// Deploys the registry and BoatReads on any chain, from a key file, with a
// stablecoin as stake (--token, an ERC-20 such as Arc's USDC at
// 0x3600000000000000000000000000000000000000) or a test token it deploys.
//
// usage: node examples/deploy.js --rpc <url> --key-file <file> [--token 0x..]
//        [--min-stake 100000000] [--unbonding 86400] [--epoch 3600] [--notice 3600]
//        [--out deployment.json]
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
const params = { minStake: BigInt(opt('min-stake', '100000000')), unbonding: Number(opt('unbonding', 86400)), epochLength: Number(opt('epoch', 3600)), jobNotice: Number(opt('notice', 3600)) }
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
  ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
}
if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
process.exit(0)
