# boat_device

An ESP32 device on the BoAT network in a few calls.

```c
// after Wi-Fi is up
boat_device_config_t cfg = {
  .nvs_namespace = "my_dev",
  .verifiers = "<verify key hex>,<verify key hex>,<verify key hex>", // the node list; NULL: look up "boat-mqtt"
  .readers = "<owner key hex>",                                       // who may read sealed readings; NULL: none
  .on_message = on_message,                                           // what others send to the device
};
boat_device_start(&cfg);
boat_device_publish("telemetry", json, len);         // signed
boat_device_publish_sealed("telemetry", json, len);  // signed, and readable only by its readers
```

What it does for the device:

- **Identity.** An Ed25519 key pair from a seed in NVS, made on first boot. The public key is the device's HyperDHT address, its MQTT identity and its DID (`did:mw:<key>`).
- **Nodes.** It connects to the staked nodes that a quorum of its trusted verifiers lists ([`hdht_mqtt`](https://github.com/linyao0177/hyperdht-esp32/tree/main/components/hdht_mqtt) node list, from hyperdht-esp32), else to the nodes announced under a network name. It moves to another node when one goes away, and names the node it is on in its DID record.
- **Messages.** Every publish is signed, with a sequence number that rises across reboots (one counter for all of the device's messages).
- **Inbox.** What others publish to `d/<them>/to/<device>/<what>` reaches `on_message` with the sender's key, which the node checked.
- **Receipts.** The node's signed word on what it got is checked on the device (`boat_device_get_stats`).
- **Sealed readings** ([`include/boat_seal.h`](include/boat_seal.h)).
    - Readings are encrypted with a data key (XChaCha20-Poly1305), and the key is sealed to each reader (crypto_box_seal to the X25519 form of their Ed25519 key) in an envelope at `d/<device>/keys/<id>`.
    - A new key comes every boot and every 1,000 sealed messages.
    - Verifiers and stores check and keep the ciphertext without reading it.
    - `packages/boat-mqtt-node` `lib/sealed.js` is the same in JS, and `test/sealed.js` checks one against the other.

Threads: hdht runs on a task of its own. Call the publish and send functions from any other task, never from `on_message`.

See [`examples/boat_device_min`](../../examples/boat_device_min).
