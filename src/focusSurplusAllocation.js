// Focus: Surplus allocation (docs/specs/16-surplus-allocation.md, Commit
// 3/4) — pure, no DOM/Plotly. "Where did the surplus actually go, year
// by year" is read straight off a real projectPlan() output's own
// per-target reporting fields (never re-derived from the allocation
// rules themselves — the same "always use the real engine" convention
// focusDebtPayoff.js/focusDeposit.js already establish); the
// single-destination alternative and the non-deductible-first benefit
// are each a SEPARATE real projectPlan() run on a clone, exactly like
// focusDebtPayoff.js's own counterfactual balance chart.

import { projectPlan } from "./deterministic.js";
import { clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";
import { deductibleFraction } from "./liabilities.js";

// One row per destination that received a nonzero amount this FY,
// reading the SAME reporting fields the settings UI and the Cashflow
// table's Funding group read — the single definition of "where did the
// surplus go" this app uses everywhere it's asked, so the three never
// disagree.
export function surplusDestinationBreakdown(row, state) {
  if (!row) return [];
  const out = [];
  for (const a of state.assets ?? []) {
    const amt = row.perAssetDetail?.[a.id]?.surplusInvested ?? 0;
    if (amt > 0.005) out.push({ label: a.name, amount: amt });
  }
  for (const l of state.liabilities ?? []) {
    const amt = row.liabilities?.[l.id]?.surplusRepayment ?? 0;
    if (amt > 0.005) out.push({ label: l.name, amount: amt });
  }
  for (const sa of state.plan?.superAccounts ?? []) {
    const d = row.superDetail?.[sa.id];
    const amt = (d?.surplusSalarySacrifice ?? 0) + (d?.surplusPersonalDeductible ?? 0);
    if (amt > 0.005) out.push({ label: sa.name, amount: amt });
  }
  for (const g of state.goals ?? []) {
    const amt = row.goals?.[g.id]?.surplusContribution ?? 0;
    if (amt > 0.005) out.push({ label: g.label, amount: amt });
  }
  if (row.surplusSpent > 0.005) out.push({ label: "Expenditure", amount: row.surplusSpent });
  if (row.surplusAccumulated > 0.005) out.push({ label: "Cash", amount: row.surplusAccumulated });
  return out;
}

// Year-by-year breakdown for the Focus view's own table/chart — the
// total swept that FY plus its destinations, for every year the
// projection covers (including years where nothing was swept: total 0,
// breakdown []).
export function buildSurplusAllocationFocus({ out, state }) {
  const years = out.yearly.map((row, y) => {
    const breakdown = surplusDestinationBreakdown(row, state);
    return {
      y,
      fyLabel: out.schedule.fyLabels[y],
      total: breakdown.reduce((s, x) => s + x.amount, 0),
      breakdown,
    };
  });
  const totalSwept = years.reduce((s, x) => s + x.total, 0);
  return { years, totalSwept };
}

// A single-destination alternative: re-projects the SAME plan with
// every configured period replaced by one Start→End period sending
// 100% of surplus to ONE destination (no non-deductible-first step, no
// remainder split) — "should we put it all on the mortgage or split
// it?", the question spec 16's own Commit 3 names. Returns the full
// projectPlan() output so the caller can compare whatever figure it
// wants (closing net worth, a specific liability's payoff year, ...)
// against the actual configured run.
export function projectSingleDestinationAlternative(state, target) {
  const clone = structuredClone(state);
  clone.settings.surplus = {
    periods: [{
      id: "alt-single-destination",
      from: { kind: "anchor", anchorId: "start" },
      to: { kind: "anchor", anchorId: "end" },
      payNonDeductibleDebtFirst: false,
      debtOrder: "interestRate",
      allocations: [{ id: "alt-a", targetType: target.targetType, targetId: target.targetId, pct: 100 }],
      remainderTo: "cash",
    }],
  };
  return projectPlan(clampAllToPlan(clone, PROFILES));
}

// Non-deductible-first benefit (spec 16, Commit 4) — only meaningful
// when at least one configured period actually turns the rule on AND
// the client holds both a fully/partly deductible liability and a
// non-deductible one (the spec's own gating condition). The
// counterfactual is a SINGLE, projection-wide pro-rata split — each
// liability's opening-balance share at the START of the projection,
// held fixed — rather than a perfectly-dynamic year-by-year
// rebalancing (which the allocation engine has no mechanism for at
// all: percentages are a period-scoped constant everywhere else in
// this feature too). Disclosed via the returned `note`, not silently
// presented as more precise than it is.
export function nonDeductibleFirstBenefit(state, out) {
  const liabs = (state.liabilities ?? []).filter((l) => l.balance > 0);
  const anyRuleOn = (state.settings?.surplus?.periods ?? []).some((p) => p.payNonDeductibleDebtFirst);
  const hasDeductible = liabs.some((l) => deductibleFraction(l) > 0);
  const hasNonDeductible = liabs.some((l) => deductibleFraction(l) < 1);
  if (!anyRuleOn || !hasDeductible || !hasNonDeductible || liabs.length < 2) return null;

  const totalBalance = liabs.reduce((s, l) => s + l.balance, 0);
  if (totalBalance <= 0) return null;
  const clone = structuredClone(state);
  clone.settings.surplus = {
    periods: [{
      id: "alt-pro-rata",
      from: { kind: "anchor", anchorId: "start" },
      to: { kind: "anchor", anchorId: "end" },
      payNonDeductibleDebtFirst: false,
      debtOrder: "interestRate",
      allocations: liabs.map((l) => ({
        id: `alt-${l.id}`, targetType: "liability", targetId: l.id, pct: (l.balance / totalBalance) * 100,
      })),
      remainderTo: "cash",
    }],
  };
  const proRataOut = projectPlan(clampAllToPlan(clone, PROFILES));

  const totalInterest = (o) => o.yearly.reduce((s, row) =>
    s + Object.values(row.liabilities ?? {}).reduce((s2, d) => s2 + (d.interest ?? 0), 0), 0);
  const actualInterest = totalInterest(out);
  const proRataInterest = totalInterest(proRataOut);
  return {
    interestSaved: proRataInterest - actualInterest,
    note: "Pro-rata means each debt's share of the household's total balance at the START of the projection, held fixed — not a dynamic year-by-year rebalancing, which this tool's allocation model has no mechanism for anywhere.",
  };
}
