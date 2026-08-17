// Genuine redundancy and Employment Termination Payment (ETP) reference
// rates — same indexation pattern as superRates.js: every indexed
// figure is compounded NOMINALLY from the FY2026/27 base year at its
// own basis rate, rounded to its own legislated step, then deflated to
// real. AS AT FY2026/27 — training-knowledge figures, NOT re-verified
// against ato.gov.au this session; confirm before relying on this for
// advice (same disclosure convention as every other embedded schedule).
//
// preservationAge (60) mirrors superRates.js's own SUPER_RATES_BASE
// figure rather than importing it — this module models the ETP-specific
// age test independently of super access, even though the number
// happens to coincide for this tool's only-modelled cohort (born from
// 1 Jul 1964).
const BASE_FY_START_YEAR = 2026;

export const ETP_RATES_BASE = Object.freeze({
  asAt: "2026-07-01",
  source: "Training-knowledge figures — UNVERIFIED against ato.gov.au this session; confirm before relying on this for advice.",
  // Genuine redundancy/early retirement scheme tax-free limit: base +
  // per-completed-year, AWOTE-indexed, each rounding to the nearest $10
  // (ATO's own published method).
  redundancyBaseAmount: 13598,
  redundancyPerYearAmount: 6801,
  // ETP cap: AWOTE-indexed, rounds DOWN to the nearest $5,000.
  etpCap: 270000,
  // Whole-of-income cap: a flat $ figure NOT indexed under either
  // bracketMode — has held this nominal value in law since 2007.
  wholeOfIncomeCap: 180000,
  preservationAge: 60,
  // Concessional rate up to the relevant cap, 45% above it either way;
  // Medicare levy (2%) applies on top of whichever rate applied.
  etpTaxRates: Object.freeze({
    belowPreservation: { concessional: 0.30, top: 0.45 },
    atOrAbovePreservation: { concessional: 0.15, top: 0.45 },
  }),
  medicareLevyRate: 0.02,
});

function roundDownTo(value, step) {
  return Math.floor(value / step) * step;
}

// etpRatesFor(fyStartYear, bracketMode, cpi, awote) → the FY's rates,
// resolved to real dollars under the plan's bracket mode — same
// contract as superRatesFor. The redundancy base/per-year amounts are
// NOT rounded to a step here (unlike the ETP cap's $5,000 step below) —
// 13,598/6,801 are themselves the ATO's own already-rounded FY2026/27
// figures, not round numbers to begin with, and this tool's own
// rounding convention isn't confirmed for them; compounding smoothly
// from that exact base is the more honest choice than guessing a step.
export function etpRatesFor(fyStartYear, bracketMode = "indexed", cpi = 0.025, awote = 0.035) {
  const tReal = Math.max(0, fyStartYear - BASE_FY_START_YEAR);
  const tNominal = bracketMode === "frozen" ? 0 : tReal;
  const deflate = Math.pow(1 + cpi, tReal);
  const baseNom = ETP_RATES_BASE.redundancyBaseAmount * Math.pow(1 + awote, tNominal);
  const perYearNom = ETP_RATES_BASE.redundancyPerYearAmount * Math.pow(1 + awote, tNominal);
  const capNom = roundDownTo(ETP_RATES_BASE.etpCap * Math.pow(1 + awote, tNominal), 5000);
  return {
    redundancyBaseAmount: baseNom / deflate,
    redundancyPerYearAmount: perYearNom / deflate,
    etpCap: capNom / deflate,
    wholeOfIncomeCap: ETP_RATES_BASE.wholeOfIncomeCap / deflate, // never indexed
    preservationAge: ETP_RATES_BASE.preservationAge,
    etpTaxRates: ETP_RATES_BASE.etpTaxRates,
    medicareLevyRate: ETP_RATES_BASE.medicareLevyRate,
  };
}

// redundancyTaxFreeAmount(rates, completedYearsOfService) → the
// non-assessable, non-exempt portion of a GENUINE redundancy payment
// (resignation/retirement gets none — the caller gates that).
export function redundancyTaxFreeAmount(rates, completedYearsOfService) {
  return rates.redundancyBaseAmount + rates.redundancyPerYearAmount * Math.max(0, completedYearsOfService);
}

// etpTax(rates, taxableComponent, age, opts) → { tax, cap } for the ETP
// taxable component's own flat tax (concessional rate up to the
// relevant cap, 45% above, plus Medicare on the whole component).
//
// opts.genuineRedundancy: true → the cap is the ETP cap ALONE (an
// excluded ETP — the whole-of-income cap does not apply). false (a
// resignation/retirement ETP) → the cap is the LESSER of the ETP cap
// and (whole-of-income cap − other taxable income this FY); opts
// .otherTaxableIncomeThisFY approximates "other taxable income" as the
// person's own accrued ordinary income THIS FY up to the termination
// point (disclosed simplification — real law uses the full FY's
// assessable income, not knowable mid-year; this is the same kind of
// as-you-go estimate PAYG withholding itself already relies on).
export function etpTax(rates, taxableComponent, age, { genuineRedundancy = true, otherTaxableIncomeThisFY = 0 } = {}) {
  if (taxableComponent <= 0) return { tax: 0, cap: 0 };
  const cap = genuineRedundancy
    ? rates.etpCap
    : Math.max(0, Math.min(rates.etpCap, rates.wholeOfIncomeCap - Math.max(0, otherTaxableIncomeThisFY)));
  const bracket = age >= rates.preservationAge ? rates.etpTaxRates.atOrAbovePreservation : rates.etpTaxRates.belowPreservation;
  const belowCap = Math.min(taxableComponent, cap);
  const aboveCap = Math.max(0, taxableComponent - cap);
  const incomeTax = belowCap * bracket.concessional + aboveCap * bracket.top;
  const medicare = taxableComponent * rates.medicareLevyRate;
  return { tax: incomeTax + medicare, cap };
}
