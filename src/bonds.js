// Investment and education bonds (spec 25) — pure, no DOM/Plotly, no
// engine state. deterministic.js wires these into the monthly loop;
// Tax/annual.js's assessPerson consumes bondWithdrawalTax's output the
// same way it already consumes FHSSS's own assessable-release-plus-
// flat-offset shape.
//
// Tax-paid structure (the whole point of the vehicle): earnings are
// taxed INSIDE the bond, never in the investor's own return — see
// deterministic.js's bond loop for why they never touch acc[p]
// (ordinary/franked/unfranked), which is what keeps them out of
// assessable income, HELP repayment income, Division 293 income and
// the Medicare Levy Surcharge base structurally, by construction,
// rather than via an exclusion list that has to be kept in sync.

// The bond tax rate (a friendly-society/life-company rate, historically
// aligned to the company tax rate). Firm reference (xtools-calm-
// reference.md §9.10) notes advisers see it as fixed at 30% even though
// franking can bring the EFFECTIVE rate down — modelled below.
export const BOND_TAX_RATE = 0.30;

// Effective internal tax rate: the standard rate less the benefit of
// the franked proportion of the bond's own income. A bond's franking
// credits are claimed by the bond issuer against its own tax; on full
// imputation (credit rate == the bond's own 30% rate) the franked share
// of income bears no further internal tax at all. Deliberately does
// NOT model a fund-level CGT discount on capital growth — the spec
// asks only for "30% less the franked proportion's benefit" as a
// single blended rate; a disclosed simplification, not an oversight.
export function bondEffectiveTaxRate(frankingPct) {
  return BOND_TAX_RATE * (1 - Math.max(0, Math.min(100, frankingPct ?? 0)) / 100);
}

// The ten-year rule's clock, in absolute plan-months (may be negative
// for a bond already held before the projection starts — see
// bondStartMonthIndex below). A bond matures, and every withdrawal
// becomes entirely tax-free, at startMonth + 120 (ten years, monthly
// steps throughout this engine).
export const BOND_MATURITY_MONTHS = 120;

export function bondMaturityMonth(startMonth) {
  return startMonth + BOND_MATURITY_MONTHS;
}

export function bondHasMatured(startMonth, atMonth) {
  return atMonth >= bondMaturityMonth(startMonth);
}

// Converts a bond's calendar startDate (an ISO "YYYY-MM-DD" string, the
// SAME representation Property.acquisitionDate already uses for a
// possibly-pre-projection date) into an absolute plan-month index —
// negative when the bond was established before the plan itself
// starts, which is the normal case for an already-existing bond and
// arithmetically just fine (its maturity month is correspondingly
// negative too, i.e. already matured before month 0).
export function bondStartMonthIndex(startDateIso, planStart) {
  const d = new Date(`${startDateIso}T00:00:00Z`);
  const monthsFromEpoch = d.getUTCFullYear() * 12 + d.getUTCMonth();
  const startMonthsFromEpoch = planStart.year * 12 + (planStart.month - 1);
  return monthsFromEpoch - startMonthsFromEpoch;
}

// The 125% rule (the spec's own "single most important warning"): a
// contribution up to 125% of the PRIOR FY's total contribution keeps
// the ten-year clock running from its existing start date; anything
// above resets the clock to the start of the FY in which the breach
// occurs, for the WHOLE bond. A nil-contribution FY sets next FY's
// 125% base to nil — modelled with no special case, since cap =
// priorFyContribution * 1.25 is already 0 when priorFyContribution is
// 0, so any positive contribution the following year breaches by
// construction.
export function bondContributionCapCheck(priorFyContribution, thisFyContribution) {
  const cap = Math.max(0, priorFyContribution) * 1.25;
  // Tolerance against float noise from monthly accumulation, not a
  // policy allowance.
  const breach = thisFyContribution > cap + 1e-6;
  return { cap, breach };
}

// Withdrawal tax treatment. Splits the withdrawal proportionally
// between original investment and accumulated earnings (the spec's own
// words) — the same "proportional to the whole pool" idea
// costBasePool.js uses for an ordinary CGT asset's partial disposal,
// but deliberately simpler: bonds are NOT CGT assets (no pool, no
// discount, no FIFO parcels), just a running notional cost base.
//
// A matured bond's earnings are entirely tax-free on withdrawal — the
// ten-year rule's whole point. An unmatured bond's earnings component
// is assessable at the investor's marginal rate with a flat 30% offset
// (see assessPerson's own bondAssessableWithdrawal/bondOffsetRate).
export function bondWithdrawalTax({ withdrawalAmount, balance, costBase, matured }) {
  if (!(withdrawalAmount > 0) || !(balance > 0)) {
    return { earningsWithdrawn: 0, capitalWithdrawn: Math.max(0, withdrawalAmount || 0), assessableEarnings: 0 };
  }
  const earningsFraction = Math.max(0, Math.min(1, 1 - Math.max(0, costBase) / balance));
  const earningsWithdrawn = withdrawalAmount * earningsFraction;
  const capitalWithdrawn = withdrawalAmount - earningsWithdrawn;
  return {
    earningsWithdrawn,
    capitalWithdrawn,
    assessableEarnings: matured ? 0 : earningsWithdrawn,
  };
}

// The earnings/capital split alone (bondWithdrawalTax's own first two
// fields), reused by the education benefit calc below — pulled out so
// the split logic exists in exactly one place.
export function bondWithdrawalSplit({ withdrawalAmount, balance, costBase }) {
  if (!(withdrawalAmount > 0) || !(balance > 0)) {
    return { earningsWithdrawn: 0, capitalWithdrawn: Math.max(0, withdrawalAmount || 0) };
  }
  const earningsFraction = Math.max(0, Math.min(1, 1 - Math.max(0, costBase) / balance));
  const earningsWithdrawn = withdrawalAmount * earningsFraction;
  return { earningsWithdrawn, capitalWithdrawn: withdrawalAmount - earningsWithdrawn };
}

// The education bond benefit (spec 25, Commit 3) — VERIFICATION NOTE:
// direct PDS/ATO fetches were blocked by this environment's network
// policy; the mechanic below is corroborated instead from two
// independent web searches that both surfaced the SAME specific,
// numeric mechanic quoted from a named provider's own education-bond
// materials (Australian Unity's Lifeplan Education Bond): a "scholarship
// plan" structure lets the provider recover the 30% tax it already paid
// on the earnings component of a withdrawal used for eligible education
// expenses, and that recovered amount is added to the withdrawal as the
// "education benefit" — described consistently as "$30 for every $70
// withdrawn from the earnings". This is claimed to apply on an
// education-purpose withdrawal REGARDLESS of the ten-year mark (it
// recovers tax the bond already paid internally every year, a
// mechanism distinct from the personal ten-year assessability rule —
// consistent with sources describing education withdrawals as not
// needing to be included in the investor's own tax return at all).
// NOT independently modelled here (no source found, so not asserted):
// any annual or lifetime cap on the benefit, or a graduated withdrawal
// schedule. Flagged in the UI as an unmodelled limit, not silently
// assumed uncapped.
export const EDUCATION_BENEFIT_RATIO = 30 / 70;

export function bondEducationBenefit(earningsWithdrawn) {
  return Math.max(0, earningsWithdrawn) * EDUCATION_BENEFIT_RATIO;
}
