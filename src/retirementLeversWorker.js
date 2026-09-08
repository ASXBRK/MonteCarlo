// Retirement levers worker (docs/specs/35-retirement-output-view.md,
// Commit 6) — a full solveAllLevers() run is dozens of Monte Carlo
// evaluations across four levers, far too slow for the main thread.
// Same protocol shape as monteCarloWorker.js (see that file's own
// header): main.js posts { state, profiles, options } once, this
// worker replies with exactly one of { type: "done", results } or
// { type: "error", message }. No per-path progress stream here —
// solveAllLevers has no natural finer-grained hook without invasively
// threading a callback through bisectScalar itself, so the UI shows an
// indeterminate "solving" status instead of a percentage.
//
// Cancellation: same as monteCarloWorker.js — main.js just calls
// worker.terminate() and discards this worker outright.
import { solveAllLevers } from "./retirementLevers.js";

self.onmessage = (e) => {
  const { state, profiles, options } = e.data;
  try {
    const results = solveAllLevers(state, profiles, options);
    self.postMessage({ type: "done", results });
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message ?? String(err) });
  }
};
