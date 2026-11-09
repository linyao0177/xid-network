# boat_device_min

The smallest device on the BoAT network, built on [`components/boat_device`](../../components/boat_device): connect to Wi-Fi, call `boat_device_start` once, then `boat_device_publish` (signed) or `boat_device_publish_sealed` (signed, readable only by its readers).

- `CONFIG_BOAT_VERIFIERS`: the verify keys of the verifiers the device trusts for the node list. Empty: it looks up the network name `boat-mqtt`.
- `CONFIG_BOAT_READERS`: the Ed25519 keys that may read its readings, such as the owner and compute nodes' work keys. Empty: readings are signed, not sealed.
- `CONFIG_BOAT_INTERVAL`: seconds between readings.

```sh
idf.py build flash monitor
```

It prints `BOAT|device <key>`, then one line per reading with the receipts the node sent so far.
