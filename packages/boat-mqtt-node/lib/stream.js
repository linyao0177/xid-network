// Aedes and mqtt.js expect a Node.js Duplex; HyperDHT streams are streamx
// streams, which they do not read reliably (mqtt.js times out waiting for
// CONNACK). This wraps one in the other and keeps the peer's public key.

import { Duplex } from 'stream'

export function toNode (s) {
  const d = new Duplex({
    read () {},
    write (chunk, enc, cb) {
      if (chunk.length === 0) return cb()
      s.write(chunk) ? cb() : s.once('drain', () => cb())
    },
    final (cb) {
      s.end()
      cb()
    },
    destroy (err, cb) {
      s.destroy()
      cb(err)
    }
  })
  s.on('data', (c) => d.push(c))
  s.on('end', () => d.push(null))
  s.on('error', (e) => d.destroy(e))
  s.on('close', () => d.destroy())
  d.remotePublicKey = s.remotePublicKey || null
  s.on('open', () => { d.remotePublicKey = s.remotePublicKey })
  return d
}
