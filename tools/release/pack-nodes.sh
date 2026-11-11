#!/usr/bin/env bash
# Node packages as npm tarballs that install without the repository:
#
#   tools/release/pack-nodes.sh <base> [out-dir]     (default dist/node)
#   npm install -g <base>/boat-registry-<version>.tgz    # gives boat-node
#
# The packages depend on each other through file: paths in the repository;
# in the tarballs those become <base>/<name>-<version>.tgz, so <base> is
# where the tarballs will be served (https://…/dl), or file:/some/dir for a
# local install or a Docker build.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BASE=${1:?usage: pack-nodes.sh <base url or file:/dir> [out-dir]}
BASE=${BASE%/}
OUT=$(mkdir -p "${2:-$ROOT/dist/node}" && cd "${2:-$ROOT/dist/node}" && pwd)
find "$OUT" -maxdepth 1 -name 'boat-*.tgz' -delete
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# boat-peer and boat-ota are hyperdht-esp32's (third_party/hyperdht-esp32)
for p in boat-peer boat-ota boat-mqtt-node boat-registry; do
  src=$ROOT/packages/$p
  [ -d "$src" ] || src=$ROOT/third_party/hyperdht-esp32/packages/$p
  # only what the package's "files" names, as npm pack would take it
  (cd "$src" && npm pack --dry-run --json 2>/dev/null) |
    node -e 'for (const f of JSON.parse(require("fs").readFileSync(0))[0].files) console.log(f.path)' |
    (cd "$src" && rsync -a --files-from=- . "$STAGE/$p/")
  SRC="$src" node - "$STAGE/$p/package.json" "$BASE" <<'JS'
const fs = require('fs')
const path = require('path')
const [file, base] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file))
for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
  if (!spec.startsWith('file:')) continue
  // the dependency where the file: path points, from the package's own place
  const dep = JSON.parse(fs.readFileSync(path.join(path.resolve(process.env.SRC, spec.slice(5)), 'package.json')))
  pkg.dependencies[name] = `${base}/${name}-${dep.version}.tgz`
}
delete pkg.devDependencies
delete pkg.scripts?.test
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
JS
  (cd "$STAGE/$p" && npm pack --pack-destination "$OUT" >/dev/null 2>&1)
  echo "$(ls "$OUT"/$p-*.tgz | xargs -n1 basename) $(node -p "require('$STAGE/$p/package.json').dependencies ? Object.entries(require('$STAGE/$p/package.json').dependencies).filter(([,s]) => s.includes('.tgz')).map(([n]) => n).join(' ') : ''")"
done
cp "$ROOT/packages/boat-registry/deploy/install.sh" "$OUT/install.sh"
(cd "$OUT" && shasum -a 256 *.tgz install.sh > SHA256SUMS)
