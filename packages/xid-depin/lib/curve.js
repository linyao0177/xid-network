// Reward curves: what an epoch may pay out at most. The same arithmetic as
// DepinNetwork.emission, in BigInt, so the oracles score against the amount
// the contract will accept.

export const KINDS = { constant: 0, halving: 1, exponential: 2, linear: 3, steps: 4 }
const ONE = 10n ** 18n

// a curve from a config ({ kind: 'halving', initial: '1000e18', ... }) in the
// form the contract takes (DepinNetwork.Curve)
export function curveOf (c) {
  if (!c || !(c.kind in KINDS)) throw new Error('curve: kind must be one of ' + Object.keys(KINDS).join(', '))
  const steps = c.steps || []
  const curve = {
    kind: KINDS[c.kind],
    initial: amount(c.initial ?? 0),
    period: BigInt(c.period ?? 0),
    rate: amount(c.rate ?? 0),
    floor: amount(c.floor ?? 0),
    end: BigInt(c.end ?? 0),
    untils: steps.map((s) => BigInt(s.until)),
    amounts: steps.map((s) => amount(s.amount))
  }
  if (curve.kind === KINDS.halving && curve.period <= 0n) throw new Error('curve: a halving curve needs a period')
  if (curve.kind === KINDS.exponential && curve.rate >= ONE) throw new Error('curve: the rate is a fraction of 1e18')
  for (let i = 1; i < curve.untils.length; i++) if (curve.untils[i] <= curve.untils[i - 1]) throw new Error('curve: steps in order')
  return curve
}

// '1000e18', '1.5e18', 1000, '0x..' -> BigInt
export function amount (v) {
  if (typeof v === 'bigint') return v
  const s = String(v).trim()
  const m = /^(\d+)(?:\.(\d+))?e(\d+)$/i.exec(s)
  if (m) {
    const frac = m[2] || ''
    const exp = Number(m[3])
    if (frac.length > exp) throw new Error('amount: ' + s)
    return BigInt(m[1] + frac) * 10n ** BigInt(exp - frac.length)
  }
  return BigInt(s)
}

export function rpow (x, n) {
  let z = ONE
  x = BigInt(x)
  n = BigInt(n)
  while (n > 0n) {
    if (n & 1n) z = (z * x) / ONE
    x = (x * x) / ONE
    n >>= 1n
  }
  return z
}

export function emission (curve, e) {
  e = BigInt(e)
  if (curve.end !== 0n && e >= curve.end) return 0n
  let v = 0n
  if (curve.kind === KINDS.constant) v = curve.initial
  else if (curve.kind === KINDS.halving) {
    const k = e / curve.period
    v = k >= 256n ? 0n : curve.initial >> k
  } else if (curve.kind === KINDS.exponential) v = (curve.initial * rpow(ONE - curve.rate, e)) / ONE
  else if (curve.kind === KINDS.linear) {
    const d = curve.rate * e
    v = curve.initial > d ? curve.initial - d : 0n
  } else {
    for (let i = 0; i < curve.untils.length; i++) {
      if (e < curve.untils[i]) { v = curve.amounts[i]; break }
    }
  }
  return v < curve.floor ? curve.floor : v
}

// the emission of epochs [from, to): for showing a schedule
export function schedule (curve, from, to) {
  const out = []
  for (let e = BigInt(from); e < BigInt(to); e++) out.push(emission(curve, e))
  return out
}
