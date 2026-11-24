#!/usr/bin/env node
// Checks the public testnet from public data, and says what is wrong.
//
// usage: node examples/testnet-health.js [--api https://iot.xid.network]
//        [--explorer https://testnet.arcscan.app] [--snapshot <file>]
//
// --snapshot reads a saved /api/network instead, and skips the explorer.
// Exit code: 0 healthy, 1 unhealthy, 2 the check itself could not run. An
// explorer that does not answer is reported, and is not an alert by itself.

import fs from 'fs'
import { BATCH_SETTLED_TOPIC, assess, countSettlements, missedBatches } from '../lib/health.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const API = opt('api', 'https://iot.xid.network')
const EXPLORER = opt('explorer', 'https://testnet.arcscan.app')
const MAX_PAGES = 10
const LOG_CHUNK = 5000

async function getJson (url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.json()
}

// the settlement transactions a node sent in [from, to); past MAX_PAGES, those
// counted so far: a node sending that many is what the check is there to catch
async function sentBy (operator, from, to) {
  let params = new URLSearchParams({ filter: 'from' })
  let total = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await getJson(`${EXPLORER}/api/v2/addresses/${operator}/transactions?${params}`)
    const items = d.items || []
    const { count, done } = countSettlements(items, from, to)
    total += count
    if (done || !d.next_page_params) return total
    params = new URLSearchParams({ filter: 'from', ...d.next_page_params })
  }
  return total
}

// (a public RPC limits its callers: HTTP 429 is "not yet", anything else fails)
async function rpc (url, method, params, tries = 4) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) })
  if (res.status === 429 && tries > 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (4 - tries)))
    return rpc(url, method, params, tries - 1)
  }
  if (!res.ok) throw new Error(`rpc: HTTP ${res.status}`)
  const d = await res.json()
  if (d.error) throw new Error(`rpc: ${d.error.message}`)
  return d.result
}

// batches skipped, from the chain: the last six hours of settlements, counting
// a gap whose next batch settled between three hours and half an hour ago
async function chainGaps () {
  const { rpc: urls, registry } = await getJson(`${API}/testnet.json`)
  const url = Array.isArray(urls) ? urls[0] : urls
  const blockAt = async (tag) => {
    const b = await rpc(url, 'eth_getBlockByNumber', [tag, false])
    return { n: Number(b.number), at: Number(b.timestamp) }
  }
  const head = await blockAt('latest')
  const past = await blockAt('0x' + Math.max(0, head.n - 3600).toString(16))
  const perSecond = (head.n - past.n) / Math.max(1, head.at - past.at)
  const back = (seconds) => Math.max(0, head.n - Math.ceil(seconds * perSecond))
  const settled = []
  for (let a = back(6 * 3600); a <= head.n; a += LOG_CHUNK) {
    const logs = await rpc(url, 'eth_getLogs', [{ address: registry, topics: [BATCH_SETTLED_TOPIC], fromBlock: '0x' + a.toString(16), toBlock: '0x' + Math.min(head.n, a + LOG_CHUNK - 1).toString(16) }])
    for (const l of logs) settled.push({ job: Number(BigInt(l.topics[1])), batch: BigInt(l.topics[2]), block: Number(l.blockNumber) })
  }
  return missedBatches(settled, back(3 * 3600), back(1800))
}

try {
  const file = opt('snapshot')
  const snap = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : await getJson(`${API}/api/network`)
  const now = Date.now()
  let sent = null
  let missed = null
  if (!file) {
    try {
      missed = await chainGaps()
    } catch (err) {
      console.log(`batches: not checked (${err.message})`)
    }
    const hour = Math.floor(now / 3600000) * 3600 - 3600
    try {
      const counts = await Promise.all(snap.nodes.filter((n) => n.public && n.active).map((n) => sentBy(n.operator, hour, hour + 3600)))
      sent = { hour, count: counts.reduce((a, b) => a + b, 0) }
    } catch (err) {
      console.log(`explorer: not checked (${err.message})`)
    }
  }
  const r = assess(snap, { now, sent, missed })
  console.log(`${r.ok ? 'healthy' : 'UNHEALTHY'} at ${new Date(now).toISOString()}`)
  console.log(`lowest node gas ${r.metrics.lowestGas ?? '?'} USDC, last settlement ${r.metrics.quietMin ?? '?'} min ago, snapshot ${r.metrics.snapshotAgeMin} min old`)
  if (sent) console.log(`last full hour: ${sent.count} settlement transactions, ${r.metrics.empty} settled nothing`)
  if (missed) console.log(`batches skipped in the window: ${missed.length}`)
  for (const a of r.alerts) console.log(`- ${a.code}: ${a.text}`)
  process.exit(r.ok ? 0 : 1)
} catch (err) {
  console.log(`UNHEALTHY: the check could not run: ${err.message}`)
  process.exit(2)
}
