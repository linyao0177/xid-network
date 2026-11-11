// Paid reads from storage nodes over a payment channel (contracts/BoatReads.sol).
//
// A store sells the blocks of the devices it keeps. Its record says how:
// { read_price, reads: <BoatReads address>, operator }. A reader opens a
// channel with a deposit (BoatReads.open), then puts on every block request
// its signature on how much it owes the store in all, `price` more than the
// last time. The store answers while that sum grows and keeps the latest one;
// it redeems now and then (BoatReads.redeem). Index and head are free, and so
// are a few blocks per remote key and window, for the verifiers' spot checks.

import { getBytes } from 'ethers'
import { recoverSigner } from './recover.js'
import { readStatementOf } from './registry.js'

// the store's side: authorize() for boat-mqtt-node's store, and redeem()
export class ReadSeller {
  constructor ({ reads, operator, price, freeBlocks = 8, windowMs = 600000, redeemEvery = 50, tx = (fn) => fn() }) {
    this.reads = reads.connect(operator) // BoatReads, with the store operator's wallet
    this.operator = operator
    this.price = BigInt(price)
    this.freeBlocks = freeBlocks
    this.windowMs = windowMs
    this.redeemEvery = redeemEvery
    this.tx = tx
    this.free = new Map() // remote key -> { at, n }
    this.owed = new Map() // reader -> { generation, cumulative, signature, redeemed, since }
    this.channels = new Map() // reader -> { at, c }
    this.stats = { paid: 0, free: 0, refused: 0, redeemed: 0n }
  }

  async ready () {
    this.ctx = { reads: await this.reads.getAddress(), chainId: (await this.reads.runner.provider.getNetwork()).chainId }
    return this
  }

  // what goes in the store's record
  terms () {
    return { read_price: String(this.price), reads: this.ctx.reads, operator: this.operator.address }
  }

  async channel (reader) {
    const c = this.channels.get(reader)
    if (c && Date.now() - c.at < 30000) return c.c
    const fresh = await this.reads.channels(reader, this.operator.address)
    this.channels.set(reader, { at: Date.now(), c: fresh })
    return fresh
  }

  authorize = async (req, remote) => {
    const v = req.voucher
    if (!v) {
      const f = this.free.get(remote) || { at: Date.now(), n: 0 }
      if (Date.now() - f.at > this.windowMs) Object.assign(f, { at: Date.now(), n: 0 })
      if (remote && f.n < this.freeBlocks) {
        f.n++
        this.free.set(remote, f)
        this.stats.free++
        return null
      }
      this.stats.refused++
      return `payment required: ${this.price} per block (reads ${this.ctx.reads}, store ${this.operator.address})`
    }
    let reader
    try {
      reader = recoverSigner(readStatementOf(this.ctx, v.reader, this.operator.address, BigInt(v.generation), BigInt(v.cumulative)), v.signature)
    } catch {}
    if (!reader || reader !== v.reader) return this._refuse('voucher not signed by the reader')
    const c = await this.channel(reader)
    const cumulative = BigInt(v.cumulative)
    if (BigInt(v.generation) !== c.generation) return this._refuse('voucher of another channel')
    if (c.closesAt !== 0n && BigInt(Math.floor(Date.now() / 1000)) >= c.closesAt) return this._refuse('channel closed')
    if (cumulative > c.deposit) return this._refuse('voucher above the deposit')
    const o = this.owed.get(reader) || { generation: c.generation, cumulative: c.redeemed, redeemed: c.redeemed, since: 0 }
    if (o.generation !== c.generation) Object.assign(o, { generation: c.generation, cumulative: c.redeemed, redeemed: c.redeemed, since: 0 })
    if (cumulative < o.cumulative + this.price) return this._refuse(`voucher must owe ${this.price} more`)
    Object.assign(o, { cumulative, signature: v.signature, since: o.since + 1 })
    this.owed.set(reader, o)
    this.stats.paid++
    if (o.since >= this.redeemEvery) this.redeem(reader).catch(() => {})
    return null
  }

  _refuse (why) {
    this.stats.refused++
    return why
  }

  // redeems what a reader owes (or every reader's)
  async redeem (reader = null) {
    for (const [r, o] of this.owed) {
      if (reader && r !== reader) continue
      if (o.cumulative <= o.redeemed) continue
      const cumulative = o.cumulative
      await this.tx(async () => (await this.reads.redeem(r, cumulative, o.signature)).wait())
      this.stats.redeemed += cumulative - o.redeemed
      o.redeemed = cumulative
      o.since = 0
      this.channels.delete(r)
    }
  }
}

// the reader's side: pay() for boat-mqtt-node's openLog
export class ReadPayer {
  constructor ({ reads, reader, store, price }) {
    this.reads = reads
    this.reader = reader // the reader's wallet
    this.store = store // the store's operator address
    this.price = BigInt(price)
    this.cumulative = null
  }

  // opens (or adds to) the channel
  async open (amount, token) {
    await (await token.connect(this.reader).approve(await this.reads.getAddress(), amount)).wait()
    await (await this.reads.connect(this.reader).open(this.store, amount)).wait()
    return this.sync()
  }

  async sync () {
    this.ctx = { reads: await this.reads.getAddress(), chainId: (await this.reads.runner.provider.getNetwork()).chainId }
    const c = await this.reads.channels(this.reader.address, this.store)
    this.generation = c.generation
    if (this.cumulative === null || this.cumulative < c.redeemed) this.cumulative = c.redeemed
    return this
  }

  pay = async () => {
    this.cumulative += this.price
    const signature = await this.reader.signMessage(getBytes(readStatementOf(this.ctx, this.reader.address, this.store, this.generation, this.cumulative)))
    return { voucher: { reader: this.reader.address, generation: String(this.generation), cumulative: String(this.cumulative), signature } }
  }
}
