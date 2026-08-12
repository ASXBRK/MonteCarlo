// costBasePool.js — pooled cost base mechanics per asset (no parcels).
//
// Pure and real-dollar throughout. Each CGT asset carries one pool:
//   { pool, fyAdditions }
// pool         — the (real) cost base of the whole holding
// fyAdditions  — additions made in the CURRENT FY, tracked only for
//                the pre-reform 12-month discount check (decision 10)
//
// Post-reform the pool is CPI-indexed, which in real dollars means it
// is simply constant — real gain = real proceeds − consumed slice,
// directly. Objects are immutable; every operation returns a new one,
// which also makes snapshot/replay in the engine a shallow copy.

import { LEG } from "./Tax/engine.js";

export function createPool(seed = 0) {
  return { pool: Math.max(0, Number(seed) || 0), fyAdditions: 0 };
}

// Contribution, one-off inflow, surplus invested, or a reinvested
// distribution — all enter at their real amount.
export function poolAdd(p, amount) {
  if (!(amount > 0)) return p;
  return { pool: p.pool + amount, fyAdditions: p.fyAdditions + amount };
}

// A sale of `proceeds` out of an asset worth `marketValue` (both real,
// value measured BEFORE the proceeds leave). Fraction f of the pool is
// consumed; realised gain = proceeds − f × pool (negative = capital
// loss). newMoneyFraction is the share of the pool added this FY,
// exposed for the pre-reform discount treatment.
export function poolConsume(p, proceeds, marketValue) {
  if (!(proceeds > 0) || !(marketValue > 0)) {
    return { state: p, gain: 0, newMoneyFraction: 0 };
  }
  const f = Math.min(1, proceeds / marketValue);
  const slice = f * p.pool;
  const newMoneyFraction = p.pool > 0 ? Math.min(1, p.fyAdditions / p.pool) : 0;
  return {
    state: { pool: p.pool - slice, fyAdditions: p.fyAdditions * (1 - f) },
    gain: proceeds - slice,
    newMoneyFraction,
  };
}

// FY rollover: this-FY additions age into old money.
export function poolNewFy(p) {
  return p.fyAdditions === 0 ? p : { pool: p.pool, fyAdditions: 0 };
}

// Deemed reacquisition at 1 July 2027 (enacted transition): the pool
// resets to market value. Pre-reform accrued gains are not taxed at
// that point in this tool's modelling scope — they simply never enter
// the post-reform pool.
export function poolDeemedReacquisition(p, marketValue) {
  return { pool: Math.max(0, marketValue), fyAdditions: 0 };
}

// Pre-reform sales only (before 1 July 2027): the sold slice comes
// proportionally from old and new money; the old portion gets the 50%
// discount (12-month holding assumed), same-FY additions do not.
// Losses pass through at full value.
export function preReformTaxableGain(gain, newMoneyFraction) {
  if (gain <= 0) return gain;
  const oldShare = 1 - newMoneyFraction;
  return gain * (oldShare * LEG.oldDiscountRate + newMoneyFraction);
}
