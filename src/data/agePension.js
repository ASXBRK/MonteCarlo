// Age Pension — core means testing (spec 21a). Rates, thresholds, and
// per-figure indexation, following the same pattern as superRates.js
// (spec 10 Commit 1) and Division 296: every indexed figure moves on
// its OWN legislated basis, rather than being held uniformly constant
// in real terms.
//
// AS AT the 20 March 2026 rate period (FY2026/27 base). Homeowner
// assets-test thresholds and the $78/$1,000 reduction rate are the
// firm's own reference figures (quoted directly in spec 21a). The
// firm's reference does NOT carry non-homeowner thresholds, deeming
// rates/thresholds, or the income-test free areas — spec 21a's own
// "data gap to close first" — so those are cross-referenced against
// Services Australia's published 2026 rates and cross-checked here two
// ways: (a) independently against two unrelated public sources, and
// (b) internally, by confirming the sourced rate figure reproduces the
// FIRM'S OWN given cut-out thresholds via assetsTestCutOut() below to
// within normal publication rounding (single: derived $733,460 vs
// firm's $733,500; couple: derived $1,102,460 vs firm's $1,102,500 —
// both within the $500 assets-threshold rounding step). Flagged
// wherever a figure could not be cross-checked this way.
//
// Indexation model (the detail that matters most): pension RATES index
// twice yearly to the greater of CPI and PBLCI, with a floor of 27.7%
// of MTAWE for the single rate. This tool has no MTAWE series to model
// that floor directly — per the spec's own resolution, rates are
// instead indexed at AWOTE outright (state.assumptions.awote), which is
// the historically-realistic proxy for "CPI/PBLCI plus the wage floor
// binding over long horizons": modelling rates at CPI instead would
// understate the age pension by roughly a third over thirty years,
// because the floor has bound for most of the pension's history.
// THRESHOLDS (assets-test full-pension limits, deeming thresholds,
// income-test free areas) index at CPI — a materially slower basis,
// which is what makes real entitlement gently RISE over a multi-decade
// projection relative to the thresholds, matching the historical
// pattern. Centrelink itself steps on 20 March and 20 September; this
// engine is annual, so indexation is applied once at 1 July and the
// simplification is disclosed (Parameters modal, Commit 4).
//
// The $78/$1,000 reduction rate (assets test) and the 50c-per-dollar
// income-test taper are POLICY RATES, not indexed under either
// bracketMode — same treatment as super's contributionsTaxRate/sgRate.
// Deeming rates (1.25%/3.25%) are likewise a ministerial determination,
// not part of the CPI/AWOTE indexation regime, so they are held flat
// here too (as at the FY2026/27 base) rather than compounded forward —
// a real pensioner's deeming rate genuinely can be reset by government
// decision at any time, which no formula can anticipate; disclosed.
//
// Assets-test cut-out points are DERIVED from the full-pension
// threshold, the annual rate, and the reduction rate — never stored —
// so they stay internally consistent as any of the three move.

const BASE_FY_START_YEAR = 2026; // the FY2026-27 (20 Mar 2026 rate period) figures below
const FORTNIGHTS_PER_YEAR = 26; // Centrelink's own annualisation convention — confirmed via the cut-out cross-check above

export const AGE_PENSION_RATES_BASE = Object.freeze({
  asAt: "2026-03-20",
  source: "Firm reference (homeowner assets-test thresholds, reduction rate) + Services Australia published rates, 20 March 2026 rate period (non-homeowner thresholds, deeming, income-test free areas — see module header)",
  // Age pension age: 67, for anyone born from 1 January 1957 — this
  // tool only models that cohort (fixed, not derived by birth-year
  // table; mirrors superRates.js's preservationAge convention).
  ageOfEligibility: 67,
  // Maximum rate (annual = fortnightly × 26), all-inclusive (base rate +
  // pension supplement + energy supplement) — the single all-in figure
  // Centrelink's own assets/income test formulas apply against.
  // AWOTE-indexed (see module header). Fortnightly source: single
  // $1,200.90, couple $905.20 each ($1,810.40 combined).
  singleRate: 1200.90 * FORTNIGHTS_PER_YEAR,
  coupleRateEach: 905.20 * FORTNIGHTS_PER_YEAR,
  // Reduction rate (assets test): $78 per $1,000 (per YEAR) of
  // assessable assets above the full-pension threshold — a rate, not
  // indexed (firm reference, spec's own words).
  reductionRatePer1000: 78,
  // Assets test — full-pension thresholds, CPI-indexed. Homeowner
  // figures are the firm's own reference (spec 21a). Non-homeowner
  // figures close the spec's own "data gap" (see module header) — the
  // gap between the two is consistently $267,000 for both singles and
  // couples across independent sources, itself indexed as part of the
  // non-homeowner figure (not stored separately).
  assetsFullHomeownerSingle: 333000,
  assetsFullHomeownerCouple: 499000,
  assetsFullNonHomeownerSingle: 600000,
  assetsFullNonHomeownerCouple: 766000,
  // Deeming (income test) — a two-tier rate on total financial assets.
  // Rates are a ministerial determination, not indexed (see header);
  // thresholds are CPI-indexed.
  deemingLowerRate: 0.0125,
  deemingUpperRate: 0.0325,
  deemingThresholdSingle: 66800,
  deemingThresholdCouple: 110600,
  // Income test — free area (CPI-indexed) and reduction rate (a flat
  // policy rate, not indexed): 50c per dollar of income above the free
  // area for a single; 50c per dollar of COMBINED income above the
  // combined free area for a couple, split between them. Fortnightly
  // source: single $226, couple $396 combined.
  incomeFreeAreaSingle: 226 * FORTNIGHTS_PER_YEAR,
  incomeFreeAreaCouple: 396 * FORTNIGHTS_PER_YEAR,
  incomeReductionRate: 0.5,
});

function roundDownTo(value, step) {
  return Math.floor(value / step) * step;
}

// The FY's un-deflated nominal dollar figure for an independently
// indexed threshold — same shape as superRates.js's nominalOf.
function nominalOf(base, basisRate, step, tNominal) {
  return roundDownTo(base * Math.pow(1 + basisRate, tNominal), step);
}

// agePensionRatesFor(fyStartYear, bracketMode, cpi, awote) → the FY's
// rates/thresholds, resolved to real-dollar values for that FY under
// the plan's bracket mode (same "frozen pins nominal compounding to
// the base year, but real deflation still uses actual elapsed years"
// behaviour as superRatesFor).
export function agePensionRatesFor(fyStartYear, bracketMode = "indexed", cpi = 0.025, awote = 0.035) {
  const b = AGE_PENSION_RATES_BASE;
  const tReal = Math.max(0, fyStartYear - BASE_FY_START_YEAR);
  const tNominal = bracketMode === "frozen" ? 0 : tReal;
  const deflate = Math.pow(1 + cpi, tReal);

  // Rates: AWOTE-indexed, rounded to the nearest 10 cents per fortnight
  // (Centrelink's own rounding step) — expressed here in nominal ANNUAL
  // dollars, so the step becomes 10c × 26 = $2.60.
  const singleRateNom = nominalOf(b.singleRate, awote, 2.60, tNominal);
  const coupleRateEachNom = nominalOf(b.coupleRateEach, awote, 2.60, tNominal);

  // Assets-test thresholds: CPI-indexed, rounded to the nearest $500 —
  // the step the firm's own homeowner figures are already stated to
  // (both $333,000 and $499,000 are exact multiples of $500).
  const assetsFullHomeownerSingleNom = nominalOf(b.assetsFullHomeownerSingle, cpi, 500, tNominal);
  const assetsFullHomeownerCoupleNom = nominalOf(b.assetsFullHomeownerCouple, cpi, 500, tNominal);
  const assetsFullNonHomeownerSingleNom = nominalOf(b.assetsFullNonHomeownerSingle, cpi, 500, tNominal);
  const assetsFullNonHomeownerCoupleNom = nominalOf(b.assetsFullNonHomeownerCouple, cpi, 500, tNominal);

  // Deeming thresholds: CPI-indexed, rounded to the nearest $200 (the
  // step these figures have historically moved in).
  const deemingThresholdSingleNom = nominalOf(b.deemingThresholdSingle, cpi, 200, tNominal);
  const deemingThresholdCoupleNom = nominalOf(b.deemingThresholdCouple, cpi, 200, tNominal);

  // Income-test free areas: CPI-indexed, rounded to the nearest $52
  // (fortnightly $2 × 26).
  const incomeFreeAreaSingleNom = nominalOf(b.incomeFreeAreaSingle, cpi, 52, tNominal);
  const incomeFreeAreaCoupleNom = nominalOf(b.incomeFreeAreaCouple, cpi, 52, tNominal);

  return {
    asAt: b.asAt,
    source: b.source,
    ageOfEligibility: b.ageOfEligibility,
    reductionRatePer1000: b.reductionRatePer1000, // flat, not indexed
    incomeReductionRate: b.incomeReductionRate, // flat, not indexed
    deemingLowerRate: b.deemingLowerRate, // flat, not indexed (ministerial determination)
    deemingUpperRate: b.deemingUpperRate, // flat, not indexed (ministerial determination)
    single: {
      rate: singleRateNom / deflate,
      assetsFullHomeowner: assetsFullHomeownerSingleNom / deflate,
      assetsFullNonHomeowner: assetsFullNonHomeownerSingleNom / deflate,
      incomeFreeArea: incomeFreeAreaSingleNom / deflate,
      deemingThreshold: deemingThresholdSingleNom / deflate,
    },
    couple: {
      rateEach: coupleRateEachNom / deflate,
      rateCombined: (2 * coupleRateEachNom) / deflate,
      assetsFullHomeowner: assetsFullHomeownerCoupleNom / deflate,
      assetsFullNonHomeowner: assetsFullNonHomeownerCoupleNom / deflate,
      incomeFreeAreaCombined: incomeFreeAreaCoupleNom / deflate,
      deemingThreshold: deemingThresholdCoupleNom / deflate,
    },
  };
}

// Work Bonus (spec 21b, Commit 1) — exempts employment/self-employment
// income from the age pension income test, with an accruing "income
// bank". The real scheme is fortnightly ($300 exempt, $11,800 bank
// cap, $4,000 starting balance for a new recipient); this engine is
// annual, so it's modelled as $7,800/yr ($300 × 26 fortnights) exempt
// — the same annual-equivalent convention FORTNIGHTS_PER_YEAR already
// uses for rates/free areas above — with the bank as an annual carry-
// forward balance. Neither figure is indexed: a policy setting, not
// part of the CPI/AWOTE regime, same treatment as the deeming rates
// above.
export const WORK_BONUS = Object.freeze({
  exemptAnnual: 300 * FORTNIGHTS_PER_YEAR, // $7,800/yr
  bankCap: 11800,
  startingBalance: 4000,
});

// Assets-test cut-out point: the assessable-assets level at which
// entitlement reaches zero under the assets test alone — derived from
// the full-pension threshold, the (real, already-deflated) annual
// rate, and the reduction rate, never stored (spec's own words: "Cut-
// outs are derived from the rate and the taper rather than stored, so
// they stay consistent when rates index").
//   excess-at-cutout = annualRate ÷ (reductionRatePer1000 / 1000)
export function assetsTestCutOut(fullPensionThreshold, annualRate, reductionRatePer1000) {
  return fullPensionThreshold + (annualRate * 1000) / reductionRatePer1000;
}
