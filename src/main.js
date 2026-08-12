// Phase A — multi-portfolio input panel + plan state model.
//
// This file owns rendering and persistence; src/planState.js owns the
// state shape, defaults, validation, and derived summaries (pure +
// unit-tested). The projection engine arrives in Phase B — the chart
// mount renders a placeholder until then.

import { PROFILES, realMu } from "./profiles.js";
import {
  defaultState, createPortfolio, createCashflow, createLumpSum,
  clampPlan, clampAllToPlan, clampCashflow, clampLumpSum,
  clampInt, clampNumber, serialize, hydrate,
  summarise, planSummaryText,
} from "./planState.js";
import { renderBellCurves } from "./chart.js";

// Legacy insight modules (firstDecade, drawdownTolerance, tornado,
// sequenceRisk) are stubbed out this phase. Their source files stay in
// the repo untouched and their mounts remain in index.html; they return
// as collapsed accordions in the insights phase. Deliberately NOT
// imported while disabled — tornado.js spins up a Web Worker at module
// scope, so a static import would run it.
const LEGACY_INSIGHTS_ENABLED = false;

const STORAGE_KEY = "portfolioPlanner.v1";
const PROFILE_KEYS = Object.keys(PROFILES);

const $ = (id) => document.getElementById(id);

const els = {
  planCurrentAge: $("planCurrentAge"),
  planEndAge: $("planEndAge"),
  planStartYear: $("planStartYear"),
  planSummary: document.querySelector('[data-role="planSummary"]'),
  portfolios: $("portfolios"),
  addPortfolioBtn: $("addPortfolioBtn"),
  summaryStrip: $("summaryStrip"),
  chartNote: document.querySelector('[data-role="chartNote"]'),
  displayOptions: document.querySelectorAll(".display-option"),
  paramsBtn: $("paramsBtn"),
  paramsModal: $("paramsModal"),
  paramAssetTable: $("paramAssetTable"),
  inflationInput: $("inflationInput"),
};

// --- state + persistence ----------------------------------------------

let state = loadState();
// Collapse state is UI-only — not persisted, keyed by portfolio id.
const collapsed = new Map();

function loadState() {
  try {
    const blob = localStorage.getItem(STORAGE_KEY);
    if (blob) {
      const s = hydrate(blob, PROFILE_KEYS);
      if (s) return s;
    }
  } catch { /* storage unavailable — fall through to defaults */ }
  return defaultState(PROFILE_KEYS);
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(state));
  } catch { /* quota/unavailable — non-fatal */ }
}

function findPortfolio(pid) {
  return state.portfolios.find((p) => p.id === pid) || null;
}

// --- formatting ---------------------------------------------------------

const fmtMoney = (v) =>
  v.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

// --- plan bar -----------------------------------------------------------

function renderPlanBar() {
  els.planCurrentAge.value = state.plan.currentAge;
  els.planEndAge.value = state.plan.endAge;
  els.planStartYear.value = state.plan.startYear;
  els.planSummary.textContent = planSummaryText(state.plan);
}

function onPlanChange() {
  const next = clampPlan({
    currentAge: els.planCurrentAge.value,
    endAge: els.planEndAge.value,
    startYear: els.planStartYear.value,
  });
  state.plan = next;
  state = clampAllToPlan(state); // silently clamp existing rows
  saveState();
  renderPlanBar();
  renderPortfolios(); // row values may have been clamped
  renderSummaryStrip();
}

for (const el of [els.planCurrentAge, els.planEndAge, els.planStartYear]) {
  el.addEventListener("change", onPlanChange);
}

// --- portfolio cards ------------------------------------------------------

function profileOptions(selected) {
  return PROFILE_KEYS.map(
    (k) => `<option value="${k}"${k === selected ? " selected" : ""}>${k}</option>`
  ).join("");
}

function cashflowRowHTML(pid, kind, cf) {
  return `
    <div class="cf-row" data-cfid="${cf.id}">
      <div class="cf-cell">
        <label>Amount ($)</label>
        <input type="number" min="0" step="100" value="${cf.amount}"
               data-pid="${pid}" data-kind="${kind}" data-cfid="${cf.id}" data-field="amount" />
      </div>
      <div class="cf-cell">
        <label>Frequency</label>
        <select data-pid="${pid}" data-kind="${kind}" data-cfid="${cf.id}" data-field="frequency">
          <option value="monthly"${cf.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${cf.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </div>
      <div class="cf-cell">
        <label>From age</label>
        <input type="number" min="18" max="120" step="1" value="${cf.fromAge}"
               data-pid="${pid}" data-kind="${kind}" data-cfid="${cf.id}" data-field="fromAge" />
      </div>
      <div class="cf-cell">
        <label>To age</label>
        <input type="number" min="18" max="120" step="1" value="${cf.toAge}"
               data-pid="${pid}" data-kind="${kind}" data-cfid="${cf.id}" data-field="toAge" />
      </div>
      <div class="cf-cell cf-indexed">
        <label>Indexed</label>
        <input type="checkbox"${cf.indexed ? " checked" : ""}
               data-pid="${pid}" data-kind="${kind}" data-cfid="${cf.id}" data-field="indexed"
               title="Indexed cashflows keep their real value; non-indexed are fixed in nominal dollars and shrink by CPI each year in real terms." />
      </div>
      <button class="cf-remove" type="button" aria-label="Remove row"
              data-action="remove-row" data-pid="${pid}" data-kind="${kind}" data-cfid="${cf.id}">×</button>
    </div>
  `;
}

function lumpSumRowHTML(pid, ls) {
  return `
    <div class="cf-row cf-row-lump" data-cfid="${ls.id}">
      <div class="cf-cell">
        <label>Amount ($)</label>
        <input type="number" min="0" step="1000" value="${ls.amount}"
               data-pid="${pid}" data-kind="lumpSums" data-cfid="${ls.id}" data-field="amount" />
      </div>
      <div class="cf-cell">
        <label>Direction</label>
        <select data-pid="${pid}" data-kind="lumpSums" data-cfid="${ls.id}" data-field="direction">
          <option value="in"${ls.direction === "in" ? " selected" : ""}>In (deposit)</option>
          <option value="out"${ls.direction === "out" ? " selected" : ""}>Out (withdrawal)</option>
        </select>
      </div>
      <div class="cf-cell">
        <label>At age</label>
        <input type="number" min="18" max="120" step="1" value="${ls.age}"
               data-pid="${pid}" data-kind="lumpSums" data-cfid="${ls.id}" data-field="age" />
      </div>
      <button class="cf-remove" type="button" aria-label="Remove row"
              data-action="remove-row" data-pid="${pid}" data-kind="lumpSums" data-cfid="${ls.id}">×</button>
    </div>
  `;
}

function portfolioCardHTML(p) {
  const isCollapsed = collapsed.get(p.id) === true;
  const excluded = !p.include;

  const head = `
    <div class="pcard-head" data-action="toggle-collapse" data-pid="${p.id}">
      <button class="pcard-chevron${isCollapsed ? "" : " open"}" type="button"
              aria-label="${isCollapsed ? "Expand" : "Collapse"}"
              data-action="toggle-collapse" data-pid="${p.id}">▸</button>
      <span class="pcard-name" data-role="headName">${escapeHTML(p.name)}</span>
      <span class="pcard-meta" data-role="headMeta">${escapeHTML(p.profile || "")} · ${fmtMoney(p.balance)}</span>
      <label class="pcard-include" title="Include in projection totals">
        <input type="checkbox"${p.include ? " checked" : ""}
               data-action="toggle-include" data-pid="${p.id}" />
        <span>Include</span>
      </label>
      ${state.portfolios.length > 1 ? `
        <button class="pcard-remove" type="button" data-action="remove-portfolio" data-pid="${p.id}">Remove</button>
      ` : ""}
    </div>
  `;

  if (isCollapsed) {
    return `<div class="pcard${excluded ? " excluded" : ""}" data-pid="${p.id}">${head}</div>`;
  }

  const body = `
    <div class="pcard-body">
      <div class="pcard-details">
        <div class="cf-cell pcard-name-cell">
          <label>Name</label>
          <input type="text" value="${escapeHTML(p.name)}" maxlength="60"
                 data-pid="${p.id}" data-field="name" />
        </div>
        <div class="cf-cell">
          <label>Risk profile</label>
          <select data-pid="${p.id}" data-field="profile">${profileOptions(p.profile)}</select>
        </div>
        <div class="cf-cell">
          <label>Starting balance ($)</label>
          <input type="number" min="0" step="1000" value="${p.balance}"
                 data-pid="${p.id}" data-field="balance" />
        </div>
      </div>

      <div class="pcard-fees">
        <div class="cf-cell">
          <label>Adviser fee (% p.a.)</label>
          <input type="number" min="0" max="100" step="0.01" value="${p.fees.adviserPct}"
                 data-pid="${p.id}" data-field="fees.adviserPct" />
        </div>
        <div class="cf-cell">
          <label>ICR (% p.a.)</label>
          <input type="number" min="0" max="100" step="0.01" value="${p.fees.icrPct}"
                 data-pid="${p.id}" data-field="fees.icrPct" />
        </div>
        <div class="cf-cell">
          <label>Flat fee ($ p.a.)</label>
          <input type="number" min="0" step="10" value="${p.fees.flatPa}"
                 data-pid="${p.id}" data-field="fees.flatPa" />
        </div>
      </div>

      <div class="cf-section">
        <div class="cf-section-title">Contributions</div>
        ${p.contributions.map((c) => cashflowRowHTML(p.id, "contributions", c)).join("")}
        <button class="add-row-btn" type="button" data-action="add-row" data-pid="${p.id}" data-kind="contributions">+ Add contribution</button>
      </div>

      <div class="cf-section">
        <div class="cf-section-title">Withdrawals</div>
        ${p.withdrawals.map((w) => cashflowRowHTML(p.id, "withdrawals", w)).join("")}
        <button class="add-row-btn" type="button" data-action="add-row" data-pid="${p.id}" data-kind="withdrawals">+ Add withdrawal</button>
      </div>

      <div class="cf-section">
        <div class="cf-section-title">Lump sums</div>
        ${p.lumpSums.map((l) => lumpSumRowHTML(p.id, l)).join("")}
        <button class="add-row-btn" type="button" data-action="add-row" data-pid="${p.id}" data-kind="lumpSums">+ Add lump sum</button>
      </div>
    </div>
  `;

  return `<div class="pcard${excluded ? " excluded" : ""}" data-pid="${p.id}">${head}${body}</div>`;
}

function escapeHTML(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderPortfolios() {
  els.portfolios.innerHTML = state.portfolios.map(portfolioCardHTML).join("");
}

// Targeted header refresh so typing in name/balance doesn't rebuild
// the card (which would drop input focus).
function refreshCardHead(pid) {
  const p = findPortfolio(pid);
  const card = els.portfolios.querySelector(`.pcard[data-pid="${pid}"]`);
  if (!p || !card) return;
  const nameEl = card.querySelector('[data-role="headName"]');
  const metaEl = card.querySelector('[data-role="headMeta"]');
  if (nameEl) nameEl.textContent = p.name;
  if (metaEl) metaEl.textContent = `${p.profile || ""} · ${fmtMoney(p.balance)}`;
}

// --- field mutation (delegated) -------------------------------------------

// 'input' events: write state, refresh summaries, never rebuild DOM
// (keeps focus). 'change' events additionally clamp and sync the field.
els.portfolios.addEventListener("input", (e) => {
  applyFieldEdit(e.target, false);
});
els.portfolios.addEventListener("change", (e) => {
  applyFieldEdit(e.target, true);
});

function applyFieldEdit(el, commit) {
  const pid = el.dataset.pid;
  const field = el.dataset.field;
  if (!pid || !field) return;
  const p = findPortfolio(pid);
  if (!p) return;

  const kind = el.dataset.kind;
  if (kind) {
    const row = p[kind]?.find((r) => r.id === el.dataset.cfid);
    if (!row) return;
    applyRowEdit(p, kind, row, field, el, commit);
  } else {
    applyPortfolioEdit(p, field, el, commit);
  }

  saveState();
  refreshCardHead(pid);
  renderSummaryStrip();
}

function applyPortfolioEdit(p, field, el, commit) {
  switch (field) {
    case "name":
      p.name = el.value.trim() || p.name;
      if (!commit) p.name = el.value; // allow transient empty while typing
      break;
    case "profile":
      p.profile = PROFILE_KEYS.includes(el.value) ? el.value : p.profile;
      break;
    case "balance":
      p.balance = clampNumber(el.value, 0);
      if (commit) el.value = p.balance;
      break;
    case "fees.adviserPct":
      p.fees.adviserPct = clampNumber(el.value, 0, 100);
      if (commit) el.value = p.fees.adviserPct;
      break;
    case "fees.icrPct":
      p.fees.icrPct = clampNumber(el.value, 0, 100);
      if (commit) el.value = p.fees.icrPct;
      break;
    case "fees.flatPa":
      p.fees.flatPa = clampNumber(el.value, 0);
      if (commit) el.value = p.fees.flatPa;
      break;
  }
}

function applyRowEdit(p, kind, row, field, el, commit) {
  const plan = state.plan;
  switch (field) {
    case "amount":
      row.amount = clampNumber(el.value, 0);
      if (commit) el.value = row.amount;
      break;
    case "frequency":
      row.frequency = el.value === "annual" ? "annual" : "monthly";
      break;
    case "indexed":
      row.indexed = el.checked;
      break;
    case "direction":
      row.direction = el.value === "out" ? "out" : "in";
      break;
    case "fromAge": {
      if (!commit) return; // ages validate on commit only
      const v = clampInt(el.value, plan.currentAge, plan.endAge);
      row.fromAge = v;
      if (row.toAge < v) row.toAge = v;
      flagIfClamped(el, v);
      syncRowAges(el, row);
      break;
    }
    case "toAge": {
      if (!commit) return;
      const v = clampInt(el.value, row.fromAge, plan.endAge);
      row.toAge = v;
      flagIfClamped(el, v);
      break;
    }
    case "age": { // lump sum
      if (!commit) return;
      const v = clampInt(el.value, plan.currentAge, plan.endAge);
      row.age = v;
      flagIfClamped(el, v);
      break;
    }
  }
}

// Inline validation feedback: if the committed value differs from what
// the user typed, snap the field to the clamped value and flash it.
function flagIfClamped(el, clampedValue) {
  const typed = Number(el.value);
  el.value = clampedValue;
  if (Number.isFinite(typed) && typed !== clampedValue) {
    el.classList.add("field-clamped");
    setTimeout(() => el.classList.remove("field-clamped"), 1200);
  }
}

// When fromAge pushes toAge, reflect it in the sibling input.
function syncRowAges(el, row) {
  const rowEl = el.closest(".cf-row");
  const toEl = rowEl?.querySelector('[data-field="toAge"]');
  if (toEl) toEl.value = row.toAge;
}

// --- structural actions (delegated clicks) ----------------------------------

els.portfolios.addEventListener("click", (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const pid = target.dataset.pid;
  const p = findPortfolio(pid);
  if (!p) return;

  switch (action) {
    case "toggle-collapse": {
      // Ignore clicks that were really on the include checkbox/remove btn.
      if (e.target.closest(".pcard-include") || e.target.closest(".pcard-remove")) return;
      collapsed.set(pid, !(collapsed.get(pid) === true));
      renderPortfolios();
      break;
    }
    case "toggle-include": {
      p.include = e.target.checked;
      saveState();
      els.portfolios.querySelector(`.pcard[data-pid="${pid}"]`)?.classList.toggle("excluded", !p.include);
      renderSummaryStrip();
      break;
    }
    case "remove-portfolio": {
      if (state.portfolios.length <= 1) return;
      if (!window.confirm(`Remove "${p.name}"? Its inputs will be lost.`)) return;
      state.portfolios = state.portfolios.filter((x) => x.id !== pid);
      collapsed.delete(pid);
      saveState();
      renderPortfolios();
      renderSummaryStrip();
      break;
    }
    case "add-row": {
      const kind = target.dataset.kind;
      if (kind === "lumpSums") p.lumpSums.push(createLumpSum(state.plan));
      else if (kind === "withdrawals") p.withdrawals.push(createCashflow("withdrawal", state.plan));
      else if (kind === "contributions") p.contributions.push(createCashflow("contribution", state.plan));
      saveState();
      renderPortfolios();
      renderSummaryStrip();
      break;
    }
    case "remove-row": {
      const kind = target.dataset.kind;
      const cfid = target.dataset.cfid;
      if (p[kind]) p[kind] = p[kind].filter((r) => r.id !== cfid);
      saveState();
      renderPortfolios();
      renderSummaryStrip();
      break;
    }
  }
});

els.addPortfolioBtn.addEventListener("click", () => {
  const p = createPortfolio(state.plan, state.portfolios, PROFILE_KEYS);
  state.portfolios.push(p);
  collapsed.set(p.id, false);
  saveState();
  renderPortfolios();
  renderSummaryStrip();
});

// --- summary strip ------------------------------------------------------

function renderSummaryStrip() {
  const s = summarise(state);
  els.summaryStrip.innerHTML = `
    <div class="stat">
      <div class="stat-label">Total starting balance</div>
      <div class="stat-value">${fmtMoney(s.totalBalance)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Portfolios included</div>
      <div class="stat-value">${s.includedCount} of ${state.portfolios.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Regular contributions (annualised)</div>
      <div class="stat-value">${fmtMoney(s.annualContributions)} /yr</div>
    </div>
  `;
}

// --- chart placeholder (Phase B replaces this) ------------------------------

function renderChartPlaceholder() {
  Plotly.newPlot("chart", [], {
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    xaxis: { visible: false },
    yaxis: { visible: false },
    annotations: [{
      text: "Projection engine arrives in Phase B",
      xref: "paper", yref: "paper", x: 0.5, y: 0.5,
      showarrow: false,
      font: { size: 15, color: "#5b6470", family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
    }],
    margin: { l: 20, r: 20, t: 20, b: 20 },
  }, { displayModeBar: false, responsive: true });
}

// --- display units toggle ----------------------------------------------------

function applyUnitsLabel() {
  const nominal = state.display.units === "nominal";
  const pct = (state.assumptions.cpi * 100).toFixed(1).replace(/\.0$/, "");
  els.chartNote.textContent = nominal
    ? `All values in future dollars (nominal, ${pct}% inflation assumed)`
    : "All values in today's dollars (CPI-adjusted)";
  els.displayOptions.forEach((btn) => {
    const active = btn.dataset.units === state.display.units;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

els.displayOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    const u = btn.dataset.units;
    if (u !== "real" && u !== "nominal") return;
    state.display.units = u;
    saveState();
    applyUnitsLabel();
    // Phase B: re-render projection in the selected units.
  });
});

// --- Parameters modal ---------------------------------------------------------

function populateParamsTable() {
  const cpi = state.assumptions.cpi;
  els.paramAssetTable.innerHTML = Object.entries(PROFILES).map(
    ([name, p]) => `
      <tr>
        <td>${name}</td>
        <td>${(p.incomeReturn * 100).toFixed(2)}%</td>
        <td>${(p.growthReturn * 100).toFixed(2)}%</td>
        <td>${(p.totalNominal * 100).toFixed(2)}%</td>
        <td>${(realMu(p, cpi) * 100).toFixed(2)}%</td>
        <td>${(p.sigma * 100).toFixed(1)}%</td>
      </tr>
    `
  ).join("");
}

function openModal(scrollToId = null) {
  els.paramsModal.showModal();
  renderBellCurves("bellCurves", PROFILES, state.assumptions.cpi);
  if (scrollToId) {
    const target = els.paramsModal.querySelector(`#${scrollToId}`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

els.paramsBtn.addEventListener("click", () => openModal());
els.paramsModal.querySelector(".modal-close").addEventListener("click", () => els.paramsModal.close());
els.paramsModal.addEventListener("click", (e) => {
  if (e.target === els.paramsModal) els.paramsModal.close();
});

els.inflationInput.addEventListener("change", () => {
  const n = Number(els.inflationInput.value);
  if (!Number.isFinite(n) || n < 0 || n > 20) {
    els.inflationInput.value = (state.assumptions.cpi * 100).toFixed(1);
    return;
  }
  state.assumptions.cpi = n / 100;
  saveState();
  applyUnitsLabel();
  populateParamsTable();
  renderBellCurves("bellCurves", PROFILES, state.assumptions.cpi);
  // Phase B: re-run projection (real returns derive from CPI).
});

// --- boot -----------------------------------------------------------------

renderPlanBar();
renderPortfolios();
renderSummaryStrip();
renderChartPlaceholder();
applyUnitsLabel();
populateParamsTable();
els.inflationInput.value = (state.assumptions.cpi * 100).toFixed(1);

if (LEGACY_INSIGHTS_ENABLED) {
  // Placeholder: insights phase re-mounts firstDecade, drawdownTolerance,
  // tornado, and sequenceRisk here as collapsed accordions.
}
