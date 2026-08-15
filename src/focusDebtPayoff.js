// Focus: Debt payoff (docs/specs/12-focus-views.md, Commit 5) — pure, no
// DOM/Plotly. Payoff date and lifetime interest are read straight off a
// real projectPlan() output; the effect of extra repayments is the
// engine's OWN comparison (liabilityRepaymentStats), read through, not
// recomputed; the counterfactual balance chart is a SEPARATE real
// projectPlan() run on a clone with this loan's extras stripped — the
// same "always use the real engine" pattern focusDeposit.js and
// focusSalarySacrifice.js already establish.
import { resolveRef } from "./keyDates.js";
import { findMinimumThreshold } from "./solve.js";
import { projectPlan } from "./deterministic.js";
import { clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";

// Loans this view can answer for — anything with an outstanding
// starting balance. (A liability entered at $0 has nothing to pay off.)
export function eligibleDebtPayoffLoans(state) {
  return (state.liabilities ?? []).filter((l) => l.balance > 0);
}

// A closing balance this close to zero counts as paid off — matches
// the small residual amortisation can leave from monthly rounding.
const PAYOFF_TOLERANCE = 0.5;

function findPayoffYear(out, liabilityId) {
  return out.yearly.findIndex((row) => (row.liabilities[liabilityId]?.closing ?? Number.MAX_SAFE_INTEGER) <= PAYOFF_TOLERANCE);
}

// Cumulative unfundedCashflow through year `y` inclusive — the same
// ground-truth funding test focusDeposit.js's cumulativeUnfundedThroughYear
// uses (duplicated here rather than shared: each Focus module is
// self-contained, per this codebase's established per-file convention —
// see focusSalarySacrifice.test.js's own header for why fixtures aren't
// shared either). Used only by the solver's affordability check below.
function cumulativeUnfundedThroughYear(out, y) {
  if (y == null || y < 0) return Number.MAX_SAFE_INTEGER;
  let total = 0;
  for (let k = 0; k <= y; k++) total += out.yearly[k]?.unfundedCashflow ?? 0;
  return total;
}

// buildDebtPayoffFocus({ out, state, liabilityId }) → the view's data, or
// null if the loan doesn't exist.
export function buildDebtPayoffFocus({ out, state, liabilityId }) {
  const liability = (state.liabilities ?? []).find((l) => l.id === liabilityId);
  if (!liability) return null;

  const payoffYear = findPayoffYear(out, liabilityId);
  const payoff = payoffYear === -1
    ? null
    : { year: payoffYear, age: out.schedule.clientAges[payoffYear], fyLabel: out.schedule.fyLabels[payoffYear] };

  // Total interest over the loan's life — safe to sum every projected
  // year regardless of whether it carries extras: interest is exactly
  // 0 once the balance reaches zero, so summing past payoff adds
  // nothing. Works for ANY loan, not just ones with extras configured.
  const totalInterest = out.yearly.reduce((s, row) => s + (row.liabilities[liabilityId]?.interest ?? 0), 0);

  // The engine's own before/after comparison — already computed once,
  // per liability, by deterministic.js. Only populated for loans with
  // extraRepayments/oneOffRepayments configured; null here means "no
  // extras configured to have an effect", not "no effect found".
  const stats = out.liabilityRepaymentStats?.[liabilityId] ?? null;

  // Counterfactual balance — a SEPARATE real projectPlan() run on a
  // clone with this loan's own extras stripped, not a re-derivation of
  // scheduledAmortisation's summary figures (which don't expose a
  // monthly/yearly series). For a loan with no extras configured, the
  // two series come out identical — the honest answer to "what did
  // extra repayments do here", since there aren't any.
  const clone = structuredClone(state);
  const cLiability = clone.liabilities.find((l) => l.id === liabilityId);
  cLiability.extraRepayments = [];
  cLiability.oneOffRepayments = [];
  const counterfactualOut = projectPlan(clampAllToPlan(clone, PROFILES));

  const balanceSeries = out.yearly.map((row, y) => ({
    year: y,
    age: out.schedule.clientAges[y],
    fyLabel: out.schedule.fyLabels[y],
    actual: row.liabilities[liabilityId]?.closing ?? 0,
    noExtras: counterfactualOut.yearly[y]?.liabilities?.[liabilityId]?.closing ?? 0,
  }));

  return { liability: { id: liability.id, name: liability.name }, payoff, totalInterest, stats, balanceSeries };
}

// solveExtraRepaymentForPayoffDate — "What extra repayment clears this
// by [date]?" Solves the SMALLEST monthly extra repayment (added on top
// of whatever's already configured, from now until the target age) that
// brings the loan's own payoff year at or before the target — built on
// solve.js's findMinimumThreshold, since a loan's payoff year plateaus
// (once cleared, more extra repayment keeps returning the same year, or
// an earlier one, never a later one) — the same "leftmost true in a
// monotonic predicate" shape as focusDeposit.js's two solvers, not an
// equation to invert.
export function solveExtraRepaymentForPayoffDate({ state, liabilityId, targetAge }) {
  const liability = (state.liabilities ?? []).find((l) => l.id === liabilityId);
  if (!liability) return { value: null, achieved: false, iterations: 0, converged: false, reason: "out-of-bounds", unfunded: null };

  const baseOut = projectPlan(state);
  const ref = resolveRef({ kind: "age", age: targetAge }, state.plan, baseOut.schedule, "client");
  const targetYear = ref.planYear;
  const fromAge = state.plan.client.currentAge;

  const draftExtra = (amount) => ({
    id: "__focus-debt-solve__", label: "Extra repayment (Focus solver draft)",
    amount, frequency: "monthly",
    from: { kind: "age", age: fromAge }, to: { kind: "age", age: targetAge },
    indexBasis: "none", indexExtraPct: 0,
  });

  const payoffYearAt = (extra) => {
    const clone = structuredClone(state);
    const l = clone.liabilities.find((x) => x.id === liabilityId);
    l.extraRepayments = [...(l.extraRepayments ?? []), draftExtra(extra)];
    const out = projectPlan(clampAllToPlan(clone, PROFILES));
    const y = findPayoffYear(out, liabilityId);
    // Not paid off within the projection at all — treat as "later than
    // any year the search cares about" rather than -1, which would
    // read as "already paid off".
    return y === -1 ? out.yearly.length : y;
  };

  // A generous cap: the loan's own opening balance. An extra repayment
  // of the whole balance in the very first month clears it almost
  // immediately — if even that can't reach the target date, the target
  // genuinely isn't reachable this way, and findMinimumThreshold
  // reports that honestly rather than extrapolating past the bound.
  const hi = Math.max(liability.balance, 1);
  const result = findMinimumThreshold({ lo: 0, hi, metric: payoffYearAt, threshold: targetYear, tolerance: 0.5 });
  if (!result.converged) return { ...result, unfunded: null };

  // Affordability — the spec's own "surfaced, not hidden" requirement:
  // a mathematically sufficient extra repayment the household can't
  // actually fund (surplus doesn't cover it) is not a real answer.
  // Checked against the SAME cumulative unfundedCashflow ground truth
  // focusDeposit.js's solvers use, run once more at the solved amount.
  const clone = structuredClone(state);
  const l = clone.liabilities.find((x) => x.id === liabilityId);
  l.extraRepayments = [...(l.extraRepayments ?? []), draftExtra(result.value)];
  const out = projectPlan(clampAllToPlan(clone, PROFILES));
  const payoffYear = findPayoffYear(out, liabilityId);
  const throughYear = payoffYear === -1 ? out.yearly.length - 1 : payoffYear;
  const unfundedAmount = cumulativeUnfundedThroughYear(out, throughYear);
  return { ...result, fromAge, toAge: targetAge, unfunded: unfundedAmount > 0.5 ? unfundedAmount : 0 };
}
