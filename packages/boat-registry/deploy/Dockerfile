# boat-node in a container. Build from packages/ (it needs the sibling packages):
#
#   docker build -f boat-registry/deploy/Dockerfile -t boat-node packages/
#   docker run --rm -v boat-node:/data boat-node init /data --rpc <url> --registry 0x..
#   docker run -d --name boat-node --network host --restart unless-stopped -v boat-node:/data boat-node
#
# HyperDHT holepunches over UDP: host networking keeps the node reachable
# without port mappings. The volume holds the seed and operator key (mode
# 600), the store and the node's state; back it up.
FROM node:22-bookworm-slim
RUN useradd --system --home /data --shell /usr/sbin/nologin boat
WORKDIR /app
COPY boat-ota/package.json boat-ota/package-lock.json* boat-ota/
COPY boat-peer/package.json boat-peer/package-lock.json* boat-peer/
COPY boat-mqtt-node/package.json boat-mqtt-node/package-lock.json* boat-mqtt-node/
COPY boat-registry/package.json boat-registry/package-lock.json* boat-registry/
COPY boat-ota boat-ota
COPY boat-peer boat-peer
COPY boat-mqtt-node boat-mqtt-node
COPY boat-registry boat-registry
RUN for p in boat-ota boat-peer boat-mqtt-node boat-registry; do (cd $p && npm install --omit=dev --no-audit --no-fund); done
USER boat
VOLUME /data
ENTRYPOINT ["node", "/app/boat-registry/bin/boat-node.js"]
CMD ["run", "/data"]
