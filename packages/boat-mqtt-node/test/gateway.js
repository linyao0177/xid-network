// Tests for the gateway in front of a real NanoMQ: node test/gateway.js
//
// Needs a nanomq binary: $NANOMQ, or nanomq on the PATH (skipped otherwise).
// The gateway listens on a local HyperDHT testnet and writes NanoMQ's
// configuration; NanoMQ checks logins with the gateway and keeps each key to
// d/<key>/ with its own ACL (${username}).

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn, execFileSync } from 'child_process'
import createTestnet from 'hyperdht/testnet.js'
import HyperDHT from 'hyperdht'
import mqtt from 'mqtt'
import { createGateway, nanomqConfig, connect, own, to, inboxOf } from '../index.js'

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
const closedWithin = (c, ms) => new Promise((resolve) => {
  if (!c.connected) return resolve(true)
  const t = setTimeout(() => resolve(false), ms)
  c.once('close', () => { clearTimeout(t); resolve(true) })
})
async function refused (promise) {
  try {
    const c = await promise
    c.end(true)
    return null
  } catch (err) {
    return err
  }
}
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

let nanomqBin = process.env.NANOMQ
if (!nanomqBin) {
  try {
    nanomqBin = execFileSync('which', ['nanomq']).toString().trim()
  } catch {}
}
if (!nanomqBin || !fs.existsSync(nanomqBin)) {
  console.log('SKIP the gateway tests: no nanomq ($NANOMQ or on the PATH)')
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mqtt-gateway-'))
const port = await freePort()
const testnet = await createTestnet(3)
const network = 'boat-mqtt-gw-' + process.pid
const g = await createGateway({ dht: testnet.createNode(), network, broker: { host: '127.0.0.1', port }, users: { ops: 'ops-secret' } })
const gwRefused = []
g.on('refused', (r) => gwRefused.push(r))
const { conf, acl } = nanomqConfig({ port, authUrl: g.authUrl, aclPath: path.join(tmp, 'nanomq_acl.conf') })
fs.writeFileSync(path.join(tmp, 'nanomq.conf'), conf)
fs.writeFileSync(path.join(tmp, 'nanomq_acl.conf'), acl)
const broker = spawn(nanomqBin, ['start', '--conf', path.join(tmp, 'nanomq.conf')], { stdio: ['ignore', 'pipe', 'pipe'] })
let brokerLog = ''
broker.stdout.on('data', (d) => { brokerLog += d })
broker.stderr.on('data', (d) => { brokerLog += d })
const canConnect = () => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1')
  s.on('connect', () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false))
})
for (let i = 0; i < 50 && !(await canConnect()); i++) await sleep(200)
check('NanoMQ starts with the gateway\'s configuration', broker.exitCode === null, brokerLog.trim().split('\n').slice(-1)[0] || '')

const tcp = (o) => mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0, connectTimeout: 5000, ...o })
// NanoMQ refuses a login by closing the connection, without a CONNACK error,
// so connectAsync never settles: true when refused, false when let in
const tcpRefused = (o) => new Promise((resolve) => {
  const c = mqtt.connect(`mqtt://127.0.0.1:${port}`, { reconnectPeriod: 0, connectTimeout: 5000, ...o })
  c.once('connect', () => { c.end(true); resolve(false) })
  c.once('error', () => { c.end(true); resolve(true) })
  c.once('close', () => resolve(true))
})

// a device through the gateway, found by network name; an operator app on NanoMQ's TCP port
const devDht = testnet.createNode()
const dev = await connect(null, { dht: devDht, network })
const devKey = dev.publicKey.toString('hex')
check('a device reaches NanoMQ through the gateway by network name', dev.connected && dev.node.equals(g.publicKey))
const ops = await tcp({ username: 'ops', password: 'ops-secret', clientId: 'ops-1' })
const got = []
await ops.subscribeAsync('d/+/telemetry', { qos: 1 })
ops.on('message', (t, p) => got.push([t, String(p)]))
const N = 100
for (let i = 0; i < N; i++) dev.publish(own(devKey) + 'telemetry', JSON.stringify({ seq: i }), { qos: 1 })
await until(() => got.length >= N, 10000)
// NanoMQ itself may deliver QoS 1 out of order (seen over plain TCP too), so count, not order
const seqs = new Set(got.filter(([t]) => t === own(devKey) + 'telemetry').map(([, p]) => JSON.parse(p).seq))
const swapped = got.filter(([, p], i) => i && JSON.parse(p).seq < JSON.parse(got[i - 1][1]).seq).length
check(`${N} messages under its own key reach an app on NanoMQ`, got.length === N && seqs.size === N, `${got.length}/${N}, ${swapped} out of order`)

// a command into the device's inbox, from an app that also comes through the gateway
const inbox = []
await dev.subscribeAsync(inboxOf(devKey), { qos: 1 })
dev.on('message', (t, p) => inbox.push([t, String(p)]))
const app = await connect(g.publicKey, { dht: testnet.createNode() })
await app.publishAsync(to(app.publicKey, devKey), 'relay=on', { qos: 1 })
await until(() => inbox.length > 0)
check('an app sends the device a command through NanoMQ', inbox.length === 1 && inbox[0][0] === to(app.publicKey, devKey) && inbox[0][1] === 'relay=on')

// NanoMQ's ACL with ${username}: a key may not publish under another key
const evil = await connect(g.publicKey, { dht: testnet.createNode() })
const before = got.length
evil.publish(own(devKey) + 'telemetry', JSON.stringify({ seq: 999 }), { qos: 1 })
const evilClosed = await closedWithin(evil, 5000)
evil.end(true)
await sleep(500)
check('NanoMQ\'s ACL refuses a key publishing under another key, and disconnects it', evilClosed && got.length === before)

// the gateway refuses a session takeover; NanoMQ refuses logins that do not come through it
const takeover = await refused(connect(g.publicKey, { dht: testnet.createNode(), clientId: devKey, tries: 1 }))
check('a takeover with the device\'s client id is refused by the gateway', takeover && takeover.code === 2 && dev.connected && gwRefused.length === 1, takeover && takeover.message)
check('a direct login as a key without the gateway\'s secret is refused', await tcpRefused({ username: devKey, password: 'guess', clientId: devKey + '-x' }) && dev.connected)
// NanoMQ (4ac14f5) drops a session when a login with its client id arrives,
// even one it then refuses. Only processes on this machine reach its port,
// and the gateway refuses such logins before NanoMQ sees them; noted, not failed.
let devDropped = 0
dev.on('close', () => devDropped++)
check('an operator app cannot log in with a key\'s client id', await tcpRefused({ username: 'ops', password: 'ops-secret', clientId: devKey }))
await until(() => dev.connected, 10000)
const afterOps = devDropped
await tcpRefused({ clientId: devKey })
await sleep(1000)
await until(() => dev.connected, 10000)
console.log(`NOTE NanoMQ dropped the device ${afterOps} time(s) for a refused operator login with its client id, ${devDropped - afterOps} for a refused anonymous one; it reconnected (${dev.connected})`)
check('anonymous logins are refused', await tcpRefused({ clientId: 'anon' }))

// the operator's app may not publish under d/, but may elsewhere
const forger = await tcp({ username: 'ops', password: 'ops-secret', clientId: 'ops-2' })
forger.publish(own(devKey) + 'telemetry', 'forged', { qos: 1 })
const forgerClosed = await closedWithin(forger, 5000)
forger.end(true)
await sleep(300)
check('an operator app cannot publish under d/', forgerClosed && !got.some(([, p]) => p === 'forged'))
await ops.publishAsync('ops/notice', 'hello', { qos: 1 })
check('an operator app publishes outside d/', ops.connected)

// MQTT 5 through the gateway
const v5 = await connect(g.publicKey, { dht: testnet.createNode(), protocolVersion: 5 })
const v5key = v5.publicKey.toString('hex')
await v5.publishAsync(own(v5key) + 'telemetry', JSON.stringify({ seq: 'v5' }), { qos: 1 })
await until(() => got.some(([t]) => t === own(v5key) + 'telemetry'))
const v5takeover = await refused(connect(g.publicKey, { dht: testnet.createNode(), protocolVersion: 5, clientId: v5key, tries: 1 }))
check('MQTT 5 works through the gateway, and its takeover is refused too', got.some(([t]) => t === own(v5key) + 'telemetry') && !!v5takeover, v5takeover && v5takeover.message)

for (const c of [dev, ops, app, v5]) c.end(true)
broker.kill('SIGTERM')
await g.close()
for (const d of [devDht]) await d.destroy()
await testnet.destroy()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
