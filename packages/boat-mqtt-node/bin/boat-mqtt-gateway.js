#!/usr/bin/env node
// A HyperDHT entrance for an MQTT broker you already run (NanoMQ, say): see
// lib/gateway.js. Devices reach it by network name or key, the broker sees
// each device log in with its key as username.
//
// usage: boat-mqtt-gateway --broker 127.0.0.1:1884 [--key gateway.json]
//                          [--network boat-mqtt | --no-announce] [--auth-port 18083]
//                          [--users users.json] [--nanomq-conf <dir>] [--bootstrap host:port,...]
//
// --users: { "name": "password" } for the operator's own apps, which log in
//   to the broker directly (they may not publish under d/).
// --nanomq-conf: write nanomq.conf and nanomq_acl.conf into <dir> for a
//   NanoMQ on --broker's port; start it with `nanomq start --conf <dir>/nanomq.conf`.

import fs from 'fs'
import path from 'path'
import { createGateway, nanomqConfig } from '../lib/gateway.js'
import { loadKeyPair } from '../lib/keyfile.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const log = (line) => console.log(new Date().toISOString().slice(11, 19) + ' ' + line)

const [host, port] = opt('broker', '127.0.0.1:1883').split(':')
const g = await createGateway({
  keyPair: loadKeyPair(opt('key', 'gateway.json')),
  network: args.includes('--no-announce') ? null : opt('network', undefined),
  bootstrap: opt('bootstrap') ? opt('bootstrap').split(',') : undefined,
  broker: { host, port: Number(port) },
  users: opt('users') ? JSON.parse(fs.readFileSync(opt('users'), 'utf8')) : {},
  authPort: Number(opt('auth-port', 0))
})
log(`gateway ${g.publicKey.toString('hex')}`)
log(g.network === null ? 'not announced' : `announced on network "${g.network}"`)
log(`broker ${host}:${port}, login checks at ${g.authUrl}`)

const dir = opt('nanomq-conf')
if (dir) {
  fs.mkdirSync(dir, { recursive: true })
  const aclPath = path.resolve(dir, 'nanomq_acl.conf')
  const { conf, acl } = nanomqConfig({ port: Number(port), authUrl: g.authUrl, aclPath })
  fs.writeFileSync(path.join(dir, 'nanomq.conf'), conf)
  fs.writeFileSync(aclPath, acl)
  log(`wrote ${path.join(dir, 'nanomq.conf')}: nanomq start --conf ${path.resolve(dir, 'nanomq.conf')}`)
}

g.on('connection', (c) => log(`+ key ${c.key.slice(0, 12)}… id ${c.clientId.slice(0, 12)}… MQTT ${c.protocolVersion === 5 ? '5' : '3.1.1'}`))
g.on('refused', (r) => log(`REFUSED key ${r.key.slice(0, 12)}… id ${String(r.clientId).slice(0, 16)}: ${r.reason}`))
g.on('broker-error', (e) => log(`cannot reach the broker for ${e.key.slice(0, 12)}…: ${e.error.message}`))
g.on('auth', (a) => { if (!a.ok) log(`broker login refused for ${a.user}`) })

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`${g.stats.connections} connections, ${g.stats.forwarded} forwarded, ${g.stats.refused} refused`)
    await g.close()
    process.exit(0)
  })
}
