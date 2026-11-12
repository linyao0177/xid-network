// The audit of settlements, run by verifier nodes: were the nodes whose
// signatures settled a unit the ones assigned to the job?
//
// The registry pays any `quorum` active nodes of a job's role that sign the
// same result: it cannot compute who was assigned (lib/assign.js needs every
// job and every capacity change). Left at that, a few staked nodes could
// settle units of jobs that are not theirs, with a result they copied from
// the assigned nodes' published work or made up, and take the pay. So the
// watchers of a device read every settlement of its jobs from the chain, and
// a signer that was not assigned is slashed by the verifiers' quorum like
// any other fault ("unassigned", lib/watch.js); its rewards of the epoch go
// with the slash.
//
// Who signed: the registry names the signers it counted (SettledBy). A
// registry from before that event does not: there the signatures are read
// from the transaction, which works when it called the registry directly.
//
// Who was assigned: the plan (lib/chain.js) moves once a step, and a unit is
// settled a little after it was signed. A signer is at fault only when no
// plan from `graceSteps` steps before the settlement up to it had the node on
// the job. This node remembers the plans it computed (PlanHistory), a little
// wider than they were: a node it saw join or leave a job between two looks
// at the chain counts as assigned for the whole time between them. A node
// that has not watched for that long, or has not read the chain that far,
// cannot tell, and does not judge. Verifiers that looked at different moments
// may differ on a node that had just left a job; then there is no quorum and
// nobody is slashed.

import { ZeroAddress } from 'ethers'
import { recoverSigner } from './recover.js'
import { ROLES, workStatement, batchStatement } from './registry.js'
import { forwardResult } from './work.js'

const lower = (a) => String(a).toLowerCase()

// which nodes each plan gave each job, as intervals of as-of blocks
export class PlanHistory {
  constructor ({ keep = 100000 } = {}) {
    this.keep = keep // blocks an interval that ended is kept
    this.since = null // the first block noted
    this.at = null // the last
    this.jobs = new Map() // job id -> Map(operator -> [{ from, to, open }])
  }

  // the plan as of `block`: Map(job id -> [operator])
  note (block, plan) {
    if (this.at !== null && block <= this.at) return
    // a node that is new on a job may have been on it since the last look
    const from = this.at === null ? block : this.at
    for (const [id, ops] of plan) {
      let m = this.jobs.get(id)
      if (!m) { m = new Map(); this.jobs.set(id, m) }
      for (const op of ops) {
        let list = m.get(op)
        if (!list) { list = []; m.set(op, list) }
        const last = list[list.length - 1]
        if (last && last.open) last.to = block
        else list.push({ from, to: block, open: true })
      }
    }
    // and one that is gone may have been on it until now
    for (const [id, m] of this.jobs) {
      const ops = plan.get(id) || []
      for (const [op, list] of m) {
        const last = list[list.length - 1]
        if (last.open && !ops.includes(op)) { last.to = block; last.open = false }
        while (list.length && !list[0].open && list[0].to < block - this.keep) list.shift()
        if (list.length === 0) m.delete(op)
      }
      if (m.size === 0) this.jobs.delete(id)
    }
    if (this.since === null) this.since = block
    this.at = block
  }

  // was op on the job in a plan of the blocks lo..hi?
  assigned (job, op, lo, hi) {
    const list = this.jobs.get(job)?.get(op)
    return !!list && list.some((i) => i.from <= hi && i.to >= lo)
  }
}

// the signatures of a settlement, from the transaction that made it (a call
// of the registry itself): the signers of the role, as addresses
export function signersFromInput (registry, ctx, data, job, unit, roleOf) {
  let call
  try { call = registry.interface.parseTransaction({ data }) } catch { return null }
  if (!call) return null
  const a = call.args
  const units = []
  const batches = []
  switch (call.name) {
    case 'settle': units.push({ id: a.id, unit: a.unit, result: a.result, forwarder: ZeroAddress, sigs: a.sigs }); break
    case 'settleForward': units.push({ id: a.id, unit: a.unit, result: a.root, forwarder: a.forwarder, sigs: a.sigs }); break
    case 'settleMany': for (const i of a.items) units.push(i); break
    case 'settleBatch': batches.push({ id: a.id, batch: a.batch, root: a.root, units: a.units, forwarder: a.forwarder, sigs: a.sigs }); break
    case 'settleBatchMany': for (const b of a.items) batches.push(b); break
    default: return null
  }
  const out = new Set()
  const add = (statement, sigs, forwarder) => {
    for (const sig of sigs) {
      const s = recoverSigner(statement, sig)
      // (for a forward job the contract counts the verifiers, not the forwarder)
      if (s && s !== forwarder && roleOf(s, forwarder !== ZeroAddress)) out.add(s)
    }
  }
  for (const i of units) {
    if (Number(i.id) !== job || String(i.unit) !== unit) continue
    const result = i.forwarder === ZeroAddress ? i.result : forwardResult(i.forwarder, i.result)
    add(workStatement(ctx, i.id, i.unit, result), i.sigs, i.forwarder)
  }
  for (const b of batches) {
    if (Number(b.id) !== job || String(b.batch) !== unit) continue
    add(batchStatement(ctx, b.id, b.batch, b.root, b.units, b.forwarder), b.sigs, b.forwarder)
  }
  return [...out]
}

export class Auditor {
  // chain: the node's ChainView, made with also: Auditor.EVENTS; sync(): reads
  // the chain again and notes the plan (for a fault about a block not read yet)
  constructor ({ registry, ctx, chain, graceSteps = 64, sync = null }) {
    this.registry = registry
    this.provider = chain.provider
    this.ctx = ctx
    this.chain = chain
    this.graceSteps = graceSteps
    this.sync = sync
    this.history = new PlanHistory()
    this.stats = { settlements: 0, unknown: 0, unjudged: 0, unassigned: 0 }
  }

  note (plan) {
    if (this.chain.block >= 0) this.history.note(this.chain.block, plan)
  }

  // was op assigned to the job when block settled one of its units? true,
  // false, or null: this node cannot tell
  assigned (job, op, block) {
    const h = this.history
    if (h.at === null || block > h.at) return null
    const lo = this.chain.asOfFor(block) - this.graceSteps * this.chain.step
    if (h.since > lo) return null // not watching for long enough
    return h.assigned(job, op, lo, block)
  }

  // the same, after reading the chain up to the block when it is ahead of us
  async assignedAt (job, op, block) {
    for (let i = 0; i < 3 && this.sync && (this.history.at === null || block > this.history.at); i++) {
      await this.sync().catch(() => {})
      if (this.history.at === null || block > this.history.at) await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    return this.assigned(job, op, block)
  }

  _parse (log) {
    try { return this.registry.interface.parseLog(log) } catch { return null }
  }

  // does the node have the role the contract counts for such a settlement?
  _roleOf (job) {
    return (op, forward) => {
      const n = this.chain.state.nodes[op]
      const role = forward ? ROLES.VERIFY : this.chain.state.jobs[job]?.role
      return !!n && !!role && (n.roles & role) !== 0
    }
  }

  // a settlement of (job, unit) in a transaction: { block, signers }, with
  // signers null when they cannot be read; null when there is none (or the
  // transaction is not in a block this node has read up to)
  async settlementOf (tx, job, unit) {
    const r = await this.provider.getTransactionReceipt(tx)
    if (!r || r.status !== 1) return null
    let found = false
    let signers = null
    for (const log of r.logs) {
      if (lower(log.address) !== lower(this.ctx.registry)) continue
      const e = this._parse(log)
      if (!e) continue
      if (e.name === 'SettledBy' && Number(e.args.id) === job && String(e.args.unit) === unit) signers = [...e.args.signers]
      else if ((e.name === 'Settled' && Number(e.args.id) === job && String(e.args.unit) === unit) || (e.name === 'BatchSettled' && Number(e.args.id) === job && String(e.args.batch) === unit)) found = true
    }
    if (!found) return null
    if (!signers) signers = await this._fromTransaction(tx, job, unit)
    return { block: r.blockNumber, signers }
  }

  async _fromTransaction (hash, job, unit) {
    const t = await this.provider.getTransaction(hash)
    if (!t || !t.to || lower(t.to) !== lower(this.ctx.registry)) return null
    return signersFromInput(this.registry, this.ctx, t.data, job, unit, this._roleOf(job))
  }

  // the settlements read since the last call, of jobs on devices this node
  // watches (watches(device)): the signers that were not assigned, as
  // [{ job, unit, operator, tx, block }]
  async scan (watches) {
    const logs = this.chain.drain()
    const by = new Map() // tx:job:unit -> signers, as the registry named them
    const settlements = []
    for (const log of logs) {
      const e = this._parse(log)
      if (!e) continue
      const job = Number(e.args.id)
      if (e.name === 'SettledBy') by.set(`${log.transactionHash}:${job}:${e.args.unit}`, [...e.args.signers])
      else settlements.push({ job, unit: String(e.name === 'Settled' ? e.args.unit : e.args.batch), tx: log.transactionHash, block: log.blockNumber })
    }
    const out = []
    for (const s of settlements) {
      const j = this.chain.state.jobs[s.job]
      // (before this node watched: nothing to say about it)
      if (!j || this.history.since === null || s.block < this.history.since) continue
      if (!(await watches(j.device))) continue
      this.stats.settlements++
      let signers = by.get(`${s.tx}:${s.job}:${s.unit}`)
      if (!signers) signers = await this._fromTransaction(s.tx, s.job, s.unit).catch(() => null)
      if (!signers) { this.stats.unknown++; continue }
      for (const operator of signers) {
        const yes = this.assigned(s.job, operator, s.block)
        if (yes === null) this.stats.unjudged++
        else if (!yes) { this.stats.unassigned++; out.push({ ...s, operator }) }
      }
    }
    return out
  }
}

Auditor.EVENTS = ['Settled', 'BatchSettled', 'SettledBy']
