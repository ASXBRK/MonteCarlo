// Aged care means testing (spec 29, Commit 2) — a SEPARATE test from
// the Age Pension's own (agePensionMeansTest.js): different thresholds,
// different taper structure, and — critically — different former-home
// treatment (capped value here, versus the Age Pension's full
// exemption). Pure mechanics only; nothing here reads plan state
// directly, matching every other means-test module in this codebase.
//
// NOT YET IMPLEMENTED: incomeTestedAmount()/assetsTestedAmount() below
// — the aged care income test's free area/taper and the assets test's
// tier thresholds/rates were not supplied (see data/agedCare.js's own
// header) and are NOT the same figures as the Age Pension's. Both
// return `null` explicitly. Everything else in this file — the former
// home's capped-value/exemption/sale treatment, and assembling the
// assessable-assets total a RAD feeds into — is fully specified by the
// spec and implemented here.
export function incomeTestedAmount() {
  return null; // not yet configured — see module header
}
export function assetsTestedAmount() {
  return null; // not yet configured — see module header
}

// formerHomeAssessedValue({ marketValue, occupiedByProtectedPerson,
// cappedValue }) → the amount the former home contributes to aged
// care ASSESSABLE ASSETS (a separate figure from the Age Pension's own
// principal-home treatment, which exempts it outright regardless of
// occupancy):
//   - FULLY EXEMPT (0) while a protected person lives there — a
//     spouse, a dependent child, or a carer/close relative meeting the
//     eligibility conditions (the spec's own list; this function takes
//     the already-resolved boolean rather than modelling each
//     protected-person TYPE, since the plan state has no carer/close-
//     relative concept to model them individually against — see
//     Commit 5's own input field, "protected-person status of the
//     former home").
//   - Otherwise, the LESSER of market value and the capped value —
//     never full market value, unlike the Age Pension.
// Once sold, this function no longer applies at all — see
// formerHomeSoldAssessableAssets's own header below.
export function formerHomeAssessedValue({ marketValue, occupiedByProtectedPerson, cappedValue }) {
  if (occupiedByProtectedPerson) return 0;
  return Math.min(Math.max(0, marketValue), cappedValue);
}

// formerHomeRentTreatment(entryDate) → which treatment applies to rent
// from a former home let out while the resident pays a DAP: the spec's
// own disclosed history — rent was historically EXEMPT from the income
// test for entrants BEFORE 1 January 2016; entrants from that date
// have the rent counted as assessable income. A structural rule (the
// date itself, and which side of it does what), not a dollar figure,
// so it needs no user-supplied figure and is implemented directly
// (unlike the tier thresholds — see module header).
const RENT_EXEMPTION_CUTOFF = "2016-01-01";
export function formerHomeRentTreatment(entryDate) {
  const d = entryDate instanceof Date ? entryDate : new Date(entryDate);
  if (Number.isNaN(d.getTime())) return null;
  return d < new Date(RENT_EXEMPTION_CUTOFF)
    ? { exempt: true, reason: `Entered care before ${RENT_EXEMPTION_CUTOFF} — rent from the former home is historically exempt from the aged care income test.` }
    : { exempt: false, reason: `Entered care on or after ${RENT_EXEMPTION_CUTOFF} — rent from the former home is assessable income.` };
}

// agedCareAssessableAssets({ otherFinancialAssets, formerHome, radPaid })
// → the total assessable-assets figure the (still missing)
// assetsTestedAmount() will eventually taper. A RAD is an assessable
// asset here EVEN THOUGH it is refundable (the spec's central,
// easy-to-invert trade-off: paying a large RAD to reduce accommodation
// cost INCREASES the means-tested fee) — it is added in on exactly the
// same footing as any other financial asset, never excluded.
// `formerHome` is the already-resolved figure from
// formerHomeAssessedValue() (0 while exempt, capped value otherwise,
// or the full sale proceeds once sold — see the caller's own
// responsibility to pass the right figure once a sale has happened).
export function agedCareAssessableAssets({ otherFinancialAssets = 0, formerHome = 0, radPaid = 0 }) {
  return Math.max(0, otherFinancialAssets) + Math.max(0, formerHome) + Math.max(0, radPaid);
}
