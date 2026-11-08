// A HyperDHT entrance for an existing MQTT broker (NanoMQ, EMQX, Mosquitto):
// the sidecar of docs/nanomq-hyperdht.md. The broker is not changed.
//
// - The gateway listens on HyperDHT with its own key and announces under a
//   network name, like a node, so devices (components/hdht_mqtt) reach it by
//   name or key, through NATs.
// - It reads each connection's first MQTT packet. A CONNECT whose client id
//   does not start with the key the peer proved in the Noise handshake is
//   refused, as a node refuses it. Otherwise the gateway sets the username to
//   that key (hex) and the password to a secret only it knows, forwards the
//   CONNECT to the broker on its local TCP port, and from then on copies bytes
//   both ways.
// - The broker asks the gateway whether to let a login in (NanoMQ's
//   http_auth auth_req, served by authServer()): the gateway's secret with a
//   key as username, or one of the operator's own users. Its ACL then keeps
//   each key to d/<key>/... with ${username} (nanomqConfig() writes both).
//
// The broker's TCP port must be reachable only from this machine: whoever
// can reach it with the secret can log in as any key.

import net from 'net'
import http from 'http'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import HyperDHT from 'hyperdht'
import mqttPacket from 'mqtt-packet'
import { topicOf, NETWORK, hex } from './topics.js'

const KEY = /^[0-9a-f]{64}$/
const MAX_CONNECT = 64 * 1024

export async function createGateway (opts) {
  const g = new Gateway(opts)
  await g.ready()
  return g
}

export class Gateway extends EventEmitter {
  constructor ({ dht, bootstrap, keyPair, network, broker = { host: '127.0.0.1', port: 1883 }, users = {}, secret, authPort = 0 }) {
    super()
    this.dht = dht || new HyperDHT({ bootstrap })
    this._ownDht = !dht
    this.keyPair = keyPair || HyperDHT.keyPair()
    this.publicKey = this.keyPair.publicKey
    this.network = network === undefined ? NETWORK : network
    this.broker = broker
    this.users = users
    this.secret = secret || crypto.randomBytes(32).toString('hex')
    this.authPort = authPort
    this.conns = new Set()
    this.stats = { connections: 0, forwarded: 0, refused: 0 }
  }

  async ready () {
    this.server = this.dht.createServer((conn) => this._handle(conn))
    await this.server.listen(this.keyPair)
    this.auth = http.createServer((req, res) => this._auth(req, res))
    await new Promise((resolve) => this.auth.listen(this.authPort, '127.0.0.1', resolve))
    this.authPort = this.auth.address().port
    if (this.network !== null) {
      await this.dht.announce(topicOf(this.network), this.keyPair).finished()
      this._timer = setInterval(() => this.dht.announce(topicOf(this.network), this.keyPair).finished().catch(() => {}), 10 * 60 * 1000)
      this._timer.unref()
    }
    return this
  }

  get authUrl () {
    return `http://127.0.0.1:${this.authPort}/mqtt/auth`
  }

  // NanoMQ's auth_req: 200 lets the login in, anything else refuses it
  _auth (req, res) {
    let body = ''
    req.on('data', (d) => {
      body += d
      if (body.length > 4096) req.destroy()
    })
    req.on('end', () => {
      const p = new URLSearchParams(body)
      const user = p.get('username') || ''
      const pass = p.get('password') || ''
      const id = p.get('clientid') || ''
      let ok = false
      if (KEY.test(user)) ok = timingSafeEqual(pass, this.secret) && id.startsWith(user) // through the gateway
      else ok = Object.hasOwn(this.users, user) && timingSafeEqual(pass, String(this.users[user])) && !/^[0-9a-f]{64}/i.test(id) // the operator's apps
      this.emit('auth', { user: KEY.test(user) ? user.slice(0, 12) + '…' : user, ok })
      res.writeHead(ok ? 200 : 401).end()
    })
  }

  _handle (conn) {
    this.stats.connections++
    const key = hex(conn.remotePublicKey)
    let buf = Buffer.alloc(0)
    let upstream = null
    const close = () => {
      conn.destroy()
      if (upstream) upstream.destroy()
      this.conns.delete(conn)
    }
    this.conns.add(conn)
    conn.on('error', () => {})
    conn.on('close', close)

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const len = packetLength(buf)
      if (len === -1) return buf.length > MAX_CONNECT ? close() : undefined // not whole yet
      conn.off('data', onData)
      const first = buf.subarray(0, len)
      const rest = buf.subarray(len)
      let packet
      try {
        packet = parseOne(first)
      } catch {
        return close()
      }
      if (!packet || packet.cmd !== 'connect') return close()
      if (!String(packet.clientId || '').startsWith(key)) {
        this.stats.refused++
        this.emit('refused', { key, clientId: packet.clientId, reason: 'client id must start with your public key' })
        // CONNACK "identifier rejected" (v5: "client identifier not valid")
        const v5 = packet.protocolVersion === 5
        conn.end(mqttPacket.generate({ cmd: 'connack', returnCode: 2, reasonCode: 0x85, sessionPresent: false }, { protocolVersion: v5 ? 5 : 4 }))
        return
      }
      packet.username = key
      packet.password = Buffer.from(this.secret)
      const rewritten = mqttPacket.generate(packet, { protocolVersion: packet.protocolVersion })
      upstream = net.connect(this.broker.port, this.broker.host)
      upstream.on('error', (err) => {
        if (!upstream.remoteAddress) this.emit('broker-error', { key, error: err })
        close()
      })
      upstream.on('close', close)
      upstream.on('connect', () => {
        this.stats.forwarded++
        this.emit('connection', { key, clientId: packet.clientId, protocolVersion: packet.protocolVersion })
        upstream.write(rewritten)
        if (rest.length) upstream.write(rest)
        conn.pipe(upstream)
        upstream.pipe(conn)
      })
    }
    conn.on('data', onData)
  }

  async close () {
    clearInterval(this._timer)
    for (const c of this.conns) c.destroy()
    if (this.network !== null) await this.dht.unannounce(topicOf(this.network), this.keyPair).catch(() => {})
    await this.server.close()
    await new Promise((resolve) => this.auth.close(() => resolve()))
    if (this._ownDht) await this.dht.destroy()
  }
}

// a NanoMQ configuration that takes logins from this gateway and keeps each
// key to d/<key>/...; returns { conf, acl } file contents
export function nanomqConfig ({ port = 1883, authUrl, aclPath }) {
  const conf = `# NanoMQ behind boat-mqtt-gateway (packages/boat-mqtt-node/lib/gateway.js)
listeners.tcp {
    bind = "127.0.0.1:${port}"
}
log {
    to = [console]
    level = warn
}
auth {
    allow_anonymous = false
    no_match = allow
    deny_action = disconnect
    acl = {include "${aclPath}"}
    http_auth = {
        auth_req {
            url = "${authUrl}"
            method = post
            headers.content-type = "application/x-www-form-urlencoded"
            params = {clientid = "%c", username = "%u", password = "%P"}
        }
        timeout = 5s
        connect_timeout = 5s
        pool_size = 4
    }
}
`
  const acl = `# a key publishes only under d/<its key>/; nobody else publishes under d/
rules = [
  {"permit": "allow", "username": "#", "action": "publish", "topics": ["d/\${username}/#"]}
  {"permit": "deny", "username": "#", "action": "publish", "topics": ["d/#"]}
  {"permit": "allow"}
]
`
  return { conf, acl }
}

// the length of the first MQTT packet in buf, or -1 if it is not all there
function packetLength (buf) {
  let mult = 1
  let len = 0
  for (let i = 1; i < 5; i++) {
    if (i >= buf.length) return -1
    len += (buf[i] & 127) * mult
    if ((buf[i] & 128) === 0) return buf.length >= 1 + i + len ? 1 + i + len : -1
    mult *= 128
  }
  return -1
}

function parseOne (bytes) {
  let out = null
  const parser = mqttPacket.parser({ protocolVersion: 5 })
  parser.on('packet', (p) => { out = out || p })
  parser.on('error', (e) => { throw e })
  parser.parse(bytes)
  return out
}

function timingSafeEqual (a, b) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
