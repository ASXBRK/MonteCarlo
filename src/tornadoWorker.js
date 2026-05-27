// Tornado worker: runs perturbation sims off the main thread.
// Receives a scenario + profiles snapshot, returns either standard
// tornado bars (signed metric deltas) or goal-seek tornado bars
// (minimum input changes that hit the target ruin probability).

import { simulate, generateShocks, generateUniforms } from "./sim.js";

const TORNADO_PATHS = 1000;

const RISK_LADDER = [
  "Cash", "Conservative", "Balanced", "Growth",
  "High Growth", "Australian Shares", "Emerging Markets",
];

// Resolve a horizon (in years) for a candidate scenario in either mode.
function horizonFor(scenario, mode) {
  if (mode === "drawdown") {
    return Math.max(1, scenario.endAge - scenario.currentAge);
  }
  return scenario.horizonYears;
}

// Build the simulate() args for a candidate scenario, reusing shared
// shocks at the given stride (in months).
function buildArgs(scenario, profiles, mode, shocks, uniforms, stride) {
  const p = profiles[scenario.asset];
  const horizon = horizonFor(scenario, mode);
  const dd = mode === "drawdown" ? {
    retirementMonth: Math.max(1, (scenario.retirementAge - scenario.currentAge) * 12),
    annualWithdrawal: scenario.annualWithdrawal,
  } : null;
  return {
    horizonYears: horizon,
    startingBalance: scenario.startingBalance,
    monthlyContribution: scenario.monthlyContribution,
    mu: p.mu,
    sigma_normal: p.sigma_normal,
    sigma_stress: p.sigma_stress,
    p_stay_normal: p.p_stay_normal,
    p_stay_stress: p.p_stay_stress,
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

function neighbourAsset(asset, direction) {
  const idx = RISK_LADDER.indexOf(asset);
  if (idx === -1) return null;
  const next = direction === "up" ? idx + 1 : idx - 1;
  if (next < 0 || next >= RISK_LADDER.length) return null;
  return RISK_LADDER[next];
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

  // Asset class: ±1 step on the ladder.
  {
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

// Search the asset-class ladder in both directions; pick the smallest
// |step| that meets the target.
function searchAsset({ scenario, profiles, mode, shocks, uniforms, stride, target }) {
  const startIdx = RISK_LADDER.indexOf(scenario.asset);
  if (startIdx === -1) return { found: false, change: 0, fromAsset: scenario.asset };
  // Generate candidates ordered by absolute step from current.
  const candidates = [];
  for (let step = 1; step < RISK_LADDER.length; step++) {
    if (startIdx + step < RISK_LADDER.length) candidates.push(+step);
    if (startIdx - step >= 0) candidates.push(-step);
  }
  candidates.sort((a, b) => Math.abs(a) - Math.abs(b));
  for (const step of candidates) {
    const asset = RISK_LADDER[startIdx + step];
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

  // Asset class: smallest step in either direction.
  {
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
    if (b.kind === "asset") return Math.abs(b.change) / RISK_LADDER.length;
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
  const { scenario, profiles, mode, targetRuin, canonicalRuin } = params;

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
  };
}
