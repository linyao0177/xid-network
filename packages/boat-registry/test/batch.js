// Batch jobs on a fresh anvil chain: node test/batch.js
//
// A batch job (postBatchJob) settles a batch of its units in one call
// (settleBatch): the nodes sign a statement over the batch's Merkle root of
// (unit, result) and how many units it holds. Checks the pay, the bounds
// (batch size, rate, quorum, once per batch), forward jobs, settleBatchMany,
// and the gas a batch costs.

import { HDNodeWallet, id, getBytes, ZeroAddress } from 'ethers'
import { deploy, deployTestToken, register, asBytes32, ROLES, postJob, SPEC, batchStatement, batchKey, batchLeaf, merkleRoot, workStatement, sortedSignatures } from '../index.js'
import { startChain, MNEMONIC } from './chain.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}
async function reverts (p) {
  try {
    await (await p).wait?.()
    return null
  } catch (err) {
    return err.reason || err.shortMessage || err.message
  }
}

const chain = await startChain(8559)
if (!chain) {
  console.log('SKIP: anvil not found')
  process.exit(0)
}
const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
const [admin, s1, s2, s3, v1, v2, v3, fwd, payer, relay, thief] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(acct)
const STAKE = 100_000000n
const PAY = 1_000000n
const key = (n) => asBytes32(Buffer.alloc(32, n))
const device = Buffer.alloc(32, 0xdd).toString('hex')

try {
  const token = await deployTestToken(admin)
  const tokenAddr = await token.getAddress()
  const reg = await deploy(admin, { token: tokenAddr, minStake: STAKE, unbonding: 600, epochLength: 3600, jobNotice: 600 })
  for (const w of [s1, s2, s3, v1, v2, v3, fwd, payer, thief]) await (await token.mint(w.address, 100000_000000n)).wait()
  await (await admin.sendTransaction({ to: thief.address, value: 10n ** 19n })).wait()
  for (const [i, w] of [s1, s2, s3].entries()) await register(reg, w, { dhtKey: key(10 + i), roles: ROLES.STORE, stake: STAKE, token: tokenAddr })
  for (const [i, w] of [v1, v2, v3].entries()) await register(reg, w, { dhtKey: key(20 + i), roles: ROLES.VERIFY, stake: STAKE, token: tokenAddr })
  await register(reg, fwd, { dhtKey: key(30), roles: ROLES.FORWARD, stake: STAKE, token: tokenAddr })
  await register(reg, thief, { dhtKey: key(31), roles: ROLES.FORWARD, stake: STAKE, token: tokenAddr })
  await chain.provider.send('evm_increaseTime', [3601]) // verifiers vote from the next epoch
  await chain.provider.send('evm_mine', [])
  const ctx = { registry: await reg.getAddress(), chainId: (await chain.provider.getNetwork()).chainId }

  // a batch: units (boot 5, indexes) and their results -> root
  const BOOT = 5n << 32n
  const batchOfUnits = (index, n, salt = 'r') => {
    const units = Array.from({ length: n }, (_, i) => BOOT | BigInt(index * 6 + i))
    const leaves = units.map((u) => batchLeaf(u, id(salt + u)))
    return { batch: BOOT | BigInt(index), root: merkleRoot(leaves), units: n }
  }
  const sign = async (signers, job, b, forwarder = ZeroAddress) => sortedSignatures(await Promise.all(signers.map(async (w) => ({ address: w.address, signature: await w.signMessage(getBytes(batchStatement(ctx, job, b.batch, b.root, b.units, forwarder))) }))))
  const pending = async (w) => (await reg.rewards(w.address))[0]

  const job = await postJob(reg, payer, { role: ROLES.STORE, device, spec: SPEC.store, params: { window: 20 }, pay: PAY, quorum: 2, budget: 1000n * PAY, batchUnits: 6 })
  const jobRow = await reg.jobs(job)
  check('a batch job records its batch size', jobRow.batchUnits === 6n)

  // unit by unit is refused for a batch job, and a batch for a unit job
  const unitSigs = sortedSignatures(await Promise.all([s1, s2].map(async (w) => ({ address: w.address, signature: await w.signMessage(getBytes(workStatement(ctx, job, BOOT, id('x')))) }))))
  const byUnit = await reverts(reg.connect(relay).settle(job, BOOT, id('x'), unitSigs))
  const unitJob = await postJob(reg, payer, { role: ROLES.STORE, device, spec: SPEC.store, params: { window: 20 }, pay: PAY, quorum: 2, budget: 100n * PAY })
  const b0 = batchOfUnits(0, 6)
  const byBatch = await reverts(reg.connect(relay).settleBatch(unitJob, b0.batch, b0.root, b0.units, ZeroAddress, await sign([s1, s2], unitJob, b0)))
  check('a batch job does not settle unit by unit, and a unit job not by batch', /settled in batches/.test(byUnit) && /settled unit by unit/.test(byBatch))

  // a batch settles once, paying units * pay among its signers
  const before = [await pending(s1), await pending(s2)]
  const budget0 = (await reg.jobs(job)).budget
  const r = await (await reg.connect(relay).settleBatch(job, b0.batch, b0.root, b0.units, ZeroAddress, await sign([s1, s2], job, b0))).wait()
  const gasOne = r.gasUsed
  const after = [await pending(s1), await pending(s2)]
  const ev = r.logs.map((l) => { try { return reg.interface.parseLog(l) } catch { return null } }).find((e) => e && e.name === 'BatchSettled')
  check('a batch of 6 units pays 6 x pay, split between its 2 signers', after[0] - before[0] === 3n * PAY && after[1] - before[1] === 3n * PAY && budget0 - (await reg.jobs(job)).budget === 6n * PAY && ev && ev.args.units === 6n, `${gasOne} gas`)
  check('the contract records the batch root under its key', (await reg.settled(batchKey(job, b0.batch))) === b0.root)
  const twice = await reverts(reg.connect(relay).settleBatch(job, b0.batch, b0.root, b0.units, ZeroAddress, await sign([s1, s2], job, b0)))
  const other = batchOfUnits(0, 6, 'other')
  const otherRoot = await reverts(reg.connect(relay).settleBatch(job, other.batch, other.root, other.units, ZeroAddress, await sign([s1, s2], job, other)))
  check('a batch settles only once, whatever root is offered the second time', /settled/.test(twice) && /settled/.test(otherRoot))

  // bounds: batch size, quorum, signatures over another statement
  const big = batchOfUnits(1, 7)
  const tooBig = await reverts(reg.connect(relay).settleBatch(job, big.batch, big.root, big.units, ZeroAddress, await sign([s1, s2], job, big)))
  const b1 = batchOfUnits(1, 6)
  const alone = await reverts(reg.connect(relay).settleBatch(job, b1.batch, b1.root, b1.units, ZeroAddress, await sign([s1], job, b1)))
  const lying = await reverts(reg.connect(relay).settleBatch(job, b1.batch, b1.root, 5, ZeroAddress, await sign([s1, s2], job, b1)))
  const verifiersSign = await reverts(reg.connect(relay).settleBatch(job, b1.batch, b1.root, b1.units, ZeroAddress, await sign([v1, v2], job, b1)))
  check('more units than the batch size, one signer, a changed count or signers of another role: refused', /batch/.test(tooBig) && /no quorum/.test(alone) && /no quorum/.test(lying) && /no quorum/.test(verifiersSign))

  // the job's rate per epoch counts units, not batches
  const slow = await postJob(reg, payer, { role: ROLES.STORE, device, spec: SPEC.store, params: { window: 20 }, pay: PAY, quorum: 2, budget: 100n * PAY, perEpoch: 10, batchUnits: 6 })
  await (await reg.connect(relay).settleBatch(slow, b0.batch, b0.root, b0.units, ZeroAddress, await sign([s1, s2], slow, b0))).wait()
  const overRate = await reverts(reg.connect(relay).settleBatch(slow, b1.batch, b1.root, b1.units, ZeroAddress, await sign([s1, s2], slow, b1)))
  const four = batchOfUnits(1, 4)
  await (await reg.connect(relay).settleBatch(slow, four.batch, four.root, four.units, ZeroAddress, await sign([s1, s2], slow, four))).wait()
  check('a job settles at most perEpoch units an epoch: 6 + 6 > 10 refused, 6 + 4 settles', /rate/.test(overRate) && (await reg.jobs(slow)).settledInEpoch === 10n)

  // a forward job: the forwarder and a quorum of verifiers; the forwarder is paid
  const fjob = await postJob(reg, payer, { role: ROLES.FORWARD, device, spec: SPEC.forward, params: { window: 20 }, pay: PAY, quorum: 2, budget: 100n * PAY, batchUnits: 6 })
  const noFwd = await reverts(reg.connect(relay).settleBatch(fjob, b0.batch, b0.root, b0.units, fwd.address, await sign([v1, v2], fjob, b0, fwd.address)))
  // another forwarding node takes the verifiers' signatures (made for fwd) and claims the pay: their signatures do not cover it
  const stolen = await reverts(reg.connect(thief).settleBatch(fjob, b0.batch, b0.root, b0.units, thief.address, sortedSignatures([
    ...(await Promise.all([v1, v2].map(async (w) => ({ address: w.address, signature: await w.signMessage(getBytes(batchStatement(ctx, fjob, b0.batch, b0.root, b0.units, fwd.address))) })))),
    { address: thief.address, signature: await thief.signMessage(getBytes(batchStatement(ctx, fjob, b0.batch, b0.root, b0.units, thief.address))) }
  ])))
  const fBefore = await pending(fwd)
  await (await reg.connect(relay).settleBatch(fjob, b0.batch, b0.root, b0.units, fwd.address, await sign([fwd, v1, v2], fjob, b0, fwd.address))).wait()
  check('a forward batch needs its forwarder\'s signature and pays it units x pay', /forwarder/.test(noFwd) && (await pending(fwd)) - fBefore === 6n * PAY)
  // (under the thief's statement the verifiers' signatures recover to other addresses: refused as unsorted, or as no quorum)
  check('another forwarding node cannot claim a forward batch the verifiers signed for its forwarder', stolen !== null && (await pending(thief)) === 0n, stolen || 'settled!')
  const fwdOnStore = await reverts(reg.connect(relay).settleBatch(job, b1.batch, b1.root, b1.units, fwd.address, await sign([s1, s2], job, b1, fwd.address)))
  check('a batch of a store job names no forwarder', /forwarder/.test(fwdOnStore))

  // posting: the rate must fit a batch, the budget at least one batch (one unit for unit jobs)
  const badRate = await reverts(postJob(reg, payer, { role: ROLES.STORE, device, spec: SPEC.store, params: { window: 20 }, pay: PAY, quorum: 2, budget: 100n * PAY, perEpoch: 5, batchUnits: 6 }))
  const badBudget = await reverts(postJob(reg, payer, { role: ROLES.STORE, device, spec: SPEC.store, params: { window: 20 }, pay: PAY, quorum: 2, budget: 5n * PAY, batchUnits: 6 }))
  const noBudget = await reverts(postJob(reg, payer, { role: ROLES.STORE, device, spec: SPEC.store, params: { window: 20 }, pay: PAY, quorum: 2, budget: 0n }))
  check('a batch job needs a rate of at least one batch an epoch and a budget of one batch; any job a budget of one unit', /batch/.test(badRate) && /batch/.test(badBudget) && /terms/.test(noBudget))

  // many batches in one transaction; a bad one is skipped
  const items = []
  for (let i = 10; i < 30; i++) {
    const b = batchOfUnits(i, 6)
    items.push({ id: job, batch: b.batch, root: b.root, units: b.units, forwarder: ZeroAddress, sigs: await sign([s1, s2, s3], job, b) })
  }
  items.push({ id: job, batch: b0.batch, root: b0.root, units: 6, forwarder: ZeroAddress, sigs: await sign([s1, s2], job, b0) }) // settled already
  const rm = await (await reg.connect(relay).settleBatchMany(items)).wait()
  const settledNow = rm.logs.map((l) => { try { return reg.interface.parseLog(l) } catch { return null } }).filter((e) => e && e.name === 'BatchSettled').length
  const perBatch = rm.gasUsed / 20n
  check('settleBatchMany settles 20 batches and skips the one already settled', settledNow === 20, `${rm.gasUsed} gas, ${perBatch} a batch of 6 units (3 signers), ${perBatch / 6n} a unit`)
} catch (err) {
  console.error(err)
  failed++
} finally {
  chain.anvil.kill()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
