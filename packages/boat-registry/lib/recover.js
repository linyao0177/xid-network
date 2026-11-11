// Who signed a 32-byte statement (EIP-191, as ethers' signMessage signs it).
//
// Recovering a secp256k1 signer in JS (ethers, noble) takes about 1 ms; a busy
// node does it for every unit it settles, every batch statement and every
// fault. libsecp256k1 (the secp256k1 package, prebuilt for macOS arm64, Linux
// x64 and Windows x64) takes about 0.08 ms. When the native binding cannot
// load, ethers does it, with the same answer.

import { createRequire } from 'module'
import { getBytes, hashMessage, keccak256, getAddress, verifyMessage } from 'ethers'

let native = null
try {
  const secp = createRequire(import.meta.url)('secp256k1')
  // the package falls back to a JS implementation itself when its binding is
  // missing; only use it when the binding is there
  if (secp === createRequire(import.meta.url)('secp256k1/bindings')) native = secp
} catch {}

export const nativeRecovery = native !== null

// half the curve order: a signature with s above it is the malleable twin of
// another (r, n - s, v ^ 1); the contract refuses it ("high s") and so do we,
// or anyone could swap a node's published signature for one that fails on chain
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

// the address that signed `statement` (32 bytes, hex or bytes) with `signature`
// (65 bytes, r|s|v), or null when the signature is malformed
export function recoverSigner (statement, signature) {
  try {
    const msg = getBytes(statement)
    const sig = getBytes(signature)
    if (sig.length !== 65) return null
    if (BigInt('0x' + Buffer.from(sig.subarray(32, 64)).toString('hex')) > HALF_N) return null
    if (!native) return verifyMessage(msg, signature)
    let v = sig[64]
    if (v >= 27) v -= 27
    if (v !== 0 && v !== 1) return null
    const pub = native.ecdsaRecover(sig.subarray(0, 64), v, getBytes(hashMessage(msg)), false)
    return getAddress('0x' + keccak256(pub.subarray(1)).slice(-40))
  } catch {
    return null
  }
}
