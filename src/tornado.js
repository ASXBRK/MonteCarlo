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

// Format an input-side dollar change (applied to a baseline like a
// monthly contribution or annual withdrawal). Display ctx provides
// the scaling factor that mirrors the main chart's y-axis.
function fmtInputDollar(amount, unit, displayCtx) {
  const scaled = amount * (displayCtx.inputScale || 1);
  const sign = scaled < 0 ? "-" : "+";
  const abs = Math.abs(scaled);
  let body;
  if (abs >= 1e6) body = `$${(abs / 1e6).toFixed(2)}M`;
  else if (abs >= 1e3) body = `$${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  else body = `$${Math.round(abs).toLocaleString("en-US")}`;
  return `${sign}${body}${unit || ""}`;
}

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
        <div class="ttrack">
          <div class="tornado-pulse"></div>
        </div>
      </div>
    `;
  }
  bars.innerHTML = rows;
}

// --- rendering ---------------------------------------------------------

// Compose the input-side descriptor for a perturbation chip:
//   - With dollarChange: "+20% (+$600/mo)"
//   - Asset shift:       "→ Emerging Markets" (worker already prefixed)
//   - Otherwise:         "+5y", "+3y", etc.
function inputDescriptor(bar, p, displayCtx) {
  if (p.dollarChange != null) {
    return `${p.dir} (${fmtInputDollar(p.dollarChange, p.unit, displayCtx)})`;
  }
  return p.dir;
}

// "+$180k median balance" or "-3.2pp ruin probability".
function outcomeText(delta, displayCtx) {
  const metricName = displayCtx.mode === "drawdown" ? "ruin probability" : "median balance";
  return `${displayCtx.formatMetric(delta)} ${metricName}`;
}

function renderStandard(result, displayCtx) {
  const titleEl = panelEl.querySelector('[data-role="ttitle"]');
  const subtitleEl = panelEl.querySelector('[data-role="tsubtitle"]');

  const isAccumulation = displayCtx.mode === "accumulation";
  const improvementSign = isAccumulation ? +1 : -1;

  if (isAccumulation) {
    titleEl.textContent = "What drives this projection?";
    subtitleEl.textContent = "Each bar shows how much your projected median balance changes when an input is varied within its plausible range.";
  } else {
    titleEl.textContent = "What would improve your retirement security?";
    const ruin = displayCtx.displayedRuin != null ? displayCtx.displayedRuin : result.baselineRuin;
    subtitleEl.innerHTML = `Your scenario meets your goal: <strong>${(ruin * 100).toFixed(1)}%</strong> ruin probability, below your <strong>${(result.targetRuin * 100).toFixed(0)}%</strong> target. Each bar shows how much each input change would shift your ruin probability.`;
  }

  let maxAbs = 0;
  for (const bar of result.bars) {
    for (const p of bar.perturbations) {
      if (Math.abs(p.delta) > maxAbs) maxAbs = Math.abs(p.delta);
    }
  }
  if (maxAbs === 0) maxAbs = 1;

  // Bars max at 60% of their half-width; the remaining 40% leaves
  // room for the inline label without crowding the bar.
  const MAX_BAR_PCT_OF_HALF = 60;

  const bars = panelEl.querySelector('[data-role="tbars"]');
  bars.innerHTML = result.bars.map((bar) => {
    const improving = [];
    const worsening = [];
    for (const p of bar.perturbations) {
      if (p.delta * improvementSign > 0) improving.push(p);
      else if (p.delta * improvementSign < 0) worsening.push(p);
    }

    const labelHTML = (p) => {
      const input = inputDescriptor(bar, p, displayCtx);
      const outcome = outcomeText(p.delta, displayCtx);
      return `<span class="tlabel-input">${input}</span> → <span class="tlabel-outcome">${outcome}</span>`;
    };

    const segWidth = (p) => (Math.abs(p.delta) / maxAbs) * MAX_BAR_PCT_OF_HALF;

    // Left half: row-reverse so the bar is against the baseline (right
    // edge of the half) and labels stack outward to the left.
    const leftItems = improving.map((p) =>
      `<div class="tseg improve" style="width:${segWidth(p)}%"></div>
       <div class="tlabel improve">${labelHTML(p)}</div>`
    ).join("");

    const rightItems = worsening.map((p) =>
      `<div class="tseg worsen" style="width:${segWidth(p)}%"></div>
       <div class="tlabel worsen">${labelHTML(p)}</div>`
    ).join("");

    return `
      <div class="tornado-row">
        <div class="tornado-label">${bar.label}</div>
        <div class="ttrack centered">
          <div class="thalf left">${leftItems}</div>
          <div class="tbaseline"></div>
          <div class="thalf right">${rightItems}</div>
        </div>
      </div>
    `;
  }).join("");
  hideCallout();
}

function goalSeekChangeLabel(bar, displayCtx) {
  if (bar.insufficient) return "Cannot reach goal alone";
  if (bar.kind === "pct") {
    const pct = `${bar.direction}${Math.round(bar.change * 100)}%`;
    if (bar.dollarChange != null) {
      return `${pct} (${fmtInputDollar(bar.dollarChange, bar.unit, displayCtx)})`;
    }
    return pct;
  }
  if (bar.kind === "years") {
    if (bar.change === 0) return "no change";
    return `${bar.direction}${bar.change} year${bar.change === 1 ? "" : "s"}`;
  }
  if (bar.kind === "asset") {
    return `Move from ${bar.fromAsset} to ${bar.toAsset}`;
  }
  return "";
}

function renderGoalSeek(result, displayCtx) {
  const titleEl = panelEl.querySelector('[data-role="ttitle"]');
  const subtitleEl = panelEl.querySelector('[data-role="tsubtitle"]');
  titleEl.textContent = "What would bring you to your goal?";
  // Single source of truth for the displayed ruin probability: the
  // main simulation's value, passed in via displayCtx. The worker's
  // own 1000-path baseline is used for compute decisions only.
  const ruin = displayCtx.displayedRuin != null ? displayCtx.displayedRuin : result.baselineRuin;
  subtitleEl.innerHTML = `Your current scenario has a <strong>${(ruin * 100).toFixed(1)}%</strong> probability of running out of money, above your <strong>${(result.targetRuin * 100).toFixed(0)}%</strong> target. Each bar shows the minimum change to one input that would bring you to your goal.`;

  function widthFor(bar) {
    // Single-sided; max bar width is 60% of the track so the inline
    // label has room to sit at the bar's end.
    if (bar.insufficient) return 60;
    if (bar.kind === "pct") return Math.min(60, Math.max(2, bar.change * 60));
    if (bar.kind === "years") return Math.min(60, Math.max(2, (bar.change / 10) * 60));
    if (bar.kind === "asset") return Math.min(60, Math.max(2, (Math.abs(bar.change) / 6) * 60));
    return 30;
  }

  const bars = panelEl.querySelector('[data-role="tbars"]');
  const rows = result.bars.map((bar) => {
    const cls = bar.insufficient ? "insufficient" : "improve";
    const w = widthFor(bar);
    const label = goalSeekChangeLabel(bar, displayCtx);
    return `
      <div class="tornado-row">
        <div class="tornado-label">${bar.label}</div>
        <div class="ttrack left-anchored">
          <div class="tseg ${cls}" style="width:${w}%"></div>
          <div class="tlabel ${cls}">${label}</div>
        </div>
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
  if (result.mode === "goal-seek") renderGoalSeek(result, displayCtx);
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

// Compare mode: cancel any pending worker call and swap the panel
// for a small placeholder. Cached result stays so toggling back to
// single mode shows it immediately without a fresh compute.
export function tornadoHideForCompare(container) {
  if (debounceHandle != null) {
    clearTimeout(debounceHandle);
    debounceHandle = null;
  }
  computingToken++; // invalidate any in-flight worker reply
  if (panelEl && panelEl.isConnected) panelEl.remove();
  panelEl = null;
  // Render the placeholder in place.
  let ph = container.querySelector(".tornado-placeholder");
  if (!ph) {
    ph = document.createElement("div");
    ph.className = "tornado-placeholder";
    ph.textContent = "Sensitivity analysis is available in single-scenario mode.";
    container.appendChild(ph);
  }
}

// Single mode: remove any compare-mode placeholder before the next
// scheduleTornado() rebuilds the real panel.
export function tornadoShowForSingle(container) {
  const ph = container.querySelector(".tornado-placeholder");
  if (ph) ph.remove();
}
