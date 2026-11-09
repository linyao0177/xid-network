// A long run of the network: boat-node processes on this machine (others,
// on other machines, run on their own), a device publishing to them, jobs on
// the registry. Every sampleMin it records what the chain, the DHT and the
// board say; at the hours in --disrupt it stops the node the device is on
// (when it is one of ours) for a while and records how the device moves.
//
// usage: node examples/soak.js --deployment <file> --device <hex> --verifiers <hex,hex,..>
//        --node <dir>... [--liar <dir>] [--hours 24] [--sample-min 10]
//        [--disrupt 3,12] [--down-min 10] [--board-log <file>] [--out <dir>]
//
// --liar: a node with testLie, run until it is slashed (or for an hour).
// --board-log: the board's serial log (a passive logger), for its counts.

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import HyperDHT from 'hyperdht'
import { attach, providerFor, readNodeList } from '../index.js'
import { homeOf } from 'boat-mqtt-node'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const all = (name) => args.flatMap((a, i) => (a === '--' + name ? [args[i + 1]] : []))
const dep = JSON.parse(fs.readFileSync(opt('deployment'), 'utf8'))
const device = opt('device')
const trusted = opt('verifiers').split(',')
const hours = Number(opt('hours', 24))
const sampleMs = Number(opt('sample-min', 10)) * 60000
const disrupt = opt('disrupt', '3,12').split(',').filter(Boolean).map(Number)
const downMs = Number(opt('down-min', 10)) * 60000
const out = opt('out', path.join(path.dirname(opt('deployment')), 'soak'))
fs.mkdirSync(out, { recursive: true })
const record = (kind, data) => fs.appendFileSync(path.join(out, 'soak.jsonl'), JSON.stringify({ t: new Date().toISOString(), kind, ...data }, (k, v) => (typeof v === 'bigint' ? String(v) : v)) + '\n')
const log = (line) => console.log(new Date().toISOString().slice(0, 19) + ' ' + line)

const provider = await providerFor(dep.rpc)
const reg = attach(dep.registry, provider)
const dht = new HyperDHT()
const here = path.dirname(new URL(import.meta.url).pathname)

// nodes on this machine
const procs = new Map() // dir -> child
function start (dir) {
  const logFile = fs.openSync(path.join(path.dirname(dir), path.basename(dir) + '.log'), 'a')
  const p = spawn(process.execPath, [path.join(here, '..', 'bin', 'boat-node.js'), 'run', dir], { stdio: ['ignore', logFile, logFile], env: process.env })
  procs.set(dir, p)
  p.on('exit', (code) => {
    record('node-exit', { node: path.basename(dir), code })
    if (procs.get(dir) === p && !stopping) setTimeout(() => { if (procs.get(dir) === p) start(dir) }, 5000)
  })
  record('node-start', { node: path.basename(dir), pid: p.pid })
}
let stopping = false
const nodes = all('node')
for (const d of nodes) start(d)
const keyOf = (dir) => HyperDHT.keyPair(Buffer.from(fs.readFileSync(path.join(dir, 'seed'), 'utf8').trim(), 'hex')).publicKey.toString('hex')
const liar = opt('liar')
if (liar) start(liar)

const started = Date.now()
const jobsCount = Number(await reg.jobCount())
const jobs = []
for (let i = 0; i < jobsCount; i++) {
  const j = await reg.jobs(i)
  if (j.device.slice(2) === device) jobs.push({ id: i, role: Number(j.role) })
}
log(`soak for ${hours} h: ${nodes.length} local node(s), jobs ${jobs.map((j) => j.id).join(',')}, out ${out}`)
record('start', { device, jobs, nodes: nodes.map((d) => path.basename(d)), hours })

async function settledSince (jobId, fromBlock) {
  const ev = await reg.queryFilter(reg.filters.Settled(jobId), fromBlock).catch(() => [])
  return ev.length
}

let lastBlock = Number(await provider.getBlockNumber())
const firstBlock = lastBlock
const operators = []
for (let i = 0n, n = await reg.operatorCount(); i < n; i++) operators.push(await reg.operators(i))

function boardCounts () {
  const f = opt('board-log')
  if (!f || !fs.existsSync(f)) return null
  const text = fs.readFileSync(f, 'utf8')
  const count = (re) => (text.match(re) || []).length
  return {
    telemetry: count(/MQTT\|telemetry seq=/g),
    connected: count(/MQTT\|connected/g),
    disconnected: count(/MQTT\|disconnected/g),
    lists: count(/NODELIST\|epoch=/g),
    noQuorum: count(/NODELIST\|no list/g),
    receiptsOk: count(/receipt .*ok/gi),
    resets: count(/rst:0x/g)
  }
}

async function sample () {
  const block = Number(await provider.getBlockNumber())
  const settled = {}
  for (const j of jobs) settled[j.id] = await settledSince(j.id, lastBlock + 1)
  const slashes = (await reg.queryFilter(reg.filters.Slashed(), lastBlock + 1).catch(() => [])).map((e) => ({ operator: e.args.operator, amount: e.args.amount, reason: e.args.reason }))
  lastBlock = block
  const ops = {}
  for (const o of operators) {
    const n = await reg.nodes(o)
    const [pending, matured] = await reg.rewards(o)
    ops[o] = { active: n.active, stake: n.stake, pending, matured, gas: await provider.getBalance(o) }
  }
  const home = await homeOf(dht, device).catch(() => null)
  const list = await readNodeList(dht, trusted).catch(() => null)
  const s = {
    hour: ((Date.now() - started) / 3600000).toFixed(2),
    block,
    settled,
    slashes,
    home: home ? home.toString('hex') : null,
    list: list ? { epoch: list.list.epoch, nodes: list.list.nodes.length, votes: list.votes } : null,
    operators: ops,
    board: boardCounts()
  }
  record('sample', s)
  log(`h ${s.hour}: settled ${JSON.stringify(settled)}, home ${s.home ? s.home.slice(0, 8) : '-'}, list ${s.list ? `${s.list.nodes} nodes ${s.list.votes} votes` : 'none'}, slashes ${slashes.length}${s.board ? `, board ${s.board.telemetry} msgs ${s.board.connected} connects` : ''}`)
  if (liar && procs.has(liar) && (slashes.some((x) => !ops[x.operator]?.active) || Date.now() - started > 3600000)) {
    stopping = true
    procs.get(liar).kill('SIGTERM')
    procs.delete(liar)
    stopping = false
    record('liar-stopped', {})
    log('the liar node is stopped')
  }
}

// stops the node the device is on, if it is ours, and times the move
async function disruptNow (n) {
  const home = await homeOf(dht, device).catch(() => null)
  const dir = nodes.find((d) => home && keyOf(d) === home.toString('hex'))
  if (!dir) {
    record('disrupt-skipped', { n, home: home && home.toString('hex'), reason: 'the device is on a node of another machine' })
    log(`disruption ${n}: the device is on ${home ? home.toString('hex').slice(0, 8) : 'no node'}, not ours: skipped`)
    return
  }
  const t0 = Date.now()
  stopping = true
  procs.get(dir).kill('SIGTERM')
  procs.delete(dir)
  stopping = false
  record('disrupt', { n, node: path.basename(dir) })
  log(`disruption ${n}: stopped ${path.basename(dir)}, where the device was`)
  let moved = null
  while (Date.now() - t0 < downMs) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const h = await homeOf(dht, device).catch(() => null)
    if (h && h.toString('hex') !== home.toString('hex')) {
      moved = { to: h.toString('hex'), s: (Date.now() - t0) / 1000 }
      break
    }
  }
  record('moved', { n, ...(moved || { s: null }) })
  log(moved ? `the device named its new home ${moved.to.slice(0, 8)} after ${moved.s} s` : 'the device did not name a new home while the node was down')
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, downMs - (Date.now() - t0))))
  start(dir)
}

for (const h of disrupt) setTimeout(() => disruptNow(h).catch((err) => log('disrupt: ' + err.message)), h * 3600000)
const timer = setInterval(() => sample().catch((err) => log('sample: ' + (err.shortMessage || err.message))), sampleMs)
await sample().catch((err) => log('sample: ' + err.message))

let finishing = false
async function finish () {
  if (finishing) return
  finishing = true
  clearInterval(timer)
  // our nodes first: they must not outlive the soak, whatever happens next
  stopping = true
  for (const p of procs.values()) p.kill('SIGTERM')
  await Promise.race([sample().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 30000))])
  const lines = fs.readFileSync(path.join(out, 'soak.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const samples = lines.filter((l) => l.kind === 'sample')
  const total = {}
  for (const s of samples) for (const [k, v] of Object.entries(s.settled)) total[k] = (total[k] || 0) + v
  const summary = {
    hours: (Date.now() - started) / 3600000,
    blocks: [firstBlock, lastBlock],
    settled: total,
    slashes: samples.flatMap((s) => s.slashes),
    moves: lines.filter((l) => l.kind === 'moved'),
    nodeExits: lines.filter((l) => l.kind === 'node-exit').length,
    listMissing: samples.filter((s) => !s.list).length,
    first: samples[0],
    last: samples.at(-1)
  }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
  log('summary in ' + path.join(out, 'summary.json'))
  await Promise.race([dht.destroy(), new Promise((resolve) => setTimeout(resolve, 5000))])
  setTimeout(() => process.exit(0), 3000)
}
setTimeout(finish, hours * 3600000)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, finish)
