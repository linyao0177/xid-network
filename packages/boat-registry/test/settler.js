// The Settler's batch signing against forged, malleated and replayed work,
// without a chain: node test/settler.js
//
// Regression tests for the v4 reviews: a node must never count a work message
// it has not checked, never let a malleated copy replace a good signature,
// never sign two statements for one batch (not across a restart, not when a
// peer's statement arrives while it signs, not when its memory file is
// damaged), should sign the same root as its peers when it saw a unit late,
// must not let unstaked keys crowd out real statements, must not adopt a
// statement that pays another forwarder, and keeps batches still retrying.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { Wallet, getBytes, ZeroHash, ZeroAddress, hexlify } from 'ethers'
import { Settler, ROLES, workStatement, batchStatement, batchLeaf, merkleRoot, recoverSigner } from '../index.js'
import { BoatNode } from '../lib/boat-node.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ctx = { registry: '0x' + '11'.repeat(20), chainId: 31337n, nodeKey: 'aa'.repeat(32) }
const device = 'dd'.repeat(32)
const job = { id: 1, role: ROLES.STORE, quorum: 2, batchUnits: 3, device }
const [A, B, C, X] = [0, 1, 2, 3].map(() => Wallet.createRandom())
// a registry that settles nothing yet and counts A, B, C as active stores
const registry = {
  connect () { return this },
  async isActive (op) { return [A, B, C].some((w) => w.address === op) },
  async settled () { return ZeroHash }
}
const result = (unit) => '0x' + (BigInt(unit) + 1n).toString(16).padStart(64, '0')
async function work (w, unit, res = result(unit)) {
  return { v: 1, job: job.id, unit: String(unit), role: job.role, device, result: res, operator: w.address, node: 'bb', detail: {}, signature: await w.signMessage(getBytes(workStatement(ctx, job.id, BigInt(unit), res))) }
}
function memory () {
  const batches = {}
  return { floor: null, get: (k) => batches[k], set: (k, v) => { batches[k] = v } }
}
function settler (me, mem, published, reg = registry, j = job) {
  return new Settler({
    registry: reg,
    operator: me,
    ctx,
    jobs: new Map([[j.id, j]]),
    settleDelayMs: 20,
    backupMs: 60000,
    batchGraceMs: 60,
    batchIdleMs: 300,
    batchMemory: () => mem,
    publish: async (topic, payload) => published.push(JSON.parse(payload))
  })
}

// 1. forged work in the node's own name, and bad signatures, count for nothing
{
  const out = []
  const victim = settler(A, memory(), out)
  for (const unit of [0, 1, 2]) {
    const forged = await work(B, unit) // signed by B...
    await victim.add({ ...forged, operator: A.address }) // ...but naming the victim
    await victim.add({ ...(await work(B, unit)), signature: '0x' + '00'.repeat(65) })
    await victim.add({ ...(await work(C, unit)), operator: A.address })
  }
  await sleep(500)
  check('work in this node\'s name from others, and bad signatures, are not counted and nothing is signed', out.length === 0 && victim.stats.batchesSigned === 0 && victim.stats.forged >= 3, `forged ${victim.stats.forged}, signed ${victim.stats.batchesSigned}`)
  victim.close()
}

// 2. a malleated (high s) copy of a good signature is refused and replaces nothing
{
  const out = []
  const s = settler(A, memory(), out)
  const good = await work(B, 10)
  const sig = getBytes(good.signature)
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
  const high = new Uint8Array(sig)
  high.set(getBytes('0x' + (n - BigInt(hexlify(sig.subarray(32, 64)))).toString(16).padStart(64, '0')), 32)
  high[64] = sig[64] === 27 ? 28 : 27
  await s.add(good)
  await s.add({ ...good, signature: hexlify(high) })
  const kept = s.units.get(job.id + ':10').results.get(good.result).get(B.address)
  check('a malleated copy of a signature is refused; the good one stays', recoverSigner(workStatement(ctx, job.id, 10n, good.result), hexlify(high)) === null && kept.signature === good.signature && s.stats.forged === 1)
  s.close()
}

// 3. one statement per batch, even after a restart that brings more units
{
  const mem = memory()
  const out1 = []
  const before = settler(A, mem, out1)
  for (const unit of [0, 1]) {
    await before.add(await work(A, unit), { own: true })
    await before.add(await work(B, unit))
  }
  await before.add(await work(A, 3), { own: true }) // a unit of the next batch: batch 0 closes (grace 60 ms)
  await sleep(200)
  before.close()
  const first = out1.find((m) => m.kind === 'batch' && m.batch === '0')
  // restart: the same disk, and now all three units of batch 0 (unit 2 replayed late)
  const out2 = []
  const after = settler(A, mem, out2)
  for (const unit of [0, 1, 2]) {
    await after.add(await work(A, unit), { own: true })
    await after.add(await work(B, unit))
  }
  await after.add(await work(A, 3), { own: true })
  await sleep(200)
  after.close()
  const second = out2.find((m) => m.kind === 'batch' && m.batch === '0')
  check('before the restart the node signed batch 0 with the 2 units it had', first && first.units === 2)
  check('after a restart it sends the same statement again, never one with 3 units', second && second.root === first.root && second.units === 2 && second.signature === first.signature && after.stats.batchesSigned === 0)
}

// 4. a node that saw a unit late adopts its peer's statement: one root
{
  const outA = []
  const outB = []
  const a = settler(A, memory(), outA)
  const b = settler(B, memory(), outB)
  // A sees a quorum on units 21..23 (batch 7 with 3 units a batch)
  const units = [21, 22, 23]
  for (const u of units) {
    await a.add(await work(A, u), { own: true })
    await a.add(await work(B, u))
    await b.add(await work(B, u), { own: true })
  }
  // B saw A's work only for 21 and 22: a quorum on two units; it signed all three itself
  for (const u of [21, 22]) await b.add(await work(A, u))
  await sleep(150) // A's batch is full: A signs 3 units after 40 ms
  const fromA = outA.find((m) => m.kind === 'batch')
  if (fromA) b.add(fromA) // A's statement reaches B before B's batch closes
  await b.add(await work(B, 24), { own: true }) // B moves on: its batch 7 closes after the grace
  await sleep(500)
  const fromB = outB.find((m) => m.kind === 'batch' && m.batch === '7')
  check('A signs the batch with 3 units; B, with 2 agreed, adopts A\'s statement: one root', fromA && fromB && fromA.units === 3 && fromB.root === fromA.root && b.stats.batchesAdopted === 1, `A ${fromA && fromA.units} units, B ${fromB && fromB.units} units`)
  // and a statement with a unit B never signed is not adopted
  const c = settler(C, memory(), [])
  check('a statement with units this node did not sign is not adoptable', !c._adoptable(c._batch(job, 7n), { leaves: fromA.leaves, forwarder: ZeroAddress }))
  a.close(); b.close(); c.close()
}

// a statement by w for batch `batch` of job j with these [unit, result] leaves
async function statement (w, j, batch, leaves, forwarder = ZeroAddress) {
  leaves = leaves.map(([u, r]) => [String(u), r])
  const root = merkleRoot(leaves.map(([u, r]) => batchLeaf(u, r)))
  const signature = await w.signMessage(getBytes(batchStatement(ctx, j.id, BigInt(batch), root, leaves.length, forwarder)))
  return { v: 1, kind: 'batch', job: j.id, batch: String(batch), root, units: leaves.length, forwarder, operator: w.address, signature, leaves }
}

// 5. a peer's statement arriving while the node signs starts no second signing
{
  const out = []
  const mem = memory()
  // the chain answers slowly: the node waits in _signBatch
  const slow = { ...registry, connect () { return this }, async settled () { await sleep(80); return ZeroHash } }
  const s = settler(A, mem, out, slow)
  for (const u of [30, 31]) {
    await s.add(await work(A, u), { own: true })
    await s.add(await work(B, u))
  }
  await s.add(await work(A, 32), { own: true }) // A signed unit 32 too, but saw no one else's
  const b = s.batches.get(job.id + ':10')
  const signing = s._signBatch(b) // closes now: it would sign units 30 and 31
  await sleep(10)
  // B's statement, with all three units, which A can adopt, arrives mid-signing
  await s.add(await statement(B, job, 10, [30, 31, 32].map((u) => [u, result(u)])))
  await signing
  await sleep(300)
  const mine = out.filter((m) => m.kind === 'batch' && m.batch === '10')
  check('a statement that arrives while the node signs a batch does not start a second signing: one statement', mine.length === 1 && s.stats.batchesSigned === 1 && mem.get('10').root === mine[0].root, `${mine.length} statements, ${s.stats.batchesSigned} signed`)
  s.close()
}

// 6. keys not staked for the role cannot fill the batch; a node gets one statement
{
  const out = []
  const s = settler(A, memory(), out)
  const doubles = []
  s.on('double-batch', (d) => doubles.push(d))
  for (const u of [40, 41, 42]) {
    await s.add(await work(A, u), { own: true })
    await s.add(await work(B, u))
  }
  const b = s.batches.get(job.id + ':13')
  // twenty unstaked keys, each with a different (valid-looking) statement
  for (let i = 0; i < 20; i++) {
    const junk = Wallet.createRandom()
    await s.add(await statement(junk, job, 13, [[39 + 1, '0x' + String(i + 1).padStart(64, '0')]]))
  }
  // C (staked) signs a real one; then B (staked) signs one, then another
  const real = await statement(C, job, 13, [40, 41, 42].map((u) => [u, result(u)]))
  await s.add(real)
  await s.add(await statement(B, job, 13, [40, 41, 42].map((u) => [u, result(u)])))
  await s.add(await statement(B, job, 13, [40, 41].map((u) => [u, result(u)])))
  check('statements from keys not active in the role are dropped and fill nothing', s.stats.inactiveBatches === 20 && ![...b.by.keys()].some((op) => ![A, B, C].some((w) => w.address === op)), `dropped ${s.stats.inactiveBatches}`)
  check('a staked node\'s real statement still counts after the junk', b.sigs.get(real.root + ':3:' + ZeroAddress)?.has(C.address))
  check('a second, different statement by the same node is reported as a double batch, not kept', doubles.length === 1 && doubles[0].operator === B.address && doubles[0].a.units === 3 && doubles[0].b.units === 2 && [...b.sigs.values()].filter((g) => g.has(B.address)).length === 1)
  await sleep(300)
  s.close()
}

// 7. a forward job's statement is adopted only when it pays the forwarder this node witnessed
{
  const fjob = { id: 2, role: ROLES.FORWARD, quorum: 1, batchUnits: 2, device }
  const [F1, F2] = [Wallet.createRandom(), Wallet.createRandom()]
  const s = settler(A, memory(), [], registry, fjob)
  const res = (u) => '0x' + (BigInt(u) + 7n).toString(16).padStart(64, '0')
  for (const u of [0, 1]) s._own(fjob, BigInt(u), res(u), F1.address)
  const b = s._batch(fjob, 0n)
  const leaves = [[0, res(0)], [1, res(1)]].map(([u, r]) => [String(u), r])
  check('a forward statement for the forwarder this node witnessed is adoptable', s._adoptable(b, { leaves, forwarder: F1.address }))
  check('the same leaves paying another forwarder are not', !s._adoptable(b, { leaves, forwarder: F2.address }) && !s._adoptable(b, { leaves, forwarder: ZeroAddress }))
  s.close()
}

// 8. a damaged batch memory file signs nothing; a missing one is empty; leaves are not stored
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-batchmem-'))
  const logs = []
  const node = { storage: dir, signedDir: path.join(dir, 'signed'), log: (m) => logs.push(m) }
  fs.mkdirSync(path.join(dir, 'signed'))
  fs.writeFileSync(path.join(dir, 'signed', '1-batches.json'), '{"floor":null,"batches":{"3":')
  const broken = BoatNode.prototype.batchMemoryOf.call(node, 1)
  const fresh = BoatNode.prototype.batchMemoryOf.call(node, 2)
  const out = []
  const s = settler(A, broken, out)
  for (const u of [50, 51, 52]) {
    await s.add(await work(A, u), { own: true })
    await s.add(await work(B, u))
  }
  await sleep(300)
  check('a batch memory file that cannot be read is not taken as empty: no batch is signed', broken.broken && out.length === 0 && s.stats.batchesSigned === 0 && s.stats.memoryBroken >= 1 && logs.length === 1)
  s.close()
  fresh.set('16', { root: '0x' + '01'.repeat(32), units: 1, message: { kind: 'batch', root: '0x' + '01'.repeat(32), leaves: [['48', '0x' + '02'.repeat(32)]] } })
  const again = BoatNode.prototype.batchMemoryOf.call({ ...node, _batchMem: new Map() }, 2)
  check('a missing file is an empty memory; what is set is on disk, without its leaves', !fresh.broken && again.get('16')?.root === '0x' + '01'.repeat(32) && again.get('16').message.leaves === undefined)
  fs.rmSync(dir, { recursive: true, force: true })
}

// 9. pruning keeps a batch whose settlement is still being retried
{
  const s = settler(A, memory(), [])
  s.maxAgeMs = 1000
  const b = s._batch(job, 99n)
  b.mine = { root: ZeroHash, units: 1, forwarder: ZeroAddress }
  b.at = Date.now() - 2000
  b.timer = setTimeout(() => {}, 60000)
  const idle = s._batch(job, 98n)
  idle.at = Date.now() - 2000
  s._prune()
  check('a batch older than maxAgeMs with a retry pending stays; one with nothing pending goes', s.batches.has(job.id + ':99') && !s.batches.has(job.id + ':98'))
  b.at = Date.now() - 5000
  s._prune()
  check('...but not beyond four times maxAgeMs', !s.batches.has(job.id + ':99'))
  clearTimeout(b.timer)
  s.close()
}

// 10. a relay re-casing a root makes no second statement (review 3, H1)
{
  const s = settler(A, memory(), [])
  const doubles = []
  s.on('double-batch', (d) => doubles.push(d))
  for (const u of [60, 61, 62]) {
    await s.add(await work(A, u), { own: true })
    await s.add(await work(B, u))
  }
  await sleep(250) // A signs batch 20
  const genuine = await statement(B, job, 20, [60, 61, 62].map((u) => [u, result(u)]))
  await s.add({ ...genuine, root: '0x' + genuine.root.slice(2).toUpperCase() }) // the relay's copy first
  await s.add(genuine)
  const b = s.batches.get(job.id + ':20')
  const group = b.mine && b.sigs.get(b.mine.root + ':' + b.mine.units + ':' + ZeroAddress)
  check('a re-cased copy of a statement is the same statement: no double batch, and it counts with this node\'s', doubles.length === 0 && group && group.has(B.address) && group.size === 2 && !!b.timer, `${doubles.length} doubles, group ${group && group.size}`)
  s.close()
}

// 11. two statements by one node arriving together are still evidence (L1)
{
  const s = settler(A, memory(), [])
  const doubles = []
  s.on('double-batch', (d) => doubles.push(d))
  for (const u of [70, 71]) await s.add(await work(A, u), { own: true })
  const one = await statement(B, job, 23, [[70, result(70)]])
  const two = await statement(B, job, 23, [[70, result(70)], [71, result(71)]])
  await Promise.all([s.add(one), s.add(two)])
  check('two statements by one node that arrive at once are reported as a double batch', doubles.length === 1)
  s.close()
}

// 12. a batch still filling is not pruned after maxAgeMs (M1)
{
  const s = settler(A, memory(), [])
  s.maxAgeMs = 1000
  await s.add(await work(A, 90), { own: true })
  const b = s.batches.get(job.id + ':30')
  b.at = Date.now() - 5000 // made long ago, but a unit came in just now
  s._prune()
  check('a batch that is still filling stays, however old it is', s.batches.has(job.id + ':30'))
  b.last = Date.now() - 5000
  s._prune()
  check('...and goes once nothing came in for maxAgeMs', !s.batches.has(job.id + ':30'))
  s.close()
}

// 13. after a restart, the units a node signed before are back in its batches (M2)
{
  const s = settler(A, memory(), [])
  const kept = {}
  for (const u of [100, 101]) {
    const w = await work(A, u)
    kept[String(u)] = { result: w.result, signature: w.signature, forwarder: null }
  }
  const node = { workers: new Map([[job.id, [{ mode: null, memory: { entries: () => Object.entries(kept) } }]]]), operator: A, ctx, settler: s }
  BoatNode.prototype.replayOwn.call(node, job)
  await sleep(50)
  check('units signed before a restart are this node\'s again in the Settler', s.ownResults.has(job.id + ':100') && s.ownResults.has(job.id + ':101') && s.stats.forged === 0)
  s.close()
}

// 14. a batch is not idle while the job's units come at their usual pace (long-run finding)
{
  const s = settler(A, memory(), [])
  s.batchIdleMs = 50
  const j7 = { ...job, batchUnits: 6 }
  s.jobs.set(job.id, j7)
  for (const u of [120, 121]) {
    await s.add(await work(A, u), { own: true })
    await s.add(await work(B, u))
    if (u === 120) await sleep(150)
  }
  const b = s.batches.get(job.id + ':20')
  await sleep(250) // past batchIdleMs, within three gaps of 150 ms
  const early = !!b.mine
  await sleep(500)
  check('a batch waits three of its job\'s usual unit gaps before closing as idle, not batchIdleMs', !early && b.mine && b.mine.units === 2, `signed early ${early}`)
  s.jobs.set(job.id, job)
  s.close()
}

// 15. units replayed after a restart, or caught up in a burst, are not the job's pace
{
  const s = settler(A, memory(), [])
  const kept = {}
  for (const u of [130, 131, 132]) {
    const w = await work(A, u)
    kept[String(u)] = { result: w.result, signature: w.signature, forwarder: null }
  }
  const node = { workers: new Map([[job.id, [{ mode: null, memory: { entries: () => Object.entries(kept) } }]]]), operator: A, ctx, settler: s }
  BoatNode.prototype.replayOwn.call(node, job)
  await sleep(5)
  check('replayed units do not set the pace of a job', !s.gaps.has(job.id))
  for (const u of [133, 134, 135]) await s.add(await work(A, u), { own: true })
  check('units caught up in a burst do not set it either', s.gaps.get(job.id).gap === 0, `gap ${s.gaps.get(job.id).gap}`)
  s.close()
  for (const b of s.batches.values()) for (const t of [b.idle, b.closing]) if (t) clearTimeout(t)
}

// 16. a close that found nothing to sign does not stop the batch closing later
{
  const out = []
  const s = settler(A, memory(), out)
  await s.add(await work(A, 141), { own: true }) // batch 47, nothing agreed yet
  const b = s.batches.get(job.id + ':47')
  s._close(b, 0)
  await sleep(30)
  check('a batch with nothing to sign stays unsigned', !b.mine)
  for (const u of [141, 142, 143]) {
    if (u !== 141) await s.add(await work(A, u), { own: true })
    await s.add(await work(B, u))
  }
  await sleep(150)
  check('...and signs when its units come', b.mine && b.mine.units === 3, `units ${b.mine && b.mine.units}`)
  s.close()
}

// 16b. a peer's smaller statement does not wake a node into signing what it holds
{
  const s = settler(A, memory(), [])
  s.batchIdleMs = 60000
  const wide = { ...job, batchUnits: 6 }
  s.jobs.set(job.id, wide)
  await s.add(await work(A, 300), { own: true }) // batch 50, nothing agreed yet
  const b = s.batches.get(job.id + ':50')
  await s._signBatch(b) // closed once with nothing to sign
  for (const u of [301, 302]) {
    await s.add(await work(A, u), { own: true })
    await s.add(await work(B, u))
  }
  const leaves = [['301', result(301)]]
  const root = merkleRoot(leaves.map(([u, r]) => batchLeaf(u, r)))
  const signature = await C.signMessage(getBytes(batchStatement(ctx, job.id, b.batch, root, 1, ZeroAddress)))
  await s.add({ v: 1, kind: 'batch', job: job.id, batch: String(b.batch), root, units: 1, forwarder: ZeroAddress, operator: C.address, signature, leaves })
  await sleep(40)
  check('a smaller statement from a peer does not make a node sign early', !b.mine && b.units.size === 2, `units ${b.mine && b.mine.units}`)
  s.jobs.set(job.id, job)
  s.close()
  for (const o of s.batches.values()) for (const t of [o.idle, o.closing]) if (t) clearTimeout(t)
}

// 17. after restarts, the node holding the most units signs first and the rest adopt it
{
  const big = { ...job, id: 2, batchUnits: 6 }
  const nodes = [A, B, C].map((w) => ({ w, s: null, out: [] }))
  for (const n of nodes) {
    n.s = settler(n.w, memory(), n.out, registry, big)
    n.s.batchGraceMs = 40
    n.s.publish = async (_t, payload) => { for (const o of nodes) if (o !== n) await o.s.add(JSON.parse(payload)) }
  }
  const signed = async (w, u) => ({ ...(await work(w, u)), job: big.id, signature: await w.signMessage(getBytes(workStatement(ctx, big.id, BigInt(u), result(u)))) })
  // every node signed units 0..5; each knows a quorum for a different number of them
  const known = [2, 5, 3]
  for (const [i, n] of nodes.entries()) {
    for (let u = 0; u < 6; u++) await n.s.add(await signed(n.w, u), { own: true, replay: true })
    const other = nodes[(i + 1) % 3].w
    for (let u = 6 - known[i]; u < 6; u++) await n.s.add(await signed(other, u))
  }
  await Promise.all(nodes.map(async (n) => n.s.add(await signed(n.w, 6), { own: true }))) // the next batch begins
  await sleep(400)
  const mine = nodes.map((n) => n.s.batches.get(big.id + ':0').mine)
  check('nodes that restarted mid-batch sign one statement, the fullest', mine.every((m) => m && m.units === 5 && m.root === mine[1].root), mine.map((m) => m && m.units).join('/'))
  for (const n of nodes) {
    n.s.close()
    for (const b of n.s.batches.values()) for (const t of [b.idle, b.closing, b.timer]) if (t && t !== true) clearTimeout(t)
  }
}

// ---- what goes out (a job out of budget once burned every node's gas) --------

// a registry whose settleBatchMany counts simulations and sends
function sending ({ simulate = async () => 1n, send = async () => {} } = {}) {
  const calls = { simulated: 0, sent: 0 }
  const method = async () => {
    calls.sent++
    await send(calls.sent)
    return { nonce: calls.sent, wait: async () => ({ logs: [], gasUsed: 1n }) }
  }
  method.staticCall = async () => {
    calls.simulated++
    return simulate(calls.simulated)
  }
  return { calls, reg: { ...registry, settleBatchMany: method, settleMany: method } }
}
const sender = (reg, opts = {}) => new Settler({
  registry: reg,
  operator: { address: A.address, provider: { getTransactionCount: async () => 1e9 } },
  ctx,
  jobs: new Map([[job.id, job]]),
  batchMs: 3600000, // flushed by hand
  ...opts
})
const queued = (n = 0) => ({ kind: 'batch', k: `b:${job.id}:${n}`, b: { done: false }, job, batch: BigInt(n), root: ZeroHash, units: 3, forwarder: ZeroAddress, sigs: [], signers: 2, attempt: 12 })

// 15. a transaction that would settle nothing is not sent
{
  const { calls, reg } = sending({ simulate: async () => 0n })
  const s = sender(reg)
  s.queue.push(queued())
  await s._flush()
  check('a settlement the simulation says settles nothing is not sent', calls.simulated === 1 && calls.sent === 0 && s.stats.notSent === 1 && s.queue.length === 0, `sent ${calls.sent}`)
  s.close()
}

// 16. one that settles something is
{
  const { calls, reg } = sending()
  const s = sender(reg)
  s.queue.push(queued())
  await s._flush()
  check('a settlement that would settle something is sent once', calls.simulated === 1 && calls.sent === 1 && s.stats.notSent === 0)
  s.close()
}

// 17. out of gas: one try, a long wait, and the settlement is still there
{
  const { calls, reg } = sending({ send: async (n) => { if (n === 1) throw Object.assign(new Error('insufficient funds for intrinsic transaction cost'), { code: 'INSUFFICIENT_FUNDS' }) } })
  const s = sender(reg, { noGasHoldMs: 120 })
  s.queue.push(queued())
  await s._flush()
  const kept = s.queue.length === 1
  await s._flush() // within the hold
  const held = calls.sent === 1 && calls.simulated === 1
  await sleep(150)
  await s._flush()
  check('out of gas the node stops sending for a while, keeps the settlement, and sends it once it can', kept && held && calls.sent === 2 && s.queue.length === 0, `sent ${calls.sent}, queued ${s.queue.length}`)
  s.close()
}

// 18. a rate-limited RPC: the wait doubles, and a success ends it
{
  const { calls, reg } = sending({ simulate: async (n) => { if (n <= 2) throw new Error('could not coalesce error (rate limit exceeded)'); return 1n } })
  const s = sender(reg, { holdMs: 20, maxHoldMs: 1000 })
  s.queue.push(queued())
  await s._flush()
  const first = s._holdFor
  await sleep(30)
  await s._flush()
  const second = s._holdFor
  await sleep(50)
  await s._flush()
  check('after RPC errors the wait doubles, and a send that works ends it', first === 20 && second === 40 && s._holdFor === 0 && calls.sent === 1, `waits ${first}, ${second}, then ${s._holdFor}`)
  s.close()
}

// 19. an error that does not pass is not retried for ever
{
  const { calls, reg } = sending({ simulate: async () => { throw new Error('some other error') } })
  const s = sender(reg, { holdMs: 1, maxHoldMs: 1 })
  s.queue.push(queued())
  for (let i = 0; i < 8 && s.queue.length; i++) {
    await sleep(3)
    await s._flush()
  }
  check('a settlement that keeps failing to send leaves the queue', s.queue.length === 0 && calls.simulated === 6 && calls.sent === 0, `tried ${calls.simulated}`)
  s.close()
}

// 20. the queue has an end, and keeps the newest
{
  const { reg } = sending()
  const s = sender(reg, { maxQueue: 3 })
  s._holdUntil = Date.now() + 60000
  for (let n = 0; n < 5; n++) s._enqueue(queued(n))
  check('while nothing can be sent the queue keeps only the newest settlements', s.queue.length === 3 && s.stats.dropped === 2 && s.queue[0].batch === 2n)
  s.close()
}

// 21. a job out of budget: its workers stop, and start again when it is funded
{
  let spent = true
  let closed = 0
  let started = 0
  let replayed = 0
  const paused = { id: 9, role: ROLES.STORE, device, batchUnits: 3 }
  const worker = { mode: null, close: async () => { closed++ } }
  const node = {
    syncChain: async () => {},
    auditor: null,
    jobs: new Map([[9, paused]]),
    workers: new Map([[9, [worker]]]),
    waiting: new Map(),
    seenJobs: 10,
    registry: { jobCount: async () => 10n },
    chain: { block: 1, state: { jobCount: 10, jobs: { 9: {} } }, isSpent: () => spent },
    log: () => {},
    pause: BoatNode.prototype.pause,
    assigned: async () => true,
    ensureWorkers: async (j) => { started++; node.workers.set(j.id, [worker]); return true },
    replayOwn: () => { replayed++ }
  }
  await BoatNode.prototype.pollJobs.call(node)
  await BoatNode.prototype.pollJobs.call(node)
  check('a job out of budget loses its workers once and stays known to the node', closed === 1 && !node.workers.has(9) && node.jobs.has(9) && started === 0, `closed ${closed}, started ${started}`)
  spent = false
  await BoatNode.prototype.pollJobs.call(node)
  check('funded again, its workers start and its signed units are replayed', started === 1 && replayed === 1 && node.workers.has(9))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
