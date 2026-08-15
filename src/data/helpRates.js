// HELP (Higher Education Loan Program) compulsory repayment rates —
// Document Set Commit 1.
//
// AS AT FY2026/27, sourced from the firm's reference set (same source
// as au-fy-figures — Macquarie Big Black Book 2026/27, 20 Mar 2026 rate
// period edition). Keyed by FY so an annual update is a data edit,
// never a change to engine code, matching src/data/superRates.js's
// convention.
//
// Repayment is MARGINAL within each bracket except the last: once
// repayment income reaches the top threshold, the rate applies to the
// WHOLE income, not just the excess — a genuine cliff, implemented
// literally per the spec rather than smoothed.
//
// Indexation (ASSUMPTION — not confirmed against the firm reference,
// per the spec's explicit "confirm before implementing and state which
// you used"): HELP repayment-income thresholds are, in reality, indexed
// to WPI (Wage Price Index) since the 1 June 2023 reform. WPI is not
// one of the two bases this tool's engine otherwise models (CPI,
// AWOTE). This build indexes the thresholds at AWOTE — the tool's
// existing wage-index proxy, and the closer of the two available bases
// to a wage-linked index — compounded nominally from the FY2026/27 base
// year and deflated to real, with no artificial rounding step (unlike
// super's caps, HELP thresholds are published as exact indexed dollar
// figures each year, not rounded to a legislated increment). Confirm
// the correct basis against the firm reference before relying on this
// for advice; state.assumptions.bracketMode's "frozen" (no-indexation)
// toggle freezes these thresholds nominally too, same as every other
// indexed tax figure.
//
// The HELP BALANCE itself (plan.<person>.helpBalance, stored real $) is
// a separate indexation question from the thresholds above. This build
// indexes it annually at the LOWER of CPI and AWOTE (deterministic.js's
// per-year loop, "HELP/HECS annual indexation") — the post-1 June 2023
// legislated basis is the lower of CPI or WPI; AWOTE stands in for WPI,
// the same proxy used for the threshold indexation above. When AWOTE ≥
// CPI (the typical case), this is equivalent to indexing at exactly CPI
// — a real-dollar balance needs no extra growth applied to hold flat —
// so the indexation figure reported on the Liabilities table is usually
// (not always) zero. CONFIRM against the firm reference before relying
// on this for advice; disclosed in the Parameters modal.

import { taxFromBrackets } from "../Tax/engine.js";

const BASE_FY_START_YEAR = 2026;

export const HELP_RATES_BASE = Object.freeze({
  asAt: "2026-07-01",
  source: "Macquarie Big Black Book 2026/27 (20 Mar 2026 rate period edition)",
  // [floor, ceiling, rate] triples, fed straight into taxFromBrackets
  // (Tax/engine.js) — the same marginal-bracket algorithm income tax
  // uses. $9,028 (the legislated base of the third bracket) is not
  // stored separately: it falls straight out of the marginal
  // computation of the second bracket (60,189 × 15% = $9,028.35), so
  // there is nothing to keep in sync by hand.
  brackets: Object.freeze([
    [0, 69528, 0],
    [69528, 129717, 0.15],
    [129717, 186052, 0.17],
  ]),
  cliffThreshold: 186052, // at/above this, 10% of the WHOLE income — see helpRepaymentAmount
  cliffRate: 0.10,
});

// helpRatesFor(fyStartYear, bracketMode, cpi, awote) → the FY's
// brackets/cliff threshold in real dollars, same signature shape as
// superRatesFor.
export function helpRatesFor(fyStartYear, bracketMode = "indexed", cpi = 0.025, awote = 0.035) {
  const tReal = Math.max(0, fyStartYear - BASE_FY_START_YEAR);
  const tNominal = bracketMode === "frozen" ? 0 : tReal;
  const deflate = Math.pow(1 + cpi, tReal);
  const factor = Math.pow(1 + awote, tNominal) / deflate;
  return {
    ...HELP_RATES_BASE,
    brackets: HELP_RATES_BASE.brackets.map(([floor, ceiling, rate]) => [floor * factor, ceiling * factor, rate]),
    cliffThreshold: HELP_RATES_BASE.cliffThreshold * factor,
  };
}

// The compulsory repayment for one person for one FY, before capping
// against their remaining balance (deterministic.js does that — this
// function knows nothing about balances, only repayment income).
export function helpRepaymentAmount(repaymentIncome, rates = HELP_RATES_BASE) {
  if (!(repaymentIncome > 0)) return 0;
  if (repaymentIncome >= rates.cliffThreshold) return repaymentIncome * rates.cliffRate;
  return taxFromBrackets(repaymentIncome, rates.brackets);
}
