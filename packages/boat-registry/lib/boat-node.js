// boat-node: one program for a node anyone can run, in the roles it
// registered for on the registry.
//
//   forward  an MQTT node on HyperDHT (boat-mqtt-node), under the key it
//            registered with
//   store    a store (boat-mqtt-node store.js) for the devices of store jobs
//   verify   work on verify jobs, the watchtower (watch.js) over every job,
//            and the node list for devices (nodelist.js)
//   compute  work on compute jobs
//
// It registers itself when asked (autoRegister, with `stake`), puts its card
// in its HyperDHT record, takes open jobs of its roles from the registry
// (up to maxJobs, while their budget lasts), settles units with the other
// nodes (work.js Settler) and withdraws its rewards when they mature.

import path from 'path'
import fs from 'fs'
import http from 'http'
import { EventEmitter } from 'events'
import HyperDHT from 'hyperdht'
import { monitorEventLoopDelay } from 'perf_hooks'
import { Contract, AbiCoder, keccak256, ZeroAddress } from 'ethers'
import { assignedRole } from './assign.js'
import { ChainView } from './chain.js'
import { createNode, createStore, Follower, openLog, decodeEntry, KeyRing, open } from 'boat-mqtt-node'
import { attach, attachReads, register, ROLES, TEST_TOKEN, decodePlan } from './registry.js'
import { ReadSeller } from './reads.js'
import { readJob, Worker, Settler, ROLE_NAME } from './work.js'
import { Watchtower } from './watch.js'
import { roleKeyPair, putRecord, buildNodeList, publishNodeList, readCard, hex } from './nodelist.js'

const abi = AbiCoder.defaultAbiCoder()

export async function createBoatNode (opts) {
  const n = new BoatNode(opts)
  await n.start()
  return n
}

export class BoatNode extends EventEmitter {
  constructor ({
    dht, bootstrap, seed, operator, registry, roles = null, stake = null, autoRegister = false,
    storage = './boat-node', network, maxJobs = 20, jobPollMs = 15000, listMs = 300000,
    settleDelayMs = 5000, backupMs = 20000, rewardMs = 600000, autoWithdraw = true, statusFile = null,
    spotters = 2, spotEvery = 10, plugins = null, lie = null, drop = null, reads = null, readPrice = null, metricsPort = null, spare = null, watchers = 3,
    overloadMs = 2000, loadCheckMs = 60000, fromBlock = null
  }) {
    super()
    this.dht = dht || new HyperDHT({ bootstrap })
    this._ownDht = !dht
    this.seed = Buffer.from(seed)
    this.operator = operator // ethers Wallet with a provider
    this.registry = attach(registry, operator)
    this.wantRoles = roles
    this.stake = stake
    this.autoRegister = autoRegister
    this.storage = storage
    this.network = network
    this.maxJobs = maxJobs // this node's capacity on the registry: the most jobs it is assigned
    this.overloadMs = overloadMs // event-loop delay (p99) above which the node takes no more jobs
    this.loadCheckMs = loadCheckMs
    this.capacity = null // as the registry has it
    this.lowered = false // capacity lowered for overload
    this.calm = 0 // load checks in a row well under overloadMs
    // where the registry's events start (null: found by a search)
    this.fromBlock = fromBlock
    this.jobPollMs = jobPollMs
    this.listMs = listMs
    this.settleDelayMs = settleDelayMs
    this.backupMs = backupMs
    this.rewardMs = rewardMs
    this.autoWithdraw = autoWithdraw
    this.statusFile = statusFile
    this.spotters = spotters
    this.readsAddress = reads // BoatReads: the store sells reads at readPrice per block
    this.readPrice = readPrice
    this.metricsPort = metricsPort
    this.wantSpare = spare // (the network's, BoatRegistry.planParams, is used)
    this.watchers = watchers // verifiers that watch a job
    this.spotEvery = spotEvery // a store's units spot-checked: one in spotEvery
    this._assigned = new Map() // role:job -> { at, yes }
    this._cards = new Map() // operator -> { at, verify }
    this._jobCache = new Map() // id -> job, read for faults on jobs not watched
    this.faultsReceived = 0 // over the fault mesh
    this.backfilled = 0 // readings fetched from stores to complete units
    this.forwarding = new Set() // devices of forward jobs this node forwards for, if they come here
    this._following = new Set()
    this.waiting = new Map() // id -> job not taken (yet)
    this.lie = lie || {}
    // job kinds run by plugins (xid-depin): [{ name, spec, createWorker({ node, job }) }].
    // A worker is an EventEmitter like Worker: take(), published(), stored(),
    // peer(from, topic, payload), close(); it emits 'signed' with work
    // messages to settle, 'log' and 'error'
    this.plugins = plugins || []
    this.drop = drop // tests: (topic, payload) => true to lose a reading on the way // tests: { compute|verify|store: (result, detail, unit) => ({ result, detail }) }
    this.keyPair = HyperDHT.keyPair(this.seed)
    this.keys = { store: roleKeyPair(this.seed, 'store'), verify: roleKeyPair(this.seed, 'verify'), work: roleKeyPair(this.seed, 'work') }
    this.jobs = new Map() // id -> job (every job we work on or watch)
    this.workers = new Map() // id -> [Worker] (a forward job may have two: forwarder and witness)
    this.forwarders = new Map() // node key hex -> operator address
    this.seenJobs = 0
    this.withdrawn = 0n
    this.timers = []
    this.recordState = {}
    this.listState = {}
    this._txq = Promise.resolve()
    // the node's transactions go one after another: no two take one nonce
    this.tx = (fn) => {
      const p = this._txq.then(fn)
      this._txq = p.catch(() => {})
      return p
    }
  }

  log (line) {
    this.emit('log', line)
  }

  async start () {
    const provider = this.operator.provider
    const net = await provider.getNetwork()
    this.ctx = { registry: await this.registry.getAddress(), chainId: net.chainId, nodeKey: hex(this.keys.work.publicKey) }
    this.minStake = await this.registry.minStake()
    // how every node plans, the same for all: the registry's settings
    const plan = decodePlan(await this.registry.planParams())
    this.spare = plan.spare // signers a job gets beyond its quorum
    if (this.wantSpare !== null && this.wantSpare !== plan.spare) this.log(`spare ${this.wantSpare} ignored: the network's is ${plan.spare}`)
    // what this node signed is kept per chain and registry: a redeployed
    // registry starts its job ids again
    this.signedDir = path.join(this.storage, 'signed', `${net.chainId}-${this.ctx.registry.toLowerCase()}`)
    fs.mkdirSync(this.signedDir, { recursive: true })
    this.chain = new ChainView({
      registry: this.registry,
      provider,
      fromBlock: this.fromBlock,
      step: plan.step,
      lag: plan.lag,
      minStake: this.minStake,
      file: path.join(this.storage, `chain-${this.ctx.registry.toLowerCase()}.json`)
    })

    // registration
    let n = await this.registry.nodes(this.operator.address)
    if (n.stake === 0n && n.unbondAt === 0n) {
      if (!this.autoRegister) throw new Error(`operator ${this.operator.address} is not registered (autoRegister is off)`)
      const token = await this.registry.token()
      const stake = this.stake ?? this.minStake
      const bal = await new Contract(token, TEST_TOKEN.abi, provider).balanceOf(this.operator.address)
      if (bal < stake) throw new Error(`operator ${this.operator.address} holds ${bal} of the stake token, needs ${stake}`)
      await register(this.registry, this.operator, { dhtKey: this.keyPair.publicKey, roles: this.wantRoles, stake, token })
      n = await this.registry.nodes(this.operator.address)
      this.log(`registered: roles ${n.roles}, stake ${n.stake}`)
    }
    if (n.dhtKey.slice(2) !== hex(this.keyPair.publicKey)) throw new Error('the registry names another key for this operator: wrong seed?')
    if (!n.active) throw new Error('this node is not active on the registry (unbonding or slashed below the minimum)')
    this.roles = Number(n.roles)
    // capacity: every node plans assignments from it, so it lives on the registry
    this.capacity = Number(n.capacity)
    const want = Math.min(this.maxJobs, 0xffffffff)
    if (this.capacity !== want) {
      await this.tx(async () => (await this.registry.setCapacity(want)).wait())
      this.capacity = want
      this.log(`capacity set to ${want} jobs`)
    }

    // roles
    if (this.roles & ROLES.FORWARD) {
      // work messages are retained (late followers get them) for an hour:
      // each unit has its own topic, so kept for ever they fill the broker
      this.forward = await createNode({ dht: this.dht, keyPair: this.keyPair, network: this.network, retainTtl: (topic) => (/^d\/[0-9a-f]+\/work\//.test(topic) ? 3600000 : 0) })
      this.forward.on('published', (e) => {
        for (const w of this.allWorkers()) w.published(e)
        // a device on this node with a forward job: follow it here, to hear the witnesses
        if (this.forwarding.has(e.key) && !this.follower.homes.has(e.key) && !this._following.has(e.key)) {
          this._following.add(e.key)
          this.follower.follow(e.key).then(() => this.follower.watchDevice(e.key, `d/+/work/${e.key}/#`), () => this._following.delete(e.key))
        }
      })
      this.log(`forwarding as ${hex(this.keyPair.publicKey)}`)
    }
    if (this.roles & ROLES.STORE) {
      fs.mkdirSync(this.storage, { recursive: true })
      if (this.readsAddress && this.readPrice) {
        this.seller = await new ReadSeller({ reads: attachReads(this.readsAddress, this.operator), operator: this.operator, price: this.readPrice, tx: this.tx }).ready()
        this.log(`selling reads at ${this.readPrice} per block`)
      }
      this.store = await createStore({
        dht: this.dht,
        keyPair: this.keys.store,
        storage: path.join(this.storage, 'store'),
        authorize: this.seller ? this.seller.authorize : null,
        record: this.seller ? this.seller.terms() : {}
      })
      this.store.on('stored', (e) => { for (const w of this.allWorkers()) w.stored(e) })
      this.store.on('error', (err) => this.log('store: ' + err.message))
      this.log(`storing as ${hex(this.keys.store.publicKey)}`)
    }
    this.follower = new Follower({ dht: this.dht, keyPair: this.keys.work, role: 'work' })
    // faults go to the home node of the job's device (topic d/<node>/faults/<reason>)
    const publish = (topic, payload, opts) => {
      let device = null
      try { device = this.jobs.get(JSON.parse(payload).job)?.device } catch {}
      return device ? this.follower.publishTo(device, topic, payload, opts) : this.follower.publish(topic, payload, opts)
    }
    this.settler = new Settler({ registry: this.registry, operator: this.operator, ctx: this.ctx, jobs: this.jobs, settleDelayMs: this.settleDelayMs, backupMs: this.backupMs, tx: this.tx, publish, batchMemory: (id) => this.batchMemoryOf(id), knownActive: (op, role) => this.chain.isActive(op, role) })
    this.settler.on('settled', (s) => {
      if (s.by === 'us' && s.kind === 'batch') this.log(`settled job ${s.job} batch ${unitText(s.batch)}: ${s.units} units, ${s.signers} signers, ${s.gas} gas${s.inTx > 1 ? ` (${s.inTx} batches in the transaction)` : ''}`)
      else if (s.by === 'us') this.log(`settled job ${s.job} unit ${unitText(s.unit)}: ${s.signers} signers, ${s.gas} gas${s.batch > 1 ? ` (a batch of ${s.batch})` : ''}`)
      this.emit('settled', s)
    })
    this.settler.on('error', (err) => this.log('settle: ' + (err.shortMessage || err.message)))
    // a node that signed two statements for one batch: the verifiers slash it
    // (half its stake to the treasury), after a random wait so that most often
    // one of them sends the transaction
    this.settler.on('double-batch', (d) => {
      this.log(`DOUBLE BATCH by ${d.operator.slice(0, 10)}… job ${d.job} batch ${unitText(d.batch)}`)
      this.emit('double-batch', d)
      if (this.roles & ROLES.VERIFY) this.slashDoubleBatch(d).catch((err) => this.log('slash double batch: ' + (err.shortMessage || err.message)))
    })
    if (this.roles & ROLES.VERIFY) {
      this.watch = new Watchtower({
        dht: this.dht,
        registry: this.registry,
        operator: this.operator,
        ctx: this.ctx,
        jobs: this.jobs,
        publish,
        minStake: this.minStake,
        submitBackupMs: this.backupMs,
        spotters: this.spotters,
        spotEvery: this.spotEvery,
        watchers: this.watchers,
        tx: this.tx,
        jobOf: (id) => this.jobOf(id),
        send: (msg) => this.sendFault(msg).catch(() => {})
      })
      await this.listenFaults()
      for (const e of ['fault', 'agree', 'disagree', 'slashed', 'spot-check']) this.watch.on(e, (x) => this.emit(e, x))
      this.watch.on('fault', (f) => this.log(`FAULT ${f.kind} by ${f.operator.slice(0, 10)}… job ${f.job} unit ${unitText(f.unit)}`))
      this.watch.on('slashed', (s) => this.log(`SLASHED ${s.operator.slice(0, 10)}… for ${s.kind}, tx ${s.tx.slice(0, 12)}…`))
      this.watch.on('error', (err) => this.log('watch: ' + (err.shortMessage || err.message)))
    }
    // sealed readings: devices that list this node's work key as a reader
    // put the data key in an envelope at d/<device>/keys/<id>
    this.keyring = new KeyRing(this.keys.work)
    if (this.watch) this.watch.keyring = this.keyring
    this.follower.on('message', (device, topic, payload, via) => {
      if (this.drop && this.drop(topic, payload)) return
      if (topic.startsWith('d/' + device + '/keys/')) {
        const m = open(Buffer.from(device, 'hex'), topic, payload)
        if (m) this.keyring.add(device, m.payload)
        // and on to the workers: a signed message like any other in the device's count
      }
      for (const w of this.allWorkers()) w.take(device, topic, payload, via)
      if (this.watch) this.watch.device(device, topic, payload)
    })
    this.follower.on('peer', (from, topic, payload) => this._peer(from, topic, payload))

    await this.putCard()
    await this.pollJobs()
    this.every(this.jobPollMs, () => this.pollJobs())
    if (this.roles & ROLES.VERIFY) {
      await this.publishList()
      this.every(this.listMs, () => this.publishList())
    }
    this.every(this.rewardMs, () => this.checkRewards())
    if (this.statusFile) this.every(60000, () => this.writeStatus())
    this.loopDelay = monitorEventLoopDelay({ resolution: 20 })
    this.loopDelay.enable()
    this.every(this.loadCheckMs, () => this.checkLoad())
    if (this.metricsPort !== null && this.metricsPort !== undefined) await this.serveMetrics(this.metricsPort)
    return this
  }

  // Prometheus text format on 127.0.0.1:port/metrics
  async metrics () {
    const s = this.status()
    const now = Date.now()
    if (!this._chainAt || now - this._chainAt > 30000) {
      const [n, gas, r] = await Promise.all([this.registry.nodes(this.operator.address), this.operator.provider.getBalance(this.operator.address), this.registry.rewards(this.operator.address)])
      this._chain = { active: n.active ? 1 : 0, stake: n.stake, gas, pending: r[0], matured: r[1], total: await this.registry.totalStake(this.operator.address) }
      this._chainAt = now
    }
    const c = this._chain
    const lines = []
    const m = (name, help, value, type = 'gauge') => lines.push(`# HELP boat_node_${name} ${help}`, `# TYPE boat_node_${name} ${type}`, `boat_node_${name} ${value}`)
    m('active', '1 while the registry counts this node active', c.active)
    m('stake', 'own stake, base units', c.stake)
    m('stake_total', 'own and delegated stake, base units', c.total)
    m('gas_balance', 'native balance for gas, wei', c.gas)
    m('rewards_pending', 'rewards not matured yet, base units', c.pending)
    m('rewards_matured', 'rewards that can be withdrawn, base units', c.matured)
    m('rewards_withdrawn_total', 'rewards withdrawn since start, base units', this.withdrawn, 'counter')
    m('jobs', 'jobs worked on or watched', s.jobs.length)
    m('capacity', 'jobs this node takes at most, as the registry has it (0: no limit)', this.capacity ?? 0)
    m('loop_delay_p99_ms', 'event-loop delay, 99th percentile over the last load check', (this.loadP99 ?? 0).toFixed(1))
    m('overloaded', '1 while the node has lowered its capacity for overload', this.lowered ? 1 : 0)
    m('units_signed_total', 'units this node signed', s.signed, 'counter')
    m('units_settled_total', 'units seen settled', s.settled.settled, 'counter')
    m('units_submitted_total', 'settlements this node sent', s.settled.submitted, 'counter')
    if (s.watch) {
      m('work_checked_total', 'work messages checked by the watchtower', s.watch.checked, 'counter')
      m('faults_total', 'faults raised', s.watch.faults, 'counter')
      m('slashes_total', 'slashes this node sent', s.watch.slashed, 'counter')
      m('spot_checks_total', 'spot checks of stores', s.watch.spotChecks, 'counter')
    }
    if (s.clients !== null) m('mqtt_clients', 'MQTT clients seen on the forwarding node', s.clients)
    if (s.stored) m('store_messages_total', 'messages kept by the store', s.stored.stored, 'counter')
    if (s.reads) {
      m('reads_paid_total', 'paid block reads served', s.reads.paid, 'counter')
      m('reads_free_total', 'free block reads served', s.reads.free, 'counter')
      m('reads_redeemed_total', 'read payments redeemed, base units', s.reads.redeemed, 'counter')
    }
    return lines.join('\n') + '\n'
  }

  serveMetrics (port) {
    this.metricsServer = http.createServer((req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404).end()
        return
      }
      this.metrics().then((body) => res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(body), (err) => res.writeHead(500).end(err.message))
    })
    return new Promise((resolve) => this.metricsServer.listen(port, '127.0.0.1', resolve))
  }

  // Overload: when the event loop's p99 delay stays over overloadMs for two
  // checks in a row, the node lowers its capacity on the registry to the jobs
  // it works on now, so the plan sends new jobs elsewhere (every node computes
  // the same plan, so they all know). After ten calm checks in a row (p99
  // under a quarter of overloadMs) it puts its capacity back to maxJobs.
  async checkLoad () {
    const p99 = this.loopDelay.percentile(99) / 1e6
    this.loopDelay.reset()
    this.loadP99 = p99
    const busy = p99 > this.overloadMs
    this.hot = busy ? (this.hot || 0) + 1 : 0
    this.calm = p99 < this.overloadMs / 4 ? this.calm + 1 : 0
    const working = [...this.workers.entries()].filter(([, list]) => list.some((w) => w.mode !== 'forwarder')).length
    if (this.hot >= 2 && (this.capacity === 0 || working < this.capacity)) {
      const cap = Math.max(1, working)
      await this.tx(async () => (await this.registry.setCapacity(cap)).wait())
      this.capacity = cap
      this.lowered = true
      this.log(`overloaded (event loop p99 ${p99.toFixed(0)} ms): capacity lowered to ${cap} jobs`)
    } else if (this.lowered && this.calm >= 10) {
      const cap = Math.min(this.maxJobs, 0xffffffff)
      await this.tx(async () => (await this.registry.setCapacity(cap)).wait())
      this.capacity = cap
      this.lowered = false
      this.log(`load back to normal (event loop p99 ${p99.toFixed(0)} ms): capacity back to ${cap} jobs`)
    }
  }

  every (ms, fn) {
    const t = setInterval(() => fn().catch((err) => this.log(err.shortMessage || err.message)), ms)
    t.unref()
    this.timers.push(t)
  }

  async putCard () {
    const card = {
      v: 1,
      boat_node: '1',
      chain: String(this.ctx.chainId),
      registry: this.ctx.registry,
      operator: this.operator.address,
      roles: this.roles,
      work: hex(this.keys.work.publicKey)
    }
    if (this.roles & ROLES.STORE) card.store = hex(this.keys.store.publicKey)
    if (this.roles & ROLES.VERIFY) card.verify = hex(this.keys.verify.publicKey)
    await putRecord(this.dht, this.keyPair, card, this.recordState)
    this.card = card
  }

  async publishList () {
    const list = await buildNodeList(this.registry, this.dht)
    if (await publishNodeList(this.dht, this.keys.verify, list, this.listState)) {
      this.log(`node list for epoch ${list.epoch}: ${list.nodes.length} node(s) on ${Math.ceil(list.nodes.length / 28)} page(s), ${list.verifiers.length} verifier(s)`)
      this.emit('list', list)
    }
  }

  // open jobs: ours to work on, and every job to watch when we verify
  async pollJobs () {
    await this.chain.sync().catch((err) => this.log('chain: ' + (err.shortMessage || err.message)))
    // jobs already seen: a node newly assigned to one (another left, or lowered
    // its capacity) starts on it; one no longer assigned (this node lowered its
    // capacity) stops, and the node it went to starts
    for (const job of this.jobs.values()) {
      if (!this.workers.has(job.id)) { if (await this.ensureWorkers(job)) this.replayOwn(job) } else if (job.role !== ROLES.FORWARD && !(await this.assigned(job, job.role))) {
        this.workers.delete(job.id)
        this._dropped = (this._dropped || 0) + 1
        this.log(`left job ${job.id}: assigned to another node now (capacity)`)
      }
    }
    const waiting = [...this.waiting.values()]
    const count = Number(await this.registry.jobCount())
    for (; this.seenJobs < count; this.seenJobs++) {
      try {
        const job = await readJob(this.registry, this.seenJobs)
        waiting.push(job)
      } catch (err) {
        this.log(err.message)
        if (/^job \d+:/.test(err.message)) continue // the job itself is bad: skip it
        break // the RPC failed: read it again next time
      }
    }
    for (const job of waiting) {
      const id = job.id
      // the chain view says what is open, as of the plan's block
      if (!(id in this.chain.state.jobs)) {
        if (id < this.chain.state.jobCount) this.waiting.delete(id) // closed: never again
        else this.waiting.set(id, job) // posted after the plan's block: at the next step
        continue
      }
      if (!this.chain.isOpen(id)) { this.waiting.set(id, job); continue } // spent (it may be funded again)
      const work = await this.ensureWorkers(job)
      const watch = await this.watching(job)
      if (!work && !watch) {
        this.waiting.set(id, job) // not this node's turn: asked again next time
        continue
      }
      this.waiting.delete(id)
      this.jobs.set(id, job)
      if (work) this.replayOwn(job)
      // a node that only forwards for the job does not follow the device: its
      // messages come to this node when it is the device's node, or not at all
      const modes = (this.workers.get(id) || []).map((w) => w.mode)
      if (!watch && modes.length > 0 && modes.every((m) => m === 'forwarder')) {
        this.forwarding.add(job.device)
        continue
      }
      try {
        await this.follower.follow(job.device)
        // the work on this device only (all its jobs), at its home node
        await this.follower.watchDevice(job.device, `d/+/work/${job.device}/#`)
        if (this.watch) await this.follower.watch('d/+/faults/#') // and the fault mesh (listenFaults)
      } catch (err) {
        this.log(`job ${id}: cannot follow its device yet (${err.message}); retrying`)
        this.jobs.delete(id)
        // a plugin's worker runs on its own (timers): stopped, or two of them
        // would work on the job, and could sign one unit twice
        for (const w of this.workers.get(id) || []) if (w.close) await w.close().catch(() => {})
        this.workers.delete(id)
        this.waiting.set(id, job) // the next poll tries this job again
        continue
      }
      this.log(`${work ? 'working on' : 'watching'} job ${id}: ${ROLE_NAME[job.role]} ${job.device.slice(0, 12)}…, window ${job.params.window}, pay ${job.pay}, quorum ${job.quorum}`)
      this.emit('job', { job, work })
    }
  }

  // the units a worker signed, on disk (the last 512), so that a restart
  // never signs one again with another result
  // the batch statements this node signed for a job, on disk and synced
  // before a statement is published: a restart sends the same one again and
  // never signs another for the batch (slashDoubleBatch). It keeps the last
  // 2,048; `floor` is the oldest kept, and batches before it are never signed.
  async slashDoubleBatch ({ job, batch, operator, a, b }, waitMs = Math.floor(Math.random() * 10000)) {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    const reason = keccak256(abi.encode(['string', 'uint256', 'uint64'], ['double-batch', job, batch]))
    if (await this.registry.slashUsed(keccak256(abi.encode(['address', 'bytes32'], [operator, reason])))) return
    const claim = (w) => ({ root: w.root, units: w.units, forwarder: w.forwarder || ZeroAddress, sig: w.signature })
    const r = await this.tx(async () => (await this.registry.slashDoubleBatch(operator, job, batch, claim(a), claim(b))).wait())
    this.log(`SLASHED ${operator.slice(0, 10)}… for a double batch, tx ${r.hash.slice(0, 12)}…`)
    this.emit('slashed', { operator, kind: 'double-batch', tx: r.hash })
  }

  batchMemoryOf (id) {
    this._batchMem = this._batchMem || new Map()
    if (this._batchMem.has(id)) return this._batchMem.get(id)
    const dir = this.signedDir
    const file = path.join(dir, `${id}-batches.json`)
    // a file that is there but cannot be read is not an empty one: the node
    // signs no batch of this job until someone looks (it might have signed any)
    let state = { floor: null, batches: {} }
    let broken = false
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!state || typeof state.batches !== 'object') throw new Error('not batch memory')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        broken = true
        this.log(`batch memory ${file} unreadable (${err.message}): signing no batches of job ${id}`)
      }
      if (err.code === 'ENOENT' || !state || typeof state.batches !== 'object') state = { floor: null, batches: {} }
    }
    const mem = {
      broken,
      get floor () { return state.floor },
      get: (batch) => state.batches[batch],
      set: (batch, statement) => {
        if (broken) throw new Error('batch memory unreadable')
        // the statement, without its leaves (peers had them when it was new)
        const { leaves, ...message } = statement.message || {}
        state.batches[batch] = { ...statement, message }
        const keys = Object.keys(state.batches).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
        if (keys.length > 2048) {
          for (const k of keys.slice(0, keys.length - 2048)) delete state.batches[k]
          state.floor = keys[keys.length - 2048]
        }
        const tmp = file + '.tmp'
        const fd = fs.openSync(tmp, 'w')
        fs.writeSync(fd, JSON.stringify(state))
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fs.renameSync(tmp, file)
        // and the rename itself, so a crash cannot bring the old file back
        const d = fs.openSync(dir, 'r')
        try { fs.fsyncSync(d) } catch {} finally { fs.closeSync(d) }
      }
    }
    this._batchMem.set(id, mem)
    return mem
  }

  memoryOf (name) {
    const dir = this.signedDir
    const file = path.join(dir, name + '.json')
    // unit -> { result, signature, forwarder } (or, written by older
    // versions, the result alone)
    let units = {}
    try { units = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    return {
      get: (unit) => units[unit],
      entries: () => Object.entries(units),
      set: (unit, signed) => {
        units[unit] = signed
        const keys = Object.keys(units)
        if (keys.length > 512) for (const k of keys.slice(0, keys.length - 512)) delete units[k]
        fs.writeFileSync(file + '.tmp', JSON.stringify(units))
        fs.renameSync(file + '.tmp', file)
      }
    }
  }

  // ---- faults between verifiers ----------------------------------------------
  //
  // A fault needs the signatures of a quorum of all verifiers, and most of
  // them do not follow the device. Each verifier takes faults on its verify
  // key, and a verifier that signs one sends it to every other.

  async listenFaults () {
    this.faultServer = this.dht.createServer((conn) => {
      conn.on('error', () => {})
      const chunks = []
      let size = 0
      conn.on('data', (d) => {
        size += d.length
        if (size > 256 * 1024) return conn.destroy()
        chunks.push(d)
      })
      conn.on('end', () => {
        conn.end()
        let msg
        try { msg = JSON.parse(Buffer.concat(chunks).toString()) } catch { return }
        this.faultsReceived++
        this.watch.fault(msg).catch((err) => this.log('watch: ' + err.message))
      })
    })
    await this.faultServer.listen(this.keys.verify)
  }

  // the verify keys of the active verifiers, from their cards (5 minutes)
  async verifyKeys () {
    const out = []
    for (const op of await this.activeOf(ROLES.VERIFY)) {
      if (op === this.operator.address) continue
      const card = await this.cardOf(op)
      if (card && /^[0-9a-f]{64}$/.test(card.verify || '')) out.push(card.verify)
    }
    return out
  }

  async sendFault (msg) {
    const body = Buffer.from(JSON.stringify(msg))
    for (const key of await this.verifyKeys()) {
      const conn = this.dht.connect(Buffer.from(key, 'hex'))
      conn.on('error', () => {})
      conn.on('data', () => {})
      conn.end(body)
      setTimeout(() => conn.destroy(), 30000).unref?.()
    }
  }

  // ---- backfill ------------------------------------------------------------------
  //
  // Readings lost on the way leave a unit short. The device's stores kept
  // them: fetch the missing ones (checked against the store's signed head and
  // the device's own signature) and complete the unit.

  // the store keys of the stores that keep a device (the nodes assigned to its store jobs)
  async storesOf (device) {
    const ids = [...this.jobs.values(), ...this.waiting.values()].filter((j) => j.role === ROLES.STORE && j.device === device).map((j) => j.id)
    if (!ids.length) return []
    // the nodes the plan gave the device's store jobs (M7, review 3)
    const plan = await this.plan()
    const ops = [...new Set(ids.flatMap((id) => plan.get(id) || []))]
    const keys = []
    for (const op of ops) {
      const card = await this.cardOf(op)
      if (card && card.store) keys.push(card.store)
    }
    return keys
  }

  async cardOf (op) {
    let c = this._cards.get(op)
    if (!c || Date.now() - c.at > 300000) {
      const n = await this.registry.nodes(op)
      const card = await readCard(this.dht, n.dhtKey.slice(2)).catch(() => null)
      c = { at: Date.now(), card: card && card.operator === op ? card : null }
      this._cards.set(op, c)
    }
    return c.card
  }

  async backfill (worker, { job, missing }) {
    let left = missing.slice()
    for (const store of await this.storesOf(job.device)) {
      if (!left.length) break
      if (this.store && store === hex(this.keys.store.publicKey)) {
        // our own store: no need to go over the network
        for (const seq of left.slice()) {
          const d = this.store.devices.get(job.device)
          const i = d && d.bySeq.get(String(seq))
          if (i === undefined) continue
          const block = await d.core.get(i, { wait: false })
          if (!block) continue
          const e = decodeEntry(block)
          worker.take(job.device, e.topic, Buffer.from(e.message), null, true)
          left = left.filter((x) => x !== seq)
          this.backfilled++
        }
        continue
      }
      let log = null
      try {
        log = await openLog(this.dht, Buffer.from(store, 'hex'), job.device)
        for (const seq of left.slice()) {
          const b = await log.find(null, seq)
          if (!b) continue
          worker.take(job.device, b.topic, Buffer.from(b.message), null, true)
          left = left.filter((x) => x !== seq)
          this.backfilled++
        }
      } catch {} finally {
        log?.close()
      }
    }
  }

  async jobOf (id) {
    if (this.jobs.has(id)) return this.jobs.get(id)
    if (!this._jobCache.has(id)) this._jobCache.set(id, readJob(this.registry, id))
    return this._jobCache.get(id)
  }

  // the active operators of a role, as of the plan's block (lib/chain.js)
  async activeOf (role) {
    if (this.chain.block < 0) await this.chain.sync()
    return this.chain.active(role)
  }

  // the quorum + spare nodes of a role that work on a job: the first by
  // keccak(operator, device). Others of the role leave it to them, so a unit
  // gets a few signatures, not one from every node; and all the jobs on one
  // device go to the same few nodes, so few nodes follow each device.
  // (with capacities: lib/assign.js; every node computes the same plan, from
  // the registry's events as of the same block: lib/chain.js. A job posted
  // after that block is nobody's yet: it is taken on at the next step)
  async assigned (job, role) {
    const plan = await this.plan()
    return (plan.get(job.id) || []).includes(this.operator.address) && assignedRole(job) === role
  }

  async plan () {
    if (this.chain.block < 0) await this.chain.sync()
    const key = this.chain.version
    if (this._plan && this._plan.key === key) return this._plan.plan
    const { plan, load } = this.chain.plan([ROLES.STORE, ROLES.VERIFY, ROLES.COMPUTE], this.spare)
    this._plan = { key, plan, load }
    return plan
  }

  // does this node watch the job (its watchtower judges it)?
  async watching (job) {
    return !!this.watch && (await this.watch.watchersOf(job.device)).includes(this.operator.address)
  }

  // starts this node's workers on a job when it is its turn; true if it works on it
  async ensureWorkers (job) {
    if (this.workers.has(job.id)) return true
    const id = job.id
    const plugin = this.plugins.find((p) => p.spec === job.spec)
    if (plugin) {
      if (!(this.roles & job.role) || !(await this.assigned(job, job.role))) return false
      const w = await plugin.createWorker({ node: this, job })
      w.on('signed', (m) => {
        if (!m) return
        this.emit('signed', m)
        this.settler.add(m, { own: true }).catch((err) => this.log('settle: ' + err.message))
        if (this.watch) this.watch.work(m).catch(() => {})
      })
      w.on('log', (line) => this.log(`${plugin.name} job ${id}: ${line}`))
      w.on('error', (err) => this.log(`${plugin.name} job ${id}: ${err.shortMessage || err.message}`))
      this.workers.set(id, [w])
      return true
    }
    // forward jobs: the device's node signs what it forwarded, assigned verifiers witness it
    const modes = []
    if (job.role === ROLES.FORWARD) {
      if (this.roles & ROLES.FORWARD) modes.push('forwarder')
      if ((this.roles & ROLES.VERIFY) && (await this.assigned(job, ROLES.VERIFY))) modes.push('witness')
    } else if ((this.roles & job.role) && (await this.assigned(job, job.role))) {
      modes.push(null)
    }
    if (modes.length === 0) return false
    const list = modes.map((mode) => {
      const w = new Worker({
        job,
        operator: this.operator,
        ctx: this.ctx,
        nodeKey: this.ctx.nodeKey,
        publish: (topic, payload, opts) => this.follower.publishTo(job.device, topic, payload, opts),
        storeKey: job.role === ROLES.STORE ? hex(this.keys.store.publicKey) : null,
        lie: this.lie[ROLE_NAME[job.role]] || null,
        mode,
        keyring: this.keyring,
        forwarderOf: (key) => this.forwarderOf(key),
        memory: this.memoryOf(`${id}-${mode || ROLE_NAME[job.role]}`)
      })
      w.on('signed', (m) => {
        if (!m) return
        this.emit('signed', m)
        this.settler.add(m, { own: true }).catch((err) => this.log('settle: ' + err.message))
        if (this.watch) this.watch.work(m).catch(() => {})
      })
      w.on('error', (err) => this.log(`job ${id}: ${err.message}`))
      w.on('missing', (m) => this.backfill(w, m).catch((err) => this.log(`backfill: ${err.message}`)))
      return w
    })
    this.workers.set(id, list)
    if (job.role === ROLES.STORE) await this.store.follow(job.device).catch((err) => this.log(`store: ${err.message}`))
    return true
  }

  // a batch job's units this node signed before a restart: back into the
  // Settler, so that its batches hold them (M2, review 3). Its workers never
  // sign them again, and its own retained messages count only from its workers
  replayOwn (job) {
    if (!job.batchUnits) return
    for (const w of this.workers.get(job.id) || []) {
      if (!w.memory || !w.memory.entries || w.mode === 'forwarder') continue
      for (const [unit, m] of w.memory.entries()) {
        if (!m || typeof m !== 'object' || !m.signature) continue // (older files: the result alone)
        const msg = { v: 1, job: job.id, unit, role: job.role, device: job.device, result: m.result, operator: this.operator.address, node: this.ctx.nodeKey, detail: m.forwarder ? { forwarder: m.forwarder } : {}, signature: m.signature }
        this.settler.add(msg, { own: true }).catch(() => {})
      }
    }
  }

  * allWorkers () {
    for (const list of this.workers.values()) yield * list
  }

  // the operator of a forwarding node, from its card, as the registry names it
  async forwarderOf (key) {
    if (this.forwarders.has(key)) return this.forwarders.get(key)
    const card = await readCard(this.dht, key)
    if (!card || !card.operator) return null
    const n = await this.registry.nodes(card.operator)
    const op = n.dhtKey.slice(2) === key ? card.operator : null
    if (op) this.forwarders.set(key, op)
    return op
  }

  async _peer (from, topic, payload) {
    const kind = topic.split('/')[2]
    if (kind === 'work') {
      let w
      try { w = JSON.parse(payload.toString()) } catch { return }
      // (and statements for a job this node left with batches still open)
      if (this.workers.has(w.job) || (w.kind === 'batch' && this.settler.hasOpenBatches(w.job))) await this.settler.add(w).catch(() => {})
      if (this.watch) await this.watch.work(w).catch((err) => this.log('watch: ' + err.message))
    } else if (kind === 'depin') {
      for (const w of this.allWorkers()) if (w.peer) w.peer(from, topic, payload)
    } else if (kind === 'faults' && this.watch) {
      await this.watch.peer(from, topic, payload).catch((err) => this.log('watch: ' + err.message))
    }
  }

  async checkRewards () {
    if (this.seller) await this.seller.redeem().catch((err) => this.log('reads: ' + (err.shortMessage || err.message)))
    const [pending, matured] = await this.registry.rewards(this.operator.address)
    this.rewards = { pending, matured, withdrawn: this.withdrawn }
    if (this.autoWithdraw && matured > 0n) {
      await this.tx(async () => (await this.registry.withdrawRewards()).wait())
      this.withdrawn += matured
      this.log(`withdrew ${matured} in rewards`)
    }
    return this.rewards
  }

  status () {
    const workers = [...this.allWorkers()]
    return {
      at: new Date().toISOString(),
      operator: this.operator.address,
      key: hex(this.keyPair.publicKey),
      roles: this.roles,
      jobs: [...this.jobs.keys()],
      signed: workers.reduce((a, w) => a + w.signedCount, 0),
      capacity: this.capacity,
      overloaded: this.lowered,
      // by kind of job: workers, units signed, messages taken and refused,
      // units dropped short and units that were short a while
      work: workers.reduce((a, w) => {
        const r = (a[ROLE_NAME[w.job.role]] ||= { workers: 0, signed: 0, taken: 0, refused: 0, dropped: 0, short: 0, open: 0 })
        r.workers++
        r.signed += w.signedCount
        r.open += w.units?.size || 0 // (plugin workers keep no units)
        for (const [k, v] of Object.entries(w.counts || {})) r[k] += v
        return a
      }, {}),
      settled: this.settler.stats,
      watch: this.watch ? this.watch.stats : null,
      rewards: this.rewards ? Object.fromEntries(Object.entries(this.rewards).map(([k, v]) => [k, String(v)])) : null,
      clients: this.forward ? Object.keys(this.forward.usage()).length : null,
      backfilled: this.backfilled,
      stored: this.store ? this.store.stats : null,
      reads: this.seller ? { ...this.seller.stats, redeemed: String(this.seller.stats.redeemed) } : null
    }
  }

  async writeStatus () {
    const s = this.status()
    fs.writeFileSync(this.statusFile, JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2))
  }

  async close () {
    for (const t of this.timers) clearInterval(t)
    this.loopDelay?.disable()
    this.metricsServer?.close()
    this.settler?.close()
    for (const w of this.allWorkers()) if (w.close) await w.close().catch(() => {})
    await this.follower?.close()
    await this.store?.close()
    await this.forward?.close()
    await this.faultServer?.close().catch(() => {})
    if (this._ownDht) await this.dht.destroy()
  }
}

const unitText = (u) => `${BigInt(u) >> 32n}:${BigInt(u) & 0xffffffffn}`
