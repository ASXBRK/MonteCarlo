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
  clampWorkingCash, uid, clampHeas,
  DEATH_BENEFIT_RELATIONSHIPS, isDeathBenefitTaxDependant, createDeathBenefitBeneficiary,
  createAllocation,
  INCOME_CATEGORIES, INCOME_CATEGORY_LABELS, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS,
  incomeCategoryTaxTreatment,
  createChild, createEducationBlock, childCurrentAgeInfo, flatEducationBlocks,
  SCHEMA_VERSION,
  ADJUSTMENT_TARGETS, ADJUSTMENT_TARGET_LABELS, createAdjustment,
  TERMINATION_TYPES, INDEX_BASES,
  createSurplusPeriod, normaliseSurplusPeriods, ALLOCATION_TARGET_TYPES,
  DEBT_ORDER_MODES, REMAINDER_TARGETS, DEFICIT_SELL_RULES,
  PENSION_TYPES, PENSION_DRAWDOWN_OPTIONS, COMMUTATION_DESTINATIONS,
  createPension, createCommutation,
  createDefinedBenefit,
  createSuperRollover,
  createBond, BOND_TYPES, createBondContribution,
  createGift,
} from "./planState.js";
import { resolveRef, listAnchors } from "./keyDates.js";
import { resolveGiftDeprivation, GIFT_ANNUAL_LIMIT, GIFT_FIVE_YEAR_LIMIT } from "./gifting.js";
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
import { describeDefault } from "./smartDefaults.js";
import {
  surplusDestinationBreakdown, buildSurplusAllocationFocus,
  projectSingleDestinationAlternative, nonDeductibleFirstBenefit,
} from "./focusSurplusAllocation.js";
import {
  eligibleMainResidenceProperties, buildMainResidenceTimeline, buildCgtIfSoldSeries,
} from "./focusMainResidenceExemption.js";
import { buildSnapshotColumns, buildSnapshotTable, snapshotToHTML, snapshotToCSV } from "./snapshot.js";
import {
  eligibleDepositProperties, buildDepositFocus, solveDepositContribution, solveWhenCouldIBuy,
} from "./focusDeposit.js";
import { eligibleFhsssPersons, buildFhsssFocus, buildFhsssComparison } from "./focusFhsss.js";
import { FHSSS_ANNUAL_CAP, FHSSS_LIFETIME_CAP } from "./fhsss.js";
import { eligibleSalarySacrificeRows, buildSalarySacrificeFocus } from "./focusSalarySacrifice.js";
import { buildAgePensionStrategyFocus } from "./focusAgePensionStrategy.js";
import { alternativeNominations, buildRecontributionFocus } from "./focusDeathBenefits.js";
import { eligibleDebtPayoffLoans, buildDebtPayoffFocus, solveExtraRepaymentForPayoffDate } from "./focusDebtPayoff.js";
import { eligibleDebtRecyclingLoans, buildDebtRecyclingFocus } from "./focusDebtRecycling.js";
import { eligibleEducationFundingChildren, buildEducationFundingFocus } from "./focusEducationFunding.js";
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
import { SUPER_RATES_BASE } from "./data/superRates.js";
import { agePensionRatesFor, assetsTestCutOut } from "./data/agePension.js";
import { LEG } from "./Tax/engine.js";
import { expenseFundingSeries, taxByTypeSeries, debtVsAssetsSeries, debtAssetsCrossoverYear, superVsNonSuperSeries } from "./chartSeries.js";
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
  pensionSection: $("pensionSection"),
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
  outputFormToggle: $("outputFormToggle"),
  chartTypeSelect: $("chartTypeSelect"),
  exportBtn: $("exportBtn"),
  viewProjection: $("viewProjection"),
  viewCashflow: $("viewCashflow"),
  cashflowEntity: $("cashflowEntity"),
  cashflowTable: $("cashflowTable"),
  viewAssets: $("viewAssets"),
  viewTax: $("viewTax"),
  taxEntity: $("taxEntity"),
  taxTable: $("taxTable"),
  viewSuper: $("viewSuper"),
  viewPension: $("viewPension"),
  viewLiabilities: $("viewLiabilities"),
  viewAssumptions: $("viewAssumptions"),
  assetsEntity: $("assetsEntity"),
  assetsTable: $("assetsTable"),
  superEntity: $("superEntity"),
  superTable: $("superTable"),
  pensionEntity: $("pensionEntity"),
  pensionTable: $("pensionTable"),
  agePensionEntity: $("agePensionEntity"),
  agePensionTable: $("agePensionTable"),
  viewDeathBenefits: $("viewDeathBenefits"),
  deathBenefitsTable: $("deathBenefitsTable"),
  viewFocusDeathBenefits: $("viewFocusDeathBenefits"),
  liabilitiesEntity: $("liabilitiesEntity"),
  liabilitiesTable: $("liabilitiesTable"),
  viewBonds: $("viewBonds"),
  bondsEntity: $("bondsEntity"),
  bondsTable: $("bondsTable"),
  viewSnapshot: $("viewSnapshot"),
  snapshotYearPicker: $("snapshotYearPicker"),
  snapshotPersonSelector: $("snapshotPersonSelector"),
  snapshotTable: $("snapshotTable"),
  viewSuperBalances: $("viewSuperBalances"),
  viewLiabilitiesBalances: $("viewLiabilitiesBalances"),
  viewCashflowBars: $("viewCashflowBars"),
  viewMoneyDecomposition: $("viewMoneyDecomposition"),
  viewIncomeSources: $("viewIncomeSources"),
  viewExpenseFunding: $("viewExpenseFunding"),
  viewTaxByType: $("viewTaxByType"),
  viewDebtVsAssets: $("viewDebtVsAssets"),
  viewSuperVsNonSuper: $("viewSuperVsNonSuper"),
  viewAgePensionChart: $("viewAgePensionChart"),
  viewAgePensionTable: $("viewAgePensionTable"),
  viewKeyFigures: $("viewKeyFigures"),
  keyFiguresPersonSelector: $("keyFiguresPersonSelector"),
  keyFiguresTable: $("keyFiguresTable"),
  keyFiguresNote: $("keyFiguresNote"),
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
  netAssetsPersonSelector: $("netAssetsPersonSelector"),
  netAssetsNote: $("netAssetsNote"),
  viewAssetBalances: $("viewAssetBalances"),
  viewAssetAllocation: $("viewAssetAllocation"),
  allocationPersonSelector: $("allocationPersonSelector"),
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
  adjustmentsBtn: $("adjustmentsBtn"),
  adjustmentsCountBadge: $("adjustmentsCountBadge"),
  adjustmentsModal: $("adjustmentsModal"),
  adjustmentsList: $("adjustmentsList"),
  adjustmentsAddBtn: $("adjustmentsAddBtn"),
  adjustmentForm: $("adjustmentForm"),
  adjId: $("adjId"),
  adjTarget: $("adjTarget"),
  adjOwnerLabel: $("adjOwnerLabel"),
  adjOwner: $("adjOwner"),
  adjSuperAccountLabel: $("adjSuperAccountLabel"),
  adjSuperAccount: $("adjSuperAccount"),
  adjAmount: $("adjAmount"),
  adjFromAge: $("adjFromAge"),
  adjToAge: $("adjToAge"),
  adjIndexBasis: $("adjIndexBasis"),
  adjIndexExtraPct: $("adjIndexExtraPct"),
  adjNote: $("adjNote"),
  adjCancelBtn: $("adjCancelBtn"),
  adjDeleteBtn: $("adjDeleteBtn"),
  terminationModal: $("terminationModal"),
  terminationForm: $("terminationForm"),
  termRowId: $("termRowId"),
  termEnabled: $("termEnabled"),
  terminationFields: $("terminationFields"),
  termType: $("termType"),
  termAt: $("termAt"),
  termYears: $("termYears"),
  termEtp: $("termEtp"),
  termLeave: $("termLeave"),
  termCancelBtn: $("termCancelBtn"),
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
  viewFocusDebtRecycling: $("viewFocusDebtRecycling"),
  viewFocusEducationFunding: $("viewFocusEducationFunding"),
  viewFocusSurplusAllocation: $("viewFocusSurplusAllocation"),
  viewFocusPprExemption: $("viewFocusPprExemption"),
  viewFocusAgePension: $("viewFocusAgePension"),
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
  expandNavGroupForRoute(route.area, route.section);
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
  { id: "pension", label: "Pension" },
  { id: "liabilities", label: "Liabilities" },
  { id: "goals", label: "Goals" },
  { id: "investment-cashflows", label: "Investment cashflows" },
  { id: "settings", label: "Settings" },
];

// Navigation, View Consolidation, and Simple Charts (spec 17), Commit 2
// — nested collapsible sidebar groups. Every id below must appear in
// INPUT_NAV/OUTPUT_NAV exactly once; grouping is purely a presentation
// re-ordering, not a new section.
const INPUT_GROUPS = [
  { id: "client", label: "Client", ids: ["setup", "tax-details", "children"] },
  { id: "money-in", label: "Money in", ids: ["income", "deductions"] },
  { id: "money-out", label: "Money out", ids: ["expenses", "goals"] },
  { id: "assets", label: "Assets", ids: ["financial-assets", "lifestyle-assets", "property", "super", "pension"] },
  { id: "debt", label: "Debt", ids: ["liabilities"] },
  { id: "plan", label: "Plan", ids: ["implementation", "investment-cashflows", "settings"] },
];
// Navigation, View Consolidation, and Simple Charts (docs/specs/17-
// navigation-and-charts.md), Commit 1 — one subject per row, each
// carrying whichever of chart/table it supports (mirrors router.js's
// OUTPUT_SUBJECT_FORMS exactly; kept as a separate literal here since
// main.js also needs the label). "composite" and "money-decomposition"
// fold into Projection's and Net worth's own chart selector (Commit 4)
// rather than staying separate subjects.
const OUTPUT_NAV = {
  Output: [
    { id: "projection", label: "Projection" },
    { id: "cashflow", label: "Cashflow" },
    { id: "assets", label: "Assets" },
    { id: "liabilities", label: "Liabilities" },
    { id: "bonds", label: "Bonds" },
    { id: "super", label: "Super" },
    { id: "pension", label: "Pension" },
    { id: "age-pension", label: "Age pension" },
    { id: "death-benefits", label: "Death benefits" },
    { id: "tax", label: "Tax" },
    { id: "net-worth", label: "Net worth" },
    { id: "allocation", label: "Allocation" },
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
    { id: "focus-debt-recycling", label: "Debt recycling" },
    { id: "focus-education-funding", label: "Education funding" },
    { id: "focus-surplus-allocation", label: "Surplus allocation" },
    { id: "focus-ppr-exemption", label: "Main residence exemption" },
    { id: "focus-age-pension", label: "Age pension" },
    { id: "focus-death-benefits", label: "Death benefits" },
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
// Commit 2's output-side groups — the three OUTPUT_NAV groups
// themselves become the collapsible units (no further nesting asked
// for), so this is just OUTPUT_NAV reshaped into the same {id, label,
// ids} shape INPUT_GROUPS uses.
const OUTPUT_GROUPS = [
  { id: "output", label: "Output", ids: OUTPUT_NAV.Output.map((n) => n.id) },
  { id: "focus", label: "Focus", ids: OUTPUT_NAV.Focus.map((n) => n.id) },
  { id: "whatif", label: "What if", ids: OUTPUT_NAV.WhatIf.map((n) => n.id) },
];
const SECTION_LABELS = Object.fromEntries([
  ...INPUT_NAV.map((n) => [n.id, n.label]),
  ...Object.values(OUTPUT_NAV).flat().map((n) => [n.id, n.label]),
]);

// Subject + form → the pre-spec-17 view id every render/export/mount
// dispatcher below still keys on. Kept as a thin compatibility layer
// deliberately: VIEW_MOUNTS, GRAPH_VIEWS, renderActiveView, and the
// export dispatcher are all untouched by this consolidation — only the
// SIDEBAR and ROUTE now address a subject rather than one of these
// directly.
const SUBJECT_FORM_VIEW = {
  projection: { chart: "projection" },
  cashflow: { chart: "cashflow-bars", table: "cashflow" },
  assets: { chart: "asset-balances", table: "assets" },
  liabilities: { chart: "liabilities-balances", table: "liabilities" },
  super: { chart: "super-balances", table: "super" },
  "age-pension": { chart: "age-pension-chart", table: "age-pension-table" },
  tax: { table: "tax" },
  "net-worth": { chart: "net-assets", table: "key-figures" },
  allocation: { chart: "asset-allocation" },
  snapshot: { table: "snapshot" },
  assumptions: { table: "assumptions" },
};

// Navigation, View Consolidation, and Simple Charts (spec 17), Commit 4
// — a subject whose CHART form actually offers more than one chart
// picks among these via the header's chart-type dropdown, rather than
// SUBJECT_FORM_VIEW's single fixed id. Ids reuse the existing legacy
// view ids where the chart already existed (cashflow-bars, net-assets,
// composite, money-decomposition, super-balances) — the same
// compatibility-layer trick Commit 1 used, so none of those four
// existing render functions needed touching.
const CHART_OPTIONS = {
  cashflow: [
    { id: "cashflow-bars", label: "Cashflow bars" },
    { id: "income-sources", label: "Income sources" },
    { id: "expense-funding", label: "Expense funding" },
    { id: "tax-by-type", label: "Tax by type" },
    // "Where the surplus went" (spec) is deliberately NOT added yet:
    // surplus allocation's engine (spec 16, Commit 1) only tracks a
    // per-destination breakdown for asset/liability targets today
    // (row.perAssetDetail[id].surplusInvested, row.liabilities[id].
    // surplusRepayment) — super/goal allocations still land in the
    // SAME generic fields an ordinary contribution/goal uses, with no
    // "this came from surplus" tag. Building this chart now would mean
    // either a materially wrong chart or a new engine field, and this
    // spec is presentation-only. Add it once spec 16's own Commit 3
    // ("Outputs") gives every destination that tag.
  ],
  "net-worth": [
    { id: "net-assets", label: "Net assets" },
    { id: "composite", label: "Composite" },
    { id: "money-decomposition", label: "Where the money went" },
    { id: "debt-vs-assets", label: "Debt vs assets" },
  ],
  super: [
    { id: "super-balances", label: "Super balances" },
    { id: "super-vs-non-super", label: "Super vs non-super" },
  ],
};

function resolveChartSelection(subject) {
  const options = CHART_OPTIONS[subject];
  if (!options) return null;
  const stored = state.display.chartSelection?.[subject];
  return options.some((o) => o.id === stored) ? stored : options[0].id;
}
function setChartSelection(subject, chartId) {
  state.display.chartSelection = { ...state.display.chartSelection, [subject]: chartId };
  writeRaw(scenarioKey(workspace.activeScenarioId), serialize(state));
}
// Chart-type dropdown, in the view header (spec 17 Commit 4) — shown
// only while the active subject's CHART form is on screen AND that
// subject actually offers more than one chart (activeView is one of
// CHART_OPTIONS[subject]'s own ids — false whenever the TABLE form, or
// a single-chart subject, is showing instead).
function renderChartTypeSelect() {
  const options = CHART_OPTIONS[activeOutputSubject];
  const isChartForm = options && options.some((o) => o.id === activeView);
  els.chartTypeSelect.hidden = !isChartForm;
  if (!isChartForm) return;
  els.chartTypeSelect.innerHTML = options.map((o) =>
    `<option value="${o.id}"${o.id === activeView ? " selected" : ""}>${escapeHTML(o.label)}</option>`
  ).join("");
  els.chartTypeSelect.onchange = () => {
    const { client, scenario } = findActive(workspace);
    setChartSelection(activeOutputSubject, els.chartTypeSelect.value);
    navigate({
      page: "workspace", clientId: client.id, scenarioId: scenario.id,
      area: "output", section: activeOutputSubject, form: "chart",
    });
  };
}

// The active Output subject (as opposed to `activeView`, the underlying
// chart/table id) — set by showSection, read by the header's
// chart/table toggle and its click handler.
let activeOutputSubject = null;

function outputFormsFor(subject) {
  return SUBJECT_FORM_VIEW[subject] ? Object.keys(SUBJECT_FORM_VIEW[subject]) : [];
}

// Resolve which form a subject should show: an explicit route form
// wins (a shared link), then the scenario's own remembered choice, then
// the subject's first allowed form.
function resolveOutputForm(subject, routeForm) {
  const allowed = outputFormsFor(subject);
  if (routeForm && allowed.includes(routeForm)) return routeForm;
  const stored = state.display.outputForm?.[subject];
  if (stored && allowed.includes(stored)) return stored;
  return allowed[0];
}

// Chart/table toggle, in the view header (spec 17 Commit 1) — hidden
// for a single-form subject rather than shown disabled.
function renderOutputFormToggle() {
  const forms = outputFormsFor(activeOutputSubject);
  els.outputFormToggle.hidden = forms.length < 2;
  if (forms.length < 2) return;
  const active = resolveOutputForm(activeOutputSubject, currentRoute?.form);
  const labels = { chart: "Chart", table: "Table" };
  els.outputFormToggle.innerHTML = forms.map((f) => `
    <button class="seg-option${f === active ? " active" : ""}" type="button"
            role="tab" aria-selected="${f === active}" data-form="${f}">${labels[f]}</button>
  `).join("");
  els.outputFormToggle.onclick = (ev) => {
    const btn = ev.target.closest("[data-form]");
    if (!btn || btn.dataset.form === active) return;
    const { client, scenario } = findActive(workspace);
    navigate({
      page: "workspace", clientId: client.id, scenarioId: scenario.id,
      area: "output", section: activeOutputSubject, form: btn.dataset.form,
    });
  };
}

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

// Navigation, View Consolidation, and Simple Charts (spec 17), Commit 2
// — one group expanded at a time PER AREA (input/output each keep
// their own single expanded subgroup), persisted per scenario in
// state.display.navExpanded like every other display-state field. A
// stale/unrecognised stored id (e.g. after a future regrouping) falls
// back to the group containing that area's default landing section,
// rather than a clamp failure — planState.js deliberately treats the
// value as free-form since group ids are a presentation concern owned
// here, not by the schema.
function groupsFor(area) {
  return area === "input" ? INPUT_GROUPS : OUTPUT_GROUPS;
}
function groupContaining(area, sectionId) {
  const groups = groupsFor(area);
  return groups.find((g) => g.ids.includes(sectionId))?.id ?? groups[0].id;
}
function defaultExpandedGroup(area) {
  return groupContaining(area, area === "input" ? DEFAULT_INPUT_SECTION : DEFAULT_OUTPUT_VIEW);
}
function expandedGroupId(area) {
  const stored = state.display.navExpanded?.[area];
  if (stored && groupsFor(area).some((g) => g.id === stored)) return stored;
  return defaultExpandedGroup(area);
}
// Persisted separately from saveState(), same reasoning as
// persistLastVisited: expanding a sidebar group to browse is not a plan
// edit and must not bump the scenario's "last updated" timestamp.
function setExpandedGroup(area, groupId) {
  state.display.navExpanded = { ...state.display.navExpanded, [area]: groupId };
  writeRaw(scenarioKey(workspace.activeScenarioId), serialize(state));
}
// The group containing the active view is always expanded (spec) —
// called from handleRoute on every navigation, so arriving at a section
// via a deep link or the export/toggle controls reopens its group even
// if the user had a different one open.
function expandNavGroupForRoute(area, section) {
  if (area !== "input" && area !== "output") return;
  setExpandedGroup(area, groupContaining(area, section));
}

function renderSideNav() {
  const counts = sectionCounts(state);
  const labelFor = (area, id) => (area === "input" ? INPUT_NAV : Object.values(OUTPUT_NAV).flat()).find((n) => n.id === id)?.label ?? id;
  const item = (area, id) => {
    const active = currentRoute?.area === area && currentRoute?.section === id;
    const unreviewed = area === "input" && sectionHasUntouched(id)
      ? `<span class="nav-badge-unreviewed" title="Contains fields not yet reviewed">●</span>` : "";
    const badge = counts[id] ? `<span class="nav-badge">${counts[id]}</span>` : "";
    return `
      <button class="nav-item nav-item-sub${active ? " active" : ""}" type="button"
              data-nav-area="${area}" data-nav-section="${id}">
        <span>${escapeHTML(labelFor(area, id))}</span>${unreviewed}${badge}
      </button>
    `;
  };
  const group = (area, g) => {
    const expanded = expandedGroupId(area) === g.id;
    // Aggregate count/untouched badge (spec: "a collapsed group still
    // signals what is inside") — only input sections carry either
    // concept today; an output group's header shows just its label.
    const groupCount = area === "input" ? g.ids.reduce((s, id) => s + (counts[id] ?? 0), 0) : 0;
    const groupUnreviewed = area === "input" && g.ids.some((id) => sectionHasUntouched(id));
    return `
      <button type="button" class="nav-group-header" data-nav-group-area="${area}" data-nav-group="${g.id}" aria-expanded="${expanded}">
        <span class="nav-group-chevron">${expanded ? "▾" : "▸"}</span>
        <span class="nav-group-title">${escapeHTML(g.label)}</span>
        ${groupUnreviewed ? `<span class="nav-badge-unreviewed" title="Contains fields not yet reviewed">●</span>` : ""}
        ${groupCount ? `<span class="nav-badge">${groupCount}</span>` : ""}
      </button>
      <div class="nav-subgroup-items"${expanded ? "" : " hidden"}>
        ${g.ids.map((id) => item(area, id)).join("")}
      </div>
    `;
  };
  els.sideNav.innerHTML = `
    <button type="button" id="reviewDefaultsBtn" class="btn-text side-nav-review-btn">Review defaults</button>
    <div class="nav-group-label">Input</div>
    ${INPUT_GROUPS.map((g) => group("input", g)).join("")}
    <div class="nav-group-label">Output</div>
    ${OUTPUT_GROUPS.map((g) => group("output", g)).join("")}
  `;
}

els.sideNav.addEventListener("click", (e) => {
  const groupBtn = e.target.closest("[data-nav-group]");
  if (groupBtn) {
    setExpandedGroup(groupBtn.dataset.navGroupArea, groupBtn.dataset.navGroup);
    renderSideNav();
    return;
  }
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
    const subject = OUTPUT_VIEWS.includes(section) ? section : DEFAULT_OUTPUT_VIEW;
    activeOutputSubject = subject;
    const forms = SUBJECT_FORM_VIEW[subject];
    if (forms) {
      // A dual/single-form subject (spec 17 Commit 1) — resolve which
      // form to show and remember it for next time, then map to the
      // legacy view id every render/export/mount dispatcher still uses.
      const form = resolveOutputForm(subject, currentRoute?.form);
      state.display.outputForm = { ...state.display.outputForm, [subject]: form };
      // Commit 4 — a subject with more than one chart resolves which
      // one via CHART_OPTIONS/chartSelection rather than
      // SUBJECT_FORM_VIEW's single fixed id.
      activeView = form === "chart" && CHART_OPTIONS[subject] ? resolveChartSelection(subject) : forms[form];
    } else {
      // Focus/What-if ids have no chart/table concept — pass through.
      activeView = subject;
    }
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
                    els.cashflowEntity, els.cashflowTable, els.assetsEntity, els.assetsTable,
                    els.taxEntity, els.taxTable, els.viewAssumptions, els.snapshotYearPicker, els.snapshotTable]) {
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
      const srcBlob = readRaw(scenarioKey(sid)) ?? serialize(defaultState(PROFILES));
      writeRaw(scenarioKey(r.scenarioId), untouchAdjustmentsInBlob(srcBlob));
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

// Adjustment rows (spec 18 Commit 3) — "adjustments survive scenario
// duplication and are listed as untouched in the review panel when
// copied, since an override that made sense in one scenario may not in
// another" (spec's own words). Duplication otherwise copies the raw
// serialized blob byte-for-byte, including meta.touched — this strips
// just the adjustments.* touched paths from the COPY, so every
// adjustment the source scenario had already reviewed reappears
// unreviewed in the new one, without disturbing any other touched path.
function untouchAdjustmentsInBlob(blob) {
  try {
    const parsed = JSON.parse(blob);
    if (Array.isArray(parsed?.meta?.touched)) {
      parsed.meta.touched = parsed.meta.touched.filter((p) => !p.startsWith("adjustments."));
    }
    return JSON.stringify(parsed);
  } catch {
    return blob;
  }
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
// Input behaviour fix — every [data-section] field container this
// decoration pass recognises. Cashflow-style tables (income, expenses,
// deductions, super contributions/withdrawals, liability extra/one-off
// repayments — every "Cashflow sections: table layout" surface) render
// one field per <td>, never inside a .cf-cell/.plan-field wrapper —
// before this fix, `target`/`container` below fell through to the bare
// <input>/<select> itself, which the CSS never targets, so NEITHER the
// dot NOR the muted styling ever appeared there at all (a real,
// confirmed gap: verified in a browser that every table-row section had
// zero decoration regardless of touched state, not merely a stale
// dot). A <td> already behaves exactly like a .cf-cell for this
// purpose — the date-ref pair (an anchor select + a hidden age number
// input) shares one dotted path and one <td> the same way Setup's
// month+year pair shares one .plan-field, so treating it as a
// container needs no special-casing.
const TOUCHED_FIELD_CONTAINER_SELECTOR = ".cf-cell, .plan-field, td";

function decorateTouchedFields() {
  for (const el of els.workspaceCanvas.querySelectorAll(TOUCHED_FIELD_SELECTOR)) {
    const path = computeFieldPath(el);
    if (!path) continue;
    const untouched = !isTouched(path);
    const container = el.closest(".cf-cell") || el.closest(".plan-field") || el.closest("td");
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
  for (const container of els.workspaceCanvas.querySelectorAll(TOUCHED_FIELD_CONTAINER_SELECTOR)) {
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
  // Adjustment rows (spec 18 Commit 3) — adjustments live in a modal,
  // not a rendered [data-section] input area, so they can't be
  // discovered by the generic DOM scan above; listed here explicitly
  // instead, same untouched/jump-to/mark-reviewed shape.
  const untouchedAdjustments = (state.plan.adjustments ?? []).filter((a) => !isTouched(`adjustments.${a.id}`));
  if (bySection.size === 0 && untouchedAdjustments.length === 0) {
    els.reviewDefaultsBody.innerHTML = `<p class="muted">Every field in this scenario has been reviewed.</p>`;
    return;
  }
  const sectionsHTML = [...bySection.entries()].map(([sectionId, fields]) => `
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
  const adjustmentsHTML = untouchedAdjustments.length === 0 ? "" : `
    <section class="review-section">
      <h3>Adjustments <span class="nav-badge">${untouchedAdjustments.length}</span></h3>
      <ul class="review-field-list">
        ${untouchedAdjustments.map((a) => `
          <li>
            <button type="button" class="btn-text review-jump" data-jump-adjustment="${a.id}">${escapeHTML(a.label)} — ${escapeHTML(adjustmentOwnerLabel(a))}</button>
            <span class="review-field-value">${fmtMoney(a.amount)}</span>
            <button type="button" class="btn-text review-mark" data-mark-path="adjustments.${a.id}">Mark reviewed</button>
          </li>
        `).join("")}
      </ul>
    </section>
  `;
  els.reviewDefaultsBody.innerHTML = sectionsHTML + adjustmentsHTML;
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
  const jumpAdjustment = e.target.closest("[data-jump-adjustment]");
  if (jumpAdjustment) {
    els.reviewDefaultsModal.close();
    openAdjustmentEditor({ id: jumpAdjustment.dataset.jumpAdjustment });
    return;
  }
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
        <div class="cf-cell">
          <label>Age pension eligible ${tooltipHTML("Assesses this person for the age pension once they reach age pension age. Turn off for someone who won't qualify — residency, or a client who simply doesn't want it modelled.")}
            ${tp.centrelinkEligibleIsDefault ? tooltipHTML(describeDefault("person.centrelinkEligible", { value: tp.centrelinkEligible })) : ""}
          </label>
          <label class="ptg-check">
            <input type="checkbox"${tp.centrelinkEligible !== false ? " checked" : ""} data-plan-field="${prefix}CentrelinkEligible" />
            <span>Yes</span>
          </label>
        </div>
      </div>
      ${deathBenefitBlockHTML(prefix, person)}
    </div>
  `;
}

// --- Death benefit nominations (spec 22 engine; spec 27 Commit 2 UI) --------
//
// Per-person, not a household list — each person nominates beneficiaries
// for their OWN super/pension death benefit (planState.js's own header
// on person.deathBenefit). Lives here (each person's Tax details block)
// because that's where the death-benefits OUTPUT table's own helper
// text already pointed ("Nominate beneficiaries per person via each
// person's Tax details section") — that text was aspirational until
// this commit built the editor it describes.
//
// deterministic.js applies sharePct/100 directly with no normalisation,
// so a total that doesn't sum to 100% either under- or over-counts the
// balance distributed — every edit here is clamped to the remaining
// headroom (100% minus every OTHER row's share), the same "incapable
// of exceeding 100%, prevented at input" convention the surplus
// allocation percentage field already uses (onSurplusPeriodChange).
function deathBenefitBeneficiaryRowHTML(prefix, b) {
  const isDependant = isDeathBenefitTaxDependant(b.relationship);
  return `
    <div class="db-beneficiary-row" data-dbprefix="${prefix}" data-bid="${b.id}">
      <input type="text" maxlength="40" value="${escapeHTML(b.label)}" aria-label="Beneficiary name"
             data-dbprefix="${prefix}" data-bid="${b.id}" data-bfield="label" />
      <select data-dbprefix="${prefix}" data-bid="${b.id}" data-bfield="relationship" aria-label="Relationship">
        ${DEATH_BENEFIT_RELATIONSHIPS.map((r) => `<option value="${r}"${b.relationship === r ? " selected" : ""}>${escapeHTML(DEATH_BENEFIT_RELATIONSHIP_LABELS[r])}</option>`).join("")}
      </select>
      <span class="db-share-input">
        <input type="number" min="0" max="100" step="1" value="${b.sharePct}" aria-label="Share %"
               data-dbprefix="${prefix}" data-bid="${b.id}" data-bfield="sharePct" />%
      </span>
      <span class="helper-inline">${isDependant ? "Tax dependant" : "Not a tax dependant"}</span>
      <button class="cf-remove" type="button" data-dbprefix="${prefix}" data-db-beneficiary-action="remove" data-bid="${b.id}" aria-label="Remove beneficiary">×</button>
    </div>
  `;
}

function deathBenefitBlockHTML(prefix, person) {
  const beneficiaries = person.deathBenefit?.beneficiaries ?? [];
  const total = beneficiaries.reduce((s, b) => s + b.sharePct, 0);
  return `
    <div class="cf-subsection">
      <div class="cf-section-title">Death benefit nominations ${tooltipHTML("Who this person's super/pension death benefit passes to, and each beneficiary's share. Tax dependency is derived from relationship, not chosen directly — an adult child, for instance, is NOT a tax dependant and pays tax on the taxable component even though a spouse or minor child would not.")}</div>
      ${beneficiaries.length ? `
        <div class="db-beneficiary-list">${beneficiaries.map((b) => deathBenefitBeneficiaryRowHTML(prefix, b)).join("")}</div>
        <p class="helper-text${total !== 100 ? " helper-warning" : ""}">Shares total ${total}%${total !== 100 ? " — the death benefits output only distributes what's nominated here, so an unallocated remainder simply isn't shown to anyone." : "."}</p>
      ` : `<p class="helper-text">No beneficiaries nominated — the death benefits output (Super → Death benefits) has nothing to show for ${escapeHTML(personDisplayName(person, prefix === "client" ? "the client" : "the partner"))} until at least one is added.</p>`}
      <button class="btn-text" type="button" data-dbprefix="${prefix}" data-db-beneficiary-action="add">+ Add beneficiary</button>
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
      centrelinkEligible: field === `${prefix}CentrelinkEligible` ? e.target.checked : cur.taxProfile.centrelinkEligible,
      // Explicitly setting the checkbox stops it tracking the smart
      // default (same one-way convention as every other *IsDefault flag).
      centrelinkEligibleIsDefault: field === `${prefix}CentrelinkEligible` ? false : cur.taxProfile.centrelinkEligibleIsDefault,
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

function personByPrefix(prefix) {
  return prefix === "partner" ? state.plan.partner : state.plan.client;
}

els.taxDetailsSection.addEventListener("change", (e) => {
  const prefix = e.target.dataset.dbprefix;
  const bid = e.target.dataset.bid;
  const bfield = e.target.dataset.bfield;
  if (!prefix || !bid || !bfield) return;
  const person = personByPrefix(prefix);
  const b = person?.deathBenefit?.beneficiaries.find((x) => x.id === bid);
  if (!b) return;
  const v = e.target.value;
  if (bfield === "label") b.label = v.trim() || b.label;
  else if (bfield === "relationship") b.relationship = DEATH_BENEFIT_RELATIONSHIPS.includes(v) ? v : "spouse";
  else if (bfield === "sharePct") {
    // Clamped to this row's own remaining headroom (100% minus every
    // OTHER beneficiary's share) — same convention as the surplus
    // allocation percentage field, so the total can never exceed 100%.
    const others = person.deathBenefit.beneficiaries.reduce((s, x) => (x.id === bid ? s : s + x.sharePct), 0);
    b.sharePct = clampNumber(v, 0, Math.max(0, 100 - others));
  } else {
    return;
  }
  saveState();
  refreshOutputs();
  renderTaxDetails();
});

els.taxDetailsSection.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-db-beneficiary-action]");
  if (!btn) return;
  const person = personByPrefix(btn.dataset.dbprefix);
  if (!person) return;
  const beneficiaries = person.deathBenefit?.beneficiaries ?? [];
  const action = btn.dataset.dbBeneficiaryAction;
  if (action === "add") {
    person.deathBenefit = { beneficiaries: [...beneficiaries, createDeathBenefitBeneficiary(beneficiaries)] };
  } else if (action === "remove") {
    const b = beneficiaries.find((x) => x.id === btn.dataset.bid);
    if (!b || !window.confirm(`Remove "${b.label}"?`)) return;
    person.deathBenefit = { beneficiaries: beneficiaries.filter((x) => x.id !== b.id) };
  } else {
    return;
  }
  saveState();
  refreshOutputs();
  renderTaxDetails();
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

// Input behaviour fix — the label cell shared by income/expense/
// deduction rows: a derived default (planState.js's clampDerivedLabel)
// that tracks the row's category until the user types their own, with
// the smart-defaults provenance tooltip while it's still tracking (the
// same "distinct while it's a default, ordinary once entered"
// treatment property.rent/expenses already get).
const LABEL_DEFAULT_KEY = { income: "income.label", expenses: "expense.label", deductions: "deduction.label" };
function labelTdHTML(kind, r) {
  const isDefault = r.labelIsDefault === true;
  return `
    <td class="cf-td-label">
      <input type="text" value="${escapeHTML(r.label)}" maxlength="60"
             data-kind="${kind}" data-cfid="${r.id}" data-field="label" />
      ${isDefault ? tooltipHTML(describeDefault(LABEL_DEFAULT_KEY[kind], { value: r.label })) : ""}
    </td>
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
          <button type="button" class="btn-text" data-action="edit-termination" data-cfid="${r.id}">${r.termination?.enabled ? "Termination ✓" : "Termination…"}</button>
        ` : ""}
      </td>
      ${labelTdHTML("income", r)}
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
      ${labelTdHTML("expenses", r)}
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
      ${labelTdHTML("deductions", r)}
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

// Bond contributions (spec 25, Commit 1 engine; spec 27 Commit 3 UI) —
// flat, bondId-referencing rows under cashflows.bondContributions, the
// SAME convention super's own contributions/withdrawals use (planState
// .js's own header) — so this fits the generic CF_MOUNTS row machinery
// (rowHTMLFor/applyRowEdit) with a bondId select in place of the
// ordinary assetId one, plus a Label column bond contributions carry
// that plain asset contributions don't.
function bondOptions(selected) {
  const bonds = state.bonds ?? [];
  if (bonds.length === 0) return `<option value="">No bond entered yet</option>`;
  return bonds.map((b) => `<option value="${b.id}"${b.id === selected ? " selected" : ""}>${escapeHTML(b.name)}</option>`).join("");
}

function bondContributionRowHTML(bc) {
  return `
    <tr class="cf-tr" data-cfid="${bc.id}">
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(bc.label)}" maxlength="60"
               data-kind="bondContributions" data-cfid="${bc.id}" data-field="label" />
      </td>
      <td class="cf-td-asset">
        <select data-kind="bondContributions" data-cfid="${bc.id}" data-field="bondId">${bondOptions(bc.bondId)}</select>
      </td>
      ${amountTdHTML("bondContributions", bc.id, bc.amount)}
      <td class="cf-td-freq">
        <select data-kind="bondContributions" data-cfid="${bc.id}" data-field="frequency">
          <option value="monthly"${bc.frequency === "monthly" ? " selected" : ""}>Monthly</option>
          <option value="annual"${bc.frequency === "annual" ? " selected" : ""}>Annual</option>
        </select>
      </td>
      <td class="cf-td-date">${dateRefControlHTML(bc.from, "client", `data-kind="bondContributions" data-cfid="${bc.id}" data-field="from"`, 18, 120)}</td>
      <td class="cf-td-date">${dateRefControlHTML(bc.to, "client", `data-kind="bondContributions" data-cfid="${bc.id}" data-field="to"`, 18, 120)}</td>
      ${indexationTdHTML("bondContributions", bc)}
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-action="remove-row" data-kind="bondContributions" data-cfid="${bc.id}">×</button>
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
  bondContributions: () => `<th>Label</th><th>Bond</th><th>Amount ($)</th><th>Freq</th><th>From</th><th>To</th><th>Indexation</th>`,
  // No Indexation column — dropped to a second line beneath each row
  // (Cashflow sections: table layout, point 6) — this section alone
  // has too many columns to fit it on the same line at 1280px.
  superContributions: () => `<th>Label</th><th>Type</th>${isCouple() ? "<th>Owner</th>" : ""}<th>Account</th><th>Basis</th><th>Amount / detail</th><th>Freq</th><th>From</th><th>To</th><th>FHSSS</th>`,
  superWithdrawals: () => `<th>Label</th>${isCouple() ? "<th>Owner</th>" : ""}<th>Account</th><th>Amount ($)</th><th>Freq</th><th>From</th><th>To</th><th>Indexation</th>`,
  // Super rollovers (spec 26, Commit 1; UI: spec 27 Commit 1) — a
  // same-person, account-to-account move; no Owner column of its own
  // (the FROM account already implies it — see superRolloverRowHTML's
  // own from-account-drives-owner behaviour).
  superRollovers: () => `<th>Label</th><th>From account</th><th>To account</th><th>Amount ($, blank = whole balance)</th><th>At</th><th>Est. rollover tax</th>`,
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

  const bonds = state.bonds ?? [];
  const allEmpty = cf.contributions.length === 0 && cf.withdrawals.length === 0 && cf.lumpSums.length === 0
    && bonds.length === 0 && (cf.bondContributions ?? []).length === 0;
  els.investSection.innerHTML = allEmpty
    ? `
      <h2 class="section-heading">Investment cashflows</h2>
      ${pageEmptyHTML(
        "Add contributions, withdrawals, or one-off amounts to model cashflows into and out of your assets, or a bond to model a tax-paid investment or education bond.",
        `${addRowBtn("contributions", "Add contribution")}${addRowBtn("withdrawals", "Add withdrawal")}${addRowBtn("lumpSums", "Add one-off amount")}<button class="add-row-btn" type="button" data-bond-action="add">+ Add bond</button>`
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
      ${bondsBlockHTML(bonds, cf)}
    `;
}

// --- Investment and education bonds (spec 25 engine; spec 27 Commit 3 UI) --
//
// Cards mirror the super-account card shape (a .pcard per bond,
// direct-mutate-then-saveState, same as els.superSection) — bonds have
// the same "named vehicle with a balance, an allocation, and its own
// contribution rows" shape super accounts do, not a single asset-
// targeted cashflow row. Lives inside "Investment cashflows"
// (els.investSection) since there is no dedicated bonds INPUT section
// (router.js's own INPUT_SECTIONS has none) — investment cashflows is
// where every other financial-vehicle contribution/withdrawal already
// lives.
function findBond(bdid) {
  return (state.bonds ?? []).find((b) => b.id === bdid) ?? null;
}

function bondHeadMeta(b) {
  const ownerLabel = b.owner === "partner" ? partnerName() : b.owner === "joint" ? "Joint" : clientName();
  const typeLabel = b.type === "education" ? "Education bond" : "Investment bond";
  return `${ownerLabel} · ${typeLabel} · ${fmtMoney(b.balance)}`;
}

// The ten-year date and the 125% contribution headroom are the two
// things the spec requires be visible AT ENTRY — both read straight off
// the engine's own already-computed bondDetail (year 0's snapshot, "as
// at" the projection's first FY) rather than re-derived here, the same
// "every figure already exists in projectPlan() output" principle
// spec 27 states for itself. Any contributionCapBreach warning for this
// bond (bondWarnings — computed by the engine, never surfaced by any UI
// until this commit) is shown directly beneath.
function bondLiveInfoHTML(b) {
  const detail = projection?.yearly?.[0]?.bondDetail?.[b.id];
  const warnings = (projection?.bondWarnings ?? []).filter((w) => w.bondId === b.id);
  const infoLine = detail
    ? `${detail.yearsToMaturity.toFixed(1)} years to the ten-year date · ${fmtMoney(detail.contributionHeadroom)} contribution headroom before next FY resets the clock (as at ${escapeHTML(projection.schedule.fyLabels[0])})`
    : "";
  return `
    ${infoLine ? `<p class="helper-text">${infoLine}</p>` : ""}
    ${warnings.map((w) => `<p class="helper-warning">${escapeHTML(w.reason)}</p>`).join("")}
  `;
}

function bondAllocationSectionHTML(b) {
  const alloc = b.allocation;
  const isCustom = alloc.mode === "custom";
  const seg = `
    <div class="seg-toggle" role="radiogroup" aria-label="Allocation mode">
      <button class="seg-option${!isCustom ? " active" : ""}" type="button"
              data-bond-action="alloc-mode" data-bdid="${b.id}" data-mode="profile"
              aria-pressed="${!isCustom}">Firm profile</button>
      <button class="seg-option${isCustom ? " active" : ""}" type="button"
              data-bond-action="alloc-mode" data-bdid="${b.id}" data-mode="custom"
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
            <select data-bdid="${b.id}" data-bdfield="alloc.profile">${profileOptions(alloc.profile)}</select>
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
                 data-bdid="${b.id}" data-bdfield="alloc.incomePct" />
        </div>
        <div class="cf-cell">
          <label>Growth (% p.a.)</label>
          <input type="number" min="0" max="${ALLOC_PCT_MAX}" step="0.05" value="${alloc.growthPct}"
                 data-bdid="${b.id}" data-bdfield="alloc.growthPct" />
        </div>
        <div class="cf-cell">
          <label>Franking (%)</label>
          <input type="number" min="0" max="100" step="1" value="${alloc.frankingPct}"
                 data-bdid="${b.id}" data-bdfield="alloc.frankingPct" />
        </div>
        <div class="cf-cell alloc-total">
          <label>&nbsp;</label>
          <div class="alloc-total-value" data-role="bondAllocTotal-${b.id}">Total: ${total}% p.a. nominal</div>
        </div>
      </div>
      <div class="alloc-grid alloc-grid-vol">
        <div class="cf-cell">
          <label>Volatility basis</label>
          <select data-bdid="${b.id}" data-bdfield="alloc.volBasis">${profileOptions(alloc.volBasis)}</select>
        </div>
      </div>
    </div>
  `;
}

function bondCardHTML(b) {
  const isCollapsed = collapsed.get(b.id) === true;
  const excluded = !b.include;
  const head = `
    <div class="pcard-head" data-bond-action="toggle-collapse" data-bdid="${b.id}">
      <button class="pcard-chevron${isCollapsed ? "" : " open"}" type="button"
              aria-label="${isCollapsed ? "Expand" : "Collapse"}"
              data-bond-action="toggle-collapse" data-bdid="${b.id}">▸</button>
      <span class="pcard-name" data-role="bondHeadName">${escapeHTML(b.name)}</span>
      <span class="pcard-meta" data-role="bondHeadMeta">${bondHeadMeta(b)}</span>
      <label class="pcard-include" title="Include in projection totals">
        <input type="checkbox"${b.include ? " checked" : ""}
               data-bond-action="toggle-include" data-bdid="${b.id}" />
        <span>Include</span>
      </label>
      <button class="pcard-remove" type="button" data-bond-action="remove" data-bdid="${b.id}">Remove</button>
    </div>
  `;
  if (isCollapsed) {
    return `<div class="pcard${excluded ? " excluded" : ""}" data-bdid="${b.id}">${head}</div>`;
  }
  const children = state.plan.children ?? [];
  return `<div class="pcard${excluded ? " excluded" : ""}" data-bdid="${b.id}">${head}
    <div class="pcard-body">
      <div class="pcard-details${isCouple() ? " with-owner" : ""}">
        <div class="cf-cell pcard-name-cell">
          <label>Name</label>
          <input type="text" value="${escapeHTML(b.name)}" maxlength="60" data-bdid="${b.id}" data-bdfield="name" />
        </div>
        <div class="cf-cell">
          <label>Type</label>
          <select data-bdid="${b.id}" data-bdfield="type">
            ${BOND_TYPES.map((t) => `<option value="${t}"${b.type === t ? " selected" : ""}>${t === "education" ? "Education bond" : "Investment bond"}</option>`).join("")}
          </select>
        </div>
        ${isCouple() ? `
          <div class="cf-cell">
            <label>Owner</label>
            <select data-bdid="${b.id}" data-bdfield="owner">
              <option value="client"${b.owner === "client" ? " selected" : ""}>${escapeHTML(clientName())}</option>
              <option value="partner"${b.owner === "partner" ? " selected" : ""}>${escapeHTML(partnerName())}</option>
              <option value="joint"${b.owner === "joint" ? " selected" : ""}>Joint</option>
            </select>
          </div>
        ` : ""}
        <div class="cf-cell">
          <label>Balance ($)</label>
          <input type="number" min="0" step="1000" value="${b.balance}" data-bdid="${b.id}" data-bdfield="balance" />
        </div>
        <div class="cf-cell">
          <label>Start date ${tooltipHTML("When the ten-year rule's clock started — this can be well before the projection's own start date for a bond you already hold.")}</label>
          <input type="date" value="${b.startDate}" data-bdid="${b.id}" data-bdfield="startDate" />
        </div>
        <div class="cf-cell">
          <label>ICR (% p.a.)</label>
          <input type="number" min="0" max="100" step="0.01" value="${b.icrPct}" data-bdid="${b.id}" data-bdfield="icrPct" />
        </div>
        ${b.type === "education" ? `
          <div class="cf-cell">
            <label>Beneficiary child ${tooltipHTML("Links this bond to one child's own Education funding rows (Children section) — withdrawals used for that child's education fees get the education-benefit treatment.")}</label>
            <select data-bdid="${b.id}" data-bdfield="beneficiaryChildId">
              <option value="">No child linked yet</option>
              ${children.map((c) => `<option value="${c.id}"${b.beneficiaryChildId === c.id ? " selected" : ""}>${escapeHTML(c.name)}</option>`).join("")}
            </select>
            ${children.length === 0 ? `<p class="helper-text">Add a child (Children section) to link this bond to their education funding.</p>` : ""}
          </div>
        ` : ""}
      </div>

      ${bondAllocationSectionHTML(b)}
      ${bondLiveInfoHTML(b)}
    </div>
  </div>`;
}

function bondsBlockHTML(bonds, cf) {
  const cards = bonds.map(bondCardHTML).join("");
  return `
    <div class="ff-section">
      <div class="ff-head"><h2 class="section-heading">Bonds</h2></div>
      ${bonds.length === 0 ? "" : `<div class="portfolio-stack">${cards}</div>`}
      <div class="portfolio-actions">
        <button class="btn-text" type="button" data-bond-action="add">+ Add bond</button>
      </div>
      ${bonds.length > 0 ? `
        <div class="cf-panel">
          ${ffSubsectionHTML("Contributions", "bondContributions", "Add contribution", cfHeaders.bondContributions(),
            (cf.bondContributions ?? []).map(bondContributionRowHTML).join(""))}
        </div>
      ` : ""}
    </div>
  `;
}

// Applies a simple (non-structural) field edit to a bond. Returns true
// when the change is structural (needs a full re-render — owner/type
// switch changes select options elsewhere, education linkage appearing/
// disappearing, etc.) — same true/false contract as
// applySuperAccountEdit.
function applyBondEdit(b, field, el, commit) {
  switch (field) {
    case "name":
      b.name = commit ? (el.value.trim() || b.name) : el.value;
      if (commit) el.value = b.name;
      return false;
    case "type":
      if (BOND_TYPES.includes(el.value)) {
        b.type = el.value;
        if (b.type !== "education") b.beneficiaryChildId = null;
      }
      return true;
    case "owner":
      if (["client", "partner", "joint"].includes(el.value) && (el.value === "client" || state.plan.partner)) b.owner = el.value;
      return false;
    case "balance":
      b.balance = clampNumber(el.value, 0);
      if (commit) el.value = b.balance;
      return false;
    case "startDate":
      if (el.value) b.startDate = el.value;
      return false;
    case "icrPct":
      b.icrPct = clampNumber(el.value, 0, 100);
      if (commit) el.value = b.icrPct;
      return false;
    case "beneficiaryChildId":
      b.beneficiaryChildId = (state.plan.children ?? []).some((c) => c.id === el.value) ? el.value : null;
      return false;
    case "alloc.profile":
      b.allocation = clampAllocation({ mode: "profile", profile: el.value }, PROFILES);
      return false;
    case "alloc.incomePct":
      b.allocation.incomePct = clampNumber(el.value, 0, ALLOC_PCT_MAX);
      if (commit) el.value = b.allocation.incomePct;
      refreshBondAllocTotal(b.id);
      return false;
    case "alloc.growthPct":
      b.allocation.growthPct = clampNumber(el.value, 0, ALLOC_PCT_MAX);
      if (commit) el.value = b.allocation.growthPct;
      refreshBondAllocTotal(b.id);
      return false;
    case "alloc.frankingPct":
      b.allocation.frankingPct = clampNumber(el.value, 0, 100);
      if (commit) el.value = b.allocation.frankingPct;
      return false;
    case "alloc.volBasis":
      if (Object.keys(PROFILES).includes(el.value)) b.allocation.volBasis = el.value;
      return false;
    default:
      return false;
  }
}

function refreshBondAllocTotal(bdid) {
  const b = findBond(bdid);
  if (!b || b.allocation.mode !== "custom") return;
  const el = document.querySelector(`[data-role="bondAllocTotal-${bdid}"]`);
  if (el) el.textContent = `Total: ${(b.allocation.incomePct + b.allocation.growthPct).toFixed(2)}% p.a. nominal`;
}

els.investSection.addEventListener("input", (e) => {
  const bdid = e.target.dataset.bdid;
  const bdfield = e.target.dataset.bdfield;
  if (!bdid || !bdfield) return;
  const b = findBond(bdid);
  if (!b) return;
  applyBondEdit(b, bdfield, e.target, false);
  saveState();
  refreshOutputs();
});

els.investSection.addEventListener("change", (e) => {
  const bdid = e.target.dataset.bdid;
  const bdfield = e.target.dataset.bdfield;
  if (!bdid || !bdfield) return;
  const b = findBond(bdid);
  if (!b) return;
  const structural = applyBondEdit(b, bdfield, e.target, true);
  saveState();
  refreshOutputs();
  if (structural) renderCashflows();
});

els.investSection.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-bond-action]");
  if (!btn) return;
  const action = btn.dataset.bondAction;
  if (action === "add") {
    const owner = isCouple() && (state.bonds ?? []).some((b) => b.owner === "client") ? "partner" : "client";
    state.bonds = [...(state.bonds ?? []), { ...createBond(state.plan, state.bonds ?? [], PROFILES), owner }];
    saveState();
    refreshOutputs();
    renderCashflows();
    return;
  }
  const bdid = btn.dataset.bdid;
  const b = findBond(bdid);
  if (!b) return;
  switch (action) {
    case "toggle-collapse":
      if (e.target.closest(".pcard-include") || e.target.closest(".pcard-remove")) return;
      collapsed.set(bdid, !(collapsed.get(bdid) === true));
      renderCashflows();
      break;
    case "toggle-include":
      b.include = e.target.checked;
      saveState();
      els.investSection.querySelector(`.pcard[data-bdid="${bdid}"]`)?.classList.toggle("excluded", !b.include);
      refreshOutputs();
      break;
    case "remove":
      if (!window.confirm(`Remove "${b.name}"? Its contribution rows will be deleted too.`)) return;
      state.bonds = state.bonds.filter((x) => x.id !== bdid);
      state.cashflows.bondContributions = (state.cashflows.bondContributions ?? []).filter((c) => c.bondId !== bdid);
      collapsed.delete(bdid);
      saveState();
      refreshOutputs();
      renderCashflows();
      break;
    case "alloc-mode":
      switchAllocMode(b, btn.dataset.mode === "custom" ? "custom" : "profile");
      saveState();
      renderCashflows();
      refreshOutputs();
      break;
  }
});

// --- settings section ------------------------------------------------------

// --- Surplus and deficit allocation (spec 16, Commits 2-4) -----------------
//
// surplusDestinationBreakdown (imported from focusSurplusAllocation.js,
// this file's own pure module) is shared by the settings editor (this
// section), the Cashflow table's Funding group (Commit 3), and the
// Focus → Surplus allocation view (Commit 3/4) — ONE reader of "where
// did this FY's surplus actually go", built from the engine's own
// already-resolved per-target reporting fields rather than re-deriving
// the allocation logic — a liability funded via the automatic
// non-deductible-first step and one funded via an explicit allocation
// both land in the SAME reported field (a real, deliberate
// simplification: both are "surplus-driven", the spec's own phrase, and
// distinguishing the mechanism after the fact would need new engine
// state for no real benefit to what's displayed).

// Every legal allocation destination, grouped by type, encoded as a
// single select value "type:id" — one control per allocation row
// rather than a dependent type+target pair, so there is no
// intermediate state where the type is chosen but the target isn't
// (which clampAllocationEntry would silently drop on the next clamp).
function surplusEligibleTargets() {
  const assets = state.assets.filter((a) => a.include && a.class !== "lifestyle");
  const liabilities = state.liabilities ?? [];
  const superRows = (state.cashflows.superContributions ?? []).filter(
    (sc) => sc.type === "salarySacrifice" || sc.type === "personalDeductible"
  );
  const goals = state.goals ?? [];
  return { assets, liabilities, superRows, goals };
}

function surplusAllocationTargetOptionsHTML(selectedType, selectedId) {
  const { assets, liabilities, superRows, goals } = surplusEligibleTargets();
  const opt = (type, id, label) =>
    `<option value="${type}:${id}"${selectedType === type && selectedId === id ? " selected" : ""}>${escapeHTML(label)}</option>`;
  const groups = [];
  if (assets.length) groups.push(`<optgroup label="Assets">${assets.map((a) => opt("asset", a.id, a.name)).join("")}</optgroup>`);
  if (liabilities.length) groups.push(`<optgroup label="Liabilities">${liabilities.map((l) => opt("liability", l.id, l.name)).join("")}</optgroup>`);
  if (superRows.length) {
    groups.push(`<optgroup label="Super contributions">${superRows.map((sc) => {
      const acct = findSuperAccount(sc.accountId);
      return opt("superContribution", sc.id, `${sc.label}${acct ? ` (${acct.name})` : ""}`);
    }).join("")}</optgroup>`);
  }
  if (goals.length) groups.push(`<optgroup label="Goals">${goals.map((g) => opt("goal", g.id, g.label)).join("")}</optgroup>`);
  return groups.join("");
}

// The default destination for a freshly added allocation row — asset
// preferred (the most common case), falling through to whatever DOES
// exist. Always non-null: this app always keeps at least one financial
// asset (removeAsset's own "keep the last financial asset" rule), so
// there is always a legal default and a fresh row is never born
// pointing at nothing (which clampAllocationEntry would drop outright).
function surplusDefaultTarget() {
  const { assets, liabilities, superRows, goals } = surplusEligibleTargets();
  if (assets.length) return { targetType: "asset", targetId: assets[0].id };
  if (liabilities.length) return { targetType: "liability", targetId: liabilities[0].id };
  if (superRows.length) return { targetType: "superContribution", targetId: superRows[0].id };
  if (goals.length) return { targetType: "goal", targetId: goals[0].id };
  return { targetType: "asset", targetId: null };
}

function surplusCtx() {
  return { liabilities: state.liabilities, goals: state.goals, superContributions: state.cashflows.superContributions };
}

function commitSurplusPeriods(periods) {
  state.settings.surplus.periods = normaliseSurplusPeriods(periods, state.plan, state.assets, surplusCtx());
  saveState();
  refreshOutputs();
  renderSettings();
}

// "Resolved effect" line (spec's own worked example: "$2,340/month:
// $1,400 to Home loan, $600 to Super, $340 to Cash") — read from the
// period's own FIRST covered plan year, using whatever the engine
// actually did that year (never re-derived), so it's never wrong
// relative to the real projection. The sweep itself is a single FY-end
// lump sum, not a monthly transfer — the "/month" framing is the
// spec's own (a familiar budgeting scale for an adviser), so the
// caption says plainly that it's shown per month for scale only.
function surplusResolvedEffectHTML(p) {
  const schedule = projection.schedule;
  const y = resolveRef(p.from, state.plan, schedule, "client").planYear;
  const row = projection.yearly?.[y];
  if (!row) return "";
  const items = surplusDestinationBreakdown(row, state);
  if (!items.length) {
    return `<p class="helper-text">Resolved effect, ${schedule.fyLabels[y]}: no surplus was swept this year under this period's rules.</p>`;
  }
  const total = items.reduce((s, x) => s + x.amount, 0);
  const parts = items.map((x) => `${fmtMoney(Math.round(x.amount / 12))} to ${escapeHTML(x.label)}`).join(", ");
  return `<p class="helper-text">Resolved effect, ${schedule.fyLabels[y]} (swept once at FY-end; shown per month for scale): ${fmtMoney(Math.round(total / 12))}/month: ${parts}.</p>`;
}

function surplusPeriodCardHTML(p, i, periods) {
  const plan = state.plan, schedule = projection.schedule;
  const isFirst = i === 0, isLast = i === periods.length - 1;
  const fromAge = resolveRef(p.from, plan, schedule, "client").age;
  const toAge = resolveRef(p.to, plan, schedule, "client").age;
  const canSplit = toAge > fromAge;
  const usedPct = p.allocations.reduce((s, a) => s + a.pct, 0);
  const remainderPct = Math.max(0, 100 - usedPct);

  // Only an INTERNAL boundary (a non-first period's own "from") is
  // ever directly edited — the outer edges (period 0's from, the last
  // period's to) always track Start/End so the periods keep covering
  // the whole projection even if the plan's own bounds later move.
  // Bounded to (previous boundary, next boundary) so the control
  // itself can never produce an overlap — the spec's own "incapable of
  // entering a gap/overlap" requirement, enforced at the input, not
  // after the fact.
  const fromHTML = isFirst
    ? `<span class="date-ref-resolved">Start (age ${fromAge})</span>`
    : dateRefControlHTML(p.from, "client", `data-pid="${p.id}" data-pfield="boundary"`, plan.client.currentAge, plan.endAge);
  const toHTML = isLast
    ? `<span class="date-ref-resolved">End (age ${toAge})</span>`
    : `<span class="date-ref-resolved">age ${toAge} — set by the next period's start</span>`;

  const allocRows = p.allocations.map((a) => `
    <div class="alloc-row" data-said="${a.id}">
      <select data-pid="${p.id}" data-said="${a.id}" data-pfield="target">${surplusAllocationTargetOptionsHTML(a.targetType, a.targetId)}</select>
      <input type="number" min="0" max="100" step="1" value="${a.pct}" data-pid="${p.id}" data-said="${a.id}" data-pfield="pct" aria-label="Percent" />%
      <button type="button" class="btn-text" data-pid="${p.id}" data-said="${a.id}" data-paction="remove-allocation">Remove</button>
    </div>
  `).join("");

  return `
    <div class="cf-section surplus-period" data-pid="${p.id}">
      <div class="cf-section-title">
        Period ${i + 1}
        ${periods.length > 1 ? `<button type="button" class="btn-text" data-pid="${p.id}" data-paction="remove-period">Remove period</button>` : ""}
      </div>
      <div class="person-grid">
        <div class="cf-cell"><label>From</label>${fromHTML}</div>
        <div class="cf-cell"><label>To</label>${toHTML}</div>
      </div>
      <label class="ptg-check">
        <input type="checkbox"${p.payNonDeductibleDebtFirst ? " checked" : ""} data-pid="${p.id}" data-pfield="payNonDeductibleDebtFirst" />
        <span>Pay non-deductible debt first, before any other destination</span>
      </label>
      <div class="cf-cell">
        <label>Order debt is paid down in</label>
        <select data-pid="${p.id}" data-pfield="debtOrder"${p.payNonDeductibleDebtFirst ? "" : " disabled"}>
          <option value="interestRate"${p.debtOrder === "interestRate" ? " selected" : ""}>Highest interest rate first</option>
          <option value="manual"${p.debtOrder === "manual" ? " selected" : ""}>Manual (Liabilities section order)</option>
        </select>
      </div>
      <div class="alloc-list">${allocRows}</div>
      ${remainderPct > 0 ? `<button type="button" class="btn-text" data-pid="${p.id}" data-paction="add-allocation">+ Add allocation</button>` : ""}
      <p class="surplus-remainder">Remainder: <strong>${remainderPct}%</strong> →
        <select data-pid="${p.id}" data-pfield="remainderTo">
          <option value="cash"${p.remainderTo === "cash" ? " selected" : ""}>Cash</option>
          <option value="expenditure"${p.remainderTo === "expenditure" ? " selected" : ""}>Expenditure</option>
        </select>
      </p>
      ${canSplit ? `<button type="button" class="btn-text" data-pid="${p.id}" data-paction="split-period">+ Split into two periods</button>` : ""}
      ${surplusResolvedEffectHTML(p)}
    </div>
  `;
}

function surplusPeriodsSectionHTML() {
  const periods = state.settings.surplus.periods;
  return `
    <div class="cf-section">
      <div class="cf-section-title">Surplus treatment</div>
      <p class="helper-text">Once a year, at the end of each financial year, whatever is sitting in the Working Cash Account above its minimum is allocated per the period covering that year.</p>
    </div>
    ${periods.map((p, i) => surplusPeriodCardHTML(p, i, periods)).join("")}
  `;
}

function deficitSectionHTML(orderItems) {
  const d = state.settings.deficit;
  const includedAssets = state.assets.filter((a) => a.include && a.class !== "lifestyle");
  const minBalRows = includedAssets.map((a) => `
    <div class="cf-cell">
      <label>${escapeHTML(a.name)} minimum ($)</label>
      <input type="number" min="0" step="1000" value="${d.minimumBalances[a.id] ?? 0}"
             data-aid="${a.id}" data-settings-field="deficitMinimum" />
    </div>
  `).join("");
  return `
    <div class="cf-section">
      <div class="cf-section-title">Deficit funding order</div>
      <div class="order-list">${orderItems}</div>
      <p class="helper-text">When the Working Cash Account needs topping up, money is drawn from these assets in this order.</p>
      <div class="cf-cell">
        <label>Sell rule</label>
        <select data-settings-field="deficitSellRule">
          <option value="order"${d.sellRule === "order" ? " selected" : ""}>Follow the order above</option>
          <option value="minimumCapitalGain"${d.sellRule === "minimumCapitalGain" ? " selected" : ""}>Smallest unrealised gain first</option>
        </select>
      </div>
      <p class="helper-text">"Smallest unrealised gain first" sells from whichever asset would realise the least capital gain as a proportion of its value, recomputed every time — tax-aware drawdown, not a fixed order. Cash and lifestyle assets (which realise nothing) always sort first either way.</p>
      <div class="person-grid">${minBalRows}</div>
      <p class="helper-text">Deficit funding draws each asset down to its own minimum before moving to the next; only once every asset is at its minimum does funding draw below them, in the same order, before cashflow goes unfunded.</p>
    </div>
  `;
}

function renderSettings() {
  const s = state.settings;
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
      ${giftsSectionHTML()}
      ${heasSectionHTML()}
      ${surplusPeriodsSectionHTML()}
      ${deficitSectionHTML(orderItems)}
    </div>
  `;
}

// --- Gifts (spec 21b engine; spec 27 Commit 2 UI) ---------------------------
//
// A household-level list (owner is informational only — the deprivation
// limits are assessed against the household as one pool regardless of
// whose asset the gift notionally came from, src/gifting.js's own
// header), so this lives in Settings alongside the other household-wide
// elections (Working Cash, HEAS) rather than under any one person — the
// spec's own "Age pension or Settings, whichever is the more natural
// home" is resolved here since there's no Age pension INPUT section to
// put it in (age pension is an output view only).
function findGift(gid) {
  return (state.plan.gifts ?? []).find((g) => g.id === gid) ?? null;
}

// Mirrors deterministic.js's own julyOf/yearStartIdx exactly (a gift
// "fires in July of its resolved plan year, or never" — the same
// convention every other one-off event in this engine uses) so this
// live preview lands on the same month the engine itself will use.
function giftJulyOf(planYear) {
  return planYear === 0 ? (state.plan.start.month === 7 ? 0 : null) : endMonthOfYear(planYear - 1);
}

// The live deprivation position for every CURRENTLY entered gift — the
// same resolveGiftDeprivation the engine itself runs (src/gifting.js),
// fed from the plan's own gifts rather than a projected schedule, so
// the $10,000/yr and $30,000/5-year running position is visible at the
// point of entry rather than only after landing on the Age pension
// output view.
function resolvedGiftsForPreview() {
  const events = (state.plan.gifts ?? []).map((g) => {
    const planYear = resolveRef(g.at, state.plan, projection.schedule, "client").planYear;
    const month = giftJulyOf(planYear);
    return month == null ? null : { id: g.id, month, amount: g.amount, planYear };
  }).filter(Boolean);
  return resolveGiftDeprivation(events);
}

function giftCardHTML(g, resolved) {
  const r = resolved.find((x) => x.id === g.id);
  return `
    <div class="pcard" data-gid="${g.id}">
      <div class="pcard-head">
        <span class="pcard-name">${escapeHTML(g.label)}</span>
        <button class="pcard-remove" type="button" data-gift-action="remove" data-gid="${g.id}">Remove</button>
      </div>
      <div class="pcard-body">
        <div class="person-grid">
          <div class="cf-cell">
            <label>Label</label>
            <input type="text" maxlength="40" value="${escapeHTML(g.label)}" data-gid="${g.id}" data-gfield="label" />
          </div>
          ${isCouple() ? `
          <div class="cf-cell">
            <label>Owner ${tooltipHTML(`Informational only — the ${fmtMoney(GIFT_ANNUAL_LIMIT)}/yr and ${fmtMoney(GIFT_FIVE_YEAR_LIMIT)}/five-year gifting limits are assessed against the household as one pool regardless of whose asset it notionally came from.`)}</label>
            <select data-gid="${g.id}" data-gfield="owner">
              <option value="client"${g.owner === "client" ? " selected" : ""}>${escapeHTML(clientName())}</option>
              <option value="partner"${g.owner === "partner" ? " selected" : ""}>${escapeHTML(partnerName())}</option>
              <option value="joint"${g.owner === "joint" ? " selected" : ""}>Joint</option>
            </select>
          </div>` : ""}
          <div class="cf-cell">
            <label>Amount ($)</label>
            <input type="number" min="0" step="1000" value="${g.amount}" data-gid="${g.id}" data-gfield="amount" />
          </div>
          <div class="cf-cell">
            <label>At</label>
            ${dateRefControlHTML(g.at, "client", `data-gid="${g.id}" data-gfield="at"`, state.plan.client.currentAge, state.plan.endAge)}
          </div>
        </div>
        ${r ? `
          <p class="helper-text">
            ${r.deprived > 0
              ? `${fmtMoney(r.allowable)} within the gifting limits; ${fmtMoney(r.deprived)} is a DEPRIVED ASSET — assessed under both the assets test and the income test (deemed) for five years from this gift's own date.`
              : `Fully within the ${fmtMoney(GIFT_ANNUAL_LIMIT)}/financial-year and ${fmtMoney(GIFT_FIVE_YEAR_LIMIT)}/rolling-five-year gifting limits — not assessed as a deprived asset.`}
          </p>
        ` : `<p class="helper-text">Falls outside the projection window (or before the projection start) — never fires, so it isn't assessed.</p>`}
      </div>
    </div>
  `;
}

function giftsSectionHTML() {
  const gifts = state.plan.gifts ?? [];
  const resolved = gifts.length ? resolvedGiftsForPreview() : [];
  return `
    <div class="cf-section">
      <div class="cf-section-title">Gifts ${tooltipHTML(`A one-off cash gift out of the household. Centrelink treats gifting above ${fmtMoney(GIFT_ANNUAL_LIMIT)}/financial year or ${fmtMoney(GIFT_FIVE_YEAR_LIMIT)}/rolling five years as a DEPRIVED ASSET — still assessed under both means tests for five years from the gift's own date.`)}</div>
      ${gifts.length ? `<div class="portfolio-stack">${gifts.map((g) => giftCardHTML(g, resolved)).join("")}</div>` : ""}
      <button class="btn-text" type="button" data-gift-action="add">+ Add gift</button>
    </div>
  `;
}

// Home Equity Access Scheme (spec 21b, Commit 5) — a single household
// election, so it lives here (a plan-level setting) rather than as a
// repeatable row-list the way pensions/gifts are. Mirrors the property
// "Sale" toggle's own shape (a checkbox gating a dependent select,
// propertyCardHTML) — disabled/hidden with an explanatory note when the
// household has no property at all to secure it against.
function heasSectionHTML() {
  const heas = state.plan.heas ?? { enabled: false, propertyId: null };
  const properties = state.properties ?? [];
  const propertyOptions = properties
    .map((p) => `<option value="${p.id}"${p.id === heas.propertyId ? " selected" : ""}>${escapeHTML(p.name)}</option>`)
    .join("");
  return `
    <div class="cf-section">
      <div class="cf-section-title">Home Equity Access Scheme</div>
      <p class="helper-text">A government loan secured against one property, drawn as a fortnightly income stream (up to 150% of the maximum pension rate, less any actual age pension received), with interest capitalising onto the loan balance and recovered from the estate — it increases cashflow at the cost of a smaller estate, not the other way around.</p>
      ${properties.length ? `
        <label class="ptg-check"><input type="checkbox"${heas.enabled ? " checked" : ""} data-settings-field="heasEnabled" /><span>Model a Home Equity Access Scheme loan</span></label>
        ${heas.enabled ? `
          <div class="person-grid">
            <div class="cf-cell">
              <label>Secured against</label>
              <select data-settings-field="heasPropertyId"><option value="">Select a property…</option>${propertyOptions}</select>
            </div>
          </div>
        ` : ""}
      ` : `<p class="helper-text">Add a property (Property section) before this can be enabled — the loan must be secured against real estate.</p>`}
    </div>
  `;
}

els.settingsPanel.addEventListener("change", (e) => {
  const gid = e.target.dataset.gid;
  const gfield = e.target.dataset.gfield;
  if (gid && gfield) {
    const g = findGift(gid);
    if (!g) return;
    const v = e.target.value;
    if (gfield === "label") g.label = v.trim() || g.label;
    else if (gfield === "owner") g.owner = ["client", "partner", "joint"].includes(v) ? v : "client";
    else if (gfield === "amount") g.amount = clampNumber(v, 0);
    else if (gfield === "at") {
      if (e.target.dataset.drRole === "anchor") {
        g.at = v === "__age__"
          ? { kind: "age", age: resolveRef(g.at, state.plan, projection.schedule, "client").age }
          : { kind: "anchor", anchorId: v };
      } else {
        const age = clampInt(v, state.plan.client.currentAge, state.plan.endAge);
        g.at = { kind: "age", age };
        flagIfClamped(e.target, age);
      }
    } else {
      return;
    }
    saveState();
    refreshOutputs();
    renderSettings();
    return;
  }
  const pid = e.target.dataset.pid;
  if (pid) { onSurplusPeriodChange(e.target, pid); return; }
  const field = e.target.dataset.settingsField;
  if (!field) return;
  if (field === "wcaBalance") {
    state.plan.workingCash = clampWorkingCash({ ...state.plan.workingCash, balance: clampNumber(e.target.value, 0) });
  } else if (field === "wcaMinimum") {
    state.plan.workingCash = clampWorkingCash({ ...state.plan.workingCash, minimumBalance: clampNumber(e.target.value, 0) });
  } else if (field === "wcaRate") {
    const v = e.target.value;
    state.plan.workingCash = clampWorkingCash({ ...state.plan.workingCash, ratePct: v === "" ? null : clampNumber(v, -10, 30) });
  } else if (field === "heasEnabled") {
    // Enabling defaults to the first available property — never an
    // enabled election with nothing yet selected to secure it against.
    const defaultPropertyId = state.plan.heas?.propertyId ?? (state.properties ?? [])[0]?.id ?? null;
    state.plan.heas = clampHeas({ enabled: e.target.checked, propertyId: defaultPropertyId });
  } else if (field === "heasPropertyId") {
    state.plan.heas = clampHeas({ ...state.plan.heas, propertyId: e.target.value || null });
  } else if (field === "deficitMinimum") {
    const aid = e.target.dataset.aid;
    state.settings.deficit = { ...state.settings.deficit, minimumBalances: { ...state.settings.deficit.minimumBalances, [aid]: clampNumber(e.target.value, 0) } };
  } else if (field === "deficitSellRule") {
    state.settings.deficit = { ...state.settings.deficit, sellRule: DEFICIT_SELL_RULES.includes(e.target.value) ? e.target.value : "order" };
  } else {
    return;
  }
  state.settings = normaliseSettings(state.settings, state.assets, state.plan, surplusCtx());
  saveState();
  refreshOutputs();
  renderSettings();
});

// A period's own from/to are mutated as a PAIR: editing period i's
// "from" (the only boundary ever directly exposed — see
// surplusPeriodCardHTML's own comment) always writes period i-1's "to"
// in the SAME commit, one age below the new value, so the two periods
// can never drift out of contiguity between renders.
function onSurplusPeriodChange(el, pid) {
  const periods = state.settings.surplus.periods;
  const i = periods.findIndex((p) => p.id === pid);
  if (i < 0) return;
  const plan = state.plan, schedule = projection.schedule;
  const field = el.dataset.pfield;
  const next = periods.map((p) => ({ ...p, allocations: p.allocations.map((a) => ({ ...a })) }));

  if (field === "boundary") {
    if (i === 0) return; // the first period's "from" is never editable
    let ref;
    if (el.dataset.drRole === "anchor") {
      ref = el.value === "__age__"
        ? { kind: "age", age: resolveRef(next[i].from, plan, schedule, "client").age }
        : { kind: "anchor", anchorId: el.value };
    } else {
      ref = { kind: "age", age: clampInt(el.value, plan.client.currentAge, plan.endAge) };
    }
    // Bound strictly between the neighbouring boundaries so the SAME
    // input that lets the user choose an anchor can never itself
    // create a gap or an overlap — an anchor whose own resolved age
    // falls outside the band is converted to a plain clamped age
    // rather than accepted and silently misordering the list (the
    // project's standing "unenterable state, not a warning" rule).
    const minAge = resolveRef(next[i - 1].from, plan, schedule, "client").age + 1;
    const maxAge = i + 1 < next.length ? resolveRef(next[i + 1].from, plan, schedule, "client").age - 1 : plan.endAge;
    const resolvedAge = resolveRef(ref, plan, schedule, "client").age;
    const clampedAge = Math.min(Math.max(resolvedAge, minAge), maxAge);
    if (clampedAge !== resolvedAge) ref = { kind: "age", age: clampedAge };
    next[i] = { ...next[i], from: ref };
    next[i - 1] = { ...next[i - 1], to: { kind: "age", age: clampedAge - 1 } };
    commitSurplusPeriods(next);
    return;
  }
  if (field === "payNonDeductibleDebtFirst") {
    next[i] = { ...next[i], payNonDeductibleDebtFirst: el.checked };
    commitSurplusPeriods(next);
    return;
  }
  if (field === "debtOrder") {
    next[i] = { ...next[i], debtOrder: DEBT_ORDER_MODES.includes(el.value) ? el.value : "interestRate" };
    commitSurplusPeriods(next);
    return;
  }
  if (field === "remainderTo") {
    next[i] = { ...next[i], remainderTo: REMAINDER_TARGETS.includes(el.value) ? el.value : "cash" };
    commitSurplusPeriods(next);
    return;
  }
  if (field === "target" || field === "pct") {
    const said = el.dataset.said;
    const allocs = next[i].allocations;
    const j = allocs.findIndex((a) => a.id === said);
    if (j < 0) return;
    if (field === "target") {
      const [targetType, targetId] = el.value.split(":");
      if (!ALLOCATION_TARGET_TYPES.includes(targetType)) return;
      allocs[j] = { ...allocs[j], targetType, targetId };
    } else {
      // Clamped to this row's own remaining headroom (100% minus every
      // OTHER row's percentage) — the spec's own "incapable of
      // exceeding 100%, prevented at input" requirement.
      const othersSum = allocs.reduce((s, a, k) => (k === j ? s : s + a.pct), 0);
      allocs[j] = { ...allocs[j], pct: clampNumber(el.value, 0, Math.max(0, 100 - othersSum)) };
    }
    commitSurplusPeriods(next);
    return;
  }
}

els.settingsPanel.addEventListener("click", (e) => {
  const giftBtn = e.target.closest("[data-gift-action]");
  if (giftBtn) {
    const giftAction = giftBtn.dataset.giftAction;
    if (giftAction === "add") {
      const owner = isCouple() && (state.plan.gifts ?? []).some((g) => g.owner === "client") ? "partner" : "client";
      state.plan.gifts = [...(state.plan.gifts ?? []), { ...createGift(state.plan, state.plan.gifts ?? []), owner }];
    } else if (giftAction === "remove") {
      const g = findGift(giftBtn.dataset.gid);
      if (!g || !window.confirm(`Remove "${g.label}"?`)) return;
      state.plan.gifts = state.plan.gifts.filter((x) => x.id !== g.id);
    } else {
      return;
    }
    saveState();
    refreshOutputs();
    renderSettings();
    return;
  }
  const btn = e.target.closest("[data-action], [data-paction]");
  if (!btn) return;
  const { action, paction, pid, said } = btn.dataset;
  if (paction) { onSurplusPeriodAction(paction, pid, said); return; }
  if (action !== "order-up" && action !== "order-down") return;
  const order = [...state.settings.fundingOrder];
  const i = order.indexOf(btn.dataset.aid);
  const j = action === "order-up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  state.settings.fundingOrder = normaliseFundingOrder(order, state.assets);
  saveState();
  renderSettings();
});

function onSurplusPeriodAction(paction, pid, said) {
  const periods = state.settings.surplus.periods;
  const i = periods.findIndex((p) => p.id === pid);
  if (i < 0) return;
  const plan = state.plan, schedule = projection.schedule;
  const next = periods.map((p) => ({ ...p, allocations: p.allocations.map((a) => ({ ...a })) }));

  if (paction === "add-allocation") {
    const usedPct = next[i].allocations.reduce((s, a) => s + a.pct, 0);
    const remainderPct = Math.max(0, 100 - usedPct);
    if (remainderPct <= 0) return;
    next[i].allocations.push({ id: uid("sa"), ...surplusDefaultTarget(), pct: remainderPct });
    commitSurplusPeriods(next);
  } else if (paction === "remove-allocation") {
    next[i].allocations = next[i].allocations.filter((a) => a.id !== said);
    commitSurplusPeriods(next);
  } else if (paction === "remove-period" && periods.length > 1) {
    // Merge into a neighbour rather than leaving a gap: the first
    // period is absorbed forward (period 1 extends back to Start), any
    // other period is absorbed by the one before it (which extends to
    // this period's own "to") — contiguity is preserved by construction,
    // never re-validated after the fact.
    if (i === 0) {
      next[1] = { ...next[1], from: { kind: "anchor", anchorId: "start" } };
    } else {
      next[i - 1] = { ...next[i - 1], to: next[i].to };
    }
    next.splice(i, 1);
    commitSurplusPeriods(next);
  } else if (paction === "split-period") {
    const p = next[i];
    const fromAge = resolveRef(p.from, plan, schedule, "client").age;
    const toAge = resolveRef(p.to, plan, schedule, "client").age;
    if (toAge <= fromAge) return;
    const splitAge = Math.min(Math.max(fromAge + Math.ceil((toAge - fromAge) / 2), fromAge + 1), toAge);
    const added = { ...createSurplusPeriod(), from: { kind: "age", age: splitAge }, to: p.to };
    next[i] = { ...p, to: { kind: "age", age: splitAge - 1 } };
    next.splice(i + 1, 0, added);
    commitSurplusPeriods(next);
  }
}

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
    case "label": {
      // Input behaviour fix — typing a label directly is the override
      // that stops it tracking the category (income/expenses/deductions
      // only; other kinds' "label" has no category to derive from).
      // Never re-arms, same one-way stop as property rent/expenses.
      // A full outerHTML refresh (as the "category" case does) would
      // drop focus/cursor position mid-keystroke, so the now-stale
      // provenance tooltip is removed surgically instead, only at the
      // instant tracking actually stops.
      const wasDefault = row.labelIsDefault === true;
      row.label = commit ? (el.value.trim() || row.label) : el.value;
      if (commit) el.value = row.label;
      if (kind === "income" || kind === "expenses" || kind === "deductions") {
        row.labelIsDefault = false;
        if (wasDefault) el.closest("td")?.querySelector(".tt-wrap")?.remove();
      }
      break;
    }
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
        // Gated on `commit` (see "category"'s own header comment,
        // just below, for why an unconditional refresh here breaks the
        // native "change" event a <select> fires second, after
        // "input" — a real, found-in-browser bug this fix closes for
        // every select-driven row refresh in this function, not just
        // the one instance that was reported).
        if (commit) { const rowEl = el.closest(".cf-tr"); if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); }
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
      if (commit) { const rowEl = el.closest(".cf-tr"); if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); }
      break;
    }
    case "assetId":
      if (findAsset(el.value)) row.assetId = el.value;
      break;
    case "bondId":
      if ((state.bonds ?? []).some((b) => b.id === el.value)) row.bondId = el.value;
      break;
    case "accountId":
      if ((state.plan.superAccounts ?? []).some((s) => s.id === el.value)) row.accountId = el.value;
      break;
    // Super rollovers (spec 26, Commit 1; UI: spec 27 Commit 1) — TWO
    // account fields, not one, so neither reuses the singular
    // "accountId" case above. Changing the FROM account can leave the
    // TO account belonging to a different owner (rollovers are same-
    // person only) or pointing at the SAME account — both dropped
    // rather than silently kept, the same "unknown/invalid reference
    // dropped, row survives" convention clampSuperRollover itself uses.
    case "fromAccountId": {
      if (!(state.plan.superAccounts ?? []).some((s) => s.id === el.value)) break;
      row.fromAccountId = el.value;
      const fromOwner = findSuperAccount(row.fromAccountId)?.owner;
      const toOwner = findSuperAccount(row.toAccountId)?.owner;
      if (row.toAccountId === row.fromAccountId || (toOwner && toOwner !== fromOwner)) row.toAccountId = null;
      if (commit) { const rowEl = el.closest(".cf-tr"); if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); }
      break;
    }
    case "toAccountId":
      if ((state.plan.superAccounts ?? []).some((s) => s.id === el.value) && el.value !== row.fromAccountId) row.toAccountId = el.value;
      if (commit) { const rowEl = el.closest(".cf-tr"); if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); } // live rollover-tax estimate depends on the pair
      break;
    case "rolloverAmount":
      row.amount = el.value === "" ? null : clampNumber(el.value, 0);
      if (commit) { el.value = row.amount ?? ""; const rowEl = el.closest(".cf-tr"); if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); } // live tax estimate
      break;
    case "type": {
      if (SUPER_CONTRIBUTION_TYPES.includes(el.value)) row.type = el.value;
      if (commit) { const rowEl = el.closest(".cf-tr"); if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); } // cap-headroom note depends on type
      break;
    }
    case "basis": {
      if (SUPER_CONTRIBUTION_BASES.includes(el.value)) row.basis = el.value;
      if (commit) { const rowEl = el.closest(".cf-tr"); if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); } // amount vs percent vs fill-note fields differ
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
      if (commit) { const rowEl = el.closest(".cf-tr"); if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); } // refresh the computed total
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
        // convention) — force it off here too.
        if (row.incomeType !== "employment") row.sgApplies = false;
        // Input behaviour fix — label as a derived default: follows the
        // category until the user types their own (see labelTdHTML's
        // own header comment), mirroring planState.js's clampDerivedLabel
        // for the cases (owner changes, hydrate) that go through the
        // full clamp instead of this direct field-edit path.
        if (row.labelIsDefault === true) row.label = INCOME_CATEGORY_LABELS[row.category];
      } else if (kind === "expenses") {
        row.category = EXPENSE_CATEGORIES.includes(el.value) ? el.value : "other";
        if (row.labelIsDefault === true) row.label = EXPENSE_CATEGORY_LABELS[row.category];
      } else if (kind === "deductions") {
        row.category = DEDUCTION_CATEGORIES.includes(el.value) ? el.value : "other";
        if (row.labelIsDefault === true) row.label = DEDUCTION_CATEGORY_LABELS[row.category];
      }
      // Refresh the row: income already needed this for the SG toggle;
      // expenses/deductions now need it too, so a still-tracking
      // label's new value shows immediately instead of waiting for
      // some unrelated edit to trigger the next re-render. Gated on
      // `commit` — a <select> fires "input" (commit false) immediately
      // BEFORE its own native "change", and an unconditional outerHTML
      // replacement here would destroy the original element while that
      // "input" is still being handled, silently suppressing the
      // "change" event the touched-field capture-phase listener (and
      // browsers generally) expect to fire next on that same node — a
      // real, found-in-browser regression (the touched dot never
      // cleared for ANY category edit, income included, until this).
      if (commit) {
        const rowEl = el.closest(".cf-tr");
        if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row);
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
        if (commit) { const rowEl = el.closest(".cf-tr"); if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); } // select/number visibility changes
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
        if (commit) { const rowEl = el.closest(".cf-tr"); if (rowEl) rowEl.outerHTML = rowHTMLFor(kind, row); }
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
  if (kind === "superRollovers") return superRolloverRowHTML(row);
  if (kind === "bondContributions") return bondContributionRowHTML(row);
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

const SUPER_ROW_KINDS = ["superContributions", "superWithdrawals", "superRollovers"];

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
    } else if (kind === "superRollovers") {
      const owner = isCouple() && (cf.superRollovers ?? []).some((r) => findSuperAccount(r.fromAccountId)?.owner === "client") ? "partner" : "client";
      cf.superRollovers = [...(cf.superRollovers ?? []), createSuperRollover(state.plan, state.plan.superAccounts ?? [], owner)];
    } else if (kind === "bondContributions") {
      cf.bondContributions = [...(cf.bondContributions ?? []), createBondContribution(state.plan, state.bonds ?? [])];
    }
    saveState();
    if (isSuperKind) { refreshOutputs(); renderSuper(); } else { renderCashflows(); refreshOutputs(); }
  } else if (action === "remove-row") {
    if (cf[kind]) cf[kind] = cf[kind].filter((r) => r.id !== cfid);
    saveState();
    if (isSuperKind) { refreshOutputs(); renderSuper(); } else { renderCashflows(); refreshOutputs(); }
  } else if (action === "edit-termination") {
    openTerminationEditor(cfid);
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
  // Smart defaults (spec 19 Commit 1) — a derived amount still tracking
  // (isDefault) carries the registry's own provenance sentence as a
  // tooltip; once overridden, the field is unremarkable (no tooltip),
  // same "distinct while it's a default, ordinary once entered"
  // treatment as untouched fields elsewhere.
  const flowCells = (label, field, flow) => `
    ${num(
      `${label} ($/yr, today's)${flow.isDefault ? ` ${tooltipHTML(describeDefault(`property.${field}Amount`, { value: flow.amount }))}` : ""}`,
      `${field}.amount`, flow.amount
    )}
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
          ${num(`Growth (% p.a. nominal) ${tooltipHTML(describeDefault("property.growthPct", { value: (PROFILES["Residential Property"]?.growthReturn ?? 0.05) * 100 }))}`, "growthPct", p.growthPct, 'min="-10" max="30" step="0.1"')}
          ${num("Equity ceiling (%)", "equityCeilingPct", p.equityCeilingPct ?? 80, 'min="0" max="100" step="1"')}
          ${owned ? `
            ${num("Current value ($)", "currentValue", p.currentValue)}
            ${cell("Acquisition date", `<input type="date" max="${todayISO()}" value="${p.acquisitionDate ?? ""}" data-pid="${p.id}" data-pfield="acquisitionDate" />`)}
            ${p.propertyType !== "ppr" ? num("Cost base ($)", "costBase", p.costBase) : ""}
          ` : `
            ${num("Price today ($)", "priceToday", p.priceToday)}
            ${cell("Purchase at", dateRefControlHTML(p.purchaseAt, "client", `data-pid="${p.id}" data-pfield="purchaseAt"`, state.plan.client.currentAge, state.plan.endAge))}
            ${num(`LVR (%) ${tooltipHTML(describeDefault("property.lvrPct"))}`, "lvrPct", p.lvrPct, 'min="0" max="100" step="1"')}
            ${num(`Purchase costs (%) ${tooltipHTML(describeDefault("property.purchaseCostsPct"))}`, "purchaseCostsPct", p.purchaseCostsPct, 'min="0" max="10" step="0.1"')}
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
          ${p.propertyType !== "ppr" ? `
            ${num(`Land value (% of property value) ${tooltipHTML("Land tax is assessed on unimproved land value, not total property value — this estimates the land component (the largest approximation in this feature). Investment and holiday properties both attract land tax; a main residence is exempt.")}`, "landValuePct", p.landValuePct ?? 60, 'min="0" max="100" step="1"')}
            ${num("Land tax override ($/yr, blank = calculated)", "landTaxOverride", p.landTaxOverride ?? "", 'min="0" step="100"')}
          ` : ""}
        </div>

        <div class="cf-section">
          <div class="cf-section-title">Sale ${tooltipHTML("Models this property being sold during the projection: proceeds net of agent fees and settlement costs, the linked loan discharged first (if any), CGT via the existing pooled cost base, and the property leaving the projection from that point.")}</div>
          <label class="ptg-check"><input type="checkbox"${p.sale.enabled ? " checked" : ""} data-pid="${p.id}" data-pfield="sale.enabled" /><span>Sell this property during the projection</span></label>
          ${p.sale.enabled ? `
            <div class="person-grid">
              ${cell("Sale date", dateRefControlHTML(p.sale.at, "client", `data-pid="${p.id}" data-pfield="sale.at"`, state.plan.client.currentAge, state.plan.endAge))}
              ${num(`Agent fees (%) ${tooltipHTML(describeDefault("property.agentFeesPct"))}`, "sale.agentFeesPct", p.sale.agentFeesPct, 'min="0" max="10" step="0.1"')}
              ${num("Settlement costs ($)", "sale.settlementCosts", p.sale.settlementCosts, 'min="0" step="100"')}
              ${cell("Proceeds destination", `
                <select data-pid="${p.id}" data-pfield="sale.proceedsDestination">
                  <option value="repayLoanThenAsset"${p.sale.proceedsDestination === "repayLoanThenAsset" ? " selected" : ""}>Discharge linked loan first, remainder to asset</option>
                  <option value="asset"${p.sale.proceedsDestination === "asset" ? " selected" : ""}>All proceeds to asset (no loan discharge)</option>
                </select>`)}
              ${cell("Destination asset", `<select data-pid="${p.id}" data-pfield="sale.assetId"><option value="">Select an asset…</option>${assetOptions(p.sale.assetId)}</select>`)}
            </div>
          ` : ""}
        </div>

        ${p.propertyType === "ppr" ? `
        <div class="cf-section">
          <div class="cf-section-title">Main residence exemption ${tooltipHTML("A main residence stays CGT-exempt while occupied, and for up to six years while absent if it isn't producing income beyond that window's own rule — see the Focus view for the running clock and what CGT would be payable if sold in a given year.")}</div>
          <label class="ptg-check"><input type="checkbox"${p.mainResidence.movedOutAt ? " checked" : ""} data-pid="${p.id}" data-pfield="mainResidence.movedOutEnabled" /><span>Moved out during the projection</span></label>
          ${p.mainResidence.movedOutAt ? `
            <div class="person-grid">
              ${cell("Moved out", dateRefControlHTML(p.mainResidence.movedOutAt, "client", `data-pid="${p.id}" data-pfield="mainResidence.movedOutAt"`, state.plan.client.currentAge, state.plan.endAge))}
              ${cell("Producing income while absent", `<label class="ptg-check"><input type="checkbox"${p.mainResidence.producingIncome ? " checked" : ""} data-pid="${p.id}" data-pfield="mainResidence.producingIncome" /><span>Yes (rented out)</span></label>`)}
            </div>
            <label class="ptg-check"><input type="checkbox"${p.mainResidence.movedBackInAt ? " checked" : ""} data-pid="${p.id}" data-pfield="mainResidence.movedBackInEnabled" /><span>Moved back in (resets the six-year clock)</span></label>
            ${p.mainResidence.movedBackInAt ? cell("Moved back in", dateRefControlHTML(p.mainResidence.movedBackInAt, "client", `data-pid="${p.id}" data-pfield="mainResidence.movedBackInAt"`, resolveRef(p.mainResidence.movedOutAt, state.plan, projection.schedule, "client").age, state.plan.endAge)) : ""}
          ` : ""}
        </div>
        ` : ""}
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
  else if (field === "landValuePct") p.landValuePct = clampNumber(v, 0, 100);
  else if (field === "landTaxOverride") p.landTaxOverride = v === "" ? null : clampNumber(v, 0);
  else if (field.includes(".")) {
    const [group, sub] = field.split(".");
    if ((group === "rent" || group === "expenses") && p[group]) {
      // Smart defaults (spec 19 Commit 1) — typing an amount directly
      // is the override that stops this field tracking its derived
      // value (4% of property value / 20% of gross rent); it never
      // re-arms from here.
      if (sub === "amount") { p[group].amount = clampNumber(v, 0); p[group].isDefault = false; }
      else if (sub === "indexBasis") p[group].indexBasis = v;
      else if (sub === "indexExtraPct") p[group].indexExtraPct = clampNumber(v, -10, 10);
    } else if (group === "sale") {
      // Property sale (spec 19 Commit 4) — engine/model-complete since
      // that commit; this is the input UI it never got.
      if (sub === "enabled") {
        // normaliseProperties forces enabled back to false whenever
        // assetId doesn't resolve to a real financial asset (a sale
        // enabled with nowhere for the proceeds to land is exactly the
        // "looks entered but silently does nothing" state CLAUDE.md's
        // input-integrity section rules out) — so checking the box
        // must ALSO pick a destination in the SAME commit, or the
        // checkbox would silently revert the instant it's ticked.
        const defaultAssetId = p.sale.assetId ?? state.assets.find((a) => a.class !== "lifestyle")?.id ?? null;
        p.sale = { ...p.sale, enabled: e.target.checked, assetId: defaultAssetId };
      }
      else if (sub === "at") {
        if (e.target.dataset.drRole === "anchor") {
          p.sale = { ...p.sale, at: v === "__age__"
            ? { kind: "age", age: resolveRef(p.sale.at, state.plan, projection.schedule, "client").age }
            : { kind: "anchor", anchorId: v } };
        } else {
          const age = clampInt(v, state.plan.client.currentAge, state.plan.endAge);
          p.sale = { ...p.sale, at: { kind: "age", age } };
          flagIfClamped(e.target, age);
        }
      }
      else if (sub === "agentFeesPct") p.sale = { ...p.sale, agentFeesPct: clampNumber(v, 0, 10) };
      else if (sub === "settlementCosts") p.sale = { ...p.sale, settlementCosts: clampNumber(v, 0) };
      else if (sub === "proceedsDestination") p.sale = { ...p.sale, proceedsDestination: v };
      else if (sub === "assetId") p.sale = { ...p.sale, assetId: v || null };
    } else if (group === "mainResidence") {
      // Main residence exemption and the six-year absence rule (spec
      // 19 Commit 5) — engine/model-complete since that commit; this
      // is the input UI it never got. movedOutEnabled/movedBackInEnabled
      // are UI-only toggles (there's no stored "enabled" flag — presence
      // of the DateRef itself is the model's own on/off switch).
      if (sub === "movedOutEnabled") {
        p.mainResidence = e.target.checked
          ? { ...p.mainResidence, movedOutAt: { kind: "age", age: state.plan.client.currentAge } }
          : { movedOutAt: null, producingIncome: false, movedBackInAt: null };
      } else if (sub === "movedOutAt") {
        if (e.target.dataset.drRole === "anchor") {
          p.mainResidence = { ...p.mainResidence, movedOutAt: v === "__age__"
            ? { kind: "age", age: resolveRef(p.mainResidence.movedOutAt, state.plan, projection.schedule, "client").age }
            : { kind: "anchor", anchorId: v } };
        } else {
          const age = clampInt(v, state.plan.client.currentAge, state.plan.endAge);
          p.mainResidence = { ...p.mainResidence, movedOutAt: { kind: "age", age } };
          flagIfClamped(e.target, age);
        }
      }
      else if (sub === "producingIncome") p.mainResidence = { ...p.mainResidence, producingIncome: e.target.checked };
      else if (sub === "movedBackInEnabled") {
        const movedOutAge = resolveRef(p.mainResidence.movedOutAt, state.plan, projection.schedule, "client").age;
        p.mainResidence = { ...p.mainResidence, movedBackInAt: e.target.checked ? { kind: "age", age: movedOutAge } : null };
      } else if (sub === "movedBackInAt") {
        if (e.target.dataset.drRole === "anchor") {
          p.mainResidence = { ...p.mainResidence, movedBackInAt: v === "__age__"
            ? { kind: "age", age: resolveRef(p.mainResidence.movedBackInAt, state.plan, projection.schedule, "client").age }
            : { kind: "anchor", anchorId: v } };
        } else {
          const age = clampInt(v, state.plan.client.currentAge, state.plan.endAge);
          p.mainResidence = { ...p.mainResidence, movedBackInAt: { kind: "age", age } };
          flagIfClamped(e.target, age);
        }
      }
    }
  }
  state.properties = normaliseProperties(state.properties, state.plan, state.assets);
  state.liabilities = normaliseLiabilities(state.liabilities, state.plan, state.assets, state.properties);
  applyLiabilityLinkDerivations(state.liabilities, state.properties, state.plan, projection.schedule); // linked commencedOn/deductiblePct may change
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
    state.properties = normaliseProperties(state.properties, state.plan, state.assets);
    state.liabilities = normaliseLiabilities(state.liabilities, state.plan, state.assets, state.properties);
  }
  applyLiabilityLinkDerivations(state.liabilities, state.properties, state.plan, projection.schedule);
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

      <div class="cf-section">
        <div class="cf-section-title">Insurance premium ${tooltipHTML("A direct reduction to this account's balance every year — not a withdrawal, not assessable income. Reduces the taxable and tax-free components proportionally. Premiums paid OUTSIDE super are an ordinary expense row instead. Fund-level tax deductibility for TPD/income protection premiums is not modelled.")}</div>
        <div class="alloc-grid alloc-grid-profile">
          <div class="cf-cell">
            <label>Amount ($/yr, today's)</label>
            <input type="number" min="0" step="100" value="${sa.insurancePremium.amount}"
                   data-said="${sa.id}" data-sfield="insurancePremium.amount" />
          </div>
          <div class="cf-cell">
            <label>Index basis</label>
            <select data-said="${sa.id}" data-sfield="insurancePremium.indexBasis">
              <option value="none"${sa.insurancePremium.indexBasis === "none" ? " selected" : ""}>None</option>
              <option value="cpi"${sa.insurancePremium.indexBasis === "cpi" ? " selected" : ""}>CPI</option>
              <option value="awote"${sa.insurancePremium.indexBasis === "awote" ? " selected" : ""}>Wage index (AWOTE)</option>
            </select>
          </div>
          <div class="cf-cell">
            <label>+ extra % p.a. (default 3 — premiums typically outrun CPI)</label>
            <input type="number" min="-10" max="10" step="0.1" value="${sa.insurancePremium.indexExtraPct}"
                   data-said="${sa.id}" data-sfield="insurancePremium.indexExtraPct" />
          </div>
        </div>
      </div>

      ${isCouple() ? `
      <div class="cf-section">
        <div class="cf-section-title">Contribution splitting ${tooltipHTML("An annual election: moves this % of THIS account's own net concessional contributions from the PRIOR financial year to the owner's spouse's default super account. Legal ceiling 85% (contributions tax already claims the rest). Moves balance only — it is not a new contribution and does not affect either person's contribution cap.")}</div>
        <div class="alloc-grid alloc-grid-profile">
          <div class="cf-cell">
            <label>% of prior FY's concessional contributions split to spouse</label>
            <input type="number" min="0" max="85" step="1" value="${sa.contributionSplitPct}"
                   data-said="${sa.id}" data-sfield="contributionSplitPct" />
          </div>
        </div>
      </div>
      ` : ""}
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

// Super rollovers (spec 26, Commit 1; UI: spec 27 Commit 1) — moves
// balance and components between two of the SAME owner's own accounts
// (never cross-spouse — the FROM account's own owner IS the row's
// owner, so there's no separate owner select to show or edit). Where
// the source is untaxed and destination taxed, 15% tax applies on the
// untaxed element AT ROLLOVER — surfaced live here ("should I roll West
// State into an accumulation fund" is the live question and the tax is
// the answer, per the spec's own words), a plain estimate BEFORE any
// lifetime cap (the untaxed plan cap's 47%-above-cap branch is not
// replicated here — see the helper note).
function superRolloverEstimatedTax(sr) {
  const from = findSuperAccount(sr.fromAccountId);
  if (!from || from.taxedStatus !== "untaxed" || !(from.balance > 0)) return 0;
  const untaxedFraction = Math.max(0, from.balance - (from.taxFreeComponent ?? 0)) / from.balance;
  const amount = sr.amount == null ? from.balance : Math.min(sr.amount, from.balance);
  return amount * untaxedFraction * 0.15;
}

function superRolloverRowHTML(sr) {
  const from = findSuperAccount(sr.fromAccountId);
  const tax = superRolloverEstimatedTax(sr);
  return `
    <tr class="cf-tr" data-cfid="${sr.id}">
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(sr.label)}" maxlength="60"
               data-kind="superRollovers" data-cfid="${sr.id}" data-field="label" />
      </td>
      <td class="cf-td-account">
        <select data-kind="superRollovers" data-cfid="${sr.id}" data-field="fromAccountId">${superAccountOptions(sr.fromAccountId, null)}</select>
      </td>
      <td class="cf-td-account">
        <select data-kind="superRollovers" data-cfid="${sr.id}" data-field="toAccountId">${superAccountOptions(sr.toAccountId, from?.owner ?? null)}</select>
      </td>
      <td class="cf-td-amount">
        <input type="number" min="0" step="1000" value="${sr.amount ?? ""}" placeholder="Whole balance"
               data-kind="superRollovers" data-cfid="${sr.id}" data-field="rolloverAmount" />
      </td>
      <td class="cf-td-date">${dateRefControlHTML(sr.at, "client", `data-kind="superRollovers" data-cfid="${sr.id}" data-field="at"`, 18, 120)}</td>
      <td class="cf-td-detail">${tax > 0 ? fmtMoney(tax) : "—"}</td>
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-action="remove-row" data-kind="superRollovers" data-cfid="${sr.id}">×</button>
      </td>
    </tr>
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
      ${ffSubsectionHTML("Rollovers", "superRollovers", "Add rollover", cfHeaders.superRollovers(),
        (cf.superRollovers ?? []).map(superRolloverRowHTML).join(""))}
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
    // Insurance premiums inside super (spec 19 Commit 7).
    case "insurancePremium.amount":
      sa.insurancePremium.amount = clampNumber(el.value, 0);
      if (commit) el.value = sa.insurancePremium.amount;
      return false;
    case "insurancePremium.indexBasis":
      if (INDEX_BASES.includes(el.value)) sa.insurancePremium.indexBasis = el.value;
      return false;
    case "insurancePremium.indexExtraPct":
      sa.insurancePremium.indexExtraPct = clampNumber(el.value, -10, 10);
      if (commit) el.value = sa.insurancePremium.indexExtraPct;
      return false;
    // Contribution splitting (spec 19 Commit 6 completion) — the input
    // only renders for a couple (superAccountCardHTML), but clamped
    // here too rather than trusted, same belt-and-braces as every other
    // field this function handles.
    case "contributionSplitPct":
      sa.contributionSplitPct = clampNumber(el.value, 0, 85);
      if (commit) el.value = sa.contributionSplitPct;
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
      // A pension sourced from this account survives (it's a projected
      // income stream, not tied to the account's continued existence
      // the way a contribution/withdrawal row is) but drops the now-
      // dangling reference — same convention as clampPension itself.
      for (const pn of state.plan.pensions ?? []) if (pn.sourceAccountId === said) pn.sourceAccountId = null;
      collapsed.delete(said);
      volBasisTouched.delete(said);
      saveState();
      refreshOutputs();
      renderSuper();
      renderPensions();
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

// --- pension section (spec 20, Commit 5) ------------------------------------
//
// Cards mirror the super-account/liability card shape (a .pcard per
// row, direct-mutate-then-saveState, same as els.superSection above) —
// not the .cf-tr table-row machinery (applyRowEdit/rowHTMLFor), which
// is shaped around cashflow rows and their owner/date semantics.
// commenceAt gets the full DateRef anchor control (spec's own words);
// each commutation's `at` gets the simpler plain-age control every
// other one-off sub-row (liability lump-sum repayments, goals) uses.

function findPension(pid) {
  return (state.plan.pensions ?? []).find((p) => p.id === pid) || null;
}

function pensionHeadMeta(pn) {
  const ownerLabel = pn.owner === "partner" ? partnerName() : clientName();
  const typeLabel = pn.type === "ttr" ? "Transition to retirement" : "Account-based pension";
  const drawdownLabel = { minimum: "Minimum", fixed: "Fixed amount", expenditure: "Expenditure-linked", maximum: "Maximum (10%)" }[pn.drawdownOption] ?? pn.drawdownOption;
  return `${ownerLabel} · ${typeLabel} · ${drawdownLabel} drawdown`;
}

function pensionAllocationSectionHTML(pn) {
  const alloc = pn.allocation;
  const isCustom = alloc.mode === "custom";
  const seg = `
    <div class="seg-toggle" role="radiogroup" aria-label="Allocation mode">
      <button class="seg-option${!isCustom ? " active" : ""}" type="button"
              data-pension-action="alloc-mode" data-pid="${pn.id}" data-mode="profile"
              aria-pressed="${!isCustom}">Firm profile</button>
      <button class="seg-option${isCustom ? " active" : ""}" type="button"
              data-pension-action="alloc-mode" data-pid="${pn.id}" data-mode="custom"
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
            <select data-pid="${pn.id}" data-pfield="alloc.profile">${profileOptions(alloc.profile)}</select>
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
                 data-pid="${pn.id}" data-pfield="alloc.incomePct" />
        </div>
        <div class="cf-cell">
          <label>Growth (% p.a.)</label>
          <input type="number" min="0" max="${ALLOC_PCT_MAX}" step="0.05" value="${alloc.growthPct}"
                 data-pid="${pn.id}" data-pfield="alloc.growthPct" />
        </div>
        <div class="cf-cell">
          <label>Franking (%)</label>
          <input type="number" min="0" max="100" step="1" value="${alloc.frankingPct}"
                 data-pid="${pn.id}" data-pfield="alloc.frankingPct" />
        </div>
        <div class="cf-cell alloc-total">
          <label>&nbsp;</label>
          <div class="alloc-total-value" data-role="pensionAllocTotal-${pn.id}">Total: ${total}% p.a. nominal</div>
        </div>
      </div>
      <div class="alloc-grid alloc-grid-vol">
        <div class="cf-cell">
          <label>Volatility basis</label>
          <select data-pid="${pn.id}" data-pfield="alloc.volBasis">${profileOptions(alloc.volBasis)}</select>
        </div>
      </div>
    </div>
  `;
}

function commutationRowHTML(pid, c) {
  const age = c.at.kind === "age" ? c.at.age : resolveRef(c.at, state.plan, projection.schedule, "client").age;
  return `
    <tr class="cf-tr">
      <td class="cf-td-label">
        <input type="text" value="${escapeHTML(c.label)}" maxlength="40" data-pid="${pid}" data-cmid="${c.id}" data-cmfield="label" />
      </td>
      <td class="cf-td-amount">
        <input type="number" min="0" step="1000" value="${c.amount ?? ""}" placeholder="Whole balance"
               data-pid="${pid}" data-cmid="${c.id}" data-cmfield="amount" />
      </td>
      <td class="cf-td-date">
        <input type="number" min="${state.plan.client.currentAge}" max="${state.plan.endAge}" step="1"
               value="${age}" aria-label="At age" data-pid="${pid}" data-cmid="${c.id}" data-cmfield="atAge" />
      </td>
      <td class="cf-td-basis">
        <select data-pid="${pid}" data-cmid="${c.id}" data-cmfield="destination">
          ${COMMUTATION_DESTINATIONS.map((d) => `<option value="${d}"${c.destination === d ? " selected" : ""}>${d === "cash" ? "To cash" : "Back to super"}</option>`).join("")}
        </select>
      </td>
      <td class="cf-td-remove">
        <button class="cf-remove" type="button" aria-label="Remove row"
                data-pension-action="remove-commutation" data-pid="${pid}" data-cmid="${c.id}">×</button>
      </td>
    </tr>
  `;
}

function pensionCommutationsHTML(pn) {
  return `
    <div class="cf-subsection">
      <div class="cf-section-title">Commutations ${tooltipHTML("A partial or full lump-sum withdrawal, paid in the pension's fixed tax-free/taxable proportions and debited from the transfer balance account. Leave the amount blank for the whole remaining balance — a full commutation closes the pension.")}</div>
      ${(pn.commutations ?? []).length === 0 ? "" : `
        <table class="cf-table">
          <thead><tr><th>Label</th><th>Amount</th><th>At (age)</th><th>Destination</th><th></th></tr></thead>
          <tbody>${pn.commutations.map((c) => commutationRowHTML(pn.id, c)).join("")}</tbody>
        </table>
      `}
      <button class="add-row-btn" type="button" data-pension-action="add-commutation" data-pid="${pn.id}">+ Add commutation</button>
    </div>
  `;
}

function pensionCardHTML(pn) {
  const account = findSuperAccount(pn.sourceAccountId);
  return `
    <div class="pcard" data-pid="${pn.id}">
      <div class="pcard-head">
        <span class="pcard-name">${escapeHTML(pn.name)}</span>
        <span class="pcard-meta">${pensionHeadMeta(pn)}</span>
        <button class="pcard-remove" type="button" data-pension-action="remove" data-pid="${pn.id}">Remove</button>
      </div>
      <div class="pcard-body">
        <div class="person-grid">
          <div class="cf-cell">
            <label>Name</label>
            <input type="text" maxlength="60" value="${escapeHTML(pn.name)}" data-pid="${pn.id}" data-pfield="name" />
          </div>
          ${isCouple() ? `
            <div class="cf-cell">
              <label>Owner</label>
              <select data-pid="${pn.id}" data-pfield="owner">${superOwnerOptions(pn.owner)}</select>
            </div>
          ` : ""}
          <div class="cf-cell">
            <label>Source super account</label>
            <select data-pid="${pn.id}" data-pfield="sourceAccountId">${superAccountOptions(pn.sourceAccountId, pn.owner)}</select>
            ${!account ? `<p class="helper-text">No super account for this owner yet — add one under Super first.</p>` : ""}
          </div>
          <div class="cf-cell">
            <label>Type</label>
            <select data-pid="${pn.id}" data-pfield="type">
              <option value="abp"${pn.type === "abp" ? " selected" : ""}>Account-based pension</option>
              <option value="ttr"${pn.type === "ttr" ? " selected" : ""}>Transition to retirement</option>
            </select>
          </div>
          <div class="cf-cell">
            <label>Commencement</label>
            ${dateRefControlHTML(pn.commenceAt, "client", `data-pid="${pn.id}" data-pfield="commenceAt"`, state.plan.client.currentAge, state.plan.endAge)}
          </div>
          <div class="cf-cell">
            <label>Commencement amount ($, blank = whole balance)</label>
            <input type="number" min="0" step="1000" value="${pn.commenceAmount ?? ""}" placeholder="Whole balance"
                   data-pid="${pn.id}" data-pfield="commenceAmount" />
          </div>
          <div class="cf-cell">
            <label class="ptg-check">
              <input type="checkbox"${pn.reversionary ? " checked" : ""} data-pid="${pn.id}" data-pfield="reversionary" />
              <span>Reversionary nomination</span>
            </label>
            <p class="helper-text">Flag only — survivor consequences are not modelled.</p>
          </div>
        </div>

        ${pensionAllocationSectionHTML(pn)}

        <div class="cf-section">
          <div class="cf-section-title">Costs</div>
          <div class="alloc-grid alloc-grid-profile">
            <div class="cf-cell">
              <label>ICR (% p.a.)</label>
              <input type="number" min="0" max="100" step="0.01" value="${pn.icrPct}"
                     data-pid="${pn.id}" data-pfield="icrPct" />
            </div>
          </div>
        </div>

        <div class="cf-section">
          <div class="cf-section-title">Drawdown</div>
          <div class="alloc-grid alloc-grid-profile">
            <div class="cf-cell">
              <label>Option</label>
              <select data-pid="${pn.id}" data-pfield="drawdownOption">
                <option value="minimum"${pn.drawdownOption === "minimum" ? " selected" : ""}>Minimum</option>
                <option value="fixed"${pn.drawdownOption === "fixed" ? " selected" : ""}>Fixed amount</option>
                <option value="expenditure"${pn.drawdownOption === "expenditure" ? " selected" : ""}>Fund expenditure shortfall</option>
                ${pn.type === "ttr" ? `<option value="maximum"${pn.drawdownOption === "maximum" ? " selected" : ""}>Maximum (10% p.a.)</option>` : ""}
              </select>
            </div>
          </div>
          ${pn.drawdownOption === "fixed" ? `
            <div class="alloc-grid alloc-grid-profile">
              <div class="cf-cell">
                <label>Amount ($/yr, today's)</label>
                <input type="number" min="0" step="100" value="${pn.fixedAmount}"
                       data-pid="${pn.id}" data-pfield="fixedAmount" />
              </div>
              <div class="cf-cell">
                <label>Index basis</label>
                <select data-pid="${pn.id}" data-pfield="indexBasis">
                  <option value="none"${pn.indexBasis === "none" ? " selected" : ""}>None</option>
                  <option value="cpi"${pn.indexBasis === "cpi" ? " selected" : ""}>CPI</option>
                  <option value="awote"${pn.indexBasis === "awote" ? " selected" : ""}>Wage index (AWOTE)</option>
                </select>
              </div>
              <div class="cf-cell">
                <label>+ extra % p.a.</label>
                <input type="number" min="-10" max="10" step="0.1" value="${pn.indexExtraPct}"
                       data-pid="${pn.id}" data-pfield="indexExtraPct" />
              </div>
            </div>
          ` : ""}
          <p class="helper-text">The minimum drawdown always applies as a floor under any other option — a fixed amount, expenditure top-up, or (TTR only) the 10% maximum will always pay out at least the age-based minimum.</p>
        </div>

        ${pensionCommutationsHTML(pn)}
      </div>
    </div>
  `;
}

function renderPensions() {
  const pensions = state.plan.pensions ?? [];
  const cards = pensions.map(pensionCardHTML).join("");
  const pensionBlock = cards === ""
    ? pageEmptyHTML(
        "Commence an account-based pension or transition-to-retirement income stream from an existing super account.",
        `<button class="add-row-btn" type="button" data-pension-action="add">+ Add pension</button>`
      )
    : `
      <div id="pensions" class="portfolio-stack">${cards}</div>
      <div class="portfolio-actions">
        <button class="btn-text" type="button" data-pension-action="add">+ Add pension</button>
      </div>
    `;
  // Defined benefit pensions (spec 26; UI: spec 27 Commit 1) — a kind
  // of pension, not a separate sidebar entry (spec's own words), shown
  // as its own subsection beneath ABP/TTR cards so its very different
  // shape (no source account, no allocation/drawdown) doesn't get
  // squeezed into that card's fields.
  const definedBenefits = state.plan.definedBenefits ?? [];
  const dbCards = definedBenefits.map(definedBenefitCardHTML).join("");
  const dbBlock = dbCards === ""
    ? pageEmptyHTML(
        "Add a defined benefit pension — a WA state-scheme pension (GESB Gold State Super and similar) the client's own annual statement states, not something derived from a modelled account.",
        `<button class="add-row-btn" type="button" data-defined-benefit-action="add">+ Add defined benefit pension</button>`
      )
    : `
      <div id="definedBenefits" class="portfolio-stack">${dbCards}</div>
      <div class="portfolio-actions">
        <button class="btn-text" type="button" data-defined-benefit-action="add">+ Add defined benefit pension</button>
      </div>
    `;
  els.pensionSection.innerHTML = `
    <h2 class="section-heading">Pension</h2>
    ${pensionBlock}
    <div class="cf-section-title" style="margin-top:24px">Defined benefit</div>
    ${dbBlock}
  `;
}

// Applies a simple (non-structural) field edit to a pension. Returns
// true when the change is structural (needs a full card re-render —
// owner/type switches change dependent select options and visibility).
function applyPensionEdit(pn, field, el, commit) {
  switch (field) {
    case "name":
      pn.name = commit ? (el.value.trim() || pn.name) : el.value;
      if (commit) el.value = pn.name;
      return false;
    case "owner": {
      if (!["client", "partner"].includes(el.value)) return false;
      pn.owner = el.value;
      // The source account may not belong to the new owner — same
      // "drop the now-invalid reference, row survives" convention as
      // clampPension itself (planState.js).
      const acctOwner = findSuperAccount(pn.sourceAccountId)?.owner;
      if (acctOwner !== pn.owner) pn.sourceAccountId = null;
      return true;
    }
    case "sourceAccountId":
      if ((state.plan.superAccounts ?? []).some((s) => s.id === el.value)) pn.sourceAccountId = el.value;
      else if (el.value === "") pn.sourceAccountId = null;
      return false;
    case "type": {
      if (!PENSION_TYPES.includes(el.value)) return false;
      pn.type = el.value;
      // "maximum" is TTR-only (planState.js's clampPension) — reset
      // rather than leave a combination this tool can't legally model.
      if (pn.type !== "ttr" && pn.drawdownOption === "maximum") pn.drawdownOption = "minimum";
      return true;
    }
    case "commenceAmount":
      pn.commenceAmount = el.value === "" ? null : clampNumber(el.value, 0);
      if (commit) el.value = pn.commenceAmount ?? "";
      return false;
    case "reversionary":
      pn.reversionary = el.checked;
      return false;
    case "icrPct":
      pn.icrPct = clampNumber(el.value, 0, 100);
      if (commit) el.value = pn.icrPct;
      return false;
    case "drawdownOption": {
      if (!PENSION_DRAWDOWN_OPTIONS.includes(el.value)) return false;
      if (el.value === "maximum" && pn.type !== "ttr") return false; // not offered by the select for an ABP, belt-and-braces
      pn.drawdownOption = el.value;
      return true;
    }
    case "fixedAmount":
      pn.fixedAmount = clampNumber(el.value, 0);
      if (commit) el.value = pn.fixedAmount;
      return false;
    case "indexBasis":
      if (INDEX_BASES.includes(el.value)) pn.indexBasis = el.value;
      return false;
    case "indexExtraPct":
      pn.indexExtraPct = clampNumber(el.value, -10, 10);
      if (commit) el.value = pn.indexExtraPct;
      return false;
    case "alloc.profile":
      pn.allocation = clampAllocation({ mode: "profile", profile: el.value }, PROFILES);
      return false;
    case "alloc.incomePct":
      pn.allocation.incomePct = clampNumber(el.value, 0, ALLOC_PCT_MAX);
      if (commit) el.value = pn.allocation.incomePct;
      refreshPensionAllocTotal(pn.id);
      return false;
    case "alloc.growthPct":
      pn.allocation.growthPct = clampNumber(el.value, 0, ALLOC_PCT_MAX);
      if (commit) el.value = pn.allocation.growthPct;
      refreshPensionAllocTotal(pn.id);
      return false;
    case "alloc.frankingPct":
      pn.allocation.frankingPct = clampNumber(el.value, 0, 100);
      if (commit) el.value = pn.allocation.frankingPct;
      return false;
    case "alloc.volBasis":
      if (Object.keys(PROFILES).includes(el.value)) pn.allocation.volBasis = el.value;
      return false;
    default:
      return false;
  }
}

function refreshPensionAllocTotal(pid) {
  const pn = findPension(pid);
  if (!pn || pn.allocation.mode !== "custom") return;
  const elTotal = document.querySelector(`[data-role="pensionAllocTotal-${pid}"]`);
  if (elTotal) elTotal.textContent = `Total: ${(pn.allocation.incomePct + pn.allocation.growthPct).toFixed(2)}% p.a. nominal`;
}

// --- defined benefit pensions (spec 27, Commit 1) ---------------------------
//
// A kind of pension (spec's own words) — lives in the SAME Pensions
// section as ABP/TTR cards, not a separate sidebar entry, but as its
// own card shape (no source account, no allocation/drawdown — a
// promised pension the client's own statement states, per spec 26's
// own scoping principle) sharing the section's direct-mutate-then-
// saveState convention via data-dbid/data-dbfield instead of
// data-pid/data-pfield.
function findDefinedBenefit(dbid) {
  return (state.plan.definedBenefits ?? []).find((d) => d.id === dbid) || null;
}

function definedBenefitHeadMeta(db) {
  const ownerLabel = db.owner === "partner" ? partnerName() : clientName();
  return `${ownerLabel} · ${fmtMoney(db.annualPension)} p.a.`;
}

// The 16× transfer balance credit, visible at the point of entry — "an
// adviser needs to see it before they are surprised by it in a table"
// (spec's own words). Mirrors deterministic.js's own creditTransferBalance
// call at commencement (annualPension × 16, the pension's special
// value) exactly — never the pension amount itself.
function definedBenefitTbaNoteHTML(db) {
  const special = db.annualPension * 16;
  return `<p class="helper-text">${fmtMoney(db.annualPension)} pa uses ${fmtMoney(special)} of the transfer balance cap — a defined benefit pension credits at 16× the annual pension (its "special value"), not the pension amount itself.</p>`;
}

function definedBenefitCardHTML(db) {
  const taxFreeHeadroom = 100 - db.taxFreeProportion;
  return `
    <div class="pcard" data-dbid="${db.id}">
      <div class="pcard-head">
        <span class="pcard-name">${escapeHTML(db.name)}</span>
        <span class="pcard-meta">${definedBenefitHeadMeta(db)}</span>
        <button class="pcard-remove" type="button" data-defined-benefit-action="remove" data-dbid="${db.id}">Remove</button>
      </div>
      <div class="pcard-body">
        <div class="person-grid">
          <div class="cf-cell">
            <label>Name</label>
            <input type="text" maxlength="60" value="${escapeHTML(db.name)}" data-dbid="${db.id}" data-dbfield="name" />
          </div>
          ${isCouple() ? `
            <div class="cf-cell">
              <label>Owner</label>
              <select data-dbid="${db.id}" data-dbfield="owner">${superOwnerOptions(db.owner)}</select>
            </div>
          ` : ""}
          <div class="cf-cell">
            <label>Commencement</label>
            ${dateRefControlHTML(db.commenceAt, "client", `data-dbid="${db.id}" data-dbfield="commenceAt"`, state.plan.client.currentAge, state.plan.endAge)}
          </div>
          <div class="cf-cell">
            <label>Annual pension ($/yr, today's)</label>
            <input type="number" min="0" step="1000" value="${db.annualPension}" data-dbid="${db.id}" data-dbfield="annualPension" />
          </div>
          <div class="cf-cell">
            <label>Index basis</label>
            <select data-dbid="${db.id}" data-dbfield="indexBasis">
              <option value="none"${db.indexBasis === "none" ? " selected" : ""}>None</option>
              <option value="cpi"${db.indexBasis === "cpi" ? " selected" : ""}>CPI</option>
              <option value="awote"${db.indexBasis === "awote" ? " selected" : ""}>Wage index (AWOTE)</option>
            </select>
          </div>
          <div class="cf-cell">
            <label>+ extra % p.a.</label>
            <input type="number" min="-10" max="10" step="0.1" value="${db.indexExtraPct}" data-dbid="${db.id}" data-dbfield="indexExtraPct" />
          </div>
        </div>
        ${definedBenefitTbaNoteHTML(db)}
        <div class="cf-section">
          <div class="cf-section-title">Tax components</div>
          <div class="alloc-grid alloc-grid-profile">
            <div class="cf-cell">
              <label>Tax-free proportion (%)</label>
              <input type="number" min="0" max="100" step="0.1" value="${db.taxFreeProportion}" data-dbid="${db.id}" data-dbfield="taxFreeProportion" />
            </div>
            <div class="cf-cell">
              <label>Untaxed proportion (%, ≤ ${taxFreeHeadroom} remaining)</label>
              <input type="number" min="0" max="${taxFreeHeadroom}" step="0.1" value="${db.untaxedProportion}" data-dbid="${db.id}" data-dbfield="untaxedProportion" />
            </div>
          </div>
          <p class="helper-text">The remainder (${(100 - db.taxFreeProportion - db.untaxedProportion).toFixed(1)}%) is the taxed element — tax-free from age 60. The untaxed proportion is assessable at the marginal rate with a 10% offset — a different rate from an untaxed lump sum's 15%.</p>
        </div>
        <div class="cf-section">
          <div class="cf-section-title">Other</div>
          <div class="alloc-grid alloc-grid-profile">
            ${isCouple() ? `
              <div class="cf-cell">
                <label>Reversionary (%, to spouse on death)</label>
                <input type="number" min="0" max="100" step="1" value="${db.reversionaryPct}" data-dbid="${db.id}" data-dbfield="reversionaryPct" />
              </div>
            ` : ""}
            <div class="cf-cell">
              <label>Notional taxed contributions ($/yr)</label>
              <input type="number" min="0" step="500" value="${db.notionalTaxedContributions}" data-dbid="${db.id}" data-dbfield="notionalTaxedContributions" />
            </div>
          </div>
          <p class="helper-text">Notional taxed contributions count toward the concessional cap while still an accruing member (before this pension's own commencement) — from the member's own annual statement.</p>
        </div>
      </div>
    </div>
  `;
}

// Applies a simple (non-structural) field edit to a defined benefit
// pension. Returns true when the change needs a full card re-render
// (owner switch changes select options; the two proportions each
// constrain the other's live max).
function applyDefinedBenefitEdit(db, field, el, commit) {
  switch (field) {
    case "name":
      db.name = commit ? (el.value.trim() || db.name) : el.value;
      if (commit) el.value = db.name;
      return false;
    case "owner":
      if (["client", "partner"].includes(el.value)) db.owner = el.value;
      return true;
    case "annualPension":
      db.annualPension = clampNumber(el.value, 0);
      if (commit) el.value = db.annualPension;
      return true; // the visible 16× TBA note depends on this
    case "indexBasis":
      if (INDEX_BASES.includes(el.value)) db.indexBasis = el.value;
      return false;
    case "indexExtraPct":
      db.indexExtraPct = clampNumber(el.value, -10, 10);
      if (commit) el.value = db.indexExtraPct;
      return false;
    case "taxFreeProportion":
      db.taxFreeProportion = clampNumber(el.value, 0, 100);
      db.untaxedProportion = Math.min(db.untaxedProportion, 100 - db.taxFreeProportion);
      return true; // untaxed's own max headroom label needs a refresh
    case "untaxedProportion":
      db.untaxedProportion = clampNumber(el.value, 0, 100 - db.taxFreeProportion);
      if (commit) el.value = db.untaxedProportion;
      return false;
    case "reversionaryPct":
      db.reversionaryPct = clampNumber(el.value, 0, 100);
      if (commit) el.value = db.reversionaryPct;
      return false;
    case "notionalTaxedContributions":
      db.notionalTaxedContributions = clampNumber(el.value, 0);
      if (commit) el.value = db.notionalTaxedContributions;
      return false;
    default:
      return false;
  }
}

els.pensionSection.addEventListener("input", (e) => {
  const dbid = e.target.dataset.dbid;
  const dbfield = e.target.dataset.dbfield;
  if (dbid && dbfield && !e.target.dataset.drRole) {
    const db = findDefinedBenefit(dbid);
    if (db) { applyDefinedBenefitEdit(db, dbfield, e.target, false); saveState(); refreshOutputs(); }
    return;
  }
  const pid = e.target.dataset.pid;
  const field = e.target.dataset.pfield;
  if (!pid || !field || e.target.dataset.drRole) return; // DateRef control handled on "change" only
  const pn = findPension(pid);
  if (!pn) return;
  applyPensionEdit(pn, field, e.target, false);
  saveState();
  refreshOutputs();
});

els.pensionSection.addEventListener("change", (e) => {
  const dbid = e.target.dataset.dbid;
  const dbfield = e.target.dataset.dbfield;
  if (dbid && dbfield === "commenceAt" && e.target.dataset.drRole) {
    const db = findDefinedBenefit(dbid);
    if (!db) return;
    if (e.target.dataset.drRole === "anchor") {
      db.commenceAt = e.target.value === "__age__"
        ? { kind: "age", age: resolveRef(db.commenceAt, state.plan, projection.schedule, "client").age }
        : { kind: "anchor", anchorId: e.target.value };
    } else {
      db.commenceAt = { kind: "age", age: clampInt(e.target.value, state.plan.client.currentAge, state.plan.endAge) };
    }
    saveState();
    refreshOutputs();
    renderPensions();
    return;
  }
  if (dbid && dbfield) {
    const db = findDefinedBenefit(dbid);
    if (!db) return;
    const structural = applyDefinedBenefitEdit(db, dbfield, e.target, true);
    saveState();
    refreshOutputs();
    if (structural) renderPensions();
    return;
  }
  const pid = e.target.dataset.pid;
  const field = e.target.dataset.pfield;
  if (pid && field === "commenceAt" && e.target.dataset.drRole) {
    const pn = findPension(pid);
    if (!pn) return;
    if (e.target.dataset.drRole === "anchor") {
      pn.commenceAt = e.target.value === "__age__"
        ? { kind: "age", age: resolveRef(pn.commenceAt, state.plan, projection.schedule, "client").age }
        : { kind: "anchor", anchorId: e.target.value };
    } else {
      pn.commenceAt = { kind: "age", age: clampInt(e.target.value, state.plan.client.currentAge, state.plan.endAge) };
    }
    saveState();
    refreshOutputs();
    renderPensions();
    return;
  }
  if (pid && field) {
    const pn = findPension(pid);
    if (!pn) return;
    const structural = applyPensionEdit(pn, field, e.target, true);
    saveState();
    refreshOutputs();
    if (structural) renderPensions();
    return;
  }
  // Commutation sub-row fields.
  const cmid = e.target.dataset.cmid;
  const cmfield = e.target.dataset.cmfield;
  if (!pid || !cmid || !cmfield) return;
  const pn = findPension(pid);
  const c = pn?.commutations.find((x) => x.id === cmid);
  if (!c) return;
  if (cmfield === "label") c.label = e.target.value.trim() || c.label;
  else if (cmfield === "amount") c.amount = e.target.value === "" ? null : clampNumber(e.target.value, 0);
  else if (cmfield === "atAge") c.at = { kind: "age", age: clampInt(e.target.value, state.plan.client.currentAge, state.plan.endAge) };
  else if (cmfield === "destination") c.destination = COMMUTATION_DESTINATIONS.includes(e.target.value) ? e.target.value : "cash";
  else return;
  saveState();
  refreshOutputs();
});

els.pensionSection.addEventListener("click", (e) => {
  const dbBtn = e.target.closest("[data-defined-benefit-action]");
  if (dbBtn) {
    const dbAction = dbBtn.dataset.definedBenefitAction;
    if (dbAction === "add") {
      const owner = isCouple() && (state.plan.definedBenefits ?? []).some((d) => d.owner === "client") ? "partner" : "client";
      state.plan.definedBenefits = [...(state.plan.definedBenefits ?? []), createDefinedBenefit(state.plan, state.plan.definedBenefits ?? [], owner)];
    } else if (dbAction === "remove") {
      const db = findDefinedBenefit(dbBtn.dataset.dbid);
      if (!db || !window.confirm(`Remove "${db.name}"?`)) return;
      state.plan.definedBenefits = state.plan.definedBenefits.filter((x) => x.id !== db.id);
    } else {
      return;
    }
    saveState();
    refreshOutputs();
    renderPensions();
    return;
  }
  const btn = e.target.closest("[data-pension-action]");
  if (!btn) return;
  const action = btn.dataset.pensionAction;
  if (action === "add") {
    const owner = isCouple() && (state.plan.pensions ?? []).some((p) => p.owner === "client") ? "partner" : "client";
    state.plan.pensions = [...(state.plan.pensions ?? []), createPension(state.plan, state.plan.pensions ?? [], state.plan.superAccounts ?? [], owner)];
    saveState();
    refreshOutputs();
    renderPensions();
    return;
  }
  const pid = btn.dataset.pid;
  const pn = findPension(pid);
  if (!pn) return;
  if (action === "remove") {
    if (!window.confirm(`Remove "${pn.name}"?`)) return;
    state.plan.pensions = state.plan.pensions.filter((x) => x.id !== pid);
  } else if (action === "alloc-mode") {
    switchAllocMode(pn, btn.dataset.mode === "custom" ? "custom" : "profile");
  } else if (action === "add-commutation") {
    pn.commutations = [...(pn.commutations ?? []), createCommutation(state.plan, pn.commutations ?? [])];
  } else if (action === "remove-commutation") {
    pn.commutations = (pn.commutations ?? []).filter((x) => x.id !== btn.dataset.cmid);
  } else {
    return;
  }
  saveState();
  refreshOutputs();
  renderPensions();
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

// Input behaviour fix: once a liability is linked to a PROPERTY (not a
// plain asset — a property carries its own acquisition/purchase date
// and a propertyType, neither of which an asset has), commencedOn and
// deductiblePct derive from it, each stopping the moment the user
// edits it directly (commencementIsDefault/deductiblePctIsDefault).
// Lives in main.js, not clampLiability: resolving a planned property's
// purchaseAt (a DateRef) to a calendar date needs a built schedule
// (planYears/fyLabels), which the pure clamp pipeline never has access
// to (see keyDates.js's resolveRef).
function derivedLoanCommencementDate(prop, plan, schedule) {
  if (prop.status === "owned") return prop.acquisitionDate ?? null;
  const r = resolveRef(prop.purchaseAt, plan, schedule, "client");
  // Purchases settle in July of the purchase FY (locked convention).
  return `${firstFyStartYear(plan.start) + r.planYear}-07-01`;
}
function derivedLoanDeductiblePct(prop) {
  return prop.propertyType === "investment" ? 100 : 0;
}
function liabilityLinkReason(prop) {
  if (prop.propertyType === "investment") return "100% for an investment property";
  if (prop.propertyType === "holiday") return "0% for a holiday home";
  return "0% for a principal residence";
}

// Re-derives commencedOn/deductiblePct for every liability still
// tracking its linked property (a no-op for liabilities linked to a
// plain asset, or not linked, or already overridden) — called after
// any edit that could change a linked property's relevant fields
// (its own edits, or the liability's own linkedAssetId changing).
function applyLiabilityLinkDerivations(liabilities, properties, plan, schedule) {
  for (const l of liabilities ?? []) {
    const prop = (properties ?? []).find((p) => p.id === l.linkedAssetId);
    if (!prop) continue;
    if (l.commencementIsDefault) l.commencedOn = derivedLoanCommencementDate(prop, plan, schedule);
    if (l.deductiblePctIsDefault) l.deductiblePct = derivedLoanDeductiblePct(prop);
  }
  return liabilities;
}

function liabilityCardHTML(l) {
  const financialAssets = state.assets.filter((a) => a.class !== "lifestyle");
  const opt = (list, sel) => `<option value=""${!sel ? " selected" : ""}>None</option>` +
    list.map((a) => `<option value="${a.id}"${a.id === sel ? " selected" : ""}>${escapeHTML(a.name)}</option>`).join("");
  const linkedProp = (state.properties ?? []).find((p) => p.id === l.linkedAssetId);
  const linkOptions = `<option value=""${!l.linkedAssetId ? " selected" : ""}>None</option>` +
    ((state.properties ?? []).length ? `<optgroup label="Properties">${
      state.properties.map((p) => `<option value="${p.id}"${p.id === l.linkedAssetId ? " selected" : ""}>${escapeHTML(p.name)}</option>`).join("")
    }</optgroup>` : "") +
    (state.assets.length ? `<optgroup label="Assets">${
      state.assets.map((a) => `<option value="${a.id}"${a.id === l.linkedAssetId ? " selected" : ""}>${escapeHTML(a.name)}</option>`).join("")
    }</optgroup>` : "");
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
            <label>Interest deductible (%)${l.deductiblePctIsDefault && linkedProp ? ` ${tooltipHTML(describeDefault("liability.deductiblePct", { value: l.deductiblePct, reason: liabilityLinkReason(linkedProp) }))}` : ""}</label>
            <input type="number" min="0" max="100" step="1" value="${l.deductiblePct}" data-lid="${l.id}" data-lfield="deductiblePct" />
            <p class="helper-text">Deducts against ${l.owner === "joint" ? "both owners'" : "the owner's"} income — 100% for a fully investment loan, 0% for a home loan, or a part-way figure for a mixed-purpose loan.</p>
          </div>
          <div class="cf-cell">
            <label>Relates to / secured by</label>
            <select data-lid="${l.id}" data-lfield="linkedAssetId">${linkOptions}</select>
          </div>
          <div class="cf-cell">
            <label>Offset account</label>
            <select data-lid="${l.id}" data-lfield="offsetAssetId">${opt(financialAssets, l.offsetAssetId)}</select>
          </div>
          <div class="cf-cell">
            <label>Loan commenced (optional)${l.commencementIsDefault && linkedProp ? ` ${tooltipHTML(describeDefault("liability.commencementDate"))}` : ""}</label>
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
    else if (field === "deductiblePct") { l.deductiblePct = clampNumber(e.target.value, 0, 100); l.deductiblePctIsDefault = false; }
    else if (field === "linkedAssetId") l.linkedAssetId = e.target.value || null;
    else if (field === "offsetAssetId") l.offsetAssetId = e.target.value || null;
    // Fixed-rate rollover (Commit 1).
    else if (field === "fixedRatePct") l.fixedRatePct = clampNumber(e.target.value, 0, 30);
    else if (field === "fixedUntilAge") l.fixedUntil = { kind: "age", age: clampInt(e.target.value, state.plan.client.currentAge, state.plan.endAge) };
    // Blank clears back to "use the mortgage-rate assumption" — the
    // same override-or-default shape as dutyOverride/lmiOverride.
    else if (field === "revertRatePct") l.revertRatePct = e.target.value === "" ? null : clampNumber(e.target.value, 0, 30);
    else if (field === "commencedOn") { l.commencedOn = e.target.value || null; l.commencementIsDefault = false; }
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
  state.liabilities = normaliseLiabilities(state.liabilities, state.plan, state.assets, state.properties);
  applyLiabilityLinkDerivations(state.liabilities, state.properties, state.plan, projection.schedule);
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
  state.liabilities = normaliseLiabilities(state.liabilities, state.plan, state.assets, state.properties);
  applyLiabilityLinkDerivations(state.liabilities, state.properties, state.plan, projection.schedule);
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
let superEntity = "all"; // Super view entity selector: "all" | "client" | "partner" | super account id
let pensionEntity = "all"; // Pension view entity selector: "all" | pension id
let liabilitiesEntity = "all"; // Liabilities view entity selector: "all" | liability id
let bondsEntity = "all"; // Bonds view entity selector (spec 25, Commit 2): "all" | bond id

// Navigation, View Consolidation, and Simple Charts (spec 17), Commit 3
// — Client/Partner/Consolidated selectors, one module-level var per
// view (unpersisted, matching every existing entity selector above —
// none of them survive a reload either).
let cashflowPersonEntity = "all";
let taxPersonEntity = "all";
let agePensionPersonEntity = "all";
let allocationPersonEntity = "all";
let netAssetsPersonEntity = "all";
let keyFiguresPersonEntity = "all";
let snapshotPersonEntity = "all";

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
  "income-sources": () => els.viewIncomeSources,
  "expense-funding": () => els.viewExpenseFunding,
  "tax-by-type": () => els.viewTaxByType,
  "debt-vs-assets": () => els.viewDebtVsAssets,
  "super-vs-non-super": () => els.viewSuperVsNonSuper,
  "age-pension-chart": () => els.viewAgePensionChart,
  "key-figures": () => els.viewKeyFigures,
  cashflow: () => els.viewCashflow,
  assets: () => els.viewAssets,
  tax: () => els.viewTax,
  super: () => els.viewSuper,
  pension: () => els.viewPension,
  "age-pension-table": () => els.viewAgePensionTable,
  "death-benefits": () => els.viewDeathBenefits,
  liabilities: () => els.viewLiabilities,
  bonds: () => els.viewBonds,
  snapshot: () => els.viewSnapshot,
  "monte-carlo-table": () => els.viewMonteCarloTable,
  assumptions: () => els.viewAssumptions,
  "focus-deposit": () => els.viewFocusDeposit,
  "focus-fhsss": () => els.viewFocusFhsss,
  "focus-salary-sacrifice": () => els.viewFocusSalarySacrifice,
  "focus-debt-payoff": () => els.viewFocusDebtPayoff,
  "focus-debt-recycling": () => els.viewFocusDebtRecycling,
  "focus-education-funding": () => els.viewFocusEducationFunding,
  "focus-surplus-allocation": () => els.viewFocusSurplusAllocation,
  "focus-ppr-exemption": () => els.viewFocusPprExemption,
  "focus-age-pension": () => els.viewFocusAgePension,
  "focus-death-benefits": () => els.viewFocusDeathBenefits,
  "focus-lookups": () => els.viewFocusLookups,
  "focus-equity": () => els.viewFocusEquity,
  "focus-transfer-schedule": () => els.viewFocusTransferSchedule,
  "whatif-rate-shock": () => els.viewWhatIfRateShock,
  "whatif-crash": () => els.viewWhatIfCrash,
  "whatif-income-gap": () => els.viewWhatIfIncomeGap,
  "whatif-expense-shock": () => els.viewWhatIfExpenseShock,
};
const GRAPH_VIEWS = new Set([
  "projection", "composite", "net-assets", "asset-balances", "asset-allocation", "monte-carlo", "super-balances", "liabilities-balances", "cashflow-bars",
  "income-sources", "expense-funding", "tax-by-type", "debt-vs-assets", "super-vs-non-super", "age-pension-chart",
]);

// Selection now happens via the sidebar (data-nav-section), which
// routes through handleRoute → showSection → here.
function renderActiveView() {
  for (const [name, mount] of Object.entries(VIEW_MOUNTS)) {
    mount().hidden = name !== activeView;
  }
  renderOutputFormToggle();
  renderChartTypeSelect();
  renderAdjustmentsCountBadge();
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
  else if (activeView === "income-sources") renderIncomeSourcesChart();
  else if (activeView === "expense-funding") renderExpenseFundingChart();
  else if (activeView === "tax-by-type") renderTaxByTypeChart();
  else if (activeView === "debt-vs-assets") renderDebtVsAssetsChart();
  else if (activeView === "super-vs-non-super") renderSuperVsNonSuperChart();
  else if (activeView === "age-pension-chart") renderAgePensionChart();
  else if (activeView === "key-figures") renderKeyFiguresView();
  else if (activeView === "cashflow") renderCashflowView();
  else if (activeView === "assets") renderAssetsView();
  else if (activeView === "tax") renderTaxView();
  else if (activeView === "super") renderSuperTableView();
  else if (activeView === "pension") renderPensionTableView();
  else if (activeView === "death-benefits") renderDeathBenefitsTableView();
  else if (activeView === "age-pension-table") renderAgePensionTableView();
  else if (activeView === "liabilities") renderLiabilitiesView();
  else if (activeView === "bonds") renderBondsView();
  else if (activeView === "snapshot") renderSnapshotView();
  else if (activeView === "monte-carlo-table") renderMonteCarloTableView();
  else if (activeView === "assumptions") renderAssumptionsView();
  else if (activeView === "focus-deposit") renderFocusDepositView();
  else if (activeView === "focus-fhsss") renderFocusFhsssView();
  else if (activeView === "focus-salary-sacrifice") renderFocusSalarySacrificeView();
  else if (activeView === "focus-debt-payoff") renderFocusDebtPayoffView();
  else if (activeView === "focus-debt-recycling") renderFocusDebtRecyclingView();
  else if (activeView === "focus-education-funding") renderFocusEducationFundingView();
  else if (activeView === "focus-surplus-allocation") renderFocusSurplusAllocationView();
  else if (activeView === "focus-ppr-exemption") renderFocusPprExemptionView();
  else if (activeView === "focus-age-pension") renderFocusAgePensionView();
  else if (activeView === "focus-death-benefits") renderFocusDeathBenefitsView();
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
  const agePensionArea = scale(series.agePension);

  // Auto-hide series that are zero across every displayed period —
  // no legend entry, no bar slot. Net assets is the chart's anchor
  // (and axis reference) and is always drawn, even if zero.
  const hasSeparate = !seriesIsAllZero(sepArea);
  const hasIncome = !seriesIsAllZero(incomeArea);
  const hasDrawdown = !seriesIsAllZero(drawdownArea);
  const hasExpenditure = !seriesIsAllZero(expenditureArea);
  const hasAgePension = !seriesIsAllZero(agePensionArea);

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
  if (hasAgePension) {
    traces.push({
      x: ages, y: agePensionArea, name: "Age pension", type: "bar",
      marker: { color: "rgb(28, 150, 150)", opacity: 0.55 }, yaxis: "y2",
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Age pension</extra>",
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
  const stackTop = ages.map((_, i) =>
    (hasIncome ? incomeArea[i] : 0) + (hasAgePension ? agePensionArea[i] : 0) + (hasDrawdown ? drawdownArea[i] : 0));
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

// --- Net worth, per owner (spec 17 Commit 3) ---------------------------------
//
// A NEW derivation — the engine only ever computes the household total
// (row.netAssets). Financial/lifestyle assets, property, and ordinary
// liabilities carry an owner and split 50/50 when "joint", the same
// disclosed convention cashflowStatement.js's shareOf already uses for
// the Cashflow/Snapshot views. Super and HELP are never joint and split
// exactly. The Working Cash Account has NO owner anywhere in the
// ledger — deliberately excluded from the per-person figure rather than
// arbitrarily split or silently folded in (spec's own fallback: "show
// it in all three modes with a note"), so Client + Partner does NOT
// reconcile to the household total by exactly the WCA balance — always
// shown alongside as its own line so nothing is hidden.
function ownerShareOf(owner, forOwner) {
  if (forOwner == null) return 1;
  if (owner === "joint") return 0.5;
  return owner === forOwner ? 1 : 0;
}

// Net worth excluding working cash, for forOwner ("client"|"partner")
// or the whole household (forOwner == null, identical to row.netAssets
// minus nothing — included for symmetry with the per-owner case, which
// callers use to decide whether to show the WCA-exclusion note).
function ownerNetWorthExWca(y, forOwner) {
  const yl = projection.yearly;
  const row = yl[y];
  const properties = state.properties ?? [];
  const liabilities = state.liabilities ?? [];
  const financial = state.assets.filter((a) => a.include)
    .reduce((s, a) => s + (row.perAssetDetail[a.id]?.closing ?? 0) * ownerShareOf(a.owner, forOwner), 0);
  const property = properties
    .reduce((s, p) => s + (row.properties?.[p.id]?.value ?? 0) * ownerShareOf(p.owner, forOwner), 0);
  const superBal = forOwner == null
    ? row.superClosing
    : (state.plan.superAccounts ?? []).filter((sa) => sa.owner === forOwner)
      .reduce((s, sa) => s + (row.superDetail[sa.id]?.closing ?? 0), 0);
  let liabTotal = 0;
  for (const lid of Object.keys(row.liabilities ?? {})) {
    const closing = row.liabilities[lid].closing;
    if (lid === "help_client") liabTotal += forOwner == null || forOwner === "client" ? closing : 0;
    else if (lid === "help_partner") liabTotal += forOwner == null || forOwner === "partner" ? closing : 0;
    else {
      const prop = properties.find((p) => `prop-${p.id}` === lid);
      const owner = prop ? prop.owner : liabilities.find((l) => l.id === lid)?.owner;
      liabTotal += closing * ownerShareOf(owner, forOwner);
    }
  }
  return financial + property + superBal - liabTotal;
}

// --- View: Net assets chart (D5) ---------------------------------------------

function renderNetAssetsChart() {
  if (netAssetsPersonEntity !== "all" && !isCouple()) netAssetsPersonEntity = "all";
  renderPersonSelector(els.netAssetsPersonSelector, netAssetsPersonEntity, (id) => { netAssetsPersonEntity = id; renderNetAssetsChart(); });
  const forOwner = netAssetsPersonEntity === "all" ? null : netAssetsPersonEntity;
  const el = $("chartNetAssets");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const netAssets = forOwner == null
    ? yearIdxs.map((y) => projection.yearly[y].netAssets * factor(y))
    : yearIdxs.map((y) => ownerNetWorthExWca(y, forOwner) * factor(y));
  els.netAssetsNote.textContent = forOwner != null
    ? `Excludes the household's Working Cash Account balance (no per-person attribution exists for it) — ${clientName()}'s and ${partnerName()}'s figures do not sum to the consolidated total for this reason.`
    : "";

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
  if (allocationPersonEntity !== "all" && !isCouple()) allocationPersonEntity = "all";
  renderPersonSelector(els.allocationPersonSelector, allocationPersonEntity, (id) => { allocationPersonEntity = id; renderAssetAllocationChart(); });
  const el = $("chartAssetAllocation");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  // A jointly-owned holding is never split here (it would double-count
  // toward both people's mix) — it's included at full weight in BOTH
  // Client's and Partner's view, disclosed below, since a 100%-
  // normalised MIX is unaffected either way (a 50/50 split of a joint
  // holding produces the identical weightPct as including it whole —
  // only the chart's dollar totals, which this view doesn't show,
  // would differ). Super accounts are never joint.
  const forOwner = allocationPersonEntity === "all" ? null : allocationPersonEntity;
  const filteredAssets = forOwner == null ? state.assets : state.assets.filter((a) => a.owner === forOwner || a.owner === "joint");
  const filteredSuper = forOwner == null ? (state.plan.superAccounts ?? []) : (state.plan.superAccounts ?? []).filter((s) => s.owner === forOwner);
  const filteredBonds = forOwner == null ? (state.bonds ?? []) : (state.bonds ?? []).filter((b) => b.owner === forOwner || b.owner === "joint");
  const { perYear, usesCustom } = allocationSeries(
    yearIdxs.map((y) => projection.yearly[y]), filteredAssets, filteredSuper, PROFILES, filteredBonds
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

  const notes = [];
  if (usesCustom) {
    notes.push("Assets and super accounts with a custom allocation are shown using their selected volatility-basis profile's class weights (the same profile Monte Carlo variability borrows from).");
  }
  if (forOwner != null && state.assets.some((a) => a.owner === "joint" && a.include && a.class !== "lifestyle")) {
    notes.push(`Jointly-owned assets are included at full weight in both ${clientName()}'s and ${partnerName()}'s mix (a 100%-normalised mix is unaffected by a joint holding's split either way).`);
  }
  $("assetAllocationNote").textContent = notes.join(" ");
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
  const pensions = state.plan.pensions ?? [];
  const palette = ["#1c5ab4", "#6b8e23", "#dc5a28", "#5e60ce", "#2e8a8a", "#b5179e", "#d97b2f", "#9a031e", "#3a86c9"];

  const traces = included.map((s, i) => ({
    x: ages,
    y: yearIdxs.map((y) => (projection.yearly[y].superDetail[s.id]?.closing ?? 0) * factor(y)),
    name: s.name, type: "scatter", mode: "lines",
    stackgroup: "super", fill: "tonexty",
    line: { color: palette[i % palette.length], width: 1 },
    hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(s.name)}</extra>`,
  }));
  // Pension phase (spec 20, Commit 5) — retirement-phase balances join
  // the same stack as a separate band, same stackgroup so the total
  // trace height still reads as "all super + pension money", palette
  // continuing past the accumulation accounts' own colours.
  const pensionTraces = pensions.map((pn, i) => ({
    x: ages,
    y: yearIdxs.map((y) => (projection.yearly[y].pensionDetail?.[pn.id]?.closing ?? 0) * factor(y)),
    name: pn.name, type: "scatter", mode: "lines",
    stackgroup: "super", fill: "tonexty",
    line: { color: palette[(included.length + i) % palette.length], width: 1, dash: "dot" },
    hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(pn.name)}</extra>`,
  }));
  traces.push(...pensionTraces);

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

// --- Single-question charts (spec 17, Commit 4) -----------------------------
//
// Each reads chartSeries.js's pure per-year series (unit-tested there
// to reconcile against the ledger rows they claim to represent) and
// shapes traces the same way every existing chart above does: age axis,
// units-toggle-aware $ formatting, hide-empty-rows, PNG export.

const BASE_CHART_FONT = { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" };

// Income sources — the same five categories the Cashflow bars chart's
// income half already shows (incomeCategorySums), stacked alone without
// the expense/surplus overlay, labelled per the spec's own wording.
const INCOME_SOURCE_SEGMENTS = [
  { key: "employment", name: "Salary", color: "#1c5ab4" },
  { key: "rental", name: "Rent", color: "#2e8a8a" },
  { key: "investment", name: "Distributions", color: "#6b8e23" },
  { key: "wcaInterest", name: "Cash interest", color: "#5e60ce" },
  // "other" folds in one-off asset inflows (the closest existing fit
  // to "capital drawdown") alongside a small amount of otherTaxable/
  // nonTaxable income — see incomeCategorySums' own header.
  { key: "other", name: "Capital drawdown & other", color: "#8d99ae" },
];

function renderIncomeSourcesChart() {
  const el = $("chartIncomeSources");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const sums = yearIdxs.map((y) => incomeCategorySums(y));
  const traces = [];
  for (const seg of INCOME_SOURCE_SEGMENTS) {
    const series = yearIdxs.map((yr, i) => sums[i][seg.key] * factor(yr));
    if (seriesIsAllZero(series)) continue;
    traces.push({
      x: ages, y: series, name: seg.name, type: "bar", marker: { color: seg.color },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(seg.name)}</extra>`,
    });
  }
  // Age pension (spec 21a, Commit 4) — its own band, read straight off
  // row.agePensionDetail (not a category row, so it never reaches
  // incomeCategorySums' own aggregation — no double-count risk).
  const agePensionSeries = yearIdxs.map((y) => (projection.yearly[y].agePensionDetail?.entitlement ?? 0) * factor(y));
  if (!seriesIsAllZero(agePensionSeries)) {
    traces.push({
      x: ages, y: agePensionSeries, name: "Age pension", type: "bar", marker: { color: "#dc5a28" },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Age pension</extra>",
    });
  }
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 60 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    barmode: "stack", hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.25, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Income (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    font: BASE_CHART_FONT,
  }, { displayModeBar: false, responsive: true });
}

// Expense funding — "the affordability picture in one image": each
// year's funding need split into met from income, funded by selling
// assets, and unfunded (chartSeries.js's expenseFundingSeries).
function renderExpenseFundingChart() {
  const el = $("chartExpenseFunding");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const series = expenseFundingSeries(projection.yearly);
  const segments = [
    { key: "metFromIncome", name: "Met from income", color: "#1c5ab4" },
    { key: "fundedFromAssets", name: "Funded by selling assets", color: "#d97b2f" },
    { key: "unfunded", name: "Unfunded", color: "#c1121f" },
  ];
  const traces = [];
  for (const seg of segments) {
    const vals = yearIdxs.map((y) => series[y][seg.key] * factor(y));
    if (seriesIsAllZero(vals)) continue;
    traces.push({
      x: ages, y: vals, name: seg.name, type: "bar", marker: { color: seg.color },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(seg.name)}</extra>`,
    });
  }
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 60 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    barmode: "stack", hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.25, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Funding need (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    font: BASE_CHART_FONT,
  }, { displayModeBar: false, responsive: true });
}

// Tax by type — income tax, CGT, contributions tax, Division 293/296,
// HELP, and the Medicare Levy Surcharge (chartSeries.js's
// taxByTypeSeries) — each its own line so a client can see WHICH lever
// is driving the household's total tax cost, not just the total.
const TAX_TYPE_SEGMENTS = [
  { key: "incomeTax", name: "Income tax", color: "#1c5ab4" },
  { key: "cgt", name: "CGT", color: "#6b8e23" },
  { key: "contributionsTax", name: "Contributions tax", color: "#5e60ce" },
  { key: "div293", name: "Division 293", color: "#d97b2f" },
  { key: "div296", name: "Division 296", color: "#9a031e" },
  { key: "help", name: "HELP", color: "#2e8a8a" },
  { key: "mls", name: "Medicare Levy Surcharge", color: "#8d99ae" },
];
function renderTaxByTypeChart() {
  const el = $("chartTaxByType");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const series = taxByTypeSeries(projection.yearly);
  const traces = [];
  for (const seg of TAX_TYPE_SEGMENTS) {
    const vals = yearIdxs.map((y) => series[y][seg.key] * factor(y));
    if (seriesIsAllZero(vals)) continue;
    traces.push({
      x: ages, y: vals, name: seg.name, type: "scatter", mode: "lines", stackgroup: "tax",
      line: { color: seg.color, width: 1 },
      hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(seg.name)}</extra>`,
    });
  }
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 60 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.3, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Tax (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    font: BASE_CHART_FONT,
  }, { displayModeBar: false, responsive: true });
}

// Debt vs assets — two lines, with the crossover year annotated
// (chartSeries.js's debtVsAssetsSeries/debtAssetsCrossoverYear).
function renderDebtVsAssetsChart() {
  const el = $("chartDebtVsAssets");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const series = debtVsAssetsSeries(projection.yearly);
  const crossoverYear = debtAssetsCrossoverYear(projection.yearly);
  const traces = [
    {
      x: ages, y: yearIdxs.map((y) => series[y].assets * factor(y)),
      name: "Total assets", type: "scatter", mode: "lines", line: { color: "#1c5ab4", width: 2.5 },
      hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Total assets</extra>",
    },
    {
      x: ages, y: yearIdxs.map((y) => series[y].debt * factor(y)),
      name: "Total debt", type: "scatter", mode: "lines", line: { color: "#c1121f", width: 2.5 },
      hovertemplate: "Age %{x}<br><b>%{y:$,.0f}</b><extra>Total debt</extra>",
    },
  ];
  const shapes = [], annotations = [];
  if (crossoverYear != null && yearIdxs.includes(crossoverYear)) {
    const age = projection.schedule.clientAges[crossoverYear];
    shapes.push({
      type: "line", xref: "x", yref: "paper", x0: age, x1: age, y0: 0, y1: 1,
      line: { color: "rgba(30,120,60,0.6)", width: 1.5, dash: "dash" },
    });
    annotations.push({
      x: age, xref: "x", y: 1, yref: "paper", yanchor: "bottom", xanchor: "center",
      text: "Assets overtake debt", showarrow: false,
      font: { size: 11, color: "rgba(30,120,60,0.9)" }, bgcolor: "rgba(255,255,255,0.8)", borderpad: 2,
    });
  }
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 60 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Balance (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    shapes, annotations,
    font: BASE_CHART_FONT,
  }, { displayModeBar: false, responsive: true });
}

// Super vs non-super — the salary-sacrifice question made visual, with
// preservation age marked (currently a flat 60 for every cohort this
// tool models — see SUPER_RATES_BASE's own comment).
function renderSuperVsNonSuperChart() {
  const el = $("chartSuperVsNonSuper");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const series = superVsNonSuperSeries(projection.yearly);
  const traces = [
    {
      x: ages, y: yearIdxs.map((y) => series[y].superBalance * factor(y)),
      name: "Super", type: "scatter", mode: "lines", stackgroup: "svns", line: { color: "#1c5ab4", width: 1 },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Super</extra>",
    },
    {
      x: ages, y: yearIdxs.map((y) => series[y].nonSuper * factor(y)),
      name: "Non-super", type: "scatter", mode: "lines", stackgroup: "svns", line: { color: "#6b8e23", width: 1 },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Non-super</extra>",
    },
  ];
  const shapes = [], annotations = [];
  const preservationAge = SUPER_RATES_BASE.preservationAge;
  if (ages.length && preservationAge >= ages[0] && preservationAge <= ages[ages.length - 1]) {
    shapes.push({
      type: "line", xref: "x", yref: "paper", x0: preservationAge, x1: preservationAge, y0: 0, y1: 1,
      line: { color: "rgba(80,70,50,0.55)", width: 1.25, dash: "dash" },
    });
    annotations.push({
      x: preservationAge, xref: "x", y: 1, yref: "paper", yanchor: "bottom", xanchor: "center",
      text: "Preservation age", showarrow: false,
      font: { size: 11, color: "rgba(80,70,50,0.85)" }, bgcolor: "rgba(255,255,255,0.8)", borderpad: 2,
    });
  }
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 60 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Balance (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    shapes, annotations,
    font: BASE_CHART_FONT,
  }, { displayModeBar: false, responsive: true });
}

// --- View: Age pension (spec 21a, Commit 4) ---------------------------------
//
// Entitlement over time with the two test results overlaid, so the
// crossover — the year the binding test changes — is visible. All
// three series read straight off row.agePensionDetail; never re-derived.
function renderAgePensionChart() {
  const el = $("chartAgePension");
  if (typeof Plotly === "undefined") { el.innerHTML = chartUnavailableHTML(); return; }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const detail = (y) => projection.yearly[y].agePensionDetail;
  const traces = [
    {
      x: ages, y: yearIdxs.map((y) => (detail(y)?.entitlement ?? 0) * factor(y)),
      name: "Entitlement (paid)", type: "scatter", mode: "lines", fill: "tozeroy",
      line: { color: "#1c5ab4", width: 2 },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Entitlement</extra>",
    },
    {
      x: ages, y: yearIdxs.map((y) => (detail(y)?.assetsTestResult ?? 0) * factor(y)),
      name: "Assets test result", type: "scatter", mode: "lines",
      line: { color: "#dc5a28", width: 1.5, dash: "dot" },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Assets test</extra>",
    },
    {
      x: ages, y: yearIdxs.map((y) => (detail(y)?.incomeTestResult ?? 0) * factor(y)),
      name: "Income test result", type: "scatter", mode: "lines",
      line: { color: "#6b8e23", width: 1.5, dash: "dot" },
      hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Income test</extra>",
    },
  ];
  Plotly.react(el, traces, {
    margin: { l: 70, r: 20, t: 24, b: 60 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Annual amount (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: true, zerolinecolor: "rgba(0,0,0,0.3)",
    },
    font: BASE_CHART_FONT,
  }, { displayModeBar: false, responsive: true });
}

// Per person per year: assessable assets, assets test result, deemed
// income, other assessable income, income test result, which test
// binds, and entitlement (the spec's own field list). The household-
// level test rows (everything except entitlement itself) are the SAME
// figure regardless of which person is selected — a couple's tests run
// on COMBINED figures (deterministic.js) — only entitlement differs
// per person, since payment is gated per person on age + the
// eligibility flag.
function buildAgePensionGroups(entity) {
  const yl = projection.yearly;
  const zero = { assessableAssets: 0, deprivedAssets: 0, assetsTestResult: 0, deemedIncome: 0, otherIncome: 0, dbAssessableIncome: 0, incomeTestResult: 0, bindingTest: null, entitlement: 0 };
  const get = (y) => yl[y].agePensionDetail ?? zero;
  const entitlementFor = (y) => {
    const d = get(y);
    if (entity === "client") return d.client?.paid ?? 0;
    if (entity === "partner") return d.partner?.paid ?? 0;
    return d.entitlement ?? 0;
  };
  // Work Bonus (spec 21b, Commit 1) is genuinely per-person — the
  // household ("all") view sums both, the same way "Deprived assets"
  // is already inherently a household-level figure (gifting has no
  // per-person split either).
  const workBonusFor = (field) => (y) => {
    const d = get(y);
    if (entity === "client") return d.client?.[field] ?? 0;
    if (entity === "partner") return d.partner?.[field] ?? 0;
    return (d.client?.[field] ?? 0) + (d.partner?.[field] ?? 0);
  };
  const bindingLabel = { assets: "Assets", income: "Income" };
  const rows = [
    { label: "Assessable assets", cell: (y) => get(y).assessableAssets, always: true },
    { label: "Deprived assets", cell: (y) => get(y).deprivedAssets },
    { label: "Assets test result", cell: (y) => get(y).assetsTestResult },
    { label: "Deemed income", cell: (y) => get(y).deemedIncome },
    { label: "Other assessable income", cell: (y) => get(y).otherIncome },
    // Defined benefit pensions (spec 26, Commit 3; UI: spec 27 Commit 4)
    // — income-test only (no account balance to asset-test, deterministic
    // .js's own point), already folded into "Other assessable income"
    // above; reported separately here since that's precisely the
    // "invisible unless modelled" advantage the spec exists to surface.
    { label: "Defined benefit income (income-test only)", cell: (y) => get(y).dbAssessableIncome },
    { label: "Work Bonus applied", cell: workBonusFor("workBonusExempt") },
    { label: "Work Bonus bank", cell: workBonusFor("workBonusBank") },
    { label: "Income test result", cell: (y) => get(y).incomeTestResult },
    { label: "Binding test", text: true, cell: (y) => bindingLabel[get(y).bindingTest] ?? "" },
    { label: "Entitlement", cell: entitlementFor, always: true, cls: "tl-total" },
  ];
  const title = entity === "client" ? clientName() : entity === "partner" ? partnerName() : "Household";
  return [{ title, rows }];
}

function renderAgePensionTableView() {
  if (agePensionPersonEntity !== "all" && !isCouple()) agePensionPersonEntity = "all";
  renderPersonSelector(els.agePensionEntity, agePensionPersonEntity, (id) => { agePensionPersonEntity = id; renderAgePensionTableView(); });
  renderTransposed(els.agePensionTable, buildAgePensionGroups(agePensionPersonEntity));
}

// --- Focus: Age pension (spec 21a, Commit 4) --------------------------------
//
// Assets and income against their own thresholds by year, with the
// full-pension and cut-out lines drawn — the view an adviser uses to
// reason about whether a strategy moves someone across a threshold.
// Thresholds are recomputed per year from agePensionRatesFor (the SAME
// function deterministic.js itself calls), never re-derived by hand.
function agePensionFocusEligible() {
  return (projection?.yearly ?? []).some((row) =>
    row.agePensionDetail?.client?.ageEligible || row.agePensionDetail?.partner?.ageEligible
  );
}

function renderFocusAgePensionView() {
  if (!agePensionFocusEligible()) {
    els.viewFocusAgePension.innerHTML = focusEmptyStateHTML(
      "Assets and income against the age pension thresholds, once someone in the household reaches age pension age (67) within the projection.",
      "tax-details"
    );
    return;
  }
  els.viewFocusAgePension.innerHTML = `
    <h2 class="section-heading">Age pension</h2>
    <div class="focus-panel">
      <div class="focus-section">
        <h3>Assessable assets vs thresholds</h3>
        <div id="focusAgePensionAssetsChart"></div>
      </div>
      <div class="focus-section">
        <h3>Assessable income vs thresholds</h3>
        <div id="focusAgePensionIncomeChart"></div>
      </div>
    </div>
    <div class="focus-section">
      <h3>Strategy comparison</h3>
      <p class="helper-text">Entitlement and net worth side by side under the current plan, an illustrative gift, and illustrative work income — gifting increases entitlement by reducing real wealth, and Work Bonus income reduces (or holds) entitlement while still adding to it; neither is shown as the "better" choice.</p>
      <div id="focusAgePensionStrategyTable"></div>
    </div>
  `;
  renderFocusAgePensionCharts();
  renderFocusAgePensionStrategyTable();
}

// Age pension strategy comparison (spec 21b, Commit 5) — current plan
// vs an illustrative gift vs illustrative work income, side by side.
// Every arm is a REAL projectPlan() run (focusAgePensionStrategy.js),
// never a hand-derived estimate. Non-prescriptive: both figures
// (entitlement, net assets) for every arm, no arm singled out as
// preferred — see that module's own header.
function renderFocusAgePensionStrategyTable() {
  const el = $("focusAgePensionStrategyTable");
  if (!el) return;
  const result = buildAgePensionStrategyFocus({ state, giftAmount: 10000, workIncomeLevels: [10000, 20000] });
  if (!result) { el.innerHTML = ""; return; }
  const rows = [];
  for (const arm of result.arms) rows.push({ label: `${arm.label} — entitlement`, cell: (y) => result.byYear[y][arm.id].entitlement });
  for (const arm of result.arms) rows.push({ label: `${arm.label} — net assets`, cell: (y) => result.byYear[y][arm.id].netAssets, cls: "tl-total" });
  renderTransposed(el, [{ title: null, rows }]);
}

function renderFocusAgePensionCharts() {
  const assetsEl = $("focusAgePensionAssetsChart");
  const incomeEl = $("focusAgePensionIncomeChart");
  if (!assetsEl || !incomeEl) return;
  if (typeof Plotly === "undefined") {
    assetsEl.innerHTML = chartUnavailableHTML();
    incomeEl.innerHTML = chartUnavailableHTML();
    return;
  }
  const yearIdxs = selectedYearIndices();
  const ages = yearIdxs.map((y) => projection.schedule.clientAges[y]);
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const fy0 = firstFyStartYear(state.plan.start);
  const couple = isCouple();
  const cpi = state.assumptions.cpi;
  const awote = state.assumptions.awote ?? 0.035;
  const bracketMode = state.assumptions.bracketMode === "frozen" ? "frozen" : "indexed";
  const detail = (y) => projection.yearly[y].agePensionDetail;
  const ratesAt = (y) => agePensionRatesFor(fy0 + y, bracketMode, cpi, awote);

  const fullPensionThreshold = (y) => {
    const r = ratesAt(y);
    const homeowner = detail(y)?.homeowner !== false;
    return couple
      ? (homeowner ? r.couple.assetsFullHomeowner : r.couple.assetsFullNonHomeowner)
      : (homeowner ? r.single.assetsFullHomeowner : r.single.assetsFullNonHomeowner);
  };
  const assetsCutOut = (y) => {
    const r = ratesAt(y);
    return assetsTestCutOut(fullPensionThreshold(y), couple ? r.couple.rateCombined : r.single.rate, r.reductionRatePer1000);
  };
  const incomeFreeArea = (y) => {
    const r = ratesAt(y);
    return couple ? r.couple.incomeFreeAreaCombined : r.single.incomeFreeArea;
  };
  // Income cut-out — the income level at which the income test alone
  // reaches zero — derived the same way assetsTestCutOut derives the
  // assets-test cut-out (solving the taper for its zero), just never
  // extracted as its own named export since only this Focus view needs it.
  const incomeCutOut = (y) => {
    const r = ratesAt(y);
    const maxRate = couple ? r.couple.rateCombined : r.single.rate;
    return incomeFreeArea(y) + maxRate / r.incomeReductionRate;
  };

  const lineTrace = (name, values, color, dash) => ({
    x: ages, y: yearIdxs.map((y, i) => values[i] * factor(y)),
    name, type: "scatter", mode: "lines", line: { color, width: name.includes("assessable") ? 2 : 1.25, dash },
    hovertemplate: `Age %{x}<br>%{y:$,.0f}<extra>${escapeHTML(name)}</extra>`,
  });

  Plotly.react(assetsEl, [
    lineTrace("Assessable assets", yearIdxs.map((y) => detail(y)?.assessableAssets ?? 0), "#1c5ab4"),
    lineTrace("Full pension threshold", yearIdxs.map((y) => fullPensionThreshold(y)), "#6b8e23", "dash"),
    lineTrace("Cut-out", yearIdxs.map((y) => assetsCutOut(y)), "#dc5a28", "dash"),
  ], {
    margin: { l: 70, r: 20, t: 24, b: 50 }, paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Assets (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: BASE_CHART_FONT,
  }, { displayModeBar: false, responsive: true });

  Plotly.react(incomeEl, [
    lineTrace("Assessable income", yearIdxs.map((y) => detail(y)?.assessableIncome ?? 0), "#1c5ab4"),
    lineTrace("Free area", yearIdxs.map((y) => incomeFreeArea(y)), "#6b8e23", "dash"),
    lineTrace("Cut-out", yearIdxs.map((y) => incomeCutOut(y)), "#dc5a28", "dash"),
  ], {
    margin: { l: 70, r: 20, t: 24, b: 50 }, paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Client age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `Income (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: BASE_CHART_FONT,
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
  // Adjustment rows (spec 18 Commit 3) — "any export produced from a
  // scenario containing adjustments carries a one-line footer... not a
  // warning, a fact" — applies regardless of which view is exported,
  // since the adjustment is a property of the scenario, not the view.
  const adjCount = (state.plan.adjustments ?? []).length;
  if (adjCount > 0) lines.push("", esc(`This projection includes ${adjCount} manual adjustment${adjCount === 1 ? "" : "s"}.`));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${exportNameBase()}-${viewName}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Adjustment rows (spec 18 Commit 3) — "Any view or export produced
// from a scenario containing adjustments carries a one-line footer...
// Not a warning, a fact." Shared by every view/export Commit 2 marks
// rows on, so the wording (and the count) can never drift between them.
const adjustmentsDisclosureFooter = () => {
  const n = (state.plan.adjustments ?? []).length;
  return n === 0 ? "" : `<div class="ledger-foot">This projection includes ${n} manual adjustment${n === 1 ? "" : "s"}.</div>`;
};

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
// entity ("all" | "client" | "partner", spec 17 Commit 3) — Total
// assets/liabilities/NET ASSETS and Super/HELP balance split via
// ownerNetWorthExWca's convention (financial/property joint→50/50,
// super/HELP exact). Total income/expenses/tax/Surplus have no
// forOwner path anywhere (cashflowCategories.js computes household
// scalars only) and Working cash has no owner at all — both stay
// household-level regardless of entity, per the spec's own fallback.
function buildKeyFiguresGroups(ctx = { state, projection }, entity = "all") {
  const { projection: p, state: s } = ctx;
  const yl = p.yearly;
  const forOwner = entity === "all" ? null : entity;
  const properties = s.properties ?? [];
  const liabilities = s.liabilities ?? [];
  // Consolidated ("all") includes working cash, exactly as before this
  // commit; a per-person split excludes it (no owner attribution exists
  // for the WCA) rather than guessing, per the header comment above.
  const totalAssets = (y) => {
    const row = yl[y];
    if (forOwner == null) return row.closingBalance + row.propertyClosing + row.superClosing + row.wcaClosing;
    const financial = s.assets.filter((a) => a.include)
      .reduce((sum, a) => sum + (row.perAssetDetail[a.id]?.closing ?? 0) * ownerShareOf(a.owner, forOwner), 0);
    const property = properties.reduce((sum, pr) => sum + (row.properties?.[pr.id]?.value ?? 0) * ownerShareOf(pr.owner, forOwner), 0);
    const superBal = (s.plan.superAccounts ?? []).filter((sa) => sa.owner === forOwner)
      .reduce((sum, sa) => sum + (row.superDetail[sa.id]?.closing ?? 0), 0);
    return financial + property + superBal;
  };
  const totalLiabilities = (y) => {
    const row = yl[y];
    if (forOwner == null) return row.liabilitiesClosing;
    let total = 0;
    for (const lid of Object.keys(row.liabilities ?? {})) {
      const closing = row.liabilities[lid].closing;
      if (lid === "help_client") total += forOwner === "client" ? closing : 0;
      else if (lid === "help_partner") total += forOwner === "partner" ? closing : 0;
      else {
        const prop = properties.find((pr) => `prop-${pr.id}` === lid);
        const owner = prop ? prop.owner : liabilities.find((l) => l.id === lid)?.owner;
        total += closing * ownerShareOf(owner, forOwner);
      }
    }
    return total;
  };
  // Consolidated NET ASSETS is exactly row.netAssets (includes working
  // cash) — unchanged from before this commit. A per-person figure
  // excludes it (no owner attribution exists for the WCA), per the
  // header comment above.
  const netAssets = (y) => forOwner == null ? yl[y].netAssets : totalAssets(y) - totalLiabilities(y);
  const totalIncome = (y) => {
    const s = incomeCategorySums(y, ctx);
    return s.employment + s.rental + s.investment + s.wcaInterest + s.other;
  };
  const totalExpenses = (y) => {
    const s = expenseCategorySums(y, ctx);
    return s.living + s.investmentExpenses + s.loanInterest + s.loanPrincipal + s.tax + s.superContributions;
  };
  const superBalance = (y) => forOwner == null
    ? yl[y].superClosing
    : (s.plan.superAccounts ?? []).filter((sa) => sa.owner === forOwner).reduce((sum, sa) => sum + (yl[y].superDetail[sa.id]?.closing ?? 0), 0);
  // Defined benefit pensions (UI: spec 27 Commit 4) — an income line,
  // not a balance: there is no account to appear in Total assets/NET
  // ASSETS above (deterministic.js's own point — the spec exists
  // precisely because that asset-test exemption is otherwise
  // invisible). Filtered to this owner's own DB pensions the same way
  // superBalance just above filters super accounts.
  const definedBenefits = s.plan.definedBenefits ?? [];
  const definedBenefitIncome = (y) => definedBenefits
    .filter((db) => forOwner == null || db.owner === forOwner)
    .reduce((sum, db) => sum + (yl[y].definedBenefitDetail?.[db.id]?.grossPension ?? 0), 0);
  const householdSuffix = forOwner == null ? "" : " (household)";
  const rows = [
    { label: "Total assets", cell: totalAssets, always: true },
    { label: "Total liabilities", cell: (y) => -totalLiabilities(y), always: true },
    { label: forOwner == null ? "NET ASSETS" : "NET ASSETS (excl. working cash)", cell: netAssets, always: true, cls: "tl-total" },
    { label: `Total income${householdSuffix}`, cell: totalIncome, always: true },
    // Not `always: true` (HELP balance's own convention below) — a
    // household with no defined benefit pension never sees this row.
    { label: "Defined benefit pension income", cell: definedBenefitIncome },
    { label: `Total expenses${householdSuffix}`, cell: (y) => -totalExpenses(y), always: true },
    { label: `Total tax${householdSuffix}`, cell: (y) => -yl[y].tax, always: true },
    { label: `Surplus / (deficit)${householdSuffix}`, cell: (y) => yl[y].surplusOrDeficit, always: true, cls: "tl-total" },
    { label: "Super balance", cell: superBalance, always: true },
    { label: `Working cash balance${householdSuffix}`, cell: (y) => yl[y].wcaClosing, always: true },
    // Document Set Commit 1 — joins the table only while any HELP debt
    // exists (no `always: true`, unlike every row above): a client
    // with no HELP balance never sees this row at all.
    {
      label: "HELP balance",
      cell: (y) => forOwner == null
        ? (yl[y].taxDetail.client?.helpBalanceClosing ?? 0) + (yl[y].taxDetail.partner?.helpBalanceClosing ?? 0)
        : (yl[y].taxDetail[forOwner]?.helpBalanceClosing ?? 0),
    },
    // CSHC (spec 21b, Commit 4) — a household-level ("is anyone in this
    // household eligible") summary when no person is selected; the
    // selected person's own flag otherwise. Always shown (not hidden
    // when never eligible) — an adviser needs to see "No" as
    // confidently as "Yes".
    {
      label: "CSHC eligible",
      text: true,
      always: true,
      cell: (y) => {
        const d = yl[y].cshcDetail;
        if (!d) return "";
        const eligible = forOwner ? d[forOwner]?.eligible : (d.client?.eligible || d.partner?.eligible);
        return eligible ? "Yes" : "No";
      },
    },
    // HEAS (spec 21b, Commit 5) — a single household loan, no per-person
    // split (same reasoning as Working cash balance above); hidden when
    // never enabled/drawn (all-zero rows convention — no `always`).
    { label: "HEAS loan balance", cell: (y) => -(yl[y].heasDetail?.closing ?? 0) },
  ];
  return [{ title: null, rows }];
}

function renderKeyFiguresView() {
  if (keyFiguresPersonEntity !== "all" && !isCouple()) keyFiguresPersonEntity = "all";
  renderPersonSelector(els.keyFiguresPersonSelector, keyFiguresPersonEntity, (id) => { keyFiguresPersonEntity = id; renderKeyFiguresView(); });
  renderTransposed(els.keyFiguresTable, buildKeyFiguresGroups({ state, projection }, keyFiguresPersonEntity));
  els.keyFiguresNote.textContent = keyFiguresPersonEntity !== "all"
    ? "Working cash, income, expenses, tax, and surplus/(deficit) have no per-person attribution and are shown at the household level regardless of the selection above; NET ASSETS here excludes working cash for the same reason."
    : "";
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
// forOwner ("client" | "partner" | null, spec 17 Commit 3) — filters
// every splittable row to that person via cashflowStatement()'s own
// forOwner param (Document Set Commit 7's Snapshot mechanism, reused
// here rather than a second copy). One-off amounts, Funding, and Goals
// have no owner attribution anywhere in the ledger — the spec's own
// fallback ("show it in all three modes with a note") applies to them.
function buildCashflowGroups(forOwner = null) {
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
    definedBenefits: state.plan.definedBenefits ?? [],
  }, forOwner);

  // The per-owner suffix is redundant (and confusing) once the whole
  // view is already filtered to one person.
  const ownerLabel = (r) => (couple && forOwner == null) ? `${r.label} (${r.owner === "partner" ? partnerName() : clientName()})` : r.label;
  // One row per category (collapsed default), or one row per
  // individually entered row of that category — same total either way.
  // Income/expense/deduction rows are never joint (planState.js), so a
  // plain owner match is exact, not a share.
  const catRow = (rows, rowTotals, category, label, aggregateCell) => {
    const matching = rows.filter((r) => r.category === category && (forOwner == null || r.owner === forOwner));
    if (!showIndividual || matching.length === 0) return [{ label, cell: aggregateCell }];
    return matching.map((r) => ({ label: ownerLabel(r), cell: (y) => rowTotals[r.id]?.[y] ?? 0 }));
  };

  // --- ASSESSABLE INCOME ------------------------------------------------
  const assessableRows = [
    ...catRow(incomeRows, rt.income, "salary", "Salary", (y) => stmt(y).assessable.salary),
    { label: "Taxable Pension Component", cell: (y) => stmt(y).assessable.taxablePensionComponent },
    ...catRow(incomeRows, rt.income, "otherIncome", "Other Income", (y) => stmt(y).assessable.otherIncome),
    { label: "Government/Centrelink payments", cell: (y) => stmt(y).assessable.governmentPayments },
    // Defined benefit pensions (UI: spec 27 Commit 4) — gross shown for
    // visibility (matching the row above), the genuinely-assessable
    // portion (untaxed element + any income-cap excess) already folded
    // into Assessable Income's own total (cashflowStatement.js).
    { label: "Defined benefit pension income (gross)", cell: (y) => stmt(y).assessable.definedBenefitGross },
    { label: "Interest Income", cell: (y) => stmt(y).assessable.interestIncome },
    { label: "Dividend Income", cell: (y) => stmt(y).assessable.dividendIncome },
    { label: "Franking Credits", cell: (y) => stmt(y).assessable.frankingCredits },
    { label: "Property Income – Gross Rent", cell: (y) => stmt(y).assessable.propertyIncomeGross },
    { label: "Trust Distribution", cell: (y) => stmt(y).assessable.trustDistribution },
    { label: "Foreign Income", cell: (y) => stmt(y).assessable.foreignIncome },
    { label: "Net Taxable Capital Gains", cell: (y) => stmt(y).assessable.netTaxableCapitalGains },
  ];
  // Adjustment rows (spec 18 Commit 2) — "income.assessable" adjusts
  // this section's own total; see adjustableRow's header comment.
  assessableRows.push(...adjustableRow(
    "Assessable Income", (y) => stmt(y).assessable.computedTotal, (y) => stmt(y).assessable.adjAssessable,
    "income.assessable", forOwner, { always: true, cls: "tl-total" }
  ));

  // --- DEDUCTIONS --------------------------------------------------------
  const deductionSectionRows = [
    { label: "Less: Investment Portfolio Interest", cell: (y) => -stmt(y).deductions.investmentPortfolioInterest },
    { label: "Property Interest Deductions", cell: (y) => -stmt(y).deductions.propertyInterestDeductions },
    { label: "Property Deductions", cell: (y) => -stmt(y).deductions.propertyDeductions },
    { label: "Property Depreciation", cell: (y) => -stmt(y).deductions.propertyDepreciation },
    { label: "Land Tax (investment)", cell: (y) => -stmt(y).deductions.propertyLandTax },
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
  // Adjustment rows (spec 18 Commit 2) — "deductions" adjusts the
  // Deductions section total, which this table surfaces as Taxable
  // Income rather than a separate "Total Deductions" line; the
  // adjustment's own contribution there is -adjDeductions (more
  // deductions ⇒ lower taxable income).
  deductionSectionRows.push(...adjustableRow(
    "Taxable Income", (y) => stmt(y).taxableIncome + stmt(y).deductions.adjDeductions, (y) => -stmt(y).deductions.adjDeductions,
    "deductions", forOwner, { always: true, cls: "tl-total" }
  ));

  // --- TAX -----------------------------------------------------------
  const taxSectionRows = [
    ...adjustableRow(
      "Income Tax",
      (y) => -stmt(y).tax.incomeTaxComputed,
      (y) => -(stmt(y).tax.incomeTaxAdjustment + stmt(y).tax.cgtAdjustment),
      ["tax.incomeTax", "tax.cgt"], forOwner
    ),
    ...adjustableRow(
      "Medicare Levy", (y) => -stmt(y).tax.medicareLevyComputed, (y) => -stmt(y).tax.medicareAdjustment,
      "tax.medicare", forOwner
    ),
    { label: "Medicare Levy Surcharge", cell: (y) => -stmt(y).tax.medicareLevySurcharge },
    ...adjustableRow(
      "HELP Repayment", (y) => -stmt(y).tax.helpRepaymentComputed, (y) => -stmt(y).tax.helpAdjustment,
      "tax.help", forOwner
    ),
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
    // Adjustment rows (spec 18 Commit 2) — "income.nonTaxable" folds
    // into this line (cashflowStatement.js); when individual rows are
    // shown (showIndividual), those already-itemised rows take over and
    // an adjustment here would have nowhere visible to attach — a
    // disclosed simplification, not a silent one (the Adjustments panel
    // still lists it either way).
    ...(showIndividual && incomeRows.some((r) => r.category === "otherTaxFreeIncome" && (forOwner == null || r.owner === forOwner))
      ? catRow(incomeRows, rt.income, "otherTaxFreeIncome", "Other tax free income", (y) => stmt(y).cashReceived.otherTaxFreeIncome)
      : adjustableRow(
          "Other tax free income", (y) => stmt(y).cashReceived.otherTaxFreeIncomeComputed, (y) => stmt(y).cashReceived.adjNonTaxable,
          "income.nonTaxable", forOwner
        )),
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
    { label: "Land Tax", cell: (y) => -stmt(y).expenses.landTax },
    ...catRow(expenseRows, rt.expenses, "homeMaintenance", "Home Maintenance expenses", (y) => stmt(y).expenses.homeMaintenance).map(negate),
    ...catRow(expenseRows, rt.expenses, "other", "Other", (y) => stmt(y).expenses.other).map(negate),
    { label: "Education Fees", cell: (y) => -stmt(y).expenses.education },
    // Gifts (UI: spec 27 Commit 4) — the full gift amount leaves cash
    // regardless of the allowable/deprived split (gifting.js's own
    // header), read straight off row.giftsPaid.
    { label: "Gifts", cell: (y) => -stmt(y).expenses.gifts },
  ];
  // Adjustment rows (spec 18 Commit 2) — "expenses" adjusts this
  // section's own total.
  expenseSectionRows.push(...adjustableRow(
    "Total Expenses", (y) => -stmt(y).expenses.computedTotal, (y) => -stmt(y).expenses.adjExpenses,
    "expenses", forOwner, { always: true, cls: "tl-total" }
  ));
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
  // Goals, One-off amounts, and Funding have no owner attribution
  // anywhere in the ledger (spec 17 Commit 3's own fallback: "show it
  // in all three modes with a note rather than hiding it or splitting
  // it arbitrarily") — shown in full regardless of forOwner, titled to
  // say so once a person is selected rather than silently looking like
  // a per-person figure.
  const householdSuffix = forOwner == null ? "" : " (household)";
  if (goalRows.length) {
    const rows = goalRows.map((g) => ({ label: g.label, cell: (y) => -(yl[y].goals?.[g.id]?.contribution ?? 0) }));
    rows.push({ label: "Total goal contributions", always: true, cls: "tl-total",
      cell: (y) => -goalRows.reduce((s, g) => s + (yl[y].goals?.[g.id]?.contribution ?? 0), 0) });
    groups.push({ title: `Goals${householdSuffix}`, rows });
  }
  if (oneOffRows.length) groups.push({ title: `One-off amounts${householdSuffix}`, rows: oneOffRows });
  // Surplus/deficit allocation spec, Commit 3: the surplus half of
  // Funding breaks into one row per destination — see
  // surplusPerDestinationRows's own header (shared with the Focus →
  // Surplus allocation view, so the two never disagree).
  groups.push({ title: `Funding${householdSuffix}`, rows: [
    ...surplusPerDestinationRows(yl),
    { label: "Deficit funded from assets", cell: (y) => -yl[y].deficitFundedFromAssets },
    { label: "Unfunded cashflow", cell: (y) => yl[y].unfundedCashflow },
  ] });
  return groups;
}

// One row per surplus destination that EXISTS in the plan (asset/
// liability/super account/goal), each reading the SAME per-target
// reporting field surplusDestinationBreakdown() reads elsewhere, plus
// the two destination-agnostic outcomes (spent, swept to cash) — a row
// a period's allocations never actually reach in a given FY reads zero
// and disappears under the existing all-zero-rows-hidden convention,
// rather than needing its own presence check here. Shared by the
// Cashflow table's Funding group and the Focus → Surplus allocation
// view (Commit 3) so the two can never disagree about the row set.
function surplusPerDestinationRows(yl) {
  const financialAssets = state.assets.filter((a) => a.include && a.class !== "lifestyle");
  return [
    ...financialAssets.map((a) => ({
      label: `Surplus → ${a.name}`, cell: (y) => yl[y].perAssetDetail?.[a.id]?.surplusInvested ?? 0,
    })),
    ...(state.liabilities ?? []).map((l) => ({
      label: `Surplus → ${l.name}`, cell: (y) => yl[y].liabilities?.[l.id]?.surplusRepayment ?? 0,
    })),
    ...(state.plan.superAccounts ?? []).map((sa) => ({
      label: `Surplus → ${sa.name}`,
      cell: (y) => (yl[y].superDetail?.[sa.id]?.surplusSalarySacrifice ?? 0) + (yl[y].superDetail?.[sa.id]?.surplusPersonalDeductible ?? 0),
    })),
    ...(state.goals ?? []).map((g) => ({ label: `Surplus → ${g.label}`, cell: (y) => yl[y].goals?.[g.id]?.surplusContribution ?? 0 })),
    { label: "Surplus spent", cell: (y) => yl[y].surplusSpent },
    { label: "Surplus swept to cash", cell: (y) => yl[y].surplusAccumulated },
  ];
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
  if (cashflowPersonEntity !== "all" && !isCouple()) cashflowPersonEntity = "all";
  renderPersonSelector(els.cashflowEntity, cashflowPersonEntity, (id) => { cashflowPersonEntity = id; renderCashflowView(); });
  const forOwner = cashflowPersonEntity === "all" ? null : cashflowPersonEntity;
  const note = forOwner
    ? `<p class="chart-note-inline">Working cash interest, pooled cash distributions, and education fees are split 50/50 between ${clientName()} and ${partnerName()} (no per-person attribution exists for these); Goals, One-off amounts, and Funding are household-level and shown in full.</p>`
    : "";
  renderTransposed(els.cashflowTable, buildCashflowGroups(forOwner),
    note + accruedCgtFooter() + accruedDiv293Footer() + accruedDiv296Footer() + adjustmentsDisclosureFooter());
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

// Navigation, View Consolidation, and Simple Charts (spec 17), Commit 3
// — Client/Partner/Consolidated selector, the same renderEntitySelector
// widget the Assets/Super/Liabilities views already use, with a fixed
// "all"|"client"|"partner" entity set. Shown only for a couple (spec:
// "shown only when the household is a couple") — a single-person
// household has nothing to select between, so the control is hidden
// entirely rather than shown with one meaningless option.
function renderPersonSelector(mountEl, active, onSelect) {
  if (!mountEl) return;
  if (!isCouple()) { mountEl.hidden = true; return; }
  mountEl.hidden = false;
  renderEntitySelector(
    mountEl,
    [{ id: "all", label: "Consolidated" }, { id: "client", label: clientName() }, { id: "partner", label: partnerName() }],
    active,
    onSelect
  );
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
    const bondList = (state.bonds ?? []).filter((b) => b.include);
    if (bondList.length) {
      groups.push({
        title: "Investment/education bonds",
        rows: [
          ...bondList.map((b) => ({ label: b.name, cell: (y) => yl[y].bondDetail?.[b.id]?.closing ?? 0 })),
          { label: "Total bonds", cell: (y) => yl[y].bondsClosing, always: true, cls: "tl-total" },
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

// entity: "all" | "client" | "partner" | a specific account id. Super
// accounts are never joint (planState.js), so filtering by owner is an
// exact split, not a share — unlike most of the other five views in
// spec 17 Commit 3.
function buildSuperGroups(entity) {
  const yl = projection.yearly;
  const included = (state.plan.superAccounts ?? []).filter((s) => s.include);
  const couple = isCouple();
  const clientGroup = superPersonGroup("client", clientName());
  const partnerGroup = couple ? superPersonGroup("partner", partnerName()) : null;
  const personGroups = [clientGroup, ...(partnerGroup ? [partnerGroup] : [])];

  const zero = { opening: 0, sg: 0, salarySacrifice: 0, personalDeductible: 0, nonConcessional: 0, contributionsTax: 0, earnings: 0, earningsTax: 0, withdrawals: 0, release: 0, closing: 0 };
  const combinedGroupsFor = (accounts, title) => {
    const combined = superDetailRows((y) => accounts.reduce((s, a) => {
      const d = yl[y].superDetail[a.id] ?? zero;
      for (const k in s) s[k] += d[k] ?? 0;
      return s;
    }, { ...zero }));
    combined.push({
      label: "Closing balance", always: true, cls: "tl-total",
      cell: (y) => accounts.reduce((s, a) => s + (yl[y].superDetail[a.id]?.closing ?? 0), 0),
    });
    const byAccount = accounts.map((a) => ({ label: a.name, cell: (y) => yl[y].superDetail[a.id]?.closing ?? 0 }));
    byAccount.push({
      label: "Total", always: true, cls: "tl-total",
      cell: (y) => accounts.reduce((s, a) => s + (yl[y].superDetail[a.id]?.closing ?? 0), 0),
    });
    return [
      { title, rows: combined },
      { title: "Closing balance by account", rows: byAccount },
    ];
  };

  if (entity === "client") {
    return [...combinedGroupsFor(included.filter((s) => s.owner === "client"), `Combined — ${clientName()}`), clientGroup];
  }
  if (entity === "partner" && couple) {
    return [...combinedGroupsFor(included.filter((s) => s.owner === "partner"), `Combined — ${partnerName()}`), partnerGroup];
  }
  if (entity === "all") {
    return [...combinedGroupsFor(included, "Combined"), ...personGroups];
  }

  const zeroAccount = { ...zero, taxFreeClosing: 0 };
  const name = included.find((a) => a.id === entity)?.name ?? "Super account";
  const rows = superDetailRows((y) => yl[y].superDetail[entity] ?? zeroAccount);
  rows.push({ label: "Closing balance", cell: (y) => (yl[y].superDetail[entity] ?? zeroAccount).closing, always: true, cls: "tl-total" });
  rows.push({ label: "of which tax-free", cell: (y) => (yl[y].superDetail[entity] ?? zeroAccount).taxFreeClosing });
  return [{ title: name, rows }, ...personGroups];
}

function renderSuperTableView() {
  const included = (state.plan.superAccounts ?? []).filter((s) => s.include);
  const couple = isCouple();
  const validEntities = ["all", ...(couple ? ["client", "partner"] : []), ...included.map((s) => s.id)];
  if (!validEntities.includes(superEntity)) superEntity = "all"; // entity removed/excluded, or no longer a couple
  renderEntitySelector(
    els.superEntity,
    [
      { id: "all", label: "Consolidated" },
      ...(couple ? [{ id: "client", label: clientName() }, { id: "partner", label: partnerName() }] : []),
      ...included.map((s) => ({ id: s.id, label: s.name })),
    ],
    superEntity,
    (id) => { superEntity = id; renderSuperTableView(); }
  );
  renderTransposed(els.superTable, buildSuperGroups(superEntity));
}

// --- View: Pension (spec 20, Commit 5) --------------------------------------

function pensionDetailRows(get) {
  return [
    { label: "Opening balance", cell: (y) => get(y).opening, always: true },
    { label: "Commencement", cell: (y) => get(y).commencementAmount },
    { label: "Earnings", cell: (y) => get(y).earnings },
    { label: "Earnings tax", cell: (y) => -get(y).earningsTax },
    { label: "Payments (tax-free)", cell: (y) => -get(y).paymentsTaxFree },
    { label: "Payments (taxable)", cell: (y) => -get(y).paymentsTaxable },
    { label: "Commutations", cell: (y) => -get(y).commutations },
  ];
}

// Defined benefit pensions (spec 26, Commit 2/3; UI: spec 27 Commit 4)
// — no balance rows (no account exists to hold one, deterministic.js's
// own point): gross pension, the deductible (tax-free) amount, and the
// assessable portion (the untaxed element plus any income-cap excess —
// see cashflowStatement.js's own comment on why the taxed-within-cap
// element is excluded here). "Tax" is deliberately NOT a row: the
// engine assesses tax at the whole-of-person level across every income
// source together (Tax/annual.js's own marginal-rate `base`), so no
// per-DB-pension tax figure exists to show — showing one would mean
// fabricating a number projectPlan() never computes, which spec 27's
// own principle (every figure already exists in its output) rules out.
function dbDetailRows(get) {
  return [
    { label: "Gross pension", cell: (y) => get(y).grossPension, always: true },
    { label: "Deductible amount (tax-free)", cell: (y) => -get(y).taxFreeAmount },
    { label: "Assessable portion", cell: (y) => get(y).untaxedAssessable + get(y).dbIncomeCapExcess },
  ];
}

// The 16x TBA credit (deterministic.js's own "the factor of ten") —
// today's-dollars, the same figure Commit 1's input card already shows
// at entry ("$80,000 pa uses $1,280,000 of your transfer balance
// cap"), shown DISTINCTLY here too so it's never mistaken for the
// pension's own gross amount in the same TBA display an ordinary
// pension's dollar-for-dollar commencement credit appears in.
function dbTbaCreditNote(db) {
  return `<p class="helper-text">Transfer balance cap credited at commencement: ${fmtMoney(db.annualPension * 16)} (16 × ${fmtMoney(db.annualPension)} annual pension) — NOT the pension amount itself.</p>`;
}

// entity: "all" | a specific pension id | a specific definedBenefit id.
function buildPensionGroups(entity) {
  const yl = projection.yearly;
  const pensions = state.plan.pensions ?? [];
  const dbRows = state.plan.definedBenefits ?? [];
  const zero = { opening: 0, commencementAmount: 0, earnings: 0, earningsTax: 0, payments: 0, paymentsTaxFree: 0, paymentsTaxable: 0, commutations: 0, closing: 0, taxFreeClosing: 0 };
  const dbZero = { grossPension: 0, taxFreeAmount: 0, untaxedAssessable: 0, dbIncomeCapExcess: 0 };

  if (entity === "all") {
    const combined = pensionDetailRows((y) => pensions.reduce((s, pn) => {
      const d = yl[y].pensionDetail?.[pn.id] ?? zero;
      for (const k in s) s[k] += d[k] ?? 0;
      return s;
    }, { ...zero }));
    combined.push({
      label: "Closing balance", always: true, cls: "tl-total",
      cell: (y) => pensions.reduce((s, pn) => s + (yl[y].pensionDetail?.[pn.id]?.closing ?? 0), 0),
    });
    const byPension = pensions.map((pn) => ({ label: pn.name, cell: (y) => yl[y].pensionDetail?.[pn.id]?.closing ?? 0 }));
    byPension.push({
      label: "Total", always: true, cls: "tl-total",
      cell: (y) => pensions.reduce((s, pn) => s + (yl[y].pensionDetail?.[pn.id]?.closing ?? 0), 0),
    });
    const groups = [
      { title: "Combined", rows: combined },
      { title: "Closing balance by pension", rows: byPension },
    ];
    if (dbRows.length > 0) {
      const dbCombined = dbDetailRows((y) => dbRows.reduce((s, db) => {
        const d = yl[y].definedBenefitDetail?.[db.id] ?? dbZero;
        for (const k in s) s[k] += d[k] ?? 0;
        return s;
      }, { ...dbZero }));
      groups.push({ title: "Defined benefit — combined", rows: dbCombined });
    }
    return groups;
  }

  const db = dbRows.find((x) => x.id === entity);
  if (db) {
    const rows = dbDetailRows((y) => yl[y].definedBenefitDetail?.[entity] ?? dbZero);
    return [{ title: db.name, rows }];
  }

  const pn = pensions.find((x) => x.id === entity);
  const name = pn?.name ?? "Pension";
  const rows = pensionDetailRows((y) => yl[y].pensionDetail?.[entity] ?? zero);
  rows.push({ label: "Closing balance", cell: (y) => (yl[y].pensionDetail?.[entity] ?? zero).closing, always: true, cls: "tl-total" });
  rows.push({ label: "of which tax-free", cell: (y) => (yl[y].pensionDetail?.[entity] ?? zero).taxFreeClosing });
  return [{ title: name, rows }];
}

function renderPensionTableView() {
  const pensions = state.plan.pensions ?? [];
  const dbRows = state.plan.definedBenefits ?? [];
  const validEntities = ["all", ...pensions.map((pn) => pn.id), ...dbRows.map((db) => db.id)];
  if (!validEntities.includes(pensionEntity)) pensionEntity = "all"; // entity removed
  renderEntitySelector(
    els.pensionEntity,
    [
      { id: "all", label: "Consolidated" },
      ...pensions.map((pn) => ({ id: pn.id, label: pn.name })),
      ...dbRows.map((db) => ({ id: db.id, label: `${db.name} (DB)` })),
    ],
    pensionEntity,
    (id) => { pensionEntity = id; renderPensionTableView(); }
  );
  // TBA-credit footnotes render outside renderTransposed's own
  // per-group rows (a distinct, always-visible note, never a ledger
  // figure a period selector could hide) — every DB pension's own note
  // when consolidated, just the selected one's when drilled into.
  const relevantDbs = pensionEntity === "all" ? dbRows : dbRows.filter((db) => db.id === pensionEntity);
  const footerHTML = relevantDbs.map(dbTbaCreditNote).join("");
  renderTransposed(els.pensionTable, buildPensionGroups(pensionEntity), footerHTML);
}

// --- View: Death benefits (spec 22, Commit 3) -------------------------------
//
// A TERMINAL figure — the FINAL projection year alone, per person, per
// account (deterministic.js's own deathBenefitDetail, spec 22 Commits
// 1-2) — never a year-by-year ledger, so this deliberately does NOT go
// through renderTransposed's year-columns machinery; a plain table
// instead, the same choice Snapshot/Focus views already make when the
// data isn't a year series.
const DEATH_BENEFIT_RELATIONSHIP_LABELS = {
  spouse: "Spouse", adultChild: "Adult child", minorChild: "Minor child",
  interdependent: "Interdependent", financialDependant: "Financial dependant", estate: "Estate",
};

function deathBenefitRowsHTML(label, detail) {
  const beneficiaryRows = (detail?.byBeneficiary ?? []).flatMap((b) => b.accounts.map((a) => {
    const net = a.taxFree + a.taxableTaxed + a.taxableUntaxed - a.tax;
    return `<tr>
      <td>${escapeHTML(label)}</td><td>${escapeHTML(a.accountName)}</td>
      <td>${escapeHTML(b.label)} (${escapeHTML(DEATH_BENEFIT_RELATIONSHIP_LABELS[b.relationship] ?? b.relationship)})</td>
      <td class="tl-num">${b.sharePct}%</td>
      <td class="tl-num">${fmtLedgerCell(a.taxFree)}</td>
      <td class="tl-num">${fmtLedgerCell(a.taxableTaxed)}</td>
      <td class="tl-num">${fmtLedgerCell(a.taxableUntaxed)}</td>
      <td class="tl-num">${fmtLedgerCell(a.tax)}</td>
      <td class="tl-num">${fmtLedgerCell(net)}</td>
    </tr>`;
  }));
  const reversionaryRows = (detail?.reversionaryPensions ?? []).map((rp) => `<tr>
      <td>${escapeHTML(label)}</td><td>${escapeHTML(rp.pensionName)}</td>
      <td>Reversionary — continues to spouse</td>
      <td class="tl-num">—</td>
      <td class="tl-num">${fmtLedgerCell(rp.valueAtDeath)}</td>
      <td class="tl-num">–</td><td class="tl-num">–</td><td class="tl-num">–</td>
      <td class="tl-num">${fmtLedgerCell(rp.valueAtDeath)}</td>
    </tr>`);
  if (beneficiaryRows.length === 0 && reversionaryRows.length === 0) {
    return `<tr><td colspan="9" class="helper-text">No beneficiaries nominated for ${escapeHTML(label)}.</td></tr>`;
  }
  return beneficiaryRows.join("") + reversionaryRows.join("");
}

function buildDeathBenefitsTableHTML() {
  const yl = projection.yearly;
  const final = yl[yl.length - 1];
  const d = final.deathBenefitDetail ?? { client: null, partner: null };
  const fyLabel = projection.schedule.fyLabels[yl.length - 1];
  const rows = deathBenefitRowsHTML(clientName(), d.client)
    + (isCouple() ? deathBenefitRowsHTML(partnerName(), d.partner) : "");
  const reversionaryTotal = (arr) => (arr ?? []).reduce((s, r) => s + r.valueAtDeath, 0);
  const householdGross = (d.client?.totals.gross ?? 0) + (d.partner?.totals.gross ?? 0)
    + reversionaryTotal(d.client?.reversionaryPensions) + reversionaryTotal(d.partner?.reversionaryPensions);
  const householdTax = (d.client?.totals.tax ?? 0) + (d.partner?.totals.tax ?? 0);
  return `
    <p class="helper-text">The tax outcome IF the super/pension balance passed to these beneficiaries at the FINAL projection year (${escapeHTML(fyLabel ?? "")}, age ${final.clientAge ?? ""}) — a planning figure, not partner-death modelling; no projection branch. Nominate beneficiaries per person via each person's Tax details section.</p>
    <div class="tl-wrap">
      <table class="tl">
        <thead><tr>
          <th class="tl-label">Person</th><th class="tl-label">Account</th><th class="tl-label">Beneficiary</th>
          <th>Share</th><th>Tax-free</th><th>Taxable (taxed)</th><th>Taxable (untaxed)</th><th>Tax</th><th>Net received</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="tl-total">
          <th class="tl-label" colspan="7">Household total</th>
          <th class="tl-num">${fmtLedgerCell(householdTax)}</th>
          <th class="tl-num">${fmtLedgerCell(householdGross - householdTax)}</th>
        </tr></tfoot>
      </table>
    </div>
  `;
}

function renderDeathBenefitsTableView() {
  els.deathBenefitsTable.innerHTML = buildDeathBenefitsTableHTML();
}

function exportDeathBenefitsCSV() {
  const yl = projection.yearly;
  const final = yl[yl.length - 1];
  const d = final.deathBenefitDetail ?? { client: null, partner: null };
  const lines = [["Person", "Account", "Beneficiary", "Relationship", "Share %", "Tax-free", "Taxable (taxed)", "Taxable (untaxed)", "Tax", "Net received"].map(csvEsc).join(",")];
  const addPerson = (label, detail) => {
    for (const b of detail?.byBeneficiary ?? []) {
      for (const a of b.accounts) {
        const net = a.taxFree + a.taxableTaxed + a.taxableUntaxed - a.tax;
        lines.push([label, a.accountName, b.label, DEATH_BENEFIT_RELATIONSHIP_LABELS[b.relationship] ?? b.relationship, b.sharePct, a.taxFree.toFixed(2), a.taxableTaxed.toFixed(2), a.taxableUntaxed.toFixed(2), a.tax.toFixed(2), net.toFixed(2)].map(csvEsc).join(","));
      }
    }
    for (const rp of detail?.reversionaryPensions ?? []) {
      lines.push([label, rp.pensionName, "Reversionary — continues to spouse", "", "", rp.valueAtDeath.toFixed(2), "0.00", "0.00", "0.00", rp.valueAtDeath.toFixed(2)].map(csvEsc).join(","));
    }
  };
  addPerson(clientName(), d.client);
  if (isCouple()) addPerson(partnerName(), d.partner);
  downloadCSV("death-benefits", lines);
}

// --- Focus: Death benefits (spec 22, Commit 3) ------------------------------
//
// Non-prescriptive (locked convention, and the spec's own words for
// this feature): reports the tax difference and constraints under
// alternative nominations and under an actually-modelled re-contribution
// — never labels a nomination or the strategy as "better".
function renderFocusDeathBenefitsView() {
  const yl = projection.yearly;
  const final = yl[yl.length - 1];
  const d = final.deathBenefitDetail ?? { client: null, partner: null };
  const anyDetail = d.client || d.partner;
  if (!anyDetail) {
    els.viewFocusDeathBenefits.innerHTML = focusEmptyStateHTML(
      "The tax cost of the current nomination against alternatives, once at least one beneficiary is nominated (each person's Tax details section) or a reversionary pension exists.",
      "tax-details"
    );
    return;
  }

  const alternativesSectionHTML = (label, detail) => {
    const alts = alternativeNominations(detail);
    if (!alts) return "";
    const rows = alts.map((a) => `<tr><td>${escapeHTML(DEATH_BENEFIT_RELATIONSHIP_LABELS[a.relationship] ?? a.relationship)}</td>
      <td class="tl-num">${fmtLedgerCell(a.tax)}</td><td class="tl-num">${fmtLedgerCell(a.net)}</td></tr>`).join("");
    return `
      <div class="focus-section">
        <h3>${escapeHTML(label)} — if the WHOLE balance instead went to a single beneficiary type</h3>
        <p class="helper-text">Same underlying balance (${fmtLedgerCell(detail.totals.gross)} gross) each time — only the tax changes with who receives it.</p>
        <table class="tl"><thead><tr><th class="tl-label">If nominated as</th><th>Tax</th><th>Net received</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
    `;
  };

  const withdrawals = state.cashflows.superWithdrawals ?? [];
  const nccContributions = (state.cashflows.superContributions ?? []).filter((c) => c.type === "personalNonDeductible");
  const recontributionSectionHTML = (withdrawals.length && nccContributions.length) ? `
    <div class="focus-section">
      <h3>Re-contribution strategy — with vs without an actually-modelled withdrawal + contribution</h3>
      <p class="helper-text">Withdrawing a taxable amount after 60 and re-contributing it as a non-concessional contribution converts taxable component to tax-free — pick the withdrawal and contribution rows already in this scenario that model it.</p>
      <div class="person-grid">
        <div class="cf-cell">
          <label>Withdrawal</label>
          <select id="recontributionWithdrawalSelect">
            <option value="">Select…</option>
            ${withdrawals.map((w) => `<option value="${w.id}"${w.id === recontributionSelection.withdrawalId ? " selected" : ""}>${escapeHTML(w.label || "Withdrawal")}</option>`).join("")}
          </select>
        </div>
        <div class="cf-cell">
          <label>Non-concessional contribution</label>
          <select id="recontributionContributionSelect">
            <option value="">Select…</option>
            ${nccContributions.map((c) => `<option value="${c.id}"${c.id === recontributionSelection.contributionId ? " selected" : ""}>${escapeHTML(c.label || "Contribution")}</option>`).join("")}
          </select>
        </div>
      </div>
      <div id="recontributionResult"></div>
    </div>
  ` : "";

  els.viewFocusDeathBenefits.innerHTML = `
    <h2 class="section-heading">Death benefits</h2>
    <div class="focus-panel">
      ${d.client ? alternativesSectionHTML(clientName(), d.client) : ""}
      ${d.partner ? alternativesSectionHTML(partnerName(), d.partner) : ""}
      ${recontributionSectionHTML}
    </div>
  `;

  if (recontributionSectionHTML) {
    $("recontributionWithdrawalSelect").addEventListener("change", (e) => {
      recontributionSelection.withdrawalId = e.target.value || null;
      renderRecontributionResult();
    });
    $("recontributionContributionSelect").addEventListener("change", (e) => {
      recontributionSelection.contributionId = e.target.value || null;
      renderRecontributionResult();
    });
    renderRecontributionResult();
  }
}

// Persisted only for the life of this render pass — a lightweight UI
// selection, not plan state (the withdrawal/contribution rows
// themselves are the real, already-modelled strategy; this just picks
// WHICH ones to compare).
let recontributionSelection = { withdrawalId: null, contributionId: null };

function renderRecontributionResult() {
  const el = $("recontributionResult");
  if (!el) return;
  const { withdrawalId, contributionId } = recontributionSelection;
  if (!withdrawalId || !contributionId) { el.innerHTML = ""; return; }
  const withdrawal = (state.cashflows.superWithdrawals ?? []).find((w) => w.id === withdrawalId);
  const owner = withdrawal?.owner === "partner" ? "partner" : "client";
  const result = buildRecontributionFocus({ state, owner, withdrawalId, contributionId });
  if (!result) { el.innerHTML = `<p class="helper-text">Couldn't find that withdrawal/contribution pair in the current plan.</p>`; return; }
  el.innerHTML = `
    <p class="helper-text">
      ${result.cannotHelp
        ? "Every nominated beneficiary for this person is already a tax dependant — re-contribution changes nothing, since a dependant pays no death benefit tax regardless of component."
        : `Death benefit tax with this re-contribution modelled: ${fmtLedgerCell(result.withTax)}. Without it: ${fmtLedgerCell(result.withoutTax)}. Difference: ${fmtLedgerCell(result.taxSaved)}.`}
    </p>
  `;
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
    // Surplus and deficit allocation spec, Commit 3: a repayment the
    // FY-end surplus sweep made — via the automatic pay-non-deductible-
    // debt-first step, an explicit period allocation, or both combined
    // — is a different DECISION from an "Extra repayments" row the
    // client entered directly, so it gets its own line rather than
    // folding into that figure. Zero (and so hidden by the all-zero-
    // rows convention) for a loan no period ever routed surplus to.
    { label: "Surplus-driven repayment", cell: (y) => -(get(y).surplusRepayment ?? 0) },
    { label: "Offset balance applied", cell: (y) => get(y).offsetApplied },
    // Fixed-rate rollover (Implementation/Rates spec, Commit 1) — the
    // nominal annual rate actually applying that year. Suppressed in
    // the "Combined" (all-loans-summed) view: summing a PERCENTAGE
    // across loans is meaningless, unlike every other row here which is
    // a genuine dollar figure. A HELP/HECS row (opts.help) genuinely
    // shows 0% throughout — it charges no interest, only indexation
    // (its own row above).
    ...(opts.combined ? [] : [{ label: "Interest rate (% p.a., nominal)", cell: (y) => get(y).ratePct ?? 0, pct: true }]),
    // Drawdowns and dynamic deductibility (spec 24, Commit 3) — the
    // point of the whole feature, invisible otherwise: how much of
    // THIS loan's balance is currently investment- vs private-purpose.
    // investmentBalance/privateBalance are reported for every liability
    // regardless of whether it ever drew down (deterministic.js derives
    // them from the STATIC opening split when dynamic tracking never
    // engaged), so this row is meaningful even for a plain part-
    // deductible loan. Summing across loans in the combined view still
    // means something (a household-wide blended proportion), unlike
    // the interest rate above — so it isn't excluded there.
    {
      label: "Deductible proportion", pct: true,
      cell: (y) => {
        const d = get(y);
        const total = (d.investmentBalance ?? 0) + (d.privateBalance ?? 0);
        return total > 0 ? (d.investmentBalance / total) * 100 : 0;
      },
    },
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
  const zero = {
    opening: 0, drawdown: 0, interest: 0, principal: 0, offsetApplied: 0, closing: 0, extraRepayment: 0,
    surplusRepayment: 0, indexation: 0, ratePct: 0, investmentBalance: 0, privateBalance: 0,
  };

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

// --- View: Bonds (spec 25, Commit 2) ----------------------------------------
//
// Per bond per year: opening + contributions + earnings − internalTax
// − withdrawals = closing, plus the assessable portion of any
// withdrawal (the real cost of tapping an unmatured bond, shown rather
// than hidden), years to the ten-year date, and the current 125%
// contribution headroom — every figure read straight off
// row.bondDetail, nothing re-derived here. yearsToMaturity/
// contributionHeadroom are suppressed in the combined view (summing a
// YEAR COUNT or a $ headroom across bonds with different clocks is
// meaningless), same reasoning as Liabilities' own interest-rate row.

function bondDetailRows(get, opts = {}) {
  return [
    { label: "Opening balance", cell: (y) => get(y).opening, always: true },
    { label: "Contributions", cell: (y) => get(y).contributions },
    { label: "Earnings", cell: (y) => get(y).earnings },
    { label: "Internal tax (30% less franking benefit)", cell: (y) => -get(y).internalTax },
    { label: "Withdrawals", cell: (y) => -get(y).withdrawals },
    { label: "— of which assessable (pre-ten-year earnings)", cell: (y) => get(y).assessableWithdrawal },
    ...(opts.combined ? [] : [
      { label: "Years to the ten-year date", cell: (y) => get(y).yearsToMaturity ?? 0 },
      { label: "125% contribution headroom next FY", cell: (y) => get(y).contributionHeadroom ?? 0 },
    ]),
  ];
}

function bondName(id) {
  return (state.bonds ?? []).find((b) => b.id === id)?.name ?? "Bond";
}

function buildBondsGroups(entity) {
  const yl = projection.yearly;
  const bondIds = Object.keys(yl[0]?.bondDetail ?? {});
  const zero = {
    opening: 0, contributions: 0, earnings: 0, internalTax: 0, withdrawals: 0, assessableWithdrawal: 0,
    closing: 0, costBase: 0, yearsToMaturity: 0, contributionHeadroom: 0,
  };

  if (entity === "all") {
    const combined = bondDetailRows((y) => bondIds.reduce((s, bid) => {
      const d = yl[y].bondDetail[bid] ?? zero;
      for (const k in s) s[k] += d[k] ?? 0;
      return s;
    }, { ...zero }), { combined: true });
    combined.push({ label: "Closing balance", cell: (y) => yl[y].bondsClosing, always: true, cls: "tl-total" });
    const closingRow = (bid) => ({ label: bondName(bid), cell: (y) => yl[y].bondDetail[bid]?.closing ?? 0 });
    const byBond = bondIds.map(closingRow);
    byBond.push({ label: "Total", cell: (y) => yl[y].bondsClosing, always: true, cls: "tl-total" });
    return [
      { title: "Combined", rows: combined },
      { title: "Closing balance by bond", rows: byBond },
    ];
  }

  const name = bondName(entity);
  const rows = bondDetailRows((y) => yl[y].bondDetail[entity] ?? zero);
  rows.push({ label: "Closing balance", cell: (y) => (yl[y].bondDetail[entity] ?? zero).closing, always: true, cls: "tl-total" });
  return [{ title: name, rows }];
}

function renderBondsView() {
  const bondIds = Object.keys(projection.yearly[0]?.bondDetail ?? {});
  if (bondIds.length === 0) {
    els.bondsEntity.innerHTML = "";
    els.bondsTable.innerHTML = focusEmptyStateHTML(
      "Per-bond opening, contributions, earnings, internal tax, withdrawals and the ten-year/125% clocks — add an investment or education bond to see it.",
      "financial-assets"
    );
    return;
  }
  if (bondsEntity !== "all" && !bondIds.includes(bondsEntity)) {
    bondsEntity = "all"; // entity was removed/excluded
  }
  renderEntitySelector(
    els.bondsEntity,
    [{ id: "all", label: "Consolidated" }, ...bondIds.map((bid) => ({ id: bid, label: bondName(bid) }))],
    bondsEntity,
    (id) => { bondsEntity = id; renderBondsView(); }
  );
  renderTransposed(els.bondsTable, buildBondsGroups(bondsEntity));
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

// Client/Partner/Consolidated selector (spec 17 Commit 3) — Snapshot
// already computed all three sub-values via cashflowStatement's own
// forOwner mechanism (buildSnapshotColumns); this projects that result
// down to whichever one the selector shows. buildSnapshotTable/
// snapshotToHTML/snapshotToCSV are unchanged — in single-entity mode
// they're simply called the same way a single-person household already
// calls them (reading only `.total`), so the well-tested snapshot.js
// module needed no changes at all.
function snapshotColumnsForEntity(columns, entity) {
  if (entity === "all") return columns;
  return columns.map((c) => {
    const chosen = entity === "client" ? c.client : c.partner;
    return { y: c.y, client: chosen, partner: null, total: chosen };
  });
}

function renderSnapshotView() {
  ensureSnapshotYears();
  renderSnapshotYearPicker();
  const planYears = snapshotResolvedPlanYears();
  const couple = isCouple();
  if (snapshotPersonEntity !== "all" && !couple) snapshotPersonEntity = "all";
  renderPersonSelector(els.snapshotPersonSelector, snapshotPersonEntity, (id) => { snapshotPersonEntity = id; renderSnapshotView(); });
  const showAll = snapshotPersonEntity === "all";
  const rawColumns = buildSnapshotColumns(projection.yearly, snapshotCtxFor, planYears, couple);
  const columns = snapshotColumnsForEntity(rawColumns, snapshotPersonEntity);
  if (columns.length === 0) {
    els.snapshotTable.innerHTML = `<p class="helper-text" style="padding:24px 8px;">Add at least one year above to see the snapshot.</p>`;
    return;
  }
  const table = buildSnapshotTable(columns, { hideEmptyRows: state.display.hideEmptyRows !== false });
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const headCols = columns.flatMap((c) => {
    const label = projection.schedule.fyLabels[c.y];
    return showAll && couple ? [`${label} — ${clientName()}`, `${label} — ${partnerName()}`, `${label} — Total`] : [label];
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
      return showAll && couple
        ? `<td class="tl-num">${fmtLedgerCell(cell.client * f)}</td><td class="tl-num">${fmtLedgerCell(cell.partner * f)}</td><td class="tl-num">${fmtLedgerCell(cell.total * f)}</td>`
        : `<td class="tl-num">${fmtLedgerCell(cell.total * f)}</td>`;
    }).join("");
    return sectionRow + `<tr class="${r.total ? "tl-total" : ""}"><th class="tl-label">${escapeHTML(r.label)}</th>${cells}</tr>`;
  }).join("");
  els.snapshotTable.innerHTML = `<div class="tl-wrap"><table class="tl"><thead>${head}</thead><tbody>${body}</tbody></table></div>${adjustmentsDisclosureFooter()}`;
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
  const showAll = snapshotPersonEntity === "all";
  const rawColumns = buildSnapshotColumns(projection.yearly, snapshotCtxFor, planYears, couple);
  const columns = snapshotColumnsForEntity(rawColumns, snapshotPersonEntity);
  const scaled = columns.map((c) => {
    const f = factorFor(c.y);
    const scaleStmt = (s) => s && JSON.parse(JSON.stringify(s), (k, v) => typeof v === "number" ? v * f : v);
    return { y: c.y, client: scaleStmt(c.client), partner: scaleStmt(c.partner), total: scaleStmt(c.total) };
  });
  // The export's own couple flag drives its 3-column-vs-1-column
  // choice (snapshotToHTML/snapshotToCSV) — a specific person selected
  // is presented the same way a single-person household already is.
  return { table: buildSnapshotTable(scaled, { hideEmptyRows: state.display.hideEmptyRows !== false }), couple: showAll && couple };
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
    // Adjustment rows (spec 18 Commit 3) — appended at the call site
    // rather than inside snapshot.js's own pure HTML builder, so that
    // module stays free of main.js's plan-level state.
    const html = snapshotToHTML(table, snapshotColumnLabels(), couple) + adjustmentsDisclosureFooter();
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

// entity ("all" | "client" | "partner", spec 17 Commit 3) — this view
// was already fully split per person (row.taxDetail.client/.partner);
// the selector just picks which of the existing groups render. The
// Household group (Div 293/296/HELP/MLS/FHSSS totals, already summed
// across both people on the row) has no per-person figure to show —
// it's the spec's own "show it in all three modes with a note" case.
function buildTaxGroups(entity = "all") {
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
  // Adjustment rows (spec 18 Commit 2) — unlike cashflowStatement.js's
  // stmt(), taxDetail's own per-component fields (incomeTax/medicare/
  // help/cgt) are NEVER touched by an adjustment (deterministic.js
  // settles tax.* adjustments as a lump-sum cash effect via spreadTax,
  // not into these fields) — so td(y,p)?.X is already exactly the
  // "Computed" figure, and adjustmentAmountFor supplies the sign-matched
  // Adjustment; adjustableRow derives Total as their sum.
  const personGroup = (p, title) => ({
    title,
    rows: [
      { label: "Taxable income", cell: (y) => td(y, p)?.taxableIncome ?? 0 },
      { label: "Gross tax", cell: (y) => -(td(y, p)?.grossTax ?? 0) },
      ...adjustableRow(
        "Medicare levy", (y) => -(td(y, p)?.medicare ?? 0), (y) => -adjustmentAmountFor(y, "tax.medicare", p),
        "tax.medicare", p
      ),
      { label: "LITO", cell: (y) => td(y, p)?.lito ?? 0 },
      { label: "Franking credits", cell: (y) => td(y, p)?.frankingCredits ?? 0 },
      { label: "Excess concessional super contributions", cell: (y) => td(y, p)?.excessConcessionalContributions ?? 0 },
      { label: "Excess concessional contributions offset (15%)", cell: (y) => td(y, p)?.excessCcOffset ?? 0 },
      ...adjustableRow(
        "Net income tax", (y) => -(td(y, p)?.incomeTax ?? 0), (y) => -adjustmentAmountFor(y, "tax.incomeTax", p),
        "tax.incomeTax", p, { cls: "tl-total" }
      ),
      ...adjustableRow(
        "CGT payable", (y) => -(td(y, p)?.cgt ?? 0), (y) => -adjustmentAmountFor(y, "tax.cgt", p),
        "tax.cgt", p
      ),
      { label: "Division 293 tax payable", cell: (y) => -(td(y, p)?.div293 ?? 0) },
      { label: "Division 296 tax payable", cell: (y) => -(td(y, p)?.div296 ?? 0) },
      { label: "Division 293/296 — paid from", text: true, cell: (y) => divPaidFromText(y, p) },
      { label: "Quarantined rental losses (carried)", cell: (y) => td(y, p)?.quarantinedLossCarry ?? 0 },
      ...adjustableRow(
        "HELP repayment", (y) => -(td(y, p)?.helpRepayment ?? 0), (y) => -adjustmentAmountFor(y, "tax.help", p),
        "tax.help", p
      ),
      { label: "HELP balance (closing)", cell: (y) => td(y, p)?.helpBalanceClosing ?? 0 },
      { label: "Medicare levy surcharge", cell: (y) => -(td(y, p)?.medicareLevySurcharge ?? 0) },
      { label: "FHSSS release (gross)", cell: (y) => td(y, p)?.fhsssRelease ?? 0 },
      { label: "FHSSS tax offset (30%)", cell: (y) => td(y, p)?.fhsssOffset ?? 0 },
      { label: "Taxable pension component", cell: (y) => td(y, p)?.taxablePensionComponent ?? 0 },
      { label: "Taxable pension offset (TTR, 15%)", cell: (y) => td(y, p)?.ttrPensionOffset ?? 0 },
      // Transfer balance account (spec 20, Commit 4/5) — a snapshot at
      // this FY's end, not a flow: the running credited-minus-debited
      // balance against the person's own (proportionally-indexed)
      // personal cap, and remaining headroom (a breach shows 0
      // headroom, not negative — see deterministic.js's own header).
      { label: "Transfer balance account", cell: (y) => yl[y].transferBalance?.[p]?.balance ?? 0 },
      { label: "Transfer balance personal cap", cell: (y) => yl[y].transferBalance?.[p]?.personalCap ?? 0 },
      { label: "Transfer balance remaining cap", cell: (y) => yl[y].transferBalance?.[p]?.remainingCap ?? 0 },
    ],
  });
  const groups = [];
  if (entity === "all" || entity === "client") groups.push(personGroup("client", clientName()));
  if (isCouple() && (entity === "all" || entity === "partner")) groups.push(personGroup("partner", partnerName()));
  groups.push({
    title: entity === "all" ? "Household" : "Household (not split by person)",
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
  if (taxPersonEntity !== "all" && !isCouple()) taxPersonEntity = "all";
  renderPersonSelector(els.taxEntity, taxPersonEntity, (id) => { taxPersonEntity = id; renderTaxView(); });
  const note = `<p class="chart-note-inline">Income tax rows accrue in the year shown (spread through the year, PAYG-style). CGT, Division 293 and Division 296 payable show the year of <em>payment</em> — each is assessed in one year and paid the following July.</p>`;
  renderTransposed(els.taxTable, buildTaxGroups(taxPersonEntity), note + accruedCgtFooter() + accruedDiv293Footer() + accruedDiv296Footer() + adjustmentsDisclosureFooter());
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

// --- Debt recycling (spec 24, Commit 3) -------------------------------------
//
// Every figure below is read straight off `projection` (and a SEPARATE
// real projectPlan() run with recycling switched off) via
// src/focusDebtRecycling.js's buildDebtRecyclingFocus — this file only
// renders it. The strategy's own risk — the benefit depends on the
// destination investment's return beating the after-tax cost of
// carrying a larger loan — is stated here, in the view, not just
// implied by the chart; non-prescriptive, as always: this shows what
// the plan's own numbers do, it recommends nothing.
let focusDebtRecyclingLoanId = null;

function renderFocusDebtRecyclingView() {
  const emptyMsg = "How a debt recycling plan converts non-deductible debt into deductible debt over time — the tax saved, the investment it builds, and when (if ever) it catches up to not recycling at all — add a loan with debt recycling enabled to see it.";
  const loans = eligibleDebtRecyclingLoans(state);
  if (loans.length === 0) {
    els.viewFocusDebtRecycling.innerHTML = focusEmptyStateHTML(emptyMsg, "liabilities");
    return;
  }
  if (!loans.some((l) => l.id === focusDebtRecyclingLoanId)) {
    focusDebtRecyclingLoanId = loans[0].id;
  }
  const f = buildDebtRecyclingFocus({ out: projection, state, liabilityId: focusDebtRecyclingLoanId });
  if (!f) {
    els.viewFocusDebtRecycling.innerHTML = focusEmptyStateHTML(emptyMsg, "liabilities");
    return;
  }
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const breakEvenLine = f.breakEven
    ? `${escapeHTML(f.breakEven.fyLabel)} (age ${f.breakEven.age})`
    : "Not reached within this projection";

  els.viewFocusDebtRecycling.innerHTML = `
    <h2 class="section-heading">Debt recycling</h2>
    ${loans.length > 1 ? `<div id="focusDebtRecyclingEntity" class="seg-toggle entity-select" role="tablist" aria-label="Loan"></div>` : ""}
    <div class="focus-panel">
      <div class="focus-section">
        <p class="helper-warning">Debt recycling replaces non-deductible debt with deductible debt by redrawing repaid principal into an investment. The extra tax-deductible interest is not a free benefit: it comes with a larger ongoing loan balance than paying the loan off outright would leave, and whether it's worthwhile depends on the destination investment's own return exceeding the after-tax cost of that extra debt. Nothing here recommends the strategy — it shows what this plan's own numbers do, against the same plan without it.</p>
      </div>
      <div class="focus-section">
        <h3>${escapeHTML(f.liability.name)}</h3>
        <div class="summary-strip">
          <div class="stat stat-headline"><div class="stat-label">Net worth catches up to not recycling</div><div class="stat-value">${breakEvenLine}</div></div>
          <div class="stat"><div class="stat-label">Deductible interest this year</div><div class="stat-value">${fmtMoney(f.series[0].deductibleInterest * factor(0))}</div></div>
          <div class="stat"><div class="stat-label">Extra tax saved this year</div><div class="stat-value">${fmtMoney(f.series[0].taxSaved * factor(0))}</div></div>
        </div>
      </div>
      <div class="focus-section">
        <h3>Total loan balance: recycling vs not</h3>
        <div id="focusDebtRecyclingDebtChart"></div>
      </div>
      <div class="focus-section">
        <h3>Destination investment: recycling vs not</h3>
        <div id="focusDebtRecyclingInvestChart"></div>
      </div>
    </div>
  `;
  if (loans.length > 1) {
    renderEntitySelector(
      $("focusDebtRecyclingEntity"),
      loans.map((l) => ({ id: l.id, label: l.name })),
      focusDebtRecyclingLoanId,
      (id) => { focusDebtRecyclingLoanId = id; renderFocusDebtRecyclingView(); }
    );
  }
  renderFocusDebtRecyclingCharts(f, factor);
}

function focusDebtRecyclingChartLayout(ages, yTitle) {
  return {
    margin: { l: 70, r: 20, t: 24, b: 40 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `${yTitle} (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  };
}

function renderFocusDebtRecyclingCharts(f, factor) {
  const debtEl = $("focusDebtRecyclingDebtChart");
  const investEl = $("focusDebtRecyclingInvestChart");
  if (typeof Plotly === "undefined") {
    if (debtEl) debtEl.innerHTML = chartUnavailableHTML();
    if (investEl) investEl.innerHTML = chartUnavailableHTML();
    return;
  }
  const ages = f.series.map((r) => r.age);
  if (debtEl) {
    Plotly.react(debtEl, [
      {
        x: ages, y: f.series.map((r) => r.totalDebt * factor(r.year)), name: "With recycling",
        type: "scatter", mode: "lines", line: { color: "rgb(28, 90, 180)", width: 2 },
        hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>With recycling</extra>",
      },
      {
        x: ages, y: f.series.map((r) => r.totalDebtWithout * factor(r.year)), name: "Without recycling",
        type: "scatter", mode: "lines", line: { color: "rgb(217, 90, 40)", width: 2, dash: "dash" },
        hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Without recycling</extra>",
      },
    ], focusDebtRecyclingChartLayout(ages, "Total loan balance"), { displayModeBar: false, responsive: true });
  }
  if (investEl) {
    Plotly.react(investEl, [
      {
        x: ages, y: f.series.map((r) => r.investmentBalance * factor(r.year)), name: "With recycling",
        type: "scatter", mode: "lines", line: { color: "rgb(28, 90, 180)", width: 2 },
        hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>With recycling</extra>",
      },
      {
        x: ages, y: f.series.map((r) => r.investmentBalanceWithout * factor(r.year)), name: "Without recycling",
        type: "scatter", mode: "lines", line: { color: "rgb(217, 90, 40)", width: 2, dash: "dash" },
        hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Without recycling</extra>",
      },
    ], focusDebtRecyclingChartLayout(ages, "Destination investment balance"), { displayModeBar: false, responsive: true });
  }
}

function exportFocusDebtRecyclingCSV() {
  const f = buildDebtRecyclingFocus({ out: projection, state, liabilityId: focusDebtRecyclingLoanId });
  if (!f) return;
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lines = [
    ["Section", "Item", "Value"].map(csvEsc).join(","),
    [csvEsc(f.liability.name), csvEsc("Net worth catches up to not recycling"), csvEsc(f.breakEven ? `${f.breakEven.fyLabel} (age ${f.breakEven.age})` : "Not reached within this projection")].join(","),
  ];
  lines.push("", [
    "Year", "Age", "FY",
    "Deductible interest (with)", "Deductible interest (without)", "Extra tax saved",
    "Total debt (with)", "Total debt (without)",
    "Investment balance (with)", "Investment balance (without)",
  ].map(csvEsc).join(","));
  for (const r of f.series) {
    const fac = factor(r.year);
    lines.push([
      r.year, r.age, csvEsc(r.fyLabel),
      (r.deductibleInterest * fac).toFixed(2), (r.deductibleInterestWithout * fac).toFixed(2), (r.taxSaved * fac).toFixed(2),
      (r.totalDebt * fac).toFixed(2), (r.totalDebtWithout * fac).toFixed(2),
      (r.investmentBalance * fac).toFixed(2), (r.investmentBalanceWithout * fac).toFixed(2),
    ].join(","));
  }
  downloadCSV("focus-debt-recycling", lines);
}

// --- Education funding (spec 25, Commit 3) ----------------------------------
//
// "The same dollars, three ways" — every figure below is read straight
// off THREE real projectPlan() runs (buildEducationFundingFocus, on
// clones per the Focus governing principle): the same seed lump sum
// and the same already-modelled fee schedule, held in an ordinary
// asset, a plain investment bond, and an education bond respectively.
// This file only renders it. The risk disclosure (ten-year rule,
// 125% rule, the bond's own flat internal rate) is shown prominently,
// not buried — and the worse-than-alternative flags are surfaced
// exactly as computed, never softened or hidden, per the spec's own
// "the tool exists to reveal that, not to sell the product."

let focusEducationFundingChildId = null;

function focusEducationFundingFlagsHTML(f) {
  const lines = [];
  if (f.flags.investmentWorseThanBaseline) {
    lines.push(`<p class="helper-warning">For this client, a plain investment bond ends up WORSE than simply saving the same amount outside one.</p>`);
  }
  if (f.flags.educationWorseThanBaseline) {
    lines.push(`<p class="helper-warning">For this client, the education bond — even with its own benefit — ends up WORSE than simply saving the same amount outside one.</p>`);
  }
  return lines.join("");
}

function renderFocusEducationFundingView() {
  const children = eligibleEducationFundingChildren(state);
  const emptyMsg = "The same dollars, three ways — saved outside a bond, in a plain investment bond, or in an education bond with its own benefit — the net cost of funding the same school fees under each, with the tax paid along the way. Add a child with a school fee schedule to see it.";
  if (children.length === 0) {
    els.viewFocusEducationFunding.innerHTML = focusEmptyStateHTML(emptyMsg, "children");
    return;
  }
  if (!children.some((c) => c.id === focusEducationFundingChildId)) {
    focusEducationFundingChildId = children[0].id;
  }
  const f = buildEducationFundingFocus({ out: projection, state, childId: focusEducationFundingChildId });
  if (!f) {
    els.viewFocusEducationFunding.innerHTML = focusEmptyStateHTML(emptyMsg, "children");
    return;
  }
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const last = f.series[f.series.length - 1];

  els.viewFocusEducationFunding.innerHTML = `
    <h2 class="section-heading">Education funding</h2>
    ${children.length > 1 ? `<div id="focusEducationFundingEntity" class="seg-toggle entity-select" role="tablist" aria-label="Child"></div>` : ""}
    <div class="focus-panel">
      <div class="focus-section">
        <p class="helper-warning">${escapeHTML(f.disclosure)}</p>
      </div>
      ${focusEducationFundingFlagsHTML(f)}
      <div class="focus-section">
        <h3>${escapeHTML(f.child.name)} — same seed, three vehicles</h3>
        <div class="summary-strip">
          <div class="stat stat-headline"><div class="stat-label">Seed (same in all three)</div><div class="stat-value">${fmtMoney(f.seed)}</div></div>
          <div class="stat"><div class="stat-label">Ending net worth — outside a bond</div><div class="stat-value">${fmtMoney(last.netAssetsBaseline * factor(last.year))}</div></div>
          <div class="stat"><div class="stat-label">Ending net worth — investment bond</div><div class="stat-value">${fmtMoney(last.netAssetsInvestment * factor(last.year))}</div></div>
          <div class="stat"><div class="stat-label">Ending net worth — education bond</div><div class="stat-value">${fmtMoney(last.netAssetsEducation * factor(last.year))}</div></div>
        </div>
      </div>
      <div class="focus-section">
        <h3>Net worth over time, by vehicle</h3>
        <div id="focusEducationFundingChart"></div>
      </div>
      <div class="focus-section">
        <h3>Tax paid along the way (cumulative)</h3>
        <div id="focusEducationFundingTaxChart"></div>
      </div>
    </div>
  `;
  if (children.length > 1) {
    renderEntitySelector(
      $("focusEducationFundingEntity"),
      children.map((c) => ({ id: c.id, label: c.name })),
      focusEducationFundingChildId,
      (id) => { focusEducationFundingChildId = id; renderFocusEducationFundingView(); }
    );
  }
  renderFocusEducationFundingCharts(f, factor);
}

function focusEducationFundingChartLayout(ages, yTitle) {
  return {
    margin: { l: 70, r: 20, t: 24, b: 40 },
    paper_bgcolor: "white", plot_bgcolor: "white",
    hovermode: "x unified", showlegend: true,
    legend: { orientation: "h", y: -0.2, x: 0.5, xanchor: "center" },
    xaxis: { title: "Age", showgrid: false, zeroline: false, dtick: ages.length > 20 ? 5 : 1 },
    yaxis: {
      title: { text: `${yTitle} (${isNominal() ? "future" : "today's"} dollars)`, standoff: 10 },
      tickformat: "$,.2s", gridcolor: "rgba(0,0,0,0.06)", zeroline: false, rangemode: "tozero",
    },
    font: { family: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 13, color: "#222" },
  };
}

function renderFocusEducationFundingCharts(f, factor) {
  const netEl = $("focusEducationFundingChart");
  const taxEl = $("focusEducationFundingTaxChart");
  if (typeof Plotly === "undefined") {
    if (netEl) netEl.innerHTML = chartUnavailableHTML();
    if (taxEl) taxEl.innerHTML = chartUnavailableHTML();
    return;
  }
  const ages = f.series.map((r) => r.age);
  const palette = { baseline: "rgb(28, 90, 180)", investment: "rgb(217, 90, 40)", education: "rgb(46, 138, 138)" };
  if (netEl) {
    Plotly.react(netEl, [
      { x: ages, y: f.series.map((r) => r.netAssetsBaseline * factor(r.year)), name: "Outside a bond",
        type: "scatter", mode: "lines", line: { color: palette.baseline, width: 2 },
        hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Outside a bond</extra>" },
      { x: ages, y: f.series.map((r) => r.netAssetsInvestment * factor(r.year)), name: "Investment bond",
        type: "scatter", mode: "lines", line: { color: palette.investment, width: 2, dash: "dash" },
        hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Investment bond</extra>" },
      { x: ages, y: f.series.map((r) => r.netAssetsEducation * factor(r.year)), name: "Education bond",
        type: "scatter", mode: "lines", line: { color: palette.education, width: 2, dash: "dot" },
        hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Education bond</extra>" },
    ], focusEducationFundingChartLayout(ages, "Net worth"), { displayModeBar: false, responsive: true });
  }
  if (taxEl) {
    Plotly.react(taxEl, [
      { x: ages, y: f.series.map((r) => r.cumTaxBaseline * factor(r.year)), name: "Outside a bond",
        type: "scatter", mode: "lines", line: { color: palette.baseline, width: 2 },
        hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Outside a bond</extra>" },
      { x: ages, y: f.series.map((r) => r.cumTaxInvestment * factor(r.year)), name: "Investment bond",
        type: "scatter", mode: "lines", line: { color: palette.investment, width: 2, dash: "dash" },
        hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Investment bond</extra>" },
      { x: ages, y: f.series.map((r) => r.cumTaxEducation * factor(r.year)), name: "Education bond",
        type: "scatter", mode: "lines", line: { color: palette.education, width: 2, dash: "dot" },
        hovertemplate: "Age %{x}<br>%{y:$,.0f}<extra>Education bond</extra>" },
    ], focusEducationFundingChartLayout(ages, "Cumulative household tax paid"), { displayModeBar: false, responsive: true });
  }
}

function exportFocusEducationFundingCSV() {
  const f = buildEducationFundingFocus({ out: projection, state, childId: focusEducationFundingChildId });
  if (!f) return;
  const factor = (y) => displayFactor(endMonthOfYear(y));
  const lines = [
    ["Section", "Item", "Value"].map(csvEsc).join(","),
    [csvEsc(f.child.name), csvEsc("Seed (same in all three)"), f.seed.toFixed(2)].join(","),
  ];
  if (f.flags.investmentWorseThanBaseline) lines.push(["", csvEsc("Flag"), csvEsc("Investment bond ends up worse than saving outside one")].join(","));
  if (f.flags.educationWorseThanBaseline) lines.push(["", csvEsc("Flag"), csvEsc("Education bond ends up worse than saving outside one")].join(","));
  lines.push("", [
    "Year", "Age", "FY",
    "Net worth (outside a bond)", "Net worth (investment bond)", "Net worth (education bond)",
    "Cumulative tax (outside a bond)", "Cumulative tax (investment bond)", "Cumulative tax (education bond)",
    "Education benefit this year",
  ].map(csvEsc).join(","));
  for (const r of f.series) {
    const fac = factor(r.year);
    lines.push([
      r.year, r.age, csvEsc(r.fyLabel),
      (r.netAssetsBaseline * fac).toFixed(2), (r.netAssetsInvestment * fac).toFixed(2), (r.netAssetsEducation * fac).toFixed(2),
      (r.cumTaxBaseline * fac).toFixed(2), (r.cumTaxInvestment * fac).toFixed(2), (r.cumTaxEducation * fac).toFixed(2),
      (r.educationBenefit * fac).toFixed(2),
    ].join(","));
  }
  lines.push("", csvEsc(f.disclosure));
  downloadCSV("focus-education-funding", lines);
}

// --- Surplus and deficit allocation, Focus view (spec 16, Commit 3) --------
//
// "Where did the surplus actually go, year by year" (buildSurplusAllocationFocus)
// plus "should we put it all on one thing instead?" (projectSingleDestinationAlternative)
// — both pure, both reading/re-running the SAME real projectPlan(), never a
// separate calculation (the Focus governing principle). The non-deductible-
// first benefit paragraph (Commit 4) is added to this SAME view once that
// commit lands — see this function's own note below.

let focusSurplusCompareTarget = null;

function focusSurplusAllocationTableHTML() {
  return [{ title: null, rows: surplusPerDestinationRows(projection.yearly) }];
}

function renderFocusSurplusAllocationView() {
  const focus = buildSurplusAllocationFocus({ out: projection, state });
  if (focus.totalSwept <= 0.005) {
    els.viewFocusSurplusAllocation.innerHTML = focusEmptyStateHTML(
      "No surplus has been swept anywhere in this projection yet — check the Working Cash Account's minimum balance and the surplus periods in Settings.",
      "settings"
    );
    return;
  }
  const { assets, liabilities, superRows, goals } = surplusEligibleTargets();
  if (!focusSurplusCompareTarget) focusSurplusCompareTarget = surplusDefaultTarget();
  const compareOptions = surplusAllocationTargetOptionsHTML(focusSurplusCompareTarget.targetType, focusSurplusCompareTarget.targetId);
  const canCompare = assets.length + liabilities.length + superRows.length + goals.length > 0;

  let compareHTML = "";
  if (canCompare) {
    const alt = projectSingleDestinationAlternative(state, focusSurplusCompareTarget);
    const actualNetWorth = projection.yearly[projection.yearly.length - 1].netAssets;
    const altNetWorth = alt.yearly[alt.yearly.length - 1].netAssets;
    const delta = altNetWorth - actualNetWorth;
    compareHTML = `
      <div class="focus-section">
        <label>Compare against sending 100% of surplus, every year, to:</label>
        <select id="focusSurplusCompareSelect">${compareOptions}</select>
        <p class="helper-text">
          As configured, closing net worth is ${fmtMoney(Math.round(actualNetWorth))}.
          Sending everything to this one destination instead would leave
          ${fmtMoney(Math.round(altNetWorth))} —
          ${delta === 0 ? "no difference" : `${delta > 0 ? fmtMoney(Math.round(delta)) + " more" : fmtMoney(Math.round(-delta)) + " less"}`}.
          This is one alternative, not a recommendation — the right split depends on goals a single net-worth figure doesn't capture (liquidity, debt-free timing, super access age).
        </p>
      </div>
    `;
  }

  // Non-deductible-first benefit (spec 16, Commit 4) — a figure and a
  // sentence, never framed as a recommendation: it states the
  // difference and why (non-deductible interest is paid from after-tax
  // income; deductible interest is not), and leaves the conclusion to
  // the adviser, per the locked non-prescriptive convention. Absent
  // entirely (not a zero) when it doesn't apply — see
  // nonDeductibleFirstBenefit's own gating.
  const ndfBenefit = nonDeductibleFirstBenefit(state, projection);
  const ndfHTML = ndfBenefit ? `
    <div class="focus-section">
      <p class="helper-text">
        Paying non-deductible debt first ${
          Math.abs(ndfBenefit.interestSaved) < 1
            ? "makes no material difference to total interest paid here"
            : `means this projection pays ${fmtMoney(Math.round(Math.abs(ndfBenefit.interestSaved)))}
               ${ndfBenefit.interestSaved > 0 ? "less" : "more"} total interest over its life`
        } than sending the same surplus pro-rata across all debt instead.
        Non-deductible interest is paid from after-tax income; deductible
        interest is not — that is the basis for prioritising it, independent
        of which path happens to produce less total interest in a given
        scenario (that depends on the relative interest rates involved, not
        just deductibility). ${escapeHTML(ndfBenefit.note)}
      </p>
    </div>
  ` : "";

  els.viewFocusSurplusAllocation.innerHTML = `
    <h2 class="section-heading">Surplus allocation</h2>
    <p class="helper-text">Where the Working Cash Account's FY-end surplus actually went, year by year, per the periods configured in Settings.</p>
    ${compareHTML}
    ${ndfHTML}
    <div id="focusSurplusTable"></div>
  `;
  renderTransposed(document.getElementById("focusSurplusTable"), focusSurplusAllocationTableHTML());
}

els.viewFocusSurplusAllocation.addEventListener("change", (e) => {
  if (e.target.id !== "focusSurplusCompareSelect") return;
  const [targetType, targetId] = e.target.value.split(":");
  focusSurplusCompareTarget = { targetType, targetId };
  renderFocusSurplusAllocationView();
});

function exportFocusSurplusAllocationCSV() {
  const focus = buildSurplusAllocationFocus({ out: projection, state });
  if (focus.totalSwept <= 0.005) return;
  exportTransposedCSV("focus-surplus-allocation", focusSurplusAllocationTableHTML());
}

// --- Main residence exemption and the six-year absence rule, Focus view ----
// (docs/specs/19-engine-completion.md, Commit 5's own Focus view — never
// built until this commit.)
//
// The timeline/exempt-days table read straight off buildMainResidenceTimeline
// (pure day-count arithmetic on the SAME exemptProportion the real engine
// uses); "CGT payable if sold" is a table, not a chart — a genuine,
// disclosed scope reduction: a Plotly line would need new chart-wiring
// this commit doesn't add, and the cliff (flat, then climbing once the
// six-year window lapses) is still legible in the numbers themselves.

const MRE_STATUS_LABELS = {
  "main-residence": "Main residence", "absent-covered": "Absent — covered",
  "absent-exceeded": "Absent — exceeded", investment: "Investment",
};

let focusPprPropertyId = null;

function focusPprTimelineHTML(rows) {
  const segments = rows.map((r) =>
    `<div class="mre-segment ${r.status}" title="${escapeHTML(r.fyLabel)}: ${MRE_STATUS_LABELS[r.status]}"></div>`
  ).join("");
  const legend = Object.entries(MRE_STATUS_LABELS).map(([key, label]) =>
    `<span><span class="mre-legend-swatch mre-segment ${key}" style="display:inline-block;width:11px;height:11px;"></span>${escapeHTML(label)}</span>`
  ).join("");
  return `<div class="mre-timeline">${segments}</div><div class="mre-legend">${legend}</div>`;
}

function renderFocusPprExemptionView() {
  const props = eligibleMainResidenceProperties(state);
  if (props.length === 0) {
    els.viewFocusPprExemption.innerHTML = focusEmptyStateHTML(
      "The main residence exemption and its six-year absence rule only apply to a property flagged as Main residence (PPR) — add one, or set an existing property's type to PPR, to see it here.",
      "property"
    );
    return;
  }
  if (!props.some((p) => p.id === focusPprPropertyId)) focusPprPropertyId = props[0].id;
  const property = props.find((p) => p.id === focusPprPropertyId);
  const schedule = projection.schedule;
  const rows = buildMainResidenceTimeline({ property, plan: state.plan, schedule });

  const propertyOptions = props.map((p) =>
    `<option value="${p.id}"${p.id === property.id ? " selected" : ""}>${escapeHTML(p.name)}</option>`
  ).join("");

  if (!property.mainResidence.movedOutAt) {
    els.viewFocusPprExemption.innerHTML = `
      <h2 class="section-heading">Main residence exemption</h2>
      ${props.length > 1 ? `<div class="focus-section"><label>Property</label><select id="focusPprPropertySelect">${propertyOptions}</select></div>` : ""}
      <p class="helper-text">"${escapeHTML(property.name)}" has never moved out during this projection — it stays fully CGT-exempt throughout, so there is no six-year clock to show. Set a "Moved out" date on the property's own Main residence exemption section to see the timeline and the exempt-days table.</p>
    `;
    return;
  }

  const cgtSeries = buildCgtIfSoldSeries({ state, property, out: projection });
  const cgtRows = cgtSeries.map((c, i) => `
    <tr><td>${escapeHTML(c.fyLabel)}</td><td class="tl-num">${fmtMoney(Math.round(c.cgtPayable))}</td></tr>
  `).join("");
  const exemptRows = rows.map((r) => `
    <tr>
      <td>${escapeHTML(r.fyLabel)}</td>
      <td>${MRE_STATUS_LABELS[r.status]}</td>
      <td class="tl-num">${r.exemptDays.toLocaleString()}</td>
      <td class="tl-num">${r.totalDays.toLocaleString()}</td>
      <td class="tl-num">${(r.exemptProportion * 100).toFixed(1)}%</td>
    </tr>
  `).join("");

  els.viewFocusPprExemption.innerHTML = `
    <h2 class="section-heading">Main residence exemption</h2>
    <p class="helper-text">The PPR stays CGT-exempt while occupied, and for up to six years while absent and producing income (indefinitely if not) — but only one absence/reoccupation cycle is modelled, only one property can be the main residence at a time, and there is no apportionment for a home office. The clock resets on reoccupation.</p>
    ${props.length > 1 ? `<div class="focus-section"><label>Property</label><select id="focusPprPropertySelect">${propertyOptions}</select></div>` : ""}
    ${focusPprTimelineHTML(rows)}
    <div class="focus-panel">
      <div class="focus-section">
        <h3>CGT payable if sold that year</h3>
        <p class="helper-text">Flat while the exemption is intact; climbs once the six-year window lapses — the incremental household tax of a sale that year, against the same plan with no sale at all.</p>
        <div class="tl-wrap"><table class="tl"><thead><tr><th>FY</th><th>CGT payable</th></tr></thead><tbody>${cgtRows}</tbody></table></div>
      </div>
      <div class="focus-section">
        <h3>Exempt days by year</h3>
        <div class="tl-wrap"><table class="tl"><thead><tr><th>FY</th><th>Status</th><th>Exempt days</th><th>Total days owned</th><th>Exempt %</th></tr></thead><tbody>${exemptRows}</tbody></table></div>
      </div>
    </div>
  `;
}

els.viewFocusPprExemption.addEventListener("change", (e) => {
  if (e.target.id !== "focusPprPropertySelect") return;
  focusPprPropertyId = e.target.value;
  renderFocusPprExemptionView();
});

function exportFocusPprExemptionCSV() {
  const props = eligibleMainResidenceProperties(state);
  const property = props.find((p) => p.id === focusPprPropertyId) ?? props[0];
  if (!property || !property.mainResidence.movedOutAt) return;
  const rows = buildMainResidenceTimeline({ property, plan: state.plan, schedule: projection.schedule });
  const cgtSeries = buildCgtIfSoldSeries({ state, property, out: projection });
  const lines = [`Main residence exemption,${csvEsc(property.name)}`, "", ["FY", "Status", "Exempt days", "Total days owned", "Exempt %", "CGT payable if sold"].map(csvEsc).join(",")];
  rows.forEach((r, i) => {
    lines.push([csvEsc(r.fyLabel), csvEsc(MRE_STATUS_LABELS[r.status]), r.exemptDays, r.totalDays, (r.exemptProportion * 100).toFixed(1), cgtSeries[i]?.cgtPayable.toFixed(2) ?? ""].join(","));
  });
  downloadCSV("focus-ppr-exemption", lines);
}

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
    definedBenefits: s.plan.definedBenefits ?? [],
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
  else if (activeView === "income-sources") exportChartPNG("chartIncomeSources", "income-sources");
  else if (activeView === "expense-funding") exportChartPNG("chartExpenseFunding", "expense-funding");
  else if (activeView === "tax-by-type") exportChartPNG("chartTaxByType", "tax-by-type");
  else if (activeView === "debt-vs-assets") exportChartPNG("chartDebtVsAssets", "debt-vs-assets");
  else if (activeView === "super-vs-non-super") exportChartPNG("chartSuperVsNonSuper", "super-vs-non-super");
  else if (activeView === "age-pension-chart") exportChartPNG("chartAgePension", "age-pension");
  else if (activeView === "monte-carlo") exportChartPNG("chartMonteCarlo", "monte-carlo");
  else if (activeView === "money-decomposition") exportMoneyDecompositionCSV();
  else if (activeView === "key-figures") exportTransposedCSV("key-figures", buildKeyFiguresGroups({ state, projection }, keyFiguresPersonEntity));
  else if (activeView === "cashflow") exportTransposedCSV("cashflow", buildCashflowGroups(cashflowPersonEntity === "all" ? null : cashflowPersonEntity));
  else if (activeView === "assets") exportTransposedCSV("assets", buildAssetsGroups(assetsEntity));
  else if (activeView === "tax") exportTransposedCSV("tax", buildTaxGroups(taxPersonEntity));
  else if (activeView === "super") exportTransposedCSV("super", buildSuperGroups(superEntity));
  else if (activeView === "age-pension-table") exportTransposedCSV("age-pension", buildAgePensionGroups(agePensionPersonEntity));
  else if (activeView === "death-benefits") exportDeathBenefitsCSV();
  else if (activeView === "liabilities") exportTransposedCSV("liabilities", buildLiabilitiesGroups(liabilitiesEntity));
  else if (activeView === "bonds") exportTransposedCSV("bonds", buildBondsGroups(bondsEntity));
  else if (activeView === "snapshot") exportSnapshotCSV();
  else if (activeView === "monte-carlo-table") exportMonteCarloCSV();
  else if (activeView === "assumptions") exportTransposedCSV("assumptions", buildAssumptionsGroups());
  else if (activeView === "focus-deposit") exportFocusDepositCSV();
  else if (activeView === "focus-fhsss") exportFocusFhsssCSV();
  else if (activeView === "focus-salary-sacrifice") exportFocusSalarySacrificeCSV();
  else if (activeView === "focus-debt-payoff") exportFocusDebtPayoffCSV();
  else if (activeView === "focus-debt-recycling") exportFocusDebtRecyclingCSV();
  else if (activeView === "focus-education-funding") exportFocusEducationFundingCSV();
  else if (activeView === "focus-surplus-allocation") exportFocusSurplusAllocationCSV();
  else if (activeView === "focus-ppr-exemption") exportFocusPprExemptionCSV();
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

// --- Adjustment rows (docs/specs/18-adjustment-rows.md, Commits 2-3) --------
//
// A single modal, used two ways: the "Adjustments" button in the output
// header opens it showing every adjustment in the scenario (Commit 3's
// review panel, with a count badge that appears whenever any exist); a
// marked table row's own icon (renderAdjustmentMarker, below) opens the
// SAME modal pre-filtered into a create/edit form for that row's target
// (Commit 2's "edit affordance") — one editing surface, not two.

function adjustmentOwnerLabel(a) {
  if (a.owner === "household") return "Household";
  return a.owner === "partner" ? partnerName() : clientName();
}

function ageRefLabel(ref) {
  // The editor only ever writes age-based DateRefs (see the form
  // below); an anchor-based one (from a source other than this editor)
  // is shown by its anchor id rather than crashing.
  return ref?.kind === "age" ? String(ref.age) : (ref?.anchorId ?? "?");
}

function renderAdjustmentsCountBadge() {
  const n = (state.plan.adjustments ?? []).length;
  els.adjustmentsCountBadge.hidden = n === 0;
  els.adjustmentsCountBadge.textContent = String(n);
}

// The output subject a target's own row lives on (spec 18 Commit 3's
// "jump-to link") — every target except superContributions/tax.withheld
// appears somewhere in Cashflow or Tax (Commit 2); those two have no
// table row of their own to jump to (see build-log's Commit 2 entry),
// so the list shows their amount/window/note with no link, not a
// dead one.
function adjustmentJumpSubject(target) {
  if (target.startsWith("tax.")) return "tax";
  if (target === "superContributions" || target === "tax.withheld") return null;
  return "cashflow";
}

function renderAdjustmentsList() {
  const list = state.plan.adjustments ?? [];
  if (list.length === 0) {
    els.adjustmentsList.innerHTML = `<p class="helper-text">No adjustments in this scenario yet.</p>`;
    return;
  }
  els.adjustmentsList.innerHTML = list.map((a) => {
    const subject = adjustmentJumpSubject(a.target);
    return `
    <div class="adjustment-list-row">
      <div>
        <div class="adj-label">${escapeHTML(a.label)} — ${escapeHTML(adjustmentOwnerLabel(a))}</div>
        <div class="adj-meta">${fmtMoney(a.amount)} · age ${ageRefLabel(a.from)}–${ageRefLabel(a.to)}
          · <span title="${escapeHTML(a.note)}">${escapeHTML(a.note.length > 60 ? a.note.slice(0, 60) + "…" : a.note)}</span></div>
      </div>
      ${subject ? `<button type="button" class="btn-text" data-adj-view="${subject}">View</button>` : ""}
      <button type="button" class="btn-text" data-adj-edit="${a.id}">Edit</button>
    </div>
  `;
  }).join("");
}

function adjustmentFieldsForTarget(target) {
  const isHousehold = target === "expenses";
  const isSuperContribution = target === "superContributions";
  els.adjOwnerLabel.hidden = isHousehold || isSuperContribution;
  els.adjSuperAccountLabel.hidden = !isSuperContribution;
  if (isSuperContribution) {
    const accounts = (state.plan.superAccounts ?? []).filter((s) => s.include);
    els.adjSuperAccount.innerHTML = accounts.map((s) => `<option value="${s.id}">${escapeHTML(s.name)} (${s.owner === "partner" ? escapeHTML(partnerName()) : escapeHTML(clientName())})</option>`).join("")
      || `<option value="">No super accounts yet</option>`;
  }
}

// Opens the shared editor. target/prefillOwner seed a NEW adjustment
// (Commit 2's row-marker "+" affordance); an existing id (via the
// review list's Edit button) loads that adjustment instead.
function openAdjustmentEditor({ id = null, target = ADJUSTMENT_TARGETS[0], owner = null } = {}) {
  els.adjustmentsModal.showModal();
  renderAdjustmentsList();
  els.adjTarget.innerHTML = adjustmentTargetOptionsHTML();
  const existing = id ? (state.plan.adjustments ?? []).find((a) => a.id === id) : null;
  els.adjId.value = existing?.id ?? "";
  els.adjTarget.value = existing?.target ?? target;
  adjustmentFieldsForTarget(els.adjTarget.value);
  els.adjOwner.value = existing?.owner === "partner" ? "partner" : (owner === "partner" ? "partner" : "client");
  if (existing?.superAccountId) els.adjSuperAccount.value = existing.superAccountId;
  els.adjAmount.value = existing?.amount ?? 0;
  els.adjFromAge.value = existing ? ageRefLabel(existing.from) : state.plan.client.currentAge;
  els.adjToAge.value = existing ? ageRefLabel(existing.to) : state.plan.endAge;
  els.adjIndexBasis.value = existing?.indexBasis ?? "cpi";
  els.adjIndexExtraPct.value = existing?.indexExtraPct ?? 0;
  els.adjNote.value = existing?.note ?? "";
  els.adjDeleteBtn.hidden = !existing;
  els.adjustmentForm.hidden = false;
  requestAnimationFrame(() => els.adjustmentForm.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function adjustmentTargetOptionsHTML() {
  return ADJUSTMENT_TARGETS.map((t) => `<option value="${t}">${escapeHTML(ADJUSTMENT_TARGET_LABELS[t])}</option>`).join("");
}

function closeAdjustmentForm() {
  els.adjustmentForm.hidden = true;
  els.adjustmentForm.reset();
}

els.adjustmentsBtn.addEventListener("click", () => {
  els.adjustmentsModal.showModal();
  renderAdjustmentsList();
  els.adjustmentForm.hidden = true;
});
els.adjustmentsAddBtn.addEventListener("click", () => openAdjustmentEditor());
els.adjustmentsModal.querySelector(".modal-close").addEventListener("click", () => els.adjustmentsModal.close());
els.adjustmentsModal.addEventListener("click", (e) => {
  if (e.target === els.adjustmentsModal) els.adjustmentsModal.close();
  const editBtn = e.target.closest("[data-adj-edit]");
  if (editBtn) { openAdjustmentEditor({ id: editBtn.dataset.adjEdit }); return; }
  // Commit 3's "jump-to link" — the review list's own View button, to
  // the output subject Commit 2 marked that adjustment's row on.
  const viewBtn = e.target.closest("[data-adj-view]");
  if (viewBtn) {
    els.adjustmentsModal.close();
    const { client, scenario } = findActive(workspace);
    navigate({ page: "workspace", clientId: client.id, scenarioId: scenario.id, area: "output", section: viewBtn.dataset.adjView, form: "table" });
  }
});
els.adjTarget.addEventListener("change", () => adjustmentFieldsForTarget(els.adjTarget.value));
els.adjCancelBtn.addEventListener("click", () => closeAdjustmentForm());

els.adjustmentForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!els.adjNote.value.trim()) { els.adjNote.focus(); return; } // required — spec's own words
  const target = els.adjTarget.value;
  const raw = {
    id: els.adjId.value || undefined,
    target,
    owner: target === "expenses" ? "household" : els.adjOwner.value,
    superAccountId: target === "superContributions" ? els.adjSuperAccount.value : null,
    label: "",
    amount: clampNumber(els.adjAmount.value, -1e9, 1e9),
    from: { kind: "age", age: clampInt(els.adjFromAge.value, 0, 120) },
    to: { kind: "age", age: clampInt(els.adjToAge.value, 0, 120) },
    indexBasis: els.adjIndexBasis.value,
    indexExtraPct: clampNumber(els.adjIndexExtraPct.value, -10, 10),
    note: els.adjNote.value.trim(),
  };
  const existingId = els.adjId.value;
  const finalId = existingId || uid("adj");
  const list = state.plan.adjustments ?? [];
  state.plan.adjustments = existingId
    ? list.map((a) => (a.id === existingId ? { ...raw, id: existingId } : a))
    : [...list, { ...raw, id: finalId }];
  state.plan = clampPlan(state.plan, PROFILES);
  state = clampAllToPlan(state, PROFILES);
  // Input Usability convention (spec 15): a path is touched when the
  // user changes OR confirms it — creating/editing an adjustment is
  // exactly that, for its own `adjustments.<id>` path (Commit 3).
  markTouched(`adjustments.${finalId}`);
  saveState();
  refreshOutputs();
  closeAdjustmentForm();
  renderAdjustmentsList();
  renderAdjustmentsCountBadge();
});

els.adjDeleteBtn.addEventListener("click", () => {
  const id = els.adjId.value;
  if (!id) return;
  if (!window.confirm("Delete this adjustment?")) return;
  state.plan.adjustments = (state.plan.adjustments ?? []).filter((a) => a.id !== id);
  state.plan = clampPlan(state.plan, PROFILES);
  state = clampAllToPlan(state, PROFILES);
  if (state.meta?.touched) state.meta.touched = state.meta.touched.filter((p) => p !== `adjustments.${id}`);
  saveState();
  refreshOutputs();
  closeAdjustmentForm();
  renderAdjustmentsList();
  renderAdjustmentsCountBadge();
});

// Reused by Cashflow/Tax's row marking (Commit 2): the sum of every
// active adjustment matching `target` (and `owner`, when given) for
// plan-year y, plus the small marker icon's HTML (empty when nothing
// is active that year — the spec's "hidden by default", not disabled).
function adjustmentAmountFor(y, target, owner = null) {
  const row = projection.yearly[y];
  return (row?.adjustments ?? [])
    .filter((a) => a.target === target && (owner == null || a.owner === owner))
    .reduce((s, a) => s + a.amount, 0);
}
// adjustmentRowAttrs(target, forOwner) → the <tr> attributes that both
// mark an adjusted row (a tinted background via .tl-adjustment-row/
// .tl-adjusted in styles.css) and make the WHOLE row clickable to open
// the editor (the delegated listener below matches [data-adj-marker] on
// any element, tr included) — the note becomes its tooltip, per the
// spec's "distinct icon and a tinted cell... the note as its tooltip".
// target may be a single target or an array (a displayed row can fold
// more than one target, e.g. Cashflow's "Income Tax" carries both
// tax.incomeTax and tax.cgt — there's no separate CGT line there).
function adjustmentRowAttrs(target, forOwner) {
  const targets = Array.isArray(target) ? target : [target];
  const active = (state.plan.adjustments ?? []).find((a) => targets.includes(a.target)
    && (forOwner == null || a.owner === forOwner || a.owner === "household"));
  if (!active) return "";
  return ` data-adj-marker="${active.target}"${active.owner && active.owner !== "household" ? ` data-adj-owner="${active.owner}"` : ""}` +
    ` title="${escapeHTML(active.note)}"`;
}

// adjustableRow(label, computedCell, adjCell, target, forOwner, rowOpts)
// — Commit 2's "own sub-row beneath the computed figure (Computed /
// Adjustment / Total)" pattern, from the Xtools Amount/Special/Total
// convention the spec cites. `computedCell` is the pre-adjustment
// figure (what the engine alone would have shown); `adjCell` is the
// already sign-matched (same display convention as computedCell) sum of
// active adjustments; Total = Computed + Adjustment always, so the three
// rows can never disagree with each other or with the engine's own
// (already-adjusted) figures elsewhere. Returns the single unmodified
// row when nothing is active for this target/owner — a scenario with no
// adjustments therefore renders byte-identical to before Commit 2, the
// spec's own regression gate.
function adjustableRow(label, computedCell, adjCell, target, forOwner, rowOpts = {}) {
  const targets = Array.isArray(target) ? target : [target];
  const { cls: baseCls, ...restOpts } = rowOpts;
  const active = (state.plan.adjustments ?? []).some((a) => targets.includes(a.target)
    && (forOwner == null || a.owner === forOwner || a.owner === "household"));
  if (!active) return [{ label, cell: computedCell, cls: baseCls, ...restOpts }];
  const totalCell = (y) => computedCell(y) + adjCell(y);
  const attrs = adjustmentRowAttrs(targets, forOwner);
  return [
    { label: `${label} — Computed`, cell: computedCell, cls: baseCls, ...restOpts },
    { label: `${label} — Adjustment`, cell: adjCell, cls: "tl-adjustment-row", rowAttrs: attrs, ...restOpts },
    { label, cell: totalCell, cls: [baseCls, "tl-adjusted"].filter(Boolean).join(" "), rowAttrs: attrs, ...restOpts },
  ];
}
// Delegated once, on the whole output canvas, since Cashflow/Tax
// re-render their DOM on every edit — a per-row listener would leak.
els.outputCanvas.addEventListener("click", (e) => {
  const marker = e.target.closest("[data-adj-marker]");
  if (!marker) return;
  const target = marker.dataset.adjMarker;
  const owner = marker.dataset.adjOwner || null;
  const existing = (state.plan.adjustments ?? []).find((a) => a.target === target && (owner == null || a.owner === owner));
  openAdjustmentEditor(existing ? { id: existing.id } : { target, owner });
});

// --- Redundancy and ETP (spec 19 Commit 3) ----------------------------------
//
// A small modal, one-per-income-row (not a list like Adjustments — this
// is a 1:1 property of the row, not a separate collection), triggered
// by the row's own "Termination…" button (salary-category rows only,
// matching the spec's own "a termination event on an income row").

function terminationFieldsVisibility() {
  els.terminationFields.hidden = !els.termEnabled.checked;
}

function openTerminationEditor(rowId) {
  const row = state.cashflows.income.find((r) => r.id === rowId);
  if (!row) return;
  const t = row.termination ?? { enabled: false, at: null, completedYearsOfService: 0, type: "genuineRedundancy", etpTaxableComponent: 0, unusedLeave: 0 };
  els.termRowId.value = rowId;
  els.termEnabled.checked = t.enabled === true;
  els.termType.value = TERMINATION_TYPES.includes(t.type) ? t.type : "genuineRedundancy";
  els.termAt.value = ageRefLabel(t.at ?? { kind: "age", age: state.plan.client.currentAge });
  els.termYears.value = t.completedYearsOfService ?? 0;
  els.termEtp.value = t.etpTaxableComponent ?? 0;
  els.termLeave.value = t.unusedLeave ?? 0;
  terminationFieldsVisibility();
  els.terminationModal.showModal();
}

els.termEnabled.addEventListener("change", terminationFieldsVisibility);
els.terminationModal.querySelector(".modal-close").addEventListener("click", () => els.terminationModal.close());
els.terminationModal.addEventListener("click", (e) => {
  if (e.target === els.terminationModal) els.terminationModal.close();
});
els.termCancelBtn.addEventListener("click", () => els.terminationModal.close());

els.terminationForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const row = state.cashflows.income.find((r) => r.id === els.termRowId.value);
  if (!row) { els.terminationModal.close(); return; }
  row.termination = {
    enabled: els.termEnabled.checked,
    at: { kind: "age", age: clampInt(els.termAt.value, 0, 120) },
    completedYearsOfService: clampNumber(els.termYears.value, 0, 60),
    type: TERMINATION_TYPES.includes(els.termType.value) ? els.termType.value : "genuineRedundancy",
    etpTaxableComponent: clampNumber(els.termEtp.value, 0),
    unusedLeave: clampNumber(els.termLeave.value, 0),
  };
  state = clampAllToPlan(state, PROFILES);
  saveState();
  refreshOutputs();
  renderCashflows();
  els.terminationModal.close();
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
  renderPensions();
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
