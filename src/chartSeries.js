// Single-question chart series (docs/specs/17-navigation-and-charts.md,
// Commit 4) — pure, no DOM/Plotly, same pattern as cashflowCategories.js/
// outputSeries.js: each function reads only existing yearly-ledger
// fields (no new engine work — this spec is presentation-only) and is
// unit-tested to reconcile against the ledger rows it claims to
// represent, per year, not just in total.

// Expense funding — "the affordability picture in one image": every
// year's total funding need (income the household would have needed
// to cover everything, derived as income − surplusOrDeficit) split
// into what actually came from income, what was funded by pension
// payments/released-super withdrawals, what was funded by selling
// assets, and what went unfunded.
//
// fundedFromPension (docs/specs/37-review-remediation.md, Commit 4;
// adversarial review finding 2.5) — pension payments and released-
// super deficit draws are credited straight to the working cash
// account (deterministic.js), never touching income or
// surplusOrDeficit, so they used to break the identity below silently:
// whatever they funded still showed up folded into "met from income"
// (a retiree probe: income $24,429, pension payments $30,000, but the
// chart read "Met from income" $44,958 of a $44,958 need). Capped at
// whatever remains of the need after assets/unfunded are accounted for
// — a pension's own statutory-minimum payment can exceed what the
// household actually needed that year (a surplus year), and the
// excess isn't "funding the need", it's accumulating in the working
// cash account instead, the same way surplus income already does off
// this chart.
//
// Reconciling identity (exact, not approximate): by construction of
// the engine's own deficit-funding cascade (drain WCA/assets in
// fundingOrder, remainder unfunded), deficitFundedFromAssets +
// unfundedCashflow together equal exactly −surplusOrDeficit whenever
// surplusOrDeficit is negative, and are both zero otherwise, so
// metFromIncome + fundedFromPension always exactly accounts for
// whatever `fundedFromAssets + unfunded` didn't — verified directly in
// chartSeries.test.js rather than just asserted here.
export function expenseFundingSeries(yearly) {
  return yearly.map((row) => {
    const fundedFromAssets = row.deficitFundedFromAssets ?? 0;
    const unfunded = row.unfundedCashflow ?? 0;
    const need = (row.income ?? 0) - (row.surplusOrDeficit ?? 0);
    const pensionAndSuper = Object.values(row.pensionDetail ?? {}).reduce((s, d) => s + (d.payments ?? 0), 0)
      + Object.values(row.superDetail ?? {}).reduce((s, d) => s + (d.withdrawals ?? 0), 0);
    const remaining = need - fundedFromAssets - unfunded;
    const fundedFromPension = Math.max(0, Math.min(remaining, pensionAndSuper));
    const metFromIncome = remaining - fundedFromPension;
    return { metFromIncome, fundedFromPension, fundedFromAssets, unfunded };
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

// Debt vs assets — the crossover-year picture. row.totalAssets is the
// engine's own published aggregate (docs/specs/37-review-remediation.md,
// Commit 4) — every balance type (financial/lifestyle assets, property,
// super, pension, bonds, working cash), the same figure Key Figures'
// Consolidated "Total assets" reads; total debt is row.liabilitiesClosing,
// unchanged.
export function debtVsAssetsSeries(yearly) {
  return yearly.map((row) => ({
    assets: row.totalAssets,
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
// "Super" includes pension-phase balances (docs/specs/37-review-
// remediation.md, Commit 4; adversarial review finding 1.11) — a
// pension is superannuation money in retirement phase, not a
// different asset class, and was previously omitted entirely (a
// retiree probe: "Super" read $1,720 while $592,722 sat in an ABP).
// Non-super is everything else the household holds outside a fund:
// financial/lifestyle assets, property, bonds, and working cash.
// nonSuper is derived from row.totalAssets minus super so the two
// always reconcile with debtVsAssetsSeries's own "assets" figure by
// construction (super + nonSuper === that same total assets figure),
// rather than re-listing non-super's own components a second time.
export function superVsNonSuperSeries(yearly) {
  return yearly.map((row) => {
    const superBalance = row.superClosing + row.pensionClosing;
    return { superBalance, nonSuper: row.totalAssets - superBalance };
  });
}
