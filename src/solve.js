// Goal-seek solver (Focus views, Commit 1) — pure, no DOM/Plotly.
//
// The engine runs a multi-decade projection in well under a millisecond
// (deterministic.js), which makes binary search over one scalar input
// cheap enough to run interactively from a UI control. This is the
// capability the workbook never had — Xtools' documented answer to "what
// can this client sustainably draw?" is "we don't have a magic button."
//
// Governing principle (docs/specs/12-focus-views.md): a Focus view never
// re-derives a figure the engine already produces. The solver honours
// this by construction — every trial is a REAL `projectPlan()` run
// against a full clone of the caller's plan, never a shortcut formula.
// `structuredClone` is used for cloning (state is plain JSON, already
// how it round-trips through localStorage — see workspace.js) — the
// caller's own `state` object is never mutated, at any iteration.
//
// `bisectScalar` is the pure numeric core (any x → number function),
// exported separately so its monotonicity/convergence behaviour can be
// tested directly against synthetic functions, without needing a
// financial scenario that is deliberately non-monotonic to prove the
// non-convergence path works. `solveFor` is the thin wrapper that builds
// that function from a real plan, a `vary` target and a `target` metric.
import { projectPlan } from "./deterministic.js";
import { clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";

export const MAX_ITERATIONS = 40;
export const MAX_MS = 2000;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// bisectScalar({ f, lo, hi, targetValue, tolerance, maxIterations, maxMs })
//   f: x => number — assumed MONOTONIC over [lo, hi]. Direction is
//   inferred from the two endpoint evaluations, then checked at every
//   subsequent midpoint: if a midpoint's value falls outside the
//   bracket implied by that direction, the assumption has failed and
//   the search stops rather than continuing to narrow toward a
//   plausible-looking but meaningless answer.
//
// Returns { value, achieved, iterations, converged, reason }:
//   value      — the best x found (null if none can be trusted)
//   achieved   — |f(value) − targetValue| <= tolerance
//   iterations — bisection steps actually run (excludes the 2 endpoint reads)
//   converged  — true only when the result can be trusted: targetValue
//                was bracketed, monotonicity held throughout, and
//                either achieved or the bracket narrowed to (effectively)
//                a point before the iteration/time cap
//   reason     — "converged" | "out-of-bounds" | "non-monotonic" |
//                "iteration-cap" | "time-cap"
export function bisectScalar({
  f, lo, hi, targetValue, tolerance = 1e-6,
  maxIterations = MAX_ITERATIONS, maxMs = MAX_MS,
}) {
  if (!(hi > lo)) throw new Error(`bisectScalar: bounds must satisfy hi > lo (got [${lo}, ${hi}])`);
  const start = now();
  let a = lo, b = hi;
  let fa = f(a), fb = f(b);
  const increasing = fb >= fa;
  const inBracket = (v) => (increasing ? v >= Math.min(fa, fb) - Math.abs(tolerance) && v <= Math.max(fa, fb) + Math.abs(tolerance)
    : v <= Math.max(fa, fb) + Math.abs(tolerance) && v >= Math.min(fa, fb) - Math.abs(tolerance));
  // Bounds are respected literally: if targetValue isn't between the
  // two endpoint values (in either direction), no x in [lo, hi] can
  // reach it under a monotonic assumption — report rather than
  // extrapolate past a bound the caller deliberately set.
  const lower = Math.min(fa, fb), upper = Math.max(fa, fb);
  if (targetValue < lower - Math.abs(tolerance) || targetValue > upper + Math.abs(tolerance)) {
    return { value: null, achieved: false, iterations: 0, converged: false, reason: "out-of-bounds" };
  }
  if (Math.abs(fa - targetValue) <= tolerance) return { value: a, achieved: true, iterations: 0, converged: true, reason: "converged" };
  if (Math.abs(fb - targetValue) <= tolerance) return { value: b, achieved: true, iterations: 0, converged: true, reason: "converged" };

  let iterations = 0;
  while (iterations < maxIterations) {
    if (now() - start > maxMs) {
      return { value: (a + b) / 2, achieved: false, iterations, converged: false, reason: "time-cap" };
    }
    const mid = (a + b) / 2;
    const fm = f(mid);
    iterations++;
    if (!inBracket(fm)) {
      return { value: null, achieved: false, iterations, converged: false, reason: "non-monotonic" };
    }
    if (Math.abs(fm - targetValue) <= tolerance) {
      return { value: mid, achieved: true, iterations, converged: true, reason: "converged" };
    }
    // Narrow toward targetValue, respecting the inferred direction.
    const midIsBelowTarget = fm < targetValue;
    const takeUpperHalf = increasing ? midIsBelowTarget : !midIsBelowTarget;
    if (takeUpperHalf) { a = mid; fa = fm; } else { b = mid; fb = fm; }
  }
  // Iteration cap hit — still report the best estimate, but flag it as
  // not fully converged rather than implying the tolerance was met.
  const best = (a + b) / 2;
  return { value: best, achieved: Math.abs(f(best) - targetValue) <= tolerance, iterations, converged: false, reason: "iteration-cap" };
}

// --- vary: where a trial value gets written into a CLONED plan state ---
//
// Kept as a small named-kind dispatch (not a raw closure) so callers
// (Focus views) describe "what to vary" declaratively — e.g. for a
// dropdown, or for a test to assert against without constructing
// functions. New kinds are added here as later Focus commits need them
// (a property's purchase date, a liability's extra-repayment amount);
// commit 1 ships the three the spec calls for.
//
// "cashflowAmount"/"superContributionAmount" write a plain dollar
// amount. "goalTargetDate" writes an age-based DateRef — solving for
// WHEN, not how much, per the spec.
function findById(rows, id) {
  const row = (rows ?? []).find((r) => r.id === id);
  if (!row) throw new Error(`solve.js: no row with id "${id}" found`);
  return row;
}

const CASHFLOW_ARRAYS = ["income", "expenses", "deductions", "contributions", "withdrawals"];

export function applyVary(clonedState, vary, x) {
  switch (vary.kind) {
    case "cashflowAmount": {
      for (const key of CASHFLOW_ARRAYS) {
        const row = (clonedState.cashflows[key] ?? []).find((r) => r.id === vary.id);
        if (row) { row.amount = x; return; }
      }
      throw new Error(`solve.js: no cashflow row with id "${vary.id}" found in income/expenses/deductions/contributions/withdrawals`);
    }
    case "superContributionAmount": {
      const row = findById(clonedState.cashflows.superContributions, vary.id);
      row.amount = x;
      return;
    }
    case "goalTargetDate": {
      const goal = findById(clonedState.goals, vary.id);
      goal.targetAt = { kind: "age", age: x };
      return;
    }
    // Focus Commit 2 — "When could I buy?" varies the property's OWN
    // purchase date, same "when, not how much" shape as goalTargetDate.
    case "propertyPurchaseDate": {
      const property = findById(clonedState.properties, vary.id);
      property.purchaseAt = { kind: "age", age: x };
      return;
    }
    default:
      throw new Error(`solve.js: unknown vary.kind "${vary.kind}"`);
  }
}

// solveFor({ state, target, vary, bounds, tolerance }) → see bisectScalar's
// return shape.
//
//   state:   the caller's plan state — NEVER mutated; each trial clones it.
//   target:  { metric(out): number, value: number } — metric reads a
//            scalar from a real projectPlan() output (e.g. a year's
//            closingBalance, or out.shortfall?.total ?? 0); value is
//            what we want metric(out) to equal.
//   vary:    { kind, id } — see applyVary above.
//   bounds:  [lo, hi] over the varied scalar.
//   tolerance: on the METRIC's own units (dollars, unless the metric
//            returns something else) — defaults to $1.
export function solveFor({ state, target, vary, bounds, tolerance = 1 }) {
  const [lo, hi] = bounds;
  const evaluate = (x) => {
    const clone = structuredClone(state);
    applyVary(clone, vary, x);
    // Re-clamp/re-derive the whole plan (same pass an edit through the
    // UI would trigger — see main.js's saveState/refreshOutputs call
    // sites) rather than handing the engine a hand-mutated object
    // straight: this is what keeps a solver trial from "accepting an
    // input that bypasses the plan" (the governing principle) — a
    // goal's target age landing outside [currentAge, endAge] gets
    // clamped into range the same way a manual edit would, instead of
    // silently reaching projectPlan with an unvalidated value.
    const validated = clampAllToPlan(clone, PROFILES);
    const out = projectPlan(validated);
    return target.metric(out);
  };
  return bisectScalar({
    f: evaluate, lo, hi, targetValue: target.value, tolerance,
    maxIterations: MAX_ITERATIONS, maxMs: MAX_MS,
  });
}
