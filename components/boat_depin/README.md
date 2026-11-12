# boat_depin

An ESP32 device of a DePIN network on the xid network
([`packages/xid-depin`](../../packages/xid-depin)), on top of
[`boat_device`](../boat_device). It is what xid-depin's `DepinDevice` is in JS.

```c
// after boat_device_start, with the clock set (SNTP)
boat_depin_config_t d = {
  .net = "<network key hex>",         // `xid-depin station` prints these
  .cell = "<H3 cell>",
  .payee = "0x...",
  .topic = "weather",
  .start = 1794412800, .slot_seconds = 300,
  .beacons = true,                    // ESP-NOW beacons and witness reports
};
boat_depin_start(&d);

// in boat_device's callbacks
if (boat_depin_message(from, what, data, len)) return;   // on_message
boat_depin_connected();                                   // on_connected

// readings: the network's fields as JSON members; ts is added
boat_depin_reading("\"t\":215,\"h\":640,\"p\":10132");
```

What it does for the device:

- **Join record.** `{ v, net, cell, payee, rated? }`, signed and retained at
  `d/<device>/depin/<net>/join`, on every connect and every half hour. It
  says where the device is (an H3 cell) and who is paid for it.
- **Pongs (proof of location).** An oracle's ping,
  `d/<oracle>/to/<device>/depin-ping { net, nonce }`, is answered at once
  with a signed `d/<device>/depin/<net>/pong { v, nonce }`. Its round trip
  bounds how far the device can be from the oracle.
- **Readings.** The fields plus `ts` (unix seconds) at `d/<device>/<topic>`.
- **Beacons (proof of coverage).** Once a slot, two ESP-NOW broadcasts a
  moment apart, on the Wi-Fi channel the device is on, at an offset in the
  slot set by its key. A beacon frame is 140 bytes:
  `"XDB1" | net (32) | device (32) | slot (8, big-endian) | signature (64)`.
  The signature is Ed25519 over
  `"xid-depin-beacon/1" 0 | net | device | slot`, the same bytes
  `records.js` `beaconOk` checks.
- **Witness reports.** It checks the signature of each beacon it hears and
  keeps it with its RSSI. When the slot is over, it reports the five
  strongest at
  `d/<device>/depin/<net>/witness { v, slot, heard: [{ from, slot, sig, rssi }] }`.

Slots are counted from the network's start, `(now - start) / slot_seconds`,
so the clock must be right: run SNTP before it. Keep Wi-Fi awake
(`esp_wifi_set_ps(WIFI_PS_NONE)`), or it misses beacons between DTIM
beacons. Stations hear each other only on the same channel, which is that of
the access point each is on.

Round trips are evidence, so keep them short:
- Put the device on the network's oracle nearest to it (`boat_device`'s
  `.node`; `xid-depin station` names it). Every oracle's ping goes through
  the device's node.
- Turn off Wi-Fi A-MPDU receive (`CONFIG_ESP_WIFI_AMPDU_RX_ENABLED=n`). With
  it on, an ESP32-C3 held arriving frames for about 150 ms. Its pongs then
  took 240 ms over a 55 ms network; with it off, 77–90 ms.

`boat_depin_beacon_json` gives the beacon of the slot now as JSON, to check
the signature off the radio. See
[`examples/depin_station`](../../examples/depin_station).
