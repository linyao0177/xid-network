// Tests that need no network: node test/offline.js
//
// The DHT is a stand-in in this process (records in a map, connections as
// pairs of streams that keep message boundaries, the peer's key as given), so
// nodes, stores, readers and followers run as they are, without a socket.
// What it cannot do is Hypercore replication (mirrors: test/store.js).
//
// - billing: one authorization sent twice at once is taken once
// - receipts: only messages whose signature checks out count; a signed line
//   that is not a receipt does not open (and does not throw)
// - what is remembered per key or topic is bounded
// - stores: an append that fails can be sent again; a reader is held to what
//   the caller knows (length, sequence numbers, core); requests time out;
//   who may replicate; records are put again
// - Follower: follow, a device that moves, unfollow

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { Duplex } from 'stream'
import { createRequire } from 'module'
import HyperDHT from 'hyperdht'
import sodium from 'sodium-universal'
import { createNode, connect, publishHome, homeOf, own, sign, SignedInbox, Billing, Receipts, openReceipt, createStore, openLog, spotCheck, Follower } from '../index.js'

const { eth, makeRecord } = createRequire(import.meta.url)('boat-peer')

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (!(await fn()) && Date.now() < end) await sleep(20)
  return fn()
}
const thrown = (p) => p.then(() => null, (err) => err)

// ---- the stand-in DHT ------------------------------------------------------

function fakeNet () {
  const records = new Map() // key hex -> { value, seq }
  const servers = new Map() // key hex -> onconnection
  const net = { records, puts: [], conns: 0 }
  const end = (key) => {
    const d = new Duplex({
      read () {},
      write (chunk, enc, cb) {
        if (!d.other.destroyed) d.other.push(Buffer.from(chunk))
        cb()
      },
      final (cb) {
        if (!d.other.destroyed) d.other.push(null)
        cb()
      },
      destroy (err, cb) {
        setImmediate(() => d.other.destroy())
        cb(null)
      }
    })
    d.publicKey = key
    return d
  }
  net.createNode = () => {
    const dht = {
      defaultKeyPair: HyperDHT.keyPair(),
      createServer (onconnection) {
        let key = null
        return {
          async listen (keyPair) {
            key = keyPair.publicKey.toString('hex')
            servers.set(key, onconnection)
          },
          async close () { servers.delete(key) }
        }
      },
      connect (key, opts = {}) {
        const kp = opts.keyPair || dht.defaultKeyPair
        const a = end(kp.publicKey)
        const b = end(Buffer.from(key))
        a.other = b
        b.other = a
        a.remotePublicKey = b.publicKey
        b.remotePublicKey = a.publicKey
        net.conns++
        setImmediate(() => {
          const server = servers.get(Buffer.from(key).toString('hex'))
          if (!server) return a.destroy(new Error('PEER_NOT_FOUND'))
          server(b)
          a.emit('open')
        })
        return a
      },
      async mutablePut (keyPair, value, { seq = 0 } = {}) {
        const k = keyPair.publicKey.toString('hex')
        const old = records.get(k)
        if (old && seq < old.seq) throw new Error('SEQ_TOO_LOW')
        records.set(k, { value: Buffer.from(value), seq })
        net.puts.push({ key: k, seq })
        return { seq }
      },
      async mutableGet (key) {
        return records.get(Buffer.from(key).toString('hex')) || null
      },
      async destroy () {}
    }
    return dht
  }
  return net
}

const net = fakeNet()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-offline-'))

// ---- signed messages and receipts ------------------------------------------

{
  const kp = HyperDHT.keyPair()
  const dev = HyperDHT.keyPair()
  const t = own(dev.publicKey) + 'telemetry'
  const r = new Receipts(kp)
  const good = sign(dev.secretKey, t, 1, 'x')
  const forged = sign(dev.secretKey, t, 2, 'x')
  forged[forged.length - 1] ^= 1
  const looksSigned = Buffer.concat([Buffer.from([0x53, 1]), Buffer.alloc(80, 9)])
  const counted = [r.add(dev.publicKey, good, t), r.add(dev.publicKey, forged, t), r.add(dev.publicKey, looksSigned, t), r.add(dev.publicKey, sign(dev.secretKey, t, 3, 'x'), own(dev.publicKey) + 'other')]
  const o = openReceipt(r.receipt(dev.publicKey), kp.publicKey)
  check('a receipt counts only messages whose signature checks out on their topic', counted.join() === 'true,false,false,false' && o.count === 1 && o.ranges.join() === '1,1', counted.join())

  // lines its signer signed, but that are not receipts
  const signedLine = (fields) => {
    const body = ['boat-receipt/1', kp.publicKey.toString('hex'), dev.publicKey.toString('hex'), ...fields].join('|')
    const sig = Buffer.alloc(64)
    sodium.crypto_sign_detached(sig, Buffer.from(body), kp.secretKey)
    return body + '|' + sig.toString('hex')
  }
  const odd = [[1, 10, 'a-b', 5], [1, 10, '1-', 5], [1, 10, '7', 5], [1, 10, '5-2', 5], [1, 10, '1-2;;3-4', 5], ['x', 10, '1-2', 5], [1, 10, '1-2', '1e3'], [1, 10, '0x1-0x2', 5]]
  let threw = 0
  const opened = odd.map((f) => { try { return openReceipt(signedLine(f)) } catch { threw++; return 'threw' } })
  const fine = openReceipt(signedLine([2, 10, '1-2', 5]))
  check('a signed line that is not a receipt does not open, and does not throw', threw === 0 && opened.every((x) => x === null) && fine && fine.count === 2 && fine.ranges[0][1] === 2n, `${threw} threw`)

  const small = new Receipts(kp, { max: 3 })
  const keys = Array.from({ length: 5 }, () => HyperDHT.keyPair())
  for (const k of keys) small.add(k.publicKey, sign(k.secretKey, own(k.publicKey) + 't', 1, 'x'))
  small.add(keys[2].publicKey, sign(keys[2].secretKey, own(keys[2].publicKey) + 't', 2, 'x')) // busy again
  small.add(HyperDHT.keyPair().publicKey, sign(dev.secretKey, t, 1, 'x'))
  check('receipts remember a bounded number of devices, the busiest longest', small.devices.size === 3 && small.devices.has(keys[2].publicKey.toString('hex')) && !small.devices.has(keys[3].publicKey.toString('hex')))

  const inbox = new SignedInbox({ maxTopics: 4, maxSenders: 2 })
  let seq = 0
  const say = (k, topic) => inbox.check(own(k.publicKey) + topic, sign(k.secretKey, own(k.publicKey) + topic, ++seq, 'x'))
  const first = sign(dev.secretKey, own(dev.publicKey) + 't0', 1, 'x')
  seq = 1
  const a = inbox.check(own(dev.publicKey) + 't0', first)
  for (let i = 1; i <= 6; i++) say(dev, 't' + i) // t0, t1 and t2 are forgotten
  const again = inbox.check(own(dev.publicKey) + 't0', first)
  const newer = say(dev, 't0')
  check('SignedInbox keeps a bounded number of topics per key, and still refuses a replay on a forgotten one', a.ok && inbox.senders.get(dev.publicKey.toString('hex')).last.size === 4 && !again.ok && again.reason === 'replayed' && newer.ok)
  for (let i = 0; i < 3; i++) say(HyperDHT.keyPair(), 't')
  check('and a bounded number of keys', inbox.senders.size === 2)
}

// ---- billing ---------------------------------------------------------------

{
  const PAYEE = '0x1e6a1664aa7c2b2dbbd2e8e4b8e0f1a7c5d7e9f1'
  const TOKEN = '0x78Cf24370174180738C5B8E352B6D14c83a6c9A9'
  const domain = { name: 'USD₮0', version: '1', chainId: 2201, verifyingContract: TOKEN }
  const dht = net.createNode()
  const P = await createNode({ dht, network: null, billing: { price: { message: 100, kb: 0 }, credit: 100000, payee: PAYEE, token: TOKEN, chainId: 2201, domain: { name: 'USD₮0', version: '1' }, invoiceMs: 100000, recordMs: 40, maxAccounts: 3 } })
  const pk = P.publicKey.toString('hex')
  const devKp = HyperDHT.keyPair()
  const devKey = devKp.publicKey.toString('hex')
  const wallet = crypto.randomBytes(32)
  const authorize = (value, { nonce = '0x' + crypto.randomBytes(32).toString('hex'), validBefore = Math.floor(Date.now() / 1000) + 3600 } = {}) => {
    const a = { from: eth.addressOf(wallet), to: PAYEE, value: String(value), validAfter: 0, validBefore, nonce }
    return { ...a, signature: eth.signTransfer(domain, a, wallet) }
  }
  for (let i = 0; i < 10; i++) P.billing.meter(devKey, own(devKey) + 't', 10) // owes 1000

  // no DID record yet: refused, and the nonce is not used up by that
  const early = authorize(400)
  const r0 = await P.billing.pay(devKey, JSON.stringify(early))
  await dht.mutablePut(devKp, Buffer.from(JSON.stringify({ ...makeRecord(devKp.publicKey, wallet), mqtt: pk })), { seq: 1 })
  const r1 = await P.billing.pay(devKey, JSON.stringify(early))
  check('a refused payment does not use up its nonce', !r0.ok && r1.ok && P.billing.due(devKey) === 600n, r0.reason)

  // the same authorization twice at once (the wallet lookup is awaited in between)
  P.billing._wallets.clear()
  const twice = JSON.stringify(authorize(300))
  const both = await Promise.all([P.billing.pay(devKey, twice), P.billing.pay(devKey, twice)])
  const later = await P.billing.pay(devKey, twice)
  check('one authorization sent twice at once is taken once', both.filter((r) => r.ok).length === 1 && both.find((r) => !r.ok).reason === 'nonce reused' && !later.ok && P.billing.due(devKey) === 300n, both.map((r) => r.ok).join())

  const short = authorize(100, { validBefore: Math.floor(Date.now() / 1000) + 200 })
  await P.billing.pay(devKey, JSON.stringify(short))
  const held = P.billing._nonces.size
  P.billing._pruneNonces(Date.now() + 300000)
  check('nonces are forgotten once their authorization has run out', held === 3 && P.billing._nonces.size === 2)

  for (let i = 0; i < 5; i++) P.billing.meter(crypto.randomBytes(32).toString('hex'), 'd/x/t', 1)
  P.billing.meter(devKey, own(devKey) + 't', 10)
  check('accounts are bounded', P.billing.accounts.size === 3 && P.billing.accounts.has(devKey))

  const before = net.puts.filter((p) => p.key === pk).length
  await sleep(150)
  const after = net.puts.filter((p) => p.key === pk).length
  await P.close()
  await sleep(100)
  check('the terms are put again while the node runs, and no more once it is closed', before >= 1 && after > before && net.puts.filter((p) => p.key === pk).length === after, `${before} -> ${after}`)
}

// ---- a home record that is put again ---------------------------------------

{
  const dht = net.createNode()
  const kp = HyperDHT.keyPair()
  const k = kp.publicKey.toString('hex')
  const home = HyperDHT.keyPair().publicKey
  const once = await publishHome(dht, kp, home)
  const kept = await publishHome(dht, kp, home, { refreshMs: 30 })
  await sleep(120)
  const n = net.puts.filter((p) => p.key === k).length
  kept.stop()
  await sleep(80)
  check('publishHome puts the record again with refreshMs, until stop()', once.stop === undefined && n >= 4 && net.puts.filter((p) => p.key === k).length === n && kept.seq > once.seq && (await homeOf(dht, kp.publicKey)).equals(home), `${n} puts`)
}

// ---- a node, a device, a store ---------------------------------------------

const A = await createNode({ dht: net.createNode(), network: null })
const devDht = net.createNode()
const dev = await connect(A.publicKey, { dht: devDht })
const key = dev.publicKey.toString('hex')
await publishHome(devDht, dev.keyPair, A.publicKey)
const topic = own(key) + 'telemetry'
const say = (seq, text, t = topic) => dev.publishAsync(t, sign(dev.keyPair.secretKey, t, seq, text), { qos: 1 })

{
  // bytes that look signed, sent by the key itself: no receipt for them
  await say(1, 'reading 1')
  await dev.publishAsync(topic, Buffer.concat([Buffer.from([0x53, 1]), Buffer.alloc(80, 9)]), { qos: 1 })
  const d = A.receipts.devices.get(key)
  check('a node\'s receipt does not count a message with a bad signature', d && d.count === 1 && A.usage()[key].messages === 2)
}

const storeDht = net.createNode()
const storeKp = storeDht.defaultKeyPair
const S = await createStore({ dht: storeDht, keyPair: storeKp, storage: path.join(tmp, 'store'), devices: [key], receiptMs: 100000, recordMs: 40 })
const reader = net.createNode()

{
  // (an honest store has no signed head for an empty core; a head of length 0
  // signed by a key of the store's own choosing is caught by minLength: 1)
  const empty = await thrown(spotCheck(reader, S.publicKey, key))
  check('a spot check of a log with nothing in it does not pass', empty && /^store: /.test(empty.message), empty && empty.message)
}

{
  // an append that fails: the message can be sent again
  const d = await S._device(key)
  const append = d.core.append.bind(d.core)
  let fail = 1
  d.core.append = async (...args) => {
    if (fail-- > 0) throw new Error('disk full')
    return append(...args)
  }
  const errors = []
  S.on('error', (err) => errors.push(err.message))
  await say(2, 'reading 2')
  await until(() => errors.length === 1)
  await say(2, 'reading 2')
  await until(() => S.stats.stored === 1)
  check('a message whose append failed is stored when it comes again', errors.join() === 'disk full' && S.stats.stored === 1 && S.stats.replayed === 0 && d.core.length === 1)

  // the same message twice in one turn: once in the core
  const m = sign(dev.keyPair.secretKey, topic, 3, 'reading 3')
  await Promise.all([S._ingest(topic, m), S._ingest(topic, m)])
  check('of two copies that arrive together one is stored', d.core.length === 2 && S.stats.stored === 2 && S.stats.replayed === 1)
  d.core.append = append
  for (let n = 4; n <= 12; n++) await say(n, `reading ${n}`)
  await until(() => S.stats.stored === 11)
}

{
  const log = await openLog(reader, S.publicKey, key)
  const all = []
  for (let i = 0; i < log.length; i++) all.push(await log.block(i))
  log.close()
  check('a reader gets every entry, checked against the head and the device\'s signature', all.length === 11 && all.every((r, i) => r.ok && r.seq === BigInt(i + 2)) && /^[0-9a-f]{64}$/.test(log.signer))

  const spot = await spotCheck(reader, S.publicKey, key, { samples: 6, minLength: 11, seqs: [2n, 7, '12'], core: log.core, signer: log.signer })
  check('a spot check held to what the caller knows passes on an honest store', spot.ok && spot.checked === 9 && spot.found.length === 3 && spot.found.every((b) => b && b.ok) && String(spot.found[1].payload) === 'reading 7')
  const more = await spotCheck(reader, S.publicKey, key, { minLength: 50 })
  const never = await spotCheck(reader, S.publicKey, key, { seqs: [5, 99] })
  check('it fails when the log is shorter than the caller knows, or lacks a message known to be stored', !more.ok && more.checked === 0 && !never.ok && never.failed.length === 1 && never.failed[0].seq === 99n && never.failed[0].reason === 'not held')
  const other = await thrown(spotCheck(reader, S.publicKey, key, { core: 'ab'.repeat(32) }))
  const short = await thrown(openLog(reader, S.publicKey, key, { minLength: 12 }))
  check('another core than the one seen before, or a shorter log, is refused when opening', other && /^head: another core/.test(other.message) && short && /^head: 11 entries/.test(short.message), other && other.message)
}

{
  // a store that serves a log of its own making for the device: its own core
  // and signer, entries not signed by the device
  const liar = net.createNode()
  const fake = S.corestore.get({ name: 'made-up' })
  await fake.ready()
  const stranger = HyperDHT.keyPair()
  await fake.append(Buffer.concat([Buffer.from([0, topic.length]), Buffer.from(topic), sign(stranger.secretKey, topic, 1, 'made up')]))
  const { signedHead, blockProof, wire } = createRequire(import.meta.url)('boat-ota')
  const server = liar.createServer((conn) => {
    conn.on('data', async (data) => {
      const req = JSON.parse(data.toString())
      if (req.op === 'index') conn.write(Buffer.from(JSON.stringify({ core: fake.key.toString('hex'), signer: fake.manifest.signers[0].publicKey.toString('hex'), length: fake.length })))
      else if (req.op === 'head') conn.write(wire.encodeHead({ ...signedHead(fake), latest: -1 }))
      else if (req.op === 'block') conn.write(wire.encodeBlock(await blockProof(fake, req.index, req.length)))
    })
  })
  await server.listen(liar.defaultKeyPair)
  const r = await spotCheck(reader, liar.defaultKeyPair.publicKey, key)
  check('a log of the store\'s own making does not pass: its entries are not the device\'s', !r.ok && r.failed.length === 1 && r.failed[0].reason === 'not signed by the device', r.failed[0] && r.failed[0].reason)
  await server.close()
  await fake.close()
}

{
  // a store that takes requests and never answers
  const mute = net.createNode()
  let got = 0
  const server = mute.createServer((conn) => conn.on('data', () => got++))
  await server.listen(mute.defaultKeyPair)
  const t0 = Date.now()
  const err = await thrown(openLog(reader, mute.defaultKeyPair.publicKey, key, { timeout: 150 }))
  const ms = Date.now() - t0
  const gone = await thrown(openLog(reader, HyperDHT.keyPair().publicKey, key, { timeout: 150 }))
  check('a request to a store that does not answer times out', err && /timed out/.test(err.message) && got === 1 && ms >= 140 && ms < 2000 && gone !== null, `${ms} ms: ${err && err.message}`)

  // answers the index and the head, then stalls on blocks: the log closes
  const slow = net.createNode()
  const d = await S._device(key)
  const { signedHead, wire } = createRequire(import.meta.url)('boat-ota')
  const server2 = slow.createServer((conn) => conn.on('data', (data) => {
    const req = JSON.parse(data.toString())
    if (req.op === 'index') conn.write(Buffer.from(JSON.stringify({ core: d.core.key.toString('hex'), signer: d.core.manifest.signers[0].publicKey.toString('hex'), length: d.core.length })))
    else if (req.op === 'head') conn.write(wire.encodeHead({ ...signedHead(d.core), latest: -1 }))
  }))
  await server2.listen(slow.defaultKeyPair)
  const log = await openLog(reader, slow.defaultKeyPair.publicKey, key, { timeout: 150 })
  const two = await Promise.all([thrown(log.block(0)), thrown(log.block(1))])
  const next = await thrown(log.block(2))
  check('every request waiting on it fails, and none is left behind', two.every((e) => e && /timed out/.test(e.message)) && next && /timed out/.test(next.message))
  await server.close()
  await server2.close()
}

{
  // who may replicate
  const replicated = []
  S.corestore.replicate = (conn) => replicated.push(conn.remotePublicKey.toString('hex'))
  const dial = async (store, kp) => {
    const c = net.createNode().connect(store.replicateKeyPair.publicKey, kp ? { keyPair: kp } : undefined)
    c.on('error', () => {})
    let closed = false
    c.on('close', () => { closed = true })
    await sleep(60)
    c.destroy()
    return !closed
  }
  const open1 = await dial(S)
  const friend = HyperDHT.keyPair()
  const sells = await createStore({ dht: net.createNode(), storage: path.join(tmp, 'sells'), authorize: async () => null, recordMs: 0 })
  sells.corestore.replicate = (conn) => replicated.push(conn.remotePublicKey.toString('hex'))
  const closed1 = await dial(sells, friend)
  const named = await createStore({ dht: net.createNode(), storage: path.join(tmp, 'named'), authorize: async () => null, replicate: [friend.publicKey], recordMs: 0 })
  named.corestore.replicate = (conn) => replicated.push(conn.remotePublicKey.toString('hex'))
  const open2 = await dial(named, friend)
  const closed2 = await dial(named)
  check('a store lets everyone replicate, one that sells reads only the mirrors it names', open1 && !closed1 && open2 && !closed2 && replicated.length === 2 && replicated[1] === friend.publicKey.toString('hex'), [open1, closed1, open2, closed2].join())
  await sells.close()
  await named.close()
}

{
  // ever new topics: `last` stays bounded and a replay on a forgotten topic is refused
  const d = await S._device(key)
  const stored = S.stats.stored
  for (let i = 0; i < 4100; i++) {
    const t = own(key) + 'unit/' + i
    await S._ingest(t, sign(dev.keyPair.secretKey, t, 100 + i, 'x'))
  }
  const replayed = S.stats.replayed
  const t0 = own(key) + 'unit/0'
  await S._ingest(t0, sign(dev.keyPair.secretKey, t0, 100, 'x'))
  check('a store keeps a bounded number of topics per device, and still refuses a replay on a forgotten one', d.last.size === 4096 && S.stats.stored === stored + 4100 && S.stats.replayed === replayed + 1 && d.floor >= 100n, `${d.last.size} topics, floor ${d.floor}`)
}

{
  const pk = storeKp.publicKey.toString('hex')
  const before = net.puts.filter((p) => p.key === pk).length
  await sleep(150)
  const after = net.puts.filter((p) => p.key === pk).length
  await S.close()
  await sleep(100)
  check('the store\'s record is put again while it runs, and no more once it is closed', after > before && net.puts.filter((p) => p.key === pk).length === after, `${before} -> ${after}`)
}

// ---- Follower --------------------------------------------------------------

{
  const B = await createNode({ dht: net.createNode(), network: null })
  const subs = (node, id) => Object.keys(node.broker.clients[id] ? node.broker.clients[id].subscriptions : {}).sort()
  // a second device, at home on A too
  const dev2Dht = net.createNode()
  const dev2 = await connect(A.publicKey, { dht: dev2Dht })
  const key2 = dev2.publicKey.toString('hex')
  await publishHome(dev2Dht, dev2.keyPair, A.publicKey)

  const fKp = HyperDHT.keyPair()
  const id = fKp.publicKey.toString('hex') + '-test'
  const F = new Follower({ dht: net.createNode(), keyPair: fKp, role: 'test', refreshMs: 0 })
  const got = []
  F.on('message', (device, t, payload, via) => got.push({ device, t, text: String(payload), via }))
  const a = A.publicKey.toString('hex')
  const h = await F.follow(key)
  await F.follow(key2, 'telemetry')
  await F.watchDevice(key, `d/+/work/${key}/#`)
  await say(20, 'to the follower')
  await dev2.publishAsync(own(key2) + 'telemetry', 'from the second', { qos: 1 })
  await until(() => got.length === 2)
  check('a Follower follows devices to their home node and hands on what they publish', h === a && got.length === 2 && got[0].device === key && got[0].via === a && got[1].device === key2 && F.clients.size === 1 && subs(A, id).length === 3, subs(A, id).length + ' subscriptions')

  // one device is unfollowed: the other is still followed there
  const was = await F.unfollow(key)
  await say(21, 'not followed')
  await dev2.publishAsync(own(key2) + 'telemetry', 'still followed', { qos: 1 })
  await until(() => got.length === 3)
  await sleep(100)
  check('unfollow gives up a device\'s subscriptions and state, and keeps the others', was === true && (await F.unfollow(key)) === false && got.length === 3 && got[2].text === 'still followed' && !F.devices.has(key) && !F.homes.has(key) && !F.filters.has(key) && !F.extra.has(key) && F.clients.size === 1 && subs(A, id).join() === `d/${key2}/telemetry`, subs(A, id).join())

  // the device moves to B: followed there, and no longer at A
  await F.follow(key)
  dev.end(true)
  const moved = await connect(B.publicKey, { dht: devDht, keyPair: dev.keyPair })
  await publishHome(devDht, dev.keyPair, B.publicKey, { seq: Math.floor(Date.now() / 1000) + 10 })
  const movedTo = []
  F.on('moved', (k, home) => movedTo.push(k + home))
  await F._refresh()
  await moved.publishAsync(topic, sign(dev.keyPair.secretKey, topic, 30, 'from B'), { qos: 1 })
  await until(() => got.length === 4)
  const b = B.publicKey.toString('hex')
  check('a device that moved is followed at its new home, and given up at the old one', movedTo.join() === key + b && got.length === 4 && got[3].via === b && F.homes.get(key) === b && subs(B, id).join() === `d/${key}/#` && subs(A, id).join() === `d/${key2}/telemetry`, subs(A, id).join())

  // the last device at a home node is unfollowed: the connection goes
  await F.unfollow(key2)
  await until(() => !A.broker.clients[id])
  check('the connection to a home node with no followed device left is closed', F.clients.size === 1 && !F.clients.has(a) && !A.broker.clients[id] && !!B.broker.clients[id])
  await F.unfollow(key)
  check('with nothing followed, nothing is kept', F.clients.size + F.devices.size + F.homes.size + F.filters.size + F.extra.size === 0)

  await F.close()
  for (const c of [moved, dev2]) c.end(true)
  await B.close()
}

await A.close()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
