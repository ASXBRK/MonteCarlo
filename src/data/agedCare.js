// Residential aged care rates (spec 29, Commit 1).
//
// ⚠ RATE SOURCING RULE (spec 29's own header, restated here because
// it governs this entire file): NEVER web-search aged care rates.
// Every dollar figure below was supplied directly by the user from a
// mix of general secondary sources — explicitly NOT the firm's own Big
// Black Book — cross-checked against each other where the user could,
// and several are genuinely UNVERIFIED, APPROXIMATE, or unresolved
// between conflicting sources. Each is marked accordingly below and
// carries its own `source`/period note. None should be presented to a
// client as confirmed until checked against the firm's current
// reference. If the rate period below has rolled by the time this is
// used, STOP and ask the user for the new figures — do not extrapolate
// or search.
//
// Period covered: 20 March 2026 – 19 September 2026. Aged care figures
// index twice yearly (20 March / 20 September) — a materially faster
// cycle than this engine's own annual-FY step. Following the same
// disclosed simplification `data/agePension.js` already uses for its
// own twice-yearly-in-reality figures, indexation here is applied once
// at 1 July per FY.
//
// NOT YET IMPLEMENTED: the means-tested fee's own income-tested and
// assets-tested amounts. That derivation needs the aged care income
// test's free area/taper and the assets test's tier thresholds/rates
// — genuinely different figures from the age pension's own (this is a
// SEPARATE means test per the spec, sharing only the underlying
// assessable-income/assets INPUTS, not the test itself) — and they
// were not supplied. `assetsTestedAmount`/`incomeTestedAmount`
// (Commit 2) return `null` ("not yet configured") rather than 0 or a
// guessed figure — 0 is a valid amount and would be silently
// indistinguishable from "can't compute this yet." Every function
// downstream of them (the full `meansTestedFee`, the 2025 reform
// contributions, which are also means-tested) propagates that `null`
// rather than guessing. `combineMeansTestedFee`/`trackLifetimeCare`
// below — the CAPPING and lifetime-accumulation logic — use only the
// two real, sourced caps and are fully implemented and tested now.

export const AGED_CARE_RATES_BASE = Object.freeze({
  periodStart: "2026-03-20",
  periodEnd: "2026-09-19", // rolls the day after — see agedCareStalenessWarning()
  source:
    "User-supplied, general secondary sources — NOT the firm's Big Black Book. " +
    "Confirm every figure below against the firm's current reference before relying on it for advice.",

  // Basic daily fee is DERIVED (85% of the single basic Age Pension
  // rate) — see basicDailyFeeAnnual() below — never stored here, so it
  // indexes correctly with the age pension rate and can't drift out of
  // step (spec's own words). Two conflicting figures turned up in the
  // user's search ($66.80 vs $65.55, the latter itself already stale
  // per its own source) — both ignored in favour of the derivation.

  // Means-tested fee caps.
  // Annual cap — UNVERIFIED, two independent sources agree.
  meansTestedFeeAnnualCap: 35910.43,
  // Lifetime cap — UNVERIFIED, pre-1 November 2025 cohort (the OLD
  // regime's own cap; see the "no worse off" dual-regime note, Commit
  // 4). Two OTHER lifetime-cap-shaped figures turned up in the same
  // search and could NOT be confidently attributed from secondary
  // sources alone:
  //   $135,318.69 — candidate for the NEW non-clinical care
  //     contribution's own lifetime cap (which the spec says carries a
  //     four-year time limit) — see NON_CLINICAL_CARE_LIFETIME_CAP
  //     below, left unconfigured rather than guessed.
  //   $137,917.01 — candidate for the Support at Home Program's own
  //     cap under the 1 November 2025 arrangements (out of scope here
  //     regardless — spec 29 models Support at Home only as a flat
  //     cost input).
  // Confirm all three against the firm's own reference before relying
  // on any of them.
  meansTestedFeeLifetimeCap: 86185.23,

  // Maximum accommodation supplement — UNVERIFIED, single source.
  maxAccommodationSupplement: 70.94, // $/day

  // Maximum Permissible Interest Rate — UNVERIFIED. "From 1 July 2026"
  // per the user's own note, straddling this module's 20 March 2026
  // base date. MPIR resets QUARTERLY (a different cycle again from the
  // aged-care 20 Mar/20 Sep cycle) and, per the spec, is FIXED AT THE
  // RATE APPLYING ON THE RESIDENT'S OWN ENTRY DATE for the life of
  // that resident's DAP — never re-indexed for them afterward, even as
  // this module's own "current" figure moves for later entrants (see
  // dapAnnualRate() below). Held flat here — not part of the CPI/AWOTE
  // indexation regime, same treatment as heas.js's own interest rate —
  // since no legislated MPIR schedule exists to index it against; a
  // disclosed simplification (every entrant in a given projection run
  // sees the SAME current MPIR, regardless of assumed entry date).
  mpir: 0.0843,

  // Former home — capped value for the aged care ASSETS test (a
  // separate, more punitive treatment than the Age Pension's own full
  // exemption of the principal home). APPROXIMATE.
  formerHomeCappedValue: 206000,

  // "Low means" resident classification thresholds — APPROXIMATE.
  // Distinct from the means-tested fee's own income/assets TEST tiers
  // (see module header — those are still missing); this pair
  // determines "low means resident" status (affecting accommodation
  // contribution vs payment, and RAD/DAP negotiability), not the
  // ongoing means-tested fee amount itself.
  lowMeansIncomeThreshold: 35000,
  lowMeansAssetsThreshold: 63000,

  // 2025 reforms (Commit 4) — new-regime (1 November 2025 onward)
  // contributions. Structural rules below are confirmed against
  // health.gov.au (primary source) via the user's own research, so
  // treated as reliable even though the dollar figures are not:
  //   - The hotelling contribution has NO annual or lifetime cap.
  //   - The non-clinical care contribution applies ONLY to residents
  //     on the 1 November 2025 arrangements who pay the FULL hotelling
  //     contribution.
  //   - The non-clinical care contribution is capped DAILY; its own
  //     thresholds index in March and September.
  // Both contributions are MEANS-TESTED against the same missing
  // income/assets tiers (module header) — the figures below are each
  // contribution's MAXIMUM daily rate, usable on their own (e.g. a
  // "worst case" cost), but the actual tapered amount a specific
  // resident pays is not yet computable — see hotellingContribution()/
  // nonClinicalCareContribution() below.
  hotellingContributionMaxDaily: 22.15, // UNVERIFIED, single source
  nonClinicalCareContributionMaxDaily: 105.30, // UNVERIFIED, single source
});

// The non-clinical care contribution's own lifetime cap — genuinely
// unresolved (see AGED_CARE_RATES_BASE's own header). `null` means
// "not yet configured": the four-year time limit and lifetime-cap
// binding test (Commit 4) cannot run until the user confirms which of
// the two candidate figures ($135,318.69 or $137,917.01, or neither)
// applies, stamped with its own source.
export const NON_CLINICAL_CARE_LIFETIME_CAP = null;

// agedCareStalenessWarning(calendarDate, base) → null, or a string
// naming the loaded period, whenever `calendarDate` falls after the
// loaded rate period's own end. `calendarDate` is a JS Date or an
// ISO/parseable date string — the caller passes whichever date in the
// projection it wants checked (e.g. the final projection year's own
// calendar date), not "today" — a projection running years into the
// future is stale against this period from the day it's generated,
// regardless of when it's actually viewed.
export function agedCareStalenessWarning(calendarDate, base = AGED_CARE_RATES_BASE) {
  const d = calendarDate instanceof Date ? calendarDate : new Date(calendarDate);
  const periodEnd = new Date(base.periodEnd);
  if (Number.isNaN(d.getTime()) || d <= periodEnd) return null;
  return `Aged care rates loaded for ${base.periodStart} – ${base.periodEnd} — this projection runs past that period's end. Aged care figures index every 20 March and 20 September; confirm current rates (Services Australia, My Aged Care, or the firm's current reference) before relying on this for advice.`;
}

// basicDailyFeeAnnual/basicDailyFeeDaily — DERIVED, never stored (see
// module header). `singleAgePensionRateAnnual` is the already-resolved
// FY figure from `data/agePension.js`'s own `agePensionRatesFor(...)
// .single.rate` — this module deliberately does not import that data
// module itself (data modules in this codebase stay independent; the
// caller, deterministic.js, resolves the age pension rate once and
// passes the plain number through, the same pattern heas.js's own
// drawdown cap already uses for "150% of the maximum pension rate").
export function basicDailyFeeAnnual(singleAgePensionRateAnnual) {
  return 0.85 * singleAgePensionRateAnnual;
}
export function basicDailyFeeDaily(singleAgePensionRateAnnual, daysPerYear = 365) {
  return basicDailyFeeAnnual(singleAgePensionRateAnnual) / daysPerYear;
}

function nominalOf(base, basisRate, step, tNominal) {
  return Math.floor((base * Math.pow(1 + basisRate, tNominal)) / step) * step;
}

const BASE_FY_START_YEAR = 2026; // the FY2026-27 (20 Mar 2026 rate period) figures above

// agedCareRatesFor(fyStartYear, bracketMode, cpi, overrides) → this
// FY's resolved figures. CPI-indexed (disclosed simplification, module
// header) except `mpir` (flat, see its own comment). `overrides` is a
// per-figure override bag — any key present (non-null) replaces the
// module's own value BEFORE indexation, the same override-or-default
// shape `dutyOverride`/`lmiOverride` already use elsewhere in this
// app, surfaced per figure here because every one of these is
// currently unverified/approximate and the user must be able to
// correct any single one without waiting on the rest.
export function agedCareRatesFor(fyStartYear, bracketMode = "indexed", cpi = 0.025, overrides = {}) {
  const b = AGED_CARE_RATES_BASE;
  const ov = (key) => (overrides?.[key] != null ? overrides[key] : b[key]);
  const tReal = Math.max(0, fyStartYear - BASE_FY_START_YEAR);
  const tNominal = bracketMode === "frozen" ? 0 : tReal;
  const deflate = Math.pow(1 + cpi, tReal);
  const indexed = (key, step) => nominalOf(ov(key), cpi, step, tNominal) / deflate;
  return {
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    source: b.source,
    meansTestedFeeAnnualCap: indexed("meansTestedFeeAnnualCap", 0.01),
    meansTestedFeeLifetimeCap: indexed("meansTestedFeeLifetimeCap", 0.01),
    maxAccommodationSupplement: indexed("maxAccommodationSupplement", 0.01),
    formerHomeCappedValue: indexed("formerHomeCappedValue", 1),
    lowMeansIncomeThreshold: indexed("lowMeansIncomeThreshold", 1),
    lowMeansAssetsThreshold: indexed("lowMeansAssetsThreshold", 1),
    hotellingContributionMaxDaily: indexed("hotellingContributionMaxDaily", 0.01),
    nonClinicalCareContributionMaxDaily: indexed("nonClinicalCareContributionMaxDaily", 0.01),
    nonClinicalCareLifetimeCap: overrides?.nonClinicalCareLifetimeCap ?? NON_CLINICAL_CARE_LIFETIME_CAP,
    // MPIR: flat nominal, not CPI-indexed — see AGED_CARE_RATES_BASE's
    // own comment. Overridable like every other figure here.
    mpir: overrides?.mpir ?? b.mpir,
  };
}

// dapAnnualRate(radAmount, mpirAtEntry) → the daily accommodation
// payment implied by a given RAD amount, expressed as an ANNUAL rate
// (× balance ÷ 365 gives the actual daily $ — kept as a rate here so
// the caller can apply it against a REAL, deflating balance the same
// way every other nominal rate in this engine is, per CLAUDE.md's
// Returns convention). `mpirAtEntry` must be the rate resolved for the
// resident's OWN entry FY (agedCareRatesFor(...).mpir at that FY) and
// then held fixed for that resident for the life of the DAP — the
// caller's responsibility (see AGED_CARE_RATES_BASE's own comment);
// this function itself is stateless and just applies whatever rate
// it's given.
export function dapAnnualRate(mpirAtEntry) {
  return mpirAtEntry;
}
export function dapDaily(radAmount, mpirAtEntry, daysPerYear = 365) {
  return (radAmount * mpirAtEntry) / daysPerYear;
}

// combineMeansTestedFee({...}) — the means-tested fee's OUTER formula:
// (income tested amount + assets tested amount) − maximum
// accommodation supplement, floored at 0, then capped at the LEAST of
// the subsidy the government would otherwise pay, the annual cap, and
// the remaining lifetime cap. Fully implemented and tested against the
// two REAL sourced caps — `incomeTestedAmount`/`assetsTestedAmount`
// themselves are the still-missing piece (Commit 2).
export function combineMeansTestedFee({
  incomeTestedAmount, assetsTestedAmount, maxAccommodationSupplement,
  subsidyAmount, annualCap, lifetimeCapRemaining,
}) {
  const raw = Math.max(0, incomeTestedAmount + assetsTestedAmount - maxAccommodationSupplement);
  return Math.max(0, Math.min(raw, subsidyAmount, annualCap, lifetimeCapRemaining));
}

// trackLifetimeCare(priorCumulative, thisYearFee, lifetimeCap) → the
// new running total and how much of thisYearFee was actually
// chargeable before the cap bound. The cap is CUMULATIVE and persists
// across a break in care (spec's own words) — the caller is
// responsible for keeping `priorCumulative` on the person across years
// (and across an admission gap), not per-admission; this function is
// itself stateless.
export function trackLifetimeCare(priorCumulative, thisYearFee, lifetimeCap) {
  const remaining = Math.max(0, lifetimeCap - priorCumulative);
  const charged = Math.min(thisYearFee, remaining);
  return { cumulative: priorCumulative + charged, charged, capped: charged < thisYearFee - 1e-9 };
}
