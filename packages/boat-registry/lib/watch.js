// The watchtower, run by verifier nodes: re-checks the work other nodes sign
// and slashes faults on the registry without anyone stepping in.
//
// Faults it finds itself:
//   double-work    two different results signed for one unit: slashed at
//                  once with slashDoubleWork (the contract checks it)
//   inconsistent   a signed result that is not what the message's own detail
//                  gives
//   wrong-value    a compute result the rule does not give on its inputs
//   wrong-input    an input, leaf or verdict that disagrees with a message
//                  the device signed (the evidence carries that message)
//   store-failed   a store that signed it holds a device's messages and then
//                  fails a spot check of its Hypercore; each unit a store
//                  signs is checked by `spotters` verifiers (2), the ones
//                  that rank first by keccak(verifier, store, job, unit), so
//                  the work spreads over the verifiers and anyone can tell
//                  whose turn it was
//   unassigned     a node whose signature settled a unit of a job it was not
//                  assigned to (lib/audit.js): read from the chain, so the
//                  evidence is the settlement's transaction
//
// A fault is published at d/<node>/faults/<reason> with the judge's signature
// on the slash (slashStatementOf, BoatRegistry._slashStatement) and the evidence. Every other
// verifier that sees it judges it again from the evidence (or, for a store,
// its own spot check) and adds its signature when it agrees. Once enough
// verifiers signed (the contract's quorum), the one with the lowest address
// submits slash(); the others do after a delay if it has not.

import { EventEmitter } from 'events'
import { AbiCoder, keccak256, getBytes } from 'ethers'
import { recoverSigner } from './recover.js'
import { open, spotCheck } from 'boat-mqtt-node'
import { ROLES, slashStatementOf, sortBySigner } from './registry.js'
import { judgeMessage, VERDICT } from './verifier.js'
import { runRule } from './compute.js'
import { resultOf, signerOf, unitOf, SPEC } from './work.js'
import { keyIdOf } from 'boat-mqtt-node'

const abi = AbiCoder.defaultAbiCoder()
export const FAULT_BPS = 2000 // a fault costs this share of the minimum stake

export const faultReason = (kind, operator, job, unit) =>
  keccak256(abi.encode(['string', 'string', 'address', 'uint256', 'uint64'], ['boat-fault/1', kind, operator, job, BigInt(unit)]))

// a store that answered and could not show what it signed for; one that
// does not answer at all may only be offline, which is not judged here
const refused = (r) => !r.ok && (!r.error || /^(store|head):/.test(r.error))

function own (b) {
  const c = Buffer.allocUnsafeSlow(b.length)
  b.copy(c)
  return c
}

export class Watchtower extends EventEmitter {
  // watchers: verifiers per device (the first by keccak(verifier, device))
  // that judge the work of its jobs and spot-check their stores; jobOf(id): a job this node does
  // not watch (to judge a fault another verifier sends); send(fault): to every
  // verifier, not only those at the device's home node
  constructor ({ dht, registry, operator, ctx, jobs, publish, minStake, submitBackupMs = 20000, spotters = 2, spotEvery = 10, watchers = 3, spotDelayMs = 5000, tx = (fn) => fn(), jobOf = null, send = null, audit = null }) {
    super()
    this.tx = tx
    this.dht = dht
    this.registry = registry.connect(operator)
    this.operator = operator
    this.ctx = ctx
    this.jobs = jobs
    this.publish = publish
    this.amount = (minStake * BigInt(FAULT_BPS)) / 10000n
    this.submitBackupMs = submitBackupMs
    this.spotters = spotters
    this.spotEvery = spotEvery
    this.watchers = watchers
    this.jobOf = jobOf
    this.send = send
    this.audit = audit // lib/audit.js: who settled what, and who was assigned
    this.keyring = null // set by the node: sealed readings it may read
    this._watchers = new Map() // device -> { key (the verifiers), list }
    this._verifiers = { at: 0, list: [] }
    this.spotDelayMs = spotDelayMs
    this.messages = new Map() // device -> Map(seq:topic -> payload): the device's own signed messages
    this.seen = new Map() // operator:job:unit -> work message (double work)
    this.faults = new Map() // reason -> { fault, sigs: Map(judge -> sig), done, timer }
    this.spots = new Map() // store key:device -> units since the last spot check
    this.stats = { checked: 0, faults: 0, agreed: 0, slashed: 0, spotChecks: 0 }
  }

  // a message a device published
  device (device, topic, payload) {
    const m = open(Buffer.from(device, 'hex'), topic, payload)
    if (!m) return
    if (!this.messages.has(device)) this.messages.set(device, new Map())
    const d = this.messages.get(device)
    const k = m.seq + ':' + topic
    // a copy of its own: the payload is a slice of the chunk it arrived in,
    // and Buffer.from would put the copy in the shared 8 KB pool; either way
    // one kept message keeps the whole chunk or slab alive (a day's run grew
    // 250, then 130 MB an hour)
    if (!d.has(k)) d.set(k, own(payload))
    if (d.size > 1000) d.delete(d.keys().next().value)
  }

  // something another node published (work, faults)
  async peer (from, topic, payload) {
    const parts = topic.split('/')
    let msg
    try { msg = JSON.parse(payload.toString()) } catch { return }
    if (parts[2] === 'work') await this.work(msg)
    else if (parts[2] === 'faults') await this.fault(msg)
  }

  // A job's watchers judge its work (signatures are checked only then, or
  // when two results for one unit show up: cheap to see, costly to verify
  // for every message).
  async work (w) {
    const job = this.jobs.get(w.job)
    if (!job || w.role !== job.role || w.device !== job.device) return
    // two results for one unit
    const k = w.operator + ':' + w.job + ':' + w.unit
    const before = this.seen.get(k)
    // what two results for one unit are told and proven by, and no more: the
    // whole message, with every leaf of its unit, 20,000 times over, was most
    // of what a busy verifier's memory grew by
    const slim = { job: w.job, unit: w.unit, operator: w.operator, result: w.result, signature: w.signature }
    if (before && before.result !== w.result) {
      if (signerOf(this.ctx, before) && signerOf(this.ctx, w)) return this._doubleWork(before, w)
      if (!signerOf(this.ctx, before)) this.seen.set(k, slim) // keep the genuine one
      return
    }
    if (!before) this.seen.set(k, slim)
    if (this.seen.size > 20000) this.seen.delete(this.seen.keys().next().value)
    if (w.operator === this.operator.address) return
    // a DePIN epoch: its result is the root of a score anyone can run again
    // from the oracles' published sheets (xid-depin audit), not a rule run
    // on one window, so the judgements below do not apply. (Two results for
    // one epoch, above, still do.)
    if (job.spec === SPEC.depin) return
    const watchers = await this.watchersOf(job.device)
    if (!watchers.includes(this.operator.address)) return
    this.stats.checked++
    // the signature is checked only for work that is wrong (a forged message
    // must not get anyone slashed) or about to be spot-checked: checking every
    // message's took most of a busy node's time
    const why = this.judge(job, w)
    if (why) return signerOf(this.ctx, w) ? this._raise(why.kind, w, why.evidence) : undefined
    // a store's unit: one in spotEvery is checked (keccak(job, unit, store)
    // picks which: anyone can tell, a store cannot know ahead), by
    // `spotters` of the watchers, by keccak(watcher, unit)
    const picked = BigInt(keccak256(abi.encode(['uint256', 'uint64', 'address'], [w.job, BigInt(w.unit), w.operator]))) % BigInt(this.spotEvery) === 0n
    if (job.role === ROLES.STORE && w.detail.store && picked) {
      const score = (v) => keccak256(abi.encode(['address', 'uint256', 'uint64'], [v, w.job, BigInt(w.unit)]))
      const turn = watchers.filter((v) => v !== w.operator).map((v) => [score(v), v]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, this.spotters).map(([, v]) => v)
      if (turn.includes(this.operator.address) && signerOf(this.ctx, w)) await this._spotCheck(job, w)
    }
  }

  // a device with no job left here: what was kept for it goes
  forget (device) {
    this.messages.delete(device)
    this._watchers.delete(device)
  }

  // the verifiers that watch a device's jobs: the first `watchers` by
  // keccak(verifier, device), the same few for every job on the device
  async watchersOf (device) {
    const c = this._watchers.get(device)
    const verifiers = await this.verifiers()
    // the same verifiers as last time (each refresh of the list made a new
    // one, so every device's watchers were worked out again)
    const key = verifiers.join(',')
    if (c && c.key === key) return c.list
    const score = (v) => keccak256(abi.encode(['address', 'string', 'bytes32'], [v, 'watch', '0x' + device]))
    const list = verifiers.map((v) => [score(v), v]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, this.watchers).map(([, v]) => v)
    this._watchers.set(device, { key, list })
    return list
  }

  // the first n active verifiers (not `exclude`) by keccak(verifier, ...salt)
  async ranked (exclude, salt, n) {
    const score = (v) => keccak256(abi.encode(['address', 'string', 'uint256', 'uint64'], [v, salt[0], salt[1], BigInt(salt[2])]))
    return (await this.verifiers()).filter((v) => v !== exclude).map((v) => [score(v), v]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([, v]) => v)
  }

  // what is wrong with a work message, judged from it and the device's
  // messages we hold: { kind, evidence } or null
  judge (job, w, held = this.messages.get(job.device)) {
    let mine
    try { mine = resultOf(job.role, w.detail) } catch { return { kind: 'inconsistent' } }
    if (mine !== w.result) return { kind: 'inconsistent' }
    if (job.role === ROLES.COMPUTE) {
      const units = new Set(w.detail.inputs.map(([s]) => String(unitOf(s, job.params.window))))
      if (units.size !== 1 || !units.has(w.unit)) return { kind: 'inconsistent' }
      const value = String(runRule(job.wasm, w.detail.inputs.map(([, v]) => v), job.price))
      if (value !== w.detail.value) return { kind: 'wrong-value' }
      for (const [seq, v] of w.detail.inputs) {
        const p = held && held.get(seq + ':d/' + job.device + '/' + job.params.topic)
        if (!p) continue
        let real
        let body = p.subarray(74)
        if (keyIdOf(body) !== null) body = this.keyring ? this.keyring.open(job.device, 'd/' + job.device + '/' + job.params.topic, body) : null
        if (!body) continue // sealed, and not for us: the other watchers judge it
        try { real = JSON.parse(body.toString())[job.params.field] } catch {}
        if (String(real) !== v) return { kind: 'wrong-input', evidence: { topic: 'd/' + job.device + '/' + job.params.topic, message: p.toString('base64') } }
      }
      return null
    }
    for (const leaf of w.detail.leaves) {
      if (leaf.device !== job.device || String(unitOf(leaf.seq, job.params.window)) !== w.unit) return { kind: 'inconsistent' }
      const p = held && held.get(leaf.seq + ':' + leaf.topic)
      if (!p) continue
      const evidence = { topic: leaf.topic, message: p.toString('base64') }
      if (keccak256(p) !== leaf.payloadHash) return { kind: 'wrong-input', evidence }
      if (job.role === ROLES.VERIFY) {
        const v = judgeMessage(job.device, leaf.topic, p)
        if ((v.verdict & ~VERDICT.REPLAY) !== leaf.verdict) return { kind: 'wrong-input', evidence }
      }
    }
    return null
  }

  // signers of a settlement that were not assigned to its job (Auditor.scan)
  async unassigned (found) {
    for (const s of found) {
      await this._raise('unassigned', { job: s.job, unit: s.unit, operator: s.operator }, { tx: s.tx })
    }
  }

  // judges a fault from its evidence alone (and a spot check of our own)
  async rejudge (f) {
    if (f.kind === 'unassigned') {
      // from the chain: the transaction settled the unit with the node's
      // signature, and our plans of that time did not have it on the job
      const w = f.work
      if (!this.audit || w.operator !== f.operator || !Number.isSafeInteger(w.job) || !/^\d{1,20}$/.test(String(w.unit))) return false
      if (!f.evidence || !/^0x[0-9a-f]{64}$/.test(f.evidence.tx || '')) return false
      const s = await this.audit.settlementOf(f.evidence.tx, w.job, String(w.unit)).catch(() => null)
      if (!s || !s.signers || !s.signers.includes(f.operator)) return false
      return (await this.audit.assignedAt(w.job, f.operator, s.block)) === false
    }
    const job = this.jobs.get(f.work.job) || (this.jobOf ? await this.jobOf(f.work.job).catch(() => null) : null)
    if (!job || !signerOf(this.ctx, f.work) || f.work.operator !== f.operator) return false
    if (f.kind === 'store-failed') {
      if (job.role !== ROLES.STORE || !f.work.detail.store) return false
      return refused(await this._spot(f.work.detail.store, job.device))
    }
    const held = new Map()
    if (f.evidence) {
      const p = Buffer.from(f.evidence.message, 'base64')
      const m = open(Buffer.from(job.device, 'hex'), f.evidence.topic, p)
      if (!m) return false // not the device's own word
      held.set(m.seq + ':' + f.evidence.topic, p)
    }
    const why = this.judge(job, f.work, held)
    return !!why && why.kind === f.kind
  }

  // the active verifiers, from the registry (looked up again every 5 minutes)
  async verifiers () {
    if (Date.now() - this._verifiers.at < 300000) return this._verifiers.list
    // one lookup at a time, however many messages ask
    if (!this._verifiersLoading) {
      this._verifiersLoading = (async () => {
        const n = Number(await this.registry.verifierCount())
        const list = []
        for (let i = 0; i < n; i++) list.push(await this.registry.verifiers(i))
        this._verifiers = { at: Date.now(), list }
        return list
      })().finally(() => { this._verifiersLoading = null })
    }
    return this._verifiersLoading
  }

  async _spotCheck (job, w) {
    this.stats.spotChecks++
    // after a moment: the store appends before it signs, but give it time
    setTimeout(async () => {
      const r = await this._spot(w.detail.store, job.device)
      this.emit('spot-check', { store: w.detail.store, operator: w.operator, device: job.device, ...r })
      if (refused(r)) await this._raise('store-failed', w, null)
    }, this.spotDelayMs).unref?.()
  }

  _spot (store, device) {
    return spotCheck(this.dht, Buffer.from(store, 'hex'), device, { samples: 4 }).catch((err) => ({ ok: false, error: err.message }))
  }

  async _doubleWork (a, b) {
    const reason = keccak256(abi.encode(['string', 'uint256', 'uint64'], ['double work', a.job, BigInt(a.unit)]))
    const k = 'double:' + a.operator + ':' + reason
    if (this.faults.has(k)) return
    this.faults.set(k, { done: true })
    this.stats.faults++
    this.emit('fault', { kind: 'double-work', operator: a.operator, job: a.job, unit: a.unit })
    try {
      const r = await this.tx(async () => (await this.registry.slashDoubleWork(a.operator, a.job, BigInt(a.unit), a.result, a.signature, b.result, b.signature)).wait())
      this.stats.slashed++
      this.emit('slashed', { kind: 'double-work', operator: a.operator, tx: r.hash })
    } catch (err) {
      if (!/already slashed|nothing to slash/.test(err.shortMessage || err.message)) this.emit('error', err)
    }
  }

  async _sign (f) {
    const h = slashStatementOf(this.ctx, f.operator, BigInt(f.amount), f.reason, 0n)
    return this.operator.signMessage(getBytes(h))
  }

  async _raise (kind, w, evidence) {
    const reason = faultReason(kind, w.operator, w.job, w.unit)
    if (this.faults.has(reason)) return
    const f = { v: 1, kind, operator: w.operator, job: w.job, unit: w.unit, amount: String(this.amount), reason, work: w, evidence: evidence || null }
    this.faults.set(reason, { fault: f, sigs: new Map(), done: false })
    this._trimFaults()
    this.stats.faults++
    this.emit('fault', { kind, operator: w.operator, job: w.job, unit: w.unit })
    await this._agree(f)
  }

  async _agree (f) {
    const entry = this.faults.get(f.reason)
    const signature = await this._sign(f)
    entry.sigs.set(this.operator.address, signature)
    const msg = { ...f, judge: this.operator.address, signature }
    await this.publish(`d/${this.ctx.nodeKey}/faults/${f.reason.slice(2)}`, JSON.stringify(msg), { qos: 1, retain: true }).catch(() => {})
    if (this.send) this.send(msg)
    await this._maybeSubmit(f.reason)
  }

  // a fault another verifier published
  async fault (msg) {
    if (!msg || !msg.reason || !msg.work || msg.judge === this.operator.address) return
    if (msg.reason !== faultReason(msg.kind, msg.operator, msg.work.job, msg.work.unit) || msg.amount !== String(this.amount)) return
    let judge
    judge = recoverSigner(slashStatementOf(this.ctx, msg.operator, BigInt(msg.amount), msg.reason, 0n), msg.signature)
    if (!judge) return
    if (judge !== msg.judge || judge === msg.operator) return
    let entry = this.faults.get(msg.reason)
    if (!entry) {
      if (!(await this.rejudge(msg))) {
        this.emit('disagree', { kind: msg.kind, operator: msg.operator, judge })
        return
      }
      const { judge: _j, signature: _s, ...f } = msg
      entry = { fault: f, sigs: new Map(), done: false }
      this.faults.set(msg.reason, entry)
      this._trimFaults()
      entry.sigs.set(judge, msg.signature)
      this.stats.agreed++
      this.emit('agree', { kind: msg.kind, operator: msg.operator, judge })
      await this._agree(f)
      return
    }
    entry.sigs.set(judge, msg.signature)
    await this._maybeSubmit(msg.reason)
  }

  // faults are kept so that one is raised and submitted once; the oldest
  // that are done go (seen again, the registry says they were used)
  _trimFaults () {
    if (this.faults.size <= 5000) return
    for (const [k, e] of this.faults) {
      if (this.faults.size <= 4000) break
      if (e.done) this.faults.delete(k)
    }
  }

  async _maybeSubmit (reason, backup = false, attempt = 0) {
    const entry = this.faults.get(reason)
    if (!entry || entry.done) return
    const f = entry.fault
    const valid = []
    for (const [address, signature] of entry.sigs) if (address !== f.operator) valid.push({ address, signature })
    if (valid.length < 2) return
    const sorted = sortBySigner(valid)
    const h = slashStatementOf(this.ctx, f.operator, BigInt(f.amount), f.reason, 0n)
    if (await this.registry.slashUsed(h)) {
      entry.done = true
      return
    }
    // the contract weighs the signers by stake: ask it whether they are enough
    const sigs = sorted.map((s) => s.signature)
    try {
      await this.registry.slash.staticCall(f.operator, BigInt(f.amount), f.reason, 0n, sigs)
    } catch (err) {
      const why = err.reason || err.shortMessage || err.message
      if (/no quorum/.test(why)) {
        // more signatures may come, and verifiers count once they have been one for an epoch
        if (!entry.retry && attempt < 10) {
          entry.retry = setTimeout(() => { entry.retry = null; this._maybeSubmit(reason, backup, attempt + 1).catch((e) => this.emit('error', e)) }, this.submitBackupMs * 2 ** Math.min(attempt, 5))
          entry.retry.unref?.()
        }
        return
      }
      if (/already slashed|nothing to slash/.test(why)) {
        entry.done = true
        return
      }
      throw err
    }
    if (!backup && sorted[0].address !== this.operator.address) {
      if (!entry.timer) {
        entry.timer = setTimeout(() => this._maybeSubmit(reason, true).catch((err) => this.emit('error', err)), this.submitBackupMs + Math.floor(Math.random() * 5000))
        entry.timer.unref?.()
      }
      return
    }
    entry.done = true
    try {
      const r = await this.tx(async () => {
        if (await this.registry.slashUsed(h)) return null
        return (await this.registry.slash(f.operator, BigInt(f.amount), f.reason, 0n, sigs)).wait()
      })
      if (!r) return
      this.stats.slashed++
      this.emit('slashed', { kind: f.kind, operator: f.operator, job: f.job, unit: f.unit, signers: sorted.length, tx: r.hash })
    } catch (err) {
      // a revert may come without its reason: look at the chain
      const used = await this.registry.slashUsed(h).catch(() => false)
      if (!used && !/already slashed|nothing to slash/.test(err.shortMessage || err.message)) {
        entry.done = false
        this.emit('error', err)
        if (!entry.retry) {
          entry.retry = setTimeout(() => { entry.retry = null; this._maybeSubmit(reason, true).catch((e) => this.emit('error', e)) }, this.submitBackupMs)
          entry.retry.unref?.()
        }
      }
    }
  }

}

