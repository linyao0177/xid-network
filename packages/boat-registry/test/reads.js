// Paid reads from a store: node test/reads.js
//
// A store keeps a meter's messages and sells its blocks over a BoatReads
// channel: a reader pays per block with vouchers, a few blocks are free (for
// spot checks), an underpaying voucher is refused, and the store redeems
// what it is owed on chain.

import os from 'os'
import fs from 'fs'
import path from 'path'
import createTestnet from 'hyperdht/testnet.js'
import { HDNodeWallet } from 'ethers'
import { createNode, createStore, connect, publishHome, own, sign, openLog } from 'boat-mqtt-node'
import { deploy, deployTestToken, register, ROLES, deployReads, ReadSeller, ReadPayer, getRecord } from '../index.js'
import { startChain, MNEMONIC } from './chain.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PRICE = 10_000n // per block: 0.01 of a 6-decimal token

const chain = await startChain(8559)
const testnet = await createTestnet(3)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boat-reads-'))
let store, node, meter
try {
  const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(chain.provider)
  const [admin, op, reader] = [0, 1, 2].map(acct)
  const token = await deployTestToken(admin)
  const reg = await deploy(admin, { token: await token.getAddress(), minStake: 100_000000n })
  const reads = await deployReads(admin, { token: await token.getAddress(), registry: await reg.getAddress(), notice: 600 })
  for (const w of [op, reader]) await (await token.mint(w.address, 1000_000000n)).wait()
  await register(reg, op, { dhtKey: Buffer.alloc(32, 1), roles: ROLES.STORE, stake: 100_000000n, token: await token.getAddress() })

  const seller = await new ReadSeller({ reads, operator: op, price: PRICE, freeBlocks: 4, redeemEvery: 1000 }).ready()
  node = await createNode({ dht: testnet.createNode(), network: null })
  store = await createStore({ dht: testnet.createNode(), storage: path.join(tmp, 'store'), authorize: seller.authorize, record: seller.terms() })
  const devDht = testnet.createNode()
  meter = await connect(node.publicKey, { dht: devDht })
  const device = meter.publicKey.toString('hex')
  await publishHome(devDht, meter.keyPair, node.publicKey)
  await store.follow(device)
  const topic = own(device) + 'telemetry'
  for (let i = 0; i < 30; i++) await meter.publishAsync(topic, sign(meter.keyPair.secretKey, topic, i, JSON.stringify({ mwh: i * 100 })), { qos: 1 })
  for (let t = 0; t < 100 && store.stats.stored < 30; t++) await sleep(100)

  const rec = await getRecord(testnet.createNode(), store.publicKey)
  check('the store\'s record says what a block costs and where to pay', rec && rec.read_price === String(PRICE) && rec.reads === await reads.getAddress() && rec.operator === op.address)

  // free blocks, then payment required
  const dht = testnet.createNode()
  const log = await openLog(dht, store.publicKey, device)
  const freeReads = []
  for (let i = 0; i < 6; i++) freeReads.push(await log.block(i))
  log.close()
  check('a few blocks per reader are free (spot checks); then payment is required', freeReads.slice(0, 4).every((b) => b.ok) && freeReads.slice(4).every((b) => !b.ok && /payment required/.test(b.reason)), freeReads[5].reason.slice(0, 40) + '…')

  // paid
  const payer = await new ReadPayer({ reads, reader, store: op.address, price: PRICE }).open(1_000000n, token)
  const paid = await openLog(dht, store.publicKey, device, { pay: payer.pay })
  const blocks = []
  for (let i = 0; i < 20; i++) blocks.push(await paid.block(i))
  check('a reader with a channel pays per block: every block checked against the device\'s signature', blocks.every((b) => b.ok) && blocks[7].payload.toString() === JSON.stringify({ mwh: 700 }), `20 blocks, ${seller.stats.paid} vouchers`)

  // an underpaying voucher
  const replayed = await (async () => {
    const body = await payer.pay()
    payer.cumulative -= PRICE
    const r1 = await openLog(dht, store.publicKey, device, { pay: async () => body })
    const a = await r1.block(2)
    const b = await r1.block(3)
    r1.close()
    return [a, b]
  })()
  check('a voucher that does not owe the price again is refused', replayed[0].ok && !replayed[1].ok && /more/.test(replayed[1].reason), replayed[1].reason)
  paid.close()

  const b0 = await token.balanceOf(op.address)
  await seller.redeem()
  const got = (await token.balanceOf(op.address)) - b0
  check('the store redeems what it is owed on chain, once', got === PRICE * BigInt(seller.stats.paid) && (await reads.channels(reader.address, op.address)).redeemed === got, `${got} for ${seller.stats.paid} blocks`)
} catch (err) {
  console.error(err)
  failed++
} finally {
  meter?.end(true)
  await store?.close().catch(() => {})
  await node?.close().catch(() => {})
  await testnet.destroy()
  chain?.anvil.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
