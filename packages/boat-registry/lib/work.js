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
// and publishes it retained at d/<node>/work/<device>/<job>/<unit>, with what it
// computed it from, so anyone can check it. A unit is settled on the
// registry when `quorum` active nodes signed the same result (Settler); they
// share the pay. Results that are wrong are faults (watch.js).

import { EventEmitter } from 'events'
import { AbiCoder, keccak256, getBytes, getAddress, toUtf8Bytes, Contract, ZeroAddress, ZeroHash } from 'ethers'
import { recoverSigner } from './recover.js'
import { merkleRoot } from './merkle.js'
import { judgeMessage, leafOf, VERDICT } from './verifier.js'
import { runRule, inputsHash } from './compute.js'
import { ROLES, TEST_TOKEN, asBytes32, workStatement, settledKey, sortBySigner, batchStatement, batchKey, batchLeaf } from './registry.js'
import { keyIdOf } from 'boat-mqtt-node'

const ZERO = ZeroHash

const abi = AbiCoder.defaultAbiCoder()
export const SPEC = {
  verify: keccak256(toUtf8Bytes('boat-verify/1')),
  store: keccak256(toUtf8Bytes('boat-store/1')),
  forward: keccak256(toUtf8Bytes('boat-forward/1')),
  // a DePIN network's epochs (packages/xid-depin): a compute job whose device
  // is the network's key and whose units are its epochs. Nodes that run the
  // xid-depin plugin work on it; the plan assigns it like any compute job
  depin: keccak256(toUtf8Bytes('xid-depin/1'))
}
export const ROLE_NAME = { [ROLES.FORWARD]: 'forward', [ROLES.STORE]: 'store', [ROLES.VERIFY]: 'verify', [ROLES.COMPUTE]: 'compute' }

// ---- jobs -------------------------------------------------------------------

export const computeJob = ({ wasm, topic = 'telemetry', field, window, price }) =>
  ({ role: ROLES.COMPUTE, spec: keccak256(wasm), params: { topic, field, window, price: String(price), wasm: Buffer.from(wasm).toString('hex') } })
export const verifyJob = ({ window }) => ({ role: ROLES.VERIFY, spec: SPEC.verify, params: { window } })
export const storeJob = ({ window }) => ({ role: ROLES.STORE, spec: SPEC.store, params: { window } })
// pays the node the device's messages go through, with verifiers as witnesses
export const forwardJob = ({ window }) => ({ role: ROLES.FORWARD, spec: SPEC.forward, params: { window } })
// scores a DePIN network's epochs (xid-depin): device = the network's key
export const depinJob = ({ network, config }) => ({ role: ROLES.COMPUTE, spec: SPEC.depin, params: { window: 1, network, config } })

// approves the budget and posts the job; returns its id. perEpoch: units
// that may settle in one epoch (what a few bad nodes could take at most)
// batchUnits: settle in batches of this many units (postBatchJob, one
// transaction per batch); 0 or absent: unit by unit
export async function postJob (registry, payer, { role, device, spec, params, pay, quorum, budget, perEpoch = 1000, batchUnits = 0 }) {
  const token = new Contract(await registry.token(), TEST_TOKEN.abi, payer)
  await (await token.approve(await registry.getAddress(), budget)).wait()
  const terms = { role, quorum, perEpoch, deadline: 0, spec, pay, budget }
  const r = batchUnits
    ? await (await registry.connect(payer).postBatchJob(asBytes32(device), terms, batchUnits, toUtf8Bytes(JSON.stringify(params)))).wait()
    : await (await registry.connect(payer).postJob(asBytes32(device), terms, toUtf8Bytes(JSON.stringify(params)))).wait()
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
    batchUnits: Number(j.batchUnits), // 0: settled unit by unit
    params
  }
  const problem = jobProblem(job.role, job.spec, params)
  if (problem) throw new Error(`job ${id}: ${problem}`)
  if (job.role === ROLES.COMPUTE && job.spec !== SPEC.depin) {
    job.wasm = Buffer.from(params.wasm, 'hex')
    job.price = BigInt(params.price)
  }
  return job
}

// what is wrong with a job's terms, or null: no node works on such a job, and
// the plan gives it no node (lib/chain.js), so it holds no one's room
export function jobProblem (role, spec, params) {
  if (!params || typeof params !== 'object') return 'bad params'
  if (!Number.isInteger(params.window) || params.window < 1 || params.window > 1000) return 'bad window'
  if (role === ROLES.COMPUTE && spec === SPEC.depin) {
    if (params.window !== 1 || !addressOf(params.network) || !params.config || typeof params.config !== 'object') return 'bad DePIN params'
  } else if (role === ROLES.COMPUTE) {
    if (typeof params.wasm !== 'string' || !/^([0-9a-fA-F]{2})*$/.test(params.wasm)) return 'bad WASM'
    if (keccak256(Buffer.from(params.wasm, 'hex')) !== spec) return 'the WASM is not the one its spec names'
    try { BigInt(params.price) } catch { return 'bad price' }
  } else if (spec !== SPEC[ROLE_NAME[role]]) {
    return 'unknown spec'
  }
  return null
}

// a 32-byte hex value in one spelling (lower case), or null: a signature
// covers the bytes, not the spelling, so values are compared and keyed only
// in this form (a relay re-casing a root must not make it another statement)
export function hex32 (v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null
}

// an address in its checksum spelling, or null
export function addressOf (v) {
  try { return getAddress(v) } catch { return null }
}

// ---- units and results ------------------------------------------------------

// the unit of a sequence number: boot << 32 | (count / window)
export const unitOf = (seq, window) => ((BigInt(seq) >> 32n) << 32n) | ((BigInt(seq) & 0xffffffffn) / BigInt(window))
// the batch of a unit (batch jobs): boot << 32 | (index / batchUnits)
export const batchOf = (unit, batchUnits) => ((BigInt(unit) >> 32n) << 32n) | ((BigInt(unit) & 0xffffffffn) / BigInt(batchUnits))

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
    a = recoverSigner(workStatement(ctx, w.job, BigInt(w.unit), w.result), w.signature)
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
    const kept = this.memory && this.memory.get(String(unit))
    const before = kept && typeof kept === 'object' ? kept.result : kept
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
    // (with the signature: after a restart the Settler gets the unit back)
    if (this.memory) this.memory.set(String(unit), { result: w.result, signature: w.signature, forwarder: (detail && detail.forwarder) || null })
    this.signed.set(unit, w)
    this.signedCount++
    for (const k of this.signed.keys()) if (k + 64n < unit) this.signed.delete(k)
    for (const k of this.via.keys()) if (k + 64n < unit) this.via.delete(k)
    // at: when it was sent (not signed: for measuring how long work takes to
    // reach the other nodes)
    // d/<node>/work/<device>/<job>/<unit>: the device in the topic, so a node
    // subscribes to the work on the devices it follows, not on all of them
    await this.publish(`d/${this.nodeKey}/work/${this.job.device}/${w.job}/${w.unit}`, JSON.stringify({ ...w, at: Date.now() }), { qos: 1, retain: true })
    this.emit('signed', w)
    return w
  }
}

// ---- settling ---------------------------------------------------------------

// gas for a settleMany / settleBatchMany: per item, a base plus each
// signature's recovery and credit (a unit with 3 signers uses about 100k, a
// batch about 105k), with room to spare; the transaction's own cost on top
export function settleGasLimit (group) {
  let gas = 100000n
  for (const i of group) gas += 150000n + 30000n * BigInt(i.sigs.length)
  return gas
}

// Collects work messages (its own and other nodes') and settles units on the
// registry: once `quorum` active nodes signed the same result it waits
// settleDelayMs for more signers, then the signer with the lowest address
// submits; the others submit after a further delay if it has not.
export class Settler extends EventEmitter {
  // tx(fn): runs fn (which sends a transaction and waits for it) after the
  // node's other transactions, so they never take the same nonce
  // batchMs, batchSize: settlements go out together, every batchMs or once
  // batchSize are waiting
  // publish(topic, payload): sends this node's batch statements to the
  // job's other nodes (batch jobs; see "batches" below)
  // batchMemory(job id): { get(batch), set(batch, statement), floor } on disk:
  // the batch statements this node signed, so that it never signs another
  // for the same batch, across restarts (that would be slashable)
  // knownActive(operator, role): false for a key the node's view of the chain
  // does not know as active in the role (lib/chain.js); a batch statement by
  // it is refused without asking the chain
  constructor ({ registry, operator, ctx, jobs, settleDelayMs = 5000, backupMs = 20000, tx = (fn) => fn(), batchMs = 500, batchSize = 40, maxAgeMs = 3600000, publish = null, batchMemory = null, batchGraceMs = null, batchIdleMs = null, knownActive = null }) {
    super()
    this.knownActive = knownActive
    this.publish = publish
    this.batchMemory = batchMemory
    this.batchGraceMs = batchGraceMs ?? settleDelayMs * 6 // after a later batch begins, for the last units' signatures
    this.batchIdleMs = batchIdleMs ?? backupMs * 6 // a batch that stops growing closes after this
    this.ownResults = new Map() // job:unit -> the result this node signed (batch jobs)
    this.gaps = new Map() // job -> { at, gap }: when its last own unit came, and the usual gap
    this.batches = new Map() // job:batch -> { job, batch, units: Map(unit -> result), forwarder, mine, sigs: Map(root:units:forwarder -> Map(operator -> w)), by: Map(operator -> root:units:forwarder), timer, done, at }
    this.tx = tx
    this.registry = registry.connect(operator)
    this.operator = operator
    this.ctx = ctx
    this.jobs = jobs // id -> job
    this.settleDelayMs = settleDelayMs
    this.backupMs = backupMs
    this.units = new Map() // job:unit -> { results: Map(result -> Map(operator -> w)), timer, done }
    this.active = new Map() // operator:role -> { ok, at }
    this.stats = { settled: 0, submitted: 0, paid: 0n, quorums: 0, attempts: 0, waits: 0, errors: {}, split: 0, quorumMs: [0, 0, 0, 0, 0, 0], transitMs: [0, 0, 0, 0, 0, 0], batchesSigned: 0, batchesSettled: 0, batchUnits: 0, batchesAdopted: 0, forged: 0 }
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

  // Every work message is checked when it arrives: its signature (low s, by
  // the operator it names). With native recovery that costs about 0.08 ms, and
  // a unit's groups then hold only genuine signatures: nothing forged counts
  // towards a quorum or replaces a good signature. This node's own work comes
  // only from its own workers (own: true); anything else in its name is ignored.
  async add (w, { own = false } = {}) {
    if (!w || typeof w !== 'object') return
    if (w.kind === 'batch') return this._addBatchSig(w)
    // one spelling of each value, as the signature covers it
    const result = hex32(w.result)
    const operator = addressOf(w.operator)
    if (!result || !operator) return
    let detail = w.detail
    if (detail && typeof detail === 'object' && detail.forwarder !== undefined && detail.forwarder !== null) {
      const f = addressOf(detail.forwarder)
      if (!f) return
      if (f !== detail.forwarder) detail = { ...detail, forwarder: f }
    }
    if (result !== w.result || operator !== w.operator || detail !== w.detail) w = { ...w, result, operator, detail }
    const job = this.jobs.get(w.job)
    if (!job || w.role !== job.role) return
    if (w.operator === this.operator.address && !own) return
    if (!own && !signerOf(this.ctx, w)) {
      this.stats.forged++
      return
    }
    if (job.batchUnits && own) this._own(job, BigInt(w.unit), w.result, job.role === ROLES.FORWARD ? (w.detail && w.detail.forwarder) || null : ZeroAddress)
    // another node's work: how long it took to get here (same buckets)
    if (w.at && !own) {
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
    if (own && !u.mineAt) u.mineAt = Date.now()
    const mine = [...u.results.entries()].find(([, m]) => m.has(this.operator.address))
    if (!mine || mine[1].size < job.quorum || u.timer) return
    if (job.batchUnits) {
      // into a batch, once a quorum of nodes active in the role signed it
      if ((await this._activeCount([...mine[1].keys()], job.role)) < job.quorum || u.timer) return
      u.timer = true
      this.stats.quorums++
      return this._agreed(job, BigInt(w.unit), mine[0], null)
    }
    // only a node that signed the result settles it (it is paid for it)
    this.stats.quorums++
    // from our signature to a quorum: under 2, 5, 15, 30, 60 s, or more
    const ms = Date.now() - (u.mineAt || u.at)
    const bucket = [2000, 5000, 15000, 30000, 60000].findIndex((x) => ms < x)
    this.stats.quorumMs[bucket < 0 ? 5 : bucket]++
    u.timer = setTimeout(() => this._settle(job, k, mine[0]).catch((err) => this.emit('error', err)), this.settleDelayMs)
    u.timer.unref?.()
  }

  // how many of these operators are active in the role (cached lookups)
  async _activeCount (ops, role) {
    let n = 0
    for (const op of ops) if (await this.isActive(op, role).catch(() => false)) n++
    return n
  }

  // forgets settled units after a minute and unsettled ones after maxAgeMs
  // (by then their backups have given up). It used to keep the last 2,000
  // units whatever their state: at 4 jobs a device and a few hundred jobs a
  // node that is half a minute, shorter than a backup's wait, so units still
  // waiting to settle were dropped
  _prune () {
    const now = Date.now()
    for (const [k, c] of this.active) if (c.at && now - c.at > 60000) this.active.delete(k)
    // (unsettled ones whose retries are still running stay, up to four times
    // as long; a batch not signed yet is aged from its last unit: a slow device
    // makes batches that take longer than maxAgeMs to fill, M1 of review 3)
    for (const [k, b] of this.batches) {
      const age = now - (b.mine || b.done ? b.at : (b.last || b.at))
      if ((b.done && age > 600000) || (age > this.maxAgeMs && (b.done || !b.timer || age > this.maxAgeMs * 4))) {
        if (b.timer && b.timer !== true) clearTimeout(b.timer)
        if (b.closing) clearTimeout(b.closing)
        if (b.idle) clearTimeout(b.idle)
        this.batches.delete(k)
      }
    }
    for (const [k, u] of this.units) {
      const age = now - u.at
      if ((u.done && age > 60000) || (age > this.maxAgeMs && (u.done || !u.timer || u.timer === true || age > this.maxAgeMs * 4))) {
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
    if (job.batchUnits) {
      if (!(await this.isActive(forwarder, ROLES.FORWARD).catch(() => false))) return
      if ((await this._activeCount([...group.keys()].filter((op) => op !== forwarder), ROLES.VERIFY)) < job.quorum || u.timer) return
      u.timer = true
      this.stats.quorums++
      return this._agreed(job, BigInt(w.unit), w.result, forwarder)
    }
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
        const u = i.kind === 'batch' ? i.b : this.units.get(i.k)
        return !seen.has(i.k) && seen.add(i.k) && !u?.done && !u?.sending
      })
      for (const group of [items.filter((i) => !i.forward && i.kind !== 'batch'), items.filter((i) => i.forward), items.filter((i) => i.kind === 'batch')]) {
        if (group.length === 0) continue
        for (const i of group) { const u = i.kind === 'batch' ? i.b : this.units.get(i.k); if (u) u.sending = true }
        let tx = null
        try {
          tx = await this.tx(async () => {
            // the gas limit is set, not estimated: settleMany and
            // settleBatchMany try each item and skip one that fails, so an
            // estimate finds the least gas at which the transaction succeeds,
            // which is too little for the items (they run out of gas, are
            // skipped, and the transaction settles nothing). Only the gas used
            // is paid
            const gasLimit = settleGasLimit(group)
            const tx = group[0].kind === 'batch'
              ? await this.registry.settleBatchMany(group.map((i) => ({ id: i.job.id, batch: i.batch, root: i.root, units: i.units, forwarder: i.forwarder, sigs: i.sigs })), { gasLimit })
              : await this.registry.settleMany(group.map((i) => (i.forward
                ? { id: i.job.id, unit: i.unit, result: i.root, forwarder: i.forwarder, sigs: i.sigs }
                : { id: i.job.id, unit: i.unit, result: i.result, forwarder: ZeroAddress, sigs: i.sigs })), { gasLimit })
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
    if (group[0] && group[0].kind === 'batch') return this._confirmBatches(group, tx)
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

  async _confirmBatches (group, tx) {
    let r = null
    if (tx) {
      try { r = await tx.wait() } catch (err) { this._error(err) }
    }
    const done = new Set()
    for (const log of r ? r.logs : []) {
      let e = null
      try { e = this.registry.interface.parseLog(log) } catch {}
      if (e && e.name === 'BatchSettled') done.add(e.args.id + ':' + e.args.batch)
    }
    for (const i of group) {
      const b = i.b
      b.sending = false
      if (b.done) continue
      if (done.has(i.job.id + ':' + i.batch)) {
        this.stats.submitted++
        this._batchDone(b, 'us', { signers: i.signers, gas: r.gasUsed / BigInt(done.size), tx: r.hash, inTx: group.length })
        continue
      }
      if ((await this.registry.settled(batchKey(i.job.id, i.batch)).catch(() => ZERO)) !== ZERO) this._batchDone(b, 'another node')
      else if (i.attempt < 12) {
        // not settled (the job's rate this epoch, say): again later, every 10 minutes at most
        b.timer = setTimeout(() => this._settleBatch(b, true, i.attempt + 1).catch((e) => this.emit('error', e)), Math.min(this.backupMs * 2 ** i.attempt, 600000))
        b.timer.unref?.()
      }
    }
  }

  // ---- batches ------------------------------------------------------------------
  //
  // A batch job's units are not settled one by one. A unit that a quorum of
  // active nodes agreed on, this node among them, goes into its batch
  // (batchOf). The batch closes when it is full (after a short grace), when
  // this node signs a unit of a later batch (after a longer one, for late
  // signatures), or when it has not grown for batchIdleMs. Then this node signs
  // ONE statement for it, and never another: the statement is on disk
  // (batchMemory) before it is published, and after a restart the same one is
  // sent again. Before signing it picks, among its own set of agreed units and
  // the statements of other nodes whose every unit it signed itself with the
  // same result, the one with the most units: so nodes that saw a unit late
  // still sign the same root. When `quorum` nodes signed one statement (and the
  // forwarder, for a forward job), the first by rank submits it, the others
  // after a delay. Signing two statements for one batch is slashable
  // (slashDoubleBatch).

  _batch (job, batch) {
    const k = job.id + ':' + batch
    let b = this.batches.get(k)
    if (!b) this.batches.set(k, (b = { job, batch, units: new Map(), forwarder: null, mine: null, sigs: new Map(), by: new Map(), peers: new Map(), timer: null, closing: null, closingDelay: Infinity, idle: null, tried: false, done: false, at: Date.now() }))
    return b
  }

  // a unit this node signed: it may sign the batch (and batches before it are over)
  _own (job, unit, result, forwarder) {
    this.ownResults.set(job.id + ':' + unit, { result, forwarder })
    // how often the job's units come (a device's readings may be minutes
    // apart): a batch waits three gaps before it counts as idle
    const t = Date.now()
    const g = this.gaps.get(job.id)
    if (g && t > g.at) g.gap = g.gap ? Math.round(g.gap * 0.7 + (t - g.at) * 0.3) : t - g.at
    this.gaps.set(job.id, { at: t, gap: g ? g.gap : 0 })
    if (this.gaps.size > 50000) this.gaps.delete(this.gaps.keys().next().value)
    if (this.ownResults.size > 50000) this.ownResults.delete(this.ownResults.keys().next().value)
    const now = batchOf(unit, job.batchUnits)
    const b = this._batch(job, now)
    b.last = Date.now()
    this._idle(b)
    for (const o of this.batches.values()) {
      if (o.job.id === job.id && !o.mine && !o.done && BigInt(o.batch) < now) this._close(o, this.batchGraceMs)
    }
  }

  // a unit agreed by a quorum of active nodes that includes this node
  _agreed (job, unit, result, forwarder) {
    const b = this._batch(job, batchOf(unit, job.batchUnits))
    if (b.mine || b.done) return // signed already: a late unit stays out
    if (forwarder) {
      if (b.forwarder && b.forwarder !== forwarder) return // the device moved mid-batch: units through another node stay out
      b.forwarder = forwarder
    }
    b.units.set(String(unit), result)
    b.last = Date.now()
    if (b.units.size >= job.batchUnits) this._close(b, this.settleDelayMs * 2)
    else this._idle(b)
  }

  _idle (b) {
    if (b.mine || b.done) return
    if (b.idle) clearTimeout(b.idle)
    const g = this.gaps.get(b.job.id)
    // (before the gap is known, ten times batchIdleMs: the first batch after a
    // start would otherwise close with one unit when units are minutes apart)
    b.idle = setTimeout(() => this._close(b, 0), g && g.gap ? Math.max(this.batchIdleMs, g.gap * 3) : this.batchIdleMs * 10)
    b.idle.unref?.()
  }

  // sign after `delay`, or sooner if already due sooner
  _close (b, delay) {
    if (b.mine || b.done || delay >= b.closingDelay) return
    if (b.closing) clearTimeout(b.closing)
    b.closingDelay = delay
    b.closing = setTimeout(() => this._signBatch(b).catch((e) => this.emit('error', e)), delay)
    b.closing.unref?.()
  }

  // a statement another node signed that this node may sign too: every unit in
  // it is one of the batch's, signed by this node with the same result (and
  // through the same forwarder)
  _adoptable (b, p) {
    if (b.job.role === ROLES.FORWARD ? !p.forwarder || p.forwarder === ZeroAddress : p.forwarder !== ZeroAddress) return false
    const lo = BigInt(b.batch & 0xffffffffn) * BigInt(b.job.batchUnits)
    const boot = BigInt(b.batch) >> 32n
    let last = -1n
    for (const [u, r] of p.leaves) {
      const unit = BigInt(u)
      if (unit >> 32n !== boot || (unit & 0xffffffffn) < lo || (unit & 0xffffffffn) >= lo + BigInt(b.job.batchUnits) || unit <= last) return false
      last = unit
      // the same result, and for a forward job the same forwarder: the one the
      // statement pays is the one this node witnessed for every unit
      const o = this.ownResults.get(b.job.id + ':' + unit)
      if (!o || o.result !== r || o.forwarder !== p.forwarder) return false
    }
    return true
  }

  // One run at a time per batch: a statement that arrives while this node is
  // signing (it waits on the chain and on its key) asks for another run after
  // it (b.again) instead of starting one beside it, which could sign a second,
  // different statement: slashable
  async _signBatch (b) {
    if (b.mine || b.done) return
    if (b.signing) { b.again = true; return }
    b.signing = true
    b.tried = true
    try {
      await this._signBatchOnce(b)
    } finally {
      b.signing = false
    }
    if (b.again && !b.mine && !b.done) {
      b.again = false
      return this._signBatch(b)
    }
  }

  async _signBatchOnce (b) {
    const job = b.job
    const mem = this.batchMemory ? this.batchMemory(job.id) : null
    if (mem && mem.broken) { this.stats.memoryBroken = (this.stats.memoryBroken || 0) + 1; return }
    const before = mem && mem.get(String(b.batch))
    if (before) {
      // signed before this run: the same statement again, never another
      b.mine = before
      this._addBatchSig(before.message, true)
      if (this.publish) await this.publish(this._batchTopic(b), JSON.stringify(before.message)).catch(() => {})
      return
    }
    if (mem && mem.floor !== null && BigInt(b.batch) < BigInt(mem.floor)) return // older than what is remembered: never sign it
    if ((await this.registry.settled(batchKey(job.id, b.batch)).catch(() => ZERO)) !== ZERO) return this._batchDone(b, 'another node')
    if (b.mine || b.done || (mem && mem.get(String(b.batch)))) return
    // the candidates: this node's own set, and others' statements it can sign;
    // the most units wins, then the lowest root, so nodes converge on one
    const cands = []
    const own = [...b.units.entries()].sort((x, y) => (BigInt(x[0]) < BigInt(y[0]) ? -1 : 1))
    if (own.length && (job.role !== ROLES.FORWARD || b.forwarder)) cands.push({ leaves: own, forwarder: job.role === ROLES.FORWARD ? b.forwarder : ZeroAddress, adopted: false })
    for (const p of b.peers.values()) if (this._adoptable(b, p)) cands.push({ leaves: p.leaves, forwarder: p.forwarder, adopted: true })
    for (const c of cands) {
      c.leaves = c.leaves.map(([u, r]) => [String(u), r])
      c.root = merkleRoot(c.leaves.map(([u, r]) => batchLeaf(u, r)))
    }
    cands.sort((x, y) => (y.leaves.length - x.leaves.length) || (x.root < y.root ? -1 : x.root > y.root ? 1 : 0))
    const pick = cands[0]
    if (!pick) return
    const leaves = pick.leaves
    const root = pick.root
    const units = leaves.length
    const forwarder = pick.forwarder
    const signature = await this.operator.signMessage(getBytes(batchStatement(this.ctx, job.id, b.batch, root, units, forwarder)))
    if (b.mine || b.done || (mem && mem.get(String(b.batch)))) return // (cannot happen with the lock; never sign twice)
    const message = { v: 1, kind: 'batch', job: job.id, batch: String(b.batch), root, units, forwarder, operator: this.operator.address, signature, leaves }
    b.mine = { root, units, forwarder, signature, message }
    if (mem) mem.set(String(b.batch), b.mine) // on disk before anyone sees it
    if (b.idle) clearTimeout(b.idle)
    this.stats.batchesSigned++
    if (pick.adopted) this.stats.batchesAdopted++
    this._addBatchSig(message, true)
    if (this.publish) await this.publish(this._batchTopic(b), JSON.stringify(message)).catch(() => {})
  }

  // a job with batches not settled yet: its statements still matter here,
  // even after the node stopped working on it (the plan moved it)
  hasOpenBatches (jobId) {
    for (const b of this.batches.values()) if (b.job.id === jobId && !b.done) return true
    return false
  }

  _batchTopic (b) {
    return `d/${this.ctx.nodeKey}/work/${b.job.device}/${b.job.id}/b${b.batch}`
  }

  // a batch statement, this node's (trusted) or another's: its signature is
  // checked here, and only batches this node took part in are kept. Another
  // node's counts only when it is active in the role it signs in (the job's,
  // or for a forward job VERIFY, FORWARD for the forwarder), and each node
  // gets one statement a batch: a second, different one is evidence of a
  // double batch (slashDoubleBatch), not another view. So the statements a
  // batch keeps are bounded by the nodes that staked for the role, and no key
  // can crowd the honest ones out
  async _addBatchSig (w, trusted = false) {
    const job = this.jobs.get(w.job)
    if (!job || !job.batchUnits || !Number.isInteger(w.units) || w.units < 1 || w.units > job.batchUnits || typeof w.signature !== 'string') return
    // one spelling of each value (H1, review 3): the root in lower case, the
    // addresses checksummed; anything else is not a statement
    const root = hex32(w.root)
    const operator = addressOf(w.operator)
    if (!root || !operator) return
    let batch
    try { batch = BigInt(w.batch) } catch { return }
    if (batch < 0n || batch >= 2n ** 64n) return
    let forwarder = ZeroAddress
    if (job.role === ROLES.FORWARD) {
      forwarder = addressOf(w.forwarder)
      if (!forwarder || forwarder === ZeroAddress) return
    } else if (w.forwarder && addressOf(w.forwarder) !== ZeroAddress) {
      return
    }
    if (root !== w.root || operator !== w.operator || (job.role === ROLES.FORWARD && forwarder !== w.forwarder)) w = { ...w, root, operator, forwarder }
    let b = this.batches.get(job.id + ':' + batch)
    if (!b || b.done) return // a batch this node has no part in
    const g = root + ':' + w.units + ':' + forwarder
    if (!trusted) {
      if (w.operator === this.operator.address) return // this node's statements come from this node
      const had = b.by.get(w.operator)
      if (had === g) return // seen it
      if (recoverSigner(batchStatement(this.ctx, job.id, batch, w.root, w.units, forwarder), w.signature) !== w.operator) {
        this.stats.forged++
        return
      }
      if (had) {
        // a second statement by the same node for the same batch
        this.stats.doubleBatches = (this.stats.doubleBatches || 0) + 1
        this.emit('double-batch', { job: job.id, batch, operator: w.operator, a: b.sigs.get(had).get(w.operator), b: w })
        return
      }
      const role = job.role !== ROLES.FORWARD ? job.role : w.operator === forwarder ? ROLES.FORWARD : ROLES.VERIFY
      // a key the plan's view of the chain does not know is refused without
      // asking the chain (L4: no RPC call, and no cache entry, per stranger)
      if ((this.knownActive && !this.knownActive(w.operator, role)) || !(await this.isActive(w.operator, role).catch(() => false))) {
        this.stats.inactiveBatches = (this.stats.inactiveBatches || 0) + 1
        return
      }
      b = this.batches.get(job.id + ':' + batch)
      if (!b || b.done) return // (changed while we looked)
      const now = b.by.get(w.operator)
      if (now === g) return
      if (now) {
        // its other statement came in while we looked (L1): still evidence
        this.stats.doubleBatches = (this.stats.doubleBatches || 0) + 1
        this.emit('double-batch', { job: job.id, batch, operator: w.operator, a: b.sigs.get(now).get(w.operator), b: w })
        return
      }
    }
    b.by.set(w.operator, g)
    if (!b.sigs.has(g)) b.sigs.set(g, new Map())
    b.sigs.get(g).set(w.operator, w)
    // its leaves: a statement this node may adopt (they must make its root)
    if (!trusted && !b.peers.has(g) && Array.isArray(w.leaves) && w.leaves.length === w.units) {
      let root = null
      try { root = merkleRoot(w.leaves.map(([u, r]) => batchLeaf(u, r))) } catch {}
      if (root === w.root) b.peers.set(g, { leaves: w.leaves, forwarder })
      if (b.tried && !b.mine) this._signBatch(b).catch((e) => this.emit('error', e)) // closed with nothing to sign: maybe this
    }
    this._checkBatch(b)
  }

  _checkBatch (b) {
    if (b.done || !b.mine || b.timer) return
    const group = b.sigs.get(b.mine.root + ':' + b.mine.units + ':' + b.mine.forwarder)
    if (!group) return
    const job = b.job
    const enough = job.role === ROLES.FORWARD ? group.has(b.mine.forwarder) && group.size - 1 >= job.quorum : group.size >= job.quorum
    if (!enough) return
    b.timer = setTimeout(() => this._settleBatch(b).catch((e) => this.emit('error', e)), this.settleDelayMs)
    b.timer.unref?.()
  }

  async _settleBatch (b, backup = false, attempt = 0) {
    if (b.done) return
    const job = b.job
    const fwd = b.mine.forwarder
    const group = b.sigs.get(b.mine.root + ':' + b.mine.units + ':' + fwd)
    const rank = (op) => keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'uint64', 'address'], [job.id, b.batch, op]))
    const first = job.role === ROLES.FORWARD ? fwd : [...group.keys()].map((op) => [rank(op), op]).sort((x, y) => (x[0] < y[0] ? -1 : 1))[0][1]
    if (!backup && first !== this.operator.address) {
      this.stats.waits++
      b.timer = setTimeout(() => this._settleBatch(b, true).catch((e) => this.emit('error', e)), this.backupMs + Math.floor(Math.random() * 5000))
      b.timer.unref?.()
      return
    }
    if (backup && (await this.registry.settled(batchKey(job.id, b.batch))) !== ZERO) return this._batchDone(b, 'another node')
    // (signatures were checked as they came in)
    const signers = []
    for (const w of sortBySigner([...group.values()])) {
      const role = job.role !== ROLES.FORWARD ? job.role : w.operator === fwd ? ROLES.FORWARD : ROLES.VERIFY
      if (await this.isActive(w.operator, role).catch(() => false)) signers.push(w)
    }
    const enough = job.role === ROLES.FORWARD ? signers.some((w) => w.operator === fwd) && signers.length - 1 >= job.quorum : signers.length >= job.quorum
    if (!enough) {
      if (attempt < 8) {
        b.timer = setTimeout(() => this._settleBatch(b, backup, attempt + 1).catch((e) => this.emit('error', e)), this.backupMs)
        b.timer.unref?.()
      }
      return
    }
    this.stats.attempts++
    this.queue.push({ kind: 'batch', k: 'b:' + job.id + ':' + b.batch, b, job, batch: b.batch, root: b.mine.root, units: b.mine.units, forwarder: fwd, sigs: signers.map((w) => w.signature), signers: signers.length, attempt })
    if (this.queue.length >= this.batchSize) this._flush().catch((e) => this.emit('error', e))
  }

  _batchDone (b, by, extra = {}) {
    b.done = true
    if (b.timer && b.timer !== true) clearTimeout(b.timer)
    if (b.idle) clearTimeout(b.idle)
    if (b.closing) clearTimeout(b.closing)
    this.stats.batchesSettled++
    this.stats.batchUnits += b.mine ? b.mine.units : 0
    this.stats.settled += b.mine ? b.mine.units : 0
    this.emit('settled', { kind: 'batch', job: b.job.id, batch: b.batch, units: b.mine ? b.mine.units : 0, by, ...extra })
  }

  close () {
    clearInterval(this._flushTimer)
    clearInterval(this._pruneTimer)
  }
}
