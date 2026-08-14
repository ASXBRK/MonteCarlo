// Monte Carlo simulation (Session B) — pure, no DOM/Plotly. Drives the
// real, tax-aware projectPlan() engine once per path, with randomised
// monthly returns per included financial asset and super account, and
// a randomised annual CPI per path — NOT the legacy scalar sim.js (a
// single bucket, no tax, no schedule), which this supersedes for
// full-plan simulation and which stays behind LEGACY_INSIGHTS_ENABLED,
// untouched.
//
// Correlation model: a single shared market factor at ρ (default
// 0.85), loaded identically onto every holding (so any two distinct
// holdings' innovations correlate at exactly ρ), combined with each
// holding's OWN regime-switching Markov chain — the existing per-
// profile mechanics profiles.js/sim.js already calibrate (category →
// p_stay_normal/p_stay_stress/stressMultiplier), unchanged and
// untouched here. This is a deliberate simplification, not an
// oversight: the new per-class weights (Asset class allocations
// commit) would in principle support a genuine per-class correlation
// matrix (Australian vs international equity, property, fixed
// interest, cash each with their own factor loadings), but that needs
// per-class σ calibrated to reproduce each profile's firm-set total σ
// — get that calibration wrong and the model would silently
// contradict the firm's stated volatility assumptions, which is worse
// than the simplification it would replace. Noted in the Parameters
// modal as a future refinement; not built here.
//
// CPI: drawn once per plan year per path (mean = the plan's assumed
// cpi, configurable σ and floor), fed to deterministic.js as
// mc.cpiForYear — see that module's header comment for exactly what it
// does and doesn't affect (liabilities and planned-property pricing
// only; asset/super/WCA expected returns stay Fisher-converted from
// the plan's single assumed cpi). This is what gives a fixed-nominal
// mortgage a real burden that actually varies path to path — inflation
// was previously certain (every path used the same assumed cpi), which
// silently understated dispersion for geared clients.
//
// Seeding: every random draw this module makes — CPI, regime
// transitions, correlated return shocks, even which paths get kept as
// full samples — comes from ONE rng stream per run, in a fixed order,
// so options.seed fully determines the output (see createRng below).
// This matters beyond reproducible tests: comparing two scenarios
// (e.g. a strategy change) must run both on IDENTICAL draws, or the
// difference between their results includes sampling noise as well as
// the strategy effect — pass the same seed to both runMonteCarlo()
// calls to get that. (Fixed defect: a `seed` option was documented but
// never actually consumed — every run used Math.random regardless.)
//
// Percentile bands are 10/25/50/75/90 (not sim.js's legacy 05/25/50/
// 75/95). Ruin has exactly one definition, used everywhere in this
// module: out.shortfall !== null (any unfunded cashflow before
// projection end) — ruinProbability is the fraction of paths meeting
// it; nothing else (a "success" figure, say) computes it a second way.
//
// Shock and CPI generation are pre-computed for the WHOLE path,
// sequentially, before projectPlan() sees a single month of it (see
// deterministic.js's `mc` parameter header comment) — regime state is
// inherently sequential, and the measurement/real pass replay within a
// plan year must see byte-identical returns or the tax timing split
// means nothing. This is the same pre-generate-then-replay discipline
// sim.js's preGenZ/preGenU already uses, extended to a per-holding,
// tax-aware engine.

import { PROFILES } from "./profiles.js";
import { profileForAllocation } from "./allocation.js";
import { projectPlan } from "./deterministic.js";

export const DEFAULT_NUM_PATHS = 2000;
export const MARKET_RHO = 0.85;
export const DEFAULT_CPI_SIGMA = 0.01; // 1.0 percentage point, annual
export const DEFAULT_CPI_FLOOR = -0.01; // −1%
const SQRT12 = Math.sqrt(12);
// [key, quantile] — 10/25/50/75/90, not sim.js's legacy 05/25/50/75/95:
// the 5th/95th tails are wide enough, on a 40+ year tax-aware
// projection, to read as more extreme than they are — 10/90 is the
// firm's chosen band for advice-facing display.
const QUANTILES = [["p10", 0.10], ["p25", 0.25], ["p50", 0.50], ["p75", 0.75], ["p90", 0.90]];

// A small, solid seeded PRNG (mulberry32) — deterministic given the
// same 32-bit integer seed, so options.seed fully determines a run's
// output. Not cryptographic; doesn't need to be for a simulation.
export function createRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller — same formula as sim.js's randn(), duplicated rather
// than imported: this module deliberately has no dependency on the
// legacy engine it supersedes. `rng` is a () => [0,1) source.
function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8)
// — used to turn a correlated normal draw into a correlated uniform
// for the regime transition below, so two holdings' REGIME STATES can
// be correlated by the same ρ their return shocks are, not just their
// shock magnitude within whatever regime each independently drifted
// into. Without this, ρ = 1 still let two identical-profile holdings
// diverge into different regimes (a real, tested-for defect: perfect
// return-shock correlation is not the same as perfect realised-return
// correlation if the regimes themselves can disagree).
function normalCdf(z) {
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const p = 0.2316419;
  const absZ = Math.abs(z);
  const t = 1 / (1 + p * absZ);
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const phi = Math.exp((-absZ * absZ) / 2) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - phi * poly;
  return z >= 0 ? cdf : 1 - cdf;
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

function median(values) {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  return quantileSorted(sorted, 0.5);
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
    .map((a) => ({ id: a.id, name: a.name, allocation: a.allocation }));
  const supers = (state.plan.superAccounts ?? [])
    .filter((s) => s.include)
    .map((s) => ({ id: s.id, name: s.name, allocation: s.allocation }));
  return [...assets, ...supers]
    .map((h) => ({ ...h, profile: profileForAllocation(h.allocation, profiles) }))
    .filter((h) => h.profile); // a stale/unknown profile reference shocks nothing, same as allocation.js
}

// Holdings on a "custom" allocation — flagged (never blocking; the run
// proceeds regardless), since a custom allocation's variability is
// modelled on whatever profile its volatility basis happens to point
// at, not on a separately-calibrated σ of its own. The UI's "N
// asset(s) use custom returns" note (renderMonteCarloView) reads this
// unconditionally, whether or not the run has happened yet.
export function customAllocationHoldings(state, profiles = PROFILES) {
  return holdingsFor(state, profiles)
    .filter((h) => h.allocation?.mode === "custom")
    .map((h) => ({ id: h.id, name: h.name, volBasis: h.allocation.volBasis }));
}

// One path's annual CPI draw: mean = the plan's assumed cpi, each
// year's draw independent of every other year's (and of the return
// shocks below) — a simple, disclosed starting point; genuine
// inflation persistence/correlation-with-markets is not modelled.
// Floored, not clamped-and-redrawn: a floor that quietly resampled
// would bias the mean upward exactly in the scenarios (deep deflation)
// where the floor binds most often.
function generatePathCpi(years, rng, { mean, sigma, floor }) {
  const path = new Float64Array(years);
  for (let y = 0; y < years; y++) {
    path[y] = Math.max(floor, mean + sigma * randn(rng));
  }
  return path;
}

// One path's shock lookup, resolved sequentially month-by-month (both
// the regime transition and the correlated draw are inherently
// ordered) and handed back as a plain function so deterministic.js
// never has to know this is a Map of Float64Arrays underneath.
// Returns a REAL monthly return shock (zero-mean; deterministic.js
// adds this to its own deterministic mu, never replaces it).
//
// Two INDEPENDENT market factors per month — one for the regime
// transition, one for the return magnitude — each loaded onto every
// holding at the same ρ. Using the same market factor for both would
// couple a holding's own regime transition to its own return magnitude
// within the month, which isn't something ρ is meant to control;
// keeping them separate means ρ = 1 makes two identical-profile
// holdings' regime HISTORY identical (and hence their realised returns
// perfectly correlated), while ρ = 0 makes both independent, without
// smuggling in an unintended within-holding correlation either way.
function generatePathShocks(holdings, months, rng, rho) {
  const loading = Math.sqrt(rho);
  const idio = Math.sqrt(1 - rho);
  const regime = new Map(holdings.map((h) => [h.id, 0])); // 0 = normal — every holding starts there (sim.js convention)
  const series = new Map(holdings.map((h) => [h.id, new Float64Array(months)]));
  for (let m = 0; m < months; m++) {
    const zMarketRegime = randn(rng);
    const zMarketReturn = randn(rng);
    for (const h of holdings) {
      const p = h.profile;
      const zRegime = loading * zMarketRegime + idio * randn(rng);
      const u = normalCdf(zRegime);
      const wasNormal = regime.get(h.id) === 0;
      const isNormal = wasNormal ? u < p.p_stay_normal : u >= p.p_stay_stress;
      regime.set(h.id, isNormal ? 0 : 1);
      const sigmaAnnual = isNormal ? p.sigma_normal : p.sigma_stress;
      const sigmaMonthly = sigmaAnnual / SQRT12;
      const z = loading * zMarketReturn + idio * randn(rng);
      series.get(h.id)[m] = sigmaMonthly * z;
    }
  }
  return (id, m) => series.get(id)?.[m] ?? 0;
}

// runMonteCarlo(state, profiles, options) → {
//   numPaths, years, elapsedMs,
//   netAssets: { p10, p25, p50, p75, p90 }  — each an array of length years,
//   endDistribution: { min, p10, p25, p50, p75, p90, max, mean }  — the FINAL
//     year's netAssets distribution across all paths (Tables view's
//     "distribution summary of end net assets").
//   ruinProbability,  — fraction of paths with ANY unfunded cashflow before
//     projection end (out.shortfall !== null). This is the SINGLE, locked
//     ruin definition (the tool's original design convention: one ruin
//     definition, used everywhere) — nothing else in this module computes
//     ruin or "success" independently of it. A "success" display should
//     read 1 − ruinProbability rather than track its own counter.
//   medianShortfallAge,  — median client age at FIRST shortfall, over ONLY
//     the ruined paths (median(), not mean, so one catastrophically early
//     outlier doesn't drag the headline figure) — null when no path ruined.
//   customHoldings,  — customAllocationHoldings(state, profiles); the UI's
//     "N asset(s) use custom returns" flag reads this, unconditionally
//     (the run itself is never blocked by a custom allocation).
//   samplePaths: [projectPlan() output, ...]  — sampleCount full path outputs, for
//     spot-checking (e.g. the conservation invariant) or deeper inspection; NOT a
//     representative percentile sample, just an unbiased random draw of raw outputs.
// }
//
// options:
//   numPaths    — default DEFAULT_NUM_PATHS (2,000)
//   seed        — integer; when given, createRng(seed) drives every draw this
//                 run makes and the result is byte-identical across calls.
//                 Omitted, draws come from Math.random (non-reproducible).
//   rng         — advanced escape hatch: a () => [0,1) source, used verbatim
//                 instead of seed/Math.random. Mainly for tests that need a
//                 specific generator rather than an integer seed.
//   sampleCount — how many full path outputs to retain (default 20)
//   rho         — market-factor correlation (default MARKET_RHO, 0.85)
//   cpiSigma    — annual CPI draw's σ (default DEFAULT_CPI_SIGMA, 1.0%)
//   cpiFloor    — annual CPI draw's floor (default DEFAULT_CPI_FLOOR, −1%)
//   onProgress(pathsDone, numPaths) — called periodically (throttled to
//     roughly every 1% of numPaths, never more than once per path) as
//     paths complete. The worker (monteCarloWorker.js) forwards this to
//     the main thread via postMessage — a synchronous call here still
//     reaches the main thread immediately, since postMessage queues
//     rather than blocks, which is what lets a long run report progress
//     without needing to chunk the loop itself.
export function runMonteCarlo(state, profiles = PROFILES, options = {}) {
  const {
    numPaths = DEFAULT_NUM_PATHS,
    seed = null,
    rng: rngOverride = null,
    sampleCount = 20,
    rho = MARKET_RHO,
    cpiSigma = DEFAULT_CPI_SIGMA,
    cpiFloor = DEFAULT_CPI_FLOOR,
    onProgress = null,
  } = options;
  const progressEvery = Math.max(1, Math.floor(numPaths / 100));
  const rng = rngOverride ?? (seed != null ? createRng(seed) : Math.random);
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const t0 = now();

  const holdings = holdingsFor(state, profiles);
  const cpiMean = state.assumptions.cpi;
  // A single deterministic run first, purely to read off months/years
  // from the schedule — cheap relative to the paths themselves, and
  // avoids this module reaching into buildSchedules directly.
  const base = projectPlan(state, profiles);
  const months = base.schedule.months;
  const years = base.yearly.length;

  const netAssetsAll = new Float64Array(numPaths * years); // [path*years + y]
  let ruinCount = 0;
  const shortfallAges = [];
  const sampleIdx = new Set();
  const targetSamples = Math.min(sampleCount, numPaths);
  while (sampleIdx.size < targetSamples) sampleIdx.add(Math.floor(rng() * numPaths));
  const samplePaths = [];

  for (let path = 0; path < numPaths; path++) {
    const cpiPath = generatePathCpi(years, rng, { mean: cpiMean, sigma: cpiSigma, floor: cpiFloor });
    const shockFor = generatePathShocks(holdings, months, rng, rho);
    const out = projectPlan(state, profiles, { shockFor, cpiForYear: (y) => cpiPath[y] });
    const rowBase = path * years;
    for (let y = 0; y < years; y++) netAssetsAll[rowBase + y] = out.yearly[y].netAssets;
    // The single, locked ruin definition (see the docblock above): ANY
    // unfunded cashflow before projection end. out.shortfall is exactly
    // that — deterministic.js sets it the first time recordUnfunded
    // fires anywhere in the projection, non-null for the rest of the run.
    if (out.shortfall) {
      ruinCount++;
      shortfallAges.push(out.shortfall.clientAge);
    }
    if (sampleIdx.has(path)) samplePaths.push(out);
    if (onProgress && ((path + 1) % progressEvery === 0 || path + 1 === numPaths)) {
      onProgress(path + 1, numPaths);
    }
  }

  const col = new Float64Array(numPaths);
  const netAssets = {};
  for (const [key] of QUANTILES) netAssets[key] = new Array(years);
  let endDistribution = null;
  for (let y = 0; y < years; y++) {
    for (let path = 0; path < numPaths; path++) col[path] = netAssetsAll[path * years + y];
    col.sort(); // Float64Array.sort defaults to ascending numeric order (unlike Array.sort's string default)
    for (const [key, q] of QUANTILES) netAssets[key][y] = quantileSorted(col, q);
    if (y === years - 1) {
      // The Tables view's "distribution summary of end net assets"
      // (min/max/mean alongside the percentile bands already computed
      // above) — captured here rather than re-sorting a second time,
      // since `col` already holds the final year's full sorted set.
      let sum = 0;
      for (let path = 0; path < numPaths; path++) sum += col[path];
      endDistribution = {
        min: col[0], max: col[numPaths - 1], mean: sum / numPaths,
        p10: netAssets.p10[y], p25: netAssets.p25[y], p50: netAssets.p50[y],
        p75: netAssets.p75[y], p90: netAssets.p90[y],
      };
    }
  }

  return {
    numPaths, years, elapsedMs: now() - t0,
    netAssets,
    endDistribution,
    ruinProbability: ruinCount / numPaths,
    medianShortfallAge: median(shortfallAges),
    customHoldings: customAllocationHoldings(state, profiles),
    samplePaths,
  };
}
