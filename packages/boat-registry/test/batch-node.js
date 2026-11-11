// Batch jobs end to end: node test/batch-node.js
//
// Four nodes on a HyperDHT testnet and an anvil chain, a meter publishing a
// signed reading every 300 ms, and four batch jobs on it (verify, store,
// compute, forward; 5 readings a unit, 3 units a batch). The nodes agree on
// units as before, then each signs one statement per batch and the batches
// settle on chain (BatchSettled), with no unit settled on its own.

import fs from 'fs'
import os from 'os'
import path from 'path'
import createTestnet from 'hyperdht/testnet.js'
import { HDNodeWallet } from 'ethers'
import { connect, publishHome, own, sign } from 'boat-mqtt-node'
import { deploy, deployTestToken, ROLES, createBoatNode, postJob, computeJob, verifyJob, storeJob, forwardJob, batchKey } from '../index.js'
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
  while (!(v = await fn()) && Date.now() < end) await sleep(250)
  return v
}

const wasm = fs.readFileSync(new URL('../rules/energy-bill.wasm', import.meta.url))
const MIN = 100_000000n
const chain = await startChain(8561)
const testnet = await createTestnet(3)
const nodes = []
let meterTimer = null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-batch-test-'))
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, payer, ...ops] = [0, 1, 2, 3, 4, 5].map(acct)
  const token = await deployTestToken(admin)
  const reg = await deploy(admin, { token: await token.getAddress(), minStake: MIN, unbonding: 600, epochLength: 15, jobNotice: 10, plan: { spare: 10 } })
  for (const o of [payer, ...ops]) await (await token.mint(o.address, 10000_000000n)).wait()
  const registry = await reg.getAddress()
  const ALL = ROLES.FORWARD | ROLES.STORE | ROLES.VERIFY | ROLES.COMPUTE
  const logs = []
  for (const [i, o] of ops.entries()) {
    const n = await createBoatNode({
      dht: testnet.createNode(),
      seed: Buffer.alloc(32, 0x60 + i),
      operator: o,
      registry,
      roles: ALL,
      stake: MIN,
      autoRegister: true,
      storage: path.join(tmp, 'n' + (i + 1)),
      network: 'boat-batch-test',
      jobPollMs: 1000,
      listMs: 2000,
      settleDelayMs: 800,
      backupMs: 2500,
      rewardMs: 3000,
      watchers: 10
    })
    n.on('log', (line) => logs.push(`N${i + 1} ${line}`))
    nodes.push(n)
  }
  await chain.provider.send('evm_increaseTime', [16]) // verifiers vote from the next epoch
  await chain.provider.send('evm_mine', [])
  const [N1] = nodes

  const devDht = testnet.createNode()
  const meter = await connect(N1.keyPair.publicKey, { dht: devDht })
  const device = meter.publicKey.toString('hex')
  await publishHome(devDht, meter.keyPair, N1.keyPair.publicKey)
  const topic = own(device) + 'telemetry'
  let seq = 0
  let mwh = 1000000

  const WINDOW = 5
  const BATCH = 3
  const PAY = 1_000000n
  const job = (j) => postJob(reg, payer, { ...j, device, pay: PAY, quorum: 2, budget: PAY * 1000n, batchUnits: BATCH })
  const jv = await job(verifyJob({ window: WINDOW }))
  const js = await job(storeJob({ window: WINDOW }))
  const jc = await job(computeJob({ wasm, field: 'mwh', window: WINDOW, price: 250 }))
  const jf = await job(forwardJob({ window: WINDOW }))
  await until(() => nodes.every((n) => n.jobs.size === 4), 20000)
  check('four batch jobs posted; every node took them', nodes.every((n) => n.jobs.size === 4) && [...N1.jobs.values()].every((j) => j.batchUnits === BATCH))

  meterTimer = setInterval(() => {
    mwh += 100
    meter.publishAsync(topic, sign(meter.keyPair.secretKey, topic, seq++, JSON.stringify({ mwh })), { qos: 1 }).catch(() => {})
  }, 300)

  // batch 0 holds units 0..2 (readings 0..14); it closes once a unit of batch 1 is signed
  const settledBatch = (id, b) => reg.settled(batchKey(id, BigInt(b))).then((r) => r !== '0x' + '0'.repeat(64))
  const all = await until(async () => (await settledBatch(jv, 0)) && (await settledBatch(js, 0)) && (await settledBatch(jc, 0)) && (await settledBatch(jf, 0)), 90000)
  const state = await Promise.all([jv, js, jc, jf].map((id) => settledBatch(id, 0)))
  check('the first batch of each job settled on chain', all, `verify ${state[0]}, store ${state[1]}, compute ${state[2]}, forward ${state[3]}`)

  const events = await reg.queryFilter(reg.filters.BatchSettled(), 0, 'latest')
  const unitEvents = await reg.queryFilter(reg.filters.Settled(), 0, 'latest')
  const first = events.filter((e) => e.args.batch === 0n)
  check('a whole batch settles at once (3 units), and no unit settles on its own', first.length === 4 && first.every((e) => e.args.units === 3n) && unitEvents.length === 0, `${events.length} batches, ${unitEvents.length} units on their own`)

  const verify0 = first.find((e) => e.args.id === BigInt(jv))
  const fwd0 = first.find((e) => e.args.id === BigInt(jf))
  check('a verify batch pays 3 units among its signers; a forward batch pays the forwarder', verify0 && verify0.args.pay === 3n * PAY && verify0.args.signers >= 2n && fwd0 && fwd0.args.pay === 3n * PAY)

  const r = await reg.rewards(ops[0].address)
  check('nodes earn from batches', r[0] + r[1] > 0n, `node 1: ${r[0] + r[1]}`)
  const st = nodes.map((n) => n.settler.stats)
  check('every node signed its batch statements once', st.every((s) => s.batchesSigned >= 4), st.map((s) => s.batchesSigned).join(', '))
} catch (err) {
  console.error(err)
  failed++
} finally {
  clearInterval(meterTimer)
  for (const n of nodes) await n.close().catch(() => {})
  await testnet.destroy()
  chain.anvil.kill()
  if (failed) console.log(logs.filter((l) => /batch|settle|error|cannot/i.test(l)).slice(-30).join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
