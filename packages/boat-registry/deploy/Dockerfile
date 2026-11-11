# boat-node in a container. Build from the repository's root (boat-peer and
# boat-ota come from the third_party/hyperdht-esp32 submodule):
#
#   docker build -f packages/boat-registry/deploy/Dockerfile -t boat-node .
#   docker run --rm -v boat-node:/data boat-node init /data --testnet
#   docker run -d --name boat-node --network host --restart unless-stopped -v boat-node:/data boat-node
#
# HyperDHT holepunches over UDP: host networking keeps the node reachable
# without port mappings. The volume holds the seed and operator key (mode
# 600), the store and the node's state; back it up.
FROM node:22-bookworm-slim
# /data belongs to boat before it becomes a volume, so a new volume does too
RUN useradd --system --home /data --shell /usr/sbin/nologin boat \
 && mkdir -p /data && chown boat:boat /data && chmod 700 /data
WORKDIR /app
# the packages keep their places in the repository, so their file: paths hold
COPY third_party/hyperdht-esp32/packages/boat-ota third_party/hyperdht-esp32/packages/boat-ota
COPY third_party/hyperdht-esp32/packages/boat-peer third_party/hyperdht-esp32/packages/boat-peer
COPY packages/boat-mqtt-node packages/boat-mqtt-node
COPY packages/boat-registry packages/boat-registry
RUN for p in third_party/hyperdht-esp32/packages/boat-ota third_party/hyperdht-esp32/packages/boat-peer packages/boat-mqtt-node packages/boat-registry; do (cd $p && rm -rf node_modules && npm install --omit=dev --no-audit --no-fund); done
USER boat
VOLUME /data
ENTRYPOINT ["node", "/app/packages/boat-registry/bin/boat-node.js"]
CMD ["run", "/data"]
