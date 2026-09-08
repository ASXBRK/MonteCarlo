// Maximum sustainable spend worker (docs/specs/36-retirement-outputs.md,
// Commit 2) — reuses retirementLevers.js's own solveSpendLess (spec 35
// Commit 6) rather than a second solve implementation: "the highest
// Income Required at which no more than the chosen tolerance's share
// of paths run short" is EXACTLY what that lever already solves for —
// this worker just calls it with an adviser-chosen `threshold`
// (5/10/20%) instead of the levers panel's own fixed ruin threshold,
// and reports it as a standalone headline rather than one of four
// ranked levers.
//
// Same protocol shape as monteCarloWorker.js/retirementLeversWorker.js
// (see those files' own header comments): main.js posts one
// {state, profiles, options}, this worker replies with exactly one of
// {type: "done", result} or {type: "error", message}. Cancellation is
// the same non-cooperative worker.terminate() as those two.
import { solveSpendLess } from "./retirementLevers.js";

self.onmessage = (e) => {
  const { state, profiles, options } = e.data;
  try {
    const result = solveSpendLess(state, profiles, options);
    self.postMessage({ type: "done", result });
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message ?? String(err) });
  }
};
