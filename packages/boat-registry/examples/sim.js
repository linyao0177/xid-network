#!/usr/bin/env node
// boat-sim: simulated devices on a network, for trying it without boards.
//
// usage: boat-sim --testnet [--devices 3] [--every 5] [--dir ~/.boat-sim] [--no-sponsor]
//        boat-sim --node <node key hex>[,<node key hex>..] [--devices 3] [--every 5] [--dir ..]
//
// Each device has its own key (a seed in <dir>/device-<n>.key, mode 600, made
// when missing, so it keeps its identity across runs), names a home node in
// its DHT record and publishes a signed reading at d/<key>/telemetry every
// --every seconds: { "mwh": <total>, "w": <power now> }, as an ESP32-C3 with
// examples/boat_device_min does. Devices are spread over the nodes.
//
// --testnet: the public testnet's nodes, from https://iot.xid.network/testnet.json,
// and each device asks the testnet to sponsor it (POST /api/sponsor): verify
// and store jobs on its readings, paid by the testnet. --no-sponsor skips that.

import fs from 'fs'
import os from 'os'
import path from 'path'
import HyperDHT from 'hyperdht'
import { connect, publishHome, own, sign } from 'boat-mqtt-node'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const log = (line) => console.log(new Date().toISOString().slice(11, 19) + ' ' + line)
const SITE = 'https://iot.xid.network'

const testnet = args.includes('--testnet')
const count = Number(opt('devices', 3))
const every = Number(opt('every', 5))
const dir = opt('dir', path.join(os.homedir(), '.boat-sim'))
let nodes = opt('node') ? opt('node').split(',') : []
if (testnet) nodes = (await (await fetch(opt('testnet-url', SITE + '/testnet.json'))).json()).nodes.map((n) => n.nodeKey)
if (!nodes.length || nodes.some((k) => !/^[0-9a-f]{64}$/i.test(k)) || !(count >= 1)) {
  console.error('usage: boat-sim --testnet [--devices 3] [--every 5] [--dir ~/.boat-sim] [--no-sponsor]\n       boat-sim --node <node key hex>[,..] [--devices 3] [--every 5]')
  process.exit(2)
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

const dht = new HyperDHT()
const devices = []

async function sponsor (key) {
  const res = await fetch(SITE + '/api/sponsor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: key }) })
  const body = await res.json()
  if (!res.ok || body.error) throw new Error(body.error || res.status)
  for (let i = 0; i < 30 && body.state !== 'done' && body.state !== 'failed'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 4000))
    Object.assign(body, await (await fetch(`${SITE}/api/request/${body.id}`)).json())
  }
  if (body.state === 'done') return `verify job #${body.result.jobs.verify}, store job #${body.result.jobs.store}`
  if (body.state === 'failed') throw new Error(body.result?.error || 'failed')
  return `request ${body.id} still ${body.state}`
}

async function start (i) {
  const file = path.join(dir, `device-${i}.key`)
  if (!fs.existsSync(file)) fs.writeFileSync(file, HyperDHT.keyPair().secretKey.subarray(0, 32).toString('hex'), { mode: 0o600 })
  const keyPair = HyperDHT.keyPair(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex'))
  const key = keyPair.publicKey.toString('hex')
  const home = nodes[i % nodes.length]
  await publishHome(dht, keyPair, Buffer.from(home, 'hex'))
  const client = await connect(home, { dht, keyPair })
  client.on('error', (err) => log(`device ${i}: ${err.message}`))
  const d = { i, key, client, n: 0, mwh: Math.floor(Math.random() * 1e6), boot: BigInt(Math.floor(Date.now() / 1000)) << 32n, topic: own(key) + 'telemetry' }
  devices.push(d)
  log(`device ${i} ${key} at node ${home.slice(0, 12)}…`)
  if (testnet && !args.includes('--no-sponsor')) {
    sponsor(key).then((s) => log(`device ${i} sponsored: ${s}`), (err) => log(`device ${i} not sponsored: ${err.message}`))
  }
  // readings start at a random offset, so the devices do not publish at once
  setTimeout(() => {
    d.timer = setInterval(() => {
      const w = 200 + Math.floor(Math.random() * 300)
      d.mwh += Math.round(w * every / 3.6)
      const seq = d.boot | BigInt(d.n++)
      d.client.publishAsync(d.topic, sign(keyPair.secretKey, d.topic, seq, JSON.stringify({ mwh: d.mwh, w })), { qos: 1 })
        .catch((err) => log(`device ${i} publish: ${err.message}`))
    }, every * 1000)
  }, Math.random() * every * 1000)
}

log(`${count} device(s) over ${nodes.length} node(s), a reading every ${every} s; keys in ${dir}`)
for (let i = 0; i < count; i++) await start(i).catch((err) => log(`device ${i}: ${err.message}`))
if (testnet) log(`see them at ${SITE}/network/ (and boat-watch --network xid-testnet)`)
setInterval(() => log(`${devices.reduce((a, d) => a + d.n, 0)} readings sent by ${devices.length} device(s)`), 60000)

async function stop () {
  for (const d of devices) { clearInterval(d.timer); d.client.end(true) }
  await dht.destroy()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
