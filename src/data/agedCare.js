// Residential aged care rates (spec 29). Source: Macquarie Big Black
// Book, aged care and social security section — a PRIMARY professional
// source, superseding the secondary-sourced figures this module
// started with (see git history for that first pass; every dollar
// figure below is now BBB-sourced unless flagged otherwise).
//
// Period: 20 March 2026 – 19 September 2026. Aged care figures index
// twice yearly (20 March / 20 September; income thresholds ALSO on 1
// July) — a materially faster cycle than this engine's own annual-FY
// step. Following the same disclosed simplification `data/agePension.js`
// already uses for its own twice-yearly figures, indexation here is
// applied once at 1 July per FY.
//
// TWO COMPLETE REGIMES run permanently side by side, selected by the
// resident's own entry date, NOT a migration:
//   - PRE_1_NOV_2025 ("old"): entry 1 Jul 2014 – 31 Oct 2025. The
//     "means tested fee" (§2) — a simple single-taper income test, a
//     4-bracket assets test, both amounts summed then capped three
//     ways (subsidy, a DAILY max, an ANNUAL max, and the LIFETIME cap).
//   - FROM_1_NOV_2025 ("new"): entry from 1 Nov 2025, OR an existing
//     pre-Nov-2025 resident who explicitly opts in (the spec's own
//     words: "model the opt-in as a flag" — never silently switched).
//     The "NCCC + Hotelling" contributions (§3) — a 6-bracket income
//     test and a 6-bracket assets test, EACH WITH TWO LITERAL PLATEAU
//     BANDS (a flat dollar amount across a range, not a taper — get
//     this backwards and every fee in that band is wrong), an
//     ordering rule (Hotelling saturates first, THEN the Non-Clinical
//     Care Contribution starts), and NCCC's own lifetime cap + 4-year
//     time limit (shared with Support at Home and pre-Nov-2025 means-
//     tested fees on the SAME lifetime cap — a single running total
//     per person, not per-contribution-type).
//   - Pre-1 July 2014 residents are grandfathered under an OLDER
//     regime again — flagged and NOT modelled at all (spec's own
//     words), never approximated as either of the two above.
//
// A RAD is EXEMPT from the Age Pension assets/income tests but IS
// assessable for the aged care means test (§5.6) — the asymmetry at
// the heart of the RAD/DAP decision. This module only computes the
// AGED CARE side; the Age Pension side already naturally excludes a
// RAD simply by never being told about it (a RAD is never entered as
// one of the person's ordinary financial assets) — see
// agedCareMeansTest.js's own header for where this is made explicit.
//
// THE FORMER HOME gets TWO treatments of the SAME asset: capped at
// $214,884 per person for the ONGOING means test (§2/§3), but NOT
// capped (full market value) for the ONE-OFF accommodation assessment
// at entry (§4) that decides accommodation contribution vs payment and
// RAD/DAP negotiability. Both figures/functions are exported
// separately — never conflate them.
export const AGED_CARE_RATES_BASE = Object.freeze({
  periodStart: "2026-03-20",
  periodEnd: "2026-09-19", // rolls the day after — see agedCareStalenessWarning()
  source: "Macquarie Big Black Book, aged care and social security section — a primary professional source.",

  // Basic daily fee is DERIVED (85% of the single basic Age Pension
  // rate — BBB confirms $66.80/day at the current single rate), never
  // stored here, so it indexes correctly with the age pension rate and
  // can't drift out of step — see basicDailyFeeAnnual() below.

  maxAccommodationSupplementAnnual: 26317.20, // BBB corrects the earlier $70.94/day ($72.10/day-equivalent) figure

  // §2 — pre-1 November 2025 ("old") regime.
  oldRegime: {
    incomeThresholdSingle: 35313.20,
    incomeThresholdCoupleEach: 34585.20,
    incomeTaperRate: 0.5, // flat 50% above the threshold — no plateau in the OLD regime
    // Assets test brackets — per person (a couple member uses HALF the
    // couple's combined assets against this same table). See
    // evaluateTieredAmount() below for the bracket-walk mechanics.
    assetsBrackets: [
      { from: 0, to: 64500, mode: "nil", base: 0, rate: 0 },
      { from: 64500, to: 214884, mode: "taper", base: 0, rate: 0.175 },
      { from: 214884, to: 515652, mode: "taper", base: 26317.20, rate: 0.01 },
      { from: 515652, to: Infinity, mode: "taper", base: 29324.88, rate: 0.02 },
    ],
    dailyMax: 370.39, // a SEPARATE cap from the annual one — apply both (BBB's own note)
    annualCap: 35910.43,
    lifetimeCap: 86185.23, // shares the SAME running total as the new regime's NCCC — see NCCC_LIFETIME_CAP
  },

  // §3 — from 1 November 2025 ("new") regime. Both income and assets
  // tests below have TWO LITERAL PLATEAU BANDS each (mode: "flat") —
  // implement literally, not as a taper across the band.
  newRegime: {
    incomeBracketsSingle: [
      { from: 0, to: 35313.20, mode: "nil", base: 0, rate: 0 },
      { from: 35313.20, to: 87947.60, mode: "taper", base: 0, rate: 0.5 },
      { from: 87947.60, to: 101105.00, mode: "flat", base: 26317.20, rate: 0 },
      { from: 101105.00, to: 117230.20, mode: "taper", base: 26317.20, rate: 0.5 },
      { from: 117230.20, to: 141252.80, mode: "flat", base: 34379.80, rate: 0 },
      { from: 141252.80, to: Infinity, mode: "taper", base: 34379.80, rate: 0.5 },
    ],
    incomeBracketsCoupleEach: [
      { from: 0, to: 34585.20, mode: "nil", base: 0, rate: 0 },
      { from: 34585.20, to: 87219.60, mode: "taper", base: 0, rate: 0.5 },
      { from: 87219.60, to: 101105.00, mode: "flat", base: 26317.20, rate: 0 },
      { from: 101105.00, to: 117230.20, mode: "taper", base: 26317.20, rate: 0.5 },
      { from: 117230.20, to: 138340.80, mode: "flat", base: 34379.80, rate: 0 },
      { from: 138340.80, to: Infinity, mode: "taper", base: 34379.80, rate: 0.5 },
    ],
    // Assets test — SAME brackets for singles and each couple member
    // (a couple member uses half the couple's combined assets).
    assetsBrackets: [
      { from: 0, to: 64500, mode: "nil", base: 0, rate: 0 },
      { from: 64500, to: 214884, mode: "taper", base: 0, rate: 0.175 },
      { from: 214884, to: 258000, mode: "flat", base: 26317.20, rate: 0 },
      { from: 258000, to: 361366.66, mode: "taper", base: 26317.20, rate: 0.078 },
      { from: 361366.66, to: 536384, mode: "flat", base: 34379.80, rate: 0 },
      { from: 536384, to: Infinity, mode: "taper", base: 34379.80, rate: 0.078 },
    ],
    hotellingMaxAnnual: 8062.60, // $22.15/day — no annual or lifetime cap at all
    ncccMaxAnnual: 39064.48, // $107.32/day
    ncccTimeLimitYears: 4,
    // RAD/RAC retention, from 1 Nov 2025 entrants only: 2% pa, up to 5
    // years, calculated DAILY on the outstanding balance. This engine
    // steps annually — applied once a year as 2% of the balance at the
    // START of that year (a disclosed simplification of the real daily
    // compounding, same annualisation treatment this engine already
    // gives every other sub-annual mechanic).
    radRetentionRatePerYear: 0.02,
    radRetentionCapYears: 5,
    // DAPs index with CPI on 20 March/20 September for 1 Nov 2025+
    // entrants only — pre-Nov-2025 entrants' DAP is NOT indexed at all
    // (see dapAnnualForRegime() below).
  },

  // The NCCC's own lifetime cap — SHARED with pre-1 Nov 2025 means-
  // tested fees, Support at Home contributions, and Home Care income-
  // tested fees (BBB's own words: "includes NCCCs plus means tested
  // residential care fees... plus Support at Home contributions and
  // Home Care income tested fees"). This engine tracks aged CARE
  // contributions on this running total; Support at Home / Home Care
  // themselves are out of scope (spec 29's own Deferred list) and so
  // never contribute to it here — a disclosed narrowing of the real,
  // broader shared cap.
  ncccLifetimeCap: 137917.01,
  ncccTimeLimitYears: 4,

  // §4 — accommodation.
  formerHomeCappedValuePerPerson: 214884, // ONLY for the ongoing means test — NOT the accommodation assessment (uncapped there)
  maxAccommodationPaymentWithoutApproval: 750000, // "from 1 Jan 2025", indexed twice yearly
  maxAccommodationPaymentWithApproval: 758627, // the Pricing Commissioner may approve higher still
  minimumPermissibleAssets: 64500, // a facility cannot accept a RAD leaving the resident below this

  // MPIR — CONFLICTING sources: the BBB gives 7.96% for the 1 Apr – 30
  // Jun 2026 quarter specifically; a secondary source separately gave
  // 8.43% "from 1 July 2026". MPIR resets QUARTERLY (a different cycle
  // again from the 20 Mar/20 Sep aged-care cycle) — we are now in the
  // September 2026 quarter, so NEITHER figure is necessarily current.
  // Stored as the BBB's own Apr–Jun figure, explicitly flagged as
  // needing confirmation for the current quarter, and overridable (see
  // agedCareRatesFor's own `overrides.mpir`). Per the spec, MPIR is
  // FIXED AT THE RATE APPLYING ON THE RESIDENT'S OWN ENTRY DATE for
  // the life of that resident's DAP — never re-indexed for them
  // afterward, even as this module's own "current" figure moves for
  // later entrants (the caller's responsibility — this module is
  // stateless; see dapAnnualRate() below).
  mpir: 0.0796,
  mpirAsAtQuarter: "1 April 2026 – 30 June 2026",
  mpirNeedsConfirmation: true, // ⚠ the CURRENT (September 2026) quarter's own rate has not been confirmed
});

// The NCCC lifetime cap constant, exported at top level for parity
// with the old regime's own `oldRegime.lifetimeCap` — see
// AGED_CARE_RATES_BASE.ncccLifetimeCap for the full disclosure on what
// it's shared with.
export const NCCC_LIFETIME_CAP = AGED_CARE_RATES_BASE.ncccLifetimeCap;

// agedCareStalenessWarning(calendarDate, base) → null, or a string
// naming the loaded period, whenever `calendarDate` falls after the
// loaded rate period's own end. `calendarDate` is a JS Date or an
// ISO/parseable date string — the caller passes whichever date in the
// projection it wants checked (e.g. the final projection year's own
// calendar date), not "today".
export function agedCareStalenessWarning(calendarDate, base = AGED_CARE_RATES_BASE) {
  const d = calendarDate instanceof Date ? calendarDate : new Date(calendarDate);
  const periodEnd = new Date(base.periodEnd);
  if (Number.isNaN(d.getTime()) || d <= periodEnd) return null;
  return `Aged care rates loaded for ${base.periodStart} – ${base.periodEnd} — this projection runs past that period's end. Aged care figures index every 20 March and 20 September (income thresholds also 1 July); confirm current rates (Services Australia, My Aged Care, or the firm's current Big Black Book) before relying on this for advice.`;
}

// The basic daily fee is 85% of the single Age Pension's "maximum
// BASIC rate" — a defined legislative term that EXCLUDES the Pension
// Supplement and Energy Supplement, unlike `data/agePension.js`'s own
// `singleRate` (deliberately the ALL-INCLUSIVE figure — see that
// module's own comment: "the single all-in figure Centrelink's own
// assets/income test formulas apply against", correct for THAT
// purpose but not this one). Verified against the BBB's own numbers:
// fortnightly $1,200.90 all-inclusive, incl. pension supplement $86.50
// and energy supplement $14.10 — base = $1,100.30/fortnight. 85% of
// that, ÷ 14 (days per fortnight — the exact conversion, not an
// annual/365 approximation) = $66.804/day, matching the BBB's own
// stated $66.80/day to the cent.
//
// This engine's own age-pension model does not track the base/
// supplement split separately (a spec 21a architectural choice, not
// something this commit revisits) — so BASE_FRACTION below is a FIXED
// ratio calibrated at this period's own figures, applied to whatever
// the all-inclusive rate resolves to in a future FY. Disclosed
// simplification: assumes the supplements scale proportionally with
// the whole rate over time, rather than indexing independently.
const BASE_FRACTION = (1200.90 - 86.50 - 14.10) / 1200.90; // 1100.30 / 1200.90

export function basicDailyFeeDaily(singleAgePensionRateAnnual) {
  const fortnightlyBase = (singleAgePensionRateAnnual / 26) * BASE_FRACTION;
  return (0.85 * fortnightlyBase) / 14;
}
export function basicDailyFeeAnnual(singleAgePensionRateAnnual, daysPerYear = 365) {
  return basicDailyFeeDaily(singleAgePensionRateAnnual) * daysPerYear;
}

function nominalOf(base, basisRate, step, tNominal) {
  return Math.floor((base * Math.pow(1 + basisRate, tNominal)) / step) * step;
}

const BASE_FY_START_YEAR = 2026; // the FY2026-27 (20 Mar 2026 rate period) figures above

function indexBracket(b, cpi, tNominal, deflate) {
  return {
    from: nominalOf(b.from, cpi, 0.01, tNominal) / deflate,
    to: b.to === Infinity ? Infinity : nominalOf(b.to, cpi, 0.01, tNominal) / deflate,
    mode: b.mode,
    base: nominalOf(b.base, cpi, 0.01, tNominal) / deflate,
    rate: b.rate,
  };
}

// agedCareRatesFor(fyStartYear, bracketMode, cpi, overrides) → this
// FY's resolved figures, all CPI-indexed (disclosed simplification,
// module header) except `mpir` (flat — see its own comment).
// `overrides` is a per-figure override bag — any key present
// (non-null) replaces the module's own BASE value before indexation,
// the same override-or-default shape `dutyOverride`/`lmiOverride`
// already use elsewhere, surfaced per figure since every one of these
// may need a firm-confirmed correction independent of the rest.
export function agedCareRatesFor(fyStartYear, bracketMode = "indexed", cpi = 0.025, overrides = {}) {
  const b = AGED_CARE_RATES_BASE;
  const tReal = Math.max(0, fyStartYear - BASE_FY_START_YEAR);
  const tNominal = bracketMode === "frozen" ? 0 : tReal;
  const deflate = Math.pow(1 + cpi, tReal);
  const flat = (key, step = 0.01) => nominalOf(overrides?.[key] ?? b[key], cpi, step, tNominal) / deflate;

  return {
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    source: b.source,
    maxAccommodationSupplementAnnual: flat("maxAccommodationSupplementAnnual"),
    formerHomeCappedValuePerPerson: flat("formerHomeCappedValuePerPerson", 1),
    maxAccommodationPaymentWithoutApproval: flat("maxAccommodationPaymentWithoutApproval", 1),
    maxAccommodationPaymentWithApproval: flat("maxAccommodationPaymentWithApproval", 1),
    minimumPermissibleAssets: flat("minimumPermissibleAssets", 1),
    ncccLifetimeCap: flat("ncccLifetimeCap"),
    ncccTimeLimitYears: overrides?.ncccTimeLimitYears ?? b.ncccTimeLimitYears,
    oldRegime: {
      incomeThresholdSingle: nominalOf(overrides?.oldRegimeIncomeThresholdSingle ?? b.oldRegime.incomeThresholdSingle, cpi, 0.01, tNominal) / deflate,
      incomeThresholdCoupleEach: nominalOf(overrides?.oldRegimeIncomeThresholdCoupleEach ?? b.oldRegime.incomeThresholdCoupleEach, cpi, 0.01, tNominal) / deflate,
      incomeTaperRate: b.oldRegime.incomeTaperRate,
      assetsBrackets: b.oldRegime.assetsBrackets.map((br) => indexBracket(br, cpi, tNominal, deflate)),
      dailyMax: nominalOf(overrides?.oldRegimeDailyMax ?? b.oldRegime.dailyMax, cpi, 0.01, tNominal) / deflate,
      annualCap: nominalOf(overrides?.oldRegimeAnnualCap ?? b.oldRegime.annualCap, cpi, 0.01, tNominal) / deflate,
      lifetimeCap: nominalOf(overrides?.oldRegimeLifetimeCap ?? b.oldRegime.lifetimeCap, cpi, 0.01, tNominal) / deflate,
    },
    newRegime: {
      incomeBracketsSingle: b.newRegime.incomeBracketsSingle.map((br) => indexBracket(br, cpi, tNominal, deflate)),
      incomeBracketsCoupleEach: b.newRegime.incomeBracketsCoupleEach.map((br) => indexBracket(br, cpi, tNominal, deflate)),
      assetsBrackets: b.newRegime.assetsBrackets.map((br) => indexBracket(br, cpi, tNominal, deflate)),
      hotellingMaxAnnual: nominalOf(overrides?.hotellingMaxAnnual ?? b.newRegime.hotellingMaxAnnual, cpi, 0.01, tNominal) / deflate,
      ncccMaxAnnual: nominalOf(overrides?.ncccMaxAnnual ?? b.newRegime.ncccMaxAnnual, cpi, 0.01, tNominal) / deflate,
      ncccTimeLimitYears: b.newRegime.ncccTimeLimitYears,
      radRetentionRatePerYear: overrides?.radRetentionRatePerYear ?? b.newRegime.radRetentionRatePerYear,
      radRetentionCapYears: overrides?.radRetentionCapYears ?? b.newRegime.radRetentionCapYears,
    },
    // MPIR: flat nominal, not CPI-indexed — see AGED_CARE_RATES_BASE's
    // own comment. Overridable like every other figure here.
    mpir: overrides?.mpir ?? b.mpir,
    mpirAsAtQuarter: b.mpirAsAtQuarter,
    mpirNeedsConfirmation: overrides?.mpir != null ? false : b.mpirNeedsConfirmation,
  };
}

// evaluateTieredAmount(value, brackets) → the bracket-walk result: 0
// below the first threshold, a LITERAL flat amount across a "flat"
// bracket (never a taper, even partway through the band), or
// base + rate × (value − from) across a "taper" bracket. The single
// mechanics function BOTH regimes' income and assets tests share —
// only the bracket TABLE differs between them (see AGED_CARE_RATES_BASE).
export function evaluateTieredAmount(value, brackets) {
  const v = Math.max(0, value);
  for (const b of brackets) {
    if (v >= b.from && v < b.to) {
      return b.mode === "flat" ? b.base : b.base + b.rate * (v - b.from);
    }
  }
  const last = brackets[brackets.length - 1];
  return last.mode === "flat" ? last.base : last.base + last.rate * (v - last.from);
}

// dapAnnualRate(radAmount, mpirAtEntry) → the daily accommodation
// payment implied by a given RAD amount, expressed as an ANNUAL rate.
export function dapAnnualRate(mpirAtEntry) {
  return mpirAtEntry;
}
export function dapDaily(radAmount, mpirAtEntry, daysPerYear = 365) {
  return (radAmount * mpirAtEntry) / daysPerYear;
}

// combinationPayment({ accommodationPrice, radPaid, mpirAtEntry }) →
// the DAP owed on whatever balance is left unpaid. RAD-only and
// DAP-only are just the two ends of this same function.
export function combinationPayment({ accommodationPrice, radPaid, mpirAtEntry, daysPerYear = 365 }) {
  const unpaidBalance = Math.max(0, accommodationPrice - Math.max(0, radPaid));
  return {
    radPaid: Math.max(0, Math.min(radPaid, accommodationPrice)),
    unpaidBalance,
    dapAnnual: unpaidBalance * mpirAtEntry,
    dapDaily: dapDaily(unpaidBalance, mpirAtEntry, daysPerYear),
  };
}

// radRefundOnExit({ radPaid, yearsInCare, enteredFrom1Nov2025,
// retentionRatePerYear, retentionCapYears }) → the refund due on
// leaving care or death. Retention applies ONLY to 1 Nov 2025+
// entrants (BBB §4: "fully refundable for entrants before 1 November
// 2025"); pre-Nov-2025 entrants always get the full RAD back
// regardless of any rate passed in. Real rule: 2% pa, up to 5 years,
// calculated DAILY on the outstanding balance — approximated here as
// a once-a-year 2%-of-opening-balance charge (this engine's own
// annual-step convention), a disclosed simplification of the real
// daily compounding.
export function radRefundOnExit({
  radPaid, yearsInCare, enteredFrom1Nov2025 = false,
  retentionRatePerYear = AGED_CARE_RATES_BASE.newRegime.radRetentionRatePerYear,
  retentionCapYears = AGED_CARE_RATES_BASE.newRegime.radRetentionCapYears,
}) {
  if (!enteredFrom1Nov2025) return { refund: radPaid, retained: 0, modelled: true };
  const yearsRetained = Math.max(0, Math.min(yearsInCare, retentionCapYears));
  const retainedPct = Math.min(1, retentionRatePerYear * yearsRetained);
  const retained = radPaid * retainedPct;
  return { refund: radPaid - retained, retained, modelled: true };
}

// radRealValueAtYear(radPaidReal, cpi, yearsElapsed) → a RAD refund is
// fixed in NOMINAL dollars. Expressed here back into TODAY's (year-0)
// real dollars for consistency with the rest of this engine (CLAUDE.md's
// Returns convention) — its value decays with inflation the longer it
// sits with the facility before being refunded, part of the RAD-vs-DAP
// trade-off.
export function radRealValueAtYear(radPaidReal, cpi, yearsElapsed) {
  return radPaidReal / Math.pow(1 + cpi, Math.max(0, yearsElapsed));
}

// trackLifetimeCare(priorCumulative, thisYearFee, lifetimeCap) → the
// new running total and how much of thisYearFee was actually
// chargeable before the cap bound. The cap is CUMULATIVE and persists
// across a break in care (spec's own words) — the caller is
// responsible for keeping `priorCumulative` on the person across years
// (and across an admission gap), not per-admission.
export function trackLifetimeCare(priorCumulative, thisYearFee, lifetimeCap) {
  const remaining = Math.max(0, lifetimeCap - priorCumulative);
  const charged = Math.min(thisYearFee, remaining);
  return { cumulative: priorCumulative + charged, charged, capped: charged < thisYearFee - 1e-9 };
}
