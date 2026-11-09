// Sealed telemetry, C (components/boat_device seal.c) against JS: node test/sealed.js
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import HyperDHT from 'hyperdht'
import { sealEnvelope, openEnvelope, encrypt, decrypt, KeyRing } from '../index.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}
const dir = new URL('../../../components/boat_device/', import.meta.url).pathname
const sodium = ['/opt/homebrew', '/usr/local', '/usr'].find((p) => fs.existsSync(path.join(p, 'include', 'sodium.h')))
if (!sodium) {
  console.log('SKIP: no libsodium')
  process.exit(0)
}
const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seal-')), 'test_seal')
execFileSync('clang', ['-O1', '-Wall', '-Werror', '-I' + path.join(dir, 'include'), '-I' + path.join(sodium, 'include'), path.join(dir, 'seal.c'), path.join(dir, 'test', 'test_seal.c'), '-L' + path.join(sodium, 'lib'), '-lsodium', '-o', bin])
const c = (...args) => execFileSync(bin, args.map(String)).toString().trim()

const owner = HyperDHT.keyPair(crypto.randomBytes(32))
const ownerSeed = crypto.randomBytes(32)
const ownerKp = HyperDHT.keyPair(ownerSeed)
const compute = HyperDHT.keyPair()
const stranger = HyperDHT.keyPair()
const key = crypto.randomBytes(32)
const topic = 'd/' + 'ab'.repeat(32) + '/telemetry'

// C seals the key; JS opens it
const envC = Buffer.from(c('envelope', 7, key.toString('hex'), ownerKp.publicKey.toString('hex'), compute.publicKey.toString('hex')), 'hex')
const o = openEnvelope(envC, compute)
check('a key the device (C) seals to its readers, a reader opens (JS)', o && o.keyId === 7 && o.key.equals(key) && openEnvelope(envC, stranger) === null)
// JS seals; C opens
const envJ = sealEnvelope(9, key, [ownerKp.publicKey])
check('and the other way round; someone else cannot', c('open', envJ.toString('hex'), ownerSeed.toString('hex')) === `9 ${key.toString('hex')}` && c('open', envJ.toString('hex'), crypto.randomBytes(32).toString('hex')) === 'NONE')
// readings
const text = '{"seq":1,"mwh":1234}'
const sealedC = Buffer.from(c('encrypt', key.toString('hex'), 7, topic, text), 'hex')
check('a reading the device seals, a reader with the key opens; on another topic it does not', decrypt(key, topic, sealedC)?.toString() === text && decrypt(key, topic + 'x', sealedC) === null)
const sealedJ = encrypt(key, 7, topic, Buffer.from(text))
check('and C opens what JS seals; a changed byte is refused', c('decrypt', key.toString('hex'), topic, sealedJ.toString('hex')) === text && (() => { const b = Buffer.from(sealedJ); b[40] ^= 1; return c('decrypt', key.toString('hex'), topic, b.toString('hex')) === 'BAD' })())
const ring = new KeyRing(compute)
ring.add('ab'.repeat(32), envC)
check('a key ring opens the readings of the keys it holds', ring.open('ab'.repeat(32), topic, sealedC)?.toString() === text && new KeyRing(stranger).open('ab'.repeat(32), topic, sealedC) === null)
void owner
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
