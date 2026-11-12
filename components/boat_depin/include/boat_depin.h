// boat_depin: a device of a DePIN network on the xid network
// (packages/xid-depin), on top of components/boat_device.
//
//   // after boat_device_start, once the clock is set (SNTP)
//   boat_depin_config_t d = {
//     .net = "<network key hex>",       // xid-depin station prints these
//     .cell = "<H3 cell>",
//     .payee = "0x...",
//     .topic = "weather",
//     .start = 1794412800, .slot_seconds = 300,
//     .beacons = true,
//   };
//   boat_depin_start(&d);
//   // in boat_device's on_message and on_connected:
//   if (boat_depin_message(from, what, data, len)) return;
//   boat_depin_connected();
//   // the readings, as JSON members (integers, the network's fields):
//   boat_depin_reading("\"t\":215,\"h\":640,\"p\":10132");
//
// What it does for the device (the same as xid-depin's DepinDevice in JS):
// - Join record: { v, net, cell, payee, rated? }, signed and retained at
//   d/<device>/depin/<net>/join, on every connect and every half hour.
// - Pongs: an oracle's ping (d/<oracle>/to/<device>/depin-ping { net, nonce })
//   is answered at once with a signed d/<device>/depin/<net>/pong { v, nonce };
//   its round trip bounds where the device can be (proof of location).
// - Readings: the fields plus ts (unix seconds) at d/<device>/<topic>.
// - Beacons (proof of coverage), with .beacons: once a slot, an ESP-NOW
//   broadcast of the device's key, the slot and its Ed25519 signature over
//   "xid-depin-beacon/1" 0 | net | device | slot (8 bytes, big-endian), sent
//   on the Wi-Fi channel it is on. It verifies the beacons it hears and,
//   when the slot is over, reports them with their RSSI at
//   d/<device>/depin/<net>/witness { v, slot, heard: [{ from, slot, sig, rssi }] }.
//
// Slots are counted from the network's start: slot = (now - start) / slot_seconds,
// so the clock must be right (SNTP). Wi-Fi must stay awake to hear beacons
// (esp_wifi_set_ps(WIFI_PS_NONE)).

#ifndef BOAT_DEPIN_H
#define BOAT_DEPIN_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
  const char *net;         // the network's key: 64 hex characters
  const char *cell;        // where the device is: an H3 cell at the network's resolution (hex)
  const char *payee;       // who is paid for it: 0x and 40 hex characters
  const char *topic;       // the readings' topic (the network's config: readings.topic)
  int64_t start;           // the network's start (unix seconds)
  uint32_t slot_seconds;   // epoch length / slots
  uint32_t rated;          // energy networks: the rated power in W; 0: none
  bool beacons;            // ESP-NOW beacons and witness reports
} boat_depin_config_t;

esp_err_t
boat_depin_start (const boat_depin_config_t *cfg);

// From boat_device's on_message: true when it was for the network (a ping).
bool
boat_depin_message (const char *from_hex, const char *what, const uint8_t *data, size_t len);

// From boat_device's on_connected: the join record again.
void
boat_depin_connected (void);

// A reading: JSON members without braces; ts is added. Not from on_message.
esp_err_t
boat_depin_reading (const char *members);

// The slot now (-1 before the start, or while the clock is not set).
int64_t
boat_depin_slot (void);

// The beacon it sends in the slot now, as a witness reports it:
// {"from":"..","slot":n,"sig":".."} (a check of the radio-free part).
esp_err_t
boat_depin_beacon_json (char *out, size_t size);

typedef struct {
  uint32_t joins;
  uint32_t pongs;
  uint32_t readings;
  uint32_t beacons_sent;
  uint32_t beacons_heard;   // with a good signature
  uint32_t beacons_bad;
  uint32_t witness_reports;
} boat_depin_stats_t;

void
boat_depin_get_stats (boat_depin_stats_t *out);

#endif
