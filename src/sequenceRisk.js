// Sequence-of-returns risk visualiser. Two paths through the
// drawdown phase with identical return statistics but opposite
// orderings: Path A puts the 7 worst years first, Path B puts them
// last. Highlights how the order of returns matters in decumulation.

const COLOR_A = "#d97b2f";  // warm orange — bad years early
const COLOR_B = "#2e8a8a";  // cool teal   — bad years late
const BAD_COUNT = 7;

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

// --- math --------------------------------------------------------------

function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Construct `years` annual returns from N(mu, sigma²) with rejection
// sampling: no individual year outside ±2σ, arithmetic mean within
// ±0.5σ of μ. Falls back to all-μ after 500 unsuccessful attempts
// (should never trigger for reasonable params).
function generateReturns(years, mu, sigma) {
  const bandLo = mu - 2 * sigma;
  const bandHi = mu + 2 * sigma;
  const meanTol = 0.5 * sigma;
  for (let attempt = 0; attempt < 500; attempt++) {
    const ret = new Array(years);
    let sum = 0;
    let valid = true;
    for (let y = 0; y < years; y++) {
      const r = mu + sigma * randn();
      if (r < bandLo || r > bandHi) { valid = false; break; }
      ret[y] = r;
      sum += r;
    }
    if (!valid) continue;
    if (Math.abs(sum / years - mu) > meanTol) continue;
    return ret;
  }
  return new Array(years).fill(mu);
}

// Place the 7 worst years first (Path A) or last (Path B). The
// non-worst years use the SAME shuffle for both paths so the only
// difference is the bad-year placement.
function orderPaths(returns) {
  const n = returns.length;
  const bad = Math.min(BAD_COUNT, n);
  const sortedIdx = returns.map((_, i) => i).sort((a, b) => returns[a] - returns[b]);
  const worst = sortedIdx.slice(0, bad).map((i) => returns[i]);
  const rest = sortedIdx.slice(bad).map((i) => returns[i]);
  // Fisher-Yates shuffle on `rest`.
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return {
    A: [...worst, ...rest],
    B: [...rest, ...worst],
  };
}

// Run year-by-year drawdown: apply return, subtract withdrawal, mark
// ruin at first depletion, hold at 0 thereafter. balances[0] is the
// starting balance; balances[y] is the end-of-year-y balance.
function runPath(returns, startingBalance, annualWithdrawal) {
  const balances = [startingBalance];
  let bal = startingBalance;
  let ruinYear = null;
  for (let y = 0; y < returns.length; y++) {
    if (bal === 0) { balances.push(0); continue; }
    bal = bal * (1 + returns[y]) - annualWithdrawal;
    if (bal <= 0) {
      bal = 0;
      if (ruinYear == null) ruinYear = y + 1;
    }
    balances.push(bal);
  }
  return { balances, ruinYear };
}

function stats(returns) {
  const n = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  let varSum = 0;
  for (const r of returns) varSum += (r - mean) ** 2;
  const stddev = Math.sqrt(varSum / n);
  let logSum = 0;
  for (const r of returns) logSum += Math.log(1 + r);
  const geoMean = Math.exp(logSum / n) - 1;
  return { mean, stddev, geoMean };
}

// --- y-axis ticks ------------------------------------------------------

// Step size based on the y-max, picked to produce round-number ticks
// at a useful density (~5–10 ticks across the visible range).
function pickTickStep(yMax) {
  if (yMax < 200_000)    return 25_000;
  if (yMax < 500_000)    return 50_000;
  if (yMax < 1_000_000)  return 100_000;
  if (yMax < 2_500_000)  return 250_000;
  if (yMax < 5_000_000)  return 500_000;
  if (yMax < 10_000_000) return 1_000_000;
  return 2_000_000;
}

function fmtTick(v) {
  if (v === 0) return "$0";
  if (v >= 1_000_000) {
    // parseFloat round-trip strips trailing zeros so $1,250,000 reads
    // as "$1.25M" not "$1.3M", $1,500,000 as "$1.5M" not "$1.50M".
    const m = parseFloat((v / 1_000_000).toFixed(2));
    return `$${m}M`;
  }
  return `$${(v / 1000).toFixed(0)}k`;
}

function buildYTicks(yMax) {
  const step = pickTickStep(yMax);
  const vals = [];
  for (let v = 0; v <= yMax + 1; v += step) vals.push(v);
  return { vals, text: vals.map(fmtTick) };
}

// --- formatting --------------------------------------------------------

function fmtMoney(v) {
  if (v <= 0) return "$0";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}
function fmtPct(v, d = 1) {
  return `${(v * 100).toFixed(d)}%`;
}

// --- module state ------------------------------------------------------

let panelEl = null;
let returnSet = null;          // raw real returns (cached across input changes)
let returnSetKey = null;       // tracks (mu, sigma, years) for invalidation
let lastParams = null;         // last params we drew with

// --- DOM scaffold ------------------------------------------------------

function ensurePanel(container) {
  if (panelEl && panelEl.isConnected) return panelEl;
  panelEl = document.createElement("section");
  panelEl.className = "seqrisk";
  panelEl.innerHTML = `
    <header class="seqrisk-header">
      <h3 class="seqrisk-title">Why sequence matters in retirement</h3>
      <p class="seqrisk-subtitle">If you experience the same average return, the only difference between these two outcomes is when the bad years arrive.</p>
    </header>
    <div class="seqrisk-content">
      <div class="seqrisk-chart" id="seqRiskChart"></div>
      <aside class="seqrisk-stats" data-role="seqStats"></aside>
    </div>
    <p class="seqrisk-caption" data-role="seqCaption"></p>
    <div class="seqrisk-footer">
      <button class="seqrisk-refresh" type="button" data-role="seqRefresh">Show a different sequence</button>
    </div>
  `;
  container.appendChild(panelEl);
  // Wire refresh.
  panelEl.querySelector('[data-role="seqRefresh"]').addEventListener("click", () => {
    returnSet = null;
    returnSetKey = null;
    if (lastParams) renderInternal(lastParams);
  });
  return panelEl;
}

// --- render ------------------------------------------------------------

function renderInternal(params) {
  const { mu, sigma, horizonYears, startingBalance, annualWithdrawal, displayCtx, retirementOffset } = params;

  const key = `${mu}|${sigma}|${horizonYears}`;
  if (returnSet == null || returnSetKey !== key) {
    returnSet = generateReturns(horizonYears, mu, sigma);
    returnSetKey = key;
  }

  const ordered = orderPaths(returnSet);
  const a = runPath(ordered.A, startingBalance, annualWithdrawal);
  const b = runPath(ordered.B, startingBalance, annualWithdrawal);

  // Display scaling: real balances → nominal multiplied by
  // (1+i)^(retirementOffset + visualiser_year_t). Apply per-year.
  const factor = (t) => {
    if (displayCtx.units !== "nominal") return 1;
    return Math.pow(1 + displayCtx.inflation, retirementOffset + t);
  };
  const scaleBalances = (balances) => balances.map((v, t) => v * factor(t));

  const aDisplay = scaleBalances(a.balances);
  const bDisplay = scaleBalances(b.balances);
  const x = a.balances.map((_, t) => t);

  // Annotations at each path's terminal point with the name + value.
  const annotations = [
    {
      x: horizonYears, y: aDisplay[horizonYears], xref: "x", yref: "y",
      text: `<b>Path A</b><br>${a.ruinYear != null ? `Ruined at year ${a.ruinYear}` : fmtMoney(aDisplay[horizonYears])}`,
      showarrow: false, xanchor: "left", yanchor: "middle", xshift: 6,
      font: { size: 11, color: COLOR_A },
      align: "left",
    },
    {
      x: horizonYears, y: bDisplay[horizonYears], xref: "x", yref: "y",
      text: `<b>Path B</b><br>${b.ruinYear != null ? `Ruined at year ${b.ruinYear}` : fmtMoney(bDisplay[horizonYears])}`,
      showarrow: false, xanchor: "left", yanchor: "middle", xshift: 6,
      font: { size: 11, color: COLOR_B },
      align: "left",
    },
  ];

  const data = [
    {
      x, y: aDisplay,
      mode: "lines", type: "scatter",
      name: "Path A (bad years early)",
      line: { color: COLOR_A, width: 2.5 },
      hovertemplate: `<b>Path A · year %{x}</b>  %{y:$,.0f}<extra></extra>`,
    },
    {
      x, y: bDisplay,
      mode: "lines", type: "scatter",
      name: "Path B (bad years late)",
      line: { color: COLOR_B, width: 2.5 },
      hovertemplate: `<b>Path B · year %{x}</b>  %{y:$,.0f}<extra></extra>`,
    },
  ];

  // Y-axis upper bound: scan every point across both paths (a path's
  // true peak is often mid-horizon, well above its terminal). Add 10%
  // headroom, then snap up to the next tick step so the topmost tick
  // sits at or above the peak — keeps the chart's range from clipping
  // a path during transition animations.
  const allPoints = aDisplay.concat(bDisplay);
  let yPeak = 0;
  for (const v of allPoints) if (v > yPeak) yPeak = v;
  const yMaxRaw = Math.max(yPeak * 1.10, 1000);
  const step = pickTickStep(yMaxRaw);
  const yMax = Math.ceil(yMaxRaw / step) * step;
  const yTicks = buildYTicks(yMax);

  const layout = {
    margin: { l: 60, r: 100, t: 14, b: 40 },
    height: 280,
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    showlegend: false,
    hovermode: "x unified",
    hoverlabel: HOVER_LABEL,
    annotations,
    xaxis: {
      title: { text: "Retirement year", standoff: 6 },
      tickfont: { size: 11 },
      showgrid: false, zeroline: false,
    },
    yaxis: {
      autorange: false,
      range: [0, yMax],
      tickmode: "array",
      tickvals: yTicks.vals,
      ticktext: yTicks.text,
      gridcolor: "rgba(0,0,0,0.06)",
      zeroline: false,
    },
    font: PLOTLY_FONT,
    transition: { duration: 600, easing: "cubic-in-out" },
  };

  Plotly.react("seqRiskChart", data, layout, { displayModeBar: false, responsive: true });

  // Stats panel (uses real returns; geometry is the same in both
  // orderings so we compute once).
  const s = stats(returnSet);
  // Total withdrawn — in real terms it's annualWithdrawal × horizon;
  // in nominal it's the inflated sum.
  let totalWithdrawn = 0;
  if (displayCtx.units === "nominal") {
    for (let t = 0; t < horizonYears; t++) {
      totalWithdrawn += annualWithdrawal * factor(t);
    }
  } else {
    totalWithdrawn = annualWithdrawal * horizonYears;
  }

  const statsEl = panelEl.querySelector('[data-role="seqStats"]');
  statsEl.innerHTML = `
    <p class="seqrisk-stats-note">Both paths share identical return statistics. Only the order differs.</p>
    <dl class="seqrisk-stats-list">
      <dt>Average annual return</dt><dd>${fmtPct(s.mean)}</dd>
      <dt>Geometric mean</dt><dd>${fmtPct(s.geoMean)}</dd>
      <dt>Annual volatility</dt><dd>${fmtPct(s.stddev)}</dd>
      <dt>Total withdrawn</dt><dd>${fmtMoney(totalWithdrawn)}</dd>
    </dl>
    <dl class="seqrisk-stats-list endings">
      <dt class="path-a">Path A terminal</dt>
      <dd class="path-a">${a.ruinYear != null ? `Ruined at year ${a.ruinYear}` : fmtMoney(aDisplay[horizonYears])}</dd>
      <dt class="path-b">Path B terminal</dt>
      <dd class="path-b">${b.ruinYear != null ? `Ruined at year ${b.ruinYear}` : fmtMoney(bDisplay[horizonYears])}</dd>
    </dl>
  `;

  // Adaptive caption.
  const aRuin = a.ruinYear != null;
  const bRuin = b.ruinYear != null;
  const aEnd = aDisplay[horizonYears];
  const bEnd = bDisplay[horizonYears];
  const captionEl = panelEl.querySelector('[data-role="seqCaption"]');
  let caption;
  if (aRuin && bRuin) {
    caption = `Both sequences eventually deplete the portfolio, but the difference in when ruin occurs is striking — Path A at year ${a.ruinYear}, Path B at year ${b.ruinYear}.`;
  } else if (aRuin && !bRuin) {
    caption = `Path A runs out at year ${a.ruinYear}. Path B sustains the full horizon and ends with ${fmtMoney(bEnd)}. Same returns, same withdrawals — only the sequence differs.`;
  } else if (!aRuin && bRuin) {
    caption = `Both sequences face challenges, with Path B running out at year ${b.ruinYear} despite later bad years.`;
  } else {
    caption = `Both sequences sustain through retirement. Sequence risk is less severe in your scenario than for higher withdrawal rates — but the difference in terminal balance (${fmtMoney(aEnd)} vs ${fmtMoney(bEnd)}) shows the principle holds.`;
  }
  captionEl.textContent = caption;

  lastParams = params;
}

// --- public API --------------------------------------------------------

export function sequenceRiskShow(container, params) {
  ensurePanel(container);
  renderInternal(params);
}

export function sequenceRiskHide(container) {
  if (panelEl && panelEl.isConnected) panelEl.remove();
  panelEl = null;
  returnSet = null;
  returnSetKey = null;
  lastParams = null;
}

// Redisplay using the cached return set and last params with a new
// display ctx (units/inflation toggle).
export function sequenceRiskRedisplay(displayCtx) {
  if (!lastParams) return;
  renderInternal({ ...lastParams, displayCtx });
}
