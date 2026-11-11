// Sealed readings on the network: node test/sealed-node.js
//
// A meter seals its readings (components/boat_device boat_seal.h; here in
// JS) to two of three nodes. Bills are computed by the two that hold the key
// and settle with the right value; the third cannot read them and signs no
// bill, yet verifies them like any message: signatures and sequence numbers
// do not need the plaintext.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import createTestnet from 'hyperdht/testnet.js'
import { HDNodeWallet } from 'ethers'
import { connect, publishHome, own, sign, sealEnvelope, encrypt } from 'boat-mqtt-node'
import { deploy, deployTestToken, ROLES, createBoatNode, postJob, computeJob, verifyJob, settledKey, runRule, computeResult } from '../index.js'
import { startChain, MNEMONIC } from './chain.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, ms = 30000) => {
  const end = Date.now() + ms
  let v
  while (!(v = await fn()) && Date.now() < end) await sleep(200)
  return v
}
const wasm = fs.readFileSync(new URL('../rules/energy-bill.wasm', import.meta.url))

const chain = await startChain(8562)
const testnet = await createTestnet(3)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-sealed-'))
const nodes = []
let timer = null
let meter = null
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, payer, ...ops] = [0, 1, 2, 3, 4].map(acct)
  const token = await deployTestToken(admin)
  const reg = await deploy(admin, { token: await token.getAddress(), minStake: 100_000000n, unbonding: 600, epochLength: 15, jobNotice: 10, plan: { spare: 10 } })
  for (const o of [payer, ...ops]) await (await token.mint(o.address, 1000_000000n)).wait()
  for (const [i, o] of ops.entries()) {
    nodes.push(await createBoatNode({
      dht: testnet.createNode(), seed: Buffer.alloc(32, 0x70 + i), operator: o, registry: await reg.getAddress(), roles: 15, autoRegister: true,
      storage: path.join(tmp, 'n' + i), network: 'boat-sealed', jobPollMs: 1000, listMs: 60000, settleDelayMs: 800, backupMs: 2500, rewardMs: 30000, watchers: 10
    }))
  }
  const [N1, N2, N3] = nodes
  await chain.provider.send('evm_increaseTime', [16])
  await chain.provider.send('evm_mine', [])

  const devDht = testnet.createNode()
  meter = await connect(N1.keyPair.publicKey, { dht: devDht })
  const device = meter.publicKey.toString('hex')
  await publishHome(devDht, meter.keyPair, N1.keyPair.publicKey)
  const jc = await postJob(reg, payer, { ...computeJob({ wasm, field: 'mwh', window: 5, price: 250 }), device, pay: 1_000000n, quorum: 2, budget: 100_000000n })
  const jv = await postJob(reg, payer, { ...verifyJob({ window: 5 }), device, pay: 1_000000n, quorum: 2, budget: 100_000000n })
  await until(() => nodes.every((n) => n.jobs.size === 2), 20000)

  // the readers: N1's and N2's work keys, not N3's
  const key = crypto.randomBytes(32)
  const keyId = 1
  const readers = [N1, N2].map((n) => n.keys.work.publicKey)
  let seq = 0
  const pub = (name, body, opts = {}) => {
    const topic = own(device) + name
    return meter.publishAsync(topic, sign(meter.keyPair.secretKey, topic, seq++, body), { qos: 1, ...opts })
  }
  await pub('keys/00000001', sealEnvelope(keyId, key, readers), { retain: true })
  await sleep(1000)
  // one counter for all the device's messages, as boat_device keeps it: the
  // envelope took seq 0, readings follow
  const plain = new Map() // seq -> mwh
  let mwh = 5000
  timer = setInterval(() => {
    mwh += 1667
    plain.set(String(seq), mwh)
    const topic = own(device) + 'telemetry'
    meter.publishAsync(topic, sign(meter.keyPair.secretKey, topic, seq++, encrypt(key, keyId, topic, Buffer.from(JSON.stringify({ mwh })))), { qos: 1 }).catch(() => {})
  }, 250)

  const settled = async (id, unit) => (await reg.settled(settledKey(id, unit))) !== '0x' + '0'.repeat(64)
  await until(async () => (await settled(jc, 1n)) && (await settled(jv, 1n)), 40000)
  const w1 = N1.workers.get(jc)[0].signed.get(1n)
  const inputs = [5, 6, 7, 8, 9].map((s) => [String(s), String(plain.get(String(s)))])
  const expected = computeResult(inputs, runRule(wasm, inputs.map(([, v]) => v), 250n))
  check('bills on sealed readings settle, computed by the nodes that hold the key, from the very readings sent', await settled(jc, 1n) && (await reg.settled(settledKey(jc, 1n))) === expected && w1 && w1.result === expected, `unit 1: ${w1 ? w1.detail.value : '-'} base units`)
  const w0 = N1.workers.get(jc)[0].signed.get(0n)
  check('a window that holds another message (the key envelope) still completes, with the readings in it as inputs', w0 && w0.detail.inputs.length === 4 && w0.detail.inputs.every(([s, v]) => String(plain.get(s)) === v))
  check('the node that is not a reader cannot read them, and signs no bill', N3.workers.get(jc)[0].signedCount === 0 && N1.workers.get(jc)[0].signedCount > 0)
  check('every node verifies them: signatures and sequence numbers need no plaintext', await settled(jv, 1n) && N3.workers.get(jv)[0].signedCount > 0)
  const leaf = N3.workers.get(jv)[0].signed.get(1n).detail.leaves[0]
  check('what the verifiers judged is the ciphertext, never the reading', leaf && leaf.payloadHash && !JSON.stringify(N3.workers.get(jv)[0].signed.get(1n)).includes('mwh'))
} catch (err) {
  console.error(err)
  failed++
} finally {
  clearInterval(timer)
  meter?.end(true)
  for (const n of nodes) await n.close().catch(() => {})
  await testnet.destroy()
  chain?.anvil.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
