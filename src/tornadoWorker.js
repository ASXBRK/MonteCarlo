// Tornado worker: runs perturbation sims off the main thread.
// Receives a scenario + profiles snapshot, returns either standard
// tornado bars (signed metric deltas) or goal-seek tornado bars
// (minimum input changes that hit the target ruin probability).

import { simulate, generateShocks, generateUniforms, buildGlideSchedule } from "./sim.js";
import { RISK_RUNGS, rungOf, neighbourAsset as ladderNeighbour, realMu } from "./profiles.js";

const TORNADO_PATHS = 1000;

// Flat sequence of every asset on the ladder — used only by the
// goal-seek asset search when we exhaustively try every alternative.
// Residential Property is intentionally excluded (it's a distinct
// asset class, not a step on the diversified risk ladder).
const LADDER_FLAT = RISK_RUNGS.flatMap((r) => r.assets);

// Resolve a horizon (in years) for a candidate scenario in either mode.
function horizonFor(scenario, mode) {
  if (mode === "drawdown") {
    return Math.max(1, scenario.endAge - scenario.currentAge);
  }
  return scenario.horizonYears;
}

// Build the simulate() args for a candidate scenario, reusing shared
// shocks at the given stride (in months).
// Worker is strictly sequential (new compute requests replace old
// pending ones via the caller's token pattern), so a module-level
// CPI stash is safe and lets us avoid threading `cpi` through every
// runMetric / searchAsset call site.
let currentCpi = 0.025;

function buildArgs(scenario, profiles, mode, shocks, uniforms, stride, cpi = currentCpi) {
  const p = profiles[scenario.asset];
  const horizon = horizonFor(scenario, mode);
  const dd = mode === "drawdown" ? {
    retirementMonth: Math.max(1, (scenario.retirementAge - scenario.currentAge) * 12),
    annualWithdrawal: scenario.annualWithdrawal,
  } : null;

  let glideSchedule = null;
  if (scenario.glide) {
    const endP = profiles[scenario.glide.endAsset];
    if (endP) {
      const currentAge = mode === "drawdown"
        ? scenario.currentAge
        : (scenario.glide.glideStartAge);
      // Glide schedule interpolates each profile parameter month by
      // month; supply real μ derived at the current CPI.
      glideSchedule = buildGlideSchedule({
        startProfile: { ...p, mu: realMu(p, cpi) },
        endProfile:   { ...endP, mu: realMu(endP, cpi) },
        currentAge,
        glideStartAge: scenario.glide.glideStartAge,
        glideEndAge: scenario.glide.glideEndAge,
        months: horizon * 12,
      });
    }
  }

  return {
    horizonYears: horizon,
    startingBalance: scenario.startingBalance,
    monthlyContribution: scenario.monthlyContribution,
    mu: realMu(p, cpi),
    sigma_normal: p.sigma_normal,
    sigma_stress: p.sigma_stress,
    p_stay_normal: p.p_stay_normal,
    p_stay_stress: p.p_stay_stress,
    glideSchedule,
    numPaths: TORNADO_PATHS,
    preGenZ: shocks,
    preGenU: uniforms,
    shockStride: stride,
    drawdown: dd,
  };
}

// Median terminal balance metric (for accumulation tornado).
function medianTerminal(sim) {
  return sim.p50[sim.p50.length - 1];
}

// Compute a scenario's outcome metric: median terminal (accumulation)
// or ruin fraction (drawdown).
function runMetric(scenario, profiles, mode, shocks, uniforms, stride) {
  const sim = simulate(buildArgs(scenario, profiles, mode, shocks, uniforms, stride));
  if (mode === "drawdown") return sim.ruinedFraction;
  return medianTerminal(sim);
}

// --- standard tornado --------------------------------------------------

// Thin wrapper around the ladder helper in profiles.js — kept here as
// a stub for backward-compatibility with call sites that used to
// reach for the worker-local flat ladder.
function neighbourAsset(asset, direction) {
  return ladderNeighbour(asset, direction);
}

function standardBars(scenario, profiles, mode, shocks, uniforms, stride, baseline) {
  const bars = [];

  // Monthly contribution: ±20%.
  {
    const baseAmt = scenario.monthlyContribution;
    const upS = { ...scenario, monthlyContribution: baseAmt * 1.2 };
    const downS = { ...scenario, monthlyContribution: baseAmt * 0.8 };
    bars.push({
      key: "monthlyContribution",
      label: "Monthly contribution",
      perturbations: [
        { dir: "+20%", delta: runMetric(upS, profiles, mode, shocks, uniforms, stride) - baseline, dollarChange:  baseAmt * 0.2, unit: "/mo" },
        { dir: "-20%", delta: runMetric(downS, profiles, mode, shocks, uniforms, stride) - baseline, dollarChange: -baseAmt * 0.2, unit: "/mo" },
      ],
    });
  }

  // Starting balance: ±20%.
  {
    const baseAmt = scenario.startingBalance;
    const upS = { ...scenario, startingBalance: baseAmt * 1.2 };
    const downS = { ...scenario, startingBalance: baseAmt * 0.8 };
    bars.push({
      key: "startingBalance",
      label: "Starting balance",
      perturbations: [
        { dir: "+20%", delta: runMetric(upS, profiles, mode, shocks, uniforms, stride) - baseline, dollarChange:  baseAmt * 0.2, unit: "" },
        { dir: "-20%", delta: runMetric(downS, profiles, mode, shocks, uniforms, stride) - baseline, dollarChange: -baseAmt * 0.2, unit: "" },
      ],
    });
  }

  if (mode === "accumulation") {
    const upH = scenario.horizonYears + 5;
    const downH = Math.max(5, scenario.horizonYears - 5);
    const upS = { ...scenario, horizonYears: upH };
    const downS = { ...scenario, horizonYears: downH };
    bars.push({
      key: "horizonYears",
      label: "Time horizon",
      perturbations: [
        { dir: "+5y", delta: runMetric(upS, profiles, mode, shocks, uniforms, stride) - baseline },
        { dir: "-5y", delta: runMetric(downS, profiles, mode, shocks, uniforms, stride) - baseline },
      ],
    });
  } else {
    // Retirement age: ±3 years.
    const upS = { ...scenario, retirementAge: scenario.retirementAge + 3 };
    const downS = { ...scenario, retirementAge: Math.max(scenario.currentAge + 1, scenario.retirementAge - 3) };
    bars.push({
      key: "retirementAge",
      label: "Retirement age",
      perturbations: [
        { dir: "+3y", delta: runMetric(upS, profiles, mode, shocks, uniforms, stride) - baseline },
        { dir: "-3y", delta: runMetric(downS, profiles, mode, shocks, uniforms, stride) - baseline },
      ],
    });

    // Annual withdrawal: ±20%.
    const baseW = scenario.annualWithdrawal;
    const upW = { ...scenario, annualWithdrawal: baseW * 1.2 };
    const downW = { ...scenario, annualWithdrawal: baseW * 0.8 };
    bars.push({
      key: "annualWithdrawal",
      label: "Annual withdrawal",
      perturbations: [
        { dir: "+20%", delta: runMetric(upW, profiles, mode, shocks, uniforms, stride) - baseline, dollarChange:  baseW * 0.2, unit: "" },
        { dir: "-20%", delta: runMetric(downW, profiles, mode, shocks, uniforms, stride) - baseline, dollarChange: -baseW * 0.2, unit: "" },
      ],
    });
  }

  // Asset class: ±1 step on the ladder. Omitted under a glide path
  // (±1-step is ill-defined) or when the selected asset is off-ladder
  // (Residential Property — not part of the diversified risk ladder).
  if (!scenario.glide && rungOf(scenario.asset) !== null) {
    const upAsset = neighbourAsset(scenario.asset, "up");
    const downAsset = neighbourAsset(scenario.asset, "down");
    const perturbations = [];
    if (upAsset) {
      perturbations.push({
        dir: `→ ${upAsset}`,
        delta: runMetric({ ...scenario, asset: upAsset }, profiles, mode, shocks, uniforms, stride) - baseline,
      });
    }
    if (downAsset) {
      perturbations.push({
        dir: `→ ${downAsset}`,
        delta: runMetric({ ...scenario, asset: downAsset }, profiles, mode, shocks, uniforms, stride) - baseline,
      });
    }
    bars.push({ key: "asset", label: "Asset class", perturbations });
  }

  bars.sort((a, b) => {
    const A = a.perturbations.reduce((s, p) => s + Math.abs(p.delta), 0);
    const B = b.perturbations.reduce((s, p) => s + Math.abs(p.delta), 0);
    return B - A;
  });

  return bars;
}

// --- goal-seek tornado -------------------------------------------------

// Binary search for the smallest positive delta in [0, maxPct] that makes
// the new ruin probability ≤ target. `apply(delta)` builds the perturbed
// scenario. Returns { found, change } where change is the delta or maxPct
// if unsolvable.
function searchContinuous({ apply, profiles, mode, shocks, uniforms, stride, target, maxPct }) {
  const evalAt = (d) => runMetric(apply(d), profiles, mode, shocks, uniforms, stride);
  // First check the bound — if even the max doesn't reach target, mark
  // insufficient.
  if (evalAt(maxPct) > target) return { found: false, change: maxPct };
  // Binary search on [0, maxPct].
  let lo = 0, hi = maxPct;
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    if (evalAt(mid) <= target) hi = mid;
    else lo = mid;
  }
  return { found: true, change: hi };
}

// Step through integer years for retirement age delay.
function searchYears({ apply, profiles, mode, shocks, uniforms, stride, target, maxYears }) {
  for (let d = 0; d <= maxYears; d++) {
    if (runMetric(apply(d), profiles, mode, shocks, uniforms, stride) <= target) {
      return { found: true, change: d };
    }
  }
  return { found: false, change: maxYears };
}

// Goal-seek across the rung-based risk ladder. We step by rung
// (never between sibling variants of the same rung, since that's a
// null move on risk), and when the current asset is off-ladder
// (Residential Property) the search is skipped altogether. The step
// magnitude reported is rung-distance, so a Balanced→High Growth
// move counts as 2 rungs regardless of which sibling lands.
function searchAsset({ scenario, profiles, mode, shocks, uniforms, stride, target }) {
  const pos = rungOf(scenario.asset);
  if (!pos) return { found: false, change: 0, fromAsset: scenario.asset };
  // Candidate rung shifts, ordered by absolute distance from current.
  const shifts = [];
  for (let d = 1; d < RISK_RUNGS.length; d++) {
    if (pos.rungIndex + d < RISK_RUNGS.length) shifts.push(+d);
    if (pos.rungIndex - d >= 0) shifts.push(-d);
  }
  shifts.sort((a, b) => Math.abs(a) - Math.abs(b));
  for (const step of shifts) {
    const rung = RISK_RUNGS[pos.rungIndex + step];
    // Preserve sibling flavour (income vs growth) by variant index.
    const v = Math.min(pos.variantIndex, rung.assets.length - 1);
    const asset = rung.assets[v];
    if (runMetric({ ...scenario, asset }, profiles, mode, shocks, uniforms, stride) <= target) {
      return { found: true, change: step, toAsset: asset, fromAsset: scenario.asset };
    }
  }
  return { found: false, change: 0, fromAsset: scenario.asset };
}

function goalSeekBars(scenario, profiles, mode, shocks, uniforms, stride, target) {
  const bars = [];

  // Monthly contribution: increase up to +100%.
  {
    const r = searchContinuous({
      apply: (d) => ({ ...scenario, monthlyContribution: scenario.monthlyContribution * (1 + d) }),
      profiles, mode, shocks, uniforms, stride, target, maxPct: 1.0,
    });
    bars.push({
      key: "monthlyContribution",
      label: "Monthly contribution",
      kind: "pct",
      direction: "+",
      change: r.change,
      dollarChange: scenario.monthlyContribution * r.change,
      unit: "/mo",
      insufficient: !r.found,
    });
  }

  // Retirement age: delay by up to +10 years.
  {
    const r = searchYears({
      apply: (d) => ({ ...scenario, retirementAge: scenario.retirementAge + d }),
      profiles, mode, shocks, uniforms, stride, target, maxYears: 10,
    });
    bars.push({
      key: "retirementAge",
      label: "Retirement age",
      kind: "years",
      direction: "+",
      change: r.change,
      insufficient: !r.found,
    });
  }

  // Annual withdrawal: reduce by up to -50%.
  {
    const r = searchContinuous({
      apply: (d) => ({ ...scenario, annualWithdrawal: scenario.annualWithdrawal * (1 - d) }),
      profiles, mode, shocks, uniforms, stride, target, maxPct: 0.5,
    });
    bars.push({
      key: "annualWithdrawal",
      label: "Annual withdrawal",
      kind: "pct",
      direction: "-",
      change: r.change,
      dollarChange: -scenario.annualWithdrawal * r.change,
      unit: "",
      insufficient: !r.found,
    });
  }

  // Asset class: smallest step in either direction. Omitted under a
  // glide path (single asset class isn't held throughout).
  if (!scenario.glide && rungOf(scenario.asset) !== null) {
    const r = searchAsset({ scenario, profiles, mode, shocks, uniforms, stride, target });
    bars.push({
      key: "asset",
      label: "Asset class",
      kind: "asset",
      direction: r.change >= 0 ? "+" : "-",
      change: r.change,
      fromAsset: r.fromAsset,
      toAsset: r.toAsset || null,
      insufficient: !r.found,
    });
  }

  function severity(b) {
    if (b.insufficient) return Infinity;
    if (b.kind === "pct") return b.change;
    if (b.kind === "years") return b.change / 10;
    if (b.kind === "asset") return Math.abs(b.change) / RISK_RUNGS.length;
    return 1;
  }
  bars.sort((a, b) => severity(a) - severity(b));

  return bars;
}

// --- worker entry point ------------------------------------------------

self.addEventListener("message", (ev) => {
  const { id, params } = ev.data;
  try {
    const result = compute(params);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
});

function compute(params) {
  const { scenario, profiles, mode, targetRuin, canonicalRuin, cpi } = params;
  currentCpi = (typeof cpi === "number" && Number.isFinite(cpi)) ? cpi : 0.025;

  // Size shocks for the longest perturbation horizon.
  // - Accumulation: horizon ±5 years → +5y
  // - Drawdown: horizon fixed by (endAge - currentAge); retirement age
  //   shifts don't change months.
  const baseHorizon = horizonFor(scenario, mode);
  const maxHorizon = mode === "accumulation" ? baseHorizon + 5 : baseHorizon;
  const stride = maxHorizon * 12;
  const shocks = generateShocks(TORNADO_PATHS, stride);
  const uniforms = generateUniforms(TORNADO_PATHS, stride);

  // Baseline metric & ruin from this worker's 1000-path sim.
  const baselineSim = simulate(buildArgs(scenario, profiles, mode, shocks, uniforms, stride));
  const baseline = mode === "drawdown" ? baselineSim.ruinedFraction : medianTerminal(baselineSim);
  const baselineRuin = baselineSim.ruinedFraction;

  // State decision must use the SAME ruin probability the subtitle
  // displays — the main 2000-path canonicalRuin when supplied. The
  // worker's own 1000-path baselineRuin is only used as a fallback.
  const decisionRuin = (canonicalRuin != null) ? canonicalRuin : baselineRuin;
  const goalSeek = mode === "drawdown" && decisionRuin > targetRuin;

  let bars;
  if (goalSeek) {
    bars = goalSeekBars(scenario, profiles, mode, shocks, uniforms, stride, targetRuin);
  } else {
    bars = standardBars(scenario, profiles, mode, shocks, uniforms, stride, baseline);
  }

  return {
    mode: goalSeek ? "goal-seek" : "standard",
    chartMode: mode,
    baseline,
    baselineRuin,
    targetRuin,
    bars,
    allInsufficient: goalSeek && bars.every((b) => b.insufficient),
    glideActive: !!scenario.glide,
  };
}
