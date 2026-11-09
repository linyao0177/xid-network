// A BoAT MER device (examples/boat_mer) joins the network, end to end:
//
//   1. factory: a manufacturer's key signs a credential for the device's DID
//      and wallet (in a product this happens on the production line);
//   2. consent: the owner's app asks the device, over its owner channel, to
//      sign that this owner may claim it (EIP-191, the device's MER key);
//   3. claim: the owner claims it on the registry, which checks both;
//   4. fund: the owner sends the device's wallet some of the stake token, to
//      pay MQTT nodes with (CONFIG_MER_MQTT_* on the device);
//   5. node: the owner picks an active, staked forwarding node from the
//      registry that answers on HyperDHT, and tells the device to use it; the
//      device moves there and names it in its own DID record.
//
// usage: node examples/onboard.js --did did:mw:<device> --owner-seed <file of hex>
//        --rpc http://127.0.0.1:8555 --registry 0x.. --token 0x..
//        --admin-key-file f --owner-key-file f --issuer-key-file f
//
// Key files hold one hex private key each. The admin adds the issuer to the
// registry if it is not there yet. Local chains only: this sends transactions.

import fs from 'fs'
import { createRequire } from 'module'
import HyperDHT from 'hyperdht'
import { Wallet, JsonRpcProvider, Contract } from 'ethers'
import { connect, homeOf } from 'boat-mqtt-node'
import { attach, asBytes32, ROLES, TEST_TOKEN } from '../index.js'

const { OwnerChannel } = createRequire(import.meta.url)('boat-peer')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const log = (line) => console.log('ONBOARD|' + new Date().toISOString().slice(11, 19) + ' ' + line)
const keyFile = (name) => fs.readFileSync(opt(name), 'utf8').trim()

const did = opt('did')
const provider = new JsonRpcProvider(opt('rpc'), undefined, { cacheTimeout: -1 })
const admin = new Wallet(keyFile('admin-key-file'), provider)
const owner = new Wallet(keyFile('owner-key-file'), provider)
const issuer = new Wallet(keyFile('issuer-key-file'))
const registry = attach(opt('registry'), owner)
const token = new Contract(opt('token'), TEST_TOKEN.abi, owner)
const dht = new HyperDHT()
const didKey = asBytes32(did.slice(7))
const t0 = Date.now()
const step = (n, text) => log(`${n}. ${text} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)

const channel = new OwnerChannel({ dht, did, keyPair: HyperDHT.keyPair(Buffer.from(fs.readFileSync(opt('owner-seed'), 'utf8').trim(), 'hex')) })
await channel.open()
const { address: wallet } = await channel.request({ op: 'address' })
log(`device ${did.slice(0, 20)}… wallet ${wallet}`)

// 1. the manufacturer's credential
const credential = await issuer.signMessage(await registry.credentialText(didKey, wallet))
if (!(await registry.issuers(issuer.address))) await (await attach(opt('registry'), admin).setIssuer(issuer.address, true)).wait()
step(1, `credential from issuer ${issuer.address}`)

// 2. the device's consent, signed on the device
const text = await registry.claimText(didKey, owner.address)
const consent = await channel.request({ op: 'sign', message: text })
if (!consent.ok) throw new Error('device refused to sign: ' + consent.error)
step(2, `device signed "${text.slice(0, 24)}…"`)

// 3. the claim
const existing = await registry.devices(didKey)
if (existing.owner === '0x0000000000000000000000000000000000000000') {
  const r = await (await registry.claimDevice(didKey, wallet, credential, consent.signature)).wait()
  step(3, `claimed on the registry, tx ${r.hash.slice(0, 18)}…, ${r.gasUsed} gas`)
} else {
  step(3, `already claimed by ${existing.owner}`)
}
const d = await registry.devices(didKey)
if (d.owner !== owner.address || d.wallet.toLowerCase() !== wallet.toLowerCase()) throw new Error('the registry does not show the claim')

// 4. fund the device's wallet
const amount = BigInt(opt('fund', '1000000'))
if ((await token.balanceOf(owner.address)) < amount) await (await token.mint(owner.address, amount)).wait()
await (await token.transfer(wallet, amount)).wait()
step(4, `sent ${amount} base units to the device wallet, which holds ${await token.balanceOf(wallet)}`)

// 5. a staked forwarding node that answers
const events = await attach(opt('registry'), provider).queryFilter('NodeRegistered')
let chosen = null
for (const e of events) {
  const operator = e.args.operator
  if (!(await registry.isActive(operator, ROLES.FORWARD))) continue
  const key = e.args.dhtKey.slice(2)
  try {
    const c = await connect(key, { dht, tries: 1, connectTimeout: 15000 })
    c.end(true)
    chosen = { key, operator, stake: (await registry.nodes(operator)).stake }
    break
  } catch {
    log(`   node ${key.slice(0, 12)}… (operator ${operator.slice(0, 10)}…) does not answer`)
  }
}
if (!chosen) throw new Error('no active forwarding node answers')
step(5, `chose node ${chosen.key.slice(0, 16)}… (operator ${chosen.operator.slice(0, 10)}…, stake ${chosen.stake})`)
const set = await channel.request({ op: 'mqtt_node', node: chosen.key })
if (!set.ok) throw new Error('device refused: ' + set.error)
let home = null
for (let i = 0; i < 40 && !(home && home.toString('hex') === chosen.key); i++) {
  await new Promise((resolve) => setTimeout(resolve, 3000))
  home = await homeOf(dht, did.slice(7)).catch(() => null)
}
step(5, home && home.toString('hex') === chosen.key ? 'the device moved there: its DID record names that node' : 'the device record does not name the node yet')
channel.close()
await dht.destroy()
process.exit(home && home.toString('hex') === chosen.key ? 0 : 1)
