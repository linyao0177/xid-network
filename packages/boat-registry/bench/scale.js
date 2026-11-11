// The network at scale, on one machine: node bench/scale.js
//   [--nodes 12] [--devices 100] [--interval 1000] [--window 5]
//   [--minutes 5] [--jobs verify,compute] [--quorum 2] [--spare 1]
//   [--in-process] [--json out.json]
//
// A local chain (anvil) and a local HyperDHT testnet; boat-nodes in all four
// roles, each its own process (bin/boat-node.js, as an operator runs it;
// --in-process: all in this one), registered by themselves; simulated
// meters in this process, spread over the forwarding nodes, publishing a
// signed reading every --interval ms; jobs on every meter. It measures what
// settles: units expected and settled, gas per unit, the time from a unit's
// last reading to its settlement on chain, and CPU and memory.

import os from 'os'
import fs from 'fs'
import path from 'path'
import { spawn, execFileSync } from 'child_process'
import createTestnet from 'hyperdht/testnet.js'
import HyperDHT from 'hyperdht'
import { HDNodeWallet } from 'ethers'
import { connect, publishHome, own, sign } from 'boat-mqtt-node'
import { deploy, deployTestToken, ROLES, createBoatNode, postJob, verifyJob, storeJob, computeJob, forwardJob, unitOf } from '../index.js'
import { startChain, MNEMONIC } from '../test/chain.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const N = Number(opt('nodes', 12))
const D = Number(opt('devices', 100))
const INTERVAL = Number(opt('interval', 1000))
const WINDOW = Number(opt('window', 5))
const MINUTES = Number(opt('minutes', 5))
const KINDS = opt('jobs', 'verify,compute').split(',')
const QUORUM = Number(opt('quorum', 2))
const SPARE = Number(opt('spare', 1))
const BATCH = Number(opt('batch', 0)) // units per batch (batch jobs); 0: unit by unit
const IN_PROCESS = args.includes('--in-process')
const EPOCH = 60
// CPU seconds and RSS (MB) of processes, from ps: `time` is the CPU time
// used so far (D-HH:MM:SS on Linux, M:SS.ss on macOS). ps's %cpu is not used:
// on Linux it is the average over the process's whole life
function cpuOf (pids) {
  const secs = (t) => {
    const [d, rest] = t.includes('-') ? t.split('-') : ['0', t]
    return Number(d) * 86400 + rest.split(':').reduce((a, x) => a * 60 + Number(x), 0)
  }
  return execFileSync('ps', ['-o', 'pid=,time=,rss=', '-p', pids.join(',')]).toString().trim().split('\n').map((l) => {
    const [pid, t, r] = l.trim().split(/\s+/)
    return { pid: Number(pid), cpu: secs(t), rss: Number(r) / 1024 }
  })
}

const log = (line) => console.log(new Date().toISOString().slice(11, 19) + ' ' + line)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const chain = await startChain(8560)
const testnet = await createTestnet(4)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-scale-'))
const wasm = fs.readFileSync(new URL('../rules/energy-bill.wasm', import.meta.url))
const nodes = [] // in-process nodes, or { keyPair, proc }
const meters = []
const procs = []
let timer = null
try {
  // anvil's mnemonic, accounts beyond the first 20
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const admin = acct(0)
  const payer = acct(1)
  const token = await deployTestToken(admin)
  const reg = await deploy(admin, { token: await token.getAddress(), minStake: 100_000000n, unbonding: 600, epochLength: EPOCH, jobNotice: 600, plan: { spare: SPARE } })
  const registry = await reg.getAddress()
  const ops = Array.from({ length: N }, (_, i) => acct(2 + i))
  // anvil funds only its first accounts with gas: give the rest some
  for (const o of [payer, ...ops]) {
    if ((await chain.provider.getBalance(o.address)) === 0n) await (await admin.sendTransaction({ to: o.address, value: 10n ** 20n })).wait()
    await (await token.mint(o.address, 1000_000000n)).wait()
  }
  log(`chain up; starting ${N} nodes${IN_PROCESS ? ' in this process' : ' as processes'}`)
  const t0 = Date.now()
  const opts = { jobPollMs: 2000, listMs: 60000, settleDelayMs: 1000, backupMs: 4000, rewardMs: 30000, maxJobs: 100000 }
  for (const [i, o] of ops.entries()) {
    const seed = Buffer.alloc(32, 0x10 + i)
    if (IN_PROCESS) {
      nodes.push(await createBoatNode({ dht: testnet.createNode(), seed, operator: o, registry, roles: 15, autoRegister: true, storage: path.join(tmp, 'n' + i), network: 'boat-scale', ...opts }))
      continue
    }
    const dir = path.join(tmp, 'n' + i)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'seed'), seed.toString('hex'), { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'operator.key'), o.privateKey, { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'node.json'), JSON.stringify({ rpc: chain.url, registry, roles: ['forward', 'store', 'verify', 'compute'], autoRegister: true, network: 'boat-scale', bootstrap: testnet.bootstrap.map((b) => `${b.host}:${b.port}`), ...opts }))
    const proc = spawn(process.execPath, [...(args.includes('--profile') && i === 0 ? ['--cpu-prof', '--cpu-prof-dir=' + dir] : []), new URL('../bin/boat-node.js', import.meta.url).pathname, 'run', dir], { env: { ...process.env, BOAT_STATUS_MS: '15000', BOAT_WORK_DETAIL: args.includes('--keep') ? '1' : '' }, stdio: ['ignore', fs.openSync(path.join(dir, 'log'), 'a'), fs.openSync(path.join(dir, 'log'), 'a')] })
    procs.push(proc)
    nodes.push({ keyPair: HyperDHT.keyPair(seed), proc, dir })
  }
  if (!IN_PROCESS) {
    // registered and serving: every node in the registry, every card readable
    for (let t = 0; t < 120 && Number(await reg.operatorCount()) < N; t++) await sleep(1000)
    await sleep(5000)
  }
  log(`${N} nodes up in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  await chain.provider.send('evm_increaseTime', [EPOCH + 1]) // verifiers vote from here
  await chain.provider.send('evm_mine', [])

  // meters: a few DHT instances, many key pairs
  const dhts = Array.from({ length: Math.min(8, D) }, () => testnet.createNode())
  for (let i = 0; i < D; i++) {
    const dht = dhts[i % dhts.length]
    const keyPair = HyperDHT.keyPair()
    const home = nodes[i % N].keyPair.publicKey
    await publishHome(dht, keyPair, home)
    const client = await connect(home, { dht, keyPair })
    meters.push({ client, keyPair, key: keyPair.publicKey.toString('hex'), seq: 0, mwh: 0, times: new Map() })
  }
  log(`${D} meters connected`)
  if (args.includes('--keep')) fs.writeFileSync(path.join(tmp, 'meters.json'), JSON.stringify(meters.map((m, i) => ({ key: m.key, home: i % N }))))

  // jobs
  const kindOfJob = new Map() // job id -> kind
  const kinds = { verify: verifyJob({ window: WINDOW }), store: storeJob({ window: WINDOW }), forward: forwardJob({ window: WINDOW }), compute: computeJob({ wasm, field: 'mwh', window: WINDOW, price: 250 }) }
  const budget = 1_000000n * 100000n
  await (await token.mint(payer.address, budget * BigInt(D * KINDS.length))).wait()
  const jobOf = new Map() // job id -> meter
  const tj = Date.now()
  for (const m of meters) {
    for (const k of KINDS) {
      const id = await postJob(reg, payer, { ...kinds[k], device: m.key, pay: 1_000000n, quorum: QUORUM, budget, perEpoch: 100000, batchUnits: BATCH })
      jobOf.set(id, m)
      kindOfJob.set(id, k)
    }
  }
  log(`${jobOf.size} jobs posted in ${((Date.now() - tj) / 1000).toFixed(1)} s; waiting for nodes to take them`)
  if (IN_PROCESS) {
    for (let t = 0; t < 120 && !nodes.every((n) => n.jobs.size === jobOf.size); t++) await sleep(1000)
  } else {
    await sleep(Math.max(15000, jobOf.size * 30)) // nodes poll every 2 s and follow the meters
  }
  log('jobs taken')

  // publish
  const tick = () => {
    for (const m of meters) {
      const topic = own(m.key) + 'telemetry'
      m.mwh += 333
      const seq = m.seq++
      m.times.set(seq, Date.now())
      m.client.publish(topic, sign(m.keyPair.secretKey, topic, seq, JSON.stringify({ mwh: m.mwh })), { qos: 1 })
    }
  }
  const settled = []
  reg.on('Settled', (id, unit, result, signers, pay, ev) => {
    const m = jobOf.get(Number(id))
    if (!m) return
    const last = Number((BigInt(unit) & 0xffffffffn) * BigInt(WINDOW) + BigInt(WINDOW - 1))
    const at = m.times.get(last)
    settled.push({ id: Number(id), unit: String(unit), ms: at ? Date.now() - at : null, block: ev.log.blockNumber })
  })
  // a batch settles `units` units at once; its latency runs from the batch's last reading
  reg.on('BatchSettled', (id, batch, root, units, signers, pay, ev) => {
    const m = jobOf.get(Number(id))
    if (!m) return
    const lastUnit = (BigInt(batch) & 0xffffffffn) * BigInt(BATCH) + BigInt(BATCH - 1)
    const at = m.times.get(Number(lastUnit * BigInt(WINDOW) + BigInt(WINDOW - 1)))
    for (let i = 0; i < Number(units); i++) settled.push({ id: Number(id), unit: String(batch) + ':' + i, ms: at ? Date.now() - at : null, block: ev.log.blockNumber, batch: true })
  })
  const cpu0 = process.cpuUsage()
  const start = Date.now()
  timer = setInterval(tick, INTERVAL)
  const rss = []
  const nodeCpu = [] // % of a core per node process, sampled
  const nodeRss = []
  const lastCpu = new Map() // pid -> CPU seconds at the last sample
  for (let s = 0; s < MINUTES * 60; s += 15) {
    await sleep(15000)
    rss.push(process.memoryUsage().rss)
    if (procs.length) {
      // % of a core over the last 15 s
      for (const { pid, cpu, rss: r } of cpuOf(procs.map((p) => p.pid))) {
        if (lastCpu.has(pid)) nodeCpu.push((100 * (cpu - lastCpu.get(pid))) / 15)
        lastCpu.set(pid, cpu)
        nodeRss.push(r)
      }
    }
    log(`${Math.round((Date.now() - start) / 1000)} s: ${settled.length} units settled, this process rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB${procs.length ? `, nodes ${(nodeCpu.slice(-procs.length).reduce((a, b) => a + b, 0) / procs.length).toFixed(0)}% CPU each` : ''}`)
  }
  clearInterval(timer)
  const elapsed = (Date.now() - start) / 1000
  await sleep(15000) // the last units settle
  const cpu = process.cpuUsage(cpu0)

  // gas: from the settle transactions' receipts (a sample)
  const sample = settled.slice(0, 200)
  const gas = []
  for (const s of sample) {
    const ev = (await reg.queryFilter(reg.filters.Settled(s.id), s.block, s.block)).find((e) => String(e.args.unit) === s.unit)
    if (!ev) continue
    // a batch settles many units in one transaction: its gas over them
    const r = await ev.getTransactionReceipt()
    const units = r.logs.filter((l) => { try { return reg.interface.parseLog(l)?.name === 'Settled' } catch { return false } }).length
    gas.push(Number(r.gasUsed) / Math.max(1, units))
  }
  const sentUnits = Math.floor(meters[0].seq / WINDOW)
  const expected = jobOf.size * sentUnits
  const lat = settled.map((s) => s.ms).filter((x) => x !== null).sort((a, b) => a - b)
  const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : null
  const watch = IN_PROCESS ? nodes.reduce((a, n) => a + n.watch.stats.checked, 0) : null
  // jobs each node process took (its log)
  const taken = IN_PROCESS ? nodes.map((n) => n.jobs.size) : nodes.map((n) => (fs.readFileSync(path.join(n.dir, 'log'), 'utf8').match(/(working on|watching) job/g) || []).length)
  // settled by kind, from the chain (not the event subscription)
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]))
  const onchain = await reg.queryFilter(reg.filters.Settled(), 0, 'latest')
  for (const e of onchain) if (kindOfJob.has(Number(e.args.id))) byKind[kindOfJob.get(Number(e.args.id))]++
  const batches = await reg.queryFilter(reg.filters.BatchSettled(), 0, 'latest')
  for (const e of batches) if (kindOfJob.has(Number(e.args.id))) byKind[kindOfJob.get(Number(e.args.id))] += Number(e.args.units)
  // gas per unit in batches: each transaction's gas over the units it settled
  const txs = [...new Set(batches.map((e) => e.transactionHash))].slice(0, 60)
  for (const h of txs) {
    const r = await chain.provider.getTransactionReceipt(h)
    const units = batches.filter((e) => e.transactionHash === h).reduce((a, e) => a + Number(e.args.units), 0)
    if (units) gas.push(Number(r.gasUsed) / units)
  }
  // what the nodes' workers did, by kind (each node logs it every 15 s)
  const work = {}
  if (!IN_PROCESS) {
    for (const n of nodes) {
      const line = fs.readFileSync(path.join(n.dir, 'log'), 'utf8').split('\n').filter((l) => l.includes(' work: ')).pop()
      if (!line) continue
      for (const [k, v] of Object.entries(JSON.parse(line.slice(line.indexOf(' work: ') + 7)))) {
        work[k] ||= {}
        for (const [f, x] of Object.entries(v)) work[k][f] = (work[k][f] || 0) + x
      }
    }
  }
  const report = {
    nodes: N,
    meters: D,
    jobs: jobOf.size,
    kinds: KINDS,
    readings_per_s: Math.round((D * 1000) / INTERVAL),
    seconds: Math.round(elapsed),
    units_complete: expected,
    units_settled: settled.length,
    settled_share: expected ? +(settled.length / expected).toFixed(3) : null,
    settled_by_kind: Object.fromEntries(KINDS.map((k) => [k, +(byKind[k] / (expected / KINDS.length)).toFixed(3)])),
    settled_onchain: onchain.length + batches.reduce((a, e) => a + Number(e.args.units), 0),
    batches_settled: batches.length,
    work_by_kind: work,
    settles_per_s: +(settled.length / (elapsed + 15)).toFixed(2),
    gas_per_unit: gas.length ? Math.round(gas.reduce((a, b) => a + b, 0) / gas.length) : null,
    settle_latency_ms: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99) },
    work_checked_by_watchtowers: watch,
    jobs_taken_per_node: { min: Math.min(...taken), max: Math.max(...taken) },
    spare: SPARE,
    processes: IN_PROCESS ? 'one' : 'one per node',
    this_process_cpu_cores: +((cpu.user + cpu.system) / 1e6 / (elapsed + 15)).toFixed(2),
    this_process_rss_mb_max: Math.round(Math.max(...rss) / 1e6),
    node_cpu_pct_avg: nodeCpu.length ? Math.round(nodeCpu.reduce((a, b) => a + b, 0) / nodeCpu.length) : null,
    node_rss_mb_max: nodeRss.length ? Math.round(Math.max(...nodeRss)) : null,
    machine: `${os.cpus()[0].model}, ${os.cpus().length} cores`
  }
  console.log(JSON.stringify(report, null, 2))
  if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(report, null, 2) + '\n')
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  clearInterval(timer)
  for (const m of meters) m.client.end(true)
  for (const n of nodes) await n.close?.().catch(() => {})
  for (const p of procs) p.kill('SIGTERM')
  await sleep(3000)
  await testnet.destroy()
  chain?.anvil.kill()
  if (args.includes('--keep')) console.log('kept ' + tmp)
  else fs.rmSync(tmp, { recursive: true, force: true })
  setTimeout(() => process.exit(process.exitCode || 0), 2000)
}
