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
import { assess, countSettlements } from '../lib/health.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const API = opt('api', 'https://iot.xid.network')
const EXPLORER = opt('explorer', 'https://testnet.arcscan.app')
const MAX_PAGES = 10

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

try {
  const file = opt('snapshot')
  const snap = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : await getJson(`${API}/api/network`)
  const now = Date.now()
  let sent = null
  if (!file) {
    const hour = Math.floor(now / 3600000) * 3600 - 3600
    try {
      const counts = await Promise.all(snap.nodes.filter((n) => n.public && n.active).map((n) => sentBy(n.operator, hour, hour + 3600)))
      sent = { hour, count: counts.reduce((a, b) => a + b, 0) }
    } catch (err) {
      console.log(`explorer: not checked (${err.message})`)
    }
  }
  const r = assess(snap, { now, sent })
  console.log(`${r.ok ? 'healthy' : 'UNHEALTHY'} at ${new Date(now).toISOString()}`)
  console.log(`lowest node gas ${r.metrics.lowestGas ?? '?'} USDC, last settlement ${r.metrics.quietMin ?? '?'} min ago, snapshot ${r.metrics.snapshotAgeMin} min old`)
  if (sent) console.log(`last full hour: ${sent.count} settlement transactions, ${r.metrics.empty} settled nothing`)
  for (const a of r.alerts) console.log(`- ${a.code}: ${a.text}`)
  process.exit(r.ok ? 0 : 1)
} catch (err) {
  console.log(`UNHEALTHY: the check could not run: ${err.message}`)
  process.exit(2)
}
