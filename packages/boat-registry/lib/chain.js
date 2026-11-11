// What every node needs to agree on who works on which job, rebuilt from the
// registry's events, as of one block that every node picks alike.
//
// Assignment (lib/assign.js) is computed off-chain by every node, and the nodes
// only agree if they compute it from the same inputs. Reading the registry's
// current state (jobs, nodes, capacities) at whatever moment each node polls
// does not give them that: one reads a job a few seconds after another, one has
// a cached list of active nodes and another a fresh one. So the inputs are:
// - the events up to an "as of" block: the head, `lag` blocks back (an RPC a
//   little behind still has it), rounded down to a multiple of `step`. Nodes
//   whose heads differ by less than a step compute the same plan; the plan
//   moves once a step;
// - in the order the chain put them (block, then log index), which also gives
//   what the contract no longer stores: how many jobs had been posted when a
//   node registered, and when each capacity change took effect. A
//   CapacitySet applies to the jobs posted after it; every change is kept, so
//   lowering a capacity and raising it again never moves jobs that were posted
//   before either change;
// - and, for the one thing events do not say (whether a slash left a node
//   below the minimum stake), the node's record read at the as-of block.
//
// A job is open while it is not closed (JobClosed, or JobClosing with its time
// past at the as-of block) and its terms are good (jobProblem: no node works
// on a job it cannot read). A spent job (JobSpent: its budget is under what a
// unit, or a batch, pays) keeps its nodes for `spentHoldS` seconds of chain
// time, so a job running dry and being funded again, the usual case, moves
// no other job; after that it stops holding room (later jobs may then move).
// JobFunded that brings the budget back makes it a working job again. The
// state is kept on disk (`file`) with the chain id and the hash of its block,
// so a restart reads only the blocks since, and a state from another chain, or
// from blocks that are no longer the chain's, is thrown away.

import fs from 'fs'
import { getBytes } from 'ethers'
import { assignJobs } from './assign.js'
import { jobProblem } from './work.js'

const EVENTS = ['JobPosted', 'BatchJob', 'JobFunded', 'JobSpent', 'JobClosing', 'JobClosed', 'NodeRegistered', 'Unbonding', 'Withdrawn', 'Slashed', 'CapacitySet']

export class ChainView {
  // registry: the BoatRegistry contract (with a provider); fromBlock: where to
  // start reading (null: the block it was deployed in, found by its code);
  // minStake: the registry's; file: where the state is kept (null: memory only)
  constructor ({ registry, provider = null, fromBlock = null, step = 10, lag = 2, chunk = 5000, minStake = 0n, file = null, spentHoldS = 86400 }) {
    this.registry = registry
    this.provider = provider || registry.runner.provider
    this.step = step
    this.lag = lag
    this.chunk = chunk
    this.minStake = BigInt(minStake)
    this.file = file
    this.fromBlock = fromBlock
    this.spentHoldS = spentHoldS
    this._logs = new Map() // from:to -> logs, read in a sync that failed later (L3)
    this.topics = EVENTS.map((e) => registry.interface.getEvent(e).topicHash)
    this.topicSet = new Set(this.topics)
    this.state = this._fresh()
    this.version = 0 // changes when what the plan depends on changes
    this._load()
  }

  _load () {
    if (!this.file) return
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (s && s.registry === this.registry.target && typeof s.block === 'number') this.state = s
    } catch {}
  }

  _fresh () {
    return { block: -1, hash: null, chainId: null, time: 0, jobCount: 0, jobs: {}, nodes: {} }
  }

  _save () {
    if (!this.file) return
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ ...this.state, registry: this.registry.target }))
    fs.renameSync(tmp, this.file)
  }

  // the block a plan is computed at, for a head
  asOfFor (head) {
    return Math.max(0, Math.floor((head - this.lag) / this.step) * this.step)
  }

  get block () { return this.state.block }

  // reads the events up to the as-of block of the current head; returns that block
  async sync () {
    if (this._syncing) return this._syncing
    this._syncing = this._sync().finally(() => { this._syncing = null })
    return this._syncing
  }

  async _sync () {
    const asOf = this.asOfFor(await this.provider.getBlockNumber())
    // the state must be this chain's: same chain id, and its block still the
    // chain's (a restarted local chain, or a reorg deeper than `lag`, is not)
    if (this.state.block >= 0) {
      const chainId = String((await this.provider.getNetwork()).chainId)
      const b = await this.provider.getBlock(this.state.block)
      if (this.state.chainId !== chainId || !b || b.hash !== this.state.hash) {
        this.state = this._fresh()
        this._logs.clear()
        this.version++
      }
    }
    if (asOf <= this.state.block) return this.state.block
    // all or nothing: the events go into a copy, which replaces the state only
    // once every read succeeded (an RPC error halfway, applied twice later,
    // would record a capacity change twice, at the wrong job)
    const next = structuredClone(this.state)
    if (next.block < 0) next.block = (this.fromBlock ?? await deployBlockOf(this.provider, this.registry.target, asOf)) - 1
    const touched = new Set() // nodes slashed in these blocks: read as of asOf
    let events = 0
    for (let from = next.block + 1; from <= asOf;) {
      const to = Math.min(asOf, from + this.chunk - 1)
      // (logs read before a failure are kept for the next try: a first sync
      // over many blocks need not succeed in one go)
      let logs = this._logs.get(from + ':' + to)
      if (!logs) {
        // every event of the registry, filtered here: some RPCs (Arc's) take
        // a topic list as many queries and refuse a range they would serve
        // without one ("requested range too large")
        try {
          logs = await this.provider.getLogs({ address: this.registry.target, fromBlock: from, toBlock: to })
        } catch (err) {
          // a range the RPC refuses: smaller chunks from here on
          if (this.chunk > 50 && /range|too large|limit|exceed/i.test(err.error?.message || err.message)) {
            this.chunk = Math.max(50, Math.floor(this.chunk / 2))
            continue
          }
          throw err
        }
        logs = logs.filter((l) => this.topicSet.has(l.topics[0]))
        logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index))
        this._logs.set(from + ':' + to, logs)
      }
      for (const log of logs) {
        const e = this.registry.interface.parseLog(log)
        // when a job ran dry, by the chain's clock
        if (e && e.name === 'JobSpent') e.time = (await this.provider.getBlock(log.blockNumber)).timestamp
        this._apply(next, e, touched)
        if (e) events++
      }
      from = to + 1
    }
    for (const op of touched) {
      const n = next.nodes[op]
      if (!n) continue
      const r = await this.registry.nodes(op, { blockTag: asOf })
      n.active = r.active && r.stake >= this.minStake
    }
    const top = await this.provider.getBlock(asOf)
    next.time = top.timestamp
    next.hash = top.hash
    next.chainId = String((await this.provider.getNetwork()).chainId)
    next.block = asOf
    const openBefore = this._openKey()
    this.state = next
    this._logs.clear()
    this._prune()
    // the plan changes only with events, or with time closing or releasing a
    // job: not with every block (a local chain makes one per transaction)
    if (events > 0 || touched.size > 0 || this._openKey() !== openBefore) this.version++
    this._save()
    return asOf
  }

  _apply (s, e, touched) {
    if (!e) return
    const a = e.args
    switch (e.name) {
      case 'JobPosted': {
        const id = Number(a.id)
        let params = null
        try { params = JSON.parse(Buffer.from(getBytes(a.params)).toString()) } catch {}
        const bad = jobProblem(Number(a.role), a.spec, params) !== null
        s.jobs[id] = { id, device: a.device.slice(2), role: Number(a.role), quorum: Number(a.quorum), pay: a.pay.toString(), batchUnits: 0, closesAt: 0, spent: false, spentAt: 0, budget: null, closed: false, bad }
        s.jobCount = Math.max(s.jobCount, id + 1)
        break
      }
      case 'BatchJob': { const j = s.jobs[Number(a.id)]; if (j) j.batchUnits = Number(a.batchUnits); break }
      case 'JobSpent': { const j = s.jobs[Number(a.id)]; if (j) { j.spent = true; j.spentAt = e.time || 0; j.budget = a.left.toString() } break }
      case 'JobFunded': {
        // working again once its budget pays a unit (a batch, for a batch job),
        // as the contract counts it (JobSpent in _spend)
        const j = s.jobs[Number(a.id)]
        if (j && j.spent) {
          j.budget = (BigInt(j.budget) + a.amount).toString()
          if (BigInt(j.budget) >= BigInt(j.pay) * BigInt(Math.max(1, j.batchUnits))) { j.spent = false; j.spentAt = 0; j.budget = null }
        }
        break
      }
      case 'JobClosing': { const j = s.jobs[Number(a.id)]; if (j) j.closesAt = Number(a.closesAt); break }
      case 'JobClosed': { const j = s.jobs[Number(a.id)]; if (j) j.closed = true; break }
      case 'NodeRegistered':
        // a node's capacity is 0 (no limit) until it sets one
        s.nodes[a.operator] = { roles: Number(a.roles), active: a.stake >= this.minStake, sinceJob: s.jobCount, steps: [[s.jobCount, 0]] }
        break
      case 'Unbonding': { const n = s.nodes[a.operator]; if (n) n.active = false; break }
      case 'Withdrawn': delete s.nodes[a.operator]; break
      case 'Slashed': touched.add(a.operator); break
      case 'CapacitySet': {
        const n = s.nodes[a.operator]
        if (!n) break
        const last = n.steps[n.steps.length - 1]
        if (last[0] === s.jobCount) last[1] = Number(a.capacity) // no job posted since the last change
        else n.steps.push([s.jobCount, Number(a.capacity)])
        break
      }
    }
  }

  _openKey () {
    let n = 0
    let sum = 0
    for (const j of Object.values(this.state.jobs)) if (this._open(j)) { n++; sum = (sum + j.id * 2654435761) % 4294967296 }
    return n + ':' + sum
  }

  // a job that holds nodes: not closed, good, and not spent for long
  _open (j) {
    return !j.closed && !j.bad && (!j.spent || this.state.time - j.spentAt < this.spentHoldS) && (j.closesAt === 0 || j.closesAt > this.state.time)
  }

  // jobs that can never take work again go; capacity steps older than every
  // open job go, but for the one in force when the oldest was posted
  _prune () {
    const s = this.state
    for (const [id, j] of Object.entries(s.jobs)) {
      if (j.closed || (j.closesAt !== 0 && j.closesAt <= s.time)) delete s.jobs[id]
    }
    const ids = Object.keys(s.jobs).map(Number)
    const oldest = ids.length ? Math.min(...ids) : s.jobCount
    for (const n of Object.values(s.nodes)) {
      while (n.steps.length > 1 && n.steps[1][0] <= oldest) n.steps.shift()
    }
  }

  // the open jobs as of the block, for lib/assign.js
  openJobs () {
    return Object.values(this.state.jobs).filter((j) => this._open(j)).map((j) => ({ ...j, pay: BigInt(j.pay) }))
  }

  // a job nodes should work on: open, and not spent
  isOpen (id) {
    const j = this.state.jobs[id]
    return !!j && this._open(j) && !j.spent
  }

  isActive (op, role) {
    const n = this.state.nodes[op]
    return !!n && n.active && (n.roles & role) !== 0
  }

  // the active operators of a role as of the block
  active (role) {
    return Object.entries(this.state.nodes).filter(([, n]) => n.active && (n.roles & role)).map(([op]) => op).sort()
  }

  // operator -> { steps, sinceJob }, for lib/assign.js
  nodes () {
    return new Map(Object.entries(this.state.nodes).map(([op, n]) => [op, { steps: n.steps, sinceJob: n.sinceJob }]))
  }

  // who works on which job: Map(job id -> [operator]), and each node's load
  plan (roles, spare) {
    return assignJobs(this.openJobs(), new Map(roles.map((r) => [r, this.active(r)])), this.nodes(), spare)
  }
}

// the block a contract was deployed in: the first with its code (a binary
// search; an RPC that keeps no old state cannot answer, and then it is 0)
export async function deployBlockOf (provider, address, head) {
  try {
    let lo = 0
    let hi = head
    if ((await provider.getCode(address, hi)) === '0x') return head
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if ((await provider.getCode(address, mid)) === '0x') lo = mid + 1
      else hi = mid
    }
    return lo
  } catch {
    return 0
  }
}
