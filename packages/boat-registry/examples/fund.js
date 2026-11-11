#!/usr/bin/env node
// Sends an operator gas and mints it test stake tokens (TestToken mints for anyone).
//
// usage: node examples/fund.js --rpc <url> --key-file <funder> --token 0x.. --to 0x..
//        [--gas 1.5] [--stake 200000000]

import fs from 'fs'
import { Wallet, Contract, parseEther, formatEther } from 'ethers'
import { providerFor, TEST_TOKEN } from '../index.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const provider = await providerFor(opt('rpc'))
const funder = new Wallet(fs.readFileSync(opt('key-file'), 'utf8').trim(), provider)
const to = opt('to')
if (Number(opt('gas', '1.5')) > 0) await (await funder.sendTransaction({ to, value: parseEther(opt('gas', '1.5')) })).wait()
const token = new Contract(opt('token'), TEST_TOKEN.abi, funder)
if (BigInt(opt('stake', '200000000')) > 0n) await (await token.mint(to, BigInt(opt('stake', '200000000')))).wait()
console.log(`${to}: gas ${formatEther(await provider.getBalance(to))}, stake token ${await token.balanceOf(to)}; funder has ${formatEther(await provider.getBalance(funder.address))} left`)
process.exit(0)
