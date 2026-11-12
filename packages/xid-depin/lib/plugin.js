// The boat-node plugin: compute nodes that load it are oracles of the DePIN
// networks whose jobs they are assigned (lib/oracle.js).
//
// node.json: { "plugins": { "xid-depin": { "lat": 25.03, "lon": 121.56 } } }
// lat, lon: where the node is (its round trips to devices bound where they
// can be). Optional: collectMs, waitMs, pingMs.

import { SPEC } from 'boat-registry'
import { Oracle } from './oracle.js'

export function plugin (opts = {}) {
  // one oracle per node and job, ever running at once: two would each sign
  // the job's units, maybe differently (double work, slashed)
  const running = new Map() // node -> Map(job id -> Oracle)
  return {
    name: 'xid-depin',
    spec: SPEC.depin,
    async createWorker ({ node, job }) {
      if (!running.has(node)) running.set(node, new Map())
      const mine = running.get(node)
      const was = mine.get(job.id)
      if (was && !was.closed) return was
      const o = new Oracle({ node, job, ...opts })
      mine.set(job.id, o)
      o.start().catch((err) => o.emit('error', err))
      return o
    }
  }
}
