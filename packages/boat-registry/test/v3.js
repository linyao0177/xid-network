// The contract's iteration 3: node test/v3.js
//
// Forwarding settled from a forwarder and witnesses; delegation (shares,
// compounding rewards, a commission that changes only after notice, slashes
// in proportion, leaving stake still slashed); devices paying for their own
// jobs; governance by verifiers once the admin renounces; paid reads over a
// channel (BoatReads). And the attacks an independent review found, each
// shown not to work any more: reporting oneself to take the delegators'
// stake, undelegating ahead of a slash, sybil verifiers blocking a slash or
// taking the treasury, a few nodes draining a job, an old read voucher
// after a channel reopens, an old device request.

import { HDNodeWallet, Wallet, id, getBytes, toUtf8Bytes, AbiCoder, keccak256 } from 'ethers'
import {
  deploy, deployTestToken, register, signSlash, sortedSignatures, asBytes32, ROLES, postJob, forwardJob, storeJob, workStatement, settledKey,
  signGovern, jobRequestStatementOf, deployReads, readStatementOf, merkleRoot, storeLeaf
} from '../index.js'
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
const abi = AbiCoder.defaultAbiCoder()
const STAKE = 100_000000n
const EPOCH = 3600
const UNBONDING = 600
const key = (n) => asBytes32(Buffer.alloc(32, n))
const bySigner = (ws) => ws.slice().sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))

const chain = await startChain(8558)
if (!chain) {
  console.log('SKIP: anvil not found')
  process.exit(0)
}
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, fwd, v1, v2, v3, payer, d1, d2, owner, reader, outsider, s1, s2] = Array.from({ length: 13 }, (_, i) => acct(i))
  const token = await deployTestToken(admin)
  const tokenAddr = await token.getAddress()
  const reg = await deploy(admin, { token: tokenAddr, minStake: STAKE, unbonding: UNBONDING, epochLength: EPOCH, jobNotice: 600 })
  const ctx = { registry: await reg.getAddress(), chainId: 31337n }
  for (const w of [fwd, v1, v2, v3, payer, d1, d2, owner, reader, outsider, s1, s2]) await (await token.mint(w.address, 10000n * STAKE)).wait()
  await register(reg, fwd, { dhtKey: key(1), roles: ROLES.FORWARD, stake: STAKE, token: tokenAddr })
  for (const [w, n] of [[v1, 2], [v2, 3], [v3, 4]]) await register(reg, w, { dhtKey: key(n), roles: ROLES.VERIFY | ROLES.STORE, stake: STAKE, token: tokenAddr })
  const mine = async (s) => { await chain.provider.send('evm_increaseTime', [s]); await chain.provider.send('evm_mine', []) }
  const bal = (w) => token.balanceOf(w.address)
  const slashBy = async (verifiers, operator, amount, tag) => {
    const reason = id(tag)
    const sigs = await Promise.all(verifiers.map((v) => signSlash(reg, v, { operator, amount, reason, nonce: 1 })))
    return reg.connect(outsider).slash(operator, amount, reason, 1, sortedSignatures(sigs))
  }

  // ---- verifiers vote once they have been one for an epoch ----
  const tooSoon = await reverts(slashBy([v1, v2, v3], fwd.address, 1_000000n, 'early'))
  await mine(EPOCH + 1)
  check('a new verifier does not vote for its first epoch', /quorum/.test(tooSoon))

  // ---- forwarding ----
  const PAY = 1_000000n
  const jf = await postJob(reg, payer, { ...forwardJob({ window: 5 }), device: key(0xdd), pay: PAY, quorum: 2, budget: 20n * PAY })
  const leaves = [0, 1, 2, 3, 4].map((seq) => ({ device: 'dd'.repeat(32), topic: 'd/' + 'dd'.repeat(32) + '/telemetry', seq: String(seq), payloadHash: id('m' + seq) }))
  const root = merkleRoot(leaves.map(storeLeaf))
  const result = keccak256(abi.encode(['address', 'bytes32'], [fwd.address, root]))
  const sign = (w, job, unit, r = result) => w.signMessage(getBytes(workStatement(ctx, job, unit, r)))
  const sigsOf = async (ws, job, unit, r) => Promise.all(bySigner(ws).map((w) => sign(w, job, unit, r)))
  const noForwarder = await reverts(reg.settleForward(jf, 0, root, fwd.address, await sigsOf([v1, v2], jf, 0n)))
  const oneWitness = await reverts(reg.settleForward(jf, 0, root, fwd.address, await sigsOf([fwd, v1], jf, 0n)))
  const viaSettle = await reverts(reg.settle(jf, 0, result, await sigsOf([fwd, v1, v2], jf, 0n)))
  const notForwarder = await reverts(reg.settleForward(jf, 0, root, v3.address, await sigsOf([v3, v1, v2], jf, 0n, keccak256(abi.encode(['address', 'bytes32'], [v3.address, root])))))
  await (await reg.connect(outsider).settleForward(jf, 0, root, fwd.address, await sigsOf([fwd, v1, v2], jf, 0n))).wait()
  check('a forward unit settles with the forwarder and two witnesses; only the forwarder is paid', (await reg.rewards(fwd.address)).pending === PAY && (await reg.rewards(v1.address)).pending === 0n && (await reg.settled(settledKey(jf, 0n))) === result)
  check('…not without the forwarder, with one witness, through settle(), or for a node that does not forward', /forwarder/.test(noForwarder) && /quorum/.test(oneWitness) && /settleForward/.test(viaSettle) && /forwarder/.test(notForwarder))

  // ---- a job's rate ----
  const js = await postJob(reg, payer, { ...storeJob({ window: 5 }), device: key(0xdd), pay: PAY, quorum: 2, budget: 100n * PAY, perEpoch: 2 })
  const storeResult = id('a store root')
  for (const u of [0n, 1n]) await (await reg.settle(js, u, storeResult, await sigsOf([v1, v2], js, u, storeResult))).wait()
  const third = await reverts(reg.settle(js, 2, storeResult, await sigsOf([v1, v2], js, 2n, storeResult)))
  await mine(EPOCH)
  const nextEpoch = await reverts(reg.settle(js, 2, storeResult, await sigsOf([v1, v2], js, 2n, storeResult)))
  check('a job settles at most perEpoch units an epoch: two nodes cannot drain its budget at once', /rate/.test(third) && nextEpoch === null, third)

  // ---- many units in one transaction ----
  const items = [
    { id: js, unit: 5n, result: storeResult, sigs: await sigsOf([v1, v2], js, 5n, storeResult) }, // fine
    { id: js, unit: 0n, result: storeResult, sigs: await sigsOf([v1, v2], js, 0n, storeResult) }, // settled already
    { id: js, unit: 6n, result: storeResult, sigs: await sigsOf([v1], js, 6n, storeResult) } // no quorum
  ]
  const n = await reg.settleMany.staticCall(items)
  const rb = await (await reg.settleMany(items)).wait()
  const settledIds = rb.logs.map((l) => { try { return reg.interface.parseLog(l) } catch { return null } }).filter((e) => e && e.name === 'Settled').map((e) => String(e.args.unit))
  check('settleMany settles the units it can and skips the rest, not the batch', n === 1n && settledIds.join() === '5' && (await reg.settled(settledKey(js, 6n))) === '0x' + '0'.repeat(64), `${rb.gasUsed} gas`)

  // ---- delegation ----
  await (await token.connect(d1).approve(ctx.registry, 1000n * STAKE)).wait()
  await (await token.connect(d2).approve(ctx.registry, 1000n * STAKE)).wait()
  await (await reg.connect(d1).delegate(fwd.address, 100_000000n)).wait()
  await (await reg.connect(d2).delegate(fwd.address, 300_000000n)).wait()
  check('delegators stake on a node; its total stake counts them', (await reg.totalStake(fwd.address)) === STAKE + 400_000000n)
  await (await reg.connect(fwd).setCommission(1000)).wait() // 10%, from one unbonding period on
  const pool0 = (await reg.pools(fwd.address)).stake
  await (await reg.settleForward(jf, 1, root, fwd.address, await sigsOf([fwd, v1, v2], jf, 1n))).wait()
  const pool1 = (await reg.pools(fwd.address)).stake
  const theirs1 = (PAY * pool0) / (STAKE + pool0)
  await mine(UNBONDING + 1)
  await (await reg.settleForward(jf, 2, root, fwd.address, await sigsOf([fwd, v1, v2], jf, 2n))).wait()
  const pool2 = (await reg.pools(fwd.address)).stake
  const theirs2 = (PAY * pool1) / (STAKE + pool1)
  check('the delegators\' part of rewards compounds in the pool; a new commission applies only after notice', pool1 - pool0 === theirs1 && pool2 - pool1 === theirs2 - theirs2 / 10n, `no commission yet: +${pool1 - pool0}, then 10%: +${pool2 - pool1}`)
  const highCommission = await reverts(reg.connect(fwd).setCommission(6000))
  const toInactive = await reverts(reg.connect(d1).delegate(outsider.address, 1_000000n))
  check('commission is capped at 50%; nobody delegates to a node that is not active', /commission/.test(highCommission) && /not active/.test(toInactive))

  // d1 leaves ahead of a slash: what is leaving is still slashed
  await (await reg.connect(d1).undelegate(fwd.address, await reg.delegatorShares(fwd.address, d1.address))).wait()
  const p = await reg.pools(fwd.address)
  const own0 = (await reg.nodes(fwd.address)).stake
  const total = own0 + p.stake + p.ubStake
  const amount = 50_000000n
  const forfeited = (await reg.rewards(fwd.address)).pending
  const treasury0 = await reg.treasury()
  const reporter0 = await bal(outsider)
  await (await slashBy([v1, v2, v3], fwd.address, amount, 'fault 1')).wait()
  const p2 = await reg.pools(fwd.address)
  const fromPool = (amount * p.stake) / total
  const fromLeaving = (amount * p.ubStake) / total
  const fromOwn = amount - fromPool - fromLeaving
  check('a slash takes from the node, the pool and the stake leaving it, in proportion', p2.stake === p.stake - fromPool && p2.ubStake === p.ubStake - fromLeaving && (await reg.nodes(fwd.address)).stake === own0 - fromOwn, `own ${fromOwn}, pool ${fromPool}, leaving ${fromLeaving}`)
  const bounty = (fromOwn + forfeited) / 2n
  check('the reporter gets half of what the node itself loses; the delegators\' loss goes to the treasury', (await bal(outsider)) - reporter0 === bounty && (await reg.treasury()) - treasury0 === amount + forfeited - bounty, `reporter ${bounty}`)
  const early = await reverts(reg.connect(d1).withdrawUndelegated(fwd.address))
  await mine(UNBONDING + 1)
  const b0 = await bal(d1)
  await (await reg.connect(d1).withdrawUndelegated(fwd.address)).wait()
  check('the leaver gets its slashed share back after the unbonding period', /bonded/.test(early) && (await bal(d1)) - b0 === p2.ubStake, `${(await bal(d1)) - b0} back of 100000000 in`)

  // reporting itself: two results for one unit, sent by the node
  const fwdBefore = await bal(fwd)
  const ownBefore = (await reg.nodes(fwd.address)).stake
  const poolBefore = (await reg.pools(fwd.address)).stake
  const sigA = await sign(fwd, 9, 0n, id('one'))
  const sigB = await sign(fwd, 9, 0n, id('two'))
  await (await reg.connect(fwd).slashDoubleWork(fwd.address, 9, 0, id('one'), sigA, id('two'), sigB)).wait()
  const gained = (await bal(fwd)) - fwdBefore
  const lost = ownBefore - (await reg.nodes(fwd.address)).stake
  check('a node that reports itself gains less than it loses, and nothing of its delegators\' loss', gained < lost && (await reg.pools(fwd.address)).stake < poolBefore, `gained ${gained}, lost ${lost}`)

  // ---- sybil verifiers ----
  for (const [w, n] of [[s1, 20], [s2, 21]]) await register(reg, w, { dhtKey: key(n), roles: ROLES.VERIFY, stake: STAKE, token: tokenAddr })
  const g0 = { kind: 2, target: s1.address, value: 1n, nonce: 7n }
  const sybilGov = await reverts(reg.govern(g0.kind, g0.target, g0.value, g0.nonce, sortedSignatures([await signGovern(reg, s1, g0), await signGovern(reg, s2, g0)])))
  const stillWorks = await reverts(slashBy([v1, v2, v3], fwd.address, 1_000000n, 'fault 2'))
  check('new sybil verifiers can neither take the treasury nor block a slash in their first epoch', /quorum/.test(sybilGov) && stillWorks === null, sybilGov)
  await mine(EPOCH + 1)
  const weighed = await reverts(reg.govern(g0.kind, g0.target, g0.value, g0.nonce, sortedSignatures([await signGovern(reg, s1, g0), await signGovern(reg, s2, g0)])))
  check('…and once they vote, two of five with 40% of the stake are still no quorum: votes are weighed by stake', /quorum/.test(weighed))

  // ---- devices pay for their own jobs ----
  const issuer = Wallet.createRandom()
  const device = Wallet.createRandom()
  const did = key(0xd1)
  await (await reg.connect(admin).setIssuer(issuer.address, true)).wait()
  const credential = await issuer.signMessage(await reg.credentialText(did, device.address))
  const consent = await device.signMessage(await reg.claimText(did, owner.address))
  await (await reg.connect(owner).claimDevice(did, device.address, credential, consent)).wait()
  await (await token.connect(owner).approve(ctx.registry, 50n * PAY)).wait()
  await (await reg.connect(owner).fundDevice(did, 50n * PAY)).wait()
  const now = BigInt((await chain.provider.getBlock('latest')).timestamp)
  const terms = { role: ROLES.STORE, quorum: 2, perEpoch: 10, deadline: now + 600n, spec: id('boat-store/1'), pay: PAY, budget: 20n * PAY }
  const params = toUtf8Bytes(JSON.stringify({ window: 10 }))
  const reqSig = await device.signMessage(getBytes(jobRequestStatementOf(ctx, did, terms, params, 0n)))
  const before = Number(await reg.jobCount())
  await (await reg.connect(outsider).postJobFromDevice(did, terms, params, reqSig)).wait()
  const j = await reg.jobs(before)
  const replay = await reverts(reg.connect(outsider).postJobFromDevice(did, terms, params, reqSig))
  const forged = await reverts(reg.connect(outsider).postJobFromDevice(did, terms, params, await outsider.signMessage(getBytes(jobRequestStatementOf(ctx, did, terms, params, 1n)))))
  const tooMuch = { ...terms, budget: 100n * PAY }
  const overSpend = await reverts(reg.connect(outsider).postJobFromDevice(did, tooMuch, params, await device.signMessage(getBytes(jobRequestStatementOf(ctx, did, tooMuch, params, 1n)))))
  const later = { ...terms, budget: PAY }
  const laterSig = await device.signMessage(getBytes(jobRequestStatementOf(ctx, did, later, params, 1n)))
  await mine(601)
  const expired = await reverts(reg.connect(outsider).postJobFromDevice(did, later, params, laterSig))
  check('a device posts a job paid from its own balance, signed with its key; anyone relays it', j.payer === owner.address && j.device === did && j.budget === 20n * PAY && (await reg.deviceBalance(did)) === 30n * PAY)
  check('…once, only with its signature, within its balance, and before its deadline', !!replay && /device/.test(forged) && /device balance/.test(overSpend) && /expired/.test(expired), [replay, forged, overSpend, expired].map((x) => (x || '').slice(0, 26)).join(' / '))

  // ---- governance ----
  const g = { kind: 1, target: Wallet.createRandom().address, value: 1n, nonce: 1n }
  await (await reg.connect(admin).renounceAdmin()).wait()
  const adminGone = await reverts(reg.connect(admin).setIssuer(g.target, true))
  const voters = [v1, v2, v3, s1, s2]
  const sigsG = async (x) => sortedSignatures(await Promise.all(voters.map((v) => signGovern(reg, v, x))))
  await (await reg.connect(outsider).govern(g.kind, g.target, g.value, g.nonce, await sigsG(g))).wait()
  const replayGov = await reverts(reg.govern(g.kind, g.target, g.value, g.nonce, await sigsG(g)))
  check('after the admin renounces, issuers change only with a quorum of verifiers, by stake', /admin/.test(adminGone) && (await reg.issuers(g.target)) && /used/.test(replayGov))
  const treasury = await reg.treasury()
  const t = { kind: 2, target: outsider.address, value: treasury / 2n, nonce: 2n }
  const bo = await bal(outsider)
  await (await reg.govern(t.kind, t.target, t.value, t.nonce, await sigsG(t))).wait()
  check('the treasury pays out only by a quorum of verifiers', (await bal(outsider)) - bo === treasury / 2n, `${treasury / 2n} paid`)

  // ---- paid reads ----
  const reads = await deployReads(admin, { token: tokenAddr, registry: ctx.registry, notice: 600 })
  const rctx = { reads: await reads.getAddress(), chainId: 31337n }
  await (await token.connect(reader).approve(rctx.reads, 100_000000n)).wait()
  const notStore = await reverts(reads.connect(reader).open(fwd.address, 1_000000n))
  await (await reads.connect(reader).open(v1.address, 10_000000n)).wait()
  const voucher = (n, gen = 0n) => reader.signMessage(getBytes(readStatementOf(rctx, reader.address, v1.address, gen, n)))
  const bs = await bal(v1)
  await (await reads.connect(v1).redeem(reader.address, 3_000000n, await voucher(3_000000n))).wait()
  await (await reads.connect(v1).redeem(reader.address, 5_000000n, await voucher(5_000000n))).wait()
  const older = await reverts(reads.connect(v1).redeem(reader.address, 4_000000n, await voucher(4_000000n)))
  const overDeposit = await reverts(reads.connect(v1).redeem(reader.address, 11_000000n, await voucher(11_000000n)))
  const otherStore = await reverts(reads.connect(v2).redeem(reader.address, 6_000000n, await voucher(6_000000n)))
  check('a store redeems the reader\'s latest voucher; not an older one, more than deposited, or another store\'s', (await bal(v1)) - bs === 5_000000n && /amount/.test(older) && /amount/.test(overDeposit) && !!otherStore)
  await (await reads.connect(reader).close(v1.address)).wait()
  const keep = await voucher(9_000000n) // signed in generation 0, never redeemed
  await (await reads.connect(v1).redeem(reader.address, 6_000000n, await voucher(6_000000n))).wait() // during the notice
  await mine(601)
  const late = await reverts(reads.connect(v1).redeem(reader.address, 7_000000n, await voucher(7_000000n)))
  const br = await bal(reader)
  await (await reads.connect(reader).close(v1.address)).wait()
  check('a reader closes; the store still redeems during the notice, then the rest goes back', /closed/.test(late) && (await bal(reader)) - br === 4_000000n && /active store/.test(notStore))
  await (await reads.connect(reader).open(v1.address, 20_000000n)).wait()
  const stale = await reverts(reads.connect(v1).redeem(reader.address, 9_000000n, keep))
  await (await reads.connect(v1).redeem(reader.address, 2_000000n, await voucher(2_000000n, 1n))).wait()
  check('after a channel reopens, a voucher of the old one is no good', /reader/.test(stale), stale)
} catch (err) {
  console.error(err)
  failed++
} finally {
  chain.anvil.kill()
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
