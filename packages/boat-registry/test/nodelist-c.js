// The node list in C (hyperdht-esp32's components/hdht_mqtt nodelist.c, the
// third_party submodule) against the JS:
// node test/nodelist-c.js (needs clang and libsodium)
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { encodeNodeList, decodePage, tally } from '../index.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}

const dir = new URL('../../../third_party/hyperdht-esp32/components/hdht_mqtt/', import.meta.url).pathname
const sodium = ['/opt/homebrew', '/usr/local', '/usr'].find((p) => fs.existsSync(path.join(p, 'include', 'sodium.h')))
if (!sodium) {
  console.log('SKIP: no libsodium')
  process.exit(0)
}
const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nodelist-')), 'test_nodelist')
execFileSync('clang', ['-O1', '-Wall', '-Werror', '-I' + path.join(dir, 'include'), '-I' + path.join(sodium, 'include'), path.join(dir, 'nodelist.c'), path.join(dir, 'test', 'test_nodelist.c'), '-L' + path.join(sodium, 'lib'), '-lsodium', '-o', bin])

const key = () => crypto.randomBytes(32).toString('hex')
const list = (epoch, nodes, verifiers = [key(), key(), key()]) => ({ chainId: 5042002n, registry: '0x' + 'ab'.repeat(20), epoch: BigInt(epoch), verifiers, nodes })
const record = (l) => Buffer.from(JSON.stringify({ v: 1, boat_nodes: encodeNodeList(l).main.toString('base64') }))
const c = (trusted, pick, page, recs) => execFileSync(bin, [String(trusted), String(pick), page ? page.toString('hex') : '-', ...recs.map((r) => (r ? r.toString('hex') : '-'))]).toString().trim()
// the JS answer for the same inputs
const js = (trusted, pick, page, recs) => {
  const blob = (r) => {
    try { return Buffer.from(JSON.parse(r).boat_nodes, 'base64') } catch { return null }
  }
  const t = tally(recs.map((r) => (r ? blob(r) : null)), trusted)
  if (!t) return 'NONE'
  const i = t.list.pages.length ? pick % t.list.pages.length : 0
  let nodes = []
  if (t.list.pages.length) {
    const ok = page && t.list.pages[i] === Buffer.from(blake(page)).toString('hex')
    if (!ok) return 'BADPAGE'
    nodes = decodePage(page)
  }
  return `${t.list.epoch} ${t.votes} ${i} ${t.list.verifiers.join(",")} ${nodes.join(",")}`.trim()
}
const blake = (b) => {
  const out = Buffer.alloc(32)
  sodiumJs.crypto_generichash(out, b)
  return out
}
const sodiumJs = (await import('sodium-universal')).default
const same = (name, trusted, pick, page, recs, expect) => {
  const a = c(trusted, pick, page, recs)
  const b = js(trusted, pick, page, recs)
  check(name, a === b && expect(a), a.slice(0, 44) + (a.length > 44 ? '…' : ''))
}

const A = list(7, Array.from({ length: 60 }, key)) // three pages: 28 + 28 + 4
const B = { ...A, nodes: [key()] }
const newer = { ...A, epoch: 8n }
const pagesA = encodeNodeList(A).pages
same('three verifiers agree; page 0 of 3', 3, 0, pagesA[0], [record(A), record(A), record(A)], (r) => r.startsWith('7 3 0 ') && r.split(' ')[4].split(',').length === 28)
same('a device\'s pick chooses the page: 5 % 3 = page 2 (4 nodes)', 3, 5, pagesA[2], [record(A), record(A), record(A)], (r) => r.startsWith('7 3 2 ') && r.split(' ')[4].split(',').length === 4)
same('a page that is not the one the list names is refused', 3, 1, pagesA[0], [record(A), record(A), record(A)], (r) => r === 'BADPAGE')
same('two of three agree; the third\'s list is left out', 3, 0, pagesA[0], [record(A), record(B), record(A)], (r) => r.startsWith('7 2 0 '))
same('one list alone is no quorum', 3, 0, null, [record(B), null, null], (r) => r === 'NONE')
same('the newest epoch a quorum agrees on wins', 3, 0, encodeNodeList(newer).pages[0], [record(A), record(newer), record(newer)], (r) => r.startsWith('8 2 '))
same('an older epoch with a quorum is taken when the newer has none', 3, 0, pagesA[0], [record(A), record(A), record(newer)], (r) => r.startsWith('7 2 '))
same('four trusted need three', 4, 0, null, [record(A), record(A), record(B), null], (r) => r === 'NONE')
const broken = Buffer.from(JSON.stringify({ v: 1, boat_nodes: encodeNodeList(A).main.subarray(0, 50).toString('base64') }))
same('cut or foreign records count as none', 3, 0, null, [broken, Buffer.from('{"v":1,"mqtt":"x"}'), record(A)], (r) => r === 'NONE')
const full = list(9, Array.from({ length: 224 }, key), Array.from({ length: 10 }, key))
const fullRecord = record(full)
same('a full list: 10 verifiers, 224 nodes on 8 pages; the main record still fits', 3, 7, encodeNodeList(full).pages[7], [fullRecord, fullRecord, null], (r) => r.startsWith('9 2 7 ') && r.split(' ')[3].split(',').length === 10 && fullRecord.length < 1000, `record ${fullRecord.length} bytes`)
const empty = list(10, [])
same('a list with no nodes has no pages', 3, 0, null, [record(empty), record(empty), record(empty)], (r) => r.startsWith('10 3 0 '))
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
