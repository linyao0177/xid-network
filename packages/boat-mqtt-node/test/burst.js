// A client that sends a large backlog at once (an MQTT client flushing what
// it queued while the node was away): node test/burst.js
//
// Aedes parses a read and handles each publish; when publishing completes
// synchronously it reads and parses the next packet from inside the last
// one's callback, so a backlog of many thousand packets in one read overflows
// the stack (a day's run lost a node to "Maximum call stack size exceeded").

import net from 'net'
import createTestnet from 'hyperdht/testnet.js'
import mqttPacket from 'mqtt-packet'
import { createNode } from '../index.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}

const N = 60000
const testnet = await createTestnet(3)
const node = await createNode({ dht: testnet.createNode(), network: null, tcp: { port: 18883 }, users: { app: 'secret' } })
let crashed = null
process.on('uncaughtException', (err) => { crashed = err })
let delivered = 0
node.broker.subscribe('burst/#', (packet, cb) => { delivered++; cb() }, () => {})
try {
  const sock = net.connect(18883, '127.0.0.1')
  await new Promise((resolve) => sock.once('connect', resolve))
  const parts = [mqttPacket.generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clean: true, clientId: 'burst', keepalive: 60, username: 'app', password: Buffer.from('secret') })]
  await new Promise((resolve) => { sock.write(parts[0]); sock.once('data', resolve) }) // CONNACK
  const burst = []
  for (let i = 0; i < N; i++) burst.push(mqttPacket.generate({ cmd: 'publish', topic: 'burst/' + (i % 10), payload: Buffer.from(String(i)), qos: 0, retain: false }))
  sock.write(Buffer.concat(burst)) // one write: the node reads it as one backlog
  const end = Date.now() + 20000
  while (delivered < N && !crashed && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100))
  check('a backlog of 60,000 publishes in one read is handled without overflowing the stack', !crashed && delivered === N, crashed ? crashed.message : `${delivered} delivered`)
  sock.destroy()
} catch (err) {
  console.error(err)
  failed++
} finally {
  await node.close()
  await testnet.destroy()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
