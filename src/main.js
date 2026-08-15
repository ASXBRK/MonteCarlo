// Phase A.2 — household, income & expenses, surplus/deficit settings.
//
// This file owns rendering and persistence; src/planState.js owns the
// state shape (schemaVersion 3), defaults, validation, migration, and
// derived summaries. The ledger that consumes these inputs arrives in
// Phase B; tax in B.1 — income is captured gross and the UI says so.

import { PROFILES, realMu, impliedFrankingPct, ASSET_CLASS_KEYS, ASSET_CLASS_LABELS } from "./profiles.js";
import { allocationSeries } from "./allocation.js";
import { runMonteCarlo, DEFAULT_NUM_PATHS } from "./monteCarlo.js";
import {
  defaultState, createAsset, createLifestyleAsset, createCashflow, createLumpSum,
  createIncomeRow, createExpenseRow, createDeductionRow, clampDeductionRow,
  DEDUCTION_CATEGORIES, DEDUCTION_CATEGORY_LABELS,
  clampPlan, clampAllToPlan, clampAllocation, clampIncomeRow,
  nearestVolBasis, normaliseSettings, normaliseFundingOrder,
  partnerOwnedItems, reassignPartnerToClient, deletePartnerOwned,
  removeAsset, cashflowRowsForAsset, ownerWindow, fyLabelForAge,
  clampInt, clampNumber, serialize, hydrate, ageAtDate,
  planSummaryText, allocationSummary, ALLOC_PCT_MAX,
  tableLumpSumFor, upsertTableLumpSum, canEditOneOffYear,
  personDisplayName, resolveEndBasis,
  createLiability, LIABILITY_TYPES, normaliseLiabilities,
  createProperty, normaliseProperties, PROPERTY_STATES, PROPERTY_TYPES,
  clampLastVisited, isScenarioEffectivelyEmpty, sectionCounts,
  createKeyDate, removeKeyDate, referencesToAnchor, convertAnchorReferences,
  createSuperAccount, clampSuperAccount, normaliseSuperAccounts,
  createSuperContribution, normaliseSuperContributions,
  createSuperWithdrawal, normaliseSuperWithdrawals,
  SUPER_CONTRIBUTION_TYPES, SUPER_CONTRIBUTION_BASES,
  clampWorkingCash,
  INCOME_CATEGORIES, INCOME_CATEGORY_LABELS, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS,
  incomeCategoryTaxTreatment,
} from "./planState.js";
import { resolveRef, listAnchors } from "./keyDates.js";
import { levelPayment, monthlyRate, termMonths, ioMonths } from "./liabilities.js";
import { dutyWithConcessions, fhogAmount } from "./data/stampDuty.js";
import { renderBellCurves } from "./chart.js";
import { projectPlan, assetReturnComponents } from "./deterministic.js";
import { nominalFactor, firstFyStartYear } from "./schedule.js";
import { thinnedYearIndices } from "./periodThinning.js";
import { compositeSeries, sharedZeroRanges, seriesIsAllZero, axisTickVals } from "./outputSeries.js";
import { cashflowStatement } from "./cashflowStatement.js";
import {
  salarySacrificeCash as salarySacrificeCashPure,
  personalSuperContributionsCash,
  incomeCategorySums as incomeCategorySumsPure,
  expenseCategorySums as expenseCategorySumsPure,
} from "./cashflowCategories.js";
import { realThreshold, LITO } from "./Tax/annual.js";
import { superRatesFor } from "./data/superRates.js";
import { LEG } from "./Tax/engine.js";
import {
  createIndex, normaliseIndex, findActive, findClient,
  newClient, renameClient, deleteClient, switchClient,
  newScenario, duplicateScenario, renameScenario, deleteScenario,
  switchScenario, touchScenario,
  exportClientFile, exportScenarioFile, importFile,
} from "./workspace.js";
import {
  formatRoute, resolveRoute, initialRoute,
  INPUT_SECTIONS, OUTPUT_VIEWS, DEFAULT_INPUT_SECTION, DEFAULT_OUTPUT_VIEW,
} from "./router.js";

// Legacy insight modules (firstDecade, drawdownTolerance, tornado,
// sequenceRisk) are stubbed out. Deliberately NOT imported while
// disabled — tornado.js spins up a Web Worker at module scope. They
// return as collapsed accordions in the insights phase.
const LEGACY_INSIGHTS_ENABLED = false;

const PROFILE_KEYS = Object.keys(PROFILES);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const $ = (id) => document.getElementById(id);

const els = {
  breadcrumb: $("breadcrumb"),
  pageClients: $("pageClients"),
  pageClient: $("pageClient"),
  pageWorkspace: $("pageWorkspace"),
  planBar: $("planBar"),
  assets: $("assets"),
  lifestyleSection: $("lifestyleSection"),
  liabilitiesSection: $("liabilitiesSection"),
  propertySection: $("propertySection"),
  superSection: $("superSection"),
  addAssetBtn: $("addAssetBtn"),
  incomeSection: $("incomeSection"),
  deductionsSection: $("deductionsSection"),
  expensesSection: $("expensesSection"),
  investSection: $("investSection"),
  settingsPanel: $("settingsPanel"),
  summaryStrip: $("summaryStrip"),
  chartNote: document.querySelector('[data-role="chartNote"]'),
  displayOptions: document.querySelectorAll(".display-option"),
  sideNav: $("sideNav"),
  workspaceCanvas: document.querySelector(".workspace-canvas"),
  outputCanvas: $("outputCanvas"),
  exportBtn: $("exportBtn"),
  viewProjection: $("viewProjection"),
  viewCashflow: $("viewCashflow"),
  viewAssets: $("viewAssets"),
  viewTax: $("viewTax"),
  viewSuper: $("viewSuper"),
  viewLiabilities: $("viewLiabilities"),
  viewAssumptions: $("viewAssumptions"),
  assetsEntity: $("assetsEntity"),
  assetsTable: $("assetsTable"),
  superEntity: $("superEntity"),
  superTable: $("superTable"),
  liabilitiesEntity: $("liabilitiesEntity"),
  liabilitiesTable: $("liabilitiesTable"),
  viewSuperBalances: $("viewSuperBalances"),
  viewLiabilitiesBalances: $("viewLiabilitiesBalances"),
  viewCashflowBars: $("viewCashflowBars"),
  viewKeyFigures: $("viewKeyFigures"),
  keyFiguresTable: $("keyFiguresTable"),
  showAssetsToggle: $("showAssetsToggle"),
  shortfallNote: $("shortfallNote"),
  periodFromAge: $("periodFromAge"),
  periodToAge: $("periodToAge"),
  periodEveryN: $("periodEveryN"),
  forceKeyYearsToggle: $("forceKeyYearsToggle"),
  hideEmptyRowsToggle: $("hideEmptyRowsToggle"),
  showIndividualItemsLabel: $("showIndividualItemsLabel"),
  showIndividualItemsToggle: $("showIndividualItemsToggle"),
  viewComposite: $("viewComposite"),
  viewNetAssets: $("viewNetAssets"),
  viewAssetBalances: $("viewAssetBalances"),
  viewAssetAllocation: $("viewAssetAllocation"),
  viewMonteCarlo: $("viewMonteCarlo"),
  runMonteCarloBtn: $("runMonteCarloBtn"),
  cancelMonteCarloBtn: $("cancelMonteCarloBtn"),
  monteCarloStatus: $("monteCarloStatus"),
  monteCarloResults: $("monteCarloResults"),
  monteCarloStats: $("monteCarloStats"),
  viewMonteCarloTable: $("viewMonteCarloTable"),
  runMonteCarloTableBtn: $("runMonteCarloTableBtn"),
  cancelMonteCarloTableBtn: $("cancelMonteCarloTableBtn"),
  monteCarloTableStatus: $("monteCarloTableStatus"),
  monteCarloTableResults: $("monteCarloTableResults"),
  chartTreatmentSelects: document.querySelectorAll("[data-treatment]"),
  paramsBtn: $("paramsBtn"),
  paramsModal: $("paramsModal"),
  assetRemoveModal: $("assetRemoveModal"),
  assetRemoveModalBody: $("assetRemoveModalBody"),
  paramAssetTable: $("paramAssetTable"),
  inflationInput: $("inflationInput"),
  unitsToggle: document.querySelector(".display-toggle"),
};

// --- workspace + persistence ----------------------------------------------
//
// Hierarchy: Client → Scenarios. The index lives under INDEX_KEY; each
// scenario's full plan state lives under its own key. A legacy single
// blob (from either historical key) migrates into "Client 1 /
// Scenario 1" on first load — this also recovers data from the earlier
// storage-key rotation that made saved plans appear to vanish.

const INDEX_KEY = "planner.workspace.v1";
const LEGACY_KEYS = ["projectionPlanner.v1", "portfolioPlanner.v1"];
const scenarioKey = (id) => `planner.scenario.${id}`;

function readRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeRaw(key, value) {
  try { localStorage.setItem(key, value); } catch { /* non-fatal */ }
}
function removeRaw(key) {
  try { localStorage.removeItem(key); } catch { /* non-fatal */ }
}
function readJSON(key) {
  try { const v = readRaw(key); return v ? JSON.parse(v) : null; } catch { return null; }
}

function loadWorkspaceIndex() {
  const existing = normaliseIndex(readJSON(INDEX_KEY));
  if (existing) return existing;
  // First run (or corrupt index): migrate any legacy single blob into
  // Client 1 / Scenario 1. hydrate() migrates old schema versions on
  // the subsequent load.
  const fresh = createIndex(Date.now());
  for (const key of LEGACY_KEYS) {
    const blob = readRaw(key);
    if (blob) { writeRaw(scenarioKey(fresh.activeScenarioId), blob); break; }
  }
  writeRaw(INDEX_KEY, JSON.stringify(fresh));
  return fresh;
}

let workspace = loadWorkspaceIndex();

function loadActiveState() {
  const blob = readRaw(scenarioKey(workspace.activeScenarioId));
  if (blob) {
    const s = hydrate(blob, PROFILES);
    if (s) return s;
  }
  return defaultState(PROFILES);
}

let state = loadActiveState();
// UI-only runtime state — none of this is persisted.
const collapsed = new Map();
const allocMemory = new Map();
const volBasisTouched = new Set();

function resetRuntimeUiState() {
  collapsed.clear();
  allocMemory.clear();
  volBasisTouched.clear();
}

function saveWorkspace() {
  writeRaw(INDEX_KEY, JSON.stringify(workspace));
}

// Autosave: every mutation writes the active scenario's blob and
// touches its updatedAt in the index. Sidebar badges are counts of
// plan-state lists, so this is also the single choke point that keeps
// them live-updating without threading a render call through every
// individual mutation handler.
function saveState() {
  writeRaw(scenarioKey(workspace.activeScenarioId), serialize(state));
  workspace = touchScenario(workspace, workspace.activeScenarioId, Date.now());
  saveWorkspace();
  if (mountedScenarioId) renderSideNav();
}

// --- pages + routing (A.5) --------------------------------------------------
//
// Hash-based navigation, Xplan-style: #/clients → Clients page,
// #/clients/<id> → Client page, #/clients/<cid>/scenarios/<sid> →
// Workspace (the modelling page). The list pages are light renders;
// only the workspace mounts the heavy input/output DOM, and it is
// emptied on the way out.

let currentRoute = null;      // last resolved route
let mountedScenarioId = null; // non-null while the workspace DOM is live

function navigate(route) {
  const target = formatRoute(route);
  if (location.hash === target) handleRoute(); // same hash → no hashchange event
  else location.hash = target;
}

function showPage(name) {
  els.pageClients.hidden = name !== "clients";
  els.pageClient.hidden = name !== "client";
  els.pageWorkspace.hidden = name !== "workspace";
}

// A scenario lands on Setup when it hasn't been configured yet
// (a brand-new client/scenario, or one cleared back down); otherwise
// it reopens wherever it was last left.
function landingRoute(clientId, scenarioId) {
  if (isScenarioEffectivelyEmpty(state)) {
    return { page: "workspace", clientId, scenarioId, area: "input", section: DEFAULT_INPUT_SECTION };
  }
  const lv = clampLastVisited(state.display.lastVisited);
  return { page: "workspace", clientId, scenarioId, area: lv.area, section: lv.section };
}

function handleRoute() {
  const route = resolveRoute(location.hash, workspace);
  if (!route) { location.replace("#/clients"); return; } // invalid ids → Clients
  // An invalid area/section was clamped (e.g. to input/setup) rather
  // than rejected — normalise the visible URL to match, the same way
  // an invalid client/scenario id normalises to #/clients. A genuine
  // bare route (no area/section yet) formats back to the identical
  // hash here, so this never fires for that case.
  if (route.page === "workspace" && route.area != null && formatRoute(route) !== location.hash) {
    location.replace(formatRoute(route));
    return;
  }
  currentRoute = route;
  if (route.page !== "workspace" && mountedScenarioId) unmountWorkspace();
  showPage(route.page);
  if (route.page === "clients") { renderClientsPage(); return; }
  if (route.page === "client") { renderClientPage(route.clientId); return; }

  // workspace
  if (mountedScenarioId !== route.scenarioId) mountWorkspace(route.clientId, route.scenarioId);
  if (route.area == null) {
    // Bare scenario URL — now that state is loaded, resolve landing
    // and replace the hash (fires hashchange; this function re-enters
    // with area/section set and mountedScenarioId already current).
    navigate(landingRoute(route.clientId, route.scenarioId));
    return;
  }
  persistLastVisited(route.area, route.section);
  renderWorkspaceBreadcrumb();
  showSection(route.area, route.section);
  renderSideNav();
}

function mountWorkspace(clientId, scenarioId) {
  workspace = switchScenario(workspace, clientId, scenarioId);
  saveWorkspace();
  state = loadActiveState();
  resetRuntimeUiState();
  mountedScenarioId = scenarioId;
  renderAll();
  applyUnitsLabel();
  populateParamsTable();
  els.inflationInput.value = (state.assumptions.cpi * 100).toFixed(1);
  awoteInput.value = ((state.assumptions.awote ?? 0.035) * 100).toFixed(1);
  mortgageRateInput.value = ((state.assumptions.mortgageRate ?? 0.06) * 100).toFixed(2);
  syncBracketModeInputs();
  els.chartTreatmentSelects.forEach((sel) => { sel.value = state.display.chartTreatment[sel.dataset.treatment]; });
}

// --- sidebar navigation: one section per page (Sidebar nav) -----------------

const INPUT_NAV = [
  { id: "setup", label: "Setup" },
  { id: "income", label: "Income" },
  { id: "deductions", label: "Deductions" },
  { id: "expenses", label: "Expenses" },
  { id: "financial-assets", label: "Financial assets" },
  { id: "lifestyle-assets", label: "Lifestyle assets" },
  { id: "property", label: "Property" },
  { id: "super", label: "Super" },
  { id: "liabilities", label: "Liabilities" },
  { id: "investment-cashflows", label: "Investment cashflows" },
  { id: "settings", label: "Settings" },
];
const OUTPUT_NAV = {
  Graphs: [
    { id: "projection", label: "Projection" },
    { id: "cashflow-bars", label: "Cashflow" },
    { id: "composite", label: "Cashflow, Assets & Liabilities" },
    { id: "net-assets", label: "Net assets" },
    { id: "asset-balances", label: "Asset balances" },
    { id: "asset-allocation", label: "Asset allocation" },
    { id: "monte-carlo", label: "Monte Carlo" },
    { id: "super-balances", label: "Super balances" },
    { id: "liabilities-balances", label: "Liabilities" },
  ],
  Tables: [
    { id: "key-figures", label: "Key figures" },
    { id: "cashflow", label: "Cashflow" },
    { id: "assets", label: "Assets" },
    { id: "tax", label: "Tax" },
    { id: "super", label: "Super" },
    { id: "liabilities", label: "Liabilities" },
    { id: "monte-carlo-table", label: "Monte Carlo" },
    { id: "assumptions", label: "Assumptions" },
  ],
};
const SECTION_LABELS = Object.fromEntries([
  ...INPUT_NAV.map((n) => [n.id, n.label]),
  ...Object.values(OUTPUT_NAV).flat().map((n) => [n.id, n.label]),
]);

function renderSideNav() {
  const counts = sectionCounts(state);
  const badge = (id) => (counts[id] ? `<span class="nav-badge">${counts[id]}</span>` : "");
  const item = (n, sub = false) => {
    const area = INPUT_NAV.includes(n) ? "input" : "output";
    const active = currentRoute?.area === area && currentRoute?.section === n.id;
    return `
      <button class="nav-item${sub ? " nav-item-sub" : ""}${active ? " active" : ""}" type="button"
              data-nav-area="${area}" data-nav-section="${n.id}">
        <span>${escapeHTML(n.label)}</span>${badge(n.id)}
      </button>
    `;
  };
  els.sideNav.innerHTML = `
    <div class="nav-group-label">Input</div>
    ${INPUT_NAV.map((n) => item(n)).join("")}
    <div class="nav-group-label">Output</div>
    <div class="nav-subgroup-label">Graphs</div>
    ${OUTPUT_NAV.Graphs.map((n) => item(n, true)).join("")}
    <div class="nav-subgroup-label">Tables</div>
    ${OUTPUT_NAV.Tables.map((n) => item(n, true)).join("")}
  `;
}

els.sideNav.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-nav-section]");
  if (!btn || btn.disabled) return;
  const { client, scenario } = findActive(workspace);
  navigate({
    page: "workspace", clientId: client.id, scenarioId: scenario.id,
    area: btn.dataset.navArea, section: btn.dataset.navSection,
  });
});

// Toggle which single canvas section is visible; drives the output
// sub-view when area is "output". Every INPUT_SECTIONS id maps 1:1 to
// a data-section element already rendered by renderAll().
function showSection(area, section) {
  const target = area === "output" ? "__output__" : section;
  for (const el of els.workspaceCanvas.querySelectorAll("[data-section]")) {
    el.hidden = el.dataset.section !== target;
  }
  if (area === "output") {
    activeView = OUTPUT_VIEWS.includes(section) ? section : DEFAULT_OUTPUT_VIEW;
    renderActiveView();
  }
}

// Persisted separately from saveState(): visiting a page is not an
// edit, so it must not bump the scenario's "last updated" timestamp.
function persistLastVisited(area, section) {
  state.display.lastVisited = { area, section };
  writeRaw(scenarioKey(workspace.activeScenarioId), serialize(state));
}

// Empty every dynamic mount so the list pages do not sit on top of a
// live workspace DOM. The static skeleton and its listeners stay; the
// content goes.
function unmountWorkspace() {
  if (typeof Plotly !== "undefined") { try { Plotly.purge($("chart")); } catch { /* fine */ } }
  $("chart").innerHTML = "";
  for (const el of [els.planBar, els.incomeSection, els.deductionsSection, els.expensesSection, els.assets,
                    els.lifestyleSection, els.liabilitiesSection, els.propertySection,
                    els.investSection, els.settingsPanel, els.summaryStrip,
                    els.viewCashflow, els.assetsEntity, els.assetsTable,
                    els.viewTax, els.viewAssumptions]) {
    el.innerHTML = "";
  }
  els.shortfallNote.hidden = true;
  projection = null;
  mountedScenarioId = null;
}

// Inline rename: swap the name element for a text input; Enter/blur
// commits, Escape aborts; the caller re-renders its page afterwards.
function startInlineRename(nameEl, currentName, commit, rerender) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-rename-input";
  input.value = currentName;
  input.maxLength = 80;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (apply) => {
    if (done) return;
    done = true;
    if (apply) commit(input.value);
    rerender();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function sanitiseFilename(name) {
  return name.replace(/[^\w\- ]+/g, "_").trim() || "export";
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sanitiseFilename(filename)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const getScenarioState = (id) => readJSON(scenarioKey(id));

// Hidden file input, created once, for Import…
const importInput = document.createElement("input");
importInput.type = "file";
importInput.accept = ".json,application/json";
importInput.style.display = "none";
document.body.appendChild(importInput);
// A scenario file needs a destination client; a client file lands in
// the list as-is.
function pickClientForImport() {
  if (workspace.clients.length === 1) return workspace.clients[0].id;
  const listing = workspace.clients.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
  const raw = window.prompt(`Import scenario into which client?\n\n${listing}\n\nEnter a number:`, "1");
  if (raw == null) return null; // cancelled
  const id = workspace.clients[Math.round(Number(raw)) - 1]?.id ?? null;
  if (!id) window.alert("No client with that number — import cancelled.");
  return id;
}

importInput.addEventListener("change", () => {
  const file = importInput.files?.[0];
  importInput.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed = null;
    try { parsed = JSON.parse(String(reader.result)); } catch { /* handled below */ }

    // importFile targets the index's active client for scenario files,
    // so point that at the user's pick first.
    if (parsed && parsed.kind === "scenario") {
      const targetId = pickClientForImport();
      if (!targetId) return;
      workspace = switchClient(workspace, targetId);
    }

    const res = importFile(workspace, parsed, {
      hydrateState: (json) => hydrate(json, PROFILES),
      now: Date.now(),
    });
    if (res.error) {
      window.alert(`Import failed: ${res.error}`);
      return;
    }
    for (const w of res.writes) {
      writeRaw(scenarioKey(w.scenarioId), serialize(w.state));
    }
    workspace = res.index;
    saveWorkspace();
    if (parsed.kind === "scenario") {
      navigate({ page: "client", clientId: workspace.activeClientId });
    } else {
      renderClientsPage(); // imported client appears in the list
    }
  };
  reader.readAsText(file);
});

// --- breadcrumb ---------------------------------------------------------
//
// items: { label, href } render as links; { label, onRename, rerender }
// renders the current page's name as an inline-renameable button.

let breadcrumbRename = null;

function renderBreadcrumb(items) {
  els.breadcrumb.hidden = items.length === 0;
  breadcrumbRename = null;
  els.breadcrumb.innerHTML = items.map((it, i) => {
    const sep = i > 0 ? `<span class="bc-sep">/</span>` : "";
    if (it.href) return `${sep}<a class="bc-link" href="${it.href}">${escapeHTML(it.label)}</a>`;
    if (it.onRename) {
      breadcrumbRename = it;
      return `${sep}<button class="bc-name" type="button" data-bc-rename
                     title="Click to rename">${escapeHTML(it.label)}</button>`;
    }
    return `${sep}<span class="bc-current">${escapeHTML(it.label)}</span>`;
  }).join("");
}

els.breadcrumb.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-bc-rename]");
  if (!btn || !breadcrumbRename) return;
  const it = breadcrumbRename;
  startInlineRename(btn, it.label, it.onRename, it.rerender);
});

function renderWorkspaceBreadcrumb() {
  const { client, scenario } = findActive(workspace);
  if (!client || !scenario) return;
  const items = [
    { label: "Clients", href: "#/clients" },
    { label: client.name, href: formatRoute({ page: "client", clientId: client.id }) },
    {
      label: scenario.name,
      onRename: (name) => {
        workspace = renameScenario(workspace, client.id, scenario.id, name);
        saveWorkspace();
      },
      rerender: renderWorkspaceBreadcrumb,
    },
  ];
  const sectionLabel = currentRoute?.section && SECTION_LABELS[currentRoute.section];
  if (sectionLabel) items.push({ label: sectionLabel });
  renderBreadcrumb(items);
}

// --- Clients page ---------------------------------------------------------

function fmtUpdated(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  return new Date(ts).toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const clientUpdatedAt = (c) => Math.max(0, ...c.scenarios.map((s) => s.updatedAt || 0));

function renderClientsPage() {
  renderBreadcrumb([]); // root page — no breadcrumb
  const canDelete = workspace.clients.length > 1;
  const rows = workspace.clients.map((c) => `
    <div class="list-row" data-id="${c.id}">
      <a class="list-name" href="${formatRoute({ page: "client", clientId: c.id })}">${escapeHTML(c.name)}</a>
      <span class="list-meta">${c.scenarios.length} scenario${c.scenarios.length === 1 ? "" : "s"}</span>
      <span class="list-meta">${fmtUpdated(clientUpdatedAt(c))}</span>
      <span class="list-actions">
        <button class="btn-text" type="button" data-action="rename" data-id="${c.id}">Rename</button>
        <button class="btn-text" type="button" data-action="export" data-id="${c.id}">Export</button>
        <button class="btn-text list-danger" type="button" data-action="delete" data-id="${c.id}"
                ${canDelete ? "" : "disabled"}>Delete</button>
      </span>
    </div>
  `).join("");
  els.pageClients.innerHTML = `
    <header class="page-head">
      <h1>Clients</h1>
      <div class="page-actions">
        <button class="btn-text" type="button" data-action="new-client">+ New client</button>
        <button class="btn-text" type="button" data-action="import">Import JSON…</button>
      </div>
    </header>
    <div class="list">
      <div class="list-head"><span>Name</span><span>Scenarios</span><span>Last updated</span><span></span></div>
      ${rows}
    </div>
  `;
}

els.pageClients.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  switch (btn.dataset.action) {
    case "new-client": {
      const r = newClient(workspace, Date.now());
      writeRaw(scenarioKey(r.scenarioId), serialize(defaultState(PROFILES)));
      workspace = r.index;
      saveWorkspace();
      navigate({ page: "client", clientId: r.clientId });
      break;
    }
    case "import":
      importInput.click();
      break;
    case "rename": {
      const client = findClient(workspace, id);
      const nameEl = els.pageClients.querySelector(`.list-row[data-id="${id}"] .list-name`);
      if (!client || !nameEl) break;
      startInlineRename(nameEl, client.name, (name) => {
        workspace = renameClient(workspace, id, name);
        saveWorkspace();
      }, renderClientsPage);
      break;
    }
    case "export": {
      const client = findClient(workspace, id);
      const file = exportClientFile(workspace, id, getScenarioState);
      if (client && file) downloadJSON(client.name, file);
      break;
    }
    case "delete": {
      const client = findClient(workspace, id);
      if (!client) break;
      if (!window.confirm(`Delete client "${client.name}" and all of its scenarios? This cannot be undone.`)) break;
      const r = deleteClient(workspace, id);
      if (!r) break; // cannot delete the last client
      for (const sid of r.removedScenarioIds) removeRaw(scenarioKey(sid));
      workspace = r.index;
      saveWorkspace();
      renderClientsPage();
      break;
    }
  }
});

// --- Client page (a client's scenarios) --------------------------------------

function renderClientPage(clientId) {
  const client = findClient(workspace, clientId);
  if (!client) { location.replace("#/clients"); return; }
  renderBreadcrumb([
    { label: "Clients", href: "#/clients" },
    {
      label: client.name,
      onRename: (name) => {
        workspace = renameClient(workspace, clientId, name);
        saveWorkspace();
      },
      rerender: () => renderClientPage(clientId),
    },
  ]);
  const canDelete = client.scenarios.length > 1;
  const rows = client.scenarios.map((s) => `
    <div class="list-row list-row-scenario" data-id="${s.id}">
      <a class="list-name" href="${formatRoute({ page: "workspace", clientId, scenarioId: s.id })}">${escapeHTML(s.name)}</a>
      <span class="list-meta">${fmtUpdated(s.updatedAt)}</span>
      <span class="list-actions">
        <button class="btn-text" type="button" data-action="rename" data-id="${s.id}">Rename</button>
        <button class="btn-text" type="button" data-action="duplicate" data-id="${s.id}">Duplicate</button>
        <button class="btn-text" type="button" data-action="export" data-id="${s.id}">Export</button>
        <button class="btn-text list-danger" type="button" data-action="delete" data-id="${s.id}"
                ${canDelete ? "" : "disabled"}>Delete</button>
      </span>
    </div>
  `).join("");
  els.pageClient.innerHTML = `
    <header class="page-head">
      <h1>Scenarios</h1>
      <div class="page-actions">
        <button class="btn-text" type="button" data-action="new-scenario">+ New scenario</button>
      </div>
    </header>
    <div class="list">
      <div class="list-head list-head-scenario"><span>Name</span><span>Last updated</span><span></span></div>
      ${rows}
    </div>
  `;
}

els.pageClient.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const clientId = currentRoute?.clientId;
  const client = findClient(workspace, clientId);
  if (!client) return;
  const sid = btn.dataset.id;
  const scenario = client.scenarios.find((s) => s.id === sid) || null;
  switch (btn.dataset.action) {
    case "new-scenario": {
      const r = newScenario(workspace, clientId, Date.now());
      writeRaw(scenarioKey(r.scenarioId), serialize(defaultState(PROFILES)));
      workspace = r.index;
      saveWorkspace();
      navigate({ page: "workspace", clientId, scenarioId: r.scenarioId });
      break;
    }
    case "rename": {
      const nameEl = els.pageClient.querySelector(`.list-row[data-id="${sid}"] .list-name`);
      if (!scenario || !nameEl) break;
      startInlineRename(nameEl, scenario.name, (name) => {
        workspace = renameScenario(workspace, clientId, sid, name);
        saveWorkspace();
      }, () => renderClientPage(clientId));
      break;
    }
    case "duplicate": {
      if (!scenario) break;
      const r = duplicateScenario(workspace, clientId, sid, Date.now());
      // Deep copy via the serialized blob — never a shared reference. A
      // scenario with no blob yet duplicates as defaults, matching load.
      writeRaw(scenarioKey(r.scenarioId), readRaw(scenarioKey(sid)) ?? serialize(defaultState(PROFILES)));
      workspace = r.index;
      saveWorkspace();
      renderClientPage(clientId);
      break;
    }
    case "export": {
      if (!scenario) break;
      const file = exportScenarioFile(workspace, clientId, sid, getScenarioState);
      if (file) downloadJSON(`${client.name} - ${scenario.name}`, file);
      break;
    }
    case "delete": {
      if (!scenario) break;
      if (!window.confirm(`Delete scenario "${scenario.name}"? This cannot be undone.`)) break;
      const r = deleteScenario(workspace, clientId, sid);
      if (!r) break; // cannot delete the last scenario in a client
      removeRaw(scenarioKey(r.removedScenarioId));
      workspace = r.index;
      saveWorkspace();
      renderClientPage(clientId);
      break;
    }
  }
});

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

// Today's date (real-world, not plan-relative), ISO — used to bound an
// "Owned" property's acquisition date input (input integrity: you
// can't already own something you haven't bought yet, so a future
// date there is unenterable, not just warned about — see CLAUDE.md).
const todayISO = () => new Date().toISOString().slice(0, 10);

const isCouple = () => !!state.plan.partner;

// --- Setup (plan bar): identity, timeline, tax profiles (D1) ---------------

const clientName = () => personDisplayName(state.plan.client, "Client");
const partnerName = () => personDisplayName(state.plan.partner, "Partner");

// "Projecting to age 92 (FY 2078–79) — life expectancy of Jo Smith + 5"
function endResolutionText(p) {
  const fy = fyLabelForAge(p, "client", p.endAge);
  const head = `Projecting to age ${p.endAge} (${fy})`;
  if (p.endBasis.mode === "fixedAge") return `${head} — fixed age`;
  if (p.endBasis.mode === "fixedYears") return `${head} — fixed ${p.endBasis.fixedYears} years`;
  const { anchor } = resolveEndBasis(p.endBasis, p.client, p.partner);
  const who = anchor === "partner"
    ? personDisplayName(p.partner, "the partner")
    : personDisplayName(p.client, "the client");
  const off = p.endBasis.offset;
  const offTxt = off === 0 ? "" : off > 0 ? ` + ${off}` : ` − ${-off}`;
  return `${head} — life expectancy of ${who}${offTxt}`;
}

// Tier 1.2, Commit 4: the work-test toggle is only shown when this
// person is actually 67–74 at some point during the projection — a
// client who is already 80, or a partner whose whole window is under
// 67, never needs it cluttering Setup. The partner ages alongside the
// client from their own current age (D1 convention), so the partner's
// window length matches the client's, not the partner's own end age.
function personSpansWorkTestAges(person) {
  const years = state.plan.endAge - state.plan.client.currentAge;
  const from = person.currentAge;
  const to = from + years;
  return from <= 74 && to >= 67;
}

function personBlockHTML(prefix, person, title) {
  const tp = person.taxProfile;
  const owner = prefix === "client" ? "client" : "partner";
  const ownerSuperAccounts = (state.plan.superAccounts ?? []).filter((s) => s.owner === owner && s.include);
  const divTaxPaidFrom = person.super?.divTaxPaidFrom === "cash" ? "cash" : "super";
  return `
    <div class="person-block">
      <div class="cf-section-title">${escapeHTML(title)}</div>
      <div class="person-grid">
        <div class="cf-cell">
          <label>First name</label>
          <input type="text" maxlength="40" value="${escapeHTML(person.firstName)}"
                 data-plan-field="${prefix}FirstName" />
        </div>
        <div class="cf-cell">
          <label>Surname</label>
          <input type="text" maxlength="40" value="${escapeHTML(person.surname)}"
                 data-plan-field="${prefix}Surname" />
        </div>
        <div class="cf-cell">
          <label>Date of birth <span class="live-age">· age ${person.currentAge}</span></label>
          <input type="date" value="${person.dob}" data-plan-field="${prefix}Dob" />
        </div>
        <div class="cf-cell">
          <label>Sex <span class="helper-inline">used for life expectancy</span></label>
          <select data-plan-field="${prefix}Sex">
            <option value="male"${person.sex !== "female" ? " selected" : ""}>Male</option>
            <option value="female"${person.sex === "female" ? " selected" : ""}>Female</option>
          </select>
        </div>
        <div class="cf-cell">
          <label>Tax residency</label>
          <select data-plan-field="${prefix}Residency">
            <option value="resident"${tp.residency !== "nonResident" ? " selected" : ""}>Australian resident</option>
            <option value="nonResident"${tp.residency === "nonResident" ? " selected" : ""}>Non-resident</option>
          </select>
        </div>
        <div class="cf-cell">
          <label>Medicare levy</label>
          <select data-plan-field="${prefix}Medicare">
            <option value="applies"${!tp.medicareExempt ? " selected" : ""}>Applies</option>
            <option value="exempt"${tp.medicareExempt ? " selected" : ""}>Exempt</option>
          </select>
        </div>
        <div class="cf-cell">
          <label>Retirement age
            <span class="helper-inline">Used as the Retirement key date and as the default report period anchor.</span>
          </label>
          <input type="number" min="${person.currentAge}" max="${state.plan.endAge}" step="1" value="${person.retirementAge}"
                 data-plan-field="${prefix}RetirementAge" />
        </div>
        ${personSpansWorkTestAges(person) ? `
          <div class="cf-cell">
            <label>Work test met (age 67–74)
              <span class="helper-inline">Gates personal deductible super contributions in that age band. The work-test exemption itself is not modelled.</span>
            </label>
            <label class="ptg-check">
              <input type="checkbox" data-plan-field="${prefix}WorkTestMet"${person.super?.workTestMet !== false ? " checked" : ""} />
              <span>Yes</span>
            </label>
          </div>
        ` : ""}
        <div class="cf-cell">
          <label>Opening carry-forward capital losses ($)</label>
          <input type="number" min="0" step="1000" value="${tp.openingCapitalLosses}"
                 data-plan-field="${prefix}OpeningLosses" />
        </div>
        <div class="cf-cell">
          <label>Division 293 / 296 tax paid from
            <span class="helper-inline">The taxpayer may elect either; release from super is the common election.</span>
          </label>
          <select data-plan-field="${prefix}DivTaxPaidFrom">
            <option value="super"${divTaxPaidFrom === "super" ? " selected" : ""}>Super (release authority)</option>
            <option value="cash"${divTaxPaidFrom === "cash" ? " selected" : ""}>Personal cash</option>
          </select>
        </div>
        ${divTaxPaidFrom === "super" && ownerSuperAccounts.length > 1 ? `
          <div class="cf-cell">
            <label>Release from which account?</label>
            <select data-plan-field="${prefix}DivTaxReleaseAccountId">
              <option value=""${!person.super?.divTaxReleaseAccountId ? " selected" : ""}>Largest balance (default)</option>
              ${ownerSuperAccounts.map((a) => `<option value="${escapeHTML(a.id)}"${person.super?.divTaxReleaseAccountId === a.id ? " selected" : ""}>${escapeHTML(a.name)}</option>`).join("")}
            </select>
          </div>
        ` : ""}
        <div class="cf-cell">
          <label>Eligible for Centrelink benefits
            <span class="coming-soon-tag" title="No engine effect yet">Used when Centrelink modelling arrives</span>
          </label>
          <label class="ptg-check">
            <input type="checkbox" data-plan-field="${prefix}Centrelink"${tp.centrelinkEligible ? " checked" : ""} />
            <span>Yes</span>
          </label>
        </div>
      </div>
    </div>
  `;
}

// --- key dates block (Tier 1.1) ----------------------------------------
//
// Built-in anchors (Start, End, the retirement anchors) are listed as
// read-only reference rows — the user can see what's available without
// being able to delete them; user key dates below are the only
// editable rows.

function keyDateReadoutHTML(a) {
  return a.outOfRange
    ? `<span class="date-ref-resolved date-ref-outofrange">Falls outside the projection window — clamped to age ${a.age}</span>`
    : `<span class="date-ref-resolved">age ${a.age} (${a.fyLabel})</span>`;
}

const BUILT_IN_ANCHOR_IDS = new Set(["start", "end", "retirement-client", "retirement-partner"]);

function keyDateRowHTML(anchor) {
  const kd = state.plan.keyDates.find((k) => k.id === anchor.id);
  return `
    <div class="kd-row" data-kd-id="${kd.id}">
      <input type="text" maxlength="60" placeholder="Label" value="${escapeHTML(kd.label)}"
             data-kd-field="label" data-kd-id="${kd.id}" />
      ${state.plan.partner ? `
        <select data-kd-field="basis" data-kd-id="${kd.id}">
          <option value="client"${kd.basis === "client" ? " selected" : ""}>${escapeHTML(clientName())}</option>
          <option value="partner"${kd.basis === "partner" ? " selected" : ""}>${escapeHTML(partnerName())}</option>
        </select>
      ` : ""}
      <input type="number" min="0" max="130" step="1" value="${kd.age}"
             data-kd-field="age" data-kd-id="${kd.id}" />
      ${keyDateReadoutHTML(anchor)}
      <button class="cf-remove" type="button" data-kd-action="remove" data-kd-id="${kd.id}" aria-label="Remove key date">×</button>
    </div>
  `;
}

function keyDatesBlockHTML() {
  const anchors = listAnchors(state.plan, projection.schedule);
  const builtins = anchors.filter((a) => BUILT_IN_ANCHOR_IDS.has(a.id));
  const userAnchors = anchors.filter((a) => !BUILT_IN_ANCHOR_IDS.has(a.id));
  return `
    <div class="key-dates-block">
      <div class="cf-section-title">Key dates</div>
      <p class="helper-text">Named ages referenced by every start/end field below — move one date here and everything that points at it moves too.</p>
      <div class="kd-list kd-builtin">
        ${builtins.map((a) => `
          <div class="kd-row kd-readonly">
            <span class="kd-label">${escapeHTML(a.label)}</span>
            ${keyDateReadoutHTML(a)}
          </div>
        `).join("")}
      </div>
      ${userAnchors.length ? `<div class="kd-list kd-user">${userAnchors.map(keyDateRowHTML).join("")}</div>` : ""}
      <button class="btn-text" type="button" data-kd-action="add">+ Add key date</button>
    </div>
  `;
}

els.planBar.addEventListener("change", (e) => {
  const kdId = e.target.dataset.kdId;
  const kdField = e.target.dataset.kdField;
  if (!kdId || !kdField) return;
  const kd = state.plan.keyDates.find((k) => k.id === kdId);
  if (!kd) return;
  if (kdField === "label") kd.label = e.target.value;
  else if (kdField === "basis") kd.basis = e.target.value === "partner" && state.plan.partner ? "partner" : "client";
  else if (kdField === "age") kd.age = Number(e.target.value);
  state.plan = clampPlan(state.plan, PROFILES);
  state = clampAllToPlan(state, PROFILES);
  saveState();
  renderAll();
});

els.planBar.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-kd-action]");
  if (!btn) return;
  if (btn.dataset.kdAction === "add") {
    state.plan.keyDates = [...state.plan.keyDates, createKeyDate(state.plan)];
    saveState();
    renderAll();
    return;
  }
  if (btn.dataset.kdAction === "remove") {
    const kdId = btn.dataset.kdId;
    const refs = referencesToAnchor(state, kdId);
    if (refs.length > 0) {
      const resolvedAge = resolveRef({ kind: "anchor", anchorId: kdId }, state.plan, projection.schedule).age;
      const names = refs.map((r) => r.label).join(", ");
      const ok = window.confirm(
        `${refs.length} row(s) reference this key date: ${names}.\n\n` +
        `OK — convert those references to age ${resolvedAge}.\nCancel — keep the key date.`
      );
      if (!ok) return; // never orphan a reference, never silently drop data
      state = convertAnchorReferences(state, kdId, resolvedAge);
    }
    state.plan = removeKeyDate(state.plan, kdId);
    state = clampAllToPlan(state, PROFILES);
    saveState();
    renderAll();
  }
});

const END_MODE_OPTIONS = [
  ["le:0", "Life expectancy"],
  ["le:5", "Life expectancy + 5"], ["le:10", "Life expectancy + 10"],
  ["le:15", "Life expectancy + 15"], ["le:20", "Life expectancy + 20"],
  ["le:-5", "Life expectancy − 5"], ["le:-10", "Life expectancy − 10"],
  ["le:-15", "Life expectancy − 15"],
  ["fixedAge", "Fixed age"], ["fixedYears", "Fixed number of years"],
];

function renderPlanBar() {
  const p = state.plan;
  const couple = isCouple();
  const endModeValue = p.endBasis.mode === "le" ? `le:${p.endBasis.offset}` : p.endBasis.mode;
  els.planBar.innerHTML = `
    <div class="plan-field">
      <label>Marital status</label>
      <div class="seg-toggle">
        ${[["single", "Single"], ["married", "Married"], ["defacto", "De facto"]].map(([v, l]) => `
          <button class="seg-option${p.household === v ? " active" : ""}" type="button"
                  data-plan-action="household" data-value="${v}">${l}</button>
        `).join("")}
      </div>
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
    <div class="plan-field">
      <label>Projection end</label>
      <div class="plan-start">
        <select data-plan-field="endMode">
          ${END_MODE_OPTIONS.map(([v, l]) =>
            `<option value="${v}"${endModeValue === v ? " selected" : ""}>${l}</option>`
          ).join("")}
        </select>
        ${p.endBasis.mode === "fixedAge" ? `
          <input type="number" min="${p.client.currentAge + 1}" max="120" step="1" value="${p.endBasis.fixedAge}"
                 data-plan-field="endFixedAge" aria-label="Fixed end age" />` : ""}
        ${p.endBasis.mode === "fixedYears" ? `
          <input type="number" min="1" max="100" step="1" value="${p.endBasis.fixedYears}"
                 data-plan-field="endFixedYears" aria-label="Fixed number of years" />` : ""}
      </div>
    </div>
    <div class="plan-derived">${endResolutionText(p)} · ${planSummaryText(p)}</div>
    ${keyDatesBlockHTML()}
    ${personBlockHTML("client", p.client, couple ? `Client — ${clientName()}` : clientName())}
    ${couple ? personBlockHTML("partner", p.partner, `Partner — ${partnerName()}`) : ""}
  `;
}

// The workspace client's name follows the client's full name until the
// user renames it themselves (auto-names look like "Client 3").
function maybeDefaultWorkspaceClientName(field) {
  if (field !== "clientFirstName" && field !== "clientSurname") return;
  const full = personDisplayName(state.plan.client, "");
  if (!full) return;
  const { client } = findActive(workspace);
  if (client && /^Client \d+$/.test(client.name)) {
    workspace = renameClient(workspace, client.id, full);
    saveWorkspace();
    renderWorkspaceBreadcrumb();
  }
}

wireDeferredDateCommit(els.planBar, (e) => {
  const field = e.target.dataset.planField;
  if (!field) return;
  const p = state.plan;
  const person = (prefix, cur) => ({
    firstName: field === `${prefix}FirstName` ? e.target.value : cur.firstName,
    surname: field === `${prefix}Surname` ? e.target.value : cur.surname,
    dob: field === `${prefix}Dob` ? e.target.value : cur.dob,
    sex: field === `${prefix}Sex` ? e.target.value : cur.sex,
    currentAge: cur.currentAge, // fallback if the new DOB is invalid
    retirementAge: field === `${prefix}RetirementAge` ? e.target.value : cur.retirementAge,
    taxProfile: {
      residency: field === `${prefix}Residency` ? e.target.value : cur.taxProfile.residency,
      medicareExempt: field === `${prefix}Medicare` ? e.target.value === "exempt" : cur.taxProfile.medicareExempt,
      centrelinkEligible: field === `${prefix}Centrelink` ? e.target.checked : cur.taxProfile.centrelinkEligible,
      openingCapitalLosses: field === `${prefix}OpeningLosses` ? e.target.value : cur.taxProfile.openingCapitalLosses,
    },
    // Super carry-forward ledger etc. (Tier 1.2) — carried through
    // untouched by every OTHER Setup field edit; the work-test toggle
    // (Commit 2/4) and the Division 293/296 release election are the
    // only ones that write it here.
    super: field === `${prefix}WorkTestMet`
      ? { ...cur.super, workTestMet: e.target.checked }
      : field === `${prefix}DivTaxPaidFrom`
      ? { ...cur.super, divTaxPaidFrom: e.target.value }
      : field === `${prefix}DivTaxReleaseAccountId`
      ? { ...cur.super, divTaxReleaseAccountId: e.target.value || null }
      : cur.super,
  });
  let endBasis = { ...p.endBasis };
  if (field === "endMode") {
    const v = e.target.value;
    if (v === "fixedAge") endBasis = { ...endBasis, mode: "fixedAge", fixedAge: p.endAge };
    else if (v === "fixedYears") endBasis = { ...endBasis, mode: "fixedYears", fixedYears: Math.max(1, p.endAge - p.client.currentAge) };
    else endBasis = { ...endBasis, mode: "le", offset: Number(v.split(":")[1]) || 0 };
  } else if (field === "endFixedAge") {
    endBasis = { ...endBasis, fixedAge: Number(e.target.value) };
  } else if (field === "endFixedYears") {
    endBasis = { ...endBasis, fixedYears: Number(e.target.value) };
  }
  const next = {
    household: p.household,
    client: person("client", p.client),
    partner: p.partner ? person("partner", p.partner) : null,
    endBasis,
    start: {
      year: field === "startYear" ? e.target.value : p.start.year,
      month: field === "startMonth" ? e.target.value : p.start.month,
    },
    keyDates: p.keyDates,
    superAccounts: p.superAccounts,
  };
  state.plan = clampPlan(next, PROFILES);
  state = clampAllToPlan(state, PROFILES);
  saveState();
  maybeDefaultWorkspaceClientName(field);
  renderAll();
});

els.planBar.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-plan-action="household"]');
  if (!btn) return;
  const target = btn.dataset.value;
  if (target === state.plan.household) return;

  const wasCouple = isCouple();
  const willBeCouple = target === "married" || target === "defacto";

  if (willBeCouple) {
    state.plan = clampPlan({
      ...state.plan,
      household: target,
      partner: state.plan.partner ?? { currentAge: state.plan.client.currentAge },
    }, PROFILES);
  } else {
    // Couple → single: never orphan an owner.
    if (wasCouple) {
      const owned = partnerOwnedItems(state);
      if (owned.count > 0) {
        const reassign = window.confirm(
          `${owned.count} item(s) are owned by the partner (or jointly): ` +
          `${owned.assets.map((a) => a.name).concat(owned.income.map((r) => r.label)).concat(owned.deductions.map((r) => r.label)).join(", ")}.\n\n` +
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
    }
    state.plan = clampPlan({ ...state.plan, household: "single", partner: null }, PROFILES);
  }
  state = clampAllToPlan(state, PROFILES);
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
  const labels = { client: clientName(), partner: partnerName(), joint: "Joint" };
  return ["client", "partner", "joint"].map(
    (o) => `<option value="${o}"${o === selected ? " selected" : ""}>${escapeHTML(labels[o])}</option>`
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

function assetHeadMeta(a) {
  if (a.class === "lifestyle") {
    return `Lifestyle · ${fmtMoney(a.balance)} · ${(a.growthPct ?? 0).toFixed(1).replace(/\.0$/, "")}% growth${isCouple() ? ` · ${a.owner}` : ""}`;
  }
  return `${allocationSummary(a.allocation, PROFILES)} · ${fmtMoney(a.balance)}${isCouple() ? ` · ${a.owner}` : ""}`;
}

function assetCardHTML(a) {
  const isCollapsed = collapsed.get(a.id) === true;
  const excluded = !a.include;
  // Last-asset rule counts FINANCIAL assets; lifestyle always removable.
  const removable = a.class === "lifestyle"
    || state.assets.filter((x) => x.class !== "lifestyle").length > 1;

  const head = `
    <div class="pcard-head" data-action="toggle-collapse" data-aid="${a.id}">
      <button class="pcard-chevron${isCollapsed ? "" : " open"}" type="button"
              aria-label="${isCollapsed ? "Expand" : "Collapse"}"
              data-action="toggle-collapse" data-aid="${a.id}">▸</button>
      <span class="pcard-name" data-role="headName">${escapeHTML(a.name)}</span>
      <span class="pcard-meta" data-role="headMeta">${escapeHTML(assetHeadMeta(a))}</span>
      <label class="pcard-include" title="Include in projection totals">
        <input type="checkbox"${a.include ? " checked" : ""}
               data-action="toggle-include" data-aid="${a.id}" />
        <span>Include</span>
      </label>
      ${removable ? `
        <button class="pcard-remove" type="button" data-action="remove-asset" data-aid="${a.id}">Remove</button>
      ` : ""}
    </div>
  `;

  if (isCollapsed) {
    return `<div class="pcard${excluded ? " excluded" : ""}" data-aid="${a.id}">${head}</div>`;
  }

  // Lifestyle assets (D2): the minimal field set — value + simple
  // growth, nothing else.
  if (a.class === "lifestyle") {
    return `<div class="pcard${excluded ? " excluded" : ""}" data-aid="${a.id}">${head}
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
            <label>Value ($)</label>
            <input type="number" min="0" step="1000" value="${a.balance}"
                   data-aid="${a.id}" data-field="balance" />
          </div>
          <div class="cf-cell">
            <label>Growth (% p.a. nominal)</label>
            <input type="number" min="-10" max="30" step="0.1" value="${a.growthPct ?? 0}"
                   data-aid="${a.id}" data-field="growthPct" />
          </div>
        </div>
        <p class="helper-text">Lifestyle assets grow at their simple rate and sit outside the investment machinery — no income, fees, tax, or cashflow targeting, and they are never drawn on to fund deficits.</p>
      </div>
    </div>`;
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

// Financial assets can never be empty (the last-financial-asset rule),
// so its static heading/stack/Add-button markup in index.html never
// needs the page-empty treatment. Lifestyle assets can be empty.
function renderAssets() {
  els.assets.innerHTML = state.assets.filter((a) => a.class !== "lifestyle").map(assetCardHTML).join("");

  const lifestyleCards = state.assets.filter((a) => a.class === "lifestyle").map(assetCardHTML).join("");
  els.lifestyleSection.innerHTML = lifestyleCards === ""
    ? `
      <h2 class="section-heading">Lifestyle assets</h2>
      ${pageEmptyHTML(
        "Add lifestyle assets like vehicles, contents, or jewellery to include their value in net assets.",
        `<button class="add-row-btn" type="button" data-action="add-lifestyle-asset">+ Add lifestyle asset</button>`
      )}
    `
    : `
      <h2 class="section-heading">Lifestyle assets</h2>
      <div id="lifestyleAssets" class="portfolio-stack">${lifestyleCards}</div>
      <div class="portfolio-actions">
        <button class="btn-text" type="button" data-action="add-lifestyle-asset">+ Add lifestyle asset</button>
      </div>
    `;
}

function assetCardEl(aid) {
  return els.assets.querySelector(`.pcard[data-aid="${aid}"]`)
    || els.lifestyleSection.querySelector(`.pcard[data-aid="${aid}"]`);
}

function refreshCardHead(aid) {
  const a = findAsset(aid);
  const card = assetCardEl(aid);
  if (!a || !card) return;
  const nameEl = card.querySelector('[data-role="headName"]');
  const metaEl = card.querySelector('[data-role="headMeta"]');
  if (nameEl) nameEl.textContent = a.name;
  if (metaEl) metaEl.textContent = assetHeadMeta(a);
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
  // Cashflows may only target financial assets (D2).
  return state.assets.filter((a) => a.class !== "lifestyle").map(
    (a) => `<option value="${a.id}"${a.id === selected ? " selected" : ""}>${escapeHTML(a.name)}</option>`
  ).join("");
}

// A cashflow row targeting an excluded asset has no effect on the
// projection at all — the asset card itself dims when excluded, but a
// row in a table elsewhere never showed that (audit follow-up B1/B2:
// this was the only place "excluded" wasn't visibly flagged). Returns
// "" when the row's target is included or missing (no flag needed).
function assetExcludedFlagHTML(assetId) {
  const a = findAsset(assetId);
  if (!a || a.include) return "";
  return `<span class="cf-tag cf-tag-warn" title="&quot;${escapeHTML(a.name)}&quot; is excluded from the projection — this row has no effect until it's re-included.">excluded</span>`;
}

// A single date-ref control (Tier 1.1): a <select> listing every
// available anchor plus "Specific age…", each option carrying its
// resolved value so the user never has to work it out; a number input
// that only shows while "Specific age…" is chosen; and a resolved
// value/out-of-range readout beneath. `dataAttrs` stamps the caller's
// own data-* identifiers (data-kind/data-cfid/data-field for cashflow
// rows, data-pid/data-pfield for properties) onto both controls so the
// existing delegated change handlers can find the row/field; a
// `data-dr-role` of "anchor" or "age" tells them which control fired.
function dateRefControlHTML(ref, ownerForAges, dataAttrs, ageMin, ageMax) {
  const plan = state.plan;
  const schedule = projection.schedule;
  const anchors = listAnchors(plan, schedule);
  const isAnchor = ref?.kind === "anchor";
  const resolved = resolveRef(ref, plan, schedule, ownerForAges);
  const selectValue = isAnchor ? ref.anchorId : "__age__";
  const options = anchors.map((a) =>
    `<option value="${a.id}"${selectValue === a.id ? " selected" : ""}>${escapeHTML(a.display)}</option>`
  ).join("") + `<option value="__age__"${selectValue === "__age__" ? " selected" : ""}>Specific age…</option>`;
  // The number input is hidden (not removed) while an anchor is
  // chosen, pre-filled with the anchor's current resolved age so
  // switching to "Specific age…" starts from somewhere sensible rather
  // than a blank/zero box.
  const numberValue = isAnchor ? resolved.age : ref.age;
  // Short label shown when the select is closed (Cashflow sections:
  // table layout, one line per item) — "Start", "Retirement", "Age
  // 45" — the full "Retirement — <name> — age N (FYxx–yy)" form stays
  // exactly as-is in the open dropdown's own option text. A visual-only
  // overlay (pointer-events:none) sits on top of the native select so
  // clicking still opens its real popup, which is unaffected by the
  // overlay sitting behind it in the layer order.
  const shortLabel = isAnchor
    ? (anchors.find((a) => a.id === selectValue)?.label ?? "").split(" — ")[0]
    : `Age ${resolved.age}`;
  return `
    <div class="date-ref">
      <div class="date-ref-select-wrap">
        <select ${dataAttrs} data-dr-role="anchor">${options}</select>
        <span class="date-ref-short" aria-hidden="true">${escapeHTML(shortLabel)}</span>
      </div>
      <input type="number" min="${ageMin}" max="${ageMax}" step="1" value="${numberValue}"
             ${dataAttrs} data-dr-role="age"${isAnchor ? " hidden" : ""} />
      <span class="date-ref-resolved${resolved.outOfRange ? " date-ref-outofrange" : ""}">${
        resolved.outOfRange
          ? `Falls outside the projection window — clamped to age ${resolved.age}`
          : `age ${resolved.age} (${resolved.fyLabel})`
      }</span>
    </div>
  `;
}

function incomeRowHTML(r) {
  return `
    <tr class="cf-tr" data-cfid="${r.id}">
      <td class="cf-td-category">
        <select data-kind="income" data-cfid="${r.id}" data-field="category">
          ${INCOME_CATEGORIES.map((c) => `<option value="${c}"${r.category === c ? " selected" : ""}>${escapeHTML(INCOME_CATEGORY_LABELS[c])}</option>`).join("")}
        </select>
        ${r.category === "salary" ? `
          <label class="ptg-check cf-sg-check">
            <input type="checkbox"${r.sgApplies !== false ? " checked" : ""}
                   data-kind="income" data-cfid="${r.id}" data-field="sgApplies" />
            <span>SG applies</span>
          </label>
        ` : ""}
      </td>
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(r.label)}" maxlength="60"
               data-kind="income" data-cfid="${r.id}" data-field="label" />
      </td>
      ${isCouple() ? `
        <td class="cf-td-owner">
          <select data-kind="income" data-cfid="${r.id}" data-field="owner">
            <option value="client"${r.owner === "client" ? " selected" : ""}>${escapeHTML(clientName())}</option>
            <option value="partner"${r.owner === "partner" ? " selected" : ""}>${escapeHTML(partnerName())}</option>
          </select>
        </td>
      ` : ""}
      ${amountTdHTML("income", r.id, r.amount)}
      <td class="cf-td-freq">
        <select data-kind="income" data-cfid="${r.id}" data-field="frequency">
          <option value="monthly"${r.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${r.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </td>
      <td class="cf-td-date">${dateRefControlHTML(r.from, r.owner, `data-kind="income" data-cfid="${r.id}" data-field="from"`, 18, 120)}</td>
      <td class="cf-td-date">${dateRefControlHTML(r.to, r.owner, `data-kind="income" data-cfid="${r.id}" data-field="to"`, 18, 120)}</td>
      ${indexationTdHTML("income", r)}
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-action="remove-row" data-kind="income" data-cfid="${r.id}">×</button>
      </td>
    </tr>
  `;
}

function expenseRowHTML(r) {
  return `
    <tr class="cf-tr" data-cfid="${r.id}">
      <td class="cf-td-category">
        <select data-kind="expenses" data-cfid="${r.id}" data-field="category">
          ${EXPENSE_CATEGORIES.map((c) => `<option value="${c}"${r.category === c ? " selected" : ""}>${escapeHTML(EXPENSE_CATEGORY_LABELS[c])}</option>`).join("")}
        </select>
      </td>
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(r.label)}" maxlength="60"
               data-kind="expenses" data-cfid="${r.id}" data-field="label" />
      </td>
      ${amountTdHTML("expenses", r.id, r.amount)}
      <td class="cf-td-freq">
        <select data-kind="expenses" data-cfid="${r.id}" data-field="frequency">
          <option value="monthly"${r.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${r.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </td>
      <td class="cf-td-date">${dateRefControlHTML(r.from, "client", `data-kind="expenses" data-cfid="${r.id}" data-field="from"`, 18, 120)}</td>
      <td class="cf-td-date">${dateRefControlHTML(r.to, "client", `data-kind="expenses" data-cfid="${r.id}" data-field="to"`, 18, 120)}</td>
      ${indexationTdHTML("expenses", r)}
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-action="remove-row" data-kind="expenses" data-cfid="${r.id}">×</button>
      </td>
    </tr>
  `;
}

// PAYG withholding, tax refund timing, and deductions: a deduction row
// reduces its owner's assessable income only — it never itself debits
// household cash (disclosed — see schedule.js's deductionsByOwner
// header comment). Enter a matching Expense row too if the underlying
// spend also needs to leave household cash.
function deductionRowHTML(r) {
  return `
    <tr class="cf-tr" data-cfid="${r.id}">
      <td class="cf-td-category">
        <select data-kind="deductions" data-cfid="${r.id}" data-field="category">
          ${DEDUCTION_CATEGORIES.map((c) =>
            `<option value="${c}"${r.category === c ? " selected" : ""}>${escapeHTML(DEDUCTION_CATEGORY_LABELS[c])}</option>`
          ).join("")}
        </select>
      </td>
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(r.label)}" maxlength="60"
               data-kind="deductions" data-cfid="${r.id}" data-field="label" />
      </td>
      ${isCouple() ? `
        <td class="cf-td-owner">
          <select data-kind="deductions" data-cfid="${r.id}" data-field="owner">
            <option value="client"${r.owner === "client" ? " selected" : ""}>${escapeHTML(clientName())}</option>
            <option value="partner"${r.owner === "partner" ? " selected" : ""}>${escapeHTML(partnerName())}</option>
          </select>
        </td>
      ` : ""}
      ${amountTdHTML("deductions", r.id, r.amount)}
      <td class="cf-td-freq">
        <select data-kind="deductions" data-cfid="${r.id}" data-field="frequency">
          <option value="monthly"${r.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${r.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </td>
      <td class="cf-td-date">${dateRefControlHTML(r.from, r.owner, `data-kind="deductions" data-cfid="${r.id}" data-field="from"`, 18, 120)}</td>
      <td class="cf-td-date">${dateRefControlHTML(r.to, r.owner, `data-kind="deductions" data-cfid="${r.id}" data-field="to"`, 18, 120)}</td>
      ${indexationTdHTML("deductions", r)}
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-action="remove-row" data-kind="deductions" data-cfid="${r.id}">×</button>
      </td>
    </tr>
  `;
}

function contributionRowHTML(kind, cf) {
  return `
    <tr class="cf-tr" data-cfid="${cf.id}">
      <td class="cf-td-asset">
        <select data-kind="${kind}" data-cfid="${cf.id}" data-field="assetId">${assetOptions(cf.assetId)}</select>
        ${assetExcludedFlagHTML(cf.assetId)}
      </td>
      ${amountTdHTML(kind, cf.id, cf.amount)}
      <td class="cf-td-freq">
        <select data-kind="${kind}" data-cfid="${cf.id}" data-field="frequency">
          <option value="monthly"${cf.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${cf.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </td>
      <td class="cf-td-date">${dateRefControlHTML(cf.from, "client", `data-kind="${kind}" data-cfid="${cf.id}" data-field="from"`, 18, 120)}</td>
      <td class="cf-td-date">${dateRefControlHTML(cf.to, "client", `data-kind="${kind}" data-cfid="${cf.id}" data-field="to"`, 18, 120)}</td>
      ${indexationTdHTML(kind, cf)}
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-action="remove-row" data-kind="${kind}" data-cfid="${cf.id}">×</button>
      </td>
    </tr>
  `;
}

// Amount cell (Cashflow sections: table layout, one line per item) —
// right-aligned, thousands-separated on blur/render; a delegated
// focusin handler (below) strips the separators back to a plain
// editable number.
const fmtAmountValue = (v) => Number(v || 0).toLocaleString("en-AU", { maximumFractionDigits: 2 });
function amountTdHTML(kind, id, value) {
  return `
    <td class="cf-td-amount">
      <input type="text" inputmode="decimal" class="cf-amount-input" value="${fmtAmountValue(value)}"
             data-kind="${kind}" data-cfid="${id}" data-field="amount" />
    </td>`;
}

// Indexation collapses to a single "Indexation" header over two narrow
// adjacent inputs (basis select + additional %), with the computed
// nominal total as muted subtext beneath — Cashflow sections: table
// layout, one line per item. Basis option labels shortened to
// None/CPI/Wages (the full "Wage index (AWOTE)" form stays on the
// input-panel-only controls untouched by this — Assumptions/deduction
// selects elsewhere are unaffected).
function indexationTdHTML(kind, row) {
  const basis = row.indexBasis ?? (row.indexed === false ? "none" : "cpi");
  const extra = row.indexExtraPct ?? 0;
  const basisRate = basis === "awote"
    ? (state.assumptions.awote ?? 0.035)
    : basis === "cpi" ? state.assumptions.cpi : 0;
  const fixed1 = (v) => `${v.toFixed(1)}%`;
  const total = basis === "none" && extra === 0
    ? "Fixed nominal"
    : `${fixed1(basisRate * 100)} + ${fixed1(extra)} = ${fixed1(basisRate * 100 + extra)}`;
  return `
    <td class="cf-td-index">
      <div class="cf-index-pair">
        <select data-kind="${kind}" data-cfid="${row.id}" data-field="indexBasis" aria-label="Index basis">
          <option value="none"${basis === "none" ? " selected" : ""}>None</option>
          <option value="cpi"${basis === "cpi" ? " selected" : ""}>CPI</option>
          <option value="awote"${basis === "awote" ? " selected" : ""}>Wages</option>
        </select>
        <input type="number" min="-10" max="10" step="0.1" value="${extra}" aria-label="Additional %"
               data-kind="${kind}" data-cfid="${row.id}" data-field="indexExtraPct" />
      </div>
      <span class="index-total">${total}</span>
    </td>`;
}

// Super contributions carries too many columns to fit Indexation on
// the same line at 1280px even with every other column trimmed —
// "drop Indexation to a second line for that section only" (Cashflow
// sections: table layout, one line per item). Same basis+extra%
// controls and computed total, rendered as a full-width detail row
// immediately beneath the contribution row instead of its own column.
function indexationDetailRowHTML(kind, row) {
  const basis = row.indexBasis ?? (row.indexed === false ? "none" : "cpi");
  const extra = row.indexExtraPct ?? 0;
  const basisRate = basis === "awote"
    ? (state.assumptions.awote ?? 0.035)
    : basis === "cpi" ? state.assumptions.cpi : 0;
  const fixed1 = (v) => `${v.toFixed(1)}%`;
  const total = basis === "none" && extra === 0
    ? "Fixed nominal"
    : `${fixed1(basisRate * 100)} + ${fixed1(extra)} = ${fixed1(basisRate * 100 + extra)}`;
  return `
    <tr class="cf-tr-detail">
      <td colspan="99">
        <div class="cf-detail-index-row">
          <span class="cf-detail-label">Indexation</span>
          <select data-kind="${kind}" data-cfid="${row.id}" data-field="indexBasis" aria-label="Index basis">
            <option value="none"${basis === "none" ? " selected" : ""}>None</option>
            <option value="cpi"${basis === "cpi" ? " selected" : ""}>CPI</option>
            <option value="awote"${basis === "awote" ? " selected" : ""}>Wages</option>
          </select>
          <input type="number" min="-10" max="10" step="0.1" value="${extra}" aria-label="Additional %"
                 data-kind="${kind}" data-cfid="${row.id}" data-field="indexExtraPct" />
          <span class="index-total">${total}</span>
        </div>
      </td>
    </tr>`;
}

function lumpSumRowHTML(ls) {
  return `
    <tr class="cf-tr" data-cfid="${ls.id}">
      <td class="cf-td-asset">
        <select data-kind="lumpSums" data-cfid="${ls.id}" data-field="assetId">${assetOptions(ls.assetId)}</select>
        ${ls.source === "table" ? '<span class="cf-tag">from table</span>' : ""}
        ${assetExcludedFlagHTML(ls.assetId)}
      </td>
      ${amountTdHTML("lumpSums", ls.id, ls.amount)}
      <td class="cf-td-direction">
        <select data-kind="lumpSums" data-cfid="${ls.id}" data-field="direction">
          <option value="in"${ls.direction === "in" ? " selected" : ""}>In (deposit)</option>
          <option value="out"${ls.direction === "out" ? " selected" : ""}>Out (withdrawal)</option>
        </select>
      </td>
      <td class="cf-td-date">${dateRefControlHTML(ls.at, "client", `data-kind="lumpSums" data-cfid="${ls.id}" data-field="at"`, 18, 120)}</td>
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-action="remove-row" data-kind="lumpSums" data-cfid="${ls.id}">×</button>
      </td>
    </tr>
  `;
}

// Fact-find empty-state treatment (A.3, extended for the sidebar's
// one-section-per-page layout): each input section is now a full page
// on its own, so an empty section renders a page-sized purpose
// sentence + Add button rather than the old collapsed strip — nothing
// crowds it, so it should read as "finished, not started" rather than
// "half-built".

function addRowBtn(kind, label) {
  return `<button class="add-row-btn" type="button" data-action="add-row" data-kind="${kind}">+ ${label}</button>`;
}

// Header cell sets, one per cashflow-style list section (Cashflow
// sections: table layout, one line per item) — computed per-render
// since Owner columns only appear for couples. Column order matches
// each row-HTML function's <td> order exactly.
const cfHeaders = {
  income: () => `<th>Category</th><th>Label</th>${isCouple() ? "<th>Owner</th>" : ""}<th>Amount ($)</th><th>Freq</th><th>From</th><th>To</th><th>Indexation</th>`,
  deductions: () => `<th>Category</th><th>Label</th>${isCouple() ? "<th>Owner</th>" : ""}<th>Amount ($)</th><th>Freq</th><th>From</th><th>To</th><th>Indexation</th>`,
  expenses: () => `<th>Category</th><th>Label</th><th>Amount ($)</th><th>Freq</th><th>From</th><th>To</th><th>Indexation</th>`,
  contributions: () => `<th>Asset</th><th>Amount ($)</th><th>Freq</th><th>From</th><th>To</th><th>Indexation</th>`,
  withdrawals: () => `<th>Asset</th><th>Amount ($)</th><th>Freq</th><th>From</th><th>To</th><th>Indexation</th>`,
  lumpSums: () => `<th>Asset</th><th>Amount ($)</th><th>Direction</th><th>At</th>`,
  // No Indexation column — dropped to a second line beneath each row
  // (Cashflow sections: table layout, point 6) — this section alone
  // has too many columns to fit it on the same line at 1280px.
  superContributions: () => `<th>Label</th><th>Type</th>${isCouple() ? "<th>Owner</th>" : ""}<th>Account</th><th>Basis</th><th>Amount / detail</th><th>Freq</th><th>From</th><th>To</th>`,
  superWithdrawals: () => `<th>Label</th>${isCouple() ? "<th>Owner</th>" : ""}<th>Account</th><th>Amount ($)</th><th>Freq</th><th>From</th><th>To</th><th>Indexation</th>`,
};

function pageEmptyHTML(sentence, actionsHTML) {
  return `
    <div class="page-empty">
      <p class="page-empty-text">${escapeHTML(sentence)}</p>
      <div class="page-empty-actions">${actionsHTML}</div>
    </div>
  `;
}

// Cashflow sections: table layout, one line per item. Every
// repeatable cashflow-style list section (Income, Expenses,
// Deductions, Contributions, Withdrawals, One-off amounts, Super
// contributions, Super withdrawals) renders as a real <table>: ONE
// sticky header row per section, naming every column once, and one
// compact <tr> per entered row underneath — replacing the old card
// grid, which repeated its full label set on every row (five expenses
// used to print the header set five times). headerCellsHTML is the
// <th> markup for this section's own columns; a trailing blank <th>
// for the remove button is added here so every caller doesn't repeat
// it.
function cfTableHTML(headerCellsHTML, rowsHTML) {
  return `
    <div class="cf-table-wrap">
      <table class="cf-table">
        <thead><tr>${headerCellsHTML}<th class="cf-th-remove" aria-hidden="true"></th></tr></thead>
        <tbody>${rowsHTML}</tbody>
      </table>
    </div>
  `;
}

// Top-level fact-find section (Income / Expenses / Deductions):
// page-sized empty state with a purpose sentence when empty; heading +
// table otherwise.
function ffSectionHTML(title, kind, addLabel, headerCellsHTML, rowsHTML, helperHTML = "", purposeSentence = "") {
  const empty = rowsHTML === "";
  if (empty) {
    return `
      <h2 class="section-heading">${title}</h2>
      ${pageEmptyHTML(purposeSentence, addRowBtn(kind, addLabel))}
    `;
  }
  return `
    <div class="ff-section">
      <div class="ff-head"><h2 class="section-heading">${title}</h2></div>
      <div class="cf-panel">
        <div class="cf-section">
          ${helperHTML}
          ${cfTableHTML(headerCellsHTML, rowsHTML)}
          ${addRowBtn(kind, addLabel)}
        </div>
      </div>
    </div>
  `;
}

// Subsection inside the Investment cashflows / Super panels: single
// compact row when empty; title + table + Add otherwise.
function ffSubsectionHTML(title, kind, addLabel, headerCellsHTML, rowsHTML) {
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
      ${cfTableHTML(headerCellsHTML, rowsHTML)}
      ${addRowBtn(kind, addLabel)}
    </div>
  `;
}

function renderCashflows() {
  const cf = state.cashflows;

  els.incomeSection.innerHTML = ffSectionHTML(
    "Income", "income", "Add income",
    cfHeaders.income(),
    cf.income.map(incomeRowHTML).join(""),
    `<p class="helper-text">Enter income before tax.</p>`,
    "Add income to include salary, rental, or other regular receipts in the projection."
  );

  els.deductionsSection.innerHTML = ffSectionHTML(
    "Deductions", "deductions", "Add deduction",
    cfHeaders.deductions(),
    cf.deductions.map(deductionRowHTML).join(""),
    `<p class="helper-text">Deductions reduce assessable income only — they never themselves debit household cash. If the underlying spend also needs to leave cash, enter a matching Expense row too.</p>`,
    "Add deductions such as work-related expenses, vehicle deductions, or salary packaging to reduce assessable income."
  );

  els.expensesSection.innerHTML = ffSectionHTML(
    "Expenses", "expenses", "Add expense",
    cfHeaders.expenses(),
    cf.expenses.map(expenseRowHTML).join(""),
    "",
    "Add expenses to model the household's regular spending."
  );

  const allEmpty = cf.contributions.length === 0 && cf.withdrawals.length === 0 && cf.lumpSums.length === 0;
  els.investSection.innerHTML = allEmpty
    ? `
      <h2 class="section-heading">Investment cashflows</h2>
      ${pageEmptyHTML(
        "Add contributions, withdrawals, or one-off amounts to model cashflows into and out of your assets.",
        `${addRowBtn("contributions", "Add contribution")}${addRowBtn("withdrawals", "Add withdrawal")}${addRowBtn("lumpSums", "Add one-off amount")}`
      )}
    `
    : `
      <div class="ff-section">
        <div class="ff-head"><h2 class="section-heading">Investment cashflows</h2></div>
        <div class="cf-panel">
          ${ffSubsectionHTML("Contributions", "contributions", "Add contribution", cfHeaders.contributions(),
            cf.contributions.map((c) => contributionRowHTML("contributions", c)).join(""))}
          ${ffSubsectionHTML("Withdrawals", "withdrawals", "Add withdrawal", cfHeaders.withdrawals(),
            cf.withdrawals.map((w) => contributionRowHTML("withdrawals", w)).join(""))}
          ${ffSubsectionHTML("One-off amounts", "lumpSums", "Add one-off amount", cfHeaders.lumpSums(),
            cf.lumpSums.map(lumpSumRowHTML).join(""))}
        </div>
      </div>
    `;
}

// --- settings section ------------------------------------------------------

function renderSettings() {
  const s = state.settings;
  const includedAssets = state.assets.filter((a) => a.include && a.class !== "lifestyle");
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

  const wca = state.plan.workingCash;
  const SURPLUS_HELP = {
    accumulate: "left in the Working Cash Account, building a cash balance",
    invest: "invested into the selected asset",
    spend: "treated as additional spending and disappears from the projection",
  };
  els.settingsPanel.innerHTML = `
    <div class="cf-panel">
      <div class="cf-section">
        <div class="cf-section-title">Working Cash Account</div>
        <p class="helper-text">All household cashflow passes through this account before anything else happens — it exists to absorb timing mismatches (e.g. annual income vs. monthly expenses) so a lump of income doesn't get "spent" the month it lands while the rest of the year runs a spurious deficit.</p>
        <div class="person-grid">
          <div class="cf-cell">
            <label>Opening balance ($)</label>
            <input type="number" min="0" step="1000" value="${wca.balance}" data-settings-field="wcaBalance" />
          </div>
          <div class="cf-cell">
            <label>Minimum balance ($)</label>
            <input type="number" min="0" step="1000" value="${wca.minimumBalance}" data-settings-field="wcaMinimum" />
          </div>
          <div class="cf-cell">
            <label>Interest rate (% p.a. nominal)</label>
            <input type="number" step="0.05" placeholder="Cash profile" value="${wca.ratePct ?? ""}" data-settings-field="wcaRate" />
          </div>
        </div>
        <p class="helper-text">If the account would fall below its minimum, the shortfall is drawn from the deficit funding order below. Leave the rate blank to use the firm's Cash profile return.</p>
      </div>
      <div class="cf-section">
        <div class="cf-section-title">Surplus treatment</div>
        <div class="settings-row">
          <select data-settings-field="surplusMode">
            <option value="accumulate"${s.surplus.mode === "accumulate" ? " selected" : ""}>Accumulate in the Working Cash Account</option>
            <option value="invest"${s.surplus.mode === "invest" ? " selected" : ""}>Invest to…</option>
            <option value="spend"${s.surplus.mode === "spend" ? " selected" : ""}>Spend (additional expenses)</option>
          </select>
          ${s.surplus.mode === "invest" ? `
            <select data-settings-field="surplusAsset">
              ${includedAssets.map((a) =>
                `<option value="${a.id}"${a.id === s.surplus.assetId ? " selected" : ""}>${escapeHTML(a.name)}</option>`
              ).join("")}
            </select>
          ` : ""}
        </div>
        <p class="helper-text">Once a year, at the end of each financial year, whatever is sitting in the Working Cash Account above its minimum is ${SURPLUS_HELP[s.surplus.mode]}.</p>
      </div>
      <div class="cf-section">
        <div class="cf-section-title">Deficit funding order</div>
        <div class="order-list">${orderItems}</div>
        <p class="helper-text">When the Working Cash Account needs topping up, money is drawn from these assets in this order.</p>
      </div>
    </div>
  `;
}

els.settingsPanel.addEventListener("change", (e) => {
  const field = e.target.dataset.settingsField;
  if (!field) return;
  if (field === "surplusMode") {
    if (e.target.value === "invest") {
      const first = state.assets.find((a) => a.include && a.class !== "lifestyle");
      state.settings.surplus = { mode: "invest", assetId: first ? first.id : null };
      state.settings = normaliseSettings(state.settings, state.assets);
    } else {
      state.settings.surplus = { mode: e.target.value === "spend" ? "spend" : "accumulate", assetId: null };
    }
  } else if (field === "surplusAsset") {
    state.settings.surplus = { mode: "invest", assetId: e.target.value };
    state.settings = normaliseSettings(state.settings, state.assets);
  } else if (field === "wcaBalance") {
    state.plan.workingCash = clampWorkingCash({ ...state.plan.workingCash, balance: clampNumber(e.target.value, 0) });
  } else if (field === "wcaMinimum") {
    state.plan.workingCash = clampWorkingCash({ ...state.plan.workingCash, minimumBalance: clampNumber(e.target.value, 0) });
  } else if (field === "wcaRate") {
    const v = e.target.value;
    state.plan.workingCash = clampWorkingCash({ ...state.plan.workingCash, ratePct: v === "" ? null : clampNumber(v, -10, 30) });
  } else {
    return;
  }
  saveState();
  refreshOutputs();
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

const CF_MOUNTS = [els.incomeSection, els.deductionsSection, els.expensesSection, els.investSection, els.superSection];
for (const container of [els.assets, els.lifestyleSection, ...CF_MOUNTS]) {
  container.addEventListener("input", (e) => applyFieldEdit(e.target, false));
  container.addEventListener("change", (e) => applyFieldEdit(e.target, true));
  // Amount cells (Cashflow sections: table layout) show a thousands-
  // separated value at rest; focusing one strips the separators back
  // to a plain editable number, restored on blur/change above.
  container.addEventListener("focusin", (e) => {
    if (e.target.matches(".cf-amount-input")) {
      e.target.value = e.target.value.replaceAll(",", "");
      e.target.select();
    }
  });
}

function applyFieldEdit(el, commit) {
  const field = el.dataset.field;
  if (!field) return;

  if (el.dataset.kind) {
    const row = findRow(el.dataset.kind, el.dataset.cfid);
    if (!row) return;
    applyRowEdit(el.dataset.kind, row, field, el, commit);
    saveState();
    refreshOutputs();
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
  refreshOutputs();
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
    case "growthPct": // lifestyle assets (D2)
      a.growthPct = clampNumber(el.value, -10, 30);
      if (commit) el.value = a.growthPct;
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
  const owner = (kind === "income" || kind === "deductions") ? row.owner : "client";
  const win = ownerWindow(plan, owner);

  switch (field) {
    case "label":
      row.label = commit ? (el.value.trim() || row.label) : el.value;
      if (commit) el.value = row.label;
      break;
    case "owner": {
      if (el.value !== "client" && el.value !== "partner") break;
      row.owner = el.value;
      if (kind === "superContributions" || kind === "superWithdrawals") {
        // Super rows are always client-anchored (Tier 1.2 convention —
        // see planState.js), so no date reclamping is needed here,
        // unlike income. The account may not belong to the new owner —
        // drop it if so, same "unknown reference dropped, row
        // survives" convention as clampSuperContribution.
        const acct = (state.plan.superAccounts ?? []).find((s) => s.id === row.accountId);
        if (acct && acct.owner !== el.value) row.accountId = null;
        const rowEl = el.closest(".cf-tr");
        if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row);
        break;
      }
      // income/deduction rows only, from here.
      // Anchors resolve dynamically against whichever owner window
      // applies — only explicit ages need re-clamping into the new
      // owner's window (clampIncomeRow/clampDeductionRow do both via
      // clampDateRef).
      const clamped = kind === "deductions" ? clampDeductionRow(row, plan) : clampIncomeRow(row, plan);
      row.from = clamped.from;
      row.to = clamped.to;
      // The owner change can also change which anchor a "Retirement —
      // <name>" option resolves to, so the whole row (selects,
      // resolved readouts) needs a full refresh, not just two labels.
      const rowEl = el.closest(".cf-tr");
      if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row);
      break;
    }
    case "assetId":
      if (findAsset(el.value)) row.assetId = el.value;
      break;
    case "accountId":
      if ((state.plan.superAccounts ?? []).some((s) => s.id === el.value)) row.accountId = el.value;
      break;
    case "type": {
      if (SUPER_CONTRIBUTION_TYPES.includes(el.value)) row.type = el.value;
      const rowEl = el.closest(".cf-tr");
      if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); // cap-headroom note depends on type
      break;
    }
    case "basis": {
      if (SUPER_CONTRIBUTION_BASES.includes(el.value)) row.basis = el.value;
      const rowEl = el.closest(".cf-tr");
      if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); // amount vs percent vs fill-note fields differ
      break;
    }
    case "percent":
      row.percent = clampNumber(el.value, 0, 100);
      if (commit) el.value = row.percent;
      break;
    case "incomeRowId":
      if (state.cashflows.income.some((r) => r.id === el.value)) row.incomeRowId = el.value;
      break;
    case "amount":
      // Thousands-separated on blur (Cashflow sections: table layout)
      // — strip separators before parsing; the delegated focusin
      // handler strips them back out for editing, so el.value is only
      // ever comma-formatted while NOT focused.
      row.amount = clampNumber(String(el.value).replaceAll(",", ""), 0);
      if (commit) el.value = fmtAmountValue(row.amount);
      break;
    case "frequency":
      row.frequency = el.value === "annual" ? "annual" : "monthly";
      break;
    case "indexBasis": {
      row.indexBasis = ["none", "cpi", "awote"].includes(el.value) ? el.value : "cpi";
      delete row.indexed;
      // Super contributions dropped Indexation to its own detail row
      // (Cashflow sections: table layout, point 6) — that row has no
      // .cf-tr ancestor to refresh via outerHTML, so update its total
      // subtext directly instead of re-rendering.
      const detailRow = el.closest(".cf-tr-detail");
      if (detailRow) { updateIndexTotalText(detailRow, row); break; }
      const rowEl = el.closest(".cf-tr");
      if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); // refresh the computed total
      break;
    }
    case "indexExtraPct": {
      row.indexExtraPct = clampNumber(el.value, -10, 10);
      if (commit) {
        el.value = row.indexExtraPct;
        const detailRow = el.closest(".cf-tr-detail");
        if (detailRow) { updateIndexTotalText(detailRow, row); break; }
        const rowEl = el.closest(".cf-tr");
        if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row);
      }
      break;
    }
    case "direction":
      row.direction = el.value === "out" ? "out" : "in";
      break;
    case "sgApplies":
      row.sgApplies = el.checked;
      break;
    case "category": {
      if (kind === "income") {
        row.category = INCOME_CATEGORIES.includes(el.value) ? el.value : "salary";
        row.incomeType = incomeCategoryTaxTreatment(row.category);
        // SG only ever applies to salary (planState's clampIncomeRow
        // convention) — force it off here too, and refresh the row so
        // the SG toggle appears/disappears.
        if (row.incomeType !== "employment") row.sgApplies = false;
        const rowEl = el.closest(".cf-tr");
        if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row);
      } else if (kind === "expenses") {
        row.category = EXPENSE_CATEGORIES.includes(el.value) ? el.value : "other";
      } else if (kind === "deductions") {
        row.category = DEDUCTION_CATEGORIES.includes(el.value) ? el.value : "other";
      }
      break;
    }
    case "from":
    case "to": {
      if (el.dataset.drRole === "anchor") {
        if (el.value === "__age__") {
          // Switch to an explicit age, seeded from the anchor's
          // current resolved value so the number doesn't jump.
          row[field] = { kind: "age", age: resolveRef(row[field], plan, projection.schedule, owner).age };
        } else {
          row[field] = { kind: "anchor", anchorId: el.value };
        }
        const rowEl = el.closest(".cf-tr");
        if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); // select/number visibility changes
        break;
      }
      // The paired number input, live only while "Specific age…" is chosen.
      if (!commit) return;
      const other = field === "from" ? "to" : "from";
      const otherResolved = resolveRef(row[other], plan, projection.schedule, owner).age;
      const lo = field === "to" ? Math.max(win.from, otherResolved) : win.from;
      const v = clampInt(el.value, lo, win.to);
      row[field] = { kind: "age", age: v };
      // Mirror the old "lift the other bound" nicety, but only when
      // it's ALSO an explicit age — never silently rewrite a
      // reference the user chose deliberately.
      if (field === "from" && row.to.kind === "age" && row.to.age < v) row.to = { kind: "age", age: v };
      flagIfClamped(el, v);
      updateDateRefReadouts(el.closest(".cf-tr"), row, owner);
      break;
    }
    case "at": { // lump sum
      if (el.dataset.drRole === "anchor") {
        if (el.value === "__age__") {
          row.at = { kind: "age", age: resolveRef(row.at, plan, projection.schedule, "client").age };
        } else {
          row.at = { kind: "anchor", anchorId: el.value };
        }
        const rowEl = el.closest(".cf-tr");
        if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row);
        break;
      }
      if (!commit) return;
      const v = clampInt(el.value, plan.client.currentAge, plan.endAge);
      row.at = { kind: "age", age: v };
      flagIfClamped(el, v);
      updateDateRefReadouts(el.closest(".cf-tr"), row, "client");
      break;
    }
  }
}

function rowHTMLFor(kind, row) {
  if (kind === "income") return incomeRowHTML(row);
  if (kind === "expenses") return expenseRowHTML(row);
  if (kind === "deductions") return deductionRowHTML(row);
  if (kind === "lumpSums") return lumpSumRowHTML(row);
  if (kind === "superContributions") return superContributionRowHTML(row);
  if (kind === "superWithdrawals") return superWithdrawalRowHTML(row);
  return contributionRowHTML(kind, row);
}

// Refresh every date-ref "age N (FYxxxx–yy)" / out-of-range readout in
// a row in place, without a full re-render — used for the live
// (per-keystroke) number-input path so the field never loses focus.
function updateDateRefReadouts(rowEl, row, ownerForAges) {
  if (!rowEl) return;
  for (const wrap of rowEl.querySelectorAll(".date-ref")) {
    const select = wrap.querySelector('[data-dr-role="anchor"]');
    const field = select?.dataset.field;
    const span = wrap.querySelector(".date-ref-resolved");
    if (!field || !row[field] || !span) continue;
    const resolved = resolveRef(row[field], state.plan, projection.schedule, ownerForAges);
    span.classList.toggle("date-ref-outofrange", resolved.outOfRange);
    span.textContent = resolved.outOfRange
      ? `Falls outside the projection window — clamped to age ${resolved.age}`
      : `age ${resolved.age} (${resolved.fyLabel})`;
    // Live-typing an explicit age also keeps the closed-select overlay
    // (Cashflow sections: table layout) in sync without a full re-render.
    const shortSpan = wrap.querySelector(".date-ref-short");
    if (shortSpan && select?.value === "__age__") shortSpan.textContent = `Age ${resolved.age}`;
  }
}

// Recomputes an indexation total's subtext in place — used only for
// super contributions' detail-row Indexation control (see
// indexBasis/indexExtraPct above), which has no .cf-tr ancestor for
// the usual outerHTML-refresh approach to target.
function updateIndexTotalText(container, row) {
  const span = container.querySelector(".index-total");
  if (!span) return;
  const basis = row.indexBasis ?? (row.indexed === false ? "none" : "cpi");
  const extra = row.indexExtraPct ?? 0;
  const basisRate = basis === "awote"
    ? (state.assumptions.awote ?? 0.035)
    : basis === "cpi" ? state.assumptions.cpi : 0;
  const fixed1 = (v) => `${v.toFixed(1)}%`;
  span.textContent = basis === "none" && extra === 0
    ? "Fixed nominal"
    : `${fixed1(basisRate * 100)} + ${fixed1(extra)} = ${fixed1(basisRate * 100 + extra)}`;
}

function refreshAssetSelects() {
  for (const sel of els.investSection.querySelectorAll('[data-field="assetId"]')) {
    const current = sel.value;
    sel.innerHTML = assetOptions(current);
  }
}

function refreshSuperAccountSelects() {
  for (const sel of els.superSection.querySelectorAll('[data-field="accountId"]')) {
    const row = findRow(sel.dataset.kind, sel.dataset.cfid);
    sel.innerHTML = superAccountOptions(sel.value, row?.owner);
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

// Numeric inputs: validate on commit, not on keystroke. Every plain
// number input in this app already gets this for free — the browser
// only fires "change" once, on blur or Enter, never mid-keystroke
// ("input" fires every keystroke, but nothing here listens for it on
// these fields). <input type="date"> does NOT behave the same way:
// Chromium (and other browsers) fire "change" repeatedly WHILE a
// later date segment is still being edited, not only once the whole
// date is complete and the user has moved on — so a date field wired
// straight to "change" re-clamps and re-renders mid-edit, visibly
// scrambling what's being typed (e.g. a DOB year). Route every date
// input's commit through blur (the bubbling "focusout") or Enter
// instead, so it gets the same "accept free text while focused,
// validate on commit" treatment every other year/age field already
// has structurally.
function wireDeferredDateCommit(container, handler) {
  container.addEventListener("change", (e) => {
    if (e.target.type === "date") return; // deferred to focusout below
    handler(e);
  });
  container.addEventListener("focusout", (e) => {
    if (e.target.type !== "date") return;
    handler(e);
  });
  container.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.type === "date") e.target.blur(); // blur triggers focusout above
  });
}

// --- structural actions ------------------------------------------------------

function onAssetSectionClick(e) {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "add-lifestyle-asset") {
    const a = createLifestyleAsset(state.plan, state.assets);
    state.assets.push(a);
    collapsed.set(a.id, false);
    saveState();
    renderAll();
    return;
  }
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
      assetCardEl(aid)?.classList.toggle("excluded", !a.include);
      renderSettings();
      renderCashflows(); // B2: excluded-asset flag on any row targeting it
      refreshOutputs();
      break;
    }
    case "remove-asset": {
      const financialCount = state.assets.filter((x) => x.class !== "lifestyle").length;
      if (a.class !== "lifestyle" && financialCount <= 1) return; // keep the last financial asset
      const isSurplusTarget = state.settings.surplus.assetId === aid;
      const affectedRows = cashflowRowsForAsset(state, aid);
      // No attached cashflow rows (the common case — lifestyle assets
      // never have any, per D2) — a plain confirm is enough; nothing
      // to reassign or delete. Otherwise never orphan those rows
      // silently: require an explicit reassign-or-delete choice (audit
      // follow-up B1 — this used to cascade-delete unconditionally).
      if (affectedRows.length === 0) {
        const msg = isSurplusTarget
          ? `Remove "${a.name}"? It is the surplus investment target — surplus treatment will revert to Spend.`
          : `Remove "${a.name}"?`;
        if (!window.confirm(msg)) return;
        state = removeAsset(state, aid);
        collapsed.delete(aid);
        allocMemory.delete(aid);
        volBasisTouched.delete(aid);
        saveState();
        renderAll();
        break;
      }
      openAssetRemoveDialog(a, affectedRows, isSurplusTarget);
      break;
    }
    case "alloc-mode": {
      switchAllocMode(a, target.dataset.mode === "custom" ? "custom" : "profile");
      saveState();
      renderAssets();
      refreshOutputs();
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
}

els.assets.addEventListener("click", onAssetSectionClick);
els.lifestyleSection.addEventListener("click", onAssetSectionClick);

// Asset removal with attached cashflow rows (audit follow-up B1): list
// the rows and require an explicit reassign-or-delete choice —
// removeAsset(state, aid) still cascade-deletes when called with no
// third argument, so every other call site (there are none besides
// this one) is unaffected.
function openAssetRemoveDialog(asset, rows, isSurplusTarget) {
  const otherFinancial = state.assets.filter((x) => x.id !== asset.id && x.class !== "lifestyle");
  const rowList = rows.map((r) => `<li>${escapeHTML(r.summary)}</li>`).join("");
  const surplusNote = isSurplusTarget
    ? `<p>It is also the surplus investment target — surplus treatment will revert to Spend.</p>` : "";
  els.assetRemoveModalBody.innerHTML = `
    <p>"${escapeHTML(asset.name)}" has ${rows.length} cashflow row(s) attached:</p>
    <ul>${rowList}</ul>
    <p>Removing the asset must not silently delete these — choose one:</p>
    ${surplusNote}
    <div class="cf-cell">
      <label>Reassign rows to</label>
      <select id="assetRemoveReassignSelect">${otherFinancial.map((x) => `<option value="${x.id}">${escapeHTML(x.name)}</option>`).join("")}</select>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn-text" id="assetRemoveReassignBtn"${otherFinancial.length === 0 ? " disabled" : ""}>Reassign and remove</button>
      <button type="button" class="btn-text list-danger" id="assetRemoveDeleteBtn">Delete these rows and remove</button>
      <button type="button" class="btn-text" id="assetRemoveCancelBtn">Cancel</button>
    </div>
  `;
  els.assetRemoveModal.showModal();

  const close = () => els.assetRemoveModal.close();
  const finish = (reassignToId) => {
    state = removeAsset(state, asset.id, reassignToId);
    collapsed.delete(asset.id);
    allocMemory.delete(asset.id);
    volBasisTouched.delete(asset.id);
    saveState();
    close();
    renderAll();
  };
  $("assetRemoveReassignBtn").addEventListener("click", () => {
    finish($("assetRemoveReassignSelect").value);
  }, { once: true });
  $("assetRemoveDeleteBtn").addEventListener("click", () => finish(null), { once: true });
  $("assetRemoveCancelBtn").addEventListener("click", close, { once: true });
}
els.assetRemoveModal.querySelector(".modal-close").addEventListener("click", () => els.assetRemoveModal.close());
els.assetRemoveModal.addEventListener("click", (e) => {
  if (e.target === els.assetRemoveModal) els.assetRemoveModal.close();
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
        // Franking is derived, not stored (Derive franking from class
        // weights commit) — seed the custom field with the profile's
        // derived figure at the point of switching, same starting
        // point as before; the user can then edit it freely.
        frankingPct: p.classWeights ? Math.round(impliedFrankingPct(p.classWeights, p.incomeReturn ?? 0)) : 0,
        volBasis: a.allocation.profile,
      }, PROFILES);
    }
  } else {
    a.allocation = mem.profile || clampAllocation({ mode: "profile", profile: null }, PROFILES);
  }
  allocMemory.set(a.id, mem);
}

const SUPER_ROW_KINDS = ["superContributions", "superWithdrawals"];

function onCashflowSectionClick(e) {
  const target = e.target.closest("[data-action]");
  if (!target) return;
  const { action, kind, cfid } = target.dataset;
  const cf = state.cashflows;
  const isSuperKind = SUPER_ROW_KINDS.includes(kind);

  if (action === "add-row") {
    const firstAsset = state.assets.find((a) => a.class !== "lifestyle")?.id ?? null;
    if (kind === "income") cf.income.push(createIncomeRow(state.plan, cf.income));
    else if (kind === "deductions") cf.deductions.push(createDeductionRow(state.plan, cf.deductions));
    else if (kind === "expenses") cf.expenses.push(createExpenseRow(state.plan, cf.expenses));
    else if (kind === "contributions") cf.contributions.push(createCashflow("contribution", state.plan, firstAsset));
    else if (kind === "withdrawals") cf.withdrawals.push(createCashflow("withdrawal", state.plan, firstAsset));
    else if (kind === "lumpSums") cf.lumpSums.push(createLumpSum(state.plan, firstAsset));
    else if (kind === "superContributions") {
      cf.superContributions.push(createSuperContribution(state.plan, state.plan.superAccounts ?? []));
    } else if (kind === "superWithdrawals") {
      cf.superWithdrawals.push(createSuperWithdrawal(state.plan, state.plan.superAccounts ?? []));
    }
    saveState();
    if (isSuperKind) { refreshOutputs(); renderSuper(); } else { renderCashflows(); refreshOutputs(); }
  } else if (action === "remove-row") {
    if (cf[kind]) cf[kind] = cf[kind].filter((r) => r.id !== cfid);
    saveState();
    if (isSuperKind) { refreshOutputs(); renderSuper(); } else { renderCashflows(); refreshOutputs(); }
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

// --- property section (D4) -------------------------------------------------------

// "Projected price at purchase (age 34, FY2032–33): $978,000 · duty ≈
// $36,000 · cash required ≈ $141,000"
// Returns { text, warn } — warn:true renders in the amber warning
// style instead of the plain italic helper style.
//
// The "owned + future acquisition date" branch below is a reported-bug
// fix (rent appearing from the projection's start for a property
// meant to be a future purchase): acquisitionDate on an OWNED property
// is cosmetic/CGT-only (deterministic.js's grandfathering check is its
// only consumer) — it does NOT gate when the property, or its rent,
// becomes active. An owned property is live from month one regardless
// of acquisition date; only "Planned purchase" + "Purchase at" defers
// anything. Setting a future acquisition date while leaving status on
// the default "Owned" is an easy, silent way to end up with rent (and
// the property's value) counted from day one when a future purchase
// was intended — verified live: this reproduces the reported symptom
// exactly, while the engine's own purchase-gating (propVal stays 0
// until settlement for a genuinely "planned" property) is correct.
// This is a validation warning, not an engine change — the engine is
// doing exactly what "Owned" means.
function propertyHelperText(p) {
  if (p.status === "owned") {
    if (p.acquisitionDate) {
      const planStart = new Date(state.plan.start.year, state.plan.start.month - 1, 1);
      const acq = new Date(p.acquisitionDate);
      if (!Number.isNaN(acq.getTime()) && acq > planStart) {
        return {
          warn: true,
          action: "convertToPlanned",
          text: `Acquisition date is in the future, but status is "Owned" — an owned property (and its rent, if any) is included in the projection from the very first month regardless of acquisition date; the date only affects CGT grandfathering. To model a future purchase, switch status to "Planned purchase" and set "Purchase at" instead.`,
        };
      }
    }
    return { warn: false, text: "" };
  }
  if (!(p.priceToday > 0)) return { warn: false, text: "" };
  const resolved = resolveRef(p.purchaseAt, state.plan, projection.schedule, "client");
  const y = resolved.planYear;
  if (resolved.outOfRange) {
    return { warn: false, text: `Falls outside the projection window — clamped to age ${resolved.age}.` };
  }
  if (y === 0 && state.plan.start.month !== 7) {
    return { warn: false, text: "A purchase in the partial first year (which has no firing July) is skipped — pick a later date." };
  }
  const first = 12 - ((state.plan.start.month - 7 + 12) % 12);
  const m = y === 0 ? 0 : first + 12 * (y - 1);
  const nominalPrice = p.priceToday * Math.pow(1 + p.growthPct / 100, m / 12);
  const duty = p.dutyOverride != null
    ? p.dutyOverride
    : dutyWithConcessions(p.state, nominalPrice, { firstHomeBuyer: p.firstHomeBuyer, newBuild: p.newBuild });
  const fhog = fhogAmount(p.state, nominalPrice, { firstHomeBuyer: p.firstHomeBuyer, newBuild: p.newBuild });
  const cash = nominalPrice * (1 - p.lvrPct / 100) + duty + (p.purchaseCostsPct / 100) * nominalPrice - fhog;
  return {
    warn: false,
    text: `Projected price at purchase (age ${resolved.age}, ${resolved.fyLabel}): ` +
      `${fmtMoney(nominalPrice)} · duty ≈ ${fmtMoney(duty)}${fhog ? ` · FHOG ${fmtMoney(fhog)}` : ""} · cash required ≈ ${fmtMoney(cash)}`,
  };
}

function propertyCardHTML(p) {
  const owned = p.status === "owned";
  const invest = p.propertyType === "investment";
  const cell = (label, inner) => `<div class="cf-cell"><label>${label}</label>${inner}</div>`;
  const num = (label, field, value, attrs = 'min="0" step="1000"') =>
    cell(label, `<input type="number" ${attrs} value="${value}" data-pid="${p.id}" data-pfield="${field}" />`);
  const flowCells = (label, field, flow) => `
    ${num(`${label} ($/yr, today's)`, `${field}.amount`, flow.amount)}
    ${cell(`${label} index basis`, `
      <select data-pid="${p.id}" data-pfield="${field}.indexBasis">
        <option value="none"${flow.indexBasis === "none" ? " selected" : ""}>None</option>
        <option value="cpi"${flow.indexBasis === "cpi" ? " selected" : ""}>CPI</option>
        <option value="awote"${flow.indexBasis === "awote" ? " selected" : ""}>Wage index (AWOTE)</option>
      </select>`)}
    ${num(`${label} additional %`, `${field}.indexExtraPct`, flow.indexExtraPct, 'min="-10" max="10" step="0.1"')}
  `;
  const helper = propertyHelperText(p);
  return `
    <div class="pcard" data-pid="${p.id}">
      <div class="pcard-head">
        <span class="pcard-name">${escapeHTML(p.name)}</span>
        <span class="pcard-meta">${p.propertyType.toUpperCase()} · ${p.state} · ${owned ? fmtMoney(p.currentValue) : `planned @ age ${resolveRef(p.purchaseAt, state.plan, projection.schedule, "client").age}`}</span>
        <button class="pcard-remove" type="button" data-prop-action="remove" data-pid="${p.id}">Remove</button>
      </div>
      <div class="pcard-body">
        <div class="person-grid">
          ${cell("Name", `<input type="text" maxlength="60" value="${escapeHTML(p.name)}" data-pid="${p.id}" data-pfield="name" />`)}
          ${isCouple() ? cell("Owner", `<select data-pid="${p.id}" data-pfield="owner">${ownerOptions(p.owner)}</select>`) : ""}
          ${cell("State", `<select data-pid="${p.id}" data-pfield="state">${PROPERTY_STATES.map((st) => `<option value="${st}"${p.state === st ? " selected" : ""}>${st}</option>`).join("")}</select>`)}
          ${cell("Type", `<select data-pid="${p.id}" data-pfield="propertyType">
            <option value="ppr"${p.propertyType === "ppr" ? " selected" : ""}>Main residence (PPR)</option>
            <option value="holiday"${p.propertyType === "holiday" ? " selected" : ""}>Holiday home</option>
            <option value="investment"${invest ? " selected" : ""}>Investment</option>
          </select>`)}
          ${cell("Status", `
            <div class="seg-toggle">
              <button class="seg-option${owned ? " active" : ""}" type="button" data-prop-action="status" data-pid="${p.id}" data-value="owned">Owned</button>
              <button class="seg-option${!owned ? " active" : ""}" type="button" data-prop-action="status" data-pid="${p.id}" data-value="planned">Planned purchase</button>
            </div>`)}
          ${num("Growth (% p.a. nominal)", "growthPct", p.growthPct, 'min="-10" max="30" step="0.1"')}
          ${owned ? `
            ${num("Current value ($)", "currentValue", p.currentValue)}
            ${cell("Acquisition date", `<input type="date" max="${todayISO()}" value="${p.acquisitionDate ?? ""}" data-pid="${p.id}" data-pfield="acquisitionDate" />`)}
            ${p.propertyType !== "ppr" ? num("Cost base ($)", "costBase", p.costBase) : ""}
          ` : `
            ${num("Price today ($)", "priceToday", p.priceToday)}
            ${cell("Purchase at", dateRefControlHTML(p.purchaseAt, "client", `data-pid="${p.id}" data-pfield="purchaseAt"`, state.plan.client.currentAge, state.plan.endAge))}
            ${num("LVR (%)", "lvrPct", p.lvrPct, 'min="0" max="100" step="1"')}
            ${num("Purchase costs (%)", "purchaseCostsPct", p.purchaseCostsPct, 'min="0" max="10" step="0.1"')}
            ${num("Duty override ($, blank = schedule)", "dutyOverride", p.dutyOverride ?? "", 'min="0" step="100"')}
            ${cell("First home buyer", `<label class="ptg-check"><input type="checkbox"${p.firstHomeBuyer ? " checked" : ""} data-pid="${p.id}" data-pfield="firstHomeBuyer" /><span>Yes</span></label>`)}
            ${cell("New build", `<label class="ptg-check"><input type="checkbox"${p.newBuild ? " checked" : ""} data-pid="${p.id}" data-pfield="newBuild" /><span>Yes</span></label>`)}
          `}
          ${invest ? `
            ${flowCells("Rent", "rent", p.rent)}
            ${flowCells("Expenses", "expenses", p.expenses)}
            ${cell("Expenses deductible", `<label class="ptg-check"><input type="checkbox"${p.expensesDeductible ? " checked" : ""} data-pid="${p.id}" data-pfield="expensesDeductible" /><span>Yes</span></label>`)}
            ${num("Depreciation ($ p.a., deductible)", "depreciation", p.depreciation ?? 0)}
          ` : ""}
        </div>
        ${helper.text ? `<p class="${helper.warn ? "helper-warning" : "helper-text"}">${escapeHTML(helper.text)}${
          helper.action === "convertToPlanned"
            ? ` <button class="btn-text" type="button" data-prop-action="convertToPlanned" data-pid="${p.id}">Switch to planned purchase</button>`
            : ""
        }</p>` : ""}
      </div>
    </div>
  `;
}

function renderProperties() {
  const cards = (state.properties ?? []).map(propertyCardHTML).join("");
  els.propertySection.innerHTML = cards === ""
    ? `
      <h2 class="section-heading">Property</h2>
      ${pageEmptyHTML(
        "Add property to project value growth, purchases, rent, and gearing.",
        `<button class="add-row-btn" type="button" data-prop-action="add">+ Add property</button>`
      )}
    `
    : `
      <h2 class="section-heading">Property</h2>
      <div id="properties" class="portfolio-stack">${cards}</div>
      <div class="portfolio-actions">
        <button class="btn-text" type="button" data-prop-action="add">+ Add property</button>
      </div>
    `;
}

function findProperty(pid) {
  return (state.properties ?? []).find((p) => p.id === pid) || null;
}

// Owned → planned purchase (shared by the warning's button and the
// acquisition-date input-integrity gate below). `p.acquisitionDate`
// must already hold the date to convert from; caller re-normalises
// and saves/renders afterward.
function convertPropertyToPlanned(p) {
  const acq = new Date(p.acquisitionDate);
  const age = ageAtDate(state.plan.client.dob, acq.getFullYear(), acq.getMonth() + 1);
  p.status = "planned";
  p.priceToday = p.currentValue;
  p.purchaseAt = {
    kind: "age",
    age: clampInt(age ?? state.plan.client.currentAge, state.plan.client.currentAge, state.plan.endAge),
  };
}

wireDeferredDateCommit(els.propertySection, (e) => {
  const field = e.target.dataset.pfield;
  const p = findProperty(e.target.dataset.pid);
  if (!field || !p) return;
  const v = e.target.value;
  if (field === "name") p.name = v.trim() || p.name;
  else if (field === "owner") p.owner = v;
  else if (field === "state") p.state = v;
  else if (field === "propertyType") p.propertyType = v;
  else if (field === "growthPct") p.growthPct = clampNumber(v, -10, 30);
  else if (field === "currentValue") p.currentValue = clampNumber(v, 0);
  else if (field === "acquisitionDate") {
    // Input integrity (C1): a future acquisition date on an "Owned"
    // property is impossible, not just unusual — you can't already
    // own something you haven't bought yet. Reject the commit outright
    // rather than accepting it and relying on the warning below to
    // catch it after the fact; offer the same planned-purchase
    // conversion inline instead. The warning + button stay in place
    // for state already saved before this gate existed (or imported
    // from elsewhere) — this only stops NEW future dates from being
    // entered going forward.
    if (p.status === "owned" && v && v > todayISO()) {
      const convert = window.confirm(
        `A future acquisition date isn't valid for an "Owned" property — you can't already own ` +
        `something you haven't bought yet.\n\nSwitch "${p.name}" to a planned purchase instead? ` +
        `Its acquisition date becomes the purchase date, and its current value becomes today's price ` +
        `to grow from until then.\n\nCancel leaves the acquisition date unchanged.`
      );
      if (convert) {
        p.acquisitionDate = v;
        convertPropertyToPlanned(p);
      }
      // Declined: acquisitionDate is left untouched — the future date
      // is never stored, and renderProperties() below reverts the
      // input's displayed value to it.
    } else {
      p.acquisitionDate = v || null;
    }
  }
  else if (field === "costBase") p.costBase = clampNumber(v, 0);
  else if (field === "priceToday") p.priceToday = clampNumber(v, 0);
  else if (field === "purchaseAt") {
    if (e.target.dataset.drRole === "anchor") {
      p.purchaseAt = v === "__age__"
        ? { kind: "age", age: resolveRef(p.purchaseAt, state.plan, projection.schedule, "client").age }
        : { kind: "anchor", anchorId: v };
    } else {
      const age = clampInt(v, state.plan.client.currentAge, state.plan.endAge);
      p.purchaseAt = { kind: "age", age };
      flagIfClamped(e.target, age); // same visible cue every other date-ref "Specific age" field uses
    }
  }
  else if (field === "lvrPct") p.lvrPct = clampNumber(v, 0, 100);
  else if (field === "purchaseCostsPct") p.purchaseCostsPct = clampNumber(v, 0, 10);
  else if (field === "dutyOverride") p.dutyOverride = v === "" ? null : clampNumber(v, 0);
  else if (field === "firstHomeBuyer") p.firstHomeBuyer = e.target.checked;
  else if (field === "newBuild") p.newBuild = e.target.checked;
  else if (field === "expensesDeductible") p.expensesDeductible = e.target.checked;
  else if (field === "depreciation") p.depreciation = clampNumber(v, 0);
  else if (field.includes(".")) {
    const [group, sub] = field.split(".");
    if ((group === "rent" || group === "expenses") && p[group]) {
      if (sub === "amount") p[group].amount = clampNumber(v, 0);
      else if (sub === "indexBasis") p[group].indexBasis = v;
      else if (sub === "indexExtraPct") p[group].indexExtraPct = clampNumber(v, -10, 10);
    }
  }
  state.properties = normaliseProperties(state.properties, state.plan);
  state.liabilities = normaliseLiabilities(state.liabilities, state.plan, state.assets, state.properties);
  saveState();
  refreshOutputs();
  renderProperties();
  renderLiabilities(); // linked-asset labels may change
});

els.propertySection.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-prop-action]");
  if (!btn) return;
  if (btn.dataset.propAction === "add") {
    const growthDefault = (PROFILES["Residential Property"]?.growthReturn ?? 0.05) * 100;
    state.properties = [...(state.properties ?? []), createProperty(state.plan, state.properties ?? [], growthDefault)];
    saveState();
    refreshOutputs();
    renderProperties();
    return;
  }
  const p = findProperty(btn.dataset.pid);
  if (!p) return;
  if (btn.dataset.propAction === "remove") {
    if (!window.confirm(`Remove "${p.name}"?`)) return;
    state.properties = state.properties.filter((x) => x.id !== p.id);
    state.liabilities = normaliseLiabilities(state.liabilities, state.plan, state.assets, state.properties);
  } else if (btn.dataset.propAction === "status") {
    p.status = btn.dataset.value === "planned" ? "planned" : "owned";
  } else if (btn.dataset.propAction === "convertToPlanned") {
    if (!window.confirm(
      `Switch "${p.name}" to a planned purchase? This changes how the property is modelled: ` +
      `its acquisition date becomes the purchase date, and its current value becomes today's price ` +
      `to grow from until then.`
    )) return;
    convertPropertyToPlanned(p);
    state.properties = normaliseProperties(state.properties, state.plan);
    state.liabilities = normaliseLiabilities(state.liabilities, state.plan, state.assets, state.properties);
  }
  saveState();
  refreshOutputs();
  renderProperties();
  renderLiabilities();
});

// --- super section (Tier 1.2, Commit 4) -------------------------------------
//
// Super accounts live on plan.superAccounts (person-owned, never
// joint — see planState.js), so account cards are entirely
// self-contained (their own data-said/data-sfield attributes and
// listeners) rather than routed through the financial-asset pipeline.
// Contribution/withdrawal rows DO reuse the shared cashflow-row
// plumbing (findRow/applyRowEdit/rowHTMLFor, add-row/remove-row) —
// they're shaped like every other cashflow row plus a type/basis pair.

const ENTERABLE_SUPER_TYPES = SUPER_CONTRIBUTION_TYPES.filter((t) => t !== "sg"); // SG is derived, never entered
const SUPER_TYPE_LABELS = {
  sg: "Superannuation Guarantee",
  salarySacrifice: "Salary sacrifice",
  personalDeductible: "Personal (deductible)",
  personalNonDeductible: "Personal (non-deductible)",
  spouse: "Spouse contribution",
};
const CONCESSIONAL_SUPER_TYPES = ["salarySacrifice", "personalDeductible"];

function findSuperAccount(said) {
  return (state.plan.superAccounts ?? []).find((s) => s.id === said) || null;
}

// Super accounts are always person-owned — never "joint" (Tier 1.2).
function superOwnerOptions(selected) {
  const labels = { client: clientName(), partner: partnerName() };
  const owners = isCouple() ? ["client", "partner"] : ["client"];
  return owners.map((o) =>
    `<option value="${o}"${o === selected ? " selected" : ""}>${escapeHTML(labels[o])}</option>`
  ).join("");
}

function superAccountOptions(selected, owner) {
  const accounts = (state.plan.superAccounts ?? []).filter((s) => !owner || s.owner === owner);
  if (accounts.length === 0) return `<option value="">No super account for this owner</option>`;
  return accounts.map((s) =>
    `<option value="${s.id}"${s.id === selected ? " selected" : ""}>${escapeHTML(s.name)}</option>`
  ).join("");
}

function incomeRowOptions(selected) {
  const rows = state.cashflows.income;
  if (rows.length === 0) return `<option value="">No income rows</option>`;
  return rows.map((r) =>
    `<option value="${r.id}"${r.id === selected ? " selected" : ""}>${escapeHTML(r.label)}</option>`
  ).join("");
}

// Live cap-headroom "constraint row" (spec: "the single most useful
// thing on the screen") — reads the current FY's superCapUsage off the
// live projection rather than recomputing cap/carry-forward logic here
// a second time. Shown only beside concessional-type rows.
function superCapHeadroomHTML(sc) {
  if (!CONCESSIONAL_SUPER_TYPES.includes(sc.type)) return "";
  const usage = projection?.yearly?.[0]?.superCapUsage?.[sc.owner];
  if (!usage) return "";
  return `
    <div class="super-cap-headroom">
      ${fmtMoney(usage.cap)} cap · ${fmtMoney(usage.sg)} SG · ${fmtMoney(usage.salarySacrifice)} sacrifice ·
      ${fmtMoney(usage.personalDeductible)} personal ·
      <strong>${fmtMoney(usage.available)} available</strong>
      (incl. ${fmtMoney(usage.carryForwardAvailable)} carry-forward)
    </div>
  `;
}

function superAccountHeadMeta(sa) {
  const ownerLabel = sa.owner === "partner" ? partnerName() : clientName();
  return `${ownerLabel} · ${fmtMoney(sa.balance)}` +
    (sa.taxFreeComponent > 0 ? ` · tax-free ${fmtMoney(sa.taxFreeComponent)}` : "");
}

function superAllocationSectionHTML(sa) {
  const alloc = sa.allocation;
  const isCustom = alloc.mode === "custom";
  const seg = `
    <div class="seg-toggle" role="radiogroup" aria-label="Allocation mode">
      <button class="seg-option${!isCustom ? " active" : ""}" type="button"
              data-super-action="alloc-mode" data-said="${sa.id}" data-mode="profile"
              aria-pressed="${!isCustom}">Firm profile</button>
      <button class="seg-option${isCustom ? " active" : ""}" type="button"
              data-super-action="alloc-mode" data-said="${sa.id}" data-mode="custom"
              aria-pressed="${isCustom}">Custom</button>
    </div>
  `;
  if (!isCustom) {
    return `
      <div class="cf-section">
        <div class="cf-section-title">Allocation</div>
        ${seg}
        <div class="alloc-grid alloc-grid-profile">
          <div class="cf-cell">
            <label>Risk profile</label>
            <select data-said="${sa.id}" data-sfield="alloc.profile">${profileOptions(alloc.profile)}</select>
          </div>
        </div>
      </div>
    `;
  }
  const total = (alloc.incomePct + alloc.growthPct).toFixed(2);
  return `
    <div class="cf-section">
      <div class="cf-section-title">Allocation</div>
      ${seg}
      <div class="alloc-grid">
        <div class="cf-cell">
          <label>Income (% p.a.)</label>
          <input type="number" min="0" max="${ALLOC_PCT_MAX}" step="0.05" value="${alloc.incomePct}"
                 data-said="${sa.id}" data-sfield="alloc.incomePct" />
        </div>
        <div class="cf-cell">
          <label>Growth (% p.a.)</label>
          <input type="number" min="0" max="${ALLOC_PCT_MAX}" step="0.05" value="${alloc.growthPct}"
                 data-said="${sa.id}" data-sfield="alloc.growthPct" />
        </div>
        <div class="cf-cell">
          <label>Franking (%)</label>
          <input type="number" min="0" max="100" step="1" value="${alloc.frankingPct}"
                 data-said="${sa.id}" data-sfield="alloc.frankingPct" />
        </div>
        <div class="cf-cell alloc-total">
          <label>&nbsp;</label>
          <div class="alloc-total-value" data-role="superAllocTotal-${sa.id}">Total: ${total}% p.a. nominal</div>
        </div>
      </div>
      <div class="alloc-grid alloc-grid-vol">
        <div class="cf-cell">
          <label>Volatility basis</label>
          <select data-said="${sa.id}" data-sfield="alloc.volBasis">${profileOptions(alloc.volBasis)}</select>
        </div>
      </div>
    </div>
  `;
}

function superAccountCardHTML(sa) {
  const isCollapsed = collapsed.get(sa.id) === true;
  const excluded = !sa.include;
  const head = `
    <div class="pcard-head" data-super-action="toggle-collapse" data-said="${sa.id}">
      <button class="pcard-chevron${isCollapsed ? "" : " open"}" type="button"
              aria-label="${isCollapsed ? "Expand" : "Collapse"}"
              data-super-action="toggle-collapse" data-said="${sa.id}">▸</button>
      <span class="pcard-name" data-role="superHeadName">${escapeHTML(sa.name)}</span>
      <span class="pcard-meta" data-role="superHeadMeta">${superAccountHeadMeta(sa)}</span>
      <label class="pcard-include" title="Include in projection totals">
        <input type="checkbox"${sa.include ? " checked" : ""}
               data-super-action="toggle-include" data-said="${sa.id}" />
        <span>Include</span>
      </label>
      <button class="pcard-remove" type="button" data-super-action="remove-account" data-said="${sa.id}">Remove</button>
    </div>
  `;
  if (isCollapsed) {
    return `<div class="pcard${excluded ? " excluded" : ""}" data-said="${sa.id}">${head}</div>`;
  }
  return `<div class="pcard${excluded ? " excluded" : ""}" data-said="${sa.id}">${head}
    <div class="pcard-body">
      <div class="pcard-details${isCouple() ? " with-owner" : ""}">
        <div class="cf-cell pcard-name-cell">
          <label>Name</label>
          <input type="text" value="${escapeHTML(sa.name)}" maxlength="60"
                 data-said="${sa.id}" data-sfield="name" />
        </div>
        ${isCouple() ? `
          <div class="cf-cell">
            <label>Owner</label>
            <select data-said="${sa.id}" data-sfield="owner">${superOwnerOptions(sa.owner)}</select>
          </div>
        ` : ""}
        <div class="cf-cell">
          <label>Balance ($)</label>
          <input type="number" min="0" step="1000" value="${sa.balance}"
                 data-said="${sa.id}" data-sfield="balance" />
        </div>
        <div class="cf-cell">
          <label>Tax-free component ($)</label>
          <input type="number" min="0" step="1000" value="${sa.taxFreeComponent}"
                 data-said="${sa.id}" data-sfield="taxFreeComponent" />
        </div>
      </div>

      ${superAllocationSectionHTML(sa)}

      <div class="cf-section">
        <div class="cf-section-title">Costs</div>
        <div class="alloc-grid alloc-grid-profile">
          <div class="cf-cell">
            <label>ICR (% p.a.)</label>
            <input type="number" min="0" max="100" step="0.01" value="${sa.icrPct}"
                   data-said="${sa.id}" data-sfield="icrPct" />
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function superContributionRowHTML(sc) {
  const showAmount = sc.basis === "amount";
  const showPercent = sc.basis === "percentOfIncome";
  const showFillNote = sc.basis === "toConcessionalCap";
  // The Amount/detail column's content varies by basis (a fixed $,
  // a %-of-income-row pair, or a plain note) — one column, contents
  // vary, same discipline as super contribution rows have always
  // needed (Cashflow sections: table layout, one line per item).
  const detailHTML = showAmount
    ? `<input type="text" inputmode="decimal" class="cf-amount-input" value="${fmtAmountValue(sc.amount)}"
              data-kind="superContributions" data-cfid="${sc.id}" data-field="amount" />`
    : showPercent
    ? `<div class="cf-index-pair">
        <input type="number" min="0" max="100" step="1" value="${sc.percent}" aria-label="% of income"
               data-kind="superContributions" data-cfid="${sc.id}" data-field="percent" />
        <select data-kind="superContributions" data-cfid="${sc.id}" data-field="incomeRowId" aria-label="Income row">${incomeRowOptions(sc.incomeRowId)}</select>
       </div>`
    : showFillNote
    ? `<span class="cf-detail-note">Fills remaining concessional cap</span>`
    : "";
  const headroomRow = superCapHeadroomHTML(sc);
  return `
    <tr class="cf-tr" data-cfid="${sc.id}">
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(sc.label)}" maxlength="60"
               data-kind="superContributions" data-cfid="${sc.id}" data-field="label" />
      </td>
      <td class="cf-td-type">
        <select data-kind="superContributions" data-cfid="${sc.id}" data-field="type">
          ${ENTERABLE_SUPER_TYPES.map((t) =>
            `<option value="${t}"${sc.type === t ? " selected" : ""}>${SUPER_TYPE_LABELS[t]}</option>`
          ).join("")}
        </select>
      </td>
      ${isCouple() ? `
        <td class="cf-td-owner">
          <select data-kind="superContributions" data-cfid="${sc.id}" data-field="owner">${superOwnerOptions(sc.owner)}</select>
        </td>
      ` : ""}
      <td class="cf-td-account">
        <select data-kind="superContributions" data-cfid="${sc.id}" data-field="accountId">${superAccountOptions(sc.accountId, sc.owner)}</select>
      </td>
      <td class="cf-td-basis">
        <select data-kind="superContributions" data-cfid="${sc.id}" data-field="basis">
          <option value="amount"${sc.basis === "amount" ? " selected" : ""}>Fixed amount</option>
          <option value="percentOfIncome"${sc.basis === "percentOfIncome" ? " selected" : ""}>% of an income row</option>
          <option value="toConcessionalCap"${sc.basis === "toConcessionalCap" ? " selected" : ""}>Fill remaining concessional cap</option>
        </select>
      </td>
      <td class="cf-td-detail">${detailHTML}</td>
      <td class="cf-td-freq">
        <select data-kind="superContributions" data-cfid="${sc.id}" data-field="frequency">
          <option value="monthly"${sc.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${sc.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </td>
      <td class="cf-td-date">${dateRefControlHTML(sc.from, "client", `data-kind="superContributions" data-cfid="${sc.id}" data-field="from"`, 18, 120)}</td>
      <td class="cf-td-date">${dateRefControlHTML(sc.to, "client", `data-kind="superContributions" data-cfid="${sc.id}" data-field="to"`, 18, 120)}</td>
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-action="remove-row" data-kind="superContributions" data-cfid="${sc.id}">×</button>
      </td>
    </tr>
    ${showAmount ? indexationDetailRowHTML("superContributions", sc) : ""}
    ${headroomRow ? `<tr class="cf-tr-detail"><td colspan="99">${headroomRow}</td></tr>` : ""}
  `;
}

function superWithdrawalRowHTML(sw) {
  return `
    <tr class="cf-tr" data-cfid="${sw.id}">
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(sw.label)}" maxlength="60"
               data-kind="superWithdrawals" data-cfid="${sw.id}" data-field="label" />
      </td>
      ${isCouple() ? `
        <td class="cf-td-owner">
          <select data-kind="superWithdrawals" data-cfid="${sw.id}" data-field="owner">${superOwnerOptions(sw.owner)}</select>
        </td>
      ` : ""}
      <td class="cf-td-account">
        <select data-kind="superWithdrawals" data-cfid="${sw.id}" data-field="accountId">${superAccountOptions(sw.accountId, sw.owner)}</select>
      </td>
      ${amountTdHTML("superWithdrawals", sw.id, sw.amount)}
      <td class="cf-td-freq">
        <select data-kind="superWithdrawals" data-cfid="${sw.id}" data-field="frequency">
          <option value="monthly"${sw.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${sw.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </td>
      <td class="cf-td-date">${dateRefControlHTML(sw.from, "client", `data-kind="superWithdrawals" data-cfid="${sw.id}" data-field="from"`, 18, 120)}</td>
      <td class="cf-td-date">${dateRefControlHTML(sw.to, "client", `data-kind="superWithdrawals" data-cfid="${sw.id}" data-field="to"`, 18, 120)}</td>
      ${indexationTdHTML("superWithdrawals", sw)}
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-action="remove-row" data-kind="superWithdrawals" data-cfid="${sw.id}">×</button>
      </td>
    </tr>
  `;
}

function renderSuper() {
  const accounts = state.plan.superAccounts ?? [];
  const cards = accounts.map(superAccountCardHTML).join("");
  const cf = state.cashflows;
  const cashflowsHTML = `
    <div class="cf-panel">
      ${ffSubsectionHTML("Contributions", "superContributions", "Add contribution", cfHeaders.superContributions(),
        (cf.superContributions ?? []).map(superContributionRowHTML).join(""))}
      ${ffSubsectionHTML("Withdrawals", "superWithdrawals", "Add withdrawal", cfHeaders.superWithdrawals(),
        (cf.superWithdrawals ?? []).map(superWithdrawalRowHTML).join(""))}
    </div>
  `;
  els.superSection.innerHTML = accounts.length === 0
    ? `
      <h2 class="section-heading">Super</h2>
      ${pageEmptyHTML(
        "Add a super account to model accumulation-phase superannuation — balances, contributions, caps, and withdrawals.",
        `<button class="add-row-btn" type="button" data-super-action="add-account">+ Add super account</button>`
      )}
    `
    : `
      <h2 class="section-heading">Super</h2>
      <div id="superAccounts" class="portfolio-stack">${cards}</div>
      <div class="portfolio-actions">
        <button class="btn-text" type="button" data-super-action="add-account">+ Add super account</button>
      </div>
      ${cashflowsHTML}
    `;
}

function refreshSuperCardHead(said) {
  const sa = findSuperAccount(said);
  const card = els.superSection.querySelector(`.pcard[data-said="${said}"]`);
  if (!sa || !card) return;
  const nameEl = card.querySelector('[data-role="superHeadName"]');
  const metaEl = card.querySelector('[data-role="superHeadMeta"]');
  if (nameEl) nameEl.textContent = sa.name;
  if (metaEl) metaEl.textContent = superAccountHeadMeta(sa);
}

function refreshSuperAllocTotal(said) {
  const sa = findSuperAccount(said);
  if (!sa || sa.allocation.mode !== "custom") return;
  const el = document.querySelector(`[data-role="superAllocTotal-${said}"]`);
  if (el) {
    el.textContent = `Total: ${(sa.allocation.incomePct + sa.allocation.growthPct).toFixed(2)}% p.a. nominal`;
  }
}

// Applies a simple (non-structural) field edit to a super account.
// Returns true when the change is structural (needs a full re-render —
// owner switch changes account-select options everywhere else, etc.).
function applySuperAccountEdit(sa, field, el, commit) {
  switch (field) {
    case "name":
      sa.name = commit ? (el.value.trim() || sa.name) : el.value;
      if (commit) { el.value = sa.name; refreshSuperAccountSelects(); }
      return false;
    case "owner":
      if (["client", "partner"].includes(el.value)) sa.owner = el.value;
      return true;
    case "balance":
      sa.balance = clampNumber(el.value, 0);
      sa.taxFreeComponent = Math.min(sa.taxFreeComponent, sa.balance);
      if (commit) el.value = sa.balance;
      return false;
    case "taxFreeComponent":
      sa.taxFreeComponent = clampNumber(el.value, 0, sa.balance);
      if (commit) el.value = sa.taxFreeComponent;
      return false;
    case "icrPct":
      sa.icrPct = clampNumber(el.value, 0, 100);
      if (commit) el.value = sa.icrPct;
      return false;
    case "alloc.profile":
      sa.allocation = clampAllocation({ mode: "profile", profile: el.value }, PROFILES);
      return false;
    case "alloc.incomePct":
      sa.allocation.incomePct = clampNumber(el.value, 0, ALLOC_PCT_MAX);
      if (commit) el.value = sa.allocation.incomePct;
      retargetSuperVolBasis(sa.id);
      refreshSuperAllocTotal(sa.id);
      return false;
    case "alloc.growthPct":
      sa.allocation.growthPct = clampNumber(el.value, 0, ALLOC_PCT_MAX);
      if (commit) el.value = sa.allocation.growthPct;
      retargetSuperVolBasis(sa.id);
      refreshSuperAllocTotal(sa.id);
      return false;
    case "alloc.frankingPct":
      sa.allocation.frankingPct = clampNumber(el.value, 0, 100);
      if (commit) el.value = sa.allocation.frankingPct;
      return false;
    case "alloc.volBasis":
      if (Object.keys(PROFILES).includes(el.value)) {
        sa.allocation.volBasis = el.value;
        volBasisTouched.add(sa.id);
      }
      return false;
    default:
      return false;
  }
}

function retargetSuperVolBasis(said) {
  const sa = findSuperAccount(said);
  if (!sa || sa.allocation.mode !== "custom" || volBasisTouched.has(said)) return;
  const next = nearestVolBasis(PROFILES, sa.allocation.incomePct + sa.allocation.growthPct);
  if (next && next !== sa.allocation.volBasis) {
    sa.allocation.volBasis = next;
    const sel = els.superSection.querySelector(`[data-said="${said}"][data-sfield="alloc.volBasis"]`);
    if (sel) sel.value = next;
  }
}

els.superSection.addEventListener("input", (e) => {
  const said = e.target.dataset.said;
  const field = e.target.dataset.sfield;
  if (!said || !field) return;
  const sa = findSuperAccount(said);
  if (!sa) return;
  applySuperAccountEdit(sa, field, e.target, false);
  saveState();
  refreshOutputs();
});

els.superSection.addEventListener("change", (e) => {
  const said = e.target.dataset.said;
  const field = e.target.dataset.sfield;
  if (!said || !field) return;
  const sa = findSuperAccount(said);
  if (!sa) return;
  const structural = applySuperAccountEdit(sa, field, e.target, true);
  saveState();
  if (structural) {
    renderSuper();
  } else {
    refreshSuperCardHead(said);
  }
  refreshOutputs();
});

els.superSection.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-super-action]");
  if (!btn) return;
  const action = btn.dataset.superAction;
  if (action === "add-account") {
    const owner = isCouple() && (state.plan.superAccounts ?? []).some((s) => s.owner === "client")
      ? "partner" : "client";
    state.plan.superAccounts = [...(state.plan.superAccounts ?? []), createSuperAccount(state.plan, state.plan.superAccounts, PROFILES, owner)];
    saveState();
    refreshOutputs();
    renderSuper();
    return;
  }
  const said = btn.dataset.said;
  const sa = findSuperAccount(said);
  if (!sa) return;
  switch (action) {
    case "toggle-collapse": {
      if (e.target.closest(".pcard-include") || e.target.closest(".pcard-remove")) return;
      collapsed.set(said, !(collapsed.get(said) === true));
      renderSuper();
      break;
    }
    case "toggle-include": {
      sa.include = e.target.checked;
      saveState();
      els.superSection.querySelector(`.pcard[data-said="${said}"]`)?.classList.toggle("excluded", !sa.include);
      refreshOutputs();
      break;
    }
    case "remove-account": {
      if (!window.confirm(`Remove "${sa.name}"? Its contribution and withdrawal rows will be deleted too.`)) return;
      state.plan.superAccounts = state.plan.superAccounts.filter((x) => x.id !== said);
      state.cashflows.superContributions = (state.cashflows.superContributions ?? []).filter((c) => c.accountId !== said);
      state.cashflows.superWithdrawals = (state.cashflows.superWithdrawals ?? []).filter((w) => w.accountId !== said);
      collapsed.delete(said);
      volBasisTouched.delete(said);
      saveState();
      refreshOutputs();
      renderSuper();
      break;
    }
    case "alloc-mode": {
      switchAllocMode(sa, btn.dataset.mode === "custom" ? "custom" : "profile");
      saveState();
      renderSuper();
      refreshOutputs();
      break;
    }
  }
});

// --- liabilities section (D3) --------------------------------------------------

function liabilityDerivedText(l) {
  if (!(l.balance > 0)) return "Enter a balance to see repayments.";
  const i = monthlyRate(l);
  const pmt = levelPayment(l.balance, i, termMonths(l) - ioMonths(l));
  const ioPart = l.repayment === "io"
    ? `interest-only ≈ ${fmtMoney(l.balance * i)}/mo for ${l.ioYears}y, then `
    : "";
  // Payoff FY from the live projection (offsets can shorten it).
  let payoff = "beyond projection";
  if (projection) {
    const rows = projection.yearly;
    for (let y = 0; y < rows.length; y++) {
      const lr = rows[y].liabilities?.[l.id];
      if (!lr) break;
      const prev = y === 0 ? l.balance : rows[y - 1].liabilities[l.id].closing;
      if (lr.closing < 0.005 && prev > 0.005) { payoff = rows[y].fyLabel; break; }
    }
  }
  return `${ioPart}≈ ${fmtMoney(pmt)}/mo · paid off ${payoff}`;
}

function liabilityCardHTML(l) {
  const financialAssets = state.assets.filter((a) => a.class !== "lifestyle");
  const opt = (list, sel) => `<option value=""${!sel ? " selected" : ""}>None</option>` +
    list.map((a) => `<option value="${a.id}"${a.id === sel ? " selected" : ""}>${escapeHTML(a.name)}</option>`).join("");
  return `
    <div class="pcard" data-lid="${l.id}">
      <div class="pcard-head">
        <span class="pcard-name">${escapeHTML(l.name)}</span>
        <span class="pcard-meta">${liabilityDerivedText(l)}</span>
        <button class="pcard-remove" type="button" data-liab-action="remove" data-lid="${l.id}">Remove</button>
      </div>
      <div class="pcard-body">
        <div class="person-grid">
          <div class="cf-cell">
            <label>Name</label>
            <input type="text" maxlength="60" value="${escapeHTML(l.name)}" data-lid="${l.id}" data-lfield="name" />
          </div>
          <div class="cf-cell">
            <label>Type</label>
            <select data-lid="${l.id}" data-lfield="type">
              ${LIABILITY_TYPES.map((t) => `<option value="${t}"${l.type === t ? " selected" : ""}>${t[0].toUpperCase()}${t.slice(1)}</option>`).join("")}
            </select>
          </div>
          ${isCouple() ? `
            <div class="cf-cell">
              <label>Owner</label>
              <select data-lid="${l.id}" data-lfield="owner">${ownerOptions(l.owner)}</select>
            </div>
          ` : ""}
          <div class="cf-cell">
            <label>Balance ($)</label>
            <input type="number" min="0" step="1000" value="${l.balance}" data-lid="${l.id}" data-lfield="balance" />
          </div>
          <div class="cf-cell">
            <label>Interest rate (% p.a.)</label>
            <input type="number" min="0" max="30" step="0.05" value="${l.interestRatePct}" data-lid="${l.id}" data-lfield="interestRatePct" />
          </div>
          <div class="cf-cell">
            <label>Term (years)</label>
            <input type="number" min="1" max="50" step="1" value="${l.termYears}" data-lid="${l.id}" data-lfield="termYears" />
          </div>
          <div class="cf-cell">
            <label>Repayments</label>
            <div class="seg-toggle">
              <button class="seg-option${l.repayment === "pi" ? " active" : ""}" type="button"
                      data-liab-action="repayment" data-lid="${l.id}" data-value="pi">P&amp;I</button>
              <button class="seg-option${l.repayment === "io" ? " active" : ""}" type="button"
                      data-liab-action="repayment" data-lid="${l.id}" data-value="io">Interest only</button>
            </div>
          </div>
          ${l.repayment === "io" ? `
            <div class="cf-cell">
              <label>IO period (years)</label>
              <input type="number" min="1" max="${l.termYears}" step="1" value="${l.ioYears}" data-lid="${l.id}" data-lfield="ioYears" />
            </div>
          ` : ""}
          <div class="cf-cell">
            <label>Interest deductible</label>
            <label class="ptg-check">
              <input type="checkbox"${l.deductible ? " checked" : ""} data-lid="${l.id}" data-lfield="deductible" />
              <span>Deducts against ${l.owner === "joint" ? "both owners'" : "the owner's"} income</span>
            </label>
          </div>
          <div class="cf-cell">
            <label>Relates to / secured by</label>
            <select data-lid="${l.id}" data-lfield="linkedAssetId">${opt(state.assets, l.linkedAssetId)}</select>
          </div>
          <div class="cf-cell">
            <label>Offset account</label>
            <select data-lid="${l.id}" data-lfield="offsetAssetId">${opt(financialAssets, l.offsetAssetId)}</select>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderLiabilities() {
  const cards = (state.liabilities ?? []).map(liabilityCardHTML).join("");
  els.liabilitiesSection.innerHTML = cards === ""
    ? `
      <h2 class="section-heading">Liabilities</h2>
      ${pageEmptyHTML(
        "Add loans and mortgages to project repayments, interest and net assets.",
        `<button class="add-row-btn" type="button" data-liab-action="add">+ Add liability</button>`
      )}
    `
    : `
      <h2 class="section-heading">Liabilities</h2>
      <div id="liabilities" class="portfolio-stack">${cards}</div>
      <div class="portfolio-actions">
        <button class="btn-text" type="button" data-liab-action="add">+ Add liability</button>
      </div>
    `;
}

function findLiability(lid) {
  return (state.liabilities ?? []).find((l) => l.id === lid) || null;
}

els.liabilitiesSection.addEventListener("change", (e) => {
  const field = e.target.dataset.lfield;
  const l = findLiability(e.target.dataset.lid);
  if (!field || !l) return;
  if (field === "name") l.name = e.target.value.trim() || l.name;
  else if (field === "type") l.type = e.target.value;
  else if (field === "owner") l.owner = e.target.value;
  else if (field === "balance") l.balance = clampNumber(e.target.value, 0);
  else if (field === "interestRatePct") l.interestRatePct = clampNumber(e.target.value, 0, 30);
  else if (field === "termYears") l.termYears = clampInt(e.target.value, 1, 50);
  else if (field === "ioYears") l.ioYears = clampInt(e.target.value, 1, l.termYears); // never longer than the loan's own term
  else if (field === "deductible") l.deductible = e.target.checked;
  else if (field === "linkedAssetId") l.linkedAssetId = e.target.value || null;
  else if (field === "offsetAssetId") l.offsetAssetId = e.target.value || null;
  state.liabilities = normaliseLiabilities(state.liabilities, state.plan, state.assets);
  saveState();
  refreshOutputs();
  renderLiabilities();
});

els.liabilitiesSection.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-liab-action]");
  if (!btn) return;
  if (btn.dataset.liabAction === "add") {
    state.liabilities = [...(state.liabilities ?? []), createLiability(state.plan, state.liabilities ?? [])];
    saveState();
    refreshOutputs();
    renderLiabilities();
    return;
  }
  const l = findLiability(btn.dataset.lid);
  if (!l) return;
  if (btn.dataset.liabAction === "remove") {
    if (!window.confirm(`Remove "${l.name}"?`)) return;
    state.liabilities = state.liabilities.filter((x) => x.id !== l.id);
  } else if (btn.dataset.liabAction === "repayment") {
    l.repayment = btn.dataset.value === "io" ? "io" : "pi";
  }
  saveState();
  refreshOutputs();
  renderLiabilities();
});

// --- projection outputs (Phase B) -----------------------------------------
//
// The engine is sub-millisecond at this size: recompute live on every
// mutation, no worker, no debounce. The engine emits REAL values only;
// nominal is applied here at render time (convention 12).

let projection = null;
let activeView = "composite"; // the composite chart is the default Graphs view (D5)
let showAssets = false;
let assetsEntity = "all"; // Assets view entity selector: "all" | assetId
let superEntity = "all"; // Super view entity selector: "all" | super account id
let liabilitiesEntity = "all"; // Liabilities view entity selector: "all" | liability id

// Monte Carlo (Session B): unlike the deterministic engine above,
// 2,000 paths through the full tax-aware year loop is NOT sub-
// millisecond (order of several seconds for a realistic plan — see
// monteCarlo.js's own header and this session's measured benchmark),
// so it never runs automatically and runs in a dedicated worker
// (monteCarloWorker.js) rather than blocking the main thread. mcResult
// is invalidated when the PLAN changes (a fingerprint of everything
// that feeds projectPlan — see planFingerprint below) rather than on
// every call to refreshOutputs(): a display-only change (Real/Nominal
// toggle) must re-render the existing result in the new units, not
// discard a completed run and force a multi-second re-run just to see
// it differently formatted (audit fix, spec 10 commit 4's "results
// cache against a hash of scenario state" requirement — no such cache
// existed before this). The report period selector never called
// refreshOutputs() in the first place (setReportPeriod re-renders
// directly), so it was already unaffected; the units toggle was the
// actual bug. An in-flight run IS still terminated when the plan
// itself changes (its result would be for a plan that no longer
// exists) — see refreshOutputs below.
let mcResult = null;
// The planFingerprint() the current mcResult (or in-flight run) is
// valid for — null when there is neither. Compared against the live
// fingerprint in refreshOutputs() to decide whether a plan mutation
// actually happened, as opposed to a display-only change.
let mcResultFingerprint = null;
let mcRunning = false;
let mcProgress = null; // { done, total } while mcRunning; null otherwise
let mcWorker = null;

function stopMonteCarloWorker() {
  if (mcWorker) { mcWorker.terminate(); mcWorker = null; }
  mcRunning = false;
  mcProgress = null;
}

// Discard the cached/in-flight Monte Carlo result — used only when the
// PLAN (not a display setting) has actually changed since it started.
function invalidateMonteCarloResult() {
  mcResult = null;
  mcResultFingerprint = null;
  stopMonteCarloWorker();
}

// Everything that feeds projectPlan()'s output — i.e., everything that
// would make a completed (or in-flight) Monte Carlo run stale.
// `state.display` (units, report period, chart treatment, hide-empty-
// rows, show-individual-items, last-visited) is deliberately excluded:
// it's presentation-only and must never invalidate a run. JSON
// stringify comparison is the "hash" — cheap enough at this state size
// and simpler than a real hash function for a same-session equality
// check.
function planFingerprint() {
  return JSON.stringify({
    plan: state.plan, assets: state.assets, cashflows: state.cashflows,
    settings: state.settings, assumptions: state.assumptions,
    properties: state.properties, liabilities: state.liabilities,
  });
}

function recomputeProjection() {
  projection = projectPlan(state);
}

// One entry point after any mutation: recompute + refresh everything
// that displays engine output. Called for BOTH plan mutations and
// display-only changes (e.g. the units toggle) — only the former may
// invalidate a cached/in-flight Monte Carlo result.
function refreshOutputs() {
  recomputeProjection();
  if (mcResultFingerprint !== null && mcResultFingerprint !== planFingerprint()) {
    invalidateMonteCarloResult();
  }
  renderPeriodSelector();
  renderSummaryStrip();
  renderActiveView();
}

const VIEW_MOUNTS = {
  projection: () => els.viewProjection,
  composite: () => els.viewComposite,
  "net-assets": () => els.viewNetAssets,
  "asset-balances": () => els.viewAssetBalances,
  "asset-allocation": () => els.viewAssetAllocation,
  "monte-carlo": () => els.viewMonteCarlo,
  "super-balances": () => els.viewSuperBalances,
  "liabilities-balances": () => els.viewLiabilitiesBalances,
  "cashflow-bars": () => els.viewCashflowBars,
  "key-figures": () => els.viewKeyFigures,
  cashflow: () => els.viewCashflow,
  assets: () => els.viewAssets,
  tax: () => els.viewTax,
  super: () => els.viewSuper,
  liabilities: () => els.viewLiabilities,
  "monte-carlo-table": () => els.viewMonteCarloTable,
  assumptions: () => els.viewAssumptions,
};
const GRAPH_VIEWS = new Set(["projection", "composite", "net-assets", "asset-balances", "asset-allocation", "monte-carlo", "super-balances", "liabilities-balances", "cashflow-bars"]);

// Selection now happens via the sidebar (data-nav-section), which
// routes through handleRoute → showSection → here.
function renderActiveView() {
  for (const [name, mount] of Object.entries(VIEW_MOUNTS)) {
    mount().hidden = name !== activeView;
  }
  els.exportBtn.textContent = GRAPH_VIEWS.has(activeView) ? "Export PNG" : "Export CSV";
  // Asset allocation is a pure mix (always 100%, whichever way you cut
  // it) — real vs nominal dollars has nothing to say about it, so the
  // units toggle is suppressed here rather than left showing a control
  // with no effect (Asset class allocations commit).
  els.unitsToggle.hidden = activeView === "asset-allocation";
  if (activeView === "projection") renderProjectionChart();
  else if (activeView === "composite") renderCompositeChart();
  else if (activeView === "net-assets") renderNetAssetsChart();
  else if (activeView === "asset-balances") renderAssetBalancesChart();
  else if (activeView === "asset-allocation") renderAssetAllocationChart();
  else if (activeView === "monte-carlo") renderMonteCarloView();
  else if (activeView === "super-balances") renderSuperBalancesChart();
  else if (activeView === "liabilities-balances") renderLiabilitiesBalancesChart();
  else if (activeView === "cashflow-bars") renderCashflowBarsChart();
  else if (activeView === "key-figures") renderKeyFiguresView();
  else if (activeView === "cashflow") renderCashflowView();
  else if (activeView === "assets") renderAssetsView();
  else if (activeView === "tax") renderTaxView();
  else if (activeView === "super") renderSuperTableView();
  else if (activeView === "liabilities") renderLiabilitiesView();
  else if (activeView === "monte-carlo-table") renderMonteCarloTableView();
  else if (activeView === "assumptions") renderAssumptionsView();
}

const isNominal = () => state.display.units === "nominal";
const displayFactor = (m) => (isNominal() ? nominalFactor(m, state.assumptions.cpi) : 1);

// Month index at the END of plan year y (cumulative months elapsed).
function endMonthOfYear(y) {
  return projection.schedule.monthsInFirstYear + 12 * y;
}

// --- report period + thinning (D5, display state, persisted per scenario) ----
//
// Ages, not FY years, are the primary period bound (item D); thinning
// (item E) replaces the old All/Next 10/Next 20 presets: full detail
// across [fromAge, toAge], then every Nth plan year beyond `toAge`
// through the projection's actual end. Forcing pins the first/last
// projection years plus the shortfall year and any planned-property
// purchase year into every table, chart x-range, and export.

const fyShortLabel = (fyStart) =>
  `FY${String(fyStart % 100).padStart(2, "0")}–${String((fyStart + 1) % 100).padStart(2, "0")}`;

// Plan-year indices that must survive thinning beyond the ordinary
// first/last-year pins: the first shortfall, every planned property's
// purchase year, and every resolved key date (built-in or
// user-defined) — so the table/chart annotation always has a year to
// attach its label to.
function forcedYearIndices() {
  const forced = [];
  if (projection.shortfall) forced.push(projection.shortfall.planYear);
  for (const p of state.properties ?? []) {
    if (p.status !== "planned") continue;
    forced.push(resolveRef(p.purchaseAt, state.plan, projection.schedule, "client").planYear);
  }
  for (const a of listAnchors(state.plan, projection.schedule)) forced.push(a.planYear);
  return forced;
}

// The full (possibly non-contiguous) set of plan-year indices to show
// in every table and export.
function selectedYearIndices() {
  return thinnedYearIndices(state.display.reportPeriod, projection.schedule.clientAges, forcedYearIndices());
}

function renderPeriodSelector() {
  const years = projection.schedule.planYears;
  const ages = projection.schedule.clientAges;
  const rp = state.display.reportPeriod;
  const options = (sel, current) => {
    sel.innerHTML = Array.from({ length: years }, (_, y) =>
      `<option value="${ages[y]}"${ages[y] === current ? " selected" : ""}>${ages[y]}</option>`
    ).join("");
  };
  options(els.periodFromAge, rp.fromAge ?? ages[0]);
  options(els.periodToAge, rp.toAge ?? ages[years - 1]);
  els.periodEveryN.value = String(rp.everyN);
  els.forceKeyYearsToggle.checked = rp.forceKeyYears;
  els.hideEmptyRowsToggle.checked = state.display.hideEmptyRows !== false;
  // Cashflow-view-only control (Cashflow table: firm row vocabulary
  // and category grouping) — hidden everywhere else.
  els.showIndividualItemsLabel.hidden = activeView !== "cashflow";
  els.showIndividualItemsToggle.checked = state.display.showIndividualCashflowItems === true;
}

function setReportPeriod(patch) {
  state.display.reportPeriod = { ...state.display.reportPeriod, ...patch };
  saveState();
  renderPeriodSelector();
  renderActiveView();
}

els.periodFromAge.addEventListener("change", () => {
  const fromAge = Number(els.periodFromAge.value);
  const toAge = Math.max(fromAge, state.display.reportPeriod.toAge ?? fromAge);
  setReportPeriod({ fromAge, toAge });
});
els.periodToAge.addEventListener("change", () => {
  const toAge = Number(els.periodToAge.value);
  const fromAge = Math.min(toAge, state.display.reportPeriod.fromAge ?? toAge);
  setReportPeriod({ fromAge, toAge });
});
els.periodEveryN.addEventListener("change", () => {
  setReportPeriod({ everyN: Number(els.periodEveryN.value) });
});
els.forceKeyYearsToggle.addEventListener("change", () => {
  setReportPeriod({ forceKeyYears: els.forceKeyYearsToggle.checked });
});
els.hideEmptyRowsToggle.addEventListener("change", () => {
  state.display.hideEmptyRows = els.hideEmptyRowsToggle.checked;
  saveState();
  renderActiveView();
});
els.showIndividualItemsToggle.addEventListener("change", () => {
  state.display.showIndividualCashflowItems = els.showIndividualItemsToggle.checked;
  saveState();
  renderActiveView();
});
// --- View 1: projection chart -----------------------------------------------

// One point per plan year (FY-end closing balance), sourced from the
// same yearly ledger every table reads — chart and table cannot
// disagree. Annual cashflows fire in July, so a monthly line would
// show a step-then-drift sawtooth that is an artefact of that
// convention, not anything the client experiences; per-year points
// sidestep it entirely. X-axis is client age, matching every other
// chart; hover keeps the FY label alongside the age since this is the
// headline chart clients see first.
function renderProjectionChart() {
  const el = $("chart");
  if (typeof Plotly === "undefined") {
    el.innerHTML = `<p class="helper-text" style="text-align:center;padding:40px 0;">Chart unavailable (Plotly failed to load). The ledger view and autosave still work.</p>`;
    els.shortfallNote.hidden = true;
    return;
  }
  const { schedule, yearly, shortfall } = projection;
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => schedule.clientAges[y]);
  const fyLabels = yearIdxs.map((y) => schedule.fyLabels[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));

  const traces = [{
    x: ages, y: yearIdxs.map((y) => yearly[y].closingBalance * factor(y)), customdata: fyLabels,
    mode: "lines", type: "scatter",
    name: "Combined",
    line: { color: "rgb(28, 90, 180)", width: 2.5 },
    hovertemplate: "%{customdata} · age %{x}<br><b>%{y:$,.0f}</b><extra>Combined</extra>",
  }];

  if (showAssets) {
    const palette = ["#6b8e23", "#dc5a28", "#5e60ce", "#2e8a8a", "#b5179e", "#d97b2f", "#9a031e", "#3a86c9"];
    let i = 0;
    for (const a of state.assets.filter((x) => x.include)) {
      traces.push({
        x: ages, y: yearIdxs.map((y) => (yearly[y].perAssetClosing[a.id] ?? 0) * factor(y)), customdata: fyLabels,
        mode: "lines", type: "scatter",
        name: a.name,
        line: { color: palette[i++ % palette.length], width: 1.5 },
        hovertemplate: `%{customdata} · age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(a.name)}</extra>`,
      });
    }
  }

  const shapes = [];
  const annotations = [];
  if (shortfall) {
    const sx = shortfall.clientAge;
    shapes.push({
      type: "line", xref: "x", yref: "paper",
      x0: sx, x1: sx, y0: 0, y1: 1,
      line: { color: "rgba(200, 80, 60, 0.6)", width: 1.5, dash: "dash" },
    });
    annotations.push({
      x: sx, xref: "x", y: 1, yref: "paper",
      yanchor: "bottom", text: "First shortfall", showarrow: false,
      font: { size: 11, color: "rgb(200, 80, 60)" },
    });
    els.shortfallNote.textContent =
      `Planned outflows exceed available funds from age ${shortfall.clientAge} (${shortfall.fyLabel}); ` +
      `${fmtMoney(shortfall.total)} (today's dollars) of outflows are unfunded over the projection.`;
    els.shortfallNote.hidden = false;
  } else {
    els.shortfallNote.hidden = true;
  }

  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 60 },
    paper_bgcolor: "white",
    plot_bgcolor: "white",
    hovermode: "x unified",
    showlegend: showAssets,
    legend: { orientation: "h", y: -0.18, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Balance (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    shapes, annotations,
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

// --- View: Composite chart (D5) — the default Graphs view -------------------
//
// "Cashflow, Assets & Liabilities" — the headline artefact. Dual axis,
// x = CLIENT AGE, one point per selected (thinned) plan year: net
// assets as a filled area (can go negative in early mortgage years —
// never clamped), non-financial assets as their own stacked area when
// the display treatment below says Include Separately, total
// expenditure including tax as a line, income and capital drawdown as
// bars. Series come from src/outputSeries.js — pure and unit-tested;
// this function only scales and draws them.

function chartUnavailableHTML() {
  return `<p class="helper-text" style="text-align:center;padding:40px 0;">Chart unavailable (Plotly failed to load). Table views and autosave still work.</p>`;
}

function renderCompositeChart() {
  const el = $("chartComposite");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const scale = (arr) => yearIdxs.map((y, i) => arr[y] * factor(y));

  const series = compositeSeries(projection.yearly, state.assets, state.properties ?? [], state.display.chartTreatment);
  const netArea = scale(series.netAssetsArea);
  const sepArea = scale(series.separateArea);
  const incomeArea = scale(series.income);
  const drawdownArea = scale(series.drawdown);
  const expenditureArea = scale(series.expenditure);

  // Auto-hide series that are zero across every displayed period —
  // no legend entry, no bar slot. Net assets is the chart's anchor
  // (and axis reference) and is always drawn, even if zero.
  const hasSeparate = !seriesIsAllZero(sepArea);
  const hasIncome = !seriesIsAllZero(incomeArea);
  const hasDrawdown = !seriesIsAllZero(drawdownArea);
  const hasExpenditure = !seriesIsAllZero(expenditureArea);

  const traces = [{
    x: ages, y: netArea, name: "Net assets",
    type: "scatter", mode: "lines", fill: "tozeroy",
    line: { color: "rgb(28, 90, 180)", width: 1.5 },
    fillcolor: "rgba(28, 90, 180, 0.18)",
    hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Net assets</extra>",
  }];
  if (hasSeparate) {
    traces.push({
      x: ages, y: sepArea, name: "Non-financial assets",
      type: "scatter", mode: "lines", fill: "tonexty",
      line: { color: "rgb(150, 180, 220)", width: 1.5 },
      fillcolor: "rgba(150, 180, 220, 0.12)",
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Non-financial assets</extra>",
    });
  }
  if (hasIncome) {
    traces.push({
      x: ages, y: incomeArea, name: "Income", type: "bar",
      marker: { color: "rgb(107, 142, 35)", opacity: 0.55 }, yaxis: "y2",
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Income</extra>",
    });
  }
  if (hasDrawdown) {
    traces.push({
      x: ages, y: drawdownArea, name: "Capital drawdown", type: "bar",
      marker: { color: "rgb(217, 123, 47)", opacity: 0.55 }, yaxis: "y2",
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Capital drawdown</extra>",
    });
  }
  if (hasExpenditure) {
    traces.push({
      x: ages, y: expenditureArea, name: "Total expenditure (incl. tax)", type: "scatter",
      mode: "lines", line: { color: "rgb(180, 40, 40)", width: 2 }, yaxis: "y2",
      hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Total expenditure (incl. tax)</extra>",
    });
  }

  // Shared zero baseline: the left (assets) axis spans net assets plus
  // whatever's stacked on top of it as a separate area; the right
  // (income/expenditure) axis spans the stacked income+drawdown bars
  // plus the expenditure line. Only visible (non-hidden) series feed
  // the range maths.
  const topArea = hasSeparate ? netArea.map((v, i) => v + sepArea[i]) : netArea;
  const leftValues = hasSeparate ? [...netArea, ...topArea] : netArea;
  const stackTop = ages.map((_, i) => (hasIncome ? incomeArea[i] : 0) + (hasDrawdown ? drawdownArea[i] : 0));
  const rightValues = hasExpenditure ? [...stackTop, ...expenditureArea] : stackTop;
  const { leftRange, rightRange, zeroFraction, leftDataRange, rightDataRange } =
    sharedZeroRanges(leftValues, rightValues);
  // Each axis may be stretched past its own data purely to align its
  // zero with the other axis — confine tick labels to the span the
  // axis's own series actually occupy so no axis labels a value no
  // series ever reaches.
  const leftTicks = axisTickVals(leftRange, leftDataRange);
  const rightTicks = axisTickVals(rightRange, rightDataRange);

  const periods = ages.length;
  const dtick = periods <= 15 ? 1 : periods <= 40 ? 5 : 10;

  // Key date annotation (Tier 1.1): a thin, low-opacity vertical rule
  // + label at each retirement/user key date year that survived
  // thinning onto the displayed x-range — subtle, no fill.
  const keyDateMarks = listAnchors(state.plan, projection.schedule)
    .filter((a) => !SKIP_LABEL_ANCHOR_IDS.has(a.id) && yearIdxs.includes(a.planYear))
    .map((a) => ({ age: projection.schedule.clientAges[a.planYear], label: a.label }));
  const keyDateShapes = keyDateMarks.map((k) => ({
    type: "line", xref: "x", x0: k.age, x1: k.age, yref: "paper", y0: 0, y1: 1,
    line: { color: "rgba(0, 0, 0, 0.15)", width: 1, dash: "dot" },
  }));
  const keyDateAnnotations = keyDateMarks.map((k) => ({
    // Plotly's text field interprets its own small HTML-like tag
    // subset, not raw HTML — escapeHTML() would double-escape entities
    // (e.g. "&" → "&amp;" shown literally), so the label goes through
    // as-is, same as every other dynamic label already fed to Plotly
    // in this file (hovertemplates, trace names).
    x: k.age, y: 1, xref: "x", yref: "paper", yanchor: "bottom", xanchor: "left",
    text: k.label, showarrow: false, textangle: -90,
    font: { size: 9, color: "rgba(0, 0, 0, 0.5)" },
  }));

  Plotly.react(el, traces, {
    margin: { l: 64, r: 64, t: 16, b: 44 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", barmode: "stack", bargap: 0.1, showlegend: true,
    legend: { orientation: "h", y: -0.16, x: 0.5, xanchor: "center", font: { size: 11 } },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick },
    yaxis: {
      title: { text: `Assets (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10, font: { size: 11 } },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.05)", zeroline: false,
      range: leftRange, autorange: false,
      tickmode: "array", tickvals: leftTicks,
    },
    yaxis2: {
      title: { text: "Income / expenditure", standoff: 10, font: { size: 11 } },
      tickformat: "$,.2s", overlaying: "y", side: "right", showgrid: false, zeroline: false,
      range: rightRange, autorange: false,
      tickmode: "array", tickvals: rightTicks,
    },
    shapes: [
      { type: "line", xref: "paper", x0: 0, x1: 1, yref: "paper", y0: zeroFraction, y1: zeroFraction,
        line: { color: "rgba(0, 0, 0, 0.3)", width: 1 } },
      ...keyDateShapes,
    ],
    annotations: keyDateAnnotations,
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 11.5, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

els.chartTreatmentSelects.forEach((sel) => {
  sel.addEventListener("change", () => {
    state.display.chartTreatment = { ...state.display.chartTreatment, [sel.dataset.treatment]: sel.value };
    saveState();
    if (activeView === "composite") renderCompositeChart(); // display-only — never touches table values
  });
});

// --- View: Net assets chart (D5) ---------------------------------------------

function renderNetAssetsChart() {
  const el = $("chartNetAssets");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const netAssets = yearIdxs.map((y) => projection.yearly[y].netAssets * factor(y));

  Plotly.react(el, [{
    x: ages, y: netAssets, name: "Net assets",
    type: "scatter", mode: "lines", fill: "tozeroy",
    line: { color: "rgb(28, 90, 180)", width: 2.5 },
    hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Net assets</extra>",
  }], {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: false,
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Net assets (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

// --- View: Asset balances chart (D5) -----------------------------------------
//
// Each included asset's closing balance, stacked. The lifestyle
// display treatment applies (exclude drops it from the stack;
// separate has no distinct meaning in an asset-only chart, so it
// behaves like include here — disclosed in this comment).

function renderAssetBalancesChart() {
  const el = $("chartAssetBalances");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lifestyleTreatment = state.display.chartTreatment.lifestyle;
  const included = state.assets.filter((a) => a.include && (a.class !== "lifestyle" || lifestyleTreatment !== "exclude"));
  const palette = ["#1c5ab4", "#6b8e23", "#dc5a28", "#5e60ce", "#2e8a8a", "#b5179e", "#d97b2f", "#9a031e", "#3a86c9"];

  const traces = included.map((a, i) => ({
    x: ages,
    y: yearIdxs.map((y) => (projection.yearly[y].perAssetClosing[a.id] ?? 0) * factor(y)),
    name: a.name, type: "scatter", mode: "lines",
    stackgroup: "assets", fill: "tonexty",
    line: { color: palette[i % palette.length], width: 1 },
    hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(a.name)}</extra>`,
  }));

  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Balance (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

// --- View: Asset allocation chart (Asset class allocations commit) ----------
//
// 100% stacked area, by client age, one band per asset class
// (profiles.js's ASSET_CLASS_KEYS/ASSET_CLASS_LABELS) — weights come
// from allocation.js's allocationSeries, which derives them from each
// included, non-lifestyle financial asset's and super account's own
// profile (a custom allocation borrows its volatility-basis profile's
// weights, same as Monte Carlo does — noted beneath the chart when
// that applies). Lifestyle assets and property carry no profile and
// are excluded from the mix entirely (see allocation.js's header).
// Real vs nominal is meaningless for a 100%-stacked mix, so the units
// toggle is suppressed for this view (renderActiveView).

function renderAssetAllocationChart() {
  const el = $("chartAssetAllocation");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const { perYear, usesCustom } = allocationSeries(
    yearIdxs.map((y) => projection.yearly[y]), state.assets, state.plan.superAccounts ?? [], PROFILES
  );
  const palette = ["#1c5ab4", "#6b8e23", "#dc5a28", "#5e60ce", "#2e8a8a", "#d97b2f"];

  const traces = ASSET_CLASS_KEYS.map((k, i) => ({
    x: ages,
    y: perYear.map((p) => p.weightPct[k]),
    name: ASSET_CLASS_LABELS[k], type: "scatter", mode: "lines",
    stackgroup: "alloc", fill: "tonexty",
    line: { color: palette[i % palette.length], width: 1 },
    hovertemplate: `Age %{x}<br>%{y:.1f}%<extra>${escapeHTML(ASSET_CLASS_LABELS[k])}</extra>`,
  }));

  Plotly.react(el, traces, {
    margin: { l: 60, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: "Allocation", standoff: 10 },
      tickformat: ".0f", ticksuffix: "%", dtick: 25,
      range: [0, 100], gridcolor: "rgba(0,0,0,0.06)", zeroline: false,
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });

  $("assetAllocationNote").textContent = usesCustom
    ? "Assets and super accounts with a custom allocation are shown using their selected volatility-basis profile's class weights (the same profile Monte Carlo variability borrows from)."
    : "";
}

// --- View: Monte Carlo (Session B) -------------------------------------------
//
// Runs 2,000 full paths through the real, tax-aware engine (monte
// Carlo.js's runMonteCarlo — NOT the legacy scalar sim.js, which stays
// behind LEGACY_INSIGHTS_ENABLED) with randomised, correlated monthly
// returns per included financial asset and super account. This is
// order-of-seconds, not sub-millisecond like the deterministic engine
// above — never auto-run on a mutation, and run inside a dedicated
// worker (monteCarloWorker.js) rather than blocking the main thread, so
// the rest of the UI stays responsive and a run can be cancelled
// outright. Any plan edit invalidates the cached result and terminates
// an in-flight run (refreshOutputs) rather than leaving a stale chart
// or finishing a run for a plan that no longer exists.

// Shared Run/Cancel/status control triple — the Graphs view and the
// Tables view each have their own set of these three elements (ids
// must be unique in the document), both driven by the SAME mcResult/
// mcRunning/mcProgress/mcWorker state, so either view can start a run,
// and a run started from one is visible (progress included) from the
// other if the user switches mid-run.
function renderMonteCarloControls(runBtn, cancelBtn, statusEl) {
  runBtn.hidden = mcRunning;
  cancelBtn.hidden = !mcRunning;
  runBtn.textContent = `Run Monte Carlo (${DEFAULT_NUM_PATHS.toLocaleString()} paths)`;
  if (mcRunning) {
    const pct = mcProgress && mcProgress.total > 0 ? Math.round((mcProgress.done / mcProgress.total) * 100) : 0;
    statusEl.textContent = mcProgress
      ? `Simulating — ${mcProgress.done.toLocaleString()} / ${mcProgress.total.toLocaleString()} paths (${pct}%).`
      : "Simulating…";
  } else if (!mcResult) {
    statusEl.textContent = "";
  } else {
    statusEl.textContent =
      `${mcResult.numPaths.toLocaleString()} paths in ${(mcResult.elapsedMs / 1000).toFixed(1)}s. ` +
      "Re-run after changing the plan — this result is a snapshot, not live.";
  }
}

// Re-renders BOTH Monte Carlo views' controls (and results, once
// mcResult exists) regardless of which is currently on screen — cheap,
// and means a run started from either view stays correct if the user
// navigates to the other one mid-run or after it finishes.
function refreshMonteCarloViews() {
  renderMonteCarloView();
  renderMonteCarloTableView();
}

function renderMonteCarloView() {
  renderMonteCarloControls(els.runMonteCarloBtn, els.cancelMonteCarloBtn, els.monteCarloStatus);
  els.monteCarloResults.hidden = !mcResult;
  if (!mcResult) return;
  renderMonteCarloChart();
  renderMonteCarloStats();
  renderMonteCarloTable();
}

function renderMonteCarloChart() {
  const el = $("chartMonteCarlo");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const band = (key) => yearIdxs.map((y) => mcResult.netAssets[key][y] * factor(y));
  const p10 = band("p10"), p25 = band("p25"), p50 = band("p50"), p75 = band("p75"), p90 = band("p90");
  // Same netAssets figure the deterministic engine reports (out.yearly[y].
  // netAssets — deterministic.js), same units/scaling as the bands above:
  // genuinely comparable, not a second, differently-derived series.
  const deterministic = yearIdxs.map((y) => projection.yearly[y].netAssets * factor(y));

  const outer = "rgba(28, 90, 180, 0.12)";
  const inner = "rgba(28, 90, 180, 0.28)";
  const traces = [
    { x: ages, y: p10, mode: "lines", line: { width: 0 }, showlegend: false, hoverinfo: "skip" },
    { x: ages, y: p90, mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: outer,
      name: "10th–90th percentile", hovertemplate: "Age %{x}<br>P90 %{y:$,.0f}<extra></extra>" },
    { x: ages, y: p25, mode: "lines", line: { width: 0 }, showlegend: false, hoverinfo: "skip" },
    { x: ages, y: p75, mode: "lines", line: { width: 0 }, fill: "tonexty", fillcolor: inner,
      name: "25th–75th percentile", hovertemplate: "Age %{x}<br>P75 %{y:$,.0f}<extra></extra>" },
    { x: ages, y: p50, mode: "lines", line: { color: "rgb(28, 90, 180)", width: 2.5 },
      name: "Median", hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Median</extra>" },
    { x: ages, y: deterministic, mode: "lines", line: { color: "#444", width: 1.5, dash: "dash" },
      name: "Deterministic projection", hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Deterministic</extra>" },
  ];

  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Net assets (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

// Headline stats, in the locked order: ruin probability first (the
// single ruin definition — see monteCarlo.js — never a second,
// independently-computed "success" figure), then median/10th/90th
// ending net assets, then median first-shortfall age (only shown when
// at least one path was ruined — undefined for an ample plan).
function renderMonteCarloStats() {
  const years = mcResult.years;
  const factor = displayFactor(endMonthOfYear(years - 1));
  const ruinPct = (mcResult.ruinProbability * 100).toFixed(0);
  const shortfallAgeStat = mcResult.medianShortfallAge != null ? `
    <div class="stat">
      <div class="stat-label">Median first-shortfall age</div>
      <div class="stat-value">${Math.round(mcResult.medianShortfallAge)}</div>
    </div>
  ` : "";
  els.monteCarloStats.innerHTML = `
    <div class="stat stat-headline">
      <div class="stat-label">Ruin probability</div>
      <div class="stat-value">${ruinPct}%</div>
    </div>
    <div class="stat">
      <div class="stat-label">Median ending net assets</div>
      <div class="stat-value">${fmtMoney(mcResult.netAssets.p50[years - 1] * factor)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">10th percentile ending</div>
      <div class="stat-value">${fmtMoney(mcResult.netAssets.p10[years - 1] * factor)}</div>
    </div>
    <div class="stat">
      <div class="stat-label">90th percentile ending</div>
      <div class="stat-value">${fmtMoney(mcResult.netAssets.p90[years - 1] * factor)}</div>
    </div>
    ${shortfallAgeStat}
  `;
  // Custom-allocation flag (never blocks the run): lists exactly which
  // included holdings borrowed a volatility-basis profile rather than
  // having their own calibrated σ.
  const customNote = $("monteCarloCustomNote");
  if (mcResult.customHoldings.length > 0) {
    const names = mcResult.customHoldings.map((h) => `${h.name} (${h.volBasis})`).join(", ");
    customNote.textContent =
      `${mcResult.customHoldings.length} asset(s) use custom returns; their variability is modelled on the ` +
      `volatility basis profile selected for each — ${names}.`;
  } else {
    customNote.textContent = "";
  }
}

// Shared by both the Graphs view's under-chart table and the Tables
// view's percentile table (and its CSV export) — one row/column
// definition, so the two can never drift apart.
function monteCarloPercentileGroups() {
  return [{
    title: "Net assets — simulated percentiles",
    rows: [
      { label: "10th percentile", cell: (y) => mcResult.netAssets.p10[y], always: true },
      { label: "25th percentile", cell: (y) => mcResult.netAssets.p25[y], always: true },
      { label: "Median (50th)", cell: (y) => mcResult.netAssets.p50[y], always: true, cls: "tl-total" },
      { label: "75th percentile", cell: (y) => mcResult.netAssets.p75[y], always: true },
      { label: "90th percentile", cell: (y) => mcResult.netAssets.p90[y], always: true },
    ],
  }];
}
const MC_CORRELATION_NOTE = `<p class="chart-note-inline">Single shared market factor (ρ = 0.85) plus each holding's own profile-based regime switching — not a per-asset-class correlation matrix (would need per-class σ calibrated to reproduce each profile's firm-set σ; a future refinement, see Parameters). Lifestyle assets and property carry no profile and are not randomised.</p>`;

function renderMonteCarloTable() {
  renderTransposed($("monteCarloTable"), monteCarloPercentileGroups(), MC_CORRELATION_NOTE);
}

// --- View: Monte Carlo (Tables) -----------------------------------------------
//
// The percentile-by-FY table above plus a distribution summary of the
// FINAL year's net assets (min/percentiles/max/mean, from mcResult.
// endDistribution) — the detailed, exportable companion to the Graphs
// view's fan chart. Shares mcResult/mcRunning with it (see
// renderMonteCarloControls); shows the same Run prompt when no result
// exists yet.

function renderMonteCarloTableView() {
  renderMonteCarloControls(els.runMonteCarloTableBtn, els.cancelMonteCarloTableBtn, els.monteCarloTableStatus);
  els.monteCarloTableResults.hidden = !mcResult;
  if (!mcResult) return;
  renderTransposed($("monteCarloPercentileTable"), monteCarloPercentileGroups(), MC_CORRELATION_NOTE);
  renderMonteCarloDistributionTable();
}

function renderMonteCarloDistributionTable() {
  const d = mcResult.endDistribution;
  const factor = displayFactor(endMonthOfYear(mcResult.years - 1));
  const rows = [
    ["Minimum", d.min], ["10th percentile", d.p10], ["25th percentile", d.p25],
    ["Median", d.p50], ["75th percentile", d.p75], ["90th percentile", d.p90],
    ["Maximum", d.max], ["Mean", d.mean],
  ];
  $("monteCarloDistributionTable").innerHTML = `
    <table class="param-table">
      <thead><tr><th>Statistic</th><th>Ending net assets</th></tr></thead>
      <tbody>
        ${rows.map(([label, val]) => `<tr><td>${escapeHTML(label)}</td><td>${fmtMoney(val * factor)}</td></tr>`).join("")}
      </tbody>
    </table>
  `;
}

function exportMonteCarloCSV() {
  if (!mcResult) return;
  const esc = (s) => `"${String(s).replaceAll('"', '""')}"`;
  const yearIdxs = selectedYearIndices();
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lines = [];
  lines.push(["Net assets — simulated percentiles", ...yearIdxs.map((y) => yearHeaderText(y))].map(esc).join(","));
  for (const g of monteCarloPercentileGroups()) {
    for (const r of g.rows) {
      lines.push([esc(r.label), ...yearIdxs.map((y) => (r.cell(y) * factor(y)).toFixed(2))].join(","));
    }
  }
  lines.push("");
  lines.push(esc("Distribution summary — ending net assets"));
  const endFactor = displayFactor(endMonthOfYear(mcResult.years - 1));
  const d = mcResult.endDistribution;
  for (const [label, val] of [
    ["Minimum", d.min], ["10th percentile", d.p10], ["25th percentile", d.p25], ["Median", d.p50],
    ["75th percentile", d.p75], ["90th percentile", d.p90], ["Maximum", d.max], ["Mean", d.mean],
  ]) {
    lines.push([esc(label), (val * endFactor).toFixed(2)].join(","));
  }
  lines.push("");
  lines.push([esc("Ruin probability (%)"), (mcResult.ruinProbability * 100).toFixed(1)].join(","));
  if (mcResult.medianShortfallAge != null) {
    lines.push([esc("Median first-shortfall age"), mcResult.medianShortfallAge].join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${exportNameBase()}-monte-carlo.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function startMonteCarloRun() {
  if (mcRunning) return;
  mcRunning = true;
  // Stamped now, not on completion: if the plan mutates while this run
  // is in flight, refreshOutputs() compares against THIS fingerprint
  // and correctly cancels the now-stale run.
  mcResultFingerprint = planFingerprint();
  mcProgress = { done: 0, total: DEFAULT_NUM_PATHS };
  refreshMonteCarloViews();

  mcWorker = new Worker(new URL("./monteCarloWorker.js", import.meta.url), { type: "module" });
  mcWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "progress") {
      mcProgress = { done: msg.done, total: msg.total };
      refreshMonteCarloViews();
    } else if (msg.type === "done") {
      mcResult = msg.result;
      stopMonteCarloWorker();
      refreshMonteCarloViews();
    } else if (msg.type === "error") {
      invalidateMonteCarloResult();
      refreshMonteCarloViews();
      els.monteCarloStatus.textContent = `Monte Carlo run failed: ${msg.message}`;
      els.monteCarloTableStatus.textContent = `Monte Carlo run failed: ${msg.message}`;
    }
  };
  mcWorker.onerror = (e) => {
    invalidateMonteCarloResult();
    refreshMonteCarloViews();
    els.monteCarloStatus.textContent = `Monte Carlo run failed: ${e.message}`;
    els.monteCarloTableStatus.textContent = `Monte Carlo run failed: ${e.message}`;
  };
  // state/PROFILES are plain data (no functions, no DOM) — structured-
  // clone across the worker boundary without loss.
  mcWorker.postMessage({ state, profiles: PROFILES, options: {} });
}

function cancelMonteCarloRun() {
  invalidateMonteCarloResult();
  refreshMonteCarloViews(); // resets button visibility; clears status since mcResult is still null
  els.monteCarloStatus.textContent = "Cancelled.";
  els.monteCarloTableStatus.textContent = "Cancelled.";
}

els.runMonteCarloBtn.addEventListener("click", startMonteCarloRun);
els.cancelMonteCarloBtn.addEventListener("click", cancelMonteCarloRun);
els.runMonteCarloTableBtn.addEventListener("click", startMonteCarloRun);
els.cancelMonteCarloTableBtn.addEventListener("click", cancelMonteCarloRun);
$("mcVolatilityDragLink").addEventListener("click", () => openModal("volatility-drag"));

// --- View: Super balances chart (Tier 1.2, Commit 4) ------------------------
//
// Each included super account's closing balance, stacked — the same
// shape as the Asset balances chart. Net assets and the composite
// chart already fold super in via the engine's own row.netAssets
// (Commit 1); this is the dedicated per-account breakdown.

function renderSuperBalancesChart() {
  const el = $("chartSuperBalances");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const included = (state.plan.superAccounts ?? []).filter((s) => s.include);
  const palette = ["#1c5ab4", "#6b8e23", "#dc5a28", "#5e60ce", "#2e8a8a", "#b5179e", "#d97b2f", "#9a031e", "#3a86c9"];

  const traces = included.map((s, i) => ({
    x: ages,
    y: yearIdxs.map((y) => (projection.yearly[y].superDetail[s.id]?.closing ?? 0) * factor(y)),
    name: s.name, type: "scatter", mode: "lines",
    stackgroup: "super", fill: "tonexty",
    line: { color: palette[i % palette.length], width: 1 },
    hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(s.name)}</extra>`,
  }));

  if (traces.length === 0) {
    el.innerHTML = `<p class="helper-text" style="padding:24px 8px;">Add a super account to see balances here.</p>`;
    return;
  }

  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Super balance (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

// --- View: Liabilities balances chart (fix batch, item 5) -------------------
//
// One line per loan (user-entered or property-purchase-derived) plus
// a Total, x-axis client age — lines, not a stack, since balances
// here are debts owed rather than assets held. A star marks the plan
// year a loan first reaches zero (its payoff), when that year falls
// within the selected period.

function liabilityPayoffYear(lid) {
  const yl = projection.yearly;
  for (let y = 0; y < yl.length; y++) {
    const lr = yl[y].liabilities?.[lid];
    if (!lr) continue;
    if (lr.closing < 0.005 && lr.opening > 0.005) return y;
  }
  return null;
}
function liabilityPayoffLabel(lid) {
  const y = liabilityPayoffYear(lid);
  return y == null ? "beyond projection" : projection.yearly[y].fyLabel;
}

function renderLiabilitiesBalancesChart() {
  const el = $("chartLiabilitiesBalances");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yl = projection.yearly;
  const liabIds = Object.keys(yl[0]?.liabilities ?? {});
  if (liabIds.length === 0) {
    el.innerHTML = `<p class="helper-text" style="padding:24px 8px;">No liabilities to show.</p>`;
    return;
  }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const palette = ["#1c5ab4", "#6b8e23", "#dc5a28", "#5e60ce", "#2e8a8a", "#b5179e", "#d97b2f", "#9a031e", "#3a86c9"];

  const traces = liabIds.map((lid, i) => ({
    x: ages,
    y: yearIdxs.map((y) => (yl[y].liabilities[lid]?.closing ?? 0) * factor(y)),
    name: loanName(lid), type: "scatter", mode: "lines",
    line: { color: palette[i % palette.length], width: 1.5 },
    hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(loanName(lid))}</extra>`,
  }));
  traces.push({
    x: ages,
    y: yearIdxs.map((y) => yl[y].liabilitiesClosing * factor(y)),
    name: "Total", type: "scatter", mode: "lines",
    line: { color: "#222", width: 2.5, dash: "dot" },
    hovertemplate: `Age %{x}<br><b>%{y:$,.0f}</b><extra>Total</extra>`,
  });
  for (const lid of liabIds) {
    const payoffY = liabilityPayoffYear(lid);
    if (payoffY == null || !yearIdxs.includes(payoffY)) continue;
    traces.push({
      x: [projection.schedule.clientAges[payoffY]], y: [0],
      type: "scatter", mode: "markers", showlegend: false,
      marker: { symbol: "star", size: 12, color: "#1c5ab4", line: { color: "white", width: 1 } },
      hovertemplate: `Age %{x}<br>${escapeHTML(loanName(lid))} paid off<extra></extra>`,
    });
  }

  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Balance owing (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

// --- View: Cashflow bars chart (fix batch 3, item 2) ------------------------
//
// The client-facing counterpart to the Cashflow table: stacked bars by
// client age, income above the axis and expenses below (Plotly's
// "relative" barmode stacks each sign on its own side of zero), with
// Surplus/(deficit) overlaid as a line. Categories are sourced from
// incomeCategorySums/expenseCategorySums, the same functions the
// Cashflow table's reconciliation relies on — chart and table read
// the same numbers, just grouped differently (category vs per-row).

const CASHFLOW_INCOME_SEGMENTS = [
  { key: "employment", name: "Employment", color: "#1c5ab4" },
  { key: "rental", name: "Rental", color: "#2e8a8a" },
  { key: "investment", name: "Investment/distributions", color: "#6b8e23" },
  { key: "wcaInterest", name: "Working Cash Account interest", color: "#5e60ce" },
  { key: "other", name: "Other income", color: "#8d99ae" },
];
const CASHFLOW_EXPENSE_SEGMENTS = [
  { key: "living", name: "Living expenses", color: "#dc5a28" },
  { key: "investmentExpenses", name: "Investment/property expenses", color: "#d97b2f" },
  { key: "loanInterest", name: "Loan interest", color: "#9a031e" },
  { key: "loanPrincipal", name: "Loan principal", color: "#c1121f" },
  { key: "tax", name: "Tax", color: "#780000" },
  { key: "superContributions", name: "Super contributions", color: "#b5179e" },
];

function renderCashflowBarsChart() {
  const el = $("chartCashflowBars");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yl = projection.yearly;
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const incomeSums = yearIdxs.map(incomeCategorySums);
  const expenseSums = yearIdxs.map(expenseCategorySums);

  const traces = [];
  for (const seg of CASHFLOW_INCOME_SEGMENTS) {
    const y = yearIdxs.map((yr, i) => incomeSums[i][seg.key] * factor(yr));
    if (seriesIsAllZero(y)) continue; // hide-empty-rows convention
    traces.push({
      x: ages, y,
      name: seg.name, type: "bar",
      marker: { color: seg.color },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(seg.name)}</extra>`,
    });
  }
  for (const seg of CASHFLOW_EXPENSE_SEGMENTS) {
    const y = yearIdxs.map((yr, i) => -expenseSums[i][seg.key] * factor(yr));
    if (seriesIsAllZero(y)) continue;
    traces.push({
      x: ages, y,
      name: seg.name, type: "bar",
      marker: { color: seg.color },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(seg.name)}</extra>`,
    });
  }
  traces.push({
    x: ages, y: yearIdxs.map((y) => yl[y].surplusOrDeficit * factor(y)),
    name: "Surplus / (deficit)", type: "scatter", mode: "lines+markers",
    line: { color: "#111", width: 2 }, marker: { size: 5 },
    hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Surplus / (deficit)</extra>",
  });

  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 70 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    barmode: "relative",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.3, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Cashflow (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

// --- transposed table infrastructure (shared by every table view) ------------
//
// Years as columns, line items as rows. Groups are visual bands; a
// numeric row hides when every visible year is zero (the transposed
// equivalent of Phase B's column hiding) unless marked `always`
// (subtotals/totals). The renderer and the CSV export consume the same
// group model, so the CSV always matches the visible cells.
//
// Row shape: { label, cell(y) → number, always?, cls?, text? (string
// cells, exempt from hiding + scaling) }.

function fmtLedgerCell(v) {
  if (Math.abs(v) < 0.005) return "–";
  const s = Math.round(Math.abs(v)).toLocaleString("en-AU");
  return v < 0 ? `(${s})` : s;
}

// Start/end are always the first/last column or chart edge already —
// annotating them again would just be noise, so table and chart
// annotation both skip them and only surface retirement/user dates.
const SKIP_LABEL_ANCHOR_IDS = new Set(["start", "end"]);

// The key date (built-in or user-defined) whose resolved plan year is
// y, preferring a user-defined label over a coincidental built-in
// match (Tier 1.1 table annotation).
function keyDateLabelForYear(y) {
  const matches = listAnchors(state.plan, projection.schedule)
    .filter((a) => a.planYear === y && !SKIP_LABEL_ANCHOR_IDS.has(a.id));
  if (matches.length === 0) return null;
  const user = matches.find((a) => !BUILT_IN_ANCHOR_IDS.has(a.id));
  return (user ?? matches[0]).label;
}

// Client age, primary; FY beneath; partner age a third line for
// couples (item D); a matching key date's label beneath that (Tier
// 1.1). One shared builder for the on-screen header and the
// plain-text CSV header.
function yearHeaderHTML(y) {
  const age = projection.schedule.clientAges[y];
  const fy = fyShortLabel(firstFyStartYear(state.plan.start) + y);
  const partnerAge = projection.schedule.partnerAges ? projection.schedule.partnerAges[y] : null;
  const kdLabel = keyDateLabelForYear(y);
  return `
    <span class="tl-age">${age}</span>
    <span class="tl-fy">${escapeHTML(fy)}</span>
    ${partnerAge != null ? `<span class="tl-partner-age">${partnerAge}</span>` : ""}
    ${kdLabel ? `<span class="tl-kd-label" title="${escapeHTML(kdLabel)}">${escapeHTML(kdLabel)}</span>` : ""}
  `;
}
function yearHeaderText(y) {
  const age = projection.schedule.clientAges[y];
  const fy = fyShortLabel(firstFyStartYear(state.plan.start) + y);
  const partnerAge = projection.schedule.partnerAges ? projection.schedule.partnerAges[y] : null;
  const kdLabel = keyDateLabelForYear(y);
  const base = partnerAge != null ? `${age} / ${partnerAge} (${fy})` : `${age} (${fy})`;
  return kdLabel ? `${base} — ${kdLabel}` : base;
}

// Filter groups down to the selected (thinned) period + visible rows.
// Hide-empty-rows (item F) is a toggle, default on; off shows the
// full row skeleton including all-zero rows.
function visibleTransposed(groups) {
  const yearIdxs = selectedYearIndices();
  const hideEmpty = state.display.hideEmptyRows !== false;
  const vGroups = groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter((r) =>
        !hideEmpty || r.always || r.text || yearIdxs.some((y) => Math.abs(r.cell(y)) >= 0.005)),
    }))
    .filter((g) => g.rows.length > 0);
  return { yearIdxs, vGroups };
}

function renderTransposed(mountEl, groups, footerHTML = "") {
  const { yearIdxs, vGroups } = visibleTransposed(groups);
  if (vGroups.length === 0) {
    mountEl.innerHTML = `<p class="helper-text" style="padding:24px 8px;">Nothing to show for this scenario — rows appear as soon as they have a nonzero year.</p>`;
    return;
  }
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const head = `<tr><th class="tl-corner"></th>${
    yearIdxs.map((y) => `<th class="tl-year"><span class="tl-year-stack">${yearHeaderHTML(y)}</span></th>`).join("")
  }</tr>`;
  const body = vGroups.map((g) => {
    const gh = g.title
      ? `<tr class="tl-group"><th colspan="${yearIdxs.length + 1}">${escapeHTML(g.title)}</th></tr>`
      : "";
    const rows = g.rows.map((r) => {
      const cells = yearIdxs.map((y) => {
        if (r.text) return `<td class="tl-num">${escapeHTML(String(r.cell(y)))}</td>`;
        if (r.pct) return `<td class="tl-num">${r.cell(y).toFixed(2)}%</td>`;
        return `<td class="tl-num"${r.cellAttrs ? r.cellAttrs(y) : ""}>${fmtLedgerCell(r.cell(y) * factor(y))}</td>`;
      }).join("");
      return `<tr class="${r.cls || ""}" ${r.rowAttrs || ""}><th class="tl-label">${escapeHTML(r.label)}</th>${cells}</tr>`;
    }).join("");
    return gh + rows;
  }).join("");
  mountEl.innerHTML = `
    <div class="tl-wrap">
      <table class="tl"><thead>${head}</thead><tbody>${body}</tbody></table>
    </div>
    ${footerHTML}
  `;
}

function exportTransposedCSV(viewName, groups) {
  const { yearIdxs, vGroups } = visibleTransposed(groups);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const esc = (s) => `"${String(s).replaceAll('"', '""')}"`;
  const lines = [
    ["Item", ...yearIdxs.map((y) => yearHeaderText(y))].map(esc).join(","),
  ];
  for (const g of vGroups) {
    if (g.title) lines.push(esc(g.title));
    for (const r of g.rows) {
      const cells = yearIdxs.map((y) => {
        if (r.text) return esc(String(r.cell(y)));
        if (r.pct) return esc(`${r.cell(y).toFixed(2)}%`);
        return (r.cell(y) * factor(y)).toFixed(2);
      });
      lines.push([esc(r.label), ...cells].join(","));
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${exportNameBase()}-${viewName}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const accruedCgtFooter = () => {
  const accrued = projection.accruedCgtAtEnd * displayFactor(projection.schedule.months);
  return accrued > 0.005
    ? `<div class="ledger-foot">CGT liability accrued at end of projection: ${fmtMoney(accrued)} (assessed on the final year's realised gains; payable after the projection ends).</div>`
    : "";
};

const accruedDiv293Footer = () => {
  const accrued = (projection.accruedDiv293AtEnd ?? 0) * displayFactor(projection.schedule.months);
  return accrued > 0.005
    ? `<div class="ledger-foot">Division 293 tax accrued at end of projection: ${fmtMoney(accrued)} (assessed on the final year's low-tax contributions; payable after the projection ends).</div>`
    : "";
};

// --- View: Cashflow -----------------------------------------------------------

// Shared by the Cashflow view's loan interest/principal rows and the
// Liabilities view/chart: a liability id is either a user-entered
// liability or a property-purchase-derived loan ("prop-<propertyId>").
function loanName(lid) {
  return (state.liabilities ?? []).find((l) => l.id === lid)?.name
    ?? ((state.properties ?? []).find((pr) => `prop-${pr.id}` === lid)
      ? `${(state.properties ?? []).find((pr) => `prop-${pr.id}` === lid).name} loan`
      : "Loan");
}

// Thin adapters over src/cashflowCategories.js's pure functions —
// main.js owns the DOM/Plotly-dependent rendering, cashflowCategories.js
// owns the (unit-tested) arithmetic. See that module's header comment
// for why the split exists.
function financialAssetIds() {
  return state.assets.filter((a) => a.class !== "lifestyle").map((a) => a.id);
}

// Salary-sacrifice cash for a year — the Cashflow table's own "Less:
// salary sacrifice" row uses this directly (its per-row Salary line
// reads rt.income, which is GROSS, unlike the engine's row.income).
function salarySacrificeCash(y) {
  return salarySacrificeCashPure(projection.yearly[y], state.plan.superAccounts);
}

// Super contributions the client actually pays for out of household
// cash — personal deductible/non-deductible, spouse (toConcessionalCap
// fills included). Salary sacrifice and SG are excluded (see
// cashflowCategories.js). Shared by the Cashflow table's expense row
// and the Cashflow bars chart's matching category — one formula, so
// they can never disagree.
function superContributionsCash(y) {
  return personalSuperContributionsCash(projection.yearly[y], state.plan.superAccounts);
}

// Income/expense category sums (Cashflow bars chart) — built from
// exactly the same fields the Cashflow table's rows read, so summing
// every category reproduces the table's Total income/Total expenses
// exactly (verified by a reconciliation check, now a committed unit
// test — see cashflowCategories.test.js).
function incomeCategorySums(y) {
  return incomeCategorySumsPure(
    projection.yearly[y], state.cashflows.income, projection.schedule.rowTotals.income,
    state.properties, projection.schedule.oneOffsByAssetYear, financialAssetIds(),
    state.plan.superAccounts, y
  );
}

function expenseCategorySums(y) {
  return expenseCategorySumsPure(
    projection.yearly[y], state.cashflows.expenses, projection.schedule.rowTotals.expenses,
    state.properties, projection.schedule.oneOffsByAssetYear, financialAssetIds(),
    state.plan.superAccounts, y
  );
}

// --- View: Key figures (fix batch 3, item 3) --------------------------------
//
// The screen that gets pasted into a file note — dense, unadorned, one
// flat list, every row always shown regardless of zero. Every value is
// read straight from the yearly ledger or the same category-sum
// functions the Cashflow table/chart already reconcile against — no
// new engine fields, and each row equals its source in the detailed
// views (Assets/Super/Liabilities/Cashflow) for every year.

function buildKeyFiguresGroups() {
  const yl = projection.yearly;
  const totalAssets = (y) => yl[y].closingBalance + yl[y].propertyClosing + yl[y].superClosing + yl[y].wcaClosing;
  const totalIncome = (y) => {
    const s = incomeCategorySums(y);
    return s.employment + s.rental + s.investment + s.wcaInterest + s.other;
  };
  const totalExpenses = (y) => {
    const s = expenseCategorySums(y);
    return s.living + s.investmentExpenses + s.loanInterest + s.loanPrincipal + s.tax + s.superContributions;
  };
  const rows = [
    { label: "Total assets", cell: totalAssets, always: true },
    { label: "Total liabilities", cell: (y) => -yl[y].liabilitiesClosing, always: true },
    { label: "NET ASSETS", cell: (y) => yl[y].netAssets, always: true, cls: "tl-total" },
    { label: "Total income", cell: totalIncome, always: true },
    { label: "Total expenses", cell: (y) => -totalExpenses(y), always: true },
    { label: "Total tax", cell: (y) => -yl[y].tax, always: true },
    { label: "Surplus / (deficit)", cell: (y) => yl[y].surplusOrDeficit, always: true, cls: "tl-total" },
    { label: "Super balance", cell: (y) => yl[y].superClosing, always: true },
    { label: "Working cash balance", cell: (y) => yl[y].wcaClosing, always: true },
  ];
  return [{ title: null, rows }];
}

function renderKeyFiguresView() {
  renderTransposed(els.keyFiguresTable, buildKeyFiguresGroups());
}

// Two input sections plus the resolution (Working Cash Account fix,
// Commit 2): every inflow lives in Income, every outflow in Expenses —
// Liabilities and One-off amounts as standalone sections are gone,
// their rows folded in by direction. Tax detail stays in the Tax
// view; this shows only the single Tax line. One-off amounts are
// asset-level transactions, not household cashflow — they never touch
// the Working Cash Account, so they show here for completeness but
// Surplus/(deficit) (the engine's own household-net figure) doesn't
// include them; in a year with a nonzero one-off, Total income minus
// Total expenses can differ from Surplus/(deficit) by that amount.
// Cashflow table: firm row vocabulary and category grouping. Row order
// and labels mirror the firm's own Cash Flow SOA spreadsheet exactly,
// so the output reads as familiar to advisers who've used the
// workbook for years. Every row's arithmetic lives in the pure,
// unit-tested src/cashflowStatement.js — this function only turns that
// data into the transposed-table row shape and handles the two display
// choices (individual items vs category totals; one-off amounts and
// Funding, which sit outside the firm's vocabulary but must still
// render somewhere).
//
// "Show individual items" (default off) expands a pure category total
// into one row per entered row of that category — the two combined
// derived+category rows (Interest Income, Dividend Income) always stay
// combined either way; expanding those specifically isn't supported
// (a disclosed simplification, not a bug).
function buildCashflowGroups() {
  const yl = projection.yearly;
  const rt = projection.schedule.rowTotals;
  const couple = isCouple();
  const included = state.assets.filter((a) => a.include);
  const editableAssets = included.filter((a) => a.class !== "lifestyle");
  const showIndividual = state.display.showIndividualCashflowItems === true;
  const properties = state.properties ?? [];
  const liabilities = state.liabilities ?? [];
  const superAccounts = state.plan.superAccounts ?? [];
  const incomeRows = state.cashflows.income;
  const expenseRows = state.cashflows.expenses;
  const deductionRows = state.cashflows.deductions ?? [];

  const stmt = (y) => cashflowStatement(yl[y], {
    incomeRows, rowTotalsIncome: rt.income,
    expenseRows, rowTotalsExpenses: rt.expenses,
    deductionRows, rowTotalsDeductions: rt.deductions,
    properties, liabilities, superAccounts, y,
  });

  const ownerLabel = (r) => couple ? `${r.label} (${r.owner === "partner" ? partnerName() : clientName()})` : r.label;
  // One row per category (collapsed default), or one row per
  // individually entered row of that category — same total either way.
  const catRow = (rows, rowTotals, category, label, aggregateCell) => {
    const matching = rows.filter((r) => r.category === category);
    if (!showIndividual || matching.length === 0) return [{ label, cell: aggregateCell }];
    return matching.map((r) => ({ label: ownerLabel(r), cell: (y) => rowTotals[r.id]?.[y] ?? 0 }));
  };

  // --- ASSESSABLE INCOME ------------------------------------------------
  const assessableRows = [
    ...catRow(incomeRows, rt.income, "salary", "Salary", (y) => stmt(y).assessable.salary),
    { label: "Taxable Pension Component", cell: (y) => stmt(y).assessable.taxablePensionComponent },
    ...catRow(incomeRows, rt.income, "otherIncome", "Other Income", (y) => stmt(y).assessable.otherIncome),
    { label: "Government/Centrelink payments", cell: (y) => stmt(y).assessable.governmentPayments },
    { label: "Interest Income", cell: (y) => stmt(y).assessable.interestIncome },
    { label: "Dividend Income", cell: (y) => stmt(y).assessable.dividendIncome },
    { label: "Franking Credits", cell: (y) => stmt(y).assessable.frankingCredits },
    { label: "Property Income – Gross Rent", cell: (y) => stmt(y).assessable.propertyIncomeGross },
    { label: "Trust Distribution", cell: (y) => stmt(y).assessable.trustDistribution },
    { label: "Foreign Income", cell: (y) => stmt(y).assessable.foreignIncome },
    { label: "Net Taxable Capital Gains", cell: (y) => stmt(y).assessable.netTaxableCapitalGains },
  ];
  assessableRows.push({ label: "Assessable Income", always: true, cls: "tl-total", cell: (y) => stmt(y).assessable.total });

  // --- DEDUCTIONS --------------------------------------------------------
  const deductionSectionRows = [
    { label: "Less: Investment Portfolio Interest", cell: (y) => -stmt(y).deductions.investmentPortfolioInterest },
    { label: "Property Interest Deductions", cell: (y) => -stmt(y).deductions.propertyInterestDeductions },
    { label: "Property Deductions", cell: (y) => -stmt(y).deductions.propertyDeductions },
    { label: "Property Depreciation", cell: (y) => -stmt(y).deductions.propertyDepreciation },
    ...catRow(deductionRows, rt.deductions, "vehicle", "Vehicle Deductions", (y) => stmt(y).deductions.vehicle).map(negate),
    ...catRow(deductionRows, rt.deductions, "socialClub", "Social Club (pre-tax)", (y) => stmt(y).deductions.socialClub).map(negate),
    ...catRow(deductionRows, rt.deductions, "insurance", "Deductible Insurance Premiums", (y) => stmt(y).deductions.insurance).map(negate),
    ...catRow(deductionRows, rt.deductions, "novatedLease", "Novated Lease pre-tax", (y) => stmt(y).deductions.novatedLease).map(negate),
    ...catRow(deductionRows, rt.deductions, "workingExpense", "Working Expense", (y) => stmt(y).deductions.workingExpense).map(negate),
    { label: "Salary sacrifice", cell: (y) => -stmt(y).deductions.salarySacrifice },
    { label: "Lump sum super contributions", cell: (y) => -stmt(y).deductions.lumpSumSuperContributions },
    ...catRow(deductionRows, rt.deductions, "salaryPackaging", "Salary Packaging (Living Expenses)", (y) => stmt(y).deductions.salaryPackaging).map(negate),
    ...catRow(deductionRows, rt.deductions, "other", "Other", (y) => stmt(y).deductions.other).map(negate),
  ];
  deductionSectionRows.push({ label: "Taxable Income", always: true, cls: "tl-total", cell: (y) => stmt(y).taxableIncome });

  // --- TAX -----------------------------------------------------------
  const taxSectionRows = [
    { label: "Income Tax", cell: (y) => -stmt(y).tax.incomeTax },
    { label: "Medicare Levy", cell: (y) => -stmt(y).tax.medicareLevy },
    { label: "Medicare Levy Surcharge", cell: (y) => -stmt(y).tax.medicareLevySurcharge },
    { label: "HELP Repayment", cell: (y) => -stmt(y).tax.helpRepayment },
    { label: "SAPTO", cell: (y) => -stmt(y).tax.sapto },
    { label: "LITO", cell: (y) => -stmt(y).tax.lito },
    { label: "Spouse Splitting Offset", cell: (y) => -stmt(y).tax.spouseSplittingOffset },
    { label: "Franking Credit Offset", cell: (y) => -stmt(y).tax.frankingCreditOffset },
    { label: "Taxable Pension Offset (TTR)", cell: (y) => -stmt(y).tax.taxablePensionOffset },
    { label: "Division 293", cell: (y) => -stmt(y).tax.div293 },
    { label: "Division 296", cell: (y) => -stmt(y).tax.div296 },
  ];
  taxSectionRows.push({ label: "Tax on Taxable Income", always: true, cls: "tl-total", cell: (y) => -stmt(y).tax.total });
  taxSectionRows.push({ label: "NET INCOME", always: true, cls: "tl-total", cell: (y) => stmt(y).netIncome });

  // --- CASH RECEIVED ---------------------------------------------------
  const cashReceivedRows = [
    { label: "Regular take home pay", cell: (y) => stmt(y).cashReceived.regularTakeHomePay },
    { label: "Anticipated tax return", cell: (y) => stmt(y).cashReceived.anticipatedTaxReturn },
    ...catRow(incomeRows, rt.income, "afterTaxBonus", "After tax bonus", (y) => stmt(y).cashReceived.afterTaxBonus),
    ...catRow(incomeRows, rt.income, "otherTaxFreeIncome", "Other tax free income", (y) => stmt(y).cashReceived.otherTaxFreeIncome),
  ];

  // --- EXPENSES ----------------------------------------------------------
  const expenseSectionRows = [
    { label: "Mortgage Repayments", cell: (y) => -stmt(y).expenses.mortgageRepayments },
    { label: "Other Loan Repayments (P&I)", cell: (y) => -stmt(y).expenses.otherLoanRepayments },
    ...catRow(expenseRows, rt.expenses, "nonDiscretionary", "Non-discretionary Living Expenses", (y) => stmt(y).expenses.nonDiscretionary).map(negate),
    ...catRow(expenseRows, rt.expenses, "discretionary", "Discretionary Living Expenses", (y) => stmt(y).expenses.discretionary).map(negate),
    ...catRow(expenseRows, rt.expenses, "groceryFuel", "Grocery & Fuel Expenses", (y) => stmt(y).expenses.groceryFuel).map(negate),
    ...catRow(expenseRows, rt.expenses, "holidays", "Holidays", (y) => stmt(y).expenses.holidays).map(negate),
    ...catRow(expenseRows, rt.expenses, "insurance", "New Insurance Premiums", (y) => stmt(y).expenses.insurance).map(negate),
    { label: "Investment Property expenses", cell: (y) => -stmt(y).expenses.investmentPropertyExpenses },
    ...catRow(expenseRows, rt.expenses, "homeMaintenance", "Home Maintenance expenses", (y) => stmt(y).expenses.homeMaintenance).map(negate),
    ...catRow(expenseRows, rt.expenses, "other", "Other", (y) => stmt(y).expenses.other).map(negate),
  ];
  expenseSectionRows.push({ label: "Total Expenses", always: true, cls: "tl-total", cell: (y) => -stmt(y).expenses.total });
  expenseSectionRows.push({ label: "SURPLUS INCOME", always: true, cls: "tl-total", cell: (y) => stmt(y).surplusIncome });

  // --- One-off amounts (asset-level events, outside the firm's row
  // vocabulary — kept as its own section so in-grid one-off editing
  // keeps working; never touches the Working Cash Account, so neither
  // NET INCOME nor SURPLUS INCOME above include it). ------------------
  const oneOffRows = [];
  for (const a of editableAssets) {
    oneOffRows.push({
      label: `${a.name} — one-off in`,
      cell: (y) => Math.max(0, projection.schedule.oneOffsByAssetYear[a.id]?.[y] ?? 0),
      always: true, cellAttrs: (y) => oneOffCellAttrs(a.id, y),
    });
    oneOffRows.push({
      label: `${a.name} — one-off out`,
      cell: (y) => Math.max(0, -(projection.schedule.oneOffsByAssetYear[a.id]?.[y] ?? 0)),
      always: true, cellAttrs: (y) => oneOffCellAttrs(a.id, y),
    });
  }
  for (const pr of properties.filter((x) => x.status === "planned")) {
    oneOffRows.push({ label: `${pr.name} settlement`, cell: (y) => -(yl[y].properties?.[pr.id]?.settlement ?? 0) });
  }

  const surplusTarget = state.settings.surplus.mode === "invest"
    ? state.assets.find((a) => a.id === state.settings.surplus.assetId)
    : null;

  const groups = [
    { title: "Assessable Income", rows: assessableRows },
    { title: "Deductions", rows: deductionSectionRows },
    { title: "Tax", rows: taxSectionRows },
    { title: "Cash Received", rows: cashReceivedRows },
    { title: "Expenses", rows: expenseSectionRows },
  ];
  if (oneOffRows.length) groups.push({ title: "One-off amounts", rows: oneOffRows });
  groups.push({ title: "Funding", rows: [
    { label: surplusTarget ? `Surplus invested (to ${surplusTarget.name})` : "Surplus invested",
      cell: (y) => yl[y].surplusInvested },
    { label: "Surplus swept to cash", cell: (y) => yl[y].surplusAccumulated },
    { label: "Surplus spent", cell: (y) => yl[y].surplusSpent },
    { label: "Deficit funded from assets", cell: (y) => -yl[y].deficitFundedFromAssets },
    { label: "Unfunded cashflow", cell: (y) => yl[y].unfundedCashflow },
  ] });
  return groups;
}

// catRow()'s expanded (individual-item) rows read POSITIVE row totals
// (the pure module's own convention); the Deductions/Expenses sections
// display everything as a negative outflow — negate() flips an
// already-built row's cell function without altering catRow itself
// (which is shared by Income, where rows stay positive).
function negate(r) {
  return { ...r, cell: (y) => -r.cell(y) };
}

// In-grid one-off editing (C2): each cell shows the NET of all
// one-offs for that asset+FY; editing manages the single table-sourced
// lump sum alongside any input-panel rows (marked with a dot).
function oneOffCellAttrs(assetId, y) {
  if (!canEditOneOffYear(state.plan, y)) {
    return ` data-ls-blocked="1" title="This partial first year starts after July, so its annual amounts are skipped (already made earlier in the FY) — a one-off here would have no effect."`;
  }
  const age = state.plan.client.currentAge + y;
  const hasInput = state.cashflows.lumpSums.some(
    (l) => l.source === "input" && l.assetId === assetId && l.age === age
  );
  return ` data-ls-asset="${assetId}" data-ls-y="${y}" tabindex="0"` +
    (hasInput ? ` data-ls-mixed="1" title="Includes amounts entered in the input panel — this cell edits only the table-sourced amount."` : "");
}

function startOneOffCellEdit(td) {
  const assetId = td.dataset.lsAsset;
  const y = Number(td.dataset.lsY);
  const age = state.plan.client.currentAge + y;
  const existing = tableLumpSumFor(state.cashflows.lumpSums, assetId, age);
  const current = existing
    ? (existing.direction === "out" ? -existing.amount : existing.amount)
    : "";
  td.innerHTML = `<input type="number" step="any" class="tl-cell-input" value="${current}"
                         aria-label="One-off amount (positive = inflow, negative = outflow, today's dollars)" />`;
  const input = td.querySelector("input");
  input.focus();
  input.select();
  let done = false;
  const finish = (apply) => {
    if (done) return;
    done = true;
    if (apply) {
      const v = input.value.trim() === "" ? 0 : Number(input.value);
      state.cashflows.lumpSums = upsertTableLumpSum(state.cashflows.lumpSums, assetId, age, v);
      saveState();
      renderCashflows(); // input panel's one-off list mirrors the grid
      refreshOutputs();  // re-renders the grid, removing the input
    } else {
      renderCashflowView();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

els.viewCashflow.addEventListener("click", (e) => {
  const td = e.target.closest("td[data-ls-asset]");
  if (!td || td.querySelector("input")) return;
  startOneOffCellEdit(td);
});
els.viewCashflow.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const td = e.target.closest?.("td[data-ls-asset]");
  if (!td || td.querySelector("input")) return;
  startOneOffCellEdit(td);
});

function renderCashflowView() {
  renderTransposed(els.viewCashflow, buildCashflowGroups(),
    accruedCgtFooter() + accruedDiv293Footer() + accruedDiv296Footer());
}

// --- View: Assets ---------------------------------------------------------------
//
// Entity selector (Consolidated | each asset) — the reusable pattern
// the future Super view repeats (consolidated | per fund).

function renderEntitySelector(mountEl, entities, active, onSelect) {
  mountEl.innerHTML = entities.map((e) => `
    <button class="seg-option${e.id === active ? " active" : ""}" type="button"
            role="tab" aria-selected="${e.id === active}" data-entity="${e.id}">${escapeHTML(e.label)}</button>
  `).join("");
  mountEl.onclick = (ev) => {
    const btn = ev.target.closest("[data-entity]");
    if (!btn || btn.dataset.entity === active) return;
    onSelect(btn.dataset.entity);
  };
}

function assetDetailRows(get) {
  return [
    { label: "Opening balance", cell: (y) => get(y).opening, always: true },
    { label: "Contributions", cell: (y) => get(y).contributions },
    { label: "Withdrawals", cell: (y) => -get(y).withdrawals },
    { label: "One-off amounts", cell: (y) => get(y).oneOffs },
    { label: "Deficit funding", cell: (y) => -get(y).deficitFunding },
    { label: "Surplus invested", cell: (y) => get(y).surplusInvested },
    { label: "Growth", cell: (y) => get(y).growth },
  ];
}

function buildAssetsGroups(entity) {
  const yl = projection.yearly;
  const included = state.assets.filter((a) => a.include);

  if (entity === "all") {
    const combined = assetDetailRows((y) => ({
      opening: yl[y].openingBalance,
      contributions: yl[y].contributions,
      withdrawals: yl[y].withdrawals,
      oneOffs: yl[y].oneOffsNet,
      deficitFunding: yl[y].deficitFundedFromAssets,
      surplusInvested: yl[y].surplusInvested,
      growth: yl[y].growth,
    }));
    // Unrealised gain (item G): market value − cost base pool, summed
    // only over CGT assets (a non-CGT asset's closing balance never
    // enters this row — costBasePool is null for it, not zero).
    combined.push({
      label: "Unrealised gain",
      cell: (y) => included.reduce((s, a) => {
        const d = yl[y].perAssetDetail[a.id];
        return d?.costBasePool != null ? s + (d.closing - d.costBasePool) : s;
      }, 0),
    });
    combined.push({ label: "Tax attributable", cell: (y) => -yl[y].tax });
    combined.push({ label: "Closing balance", cell: (y) => yl[y].closingBalance, always: true, cls: "tl-total" });
    const financial = included.filter((a) => a.class !== "lifestyle");
    const lifestyle = included.filter((a) => a.class === "lifestyle");
    const closingRow = (a) => ({ label: a.name, cell: (y) => yl[y].perAssetClosing[a.id] ?? 0 });
    const byAsset = financial.map(closingRow);
    byAsset.push({ label: "Total", cell: (y) => yl[y].closingBalance, always: true, cls: "tl-total" });
    const groups = [
      { title: "Combined", rows: combined },
      { title: "Closing balance by asset", rows: byAsset },
    ];
    if (lifestyle.length) {
      groups.splice(2, 0, { title: "Lifestyle assets", rows: lifestyle.map(closingRow) });
    }
    // Working Cash Account (engine correctness fix): always exists,
    // so always shown here — same reconciliation as the Cashflow
    // view's own WCA group.
    groups.push({
      title: "Working Cash Account",
      rows: [
        { label: "Opening balance", cell: (y) => yl[y].wcaDetail.opening, always: true },
        { label: "Interest", cell: (y) => yl[y].wcaDetail.interest },
        { label: "Net household cashflow", cell: (y) => yl[y].wcaDetail.netFlow },
        { label: "Closing balance", cell: (y) => yl[y].wcaClosing, always: true, cls: "tl-total" },
      ],
    });
    const propList = state.properties ?? [];
    if (propList.length) {
      groups.push({
        title: "Property",
        rows: [
          ...propList.map((pr) => ({
            label: pr.name,
            cell: (y) => yl[y].properties?.[pr.id]?.value ?? 0,
          })),
          { label: "Total property", cell: (y) => yl[y].propertyClosing, always: true, cls: "tl-total" },
        ],
      });
    }
    const liabs = state.liabilities ?? [];
    if (liabs.length || Object.keys(yl[0]?.liabilities ?? {}).length) {
      groups.push({
        title: "Liabilities",
        rows: [
          ...Object.keys(yl[0]?.liabilities ?? {}).map((lid) => ({
            label: liabs.find((l) => l.id === lid)?.name
              ?? (state.properties ?? []).find((pr) => `prop-${pr.id}` === lid)?.name?.concat(" loan")
              ?? "Loan",
            cell: (y) => -(yl[y].liabilities?.[lid]?.closing ?? 0),
          })),
          { label: "Total liabilities", cell: (y) => -yl[y].liabilitiesClosing, always: true, cls: "tl-total" },
        ],
      });
    }
    groups.push({
      title: null,
      rows: [{ label: "NET ASSETS", cell: (y) => yl[y].netAssets, always: true, cls: "tl-total" }],
    });
    return groups;
  }

  const zero = { opening: 0, contributions: 0, withdrawals: 0, oneOffs: 0, deficitFunding: 0, surplusInvested: 0, growth: 0, closing: 0, costBasePool: null };
  const name = included.find((a) => a.id === entity)?.name ?? "Asset";
  const rows = assetDetailRows((y) => yl[y].perAssetDetail[entity] ?? zero);
  // Unrealised gain (item G): zero (and auto-hidden under F) for a
  // non-CGT asset, whose costBasePool is null rather than 0.
  rows.push({
    label: "Unrealised gain",
    cell: (y) => {
      const d = yl[y].perAssetDetail[entity] ?? zero;
      return d.costBasePool != null ? d.closing - d.costBasePool : 0;
    },
  });
  rows.push({ label: "Closing balance", cell: (y) => (yl[y].perAssetDetail[entity] ?? zero).closing, always: true, cls: "tl-total" });
  return [{ title: name, rows }];
}

function renderAssetsView() {
  const included = state.assets.filter((a) => a.include);
  if (assetsEntity !== "all" && !included.some((a) => a.id === assetsEntity)) {
    assetsEntity = "all"; // entity was removed/excluded
  }
  renderEntitySelector(
    els.assetsEntity,
    [{ id: "all", label: "Consolidated" }, ...included.map((a) => ({ id: a.id, label: a.name }))],
    assetsEntity,
    (id) => { assetsEntity = id; renderAssetsView(); }
  );
  renderTransposed(els.assetsTable, buildAssetsGroups(assetsEntity));
}

// --- View: Super (Tier 1.2, Commit 4) ---------------------------------------

function superDetailRows(get) {
  return [
    { label: "Opening balance", cell: (y) => get(y).opening, always: true },
    { label: "SG contributions", cell: (y) => get(y).sg },
    { label: "Salary sacrifice", cell: (y) => get(y).salarySacrifice },
    { label: "Personal deductible", cell: (y) => get(y).personalDeductible },
    { label: "Non-concessional", cell: (y) => get(y).nonConcessional },
    { label: "Contributions tax", cell: (y) => -get(y).contributionsTax },
    { label: "Earnings", cell: (y) => get(y).earnings },
    { label: "Earnings tax", cell: (y) => -get(y).earningsTax },
    { label: "Withdrawals", cell: (y) => -get(y).withdrawals },
    // Division 293/296 release-from-super default: a direct balance
    // reduction, reported separately from an ordinary withdrawal since
    // it's not a benefit payment (not assessable, not preservation-
    // gated) — see the Division 293/296 release-from-super feature.
    { label: "Releases (Division 293/296)", cell: (y) => -get(y).release },
  ];
}

// Per-person cap/TSB rows, from the engine's superCapUsage +
// superDetail — never re-derives cap/carry-forward arithmetic here.
function superPersonGroup(p, title) {
  const yl = projection.yearly;
  const owned = (state.plan.superAccounts ?? []).filter((s) => s.owner === p).map((s) => s.id);
  return {
    title,
    rows: [
      {
        label: "Concessional cap used", always: true,
        cell: (y) => {
          const u = yl[y].superCapUsage?.[p];
          return u ? u.sg + u.salarySacrifice + u.personalDeductible : 0;
        },
      },
      {
        label: "Concessional cap available",
        cell: (y) => yl[y].superCapUsage?.[p]?.available ?? 0,
      },
      {
        label: "Carry-forward available",
        cell: (y) => yl[y].superCapUsage?.[p]?.carryForwardAvailable ?? 0,
      },
      {
        label: "Total super balance (TSB)", always: true, cls: "tl-total",
        cell: (y) => owned.reduce((s, id) => s + (yl[y].superDetail[id]?.closing ?? 0), 0),
      },
    ],
  };
}

function buildSuperGroups(entity) {
  const yl = projection.yearly;
  const included = (state.plan.superAccounts ?? []).filter((s) => s.include);

  const personGroups = [superPersonGroup("client", clientName())];
  if (isCouple()) personGroups.push(superPersonGroup("partner", partnerName()));

  if (entity === "all") {
    const zero = { opening: 0, sg: 0, salarySacrifice: 0, personalDeductible: 0, nonConcessional: 0, contributionsTax: 0, earnings: 0, earningsTax: 0, withdrawals: 0, release: 0, closing: 0 };
    const combined = superDetailRows((y) => included.reduce((s, a) => {
      const d = yl[y].superDetail[a.id] ?? zero;
      for (const k in s) s[k] += d[k] ?? 0;
      return s;
    }, { ...zero }));
    combined.push({
      label: "Closing balance", always: true, cls: "tl-total",
      cell: (y) => included.reduce((s, a) => s + (yl[y].superDetail[a.id]?.closing ?? 0), 0),
    });
    const closingRow = (a) => ({ label: a.name, cell: (y) => yl[y].superDetail[a.id]?.closing ?? 0 });
    const byAccount = included.map(closingRow);
    byAccount.push({ label: "Total", always: true, cls: "tl-total", cell: (y) => yl[y].superClosing });
    return [
      { title: "Combined", rows: combined },
      { title: "Closing balance by account", rows: byAccount },
      ...personGroups,
    ];
  }

  const zero = { opening: 0, sg: 0, salarySacrifice: 0, personalDeductible: 0, nonConcessional: 0, contributionsTax: 0, earnings: 0, earningsTax: 0, withdrawals: 0, release: 0, closing: 0, taxFreeClosing: 0 };
  const name = included.find((a) => a.id === entity)?.name ?? "Super account";
  const rows = superDetailRows((y) => yl[y].superDetail[entity] ?? zero);
  rows.push({ label: "Closing balance", cell: (y) => (yl[y].superDetail[entity] ?? zero).closing, always: true, cls: "tl-total" });
  rows.push({ label: "of which tax-free", cell: (y) => (yl[y].superDetail[entity] ?? zero).taxFreeClosing });
  return [{ title: name, rows }, ...personGroups];
}

function renderSuperTableView() {
  const included = (state.plan.superAccounts ?? []).filter((s) => s.include);
  if (superEntity !== "all" && !included.some((s) => s.id === superEntity)) {
    superEntity = "all"; // entity was removed/excluded
  }
  renderEntitySelector(
    els.superEntity,
    [{ id: "all", label: "Consolidated" }, ...included.map((s) => ({ id: s.id, label: s.name }))],
    superEntity,
    (id) => { superEntity = id; renderSuperTableView(); }
  );
  renderTransposed(els.superTable, buildSuperGroups(superEntity));
}

// --- View: Liabilities (fix batch, item 5) ----------------------------------

function liabilityDetailRows(get) {
  return [
    { label: "Opening balance", cell: (y) => get(y).opening, always: true },
    { label: "Drawdowns", cell: (y) => get(y).drawdown },
    { label: "Interest", cell: (y) => -get(y).interest },
    { label: "Principal repaid", cell: (y) => -get(y).principal },
    // Extra repayments are not modelled (v1 limitation, disclosed) —
    // always zero, so the all-zero-rows convention hides it rather
    // than needing a separate disclosure line here.
    { label: "Extra repayments", cell: () => 0 },
    { label: "Offset balance applied", cell: (y) => get(y).offsetApplied },
  ];
}

function liabilitiesPayoffFooter(liabIds) {
  if (liabIds.length === 0) return "";
  const lines = liabIds.map((lid) => `${escapeHTML(loanName(lid))}: paid off ${liabilityPayoffLabel(lid)}`);
  return `<div class="ledger-foot">${lines.join(" · ")}</div>`;
}

function buildLiabilitiesGroups(entity) {
  const yl = projection.yearly;
  const liabIds = Object.keys(yl[0]?.liabilities ?? {});
  const zero = { opening: 0, drawdown: 0, interest: 0, principal: 0, offsetApplied: 0, closing: 0 };

  if (entity === "all") {
    const combined = liabilityDetailRows((y) => liabIds.reduce((s, lid) => {
      const d = yl[y].liabilities[lid] ?? zero;
      for (const k in s) s[k] += d[k] ?? 0;
      return s;
    }, { ...zero }));
    combined.push({ label: "Closing balance", cell: (y) => yl[y].liabilitiesClosing, always: true, cls: "tl-total" });
    const closingRow = (lid) => ({ label: loanName(lid), cell: (y) => yl[y].liabilities[lid]?.closing ?? 0 });
    const byLoan = liabIds.map(closingRow);
    byLoan.push({ label: "Total", cell: (y) => yl[y].liabilitiesClosing, always: true, cls: "tl-total" });
    return [
      { title: "Combined", rows: combined },
      { title: "Closing balance by loan", rows: byLoan },
    ];
  }

  const name = loanName(entity);
  const rows = liabilityDetailRows((y) => yl[y].liabilities[entity] ?? zero);
  rows.push({ label: "Closing balance", cell: (y) => (yl[y].liabilities[entity] ?? zero).closing, always: true, cls: "tl-total" });
  return [{ title: name, rows }];
}

function renderLiabilitiesView() {
  const liabIds = Object.keys(projection.yearly[0]?.liabilities ?? {});
  if (liabilitiesEntity !== "all" && !liabIds.includes(liabilitiesEntity)) {
    liabilitiesEntity = "all"; // entity was removed/excluded
  }
  renderEntitySelector(
    els.liabilitiesEntity,
    [{ id: "all", label: "Consolidated" }, ...liabIds.map((lid) => ({ id: lid, label: loanName(lid) }))],
    liabilitiesEntity,
    (id) => { liabilitiesEntity = id; renderLiabilitiesView(); }
  );
  renderTransposed(els.liabilitiesTable, buildLiabilitiesGroups(liabilitiesEntity), liabilitiesPayoffFooter(liabIds));
}

// --- View: Tax (C4) -----------------------------------------------------------

function buildTaxGroups() {
  const yl = projection.yearly;
  const td = (y, p) => yl[y].taxDetail?.[p] ?? null;
  // Division 293/296 "paid from" indication (release-from-super
  // default): blank in a year nothing is payable; otherwise "Super",
  // "Cash" (the personal-cash election), or a flagged shortfall when
  // the super balance couldn't cover it in full.
  const divPaidFromText = (y, p) => {
    const d = td(y, p);
    const due = (d?.div293 ?? 0) + (d?.div296 ?? 0);
    if (due <= 0.005) return "";
    const released = d.divTaxReleasedFromSuper ?? 0;
    const fromCash = d.divTaxFromCash ?? 0;
    if (fromCash <= 0.005) return "Super (release authority)";
    if (released <= 0.005) return "Personal cash";
    return `Super, $${Math.round(fromCash).toLocaleString()} shortfall to cash`;
  };
  const personGroup = (p, title) => ({
    title,
    rows: [
      { label: "Taxable income", cell: (y) => td(y, p)?.taxableIncome ?? 0 },
      { label: "Gross tax", cell: (y) => -(td(y, p)?.grossTax ?? 0) },
      { label: "Medicare levy", cell: (y) => -(td(y, p)?.medicare ?? 0) },
      { label: "LITO", cell: (y) => td(y, p)?.lito ?? 0 },
      { label: "Franking credits", cell: (y) => td(y, p)?.frankingCredits ?? 0 },
      { label: "Excess concessional super contributions", cell: (y) => td(y, p)?.excessConcessionalContributions ?? 0 },
      { label: "Excess concessional contributions offset (15%)", cell: (y) => td(y, p)?.excessCcOffset ?? 0 },
      { label: "Net income tax", cell: (y) => -(td(y, p)?.incomeTax ?? 0), cls: "tl-total" },
      { label: "CGT payable", cell: (y) => -(td(y, p)?.cgt ?? 0) },
      { label: "Division 293 tax payable", cell: (y) => -(td(y, p)?.div293 ?? 0) },
      { label: "Division 296 tax payable", cell: (y) => -(td(y, p)?.div296 ?? 0) },
      { label: "Division 293/296 — paid from", text: true, cell: (y) => divPaidFromText(y, p) },
      { label: "Quarantined rental losses (carried)", cell: (y) => td(y, p)?.quarantinedLossCarry ?? 0 },
    ],
  });
  const groups = [personGroup("client", clientName())];
  if (isCouple()) groups.push(personGroup("partner", partnerName()));
  groups.push({
    title: "Household",
    rows: [
      { label: "Division 293 tax payable", cell: (y) => -yl[y].taxDetail.div293 },
      { label: "Division 296 tax payable", cell: (y) => -yl[y].taxDetail.div296 },
      { label: "Total tax", cell: (y) => -yl[y].tax, cls: "tl-total" },
    ],
  });
  return groups;
}

const accruedDiv296Footer = () => {
  const accrued = (projection.accruedDiv296AtEnd ?? 0) * displayFactor(projection.schedule.months);
  return accrued > 0.005
    ? `<div class="ledger-foot">Division 296 tax accrued at end of projection: ${fmtMoney(accrued)} (assessed on the final year's realised super earnings above $3m TSB; payable after the projection ends).</div>`
    : "";
};

function renderTaxView() {
  const note = `<p class="chart-note-inline">Income tax rows accrue in the year shown (spread through the year, PAYG-style). CGT, Division 293 and Division 296 payable show the year of <em>payment</em> — each is assessed in one year and paid the following July.</p>`;
  renderTransposed(els.viewTax, buildTaxGroups(), note + accruedCgtFooter() + accruedDiv293Footer() + accruedDiv296Footer());
}

// --- View: Assumptions (C4) -----------------------------------------------------
//
// The audit trail for "what assumptions did this projection use" —
// economic settings plus tax thresholds through time under the active
// bracket mode.

function buildAssumptionsGroups() {
  const included = state.assets.filter((a) => a.include);
  const cpi = state.assumptions.cpi;
  const mode = state.assumptions.bracketMode === "frozen" ? "frozen" : "indexed";
  const f0 = firstFyStartYear(state.plan.start);
  const thr = (nominal) => (y) => realThreshold(nominal, f0 + y, mode, cpi);

  const economic = [
    { label: "CPI (% p.a.)", cell: () => cpi * 100, pct: true, always: true },
    { label: "Wage index (AWOTE, % p.a. nominal)", cell: () => (state.assumptions.awote ?? 0.035) * 100, pct: true, always: true },
  ];
  for (const a of included) {
    const { incomeNominal, growthNominal } = assetReturnComponents(a);
    const gross = incomeNominal + growthNominal;
    const icrPct = a.class === "lifestyle" ? 0 : (a.icrPct ?? 0);
    const netReal = (1 + gross - icrPct / 100) / (1 + cpi) - 1;
    economic.push({ label: `${a.name} — gross return, nominal (% p.a.)`, cell: () => gross * 100, pct: true, always: true });
    if (icrPct > 0) economic.push({ label: `${a.name} — ICR (% p.a.)`, cell: () => icrPct, pct: true });
    economic.push({ label: `${a.name} — net real return (% p.a.)`, cell: () => netReal * 100, pct: true, always: true });
  }

  // Resident bracket floors are identical across the covered tables
  // (only the second bracket's RATE steps 16→15→14); the 30/37/45
  // thresholds are stable labels.
  const residentRows = [
    { label: "Tax-free threshold (to)", cell: thr(18200), always: true },
    { label: "30% bracket from", cell: thr(45000), always: true },
    { label: "37% bracket from", cell: thr(135000), always: true },
    { label: "45% bracket from", cell: thr(190000), always: true },
    { label: "Medicare levy shading-in from", cell: thr(LEG.medicareLowerSingle), always: true },
    { label: "Medicare full 2% levy from", cell: thr(LEG.medicareUpperSingle), always: true },
    { label: "LITO maximum offset", cell: thr(LITO.maxOffset), always: true },
    { label: "LITO taper begins", cell: thr(LITO.taper1Threshold), always: true },
    { label: "LITO cut-out", cell: thr(LITO.taper2Threshold + LITO.taper2Base / LITO.taper2Rate), always: true },
  ];

  const groups = [
    { title: "Economic", rows: economic },
    { title: "Tax settings (resident, per person)", rows: residentRows },
  ];

  const anyNonResident = [state.plan.client, state.plan.partner]
    .some((p) => p?.taxProfile?.residency === "nonResident");
  if (anyNonResident) {
    groups.push({
      title: "Tax settings (non-resident — 30% from the first dollar)",
      rows: [
        { label: "37% bracket from", cell: thr(135000), always: true },
        { label: "45% bracket from", cell: thr(190000), always: true },
      ],
    });
  }

  // Super thresholds (Super thresholds Commit 1): each figure indexes
  // on its own legislated basis and rounding step (superRates.js), so —
  // unlike the tax-bracket rows above — these are NOT flat under
  // "Indexed": the concessional/untaxed-plan caps and transfer balance
  // cap step up irregularly in real dollars as their own nominal
  // rounding thresholds are crossed.
  if ((state.plan.superAccounts ?? []).length) {
    const awote = state.assumptions.awote ?? 0.035;
    const sr = (y) => superRatesFor(f0 + y, mode, cpi, awote);
    groups.push({
      title: "Super thresholds",
      rows: [
        { label: "Concessional cap", cell: (y) => sr(y).concessionalCap, always: true },
        { label: "Non-concessional cap (= 4× concessional)", cell: (y) => sr(y).nonConcessionalCap, always: true },
        { label: "General transfer balance cap", cell: (y) => sr(y).generalTransferBalanceCap, always: true },
        { label: "Bring-forward threshold — full (3yr)", cell: (y) => sr(y).bringForwardTsbThresholds.full },
        { label: "Bring-forward threshold — 2yr", cell: (y) => sr(y).bringForwardTsbThresholds.two },
        { label: "Bring-forward threshold — nil bring-forward", cell: (y) => sr(y).bringForwardTsbThresholds.one },
        { label: "Carry-forward TSB gate (not indexed)", cell: (y) => sr(y).carryForwardTsbGate, always: true },
        { label: "SG maximum salary", cell: (y) => sr(y).sgMaximumSalary, always: true },
        { label: "Untaxed plan cap", cell: (y) => sr(y).untaxedPlanCap, always: true },
        { label: "Division 293 threshold (not indexed)", cell: (y) => sr(y).div293Threshold, always: true },
        { label: "Division 296 lower threshold ($3m)", cell: (y) => sr(y).div296LowerThreshold, always: true },
        { label: "Division 296 upper threshold ($10m)", cell: (y) => sr(y).div296UpperThreshold, always: true },
      ],
    });
  }
  return groups;
}

function renderAssumptionsView() {
  const caption = `<p class="chart-note-inline">Under “Indexed”, threshold rows are flat in today's dollars — that is what CPI-indexed tax settings mean. Under “No indexation” they shrink in real terms each year after FY2027–28 (bracket creep). Future dollars shows the nominal picture. The bracket mode is set in Parameters.</p>`;
  renderTransposed(els.viewAssumptions, buildAssumptionsGroups(), caption);
}

// --- exports -----------------------------------------------------------------

function exportNameBase() {
  const { client, scenario } = findActive(workspace);
  return sanitiseFilename(`${client?.name ?? "client"}-${scenario?.name ?? "scenario"}`);
}

function exportChartPNG(chartElId, viewName) {
  const el = $(chartElId);
  if (typeof Plotly === "undefined" || !el?.data) return;
  Plotly.toImage(el, { format: "png", width: 1280, height: 640 }).then((dataUrl) => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${exportNameBase()}-${viewName}.png`;
    a.click();
  });
}

els.exportBtn.addEventListener("click", () => {
  if (activeView === "projection") exportChartPNG("chart", "projection");
  else if (activeView === "composite") exportChartPNG("chartComposite", "composite");
  else if (activeView === "net-assets") exportChartPNG("chartNetAssets", "net-assets");
  else if (activeView === "asset-balances") exportChartPNG("chartAssetBalances", "asset-balances");
  else if (activeView === "super-balances") exportChartPNG("chartSuperBalances", "super-balances");
  else if (activeView === "liabilities-balances") exportChartPNG("chartLiabilitiesBalances", "liabilities-balances");
  else if (activeView === "cashflow-bars") exportChartPNG("chartCashflowBars", "cashflow-bars");
  else if (activeView === "monte-carlo") exportChartPNG("chartMonteCarlo", "monte-carlo");
  else if (activeView === "key-figures") exportTransposedCSV("key-figures", buildKeyFiguresGroups());
  else if (activeView === "cashflow") exportTransposedCSV("cashflow", buildCashflowGroups());
  else if (activeView === "assets") exportTransposedCSV("assets", buildAssetsGroups(assetsEntity));
  else if (activeView === "tax") exportTransposedCSV("tax", buildTaxGroups());
  else if (activeView === "super") exportTransposedCSV("super", buildSuperGroups(superEntity));
  else if (activeView === "liabilities") exportTransposedCSV("liabilities", buildLiabilitiesGroups(liabilitiesEntity));
  else if (activeView === "monte-carlo-table") exportMonteCarloCSV();
  else if (activeView === "assumptions") exportTransposedCSV("assumptions", buildAssumptionsGroups());
});

els.showAssetsToggle.addEventListener("change", () => {
  showAssets = els.showAssetsToggle.checked;
  renderProjectionChart();
});

// --- summary strip ------------------------------------------------------

// Slim bar (D1): outputs only — the input-echo tiles are gone.
function renderSummaryStrip() {
  const months = projection.schedule.months;
  const endBalance = projection.monthly.combined[months] * displayFactor(months);
  const shortfall = projection.shortfall;
  els.summaryStrip.innerHTML = `
    <div class="stat">
      <div class="stat-label">Projected end balance</div>
      <div class="stat-value">${fmtMoney(endBalance)}</div>
    </div>
    ${shortfall ? `
      <div class="stat stat-headline">
        <div class="stat-label">First shortfall</div>
        <div class="stat-value">Age ${shortfall.clientAge} (${shortfall.fyLabel})</div>
      </div>
    ` : ""}
    ${projection.accruedCgtAtEnd > 0.005 ? `
      <div class="stat">
        <div class="stat-label">CGT accrued at end</div>
        <div class="stat-value">${fmtMoney(projection.accruedCgtAtEnd * displayFactor(months))}</div>
      </div>
    ` : ""}
  `;
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
    refreshOutputs(); // re-render chart/table/strip in the selected units
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
        <td>${impliedFrankingPct(p.classWeights, p.incomeReturn).toFixed(1)}%</td>
      </tr>
    `
  ).join("");
}

function openModal(scrollToId = null) {
  els.paramsModal.showModal();
  renderBellCurves("bellCurves", PROFILES, state.assumptions.cpi);
  if (scrollToId) {
    // Deferred a frame: `<dialog>` is display:none until showModal()
    // promotes it to the top layer, and scrollIntoView computed against
    // that not-yet-painted geometry silently no-ops. First real caller
    // of this branch — the Monte Carlo view's volatility-drag link — is
    // what surfaced this; it was previously dead code.
    requestAnimationFrame(() => {
      const target = els.paramsModal.querySelector(`#${scrollToId}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

els.paramsBtn.addEventListener("click", () => openModal());
els.paramsModal.querySelector(".modal-close").addEventListener("click", () => els.paramsModal.close());
els.paramsModal.addEventListener("click", (e) => {
  if (e.target === els.paramsModal) els.paramsModal.close();
});

// Bracket-mode toggle (Parameters modal): indexed real-constant vs
// frozen-nominal thresholds. Scenario-level assumption, like CPI.
const bracketModeInputs = document.querySelectorAll('input[name="bracketMode"]');
function syncBracketModeInputs() {
  bracketModeInputs.forEach((r) => { r.checked = r.value === state.assumptions.bracketMode; });
}
bracketModeInputs.forEach((r) => {
  r.addEventListener("change", () => {
    if (!r.checked) return;
    state.assumptions.bracketMode = r.value === "frozen" ? "frozen" : "indexed";
    saveState();
    refreshOutputs();
  });
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
  refreshOutputs(); // real returns derive from CPI via Fisher
});

const mortgageRateInput = $("mortgageRateInput");
mortgageRateInput.addEventListener("change", () => {
  const n = Number(mortgageRateInput.value);
  if (!Number.isFinite(n) || n < 0 || n > 30) {
    mortgageRateInput.value = ((state.assumptions.mortgageRate ?? 0.06) * 100).toFixed(2);
    return;
  }
  state.assumptions.mortgageRate = n / 100;
  saveState();
  refreshOutputs();
  renderProperties(); // planned-purchase helper lines re-derive
});

const awoteInput = $("awoteInput");
awoteInput.addEventListener("change", () => {
  const n = Number(awoteInput.value);
  if (!Number.isFinite(n) || n < 0 || n > 20) {
    awoteInput.value = ((state.assumptions.awote ?? 0.035) * 100).toFixed(1);
    return;
  }
  state.assumptions.awote = n / 100;
  saveState();
  refreshOutputs(); // wage-indexed rows re-derive
});

// --- boot -----------------------------------------------------------------

// Full workspace render — only ever called with the workspace mounted.
function renderAll() {
  // Setup's Key Dates block (and every date-ref select) needs a
  // resolved schedule, so the projection must exist before the plan
  // bar renders — refreshOutputs() recomputes it again below, which is
  // cheap (the engine is sub-millisecond at this size).
  recomputeProjection();
  renderPlanBar();
  renderAssets();
  renderCashflows();
  renderSettings();
  refreshOutputs();
  renderLiabilities(); // after refreshOutputs — payoff FYs read the projection
  renderProperties();
  renderSuper(); // after refreshOutputs — the cap-headroom display reads the projection
}

window.addEventListener("hashchange", handleRoute);

// Boot: an explicit valid deep link wins; an empty hash restores the
// last active scenario; anything invalid lands on Clients.
const bootRoute = initialRoute(location.hash, workspace);
if (location.hash !== formatRoute(bootRoute)) {
  location.replace(formatRoute(bootRoute)); // also fires hashchange
}
handleRoute();

if (LEGACY_INSIGHTS_ENABLED) {
  // Placeholder: insights phase re-mounts firstDecade, drawdownTolerance,
  // tornado, and sequenceRisk here as collapsed accordions.
}
