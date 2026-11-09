// boat_seal: telemetry only its readers can read, and the network can still
// check. Plain C over libsodium, also built on the desktop (test/test_seal.c);
// packages/boat-mqtt-node lib/sealed.js is the same in JS.
//
// A device encrypts its readings with a data key (XChaCha20-Poly1305, the
// topic as associated data) and puts that key, sealed to each reader, in a
// key envelope it publishes at d/<device>/keys/<key id>. Readers are Ed25519
// public keys (an owner's, a compute node's work key): the key is sealed to
// their X25519 form (crypto_box_seal). Both are then signed like any message
// (hdht_mqtt_sign), so verifiers and stores check and keep them without
// reading them.
//
//   sealed reading  'E' 0x01 | key id u32 BE | nonce 24 | ciphertext + tag 16
//   key envelope    'K' 0x01 | key id u32 BE | n u8 | n x (reader 32 | sealed key 80)

#ifndef BOAT_SEAL_H
#define BOAT_SEAL_H

#include <stddef.h>
#include <stdint.h>

#define BOAT_SEAL_OVERHEAD (2 + 4 + 24 + 16)
#define BOAT_SEAL_MAX_READERS 8
#define BOAT_SEAL_ENVELOPE_SIZE(n) (7 + (n) * (32 + 32 + 48))

// The envelope for key_id: returns its length, or -1.
int
boat_seal_envelope (uint32_t key_id, const uint8_t data_key[32], const uint8_t (*readers)[32], size_t n, uint8_t *out, size_t cap);

// The data key in an envelope, for a reader with this Ed25519 key pair: 0, or -1.
int
boat_seal_open_envelope (const uint8_t *env, size_t len, const uint8_t ed25519_pk[32], const uint8_t ed25519_sk[64], uint32_t *key_id, uint8_t data_key[32]);

// A sealed reading: returns its length, or -1.
int
boat_seal_encrypt (const uint8_t data_key[32], uint32_t key_id, const char *topic, const uint8_t *plain, size_t len, uint8_t *out, size_t cap);

// Opens a sealed reading with the key of its key id: the plaintext length, or -1.
int
boat_seal_decrypt (const uint8_t data_key[32], const char *topic, const uint8_t *sealed, size_t len, uint8_t *out, size_t cap);

// The key id of a sealed reading, or -1 when it is not one.
int64_t
boat_seal_key_id (const uint8_t *sealed, size_t len);

#endif
