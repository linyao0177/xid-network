// The audit of settlements (lib/audit.js): a node whose signature settles a
// unit of a job it was not assigned to is found from the chain and slashed by
// the verifiers; the assigned ones, and one that left the job a moment ago,
// are not: node test/audit.js
//
// The contract pays any `quorum` active nodes of the role, so without this
// two staked nodes could settle any job's units. No DHT here: the
// watchtowers hand each other their faults directly.

import { HDNodeWallet, getBytes, toUtf8Bytes, ZeroAddress } from 'ethers'
import { deploy, deployTestToken, register, ROLES, SPEC, ChainView, workStatement, settledKey, Auditor, PlanHistory, signersFromInput, Watchtower, FAULT_BPS } from '../index.js'
import { startChain, MNEMONIC } from './chain.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}

// the plans a node remembers
{
  const h = new PlanHistory({ keep: 50 })
  h.note(10, new Map([[1, ['a', 'b']]]))
  h.note(20, new Map([[1, ['a', 'c']]]))
  h.note(30, new Map([[1, ['a', 'c']]]))
  check('a node on the job throughout is assigned at any block', h.assigned(1, 'a', 10, 10) && h.assigned(1, 'a', 25, 30))
  check('one that left counts until the look that saw it gone', h.assigned(1, 'b', 15, 20) && !h.assigned(1, 'b', 21, 30))
  check('one that joined counts from the look before', h.assigned(1, 'c', 10, 12) && h.assigned(1, 'c', 30, 30))
  check('a node never on the job is not', !h.assigned(1, 'd', 0, 100) && !h.assigned(2, 'a', 0, 100))
  h.note(100, new Map([[1, ['a']]]))
  check('intervals that ended long ago are dropped, open ones kept', !h.assigned(1, 'b', 0, 100) && h.assigned(1, 'a', 10, 10) && h.since === 10 && h.at === 100)
}

const MIN = 100_000000n
const PAY = 1_000000n
const chain = await startChain(8566)
if (!chain) {
  console.log('SKIP anvil not installed')
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, payer, ...rest] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(acct)
  const stores = rest.slice(0, 4)
  const verifiers = rest.slice(4, 7)
  const token = await deployTestToken(admin)
  const tokenAddr = await token.getAddress()
  const reg = await deploy(admin, { token: tokenAddr, minStake: MIN, unbonding: 600, epochLength: 60, jobNotice: 10, jobFee: 0n })
  const regAddr = await reg.getAddress()
  const ctx = { registry: regAddr, chainId: 31337n, nodeKey: '00'.repeat(32) }
  for (const w of [payer, ...rest]) await (await token.mint(w.address, 10000_000000n)).wait()
  await (await token.connect(payer).approve(regAddr, 2n ** 255n)).wait()
  for (const [i, w] of stores.entries()) await register(reg, w, { dhtKey: Buffer.alloc(32, i + 1), roles: ROLES.STORE, stake: MIN, token: tokenAddr })
  for (const [i, w] of verifiers.entries()) await register(reg, w, { dhtKey: Buffer.alloc(32, i + 9), roles: ROLES.VERIFY, stake: MIN, token: tokenAddr })
  const device = '0x' + '7'.repeat(64)
  const post = async () => {
    const r = await (await reg.connect(payer).postJob(device, { role: ROLES.STORE, quorum: 2, perEpoch: 1000, deadline: 0, spec: SPEC.store, pay: PAY, budget: 100n * PAY }, toUtf8Bytes(JSON.stringify({ window: 5 })))).wait()
    return Number(r.logs.map((l) => { try { return reg.interface.parseLog(l) } catch { return null } }).find((e) => e && e.name === 'JobPosted').args.id)
  }
  const mine = async (n = 1) => { for (let i = 0; i < n; i++) await chain.provider.send('evm_mine', []) }
  const job = await post()
  // verifiers vote once they have been one for an epoch
  await chain.provider.send('evm_increaseTime', [120])
  await mine()

  // three verifiers, each with its own view of the chain, audit and watchtower
  const GRACE = 3
  const nodes = verifiers.map((operator) => {
    const view = new ChainView({ registry: reg, step: 1, lag: 0, minStake: MIN, also: Auditor.EVENTS })
    const plan = () => view.plan([ROLES.STORE, ROLES.VERIFY, ROLES.COMPUTE], 1).plan
    const n = { operator, view, plan, events: [] }
    n.sync = async () => { await view.sync(); n.auditor.note(plan()) }
    n.auditor = new Auditor({ registry: reg, ctx, chain: view, graceSteps: GRACE, sync: n.sync })
    n.watch = new Watchtower({ dht: null, registry: reg, operator, ctx, jobs: new Map(), publish: async () => {}, minStake: MIN, submitBackupMs: 300, audit: n.auditor, send: (msg) => { for (const o of nodes) if (o !== n) o.watch.fault(structuredClone(msg)).catch((err) => n.events.push(['error', err.message])) } })
    for (const e of ['fault', 'agree', 'disagree', 'slashed', 'error']) n.watch.on(e, (x) => n.events.push([e, x]))
    n.audit = async () => { await n.sync(); const found = await n.auditor.scan(async () => true); await n.watch.unassigned(found); return found }
    return n
  })
  for (const n of nodes) await n.sync()
  const assigned = nodes[0].plan().get(job)
  const outsider = stores.find((s) => !assigned.includes(s.address))
  check('the plan gives the job quorum + spare of the four stores', assigned.length === 3 && !!outsider)

  const sign = async (signers, unit, result) => {
    const h = workStatement(ctx, job, unit, result)
    const sigs = []
    for (const w of signers.slice().sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))) sigs.push(await w.signMessage(getBytes(h)))
    return sigs
  }
  const wallet = (address) => stores.find((s) => s.address === address)
  const R = '0x' + 'ab'.repeat(32)

  // too early: the verifiers have not watched for the grace period yet
  const early = await (await reg.connect(outsider).settle(job, 1n, R, await sign([outsider, wallet(assigned[0])], 1n, R))).wait()
  const foundEarly = await nodes[0].audit()
  check('a verifier that has not watched long enough does not judge', foundEarly.length === 0 && nodes[0].auditor.stats.unjudged === 2, JSON.stringify(nodes[0].auditor.stats))
  check('and tells another it cannot (no agreement from it)', (await nodes[0].auditor.assignedAt(job, outsider.address, early.blockNumber)) === null)

  await mine(GRACE + 2)
  for (const n of nodes) await n.audit()

  // the assigned nodes settle a unit: nothing to find
  const good = await (await reg.connect(admin).settle(job, 2n, R, await sign([wallet(assigned[0]), wallet(assigned[1])], 2n, R))).wait()
  const by = good.logs.map((l) => { try { return reg.interface.parseLog(l) } catch { return null } }).find((e) => e && e.name === 'SettledBy')
  check('the registry names the signers it counted', !!by && by.args.signers.length === 2 && [...by.args.signers].every((s) => assigned.includes(s)))
  const none = await nodes[0].audit()
  check('a unit settled by assigned nodes is fine', none.length === 0 && nodes[0].events.length === 0)

  // the signers, from the transaction alone (a registry without SettledBy)
  const roleOf = (op) => stores.some((s) => s.address === op)
  const tx = await chain.provider.getTransaction(good.hash)
  const fromInput = signersFromInput(reg, ctx, tx.data, job, '2', roleOf)
  check('the same signers are read from a settle() transaction', fromInput.slice().sort().join() === [...by.args.signers].sort().join())

  // an outsider and one assigned node settle a unit, in a settleMany
  const before = (await reg.nodes(outsider.address)).stake
  const items = [{ id: job, unit: 3n, result: R, forwarder: ZeroAddress, sigs: await sign([outsider, wallet(assigned[0])], 3n, R) }]
  // (a fixed gas limit, as the Settler gives: an estimate is too low for the calls inside)
  const bad = await (await reg.connect(outsider).settleMany(items, { gasLimit: 1000000n })).wait()
  check('the contract settles it (it cannot know the assignment)', (await reg.settled(settledKey(job, 3n))) === R)
  const txMany = await chain.provider.getTransaction(bad.hash)
  check('signers are read from a settleMany() transaction too', signersFromInput(reg, ctx, txMany.data, job, '3', roleOf).includes(outsider.address))
  check('and not for a unit the transaction did not settle', signersFromInput(reg, ctx, txMany.data, job, '4', roleOf).length === 0)

  const found = await nodes[0].audit()
  check('the audit finds the outsider, and only it', found.length === 1 && found[0].operator === outsider.address && found[0].unit === '3', JSON.stringify(found))
  for (const n of nodes.slice(1)) await n.audit()
  // the verifiers agree and the first submits; the others after a delay
  let slashed = false
  for (let i = 0; i < 60 && !slashed; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    slashed = (await reg.nodes(outsider.address)).stake < before
  }
  const after = (await reg.nodes(outsider.address)).stake
  check('the verifiers slash it', slashed && before - after === MIN * BigInt(FAULT_BPS) / 10000n, `${before} -> ${after}`)
  check('the assigned node that signed with it is not touched', (await reg.nodes(assigned[0])).stake === MIN)
  check('no watchtower reported an error', nodes.every((n) => !n.events.some(([e]) => e === 'error')), JSON.stringify(nodes.flatMap((n) => n.events.filter(([e]) => e === 'error'))))

  // a fault that names a node the settlement did not count is refused
  const liar = { v: 1, kind: 'unassigned', operator: assigned[1], job, unit: '3', work: { job, unit: '3', operator: assigned[1] }, evidence: { tx: bad.hash } }
  check('a fault against a node that did not sign is not agreed with', (await nodes[1].watch.rejudge(liar)) === false)
  const wrongTx = { ...liar, operator: outsider.address, work: { job, unit: '3', operator: outsider.address }, evidence: { tx: good.hash } }
  check('nor one whose transaction settled another unit', (await nodes[1].watch.rejudge(wrongTx)) === false)
  check('nor one against an assigned signer', (await nodes[1].watch.rejudge({ ...liar, operator: assigned[0], work: { job, unit: '3', operator: assigned[0] } })) === false)

  // a node that left the job a moment ago: its signature is still good
  const leaver = wallet(assigned[0])
  await (await reg.connect(leaver).startUnbonding()).wait()
  await nodes[2].sync()
  check('after it leaves, the plan no longer has it on the job', !nodes[2].plan().get(job).includes(leaver.address))
  check('a node that left within the grace period still counts as assigned', nodes[2].auditor.assigned(job, leaver.address, nodes[2].view.block) === true)
  await mine(GRACE + 3)
  await nodes[2].sync()
  check('and no longer after it', nodes[2].auditor.assigned(job, leaver.address, nodes[2].view.block) === false)
} finally {
  chain.anvil.kill()
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
