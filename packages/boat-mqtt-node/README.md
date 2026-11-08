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

A device publishes on one node, its **home**, and names it in its DHT record (`"mqtt":"<node key>"`, next to the rest of a BoAT DID record; `publishHome`). A node that gets a subscription to a device by key (`d/<key>/…`) reads the record and **follows** the device: it bridges `d/<key>/#` from the home node, one bridge per home node (`following()`, `--no-follow` to turn it off). To send a device a message, connect to its home node (`connectHome(key)`, `watch.js --home`), so the message needs no bridge.

Nodes can also be bridged by hand: `node.bridge(<key of the device's node>, ['d/+/telemetry', 'd/+/to/#'])`, or `--bridge <key>=d/+/telemetry,d/+/to/#`. The bridge logs in with the node's key and copies what it receives into its own broker. A bridge carries only what was published on the node it reads, never what another bridge brought in, so two nodes can bridge each other without loops. Nothing is flooded across the network; a network-wide `#` subscription sees only the nodes bridged into its own.

## In front of a broker you already run

`boat-mqtt-gateway` puts the same HyperDHT entrance in front of an existing broker, such as NanoMQ, which stays unchanged ([`lib/gateway.js`](lib/gateway.js)).

- Devices reach the gateway by network name or key.
- It refuses a client id that does not start with the device's key.
- It logs the device in to the broker with its key as username and a secret only the gateway knows as password, and then copies bytes.
- The broker asks the gateway whether to let each login in, and its own ACL keeps each key under `d/<key>/`.

```bash
boat-mqtt-gateway --broker 127.0.0.1:1884 --users users.json --nanomq-conf ./nanomq
nanomq start --conf ./nanomq/nanomq.conf
```

`test/gateway.js` runs it against a real NanoMQ (`$NANOMQ`), 12 checks. Results, the ESP32 run, and what we saw in NanoMQ itself are in [docs/nanomq-hyperdht.md](../../docs/nanomq-hyperdht.md#the-sidecar-built-and-tested-2026-11-08).

## Signed messages

A node checks who publishes, but anyone can run a node, so a node or a bridge could change a message or replay an old one. Publishers that care sign their messages: `sign(secretKey, topic, seq, payload)` here, `hdht_mqtt_sign` on the device (`components/hdht_mqtt`). Each message carries the publisher's Ed25519 signature over the topic, a sequence number and the payload. `SignedInbox` checks a message against the key in its topic, whatever node it came through, and refuses a sequence number it has seen. The C and JS implementations are checked against each other in the tests.

## Paid per message

With `billing`, a node charges each key for what it publishes and takes EIP-3009 payments (USD₮, USDC), the payments BoAT MER devices sign ([`lib/billing.js`](lib/billing.js)):

- The node puts its **terms** (payee, token, chain, price per message and per KB, credit) in its own DHT record, so a device knows whom it pays before it pays.
- It meters each key: price × messages + price per KB × payload bytes. A device can count the same.
- It sends **invoices** to the device's inbox, `d/<node>/to/<device>/invoice`. The device pays with an authorization published to `d/<device>/to/<node>/pay`, which is free and always allowed.
- It **checks** each payment: the signer must be the wallet in the device's DID record (boat-peer), the authorization must pay the payee no more than is due and stay valid long enough to settle, and its nonce must be new. While more than the credit is unpaid, the node refuses the device's other messages.
- **Settlement** is up to the node operator: each good payment is a `payment` event with an authorization that `wdk-protocol-boat-evm` settles, one by one or in Multicall3 batches ([`examples/mqtt-node.js`](../wdk-protocol-boat-evm/examples/mqtt-node.js)).

On the ESP32-C3 with `examples/boat_mer`, 29 of 29 invoices were paid by the device and settled on a Stable testnet fork, and the device's own count equalled the node's ([results](../../examples/boat_mer/README.md#mqtt-paid-per-message-2026-11-08)).

## API

```js
import { createNode, connect, connectHome, own, to, inboxOf, senderOf, SignedInbox } from 'boat-mqtt-node'

const node = await createNode({ keyPair, network: 'boat-mqtt', tcp: { port: 1883 }, users: { ops: 'pw' } })
node.on('refused', ({ client, topic, reason }) => {})
node.usage() // { <key hex> | 'tcp:<user>': { messages, bytes } }, what each client published
await node.bridge(otherNodeKey, ['d/+/telemetry'])
node.following() // { <device key>: <home node key> }

const paid = await createNode({ billing: { price: { message: 100, kb: 1000 }, credit: 20000, payee, token, chainId: 2201, domain: { name: 'USD₮0', version: '1' } } })
paid.billing.on('payment', ({ key, authorization }) => {}) // settle it

const app = await connect(null, { network: 'boat-mqtt', keyPair }) // an mqtt.js client
await app.subscribeAsync('d/+/telemetry')
const inbox = new SignedInbox()
app.on('message', (topic, payload) => inbox.check(topic, payload)) // { ok, from, seq, payload }
const out = await connectHome(deviceKey, { keyPair }) // the device's home node
out.publish(to(app.publicKey, deviceKey, 'cmd'), 'relay=on')
```

`connect(target, opts)` takes a node key, a list of keys, or `null` to look up `opts.network`. Other options go to mqtt.js.

`examples/watch.js` is a small app: it prints what devices publish and can send one a command.

## Tests

`npm test` runs nodes on a local HyperDHT testnet (35 checks):

- **Signed messages:** C and JS signatures checked against each other.
- **Connecting:** lookup by network name.
- **Delivery:** a device publishes to apps over TCP, over HyperDHT and across a bridge; a command reaches the device's inbox; two nodes bridge each other without a loop.
- **Following:** a node follows a device to its home node from its record; a replayed or changed message is caught; a command reaches the device through `connectHome`.
- **Billing:** invoices; bad payments refused (too much, another wallet, expiring, another payee, replayed); disconnection over the credit; publishing again after paying.
- **Refusals:** another key's namespace, a session takeover, bad TCP logins, a TCP app writing under `d/`.
- **Usage:** usage counts.
- **Failover:** a client moving to the other node when its node closes.

With the ESP32-C3 on the public HyperDHT (2026-11-08), see [`examples/mqtt_p2p`](../../examples/mqtt_p2p/README.md#tested).

## Load

`bench/load.js` runs a node in a process of its own on a local HyperDHT testnet and opens N clients from worker processes. Each client publishes a small message every 10 s, and a subscriber measures delivery. On a Mac (10 cores, 16 GB) on 2026-11-08, all on one machine (so connect times have no network in them):

| | 1,000 over HyperDHT | 10,000 over HyperDHT | 10,000 over TCP |
|---|---|---|---|
| Connected | 1,000 | 10,000 | 10,000 |
| Connect time p50 / p95 / max | 4 ms / 3.9 s / 5.0 s | 3 ms / 6.0 s / 12.5 s | 2 / 4 / 48 ms |
| Node memory | 118 MB, 50 KB per client | 544 MB, 49 KB per client | 249 MB, 18 KB per client |
| Node CPU, steady (median, % of one core) | 11 % | 23 % | 11 % |
| Messages delivered per second | 94 of 100 | 999 of 1,000 | 981 of 1,000 |
| Latency p50 / p95 / p99 | 1 / 2 / 3 ms | 1 / 4 / 11 ms | 0 / 2 / 5 ms |

Clients were opened at 250 per second. Most connected in a few milliseconds, but a tail waited seconds while the node worked through Noise handshakes. Over HyperDHT the node needs about 31 KB more per client than over TCP, and twice the CPU at this message rate. One Node.js process held 10,000 HyperDHT clients with room to spare.

## Not yet

- Retained messages and QoS 1/2 sessions live in memory, so they are lost when a node restarts.
- A node is trusted with what passes through it. A device that needs more signs and encrypts its payloads itself.
