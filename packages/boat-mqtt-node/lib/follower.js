// Follows devices to their home nodes (home.js) and hands on what they
// publish: for nodes that work on device data without being in its path
// (verifiers, compute nodes). Emits 'message' (device hex, topic, payload).
// watch(filter) also takes what other clients of those nodes publish (other
// nodes' work, say): 'peer' (sender hex, topic, payload).

import { EventEmitter } from 'events'
import { connect } from './client.js'
import { homeOf } from './home.js'
import { senderOf, hex } from './topics.js'

export class Follower extends EventEmitter {
  // refreshMs: how often to look up devices' records again, to follow a
  // device that moved to another home node (0: never)
  constructor ({ dht, keyPair, role = 'follower', refreshMs = 60000 }) {
    super()
    this.dht = dht
    this.keyPair = keyPair
    this.role = role
    this.devices = new Set()
    this.clients = new Map() // home hex -> Promise<client>
    this.watching = new Set()
    this.homes = new Map() // device hex -> home hex
    this.filters = new Map() // device hex -> filter
    if (refreshMs) {
      this._timer = setInterval(() => this._refresh().catch(() => {}), refreshMs)
      this._timer.unref()
    }
  }

  async _refresh () {
    for (const [key, h] of this.homes) {
      const home = await homeOf(this.dht, key).catch(() => null)
      if (home && hex(home) !== h) {
        await this.follow(key, this.filters.get(key)).catch(() => {})
        this.emit('moved', key, hex(home))
      }
    }
  }

  async follow (device, filter = '#') {
    const key = hex(device)
    this.devices.add(key)
    const home = await homeOf(this.dht, key)
    if (!home) throw new Error('no home node in the record of ' + key.slice(0, 12))
    const h = hex(home)
    if (!this.clients.has(h)) {
      const p = connect(home, { dht: this.dht, keyPair: this.keyPair, clientId: hex(this.keyPair.publicKey) + '-' + this.role })
      p.then(async (c) => {
        c.on('message', (topic, payload) => {
          const from = senderOf(topic)
          if (!from) return
          if (this.devices.has(from)) this.emit('message', from, topic, payload, h) // h: the node it came through
          else this.emit('peer', from, topic, payload)
        })
        for (const f of this.watching) await c.subscribeAsync(f, { qos: 1 }).catch(() => {})
      }, () => this.clients.delete(h))
      this.clients.set(h, p)
    }
    const c = await this.clients.get(h)
    await c.subscribeAsync(`d/${key}/${filter}`, { qos: 1 })
    this.homes.set(key, h)
    this.filters.set(key, filter)
    return h
  }

  // subscribes to filter on every home node we follow devices at, now and later
  async watch (filter) {
    if (this.watching.has(filter)) return
    this.watching.add(filter)
    for (const p of this.clients.values()) {
      const c = await p.catch(() => null)
      if (c) await c.subscribeAsync(filter, { qos: 1 })
    }
  }

  // publishes at one device's home node only: everyone who follows the
  // device is there (cheaper than every home node, at scale)
  async publishTo (device, topic, payload, opts = { qos: 1 }) {
    const h = this.homes.get(hex(device))
    const p = h && this.clients.get(h)
    const c = p && (await p.catch(() => null))
    if (c) return c.publishAsync(topic, payload, opts)
    return this.publish(topic, payload, opts)
  }

  // publishes on every home node we are connected to (our own namespace only)
  async publish (topic, payload, opts = { qos: 1 }) {
    for (const p of this.clients.values()) {
      const c = await p.catch(() => null)
      if (c) await c.publishAsync(topic, payload, opts)
    }
  }

  async close () {
    clearInterval(this._timer)
    for (const p of this.clients.values()) (await p.catch(() => null))?.end(true)
  }
}
