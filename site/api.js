// /api/* of iot.xid.network: the public testnet's live state and its faucet.
//
//   GET  /api/network          the latest snapshot the hub pushed (nodes, jobs,
//                              devices, settlements)
//   POST /api/faucet  {address}  queue test tokens for an address: 1,000 TSUSD
//                              (stake and job budgets) and a little Arc USDC for gas
//   POST /api/sponsor {device}   queue verify and store jobs for a device key, paid
//                              by the testnet, so a new device's readings get worked on
//   GET  /api/request/<id>     how a queued request went
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
// all; one sponsorship per device, five per client, 200 in all.

const DAY = 24 * 3600 * 1000
const LIMITS = {
  faucet: { target: 1, ip: 3, all: 100 },
  sponsor: { target: 1, ip: 5, all: 200 }
}

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...extra }
})

async function clientOf (request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  const data = new TextEncoder().encode((env.IP_SALT || 'xid') + ip)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return [...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function queue (request, env, kind) {
  let body
  try { body = await request.json() } catch { return json({ error: 'send JSON' }, 400) }
  const target = String((kind === 'faucet' ? body.address : body.device) || '').trim().toLowerCase()
  const ok = kind === 'faucet' ? /^0x[0-9a-f]{40}$/.test(target) : /^[0-9a-f]{64}$/.test(target)
  if (!ok) return json({ error: kind === 'faucet' ? 'address: 0x and 40 hex digits' : 'device: its 64-hex-digit key' }, 400)
  const since = Date.now() - DAY
  const ip = await clientOf(request, env)
  const prev = await env.DB.prepare("SELECT id, state FROM requests WHERE kind = ? AND target = ? AND at > ? AND state != 'failed' ORDER BY id DESC LIMIT 1").bind(kind, target, since).first()
  if (prev) return json({ id: prev.id, state: prev.state, note: 'already asked for in the last 24 hours' })
  const [byIp, all] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM requests WHERE kind = ? AND ip = ? AND at > ?').bind(kind, ip, since).first('n'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM requests WHERE kind = ? AND at > ?').bind(kind, since).first('n')
  ])
  if (byIp >= LIMITS[kind].ip) return json({ error: 'too many requests from you today' }, 429)
  if (all >= LIMITS[kind].all) return json({ error: 'the testnet gave out all it gives in a day: try tomorrow' }, 429)
  const row = await env.DB.prepare('INSERT INTO requests (kind, target, ip, at) VALUES (?, ?, ?, ?) RETURNING id').bind(kind, target, ip, Date.now()).first()
  return json({ id: row.id, state: 'queued' }, 202)
}

async function hub (request, env, what) {
  const auth = request.headers.get('Authorization') || ''
  if (!env.HUB_TOKEN || auth !== 'Bearer ' + env.HUB_TOKEN) return json({ error: 'not the hub' }, 401)
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
    if (method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' } })
    if (pathname === '/api/network' && method === 'GET') {
      const row = await env.DB.prepare('SELECT v, at FROM kv WHERE k = ?').bind('network').first()
      if (!row) return json({ error: 'no snapshot yet' }, 503)
      return new Response(row.v, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=15' } })
    }
    if (pathname === '/api/faucet' && method === 'POST') return await queue(request, env, 'faucet')
    if (pathname === '/api/sponsor' && method === 'POST') return await queue(request, env, 'sponsor')
    const req = /^\/api\/request\/(\d+)$/.exec(pathname)
    if (req && method === 'GET') {
      const row = await env.DB.prepare('SELECT id, kind, target, state, result, at, done_at FROM requests WHERE id = ?').bind(Number(req[1])).first()
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
