# mqtt_p2p: esp-mqtt over HyperDHT

An ESP32 device on a network of MQTT nodes that anyone can run ([`packages/boat-mqtt-node`](../../packages/boat-mqtt-node)). The firmware uses ESP-IDF's esp-mqtt unchanged. [`components/hdht_mqtt`](../../components/hdht_mqtt) gives it a transport that looks the network up on HyperDHT and dials a node by public key.

- **No broker address, password or certificate on the device.** The device knows only a network name (`CONFIG_MQTT_P2P_NODE`, default `boat-mqtt`) or a node's key. The node knows the device by the key it proved in the Noise handshake.
- **Identity**: a seed kept in NVS. The public key is the MQTT client id, and only this device may publish under `d/<its key>/`.
- **Telemetry**: `d/<key>/telemetry` every `CONFIG_MQTT_P2P_INTERVAL` seconds, QoS 1, from a task of its own.
- **Commands**: the device subscribes to `d/+/to/<key>/#`, where `+` is the sender's key (the node guarantees it), prints each message and acknowledges it to its sender on `d/<key>/to/<sender>/ack`.

## Run it

1. Copy `sdkconfig.wifi.example` to `sdkconfig.wifi` at the repo root and fill in a 2.4 GHz network.

2. Start a node anywhere, on any network:

   ```bash
   cd packages/boat-mqtt-node && npm install
   node bin/boat-mqtt-node.js --key node.json
   ```

3. Build and flash:

   ```bash
   idf.py set-target esp32c3 && idf.py build flash monitor
   ```

   The device prints `MQTT|device key <hex>`, then `MQTT|connected node=…` and a telemetry line every 5 s.

4. Watch it and send it a command from any computer:

   ```bash
   node examples/watch.js --network boat-mqtt --to <device key> --send 'relay=on'
   ```

## Tested

2026-11-08, an ESP32-C3 on home WiFi and two nodes on a Mac on the same LAN, discovered and connected over the public HyperDHT. The nodes bridged each other (`d/+/telemetry,d/+/to/#`), and an app read through either node.

| | Result |
|---|---|
| First connection after boot | the lookup found both nodes in 4.8–5.0 s; MQTT connected 7.3–7.9 s after the client started, direct (no relay) |
| Command round trip, app and device on the same node | 32/32 acknowledged; 34 / 86 / 137 / 190 ms (min / median / p90 / max) |
| Command round trip, app on the other node, both ways across the bridges | 5/5 acknowledged, 58–160 ms |
| Telemetry to a TCP app on the device's node, and to an app on the other node through the bridge | all received |
| A TCP app publishing under the device's key | refused and disconnected |
| The device's node stopped | back on the other node in 14–16 s (37 s before the device tried the lost node last) |
| Free heap, connected | ~159 KB, steady |
| Firmware | 1.19 MB (23 % of the app partition free) |

Both nodes were on the same LAN as the board, so the round trips are LAN figures. A node elsewhere adds the network round trip. When a node goes away, most of the failover time is esp-mqtt's reconnect wait (5 s) plus a new lookup (~5 s).
