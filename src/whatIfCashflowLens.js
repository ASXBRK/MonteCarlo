// What if: cashflow as the primary lens for cashflow shocks — pure, no
// DOM/Plotly. Three of the four shocks (rate, income gap, expense)
// perturb CASHFLOW, not asset values, so their headline questions are
// answered from the surplus line and the working cash balance, not net
// worth decades away. Net assets is the consequence; cashflow is the
// experience — a crash view keeps net assets primary, since a crash
// genuinely IS an asset-value event.
//
// Every function here reads straight off a runShock()-shaped
// { base, shocked, deltas }, or the raw projectPlan() outputs
// themselves — never re-derives a figure the engine already produces.

// bufferBreach(out) — the first plan year the working cash account
// needed help to stay at its own floor: money drawn from OTHER assets
// to top it back up (deficitFundedFromAssets), or a shortfall it
// couldn't even fund that way (unfundedCashflow). Deliberately NOT "did
// wcaClosing dip below minimumBalance" — this engine floors the WCA at
// its own minimum by construction (deterministic.js's own "balances
// never go negative" convention; an unfundable month sets wcaBal back
// UP to minimumBalance rather than letting it go negative), so that
// comparison would never fire. Needing external funding at all — even
// though the reported balance never shows it — IS the buffer failing.
export function bufferBreach(out) {
  const year = out.yearly.findIndex((row) => row.deficitFundedFromAssets > 0.5 || row.unfundedCashflow > 0.5);
  return { breached: year !== -1, year: year === -1 ? null : year };
}

// The permanent cost at projection end is the same shape for every
// cashflow shock: the shocked run's own compounding never catches back
// up to the base run's, so the gap at the end is always larger than
// the shock's own face value — the answer clients don't expect.
function permanentCost(deltas) {
  return deltas.headline.shocked.endNetAssets - deltas.headline.base.endNetAssets;
}

// incomeGapHeadline — total cash drawn from assets to bridge the gap
// (the INCREMENTAL draw the shock itself causes, not the shocked run's
// whole deficitFunded total, most of which has nothing to do with the
// gap); whether the working-cash buffer held, and in which year it
// first didn't; the permanent cost at the end of the projection.
export function incomeGapHeadline({ shocked, deltas }) {
  const totalCashDrawn = Math.max(
    0, deltas.byYear.reduce((s, y) => s + (y.deficitFunded.shocked - y.deficitFunded.base), 0)
  );
  const breach = bufferBreach(shocked);
  return { totalCashDrawn, bufferHeld: !breach.breached, breachYear: breach.year, permanentCost: permanentCost(deltas) };
}

// expenseShockHeadline — the first year surplus turns negative under
// the shock (null if it never does); total additional spending over
// the whole projection (the shocked run's own row.expenses total,
// which already includes every indexed row's full trajectory, minus
// the base's); the permanent cost.
export function expenseShockHeadline({ base, shocked, deltas }) {
  const years = Math.min(base.yearly.length, shocked.yearly.length);
  let firstNegativeSurplusYear = null;
  let totalAdditionalSpending = 0;
  for (let y = 0; y < years; y++) {
    if (firstNegativeSurplusYear == null && shocked.yearly[y].surplusOrDeficit < 0) firstNegativeSurplusYear = y;
    totalAdditionalSpending += shocked.yearly[y].expenses - base.yearly[y].expenses;
  }
  return { firstNegativeSurplusYear, totalAdditionalSpending, permanentCost: permanentCost(deltas) };
}

// Household-wide loan service (interest + principal, every liability
// summed) for one plan year — "annual repayments" at the portfolio
// level, the same interest/principal fields cashflowStatement.js's own
// loanInterest/loanPrincipal categories read.
function householdLoanService(out, y) {
  return Object.values(out.yearly[y]?.liabilities ?? {}).reduce((s, l) => s + l.interest + l.principal, 0);
}
function householdLoanInterest(out, y) {
  return Object.values(out.yearly[y]?.liabilities ?? {}).reduce((s, l) => s + l.interest, 0);
}

// rateShockHeadline — the first plan year household repayments
// actually differ from base (immediately for a variable loan; from
// its own rollover year for a fixed one — this is deliberately
// discovered from the ENGINE'S OWN per-year figures rather than
// re-deriving loan-type timing, so it's correct for any mix of
// variable/fixed loans without special-casing either), the change in
// annual repayments that year, total additional interest over the
// whole projection, and whether the shock introduces unfunded cashflow.
export function rateShockHeadline({ base, shocked, deltas }) {
  const years = Math.min(base.yearly.length, shocked.yearly.length);
  let firstAffectedYear = null;
  let changeInRepayments = 0;
  let totalAdditionalInterest = 0;
  for (let y = 0; y < years; y++) {
    totalAdditionalInterest += householdLoanInterest(shocked, y) - householdLoanInterest(base, y);
    if (firstAffectedYear == null) {
      const delta = householdLoanService(shocked, y) - householdLoanService(base, y);
      if (Math.abs(delta) > 0.5) { firstAffectedYear = y; changeInRepayments = delta; }
    }
  }
  const introducesUnfunded = deltas.headline.shocked.totalUnfunded > deltas.headline.base.totalUnfunded;
  return { firstAffectedYear, changeInRepayments, totalAdditionalInterest, introducesUnfunded };
}
