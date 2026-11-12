// An oracle: a compute node's work on a DePIN network's job (a boat-node
// plugin, lib/plugin.js). Its units are the network's epochs.
//
// - Following. It follows every device enrolled on the network (DepinNetwork
//   devices[]) to its home node and keeps what each signs for the network:
//   readings, its join record, witness reports.
// - Pinging. Once a minute it pings each device (d/<work>/to/<did>/depin-ping)
//   and times the device's signed pong: the epoch's shortest round trip goes
//   in its sheet, with where the oracle is (plugin option lat, lon).
// - Sheets. collectMs after an epoch ends it publishes, at the network's home
//   node, one sheet per device (the device's messages for the epoch and the
//   round trip) and an index of their hashes, signed by its operator key.
// - Scoring. It waits for the indexes and sheets of the job's other assigned
//   oracles (at most waitMs), scores the epoch from all of them (score.js:
//   a message counts when most sheets hold it) and signs
//   DepinNetwork.epochStatement as the unit's result, once (kept on disk).
//   It publishes the rewards tree for claims.
// - Settling and publishing. The node's Settler settles the unit on the
//   registry once a quorum signed the same result; then one oracle publishes
//   the epoch on the network (DepinNetwork.publishEpoch), the others later if
//   it has not.

import { EventEmitter } from 'events'
import crypto from 'crypto'
import { Contract, getBytes, keccak256, toUtf8Bytes, verifyMessage, getAddress } from 'ethers'
import { workStatement, settledKey, ROLES } from 'boat-registry'
import { checkConfig, configHash, canonical } from './config.js'
import { topics, kindOf, openMessage } from './records.js'
import { scoreEpoch, epochStatement } from './score.js'
import NETWORK from '../artifacts/DepinNetwork.json' with { type: 'json' }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => Date.now()

export const indexHash = (body) => keccak256(toUtf8Bytes('xid-depin-index/1' + canonical(body)))

// an index's signer, when it is genuine: { ...body, sheets } or null
export function openIndex (payload) {
  let x
  try { x = JSON.parse(payload.toString()) } catch { return null }
  if (!x || x.v !== 1 || typeof x.sig !== 'string' || !x.sheets || typeof x.sheets !== 'object') return null
  const { sig, ...body } = x
  try {
    if (getAddress(verifyMessage(getBytes(indexHash(body)), sig)) !== getAddress(body.operator)) return null
  } catch { return null }
  return x
}

export class Oracle extends EventEmitter {
  constructor ({ node, job, lat = null, lon = null, collectMs = 30000, waitMs = 90000, pingMs = 60000, tickMs = 5000, deviceMs = 60000, publishGapMs = 20000 }) {
    super()
    this.node = node
    this.job = job
    this.net = job.device // the network's key (hex)
    this.loc = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
    this.collectMs = collectMs
    this.waitMs = waitMs
    this.pingMs = pingMs
    this.tickMs = tickMs
    this.deviceMs = deviceMs
    this.publishGapMs = publishGapMs
    // what the node's status reports for a worker
    this.mode = null
    this.counts = { taken: 0, refused: 0, dropped: 0, short: 0 }
    this.signedCount = 0
    this.devices = new Map() // did -> { enrolledAt, removedAt, following }
    this.held = new Map() // epoch -> Map(did -> Map(messageKey -> [topic, base64]))
    this.joins = new Map() // did -> { seq, msg: [topic, base64] }
    this.rtt = new Map() // epoch -> Map(did -> ms)
    this.pings = new Map() // nonce -> { did, at }
    this.received = new Map() // epoch -> { indexes: Map(operator -> index), sheets: Map(work:did -> payload) }
    this.done = new Set() // epochs this oracle has sheeted
    this.signedEpochs = new Map() // epoch -> { result, root, total, count, at }
    this.timers = []
    this.closed = false
  }

  log (line) { this.emit('log', line) }

  async start () {
    this.config = checkConfig(this.job.params.config)
    this.work = this.node.ctx.nodeKey
    this.network = new Contract(this.job.params.network, NETWORK.abi, this.node.operator)
    const [key, hash, start, length] = await Promise.all([this.network.networkKey(), this.network.configHash(), this.network.start(), this.network.epochLength()])
    if (key.slice(2) !== this.net) throw new Error('the network contract names another key')
    if (hash !== configHash(this.config)) throw new Error('the job\'s config is not the network\'s')
    if (Number(length) !== this.config.epoch.length) throw new Error('the network\'s epoch length is not the config\'s')
    this.start0 = Number(start)
    this.length = Number(length)
    this.memory = this.node.memoryOf(`${this.job.id}-depin`)
    this.firstEpoch = this.epochAt(now()) // the first it saw from its start
    await this.node.follower.watchDevice(this.net, `d/+/depin/${this.net}/#`)
    await this.refreshDevices()
    this.every(this.deviceMs, () => this.refreshDevices())
    this.every(this.pingMs, () => this.pingAll())
    this.every(this.tickMs, () => this.tick())
    this.log(`oracle for network ${this.job.params.network} (${this.config.name}), ${this.devices.size} devices, epoch ${this.firstEpoch} now`)
    return this
  }

  every (ms, fn) {
    const t = setInterval(() => { if (!this.closed) fn().catch((err) => this.emit('error', err)) }, ms)
    t.unref?.()
    this.timers.push(t)
  }

  epochAt (ms) { return Math.max(0, Math.floor((ms / 1000 - this.start0) / this.length)) }
  epochStart (e) { return this.start0 + e * this.length }

  inEpoch (d, e) {
    return d.enrolledAt !== 0 && d.enrolledAt < this.epochStart(e + 1) && (d.removedAt === 0 || d.removedAt > this.epochStart(e))
  }

  // devices[] only grows: new ones are read once; who was removed, now and then
  async refreshDevices () {
    this.refreshes = (this.refreshes || 0) + 1
    const count = Number(await this.network.deviceCount())
    for (let i = this.devices.size; i < count; i++) {
      const did = (await this.network.devices(i)).slice(2)
      this.devices.set(did, { enrolledAt: Number(await this.network.enrolledAt('0x' + did)), removedAt: Number(await this.network.removedAt('0x' + did)), following: false })
    }
    for (const [did, d] of this.devices) {
      if (d.removedAt === 0 && this.refreshes % 10 === 0) d.removedAt = Number(await this.network.removedAt('0x' + did))
      if (!d.following && d.removedAt === 0) {
        try {
          await this.node.follower.follow(did)
          d.following = true
        } catch {} // no home node yet: next time
      }
    }
  }

  async pingAll () {
    for (const [did, d] of this.devices) {
      if (!d.following || d.removedAt) continue
      const nonce = crypto.randomBytes(16).toString('hex')
      this.pings.set(nonce, { did, at: performance.now() })
      await this.node.follower.publishTo(did, topics.ping(this.work, did), JSON.stringify({ net: this.net, nonce }), { qos: 0 }).catch(() => {})
    }
    const old = performance.now() - 30000
    for (const [n, p] of this.pings) if (p.at < old) this.pings.delete(n)
  }

  // ---- what devices publish ---------------------------------------------------

  take (device, topic, payload) {
    if (!this.devices.has(device)) return
    const kind = kindOf(topic, device, this.net, this.config)
    if (!kind) return
    const m = openMessage(device, topic, payload)
    if (!m) { this.counts.refused++; return }
    this.counts.taken++
    const msg = [topic, Buffer.from(payload).toString('base64')]
    if (kind === 'pong') {
      const p = this.pings.get(m.body.nonce)
      if (!p || p.did !== device) return
      this.pings.delete(m.body.nonce)
      const ms = Math.max(1, Math.round(performance.now() - p.at))
      const e = this.epochAt(now())
      if (!this.rtt.has(e)) this.rtt.set(e, new Map())
      const r = this.rtt.get(e)
      if (!r.has(device) || ms < r.get(device)) r.set(device, ms)
      return
    }
    if (kind === 'join') {
      const j = this.joins.get(device)
      if (!j || m.seq > j.seq) this.joins.set(device, { seq: m.seq, msg })
      return
    }
    let e
    if (kind === 'reading') {
      if (!Number.isInteger(m.body.ts)) return
      e = Math.floor((m.body.ts - this.start0) / this.length)
    } else {
      if (!Number.isSafeInteger(m.body.slot)) return
      e = Math.floor(m.body.slot / this.config.epoch.slots)
    }
    const current = this.epochAt(now())
    if (e < 0 || e < current - 1 || e > current || this.done.has(e)) { this.counts.dropped++; return } // late, or from the future
    if (!this.held.has(e)) this.held.set(e, new Map())
    const h = this.held.get(e)
    if (!h.has(device)) h.set(device, new Map())
    h.get(device).set(keccak256(Buffer.from(payload)), msg)
  }

  // ---- what other oracles publish ---------------------------------------------

  peer (from, topic, payload) {
    const p = topic.split('/')
    // d/<work>/depin/<net>/<epoch>/index | sheet/<did>
    if (p[2] !== 'depin' || p[3] !== this.net) return
    const e = Number(p[4])
    if (!Number.isSafeInteger(e) || e < 0) return
    if (!this.received.has(e)) this.received.set(e, { indexes: new Map(), sheets: new Map() })
    const r = this.received.get(e)
    if (p[5] === 'index') {
      const x = openIndex(payload)
      if (x && x.net === this.net && x.epoch === e && x.work === from) r.indexes.set(getAddress(x.operator), x)
    } else if (p[5] === 'sheet' && /^[0-9a-f]{64}$/.test(p[6] || '')) {
      r.sheets.set(from + ':' + p[6], Buffer.from(payload))
    }
  }

  // ---- epochs -------------------------------------------------------------------

  async tick () {
    const t = now() / 1000
    const e = this.epochAt(now()) - 1
    if (e >= 0 && !this.done.has(e) && t >= this.epochStart(e + 1) + this.collectMs / 1000) {
      this.done.add(e)
      await this.publishSheets(e)
      this.scoreWhenReady(e).catch((err) => this.emit('error', err))
    }
    await this.publishSettled()
    // forget what is long past
    for (const m of [this.held, this.rtt, this.received]) for (const k of m.keys()) if (k < e - 2) m.delete(k)
  }

  async publishSheets (e) {
    const s0 = this.epochStart(e)
    const sheets = {}
    for (const [did, d] of this.devices) {
      if (!this.inEpoch(d, e)) continue
      const msgs = [...(this.held.get(e)?.get(did)?.values() || [])]
      const j = this.joins.get(did)
      if (j) msgs.push(j.msg)
      msgs.sort((a, b) => (a[1] < b[1] ? -1 : 1))
      const sheet = { msgs, rtt: this.rtt.get(e)?.get(did) ?? null }
      const payload = Buffer.from(canonical(sheet))
      sheets[did] = keccak256(payload)
      await this.node.follower.publishTo(this.net, topics.sheet(this.work, this.net, e, did), payload, { qos: 1, retain: true })
      this.peer(this.work, topics.sheet(this.work, this.net, e, did), payload)
    }
    const body = { v: 1, net: this.net, epoch: e, work: this.work, operator: this.node.operator.address, loc: this.loc, start: s0, sheets }
    const index = { ...body, sig: await this.node.operator.signMessage(getBytes(indexHash(body))) }
    const payload = Buffer.from(JSON.stringify(index))
    await this.node.follower.publishTo(this.net, topics.index(this.work, this.net, e), payload, { qos: 1, retain: true })
    this.peer(this.work, topics.index(this.work, this.net, e), payload)
    this.log(`epoch ${e}: sheets on ${Object.keys(sheets).length} devices published`)
  }

  // the indexes of the job's assigned oracles whose sheets have all come
  complete (e, assigned) {
    const r = this.received.get(e)
    if (!r) return []
    const out = []
    for (const [op, x] of r.indexes) {
      if (!assigned.has(op)) continue
      const sheets = {}
      let ok = true
      for (const [did, h] of Object.entries(x.sheets)) {
        const p = r.sheets.get(x.work + ':' + did)
        if (!p || keccak256(p) !== h) { ok = false; break }
        try { sheets[did] = JSON.parse(p.toString()) } catch { ok = false; break }
      }
      if (ok) out.push({ operator: op, loc: x.loc && Number.isFinite(x.loc.lat) && Number.isFinite(x.loc.lon) ? x.loc : null, devices: sheets })
    }
    return out.sort((a, b) => (a.operator < b.operator ? -1 : 1))
  }

  async scoreWhenReady (e) {
    const plan = await this.node.plan()
    const assigned = new Set((plan.get(this.job.id) || []).map((a) => getAddress(a)))
    const deadline = now() + this.waitMs
    let sheets = this.complete(e, assigned)
    while (sheets.length < assigned.size && now() < deadline && !this.closed) {
      await sleep(1000)
      sheets = this.complete(e, assigned)
    }
    if (this.closed) return
    if (!sheets.some((s) => s.operator === getAddress(this.node.operator.address))) return this.log(`epoch ${e}: its own sheets are not in, not signing`)
    const devices = [...this.devices].filter(([, d]) => this.inEpoch(d, e)).map(([did]) => did)
    const emission = await this.network.emission(e)
    const tree = scoreEpoch({ config: this.config, net: this.net, epoch: e, start: this.epochStart(e), emission, devices, sheets: sheets.map((s) => ({ ...s, devices: s.devices })) })
    this.emit('scored', { epoch: e, tree, oracles: sheets.map((s) => s.operator) })
    if (!tree.root) return this.log(`epoch ${e}: nothing to reward (${devices.length} devices, ${sheets.length} sheets)`)
    const result = epochStatement({ network: this.job.params.network, chainId: this.node.ctx.chainId, epoch: e, root: tree.root, total: tree.total, count: tree.count })
    // a unit is signed once, ever: another result for it would be slashable
    const before = this.memory.get(String(e))
    if (before) {
      if (before.result !== result) this.log(`epoch ${e} was signed before with another result: not signing again`)
      return
    }
    const w = {
      v: 1,
      job: this.job.id,
      unit: String(e),
      role: ROLES.COMPUTE,
      device: this.net,
      result,
      operator: this.node.operator.address,
      node: this.work,
      detail: { network: this.job.params.network, epoch: e, root: tree.root, total: String(tree.total), count: tree.count, oracles: sheets.map((s) => s.operator) }
    }
    w.signature = await this.node.operator.signMessage(getBytes(workStatement(this.node.ctx, w.job, e, result)))
    this.memory.set(String(e), { result, signature: w.signature })
    this.signedEpochs.set(e, { result, root: tree.root, total: tree.total, count: tree.count, at: now() })
    this.signedCount++
    const rewards = {
      v: 1,
      net: this.net,
      network: this.job.params.network,
      config: this.config.name,
      epoch: e,
      start: this.epochStart(e),
      root: tree.root,
      total: String(tree.total),
      count: tree.count,
      emission: String(tree.emission),
      oracles: sheets.map((s) => s.operator),
      leaves: tree.leaves.map((l) => ({ did: l.did, payee: l.payee, amount: String(l.amount) })),
      rows: tree.rows
    }
    await this.node.follower.publishTo(this.net, topics.rewards(this.work, this.net, e), JSON.stringify(rewards), { qos: 1, retain: true })
    await this.node.follower.publishTo(this.net, `d/${this.work}/work/${this.net}/${w.job}/${w.unit}`, JSON.stringify({ ...w, at: now() }), { qos: 1, retain: true })
    this.log(`epoch ${e}: signed, ${tree.count} devices rewarded, ${tree.total} of ${tree.emission}, from ${sheets.length} oracles' sheets`)
    this.emit('signed', w)
  }

  // epochs settled on the registry and not yet on the network: the first
  // signer by address publishes, the others publishGapMs apart after it
  async publishSettled () {
    for (const [e, s] of this.signedEpochs) {
      if (s.published) continue
      const p = await this.network.epochs(e)
      if (p.publishedAt !== 0n) {
        s.published = true
        this.emit('published', { epoch: e, root: p.root, by: 'other' })
        continue
      }
      const settled = await this.node.registry.settled(settledKey(this.job.id, e))
      if (settled !== s.result) {
        if (now() - s.at > 3600000) { s.published = true; this.log(`epoch ${e}: never settled with this result`) }
        continue
      }
      if (!s.settledAt) s.settledAt = now()
      const plan = await this.node.plan()
      const order = (plan.get(this.job.id) || []).map((a) => getAddress(a)).sort()
      const rank = Math.max(0, order.indexOf(getAddress(this.node.operator.address)))
      if (now() - s.settledAt < rank * this.publishGapMs) continue
      try {
        const r = await this.node.tx(async () => (await this.network.publishEpoch(this.job.id, e, s.root, s.total, s.count)).wait())
        s.published = true
        this.log(`epoch ${e}: published on the network, tx ${r.hash.slice(0, 12)}…`)
        this.emit('published', { epoch: e, root: s.root, by: 'us', tx: r.hash })
      } catch (err) {
        if (/published/.test(err.shortMessage || err.message)) s.published = true
        else this.log(`epoch ${e}: publish: ${err.shortMessage || err.message}`)
      }
    }
  }

  published () {}
  stored () {}

  async close () {
    this.closed = true
    for (const t of this.timers) clearInterval(t)
  }
}
