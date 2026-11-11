# boat_device_min

The smallest device on the BoAT network, built on [`components/boat_device`](../../components/boat_device): connect to Wi-Fi, call `boat_device_start` once, then `boat_device_publish` (signed) or `boat_device_publish_sealed` (signed, readable only by its readers).

It is also the firmware released as an image (`tools/release`, and the
Download section of the docs), so one build serves anyone's network:

- **Wi-Fi** comes over [Improv](https://www.improv-wifi.com/serial/) from
  [`components/boat_wifi`](../../components/boat_wifi): the browser installer
  asks for it right after flashing. A developer's build starts with the
  network in `sdkconfig.wifi`.
- **Settings** are typed on the console and kept in NVS; the device restarts
  to use a new one. Without one, it uses the firmware's default from
  menuconfig.

| Command | Sets | Default |
| --- | --- | --- |
| `boat network <name>` | The network name to look up without verifiers | `boat-mqtt` |
| `boat verifiers <key>,<key>,…` | Verify keys whose node list it trusts | `CONFIG_BOAT_VERIFIERS` |
| `boat readers <key>,<key>,…` | Ed25519 keys that may read its readings (sealed) | `CONFIG_BOAT_READERS` |
| `boat show` | Prints what it uses and its device key | |

A command with no value goes back to the default. `CONFIG_BOAT_INTERVAL` is
the seconds between readings.

```sh
idf.py build flash monitor
```

It prints `BOAT|device <key>`, `BOAT|config …`, then one line per reading
with the receipts the node sent so far.

The console is on the C3's USB Serial/JTAG port (`sdkconfig.defaults`), the
port of most small C3 boards. On a board whose USB socket goes through a
USB-UART chip, set `CONFIG_ESP_CONSOLE_UART_DEFAULT`: Improv and the commands
follow the console.

Tested on 2026-11-10 with the release image on an ESP32-C3 board: Improv
device info, a scan, a wrong password refused, the right one taken in under
2 s and kept across a restart; then `boat network` and `boat verifiers`
pointed it at three local nodes, it read their node list (3 of 3 votes) and
got 12 receipts, none bad.
