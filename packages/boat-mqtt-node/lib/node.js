import net from 'net'
import { EventEmitter } from 'events'
import HyperDHT from 'hyperdht'
import { Aedes } from 'aedes'
import { toNode } from './stream.js'
import { topicOf, senderOf, NETWORK, hex } from './topics.js'
import { connect } from './client.js'
import { homeOf } from './home.js'
import { Billing } from './billing.js'
import { Receipts } from './receipts.js'

const BRIDGED = '$bridge' // marks packets a bridge brought in from another node
const ANNOUNCE_MS = 10 * 60 * 1000 // DHT nodes keep an announcement for 20 minutes

// CONNACK return codes (MQTT 3.1.1)
const IDENTIFIER_REJECTED = 2
const BAD_USER_OR_PASSWORD = 4

// A node anyone can run: an MQTT broker (Aedes) reached over HyperDHT by its
// public key, announced under its network's topic so devices find it without
// an IP address, domain or certificate.
//
// - A HyperDHT client is identified by the key it proved in the Noise
//   handshake; no password. Its client id must start with that key in hex,
//   so nobody else can take over its session.
// - Only the holder of <key> may publish under d/<key>/ (topics.js).
// - opts.tcp opens a plain TCP listener for the operator's own apps, with
//   opts.users = { name: password }. They may not publish under d/.
// - bridge() pulls topics from another node over HyperDHT.
// - Following (opts.follow, on by default): when a client subscribes to a
//   device by key (d/<key>/...), and the device's record names another node
//   as its home, this node bridges d/<key>/# from that node.
// - opts.billing charges per message and takes EIP-3009 payments (billing.js).
// - Receipts (receipts.js): the node signs what signed messages it got for
//   each device, directly or through a bridge, every opts.receiptMs (5 s), to
//   the device's inbox and retained at d/<node>/receipts/<device>.
export async function createNode (opts = {}) {
  const node = new BoatMqttNode(opts)
  await node.ready()
  return node
}

export class BoatMqttNode extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.dht = opts.dht || new HyperDHT({ bootstrap: opts.bootstrap })
    this.keyPair = opts.keyPair || HyperDHT.keyPair()
    this.publicKey = this.keyPair.publicKey
    this.network = opts.network === undefined ? NETWORK : opts.network // null: not announced
    this.users = opts.users || {}
    this.tcp = opts.tcp || null // { port, host = '127.0.0.1' }
    this.broker = null
    this.server = null
    this.tcpServer = null
    this.bridges = new Set()
    this._ownDht = !opts.dht
    this._authorizeSubscribe = opts.authorizeSubscribe || null
    this._usage = new Map()
    this._timer = null
    this.follow = opts.follow !== false
    this._following = new Map() // device key hex -> home key hex (or null while resolving)
    this._homes = new Map() // home key hex -> Promise<bridge client>
    this.billing = opts.billing ? new Billing(this, opts.billing) : null
    this.receipts = opts.receipts === false ? null : new Receipts(this.keyPair)
    this.receiptMs = opts.receiptMs || 5000
    this._receiptTimer = null
  }

  async ready () {
    const node = this
    this.broker = await Aedes.createBroker({
      id: hex(this.publicKey).slice(0, 16),
      maxClientsIdLength: 160,
      authenticate (client, user, pass, done) { node._authenticate(client, user, pass, done) },
      authorizePublish (client, packet, done) { node._authorizePublish(client, packet, done) },
      authorizeSubscribe (client, sub, done) {
        if (sub.topic.startsWith('$') && !sub.topic.startsWith('$SYS/')) return done(new Error('reserved topic'))
        if (node.follow && !client.bridge) node._follow(sub.topic)
        node._authorizeSubscribe ? node._authorizeSubscribe(client, sub, done) : done(null, sub)
      },
      authorizeForward (client, packet) {
        // a bridge carries what was published on its node, never what another
        // bridge brought in: no loops between nodes that bridge each other
        if (packet.clientId === BRIDGED && client.bridge) return null
        return packet
      }
    })
    this.broker.on('client', (c) => this.emit('client', describe(c)))
    this.broker.on('clientDisconnect', (c) => this.emit('clientDisconnect', describe(c)))

    this.server = this.dht.createServer((conn) => {
      conn.on('error', () => {})
      this.broker.handle(toNode(conn))
    })
    await this.server.listen(this.keyPair)

    if (this.tcp) {
      this.tcpServer = net.createServer((sock) => this.broker.handle(sock))
      await new Promise((resolve, reject) => {
        this.tcpServer.once('error', reject)
        this.tcpServer.listen(this.tcp.port, this.tcp.host || '127.0.0.1', resolve)
      })
    }

    if (this.billing) await this.billing.start()
    if (this.receipts) {
      this._receiptTimer = setInterval(() => this.sendReceipts(), this.receiptMs)
      this._receiptTimer.unref()
    }

    if (this.network !== null) {
      await this._announce()
      this._timer = setInterval(() => this._announce().catch(() => {}), ANNOUNCE_MS)
      this._timer.unref()
    }
    return this
  }

  get topic () {
    return this.network === null ? null : topicOf(this.network)
  }

  async _announce () {
    await this.dht.announce(this.topic, this.keyPair).finished()
  }

  _authenticate (client, user, pass, done) {
    const pk = client.conn.remotePublicKey
    if (pk) {
      client.key = hex(pk)
      if (!client.id.startsWith(client.key)) return done(refusal(IDENTIFIER_REJECTED, 'client id must start with your public key'), false)
      client.bridge = client.id.endsWith('-bridge')
      return done(null, true)
    }
    // TCP: the operator's own apps
    client.key = null
    if (user == null || !Object.hasOwn(this.users, user) || this.users[user] !== String(pass)) {
      return done(refusal(BAD_USER_OR_PASSWORD, 'bad user name or password'), false)
    }
    if (/^[0-9a-f]{64}/i.test(client.id)) return done(refusal(IDENTIFIER_REJECTED, 'client ids starting with a key are for HyperDHT clients'), false)
    client.user = user
    done(null, true)
  }

  _authorizePublish (client, packet, done) {
    if (!client) return done(null) // the broker's own
    const topic = packet.topic
    let reason = null
    if (topic.startsWith('$')) reason = 'reserved topic'
    else if (client.key) {
      if (senderOf(topic) !== client.key) reason = `publish only under d/${client.key.slice(0, 8)}.../`
    } else if (topic.startsWith('d/')) {
      reason = 'd/ is for HyperDHT clients'
    }
    if (!reason && client.key && this.billing) {
      const m = this.billing.meter(client.key, topic, packet.payload.length)
      if (!m.ok) reason = m.reason
      else if (m.free) this.billing.pay(client.key, packet.payload).catch(() => {})
    }
    if (reason) {
      this.emit('refused', { client: describe(client), topic, reason })
      return done(new Error(reason)) // MQTT 3.1.1: the node closes the connection
    }
    if (client.key && this.receipts) this.receipts.add(client.key, packet.payload)
    const id = client.key || 'tcp:' + client.user
    const u = this._usage.get(id) || { messages: 0, bytes: 0 }
    u.messages++
    u.bytes += packet.payload.length
    this._usage.set(id, u)
    done(null)
  }

  // Messages and payload bytes published so far, by client key (or tcp:<user>).
  usage () {
    return Object.fromEntries([...this._usage].map(([k, v]) => [k, { ...v }]))
  }

  // Pulls topics from another node into this one over HyperDHT, logged in
  // with this node's key. Only messages published on that node itself come
  // over (one hop), so nodes that bridge each other do not loop.
  async bridge (remoteKey, filters = ['d/+/telemetry'], opts = {}) {
    const client = await connect(remoteKey, { ...opts, dht: this.dht, keyPair: this.keyPair, clientId: hex(this.publicKey) + '-bridge' })
    if (filters.length) await client.subscribeAsync(filters, { qos: 1 })
    client.on('message', (topic, payload, packet) => {
      const from = senderOf(topic)
      if (from && this.receipts) this.receipts.add(from, payload)
      this.broker.publish({ cmd: 'publish', topic, payload, qos: packet.qos, retain: false, clientId: BRIDGED }, () => {})
    })
    this.bridges.add(client)
    client.on('end', () => this.bridges.delete(client))
    return client
  }

  // a subscription to d/<key>/...: bridge that device from its home node
  async _follow (filter) {
    const m = /^d\/([0-9a-f]{64})(\/|$)/.exec(filter)
    if (!m || this._following.has(m[1])) return
    const key = m[1]
    this._following.set(key, null)
    try {
      const home = await homeOf(this.dht, key)
      if (!home) throw new Error('no home node in its record')
      if (home.equals(this.publicKey)) {
        this._following.set(key, hex(home))
        return
      }
      const h = hex(home)
      if (!this._homes.has(h)) {
        const p = this.bridge(home, [])
        this._homes.set(h, p)
        p.then((c) => c.on('end', () => this._homes.delete(h)), () => this._homes.delete(h))
      }
      const bridge = await this._homes.get(h)
      await bridge.subscribeAsync(`d/${key}/#`, { qos: 1 })
      this._following.set(key, h)
      this.emit('follow', { key, home: h })
    } catch (err) {
      this._following.delete(key) // tried again on the next subscription
      this.emit('follow-error', { key, error: err })
    }
  }

  // signs a receipt for each device with new signed messages
  sendReceipts () {
    const me = hex(this.publicKey)
    for (const key of this.receipts.dirty()) {
      const line = Buffer.from(this.receipts.receipt(key))
      this.broker.publish({ cmd: 'publish', topic: `d/${me}/receipts/${key}`, payload: line, qos: 1, retain: true }, () => {})
      this.broker.publish({ cmd: 'publish', topic: `d/${me}/to/${key}/receipt`, payload: line, qos: 1, retain: false }, () => {})
      this.emit('receipt', { key, line: String(line) })
    }
  }

  // device key hex -> home node key hex, for the devices this node follows
  following () {
    return Object.fromEntries([...this._following].filter(([, v]) => v))
  }

  async close () {
    clearInterval(this._timer)
    clearInterval(this._receiptTimer)
    if (this.billing) this.billing.stop()
    for (const b of this.bridges) b.end(true)
    if (this.network !== null) await this.dht.unannounce(this.topic, this.keyPair).catch(() => {})
    await this.server.close()
    if (this.tcpServer) await new Promise((resolve) => this.tcpServer.close(() => resolve()))
    await new Promise((resolve) => this.broker.close(resolve))
    if (this._ownDht) await this.dht.destroy()
  }
}

function refusal (returnCode, message) {
  const err = new Error(message)
  err.returnCode = returnCode
  return err
}

function describe (c) {
  return { id: c.id, key: c.key || null, user: c.user || null, bridge: !!c.bridge }
}
