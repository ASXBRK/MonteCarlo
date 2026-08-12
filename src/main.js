// Phase A.2 — household, income & expenses, surplus/deficit settings.
//
// This file owns rendering and persistence; src/planState.js owns the
// state shape (schemaVersion 3), defaults, validation, migration, and
// derived summaries. The ledger that consumes these inputs arrives in
// Phase B; tax in B.1 — income is captured gross and the UI says so.

import { PROFILES, realMu } from "./profiles.js";
import {
  defaultState, createAsset, createCashflow, createLumpSum,
  createIncomeRow, createExpenseRow,
  clampPlan, clampAllToPlan, clampAllocation, clampIncomeRow,
  nearestVolBasis, normaliseSettings, normaliseFundingOrder,
  partnerOwnedItems, reassignPartnerToClient, deletePartnerOwned,
  removeAsset, ownerWindow, fyLabelForAge,
  clampInt, clampNumber, serialize, hydrate,
  summarise, planSummaryText, allocationSummary, ALLOC_PCT_MAX,
} from "./planState.js";
import { renderBellCurves } from "./chart.js";

// Legacy insight modules (firstDecade, drawdownTolerance, tornado,
// sequenceRisk) are stubbed out. Deliberately NOT imported while
// disabled — tornado.js spins up a Web Worker at module scope. They
// return as collapsed accordions in the insights phase.
const LEGACY_INSIGHTS_ENABLED = false;

const STORAGE_KEY = "projectionPlanner.v1";
const PROFILE_KEYS = Object.keys(PROFILES);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const $ = (id) => document.getElementById(id);

const els = {
  planBar: $("planBar"),
  assets: $("assets"),
  addAssetBtn: $("addAssetBtn"),
  incomeSection: $("incomeSection"),
  expensesSection: $("expensesSection"),
  investSection: $("investSection"),
  settingsPanel: $("settingsPanel"),
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
const collapsed = new Map();
const allocMemory = new Map();
const volBasisTouched = new Set();

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

function findRow(kind, id) {
  return state.cashflows[kind]?.find((r) => r.id === id) || null;
}

const fmtMoney = (v) =>
  v.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

function escapeHTML(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const isCouple = () => state.plan.household === "couple";

// --- plan bar -----------------------------------------------------------

function renderPlanBar() {
  const p = state.plan;
  els.planBar.innerHTML = `
    <div class="plan-field">
      <label>Household</label>
      <div class="seg-toggle">
        <button class="seg-option${p.household === "single" ? " active" : ""}" type="button"
                data-plan-action="household" data-value="single">Single</button>
        <button class="seg-option${p.household === "couple" ? " active" : ""}" type="button"
                data-plan-action="household" data-value="couple">Couple</button>
      </div>
    </div>
    <div class="plan-field">
      <label>${isCouple() ? "Client age" : "Current age"}</label>
      <input type="number" min="18" max="100" step="1" value="${p.client.currentAge}"
             data-plan-field="clientAge" />
    </div>
    ${isCouple() ? `
      <div class="plan-field">
        <label>Partner age</label>
        <input type="number" min="18" max="100" step="1" value="${p.partner.currentAge}"
               data-plan-field="partnerAge" />
      </div>
    ` : ""}
    <div class="plan-field">
      <label>Projection end age</label>
      <input type="number" min="19" max="120" step="1" value="${p.endAge}"
             data-plan-field="endAge" />
    </div>
    <div class="plan-field">
      <label>Start</label>
      <div class="plan-start">
        <select data-plan-field="startMonth">
          ${MONTH_NAMES.map((m, i) =>
            `<option value="${i + 1}"${p.start.month === i + 1 ? " selected" : ""}>${m}</option>`
          ).join("")}
        </select>
        <input type="number" min="1900" max="2200" step="1" value="${p.start.year}"
               data-plan-field="startYear" />
      </div>
    </div>
    <div class="plan-derived">${planSummaryText(p)}</div>
  `;
}

els.planBar.addEventListener("change", (e) => {
  const field = e.target.dataset.planField;
  if (!field) return;
  const p = state.plan;
  const next = {
    household: p.household,
    client: { currentAge: field === "clientAge" ? e.target.value : p.client.currentAge },
    partner: p.partner
      ? { currentAge: field === "partnerAge" ? e.target.value : p.partner.currentAge }
      : null,
    endAge: field === "endAge" ? e.target.value : p.endAge,
    start: {
      year: field === "startYear" ? e.target.value : p.start.year,
      month: field === "startMonth" ? e.target.value : p.start.month,
    },
  };
  state.plan = clampPlan(next);
  state = clampAllToPlan(state);
  saveState();
  renderAll();
});

els.planBar.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-plan-action="household"]');
  if (!btn) return;
  const target = btn.dataset.value;
  if (target === state.plan.household) return;

  if (target === "couple") {
    state.plan = clampPlan({
      ...state.plan,
      household: "couple",
      partner: { currentAge: state.plan.client.currentAge },
    });
  } else {
    // Couple → single: never orphan an owner.
    const owned = partnerOwnedItems(state);
    if (owned.count > 0) {
      const reassign = window.confirm(
        `${owned.count} item(s) are owned by the partner (or jointly): ` +
        `${owned.assets.map((a) => a.name).concat(owned.income.map((r) => r.label)).join(", ")}.\n\n` +
        `OK — reassign them to the client.\nCancel — choose what else to do.`
      );
      if (reassign) {
        state = reassignPartnerToClient(state);
      } else {
        const del = window.confirm("Delete the partner-owned items instead? Cancel keeps the household as a couple.");
        if (!del) { renderPlanBar(); return; } // abort the switch
        state = deletePartnerOwned(state);
      }
    }
    state.plan = clampPlan({ ...state.plan, household: "single", partner: null });
  }
  state = clampAllToPlan(state);
  saveState();
  renderAll();
});

// --- asset cards ------------------------------------------------------

function profileOptions(selected) {
  return PROFILE_KEYS.map(
    (k) => `<option value="${k}"${k === selected ? " selected" : ""}>${k}</option>`
  ).join("");
}

function ownerOptions(selected) {
  return ["client", "partner", "joint"].map(
    (o) => `<option value="${o}"${o === selected ? " selected" : ""}>${o[0].toUpperCase()}${o.slice(1)}</option>`
  ).join("");
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
      <span class="pcard-meta" data-role="headMeta">${escapeHTML(allocationSummary(a.allocation, PROFILES))} · ${fmtMoney(a.balance)}${isCouple() ? ` · ${a.owner}` : ""}</span>
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
      <div class="pcard-details${isCouple() ? " with-owner" : ""}">
        <div class="cf-cell pcard-name-cell">
          <label>Name</label>
          <input type="text" value="${escapeHTML(a.name)}" maxlength="60"
                 data-aid="${a.id}" data-field="name" />
        </div>
        ${isCouple() ? `
          <div class="cf-cell">
            <label>Owner</label>
            <select data-aid="${a.id}" data-field="owner">${ownerOptions(a.owner)}</select>
          </div>
        ` : ""}
        <div class="cf-cell">
          <label>Current value ($)</label>
          <input type="number" min="0" step="1000" value="${a.balance}"
                 data-aid="${a.id}" data-field="balance" />
        </div>
      </div>

      ${allocationSectionHTML(a)}

      <div class="cf-section">
        <div class="cf-section-title">Distributions</div>
        <div class="seg-toggle" role="radiogroup" aria-label="Distribution treatment">
          <button class="seg-option${a.distributions === "reinvest" ? " active" : ""}" type="button"
                  data-action="distributions" data-aid="${a.id}" data-value="reinvest">Reinvested</button>
          <button class="seg-option${a.distributions === "cash" ? " active" : ""}" type="button"
                  data-action="distributions" data-aid="${a.id}" data-value="cash">Paid as cash</button>
        </div>
        <p class="helper-text">Reinvested distributions stay in the asset. Paid-as-cash distributions enter the household ledger as the owner's income in that financial year.</p>
      </div>

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
    </div>
  `;

  return `<div class="pcard${excluded ? " excluded" : ""}" data-aid="${a.id}">${head}${body}</div>`;
}

function renderAssets() {
  els.assets.innerHTML = state.assets.map(assetCardHTML).join("");
}

function refreshCardHead(aid) {
  const a = findAsset(aid);
  const card = els.assets.querySelector(`.pcard[data-aid="${aid}"]`);
  if (!a || !card) return;
  const nameEl = card.querySelector('[data-role="headName"]');
  const metaEl = card.querySelector('[data-role="headMeta"]');
  if (nameEl) nameEl.textContent = a.name;
  if (metaEl) metaEl.textContent = `${allocationSummary(a.allocation, PROFILES)} · ${fmtMoney(a.balance)}${isCouple() ? ` · ${a.owner}` : ""}`;
}

function refreshAllocTotal(aid) {
  const a = findAsset(aid);
  if (!a || a.allocation.mode !== "custom") return;
  const el = document.querySelector(`[data-role="allocTotal-${aid}"]`);
  if (el) {
    el.textContent = `Total: ${(a.allocation.incomePct + a.allocation.growthPct).toFixed(2)}% p.a. nominal`;
  }
}

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

// --- central cashflows section ------------------------------------------

function assetOptions(selected) {
  return state.assets.map(
    (a) => `<option value="${a.id}"${a.id === selected ? " selected" : ""}>${escapeHTML(a.name)}</option>`
  ).join("");
}

function fySpan(kind, row, which, owner) {
  const age = which === "from" ? row.fromAge : (which === "to" ? row.toAge : row.age);
  return `<span class="fy-label" data-role="fy-${row.id}-${which}">${fyLabelForAge(state.plan, owner, age)}</span>`;
}

function incomeRowHTML(r) {
  return `
    <div class="cf-row cf-row-income${isCouple() ? " with-owner" : ""}" data-cfid="${r.id}">
      <div class="cf-cell">
        <label>Label</label>
        <input type="text" value="${escapeHTML(r.label)}" maxlength="60"
               data-kind="income" data-cfid="${r.id}" data-field="label" />
      </div>
      ${isCouple() ? `
        <div class="cf-cell">
          <label>Owner</label>
          <select data-kind="income" data-cfid="${r.id}" data-field="owner">
            <option value="client"${r.owner === "client" ? " selected" : ""}>Client</option>
            <option value="partner"${r.owner === "partner" ? " selected" : ""}>Partner</option>
          </select>
        </div>
      ` : ""}
      <div class="cf-cell">
        <label>Gross amount ($)</label>
        <input type="number" min="0" step="1000" value="${r.amount}"
               data-kind="income" data-cfid="${r.id}" data-field="amount" />
      </div>
      <div class="cf-cell">
        <label>Frequency</label>
        <select data-kind="income" data-cfid="${r.id}" data-field="frequency">
          <option value="monthly"${r.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${r.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </div>
      <div class="cf-cell">
        <label>From age ${fySpan("income", r, "from", r.owner)}</label>
        <input type="number" min="18" max="120" step="1" value="${r.fromAge}"
               data-kind="income" data-cfid="${r.id}" data-field="fromAge" />
      </div>
      <div class="cf-cell">
        <label>To age ${fySpan("income", r, "to", r.owner)}</label>
        <input type="number" min="18" max="120" step="1" value="${r.toAge}"
               data-kind="income" data-cfid="${r.id}" data-field="toAge" />
      </div>
      <div class="cf-cell cf-indexed">
        <label>Indexed</label>
        <input type="checkbox"${r.indexed ? " checked" : ""}
               data-kind="income" data-cfid="${r.id}" data-field="indexed" />
      </div>
      <button class="cf-remove" type="button" aria-label="Remove row"
              data-action="remove-row" data-kind="income" data-cfid="${r.id}">×</button>
    </div>
  `;
}

function expenseRowHTML(r) {
  return `
    <div class="cf-row cf-row-expense" data-cfid="${r.id}">
      <div class="cf-cell">
        <label>Label</label>
        <input type="text" value="${escapeHTML(r.label)}" maxlength="60"
               data-kind="expenses" data-cfid="${r.id}" data-field="label" />
      </div>
      <div class="cf-cell">
        <label>Amount ($)</label>
        <input type="number" min="0" step="1000" value="${r.amount}"
               data-kind="expenses" data-cfid="${r.id}" data-field="amount" />
      </div>
      <div class="cf-cell">
        <label>Frequency</label>
        <select data-kind="expenses" data-cfid="${r.id}" data-field="frequency">
          <option value="monthly"${r.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${r.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </div>
      <div class="cf-cell">
        <label>From age ${fySpan("expenses", r, "from", "client")}</label>
        <input type="number" min="18" max="120" step="1" value="${r.fromAge}"
               data-kind="expenses" data-cfid="${r.id}" data-field="fromAge" />
      </div>
      <div class="cf-cell">
        <label>To age ${fySpan("expenses", r, "to", "client")}</label>
        <input type="number" min="18" max="120" step="1" value="${r.toAge}"
               data-kind="expenses" data-cfid="${r.id}" data-field="toAge" />
      </div>
      <div class="cf-cell cf-indexed">
        <label>Indexed</label>
        <input type="checkbox"${r.indexed ? " checked" : ""}
               data-kind="expenses" data-cfid="${r.id}" data-field="indexed" />
      </div>
      <button class="cf-remove" type="button" aria-label="Remove row"
              data-action="remove-row" data-kind="expenses" data-cfid="${r.id}">×</button>
    </div>
  `;
}

function contributionRowHTML(kind, cf) {
  return `
    <div class="cf-row cf-row-asset" data-cfid="${cf.id}">
      <div class="cf-cell">
        <label>Asset</label>
        <select data-kind="${kind}" data-cfid="${cf.id}" data-field="assetId">${assetOptions(cf.assetId)}</select>
      </div>
      <div class="cf-cell">
        <label>Amount ($)</label>
        <input type="number" min="0" step="100" value="${cf.amount}"
               data-kind="${kind}" data-cfid="${cf.id}" data-field="amount" />
      </div>
      <div class="cf-cell">
        <label>Frequency</label>
        <select data-kind="${kind}" data-cfid="${cf.id}" data-field="frequency">
          <option value="monthly"${cf.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${cf.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </div>
      <div class="cf-cell">
        <label>From age ${fySpan(kind, cf, "from", "client")}</label>
        <input type="number" min="18" max="120" step="1" value="${cf.fromAge}"
               data-kind="${kind}" data-cfid="${cf.id}" data-field="fromAge" />
      </div>
      <div class="cf-cell">
        <label>To age ${fySpan(kind, cf, "to", "client")}</label>
        <input type="number" min="18" max="120" step="1" value="${cf.toAge}"
               data-kind="${kind}" data-cfid="${cf.id}" data-field="toAge" />
      </div>
      <div class="cf-cell cf-indexed">
        <label>Indexed</label>
        <input type="checkbox"${cf.indexed ? " checked" : ""}
               data-kind="${kind}" data-cfid="${cf.id}" data-field="indexed" />
      </div>
      <button class="cf-remove" type="button" aria-label="Remove row"
              data-action="remove-row" data-kind="${kind}" data-cfid="${cf.id}">×</button>
    </div>
  `;
}

function lumpSumRowHTML(ls) {
  return `
    <div class="cf-row cf-row-lump" data-cfid="${ls.id}">
      <div class="cf-cell">
        <label>Asset${ls.source === "table" ? ' <span class="cf-tag">from table</span>' : ""}</label>
        <select data-kind="lumpSums" data-cfid="${ls.id}" data-field="assetId">${assetOptions(ls.assetId)}</select>
      </div>
      <div class="cf-cell">
        <label>Amount ($)</label>
        <input type="number" min="0" step="1000" value="${ls.amount}"
               data-kind="lumpSums" data-cfid="${ls.id}" data-field="amount" />
      </div>
      <div class="cf-cell">
        <label>Direction</label>
        <select data-kind="lumpSums" data-cfid="${ls.id}" data-field="direction">
          <option value="in"${ls.direction === "in" ? " selected" : ""}>In (deposit)</option>
          <option value="out"${ls.direction === "out" ? " selected" : ""}>Out (withdrawal)</option>
        </select>
      </div>
      <div class="cf-cell">
        <label>At age ${fySpan("lumpSums", ls, "at", "client")}</label>
        <input type="number" min="18" max="120" step="1" value="${ls.age}"
               data-kind="lumpSums" data-cfid="${ls.id}" data-field="age" />
      </div>
      <button class="cf-remove" type="button" aria-label="Remove row"
              data-action="remove-row" data-kind="lumpSums" data-cfid="${ls.id}">×</button>
    </div>
  `;
}

// Fact-find empty-state treatment: a section (or subsection) with no
// rows renders collapsed to a single row — header + Add button —
// so a portfolio-only scenario stays visually simple. Adding the
// first row expands it.

function addRowBtn(kind, label) {
  return `<button class="add-row-btn" type="button" data-action="add-row" data-kind="${kind}">+ ${label}</button>`;
}

// Top-level fact-find section (Income / Expenses): heading with an
// inline Add button when empty; heading + panel of rows otherwise.
function ffSectionHTML(title, kind, addLabel, rowsHTML, helperHTML = "") {
  const empty = rowsHTML === "";
  if (empty) {
    return `
      <div class="ff-section empty">
        <div class="ff-head">
          <h2 class="section-heading">${title}</h2>
          ${addRowBtn(kind, addLabel)}
        </div>
      </div>
    `;
  }
  return `
    <div class="ff-section">
      <div class="ff-head"><h2 class="section-heading">${title}</h2></div>
      <div class="cf-panel">
        <div class="cf-section">
          ${helperHTML}
          ${rowsHTML}
          ${addRowBtn(kind, addLabel)}
        </div>
      </div>
    </div>
  `;
}

// Subsection inside the Investment cashflows panel: single compact
// row when empty; title + rows + Add otherwise.
function ffSubsectionHTML(title, kind, addLabel, rowsHTML) {
  if (rowsHTML === "") {
    return `
      <div class="cf-section cf-empty">
        <div class="cf-empty-row">
          <span class="cf-section-title">${title}</span>
          ${addRowBtn(kind, addLabel)}
        </div>
      </div>
    `;
  }
  return `
    <div class="cf-section">
      <div class="cf-section-title">${title}</div>
      ${rowsHTML}
      ${addRowBtn(kind, addLabel)}
    </div>
  `;
}

function renderCashflows() {
  const cf = state.cashflows;

  els.incomeSection.innerHTML = ffSectionHTML(
    "Income", "income", "Add income",
    cf.income.map(incomeRowHTML).join(""),
    `<p class="helper-text">Enter income before tax. Tax is calculated from a later phase.</p>`
  );

  els.expensesSection.innerHTML = ffSectionHTML(
    "Expenses", "expenses", "Add expense",
    cf.expenses.map(expenseRowHTML).join("")
  );

  els.investSection.innerHTML = `
    <div class="ff-section">
      <div class="ff-head"><h2 class="section-heading">Investment cashflows</h2></div>
      <div class="cf-panel">
        ${ffSubsectionHTML("Contributions", "contributions", "Add contribution",
          cf.contributions.map((c) => contributionRowHTML("contributions", c)).join(""))}
        ${ffSubsectionHTML("Withdrawals", "withdrawals", "Add withdrawal",
          cf.withdrawals.map((w) => contributionRowHTML("withdrawals", w)).join(""))}
        ${ffSubsectionHTML("One-off amounts", "lumpSums", "Add one-off amount",
          cf.lumpSums.map(lumpSumRowHTML).join(""))}
      </div>
    </div>
  `;
}

// --- settings section ------------------------------------------------------

function renderSettings() {
  const s = state.settings;
  const includedAssets = state.assets.filter((a) => a.include);
  const orderItems = s.fundingOrder.map((id, i) => {
    const a = findAsset(id);
    if (!a) return "";
    return `
      <div class="order-item">
        <span class="order-pos">${i + 1}.</span>
        <span class="order-name">${escapeHTML(a.name)}</span>
        <span class="order-controls">
          <button type="button" class="order-btn" data-action="order-up" data-aid="${id}"
                  ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button type="button" class="order-btn" data-action="order-down" data-aid="${id}"
                  ${i === s.fundingOrder.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
        </span>
      </div>
    `;
  }).join("");

  els.settingsPanel.innerHTML = `
    <div class="cf-panel">
      <div class="cf-section">
        <div class="cf-section-title">Surplus treatment</div>
        <div class="settings-row">
          <select data-settings-field="surplusMode">
            <option value="spend"${s.surplus.mode === "spend" ? " selected" : ""}>Spend (additional expenses)</option>
            <option value="invest"${s.surplus.mode === "invest" ? " selected" : ""}>Invest to…</option>
          </select>
          ${s.surplus.mode === "invest" ? `
            <select data-settings-field="surplusAsset">
              ${includedAssets.map((a) =>
                `<option value="${a.id}"${a.id === s.surplus.assetId ? " selected" : ""}>${escapeHTML(a.name)}</option>`
              ).join("")}
            </select>
          ` : ""}
        </div>
        <p class="helper-text">When income exceeds expenses, the surplus is ${s.surplus.mode === "invest" ? "invested into the selected asset" : "treated as additional spending and disappears from the projection"}.</p>
      </div>
      <div class="cf-section">
        <div class="cf-section-title">Deficit funding order</div>
        <div class="order-list">${orderItems}</div>
        <p class="helper-text">When expenses exceed income, money is drawn from these assets in this order.</p>
      </div>
    </div>
  `;
}

els.settingsPanel.addEventListener("change", (e) => {
  const field = e.target.dataset.settingsField;
  if (!field) return;
  if (field === "surplusMode") {
    if (e.target.value === "invest") {
      const first = state.assets.find((a) => a.include);
      state.settings.surplus = { mode: "invest", assetId: first ? first.id : null };
      state.settings = normaliseSettings(state.settings, state.assets);
    } else {
      state.settings.surplus = { mode: "spend", assetId: null };
    }
  } else if (field === "surplusAsset") {
    state.settings.surplus = { mode: "invest", assetId: e.target.value };
    state.settings = normaliseSettings(state.settings, state.assets);
  }
  saveState();
  renderSettings();
});

els.settingsPanel.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, aid } = btn.dataset;
  if (action !== "order-up" && action !== "order-down") return;
  const order = [...state.settings.fundingOrder];
  const i = order.indexOf(aid);
  const j = action === "order-up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  state.settings.fundingOrder = normaliseFundingOrder(order, state.assets);
  saveState();
  renderSettings();
});

// --- field mutation (delegated over assets + cashflows) ---------------------

const CF_MOUNTS = [els.incomeSection, els.expensesSection, els.investSection];
for (const container of [els.assets, ...CF_MOUNTS]) {
  container.addEventListener("input", (e) => applyFieldEdit(e.target, false));
  container.addEventListener("change", (e) => applyFieldEdit(e.target, true));
}

function applyFieldEdit(el, commit) {
  const field = el.dataset.field;
  if (!field) return;

  if (el.dataset.kind) {
    const row = findRow(el.dataset.kind, el.dataset.cfid);
    if (!row) return;
    applyRowEdit(el.dataset.kind, row, field, el, commit);
    saveState();
    renderSummaryStrip();
    return;
  }

  const aid = el.dataset.aid;
  const a = findAsset(aid);
  if (!a) return;
  const structural = applyAssetEdit(a, field, el, commit);
  saveState();
  if (structural) {
    renderAssets();
    renderSettings(); // names/inclusion feed the funding order list
    renderCashflows(); // asset selects show names
  } else {
    refreshCardHead(aid);
  }
  renderSummaryStrip();
}

function applyAssetEdit(a, field, el, commit) {
  switch (field) {
    case "name": {
      a.name = commit ? (el.value.trim() || a.name) : el.value;
      if (commit) {
        el.value = a.name;
        // Funding order + cashflow asset selects display the name.
        renderSettings();
        refreshAssetSelects();
      }
      return false;
    }
    case "owner":
      if (["client", "partner", "joint"].includes(el.value)) a.owner = el.value;
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
      if (a.cgtAsset && a.costBase == null) a.costBase = a.balance;
      if (!a.cgtAsset) a.costBase = null;
      return true;
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
        volBasisTouched.add(a.id);
      }
      return false;
  }
  return false;
}

function applyRowEdit(kind, row, field, el, commit) {
  const plan = state.plan;
  const owner = kind === "income" ? row.owner : "client";
  const win = ownerWindow(plan, owner);

  switch (field) {
    case "label":
      row.label = commit ? (el.value.trim() || row.label) : el.value;
      if (commit) el.value = row.label;
      break;
    case "owner": { // income rows only
      if (el.value !== "client" && el.value !== "partner") break;
      row.owner = el.value;
      // Keep numeric ages; re-clamp into the new owner's window and
      // re-derive FY labels.
      const clamped = clampIncomeRow(row, plan);
      row.fromAge = clamped.fromAge;
      row.toAge = clamped.toAge;
      syncRowInput(el, "fromAge", row.fromAge);
      syncRowInput(el, "toAge", row.toAge);
      updateFyLabels(row, kind);
      break;
    }
    case "assetId":
      if (findAsset(el.value)) row.assetId = el.value;
      break;
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
      if (!commit) return;
      const v = clampInt(el.value, win.from, win.to);
      row.fromAge = v;
      if (row.toAge < v) { row.toAge = v; syncRowInput(el, "toAge", v); }
      flagIfClamped(el, v);
      updateFyLabels(row, kind);
      break;
    }
    case "toAge": {
      if (!commit) return;
      const v = clampInt(el.value, row.fromAge, win.to);
      row.toAge = v;
      flagIfClamped(el, v);
      updateFyLabels(row, kind);
      break;
    }
    case "age": { // lump sum
      if (!commit) return;
      const v = clampInt(el.value, plan.client.currentAge, plan.endAge);
      row.age = v;
      flagIfClamped(el, v);
      updateFyLabels(row, kind);
      break;
    }
  }
}

function syncRowInput(el, field, value) {
  const rowEl = el.closest(".cf-row");
  const sib = rowEl?.querySelector(`[data-field="${field}"]`);
  if (sib) sib.value = value;
}

function updateFyLabels(row, kind) {
  const owner = kind === "income" ? row.owner : "client";
  const set = (which, age) => {
    const el = document.querySelector(`[data-role="fy-${row.id}-${which}"]`);
    if (el) el.textContent = fyLabelForAge(state.plan, owner, age);
  };
  if (kind === "lumpSums") set("at", row.age);
  else { set("from", row.fromAge); set("to", row.toAge); }
}

function refreshAssetSelects() {
  for (const sel of els.investSection.querySelectorAll('[data-field="assetId"]')) {
    const current = sel.value;
    sel.innerHTML = assetOptions(current);
  }
}

function flagIfClamped(el, clampedValue) {
  const typed = Number(el.value);
  el.value = clampedValue;
  if (Number.isFinite(typed) && typed !== clampedValue) {
    el.classList.add("field-clamped");
    setTimeout(() => el.classList.remove("field-clamped"), 1200);
  }
}

// --- structural actions ------------------------------------------------------

els.assets.addEventListener("click", (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const aid = target.dataset.aid;
  const a = findAsset(aid);
  if (!a) return;

  switch (action) {
    case "toggle-collapse": {
      if (e.target.closest(".pcard-include") || e.target.closest(".pcard-remove")) return;
      collapsed.set(aid, !(collapsed.get(aid) === true));
      renderAssets();
      break;
    }
    case "toggle-include": {
      const wasSurplusTarget = state.settings.surplus.assetId === aid && e.target.checked === false;
      if (wasSurplusTarget) {
        const ok = window.confirm(`"${a.name}" is the surplus investment target. Excluding it reverts surplus treatment to Spend. Continue?`);
        if (!ok) { e.target.checked = true; return; }
      }
      a.include = e.target.checked;
      state.settings = normaliseSettings(state.settings, state.assets);
      saveState();
      els.assets.querySelector(`.pcard[data-aid="${aid}"]`)?.classList.toggle("excluded", !a.include);
      renderSettings();
      renderSummaryStrip();
      break;
    }
    case "remove-asset": {
      if (state.assets.length <= 1) return;
      const isSurplusTarget = state.settings.surplus.assetId === aid;
      const msg = isSurplusTarget
        ? `Remove "${a.name}"? It is the surplus investment target — surplus treatment will revert to Spend, and the asset's cashflow rows will be deleted.`
        : `Remove "${a.name}"? Its cashflow rows will be deleted too.`;
      if (!window.confirm(msg)) return;
      state = removeAsset(state, aid);
      collapsed.delete(aid);
      allocMemory.delete(aid);
      volBasisTouched.delete(aid);
      saveState();
      renderAll();
      break;
    }
    case "alloc-mode": {
      switchAllocMode(a, target.dataset.mode === "custom" ? "custom" : "profile");
      saveState();
      renderAssets();
      renderSummaryStrip();
      break;
    }
    case "distributions": {
      const v = target.dataset.value === "cash" ? "cash" : "reinvest";
      if (a.distributions !== v) {
        a.distributions = v;
        saveState();
        renderAssets();
      }
      break;
    }
  }
});

function switchAllocMode(a, mode) {
  if (a.allocation.mode === mode) return;
  const mem = allocMemory.get(a.id) || {};
  mem[a.allocation.mode] = a.allocation;
  if (mode === "custom") {
    if (mem.custom) {
      a.allocation = mem.custom;
    } else {
      const p = PROFILES[a.allocation.profile] || {};
      a.allocation = clampAllocation({
        mode: "custom",
        incomePct: +((p.incomeReturn ?? 0) * 100).toFixed(2),
        growthPct: +((p.growthReturn ?? 0) * 100).toFixed(2),
        frankingPct: p.frankingPct ?? 0,
        volBasis: a.allocation.profile,
      }, PROFILES);
    }
  } else {
    a.allocation = mem.profile || clampAllocation({ mode: "profile", profile: null }, PROFILES);
  }
  allocMemory.set(a.id, mem);
}

function onCashflowSectionClick(e) {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const { action, kind, cfid } = target.dataset;
  const cf = state.cashflows;

  if (action === "add-row") {
    const firstAsset = state.assets[0]?.id ?? null;
    if (kind === "income") cf.income.push(createIncomeRow(state.plan, cf.income));
    else if (kind === "expenses") cf.expenses.push(createExpenseRow(state.plan, cf.expenses));
    else if (kind === "contributions") cf.contributions.push(createCashflow("contribution", state.plan, firstAsset));
    else if (kind === "withdrawals") cf.withdrawals.push(createCashflow("withdrawal", state.plan, firstAsset));
    else if (kind === "lumpSums") cf.lumpSums.push(createLumpSum(state.plan, firstAsset));
    saveState();
    renderCashflows();
    renderSummaryStrip();
  } else if (action === "remove-row") {
    if (cf[kind]) cf[kind] = cf[kind].filter((r) => r.id !== cfid);
    saveState();
    renderCashflows();
    renderSummaryStrip();
  }
}

for (const mount of CF_MOUNTS) {
  mount.addEventListener("click", onCashflowSectionClick);
}

els.addAssetBtn.addEventListener("click", () => {
  const a = createAsset(state.plan, state.assets, PROFILES);
  state.assets.push(a);
  state.settings = normaliseSettings(state.settings, state.assets); // appends to funding order
  collapsed.set(a.id, false);
  saveState();
  renderAll();
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
      <div class="stat-label">Gross income (annualised)</div>
      <div class="stat-value">${fmtMoney(s.annualIncome)} /yr</div>
    </div>
    <div class="stat">
      <div class="stat-label">Expenses (annualised)</div>
      <div class="stat-value">${fmtMoney(s.annualExpenses)} /yr</div>
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
        <td>${p.frankingPct}%</td>
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
});

// --- boot -----------------------------------------------------------------

function renderAll() {
  renderPlanBar();
  renderAssets();
  renderCashflows();
  renderSettings();
  renderSummaryStrip();
}

renderAll();
renderChartPlaceholder();
applyUnitsLabel();
populateParamsTable();
els.inflationInput.value = (state.assumptions.cpi * 100).toFixed(1);

if (LEGACY_INSIGHTS_ENABLED) {
  // Placeholder: insights phase re-mounts firstDecade, drawdownTolerance,
  // tornado, and sequenceRisk here as collapsed accordions.
}
