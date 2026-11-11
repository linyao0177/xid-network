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

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
