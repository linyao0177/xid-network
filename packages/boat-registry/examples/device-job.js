// A BoAT MER device (examples/boat_mer) asks for a job on its own data and
// pays for it from its own balance on the registry:
//
//   1. the owner funds the device's balance (fundDevice), once;
//   2. the owner's app sends the terms over the owner channel (op post_job);
//      the device puts in its own DID, checks the budget against its limit
//      (CONFIG_MER_JOB_MAX_BUDGET) and signs the request with its MER key;
//   3. anyone relays it (postJobFromDevice): here, the owner.
//
// usage: node examples/device-job.js --did did:mw:<device> --owner-seed <file>
//        --rpc <url> --registry 0x.. --owner-key-file <file>
//        [--role store|verify|compute|forward] [--window 20] [--pay 1000000]
//        [--units 100] [--quorum 2] [--per-epoch 12] [--fund 200000000]
//
// The device must be claimed on this registry by the owner first
// (examples/onboard.js).

import fs from 'fs'
import { createRequire } from 'module'
import HyperDHT from 'hyperdht'
import { Wallet, Contract, keccak256, toUtf8Bytes, verifyMessage, getBytes } from 'ethers'
import { attach, providerFor, asBytes32, TEST_TOKEN, ROLES, verifyJob, storeJob, forwardJob, computeJob, jobRequestStatementOf } from '../index.js'

const { OwnerChannel } = createRequire(import.meta.url)('boat-peer')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const log = (line) => console.log('DEVJOB|' + new Date().toISOString().slice(11, 19) + ' ' + line)

const did = opt('did')
const didKey = asBytes32(did.slice(7))
const provider = await providerFor(opt('rpc'))
const owner = new Wallet(fs.readFileSync(opt('owner-key-file'), 'utf8').trim(), provider)
const registry = attach(opt('registry'), owner)
const token = new Contract(await registry.token(), TEST_TOKEN.abi, owner)
const chainId = (await provider.getNetwork()).chainId
const window = Number(opt('window', 20))
const wasm = fs.readFileSync(new URL('../rules/energy-bill.wasm', import.meta.url))
const kinds = { verify: verifyJob({ window }), store: storeJob({ window }), forward: forwardJob({ window }), compute: computeJob({ wasm, field: 'mwh', window, price: 250 }) }
const job = kinds[opt('role', 'store')]
const pay = BigInt(opt('pay', '1000000'))
const terms = {
  role: job.role,
  quorum: Number(opt('quorum', 2)),
  perEpoch: Number(opt('per-epoch', 12)),
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  spec: job.spec,
  pay,
  budget: pay * BigInt(opt('units', 100))
}
const params = toUtf8Bytes(JSON.stringify(job.params))

const d = await registry.devices(didKey)
if (d.owner !== owner.address) throw new Error(`the device is claimed by ${d.owner}, not by ${owner.address}`)

// 1. the device's balance
const fund = BigInt(opt('fund', String(terms.budget)))
if ((await registry.deviceBalance(didKey)) < terms.budget) {
  if ((await token.balanceOf(owner.address)) < fund) await (await token.mint(owner.address, fund)).wait()
  await (await token.approve(await registry.getAddress(), fund)).wait()
  await (await registry.fundDevice(didKey, fund)).wait()
}
log(`device balance ${await registry.deviceBalance(didKey)}`)

// 2. the device signs its request
const dht = new HyperDHT()
const channel = new OwnerChannel({ dht, did, keyPair: HyperDHT.keyPair(Buffer.from(fs.readFileSync(opt('owner-seed'), 'utf8').trim(), 'hex')) })
await channel.open()
const nonce = await registry.deviceNonce(didKey)
const t0 = Date.now()
const res = await channel.request({
  op: 'post_job',
  registry: await registry.getAddress(),
  chainId: String(chainId),
  role: String(terms.role),
  quorum: String(terms.quorum),
  perEpoch: String(terms.perEpoch),
  deadline: String(terms.deadline),
  spec: terms.spec,
  pay: String(terms.pay),
  budget: String(terms.budget),
  paramsHash: keccak256(params),
  nonce: String(nonce)
})
if (!res.ok) throw new Error('device refused: ' + res.error)
const statement = jobRequestStatementOf({ registry: await registry.getAddress(), chainId }, didKey, terms, params, nonce)
const signer = verifyMessage(getBytes(statement), res.signature)
log(`the device signed its request in ${Date.now() - t0} ms; it hashed what the contract hashes: ${signer === d.wallet ? 'yes' : 'NO'} (${signer})`)

// 3. relayed
const before = Number(await registry.jobCount())
const r = await (await registry.postJobFromDevice(didKey, terms, params, res.signature)).wait()
const j = await registry.jobs(before)
log(`job ${before} posted for the device: role ${Object.keys(ROLES).find((k) => ROLES[k] === terms.role).toLowerCase()}, budget ${j.budget}, paid by the device (balance now ${await registry.deviceBalance(didKey)}), tx ${r.hash.slice(0, 14)}…, ${r.gasUsed} gas`)
channel.close()
await dht.destroy()
process.exit(0)
