# Release packages

What someone needs to try the network without building anything:

| Output | What it is | Made by |
|---|---|---|
| `dist/firmware/boat_device_min-esp32c3-<v>.bin` | The smallest BoAT device: signed readings every 10 s. Wi-Fi is set over Improv from the browser installer | `build-firmware.sh` |
| `dist/firmware/uart_module-esp32c3-<v>.bin` | The C3 as a module a host MCU drives with AT commands over USB; Wi-Fi with `AT+WIFI` | `build-firmware.sh` |
| `dist/firmware/*.manifest.json` | [ESP Web Tools](https://esphome.github.io/esp-web-tools/) manifests, to flash from a browser | `build-firmware.sh` |
| `dist/node/*.tgz` | The node packages as npm tarballs: `boat-registry` (`boat-node`, `boat-deploy`, `boat-fund`, `boat-sim` and the other commands), `xid-depin`, and what they depend on (`boat-mqtt-node`, `boat-peer`, `boat-ota`) | `pack-nodes.sh` |
| `dist/node/install.sh` | Installs `boat-node` from a tarball as a systemd service (a copy of `packages/boat-registry/deploy/install.sh`) | `pack-nodes.sh` |
| `dist/SHA256SUMS` | Checksums of the images, the tarballs and `install.sh` (`dist/node/SHA256SUMS`: the same for `node/` alone) | `release.sh`, `pack-nodes.sh` |
| `boat-node:<v>` | Docker image of the node (`packages/boat-registry/deploy/Dockerfile`) | `build-docker.sh` |

```sh
. ~/esp/esp-idf/export.sh
tools/release/release.sh https://iot.xid.network/dl/node     # firmware, tarballs, SHA256SUMS
tools/release/build-docker.sh                            # boat-node:<version>
```

`release.sh` needs ESP-IDF (`idf.py`) for the firmware; `pack-nodes.sh <base>` alone needs only Node.js.

## Publishing

The site serves `dist/` as `https://iot.xid.network/dl/`: `site/build.mjs` copies `firmware/`, `node/` and `SHA256SUMS` into the site, and `npm run deploy` there stops if the release is missing, incomplete or does not match `SHA256SUMS` (`site/README.md`). So the order is `release.sh`, then the site's deploy. The base given to `release.sh` must be where `node/` will be served, since the tarballs name each other by it.

To check a download against the published checksums:

```sh
curl -fsSLO https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz
curl -fsSL https://iot.xid.network/dl/SHA256SUMS | grep ' node/boat-registry-0.1.0.tgz$' | sed 's| node/| |' | shasum -a 256 -c
```

## Firmware

Release builds (`BOAT_RELEASE=1`) take `sdkconfig.release` instead of your
`sdkconfig.wifi`, so an image carries no Wi-Fi network; the script also checks
that your network's name and password are nowhere in it. `boat_device_min`
also takes `sdkconfig.testnet`: the public testnet's network name and
verifiers, to regenerate from `site/testnet.json` when its verifiers change.
`uart_module` is hyperdht-esp32's (`third_party/hyperdht-esp32`) and is
skipped, with a message, if that checkout has no release build. Each image is the
bootloader, partition table and app merged, flashed at 0x0:

```sh
esptool.py --chip esp32c3 erase_flash
esptool.py --chip esp32c3 write_flash 0x0 boat_device_min-esp32c3-0.1.0.bin
```

`boat_device_min` speaks Improv Wi-Fi on its console (USB Serial/JTAG), so
ESP Web Tools asks for the network right after flashing. On a board whose USB
goes through a USB-UART chip, build it with the console on UART0 instead
(`CONFIG_ESP_CONSOLE_UART_DEFAULT`); Improv follows the console.

## Node packages

In the repository the packages depend on each other with `file:../` paths.
`pack-nodes.sh <base>` rewrites those to `<base>/<name>-<version>.tgz`, so
they install with plain npm wherever the tarballs are served:

```sh
npm install -g https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz
boat-node init ~/boat-node --rpc <url> --registry 0x...
boat-node run ~/boat-node
```

With `file:/some/dir` as the base they install from a local directory, for a
machine that cannot reach the server. Node.js 20 or later.

`pack-nodes.sh` also puts `install.sh` (packages/boat-registry/deploy) next to
the tarballs: it installs boat-node from a tarball as a systemd service
(`--testnet` for the public testnet, `--depin lat,lon` to add `xid-depin`):

```sh
curl -fsSL https://iot.xid.network/dl/node/install.sh | sudo sh -s -- https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz --testnet
```

That runs what the server sends as root, unchecked. To check it first, download
`install.sh`, compare it with `SHA256SUMS` as above, then `sudo sh install.sh …`.
