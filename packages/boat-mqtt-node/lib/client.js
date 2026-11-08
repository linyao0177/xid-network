import HyperDHT from 'hyperdht'
import mqtt from 'mqtt'
import { toNode } from './stream.js'
import { topicOf, NETWORK, hex } from './topics.js'
import { homeOf } from './home.js'

// Finds the nodes announced for a network: their public keys, in random order.
export async function findNodes (dht, network = NETWORK) {
  const found = new Map()
  for await (const r of dht.lookup(topicOf(network))) {
    for (const p of r.peers) found.set(hex(p.publicKey), p.publicKey)
  }
  return shuffle([...found.values()])
}

// An MQTT client (mqtt.js) whose transport is a HyperDHT connection.
//
// target: a node's public key (Buffer or hex), a list of them, or nothing to
// look up opts.network. Every (re)connect dials the next key, so a client
// moves to another node when one goes away. The client logs in with
// opts.keyPair: its public key is its identity on the node, and its client
// id must start with that key in hex (the default).
//
// Resolves with the client once the first CONNACK arrives.
export async function connect (target, opts = {}) {
  const dht = opts.dht || new HyperDHT({ bootstrap: opts.bootstrap })
  const keyPair = opts.keyPair || HyperDHT.keyPair()
  let keys = target == null ? null : [].concat(target).map((k) => typeof k === 'string' ? Buffer.from(k, 'hex') : k)
  if (keys === null) {
    keys = await findNodes(dht, opts.network)
    if (keys.length === 0) throw new Error(`no node found for network "${opts.network || NETWORK}"`)
  }

  let next = 0
  let current = null
  const builder = () => {
    current = keys[next++ % keys.length]
    if (client) client.node = current // undefined during the first call, from the constructor
    return toNode(dht.connect(current, { keyPair }))
  }
  let client = null
  const { network, bootstrap, keyPair: _kp, dht: _dht, ...mqttOpts } = opts
  client = new mqtt.MqttClient(builder, {
    clientId: hex(keyPair.publicKey),
    protocolVersion: 4,
    reconnectPeriod: 1000,
    connectTimeout: 30000,
    ...mqttOpts
  })
  client.node = current
  client.dht = dht
  client.keyPair = keyPair
  client.publicKey = keyPair.publicKey
  client.nodes = keys
  // a node that goes away resets the stream; mqtt.js reconnects, so that is
  // not fatal. Add your own 'error' listener to see it.
  client.on('error', () => {})
  const ownDht = !opts.dht
  client.on('end', () => { if (ownDht) dht.destroy() })

  await new Promise((resolve, reject) => {
    const tries = opts.tries || keys.length
    let failed = 0
    const onConnect = () => { cleanup(); resolve() }
    const onClose = () => {
      if (++failed < tries) return // mqtt.js reconnects to the next key
      cleanup()
      client.end(true)
      reject(new Error(`could not connect to ${tries} node(s)`))
    }
    const onError = (err) => {
      if (err.code === 5 || err.code === 4 || err.code === 2) { // refused by the node: do not retry
        cleanup()
        client.end(true)
        reject(err)
      }
    }
    const cleanup = () => {
      client.off('connect', onConnect)
      client.off('close', onClose)
      client.off('error', onError)
    }
    client.on('connect', onConnect)
    client.on('close', onClose)
    client.on('error', onError)
  })
  return client
}

function shuffle (a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Connects to a device's home node, named in its record: where to send it
// messages, so they reach it without a bridge.
export async function connectHome (deviceKey, opts = {}) {
  const dht = opts.dht || new HyperDHT({ bootstrap: opts.bootstrap })
  const home = await homeOf(dht, deviceKey)
  if (!home) throw new Error('no home node in the record of ' + hex(deviceKey).slice(0, 12))
  const client = await connect(home, { ...opts, dht })
  if (!opts.dht) client.on('end', () => dht.destroy())
  return client
}
