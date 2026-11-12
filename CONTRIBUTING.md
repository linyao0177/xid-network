# Contributing

Thanks for helping. This repository has four parts, and each has its own tests:

| Part | Where | Tests |
| --- | --- | --- |
| Contracts and the node | `packages/boat-registry` | `npm test` (needs `anvil` from Foundry); `forge test` for the contracts' invariants |
| The DePIN toolkit | `packages/xid-depin` | `npm test`; `forge test` for its contracts |
| MQTT over HyperDHT, storage, clients | `packages/boat-mqtt-node` | `npm test` |
| Device components and firmware | `components/`, `examples/` (ESP-IDF 5.5) | `idf.py build`; on a board, the docs' [Quick Start](https://iot.xid.network/docs/#quick-start) step 10 |

HyperDHT in C, `hdht_mqtt`, `uart_module`, `boat-peer` and `boat-ota` live in [hyperdht-esp32](https://github.com/linyao0177/hyperdht-esp32) (the `third_party/hyperdht-esp32` submodule); changes to them go there.

Once after cloning, at the repository root: `npm run setup` (it installs every node package in the order they depend on each other). `npm test` there runs all three node packages' tests, `npm run test:sol` the contracts'. CI (`.github/workflows/ci.yml`) runs the same on every pull request.

## Before you send a pull request

- Run the tests of what you touched.
- One change per pull request, with what it changes and how you tested it (on a board, locally, on the public testnet).
- Never commit `sdkconfig`, `sdkconfig.wifi`, key files (`*.key`, `seed`, `operator.key`, `*.pem`) or anything with a password in it. `.gitignore` covers the usual ones.
- Code style: what the file around it does. C follows ESP-IDF's; JavaScript is [standard](https://standardjs.com) style without a build step.
- A contract change needs a test of the attack it closes or the case it adds, in `test/` or `test/sol/`.

## Good first contributions

- Run a node on the [public testnet](https://iot.xid.network/docs/#testnet) and report what breaks.
- Try `boat_device_min` on other ESP32-C3 boards.
- Compute rules: WASM rules besides `rules/energy-bill.wat`.

## Questions and bugs

Open an issue with what you ran, what you expected and what happened: for a device, the firmware version and `boat show`; for a node, `boat-node status` and the last lines of `journalctl -u boat-node`. Leave out keys, seeds and Wi-Fi passwords.

Security problems: see [SECURITY.md](SECURITY.md), not an issue.

## License

By contributing you agree that your contribution is licensed under the license of the part you change: MIT (see [LICENSE](LICENSE)).
