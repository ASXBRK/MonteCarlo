import { PROFILES, DEFAULT_PROFILE } from "./profiles.js";
import { simulate } from "./sim.js";
import { renderChart, renderCompareChart, renderProbChart } from "./chart.js";

const $ = (id) => document.getElementById(id);

const els = {
  toggle: $("compareToggle"),
  scenarios: $("scenarios"),
  summary: $("summary"),
  compareExtras: $("compareExtras"),
  callout: $("callout"),
  narrative: $("narrative"),
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
  grid.innerHTML = `
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

function renderControls() {
  els.scenarios.innerHTML = "";
  els.scenarios.className = `scenarios ${state.compareMode ? "compare" : "single"}`;
  els.scenarios.appendChild(buildScenarioBlock("A", state.scenarios.A));
  if (state.compareMode) {
    els.scenarios.appendChild(buildScenarioBlock("B", state.scenarios.B));
  }
}

// --- subtitle / diff ------------------------------------------------------

function describeField(field, value) {
  switch (field) {
    case "asset": return value;
    case "horizonYears": return `${value}y`;
    case "startingBalance": return `${fmtMoneyShort(value)} start`;
    case "monthlyContribution": return `${fmtMoneyShort(value)}/mo`;
    default: return String(value);
  }
}

// Returns the per-scenario subtitle text, or "" if nothing differs.
function computeSubtitles(a, b) {
  const fields = ["asset", "horizonYears", "startingBalance", "monthlyContribution"];
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
  const ho = block.querySelector('[data-role="horizonOut"]');
  if (ho) ho.textContent = String(state.scenarios[id].horizonYears);
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

function renderSingleSummary(s, sim) {
  const last = sim.xYears.length - 1;
  const totalContrib = s.startingBalance + s.monthlyContribution * 12 * s.horizonYears;
  els.summary.className = "summary single";
  els.summary.innerHTML = `
    <div class="stat">
      <div class="stat-label">Total contributed</div>
      <div class="stat-value">${fmtMoney(totalContrib)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Steady return @ ${(PROFILES[s.asset].mu * 100).toFixed(1)}%</div>
      <div class="stat-value">${fmtMoney(sim.deterministic[last])}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Median outcome</div>
      <div class="stat-value">${fmtMoney(sim.p50[last])}</div>
    </div>
    <div class="stat range">
      <div class="stat-label">5th – 95th percentile</div>
      <div class="stat-value">${fmtMoney(sim.p05[last])} – ${fmtMoney(sim.p95[last])}</div>
    </div>
  `;
}

function runSingle() {
  const s = state.scenarios.A;
  const { mu, sigma } = PROFILES[s.asset];
  applyAssetMeta("A", mu, sigma);

  const t0 = performance.now();
  const sim = runScenario(s);
  const t1 = performance.now();

  renderChart("chart", sim, {
    horizonYears: s.horizonYears,
    currentAge: parseAge(s.age),
  });
  renderSingleSummary(s, sim);

  els.compareExtras.hidden = true;
  console.log(`sim ${(t1 - t0).toFixed(1)}ms · single · ${s.asset} · ${s.horizonYears}y`);
}

// --- compare-mode rendering ----------------------------------------------

// P(A_i(t) > B_i(t)) for each year t in [0, sharedYears).
function pathProbability(simA, simB, sharedYears) {
  const n = Math.min(simA.numPaths, simB.numPaths);
  const yearsA = simA.years;
  const yearsB = simB.years;
  const out = new Array(sharedYears);
  for (let y = 0; y < sharedYears; y++) {
    let count = 0;
    for (let p = 0; p < n; p++) {
      if (simA.paths[p * yearsA + y] > simB.paths[p * yearsB + y]) count++;
    }
    out[y] = count / n;
  }
  return out;
}

// Fraction of paths where simA's terminal < simB's terminal.
function regretFraction(simA, simB, termIdxA, termIdxB, higherIsA) {
  const n = Math.min(simA.numPaths, simB.numPaths);
  const yearsA = simA.years;
  const yearsB = simB.years;
  let bad = 0;
  for (let p = 0; p < n; p++) {
    const a = simA.paths[p * yearsA + termIdxA];
    const b = simB.paths[p * yearsB + termIdxB];
    // "finish worse off in H than in L"
    if (higherIsA) {
      if (a < b) bad++;
    } else {
      if (b < a) bad++;
    }
  }
  return bad / n;
}

function renderCallout(probAGreater, names) {
  // Skip year 0 because at equal starting balances P is locked at 0.
  const start = 1;
  const end = probAGreater.length - 1;
  if (end < start) {
    els.callout.textContent = "";
    return;
  }

  let allAbove = true, allBelow = true;
  for (let y = start; y <= end; y++) {
    if (probAGreater[y] <= 0.5) allAbove = false;
    if (probAGreater[y] >= 0.5) allBelow = false;
  }

  let text = "";
  if (allAbove) {
    text = `${names.A} is more likely to lead throughout the entire horizon.`;
  } else if (allBelow) {
    text = `${names.B} is more likely to lead throughout the entire horizon.`;
  } else {
    const initialDir = probAGreater[start] > 0.5 ? "A" : "B";
    let flipYear = -1;
    let flipTo = null;
    for (let y = start + 1; y <= end; y++) {
      const dir = probAGreater[y] > 0.5 ? "A" : (probAGreater[y] < 0.5 ? "B" : null);
      if (dir && dir !== initialDir) {
        flipYear = y;
        flipTo = dir;
        break;
      }
    }
    if (flipYear === -1) {
      // Mostly straddles 50% — degenerate case.
      text = `${names.A} and ${names.B} stay close to 50/50 across the horizon.`;
    } else {
      text = `${names[flipTo]} becomes more likely to lead from Year ${flipYear}.`;
    }
  }

  els.callout.textContent = text;
}

function renderNarrative(simA, simB, sA, sB, names, sharedHorizon, regret) {
  const tA = sharedHorizon; // index of terminal year within shared range
  const tB = sharedHorizon;
  const aMedian = simA.p50[tA];
  const bMedian = simB.p50[tB];
  const aP5 = simA.p05[tA];
  const bP5 = simB.p05[tB];

  const higherIsA = aMedian >= bMedian;
  const Hname = higherIsA ? names.A : names.B;
  const Lname = higherIsA ? names.B : names.A;
  const Hmedian = higherIsA ? aMedian : bMedian;
  const Lmedian = higherIsA ? bMedian : aMedian;
  const Hp5 = higherIsA ? aP5 : bP5;
  const Lp5 = higherIsA ? bP5 : aP5;

  const premium = Math.round((Hmedian / Math.max(Lmedian, 1) - 1) * 100);
  const regretPct = Math.round(regret * 100);

  let tailSentence;
  if (Hp5 < Lp5) {
    tailSentence = `However, ${Hname}'s 5th-percentile outcome is ${fmtMoney(Hp5)} versus ${Lname}'s ${fmtMoney(Lp5)} — the extra upside comes with greater downside risk.`;
  } else {
    tailSentence = `${Hname} also has a higher worst-case outcome (${fmtMoney(Hp5)} at the 5th percentile, versus ${Lname}'s ${fmtMoney(Lp5)}) — one scenario dominates the other.`;
  }

  els.narrative.innerHTML = `
    <p>Over ${sharedHorizon} years, <strong>${Hname}</strong> ends with a median of
    <strong>${fmtMoney(Hmedian)}</strong> — about <strong>${premium}%</strong> above
    ${Lname}'s ${fmtMoney(Lmedian)}. ${tailSentence}
    There's a <strong>${regretPct}%</strong> chance you actually finish worse off in
    ${Hname} than you would have in ${Lname}.</p>
  `;
}

function renderCompareStatBlock(simA, simB, sA, sB, names, sharedHorizon) {
  const rowFor = (label, s, sim) => {
    const t = sharedHorizon;
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

  els.summary.className = "summary compare";
  els.summary.innerHTML = `
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
      <tbody>
        ${rowFor(names.A, sA, simA)}
        ${rowFor(names.B, sB, simB)}
      </tbody>
    </table>
  `;
}

function runCompare() {
  const sA = state.scenarios.A;
  const sB = state.scenarios.B;
  const profA = PROFILES[sA.asset];
  const profB = PROFILES[sB.asset];
  applyAssetMeta("A", profA.mu, profA.sigma);
  applyAssetMeta("B", profB.mu, profB.sigma);

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

  // Probability over time.
  const probA = pathProbability(simA, simB, sharedYears);
  const xYears = Array.from({ length: sharedYears }, (_, i) => i);

  els.compareExtras.hidden = false;
  renderProbChart("probChart", xYears, probA, {
    horizonYears: sharedHorizon,
    currentAge: sharedAge,
  });
  renderCallout(probA, names);

  // Narrative + stat block.
  const aMedian = simA.p50[sharedHorizon];
  const bMedian = simB.p50[sharedHorizon];
  const higherIsA = aMedian >= bMedian;
  const regret = regretFraction(simA, simB, sharedHorizon, sharedHorizon, higherIsA);
  renderNarrative(simA, simB, sA, sB, names, sharedHorizon, regret);
  renderCompareStatBlock(simA, simB, sA, sB, names, sharedHorizon);

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
    // Initialise B as a copy of A's current values.
    state.scenarios.B = { ...state.scenarios.A };
  } else {
    // Discard B's values.
    state.scenarios.B = { ...DEFAULTS };
  }
  renderControls();
  run();
});

// Boot.
renderControls();
run();
