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
export async function publishHome (dht, keyPair, nodeKey, { seq = Math.floor(Date.now() / 1000), record = {} } = {}) {
  const value = { v: 1, did: 'did:mw:' + hex(keyPair.publicKey), ...record, mqtt: hex(nodeKey) }
  await dht.mutablePut(keyPair, Buffer.from(JSON.stringify(value)), { seq })
  return { record: value, seq }
}
