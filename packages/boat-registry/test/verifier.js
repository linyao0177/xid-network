// Verifier nodes on a HyperDHT testnet and an anvil chain: node test/verifier.js
//
// A device publishes good, forged, replayed and attested messages. Three
// verifiers follow it, sign their verdicts in batches and anchor the roots.
// One of them lies about the forged message; the other two audit its batch,
// sign a judgement, and the registry slashes it.

import createTestnet from 'hyperdht/testnet.js'
import HyperDHT from 'hyperdht'
import sodium from 'sodium-universal'
import { HDNodeWallet, keccak256, AbiCoder } from 'ethers'
import { createNode, connect, publishHome, own, sign } from 'boat-mqtt-node'
import { deploy, deployTestToken, register, signSlash, sortedSignatures, asBytes32, ROLES, createVerifier, checkBatch, verdictOf, auditBatch, VERDICT } from '../index.js'
import { startChain, MNEMONIC } from './chain.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await sleep(30)
  return fn()
}

const chain = await startChain(8553)
const testnet = await createTestnet(3)
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, o1, o2, o3, reporter] = [0, 1, 2, 3, 4].map(acct)
  const token = await deployTestToken(admin)
  const reg = await deploy(admin, { token: await token.getAddress(), minStake: 100_000000n, unbonding: 600 })
  const dhts = [1, 2, 3].map(() => testnet.createNode())
  for (const [i, o] of [o1, o2, o3].entries()) {
    await (await token.mint(o.address, 1000_000000n)).wait()
    await register(reg, o, { dhtKey: dhts[i].defaultKeyPair.publicKey, roles: ROLES.VERIFY, stake: 100_000000n, token: await token.getAddress() })
  }
  // verifiers count towards a quorum from the epoch after they joined
  await chain.provider.send('evm_increaseTime', [3600])
  await chain.provider.send('evm_mine', [])

  // the device and its home node
  const A = await createNode({ dht: testnet.createNode(), network: null })
  const devDht = testnet.createNode()
  const dev = await connect(A.publicKey, { dht: devDht })
  const key = dev.publicKey.toString('hex')
  await publishHome(devDht, dev.keyPair, A.publicKey)
  const topic = own(key) + 'telemetry'

  // three verifiers; the third says a forged message is fine
  const liar = (leaf) => (leaf.verdict & VERDICT.SIGNED_BAD ? { ...leaf, verdict: VERDICT.SIGNED_OK } : leaf)
  const vs = []
  for (const [i, o] of [o1, o2, o3].entries()) vs.push(await createVerifier({ dht: dhts[i], keyPair: dhts[i].defaultKeyPair, operator: o, registry: reg, devices: [key], batchMs: 60000, lie: i === 2 ? liar : null }))

  for (let n = 1; n <= 5; n++) await dev.publishAsync(topic, sign(dev.keyPair.secretKey, topic, n, `{"wh":${n * 10}}`), { qos: 1 })
  const forged = sign(dev.keyPair.secretKey, topic, 6, '{"wh":999}')
  forged[forged.length - 1] ^= 1
  await dev.publishAsync(topic, forged, { qos: 1 })
  await dev.publishAsync(topic, sign(dev.keyPair.secretKey, topic, 3, '{"wh":30}'), { qos: 1 }) // replay
  // a BoAT MER attested reading: sha256(payload) signed by the DID key
  const payload = '{"uptime_s":5,"free_heap":1000}'
  const hash = Buffer.alloc(32)
  sodium.crypto_hash_sha256(hash, Buffer.from(payload))
  const sig = Buffer.alloc(64)
  sodium.crypto_sign_detached(sig, hash, dev.keyPair.secretKey)
  await dev.publishAsync(own(key) + 'reading', JSON.stringify({ did: 'did:mw:' + key, eth: '0x' + '11'.repeat(20), payload, hash: hash.toString('hex'), sig: sig.toString('hex') }), { qos: 1 })
  await until(() => vs.every((v) => v.pending.length === 8))
  const batches = []
  for (const v of vs) batches.push(await v.flush())

  const flags = batches[0].leaves.map((l) => l.verdict)
  check('verdicts: 5 good, a forged signature, a replay, an attested reading', flags.filter((f) => f === VERDICT.SIGNED_OK).length === 5 && flags.includes(VERDICT.SIGNED_BAD) && flags.includes(VERDICT.SIGNED_OK | VERDICT.REPLAY) && flags.includes(VERDICT.ATTESTED_OK), flags.join(','))
  const checks = await Promise.all(batches.map((b) => checkBatch(reg, b)))
  check('each verifier signed and anchored its batch root; anyone can check it', checks.every((c) => c.ok), checks.map((c) => c.reason || 'ok').join(', '))
  const v = verdictOf(batches[0], key, 2n, topic)
  check('a message\'s verdict comes with a Merkle proof against the anchored root', v && v.ok && v.leaf.verdict === VERDICT.SIGNED_OK)
  const changed = { ...batches[0], leaves: batches[0].leaves.map((l, i) => (i === 5 ? { ...l, verdict: VERDICT.SIGNED_OK } : l)) }
  check('a batch changed after anchoring no longer checks out', !(await checkBatch(reg, changed)).ok)

  // the liar is caught by audit and slashed by the other two
  const wrong1 = auditBatch(batches[2], vs[0].messages)
  const wrong2 = auditBatch(batches[2], vs[1].messages)
  check('two verifiers audit the third and find its one wrong verdict', wrong1.length === 1 && wrong2.length === 1 && wrong1[0].expected === VERDICT.SIGNED_BAD, `seq ${wrong1[0] && wrong1[0].leaf.seq}`)
  const reason = keccak256(AbiCoder.defaultAbiCoder().encode(['uint64', 'bytes32'], [batches[2].batch, keccak256(Buffer.from(JSON.stringify(wrong1[0].leaf)))]))
  const judgement = { operator: o3.address, amount: 50_000000n, reason, nonce: 1 }
  const sigs = [await signSlash(reg, o1, judgement), await signSlash(reg, o2, judgement)]
  await (await reg.connect(reporter).slash(o3.address, 50_000000n, reason, 1, sortedSignatures(sigs))).wait()
  check('a quorum of the other verifiers slashes it on the registry', (await reg.nodes(o3.address)).stake === 50_000000n && !(await reg.isActive(o3.address, ROLES.VERIFY)))

  for (const x of vs) await x.close()
  dev.end(true)
  await A.close()
} finally {
  chain.anvil.kill()
  await testnet.destroy()
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
