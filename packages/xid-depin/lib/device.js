// A device of a DePIN network in JS: for gateways that run Node (a Raspberry
// Pi station, say) and for simulated devices (xid-depin sim). An ESP32 does
// the same with components/boat_device.
//
//   const d = new DepinDevice({ dht, keyPair, home, net, config, payee, cell })
//   await d.start()               // home record, connection, join record
//   await d.reading({ t: 215, h: 640, p: 10132 })
//   d.beacon(slot) -> what to send over the radio; d.heard(beacon, rssi)
//   await d.flushWitness(slot)    // reports what it heard in a slot
//
// It answers oracles' pings itself.

import { EventEmitter } from 'events'
import { connect, publishHome, sign, inboxOf } from 'boat-mqtt-node'
import { topics, signBeacon, hex } from './records.js'

export class DepinDevice extends EventEmitter {
  constructor ({ dht, keyPair, home, net, config, payee, cell, rated = null }) {
    super()
    this.dht = dht
    this.keyPair = keyPair
    this.did = hex(keyPair.publicKey)
    this.home = home
    this.net = net
    this.config = config
    this.payee = payee
    this.cell = cell
    this.rated = rated
    this.boot = BigInt(Math.floor(Date.now() / 1000)) << 32n
    this.n = 0n
    this.heardIn = new Map() // slot -> Map(from -> { beacon, rssi })
    this.stats = { readings: 0, pongs: 0, witness: 0 }
  }

  seq () { return this.boot | this.n++ }

  async start () {
    await publishHome(this.dht, this.keyPair, Buffer.from(this.home, 'hex'))
    this.client = await connect(this.home, { dht: this.dht, keyPair: this.keyPair })
    this.client.on('error', (err) => this.emit('error', err))
    this.client.on('message', (topic, payload) => this._inbox(topic, payload))
    await this.client.subscribeAsync(inboxOf(this.keyPair.publicKey), { qos: 1 })
    await this.join()
    // the join record again after a reconnect (a restarted node may have
    // lost what it retained), and every half hour
    this.client.on('connect', () => this.join().catch(() => {}))
    this._rejoin = setInterval(() => this.join().catch(() => {}), 30 * 60 * 1000)
    this._rejoin.unref?.()
    return this
  }

  async publish (topic, body, opts = { qos: 1 }) {
    return this.client.publishAsync(topic, sign(this.keyPair.secretKey, topic, this.seq(), JSON.stringify(body)), opts)
  }

  async join () {
    const body = { v: 1, net: this.net, cell: this.cell, payee: this.payee }
    if (this.rated) body.rated = this.rated
    return this.publish(topics.join(this.did, this.net), body, { qos: 1, retain: true })
  }

  async reading (fields, ts = Math.floor(Date.now() / 1000)) {
    this.stats.readings++
    return this.publish(topics.reading(this.did, this.config), { ...fields, ts })
  }

  beacon (slot) { return signBeacon(this.keyPair.secretKey, this.net, this.did, slot) }

  heard (beacon, rssi) {
    if (!this.heardIn.has(beacon.slot)) this.heardIn.set(beacon.slot, new Map())
    this.heardIn.get(beacon.slot).set(beacon.from, { ...beacon, rssi })
  }

  async flushWitness (slot) {
    const h = this.heardIn.get(slot)
    this.heardIn.delete(slot)
    if (!h || !h.size) return
    this.stats.witness++
    return this.publish(topics.witness(this.did, this.net), { v: 1, slot, heard: [...h.values()] })
  }

  _inbox (topic, payload) {
    // d/<oracle>/to/<me>/depin-ping { net, nonce }: answered at once, signed
    if (!topic.endsWith('/to/' + this.did + '/depin-ping')) return
    let m
    try { m = JSON.parse(payload.toString()) } catch { return }
    if (!m || m.net !== this.net || typeof m.nonce !== 'string' || m.nonce.length > 64) return
    this.stats.pongs++
    this.publish(topics.pong(this.did, this.net), { v: 1, nonce: m.nonce }, { qos: 0 }).catch(() => {})
  }

  async close () {
    clearInterval(this._rejoin)
    this.client?.end(true)
  }
}

// The radio between simulated devices: each slot every device beacons, and
// devices within reach hear it, at the signal free space gives (2.4 GHz,
// 20 dBm, with antenna gains) less some fading. Real devices use ESP-NOW or
// BLE advertisements instead.
export class SimRadio {
  constructor ({ txDbm = 20, sensitivity = -95, fadeDb = 8 } = {}) {
    this.txDbm = txDbm
    this.sensitivity = sensitivity
    this.fadeDb = fadeDb
    this.devices = [] // { device, lat, lon, lie?: { rssi } }
  }

  add (device, lat, lon, opts = {}) { this.devices.push({ device, lat, lon, ...opts }) }

  static km (a, b) {
    const rad = Math.PI / 180
    const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
  }

  rssiAt (km) {
    const m = Math.max(1, km * 1000)
    return Math.round(this.txDbm + 6 - (20 * Math.log10(m) + 40.2) - Math.random() * this.fadeDb)
  }

  // one slot: every device beacons, the others hear what reaches them
  async slot (slot) {
    for (const a of this.devices) {
      const b = a.device.beacon(slot)
      for (const w of this.devices) {
        if (w === a) continue
        const km = Math.max(0.01, SimRadio.km(a, w))
        const rssi = w.lie?.rssi ?? this.rssiAt(km)
        if (rssi >= this.sensitivity || w.lie) w.device.heard(b, rssi)
      }
    }
    await Promise.all(this.devices.map((x) => x.device.flushWitness(slot).catch(() => {})))
  }
}
