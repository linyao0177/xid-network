#!/usr/bin/env node
// The public testnet's hub: what iot.xid.network/network shows, and its faucet.
//
// usage: boat-testnet-hub --key-file <hub wallet> --token-file <hub token>
//        [--testnet https://iot.xid.network/testnet.json] [--api https://iot.xid.network]
//        [--state hub-state.json] [--drip-gas 0.1] [--drip-token 1000000000]
//        [--sponsor-units 500]
//
// It follows the registry's events (nodes, jobs, settlements, slashes),
// watches what devices publish on every public node, and every 30 s pushes
// one snapshot to the site (POST /api/hub/snapshot). It also does the
// requests the site queues (POST /api/hub/take):
//   faucet <address>: --drip-gas Arc USDC for gas and --drip-token of the
//     test stake token (TSUSD, 6 decimals), enough to stake a node and pay jobs;
//   sponsor <device>: verify and store jobs on the device's readings, paid by
//     the hub in TSUSD (--sponsor-units units each, 1 TSUSD a unit).
// The hub wallet pays the gas; the stake token mints for anyone. The key file
// and the token never leave this machine and are never printed.

import fs from 'fs'
import HyperDHT from 'hyperdht'
import { Wallet, NonceManager, Contract, parseEther, formatEther, formatUnits } from 'ethers'
import { connect, senderOf, SignedInbox } from 'boat-mqtt-node'
import { attach, providerFor, TEST_TOKEN, ROLES, postJob, verifyJob, storeJob } from '../index.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const log = (line) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ' + line)
const API = opt('api', 'https://iot.xid.network')
const TOKEN = fs.readFileSync(opt('token-file'), 'utf8').trim()
const STATE = opt('state', 'hub-state.json')
const DRIP_GAS = opt('drip-gas', '0.1')
const DRIP_TOKEN = BigInt(opt('drip-token', '1000000000'))
const SPONSOR_UNITS = BigInt(opt('sponsor-units', '500'))

const src = opt('testnet', 'https://iot.xid.network/testnet.json')
const testnet = src.startsWith('http') ? await (await fetch(src)).json() : JSON.parse(fs.readFileSync(src, 'utf8'))
const provider = await providerFor(testnet.rpc)
// the hub counts its own nonces: the RPC sits behind a load balancer, and a
// server a block behind hands out a nonce the last transaction already used
const key = new Wallet(fs.readFileSync(opt('key-file'), 'utf8').trim(), provider)
const wallet = new NonceManager(key)
wallet.address = key.address
const registry = attach(testnet.registry, wallet)
const token = new Contract(testnet.token, TEST_TOKEN.abi, wallet)
const roleName = Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [v, k.toLowerCase()]))
const rolesOf = (bits) => Object.entries(ROLES).filter(([, v]) => Number(bits) & v).map(([k]) => k.toLowerCase())
log(`hub ${wallet.address} on ${testnet.name}, registry ${testnet.registry}`)

// ---- the registry's events, kept on disk ----------------------------------------

const fresh = () => ({ version: 2, registry: testnet.registry, block: testnet.block - 1, nodes: {}, jobs: {}, hours: {}, slashes: [], txs: 0, units: 0, paid: '0' })
let state = fresh()
try {
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  if (saved.registry === testnet.registry && saved.version === 2) state = saved
} catch {}
const save = () => fs.writeFileSync(STATE + '.tmp', JSON.stringify(state)) || fs.renameSync(STATE + '.tmp', STATE)

let chunk = 2000
const blockTimes = new Map()
async function timeOf (n) {
  if (!blockTimes.has(n)) {
    if (blockTimes.size > 5000) blockTimes.clear()
    blockTimes.set(n, (await provider.getBlock(n)).timestamp)
  }
  return blockTimes.get(n)
}

// total: what the settlement paid (Settled: one unit's pay; BatchSettled: the batch's)
function settle (s, id, units, total, hour) {
  const j = s.jobs[id]
  if (j) {
    j.units += units
    j.paid = (BigInt(j.paid) + total).toString()
  }
  s.units += units
  s.paid = (BigInt(s.paid) + total).toString()
  const h = (s.hours[hour] ??= { units: 0, txs: 0 })
  h.units += units
}

async function follow () {
  const head = (await provider.getBlockNumber()) - 2
  const txs = new Set()
  while (state.block < head) {
    const from = state.block + 1
    const to = Math.min(head, from + chunk - 1)
    let logs
    try {
      logs = await provider.getLogs({ address: testnet.registry, fromBlock: from, toBlock: to })
    } catch (err) {
      if (chunk > 50 && /range|too large|limit|exceed/i.test(err.error?.message || err.message)) { chunk = Math.floor(chunk / 2); continue }
      throw err
    }
    logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index))
    // a chunk applies in full or not at all: an RPC error halfway is tried again
    const next = structuredClone(state)
    for (const l of logs) {
      let e
      try { e = registry.interface.parseLog(l) } catch { continue }
      if (!e) continue
      const a = e.args
      const at = await timeOf(l.blockNumber)
      const hour = Math.floor(at / 3600) * 3600
      switch (e.name) {
        case 'NodeRegistered': next.nodes[a.operator] = { dhtKey: a.dhtKey.slice(2), since: at }; break
        case 'JobPosted':
          next.jobs[Number(a.id)] = { id: Number(a.id), payer: a.payer, device: a.device.slice(2), role: roleName[Number(a.role)] || String(a.role), pay: a.pay.toString(), quorum: Number(a.quorum), budget: a.budget.toString(), units: 0, paid: '0', posted: at, closed: false, spent: false }
          break
        case 'JobFunded': { const j = next.jobs[Number(a.id)]; if (j) { j.budget = (BigInt(j.budget) + a.amount).toString(); j.spent = false } break }
        case 'JobSpent': { const j = next.jobs[Number(a.id)]; if (j) j.spent = true; break }
        case 'JobClosed': { const j = next.jobs[Number(a.id)]; if (j) j.closed = true; break }
        case 'Settled': settle(next, Number(a.id), 1, a.pay, hour); txs.add(l.transactionHash); break
        case 'BatchSettled': settle(next, Number(a.id), Number(a.units), a.pay, hour); txs.add(l.transactionHash); break
        case 'Slashed': next.slashes.push({ operator: a.operator, amount: a.amount.toString(), reason: a.reason, at }); break
      }
    }
    // count each settling transaction once, in the hour it landed
    for (const tx of txs) {
      const r = logs.find((l) => l.transactionHash === tx)
      if (!r) continue
      const hour = Math.floor((await timeOf(r.blockNumber)) / 3600) * 3600
      next.hours[hour].txs++
      next.txs++
    }
    txs.clear()
    next.block = to
    state = next
  }
  // keep 72 hours
  const cut = Math.floor(Date.now() / 1000) - 72 * 3600
  for (const h of Object.keys(state.hours)) if (Number(h) < cut) delete state.hours[h]
  save()
}

// ---- devices: what they publish on the public nodes -----------------------------

const devices = new Map() // key -> { first, last, count, node, text, kind }
const online = new Map() // node key -> { connected, since, error }
const inbox = new SignedInbox()
const dht = new HyperDHT()
const hubKeys = HyperDHT.keyPair()

function watchNode (n) {
  const st = { connected: false, since: 0, error: null }
  online.set(n.nodeKey, st)
  const start = async () => {
    try {
      const client = await connect(n.nodeKey, { dht, keyPair: hubKeys })
      st.connected = true
      st.since = Date.now()
      st.error = null
      client.on('connect', () => { st.connected = true; st.since = Date.now() })
      client.on('close', () => { st.connected = false })
      client.on('error', (err) => { st.error = err.message })
      await client.subscribeAsync('d/+/telemetry', { qos: 0 })
      client.on('message', (topic, payload) => {
        const dev = senderOf(topic)
        if (!dev) return
        let d = devices.get(dev)
        if (!d) devices.set(dev, (d = { first: Date.now(), count: 0 }))
        d.last = Date.now()
        d.count++
        d.node = n.name
        if (payload[0] === 0x53 && payload[1] === 1) {
          const r = inbox.check(topic, payload)
          const inner = r.ok ? Buffer.from(r.payload) : null
          // a sealed reading is signed too; only its readers can open it
          d.kind = !r.ok ? 'refused' : inner[0] === 0x45 && inner[1] === 1 ? 'sealed' : 'signed'
          d.text = !r.ok ? r.reason : d.kind === 'sealed' ? null : inner.toString().slice(0, 160)
        } else if (payload.length > 0 && payload[0] === 0x45) {
          d.kind = 'sealed'
          d.text = null
        } else {
          d.kind = 'plain'
          d.text = String(payload).slice(0, 160)
        }
      })
    } catch (err) {
      st.connected = false
      st.error = err.message
      setTimeout(start, 30000)
    }
  }
  start()
}
for (const n of testnet.nodes) watchNode(n)

// ---- requests the site queued ---------------------------------------------------

const hubCall = async (what, body) => {
  const res = await fetch(`${API}/api/hub/${what}`, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) })
  if (!res.ok) throw new Error(`${what}: ${res.status}`)
  return res.json()
}

async function faucet (address) {
  const gas = await wallet.sendTransaction({ to: address, value: parseEther(DRIP_GAS) })
  await gas.wait()
  const mint = await token.mint(address, DRIP_TOKEN)
  await mint.wait()
  return { gas: DRIP_GAS, token: DRIP_TOKEN.toString(), txs: [gas.hash, mint.hash] }
}

async function sponsor (device) {
  const pay = 1000000n
  const budget = pay * SPONSOR_UNITS
  await (await token.mint(wallet.address, budget * 2n + 10000000n)).wait()
  const jobs = {}
  for (const [k, terms] of [['verify', verifyJob({ window: 20 })], ['store', storeJob({ window: 20 })]]) {
    // settled in Merkle batches of 6 units: one transaction pays for six
    jobs[k] = await postJob(registry, wallet, { ...terms, device, pay, quorum: 2, budget, batchUnits: 6 })
  }
  return { jobs, units: SPONSOR_UNITS.toString() }
}

let working = false
async function serve () {
  if (working) return
  working = true
  try {
    const { requests } = await hubCall('take')
    for (const r of requests) {
      try {
        const run = () => r.kind === 'faucet' ? faucet(r.target) : sponsor(r.target)
        // once more after an error, with the nonce read from the chain again
        const result = await run().catch(async (err) => {
          log(`${r.kind} ${r.target.slice(0, 14)}…: ${err.error?.message || err.shortMessage || err.message}; trying again`)
          wallet.reset()
          await new Promise((resolve) => setTimeout(resolve, 3000))
          return run()
        })
        await hubCall('done', { id: r.id, ok: true, result })
        log(`${r.kind} ${r.target.slice(0, 14)}… done`)
      } catch (err) {
        wallet.reset()
        const why = err.error?.message || err.shortMessage || err.message
        await hubCall('done', { id: r.id, ok: false, result: { error: why } }).catch(() => {})
        log(`${r.kind} ${r.target.slice(0, 14)}… failed: ${why}`)
      }
    }
  } catch (err) {
    log('queue: ' + err.message)
  } finally {
    working = false
  }
}

// ---- the snapshot ---------------------------------------------------------------

async function snapshot () {
  const now = Date.now()
  const known = new Map(testnet.nodes.map((n) => [n.operator.toLowerCase(), n]))
  const nodes = []
  for (const [operator, seen] of Object.entries(state.nodes)) {
    const r = await registry.nodes(operator)
    const [pending, matured] = await registry.rewards(operator)
    const k = known.get(operator.toLowerCase())
    nodes.push({
      operator,
      name: k?.name ?? null,
      location: k?.location ?? null,
      nodeKey: seen.dhtKey,
      public: Boolean(k),
      online: k ? online.get(k.nodeKey)?.connected ?? false : null,
      roles: rolesOf(r.roles),
      active: r.active,
      stake: formatUnits(r.stake, 6),
      capacity: Number(r.capacity),
      rewards: formatUnits(pending + matured, 6),
      gas: formatEther(await provider.getBalance(operator)),
      since: seen.since
    })
  }
  const jobs = Object.values(state.jobs).sort((a, b) => b.id - a.id).slice(0, 100)
    .map((j) => ({ ...j, paid: formatUnits(j.paid, 6), budget: formatUnits(j.budget, 6), left: formatUnits(BigInt(j.budget) - BigInt(j.paid), 6), pay: formatUnits(j.pay, 6) }))
  const jobsOf = new Map()
  for (const j of Object.values(state.jobs)) {
    const l = jobsOf.get(j.device) || []
    l.push(j.id)
    jobsOf.set(j.device, l)
  }
  const devs = [...devices.entries()].sort((a, b) => b[1].last - a[1].last).slice(0, 200)
    .map(([key, d]) => ({ key, ...d, jobs: jobsOf.get(key) || [] }))
  const hourNow = Math.floor(now / 3600000) * 3600
  const hours = []
  for (let h = hourNow - 47 * 3600; h <= hourNow; h += 3600) hours.push({ hour: h, units: state.hours[h]?.units || 0, txs: state.hours[h]?.txs || 0 })
  const body = {
    at: now,
    testnet: { name: testnet.name, network: testnet.network, chain: testnet.chain, chainId: testnet.chainId, registry: testnet.registry, token: testnet.token, explorer: testnet.explorer },
    chain: { block: state.block },
    totals: {
      nodes: nodes.length,
      activeNodes: nodes.filter((n) => n.active).length,
      devicesLive: devs.filter((d) => now - d.last < 600000).length,
      devicesSeen: devices.size,
      jobs: Object.keys(state.jobs).length,
      openJobs: Object.values(state.jobs).filter((j) => !j.closed && !j.spent).length,
      unitsSettled: state.units,
      paid: formatUnits(state.paid, 6),
      settleTxs: state.txs,
      slashes: state.slashes.length
    },
    nodes,
    jobs,
    devices: devs,
    hours,
    slashes: state.slashes.slice(-20),
    faucet: { address: wallet.address, gas: formatEther(await provider.getBalance(wallet.address)) }
  }
  await hubCall('snapshot', JSON.stringify(body))
}

const loop = (name, fn, ms) => {
  const run = async () => {
    try { await fn() } catch (err) { log(`${name}: ${err.shortMessage || err.message}`) }
    setTimeout(run, ms)
  }
  run()
}
loop('chain', follow, 15000)
loop('requests', serve, 10000)
setTimeout(() => loop('snapshot', snapshot, 30000), 20000)
setInterval(() => log(`devices ${devices.size}, nodes online ${[...online.values()].filter((s) => s.connected).length}/${online.size}, units ${state.units}, txs ${state.txs}`), 300000)
