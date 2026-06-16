// Withdrawal-strategy comparison panel.
//
// Runs three sims (fixed-real, Guyton-Klinger, fixed-pct) on the same
// scenario with paired shocks + uniforms, then plots a tradeoff
// scatter: median lifetime real spending on the x-axis, probability of
// ruin on the y-axis. The strategies appear as three labelled points;
// no single one is marked "best" — different users will weigh ruin
// risk against spending volatility differently.

import { simulate, generateShocks, generateUniforms, NUM_PATHS, buildGlideSchedule } from "./sim.js";

const STRATEGY_DEFS = [
  { value: "fixed-real",     label: "Fixed real",      colour: "#1c5ab4" },
  { value: "guyton-klinger", label: "Guyton-Klinger",  colour: "#6b8e23" },
  { value: "fixed-pct",      label: "Fixed % balance", colour: "#b5179e" },
];

const PLOTLY_FONT = {
  family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  size: 12, color: "#222",
};
const HOVER_LABEL = {
  bgcolor: "white",
  bordercolor: "rgba(0,0,0,0.08)",
  font: { ...PLOTLY_FONT },
  align: "left",
};

let panelEl = null;
let lastInputs = null;

function fmtMoney(v) {
  if (v <= 0) return "$0";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function quantile(arr, q) {
  const a = Array.from(arr).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const pos = q * (a.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function ensurePanel(container) {
  if (panelEl && panelEl.isConnected) return panelEl;
  panelEl = document.createElement("section");
  panelEl.className = "stratcmp";
  panelEl.innerHTML = `
    <header class="stratcmp-header">
      <h3 class="stratcmp-title">Withdrawal strategy tradeoff</h3>
      <p class="stratcmp-subtitle">Three strategies on the same portfolio and the same simulated markets. Lower-left points are safer with less spending; upper-right take more spending for higher ruin risk. No single point is "best" — the tradeoff is yours.</p>
    </header>
    <div class="stratcmp-content">
      <div class="stratcmp-chart" id="stratcmpChart"></div>
      <aside class="stratcmp-stats" data-role="scstats"></aside>
    </div>
  `;
  container.appendChild(panelEl);
  return panelEl;
}

function buildSchedule(s, profiles, currentAge, months) {
  if (!s.glide) return null;
  const start = profiles[s.asset];
  const end = profiles[s.glide.endAsset];
  if (!end) return null;
  return buildGlideSchedule({
    startProfile: start, endProfile: end, currentAge,
    glideStartAge: s.glide.glideStartAge,
    glideEndAge: s.glide.glideEndAge,
    months,
  });
}

function runStrategy(scenario, profiles, strategy, shocks, uniforms, displayCtx) {
  const horizon = Math.max(1, scenario.endAge - scenario.currentAge);
  const months = horizon * 12;
  const p = profiles[scenario.asset];
  const glideSchedule = buildSchedule(scenario, profiles, scenario.currentAge, months);
  const sim = simulate({
    horizonYears: horizon,
    startingBalance: scenario.startingBalance,
    monthlyContribution: scenario.monthlyContribution,
    mu: p.mu,
    sigma_normal: p.sigma_normal,
    sigma_stress: p.sigma_stress,
    p_stay_normal: p.p_stay_normal,
    p_stay_stress: p.p_stay_stress,
    glideSchedule,
    preGenZ: shocks,
    preGenU: uniforms,
    drawdown: {
      retirementMonth: Math.max(1, (scenario.retirementAge - scenario.currentAge) * 12),
      annualWithdrawal: scenario.annualWithdrawal,
      strategy,
    },
  });

  // Convert per-path totals to displayed units. Total spending is the
  // sum of monthly withdrawals across all years; in nominal display
  // each year's withdrawal compounds with inflation. Approximate by
  // scaling the total by an "average factor" — annuity sum / horizon.
  // Cheaper than tracking each year separately and good enough for
  // the tradeoff plot's relative ordering.
  let totalScale = 1;
  if (displayCtx.units === "nominal") {
    let s2 = 0;
    for (let y = 0; y < horizon; y++) s2 += Math.pow(1 + displayCtx.inflation, y);
    totalScale = s2 / horizon;
  }

  const medianSpend = quantile(sim.totalSpending, 0.5) * totalScale;
  const p95Cut = quantile(sim.worstYearCut, 0.95);
  return {
    strategy,
    ruin: sim.ruinedFraction,
    medianSpend,
    p95Cut,
  };
}

export function strategyCompareShow(container, params) {
  // params: { scenario, profiles, displayCtx }
  ensurePanel(container);
  const { scenario, profiles, displayCtx } = params;
  if (!scenario || scenario.endAge <= scenario.currentAge) { strategyCompareHide(container); return; }
  lastInputs = { scenario: { ...scenario }, profiles, displayCtx };

  const horizon = Math.max(1, scenario.endAge - scenario.currentAge);
  const months = horizon * 12;
  // Shared shocks across the three strategy runs so the only thing
  // varying is the strategy itself.
  const shocks = generateShocks(NUM_PATHS, months);
  const uniforms = generateUniforms(NUM_PATHS, months);

  const results = STRATEGY_DEFS.map((s) =>
    Object.assign(
      { def: s },
      runStrategy(scenario, profiles, s.value, shocks, uniforms, displayCtx),
    )
  );

  // Plotly scatter. One trace per strategy so each gets its own colour
  // and hover label.
  const traces = results.map((r) => ({
    x: [r.medianSpend],
    y: [r.ruin * 100],
    mode: "markers+text",
    type: "scatter",
    name: r.def.label,
    text: [r.def.label],
    textposition: "top center",
    textfont: { size: 11, color: r.def.colour, family: PLOTLY_FONT.family },
    marker: { size: 14, color: r.def.colour, line: { color: "white", width: 2 } },
    hovertemplate:
      `<b>${r.def.label}</b><br>` +
      `Ruin probability %{y:.1f}%<br>` +
      `Median lifetime spending %{x:$,.0f}<br>` +
      `<extra></extra>`,
    showlegend: false,
  }));

  // X range padded on both sides.
  const xs = results.map((r) => r.medianSpend);
  const xMin = Math.min(...xs) * 0.9;
  const xMax = Math.max(...xs) * 1.10;
  const yMax = Math.max(0.05, Math.max(...results.map((r) => r.ruin)) * 1.5) * 100;

  const layout = {
    margin: { l: 60, r: 30, t: 30, b: 50 },
    height: 280,
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    hoverlabel: HOVER_LABEL,
    showlegend: false,
    xaxis: {
      title: { text: "Median lifetime real spending →", standoff: 8 },
      tickformat: "$,.2s",
      range: [xMin, xMax],
      gridcolor: "rgba(0,0,0,0.06)",
      zeroline: false,
    },
    yaxis: {
      title: { text: "Probability of ruin", standoff: 8 },
      ticksuffix: "%",
      range: [0, yMax],
      gridcolor: "rgba(0,0,0,0.06)",
      zeroline: false,
    },
    font: PLOTLY_FONT,
  };
  Plotly.react("stratcmpChart", traces, layout, { displayModeBar: false, responsive: true });

  // Stats list to the right.
  const statsEl = panelEl.querySelector('[data-role="scstats"]');
  statsEl.innerHTML = results.map((r) => `
    <div class="stratcmp-stat" style="border-left-color:${r.def.colour}">
      <div class="stratcmp-stat-name">${r.def.label}</div>
      <dl>
        <dt>Ruin probability</dt><dd>${(r.ruin * 100).toFixed(1)}%</dd>
        <dt>Median lifetime spending</dt><dd>${fmtMoney(r.medianSpend)}</dd>
        <dt>p95 worst-year cut</dt><dd>${(r.p95Cut * 100).toFixed(0)}%</dd>
      </dl>
    </div>
  `).join("");
}

export function strategyCompareHide(container) {
  if (panelEl && panelEl.isConnected) panelEl.remove();
  panelEl = null;
  lastInputs = null;
}

export function strategyCompareRedisplay(displayCtx) {
  if (!lastInputs) return;
  // Re-run is needed because the display scaling affects the spending
  // x-axis values. Cheap (~3 × 200ms at most) but does reshuffle shocks
  // — that's acceptable for an "explore strategies" panel; the user
  // isn't comparing the bars to the main chart's exact paths.
  strategyCompareShow(panelEl.parentNode, { ...lastInputs, displayCtx });
}
