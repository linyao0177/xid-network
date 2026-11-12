// A network's config: what it rewards and how. It is fixed when the network
// is deployed: DepinNetwork.configHash is keccak256 of its canonical JSON,
// and the oracles' job carries the config itself (its params).
//
// templates/*.json are configs for networks of one kind (weather, air
// quality, energy); a network starts from one and changes what it needs.

import fs from 'fs'
import { keccak256, toUtf8Bytes } from 'ethers'
import { curveOf } from './curve.js'

export const MODES = ['uptime', 'energy']

// JSON with keys in order: one spelling of a config, so one hash
export function canonical (v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  return JSON.stringify(v)
}

export const configHash = (config) => keccak256(toUtf8Bytes(canonical(config)))

export function loadTemplate (name) {
  const url = new URL(`../templates/${name}.json`, import.meta.url)
  if (!fs.existsSync(url)) throw new Error(`no template "${name}" (there are: ${templates().join(', ')})`)
  return JSON.parse(fs.readFileSync(url, 'utf8'))
}

export function templates () {
  return fs.readdirSync(new URL('../templates/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
}

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi

// what is wrong with a config, or null
export function configProblem (c) {
  if (!c || typeof c !== 'object' || c.v !== 1) return 'v must be 1'
  if (typeof c.name !== 'string' || !/^[a-z0-9-]{1,40}$/.test(c.name)) return 'name: a-z, 0-9 and -'
  const e = c.epoch
  if (!e || !int(e.length, 10, 30 * 86400) || !int(e.slots, 1, 1440) || e.length % e.slots) return 'epoch: length (s) and slots, the length a multiple of the slots'
  try { curveOf(c.curve) } catch (err) { return err.message }
  const r = c.readings
  if (!r || typeof r.topic !== 'string' || !/^[a-z0-9-]{1,32}$/.test(r.topic)) return 'readings.topic'
  if (!r.fields || typeof r.fields !== 'object' || !Object.keys(r.fields).length) return 'readings.fields'
  for (const [k, f] of Object.entries(r.fields)) if (!/^[a-z0-9_]{1,16}$/.test(k) || !f || !Number.isInteger(f.min) || !Number.isInteger(f.max) || f.min > f.max) return `readings.fields.${k}: integer min and max`
  if (r.crossCheck) {
    const x = r.crossCheck
    if (!(x.field in r.fields) || !int(x.resolution, 0, 15) || !int(x.tolerance, 0, 1e9) || !int(x.min, 2, 1000)) return 'readings.crossCheck: field, resolution, tolerance, min'
  }
  const l = c.location
  if (!l || !int(l.resolution, 0, 15) || !int(l.kmPerMs, 1, 300) || !int(l.slackKm, 0, 20000) || !int(l.minViolations, 1, 32)) return 'location: resolution, kmPerMs, slackKm, minViolations'
  if (l.maxRttMs !== undefined && !int(l.maxRttMs, 1, 10000)) return 'location.maxRttMs: 1 to 10000 ms'
  const cov = c.coverage || {}
  if (cov.poc) {
    const p = cov.poc
    if (!int(p.rangeCells, 1, 1000) || !int(p.minWitnesses, 1, 32) || !int(p.maxWitnesses, p.minWitnesses, 64) || !int(p.txDbm, -10, 36) || !int(p.rssiMin, -130, 0)) return 'coverage.poc: rangeCells, minWitnesses, maxWitnesses, txDbm, rssiMin'
  }
  if (cov.hex && (!int(cov.hex.resolution, 0, l.resolution) || !int(cov.hex.target, 1, 1000))) return 'coverage.hex: resolution (at most the location\'s) and target'
  const s = c.score
  if (!s || !MODES.includes(s.mode)) return 'score.mode: ' + MODES.join(' or ')
  if (s.mode === 'uptime') {
    const w = s.weights || {}
    if (!int(w.uptime ?? -1, 0, 10000) || !int(w.quality ?? -1, 0, 10000) || !int(w.coverage ?? -1, 0, 10000) || w.uptime + w.quality + w.coverage !== 10000) return 'score.weights: uptime + quality + coverage = 10000'
    if (w.coverage > 0 && !cov.poc) return 'score.weights.coverage needs coverage.poc'
  } else {
    if (!(s.field in r.fields) || !int(s.maxPowerW, 1, 1e9)) return 'score: field (a meter in mWh, counting up) and maxPowerW'
  }
  return null
}

export function checkConfig (c) {
  const p = configProblem(c)
  if (p) throw new Error('config: ' + p)
  return c
}
