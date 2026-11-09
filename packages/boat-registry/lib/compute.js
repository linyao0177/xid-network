// Compute nodes: a WASM rule run on device readings by several nodes, whose
// signed results are accepted when two of three agree.
//
// - A job names a rule by the hash of its WASM, a device, a field of its
//   readings and a window: compute nodes follow the device (boat-mqtt-node's
//   Follower), take only messages with the device's own valid signature and a
//   new sequence number, and run the rule on each window of `window`
//   readings, fixed by sequence number so that every node bills the same ones
//   (a window missing a reading is not billed).
// - Each result is published retained at
//   d/<node>/results/<job>/<first seq> with its inputs (sequence numbers and
//   values) and the operator's EIP-191 signature over
//   keccak256(abi.encode("boat-compute/1", registry, chainId, job, wasm,
//   device, first, last, keccak(inputs), result)).
// - The rule is deterministic (integer WASM, no imports), so anyone can run it
//   again on the published inputs (checkResult). A node that signed a wrong
//   result for the same inputs is judged by a quorum of verifiers on the
//   registry (BoatRegistry.slash).

import { EventEmitter } from 'events'
import { AbiCoder, keccak256, getBytes, verifyMessage } from 'ethers'
import { Follower } from 'boat-mqtt-node'
import { judgeMessage, VERDICT } from './verifier.js'

const abi = AbiCoder.defaultAbiCoder()

// runs a rule's bill(n, price) on i64 values (no imports: nothing outside it)
export function runRule (wasm, values, price) {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), {})
  const mem = new BigInt64Array(instance.exports.memory.buffer, 0, values.length)
  values.forEach((v, i) => { mem[i] = BigInt(v) })
  return instance.exports.bill(values.length, BigInt(price))
}

export const wasmHash = (wasm) => keccak256(wasm)
export const jobId = (job) => keccak256(Buffer.from(JSON.stringify({ wasm: job.wasm, device: job.device, topic: job.topic, field: job.field, window: job.window, price: String(job.price) })))
export const inputsHash = (inputs) => keccak256(abi.encode(['uint64[]', 'int64[]'], [inputs.map(([s]) => BigInt(s)), inputs.map(([, v]) => BigInt(v))]))

export function resultStatement ({ registry, chainId, job, wasm, device, first, last, inputs, result }) {
  return keccak256(abi.encode(['string', 'address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'uint64', 'bytes32', 'int256'],
    ['boat-compute/1', registry, chainId, job, wasm, '0x' + device, BigInt(first), BigInt(last), inputsHash(inputs), BigInt(result)]))
}

export async function createComputer (opts) {
  const c = new Computer(opts)
  await c.ready()
  return c
}

export class Computer extends EventEmitter {
  constructor ({ dht, keyPair, operator, registry, job, wasm, lie = null }) {
    super()
    this.dht = dht
    this.keyPair = keyPair
    this.publicKey = keyPair.publicKey
    this.operator = operator
    this.registry = registry
    this.job = { ...job, wasm: wasmHash(wasm) }
    this.id = jobId(this.job)
    this.wasm = wasm
    this.lie = lie
    this.follower = new Follower({ dht, keyPair, role: 'compute' })
    this.inputs = []
    this.last = new Map()
    this.results = []
  }

  async ready () {
    this.chainId = (await this.registry.runner.provider.getNetwork()).chainId
    this.registryAddress = await this.registry.getAddress()
    this.follower.on('message', (device, topic, payload) => this._take(device, topic, payload).catch((err) => this.emit('error', err)))
    await this.follower.follow(this.job.device)
    return this
  }

  async _take (device, topic, payload) {
    if (device !== this.job.device || !topic.endsWith('/' + this.job.topic)) return
    const v = judgeMessage(device, topic, payload, this.last)
    if (v.verdict !== VERDICT.SIGNED_OK) return // only the device's own word, and only once
    let value
    try {
      value = JSON.parse(payload.subarray(74).toString())[this.job.field]
    } catch {}
    if (!Number.isInteger(value)) return
    // windows are fixed by sequence number, so every node bills the same
    // readings: window k of a boot holds counts k*window .. k*window+window-1
    const seq = BigInt(v.seq)
    const w = ((seq >> 32n) << 32n) | ((seq & 0xffffffffn) / BigInt(this.job.window))
    if (this._window !== w) {
      this._window = w
      this.inputs = [] // a window we joined part way through is not billed
    }
    this.inputs.push([v.seq, String(value)])
    if (this.inputs.length === this.job.window) await this._compute(this.inputs.splice(0))
  }

  async _compute (inputs) {
    let result = runRule(this.wasm, inputs.map(([, v]) => v), this.job.price)
    if (this.lie) result = this.lie(result)
    const r = {
      v: 1,
      job: this.id,
      wasm: this.job.wasm,
      device: this.job.device,
      first: inputs[0][0],
      last: inputs.at(-1)[0],
      inputs,
      result: String(result),
      price: String(this.job.price),
      node: this.publicKey.toString('hex'),
      operator: this.operator.address,
      registry: this.registryAddress,
      chainId: String(this.chainId)
    }
    r.signature = await this.operator.signMessage(getBytes(resultStatement({ ...r, chainId: this.chainId })))
    this.results.push(r)
    await this.follower.publish(`d/${r.node}/results/${this.id.slice(2, 18)}/${r.first}`, JSON.stringify(r), { qos: 1, retain: true })
    this.emit('result', r)
  }

  async close () {
    await this.follower.close()
  }
}

// checks a result: the operator's signature, and the rule run again on its inputs
export function checkResult (r, wasm) {
  if (wasmHash(wasm) !== r.wasm) return { ok: false, reason: 'another rule' }
  if (verifyMessage(getBytes(resultStatement({ ...r, chainId: BigInt(r.chainId) })), r.signature) !== r.operator) return { ok: false, reason: 'not signed by the operator' }
  const again = String(runRule(wasm, r.inputs.map(([, v]) => v), r.price))
  return again === r.result ? { ok: true } : { ok: false, reason: `the rule gives ${again}, not ${r.result}` }
}

// results of several nodes for one window: the answer two thirds sign, and who differs
export function aggregate (results, wasm, price) {
  const groups = new Map()
  for (const r of results) {
    const k = inputsHash(r.inputs) + ':' + r.result
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || []
  const accepted = best.length * 3 >= results.length * 2 ? best[0] : null
  const deviants = results.filter((r) => !best.includes(r)).map((r) => {
    const again = runRule(wasm, r.inputs.map(([, v]) => v), price)
    return { node: r.node, operator: r.operator, result: r.result, wrong: String(again) !== r.result, sameInputs: accepted && inputsHash(r.inputs) === inputsHash(accepted.inputs) }
  })
  return { accepted: accepted ? { result: accepted.result, first: accepted.first, last: accepted.last, signers: best.map((r) => r.operator) } : null, deviants }
}
