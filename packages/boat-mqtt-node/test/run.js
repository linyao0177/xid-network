// Tests for boat-mqtt-node: node test/run.js
//
// Two nodes on a local HyperDHT testnet. A device-like client finds them by
// network name and publishes under its key; an app reads it over TCP and
// over HyperDHT, and sends the device a command; a second node bridges the
// telemetry. Then the refusals: a key that publishes under another key, a
// session takeover, a bad TCP login, a TCP app that writes under d/.

import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import HyperDHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import mqtt from 'mqtt'
import crypto from 'crypto'
import { createRequire } from 'module'
import { createNode, connect, connectHome, findNodes, own, to, inboxOf, senderOf, sign, open, SignedInbox, homeOf, publishHome } from '../index.js'

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
  while (!fn() && Date.now() < end) await sleep(20)
  return fn()
}
async function refused (promise) {
  try {
    const c = await promise
    c.end(true)
    return null
  } catch (err) {
    return err
  }
}
// resolves when the client is closed by the node, or false after ms
const closedWithin = (c, ms) => new Promise((resolve) => {
  if (!c.connected) return resolve(true)
  const t = setTimeout(() => resolve(false), ms)
  c.once('close', () => { clearTimeout(t); resolve(true) })
})
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

// signed messages, in JS and in the device's C (components/hdht_mqtt/signed.c)
{
  const seed = Buffer.alloc(32, 7)
  const kp = HyperDHT.keyPair(seed)
  const key = kp.publicKey.toString('hex')
  const topic = own(key) + 'telemetry'
  const msg = sign(kp.secretKey, topic, 42n, '{"kwh":1.5}')
  const opened = open(kp.publicKey, topic, msg)
  check('a signed message opens with its key and topic', opened && opened.seq === 42n && String(opened.payload) === '{"kwh":1.5}')
  const tampered = Buffer.from(msg)
  tampered[tampered.length - 1] ^= 1
  check('a changed payload, topic or key does not open', !open(kp.publicKey, topic, tampered) && !open(kp.publicKey, own(key) + 'other', msg) && !open(HyperDHT.keyPair().publicKey, topic, msg))
  const inbox = new SignedInbox()
  const a = inbox.check(topic, sign(kp.secretKey, topic, 1, 'a'))
  const b = inbox.check(topic, sign(kp.secretKey, topic, 2, 'b'))
  const again = inbox.check(topic, sign(kp.secretKey, topic, 2, 'b'))
  check('SignedInbox refuses a sequence number seen before', a.ok && b.ok && !again.ok && again.reason === 'replayed')

  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'components', 'hdht_mqtt')
  const sodium = ['/opt/homebrew', '/usr/local', '/usr'].find((p) => fs.existsSync(path.join(p, 'include', 'sodium.h')))
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hdht-mqtt-')), 'test_signed')
  let built = false
  if (sodium) {
    try {
      execFileSync('clang', ['-O1', '-Wall', '-I' + path.join(dir, 'include'), '-I' + path.join(sodium, 'include'), path.join(dir, 'signed.c'), path.join(dir, 'test', 'test_signed.c'), '-L' + path.join(sodium, 'lib'), '-lsodium', '-o', bin])
      built = true
    } catch {}
  }
  if (built) {
    const c = (...args) => execFileSync(bin, args).toString().trim()
    const fromC = Buffer.from(c('sign', seed.toString('hex'), topic, '18446744073709551615', 'from C'), 'hex')
    const o = open(kp.publicKey, topic, fromC)
    check('C signs, JS opens (seq up to 2^64-1)', o && o.seq === 18446744073709551615n && String(o.payload) === 'from C')
    check('JS signs, C opens; C refuses a changed one', c('open', key, topic, msg.toString('hex')) === '42 {"kwh":1.5}' && c('open', key, topic, tampered.toString('hex')) === 'BAD')
  } else {
    console.log('SKIP the C side of signed messages: no clang or libsodium')
  }
}

const network = 'boat-mqtt-test-' + process.pid
const testnet = await createTestnet(3)
const dhtA = testnet.createNode()
const dhtB = testnet.createNode()
const dhtDev = testnet.createNode()
const dhtApp = testnet.createNode()
const dhtEvil = testnet.createNode()
const tcpPort = await freePort()

const refusals = []
const A = await createNode({ dht: dhtA, network, tcp: { port: tcpPort }, users: { ops: 'secret' } })
const B = await createNode({ dht: dhtB, network })
for (const n of [A, B]) n.on('refused', (r) => refusals.push(r))

const found = await findNodes(dhtDev, network)
check('both nodes are found by network name', found.length === 2 && [A, B].every((n) => found.some((k) => k.equals(n.publicKey))))

// the device: looks the network up and logs in with its key
const dev = await connect(A.publicKey, { dht: dhtDev })
const devKey = dev.publicKey.toString('hex')
check('a device connects by key, client id = its key', dev.connected && dev.options.clientId === devKey)
const anyDev = await connect(null, { dht: testnet.createNode(), network })
check('a client connects by network name alone', anyDev.connected && [A, B].some((n) => n.publicKey.equals(anyDev.node)))
anyDev.end(true)

// an operator app over TCP, and an app over HyperDHT with its own key
const ops = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, { username: 'ops', password: 'secret', clientId: 'ops-1' })
const app = await connect(A.publicKey, { dht: dhtApp })
const got = { ops: [], app: [], b: [], dev: [] }
await ops.subscribeAsync('d/+/telemetry', { qos: 1 })
await app.subscribeAsync('d/+/telemetry', { qos: 1 })
ops.on('message', (t, p) => got.ops.push([t, String(p)]))
app.on('message', (t, p) => got.app.push([t, String(p)]))

// B bridges A's telemetry; a subscriber on B
const bridge = await B.bridge(A.publicKey, ['d/+/telemetry'])
const subB = await connect(B.publicKey, { dht: testnet.createNode() })
await subB.subscribeAsync('d/+/telemetry', { qos: 1 })
subB.on('message', (t, p) => got.b.push([t, String(p)]))

const N = 10
for (let i = 0; i < N; i++) await dev.publishAsync(own(devKey) + 'telemetry', JSON.stringify({ seq: i }), { qos: 1 })
await until(() => got.ops.length >= N && got.app.length >= N && got.b.length >= N)
const inOrder = (a) => a.length === N && a.every(([t, p], i) => t === own(devKey) + 'telemetry' && JSON.parse(p).seq === i)
check('the TCP app gets the device telemetry', inOrder(got.ops), `${got.ops.length}/${N}`)
check('the HyperDHT app gets it', inOrder(got.app), `${got.app.length}/${N}`)
check('a subscriber on node B gets it through the bridge', inOrder(got.b), `${got.b.length}/${N}`)
check('senderOf names the publishing key', senderOf(got.app[0][0]) === devKey)

// commands: the app writes into the device's inbox, under its own key
await dev.subscribeAsync(inboxOf(devKey), { qos: 1 })
dev.on('message', (t, p) => got.dev.push([t, String(p)]))
await app.publishAsync(to(app.publicKey, devKey, 'cmd'), 'relay=on', { qos: 1 })
await until(() => got.dev.length >= 1)
check('the device gets a command in its inbox, with the sender in the topic', got.dev.length === 1 && senderOf(got.dev[0][0]) === app.publicKey.toString('hex') && got.dev[0][1] === 'relay=on')

// nodes that bridge each other do not loop
const back = await A.bridge(B.publicKey, ['d/+/telemetry'])
const dev2 = await connect(B.publicKey, { dht: testnet.createNode() })
const before = got.app.length
const bBefore = got.b.length
await dev2.publishAsync(own(dev2.publicKey) + 'telemetry', 'from-b', { qos: 1 })
await until(() => got.app.length > before)
await sleep(1500)
check('A and B bridging each other: one copy each, no loop', got.app.length === before + 1 && got.b.length === bBefore + 1, `A +${got.app.length - before}, B +${got.b.length - bBefore}`)

// following: a node with no bridges gets a subscription to a device by key,
// finds its home node in the device's record and bridges from there
const C = await createNode({ dht: testnet.createNode(), network: null })
const followed = []
C.on('follow', (f) => followed.push(f))
const homeDht = testnet.createNode()
const homeDev = await connect(A.publicKey, { dht: homeDht })
const hk = homeDev.publicKey.toString('hex')
await publishHome(homeDht, homeDev.keyPair, A.publicKey)
check('homeOf reads the home node from the device record', (await homeOf(dhtApp, hk))?.equals(A.publicKey))
const onC = await connect(C.publicKey, { dht: testnet.createNode() })
const viaC = []
const signedInbox = new SignedInbox()
onC.on('message', (t, p) => viaC.push(signedInbox.check(t, p)))
await onC.subscribeAsync(own(hk) + 'telemetry', { qos: 1 })
await until(() => followed.length > 0)
check('node C follows the device to its home node', followed[0]?.key === hk && followed[0]?.home === A.publicKey.toString('hex'), JSON.stringify(C.following()).slice(0, 40))
for (let i = 1; i <= 5; i++) await homeDev.publishAsync(own(hk) + 'telemetry', sign(homeDev.keyPair.secretKey, own(hk) + 'telemetry', i, `r${i}`), { qos: 1 })
await until(() => viaC.length >= 5)
check('signed telemetry arrives on C and checks out', viaC.length === 5 && viaC.every((r, i) => r.ok && r.seq === BigInt(i + 1) && String(r.payload) === `r${i + 1}`))
// a node in the path that changes a message, or plays one again
C.broker.publish({ cmd: 'publish', topic: own(hk) + 'telemetry', payload: sign(homeDev.keyPair.secretKey, own(hk) + 'telemetry', 3, 'r3'), qos: 0, retain: false }, () => {})
const forgedPayload = sign(homeDev.keyPair.secretKey, own(hk) + 'telemetry', 9, 'r9')
forgedPayload[forgedPayload.length - 1] ^= 1
C.broker.publish({ cmd: 'publish', topic: own(hk) + 'telemetry', payload: forgedPayload, qos: 0, retain: false }, () => {})
await until(() => viaC.length >= 7)
check('a replayed or changed message from a node is caught', viaC[5]?.reason === 'replayed' && viaC[6]?.reason === 'bad signature')
// a command goes straight to the device's home node
const homeIn = []
await homeDev.subscribeAsync(inboxOf(hk), { qos: 1 })
homeDev.on('message', (t, p) => homeIn.push(t))
const sender = await connectHome(hk, { dht: testnet.createNode() })
await sender.publishAsync(to(sender.publicKey, hk), 'go', { qos: 1 })
await until(() => homeIn.length > 0)
check('connectHome reaches the device at its home node', sender.node.equals(A.publicKey) && homeIn.length === 1)
for (const c of [onC, sender, homeDev]) c.end(true)
await C.close()

// billing: a node that charges per message, and a device that pays its invoices
{
  const PAYEE = '0x1e6a1664aa7c2b2dbbd2e8e4b8e0f1a7c5d7e9f1'
  const TOKEN = '0x78Cf24370174180738C5B8E352B6D14c83a6c9A9'
  const domain = { name: 'USD₮0', version: '1', chainId: 2201, verifyingContract: TOKEN }
  const P = await createNode({ dht: testnet.createNode(), network: null, billing: { price: { message: 100, kb: 1000 }, credit: 3000, payee: PAYEE, token: TOKEN, chainId: 2201, domain: { name: 'USD₮0', version: '1' }, invoiceMs: 400 } })
  P.on('refused', (r) => refusals.push(r))
  const pk = P.publicKey.toString('hex')
  const terms = await dhtApp.mutableGet(P.publicKey, { latest: true })
  const t = JSON.parse(terms.value)
  check('the node puts its terms in its record', t.pay === PAYEE && t.price_msg === '100' && t.price_kb === '1000' && t.credit === '3000' && t.domain_name === 'USD₮0')

  const devDht = testnet.createNode()
  const devKp = HyperDHT.keyPair()
  const devKey = devKp.publicKey.toString('hex')
  const wallet = crypto.randomBytes(32)
  const record = { ...makeRecord(devKp.publicKey, wallet), mqtt: pk }
  await devDht.mutablePut(devKp, Buffer.from(JSON.stringify(record)), { seq: 1 })
  const d = await connect(P.publicKey, { dht: devDht, keyPair: devKp })
  const invoices = []
  await d.subscribeAsync(inboxOf(devKey), { qos: 1 })
  d.on('message', (topic, payload) => { if (topic.endsWith('/invoice')) invoices.push(JSON.parse(payload)) })
  const payments = []
  const refusedPays = []
  P.billing.on('payment', (p) => payments.push(p))
  P.billing.on('payment-refused', (r) => refusedPays.push(r.reason))
  const payTopic = to(devKey, pk, 'pay')
  const authorize = (value, { key = wallet, validBefore = Math.floor(Date.now() / 1000) + 3600, nonce = '0x' + crypto.randomBytes(32).toString('hex') } = {}) => {
    const a = { from: eth.addressOf(key), to: PAYEE, value: String(value), validAfter: 0, validBefore, nonce }
    return { ...a, signature: eth.signTransfer(domain, a, key) }
  }

  for (let i = 0; i < 10; i++) await d.publishAsync(own(devKey) + 'telemetry', Buffer.alloc(100, i), { qos: 1 })
  const owed = 10n * 100n + (1000n * 1000n + 1023n) / 1024n // 10 messages of 100 bytes
  await until(() => invoices.some((i) => BigInt(i.owed) === owed), 3000)
  const full = invoices.find((i) => BigInt(i.owed) === owed)
  check('the node meters and sends invoices', full && full.due === String(owed) && full.pay === PAYEE && invoices.length >= 2, `owed ${owed}, ${invoices.length} invoices (one at half the credit)`)

  const bad = [
    [authorize(owed + 1n), 'more than due'],
    [authorize(500, { key: crypto.randomBytes(32) }), 'another wallet'],
    [authorize(500, { validBefore: Math.floor(Date.now() / 1000) + 30 }), 'expiring'],
    [{ ...authorize(500), to: '0x' + '22'.repeat(20) }, 'another payee']
  ]
  for (const [a] of bad) await d.publishAsync(payTopic, JSON.stringify(a), { qos: 1 })
  await until(() => refusedPays.length >= bad.length)
  check('payments that pay too much, from another wallet, expiring or elsewhere are refused', refusedPays.length === bad.length && payments.length === 0, refusedPays.join('; ').slice(0, 120))

  const good = authorize(owed)
  await d.publishAsync(payTopic, JSON.stringify({ ...good, invoice: full.invoice }), { qos: 1 })
  await until(() => payments.length === 1)
  check('a payment signed by the wallet in the DID record is accepted', payments.length === 1 && payments[0].authorization.value === String(owed) && P.billing.due(devKey) === 0n)
  await d.publishAsync(payTopic, JSON.stringify(good), { qos: 1 })
  await until(() => refusedPays.length > bad.length)
  check('the same authorization again is refused', payments.length === 1 && refusedPays.length === bad.length + 1)

  // over the credit: refused and disconnected; paying lets it publish again
  for (let i = 0; i < 25 && d.connected; i++) d.publish(own(devKey) + 'telemetry', Buffer.alloc(100), { qos: 0 })
  const cut = await closedWithin(d, 5000)
  check('over the credit, the node refuses and disconnects', cut && refusals.some((r) => r.reason === 'payment required'))
  await until(() => d.connected, 10000)
  const due = P.billing.due(devKey)
  await d.publishAsync(payTopic, JSON.stringify(authorize(due)), { qos: 1 })
  await until(() => payments.length === 2)
  await d.publishAsync(own(devKey) + 'telemetry', 'after paying', { qos: 1 })
  check('after paying it publishes again', payments.length === 2 && d.connected && P.billing.summary()[devKey].paid === String(owed + due), JSON.stringify(P.billing.summary()[devKey]))
  d.end(true)
  await P.close()
}

// refusals
const evil = await connect(A.publicKey, { dht: dhtEvil })
evil.publish(own(devKey) + 'telemetry', JSON.stringify({ seq: 999 }), { qos: 1 })
const evilClosed = await closedWithin(evil, 5000)
evil.end(true)
await sleep(300)
check('a key publishing under another key is refused and disconnected', evilClosed && !got.ops.some(([, p]) => p.includes('999')) && refusals.some((r) => r.reason.startsWith('publish only under')))

const takeover = await refused(connect(A.publicKey, { dht: testnet.createNode(), clientId: devKey, tries: 1 }))
check('a session takeover with the device client id is refused', takeover && takeover.code === 2 && dev.connected, takeover && takeover.message)

const badLogin = await refused(mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, { username: 'ops', password: 'wrong', reconnectPeriod: 0 }))
check('a TCP login with a bad password is refused', badLogin && badLogin.code === 4, badLogin && badLogin.message)
const noLogin = await refused(mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, { reconnectPeriod: 0 }))
check('a TCP client without a login is refused', !!noLogin)
const keyId = await refused(mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, { username: 'ops', password: 'secret', clientId: devKey, reconnectPeriod: 0 }))
check('a TCP client cannot take a key client id', keyId && keyId.code === 2)

const forger = await mqtt.connectAsync(`mqtt://127.0.0.1:${tcpPort}`, { username: 'ops', password: 'secret', clientId: 'ops-2', reconnectPeriod: 0 })
forger.publish(own(devKey) + 'telemetry', 'tcp-forged', { qos: 1 })
const forgerClosed = await closedWithin(forger, 5000)
forger.end(true)
check('a TCP app cannot publish under d/', forgerClosed && !got.app.some(([, p]) => p === 'tcp-forged'))
await ops.publishAsync('ops/notice', 'hello', { qos: 1 })
check('a TCP app may publish outside d/', ops.connected)

const usage = A.usage()
check('usage is counted per key', usage[devKey] && usage[devKey].messages === N && usage[devKey].bytes > 0 && usage['tcp:ops'] && usage['tcp:ops'].messages === 1 && !usage[evil.publicKey.toString('hex')], JSON.stringify(usage[devKey]))

// failover: B goes away; a client that knows both keys reconnects to A
const fail = await connect([B.publicKey, A.publicKey], { dht: testnet.createNode(), reconnectPeriod: 200 })
const firstNode = fail.node
for (const c of [subB, dev2]) c.end(true)
bridge.end(true)
back.end(true)
await B.close()
if (firstNode.equals(B.publicKey)) await until(() => fail.connected && fail.node.equals(A.publicKey), 20000)
check('a client moves to the other node when its node goes away', fail.connected && fail.node.equals(A.publicKey), `first ${firstNode.equals(B.publicKey) ? 'B' : 'A'}`)

for (const c of [dev, app, ops, fail]) c.end(true)
await A.close()
for (const d of [dhtDev, dhtApp, dhtEvil]) await d.destroy()
await testnet.destroy()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
