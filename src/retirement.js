// Retirement: Income Required (docs/specs/32-retirement-phase-one.md,
// Commit 1) — pure, no DOM/engine mutation.
//
// Income Required is a REFERENCE line, not a driver, in this commit:
// the projection keeps drawing per the existing pension/drawdown
// settings; this module only computes what the client said they need,
// in the same real-dollar/indexation vocabulary as every other
// cashflow row, for deterministic.js to attach to each yearly row
// (`row.incomeRequired`) without it ever feeding projection arithmetic.
// A toggle to actually DRIVE drawdown from it is Commit 4.
//
// Interpretation fixed by the spec: Income Required is AFTER-TAX
// income received by the household — compare it against
// `row.income - row.tax` (net income after tax), never against gross
// drawdown. This is stated on the input and in the Parameters modal
// (index.html's #retirement-assumptions section); this module has no
// part in enforcing that beyond keeping the figure itself pre-tax-free
// (a stated target, not a tax computation).

import { resolveRef } from "./keyDates.js";
import { realAmountAt } from "./schedule.js";
import { createIncomeRequired } from "./planState.js";

// ASFA sources (asfaComfortable/asfaModest) are added in Commit 2, once
// src/data/asfaStandards.js exists to resolve them against — see
// CLAUDE.md's Input integrity section: an option with nothing to
// resolve against must not be enterable yet, so the schema/UI restrict
// `source` to exactly these two until then.
export const INCOME_REQUIRED_SOURCES = ["currentExpenses", "custom"];

// Total household living-expense rows (state.cashflows.expenses only —
// never property costs, loan repayments, adviser fees, or tax) for
// plan year `y`, summed across its own months. Mirrors schedule.js's
// own "income[m], expenses[m], // household, real $" header comment —
// deliberately the pre-property/pre-tax figure, not deterministic.js's
// richer `row.expenses` (which folds in property expenses and land
// tax too), since "total household living expenses" is the plain-
// English concept the spec names.
function livingExpensesForYear(schedule, y) {
  let total = 0;
  for (let m = 0; m < schedule.months; m++) {
    if (schedule.yearOfMonth[m] === y) total += schedule.expenses[m];
  }
  return total;
}

// resolveIncomeRequired(plan, schedule, cpi, wageGrowth) → (y) => amount|null
//
// The returned accessor gives the resolved, indexed, step-down-applied
// Income Required figure for plan year `y` — real $, after-tax
// interpretation per the header above. `null` for every year before
// `startAt`'s own resolved year (never 0 — 0 is a real, distinguishable
// value once the requirement is actually active; null means "not yet
// applicable", the same convention used elsewhere in this codebase for
// pre-commencement figures).
export function resolveIncomeRequired(plan, schedule, cpi, wageGrowth) {
  // A plan that never went through clampPlan (a hand-built test
  // fixture, mostly) has no `retirement` block at all — fall back to
  // the same schema default clampPlan itself would have supplied,
  // rather than going inert, so this behaves identically whether or
  // not the caller clamped first (the same defensive convention
  // keyDates.js's resolveOwnerAge already uses for a missing
  // retirementAge).
  const cfg = plan.retirement?.incomeRequired ?? createIncomeRequired();
  const { planYear: startYear } = resolveRef(cfg.startAt, plan, schedule, "client");
  const baseAmount = cfg.source === "custom" ? cfg.customAmount : livingExpensesForYear(schedule, startYear);
  // A pseudo cashflow-row shape so this reuses schedule.js's OWN
  // canonical indexation ratio (realAmountAt) rather than
  // re-deriving it — the ratio formula is reference-point-agnostic:
  // `m` here is months elapsed since startYear, not literal plan start.
  const pseudoRow = { amount: baseAmount, indexBasis: cfg.indexBasis, indexExtraPct: cfg.indexExtraPct };
  return (y) => {
    if (y < startYear) return null;
    let amount = realAmountAt(pseudoRow, (y - startYear) * 12, cpi, wageGrowth);
    if (cfg.stepDownAtAge != null && schedule.clientAges[y] >= cfg.stepDownAtAge) {
      amount *= (cfg.stepDownPct ?? 100) / 100;
    }
    return amount;
  };
}
