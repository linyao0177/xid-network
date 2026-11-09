// A Merkle tree of keccak256 leaves, sorted pairs (as OpenZeppelin's
// MerkleProof), so a contract can check an inclusion proof too.

import { keccak256, concat, getBytes } from 'ethers'

const pair = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])))

export function merkleRoot (leaves) {
  if (leaves.length === 0) return '0x' + '00'.repeat(32)
  let level = leaves.slice()
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i])
    level = next
  }
  return level[0]
}

export function merkleProof (leaves, index) {
  const proof = []
  let level = leaves.slice()
  let i = index
  while (level.length > 1) {
    const sib = i ^ 1
    if (sib < level.length) proof.push(level[sib])
    const next = []
    for (let k = 0; k < level.length; k += 2) next.push(k + 1 < level.length ? pair(level[k], level[k + 1]) : level[k])
    level = next
    i = i >> 1
  }
  return proof
}

export function verifyProof (leaf, proof, root) {
  let h = leaf
  for (const p of proof) h = pair(h, p)
  return h === root
}

export const bytes32 = (b) => '0x' + Buffer.from(getBytes(b)).toString('hex')
