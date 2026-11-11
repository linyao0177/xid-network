// Job assignment with capacities (lib/assign.js), no chain: node test/assign.js

import { Wallet } from 'ethers'
import { assignJobs, ROLES } from '../index.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}

const ops = Array.from({ length: 8 }, () => Wallet.createRandom().address)
const dev = (i) => Buffer.alloc(32, i + 1).toString('hex')
const active = new Map([[ROLES.STORE, ops], [ROLES.VERIFY, ops.slice(0, 6)], [ROLES.COMPUTE, ops]])
const jobs = []
for (let i = 0; i < 40; i++) jobs.push({ id: i, device: dev(i % 10), role: [ROLES.STORE, ROLES.COMPUTE, ROLES.FORWARD, ROLES.VERIFY][i % 4], quorum: 2 })

// no limits: every job gets quorum + spare nodes, a device's jobs of one role the same ones
const free = assignJobs(jobs, active, new Map(), 1)
check('without limits every job gets quorum + spare nodes', [...free.plan.values()].every((o) => o.length === 3))
const sameDevice = jobs.filter((j) => j.device === dev(0) && j.role === ROLES.STORE).map((j) => free.plan.get(j.id).join())
check('a device\'s jobs of one role go to the same nodes', new Set(sameDevice).size === 1)
check('forward jobs are witnessed by verifiers', jobs.filter((j) => j.role === ROLES.FORWARD).every((j) => free.plan.get(j.id).every((op) => ops.slice(0, 6).includes(op))))

// the same answer whatever order the jobs were read in
const shuffled = [...jobs].sort(() => Math.random() - 0.5)
const again = assignJobs(shuffled, active, new Map(), 1)
check('the plan does not depend on the order jobs were read in', jobs.every((j) => again.plan.get(j.id).join() === free.plan.get(j.id).join()))

// capacities: no node over its limit; the work moves to the next ranked nodes
const capacity = new Map(ops.map((op) => [op, 30])) // room for all 120 assignments, the 6 verifiers included
capacity.set(ops[0], 3)
const capped = assignJobs(jobs, active, capacity, 1)
const over = ops.filter((op) => (capped.load.get(op) || 0) > (capacity.get(op) || Infinity))
check('no node holds more jobs than its capacity', over.length === 0, ops.map((op) => `${capped.load.get(op) || 0}/${capacity.get(op)}`).join(' '))
check('a node with capacity 3 gets 3 jobs, the rest go to others, and every job is still fully staffed', capped.load.get(ops[0]) === 3 && [...capped.plan.values()].every((o) => o.length === 3))

// a node lowering its capacity keeps its first jobs (in id order), not random ones
const first = jobs.filter((j) => free.plan.get(j.id).includes(ops[0])).map((j) => j.id)
const kept = jobs.filter((j) => capped.plan.get(j.id).includes(ops[0])).map((j) => j.id)
check('a node that lowers its capacity keeps its earliest jobs', kept.join() === first.slice(0, 3).join(), `kept ${kept.join(',')}`)

// not enough room: a job gets what there is
const tight = assignJobs(jobs, active, new Map(ops.map((op) => [op, 2])), 1)
const total = [...tight.plan.values()].reduce((a, o) => a + o.length, 0)
check('when the network is full, jobs past its room get fewer nodes (at least their quorum, or none), never an overloaded one', total <= 16 && total >= 14 && [...tight.plan.entries()].every(([id, o]) => o.length === 0 || o.length >= jobs[id].quorum) && ops.every((op) => (tight.load.get(op) || 0) <= 2), `${total} assignments for 8 nodes of capacity 2`)

// stability: a capacity cut applies to jobs posted after it, never to earlier ones
const at20 = new Map(ops.map((op) => [op, { steps: [[0, 0]], sinceJob: 0 }]))
const plan0 = assignJobs(jobs, active, at20, 1).plan
const cut = new Map(at20)
cut.set(ops[0], { steps: [[0, 0], [20, 1]], sinceJob: 0 }) // set to 1 when 20 jobs existed
const plan1 = assignJobs(jobs, active, cut, 1).plan
const early = jobs.filter((j) => j.id < 20)
check('lowering a capacity moves none of the jobs posted before the change', early.every((j) => plan1.get(j.id).join() === plan0.get(j.id).join()))
const lateJobs = jobs.filter((j) => j.id >= 20 && plan1.get(j.id).includes(ops[0])).length
check('after the change, later jobs go to the node only while its load (earlier jobs included) is under the new capacity', lateJobs <= 1, `${lateJobs} later jobs`)

// lowered for overload, then raised back: neither change moves earlier jobs
// (with only the last change kept, the jobs between the two were capped at
// the lowered value and moved: review N3)
const back = new Map(at20)
back.set(ops[0], { steps: [[0, 0], [20, 1], [25, 0]], sinceJob: 0 })
const plan3 = assignJobs(jobs, active, back, 1).plan
check('lowering a capacity and raising it again moves none of the jobs posted before the first change', early.every((j) => plan3.get(j.id).join() === plan0.get(j.id).join()))
check('...and the jobs posted while it was lowered stay as they were assigned then', jobs.filter((j) => j.id >= 20 && j.id < 25).every((j) => plan3.get(j.id).join() === plan1.get(j.id).join()))

// stability: a node that registers later does not take jobs posted before it
const newcomer = Wallet.createRandom().address
const withNew = new Map(active)
for (const r of [ROLES.STORE, ROLES.VERIFY, ROLES.COMPUTE]) withNew.set(r, [...active.get(r), newcomer])
const nodes2 = new Map(at20)
nodes2.set(newcomer, { steps: [[30, 0]], sinceJob: 30 }) // registered when 30 jobs existed
const plan2 = assignJobs(jobs, withNew, nodes2, 1).plan
check('a node registered later leaves the jobs posted before it to the nodes that had them', jobs.filter((j) => j.id < 30).every((j) => plan2.get(j.id).join() === plan0.get(j.id).join()))

// a job whose quorum the role cannot meet takes no room (review 3, H2): jobs
// with a huge quorum posted first leave later jobs fully staffed
const greedy = [0, 1, 2].map((i) => ({ id: i, device: dev(i), role: ROLES.STORE, quorum: 32 }))
const honest = { id: 3, device: dev(3), role: ROLES.STORE, quorum: 2 }
const full = assignJobs([...greedy, honest], active, new Map(ops.map((op) => [op, 3])), 1)
check('a job that can never reach its quorum gets no node and holds no room', greedy.every((j) => full.plan.get(j.id).length === 0) && full.plan.get(3).length === 3)
const five = [0, 1, 2, 3, 4].map((i) => ({ id: i, device: dev(i), role: ROLES.STORE, quorum: 3 }))
const short = assignJobs(five, active, new Map(ops.map((op) => [op, 1])), 0) // room for 8: two jobs of 3, and 2 left over
check('nor does a job that finds room for only part of its quorum', [...short.plan.values()].filter((o) => o.length === 3).length === 2 && [...short.plan.values()].filter((o) => o.length === 0).length === 3)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
