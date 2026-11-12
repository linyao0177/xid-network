// What devices and oracles publish, and where.
//
// A device signs everything with its own key (boat-mqtt-node's signed
// messages), on its own topics:
//
//   d/<did>/<readings.topic>          a reading: the config's fields, integers,
//                                     and ts (unix seconds)
//   d/<did>/depin/<net>/join          retained: { v, net, cell, payee, rated? }
//                                     where it is (an H3 cell at the network's
//                                     resolution) and who is paid for it
//   d/<did>/depin/<net>/witness       { v, slot, heard: [{ from, slot, sig, rssi }] }
//                                     beacons it heard over the radio
//   d/<did>/depin/<net>/pong          { v, nonce }: the answer to an oracle's ping
//
// A beacon is what a device sends over the radio (ESP-NOW, BLE) once a slot:
// its key, the slot, and its Ed25519 signature over
// "xid-depin-beacon/1" 0 | net | did | slot (8 bytes, big-endian).
//
// An oracle (a compute node working on the network's job) publishes, at the
// network's home node:
//
//   d/<work>/to/<did>/depin-ping                        { net, nonce }
//   d/<work>/depin/<net>/<epoch>/sheet/<did>           what it holds on a device
//   d/<work>/depin/<net>/<epoch>/index                 its sheets' hashes, signed
//   d/<work>/depin/<net>/<epoch>/rewards               the epoch's rewards tree

import sodium from 'sodium-universal'
import { keccak256, toUtf8Bytes } from 'ethers'
import { open } from 'boat-mqtt-node'

export const hex = (b) => Buffer.from(b).toString('hex')

export const topics = {
  reading: (did, config) => `d/${did}/${config.readings.topic}`,
  join: (did, net) => `d/${did}/depin/${net}/join`,
  witness: (did, net) => `d/${did}/depin/${net}/witness`,
  pong: (did, net) => `d/${did}/depin/${net}/pong`,
  ping: (work, did) => `d/${work}/to/${did}/depin-ping`,
  sheet: (work, net, epoch, did) => `d/${work}/depin/${net}/${epoch}/sheet/${did}`,
  index: (work, net, epoch) => `d/${work}/depin/${net}/${epoch}/index`,
  rewards: (work, net, epoch) => `d/${work}/depin/${net}/${epoch}/rewards`
}

// which of a device's messages an oracle keeps for the network: its readings,
// its join record and its witness reports
export function kindOf (topic, did, net, config) {
  if (topic === topics.reading(did, config)) return 'reading'
  if (topic === topics.join(did, net)) return 'join'
  if (topic === topics.witness(did, net)) return 'witness'
  if (topic === topics.pong(did, net)) return 'pong'
  return null
}

// a device's signed message: { seq, body } or null
export function openMessage (did, topic, payload) {
  const m = open(Buffer.from(did, 'hex'), topic, payload)
  if (!m) return null
  let body
  try { body = JSON.parse(m.payload.toString()) } catch { return null }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  return { seq: m.seq, body }
}

const BEACON = Buffer.from('xid-depin-beacon/1\0')

function beaconBytes (net, did, slot) {
  const s = Buffer.alloc(8)
  s.writeBigUInt64BE(BigInt(slot))
  return Buffer.concat([BEACON, Buffer.from(net, 'hex'), Buffer.from(did, 'hex'), s])
}

export function signBeacon (secretKey, net, did, slot) {
  const sig = Buffer.alloc(64)
  sodium.crypto_sign_detached(sig, beaconBytes(net, did, slot), secretKey)
  return { from: did, slot: Number(slot), sig: hex(sig) }
}

export function beaconOk (net, b) {
  if (!b || !/^[0-9a-f]{64}$/.test(b.from) || !Number.isSafeInteger(b.slot) || b.slot < 0 || !/^[0-9a-f]{128}$/.test(b.sig || '')) return false
  return sodium.crypto_sign_verify_detached(Buffer.from(b.sig, 'hex'), beaconBytes(net, b.from, b.slot), Buffer.from(b.from, 'hex'))
}

// one key for a message, whoever relays it: the same bytes are the same message
export const messageKey = (topic, payload) => keccak256(Buffer.concat([toUtf8Bytes(topic), Buffer.from([0]), Buffer.from(payload)]))
