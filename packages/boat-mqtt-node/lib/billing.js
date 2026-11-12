// Pay per message: a node charges what each key publishes and is paid with
// EIP-3009 authorizations (USD₮, USDC), the payments BoAT MER devices sign.
//
// - Terms. The node puts its price and payee in its own HyperDHT record
//   (under its key, so signed by it), a flat JSON object of strings:
//     {"v":"1","mqtt_node":"1","pay":"0x..","token":"0x..","chain_id":"2201",
//      "domain_name":"USD₮0","domain_version":"1","price_msg":"100",
//      "price_kb":"1000","credit":"20000"}
//   A device reads it before it pays, so the node cannot ask it to pay
//   anyone else or in another token.
// - Metering. For each key: owed = price_msg × messages + ceil(price_kb ×
//   bytes / 1024), payload bytes. A device can count the same thing itself.
// - Invoices. The node publishes {"invoice","owed","paid","due","pay",
//   "token","chain_id","receipt"} to d/<node>/to/<device>/invoice (receipt:
//   the node's signed receipt for the key's signed messages, receipts.js), every few seconds
//   while something is due, and at once when half the credit is used.
// - Payments. The device publishes an authorization to
//   d/<device>/to/<node>/pay: {"from","to","value","validAfter",
//   "validBefore","nonce","signature","invoice"}. The node checks that the
//   signer is the wallet in the device's DID record (boat-peer), that it pays
//   the payee no more than is due, that it is valid long enough to settle, and
//   that its nonce is new. Paying is free and always allowed.
//   Nonces are remembered in memory, until the authorization runs out: after
//   a restart a payment sent again within its validity is taken again here
//   (and what was owed is forgotten too). The token contract takes a nonce
//   once, so it does not settle twice; to refuse it here as well, the nonces
//   and the accounts would have to be kept on disk, and a node has no state
//   directory yet.
// - Credit. While more than `credit` is due, the node refuses the key's other
//   publishes (and so closes its connection).
// - Settlement is not done here: each good payment is a 'payment' event with
//   an authorization that wdk-protocol-boat-evm settles, one by one or in
//   batches (packages/wdk-protocol-boat-evm/examples/mqtt-node.js).

import { EventEmitter } from 'events'
import { createRequire } from 'module'
import { hex } from './topics.js'

const require = createRequire(import.meta.url)
const { eth, verifyRecord } = require('boat-peer')

const MIN_VALIDITY_S = 120 // an authorization must stay valid this long to be settled
const RECORD_MS = 60 * 60 * 1000 // DHT nodes drop a record after about 48 hours: put again long before

export class Billing extends EventEmitter {
  constructor (node, opts) {
    super()
    for (const k of ['payee', 'token', 'chainId', 'domain']) if (!opts[k]) throw new Error('billing needs ' + k)
    this.node = node
    this.price = { message: BigInt(opts.price?.message ?? 0), kb: BigInt(opts.price?.kb ?? 0) }
    this.credit = BigInt(opts.credit ?? 0)
    this.payee = opts.payee.toLowerCase()
    this.token = opts.token.toLowerCase()
    this.chainId = Number(opts.chainId)
    this.domain = { name: opts.domain.name, version: opts.domain.version, chainId: this.chainId, verifyingContract: opts.token }
    this.invoiceMs = opts.invoiceMs || 10000
    this.recordMs = opts.recordMs === undefined ? RECORD_MS : opts.recordMs // 0: the terms are put once
    // keys are free to make: beyond this many accounts, the one idle longest
    // is dropped (and what it owed, less than the credit, with it)
    this.maxAccounts = opts.maxAccounts || 100000
    this.accounts = new Map() // key hex -> { messages, bytes, paid, invoice, lastInvoice }, the busiest last
    this._nonces = new Map() // from + nonce -> validBefore (s): kept while the authorization could be sent again
    this._pruned = Date.now()
    this._wallets = new Map() // key hex -> Promise<address | null>
    this._timer = null
    this._recordTimer = null
  }

  terms () {
    return {
      v: '1',
      mqtt_node: '1',
      pay: this.payee,
      token: this.token,
      chain_id: String(this.chainId),
      domain_name: this.domain.name,
      domain_version: this.domain.version,
      price_msg: String(this.price.message),
      price_kb: String(this.price.kb),
      credit: String(this.credit)
    }
  }

  _putTerms () {
    return this.node.dht.mutablePut(this.node.keyPair, Buffer.from(JSON.stringify(this.terms())), { seq: Math.floor(Date.now() / 1000) })
  }

  async start () {
    const put = await this._putTerms()
    this._timer = setInterval(() => this._invoiceAll(), this.invoiceMs)
    this._timer.unref()
    if (this.recordMs) {
      this._recordTimer = setInterval(() => this._putTerms().catch(() => {}), this.recordMs)
      this._recordTimer.unref()
    }
    return put
  }

  stop () {
    clearInterval(this._timer)
    clearInterval(this._recordTimer)
  }

  _account (key) {
    let a = this.accounts.get(key)
    if (!a) {
      a = { messages: 0n, bytes: 0n, paid: 0n, invoice: 0, lastInvoice: 0 }
      this.accounts.set(key, a)
      if (this.accounts.size > this.maxAccounts) {
        const idle = this.accounts.keys().next().value
        this.accounts.delete(idle)
        this._wallets.delete(idle)
      }
    }
    return a
  }

  owed (a) {
    return this.price.message * a.messages + (this.price.kb * a.bytes + 1023n) / 1024n
  }

  due (key) {
    const a = this.accounts.get(key)
    return a ? this.owed(a) - a.paid : 0n
  }

  payTopic (key) {
    return `d/${key}/to/${hex(this.node.publicKey)}/pay`
  }

  // called for each publish of a key: { ok } or { ok: false, reason }
  meter (key, topic, bytes) {
    if (topic === this.payTopic(key)) return { ok: true, free: true }
    const a = this._account(key)
    if (this.owed(a) - a.paid > this.credit) return { ok: false, reason: 'payment required' }
    a.messages++
    a.bytes += BigInt(bytes)
    this.accounts.delete(key) // (in time order: the busiest last)
    this.accounts.set(key, a)
    const due = this.owed(a) - a.paid
    if (due * 2n >= this.credit && Date.now() - a.lastInvoice > 2000) this.invoice(key)
    return { ok: true }
  }

  invoice (key) {
    const a = this._account(key)
    const owed = this.owed(a)
    if (owed <= a.paid) return
    a.invoice++
    a.lastInvoice = Date.now()
    const body = { invoice: String(a.invoice), owed: String(owed), paid: String(a.paid), due: String(owed - a.paid), pay: this.payee, token: this.token, chain_id: String(this.chainId) }
    // what the node signs it got from this key, so the bill can be checked against it
    if (this.node.receipts && this.node.receipts.devices.has(key)) body.receipt = this.node.receipts.receipt(key)
    this.node.broker.publish({ cmd: 'publish', topic: `d/${hex(this.node.publicKey)}/to/${key}/invoice`, payload: Buffer.from(JSON.stringify(body)), qos: 1, retain: false }, () => {})
    this.emit('invoice', { key, ...body })
  }

  _invoiceAll () {
    if (Date.now() - this._pruned > 60000) this._pruneNonces()
    for (const [key, a] of this.accounts) if (this.owed(a) > a.paid && Date.now() - a.lastInvoice >= this.invoiceMs - 50) this.invoice(key)
  }

  // nonces of authorizations that ran out: they are refused for that now
  _pruneNonces (now = Date.now()) {
    this._pruned = now
    for (const [n, validBefore] of this._nonces) if (validBefore * 1000 < now) this._nonces.delete(n)
  }

  // the wallet a device's DID record names, checked (boat-peer verifyRecord)
  _wallet (key) {
    if (!this._wallets.has(key)) {
      const p = this.node.dht.mutableGet(Buffer.from(key, 'hex'), { latest: true }).then((res) => {
        const r = res && verifyRecord(Buffer.from(key, 'hex'), res.value)
        return r ? r.eth.toLowerCase() : null
      })
      p.then((w) => { if (!w) this._wallets.delete(key) }, () => this._wallets.delete(key))
      this._wallets.set(key, p)
    }
    return this._wallets.get(key)
  }

  async pay (key, payload) {
    const refuse = (reason) => {
      this.emit('payment-refused', { key, reason })
      return { ok: false, reason }
    }
    let p
    try {
      p = JSON.parse(payload)
    } catch {
      return refuse('not JSON')
    }
    const a = this._account(key)
    const now = Math.floor(Date.now() / 1000)
    let value
    try {
      value = BigInt(p.value)
    } catch {
      return refuse('bad value')
    }
    if (String(p.to).toLowerCase() !== this.payee) return refuse('not our payee')
    if (value <= 0n || value > this.owed(a) - a.paid) return refuse(`value ${value} is not between 1 and the ${this.owed(a) - a.paid} due`)
    if (Number(p.validAfter) > now || Number(p.validBefore) < now + MIN_VALIDITY_S) return refuse('not valid now, or not long enough')
    const nonce = String(p.from).toLowerCase() + String(p.nonce).toLowerCase()
    if (!/^0x[0-9a-fA-F]{64}$/.test(p.nonce) || this._nonces.has(nonce)) return refuse('nonce reused')
    // taken now, before anything is awaited: of the same authorization sent
    // twice at once only one may pass. Given back if this one is refused.
    this._nonces.set(nonce, Number(p.validBefore))
    const release = (reason) => {
      this._nonces.delete(nonce)
      return refuse(reason)
    }
    const authorization = { from: p.from, to: p.to, value: String(value), validAfter: Number(p.validAfter), validBefore: Number(p.validBefore), nonce: p.nonce, signature: p.signature }
    let signer
    try {
      signer = eth.verifyTransfer(this.domain, authorization, p.signature).toLowerCase()
    } catch {
      return release('bad signature')
    }
    const wallet = await this._wallet(key).catch(() => null)
    if (!wallet) return release('no valid DID record with a wallet')
    if (signer !== wallet || String(p.from).toLowerCase() !== wallet) return release('not signed by the wallet in its DID record')
    if (value > this.owed(a) - a.paid) return release('paid meanwhile')
    a.paid += value
    const result = { key, authorization, invoice: p.invoice, owed: String(this.owed(a)), paid: String(a.paid) }
    this.emit('payment', result)
    return { ok: true, ...result }
  }

  summary () {
    return Object.fromEntries([...this.accounts].map(([k, a]) => [k, { messages: Number(a.messages), bytes: Number(a.bytes), owed: String(this.owed(a)), paid: String(a.paid), invoices: a.invoice }]))
  }
}
