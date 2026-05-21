// Plotly wiring. Aggregates already happened in sim; we just shape traces.

const COLOURS = {
  band95: "rgba(56, 132, 224, 0.12)",   // outer band fill
  band75: "rgba(56, 132, 224, 0.28)",   // inner band fill
  median: "rgb(28, 90, 180)",
  sample: "rgba(80, 80, 80, 0.15)",
  deterministic: "rgb(220, 90, 40)",
};

function buildTraces(sim) {
  const { xYears, p05, p25, p50, p75, p95, deterministic, sampled } = sim;

  const traces = [];

  // Sampled paths first so the bands paint over them where they overlap.
  // We still get visible grey wisps in the outer 5/95 band region.
  for (let i = 0; i < sampled.length; i++) {
    traces.push({
      x: xYears,
      y: sampled[i],
      mode: "lines",
      type: "scatter",
      line: { color: COLOURS.sample, width: 1 },
      hoverinfo: "skip",
      showlegend: false,
    });
  }

  // 5-95 band: invisible lower edge then upper edge with fill='tonexty'.
  traces.push({
    x: xYears, y: p05,
    mode: "lines", type: "scatter",
    line: { color: "rgba(0,0,0,0)", width: 0 },
    hoverinfo: "skip", showlegend: false,
  });
  traces.push({
    x: xYears, y: p95,
    mode: "lines", type: "scatter",
    line: { color: "rgba(0,0,0,0)", width: 0 },
    fill: "tonexty", fillcolor: COLOURS.band95,
    name: "5–95th percentile",
    hovertemplate: "Year %{x} · 95th: %{y:$,.0f}<extra></extra>",
  });

  // 25-75 band.
  traces.push({
    x: xYears, y: p25,
    mode: "lines", type: "scatter",
    line: { color: "rgba(0,0,0,0)", width: 0 },
    hoverinfo: "skip", showlegend: false,
  });
  traces.push({
    x: xYears, y: p75,
    mode: "lines", type: "scatter",
    line: { color: "rgba(0,0,0,0)", width: 0 },
    fill: "tonexty", fillcolor: COLOURS.band75,
    name: "25–75th percentile",
    hovertemplate: "Year %{x} · 75th: %{y:$,.0f}<extra></extra>",
  });

  // Median.
  traces.push({
    x: xYears, y: p50,
    mode: "lines", type: "scatter",
    line: { color: COLOURS.median, width: 2.5 },
    name: "Median (50th)",
    hovertemplate: "Year %{x} · median: %{y:$,.0f}<extra></extra>",
  });

  // Deterministic comparison.
  traces.push({
    x: xYears, y: deterministic,
    mode: "lines", type: "scatter",
    line: { color: COLOURS.deterministic, width: 2.25, dash: "dash" },
    name: "Steady return (no variance)",
    hovertemplate: "Year %{x} · steady: %{y:$,.0f}<extra></extra>",
  });

  return traces;
}

function buildAxisTicks(horizonYears, currentAge) {
  // ~7 ticks across the horizon, including 0 and horizonYears.
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

export function renderChart(containerId, sim, { horizonYears, currentAge }) {
  const data = buildTraces(sim);
  const ticks = buildAxisTicks(horizonYears, currentAge);

  const layout = {
    margin: { l: 70, r: 20, t: 30, b: 60 },
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    hovermode: "x unified",
    legend: {
      orientation: "h",
      y: -0.18,
      x: 0.5,
      xanchor: "center",
      bgcolor: "rgba(255,255,255,0)",
    },
    xaxis: {
      title: { text: "Time", standoff: 10 },
      tickmode: "array",
      tickvals: ticks.vals,
      ticktext: ticks.text,
      showgrid: false,
      zeroline: false,
    },
    yaxis: {
      title: { text: "Portfolio value", standoff: 10 },
      tickformat: "$,.2s",
      gridcolor: "rgba(0,0,0,0.06)",
      zeroline: false,
      rangemode: "tozero",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  };

  const config = {
    displayModeBar: false,
    responsive: true,
  };

  Plotly.react(containerId, data, layout, config);
}
