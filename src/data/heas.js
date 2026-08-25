// Home Equity Access Scheme (spec 21b, Commit 5) — a government loan
// against Australian real estate, drawn as a fortnightly income
// stream, with interest capitalising onto the loan balance (never paid
// in cash — recovered from the estate). Two figures here are firmly
// sourced and cross-checked two ways (Services Australia's own pages,
// confirmed via two independent published summaries): the 3.95% pa
// interest rate (compounds fortnightly) and the 150%-of-maximum-
// pension-rate fortnightly drawdown cap.
//
// The age-component table (used only for the TOTAL loan cap) is NOT
// fully reproduced here. Direct access to Services Australia's own
// published table was unavailable in this environment (network egress
// to servicesaustralia.gov.au and clik.dva.gov.au is blocked); what
// follows is a SPARSE set of publicly-quoted anchor points — age 55
// (or younger) $1,710; 65 $2,530; 66 $2,630; 69 $2,960; 70 $3,080; 84
// $5,330; 85 $5,550; 90 (or older) $6,750 — each per $10,000 of
// security value, cross-checked against two independent sources —
// PIECEWISE-LINEARLY INTERPOLATED between them. The real table is
// almost certainly a finer-grained, year-by-year legislated schedule
// that doesn't move in a straight line between these anchors (the
// observed increment accelerates with age: roughly 1%/yr in the 60s,
// ~1.6%/yr through the 70s, ~2.2-2.4%/yr near 85-90) — this is a
// DISCLOSED APPROXIMATION of that schedule, not a verified reproduction
// of it, flagged in the Parameters modal. Ages below 55 or at/above 90
// are held flat at the nearest anchor (the real table does the same at
// its own ends — "55 or younger", "90 or older").
export const HEAS_BASE = Object.freeze({
  asAt: "2026-03-20",
  source:
    "Services Australia, Home Equity Access Scheme (interest rate, drawdown cap — confirmed via two independent published summaries). " +
    "Age-component table: SPARSE anchor points only (see module header) — full table unavailable, network egress to the primary source blocked in this environment.",
  interestRateAnnual: 0.0395, // 3.95% pa, compounds FORTNIGHTLY on the loan balance
  fortnightsPerYear: 26,
  drawdownCapPctOfMaxPension: 1.5, // "up to 150% of the maximum pension rate" per fortnight
  ageOfEligibility: 67, // real rule: the client OR partner must have reached this age
  // Age component per $10,000 of security value, sparse anchors (see
  // header) — sorted ascending by age.
  ageComponentAnchors: [
    { age: 55, perTenK: 1710 },
    { age: 65, perTenK: 2530 },
    { age: 66, perTenK: 2630 },
    { age: 69, perTenK: 2960 },
    { age: 70, perTenK: 3080 },
    { age: 84, perTenK: 5330 },
    { age: 85, perTenK: 5550 },
    { age: 90, perTenK: 6750 },
  ],
});

// The loan's effective ANNUAL rate from fortnightly compounding —
// (1 + r/26)^26 − 1 — a fixed NOMINAL figure (a legislated rate, not
// indexed to CPI/AWOTE the way age pension thresholds are); deflated to
// real terms by the caller the same way every other nominal rate in
// this engine is (Fisher, per CLAUDE.md's own Returns convention).
export function heasEffectiveAnnualRate(base = HEAS_BASE) {
  return Math.pow(1 + base.interestRateAnnual / base.fortnightsPerYear, base.fortnightsPerYear) - 1;
}

// Age-component dollar amount per $10,000 of security value, at `age` —
// piecewise-linear interpolation between the sparse anchors above, flat
// beyond either end (see module header for the disclosed-approximation
// caveat).
export function heasAgeComponentPerTenK(age, base = HEAS_BASE) {
  const anchors = base.ageComponentAnchors;
  if (age <= anchors[0].age) return anchors[0].perTenK;
  if (age >= anchors[anchors.length - 1].age) return anchors[anchors.length - 1].perTenK;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    if (age >= a.age && age <= b.age) {
      const t = (age - a.age) / (b.age - a.age);
      return a.perTenK + t * (b.perTenK - a.perTenK);
    }
  }
  return anchors[anchors.length - 1].perTenK; // unreachable, defensive
}

// Maximum Loan Amount: security value rounded DOWN to the nearest
// $10,000, divided by 10,000, times the age component — the real
// scheme's own published formula.
export function heasMaxLoanAmount(securityValue, age, base = HEAS_BASE) {
  const tenKs = Math.floor(Math.max(0, securityValue) / 10000);
  return tenKs * heasAgeComponentPerTenK(age, base);
}
