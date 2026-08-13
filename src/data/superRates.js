// Superannuation (accumulation phase) reference rates — Tier 1.2.
//
// AS AT FY2026/27, sourced from the firm's reference set (Macquarie Big
// Black Book 2026/27, 20 Mar 2026 rate period edition — same source as
// au-fy-figures). Keyed by FY so an annual update is a data edit, never
// a change to engine code.
//
// Indexation: caps/thresholds are held constant in REAL terms by
// default ("indexed" bracket mode, matching the tax-bracket
// convention) — since the engine works in real dollars throughout,
// that means using the FY2026/27 figure as-is for every later FY.
// "frozen" mode instead holds the FY2026/27 NOMINAL figure fixed, so
// it shrinks in real terms by CPI each year — same k-scaling as
// Tax/annual.js's bracketSettings.
//
// div293Threshold is a documented ASYMMETRY: it is a flat $250,000
// figure not indexed in *law* under either setting, so — unlike every
// other cap here — it is scaled as "frozen" regardless of the plan's
// bracketMode: it shrinks in real terms every year even under the
// "indexed" default. Disclosed in the Parameters modal (Commit 4).
//
// contributionsTaxRate/earningsTaxRate/div293Rate/sgRate and the age
// thresholds are flat rates/ages — never scaled by any bracket mode.

const BASE_FY_START_YEAR = 2026; // the FY2026-27 figures below

export const SUPER_RATES_BASE = Object.freeze({
  asAt: "2026-07-01",
  source: "Macquarie Big Black Book 2026/27 (20 Mar 2026 rate period edition)",
  concessionalCap: 32500,
  nonConcessionalCap: 130000,
  // TSB at prior 30 June → bring-forward period + total cap over it:
  //   < $1.84m         → $390,000 over 3 years
  //   $1.84m–<$1.97m   → $260,000 over 2 years
  //   $1.97m–<$2.1m    → $130,000, no bring-forward (single year only)
  //   ≥ $2.1m          → nil (no NCCs accepted)
  bringForwardTsbThresholds: Object.freeze({ full: 1840000, two: 1970000, one: 2100000 }),
  carryForwardTsbGate: 500000, // TSB at prior 30 June, gates carry-forward USE (not accrual)
  carryForwardYears: 5,
  contributionsTaxRate: 0.15,
  earningsTaxRate: 0.15,
  div293Threshold: 250000, // NOT indexed in law — always scaled "frozen" (see header)
  div293Rate: 0.15, // additional; total 30% on low-tax contributions above the threshold
  sgRate: 0.12,
  sgMaximumSalary: 270830, // per FY, per employer (income row)
  contributionAgeLimit: 75,
  workTestAges: Object.freeze([67, 74]),
  preservationAge: 60, // born from 1 Jul 1964 — the only cohort this projection tool models
});

// Fields expressed in nominal FY2026/27 dollars that scale with the
// bracket-mode convention (everything else above is a flat rate, age,
// or already-real structural figure and is returned unscaled).
const SCALED_FIELDS = [
  "concessionalCap", "nonConcessionalCap", "carryForwardTsbGate", "sgMaximumSalary",
];

function scaleFactor(fyStartYear, bracketMode, cpi) {
  if (bracketMode !== "frozen") return 1; // indexed (default): constant in real terms
  return Math.pow(1 + cpi, Math.max(0, fyStartYear - BASE_FY_START_YEAR));
}

// superRatesFor(fyStartYear, bracketMode, cpi) → the FY's rates, with
// nominal caps/thresholds converted to their real-dollar value under
// the plan's bracket mode. Only one FY of source data exists; every FY
// resolves against it (there is nothing yet to look up by year, unlike
// the legislated multi-year tax-bracket tables).
export function superRatesFor(fyStartYear, bracketMode = "indexed", cpi = 0.025) {
  const k = scaleFactor(fyStartYear, bracketMode, cpi);
  const divK = scaleFactor(fyStartYear, "frozen", cpi); // div293Threshold: always frozen (asymmetry)
  const out = { ...SUPER_RATES_BASE };
  for (const field of SCALED_FIELDS) out[field] = SUPER_RATES_BASE[field] / k;
  out.bringForwardTsbThresholds = {
    full: SUPER_RATES_BASE.bringForwardTsbThresholds.full / k,
    two: SUPER_RATES_BASE.bringForwardTsbThresholds.two / k,
    one: SUPER_RATES_BASE.bringForwardTsbThresholds.one / k,
  };
  out.div293Threshold = SUPER_RATES_BASE.div293Threshold / divK;
  return out;
}
