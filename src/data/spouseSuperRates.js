// Spouse contribution tax offset, government co-contribution, and LISTO
// reference rates (spec 19, Commit 6) — same indexation pattern as
// superRates.js/etpRates.js. AS AT FY2026/27 — training-knowledge
// figures, UNVERIFIED against ato.gov.au this session; confirm before
// relying on this for advice.
const BASE_FY_START_YEAR = 2026;

export const SPOUSE_SUPER_RATES_BASE = Object.freeze({
  asAt: "2026-07-01",
  source: "Training-knowledge figures — UNVERIFIED against ato.gov.au this session; confirm before relying on this for advice.",
  // Spouse contribution tax offset — flat figures, NOT indexed.
  spouseOffsetRate: 0.18,
  spouseOffsetContributionCap: 3000, // the "lesser of the contribution and $3,000"
  spouseIncomeLowerThreshold: 37000, // notional cap starts phasing out above this
  spouseIncomeUpperThreshold: 40000, // nil above this
  // Government co-contribution — flat rate, AWOTE-indexed thresholds.
  coContributionRate: 0.5,
  coContributionMax: 500,
  coContributionLowerThreshold: 49293,
  coContributionUpperThreshold: 64293,
  coContributionEligibleIncomeTestPct: 0.10, // ≥10% of income from employment/business
  // LISTO — flat rate/cap/threshold, none indexed (the $37,000 income
  // test threshold mirrors the bottom marginal tax bracket, held flat).
  listoRate: 0.15,
  listoMax: 500,
  listoIncomeThreshold: 37000,
  listoEligibleIncomeTestPct: 0.10,
});

function nominalOf(base, basisRate, tNominal) {
  return base * Math.pow(1 + basisRate, tNominal);
}

// spouseSuperRatesFor(fyStartYear, bracketMode, cpi, awote) → the FY's
// rates, resolved to real dollars — same contract as superRatesFor.
// Only the co-contribution thresholds are indexed (AWOTE); everything
// else in this module is a flat figure held nominal, same convention
// carryForwardTsbGate/div293Threshold already use in superRates.js.
export function spouseSuperRatesFor(fyStartYear, bracketMode = "indexed", cpi = 0.025, awote = 0.035) {
  const tReal = Math.max(0, fyStartYear - BASE_FY_START_YEAR);
  const tNominal = bracketMode === "frozen" ? 0 : tReal;
  const deflate = Math.pow(1 + cpi, tReal);
  const lowerNom = nominalOf(SPOUSE_SUPER_RATES_BASE.coContributionLowerThreshold, awote, tNominal);
  const upperNom = nominalOf(SPOUSE_SUPER_RATES_BASE.coContributionUpperThreshold, awote, tNominal);
  return {
    ...SPOUSE_SUPER_RATES_BASE,
    coContributionLowerThreshold: lowerNom / deflate,
    coContributionUpperThreshold: upperNom / deflate,
    // Never indexed under either bracketMode — flat nominal, so real
    // value declines every year purely from CPI deflation.
    spouseOffsetContributionCap: SPOUSE_SUPER_RATES_BASE.spouseOffsetContributionCap / deflate,
    spouseIncomeLowerThreshold: SPOUSE_SUPER_RATES_BASE.spouseIncomeLowerThreshold / deflate,
    spouseIncomeUpperThreshold: SPOUSE_SUPER_RATES_BASE.spouseIncomeUpperThreshold / deflate,
    coContributionMax: SPOUSE_SUPER_RATES_BASE.coContributionMax / deflate,
    listoMax: SPOUSE_SUPER_RATES_BASE.listoMax / deflate,
    listoIncomeThreshold: SPOUSE_SUPER_RATES_BASE.listoIncomeThreshold / deflate,
  };
}

// spouseContributionOffset(rates, contribution, spouseIncome) → the
// contributing person's own tax offset for a "spouse" contribution.
// The notional $3,000 cap reduces dollar-for-dollar with the RECEIVING
// spouse's income over $37,000, reaching nil at $40,000.
export function spouseContributionOffset(rates, contribution, spouseIncome) {
  if (!(contribution > 0) || spouseIncome >= rates.spouseIncomeUpperThreshold) return 0;
  const notionalCap = Math.max(0, rates.spouseOffsetContributionCap - Math.max(0, spouseIncome - rates.spouseIncomeLowerThreshold));
  return rates.spouseOffsetRate * Math.min(contribution, notionalCap);
}

// coContribution(rates, personalNonConcessional, totalIncome) → the
// government's co-contribution into super. Phases out linearly between
// the lower and upper income thresholds; the caller applies the 10%
// eligible-income test separately (it needs the person's own income
// composition, not just totals).
export function coContribution(rates, personalNonConcessional, totalIncome) {
  if (!(personalNonConcessional > 0) || totalIncome >= rates.coContributionUpperThreshold) return 0;
  const maxEntitlement = Math.min(rates.coContributionMax, rates.coContributionRate * personalNonConcessional);
  if (totalIncome <= rates.coContributionLowerThreshold) return maxEntitlement;
  const range = rates.coContributionUpperThreshold - rates.coContributionLowerThreshold;
  const taper = 1 - (totalIncome - rates.coContributionLowerThreshold) / range;
  return Math.max(0, maxEntitlement * taper);
}

// listo(rates, concessionalContributions, adjustedTaxableIncome) → the
// Low Income Super Tax Offset. The caller applies the 10% eligible-
// income test separately, same reasoning as coContribution above.
export function listo(rates, concessionalContributions, adjustedTaxableIncome) {
  if (!(concessionalContributions > 0) || adjustedTaxableIncome >= rates.listoIncomeThreshold) return 0;
  return Math.min(rates.listoMax, rates.listoRate * concessionalContributions);
}
