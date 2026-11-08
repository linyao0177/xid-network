# boat-mqtt-node

An MQTT node anyone can run. It is a standard MQTT broker ([Aedes](https://github.com/moscajs/aedes), MIT) reached over HyperDHT by its public key and announced under a network name, so devices find it without an IP address, a domain or a certificate, through NATs. Devices on ESP32 connect with [`components/hdht_mqtt`](../../components/hdht_mqtt) and use esp-mqtt as usual ([`examples/mqtt_p2p`](../../examples/mqtt_p2p)).

```bash
npx boat-mqtt-node --key node.json                      # join the "boat-mqtt" network
npx boat-mqtt-node --key node.json --tcp 1883 --users users.json   # plus TCP for your own apps
```

## Identity and topics

- **A client is its key.** A HyperDHT client is identified by the public key it proved in the Noise handshake. There is no password. Its MQTT client id must start with that key in hex (the default in `connect()` and in the example firmware), so nobody else can take over its session.
- **`d/<key>/…` belongs to `<key>`.** Only the holder of a key may publish under it, so a subscriber knows who sent a message from its topic alone (`senderOf(topic)`). A client that publishes anywhere else under `d/` is disconnected.
- **Messages to someone** go under the sender's key: `d/<from>/to/<to>/<anything>`. A device subscribes to its inbox, `d/+/to/<its key>/#`, and learns each sender from the topic.
- **Subscriptions are open.** Anyone may read anything, as on a public broker, so encrypt payloads end to end when they matter. Pass `authorizeSubscribe` to restrict them.
- **TCP apps**, with `--tcp` and `--users`, are the operator's own. They log in with a user name and a password, and may publish anywhere except under `d/`. Apps that need to send devices messages connect over HyperDHT with a key instead (`connect()`).

## Several nodes

Nodes of one network announce under BLAKE2b-256(network name). A client that looks the name up dials the nodes it finds in random order until one opens, and moves to another one when its node goes away.

A device publishes on one node. To read it from another node, that node **bridges** it: `node.bridge(<key of the device's node>, ['d/+/telemetry', 'd/+/to/#'])`, or `--bridge <key>=d/+/telemetry,d/+/to/#`. The bridge logs in with the node's key and copies what it receives into its own broker. A bridge carries only what was published on the node it reads, never what another bridge brought in, so two nodes can bridge each other without loops. Nothing is flooded across the network; a network-wide `#` subscription sees only the nodes bridged into its own.

## API

```js
import { createNode, connect, own, to, inboxOf, senderOf } from 'boat-mqtt-node'

const node = await createNode({ keyPair, network: 'boat-mqtt', tcp: { port: 1883 }, users: { ops: 'pw' } })
node.on('refused', ({ client, topic, reason }) => {})
node.usage() // { <key hex> | 'tcp:<user>': { messages, bytes } }, what each client published
await node.bridge(otherNodeKey, ['d/+/telemetry'])

const app = await connect(null, { network: 'boat-mqtt', keyPair }) // an mqtt.js client
await app.subscribeAsync('d/+/telemetry')
app.publish(to(app.publicKey, deviceKey, 'cmd'), 'relay=on')
```

`connect(target, opts)` takes a node key, a list of keys, or `null` to look up `opts.network`. Other options go to mqtt.js.

`examples/watch.js` is a small app: it prints what devices publish and can send one a command.

## Tests

`npm test` runs two nodes on a local HyperDHT testnet (18 checks): lookup by network name, a device publishing to apps over TCP and HyperDHT and across a bridge, a command into the device's inbox, two nodes bridging each other without a loop, the refusals (another key's namespace, a session takeover, bad TCP logins, a TCP app writing under `d/`), usage counts, and a client moving to the other node when its node closes.

With the ESP32-C3 on the public HyperDHT (2026-11-08), see [`examples/mqtt_p2p`](../../examples/mqtt_p2p/README.md#tested).

## Not yet

- Retained messages and QoS 1/2 sessions live in memory, so they are lost when a node restarts.
- Usage is counted but not charged: that is where payment per message would hook in.
- A node is trusted with what passes through it. A device that needs more signs and encrypts its payloads itself.
