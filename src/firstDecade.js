// Conditional-outcome panel keyed by first-decade pure return.
// Buckets the cached 2000 sim paths into quintiles by their first-decade
// annualised market return, then overlays each quintile's conditional
// median path on the chart's x-axis. Beneath the chart, per-quintile
// outcome chips show the conditional ruin % (drawdown) or conditional
// median terminal balance (accumulation).
//
// Static visual. No animation. Reads from cached sim only — units
// toggle re-renders without resimulating.

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

// Five-stop ramp from worst (deep red) → best (deep green).
const QUINTILE_COLOURS = [
  "rgb(180, 50, 50)",
  "rgb(220, 130, 60)",
  "rgb(180, 165, 60)",
  "rgb(110, 165, 80)",
  "rgb(45, 130, 70)",
];
const QUINTILE_LABELS = [
  "Worst 20%", "20–40%", "40–60%", "60–80%", "Best 20%",
];

let panelEl = null;
let lastRendered = null; // { sim, retirementYear, displayCtx, mode }

function fmtMoney(v) {
  if (v <= 0) return "$0";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

// Build five buckets of path indices ordered by first-decade return.
function bucketQuintiles(firstDecadeReturn, numPaths) {
  const order = Array.from({ length: numPaths }, (_, i) => i);
  order.sort((a, b) => firstDecadeReturn[a] - firstDecadeReturn[b]);
  const size = Math.floor(numPaths / 5);
  const buckets = [];
  for (let q = 0; q < 5; q++) {
    const start = q * size;
    const end = q === 4 ? numPaths : start + size;
    buckets.push(order.slice(start, end));
  }
  return buckets;
}

// Per-quintile median balance at each year — used to plot the
// conditional median line.
function quintileMedian(sim, bucket) {
  const path = new Array(sim.years);
  const tmp = new Float64Array(bucket.length);
  for (let y = 0; y < sim.years; y++) {
    for (let i = 0; i < bucket.length; i++) {
      tmp[i] = sim.paths[bucket[i] * sim.years + y];
    }
    const sorted = Array.from(tmp).sort((a, b) => a - b);
    path[y] = sorted[Math.floor(sorted.length / 2)];
  }
  return path;
}

function quintileRuinFraction(sim, bucket) {
  if (!sim.ruined) return 0;
  let count = 0;
  for (const p of bucket) if (sim.ruined[p]) count++;
  return count / bucket.length;
}

function quintileMedianTerminal(sim, bucket) {
  const last = sim.years - 1;
  const vals = bucket.map((p) => sim.paths[p * sim.years + last]).sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

function quintileMeanReturn(sim, bucket) {
  let s = 0;
  for (const p of bucket) s += sim.firstDecadeReturn[p];
  return s / bucket.length;
}

function ensurePanel(container) {
  if (panelEl && panelEl.isConnected) return panelEl;
  panelEl = document.createElement("section");
  panelEl.className = "decade";
  panelEl.innerHTML = `
    <header class="decade-header">
      <h3 class="decade-title">Conditional outcome by first-decade returns</h3>
      <p class="decade-subtitle">Five quintiles of paths grouped by their annualised market return over the first ${"<span data-role=\"dyears\">10</span>"} years. Each line is the median balance of its quintile — the gap between worst and best shows how much the early years matter.</p>
    </header>
    <div class="decade-chart" id="decadeChart"></div>
    <div class="decade-stats" data-role="dstats"></div>
    <p class="decade-footer" data-role="dfooter"></p>
  `;
  container.appendChild(panelEl);
  return panelEl;
}

// Returns array of factors for each year index, used to scale balances
// for nominal display. retirementYear is unused here since the quintile
// chart uses the absolute year axis, not retirement-relative.
function buildFactors(years, units, inflation) {
  if (units !== "nominal") return null;
  const out = new Array(years);
  for (let y = 0; y < years; y++) out[y] = Math.pow(1 + inflation, y);
  return out;
}

function scale(arr, factors) {
  if (!factors) return arr;
  return arr.map((v, i) => v * factors[i]);
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

export function firstDecadeShow(container, params) {
  // params: { sim, mode, horizonYears, currentAge, retirementYear, displayCtx }
  ensurePanel(container);
  const { sim, mode, horizonYears, currentAge, displayCtx } = params;
  if (!sim || !sim.firstDecadeReturn) { firstDecadeHide(container); return; }

  panelEl.querySelector('[data-role="dyears"]').textContent = String(sim.decadeYears || 10);

  const buckets = bucketQuintiles(sim.firstDecadeReturn, sim.numPaths);
  const factors = buildFactors(sim.years, displayCtx.units, displayCtx.inflation);

  // Median path per quintile.
  const xYears = Array.from({ length: sim.years }, (_, i) => i);
  const traces = buckets.map((b, q) => {
    const median = quintileMedian(sim, b);
    const display = scale(median, factors);
    return {
      x: xYears, y: display,
      mode: "lines", type: "scatter",
      name: QUINTILE_LABELS[q],
      line: { color: QUINTILE_COLOURS[q], width: 2 },
      hovertemplate: `<b>${QUINTILE_LABELS[q]} · Year %{x}</b>  %{y:$,.0f}<extra></extra>`,
    };
  });

  const ticks = buildAxisTicks(horizonYears, currentAge);

  let yPeak = 0;
  for (const t of traces) for (const v of t.y) if (v > yPeak) yPeak = v;
  const yMax = Math.max(yPeak * 1.05, 1000);

  const layout = {
    margin: { l: 70, r: 20, t: 14, b: 60 },
    height: 280,
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    hovermode: "x unified",
    hoverlabel: HOVER_LABEL,
    showlegend: true,
    legend: {
      orientation: "h", y: -0.20, x: 0.5, xanchor: "center",
      bgcolor: "rgba(255,255,255,0)",
      font: { size: 11 },
    },
    xaxis: {
      tickmode: "array",
      tickvals: ticks.vals,
      ticktext: ticks.text,
      showgrid: false, zeroline: false,
    },
    yaxis: {
      title: { text: "Conditional median balance", standoff: 8 },
      tickformat: "$,.2s",
      gridcolor: "rgba(0,0,0,0.06)",
      zeroline: false,
      autorange: false,
      range: [0, yMax],
    },
    font: PLOTLY_FONT,
  };

  Plotly.react("decadeChart", traces, layout, { displayModeBar: false, responsive: true });

  // Stat strip — one card per quintile.
  const isDrawdown = mode === "drawdown";
  const statsEl = panelEl.querySelector('[data-role="dstats"]');
  statsEl.innerHTML = buckets.map((b, q) => {
    const meanRet = quintileMeanReturn(sim, b);
    const retLabel = `${meanRet >= 0 ? "+" : ""}${(meanRet * 100).toFixed(1)}%/yr`;
    let outcome;
    if (isDrawdown) {
      const ruin = quintileRuinFraction(sim, b);
      outcome = `${(ruin * 100).toFixed(1)}% ruin`;
    } else {
      const term = quintileMedianTerminal(sim, b);
      const factor = factors ? factors[factors.length - 1] : 1;
      outcome = fmtMoney(term * factor);
    }
    return `
      <div class="decade-stat" style="border-top-color: ${QUINTILE_COLOURS[q]}">
        <div class="decade-stat-label">${QUINTILE_LABELS[q]}</div>
        <div class="decade-stat-meta">${retLabel}</div>
        <div class="decade-stat-value">${outcome}</div>
      </div>
    `;
  }).join("");

  // Footer caption.
  const footerEl = panelEl.querySelector('[data-role="dfooter"]');
  if (isDrawdown) {
    const worst = quintileRuinFraction(sim, buckets[0]);
    const best = quintileRuinFraction(sim, buckets[4]);
    if (worst === 0 && best === 0) {
      footerEl.textContent = `In this scenario no paths ruin in any first-decade bucket.`;
    } else if (best === 0) {
      footerEl.textContent = `Paths in the worst first-decade quintile ruin ${(worst * 100).toFixed(1)}% of the time; in the best quintile, none ruin. The early years carry most of the risk.`;
    } else {
      const ratio = worst / Math.max(best, 0.0001);
      footerEl.textContent = `Paths in the worst first-decade quintile ruin ${(worst * 100).toFixed(1)}% of the time, versus ${(best * 100).toFixed(1)}% in the best — roughly ${ratio.toFixed(1)}× the rate. The early years carry most of the risk.`;
    }
  } else {
    const worstTerm = quintileMedianTerminal(sim, buckets[0]);
    const bestTerm = quintileMedianTerminal(sim, buckets[4]);
    const factor = factors ? factors[factors.length - 1] : 1;
    footerEl.textContent = `The best first-decade quintile ends with a conditional median of ${fmtMoney(bestTerm * factor)} — ${(bestTerm / Math.max(worstTerm, 1)).toFixed(1)}× the worst quintile's ${fmtMoney(worstTerm * factor)}.`;
  }

  lastRendered = { sim, mode, horizonYears, currentAge, displayCtx };
}

export function firstDecadeHide(container) {
  if (panelEl && panelEl.isConnected) panelEl.remove();
  panelEl = null;
  lastRendered = null;
}

export function firstDecadeRedisplay(displayCtx) {
  if (!lastRendered || !panelEl || !panelEl.isConnected) return;
  firstDecadeShow(panelEl.parentNode, { ...lastRendered, displayCtx });
}
