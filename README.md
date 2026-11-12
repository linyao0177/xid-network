# xid network

**An open network for connected devices.** Devices sign everything they send. Independent nodes, run by anyone who puts up a stake, carry that data, store it, check it and bill it. A contract pays them only when enough of them agree, so nobody in the middle has to be trusted.

- **Try it:** the [public testnet](https://iot.xid.network/network/) runs four nodes (US, EU, Taiwan, Japan) with contracts on Arc testnet. Flash an ESP32-C3 from the browser, run simulated devices, or run a node: [docs](https://iot.xid.network/docs/#testnet).
- **Read about it:** [iot.xid.network](https://iot.xid.network/) and the [docs](https://iot.xid.network/docs/).

> **Status: testnet.** The contracts have not been audited. See [Status](https://iot.xid.network/docs/#status) for what works and what does not yet.

## In five minutes, without a board

```bash
npm install -g https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz
boat-sim --testnet --devices 3
```

Three simulated meters sign readings, the testnet sponsors verify and store jobs on them, and the four public nodes settle the work on chain. Watch them on the [testnet page](https://iot.xid.network/network/).

## What is here

| Path | What it is |
| --- | --- |
| [`packages/boat-registry`](packages/boat-registry) | The contracts (registry: stake, jobs, Merkle-batch settlement, slashing; paid reads) and `boat-node`, the node: forward, store, verify and compute roles, the watchtower, the node list. Also `boat-sim`, `boat-deploy`, `boat-post-jobs` and the testnet hub |
| [`packages/xid-depin`](packages/xid-depin) | A DePIN toolkit: reward curves, proof of location and proof of coverage as templates (weather, air quality, energy). A network is a contract and a job: the registry's compute nodes are its oracles, score each epoch and settle the rewards root |
| [`packages/boat-mqtt-node`](packages/boat-mqtt-node) | MQTT over HyperDHT: the broker nodes run, signed messages, receipts, storage on Hypercore, sealed readings; `boat-watch` and `boat-read-store` for apps |
| [`components/boat_device`](components/boat_device) | ESP-IDF component: a device on the network in a few calls (signed and sealed readings, receipts checked on the device, node list from trusted verifiers) |
| [`components/boat_depin`](components/boat_depin) | ESP-IDF component: a device of a DePIN network (join record, pongs for proof of location, readings, ESP-NOW beacons and witness reports) |
| [`components/boat_wifi`](components/boat_wifi) | Wi-Fi from NVS, set over Improv by the browser installer or on the console |
| [`examples/boat_device_min`](examples/boat_device_min) | The smallest device; its release image joins the public testnet |
| [`examples/depin_station`](examples/depin_station) | A station of a DePIN network: `xid-depin station` enrolls it and prints the line that sets it up |
| [`examples/mqtt_p2p`](examples/mqtt_p2p) | A meter and command target over MQTT on HyperDHT |
| [`site`](site) | iot.xid.network: the landing page, the docs, the testnet page and its API (Cloudflare Workers + D1) |
| [`tools/release`](tools/release) | Release builds: firmware images with ESP Web Tools manifests, node tarballs, checksums |
| [`third_party/hyperdht-esp32`](https://github.com/linyao0177/hyperdht-esp32) | Submodule: HyperDHT in C for the ESP32-C3, MQTT over it (`hdht_mqtt`), the `uart_module` firmware, and two packages the nodes use: `boat-peer` (a device owner's channel) and `boat-ota` (Hypercore firmware and proofs) |

## Building from source

```bash
git clone --recursive https://github.com/linyao0177/xid-network.git
cd xid-network
npm run setup && npm test                            # Node.js 20+; anvil (Foundry) for the chain tests
npm run test:sol                                     # the contracts' own tests (forge)
cd examples/boat_device_min && idf.py build          # ESP-IDF 5.5
```

`npm run setup` installs the three node packages and the two they use from the submodule, in order (`npm install` in one package alone does not install what the packages it links to need). Wi-Fi for developer builds comes from a gitignored `sdkconfig.wifi` at the repository root (copy `third_party/hyperdht-esp32/sdkconfig.wifi.example`); release builds carry none and take it over Improv. `tools/release/release.sh https://iot.xid.network/dl/node` builds what the site serves.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately ([SECURITY.md](SECURITY.md)).

## License

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright (c) 2026 Leo Lin.
