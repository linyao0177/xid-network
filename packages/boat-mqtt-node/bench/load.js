// Load on one node: N clients over HyperDHT (or TCP, for comparison), each
// publishing a small message every few seconds, all on this machine.
//
// usage: node bench/load.js [--clients 1000] [--workers 4] [--transport hdht|tcp]
//                           [--rate 200] [--hold 60] [--interval 10]
//
// The node runs in a process of its own (bin/boat-mqtt-node.js) on a local
// HyperDHT testnet, so its memory and CPU can be read apart. Worker processes
// open the clients at --rate per second in all; a subscriber on the node's TCP
// port receives every message and measures delivery and latency. Prints one
// JSON summary line at the end (BENCH|...).

import { spawn, fork } from 'child_process'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import createTestnet from 'hyperdht/testnet.js'
import HyperDHT from 'hyperdht'
import mqtt from 'mqtt'
import { toNode } from '../lib/stream.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}

// ---- worker ----------------------------------------------------------------------------
if (process.env.BENCH_WORKER) {
  const { bootstrap, nodeKey, tcpPort, password, count, rate, interval, transport } = JSON.parse(process.env.BENCH_WORKER)
  const dht = transport === 'hdht' ? new HyperDHT({ bootstrap }) : null
  const nodePk = Buffer.from(nodeKey, 'hex')
  const times = []
  let failed = 0
  let sent = 0
  const clients = []
  const open = () => new Promise((resolve) => {
    const t = Date.now()
    let c
    if (transport === 'hdht') {
      const keyPair = HyperDHT.keyPair()
      c = new mqtt.MqttClient(() => toNode(dht.connect(nodePk, { keyPair })), { clientId: keyPair.publicKey.toString('hex'), protocolVersion: 4, reconnectPeriod: 0, connectTimeout: 60000, keepalive: 120 })
      c.topic = `d/${keyPair.publicKey.toString('hex')}/telemetry`
    } else {
      const id = 'w' + process.pid + '-' + clients.length
      c = mqtt.connect(`mqtt://127.0.0.1:${tcpPort}`, { clientId: id, username: 'bench', password, reconnectPeriod: 0, connectTimeout: 60000, keepalive: 120 })
      c.topic = `bench/${id}/telemetry`
    }
    c.on('error', () => {})
    c.once('connect', () => { times.push(Date.now() - t); resolve(c) })
    c.once('close', () => { if (!c.connected) { failed++; resolve(null) } })
  })
  const gap = 1000 / rate
  const pending = []
  for (let i = 0; i < count; i++) {
    pending.push(open().then((c) => {
      if (!c) return
      clients.push(c)
      // spread the publishes over the interval
      setTimeout(() => setInterval(() => {
        if (!c.connected) return
        c.publish(c.topic, JSON.stringify({ t: Date.now() }), { qos: 0 })
        sent++
      }, interval * 1000), Math.random() * interval * 1000)
    }))
    await new Promise((resolve) => setTimeout(resolve, gap))
  }
  await Promise.all(pending)
  process.send({ type: 'ready', times, failed, connected: clients.length })
  process.on('message', (m) => {
    if (m === 'stats') process.send({ type: 'stats', sent, connected: clients.filter((c) => c.connected).length })
    if (m === 'quit') {
      for (const c of clients) c.end(true)
      process.exit(0)
    }
  })
} else {
  await main()
}

// ---- main ------------------------------------------------------------------------------
async function main () {
  const total = Number(opt('clients', 1000))
  const workers = Number(opt('workers', 4))
  const transport = opt('transport', 'hdht')
  const rate = Number(opt('rate', 200))
  const hold = Number(opt('hold', 60))
  const interval = Number(opt('interval', 10))

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mqtt-bench-'))
  const password = Math.random().toString(36).slice(2)
  fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ bench: password, sub: password }))
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${b.port}`)
  const tcpPort = 20000 + Math.floor(Math.random() * 20000)

  const node = spawn('node', ['--max-old-space-size=8192', path.join(here, '..', 'bin', 'boat-mqtt-node.js'), '--key', path.join(tmp, 'node.json'), '--no-announce', '--bootstrap', bootstrap.join(','), '--tcp', String(tcpPort), '--users', path.join(tmp, 'users.json')], { stdio: ['ignore', 'pipe', 'inherit'] })
  const nodeKey = await new Promise((resolve) => node.stdout.on('data', (d) => {
    const m = /node ([0-9a-f]{64})/.exec(String(d))
    if (m) resolve(m[1])
  }))
  node.stdout.resume()
  const sample = () => {
    try {
      const [rss, cpu] = execFileSync('ps', ['-o', 'rss=,%cpu=', '-p', String(node.pid)]).toString().trim().split(/\s+/).map(Number)
      return { rssMB: Math.round(rss / 1024), cpu }
    } catch {
      return null
    }
  }
  const idle = sample()

  // the subscriber, over TCP
  const lat = []
  let received = 0
  const sub = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, { username: 'sub', password, clientId: 'bench-sub' })
  await sub.subscribeAsync(transport === 'hdht' ? 'd/+/telemetry' : 'bench/+/telemetry', { qos: 0 })
  sub.on('message', (t, p) => {
    received++
    const sentAt = JSON.parse(p).t
    if (lat.length < 200000) lat.push(Date.now() - sentAt)
  })

  const t0 = Date.now()
  const per = Math.ceil(total / workers)
  const kids = []
  const ready = []
  for (let w = 0; w < workers; w++) {
    const count = Math.min(per, total - w * per)
    if (count <= 0) break
    const k = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, BENCH_WORKER: JSON.stringify({ bootstrap, nodeKey, tcpPort, password, count, rate: rate / workers, interval, transport }) }, execArgv: ['--max-old-space-size=4096'] })
    kids.push(k)
    ready.push(new Promise((resolve) => k.once('message', resolve)))
  }
  const peak = { rssMB: 0, cpu: 0 }
  const ramp = setInterval(() => {
    const s = sample()
    if (s && s.rssMB > peak.rssMB) peak.rssMB = s.rssMB
  }, 1000)
  const results = await Promise.all(ready)
  const rampS = (Date.now() - t0) / 1000
  clearInterval(ramp)
  const times = results.flatMap((r) => r.times).sort((a, b) => a - b)
  const failedConnects = results.reduce((n, r) => n + r.failed, 0)
  const q = (a, f) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * f))] : null

  // steady state: messages and node load
  received = 0
  lat.length = 0
  const cpus = []
  const holdStart = Date.now()
  const during = setInterval(() => {
    const s = sample()
    if (s) {
      cpus.push(s.cpu)
      if (s.rssMB > peak.rssMB) peak.rssMB = s.rssMB
    }
  }, 2000)
  await new Promise((resolve) => setTimeout(resolve, hold * 1000))
  clearInterval(during)
  const holdS = (Date.now() - holdStart) / 1000
  const stats = await Promise.all(kids.map((k) => new Promise((resolve) => {
    k.once('message', resolve)
    k.send('stats')
  })))
  const still = stats.reduce((n, s) => n + s.connected, 0)
  const steady = sample()
  lat.sort((a, b) => a - b)
  cpus.sort((a, b) => a - b)

  const summary = {
    transport,
    clients: total,
    connected: times.length,
    failedConnects,
    stillConnected: still,
    rampS: Math.round(rampS),
    connectMs: { p50: q(times, 0.5), p95: q(times, 0.95), max: times.at(-1) },
    node: { idleRssMB: idle?.rssMB, rssMB: steady?.rssMB, peakRssMB: peak.rssMB, kbPerClient: steady && idle ? Math.round((steady.rssMB - idle.rssMB) * 1024 / Math.max(1, times.length)) : null, cpuMedian: q(cpus, 0.5), cpuP95: q(cpus, 0.95) },
    msgsPerS: Math.round(received / holdS),
    expectedMsgsPerS: Math.round(still / interval),
    latencyMs: { p50: q(lat, 0.5), p95: q(lat, 0.95), p99: q(lat, 0.99) }
  }
  console.log('BENCH|' + JSON.stringify(summary))
  for (const k of kids) k.send('quit')
  sub.end(true)
  node.kill('SIGTERM')
  await testnet.destroy()
  setTimeout(() => process.exit(0), 2000)
}
