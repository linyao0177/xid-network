// Desktop check of boat_seal against the JS (packages/boat-mqtt-node
// test/run.js builds and drives it).
//   test_seal envelope <key id> <data key hex> <reader pk hex>...  -> envelope hex
//   test_seal open <envelope hex> <reader seed hex>                -> "<key id> <data key hex>" or "NONE"
//   test_seal encrypt <data key hex> <key id> <topic> <text>       -> sealed hex
//   test_seal decrypt <data key hex> <topic> <sealed hex>          -> text or "BAD"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sodium.h>

#include "boat_seal.h"

static size_t
hex (const char *h, uint8_t *out, size_t cap) {
  size_t len = 0;
  sodium_hex2bin(out, cap, h, strlen(h), NULL, &len, NULL);
  return len;
}

static void
print_hex (const uint8_t *b, size_t n) {
  for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
  printf("\n");
}

int
main (int argc, char **argv) {
  if (sodium_init() < 0 || argc < 3) return 2;
  static uint8_t buf[4096], out[4096];
  if (strcmp(argv[1], "envelope") == 0) {
    uint8_t key[32], readers[8][32];
    hex(argv[3], key, 32);
    size_t n = (size_t) argc - 4;
    for (size_t i = 0; i < n; i++) hex(argv[4 + i], readers[i], 32);
    int len = boat_seal_envelope((uint32_t) strtoul(argv[2], NULL, 10), key, (const uint8_t (*)[32]) readers, n, out, sizeof(out));
    if (len < 0) return 1;
    print_hex(out, (size_t) len);
  } else if (strcmp(argv[1], "open") == 0) {
    size_t len = hex(argv[2], buf, sizeof(buf));
    uint8_t seed[32], pk[32], sk[64], key[32];
    uint32_t id;
    hex(argv[3], seed, 32);
    crypto_sign_seed_keypair(pk, sk, seed);
    if (boat_seal_open_envelope(buf, len, pk, sk, &id, key) != 0) { printf("NONE\n"); return 0; }
    printf("%u ", (unsigned) id);
    print_hex(key, 32);
  } else if (strcmp(argv[1], "encrypt") == 0) {
    uint8_t key[32];
    hex(argv[2], key, 32);
    int len = boat_seal_encrypt(key, (uint32_t) strtoul(argv[3], NULL, 10), argv[4], (const uint8_t *) argv[5], strlen(argv[5]), out, sizeof(out));
    if (len < 0) return 1;
    print_hex(out, (size_t) len);
  } else if (strcmp(argv[1], "decrypt") == 0) {
    uint8_t key[32];
    hex(argv[2], key, 32);
    size_t len = hex(argv[4], buf, sizeof(buf));
    int n = boat_seal_decrypt(key, argv[3], buf, len, out, sizeof(out));
    if (n < 0) { printf("BAD\n"); return 0; }
    printf("%.*s\n", n, out);
  }
  return 0;
}
