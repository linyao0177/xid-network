#!/bin/sh
# Installs boat-node as a systemd service, from a copy of packages/.
#
#   sudo sh install.sh <packages dir> [--rpc url] [--registry 0x..] [--roles forward,store,verify,compute] [--no-start]
#
# Puts the code in /opt/boat-node, makes a system user "boat" and its state in
# /var/lib/boat-node (seed and operator key, mode 600), and prints the
# operator address to fund. With --no-start it stops before enabling the
# service. Needs Node.js 20 or later.
set -eu
SRC=${1:?usage: install.sh <packages dir> [--rpc url] [--registry 0x..] [--roles ..] [--no-start]}
shift
RPC=http://127.0.0.1:8545; REGISTRY=; ROLES=forward,store,verify,compute; START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC=$2; shift 2 ;;
    --registry) REGISTRY=$2; shift 2 ;;
    --roles) ROLES=$2; shift 2 ;;
    --no-start) START=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
PREFIX=${PREFIX:-/opt/boat-node}
STATE=${STATE:-/var/lib/boat-node}
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo "needs Node.js 20 or later" >&2; exit 1; }
id boat >/dev/null 2>&1 || useradd --system --home "$STATE" --shell /usr/sbin/nologin boat
mkdir -p "$PREFIX"
for p in boat-ota boat-peer boat-mqtt-node boat-registry; do
  rm -rf "$PREFIX/$p"
  cp -R "$SRC/$p" "$PREFIX/$p"
  rm -rf "$PREFIX/$p/node_modules" "$PREFIX/$p/out" "$PREFIX/$p/cache" "$PREFIX/$p/sol-lib"
done
for p in boat-ota boat-peer boat-mqtt-node boat-registry; do (cd "$PREFIX/$p" && npm install --omit=dev --no-audit --no-fund >/dev/null); done
mkdir -p "$STATE"
chown boat:boat "$STATE"
chmod 700 "$STATE"
su -s /bin/sh boat -c "node $PREFIX/boat-registry/bin/boat-node.js init $STATE --rpc $RPC --registry '$REGISTRY' --roles $ROLES"
if [ "$START" = 1 ]; then
  cp "$PREFIX/boat-registry/deploy/boat-node.service" /etc/systemd/system/boat-node.service
  systemctl daemon-reload
  systemctl enable --now boat-node
  echo "started: journalctl -u boat-node -f"
else
  echo "installed, not started (fund the operator, then: cp $PREFIX/boat-registry/deploy/boat-node.service /etc/systemd/system/ && systemctl enable --now boat-node)"
fi
