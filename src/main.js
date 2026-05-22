import { PROFILES, DEFAULT_PROFILE } from "./profiles.js";
import { simulate } from "./sim.js";
import { renderChart, renderCompareChart, renderProbChart, renderBellCurves } from "./chart.js";

const $ = (id) => document.getElementById(id);

const els = {
  toggle: $("compareToggle"),
  scenarios: $("scenarios"),
  output: $("output"),
  paramsBtn: $("paramsBtn"),
  paramsModal: $("paramsModal"),
  paramAssetTable: $("paramAssetTable"),
};

const DEFAULTS = {
  age: "",
  horizonYears: 30,
  startingBalance: 50000,
  monthlyContribution: 1000,
  asset: DEFAULT_PROFILE,
};

const state = {
  compareMode: false,
  scenarios: {
    A: { ...DEFAULTS },
    B: { ...DEFAULTS },
  },
};

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

  // In compare mode, age + horizon live in the shared block above;
  // the per-scenario block shows only balance/monthly/asset.
  const ageHorizonMarkup = state.compareMode ? "" : `
    <div class="control">
      <label>Current age <span class="hint">(optional)</span></label>
      <input type="number" min="0" max="100" step="1" placeholder="e.g. 30"
             data-field="age" value="${values.age}" />
    </div>
    <div class="control control-wide">
      <label>Time horizon: <output data-role="horizonOut">${values.horizonYears}</output> years</label>
      <input type="range" min="5" max="50" step="1"
             data-field="horizonYears" value="${values.horizonYears}" />
    </div>
  `;

  grid.innerHTML = `
    ${ageHorizonMarkup}
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
      <div class="asset-meta" data-role="assetMeta"></div>
    </div>
  `;
  block.appendChild(grid);

  // Wire inputs.
  grid.querySelectorAll("[data-field]").forEach((el) => {
    el.addEventListener("input", () => onFieldChange(id, el));
    el.addEventListener("change", () => onFieldChange(id, el));
  });

  return block;
}

// Shared age + horizon controls, shown only in compare mode.
function buildSharedBlock() {
  const block = document.createElement("div");
  block.className = "scenario-shared";
  // Values come from A; B is kept in sync.
  const values = state.scenarios.A;
  block.innerHTML = `
    <div class="control">
      <label>Current age <span class="hint">(optional)</span></label>
      <input type="number" min="0" max="100" step="1" placeholder="e.g. 30"
             data-shared="age" value="${values.age}" />
    </div>
    <div class="control control-wide">
      <label>Time horizon: <output data-role="horizonOut">${values.horizonYears}</output> years</label>
      <input type="range" min="5" max="50" step="1"
             data-shared="horizonYears" value="${values.horizonYears}" />
    </div>
  `;
  block.querySelectorAll("[data-shared]").forEach((el) => {
    el.addEventListener("input", () => onSharedChange(el));
    el.addEventListener("change", () => onSharedChange(el));
  });
  return block;
}

function onFieldChange(id, el) {
  const field = el.dataset.field;
  const raw = el.value;
  if (field === "age") {
    state.scenarios[id].age = raw;
  } else if (field === "asset") {
    state.scenarios[id].asset = raw;
  } else {
    // horizonYears, startingBalance, monthlyContribution — numeric.
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
    state.scenarios.A.horizonYears = val;
    state.scenarios.B.horizonYears = val;
  }
  scheduleRun();
}

function renderControls() {
  els.scenarios.innerHTML = "";
  els.scenarios.className = `scenarios ${state.compareMode ? "compare" : "single"}`;
  if (state.compareMode) {
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
    default: return String(value);
  }
}

// Returns the per-scenario subtitle text, or "" if nothing differs.
// Only considers per-scenario fields; horizon and age are shared.
function computeSubtitles(a, b) {
  const fields = ["asset", "startingBalance", "monthlyContribution"];
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

function applyAssetMeta(id, mu, sigma) {
  const block = els.scenarios.querySelector(`.scenario[data-scenario="${id}"]`);
  if (!block) return;
  const el = block.querySelector('[data-role="assetMeta"]');
  if (el) el.textContent = `μ = ${(mu * 100).toFixed(1)}% · σ = ${(sigma * 100).toFixed(0)}%`;
}

// Updates the horizon output label (shared block in compare, per-scenario in single).
function applyHorizonLabel() {
  const out = els.scenarios.querySelector('[data-role="horizonOut"]');
  if (out) out.textContent = String(state.scenarios.A.horizonYears);
}

// --- sim wrappers ---------------------------------------------------------

function runScenario(s) {
  const { mu, sigma } = PROFILES[s.asset];
  return simulate({
    horizonYears: s.horizonYears,
    startingBalance: s.startingBalance,
    monthlyContribution: s.monthlyContribution,
    mu, sigma,
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
  } else {
    els.output.innerHTML = `
      <div class="callout" data-role="callout"></div>
      <div class="chart-wrap chart-wrap-small">
        <div class="prob-header">
          <h3 class="prob-title" data-role="probTitle"></h3>
          <button class="info-icon" type="button" aria-label="About this chart"
            title="At each year, we pair the i-th simulated path of each plan and count how often Plan A finishes ahead. Ties count as half. The dashed line marks 50/50.">i</button>
        </div>
        <div id="probChart"></div>
      </div>
      <div class="narrative" data-role="narrative"></div>
      <div class="summary compare">
        <table class="stat-table">
          <thead>
            <tr>
              <th></th>
              <th>Total contributed</th>
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

function updateSingleOutput(s, sim) {
  const last = sim.xYears.length - 1;
  const totalContrib = s.startingBalance + s.monthlyContribution * 12 * s.horizonYears;
  const q = (role) => els.output.querySelector(`[data-role="${role}"]`);
  q("contrib").textContent = fmtMoney(totalContrib);
  q("steadyLabel").textContent = `Steady return @ ${(PROFILES[s.asset].mu * 100).toFixed(1)}%`;
  q("steady").textContent = fmtMoney(sim.deterministic[last]);
  q("median").textContent = fmtMoney(sim.p50[last]);
  q("range").textContent = `${fmtMoney(sim.p05[last])} – ${fmtMoney(sim.p95[last])}`;
}

function runSingle() {
  const s = state.scenarios.A;
  const { mu, sigma } = PROFILES[s.asset];
  applyAssetMeta("A", mu, sigma);
  applyHorizonLabel();

  const t0 = performance.now();
  const sim = runScenario(s);
  const t1 = performance.now();

  renderChart("chart", sim, {
    horizonYears: s.horizonYears,
    currentAge: parseAge(s.age),
  });

  ensureOutputSkeleton("single");
  updateSingleOutput(s, sim);

  console.log(`sim ${(t1 - t0).toFixed(1)}ms · single · ${s.asset} · ${s.horizonYears}y`);
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
  // Year 0 now reads correctly thanks to tie-handling (50% if equal
  // start balances, 0/100% if not), so we scan the whole range.
  const start = 0;
  const end = probAGreater.length - 1;
  if (end < start) return "";

  let allAbove = true, allBelow = true;
  for (let y = start; y <= end; y++) {
    if (probAGreater[y] <= 0.5) allAbove = false;
    if (probAGreater[y] >= 0.5) allBelow = false;
  }

  if (allAbove) return `${names.A} is more likely to lead throughout the entire horizon.`;
  if (allBelow) return `${names.B} is more likely to lead throughout the entire horizon.`;

  // Use the first year with a non-tied probability as the initial direction.
  let initialDir = null;
  let initialY = start;
  for (let y = start; y <= end; y++) {
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
  return `${names.A} and ${names.B} stay close to 50/50 across the horizon.`;
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

  const premium = Math.round((Hmedian / Math.max(Lmedian, 1) - 1) * 100);
  const regretPct = Math.round(regret * 100);

  const tailSentence = Hp5 < Lp5
    ? `However, ${Hname}'s 5th-percentile outcome is ${fmtMoney(Hp5)} versus ${Lname}'s ${fmtMoney(Lp5)} — the extra upside comes with greater downside risk.`
    : `${Hname} also has a higher worst-case outcome (${fmtMoney(Hp5)} at the 5th percentile, versus ${Lname}'s ${fmtMoney(Lp5)}) — one scenario dominates the other.`;

  return `
    <p>Over ${sharedHorizon} years, <strong>${Hname}</strong> ends with a median of
    <strong>${fmtMoney(Hmedian)}</strong> — about <strong>${premium}%</strong> above
    ${Lname}'s ${fmtMoney(Lmedian)}. ${tailSentence}
    There's a <strong>${regretPct}%</strong> chance you actually finish worse off in
    ${Hname} than you would have in ${Lname}.</p>
  `;
}

function statRowsHTML(simA, simB, sA, sB, names, sharedHorizon) {
  const t = sharedHorizon;
  const row = (label, s, sim) => {
    const totalContrib = s.startingBalance + s.monthlyContribution * 12 * sharedHorizon;
    return `
      <tr>
        <th scope="row">${label}</th>
        <td>${fmtMoney(totalContrib)}</td>
        <td>${fmtMoney(sim.p05[t])}</td>
        <td>${fmtMoney(sim.p50[t])}</td>
        <td>${fmtMoney(sim.p95[t])}</td>
      </tr>
    `;
  };
  return row(names.A, sA, simA) + row(names.B, sB, simB);
}

function runCompare() {
  const sA = state.scenarios.A;
  const sB = state.scenarios.B;
  const profA = PROFILES[sA.asset];
  const profB = PROFILES[sB.asset];
  applyAssetMeta("A", profA.mu, profA.sigma);
  applyAssetMeta("B", profB.mu, profB.sigma);
  applyHorizonLabel();

  const subs = computeSubtitles(sA, sB);
  applySubtitles(subs);
  const names = {
    A: subs.A || "Scenario A",
    B: subs.B || "Scenario B",
  };

  const t0 = performance.now();
  const simA = runScenario(sA);
  const simB = runScenario(sB);
  const t1 = performance.now();

  // Shared horizon for paired computations & narrative.
  const sharedHorizon = Math.min(sA.horizonYears, sB.horizonYears);
  const sharedYears = sharedHorizon + 1;
  const sharedAge = parseAge(sA.age) ?? parseAge(sB.age);

  renderCompareChart("chart", { A: simA, B: simB }, {
    horizonYears: sharedHorizon,
    currentAge: sharedAge,
    names,
  });

  ensureOutputSkeleton("compare");

  // Probability over time.
  const probA = pathProbability(simA, simB, sharedYears);
  const xYears = Array.from({ length: sharedYears }, (_, i) => i);

  renderProbChart("probChart", xYears, probA, {
    horizonYears: sharedHorizon,
    currentAge: sharedAge,
  });

  const q = (role) => els.output.querySelector(`[data-role="${role}"]`);

  // Chart headline uses "Plan A/B" fallback (reads more naturally than
  // "Scenario A/B" in a sentence) when subtitles are empty.
  const chartNames = {
    A: subs.A || "Plan A",
    B: subs.B || "Plan B",
  };
  q("probTitle").textContent = `Probability ${chartNames.A} finishes ahead of ${chartNames.B}`;

  // Identical per-scenario inputs → suppress callout, swap narrative
  // for an explainer. The bands & probability chart still render —
  // they're the visual evidence that the two configs match.
  const identical =
    sA.asset === sB.asset &&
    sA.startingBalance === sB.startingBalance &&
    sA.monthlyContribution === sB.monthlyContribution;

  if (identical) {
    q("callout").textContent = "";
    q("narrative").innerHTML = `
      <p>Both scenarios are configured identically. The small differences
      between the two fans are sampling noise — each scenario runs its own
      2,000-path simulation with independent random draws. Change at least
      one per-scenario input (asset class, starting balance, or monthly
      contribution) to see a meaningful comparison.</p>
    `;
  } else {
    q("callout").textContent = calloutText(probA, names);
    const aMedian = simA.p50[sharedHorizon];
    const bMedian = simB.p50[sharedHorizon];
    const higherIsA = aMedian >= bMedian;
    const regret = regretFraction(simA, simB, sharedHorizon, sharedHorizon, higherIsA);
    q("narrative").innerHTML = narrativeHTML(simA, simB, names, sharedHorizon, regret);
  }

  q("statbody").innerHTML = statRowsHTML(simA, simB, sA, sB, names, sharedHorizon);

  console.log(
    `sim ${(t1 - t0).toFixed(1)}ms · compare · ` +
    `A=${sA.asset}/${sA.horizonYears}y · B=${sB.asset}/${sB.horizonYears}y`
  );
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

function openModal() {
  els.paramsModal.showModal();
  // Render the bell curves lazily on first open, when the dialog has
  // real dimensions so Plotly sizes correctly.
  if (!bellCurvesRendered) {
    renderBellCurves("bellCurves", PROFILES);
    bellCurvesRendered = true;
  }
}

function closeModal() {
  els.paramsModal.close();
}

els.paramsBtn.addEventListener("click", openModal);
els.paramsModal.querySelector(".modal-close").addEventListener("click", closeModal);
// Click on backdrop (i.e. on the dialog element itself, outside the content) closes.
els.paramsModal.addEventListener("click", (e) => {
  if (e.target === els.paramsModal) closeModal();
});

// Boot.
populateParamsTable();
renderControls();
run();
