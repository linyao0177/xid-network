# A HyperDHT transport for NanoMQ: how much work

NanoMQ is EMQ's MIT-licensed C broker, built on its fork of NNG (NanoNNG). This note estimates what it takes for a NanoMQ broker to accept MQTT clients over HyperDHT, by public key, the way [`packages/boat-mqtt-node`](../packages/boat-mqtt-node) (Aedes) does. ESP32 devices would then connect with [`components/hdht_mqtt`](../components/hdht_mqtt) unchanged.

Read from the source at nanomq `4ac14f5` and NanoNNG `f70f50d` (both 2026-11-06), 2026-11-08. File and function names below were checked in that source. The effort figures, the thread-bridge design, and whether EMQ would take it upstream are estimates.

## How NanoNNG's MQTT transport is built

- **Transports.** `src/sp/transport.h` defines `struct nni_sp_tran`: a scheme, listener and dialer operations, and pipe operations. `nni_sp_tran_find` (`src/sp/transport.c`) picks one by exact match on the URL scheme. Each is registered behind a CMake flag (`nni_nmq_broker_tcp_register()`).
- **MQTT over TCP.** `src/sp/transport/mqtt/broker_tcp.c` (2,454 lines) registers `nmq-tcp`, `nmq-tcp4`, `nmq-tcp6` and `broker+tcp*`. It does the MQTT framing, the CONNECT exchange (`tcptran_pipe_nego_cb` → `conn_handler`), QoS resends and the v4/v5 send paths. It touches the network only through `nng_stream_*` and `nng_stream_listener_*`; its listener comes from `nng_stream_listener_alloc_url` in `tcptran_listener_init`.
- **Byte streams.** `src/core/stream.c` maps a scheme to a stream driver (`stream_drivers[]`). A stream is six callbacks (free, close, recv, send, get, set), and a stream listener is six more.

So the MQTT layer does not need rewriting. A HyperDHT transport is:

1. a stream driver for `nmq-hdht` (an hdht listener and stream);
2. one more `nni_sp_tran` entry that reuses `tcptran_listener_ops` and `tcptran_pipe_ops` under the new scheme.

`tcptran_pipe_getopt` ends in `nni_stream_get(p->conn, …)`, so any option the hdht stream answers, such as the peer's key, can be read from the pipe.

Two things do not exist yet:

- NanoNNG's QUIC transport (`src/mqtt/transport/quic/mqtt_quic.c`) is client-only (`.tran_listener = NULL`), used for bridging. There is no server-side non-TCP transport to copy.
- The listener URL may not carry a path, query or user info (`tcptran_listener_init` refuses them), so the node's key comes from configuration or a listener option.

## Threads

NNG has its own pollers (kqueue/epoll) and task-queue threads. Our hdht runs every call on one libuv loop. The pattern that bridges the two is already in NanoNNG: the msquic code (`msquic_dial.c`, `quic_stream_cb`) completes NNG operations from msquic's own threads with `nni_aio_finish` under a lock.

A native transport would run one uv thread that owns the `hdht_t`. NNG threads hand it work (listen, write, close, arm a receive) through a locked queue and `uv_async_send`, and the uv thread completes their operations. The hard parts:

- **Receiving.** hdht pushes data (`on_data`); NNG pulls it into an iov. A receive buffer per connection is needed.
- **Sending.** `hdht_stream_write` returns no completion and has no pause or resume, so either hdht gets backpressure or sends complete at once into an unbounded buffer.
- **Cancellation and lifetime.** Cancelling an NNG operation must go through the uv thread, and hdht frees a server stream after `on_close`, so the wrapper must let go first.

## Identity into authentication and ACL

`nano_pipe_start` (`src/sp/protocol/mqtt/nmq_mqtt.c:643`) already reads the peer's TLS certificate from the pipe. `nano_pipe_peer_cert_as_username` then makes the certificate name the username before `verify_connect` and HTTP auth run.

- **The clean way:** a sibling option such as `peer_key_as_username`, fed by a new stream option (`hdht:remote-key`). That is a small change in `nmq_mqtt.c`.
- **ACL:** `acl_handler.c` substitutes `${username}` and `${clientid}` in topic rules, and hex keys pass its checks. "Publish only under `d/${username}/#`" is then our rule. That its rule order and deny semantics match ours exactly was not checked.
- **A hack that works today:** have the hdht stream answer as a verified TLS peer (`NNG_OPT_TLS_PEER_CN` = the key in hex, `NNG_OPT_TLS_VERIFIED` = true). It is misleading and unlikely to be accepted upstream.

## Two ways to do it

| | Sidecar | Native transport |
|---|---|---|
| What | A process that accepts HyperDHT connections and forwards them to NanoMQ on 127.0.0.1 | An `nmq-hdht` stream driver and transport in a NanoNNG fork |
| Changes to NanoMQ | None | NanoNNG: `stream.c`, the MQTT transport, `nmq_mqtt.c`, CMake. NanoMQ: config parsing (`conf_ver2.c`), listener start (`apps/broker.c`) |
| Identity | The sidecar rewrites the CONNECT username to the key; the listener must be reachable only by the sidecar (NanoMQ has no PROXY protocol) | The key from the stream, as the username |
| Costs | Every client looks like 127.0.0.1 to NanoMQ; one more hop | A libuv thread inside the broker; a fork to keep up with `broker_tcp.c` |
| Effort | 3–4 days in Node.js (reusing boat-mqtt-node), 5–7 in C | 20–30 days for a working fork, plus 10 or more for upstream (Windows, CI, docs, review) |

The native estimate includes server-side work on hdht itself, which so far has run on devices. Its handshake limit is 4 by default (`HDHT_SERVER_MAX_HANDSHAKES`), it announces to 3 nodes, it runs as an ephemeral node with a small routing table, it has no IPv6 support, and writes have no backpressure.

## Licenses

- NanoMQ and NanoNNG are MIT, as is our code.
- libudx is Apache-2.0 with a NOTICE file. We ship that NOTICE and state our patches (`components/libudx/libudx/VENDORED.txt`).
- libuv is MIT and libsodium is ISC.

Nothing conflicts. EMQ has a precedent for optional transports that are off by default (`NNG_TRANSPORT_ZEROTIER`, `NNG_ENABLE_QUIC`), but whether it would take a new dependency stack is up to EMQ.

## Recommendation

1. **Start with the sidecar in Node.js.** It is a few days, needs nothing from EMQ, and gives an EMQ or NanoMQ operator a HyperDHT entrance that ESP32 devices can use.
2. **Propose the native transport to EMQ as a joint project.** Its cost sits mostly in the thread bridge and in making hdht a server-grade library, and it only pays off if EMQ wants it upstream.
