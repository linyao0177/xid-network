// A weather network on a local chain, end to end: node test/e2e.js
//
// Four boat-nodes with the xid-depin plugin (forward, verify, compute) and a
// weather network with 20-second epochs. Six simulated stations:
//   A, B   Taipei, 300 m apart: they hear each other's beacons
//   C      Taipei, in A's and B's area: three share what one earns in full
//   D      Taoyuan, its own area
//   E      says it is in Berlin, but every oracle reaches it in a few ms
//   F      enrolled, never online
// The oracles score epoch 0 from each other's sheets, sign the same root,
// settle it on the registry (and are paid for it), publish it on the
// network; then anyone claims a station's reward for its payee.

import fs from 'fs'
import os from 'os'
import path from 'path'
import createTestnet from 'hyperdht/testnet.js'
import HyperDHT from 'hyperdht'
import { HDNodeWallet, Contract, getAddress } from 'ethers'
import { connect, publishHome } from 'boat-mqtt-node'
import { deploy, deployTestToken, createBoatNode, ROLES, TEST_TOKEN } from 'boat-registry'
import { startChain, MNEMONIC } from 'boat-registry/test/chain.js'
import { plugin, deployNetwork, attachNetwork, attachToken, loadTemplate, DepinDevice, SimRadio, cellAt, claimOf, hex } from '../index.js'
import { verifyProof } from 'boat-registry/lib/merkle.js'

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, ms = 30000) => {
  const end = Date.now() + ms
  let v
  while (!(v = await fn()) && Date.now() < end) await sleep(250)
  return v
}

const chain = await startChain(8572)
if (!chain) { console.log('SKIP no anvil'); process.exit(0) }
const testnet = await createTestnet(3)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xid-depin-e2e-'))
const nodes = []
const devices = []
const timers = []
const logs = []
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, payer, ...ops] = [0, 1, 2, 3, 4, 5].map(acct)
  const usd = await deployTestToken(admin)
  const MIN = 100_000000n
  const reg = await deploy(admin, { token: await usd.getAddress(), minStake: MIN, unbonding: 600, epochLength: 15, jobNotice: 10, plan: { spare: 1 } })
  const registry = await reg.getAddress()
  for (const o of [admin, payer, ...ops]) await (await usd.mint(o.address, 1000_000000n)).wait()

  // four oracles near Taipei (the local testnet's round trips are a few ms)
  const where = [[25.03, 121.56], [25.05, 121.52], [24.99, 121.60], [25.10, 121.50]]
  for (const [i, o] of ops.entries()) {
    const n = await createBoatNode({
      dht: testnet.createNode(),
      seed: Buffer.alloc(32, 0x60 + i),
      operator: o,
      registry,
      roles: ROLES.FORWARD | ROLES.VERIFY | ROLES.COMPUTE,
      stake: MIN,
      autoRegister: true,
      storage: path.join(tmp, 'n' + (i + 1)),
      network: 'xid-depin-test',
      jobPollMs: 1000,
      listMs: 60000,
      settleDelayMs: 800,
      backupMs: 2500,
      rewardMs: 3000,
      plugins: [plugin({ lat: where[i][0], lon: where[i][1], collectMs: 2000, waitMs: 10000, pingMs: 2000, tickMs: 500, deviceMs: 1500, publishGapMs: 3000 })]
    })
    n.on('log', (line) => logs.push(`N${i + 1} ${line}`))
    nodes.push(n)
  }
  check('four nodes registered with the plugin', nodes.every((n) => n.plugins.length === 1))

  // the network: its key's home at N1
  const netKP = HyperDHT.keyPair()
  const netKey = hex(netKP.publicKey)
  const keeper = testnet.createNode()
  await publishHome(keeper, netKP, nodes[0].keyPair.publicKey)
  const config = loadTemplate('weather')
  config.epoch = { length: 20, slots: 4 }
  config.enroll.fee = '1000000'
  const t0 = Math.floor(Date.now() / 1000) + 25 // epoch 0 starts once all is set up
  const d = await deployNetwork(admin, { registry, config, netKey, start: t0, job: { quorum: 2, pay: 2_000000n, budget: 40_000000n } })
  const net = attachNetwork(d.network, payer)
  const rwd = attachToken(d.token, payer)
  check('network deployed, its oracles\' job attached', (await net.jobAttached(d.job)) && (await rwd.minter()) === d.network)

  // the stations
  const radio = new SimRadio()
  const place = { A: [25.0330, 121.5654], B: [25.0310, 121.5630], C: [25.0390, 121.5600], D: [24.9936, 121.3010], E: [52.52, 13.405], F: [25.04, 121.51] }
  const payee = {}
  for (const [name, [lat, lon]] of Object.entries(place)) {
    const kp = HyperDHT.keyPair()
    payee[name] = HDNodeWallet.createRandom().address
    const dev = new DepinDevice({ dht: testnet.createNode(), keyPair: kp, home: hex(nodes[devices.length % 4].keyPair.publicKey), net: netKey, config, payee: payee[name], cell: cellAt(lat, lon, config.location.resolution) })
    dev.name = name
    devices.push(dev)
  }
  const usdP = new Contract(await usd.getAddress(), TEST_TOKEN.abi, payer)
  await (await usdP.approve(d.network, 10_000000n)).wait()
  for (const dev of devices) await (await net.enroll('0x' + dev.did)).wait()
  check('six stations enrolled for the fee', Number(await net.deviceCount()) === 6 && (await net.fees()) === 6_000000n)
  await (await net.sendFees()).wait()
  check('the fees went to the oracles\' job', (await reg.jobs(d.job)).budget === 40_000000n + 6_000000n)

  const on = devices.filter((x) => x.name !== 'F')
  for (const dev of on) await dev.start()
  // E is in Taipei for the radio too: it is only its claim that is far
  for (const dev of on) radio.add(dev, ...(dev.name === 'E' ? [25.0, 121.5] : place[dev.name]))
  const reading = () => ({ t: 200 + Math.floor(Math.random() * 30), h: 600 + Math.floor(Math.random() * 50), p: 10120 + Math.floor(Math.random() * 20) })
  timers.push(setInterval(() => { for (const dev of on) dev.reading(reading()).catch(() => {}) }, 2000))
  const slotLen = config.epoch.length / config.epoch.slots
  timers.push(setInterval(() => {
    const slot = Math.floor((Date.now() / 1000 - t0) / slotLen)
    if (slot >= 0) radio.slot(slot).catch(() => {})
  }, slotLen * 1000))

  await until(() => nodes.filter((n) => n.workers.has(d.job)).length >= 3, 30000)
  const oracles = nodes.filter((n) => n.workers.has(d.job))
  check('the plan made three of the four nodes the network\'s oracles (quorum 2 + 1 spare)', oracles.length === 3, String(oracles.length))
  const signed = []
  const scored = []
  for (const n of oracles) {
    const o = n.workers.get(d.job)[0]
    o.on('signed', (w) => signed.push(w))
    o.on('scored', (s) => scored.push(s))
  }

  // epoch 0: t0 .. t0+20, then collect 2 s, then score
  const wait = (t0 + 20) * 1000 - Date.now() + 20000
  console.log(`(waiting ${Math.round(wait / 1000)} s for epoch 0 to end and settle)`)
  await until(async () => (await net.epochs(0)).publishedAt > 0n, wait + 30000)
  const ep = await net.epochs(0)
  check('every oracle signed the same root for epoch 0', signed.filter((w) => w.unit === '0').length === 3 && new Set(signed.filter((w) => w.unit === '0').map((w) => w.result)).size === 1, signed.map((w) => w.result.slice(0, 10)).join(' '))
  check('epoch 0 settled on the registry and published on the network', ep.publishedAt > 0n && ep.root === signed[0]?.detail.root, ep.root)
  check('what was published is within the emission', ep.total <= (await net.emission(0)) && ep.total > 0n, String(ep.total))
  const tree = scored.find((s) => s.epoch === 0)?.tree
  const row = (name) => tree.rows.find((r) => r.did === devices.find((x) => x.name === name).did)
  console.log(tree.rows.map((r) => `  ${devices.find((x) => x.did === r.did).name}: ${r.location}, uptime ${r.uptime}, quality ${r.quality}, coverage ${r.coverage}, share ${r.share}, ${BigInt(r.amount) / 10n ** 18n} WXR`).join('\n'))
  check('A, B and C are located, up and covered', ['A', 'B', 'C'].every((n) => row(n).location === 'ok' && row(n).uptime > 0 && row(n).coverage > 0))
  check('A, B and C share their area', ['A', 'B', 'C'].every((n) => row(n).share === 3333))
  check('D, alone in its area, earns the most', BigInt(row('D').amount) > BigInt(row('A').amount))
  check('E, claiming Berlin, is ruled out by the round trips', /too far/.test(row('E').location) && row('E').amount === '0', row('E').location)
  check('F, never online, earns nothing', row('F').amount === '0' && row('F').location === 'no join record')

  // the rewards tree, from the network's home node, as a claimer gets it
  const claimer = await connect(nodes[0].keyPair.publicKey, { dht: testnet.createNode() })
  const trees = []
  claimer.on('message', (topic, payload) => { if (topic.endsWith('/0/rewards')) trees.push(JSON.parse(payload.toString())) })
  await claimer.subscribeAsync(`d/+/depin/${netKey}/0/rewards`, { qos: 1 })
  await until(() => trees.length >= 1, 10000)
  const t = trees[0]
  check('the rewards tree is on the network\'s home node', t && t.root === ep.root && t.leaves.length === Number(ep.devices))
  const A = devices.find((x) => x.name === 'A')
  const c = claimOf({ epoch: 0, leaves: tree.leaves }, A.did)
  check('A\'s claim proves against the root', c && verifyProof(tree.leaves.find((l) => l.did === A.did).leaf, c.proof, ep.root))
  await (await net.claimMany([{ epoch: 0, did: '0x' + A.did, payee: c.payee, amount: c.amount, proof: c.proof }])).wait()
  check('anyone claims for A: its payee is paid', (await rwd.balanceOf(payee.A)) === c.amount && c.amount > 0n, String(c.amount))
  await (await net.claimMany([{ epoch: 0, did: '0x' + A.did, payee: c.payee, amount: c.amount, proof: c.proof }])).wait()
  check('a second claim pays nothing more', (await rwd.balanceOf(payee.A)) === c.amount)
  check('the stations answered the oracles\' pings', on.every((x) => x.stats.pongs > 0), on.map((x) => x.stats.pongs).join(' '))

  await until(async () => (await Promise.all(oracles.map((n) => reg.rewards(n.operator.address)))).filter(([p, m]) => p + m > 0n).length >= 2, 15000)
  const paid = await Promise.all(oracles.map((n) => reg.rewards(n.operator.address)))
  check('the oracles that settled the epoch were paid from the job', paid.filter(([p, m]) => p + m > 0n).length >= 2, paid.map(([p, m]) => String(p + m)).join(' '))
  check('no watchtower judged the oracles\' work as a fault', !logs.some((l) => /FAULT/.test(l)), logs.filter((l) => /FAULT/.test(l)).slice(0, 2).join(' | '))
  claimer.end(true)
  await keeper.destroy()
} catch (err) {
  failed++
  console.log('FAIL ' + (err.stack || err))
} finally {
  for (const t of timers) clearInterval(t)
  if (failed) console.log(logs.slice(-60).join("\n"))
  for (const dev of devices) await dev.close().catch(() => {})
  for (const n of nodes) await n.close().catch(() => {})
  await testnet.destroy()
  chain.anvil.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
