// Receipts: each hop signs what it got.
//
// A node (and a bridge, and a storage node) records the sequence numbers of
// the signed messages (signed.js) it handles for each device, and signs a
// receipt for them: one text line, easy to check in C
// (components/hdht_mqtt, hdht_mqtt_receipt_open):
//
//   boat-receipt/1|<signer>|<device>|<count>|<bytes>|<ranges>|<t>|<signature>
//
// - signer, device: public keys in hex; t: unix ms
// - count, bytes: signed messages and their payload bytes, since the signer
//   started
// - ranges: the sequence numbers, "a-b;c-d" in decimal, oldest first; at most
//   MAX_RANGES, older ones dropped (count and bytes still cover them)
// - signature: Ed25519 by the signer over everything before the last '|'
//
// A device compares a receipt with what it sent: a range it never sent is the
// signer's signed word against itself. Whoever reads the receipts of every
// hop finds where a message was lost.

import sodium from 'sodium-universal'
import { hex } from './topics.js'

export const MAX_RANGES = 32
const PREFIX = 'boat-receipt/1'

// the sequence number of a signed message ('S' 1 | seq u64 BE | ...), or null
export function seqOf (payload) {
  if (!payload || payload.length < 74 || payload[0] !== 0x53 || payload[1] !== 1) return null
  return Buffer.from(payload).readBigUInt64BE(2)
}

export class Receipts {
  constructor (keyPair) {
    this.keyPair = keyPair
    this.devices = new Map() // device hex -> { count, bytes, ranges: [[a, b]], dirty }
  }

  // records a signed message; false when it is not one, or its seq was seen
  add (device, payload) {
    const seq = seqOf(payload)
    if (seq === null) return false
    const key = hex(device)
    let d = this.devices.get(key)
    if (!d) {
      d = { count: 0, bytes: 0, ranges: [], dirty: false }
      this.devices.set(key, d)
    }
    if (!insert(d.ranges, seq)) return false
    if (d.ranges.length > MAX_RANGES) d.ranges.splice(0, d.ranges.length - MAX_RANGES)
    d.count++
    d.bytes += payload.length
    d.dirty = true
    return true
  }

  // devices with messages not in a receipt yet
  dirty () {
    return [...this.devices].filter(([, d]) => d.dirty).map(([k]) => k)
  }

  receipt (device) {
    const key = hex(device)
    const d = this.devices.get(key)
    if (!d) return null
    d.dirty = false
    const body = [PREFIX, hex(this.keyPair.publicKey), key, d.count, d.bytes, d.ranges.map(([a, b]) => `${a}-${b}`).join(';'), Date.now()].join('|')
    const sig = Buffer.alloc(64)
    sodium.crypto_sign_detached(sig, Buffer.from(body), this.keyPair.secretKey)
    return body + '|' + sig.toString('hex')
  }
}

// keeps ranges sorted and merged; false if seq is already in one
function insert (ranges, seq) {
  let i = ranges.length
  while (i > 0 && ranges[i - 1][0] > seq) i--
  const prev = ranges[i - 1]
  if (prev && seq <= prev[1]) return false
  const next = ranges[i]
  const joinsPrev = prev && prev[1] + 1n === seq
  const joinsNext = next && next[0] - 1n === seq
  if (joinsPrev && joinsNext) {
    prev[1] = next[1]
    ranges.splice(i, 1)
  } else if (joinsPrev) prev[1] = seq
  else if (joinsNext) next[0] = seq
  else ranges.splice(i, 0, [seq, seq])
  return true
}

// { signer, device, count, bytes, ranges: [[a, b]], t } if the line is a
// receipt signed by its signer (and by `signer`, when given), else null
export function openReceipt (line, signer) {
  line = String(line)
  const cut = line.lastIndexOf('|')
  if (cut < 0) return null
  const body = line.slice(0, cut)
  const f = body.split('|')
  if (f.length !== 7 || f[0] !== PREFIX || !/^[0-9a-f]{64}$/.test(f[1]) || !/^[0-9a-f]{64}$/.test(f[2])) return null
  if (signer && hex(signer) !== f[1]) return null
  const sig = Buffer.from(line.slice(cut + 1), 'hex')
  if (sig.length !== 64 || !sodium.crypto_sign_verify_detached(sig, Buffer.from(body), Buffer.from(f[1], 'hex'))) return null
  const ranges = f[5] ? f[5].split(';').map((r) => r.split('-').map(BigInt)) : []
  return { signer: f[1], device: f[2], count: Number(f[3]), bytes: Number(f[4]), ranges, t: Number(f[6]) }
}

// compares a receipt with the sequence numbers a device sent:
// { covered, missing: [seq], claimedNotSent: [[a, b]] }
export function compareReceipt (r, sent) {
  const sentSet = new Set([...sent].map(String))
  const inReceipt = (s) => r.ranges.some(([a, b]) => s >= a && s <= b)
  const lo = r.ranges.length ? r.ranges[0][0] : 0n
  const missing = [...sent].filter((s) => s >= lo && !inReceipt(BigInt(s)))
  const claimedNotSent = []
  for (const [a, b] of r.ranges) {
    for (let s = a; s <= b && claimedNotSent.length < 16; s++) if (!sentSet.has(String(s))) claimedNotSent.push(s)
  }
  return { covered: sent.length - missing.length, missing, claimedNotSent }
}
