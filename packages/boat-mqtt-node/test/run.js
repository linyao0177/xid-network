// Tests for boat-mqtt-node: node test/run.js
//
// Two nodes on a local HyperDHT testnet. A device-like client finds them by
// network name and publishes under its key; an app reads it over TCP and
// over HyperDHT, and sends the device a command; a second node bridges the
// telemetry. Then the refusals: a key that publishes under another key, a
// session takeover, a bad TCP login, a TCP app that writes under d/.

import net from 'net'
import createTestnet from 'hyperdht/testnet.js'
import mqtt from 'mqtt'
import { createNode, connect, findNodes, own, to, inboxOf, senderOf } from '../index.js'

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
