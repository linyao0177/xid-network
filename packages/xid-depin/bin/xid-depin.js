#!/usr/bin/env node
// xid-depin: start a DePIN network on the xid network, and run it.
//
//   xid-depin templates
//   xid-depin new <template> <dir> [--name n] [--epoch seconds] [--slots n]
//       <dir>/config.json from the template, and the network's key
//       (<dir>/network.key, mode 600, never printed)
//   xid-depin deploy <dir> --key <file> [--testnet | --rpc url --registry 0x..]
//       [--start unix-time] [--quorum 2] [--pay 1] [--budget 100]
//       deploys the reward token, the network, and the oracles' job on the
//       registry (pay and budget in the registry's token); <dir>/deployment.json
//   xid-depin keeper <dir> --home <node key> [--key <file>] [--claim]
//       keeps the network key's home record up (where oracles meet); with
//       --key, sends enrollment fees to the oracles' job; with --claim, claims
//       every published epoch's rewards for their payees
//   xid-depin get <dir> --testnet
//       the public testnet's DePIN network (config.json, deployment.json), to
//       run devices on it
//   xid-depin sim <dir> --home <node key>[,..] --stations "name@lat,lon;.." [--every 60]
//       [--key <file> | --enroll-via https://iot.xid.network]
//       simulated devices of the network's kind at those places: enrolled
//       (the key pays the fee, or the testnet does), join records, readings,
//       beacons and pongs
//   xid-depin station <dir> --device <key> --lat <lat> --lon <lon> --payee 0x..
//       [--rated W] [--node <node key>] [--key <file> | --enroll-via https://iot.xid.network]
//       a hardware station (examples/depin_station): enrolls it and prints
//       the line to type on its console, with the node it should be on: the
//       network's oracle nearest to it (from their last signed indexes), so
//       the oracles' pings to it take a short way
//   xid-depin status <dir>
//   xid-depin rewards <dir> <epoch>
//   xid-depin audit <dir> <epoch>
//       scores the epoch again from the oracles' published sheets and
//       compares the root with the one published on chain
//
// <file> holds an EVM private key (hex), mode 600; it is never printed.
// --bootstrap host:port[,..]: another HyperDHT than the public one (tests).

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import HyperDHT from 'hyperdht'
import { Wallet, Contract, HDNodeWallet, getAddress, keccak256 } from 'ethers'
import { connect, publishHome, homeOf } from 'boat-mqtt-node'
import { providerFor, TEST_TOKEN, attach, merkleRoot } from 'boat-registry'
import { loadTemplate, templates, checkConfig, configHash } from '../lib/config.js'
import { curveOf, emission } from '../lib/curve.js'
import { deployNetwork, attachNetwork, attachToken, networkInfo } from '../lib/network.js'
import { DepinDevice, SimRadio } from '../lib/device.js'
import { cellAt, distanceKm } from '../lib/geo.js'
import { hex } from '../lib/records.js'
import { scoreEpoch, claimOf, leafOf } from '../lib/score.js'
import { openIndex } from '../lib/oracle.js'

const SITE = 'https://iot.xid.network'
const [cmd, ...argv] = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : fallback
}
const BOOL = ['--testnet', '--claim', '--mint']
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !BOOL.includes(argv[i - 1])))
const log = (line) => console.log(new Date().toISOString().slice(11, 19) + ' ' + line)
const die = (msg) => { console.error(msg); process.exit(2) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const dirOf = (i = 0) => positional[i] || die('which network directory?')
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
const secret = (file) => {
  if (!file) die('--key <file>: an EVM private key, mode 600')
  const st = fs.statSync(file)
  if (st.mode & 0o077) die(`${file} must be readable by its owner only (chmod 600)`)
  return fs.readFileSync(file, 'utf8').trim()
}
const newDht = () => {
  const bootstrap = opt('bootstrap') ? opt('bootstrap').split(',') : null
  if (!bootstrap) return new HyperDHT()
  return new HyperDHT({ bootstrap, host: bootstrap.every((b) => b.startsWith('127.0.0.1:')) ? '127.0.0.1' : undefined })
}
const netKeyPair = (dir) => HyperDHT.keyPair(Buffer.from(fs.readFileSync(path.join(dir, 'network.key'), 'utf8').trim(), 'hex'))

async function chainOf (dir) {
  const d = fs.existsSync(path.join(dir, 'deployment.json')) ? read(dir, 'deployment.json') : null
  let rpc = opt('rpc', d?.rpc)
  let registry = opt('registry', d?.registry)
  let fromBlock = null
  if (flags.has('--testnet')) {
    const t = await (await fetch(opt('testnet-url', SITE + '/testnet.json'))).json()
    rpc = rpc || t.rpc
    registry = registry || t.registry
    fromBlock = t.block
  }
  if (!rpc || !registry) die('--testnet, or --rpc and --registry')
  return { rpc, registry, fromBlock, provider: await providerFor(rpc), deployment: d }
}

// the network's home node, where its oracles publish: a client there. The
// home is in the network key's record (xid-depin keeper keeps it up)
// (the network's public key: from network.key, or deployment.json for anyone else)
const netPublicKey = (dir) => fs.existsSync(path.join(dir, 'network.key')) ? netKeyPair(dir).publicKey : Buffer.from(read(dir, 'deployment.json').netKey, 'hex')

async function atHome (dir, dht) {
  const kp = { publicKey: netPublicKey(dir) }
  let home = opt('home') ? Buffer.from(opt('home').split(',')[0], 'hex') : null
  for (let i = 0; !home && i < 5; i++) {
    home = await homeOf(dht, kp.publicKey).catch(() => null)
    if (!home) await sleep(2000)
  }
  if (!home) die('the network has no home node: run xid-depin keeper, or give --home')
  return connect(home, { dht, keyPair: HyperDHT.keyPair() })
}

// what the oracles published about an epoch, at the network's home node.
// Give it a DHT to use one that is already up (the keeper's); a DHT it makes
// itself goes away with the call, also when the home cannot be reached: a
// keeper that left one behind every round ran out of sockets in a day
async function gather (dir, epoch, ms = 8000, shared = null) {
  const dht = shared || newDht()
  let c = null
  try {
    c = await atHome(dir, dht)
    const net = hex(netPublicKey(dir))
    const got = { rewards: [], indexes: [], sheets: new Map(), work: [] }
    c.on('message', (topic, payload) => {
      const p = topic.split('/')
      if (p[2] === 'work') { try { got.work.push(JSON.parse(payload.toString())) } catch {} return }
      if (p[5] === 'rewards') { try { got.rewards.push(JSON.parse(payload.toString())) } catch {} }
      else if (p[5] === 'index') { const x = openIndex(payload); if (x && x.work === p[1]) got.indexes.push(x) }
      else if (p[5] === 'sheet') got.sheets.set(p[1] + ':' + p[6], Buffer.from(payload))
    })
    await c.subscribeAsync(`d/+/depin/${net}/${epoch}/#`, { qos: 1 })
    await c.subscribeAsync(`d/+/work/${net}/+/${epoch}`, { qos: 1 })
    await sleep(ms)
    return got
  } finally {
    if (c) c.end(true)
    if (!shared) await dht.destroy().catch(() => {})
  }
}

// readings for a simulated device of the template: a slow day's cycle shared
// by devices around one place, with a little noise of its own
function readingOf (config, st, t) {
  const day = Math.sin((2 * Math.PI * ((t + st.lon * 240) % 86400)) / 86400)
  const noise = () => (Math.random() - 0.5) * 0.04
  if (config.score.mode === 'energy') {
    const sun = Math.max(0, day)
    const w = Math.round(st.rated * sun * (0.9 + Math.random() * 0.1))
    st.mwh = (st.mwh ?? Math.floor(Math.random() * 1e9)) + Math.round((w * st.every * 1000) / 3600)
    return { mwh: st.mwh, w }
  }
  const out = {}
  for (const [k, f] of Object.entries(config.readings.fields)) {
    const mid = (f.min + f.max) / 2
    const span = (f.max - f.min) / 8
    out[k] = Math.round(mid + span * (0.5 * day + noise()))
  }
  return out
}

// without a key, the testnet's site enrolls a device (POST /api/depin/enroll)
async function enrollViaSite (did) {
  const site = opt('enroll-via', SITE)
  const res = await fetch(site + '/api/depin/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: did }) })
  const body = await res.json()
  if (!res.ok || body.error) throw new Error(body.error || res.status)
  for (let i = 0; i < 40 && body.state !== 'done' && body.state !== 'failed'; i++) {
    await sleep(4000)
    Object.assign(body, await (await fetch(`${site}/api/request/${body.id}`)).json())
  }
  if (body.state !== 'done') throw new Error(body.result?.error || 'still ' + body.state)
}

// with a key, it pays the fee itself (in the registry's token)
async function enrollPaying (w, net, usd, network, did) {
  const fee = await net.enrollFee()
  if (fee > 0n) {
    if ((await usd.balanceOf(w.address)) < fee) await (await usd.mint(w.address, fee * 10n)).wait() // test tokens anyone mints
    if ((await usd.allowance(w.address, network)) < fee) await (await usd.approve(network, fee * 100n)).wait()
  }
  await (await net.enroll('0x' + did)).wait()
}

if (cmd === 'templates') {
  for (const t of templates()) {
    const c = loadTemplate(t)
    console.log(`${t.padEnd(12)} ${c.title}: ${c.about}`)
  }
} else if (cmd === 'new') {
  const [template, dir] = positional
  if (!template || !dir) die('usage: xid-depin new <template> <dir>')
  const config = loadTemplate(template)
  if (opt('name')) config.name = opt('name')
  if (opt('epoch')) config.epoch.length = Number(opt('epoch'))
  if (opt('slots')) config.epoch.slots = Number(opt('slots'))
  checkConfig(config)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (fs.existsSync(path.join(dir, 'config.json'))) die(`${dir}/config.json is there already`)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n')
  if (!fs.existsSync(path.join(dir, 'network.key'))) fs.writeFileSync(path.join(dir, 'network.key'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
  console.log(`network key ${hex(netKeyPair(dir).publicKey)}`)
  console.log(`config ${configHash(config)} in ${dir}/config.json: change what you need, then xid-depin deploy`)
} else if (cmd === 'deploy') {
  const dir = dirOf()
  const config = checkConfig(read(dir, 'config.json'))
  const { rpc, registry, provider } = await chainOf(dir)
  const admin = new Wallet(secret(opt('key')), provider)
  const reg = attach(registry, admin)
  const usd = new Contract(await reg.token(), TEST_TOKEN.abi, admin)
  const dec = 10n ** BigInt(await usd.decimals())
  const budget = BigInt(opt('budget', '100')) * dec
  if (flags.has('--mint')) await (await usd.mint(admin.address, budget)).wait() // a test token anyone mints
  const d = await deployNetwork(admin, {
    registry,
    config,
    netKey: hex(netKeyPair(dir).publicKey),
    start: opt('start') ? Number(opt('start')) : null,
    job: { quorum: Number(opt('quorum', 2)), pay: BigInt(opt('pay', '1')) * dec, budget, perEpoch: Number(opt('per-epoch', 10)) },
    log
  })
  const out = { chainId: Number((await provider.getNetwork()).chainId), rpc, registry, netKey: hex(netKeyPair(dir).publicKey), config: config.name, configHash: configHash(config), ...d }
  fs.writeFileSync(path.join(dir, 'deployment.json'), JSON.stringify(out, null, 2) + '\n')
  log(`deployed: ${dir}/deployment.json. Keep the network's home up: xid-depin keeper ${dir} --home <a forwarding node's key>`)
} else if (cmd === 'keeper') {
  const dir = dirOf()
  const dht = newDht()
  const kp = netKeyPair(dir)
  const home = opt('home') || die('--home <node key>: a forwarding node the oracles meet at')
  const put = async () => {
    await publishHome(dht, kp, Buffer.from(home, 'hex'))
    log(`network ${hex(kp.publicKey).slice(0, 12)}… at home node ${home.slice(0, 12)}…`)
  }
  await put()
  setInterval(() => put().catch((err) => log('home: ' + err.message)), 6 * 3600 * 1000)
  if (opt('key')) {
    const { provider, deployment } = await chainOf(dir)
    const w = new Wallet(secret(opt('key')), provider)
    const net = attachNetwork(deployment.network, w)
    const claimedUpTo = { e: -1 }
    const stateFile = path.join(dir, 'keeper.json')
    try { Object.assign(claimedUpTo, read(dir, 'keeper.json')) } catch {}
    const round = async () => {
      if ((await net.fees()) > 0n && (await net.hasJob())) {
        await (await net.sendFees()).wait()
        log('enrollment fees sent to the oracles\' job')
      }
      if (!flags.has('--claim')) return
      const now = Number(await net.epoch())
      for (let e = claimedUpTo.e + 1; e < now; e++) {
        const ep = await net.epochs(e)
        if (ep.publishedAt === 0n) {
          if (now - e > 3) { claimedUpTo.e = e; continue } // never published: past it
          break
        }
        const got = await gather(dir, e, 6000, dht)
        // a tree is anyone's word until its leaves give the published root
        const leavesOf = (r) => {
          try {
            const leaves = r.leaves.map((l) => ({ ...l, amount: BigInt(l.amount), leaf: null }))
            for (const l of leaves) l.leaf = leafOf(e, l.did, l.payee, l.amount)
            return leaves.length && merkleRoot(leaves.map((l) => l.leaf)) === ep.root ? leaves : null
          } catch { return null }
        }
        let leaves = null
        for (const r of got.rewards) if (r && r.root === ep.root && (leaves = leavesOf(r))) break
        if (!leaves) { log(`epoch ${e}: no rewards tree with the published root yet`); break }
        const items = leaves.map((l) => claimOf({ epoch: e, leaves }, l.did)).map((c) => ({ epoch: e, did: '0x' + c.did, payee: c.payee, amount: c.amount, proof: c.proof }))
        for (let i = 0; i < items.length; i += 20) {
          const part = items.slice(i, i + 20)
          await (await net.claimMany(part, { gasLimit: 80000n + 70000n * BigInt(part.length) })).wait()
        }
        log(`epoch ${e}: claimed for ${items.length} devices`)
        claimedUpTo.e = e
        fs.writeFileSync(stateFile, JSON.stringify(claimedUpTo))
      }
    }
    let busy = false // one round at a time: a slow one must not claim twice
    const loop = async () => {
      if (busy) return
      busy = true
      try { await round() } catch (err) { log('keeper: ' + (err.shortMessage || err.message)) } finally { busy = false }
    }
    await loop()
    setInterval(loop, Number(opt('every', 300)) * 1000)
  }
} else if (cmd === 'get') {
  const dir = dirOf()
  const t = await (await fetch(opt('testnet-url', SITE + '/testnet.json'))).json()
  const n = (t.depin || []).find((x) => !opt('name') || x.config.name === opt('name'))
  if (!n) die('the testnet names no DePIN network' + (opt('name') ? ' called ' + opt('name') : ''))
  const { config, ...deployment } = n
  if (configHash(config) !== deployment.configHash) die('the config does not match its hash')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'deployment.json'), JSON.stringify(deployment, null, 2) + '\n')
  console.log(`${config.title} (${config.name}): network ${deployment.network} in ${dir}`)
} else if (cmd === 'sim') {
  const dir = dirOf()
  const config = checkConfig(read(dir, 'config.json'))
  const { provider, deployment } = await chainOf(dir)
  if (!deployment) die('deploy the network first')
  const w = opt('key') ? new Wallet(secret(opt('key')), provider) : null
  const net = attachNetwork(deployment.network, w || provider)
  const reg = attach(deployment.registry, w || provider)
  const usd = new Contract(await reg.token(), TEST_TOKEN.abi, w || provider)
  const homes = (opt('home') || die('--home <node key>[,..]')).split(',')
  const stations = (opt('stations') || die('--stations "name@lat,lon;.."')).split(';').filter(Boolean).map((s) => {
    const [name, at] = s.split('@')
    const [lat, lon] = at.split(',').map(Number)
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) die('bad station: ' + s)
    return { name, lat, lon }
  })
  const every = Number(opt('every', 60))
  const simDir = path.join(dir, 'sim')
  fs.mkdirSync(simDir, { recursive: true, mode: 0o700 })
  const dht = newDht()
  const radio = new SimRadio()
  const netKey = deployment.netKey
  const devs = []
  for (const [i, st] of stations.entries()) {
    const kf = path.join(simDir, st.name + '.key')
    if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32).toString('hex'), { mode: 0o600 })
    const pf = path.join(simDir, st.name + '.payee')
    if (!fs.existsSync(pf)) fs.writeFileSync(pf, HDNodeWallet.createRandom().privateKey, { mode: 0o600 })
    const kp = HyperDHT.keyPair(Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'hex'))
    const payee = new Wallet(fs.readFileSync(pf, 'utf8').trim()).address
    const did = hex(kp.publicKey)
    if ((await net.enrolledAt('0x' + did)) === 0n && !w) {
      await enrollViaSite(did).then(() => log(`${st.name} enrolled by the testnet`), (err) => log(`${st.name} not enrolled: ${err.message}`))
    } else if ((await net.enrolledAt('0x' + did)) === 0n) {
      await enrollPaying(w, net, usd, deployment.network, did)
      log(`${st.name} enrolled`)
    }
    st.every = every
    st.rated = 5000
    const dev = new DepinDevice({ dht, keyPair: kp, home: homes[i % homes.length], net: netKey, config, payee, cell: cellAt(st.lat, st.lon, config.location.resolution), rated: config.score.mode === 'energy' ? st.rated : null })
    dev.on('error', (err) => log(`${st.name}: ${err.message}`))
    await dev.start()
    radio.add(dev, st.lat, st.lon)
    devs.push({ dev, st })
    log(`${st.name} ${did.slice(0, 12)}… at ${st.lat},${st.lon} (cell ${dev.cell}), home ${dev.home.slice(0, 12)}…, payee ${payee}`)
  }
  setTimeout(() => {
    setInterval(() => {
      const t = Math.floor(Date.now() / 1000)
      for (const { dev, st } of devs) dev.reading(readingOf(config, st, t), t).catch((err) => log(`${st.name}: ${err.message}`))
    }, every * 1000)
  }, Math.random() * every * 1000)
  if (config.coverage?.poc) {
    const slotLen = config.epoch.length / config.epoch.slots
    const tick = () => {
      const slot = Math.floor((Date.now() / 1000 - deployment.start) / slotLen)
      if (slot >= 0) radio.slot(slot).catch(() => {})
    }
    const wait = slotLen * 1000 - ((Date.now() - deployment.start * 1000) % (slotLen * 1000)) + 2000
    setTimeout(() => { tick(); setInterval(tick, slotLen * 1000) }, wait)
  }
  setInterval(() => log(`${devs.reduce((a, x) => a + x.dev.stats.readings, 0)} readings, ${devs.reduce((a, x) => a + x.dev.stats.pongs, 0)} pongs, ${devs.reduce((a, x) => a + x.dev.stats.witness, 0)} witness reports`), 600000)
  const stop = async () => { for (const { dev } of devs) await dev.close(); await dht.destroy(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
} else if (cmd === 'station') {
  // a hardware station (examples/depin_station): enrolled, and the line to
  // type on its console
  const dir = dirOf()
  const config = checkConfig(read(dir, 'config.json'))
  const { provider, deployment } = await chainOf(dir)
  if (!deployment) die('get or deploy the network first')
  const did = String(opt('device') || die('--device <the key it prints: DEPIN|device ...>')).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(did)) die('--device: 64 hex characters')
  const lat = Number(opt('lat'))
  const lon = Number(opt('lon'))
  if (!opt('lat') || !opt('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) die('--lat and --lon: where it is')
  let payee
  try { payee = getAddress(opt('payee') || '') } catch { die('--payee 0x...: who is paid for it') }
  const rated = config.score.mode === 'energy' ? Number(opt('rated') || die('--rated <W>: the rated power, for an energy network')) : 0
  const w = opt('key') ? new Wallet(secret(opt('key')), provider) : null
  const net = attachNetwork(deployment.network, w || provider)
  if ((await net.enrolledAt('0x' + did)) !== 0n) log('already enrolled')
  else if (w) {
    const usd = new Contract(await attach(deployment.registry, w).token(), TEST_TOKEN.abi, w)
    await enrollPaying(w, net, usd, deployment.network, did)
    log('enrolled')
  } else {
    await enrollViaSite(did)
    log('enrolled by the testnet')
  }
  const cell = cellAt(lat, lon, config.location.resolution)
  // the node it should be on: the oracle nearest to it. Every oracle's ping
  // goes through the node a device is on, so a device on a far node is far
  // from all of them (and its round trips rule nothing out); on an oracle's
  // own node, that oracle's round trip is the device's alone.
  let node = opt('node') ? String(opt('node')).toLowerCase() : null
  if (node && !/^[0-9a-f]{64}$/.test(node)) die('--node: a node key, 64 hex characters')
  if (!node) {
    const e = Number((await networkInfo(deployment.network, provider)).epoch)
    for (const x of e > 0 ? [e - 1, e - 2].filter((n) => n >= 0) : []) {
      const got = await gather(dir, x)
      const near = got.indexes.filter((i) => i.loc && Number.isFinite(i.loc.lat) && Number.isFinite(i.loc.lon))
        .map((i) => ({ operator: i.operator, km: distanceKm(lat, lon, i.loc.lat, i.loc.lon) }))
        .sort((a, b) => a.km - b.km)
      // the node devices connect to: the key the operator registered (the
      // node list's), not the oracle's work key in its index
      const reg = attach(deployment.registry, provider)
      for (const n of near) {
        const r = await reg.nodes(n.operator)
        if (!r.active) continue
        node = r.dhtKey.slice(2)
        log(`nearest oracle of epoch ${x}: node ${node.slice(0, 12)}…, ${Math.round(n.km)} km away (of ${near.map((m) => Math.round(m.km) + ' km').join(', ')})`)
        break
      }
      if (node) break
    }
    if (!node) log('no oracle\'s index found: the station takes any listed node (give --node to choose)')
  }
  console.log('Type this on the station\'s console:\n')
  console.log(`depin set ${deployment.netKey} ${cell} ${payee} ${deployment.start} ${config.epoch.length / config.epoch.slots} ${config.readings.topic}${rated ? ' ' + Math.floor(rated) : ''}${node ? ' ' + node : ''}`)
} else if (cmd === 'status') {
  const dir = dirOf()
  const config = checkConfig(read(dir, 'config.json'))
  const { provider, deployment } = await chainOf(dir)
  if (!deployment) die('deploy the network first')
  const info = await networkInfo(deployment.network, provider)
  const net = attachNetwork(deployment.network, provider)
  const curve = curveOf(config.curve)
  console.log(`${config.title} (${config.name}), network ${info.network}, key ${info.netKey.slice(0, 16)}…`)
  console.log(`epoch ${info.epoch} (${info.epochLength} s each), ${info.devices} devices enrolled, emission now ${emission(curve, info.epoch)}, ${info.emitted} emitted, ${info.owed} not claimed`)
  for (let e = Math.max(0, info.epoch - 5); e < info.epoch; e++) {
    const ep = await net.epochs(e)
    console.log(`  epoch ${e}: ${ep.publishedAt ? `${ep.devices} devices, ${ep.total} paid, root ${ep.root.slice(0, 12)}…` : 'not published'}`)
  }
} else if (cmd === 'rewards' || cmd === 'audit') {
  const dir = dirOf()
  const e = Number(positional[1])
  if (!Number.isInteger(e)) die(`usage: xid-depin ${cmd} <dir> <epoch>`)
  const config = checkConfig(read(dir, 'config.json'))
  const { provider, deployment } = await chainOf(dir)
  const net = attachNetwork(deployment.network, provider)
  const ep = await net.epochs(e)
  const got = await gather(dir, e)
  if (cmd === 'rewards') {
    const tree = got.rewards.find((r) => r.root === ep.root) || got.rewards[0]
    if (!tree) die(`no rewards tree for epoch ${e} at the network's home node`)
    console.log(`epoch ${e}: root ${tree.root}${ep.publishedAt ? ' (published)' : ' (not published)'}, ${tree.count} devices, ${tree.total} of ${tree.emission}`)
    for (const r of tree.rows) console.log(`  ${r.did.slice(0, 12)}… ${String(r.cell).padEnd(16)} ${r.location.padEnd(24)} up ${r.uptime / 100}% good ${r.quality / 100}% cov ${r.coverage / 100}% share ${r.share / 100}% -> ${r.amount}`)
  } else {
    const w = got.work.find((x) => x.detail?.root === ep.root)
    if (!ep.publishedAt || !w) die(`epoch ${e} is not published, or its oracles' work is not at the home node`)
    const oracles = new Set(w.detail.oracles.map((a) => getAddress(a)))
    const sheets = []
    for (const x of got.indexes) {
      if (!oracles.has(getAddress(x.operator))) continue
      const devices = {}
      for (const [did, h] of Object.entries(x.sheets)) {
        const p = got.sheets.get(x.work + ':' + did)
        if (!p) die(`sheet of ${x.operator} on ${did.slice(0, 12)}… missing`)
        devices[did] = JSON.parse(p.toString())
        if (keccak256(p) !== h) die(`sheet of ${x.operator} on ${did.slice(0, 12)}… does not match its index`)
      }
      sheets.push({ operator: getAddress(x.operator), loc: x.loc, devices })
    }
    const count = Number(await net.deviceCount())
    const dids = []
    const start = Number(await net.epochStart(e))
    for (let i = 0; i < count; i++) {
      const did = await net.devices(i)
      if (await net.inEpoch(did, e)) dids.push(did.slice(2))
    }
    const tree = scoreEpoch({ config, net: deployment.netKey, epoch: e, start, emission: await net.emission(e), devices: dids, sheets: sheets.sort((a, b) => (a.operator < b.operator ? -1 : 1)) })
    const ok = tree.root === ep.root && tree.total === ep.total
    console.log(`epoch ${e}: ${sheets.length} oracles' sheets, ${dids.length} devices; root ${tree.root} ${ok ? 'matches' : 'DOES NOT MATCH'} the published ${ep.root}`)
    process.exit(ok ? 0 : 1)
  }
} else {
  console.error('usage: xid-depin templates | new | deploy | keeper | sim | status | rewards | audit (see the top of bin/xid-depin.js)')
  process.exit(2)
}
