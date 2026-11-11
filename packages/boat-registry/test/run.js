// Tests for the registry contract on a fresh anvil chain: node test/run.js

import { HDNodeWallet, Wallet, id, keccak256, toUtf8Bytes, ZeroHash, getBytes, ZeroAddress } from 'ethers'
import { deploy, deployTestToken, register, batchStatement, slashStatementOf, signSlash, sortedSignatures, asBytes32, ROLES, postJob, workStatement, settledKey } from '../index.js'
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

const chain = await startChain(8552)
if (!chain) {
  console.log('SKIP: anvil not found')
  process.exit(0)
}
const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
const [admin, v1, v2, v3, store, reporter, owner, stranger] = [0, 1, 2, 3, 4, 5, 6, 7].map(acct)
const STAKE = 100_000000n // 100 tokens of 6 decimals
const key = (n) => asBytes32(Buffer.alloc(32, n))

try {
  const token = await deployTestToken(admin)
  const tokenAddr = await token.getAddress()
  const reg = await deploy(admin, { token: tokenAddr, minStake: STAKE, unbonding: 600, quorumBps: 6667 })
  for (const w of [v1, v2, v3, store, stranger]) await (await token.mint(w.address, 1000_000000n)).wait()

  // nodes
  for (const [w, n] of [[v1, 1], [v2, 2], [v3, 3]]) await register(reg, w, { dhtKey: key(n), roles: ROLES.VERIFY | ROLES.FORWARD, stake: STAKE, token: tokenAddr })
  await register(reg, store, { dhtKey: key(9), roles: ROLES.STORE, stake: 2n * STAKE, token: tokenAddr })
  // verifiers vote one epoch after they register
  await chain.provider.send('evm_increaseTime', [3600])
  await chain.provider.send('evm_mine', [])
  const low = await reverts(register(reg, stranger, { dhtKey: key(7), roles: ROLES.STORE, stake: STAKE - 1n, token: tokenAddr }))
  const again = await reverts(register(reg, v1, { dhtKey: key(1), roles: ROLES.VERIFY, stake: STAKE, token: tokenAddr }))
  check('nodes register with stake and roles; under the minimum or twice is refused', (await reg.verifierCount()) === 3n && await reg.isActive(store.address, ROLES.STORE) && !(await reg.isActive(store.address, ROLES.VERIFY)) && /minimum/.test(low) && /already/.test(again))

  // capacity: how many jobs a node takes (0: no limit)
  await (await reg.connect(v1).setCapacity(40)).wait()
  const capStranger = await reverts(reg.connect(stranger).setCapacity(5))
  check('a node sets how many jobs it takes; an address that is not an active node may not', (await reg.nodes(v1.address)).capacity === 40n && /not active/.test(capStranger))

  // a double batch: two statements for one batch of a job, slashed by anyone
  const bctx = { registry: await reg.getAddress(), chainId: (await chain.provider.getNetwork()).chainId }
  const claim = async (w, job, batch, root, units, forwarder = ZeroAddress) => ({ root, units, forwarder, sig: await w.signMessage(getBytes(batchStatement(bctx, job, batch, root, units, forwarder))) })
  const cA = await claim(v3, 0, 7, id('A'), 10)
  const cB = await claim(v3, 0, 7, id('B'), 10)
  const before = await token.balanceOf(reporter.address)
  await (await reg.connect(reporter).slashDoubleBatch(v3.address, 0, 7, cA, cB)).wait()
  const n3 = await reg.nodes(v3.address)
  const reward = (await token.balanceOf(reporter.address)) - before
  const dup = await reverts(reg.connect(reporter).slashDoubleBatch(v3.address, 0, 7, cA, cB))
  const cSame = await claim(v1, 0, 8, id('A'), 10)
  const same = await reverts(reg.connect(reporter).slashDoubleBatch(v1.address, 0, 8, cSame, cSame))
  check('a node that signs two statements for one batch of a job loses half its stake; the reporter gets half of that', n3.stake === STAKE / 2n && reward === STAKE / 4n && (await reg.treasury()) === STAKE / 4n && /already/.test(dup) && /same statement/.test(same))
  check('below the minimum stake it is no longer active, nor counted as a verifier', !n3.active && (await reg.verifierCount()) === 2n)

  // a judgement by the verifiers: the store failed its spot checks
  const reason = keccak256(toUtf8Bytes('store failed spot checks: 10 of 20 blocks'))
  const judgement = { operator: store.address, amount: STAKE / 2n, reason, nonce: 1 }
  const one = [await signSlash(reg, v1, judgement)]
  const withStranger = [...one, await signSlash(reg, stranger, judgement)]
  const noQuorum = await reverts(reg.connect(reporter).slash(store.address, STAKE / 2n, reason, 1, sortedSignatures(one)))
  const notVerifier = await reverts(reg.connect(reporter).slash(store.address, STAKE / 2n, reason, 1, sortedSignatures(withStranger)))
  const two = [...one, await signSlash(reg, v2, judgement)]
  const unsorted = sortedSignatures(two).reverse()
  const badOrder = await reverts(reg.connect(reporter).slash(store.address, STAKE / 2n, reason, 1, unsorted))
  await (await reg.connect(reporter).slash(store.address, STAKE / 2n, reason, 1, sortedSignatures(two))).wait()
  const replay = await reverts(reg.connect(reporter).slash(store.address, STAKE / 2n, reason, 1, sortedSignatures(two)))
  check('one verifier, or one and an outsider, is no quorum; signatures must be sorted', /quorum/.test(noQuorum) && /quorum/.test(notVerifier) && /sorted/.test(badOrder))
  check('two of two active verifiers slash the store; the same judgement cannot be used twice', (await reg.nodes(store.address)).stake === 3n * STAKE / 2n && /already/.test(replay))

  // unbonding
  await (await reg.connect(v1).startUnbonding()).wait()
  const early = await reverts(reg.connect(v1).withdraw())
  await chain.provider.send('evm_increaseTime', [601])
  await chain.provider.send('evm_mine', [])
  const b1 = await token.balanceOf(v1.address)
  await (await reg.connect(v1).withdraw()).wait()
  check('stake comes back only after the unbonding period', /still bonded/.test(early) && (await token.balanceOf(v1.address)) - b1 === STAKE && (await reg.verifierCount()) === 1n)

  // devices: a manufacturer credential and the device's own consent
  const issuer = Wallet.createRandom()
  const device = Wallet.createRandom() // the device's secp256k1 key (BoAT MER)
  const did = asBytes32(Buffer.alloc(32, 0xd1))
  await (await reg.connect(admin).setIssuer(issuer.address, true)).wait()
  const credential = await issuer.signMessage(await reg.credentialText(did, device.address))
  const consent = await device.signMessage(await reg.connect(owner).claimText(did, owner.address))
  const forOther = await device.signMessage(await reg.claimText(did, stranger.address))
  const wrongOwner = await reverts(reg.connect(owner).claimDevice(did, device.address, credential, forOther))
  const fakeIssuer = await reverts(reg.connect(owner).claimDevice(did, device.address, await Wallet.createRandom().signMessage(await reg.credentialText(did, device.address)), consent))
  await (await reg.connect(owner).claimDevice(did, device.address, credential, consent)).wait()
  const d = await reg.devices(did)
  const twiceClaim = await reverts(reg.connect(stranger).claimDevice(did, device.address, credential, forOther))
  check('a device is claimed with its credential and its consent to that owner', d.owner === owner.address && d.wallet === device.address && d.issuer === issuer.address && /consent/.test(wrongOwner) && /issuer/.test(fakeIssuer) && /already/.test(twiceClaim), await reg.claimText(did, owner.address).then((t) => t.slice(0, 40) + '…'))
  const sctx = { registry: await reg.getAddress(), chainId: 31337n }
  check('the slashing statement covers this registry and chain only', slashStatementOf(sctx, store.address, 1n, ZeroHash, 1n) !== slashStatementOf({ ...sctx, chainId: 1n }, store.address, 1n, ZeroHash, 1n) && slashStatementOf(sctx, store.address, 1n, ZeroHash, 1n) !== slashStatementOf({ ...sctx, registry: ZeroAddress }, store.address, 1n, ZeroHash, 1n))

  // jobs, settlement and rewards
  const [c1, c2, payer] = [8, 9, 10].map(acct)
  for (const w of [c1, c2, payer]) await (await token.mint(w.address, 1000n * STAKE)).wait()
  for (const [w, n] of [[c1, 8], [c2, 9]]) await register(reg, w, { dhtKey: key(n), roles: ROLES.COMPUTE, stake: STAKE, token: tokenAddr })
  const PAY = 10_000000n
  const job = await postJob(reg, payer, { role: ROLES.COMPUTE, device: key(0xdd), spec: id('rule'), params: { window: 5 }, pay: PAY, quorum: 2, budget: 3n * PAY })
  const ctx = { registry: await reg.getAddress(), chainId: 31337n }
  const result = id('a bill')
  const signW = (w, unit, r = result) => w.signMessage(getBytes(workStatement(ctx, job, unit, r)))
  const sorted = async (ws, unit, r) => (await Promise.all(sortBySigners(ws).map((w) => signW(w, unit, r))))
  const sortBySigners = (ws) => ws.slice().sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1))
  const alone = await reverts(reg.connect(stranger).settle(job, 0, result, await sorted([c1], 0n)))
  const withOutsider = await reverts(reg.connect(stranger).settle(job, 0, result, await sorted([c1, stranger], 0n)))
  const wrongRole = await reverts(reg.connect(stranger).settle(job, 0, result, await sorted([c1, v2], 0n)))
  await (await reg.connect(stranger).settle(job, 0, result, await sorted([c1, c2], 0n))).wait()
  const twiceSettled = await reverts(reg.connect(stranger).settle(job, 0, result, await sorted([c1, c2], 0n)))
  const r1 = await reg.rewards(c1.address)
  check('a unit settles once, with a quorum of active nodes of the job\'s role, who share its pay', (await reg.settled(settledKey(job, 0n))) === result && r1.pending === PAY / 2n && /quorum/.test(alone) && /quorum/.test(withOutsider) && /quorum/.test(wrongRole) && /settled/.test(twiceSettled) && (await reg.jobs(job)).budget === 2n * PAY)
  const unripe = await reverts(reg.connect(c1).withdrawRewards())
  await chain.provider.send('evm_increaseTime', [3600])
  await chain.provider.send('evm_mine', [])
  const stillPending = (await reg.rewards(c1.address)).pending
  await chain.provider.send('evm_increaseTime', [3600])
  await chain.provider.send('evm_mine', [])
  const bc = await token.balanceOf(c1.address)
  await (await reg.connect(c1).withdrawRewards()).wait()
  check('rewards mature after the next epoch has ended, then are withdrawn', /nothing matured/.test(unripe) && stillPending === PAY / 2n && (await token.balanceOf(c1.address)) - bc === PAY / 2n)
  await (await reg.connect(stranger).settle(job, 1, result, await sorted([c1, c2], 1n))).wait()
  const sigA = await signW(c2, 2n, id('one'))
  const sigB = await signW(c2, 2n, id('two'))
  await (await reg.connect(reporter).slashDoubleWork(c2.address, job, 2, id('one'), sigA, id('two'), sigB)).wait()
  const ev = (await reg.queryFilter(reg.filters.Slashed(c2.address))).at(-1)
  check('two results for one unit cost half the stake and the rewards not matured yet', ev.args.amount === STAKE / 2n + PAY / 2n && (await reg.rewards(c2.address)).pending === 0n)
  const notPayer = await reverts(reg.connect(stranger).closeJob(job))
  await (await reg.connect(payer).closeJob(job)).wait()
  const tooSoon = await reverts(reg.connect(payer).closeJob(job))
  await chain.provider.send('evm_increaseTime', [3601])
  await chain.provider.send('evm_mine', [])
  const late = await reverts(reg.connect(stranger).settle(job, 3, result, await sorted([c1, c2], 3n)))
  const bp = await token.balanceOf(payer.address)
  await (await reg.connect(payer).closeJob(job)).wait()
  check('only the payer closes a job; it settles through the notice, then returns the rest', /payer/.test(notPayer) && /notice/.test(tooSoon) && /closed/.test(late) && (await token.balanceOf(payer.address)) - bp === PAY)
} finally {
  chain.anvil.kill()
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
