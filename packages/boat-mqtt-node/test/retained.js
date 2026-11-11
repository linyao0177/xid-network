// Retained messages with a TTL, and copied payloads: node test/retained.js
//
// A day's run of the work network grew each node by about 200 MB an hour:
// work messages are retained, one topic per unit, and were kept for ever,
// each pinning the network chunk its payload was sliced from.

import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../index.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}

const testnet = await createTestnet(3)
const node = await createNode({ dht: testnet.createNode(), network: null, retainTtl: (topic) => (topic.includes('/work/') ? 1000 : 0) })
const publish = (topic, payload) => new Promise((resolve) => node.broker.publish({ cmd: 'publish', topic, payload, qos: 0, retain: true }, resolve))
const retained = async (pattern) => {
  const out = []
  for await (const p of node.broker.persistence.asyncPersistence.createRetainedStream(pattern)) out.push(p)
  return out
}
try {
  const chunk = Buffer.alloc(65536, 7)
  const slice = chunk.subarray(100, 140) // a payload sliced from a big chunk
  await publish('d/aa/work/dev/1/0', slice)
  await publish('d/aa/work/dev/1/1', Buffer.from('two'))
  await publish('d/aa/receipts/dev', Buffer.from('receipt'))
  const kept = await retained('d/aa/#')
  const work = kept.find((p) => p.topic === 'd/aa/work/dev/1/0')
  check('retained messages are kept', kept.length === 3)
  check('a retained payload is a copy of its own (not a slice of the chunk, nor in the shared pool)', work && work.payload.equals(slice) && work.payload.buffer.byteLength === slice.length, work && `${work.payload.buffer.byteLength} bytes behind it`)
  check('nothing has expired yet', node.expireRetained() === 0)
  const dropped = node.expireRetained(Date.now() + 2000)
  await new Promise((resolve) => setTimeout(resolve, 100)) // (the store deletes asynchronously)
  const left = (await retained('d/aa/#')).map((p) => p.topic)
  check('after their TTL, retained messages on work topics are dropped; others stay', dropped === 2 && left.length === 1 && left[0] === 'd/aa/receipts/dev', left.join(', '))
} catch (err) {
  console.error(err)
  failed++
} finally {
  await node.close()
  await testnet.destroy()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}
