// Phase A — multi-asset input panel + plan state model.
//
// This file owns rendering and persistence; src/planState.js owns the
// state shape, defaults, validation, and derived summaries (pure +
// unit-tested). The projection engine arrives in Phase B — the chart
// mount renders a placeholder until then.

import { PROFILES, realMu } from "./profiles.js";
import {
  defaultState, createAsset, createCashflow, createLumpSum,
  clampPlan, clampAllToPlan, clampAllocation, nearestVolBasis,
  clampInt, clampNumber, serialize, hydrate,
  summarise, planSummaryText, allocationSummary, ALLOC_PCT_MAX,
} from "./planState.js";
import { renderBellCurves } from "./chart.js";

// Legacy insight modules (firstDecade, drawdownTolerance, tornado,
// sequenceRisk) are stubbed out this phase. Their source files stay in
// the repo untouched and their mounts remain in index.html; they return
// as collapsed accordions in the insights phase. Deliberately NOT
// imported while disabled — tornado.js spins up a Web Worker at module
// scope, so a static import would run it.
const LEGACY_INSIGHTS_ENABLED = false;

const STORAGE_KEY = "projectionPlanner.v1";
const PROFILE_KEYS = Object.keys(PROFILES);

const $ = (id) => document.getElementById(id);

const els = {
  planCurrentAge: $("planCurrentAge"),
  planEndAge: $("planEndAge"),
  planStartYear: $("planStartYear"),
  planSummary: document.querySelector('[data-role="planSummary"]'),
  assets: $("assets"),
  addAssetBtn: $("addAssetBtn"),
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
// UI-only runtime state — none of this is persisted.
const collapsed = new Map();          // assetId → bool
const allocMemory = new Map();        // assetId → { profile?, custom? } last-used per mode
const volBasisTouched = new Set();    // assetIds where the user overrode volBasis

function loadState() {
  try {
    const blob = localStorage.getItem(STORAGE_KEY);
    if (blob) {
      const s = hydrate(blob, PROFILES);
      if (s) return s;
    }
  } catch { /* storage unavailable — fall through to defaults */ }
  return defaultState(PROFILES);
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(state));
  } catch { /* quota/unavailable — non-fatal */ }
}

function findAsset(aid) {
  return state.assets.find((a) => a.id === aid) || null;
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
  renderAssets(); // row values may have been clamped
  renderSummaryStrip();
}

for (const el of [els.planCurrentAge, els.planEndAge, els.planStartYear]) {
  el.addEventListener("change", onPlanChange);
}

// --- asset cards ------------------------------------------------------

function profileOptions(selected) {
  return PROFILE_KEYS.map(
    (k) => `<option value="${k}"${k === selected ? " selected" : ""}>${k}</option>`
  ).join("");
}

function cashflowRowHTML(aid, kind, cf) {
  return `
    <div class="cf-row" data-cfid="${cf.id}">
      <div class="cf-cell">
        <label>Amount ($)</label>
        <input type="number" min="0" step="100" value="${cf.amount}"
               data-aid="${aid}" data-kind="${kind}" data-cfid="${cf.id}" data-field="amount" />
      </div>
      <div class="cf-cell">
        <label>Frequency</label>
        <select data-aid="${aid}" data-kind="${kind}" data-cfid="${cf.id}" data-field="frequency">
          <option value="monthly"${cf.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${cf.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </div>
      <div class="cf-cell">
        <label>From age</label>
        <input type="number" min="18" max="120" step="1" value="${cf.fromAge}"
               data-aid="${aid}" data-kind="${kind}" data-cfid="${cf.id}" data-field="fromAge" />
      </div>
      <div class="cf-cell">
        <label>To age</label>
        <input type="number" min="18" max="120" step="1" value="${cf.toAge}"
               data-aid="${aid}" data-kind="${kind}" data-cfid="${cf.id}" data-field="toAge" />
      </div>
      <div class="cf-cell cf-indexed">
        <label>Indexed</label>
        <input type="checkbox"${cf.indexed ? " checked" : ""}
               data-aid="${aid}" data-kind="${kind}" data-cfid="${cf.id}" data-field="indexed"
               title="Indexed cashflows keep their real value; non-indexed are fixed in nominal dollars and shrink by CPI each year in real terms." />
      </div>
      <button class="cf-remove" type="button" aria-label="Remove row"
              data-action="remove-row" data-aid="${aid}" data-kind="${kind}" data-cfid="${cf.id}">×</button>
    </div>
  `;
}

function lumpSumRowHTML(aid, ls) {
  return `
    <div class="cf-row cf-row-lump" data-cfid="${ls.id}">
      <div class="cf-cell">
        <label>Amount ($)${ls.source === "table" ? ' <span class="cf-tag">from table</span>' : ""}</label>
        <input type="number" min="0" step="1000" value="${ls.amount}"
               data-aid="${aid}" data-kind="lumpSums" data-cfid="${ls.id}" data-field="amount" />
      </div>
      <div class="cf-cell">
        <label>Direction</label>
        <select data-aid="${aid}" data-kind="lumpSums" data-cfid="${ls.id}" data-field="direction">
          <option value="in"${ls.direction === "in" ? " selected" : ""}>In (deposit)</option>
          <option value="out"${ls.direction === "out" ? " selected" : ""}>Out (withdrawal)</option>
        </select>
      </div>
      <div class="cf-cell">
        <label>At age</label>
        <input type="number" min="18" max="120" step="1" value="${ls.age}"
               data-aid="${aid}" data-kind="lumpSums" data-cfid="${ls.id}" data-field="age" />
      </div>
      <button class="cf-remove" type="button" aria-label="Remove row"
              data-action="remove-row" data-aid="${aid}" data-kind="lumpSums" data-cfid="${ls.id}">×</button>
    </div>
  `;
}

function allocationSectionHTML(a) {
  const alloc = a.allocation;
  const isCustom = alloc.mode === "custom";
  const seg = `
    <div class="seg-toggle" role="radiogroup" aria-label="Allocation mode">
      <button class="seg-option${!isCustom ? " active" : ""}" type="button"
              data-action="alloc-mode" data-aid="${a.id}" data-mode="profile"
              aria-pressed="${!isCustom}">Firm profile</button>
      <button class="seg-option${isCustom ? " active" : ""}" type="button"
              data-action="alloc-mode" data-aid="${a.id}" data-mode="custom"
              aria-pressed="${isCustom}">Custom</button>
    </div>
  `;

  if (!isCustom) {
    return `
      <div class="cf-section">
        <div class="cf-section-title">Asset allocation</div>
        ${seg}
        <div class="alloc-grid alloc-grid-profile">
          <div class="cf-cell">
            <label>Risk profile</label>
            <select data-aid="${a.id}" data-field="alloc.profile">${profileOptions(alloc.profile)}</select>
          </div>
        </div>
      </div>
    `;
  }

  const total = (alloc.incomePct + alloc.growthPct).toFixed(2);
  return `
    <div class="cf-section">
      <div class="cf-section-title">Asset allocation</div>
      ${seg}
      <div class="alloc-grid">
        <div class="cf-cell">
          <label>Income (% p.a.)</label>
          <input type="number" min="0" max="${ALLOC_PCT_MAX}" step="0.05" value="${alloc.incomePct}"
                 data-aid="${a.id}" data-field="alloc.incomePct" />
        </div>
        <div class="cf-cell">
          <label>Growth (% p.a.)</label>
          <input type="number" min="0" max="${ALLOC_PCT_MAX}" step="0.05" value="${alloc.growthPct}"
                 data-aid="${a.id}" data-field="alloc.growthPct" />
        </div>
        <div class="cf-cell">
          <label>Franking (%)</label>
          <input type="number" min="0" max="100" step="1" value="${alloc.frankingPct}"
                 data-aid="${a.id}" data-field="alloc.frankingPct" />
        </div>
        <div class="cf-cell alloc-total">
          <label>&nbsp;</label>
          <div class="alloc-total-value" data-role="allocTotal-${a.id}">Total: ${total}% p.a. nominal</div>
        </div>
      </div>
      <div class="alloc-grid alloc-grid-vol">
        <div class="cf-cell">
          <label>Volatility basis</label>
          <select data-aid="${a.id}" data-field="alloc.volBasis">${profileOptions(alloc.volBasis)}</select>
        </div>
      </div>
      <p class="helper-text">Monte Carlo variability for this asset is modelled on the selected profile.</p>
    </div>
  `;
}

function assetCardHTML(a) {
  const isCollapsed = collapsed.get(a.id) === true;
  const excluded = !a.include;

  const head = `
    <div class="pcard-head" data-action="toggle-collapse" data-aid="${a.id}">
      <button class="pcard-chevron${isCollapsed ? "" : " open"}" type="button"
              aria-label="${isCollapsed ? "Expand" : "Collapse"}"
              data-action="toggle-collapse" data-aid="${a.id}">▸</button>
      <span class="pcard-name" data-role="headName">${escapeHTML(a.name)}</span>
      <span class="pcard-meta" data-role="headMeta">${escapeHTML(allocationSummary(a.allocation, PROFILES))} · ${fmtMoney(a.balance)}</span>
      <label class="pcard-include" title="Include in projection totals">
        <input type="checkbox"${a.include ? " checked" : ""}
               data-action="toggle-include" data-aid="${a.id}" />
        <span>Include</span>
      </label>
      ${state.assets.length > 1 ? `
        <button class="pcard-remove" type="button" data-action="remove-asset" data-aid="${a.id}">Remove</button>
      ` : ""}
    </div>
  `;

  if (isCollapsed) {
    return `<div class="pcard${excluded ? " excluded" : ""}" data-aid="${a.id}">${head}</div>`;
  }

  const body = `
    <div class="pcard-body">
      <div class="pcard-details">
        <div class="cf-cell pcard-name-cell">
          <label>Name</label>
          <input type="text" value="${escapeHTML(a.name)}" maxlength="60"
                 data-aid="${a.id}" data-field="name" />
        </div>
        <div class="cf-cell">
          <label>Current value ($)</label>
          <input type="number" min="0" step="1000" value="${a.balance}"
                 data-aid="${a.id}" data-field="balance" />
        </div>
      </div>

      ${allocationSectionHTML(a)}

      <div class="cf-section">
        <div class="cf-section-title">Costs</div>
        <div class="alloc-grid alloc-grid-profile">
          <div class="cf-cell">
            <label>ICR (% p.a.)</label>
            <input type="number" min="0" max="100" step="0.01" value="${a.icrPct}"
                   data-aid="${a.id}" data-field="icrPct" />
          </div>
        </div>
        <p class="helper-text">Advice fees can be added as a withdrawal.</p>
      </div>

      <div class="cf-section">
        <div class="cf-section-title">Capital gains tax</div>
        <label class="cgt-toggle">
          <input type="checkbox"${a.cgtAsset ? " checked" : ""}
                 data-aid="${a.id}" data-field="cgtAsset" />
          <span>CGT asset</span>
        </label>
        ${a.cgtAsset ? `
          <div class="alloc-grid alloc-grid-profile">
            <div class="cf-cell">
              <label>Cost base ($)</label>
              <input type="number" min="0" step="1000" value="${a.costBase ?? a.balance}"
                     data-aid="${a.id}" data-field="costBase" />
            </div>
          </div>
        ` : ""}
        <p class="helper-text">Used for capital gains tax modelling in a future version.</p>
      </div>

      <div class="cf-section">
        <div class="cf-section-title">Contributions</div>
        ${a.contributions.map((c) => cashflowRowHTML(a.id, "contributions", c)).join("")}
        <button class="add-row-btn" type="button" data-action="add-row" data-aid="${a.id}" data-kind="contributions">+ Add contribution</button>
      </div>

      <div class="cf-section">
        <div class="cf-section-title">Withdrawals</div>
        ${a.withdrawals.map((w) => cashflowRowHTML(a.id, "withdrawals", w)).join("")}
        <button class="add-row-btn" type="button" data-action="add-row" data-aid="${a.id}" data-kind="withdrawals">+ Add withdrawal</button>
      </div>

      <div class="cf-section">
        <div class="cf-section-title">Lump sums</div>
        ${a.lumpSums.map((l) => lumpSumRowHTML(a.id, l)).join("")}
        <button class="add-row-btn" type="button" data-action="add-row" data-aid="${a.id}" data-kind="lumpSums">+ Add lump sum</button>
      </div>
    </div>
  `;

  return `<div class="pcard${excluded ? " excluded" : ""}" data-aid="${a.id}">${head}${body}</div>`;
}

function escapeHTML(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderAssets() {
  els.assets.innerHTML = state.assets.map(assetCardHTML).join("");
}

// Targeted header refresh so typing in name/balance doesn't rebuild
// the card (which would drop input focus).
function refreshCardHead(aid) {
  const a = findAsset(aid);
  const card = els.assets.querySelector(`.pcard[data-aid="${aid}"]`);
  if (!a || !card) return;
  const nameEl = card.querySelector('[data-role="headName"]');
  const metaEl = card.querySelector('[data-role="headMeta"]');
  if (nameEl) nameEl.textContent = a.name;
  if (metaEl) metaEl.textContent = `${allocationSummary(a.allocation, PROFILES)} · ${fmtMoney(a.balance)}`;
}

function refreshAllocTotal(aid) {
  const a = findAsset(aid);
  if (!a || a.allocation.mode !== "custom") return;
  const el = document.querySelector(`[data-role="allocTotal-${aid}"]`);
  if (el) {
    el.textContent = `Total: ${(a.allocation.incomePct + a.allocation.growthPct).toFixed(2)}% p.a. nominal`;
  }
}

// If the user hasn't manually chosen a volatility basis, keep it
// tracking the nearest-return profile as income/growth change.
function retargetVolBasis(aid) {
  const a = findAsset(aid);
  if (!a || a.allocation.mode !== "custom" || volBasisTouched.has(aid)) return;
  const next = nearestVolBasis(PROFILES, a.allocation.incomePct + a.allocation.growthPct);
  if (next && next !== a.allocation.volBasis) {
    a.allocation.volBasis = next;
    const sel = els.assets.querySelector(`[data-aid="${aid}"][data-field="alloc.volBasis"]`);
    if (sel) sel.value = next;
  }
}

// --- field mutation (delegated) -------------------------------------------

// 'input' events: write state, refresh summaries, never rebuild DOM
// (keeps focus). 'change' events additionally clamp and sync the field.
els.assets.addEventListener("input", (e) => {
  applyFieldEdit(e.target, false);
});
els.assets.addEventListener("change", (e) => {
  applyFieldEdit(e.target, true);
});

function applyFieldEdit(el, commit) {
  const aid = el.dataset.aid;
  const field = el.dataset.field;
  if (!aid || !field) return;
  const a = findAsset(aid);
  if (!a) return;

  const kind = el.dataset.kind;
  let structural = false;
  if (kind) {
    const row = a[kind]?.find((r) => r.id === el.dataset.cfid);
    if (!row) return;
    applyRowEdit(a, kind, row, field, el, commit);
  } else {
    structural = applyAssetEdit(a, field, el, commit);
  }

  saveState();
  if (structural) {
    renderAssets();
  } else {
    refreshCardHead(aid);
  }
  renderSummaryStrip();
}

// Returns true when the edit needs a structural re-render (e.g. the
// CGT checkbox toggling the cost-base field's existence).
function applyAssetEdit(a, field, el, commit) {
  switch (field) {
    case "name":
      a.name = commit ? (el.value.trim() || a.name) : el.value;
      if (commit) el.value = a.name;
      return false;
    case "balance":
      a.balance = clampNumber(el.value, 0);
      if (commit) el.value = a.balance;
      return false;
    case "icrPct":
      a.icrPct = clampNumber(el.value, 0, 100);
      if (commit) el.value = a.icrPct;
      return false;
    case "cgtAsset": {
      a.cgtAsset = el.checked;
      if (a.cgtAsset && a.costBase == null) a.costBase = a.balance; // default on first tick
      if (!a.cgtAsset) a.costBase = null;
      return true; // cost-base field appears/disappears
    }
    case "costBase":
      a.costBase = clampNumber(el.value, 0);
      if (commit) el.value = a.costBase;
      return false;
    case "alloc.profile":
      if (a.allocation.mode === "profile" && PROFILE_KEYS.includes(el.value)) {
        a.allocation.profile = el.value;
      }
      return false;
    case "alloc.incomePct":
      if (a.allocation.mode === "custom") {
        a.allocation.incomePct = clampNumber(el.value, 0, ALLOC_PCT_MAX);
        if (commit) el.value = a.allocation.incomePct;
        refreshAllocTotal(a.id);
        retargetVolBasis(a.id);
      }
      return false;
    case "alloc.growthPct":
      if (a.allocation.mode === "custom") {
        a.allocation.growthPct = clampNumber(el.value, 0, ALLOC_PCT_MAX);
        if (commit) el.value = a.allocation.growthPct;
        refreshAllocTotal(a.id);
        retargetVolBasis(a.id);
      }
      return false;
    case "alloc.frankingPct":
      if (a.allocation.mode === "custom") {
        a.allocation.frankingPct = clampNumber(el.value, 0, 100);
        if (commit) el.value = a.allocation.frankingPct;
      }
      return false;
    case "alloc.volBasis":
      if (a.allocation.mode === "custom" && PROFILE_KEYS.includes(el.value)) {
        a.allocation.volBasis = el.value;
        volBasisTouched.add(a.id); // user override — stop auto-tracking
      }
      return false;
  }
  return false;
}

function applyRowEdit(a, kind, row, field, el, commit) {
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

// --- allocation mode switching -----------------------------------------------

// Switching modes preserves the other mode's last values within the
// session (allocMemory). First switch to custom seeds income/growth
// from the current profile's split and pre-selects that profile as the
// volatility basis — the natural starting point.
function switchAllocMode(a, mode) {
  if (a.allocation.mode === mode) return;
  const mem = allocMemory.get(a.id) || {};
  mem[a.allocation.mode] = a.allocation; // stash outgoing mode
  if (mode === "custom") {
    if (mem.custom) {
      a.allocation = mem.custom;
    } else {
      const p = PROFILES[a.allocation.profile] || {};
      const incomePct = +((p.incomeReturn ?? 0) * 100).toFixed(2);
      const growthPct = +((p.growthReturn ?? 0) * 100).toFixed(2);
      a.allocation = clampAllocation({
        mode: "custom",
        incomePct, growthPct, frankingPct: 0,
        volBasis: a.allocation.profile,
      }, PROFILES);
    }
  } else {
    a.allocation = mem.profile || clampAllocation({ mode: "profile", profile: null }, PROFILES);
  }
  allocMemory.set(a.id, mem);
}

// --- structural actions (delegated clicks) ----------------------------------

els.assets.addEventListener("click", (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const aid = target.dataset.aid;
  const a = findAsset(aid);
  if (!a) return;

  switch (action) {
    case "toggle-collapse": {
      // Ignore clicks that were really on the include checkbox/remove btn.
      if (e.target.closest(".pcard-include") || e.target.closest(".pcard-remove")) return;
      collapsed.set(aid, !(collapsed.get(aid) === true));
      renderAssets();
      break;
    }
    case "toggle-include": {
      a.include = e.target.checked;
      saveState();
      els.assets.querySelector(`.pcard[data-aid="${aid}"]`)?.classList.toggle("excluded", !a.include);
      renderSummaryStrip();
      break;
    }
    case "remove-asset": {
      if (state.assets.length <= 1) return;
      if (!window.confirm(`Remove "${a.name}"? Its inputs will be lost.`)) return;
      state.assets = state.assets.filter((x) => x.id !== aid);
      collapsed.delete(aid);
      allocMemory.delete(aid);
      volBasisTouched.delete(aid);
      saveState();
      renderAssets();
      renderSummaryStrip();
      break;
    }
    case "alloc-mode": {
      switchAllocMode(a, target.dataset.mode === "custom" ? "custom" : "profile");
      saveState();
      renderAssets();
      renderSummaryStrip();
      break;
    }
    case "add-row": {
      const kind = target.dataset.kind;
      if (kind === "lumpSums") a.lumpSums.push(createLumpSum(state.plan));
      else if (kind === "withdrawals") a.withdrawals.push(createCashflow("withdrawal", state.plan));
      else if (kind === "contributions") a.contributions.push(createCashflow("contribution", state.plan));
      saveState();
      renderAssets();
      renderSummaryStrip();
      break;
    }
    case "remove-row": {
      const kind = target.dataset.kind;
      const cfid = target.dataset.cfid;
      if (a[kind]) a[kind] = a[kind].filter((r) => r.id !== cfid);
      saveState();
      renderAssets();
      renderSummaryStrip();
      break;
    }
  }
});

els.addAssetBtn.addEventListener("click", () => {
  const a = createAsset(state.plan, state.assets, PROFILES);
  state.assets.push(a);
  collapsed.set(a.id, false);
  saveState();
  renderAssets();
  renderSummaryStrip();
});

// --- summary strip ------------------------------------------------------

function renderSummaryStrip() {
  const s = summarise(state);
  els.summaryStrip.innerHTML = `
    <div class="stat">
      <div class="stat-label">Total current value</div>
      <div class="stat-value">${fmtMoney(s.totalBalance)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Assets included</div>
      <div class="stat-value">${s.includedCount} of ${state.assets.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Contributions (annualised)</div>
      <div class="stat-value">${fmtMoney(s.annualContributions)} /yr</div>
    </div>
    <div class="stat">
      <div class="stat-label">Withdrawals (annualised)</div>
      <div class="stat-value">${fmtMoney(s.annualWithdrawals)} /yr</div>
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
renderAssets();
renderSummaryStrip();
renderChartPlaceholder();
applyUnitsLabel();
populateParamsTable();
els.inflationInput.value = (state.assumptions.cpi * 100).toFixed(1);

if (LEGACY_INSIGHTS_ENABLED) {
  // Placeholder: insights phase re-mounts firstDecade, drawdownTolerance,
  // tornado, and sequenceRisk here as collapsed accordions.
}
