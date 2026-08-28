// Focus: Approach comparison (spec 30, Commit 3) — net assets under
// both the real engine and the static extrapolation model over time,
// the divergence, and the seven-driver attribution ranked by
// contribution. A thin pass-through to measureDivergence()
// (divergence.js), which does all the actual work — this file exists
// only so main.js's Focus-view convention (a build*Focus function
// taking a params object) has something with the right shape to call,
// matching every other Focus module.
import { measureDivergence } from "./divergence.js";

// buildApproachComparisonFocus({ state, snapshotYear, indexation }) →
// measureDivergence()'s own result shape ({ byYear, summary, drivers,
// totalGap, residual }), unchanged. `out` (the active scenario's
// already-computed real projection) is deliberately NOT a parameter
// here, unlike most other Focus builders — measureDivergence runs its
// own projectPlan() internally (it has to, to build the comparable-
// scope real figures right alongside the static ones for every year,
// not just the ones a caller's own `out` happens to have already
// summed), so accepting a pre-computed one in would go unused.
export function buildApproachComparisonFocus({ state, snapshotYear = 0, indexation = "cpi" }) {
  return measureDivergence(state, { snapshotYears: snapshotYear, indexation });
}
