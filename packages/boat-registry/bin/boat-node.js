#!/usr/bin/env node
// boat-node: run a node of the network in the roles it registers for.
//
//   boat-node init <dir> [--testnet] [--roles forward,store,verify,compute] [--rpc url]
//       [--registry 0x..] [--network name] [--from-block n] [--reads 0x..]
//       [--depin lat,lon] (an oracle of DePIN networks: the xid-depin plugin)
//       makes <dir>/node.json, a seed and an operator key (mode 600) and
//       prints the operator's address: fund it with gas and the stake token
//   boat-node run <dir>        registers when needed, then works
//   boat-node status <dir>     what the registry says about this node
//
// node.json: { rpc, registry, roles: [..], stake, autoRegister, network,
//   maxJobs (the node's capacity, on the registry), overloadMs (event-loop p99
//   delay that lowers it, default 2000), bootstrap: ["host:port"], listMs,
//   rewardMs, autoWithdraw,
//   fromBlock (the registry's deploy block: where its events start; found by
//   a search when left out; deployment.json's `block`). How jobs are assigned
//   (spare workers, the plan's block) is the registry's, the same for every
//   node,
//   reads: <BoatReads address>, readPrice: <per block> (a store sells reads),
//   metricsPort: <port> (Prometheus metrics on 127.0.0.1),
//   plugins: { "xid-depin": { "lat": .., "lon": .. } } (modules that run more
//   kinds of jobs: xid-depin makes the node an oracle of DePIN networks) }
// testLie: "compute" makes the node sign bills three times too high, to see
// the other nodes slash it (tests only: it loses its stake).
// The seed is the node's HyperDHT identity (its forwarding key and, derived
// from it, its store, verify and work keys); the operator key holds its stake
// and signs its work. Neither is ever printed.

import { monitorEventLoopDelay } from 'perf_hooks'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import HyperDHT from 'hyperdht'
import { Wallet } from 'ethers'
import { attach, providerFor, ROLES, BoatNode, roleKeyPair, readCard, hex } from '../index.js'

const [cmd, dir, ...rest] = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = rest.indexOf('--' + name)
  return i >= 0 ? rest[i + 1] : fallback
}
const log = (line) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ' + line)
const usage = () => {
  console.error('usage: boat-node init|run|status <dir>')
  process.exit(2)
}
if (!dir) usage()

const TESTNET_URL = 'https://iot.xid.network/testnet.json'
const file = (name) => path.join(dir, name)
const secret = (name, make) => {
  if (!fs.existsSync(file(name))) fs.writeFileSync(file(name), make(), { mode: 0o600 })
  return fs.readFileSync(file(name), 'utf8').trim()
}
const rolesOf = (names) => names.reduce((a, n) => a | ROLES[n.toUpperCase()], 0)

if (cmd === 'init') {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!fs.existsSync(file('node.json'))) {
    // --testnet: the public testnet's chain, contracts and network name, from
    // the file the site publishes (or --testnet-url)
    const net = rest.includes('--testnet') || opt('testnet-url')
      ? await (await fetch(opt('testnet-url', TESTNET_URL))).json()
      : {}
    const config = {
      rpc: opt('rpc', net.rpc ?? 'http://127.0.0.1:8545'),
      registry: opt('registry', net.registry ?? ''),
      roles: opt('roles', 'forward,store,verify,compute').split(','),
      stake: opt('stake', null),
      autoRegister: true,
      network: opt('network', net.network ?? 'boat-mqtt'),
      maxJobs: 20,
      autoWithdraw: true
    }
    const fromBlock = opt('from-block', net.block ?? null)
    if (fromBlock !== null) config.fromBlock = Number(fromBlock)
    if (opt('reads', net.reads)) config.reads = opt('reads', net.reads)
    if (opt('depin')) {
      const [lat, lon] = opt('depin').split(',').map(Number)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) usage()
      config.plugins = { 'xid-depin': { lat, lon } }
    }
    fs.writeFileSync(file('node.json'), JSON.stringify(config, null, 2) + '\n')
  }
  const seed = Buffer.from(secret('seed', () => crypto.randomBytes(32).toString('hex')), 'hex')
  const operator = new Wallet(secret('operator.key', () => Wallet.createRandom().privateKey))
  console.log(`operator ${operator.address}`)
  console.log(`node key ${hex(HyperDHT.keyPair(seed).publicKey)}`)
  console.log(`verify key ${hex(roleKeyPair(seed, 'verify').publicKey)}`)
  process.exit(0)
}

const config = JSON.parse(fs.readFileSync(file('node.json'), 'utf8'))
const seed = Buffer.from(fs.readFileSync(file('seed'), 'utf8').trim(), 'hex')
const provider = await providerFor(config.rpc)
const operator = new Wallet(fs.readFileSync(file('operator.key'), 'utf8').trim(), provider)

if (cmd === 'status') {
  const reg = attach(config.registry, provider)
  const n = await reg.nodes(operator.address)
  const [pending, matured] = await reg.rewards(operator.address)
  console.log(JSON.stringify({
    operator: operator.address,
    gas: String(await provider.getBalance(operator.address)),
    active: n.active,
    roles: Number(n.roles),
    stake: String(n.stake),
    rewards: { pending: String(pending), matured: String(matured) },
    epoch: String(await reg.epoch()),
    jobs: String(await reg.jobCount())
  }, null, 2))
  const dht = new HyperDHT({ bootstrap: config.bootstrap })
  console.log('card', JSON.stringify(await readCard(dht, HyperDHT.keyPair(seed).publicKey)))
  await dht.destroy()
  process.exit(0)
}

if (cmd !== 'run') usage()
// plugins: { "<module>": { ...options } }, modules that run kinds of jobs
// (xid-depin: DePIN networks' oracles; options lat, lon: where the node is)
const plugins = []
for (const [name, opts] of Object.entries(config.plugins || {})) {
  try {
    const mod = await import(name)
    plugins.push(await mod.plugin(opts || {}))
    log(`plugin ${name}`)
  } catch (err) {
    log(`plugin ${name} not loaded: ${err.message}`)
  }
}
const node = new BoatNode({
  plugins,
  bootstrap: config.bootstrap,
  seed,
  operator,
  registry: config.registry,
  roles: rolesOf(config.roles),
  stake: config.stake ? BigInt(config.stake) : null,
  autoRegister: config.autoRegister,
  storage: path.join(dir, 'data'),
  network: config.network,
  maxJobs: config.maxJobs,
  listMs: config.listMs,
  rewardMs: config.rewardMs,
  autoWithdraw: config.autoWithdraw,
  statusFile: file('status.json'),
  jobPollMs: config.jobPollMs,
  reads: config.reads,
  readPrice: config.readPrice ? BigInt(config.readPrice) : null,
  metricsPort: config.metricsPort,
  settleDelayMs: config.settleDelayMs,
  backupMs: config.backupMs,
  overloadMs: config.overloadMs,
  fromBlock: config.fromBlock ?? null,
  lie: config.testLie === 'compute' ? { compute: (result, detail) => ({ detail: { ...detail, value: String(BigInt(detail.value) * 3n) } }) } : null
})
node.on('log', log)
await node.start().catch((err) => {
  log('cannot start: ' + (err.shortMessage || err.message))
  process.exit(1)
})
log(`node ${hex(node.keyPair.publicKey)} operator ${operator.address} roles ${node.roles}`)
const loopDelay = monitorEventLoopDelay({ resolution: 20 })
loopDelay.enable()
setInterval(() => {
  const s = node.status()
  log(`settler: ${JSON.stringify({ ...s.settled, paid: undefined })}`)
  log(`work: ${JSON.stringify(s.work)}`)
  log(`loop: delay p50 ${(loopDelay.percentile(50) / 1e6).toFixed(1)} ms, p99 ${(loopDelay.percentile(99) / 1e6).toFixed(1)} ms, max ${(loopDelay.max / 1e6).toFixed(0)} ms`)
  loopDelay.reset()
  // BOAT_WORK_DETAIL=1: messages each worker took, by job (for benches)
  if (process.env.BOAT_WORK_DETAIL) log(`work detail: ${JSON.stringify(Object.fromEntries([...node.allWorkers()].filter((w) => w.mode !== 'forwarder').map((w) => [w.job.id, [w.job.device.slice(0, 16), w.counts.taken, w.signedCount]])))}`)
  log(`status: jobs ${s.jobs.length}, signed ${s.signed}, settled ${s.settled.settled} (${s.settled.submitted} by us)${s.watch ? `, faults ${s.watch.faults}, slashed ${s.watch.slashed}` : ''}${s.rewards ? `, rewards ${s.rewards.pending} pending ${s.rewards.withdrawn} withdrawn` : ''}`)
}, Number(process.env.BOAT_STATUS_MS || 300000)).unref()

let closing = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return
    closing = true
    await node.writeStatus().catch(() => {})
    await node.close()
    process.exit(0)
  })
}
process.on('unhandledRejection', (err) => log('unhandled: ' + (err?.shortMessage || err?.message || err)))
