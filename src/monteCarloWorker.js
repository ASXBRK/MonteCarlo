// Monte Carlo web worker (Session B: run in a worker with progress and
// cancel) — keeps the ~9s, 2,000-path run off the main thread, so the
// UI stays responsive instead of freezing with no feedback.
//
// Protocol: main.js posts { state, profiles, options } once; this
// worker replies with a stream of { type: "progress", done, total }
// messages (throttled inside runMonteCarlo itself — see monteCarlo.js's
// onProgress), then exactly one of { type: "done", result } or
// { type: "error", message }.
//
// Cancellation is NOT cooperative — main.js just calls worker.
// terminate() and discards this worker outright. A synchronous, tight
// simulation loop can't poll a "please stop" flag without also paying
// for checking it every iteration, and terminate() is instant and
// unconditionally reliable, which a cooperative flag inside a pure,
// heavily-tested function (runMonteCarlo) would not be worth
// complicating for.

import { runMonteCarlo } from "./monteCarlo.js";

self.onmessage = (e) => {
  const { state, profiles, options } = e.data;
  try {
    const result = runMonteCarlo(state, profiles, {
      ...options,
      onProgress: (done, total) => self.postMessage({ type: "progress", done, total }),
    });
    self.postMessage({ type: "done", result });
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message ?? String(err) });
  }
};
