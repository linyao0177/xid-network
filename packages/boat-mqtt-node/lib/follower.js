// Follows devices to their home nodes (home.js) and hands on what they
// publish: for nodes that work on device data without being in its path
// (verifiers, compute nodes). Emits 'message' (device hex, topic, payload).
// watch(filter) also takes what other clients of those nodes publish (other
// nodes' work, say): 'peer' (sender hex, topic, payload), on every home node;
// watchDevice(device, filter) does the same on one device's home node only,
// and follows the device when it moves. unfollow(device) gives all of it up.

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
    this.extra = new Map() // device hex -> Set of filters watched at its home (watchDevice)
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
    for (const f of this.extra.get(key) || []) await c.subscribeAsync(f, { qos: 1 })
    // unfollowed meanwhile: give back what was just subscribed
    if (!this.devices.has(key)) {
      await this._leave(key, h, filter)
      return h
    }
    const before = this.homes.get(key)
    const old = this.filters.get(key)
    this.homes.set(key, h)
    this.filters.set(key, filter)
    // it moved, or is followed with another filter now: not twice
    if (before && (before !== h || old !== filter)) await this._leave(key, before, old, before !== h)
    return h
  }

  // unsubscribes a device at one home node, and closes the connection to a
  // home node that no followed device is at any more
  async _leave (key, h, filter, extra = true) {
    const p = this.clients.get(h)
    const c = p && (await p.catch(() => null))
    if (!c) return
    const topics = [`d/${key}/${filter}`]
    // (a filter watched on every home node stays, when another device needs it there)
    if (extra) for (const f of this.extra.get(key) || []) if (!this.watching.has(f) && !this._shared(key, h, f)) topics.push(f)
    await c.unsubscribeAsync(topics).catch(() => {})
    if ([...this.homes.values()].includes(h) || this.clients.get(h) !== p) return
    this.clients.delete(h)
    c.end(true)
  }

  // whether another device at home node h has the same extra filter (watchDevice)
  _shared (key, h, f) {
    for (const [k, set] of this.extra) if (k !== key && set.has(f) && this.homes.get(k) === h) return true
    return false
  }

  // stops following a device: its subscriptions at its home node, and what
  // is kept for it here. Its messages are no longer handed on.
  async unfollow (device) {
    const key = hex(device)
    if (!this.devices.delete(key)) return false
    const h = this.homes.get(key)
    const filter = this.filters.get(key)
    this.homes.delete(key)
    this.filters.delete(key)
    if (h) await this._leave(key, h, filter)
    this.extra.delete(key)
    return true
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

  // subscribes to filter at the home node of one followed device (and again at
  // its new home when it moves): what others publish about that device only,
  // rather than about every device on every home node (watch)
  async watchDevice (device, filter) {
    const key = hex(device)
    if (!this.extra.has(key)) this.extra.set(key, new Set())
    const set = this.extra.get(key)
    if (set.has(filter)) return
    set.add(filter)
    const h = this.homes.get(key)
    const p = h && this.clients.get(h)
    const c = p && (await p.catch(() => null))
    if (c) await c.subscribeAsync(filter, { qos: 1 })
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
