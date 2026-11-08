#!/usr/bin/env node
// Runs a node: an MQTT broker on HyperDHT, announced under a network name.
//
// usage: boat-mqtt-node [--key node.json] [--network boat-mqtt | --no-announce]
//                       [--tcp 1883 [--tcp-host 127.0.0.1] --users users.json]
//                       [--bridge <node key>[=filter,filter]]... [--bootstrap host:port,...]
//                       [--stats 60]
//
// --key: { "seed": hex }, created when missing; keeps the node's public key.
// --users: { "name": "password" } for TCP apps (they may not publish under d/).
// --bridge: pull these filters (default d/+/telemetry) from another node.

import fs from 'fs'
import { createNode } from '../index.js'
import { loadKeyPair } from '../lib/keyfile.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const all = (name) => args.flatMap((a, i) => a === '--' + name ? [args[i + 1]] : [])
const log = (line) => console.log(new Date().toISOString().slice(11, 19) + ' ' + line)
const short = (k) => k ? k.slice(0, 12) + '…' : ''

let closing = false
const keyPair = loadKeyPair(opt('key', 'node.json'))
const network = args.includes('--no-announce') ? null : opt('network', undefined)
const tcpPort = opt('tcp')
const users = opt('users') ? JSON.parse(fs.readFileSync(opt('users'), 'utf8')) : {}
const bootstrap = opt('bootstrap') ? opt('bootstrap').split(',') : undefined

const node = await createNode({
  keyPair,
  network,
  bootstrap,
  users,
  tcp: tcpPort ? { port: Number(tcpPort), host: opt('tcp-host', '127.0.0.1') } : null
})
log(`node ${node.publicKey.toString('hex')}`)
log(node.network === null ? 'not announced' : `announced on network "${node.network}"`)
if (node.tcp) log(`TCP on ${node.tcp.host || '127.0.0.1'}:${node.tcp.port} for ${Object.keys(users).length} user(s)`)

node.on('client', (c) => log(`+ ${c.key ? 'key ' + short(c.key) : 'tcp ' + c.user}${c.bridge ? ' (bridge)' : ''} id ${short(c.id)}`))
node.on('clientDisconnect', (c) => log(`- ${c.key ? 'key ' + short(c.key) : 'tcp ' + c.user}`))
node.on('refused', (r) => log(`REFUSED ${r.client.key ? 'key ' + short(r.client.key) : 'tcp ' + r.client.user} -> ${r.topic}: ${r.reason}`))

// a bridge to a node that is not up yet is retried every 10 s
async function startBridge (key, filters) {
  try {
    await node.bridge(key, filters ? filters.split(',') : undefined)
    log(`bridging from ${short(key)}: ${filters || 'd/+/telemetry'}`)
  } catch (err) {
    log(`bridge from ${short(key)} failed (${err.message}), retrying in 10 s`)
    setTimeout(() => { if (!closing) startBridge(key, filters) }, 10000)
  }
}
for (const b of all('bridge')) {
  const [key, filters] = b.split('=')
  startBridge(key, filters)
}

const stats = () => {
  const u = node.usage()
  for (const [id, v] of Object.entries(u)) log(`usage ${short(id)} ${v.messages} msgs ${v.bytes} B`)
}
if (opt('stats')) setInterval(stats, Number(opt('stats')) * 1000).unref()

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return
    closing = true
    stats()
    await node.close()
    process.exit(0)
  })
}
