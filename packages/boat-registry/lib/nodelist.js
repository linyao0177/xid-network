// Node cards and the node list devices pick their node from.
//
// Card: a node's HyperDHT record under the key it registered with (its
// forwarding key), JSON signed by that key like any HyperDHT mutable record:
//
//   { "v": 1, "boat_node": "1", "chain": "<id>", "registry": "0x..",
//     "operator": "0x..", "roles": <bits>, "store": "<hex>", "verify": "<hex>",
//     "work": "<hex>" }
//
// naming the keys of its other roles (a store, a verifier and its work run
// under keys of their own, derived from the node's seed).
//
// Node list: every verifier puts, under its verify key,
//
//   { "v": 1, "boat_nodes": "<base64 of the main part>" }
//
//   main  'BNL2' | chain id u64 BE | registry 20 bytes | epoch u64 BE
//         | n verifiers u8 (<= 10) | n x 32 bytes
//         | n nodes u16 BE | n pages u8 (<= 8) | n x 32-byte page hash
//   page  'BNP1' | n u8 (<= 28) | n x 32 bytes, an immutable HyperDHT record
//         (stored under its BLAKE2b-256 hash)
//
// the forwarding nodes active on the registry, most stake (own and
// delegated) first, 28 to a page, and the verify keys of the 10 verifiers
// with the most stake. Every verifier that sees the same registry puts out
// the same bytes, and the pages are the same records for all of them.
//
// A device that trusts a set of verify keys takes the main part a quorum of
// them put out byte for byte (2 of 3: ceil(2n/3), n when n <= 2), newest
// epoch first, then reads one page, chosen by its own key so that devices
// spread over the nodes, and checks it against the hash. It needs no chain,
// and one verifier alone cannot steer it. When the list names other
// verifiers, it trusts those from then on (components/hdht_mqtt nodelist.c
// does the same in C).

import crypto from 'crypto'
import sodium from 'sodium-universal'
import HyperDHT from 'hyperdht'
import { ROLES } from './registry.js'

const MAIN = Buffer.from('BNL2')
const PAGE = Buffer.from('BNP1')
export const MAX_VERIFIERS = 10
export const PAGE_SIZE = 28
export const MAX_PAGES = 8

export const hex = (k) => (typeof k === 'string' ? k.replace(/^0x/, '').toLowerCase() : Buffer.from(k).toString('hex'))

// a key pair of the node's own, for one role: BLAKE2b-256(name, key = seed)
export function roleKeyPair (seed, name) {
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, Buffer.from('boat-node/' + name), seed)
  return HyperDHT.keyPair(out)
}

export async function putRecord (dht, keyPair, value, state = {}) {
  const seq = Math.max(Math.floor(Date.now() / 1000), (state.seq || 0) + 1)
  state.seq = seq
  await dht.mutablePut(keyPair, Buffer.from(JSON.stringify(value)), { seq })
  return seq
}

export async function getRecord (dht, key) {
  const res = await dht.mutableGet(Buffer.from(hex(key), 'hex'), { latest: true }).catch(() => null)
  if (!res) return null
  try { return JSON.parse(res.value.toString()) } catch { return null }
}

export async function readCard (dht, key) {
  const c = await getRecord(dht, key)
  return c && c.boat_node ? c : null
}

// ---- the list -----------------------------------------------------------------

const blake = (b) => {
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, b)
  return out
}

export function encodePage (keys) {
  if (keys.length > PAGE_SIZE) throw new Error('page too long')
  return Buffer.concat([PAGE, Buffer.from([keys.length]), ...keys.map((k) => Buffer.from(hex(k), 'hex'))])
}

export function decodePage (b) {
  if (!b || b.length < 5 || !b.subarray(0, 4).equals(PAGE) || b.length !== 5 + 32 * b[4]) return null
  return Array.from({ length: b[4] }, (_, i) => b.subarray(5 + 32 * i, 37 + 32 * i).toString('hex'))
}

// list: { chainId, registry, epoch, verifiers, nodes } -> { main, pages }
export function encodeNodeList ({ chainId, registry, epoch, verifiers, nodes }) {
  if (verifiers.length > MAX_VERIFIERS) throw new Error('too many verifiers')
  if (nodes.length > PAGE_SIZE * MAX_PAGES) throw new Error('too many nodes')
  const pages = []
  for (let i = 0; i < nodes.length; i += PAGE_SIZE) pages.push(encodePage(nodes.slice(i, i + PAGE_SIZE)))
  const main = Buffer.alloc(4 + 8 + 20 + 8 + 1 + 32 * verifiers.length + 2 + 1 + 32 * pages.length)
  let o = MAIN.copy(main, 0)
  main.writeBigUInt64BE(BigInt(chainId), o); o += 8
  o += Buffer.from(hex(registry), 'hex').copy(main, o)
  main.writeBigUInt64BE(BigInt(epoch), o); o += 8
  main[o++] = verifiers.length
  for (const k of verifiers) o += Buffer.from(hex(k), 'hex').copy(main, o)
  main.writeUInt16BE(nodes.length, o); o += 2
  main[o++] = pages.length
  for (const p of pages) o += blake(p).copy(main, o)
  return { main, pages }
}

export function decodeNodeList (b) {
  if (!b || b.length < 44 || !b.subarray(0, 4).equals(MAIN)) return null
  let o = 4
  const chainId = b.readBigUInt64BE(o); o += 8
  const registry = '0x' + b.subarray(o, o + 20).toString('hex'); o += 20
  const epoch = b.readBigUInt64BE(o); o += 8
  const nv = b[o++]
  if (nv > MAX_VERIFIERS || b.length < o + 32 * nv + 3) return null
  const verifiers = []
  for (let i = 0; i < nv; i++, o += 32) verifiers.push(b.subarray(o, o + 32).toString('hex'))
  const total = b.readUInt16BE(o); o += 2
  const np = b[o++]
  if (np > MAX_PAGES || b.length !== o + 32 * np || Math.ceil(total / PAGE_SIZE) !== np) return null
  const pages = []
  for (let i = 0; i < np; i++, o += 32) pages.push(b.subarray(o, o + 32).toString('hex'))
  return { chainId, registry, epoch, verifiers, total, pages }
}

// the list as this verifier sees the registry now
export async function buildNodeList (registry, dht) {
  const [count, minStake, epoch, network] = await Promise.all([registry.operatorCount(), registry.minStake(), registry.epoch(), registry.runner.provider.getNetwork()])
  const forward = []
  const verifiers = []
  for (let i = 0n; i < count; i++) {
    const op = await registry.operators(i)
    const n = await registry.nodes(op)
    if (!n.active || n.stake < minStake) continue
    const key = n.dhtKey.slice(2)
    const stake = await registry.totalStake(op)
    const roles = Number(n.roles)
    if (roles & ROLES.FORWARD) forward.push({ key, stake })
    if (roles & ROLES.VERIFY) {
      const card = await readCard(dht, key)
      if (card && /^[0-9a-f]{64}$/.test(card.verify || '') && card.operator === op) verifiers.push({ key: card.verify, stake })
    }
  }
  const byStake = (a, b) => (a.stake === b.stake ? (a.key < b.key ? -1 : 1) : a.stake > b.stake ? -1 : 1)
  forward.sort(byStake)
  verifiers.sort(byStake)
  return {
    chainId: network.chainId,
    registry: await registry.getAddress(),
    epoch,
    verifiers: verifiers.slice(0, MAX_VERIFIERS).map((v) => v.key).sort(),
    nodes: forward.slice(0, PAGE_SIZE * MAX_PAGES).map((f) => f.key)
  }
}

// puts the pages (immutable: the same records for every verifier) and the
// main part; pages are put again every refreshMs (they expire on the DHT)
export async function publishNodeList (dht, verifyKeyPair, list, state = {}, { refreshMs = 6 * 3600 * 1000 } = {}) {
  const { main, pages } = encodeNodeList(list)
  const stale = !state.at || Date.now() - state.at > refreshMs
  if (state.main && state.main.equals(main) && !stale) return false
  for (const p of pages) await dht.immutablePut(p)
  await putRecord(dht, verifyKeyPair, { v: 1, boat_nodes: main.toString('base64') }, state)
  state.main = main
  state.at = Date.now()
  return true
}

export const quorumOf = (n) => (n <= 2 ? n : Math.ceil((2 * n) / 3))

// the main part a quorum of the trusted verify keys agrees on, and one page
// of it (by `pick`, or every page with all: true): { list, votes, quorum, main }
export async function readNodeList (dht, trusted, { pick = 0, all = false } = {}) {
  const records = await Promise.all(trusted.map((k) => getRecord(dht, k)))
  const t = tally(records.map((r) => (r && typeof r.boat_nodes === 'string' ? Buffer.from(r.boat_nodes, 'base64') : null)), trusted.length)
  if (!t) return null
  const wanted = t.list.pages.length === 0 ? [] : all ? t.list.pages.map((_, i) => i) : [pick % t.list.pages.length]
  const nodes = []
  for (const i of wanted) {
    const keys = await readPage(dht, t.list.pages[i])
    if (!keys) return null
    nodes.push(...keys)
  }
  return { ...t, list: { ...t.list, nodes, page: all ? null : wanted[0] ?? null } }
}

export async function readPage (dht, hash) {
  const res = await dht.immutableGet(Buffer.from(hash, 'hex')).catch(() => null)
  return res ? decodePage(res.value) : null
}

export function tally (blobs, trustedCount) {
  const votes = new Map()
  for (const b of blobs) {
    if (!b || !decodeNodeList(b)) continue
    const h = crypto.createHash('sha256').update(b).digest('hex')
    if (!votes.has(h)) votes.set(h, { blob: b, n: 0 })
    votes.get(h).n++
  }
  const quorum = quorumOf(trustedCount)
  const agreed = [...votes.values()].filter((v) => v.n >= quorum).map((v) => ({ ...v, list: decodeNodeList(v.blob) }))
  agreed.sort((a, b) => (a.list.epoch > b.list.epoch ? -1 : a.list.epoch < b.list.epoch ? 1 : b.n - a.n))
  return agreed.length ? { list: agreed[0].list, votes: agreed[0].n, quorum, main: agreed[0].blob } : null
}
