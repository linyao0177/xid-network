#!/usr/bin/env node
// A storage node: keeps the signed messages of devices in Hypercores (lib/store.js).
//
// usage: boat-mqtt-store --device <key> [--device <key>]... [--key store.json]
//                        [--storage ./store] [--bootstrap host:port,...]
//
// It follows each device to the home node named in its record. Readers and
// checkers use examples/read-store.js.

import { createStore } from '../lib/store.js'
import { loadKeyPair } from '../lib/keyfile.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const all = (name) => args.flatMap((a, i) => a === '--' + name ? [args[i + 1]] : [])
const log = (line) => console.log(new Date().toISOString().slice(11, 19) + ' ' + line)

const s = await createStore({
  keyPair: loadKeyPair(opt('key', 'store.json')),
  storage: opt('storage', './store'),
  bootstrap: opt('bootstrap') ? opt('bootstrap').split(',') : undefined,
  devices: all('device')
})
log(`store ${s.publicKey.toString('hex')}`)
s.on('follow', (f) => log(`following ${f.device.slice(0, 12)}… at its home node ${f.home.slice(0, 12)}…`))
s.on('rejected', (r) => log(`REJECTED from ${r.device.slice(0, 12)}… on ${r.topic.slice(67)}: ${r.reason}`))
s.on('stored', (e) => { if (e.index % 10 === 0) log(`stored ${e.device.slice(0, 12)}… #${e.index} seq ${e.seq >> 32n}:${e.seq & 0xffffffffn}`) })
s.on('request', (r) => log(`asked for block ${r.index} of ${r.device.slice(0, 12)}…`))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log(`stored ${s.stats.stored}, rejected ${s.stats.rejected}, replays ${s.stats.replayed}`)
    await s.close()
    process.exit(0)
  })
}
