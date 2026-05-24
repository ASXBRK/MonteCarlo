// Tornado chart main-thread coordinator: owns the worker, debounces
// recomputes, renders bars, and re-formats values when display units
// change without re-running the worker.

import TornadoWorker from "./tornadoWorker.js?worker";

const worker = new TornadoWorker();
let pendingId = 0;
const pendingResolvers = new Map();

worker.addEventListener("message", (ev) => {
  const { id, ok, result, error } = ev.data;
  const resolver = pendingResolvers.get(id);
  if (!resolver) return;
  pendingResolvers.delete(id);
  if (ok) resolver.resolve(result);
  else resolver.reject(new Error(error));
});

function runWorker(params) {
  const id = ++pendingId;
  return new Promise((resolve, reject) => {
    pendingResolvers.set(id, { resolve, reject });
    worker.postMessage({ id, params });
  });
}

// --- formatting --------------------------------------------------------

const fmtMoneyCompact = (v) => {
  const sign = v < 0 ? "-" : "+";
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}k`;
  return `${sign}$${Math.round(abs)}`;
};

const fmtPp = (v) => `${v >= 0 ? "+" : "-"}${Math.abs(v * 100).toFixed(1)}pp`;

// --- DOM / state -------------------------------------------------------

let panelEl = null;
let lastResult = null;
let lastInflation = 0;
let lastUnits = "real";
let lastTargetPct = 0.10;
let debounceHandle = null;
let computingToken = 0;

const DEBOUNCE_MS = 1500;

function ensurePanel(container) {
  if (panelEl && panelEl.isConnected) return panelEl;
  panelEl = document.createElement("section");
  panelEl.className = "tornado";
  panelEl.innerHTML = `
    <header class="tornado-header">
      <h3 class="tornado-title" data-role="ttitle">What drives this projection?</h3>
      <p class="tornado-subtitle" data-role="tsubtitle"></p>
      <p class="tornado-compare-note" data-role="tcompareNote" hidden>
        Sensitivity analysis is shown for Scenario A. Toggle off compare mode to focus on a single scenario.
      </p>
    </header>
    <div class="tornado-callout" data-role="tcallout" hidden></div>
    <div class="tornado-body" data-role="tbars"></div>
    <p class="tornado-footer">
      Tornado bars use a reduced path count for performance; magnitudes are illustrative.
    </p>
  `;
  container.appendChild(panelEl);
  return panelEl;
}

function showPulsingPlaceholders(barCount) {
  const bars = panelEl.querySelector('[data-role="tbars"]');
  let rows = "";
  for (let i = 0; i < barCount; i++) {
    rows += `
      <div class="tornado-row placeholder">
        <div class="tornado-label">&nbsp;</div>
        <div class="tornado-track">
          <div class="tornado-pulse"></div>
        </div>
        <div class="tornado-value">&nbsp;</div>
      </div>
    `;
  }
  bars.innerHTML = rows;
}

// --- rendering ---------------------------------------------------------

function renderStandard(result, displayCtx) {
  const { formatMetric, mode } = displayCtx;
  const titleEl = panelEl.querySelector('[data-role="ttitle"]');
  const subtitleEl = panelEl.querySelector('[data-role="tsubtitle"]');
  titleEl.textContent = mode === "accumulation"
    ? "What drives this projection?"
    : "What drives your retirement outcome?";
  subtitleEl.textContent = "Each bar shows how much your projected outcome changes when an input is varied within its plausible range.";

  // Max absolute delta to scale bar widths. Each half of the track is
  // 50%, so a bar with the max-abs delta fills its half exactly.
  let maxAbs = 0;
  for (const bar of result.bars) {
    for (const p of bar.perturbations) {
      if (Math.abs(p.delta) > maxAbs) maxAbs = Math.abs(p.delta);
    }
  }
  if (maxAbs === 0) maxAbs = 1;

  const bars = panelEl.querySelector('[data-role="tbars"]');
  bars.innerHTML = result.bars.map((bar) => {
    const left = bar.perturbations.filter((p) => p.delta < 0);
    const right = bar.perturbations.filter((p) => p.delta >= 0);

    const seg = (p, cls) =>
      `<div class="tornado-seg ${cls}" style="width:${(Math.abs(p.delta) / maxAbs) * 100}%" title="${p.dir}: ${formatMetric(p.delta)}"></div>`;

    const chips = bar.perturbations.map((p) =>
      `<span class="tornado-chip ${p.delta >= 0 ? "pos" : "neg"}">${p.dir} ${formatMetric(p.delta)}</span>`
    ).join(" ");

    return `
      <div class="tornado-row">
        <div class="tornado-label">${bar.label}</div>
        <div class="tornado-track centered">
          <div class="tornado-half left">${left.map((p) => seg(p, "neg")).join("")}</div>
          <div class="tornado-baseline"></div>
          <div class="tornado-half right">${right.map((p) => seg(p, "pos")).join("")}</div>
        </div>
        <div class="tornado-value">${chips}</div>
      </div>
    `;
  }).join("");
  hideCallout();
}

function renderGoalSeek(result) {
  const titleEl = panelEl.querySelector('[data-role="ttitle"]');
  const subtitleEl = panelEl.querySelector('[data-role="tsubtitle"]');
  titleEl.textContent = "What would bring you to your goal?";
  subtitleEl.innerHTML = `Your current scenario has a <strong>${(result.baselineRuin * 100).toFixed(1)}%</strong> probability of running out of money, above your <strong>${(result.targetRuin * 100).toFixed(0)}%</strong> target. Each bar shows the minimum change to one input that would bring you to your goal.`;

  // Normalised magnitudes for bar width scaling.
  function widthFor(bar) {
    if (bar.insufficient) return 100;
    if (bar.kind === "pct") return Math.min(100, Math.max(2, bar.change * 100));
    if (bar.kind === "years") return Math.min(100, Math.max(2, (bar.change / 10) * 100));
    if (bar.kind === "asset") return Math.min(100, Math.max(2, (Math.abs(bar.change) / 6) * 100));
    return 50;
  }

  const bars = panelEl.querySelector('[data-role="tbars"]');
  const rows = result.bars.map((bar) => {
    const cls = bar.insufficient ? "insufficient" : "pos";
    const w = widthFor(bar);
    const valueText = bar.insufficient
      ? `<span class="tornado-chip insufficient">Cannot reach goal alone</span>`
      : `<span class="tornado-chip pos">${bar.changeLabel}</span>`;
    return `
      <div class="tornado-row">
        <div class="tornado-label">${bar.label}</div>
        <div class="tornado-track left-anchored">
          <div class="tornado-seg ${cls}" style="width:${w}%"></div>
        </div>
        <div class="tornado-value">${valueText}</div>
      </div>
    `;
  }).join("");
  bars.innerHTML = rows;

  if (result.allInsufficient) {
    showCallout("No single input change can meet your goal. Multiple changes in combination may be required.");
  } else {
    hideCallout();
  }
}

function showCallout(text) {
  const el = panelEl.querySelector('[data-role="tcallout"]');
  el.textContent = text;
  el.hidden = false;
}
function hideCallout() {
  const el = panelEl.querySelector('[data-role="tcallout"]');
  el.hidden = true;
  el.textContent = "";
}
function setCompareNote(visible) {
  const el = panelEl.querySelector('[data-role="tcompareNote"]');
  if (el) el.hidden = !visible;
}

// --- public API --------------------------------------------------------

function metricFormatter(mode, units, inflation, horizonYears) {
  if (mode === "drawdown") {
    return (v) => fmtPp(v);  // percentage points of ruin probability
  }
  // Accumulation: bar deltas are in real-terms terminal-balance dollars;
  // scale by (1+i)^horizon when nominal is the active display.
  const scale = units === "nominal" ? Math.pow(1 + inflation, horizonYears) : 1;
  return (v) => fmtMoneyCompact(v * scale);
}

export function tornadoRender(container, displayCtx, opts = {}) {
  ensurePanel(container);
  setCompareNote(opts.compareNote === true);
  if (!lastResult) {
    showPulsingPlaceholders(opts.expectedBars || 4);
    return;
  }
  applyResult(lastResult, displayCtx);
}

function applyResult(result, displayCtx) {
  panelEl.classList.toggle("computing", false);
  if (result.mode === "goal-seek") renderGoalSeek(result);
  else renderStandard(result, displayCtx);
}

// Trigger a recompute (debounced). `request` describes the current
// scenario; `displayCtx` describes how to format the result. Compute
// happens in a worker; while pending we show pulsing placeholders.
export function tornadoSchedule(container, request, displayCtx, opts = {}) {
  ensurePanel(container);
  setCompareNote(opts.compareNote === true);

  // Immediate placeholder UI.
  panelEl.classList.add("computing");
  showPulsingPlaceholders(opts.expectedBars || (request.mode === "drawdown" ? 4 : 4));

  if (debounceHandle != null) clearTimeout(debounceHandle);
  const myToken = ++computingToken;
  debounceHandle = setTimeout(async () => {
    debounceHandle = null;
    try {
      const result = await runWorker(request);
      if (myToken !== computingToken) return; // newer request superseded
      lastResult = result;
      lastInflation = displayCtx.inflation;
      lastUnits = displayCtx.units;
      lastTargetPct = request.targetRuin;
      applyResult(result, displayCtx);
    } catch (err) {
      console.error("tornado worker error", err);
      panelEl.classList.remove("computing");
      const bars = panelEl.querySelector('[data-role="tbars"]');
      bars.innerHTML = `<p class="tornado-error">Couldn't compute sensitivity — ${err.message}</p>`;
    }
  }, DEBOUNCE_MS);
}

// Re-render the cached result with new display context (e.g. when the
// units toggle flips). No worker call needed.
export function tornadoRedisplay(displayCtx) {
  if (!panelEl || !lastResult) return;
  applyResult(lastResult, displayCtx);
}

export function tornadoClear() {
  lastResult = null;
  if (panelEl) {
    panelEl.querySelector('[data-role="tbars"]').innerHTML = "";
    hideCallout();
  }
}
