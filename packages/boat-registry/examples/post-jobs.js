#!/usr/bin/env node
// Posts verify, store and compute (energy bill) jobs for one meter.
//
// usage: node examples/post-jobs.js --rpc <url> --registry 0x.. --key-file <payer>
//        --device <hex> [--window 20] [--pay 1000000] [--units 200] [--quorum 2]
//        [--field mwh] [--price 250] [--only verify,store,compute]
//
// The payer mints the budget in the test stake token first.

import fs from 'fs'
import { Wallet, Contract } from 'ethers'
import { attach, providerFor, TEST_TOKEN, postJob, verifyJob, storeJob, computeJob } from '../index.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const provider = await providerFor(opt('rpc'))
const payer = new Wallet(fs.readFileSync(opt('key-file'), 'utf8').trim(), provider)
const registry = attach(opt('registry'), payer)
const window = Number(opt('window', 20))
const pay = BigInt(opt('pay', '1000000'))
const budget = pay * BigInt(opt('units', 200))
const quorum = Number(opt('quorum', 2))
const only = opt('only', 'verify,store,compute').split(',')
const token = new Contract(await registry.token(), TEST_TOKEN.abi, payer)
await (await token.mint(payer.address, budget * BigInt(only.length))).wait()
const wasm = fs.readFileSync(new URL('../rules/energy-bill.wasm', import.meta.url))
const kinds = { verify: verifyJob({ window }), store: storeJob({ window }), compute: computeJob({ wasm, field: opt('field', 'mwh'), window, price: Number(opt('price', 250)) }) }
const out = {}
for (const k of only) out[k] = await postJob(registry, payer, { ...kinds[k], device: opt('device'), pay, quorum, budget })
console.log(JSON.stringify(out))
process.exit(0)
