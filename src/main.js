import { PROFILES, DEFAULT_PROFILE } from "./profiles.js";
import { simulate } from "./sim.js";
import { renderChart } from "./chart.js";

const $ = (id) => document.getElementById(id);

const els = {
  age: $("age"),
  horizon: $("horizon"),
  horizonOut: $("horizonOut"),
  starting: $("starting"),
  monthly: $("monthly"),
  asset: $("asset"),
  assetMeta: $("assetMeta"),
  summary: $("summary"),
};

// Populate asset dropdown from PROFILES.
function populateAssets() {
  for (const name of Object.keys(PROFILES)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === DEFAULT_PROFILE) opt.selected = true;
    els.asset.appendChild(opt);
  }
}

function readInputs() {
  const ageRaw = els.age.value.trim();
  const currentAge = ageRaw === "" ? null : Math.max(0, Math.floor(Number(ageRaw)));
  const horizonYears = Number(els.horizon.value);
  const startingBalance = Math.max(0, Number(els.starting.value) || 0);
  const monthlyContribution = Math.max(0, Number(els.monthly.value) || 0);
  const assetName = els.asset.value;
  const { mu, sigma } = PROFILES[assetName];
  return { currentAge, horizonYears, startingBalance, monthlyContribution, assetName, mu, sigma };
}

function fmtMoney(v) {
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function updateSummary(inputs, sim) {
  const last = sim.xYears.length - 1;
  const totalContrib = inputs.startingBalance + inputs.monthlyContribution * 12 * inputs.horizonYears;
  els.summary.innerHTML = `
    <div class="stat">
      <div class="stat-label">Total contributed</div>
      <div class="stat-value">${fmtMoney(totalContrib)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Steady return @ ${(inputs.mu * 100).toFixed(1)}%</div>
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

function updateAssetMeta(inputs) {
  els.assetMeta.textContent =
    `μ = ${(inputs.mu * 100).toFixed(1)}% · σ = ${(inputs.sigma * 100).toFixed(0)}%`;
}

let rafHandle = null;
function scheduleRun() {
  // Coalesce rapid input events (slider drag, number spinner) into one run per frame.
  if (rafHandle != null) return;
  rafHandle = requestAnimationFrame(() => {
    rafHandle = null;
    run();
  });
}

function run() {
  const inputs = readInputs();
  els.horizonOut.textContent = String(inputs.horizonYears);
  updateAssetMeta(inputs);

  const t0 = performance.now();
  const sim = simulate({
    horizonYears: inputs.horizonYears,
    startingBalance: inputs.startingBalance,
    monthlyContribution: inputs.monthlyContribution,
    mu: inputs.mu,
    sigma: inputs.sigma,
  });
  const t1 = performance.now();

  renderChart("chart", sim, {
    horizonYears: inputs.horizonYears,
    currentAge: inputs.currentAge,
  });
  updateSummary(inputs, sim);

  // Useful while iterating — kept lightweight.
  console.log(`sim ${(t1 - t0).toFixed(1)}ms · ${inputs.assetName} · ${inputs.horizonYears}y`);
}

function attachListeners() {
  for (const el of [els.age, els.horizon, els.starting, els.monthly, els.asset]) {
    el.addEventListener("input", scheduleRun);
    el.addEventListener("change", scheduleRun);
  }
}

populateAssets();
attachListeners();
run();
