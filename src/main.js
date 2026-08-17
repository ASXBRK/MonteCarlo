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
  createExtraRepayment, createOneOffRepayment,
  createGoal, normaliseGoals,
  clampSnapshotYears, MAX_SNAPSHOT_YEARS,
  createProperty, normaliseProperties, PROPERTY_STATES, PROPERTY_TYPES,
  clampLastVisited, isScenarioEffectivelyEmpty, sectionCounts,
  createKeyDate, removeKeyDate, referencesToAnchor, convertAnchorReferences,
  createSuperAccount, clampSuperAccount, normaliseSuperAccounts,
  createSuperContribution, normaliseSuperContributions,
  createSuperWithdrawal, normaliseSuperWithdrawals,
  SUPER_CONTRIBUTION_TYPES, SUPER_CONTRIBUTION_BASES, FHSSS_ELIGIBLE_TYPES,
  clampWorkingCash, uid,
  createAllocation,
  INCOME_CATEGORIES, INCOME_CATEGORY_LABELS, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS,
  incomeCategoryTaxTreatment,
  createChild, createEducationBlock, childCurrentAgeInfo, flatEducationBlocks,
  SCHEMA_VERSION,
} from "./planState.js";
import { resolveRef, listAnchors } from "./keyDates.js";
import { levelPayment, monthlyRate, termMonths, ioMonths } from "./liabilities.js";
import { dutyWithConcessions, fhogAmount } from "./data/stampDuty.js";
import { lmiPremium } from "./data/lmiRates.js";
import { fhbgPriceCapExceeded, FHBG_PRICE_CAPS } from "./data/fhbgCaps.js";
import { renderBellCurves } from "./chart.js";
import { projectPlan, assetReturnComponents } from "./deterministic.js";
import { nominalFactor, firstFyStartYear } from "./schedule.js";
import { thinnedYearIndices } from "./periodThinning.js";
import { compositeSeries, sharedZeroRanges, seriesIsAllZero, axisTickVals } from "./outputSeries.js";
import { cashflowStatement } from "./cashflowStatement.js";
import { buildSnapshotColumns, buildSnapshotTable, snapshotToHTML, snapshotToCSV } from "./snapshot.js";
import {
  eligibleDepositProperties, buildDepositFocus, solveDepositContribution, solveWhenCouldIBuy,
} from "./focusDeposit.js";
import { eligibleFhsssPersons, buildFhsssFocus, buildFhsssComparison } from "./focusFhsss.js";
import { FHSSS_ANNUAL_CAP, FHSSS_LIFETIME_CAP } from "./fhsss.js";
import { eligibleSalarySacrificeRows, buildSalarySacrificeFocus } from "./focusSalarySacrifice.js";
import { eligibleDebtPayoffLoans, buildDebtPayoffFocus, solveExtraRepaymentForPayoffDate } from "./focusDebtPayoff.js";
import {
  computeStampDutyLookup, computeLmiLookup, STATES as FOCUS_LOOKUP_STATES,
  STAMP_DUTY_META, LMI_META, FHBG_META,
} from "./focusLookups.js";
import { eligibleEquityProperties, buildEquityFocus } from "./focusEquity.js";
import { buildTransferScheduleFocus, defaultTransferScheduleYear, perFortnight, perMonth } from "./focusTransferSchedule.js";
import { planWindowsMatch, keyFigureValuesAtYear, keyFigureComparisonRows } from "./scenarioComparison.js";
import { buildRateShockView, RATE_SHOCK_DELTAS, eligibleRateShockLoans } from "./whatIfRateShock.js";
import { buildCrashTimingView, eligibleCrashHoldings } from "./whatIfCrash.js";
import { runShock } from "./whatIf.js";
import { bufferBreach, incomeGapHeadline, expenseShockHeadline, rateShockHeadline } from "./whatIfCashflowLens.js";
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
  exportClientFile, exportScenarioFile, importFile, EXPORT_FORMAT,
} from "./workspace.js";
import { buildDemoClients } from "./demo/index.js";
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
  pageCompare: $("pageCompare"),
  pageWorkspace: $("pageWorkspace"),
  planBar: $("planBar"),
  taxDetailsSection: $("taxDetailsSection"),
  childrenSection: $("childrenSection"),
  implementationSection: $("implementationSection"),
  assets: $("assets"),
  lifestyleSection: $("lifestyleSection"),
  liabilitiesSection: $("liabilitiesSection"),
  goalsSection: $("goalsSection"),
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
  viewSnapshot: $("viewSnapshot"),
  snapshotYearPicker: $("snapshotYearPicker"),
  snapshotTable: $("snapshotTable"),
  viewSuperBalances: $("viewSuperBalances"),
  viewLiabilitiesBalances: $("viewLiabilitiesBalances"),
  viewCashflowBars: $("viewCashflowBars"),
  viewMoneyDecomposition: $("viewMoneyDecomposition"),
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
  reviewDefaultsModal: $("reviewDefaultsModal"),
  reviewDefaultsBody: $("reviewDefaultsBody"),
  assetRemoveModal: $("assetRemoveModal"),
  assetRemoveModalBody: $("assetRemoveModalBody"),
  paramAssetTable: $("paramAssetTable"),
  inflationInput: $("inflationInput"),
  unitsToggle: document.querySelector(".display-toggle"),
  periodSelect: $("periodSelect"),
  viewFocusDeposit: $("viewFocusDeposit"),
  viewFocusFhsss: $("viewFocusFhsss"),
  viewFocusSalarySacrifice: $("viewFocusSalarySacrifice"),
  viewFocusDebtPayoff: $("viewFocusDebtPayoff"),
  viewFocusLookups: $("viewFocusLookups"),
  viewFocusEquity: $("viewFocusEquity"),
  viewFocusTransferSchedule: $("viewFocusTransferSchedule"),
  viewWhatIfRateShock: $("viewWhatIfRateShock"),
  viewWhatIfCrash: $("viewWhatIfCrash"),
  viewWhatIfIncomeGap: $("viewWhatIfIncomeGap"),
  viewWhatIfExpenseShock: $("viewWhatIfExpenseShock"),
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
  els.pageCompare.hidden = name !== "compare";
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
  // hash here, so this never fires for that case. A compare route with
  // stale scenario ids dropped gets the same treatment.
  if (route.page === "workspace" && route.area != null && formatRoute(route) !== location.hash) {
    location.replace(formatRoute(route));
    return;
  }
  if (route.page === "compare" && formatRoute(route) !== location.hash) {
    location.replace(formatRoute(route));
    return;
  }
  currentRoute = route;
  if (route.page !== "workspace" && mountedScenarioId) unmountWorkspace();
  showPage(route.page);
  if (route.page === "clients") { renderClientsPage(); return; }
  if (route.page === "client") { renderClientPage(route.clientId); return; }
  if (route.page === "compare") { renderComparePage(route.clientId, route.scenarioIds); return; }

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
  fhsssEarningsRateInput.value = ((state.assumptions.fhsssEarningsRate ?? 0.0794) * 100).toFixed(2);
  syncBracketModeInputs();
  els.chartTreatmentSelects.forEach((sel) => { sel.value = state.display.chartTreatment[sel.dataset.treatment]; });
}

// --- sidebar navigation: one section per page (Sidebar nav) -----------------

const INPUT_NAV = [
  { id: "setup", label: "Setup" },
  { id: "tax-details", label: "Tax details" },
  { id: "children", label: "Children" },
  { id: "implementation", label: "Implementation" },
  { id: "income", label: "Income" },
  { id: "deductions", label: "Deductions" },
  { id: "expenses", label: "Expenses" },
  { id: "financial-assets", label: "Financial assets" },
  { id: "lifestyle-assets", label: "Lifestyle assets" },
  { id: "property", label: "Property" },
  { id: "super", label: "Super" },
  { id: "liabilities", label: "Liabilities" },
  { id: "goals", label: "Goals" },
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
    { id: "super-balances", label: "Super balances" },
    { id: "liabilities-balances", label: "Liabilities" },
    { id: "money-decomposition", label: "Where the money went" },
  ],
  Tables: [
    { id: "key-figures", label: "Key figures" },
    { id: "cashflow", label: "Cashflow" },
    { id: "assets", label: "Assets" },
    { id: "tax", label: "Tax" },
    { id: "super", label: "Super" },
    { id: "liabilities", label: "Liabilities" },
    { id: "snapshot", label: "Snapshot" },
    { id: "assumptions", label: "Assumptions" },
  ],
  // Focus (docs/specs/12-focus-views.md) — one question, one page, read
  // from the SAME projectPlan() output every other view reads. Never a
  // separate calculation (the governing principle) — see each
  // renderFocusXView() for how it reuses the engine's own figures.
  Focus: [
    { id: "focus-deposit", label: "Deposit & home purchase" },
    { id: "focus-fhsss", label: "FHSSS" },
    { id: "focus-salary-sacrifice", label: "Salary sacrifice" },
    { id: "focus-debt-payoff", label: "Debt payoff" },
    { id: "focus-lookups", label: "Stamp duty & LMI" },
    { id: "focus-equity", label: "Usable equity" },
    { id: "focus-transfer-schedule", label: "Transfer schedule" },
    // Compare scenarios relocated to its own client-level Compare page
    // (Clients > client > Compare) — no longer a workspace Focus view.
  ],
  // What if (docs/specs/14-what-if.md) — "what if the WORLD is
  // different" (uncontrolled shocks: rates, markets, inflation, income
  // interruption), the mirror image of Focus's "what if I did something
  // different" (levers the client controls). Monte Carlo moved here
  // unchanged (Commit 1) — a simulation is the probabilistic form of
  // exactly this question, and it no longer makes sense split across
  // Graphs (fan chart) and Tables (percentile table).
  WhatIf: [
    { id: "monte-carlo", label: "Monte Carlo (fan chart)" },
    { id: "monte-carlo-table", label: "Monte Carlo (percentile table)" },
    { id: "whatif-rate-shock", label: "Interest rate shocks" },
    { id: "whatif-crash", label: "Market crash timing" },
    { id: "whatif-income-gap", label: "Income interruption" },
    { id: "whatif-expense-shock", label: "Expense shock" },
  ],
};
const SECTION_LABELS = Object.fromEntries([
  ...INPUT_NAV.map((n) => [n.id, n.label]),
  ...Object.values(OUTPUT_NAV).flat().map((n) => [n.id, n.label]),
]);

// Input Usability spec, Commit 2 — a section "has untouched fields" if
// its (always-mounted) DOM contains at least one trackable control
// whose path isn't in state.meta.touched yet. Read straight off the
// live DOM rather than re-deriving section membership from state, so
// it can never drift from what decorateTouchedFields() itself counts.
function sectionHasUntouched(sectionId) {
  const section = els.workspaceCanvas.querySelector(`[data-section="${sectionId}"]`);
  if (!section) return false;
  for (const el of section.querySelectorAll(TOUCHED_FIELD_SELECTOR)) {
    const path = computeFieldPath(el);
    if (path && !isTouched(path)) return true;
  }
  return false;
}

function renderSideNav() {
  const counts = sectionCounts(state);
  const badge = (id) => (counts[id] ? `<span class="nav-badge">${counts[id]}</span>` : "");
  const item = (n, sub = false) => {
    const area = INPUT_NAV.includes(n) ? "input" : "output";
    const active = currentRoute?.area === area && currentRoute?.section === n.id;
    const unreviewed = area === "input" && sectionHasUntouched(n.id)
      ? `<span class="nav-badge-unreviewed" title="Contains fields not yet reviewed">●</span>` : "";
    return `
      <button class="nav-item${sub ? " nav-item-sub" : ""}${active ? " active" : ""}" type="button"
              data-nav-area="${area}" data-nav-section="${n.id}">
        <span>${escapeHTML(n.label)}</span>${unreviewed}${badge(n.id)}
      </button>
    `;
  };
  els.sideNav.innerHTML = `
    <button type="button" id="reviewDefaultsBtn" class="btn-text side-nav-review-btn">Review defaults</button>
    <div class="nav-group-label">Input</div>
    ${INPUT_NAV.map((n) => item(n)).join("")}
    <div class="nav-group-label">Output</div>
    <div class="nav-subgroup-label">Graphs</div>
    ${OUTPUT_NAV.Graphs.map((n) => item(n, true)).join("")}
    <div class="nav-subgroup-label">Tables</div>
    ${OUTPUT_NAV.Tables.map((n) => item(n, true)).join("")}
    <div class="nav-subgroup-label">Focus</div>
    ${OUTPUT_NAV.Focus.map((n) => item(n, true)).join("")}
    <div class="nav-subgroup-label">What if</div>
    ${OUTPUT_NAV.WhatIf.map((n) => item(n, true)).join("")}
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
  for (const el of [els.planBar, els.taxDetailsSection, els.childrenSection, els.implementationSection, els.incomeSection, els.deductionsSection, els.expensesSection, els.assets,
                    els.lifestyleSection, els.liabilitiesSection, els.goalsSection, els.propertySection,
                    els.investSection, els.settingsPanel, els.summaryStrip,
                    els.viewCashflow, els.assetsEntity, els.assetsTable,
                    els.viewTax, els.viewAssumptions, els.snapshotYearPicker, els.snapshotTable]) {
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

// Demo clients (committed fixtures, see src/demo/) — loaded fresh from
// the real factories each time, exactly like a JSON import. Reuses
// importFile's "client" kind wholesale: never a hand-rolled insertion
// path, so a schema change or a workspace-shape change breaks here at
// the same place it'd break a real import, not somewhere new.
//
// Never silently overwrites: a name clash asks Replace vs Add-as-copy
// (or Cancel) up front — imported-alongside copies get importFile's
// own " (imported)" suffix, exactly like a JSON client import would.
function loadDemoClients() {
  const demo = buildDemoClients(new Date());
  const existingNames = new Set(workspace.clients.map((c) => c.name));
  const clashes = demo.filter((d) => existingNames.has(d.name));

  let replace = false;
  if (clashes.length > 0) {
    const names = clashes.map((d) => d.name).join(", ");
    const raw = window.prompt(
      `${clashes.length === 1 ? "A demo client" : "Demo clients"} already loaded: ${names}.\n\n` +
      `1. Replace — delete the existing client(s) and load fresh demo data\n` +
      `2. Add as copies — load alongside, distinguished by name\n` +
      `3. Cancel\n\nEnter a number:`,
      "2"
    );
    const choice = raw == null ? null : raw.trim();
    if (choice == null || choice === "3" || choice === "") return;
    replace = choice === "1";
  }

  let idx = workspace;
  const writes = [];
  for (const d of demo) {
    if (replace) {
      const existing = idx.clients.find((c) => c.name === d.name);
      if (existing) {
        const r = deleteClient(idx, existing.id);
        // deleteClient refuses to remove the workspace's LAST client —
        // if that's the only thing standing in the way, fall through
        // to importFile's own add-as-copy naming instead of failing
        // outright; never leaves the workspace empty, never overwrites.
        if (r) {
          for (const sid of r.removedScenarioIds) removeRaw(scenarioKey(sid));
          idx = r.index;
        }
      }
    }
    const file = {
      kind: "client",
      formatVersion: EXPORT_FORMAT,
      name: d.name,
      scenarios: d.scenarios.map((s) => ({ name: s.name, state: { ...s.state, schemaVersion: SCHEMA_VERSION } })),
    };
    const res = importFile(idx, file, { hydrateState: (json) => hydrate(json, PROFILES), now: Date.now() });
    if (res.error) { window.alert(`Couldn't load "${d.name}": ${res.error}`); continue; }
    writes.push(...res.writes);
    idx = res.index;
  }
  for (const w of writes) writeRaw(scenarioKey(w.scenarioId), serialize(w.state));
  workspace = idx;
  saveWorkspace();
  renderClientsPage();
}

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
        <button class="btn-text" type="button" data-action="load-demo">Load demo clients</button>
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
    case "load-demo":
      loadDemoClients();
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

// Compare-selection mode (client page) — module state so it survives
// the re-renders a checkbox toggle triggers. Tracked per-client so
// switching clients never carries a stale selection across.
let compareSelectionMode = false;
let compareSelectedIds = [];
let compareModeClientId = null;

function renderClientPage(clientId) {
  const client = findClient(workspace, clientId);
  if (!client) { location.replace("#/clients"); return; }
  if (compareModeClientId !== clientId) {
    compareModeClientId = clientId;
    compareSelectionMode = false;
    compareSelectedIds = [];
  }
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
  const canCompare = client.scenarios.length >= 2;
  compareSelectedIds = compareSelectedIds.filter((id) => client.scenarios.some((s) => s.id === id));

  const rows = client.scenarios.map((s) => {
    const checkboxDisabled = !compareSelectedIds.includes(s.id) && compareSelectedIds.length >= 3;
    return `
    <div class="list-row ${compareSelectionMode ? "list-row-scenario-cmp" : "list-row-scenario"}" data-id="${s.id}">
      ${compareSelectionMode ? `
        <input type="checkbox" data-cmp-scenario="${s.id}"
          ${compareSelectedIds.includes(s.id) ? "checked" : ""} ${checkboxDisabled ? "disabled" : ""} />
      ` : ""}
      <a class="list-name" href="${formatRoute({ page: "workspace", clientId, scenarioId: s.id })}">${escapeHTML(s.name)}</a>
      <span class="list-meta">${fmtUpdated(s.updatedAt)}</span>
      <span class="list-actions">
        ${compareSelectionMode ? "" : `
        <button class="btn-text" type="button" data-action="rename" data-id="${s.id}">Rename</button>
        <button class="btn-text" type="button" data-action="duplicate" data-id="${s.id}">Duplicate</button>
        <button class="btn-text" type="button" data-action="export" data-id="${s.id}">Export</button>
        <button class="btn-text list-danger" type="button" data-action="delete" data-id="${s.id}"
                ${canDelete ? "" : "disabled"}>Delete</button>`}
      </span>
    </div>
  `;
  }).join("");

  const actionsHTML = compareSelectionMode
    ? `
      <span class="helper-text">${compareSelectedIds.length} selected (2–3)</span>
      <button class="btn-text" type="button" data-action="confirm-compare" ${compareSelectedIds.length < 2 ? "disabled" : ""}>Compare</button>
      <button class="btn-text" type="button" data-action="cancel-compare">Cancel</button>
    `
    : `
      <button class="btn-text" type="button" data-action="new-scenario">+ New scenario</button>
      <button class="btn-text" type="button" data-action="enter-compare" ${canCompare ? "" : "disabled"}
              title="${canCompare ? "Select scenarios to compare" : "Add another scenario to compare"}">Compare</button>
    `;

  els.pageClient.innerHTML = `
    <header class="page-head">
      <h1>Scenarios</h1>
      <div class="page-actions">${actionsHTML}</div>
    </header>
    <div class="list">
      <div class="list-head ${compareSelectionMode ? "list-head-scenario-cmp" : "list-head-scenario"}">
        ${compareSelectionMode ? "<span></span>" : ""}<span>Name</span><span>Last updated</span><span></span>
      </div>
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
    case "enter-compare": {
      if (client.scenarios.length < 2) break;
      compareSelectionMode = true;
      compareSelectedIds = [];
      renderClientPage(clientId);
      break;
    }
    case "cancel-compare": {
      compareSelectionMode = false;
      compareSelectedIds = [];
      renderClientPage(clientId);
      break;
    }
    case "confirm-compare": {
      if (compareSelectedIds.length < 2) break;
      const scenarioIds = compareSelectedIds;
      compareSelectionMode = false;
      compareSelectedIds = [];
      navigate({ page: "compare", clientId, scenarioIds });
      break;
    }
  }
});

els.pageClient.addEventListener("change", (e) => {
  const cb = e.target.closest("[data-cmp-scenario]");
  if (!cb) return;
  const clientId = currentRoute?.clientId;
  const id = cb.dataset.cmpScenario;
  if (cb.checked) {
    if (!compareSelectedIds.includes(id) && compareSelectedIds.length < 3) compareSelectedIds.push(id);
  } else {
    compareSelectedIds = compareSelectedIds.filter((x) => x !== id);
  }
  renderClientPage(clientId);
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

// --- tooltip affordance (Input Usability spec, Commit 1) --------------------
//
// A field's explanatory sentence goes behind a small (i) icon instead
// of rendering permanently — every Setup/Tax details/Super field that
// previously carried a `.helper-inline` sentence uses this now. Two
// exceptions never do (see the label's own inline markup instead): the
// derived age beside date of birth, and a resolved anchor value
// beneath a date-ref select — both change what the field MEANS, not
// merely explain it.
//
// Hover/focus shows it via CSS alone (:hover, :focus-within — so it's
// keyboard-reachable too); a delegated click listener (wireTooltips,
// called once at boot) toggles `.tt-open` for tap/click, and closes
// any open bubble when the user clicks elsewhere. `unreviewedNote`
// (Commit 2) appends the "Not yet reviewed — this is a default" line
// when the field is untouched.
function tooltipHTML(text, unreviewedNote = false) {
  return `
    <span class="tt-wrap">
      <button type="button" class="tt-icon" aria-label="More info" tabindex="0">i</button>
      <span class="tt-bubble">${escapeHTML(text)}${unreviewedNote ? `<span class="tt-unreviewed">Not yet reviewed — this is a default.</span>` : ""}</span>
    </span>
  `;
}

function wireTooltips() {
  document.addEventListener("click", (e) => {
    const icon = e.target.closest(".tt-icon");
    const openWraps = document.querySelectorAll(".tt-wrap.tt-open");
    if (icon) {
      const wrap = icon.closest(".tt-wrap");
      const wasOpen = wrap.classList.contains("tt-open");
      for (const w of openWraps) w.classList.remove("tt-open");
      if (!wasOpen) wrap.classList.add("tt-open");
      return;
    }
    if (!e.target.closest(".tt-wrap")) {
      for (const w of openWraps) w.classList.remove("tt-open");
    }
  });
}
wireTooltips();

// --- Touched-field tracking (Input Usability spec, Commit 2) ---------------
//
// state.meta.touched holds the dotted path of every field the user has
// attended to — changed, or explicitly confirmed via the tick
// affordance / "mark all reviewed". Paths reuse the state's own
// identifiers (see planState.js) and are computed generically from
// each control's existing data-* attributes, so this needed no new
// markup at any of the ~150 field call sites: one delegated listener
// plus one lookup table per naming convention covers the whole app.

// Person-prefixed data-plan-field suffixes (e.g. "clientRetirementAge",
// "partnerDivTaxPaidFrom") → the path under plan.<person>.
const PERSON_PLAN_FIELD_SUFFIX = {
  FirstName: "firstName",
  Surname: "surname",
  Dob: "dob",
  Sex: "sex",
  RetirementAge: "retirementAge",
  Residency: "taxProfile.residency",
  Medicare: "taxProfile.medicareExempt",
  WorkTestMet: "super.workTestMet",
  OpeningLosses: "taxProfile.openingCapitalLosses",
  PrivateHospitalCover: "privateHospitalCover",
  DivTaxPaidFrom: "super.divTaxPaidFrom",
  DivTaxReleaseAccountId: "super.divTaxReleaseAccountId",
};
// Static (non-person) data-plan-field codes.
const STATIC_PLAN_FIELD_PATH = {
  startYear: "plan.start.year",
  startMonth: "plan.start.month",
  endMode: "plan.endBasis.mode",
  endFixedAge: "plan.endBasis.fixedAge",
  endFixedYears: "plan.endBasis.fixedYears",
};
const IMPL_FIELD_PATH = {
  upfrontTotal: "plan.adviserFees.upfront.total",
  upfrontFromSuper: "plan.adviserFees.upfront.fromSuperAmount",
  upfrontSuperAccount: "plan.adviserFees.upfront.superAccountId",
  ongoingAnnual: "plan.adviserFees.ongoing.annualAmount",
  ongoingFromSuper: "plan.adviserFees.ongoing.fromSuperAmount",
  ongoingSuperAccount: "plan.adviserFees.ongoing.superAccountId",
  ongoingIndexBasis: "plan.adviserFees.ongoing.indexBasis",
  totalCashAvailable: "plan.implementation.totalCashAvailable",
  emergencyFundTarget: "plan.implementation.emergencyFundTarget",
};
const SETTINGS_FIELD_PATH = {
  wcaBalance: "plan.workingCash.balance",
  wcaMinimum: "plan.workingCash.minimumBalance",
  wcaRate: "plan.workingCash.ratePct",
};

function computePlanFieldPath(field) {
  if (STATIC_PLAN_FIELD_PATH[field]) return STATIC_PLAN_FIELD_PATH[field];
  for (const prefix of ["client", "partner"]) {
    if (field.startsWith(prefix)) {
      const suffix = PERSON_PLAN_FIELD_SUFFIX[field.slice(prefix.length)];
      if (suffix) return `plan.${prefix}.${suffix}`;
    }
  }
  return null;
}

// Selector for every element carrying a computable field path — kept
// in one place so the capture-phase listener, the decoration pass, and
// "mark all remaining as reviewed" all enumerate the identical set.
const TOUCHED_FIELD_SELECTOR = [
  "[data-plan-field]",
  "[data-kind][data-cfid][data-field]",
  "[data-aid][data-field]",
  "[data-said][data-sfield]",
  "[data-lid][data-erid][data-erfield]",
  "[data-lid][data-orid][data-orfield]",
  "[data-lid][data-lfield]",
  "[data-chid][data-edid][data-edfield]",
  "[data-chid][data-cfield]",
  "[data-pid][data-pfield]",
  "[data-gid][data-gfield]",
  "[data-alid][data-alfield]",
  "[data-impl-field]",
  "[data-settings-field]",
  "[data-kd-id][data-kd-field]",
].join(",");

// One dotted path per element, driven entirely by which data-*
// attributes it carries — never by which section it lives in, so a
// field moved between sections (as Commit 1 just did) needs no update
// here. Order matters where attributes co-occur: a liability's
// extra/one-off repayment sub-rows carry data-lid alongside their own
// data-erid/orid, so those checks come before the plain data-lfield one.
function computeFieldPath(el) {
  const ds = el.dataset;
  if (ds.lid && ds.erid && ds.erfield) return `liabilities.${ds.lid}.extraRepayments.${ds.erid}.${ds.erfield}`;
  if (ds.lid && ds.orid && ds.orfield) return `liabilities.${ds.lid}.oneOffRepayments.${ds.orid}.${ds.orfield}`;
  if (ds.lid && ds.lfield) return `liabilities.${ds.lid}.${ds.lfield}`;
  if (ds.chid && ds.edid && ds.edfield) return `plan.children.${ds.chid}.education.${ds.edid}.${ds.edfield}`;
  if (ds.chid && ds.cfield) return `plan.children.${ds.chid}.${ds.cfield}`;
  if (ds.kind && ds.cfid && ds.field) return `cashflows.${ds.kind}.${ds.cfid}.${ds.field}`;
  if (ds.aid && ds.field) return `assets.${ds.aid}.${ds.field}`;
  if (ds.said && ds.sfield) return `plan.superAccounts.${ds.said}.${ds.sfield}`;
  if (ds.pid && ds.pfield) return `properties.${ds.pid}.${ds.pfield}`;
  if (ds.gid && ds.gfield) return `goals.${ds.gid}.${ds.gfield}`;
  if (ds.alid && ds.alfield) return `plan.implementation.allocations.${ds.alid}.${ds.alfield}`;
  if (ds.implField) return IMPL_FIELD_PATH[ds.implField] ?? null;
  if (ds.settingsField) return SETTINGS_FIELD_PATH[ds.settingsField] ?? null;
  if (ds.kdId && ds.kdField) return `plan.keyDates.${ds.kdId}.${ds.kdField}`;
  if (ds.planField) return computePlanFieldPath(ds.planField);
  return null;
}

function isTouched(path) {
  return (state.meta?.touched ?? []).includes(path);
}

function markTouched(path) {
  if (!path) return;
  if (!state.meta) state.meta = { touched: [] };
  if (!state.meta.touched.includes(path)) state.meta.touched.push(path);
}

// Fired in the CAPTURE phase on the whole canvas, ahead of every
// section's own bubble-phase handler — so by the time that handler
// calls saveState()+renderAll(), state.meta.touched already reflects
// this edit and the re-render picks it up in one pass. No extra
// saveState() call needed here for that reason. Dates are deferred to
// focusout the same way wireDeferredDateCommit treats them, so a date
// field isn't marked touched on every intermediate keystroke commit.
function handleTouchMarkingEvent(e) {
  if (e.target.type === "date" ? e.type !== "focusout" : e.type !== "change") return;
  const el = e.target.closest?.(TOUCHED_FIELD_SELECTOR) ?? (e.target.matches?.(TOUCHED_FIELD_SELECTOR) ? e.target : null);
  if (!el) return;
  markTouched(computeFieldPath(el));
}
els.workspaceCanvas.addEventListener("change", handleTouchMarkingEvent, true);
els.workspaceCanvas.addEventListener("focusout", handleTouchMarkingEvent, true);

// Mark every currently-untouched field inside `container` (a
// [data-section] root, or the whole canvas for "mark all reviewed"
// from the review panel) as reviewed, without changing any value.
function markAllReviewedIn(container) {
  let changed = false;
  for (const el of container.querySelectorAll(TOUCHED_FIELD_SELECTOR)) {
    const path = computeFieldPath(el);
    if (path && !isTouched(path)) { markTouched(path); changed = true; }
  }
  if (changed) { saveState(); renderAll(); }
}

// Post-render decoration pass: mutes untouched fields' label/control,
// gives each a small dot that doubles as the "confirm without
// changing" tick affordance, and appends the tooltip's "Not yet
// reviewed" line. Runs once at the end of renderAll() over the whole
// canvas — every [data-section] is always mounted (showSection only
// toggles `hidden`), so this reaches every section regardless of which
// one is currently visible.
function decorateTouchedFields() {
  for (const el of els.workspaceCanvas.querySelectorAll(TOUCHED_FIELD_SELECTOR)) {
    const path = computeFieldPath(el);
    if (!path) continue;
    const untouched = !isTouched(path);
    const container = el.closest(".cf-cell") || el.closest(".plan-field");
    const target = container || el;
    target.classList.toggle("field-untouched", untouched);
    const bubble = container?.querySelector(".tt-bubble");
    if (bubble) {
      const existingNote = bubble.querySelector(".tt-unreviewed");
      if (untouched && !existingNote) {
        bubble.insertAdjacentHTML("beforeend", `<span class="tt-unreviewed">Not yet reviewed — this is a default.</span>`);
      } else if (!untouched && existingNote) {
        existingNote.remove();
      }
    }
  }
  // The tick/dot is per CONTAINER, not per field: a couple of fields
  // (Setup's month+year "Start" pair, for one) share a single .cf-cell/
  // .plan-field, so a dot keyed to just one of their paths would leave
  // the other permanently unconfirmable. Recompute per container from
  // its own live children instead — one dot, click marks every path
  // still untouched inside it (see the click handler below).
  for (const container of els.workspaceCanvas.querySelectorAll(".cf-cell, .plan-field")) {
    const ownFields = container.querySelectorAll(TOUCHED_FIELD_SELECTOR);
    const anyUntouched = [...ownFields].some((el) => {
      const p = computeFieldPath(el);
      return p && !isTouched(p);
    });
    let dot = container.querySelector(":scope > .field-dot");
    if (anyUntouched && ownFields.length > 0) {
      if (!dot) {
        dot = document.createElement("button");
        dot.type = "button";
        dot.className = "field-dot";
        dot.setAttribute("aria-label", "Mark as reviewed");
        dot.title = "Not yet reviewed — click to mark reviewed";
        container.insertBefore(dot, container.firstChild);
      }
    } else if (dot) {
      dot.remove();
    }
  }
  // Section-level "Mark all remaining as reviewed" — inserted once per
  // populated [data-section] root that still has untouched fields.
  for (const section of els.workspaceCanvas.querySelectorAll("[data-section]")) {
    const fields = section.querySelectorAll(TOUCHED_FIELD_SELECTOR);
    const untouchedCount = [...fields].filter((el) => {
      const p = computeFieldPath(el);
      return p && !isTouched(p);
    }).length;
    let btn = section.querySelector(":scope > .mark-all-reviewed");
    if (untouchedCount > 0) {
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mark-all-reviewed btn-text";
        section.insertBefore(btn, section.firstChild);
      }
      // A write here is a mutation whether or not the string actually
      // changed (textContent always replaces the text node) — this
      // function is driven by a MutationObserver on this same canvas,
      // so an unconditional write would re-trigger itself forever.
      // Guard on the value actually differing so a settled canvas
      // truly settles.
      const label = `Mark all remaining as reviewed (${untouchedCount})`;
      if (btn.textContent !== label) btn.textContent = label;
    } else if (btn) {
      btn.remove();
    }
  }
}

els.workspaceCanvas.addEventListener("click", (e) => {
  const dot = e.target.closest(".field-dot");
  if (dot) {
    markAllReviewedIn(dot.parentElement); // just this one .cf-cell/.plan-field
    return;
  }
  const markAllBtn = e.target.closest(".mark-all-reviewed");
  if (markAllBtn) {
    markAllReviewedIn(markAllBtn.closest("[data-section]"));
  }
});

// Most sections re-render narrowly after their own edits (e.g.
// renderLiabilities(), not a full renderAll()), so decoration can't
// simply be called once at the end of renderAll() — it would only ever
// see Setup/Tax details, the two sections whose handler happens to
// call renderAll() directly. A MutationObserver on the whole canvas
// catches every section's innerHTML replacement uniformly, wherever it
// comes from, present or future, without each render function needing
// to remember to call decorateTouchedFields() itself. Decoration's own
// DOM writes (the dot, the mark-all button) re-trigger this once more,
// but it's idempotent — the second pass finds nothing left to change.
new MutationObserver(() => decorateTouchedFields())
  .observe(els.workspaceCanvas, { childList: true, subtree: true });

// --- Review defaults panel ---------------------------------------------------
//
// "The pre-advice check: what in this plan has nobody looked at?" —
// every untouched field, grouped by section, with its current value
// and a jump-to link. Reads the same value straight off its live DOM
// control, so it never falls out of sync with what clamping actually
// produced.
function fieldDisplayValue(el) {
  if (el.type === "checkbox") return el.checked ? "Yes" : "No";
  if (el.tagName === "SELECT") return el.options[el.selectedIndex]?.text ?? el.value;
  return el.value || "(blank)";
}

function fieldLabelText(el) {
  const cell = el.closest(".cf-cell") || el.closest(".plan-field");
  const label = cell?.querySelector("label");
  if (label) return label.textContent.replace(/\s+/g, " ").trim();
  return el.getAttribute("aria-label") || el.placeholder || el.dataset.field || el.dataset.lfield
    || el.dataset.pfield || el.dataset.gfield || el.dataset.alfield || el.dataset.sfield
    || el.dataset.kdField || el.dataset.implField || el.dataset.settingsField || "Field";
}

function renderReviewDefaults() {
  const bySection = new Map();
  for (const section of els.workspaceCanvas.querySelectorAll("[data-section]")) {
    const sectionId = section.dataset.section;
    for (const el of section.querySelectorAll(TOUCHED_FIELD_SELECTOR)) {
      const path = computeFieldPath(el);
      if (!path || isTouched(path)) continue;
      if (!bySection.has(sectionId)) bySection.set(sectionId, []);
      bySection.get(sectionId).push({ path, label: fieldLabelText(el), value: fieldDisplayValue(el) });
    }
  }
  if (bySection.size === 0) {
    els.reviewDefaultsBody.innerHTML = `<p class="muted">Every field in this scenario has been reviewed.</p>`;
    return;
  }
  els.reviewDefaultsBody.innerHTML = [...bySection.entries()].map(([sectionId, fields]) => `
    <section class="review-section">
      <h3>${escapeHTML(SECTION_LABELS[sectionId] ?? sectionId)} <span class="nav-badge">${fields.length}</span></h3>
      <ul class="review-field-list">
        ${fields.map((f) => `
          <li>
            <button type="button" class="btn-text review-jump" data-jump-section="${sectionId}">${escapeHTML(f.label)}</button>
            <span class="review-field-value">${escapeHTML(String(f.value))}</span>
            <button type="button" class="btn-text review-mark" data-mark-path="${escapeHTML(f.path)}">Mark reviewed</button>
          </li>
        `).join("")}
      </ul>
    </section>
  `).join("");
}

function openReviewDefaultsModal() {
  renderReviewDefaults();
  els.reviewDefaultsModal.showModal();
}
// Delegated, not a one-time addEventListener: renderSideNav() rebuilds
// #sideNav's innerHTML (and this button with it) on every save.
els.sideNav.addEventListener("click", (e) => {
  if (e.target.closest("#reviewDefaultsBtn")) openReviewDefaultsModal();
});
els.reviewDefaultsModal.querySelector(".modal-close").addEventListener("click", () => els.reviewDefaultsModal.close());
els.reviewDefaultsModal.addEventListener("click", (e) => {
  if (e.target === els.reviewDefaultsModal) { els.reviewDefaultsModal.close(); return; }
  const jump = e.target.closest(".review-jump");
  if (jump) {
    els.reviewDefaultsModal.close();
    const { client, scenario } = findActive(workspace);
    navigate({ page: "workspace", clientId: client.id, scenarioId: scenario.id, area: "input", section: jump.dataset.jumpSection });
    return;
  }
  const mark = e.target.closest(".review-mark");
  if (mark) {
    markTouched(mark.dataset.markPath);
    saveState();
    renderAll();
    renderReviewDefaults(); // stays open, list shrinks by one
    return;
  }
  const markAllEverywhere = e.target.closest("#reviewDefaultsMarkAll");
  if (markAllEverywhere) {
    markAllReviewedIn(els.workspaceCanvas);
    renderReviewDefaults();
  }
});

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

// Setup keeps identity and timeline only (Input Usability spec, Commit
// 1) — Xplan's own "Basic Details" division. Tax residency, Medicare,
// work test, capital losses and private hospital cover moved to the
// new Tax details section (personTaxDetailsHTML, below); the Division
// 293/296 election moved beside the super accounts it draws on
// (renderSuper's own person block); "Eligible for Centrelink benefits"
// is gone entirely (inert, reintroduced with Centrelink modelling).
function personIdentityHTML(prefix, person, title) {
  return `
    <div class="person-block">
      <div class="cf-section-title">${escapeHTML(title)}</div>
      <div class="identity-grid">
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
          <label>Sex ${tooltipHTML("Used for life expectancy.")}</label>
          <select data-plan-field="${prefix}Sex">
            <option value="male"${person.sex !== "female" ? " selected" : ""}>Male</option>
            <option value="female"${person.sex === "female" ? " selected" : ""}>Female</option>
          </select>
        </div>
        <div class="cf-cell">
          <label>Retirement age ${tooltipHTML("Used as the Retirement key date and as the default report period anchor.")}</label>
          <input type="number" min="${person.currentAge}" max="${state.plan.endAge}" step="1" value="${person.retirementAge}"
                 data-plan-field="${prefix}RetirementAge" />
        </div>
      </div>
    </div>
  `;
}

// New Tax details section (Input Usability spec, Commit 1) — Xplan's
// own "Tax Details" division: residency, Medicare, work test, opening
// capital losses, private hospital cover.
function personTaxDetailsHTML(prefix, person, title) {
  const tp = person.taxProfile;
  return `
    <div class="person-block">
      <div class="cf-section-title">${escapeHTML(title)}</div>
      <div class="identity-grid">
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
        ${personSpansWorkTestAges(person) ? `
          <div class="cf-cell">
            <label>Work test met (age 67–74) ${tooltipHTML("Gates personal deductible super contributions in that age band. The work-test exemption itself is not modelled.")}</label>
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
          <label>Private hospital cover ${tooltipHTML("Suppresses the Medicare Levy Surcharge for this person entirely.")}</label>
          <label class="ptg-check">
            <input type="checkbox"${person.privateHospitalCover !== false ? " checked" : ""} data-plan-field="${prefix}PrivateHospitalCover" />
            <span>Yes</span>
          </label>
        </div>
      </div>
    </div>
  `;
}

// Division 293/296 election — moved beside the super accounts it draws
// on (renderSuper, below), not in identity. Its own field mutation
// listener lives on els.superSection alongside the account cards.
function personDivTaxHTML(prefix, person, title) {
  const owner = prefix === "client" ? "client" : "partner";
  const ownerSuperAccounts = (state.plan.superAccounts ?? []).filter((s) => s.owner === owner && s.include);
  const divTaxPaidFrom = person.super?.divTaxPaidFrom === "cash" ? "cash" : "super";
  return `
    <div class="person-block">
      <div class="cf-section-title">${escapeHTML(title)}</div>
      <div class="identity-grid">
        <div class="cf-cell">
          <label>Division 293 / 296 tax paid from ${tooltipHTML("The taxpayer may elect either; release from super is the common election.")}</label>
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
    ${personIdentityHTML("client", p.client, couple ? `Client — ${clientName()}` : clientName())}
    ${couple ? personIdentityHTML("partner", p.partner, `Partner — ${partnerName()}`) : ""}
  `;
}

// New Tax details section (Input Usability spec, Commit 1) — each
// person's tax-details block.
function renderTaxDetails() {
  const p = state.plan;
  const couple = isCouple();
  els.taxDetailsSection.innerHTML = `
    <h2 class="section-heading">Tax details</h2>
    ${personTaxDetailsHTML("client", p.client, couple ? `Client — ${clientName()}` : clientName())}
    ${couple ? personTaxDetailsHTML("partner", p.partner, `Partner — ${partnerName()}`) : ""}
  `;
}

// --- Children + education funding (Input Usability spec, Commit 3) --------
//
// dependentChildren is now DERIVED (dependentChildrenCountInFY, read by
// deterministic.js) from each child's own DOB — no field here sets it
// directly. Education blocks are household expenses that flow through
// the normal cashflow mechanism (schedule.js), anchored to the child's
// own age rather than client/partner.

function findChild(chid) {
  return (state.plan.children ?? []).find((c) => c.id === chid) ?? null;
}

function educationRowHTML(chid, ed) {
  return `
    <tr class="cf-tr">
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(ed.label)}" maxlength="40" data-chid="${chid}" data-edid="${ed.id}" data-edfield="label" />
      </td>
      <td class="cf-td-amount">
        <input type="number" min="0" step="100" value="${ed.annualAmount}" data-chid="${chid}" data-edid="${ed.id}" data-edfield="annualAmount" />
      </td>
      <td class="cf-td-date">
        <input type="number" min="0" max="25" step="1" value="${ed.fromAge}" aria-label="From (child's age)" data-chid="${chid}" data-edid="${ed.id}" data-edfield="fromAge" />
      </td>
      <td class="cf-td-date">
        <input type="number" min="0" max="25" step="1" value="${ed.toAge}" aria-label="To (child's age)" data-chid="${chid}" data-edid="${ed.id}" data-edfield="toAge" />
      </td>
      <td class="cf-td-index">
        <select data-chid="${chid}" data-edid="${ed.id}" data-edfield="indexBasis" aria-label="Index basis">
          <option value="none"${ed.indexBasis === "none" ? " selected" : ""}>None</option>
          <option value="cpi"${ed.indexBasis === "cpi" ? " selected" : ""}>CPI</option>
          <option value="awote"${ed.indexBasis === "awote" ? " selected" : ""}>Wage index (AWOTE)</option>
        </select>
        <input type="number" min="-10" max="10" step="0.1" value="${ed.indexExtraPct}" aria-label="Additional %"
               data-chid="${chid}" data-edid="${ed.id}" data-edfield="indexExtraPct" />
      </td>
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove education funding"
                data-child-action="remove-education" data-chid="${chid}" data-edid="${ed.id}">×</button>
      </td>
    </tr>
  `;
}

function childCardHTML(c) {
  const info = childCurrentAgeInfo(c, state.plan);
  const ageMeta = info.notYetBorn
    ? `Not yet born — arrives ${info.bornFYLabel}`
    : `Age ${info.age}`;
  return `
    <div class="pcard" data-chid="${c.id}">
      <div class="pcard-head">
        <span class="pcard-name">${escapeHTML(c.name)}</span>
        <span class="pcard-meta">${ageMeta}</span>
        <button class="pcard-remove" type="button" data-child-action="remove" data-chid="${c.id}">Remove</button>
      </div>
      <div class="pcard-body">
        <div class="person-grid">
          <div class="cf-cell">
            <label>Name</label>
            <input type="text" maxlength="40" value="${escapeHTML(c.name)}" data-chid="${c.id}" data-cfield="name" />
          </div>
          <div class="cf-cell">
            <label>Date of birth <span class="live-age">· ${ageMeta}</span></label>
            <input type="date" value="${c.dateOfBirth}" data-chid="${c.id}" data-cfield="dateOfBirth" />
          </div>
        </div>
        <div class="cf-subsection">
          <div class="cf-section-title">Education funding ${tooltipHTML("Household expenses anchored to this child's own age (e.g. Primary ages 5–12), not the client's. Defaults to CPI + 2% — school fees have historically outrun CPI.")}</div>
          ${(c.education ?? []).length === 0 ? "" : `
            <table class="cf-table">
              <thead><tr><th>Label</th><th>Amount ($/yr, today's)</th><th>From (age)</th><th>To (age)</th><th>Indexation</th><th></th></tr></thead>
              <tbody>${c.education.map((ed) => educationRowHTML(c.id, ed)).join("")}</tbody>
            </table>
          `}
          <button class="add-row-btn" type="button" data-child-action="add-education" data-chid="${c.id}">+ Add education funding</button>
        </div>
      </div>
    </div>
  `;
}

function renderChildren() {
  const children = state.plan.children ?? [];
  els.childrenSection.innerHTML = `
    <h2 class="section-heading">Children</h2>
    <p class="helper-inline">Drives the Medicare Levy Surcharge family threshold, which steps down as each child turns 21 — a fixed count is never entered directly.</p>
    <div class="portfolio-stack">${children.map(childCardHTML).join("")}</div>
    <div class="portfolio-actions">
      <button id="addChildBtn" class="btn-text" type="button" data-child-action="add">+ Add child</button>
    </div>
  `;
}

els.childrenSection.addEventListener("change", (e) => {
  const c = findChild(e.target.dataset.chid);
  if (!c) return;
  const field = e.target.dataset.cfield;
  const edField = e.target.dataset.edfield;
  if (field) {
    if (field === "name") c.name = e.target.value.trim() || c.name;
    else if (field === "dateOfBirth") c.dateOfBirth = e.target.value || c.dateOfBirth;
  } else if (edField) {
    const ed = (c.education ?? []).find((x) => x.id === e.target.dataset.edid);
    if (!ed) return;
    if (edField === "label") ed.label = e.target.value.trim() || ed.label;
    else if (edField === "annualAmount") ed.annualAmount = clampNumber(e.target.value, 0);
    else if (edField === "fromAge") ed.fromAge = clampInt(e.target.value, 0, 25);
    else if (edField === "toAge") ed.toAge = clampInt(e.target.value, 0, 25);
    else if (edField === "indexBasis") ed.indexBasis = e.target.value;
    else if (edField === "indexExtraPct") ed.indexExtraPct = clampNumber(e.target.value, -10, 10);
  } else {
    return;
  }
  state.plan = clampPlan({ ...state.plan, children: state.plan.children }, PROFILES);
  state = clampAllToPlan(state, PROFILES);
  saveState();
  refreshOutputs();
  renderChildren();
});

els.childrenSection.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-child-action]");
  if (!btn) return;
  if (btn.dataset.childAction === "add") {
    state.plan.children = [...(state.plan.children ?? []), createChild(state.plan.children ?? [], state.plan)];
  } else {
    const c = findChild(btn.dataset.chid);
    if (!c) return;
    if (btn.dataset.childAction === "remove") {
      if (!window.confirm(`Remove "${c.name}"?`)) return;
      state.plan.children = state.plan.children.filter((x) => x.id !== c.id);
    } else if (btn.dataset.childAction === "add-education") {
      c.education = [...(c.education ?? []), createEducationBlock(c.education ?? [])];
    } else if (btn.dataset.childAction === "remove-education") {
      c.education = (c.education ?? []).filter((x) => x.id !== btn.dataset.edid);
    } else {
      return;
    }
  }
  state.plan = clampPlan({ ...state.plan, children: state.plan.children }, PROFILES);
  state = clampAllToPlan(state, PROFILES);
  saveState();
  refreshOutputs();
  renderChildren();
});

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

// Shared by every container that can render a `data-plan-field`
// control (Input Usability spec, Commit 1 split Setup's single block
// into three: Setup itself, the new Tax details section, and the
// Division 293/296 election beside super accounts) — wired to all
// three below. Field names are unchanged by the split (still e.g.
// "clientResidency", "clientDivTaxPaidFrom"), so this ONE handler
// reads `e.target.dataset.planField` and no-ops when the event came
// from an unrelated control on the same container (data-sfield etc.),
// regardless of which section's DOM the event actually bubbled from.
function handlePlanFieldChange(e) {
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
    // HELP-as-liability follow-up fix: edited in the Liabilities section
    // now (its own block, see renderLiabilities), not here — carried
    // through unchanged by every OTHER Setup field edit.
    helpBalance: cur.helpBalance,
    privateHospitalCover: field === `${prefix}PrivateHospitalCover` ? e.target.checked : cur.privateHospitalCover,
    taxProfile: {
      residency: field === `${prefix}Residency` ? e.target.value : cur.taxProfile.residency,
      medicareExempt: field === `${prefix}Medicare` ? e.target.value === "exempt" : cur.taxProfile.medicareExempt,
      openingCapitalLosses: field === `${prefix}OpeningLosses` ? e.target.value : cur.taxProfile.openingCapitalLosses,
    },
    // Super carry-forward ledger etc. (Tier 1.2) — carried through
    // untouched by every OTHER field edit; the work-test toggle
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
    workingCash: p.workingCash,
    children: p.children,
  };
  state.plan = clampPlan(next, PROFILES);
  state = clampAllToPlan(state, PROFILES);
  saveState();
  maybeDefaultWorkspaceClientName(field);
  renderAll();
}
wireDeferredDateCommit(els.planBar, handlePlanFieldChange);
els.taxDetailsSection.addEventListener("change", handlePlanFieldChange);
els.superSection.addEventListener("change", handlePlanFieldChange);

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

// --- Implementation: adviser fees & flow of initial funds
// (Implementation/Rates spec, Commit 2) ---------------------------------

function superAccountOptionsForFees(selected) {
  const accts = state.plan.superAccounts ?? [];
  return `<option value=""${!selected ? " selected" : ""}>None</option>` +
    accts.map((s) => `<option value="${s.id}"${s.id === selected ? " selected" : ""}>${escapeHTML(s.name)}</option>`).join("");
}

// The three shapes an allocation can target — an existing financial
// asset, the Working Cash Account, or a goal — mirrors the spec's own
// `targetAssetId | "workingCash" | "goal:<id>"` union exactly.
function allocationTargetOptions(selected) {
  const opts = [`<option value="workingCash"${selected === "workingCash" ? " selected" : ""}>Working Cash Account</option>`];
  for (const a of state.assets.filter((x) => x.class !== "lifestyle")) {
    opts.push(`<option value="${a.id}"${a.id === selected ? " selected" : ""}>${escapeHTML(a.name)}</option>`);
  }
  for (const g of state.goals ?? []) {
    const val = `goal:${g.id}`;
    opts.push(`<option value="${val}"${val === selected ? " selected" : ""}>Goal: ${escapeHTML(g.label)}</option>`);
  }
  return opts.join("");
}

// "Show the cap, the requested amount, and any shortfall that must be
// paid personally" — read straight off the live projection's own
// per-year adviser-fee report, never recomputed.
function adviserFeeCapRowHTML(label, fee) {
  if (!fee || !(fee.requestedFromSuper > 0)) return "";
  const shortfall = fee.requestedFromSuper - fee.paidFromSuper;
  return `
    <tr>
      <td>${escapeHTML(label)} — requested from super</td>
      <td>${fmtMoney(fee.requestedFromSuper)}, paid ${fmtMoney(fee.paidFromSuper)}${shortfall > 0.5 ? ` — short ${fmtMoney(shortfall)}, paid personally` : ""}</td>
    </tr>
  `;
}

// A reconciliation block, not a new source of truth (the spec's own
// words): total cash available, less the upfront fee's outside-super
// slice, less every allocation, equals residual — cross-checked
// against what's ACTUALLY entered as opening balances elsewhere in the
// plan. A mismatch is flagged, never silently corrected — entered
// balances are never overwritten by this display.
function implementationReconciliationHTML() {
  const impl = state.plan.implementation;
  const upfront = state.plan.adviserFees.upfront;
  const upfrontOutside = Math.max(0, upfront.total - upfront.fromSuperAmount);
  const allocatedTotal = impl.allocations.reduce((s, a) => s + a.amount, 0);
  const residual = impl.totalCashAvailable - upfrontOutside - allocatedTotal;
  const enteredTotal = state.assets.reduce((s, a) => s + (a.balance || 0), 0) + (state.plan.workingCash.balance || 0);
  const mismatch = allocatedTotal - enteredTotal;
  return `
    <table class="focus-table">
      <tr><td>Total cash available</td><td>${fmtMoney(impl.totalCashAvailable)}</td></tr>
      <tr><td>Less: upfront adviser fee (outside super)</td><td>−${fmtMoney(upfrontOutside)}</td></tr>
      ${impl.allocations.map((a) => `<tr><td>Less: ${escapeHTML(a.label)}</td><td>−${fmtMoney(a.amount)}</td></tr>`).join("")}
      <tr class="tl-total"><td>Residual</td><td>${fmtMoney(residual)}</td></tr>
    </table>
    ${Math.abs(mismatch) > 0.5
      ? `<p class="helper-warning">Allocations total ${fmtMoney(allocatedTotal)}, but entered opening balances (financial + lifestyle assets, plus the Working Cash Account) total ${fmtMoney(enteredTotal)} — a ${fmtMoney(Math.abs(mismatch))} difference. A reconciliation flag only; entered balances are never overwritten.</p>`
      : `<p class="helper-text">Allocations reconcile with entered opening balances.</p>`}
  `;
}

function renderImplementation() {
  const af = state.plan.adviserFees;
  const impl = state.plan.implementation;
  const y0 = projection?.yearly?.[0];
  els.implementationSection.innerHTML = `
    <h2 class="section-heading">Implementation</h2>
    <div class="pcard">
      <div class="pcard-head"><span class="pcard-name">Adviser fees</span></div>
      <div class="pcard-body">
        <div class="cf-section-title">Upfront (paid once, at plan start)</div>
        <div class="person-grid">
          <div class="cf-cell"><label>Total fee ($)</label>
            <input type="number" min="0" step="100" value="${af.upfront.total}" data-impl-field="upfrontTotal" /></div>
          <div class="cf-cell"><label>From super ($)</label>
            <input type="number" min="0" max="${af.upfront.total}" step="100" value="${af.upfront.fromSuperAmount}" data-impl-field="upfrontFromSuper" /></div>
          <div class="cf-cell"><label>Super account</label>
            <select data-impl-field="upfrontSuperAccount">${superAccountOptionsForFees(af.upfront.superAccountId)}</select></div>
        </div>
        <div class="cf-section-title">Ongoing (indexed, every year)</div>
        <div class="person-grid">
          <div class="cf-cell"><label>Annual amount ($)</label>
            <input type="number" min="0" step="100" value="${af.ongoing.annualAmount}" data-impl-field="ongoingAnnual" /></div>
          <div class="cf-cell"><label>From super ($/yr)</label>
            <input type="number" min="0" max="${af.ongoing.annualAmount}" step="100" value="${af.ongoing.fromSuperAmount}" data-impl-field="ongoingFromSuper" /></div>
          <div class="cf-cell"><label>Super account</label>
            <select data-impl-field="ongoingSuperAccount">${superAccountOptionsForFees(af.ongoing.superAccountId)}</select></div>
          <div class="cf-cell"><label>Indexation</label>
            <select data-impl-field="ongoingIndexBasis">
              <option value="cpi"${af.ongoing.indexBasis === "cpi" ? " selected" : ""}>CPI</option>
              <option value="awote"${af.ongoing.indexBasis === "awote" ? " selected" : ""}>AWOTE (wages)</option>
              <option value="none"${af.ongoing.indexBasis === "none" ? " selected" : ""}>None (nominal fixed)</option>
            </select>
          </div>
        </div>
        <p class="helper-text">Financial advice fees are not modelled as tax-deductible here. The partial deductibility available for advice relating to EXISTING investments is real but needs an apportionment this tool doesn't collect — see the Parameters modal.</p>
        <p class="helper-text">Fees paid from super are not a benefit payment and are not assessable to the member — they reduce the account's own balance directly, so its future earnings are on a smaller base (the same treatment as a Division 293/296 release from super).</p>
        ${y0 && (y0.adviserFeesUpfront?.requestedFromSuper > 0 || y0.adviserFeesOngoing?.requestedFromSuper > 0) ? `
          <table class="focus-table">
            ${adviserFeeCapRowHTML("Upfront", y0.adviserFeesUpfront)}
            ${adviserFeeCapRowHTML("Ongoing, this year", y0.adviserFeesOngoing)}
          </table>
        ` : ""}
      </div>
    </div>
    <div class="pcard">
      <div class="pcard-head"><span class="pcard-name">Flow of initial funds</span></div>
      <div class="pcard-body">
        <div class="person-grid">
          <div class="cf-cell"><label>Total cash available ($)</label>
            <input type="number" min="0" step="1000" value="${impl.totalCashAvailable}" data-impl-field="totalCashAvailable" /></div>
          <div class="cf-cell"><label>Emergency fund target ($)</label>
            <input type="number" min="0" step="1000" value="${impl.emergencyFundTarget}" data-impl-field="emergencyFundTarget" /></div>
        </div>
        <p class="helper-text">Emergency fund target sets the Working Cash Account's minimum balance once it's nonzero — deficit funding will not draw the buffer below it, so a plan that would eat the emergency fund shows as unfunded instead.</p>
        <div class="cf-section-title">Allocations</div>
        ${impl.allocations.length === 0 ? "" : `
          <table class="cf-table">
            <thead><tr><th>Label</th><th>Amount</th><th>Target</th><th></th></tr></thead>
            <tbody>${impl.allocations.map((a) => `
              <tr class="cf-tr">
                <td class="cf-td-label"><input type="text" maxlength="40" value="${escapeHTML(a.label)}" data-alid="${a.id}" data-alfield="label" /></td>
                <td class="cf-td-amount"><input type="text" inputmode="decimal" class="cf-amount-input" value="${fmtAmountValue(a.amount)}" data-alid="${a.id}" data-alfield="amount" /></td>
                <td class="cf-td-date"><select data-alid="${a.id}" data-alfield="targetAssetId">${allocationTargetOptions(a.targetAssetId)}</select></td>
                <td class="cf-td-remove"><button class="cf-remove" type="button" data-impl-action="remove-allocation" data-alid="${a.id}">×</button></td>
              </tr>
            `).join("")}</tbody>
          </table>
        `}
        <button class="add-row-btn" type="button" data-impl-action="add-allocation">+ Add allocation</button>
        ${implementationReconciliationHTML()}
      </div>
    </div>
  `;
}

els.implementationSection.addEventListener("change", (e) => {
  const field = e.target.dataset.implField;
  const alField = e.target.dataset.alfield;
  if (field) {
    const af = state.plan.adviserFees;
    const impl = state.plan.implementation;
    if (field === "upfrontTotal") af.upfront.total = clampNumber(e.target.value, 0);
    else if (field === "upfrontFromSuper") af.upfront.fromSuperAmount = clampNumber(e.target.value, 0);
    else if (field === "upfrontSuperAccount") af.upfront.superAccountId = e.target.value || null;
    else if (field === "ongoingAnnual") af.ongoing.annualAmount = clampNumber(e.target.value, 0);
    else if (field === "ongoingFromSuper") af.ongoing.fromSuperAmount = clampNumber(e.target.value, 0);
    else if (field === "ongoingSuperAccount") af.ongoing.superAccountId = e.target.value || null;
    else if (field === "ongoingIndexBasis") af.ongoing.indexBasis = e.target.value;
    else if (field === "totalCashAvailable") impl.totalCashAvailable = clampNumber(e.target.value, 0);
    else if (field === "emergencyFundTarget") impl.emergencyFundTarget = clampNumber(e.target.value, 0);
    else return;
  } else if (alField) {
    const a = (state.plan.implementation.allocations ?? []).find((x) => x.id === e.target.dataset.alid);
    if (!a) return;
    if (alField === "label") a.label = e.target.value.trim() || a.label;
    else if (alField === "amount") a.amount = clampNumber(e.target.value, 0);
    else if (alField === "targetAssetId") a.targetAssetId = e.target.value;
    else return;
  } else {
    return;
  }
  state.plan = clampPlan(state.plan, PROFILES);
  state = clampAllToPlan(state, PROFILES);
  saveState();
  refreshOutputs();
  renderImplementation();
});

els.implementationSection.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-impl-action]");
  if (!btn) return;
  if (btn.dataset.implAction === "add-allocation") {
    state.plan.implementation.allocations = [
      ...state.plan.implementation.allocations, createAllocation(state.plan.implementation.allocations),
    ];
  } else if (btn.dataset.implAction === "remove-allocation") {
    state.plan.implementation.allocations = state.plan.implementation.allocations.filter((a) => a.id !== btn.dataset.alid);
  } else {
    return;
  }
  state = clampAllToPlan(state, PROFILES);
  saveState();
  refreshOutputs();
  renderImplementation();
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
  superContributions: () => `<th>Label</th><th>Type</th>${isCouple() ? "<th>Owner</th>" : ""}<th>Account</th><th>Basis</th><th>Amount / detail</th><th>Freq</th><th>From</th><th>To</th><th>FHSSS</th>`,
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
  // Surplus/deficit allocation spec, Commit 1: settings.surplus is now
  // a list of periods (model + engine only in this commit) — the old
  // single-destination mode/assetId select is gone. A real period
  // editor is Commit 2's own scope ("Allocation UI"); this is a safe,
  // honest placeholder for the gap between the two, not the finished
  // feature — it never writes the old {mode, assetId} shape, which
  // normaliseSettings no longer reads at all.
  const periodCount = s.surplus.periods.length;
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
        <p class="helper-text">${periodCount} period${periodCount === 1 ? "" : "s"} configured. Once a year, at the end of each financial year, whatever is sitting in the Working Cash Account above its minimum is allocated per the period covering that year. A full period editor is coming; this scenario's allocation is unchanged from before.</p>
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
  if (field === "wcaBalance") {
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
    case "fhsssEligible":
      row.fhsssEligible = el.checked;
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

// Whether any surplus period's allocation list targets this asset —
// replaces the old single settings.surplus.assetId check now that a
// period can allocate to several destinations at once.
function isSurplusAllocationTarget(settings, assetId) {
  return (settings.surplus?.periods ?? []).some((p) =>
    (p.allocations ?? []).some((a) => a.targetType === "asset" && a.targetId === assetId));
}

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
      const wasSurplusTarget = isSurplusAllocationTarget(state.settings, aid) && e.target.checked === false;
      if (wasSurplusTarget) {
        const ok = window.confirm(`"${a.name}" is a surplus allocation target. Excluding it drops that allocation — its share falls back to the period's remainder. Continue?`);
        if (!ok) { e.target.checked = true; return; }
      }
      a.include = e.target.checked;
      state.settings = normaliseSettings(state.settings, state.assets, state.plan, {
        liabilities: state.liabilities, goals: state.goals, superContributions: state.cashflows.superContributions,
      });
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
      const isSurplusTarget = isSurplusAllocationTarget(state.settings, aid);
      const affectedRows = cashflowRowsForAsset(state, aid);
      // No attached cashflow rows (the common case — lifestyle assets
      // never have any, per D2) — a plain confirm is enough; nothing
      // to reassign or delete. Otherwise never orphan those rows
      // silently: require an explicit reassign-or-delete choice (audit
      // follow-up B1 — this used to cascade-delete unconditionally).
      if (affectedRows.length === 0) {
        const msg = isSurplusTarget
          ? `Remove "${a.name}"? It is a surplus allocation target — that allocation will drop, falling back to the period's remainder.`
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
    ? `<p>It is also a surplus allocation target — that allocation will drop, falling back to the period's remainder.</p>` : "";
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
  state.settings = normaliseSettings(state.settings, state.assets, state.plan, {
    liabilities: state.liabilities, goals: state.goals, superContributions: state.cashflows.superContributions,
  }); // appends to funding order
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
  const loanNominal = (p.lvrPct / 100) * nominalPrice;
  const lmi = p.lmiOverride != null ? p.lmiOverride : (p.firstHomeGuarantee ? 0 : lmiPremium(p.lvrPct, loanNominal));
  const lmiCash = p.lvrPct > 80 && p.lmiPayAtSettlement ? lmi : 0;
  const cash = nominalPrice * (1 - p.lvrPct / 100) + duty + (p.purchaseCostsPct / 100) * nominalPrice - fhog + lmiCash;
  const capExceeded = p.firstHomeGuarantee && fhbgPriceCapExceeded(p.state, nominalPrice);
  const lmiNote = lmi > 0
    ? ` · LMI ≈ ${fmtMoney(lmi)}${p.lmiPayAtSettlement ? " (paid at settlement)" : " (capitalised into the loan)"}`
    : (p.lvrPct > 80 && p.firstHomeGuarantee ? " · LMI waived (First Home Guarantee)" : "");
  if (capExceeded) {
    return {
      warn: true,
      text: `Projected price at purchase (age ${resolved.age}, ${resolved.fyLabel}): ` +
        `${fmtMoney(nominalPrice)} · duty ≈ ${fmtMoney(duty)}${fhog ? ` · FHOG ${fmtMoney(fhog)}` : ""}` +
        `${lmiNote} · cash required ≈ ${fmtMoney(cash)}. Exceeds the ${p.state} First Home Guarantee price cap ` +
        `(≈ ${fmtMoney(FHBG_PRICE_CAPS[p.state])}, indicative — confirm current eligibility); LMI is still shown ` +
        `waived here but a real application may be refused.`,
    };
  }
  return {
    warn: false,
    text: `Projected price at purchase (age ${resolved.age}, ${resolved.fyLabel}): ` +
      `${fmtMoney(nominalPrice)} · duty ≈ ${fmtMoney(duty)}${fhog ? ` · FHOG ${fmtMoney(fhog)}` : ""}${lmiNote} · cash required ≈ ${fmtMoney(cash)}`,
  };
}

// Usable equity and borrowing capacity (Commit 3) — every OTHER
// property, for the "source" select on a planned purchase's
// depositFromEquity flag. A property can't source its own deposit from
// its own equity (normaliseProperties enforces this too, defensively).
function otherPropertyOptions(p) {
  const others = (state.properties ?? []).filter((x) => x.id !== p.id);
  return `<option value="">None</option>` +
    others.map((x) => `<option value="${x.id}"${x.id === p.depositFromEquitySourcePropertyId ? " selected" : ""}>${escapeHTML(x.name)}</option>`).join("");
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
          ${num("Equity ceiling (%)", "equityCeilingPct", p.equityCeilingPct ?? 80, 'min="0" max="100" step="1"')}
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
            ${p.propertyType === "ppr" ? cell("Release FHSSS at purchase", `<label class="ptg-check"><input type="checkbox"${p.releaseFhsssAtPurchase ? " checked" : ""} data-pid="${p.id}" data-pfield="releaseFhsssAtPurchase" /><span>Yes</span></label>`) : ""}
            ${p.firstHomeBuyer ? cell("First Home Guarantee (waives LMI)", `<label class="ptg-check"><input type="checkbox"${p.firstHomeGuarantee ? " checked" : ""} data-pid="${p.id}" data-pfield="firstHomeGuarantee" /><span>Yes</span></label>`) : ""}
            ${p.lvrPct > 80 ? num("LMI override ($, blank = table)", "lmiOverride", p.lmiOverride ?? "", 'min="0" step="100"') : ""}
            ${p.lvrPct > 80 ? cell("Pay LMI at settlement (default: capitalised)", `<label class="ptg-check"><input type="checkbox"${p.lmiPayAtSettlement ? " checked" : ""} data-pid="${p.id}" data-pfield="lmiPayAtSettlement" /><span>Yes</span></label>`) : ""}
            ${cell("Deposit from another property's equity", `<label class="ptg-check"><input type="checkbox"${p.depositFromEquity ? " checked" : ""} data-pid="${p.id}" data-pfield="depositFromEquity" /><span>Yes</span></label>`)}
            ${p.depositFromEquity ? cell("Source property", `<select data-pid="${p.id}" data-pfield="depositFromEquitySourcePropertyId">${otherPropertyOptions(p)}</select>`) : ""}
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
        ${(projection?.propertyWarnings ?? [])
          .filter((w) => w.type === "insufficientEquity" && w.propertyId === p.id)
          .map((w) => `<p class="helper-warning">${escapeHTML(w.reason)}</p>`)
          .join("")}
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
  else if (field === "releaseFhsssAtPurchase") p.releaseFhsssAtPurchase = e.target.checked;
  else if (field === "firstHomeGuarantee") p.firstHomeGuarantee = e.target.checked;
  else if (field === "lmiOverride") p.lmiOverride = v === "" ? null : clampNumber(v, 0);
  else if (field === "lmiPayAtSettlement") p.lmiPayAtSettlement = e.target.checked;
  else if (field === "expensesDeductible") p.expensesDeductible = e.target.checked;
  else if (field === "depreciation") p.depreciation = clampNumber(v, 0);
  else if (field === "equityCeilingPct") p.equityCeilingPct = clampNumber(v, 0, 100);
  else if (field === "depositFromEquity") p.depositFromEquity = e.target.checked;
  else if (field === "depositFromEquitySourcePropertyId") p.depositFromEquitySourcePropertyId = v || null;
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
  // FHSSS (Document Set Commit 3): only a voluntary contribution — not
  // a spouse contribution, never a dynamic cap-fill (see
  // planState.js's clampSuperContribution for why) — can be flagged
  // eligible, so the checkbox is hidden rather than shown-and-clamped-
  // away for a type/basis it can never apply to.
  const fhsssEligibleAllowed = FHSSS_ELIGIBLE_TYPES.includes(sc.type) && !showFillNote;
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
      <td class="cf-td-fhsss">
        ${fhsssEligibleAllowed
          ? `<label class="ptg-check" title="Voluntary contribution eligible for First Home Super Saver release">
               <input type="checkbox"${sc.fhsssEligible ? " checked" : ""}
                      data-kind="superContributions" data-cfid="${sc.id}" data-field="fhsssEligible" />
             </label>`
          : ""}
      </td>
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
  // Division 293/296 election (Input Usability spec, Commit 1) — moved
  // here from identity, beside the accounts it draws on. Shown
  // regardless of whether any account exists yet (the election is a
  // per-person preference, not tied to a specific account).
  const couple = isCouple();
  const divTaxHTML = `
    ${personDivTaxHTML("client", state.plan.client, couple ? `Client — ${clientName()}` : clientName())}
    ${couple ? personDivTaxHTML("partner", state.plan.partner, `Partner — ${partnerName()}`) : ""}
  `;
  els.superSection.innerHTML = accounts.length === 0
    ? `
      <h2 class="section-heading">Super</h2>
      ${divTaxHTML}
      ${pageEmptyHTML(
        "Add a super account to model accumulation-phase superannuation — balances, contributions, caps, and withdrawals.",
        `<button class="add-row-btn" type="button" data-super-action="add-account">+ Add super account</button>`
      )}
    `
    : `
      <h2 class="section-heading">Super</h2>
      ${divTaxHTML}
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
  // Fixed-rate rollover (Commit 1): the STARTING rate is the fixed
  // rate while rateType is "fixed" — interestRatePct is unused then —
  // this quick summary is the pre-rollover figure; the post-rollover
  // one is shown by liabilityRolloverSummaryHTML below.
  const i = l.rateType === "fixed" ? (l.fixedRatePct ?? 0) / 100 / 12 : monthlyRate(l);
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

// Document Set Commit 5 — extra (repeatable) and one-off (lump-sum)
// loan repayments. Client-anchored, plain-age date fields (not the
// full anchor-dropdown DateRef control every cashflow row gets) — a
// deliberate scope reduction for this nested, per-liability sub-list;
// a DateRef of {kind:"age", age} is still a fully valid, fully
// supported DateRef, just without the "Retirement" etc. shortcuts.
function extraRepaymentRowHTML(lid, er) {
  const age = (ref) => resolveRef(ref, state.plan, projection.schedule, "client").age;
  return `
    <tr class="cf-tr">
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(er.label)}" maxlength="40" data-lid="${lid}" data-erid="${er.id}" data-erfield="label" />
      </td>
      <td class="cf-td-amount">
        <input type="text" inputmode="decimal" class="cf-amount-input" value="${fmtAmountValue(er.amount)}"
               data-lid="${lid}" data-erid="${er.id}" data-erfield="amount" />
      </td>
      <td class="cf-td-freq">
        <select data-lid="${lid}" data-erid="${er.id}" data-erfield="frequency">
          <option value="monthly"${er.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${er.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </td>
      <td class="cf-td-date">
        <input type="number" min="${state.plan.client.currentAge}" max="${state.plan.endAge}" step="1"
               value="${age(er.from)}" aria-label="From age" data-lid="${lid}" data-erid="${er.id}" data-erfield="fromAge" />
      </td>
      <td class="cf-td-date">
        <input type="number" min="${state.plan.client.currentAge}" max="${state.plan.endAge}" step="1"
               value="${age(er.to)}" aria-label="To age" data-lid="${lid}" data-erid="${er.id}" data-erfield="toAge" />
      </td>
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-liab-action="remove-extra" data-lid="${lid}" data-erid="${er.id}">×</button>
      </td>
    </tr>
  `;
}

function oneOffRepaymentRowHTML(lid, or) {
  const age = resolveRef(or.at, state.plan, projection.schedule, "client").age;
  return `
    <tr class="cf-tr">
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(or.label)}" maxlength="40" data-lid="${lid}" data-orid="${or.id}" data-orfield="label" />
      </td>
      <td class="cf-td-amount">
        <input type="text" inputmode="decimal" class="cf-amount-input" value="${fmtAmountValue(or.amount)}"
               data-lid="${lid}" data-orid="${or.id}" data-orfield="amount" />
      </td>
      <td class="cf-td-date">
        <input type="number" min="${state.plan.client.currentAge}" max="${state.plan.endAge}" step="1"
               value="${age}" aria-label="At age" data-lid="${lid}" data-orid="${or.id}" data-orfield="atAge" />
      </td>
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-liab-action="remove-oneoff" data-lid="${lid}" data-orid="${or.id}">×</button>
      </td>
    </tr>
  `;
}

// Fixed-rate rollover (Implementation/Rates spec, Commit 1) — read
// straight off the live projection's own liabilityRollovers, never
// recomputed here. A fixed loan whose rollover never actually fires
// within the current projection (fixedUntil clamps to a year the loan
// is already retired by, or is simply beyond the plan's own end) shows
// as informational text instead of a blank gap.
function liabilityRolloverSummaryHTML(l) {
  if (l.rateType !== "fixed") return "";
  const r = projection?.liabilityRollovers?.[l.id];
  if (!r) {
    const fixedUntilAge = resolveRef(l.fixedUntil, state.plan, projection.schedule, "client").age;
    return `<p class="helper-text">Fixed until age ${fixedUntilAge} — no rollover falls within the current projection while this loan is still open.</p>`;
  }
  return `<p class="helper-text">Rolls over in ${escapeHTML(r.fyLabel)}: ${r.fromRatePct.toFixed(2)}% → ${r.toRatePct.toFixed(2)}% p.a., repayment ${fmtMoney(r.repaymentBefore)}/mo → ${fmtMoney(r.repaymentAfter)}/mo.</p>`;
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
            <label>Rate type</label>
            <div class="seg-toggle">
              <button class="seg-option${l.rateType !== "fixed" ? " active" : ""}" type="button"
                      data-liab-action="rateType" data-lid="${l.id}" data-value="variable">Variable</button>
              <button class="seg-option${l.rateType === "fixed" ? " active" : ""}" type="button"
                      data-liab-action="rateType" data-lid="${l.id}" data-value="fixed">Fixed</button>
            </div>
          </div>
          ${l.rateType === "fixed" ? `
            <div class="cf-cell">
              <label>Fixed rate (% p.a.)</label>
              <input type="number" min="0" max="30" step="0.05" value="${l.fixedRatePct}" data-lid="${l.id}" data-lfield="fixedRatePct" />
            </div>
            <div class="cf-cell">
              <label>Fixed until (age)</label>
              <input type="number" min="${state.plan.client.currentAge}" max="${state.plan.endAge}" step="1"
                     value="${resolveRef(l.fixedUntil, state.plan, projection.schedule, "client").age}"
                     data-lid="${l.id}" data-lfield="fixedUntilAge" />
            </div>
            <div class="cf-cell">
              <label>Revert rate (% p.a.)</label>
              <input type="number" min="0" max="30" step="0.05" value="${l.revertRatePct ?? ""}"
                     placeholder="${(state.assumptions.mortgageRate * 100).toFixed(2)} (assumption)"
                     data-lid="${l.id}" data-lfield="revertRatePct" />
            </div>
          ` : `
            <div class="cf-cell">
              <label>Interest rate (% p.a.)</label>
              <input type="number" min="0" max="30" step="0.05" value="${l.interestRatePct}" data-lid="${l.id}" data-lfield="interestRatePct" />
            </div>
          `}
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
            <label>Interest deductible (%)</label>
            <input type="number" min="0" max="100" step="1" value="${l.deductiblePct}" data-lid="${l.id}" data-lfield="deductiblePct" />
            <p class="helper-text">Deducts against ${l.owner === "joint" ? "both owners'" : "the owner's"} income — 100% for a fully investment loan, 0% for a home loan, or a part-way figure for a mixed-purpose loan.</p>
          </div>
          <div class="cf-cell">
            <label>Relates to / secured by</label>
            <select data-lid="${l.id}" data-lfield="linkedAssetId">${opt(state.assets, l.linkedAssetId)}</select>
          </div>
          <div class="cf-cell">
            <label>Offset account</label>
            <select data-lid="${l.id}" data-lfield="offsetAssetId">${opt(financialAssets, l.offsetAssetId)}</select>
          </div>
          <div class="cf-cell">
            <label>Loan commenced (optional)</label>
            <input type="date" value="${l.commencedOn ?? ""}" data-lid="${l.id}" data-lfield="commencedOn" />
          </div>
        </div>
        ${liabilityRolloverSummaryHTML(l)}
        ${liabilityRepaymentPlansHTML(l)}
      </div>
    </div>
  `;
}

// Document Set Commit 5 — the repeatable extra-repayments list, the
// one-off (lump-sum) repayments list, and (once at least one exists) a
// summary of interest and time saved against the scheduled path.
function liabilityRepaymentPlansHTML(l) {
  const stats = projection?.liabilityRepaymentStats?.[l.id];
  const summary = stats
    ? stats.actualPayoffMonth == null
      ? `<p class="helper-text">Still repaying at the end of the projection — interest/time saved isn't shown until the loan is fully repaid within the projection window.</p>`
      // A lifetime total summed across many years has no single "nominal
      // equivalent" (each year's dollar scales differently) — shown in
      // today's (real) dollars regardless of the Today's/Future toggle.
      : `<p class="helper-text">Repaid ${Math.round(stats.timeSavedMonths / 12 * 10) / 10} years early vs the scheduled path, saving ${fmtMoney(stats.interestSaved)} in interest (today's dollars).</p>`
    : "";
  return `
    <div class="cf-subsection">
      <div class="cf-section-title">Extra repayments</div>
      ${(l.extraRepayments ?? []).length === 0 ? "" : `
        <table class="cf-table">
          <thead><tr><th>Label</th><th>Amount / detail</th><th>Freq</th><th>From (age)</th><th>To (age)</th><th></th></tr></thead>
          <tbody>${l.extraRepayments.map((er) => extraRepaymentRowHTML(l.id, er)).join("")}</tbody>
        </table>
      `}
      <button class="add-row-btn" type="button" data-liab-action="add-extra" data-lid="${l.id}">+ Add extra repayment</button>
      <div class="cf-section-title">One-off (lump-sum) repayments</div>
      ${(l.oneOffRepayments ?? []).length === 0 ? "" : `
        <table class="cf-table">
          <thead><tr><th>Label</th><th>Amount</th><th>At (age)</th><th></th></tr></thead>
          <tbody>${l.oneOffRepayments.map((or) => oneOffRepaymentRowHTML(l.id, or)).join("")}</tbody>
        </table>
      `}
      <button class="add-row-btn" type="button" data-liab-action="add-oneoff" data-lid="${l.id}">+ Add one-off repayment</button>
      ${summary}
    </div>
  `;
}

// HELP-as-liability follow-up fix — its own block, not a Liability
// object: no interest rate, term, repayment schedule, offset or
// drawdown, so most of a loan card's field set would just be disabled.
// Matches Xplan's own structure (HECS-HELP under Liabilities as a
// distinct screen, not a loan row). Fields are just: per person,
// opening balance — everything else (indexation, compulsory repayment,
// closing balance) is the engine's output, shown in the Liabilities
// table below, not entered here.
function helpBlockHTML() {
  const rows = [
    { owner: "client", label: clientName(), person: state.plan.client },
    ...(isCouple() ? [{ owner: "partner", label: partnerName(), person: state.plan.partner }] : []),
  ];
  return `
    <div class="pcard" data-help-block="1">
      <div class="pcard-head">
        <span class="pcard-name">HELP/HECS</span>
        <span class="pcard-meta">Compulsory repayments come out of take-home pay via PAYG each year</span>
      </div>
      <div class="pcard-body">
        <div class="person-grid">
          ${rows.map((r) => `
            <div class="cf-cell">
              <label>${escapeHTML(r.label)} — opening balance ($)</label>
              <input type="number" min="0" step="1000" value="${r.person?.helpBalance ?? 0}"
                     data-help-owner="${r.owner}" />
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderLiabilities() {
  const cards = (state.liabilities ?? []).map(liabilityCardHTML).join("");
  const helpHTML = helpBlockHTML();
  els.liabilitiesSection.innerHTML = cards === ""
    ? `
      <h2 class="section-heading">Liabilities</h2>
      ${helpHTML}
      ${pageEmptyHTML(
        "Add loans and mortgages to project repayments, interest and net assets.",
        `<button class="add-row-btn" type="button" data-liab-action="add">+ Add liability</button>`
      )}
    `
    : `
      <h2 class="section-heading">Liabilities</h2>
      ${helpHTML}
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
  const helpOwner = e.target.dataset.helpOwner;
  if (helpOwner === "client" || helpOwner === "partner") {
    const person = helpOwner === "partner" ? state.plan.partner : state.plan.client;
    if (!person) return;
    state.plan = clampPlan({
      ...state.plan,
      [helpOwner]: { ...person, helpBalance: clampNumber(e.target.value, 0) },
    }, PROFILES);
    state = clampAllToPlan(state, PROFILES);
    saveState();
    refreshOutputs();
    renderLiabilities();
    return;
  }
  const l = findLiability(e.target.dataset.lid);
  if (!l) return;
  const field = e.target.dataset.lfield;
  const erField = e.target.dataset.erfield;
  const orField = e.target.dataset.orfield;
  if (field) {
    if (field === "name") l.name = e.target.value.trim() || l.name;
    else if (field === "type") l.type = e.target.value;
    else if (field === "owner") l.owner = e.target.value;
    else if (field === "balance") l.balance = clampNumber(e.target.value, 0);
    else if (field === "interestRatePct") l.interestRatePct = clampNumber(e.target.value, 0, 30);
    else if (field === "termYears") l.termYears = clampInt(e.target.value, 1, 50);
    else if (field === "ioYears") l.ioYears = clampInt(e.target.value, 1, l.termYears); // never longer than the loan's own term
    else if (field === "deductiblePct") l.deductiblePct = clampNumber(e.target.value, 0, 100);
    else if (field === "linkedAssetId") l.linkedAssetId = e.target.value || null;
    else if (field === "offsetAssetId") l.offsetAssetId = e.target.value || null;
    // Fixed-rate rollover (Commit 1).
    else if (field === "fixedRatePct") l.fixedRatePct = clampNumber(e.target.value, 0, 30);
    else if (field === "fixedUntilAge") l.fixedUntil = { kind: "age", age: clampInt(e.target.value, state.plan.client.currentAge, state.plan.endAge) };
    // Blank clears back to "use the mortgage-rate assumption" — the
    // same override-or-default shape as dutyOverride/lmiOverride.
    else if (field === "revertRatePct") l.revertRatePct = e.target.value === "" ? null : clampNumber(e.target.value, 0, 30);
    else if (field === "commencedOn") l.commencedOn = e.target.value || null; // informational only
  } else if (erField) {
    // Document Set Commit 5 — extra repayment sub-row.
    const er = (l.extraRepayments ?? []).find((x) => x.id === e.target.dataset.erid);
    if (!er) return;
    if (erField === "label") er.label = e.target.value.trim() || er.label;
    else if (erField === "amount") er.amount = clampNumber(e.target.value, 0);
    else if (erField === "frequency") er.frequency = e.target.value === "annual" ? "annual" : "monthly";
    else if (erField === "fromAge") er.from = { kind: "age", age: clampInt(e.target.value, state.plan.client.currentAge, state.plan.endAge) };
    else if (erField === "toAge") er.to = { kind: "age", age: clampInt(e.target.value, state.plan.client.currentAge, state.plan.endAge) };
  } else if (orField) {
    // Document Set Commit 5 — one-off (lump-sum) repayment sub-row.
    const or = (l.oneOffRepayments ?? []).find((x) => x.id === e.target.dataset.orid);
    if (!or) return;
    if (orField === "label") or.label = e.target.value.trim() || or.label;
    else if (orField === "amount") or.amount = clampNumber(e.target.value, 0);
    else if (orField === "atAge") or.at = { kind: "age", age: clampInt(e.target.value, state.plan.client.currentAge, state.plan.endAge) };
  } else {
    return;
  }
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
  } else if (btn.dataset.liabAction === "rateType") {
    const next = btn.dataset.value === "fixed" ? "fixed" : "variable";
    // A nice-to-have on first switch, not a continuous sync: seed the
    // fixed rate from whatever's already entered as the variable rate,
    // so toggling to Fixed doesn't show an unrelated stale default.
    if (next === "fixed" && l.rateType !== "fixed") l.fixedRatePct = l.interestRatePct;
    l.rateType = next;
  } else if (btn.dataset.liabAction === "add-extra") {
    l.extraRepayments = [...(l.extraRepayments ?? []), createExtraRepayment(state.plan, l.extraRepayments ?? [])];
  } else if (btn.dataset.liabAction === "remove-extra") {
    l.extraRepayments = (l.extraRepayments ?? []).filter((x) => x.id !== btn.dataset.erid);
  } else if (btn.dataset.liabAction === "add-oneoff") {
    l.oneOffRepayments = [...(l.oneOffRepayments ?? []), createOneOffRepayment(state.plan)];
  } else if (btn.dataset.liabAction === "remove-oneoff") {
    l.oneOffRepayments = (l.oneOffRepayments ?? []).filter((x) => x.id !== btn.dataset.orid);
  }
  state.liabilities = normaliseLiabilities(state.liabilities, state.plan, state.assets);
  saveState();
  refreshOutputs();
  renderLiabilities();
});

// --- goals (Document Set Commit 6) ------------------------------------------
//
// A goal accrues straight-line from plan start toward its (indexed)
// target, funded either from a named financial asset or from household
// surplus — see deterministic.js's own header for the full mechanics.
// "Spent at the target date" is the accrual itself; there is no
// separate goal-balance ledger to show here beyond the running total
// (goalStats.accrued) and whether it reached the (indexed) target.

function findGoal(gid) {
  return (state.goals ?? []).find((g) => g.id === gid) || null;
}

function goalStatusHTML(g) {
  const stats = projection?.goalStats?.[g.id];
  if (!stats) return "";
  if (stats.achieved) {
    return `<p class="helper-text">On track: ${fmtMoney(stats.accrued)} of ${fmtMoney(stats.targetReal)} accrued by the target date (today's dollars).</p>`;
  }
  const altText = stats.alternativeMonth == null
    ? "at the current funding rate, the target may never be reached"
    : `reachable by ${projection.schedule.fyLabels[Math.min(projection.schedule.planYears - 1, Math.floor(stats.alternativeMonth / 12))]} instead`;
  return `<p class="helper-warning">Short by ${fmtMoney(stats.shortfall)} at the target date (${fmtMoney(stats.accrued)} of ${fmtMoney(stats.targetReal)} accrued, today's dollars) — ${altText}.</p>`;
}

function goalCardHTML(g) {
  const financialAssets = state.assets.filter((a) => a.class !== "lifestyle");
  return `
    <div class="pcard" data-gid="${g.id}">
      <div class="pcard-head">
        <span class="pcard-name">${escapeHTML(g.label)}</span>
        <span class="pcard-meta">${fmtMoney(g.targetAmount)} target</span>
        <button class="pcard-remove" type="button" data-goal-action="remove" data-gid="${g.id}">Remove</button>
      </div>
      <div class="pcard-body">
        <div class="person-grid">
          <div class="cf-cell">
            <label>Label</label>
            <input type="text" maxlength="60" value="${escapeHTML(g.label)}" data-gid="${g.id}" data-gfield="label" />
          </div>
          <div class="cf-cell">
            <label>Target amount ($, today's dollars)</label>
            <input type="number" min="0" step="1000" value="${g.targetAmount}" data-gid="${g.id}" data-gfield="targetAmount" />
          </div>
          <div class="cf-cell">
            <label>Target date</label>
            ${dateRefControlHTML(g.targetAt, "client", `data-gid="${g.id}" data-gfield="targetAt"`, state.plan.client.currentAge, state.plan.endAge)}
          </div>
          <div class="cf-cell">
            <label>Funded from</label>
            <select data-gid="${g.id}" data-gfield="fundedFrom">
              <option value="surplus"${g.fundedFrom === "surplus" ? " selected" : ""}>Household surplus</option>
              ${financialAssets.map((a) => `<option value="${a.id}"${g.fundedFrom === a.id ? " selected" : ""}>${escapeHTML(a.name)}</option>`).join("")}
            </select>
          </div>
          <div class="cf-cell">
            <label>Target indexation</label>
            <select data-gid="${g.id}" data-gfield="indexBasis">
              <option value="none"${g.indexBasis === "none" ? " selected" : ""}>None (fixed nominal)</option>
              <option value="cpi"${g.indexBasis === "cpi" ? " selected" : ""}>CPI</option>
              <option value="awote"${g.indexBasis === "awote" ? " selected" : ""}>Wage index (AWOTE)</option>
            </select>
          </div>
          <div class="cf-cell">
            <label>Additional %</label>
            <input type="number" min="-10" max="10" step="0.1" value="${g.indexExtraPct}" data-gid="${g.id}" data-gfield="indexExtraPct" />
          </div>
        </div>
        ${goalStatusHTML(g)}
      </div>
    </div>
  `;
}

function renderGoals() {
  const goals = state.goals ?? [];
  const cards = goals.map(goalCardHTML).join("");
  els.goalsSection.innerHTML = cards === ""
    ? `
      <h2 class="section-heading">Goals</h2>
      ${pageEmptyHTML(
        "Track named savings goals — a car, a wedding, a deposit — separately from ordinary living expenses.",
        `<button class="add-row-btn" type="button" data-goal-action="add">+ Add goal</button>`
      )}
    `
    : `
      <h2 class="section-heading">Goals</h2>
      <div class="portfolio-stack">${cards}</div>
      <div class="portfolio-actions">
        <button class="btn-text" type="button" data-goal-action="add">+ Add goal</button>
      </div>
    `;
}

els.goalsSection.addEventListener("change", (e) => {
  const g = findGoal(e.target.dataset.gid);
  const field = e.target.dataset.gfield;
  if (!g || !field) return;
  const v = e.target.value;
  if (field === "label") g.label = v.trim() || g.label;
  else if (field === "targetAmount") g.targetAmount = clampNumber(v, 0);
  else if (field === "fundedFrom") g.fundedFrom = v;
  else if (field === "indexBasis") g.indexBasis = ["none", "cpi", "awote"].includes(v) ? v : "cpi";
  else if (field === "indexExtraPct") g.indexExtraPct = clampNumber(v, -10, 10);
  else if (field === "targetAt") {
    if (e.target.dataset.drRole === "anchor") {
      g.targetAt = v === "__age__"
        ? { kind: "age", age: resolveRef(g.targetAt, state.plan, projection.schedule, "client").age }
        : { kind: "anchor", anchorId: v };
    } else {
      const age = clampInt(v, state.plan.client.currentAge, state.plan.endAge);
      g.targetAt = { kind: "age", age };
      flagIfClamped(e.target, age);
    }
  } else {
    return;
  }
  state.goals = normaliseGoals(state.goals, state.plan, state.assets);
  saveState();
  refreshOutputs();
  renderGoals();
});

els.goalsSection.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-goal-action]");
  if (!btn) return;
  if (btn.dataset.goalAction === "add") {
    state.goals = [...(state.goals ?? []), createGoal(state.plan, state.goals ?? [])];
  } else if (btn.dataset.goalAction === "remove") {
    const g = findGoal(btn.dataset.gid);
    if (!g || !window.confirm(`Remove "${g.label}"?`)) return;
    state.goals = (state.goals ?? []).filter((x) => x.id !== g.id);
  } else {
    return;
  }
  state.goals = normaliseGoals(state.goals, state.plan, state.assets);
  saveState();
  refreshOutputs();
  renderGoals();
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
  "money-decomposition": () => els.viewMoneyDecomposition,
  "key-figures": () => els.viewKeyFigures,
  cashflow: () => els.viewCashflow,
  assets: () => els.viewAssets,
  tax: () => els.viewTax,
  super: () => els.viewSuper,
  liabilities: () => els.viewLiabilities,
  snapshot: () => els.viewSnapshot,
  "monte-carlo-table": () => els.viewMonteCarloTable,
  assumptions: () => els.viewAssumptions,
  "focus-deposit": () => els.viewFocusDeposit,
  "focus-fhsss": () => els.viewFocusFhsss,
  "focus-salary-sacrifice": () => els.viewFocusSalarySacrifice,
  "focus-debt-payoff": () => els.viewFocusDebtPayoff,
  "focus-lookups": () => els.viewFocusLookups,
  "focus-equity": () => els.viewFocusEquity,
  "focus-transfer-schedule": () => els.viewFocusTransferSchedule,
  "whatif-rate-shock": () => els.viewWhatIfRateShock,
  "whatif-crash": () => els.viewWhatIfCrash,
  "whatif-income-gap": () => els.viewWhatIfIncomeGap,
  "whatif-expense-shock": () => els.viewWhatIfExpenseShock,
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
  // The Snapshot view picks its own years (up to six DateRef
  // selectors) rather than the thinned report-period range every other
  // table/chart uses, so the shared period-select controls are
  // meaningless here and would just be confusing clutter. Focus views
  // (docs/specs/12-focus-views.md) are one-question pages built around
  // their own relevant date (a purchase date, a release date, a payoff
  // date) rather than the household's whole report period — same reason.
  els.periodSelect.hidden = activeView === "snapshot" || activeView.startsWith("focus-");
  if (activeView === "projection") renderProjectionChart();
  else if (activeView === "composite") renderCompositeChart();
  else if (activeView === "net-assets") renderNetAssetsChart();
  else if (activeView === "asset-balances") renderAssetBalancesChart();
  else if (activeView === "asset-allocation") renderAssetAllocationChart();
  else if (activeView === "monte-carlo") renderMonteCarloView();
  else if (activeView === "super-balances") renderSuperBalancesChart();
  else if (activeView === "liabilities-balances") renderLiabilitiesBalancesChart();
  else if (activeView === "cashflow-bars") renderCashflowBarsChart();
  else if (activeView === "money-decomposition") renderMoneyDecompositionView();
  else if (activeView === "key-figures") renderKeyFiguresView();
  else if (activeView === "cashflow") renderCashflowView();
  else if (activeView === "assets") renderAssetsView();
  else if (activeView === "tax") renderTaxView();
  else if (activeView === "super") renderSuperTableView();
  else if (activeView === "liabilities") renderLiabilitiesView();
  else if (activeView === "snapshot") renderSnapshotView();
  else if (activeView === "monte-carlo-table") renderMonteCarloTableView();
  else if (activeView === "assumptions") renderAssumptionsView();
  else if (activeView === "focus-deposit") renderFocusDepositView();
  else if (activeView === "focus-fhsss") renderFocusFhsssView();
  else if (activeView === "focus-salary-sacrifice") renderFocusSalarySacrificeView();
  else if (activeView === "focus-debt-payoff") renderFocusDebtPayoffView();
  else if (activeView === "focus-lookups") renderFocusLookupsView();
  else if (activeView === "focus-equity") renderFocusEquityView();
  else if (activeView === "focus-transfer-schedule") renderFocusTransferScheduleView();
  else if (activeView === "whatif-rate-shock") renderWhatIfRateShockView();
  else if (activeView === "whatif-crash") renderWhatIfCrashView();
  else if (activeView === "whatif-income-gap") renderWhatIfIncomeGapView();
  else if (activeView === "whatif-expense-shock") renderWhatIfExpenseShockView();
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
  // Fixed-rate rollover (Implementation/Rates spec, Commit 1) — "the
  // rollover is a key date" per the spec: forced into every table/chart
  // the same way a planned property's purchase year already is (not a
  // plan.keyDates entry itself, so it can't go through listAnchors).
  for (const r of Object.values(projection.liabilityRollovers ?? {})) forced.push(r.planYear);
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

  // Goal markers (Document Set Commit 6) — same shape/annotation
  // pattern as key dates above, distinguished by colour (green =
  // reached its target, red = fell short) rather than a separate legend.
  const goalMarks = (state.goals ?? [])
    .map((g) => {
      const stats = projection.goalStats?.[g.id];
      if (!stats) return null;
      const y = Math.min(projection.schedule.planYears - 1, Math.floor(stats.targetMonth / 12));
      if (!yearIdxs.includes(y)) return null;
      return { age: projection.schedule.clientAges[y], label: g.label, achieved: stats.achieved };
    })
    .filter(Boolean);
  const goalShapes = goalMarks.map((k) => ({
    type: "line", xref: "x", x0: k.age, x1: k.age, yref: "paper", y0: 0, y1: 1,
    line: { color: k.achieved ? "rgba(46, 139, 87, 0.55)" : "rgba(180, 40, 40, 0.55)", width: 1.5, dash: "dash" },
  }));
  const goalAnnotations = goalMarks.map((k) => ({
    x: k.age, y: 1, xref: "x", yref: "paper", yanchor: "bottom", xanchor: "left",
    text: `🎯 ${k.label}`, showarrow: false, textangle: -90,
    font: { size: 9, color: k.achieved ? "rgba(46, 139, 87, 0.85)" : "rgba(180, 40, 40, 0.85)" },
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
      ...goalShapes,
    ],
    annotations: [...keyDateAnnotations, ...goalAnnotations],
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

  // Fixed-rate rollover (Implementation/Rates spec, Commit 1) — "the
  // rollover is a key date... and annotates charts automatically", the
  // same thin dashed-rule + label pattern as the composite chart's own
  // key-date/goal markers, applied here since this is the debt-specific
  // chart the rollover most concretely affects.
  const rolloverMarks = Object.entries(projection.liabilityRollovers ?? {})
    .filter(([, r]) => yearIdxs.includes(r.planYear))
    .map(([lid, r]) => ({ age: projection.schedule.clientAges[r.planYear], label: `${loanName(lid)} rolls over` }));
  const rolloverShapes = rolloverMarks.map((k) => ({
    type: "line", xref: "x", x0: k.age, x1: k.age, yref: "paper", y0: 0, y1: 1,
    line: { color: "rgba(217, 123, 47, 0.55)", width: 1.5, dash: "dot" },
  }));
  const rolloverAnnotations = rolloverMarks.map((k) => ({
    x: k.age, y: 1, xref: "x", yref: "paper", yanchor: "bottom", xanchor: "left",
    text: k.label, showarrow: false, textangle: -90,
    font: { size: 9, color: "rgba(217, 123, 47, 0.9)" },
  }));

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
    shapes: rolloverShapes,
    annotations: rolloverAnnotations,
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
  // Its own band, not folded into "living" — one of the largest
  // cashflow items this client base faces (spec's own words).
  { key: "education", name: "Education", color: "#4a6fa5" },
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
  const incomeSums = yearIdxs.map((y) => incomeCategorySums(y));
  const expenseSums = yearIdxs.map((y) => expenseCategorySums(y));

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

// --- View: Where the money went (Implementation/Rates spec, Commit 4) -------
//
// Every figure below is read straight off `projection.yearly[y].decomposition`
// / `.cumulativeDecomposition` — deterministic.js's own post-pass, itself
// built from conservationCheck.js's decomposeNetWorthChange (the SAME
// terms the conservation invariant asserts over). Never re-derived here.

// The engine reports each year's OWN opening/closing net worth via
// `netAssets`, but not the very first year's opening figure as a named
// field (it's implicit in the year-0 row's own components) — same
// derivation deterministic.js's post-pass and its own test use.
function openingNetWorthAt(y) {
  const row = projection.yearly[y];
  if (y > 0) return projection.yearly[y - 1].netAssets;
  return row.openingBalance + row.wcaDetail.opening
    + Object.values(row.superDetail).reduce((s, v) => s + v.opening, 0)
    - Object.values(row.liabilities).reduce((s, v) => s + v.opening, 0);
}

function buildMoneyDecompositionGroups() {
  const walk = [
    { label: "Opening net worth", cell: (y) => openingNetWorthAt(y), always: true },
    { label: "+ Income", cell: (y) => projection.yearly[y].decomposition.income },
    { label: "+ Investment growth", cell: (y) => projection.yearly[y].decomposition.growth },
    { label: "− Tax", cell: (y) => -projection.yearly[y].decomposition.tax },
    { label: "− Expenses", cell: (y) => -projection.yearly[y].decomposition.expenses },
    { label: "− Interest", cell: (y) => -projection.yearly[y].decomposition.interest },
    { label: "− Fees", cell: (y) => -projection.yearly[y].decomposition.fees },
    { label: "± One-offs (property costs/FHOG, goals)", cell: (y) => projection.yearly[y].decomposition.oneOffs },
    { label: "Closing net worth", cell: (y) => projection.yearly[y].netAssets, always: true, cls: "tl-total" },
  ];
  const cumulative = [
    { label: "Cumulative income", cell: (y) => projection.yearly[y].cumulativeDecomposition.income },
    { label: "Cumulative investment growth", cell: (y) => projection.yearly[y].cumulativeDecomposition.growth },
    { label: "Cumulative tax", cell: (y) => -projection.yearly[y].cumulativeDecomposition.tax },
    { label: "Cumulative expenses", cell: (y) => -projection.yearly[y].cumulativeDecomposition.expenses },
    { label: "Cumulative interest", cell: (y) => -projection.yearly[y].cumulativeDecomposition.interest },
    { label: "Cumulative fees", cell: (y) => -projection.yearly[y].cumulativeDecomposition.fees },
    { label: "Cumulative one-offs", cell: (y) => projection.yearly[y].cumulativeDecomposition.oneOffs },
  ];
  return [
    { title: "This year's change in net worth", rows: walk },
    { title: "Cumulative since the projection started", rows: cumulative },
  ];
}

function moneyWentCaptionHTML() {
  const parts = [];
  if (projection.wealthCrossoverYear != null) {
    parts.push(`Cumulative investment growth first overtakes cumulative income in ${escapeHTML(yearHeaderText(projection.wealthCrossoverYear))} — the point a long accumulation starts compounding faster than it's being fed.`);
  }
  parts.push("Platform/ICR fees are already netted into each asset's own return rate at the source and can't be separately broken out — they're absorbed into growth here, not double-counted, a disclosed simplification.");
  return `<p class="chart-note-inline">${parts.join(" ")}</p>`;
}

// The waterfall year — index into projection.yearly. Reset whenever it
// falls outside the currently selected (period-thinned) range, same
// convention as focusDebtPayoffLoanId resetting when its own list changes.
let moneyDecompositionYear = null;

function renderMoneyDecompositionView() {
  const yearIdxs = selectedYearIndices();
  if (yearIdxs.length === 0) {
    els.viewMoneyDecomposition.innerHTML = `<p class="helper-text" style="padding:24px 8px;">Nothing to show for this scenario yet.</p>`;
    return;
  }
  if (moneyDecompositionYear == null || !yearIdxs.includes(moneyDecompositionYear)) {
    moneyDecompositionYear = yearIdxs[yearIdxs.length - 1];
  }
  const yearOptions = yearIdxs.map((y) =>
    `<option value="${y}"${y === moneyDecompositionYear ? " selected" : ""}>${escapeHTML(yearHeaderText(y))}</option>`
  ).join("");
  els.viewMoneyDecomposition.innerHTML = `
    <div class="focus-section">
      <h3>Net worth walk, projection start → selected year</h3>
      <label>Through
        <select id="moneyDecompositionYearSelect">${yearOptions}</select>
      </label>
      <div id="moneyDecompositionChart"></div>
    </div>
    <div id="moneyDecompositionTable"></div>
  `;
  renderMoneyDecompositionChart();
  renderTransposed($("moneyDecompositionTable"), buildMoneyDecompositionGroups(), moneyWentCaptionHTML());
}

function renderMoneyDecompositionChart() {
  const el = $("moneyDecompositionChart");
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const y = moneyDecompositionYear;
  const factor = displayFactor(endMonthOfYear(y));
  const c = projection.yearly[y].cumulativeDecomposition;
  const opening = openingNetWorthAt(0) * factor;
  const closing = projection.yearly[y].netAssets * factor;

  Plotly.react(el, [{
    type: "waterfall",
    x: ["Opening", "Income", "Growth", "Tax", "Expenses", "Interest", "Fees", "One-offs", "Closing"],
    measure: ["absolute", "relative", "relative", "relative", "relative", "relative", "relative", "relative", "total"],
    y: [
      opening,
      c.income * factor, c.growth * factor,
      -c.tax * factor, -c.expenses * factor, -c.interest * factor, -c.fees * factor,
      c.oneOffs * factor,
      closing,
    ],
    connector: { line: { color: "rgba(0,0,0,0.25)" } },
    decreasing: { marker: { color: "#dc5a28" } },
    increasing: { marker: { color: "#1c5ab4" } },
    totals: { marker: { color: "#222" } },
    hovertemplate: "%{x}<br>%{y:$,.0f}<extra></extra>",
  }], {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    showlegend: false,
    yaxis: {
      title: { text: `Net worth (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false,
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

function exportMoneyDecompositionCSV() {
  exportTransposedCSV("money-decomposition", buildMoneyDecompositionGroups());
}

els.viewMoneyDecomposition.addEventListener("change", (e) => {
  if (e.target.id !== "moneyDecompositionYearSelect") return;
  moneyDecompositionYear = Number(e.target.value);
  renderMoneyDecompositionChart();
  renderTransposed($("moneyDecompositionTable"), buildMoneyDecompositionGroups(), moneyWentCaptionHTML());
});

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
  // HELP-as-liability follow-up fix: HELP/HECS entries aren't Liability
  // objects (state.liabilities) or purchase loans (state.properties) —
  // they're their own kind of row, keyed help_<person> in the engine's
  // output only (see deterministic.js). Real names, same as everywhere
  // else in this file.
  if (lid === "help_client") return `${clientName()} — HELP/HECS`;
  if (lid === "help_partner") return `${partnerName()} — HELP/HECS`;
  return (state.liabilities ?? []).find((l) => l.id === lid)?.name
    ?? ((state.properties ?? []).find((pr) => `prop-${pr.id}` === lid)
      ? `${(state.properties ?? []).find((pr) => `prop-${pr.id}` === lid).name} loan`
      : "Loan");
}

// Thin adapters over src/cashflowCategories.js's pure functions —
// main.js owns the DOM/Plotly-dependent rendering, cashflowCategories.js
// owns the (unit-tested) arithmetic. See that module's header comment
// for why the split exists.
function financialAssetIds(s = state) {
  return s.assets.filter((a) => a.class !== "lifestyle").map((a) => a.id);
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
// Both take an optional {state, projection} ctx — defaulting to the
// active workspace's own globals, unchanged for every existing call
// site — so Scenario comparison (Implementation/Rates spec, Commit 6)
// can run the SAME functions against another scenario's (state,
// projection) pair without a second, drift-prone copy of this logic.
function incomeCategorySums(y, ctx = { state, projection }) {
  const { state: s, projection: p } = ctx;
  return incomeCategorySumsPure(
    p.yearly[y], s.cashflows.income, p.schedule.rowTotals.income,
    s.properties, p.schedule.oneOffsByAssetYear, financialAssetIds(s),
    s.plan.superAccounts, y
  );
}

function expenseCategorySums(y, ctx = { state, projection }) {
  const { state: s, projection: p } = ctx;
  return expenseCategorySumsPure(
    p.yearly[y], s.cashflows.expenses, p.schedule.rowTotals.expenses,
    s.properties, p.schedule.oneOffsByAssetYear, financialAssetIds(s),
    s.plan.superAccounts, y,
    flatEducationBlocks(s.plan), p.schedule.rowTotals.education
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

// Takes an optional {state, projection} ctx (see incomeCategorySums'
// own comment) — Scenario comparison (Commit 6) is what needs it;
// every pre-Commit-6 call site is unaffected (same default globals).
function buildKeyFiguresGroups(ctx = { state, projection }) {
  const { projection: p } = ctx;
  const yl = p.yearly;
  const totalAssets = (y) => yl[y].closingBalance + yl[y].propertyClosing + yl[y].superClosing + yl[y].wcaClosing;
  const totalIncome = (y) => {
    const s = incomeCategorySums(y, ctx);
    return s.employment + s.rental + s.investment + s.wcaInterest + s.other;
  };
  const totalExpenses = (y) => {
    const s = expenseCategorySums(y, ctx);
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
    // Document Set Commit 1 — joins the table only while any HELP debt
    // exists (no `always: true`, unlike every row above): a client
    // with no HELP balance never sees this row at all.
    {
      label: "HELP balance",
      cell: (y) => (yl[y].taxDetail.client?.helpBalanceClosing ?? 0) + (yl[y].taxDetail.partner?.helpBalanceClosing ?? 0),
    },
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
    educationBlocks: flatEducationBlocks(state.plan), rowTotalsEducation: rt.education,
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
    { label: "Education Fees", cell: (y) => -stmt(y).expenses.education },
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

  const groups = [
    { title: "Assessable Income", rows: assessableRows },
    { title: "Deductions", rows: deductionSectionRows },
    { title: "Tax", rows: taxSectionRows },
    { title: "Cash Received", rows: cashReceivedRows },
    { title: "Expenses", rows: expenseSectionRows },
  ];
  // Document Set Commit 6 — Goals get their OWN group, matching the
  // workbook's separate Goals block: tracked apart from ordinary
  // living expenses even though a goal contribution is, mechanically,
  // a household cash outflow.
  const goalRows = state.goals ?? [];
  if (goalRows.length) {
    const rows = goalRows.map((g) => ({ label: g.label, cell: (y) => -(yl[y].goals?.[g.id]?.contribution ?? 0) }));
    rows.push({ label: "Total goal contributions", always: true, cls: "tl-total",
      cell: (y) => -goalRows.reduce((s, g) => s + (yl[y].goals?.[g.id]?.contribution ?? 0), 0) });
    groups.push({ title: "Goals", rows });
  }
  if (oneOffRows.length) groups.push({ title: "One-off amounts", rows: oneOffRows });
  // Surplus/deficit allocation spec: with multiple periods/destinations
  // possible in a single year, a single named target no longer applies
  // — Commit 3 ("Outputs") breaks the surplus row into one line per
  // destination; this aggregate view is the interim shape.
  groups.push({ title: "Funding", rows: [
    { label: "Surplus invested", cell: (y) => yl[y].surplusInvested },
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

function liabilityDetailRows(get, opts = {}) {
  return [
    { label: "Opening balance", cell: (y) => get(y).opening, always: true },
    { label: "Drawdowns", cell: (y) => get(y).drawdown },
    { label: "Interest", cell: (y) => -get(y).interest },
    // HELP-as-liability follow-up fix: a liability increase with no cash
    // movement — always 0 (and hidden by the all-zero-rows convention)
    // for an ordinary loan, since its nominal balance is never indexed;
    // genuinely populated only for HELP/HECS.
    { label: "Indexation", cell: (y) => get(y).indexation ?? 0 },
    { label: opts.help ? "Compulsory repayment" : "Principal repaid", cell: (y) => -get(y).principal },
    // Document Set Commit 5 — extra and one-off (lump-sum) repayments,
    // combined into the same figure the engine already applies against
    // the balance each month. Zero (and so hidden by the all-zero-rows
    // convention) for a loan with no extra/one-off repayments configured.
    { label: "Extra repayments", cell: (y) => -get(y).extraRepayment },
    { label: "Offset balance applied", cell: (y) => get(y).offsetApplied },
    // Fixed-rate rollover (Implementation/Rates spec, Commit 1) — the
    // nominal annual rate actually applying that year. Suppressed in
    // the "Combined" (all-loans-summed) view: summing a PERCENTAGE
    // across loans is meaningless, unlike every other row here which is
    // a genuine dollar figure. A HELP/HECS row (opts.help) genuinely
    // shows 0% throughout — it charges no interest, only indexation
    // (its own row above).
    ...(opts.combined ? [] : [{ label: "Interest rate (% p.a., nominal)", cell: (y) => get(y).ratePct ?? 0, pct: true }]),
  ];
}

function liabilitiesPayoffFooter(liabIds) {
  if (liabIds.length === 0) return "";
  const lines = liabIds.map((lid) => `${escapeHTML(loanName(lid))}: paid off ${liabilityPayoffLabel(lid)}`);
  // Document Set Commit 5 — interest/time saved vs the scheduled
  // (no-extras) path, for every liability with a repayment plan that
  // actually retired the loan within the projection.
  const savedLines = liabIds
    .map((lid) => ({ lid, stats: projection.liabilityRepaymentStats?.[lid] }))
    .filter(({ stats }) => stats && stats.actualPayoffMonth != null)
    .map(({ lid, stats }) =>
      `${escapeHTML(loanName(lid))}: ${Math.round(stats.timeSavedMonths / 12 * 10) / 10} years early, ` +
      `${fmtMoney(stats.interestSaved)} interest saved (today's dollars) vs the scheduled path`
    );
  return `<div class="ledger-foot">${lines.join(" · ")}</div>` +
    (savedLines.length ? `<div class="ledger-foot">${savedLines.join(" · ")}</div>` : "");
}

function buildLiabilitiesGroups(entity) {
  const yl = projection.yearly;
  const liabIds = Object.keys(yl[0]?.liabilities ?? {});
  const zero = { opening: 0, drawdown: 0, interest: 0, principal: 0, offsetApplied: 0, closing: 0, extraRepayment: 0, indexation: 0, ratePct: 0 };

  if (entity === "all") {
    const combined = liabilityDetailRows((y) => liabIds.reduce((s, lid) => {
      const d = yl[y].liabilities[lid] ?? zero;
      for (const k in s) s[k] += d[k] ?? 0;
      return s;
    }, { ...zero }), { combined: true });
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
  const rows = liabilityDetailRows((y) => yl[y].liabilities[entity] ?? zero, { help: entity.startsWith("help_") });
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

// --- View: Snapshot (Document Set Commit 7) -------------------------------
//
// The firm's Cash Flow SOA sheet reproduced for a handful of chosen
// years — one column per selected year, Client/Partner/Total
// sub-columns, reusing cashflowStatement.js's per-owner breakdown so
// every figure here reconciles to the Cashflow table for that year by
// construction (buildSnapshotColumns/buildSnapshotTable in
// snapshot.js). Year selections persist per scenario (state.display.
// snapshotYears); export is HTML (clipboard, retains table structure
// when pasted into Word) and CSV — explicitly not .docx generation,
// per the spec.

// Smart default: current year, retirement, and up to four more spread
// evenly across the projection — deduplicated against those two and
// against each other by buildSnapshotColumns itself.
function defaultSnapshotYears() {
  const n = projection.schedule.planYears;
  const retirementY = resolveRef({ kind: "anchor", anchorId: "retirement-client" }, state.plan, projection.schedule, "client").planYear;
  const picks = new Set([0, Math.max(0, Math.min(n - 1, retirementY))]);
  for (let i = 1; i <= 4; i++) picks.add(Math.round((i * (n - 1)) / 5));
  return [...picks].filter((y) => y >= 0 && y < n).sort((a, b) => a - b).slice(0, MAX_SNAPSHOT_YEARS)
    .map((y) => ({ kind: "age", age: projection.schedule.clientAges[y] }));
}

function ensureSnapshotYears() {
  if (!(state.display.snapshotYears?.length > 0)) {
    state.display.snapshotYears = defaultSnapshotYears();
    saveState();
  }
}

function snapshotCtxFor(y) {
  const rt = projection.schedule.rowTotals;
  return {
    incomeRows: state.cashflows.income, rowTotalsIncome: rt.income,
    expenseRows: state.cashflows.expenses, rowTotalsExpenses: rt.expenses,
    deductionRows: state.cashflows.deductions ?? [], rowTotalsDeductions: rt.deductions,
    properties: state.properties ?? [], liabilities: state.liabilities ?? [],
    superAccounts: state.plan.superAccounts ?? [], y,
    educationBlocks: flatEducationBlocks(state.plan), rowTotalsEducation: rt.education,
  };
}

function snapshotResolvedPlanYears() {
  return (state.display.snapshotYears ?? [])
    .map((ref) => resolveRef(ref, state.plan, projection.schedule, "client").planYear);
}

function renderSnapshotYearPicker() {
  const years = state.display.snapshotYears ?? [];
  const rows = years.map((ref, i) => `
    <div class="cf-cell">
      <label>Year ${i + 1}</label>
      <div class="snap-year-row">
        ${dateRefControlHTML(ref, "client", `data-snap-idx="${i}"`, state.plan.client.currentAge, state.plan.endAge)}
        <button class="cf-remove" type="button" aria-label="Remove year" data-snap-action="remove" data-snap-idx="${i}">×</button>
      </div>
    </div>
  `).join("");
  const addBtn = years.length < MAX_SNAPSHOT_YEARS
    ? `<button class="add-row-btn" type="button" data-snap-action="add">+ Add year</button>` : "";
  els.snapshotYearPicker.innerHTML = `
    <div class="person-grid">${rows}</div>
    ${addBtn}
    <div class="output-actions">
      <button class="btn-text" type="button" id="snapshotCopyBtn">Copy for Word</button>
    </div>
  `;
}

function renderSnapshotView() {
  ensureSnapshotYears();
  renderSnapshotYearPicker();
  const planYears = snapshotResolvedPlanYears();
  const couple = isCouple();
  const columns = buildSnapshotColumns(projection.yearly, snapshotCtxFor, planYears, couple);
  if (columns.length === 0) {
    els.snapshotTable.innerHTML = `<p class="helper-text" style="padding:24px 8px;">Add at least one year above to see the snapshot.</p>`;
    return;
  }
  const table = buildSnapshotTable(columns, { hideEmptyRows: state.display.hideEmptyRows !== false });
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const headCols = columns.flatMap((c) => {
    const label = projection.schedule.fyLabels[c.y];
    return couple ? [`${label} — ${clientName()}`, `${label} — ${partnerName()}`, `${label} — Total`] : [label];
  });
  const head = `<tr><th class="tl-corner"></th>${headCols.map((h) => `<th class="tl-year">${escapeHTML(h)}</th>`).join("")}</tr>`;
  let lastSection = null;
  const body = table.rows.map((r) => {
    const sectionRow = r.section !== lastSection
      ? `<tr class="tl-group"><th colspan="${headCols.length + 1}">${escapeHTML(r.section)}</th></tr>` : "";
    lastSection = r.section;
    const cells = table.rows.length && columns.map((c, i) => {
      const cell = r.cells[i];
      const f = factor(c.y);
      return couple
        ? `<td class="tl-num">${fmtLedgerCell(cell.client * f)}</td><td class="tl-num">${fmtLedgerCell(cell.partner * f)}</td><td class="tl-num">${fmtLedgerCell(cell.total * f)}</td>`
        : `<td class="tl-num">${fmtLedgerCell(cell.total * f)}</td>`;
    }).join("");
    return sectionRow + `<tr class="${r.total ? "tl-total" : ""}"><th class="tl-label">${escapeHTML(r.label)}</th>${cells}</tr>`;
  }).join("");
  els.snapshotTable.innerHTML = `<div class="tl-wrap"><table class="tl"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function snapshotColumnLabels() {
  return snapshotResolvedPlanYears()
    .filter((y, i, arr) => y >= 0 && y < projection.yearly.length && arr.indexOf(y) === i)
    .map((y) => projection.schedule.fyLabels[y]);
}

// Real → nominal scaling applied at export time too, matching what's
// on screen — the export must show exactly what the visible table shows.
function snapshotExportTable() {
  const planYears = snapshotResolvedPlanYears();
  const couple = isCouple();
  const columns = buildSnapshotColumns(projection.yearly, snapshotCtxFor, planYears, couple);
  const scaled = columns.map((c) => {
    const f = factorFor(c.y);
    const scaleStmt = (s) => s && JSON.parse(JSON.stringify(s), (k, v) => typeof v === "number" ? v * f : v);
    return { y: c.y, client: scaleStmt(c.client), partner: scaleStmt(c.partner), total: scaleStmt(c.total) };
  });
  return { table: buildSnapshotTable(scaled, { hideEmptyRows: state.display.hideEmptyRows !== false }), couple };
}
function factorFor(y) { return displayFactor(endMonthOfYear(y)); }

els.snapshotYearPicker?.addEventListener("change", (e) => {
  const idx = Number(e.target.dataset.snapIdx);
  if (Number.isNaN(idx)) return;
  const years = [...(state.display.snapshotYears ?? [])];
  const ref = years[idx];
  if (!ref) return;
  if (e.target.dataset.drRole === "anchor") {
    years[idx] = e.target.value === "__age__"
      ? { kind: "age", age: resolveRef(ref, state.plan, projection.schedule, "client").age }
      : { kind: "anchor", anchorId: e.target.value };
  } else {
    const age = clampInt(e.target.value, state.plan.client.currentAge, state.plan.endAge);
    years[idx] = { kind: "age", age };
    flagIfClamped(e.target, age);
  }
  state.display.snapshotYears = clampSnapshotYears(years, state.plan);
  saveState();
  renderSnapshotView();
});

els.snapshotYearPicker?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-snap-action]");
  if (btn) {
    const years = [...(state.display.snapshotYears ?? [])];
    if (btn.dataset.snapAction === "add" && years.length < MAX_SNAPSHOT_YEARS) {
      years.push({ kind: "age", age: state.plan.endAge });
    } else if (btn.dataset.snapAction === "remove") {
      years.splice(Number(btn.dataset.snapIdx), 1);
    } else {
      return;
    }
    state.display.snapshotYears = clampSnapshotYears(years, state.plan);
    saveState();
    renderSnapshotView();
    return;
  }
  if (e.target.id === "snapshotCopyBtn") {
    const { table, couple } = snapshotExportTable();
    const html = snapshotToHTML(table, snapshotColumnLabels(), couple);
    const plain = table.rows.map((r) => r.label).join("\n");
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]).then(() => {
        e.target.textContent = "Copied!";
        setTimeout(() => { e.target.textContent = "Copy for Word"; }, 1500);
      }).catch(() => window.alert("Couldn't access the clipboard — try again, or use Export CSV instead."));
    } else {
      window.alert("Clipboard access isn't available in this browser — use Export CSV instead.");
    }
  }
});

function exportSnapshotCSV() {
  const { table, couple } = snapshotExportTable();
  const csv = snapshotToCSV(table, snapshotColumnLabels(), couple);
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${exportNameBase()}-snapshot.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
      { label: "HELP repayment", cell: (y) => -(td(y, p)?.helpRepayment ?? 0) },
      { label: "HELP balance (closing)", cell: (y) => td(y, p)?.helpBalanceClosing ?? 0 },
      { label: "Medicare levy surcharge", cell: (y) => -(td(y, p)?.medicareLevySurcharge ?? 0) },
      { label: "FHSSS release (gross)", cell: (y) => td(y, p)?.fhsssRelease ?? 0 },
      { label: "FHSSS tax offset (30%)", cell: (y) => td(y, p)?.fhsssOffset ?? 0 },
    ],
  });
  const groups = [personGroup("client", clientName())];
  if (isCouple()) groups.push(personGroup("partner", partnerName()));
  groups.push({
    title: "Household",
    rows: [
      { label: "Division 293 tax payable", cell: (y) => -yl[y].taxDetail.div293 },
      { label: "Division 296 tax payable", cell: (y) => -yl[y].taxDetail.div296 },
      { label: "HELP repayment", cell: (y) => -(yl[y].taxDetail.helpRepayment ?? 0) },
      { label: "Medicare levy surcharge", cell: (y) => -(yl[y].taxDetail.medicareLevySurcharge ?? 0) },
      { label: "FHSSS release (gross)", cell: (y) => yl[y].taxDetail.fhsssRelease ?? 0 },
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
  // Shown only when FHSSS is actually in play — unlike CPI/AWOTE this
  // rate is a constant % every year regardless of use, so it would
  // never all-zero-hide on its own the way an unused per-row figure
  // does (Outputs convention: all-zero rows hidden).
  const fhsssInUse = (state.cashflows.superContributions ?? []).some((c) => c.fhsssEligible)
    || (state.properties ?? []).some((p) => p.releaseFhsssAtPurchase);
  if (fhsssInUse) {
    economic.push({ label: "FHSSS associated earnings rate (% p.a. nominal)", cell: () => (state.assumptions.fhsssEarningsRate ?? 0.0794) * 100, pct: true, always: true });
  }
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

// --- View: Focus (docs/specs/12-focus-views.md) -----------------------------
//
// The governing principle: a Focus view is a VIEW, never a separate
// calculation. Every figure below is read straight off `projection`
// (the SAME projectPlan() output every Graphs/Tables view reads) or
// computed via src/solve.js, which itself only ever runs the real
// engine against a cloned plan — never a shortcut formula, never an
// input that bypasses the plan. Six commits build these out in order;
// each view falls back to this same one-line empty state (what it
// answers, what input it needs) until its own commit lands, and again
// afterwards whenever the plan genuinely has nothing for it to show.

// A Focus view's empty state names what it answers and, where the
// answer needs plan input that doesn't exist yet, offers a direct hop
// to the input section that would add it — one click, not "go find the
// Property page yourself". `inputSection` is null for a view (like the
// standalone lookups) that takes no plan input at all.
function focusEmptyStateHTML(sentence, inputSection) {
  return pageEmptyHTML(
    sentence,
    inputSection
      ? `<button class="btn-text" type="button" data-focus-action="go-to-input" data-input-section="${inputSection}">Go to ${escapeHTML(SECTION_LABELS[inputSection] ?? "input")}</button>`
      : ""
  );
}

els.outputCanvas.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-focus-action="go-to-input"]');
  if (!btn) return;
  const { client, scenario } = findActive(workspace);
  navigate({ page: "workspace", clientId: client.id, scenarioId: scenario.id, area: "input", section: btn.dataset.inputSection });
});

// --- Commit 2: Deposit & home purchase --------------------------------------
//
// Every figure below is read straight off `projection` via
// src/focusDeposit.js's buildDepositFocus — this file only renders it.
// The two solver actions are BUTTON-triggered (not eager): each is a
// real solveFor/solveWhenCouldIBuy run (up to 40 projectPlan calls),
// cheap enough to run on a click but wasteful to re-run on every
// unrelated keystroke while parked on this view. "The answer"'s own
// "reached in FY…" line for a shortfall DOES run eagerly — it's a
// single solveWhenCouldIBuy call per render, and the spec shows it as
// part of the answer itself, not behind a button.
let focusDepositPropertyId = null;
// { kind: "contribution", result, assetId, fromAge, toAge } |
// { kind: "date", result } | null — cleared whenever the property
// changes or a result is applied, so a stale solve is never shown
// against a plan it no longer describes.
let focusDepositSolveResult = null;

function focusDepositLmiRowHTML(f) {
  if (f.required.firstHomeGuarantee) {
    return `<tr><td>LMI</td><td>Waived — First Home Guarantee</td></tr>`;
  }
  if (f.required.lmi <= 0) return "";
  return f.required.lmiInCash
    ? `<tr><td>LMI (paid at settlement)</td><td>${fmtMoney(f.required.lmi)}</td></tr>`
    : `<tr><td>LMI</td><td>${fmtMoney(f.required.lmi)} — capitalised into the loan, not part of settlement cash</td></tr>`;
}

// "Earliest settleable" is CONTEXT, never the answer: a date/amount
// that clears settlement but leaves the mortgage unserviceable for the
// rest of the projection is exactly the bug this view exists to avoid
// repeating — see solveWithAffordabilitySplit's own header
// (src/focusDeposit.js). Labelled "settlement only" everywhere it
// appears so it's never mistaken for a genuine recommendation.
function focusDepositEarliestSettleableHTML(earliestSettleable, formatValue) {
  if (!earliestSettleable) return "";
  return `<p class="helper-text">Settlement only, NOT an answer — the deposit itself could be raised by ${formatValue(earliestSettleable.value)}, but the mortgage still can't be serviced afterward.</p>`;
}

function focusDepositAnswerHTML(f) {
  if (f.answer.onTrack) {
    return `<p class="helper-text">On track: funded by ${escapeHTML(f.target.fyLabel)}, ${fmtMoney(f.answer.spare)} to spare.</p>`;
  }
  if (f.answer.reason === "servicing-unaffordable") {
    // Settles fine on its own configured date; the loan it creates
    // can't be serviced for the rest of the projection. NOT a date
    // problem — a later purchase doesn't fix an unaffordable loan, so
    // no "reached in FY…" guess is offered here (see solveWhenCouldIBuy's
    // own header for why "later" isn't guaranteed to help at all once
    // servicing, not just settlement, is the constraint).
    return `<p class="helper-warning">Cannot afford this purchase: settlement clears, but servicing the loan leaves ${fmtMoney(f.answer.shortfall)} of unfunded cashflow over the rest of the projection.</p>`;
  }
  // reason === "settlement-unaffordable" — "on current savings the
  // target is reached in FY…" — see solveWhenCouldIBuy's own header: a
  // real run against the WHOLE-projection metric, not a guess.
  const when = solveWhenCouldIBuy({ state, propertyId: focusDepositPropertyId });
  let reached;
  if (when.converged) {
    reached = `on current savings the target is reached in ${escapeHTML(fyLabelForAge(state.plan, "client", when.value))} (age ${when.value})`;
  } else if (when.reason === "servicing-unaffordable") {
    reached = `no date makes this affordable — even the earliest settleable date (age ${when.earliestSettleable.value}) leaves the mortgage unserviceable`;
  } else {
    reached = "on current savings, the target may never be reached within this projection";
  }
  return `<p class="helper-warning">Short by ${fmtMoney(f.answer.shortfall)} at the purchase date (${escapeHTML(f.target.fyLabel)}); ${reached}.</p>`;
}

function focusDepositSolverResultHTML() {
  const r = focusDepositSolveResult;
  if (!r) return "";
  if (r.kind === "contribution") {
    if (r.result.converged) {
      return `<p class="helper-text">Save ${fmtMoney(r.result.value)}/month from now to fund the purchase AND service the mortgage afterward.
          <button class="btn-text" type="button" data-focus-apply="contribution">Apply to plan</button></p>`;
    }
    if (r.result.reason === "servicing-unaffordable") {
      return `<p class="helper-warning">Cannot afford this purchase by saving alone: some amount up to ${fmtMoney(20000)}/month raises the deposit, but the mortgage still can't be serviced afterward.
          ${focusDepositEarliestSettleableHTML(r.result.earliestSettleable, (v) => `${fmtMoney(v)}/month`)}</p>`;
    }
    return `<p class="helper-warning">No monthly amount up to ${fmtMoney(20000)} gets there — the shortfall is larger than saving alone can close by the purchase date.</p>`;
  }
  if (r.result.converged) {
    return `<p class="helper-text">Earliest affordable: ${escapeHTML(fyLabelForAge(state.plan, "client", r.result.value))} (age ${r.result.value}) — settles AND services the mortgage afterward.
        <button class="btn-text" type="button" data-focus-apply="date">Apply to plan</button></p>`;
  }
  if (r.result.reason === "servicing-unaffordable") {
    return `<p class="helper-warning">Cannot afford this purchase at any date within the projection: it settles somewhere, but the mortgage is never serviceable afterward — no later date fixes an unaffordable loan.
        ${focusDepositEarliestSettleableHTML(r.result.earliestSettleable, (v) => `age ${v}`)}</p>`;
  }
  return `<p class="helper-warning">No date within this projection is fully funded on current savings.</p>`;
}

function renderFocusDepositView() {
  const props = eligibleDepositProperties(state);
  if (props.length === 0) {
    els.viewFocusDeposit.innerHTML = focusEmptyStateHTML(
      "How much cash a planned property purchase needs at settlement, and whether the client is on track to have it — add a planned property purchase to see it.",
      "property"
    );
    return;
  }
  if (!props.some((p) => p.id === focusDepositPropertyId)) {
    focusDepositPropertyId = props[0].id;
    focusDepositSolveResult = null;
  }
  const f = buildDepositFocus({ out: projection, state, propertyId: focusDepositPropertyId });
  if (!f) {
    els.viewFocusDeposit.innerHTML = focusEmptyStateHTML(
      "This property's purchase date doesn't fall inside the current projection — adjust the purchase date or the projection's end to see this view.",
      "property"
    );
    return;
  }
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const financialAssets = state.assets.filter((a) => a.class !== "lifestyle" && a.include);

  els.viewFocusDeposit.innerHTML = `
    <h2 class="section-heading">Deposit & home purchase</h2>
    ${props.length > 1 ? `<div id="focusDepositEntity" class="seg-toggle entity-select" role="tablist" aria-label="Property"></div>` : ""}
    <div class="focus-panel">
      <div class="focus-section">
        <h3>Target</h3>
        <div class="summary-strip">
          <div class="stat"><div class="stat-label">Price today</div><div class="stat-value">${fmtMoney(f.target.priceToday)}</div></div>
          <div class="stat"><div class="stat-label">Growth rate</div><div class="stat-value">${f.target.growthPct}% p.a.</div></div>
          <div class="stat"><div class="stat-label">Purchase date</div><div class="stat-value">${escapeHTML(f.target.fyLabel)} (age ${f.target.purchaseAge})</div></div>
          <div class="stat stat-headline"><div class="stat-label">Projected price at purchase</div><div class="stat-value">${fmtMoney(f.target.projectedPriceReal * factor(f.target.purchaseYear))}</div></div>
        </div>
        <p class="helper-text">A ${fmtMoney(f.target.priceToday)} property growing at ${f.target.growthPct}% a year is not ${fmtMoney(f.target.priceToday)} in ${escapeHTML(f.target.fyLabel)} — the price itself is the moving part of this question.</p>
      </div>
      <div class="focus-section">
        <h3>Required at settlement</h3>
        <table class="focus-table">
          <tr><td>Deposit (price less the loan)</td><td>${fmtMoney(f.required.deposit * factor(f.target.purchaseYear))}</td></tr>
          <tr><td>Stamp duty</td><td>${fmtMoney(f.required.duty * factor(f.target.purchaseYear))}</td></tr>
          ${focusDepositLmiRowHTML(f)}
          <tr><td>Transfer &amp; legal costs</td><td>${fmtMoney(f.required.costs * factor(f.target.purchaseYear))}</td></tr>
          ${f.required.fhog > 0 ? `<tr><td>Less: First Home Owner Grant</td><td>−${fmtMoney(f.required.fhog * factor(f.target.purchaseYear))}</td></tr>` : ""}
          <tr class="tl-total"><td>Total cash required</td><td>${fmtMoney(f.required.total * factor(f.target.purchaseYear))}</td></tr>
        </table>
      </div>
      <div class="focus-section">
        <h3>Accumulating</h3>
        <div id="focusDepositChart"></div>
        ${f.fhsssReleaseAtPurchase > 0 ? `<p class="helper-text">Includes a ${fmtMoney(f.fhsssReleaseAtPurchase * factor(f.target.purchaseYear))} FHSSS release at the purchase date.</p>` : ""}
      </div>
      <div class="focus-section focus-answer">
        <h3>The answer</h3>
        ${focusDepositAnswerHTML(f)}
      </div>
      <div class="focus-section focus-solvers">
        <h3>What if?</h3>
        <div class="focus-solver-row">
          <label>Save into
            <select id="focusDepositAsset">
              ${financialAssets.map((a) => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join("")}
            </select>
          </label>
          <label>From age
            <input type="number" id="focusDepositFromAge" min="${state.plan.client.currentAge}" max="${f.target.purchaseAge}" value="${state.plan.client.currentAge}" />
          </label>
          <button class="btn-text" type="button" data-focus-solve="contribution">What would I need to save?</button>
        </div>
        <button class="btn-text" type="button" data-focus-solve="date">When could I buy?</button>
        ${focusDepositSolverResultHTML()}
      </div>
    </div>
  `;
  if (props.length > 1) {
    renderEntitySelector(
      $("focusDepositEntity"),
      props.map((p) => ({ id: p.id, label: p.name })),
      focusDepositPropertyId,
      (id) => { focusDepositPropertyId = id; focusDepositSolveResult = null; renderFocusDepositView(); }
    );
  }
  renderFocusDepositChart(f);
}

function renderFocusDepositChart(f) {
  const el = $("focusDepositChart");
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const ages = f.accumulating.map((a) => a.age);
  const available = f.accumulating.map((a) => a.availableReal * factor(a.year));
  const requiredLine = ages.map(() => f.required.total * factor(f.target.purchaseYear));
  Plotly.react(el, [
    {
      x: ages, y: available, name: "Available funds", type: "scatter", mode: "lines+markers",
      line: { color: "rgb(28, 90, 180)", width: 2 },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Available funds</extra>",
    },
    {
      x: ages, y: requiredLine, name: "Required at settlement", type: "scatter", mode: "lines",
      line: { color: "rgb(217, 90, 40)", width: 2, dash: "dash" },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Required at settlement</extra>",
    },
  ], {
    margin: { l: 70, r: 20, t: 24, b: 40 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: 1 },
    yaxis: {
      title: { text: `${isNominal() ? "Future" : "Today's"} dollars`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

function exportFocusDepositCSV() {
  const f = buildDepositFocus({ out: projection, state, propertyId: focusDepositPropertyId });
  if (!f) return;
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const py = f.target.purchaseYear;
  const lines = [
    ["Section", "Item", "Value"].map(csvEsc).join(","),
    [csvEsc("Target"), csvEsc("Price today"), f.target.priceToday.toFixed(2)].join(","),
    [csvEsc("Target"), csvEsc("Growth rate (% p.a.)"), f.target.growthPct].join(","),
    [csvEsc("Target"), csvEsc("Purchase date"), csvEsc(`${f.target.fyLabel} (age ${f.target.purchaseAge})`)].join(","),
    [csvEsc("Target"), csvEsc("Projected price at purchase"), (f.target.projectedPriceReal * factor(py)).toFixed(2)].join(","),
    [csvEsc("Required at settlement"), csvEsc("Deposit"), (f.required.deposit * factor(py)).toFixed(2)].join(","),
    [csvEsc("Required at settlement"), csvEsc("Stamp duty"), (f.required.duty * factor(py)).toFixed(2)].join(","),
    [csvEsc("Required at settlement"), csvEsc("LMI"), (f.required.lmi * factor(py)).toFixed(2)].join(","),
    [csvEsc("Required at settlement"), csvEsc("Transfer & legal costs"), (f.required.costs * factor(py)).toFixed(2)].join(","),
    [csvEsc("Required at settlement"), csvEsc("First Home Owner Grant"), (-f.required.fhog * factor(py)).toFixed(2)].join(","),
    [csvEsc("Required at settlement"), csvEsc("Total cash required"), (f.required.total * factor(py)).toFixed(2)].join(","),
    [csvEsc("The answer"), csvEsc("Status"), csvEsc(f.answer.onTrack ? "On track" : f.answer.reason)].join(","),
    [csvEsc("The answer"), csvEsc(f.answer.onTrack ? "Spare at settlement" : f.answer.reason === "servicing-unaffordable" ? "Unfunded cashflow after settlement" : "Shortfall at settlement"), (f.answer.onTrack ? f.answer.spare : f.answer.shortfall).toFixed(2)].join(","),
    "",
    ["Year", "Age", "FY", "Available funds"].map(csvEsc).join(","),
  ];
  for (const a of f.accumulating) {
    lines.push([a.year, a.age, csvEsc(a.fyLabel), (a.availableReal * factor(a.year)).toFixed(2)].join(","));
  }
  downloadCSV("focus-deposit", lines);
}

els.viewFocusDeposit.addEventListener("click", (e) => {
  const solveBtn = e.target.closest("[data-focus-solve]");
  if (solveBtn) {
    const kind = solveBtn.dataset.focusSolve;
    if (kind === "contribution") {
      const assetId = $("focusDepositAsset")?.value;
      const fromAge = clampInt($("focusDepositFromAge")?.value, state.plan.client.currentAge, state.plan.endAge);
      const result = solveDepositContribution({ state, propertyId: focusDepositPropertyId, assetId, fromAge });
      focusDepositSolveResult = { kind: "contribution", result, assetId, fromAge };
    } else if (kind === "date") {
      const result = solveWhenCouldIBuy({ state, propertyId: focusDepositPropertyId });
      focusDepositSolveResult = { kind: "date", result };
    }
    renderFocusDepositView();
    return;
  }
  const applyBtn = e.target.closest("[data-focus-apply]");
  if (!applyBtn || !focusDepositSolveResult?.result?.converged) return;
  const property = state.properties.find((p) => p.id === focusDepositPropertyId);
  if (!property) return;
  if (focusDepositSolveResult.kind === "contribution") {
    const { result, assetId, fromAge } = focusDepositSolveResult;
    const ref = resolveRef(property.purchaseAt, state.plan, projection.schedule, "client");
    const owner = state.assets.find((a) => a.id === assetId)?.owner ?? "client";
    state.cashflows.contributions = [
      ...state.cashflows.contributions,
      {
        id: uid("cf"), assetId, amount: result.value, frequency: "monthly",
        from: { kind: "age", age: fromAge }, to: { kind: "age", age: Math.max(fromAge, ref.age - 1) },
        indexed: false, owner, label: "Deposit savings (Focus)",
      },
    ];
  } else if (focusDepositSolveResult.kind === "date") {
    property.purchaseAt = { kind: "age", age: focusDepositSolveResult.result.value };
  }
  focusDepositSolveResult = null;
  state = clampAllToPlan(state, PROFILES);
  saveState();
  refreshOutputs();
});

// --- Commit 3: First Home Super Saver ---------------------------------------
//
// Every figure below is read straight off `projection` via
// src/focusFhsss.js's buildFhsssFocus/buildFhsssComparison — this file
// only renders it. The comparison is a real second projectPlan() run
// (via buildFhsssComparison), not a hand-rolled tax calculation.
let focusFhsssPerson = null;

function focusFhsssReleaseHTML(f, factor) {
  if (f.actualRelease) {
    const r = f.actualRelease;
    return `
      <table class="focus-table">
        <tr><td>Gross release (${escapeHTML(r.fyLabel)})</td><td>${fmtMoney(r.grossRelease * factor(r.year))}</td></tr>
        <tr><td>— taxable component (85% concessional + earnings)</td><td>${fmtMoney(r.taxableComponent * factor(r.year))}</td></tr>
        <tr><td>— tax-free component (non-concessional)</td><td>${fmtMoney(r.taxFreeComponent * factor(r.year))}</td></tr>
        <tr><td>30% tax offset on the taxable component</td><td>${fmtMoney(r.offset * factor(r.year))}</td></tr>
      </table>
    `;
  }
  if (f.eligibleReleaseNow && f.eligibleReleaseNow.grossRelease > 0) {
    const r = f.eligibleReleaseNow;
    return `<p class="helper-text">No release triggered yet. If released today (${escapeHTML(r.fyLabel)}), this would be worth ${fmtMoney(r.grossRelease * factor(r.year))} gross (${fmtMoney(r.taxableComponent * factor(r.year))} taxable, ${fmtMoney(r.taxFreeComponent * factor(r.year))} tax-free).</p>`;
  }
  return `<p class="helper-text">No release triggered, and no balance yet to release.</p>`;
}

function focusFhsssComparisonHTML(comparison, factor) {
  if (!comparison) return "";
  const f = factor(comparison.comparisonYear);
  const better = comparison.difference >= 0 ? "FHSSS" : "saving outside super";
  return `
    <table class="focus-table">
      <tr><td>Inside FHSSS, at ${escapeHTML(comparison.fyLabel)}</td><td>${fmtMoney(comparison.insideValue * f)}</td></tr>
      <tr><td>The same dollars saved outside super instead</td><td>${fmtMoney(comparison.outsideValue * f)}</td></tr>
      <tr class="tl-total"><td>Difference</td><td>${fmtMoney(Math.abs(comparison.difference) * f)} in favour of ${better}</td></tr>
    </table>
    <p class="helper-text">The drivers: 15% contributions tax on the way in (versus this client's marginal rate outside super), concessional earnings tax while it's inside the fund, and a 30% offset on release that ordinary savings never get.</p>
  `;
}

function renderFocusFhsssView() {
  const persons = eligibleFhsssPersons(state);
  if (persons.length === 0) {
    els.viewFocusFhsss.innerHTML = focusEmptyStateHTML(
      "What the First Home Super Saver scheme actually gains a client, compared with saving the same dollars outside super — add an FHSSS-eligible super contribution to see it.",
      "super"
    );
    return;
  }
  if (!persons.includes(focusFhsssPerson)) focusFhsssPerson = persons[0];
  const f = buildFhsssFocus({ out: projection, state, person: focusFhsssPerson });
  if (!f) {
    els.viewFocusFhsss.innerHTML = focusEmptyStateHTML(
      "What the First Home Super Saver scheme actually gains a client, compared with saving the same dollars outside super — add an FHSSS-eligible super contribution to see it.",
      "super"
    );
    return;
  }
  const comparison = buildFhsssComparison({ state, person: focusFhsssPerson });
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const personLabel = focusFhsssPerson === "partner" ? partnerName() : clientName();

  els.viewFocusFhsss.innerHTML = `
    <h2 class="section-heading">First Home Super Saver</h2>
    ${persons.length > 1 ? `<div id="focusFhsssEntity" class="seg-toggle entity-select" role="tablist" aria-label="Person"></div>` : ""}
    <div class="focus-panel">
      <div class="focus-section">
        <h3>Cap headroom — ${escapeHTML(personLabel)}, as at ${escapeHTML(projection.schedule.fyLabels[f.capHeadroom.year])}</h3>
        <div class="summary-strip">
          <div class="stat"><div class="stat-label">Used this year</div><div class="stat-value">${fmtMoney(f.capHeadroom.annualUsed)}</div></div>
          <div class="stat"><div class="stat-label">Annual cap remaining</div><div class="stat-value">${fmtMoney(f.capHeadroom.annualRemaining)} of ${fmtMoney(FHSSS_ANNUAL_CAP)}</div></div>
          <div class="stat"><div class="stat-label">Lifetime contributed</div><div class="stat-value">${fmtMoney(f.capHeadroom.lifetimeContributed)}</div></div>
          <div class="stat stat-headline"><div class="stat-label">Lifetime cap remaining</div><div class="stat-value">${fmtMoney(f.capHeadroom.lifetimeRemaining)} of ${fmtMoney(FHSSS_LIFETIME_CAP)}</div></div>
        </div>
        ${f.capHeadroom.rejectedThisYear > 0 ? `<p class="helper-warning">${fmtMoney(f.capHeadroom.rejectedThisYear)} of this year's contribution exceeded the cap and isn't FHSSS-eligible (it's still credited to super as an ordinary contribution).</p>` : ""}
      </div>
      <div class="focus-section">
        <h3>Contributions and associated earnings by year</h3>
        <div id="focusFhsssChart"></div>
      </div>
      <div class="focus-section">
        <h3>Release</h3>
        ${focusFhsssReleaseHTML(f, factor)}
      </div>
      <div class="focus-section">
        <h3>FHSSS versus saving outside super</h3>
        ${comparison
          ? focusFhsssComparisonHTML(comparison, factor)
          : `<p class="helper-text">Not enough information to compare yet.</p>`}
      </div>
    </div>
  `;
  if (persons.length > 1) {
    renderEntitySelector(
      $("focusFhsssEntity"),
      persons.map((p) => ({ id: p, label: p === "partner" ? partnerName() : clientName() })),
      focusFhsssPerson,
      (id) => { focusFhsssPerson = id; renderFocusFhsssView(); }
    );
  }
  renderFocusFhsssChart(f, factor);
}

function renderFocusFhsssChart(f, factor) {
  const el = $("focusFhsssChart");
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const ages = f.byYear.map((r) => r.age);
  Plotly.react(el, [
    {
      x: ages, y: f.byYear.map((r) => r.contributionAccepted * factor(r.year)), name: "Contribution accepted",
      type: "bar", marker: { color: "rgb(28, 90, 180)" },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Contribution accepted</extra>",
    },
    {
      x: ages, y: f.byYear.map((r) => r.earningsAccrued * factor(r.year)), name: "Associated earnings",
      type: "bar", marker: { color: "rgb(107, 142, 35)" },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Associated earnings</extra>",
    },
  ], {
    barmode: "stack",
    margin: { l: 70, r: 20, t: 24, b: 40 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Age", showgrid: false, zeroline: false, dtick: 1 },
    yaxis: {
      title: { text: `${isNominal() ? "Future" : "Today's"} dollars`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false,
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

function exportFocusFhsssCSV() {
  const f = buildFhsssFocus({ out: projection, state, person: focusFhsssPerson });
  if (!f) return;
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lines = [
    ["Year", "Age", "FY", "Contribution accepted", "Contribution rejected", "Associated earnings"].map(csvEsc).join(","),
  ];
  for (const r of f.byYear) {
    lines.push([
      r.year, r.age, csvEsc(r.fyLabel),
      (r.contributionAccepted * factor(r.year)).toFixed(2),
      (r.contributionRejected * factor(r.year)).toFixed(2),
      (r.earningsAccrued * factor(r.year)).toFixed(2),
    ].join(","));
  }
  if (f.actualRelease) {
    const r = f.actualRelease;
    lines.push("", ["Release", "Value"].map(csvEsc).join(","));
    lines.push([csvEsc(`Gross release (${r.fyLabel})`), (r.grossRelease * factor(r.year)).toFixed(2)].join(","));
    lines.push([csvEsc("Taxable component"), (r.taxableComponent * factor(r.year)).toFixed(2)].join(","));
    lines.push([csvEsc("Tax-free component"), (r.taxFreeComponent * factor(r.year)).toFixed(2)].join(","));
    lines.push([csvEsc("30% offset"), (r.offset * factor(r.year)).toFixed(2)].join(","));
  }
  const comparison = buildFhsssComparison({ state, person: focusFhsssPerson });
  if (comparison) {
    const cf = factor(comparison.comparisonYear);
    lines.push("", ["Comparison", "Value"].map(csvEsc).join(","));
    lines.push([csvEsc(`Inside FHSSS (${comparison.fyLabel})`), (comparison.insideValue * cf).toFixed(2)].join(","));
    lines.push([csvEsc("Saved outside super instead"), (comparison.outsideValue * cf).toFixed(2)].join(","));
    lines.push([csvEsc("Difference"), (comparison.difference * cf).toFixed(2)].join(","));
  }
  downloadCSV("focus-fhsss", lines);
}

// --- Commit 4: Salary sacrifice ---------------------------------------------
//
// Both arms come from a real projectPlan() run (src/focusSalarySacrifice.js)
// — the "without" arm is the SAME plan with the sacrifice row deleted
// outright. Amount is adjustable live in the view (a what-if, not an
// edit to the real row) via focusSalarySacrificeAmount, reusing the
// existing concessional-cap headroom display (superCapHeadroomHTML)
// exactly as the input panel shows it.
let focusSalarySacrificeRowId = null;
let focusSalarySacrificeAmount = null;

function renderFocusSalarySacrificeView() {
  const rows = eligibleSalarySacrificeRows(state);
  if (rows.length === 0) {
    els.viewFocusSalarySacrifice.innerHTML = focusEmptyStateHTML(
      "Whether salary sacrifice is worth it for this client — income tax saved, HELP repayment unchanged, super gained net of contributions tax — add a salary sacrifice super contribution to see it.",
      "super"
    );
    return;
  }
  if (!rows.some((r) => r.id === focusSalarySacrificeRowId)) {
    focusSalarySacrificeRowId = rows[0].id;
    focusSalarySacrificeAmount = null;
  }
  const row = rows.find((r) => r.id === focusSalarySacrificeRowId);
  if (focusSalarySacrificeAmount == null) focusSalarySacrificeAmount = row.amount;
  const f = buildSalarySacrificeFocus({ state, contributionId: focusSalarySacrificeRowId, amount: focusSalarySacrificeAmount });
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const y0 = f.byYear[0];
  const ownerLabel = f.owner === "partner" ? partnerName() : clientName();

  els.viewFocusSalarySacrifice.innerHTML = `
    <h2 class="section-heading">Salary sacrifice</h2>
    ${rows.length > 1 ? `<div id="focusSacrificeEntity" class="seg-toggle entity-select" role="tablist" aria-label="Contribution"></div>` : ""}
    <div class="focus-panel">
      <div class="focus-section">
        <h3>Amount — ${escapeHTML(ownerLabel)}</h3>
        <div class="focus-solver-row">
          <label>Annual sacrifice ($)
            <input type="number" id="focusSacrificeAmount" min="0" step="500" value="${focusSalarySacrificeAmount}" />
          </label>
        </div>
        ${superCapHeadroomHTML(row)}
      </div>
      <div class="focus-section">
        <h3>This year's effect (${escapeHTML(y0.fyLabel)})</h3>
        <div class="summary-strip">
          <div class="stat"><div class="stat-label">Income tax saved</div><div class="stat-value">${fmtMoney(y0.incomeTaxSaved * factor(0))}</div></div>
          <div class="stat"><div class="stat-label">Super gained (net of 15%)</div><div class="stat-value">${fmtMoney(y0.superGainedNet * factor(0))}</div></div>
          <div class="stat"><div class="stat-label">Household cash reduced</div><div class="stat-value">${fmtMoney(y0.cashReduced * factor(0))}</div></div>
          <div class="stat stat-headline"><div class="stat-label">Net position, this year</div><div class="stat-value">${fmtMoney((y0.netAssetsWith - y0.netAssetsWithout) * factor(0))}</div></div>
        </div>
        <p class="helper-text"><strong>HELP repayment unchanged:</strong> ${fmtMoney(y0.helpWith * factor(0))} either way — reportable super contributions add the sacrificed amount straight back into repayment income, the single most commonly misunderstood interaction with this strategy.</p>
        ${y0.div293With > y0.div293Without
          ? `<p class="helper-warning">Division 293 is ${y0.div293Without > 0 ? "higher" : "triggered"} by this contribution: ${fmtMoney(y0.div293With * factor(0))} versus ${fmtMoney(y0.div293Without * factor(0))} without it.</p>`
          : ""}
      </div>
      <div class="focus-section">
        <h3>Net position over time</h3>
        <div id="focusSacrificeChart"></div>
      </div>
    </div>
  `;
  if (rows.length > 1) {
    renderEntitySelector(
      $("focusSacrificeEntity"),
      rows.map((r) => ({ id: r.id, label: r.label })),
      focusSalarySacrificeRowId,
      (id) => { focusSalarySacrificeRowId = id; focusSalarySacrificeAmount = null; renderFocusSalarySacrificeView(); }
    );
  }
  renderFocusSacrificeChart(f, factor);
}

function renderFocusSacrificeChart(f, factor) {
  const el = $("focusSacrificeChart");
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const ages = f.byYear.map((r) => r.age);
  Plotly.react(el, [
    {
      x: ages, y: f.byYear.map((r) => r.netAssetsWith * factor(r.year)), name: "With sacrifice",
      type: "scatter", mode: "lines", line: { color: "rgb(28, 90, 180)", width: 2 },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>With sacrifice</extra>",
    },
    {
      x: ages, y: f.byYear.map((r) => r.netAssetsWithout * factor(r.year)), name: "Without sacrifice",
      type: "scatter", mode: "lines", line: { color: "rgb(217, 90, 40)", width: 2, dash: "dash" },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Without sacrifice</extra>",
    },
  ], {
    margin: { l: 70, r: 20, t: 24, b: 40 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Net assets (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false,
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

function exportFocusSalarySacrificeCSV() {
  const rows = eligibleSalarySacrificeRows(state);
  const row = rows.find((r) => r.id === focusSalarySacrificeRowId);
  if (!row) return;
  const amount = focusSalarySacrificeAmount ?? row.amount;
  const f = buildSalarySacrificeFocus({ state, contributionId: focusSalarySacrificeRowId, amount });
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lines = [
    [
      "Year", "Age", "FY", "Income tax (with)", "Income tax (without)", "Income tax saved",
      "HELP (with)", "HELP (without)", "Div 293 (with)", "Div 293 (without)",
      "Super gained (net)", "Household cash reduced", "Net assets (with)", "Net assets (without)",
    ].map(csvEsc).join(","),
  ];
  for (const r of f.byYear) {
    lines.push([
      r.year, r.age, csvEsc(r.fyLabel),
      (r.incomeTaxWith * factor(r.year)).toFixed(2), (r.incomeTaxWithout * factor(r.year)).toFixed(2), (r.incomeTaxSaved * factor(r.year)).toFixed(2),
      (r.helpWith * factor(r.year)).toFixed(2), (r.helpWithout * factor(r.year)).toFixed(2),
      (r.div293With * factor(r.year)).toFixed(2), (r.div293Without * factor(r.year)).toFixed(2),
      (r.superGainedNet * factor(r.year)).toFixed(2), (r.cashReduced * factor(r.year)).toFixed(2),
      (r.netAssetsWith * factor(r.year)).toFixed(2), (r.netAssetsWithout * factor(r.year)).toFixed(2),
    ].join(","));
  }
  downloadCSV("focus-salary-sacrifice", lines);
}

els.viewFocusSalarySacrifice.addEventListener("change", (e) => {
  if (e.target.id !== "focusSacrificeAmount") return;
  focusSalarySacrificeAmount = clampNumber(e.target.value, 0);
  renderFocusSalarySacrificeView();
});

// --- Commit 5: Debt payoff --------------------------------------------------
//
// Every figure below is read straight off `projection` via
// src/focusDebtPayoff.js's buildDebtPayoffFocus — this file only renders
// it. The counterfactual chart is a real second projectPlan() run (the
// loan's own extras stripped), not a hand-rolled amortisation. The
// solver is button-triggered (up to 40 projectPlan calls), same
// convention as the deposit and FHSSS solvers.
let focusDebtPayoffLoanId = null;
// { result, targetAge } | null — cleared whenever the loan changes or a
// result is applied, so a stale solve is never shown against a plan it
// no longer describes.
let focusDebtPayoffSolveResult = null;

function focusDebtPayoffStatsHTML(f, factor) {
  if (!f.stats) {
    return `<p class="helper-text">No extra or one-off repayments configured on this loan — nothing to compare against the scheduled term.</p>`;
  }
  const s = f.stats;
  if (s.actualPayoffMonth == null) {
    return `<p class="helper-text">Extra repayments are configured, but this loan doesn't reach zero within the projection — the true lifetime interest saved can't be determined yet.</p>`;
  }
  return `
    <table class="focus-table">
      <tr><td>Interest saved</td><td>${fmtMoney(s.interestSaved * factor(f.payoff?.year ?? 0))}</td></tr>
      <tr><td>Time saved</td><td>${(s.timeSavedMonths / 12).toFixed(1)} years (${s.timeSavedMonths} months)</td></tr>
    </table>
  `;
}

// Fixed-rate rollover (Implementation/Rates spec, Commit 1) — the
// repayment before and after, read straight off f.rollover (already
// the engine's own liabilityRollovers entry, via buildDebtPayoffFocus —
// never recomputed here).
function focusDebtPayoffRolloverHTML(f, factor) {
  if (!f.rollover) return "";
  const r = f.rollover;
  return `
    <div class="focus-section">
      <h3>Fixed-rate rollover</h3>
      <table class="focus-table">
        <tr><td>Rolls over</td><td>${escapeHTML(r.fyLabel)}</td></tr>
        <tr><td>Rate</td><td>${r.fromRatePct.toFixed(2)}% → ${r.toRatePct.toFixed(2)}% p.a.</td></tr>
        <tr class="tl-total"><td>Repayment</td><td>${fmtMoney(r.repaymentBefore * factor(r.planYear))}/mo → ${fmtMoney(r.repaymentAfter * factor(r.planYear))}/mo</td></tr>
      </table>
    </div>
  `;
}

function focusDebtPayoffSolverResultHTML() {
  const r = focusDebtPayoffSolveResult;
  if (!r) return "";
  if (!r.result.converged) {
    return `<p class="helper-warning">No extra repayment up to the loan's own balance clears it by age ${r.targetAge} — the target may not be reachable this way.</p>`;
  }
  if (r.result.value === 0) {
    return `<p class="helper-text">Already on track to clear by age ${r.targetAge} without any extra repayment.</p>`;
  }
  const affordable = r.result.unfunded <= 0.5;
  return `
    <p class="${affordable ? "helper-text" : "helper-warning"}">
      ${fmtMoney(r.result.value)}/month extra, from now to age ${r.targetAge}, clears this loan on time.
      ${affordable
        ? `<button class="btn-text" type="button" data-focus-apply="extra">Apply to plan</button>`
        : `Short by ${fmtMoney(r.result.unfunded)} — the household can't fund this amount as things stand; applying it would leave cashflow unfunded, not clear the loan for free.`}
    </p>
  `;
}

function renderFocusDebtPayoffView() {
  const loans = eligibleDebtPayoffLoans(state);
  if (loans.length === 0) {
    els.viewFocusDebtPayoff.innerHTML = focusEmptyStateHTML(
      "When each loan clears, how much interest extra repayments actually save, and what it would take to clear one sooner — add a liability to see it.",
      "liabilities"
    );
    return;
  }
  if (!loans.some((l) => l.id === focusDebtPayoffLoanId)) {
    focusDebtPayoffLoanId = loans[0].id;
    focusDebtPayoffSolveResult = null;
  }
  const f = buildDebtPayoffFocus({ out: projection, state, liabilityId: focusDebtPayoffLoanId });
  if (!f) {
    els.viewFocusDebtPayoff.innerHTML = focusEmptyStateHTML(
      "When each loan clears, how much interest extra repayments actually save, and what it would take to clear one sooner — add a liability to see it.",
      "liabilities"
    );
    return;
  }
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const payoffLine = f.payoff
    ? `${escapeHTML(f.payoff.fyLabel)} (age ${f.payoff.age})`
    : "Beyond this projection — the loan outlives the current end date";

  els.viewFocusDebtPayoff.innerHTML = `
    <h2 class="section-heading">Debt payoff</h2>
    ${loans.length > 1 ? `<div id="focusDebtEntity" class="seg-toggle entity-select" role="tablist" aria-label="Loan"></div>` : ""}
    <div class="focus-panel">
      <div class="focus-section">
        <h3>${escapeHTML(f.liability.name)}</h3>
        <div class="summary-strip">
          <div class="stat stat-headline"><div class="stat-label">Payoff date</div><div class="stat-value">${payoffLine}</div></div>
          <div class="stat"><div class="stat-label">Total interest over the life</div><div class="stat-value">${fmtMoney(f.totalInterest)}</div></div>
        </div>
      </div>
      <div class="focus-section">
        <h3>Effect of extra repayments</h3>
        ${focusDebtPayoffStatsHTML(f, factor)}
      </div>
      ${focusDebtPayoffRolloverHTML(f, factor)}
      <div class="focus-section">
        <h3>Balance over time</h3>
        <div id="focusDebtChart"></div>
      </div>
      <div class="focus-section focus-solvers">
        <h3>What if?</h3>
        <div class="focus-solver-row">
          <label>Clear it by age
            <input type="number" id="focusDebtTargetAge" min="${state.plan.client.currentAge + 1}" max="${state.plan.endAge}" value="${f.payoff ? Math.max(state.plan.client.currentAge + 1, f.payoff.age - 1) : state.plan.endAge}" />
          </label>
          <button class="btn-text" type="button" data-focus-solve="extra">What extra repayment clears this by then?</button>
        </div>
        ${focusDebtPayoffSolverResultHTML()}
      </div>
    </div>
  `;
  if (loans.length > 1) {
    renderEntitySelector(
      $("focusDebtEntity"),
      loans.map((l) => ({ id: l.id, label: l.name })),
      focusDebtPayoffLoanId,
      (id) => { focusDebtPayoffLoanId = id; focusDebtPayoffSolveResult = null; renderFocusDebtPayoffView(); }
    );
  }
  renderFocusDebtChart(f, factor);
}

function renderFocusDebtChart(f, factor) {
  const el = $("focusDebtChart");
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const ages = f.balanceSeries.map((r) => r.age);
  Plotly.react(el, [
    {
      x: ages, y: f.balanceSeries.map((r) => r.actual * factor(r.year)), name: "Actual balance",
      type: "scatter", mode: "lines", line: { color: "rgb(28, 90, 180)", width: 2 },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Actual balance</extra>",
    },
    {
      x: ages, y: f.balanceSeries.map((r) => r.noExtras * factor(r.year)), name: "No extra repayments",
      type: "scatter", mode: "lines", line: { color: "rgb(217, 90, 40)", width: 2, dash: "dash" },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>No extra repayments</extra>",
    },
  ], {
    margin: { l: 70, r: 20, t: 24, b: 40 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `${isNominal() ? "Future" : "Today's"} dollars`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

function exportFocusDebtPayoffCSV() {
  const f = buildDebtPayoffFocus({ out: projection, state, liabilityId: focusDebtPayoffLoanId });
  if (!f) return;
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lines = [
    ["Section", "Item", "Value"].map(csvEsc).join(","),
    [csvEsc(f.liability.name), csvEsc("Payoff date"), csvEsc(f.payoff ? `${f.payoff.fyLabel} (age ${f.payoff.age})` : "Beyond this projection")].join(","),
    [csvEsc(f.liability.name), csvEsc("Total interest over the life"), f.totalInterest.toFixed(2)].join(","),
  ];
  if (f.stats) {
    lines.push([csvEsc(f.liability.name), csvEsc("Interest saved by extra repayments"), (f.stats.interestSaved ?? "").toString()].join(","));
    lines.push([csvEsc(f.liability.name), csvEsc("Time saved (months)"), (f.stats.timeSavedMonths ?? "").toString()].join(","));
  }
  if (f.rollover) {
    const rf = factor(f.rollover.planYear);
    lines.push([csvEsc(f.liability.name), csvEsc(`Rolls over (${f.rollover.fyLabel})`), csvEsc(`${f.rollover.fromRatePct.toFixed(2)}% -> ${f.rollover.toRatePct.toFixed(2)}%`)].join(","));
    lines.push([csvEsc(f.liability.name), csvEsc("Repayment before rollover"), (f.rollover.repaymentBefore * rf).toFixed(2)].join(","));
    lines.push([csvEsc(f.liability.name), csvEsc("Repayment after rollover"), (f.rollover.repaymentAfter * rf).toFixed(2)].join(","));
  }
  lines.push("", ["Year", "Age", "FY", "Actual balance", "No extra repayments"].map(csvEsc).join(","));
  for (const r of f.balanceSeries) {
    lines.push([r.year, r.age, csvEsc(r.fyLabel), (r.actual * factor(r.year)).toFixed(2), (r.noExtras * factor(r.year)).toFixed(2)].join(","));
  }
  downloadCSV("focus-debt-payoff", lines);
}

els.viewFocusDebtPayoff.addEventListener("click", (e) => {
  const solveBtn = e.target.closest("[data-focus-solve]");
  if (solveBtn) {
    const targetAge = clampInt($("focusDebtTargetAge")?.value, state.plan.client.currentAge + 1, state.plan.endAge);
    const result = solveExtraRepaymentForPayoffDate({ state, liabilityId: focusDebtPayoffLoanId, targetAge });
    focusDebtPayoffSolveResult = { result, targetAge };
    renderFocusDebtPayoffView();
    return;
  }
  const applyBtn = e.target.closest("[data-focus-apply]");
  if (!applyBtn || !focusDebtPayoffSolveResult?.result?.converged || focusDebtPayoffSolveResult.result.value <= 0) return;
  const liability = state.liabilities.find((l) => l.id === focusDebtPayoffLoanId);
  if (!liability) return;
  const { result, targetAge } = focusDebtPayoffSolveResult;
  liability.extraRepayments = [
    ...liability.extraRepayments,
    {
      id: uid("er"), label: "Extra repayment (Focus)", amount: result.value, frequency: "monthly",
      from: { kind: "age", age: state.plan.client.currentAge }, to: { kind: "age", age: targetAge },
      indexBasis: "none", indexExtraPct: 0,
    },
  ];
  focusDebtPayoffSolveResult = null;
  state = clampAllToPlan(state, PROFILES);
  saveState();
  refreshOutputs();
});

// --- Commit 6: Standalone lookups -------------------------------------------
//
// The one deliberate exception to the governing principle: a lookup,
// not a projection, so it can't contradict the plan. Takes no plan
// input at all (src/focusLookups.js), so there's no "add X to see it"
// empty state — the calculator is always available, seeded with
// sensible defaults rather than the client's own data.
let focusLookupsInput = {
  stateCode: FOCUS_LOOKUP_STATES[0], price: 600000,
  firstHomeBuyer: false, newBuild: false,
  lvrPct: 80, firstHomeGuarantee: false,
};

function focusLookupsDutyHTML(duty) {
  return `
    <table class="focus-table">
      <tr><td>General transfer duty</td><td>${fmtMoney(duty.general)}</td></tr>
      ${duty.concessionSaving > 0.005 ? `<tr><td>First-home-buyer concession</td><td>−${fmtMoney(duty.concessionSaving)}</td></tr>` : ""}
      <tr class="tl-total"><td>Duty payable</td><td>${fmtMoney(duty.duty)}</td></tr>
      ${duty.fhog > 0 ? `<tr><td>First Home Owner Grant</td><td>${fmtMoney(duty.fhog)}</td></tr>` : ""}
    </table>
    <p class="helper-text">As at ${escapeHTML(STAMP_DUTY_META.asAt)}. ${escapeHTML(STAMP_DUTY_META.note)}</p>
  `;
}

function focusLookupsLmiHTML(lmi, stateCode, lvrPct) {
  const body = lmi.firstHomeGuarantee
    ? `<p class="helper-text">LMI waived — First Home Guarantee.</p>
       ${lmi.capExceeded ? `<p class="helper-warning">Purchase price exceeds the ${escapeHTML(stateCode)} First Home Guarantee price cap — confirm current eligibility.</p>` : ""}`
    : lmi.lmi > 0
      ? `<table class="focus-table">
          <tr><td>Loan amount (${lvrPct}% LVR)</td><td>${fmtMoney(lmi.loanAmount)}</td></tr>
          <tr class="tl-total"><td>LMI premium</td><td>${fmtMoney(lmi.lmi)}</td></tr>
        </table>`
      : `<p class="helper-text">No LMI at ${lvrPct}% LVR — at or below the 80% threshold.</p>`;
  return `
    ${body}
    <p class="helper-text">As at ${escapeHTML(LMI_META.asAt)}. ${escapeHTML(LMI_META.note)}</p>
    <p class="helper-text">First Home Guarantee price caps as at ${escapeHTML(FHBG_META.asAt)}. ${escapeHTML(FHBG_META.note)}</p>
  `;
}

function renderFocusLookupsView() {
  const in_ = focusLookupsInput;
  const duty = computeStampDutyLookup({ stateCode: in_.stateCode, price: in_.price, firstHomeBuyer: in_.firstHomeBuyer, newBuild: in_.newBuild });
  const lmi = computeLmiLookup({ stateCode: in_.stateCode, price: in_.price, lvrPct: in_.lvrPct, firstHomeGuarantee: in_.firstHomeGuarantee });

  els.viewFocusLookups.innerHTML = `
    <h2 class="section-heading">Stamp duty & LMI</h2>
    <p class="helper-text">A standalone lookup — state, price and buyer flags only, no client or plan involved.</p>
    <div class="focus-panel">
      <div class="focus-section">
        <h3>Purchase</h3>
        <div class="focus-solver-row">
          <label>State
            <select id="focusLookupState">${FOCUS_LOOKUP_STATES.map((s) => `<option value="${s}"${s === in_.stateCode ? " selected" : ""}>${s}</option>`).join("")}</select>
          </label>
          <label>Purchase price ($)
            <input type="number" id="focusLookupPrice" min="0" step="10000" value="${in_.price}" />
          </label>
          <label>LVR (%)
            <input type="number" id="focusLookupLvr" min="0" max="100" step="1" value="${in_.lvrPct}" />
          </label>
        </div>
        <div class="focus-solver-row">
          <label><input type="checkbox" id="focusLookupFhb" ${in_.firstHomeBuyer ? "checked" : ""} /> First home buyer</label>
          <label><input type="checkbox" id="focusLookupNewBuild" ${in_.newBuild ? "checked" : ""} /> New build</label>
          <label><input type="checkbox" id="focusLookupFhbg" ${in_.firstHomeGuarantee ? "checked" : ""} /> First Home Guarantee</label>
        </div>
      </div>
      <div class="focus-section">
        <h3>Stamp duty & FHOG</h3>
        ${focusLookupsDutyHTML(duty)}
      </div>
      <div class="focus-section">
        <h3>LMI & First Home Guarantee</h3>
        ${focusLookupsLmiHTML(lmi, in_.stateCode, in_.lvrPct)}
      </div>
    </div>
  `;
}

function exportFocusLookupsCSV() {
  const in_ = focusLookupsInput;
  const duty = computeStampDutyLookup({ stateCode: in_.stateCode, price: in_.price, firstHomeBuyer: in_.firstHomeBuyer, newBuild: in_.newBuild });
  const lmi = computeLmiLookup({ stateCode: in_.stateCode, price: in_.price, lvrPct: in_.lvrPct, firstHomeGuarantee: in_.firstHomeGuarantee });
  const lines = [
    ["Input", "Value"].map(csvEsc).join(","),
    [csvEsc("State"), csvEsc(in_.stateCode)].join(","),
    [csvEsc("Purchase price"), in_.price].join(","),
    [csvEsc("LVR (%)"), in_.lvrPct].join(","),
    [csvEsc("First home buyer"), in_.firstHomeBuyer].join(","),
    [csvEsc("New build"), in_.newBuild].join(","),
    [csvEsc("First Home Guarantee"), in_.firstHomeGuarantee].join(","),
    "",
    [csvEsc("Stamp duty & FHOG"), csvEsc("Value")].join(","),
    [csvEsc("General transfer duty"), duty.general.toFixed(2)].join(","),
    [csvEsc("Concession saving"), duty.concessionSaving.toFixed(2)].join(","),
    [csvEsc("Duty payable"), duty.duty.toFixed(2)].join(","),
    [csvEsc("First Home Owner Grant"), duty.fhog.toFixed(2)].join(","),
    "",
    [csvEsc("LMI & First Home Guarantee"), csvEsc("Value")].join(","),
    [csvEsc("Loan amount"), lmi.loanAmount.toFixed(2)].join(","),
    [csvEsc("LMI premium"), lmi.lmi.toFixed(2)].join(","),
    [csvEsc("Waived (First Home Guarantee)"), lmi.waived].join(","),
    [csvEsc("Price exceeds FHBG cap"), lmi.capExceeded].join(","),
    "",
    [csvEsc(`Stamp duty as at ${STAMP_DUTY_META.asAt}`), csvEsc(STAMP_DUTY_META.note)].join(","),
    [csvEsc(`LMI as at ${LMI_META.asAt}`), csvEsc(LMI_META.note)].join(","),
    [csvEsc(`FHBG caps as at ${FHBG_META.asAt}`), csvEsc(FHBG_META.note)].join(","),
  ];
  downloadCSV("focus-lookups", lines);
}

els.viewFocusLookups.addEventListener("change", (e) => {
  const id = e.target.id;
  if (id === "focusLookupState") focusLookupsInput = { ...focusLookupsInput, stateCode: e.target.value };
  else if (id === "focusLookupPrice") focusLookupsInput = { ...focusLookupsInput, price: clampNumber(e.target.value, 0) };
  else if (id === "focusLookupLvr") focusLookupsInput = { ...focusLookupsInput, lvrPct: clampInt(e.target.value, 0, 100) };
  else if (id === "focusLookupFhb") focusLookupsInput = { ...focusLookupsInput, firstHomeBuyer: e.target.checked };
  else if (id === "focusLookupNewBuild") focusLookupsInput = { ...focusLookupsInput, newBuild: e.target.checked };
  else if (id === "focusLookupFhbg") focusLookupsInput = { ...focusLookupsInput, firstHomeGuarantee: e.target.checked };
  else return;
  renderFocusLookupsView();
});

// --- Commit 3 (docs/specs/13-implementation-rates-equity-comparison.md):
// Usable equity and borrowing capacity ---------------------------------
//
// Every figure below is read straight off `projection` via
// src/focusEquity.js's buildEquityFocus — this file only renders it.
// The disclosure ("a security constraint, not a serviceability
// assessment") is shown prominently, not buried, per the spec's own
// "be explicit about what this is not".

function focusEquityWarningsHTML(warnings) {
  if (!warnings.length) return "";
  return `<div class="focus-section">${warnings.map((w) => `<p class="helper-warning">${escapeHTML(w.reason)}</p>`).join("")}</div>`;
}

function renderFocusEquityView() {
  const properties = eligibleEquityProperties(state);
  if (properties.length === 0) {
    els.viewFocusEquity.innerHTML = focusEmptyStateHTML(
      "How much usable equity sits in each property over the projection, so you can see when equity could fund a deposit elsewhere — add a property with a value or purchase price to see it.",
      "property"
    );
    return;
  }
  const f = buildEquityFocus({ out: projection, state });
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const y0 = f.byYear[0];
  els.viewFocusEquity.innerHTML = `
    <h2 class="section-heading">Usable equity</h2>
    <div class="focus-panel">
      <div class="focus-section">
        <p class="helper-warning">${escapeHTML(f.disclosure)}</p>
      </div>
      ${focusEquityWarningsHTML(f.warnings)}
      <div class="focus-section">
        <h3>This year (${escapeHTML(y0.fyLabel)})</h3>
        <table class="focus-table">
          ${f.properties.map((p) => `<tr><td>${escapeHTML(p.name)} (ceiling ${p.equityCeilingPct}%)</td><td>${fmtMoney(y0.byProperty[p.id] * factor(0))}</td></tr>`).join("")}
          <tr class="tl-total"><td>Total usable equity</td><td>${fmtMoney(y0.total * factor(0))}</td></tr>
        </table>
      </div>
      <div class="focus-section">
        <h3>Usable equity over time</h3>
        <div id="focusEquityChart"></div>
      </div>
    </div>
  `;
  renderFocusEquityChart(f, factor);
}

function renderFocusEquityChart(f, factor) {
  const el = $("focusEquityChart");
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const ages = f.byYear.map((r) => r.age);
  const palette = ["#1c5ab4", "#6b8e23", "#dc5a28", "#5e60ce", "#2e8a8a", "#b5179e", "#d97b2f", "#9a031e", "#3a86c9"];
  const traces = f.properties.map((p, i) => ({
    x: ages, y: f.byYear.map((r) => r.byProperty[p.id] * factor(r.year)),
    name: p.name, type: "scatter", mode: "lines",
    line: { color: palette[i % palette.length], width: 1.5 },
    hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(p.name)}</extra>`,
  }));
  traces.push({
    x: ages, y: f.byYear.map((r) => r.total * factor(r.year)),
    name: "Total", type: "scatter", mode: "lines",
    line: { color: "#222", width: 2.5, dash: "dot" },
    hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Total</extra>",
  });
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Usable equity (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

function exportFocusEquityCSV() {
  const f = buildEquityFocus({ out: projection, state });
  if (!f) return;
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lines = [
    ["Year", "Age", "FY", ...f.properties.map((p) => p.name), "Total"].map(csvEsc).join(","),
  ];
  for (const r of f.byYear) {
    lines.push([
      r.year, r.age, csvEsc(r.fyLabel),
      ...f.properties.map((p) => (r.byProperty[p.id] * factor(r.year)).toFixed(2)),
      (r.total * factor(r.year)).toFixed(2),
    ].join(","));
  }
  lines.push("", csvEsc(f.disclosure));
  for (const w of f.warnings) lines.push(csvEsc(w.reason));
  downloadCSV("focus-equity", lines);
}

// --- Commit 5: Fortnightly transfer schedule --------------------------------
//
// Every figure below is read straight off `projection` via
// src/focusTransferSchedule.js's buildTransferScheduleFocus — this file
// only renders it. The firm's own banking-structure "mud map" diagram
// is built separately (deferred, per the spec); this view exists to
// produce the numbers to copy into it.
let transferScheduleYear = null;
let transferScheduleCadence = "fortnightly"; // "fortnightly" | "monthly" | "annual"

function cadenceConvert(annual) {
  if (transferScheduleCadence === "fortnightly") return perFortnight(annual);
  if (transferScheduleCadence === "monthly") return perMonth(annual);
  return annual;
}
function cadenceLabel() {
  return transferScheduleCadence === "fortnightly" ? "Per fortnight"
    : transferScheduleCadence === "monthly" ? "Per month" : "Per year";
}

function renderFocusTransferScheduleView() {
  const emptyMsg = "What to set up as recurring transfers — take-home pay per source, and where it goes each pay cycle — add an income row to see it.";
  if ((state.cashflows.income ?? []).length === 0) {
    els.viewFocusTransferSchedule.innerHTML = focusEmptyStateHTML(emptyMsg, "income");
    return;
  }
  const years = projection.yearly.length;
  if (transferScheduleYear == null || transferScheduleYear >= years) {
    transferScheduleYear = defaultTransferScheduleYear(state, years);
  }
  const f = buildTransferScheduleFocus({ out: projection, state, year: transferScheduleYear });
  if (!f) {
    els.viewFocusTransferSchedule.innerHTML = focusEmptyStateHTML(emptyMsg, "income");
    return;
  }
  const factor = displayFactor(endMonthOfYear(f.year));
  const couple = isCouple();
  const ownerLabel = (owner) => (couple ? (owner === "partner" ? partnerName() : clientName()) : null);
  const yearOptions = projection.yearly.map((_, y) =>
    `<option value="${y}"${y === f.year ? " selected" : ""}>${escapeHTML(yearHeaderText(y))}</option>`
  ).join("");

  const sourceRows = f.sources.map((s) => `
    <tr>
      <td>${escapeHTML(s.label)}${ownerLabel(s.owner) ? ` <span class="helper-text">(${escapeHTML(ownerLabel(s.owner))})</span>` : ""}</td>
      <td class="tl-num">${fmtMoney(cadenceConvert(s.annual * factor))}</td>
    </tr>
  `).join("");
  const destRows = f.destinations.map((d) => `
    <tr><td>${escapeHTML(d.label)}</td><td class="tl-num">${fmtMoney(cadenceConvert(d.annual * factor))}</td></tr>
  `).join("");
  const initialRows = f.initialTransfers.map((a) => `
    <tr><td>${escapeHTML(a.label)}</td><td class="tl-num">${fmtMoney(a.amount * factor)}</td></tr>
  `).join("");

  els.viewFocusTransferSchedule.innerHTML = `
    <h2 class="section-heading">Transfer schedule</h2>
    <p class="helper-text">The firm's own banking-structure diagram is built separately — this is the numbers to copy into it.</p>
    <div class="focus-panel">
      <div class="focus-section">
        <label>Plan year
          <select id="transferScheduleYearSelect">${yearOptions}</select>
        </label>
        <div id="transferScheduleCadence" class="seg-toggle" role="tablist" aria-label="Cadence"></div>
      </div>
      ${f.initialTransfers.length ? `
      <div class="focus-section">
        <h3>Initial transfer (one-off, plan start)</h3>
        <table class="focus-table">${initialRows}</table>
      </div>` : ""}
      <div class="focus-section">
        <h3>Sources — ${escapeHTML(cadenceLabel())}</h3>
        <table class="focus-table">
          ${sourceRows}
          <tr class="tl-total"><td>Total sources</td><td class="tl-num">${fmtMoney(cadenceConvert(f.sourcesTotal * factor))}</td></tr>
        </table>
      </div>
      <div class="focus-section">
        <h3>Destinations — ${escapeHTML(cadenceLabel())}</h3>
        <table class="focus-table">
          ${destRows}
          <tr><td>Residual to savings</td><td class="tl-num">${fmtMoney(cadenceConvert(f.residual * factor))}</td></tr>
          <tr class="tl-total"><td>Total destinations + residual</td><td class="tl-num">${fmtMoney(cadenceConvert((f.destinationsTotal + f.residual) * factor))}</td></tr>
        </table>
      </div>
      <div class="focus-section">
        <div class="output-actions">
          <button class="btn-text" type="button" id="transferScheduleCopyBtn">Copy for Word</button>
        </div>
      </div>
    </div>
  `;
  renderEntitySelector(
    $("transferScheduleCadence"),
    [{ id: "fortnightly", label: "Fortnightly" }, { id: "monthly", label: "Monthly" }, { id: "annual", label: "Annual" }],
    transferScheduleCadence,
    (id) => { transferScheduleCadence = id; renderFocusTransferScheduleView(); }
  );
}

function transferScheduleToHTML(f, factor) {
  const row = (label, amt) => `<tr><td>${escapeHTML(label)}</td><td>${fmtMoney(cadenceConvert(amt * factor))}</td></tr>`;
  const sourceRows = f.sources.map((s) => row(s.label, s.annual)).join("");
  const destRows = f.destinations.map((d) => row(d.label, d.annual)).join("");
  return `
    <p><strong>Transfer schedule — ${escapeHTML(f.fyLabel)} (${escapeHTML(cadenceLabel())})</strong></p>
    <table border="1" cellspacing="0" cellpadding="4">
      <tr><th colspan="2">Sources</th></tr>
      ${sourceRows}
      <tr><td><strong>Total sources</strong></td><td><strong>${fmtMoney(cadenceConvert(f.sourcesTotal * factor))}</strong></td></tr>
      <tr><th colspan="2">Destinations</th></tr>
      ${destRows}
      <tr><td>Residual to savings</td><td>${fmtMoney(cadenceConvert(f.residual * factor))}</td></tr>
    </table>
  `;
}

function exportFocusTransferScheduleCSV() {
  const f = buildTransferScheduleFocus({ out: projection, state, year: transferScheduleYear });
  if (!f) return;
  const factor = displayFactor(endMonthOfYear(f.year));
  const lines = [`Transfer schedule,${csvEsc(f.fyLabel)},${csvEsc(cadenceLabel())}`];
  if (f.initialTransfers.length) {
    lines.push("", "Initial transfer (one-off)");
    for (const a of f.initialTransfers) lines.push([csvEsc(a.label), (a.amount * factor).toFixed(2)].join(","));
  }
  lines.push("", "Sources");
  for (const s of f.sources) lines.push([csvEsc(s.label), cadenceConvert(s.annual * factor).toFixed(2)].join(","));
  lines.push([csvEsc("Total sources"), cadenceConvert(f.sourcesTotal * factor).toFixed(2)].join(","));
  lines.push("", "Destinations");
  for (const d of f.destinations) lines.push([csvEsc(d.label), cadenceConvert(d.annual * factor).toFixed(2)].join(","));
  lines.push([csvEsc("Residual to savings"), cadenceConvert(f.residual * factor).toFixed(2)].join(","));
  downloadCSV("focus-transfer-schedule", lines);
}

els.viewFocusTransferSchedule.addEventListener("change", (e) => {
  if (e.target.id !== "transferScheduleYearSelect") return;
  transferScheduleYear = Number(e.target.value);
  renderFocusTransferScheduleView();
});

els.viewFocusTransferSchedule.addEventListener("click", (e) => {
  if (e.target.id !== "transferScheduleCopyBtn") return;
  const f = buildTransferScheduleFocus({ out: projection, state, year: transferScheduleYear });
  if (!f) return;
  const factor = displayFactor(endMonthOfYear(f.year));
  const html = transferScheduleToHTML(f, factor);
  const plain = `Transfer schedule — ${f.fyLabel}`;
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      }),
    ]).then(() => {
      e.target.textContent = "Copied!";
      setTimeout(() => { e.target.textContent = "Copy for Word"; }, 1500);
    }).catch(() => window.alert("Couldn't access the clipboard — try again, or use Export CSV instead."));
  } else {
    window.alert("Clipboard access isn't available in this browser — use Export CSV instead.");
  }
});

// --- Compare page (client-level; relocated from the Focus "Compare
// scenarios" view — Spec 13 Commit 6) ----------------------------------
//
// "Current is simply another scenario — no new data model" (the spec's
// own words, unchanged by the relocation). Every compared scenario is
// a full, independent projectPlan() run, loaded straight from storage
// (loadScenarioFullState, the same hydrate() path loadActiveState()
// itself uses) — never approximated, and NEVER assumed to be the
// currently-mounted workspace scenario, since this page has no
// workspace mounted at all (it's a client-level page, no input
// sidebar). buildKeyFiguresGroups/keyFigureValuesAtYear/
// keyFigureComparisonRows (scenarioComparison.js) are reused exactly
// as the Key figures table itself uses them — a comparison column can
// never silently drift from what that scenario's own Key figures view
// would show. Scenario SELECTION happens on the client page (checkbox
// picker, capped at 3); this page only ever reads the ids the URL
// already carries.
let compareYear = null;
let compareSeries = "net-assets"; // a COMPARE_SERIES key (chart) or a COMPARE_TABLES key (table)

// Each series reads a field the engine already computes per year — the
// SAME fields buildKeyFiguresGroups' own rows read ("Total assets",
// "Surplus / (deficit)", etc.) — never a second, independently-derived
// figure.
const COMPARE_SERIES = {
  "net-assets": { label: "Net assets", fn: (row) => row.netAssets },
  "cashflow-surplus": { label: "Cashflow surplus / (deficit)", fn: (row) => row.surplusOrDeficit },
  "total-assets": { label: "Total assets", fn: (row) => row.closingBalance + row.propertyClosing + row.superClosing + row.wcaClosing },
  "total-liabilities": { label: "Total liabilities", fn: (row) => row.liabilitiesClosing },
  "super-balance": { label: "Super balance", fn: (row) => row.superClosing },
  "tax-paid": { label: "Tax paid", fn: (row) => row.tax },
};
const COMPARE_TABLES = { "key-figures": "Key figures", snapshot: "Snapshot rows" };

function loadScenarioFullState(scenarioId) {
  const blob = readRaw(scenarioKey(scenarioId));
  if (blob) {
    const s = hydrate(blob, PROFILES);
    if (s) return s;
  }
  // No stored blob yet (e.g. the workspace's very first bootstrap
  // scenario, before anything has triggered a save) or a corrupt one —
  // same fallback loadActiveState() uses for the identical situation.
  // Without this, an untouched scenario would silently drop out of the
  // comparison instead of showing as the defaults it actually is.
  return defaultState(PROFILES);
}

// Mirrors snapshotCtxFor(y) exactly, parameterized for an arbitrary
// (state, projection) pair rather than the active workspace's globals.
function snapshotCtxForScenario(s, p, y) {
  const rt = p.schedule.rowTotals;
  return {
    incomeRows: s.cashflows.income, rowTotalsIncome: rt.income,
    expenseRows: s.cashflows.expenses, rowTotalsExpenses: rt.expenses,
    deductionRows: s.cashflows.deductions ?? [], rowTotalsDeductions: rt.deductions,
    properties: s.properties ?? [], liabilities: s.liabilities ?? [],
    superAccounts: s.plan.superAccounts ?? [], y,
    educationBlocks: flatEducationBlocks(s.plan), rowTotalsEducation: rt.education,
  };
}

function loadComparisonScenarios(scenarioIds) {
  return scenarioIds.map((id) => {
    const s = loadScenarioFullState(id);
    if (!s) return null;
    return { id, state: s, projection: projectPlan(s, PROFILES) };
  }).filter(Boolean);
}

function compareScenarioName(scenarios, id) {
  return scenarios.find((sc) => sc.id === id)?.name ?? id;
}

function compareKeyFigureRows(loaded) {
  const scenarioValues = loaded.map((l) =>
    keyFigureValuesAtYear(buildKeyFiguresGroups({ state: l.state, projection: l.projection }), compareYear));
  return keyFigureComparisonRows(scenarioValues);
}

function compareSnapshotColumns(loaded) {
  return loaded.map((l) => {
    const ctx = snapshotCtxForScenario(l.state, l.projection, compareYear);
    const row = l.projection.yearly[compareYear];
    return { y: compareYear, client: cashflowStatement(row, ctx, "client"), partner: null, total: cashflowStatement(row, ctx, null) };
  });
}

function compareKeyFiguresTableHTML(loaded, names) {
  const comparisonRows = compareKeyFigureRows(loaded);
  return `
    <table class="tl">
      <thead><tr>
        <th class="tl-corner"></th>${names.map((n) => `<th class="tl-year">${escapeHTML(n)}</th>`).join("")}
        ${names.slice(1).map((n) => `<th class="tl-year">Δ vs ${escapeHTML(names[0])}</th>`).join("")}
      </tr></thead>
      <tbody>
        ${comparisonRows.map((r) => `
          <tr>
            <th class="tl-label">${escapeHTML(r.label)}</th>
            ${r.values.map((v) => `<td class="tl-num">${v == null ? "–" : fmtLedgerCell(v)}</td>`).join("")}
            ${r.deltas.map((d) => `<td class="tl-num">${d == null ? "–" : fmtLedgerCell(d)}</td>`).join("")}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// Snapshot rows, household total only — a disclosed simplification:
// scenarios being compared can have different household compositions
// (single vs couple), and a Client/Partner split interleaved across
// 2-3 scenarios reads as noise; each scenario's own Snapshot view still
// has the full split.
function compareSnapshotTableHTML(loaded, names) {
  const snapshotTable = buildSnapshotTable(compareSnapshotColumns(loaded), { hideEmptyRows: state.display.hideEmptyRows !== false });
  let lastSection = null;
  const body = snapshotTable.rows.map((r) => {
    const sectionRow = r.section !== lastSection
      ? `<tr class="tl-group"><th colspan="${names.length + 1}">${escapeHTML(r.section)}</th></tr>` : "";
    lastSection = r.section;
    const cells = r.cells.map((c) => `<td class="tl-num">${fmtLedgerCell(c.total)}</td>`).join("");
    return sectionRow + `<tr class="${r.total ? "tl-total" : ""}"><th class="tl-label">${escapeHTML(r.label)}</th>${cells}</tr>`;
  }).join("");
  const head = `<tr><th class="tl-corner"></th>${names.map((n) => `<th class="tl-year">${escapeHTML(n)}</th>`).join("")}</tr>`;
  return `<table class="tl"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function compareExportActionsHTML() {
  return `
    <div class="focus-section">
      <div class="output-actions">
        <button class="btn-text" type="button" id="compareExportCsvBtn">Export CSV</button>
        <button class="btn-text" type="button" id="compareCopyBtn">Copy for Word</button>
      </div>
    </div>
  `;
}

function renderCompareBody(loaded, scenarios, base) {
  const years = base.projection.yearly.length;
  if (compareYear == null || compareYear >= years) compareYear = 0;
  const names = loaded.map((l) => compareScenarioName(scenarios, l.id));

  const seriesOptions = Object.entries(COMPARE_SERIES).map(([key, s]) =>
    `<option value="${key}"${key === compareSeries ? " selected" : ""}>${escapeHTML(s.label)}</option>`).join("");
  const tableOptions = Object.entries(COMPARE_TABLES).map(([key, label]) =>
    `<option value="${key}"${key === compareSeries ? " selected" : ""}>${escapeHTML(label)} (table)</option>`).join("");
  const isTable = compareSeries in COMPARE_TABLES;
  const yearOptions = base.projection.yearly.map((_, y) =>
    `<option value="${y}"${y === compareYear ? " selected" : ""}>${escapeHTML(fyShortLabel(firstFyStartYear(base.state.plan.start) + y))} (age ${base.projection.schedule.clientAges[y]})</option>`
  ).join("");

  let viewHTML;
  if (!isTable) {
    viewHTML = `
      <div class="focus-section">
        <h3>${escapeHTML(COMPARE_SERIES[compareSeries].label)} over time</h3>
        <div id="compareChart"></div>
      </div>
      <div class="focus-section">
        <div class="output-actions">
          <button class="btn-text" type="button" id="compareExportPngBtn">Export PNG</button>
        </div>
      </div>
    `;
  } else {
    const tableHTML = compareSeries === "key-figures"
      ? compareKeyFiguresTableHTML(loaded, names)
      : compareSnapshotTableHTML(loaded, names);
    viewHTML = `
      <div class="focus-section">
        <label>Compare at <select id="compareYearSelect">${yearOptions}</select></label>
      </div>
      <div class="focus-section">
        <h3>${escapeHTML(COMPARE_TABLES[compareSeries])}
          ${compareSeries === "snapshot" ? `<span class="helper-text">(household total — see each scenario's own Snapshot view for the Client/Partner split)</span>` : ""}
        </h3>
        <div class="tl-wrap">${tableHTML}</div>
      </div>
      ${compareExportActionsHTML()}
    `;
  }

  return `
    <div class="focus-section">
      <label>View
        <select id="compareSeriesSelect">
          <optgroup label="Chart">${seriesOptions}</optgroup>
          <optgroup label="Table">${tableOptions}</optgroup>
        </select>
      </label>
    </div>
    ${viewHTML}
  `;
}

function renderComparePage(clientId, scenarioIds) {
  const client = findClient(workspace, clientId);
  if (!client) { location.replace("#/clients"); return; }
  renderBreadcrumb([
    { label: "Clients", href: "#/clients" },
    { label: client.name, href: formatRoute({ page: "client", clientId }) },
    { label: "Compare" },
  ]);

  const scenarios = client.scenarios;
  const loaded = scenarios.length >= 2 ? loadComparisonScenarios(scenarioIds) : [];
  const mismatched = loaded.length >= 2 ? loaded.slice(1).filter((l) => !planWindowsMatch(loaded[0].state.plan, l.state.plan)) : [];

  let bodyHTML;
  if (scenarios.length < 2) {
    bodyHTML = `<p class="helper-text">Add another scenario for this client to compare.</p>`;
  } else if (loaded.length < 2) {
    bodyHTML = `
      <p class="helper-text">
        Pick 2–3 scenarios to compare from the
        <a href="${formatRoute({ page: "client", clientId })}">client page</a>.
      </p>`;
  } else if (mismatched.length > 0) {
    const names = mismatched.map((m) => compareScenarioName(scenarios, m.id)).join(", ");
    bodyHTML = `
      <p class="helper-warning">
        "${escapeHTML(compareScenarioName(scenarios, loaded[0].id))}" and "${escapeHTML(names)}" have different plan windows
        (current age, start date, or end age) and can't be meaningfully compared on a single age axis — align
        their Setup pages first, or pick different scenarios. Plan windows are never approximated to fit.
      </p>`;
  } else {
    bodyHTML = renderCompareBody(loaded, scenarios, loaded[0]);
  }

  const pickedNames = loaded.map((l) => compareScenarioName(scenarios, l.id));
  els.pageCompare.innerHTML = `
    <header class="page-head"><h1>Compare scenarios</h1></header>
    <p class="helper-text">
      ${pickedNames.length ? `${escapeHTML(pickedNames.join(" vs "))} — ` : ""}scenarios are independent copies;
      client facts entered in one aren't reflected in another.
    </p>
    <div class="focus-panel">${bodyHTML}</div>
  `;

  if (loaded.length >= 2 && mismatched.length === 0 && !(compareSeries in COMPARE_TABLES)) {
    renderCompareChart(loaded, scenarios);
  }
}

function renderCompareChart(loaded, scenarios) {
  const el = $("compareChart");
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const ages = loaded[0].projection.schedule.clientAges;
  const palette = ["#1c5ab4", "#dc5a28", "#6b8e23"];
  // Each scenario's own CPI drives its own nominal conversion — a
  // shared global `displayFactor` would silently misconvert a scenario
  // whose CPI assumption differs from the active one.
  const factorFor = (s, y) => (isNominal() ? nominalFactor(endMonthOfYear(y), s.assumptions.cpi) : 1);
  const seriesFn = COMPARE_SERIES[compareSeries].fn;
  const traces = loaded.map((l, i) => ({
    x: ages,
    y: l.projection.yearly.map((row, y) => seriesFn(row) * factorFor(l.state, y)),
    name: compareScenarioName(scenarios, l.id),
    type: "scatter", mode: "lines",
    line: { color: palette[i % palette.length], width: 2 },
    hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(compareScenarioName(scenarios, l.id))}</extra>`,
  }));
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `${COMPARE_SERIES[compareSeries].label} (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

function compareTableToHTML(loaded, scenarios) {
  const names = loaded.map((l) => compareScenarioName(scenarios, l.id));
  if (compareSeries === "key-figures") {
    const rows = compareKeyFigureRows(loaded).map((r) => `
      <tr>
        <td>${escapeHTML(r.label)}</td>
        ${r.values.map((v) => `<td>${v == null ? "" : fmtMoney(v)}</td>`).join("")}
        ${r.deltas.map((d) => `<td>${d == null ? "" : fmtMoney(d)}</td>`).join("")}
      </tr>
    `).join("");
    return `
      <p><strong>Compare scenarios — Key figures</strong></p>
      <table border="1" cellspacing="0" cellpadding="4">
        <tr><th>Key figure</th>${names.map((n) => `<th>${escapeHTML(n)}</th>`).join("")}${names.slice(1).map((n) => `<th>Δ vs ${escapeHTML(names[0])}</th>`).join("")}</tr>
        ${rows}
      </table>
    `;
  }
  const snapshotTable = buildSnapshotTable(compareSnapshotColumns(loaded), { hideEmptyRows: state.display.hideEmptyRows !== false });
  return `<p><strong>Compare scenarios — Snapshot</strong></p>${snapshotToHTML(snapshotTable, names, false)}`;
}

function exportComparePNG(client) {
  const el = $("compareChart");
  if (typeof Plotly === "undefined" || !el?.data) return;
  Plotly.toImage(el, { format: "png", width: 1280, height: 640 }).then((dataUrl) => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${sanitiseFilename(client.name)}-compare-${compareSeries}.png`;
    a.click();
  });
}

function exportCompareCSV(loaded, scenarios, client) {
  const names = loaded.map((l) => compareScenarioName(scenarios, l.id));
  const lines = [];
  if (compareSeries === "key-figures") {
    lines.push(["Key figure", ...names, ...names.slice(1).map(() => `Delta vs ${names[0]}`)].map(csvEsc).join(","));
    for (const r of compareKeyFigureRows(loaded)) {
      lines.push([r.label, ...r.values.map((v) => v ?? ""), ...r.deltas.map((d) => d ?? "")].map((v) => csvEsc(String(v))).join(","));
    }
  } else {
    const snapshotTable = buildSnapshotTable(compareSnapshotColumns(loaded), { hideEmptyRows: state.display.hideEmptyRows !== false });
    lines.push(snapshotToCSV(snapshotTable, names, false));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sanitiseFilename(client.name)}-compare-${compareSeries}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

els.pageCompare.addEventListener("change", (e) => {
  if (!currentRoute || currentRoute.page !== "compare") return;
  if (e.target.id === "compareSeriesSelect") {
    compareSeries = e.target.value;
    renderComparePage(currentRoute.clientId, currentRoute.scenarioIds);
  } else if (e.target.id === "compareYearSelect") {
    compareYear = Number(e.target.value);
    renderComparePage(currentRoute.clientId, currentRoute.scenarioIds);
  }
});

els.pageCompare.addEventListener("click", (e) => {
  if (!currentRoute || currentRoute.page !== "compare") return;
  const btn = e.target.closest("button[id^='compare']");
  if (!btn) return;
  const client = findClient(workspace, currentRoute.clientId);
  if (!client) return;
  const loaded = loadComparisonScenarios(currentRoute.scenarioIds);
  if (loaded.length < 2) return;
  const scenarios = client.scenarios;
  if (btn.id === "compareExportPngBtn") {
    exportComparePNG(client);
  } else if (btn.id === "compareExportCsvBtn") {
    exportCompareCSV(loaded, scenarios, client);
  } else if (btn.id === "compareCopyBtn") {
    const html = compareTableToHTML(loaded, scenarios);
    const plain = "Compare scenarios";
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy for Word"; }, 1500);
      }).catch(() => window.alert("Couldn't access the clipboard — try again, or use Export CSV instead."));
    } else {
      window.alert("Clipboard access isn't available in this browser — use Export CSV instead.");
    }
  }
});

// --- What if: Interest rate shocks (docs/specs/14-what-if.md, Commit 2) ----
//
// Every figure below is read straight off whatIfRateShock.js's
// buildRateShockView — itself built on whatIf.js's runShock (a real
// projectPlan() clone-and-compare, never a shortcut) and
// focusDebtPayoff.js's own per-loan reader, called once against the
// base output and once against the shocked one. One shock at a time
// against the base — shocks are never stacked or combined (the spec's
// own rule for this whole group).
let whatIfRateShockKind = "rateShock"; // "rateShock" | "revertRateShock"
let whatIfRateShockDelta = 1;
let whatIfRateShockLens = "cashflow";

function renderWhatIfRateShockView() {
  const loans = eligibleRateShockLoans(state);
  if (loans.length === 0) {
    els.viewWhatIfRateShock.innerHTML = focusEmptyStateHTML(
      "What a rate move does to repayments and affordability — immediately for a variable loan, from rollover for a fixed one — add a liability to see it.",
      "liabilities"
    );
    return;
  }
  const view = buildRateShockView({ state, shockKind: whatIfRateShockKind, deltaPct: whatIfRateShockDelta });
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const hasFixed = loans.some((l) => l.rateType === "fixed");
  const lastY = view.deltas.byYear.length - 1;
  const minimumBalance = state.plan.workingCash?.minimumBalance ?? 0;
  const h = rateShockHeadline({ base: view.base, shocked: view.shocked, deltas: view.deltas });

  const deltaOptions = RATE_SHOCK_DELTAS.map((d) =>
    `<option value="${d}"${d === whatIfRateShockDelta ? " selected" : ""}>${d > 0 ? "+" : ""}${d}pp</option>`
  ).join("");

  const baseUnfunded = view.deltas.headline.base.totalUnfunded;
  const shockedUnfunded = view.deltas.headline.shocked.totalUnfunded;
  const unfundedIntro = shockedUnfunded > baseUnfunded
    ? `<p class="helper-warning">${baseUnfunded === 0 ? "This shock introduces unfunded cashflow" : "Unfunded cashflow grows under this shock"} — ${fmtMoney(shockedUnfunded)}${view.deltas.headline.shocked.firstShortfallAge != null ? ` starting at age ${view.deltas.headline.shocked.firstShortfallAge}` : ""} the plan can't actually cover, versus ${fmtMoney(baseUnfunded)} in the base case.</p>`
    : `<p class="helper-text">No unfunded cashflow introduced by this shock.</p>`;

  const headlineHTML = `
    <p class="helper-text">${h.firstAffectedYear != null
      ? `Change in annual repayments from age ${view.base.schedule.clientAges[h.firstAffectedYear]}: <b>${fmtMoney(h.changeInRepayments * factor(h.firstAffectedYear))}</b>.`
      : "Repayments never actually differ from base under this shock."}</p>
    <p class="helper-text">Total additional interest over the life of the loan(s): <b>${fmtMoney(h.totalAdditionalInterest)}</b>.</p>
  `;

  const loanRows = view.perLoan.map((l) => `
    <tr>
      <td>${escapeHTML(l.name)} <span class="helper-text">(${l.rateType})</span></td>
      <td class="tl-num">${fmtMoney(l.base.totalInterest)}</td>
      <td class="tl-num">${fmtMoney(l.shocked.totalInterest)}</td>
      <td class="tl-num">${l.base.rollover ? `${fmtMoney(l.base.rollover.repaymentBefore)} → ${fmtMoney(l.base.rollover.repaymentAfter)}` : "—"}</td>
      <td class="tl-num">${l.shocked.rollover ? `${fmtMoney(l.shocked.rollover.repaymentBefore)} → ${fmtMoney(l.shocked.rollover.repaymentAfter)}` : "—"}</td>
    </tr>
  `).join("");

  els.viewWhatIfRateShock.innerHTML = `
    <h2 class="section-heading">Interest rate shocks</h2>
    <p class="helper-text">One shock at a time against the base — shocks aren't stacked or combined.</p>
    <div class="focus-panel">
      <div class="focus-section">
        <div id="whatIfRateShockKindToggle" class="seg-toggle" role="tablist" aria-label="Shock type"></div>
        <label>Magnitude
          <select id="whatIfRateShockDeltaSelect">${deltaOptions}</select>
        </label>
        ${whatIfRateShockKind === "revertRateShock" && !hasFixed ? `<p class="helper-text">No fixed-rate loans in this plan — a revert-rate shock has nothing to act on.</p>` : ""}
      </div>
      <div class="focus-section">
        <h3>Affordability</h3>
        ${headlineHTML}
        ${unfundedIntro}
      </div>
      <div class="focus-section">
        ${lensToggleHTML("whatIfRateShockLensToggle")}
      </div>
      ${whatIfRateShockLens === "cashflow" ? cashflowLensSectionHTML("whatIfRateShock") : `
        <div class="focus-section">
          <h3>Loan balances, base vs shocked</h3>
          <div id="whatIfRateShockChart"></div>
        </div>
      `}
      <div class="focus-section">
        <h3>Repayments and total interest over the life of each loan</h3>
        <table class="focus-table">
          <thead><tr><th></th><th>Interest (base)</th><th>Interest (shocked)</th><th>Repayment before → after (base)</th><th>Repayment before → after (shocked)</th></tr></thead>
          <tbody>${loanRows}</tbody>
        </table>
      </div>
    </div>
  `;
  renderEntitySelector(
    $("whatIfRateShockKindToggle"),
    [{ id: "rateShock", label: "Rate shock" }, { id: "revertRateShock", label: "Revert-rate shock" }],
    whatIfRateShockKind,
    (id) => { whatIfRateShockKind = id; renderWhatIfRateShockView(); }
  );
  wireLensToggle("whatIfRateShockLensToggle", whatIfRateShockLens, (id) => { whatIfRateShockLens = id; renderWhatIfRateShockView(); });
  if (whatIfRateShockLens === "cashflow") {
    renderCashflowLensSection("whatIfRateShock", [
      { label: "Base", out: view.base, color: "#222", dash: "dot" },
      { label: "Shocked", out: view.shocked, color: "#dc5a28" },
    ], factor, minimumBalance);
    return;
  }
  renderWhatIfRateShockChart(view, factor);
}

function renderWhatIfRateShockChart(view, factor) {
  const el = $("whatIfRateShockChart");
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const palette = ["#1c5ab4", "#dc5a28", "#6b8e23", "#5e60ce", "#2e8a8a"];
  const traces = [];
  view.perLoan.forEach((l, i) => {
    const color = palette[i % palette.length];
    const ages = l.base.balanceSeries.map((r) => r.age);
    traces.push({
      x: ages, y: l.base.balanceSeries.map((r) => r.actual * factor(r.year)),
      name: `${l.name} — base`, type: "scatter", mode: "lines",
      line: { color, width: 2 },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(l.name)} — base</extra>`,
    });
    traces.push({
      x: ages, y: l.shocked.balanceSeries.map((r) => r.actual * factor(r.year)),
      name: `${l.name} — shocked`, type: "scatter", mode: "lines",
      line: { color, width: 2, dash: "dash" },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(l.name)} — shocked</extra>`,
    });
  });
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false },
    yaxis: {
      title: { text: `Loan balance (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

function exportWhatIfRateShockCSV() {
  const view = buildRateShockView({ state, shockKind: whatIfRateShockKind, deltaPct: whatIfRateShockDelta });
  if (!view) return;
  const lines = [csvEsc(`Interest rate shock: ${whatIfRateShockKind}, ${whatIfRateShockDelta > 0 ? "+" : ""}${whatIfRateShockDelta}pp`)];
  lines.push("");
  lines.push(["Loan", "Rate type", "Total interest (base)", "Total interest (shocked)"].map(csvEsc).join(","));
  for (const l of view.perLoan) {
    lines.push([l.name, l.rateType, l.base.totalInterest.toFixed(2), l.shocked.totalInterest.toFixed(2)]
      .map((v) => csvEsc(String(v))).join(","));
  }
  lines.push("");
  lines.push(["Year", "Net assets delta", "Closing balance delta", "Tax delta", "Surplus delta", "Unfunded cashflow delta"].map(csvEsc).join(","));
  for (const y of view.deltas.byYear) {
    lines.push([y.year, y.netAssets.toFixed(2), y.closingBalance.toFixed(2), y.totalTax.toFixed(2), y.surplus.toFixed(2), y.unfundedCashflow.toFixed(2)].join(","));
  }
  downloadCSV("whatif-rate-shock", lines);
}

els.viewWhatIfRateShock.addEventListener("change", (e) => {
  if (e.target.id !== "whatIfRateShockDeltaSelect") return;
  whatIfRateShockDelta = Number(e.target.value);
  renderWhatIfRateShockView();
});

// --- What if: Market crash timing (docs/specs/14-what-if.md, Commit 3) -----
//
// Every figure below is read straight off whatIfCrash.js's
// buildCrashTimingView — itself built on sequenceRisk.js's real crash
// injection (deterministic.js's own mc.shockFor hook, no engine
// change). The SAME shock at three representative ages against the
// SAME base: identical magnitude, radically different outcome. This
// is the deterministic what-if; Monte Carlo (also in this group)
// models the same sequence-of-returns risk probabilistically.
const CRASH_DROP_OPTIONS = [10, 20, 30, 40, 50];
const CRASH_RECOVERY_OPTIONS = [0, 1, 2, 3, 5, 7];
let whatIfCrashDropPct = 30;
let whatIfCrashRecoveryYears = 0;
// A crash genuinely IS an asset-value event, so net assets stays
// primary here (unlike the three cashflow shocks) — cashflow is only
// a secondary toggle, for consistency.
let whatIfCrashLens = "net-assets";

function renderWhatIfCrashView() {
  const emptyMsg = "How the SAME market crash at different points in your plan produces very different outcomes — add a growth-exposed financial asset or super account to see it.";
  if (eligibleCrashHoldings(state).length === 0) {
    els.viewWhatIfCrash.innerHTML = focusEmptyStateHTML(emptyMsg, "financial-assets");
    return;
  }
  const view = buildCrashTimingView({ state, dropPct: whatIfCrashDropPct, recoveryYears: whatIfCrashRecoveryYears });
  if (!view) {
    els.viewWhatIfCrash.innerHTML = focusEmptyStateHTML(emptyMsg, "financial-assets");
    return;
  }
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lastY = view.base.yearly.length - 1;
  const minimumBalance = state.plan.workingCash?.minimumBalance ?? 0;

  const dropOptions = CRASH_DROP_OPTIONS.map((d) =>
    `<option value="${d}"${d === whatIfCrashDropPct ? " selected" : ""}>${d}%</option>`
  ).join("");
  const recoveryOptions = CRASH_RECOVERY_OPTIONS.map((y) =>
    `<option value="${y}"${y === whatIfCrashRecoveryYears ? " selected" : ""}>${y === 0 ? "No recovery" : `${y} year${y > 1 ? "s" : ""}`}</option>`
  ).join("");

  const baseEnd = view.base.yearly[lastY].netAssets;
  const rows = view.ages.map((a) => {
    if (!a.out) {
      return `<tr><td>${escapeHTML(a.label)} (age ${a.age})</td><td colspan="2" class="helper-text">Not resolvable this plan year</td></tr>`;
    }
    const shockedEnd = a.out.yearly[lastY].netAssets;
    return `
      <tr>
        <td>${escapeHTML(a.label)} (age ${a.age})</td>
        <td class="tl-num">${fmtMoney(shockedEnd * factor(lastY))}</td>
        <td class="tl-num">${fmtMoney((shockedEnd - baseEnd) * factor(lastY))}</td>
      </tr>`;
  }).join("");

  els.viewWhatIfCrash.innerHTML = `
    <h2 class="section-heading">Market crash timing</h2>
    <p class="helper-text">This is a deterministic what-if — the SAME shock applied at three different points in time, never combined. The Monte Carlo view (also in this group) models this same sequence-of-returns risk probabilistically, across thousands of random paths, rather than at one chosen moment.</p>
    <div class="focus-panel">
      <div class="focus-section">
        <label>Crash size
          <select id="whatIfCrashDropSelect">${dropOptions}</select>
        </label>
        <label>Recovery period
          <select id="whatIfCrashRecoverySelect">${recoveryOptions}</select>
        </label>
      </div>
      <div class="focus-section">
        ${lensToggleHTML("whatIfCrashLensToggle")}
      </div>
      ${whatIfCrashLens === "cashflow" ? cashflowLensSectionHTML("whatIfCrash") : `
        <div class="focus-section">
          <h3>Net assets over time</h3>
          <div id="whatIfCrashChart"></div>
        </div>
        <div class="focus-section">
          <h3>End net assets by crash timing</h3>
          <table class="focus-table">
            <thead><tr><th>Crash at</th><th>End net assets</th><th>Δ vs base</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `}
    </div>
  `;
  wireLensToggle("whatIfCrashLensToggle", whatIfCrashLens, (id) => { whatIfCrashLens = id; renderWhatIfCrashView(); });
  if (whatIfCrashLens === "cashflow") {
    const palette = ["#1c5ab4", "#dc5a28", "#6b8e23"];
    renderCashflowLensSection("whatIfCrash", [
      { label: "Base", out: view.base, color: "#222", dash: "dot" },
      ...view.ages.map((a, i) => ({ label: `${a.label} (age ${a.age})`, out: a.out, color: palette[i % palette.length] })),
    ], factor, minimumBalance);
    return;
  }
  renderWhatIfCrashChart(view, factor);
}

function renderWhatIfCrashChart(view, factor) {
  const el = $("whatIfCrashChart");
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const ages = view.base.schedule.clientAges;
  const palette = ["#1c5ab4", "#dc5a28", "#6b8e23"];
  const traces = [{
    x: ages, y: view.base.yearly.map((row, y) => row.netAssets * factor(y)),
    name: "Base (no crash)", type: "scatter", mode: "lines",
    line: { color: "#222", width: 2.5, dash: "dot" },
    hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Base</extra>",
  }];
  view.ages.forEach((a, i) => {
    if (!a.out) return;
    traces.push({
      x: ages, y: a.out.yearly.map((row, y) => row.netAssets * factor(y)),
      name: `${a.label} (age ${a.age})`, type: "scatter", mode: "lines",
      line: { color: palette[i % palette.length], width: 2 },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(a.label)}</extra>`,
    });
  });
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

function exportWhatIfCrashCSV() {
  const view = buildCrashTimingView({ state, dropPct: whatIfCrashDropPct, recoveryYears: whatIfCrashRecoveryYears });
  if (!view) return;
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const ages = view.base.schedule.clientAges;
  const lines = [csvEsc(`Market crash timing: ${whatIfCrashDropPct}% drop, ${whatIfCrashRecoveryYears} year(s) recovery`)];
  lines.push("");
  const header = ["Age", "Base", ...view.ages.map((a) => `${a.label} (age ${a.age})`)];
  lines.push(header.map(csvEsc).join(","));
  for (let y = 0; y < view.base.yearly.length; y++) {
    const row = [
      ages[y],
      (view.base.yearly[y].netAssets * factor(y)).toFixed(2),
      ...view.ages.map((a) => (a.out ? (a.out.yearly[y].netAssets * factor(y)).toFixed(2) : "")),
    ];
    lines.push(row.map((v) => csvEsc(String(v))).join(","));
  }
  downloadCSV("whatif-crash", lines);
}

els.viewWhatIfCrash.addEventListener("change", (e) => {
  if (e.target.id === "whatIfCrashDropSelect") {
    whatIfCrashDropPct = Number(e.target.value);
    renderWhatIfCrashView();
  } else if (e.target.id === "whatIfCrashRecoverySelect") {
    whatIfCrashRecoveryYears = Number(e.target.value);
    renderWhatIfCrashView();
  }
});

// --- What if: Income interruption and expense shock (docs/specs/
// 14-what-if.md, Commit 4) ---------------------------------------------------
//
// Both read straight off whatIf.js's runShock (the SAME generic runner
// every What-if shock uses) — neither needed a dedicated per-shock
// reader module the way rate shocks and crash timing did, since the
// household-level deltas runShock already computes (net assets,
// closing balance, tax, surplus, unfunded cashflow, plus headline
// figures for both runs) are exactly what "the cash drawn down to
// bridge the gap, whether the buffer holds, the recovery path, and the
// permanent cost" and "the expense shock's affordability answer" need.

// Shared by both views below (and reusable by any future simple
// base-vs-shocked What-if view): a single net-assets-over-time chart,
// base dotted, shocked solid.
function renderBaseVsShockedChart(elId, base, shocked, factor, shockedLabel) {
  const el = $(elId);
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const ages = base.schedule.clientAges;
  const traces = [
    {
      x: ages, y: base.yearly.map((row, y) => row.netAssets * factor(y)),
      name: "Base", type: "scatter", mode: "lines",
      line: { color: "#222", width: 2.5, dash: "dot" },
      hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Base</extra>",
    },
    {
      x: ages, y: shocked.yearly.map((row, y) => row.netAssets * factor(y)),
      name: shockedLabel, type: "scatter", mode: "lines",
      line: { color: "#dc5a28", width: 2.5 },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(shockedLabel)}</extra>`,
    },
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

// --- Cashflow lens (What if: cashflow as the primary lens follow-up) -------
//
// Three of the four shocks (income gap, expense shock, rate shock)
// perturb CASHFLOW, not asset values — for these, "do we get through
// it?" is answered by the surplus line and the working cash balance,
// not net worth decades away. Net assets is the consequence; cashflow
// is the experience. A crash genuinely IS an asset-value event, so it
// keeps net assets as its primary lens, but gets this same cashflow
// view as a secondary toggle, for consistency.
//
// `runs` is generic ([{label, out, color, dash}]) so these two chart
// functions serve both the simple base-vs-shocked views (2 runs) and
// crash's secondary toggle (base + 3 ages, 4 runs) without duplication.
// A run with `out: null` (crash's own "not resolvable this plan year"
// case) is skipped, not plotted as zeros.

function renderSurplusWcaChart(elId, runs, factor, minimumBalance) {
  const el = $(elId);
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const live = runs.filter((r) => r.out);
  const ages = live[0]?.out.schedule.clientAges ?? [];
  const traces = [];
  for (const r of live) {
    traces.push({
      x: ages, y: r.out.yearly.map((row, y) => row.surplusOrDeficit * factor(y)),
      name: `${r.label} — surplus/(deficit)`, type: "scatter", mode: "lines",
      line: { color: r.color, width: 2.5, dash: r.dash },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(r.label)} — surplus/(deficit)</extra>`,
    });
    traces.push({
      x: ages, y: r.out.yearly.map((row, y) => row.wcaClosing * factor(y)),
      name: `${r.label} — working cash`, type: "scatter", mode: "lines",
      line: { color: r.color, width: 1.5, dash: r.dash === "dot" ? "dot" : "dashdot" },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(r.label)} — working cash</extra>`,
    });
  }
  // The minimum balance (emergency fund target) is a plan-level
  // constant in REAL dollars — plotted as its own line (not a fixed
  // Plotly shape) so it scales under the nominal/"future dollars"
  // toggle exactly the way the plan's own target actually would,
  // year by year, rather than reading as a flat nominal line.
  if (minimumBalance > 0 && ages.length) {
    traces.push({
      x: ages, y: ages.map((_, y) => minimumBalance * factor(y)),
      name: "Minimum balance (target)", type: "scatter", mode: "lines",
      line: { color: "#888", width: 1.5, dash: "dash" },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Minimum balance</extra>",
    });
  }
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.25, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Cashflow (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

// Unfunded cashflow and deficit funded from assets — both normally
// zero, so bars (highlighted wherever non-zero) read better than lines
// that would otherwise sit invisibly on the axis for most of the plan.
function renderUnfundedDeficitChart(elId, runs, factor) {
  const el = $(elId);
  if (!el) return;
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const live = runs.filter((r) => r.out);
  const ages = live[0]?.out.schedule.clientAges ?? [];
  const traces = [];
  for (const r of live) {
    const isBase = r.dash === "dot";
    traces.push({
      x: ages, y: r.out.yearly.map((row, y) => row.unfundedCashflow * factor(y)),
      name: `${r.label} — unfunded cashflow`, type: "bar",
      marker: { color: "#780000", opacity: isBase ? 0.3 : 0.9 },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(r.label)} — unfunded cashflow</extra>`,
    });
    traces.push({
      x: ages, y: r.out.yearly.map((row, y) => row.deficitFundedFromAssets * factor(y)),
      name: `${r.label} — deficit funded from assets`, type: "bar",
      marker: { color: "#dc5a28", opacity: isBase ? 0.3 : 0.75 },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(r.label)} — deficit funded from assets</extra>`,
    });
  }
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 50 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    barmode: "group",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.25, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Cashflow (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  }, { displayModeBar: false, responsive: true });
}

// Both charts share the same mount markup wherever they're used —
// "Surplus and working cash" plus "Unfunded cashflow and deficit
// funded from assets" — one heading pair, two chart ids derived from
// a shared id prefix.
function cashflowLensSectionHTML(idPrefix) {
  return `
    <div class="focus-section">
      <h3>Surplus and working cash, base vs shocked</h3>
      <div id="${idPrefix}SurplusWca"></div>
    </div>
    <div class="focus-section">
      <h3>Unfunded cashflow and deficit funded from assets</h3>
      <div id="${idPrefix}UnfundedDeficit"></div>
    </div>
  `;
}
function renderCashflowLensSection(idPrefix, runs, factor, minimumBalance) {
  renderSurplusWcaChart(`${idPrefix}SurplusWca`, runs, factor, minimumBalance);
  renderUnfundedDeficitChart(`${idPrefix}UnfundedDeficit`, runs, factor);
}

// The lens toggle itself — identical markup/behaviour everywhere it
// appears, wired via renderEntitySelector like every other segmented
// control in this codebase.
function lensToggleHTML(toggleElId) {
  return `<div id="${toggleElId}" class="seg-toggle" role="tablist" aria-label="Lens"></div>`;
}
function wireLensToggle(toggleElId, current, onChange) {
  renderEntitySelector(
    $(toggleElId),
    [{ id: "cashflow", label: "Cashflow" }, { id: "net-assets", label: "Net assets" }],
    current,
    onChange
  );
}

function unfundedCalloutHTML(deltas) {
  const base = deltas.headline.base.totalUnfunded;
  const shocked = deltas.headline.shocked.totalUnfunded;
  if (shocked <= base) return `<p class="helper-text">The buffer holds — no unfunded cashflow introduced.</p>`;
  return `<p class="helper-warning">${base === 0 ? "This introduces unfunded cashflow" : "Unfunded cashflow grows"} — ${fmtMoney(shocked)}${deltas.headline.shocked.firstShortfallAge != null ? ` starting at age ${deltas.headline.shocked.firstShortfallAge}` : ""} the plan can't actually cover${base > 0 ? `, versus ${fmtMoney(base)} in the base case` : ""}.</p>`;
}

let whatIfIncomeGapOwner = "client";
let whatIfIncomeGapAge = null;
let whatIfIncomeGapMonths = 6;
let whatIfIncomeGapReplacementPct = 0;
// Cashflow primary: "do we get through it?" is the surplus line and
// the working cash balance, not net worth in 2060. Net assets stays
// one toggle away.
let whatIfIncomeGapLens = "cashflow";

function renderWhatIfIncomeGapView() {
  const hasSalary = (state.cashflows.income ?? []).some((r) => r.category === "salary");
  if (!hasSalary) {
    els.viewWhatIfIncomeGap.innerHTML = focusEmptyStateHTML(
      "What a period without your usual salary — parental leave, illness, a career break — actually costs, including the compounding lost along with it. Add a salary income row to see it.",
      "income"
    );
    return;
  }
  const couple = isCouple();
  if (whatIfIncomeGapOwner === "partner" && !couple) whatIfIncomeGapOwner = "client";
  if (whatIfIncomeGapAge == null) whatIfIncomeGapAge = state.plan.client.currentAge + 1;

  const shock = { kind: "incomeGap", ownerId: whatIfIncomeGapOwner, atAge: whatIfIncomeGapAge, months: whatIfIncomeGapMonths, replacementPct: whatIfIncomeGapReplacementPct };
  const { base, shocked, deltas } = runShock(state, shock);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lastY = deltas.byYear.length - 1;
  const minimumBalance = state.plan.workingCash?.minimumBalance ?? 0;
  const h = incomeGapHeadline({ shocked, deltas });

  const headlineHTML = `
    <p class="helper-text">Total cash drawn from other assets to bridge the gap: <b>${fmtMoney(h.totalCashDrawn * factor(lastY))}</b>.</p>
    ${h.bufferHeld
      ? `<p class="helper-text">The working cash buffer held throughout — nothing else needed to be sold to keep it topped up.</p>`
      : `<p class="helper-warning">The buffer didn't hold on its own — other assets were drawn down starting at age ${base.schedule.clientAges[h.breachYear]}.</p>`}
    <p class="helper-text">Permanent cost at the end of the projection: <b>${fmtMoney(h.permanentCost * factor(lastY))}</b> — larger than the cash drawn, because the compounding on it is lost too.</p>
  `;

  els.viewWhatIfIncomeGap.innerHTML = `
    <h2 class="section-heading">Income interruption</h2>
    <p class="helper-text">Every date in this engine resolves to a whole plan year, so the gap length is rounded to the nearest whole number of years.</p>
    <div class="focus-panel">
      <div class="focus-section">
        ${couple ? `<div id="whatIfIncomeGapOwnerToggle" class="seg-toggle" role="tablist" aria-label="Owner"></div>` : ""}
        <label>Age when it starts
          <input type="number" id="whatIfIncomeGapAge" min="${state.plan.client.currentAge}" max="${state.plan.endAge - 1}" value="${whatIfIncomeGapAge}" />
        </label>
        <label>Length (months)
          <input type="number" id="whatIfIncomeGapMonths" min="1" max="120" step="1" value="${whatIfIncomeGapMonths}" />
        </label>
        <label>Replacement income (%)
          <input type="number" id="whatIfIncomeGapReplacement" min="0" max="100" step="5" value="${whatIfIncomeGapReplacementPct}" />
        </label>
      </div>
      <div class="focus-section">
        <h3>Does the buffer hold?</h3>
        ${headlineHTML}
        ${unfundedCalloutHTML(deltas)}
      </div>
      <div class="focus-section">
        ${lensToggleHTML("whatIfIncomeGapLensToggle")}
      </div>
      ${whatIfIncomeGapLens === "cashflow" ? cashflowLensSectionHTML("whatIfIncomeGap") : `
        <div class="focus-section">
          <h3>Net assets over time</h3>
          <div id="whatIfIncomeGapChart"></div>
        </div>
      `}
    </div>
  `;
  if (couple) {
    renderEntitySelector(
      $("whatIfIncomeGapOwnerToggle"),
      [{ id: "client", label: clientName() }, { id: "partner", label: partnerName() }],
      whatIfIncomeGapOwner,
      (id) => { whatIfIncomeGapOwner = id; renderWhatIfIncomeGapView(); }
    );
  }
  wireLensToggle("whatIfIncomeGapLensToggle", whatIfIncomeGapLens, (id) => { whatIfIncomeGapLens = id; renderWhatIfIncomeGapView(); });
  if (whatIfIncomeGapLens === "cashflow") {
    renderCashflowLensSection("whatIfIncomeGap", [
      { label: "Base", out: base, color: "#222", dash: "dot" },
      { label: "During gap", out: shocked, color: "#dc5a28" },
    ], factor, minimumBalance);
    return;
  }
  renderBaseVsShockedChart("whatIfIncomeGapChart", base, shocked, factor, "During gap");
}

function exportWhatIfIncomeGapCSV() {
  const shock = { kind: "incomeGap", ownerId: whatIfIncomeGapOwner, atAge: whatIfIncomeGapAge, months: whatIfIncomeGapMonths, replacementPct: whatIfIncomeGapReplacementPct };
  const { base, shocked } = runShock(state, shock);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const ages = base.schedule.clientAges;
  const lines = [csvEsc(`Income interruption: ${whatIfIncomeGapOwner}, age ${whatIfIncomeGapAge}, ${whatIfIncomeGapMonths} months, ${whatIfIncomeGapReplacementPct}% replacement`)];
  lines.push("");
  lines.push(["Age", "Base net assets", "Shocked net assets", "Delta"].map(csvEsc).join(","));
  for (let y = 0; y < base.yearly.length; y++) {
    const b = base.yearly[y].netAssets * factor(y);
    const s = shocked.yearly[y].netAssets * factor(y);
    lines.push([ages[y], b.toFixed(2), s.toFixed(2), (s - b).toFixed(2)].join(","));
  }
  downloadCSV("whatif-income-gap", lines);
}

els.viewWhatIfIncomeGap.addEventListener("change", (e) => {
  if (e.target.id === "whatIfIncomeGapAge") {
    whatIfIncomeGapAge = clampInt(e.target.value, state.plan.client.currentAge, state.plan.endAge - 1);
    renderWhatIfIncomeGapView();
  } else if (e.target.id === "whatIfIncomeGapMonths") {
    whatIfIncomeGapMonths = Math.max(1, Number(e.target.value) || 1);
    renderWhatIfIncomeGapView();
  } else if (e.target.id === "whatIfIncomeGapReplacement") {
    whatIfIncomeGapReplacementPct = clampNumber(e.target.value, 0, 100);
    renderWhatIfIncomeGapView();
  }
});

let whatIfExpenseShockPct = 10;
let whatIfExpenseShockLens = "cashflow";

function renderWhatIfExpenseShockView() {
  if ((state.cashflows.expenses ?? []).length === 0) {
    els.viewWhatIfExpenseShock.innerHTML = focusEmptyStateHTML(
      "What if you just spend a bit more (or less) than the plan says — every expense row scaled by one percentage, for the whole projection. Add an expense row to see it.",
      "expenses"
    );
    return;
  }
  const { base, shocked, deltas } = runShock(state, { kind: "expenseShock", pct: whatIfExpenseShockPct });
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lastY = deltas.byYear.length - 1;
  const minimumBalance = state.plan.workingCash?.minimumBalance ?? 0;
  const h = expenseShockHeadline({ base, shocked, deltas });
  const shockedLabel = `${whatIfExpenseShockPct > 0 ? "+" : ""}${whatIfExpenseShockPct}% expenses`;

  const headlineHTML = `
    ${h.firstNegativeSurplusYear != null
      ? `<p class="helper-warning">Surplus first turns negative at age ${base.schedule.clientAges[h.firstNegativeSurplusYear]} under this shock.</p>`
      : `<p class="helper-text">Surplus never turns negative under this shock.</p>`}
    <p class="helper-text">Total additional spending over the projection: <b>${fmtMoney(h.totalAdditionalSpending * factor(lastY))}</b>.</p>
    <p class="helper-text">Permanent cost at the end of the projection: <b>${fmtMoney(h.permanentCost * factor(lastY))}</b>.</p>
  `;

  els.viewWhatIfExpenseShock.innerHTML = `
    <h2 class="section-heading">Expense shock</h2>
    <p class="helper-text">What if we just spend a bit more (or less) than we say we will — every expense row scaled by one percentage, for the whole projection.</p>
    <div class="focus-panel">
      <div class="focus-section">
        <label>All expenses run at
          <input type="number" id="whatIfExpenseShockPct" min="-90" max="200" step="5" value="${whatIfExpenseShockPct}" />%
        </label>
      </div>
      <div class="focus-section">
        <h3>Affordability</h3>
        ${headlineHTML}
        ${unfundedCalloutHTML(deltas)}
      </div>
      <div class="focus-section">
        ${lensToggleHTML("whatIfExpenseShockLensToggle")}
      </div>
      ${whatIfExpenseShockLens === "cashflow" ? cashflowLensSectionHTML("whatIfExpenseShock") : `
        <div class="focus-section">
          <h3>Net assets over time</h3>
          <div id="whatIfExpenseShockChart"></div>
        </div>
      `}
    </div>
  `;
  wireLensToggle("whatIfExpenseShockLensToggle", whatIfExpenseShockLens, (id) => { whatIfExpenseShockLens = id; renderWhatIfExpenseShockView(); });
  if (whatIfExpenseShockLens === "cashflow") {
    renderCashflowLensSection("whatIfExpenseShock", [
      { label: "Base", out: base, color: "#222", dash: "dot" },
      { label: shockedLabel, out: shocked, color: "#dc5a28" },
    ], factor, minimumBalance);
    return;
  }
  renderBaseVsShockedChart("whatIfExpenseShockChart", base, shocked, factor, shockedLabel);
}

function exportWhatIfExpenseShockCSV() {
  const { base, shocked } = runShock(state, { kind: "expenseShock", pct: whatIfExpenseShockPct });
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const ages = base.schedule.clientAges;
  const lines = [csvEsc(`Expense shock: ${whatIfExpenseShockPct}%`)];
  lines.push("");
  lines.push(["Age", "Base net assets", "Shocked net assets", "Delta"].map(csvEsc).join(","));
  for (let y = 0; y < base.yearly.length; y++) {
    const b = base.yearly[y].netAssets * factor(y);
    const s = shocked.yearly[y].netAssets * factor(y);
    lines.push([ages[y], b.toFixed(2), s.toFixed(2), (s - b).toFixed(2)].join(","));
  }
  downloadCSV("whatif-expense-shock", lines);
}

els.viewWhatIfExpenseShock.addEventListener("change", (e) => {
  if (e.target.id !== "whatIfExpenseShockPct") return;
  whatIfExpenseShockPct = Number(e.target.value) || 0;
  renderWhatIfExpenseShockView();
});

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

// Shared by every Focus view's own CSV export (docs/specs/12-focus-views.md's
// "each view with its own export") — a flat dump of the view's own
// figures, distinct from exportTransposedCSV's year-columns-as-grid
// shape (built for the multi-year ledger tables; a Focus view's data
// mixes one-off scalars with its own short year series, so a simple
// row-per-fact CSV fits better than forcing it through that machinery).
function csvEsc(s) { return `"${String(s).replaceAll('"', '""')}"`; }
function downloadCSV(viewName, lines) {
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${exportNameBase()}-${viewName}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
  else if (activeView === "money-decomposition") exportMoneyDecompositionCSV();
  else if (activeView === "key-figures") exportTransposedCSV("key-figures", buildKeyFiguresGroups());
  else if (activeView === "cashflow") exportTransposedCSV("cashflow", buildCashflowGroups());
  else if (activeView === "assets") exportTransposedCSV("assets", buildAssetsGroups(assetsEntity));
  else if (activeView === "tax") exportTransposedCSV("tax", buildTaxGroups());
  else if (activeView === "super") exportTransposedCSV("super", buildSuperGroups(superEntity));
  else if (activeView === "liabilities") exportTransposedCSV("liabilities", buildLiabilitiesGroups(liabilitiesEntity));
  else if (activeView === "snapshot") exportSnapshotCSV();
  else if (activeView === "monte-carlo-table") exportMonteCarloCSV();
  else if (activeView === "assumptions") exportTransposedCSV("assumptions", buildAssumptionsGroups());
  else if (activeView === "focus-deposit") exportFocusDepositCSV();
  else if (activeView === "focus-fhsss") exportFocusFhsssCSV();
  else if (activeView === "focus-salary-sacrifice") exportFocusSalarySacrificeCSV();
  else if (activeView === "focus-debt-payoff") exportFocusDebtPayoffCSV();
  else if (activeView === "focus-lookups") exportFocusLookupsCSV();
  else if (activeView === "focus-equity") exportFocusEquityCSV();
  else if (activeView === "focus-transfer-schedule") exportFocusTransferScheduleCSV();
  else if (activeView === "whatif-rate-shock") exportWhatIfRateShockCSV();
  else if (activeView === "whatif-crash") exportWhatIfCrashCSV();
  else if (activeView === "whatif-income-gap") exportWhatIfIncomeGapCSV();
  else if (activeView === "whatif-expense-shock") exportWhatIfExpenseShockCSV();
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

const fhsssEarningsRateInput = $("fhsssEarningsRateInput");
fhsssEarningsRateInput.addEventListener("change", () => {
  const n = Number(fhsssEarningsRateInput.value);
  if (!Number.isFinite(n) || n < 0 || n > 30) {
    fhsssEarningsRateInput.value = ((state.assumptions.fhsssEarningsRate ?? 0.0794) * 100).toFixed(2);
    return;
  }
  state.assumptions.fhsssEarningsRate = n / 100;
  saveState();
  refreshOutputs();
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
  renderTaxDetails();
  renderChildren();
  renderAssets();
  renderCashflows();
  renderSettings();
  refreshOutputs();
  renderLiabilities(); // after refreshOutputs — payoff FYs read the projection
  renderProperties();
  renderSuper(); // after refreshOutputs — the cap-headroom display reads the projection
  renderGoals(); // after refreshOutputs — goalStats read the projection
  renderImplementation(); // after refreshOutputs — the fee cap/shortfall display reads the projection
  // decorateTouchedFields() itself is driven by the canvas-wide
  // MutationObserver below, not called directly here — most sections
  // re-render themselves narrowly (e.g. renderLiabilities(), not a
  // full renderAll()) after their own edits, and a direct call here
  // would miss every one of those.
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
