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
  planSummaryText, allocationSummary, ALLOC_PCT_MAX,
  tableLumpSumFor, upsertTableLumpSum, canEditOneOffYear,
  personDisplayName, resolveEndBasis,
} from "./planState.js";
import { renderBellCurves } from "./chart.js";
import { projectPlan, assetReturnComponents } from "./deterministic.js";
import { nominalFactor, firstFyStartYear } from "./schedule.js";
import { realThreshold, LITO } from "./Tax/annual.js";
import { LEG } from "./Tax/engine.js";
import {
  createIndex, normaliseIndex, findActive, findClient,
  newClient, renameClient, deleteClient, switchClient,
  newScenario, duplicateScenario, renameScenario, deleteScenario,
  switchScenario, touchScenario,
  exportClientFile, exportScenarioFile, importFile,
} from "./workspace.js";
import { formatRoute, resolveRoute, initialRoute } from "./router.js";

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
  addAssetBtn: $("addAssetBtn"),
  incomeSection: $("incomeSection"),
  expensesSection: $("expensesSection"),
  investSection: $("investSection"),
  settingsPanel: $("settingsPanel"),
  summaryStrip: $("summaryStrip"),
  chartNote: document.querySelector('[data-role="chartNote"]'),
  displayOptions: document.querySelectorAll(".display-option"),
  viewRail: $("viewRail"),
  exportBtn: $("exportBtn"),
  viewProjection: $("viewProjection"),
  viewCashflow: $("viewCashflow"),
  viewAssets: $("viewAssets"),
  viewTax: $("viewTax"),
  viewAssumptions: $("viewAssumptions"),
  assetsEntity: $("assetsEntity"),
  assetsTable: $("assetsTable"),
  showAssetsToggle: $("showAssetsToggle"),
  shortfallNote: $("shortfallNote"),
  periodFrom: $("periodFrom"),
  periodTo: $("periodTo"),
  periodPresets: document.querySelectorAll(".period-presets [data-preset]"),
  paramsBtn: $("paramsBtn"),
  paramsModal: $("paramsModal"),
  paramAssetTable: $("paramAssetTable"),
  inflationInput: $("inflationInput"),
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
// touches its updatedAt in the index.
function saveState() {
  writeRaw(scenarioKey(workspace.activeScenarioId), serialize(state));
  workspace = touchScenario(workspace, workspace.activeScenarioId, Date.now());
  saveWorkspace();
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

function handleRoute() {
  const route = resolveRoute(location.hash, workspace);
  if (!route) { location.replace("#/clients"); return; } // invalid ids → Clients
  currentRoute = route;
  if (route.page !== "workspace" && mountedScenarioId) unmountWorkspace();
  showPage(route.page);
  if (route.page === "clients") renderClientsPage();
  else if (route.page === "client") renderClientPage(route.clientId);
  else if (mountedScenarioId !== route.scenarioId) mountWorkspace(route.clientId, route.scenarioId);
}

function mountWorkspace(clientId, scenarioId) {
  workspace = switchScenario(workspace, clientId, scenarioId);
  saveWorkspace();
  state = loadActiveState();
  resetRuntimeUiState();
  mountedScenarioId = scenarioId;
  renderWorkspaceBreadcrumb();
  renderAll();
  applyUnitsLabel();
  populateParamsTable();
  els.inflationInput.value = (state.assumptions.cpi * 100).toFixed(1);
  awoteInput.value = ((state.assumptions.awote ?? 0.035) * 100).toFixed(1);
  syncBracketModeInputs();
}

// Empty every dynamic mount so the list pages do not sit on top of a
// live workspace DOM. The static skeleton and its listeners stay; the
// content goes.
function unmountWorkspace() {
  if (typeof Plotly !== "undefined") { try { Plotly.purge($("chart")); } catch { /* fine */ } }
  $("chart").innerHTML = "";
  for (const el of [els.planBar, els.incomeSection, els.expensesSection, els.assets,
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
  renderBreadcrumb([
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
  ]);
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

function personBlockHTML(prefix, person, title) {
  const tp = person.taxProfile;
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
          <label>Opening carry-forward capital losses ($)</label>
          <input type="number" min="0" step="1000" value="${tp.openingCapitalLosses}"
                 data-plan-field="${prefix}OpeningLosses" />
        </div>
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
          <input type="number" min="19" max="120" step="1" value="${p.endBasis.fixedAge}"
                 data-plan-field="endFixedAge" aria-label="Fixed end age" />` : ""}
        ${p.endBasis.mode === "fixedYears" ? `
          <input type="number" min="1" max="100" step="1" value="${p.endBasis.fixedYears}"
                 data-plan-field="endFixedYears" aria-label="Fixed number of years" />` : ""}
      </div>
    </div>
    <div class="plan-derived">${endResolutionText(p)} · ${planSummaryText(p)}</div>
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

els.planBar.addEventListener("change", (e) => {
  const field = e.target.dataset.planField;
  if (!field) return;
  const p = state.plan;
  const person = (prefix, cur) => ({
    firstName: field === `${prefix}FirstName` ? e.target.value : cur.firstName,
    surname: field === `${prefix}Surname` ? e.target.value : cur.surname,
    dob: field === `${prefix}Dob` ? e.target.value : cur.dob,
    sex: field === `${prefix}Sex` ? e.target.value : cur.sex,
    currentAge: cur.currentAge, // fallback if the new DOB is invalid
    taxProfile: {
      residency: field === `${prefix}Residency` ? e.target.value : cur.taxProfile.residency,
      medicareExempt: field === `${prefix}Medicare` ? e.target.value === "exempt" : cur.taxProfile.medicareExempt,
      centrelinkEligible: field === `${prefix}Centrelink` ? e.target.checked : cur.taxProfile.centrelinkEligible,
      openingCapitalLosses: field === `${prefix}OpeningLosses` ? e.target.value : cur.taxProfile.openingCapitalLosses,
    },
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
  };
  state.plan = clampPlan(next);
  state = clampAllToPlan(state);
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
    });
  } else {
    // Couple → single: never orphan an owner.
    if (wasCouple) {
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
            <option value="client"${r.owner === "client" ? " selected" : ""}>${escapeHTML(clientName())}</option>
            <option value="partner"${r.owner === "partner" ? " selected" : ""}>${escapeHTML(partnerName())}</option>
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
      ${indexationCellsHTML("income", r)}
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
      ${indexationCellsHTML("expenses", r)}
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
      ${indexationCellsHTML(kind, cf)}
      <button class="cf-remove" type="button" aria-label="Remove row"
              data-action="remove-row" data-kind="${kind}" data-cfid="${cf.id}">×</button>
    </div>
  `;
}

// Per-row indexation controls (D1): basis + additional %, with the
// computed nominal total shown live ("CPI 2.5% + 1% = 3.5%").
function indexationCellsHTML(kind, row) {
  const basis = row.indexBasis ?? (row.indexed === false ? "none" : "cpi");
  const extra = row.indexExtraPct ?? 0;
  const basisRate = basis === "awote"
    ? (state.assumptions.awote ?? 0.035)
    : basis === "cpi" ? state.assumptions.cpi : 0;
  const pct = (v) => `${(v).toFixed(1).replace(/\.0$/, "")}%`;
  const basisLabel = basis === "awote" ? "AWOTE" : basis === "cpi" ? "CPI" : "None";
  const total = extra === 0 && basis === "none"
    ? "Fixed nominal"
    : `${basisLabel} ${pct(basisRate * 100)}${extra ? ` + ${pct(extra)}` : ""} = ${pct(basisRate * 100 + extra)}`;
  return `
      <div class="cf-cell">
        <label>Index basis</label>
        <select data-kind="${kind}" data-cfid="${row.id}" data-field="indexBasis">
          <option value="none"${basis === "none" ? " selected" : ""}>None</option>
          <option value="cpi"${basis === "cpi" ? " selected" : ""}>CPI</option>
          <option value="awote"${basis === "awote" ? " selected" : ""}>Wage index (AWOTE)</option>
        </select>
      </div>
      <div class="cf-cell cf-index-extra">
        <label>Additional %</label>
        <input type="number" min="-10" max="10" step="0.1" value="${extra}"
               data-kind="${kind}" data-cfid="${row.id}" data-field="indexExtraPct" />
        <span class="index-total">${total}</span>
      </div>`;
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
    case "indexBasis": {
      row.indexBasis = ["none", "cpi", "awote"].includes(el.value) ? el.value : "cpi";
      delete row.indexed;
      const rowEl = el.closest(".cf-row");
      if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); // refresh the computed total
      break;
    }
    case "indexExtraPct": {
      row.indexExtraPct = clampNumber(el.value, -10, 10);
      if (commit) {
        el.value = row.indexExtraPct;
        const rowEl = el.closest(".cf-row");
        if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row);
      }
      break;
    }
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

function rowHTMLFor(kind, row) {
  if (kind === "income") return incomeRowHTML(row);
  if (kind === "expenses") return expenseRowHTML(row);
  if (kind === "lumpSums") return lumpSumRowHTML(row);
  return contributionRowHTML(kind, row);
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
      refreshOutputs();
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
    refreshOutputs();
  } else if (action === "remove-row") {
    if (cf[kind]) cf[kind] = cf[kind].filter((r) => r.id !== cfid);
    saveState();
    renderCashflows();
    refreshOutputs();
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

// --- projection outputs (Phase B) -----------------------------------------
//
// The engine is sub-millisecond at this size: recompute live on every
// mutation, no worker, no debounce. The engine emits REAL values only;
// nominal is applied here at render time (convention 12).

let projection = null;
let activeView = "projection";
let showAssets = false;
let assetsEntity = "all"; // Assets view entity selector: "all" | assetId

function recomputeProjection() {
  projection = projectPlan(state);
}

// One entry point after any mutation: recompute + refresh everything
// that displays engine output.
function refreshOutputs() {
  recomputeProjection();
  renderPeriodSelector();
  renderSummaryStrip();
  renderActiveView();
}

const VIEW_MOUNTS = {
  projection: () => els.viewProjection,
  cashflow: () => els.viewCashflow,
  assets: () => els.viewAssets,
  tax: () => els.viewTax,
  assumptions: () => els.viewAssumptions,
};

function renderActiveView() {
  for (const [name, mount] of Object.entries(VIEW_MOUNTS)) {
    mount().hidden = name !== activeView;
  }
  els.exportBtn.textContent = activeView === "projection" ? "Export PNG" : "Export CSV";
  for (const btn of els.viewRail.querySelectorAll("[data-view]")) {
    btn.classList.toggle("active", btn.dataset.view === activeView);
  }
  if (activeView === "projection") renderProjectionChart();
  else if (activeView === "cashflow") renderCashflowView();
  else if (activeView === "assets") renderAssetsView();
  else if (activeView === "tax") renderTaxView();
  else if (activeView === "assumptions") renderAssumptionsView();
}

els.viewRail.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (!btn || btn.disabled || btn.dataset.view === activeView) return;
  activeView = btn.dataset.view;
  renderActiveView();
});

const isNominal = () => state.display.units === "nominal";
const displayFactor = (m) => (isNominal() ? nominalFactor(m, state.assumptions.cpi) : 1);

// Month index at the END of plan year y (cumulative months elapsed).
function endMonthOfYear(y) {
  return projection.schedule.monthsInFirstYear + 12 * y;
}

// Month index at the START of plan year y.
function startMonthOfYear(y) {
  return y === 0 ? 0 : projection.schedule.monthsInFirstYear + 12 * (y - 1);
}

// --- report period (display state, persisted per scenario) -------------------

const fyShortLabel = (fyStart) =>
  `FY${String(fyStart % 100).padStart(2, "0")}–${String((fyStart + 1) % 100).padStart(2, "0")}`;

// Resolve the persisted {from, to} FY start years into clamped plan
// year indices [a, b].
function periodYears() {
  const years = projection.schedule.planYears;
  const f0 = firstFyStartYear(state.plan.start);
  const rp = state.display.reportPeriod || { from: null, to: null };
  let a = rp.from != null ? rp.from - f0 : 0;
  let b = rp.to != null ? rp.to - f0 : years - 1;
  a = Math.max(0, Math.min(years - 1, a));
  b = Math.max(a, Math.min(years - 1, b));
  return { a, b };
}

function renderPeriodSelector() {
  const years = projection.schedule.planYears;
  const f0 = firstFyStartYear(state.plan.start);
  const { a, b } = periodYears();
  const options = (sel) => {
    let html = "";
    for (let y = 0; y < years; y++) {
      html += `<option value="${f0 + y}">${fyShortLabel(f0 + y)}</option>`;
    }
    sel.innerHTML = html;
  };
  options(els.periodFrom);
  options(els.periodTo);
  els.periodFrom.value = String(f0 + a);
  els.periodTo.value = String(f0 + b);
  const isAll = a === 0 && b === years - 1;
  els.periodPresets.forEach((btn) => {
    const p = btn.dataset.preset;
    const active =
      (p === "all" && isAll) ||
      (p !== "all" && a === 0 && b === Math.min(years - 1, Number(p) - 1) && !isAll);
    btn.classList.toggle("active", active);
  });
}

function setReportPeriod(from, to) {
  state.display.reportPeriod = { from, to };
  saveState();
  renderPeriodSelector();
  renderActiveView();
}

els.periodFrom.addEventListener("change", () => {
  const from = Number(els.periodFrom.value);
  const to = Math.max(from, Number(els.periodTo.value));
  setReportPeriod(from, to);
});
els.periodTo.addEventListener("change", () => {
  const to = Number(els.periodTo.value);
  const from = Math.min(to, Number(els.periodFrom.value));
  setReportPeriod(from, to);
});
els.periodPresets.forEach((btn) => {
  btn.addEventListener("click", () => {
    const p = btn.dataset.preset;
    if (p === "all") setReportPeriod(null, null);
    else setReportPeriod(null, firstFyStartYear(state.plan.start) + Number(p) - 1);
  });
});

// --- View 1: projection chart -----------------------------------------------

function renderProjectionChart() {
  const el = $("chart");
  if (typeof Plotly === "undefined") {
    el.innerHTML = `<p class="helper-text" style="text-align:center;padding:40px 0;">Chart unavailable (Plotly failed to load). The ledger view and autosave still work.</p>`;
    els.shortfallNote.hidden = true;
    return;
  }
  const { schedule, monthly, shortfall } = projection;
  const months = schedule.months;
  const x = Array.from({ length: months + 1 }, (_, i) => i);
  const custom = x.map((i) => {
    const y = i === 0 ? 0 : schedule.yearOfMonth[i - 1];
    return [schedule.fyLabels[y], schedule.clientAges[y]];
  });
  const scaleSeries = (arr) => Array.from(arr, (v, i) => v * displayFactor(i));

  const traces = [{
    x, y: scaleSeries(monthly.combined), customdata: custom,
    mode: "lines", type: "scatter",
    name: "Combined",
    line: { color: "rgb(28, 90, 180)", width: 2.5 },
    hovertemplate: "%{customdata[0]} · age %{customdata[1]}<br><b>%{y:$,.0f}</b><extra>Combined</extra>",
  }];

  if (showAssets) {
    const palette = ["#6b8e23", "#dc5a28", "#5e60ce", "#2e8a8a", "#b5179e", "#d97b2f", "#9a031e", "#3a86c9"];
    let i = 0;
    for (const a of state.assets.filter((x) => x.include)) {
      const series = monthly.perAsset[a.id];
      if (!series) continue;
      traces.push({
        x, y: scaleSeries(series), customdata: custom,
        mode: "lines", type: "scatter",
        name: a.name,
        line: { color: palette[i++ % palette.length], width: 1.5 },
        hovertemplate: `%{customdata[0]} · age %{customdata[1]}<br>%{y:$,.0f}<extra>${escapeHTML(a.name)}</extra>`,
      });
    }
  }

  // FY tick labels at plan-year starts within the report period,
  // thinned to ~10.
  const { a: perA, b: perB } = periodYears();
  const step = Math.max(1, Math.ceil((perB - perA + 1) / 10));
  const tickvals = [], ticktext = [];
  for (let y = perA; y <= perB; y += step) {
    tickvals.push(startMonthOfYear(y));
    ticktext.push(schedule.fyLabels[y]);
  }

  const shapes = [];
  const annotations = [];
  if (shortfall) {
    const sx = shortfall.firstMonth + 1;
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
    xaxis: {
      tickmode: "array", tickvals, ticktext, showgrid: false, zeroline: false,
      range: [startMonthOfYear(perA), endMonthOfYear(perB)],
    },
    yaxis: {
      title: { text: `Balance (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    shapes, annotations,
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

// Filter groups down to the visible period + visible rows.
function visibleTransposed(groups) {
  const { a, b } = periodYears();
  const yearIdxs = [];
  for (let y = a; y <= b; y++) yearIdxs.push(y);
  const vGroups = groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter((r) =>
        r.always || r.text || yearIdxs.some((y) => Math.abs(r.cell(y)) >= 0.005)),
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
    yearIdxs.map((y) => `<th class="tl-year">${fyShortLabel(firstFyStartYear(state.plan.start) + y)}</th>`).join("")
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
  const f0 = firstFyStartYear(state.plan.start);
  const lines = [
    ["Item", ...yearIdxs.map((y) => fyShortLabel(f0 + y))].map(esc).join(","),
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

// --- View: Cashflow -----------------------------------------------------------

function buildCashflowGroups() {
  const yl = projection.yearly;
  const rt = projection.schedule.rowTotals;
  const couple = isCouple();
  const included = state.assets.filter((a) => a.include);

  const incomeRows = state.cashflows.income.map((rw) => ({
    label: couple
      ? `${rw.label} (${rw.owner === "partner" ? partnerName() : clientName()})`
      : rw.label,
    cell: (y) => rt.income[rw.id]?.[y] ?? 0,
  }));
  incomeRows.push({ label: "Distributions paid as cash", cell: (y) => yl[y].cashDistributions });
  incomeRows.push({ label: "Total income", cell: (y) => yl[y].income, always: true, cls: "tl-total" });

  const expenseRows = state.cashflows.expenses.map((rw) => ({
    label: rw.label,
    cell: (y) => -(rt.expenses[rw.id]?.[y] ?? 0),
  }));
  expenseRows.push({ label: "Total expenses", cell: (y) => -yl[y].expenses, always: true, cls: "tl-total" });

  const surplusTarget = state.settings.surplus.mode === "invest"
    ? state.assets.find((a) => a.id === state.settings.surplus.assetId)
    : null;

  return [
    { title: "Income", rows: incomeRows },
    { title: "Expenses", rows: expenseRows },
    { title: null, rows: [
      { label: "Tax", cell: (y) => -yl[y].tax },
      { label: "Surplus / (deficit)", cell: (y) => yl[y].surplusOrDeficit, always: true, cls: "tl-total" },
    ] },
    { title: "Funding", rows: [
      { label: surplusTarget ? `Surplus invested (to ${surplusTarget.name})` : "Surplus invested",
        cell: (y) => yl[y].surplusInvested },
      { label: "Deficit funded from assets", cell: (y) => -yl[y].deficitFundedFromAssets },
      { label: "Unfunded cashflow", cell: (y) => yl[y].unfundedCashflow },
    ] },
    { title: "One-off amounts", rows: included.map((a) => ({
      label: a.name,
      cell: (y) => projection.schedule.oneOffsByAssetYear[a.id]?.[y] ?? 0,
      always: true, // editable grid — keep every cell present
      cellAttrs: (y) => oneOffCellAttrs(a.id, y),
    })) },
  ];
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
  renderTransposed(els.viewCashflow, buildCashflowGroups(), accruedCgtFooter());
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
    combined.push({ label: "Tax attributable", cell: (y) => -yl[y].tax });
    combined.push({ label: "Closing balance", cell: (y) => yl[y].closingBalance, always: true, cls: "tl-total" });
    const byAsset = included.map((a) => ({
      label: a.name,
      cell: (y) => yl[y].perAssetClosing[a.id] ?? 0,
    }));
    byAsset.push({ label: "Total", cell: (y) => yl[y].closingBalance, always: true, cls: "tl-total" });
    return [
      { title: "Combined", rows: combined },
      { title: "Closing balance by asset", rows: byAsset },
    ];
  }

  const zero = { opening: 0, contributions: 0, withdrawals: 0, oneOffs: 0, deficitFunding: 0, surplusInvested: 0, growth: 0, closing: 0 };
  const name = included.find((a) => a.id === entity)?.name ?? "Asset";
  const rows = assetDetailRows((y) => yl[y].perAssetDetail[entity] ?? zero);
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

// --- View: Tax (C4) -----------------------------------------------------------

function buildTaxGroups() {
  const yl = projection.yearly;
  const td = (y, p) => yl[y].taxDetail?.[p] ?? null;
  const personGroup = (p, title) => ({
    title,
    rows: [
      { label: "Taxable income", cell: (y) => td(y, p)?.taxableIncome ?? 0 },
      { label: "Gross tax", cell: (y) => -(td(y, p)?.grossTax ?? 0) },
      { label: "Medicare levy", cell: (y) => -(td(y, p)?.medicare ?? 0) },
      { label: "LITO", cell: (y) => td(y, p)?.lito ?? 0 },
      { label: "Franking credits", cell: (y) => td(y, p)?.frankingCredits ?? 0 },
      { label: "Net income tax", cell: (y) => -(td(y, p)?.incomeTax ?? 0), cls: "tl-total" },
      { label: "CGT payable", cell: (y) => -(td(y, p)?.cgt ?? 0) },
    ],
  });
  const groups = [personGroup("client", clientName())];
  if (isCouple()) groups.push(personGroup("partner", partnerName()));
  groups.push({
    title: "Household",
    rows: [{ label: "Total tax", cell: (y) => -yl[y].tax, cls: "tl-total" }],
  });
  return groups;
}

function renderTaxView() {
  const note = `<p class="chart-note-inline">Income tax rows accrue in the year shown (spread through the year, PAYG-style). CGT payable shows the year of <em>payment</em> — gains realised in a year are assessed then and paid the following July.</p>`;
  renderTransposed(els.viewTax, buildTaxGroups(), note + accruedCgtFooter());
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
    const netReal = (1 + gross - a.icrPct / 100) / (1 + cpi) - 1;
    economic.push({ label: `${a.name} — gross return, nominal (% p.a.)`, cell: () => gross * 100, pct: true, always: true });
    economic.push({ label: `${a.name} — ICR (% p.a.)`, cell: () => a.icrPct, pct: true });
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

function exportProjectionPNG() {
  const el = $("chart");
  if (typeof Plotly === "undefined" || !el?.data) return;
  Plotly.toImage(el, { format: "png", width: 1280, height: 640 }).then((dataUrl) => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${exportNameBase()}-projection.png`;
    a.click();
  });
}

els.exportBtn.addEventListener("click", () => {
  if (activeView === "projection") exportProjectionPNG();
  else if (activeView === "cashflow") exportTransposedCSV("cashflow", buildCashflowGroups());
  else if (activeView === "assets") exportTransposedCSV("assets", buildAssetsGroups(assetsEntity));
  else if (activeView === "tax") exportTransposedCSV("tax", buildTaxGroups());
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
  renderPlanBar();
  renderAssets();
  renderCashflows();
  renderSettings();
  refreshOutputs();
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
