// Deploying a network and talking to its contract.

import { Contract, ContractFactory, getAddress } from 'ethers'
import { postJob, depinJob, attach } from 'boat-registry'
import { checkConfig, configHash } from './config.js'
import { curveOf } from './curve.js'
import NETWORK from '../artifacts/DepinNetwork.json' with { type: 'json' }
import TOKEN from '../artifacts/DepinToken.json' with { type: 'json' }

export const NETWORK_ABI = NETWORK.abi
export const TOKEN_ABI = TOKEN.abi
export const attachNetwork = (address, runner) => new Contract(address, NETWORK.abi, runner)
export const attachToken = (address, runner) => new Contract(address, TOKEN.abi, runner)

// deploys the reward token (unless rewardToken is given), the network, and
// the oracles' job on the registry, and attaches it:
//   netKey: the network's HyperDHT public key (hex); its home record must be
//     kept up (xid-depin keeper)
//   job: { quorum, pay, budget, perEpoch } in the registry's token
// returns { network, token, job, block }
export async function deployNetwork (admin, { registry, config, netKey, start = null, rewardToken = null, job = {}, log = () => {} }) {
  checkConfig(config)
  const reg = attach(registry, admin)
  const t0 = start ?? Math.floor(Date.now() / 1000)
  let token = rewardToken
  const mintable = !rewardToken && config.token?.mintable !== false
  let tokenContract = null
  if (!token) {
    tokenContract = await new ContractFactory(TOKEN.abi, TOKEN.bytecode, admin).deploy(config.token?.name || config.title || config.name, config.token?.symbol || 'RWD')
    await tokenContract.waitForDeployment()
    token = await tokenContract.getAddress()
    log(`token ${token}`)
  }
  const fee = BigInt(config.enroll?.fee ?? 0)
  const net = await new ContractFactory(NETWORK.abi, NETWORK.bytecode, admin).deploy(
    registry, '0x' + netKey, configHash(config), token, mintable, t0, config.epoch.length, fee, config.enroll?.maxDevices ?? 0, curveOf(config.curve))
  await net.waitForDeployment()
  const network = await net.getAddress()
  const block = (await net.deploymentTransaction().wait()).blockNumber
  log(`network ${network} (block ${block})`)
  if (tokenContract && mintable) await (await tokenContract.setMinter(network)).wait()
  const terms = { quorum: 2, pay: 1_000000n, budget: 50_000000n, perEpoch: 10, ...job }
  const j = depinJob({ network, config })
  const id = await postJob(reg, admin, { ...j, device: netKey, pay: BigInt(terms.pay), quorum: terms.quorum, budget: BigInt(terms.budget), perEpoch: terms.perEpoch })
  log(`oracles' job #${id} on the registry`)
  await (await net.attachJob(id)).wait()
  return { network, token: getAddress(token), job: Number(id), block, start: t0, mintable }
}

// a network's state for showing it: settings, devices, epochs
export async function networkInfo (network, provider) {
  const n = attachNetwork(network, provider)
  const [key, hash, token, mintable, start, length, fee, max, count, epoch, emitted, owed, job] = await Promise.all([
    n.networkKey(), n.configHash(), n.rewardToken(), n.mintable(), n.start(), n.epochLength(), n.enrollFee(), n.maxDevices(), n.deviceCount(), n.epoch(), n.emitted(), n.owed(), n.currentJob()])
  return { network, netKey: key.slice(2), configHash: hash, token, mintable, start: Number(start), epochLength: Number(length), enrollFee: fee, maxDevices: Number(max), devices: Number(count), epoch: Number(epoch), emitted, owed, job: Number(job) }
}
