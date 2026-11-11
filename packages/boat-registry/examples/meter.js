#!/usr/bin/env node
// A simulated energy meter, for trying the network without a board: its own
// key, its home node named in its DHT record, and a signed reading
// ({ "mwh": <total> }) at d/<key>/telemetry every few seconds, the way
// examples/mqtt_p2p with CONFIG_MQTT_P2P_METER publishes on an ESP32-C3.
//
// usage: node examples/meter.js --node <node key hex> [--key meter.key]
//        [--every 2] [--count 0] [--bootstrap host:port,...]
//
// --node: the forwarding node to use as home (boat-node run prints its key).
// --key: a file holding the meter's 32-byte seed in hex; made (mode 600) when
// missing, so the meter keeps its identity across runs. Its public key, the
// device key that jobs name, is printed; the seed never is.
// --count: stop after this many readings (0: run until stopped).
//
// Sequence numbers are (start time in seconds << 32) | count, so a restarted
// meter never repeats one and nodes never take a reading as a replay.

import fs from 'fs'
import HyperDHT from 'hyperdht'
import { connect, publishHome, own, sign } from 'boat-mqtt-node'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const log = (line) => console.log(new Date().toISOString().slice(11, 19) + ' ' + line)

const node = opt('node')
if (!/^[0-9a-f]{64}$/i.test(node || '')) {
  console.error('usage: node examples/meter.js --node <node key hex> [--key meter.key] [--every 2] [--count 0]')
  process.exit(2)
}
const keyFile = opt('key', 'meter.key')
const every = Number(opt('every', 2))
const count = Number(opt('count', 0))
const bootstrap = opt('bootstrap') ? opt('bootstrap').split(',') : undefined

if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, HyperDHT.keyPair().secretKey.subarray(0, 32).toString('hex'), { mode: 0o600 })
const keyPair = HyperDHT.keyPair(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex'))
const device = keyPair.publicKey.toString('hex')

const dht = new HyperDHT({ bootstrap })
const home = Buffer.from(node, 'hex')
await publishHome(dht, keyPair, home)
const client = await connect(home, { dht, keyPair })
log(`meter ${device}`)
log(`home node ${node.slice(0, 16)}…, publishing every ${every} s`)

const topic = own(device) + 'telemetry'
const boot = BigInt(Math.floor(Date.now() / 1000)) << 32n
let n = 0
let mwh = 0
const timer = setInterval(async () => {
  mwh += 250 + Math.floor(Math.random() * 100)
  const seq = boot | BigInt(n)
  await client.publishAsync(topic, sign(keyPair.secretKey, topic, seq, JSON.stringify({ mwh })), { qos: 1 }).catch((err) => log('publish: ' + err.message))
  n++
  if (n % 10 === 0) log(`${n} readings sent, ${mwh} mWh`)
  if (count && n >= count) stop()
}, every * 1000)

async function stop () {
  clearInterval(timer)
  log(`stopped after ${n} readings`)
  client.end(true)
  await dht.destroy()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
