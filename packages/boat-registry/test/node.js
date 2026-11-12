// boat-node end to end: node test/node.js
//
// Six nodes register themselves on a local chain and take three jobs on one
// meter: verify, store and compute (a bill). Three of them are dishonest:
//   N4 (forward, compute) signs bills the rule does not give, and once signs
//      two results for one unit
//   N5 (verify) signs a verdict the device's message does not support
//   N6 (store) signs for messages it then drops
// Nothing in this test judges anyone: the honest verifiers' watchtowers find
// the faults, agree on them and slash. Units settle on chain, honest nodes
// are paid and withdraw once their rewards mature, a slashed node loses what
// it had not withdrawn, devices get a node list two of three verifiers agree
// on, and a message's verdict is proven against a root settled on chain.

import fs from 'fs'
import os from 'os'
import path from 'path'
import createTestnet from 'hyperdht/testnet.js'
import { HDNodeWallet, Contract, getBytes, keccak256, AbiCoder } from 'ethers'
import { createNode, connect, publishHome, own, sign, open } from 'boat-mqtt-node'
import {
  deploy, deployTestToken, ROLES, TEST_TOKEN, createBoatNode, postJob, computeJob, verifyJob, storeJob, forwardJob, settledKey,
  workStatement, faultReason, Watchtower, readCard, readNodeList, tally, encodeNodeList, decodeNodeList, decodePage, leafOf, merkleProof, verifyProof, resultOf
} from '../index.js'
import { startChain, MNEMONIC } from './chain.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, ms = 30000) => {
  const end = Date.now() + ms
  let v
  while (!(v = await fn()) && Date.now() < end) await sleep(200)
  return v
}

const wasm = fs.readFileSync(new URL('../rules/energy-bill.wasm', import.meta.url))
const MIN = 100_000000n
const EPOCH = 15
const chain = await startChain(8556)
const testnet = await createTestnet(3)
const nodes = []
let meterTimer = null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-node-test-'))
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, payer, ...ops] = [0, 1, 2, 3, 4, 5, 6, 7].map(acct)
  const token = await deployTestToken(admin)
  const reg = await deploy(admin, { token: await token.getAddress(), minStake: MIN, unbonding: 600, epochLength: EPOCH, jobNotice: 10, plan: { spare: 10 } })
  for (const o of [payer, ...ops]) await (await token.mint(o.address, 1000_000000n)).wait()
  await (await token.mint(payer.address, 1000_000000n)).wait() // four jobs
  const registry = await reg.getAddress()

  const ALL = ROLES.FORWARD | ROLES.STORE | ROLES.VERIFY | ROLES.COMPUTE
  const roles = [ALL, ALL, ALL, ROLES.FORWARD | ROLES.COMPUTE, ROLES.VERIFY, ROLES.STORE]
  const lie = [
    null, null, null,
    { compute: (result, detail) => ({ detail: { ...detail, value: String(BigInt(detail.value) * 3n) }, result: null }) },
    // claims the first message carries a valid BoAT MER attestation
    { verify: (result, detail) => ({ detail: { ...detail, leaves: detail.leaves.map((l, i) => (i === 0 ? { ...l, verdict: l.verdict | 8 } : l)) }, result: null }) },
    null
  ]
  const logs = []
  for (const [i, o] of ops.entries()) {
    const l = lie[i] && Object.fromEntries(Object.entries(lie[i]).map(([k, f]) => [k, (r, d, u) => {
      const x = f(r, d, u)
      return { detail: x.detail, result: resultOf(k === 'compute' ? ROLES.COMPUTE : k === 'verify' ? ROLES.VERIFY : ROLES.STORE, x.detail) }
    }]))
    const n = await createBoatNode({
      dht: testnet.createNode(),
      seed: Buffer.alloc(32, 0x40 + i),
      operator: o,
      registry,
      roles: roles[i],
      stake: MIN,
      autoRegister: true,
      storage: path.join(tmp, 'n' + (i + 1)),
      network: 'boat-node-test',
      jobPollMs: 1000,
      listMs: 2000,
      settleDelayMs: 800,
      backupMs: 2500,
      rewardMs: 3000,
      metricsPort: i === 0 ? 0 : null, // any free port
      spotEvery: 1, // every unit a store signs is spot-checked here
      drop: i === 1 ? (topic, payload) => payload.length > 10 && payload.readBigUInt64BE(2) % 7n === 3n : null, // N2 loses readings
      watchers: i === 1 || i === 2 ? 1 : 10, // N2 and N3 watch one job each: faults reach them over the fault mesh
      lie: l
    })
    n.on('log', (line) => logs.push(`N${i + 1} ${line}`))
    nodes.push(n)
  }
  const [N1, N2, N3, N4, N5, N6] = nodes
  const faultsSeen = []
  N1.follower.on('peer', (from, topic, payload) => {
    if (topic.split('/')[2] === 'faults') try { faultsSeen.push(JSON.parse(payload.toString())) } catch {}
  })
  check('six nodes registered themselves with their roles and stake', (await Promise.all(ops.map((o) => reg.nodes(o.address)))).every((n, i) => n.active && n.stake === MIN && Number(n.roles) === roles[i]))
  const card = await readCard(N1.dht, N1.keyPair.publicKey)
  check('a node card names its store and verify keys', card && card.operator === ops[0].address && card.store === N1.card.store && card.verify === N1.card.verify)

  // the meter: home at N1's forwarding node
  const devDht = testnet.createNode()
  const meter = await connect(N1.keyPair.publicKey, { dht: devDht })
  const device = meter.publicKey.toString('hex')
  await publishHome(devDht, meter.keyPair, N1.keyPair.publicKey)
  const topic = own(device) + 'telemetry'
  let seq = 0
  let mwh = 1000000
  const sent = new Map()
  const tick = async () => {
    mwh += 1667 // 1.2 kW for 5 s
    const m = sign(meter.keyPair.secretKey, topic, seq, JSON.stringify({ seq, mwh }))
    sent.set(seq, m)
    seq++
    await meter.publishAsync(topic, m, { qos: 1 }).catch(() => {})
  }

  // three jobs, paid per unit of 5 messages
  const WINDOW = 5
  const PAY = 3_000000n
  const job = async (j, quorum) => postJob(reg, payer, { ...j, device, pay: PAY, quorum, budget: PAY * 100n })
  const jv = await job(verifyJob({ window: WINDOW }), 2)
  const js = await job(storeJob({ window: WINDOW }), 2)
  const jc = await job(computeJob({ wasm, field: 'mwh', window: WINDOW, price: 250 }), 2)
  const jf = await job(forwardJob({ window: WINDOW }), 2)
  check('four jobs posted with their budgets', Number(await reg.jobCount()) === 4 && (await reg.jobs(jc)).budget === PAY * 100n)
  await until(() => nodes.every((n) => n.jobs.size === (n.roles & ROLES.VERIFY ? 4 : [...n.jobs.values()].length)) && N4.workers.size === 2 && N5.workers.size === 2 && N6.workers.size === 1, 20000)
  check('each node took the jobs of its roles; verifiers watch all four', N1.workers.size === 4 && N1.workers.get(jf).length === 2 && N4.workers.size === 2 && N5.workers.size === 2 && N6.workers.size === 1 && N5.jobs.size === 4, nodes.map((n) => n.workers.size + '/' + n.jobs.size).join(' '))
  // the liars' workers: a node slashed below the minimum leaves its jobs (the
  // plan follows the chain), so they are kept here
  const liar4 = N4.workers.get(jc)[0]
  const liar5 = N5.workers.get(jv)[0]
  const liar6 = N6.workers.get(js)[0]

  // the store that drops what it stored
  const drop = setInterval(async () => {
    for (const d of N6.store.devices.values()) if (d.core.length) await d.core.clear(0, d.core.length).catch(() => {})
  }, 300)
  drop.unref()

  meterTimer = setInterval(() => tick(), 250)
  const units = (id) => [...Array(Math.floor(seq / WINDOW)).keys()].map((u) => reg.settled(settledKey(id, BigInt(u))))
  const settledCount = async (id) => (await Promise.all(units(id))).filter((r) => r !== '0x' + '0'.repeat(64)).length
  await until(async () => (await settledCount(jv)) >= 4 && (await settledCount(js)) >= 4 && (await settledCount(jc)) >= 4, 60000)
  const counts = [await settledCount(jv), await settledCount(js), await settledCount(jc)]
  check('units of all three jobs settle on chain by a quorum of signers', counts.every((c) => c >= 4), `verify ${counts[0]}, store ${counts[1]}, compute ${counts[2]} units`)

  // forwarding: the meter's node (N1) is paid, witnessed by the verifiers
  const before1 = await reg.rewards(ops[0].address)
  await until(async () => (await settledCount(jf)) >= 3, 30000)
  const fwdEvents = await reg.queryFilter(reg.filters.Settled(jf))
  const fu = fwdEvents[0]
  const fwdRoot = fu && N1.workers.get(jf)[0].signed.get(fu.args.unit)
  check('forwarding units settle: the meter\'s node signed them and verifiers that got them through it witnessed', fwdEvents.length >= 3 && fwdRoot && fwdRoot.detail.forwarder === ops[0].address && fu.args.signers >= 3n, `${fwdEvents.length} units, ${fu ? fu.args.signers : 0} signers`)
  const forwardPaid = fwdEvents.reduce((a, e) => a + e.args.pay, 0n)
  check('the forwarding node alone is paid for forwarding', forwardPaid === PAY * BigInt(fwdEvents.length))

  // the settled results are the honest ones
  const w1 = N1.workers.get(jc)[0].signed
  // (every unit N1 signed that has settled by now: which ones have is a race)
  const zero = '0x' + '0'.repeat(64)
  const onChain = await Promise.all([...w1.keys()].map(async (u) => [u, await reg.settled(settledKey(jc, u))]))
  const settledBills = onChain.filter(([, r]) => r !== zero)
  check('the settled bill is what the honest nodes signed', settledBills.length > 0 && settledBills.every(([u, r]) => r === w1.get(u).result), `${settledBills.length} units`)
  const ws = liar5.signed
  check('the verifier that lied never got a unit settled for its result', ws.size > 0 && (await Promise.all([...ws.entries()].map(async ([k, w]) => (await reg.settled(settledKey(jv, k))) !== w.result))).every(Boolean))

  // the watchtowers: no one asked them to
  const s4 = await until(async () => {
    const ev = await reg.queryFilter(reg.filters.Slashed(ops[3].address))
    return ev.find((e) => [...liar4.signed.keys()].some((k) => e.args.reason === faultReason('wrong-value', ops[3].address, jc, k)))
  }, 40000)
  check('the bill that was not the rule\'s value is slashed by the watchtowers (wrong-value)', !!s4, s4 ? `${s4.args.amount} taken` : '')
  const s5 = await until(async () => {
    const ev = await reg.queryFilter(reg.filters.Slashed(ops[4].address))
    return ev.find((e) => [...liar5.signed.keys()].some((k) => e.args.reason === faultReason('wrong-input', ops[4].address, jv, k)))
  }, 40000)
  check('the verdict the device\'s own message contradicts is slashed (wrong-input)', !!s5)
  const s6 = await until(async () => {
    const ev = await reg.queryFilter(reg.filters.Slashed(ops[5].address))
    return ev.find((e) => [...liar6.signed.keys()].some((k) => e.args.reason === faultReason('store-failed', ops[5].address, js, k)))
  }, 60000)
  check('the store that dropped what it signed fails its spot check and is slashed (store-failed)', !!s6, s6 ? `${s6.args.amount} taken, its unmatured rewards with it` : '')
  check('a slash also takes the rewards that had not matured', s6 && s6.args.amount > (MIN * 2000n) / 10000n && (await reg.rewards(ops[5].address)).pending === 0n)

  check('faults reach every verifier over the fault mesh, not only those at the device\'s node', [N1, N2, N3, N5].every((n) => n.faultsReceived > 0), [N1, N2, N3, N5].map((n) => n.faultsReceived).join(', ') + ' received')
  check('a node below the minimum stake is no longer active', !(await reg.nodes(ops[3].address)).active && !(await reg.isActive(ops[3].address, ROLES.COMPUTE)))

  // rewards: earned per unit, withdrawn once matured (two epochs later)
  const r1 = await reg.rewards(ops[0].address)
  check('honest nodes earn per settled unit', r1.pending + r1.matured > 0n || N1.withdrawn > 0n, `N1 pending ${r1.pending}`)
  const tok = new Contract(await token.getAddress(), TEST_TOKEN.abi, chain.provider)
  const b0 = await tok.balanceOf(ops[0].address)
  await until(async () => N1.withdrawn > 0n, (EPOCH * 2 + 10) * 1000)
  // (on a slow machine the first withdrawal is done before the balance above
  // is read: the registry's event is the proof then)
  const paidOut = await reg.queryFilter(reg.filters.RewardsWithdrawn(ops[0].address))
  check('rewards are withdrawn after they mature', N1.withdrawn > 0n && ((await tok.balanceOf(ops[0].address)) > b0 || paidOut.some((e) => e.args.amount > 0n)), `N1 withdrew ${N1.withdrawn}`)

  // the node list
  const trusted = [N1, N2, N3].map((n) => n.card.verify)
  const nl = await until(() => readNodeList(testnet.createNode(), trusted, { all: true }), 20000)
  const forwardKeys = [N1, N2, N3].map((n) => n.keyPair.publicKey.toString('hex'))
  check('three verifiers put out the same node list; a device needs no chain to take it', nl && nl.votes >= 2 && forwardKeys.every((k) => nl.list.nodes.includes(k)) && !nl.list.nodes.includes(N4.keyPair.publicKey.toString('hex')), nl ? `${nl.list.nodes.length} nodes, ${nl.votes} of ${trusted.length} agree, the slashed node is not listed` : '')
  check('the list names the active verifiers by verify key, for devices to trust next; not the slashed one', nl && [N1, N2, N3].every((n) => nl.list.verifiers.includes(n.card.verify)) && !nl.list.verifiers.includes(N5.card.verify))

  // a verifier that did not see the messages judges a fault from its evidence alone
  const judge = new Watchtower({ dht: testnet.createNode(), registry: reg, operator: ops[0], ctx: N1.ctx, jobs: N1.jobs, publish: async () => {}, minStake: MIN })
  const fi = faultsSeen.find((f) => f.kind === 'wrong-input')
  const fv = faultsSeen.find((f) => f.kind === 'wrong-value')
  const bent = Buffer.from(fi.evidence.message, 'base64')
  bent[bent.length - 1] ^= 1
  const honest = [...N2.workers.get(jc)[0].signed.values()][0]
  const verdicts = [await judge.rejudge(fi), await judge.rejudge(fv), await judge.rejudge({ ...fi, evidence: { ...fi.evidence, message: bent.toString('base64') } }), await judge.rejudge({ ...fv, operator: honest.operator, work: honest })]
  check('another verifier agrees from the evidence alone; not with changed evidence or an honest node', verdicts.join() === 'true,true,false,false', verdicts.join(', '))
  await judge.dht.destroy()
  const forged = encodeNodeList({ ...nl.list, nodes: ['ab'.repeat(32)] }).main
  check('one verifier alone cannot steer devices to its own node', tally([forged, null, null], 3) === null && tally([forged, nl.main, nl.main], 3).main.equals(nl.main))
  const again = encodeNodeList({ ...nl.list, nodes: nl.list.nodes })
  check('a list round-trips through its encoding; its page is the immutable record it names', again.main.equals(nl.main) && decodeNodeList(nl.main).pages[0] === nl.list.pages[0] && decodePage(again.pages[0]).join() === nl.list.nodes.join())

  // N2 lost one reading in 7 on the way: it fetched them from the stores
  const w2 = N2.workers.get(jv)[0]
  // (a unit N1 just signed may still be short on N2 while it fetches: on a
  // slow machine two were, at the moment this looked. Given a little time
  // it has all but the newest)
  await until(() => w2.signedCount >= N1.workers.get(jv)[0].signedCount - 1, 30000)
  check('a node that lost readings fetches them from the stores and still signs every unit', N2.backfilled > 0 && w2.signedCount >= N1.workers.get(jv)[0].signedCount - 1, `${N2.backfilled} readings fetched; N2 signed ${w2.signedCount} units, N1 ${N1.workers.get(jv)[0].signedCount}`)

  // metrics
  const port = N1.metricsServer.address().port
  const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()
  const metric = (name) => Number((new RegExp(`^boat_node_${name} (\\S+)$`, 'm').exec(text) || [])[1])
  check('a node serves Prometheus metrics', metric('active') === 1 && metric('units_signed_total') > 0 && metric('units_settled_total') > 0 && metric('faults_total') > 0 && metric('stake') > 0, `signed ${metric('units_signed_total')}, settled ${metric('units_settled_total')}, faults ${metric('faults_total')}`)

  // a message's verdict, proven against a root settled on chain
  const wv = [...N2.workers.get(jv)[0].signed.values()][1]
  const leaves = wv.detail.leaves.map(leafOf)
  const proof = merkleProof(leaves, 2)
  const root = await reg.settled(settledKey(jv, BigInt(wv.unit)))
  const m = sent.get(Number(wv.detail.leaves[2].seq))
  check('a message\'s verdict is proven against the root settled on chain', root === wv.result && verifyProof(leaves[2], proof, root) && open(Buffer.from(device, 'hex'), topic, m) && wv.detail.leaves[2].payloadHash === (await import('ethers')).keccak256(m))

  // two results for one unit (an honest node made to sign twice): the contract checks that itself
  const w3 = [...N3.workers.get(jc)[0].signed.values()].at(-1)
  const other = '0x' + '11'.repeat(32)
  const sig = await ops[2].signMessage(getBytes(workStatement({ registry, chainId: 31337n }, w3.job, BigInt(w3.unit), other)))
  await N3.follower.publish(`d/${N3.ctx.nodeKey}/work/${w3.device}/${w3.job}/${w3.unit}`, JSON.stringify({ ...w3, result: other, signature: sig }), { qos: 1, retain: true })
  const dwReason = keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256', 'uint64'], ['double work', w3.job, BigInt(w3.unit)]))
  const sd = await until(async () => (await reg.queryFilter(reg.filters.Slashed(ops[2].address))).find((e) => e.args.reason === dwReason), 20000)
  check('two results signed for one unit are slashed at once (slashDoubleWork)', !!sd, sd ? `half the stake: ${sd.args.amount - 0n} with rewards` : '')

  // a job closes after its notice and returns what is left
  const before = await tok.balanceOf(payer.address)
  await (await reg.connect(payer).closeJob(jc)).wait()
  await sleep(11000)
  await (await reg.connect(payer).closeJob(jc)).wait()
  const back = (await tok.balanceOf(payer.address)) - before
  check('a closed job returns its budget left after the notice', back > 0n && (await reg.jobs(jc)).budget === 0n, `${back} back`)

  const st = N1.status()
  console.log(`N1: ${st.signed} units signed, ${st.settled.submitted} settled by it, watch ${JSON.stringify(st.watch)}`)
  for (const n of nodes) console.log(`  ${n.operator.address.slice(0, 10)}… stake ${(await reg.nodes(n.operator.address)).stake}`)
  if (failed) console.log(logs.filter((l) => /FAULT|SLASH|error|cannot/i.test(l)).slice(-30).join('\n'))
  meter.end(true)
} catch (err) {
  console.error(err)
  failed++
} finally {
  clearInterval(meterTimer)
  for (const n of nodes) await n.close().catch(() => {})
  await testnet.destroy()
  chain?.anvil.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
