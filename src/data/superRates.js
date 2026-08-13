// Superannuation (accumulation phase) reference rates — Tier 1.2,
// re-based (Super thresholds Commit 1) so every indexed figure moves on
// its OWN legislated basis and rounding step, instead of being held
// uniformly constant in real terms.
//
// AS AT FY2026/27, sourced from the firm's reference set (Macquarie Big
// Black Book 2026/27, 20 Mar 2026 rate period edition — same source as
// au-fy-figures) unless flagged otherwise below. Keyed by FY so an
// annual update is a data edit, never a change to engine code.
//
// Indexation model: every indexed figure is compounded NOMINALLY from
// the FY2026/27 base year at its own basis rate (AWOTE or CPI), rounded
// DOWN to its own legislated step IN NOMINAL DOLLARS, and only THEN
// deflated to real (÷ (1+cpi)^years-since-base). Rounding happens
// before deflation, so the real value steps irregularly rather than
// gliding smoothly — this is the corrected behaviour, not a bug: it is
// exactly how these caps actually move (they jump when the rounded
// nominal figure jumps, and drift down in real terms between jumps).
//
// The "no indexation" toggle (bracketMode "frozen") holds every indexed
// figure at its nominal FY2026/27 value forever (compounding exponent
// pinned to 0) — deflation to real still applies using the ACTUAL
// elapsed years, since that reflects true inflation regardless of
// whether the legislated figure itself moved.
//
// Two thresholds are flat dollar figures NOT indexed in *law* under
// EITHER bracketMode — carryForwardTsbGate and div293Threshold. Both
// are therefore always deflated straight off their nominal FY2026/27
// value: they shrink in real terms every year even under the "indexed"
// default. Disclosed in the Parameters modal (Commit 4).
//
// contributionsTaxRate/earningsTaxRate/div293Rate/sgRate and the age
// thresholds are flat rates/ages — never scaled by any bracket mode.

const BASE_FY_START_YEAR = 2026; // the FY2026-27 figures below

export const SUPER_RATES_BASE = Object.freeze({
  asAt: "2026-07-01",
  source: "Macquarie Big Black Book 2026/27 (20 Mar 2026 rate period edition)",
  // AWOTE-indexed, rounds DOWN to the nearest $2,500 (ITAA97 s960-285's
  // method for the concessional cap).
  concessionalCap: 32500,
  // = 4 × concessionalCap, always — not independently indexed. Kept
  // here only as the FY2026/27 spot-check figure; superRatesFor derives
  // it fresh from that FY's own concessionalCap for every FY.
  nonConcessionalCap: 130000,
  // General transfer balance cap: CPI-indexed, rounds DOWN to the
  // nearest $100,000 (s960-285). $2,100,000 is the figure the
  // pre-Commit-1 bring-forward thresholds below were already
  // internally consistent with (full = GTBC − 2×NCC, two = GTBC − NCC,
  // one = GTBC), so this re-base introduces no discontinuity in those.
  generalTransferBalanceCap: 2100000,
  // Untaxed plan cap: AWOTE-indexed, rounds DOWN to the nearest $5,000
  // (same mechanism as the concessional cap, different step). UNVERIFIED
  // against the firm's FY2026/27 source: the last confirmed published
  // figure is the ATO's 2024-25 amount, $1,780,000; rolled forward two
  // years at the default 3.5% AWOTE assumption and rounded per the
  // legislated method: $1,780,000 × 1.035² = $1,906,745.15 → $1,905,000.
  // Flagged for confirmation against the Big Black Book before relying
  // on the exact figure (the indexation MECHANISM is legislated and not
  // in doubt; only this one base number is an estimate).
  untaxedPlanCap: 1905000,
  // = GTBC-derived every FY (see generalTransferBalanceCap above), NOT
  // independently indexed. Kept here as the FY2026/27 spot-check figure
  // only — see the field's own note above.
  //   TSB at prior 30 June → bring-forward period + total cap over it:
  //     < $1.84m         → $390,000 over 3 years
  //     $1.84m–<$1.97m   → $260,000 over 2 years
  //     $1.97m–<$2.1m    → $130,000, no bring-forward (single year only)
  //     ≥ $2.1m          → nil (no NCCs accepted)
  bringForwardTsbThresholds: Object.freeze({ full: 1840000, two: 1970000, one: 2100000 }),
  carryForwardTsbGate: 500000, // flat $ figure, NOT indexed under either bracketMode — TSB at prior 30 June, gates carry-forward USE (not accrual)
  carryForwardYears: 5,
  contributionsTaxRate: 0.15,
  earningsTaxRate: 0.15,
  div293Threshold: 250000, // flat $ figure, NOT indexed under either bracketMode (see header)
  div293Rate: 0.15, // additional; total 30% on low-tax contributions above the threshold
  sgRate: 0.12,
  // = floor(concessionalCap ÷ sgRate, to the nearest $10) every FY — the
  // salary at which SG contributions exactly exhaust the concessional
  // cap, not an independently indexed figure. Kept here as the
  // FY2026/27 spot-check: 32,500 ÷ 0.12 = 270,833.33 → 270,830.
  sgMaximumSalary: 270830,
  contributionAgeLimit: 75,
  workTestAges: Object.freeze([67, 74]),
  preservationAge: 60, // born from 1 Jul 1964 — the only cohort this projection tool models
  unrestrictedAccessAge: 65, // age-65 condition of release — unconditional, no retirement event needed
  // Division 296 (two-tier tax on high super balances — Commit 2 reads
  // these; added to this shared table now per that commit's spec).
  // ASSUMPTION, pending firm confirmation: both thresholds ARE indexed
  // (unlike the lapsed 2023 bill) — modelled here as CPI-indexed,
  // rounding DOWN to the nearest $100,000, mirroring the general
  // transfer balance cap's own mechanism, per public reporting that the
  // enacted Bill's Senate amendments added indexation to address
  // criticism that the original $3m threshold was permanently frozen.
  // The exact indexation basis for Division 296 specifically has not
  // been confirmed against the firm's reference material.
  div296LowerThreshold: 3000000,
  div296UpperThreshold: 10000000,
});

function roundDownTo(value, step) {
  return Math.floor(value / step) * step;
}

// The FY's un-deflated nominal dollar figure for an independently
// indexed threshold: compounded from the FY2026/27 base at its own
// basis rate, then rounded DOWN to its own legislated step. Rounding
// happens here, in nominal dollars — see the module header for why.
function nominalOf(base, basisRate, step, tNominal) {
  return roundDownTo(base * Math.pow(1 + basisRate, tNominal), step);
}

// superRatesFor(fyStartYear, bracketMode, cpi, awote) → the FY's rates,
// with every indexed cap/threshold resolved to its real-dollar value
// for that FY under the plan's bracket mode. Only one FY of source data
// exists; every FY resolves against it algorithmically (there is
// nothing yet to look up by year, unlike the legislated multi-year
// tax-bracket tables).
export function superRatesFor(fyStartYear, bracketMode = "indexed", cpi = 0.025, awote = 0.035) {
  const tReal = Math.max(0, fyStartYear - BASE_FY_START_YEAR);
  // "frozen" (no-indexation toggle): every indexed figure's nominal
  // compounding is pinned to the base year — but deflation to real
  // still uses the ACTUAL elapsed years, since real inflation doesn't
  // stop just because the legislated nominal figure does. This is why
  // "frozen" figures shrink in real terms every year.
  const tNominal = bracketMode === "frozen" ? 0 : tReal;
  const deflate = Math.pow(1 + cpi, tReal);

  const concessionalCapNom = nominalOf(SUPER_RATES_BASE.concessionalCap, awote, 2500, tNominal);
  const gtbcNom = nominalOf(SUPER_RATES_BASE.generalTransferBalanceCap, cpi, 100000, tNominal);
  const untaxedPlanCapNom = nominalOf(SUPER_RATES_BASE.untaxedPlanCap, awote, 5000, tNominal);
  const div296LowerNom = nominalOf(SUPER_RATES_BASE.div296LowerThreshold, cpi, 100000, tNominal);
  const div296UpperNom = nominalOf(SUPER_RATES_BASE.div296UpperThreshold, cpi, 100000, tNominal);

  // Derived from the above — NOT independently indexed or rounded; each
  // moves only because the figure it's built from does.
  const nonConcessionalCapNom = 4 * concessionalCapNom;
  const bringForwardNom = {
    full: gtbcNom - 2 * nonConcessionalCapNom,
    two: gtbcNom - nonConcessionalCapNom,
    one: gtbcNom,
  };
  const sgMaximumSalaryNom = roundDownTo(concessionalCapNom / SUPER_RATES_BASE.sgRate, 10);

  return {
    ...SUPER_RATES_BASE,
    concessionalCap: concessionalCapNom / deflate,
    generalTransferBalanceCap: gtbcNom / deflate,
    untaxedPlanCap: untaxedPlanCapNom / deflate,
    nonConcessionalCap: nonConcessionalCapNom / deflate,
    bringForwardTsbThresholds: {
      full: bringForwardNom.full / deflate,
      two: bringForwardNom.two / deflate,
      one: bringForwardNom.one / deflate,
    },
    sgMaximumSalary: sgMaximumSalaryNom / deflate,
    div296LowerThreshold: div296LowerNom / deflate,
    div296UpperThreshold: div296UpperNom / deflate,
    // Never indexed under either bracketMode — always nominally frozen
    // at the FY2026/27 base value, so real value declines every year
    // purely from CPI deflation (the disclosed asymmetry).
    carryForwardTsbGate: SUPER_RATES_BASE.carryForwardTsbGate / deflate,
    div293Threshold: SUPER_RATES_BASE.div293Threshold / deflate,
  };
}

// Condition of release (Commit 3): unconditional at unrestrictedAccessAge
// (65), or retiring at/after preservationAge (60) — this tool has no
// modelled "retirement event", so the person's own Tier 1.1
// retirementAge stands in for it. The two conditions collapse to a
// single "released from" age: whichever of the two is reached first,
// floored at preservationAge (someone retiring before 60 still can't
// access it before 60) and capped at unrestrictedAccessAge (turning 65
// grants access regardless of retirement status).
export function superReleaseAge(retirementAge, rates = SUPER_RATES_BASE) {
  return Math.min(rates.unrestrictedAccessAge, Math.max(rates.preservationAge, retirementAge));
}
