// boat_device: an ESP32 device on the BoAT network in a few calls.
//
//   // after Wi-Fi is up
//   boat_device_config_t cfg = {
//     .nvs_namespace = "my_dev",
//     .verifiers = CONFIG_MY_VERIFIERS,  // the node list; NULL: look up `network`
//     .on_message = on_message,          // what others send to the device
//   };
//   boat_device_start(&cfg);
//   ...
//   boat_device_publish("telemetry", json, len);         // signed
//   boat_device_publish_sealed("telemetry", json, len);  // signed, readable by its readers only
//
// What it does for the device:
// - Identity: an Ed25519 key pair from a seed in NVS (made on first boot).
//   The public key is its address on HyperDHT, its MQTT identity and its DID
//   (did:mw:<key>), and only it may publish under d/<key>/.
// - Nodes: the staked nodes a quorum of its trusted verifiers lists
//   (components/hdht_mqtt node list), else the nodes announced under
//   `network`; it moves to another when one goes away, and names the node it
//   is on in its DID record so apps and nodes find it. With `node`, it dials
//   that one first when it is among them (one near it: short round trips).
// - Messages: every publish is signed (hdht_mqtt_sign), with a sequence
//   number that rises across reboots (a boot counter in NVS), so anyone
//   checks it whatever node it came through.
// - Inbox: what others publish to d/<them>/to/<device>/<what>, handed to
//   on_message with the sender's key, which the node checked.
// - Receipts: the node's signed word on what it got, checked on the device.
// - Sealed readings (boat_seal.h): with readers set, the data key is sealed
//   to each and published at d/<key>/keys/<id>, a new one every boot and
//   every 1000 sealed messages.
//
// Threads: hdht runs on a task of its own; the calls here may be made from
// any other task (they queue for esp-mqtt), not from on_message.

#ifndef BOAT_DEVICE_H
#define BOAT_DEVICE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "boat_seal.h"

typedef void (*boat_device_message_cb)(const char *from_hex, const char *what, const uint8_t *data, size_t len, void *ctx);

typedef struct {
  const char *nvs_namespace;     // seed, boot counter, record seq, trusted verifiers (max 15 chars)
  const char *network;           // network name to look up without a node list; default "boat-mqtt"
  const char *verifiers;         // comma-separated verify keys (hex), or NULL
  const char *node;              // a node to dial first when listed (hex key), or NULL
  const char *readers;           // comma-separated Ed25519 keys (hex) that may read sealed readings, or NULL
  boat_device_message_cb on_message;
  void (*on_connected)(const char *node_hex, void *ctx);
  void *ctx;
  uint32_t hdht_stack;           // default 20480
} boat_device_config_t;

esp_err_t
boat_device_start (const boat_device_config_t *cfg);

// The device's public key in hex (64 characters), once started.
const char *
boat_device_key (void);

bool
boat_device_connected (void);

// Signed, QoS 1, to d/<key>/<name>. ESP_ERR_INVALID_STATE while not connected.
esp_err_t
boat_device_publish (const char *name, const void *data, size_t len);

// The same, retained: the node keeps the last one for later subscribers
// (a record of what the device is, such as a DePIN join record).
esp_err_t
boat_device_publish_retained (const char *name, const void *data, size_t len);

// Sealed to the readers, then signed. ESP_ERR_INVALID_STATE without readers.
esp_err_t
boat_device_publish_sealed (const char *name, const void *data, size_t len);

// To d/<key>/to/<recipient>/<what> (not signed: the node checks the sender).
esp_err_t
boat_device_send (const char *recipient_hex, const char *what, const void *data, size_t len);

// An Ed25519 signature by the device's key over msg (64 bytes into sig),
// for what it proves outside MQTT: a DePIN beacon over the radio, say.
esp_err_t
boat_device_sign (const void *msg, size_t len, uint8_t sig[64]);

typedef struct {
  uint32_t published;    // signed messages esp-mqtt took this boot
  uint32_t receipts_ok;  // receipts that checked out
  uint32_t receipts_bad;
  uint32_t connects;
} boat_device_stats_t;

void
boat_device_get_stats (boat_device_stats_t *out);

#endif
