// A storage node anyone can run: the history of devices, in Hypercores.
//
// - It follows devices to their home nodes (home.js) and subscribes to
//   d/<device>/#. It keeps only signed messages (signed.js) whose signature
//   checks out against the key in the topic, and refuses replays. Each device
//   gets a Hypercore of its own, signed by the store, of entries:
//     u16 big-endian topic length | topic | the signed message, as sent
//   A reader checks every entry twice: against the store's signed tree, and
//   against the device's own signature. The store can lose or refuse data,
//   but not change it.
// - A catalog (a Hyperbee) maps each device to its core. The store's DHT
//   record names the catalog and a second key to replicate from:
//     {"v":"1","boat_store":"1","catalog":"<key>","replicate":"<key>"}
//   Mirrors (createMirror) replicate the cores with Hypercore's own protocol,
//   and serve them as the store does.
// - Readers and checkers ask any store or mirror for a core's signed head and
//   for single blocks with their Merkle proofs (packages/boat-ota's wire, which
//   devices check in C too). A spot check asks for random blocks: a store that
//   no longer holds them cannot answer. It needs none of the data beforehand.
//   What a store says about itself (its core, its signer, how long the log is)
//   is the store's word only: a checker passes what it knows already (the
//   least length, sequence numbers that must be there, the core it saw before).
// - Receipts (receipts.js): what it stored, signed, retained over MQTT at
//   d/<store>/receipts/<device>.

import { EventEmitter } from 'events'
import { createRequire } from 'module'
import crypto from 'crypto'
import sodium from 'sodium-universal'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import HyperDHT from 'hyperdht'
import { connect, connectHome } from './client.js'
import { homeOf } from './home.js'
import { open } from './signed.js'
import { Receipts } from './receipts.js'
import { senderOf, hex } from './topics.js'

const require = createRequire(import.meta.url)
const { signedHead, blockProof, wire, verifyHead, verifyBlock } = require('boat-ota')

const REQUEST_MS = 15000 // how long a reader waits for a store to connect, and to answer
const RECORD_MS = 60 * 60 * 1000 // DHT nodes drop a record after about 48 hours: put again long before
const MAX_TOPICS = 4096 // topics per device whose newest seq is kept; older ones fall under the floor

export function encodeEntry (topic, message) {
  const t = Buffer.from(topic)
  const len = Buffer.alloc(2)
  len.writeUInt16BE(t.length)
  return Buffer.concat([len, t, Buffer.from(message)])
}

export function decodeEntry (block) {
  const n = block.readUInt16BE(0)
  return { topic: block.subarray(2, 2 + n).toString(), message: block.subarray(2 + n) }
}

// the key pair the store replicates from, derived from its own
function replicationKeyPair (keyPair) {
  const seed = Buffer.alloc(32)
  sodium.crypto_generichash(seed, Buffer.concat([Buffer.from('boat-store/replicate'), keyPair.secretKey.subarray(0, 32)]))
  return HyperDHT.keyPair(seed)
}

// the query protocol, served by stores and mirrors: one JSON request per
// message, one answer (boat-ota's wire encoding). authorize(req, remote key
// hex) -> null, or why a block is refused (a store that sells reads:
// boat-registry lib/reads.js); index and head are free.
function serveQueries (dht, keyPair, store, onrequest = () => {}, authorize = null) {
  const server = dht.createServer((conn) => {
    conn.on('error', () => {})
    conn.on('data', async (data) => {
      let req
      try {
        req = JSON.parse(data.toString())
      } catch {
        return conn.write(wire.encodeError('bad request'))
      }
      try {
        const entry = await store.lookup(String(req.device))
        if (!entry) throw new Error('no such device')
        const core = await store.coreOf(entry)
        if (req.op === 'find') {
          // a message by sequence number (recent ones): its index
          const index = store.find ? await store.find(String(req.device), String(req.seq)) : null
          if (index === null || index === undefined) throw new Error('not held')
          conn.write(Buffer.from(JSON.stringify({ index })))
        } else if (req.op === 'index') {
          await core.update({ wait: false })
          conn.write(Buffer.from(JSON.stringify({ core: entry.core, signer: entry.signer, length: core.length })))
        } else if (req.op === 'head') {
          await core.update({ wait: false })
          conn.write(wire.encodeHead({ ...signedHead(core), latest: -1 }))
        } else if (req.op === 'block') {
          const index = Number(req.index)
          const length = Number(req.length || core.length)
          if (!(index >= 0 && index < length && length <= core.length)) throw new Error('no such block')
          if (!(await core.has(index))) throw new Error('block not held')
          if (authorize) {
            const why = await authorize(req, conn.remotePublicKey ? conn.remotePublicKey.toString('hex') : null)
            if (why) throw new Error(why)
          }
          onrequest({ op: 'block', device: req.device, index })
          conn.write(wire.encodeBlock(await blockProof(core, index, length)))
        } else {
          conn.write(wire.encodeError('unsupported op'))
        }
      } catch (err) {
        conn.write(wire.encodeError(err.message))
      }
    })
  })
  return server.listen(keyPair).then(() => server)
}

export async function createStore (opts) {
  const s = new Store(opts)
  await s.ready()
  return s
}

export class Store extends EventEmitter {
  // authorize: see serveQueries; record: more fields for the store's record (its read terms)
  // replicate: who may copy the cores with Hypercore's replication (mirrors):
  //   true (everyone), false, a list of keys, or (remote key hex) -> boolean.
  //   Replication hands over every block for nothing, so a store that sells
  //   reads (authorize) lets nobody replicate unless told to; others let everyone.
  // recordMs: how often the store's DHT record is put again (0: once)
  constructor ({ dht, bootstrap, keyPair, storage, devices = [], receiptMs = 5000, refreshMs = 60000, authorize = null, record = {}, replicate, recordMs = RECORD_MS }) {
    super()
    this.dht = dht || new HyperDHT({ bootstrap })
    this._ownDht = !dht
    this.keyPair = keyPair || HyperDHT.keyPair()
    this.publicKey = this.keyPair.publicKey
    this.corestore = new Corestore(storage)
    this.devices = new Map() // device hex -> { core, last: Map(topic -> seq) }
    this.wanted = new Set(devices.map(hex))
    this.receipts = new Receipts(this.keyPair)
    this.receiptMs = receiptMs
    this.clients = new Map() // home hex -> Promise<mqtt client>
    this.stats = { stored: 0, rejected: 0, replayed: 0 }
    this.homes = new Map() // device hex -> home hex, looked up again every refreshMs
    this.refreshMs = refreshMs
    this.authorize = authorize
    this.extraRecord = record
    this.replicate = replicate === undefined ? !authorize : replicate
    this.recordMs = recordMs
  }

  _mayReplicate (remote) {
    const r = this.replicate
    if (typeof r === 'function') return !!remote && !!r(remote)
    if (Array.isArray(r)) return !!remote && r.some((k) => hex(k) === remote)
    return !!r
  }

  _putRecord () {
    return this.dht.mutablePut(this.keyPair, Buffer.from(JSON.stringify(this.record)), { seq: Math.floor(Date.now() / 1000) })
  }

  async ready () {
    await this.corestore.ready()
    this.catalog = new Hyperbee(this.corestore.get({ name: 'catalog' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await this.catalog.ready()
    this.replicateKeyPair = replicationKeyPair(this.keyPair)
    this.queries = await serveQueries(this.dht, this.keyPair, this, (r) => this.emit('request', r), this.authorize)
    this._conns = new Set()
    this.replicator = this.dht.createServer((conn) => {
      conn.on('error', () => {})
      if (!this._mayReplicate(conn.remotePublicKey ? hex(conn.remotePublicKey) : null)) return conn.destroy()
      this._conns.add(conn)
      conn.on('close', () => this._conns.delete(conn))
      this.corestore.replicate(conn)
    })
    await this.replicator.listen(this.replicateKeyPair)
    this.record = { ...this.extraRecord, v: '1', boat_store: '1', catalog: hex(this.catalog.core.key), replicate: hex(this.replicateKeyPair.publicKey) }
    await this._putRecord()
    if (this.recordMs) {
      this._recordTimer = setInterval(() => this._putRecord().catch(() => {}), this.recordMs)
      this._recordTimer.unref()
    }
    this._timer = setInterval(() => this._sendReceipts(), this.receiptMs)
    this._timer.unref()
    if (this.refreshMs) {
      // a device that moved to another home node is followed there
      this._refreshTimer = setInterval(async () => {
        for (const [key, h] of this.homes) {
          const home = await homeOf(this.dht, key).catch(() => null)
          if (home && hex(home) !== h) await this.follow(key).catch(() => {})
        }
      }, this.refreshMs)
      this._refreshTimer.unref()
    }
    for (const d of this.wanted) await this.follow(d)
    return this
  }

  // the index of a device's message by sequence number, or null
  async find (device, seq) {
    const d = this.devices.get(hex(device))
    const i = d && d.bySeq.get(String(seq))
    return i === undefined ? null : i
  }

  async lookup (device) {
    const node = await this.catalog.get(device)
    return node ? node.value : null
  }

  async coreOf (entry) {
    const core = this.corestore.get({ key: Buffer.from(entry.core, 'hex') })
    await core.ready()
    return core
  }

  async _device (key) {
    let d = this.devices.get(key)
    if (d) return d
    const core = this.corestore.get({ name: 'device/' + key })
    await core.ready()
    // floor: the newest seq of the topics dropped from `last` (MAX_TOPICS);
    // queue: appends run one at a time
    d = { core, last: new Map(), bySeq: new Map(), floor: -1n, queue: Promise.resolve() }
    // after a restart: the newest seq per topic, and where recent messages
    // are, from the core itself
    for (let i = core.length - 1; i >= 0 && i >= core.length - 1000; i--) {
      const block = await core.get(i, { wait: false }) // a block cleared or lost is skipped
      if (!block) continue
      const e = decodeEntry(block)
      const seq = Buffer.from(e.message).readBigUInt64BE(2)
      if (!d.last.has(e.topic)) d.last.set(e.topic, seq)
      if (!d.bySeq.has(String(seq))) d.bySeq.set(String(seq), i)
    }
    if (!(await this.catalog.get(key))) await this.catalog.put(key, { core: hex(core.key), signer: hex(core.manifest.signers[0].publicKey) })
    this.devices.set(key, d)
    return d
  }

  // subscribes to a device at its home node
  async follow (device) {
    const key = hex(device)
    this.wanted.add(key)
    await this._device(key)
    const home = await homeOf(this.dht, key)
    if (!home) throw new Error('no home node in the record of ' + key.slice(0, 12))
    const h = hex(home)
    if (!this.clients.has(h)) {
      const p = connect(home, { dht: this.dht, keyPair: this.keyPair, clientId: hex(this.publicKey) + '-store' }).then((c) => {
        c.on('message', (topic, payload) => this._ingest(topic, payload).catch((err) => this.emit('error', err)))
        return c
      })
      this.clients.set(h, p)
      p.catch(() => this.clients.delete(h))
    }
    const client = await this.clients.get(h)
    await client.subscribeAsync(`d/${key}/#`, { qos: 1 })
    this.homes.set(key, h)
    this.emit('follow', { device: key, home: h })
  }

  async _ingest (topic, payload) {
    const from = senderOf(topic)
    if (!from || !this.wanted.has(from)) return
    const m = open(Buffer.from(from, 'hex'), topic, payload)
    if (!m) {
      this.stats.rejected++
      this.emit('rejected', { device: from, topic, reason: payload[0] === 0x53 ? 'bad signature' : 'not signed' })
      return
    }
    const d = await this._device(from)
    // one at a time for a device: `last` moves only once the entry is in the
    // core (an append that fails can be sent again), and of two copies that
    // arrive together only one may pass the check
    const run = d.queue.then(() => this._append(d, from, topic, payload, m))
    d.queue = run.catch(() => {})
    return run
  }

  async _append (d, from, topic, payload, m) {
    const last = d.last.get(topic)
    if (last !== undefined ? m.seq <= last : m.seq <= d.floor) {
      this.stats.replayed++
      return
    }
    const index = (await d.core.append(encodeEntry(topic, payload))).length - 1
    d.last.delete(topic) // (in time order: the newest last)
    d.last.set(topic, m.seq)
    if (d.last.size > MAX_TOPICS) {
      // a device with ever new topics: forget the oldest, and refuse on
      // topics not remembered what is not newer than it
      const [old, seq] = d.last.entries().next().value
      d.last.delete(old)
      if (seq > d.floor) d.floor = seq
    }
    // where a message is, by sequence number (one counter per device), for the last 10,000
    d.bySeq.set(String(m.seq), index)
    if (d.bySeq.size > 10000) d.bySeq.delete(d.bySeq.keys().next().value)
    this.receipts.add(from, payload)
    this.stats.stored++
    this.emit('stored', { device: from, topic, seq: m.seq, index, payload })
  }

  async _sendReceipts () {
    for (const key of this.receipts.dirty()) {
      const line = this.receipts.receipt(key)
      for (const p of this.clients.values()) {
        const c = await p.catch(() => null)
        if (c) c.publish(`d/${hex(this.publicKey)}/receipts/${key}`, line, { qos: 1, retain: true })
      }
    }
  }

  async close () {
    clearInterval(this._timer)
    clearInterval(this._refreshTimer)
    clearInterval(this._recordTimer)
    for (const p of this.clients.values()) (await p.catch(() => null))?.end(true)
    for (const c of this._conns) c.destroy() // replication sessions hold the cores open
    await this.queries.close()
    await this.replicator.close()
    await this.corestore.close()
    if (this._ownDht) await this.dht.destroy()
  }
}

// A mirror: replicates a store's cores and serves them the same way.
export async function createMirror ({ dht, keyPair, storage, store }) {
  const m = new EventEmitter()
  const res = await dht.mutableGet(Buffer.from(hex(store), 'hex'), { latest: true })
  if (!res) throw new Error('no record for that store')
  const record = JSON.parse(res.value.toString())
  m.keyPair = keyPair || HyperDHT.keyPair()
  m.publicKey = m.keyPair.publicKey
  m.corestore = new Corestore(storage)
  await m.corestore.ready()
  // updates wait until the replication connection is up
  const found = m.corestore.findingPeers()
  // with its own key when it has one: a store that sells reads lets only the
  // mirrors it names replicate (Store's replicate)
  const conn = dht.connect(Buffer.from(record.replicate, 'hex'), keyPair ? { keyPair } : undefined)
  conn.on('error', () => {})
  conn.once('close', found)
  m.corestore.replicate(conn)
  m.catalog = new Hyperbee(m.corestore.get({ key: Buffer.from(record.catalog, 'hex') }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await m.catalog.ready()
  // a core replicates once its peer has said it has it: wait for that (on the
  // public DHT this takes round trips; reading earlier finds nothing)
  const peered = (core, ms = 20000) => core.peers.length ? Promise.resolve() : Promise.race([new Promise((resolve) => core.once('peer-add', resolve)), new Promise((resolve) => setTimeout(resolve, ms))])
  peered(m.catalog.core).then(found)
  m.lookup = async (device) => {
    await m.catalog.core.update()
    const node = await m.catalog.get(device)
    return node ? node.value : null
  }
  m.coreOf = async (entry) => {
    const core = m.corestore.get({ key: Buffer.from(entry.core, 'hex') })
    await core.ready()
    return core
  }
  // copies every device's core, and keeps up with them
  m.sync = async () => {
    await peered(m.catalog.core)
    await m.catalog.core.update({ wait: true })
    for await (const { key, value } of m.catalog.createReadStream()) {
      const core = await m.coreOf(value)
      await peered(core)
      await core.update({ wait: true })
      if (core.length) await core.download({ start: 0, end: core.length }).done()
      m.emit('synced', { device: key, length: core.length })
    }
  }
  m.queries = await serveQueries(dht, m.keyPair, m)
  m.close = async () => {
    conn.destroy()
    await m.queries.close()
    await m.corestore.close()
  }
  return m
}

// ---- reading and checking a store (or a mirror) ----------------------------

// timeout: ms to wait for the connection, and for each answer (0: for ever)
async function ask (dht, server, keyPair = null, timeout = REQUEST_MS) {
  const conn = dht.connect(Buffer.from(hex(server), 'hex'), keyPair ? { keyPair } : undefined)
  const waiting = [] // { resolve, reject, timer }, oldest first
  let closed = null
  const fail = (err) => {
    closed = closed || err
    for (const w of waiting.splice(0)) {
      clearTimeout(w.timer)
      w.reject(closed)
    }
  }
  conn.on('data', (data) => {
    const w = waiting.shift()
    if (!w) return
    clearTimeout(w.timer)
    w.resolve(data)
  })
  conn.on('error', () => {})
  conn.on('close', () => fail(new Error('connection closed')))
  await new Promise((resolve, reject) => {
    const t = timeout ? setTimeout(() => { reject(new Error('timed out connecting')); conn.destroy() }, timeout) : null
    conn.once('open', () => { clearTimeout(t); resolve() })
    conn.once('error', (err) => { clearTimeout(t); reject(err) })
    conn.once('close', () => { clearTimeout(t); reject(new Error('connection closed')) })
  })
  const req = (body) => new Promise((resolve, reject) => {
    if (closed) return reject(closed)
    const w = { resolve, reject, timer: null }
    // answers come back in order, with nothing to tell them apart: a late one
    // would be taken for the next request's, so a timeout ends the connection
    if (timeout) w.timer = setTimeout(() => { fail(new Error('timed out waiting for an answer')); conn.destroy() }, timeout)
    waiting.push(w)
    conn.write(Buffer.from(JSON.stringify(body)))
  })
  return { conn, req }
}

const KEY = /^[0-9a-f]{64}$/
const failure = (data) => data[0] === 0x45 ? data.subarray(1).toString() : null

// opens a device's log on a store or mirror: { length, head, block(i) }, every
// block checked against the signed head and the device's signature
//
// pay(request) -> fields to add to a block request (a paid read's voucher)
// timeout: ms to wait for the store to connect and for each answer (0: for
//   ever); a request that times out rejects, and closes the log
// The core, its signer and the length are what the store says. What the
// caller knows already holds it to that:
//   core, signer: the keys seen before (as returned here), or it throws
//   minLength: entries the caller knows are there, or it throws
export async function openLog (dht, server, device, { pay = null, keyPair = null, timeout = REQUEST_MS, core = null, signer = null, minLength = 0 } = {}) {
  const key = hex(device)
  const { conn, req } = await ask(dht, server, keyPair, timeout)
  const stop = (message) => {
    conn.destroy()
    return new Error(message)
  }
  const idx = await req({ op: 'index', device: key })
  if (failure(idx)) throw stop('store: ' + failure(idx))
  let index
  try {
    index = JSON.parse(idx.toString())
  } catch {}
  if (!index || !KEY.test(index.core) || !KEY.test(index.signer)) throw stop('store: bad index')
  if (core && hex(core) !== index.core) throw stop('head: another core than the one expected')
  if (signer && hex(signer) !== index.signer) throw stop('head: another signer than the one expected')
  const h = await req({ op: 'head', device: key })
  if (failure(h)) throw stop('store: ' + failure(h))
  const head = wire.decodeHead(h)
  const why = verifyHead(head, Buffer.from(index.core, 'hex'), Buffer.from(index.signer, 'hex'))
  if (why) throw stop('head: ' + why)
  if (head.length < minLength) throw stop(`head: ${head.length} entries, fewer than the ${minLength} expected`)
  const block = async (i) => {
    const body = { op: 'block', device: key, index: i, length: head.length }
    if (pay) Object.assign(body, await pay(body))
    const data = await req(body)
    if (failure(data)) return { index: i, ok: false, reason: failure(data) }
    const b = wire.decodeBlock(data)
    if (b.index !== i) return { index: i, ok: false, reason: 'another block' }
    const bad = verifyBlock(head, b)
    if (bad) return { index: i, ok: false, reason: bad }
    let e = null
    try { e = decodeEntry(Buffer.from(b.data)) } catch {} // too short to be an entry
    const m = e && senderOf(e.topic) === key ? open(Buffer.from(key, 'hex'), e.topic, e.message) : null
    if (!m) return { index: i, ok: false, reason: 'not signed by the device' }
    return { index: i, ok: true, topic: e.topic, seq: m.seq, payload: m.payload, message: e.message }
  }
  // a message by sequence number (and topic, when given): the block, checked like any other, or null
  const find = async (topic, seq) => {
    const data = await req({ op: 'find', device: key, seq: String(seq) })
    if (failure(data)) return null
    let at
    try { at = JSON.parse(data.toString()).index } catch { return null }
    if (!(at < head.length)) return null // stored after the head we hold
    const b = await block(at)
    return b.ok && (!topic || b.topic === topic) && String(b.seq) === String(seq) ? b : null
  }
  return { length: head.length, head, core: index.core, signer: index.signer, block, find, close: () => conn.destroy() }
}

// asks for `samples` random blocks: a store that does not hold them cannot answer
//
// Every block must carry the device's own signature (openLog), so a store
// cannot pass with a log of its own making; but how long the log is, is its
// word. So the caller says what it knows:
//   minLength: entries known to be there (1: an empty log does not pass)
//   seqs: sequence numbers known to be stored (from a store's signed work,
//     say); each must be found, as a checked block (`found`, in that order)
//   core, signer, keyPair, pay, timeout: as for openLog
export async function spotCheck (dht, server, device, { samples = 8, indices, minLength = 1, seqs = [], core = null, signer = null, keyPair = null, pay = null, timeout = REQUEST_MS } = {}) {
  const t0 = Date.now()
  const log = await openLog(dht, server, device, { core, signer, keyPair, pay, timeout })
  try {
    if (log.length < minLength) {
      const reason = `${log.length} entries, fewer than the ${minLength} expected`
      return { ok: false, length: log.length, checked: 0, failed: [{ ok: false, reason }], found: [], ms: Date.now() - t0 }
    }
    const picks = indices || Array.from({ length: Math.min(samples, log.length) }, () => crypto.randomInt(log.length))
    const results = []
    for (const i of picks) results.push(await log.block(i))
    const found = []
    for (const seq of seqs) {
      const b = await log.find(null, seq)
      found.push(b)
      if (!b) results.push({ seq: BigInt(seq), ok: false, reason: 'not held' })
    }
    const failed = results.filter((r) => !r.ok)
    return { ok: failed.length === 0, length: log.length, checked: picks.length + seqs.length, failed, found, ms: Date.now() - t0 }
  } finally {
    log.close()
  }
}
