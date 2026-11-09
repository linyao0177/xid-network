// Pay-to-power on the network: a meter (examples/mqtt_p2p with
// CONFIG_MQTT_P2P_METER) publishes signed energy readings; three staked
// compute nodes bill every few readings with a WASM rule and two of three must
// agree; a consumer pays each bill to the meter owner's wallet; the owner keeps
// the relay on while bills are paid and switches it off when one is not.
//
// usage: node examples/pay-to-power.js --rpc http://127.0.0.1:8555 --registry 0x.. --token 0x..
//        --device <meter key> --owner-seed <file> [--price 250] [--window 6]
//        [--bills 6] [--skip 3] [--liar]
//
// --price: token base units per Wh (the rule gets mWh); --skip n: the
// consumer does not pay bill n; --liar: one compute node signs wrong bills.
// Local chains only: it registers compute nodes and sends transactions with
// anvil's test accounts.

import fs from 'fs'
import HyperDHT from 'hyperdht'
import { HDNodeWallet, JsonRpcProvider, Contract } from 'ethers'
import { connectHome, to } from 'boat-mqtt-node'
import { attach, register, ROLES, TEST_TOKEN, createComputer, aggregate, checkResult } from '../index.js'

const MNEMONIC = 'test test test test test test test test test test test junk'
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const log = (line) => console.log('DEMO|' + new Date().toISOString().slice(11, 19) + ' ' + line)
const provider = new JsonRpcProvider(opt('rpc'), undefined, { cacheTimeout: -1, pollingInterval: 200 })
const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(provider)
const registry = attach(opt('registry'), provider)
const token = new Contract(opt('token'), TEST_TOKEN.abi, provider)
const device = opt('device')
const price = BigInt(opt('price', 250))
const window = Number(opt('window', 6))
const bills = Number(opt('bills', 6))
const skip = Number(opt('skip', 3))
const wasm = fs.readFileSync(new URL('../rules/energy-bill.wasm', import.meta.url))

const ownerWallet = acct(6) // the meter owner's wallet (the device's owner in onboard.js)
const consumer = acct(7)
const ownerKeys = HyperDHT.keyPair(Buffer.from(fs.readFileSync(opt('owner-seed'), 'utf8').trim(), 'hex'))

// three staked compute nodes
const operators = [13, 14, 15].map(acct)
for (const [i, o] of operators.entries()) {
  if (await registry.isActive(o.address, ROLES.COMPUTE)) continue
  await (await token.connect(acct(0)).mint(o.address, 1000_000000n)).wait()
  await register(registry, o, { dhtKey: Buffer.alloc(32, 0xc0 + i), roles: ROLES.COMPUTE, stake: 100_000000n, token: opt('token') })
}
await (await token.connect(acct(0)).mint(consumer.address, 10_000000n)).wait()
const job = { device, topic: 'telemetry', field: 'mwh', window, price }
const results = new Map() // first seq -> [result]
const computers = []
for (const [i, o] of operators.entries()) {
  const dht = new HyperDHT()
  const c = await createComputer({ dht, keyPair: HyperDHT.keyPair(), operator: o, registry, job, wasm, lie: args.includes('--liar') && i === 2 ? (r) => r * 3n : null })
  c.on('error', (err) => log(`compute node ${i + 1}: ${err.message}`))
  c.on('result', (r) => {
    if (!results.has(r.first)) results.set(r.first, [])
    results.get(r.first).push(r)
  })
  computers.push(c)
}
log(`3 compute nodes follow the meter ${device.slice(0, 12)}…, a bill every ${window} readings at ${price} base units per Wh`)

// the owner's app, at the meter's home node; a stranger tries the relay too
const dht = new HyperDHT()
const ownerApp = await connectHome(device, { dht, keyPair: ownerKeys })
const relay = (state) => ownerApp.publishAsync(to(ownerKeys.publicKey, device, 'relay'), state, { qos: 1 })
const stranger = await connectHome(device, { dht })
await stranger.publishAsync(to(stranger.publicKey, device, 'relay'), 'off', { qos: 1 })
log('a stranger sent the relay "off" (the meter should refuse it)')
await relay('on')

const startBalance = await token.balanceOf(ownerWallet.address)
let unpaid = null
for (let n = 1; n <= bills; n++) {
  // wait for the next window's results from all three (or two after a while)
  let first = null
  for (let t = 0; t < 600 && !first; t++) {
    for (const [k, rs] of results) if (rs.length === 3 || (rs.length >= 2 && Date.now() - rs[0].at > 10000)) first = k
    for (const rs of results.values()) for (const r of rs) r.at ??= Date.now()
    if (!first) await new Promise((resolve) => setTimeout(resolve, 200))
    if (t % 50 === 49) log(`   waiting: inputs ${computers.map((c) => c.inputs.length).join('/')}, results ${[...results.values()].map((rs) => rs.length).join(',') || 'none'}`)
  }
  if (!first) throw new Error('no bill came')
  const rs = results.get(first)
  results.delete(first)
  const agg = aggregate(rs, wasm, price)
  const r = rs.find((x) => x.result === agg.accepted.result)
  const energy = BigInt(r.inputs.at(-1)[1]) - BigInt(r.inputs[0][1])
  const liars = agg.deviants.filter((d) => d.wrong).map((d) => d.operator.slice(0, 10) + '…')
  log(`bill ${n}: readings ${BigInt(r.first) & 0xffffffffn}..${BigInt(r.last) & 0xffffffffn}, ${energy} mWh, ${agg.accepted.result} base units, ${agg.accepted.signers.length} of ${rs.length} agree${liars.length ? `; ${liars.join(', ')} signed a wrong bill (${agg.deviants[0].result}), re-run shows it` : ''}; check ${checkResult(r, wasm).ok ? 'ok' : 'FAILED'}`)

  // the consumer pays, except bill `skip`
  if (n === skip) {
    unpaid = BigInt(agg.accepted.result)
    log(`bill ${n}: the consumer does not pay`)
    await relay('off')
    log('bill unpaid: the owner switches the relay OFF')
  } else {
    const amount = BigInt(agg.accepted.result) + (unpaid || 0n)
    if (amount > 0n) {
      const tx = await (await token.connect(consumer).transfer(ownerWallet.address, amount)).wait()
      log(`bill ${n}: the consumer paid ${amount}${unpaid ? ' (with the unpaid one)' : ''} to the owner, tx ${tx.hash.slice(0, 14)}…`)
    }
    if (unpaid !== null) {
      unpaid = null
      await relay('on')
      log('paid up: the owner switches the relay ON')
    }
  }
}
log(`the owner's wallet got ${(await token.balanceOf(ownerWallet.address)) - startBalance} base units`)
for (const c of computers) await c.close()
ownerApp.end(true)
stranger.end(true)
process.exit(0)
