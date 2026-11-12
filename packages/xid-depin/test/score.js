// Scoring, without a chain or a network: node test/score.js
//
// Eight devices and three oracles (us, eu, tw) in one epoch of a weather
// network:
//   A, B   Taipei, a block apart, beaconing and witnessing each other
//   C      Taipei, in A's area (shares it: one station per area)
//   D      says Berlin, but the Taiwan oracle reaches it in 4 ms: ruled out
//   E      Tokyo, half its readings out of range
//   F      a reading only one oracle holds (no majority): not counted
//   G      a witness of A claiming 40 km away with a strong signal: not counted
//   H      never answered a ping
//   I      Brussels, 3 ms from the Belgian oracle; the Taiwan oracle lies that
//          it reached it in 1 ms: the two cannot both be true, I stays located
// and the same sheets scored twice give the same root.

import HyperDHT from 'hyperdht'
import { sign } from 'boat-mqtt-node'
import { scoreEpoch, claimOf } from '../lib/score.js'
import { topics, signBeacon, hex } from '../lib/records.js'
import { loadTemplate } from '../lib/config.js'
import { cellAt } from '../lib/geo.js'
import { verifyProof } from 'boat-registry/lib/merkle.js'

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }

const config = loadTemplate('weather')
config.epoch = { length: 3600, slots: 12 }
const net = hex(HyperDHT.keyPair().publicKey)
const start = 1_800_000_000
const epoch = 7
const emission = 1000n * 10n ** 18n
const oracles = [
  { operator: '0x' + '1'.repeat(40), loc: { lat: 41.26, lon: -95.86 } }, // us
  { operator: '0x' + '2'.repeat(40), loc: { lat: 50.45, lon: 3.82 } }, // eu
  { operator: '0x' + '3'.repeat(40), loc: { lat: 24.07, lon: 120.54 } } // tw
]
const place = {
  A: [25.0330, 121.5654], B: [25.0335, 121.5700], C: [25.0360, 121.5640], D: [52.52, 13.405],
  E: [35.6762, 139.6503], F: [22.6273, 120.3014], G: [25.40, 121.50], H: [24.15, 120.67], I: [50.85, 4.35]
}
const rtt = { // ms from us, eu, tw
  A: [140, 250, 6], B: [141, 251, 6], C: [139, 249, 7], D: [150, 260, 4], E: [130, 240, 40], F: [142, 252, 8], G: [140, 250, 9], H: [null, null, null], I: [100, 3, 1]
}
const devs = {}
for (const n of Object.keys(place)) {
  const kp = HyperDHT.keyPair()
  devs[n] = { kp, did: hex(kp.publicKey), seq: 1n << 32n, msgs: [] }
}
const payee = (n) => '0x' + (n.charCodeAt(0)).toString(16).padStart(40, '0')
const pub = (n, topic, body) => {
  const d = devs[n]
  d.msgs.push([topic, sign(d.kp.secretKey, topic, d.seq++, JSON.stringify(body)).toString('base64')])
}
for (const [n, [lat, lon]] of Object.entries(place)) {
  pub(n, topics.join(devs[n].did, net), { v: 1, net, cell: cellAt(lat, lon, config.location.resolution), payee: payee(n) })
  for (let s = 0; s < 12; s++) {
    const bad = n === 'E' && s % 2 === 1
    pub(n, topics.reading(devs[n].did, config), { t: bad ? 9999 : 215, h: 650, p: 10132, ts: start + s * 300 + 10 })
  }
}
const slot0 = epoch * 12
// A and B hear each other every slot; G claims to hear A loudly from 40 km
for (let s = 0; s < 12; s++) {
  pub('A', topics.witness(devs.A.did, net), { v: 1, slot: slot0 + s, heard: [{ ...signBeacon(devs.B.kp.secretKey, net, devs.B.did, slot0 + s), rssi: -70 }] })
  pub('B', topics.witness(devs.B.did, net), { v: 1, slot: slot0 + s, heard: [{ ...signBeacon(devs.A.kp.secretKey, net, devs.A.did, slot0 + s), rssi: -72 }] })
  pub('G', topics.witness(devs.G.did, net), { v: 1, slot: slot0 + s, heard: [{ ...signBeacon(devs.A.kp.secretKey, net, devs.A.did, slot0 + s), rssi: -40 }] })
}
// F: one more reading in a slot of its own that only the us oracle holds
const fExtra = devs.F.msgs.length
pub('F', topics.reading(devs.F.did, config), { t: 215, h: 650, p: 10132, ts: start + 3599 })
const fShort = (n) => n === 'F'
for (const s of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) devs.F.msgs = devs.F.msgs.filter((_, i) => i !== 2 + s || true)
// F has no readings in slots 0..10 at all, only slot 11's extra one: drop its regular readings
devs.F.msgs = devs.F.msgs.filter(([t, b], i) => i === 0 || i === fExtra)

const sheets = oracles.map((o, i) => ({
  operator: o.operator,
  loc: o.loc,
  devices: Object.fromEntries(Object.entries(devs).map(([n, d]) => [d.did, {
    msgs: fShort(n) && i !== 0 ? d.msgs.filter((_, k) => k !== 1) : d.msgs,
    rtt: rtt[n][i]
  }]))
}))
const devices = Object.values(devs).map((d) => d.did)
const tree = scoreEpoch({ config, net, epoch, start, emission, devices, sheets })
const row = (n) => tree.rows.find((r) => r.did === devs[n].did)
const amt = (n) => BigInt(row(n).amount)

check('A located, full uptime, covered', row('A').location === 'ok' && row('A').uptime === 10000 && row('A').coverage === 10000, JSON.stringify({ u: row('A').uptime, c: row('A').coverage }))
check('B covered by A', row('B').coverage === 10000)
check('C shares the area with A', row('C').share === 5000 && row('A').share === 5000, `A ${row('A').share} C ${row('C').share}`)
check('D ruled out: too far for the round trips', /too far/.test(row('D').location) && amt('D') === 0n, row('D').location)
check('E: half its readings out of range', row('E').quality === 5000 && row('E').uptime === 10000)
check('F: a reading one oracle holds does not count', row('F').uptime === 0 && amt('F') === 0n, `uptime ${row('F').uptime}`)
check('G: a witness too loud for its distance does not cover A', row('A').witnessed === 12 && row('G').witnessed === 0, `G witnessed ${row('G').witnessed}`)
check('I: one lying round trip is left out', row('I').location === 'ok' && amt('I') > 0n, row('I').location)
check('H: no oracle reached it', row('H').location === 'no oracle reached it' && amt('H') === 0n)
check('total within the emission', tree.total <= emission && tree.total > emission - 10n, String(tree.total))
const again = scoreEpoch({ config, net, epoch, start, emission, devices: devices.slice().reverse(), sheets: sheets.slice().reverse() })
check('the same sheets give the same root', again.root === tree.root && again.total === tree.total)
const c = claimOf(tree, devs.A.did)
check('a claim proves against the root', verifyProof(tree.leaves.find((l) => l.did === devs.A.did).leaf, c.proof, tree.root))
check('B (alone in its area) earns more than A', amt('B') > amt('A'), `A ${amt('A') / 10n ** 15n} B ${amt('B') / 10n ** 15n} (1e-3)`)

// energy: a meter's steps, capped by its rated power
const ec = loadTemplate('energy')
ec.epoch = { length: 3600, slots: 12 }
const m = HyperDHT.keyPair()
const did = hex(m.publicKey)
let seq = 5n << 32n
const msgs = []
const put = (topic, body) => msgs.push([topic, sign(m.secretKey, topic, seq++, JSON.stringify(body)).toString('base64')])
put(topics.join(did, net), { v: 1, net, cell: cellAt(25.03, 121.56, 7), payee: payee('M'), rated: 3000 })
let mwh = 1000000
for (let s = 0; s < 12; s++) {
  mwh += s === 5 ? 5000000 : 200000 // 2.4 kW for 5 min; slot 5 claims 60 kW
  put(topics.reading(did, ec), { mwh, w: 2400, ts: start + s * 300 })
}
const et = scoreEpoch({ config: ec, net, epoch, start, emission, devices: [did], sheets: oracles.map((o, i) => ({ ...o, devices: { [did]: { msgs, rtt: [140, 250, 6][i] } } })) })
// 10 steps of 200 Wh, and one capped at 3 kW for 5 min (250 Wh)
check('energy: steps over the rated power are capped', et.rows[0].energy === String(10n * 200000n + 250000n), et.rows[0].energy)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
