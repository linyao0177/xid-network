// Tests for storage nodes: node test/store.js
//
// A device on node A names A as its home. A store follows it there and keeps
// its signed messages in a Hypercore; a reader checks every entry against the
// store's signed tree and the device's signature; a mirror replicates the
// core; spot checks find blocks a store no longer holds; a restarted store
// carries on.

import fs from 'fs'
import os from 'os'
import path from 'path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode, connect, publishHome, own, sign, createStore, createMirror, openLog, spotCheck, openReceipt, encodeEntry } from '../index.js'
import { createRequire } from 'module'

const { verifyBlock } = createRequire(import.meta.url)('boat-ota')

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (!(await fn()) && Date.now() < end) await sleep(30)
  return fn()
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-store-'))
const testnet = await createTestnet(3)
const A = await createNode({ dht: testnet.createNode(), network: null })

// the device: home A, signed telemetry
const devDht = testnet.createNode()
const dev = await connect(A.publicKey, { dht: devDht })
const key = dev.publicKey.toString('hex')
await publishHome(devDht, dev.keyPair, A.publicKey)
const topic = own(key) + 'telemetry'
const say = (seq, text) => dev.publishAsync(topic, sign(dev.keyPair.secretKey, topic, seq, text), { qos: 1 })

// the store follows it to A
const storeDht = testnet.createNode()
const storeKp = storeDht.defaultKeyPair
const S = await createStore({ dht: storeDht, keyPair: storeKp, storage: path.join(tmp, 'store'), devices: [key], receiptMs: 300 })
const rejected = []
S.on('rejected', (r) => rejected.push(r.reason))
check('the store follows the device to its home node', S.clients.size === 1)

for (let n = 1; n <= 20; n++) await say(n, `reading ${n}`)
await dev.publishAsync(topic, 'not signed', { qos: 1 })
const forged = sign(dev.keyPair.secretKey, topic, 21, 'x')
forged[forged.length - 1] ^= 1
await dev.publishAsync(topic, forged, { qos: 1 })
await dev.publishAsync(topic, sign(dev.keyPair.secretKey, topic, 7, 'reading 7 again'), { qos: 1 }) // a replay
await until(() => S.stats.stored + S.stats.rejected + S.stats.replayed >= 23)
check('it keeps the 20 signed messages, refuses an unsigned and a forged one and a replay', S.stats.stored === 20 && rejected.join() === 'not signed,bad signature' && S.stats.replayed === 1, JSON.stringify(S.stats))

// a reader checks each entry against the store's signed tree and the device's signature
const reader = testnet.createNode()
const log = await openLog(reader, S.publicKey, key)
const all = []
for (let i = 0; i < log.length; i++) all.push(await log.block(i))
log.close()
check('a reader gets all 20, each checked twice, in order', all.length === 20 && all.every((r, i) => r.ok && r.seq === BigInt(i + 1) && String(r.payload) === `reading ${i + 1}`))

// the store's receipt for what it stored, retained at A under the store's key
const auditor = await connect(A.publicKey, { dht: testnet.createNode() })
let receipt = null
auditor.on('message', (t, p) => { receipt = openReceipt(String(p), storeKp.publicKey) })
await auditor.subscribeAsync(`d/${storeKp.publicKey.toString('hex')}/receipts/${key}`, { qos: 1 })
await until(() => receipt && receipt.count === 20)
check('the store signs a receipt for what it stored, readable at the home node', receipt && receipt.count === 20 && receipt.ranges.map(([a, b]) => `${a}-${b}`).join() === '1-20')

// a mirror replicates the core and serves it; the same checks pass against it
const M = await createMirror({ dht: testnet.createNode(), storage: path.join(tmp, 'mirror'), store: S.publicKey })
await M.sync()
const viaMirror = await spotCheck(reader, M.publicKey, key, { indices: [...Array(20).keys()] })
check('a mirror replicates the store and passes a check of every block', viaMirror.ok && viaMirror.checked === 20, `${viaMirror.ms} ms`)

// spot checks: random blocks from the store; then the store drops some
const spot = await spotCheck(reader, S.publicKey, key, { samples: 8 })
check('a spot check of 8 random blocks passes', spot.ok && spot.checked === 8, `${spot.ms} ms`)
const core = (await S._device(key)).core
await core.clear(5, 15)
const after = await spotCheck(reader, S.publicKey, key, { indices: [...Array(20).keys()] })
check('after the store drops blocks 5-14, a check of every block finds exactly those', !after.ok && after.failed.map((f) => f.index).join() === '5,6,7,8,9,10,11,12,13,14', after.failed[0] && after.failed[0].reason)

// a store cannot change an entry: it no longer hashes to the signed tree
{
  const l = await openLog(reader, M.publicKey, key)
  const real = await l.block(3)
  l.close()
  const fake = { index: 3, nodes: [], data: encodeEntry(topic, sign(dev.keyPair.secretKey, topic, 4, 'changed')) }
  check('a changed entry does not verify against the signed tree', real.ok && verifyBlock(l.head, fake) !== null)
}

// a restart: the store reopens its cores and still refuses old sequence numbers
await S.close()
const storeDht2 = testnet.createNode()
const S2 = await createStore({ dht: storeDht2, keyPair: storeKp, storage: path.join(tmp, 'store'), devices: [key] })
await say(21, 'reading 21')
await say(5, 'reading 5 again')
await until(() => S2.stats.stored + S2.stats.replayed >= 2)
const log2 = await openLog(reader, S2.publicKey, key)
const last = await log2.block(log2.length - 1)
log2.close()
check('after a restart it appends to the same core and still refuses replays', log2.length === 21 && last.ok && last.seq === 21n && S2.stats.replayed === 1, `length ${log2.length}`)

for (const c of [dev, auditor]) c.end(true)
await S2.close()
await M.close()
await A.close()
await testnet.destroy()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
