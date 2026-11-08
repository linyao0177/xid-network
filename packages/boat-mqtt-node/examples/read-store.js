// Reads a device's history from a store (or a mirror) and checks it: every
// entry against the store's signed tree and the device's own signature, the
// sequence numbers for gaps, and a spot check of random blocks.
//
// usage: node examples/read-store.js <store key> <device key> [--samples 8] [--mirror <dir>]
//
// --mirror: replicate the store into <dir> first and read from the mirror.

import HyperDHT from 'hyperdht'
import { openLog, spotCheck, createMirror } from '../index.js'

const [store, device] = process.argv.slice(2)
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const log = (line) => console.log('READ|' + line)
const dht = new HyperDHT()
let server = Buffer.from(store, 'hex')
let mirror = null
if (opt('mirror')) {
  const t = Date.now()
  mirror = await createMirror({ dht, storage: opt('mirror'), store })
  await mirror.sync()
  server = mirror.publicKey
  log(`mirrored the store in ${Date.now() - t} ms; reading from the mirror ${server.toString('hex').slice(0, 12)}…`)
}

let t = Date.now()
const l = await openLog(dht, server, device)
log(`signed head checked: ${l.length} entries (core ${l.core.slice(0, 12)}…) in ${Date.now() - t} ms`)
t = Date.now()
const entries = []
for (let i = 0; i < l.length; i++) entries.push(await l.block(i))
l.close()
const bad = entries.filter((e) => !e.ok)
const seqs = entries.filter((e) => e.ok).map((e) => e.seq)
const boots = new Map()
for (const s of seqs) {
  const b = s >> 32n
  const n = s & 0xffffffffn
  const r = boots.get(b) || { first: n, last: n, count: 0 }
  r.first = n < r.first ? n : r.first
  r.last = n > r.last ? n : r.last
  r.count++
  boots.set(b, r)
}
log(`read ${entries.length} entries in ${Date.now() - t} ms: ${entries.length - bad.length} checked out, ${bad.length} did not${bad.length ? ' (' + bad[0].reason + ')' : ''}`)
for (const [b, r] of boots) log(`boot ${b}: seq ${r.first}..${r.last}, ${r.count} stored, ${Number(r.last - r.first + 1n) - r.count} missing`)
if (entries.length) log(`last: ${entries.at(-1).payload}`)
const spot = await spotCheck(dht, server, device, { samples: Number(opt('samples', 8)) })
log(`spot check of ${spot.checked} random blocks: ${spot.ok ? 'passed' : 'FAILED ' + JSON.stringify(spot.failed)} in ${spot.ms} ms`)
if (mirror) await mirror.close()
await dht.destroy()
