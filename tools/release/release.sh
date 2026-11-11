#!/usr/bin/env bash
# Everything a tester downloads, in dist/:
#   dist/firmware/  ESP32-C3 images (flash at 0x0) and ESP Web Tools manifests
#   dist/node/      npm tarballs: npm install -g <base>/boat-registry-<v>.tgz
#   dist/SHA256SUMS
#
#   . ~/esp/esp-idf/export.sh
#   tools/release/release.sh <base>    e.g. https://iot.xid.network/dl/node
#
# <base> is where dist/node will be served: the tarballs name each other by it.
# The Docker image is separate: tools/release/build-docker.sh.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE=${1:?usage: release.sh <base url where dist/node is served>}
"$ROOT/tools/release/build-firmware.sh" "$ROOT/dist/firmware"
"$ROOT/tools/release/pack-nodes.sh" "$BASE" "$ROOT/dist/node"
(cd "$ROOT/dist" && shasum -a 256 firmware/*.bin node/*.tgz node/install.sh > SHA256SUMS && cat SHA256SUMS)
