// What the network costs a device and earns a node: node bench/economics.js [--json]
//
// Inputs are measured where we could (gas on Arc, gas per settled unit,
// what one node handled in bench/scale.js) and assumed where we could not
// (a VM's price, the return stake could earn elsewhere). Change them below.

const args = process.argv.slice(2)

const M = {
  gasPriceGwei: 25,          // Arc testnet, measured 2026-11-08 (gas is paid in USDC, 18 decimals)
  usdPerGasToken: 1,         // USDC
  gasPerUnitSingle: 120800,  // settle(), 3 signers, measured on Arc
  gasPerUnitBatched: 95000,  // settleMany(), about 20 units a transaction, measured in bench/scale.js
  readingEverySec: 30,       // the meter in the soak
  readingsPerUnit: 20,       // job window
  jobsPerDevice: 4,          // verify, store, compute, forward
  signersPerUnit: 3,         // quorum 2 + 1 spare
  vmUsdPerMonth: 13,         // an e2-small or a small VPS
  assignmentsPerVmNode: 300, // device-jobs one small node keeps up with (from bench/scale.js, scaled to 0.5 core)
  minStakeUsd: 100,          // a stake worth slashing; the test network uses 1
  stakeYield: 0.05,          // what the stake could earn elsewhere, per year
  margin: 0.2                // what a node operator wants above cost
}

const day = 86400
const unitsPerJobPerDay = (readingsPerUnit) => day / (M.readingEverySec * readingsPerUnit)
const gasUsd = (gas) => gas * M.gasPriceGwei * 1e-9 * M.usdPerGasToken

// a node's cost per day, and what it must earn per signature to cover it
function nodeCostPerDay () {
  return M.vmUsdPerMonth / 30 + (M.minStakeUsd * M.stakeYield) / 365
}

// the pay per unit that covers gas and the node's cost, with margin, when
// every node is full; and what a device then pays
function scenario (name, { readingsPerUnit, gasPerUnit, settlesPerUnit = 1 }) {
  const units = unitsPerJobPerDay(readingsPerUnit)
  const gas = gasUsd(gasPerUnit) * settlesPerUnit // paid by the submitter, out of the unit's pay
  const sigsPerNodePerDay = M.assignmentsPerVmNode * units
  const costPerSig = (nodeCostPerDay() * (1 + M.margin)) / sigsPerNodePerDay
  const pay = gas + costPerSig * M.signersPerUnit
  const devicePerMonth = pay * units * M.jobsPerDevice * 30
  return {
    scenario: name,
    unitsPerJobPerDay: +units.toFixed(1),
    gasPerUnitUsd: +gas.toFixed(6),
    payPerUnitUsd: +pay.toFixed(6),
    gasShareOfPay: +(gas / pay).toFixed(3),
    devicePerMonthUsd: +devicePerMonth.toFixed(2)
  }
}

// settling every unit on chain, as now; bigger units; and a root per epoch
// (each node submits one Merkle root of everything it signed in an hour and
// claims pay against it: the gas per unit falls with the number of units)
const unitsPerEpochPerNode = (readingsPerUnit) => M.assignmentsPerVmNode * unitsPerJobPerDay(readingsPerUnit) / 24
const rows = [
  scenario('every unit settled, one by one (iteration 2)', { readingsPerUnit: 20, gasPerUnit: M.gasPerUnitSingle }),
  scenario('every unit settled, in batches (now)', { readingsPerUnit: 20, gasPerUnit: M.gasPerUnitBatched }),
  scenario('units of an hour (120 readings), in batches', { readingsPerUnit: 120, gasPerUnit: M.gasPerUnitBatched }),
  scenario('units of a day (2,880 readings), in batches', { readingsPerUnit: 2880, gasPerUnit: M.gasPerUnitBatched }),
  // a root and its claim: about 150,000 gas an hour per node, plus about
  // 2,000 gas of claim proof per unit
  scenario('every unit, settled as one root per node per hour', { readingsPerUnit: 20, gasPerUnit: 150000 / unitsPerEpochPerNode(20) + 2000 })
]

// a device's 4 jobs each take 3 signers; a small node holds assignmentsPerVmNode of them
const out = {
  inputs: M,
  nodeCostPerDayUsd: +nodeCostPerDay().toFixed(3),
  devicesServedPerSmallNode: Math.round(M.assignmentsPerVmNode / M.jobsPerDevice),
  breakEvenNodesPer1000Devices: Math.ceil(1000 * M.jobsPerDevice * M.signersPerUnit / M.assignmentsPerVmNode),
  scenarios: rows
}

if (args.includes('--json')) {
  console.log(JSON.stringify(out, null, 2))
} else {
  console.log(`a node costs $${out.nodeCostPerDayUsd}/day (VM $${M.vmUsdPerMonth}/month, stake $${M.minStakeUsd} at ${M.stakeYield * 100}%)`)
  console.log(`1,000 devices need ${out.breakEvenNodesPer1000Devices} small nodes (4 jobs x 3 signers each, ${M.assignmentsPerVmNode} device-jobs a node)\n`)
  console.table(rows)
}
