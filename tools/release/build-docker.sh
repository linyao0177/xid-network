#!/usr/bin/env bash
# The boat-node image (packages/boat-registry/deploy/Dockerfile, built from
# the repository's root; .dockerignore keeps the context small).
#   tools/release/build-docker.sh [tag]      (default boat-node:<version>)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VER=$(node -p "require('$ROOT/packages/boat-registry/package.json').version")
docker build -f "$ROOT/packages/boat-registry/deploy/Dockerfile" -t "${1:-boat-node:$VER}" "$ROOT"
