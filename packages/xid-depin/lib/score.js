// Scoring an epoch: from what the oracles hold on each device to the
// rewards tree. Every oracle runs this on the same sheets and gets the same
// bytes, so they sign the same root. It is a pure function: anyone holding
// the sheets (they are published) can run it again (xid-depin audit).
//
// 1. Evidence. A device's message counts when a majority of the sheets hold
//    it (more than half), and only with the device's own valid signature.
//    One oracle can neither add readings nor take them away.
// 2. Location (proof of location). The device's latest join record names an
//    H3 cell and a payee. Each oracle's round trip to the device bounds how
//    far apart they are (geo.js latencyAllows): a cell further from
//    `minViolations` oracles than their round trips allow is ruled out, and
//    so is a device no oracle reached (when requirePing). Two round trips
//    that cannot both be true are both left out, so an oracle that lies
//    cannot rule out a device that an honest one near it reaches. (One that
//    lies about a device no other oracle is near can: its round trips are in
//    its signed index, on record.) A device with no valid location earns
//    nothing.
// 3. Readings. The epoch is cut into slots; a slot is up when the device
//    signed a reading in it, and good when every field is within range (and,
//    with crossCheck, close to the median of the sensors around it).
// 4. Coverage (proof of coverage). Devices beacon over the radio once a slot
//    and report the beacons they hear. A witness counts when both have a
//    valid location within rangeCells of each other, the signal is not
//    stronger than that distance allows, and they are paid to different
//    payees. A slot is covered when a device's beacon has minWitnesses.
// 5. Score. uptime mode: weights over uptime, quality and coverage (basis
//    points). energy mode: the energy the meter counted, each step no more
//    than maxPowerW (or the rated power the device names, if lower) allows.
//    With coverage.hex, devices sharing an area (an H3 cell at that
//    resolution) beyond `target` share `target` devices' worth.
// 6. Rewards. The epoch's emission is split by score (rounded down); the
//    leaves keccak(epoch, did, payee, amount), sorted by device, make the
//    tree whose root the oracles sign.

import { AbiCoder, keccak256, getAddress } from 'ethers'
import { merkleRoot, merkleProof } from 'boat-registry/lib/merkle.js'
import { kindOf, openMessage, beaconOk, messageKey } from './records.js'
import { cellOk, parentOf, gridDistance, latencyAllows, maxRssi, distanceKm } from './geo.js'

const abi = AbiCoder.defaultAbiCoder()
const BPS = 10000n

export const leafOf = (epoch, did, payee, amount) =>
  keccak256(abi.encode(['uint64', 'bytes32', 'address', 'uint256'], [BigInt(epoch), '0x' + did, payee, BigInt(amount)]))

// what the oracles sign for an epoch (DepinNetwork.epochStatement)
export const epochStatement = ({ network, chainId, epoch, root, total, count }) =>
  keccak256(abi.encode(['string', 'address', 'uint256', 'uint64', 'bytes32', 'uint256', 'uint32'],
    ['xid-depin/epoch/1', network, BigInt(chainId), BigInt(epoch), root, BigInt(total), count]))

// the round trips that could all be true: each puts the device within a disk
// around its oracle, and a disk that misses another one cannot be right
// together with it. Both are left out, so one oracle that lies about a round
// trip cannot rule a device out against an honest one nearer to it.
function consistent (rtts, { kmPerMs = 100, slackKm = 50 }) {
  const radius = (r) => Math.ceil(r.rtt * kmPerMs) + slackKm
  return rtts.filter((a) => rtts.every((b) => b === a || distanceKm(a.loc.lat, a.loc.lon, b.loc.lat, b.loc.lon) <= radius(a) + radius(b)))
}

const bySeq = (a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0)
const lowerMedian = (xs) => xs.slice().sort((a, b) => a - b)[(xs.length - 1) >> 1]

// sheets: [{ operator, loc: { lat, lon }, devices: { did: { msgs: [[topic, base64]], rtt } } }]
// devices: the dids enrolled in the epoch (DepinNetwork.inEpoch)
export function scoreEpoch ({ config, net, epoch, start, emission, devices, sheets }) {
  const len = config.epoch.length
  const slots = config.epoch.slots
  const slotLen = len / slots
  const from = Number(start)
  const to = from + len
  const firstSlot = Number(epoch) * slots
  const need = Math.floor(sheets.length / 2) + 1
  const L = config.location
  const requirePing = L.requirePing !== false

  // 1. evidence
  const dev = new Map()
  for (const did of [...new Set(devices)].sort()) {
    const counts = new Map()
    for (const s of sheets) {
      const seen = new Set()
      for (const [topic, b64] of (s.devices[did]?.msgs || [])) {
        const payload = Buffer.from(b64, 'base64')
        const k = messageKey(topic, payload)
        if (seen.has(k)) continue
        seen.add(k)
        const c = counts.get(k)
        if (c) c.n++
        else counts.set(k, { topic, payload, n: 1 })
      }
    }
    const d = { did, readings: [], joins: [], witness: [], rtts: [] }
    for (const { topic, payload, n } of counts.values()) {
      if (n < need) continue
      const kind = kindOf(topic, did, net, config)
      if (!kind || kind === 'pong') continue
      const m = openMessage(did, topic, payload)
      if (!m) continue
      if (kind === 'reading') d.readings.push(m)
      else if (kind === 'join') d.joins.push(m)
      else d.witness.push(m)
    }
    for (const s of sheets) {
      const rtt = s.devices[did]?.rtt
      if (Number.isFinite(rtt) && rtt > 0 && s.loc) d.rtts.push({ operator: s.operator, loc: s.loc, rtt })
    }
    dev.set(did, d)
  }

  // 2. location
  for (const d of dev.values()) {
    d.joins.sort(bySeq)
    const j = d.joins.length ? d.joins[d.joins.length - 1].body : null
    d.payee = null
    d.cell = null
    d.rated = null
    d.location = 'no join record'
    if (!j) continue
    try { d.payee = getAddress(j.payee) } catch { d.location = 'bad payee'; continue }
    if (j.net !== net) { d.location = 'join record for another network'; continue }
    if (!cellOk(j.cell, L.resolution)) { d.location = 'bad cell'; continue }
    d.cell = j.cell
    if (Number.isInteger(j.rated) && j.rated > 0) d.rated = j.rated
    // a round trip that no other oracle's could also be true of (their
    // disks do not meet) is a lie or a fluke: it is left out
    const kept = consistent(d.rtts, L)
    const violations = kept.filter((r) => !latencyAllows(r.loc, d.cell, r.rtt, L)).length
    if (requirePing && d.rtts.length === 0) d.location = 'no oracle reached it'
    else if (violations >= L.minViolations) d.location = `too far for ${violations} round trip${violations > 1 ? 's' : ''}`
    else d.location = 'ok'
  }
  const located = (d) => d && d.location === 'ok'

  // 3. readings
  const fields = Object.entries(config.readings.fields)
  for (const d of dev.values()) {
    d.slots = new Map() // slot -> { good, values }
    d.readings.sort(bySeq)
    for (const r of d.readings) {
      const ts = r.body.ts
      if (!Number.isInteger(ts) || ts < from || ts >= to) continue
      if (!fields.every(([k]) => Number.isInteger(r.body[k]))) continue
      const slot = Math.floor((ts - from) / slotLen)
      const good = fields.every(([k, f]) => r.body[k] >= f.min && r.body[k] <= f.max)
      const s = d.slots.get(slot)
      if (!s) d.slots.set(slot, { good, reading: r })
      else if (!s.good && good) d.slots.set(slot, { good, reading: r }) // a good reading in the slot counts
    }
  }
  const x = config.readings.crossCheck
  if (x) {
    // per slot and area: the median of the sensors' values; a reading too far from it is not good
    const groups = new Map()
    for (const d of dev.values()) {
      if (!located(d)) continue
      const area = parentOf(d.cell, Math.min(x.resolution, L.resolution))
      for (const [slot, s] of d.slots) {
        if (!s.good) continue
        const k = area + ':' + slot
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(s.reading.body[x.field])
      }
    }
    for (const d of dev.values()) {
      if (!located(d)) continue
      const area = parentOf(d.cell, Math.min(x.resolution, L.resolution))
      for (const [slot, s] of d.slots) {
        const g = groups.get(area + ':' + slot)
        if (!s.good || !g || g.length < x.min) continue
        if (Math.abs(s.reading.body[x.field] - lowerMedian(g)) > x.tolerance) s.good = false
      }
    }
  }

  // 4. coverage
  const poc = config.coverage?.poc
  const covered = new Map() // did -> Set(slot)
  const witnessed = new Map() // did -> count of valid witness reports given
  if (poc) {
    const heard = new Map() // from:slot -> Set(witness)
    for (const w of dev.values()) {
      if (!located(w)) continue
      for (const m of w.witness) {
        for (const b of Array.isArray(m.body.heard) ? m.body.heard : []) {
          if (!b || b.from === w.did || !Number.isInteger(b.rssi) || b.rssi < poc.rssiMin || b.rssi > 0) continue
          if (b.slot < firstSlot || b.slot >= firstSlot + slots) continue
          const t = dev.get(b.from)
          if (!located(t) || t.payee === w.payee) continue
          const cells = gridDistance(t.cell, w.cell)
          if (cells > poc.rangeCells || b.rssi > maxRssi(cells, L.resolution, poc.txDbm)) continue
          if (!beaconOk(net, b)) continue
          const k = b.from + ':' + b.slot
          if (!heard.has(k)) heard.set(k, new Set())
          heard.get(k).add(w.did)
        }
      }
    }
    for (const [k, ws] of heard) {
      const [from, slot] = k.split(':')
      const valid = [...ws].sort().slice(0, poc.maxWitnesses)
      for (const w of valid) witnessed.set(w, (witnessed.get(w) || 0) + 1)
      if (valid.length < poc.minWitnesses) continue
      if (!covered.has(from)) covered.set(from, new Set())
      covered.get(from).add(Number(slot) - firstSlot)
    }
  }

  // 5. score
  const S = config.score
  for (const d of dev.values()) {
    d.uptime = Math.floor((d.slots.size * 10000) / slots)
    d.quality = Math.floor(([...d.slots.values()].filter((s) => s.good).length * 10000) / slots)
    d.coverage = Math.floor(((covered.get(d.did)?.size || 0) * 10000) / slots)
    d.witnessed = witnessed.get(d.did) || 0
    d.raw = 0n
    if (!located(d) || !d.payee) continue
    if (S.mode === 'uptime') {
      d.raw = (BigInt(S.weights.uptime) * BigInt(d.uptime) + BigInt(S.weights.quality) * BigInt(d.quality) + BigInt(S.weights.coverage) * BigInt(d.coverage)) / BPS
    } else {
      const maxW = BigInt(d.rated ? Math.min(d.rated, S.maxPowerW) : S.maxPowerW)
      const rs = d.readings.filter((r) => {
        const ts = r.body.ts
        return Number.isInteger(ts) && ts >= from && ts < to && Number.isInteger(r.body[S.field]) && fields.every(([k, f]) => !Number.isInteger(r.body[k]) || (r.body[k] >= f.min && r.body[k] <= f.max))
      })
      let energy = 0n
      for (let i = 1; i < rs.length; i++) {
        const dt = rs[i].body.ts - rs[i - 1].body.ts
        const de = BigInt(rs[i].body[S.field]) - BigInt(rs[i - 1].body[S.field])
        if (dt <= 0 || de <= 0n) continue // a reset or a clock gone back: nothing for that step
        const cap = (maxW * 1000n * BigInt(dt)) / 3600n // mWh at most
        energy += de < cap ? de : cap
      }
      d.energy = energy
      d.raw = energy
    }
  }
  const hex = config.coverage?.hex
  const areas = new Map()
  if (hex) {
    for (const d of dev.values()) {
      if (d.raw <= 0n) continue
      const a = parentOf(d.cell, hex.resolution)
      areas.set(a, (areas.get(a) || 0) + 1)
    }
  }
  let sum = 0n
  for (const d of dev.values()) {
    d.share = 10000
    d.score = d.raw
    if (hex && d.raw > 0n) {
      const n = areas.get(parentOf(d.cell, hex.resolution))
      if (n > hex.target) {
        d.share = Math.floor((hex.target * 10000) / n)
        d.score = (d.raw * BigInt(hex.target)) / BigInt(n)
      }
    }
    sum += d.score
  }

  // 6. rewards
  const E = BigInt(emission)
  const leaves = []
  const rows = []
  let total = 0n
  for (const d of dev.values()) {
    const amount = sum > 0n ? (E * d.score) / sum : 0n
    if (amount > 0n) {
      leaves.push({ did: d.did, payee: d.payee, amount, leaf: leafOf(epoch, d.did, d.payee, amount) })
      total += amount
    }
    rows.push({
      did: d.did,
      payee: d.payee,
      cell: d.cell,
      location: d.location,
      rtts: d.rtts.map((r) => ({ operator: r.operator, rtt: r.rtt })),
      uptime: d.uptime,
      quality: d.quality,
      coverage: d.coverage,
      witnessed: d.witnessed,
      energy: d.energy !== undefined ? String(d.energy) : undefined,
      share: d.share,
      score: String(d.score),
      amount: String(amount)
    })
  }
  const root = leaves.length ? merkleRoot(leaves.map((l) => l.leaf)) : null
  return { epoch: Number(epoch), root, total, count: leaves.length, emission: E, leaves, rows }
}

// a device's claim from a rewards tree: { epoch, did, payee, amount, proof } or null
export function claimOf (tree, did) {
  const i = tree.leaves.findIndex((l) => l.did === did)
  if (i < 0) return null
  const l = tree.leaves[i]
  return { epoch: tree.epoch, did, payee: l.payee, amount: BigInt(l.amount), proof: merkleProof(tree.leaves.map((x) => x.leaf), i) }
}
