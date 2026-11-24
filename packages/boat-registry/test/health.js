// The testnet's health check (lib/health.js), no chain: node test/health.js

import { Interface } from 'ethers'
import { REGISTRY } from '../index.js'
import { assess, BATCH_SETTLED_TOPIC, countSettlements, missedBatches, SETTLE_SELECTORS } from '../lib/health.js'

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  ok ? passed++ : failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}

const now = 1795430000000
const hour = Math.floor(now / 3600000) * 3600 - 3600
const node = (name, gas, extra = {}) => ({ name, gas: String(gas), public: true, active: true, online: true, ...extra })
const snap = (over = {}) => ({
  at: now - 30000,
  totals: { devicesLive: 2, openJobs: 4, lastSettledAt: now / 1000 - 600 },
  nodes: [node('a', 0.3), node('b', 0.2)],
  hours: [{ hour, units: 24, txs: 4 }],
  ...over
})
const codes = (r) => r.alerts.map((a) => a.code)

const abi = new Interface(REGISTRY.abi)
check('the selectors are settleMany and settleBatchMany', SETTLE_SELECTORS[0] === abi.getFunction('settleMany').selector && SETTLE_SELECTORS[1] === abi.getFunction('settleBatchMany').selector)

check('a working network is healthy', assess(snap(), { now, sent: { hour, count: 4 } }).ok)
check('an old snapshot is an alert', codes(assess(snap({ at: now - 11 * 60000 }), { now })).includes('stale-snapshot'))
check('a node low on gas is an alert', codes(assess(snap({ nodes: [node('a', 0.3), node('b', 0.01)] }), { now })).includes('low-gas'))
check('a node that is not public does not count', assess(snap({ nodes: [node('a', 0.3), node('x', 0, { public: false })] }), { now }).ok)
check('an offline node is an alert', codes(assess(snap({ nodes: [node('a', 0.3), node('b', 0.3, { online: false })] }), { now })).includes('node-offline'))

const quiet = (ms, totals = {}) => snap({ totals: { devicesLive: 2, openJobs: 4, lastSettledAt: (now - ms) / 1000, ...totals } })
check('74 minutes without a settlement is not an alert', assess(quiet(74 * 60000), { now }).ok)
check('76 minutes without a settlement is', codes(assess(quiet(76 * 60000), { now })).includes('not-settling'))
check('silence with no live device is not an alert', assess(quiet(5 * 3600000, { devicesLive: 0 }), { now }).ok)
check('no settlement in the 48 hours shown, with devices live, is an alert', codes(assess(snap({ totals: { devicesLive: 2, openJobs: 4 }, hours: [{ hour, units: 0, txs: 0 }] }), { now })).includes('not-settling'))
const older = snap({ totals: { devicesLive: 2, openJobs: 4 }, hours: [{ hour: hour - 3600 * 3, units: 6, txs: 1 }, { hour, units: 0, txs: 0 }] })
check('a hub that does not report the time falls back on the hours', codes(assess(older, { now })).includes('not-settling'))

const lists = (over) => snap({ totals: { devicesLive: 1, openJobs: 1, lastSettledAt: (now - 5 * 3600000) / 1000 }, jobs: [{ id: 1 }, { id: 2, closesAt: 123 }], devices: [], ...over })
check('a live device with no open job is not work', assess(lists({ devices: [{ last: now, jobs: [2] }] }), { now }).ok)
check('a live device with an open job is', codes(assess(lists({ devices: [{ last: now, jobs: [1] }] }), { now })).includes('not-settling'))
check('an open job on an offline device is not', assess(lists({ devices: [{ last: now - 3600000, jobs: [1] }] }), { now }).ok)
check('an open DePIN job is work with no device live', codes(assess(lists({ depin: { job: 1 } }), { now })).includes('not-settling'))

check('a few transactions that lost a race are not an alert', assess(snap(), { now, sent: { hour, count: 8 } }).ok)
const burning = assess(snap(), { now, sent: { hour, count: 104 } })
check('100 of 104 transactions settling nothing is an alert', codes(burning).includes('empty-settlements') && burning.metrics.empty === 100)
check('an explorer that did not answer is no alert', assess(snap(), { now, sent: null }).ok)

const at = (s) => new Date(s * 1000).toISOString()
const items = [
  { timestamp: at(hour + 3700), raw_input: `${SETTLE_SELECTORS[0]}00` },
  { timestamp: at(hour + 100), raw_input: `${SETTLE_SELECTORS[1]}00` },
  { timestamp: at(hour + 50), method: SETTLE_SELECTORS[0] },
  { timestamp: at(hour + 40), raw_input: '0xdeadbeef00' },
  { timestamp: at(hour - 10), raw_input: `${SETTLE_SELECTORS[1]}00` }
]
const counted = countSettlements(items, hour, hour + 3600)
check('only settlements inside the hour count, and the list ends at an older one', counted.count === 2 && counted.done === true, JSON.stringify(counted))

check('the batch topic is BatchSettled', BATCH_SETTLED_TOPIC === abi.getEvent('BatchSettled').topicHash)
const BOOT = 1795431724n
const settledBatch = (job, index, block, boot = BOOT) => ({ job, batch: (boot << 32n) | BigInt(index), block })
const live = [settledBatch(70, 1, 100), settledBatch(70, 3, 200), settledBatch(70, 4, 300), settledBatch(71, 1, 100), settledBatch(71, 2, 150), settledBatch(71, 3, 200)]
const gap = missedBatches(live, 0, 1000)
check('a batch skipped between two settled ones is found', gap.length === 1 && gap[0].job === 70 && gap[0].batch === `${BOOT}:2`, JSON.stringify(gap))
check('...in any order of settling', missedBatches([...live].reverse(), 0, 1000).length === 1)
check('an old gap is not news', missedBatches(live, 201, 1000).length === 0)
check('a very new gap may be batches settling out of order', missedBatches(live, 0, 199).length === 0)
check('batches of two boots leave no gap between them', missedBatches([settledBatch(70, 5, 100), settledBatch(70, 0, 200, BOOT + 1n)], 0, 1000).length === 0)
check('several batches skipped are each named', missedBatches([settledBatch(70, 1, 100), settledBatch(70, 4, 200)], 0, 1000).length === 2)
check('a skipped batch is an alert', codes(assess(snap(), { now, missed: gap })).includes('missed-batch'))
check('a chain that did not answer is no alert', assess(snap(), { now, missed: null }).ok)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
