// The reward curves in JS give what the contract gives: node test/curve.js
// (needs anvil)

import { ContractFactory, HDNodeWallet, ZeroAddress } from 'ethers'
import { startChain, MNEMONIC } from 'boat-registry/test/chain.js'
import { curveOf, emission } from '../lib/curve.js'
import { loadTemplate, templates } from '../lib/config.js'
import NETWORK from '../artifacts/DepinNetwork.json' with { type: 'json' }

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }

const chain = await startChain(8571)
if (!chain) { console.log('SKIP no anvil'); process.exit(0) }
try {
  const admin = HDNodeWallet.fromPhrase(MNEMONIC).connect(chain.provider)
  const curves = {
    ...Object.fromEntries(templates().map((t) => [t, loadTemplate(t).curve])),
    constant: { kind: 'constant', initial: '7e18', end: 100 },
    linear: { kind: 'linear', initial: '1000e18', rate: '3.3e18', floor: '1e18' },
    exponential: { kind: 'exponential', initial: '123456789e9', rate: '0.0137e18' }
  }
  for (const [name, c] of Object.entries(curves)) {
    const curve = curveOf(c)
    const f = new ContractFactory(NETWORK.abi, NETWORK.bytecode, admin)
    const net = await f.deploy(ZeroAddress, '0x' + '11'.repeat(32), '0x' + '00'.repeat(32), ZeroAddress, false, 0, 86400, 0, 0, curve)
    await net.waitForDeployment()
    const es = [0, 1, 2, 9, 10, 99, 100, 364, 365, 729, 730, 731, 1094, 1095, 2000, 5000, 100000]
    let bad = null
    for (const e of es) {
      const a = emission(curve, e)
      const b = await net.emission(e)
      if (a !== b) { bad = `epoch ${e}: js ${a} contract ${b}`; break }
    }
    check(`${name}: JS and contract agree on ${es.length} epochs`, !bad, bad || '')
  }
} finally {
  chain.anvil.kill()
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
