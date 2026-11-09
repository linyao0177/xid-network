// A snapshot of a deployed network from the chain, as JSON files for a
// dashboard: nodes, jobs, units settled per hour by kind of job, slashes and
// a summary row.
//
// usage: node examples/snapshot.js --deployment <file> --out <dir>
//        [--names '{"0x..":"gcp"}'] [--hours 48] [--chunk 10000] [--abi <artifact json>]
//
// --abi: an older deployment's contract (the iteration 2 registry has no
// delegation and fewer job fields).
//
// Amounts are in the stake token's units (6 decimals). Logs are read in
// chunks of --chunk blocks (public RPCs limit a range).

import fs from 'fs'
import path from 'path'
import { formatUnits, Contract } from 'ethers'
import { attach, providerFor, ROLES } from '../index.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const dep = JSON.parse(fs.readFileSync(opt('deployment'), 'utf8'))
const out = opt('out')
const names = JSON.parse(opt('names', '{}'))
const hours = Number(opt('hours', 48))
const chunk = Number(opt('chunk', 10000))
fs.mkdirSync(out, { recursive: true })

const provider = await providerFor(dep.rpc)
const reg = opt('abi') ? new Contract(dep.registry, JSON.parse(fs.readFileSync(opt('abi'), 'utf8')).abi, provider) : attach(dep.registry, provider)
const usd = (x) => Number(formatUnits(x, 6))
const roleNames = (bits) => Object.entries(ROLES).filter(([, b]) => Number(bits) & b).map(([n]) => n.toLowerCase()).join(', ')
const kindOf = (role) => ({ 1: 'forward', 2: 'store', 4: 'verify', 8: 'compute' })[Number(role)]
const nameOf = (op) => names[op] || names[op.toLowerCase()] || op.slice(0, 8) + '…'

// logs since the deployment (or the last --hours), in chunks
const head = await provider.getBlockNumber()
const headBlock = await provider.getBlock(head)
const from = Math.max(Number(dep.block), head - Math.ceil((hours * 3600) / 0.5))
async function logs (filter) {
  const all = []
  for (let a = from; a <= head; a += chunk) all.push(...(await reg.queryFilter(filter, a, Math.min(head, a + chunk - 1))))
  return all
}
const times = new Map()
async function timeOf (block) {
  if (!times.has(block)) times.set(block, (await provider.getBlock(block)).timestamp)
  return times.get(block)
}

// jobs
const jobCount = Number(await reg.jobCount())
const jobs = []
for (let i = 0; i < jobCount; i++) {
  const j = await reg.jobs(i)
  jobs.push({ job: i, kind: kindOf(j.role), quorum: Number(j.quorum), pay: usd(j.pay), budget_left: usd(j.budget), open: j.closesAt === 0n, units_settled: 0, paid: 0 })
}

// settlements per hour, by kind
const settled = await logs(reg.filters.Settled())
const perHour = new Map()
for (const e of settled) {
  const t = await timeOf(e.blockNumber)
  const hour = new Date(Math.floor(t / 3600) * 3600 * 1000).toISOString()
  const job = jobs[Number(e.args.id)]
  if (!job) continue
  job.units_settled++
  job.paid += usd(e.args.pay)
  if (!perHour.has(hour)) perHour.set(hour, { hour, verify: 0, store: 0, compute: 0, forward: 0 })
  perHour.get(hour)[job.kind]++
}
const settlements = [...perHour.values()].sort((a, b) => (a.hour < b.hour ? -1 : 1))

// slashes
const slashes = []
for (const e of await logs(reg.filters.Slashed())) {
  slashes.push({ at: new Date((await timeOf(e.blockNumber)) * 1000).toISOString(), node: nameOf(e.args.operator), operator: e.args.operator, amount: usd(e.args.amount), tx: e.transactionHash })
}

// nodes
const nodes = []
const opCount = Number(await reg.operatorCount())
for (let i = 0; i < opCount; i++) {
  const op = await reg.operators(i)
  const n = await reg.nodes(op)
  const [pending, matured] = await reg.rewards(op)
  nodes.push({
    node: nameOf(op),
    operator: op,
    roles: roleNames(n.roles),
    active: n.active,
    stake: usd(n.stake),
    rewards_pending: usd(pending),
    rewards_matured: usd(matured),
    slashed: slashes.filter((s) => s.operator === op).reduce((a, s) => a + s.amount, 0)
  })
}

const summary = [{
  at: new Date(Number(headBlock.timestamp) * 1000).toISOString(),
  block: head,
  chain: dep.chainId,
  registry: dep.registry,
  nodes_active: nodes.filter((n) => n.active).length,
  nodes: nodes.length,
  stake_total: nodes.reduce((a, n) => a + n.stake, 0),
  jobs_open: jobs.filter((j) => j.open).length,
  units_settled: jobs.reduce((a, j) => a + j.units_settled, 0),
  paid_to_nodes: Number(jobs.reduce((a, j) => a + j.paid, 0).toFixed(6)),
  slashes: slashes.length,
  hours_covered: hours
}]

for (const [name, rows] of Object.entries({ summary, nodes, jobs, settlements, slashes })) fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(rows, null, 2) + '\n')
console.log(JSON.stringify(summary[0], null, 2))
process.exit(0)
