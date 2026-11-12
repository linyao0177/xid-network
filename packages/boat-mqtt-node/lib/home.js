// A device's home node, named in its record: the HyperDHT mutable record
// under its key (the DID record of BoAT devices), a JSON object with
//
//   "mqtt": "<home node public key, hex>"
//
// next to whatever else the record holds. The record is signed by the
// device's key, so the home it names is the device's own word.

import { hex } from './topics.js'

export async function homeOf (dht, key) {
  const res = await dht.mutableGet(Buffer.from(hex(key), 'hex'), { latest: true })
  if (!res) return null
  try {
    const r = JSON.parse(res.value.toString())
    if (typeof r.mqtt === 'string' && /^[0-9a-f]{64}$/i.test(r.mqtt)) return Buffer.from(r.mqtt, 'hex')
  } catch {}
  return null
}

// Puts a record naming nodeKey as home; merge into it what the record should
// also hold (a BoAT DID record's did/eth/eth_sig, say).
//
// DHT nodes drop a record after about 48 hours. With refreshMs the record is
// put again that often, with a newer seq, until stop() (in what is returned)
// is called: call it before the key gets another record, here or elsewhere,
// or the old one comes back over it.
export async function publishHome (dht, keyPair, nodeKey, { seq = Math.floor(Date.now() / 1000), record = {}, refreshMs = 0 } = {}) {
  const value = { v: 1, did: 'did:mw:' + hex(keyPair.publicKey), ...record, mqtt: hex(nodeKey) }
  const buf = Buffer.from(JSON.stringify(value))
  await dht.mutablePut(keyPair, buf, { seq })
  const out = { record: value, seq }
  if (refreshMs) {
    const timer = setInterval(() => {
      out.seq = Math.max(out.seq + 1, Math.floor(Date.now() / 1000))
      dht.mutablePut(keyPair, buf, { seq: out.seq }).catch(() => {})
    }, refreshMs)
    timer.unref()
    out.stop = () => clearInterval(timer)
  }
  return out
}
