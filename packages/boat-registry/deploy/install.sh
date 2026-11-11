#!/bin/sh
# Installs boat-node as a systemd service, from a checkout of xid-network or
# from the release tarball:
#
#   sudo sh install.sh <xid-network checkout | boat-registry-<v>.tgz url or file> [--testnet] [--rpc url] [--registry 0x..]
#        [--network name] [--from-block n] [--reads 0x..] [--roles forward,store,verify,compute] [--no-start]
#   curl -fsSL https://iot.xid.network/dl/node/install.sh | sudo sh -s -- https://iot.xid.network/dl/node/boat-registry-0.1.0.tgz --testnet
#
# --testnet: the public testnet (chain, contracts, network name) from
# https://iot.xid.network/testnet.json; the other options override it.
#
# Puts the code in /opt/boat-node, makes a system user "boat" and its state in
# /var/lib/boat-node (seed and operator key, mode 600), and prints the
# operator address to fund. With --no-start it stops before enabling the
# service. Needs Node.js 20 or later.
set -eu
SRC=${1:?usage: install.sh <xid-network checkout or boat-registry .tgz> [--testnet] [--rpc url] [--registry 0x..] [--network name] [--roles ..] [--no-start]}
shift
INIT=; START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc|--registry|--roles|--network|--from-block|--reads) INIT="$INIT $1 $2"; shift 2 ;;
    --testnet) INIT="$INIT --testnet"; shift ;;
    --no-start) START=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
PREFIX=${PREFIX:-/opt/boat-node}
STATE=${STATE:-/var/lib/boat-node}
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "needs Node.js 20 or later" >&2; exit 1; }
id boat >/dev/null 2>&1 || useradd --system --home "$STATE" --shell /usr/sbin/nologin boat
mkdir -p "$PREFIX"
case "$SRC" in
  *.tgz)
    # the release tarball pulls in the other packages from where it is served
    npm install -g --prefix "$PREFIX" --no-audit --no-fund "$SRC" >/dev/null
    rm -rf "$PREFIX/boat-registry"
    ln -s "$PREFIX/lib/node_modules/boat-registry" "$PREFIX/boat-registry"
    ;;
  *)
    # a checkout of xid-network (with its submodule): the packages keep their
    # places, so their file: paths hold
    rm -rf "$PREFIX/src" && mkdir -p "$PREFIX/src/packages" "$PREFIX/src/third_party/hyperdht-esp32/packages"
    for p in third_party/hyperdht-esp32/packages/boat-ota third_party/hyperdht-esp32/packages/boat-peer packages/boat-mqtt-node packages/boat-registry; do
      cp -R "$SRC/$p" "$PREFIX/src/$p"
      rm -rf "$PREFIX/src/$p/node_modules" "$PREFIX/src/$p/out" "$PREFIX/src/$p/cache" "$PREFIX/src/$p/sol-lib"
      (cd "$PREFIX/src/$p" && npm install --omit=dev --no-audit --no-fund >/dev/null)
    done
    rm -rf "$PREFIX/boat-registry"
    ln -s "$PREFIX/src/packages/boat-registry" "$PREFIX/boat-registry"
    ;;
esac
mkdir -p "$STATE"
chown boat:boat "$STATE"
chmod 700 "$STATE"
su -s /bin/sh boat -c "node $PREFIX/boat-registry/bin/boat-node.js init $STATE $INIT"
if [ "$START" = 1 ]; then
  cp "$PREFIX/boat-registry/deploy/boat-node.service" /etc/systemd/system/boat-node.service
  systemctl daemon-reload
  systemctl enable --now boat-node
  echo "started: journalctl -u boat-node -f"
else
  echo "installed, not started (fund the operator, then: cp $PREFIX/boat-registry/deploy/boat-node.service /etc/systemd/system/ && systemctl enable --now boat-node)"
fi
