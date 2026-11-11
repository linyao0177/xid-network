#!/usr/bin/env node
// An app on the network: prints what devices publish and can send one a
// command, logged in with its own key (no password).
//
// usage: node examples/watch.js [<node key> | --network boat-mqtt] [--key app.json]
//                               [--filter 'd/+/#'] [--to <device key> --send text [--every 5]]
//                               [--home] [--seconds 60]
//
// Signed messages (hdht_mqtt_sign) are checked against the key in their topic
// and shown with their sequence number. --home sends to the device's home
// node, named in its record, instead of the node we watch.

import { connect, connectHome, to, senderOf, SignedInbox } from '../index.js'
import { loadKeyPair } from '../lib/keyfile.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const target = args[0] && !args[0].startsWith('--') ? args[0] : null
const keyPair = opt('key') ? loadKeyPair(opt('key')) : undefined
const log = (line) => console.log('WATCH|' + new Date().toISOString().slice(11, 23) + ' ' + line)

const t = Date.now()
const client = await connect(target, { network: opt('network'), keyPair })
log(`connected to node ${client.node.toString('hex').slice(0, 16)}… in ${Date.now() - t} ms as ${client.publicKey.toString('hex')}`)
client.on('error', (err) => log('error ' + err.message))
client.on('reconnect', () => log('reconnecting'))
client.on('connect', () => log(`connected to node ${client.node.toString('hex').slice(0, 16)}…`))

await client.subscribeAsync(opt('filter', 'd/+/#'), { qos: 1 })
const inbox = new SignedInbox()
client.on('message', (topic, payload) => {
  const from = senderOf(topic)
  let shown = String(payload)
  if (payload[0] === 0x53 && payload[1] === 1) {
    const r = inbox.check(topic, payload)
    shown = r.ok ? `[signed seq ${r.seq >> 32n}:${r.seq & 0xffffffffn}] ${r.payload}` : `[REFUSED: ${r.reason}]`
  }
  log(`${from ? from.slice(0, 12) + '… ' : ''}${topic.replace(/^d\/[0-9a-f]{64}\//, '')} ${shown}`)
})

const dev = opt('to')
if (dev && opt('send')) {
  let n = 0
  const out = args.includes('--home') ? await connectHome(dev, { dht: client.dht, keyPair: client.keyPair, clientId: client.publicKey.toString('hex') + '-out' }) : client
  if (out !== client) log(`sending through the device's home node ${out.node.toString('hex').slice(0, 16)}…`)
  const send = () => {
    const text = opt('send').replace('{n}', String(n++))
    out.publish(to(client.publicKey, dev, 'cmd'), text, { qos: 1 })
    log(`sent to ${dev.slice(0, 12)}…: ${text}`)
  }
  send()
  if (opt('every')) setInterval(send, Number(opt('every')) * 1000)
}

setTimeout(() => {
  client.end()
  process.exit(0)
}, Number(opt('seconds', 60)) * 1000)
