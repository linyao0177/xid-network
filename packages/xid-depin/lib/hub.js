// A DePIN network run by the public testnet's hub (boat-registry's
// examples/testnet-hub.js --depin <dir>): the hub's wallet deploys it, enrolls
// devices that ask (POST /api/depin/enroll), claims every published epoch's
// rewards for the payees, and the hub's snapshot shows it.
//
// <dir> holds config.json and network.key (xid-depin new); deployment.json
// is written there once the network is deployed, and hub.json keeps what
// was claimed.

import fs from 'fs'
import path from 'path'
import HyperDHT from 'hyperdht'
import { connect, publishHome } from 'boat-mqtt-node'
import { checkConfig, configHash } from './config.js'
import { curveOf, emission } from './curve.js'
import { deployNetwork, attachNetwork, attachToken } from './network.js'
import { leafOf, claimOf } from './score.js'
import { centerOf } from './geo.js'
import { hex } from './records.js'

export class DepinHub {
  // wallet: the hub's (a NonceManager); token: the registry's stake token,
  // which mints for anyone (TSUSD)
  constructor ({ dir, wallet, provider, dht, registry, token, home, log = () => {}, chainId, rpc }) {
    this.dir = dir
    this.wallet = wallet
    this.provider = provider
    this.dht = dht
    this.registry = registry
    this.token = token
    this.home = home
    this.log = log
    this.chainId = chainId
    this.rpc = rpc
    this.trees = new Map() // epoch -> Map(root -> tree)
    this.state = { claimedUpTo: -1 }
  }

  file (name) { return path.join(this.dir, name) }

  async start () {
    this.config = checkConfig(JSON.parse(fs.readFileSync(this.file('config.json'), 'utf8')))
    this.netKP = HyperDHT.keyPair(Buffer.from(fs.readFileSync(this.file('network.key'), 'utf8').trim(), 'hex'))
    this.netKey = hex(this.netKP.publicKey)
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.file('hub.json'), 'utf8'))) } catch {}
    await this.keepHome()
    setInterval(() => this.keepHome().catch((err) => this.log('depin home: ' + err.message)), 6 * 3600 * 1000).unref()
    if (!fs.existsSync(this.file('deployment.json'))) await this.deploy()
    this.deployment = JSON.parse(fs.readFileSync(this.file('deployment.json'), 'utf8'))
    this.net = attachNetwork(this.deployment.network, this.wallet)
    this.reward = attachToken(this.deployment.token, this.provider)
    this.symbol = await this.reward.symbol()
    await this.listen()
    this.log(`depin: ${this.config.name} at ${this.deployment.network}, key ${this.netKey.slice(0, 12)}…, home ${this.home.slice(0, 12)}…`)
    return this
  }

  async keepHome () {
    await publishHome(this.dht, this.netKP, Buffer.from(this.home, 'hex'))
  }

  async deploy () {
    const pay = 1_000000n
    const budget = pay * 1000n
    await (await this.token.mint(this.wallet.address, budget)).wait()
    const start = Math.ceil(Date.now() / 1000 / 3600) * 3600 // the next full hour
    const d = await deployNetwork(this.wallet, {
      registry: await this.registry.getAddress(),
      config: this.config,
      netKey: this.netKey,
      start,
      job: { quorum: 2, pay, budget, perEpoch: 10 },
      log: (l) => this.log('depin deploy: ' + l)
    })
    const out = { chainId: Number(this.chainId), rpc: this.rpc, registry: await this.registry.getAddress(), netKey: this.netKey, config: this.config.name, configHash: configHash(this.config), ...d }
    fs.writeFileSync(this.file('deployment.json'), JSON.stringify(out, null, 2) + '\n')
  }

  // the rewards trees the oracles publish at the network's home node
  async listen () {
    const start = async () => {
      try {
        const c = await connect(this.home, { dht: this.dht, keyPair: HyperDHT.keyPair() })
        c.on('message', (topic, payload) => {
          let t
          try { t = JSON.parse(payload.toString()) } catch { return }
          if (!t || t.net !== this.netKey || !Number.isInteger(t.epoch) || !Array.isArray(t.leaves)) return
          if (!this.trees.has(t.epoch)) this.trees.set(t.epoch, new Map())
          this.trees.get(t.epoch).set(t.root, t)
          for (const e of this.trees.keys()) if (e < t.epoch - 48) this.trees.delete(e)
        })
        c.on('close', () => setTimeout(start, 30000))
        await c.subscribeAsync(`d/+/depin/${this.netKey}/+/rewards`, { qos: 1 })
      } catch (err) {
        this.log('depin listen: ' + err.message)
        setTimeout(start, 30000)
      }
    }
    await start()
  }

  // a device asked to join (POST /api/depin/enroll): the hub pays its fee
  async enroll (did) {
    if (!/^[0-9a-f]{64}$/.test(did)) throw new Error('device: its 64-hex-digit key')
    if ((await this.net.enrolledAt('0x' + did)) !== 0n) return { network: this.deployment.network, already: true }
    const fee = await this.net.enrollFee()
    if (fee > 0n) {
      if ((await this.token.balanceOf(this.wallet.address)) < fee) await (await this.token.mint(this.wallet.address, fee * 100n)).wait()
      if ((await this.token.allowance(this.wallet.address, this.deployment.network)) < fee) await (await this.token.approve(this.deployment.network, fee * 1000n)).wait()
    }
    const tx = await this.net.enroll('0x' + did)
    await tx.wait()
    return { network: this.deployment.network, tx: tx.hash }
  }

  // every published epoch's rewards, claimed for their payees; fees to the job
  async round () {
    if ((await this.net.fees()) >= 10_000000n) {
      await (await this.net.sendFees()).wait()
      this.log('depin: enrollment fees sent to the oracles\' job')
    }
    const now = Number(await this.net.epoch())
    for (let e = this.state.claimedUpTo + 1; e < now; e++) {
      const ep = await this.net.epochs(e)
      if (ep.publishedAt === 0n) {
        if (now - e > 3) { this.state.claimedUpTo = e; continue } // never published: past it
        break
      }
      const tree = this.trees.get(e)?.get(ep.root)
      if (!tree) break // not heard yet
      const leaves = tree.leaves.map((l) => ({ ...l, amount: BigInt(l.amount), leaf: leafOf(e, l.did, l.payee, BigInt(l.amount)) }))
      const items = leaves.map((l) => claimOf({ epoch: e, leaves }, l.did)).map((c) => ({ epoch: e, did: '0x' + c.did, payee: c.payee, amount: c.amount, proof: c.proof }))
      for (let i = 0; i < items.length; i += 20) {
        const part = items.slice(i, i + 20)
        await (await this.net.claimMany(part, { gasLimit: 80000n + 70000n * BigInt(part.length) })).wait()
      }
      this.log(`depin: epoch ${e} claimed for ${items.length} devices`)
      this.state.claimedUpTo = e
      fs.writeFileSync(this.file('hub.json'), JSON.stringify(this.state))
    }
  }

  // what the site shows
  async snapshot () {
    const n = this.net
    const [epoch, count, emitted, owed] = await Promise.all([n.epoch(), n.deviceCount(), n.emitted(), n.owed()])
    const curve = curveOf(this.config.curve)
    const epochs = []
    for (let e = Number(epoch) - 1; e >= 0 && epochs.length < 24; e--) {
      const ep = await n.epochs(e)
      const tree = this.trees.get(e)?.get(ep.root) || [...(this.trees.get(e)?.values() || [])][0] || null
      epochs.push({ epoch: e, start: this.deployment.start + e * this.config.epoch.length, published: ep.publishedAt !== 0n, total: ep.total.toString(), devices: Number(ep.devices), root: ep.publishedAt !== 0n ? ep.root : null, oracles: tree?.oracles || [] })
    }
    const latest = epochs.find((x) => this.trees.get(x.epoch)?.size)
    const tree = latest ? (this.trees.get(latest.epoch).get(latest.root) || [...this.trees.get(latest.epoch).values()][0]) : null
    const stations = (tree?.rows || []).map((r) => {
      let at = null
      try { at = r.cell ? centerOf(r.cell).map((x) => Math.round(x * 1000) / 1000) : null } catch {}
      return { did: r.did, cell: r.cell, at, payee: r.payee, location: r.location, rtts: r.rtts, uptime: r.uptime, quality: r.quality, coverage: r.coverage, witnessed: r.witnessed, share: r.share, amount: r.amount }
    })
    return {
      network: this.deployment.network,
      netKey: this.netKey,
      token: this.deployment.token,
      symbol: this.symbol,
      job: this.deployment.job,
      config: { name: this.config.name, title: this.config.title, about: this.config.about, epoch: this.config.epoch, curve: this.config.curve, score: this.config.score, location: this.config.location, coverage: this.config.coverage, readings: this.config.readings },
      start: this.deployment.start,
      epoch: Number(epoch),
      emissionNow: emission(curve, epoch).toString(),
      schedule: [0, 1, 24, 168, 730, 1460, 2190].map((e) => ({ epoch: e, emission: emission(curve, e).toString() })),
      devices: Number(count),
      emitted: emitted.toString(),
      owed: owed.toString(),
      claimedUpTo: this.state.claimedUpTo,
      epochs,
      latest: latest ? latest.epoch : null,
      stations
    }
  }
}
