// /api/* of iot.xid.network: the public testnet's live state and its faucet.
//
//   GET  /api/network          the latest snapshot the hub pushed (nodes, jobs,
//                              devices, settlements)
//   POST /api/faucet  {address}  queue test tokens for an address: 1,000 TSUSD
//                              (stake and job budgets) and a little Arc USDC for gas
//   POST /api/sponsor {device}   queue verify and store jobs for a device key, paid
//                              by the testnet, so a new device's readings get worked on
//   POST /api/depin/enroll {device}  queue a device's enrollment in the testnet's
//                              DePIN network (the weather demo), fee paid by the testnet
//   GET  /api/request/<id>     how a queued request went (<id>: the 32 hex digits
//                              the POST answered with; they cannot be guessed)
//
// The three POSTs take JSON (Content-Type: application/json) and, from a
// browser, only from this site's own pages.
//
// The hub (a VM running packages/boat-registry/examples/testnet-hub.js) holds
// the faucet wallet; this Worker holds no key. It pulls the queue and pushes
// snapshots with a bearer token (secret HUB_TOKEN):
//
//   POST /api/hub/snapshot     the snapshot behind /api/network
//   POST /api/hub/take         queued requests, marked as being worked on
//   POST /api/hub/done {id, ok, result}
//
// Limits per 24 hours: one faucet drip per address, three per client, 100 in
// all; one sponsorship per device, five per client, 200 in all; one
// enrollment per device, 20 per client, 300 in all. A client is an IPv4 address
// or an IPv6 /64, kept only as a salted hash (secret IP_SALT).

const DAY = 24 * 3600 * 1000
const LIMITS = {
  faucet: { target: 1, ip: 3, all: 100 },
  sponsor: { target: 1, ip: 5, all: 200 },
  enroll: { target: 1, ip: 20, all: 300 }
}

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...extra }
})

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

// What the limit per client counts: an IPv4 address, or the /64 of an IPv6
// address (one subscriber holds a whole /64, so its addresses count as one).
export function netOf (ip) {
  ip = ip.toLowerCase()
  if (!ip.includes(':')) return ip
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mapped) return mapped[1]
  const [head, tail] = ip.split('::')
  const groups = head ? head.split(':') : []
  // "::" stands for the groups left out; only the first four matter here
  if (tail !== undefined) while (groups.length < 4) groups.push('0')
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64'
}

// null without a secret to salt with: a hash salted with a constant anyone
// can read here gives the address back to whoever tries all of them. HUB_TOKEN
// stands in for IP_SALT, since the testnet cannot run without it.
async function clientOf (request, env) {
  const salt = env.IP_SALT || env.HUB_TOKEN
  if (!salt) return null
  const hash = await sha256(salt + netOf(request.headers.get('CF-Connecting-IP') || 'unknown'))
  return hex(hash.slice(0, 12))
}

// the same work whatever was sent: both are hashed, and the hashes compared in full
async function same (a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

async function queue (request, env, kind) {
  // Another site's page must not be able to ask from its visitors' browsers
  // (each with its own address, so the limit per client would not hold): a
  // browser names the page's origin, and sends JSON across origins only after
  // asking. Tools (curl, boat-sim, xid-depin) send no Origin.
  const origin = request.headers.get('Origin')
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'ask from iot.xid.network' }, 403)
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'send JSON (Content-Type: application/json)' }, 415)
  let body
  try { body = await request.json() } catch { return json({ error: 'send JSON' }, 400) }
  const target = String((kind === 'faucet' ? body?.address : body?.device) || '').trim().toLowerCase()
  const ok = kind === 'faucet' ? /^0x[0-9a-f]{40}$/.test(target) : /^[0-9a-f]{64}$/.test(target)
  if (!ok) return json({ error: kind === 'faucet' ? 'address: 0x and 40 hex digits' : 'device: its 64-hex-digit key' }, 400)
  const ip = await clientOf(request, env)
  if (!ip) return json({ error: 'the testnet is not set up here' }, 503)
  const now = Date.now()
  const since = now - DAY
  const limit = LIMITS[kind]
  // One statement checks the three limits and adds the request, so requests
  // sent at the same moment cannot all pass a check made before any was added.
  const id = hex(crypto.getRandomValues(new Uint8Array(16)))
  const added = await env.DB.prepare(`INSERT INTO requests (rid, kind, target, ip, at) SELECT ?1, ?2, ?3, ?4, ?5
    WHERE NOT EXISTS (SELECT 1 FROM requests WHERE kind = ?2 AND target = ?3 AND at > ?6 AND state != 'failed')
      AND (SELECT COUNT(*) FROM requests WHERE kind = ?2 AND ip = ?4 AND at > ?6) < ?7
      AND (SELECT COUNT(*) FROM requests WHERE kind = ?2 AND at > ?6) < ?8`).bind(id, kind, target, ip, now, since, limit.ip, limit.all).run()
  if (added.meta.changes) return json({ id, state: 'queued' }, 202)
  // not added: say which limit it was
  const prev = await env.DB.prepare("SELECT rid, state FROM requests WHERE kind = ? AND target = ? AND at > ? AND state != 'failed' ORDER BY id DESC LIMIT 1").bind(kind, target, since).first()
  if (prev) return json({ id: prev.rid, state: prev.state, note: 'already asked for in the last 24 hours' })
  const byIp = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests WHERE kind = ? AND ip = ? AND at > ?').bind(kind, ip, since).first('n')
  if (byIp >= limit.ip) return json({ error: 'too many requests from you today' }, 429)
  return json({ error: 'the testnet gave out all it gives in a day: try tomorrow' }, 429)
}

async function hub (request, env, what) {
  const auth = request.headers.get('Authorization') || ''
  if (!env.HUB_TOKEN || !(await same(auth, 'Bearer ' + env.HUB_TOKEN))) return json({ error: 'not the hub' }, 401)
  if (what === 'snapshot') {
    const text = await request.text()
    JSON.parse(text) // only JSON is kept
    await env.DB.prepare('INSERT INTO kv (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at').bind('network', text, Date.now()).run()
    return json({ ok: true })
  }
  if (what === 'take') {
    // work given out more than 10 minutes ago and not finished goes out again
    await env.DB.prepare("UPDATE requests SET state = 'queued' WHERE state = 'working' AND done_at < ?").bind(Date.now() - 600000).run()
    const { results } = await env.DB.prepare("UPDATE requests SET state = 'working', done_at = ? WHERE id IN (SELECT id FROM requests WHERE state = 'queued' ORDER BY id LIMIT 20) RETURNING id, kind, target").bind(Date.now()).all()
    return json({ requests: results })
  }
  if (what === 'done') {
    const { id, ok, result } = await request.json()
    await env.DB.prepare('UPDATE requests SET state = ?, result = ?, done_at = ? WHERE id = ?').bind(ok ? 'done' : 'failed', JSON.stringify(result ?? null), Date.now(), id).run()
    return json({ ok: true })
  }
  return json({ error: 'no such call' }, 404)
}

export async function api (request, env) {
  const { pathname } = new URL(request.url)
  const method = request.method
  try {
    if (method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' } })
    if (pathname === '/api/network' && method === 'GET') {
      const row = await env.DB.prepare('SELECT v, at FROM kv WHERE k = ?').bind('network').first()
      if (!row) return json({ error: 'no snapshot yet' }, 503)
      return new Response(row.v, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=15' } })
    }
    if (pathname === '/api/faucet' && method === 'POST') return await queue(request, env, 'faucet')
    if (pathname === '/api/sponsor' && method === 'POST') return await queue(request, env, 'sponsor')
    if (pathname === '/api/depin/enroll' && method === 'POST') return await queue(request, env, 'enroll')
    const req = /^\/api\/request\/([0-9a-f]{32})$/.exec(pathname)
    if (req && method === 'GET') {
      const row = await env.DB.prepare('SELECT rid AS id, kind, target, state, result, at, done_at FROM requests WHERE rid = ?').bind(req[1]).first()
      if (!row) return json({ error: 'no such request' }, 404)
      return json({ ...row, result: row.result ? JSON.parse(row.result) : null })
    }
    const h = /^\/api\/hub\/(snapshot|take|done)$/.exec(pathname)
    if (h && method === 'POST') return await hub(request, env, h[1])
    return json({ error: 'no such call' }, 404)
  } catch (err) {
    return json({ error: 'server error' }, 500)
  }
}
