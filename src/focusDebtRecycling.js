// Focus: Debt recycling (spec 24, Commit 3) — pure, no DOM/Plotly. The
// recycled plan against the SAME plan without recycling, both run
// through projectPlan() on clones — the same "always use the real
// engine" pattern focusDebtPayoff.js/focusDeposit.js already establish,
// not a hand-derived approximation of what recycling would do.

import { projectPlan } from "./deterministic.js";
import { clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";

// Loans this view can answer for — a recycling plan must actually be
// enabled (nothing to compare otherwise; "without recycling" and "with
// recycling" would be the identical plan).
export function eligibleDebtRecyclingLoans(state) {
  return (state.liabilities ?? []).filter((l) => l.recycling?.enabled === true);
}

// Deductible proportion this year, from the SAME investmentBalance/
// privateBalance pair the Liabilities table's own row reads (spec 24,
// Commit 3) — reported for every liability regardless of whether it
// uses dynamic tracking, so this works identically for the "before"
// arm (recycling disabled — investmentBalance/privateBalance still
// reflect the static opening split) and the "after" one.
function deductibleFractionOf(row) {
  const total = (row?.investmentBalance ?? 0) + (row?.privateBalance ?? 0);
  return total > 0 ? row.investmentBalance / total : 0;
}

// buildDebtRecyclingFocus({ out, state, liabilityId }) → the view's
// data, or null if the loan doesn't exist or isn't actually recycling.
export function buildDebtRecyclingFocus({ out, state, liabilityId }) {
  const liability = (state.liabilities ?? []).find((l) => l.id === liabilityId);
  if (!liability?.recycling?.enabled) return null;

  // The counterfactual: a SEPARATE real projectPlan() run on a clone
  // with THIS loan's recycling switched off — every other input
  // (income, other liabilities, assets) identical, so the comparison
  // isolates recycling's own effect, the Focus governing principle.
  const clone = structuredClone(state);
  const cLiability = clone.liabilities.find((l) => l.id === liabilityId);
  cLiability.recycling = { ...cLiability.recycling, enabled: false };
  const withoutOut = projectPlan(clampAllToPlan(clone, PROFILES));

  const destinationAssetId = liability.recycling.destinationAssetId;
  const years = out.yearly.length;
  const series = [];
  let breakEvenYear = null;
  for (let y = 0; y < years; y++) {
    const withRow = out.yearly[y];
    const withoutRow = withoutOut.yearly[y];
    const withLiab = withRow.liabilities[liabilityId];
    const withoutLiab = withoutRow.liabilities[liabilityId];
    const withDeductibleInterest = (withLiab?.interest ?? 0) * deductibleFractionOf(withLiab);
    const withoutDeductibleInterest = (withoutLiab?.interest ?? 0) * deductibleFractionOf(withoutLiab);
    const taxSaved = (withoutRow.taxDetail?.incomeTax ?? 0) - (withRow.taxDetail?.incomeTax ?? 0);
    const investmentBalance = destinationAssetId ? (withRow.perAssetDetail?.[destinationAssetId]?.closing ?? 0) : 0;
    const investmentBalanceWithout = destinationAssetId ? (withoutRow.perAssetDetail?.[destinationAssetId]?.closing ?? 0) : 0;
    series.push({
      year: y, age: out.schedule.clientAges[y], fyLabel: out.schedule.fyLabels[y],
      deductibleInterest: withDeductibleInterest,
      deductibleInterestWithout: withoutDeductibleInterest,
      taxSaved,
      totalDebt: withLiab?.closing ?? 0,
      totalDebtWithout: withoutLiab?.closing ?? 0,
      investmentBalance,
      investmentBalanceWithout,
    });
    // Break-even: the first year the recycled plan's own net worth
    // catches up to (or exceeds) the without-recycling plan's — the
    // engine's own netAssets already nets out every effect (the extra
    // deductible interest's tax saving, the investment's own return,
    // and the cost of carrying a larger ongoing balance), so this is
    // the honest "when does it start paying off" figure, not a
    // hand-derived approximation of one part of it.
    if (breakEvenYear == null && withRow.netAssets >= withoutRow.netAssets) breakEvenYear = y;
  }

  return {
    liability: { id: liability.id, name: liability.name },
    destinationAssetId,
    series,
    breakEven: breakEvenYear == null ? null : {
      year: breakEvenYear, age: out.schedule.clientAges[breakEvenYear], fyLabel: out.schedule.fyLabels[breakEvenYear],
    },
  };
}
