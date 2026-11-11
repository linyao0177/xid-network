// The assignment plan from the registry's events (lib/chain.js), and the job
// fee: node test/chainview.js
//
// Regression tests for the second v4 review: every node must compute the same
// plan (one that read the events in steps, one that starts fresh, one that
// restarts from its file); a capacity lowered and raised again moves no job
// posted before either change (review N3); spent, refunded, closing and closed
// jobs and slashed nodes are seen alike; and a job costs a fee that is not
// refunded (review N5).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { HDNodeWallet, getBytes, toUtf8Bytes, ZeroAddress } from 'ethers'
import { deploy, deployTestToken, register, ROLES, SPEC, ChainView, assignJobs, workStatement, batchStatement, batchLeaf, merkleRoot } from '../index.js'
import { startChain, MNEMONIC } from './chain.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}

const MIN = 100_000000n
const PAY = 1_000000n
const FEE = 2_000000n
const chain = await startChain(8563)
if (!chain) {
  console.log('SKIP anvil not installed')
  process.exit(0)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-chainview-'))
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, payer, A, B, C] = [0, 1, 2, 3, 4].map(acct)
  const token = await deployTestToken(admin)
  const tokenAddr = await token.getAddress()
  const reg = await deploy(admin, { token: tokenAddr, minStake: MIN, unbonding: 600, epochLength: 3600, jobNotice: 10, jobFee: FEE })
  const regAddr = await reg.getAddress()
  const ctx = { registry: regAddr, chainId: 31337n }
  for (const w of [payer, A, B, C]) await (await token.mint(w.address, 10000_000000n)).wait()
  await (await token.connect(payer).approve(regAddr, 2n ** 255n)).wait()
  for (const [i, w] of [A, B, C].entries()) await register(reg, w, { dhtKey: Buffer.alloc(32, i + 1), roles: ROLES.STORE, stake: MIN, token: tokenAddr })
  const device = (i) => '0x' + String(i + 1).padStart(64, '0')
  const terms = (budget) => ({ role: ROLES.STORE, quorum: 1, perEpoch: 1000, deadline: 0, spec: SPEC.store, pay: PAY, budget })
  const PARAMS = toUtf8Bytes(JSON.stringify({ window: 5 }))
  const post = async (i, budget = 50n * PAY) => {
    const r = await (await reg.connect(payer).postJob(device(i), terms(budget), PARAMS)).wait()
    return Number(r.logs.map((l) => { try { return reg.interface.parseLog(l) } catch { return null } }).find((e) => e && e.name === 'JobPosted').args.id)
  }
  const mine = async (n = 1) => { for (let i = 0; i < n; i++) await chain.provider.send('evm_mine', []) }

  // the fee
  const t0 = await reg.treasury()
  let refused = false
  try { await (await reg.connect(payer).postJob(device(0), terms(PAY + FEE - 1n), PARAMS)).wait() } catch { refused = true }
  const j0 = await post(0)
  const posted = (await reg.queryFilter(reg.filters.JobPosted(j0)))[0]
  check('a job must bring a unit\'s pay on top of the fee', refused)
  check('the fee goes to the treasury, out of the budget, and the event says the budget left', (await reg.treasury()) - t0 === FEE && (await reg.jobs(j0)).budget === 50n * PAY - FEE && posted.args.budget === 50n * PAY - FEE)
  let refusedBatch = false
  try { await (await reg.connect(payer).postBatchJob(device(0), terms(6n * PAY + FEE - 1n), 6, PARAMS)).wait() } catch { refusedBatch = true }
  check('a batch job must bring a whole batch\'s pay on top of the fee', refusedBatch)

  // a view that reads as the chain goes, keeping its state on disk
  const file = path.join(tmp, 'view.json')
  const stepwise = new ChainView({ registry: reg, step: 1, lag: 0, minStake: MIN, file })
  await stepwise.sync()

  // capacity: A takes 1 job from job 4 on, then no limit again from job 6 on
  for (let i = 1; i < 4; i++) await post(i)
  await stepwise.sync()
  await (await reg.connect(A).setCapacity(1)).wait()
  await post(4); await post(5)
  await stepwise.sync()
  await (await reg.connect(A).setCapacity(0)).wait()
  await post(6); await post(7)
  await stepwise.sync()
  const steps = stepwise.nodes().get(A.address).steps
  check('a node\'s capacity changes are all kept, each from the job posted after it', JSON.stringify(steps) === JSON.stringify([[0, 0], [4, 1], [6, 0]]), JSON.stringify(steps))
  check('the registry itself keeps only the capacity now', Number((await reg.nodes(A.address)).capacity) === 0)

  // spent: a job with one unit's pay settles it and takes no more; funded again, it is open
  const js = await post(8, PAY + FEE)
  const result = '0x' + '11'.repeat(32)
  await (await reg.connect(B).settle(js, 0, result, [await B.signMessage(getBytes(workStatement(ctx, js, 0n, result)))])).wait()
  await stepwise.sync()
  check('a job whose budget is spent is not worked on (JobSpent), but keeps its nodes a while: other jobs do not move', !stepwise.isOpen(js) && stepwise.openJobs().some((j) => j.id === js))
  const shortHold = new ChainView({ registry: reg, step: 1, lag: 0, minStake: MIN, spentHoldS: 5 })
  await shortHold.sync()
  const heldThen = shortHold.openJobs().some((j) => j.id === js)
  await chain.provider.send('evm_increaseTime', [6])
  await mine()
  await shortHold.sync()
  check('after the hold, a spent job no longer holds nodes', heldThen && !shortHold.openJobs().some((j) => j.id === js))
  await (await reg.connect(payer).fundJob(js, PAY)).wait()
  await stepwise.sync()
  check('funded again with a unit\'s pay, it is open again', stepwise.isOpen(js))

  // closing: open until its notice is past, then gone
  const jc = await post(9)
  await (await reg.connect(payer).closeJob(jc)).wait()
  await stepwise.sync()
  check('a closing job is open until its notice is over', stepwise.isOpen(jc))
  await chain.provider.send('evm_increaseTime', [11])
  await mine()
  await stepwise.sync()
  check('then it is not, and the view forgets it', !stepwise.isOpen(jc) && !(jc in stepwise.state.jobs))

  // slashed below the minimum: no longer active
  const [ra, rb] = ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32)]
  const sig = (r) => C.signMessage(getBytes(workStatement(ctx, j0, 7n, r)))
  await (await reg.connect(admin).slashDoubleWork(C.address, j0, 7, ra, await sig(ra), rb, await sig(rb))).wait()
  await stepwise.sync()
  check('a node slashed below the minimum stake drops out of the active list', !stepwise.active(ROLES.STORE).includes(C.address) && stepwise.active(ROLES.STORE).length === 2)

  // every view computes the same plan
  const planOf = (v) => JSON.stringify([...v.plan([ROLES.STORE, ROLES.VERIFY, ROLES.COMPUTE], 0).plan.entries()].sort((a, b) => a[0] - b[0]))
  const fresh = new ChainView({ registry: reg, step: 1, lag: 0, minStake: MIN })
  await fresh.sync()
  const restarted = new ChainView({ registry: reg, step: 1, lag: 0, minStake: MIN, file })
  const restartedFrom = restarted.block
  await restarted.sync()
  check('a view that read the chain in steps, one that read it at once, and one restarted from its file plan alike', planOf(stepwise) === planOf(fresh) && planOf(restarted) === planOf(fresh) && restartedFrom === stepwise.block, `${fresh.openJobs().length} open jobs`)
  const open = fresh.openJobs()
  const active = new Map([[ROLES.STORE, fresh.active(ROLES.STORE)]])
  const withSteps = assignJobs(open, active, fresh.nodes(), 0).plan
  const never = new Map(fresh.nodes())
  never.set(A.address, { steps: [[0, 0]], sinceJob: 0 })
  const unchanged = assignJobs(open, active, never, 0).plan
  const early = open.filter((j) => j.id < 4)
  check('jobs posted before A lowered and raised its capacity are assigned as if it never had', early.length > 0 && early.every((j) => withSteps.get(j.id).join() === unchanged.get(j.id).join()))
  const loadA = (p, lo, hi) => [...p.entries()].filter(([id, ops]) => id >= lo && id < hi && ops.includes(A.address)).length
  check('while lowered to 1, A took a job posted then only if it had none', loadA(withSteps, 4, 6) === 0 || loadA(withSteps, 0, 4) === 0)

  // the as-of block: `lag` back, rounded down to a multiple of `step`
  const lagged = new ChainView({ registry: reg, step: 5, lag: 2, minStake: MIN })
  check('the as-of block is lag blocks back, rounded down to a multiple of step', lagged.asOfFor(107) === 105 && lagged.asOfFor(106) === 100 && lagged.asOfFor(1) === 0)
  await lagged.sync()
  const late = await post(10)
  await lagged.sync()
  const seenAt = lagged.block
  const seen = lagged.isOpen(late)
  await mine(7)
  await lagged.sync()
  check('a job posted after the as-of block is nobody\'s until the plan reaches it', !seen && lagged.isOpen(late), `as of ${seenAt}`)
  const twin = new ChainView({ registry: reg, step: 5, lag: 2, minStake: MIN })
  await twin.sync()
  check('two views at heads within one step compute the same plan', twin.block === lagged.block && planOf(twin) === planOf(lagged))

  // an RPC that fails halfway through a sync: nothing of it is kept, and the
  // next sync reads it all again, once
  let calls = 0
  const flaky = new Proxy(chain.provider, {
    get (target, prop) {
      if (prop === 'getLogs') return async (f) => { if (++calls === 2) throw new Error('rpc down'); return target.getLogs(f) }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  const broken = new ChainView({ registry: reg, provider: flaky, step: 1, lag: 0, chunk: 4, minStake: MIN })
  let threw = false
  try { await broken.sync() } catch { threw = true }
  const keptNothing = broken.block === -1 && Object.keys(broken.state.nodes).length === 0
  await broken.sync()
  const ref = new ChainView({ registry: reg, step: 1, lag: 0, minStake: MIN })
  await ref.sync()
  check('a sync that fails halfway keeps nothing; the next one reads every event once', threw && keptNothing && broken.block === ref.block && JSON.stringify(broken.state) === JSON.stringify(ref.state), JSON.stringify(broken.nodes().get(A.address)?.steps))

  // a file from another chain, or from blocks that are no longer the chain's, is thrown away (M3)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...saved, hash: '0x' + '00'.repeat(32), jobs: { 999: { id: 999, device: 'ee', role: ROLES.STORE, quorum: 1, pay: '1', batchUnits: 0, closesAt: 0, spent: false, spentAt: 0, budget: null, closed: false, bad: false } } }))
  const stale = new ChainView({ registry: reg, step: 1, lag: 0, minStake: MIN, file })
  const hadStale = 999 in stale.state.jobs
  await stale.sync()
  check('a state whose block is not the chain\'s is read again from the start', hadStale && !(999 in stale.state.jobs) && JSON.stringify(stale.state.nodes) === JSON.stringify(ref.state.nodes))

  // a job no node can read, or with a quorum over 32, holds nobody (H2)
  const badId = await (async () => {
    const r = await (await reg.connect(payer).postJob(device(20), terms(50n * PAY), toUtf8Bytes('not json'))).wait()
    return Number(r.logs.map((l) => { try { return reg.interface.parseLog(l) } catch { return null } }).find((e) => e && e.name === 'JobPosted').args.id)
  })()
  let bigQuorum = false
  try { await (await reg.connect(payer).postJob(device(21), { ...terms(50n * PAY), quorum: 33 }, PARAMS)).wait() } catch { bigQuorum = true }
  await ref.sync()
  check('a job with terms no node can read holds no node in the plan', !ref.isOpen(badId) && !ref.openJobs().some((j) => j.id === badId))
  check('a quorum over 32 is refused on chain', bigQuorum)

  // a batch job is spent once its budget cannot pay a whole batch (L2)
  const bj = await (async () => {
    const r = await (await reg.connect(payer).postBatchJob(device(22), terms(7n * PAY + FEE), 6, PARAMS)).wait()
    return Number(r.logs.map((l) => { try { return reg.interface.parseLog(l) } catch { return null } }).find((e) => e && e.name === 'JobPosted').args.id)
  })()
  const leaves = [0, 1, 2, 3, 4, 5].map((u) => [String(u), '0x' + String(u + 1).padStart(64, '0')])
  const root = merkleRoot(leaves.map(([u, r]) => batchLeaf(u, r)))
  const bsig = await B.signMessage(getBytes(batchStatement(ctx, bj, 0n, root, 6, ZeroAddress)))
  await (await reg.connect(B).settleBatch(bj, 0, root, 6, ZeroAddress, [bsig])).wait()
  await ref.sync()
  check('a batch job left with less than a batch\'s pay is spent (one unit\'s pay is not enough)', (await reg.jobs(bj)).budget === PAY && !ref.isOpen(bj))

  // a failed sync keeps the logs it read: the next one does not read them again (L3)
  let reads = 0
  let failOnce = true
  const counting = new Proxy(chain.provider, {
    get (target, prop) {
      if (prop === 'getLogs') return async (f) => { reads++; if (reads === 3 && failOnce) { failOnce = false; throw new Error('rpc down') } return target.getLogs(f) }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  const head = await chain.provider.getBlockNumber()
  const resumed = new ChainView({ registry: reg, provider: counting, step: 1, lag: 0, chunk: Math.ceil((head + 1) / 4), minStake: MIN })
  try { await resumed.sync() } catch {}
  const before = reads
  await resumed.sync()
  check('after a failed sync the next one reads only the chunks it had not', before === 3 && reads - before === 2 && JSON.stringify(resumed.state.nodes) === JSON.stringify(ref.state.nodes), `${before} then ${reads - before} reads`)
} catch (err) {
  console.error(err)
  failed++
} finally {
  chain.anvil.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
