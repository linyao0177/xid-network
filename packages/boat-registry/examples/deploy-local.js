// Deploys a test token and the registry on a local chain (anvil, its test
// mnemonic) and registers nodes: prints their addresses as JSON.
//
// usage: node examples/deploy-local.js --rpc http://127.0.0.1:8555
//        [--node <dht key hex>:<roles>]...   (roles: 1 forward, 2 store, 4 verify, 8 compute)

import { HDNodeWallet, JsonRpcProvider } from 'ethers'
import { deploy, deployTestToken, register } from '../index.js'

const MNEMONIC = 'test test test test test test test test test test test junk' // anvil's own, local chains only
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const provider = new JsonRpcProvider(opt('rpc'), undefined, { cacheTimeout: -1 })
const acct = (i) => HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).connect(provider)
const admin = acct(0)
const token = await deployTestToken(admin)
const registry = await deploy(admin, { token: await token.getAddress(), minStake: 100_000000n, unbonding: 600 })
const nodes = args.flatMap((a, i) => a === '--node' ? [args[i + 1]] : [])
const out = { token: await token.getAddress(), registry: await registry.getAddress(), nodes: [] }
for (const [i, spec] of nodes.entries()) {
  const [key, roles] = spec.split(':')
  const operator = acct(10 + i)
  await (await token.mint(operator.address, 1000_000000n)).wait()
  await register(registry, operator, { dhtKey: key, roles: Number(roles), stake: 100_000000n + BigInt(i) * 50_000000n, token: out.token })
  out.nodes.push({ key, roles: Number(roles), operator: operator.address })
}
console.log(JSON.stringify(out))
