// The network at scale on several machines (bench/scale.js runs it on one).
//
//   on the chain machine:  node bench/cluster.js coordinator --host <its internal IP>
//                            [--nodes 24] [--devices 200] [--minutes 5] [--jobs verify,store,compute,forward]
//                            [--interval 1000] [--window 5] [--dht-port 49737] [--json out.json]
//                            [--batch 6] [--snapshots snap.jsonl] [--snapshot-min 60]
//   on each node machine:  node bench/cluster.js nodes --coordinator http://<chain IP>:8600 --from 0 --count 8
//                            [--dir <dir>] (reuse the nodes' storage: a restart mid-run, with new code)
//
// The coordinator runs a local chain (anvil, on all interfaces), a HyperDHT
// bootstrap node and three DHT nodes for routing, deploys the registry, funds
// the operators, serves /cluster.json, runs the meters, posts the jobs and
// measures what settles (--batch: batch jobs, settled a batch of units at a
// time; --snapshots: a line of JSON every --snapshot-min minutes, for long
// runs: what settled in that time, latency, CPU, memory, disk, the chain).
// Node machines run boat-node processes (bin/
// boat-node.js, as an operator runs it) for their share of the operators,
// and report CPU and memory to /stats every 15 s. Test keys only: anvil's
// mnemonic and fixed seeds.

import os from 'os'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { spawn, execFileSync } from 'child_process'
import HyperDHT from 'hyperdht'
import { HDNodeWallet, JsonRpcProvider } from 'ethers'
import { connect, publishHome, own, sign } from 'boat-mqtt-node'
import { deploy, deployTestToken, postJob, verifyJob, storeJob, computeJob, forwardJob } from '../index.js'

const [mode, ...args] = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
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
const MNEMONIC = 'test test test test test test test test test test test junk'
const seedOf = (i) => Buffer.alloc(32, 0x10 + i).toString('hex')

if (mode === 'coordinator') await coordinator()
else if (mode === 'nodes') await nodes()
else {
  console.error('usage: cluster.js coordinator|nodes ...')
  process.exit(2)
}

async function coordinator () {
  const host = opt('host')
  const N = Number(opt('nodes', 24))
  const D = Number(opt('devices', 200))
  const MINUTES = Number(opt('minutes', 5))
  const KINDS = opt('jobs', 'verify,store,compute,forward').split(',')
  const INTERVAL = Number(opt('interval', 1000))
  const WINDOW = Number(opt('window', 5))
  const EPOCH = 60
  const BATCH = Number(opt('batch', 0))
  const SNAPSHOTS = opt('snapshots', null)
  const SNAP_MIN = Number(opt('snapshot-min', 60))

  // (recent states only: a day of blocks would otherwise fill memory)
  const anvil = spawn('anvil', ['--host', '0.0.0.0', '--port', '8545', '--silent', '--mnemonic', MNEMONIC, '--accounts', '20', '--prune-history', '2000'], { stdio: 'ignore' })
  const rpc = `http://${host}:8545`
  const provider = new JsonRpcProvider('http://127.0.0.1:8545', undefined, { pollingInterval: 500, cacheTimeout: -1 })
  for (let i = 0; i < 50; i++) {
    try { await provider.getBlockNumber(); break } catch { await sleep(200) }
  }
  // the DHT: a bootstrap node and three more for routing
  const dhtPort = Number(opt('dht-port', 49737))
  const boot = HyperDHT.bootstrapper(dhtPort, host)
  await boot.ready()
  const bootstrap = [`${host}:${dhtPort}`]
  const routers = []
  for (let i = 0; i < 3; i++) {
    const d = new HyperDHT({ bootstrap, ephemeral: false, host: '0.0.0.0', port: dhtPort + 3 + i })
    await d.ready()
    routers.push(d)
  }
  log(`chain on ${rpc}, DHT on ${bootstrap[0]}`)

  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(provider)
  const admin = acct(0)
  const payer = acct(1)
  const token = await deployTestToken(admin)
  const reg = await deploy(admin, { token: await token.getAddress(), minStake: 100_000000n, unbonding: 600, epochLength: EPOCH, jobNotice: 600 })
  const registry = await reg.getAddress()
  const ops = Array.from({ length: N }, (_, i) => acct(2 + i))
  for (const o of [payer, ...ops]) {
    if ((await provider.getBalance(o.address)) === 0n) await (await admin.sendTransaction({ to: o.address, value: 10n ** 20n })).wait()
    await (await token.mint(o.address, 1000_000000n)).wait()
  }

  // what node machines fetch, and where they report
  const cluster = { rpc, registry, bootstrap, nodes: ops.map((o, i) => ({ index: i, seed: seedOf(i), key: o.privateKey })) }
  const stats = new Map() // host -> { cpu, rss, at }
  let done = false
  const server = http.createServer((req, res) => {
    if (req.url === '/cluster.json') return res.end(JSON.stringify(cluster))
    if (req.url === '/done') return res.end(done ? 'yes' : 'no')
    if (req.url === '/stats' && req.method === 'POST') {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => {
        try { const s = JSON.parse(body); stats.set(s.host, { ...s, at: Date.now() }) } catch {}
        res.end('ok')
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(8600, '0.0.0.0', resolve))
  log(`waiting for ${N} nodes to register (serving http://${host}:8600/cluster.json)`)
  const t0 = Date.now()
  while (Number(await reg.operatorCount()) < N) await sleep(2000)
  log(`${N} nodes registered in ${Math.round((Date.now() - t0) / 1000)} s`)
  await sleep(10000) // cards and node lists out
  await provider.send('evm_increaseTime', [EPOCH + 1]) // verifiers vote from here
  await provider.send('evm_mine', [])

  // meters: a few DHT instances, many key pairs, spread over the nodes
  const dhts = Array.from({ length: 8 }, () => new HyperDHT({ bootstrap }))
  const meters = []
  for (let i = 0; i < D; i++) {
    const dht = dhts[i % dhts.length]
    const keyPair = HyperDHT.keyPair()
    const home = HyperDHT.keyPair(Buffer.from(seedOf(i % N), 'hex')).publicKey
    await publishHome(dht, keyPair, home)
    const client = await connect(home, { dht, keyPair })
    meters.push({ client, keyPair, key: keyPair.publicKey.toString('hex'), seq: 0, mwh: 0, times: new Map() })
  }
  log(`${D} meters connected`)

  const wasm = fs.readFileSync(new URL('../rules/energy-bill.wasm', import.meta.url))
  const kinds = { verify: verifyJob({ window: WINDOW }), store: storeJob({ window: WINDOW }), forward: forwardJob({ window: WINDOW }), compute: computeJob({ wasm, field: 'mwh', window: WINDOW, price: 250 }) }
  const budget = 1_000000n * 100000n
  await (await token.mint(payer.address, budget * BigInt(D * KINDS.length))).wait()
  const jobOf = new Map()
  const kindOf = new Map()
  for (const m of meters) {
    for (const k of KINDS) {
      const id = await postJob(reg, payer, { ...kinds[k], device: m.key, pay: 1_000000n, quorum: 2, budget, perEpoch: 100000, batchUnits: BATCH })
      jobOf.set(id, m)
      kindOf.set(id, k)
    }
  }
  log(`${jobOf.size} jobs posted; giving nodes time to take them`)
  await sleep(Math.max(20000, jobOf.size * 40))

  // what settled: counts, by kind, and latencies (from the last reading of a
  // unit, or of a batch's last unit, to the settlement), kept per snapshot
  const settled = { units: 0, batches: 0, byKind: {}, lat: [], allLat: [], gas: 0n, txs: new Set() }
  const record = (id, units, lastUnit, ev) => {
    const m = jobOf.get(Number(id))
    if (!m) return
    settled.units += units
    settled.byKind[kindOf.get(Number(id))] = (settled.byKind[kindOf.get(Number(id))] || 0) + units
    const last = Number((BigInt(lastUnit) & 0xffffffffn) * BigInt(WINDOW) + BigInt(WINDOW - 1))
    const at = m.times.get(last)
    if (at) {
      settled.lat.push(Date.now() - at)
      if (settled.allLat.length < 200000) settled.allLat.push(Date.now() - at)
    }
    settled.txs.add(ev.log.transactionHash)
  }
  // read with getLogs every 2 s, not with a filter: anvil drops filters (a
  // day's run lost its listener in the first minutes)
  const topics = [[reg.interface.getEvent('Settled').topicHash, reg.interface.getEvent('BatchSettled').topicHash]]
  let fromBlock = (await provider.getBlockNumber()) + 1
  const pollSettled = async () => {
    for (;;) {
      try {
        const head = await provider.getBlockNumber()
        for (let f = fromBlock; f <= head; f += 2000) {
          const to = Math.min(head, f + 1999)
          for (const l of await provider.getLogs({ address: registry, fromBlock: f, toBlock: to, topics })) {
            const e = reg.interface.parseLog(l)
            if (!e) continue
            if (e.name === 'Settled') record(e.args.id, 1, e.args.unit, { log: l })
            else {
              settled.batches++
              const b = BigInt(e.args.batch)
              record(e.args.id, Number(e.args.units), ((b >> 32n) << 32n) | ((b & 0xffffffffn) * BigInt(BATCH || 1) + BigInt((BATCH || 1) - 1)), { log: l })
            }
          }
          fromBlock = to + 1
        }
      } catch (err) {
        log('settled: ' + (err.shortMessage || err.message))
      }
      await sleep(2000)
    }
  }
  pollSettled()
  const tick = () => {
    for (const m of meters) {
      const topic = own(m.key) + 'telemetry'
      m.mwh += 333
      const seq = m.seq++
      m.times.set(seq, Date.now())
      m.times.delete(seq - 4 * 3600000 / INTERVAL) // (kept four hours)
      m.client.publish(topic, sign(m.keyPair.secretKey, topic, seq, JSON.stringify({ mwh: m.mwh })), { qos: 1 })
    }
  }
  const start = Date.now()
  const timer = setInterval(tick, INTERVAL)
  const cpuSamples = []
  let snapCpu = []
  let lastSnap = { at: start, units: 0, batches: 0, txs: 0 }
  const pctOf = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null }
  const snapshot = async () => {
    const now = Date.now()
    const machines = [...stats.values()].filter((x) => now - x.at < 60000)
    const block = await provider.getBlockNumber().catch(() => null)
    const anvilRss = (() => { try { return cpuOf([anvil.pid])[0].rss } catch { return null } })()
    // units whose readings were all sent by now (a unit closes WINDOW readings in)
    const complete = jobOf.size * Math.floor(meters[0].seq / WINDOW)
    const snap = {
      at: new Date(now).toISOString(),
      hours: +((now - start) / 3600000).toFixed(2),
      readings_per_device: meters[0].seq,
      units_complete: complete,
      units_settled: settled.units,
      settled_share: complete ? +(settled.units / complete).toFixed(4) : null,
      in_period: { minutes: Math.round((now - lastSnap.at) / 60000), units: settled.units - lastSnap.units, batches: settled.batches - lastSnap.batches, txs: settled.txs.size - lastSnap.txs, latency_ms: { p50: pctOf(settled.lat, 0.5), p90: pctOf(settled.lat, 0.9), p99: pctOf(settled.lat, 0.99) } },
      by_kind: { ...settled.byKind },
      node_cpu_pct: snapCpu.length ? { avg: Math.round(snapCpu.reduce((a, b) => a + b, 0) / snapCpu.length), max: Math.round(Math.max(...snapCpu)) } : null,
      machines: machines.map((m) => ({ host: m.host, nodes: m.cpu.length, rss_mb_max: Math.round(Math.max(0, ...m.rss)), disk_used_pct: m.disk ?? null, mem_free_mb: m.memFree ?? null, nodes_alive: m.alive ?? null })),
      chain: { block, anvil_rss_mb: anvilRss && Math.round(anvilRss) },
      coordinator_rss_mb: Math.round(process.memoryUsage().rss / 1e6)
    }
    lastSnap = { at: now, units: settled.units, batches: settled.batches, txs: settled.txs.size }
    settled.lat = []
    snapCpu = []
    if (SNAPSHOTS) fs.appendFileSync(SNAPSHOTS, JSON.stringify(snap) + '\n')
    log(`snapshot: ${JSON.stringify(snap)}`)
  }
  let nextSnap = start + SNAP_MIN * 60000
  for (let s = 0; s < MINUTES * 60; s += 15) {
    await sleep(15000)
    const fresh = [...stats.values()].filter((x) => Date.now() - x.at < 30000)
    const cpus = fresh.flatMap((x) => x.cpu)
    if (cpus.length) { cpuSamples.push(...cpus.map(Math.round)); snapCpu.push(...cpus) }
    if (cpuSamples.length > 100000) cpuSamples.splice(0, cpuSamples.length - 100000)
    log(`${Math.round((Date.now() - start) / 1000)} s: ${settled.units} units settled (${settled.batches} batches); ${fresh.length} node machines report ${cpus.length ? Math.round(cpus.reduce((a, b) => a + b, 0) / cpus.length) : '-'}% CPU per node`)
    if (Date.now() >= nextSnap) {
      nextSnap += SNAP_MIN * 60000
      await snapshot().catch((err) => log('snapshot: ' + err.message))
    }
  }
  clearInterval(timer)
  const elapsed = (Date.now() - start) / 1000
  await sleep(15000)
  done = true

  await snapshot().catch(() => {})
  const lat = settled.allLat.sort((a, b) => a - b)
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : null)
  const expected = jobOf.size * Math.floor(meters[0].seq / WINDOW)
  const machines = [...stats.values()]
  const report = {
    machines: { chain: `${os.cpus().length} cores (this one)`, nodes: machines.map((m) => `${m.host}: ${m.cpu.length} nodes, ${m.cores} cores`) },
    nodes: N,
    meters: D,
    jobs: jobOf.size,
    kinds: KINDS,
    readings_per_s: Math.round((D * 1000) / INTERVAL),
    seconds: Math.round(elapsed),
    batch_units: BATCH,
    units_complete: expected,
    units_settled: settled.units,
    batches_settled: settled.batches,
    settle_txs: settled.txs.size,
    settled_share: expected ? +(settled.units / expected).toFixed(3) : null,
    settles_per_s: +(settled.units / (elapsed + 15)).toFixed(2),
    by_kind: settled.byKind,
    settle_latency_ms: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99) },
    node_cpu_pct_avg: cpuSamples.length ? Math.round(cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length) : null,
    node_rss_mb_max: machines.length ? Math.round(Math.max(...machines.flatMap((m) => m.rss))) : null,
    coordinator_cpu_cores: +(process.cpuUsage().user / 1e6 / ((Date.now() - t0) / 1000)).toFixed(2)
  }
  console.log(JSON.stringify(report, null, 2))
  if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(report, null, 2) + '\n')
  await sleep(20000) // node machines see /done
  for (const m of meters) m.client.end(true)
  anvil.kill()
  process.exit(0)
}

async function nodes () {
  const base = opt('coordinator')
  const from = Number(opt('from', 0))
  const count = Number(opt('count', 8))
  let cluster = null
  while (!cluster) {
    try { cluster = await (await fetch(base + '/cluster.json')).json() } catch { await sleep(2000) }
  }
  // (--dir: the storage of nodes restarted mid-run; their keys, what they
  // signed and stored stay, as an operator's do across an upgrade)
  const tmp = opt('dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'boat-cluster-'))
  const procs = []
  for (const n of cluster.nodes.slice(from, from + count)) {
    const dir = path.join(tmp, 'n' + n.index)
    fs.mkdirSync(dir, { recursive: true })
    if (fs.existsSync(path.join(dir, 'seed'))) {
      const out = fs.openSync(path.join(dir, 'log'), 'a')
      procs.push(spawn(process.execPath, [new URL('../bin/boat-node.js', import.meta.url).pathname, 'run', dir], { stdio: ['ignore', out, out], env: { ...process.env, BOAT_STATUS_MS: '15000' } }))
      continue
    }
    fs.writeFileSync(path.join(dir, 'seed'), n.seed, { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'operator.key'), n.key, { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'node.json'), JSON.stringify({ rpc: cluster.rpc, registry: cluster.registry, roles: ['forward', 'store', 'verify', 'compute'], autoRegister: true, network: 'boat-cluster', bootstrap: cluster.bootstrap, jobPollMs: 2000, listMs: 60000, settleDelayMs: 1000, backupMs: 4000, rewardMs: 30000, maxJobs: 100000 }))
    const out = fs.openSync(path.join(dir, 'log'), 'a')
    procs.push(spawn(process.execPath, [new URL('../bin/boat-node.js', import.meta.url).pathname, 'run', dir], { stdio: ['ignore', out, out], env: { ...process.env, BOAT_STATUS_MS: '15000' } }))
  }
  log(`${procs.length} nodes started (${from}..${from + count - 1})`)
  // a node that exits is started again, as systemd would (Restart=always):
  // counted in `restarts`, with its exit in its log
  const mine = cluster.nodes.slice(from, from + count)
  let restarts = 0
  const respawn = () => {
    for (let i = 0; i < procs.length; i++) {
      if (procs[i].exitCode === null && procs[i].signalCode === null) continue
      const dir = path.join(tmp, 'n' + mine[i].index)
      const out = fs.openSync(path.join(dir, 'log'), 'a')
      fs.writeSync(out, `${new Date().toISOString()} exited (${procs[i].exitCode ?? procs[i].signalCode}): started again\n`)
      procs[i] = spawn(process.execPath, [new URL('../bin/boat-node.js', import.meta.url).pathname, 'run', dir], { stdio: ['ignore', out, out], env: { ...process.env, BOAT_STATUS_MS: '15000' } })
      restarts++
      log(`node ${mine[i].index} exited: started again`)
    }
  }
  const hostname = os.hostname()
  const lastCpu = new Map() // pid -> CPU seconds at the last sample
  for (;;) {
    await sleep(15000)
    respawn()
    let cpu = []
    let rss = []
    try {
      // % of a core over the last 15 s
      for (const p of cpuOf(procs.map((p) => p.pid))) {
        if (lastCpu.has(p.pid)) cpu.push((100 * (p.cpu - lastCpu.get(p.pid))) / 15)
        lastCpu.set(p.pid, p.cpu)
        rss.push(p.rss)
      }
    } catch {}
    let disk = null
    try { disk = Number(execFileSync('df', ['--output=pcent', tmp]).toString().split('\n')[1].trim().replace('%', '')) } catch {}
    const alive = procs.filter((p) => p.exitCode === null).length
    await fetch(base + '/stats', { method: 'POST', body: JSON.stringify({ host: hostname, cores: os.cpus().length, cpu, rss, disk, memFree: Math.round(os.freemem() / 1e6), alive, restarts }) }).catch(() => {})
    const d = await fetch(base + '/done').then((r) => r.text()).catch(() => 'no')
    if (d === 'yes') break
  }
  for (const p of procs) p.kill('SIGTERM')
  await sleep(3000)
  // keep the logs (~/cluster-logs), not the stores
  const keep = path.join(os.homedir(), 'cluster-logs')
  fs.mkdirSync(keep, { recursive: true })
  for (const n of cluster.nodes.slice(from, from + count)) {
    try { fs.copyFileSync(path.join(tmp, 'n' + n.index, 'log'), path.join(keep, 'n' + n.index + '.log')) } catch {}
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  log('done')
  process.exit(0)
}
