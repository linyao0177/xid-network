// boat_seal (see include/boat_seal.h)

#include <string.h>
#include <sodium.h>

#include "boat_seal.h"

static void
be32 (uint8_t *p, uint32_t v) {
  p[0] = (uint8_t) (v >> 24);
  p[1] = (uint8_t) (v >> 16);
  p[2] = (uint8_t) (v >> 8);
  p[3] = (uint8_t) v;
}

static uint32_t
rd32 (const uint8_t *p) {
  return ((uint32_t) p[0] << 24) | ((uint32_t) p[1] << 16) | ((uint32_t) p[2] << 8) | p[3];
}

int
boat_seal_envelope (uint32_t key_id, const uint8_t data_key[32], const uint8_t (*readers)[32], size_t n, uint8_t *out, size_t cap) {
  if (n == 0 || n > BOAT_SEAL_MAX_READERS || cap < BOAT_SEAL_ENVELOPE_SIZE(n)) return -1;
  out[0] = 'K';
  out[1] = 1;
  be32(out + 2, key_id);
  out[6] = (uint8_t) n;
  uint8_t *p = out + 7;
  for (size_t i = 0; i < n; i++) {
    uint8_t x25519[32];
    if (crypto_sign_ed25519_pk_to_curve25519(x25519, readers[i]) != 0) return -1;
    memcpy(p, readers[i], 32);
    if (crypto_box_seal(p + 32, data_key, 32, x25519) != 0) return -1;
    p += 32 + 32 + crypto_box_SEALBYTES;
  }
  return (int) (p - out);
}

int
boat_seal_open_envelope (const uint8_t *env, size_t len, const uint8_t ed25519_pk[32], const uint8_t ed25519_sk[64], uint32_t *key_id, uint8_t data_key[32]) {
  if (len < 7 || env[0] != 'K' || env[1] != 1) return -1;
  size_t n = env[6];
  if (n > BOAT_SEAL_MAX_READERS || len != BOAT_SEAL_ENVELOPE_SIZE(n)) return -1;
  uint8_t x_pk[32], x_sk[32];
  if (crypto_sign_ed25519_pk_to_curve25519(x_pk, ed25519_pk) != 0) return -1;
  crypto_sign_ed25519_sk_to_curve25519(x_sk, ed25519_sk);
  int found = -1;
  const uint8_t *p = env + 7;
  for (size_t i = 0; i < n && found != 0; i++, p += 32 + 32 + crypto_box_SEALBYTES) {
    if (memcmp(p, ed25519_pk, 32) != 0) continue;
    found = crypto_box_seal_open(data_key, p + 32, 32 + crypto_box_SEALBYTES, x_pk, x_sk);
  }
  sodium_memzero(x_sk, sizeof(x_sk));
  if (found != 0) return -1;
  *key_id = rd32(env + 2);
  return 0;
}

int
boat_seal_encrypt (const uint8_t data_key[32], uint32_t key_id, const char *topic, const uint8_t *plain, size_t len, uint8_t *out, size_t cap) {
  if (cap < len + BOAT_SEAL_OVERHEAD) return -1;
  out[0] = 'E';
  out[1] = 1;
  be32(out + 2, key_id);
  randombytes_buf(out + 6, 24);
  unsigned long long clen = 0;
  if (crypto_aead_xchacha20poly1305_ietf_encrypt(out + 30, &clen, plain, len, (const uint8_t *) topic, strlen(topic), NULL, out + 6, data_key) != 0) return -1;
  return (int) (30 + clen);
}

int
boat_seal_decrypt (const uint8_t data_key[32], const char *topic, const uint8_t *sealed, size_t len, uint8_t *out, size_t cap) {
  if (len < BOAT_SEAL_OVERHEAD || sealed[0] != 'E' || sealed[1] != 1 || cap < len - BOAT_SEAL_OVERHEAD) return -1;
  unsigned long long plen = 0;
  if (crypto_aead_xchacha20poly1305_ietf_decrypt(out, &plen, NULL, sealed + 30, len - 30, (const uint8_t *) topic, strlen(topic), sealed + 6, data_key) != 0) return -1;
  return (int) plen;
}

int64_t
boat_seal_key_id (const uint8_t *sealed, size_t len) {
  if (len < BOAT_SEAL_OVERHEAD || sealed[0] != 'E' || sealed[1] != 1) return -1;
  return rd32(sealed + 2);
}
