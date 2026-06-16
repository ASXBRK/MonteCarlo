// Drawdown-tolerance lens.
//
// Derives per-path max peak-to-trough decline (yearly snapshots, so
// intra-year troughs are missed and true max drawdowns are slightly
// understated — disclosed in the panel footer). Shows the distribution
// of max drawdowns and the share of paths whose worst drawdown exceeds
// the user's tolerance.
//
// The tolerance input lives inside the panel itself. Changes to it
// re-threshold the CACHED maxDrawdown array — no resim, no worker call.

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
let cachedMaxDD = null;        // Float64Array of per-path max DDs (real-terms)
let lastBins = null;           // cached histogram bins for re-render
let onToleranceChange = null;  // callback set by main.js

// Compute max peak-to-trough drawdown per path from yearly snapshots.
export function computeMaxDrawdowns(sim) {
  const { paths, numPaths, years } = sim;
  const out = new Float64Array(numPaths);
  for (let p = 0; p < numPaths; p++) {
    const base = p * years;
    let peak = paths[base];
    let maxDD = 0;
    for (let y = 0; y < years; y++) {
      const v = paths[base + y];
      if (v > peak) peak = v;
      if (peak > 0) {
        const dd = (peak - v) / peak;
        if (dd > maxDD) maxDD = dd;
      }
    }
    out[p] = maxDD;
  }
  return out;
}

function quantile(sortedArr, q) {
  const n = sortedArr.length;
  if (n === 0) return 0;
  const pos = q * (n - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (pos - lo);
}

function makeBins(maxDD, binCount = 20) {
  let max = 0;
  for (let i = 0; i < maxDD.length; i++) if (maxDD[i] > max) max = maxDD[i];
  if (max < 0.05) max = 0.05; // sane floor for tiny-dispersion scenarios
  // Round max up to next 5% so bin edges stay clean.
  max = Math.ceil(max * 20) / 20;
  const binWidth = max / binCount;
  const counts = new Array(binCount).fill(0);
  for (let i = 0; i < maxDD.length; i++) {
    let b = Math.floor(maxDD[i] / binWidth);
    if (b >= binCount) b = binCount - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  const centres = counts.map((_, i) => (i + 0.5) * binWidth);
  return { binWidth, counts, centres, max };
}

function ensurePanel(container) {
  if (panelEl && panelEl.isConnected) return panelEl;
  panelEl = document.createElement("section");
  panelEl.className = "ddtol";
  panelEl.innerHTML = `
    <header class="ddtol-header">
      <h3 class="ddtol-title">Could you sit through it?</h3>
      <p class="ddtol-subtitle">Every simulated market has a worst moment. Set the largest peak-to-trough loss you'd hold through before selling, and see how often this scenario crosses that line.</p>
    </header>
    <div class="ddtol-controls">
      <label class="ddtol-control">
        <span>Largest drawdown you'd hold through</span>
        <span class="ddtol-input-wrap">
          <input id="ddtolInput" type="number" min="5" max="95" step="1" value="35" />
          <span>%</span>
        </span>
      </label>
    </div>
    <div class="ddtol-body">
      <div class="ddtol-chart" id="ddtolChart"></div>
      <aside class="ddtol-stats" data-role="ddstats"></aside>
    </div>
    <p class="ddtol-headline" data-role="ddheadline"></p>
    <p class="ddtol-footer">Drawdowns measured from yearly snapshots; intra-year troughs are not captured, so figures slightly understate true peak-to-trough losses.</p>
  `;
  container.appendChild(panelEl);
  panelEl.querySelector("#ddtolInput").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0 && v <= 100 && onToleranceChange) {
      onToleranceChange(v / 100);
    }
  });
  return panelEl;
}

function fmtPct1(x) { return `${(x * 100).toFixed(1)}%`; }
function fmtPct0(x) { return `${Math.round(x * 100)}%`; }

function renderInternal(maxDD, tolerance) {
  const sorted = Array.from(maxDD).sort((a, b) => a - b);
  const p50 = quantile(sorted, 0.50);
  const p95 = quantile(sorted, 0.95);
  let breach = 0;
  for (let i = 0; i < maxDD.length; i++) if (maxDD[i] > tolerance) breach++;
  const breachShare = breach / maxDD.length;

  // Histogram. Bars below tolerance in green-tinged colour; above in
  // amber-red. Threshold line at tolerance.
  if (!lastBins) lastBins = makeBins(maxDD);
  const { centres, counts, binWidth, max } = lastBins;

  const barColours = centres.map((c) => c > tolerance ? "rgb(200, 80, 60)" : "rgb(80, 130, 90)");

  const data = [
    {
      type: "bar",
      x: centres,
      y: counts,
      width: counts.map(() => binWidth * 0.95),
      marker: { color: barColours },
      hovertemplate: "%{x:.0%} drawdown · %{y} paths<extra></extra>",
    },
  ];

  const layout = {
    margin: { l: 50, r: 16, t: 10, b: 36 },
    height: 200,
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    showlegend: false,
    hovermode: "x",
    hoverlabel: HOVER_LABEL,
    bargap: 0.05,
    shapes: [
      {
        type: "line", xref: "x", yref: "paper",
        x0: tolerance, x1: tolerance, y0: 0, y1: 1,
        line: { color: "rgba(40,40,40,0.75)", width: 1.5, dash: "dash" },
      },
    ],
    annotations: [
      {
        x: tolerance, xref: "x", y: 1, yref: "paper",
        text: `Tolerance ${fmtPct0(tolerance)}`,
        showarrow: false, xanchor: tolerance > max * 0.85 ? "right" : "left",
        yanchor: "bottom", xshift: tolerance > max * 0.85 ? -4 : 4,
        font: { size: 11, color: "rgba(40,40,40,0.85)" },
      },
    ],
    xaxis: {
      title: { text: "Worst peak-to-trough drawdown", standoff: 6 },
      tickformat: ".0%",
      showgrid: false, zeroline: false,
      range: [0, max],
    },
    yaxis: {
      title: { text: "Paths", standoff: 6 },
      gridcolor: "rgba(0,0,0,0.06)",
      zeroline: false,
    },
    font: PLOTLY_FONT,
  };
  Plotly.react("ddtolChart", data, layout, { displayModeBar: false, responsive: true });

  const statsEl = panelEl.querySelector('[data-role="ddstats"]');
  statsEl.innerHTML = `
    <dl class="ddtol-stats-list">
      <dt>Median worst drawdown</dt><dd>${fmtPct1(p50)}</dd>
      <dt>95th percentile worst drawdown</dt><dd>${fmtPct1(p95)}</dd>
      <dt>Paths breaching tolerance</dt><dd>${breach.toLocaleString("en-US")} / ${maxDD.length.toLocaleString("en-US")}</dd>
    </dl>
  `;

  const headlineEl = panelEl.querySelector('[data-role="ddheadline"]');
  if (breachShare === 0) {
    headlineEl.innerHTML = `In <strong>none</strong> of the simulated markets does this portfolio fall ${fmtPct0(tolerance)} or more peak-to-trough.`;
  } else {
    headlineEl.innerHTML = `In <strong>${fmtPct1(breachShare)}</strong> of simulated markets this portfolio falls at least <strong>${fmtPct0(tolerance)}</strong> peak-to-trough at some point — the moment most likely to trigger selling.`;
  }
}

export function drawdownToleranceShow(container, params) {
  // params: { sim, tolerance, onChange }
  ensurePanel(container);
  onToleranceChange = params.onChange;
  cachedMaxDD = params.maxDD;
  lastBins = makeBins(cachedMaxDD);
  panelEl.querySelector("#ddtolInput").value = Math.round(params.tolerance * 100);
  renderInternal(cachedMaxDD, params.tolerance);
}

// Re-threshold against the cached maxDD using a new tolerance — no
// new sim, no histogram rebuild (bins are stable across tolerance).
export function drawdownToleranceUpdateTolerance(tolerance) {
  if (!panelEl || !cachedMaxDD) return;
  renderInternal(cachedMaxDD, tolerance);
}

export function drawdownToleranceHide(container) {
  if (panelEl && panelEl.isConnected) panelEl.remove();
  panelEl = null;
  cachedMaxDD = null;
  lastBins = null;
  onToleranceChange = null;
}
