// Cashflow category-sum builders (Cashflow view's table + bars chart) —
// pure, no DOM/Plotly, extracted from main.js so the reconciliation
// between "sum of every category" and "Total income/Total expenses"
// (previously only checked in a throwaway Playwright harness) can be a
// committed vitest test instead — see outputSeries.js for the same
// pattern applied to the composite chart. Every function takes plain
// data (a single yearly ledger row plus the state slices it needs);
// main.js supplies the data and owns all DOM/chart rendering.

// Total salary-sacrifice cash for one plan year, across every super
// account — the amount by which the client's ACTUAL pay was reduced at
// source (schedule.js's reduceHouseholdCash). It must be subtracted from
// the Employment income category (whose row totals are captured BEFORE
// that reduction — see schedule.js's rowTotals comment) so "Total
// income" continues to reconcile with the engine's own row.income,
// which IS net of it. This is the read-side half of the engine-
// correctness fix: schedule.js/deterministic.js fixed the money
// creation; this fixes the two display paths that summed the same
// figures a different way.
export function salarySacrificeCash(row, superAccounts) {
  return (superAccounts ?? []).reduce((s, sa) => {
    const d = row.superDetail[sa.id];
    return s + (d ? d.salarySacrifice : 0);
  }, 0);
}

// Super contributions the client actually pays for out of household
// cash — personal deductible/non-deductible, spouse (toConcessionalCap
// fills included, since Tier 1.2 Commit 4 folds them into these same
// per-type fields). Salary sacrifice and SG are BOTH excluded here:
// sacrifice already reduced household income at source (it must not
// also appear as an expense, or it is double-counted — the original
// money-creation bug's exact mirror image), and SG is employer money
// that never reaches the household.
export function personalSuperContributionsCash(row, superAccounts) {
  return (superAccounts ?? []).reduce((s, sa) => {
    const d = row.superDetail[sa.id];
    return s + (d ? d.personalDeductible + d.nonConcessional : 0);
  }, 0);
}

// Income category sums for one plan year — built from exactly the
// fields the Cashflow table's income rows read, so summing every
// category (INCLUDING agePension below) reproduces the table's Total
// income (once the table's own "Less: salary sacrifice" row is
// included). One-off inflows fold into "other" (income has no other
// natural home for them).
//
// Reconciliation, precisely stated (docs/specs/37-review-remediation.md,
// Commit 4 — "the reconciliation claim made true"): the categories here
// sum to row.income PLUS wcaInterest, not row.income alone.
// deterministic.js credits WCA interest straight to row.surplusOrDeficit
// (and wcaBal) as its own term — deliberately, per that file's own
// comment ("real household income... needs this added ON TOP of it"),
// and conservationCheck.js's own ΔN formula treats it the same way, as
// a term separate from row.income — so row.income itself never includes
// it. This function still surfaces wcaInterest as its own category
// (real, taxed, genuinely cash — the Cashflow view has always shown
// it), so a caller summing every field below must add row.income's own
// figure to whatever this function reports for wcaInterest, not compare
// this sum against row.income directly (found via
// displayReconciliation.test.js's own multi-year reconciliation, once a
// scenario ran long enough for the working cash account to carry a
// nonzero balance).
//
// agePension (docs/specs/37-review-remediation.md, Commit 4; adversarial
// review finding 1.10) — the age pension IS in row.income (deterministic
// .js folds it into `inc` the same way salary/rent/distributions are)
// but was in no category here, so every consumer of this function's sum
// (Key figures "Total income", the Cashflow bars chart) silently
// dropped it while claiming to reconcile against row.income. It is its
// own category, not folded into "other" — it is non-assessable (no
// SAPTO modelled) but genuinely cash, the reverse of every OTHER
// category here, which are all assessable.
//
// incomeRows: state.cashflows.income (each needs .id, .incomeType)
// rowTotalsIncome: projection.schedule.rowTotals.income (per-row Float64Arrays, GROSS of sacrifice)
// properties: state.properties
// oneOffsByAssetYear: projection.schedule.oneOffsByAssetYear
// financialAssetIds: ids of assets that aren't class "lifestyle"
// superAccounts: state.plan.superAccounts
// y: plan-year index
export function incomeCategorySums(row, incomeRows, rowTotalsIncome, properties, oneOffsByAssetYear, financialAssetIds, superAccounts, y) {
  const byType = (type) => incomeRows
    .filter((r) => r.incomeType === type)
    .reduce((s, r) => s + (rowTotalsIncome[r.id]?.[y] ?? 0), 0);
  const investmentProps = (properties ?? []).filter((p) => p.propertyType === "investment");
  const employment = byType("employment") - salarySacrificeCash(row, superAccounts);
  const rental = byType("rental") + investmentProps.reduce((s, p) => s + (row.properties?.[p.id]?.rent ?? 0), 0);
  const investment = row.cashDistributions;
  const wcaInterest = row.wcaDetail.interest;
  const oneOffIn = financialAssetIds.reduce((s, id) => s + Math.max(0, oneOffsByAssetYear[id]?.[y] ?? 0), 0);
  const other = byType("otherTaxable") + byType("nonTaxable") + oneOffIn;
  const agePension = row.agePensionDetail?.entitlement ?? 0;
  return { employment, rental, investment, wcaInterest, other, agePension };
}

// Expense category sums for one plan year — mirrors incomeCategorySums.
// One-off outflows and a planned property's settlement fold into
// "investment/property expenses" (the closest fit) — both are
// asset-level events, not household cashflow, same disclosed caveat as
// the table's.
//
// expenseRows: state.cashflows.expenses (each needs .id)
// rowTotalsExpenses: projection.schedule.rowTotals.expenses
// educationBlocks: flatEducationBlocks(state.plan) (Commit 3) — every
// child's education block, flattened; rowTotalsEducation:
// projection.schedule.rowTotals.education, keyed by block id. Its own
// category (not folded into "living") — one of the largest cashflow
// items this client base faces, per the spec, so it gets its own band
// rather than being buried in living expenses.
export function expenseCategorySums(
  row, expenseRows, rowTotalsExpenses, properties, oneOffsByAssetYear, financialAssetIds, superAccounts, y,
  educationBlocks = [], rowTotalsEducation = {}
) {
  const living = expenseRows.reduce((s, r) => s + (rowTotalsExpenses[r.id]?.[y] ?? 0), 0);
  const investmentProps = (properties ?? []).filter((p) => p.propertyType === "investment");
  const propExpenses = investmentProps.reduce((s, p) => s + (row.properties?.[p.id]?.expenses ?? 0), 0);
  const oneOffOut = financialAssetIds.reduce((s, id) => s + Math.max(0, -(oneOffsByAssetYear[id]?.[y] ?? 0)), 0);
  const settlement = (properties ?? []).filter((p) => p.status === "planned")
    .reduce((s, p) => s + (row.properties?.[p.id]?.settlement ?? 0), 0);
  const liabIds = Object.keys(row.liabilities ?? {});
  const loanInterest = liabIds.reduce((s, lid) => s + row.liabilities[lid].interest, 0);
  const loanPrincipal = liabIds.reduce((s, lid) => s + row.liabilities[lid].principal, 0);
  const education = educationBlocks.reduce((s, b) => s + (rowTotalsEducation[b.id]?.[y] ?? 0), 0);
  return {
    living,
    investmentExpenses: propExpenses + oneOffOut + settlement,
    loanInterest, loanPrincipal,
    education,
    tax: row.tax,
    superContributions: personalSuperContributionsCash(row, superAccounts),
  };
}
