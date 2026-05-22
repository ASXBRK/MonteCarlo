// Plotly wiring. Aggregates already happened in sim; we just shape traces.

const COLOURS = {
  band95: "rgba(56, 132, 224, 0.12)",
  band75: "rgba(56, 132, 224, 0.28)",
  median: "rgb(28, 90, 180)",
  sample: "rgba(80, 80, 80, 0.15)",
  deterministic: "rgb(220, 90, 40)",
};

// Compare-mode palette. The colours are spec-fixed.
const COMPARE = {
  A: { line: "#1f77b4", band: "rgba(31, 119, 180, 0.18)" },
  B: { line: "#ff7f0e", band: "rgba(255, 127, 14, 0.18)" },
  prob: "rgb(60, 60, 70)",
};

// Trace order matters: the first SAMPLE_PATH_COUNT traces are the
// overlay paths, restyled in place by the animation tick. Don't
// reorder without updating SAMPLE_TRACE_INDICES below.
export const SAMPLE_PATH_COUNT = 30;
export const sampleTraceIndices = () =>
  Array.from({ length: SAMPLE_PATH_COUNT }, (_, i) => i);

function buildSingleTraces(sim) {
  const { xYears, p05, p25, p50, p75, p95, deterministic, sampled } = sim;
  const traces = [];

  for (let i = 0; i < sampled.length; i++) {
    traces.push({
      x: xYears, y: sampled[i],
      mode: "lines", type: "scatter",
      line: { color: COLOURS.sample, width: 1 },
      hoverinfo: "skip", showlegend: false,
    });
  }

  // p5-p95 outer band (lighter). Lower edge is hover-skipped; upper
  // edge carries the band's hover row, with customdata pointing at the
  // lower edge so the tooltip shows "low – high" on one line.
  traces.push({
    x: xYears, y: p05,
    mode: "lines", type: "scatter",
    line: { color: "rgba(0,0,0,0)", width: 0 },
    hoverinfo: "skip", showlegend: false,
  });
  traces.push({
    x: xYears, y: p95, customdata: p05,
    mode: "lines", type: "scatter",
    line: { color: "rgba(0,0,0,0)", width: 0 },
    fill: "tonexty", fillcolor: COLOURS.band95,
    name: "90% likely",
    hovertemplate: "<b>90% likely</b>  %{customdata:$,.0f} – %{y:$,.0f}<extra></extra>",
  });

  // p25-p75 inner band (darker).
  traces.push({
    x: xYears, y: p25,
    mode: "lines", type: "scatter",
    line: { color: "rgba(0,0,0,0)", width: 0 },
    hoverinfo: "skip", showlegend: false,
  });
  traces.push({
    x: xYears, y: p75, customdata: p25,
    mode: "lines", type: "scatter",
    line: { color: "rgba(0,0,0,0)", width: 0 },
    fill: "tonexty", fillcolor: COLOURS.band75,
    name: "50% likely",
    hovertemplate: "<b>50% likely</b>  %{customdata:$,.0f} – %{y:$,.0f}<extra></extra>",
  });

  traces.push({
    x: xYears, y: p50,
    mode: "lines", type: "scatter",
    line: { color: COLOURS.median, width: 2.5 },
    name: "Median",
    hovertemplate: "<b>Median</b>  %{y:$,.0f}<extra></extra>",
  });

  traces.push({
    x: xYears, y: deterministic,
    mode: "lines", type: "scatter",
    line: { color: COLOURS.deterministic, width: 2.25, dash: "dash" },
    name: "Steady return",
    hovertemplate: "<b>Steady return</b>  %{y:$,.0f}<extra></extra>",
  });

  return traces;
}

// Compare-mode fan chart: only p5–p95 band + median for each scenario.
function buildCompareTraces(sims, names) {
  const traces = [];
  const order = ["A", "B"];

  for (const id of order) {
    const sim = sims[id];
    const c = COMPARE[id];
    const label = names[id];

    // p5 (invisible lower edge, hover-skipped)
    traces.push({
      x: sim.xYears, y: sim.p05,
      mode: "lines", type: "scatter",
      line: { color: "rgba(0,0,0,0)", width: 0 },
      hoverinfo: "skip", showlegend: false,
    });
    // p95 (fill to previous, carries the band's hover row)
    traces.push({
      x: sim.xYears, y: sim.p95, customdata: sim.p05,
      mode: "lines", type: "scatter",
      line: { color: "rgba(0,0,0,0)", width: 0 },
      fill: "tonexty", fillcolor: c.band,
      name: `${label} · 90% likely`,
      hovertemplate: `<b>${label} · 90% likely</b>  %{customdata:$,.0f} – %{y:$,.0f}<extra></extra>`,
    });
  }

  // Medians on top of both bands.
  for (const id of order) {
    const sim = sims[id];
    const c = COMPARE[id];
    const label = names[id];
    traces.push({
      x: sim.xYears, y: sim.p50,
      mode: "lines", type: "scatter",
      line: { color: c.line, width: 2.75 },
      name: `${label} · Median`,
      hovertemplate: `<b>${label} · Median</b>  %{y:$,.0f}<extra></extra>`,
    });
  }

  return traces;
}

function buildAxisTicks(horizonYears, currentAge) {
  const desired = 7;
  const stepGuess = horizonYears / (desired - 1);
  const niceSteps = [1, 2, 5, 10];
  let step = niceSteps[0];
  for (const s of niceSteps) if (s <= stepGuess) step = s;
  if (step < 1) step = 1;
  const vals = [];
  for (let y = 0; y <= horizonYears; y += step) vals.push(y);
  if (vals[vals.length - 1] !== horizonYears) vals.push(horizonYears);

  const text = vals.map((y) => {
    if (currentAge == null) return `Year ${y}`;
    return `Year ${y}<br><span style="font-size:10px;opacity:0.7">Age ${currentAge + y}</span>`;
  });
  return { vals, text };
}

const BASE_FONT = {
  family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  size: 13, color: "#222",
};

const HOVER_LABEL = {
  bgcolor: "white",
  bordercolor: "rgba(0,0,0,0.08)",
  font: { ...BASE_FONT },
  align: "left",
};

// Returns the retirement marker line + shaded post-retirement region
// to add to a fan chart's layout when drawdown is active.
function drawdownShapesAndAnnotations({ retirementYear, horizonYears, yMax }) {
  if (retirementYear == null || retirementYear <= 0 || retirementYear >= horizonYears) {
    return { shapes: [], annotations: [] };
  }
  return {
    shapes: [
      // Shaded post-retirement region.
      {
        type: "rect", xref: "x", yref: "paper",
        x0: retirementYear, x1: horizonYears, y0: 0, y1: 1,
        fillcolor: "rgba(120, 110, 90, 0.06)",
        line: { width: 0 },
        layer: "below",
      },
      // Vertical dashed line at retirement.
      {
        type: "line", xref: "x", yref: "paper",
        x0: retirementYear, x1: retirementYear, y0: 0, y1: 1,
        line: { color: "rgba(80, 70, 50, 0.55)", width: 1.25, dash: "dash" },
        layer: "above",
      },
    ],
    annotations: [
      {
        x: retirementYear, xref: "x",
        y: 1, yref: "paper",
        yanchor: "bottom", xanchor: "center",
        text: "Retirement",
        showarrow: false,
        font: { size: 11, color: "rgba(80, 70, 50, 0.85)" },
        bgcolor: "rgba(255,255,255,0.8)",
        borderpad: 2,
      },
    ],
  };
}

// Render single-scenario fan chart. The y-axis is locked to the bulk
// of outcomes (~p95 of terminal year). Individual sample paths that
// exceed this ceiling get clipped at the top edge — that's intentional;
// it keeps the chart's central story stable as paths rotate.
export function renderChart(containerId, sim, { horizonYears, currentAge, retirementYear = null }) {
  const data = buildSingleTraces(sim);
  const ticks = buildAxisTicks(horizonYears, currentAge);
  // Cap y-axis off the bulk of the distribution including drawdown.
  // Use the max p95 across all years so the chart doesn't shrink when
  // the terminal p95 drops below the pre-retirement peak.
  let p95Peak = 0;
  for (const v of sim.p95) if (v > p95Peak) p95Peak = v;
  const yMax = (p95Peak || 1) * 1.05;
  const { shapes, annotations } = drawdownShapesAndAnnotations({
    retirementYear, horizonYears, yMax,
  });

  const layout = {
    margin: { l: 70, r: 20, t: 30, b: 60 },
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    hovermode: "x unified",
    legend: {
      orientation: "h", y: -0.18, x: 0.5, xanchor: "center",
      bgcolor: "rgba(255,255,255,0)",
    },
    xaxis: {
      title: { text: "Time", standoff: 10 },
      tickmode: "array",
      tickvals: ticks.vals,
      ticktext: ticks.text,
      showgrid: false, zeroline: false,
    },
    yaxis: {
      title: { text: "Portfolio value", standoff: 10 },
      tickformat: "$,.2s",
      gridcolor: "rgba(0,0,0,0.06)",
      zeroline: false,
      // autorange must be explicitly false alongside `range`. Without it,
      // Plotly.restyle (used by the overlay animation) triggers an
      // internal recompute that overrides the explicit range.
      autorange: false,
      range: [0, yMax],
    },
    shapes,
    annotations,
    font: BASE_FONT,
    hoverlabel: HOVER_LABEL,
  };

  Plotly.react(containerId, data, layout, { displayModeBar: false, responsive: true });
}

// Render compare-mode fan chart (4 visual elements: 2 bands + 2 medians).
export function renderCompareChart(containerId, sims, { horizonYears, currentAge, names, retirementYear = null }) {
  const data = buildCompareTraces(sims, names);
  const ticks = buildAxisTicks(horizonYears, currentAge);
  const { shapes, annotations } = drawdownShapesAndAnnotations({
    retirementYear, horizonYears,
  });

  const layout = {
    margin: { l: 70, r: 20, t: 30, b: 60 },
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    hovermode: "x unified",
    legend: {
      orientation: "h", y: -0.18, x: 0.5, xanchor: "center",
      bgcolor: "rgba(255,255,255,0)",
    },
    xaxis: {
      title: { text: "Time", standoff: 10 },
      tickmode: "array",
      tickvals: ticks.vals,
      ticktext: ticks.text,
      showgrid: false, zeroline: false,
    },
    yaxis: {
      title: { text: "Portfolio value", standoff: 10 },
      tickformat: "$,.2s",
      gridcolor: "rgba(0,0,0,0.06)",
      zeroline: false, rangemode: "tozero",
    },
    shapes,
    annotations,
    font: BASE_FONT,
    hoverlabel: HOVER_LABEL,
  };

  Plotly.react(containerId, data, layout, { displayModeBar: false, responsive: true });
}

// Render probability-over-time line chart.
export function renderProbChart(containerId, xYears, probAGreater, { horizonYears, currentAge }) {
  const ticks = buildAxisTicks(horizonYears, currentAge);

  const data = [
    {
      x: xYears,
      y: probAGreater.map((p) => p * 100),
      mode: "lines",
      type: "scatter",
      line: { color: COMPARE.prob, width: 2.25 },
      name: "P(A > B)",
      hovertemplate: "Year %{x} · P(A > B) = %{y:.0f}%<extra></extra>",
    },
  ];

  const layout = {
    margin: { l: 60, r: 20, t: 30, b: 50 },
    height: 200,
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    showlegend: false,
    hovermode: "x unified",
    xaxis: {
      tickmode: "array",
      tickvals: ticks.vals,
      ticktext: ticks.text,
      showgrid: false, zeroline: false,
      range: [0, horizonYears],
    },
    yaxis: {
      title: { text: "Probability", standoff: 8 },
      ticksuffix: "%",
      range: [0, 100],
      gridcolor: "rgba(0,0,0,0.06)",
      zeroline: false,
    },
    shapes: [
      {
        type: "line", xref: "x", yref: "y",
        x0: 0, x1: horizonYears, y0: 50, y1: 50,
        line: { color: "rgba(0,0,0,0.35)", width: 1, dash: "dash" },
      },
    ],
    font: BASE_FONT,
    hoverlabel: HOVER_LABEL,
  };

  Plotly.react(containerId, data, layout, { displayModeBar: false, responsive: true });
}

// Static bell curves overlay for the Parameters modal. One Gaussian
// per profile, centred at μ, width proportional to σ, peak height
// normalised to 1 so shapes are directly comparable.
export function renderBellCurves(containerId, profiles) {
  let xMin = 0, xMax = 0;
  for (const { mu, sigma } of Object.values(profiles)) {
    xMin = Math.min(xMin, (mu - 3 * sigma) * 100);
    xMax = Math.max(xMax, (mu + 3 * sigma) * 100);
  }
  const step = (xMax - xMin) / 240;
  const xs = [];
  for (let x = xMin; x <= xMax; x += step) xs.push(x);

  const palette = ["#6b8e23", "#3a86c9", "#5e60ce", "#1c5ab4", "#dc5a28", "#b5179e", "#9a031e"];

  const traces = Object.entries(profiles).map(([name, { mu, sigma }], i) => {
    const muPct = mu * 100;
    const sigmaPct = sigma * 100;
    const ys = xs.map((x) => Math.exp(-Math.pow(x - muPct, 2) / (2 * sigmaPct * sigmaPct)));
    return {
      x: xs, y: ys,
      mode: "lines", type: "scatter",
      name,
      line: { width: 1.5, color: palette[i % palette.length] },
      hovertemplate: `${name} · μ=${(mu * 100).toFixed(1)}%, σ=${(sigma * 100).toFixed(0)}%<extra></extra>`,
    };
  });

  const layout = {
    margin: { l: 10, r: 10, t: 10, b: 50 },
    height: 220,
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    showlegend: true,
    legend: { orientation: "h", x: 0.5, xanchor: "center", y: -0.12, font: { size: 11 } },
    xaxis: {
      ticksuffix: "%",
      zeroline: true,
      zerolinecolor: "rgba(0,0,0,0.25)",
      zerolinewidth: 1,
      showgrid: false,
      tickfont: { size: 11 },
    },
    yaxis: {
      showticklabels: false,
      showgrid: false,
      zeroline: false,
      range: [0, 1.1],
    },
    font: BASE_FONT,
  };

  Plotly.newPlot(containerId, traces, layout, { displayModeBar: false, responsive: true });
}
