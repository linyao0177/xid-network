// JS for contracts/BoatRegistry.sol (ethers 6).

import fs from 'fs'
import { ContractFactory, Contract, getBytes, AbiCoder, keccak256, ZeroAddress } from 'ethers'

const art = (name) => JSON.parse(fs.readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), 'utf8'))
export const REGISTRY = art('BoatRegistry')
export const TEST_TOKEN = art('TestToken')
export const ROLES = { FORWARD: 1, STORE: 2, VERIFY: 4, COMPUTE: 8 }

// epochLength: rewards earned in one epoch can be withdrawn after the next
// one; jobNotice: how long a job keeps paying after its payer closes it
// the plan settings every node uses (BoatRegistry.planParams): spare workers
// beyond a job's quorum, and the plan's block (every `step` blocks, `lag`
// behind the head). A chain that makes a block only for a transaction (anvil,
// a local fork) needs step 1 and lag 0, or a job posted on a quiet chain would
// wait for blocks that never come
export const encodePlan = ({ spare, step, lag }) => BigInt(spare) | (BigInt(step) << 8n) | (BigInt(lag) << 40n)
export const decodePlan = (p) => ({ spare: Number(BigInt(p) & 0xffn), step: Number((BigInt(p) >> 8n) & 0xffffffffn), lag: Number((BigInt(p) >> 40n) & 0xffffn) })

export async function deploy (signer, { token, minStake, unbonding = 7 * 24 * 3600, quorumBps = 6667, epochLength = 3600, jobNotice = 3600, jobFee = 0n, plan = {} }) {
  const local = (await signer.provider.getNetwork()).chainId === 31337n
  const p = { spare: 1, step: local ? 1 : 10, lag: local ? 0 : 2, ...plan }
  if (!(p.step >= 1)) throw new Error('plan step must be at least 1')
  const c = await new ContractFactory(REGISTRY.abi, REGISTRY.bytecode, signer).deploy(token, minStake, unbonding, quorumBps, epochLength, jobNotice, jobFee, encodePlan(p))
  await c.waitForDeployment()
  return c
}

export async function deployTestToken (signer, name = 'Test USD', symbol = 'TUSD') {
  const c = await new ContractFactory(TEST_TOKEN.abi, TEST_TOKEN.bytecode, signer).deploy(name, symbol)
  await c.waitForDeployment()
  return c
}

export const attach = (address, runner) => new Contract(address, REGISTRY.abi, runner)

// registers a node: approves the stake, then register(); dhtKey: 32 bytes (Buffer or hex)
export async function register (registry, operator, { dhtKey, roles, stake, token }) {
  const t = new Contract(token, TEST_TOKEN.abi, operator)
  await (await t.approve(await registry.getAddress(), stake)).wait()
  return (await registry.connect(operator).register(asBytes32(dhtKey), roles, stake)).wait()
}

// a verifier's signed word on a batch of its verdicts (lib/verifier.js); off-chain
export async function signVerdicts (registry, operator, batch, root, count) {
  const { chainId } = await registry.runner.provider.getNetwork()
  return operator.signMessage(getBytes(verdictsStatement({ registry: await registry.getAddress(), chainId }, operator.address, batch, root, count)))
}

// a verifier's signature on a judgement against operator
export async function signSlash (registry, verifier, { operator, amount, reason, nonce }) {
  const { chainId } = await registry.runner.provider.getNetwork()
  const h = slashStatementOf({ registry: await registry.getAddress(), chainId }, operator, amount, reason, nonce)
  return { address: verifier.address, signature: await verifier.signMessage(getBytes(h)) }
}

// the contract wants signatures sorted by signer address
export const sortedSignatures = (sigs) => sigs.slice().sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1)).map((s) => s.signature)

export function asBytes32 (key) {
  const h = typeof key === 'string' ? key.replace(/^0x/, '') : Buffer.from(key).toString('hex')
  if (h.length !== 64) throw new Error('need 32 bytes')
  return '0x' + h
}

const abi = AbiCoder.defaultAbiCoder()

// the contract's statements, computed here (no call): ctx = { registry, chainId }
export const workStatement = ({ registry, chainId }, job, unit, result) =>
  keccak256(abi.encode(['string', 'address', 'uint256', 'uint256', 'uint64', 'bytes32'], ['boat-work/1', registry, chainId, job, unit, result]))
export const slashStatementOf = ({ registry, chainId }, operator, amount, reason, nonce) =>
  keccak256(abi.encode(['string', 'address', 'uint256', 'address', 'uint256', 'bytes32', 'uint64'], ['boat-slash/1', registry, chainId, operator, amount, reason, nonce]))
// what verifiers sign to govern (BoatRegistry.govern)
export const governStatementOf = ({ registry, chainId }, kind, target, value, nonce) =>
  keccak256(abi.encode(['string', 'address', 'uint256', 'uint8', 'address', 'uint256', 'uint64'], ['boat-govern/1', registry, chainId, kind, target, value, nonce]))
export const settledKey = (job, unit) => keccak256(abi.encode(['uint256', 'uint64'], [job, unit]))
// a batch of a job's units (BoatRegistry.settleBatch): what its nodes sign, and
// where the contract records it as settled
// (forwarder: the node a forward job's batch pays; ZeroAddress for other jobs)
export const batchStatement = ({ registry, chainId }, job, batch, root, units, forwarder = ZeroAddress) =>
  keccak256(abi.encode(['string', 'address', 'uint256', 'uint256', 'uint64', 'bytes32', 'uint32', 'address'], ['boat-batch/2', registry, chainId, job, batch, root, units, forwarder]))
export const batchKey = (job, batch) => keccak256(abi.encode(['string', 'uint256', 'uint64'], ['batch', job, batch]))
export const batchLeaf = (unit, result) => keccak256(abi.encode(['uint64', 'bytes32'], [BigInt(unit), result]))
// a verifier's batch of verdicts (lib/verifier.js): signed, published, never on chain
export const verdictsStatement = ({ registry, chainId }, operator, batch, root, count) =>
  keccak256(abi.encode(['string', 'address', 'uint256', 'address', 'uint64', 'bytes32', 'uint32'], ['boat-verdicts/1', registry, chainId, operator, batch, root, count]))

// signers of what the contract counts must come sorted by address
export const sortBySigner = (list) => list.slice().sort((a, b) => (BigInt(a.operator ?? a.address) < BigInt(b.operator ?? b.address) ? -1 : 1))

// a provider for an RPC URL; HTTPS_PROXY is used for remote ones (Node's own
// fetch ignores it), and responses are not cached (ethers caches 250 ms,
// which hands out the same nonce to quick transactions)
export async function providerFor (rpc, opts = {}) {
  const { FetchRequest, JsonRpcProvider } = await import('ethers')
  const req = new FetchRequest(rpc)
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (proxy && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(rpc)) {
    const { HttpsProxyAgent } = await import('https-proxy-agent')
    req.getUrlFunc = FetchRequest.createGetUrlFunc({ agent: new HttpsProxyAgent(proxy, { keepAlive: true }) })
  } else {
    // one connection per request runs a busy node out of sockets: keep them
    const mod = rpc.startsWith('https:') ? await import('https') : await import('http')
    req.getUrlFunc = FetchRequest.createGetUrlFunc({ agent: new mod.Agent({ keepAlive: true, maxSockets: 8 }) })
  }
  // public RPCs fail now and then (rate limits, a dropped connection, an
  // error with no data): try a request again before giving up
  class RetryingProvider extends JsonRpcProvider {
    async _send (payload) {
      // reads only: a transaction's error (a nonce, the fee) is an answer
      const reads = [].concat(payload).every((p) => !/^eth_(sendRawTransaction|estimateGas)$/.test(p.method))
      for (let i = 0; ; i++) {
        try {
          const res = await super._send(payload)
          const flaky = reads && res.some((r) => r.error && !/revert/i.test(r.error.message || '') && r.error.data === undefined)
          if (!flaky || i >= 3) return res
        } catch (err) {
          if (!reads || i >= 3) throw err
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)))
      }
    }
  }
  return new RetryingProvider(req, undefined, { cacheTimeout: -1, pollingInterval: opts.pollingInterval || 2000, staticNetwork: opts.staticNetwork })
}

// ---- iteration 3 ---------------------------------------------------------------

export const READS = art('BoatReads')

export async function deployReads (signer, { token, registry, notice = 3600 }) {
  const c = await new ContractFactory(READS.abi, READS.bytecode, signer).deploy(token, registry, notice)
  await c.waitForDeployment()
  return c
}
export const attachReads = (address, runner) => new Contract(address, READS.abi, runner)

// a verifier's signature on a governance change
export async function signGovern (registry, verifier, { kind, target, value, nonce }) {
  const { chainId } = await registry.runner.provider.getNetwork()
  const h = governStatementOf({ registry: await registry.getAddress(), chainId }, kind, target, value, nonce)
  return { address: verifier.address, signature: await verifier.signMessage(getBytes(h)) }
}

// what a device signs to post a job paid from its balance; terms: { role, quorum, spec, pay, budget }
// terms: { role, quorum, perEpoch, deadline, spec, pay, budget }, the contract's JobTerms
export const jobRequestStatementOf = ({ registry, chainId }, did, t, params, nonce) =>
  keccak256(abi.encode(['string', 'address', 'uint256', 'bytes32', 'uint8', 'uint16', 'uint32', 'uint64', 'bytes32', 'uint256', 'uint256', 'bytes32', 'uint64'],
    ['boat-job/1', registry, chainId, asBytes32(did), t.role, t.quorum, t.perEpoch, t.deadline, t.spec, t.pay, t.budget, keccak256(params), nonce]))

export const readStatementOf = ({ reads, chainId }, reader, store, generation, cumulative) =>
  keccak256(abi.encode(['string', 'address', 'uint256', 'address', 'address', 'uint64', 'uint256'], ['boat-read/1', reads, chainId, reader, store, generation, cumulative]))
