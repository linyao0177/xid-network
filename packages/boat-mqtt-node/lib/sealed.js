// Sealed telemetry (components/boat_device boat_seal.h, the same in JS):
// readings encrypted with a data key, the key sealed to each reader in a key
// envelope at d/<device>/keys/<key id>. Both are signed messages like any
// other (signed.js), so verifiers and stores check and keep them unread.
//
//   sealed reading  'E' 0x01 | key id u32 BE | nonce 24 | ciphertext + tag 16
//   key envelope    'K' 0x01 | key id u32 BE | n u8 | n x (reader 32 | sealed key 80)

import sodium from 'sodium-universal'

export const SEAL_OVERHEAD = 2 + 4 + 24 + 16

const x25519pk = (ed) => {
  const out = Buffer.alloc(32)
  sodium.crypto_sign_ed25519_pk_to_curve25519(out, ed)
  return out
}

// readers: Ed25519 public keys
export function sealEnvelope (keyId, dataKey, readers) {
  const parts = [Buffer.from([0x4b, 1, 0, 0, 0, 0, readers.length])]
  parts[0].writeUInt32BE(keyId, 2)
  for (const r of readers) {
    const sealed = Buffer.alloc(32 + sodium.crypto_box_SEALBYTES)
    sodium.crypto_box_seal(sealed, dataKey, x25519pk(Buffer.from(r)))
    parts.push(Buffer.from(r), sealed)
  }
  return Buffer.concat(parts)
}

// the data key in an envelope for this Ed25519 key pair: { keyId, key } or null
export function openEnvelope (env, keyPair) {
  if (!env || env.length < 7 || env[0] !== 0x4b || env[1] !== 1) return null
  const n = env[6]
  if (env.length !== 7 + n * (32 + 32 + 48)) return null
  const pk = x25519pk(keyPair.publicKey)
  const sk = Buffer.alloc(32)
  sodium.crypto_sign_ed25519_sk_to_curve25519(sk, keyPair.secretKey)
  for (let i = 0, o = 7; i < n; i++, o += 112) {
    if (!env.subarray(o, o + 32).equals(keyPair.publicKey)) continue
    const key = Buffer.alloc(32)
    if (sodium.crypto_box_seal_open(key, env.subarray(o + 32, o + 112), pk, sk)) return { keyId: env.readUInt32BE(2), key }
  }
  return null
}

export function encrypt (dataKey, keyId, topic, plain) {
  const nonce = Buffer.alloc(24)
  sodium.randombytes_buf(nonce)
  const c = Buffer.alloc(plain.length + 16)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(c, Buffer.from(plain), Buffer.from(topic), null, nonce, dataKey)
  const head = Buffer.from([0x45, 1, 0, 0, 0, 0])
  head.writeUInt32BE(keyId, 2)
  return Buffer.concat([head, nonce, c])
}

export const keyIdOf = (sealed) => (sealed && sealed.length >= SEAL_OVERHEAD && sealed[0] === 0x45 && sealed[1] === 1 ? sealed.readUInt32BE(2) : null)

// the plaintext, or null
export function decrypt (dataKey, topic, sealed) {
  if (keyIdOf(sealed) === null) return null
  const out = Buffer.alloc(sealed.length - SEAL_OVERHEAD)
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, null, sealed.subarray(30), Buffer.from(topic), sealed.subarray(6, 30), dataKey)
    return out
  } catch {
    return null
  }
}

// a reader's keys: envelopes it can open, by key id
export class KeyRing {
  constructor (keyPair) {
    this.keyPair = keyPair
    this.keys = new Map() // device:keyId -> key
  }

  // an envelope (the payload of a signed message at d/<device>/keys/...)
  add (device, env) {
    const o = openEnvelope(env, this.keyPair)
    if (o) this.keys.set(device + ':' + o.keyId, o.key)
    return o
  }

  // the plaintext of a sealed reading, or null
  open (device, topic, sealed) {
    const id = keyIdOf(sealed)
    const key = id === null ? null : this.keys.get(device + ':' + id)
    return key ? decrypt(key, topic, sealed) : null
  }
}
