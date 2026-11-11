// Who works on which job: the same answer on every node, from the chain alone.
//
// Jobs are taken in id order. For each one, the active nodes of the role
// that does the work (verifiers witness forward jobs) are ranked by
// keccak(operator, device), and the first quorum + spare of them that still
// have room take it. Ranking by device keeps a device's jobs on the same few
// nodes; taking jobs in id order makes the answer the same on every node that
// has read the same jobs. So that the answer stays put over time:
// - a node has room while it holds fewer jobs than its capacity as it was
//   when the job was posted (BoatRegistry.setCapacity applies from the next
//   job on; every change is kept, as steps [first job, capacity], from the
//   events: lib/chain.js; 0 is no limit), so changing it, lowering then
//   raising it again, never moves jobs it already has;
// - a node that registered after a job was posted (sinceJob) takes it only
//   when the nodes registered before cannot staff it;
// - a node that leaves (unbonds, is slashed below the minimum) is replaced by
//   the next in rank, on the jobs it had.
// Greedy in id order: when a role runs short of room, later jobs get fewer
// nodes even where another arrangement would have staffed them all. A job
// that cannot get its quorum (no room left, or a quorum larger than the
// role's nodes) gets no node: it could never settle, and it must not hold
// room that other jobs can use.

import { AbiCoder, keccak256 } from 'ethers'
import { ROLES } from './registry.js'

const abi = AbiCoder.defaultAbiCoder()
// (cached: a plan ranks every node for every job, and plans are made often)
const scores = new Map()
const score = (op, device) => {
  const k = op + device
  let s = scores.get(k)
  if (s === undefined) {
    s = keccak256(abi.encode(['address', 'bytes32'], [op, '0x' + device]))
    if (scores.size > 1000000) scores.clear()
    scores.set(k, s)
  }
  return s
}

// the role whose nodes are assigned to a job: its own, or VERIFY for the
// witnesses of a forward job (every forwarding node may forward for it)
export const assignedRole = (job) => (job.role === ROLES.FORWARD ? ROLES.VERIFY : job.role)

// jobs: [{ id, device, role, quorum }] (open jobs); active: role -> [operator];
// nodes: operator -> { steps: [[first job, capacity], ...] in order, sinceJob }
// (absent: no limit, registered before every job), or a plain number (the
// capacity);
// spare: workers beyond the quorum. Returns Map(job id -> [operator]) and each
// node's load.
export function assignJobs (jobs, active, nodes, spare) {
  const load = new Map()
  const plan = new Map()
  const capOf = (op, id) => {
    const n = nodes.get(op)
    if (n === undefined) return 0
    if (typeof n === 'number') return n
    const steps = n.steps || []
    if (steps.length === 0) return 0
    // the last change before the job; for a job older than every change (the
    // node registered after it), the first
    let cap = steps[0][1]
    for (const [from, c] of steps) {
      if (from > id) break
      cap = c
    }
    return cap
  }
  const since = (op) => { const n = nodes.get(op); return n && typeof n === 'object' ? (n.sinceJob || 0) : 0 }
  for (const job of [...jobs].sort((a, b) => a.id - b.id)) {
    const role = assignedRole(job)
    const want = job.quorum + spare
    const ranked = (active.get(role) || []).map((op) => [score(op, job.device), op]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, op]) => op)
    // nodes registered before the job first, newer ones only to fill it
    const order = [...ranked.filter((op) => since(op) <= job.id), ...ranked.filter((op) => since(op) > job.id)]
    const ops = []
    for (const op of order) {
      if (ops.length >= want) break
      const cap = capOf(op, job.id)
      if (cap !== 0 && (load.get(op) || 0) >= cap) continue
      ops.push(op)
    }
    if (ops.length < job.quorum) {
      plan.set(job.id, [])
      continue
    }
    for (const op of ops) load.set(op, (load.get(op) || 0) + 1)
    plan.set(job.id, ops)
  }
  return { plan, load }
}
