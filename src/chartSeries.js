// Single-question chart series (docs/specs/17-navigation-and-charts.md,
// Commit 4) — pure, no DOM/Plotly, same pattern as cashflowCategories.js/
// outputSeries.js: each function reads only existing yearly-ledger
// fields (no new engine work — this spec is presentation-only) and is
// unit-tested to reconcile against the ledger rows it claims to
// represent, per year, not just in total.

// Expense funding — "the affordability picture in one image": every
// year's total funding need (income the household would have needed
// to cover everything, derived as income − surplusOrDeficit) split
// into what actually came from income, what was funded by selling
// assets, and what went unfunded.
//
// Reconciling identity (exact, not approximate): by construction of
// the engine's own deficit-funding cascade (drain WCA/assets in
// fundingOrder, remainder unfunded), deficitFundedFromAssets +
// unfundedCashflow together equal exactly −surplusOrDeficit whenever
// surplusOrDeficit is negative, and are both zero otherwise. So:
//   metFromIncome = income − surplusOrDeficit − (fundedFromAssets + unfunded)
// always reduces to a clean value: the full need when there was a
// surplus (nothing to fund from elsewhere), or exactly `income` when
// there was a deficit (every dollar of income went to the need, with
// the shortfall made up by assets/unfunded) — verified directly in
// chartSeries.test.js rather than just asserted here.
export function expenseFundingSeries(yearly) {
  return yearly.map((row) => {
    const fundedFromAssets = row.deficitFundedFromAssets ?? 0;
    const unfunded = row.unfundedCashflow ?? 0;
    const need = (row.income ?? 0) - (row.surplusOrDeficit ?? 0);
    const metFromIncome = need - fundedFromAssets - unfunded;
    return { metFromIncome, fundedFromAssets, unfunded };
  });
}

// Tax by type — income tax, CGT, contributions tax, Division 293/296,
// HELP, and the Medicare Levy Surcharge, each read straight from its
// own already-reported ledger field (row.taxDetail's per-person
// figures summed to household, or row.superDetail for contributions
// tax) — no re-derivation, so each series is exactly its source by
// construction. Unlike the other five, contributions tax is NOT part
// of row.tax (it's a separate leak, per conservationCheck.js's own
// header) — the six series here do not sum to one grand ledger total,
// each reconciles individually against its own named source instead.
export function taxByTypeSeries(yearly) {
  return yearly.map((row) => {
    const td = row.taxDetail ?? {};
    const client = td.client ?? {};
    const partner = td.partner ?? {};
    const incomeTax = (client.incomeTax ?? 0) + (partner.incomeTax ?? 0);
    const cgt = td.cgt ?? 0;
    const div293 = td.div293 ?? 0;
    const div296 = td.div296 ?? 0;
    const help = td.helpRepayment ?? 0;
    const mls = td.medicareLevySurcharge ?? 0;
    const contributionsTax = Object.values(row.superDetail ?? {}).reduce((s, d) => s + (d.contributionsTax ?? 0), 0);
    return { incomeTax, cgt, contributionsTax, div293, div296, help, mls };
  });
}

// Debt vs assets — the crossover-year picture. Total assets includes
// working cash (the same "Total assets" figure Key Figures' Consolidated
// mode shows); total debt is row.liabilitiesClosing, unchanged.
export function debtVsAssetsSeries(yearly) {
  return yearly.map((row) => ({
    assets: row.closingBalance + row.propertyClosing + row.superClosing + row.wcaClosing,
    debt: row.liabilitiesClosing,
  }));
}

// The first plan-year index (0-based) at which assets - debt >= 0, or
// null if the projection never crosses (already above zero throughout,
// or never reaches it) — "the crossover year annotated" the spec asks
// for. Returns null rather than 0 when net worth is non-negative from
// year 0 (nothing to annotate — there's no crossing, just an existing
// surplus).
export function debtAssetsCrossoverYear(yearly) {
  const series = debtVsAssetsSeries(yearly);
  if (series.length === 0) return null;
  if (series[0].assets - series[0].debt >= 0) return null; // already net-positive at the start — no crossing to mark
  for (let y = 1; y < series.length; y++) {
    if (series[y].assets - series[y].debt >= 0) return y;
  }
  return null;
}

// Super vs non-super — the salary-sacrifice question made visual.
// Non-super is everything else the household holds outside a fund:
// financial/lifestyle assets, property, and working cash. Reconciles
// with debtVsAssetsSeries's own "assets" figure by construction
// (super + nonSuper === that same total assets figure).
export function superVsNonSuperSeries(yearly) {
  return yearly.map((row) => ({
    superBalance: row.superClosing,
    nonSuper: row.closingBalance + row.propertyClosing + row.wcaClosing,
  }));
}
