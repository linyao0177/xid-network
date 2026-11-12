// Signed messages (components/hdht_mqtt, hdht_mqtt_sign): the publisher's own
// Ed25519 signature over the topic, a sequence number and the payload, so a
// subscriber can check a message whatever node or bridge it came through.
//
//   'S' 0x01 | seq: 8 bytes big-endian | signature: 64 bytes | payload
//
// signed over "hdht-mqtt-sig/1" 0x00 | topic | 0x00 | seq | payload.

import sodium from 'sodium-universal'
import { senderOf } from './topics.js'

const CONTEXT = Buffer.from('hdht-mqtt-sig/1\0')
export const OVERHEAD = 2 + 8 + 64

function signable (topic, seqBytes, payload) {
  return Buffer.concat([CONTEXT, Buffer.from(topic), Buffer.from([0]), seqBytes, payload])
}

export function sign (secretKey, topic, seq, payload) {
  payload = Buffer.from(payload)
  const seqBytes = Buffer.alloc(8)
  seqBytes.writeBigUInt64BE(BigInt(seq))
  const sig = Buffer.alloc(64)
  sodium.crypto_sign_detached(sig, signable(topic, seqBytes, payload), secretKey)
  return Buffer.concat([Buffer.from([0x53, 1]), seqBytes, sig, payload])
}

// { seq (BigInt), payload } when msg is signed by publicKey for this topic, else null
export function open (publicKey, topic, msg) {
  msg = Buffer.from(msg)
  if (msg.length < OVERHEAD || msg[0] !== 0x53 || msg[1] !== 1) return null
  const seqBytes = msg.subarray(2, 10)
  const payload = msg.subarray(OVERHEAD)
  if (!sodium.crypto_sign_verify_detached(msg.subarray(10, OVERHEAD), signable(topic, seqBytes, payload), publicKey)) return null
  return { seq: seqBytes.readBigUInt64BE(), payload }
}

// Checks messages under d/<key>/ against the key in the topic and refuses a
// sequence number at or below the last one seen from that key on that topic.
//
// What it remembers is bounded, since keys and topics are free to make:
// - maxTopics per key. Past that the topic idle longest is forgotten, and on
//   topics not remembered the key's messages must be newer than what was
//   forgotten (its floor): a key with ever new topics gives up nothing as
//   long as its sequence numbers grow across them, and costs no one else.
// - maxSenders keys. Past that the key idle longest is forgotten whole.
export class SignedInbox {
  constructor ({ maxTopics = 1024, maxSenders = 100000 } = {}) {
    this.maxTopics = maxTopics
    this.maxSenders = maxSenders
    this.senders = new Map() // key hex -> { last: Map(topic -> seq), floor }, the busiest last
  }

  // { ok, from, seq, payload, reason }
  check (topic, msg) {
    const from = senderOf(topic)
    if (!from) return { ok: false, reason: 'not under d/<key>/' }
    const m = open(Buffer.from(from, 'hex'), topic, msg)
    if (!m) return { ok: false, from, reason: 'bad signature' }
    let s = this.senders.get(from)
    const last = s && s.last.get(topic)
    if (s && (last !== undefined ? m.seq <= last : m.seq <= s.floor)) return { ok: false, from, seq: m.seq, reason: 'replayed' }
    if (s) this.senders.delete(from) // (in time order: the busiest last)
    else {
      s = { last: new Map(), floor: -1n }
      if (this.senders.size >= this.maxSenders) this.senders.delete(this.senders.keys().next().value)
    }
    this.senders.set(from, s)
    s.last.delete(topic)
    s.last.set(topic, m.seq)
    if (s.last.size > this.maxTopics) {
      const [old, seq] = s.last.entries().next().value
      s.last.delete(old)
      if (seq > s.floor) s.floor = seq
    }
    return { ok: true, from, seq: m.seq, payload: m.payload }
  }
}
