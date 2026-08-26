// Superannuation contribution caps — Tier 1.2, Commit 2. Pure, no
// engine/DOM knowledge; operates on already-aggregated per-FY,
// per-person contribution totals (deterministic.js does the
// aggregation, this module does the cap arithmetic).
//
// Concessional (SG + salary sacrifice + personal deductible):
//   - ALL concessional contributions attract 15% contributions tax at
//     the point of contribution, regardless of the cap — the cap only
//     governs whether the EXCESS also gets assessed at the member's
//     marginal rate (with a 15% non-refundable offset, since it was
//     already taxed once in the fund). Modelled: leave excess in the
//     fund (the default). NOT modelled: the release-from-fund election.
//   - Carry-forward: a rolling 5-year FIFO ledger of unused cap.
//     Unused amounts accrue every FY regardless of TSB; they may only
//     be USED (to cover an excess) when the person's TSB at the PRIOR
//     30 June was under carryForwardTsbGate. The documented trap:
//     crossing that gate DURING the FY does not remove eligibility —
//     only the prior-30-June snapshot matters.
//
// Non-concessional (personal non-deductible + spouse):
//   - Not taxed on entry. A bring-forward window triggers
//     automatically the first FY contributions exceed the flat annual
//     cap, sized by the TSB tier at that trigger. Excess beyond
//     whatever cap applies (bring-forward or flat) is REJECTED
//     (not credited, flagged) — the excess-NCC tax machinery is
//     explicitly not modelled.
//
// Division 293: 15% × lesser of (low-tax contributions within cap)
// and (Div293 income − threshold). Div293 income, per the simplified
// formula this tool uses: taxable income + reportable super
// contributions (salary sacrifice + personal deductible — the
// components that reduced assessable income) + low-tax contributions
// (SG + salary sacrifice + personal deductible, capped at what was
// actually taxed at 15% i.e. excluding any excess already taxed at
// marginal rates). Reportable FBT and net investment losses are NOT
// captured by this tool (disclosed in the Parameters modal).

// --- concessional cap + carry-forward ---------------------------------

// A rolling FIFO ledger: index 0 is the OLDEST unused-cap entry.
// Consuming spends the oldest first; accruing appends a new (newest)
// entry and drops whatever just aged out past the window.
export function consumeCarryForward(carryForward, amountNeeded) {
  let remaining = amountNeeded;
  const next = [...carryForward];
  for (let i = 0; i < next.length && remaining > 1e-9; i++) {
    const use = Math.min(next[i], remaining);
    next[i] -= use;
    remaining -= use;
  }
  return { consumed: amountNeeded - remaining, carryForward: next };
}

export function accrueCarryForward(carryForward, unusedThisFy) {
  return [...carryForward.slice(1), Math.max(0, unusedThisFy)];
}

// The carry-forward total actually AVAILABLE this FY — zero unless
// the prior-30-June TSB gate is met (accrual is unconditional; USE is
// gated). Crossing the gate mid-FY is irrelevant — only the snapshot
// the caller passes in (the prior 30 June) matters.
export function availableCarryForward(carryForward, tsbPriorJune, gate) {
  return tsbPriorJune < gate ? carryForward.reduce((s, v) => s + v, 0) : 0;
}

// processConcessionalCap({ totalCC, baseCap, carryForward, tsbPriorJune, gate })
//   → { capAvailable, excess, carryForwardUsed, newCarryForward }
//
// totalCC is this FY's SG + salary sacrifice + personal deductible,
// GROSS (before the 15% contributions tax — that applies uniformly and
// is computed by the caller). Only the portion exceeding baseCap draws
// on carry-forward; only the portion beyond THAT is true excess.
export function processConcessionalCap({ totalCC, baseCap, carryForward, tsbPriorJune, gate }) {
  const capAvailableCF = availableCarryForward(carryForward, tsbPriorJune, gate);
  const shortfall = Math.max(0, totalCC - baseCap);
  const { consumed: carryForwardUsed, carryForward: afterConsume } = consumeCarryForward(carryForward, Math.min(shortfall, capAvailableCF));
  const excess = shortfall - carryForwardUsed;
  const unusedBaseCap = Math.max(0, baseCap - totalCC); // nonzero only when shortfall is 0
  const newCarryForward = accrueCarryForward(afterConsume, unusedBaseCap);
  return { capAvailable: baseCap + capAvailableCF, excess, carryForwardUsed, newCarryForward };
}

// --- non-concessional cap + bring-forward ------------------------------

// The bring-forward window a TSB tier grants, expressed as a multiple
// of the flat annual cap (matches the spec's own $390k=3×130k,
// $260k=2×130k derivation, so a future cap change never desyncs the
// bring-forward totals from the base cap).
export function bringForwardTierFor(tsbPriorJune, thresholds, baseCap) {
  if (tsbPriorJune < thresholds.full) return { years: 3, total: baseCap * 3 };
  if (tsbPriorJune < thresholds.two) return { years: 2, total: baseCap * 2 };
  if (tsbPriorJune < thresholds.one) return { years: 1, total: baseCap }; // "no bring-forward" — a single year at the flat cap
  return { years: 0, total: 0 }; // nil — no NCCs accepted at all
}

// processNonConcessionalCap({ requestedNCC, baseCap, tsbPriorJune,
//   thresholds, bringForward: {triggeredYear, remaining} | null, planYear })
//   → { accepted, rejected, bringForward }
//
// bringForward is engine-internal running state (see deterministic.js)
// — NOT the persisted plan.<person>.super.bringForwardTriggeredYear
// seed, which this build treats as informational only (every
// projection starts its own bring-forward tracking fresh at year 0;
// there is no supported way to seed a plan mid-bring-forward).
export function processNonConcessionalCap({ requestedNCC, baseCap, tsbPriorJune, thresholds, bringForward, planYear }) {
  let bf = bringForward;
  // An active window expires once `years` FYs have elapsed since it
  // triggered — that many years INCLUDING the trigger year itself.
  if (bf && planYear - bf.triggeredYear >= bf.years) bf = null;

  let capThisYear;
  if (bf) {
    capThisYear = bf.remaining;
  } else {
    const tier = bringForwardTierFor(tsbPriorJune, thresholds, baseCap);
    if (requestedNCC > baseCap && tier.years > 1) {
      bf = { triggeredYear: planYear, years: tier.years, remaining: tier.total };
      capThisYear = tier.total;
    } else {
      capThisYear = tier.years === 0 ? 0 : baseCap;
    }
  }

  const accepted = Math.max(0, Math.min(requestedNCC, capThisYear));
  const rejected = Math.max(0, requestedNCC - accepted);
  const newBringForward = bf ? { ...bf, remaining: Math.max(0, capThisYear - accepted) } : null;
  return { accepted, rejected, bringForward: newBringForward };
}

// --- Division 293 -------------------------------------------------------

// div293Income = taxableIncome + reportableSuperContributions +
// lowTaxContributions + reportableFringeBenefits (spec 23, Commit 3 —
// packaging that reduces income tax can increase Division 293 income;
// net investment losses are still not captured). reportableFringeBenefits
// defaults to 0 so every existing call site (none of which packages
// benefits) is unaffected.
export function div293Tax({ taxableIncome, reportableSuperContributions, lowTaxContributions, reportableFringeBenefits = 0, threshold, rate }) {
  const div293Income = taxableIncome + reportableSuperContributions + lowTaxContributions + reportableFringeBenefits;
  const overThreshold = Math.max(0, div293Income - threshold);
  const base = Math.max(0, Math.min(lowTaxContributions, overThreshold));
  return { div293Income, tax: rate * base };
}
