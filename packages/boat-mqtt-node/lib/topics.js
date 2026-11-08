import sodium from 'sodium-universal'

// Nodes of a network announce under BLAKE2b-256(network name); devices and
// apps look the name up. The C side (components/hdht_mqtt) hashes the MQTT
// hostname the same way.
export const NETWORK = 'boat-mqtt'

export function topicOf (network = NETWORK) {
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, Buffer.from(network))
  return out
}

// Namespaces. The node guarantees that a topic under d/<key>/ was published
// by the holder of <key> (checked by the Noise handshake, not a password).
export const own = (key) => `d/${hex(key)}/`
// what <from> sends to <to>; <to> subscribes to inboxOf(<to>)
export const to = (from, toKey, rest = 'cmd') => `d/${hex(from)}/to/${hex(toKey)}/${rest}`
export const inboxOf = (key) => `d/+/to/${hex(key)}/#`
// the sender of a topic under d/<key>/, or null
export function senderOf (topic) {
  const m = /^d\/([0-9a-f]{64})\//.exec(topic)
  return m ? m[1] : null
}

export function hex (key) {
  return typeof key === 'string' ? key.toLowerCase() : key.toString('hex')
}
