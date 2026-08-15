// Medicare Levy Surcharge (MLS) rates — Document Set Commit 2.
//
// AS AT FY2026/27, sourced from the firm's reference set (same source
// as au-fy-figures). Keyed by FY, indexed at AWOTE (per the spec's own
// "indexed 1 July with AWOTE") — the same wage-index basis this build
// already uses for HELP's repayment-income thresholds, so no new
// assumption is introduced here (unlike helpRates.js, this basis is
// exactly what the spec asked for — no disclosure needed).
//
// The surcharge is a STEP function, not marginal: once income for
// surcharge purposes crosses a threshold, the rate applies to the
// WHOLE income (per the spec's explicit "the surcharge applies to the
// whole income, not the excess"), same shape as HELP's cliff but with
// three tiers instead of one.

const BASE_FY_START_YEAR = 2026;

export const MLS_RATES_BASE = Object.freeze({
  asAt: "2026-07-01",
  source: "Macquarie Big Black Book 2026/27 (20 Mar 2026 rate period edition)",
  // [floor, rate] — the rate for a given income is whichever band's
  // floor is the highest one at or below it (a step function).
  singleBands: Object.freeze([
    [0, 0],
    [105000, 0.01],
    [123000, 0.0125],
    [164000, 0.015],
  ]),
  familyBands: Object.freeze([
    [0, 0],
    [210000, 0.01],
    [246000, 0.0125],
    [328000, 0.015],
  ]),
  dependentChildStep: 1500, // added to each non-nil family threshold per dependent child AFTER THE FIRST
});

function scaleBands(bands, factor) {
  return bands.map(([floor, rate]) => [floor * factor, rate]);
}

export function mlsRatesFor(fyStartYear, bracketMode = "indexed", cpi = 0.025, awote = 0.035) {
  const tReal = Math.max(0, fyStartYear - BASE_FY_START_YEAR);
  const tNominal = bracketMode === "frozen" ? 0 : tReal;
  const factor = Math.pow(1 + awote, tNominal) / Math.pow(1 + cpi, tReal);
  return {
    ...MLS_RATES_BASE,
    singleBands: scaleBands(MLS_RATES_BASE.singleBands, factor),
    familyBands: scaleBands(MLS_RATES_BASE.familyBands, factor),
    dependentChildStep: MLS_RATES_BASE.dependentChildStep * factor,
  };
}

// The family band table shifted for dependent children: +$1,500
// (indexed) per child AFTER THE FIRST, added to every non-nil
// threshold (the $0 "Nil" floor never moves).
function familyBandsWithChildren(rates, dependentChildren) {
  const add = Math.max(0, dependentChildren - 1) * rates.dependentChildStep;
  if (add === 0) return rates.familyBands;
  return rates.familyBands.map(([floor, rate]) => (floor === 0 ? [floor, rate] : [floor + add, rate]));
}

// Strict "greater than", not "at or above": the spec's bands read
// "≤ $105,000 → Nil, $105,001+ → 1.00%" — the published floor is itself
// still in the LOWER band.
function rateFromBands(income, bands) {
  let rate = 0;
  for (const [floor, r] of bands) {
    if (income > floor) rate = r;
  }
  return rate;
}

// mlsSurchargeAmount({ ownIncome, comparisonIncome, hasCover, isFamily,
//                       dependentChildren, rates }) → the surcharge $.
//
//   ownIncome         this person's own income for surcharge purposes
//                     — what the surcharge, once triggered, is a % of.
//   comparisonIncome  the income compared against the threshold bands
//                     to pick the RATE: this person's own income when
//                     single; the COMBINED family income for a couple
//                     (the ATO's family-threshold rule compares family
//                     income once, then applies the resulting rate to
//                     each uncovered person's OWN income separately).
//   hasCover          private hospital cover suppresses the surcharge
//                     entirely for this person, regardless of income.
//   isFamily          use family bands (+ per-child step) instead of
//                     single bands.
//   dependentChildren only relevant when isFamily.
export function mlsSurchargeAmount({
  ownIncome, comparisonIncome, hasCover, isFamily = false, dependentChildren = 0, rates = MLS_RATES_BASE,
}) {
  if (hasCover || !(ownIncome > 0)) return 0;
  const bands = isFamily ? familyBandsWithChildren(rates, dependentChildren) : rates.singleBands;
  const rate = rateFromBands(comparisonIncome, bands);
  return ownIncome * rate; // the WHOLE income, not the excess — a step function, not marginal
}
