// Monte Carlo simulation (Session B) — pure, no DOM/Plotly. Drives the
// real, tax-aware projectPlan() engine once per path, with randomised
// monthly returns per included financial asset and super account —
// NOT the legacy scalar sim.js (a single bucket, no tax, no schedule),
// which this supersedes for full-plan simulation and which stays
// behind LEGACY_INSIGHTS_ENABLED, untouched.
//
// Correlation model: a single shared market factor at ρ = 0.85, loaded
// identically onto every holding (so any two distinct holdings'
// innovations correlate at exactly ρ), combined with each holding's
// OWN regime-switching Markov chain — the existing per-profile
// mechanics profiles.js/sim.js already calibrate (category → p_stay_
// normal/p_stay_stress/stressMultiplier), unchanged and untouched
// here. This is a deliberate simplification, not an oversight: the new
// per-class weights (Asset class allocations commit) would in
// principle support a genuine per-class correlation matrix (Australian
// vs international equity, property, fixed interest, cash each with
// their own factor loadings), but that needs per-class σ calibrated to
// reproduce each profile's firm-set total σ — get that calibration
// wrong and the model would silently contradict the firm's stated
// volatility assumptions, which is worse than the simplification it
// would replace. Noted in the Parameters modal as a future refinement;
// not built here.
//
// Shock generation is pre-computed for the WHOLE path, sequentially,
// before projectPlan() sees a single month of it (see deterministic.
// js's `mc` parameter header comment) — regime state is inherently
// sequential, and the measurement/real pass replay within a plan year
// must see byte-identical returns or the tax timing split means
// nothing. This is the same pre-generate-then-replay discipline
// sim.js's preGenZ/preGenU already uses, extended to a per-holding,
// tax-aware engine.

import { PROFILES } from "./profiles.js";
import { profileForAllocation } from "./allocation.js";
import { projectPlan } from "./deterministic.js";

export const DEFAULT_NUM_PATHS = 2000;
export const MARKET_RHO = 0.85;
const SQRT12 = Math.sqrt(12);
// [key, quantile] — key names match sim.js's p05/p25/p50/p75/p95
// convention exactly, so UI code can treat either engine's percentile
// bands the same way.
const QUANTILES = [["p05", 0.05], ["p25", 0.25], ["p50", 0.50], ["p75", 0.75], ["p95", 0.95]];

// Box-Muller — same formula as sim.js's randn(), duplicated rather
// than imported: this module deliberately has no dependency on the
// legacy engine it supersedes. `rng` is a () => [0,1) source, letting
// tests inject a seeded generator for reproducibility; production
// callers pass nothing and get Math.random.
function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Every holding this plan can shock: included, non-lifestyle financial
// assets and included super accounts, each resolved to the profile
// that governs its σ/regime parameters (a custom allocation via its
// volatility-basis profile — the same resolution the allocation chart
// uses, from allocation.js, so the two features can never disagree
// about which profile a holding is "really" on). Lifestyle assets
// carry no profile and are left deterministic (they simply never
// appear here, so deterministic.js's default shockFor(id, m) = 0
// applies to them by construction, same as an asset excluded entirely).
export function holdingsFor(state, profiles = PROFILES) {
  const assets = state.assets
    .filter((a) => a.include && a.class !== "lifestyle")
    .map((a) => ({ id: a.id, allocation: a.allocation }));
  const supers = (state.plan.superAccounts ?? [])
    .filter((s) => s.include)
    .map((s) => ({ id: s.id, allocation: s.allocation }));
  return [...assets, ...supers]
    .map((h) => ({ id: h.id, profile: profileForAllocation(h.allocation, profiles) }))
    .filter((h) => h.profile); // a stale/unknown profile reference shocks nothing, same as allocation.js
}

// One path's shock lookup, resolved sequentially month-by-month (both
// the regime transition and the correlated draw are inherently
// ordered) and handed back as a plain function so deterministic.js
// never has to know this is a Map of Float64Arrays underneath.
// Returns a REAL monthly return shock (zero-mean; deterministic.js
// adds this to its own deterministic mu, never replaces it).
function generatePathShocks(holdings, months, rng) {
  const loading = Math.sqrt(MARKET_RHO);
  const idio = Math.sqrt(1 - MARKET_RHO);
  const regime = new Map(holdings.map((h) => [h.id, 0])); // 0 = normal — every holding starts there (sim.js convention)
  const series = new Map(holdings.map((h) => [h.id, new Float64Array(months)]));
  for (let m = 0; m < months; m++) {
    const zMarket = randn(rng);
    for (const h of holdings) {
      const p = h.profile;
      const wasNormal = regime.get(h.id) === 0;
      const u = rng();
      const isNormal = wasNormal ? u < p.p_stay_normal : u >= p.p_stay_stress;
      regime.set(h.id, isNormal ? 0 : 1);
      const sigmaAnnual = isNormal ? p.sigma_normal : p.sigma_stress;
      const sigmaMonthly = sigmaAnnual / SQRT12;
      const z = loading * zMarket + idio * randn(rng);
      series.get(h.id)[m] = sigmaMonthly * z;
    }
  }
  const lookup = new Map();
  for (const [id, arr] of series) lookup.set(id, arr);
  return (id, m) => lookup.get(id)?.[m] ?? 0;
}

// runMonteCarlo(state, profiles, options) → {
//   numPaths, years, elapsedMs,
//   netAssets: { p05, p25, p50, p75, p95 }  — each an array of length years,
//   successProbability,   — fraction of paths with NO shortfall (projection.shortfall === null)
//   samplePaths: [projectPlan() output, ...]  — sampleCount full path outputs, for
//     spot-checking (e.g. the conservation invariant) or deeper inspection; NOT a
//     representative percentile sample, just an unbiased random draw of raw outputs.
// }
//
// options:
//   numPaths    — default DEFAULT_NUM_PATHS (2,000)
//   rng         — () => [0,1) source; default Math.random. Inject a seeded
//                 generator for reproducible tests.
//   sampleCount — how many full path outputs to retain (default 20)
export function runMonteCarlo(state, profiles = PROFILES, options = {}) {
  const { numPaths = DEFAULT_NUM_PATHS, rng = Math.random, sampleCount = 20 } = options;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const t0 = now();

  const holdings = holdingsFor(state, profiles);
  // A single deterministic run first, purely to read off months/years
  // from the schedule — cheap relative to the paths themselves, and
  // avoids this module reaching into buildSchedules directly.
  const base = projectPlan(state, profiles);
  const months = base.schedule.months;
  const years = base.yearly.length;

  const netAssetsAll = new Float64Array(numPaths * years); // [path*years + y]
  let successes = 0;
  const sampleIdx = new Set();
  const targetSamples = Math.min(sampleCount, numPaths);
  while (sampleIdx.size < targetSamples) sampleIdx.add(Math.floor(rng() * numPaths));
  const samplePaths = [];

  for (let path = 0; path < numPaths; path++) {
    const shockFor = generatePathShocks(holdings, months, rng);
    const out = projectPlan(state, profiles, { shockFor });
    const rowBase = path * years;
    for (let y = 0; y < years; y++) netAssetsAll[rowBase + y] = out.yearly[y].netAssets;
    if (!out.shortfall) successes++;
    if (sampleIdx.has(path)) samplePaths.push(out);
  }

  const col = new Float64Array(numPaths);
  const netAssets = {};
  for (const [key] of QUANTILES) netAssets[key] = new Array(years);
  for (let y = 0; y < years; y++) {
    for (let path = 0; path < numPaths; path++) col[path] = netAssetsAll[path * years + y];
    col.sort(); // Float64Array.sort defaults to ascending numeric order (unlike Array.sort's string default)
    for (const [key, q] of QUANTILES) netAssets[key][y] = quantileSorted(col, q);
  }

  return {
    numPaths, years, elapsedMs: now() - t0,
    netAssets,
    successProbability: successes / numPaths,
    samplePaths,
  };
}
