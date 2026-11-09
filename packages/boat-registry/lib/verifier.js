// A verifier node: checks what devices publish, signs its verdicts in
// batches, and anchors each batch's Merkle root on the registry.
//
// - It follows devices to their home nodes (boat-mqtt-node's Follower) and
//   gives every message a verdict, a set of flags:
//     SIGNED_OK / SIGNED_BAD   the device's own signature (hdht_mqtt_sign)
//     REPLAY                   a sequence number seen before
//     ATTESTED_OK / _BAD       a BoAT MER attested reading in the payload
// - Every batchMs it puts the verdicts in a Merkle tree (keccak256 leaves, so
//   a contract can check them too), signs the root with its operator key,
//   anchors it with BoatRegistry.anchor(), and publishes the batch, leaves and
//   all, retained at d/<verifier>/batches/<batch>. Anyone can rebuild the
//   tree, check a verdict against the anchored root, and audit it: auditBatch()
//   re-checks the verdicts of messages one also holds. A wrong verdict is
//   judged by a quorum of verifiers (BoatRegistry.slash); two roots for one
//   batch need no judge (slashEquivocation).

import { EventEmitter } from 'events'
import { createRequire } from 'module'
import { AbiCoder, keccak256, getBytes, verifyMessage } from 'ethers'
import { Follower, open, seqOf } from 'boat-mqtt-node'
import { merkleRoot, merkleProof, verifyProof } from './merkle.js'
import { signAnchor } from './registry.js'

const require = createRequire(import.meta.url)
const { verifyReading } = require('boat-peer')

export const VERDICT = { SIGNED_OK: 1, SIGNED_BAD: 2, REPLAY: 4, ATTESTED_OK: 8, ATTESTED_BAD: 16 }
const abi = AbiCoder.defaultAbiCoder()

// the leaf of a verdict: keccak256(abi.encode(device, keccak(topic), seq, keccak(payload), verdict))
export function leafOf ({ device, topic, seq, payloadHash, verdict }) {
  return keccak256(abi.encode(['bytes32', 'bytes32', 'uint64', 'bytes32', 'uint8'], ['0x' + device, keccak256(Buffer.from(topic)), BigInt(seq), payloadHash, verdict]))
}

// a verdict on one message; `last` maps topic -> last seq seen (updated)
export function judgeMessage (device, topic, payload, last = new Map()) {
  let verdict = 0
  let seq = seqOf(payload)
  let body = payload
  if (seq !== null) {
    const m = open(Buffer.from(device, 'hex'), topic, payload)
    if (m) {
      verdict |= VERDICT.SIGNED_OK
      body = m.payload
      const prev = last.get(topic)
      if (prev !== undefined && seq <= prev) verdict |= VERDICT.REPLAY
      else last.set(topic, seq)
    } else verdict |= VERDICT.SIGNED_BAD
  } else {
    seq = 0n
  }
  try {
    const r = JSON.parse(body.toString())
    if (r && r.hash && r.sig && r.did) verdict |= verifyReading('did:mw:' + device, body).ok ? VERDICT.ATTESTED_OK : VERDICT.ATTESTED_BAD
  } catch {}
  return { device, topic, seq: String(seq), payloadHash: keccak256(payload), verdict }
}

export async function createVerifier (opts) {
  const v = new Verifier(opts)
  await v.ready()
  return v
}

export class Verifier extends EventEmitter {
  constructor ({ dht, keyPair, operator, registry, devices = [], batchMs = 10000, lie = null }) {
    super()
    this.dht = dht
    this.keyPair = keyPair
    this.publicKey = keyPair.publicKey
    this.operator = operator // an ethers Wallet with a provider: signs and anchors
    this.registry = registry.connect(operator)
    this.follower = new Follower({ dht, keyPair, role: 'verifier' })
    this.devices = devices
    this.batchMs = batchMs
    this.lie = lie // for tests: changes a verdict before it is signed
    this.pending = []
    this.last = new Map() // device -> Map(topic -> seq)
    this.messages = new Map() // device:seq -> { topic, payload }, for audits
    this.batches = []
  }

  async ready () {
    this.follower.on('message', (device, topic, payload) => this._check(device, topic, payload))
    for (const d of this.devices) await this.follower.follow(d)
    this._timer = setInterval(() => this.flush().catch((err) => this.emit('error', err)), this.batchMs)
    this._timer.unref()
    return this
  }

  _check (device, topic, payload) {
    if (!this.last.has(device)) this.last.set(device, new Map())
    let leaf = judgeMessage(device, topic, payload, this.last.get(device))
    if (this.lie) leaf = this.lie(leaf) || leaf
    this.pending.push(leaf)
    this.messages.set(device + ':' + leaf.seq + ':' + topic, { topic, payload })
    this.emit('verdict', leaf)
  }

  // signs and anchors what came in since the last batch
  async flush () {
    if (this.pending.length === 0 || this._flushing) return null
    this._flushing = true
    try {
      const leaves = this.pending.splice(0)
      const batch = Math.floor(Date.now() / 1000)
      const root = merkleRoot(leaves.map(leafOf))
      const signature = await signAnchor(this.registry, this.operator, batch, root, leaves.length)
      const tx = await (await this.registry.anchor(batch, root, leaves.length)).wait()
      const b = { v: 1, verifier: this.publicKey.toString('hex'), operator: this.operator.address, batch, root, count: leaves.length, signature, tx: tx.hash, leaves }
      this.batches.push(b)
      await this.follower.publish(`d/${this.publicKey.toString('hex')}/batches/${batch}`, JSON.stringify(b), { qos: 1, retain: true })
      this.emit('batch', b)
      return b
    } finally {
      this._flushing = false
    }
  }

  async close () {
    clearInterval(this._timer)
    await this.follower.close()
  }
}

// checks a published batch: the operator's signature, the root it rebuilds,
// and the root anchored on the registry. { ok, reason }
export async function checkBatch (registry, b) {
  const root = merkleRoot(b.leaves.map(leafOf))
  if (root !== b.root) return { ok: false, reason: 'leaves do not make the root' }
  const statement = await registry.anchorStatement(b.operator, b.batch, b.root, b.count)
  if (verifyMessage(getBytes(statement), b.signature) !== b.operator) return { ok: false, reason: 'not signed by the operator' }
  const anchored = await registry.anchors(b.operator, b.batch)
  if (anchored !== b.root) return { ok: false, reason: 'not the anchored root' }
  return { ok: true }
}

// one message's verdict in a batch, with its proof against the root
export function verdictOf (b, device, seq, topic) {
  const i = b.leaves.findIndex((l) => l.device === device && l.seq === String(seq) && (!topic || l.topic === topic))
  if (i < 0) return null
  const leaves = b.leaves.map(leafOf)
  const proof = merkleProof(leaves, i)
  return { leaf: b.leaves[i], proof, ok: verifyProof(leaves[i], proof, b.root) }
}

// re-checks the verdicts of the messages we hold ourselves: the ones that differ
export function auditBatch (b, messages) {
  const wrong = []
  const last = new Map()
  for (const leaf of b.leaves) {
    const m = messages.get(leaf.device + ':' + leaf.seq + ':' + leaf.topic)
    if (!m) continue
    if (!last.has(leaf.device)) last.set(leaf.device, new Map())
    const mine = judgeMessage(leaf.device, m.topic, m.payload, last.get(leaf.device))
    // a replay depends on what came before the batch: compare the rest
    const mask = ~VERDICT.REPLAY
    if ((mine.verdict & mask) !== (leaf.verdict & mask) || mine.payloadHash !== leaf.payloadHash) wrong.push({ leaf, expected: mine.verdict })
  }
  return wrong
}
