// Is the public testnet healthy? Decided from what anyone can read: the site's
// snapshot (/api/network) and the settlement transactions the nodes sent. No
// dependencies, so a scheduled check runs it without installing anything.

// settleMany and settleBatchMany (test/health.js checks them against the ABI)
export const SETTLE_SELECTORS = ['0x8bd7989c', '0x00ffbcab']

export const HEALTH_LIMITS = {
  maxSnapshotAgeMs: 10 * 60000, // the hub pushes one every 30 s
  minGas: 0.05, // USDC on a node: about 20 settlements
  maxQuietMs: 75 * 60000, // the DePIN epoch settles every hour
  maxEmptyShare: 0.05, // of an hour's settlement transactions
  minEmpty: 5 // fewer than this in an hour is two nodes racing for a batch
}

// when a unit last settled, in ms: from the snapshot, or for a hub that does
// not report it yet, the end of the last hour with a settlement
function lastSettled (snap) {
  const at = snap.totals?.lastSettledAt
  if (at) return at * 1000
  const hours = (snap.hours || []).filter((h) => h.units > 0)
  return hours.length ? (Math.max(...hours.map((h) => h.hour)) + 3600) * 1000 : null
}

// is anything due to settle? A DePIN network's open job, or a live device with
// an open job: anyone can publish under a new key, so a live device alone is
// not work. (A snapshot without the lists falls back on its totals)
function hasWork (snap, now) {
  if (!snap.devices || !snap.jobs) return (snap.totals?.devicesLive || 0) > 0 && (snap.totals?.openJobs || 0) > 0
  const open = new Set(snap.jobs.filter((j) => !j.closed && !j.spent && !j.closesAt).map((j) => j.id))
  if (snap.depin?.job !== undefined && open.has(snap.depin.job)) return true
  return snap.devices.some((d) => now - d.last < 600000 && (d.jobs || []).some((id) => open.has(id)))
}

// sent: { hour, count }, the settlement transactions the nodes sent in that
// hour (null when they could not be read). Returns { ok, alerts, metrics }
export function assess (snap, { now = Date.now(), sent = null, limits = {} } = {}) {
  const l = { ...HEALTH_LIMITS, ...limits }
  const alerts = []
  const alert = (code, text) => alerts.push({ code, text })
  const minutes = (ms) => Math.round(ms / 60000)

  const snapshotAgeMs = now - snap.at
  if (snapshotAgeMs > l.maxSnapshotAgeMs) alert('stale-snapshot', `the hub's last snapshot is ${minutes(snapshotAgeMs)} min old`)

  const nodes = (snap.nodes || []).filter((n) => n.public && n.active)
  const low = nodes.filter((n) => Number(n.gas) < l.minGas)
  if (low.length) alert('low-gas', `below ${l.minGas} USDC of gas: ${low.map((n) => `${n.name} ${Number(n.gas).toFixed(4)}`).join(', ')}`)
  const offline = nodes.filter((n) => n.online === false)
  if (offline.length) alert('node-offline', `offline: ${offline.map((n) => n.name).join(', ')}`)

  // silence only counts while there is work to settle
  const last = lastSettled(snap)
  const quietMs = last === null ? null : Math.max(0, now - last)
  const working = hasWork(snap, now)
  if (working && (quietMs === null || quietMs > l.maxQuietMs)) {
    alert('not-settling', quietMs === null ? 'devices are live and nothing settled in the last 48 hours' : `devices are live and nothing settled for ${minutes(quietMs)} min`)
  }

  let empty = null
  let emptyShare = null
  if (sent) {
    const settled = (snap.hours || []).find((h) => h.hour === sent.hour)?.txs || 0
    empty = Math.max(0, sent.count - settled)
    emptyShare = sent.count ? empty / sent.count : 0
    if (empty >= l.minEmpty && emptyShare > l.maxEmptyShare) alert('empty-settlements', `${empty} of ${sent.count} settlement transactions in the last full hour settled nothing`)
  }

  return {
    ok: alerts.length === 0,
    alerts,
    metrics: {
      snapshotAgeMin: minutes(snapshotAgeMs),
      lowestGas: nodes.length ? Math.min(...nodes.map((n) => Number(n.gas))) : null,
      quietMin: quietMs === null ? null : minutes(quietMs),
      sent: sent ? sent.count : null,
      empty,
      emptyShare
    }
  }
}

// how many of these explorer transactions are settlements sent in [from, to)
// (seconds); done is true once the list reached a transaction before `from`
export function countSettlements (items, from, to) {
  let count = 0
  let done = false
  for (const t of items) {
    const at = Date.parse(t.timestamp) / 1000
    if (at < from) { done = true; continue }
    if (at >= to) continue
    const selector = (t.raw_input || '').slice(0, 10) || t.method
    if (SETTLE_SELECTORS.includes(selector)) count++
  }
  return { count, done }
}
