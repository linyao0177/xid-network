#!/usr/bin/env node
// Deploys the registry and BoatReads on any chain, from a key file, with a
// stablecoin as stake (--token, an ERC-20 such as Arc's USDC at
// 0x3600000000000000000000000000000000000000) or a test token it deploys.
//
// usage: boat-deploy (or node examples/deploy.js) --rpc <url> --key-file <file> [--token 0x..]
//        [--min-stake 100000000] [--unbonding 86400] [--epoch 3600] [--notice 3600]
//        [--job-fee 1000000] [--spare 1] [--plan-step n] [--plan-lag n]
//        [--out deployment.json]
//
// --job-fee: what posting a job costs (to the treasury, not refunded), in the
// token's units: 1000000 is 1 USDC. `block` in the output is where the
// registry's events start: give it to nodes as fromBlock. --spare, --plan-step
// and --plan-lag are how every node plans who works on what. Without them: step
// 1 and lag 0 on a local chain (chain id 31337: anvil, which makes blocks only
// for transactions), else 10 and 2. An anvil fork of another chain keeps that
// chain's id: give it --plan-step 1 --plan-lag 0.
//
// HTTPS_PROXY is used for remote RPCs.

import fs from 'fs'
import { Wallet } from 'ethers'
import { deploy, deployTestToken, deployReads, providerFor } from '../index.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const provider = await providerFor(opt('rpc'))
const admin = new Wallet(fs.readFileSync(opt('key-file'), 'utf8').trim(), provider)
const params = { minStake: BigInt(opt('min-stake', '100000000')), unbonding: Number(opt('unbonding', 86400)), epochLength: Number(opt('epoch', 3600)), jobNotice: Number(opt('notice', 3600)), jobFee: BigInt(opt('job-fee', '1000000')), plan: Object.fromEntries([['spare', opt('spare', null)], ['step', opt('plan-step', null)], ['lag', opt('plan-lag', null)]].filter(([, v]) => v !== null).map(([k, v]) => [k, Number(v)])) }
const tokenAddress = opt('token') || await (await deployTestToken(admin, 'Test Stake USD', 'TSUSD')).getAddress()
const registry = await deploy(admin, { token: tokenAddress, ...params })
const reads = await deployReads(admin, { token: tokenAddress, registry: await registry.getAddress(), notice: params.jobNotice })
const out = {
  chainId: String((await provider.getNetwork()).chainId),
  rpc: opt('rpc'),
  token: tokenAddress,
  testToken: !opt('token'),
  registry: await registry.getAddress(),
  reads: await reads.getAddress(),
  block: (await registry.deploymentTransaction().wait()).blockNumber,
  admin: admin.address,
  ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'object' ? v : String(v)]))
}
if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
process.exit(0)
