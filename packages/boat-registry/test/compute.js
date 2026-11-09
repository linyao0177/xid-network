// Compute nodes: node test/compute.js
//
// A meter publishes signed cumulative Wh readings. Three compute nodes run
// the energy-bill rule on every 5 readings; one of them signs a wrong bill.
// The two-of-three answer is the right one, anyone can re-run the rule to see
// the wrong one is wrong, and two verifiers slash the node that signed it.

import fs from 'fs'
import createTestnet from 'hyperdht/testnet.js'
import { HDNodeWallet, keccak256, toUtf8Bytes } from 'ethers'
import { createNode, connect, publishHome, own, sign } from 'boat-mqtt-node'
import { deploy, deployTestToken, register, signSlash, sortedSignatures, ROLES, createComputer, checkResult, aggregate, runRule } from '../index.js'
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

const wasm = fs.readFileSync(new URL('../rules/energy-bill.wasm', import.meta.url))
const PRICE = 250000n // base units per kWh (0.25 of a 6-decimal token)
const chain = await startChain(8554)
const testnet = await createTestnet(3)
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, c1, c2, c3, v1, v2, reporter] = [0, 1, 2, 3, 4, 5, 6].map(acct)
  const token = await deployTestToken(admin)
  const reg = await deploy(admin, { token: await token.getAddress(), minStake: 100_000000n, unbonding: 600 })
  const dhts = [1, 2, 3].map(() => testnet.createNode())
  for (const [i, o] of [c1, c2, c3, v1, v2].entries()) {
    await (await token.mint(o.address, 1000_000000n)).wait()
    await register(reg, o, { dhtKey: Buffer.alloc(32, i + 1), roles: i < 3 ? ROLES.COMPUTE : ROLES.VERIFY, stake: 100_000000n, token: await token.getAddress() })
  }
  // verifiers count towards a quorum from the epoch after they joined
  await chain.provider.send('evm_increaseTime', [3600])
  await chain.provider.send('evm_mine', [])

  const A = await createNode({ dht: testnet.createNode(), network: null })
  const devDht = testnet.createNode()
  const meter = await connect(A.publicKey, { dht: devDht })
  const key = meter.publicKey.toString('hex')
  await publishHome(devDht, meter.keyPair, A.publicKey)

  const job = { device: key, topic: 'telemetry', field: 'wh', window: 5, price: PRICE }
  const nodes = []
  for (const [i, o] of [c1, c2, c3].entries()) nodes.push(await createComputer({ dht: dhts[i], keyPair: dhts[i].defaultKeyPair, operator: o, registry: reg, job, wasm, lie: i === 2 ? (r) => r * 2n : null }))

  // 10 readings: a 12 W load sampled every 5 minutes is 1 Wh each; two windows of 5
  const topic = own(key) + 'telemetry'
  const wh = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009].map((x) => x * 10)
  // sequence numbers 0..9, as a device counts: windows 0-4 and 5-9
  for (const [i, w] of wh.entries()) await meter.publishAsync(topic, sign(meter.keyPair.secretKey, topic, i, JSON.stringify({ wh: w })), { qos: 1 })
  // a forged reading is not an input
  const forged = sign(meter.keyPair.secretKey, topic, 10, JSON.stringify({ wh: 999999 }))
  forged[forged.length - 1] ^= 1
  await meter.publishAsync(topic, forged, { qos: 1 })
  await until(() => nodes.every((n) => n.results.length === 2))

  const expect = (from) => String(runRule(wasm, wh.slice(from, from + 5), PRICE))
  const windows = [0, 1].map((w) => aggregate(nodes.map((n) => n.results[w]), wasm, PRICE))
  check('every node computed both windows; the forged reading was not an input', nodes.every((n) => n.results.length === 2 && n.results[1].inputs.every(([s]) => s !== '10')))
  check('the result two of three sign is the right bill', windows.every((w, i) => w.accepted && w.accepted.result === expect(i * 5) && w.accepted.signers.length === 2), windows.map((w) => w.accepted && w.accepted.result).join(', ') + ' base units')
  const dev = windows[0].deviants[0]
  check('the third node differs on the same inputs, and re-running the rule shows it is wrong', windows.every((w) => w.deviants.length === 1) && dev.operator === c3.address && dev.wrong && dev.sameInputs, `it signed ${dev.result}`)
  check('anyone checks a result from its inputs: the honest one passes, the wrong one does not', checkResult(nodes[0].results[0], wasm).ok && !checkResult(nodes[2].results[0], wasm).ok, checkResult(nodes[2].results[0], wasm).reason)
  const tampered = { ...nodes[0].results[0], result: '1' }
  check('a result changed after signing is refused', !checkResult(tampered, wasm).ok)

  const reason = keccak256(toUtf8Bytes(`wrong result ${nodes[2].results[0].job} ${nodes[2].results[0].first}`))
  const judgement = { operator: c3.address, amount: 30_000000n, reason, nonce: 1 }
  const sigs = [await signSlash(reg, v1, judgement), await signSlash(reg, v2, judgement)]
  await (await reg.connect(reporter).slash(c3.address, 30_000000n, reason, 1, sortedSignatures(sigs))).wait()
  check('two verifiers slash the node that signed a wrong bill', (await reg.nodes(c3.address)).stake === 70_000000n)

  for (const n of nodes) await n.close()
  meter.end(true)
  await A.close()
} finally {
  chain.anvil.kill()
  await testnet.destroy()
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
