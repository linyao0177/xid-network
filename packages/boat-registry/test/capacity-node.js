// Capacity and overload end to end: node test/capacity-node.js
//
// Four store nodes; jobs on eight devices, each worked by one node (quorum 1,
// no spare). Node 1 has room for one job (maxJobs 1, put on the registry);
// node 2 calls itself overloaded at once (overloadMs tiny) and lowers its
// capacity to what it works on. Every job still gets its one node, nobody
// works past its capacity, and jobs posted after node 2 lowered its capacity
// go to the others.

import fs from 'fs'
import os from 'os'
import path from 'path'
import createTestnet from 'hyperdht/testnet.js'
import HyperDHT from 'hyperdht'
import { HDNodeWallet } from 'ethers'
import { publishHome } from 'boat-mqtt-node'
import { deploy, deployTestToken, ROLES, createBoatNode, postJob, storeJob } from '../index.js'
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

const MIN = 100_000000n
const chain = await startChain(8562)
const testnet = await createTestnet(3)
const nodes = []
const logs = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-capacity-test-'))
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, payer, ...ops] = [0, 1, 2, 3, 4, 5].map(acct)
  const token = await deployTestToken(admin)
  const reg = await deploy(admin, { token: await token.getAddress(), minStake: MIN, unbonding: 600, epochLength: 3600, jobNotice: 10, plan: { spare: 0 } })
  for (const o of [payer, ...ops]) await (await token.mint(o.address, 10000_000000n)).wait()
  for (const [i, o] of ops.entries()) {
    const n = await createBoatNode({
      dht: testnet.createNode(),
      seed: Buffer.alloc(32, 0x70 + i),
      operator: o,
      registry: await reg.getAddress(),
      roles: ROLES.STORE | ROLES.FORWARD, // forwarding runs the MQTT node devices call home
      stake: MIN,
      autoRegister: true,
      storage: path.join(tmp, 'n' + (i + 1)),
      network: 'boat-capacity-test',
      jobPollMs: 1000,
      listMs: 60000,
      maxJobs: i === 0 ? 1 : 100,
      overloadMs: i === 1 ? 0.000001 : 2000, // node 2 is "overloaded" from the first check
      loadCheckMs: 1500
    })
    n.on('log', (line) => logs.push(`N${i + 1} ${line}`))
    nodes.push(n)
  }
  const caps = await Promise.all(ops.map((o) => reg.nodes(o.address).then((n) => Number(n.capacity))))
  check('each node put its capacity on the registry', caps[0] === 1 && caps[2] === 100, caps.join(', '))

  // eight devices with a home node (node 3) named in their DHT records
  const devDht = testnet.createNode()
  const devices = []
  for (let i = 0; i < 8; i++) {
    const kp = HyperDHT.keyPair(Buffer.alloc(32, 0x80 + i))
    await publishHome(devDht, kp, nodes[2].keyPair.publicKey)
    devices.push(kp.publicKey.toString('hex'))
  }
  const device = (i) => devices[i]
  const post = (i) => postJob(reg, payer, { ...storeJob({ window: 5 }), device: device(i), pay: 1_000000n, quorum: 1, budget: 100_000000n })
  const first = []
  for (let i = 0; i < 4; i++) first.push(await post(i))
  const workersOf = (id) => nodes.filter((n) => n.workers.has(id)).length
  await until(() => first.every((id) => workersOf(id) === 1), 20000)
  check('every job gets its one node', first.every((id) => workersOf(id) === 1), first.map(workersOf).join(', '))
  check('node 1 works on one job at most', nodes[0].workers.size <= 1, `${nodes[0].workers.size}`)

  // node 2 lowers its capacity to what it has (two checks over overloadMs)
  await until(() => nodes[1].lowered, 15000)
  const lowered = Number((await reg.nodes(ops[1].address)).capacity)
  const held = nodes[1].workers.size
  check('an overloaded node lowers its capacity on the registry to the jobs it has', nodes[1].lowered && lowered === Math.max(1, held), `capacity ${lowered}, working on ${held}`)

  // the other nodes see the new capacity from its event, as of the next plan block
  const later = []
  for (let i = 4; i < 8; i++) later.push(await post(i))
  await until(() => later.every((id) => workersOf(id) === 1), 20000)
  check('jobs posted later all get a node, never the overloaded one', later.every((id) => workersOf(id) === 1) && later.every((id) => !nodes[1].workers.has(id)), later.map((id) => nodes.findIndex((n) => n.workers.has(id)) + 1).join(', '))
  check('node 1 still works on one job at most', nodes[0].workers.size <= 1)
} catch (err) {
  console.error(err)
  failed++
} finally {
  for (const n of nodes) await n.close().catch(() => {})
  await testnet.destroy()
  chain.anvil.kill()
  if (failed) console.log(logs.slice(-30).join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
