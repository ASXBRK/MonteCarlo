import { PROFILES, DEFAULT_PROFILE } from "./profiles.js";
import { simulate, generateShocks, generateUniforms, NUM_PATHS } from "./sim.js";
import {
  renderChart, renderCompareChart, renderProbChart, renderBellCurves,
  SAMPLE_PATH_COUNT, sampleTraceIndices,
} from "./chart.js";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (id) => document.getElementById(id);

const els = {
  toggle: $("compareToggle"),
  drawdownToggle: $("drawdownToggle"),
  scenarios: $("scenarios"),
  horizonSlider: $("horizonSlider"),
  sliderLabel: document.querySelector('[data-role="sliderLabel"]'),
  output: $("output"),
  paramsBtn: $("paramsBtn"),
  paramsModal: $("paramsModal"),
  paramAssetTable: $("paramAssetTable"),
  chartNote: document.querySelector('[data-role="chartNote"]'),
  displayOptions: document.querySelectorAll(".display-option"),
  inflationInput: $("inflationInput"),
};

// Strings driven by units state. The simulation runs in real terms;
// nominal is a display transform applied year-by-year by displayFactors.
function currentUnitsStrings() {
  if (state.units === "real") {
    return {
      yAxisLabel: "Portfolio value (today's dollars)",
      chartNote: "All values in today's dollars (CPI-adjusted)",
    };
  }
  const pct = (state.inflation * 100).toFixed(1).replace(/\.0$/, "");
  return {
    yAxisLabel: "Portfolio value (future dollars)",
    chartNote: `All values in future dollars (nominal, ${pct}% inflation assumed)`,
  };
}

// Returns an array of length `years` where factors[t] = (1+i)^t in
// nominal mode, or null in real mode (meaning "no conversion").
function displayFactors(years) {
  if (state.units === "real") return null;
  const r = state.inflation;
  const out = new Array(years);
  for (let y = 0; y < years; y++) out[y] = Math.pow(1 + r, y);
  return out;
}

function scaleArr(arr, factors) {
  if (!factors) return arr;
  return arr.map((v, i) => v * factors[i]);
}

// Returns a sim-shaped object with bands / deterministic / sampled
// arrays scaled by factors. paths/numPaths/years/ruined* are left
// alone — they're either raw or dimensionless.
function applyDisplayToSim(sim, factors) {
  if (!factors) return sim;
  return {
    ...sim,
    p05: scaleArr(sim.p05, factors),
    p25: scaleArr(sim.p25, factors),
    p50: scaleArr(sim.p50, factors),
    p75: scaleArr(sim.p75, factors),
    p95: scaleArr(sim.p95, factors),
    deterministic: scaleArr(sim.deterministic, factors),
    sampled: sim.sampled.map((row) => row.map((v, i) => v * factors[i])),
  };
}

function applyUnitsLabel() {
  const s = currentUnitsStrings();
  if (els.chartNote) els.chartNote.textContent = s.chartNote;
  els.displayOptions.forEach((btn) => {
    const active = btn.dataset.units === state.units;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

const DEFAULTS = {
  age: "",
  horizonYears: 30,
  startingBalance: 50000,
  monthlyContribution: 1000,
  asset: DEFAULT_PROFILE,
  // Drawdown fields — only consulted when drawdownMode is on.
  currentAge: 40,
  retirementAge: 65,
  endAge: 90,
  annualWithdrawal: 50000,
};

const state = {
  compareMode: false,
  drawdownMode: false,
  units: "real",      // "real" | "nominal"
  inflation: 0.025,   // annual rate used only when units === "nominal"
  scenarios: {
    A: { ...DEFAULTS },
    B: { ...DEFAULTS },
  },
};

// In drawdown mode the time anchor is (currentAge, endAge) on scenario A.
function effectiveHorizonYears() {
  if (!state.drawdownMode) return state.scenarios.A.horizonYears;
  const a = state.scenarios.A;
  return Math.max(1, a.endAge - a.currentAge);
}

function retirementYearsFromAge(s) {
  return Math.max(0, s.retirementAge - state.scenarios.A.currentAge);
}

// --- helpers --------------------------------------------------------------

const fmtMoney = (v) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const fmtMoneyShort = (v) => {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${Math.round(v)}`;
};

function parseAge(v) {
  const s = String(v).trim();
  if (s === "") return null;
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// --- DOM building ---------------------------------------------------------

// Whether the per-scenario block should host the age input.
// (Horizon and end age both live on the persistent slider.) Only when
// compare mode is OFF and drawdown mode is OFF does age live in the
// scenario row; otherwise it lives in the shared block.
function scenarioHostsAge() {
  return !state.compareMode && !state.drawdownMode;
}

function buildScenarioBlock(id, values) {
  const block = document.createElement("div");
  block.className = "scenario";
  block.dataset.scenario = id;

  const header = document.createElement("div");
  header.className = "scenario-header";
  if (state.compareMode) {
    header.innerHTML = `
      <div class="scenario-title">Scenario ${id}</div>
      <div class="scenario-subtitle" data-role="subtitle"></div>
    `;
  }
  block.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "scenario-grid";

  const ageMarkup = scenarioHostsAge() ? `
    <div class="control">
      <label>Current age <span class="hint">(optional)</span></label>
      <input type="number" min="0" max="100" step="1" placeholder="e.g. 30"
             data-field="age" value="${values.age}" />
    </div>
  ` : "";

  const drawdownMarkup = state.drawdownMode ? `
    <div class="control">
      <label>Retirement age</label>
      <input type="number" min="20" max="100" step="1"
             data-field="retirementAge" value="${values.retirementAge}" />
    </div>
    <div class="control">
      <label>Annual withdrawal (real $)</label>
      <input type="number" min="0" step="1000"
             data-field="annualWithdrawal" value="${values.annualWithdrawal}" />
    </div>
  ` : "";

  grid.innerHTML = `
    ${ageMarkup}
    <div class="control">
      <label>Starting balance ($)</label>
      <input type="number" min="0" step="1000"
             data-field="startingBalance" value="${values.startingBalance}" />
    </div>
    <div class="control">
      <label>Monthly contribution ($)</label>
      <input type="number" min="0" step="100"
             data-field="monthlyContribution" value="${values.monthlyContribution}" />
    </div>
    <div class="control">
      <label>Asset class</label>
      <select data-field="asset">
        ${Object.keys(PROFILES).map(
          (n) => `<option value="${n}"${n === values.asset ? " selected" : ""}>${n}</option>`
        ).join("")}
      </select>
      <a class="calibration-link" href="#" data-open-params="asset-assumptions">
        <span class="info-glyph" aria-hidden="true">i</span> How these profiles are calibrated
      </a>
    </div>
    ${drawdownMarkup}
  `;
  block.appendChild(grid);

  grid.querySelectorAll("[data-field]").forEach((el) => {
    el.addEventListener("input", () => onFieldChange(id, el));
    el.addEventListener("change", () => onFieldChange(id, el));
  });

  return block;
}

// Shared block. Present whenever compare mode is on OR drawdown mode
// is on. Contents flip based on drawdown:
//   - drawdown off, compare on: age + horizon (existing behaviour)
//   - drawdown on (any compare): current age + end age (+ retirement
//     age is per-scenario)
function buildSharedBlock() {
  const block = document.createElement("div");
  block.className = "scenario-shared";
  const values = state.scenarios.A;

  if (state.drawdownMode) {
    block.innerHTML = `
      <div class="control">
        <label>Current age</label>
        <input type="number" min="0" max="100" step="1"
               data-shared="currentAge" value="${values.currentAge}" />
      </div>
    `;
  } else {
    block.innerHTML = `
      <div class="control">
        <label>Current age <span class="hint">(optional)</span></label>
        <input type="number" min="0" max="100" step="1" placeholder="e.g. 30"
               data-shared="age" value="${values.age}" />
      </div>
    `;
  }

  block.querySelectorAll("[data-shared]").forEach((el) => {
    el.addEventListener("input", () => onSharedChange(el));
    el.addEventListener("change", () => onSharedChange(el));
  });
  return block;
}

function onFieldChange(id, el) {
  const field = el.dataset.field;
  const raw = el.value;
  if (field === "age" || field === "asset") {
    state.scenarios[id][field] = raw;
  } else {
    const n = Number(raw);
    state.scenarios[id][field] = Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  scheduleRun();
}

function onSharedChange(el) {
  const field = el.dataset.shared;
  const raw = el.value;
  if (field === "age") {
    state.scenarios.A.age = raw;
    state.scenarios.B.age = raw;
  } else {
    const n = Number(raw);
    const val = Number.isFinite(n) ? Math.max(0, n) : 0;
    state.scenarios.A[field] = val;
    state.scenarios.B[field] = val;
  }
  scheduleRun();
}

function renderControls() {
  els.scenarios.innerHTML = "";
  els.scenarios.className = `scenarios ${state.compareMode ? "compare" : "single"}`;
  if (state.compareMode || state.drawdownMode) {
    els.scenarios.appendChild(buildSharedBlock());
  }
  const columns = document.createElement("div");
  columns.className = state.compareMode ? "scenario-columns" : "scenario-columns single";
  columns.appendChild(buildScenarioBlock("A", state.scenarios.A));
  if (state.compareMode) {
    columns.appendChild(buildScenarioBlock("B", state.scenarios.B));
  }
  els.scenarios.appendChild(columns);
}

// --- subtitle / diff ------------------------------------------------------

function describeField(field, value) {
  switch (field) {
    case "asset": return value;
    case "startingBalance": return `${fmtMoneyShort(value)} start`;
    case "monthlyContribution": return `${fmtMoneyShort(value)}/mo`;
    case "retirementAge": return `retire @ ${value}`;
    case "annualWithdrawal":
      return value === 0 ? "no withdrawals" : `${fmtMoneyShort(value)}/yr withdraw`;
    default: return String(value);
  }
}

// Returns the per-scenario subtitle text, or "" if nothing differs.
// Only considers per-scenario fields; shared inputs are excluded.
function computeSubtitles(a, b) {
  const baseFields = ["asset", "startingBalance", "monthlyContribution"];
  const drawdownFields = ["retirementAge", "annualWithdrawal"];
  const fields = state.drawdownMode
    ? [...baseFields, ...drawdownFields]
    : baseFields;
  const diffs = fields.filter((f) => a[f] !== b[f]);
  if (diffs.length === 0) return { A: "", B: "" };
  return {
    A: diffs.map((f) => describeField(f, a[f])).join(" · "),
    B: diffs.map((f) => describeField(f, b[f])).join(" · "),
  };
}

function applySubtitles(subs) {
  for (const id of ["A", "B"]) {
    const block = els.scenarios.querySelector(`.scenario[data-scenario="${id}"]`);
    if (!block) continue;
    const el = block.querySelector('[data-role="subtitle"]');
    if (el) el.textContent = subs[id];
  }
}

// Sync the persistent horizon/end-age slider with state — value,
// min/max range, and label text. Called after every state change.
function applySlider() {
  const a = state.scenarios.A;
  if (state.drawdownMode) {
    const min = a.retirementAge + 5;
    const max = 105;
    let value = a.endAge;
    if (value < min) { value = min; a.endAge = min; state.scenarios.B.endAge = min; }
    if (value > max) { value = max; a.endAge = max; state.scenarios.B.endAge = max; }
    els.horizonSlider.min = String(min);
    els.horizonSlider.max = String(max);
    els.horizonSlider.step = "1";
    els.horizonSlider.value = String(value);
    els.sliderLabel.innerHTML = `Project until age: <output>${value}</output>`;
  } else {
    els.horizonSlider.min = "5";
    els.horizonSlider.max = "50";
    els.horizonSlider.step = "1";
    els.horizonSlider.value = String(a.horizonYears);
    els.sliderLabel.innerHTML = `Time horizon: <output>${a.horizonYears}</output> years`;
  }
}

function onSliderChange() {
  const raw = Number(els.horizonSlider.value);
  if (!Number.isFinite(raw)) return;
  if (state.drawdownMode) {
    state.scenarios.A.endAge = raw;
    state.scenarios.B.endAge = raw;
  } else {
    state.scenarios.A.horizonYears = raw;
    state.scenarios.B.horizonYears = raw;
  }
  applySlider();
  scheduleRun();
}

els.horizonSlider.addEventListener("input", onSliderChange);
els.horizonSlider.addEventListener("change", onSliderChange);

// --- sim wrappers ---------------------------------------------------------

function buildDrawdownConfig(s) {
  if (!state.drawdownMode) return null;
  const currentAge = state.scenarios.A.currentAge; // shared anchor
  const retirementMonth = Math.max(1, (s.retirementAge - currentAge) * 12);
  return {
    retirementMonth,
    annualWithdrawal: s.annualWithdrawal,
  };
}

function runScenario(s, preGenZ = null, preGenU = null) {
  const p = PROFILES[s.asset];
  const horizon = state.drawdownMode
    ? Math.max(1, state.scenarios.A.endAge - state.scenarios.A.currentAge)
    : s.horizonYears;
  return simulate({
    horizonYears: horizon,
    startingBalance: s.startingBalance,
    monthlyContribution: s.monthlyContribution,
    mu: p.mu,
    sigma_normal: p.sigma_normal,
    sigma_stress: p.sigma_stress,
    p_stay_normal: p.p_stay_normal,
    p_stay_stress: p.p_stay_stress,
    preGenZ,
    preGenU,
    drawdown: buildDrawdownConfig(s),
  });
}

// --- single-mode rendering -----------------------------------------------

// Build the output section's DOM skeleton for the given mode.
// Only rebuilds when the mode actually changes, so subsequent runs in
// the same mode just update text/values into existing elements.
// When switching modes, any Plotly chart inside (e.g. #probChart) is
// torn down with its host node — its references go with it.
function ensureOutputSkeleton(mode) {
  if (els.output.dataset.mode === mode) return;
  els.output.dataset.mode = mode;

  if (mode === "single") {
    els.output.innerHTML = `
      <div class="summary single">
        <div class="stat">
          <div class="stat-label">Total contributed</div>
          <div class="stat-value" data-role="contrib">—</div>
        </div>
        <div class="stat">
          <div class="stat-label" data-role="steadyLabel">Steady return</div>
          <div class="stat-value" data-role="steady">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Median outcome</div>
          <div class="stat-value" data-role="median">—</div>
        </div>
        <div class="stat range">
          <div class="stat-label">5th – 95th percentile</div>
          <div class="stat-value" data-role="range">—</div>
        </div>
      </div>
    `;
  } else if (mode === "single-drawdown") {
    els.output.innerHTML = `
      <div class="summary single">
        <div class="stat stat-headline">
          <div class="stat-label">Probability of ruin</div>
          <div class="stat-value" data-role="ruin">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Median at end</div>
          <div class="stat-value" data-role="median">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Median at retirement</div>
          <div class="stat-value" data-role="atRetirement">—</div>
        </div>
        <div class="stat range">
          <div class="stat-label">End: 5th – 95th</div>
          <div class="stat-value" data-role="range">—</div>
        </div>
      </div>
    `;
  } else {
    // compare or compare-drawdown
    const firstCol = mode === "compare-drawdown" ? "Probability of ruin" : "Total contributed";
    els.output.innerHTML = `
      <div class="callout" data-role="callout"></div>
      <div class="chart-wrap chart-wrap-small">
        <div class="prob-header">
          <h3 class="prob-title" data-role="probTitle"></h3>
          <button class="info-icon" type="button" aria-label="About this chart"
            title="At each year, this shows the fraction of 2,000 simulated markets in which Plan A's value exceeds Plan B's. Both plans face the same market shocks each month, so the comparison isolates strategy choice from market luck. Ties count as half. The dashed line marks 50/50.">i</button>
        </div>
        <div id="probChart"></div>
      </div>
      <div class="narrative" data-role="narrative"></div>
      <div class="summary compare">
        <table class="stat-table">
          <thead>
            <tr>
              <th></th>
              <th>${firstCol}</th>
              <th>5th percentile</th>
              <th>Median</th>
              <th>95th percentile</th>
            </tr>
          </thead>
          <tbody data-role="statbody"></tbody>
        </table>
      </div>
    `;
  }
}

// Total contributed over `years` years, given a (possibly nominal)
// year-by-year factor array. In real mode this collapses to the
// simple sum; in nominal mode each year-t contribution is scaled by
// (1+i)^t — matching the chart's nominal-stream convention.
function totalContribFor(s, years, factors) {
  if (!factors) return s.startingBalance + s.monthlyContribution * 12 * years;
  let total = s.startingBalance;
  for (let t = 0; t < years; t++) {
    total += s.monthlyContribution * 12 * factors[t];
  }
  return total;
}

function updateSingleOutput(s, dsim) {
  const last = dsim.xYears.length - 1;
  const q = (role) => els.output.querySelector(`[data-role="${role}"]`);
  const factors = displayFactors(dsim.years);

  if (state.drawdownMode) {
    const retYear = retirementYearsFromAge(s);
    q("ruin").textContent = `${(dsim.ruinedFraction * 100).toFixed(1)}%`;
    q("median").textContent = fmtMoney(dsim.p50[last]);
    q("atRetirement").textContent = dsim.p50[retYear] != null
      ? fmtMoney(dsim.p50[retYear])
      : "—";
    q("range").textContent = `${fmtMoney(dsim.p05[last])} – ${fmtMoney(dsim.p95[last])}`;
  } else {
    q("contrib").textContent = fmtMoney(totalContribFor(s, s.horizonYears, factors));
    q("steadyLabel").textContent = `Steady return @ ${(PROFILES[s.asset].mu * 100).toFixed(1)}%`;
    q("steady").textContent = fmtMoney(dsim.deterministic[last]);
    q("median").textContent = fmtMoney(dsim.p50[last]);
    q("range").textContent = `${fmtMoney(dsim.p05[last])} – ${fmtMoney(dsim.p95[last])}`;
  }
}

// Resample `count` paths uniformly at random from a sim's full path
// matrix, returning yearly value rows. Used by the overlay animation.
// `factors` (may be null) scales each year for nominal display.
function resampleSinglePaths(sim, factors, count = SAMPLE_PATH_COUNT) {
  const seen = new Set();
  const rows = [];
  const target = Math.min(count, sim.numPaths);
  while (rows.length < target) {
    const i = Math.floor(Math.random() * sim.numPaths);
    if (seen.has(i)) continue;
    seen.add(i);
    const row = new Array(sim.years);
    const base = i * sim.years;
    for (let y = 0; y < sim.years; y++) {
      const v = sim.paths[base + y];
      row[y] = factors ? v * factors[y] : v;
    }
    rows.push(row);
  }
  return rows;
}

let singleAnimTimer = null;
const SINGLE_ANIM_INTERVAL_MS = 4000;

function stopSingleAnimation() {
  if (singleAnimTimer != null) {
    clearInterval(singleAnimTimer);
    singleAnimTimer = null;
  }
}

function startSingleAnimation(sim, factors) {
  stopSingleAnimation();
  if (prefersReducedMotion()) return;
  singleAnimTimer = setInterval(() => {
    const rows = resampleSinglePaths(sim, factors);
    Plotly.restyle("chart", { y: rows }, sampleTraceIndices());
  }, SINGLE_ANIM_INTERVAL_MS);
}

// Cache of the most recent sim outputs, keyed by mode. Display-only
// changes (units toggle, inflation rate) re-render from these without
// resimulating — which would otherwise reshuffle sample paths.
let lastSingle = null;   // { sim, s, horizon, currentAge, retirementYear }
let lastCompare = null;  // { simA, simB, sA, sB, sharedHorizon, sharedAge, retirementYear, names, chartNames, identical, probA }

function runSingle() {
  const s = state.scenarios.A;
  applySlider();

  const t0 = performance.now();
  const sim = runScenario(s);
  const t1 = performance.now();

  lastSingle = {
    sim,
    s: { ...s },
    horizon: state.drawdownMode ? effectiveHorizonYears() : s.horizonYears,
    currentAge: state.drawdownMode ? s.currentAge : parseAge(s.age),
    retirementYear: state.drawdownMode ? retirementYearsFromAge(s) : null,
  };
  lastCompare = null;
  redisplaySingle();

  const tag = state.drawdownMode
    ? `drawdown · ret@${s.retirementAge} · withdraw=${s.annualWithdrawal} · ruin=${(sim.ruinedFraction * 100).toFixed(1)}%`
    : `${s.asset} · ${s.horizonYears}y`;
  console.log(`sim ${(t1 - t0).toFixed(1)}ms · single · ${tag}`);
}

function redisplaySingle() {
  if (!lastSingle) return;
  const { sim, s, horizon, currentAge, retirementYear } = lastSingle;
  const factors = displayFactors(sim.years);
  const dsim = applyDisplayToSim(sim, factors);
  const { yAxisLabel } = currentUnitsStrings();

  renderChart("chart", dsim, {
    horizonYears: horizon,
    currentAge,
    retirementYear,
    yAxisLabel,
  });

  ensureOutputSkeleton(state.drawdownMode ? "single-drawdown" : "single");
  updateSingleOutput(s, dsim);

  startSingleAnimation(sim, factors);
  applyUnitsLabel();
}

// --- compare-mode rendering ----------------------------------------------

// P(A_i(t) "wins" over B_i(t)) for each year t in [0, sharedYears).
// Ties contribute 0.5 — so a year where every path is tied yields 50%,
// not 0%. Without this, year 0 at equal starting balances reads as 0%.
function pathProbability(simA, simB, sharedYears) {
  const n = Math.min(simA.numPaths, simB.numPaths);
  const yearsA = simA.years;
  const yearsB = simB.years;
  const out = new Array(sharedYears);
  for (let y = 0; y < sharedYears; y++) {
    let wins = 0;
    for (let p = 0; p < n; p++) {
      const a = simA.paths[p * yearsA + y];
      const b = simB.paths[p * yearsB + y];
      if (a > b) wins += 1;
      else if (a === b) wins += 0.5;
    }
    out[y] = wins / n;
  }
  return out;
}

// Probability that the higher-median scenario finishes below the lower-median
// scenario at the terminal year. Ties contribute 0.5 — same rule as above.
function regretFraction(simA, simB, termIdxA, termIdxB, higherIsA) {
  const n = Math.min(simA.numPaths, simB.numPaths);
  const yearsA = simA.years;
  const yearsB = simB.years;
  let bad = 0;
  for (let p = 0; p < n; p++) {
    const a = simA.paths[p * yearsA + termIdxA];
    const b = simB.paths[p * yearsB + termIdxB];
    // "finish worse off in H than in L"
    const hVal = higherIsA ? a : b;
    const lVal = higherIsA ? b : a;
    if (hVal < lVal) bad += 1;
    else if (hVal === lVal) bad += 0.5;
  }
  return bad / n;
}

function calloutText(probAGreater, names) {
  const end = probAGreater.length - 1;
  if (end < 1) return "";

  // Skip Year 0. It is a forced 50% when starting balances match,
  // which would otherwise flip every directional check.
  let maxDeviation = 0;
  for (let y = 1; y <= end; y++) {
    const dev = Math.abs(probAGreater[y] - 0.5);
    if (dev > maxDeviation) maxDeviation = dev;
  }

  // True "close to 50/50" case: max deviation across the horizon
  // stays under 5 percentage points.
  if (maxDeviation < 0.05) {
    return `${names.A} and ${names.B} stay close to 50/50 across the horizon.`;
  }

  // Leadership checks use STRICT inequality so a 0.5 tie at any
  // year does not flip the flags.
  let allAbove = true, allBelow = true;
  for (let y = 1; y <= end; y++) {
    if (probAGreater[y] < 0.5) allAbove = false;
    if (probAGreater[y] > 0.5) allBelow = false;
  }
  if (allAbove) return `${names.A} is more likely to lead throughout the entire horizon.`;
  if (allBelow) return `${names.B} is more likely to lead throughout the entire horizon.`;

  // Crossover detection starts from Year 1.
  let initialDir = null;
  let initialY = 1;
  for (let y = 1; y <= end; y++) {
    if (probAGreater[y] > 0.5) { initialDir = "A"; initialY = y; break; }
    if (probAGreater[y] < 0.5) { initialDir = "B"; initialY = y; break; }
  }
  if (initialDir == null) {
    return `${names.A} and ${names.B} stay close to 50/50 across the horizon.`;
  }
  for (let y = initialY + 1; y <= end; y++) {
    const dir = probAGreater[y] > 0.5 ? "A" : (probAGreater[y] < 0.5 ? "B" : null);
    if (dir && dir !== initialDir) {
      return `${names[dir]} becomes more likely to lead from Year ${y}.`;
    }
  }
  // If no crossover after the initial direction is set, that
  // scenario led throughout — NOT "stays close to 50/50".
  return `${names[initialDir]} is more likely to lead throughout the entire horizon.`;
}

function narrativeHTML(simA, simB, names, sharedHorizon, regret) {
  const t = sharedHorizon;
  const aMedian = simA.p50[t];
  const bMedian = simB.p50[t];
  const aP5 = simA.p05[t];
  const bP5 = simB.p05[t];

  const higherIsA = aMedian >= bMedian;
  const Hname = higherIsA ? names.A : names.B;
  const Lname = higherIsA ? names.B : names.A;
  const Hmedian = higherIsA ? aMedian : bMedian;
  const Lmedian = higherIsA ? bMedian : aMedian;
  const Hp5 = higherIsA ? aP5 : bP5;
  const Lp5 = higherIsA ? bP5 : aP5;

  const premiumRaw = (Hmedian / Math.max(Lmedian, 1) - 1) * 100;
  const premium = Math.round(premiumRaw);
  const regretPct = Math.round(regret * 100);

  let leadingSentence;
  if (premium <= 2) {
    leadingSentence = `Over ${sharedHorizon} years, ${Hname} and ${Lname} end with very similar medians (${fmtMoney(Hmedian)} versus ${fmtMoney(Lmedian)}) — the central outcomes are essentially tied.`;
  } else {
    leadingSentence = `Over ${sharedHorizon} years, <strong>${Hname}</strong> ends with a median of <strong>${fmtMoney(Hmedian)}</strong> — about <strong>${premium}%</strong> above ${Lname}'s ${fmtMoney(Lmedian)}.`;
  }

  let tailSentence;
  if (Hp5 < Lp5) {
    tailSentence = `However, ${Hname}'s 5th-percentile outcome is ${fmtMoney(Hp5)} versus ${Lname}'s ${fmtMoney(Lp5)} — the extra upside comes with greater downside risk.`;
  } else if (Hp5 > Lp5) {
    tailSentence = `${Hname} also has the higher worst-case outcome (${fmtMoney(Hp5)} at the 5th percentile, versus ${Lname}'s ${fmtMoney(Lp5)}), so the higher median does not come at the cost of more downside risk.`;
  } else {
    tailSentence = `Both scenarios share the same 5th-percentile outcome of ${fmtMoney(Hp5)}, so the comparison reduces to upside potential rather than downside risk.`;
  }

  return `
    <p>${leadingSentence} ${tailSentence}
    There's a <strong>${regretPct}%</strong> chance you actually finish worse off in
    ${Hname} than you would have in ${Lname}.</p>
  `;
}

function statRowsHTML(dsimA, dsimB, sA, sB, names, sharedHorizon) {
  const t = sharedHorizon;
  const factors = displayFactors(dsimA.years);
  const row = (label, s, dsim) => {
    if (state.drawdownMode) {
      return `
        <tr>
          <th scope="row">${label}</th>
          <td>${(dsim.ruinedFraction * 100).toFixed(1)}%</td>
          <td>${fmtMoney(dsim.p05[t])}</td>
          <td>${fmtMoney(dsim.p50[t])}</td>
          <td>${fmtMoney(dsim.p95[t])}</td>
        </tr>
      `;
    }
    return `
      <tr>
        <th scope="row">${label}</th>
        <td>${fmtMoney(totalContribFor(s, sharedHorizon, factors))}</td>
        <td>${fmtMoney(dsim.p05[t])}</td>
        <td>${fmtMoney(dsim.p50[t])}</td>
        <td>${fmtMoney(dsim.p95[t])}</td>
      </tr>
    `;
  };
  return row(names.A, sA, dsimA) + row(names.B, sB, dsimB);
}

function runCompare() {
  stopSingleAnimation();

  const sA = state.scenarios.A;
  const sB = state.scenarios.B;
  applySlider();

  const subs = computeSubtitles(sA, sB);
  applySubtitles(subs);
  const names = {
    A: subs.A || "Scenario A",
    B: subs.B || "Scenario B",
  };
  const chartNames = {
    A: subs.A || "Plan A",
    B: subs.B || "Plan B",
  };

  const sharedHorizon = state.drawdownMode
    ? effectiveHorizonYears()
    : Math.min(sA.horizonYears, sB.horizonYears);
  const sharedYears = sharedHorizon + 1;
  const sharedAge = state.drawdownMode
    ? sA.currentAge
    : (parseAge(sA.age) ?? parseAge(sB.age));
  const retirementYear = state.drawdownMode
    ? Math.max(0, sA.retirementAge - sA.currentAge)
    : null;

  const sharedMonths = sharedHorizon * 12;
  const t0 = performance.now();
  const shocks = generateShocks(NUM_PATHS, sharedMonths);
  const uniforms = generateUniforms(NUM_PATHS, sharedMonths);
  const simA = runScenario(sA, shocks, uniforms);
  const simB = runScenario(sB, shocks, uniforms);
  const t1 = performance.now();

  const baseIdentical =
    sA.asset === sB.asset &&
    sA.startingBalance === sB.startingBalance &&
    sA.monthlyContribution === sB.monthlyContribution;
  const drawdownIdentical = state.drawdownMode &&
    sA.retirementAge === sB.retirementAge &&
    sA.annualWithdrawal === sB.annualWithdrawal;
  const identical = state.drawdownMode
    ? (baseIdentical && drawdownIdentical)
    : baseIdentical;

  const probA = pathProbability(simA, simB, sharedYears);

  lastCompare = {
    simA, simB,
    sA: { ...sA }, sB: { ...sB },
    sharedHorizon, sharedYears, sharedAge, retirementYear,
    names, chartNames, identical, probA,
  };
  lastSingle = null;
  redisplayCompare();

  const tag = state.drawdownMode
    ? `drawdown · ruin A=${(simA.ruinedFraction * 100).toFixed(1)}% B=${(simB.ruinedFraction * 100).toFixed(1)}%`
    : `A=${sA.asset}/${sA.horizonYears}y · B=${sB.asset}/${sB.horizonYears}y`;
  console.log(`sim ${(t1 - t0).toFixed(1)}ms · compare · ${tag}`);
}

function redisplayCompare() {
  if (!lastCompare) return;
  const {
    simA, simB, sA, sB,
    sharedHorizon, sharedYears, sharedAge, retirementYear,
    names, chartNames, identical, probA,
  } = lastCompare;
  const factors = displayFactors(simA.years);
  const dsimA = applyDisplayToSim(simA, factors);
  const dsimB = applyDisplayToSim(simB, factors);
  const { yAxisLabel } = currentUnitsStrings();

  renderCompareChart("chart", { A: dsimA, B: dsimB }, {
    horizonYears: sharedHorizon,
    currentAge: sharedAge,
    names,
    retirementYear,
    yAxisLabel,
  });

  ensureOutputSkeleton(state.drawdownMode ? "compare-drawdown" : "compare");

  const xYears = Array.from({ length: sharedYears }, (_, i) => i);
  renderProbChart("probChart", xYears, probA, {
    horizonYears: sharedHorizon,
    currentAge: sharedAge,
  });

  const q = (role) => els.output.querySelector(`[data-role="${role}"]`);
  q("probTitle").textContent = state.drawdownMode
    ? `Probability ${chartNames.A}'s portfolio leads ${chartNames.B}'s`
    : `Probability ${chartNames.A} finishes ahead of ${chartNames.B}`;

  if (identical) {
    q("callout").textContent = "";
    q("narrative").innerHTML = `
      <p>Both scenarios are configured identically, so they produce the
      same paths under the same market shocks — the two fans overlap
      exactly. Change at least one per-scenario input to see a meaningful
      comparison.</p>
    `;
  } else if (state.drawdownMode) {
    q("callout").textContent = calloutText(probA, names);
    q("narrative").innerHTML = drawdownNarrativeHTML(dsimA, dsimB, names, sharedHorizon);
  } else {
    q("callout").textContent = calloutText(probA, names);
    const aMedian = dsimA.p50[sharedHorizon];
    const bMedian = dsimB.p50[sharedHorizon];
    const higherIsA = aMedian >= bMedian;
    // Regret uses raw paths since it's a pairwise comparison; nominal
    // factors are monotonic so they don't change A<B vs A>B counts.
    const regret = regretFraction(simA, simB, sharedHorizon, sharedHorizon, higherIsA);
    q("narrative").innerHTML = narrativeHTML(dsimA, dsimB, names, sharedHorizon, regret);
  }

  q("statbody").innerHTML = statRowsHTML(dsimA, dsimB, sA, sB, names, sharedHorizon);
  applyUnitsLabel();
}

function drawdownNarrativeHTML(simA, simB, names, sharedHorizon) {
  const ruinA = simA.ruinedFraction;
  const ruinB = simB.ruinedFraction;
  const t = sharedHorizon;
  const medA = simA.p50[t];
  const medB = simB.p50[t];

  let ruinSentence;
  if (ruinA === 0 && ruinB === 0) {
    ruinSentence = `Neither scenario depletes the portfolio in any simulated market.`;
  } else if (Math.abs(ruinA - ruinB) < 0.005) {
    ruinSentence = `Both scenarios face roughly a <strong>${(ruinA * 100).toFixed(1)}%</strong> chance of running out.`;
  } else {
    const higher = ruinA > ruinB ? names.A : names.B;
    const lower = ruinA > ruinB ? names.B : names.A;
    const hP = Math.max(ruinA, ruinB);
    const lP = Math.min(ruinA, ruinB);
    ruinSentence = `<strong>${higher}</strong> runs out of money in <strong>${(hP * 100).toFixed(1)}%</strong> of simulated markets, versus <strong>${(lP * 100).toFixed(1)}%</strong> for ${lower}.`;
  }

  let medianSentence;
  if (medA === 0 && medB === 0) {
    medianSentence = `In both scenarios, the median path ends at zero.`;
  } else {
    const higherIsA = medA >= medB;
    const Hname = higherIsA ? names.A : names.B;
    const Lname = higherIsA ? names.B : names.A;
    const Hmed = higherIsA ? medA : medB;
    const Lmed = higherIsA ? medB : medA;
    medianSentence = `At end age, ${Hname}'s median surviving balance is <strong>${fmtMoney(Hmed)}</strong> versus ${Lname}'s ${fmtMoney(Lmed)}.`;
  }

  return `<p>${ruinSentence} ${medianSentence}</p>`;
}

// --- run loop -------------------------------------------------------------

let rafHandle = null;
function scheduleRun() {
  if (rafHandle != null) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = null;
    run();
  });
}

function run() {
  if (state.compareMode) runCompare();
  else runSingle();
}

// --- toggle wiring --------------------------------------------------------

els.toggle.addEventListener("change", () => {
  state.compareMode = els.toggle.checked;
  if (state.compareMode) {
    // B inherits balance and contribution from A, but defaults to a
    // different asset class so the two fans are obviously distinct on
    // first render. Untrained users otherwise read two near-identical
    // fans as a bug.
    const defaultBAsset = state.scenarios.A.asset === "Balanced" ? "Growth" : "Balanced";
    state.scenarios.B = {
      ...state.scenarios.A,
      asset: defaultBAsset,
    };
  } else {
    // Discard B's values.
    state.scenarios.B = { ...DEFAULTS };
  }
  renderControls();
  run();
});

els.drawdownToggle.addEventListener("change", () => {
  state.drawdownMode = els.drawdownToggle.checked;
  if (state.drawdownMode) {
    // Sync shared anchors across both scenarios so per-scenario
    // retirement ages remain meaningful relative to the same currentAge.
    state.scenarios.B.currentAge = state.scenarios.A.currentAge;
    state.scenarios.B.endAge = state.scenarios.A.endAge;
  }
  stopSingleAnimation();
  renderControls();
  run();
});

// Units toggle — display-only, no resim.
els.displayOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    const u = btn.dataset.units;
    if (u !== "real" && u !== "nominal") return;
    if (state.units === u) return;
    state.units = u;
    redisplay();
  });
});

// Inflation rate (in the Parameters modal). Updates the nominal
// conversion immediately. No effect in real mode.
els.inflationInput.addEventListener("input", () => {
  const n = Number(els.inflationInput.value);
  if (!Number.isFinite(n) || n < 0) return;
  state.inflation = n / 100;
  if (state.units === "nominal") redisplay();
  else applyUnitsLabel();
});

function redisplay() {
  if (lastCompare) redisplayCompare();
  else if (lastSingle) redisplaySingle();
  else applyUnitsLabel();
}

// --- Parameters modal -----------------------------------------------------

let bellCurvesRendered = false;

function populateParamsTable() {
  els.paramAssetTable.innerHTML = Object.entries(PROFILES).map(
    ([name, { mu, sigma }]) => `
      <tr>
        <td>${name}</td>
        <td>${(mu * 100).toFixed(1)}%</td>
        <td>${(sigma * 100).toFixed(0)}%</td>
      </tr>
    `
  ).join("");
}

function openModal(scrollToId = null) {
  els.paramsModal.showModal();
  if (!bellCurvesRendered) {
    renderBellCurves("bellCurves", PROFILES);
    bellCurvesRendered = true;
  }
  if (scrollToId) {
    const target = els.paramsModal.querySelector(`#${scrollToId}`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function closeModal() {
  els.paramsModal.close();
}

els.paramsBtn.addEventListener("click", () => openModal());

// Calibration / "how is this defined?" links inside the input area
// open the modal scrolled to the relevant section.
els.scenarios.addEventListener("click", (e) => {
  const link = e.target.closest("[data-open-params]");
  if (!link) return;
  e.preventDefault();
  openModal(link.dataset.openParams);
});
els.paramsModal.querySelector(".modal-close").addEventListener("click", closeModal);
// Click on backdrop (i.e. on the dialog element itself, outside the content) closes.
els.paramsModal.addEventListener("click", (e) => {
  if (e.target === els.paramsModal) closeModal();
});

// Boot.
applyUnitsLabel();
populateParamsTable();
renderControls();
run();
