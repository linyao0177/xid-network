// Jobs on the registry, and nodes' work on them unit by unit.
//
// A job (BoatRegistry.postJob) asks nodes of one role to work on a device's
// signed messages and pays per unit: a window of `window` sequence numbers
// of one boot (unitOf). For each unit a node signs one result:
//
//   store    the root of the messages it holds (storeLeaf), in a Hypercore
//            others can spot-check (boat-mqtt-node's store.js)
//   verify   the root of its verdicts on them (verifier.js leafOf; replays
//            and messages without the device's valid signature left out)
//   compute  keccak(inputs hash, the rule's value), the rule run on the
//            readings of the window (compute.js runRule)
//   forward  keccak(forwarder, root of the messages), signed by the node the
//            device published them to and by verifiers that got them
//            through that node (settled with settleForward; the forwarder
//            is paid)
//
// and publishes it retained at d/<node>/work/<job>/<unit>, with what it
// computed it from, so anyone can check it. A unit is settled on the
// registry when `quorum` active nodes signed the same result (Settler); they
// share the pay. Results that are wrong are faults (watch.js).

import { EventEmitter } from 'events'
import { AbiCoder, keccak256, getBytes, verifyMessage, toUtf8Bytes, Contract } from 'ethers'
import { merkleRoot } from './merkle.js'
import { judgeMessage, leafOf, VERDICT } from './verifier.js'
import { runRule, inputsHash } from './compute.js'
import { ROLES, TEST_TOKEN, asBytes32, workStatement, settledKey, sortBySigner } from './registry.js'
import { keyIdOf } from 'boat-mqtt-node'

const abi = AbiCoder.defaultAbiCoder()
export const SPEC = {
  verify: keccak256(toUtf8Bytes('boat-verify/1')),
  store: keccak256(toUtf8Bytes('boat-store/1')),
  forward: keccak256(toUtf8Bytes('boat-forward/1'))
}
export const ROLE_NAME = { [ROLES.FORWARD]: 'forward', [ROLES.STORE]: 'store', [ROLES.VERIFY]: 'verify', [ROLES.COMPUTE]: 'compute' }

// ---- jobs -------------------------------------------------------------------

export const computeJob = ({ wasm, topic = 'telemetry', field, window, price }) =>
  ({ role: ROLES.COMPUTE, spec: keccak256(wasm), params: { topic, field, window, price: String(price), wasm: Buffer.from(wasm).toString('hex') } })
export const verifyJob = ({ window }) => ({ role: ROLES.VERIFY, spec: SPEC.verify, params: { window } })
export const storeJob = ({ window }) => ({ role: ROLES.STORE, spec: SPEC.store, params: { window } })
// pays the node the device's messages go through, with verifiers as witnesses
export const forwardJob = ({ window }) => ({ role: ROLES.FORWARD, spec: SPEC.forward, params: { window } })

// approves the budget and posts the job; returns its id. perEpoch: units
// that may settle in one epoch (what a few bad nodes could take at most)
export async function postJob (registry, payer, { role, device, spec, params, pay, quorum, budget, perEpoch = 1000 }) {
  const token = new Contract(await registry.token(), TEST_TOKEN.abi, payer)
  await (await token.approve(await registry.getAddress(), budget)).wait()
  const terms = { role, quorum, perEpoch, deadline: 0, spec, pay, budget }
  const r = await (await registry.connect(payer).postJob(asBytes32(device), terms, toUtf8Bytes(JSON.stringify(params)))).wait()
  for (const log of r.logs) {
    let e = null
    try { e = registry.interface.parseLog(log) } catch {}
    if (e && e.name === 'JobPosted') return Number(e.args.id)
  }
  throw new Error('no JobPosted event')
}

// a job with its params (from its JobPosted event), checked against its spec
export async function readJob (registry, id) {
  const j = await registry.jobs(id)
  const events = await registry.queryFilter(registry.filters.JobPosted(id), Number(j.postedAt), Number(j.postedAt))
  // (no event yet: an RPC behind the chain; read again later)
  if (events.length !== 1) throw new Error(`no JobPosted event for job ${id} yet`)
  let params
  try { params = JSON.parse(Buffer.from(getBytes(events[0].args.params)).toString()) } catch { throw new Error(`job ${id}: bad params`) }
  const job = {
    id: Number(id),
    payer: j.payer,
    role: Number(j.role),
    quorum: Number(j.quorum),
    closesAt: Number(j.closesAt),
    device: j.device.slice(2),
    spec: j.spec,
    pay: j.pay,
    budget: j.budget,
    params
  }
  if (!Number.isInteger(params.window) || params.window < 1 || params.window > 1000) throw new Error(`job ${id}: bad window`)
  if (job.role === ROLES.COMPUTE) {
    job.wasm = Buffer.from(params.wasm || '', 'hex')
    if (keccak256(job.wasm) !== job.spec) throw new Error(`job ${id}: the WASM is not the one its spec names`)
    job.price = BigInt(params.price)
  } else if (job.spec !== SPEC[ROLE_NAME[job.role]]) {
    throw new Error(`job ${id}: unknown spec`)
  }
  return job
}

// ---- units and results ------------------------------------------------------

// the unit of a sequence number: boot << 32 | (count / window)
export const unitOf = (seq, window) => ((BigInt(seq) >> 32n) << 32n) | ((BigInt(seq) & 0xffffffffn) / BigInt(window))

export const storeLeaf = ({ device, topic, seq, payloadHash }) =>
  keccak256(abi.encode(['bytes32', 'bytes32', 'uint64', 'bytes32'], ['0x' + device, keccak256(toUtf8Bytes(topic)), BigInt(seq), payloadHash]))
export const computeResult = (inputs, value) => keccak256(abi.encode(['bytes32', 'int256'], [inputsHash(inputs), BigInt(value)]))

const bySeq = (a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0)

// the result a work message's detail gives (what it should have signed)
export const forwardResult = (forwarder, root) => keccak256(abi.encode(['address', 'bytes32'], [forwarder, root]))

export function resultOf (role, detail) {
  if (role === ROLES.FORWARD) return forwardResult(detail.forwarder, merkleRoot(detail.leaves.map(storeLeaf)))
  if (role === ROLES.VERIFY) return merkleRoot(detail.leaves.map(leafOf))
  if (role === ROLES.STORE) return merkleRoot(detail.leaves.map(storeLeaf))
  if (role === ROLES.COMPUTE) return computeResult(detail.inputs, detail.value)
  throw new Error('role')
}

// checks a work message's signature: the operator it names, or null.
// Recovering a secp256k1 signer in JS takes a millisecond or two, and a node
// sees each message from its settler and its watchtower, and again on every
// retry: so each answer is kept (for the last 50,000 messages)
const signers = new Map()
export function signerOf (ctx, w) {
  const k = `${ctx.chainId}:${ctx.registry}:${w.job}:${w.unit}:${w.result}:${w.operator}:${w.signature}`
  if (signers.has(k)) return signers.get(k)
  let a = null
  try {
    a = verifyMessage(getBytes(workStatement(ctx, w.job, BigInt(w.unit), w.result)), w.signature)
    if (a !== w.operator) a = null
  } catch {}
  signers.set(k, a)
  if (signers.size > 50000) signers.delete(signers.keys().next().value)
  return a
}

// ---- a node's work on one job -----------------------------------------------

// Takes the device's messages (take) or, for a store, what it stored
// (stored), and signs each unit once it is complete. publish(topic, payload)
// puts the work message where others see it (a Follower's publish).
// lie(result, detail) is for tests: a node that signs something else.
export class Worker extends EventEmitter {
  // forward jobs: mode 'forwarder' (this node is the device's node: give it
  // published()) or 'witness' (a verifier: take() with the node each message
  // came through, forwarderOf(node key) -> operator address)
  // memory: { get(unit) -> result | undefined, set(unit, result) }, kept on
  // disk by the node, so a restart never signs a unit twice
  // keyring: a boat-mqtt-node KeyRing, to read sealed readings (compute)
  constructor ({ job, operator, ctx, nodeKey, publish, storeKey = null, lie = null, mode = null, forwarderOf = null, memory = null, keyring = null }) {
    super()
    this.keyring = keyring
    this.memory = memory
    this.mode = mode
    this.forwarderOf = forwarderOf
    this.via = new Map() // unit -> node key the messages came through (witness)
    this.job = job
    this.operator = operator
    this.ctx = ctx // { registry: address, chainId }
    this.nodeKey = nodeKey
    this.publish = publish
    this.storeKey = storeKey
    this.lie = lie
    this.window = job.params.window
    this.units = new Map() // unit -> Map(seq:topic -> item)
    this.last = new Map() // topic -> seq (replays)
    this.signed = new Map() // unit -> work message
    this.latest = -1n
    this.signedCount = 0
    this.asked = new Set() // units whose missing messages were asked for
    // what happened to the messages and units: taken, refused (bad signature
    // or a replay), units given up on (still short 8 units later), units
    // short when the next began (their missing messages were asked for)
    this.counts = { taken: 0, refused: 0, dropped: 0, short: 0 }
  }

  // a message the device published (verify, compute; forward as a witness).
  // backfill: one fetched from a store to complete a unit (not a replay
  // because it is older; never for forwarding, which counts only what
  // came through the node)
  take (device, topic, payload, via = null, backfill = false) {
    if (device !== this.job.device) return
    if (this.job.role === ROLES.FORWARD && (this.mode !== 'witness' || backfill)) return
    const v = judgeMessage(device, topic, payload, backfill ? new Map() : this.last)
    if (!(v.verdict & VERDICT.SIGNED_OK) || (v.verdict & VERDICT.REPLAY)) {
      this.counts.refused++
      return
    }
    this.counts.taken++
    if (this.job.role === ROLES.FORWARD) {
      const unit = unitOf(v.seq, this.window)
      const was = this.via.get(unit)
      if (was === undefined) this.via.set(unit, via)
      else if (was !== via) this.via.set(unit, null) // the device moved: no one node forwarded the unit
      this._add(v.seq, topic, { device, topic, seq: v.seq, payloadHash: v.payloadHash })
    } else if (this.job.role === ROLES.VERIFY) {
      this._add(v.seq, topic, { ...v, verdict: v.verdict & ~VERDICT.REPLAY })
    } else if (this.job.role === ROLES.COMPUTE) {
      // every signed message counts towards the unit's window (a device has
      // one counter); only readings of the job's topic are inputs
      if (!topic.endsWith('/' + this.job.params.topic)) return this._add(v.seq, topic, { seq: v.seq, value: null })
      let value
      let body = payload.subarray(74)
      if (keyIdOf(body) !== null) body = this.keyring ? this.keyring.open(device, topic, body) : null // sealed: readers only
      if (!body) return this._add(v.seq, topic, { seq: v.seq, value: null }) // sealed, and not for us
      try { value = JSON.parse(body.toString())[this.job.params.field] } catch {}
      if (!Number.isInteger(value)) return this._add(v.seq, topic, { seq: v.seq, value: null })
      this._add(v.seq, topic, { seq: v.seq, value: String(value) })
    }
  }

  // what the device published to this node (boat-mqtt-node 'published')
  published (e) {
    if (this.job.role !== ROLES.FORWARD || this.mode !== 'forwarder' || e.key !== this.job.device) return
    const v = judgeMessage(e.key, e.topic, e.payload, this.last)
    if (!(v.verdict & VERDICT.SIGNED_OK) || (v.verdict & VERDICT.REPLAY)) {
      this.counts.refused++
      return
    }
    this.counts.taken++
    this._add(v.seq, e.topic, { device: e.key, topic: e.topic, seq: v.seq, payloadHash: v.payloadHash })
  }

  // what a store appended to the device's Hypercore (store.js 'stored')
  stored (e) {
    if (this.job.role !== ROLES.STORE || e.device !== this.job.device) return
    this.counts.taken++
    this._add(String(e.seq), e.topic, { device: e.device, topic: e.topic, seq: String(e.seq), payloadHash: keccak256(e.payload) })
  }

  _add (seq, topic, item) {
    const unit = unitOf(seq, this.window)
    if (this.signed.has(unit)) return
    if (unit > this.latest) this.latest = unit
    let u = this.units.get(unit)
    if (!u) this.units.set(unit, (u = new Map()))
    u.set(seq + ':' + topic, item)
    // a unit is complete with `window` messages (distinct sequence numbers)
    const seqs = new Set([...u.values()].map((x) => x.seq))
    if (seqs.size >= this.window) {
      this.units.delete(unit)
      this._sign(unit, [...u.values()]).catch((err) => this.emit('error', err))
    }
    // a unit still short once the next one has started: ask for what is
    // missing (the node fetches it from a store); dropped after a while
    for (const [k, items] of this.units) {
      if (k + 8n < this.latest) {
        this.units.delete(k)
        this.counts.dropped++
        continue
      }
      if (k + 1n < this.latest && !this.asked.has(k)) {
        this.asked.add(k)
        this.counts.short++
        const have = new Set([...items.values()].map((x) => BigInt(x.seq)))
        const first = ((k >> 32n) << 32n) | ((k & 0xffffffffn) * BigInt(this.window))
        const missing = []
        for (let i = 0n; i < BigInt(this.window); i++) if (!have.has(first + i)) missing.push(first + i)
        if (missing.length && this.job.role !== ROLES.FORWARD) this.emit('missing', { job: this.job, unit: k, missing })
      }
    }
    for (const k of this.asked) if (k + 16n < this.latest) this.asked.delete(k)
  }

  async _sign (unit, items) {
    let detail
    if (this.job.role === ROLES.COMPUTE) {
      const inputs = items.filter((x) => x.value !== null).sort(bySeq).map((x) => [x.seq, x.value])
      if (inputs.length === 0) return null // nothing to bill in this window
      detail = { inputs, value: String(runRule(this.job.wasm, inputs.map(([, v]) => v), this.job.price)) }
    } else if (this.job.role === ROLES.FORWARD) {
      let forwarder = this.operator.address
      if (this.mode === 'witness') {
        const via = this.via.get(unit)
        forwarder = via ? await this.forwarderOf(via).catch(() => null) : null
        if (!forwarder) return null // not through one known node
      }
      detail = { leaves: items.sort(bySeq), forwarder }
    } else {
      detail = { leaves: items.sort(bySeq) }
      if (this.storeKey) detail.store = this.storeKey
    }
    let result = resultOf(this.job.role, detail)
    const before = this.memory && this.memory.get(String(unit))
    if (before !== undefined && before !== null) {
      if (before !== result) this.emit('error', new Error(`unit ${unit} was signed before with another result: not signing again`))
      return null
    }
    if (this.lie) {
      const l = this.lie(result, detail, unit)
      if (l) {
        detail = l.detail
        result = l.result ?? resultOf(this.job.role, detail)
      }
    }
    const w = {
      v: 1,
      job: this.job.id,
      unit: String(unit),
      role: this.job.role,
      device: this.job.device,
      result,
      operator: this.operator.address,
      node: this.nodeKey,
      detail
    }
    w.signature = await this.operator.signMessage(getBytes(workStatement(this.ctx, w.job, unit, w.result)))
    if (this.memory) this.memory.set(String(unit), w.result)
    this.signed.set(unit, w)
    this.signedCount++
    for (const k of this.signed.keys()) if (k + 64n < unit) this.signed.delete(k)
    for (const k of this.via.keys()) if (k + 64n < unit) this.via.delete(k)
    // at: when it was sent (not signed: for measuring how long work takes to
    // reach the other nodes)
    await this.publish(`d/${this.nodeKey}/work/${w.job}/${w.unit}`, JSON.stringify({ ...w, at: Date.now() }), { qos: 1, retain: true })
    this.emit('signed', w)
    return w
  }
}

// ---- settling ---------------------------------------------------------------

// Collects work messages (its own and other nodes') and settles units on the
// registry: once `quorum` active nodes signed the same result it waits
// settleDelayMs for more signers, then the signer with the lowest address
// submits; the others submit after a further delay if it has not.
export class Settler extends EventEmitter {
  // tx(fn): runs fn (which sends a transaction and waits for it) after the
  // node's other transactions, so they never take the same nonce
  // batchMs, batchSize: settlements go out together, every batchMs or once
  // batchSize are waiting
  constructor ({ registry, operator, ctx, jobs, settleDelayMs = 5000, backupMs = 20000, tx = (fn) => fn(), batchMs = 500, batchSize = 40, maxAgeMs = 3600000 }) {
    super()
    this.tx = tx
    this.registry = registry.connect(operator)
    this.operator = operator
    this.ctx = ctx
    this.jobs = jobs // id -> job
    this.settleDelayMs = settleDelayMs
    this.backupMs = backupMs
    this.units = new Map() // job:unit -> { results: Map(result -> Map(operator -> w)), timer, done }
    this.active = new Map() // operator:role -> { ok, at }
    this.stats = { settled: 0, submitted: 0, paid: 0n, quorums: 0, attempts: 0, waits: 0, errors: {}, split: 0, quorumMs: [0, 0, 0, 0, 0, 0], transitMs: [0, 0, 0, 0, 0, 0] }
    this.queue = [] // units to settle in the next batch
    this.batchSize = batchSize
    this._flushTimer = setInterval(() => this._flush().catch((e) => this.emit('error', e)), batchMs)
    this._flushTimer.unref?.()
    this.maxAgeMs = maxAgeMs
    this._pruneTimer = setInterval(() => this._prune(), 10000)
    this._pruneTimer.unref?.()
  }

  async isActive (operator, role) {
    const k = operator + ':' + role
    const c = this.active.get(k)
    if (c && c.ok !== undefined && Date.now() - c.at < 30000) return c.ok
    if (c && c.loading) return c.loading // one lookup at a time
    const loading = this.registry.isActive(operator, role)
    this.active.set(k, { ...c, loading })
    try {
      const ok = await loading
      this.active.set(k, { ok, at: Date.now() })
      return ok
    } catch (err) {
      this.active.delete(k)
      throw err
    }
  }

  // signatures and activity are checked when a group is about to settle
  // (_settle), not for every message
  async add (w) {
    const job = this.jobs.get(w.job)
    if (!job || w.role !== job.role) return
    // another node's work: how long it took to get here (same buckets)
    if (w.at && w.operator !== this.operator.address) {
      const t = [2000, 5000, 15000, 30000, 60000].findIndex((x) => Date.now() - w.at < x)
      this.stats.transitMs[t < 0 ? 5 : t]++
    }
    if (job.role === ROLES.FORWARD) return this._addForward(job, w)
    const k = w.job + ':' + w.unit
    let u = this.units.get(k)
    if (!u) this.units.set(k, (u = { results: new Map(), timer: null, done: false, at: Date.now() }))
    if (u.done) return
    if (!u.results.has(w.result)) {
      u.results.set(w.result, new Map())
      if (u.results.size === 2) this.stats.split++ // workers disagree on the unit
    }
    u.results.get(w.result).set(w.operator, w)
    if (w.operator === this.operator.address && !u.mineAt) u.mineAt = Date.now()
    const mine = [...u.results.entries()].find(([, m]) => m.has(this.operator.address))
    if (!mine || mine[1].size < job.quorum || u.timer) return
    // only a node that signed the result settles it (it is paid for it)
    this.stats.quorums++
    // from our signature to a quorum: under 2, 5, 15, 30, 60 s, or more
    const ms = Date.now() - (u.mineAt || u.at)
    const bucket = [2000, 5000, 15000, 30000, 60000].findIndex((x) => ms < x)
    this.stats.quorumMs[bucket < 0 ? 5 : bucket]++
    u.timer = setTimeout(() => this._settle(job, k, mine[0]).catch((err) => this.emit('error', err)), this.settleDelayMs)
    u.timer.unref?.()
  }

  // forgets settled units after a minute and unsettled ones after maxAgeMs
  // (by then their backups have given up). It used to keep the last 2,000
  // units whatever their state: at 4 jobs a device and a few hundred jobs a
  // node that is half a minute, shorter than a backup's wait, so units still
  // waiting to settle were dropped
  _prune () {
    const now = Date.now()
    for (const [k, u] of this.units) {
      const age = now - u.at
      if ((u.done && age > 60000) || age > this.maxAgeMs) {
        if (u.timer) clearTimeout(u.timer)
        this.units.delete(k)
      }
    }
  }

  // forward units: the forwarder's signature and `quorum` verifiers' on one result
  async _addForward (job, w) {
    const forwarder = w.detail && w.detail.forwarder
    if (!forwarder) return
    const k = w.job + ':' + w.unit
    let u = this.units.get(k)
    if (!u) this.units.set(k, (u = { results: new Map(), timer: null, done: false, at: Date.now() }))
    if (u.done) return
    if (!u.results.has(w.result)) u.results.set(w.result, new Map())
    const group = u.results.get(w.result)
    group.set(w.operator, w)
    if (!group.has(this.operator.address) || !group.has(forwarder)) return
    if (group.size - 1 < job.quorum || u.timer) return
    u.timer = setTimeout(() => this._settle(job, k, w.result).catch((err) => this.emit('error', err)), this.settleDelayMs)
    u.timer.unref?.()
  }

  async _settle (job, k, result, backup = false, attempt = 0) {
    const u = this.units.get(k)
    if (!u || u.done) return
    const forwarder = job.role === ROLES.FORWARD ? [...u.results.get(result).values()][0].detail.forwarder : null
    const unit = BigInt([...u.results.get(result).values()][0].unit)
    // who submits first: the forwarder (it is paid), or the signer that ranks
    // first by keccak(job, unit, operator), so the work and its gas spread.
    // The others wait without checking signatures (checking each one costs a
    // millisecond or two, for every node that saw the quorum): only the
    // submitter, and a backup when its turn comes, check them
    const rank = (op) => keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'uint64', 'address'], [job.id, unit, op]))
    const first = job.role === ROLES.FORWARD ? forwarder : [...u.results.get(result).keys()].map((op) => [rank(op), op]).sort((a, b) => (a[0] < b[0] ? -1 : 1))[0][1]
    if (!backup && first !== this.operator.address) {
      this.stats.waits++
      u.timer = setTimeout(() => this._settle(job, k, result, true).catch((err) => this.emit('error', err)), this.backupMs + Math.floor(Math.random() * 5000))
      u.timer.unref?.()
      return
    }
    const settledAlready = async () => {
      if ((await this.registry.settled(settledKey(job.id, unit))) === '0x' + '0'.repeat(64)) return false
      u.done = true
      this.stats.settled++
      this.emit('settled', { job: job.id, unit, result, by: 'another node' })
      return true
    }
    // a backup: most often the first submitter has settled it by now
    if (backup && await settledAlready()) return
    const signers = []
    for (const s of sortBySigner([...u.results.get(result).values()])) {
      if (!signerOf(this.ctx, s)) continue
      const role = job.role !== ROLES.FORWARD ? job.role : s.operator === forwarder ? ROLES.FORWARD : ROLES.VERIFY
      if (await this.isActive(s.operator, role).catch(() => false)) signers.push(s)
    }
    const enough = job.role === ROLES.FORWARD ? signers.some((s) => s.operator === forwarder) && signers.length - 1 >= job.quorum : signers.length >= job.quorum
    if (!enough) {
      // forged or inactive signers: wait for more
      if (attempt < 8) {
        u.timer = setTimeout(() => this._settle(job, k, result, backup, attempt + 1).catch((e) => this.emit('error', e)), this.backupMs)
        u.timer.unref?.()
      }
      return
    }
    if (!backup && await settledAlready()) return
    this.stats.attempts++
    // into the next batch (settleMany): one transaction for many units
    const d = signers[0].detail
    const item = job.role === ROLES.FORWARD
      ? { forward: true, k, job, unit, result, root: merkleRoot(d.leaves.map(storeLeaf)), forwarder: d.forwarder, sigs: signers.map((x) => x.signature), signers: signers.length, attempt }
      : { forward: false, k, job, unit, result, sigs: signers.map((x) => x.signature), signers: signers.length, attempt }
    this.queue.push(item)
    if (this.queue.length >= this.batchSize) this._flush().catch((e) => this.emit('error', e))
  }

  // sends what is queued, one batch per kind of settlement. A batch holds the
  // node's transaction queue only until it is sent (the next one takes the
  // next nonce), not until it is mined: waiting for each receipt in turn held
  // a node to a batch every few seconds, so first submitters fell behind and
  // backups sent the same units again
  async _flush () {
    if (this._flushing || this.queue.length === 0) return
    this._flushing = true
    const confirming = []
    try {
      const seen = new Set()
      const items = this.queue.splice(0, this.batchSize).filter((i) => {
        const u = this.units.get(i.k)
        return !seen.has(i.k) && seen.add(i.k) && !u?.done && !u?.sending
      })
      for (const group of [items.filter((i) => !i.forward), items.filter((i) => i.forward)]) {
        if (group.length === 0) continue
        for (const i of group) { const u = this.units.get(i.k); if (u) u.sending = true }
        let tx = null
        try {
          tx = await this.tx(async () => {
            const tx = group[0].forward
              ? await this.registry.settleForwardMany(group.map((i) => ({ id: i.job.id, unit: i.unit, root: i.root, forwarder: i.forwarder, sigs: i.sigs })))
              : await this.registry.settleMany(group.map((i) => ({ id: i.job.id, unit: i.unit, result: i.result, sigs: i.sigs })))
            // the next transaction takes the next nonce once the node sees this one
            const provider = this.operator.provider
            for (let t = 0; t < 100; t++) {
              if ((await provider.getTransactionCount(this.operator.address, 'pending').catch(() => 0)) > tx.nonce) break
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
            return tx
          })
        } catch (err) {
          this._error(err)
        }
        confirming.push(this._confirm(group, tx))
      }
    } finally {
      this._flushing = false
    }
    if (this.queue.length >= this.batchSize) confirming.push(this._flush())
    await Promise.all(confirming)
  }

  _error (err) {
    const why = (err.shortMessage || err.message || '').slice(0, 40)
    this.stats.errors[why] = (this.stats.errors[why] || 0) + 1
  }

  // a sent batch (or one that could not be sent): what it settled, and what
  // to try again
  async _confirm (group, tx) {
    let r = null
    if (tx) {
      try {
        r = await tx.wait()
      } catch (err) {
        this._error(err)
      }
    }
    const done = new Set()
    for (const log of r ? r.logs : []) {
      let e = null
      try { e = this.registry.interface.parseLog(log) } catch {}
      if (e && e.name === 'Settled') done.add(e.args.id + ':' + e.args.unit)
    }
    for (const i of group) {
      const u = this.units.get(i.k)
      if (u) u.sending = false
      if (!u || u.done) continue
      if (done.has(i.job.id + ':' + i.unit)) {
        u.done = true
        this.stats.settled++
        this.stats.submitted++
        this.emit('settled', { job: i.job.id, unit: i.unit, result: i.result, by: 'us', signers: i.signers, gas: r.gasUsed / BigInt(done.size), tx: r.hash, batch: group.length })
        continue
      }
      // not settled by us: by another node, or not yet possible (a quorum
      // that counts only from the next epoch, the job's rate): try again later
      if ((await this.registry.settled(settledKey(i.job.id, i.unit)).catch(() => '0x' + '0'.repeat(64))) !== '0x' + '0'.repeat(64)) {
        u.done = true
        this.stats.settled++
        this.emit('settled', { job: i.job.id, unit: i.unit, result: i.result, by: 'another node' })
      } else if (i.attempt < 8) {
        u.timer = setTimeout(() => this._settle(i.job, i.k, i.result, true, i.attempt + 1).catch((e) => this.emit('error', e)), this.backupMs * 2 ** i.attempt)
        u.timer.unref?.()
      }
    }
  }

  close () {
    clearInterval(this._flushTimer)
    clearInterval(this._pruneTimer)
  }
}
