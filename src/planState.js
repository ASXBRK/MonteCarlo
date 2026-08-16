// Plan/asset state model — schemaVersion 5.
//
// v5 (D1): identity intake (names, DOB, sex, marital status),
// life-expectancy-anchored projection end, per-row indexation model
// (basis + additional %), opening carry-forward capital losses, AWOTE
// assumption. DOB replaces currentAge as stored; currentAge is derived
// (floor of exact age at the start date) and ages still tick each
// 1 July — DOB precision feeds the life-expectancy lookup only.
//
// Pure functions only — no DOM, no storage. main.js owns persistence
// (localStorage) and rendering; this module owns shape, defaults,
// validation/clamping, migration, and derived summaries, so the whole
// model is unit-testable in Node.
//
// v3 additions (Phase A.2): single/couple household, asset ownership +
// distribution treatment, gross income and household expense rows,
// surplus/deficit settings with an explicit funding order.
//
// Timeline conventions (locked):
//   - The projection timeline runs on the CLIENT's age; a partner ages
//     alongside with their own current age. No partner end age, no
//     mortality modelling.
//   - Ages tick over each 1 July (Australian FY convention, from A.1).
//   - Income rows anchor from/to ages to their OWNER's age; expenses
//     and asset cashflows anchor to the client timeline.

export const SCHEMA_VERSION = 15;

import { remainingLE } from "./data/lifeTables.js";
import { INPUT_SECTIONS, OUTPUT_VIEWS, DEFAULT_INPUT_SECTION } from "./router.js";
import { isValidAnchorId } from "./keyDates.js";

// --- id generation ---------------------------------------------------

let counter = 0;
export function uid(prefix = "id") {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// --- defaults ---------------------------------------------------------

// Per-person tax profile (C3, extended D1 with opening carry-forward
// capital losses). Input Usability spec, Commit 1: centrelinkEligible
// removed entirely — it was captured but inert (drove nothing) and is
// noise in an already-dense form; reintroduce it properly when
// Centrelink modelling arrives.
export function defaultTaxProfile() {
  return { residency: "resident", medicareExempt: false, openingCapitalLosses: 0 };
}

export function clampTaxProfile(raw) {
  return {
    residency: raw?.residency === "nonResident" ? "nonResident" : "resident",
    medicareExempt: raw?.medicareExempt === true,
    openingCapitalLosses: clampNumber(raw?.openingCapitalLosses, 0),
  };
}

// --- identity + ages (D1) --------------------------------------------------

export const isCoupleHousehold = (h) => h === "married" || h === "defacto";

// Floor of exact age at the 1st of {year, month}.
export function ageAtDate(dobISO, year, month) {
  const dob = new Date(`${dobISO}T00:00:00`);
  if (Number.isNaN(dob.getTime())) return null;
  let age = year - dob.getFullYear();
  const mDelta = (month - 1) - dob.getMonth();
  if (mDelta < 0 || (mDelta === 0 && dob.getDate() > 1)) age -= 1;
  return age;
}

// Synthesise a DOB from a plan-year age: 1 July of the current FY's
// start year minus the age, so age-at-start and every 1-July tick
// match the pre-D1 currentAge behaviour exactly (migration gate).
export function synthDob(currentAge, start) {
  const fyStart = start.month >= 7 ? start.year : start.year - 1;
  return `${fyStart - currentAge}-07-01`;
}

export function personDisplayName(person, fallback) {
  const n = `${person?.firstName ?? ""} ${person?.surname ?? ""}`.trim();
  return n || fallback;
}

// Default Retirement key date basis (Tier 1.1) — every person defaults
// to 65 until they say otherwise; used as the built-in "Retirement"
// anchor and as the default report-period horizon.
export const DEFAULT_RETIREMENT_AGE = 65;

// Per-person super state (Tier 1.2): a rolling 5-entry FIFO ledger of
// unused concessional cap (oldest first, real $) plus the plan year a
// non-concessional bring-forward was triggered, if any. Padded/
// truncated to exactly CARRY_FORWARD_YEARS entries so consumption
// logic (commit 2) never has to guard array length.
export const CARRY_FORWARD_YEARS = 5;

function clampPersonSuper(raw) {
  const carryForward = (Array.isArray(raw?.carryForward) ? raw.carryForward : [])
    .slice(0, CARRY_FORWARD_YEARS)
    .map((v) => clampNumber(v, 0));
  while (carryForward.length < CARRY_FORWARD_YEARS) carryForward.push(0);
  return {
    carryForward,
    bringForwardTriggeredYear: Number.isInteger(raw?.bringForwardTriggeredYear)
      ? raw.bringForwardTriggeredYear : null,
    workTestMet: raw?.workTestMet !== false, // default true (Commit 2/4)
    // Division 293/296: release from super by default commit. Default
    // "super" — a release authority against a super interest, which is
    // what most clients actually elect (the cost lands on the super
    // balance instead of cash available for other strategy); "cash"
    // reproduces the tool's original behaviour exactly. Validated
    // loosely here (type only) — deterministic.js resolves the
    // nominated account defensively (falls back to the largest-balance
    // account, or to cash if none exists), the same pattern
    // surplusTargetId/fundingOrder already use for a stale reference.
    divTaxPaidFrom: raw?.divTaxPaidFrom === "cash" ? "cash" : "super",
    divTaxReleaseAccountId: typeof raw?.divTaxReleaseAccountId === "string" ? raw.divTaxReleaseAccountId : null,
  };
}

function clampPerson(raw, start) {
  const parsed = typeof raw?.dob === "string" ? ageAtDate(raw.dob, start.year, start.month) : null;
  let dob = raw?.dob;
  let currentAge = parsed;
  if (currentAge == null || currentAge < 18 || currentAge > 100) {
    currentAge = clampInt(currentAge ?? raw?.currentAge ?? 40, 18, 100);
    dob = synthDob(currentAge, start);
  }
  return {
    firstName: typeof raw?.firstName === "string" ? raw.firstName.trim() : "",
    surname: typeof raw?.surname === "string" ? raw.surname.trim() : "",
    dob,
    sex: raw?.sex === "female" ? "female" : "male",
    currentAge, // derived — recomputed from DOB on every clamp
    retirementAge: clampInt(raw?.retirementAge ?? DEFAULT_RETIREMENT_AGE, 18, 120),
    taxProfile: clampTaxProfile(raw?.taxProfile),
    super: clampPersonSuper(raw?.super),
    // Document Set Commit 1 — HELP/HECS outstanding balance, real $.
    // Held constant in real terms (see src/data/helpRates.js's header);
    // reduced only by actual dollar repayments in deterministic.js.
    helpBalance: clampNumber(raw?.helpBalance, 0),
    // Document Set Commit 2 — private hospital cover suppresses the
    // Medicare Levy Surcharge entirely for this person. Default TRUE
    // (MLS off unless the user says otherwise) — the safer default for
    // an advice tool, per the spec.
    privateHospitalCover: raw?.privateHospitalCover !== false,
  };
}

// --- projection end basis (D1) ----------------------------------------------

export const END_BASIS_OFFSETS = [-15, -10, -5, 0, 5, 10, 15, 20];

export function clampEndBasis(raw) {
  const mode = ["le", "fixedAge", "fixedYears"].includes(raw?.mode) ? raw.mode : "le";
  const offset = END_BASIS_OFFSETS.includes(raw?.offset) ? raw.offset : 0;
  return {
    mode,
    offset,
    fixedAge: clampInt(raw?.fixedAge ?? 90, 19, 120),
    fixedYears: clampInt(raw?.fixedYears ?? 40, 1, 100),
  };
}

// Resolve the projection end (client-anchored endAge) from the basis.
// LE bases anchor to the household's LONGEST remaining life
// expectancy; `anchor` says whose. Rounded to whole plan years.
export function resolveEndBasis(basis, client, partner) {
  if (basis.mode === "fixedAge") {
    return { endAge: Math.max(basis.fixedAge, client.currentAge + 1), anchor: null };
  }
  if (basis.mode === "fixedYears") {
    return { endAge: Math.min(client.currentAge + basis.fixedYears, 120), anchor: null };
  }
  let anchor = "client";
  let years = Math.round(remainingLE(client.currentAge, client.sex));
  if (partner) {
    const py = Math.round(remainingLE(partner.currentAge, partner.sex));
    if (py > years) { years = py; anchor = "partner"; }
  }
  const endAge = Math.max(client.currentAge + 1, Math.min(client.currentAge + years + basis.offset, 120));
  return { endAge, anchor };
}

export function defaultPlan(now = new Date()) {
  const start = { year: now.getFullYear(), month: now.getMonth() + 1 };
  const client = clampPerson({ currentAge: 40 }, start);
  const endBasis = clampEndBasis({ mode: "le", offset: 0 });
  return {
    household: "single",
    client,
    partner: null,
    endAge: resolveEndBasis(endBasis, client, null).endAge,
    endBasis,
    start,
    keyDates: [],
    superAccounts: [],
    workingCash: { balance: 0, minimumBalance: 0, ratePct: null },
    adviserFees: defaultAdviserFees(),
    implementation: defaultImplementation(),
  };
}

// --- key dates (Tier 1.1) -----------------------------------------------
//
// User-defined named anchors, referenced by DateRefs elsewhere in the
// plan (see clampDateRef below). Built-in anchors (start/end/the two
// retirement anchors) are derived, never stored here — see keyDates.js.

export function createKeyDate(plan) {
  return { id: uid("kd"), label: "", basis: "client", age: plan.client.currentAge };
}

export function clampKeyDate(raw, plan) {
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : uid("kd"),
    label: typeof raw?.label === "string" ? raw.label.trim().slice(0, 60) : "",
    basis: raw?.basis === "partner" && plan.partner ? "partner" : "client",
    age: clampInt(raw?.age, 0, 130),
  };
}

export function normaliseKeyDates(raw, plan) {
  if (!Array.isArray(raw)) return [];
  return raw.map((kd) => clampKeyDate(kd, plan));
}

// A DateRef is either a reference to a built-in/user anchor or an
// explicit age — see keyDates.js for resolution. Clamping here only
// validates SHAPE: an anchor reference is stored as-is (its
// out-of-window handling happens at resolution time, against the
// built schedule, never by silently rewriting the stored reference);
// an explicit age is clamped into [lo, hi] exactly as the old bare
// integer fields were, so migrated {kind:"age"} rows keep their exact
// pre-migration clamping behaviour (the regression gate).
export function clampDateRef(raw, lo, hi, plan) {
  if (raw?.kind === "anchor" && typeof raw.anchorId === "string" && isValidAnchorId(raw.anchorId, plan)) {
    return { kind: "anchor", anchorId: raw.anchorId };
  }
  const age = raw?.kind === "age" ? raw.age : raw;
  return { kind: "age", age: clampInt(age, lo, hi) };
}

export function removeKeyDate(plan, keyDateId) {
  return { ...plan, keyDates: plan.keyDates.filter((k) => k.id !== keyDateId) };
}

// Every row across the plan whose from/to/at/purchaseAt points at
// `anchorId` — built for the "delete this key date" confirm dialog, so
// a deletion never silently orphans a reference.
export function referencesToAnchor(state, anchorId) {
  const found = [];
  const scan = (rows, fields, labelOf) => {
    for (const row of rows ?? []) {
      for (const field of fields) {
        if (row[field]?.kind === "anchor" && row[field].anchorId === anchorId) {
          found.push({ id: row.id, label: labelOf(row), field });
        }
      }
    }
  };
  scan(state.cashflows.income, ["from", "to"], (r) => r.label);
  scan(state.cashflows.expenses, ["from", "to"], (r) => r.label);
  scan(state.cashflows.contributions, ["from", "to"], () => "Contribution");
  scan(state.cashflows.withdrawals, ["from", "to"], () => "Withdrawal");
  scan(state.cashflows.lumpSums, ["at"], () => "One-off amount");
  scan(state.properties, ["purchaseAt"], (r) => r.name);
  return found;
}

// Convert every reference to `anchorId`, plan-wide, into the explicit
// age it currently resolves to — the deletion flow's "Convert those
// references to age N" action. Rows not referencing this anchor are
// untouched (returned as-is).
export function convertAnchorReferences(state, anchorId, age) {
  const swap = (row, field) =>
    row[field]?.kind === "anchor" && row[field].anchorId === anchorId
      ? { ...row, [field]: { kind: "age", age } }
      : row;
  const mapFields = (rows, fields) => rows.map((row) => fields.reduce(swap, row));
  return {
    ...state,
    cashflows: {
      ...state.cashflows,
      income: mapFields(state.cashflows.income, ["from", "to"]),
      expenses: mapFields(state.cashflows.expenses, ["from", "to"]),
      contributions: mapFields(state.cashflows.contributions, ["from", "to"]),
      withdrawals: mapFields(state.cashflows.withdrawals, ["from", "to"]),
      lumpSums: mapFields(state.cashflows.lumpSums, ["at"]),
    },
    properties: mapFields(state.properties ?? [], ["purchaseAt"]),
  };
}

export const dateRefAge = (ref) => (ref?.kind === "age" ? ref.age : null);

// Horizon in plan years (client-anchored).
export function horizonYears(plan) {
  return plan.endAge - plan.client.currentAge;
}

// The age window a given owner's rows may span. The partner ages
// alongside the client for the same number of plan years.
export function ownerWindow(plan, owner) {
  if (owner === "partner" && plan.partner) {
    const from = plan.partner.currentAge;
    return { from, to: from + horizonYears(plan) };
  }
  return { from: plan.client.currentAge, to: plan.endAge };
}

// FY label for the plan year in which `owner` is aged `age`.
// Ages tick over each 1 July: at plan start the owner is already
// currentAge, and turns currentAge+1 at the first 1 July after
// start.{year,month}. FY starting 1 July of year Y is "FY Y–(Y+1)".
export function fyStartForAge(plan, owner, age) {
  const win = ownerWindow(plan, owner);
  const firstJuly = plan.start.year + (plan.start.month >= 7 ? 1 : 0);
  return firstJuly + (age - win.from) - 1;
}

export function fyLabelForAge(plan, owner, age) {
  const fy = fyStartForAge(plan, owner, age);
  return `FY ${fy}–${String((fy + 1) % 100).padStart(2, "0")}`;
}

// Per-row indexation (D1): nominal growth g = basis rate + additional.
// CPI+0 = constant real (the old `indexed: true`); None+0 = fixed
// nominal, decaying at CPI in real terms (the old `false`); AWOTE
// links to the wage index and grows in real terms.
export const INDEX_BASES = ["none", "cpi", "awote"];

export function clampIndexation(row) {
  let basis = row?.indexBasis;
  if (basis == null && row && "indexed" in row) {
    basis = row.indexed === false ? "none" : "cpi"; // pre-D1 migration
  }
  if (!INDEX_BASES.includes(basis)) basis = "cpi";
  return { indexBasis: basis, indexExtraPct: clampNumber(row?.indexExtraPct ?? 0, -10, 10) };
}

// New rows open already anchored (Tier 1.1) — never a number typed
// into an age box. Migrated rows are untouched (they keep whatever
// {kind:"age"} ints they had); this only governs freshly-created rows.
const anchorRef = (anchorId) => ({ kind: "anchor", anchorId });
const ageRef = (age) => ({ kind: "age", age });

// Contributions stop at retirement (kind is "contribution" or
// "withdrawal" — only contributions default to the retirement anchor;
// withdrawals, like expenses, default to running for life).
export function createCashflow(kind, plan, assetId = null) {
  return {
    id: uid("cf"),
    assetId,
    amount: 0,
    frequency: "monthly",
    from: anchorRef("start"),
    to: kind === "contribution" ? anchorRef("retirement-client") : anchorRef("end"),
    indexBasis: "cpi",
    indexExtraPct: 0,
  };
}

// One-off amounts are point events the user always sets deliberately,
// so they default to an explicit age rather than an anchor.
export function createLumpSum(plan, assetId = null, source = "input") {
  return {
    id: uid("ls"),
    assetId,
    amount: 0,
    direction: "in",
    at: ageRef(plan.client.currentAge),
    source: source === "table" ? "table" : "input",
  };
}

export const INCOME_TYPES = ["employment", "rental", "otherTaxable", "nonTaxable"];

// Income row categories (Cashflow table: firm row vocabulary and
// category grouping) — the user-facing field, replacing the old
// incomeType select while keeping its tax semantics exactly: each
// category maps onto one of the old incomeType values below, so
// nothing downstream of clampIncomeRow (SG derivation, nonTaxable's
// tax-assessment bypass, PAYG withholding's employment base) needs to
// change — incomeType is still populated, just derived from category
// now instead of being the row's own stored field.
export const INCOME_CATEGORIES = [
  "salary", "otherIncome", "interestIncome", "dividendIncome", "otherTaxFreeIncome", "afterTaxBonus",
];
export const INCOME_CATEGORY_LABELS = {
  salary: "Salary",
  otherIncome: "Other Income",
  interestIncome: "Interest Income",
  dividendIncome: "Dividend Income",
  otherTaxFreeIncome: "Other tax-free income",
  afterTaxBonus: "After tax bonus",
};
const INCOME_CATEGORY_TAX_TREATMENT = {
  salary: "employment",
  otherIncome: "otherTaxable",
  interestIncome: "otherTaxable",
  dividendIncome: "otherTaxable",
  otherTaxFreeIncome: "nonTaxable",
  afterTaxBonus: "nonTaxable",
};
export function incomeCategoryTaxTreatment(category) {
  return INCOME_CATEGORY_TAX_TREATMENT[category] ?? "otherTaxable";
}
// A pre-Commit-2 row has no category, only incomeType — including the
// "rental" value, which has no dedicated category in the new list; the
// nearest fit is Other Income (rent entered as a manual income row,
// as opposed to the property module's own derived rent).
const LEGACY_INCOME_TYPE_TO_CATEGORY = {
  employment: "salary", rental: "otherIncome", otherTaxable: "otherIncome", nonTaxable: "otherTaxFreeIncome",
};

// Expense row categories (same commit) — Mortgage/Loan repayments and
// Investment Property expenses are [derived] elsewhere (the liability
// and property modules), not a category a user picks here.
export const EXPENSE_CATEGORIES = [
  "nonDiscretionary", "discretionary", "groceryFuel", "holidays", "insurance", "homeMaintenance", "other",
];
export const EXPENSE_CATEGORY_LABELS = {
  nonDiscretionary: "Non-discretionary Living Expenses",
  discretionary: "Discretionary Living Expenses",
  groceryFuel: "Grocery & Fuel Expenses",
  holidays: "Holidays",
  insurance: "New Insurance Premiums",
  homeMaintenance: "Home Maintenance expenses",
  other: "Other",
};

export function createIncomeRow(plan, existing = []) {
  return {
    id: uid("in"),
    label: INCOME_CATEGORY_LABELS.salary,
    owner: "client",
    amount: 0,
    frequency: "annual",
    from: anchorRef("start"),
    to: anchorRef("retirement-client"), // new rows always default owner "client"
    indexBasis: "cpi",
    indexExtraPct: 0,
    category: "salary",
    incomeType: "employment", // derived from category; kept for existing engine consumers
    sgApplies: true, // Super Guarantee (Tier 1.2) — default on for employment income
  };
}

export function createExpenseRow(plan, existing = []) {
  return {
    id: uid("ex"),
    label: EXPENSE_CATEGORY_LABELS.nonDiscretionary,
    category: "nonDiscretionary",
    amount: 0,
    frequency: "annual",
    from: anchorRef("start"),
    to: anchorRef("end"),
    indexBasis: "cpi",
    indexExtraPct: 0,
  };
}

// Deductions (PAYG withholding, tax refund timing, and deductions) —
// every category reduces the owner's assessable income in the existing
// annual.js assessment, exactly like a property's ICR or a loan's
// deductible interest already do. Label defaults to the category name
// and stays free text/editable.
export const DEDUCTION_CATEGORIES = [
  "workingExpense", "vehicle", "insurance", "socialClub",
  "novatedLease", "salaryPackaging", "other",
];
export const DEDUCTION_CATEGORY_LABELS = {
  workingExpense: "Working Expense",
  vehicle: "Vehicle Deductions",
  insurance: "Deductible Insurance Premiums",
  socialClub: "Social Club (pre-tax)",
  novatedLease: "Novated Lease pre-tax",
  salaryPackaging: "Salary Packaging (Living Expenses)",
  other: "Other",
};

export function createDeductionRow(plan, existing = []) {
  return {
    id: uid("ded"),
    label: DEDUCTION_CATEGORY_LABELS.workingExpense,
    owner: "client",
    category: "workingExpense",
    amount: 0,
    frequency: "annual",
    from: anchorRef("start"),
    to: anchorRef("end"),
    indexBasis: "cpi",
    indexExtraPct: 0,
  };
}

// Pick the firm profile whose total nominal return sits nearest to a
// custom allocation's income+growth total.
export function nearestVolBasis(profiles, totalPct) {
  let best = null;
  let bestDist = Infinity;
  for (const [key, p] of Object.entries(profiles)) {
    const dist = Math.abs(p.totalNominal * 100 - totalPct);
    if (dist < bestDist) { bestDist = dist; best = key; }
  }
  return best;
}

export function createAsset(plan, existing = [], profiles = {}) {
  const keys = Object.keys(profiles);
  const n = nextAssetNumber(existing);
  const middleProfile = keys.length ? keys[Math.floor((keys.length - 1) / 2)] : null;
  const balance = 100000;
  return {
    id: uid("as"),
    name: `Asset ${n}`,
    class: "financial",           // "financial" | "lifestyle" (D2)
    include: true,
    owner: "client",              // "client" | "partner" | "joint" (joint = 50/50 in B.1)
    distributions: "reinvest",    // "reinvest" | "cash"
    balance,
    allocation: { mode: "profile", profile: middleProfile },
    icrPct: 0,
    cgtAsset: true,
    costBase: balance,
  };
}

// Lifestyle assets (D2): contents, vehicles, jewellery, other. Value +
// simple nominal growth only — no allocation, no ICR, no
// distributions, no CGT (exempt personal-use treatment; collectables
// are not separately modelled — disclosed), no cashflow targeting,
// never in fundingOrder or surplus-invest targets.
export function createLifestyleAsset(plan, existing = []) {
  const n = existing.filter((a) => a.class === "lifestyle").length + 1;
  return {
    id: uid("ls"),
    name: `Lifestyle asset ${n}`,
    class: "lifestyle",
    include: true,
    owner: "client",
    balance: 0,
    growthPct: 0, // nominal % p.a.
  };
}

export const isLifestyle = (a) => a?.class === "lifestyle";
export const isFinancial = (a) => !isLifestyle(a);

// --- properties (D4) ---------------------------------------------------------

export const PROPERTY_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
export const PROPERTY_TYPES = ["ppr", "holiday", "investment"];

export function createProperty(plan, existing = [], defaultGrowthPct = 5) {
  return {
    id: uid("pr"),
    name: `Property ${existing.length + 1}`,
    owner: "client",
    state: "NSW",
    propertyType: "ppr",     // ppr | holiday | investment
    status: "owned",         // owned | planned
    // owned:
    currentValue: 0,
    acquisitionDate: null,   // ISO date (past); drives CGT regime + gearing rules
    costBase: 0,
    // planned: a purchase is a point event the user always sets
    // deliberately, so it defaults to an explicit age (client + 5,
    // not +1 — a placeholder immediate purchase reads as an error).
    priceToday: 0,
    purchaseAt: ageRef(plan.client.currentAge + 5),
    lvrPct: 80,
    firstHomeBuyer: false,
    newBuild: false,
    purchaseCostsPct: 2,     // transfer/legal, overridable
    dutyOverride: null,      // $ | null
    // both:
    growthPct: defaultGrowthPct, // nominal % p.a.
    // investment only (D1 indexation controls on each):
    rent: { amount: 0, indexBasis: "cpi", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "cpi", indexExtraPct: 0 },
    expensesDeductible: true,
    // Investment only — an annual deduction to the owner, alongside
    // deductible loan interest and expenses (PAYG withholding, tax
    // refund timing, and deductions). Not indexed (a fixed depreciation
    // schedule figure, entered in nominal-today dollars).
    depreciation: 0,
    // Usable equity and borrowing capacity (Implementation/Rates spec,
    // Commit 3) — a SECURITY constraint (this tool never asks whether
    // income could service the resulting loan; see the spec's own
    // "be explicit about what this is not"). equityCeilingPct is the
    // bank's usual LVR ceiling for a security property (default 80%,
    // configurable per property). depositFromEquity/SourcePropertyId
    // only make sense for a still-to-happen purchase — see
    // clampProperty/normaliseProperties for why the source is
    // validated in two stages, the same pattern releaseFhsssAtPurchase
    // and firstHomeGuarantee already use for their own "only on a
    // planned purchase" rules.
    equityCeilingPct: 80,
    depositFromEquity: false,
    depositFromEquitySourcePropertyId: null,
  };
}

export function clampProperty(p, plan) {
  const flow = (f) => ({ amount: clampNumber(f?.amount, 0), ...clampIndexation(f ?? {}) });
  const propertyType = PROPERTY_TYPES.includes(p.propertyType) ? p.propertyType : "ppr";
  const status = p.status === "planned" ? "planned" : "owned";
  return {
    id: typeof p.id === "string" && p.id ? p.id : uid("pr"),
    name: typeof p.name === "string" && p.name.trim() ? p.name : "Property",
    owner: ["client", "partner", "joint"].includes(p.owner) && (p.owner === "client" || plan.partner)
      ? p.owner : "client",
    state: PROPERTY_STATES.includes(p.state) ? p.state : "NSW",
    propertyType,
    status,
    currentValue: clampNumber(p.currentValue, 0),
    acquisitionDate: typeof p.acquisitionDate === "string" && !Number.isNaN(new Date(p.acquisitionDate).getTime())
      ? p.acquisitionDate : null,
    costBase: clampNumber(p.costBase, 0),
    priceToday: clampNumber(p.priceToday, 0),
    purchaseAt: clampDateRef(
      p.purchaseAt ?? (p.purchaseAge != null ? ageRef(p.purchaseAge) : ageRef(plan.client.currentAge + 5)),
      plan.client.currentAge, plan.endAge, plan
    ),
    lvrPct: clampNumber(p.lvrPct ?? 80, 0, 100),
    firstHomeBuyer: p.firstHomeBuyer === true,
    newBuild: p.newBuild === true,
    purchaseCostsPct: clampNumber(p.purchaseCostsPct ?? 2, 0, 10),
    dutyOverride: p.dutyOverride == null ? null : clampNumber(p.dutyOverride, 0),
    // Document Set Commit 4 (LMI / First Home Guarantee) — input
    // integrity: the FHBG waiver only makes sense for a still-to-happen
    // first-home purchase, so it's forced off otherwise, same pattern
    // as releaseFhsssAtPurchase above.
    firstHomeGuarantee: p.firstHomeGuarantee === true && status === "planned" && p.firstHomeBuyer === true,
    lmiOverride: p.lmiOverride == null ? null : clampNumber(p.lmiOverride, 0),
    lmiPayAtSettlement: p.lmiPayAtSettlement === true,
    growthPct: clampNumber(p.growthPct ?? 5, -10, 30),
    rent: flow(p.rent),
    expenses: flow(p.expenses),
    expensesDeductible: p.expensesDeductible !== false,
    depreciation: clampNumber(p.depreciation, 0),
    // Document Set Commit 3 (FHSSS) — input integrity: releasing FHSSS
    // only makes sense for a still-to-happen PPR purchase (the scheme
    // exists to fund a first home), so the toggle is forced false for
    // an owned property or an investment purchase rather than left to
    // produce a silently-meaningless flag.
    releaseFhsssAtPurchase: p.releaseFhsssAtPurchase === true && status === "planned" && propertyType === "ppr",
    // Usable equity and borrowing capacity (Commit 3). equityCeilingPct
    // is meaningful for ANY property (equity can be a deposit source
    // whether the property housing it is owned or itself still
    // planned), so it's not gated on status the way the flag below is.
    equityCeilingPct: clampNumber(p.equityCeilingPct ?? 80, 0, 100),
    // depositFromEquity only makes sense for a still-to-happen
    // purchase (same "only on a planned purchase" input-integrity rule
    // as releaseFhsssAtPurchase above); depositFromEquitySourcePropertyId
    // is only SHAPE-validated here (a string or null) — existence
    // against the SIBLING property list can't be checked in this
    // function (clampProperty never sees the other properties), so
    // normaliseProperties does that second-stage check below, the same
    // two-stage pattern clampAllToPlan already uses for
    // plan.implementation's own cross-referencing fields.
    depositFromEquity: p.depositFromEquity === true && status === "planned",
    depositFromEquitySourcePropertyId: typeof p.depositFromEquitySourcePropertyId === "string" && p.depositFromEquitySourcePropertyId
      ? p.depositFromEquitySourcePropertyId : null,
  };
}

export function normaliseProperties(properties, plan) {
  if (!Array.isArray(properties)) return [];
  const clamped = properties.map((p) => clampProperty(p, plan));
  const ids = new Set(clamped.map((p) => p.id));
  // A depositFromEquity flag with no valid, DIFFERENT sibling property
  // to source from is meaningless — forced off entirely (not just its
  // source nulled) rather than left as a flag pointing nowhere.
  return clamped.map((p) => {
    const validSource = p.depositFromEquitySourcePropertyId
      && p.depositFromEquitySourcePropertyId !== p.id
      && ids.has(p.depositFromEquitySourcePropertyId);
    if (p.depositFromEquity && validSource) return p;
    return { ...p, depositFromEquity: false, depositFromEquitySourcePropertyId: null };
  });
}

// --- liabilities (D3) --------------------------------------------------------

export const LIABILITY_TYPES = ["mortgage", "investment", "personal", "other"];

export function createLiability(plan, existing = []) {
  return {
    id: uid("lb"),
    name: `Loan ${existing.length + 1}`,
    type: "mortgage",
    owner: "client",
    balance: 0,
    interestRatePct: 6.0, // nominal p.a. — the rate while rateType is "variable"
    termYears: 25,
    repayment: "pi",      // "pi" | "io" (ioYears of IO, then P&I)
    ioYears: 5,
    deductible: false,    // interest deducts against the owner's income
    linkedAssetId: null,  // informational; used by D4 purchases
    offsetAssetId: null,  // financial asset whose balance offsets interest
    extraRepayments: [],  // Document Set Commit 5
    oneOffRepayments: [], // Document Set Commit 5
    // Fixed-rate rollover (Implementation/Rates spec, Commit 1) — see
    // that spec's own header for the accrual/repayment mechanics.
    rateType: "variable",              // "variable" | "fixed"
    fixedRatePct: 6.0,                 // used while rateType === "fixed"; interestRatePct is unused then
    fixedUntil: ageRef(plan.client.currentAge + 3), // DateRef — the rollover point
    revertRatePct: null,               // null = falls back to assumptions.mortgageRate at use-time (same override-or-default shape as dutyOverride/lmiOverride)
    commencedOn: null,                 // ISO date (past); informational only, drives nothing
  };
}

// --- extra and one-off loan repayments (Document Set Commit 5) -------------
//
// Client-anchored like every other non-income cashflow-shaped row
// (super contributions, one-offs) — never owner-anchored, regardless
// of the liability's own owner.

export function createExtraRepayment(plan, existing = []) {
  return {
    id: uid("er"),
    label: `Extra repayment ${existing.length + 1}`,
    amount: 0,
    frequency: "monthly",
    from: anchorRef("start"),
    to: anchorRef("end"),
    indexBasis: "none",
    indexExtraPct: 0,
  };
}

export function clampExtraRepayment(er, plan) {
  const { from, to } = clampFromTo(er, plan.client.currentAge, plan.endAge, plan);
  return {
    id: typeof er.id === "string" && er.id ? er.id : uid("er"),
    label: typeof er.label === "string" && er.label.trim() ? er.label : "Extra repayment",
    amount: clampNumber(er.amount, 0),
    frequency: er.frequency === "annual" ? "annual" : "monthly",
    from, to,
    ...clampIndexation(er),
  };
}

export function createOneOffRepayment(plan) {
  return { id: uid("or"), label: "Lump-sum repayment", amount: 0, at: anchorRef("start") };
}

export function clampOneOffRepayment(or, plan) {
  return {
    id: typeof or.id === "string" && or.id ? or.id : uid("or"),
    label: typeof or.label === "string" && or.label.trim() ? or.label : "Lump-sum repayment",
    amount: clampNumber(or.amount, 0),
    at: clampDateRef(or.at ?? anchorRef("start"), plan.client.currentAge, plan.endAge, plan),
  };
}

export function clampLiability(l, plan, assets, properties = []) {
  const financialIds = new Set(assets.filter((a) => isFinancial(a)).map((a) => a.id));
  // linkedAssetId may reference any asset OR a property (D4).
  const allIds = new Set([
    ...assets.map((a) => a.id),
    ...(Array.isArray(properties) ? properties.map((p) => p.id) : []),
  ]);
  const type = LIABILITY_TYPES.includes(l.type) ? l.type : "mortgage";
  const termYears = clampInt(l.termYears ?? 25, 1, 50);
  return {
    id: typeof l.id === "string" && l.id ? l.id : uid("lb"),
    name: typeof l.name === "string" && l.name.trim() ? l.name : "Loan",
    type,
    owner: ["client", "partner", "joint"].includes(l.owner) && (l.owner === "client" || plan.partner)
      ? l.owner : "client",
    balance: clampNumber(l.balance, 0),
    interestRatePct: clampNumber(l.interestRatePct ?? 6, 0, 30),
    termYears,
    repayment: l.repayment === "io" ? "io" : "pi",
    // An IO period longer than the loan's own term is a contradiction,
    // not just unusual — bound it to the term, not a static 30
    // (input integrity; the engine already capped this defensively at
    // use-time via ioMonths()'s own Math.min, so no projection was
    // ever actually wrong, but the stored value could silently say
    // something the output never did).
    ioYears: clampInt(l.ioYears ?? 5, 1, termYears),
    deductible: l.deductible === true,
    linkedAssetId: allIds.has(l.linkedAssetId) ? l.linkedAssetId : null,
    offsetAssetId: financialIds.has(l.offsetAssetId) ? l.offsetAssetId : null,
    extraRepayments: Array.isArray(l.extraRepayments) ? l.extraRepayments.map((er) => clampExtraRepayment(er, plan)) : [],
    oneOffRepayments: Array.isArray(l.oneOffRepayments) ? l.oneOffRepayments.map((or) => clampOneOffRepayment(or, plan)) : [],
    // Fixed-rate rollover (Implementation/Rates spec, Commit 1).
    // fixedUntil is a DateRef like any other one-off plan event
    // (goal.targetAt, oneOffRepayment.at) — clamped into the projection
    // window the same way, never left dangling. revertRatePct is a
    // manual-override-or-default field (null = "use the assumption"),
    // the same shape dutyOverride/lmiOverride already use elsewhere —
    // a legitimate stored state, not a value needing a numeric clamp.
    rateType: l.rateType === "fixed" ? "fixed" : "variable",
    fixedRatePct: clampNumber(l.fixedRatePct ?? 6, 0, 30),
    fixedUntil: clampDateRef(l.fixedUntil ?? ageRef(plan.client.currentAge + 3), plan.client.currentAge, plan.endAge, plan),
    revertRatePct: l.revertRatePct != null ? clampNumber(l.revertRatePct, 0, 30) : null,
    commencedOn: typeof l.commencedOn === "string" && !Number.isNaN(new Date(l.commencedOn).getTime())
      ? l.commencedOn : null,
  };
}

export function normaliseLiabilities(liabilities, plan, assets, properties = []) {
  if (!Array.isArray(liabilities)) return [];
  return liabilities.map((l) => clampLiability(l, plan, assets, properties));
}

// --- goals (Document Set Commit 6) ------------------------------------------
//
// A goal accrues straight-line from plan start toward its (indexed)
// target, funded either from a named financial asset (a scheduled
// withdrawal, naturally capped at the asset's balance) or from
// household surplus (capped at whatever's actually left over each
// month — a goal can't manufacture cash that doesn't exist, unlike an
// instructed transaction such as a loan repayment or a property
// purchase). "Spent at the target date" is modelled as the accrual
// itself — the money progressively leaves its funding source exactly
// as it's earmarked, so by the target date the (indexed) target amount
// has already left the model; there is no separate goal-balance ledger
// holding money in limbo between accrual and spend.

export function createGoal(plan, existing = []) {
  return {
    id: uid("gl"),
    label: `Goal ${existing.length + 1}`,
    targetAmount: 0,
    targetAt: anchorRef("end"),
    fundedFrom: "surplus",
    indexBasis: "cpi",
    indexExtraPct: 0,
  };
}

export function clampGoal(g, plan, assets) {
  const financialIds = new Set(assets.filter((a) => isFinancial(a)).map((a) => a.id));
  return {
    id: typeof g.id === "string" && g.id ? g.id : uid("gl"),
    label: typeof g.label === "string" && g.label.trim() ? g.label : "Goal",
    targetAmount: clampNumber(g.targetAmount, 0),
    targetAt: clampDateRef(g.targetAt ?? anchorRef("end"), plan.client.currentAge, plan.endAge, plan),
    // A stale/removed asset reference falls back to "surplus" rather
    // than silently funding from nothing — same "unknown reference
    // dropped" convention as linkedAssetId/offsetAssetId.
    fundedFrom: g.fundedFrom === "surplus" || financialIds.has(g.fundedFrom) ? g.fundedFrom : "surplus",
    ...clampIndexation(g),
  };
}

export function normaliseGoals(goals, plan, assets) {
  if (!Array.isArray(goals)) return [];
  return goals.map((g) => clampGoal(g, plan, assets));
}

// --- superannuation accounts (Tier 1.2, accumulation phase only) -----------
//
// Super accounts are never joint (owner: "client" | "partner" only) and
// live on plan.superAccounts, not state.assets — they are a distinct
// asset class with their own (fund-level) tax treatment, never
// reachable through ordinary fundingOrder/contributions/withdrawals/
// one-offs (normaliseFundingOrder/normaliseSettings only ever look at
// state.assets, so that exclusion holds structurally, at every layer,
// without any extra guard here).

export function createSuperAccount(plan, existing = [], profiles = {}, owner = "client") {
  const keys = Object.keys(profiles);
  const middleProfile = keys.length ? keys[Math.floor((keys.length - 1) / 2)] : null;
  const person = owner === "partner" ? plan.partner : plan.client;
  const label = personDisplayName(person, owner === "partner" ? "Partner" : "Client");
  return {
    id: uid("su"),
    name: `Super — ${label}`,
    owner,
    balance: 0,
    taxFreeComponent: 0,
    allocation: { mode: "profile", profile: middleProfile },
    icrPct: 0,
    include: true,
  };
}

export function clampSuperAccount(sa, plan, profiles = {}) {
  const owner = sa.owner === "partner" && plan.partner ? "partner" : "client";
  const balance = clampNumber(sa.balance, 0);
  return {
    id: typeof sa.id === "string" && sa.id ? sa.id : uid("su"),
    name: typeof sa.name === "string" && sa.name.trim() ? sa.name : "Super account",
    owner,
    balance,
    // Taxable component = balance − taxFreeComponent; never negative.
    taxFreeComponent: clampNumber(sa.taxFreeComponent, 0, balance),
    allocation: clampAllocation(sa.allocation, profiles),
    icrPct: clampNumber(sa.icrPct, 0, 100),
    include: sa.include !== false,
  };
}

export function normaliseSuperAccounts(accounts, plan, profiles = {}) {
  if (!Array.isArray(accounts)) return [];
  return accounts.map((sa) => clampSuperAccount(sa, plan, profiles));
}

// --- superannuation contributions (Tier 1.2) -------------------------------
//
// A plan-level cashflow section like income/expenses, not asset-
// targeted like contributions/withdrawals — accountId says which
// super account receives it. from/to are client-anchored (Key Dates,
// Tier 1.1), matching the convention for contributions/withdrawals
// (never owner-anchored, regardless of the row's own owner).

export const SUPER_CONTRIBUTION_TYPES = [
  "sg", "salarySacrifice", "personalDeductible", "personalNonDeductible", "spouse",
];
export const SUPER_CONTRIBUTION_BASES = ["amount", "percentOfIncome", "toConcessionalCap"];

export function createSuperContribution(plan, superAccounts = [], owner = "client") {
  const account = superAccounts.find((s) => s.owner === owner) ?? null;
  return {
    id: uid("sc"),
    label: "Contribution",
    owner,
    accountId: account ? account.id : null,
    type: "salarySacrifice",
    basis: "amount",
    amount: 0,
    percent: 0,
    incomeRowId: null,
    frequency: "monthly",
    from: anchorRef("start"),
    to: anchorRef(owner === "partner" ? "retirement-partner" : "retirement-client"),
    indexBasis: "cpi",
    indexExtraPct: 0,
  };
}

// FHSSS-eligible types (Document Set Commit 3): voluntary contributions
// only — salary sacrifice, personal deductible, personal non-deductible.
// SG is never eligible (not voluntary) and spouse contributions are
// excluded too (not the contributing person's own voluntary
// contribution, per the ATO's FHSSS rules), even though a "toConcessional
// Cap" fill or spouse row shares other machinery with the eligible types.
export const FHSSS_ELIGIBLE_TYPES = ["salarySacrifice", "personalDeductible", "personalNonDeductible"];

export function clampSuperContribution(sc, plan, superAccountOwnerById, incomeRowIds) {
  const owner = sc.owner === "partner" && plan.partner ? "partner" : "client";
  const type = SUPER_CONTRIBUTION_TYPES.includes(sc.type) ? sc.type : "salarySacrifice";
  const basis = SUPER_CONTRIBUTION_BASES.includes(sc.basis) ? sc.basis : "amount";
  const { from, to } = clampFromTo(sc, plan.client.currentAge, plan.endAge, plan);
  return {
    id: typeof sc.id === "string" && sc.id ? sc.id : uid("sc"),
    label: typeof sc.label === "string" && sc.label.trim() ? sc.label : "Contribution",
    owner,
    // Super accounts are never joint (Tier 1.2) — a contribution's
    // account must belong to the SAME person as its own owner field,
    // not just exist somewhere in the plan (input integrity: crediting
    // one person's money, and its tax attribution, to the other
    // person's account is a real, silent misattribution bug, not a
    // cosmetic one).
    accountId: superAccountOwnerById.get(sc.accountId) === owner ? sc.accountId : null,
    type,
    basis,
    amount: clampNumber(sc.amount, 0),
    percent: clampNumber(sc.percent, 0, 100),
    incomeRowId: incomeRowIds.has(sc.incomeRowId) ? sc.incomeRowId : null,
    frequency: sc.frequency === "annual" ? "annual" : "monthly",
    from, to,
    // Input integrity: an SG row, a spouse row, or a dynamic
    // "toConcessionalCap" fill (whose amount depends on the live
    // carry-forward ledger, not a fixed dollar figure — see
    // schedule.js's toConcessionalCapRows header) flagged FHSSS-
    // eligible would be a state the engine can't act on faithfully, so
    // it's forced false rather than silently ignored downstream.
    fhsssEligible: sc.fhsssEligible === true && FHSSS_ELIGIBLE_TYPES.includes(type) && basis !== "toConcessionalCap",
    ...clampIndexation(sc),
  };
}

export function normaliseSuperContributions(rows, plan, superAccountOwnerById, incomeRowIds) {
  if (!Array.isArray(rows)) return [];
  return rows.map((sc) => clampSuperContribution(sc, plan, superAccountOwnerById, incomeRowIds));
}

// --- superannuation withdrawals (Tier 1.2, Commit 3) -----------------------
//
// Client-anchored like every other cashflow row (never owner-anchored,
// regardless of the row's own owner — same convention as contributions/
// withdrawals/super contributions). Only actually PAID once the
// account owner's condition of release is met — see
// src/data/superRates.js's superReleaseAge and deterministic.js.

export function createSuperWithdrawal(plan, superAccounts = [], owner = "client") {
  const account = superAccounts.find((s) => s.owner === owner) ?? null;
  return {
    id: uid("sw"),
    label: "Withdrawal",
    owner,
    accountId: account ? account.id : null,
    amount: 0,
    frequency: "monthly",
    from: anchorRef(owner === "partner" ? "retirement-partner" : "retirement-client"),
    to: anchorRef("end"),
    indexBasis: "cpi",
    indexExtraPct: 0,
  };
}

export function clampSuperWithdrawal(sw, plan, superAccountOwnerById) {
  const owner = sw.owner === "partner" && plan.partner ? "partner" : "client";
  const { from, to } = clampFromTo(sw, plan.client.currentAge, plan.endAge, plan);
  return {
    id: typeof sw.id === "string" && sw.id ? sw.id : uid("sw"),
    label: typeof sw.label === "string" && sw.label.trim() ? sw.label : "Withdrawal",
    owner,
    accountId: superAccountOwnerById.get(sw.accountId) === owner ? sw.accountId : null, // same-owner only — see clampSuperContribution
    amount: clampNumber(sw.amount, 0),
    frequency: sw.frequency === "annual" ? "annual" : "monthly",
    from, to,
    ...clampIndexation(sw),
  };
}

export function normaliseSuperWithdrawals(rows, plan, superAccountOwnerById) {
  if (!Array.isArray(rows)) return [];
  return rows.map((sw) => clampSuperWithdrawal(sw, plan, superAccountOwnerById));
}

function nextAssetNumber(existing) {
  let max = 0;
  for (const a of existing) {
    const m = /^Asset (\d+)$/.exec(a.name || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Math.max(max, existing.length) + 1;
}

// Input Usability spec, Commit 2 — "touched" field paths, i.e. fields
// the user has attended to (entered a value, or explicitly confirmed a
// default via the tick affordance / "mark all reviewed"). A plain
// array of dotted paths (`plan.client.retirementAge`,
// `assets.<id>.balance`, …); deduped and filtered to non-empty strings
// so junk in a hand-edited import can't corrupt the review panel.
export function clampTouched(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((p) => typeof p === "string" && p.length > 0))];
}

export function defaultState(profiles = {}, now = new Date()) {
  const plan = defaultPlan(now);
  const asset = createAsset(plan, [], profiles);
  return {
    schemaVersion: SCHEMA_VERSION,
    plan,
    assets: [asset],
    cashflows: {
      income: [],
      expenses: [],
      deductions: [],
      contributions: [createCashflow("contribution", plan, asset.id)],
      withdrawals: [],
      lumpSums: [],
      superContributions: [],
      superWithdrawals: [],
    },
    liabilities: [],
    properties: [],
    goals: [],
    settings: {
      surplus: { mode: "accumulate", assetId: null },
      fundingOrder: [asset.id],
    },
    display: {
      units: "real",
      reportPeriod: defaultReportPeriod(plan),
      lastVisited: { area: "input", section: DEFAULT_INPUT_SECTION },
      chartTreatment: defaultChartTreatment(),
      hideEmptyRows: true,
      showIndividualCashflowItems: false,
    },
    assumptions: { cpi: 0.025, awote: 0.035, mortgageRate: 0.06, bracketMode: "indexed", fhsssEarningsRate: 0.0794 },
    // A newly created scenario starts fully untouched — correct, since
    // nobody has reviewed it yet (Input Usability spec, Commit 2).
    meta: { touched: [] },
  };
}

// --- one-off grid helpers (C2) -------------------------------------------
//
// The Cashflow view's editable one-off cells manage exactly one
// table-sourced lump sum per asset+FY; input-panel-sourced rows for
// the same cell live alongside untouched.

// Table-sourced one-offs are always an explicit age (never an anchor
// — they're identified by their grid column, a bare client age).
export function tableLumpSumFor(lumpSums, assetId, age) {
  return lumpSums.find(
    (l) => l.source === "table" && l.assetId === assetId && l.at?.kind === "age" && l.at.age === age
  ) || null;
}

// Upsert (or delete, when value is 0/empty/invalid) the table-sourced
// one-off for an asset+FY. value is signed: +inflow / −outflow.
export function upsertTableLumpSum(lumpSums, assetId, age, value) {
  const existing = tableLumpSumFor(lumpSums, assetId, age);
  const rest = lumpSums.filter((l) => l !== existing);
  const v = Number(value);
  if (!Number.isFinite(v) || v === 0) return rest;
  return [...rest, {
    id: existing?.id ?? uid("ls"),
    assetId,
    amount: Math.abs(v),
    direction: v < 0 ? "out" : "in",
    at: ageRef(age),
    source: "table",
  }];
}

// Convention 5: one-offs fire in July; a partial first year starting
// after July has no firing July, so its grid cell is not editable.
export function canEditOneOffYear(plan, planYear) {
  return planYear > 0 || plan.start.month === 7;
}

// Report period (D5): client-AGE bounds for the full-detail range,
// then thinning to every Nth plan year beyond `toAge` through the
// projection's actual end (src/periodThinning.js does the resolving).
// Display state, not plan state — it only narrows what the output
// views show; null bounds mean unbounded (fromAge null = from the
// start; toAge null = full detail all the way to the end, i.e. no
// thinning ever applies — the "All" default).
export const PERIOD_STEP_OPTIONS = [1, 2, 5, 10];

// Default report period for a freshly-created scenario: full detail
// out to a sensible horizon (the client's Retirement key date + 25
// years, capped at the plan's actual end) rather than the full
// projection end, and thinned (every 5th plan year beyond toAge) when
// the overall projection span is long enough that per-year detail at
// the far end adds no value. A 60+-year x-axis with decades of flat
// post-retirement years at the end is not a useful default; the user
// can still widen the period to "All" from the period selector.
export function defaultReportPeriod(plan) {
  const span = plan.endAge - plan.client.currentAge;
  const toAge = Math.min(plan.endAge, plan.client.retirementAge + 25);
  return { fromAge: null, toAge, everyN: span > 25 ? 5 : 1, forceKeyYears: true };
}

export function clampReportPeriod(raw) {
  const age = (v) => (Number.isInteger(v) && v >= 0 && v <= 130 ? v : null);
  const fromAge = age(raw?.fromAge);
  let toAge = age(raw?.toAge);
  if (fromAge != null && toAge != null && toAge < fromAge) toAge = fromAge;
  const everyN = PERIOD_STEP_OPTIONS.includes(raw?.everyN) ? raw.everyN : 1;
  const forceKeyYears = raw?.forceKeyYears !== false;
  return { fromAge, toAge, everyN, forceKeyYears };
}

// --- chart display treatment (D5) -----------------------------------------
//
// Display-level ONLY: which asset classes fold into the composite
// chart's main net-assets area vs. show as their own stacked area vs.
// drop from the chart entirely. Never touches engine output or table
// values — tables always show full detail regardless of this setting.

export const CHART_TREATMENTS = ["exclude", "include", "separate"];

export function defaultChartTreatment() {
  return { pprProperty: "separate", otherProperty: "include", lifestyle: "separate", liabilities: "include" };
}

export function clampChartTreatment(raw) {
  const pick = (v, dflt) => (CHART_TREATMENTS.includes(v) ? v : dflt);
  const d = defaultChartTreatment();
  return {
    pprProperty: pick(raw?.pprProperty, d.pprProperty),
    otherProperty: pick(raw?.otherProperty, d.otherProperty),
    lifestyle: pick(raw?.lifestyle, d.lifestyle),
    liabilities: pick(raw?.liabilities, d.liabilities),
  };
}

// --- Snapshot view (Document Set Commit 7) ----------------------------
//
// Up to six DateRef year selections, persisted per scenario like every
// other display-state field above. Smart defaults (current year,
// retirement, four spread between) need a resolved schedule/anchors
// list this pure module doesn't have, so they're computed lazily by
// the caller (main.js) the first time the view renders with none
// selected — an empty array here is a valid, meaningful state (not yet
// chosen), not an error.
export const MAX_SNAPSHOT_YEARS = 6;

export function clampSnapshotYears(raw, plan) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_SNAPSHOT_YEARS).map((ref) => clampDateRef(ref, plan.client.currentAge, plan.endAge, plan));
}

// --- sidebar navigation (page-per-section) -------------------------------
//
// Display state only — which page a scenario last showed, so reopening
// it restores where the user left off (unless the scenario is
// effectively empty, in which case landing always goes to Setup; see
// isScenarioEffectivelyEmpty below).

export function clampLastVisited(raw) {
  if (raw?.area === "input" && INPUT_SECTIONS.includes(raw.section)) {
    return { area: "input", section: raw.section };
  }
  if (raw?.area === "output" && OUTPUT_VIEWS.includes(raw.section)) {
    return { area: "output", section: raw.section };
  }
  return { area: "input", section: DEFAULT_INPUT_SECTION };
}

// A scenario counts as "effectively empty" when nothing beyond the
// single default financial asset has been entered — no cashflows, no
// extra assets, no lifestyle assets, no property, no liabilities.
// Landing always goes to Setup for these (rather than wherever the
// scenario was last left, which for a never-configured scenario is
// meaningless), and it's what a brand-new client/scenario naturally
// satisfies on first visit.
export function isScenarioEffectivelyEmpty(state) {
  const cf = state.cashflows;
  const financialCount = state.assets.filter(isFinancial).length;
  const lifestyleCount = state.assets.filter(isLifestyle).length;
  // A brand-new scenario ships with exactly one financial asset and
  // one default contribution row targeting it — that seed doesn't
  // count as "configured".
  const investCashflowCount = cf.contributions.length + cf.withdrawals.length + cf.lumpSums.length;
  return (
    cf.income.length === 0 &&
    (cf.deductions ?? []).length === 0 &&
    cf.expenses.length === 0 &&
    investCashflowCount <= 1 &&
    financialCount <= 1 &&
    lifestyleCount === 0 &&
    (state.liabilities ?? []).length === 0 &&
    (state.properties ?? []).length === 0 &&
    (state.plan.superAccounts ?? []).length === 0
  );
}

// Sidebar badge counts (item counts, not completion — a portfolio-only
// scenario is finished, not partial). No entry for sections that
// aren't "a list" (Setup, Settings).
export function sectionCounts(state) {
  const cf = state.cashflows;
  return {
    income: cf.income.length,
    deductions: (cf.deductions ?? []).length,
    expenses: cf.expenses.length,
    "financial-assets": state.assets.filter(isFinancial).length,
    "lifestyle-assets": state.assets.filter(isLifestyle).length,
    property: (state.properties ?? []).length,
    super: (state.plan.superAccounts ?? []).length,
    liabilities: (state.liabilities ?? []).length,
    goals: (state.goals ?? []).length,
    "investment-cashflows": cf.contributions.length + cf.withdrawals.length + cf.lumpSums.length,
  };
}

// --- validation / clamping ---------------------------------------------

export function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function clampNumber(v, lo = 0, hi = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export const ALLOC_PCT_MAX = 30;

export function clampAllocation(alloc, profiles) {
  const keys = Object.keys(profiles);
  const fallback = keys.length ? keys[Math.floor((keys.length - 1) / 2)] : null;
  if (!alloc || alloc.mode !== "custom") {
    const profile = keys.includes(alloc?.profile) ? alloc.profile : fallback;
    return { mode: "profile", profile };
  }
  const incomePct = clampNumber(alloc.incomePct, 0, ALLOC_PCT_MAX);
  const growthPct = clampNumber(alloc.growthPct, 0, ALLOC_PCT_MAX);
  const frankingPct = clampNumber(alloc.frankingPct, 0, 100);
  const volBasis = keys.includes(alloc.volBasis)
    ? alloc.volBasis
    : nearestVolBasis(profiles, incomePct + growthPct);
  return { mode: "custom", incomePct, growthPct, frankingPct, volBasis };
}

// `profiles` is only needed to re-validate super accounts' allocation
// (Tier 1.2) — every other caller may omit it.
export function clampPlan(plan, profiles = {}) {
  const year = clampInt(plan.start?.year, 1900, 2200);
  const month = clampInt(plan.start?.month, 1, 12);
  const start = { year, month };

  // v4 stored "couple"; v5 splits marital status.
  let household = plan.household === "couple" ? "married" : plan.household;
  if (!["single", "married", "defacto"].includes(household)) household = "single";

  const clientRaw = clampPerson(plan.client, start);
  const partnerRaw = isCoupleHousehold(household)
    ? clampPerson(plan.partner ?? { currentAge: clientRaw.currentAge }, start)
    : null;

  // Missing basis (pre-D1 blob or partial edit): fix at the stored
  // endAge so migrated projections are behaviour-identical.
  const endBasis = clampEndBasis(
    plan.endBasis ?? { mode: "fixedAge", fixedAge: clampInt(plan.endAge, 19, 120) }
  );
  const { endAge } = resolveEndBasis(endBasis, clientRaw, partnerRaw);
  // Input integrity: a retirement age below the person's current age,
  // or beyond the projection's own end, isn't a real retirement date
  // this tool can model — re-clamp now that endAge is finally known
  // (clampPerson runs before endAge is resolved, so it could only
  // enforce the static [18,120] bound). See CLAUDE.md's Input
  // integrity section.
  const client = { ...clientRaw, retirementAge: clampInt(clientRaw.retirementAge, clientRaw.currentAge, endAge) };
  const partner = partnerRaw
    ? { ...partnerRaw, retirementAge: clampInt(partnerRaw.retirementAge, partnerRaw.currentAge, endAge) }
    : null;
  // keyDates are validated against the PRE-clamp partner presence too
  // (normaliseKeyDates itself falls a partner-basis date back to
  // client when there's no partner), so this order is safe either way.
  const keyDates = normaliseKeyDates(plan.keyDates, { client, partner });
  // Super accounts (Tier 1.2) live on the plan, alongside client/
  // partner — they are always person-owned, never joint, so they
  // belong with identity rather than with the joint-ownable financial
  // asset list.
  const superAccounts = normaliseSuperAccounts(plan.superAccounts, { client, partner }, profiles);
  // Adviser fees (Implementation/Rates spec, Commit 2) — validated
  // against superAccounts, which is already known here; implementation
  // is only BASIC-clamped at this stage (see clampImplementationBasic's
  // own header for why its allocations need a second pass, later, once
  // assets/goals are known too).
  const adviserFees = clampAdviserFees(plan.adviserFees, superAccounts);
  const implementation = clampImplementationBasic(plan.implementation);
  const workingCash = {
    ...clampWorkingCash(plan.workingCash),
    // "emergencyFundTarget writing through to workingCash.minimumBalance"
    // (the spec's own words) — authoritative once it's actually set
    // (>0); a household that has never touched Implementation keeps
    // whatever minimum balance was entered directly, so this never
    // silently overwrites a value nobody asked it to.
    ...(implementation.emergencyFundTarget > 0 ? { minimumBalance: implementation.emergencyFundTarget } : {}),
  };

  // Document Set Commit 2 — household-level dependent children, for
  // the Medicare Levy Surcharge family threshold (+$1,500/indexed per
  // child after the first — see src/data/mlsRates.js).
  const dependentChildren = clampInt(plan.dependentChildren ?? 0, 0, 20);
  return {
    household, client, partner, endAge, endBasis, start, keyDates, superAccounts, workingCash, dependentChildren,
    adviserFees, implementation,
  };
}

// --- Working Cash Account ---------------------------------------------------
//
// A system cash account that always exists and cannot be deleted —
// all household cashflow passes through it (see deterministic.js's
// monthly loop). Lives on the plan, not state.assets: it is never a
// CGT asset and never targetable by contributions/withdrawals/one-offs
// (structurally excluded the same way super accounts are — those
// mechanisms only ever look at state.assets).
export function clampWorkingCash(raw) {
  const balance = clampNumber(raw?.balance, 0);
  return {
    balance,
    minimumBalance: clampNumber(raw?.minimumBalance, 0),
    // null = "use the Cash profile's return" (deterministic.js resolves
    // this at projection time, since it needs the profiles table).
    ratePct: raw?.ratePct == null ? null : clampNumber(raw.ratePct, -10, 30),
  };
}

// --- Adviser fees and flow of initial funds (Implementation/Rates
// spec, Commit 2) ------------------------------------------------------
//
// Two independent slices — upfront (once, at plan start) and ongoing
// (every year, indexed) — each split outside/inside super. Lives on
// the plan, not state.X, per the spec's own shape (these are
// implementation-of-the-plan concepts, not client holdings).

export function defaultAdviserFees() {
  return {
    upfront: { total: 0, fromSuperAmount: 0, superAccountId: null },
    ongoing: { annualAmount: 0, fromSuperAmount: 0, superAccountId: null, indexBasis: "cpi" },
  };
}

// fromSuperAmount can't exceed the fee it's meant to cover — bound at
// the control (input integrity). Deliberately NOT zeroed just because
// no account is nominated YET: the two fields are edited independently
// (one change event per keystroke re-clamps the whole plan), so
// wiping fromSuperAmount the instant superAccountId is momentarily
// null would silently discard whatever the adviser just typed if they
// happen to fill the amount before choosing the account — a plain
// data-entry ordering, not an impossible state. The engine itself
// already treats fromSuperAmount as inert without a nominated account
// (deterministic.js gates every use on superAccountId being set), so
// there's no correctness cost to preserving the stored number here.
function clampAdviserFeeSide(raw, total, superAccountIds) {
  const superAccountId = superAccountIds.has(raw?.superAccountId) ? raw.superAccountId : null;
  const requested = clampNumber(raw?.fromSuperAmount ?? 0, 0);
  return { superAccountId, fromSuperAmount: Math.min(requested, total) };
}

export function clampAdviserFees(raw, superAccounts) {
  const superAccountIds = new Set((superAccounts ?? []).map((s) => s.id));
  const upfrontTotal = clampNumber(raw?.upfront?.total ?? 0, 0);
  const ongoingAnnual = clampNumber(raw?.ongoing?.annualAmount ?? 0, 0);
  const upfrontSide = clampAdviserFeeSide(raw?.upfront, upfrontTotal, superAccountIds);
  const ongoingSide = clampAdviserFeeSide(raw?.ongoing, ongoingAnnual, superAccountIds);
  return {
    upfront: { total: upfrontTotal, ...upfrontSide },
    ongoing: { annualAmount: ongoingAnnual, ...ongoingSide, indexBasis: INDEX_BASES.includes(raw?.ongoing?.indexBasis) ? raw.ongoing.indexBasis : "cpi" },
  };
}

// --- Flow of initial funds (Commit 2) ---------------------------------
//
// A reconciliation block, not a new source of truth — assets already
// carry their own opening balances; this shows how the client's
// starting cash gets there. targetAssetId is validated in TWO stages:
// clampImplementationBasic (here) accepts any string shape, since
// clampPlan has no visibility into state.assets/state.goals (they're
// siblings of plan, not children of it); clampAllToPlan's
// refineImplementationAllocations (below) does the real existence
// check once assets/goals are known — the same two-stage pattern
// clampPlan already uses internally for client.retirementAge (bounded
// against endAge, which isn't known until later in the same function).

export function createAllocation(existing = []) {
  return { id: uid("al"), label: `Allocation ${existing.length + 1}`, amount: 0, targetAssetId: "workingCash" };
}

export function defaultImplementation() {
  return { totalCashAvailable: 0, emergencyFundTarget: 0, allocations: [] };
}

export function clampImplementationBasic(raw) {
  return {
    totalCashAvailable: clampNumber(raw?.totalCashAvailable ?? 0, 0),
    emergencyFundTarget: clampNumber(raw?.emergencyFundTarget ?? 0, 0),
    allocations: Array.isArray(raw?.allocations)
      ? raw.allocations.map((a) => ({
          id: typeof a?.id === "string" && a.id ? a.id : uid("al"),
          label: typeof a?.label === "string" && a.label.trim() ? a.label.trim().slice(0, 60) : "Allocation",
          amount: clampNumber(a?.amount ?? 0, 0),
          targetAssetId: typeof a?.targetAssetId === "string" && a.targetAssetId ? a.targetAssetId : "workingCash",
        }))
      : [],
  };
}

// Second-stage refinement (clampAllToPlan, once assets/goals exist): a
// targetAssetId that doesn't resolve to "workingCash", a real asset, or
// a real goal falls back to "workingCash" — never silently dropped
// (the amount stays; only a stale/deleted target is corrected), and
// never a throw (an imported/migrated blob may reference an asset that
// no longer exists).
export function refineImplementationAllocations(implementation, assets, goals) {
  const assetIds = new Set((assets ?? []).map((a) => a.id));
  const goalIds = new Set((goals ?? []).map((g) => `goal:${g.id}`));
  const valid = (id) => id === "workingCash" || assetIds.has(id) || goalIds.has(id);
  return {
    ...implementation,
    allocations: implementation.allocations.map((a) => (valid(a.targetAssetId) ? a : { ...a, targetAssetId: "workingCash" })),
  };
}

// A v5-schema row still carries the bare-int field (fromAge/toAge/age)
// instead of the DateRef field (from/to/at) — the migration bumps the
// version and leaves the shape work to these clamps, exactly the
// established pattern (see migrateV4toV5). Prefer the new field when
// both happen to be present.
const legacyOrRef = (row, newField, oldField) =>
  row?.[newField] !== undefined ? row[newField] : row?.[oldField];

// from/to clamping shared by every client-anchored row (contributions,
// withdrawals, expenses; income rows use their own owner window
// instead of [lo, hi] but the same logic). "to" is floored at "from"'s
// resolved age only when from is itself {kind:"age"} — an anchored
// "from" can't be resolved into a concrete age without the built
// schedule, so its out-of-order case is left to resolution time
// (an empty active window, never a crash) rather than enforced here.
function clampFromTo(row, lo, hi, plan) {
  const from = clampDateRef(legacyOrRef(row, "from", "fromAge"), lo, hi, plan);
  const toLo = from.kind === "age" ? from.age : lo;
  const to = clampDateRef(legacyOrRef(row, "to", "toAge"), toLo, hi, plan);
  return { from, to };
}

// Clamp a cashflow with client-anchored dates into the plan window.
export function clampCashflow(cf, plan) {
  const { from, to } = clampFromTo(cf, plan.client.currentAge, plan.endAge, plan);
  const { indexed, fromAge, toAge, from: _f, to: _t, ...rest } = cf;
  return { ...rest, from, to, ...clampIndexation(cf) };
}

export function clampLumpSum(ls, plan) {
  const at = clampDateRef(legacyOrRef(ls, "at", "age"), plan.client.currentAge, plan.endAge, plan);
  const { age, at: _a, ...rest } = ls;
  return { ...rest, at };
}

// Income rows anchor to their owner's window. category (Cashflow
// table: firm row vocabulary) is now the authoritative, user-facing
// field — incomeType is derived FROM it every time (a pre-Commit-2 row
// has no category, only incomeType, including the legacy "rental"
// value; LEGACY_INCOME_TYPE_TO_CATEGORY migrates it once, and category
// is authoritative from then on). incomeType stays populated purely so
// existing engine consumers (SG derivation, nonTaxable's tax-assessment
// bypass, PAYG withholding's employment base) never had to change.
// sgApplies gates on the derived incomeType, same as before — SG only
// ever makes sense for employment income, so a non-salary row's toggle
// is force-cleared regardless of what was stored (defensive — the UI
// hides the toggle for those rows too).
export function clampIncomeRow(row, plan) {
  const owner = row.owner === "partner" && plan.partner ? "partner" : "client";
  const win = ownerWindow(plan, owner);
  const { from, to } = clampFromTo(row, win.from, win.to, plan);
  const { indexed, fromAge, toAge, from: _f, to: _t, ...rest } = row;
  const category = INCOME_CATEGORIES.includes(row.category)
    ? row.category
    : (LEGACY_INCOME_TYPE_TO_CATEGORY[row.incomeType] ?? "salary");
  const incomeType = incomeCategoryTaxTreatment(category);
  const sgApplies = incomeType === "employment" && row.sgApplies !== false;
  return { ...rest, owner, from, to, category, incomeType, sgApplies, ...clampIndexation(row) };
}

export function clampExpenseRow(row, plan) {
  const { from, to } = clampFromTo(row, plan.client.currentAge, plan.endAge, plan);
  const { indexed, fromAge, toAge, from: _f, to: _t, ...rest } = row;
  const category = EXPENSE_CATEGORIES.includes(row.category) ? row.category : "other";
  return { ...rest, from, to, category, ...clampIndexation(row) };
}

// Deduction rows anchor to their owner's window, same as income rows —
// a deduction only makes sense for the person it belongs to.
export function clampDeductionRow(row, plan) {
  const owner = row.owner === "partner" && plan.partner ? "partner" : "client";
  const win = ownerWindow(plan, owner);
  const { from, to } = clampFromTo(row, win.from, win.to, plan);
  const { indexed, fromAge, toAge, from: _f, to: _t, ...rest } = row;
  const category = DEDUCTION_CATEGORIES.includes(row.category) ? row.category : "other";
  return { ...rest, owner, from, to, category, ...clampIndexation(row) };
}

// fundingOrder invariant: exactly the INCLUDED FINANCIAL assets, in
// order. Known included ids keep their relative order; missing
// included ids append in display order; excluded/unknown/lifestyle
// ids drop.
export function normaliseFundingOrder(order, assets) {
  const includedIds = assets.filter((a) => a.include && isFinancial(a)).map((a) => a.id);
  const includedSet = new Set(includedIds);
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (includedSet.has(id) && !seen.has(id)) { out.push(id); seen.add(id); }
  }
  for (const id of includedIds) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

// Re-clamp everything after a plan change; also enforce settings
// invariants. Returns a new state object (does not mutate). `profiles`
// is needed to re-validate super accounts' allocation (Tier 1.2) —
// same reason hydrateAsset needs it for financial assets.
export function clampAllToPlan(state, profiles = {}) {
  const plan = clampPlan(state.plan, profiles);
  const assets = state.assets.map((a) => ({ ...a }));
  const income = state.cashflows.income.map((r) => clampIncomeRow(r, plan));
  const incomeRowIds = new Set(income.map((r) => r.id));
  const superAccountOwnerById = new Map(plan.superAccounts.map((s) => [s.id, s.owner]));
  const cashflows = {
    income,
    deductions: (state.cashflows.deductions ?? []).map((r) => clampDeductionRow(r, plan)),
    expenses: state.cashflows.expenses.map((r) => clampExpenseRow(r, plan)),
    contributions: state.cashflows.contributions.map((c) => clampCashflow(c, plan)),
    withdrawals: state.cashflows.withdrawals.map((w) => clampCashflow(w, plan)),
    lumpSums: state.cashflows.lumpSums.map((l) => clampLumpSum(l, plan)),
    superContributions: normaliseSuperContributions(
      state.cashflows.superContributions, plan, superAccountOwnerById, incomeRowIds
    ),
    superWithdrawals: normaliseSuperWithdrawals(state.cashflows.superWithdrawals, plan, superAccountOwnerById),
  };
  const settings = normaliseSettings(state.settings, assets);
  const liabilities = normaliseLiabilities(state.liabilities, plan, assets, state.properties);
  const properties = normaliseProperties(state.properties, plan);
  const goals = normaliseGoals(state.goals, plan, assets);
  // Flow of initial funds (Commit 2), second stage: targetAssetId needs
  // assets/goals, neither of which clampPlan can see (siblings of
  // plan, not children of it) — refined here, now that both exist.
  const planWithRefinedImplementation = {
    ...plan,
    implementation: refineImplementationAllocations(plan.implementation, assets, goals),
  };
  return { ...state, plan: planWithRefinedImplementation, assets, cashflows, settings, liabilities, properties, goals };
}

// Surplus treatment (Working Cash Account FY-end sweep): "accumulate"
// (leave it in the WCA — the default), "invest" (move it to a
// nominated asset), or "spend" (it leaves the model). Any unrecognised
// or missing value falls back to "accumulate", not "spend" — an
// invalid setting should never silently start spending the client's
// money out of the model.
export function normaliseSettings(settings, assets) {
  const fundingOrder = normaliseFundingOrder(settings?.fundingOrder, assets);
  let surplus = settings?.surplus || { mode: "accumulate", assetId: null };
  if (surplus.mode === "invest") {
    const valid = assets.some((a) => a.include && isFinancial(a) && a.id === surplus.assetId);
    surplus = valid ? { mode: "invest", assetId: surplus.assetId } : { mode: "accumulate", assetId: null };
  } else if (surplus.mode === "spend") {
    surplus = { mode: "spend", assetId: null };
  } else {
    surplus = { mode: "accumulate", assetId: null };
  }
  return { surplus, fundingOrder };
}

// --- household transitions ----------------------------------------------

// Everything currently owned by the partner (or jointly), for the
// couple → single prompt.
export function partnerOwnedItems(state) {
  const assets = state.assets.filter((a) => a.owner === "partner" || a.owner === "joint");
  const income = state.cashflows.income.filter((r) => r.owner === "partner");
  const deductions = (state.cashflows.deductions ?? []).filter((r) => r.owner === "partner");
  return { assets, income, deductions, count: assets.length + income.length + deductions.length };
}

// Reassign all partner/joint ownership to the client. Income row ages
// keep their numeric values (FY labels re-derive from the client
// window) and are re-clamped into it.
export function reassignPartnerToClient(state) {
  const assets = state.assets.map((a) =>
    (a.owner === "partner" || a.owner === "joint") ? { ...a, owner: "client" } : a
  );
  const income = state.cashflows.income.map((r) =>
    r.owner === "partner" ? { ...r, owner: "client" } : r
  );
  const deductions = (state.cashflows.deductions ?? []).map((r) =>
    r.owner === "partner" ? { ...r, owner: "client" } : r
  );
  const liabilities = (state.liabilities ?? []).map((l) =>
    l.owner === "partner" || l.owner === "joint" ? { ...l, owner: "client" } : l
  );
  return { ...state, assets, cashflows: { ...state.cashflows, income, deductions }, liabilities };
}

// Delete everything partner-owned (income rows; partner/joint assets
// cascade to their cashflows, funding order, and surplus target).
export function deletePartnerOwned(state) {
  const keepAssets = state.assets.filter((a) => a.owner !== "partner" && a.owner !== "joint");
  const removedIds = new Set(state.assets.filter((a) => !keepAssets.includes(a)).map((a) => a.id));
  const cf = state.cashflows;
  const cashflows = {
    income: cf.income.filter((r) => r.owner !== "partner"),
    deductions: (cf.deductions ?? []).filter((r) => r.owner !== "partner"),
    expenses: cf.expenses,
    contributions: cf.contributions.filter((c) => !removedIds.has(c.assetId)),
    withdrawals: cf.withdrawals.filter((w) => !removedIds.has(w.assetId)),
    lumpSums: cf.lumpSums.filter((l) => !removedIds.has(l.assetId)),
  };
  const settings = normaliseSettings(state.settings, keepAssets);
  const liabilities = (state.liabilities ?? [])
    .filter((l) => l.owner !== "partner" && l.owner !== "joint")
    .map((l) => ({
      ...l,
      linkedAssetId: removedIds.has(l.linkedAssetId) ? null : l.linkedAssetId,
      offsetAssetId: removedIds.has(l.offsetAssetId) ? null : l.offsetAssetId,
    }));
  return { ...state, assets: keepAssets, cashflows, settings, liabilities };
}

// Every contribution/withdrawal/one-off row currently targeting
// `assetId` — the "affected rows" a removal confirmation must list
// (Phase A.1's asset-deletion dialog, never actually built until this
// audit follow-up: the tool used to cascade-delete these rows with no
// way to keep them). Cashflow rows carry no label, so each entry
// summarises itself for display.
export function cashflowRowsForAsset(state, assetId) {
  const cf = state.cashflows;
  const describe = (kind, r) => ({
    kind, id: r.id,
    summary: `${kind} — $${Math.round(r.amount).toLocaleString()}` +
      (kind === "One-off amount" ? ` (${r.direction === "out" ? "outflow" : "inflow"})` : `/${r.frequency}`),
  });
  return [
    ...cf.contributions.filter((c) => c.assetId === assetId).map((c) => describe("Contribution", c)),
    ...cf.withdrawals.filter((w) => w.assetId === assetId).map((w) => describe("Withdrawal", w)),
    ...cf.lumpSums.filter((l) => l.assetId === assetId).map((l) => describe("One-off amount", l)),
  ];
}

// Remove one asset with full cascade. Never removes the last asset.
// `reassignToId`, when given (and a valid remaining financial asset),
// retargets the victim's contribution/withdrawal/one-off rows to it
// instead of deleting them — never orphaning an assetId. Omitting it
// (or passing an invalid id) keeps the original cascade-delete
// behaviour exactly, so every existing call site is unaffected.
export function removeAsset(state, assetId, reassignToId = null) {
  // The last FINANCIAL asset can never be removed; lifestyle assets
  // (D2) are always removable.
  const victim = state.assets.find((a) => a.id === assetId);
  if (!victim) return state;
  if (isFinancial(victim) && state.assets.filter(isFinancial).length <= 1) return state;
  const assets = state.assets.filter((a) => a.id !== assetId);
  const reassign = assets.some((a) => a.id === reassignToId && a.class !== "lifestyle") ? reassignToId : null;
  const retarget = (r) => (r.assetId === assetId ? { ...r, assetId: reassign } : r);
  const cf = state.cashflows;
  const cashflows = reassign ? {
    ...cf,
    contributions: cf.contributions.map(retarget),
    withdrawals: cf.withdrawals.map(retarget),
    lumpSums: cf.lumpSums.map(retarget),
  } : {
    ...cf,
    contributions: cf.contributions.filter((c) => c.assetId !== assetId),
    withdrawals: cf.withdrawals.filter((w) => w.assetId !== assetId),
    lumpSums: cf.lumpSums.filter((l) => l.assetId !== assetId),
  };
  const settings = normaliseSettings(state.settings, assets);
  const liabilities = (state.liabilities ?? []).map((l) => ({
    ...l,
    linkedAssetId: l.linkedAssetId === assetId ? null : l.linkedAssetId,
    offsetAssetId: l.offsetAssetId === assetId ? null : l.offsetAssetId,
  }));
  return { ...state, assets, cashflows, settings, liabilities };
}

// --- persistence + migration ------------------------------------------------

export function serialize(state) {
  return JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION });
}

// v1 (Phase A): assets own their cashflow arrays; plan.currentAge and
// plan.startYear at top level. → v2 hoists cashflows into a central
// collection with assetId and moves start to { year, month }.
function migrateV1toV2(raw) {
  const cashflows = { contributions: [], withdrawals: [], lumpSums: [] };
  const assets = (raw.assets || []).map((a) => {
    for (const c of a.contributions || []) cashflows.contributions.push({ ...c, assetId: a.id });
    for (const w of a.withdrawals || []) cashflows.withdrawals.push({ ...w, assetId: a.id });
    for (const l of a.lumpSums || []) cashflows.lumpSums.push({ ...l, assetId: a.id });
    const { contributions, withdrawals, lumpSums, ...rest } = a;
    return rest;
  });
  return {
    ...raw,
    schemaVersion: 2,
    plan: {
      currentAge: raw.plan?.currentAge,
      endAge: raw.plan?.endAge,
      // v1 stored a bare startYear; month defaults to July (FY start)
      // so the age-tick convention lines up with a fresh FY.
      start: { year: raw.plan?.startYear, month: 7 },
    },
    assets,
    cashflows,
  };
}

// v2 (Phase A.1): central cashflows, flat plan.currentAge. → v3 wraps
// the client, stamps household/ownership/distribution defaults, builds
// fundingOrder from display order, adds empty income/expenses.
function migrateV2toV3(raw) {
  const assets = (raw.assets || []).map((a) => ({
    owner: "client",
    distributions: "reinvest",
    ...a,
  }));
  return {
    ...raw,
    schemaVersion: 3,
    plan: {
      household: "single",
      client: { currentAge: raw.plan?.currentAge },
      partner: null,
      endAge: raw.plan?.endAge,
      start: raw.plan?.start,
    },
    assets,
    cashflows: {
      income: [],
      expenses: [],
      contributions: raw.cashflows?.contributions || [],
      withdrawals: raw.cashflows?.withdrawals || [],
      lumpSums: raw.cashflows?.lumpSums || [],
    },
    settings: {
      surplus: { mode: "spend", assetId: null },
      fundingOrder: assets.map((a) => a.id),
    },
  };
}

// v3 (Phase A.2) → v4 (C3): per-person tax profiles. clampPlan stamps
// the defaults (resident / Medicare applies / not Centrelink
// eligible), so the migration only advances the version gate.
function migrateV3toV4(raw) {
  return { ...raw, schemaVersion: 4 };
}

// v4 → v5 (D1): identity + LE end basis + indexation model. The
// clamps do the shape work: clampPerson synthesises a DOB from
// currentAge (age-tick-identical), clampPlan maps household "couple"
// → "married" and fixes the end basis at the stored endAge,
// clampIndexation maps indexed true/false → CPI+0 / None+0, and
// clampTaxProfile defaults openingCapitalLosses to 0. All migrated
// projections are behaviour-identical (regression-gated).
function migrateV4toV5(raw) {
  return { ...raw, schemaVersion: 5 };
}

// v5 → v6 (Tier 1.1): Key Dates. Every date field becomes a DateRef
// (bare fromAge/toAge/age/purchaseAge → {kind:"age", age: <the
// integer>}); retirementAge defaults to 65 per person; keyDates
// defaults to []. As with D1, the clamps do the shape work (clampPlan
// stamps retirementAge/keyDates, clampFromTo/clampDateRef read the old
// field names as a fallback) — this migration only advances the
// version gate. Because clampDateRef's {kind:"age"} branch clamps the
// integer into EXACTLY the same [lo, hi] window the old bare-int
// fields did, every migrated row resolves to the same plan year it
// did pre-migration: the regression gate.
function migrateV5toV6(raw) {
  return { ...raw, schemaVersion: 6 };
}

// v6 → v7 (Tier 1.2): superannuation. New shape entirely (superAccounts,
// per-person super state, superContributions, income-row incomeType/
// sgApplies) — nothing existing changes shape, so again just the
// version gate; normaliseSuperAccounts/clampPerson/clampIncomeRow stamp
// the new defaults ([] accounts, empty carry-forward ledger, incomeType
// "employment"). No pre-existing scenario had super, so this migration
// can never change a single projected figure — the regression gate.
function migrateV6toV7(raw) {
  return { ...raw, schemaVersion: 7 };
}

// v7 → v8 (Tier 1.2, Commit 3): preservation, withdrawals, proportioning.
// New shape only (cashflows.superWithdrawals) — no existing field
// changes shape, so again just the version gate.
function migrateV7toV8(raw) {
  return { ...raw, schemaVersion: 8 };
}

// v8 → v9 (Working Cash Account): plan.workingCash is new (clampPlan
// stamps the default {balance:0, minimumBalance:0, ratePct:null}); no
// existing field changes shape, so again just the version gate. The
// default surplus mode changes from "spend" to "accumulate" for BRAND
// NEW scenarios only (defaultState) — an existing scenario's already-
// stored settings.surplus.mode is a valid value either way and is left
// exactly as normaliseSettings finds it, so this migration never
// changes an existing scenario's chosen surplus treatment.
function migrateV8toV9(raw) {
  return { ...raw, schemaVersion: 9 };
}

// v9 → v10 (PAYG withholding, tax refund timing, and deductions):
// cashflows.deductions is new (hydrateDeductionRows stamps [] for a
// pre-v10 blob with no such array); properties gain a depreciation
// field (normaliseProperties stamps 0). No existing field changes
// shape, so again just the version gate — no pre-existing scenario had
// either, so this migration can never change a single projected figure.
function migrateV9toV10(raw) {
  return { ...raw, schemaVersion: 10 };
}

// v10 → v11 (Cashflow table: firm row vocabulary and category
// grouping): income/expense rows gain a category field — clampIncomeRow
// derives it from the pre-existing incomeType on read (including the
// legacy "rental" value), clampExpenseRow defaults a missing one to
// "other". No existing field changes shape or is removed, so again
// just the version gate.
function migrateV10toV11(raw) {
  return { ...raw, schemaVersion: 11 };
}

// v11 → v12 (Implementation/Rates spec, Commit 1 + 2): liabilities gain
// rateType/fixedRatePct/fixedUntil/revertRatePct/commencedOn (default
// "variable", bit-identical); plan gains adviserFees/implementation
// (both clamp-defaulted to their zero/no-op shape by
// clampAdviserFees/clampImplementationBasic when absent). No existing
// field changes shape or is removed, so again just the version gate.
function migrateV11toV12(raw) {
  return { ...raw, schemaVersion: 12 };
}

// v12 → v13 (Implementation/Rates spec, Commit 3): properties gain
// equityCeilingPct (default 80)/depositFromEquity/
// depositFromEquitySourcePropertyId (both default off/null). No
// existing field changes shape or is removed, so again just the
// version gate.
function migrateV12toV13(raw) {
  return { ...raw, schemaVersion: 13 };
}

// v13 → v14 (Input Usability spec, Commit 1): eligibleForCentrelinkBenefits
// (taxProfile.centrelinkEligible) is removed entirely — it drove nothing
// and is reintroduced properly when Centrelink modelling arrives.
// clampTaxProfile already stops reading/writing it, so a stored value
// is silently dropped on the next clamp; no other field changes shape,
// so again just the version gate.
function migrateV13toV14(raw) {
  return { ...raw, schemaVersion: 14 };
}

// v14 → v15 (Input Usability spec, Commit 2): state gains `meta.touched`,
// the list of field paths the user has attended to (entered or
// explicitly confirmed). An existing scenario has no such data — mark
// nothing, which is the honest reading ("nobody has reviewed this
// yet"), not an unsafe one; hydrate() defaults the field itself, so
// this is again just the version gate.
function migrateV14toV15(raw) {
  return { ...raw, schemaVersion: 15 };
}

// Parse + validate a stored blob, migrating older schema versions
// forward. Returns a clamped v9 state or null (caller falls back to
// defaults). Never throws.
export function hydrate(json, profiles = {}) {
  try {
    let raw = JSON.parse(json);
    if (!raw || typeof raw !== "object") return null;
    if (raw.schemaVersion === 1) raw = migrateV1toV2(raw);
    if (raw.schemaVersion === 2) raw = migrateV2toV3(raw);
    if (raw.schemaVersion === 3) raw = migrateV3toV4(raw);
    if (raw.schemaVersion === 4) raw = migrateV4toV5(raw);
    if (raw.schemaVersion === 5) raw = migrateV5toV6(raw);
    if (raw.schemaVersion === 6) raw = migrateV6toV7(raw);
    if (raw.schemaVersion === 7) raw = migrateV7toV8(raw);
    if (raw.schemaVersion === 8) raw = migrateV8toV9(raw);
    if (raw.schemaVersion === 9) raw = migrateV9toV10(raw);
    if (raw.schemaVersion === 10) raw = migrateV10toV11(raw);
    if (raw.schemaVersion === 11) raw = migrateV11toV12(raw);
    if (raw.schemaVersion === 12) raw = migrateV12toV13(raw);
    if (raw.schemaVersion === 13) raw = migrateV13toV14(raw);
    if (raw.schemaVersion === 14) raw = migrateV14toV15(raw);
    if (raw.schemaVersion !== SCHEMA_VERSION) return null;
    if (!raw.plan || !Array.isArray(raw.assets) || raw.assets.length === 0) return null;

    const plan = clampPlan(raw.plan, profiles);
    const assets = raw.assets.map((a, i) => hydrateAsset(a, i, profiles));
    // Cashflow rows may only target FINANCIAL assets (D2 validation);
    // rows pointing at lifestyle assets drop on hydrate.
    const assetIds = new Set(assets.filter(isFinancial).map((a) => a.id));
    const cf = raw.cashflows || {};
    const income = hydrateIncomeRows(cf.income, plan);
    const superAccountOwnerById = new Map(plan.superAccounts.map((s) => [s.id, s.owner]));
    const incomeRowIds = new Set(income.map((r) => r.id));

    const goalsForImplementation = normaliseGoals(raw.goals, plan, assets);
    const state = {
      schemaVersion: SCHEMA_VERSION,
      // Flow of initial funds (Commit 2), second stage — see
      // clampAllToPlan's own comment for why this can't happen inside
      // clampPlan itself.
      plan: { ...plan, implementation: refineImplementationAllocations(plan.implementation, assets, goalsForImplementation) },
      assets,
      cashflows: {
        income,
        expenses: hydrateExpenseRows(cf.expenses, plan),
        deductions: hydrateDeductionRows(cf.deductions, plan),
        contributions: hydrateCashflows(cf.contributions, plan, assetIds),
        withdrawals: hydrateCashflows(cf.withdrawals, plan, assetIds),
        lumpSums: hydrateLumpSums(cf.lumpSums, plan, assetIds),
        superContributions: hydrateSuperContributions(cf.superContributions, plan, superAccountOwnerById, incomeRowIds),
        superWithdrawals: hydrateSuperWithdrawals(cf.superWithdrawals, plan, superAccountOwnerById),
      },
      liabilities: normaliseLiabilities(raw.liabilities, plan, assets, raw.properties),
      properties: normaliseProperties(raw.properties, plan),
      goals: goalsForImplementation,
      settings: normaliseSettings(raw.settings, assets),
      display: {
        units: raw.display?.units === "nominal" ? "nominal" : "real",
        reportPeriod: clampReportPeriod(raw.display?.reportPeriod),
        lastVisited: clampLastVisited(raw.display?.lastVisited),
        chartTreatment: clampChartTreatment(raw.display?.chartTreatment),
        hideEmptyRows: raw.display?.hideEmptyRows !== false,
        showIndividualCashflowItems: raw.display?.showIndividualCashflowItems === true,
        snapshotYears: clampSnapshotYears(raw.display?.snapshotYears, plan),
      },
      assumptions: {
        cpi: clampNumber(raw.assumptions?.cpi, 0, 0.2) || 0.025,
        awote: clampNumber(raw.assumptions?.awote ?? 0.035, 0, 0.2),
        mortgageRate: clampNumber(raw.assumptions?.mortgageRate ?? 0.06, 0, 0.3),
        bracketMode: raw.assumptions?.bracketMode === "frozen" ? "frozen" : "indexed",
        // Document Set Commit 3 (FHSSS) — the deemed rate associated
        // earnings accrue at. Defaults to an indicative ATO shortfall
        // interest rate (SIC); confirm the current quarterly rate
        // before relying on this in client work (see build-log.md's
        // Open Items).
        fhsssEarningsRate: clampNumber(raw.assumptions?.fhsssEarningsRate ?? 0.0794, 0, 0.3),
      },
      // Existing saved scenarios have no touched data — mark nothing
      // rather than guessing; showing everything as unreviewed is the
      // honest state (Input Usability spec, Commit 2).
      meta: { touched: clampTouched(raw.meta?.touched) },
    };
    // Single households must not carry partner/joint owners.
    if (plan.household === "single") {
      return reassignPartnerToClient(state);
    }
    return state;
  } catch {
    return null;
  }
}

function hydrateAsset(a, i, profiles) {
  const balance = clampNumber(a.balance, 0);
  // Migration (D2): assets without a class are financial.
  if (a.class === "lifestyle") {
    return {
      id: typeof a.id === "string" && a.id ? a.id : uid("ls"),
      name: typeof a.name === "string" && a.name.trim() ? a.name : `Lifestyle asset ${i + 1}`,
      class: "lifestyle",
      include: a.include !== false,
      owner: ["client", "partner", "joint"].includes(a.owner) ? a.owner : "client",
      balance,
      growthPct: clampNumber(a.growthPct, -10, 30),
    };
  }
  const cgtAsset = a.cgtAsset !== false;
  return {
    id: typeof a.id === "string" && a.id ? a.id : uid("as"),
    name: typeof a.name === "string" && a.name.trim() ? a.name : `Asset ${i + 1}`,
    class: "financial",
    include: a.include !== false,
    owner: ["client", "partner", "joint"].includes(a.owner) ? a.owner : "client",
    distributions: a.distributions === "cash" ? "cash" : "reinvest",
    balance,
    allocation: clampAllocation(a.allocation, profiles),
    icrPct: clampNumber(a.icrPct, 0, 100),
    cgtAsset,
    costBase: cgtAsset
      ? clampNumber(a.costBase ?? balance, 0)
      : (a.costBase == null ? null : clampNumber(a.costBase, 0)),
  };
}

function hydrateCashflows(arr, plan, assetIds) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((c) => assetIds.has(c.assetId))
    .map((c) => clampCashflow({
      id: typeof c.id === "string" && c.id ? c.id : uid("cf"),
      assetId: c.assetId,
      amount: clampNumber(c.amount, 0),
      frequency: c.frequency === "annual" ? "annual" : "monthly",
      from: c.from, fromAge: c.fromAge, // new field wins; fromAge is the pre-Key-Dates fallback
      to: c.to, toAge: c.toAge,
      indexBasis: c.indexBasis,
      indexExtraPct: c.indexExtraPct,
      indexed: c.indexed,
    }, plan));
}

function hydrateLumpSums(arr, plan, assetIds) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((l) => assetIds.has(l.assetId))
    .map((l) => clampLumpSum({
      id: typeof l.id === "string" && l.id ? l.id : uid("ls"),
      assetId: l.assetId,
      amount: clampNumber(l.amount, 0),
      direction: l.direction === "out" ? "out" : "in",
      at: l.at, age: l.age,
      source: l.source === "table" ? "table" : "input",
    }, plan));
}

function hydrateSuperContributions(arr, plan, superAccountOwnerById, incomeRowIds) {
  if (!Array.isArray(arr)) return [];
  return arr.map((sc) => clampSuperContribution({
    id: typeof sc.id === "string" && sc.id ? sc.id : uid("sc"),
    label: sc.label,
    owner: sc.owner,
    accountId: sc.accountId,
    type: sc.type,
    basis: sc.basis,
    amount: clampNumber(sc.amount, 0),
    percent: clampNumber(sc.percent, 0, 100),
    incomeRowId: sc.incomeRowId,
    frequency: sc.frequency,
    from: sc.from,
    to: sc.to,
    indexBasis: sc.indexBasis,
    indexExtraPct: sc.indexExtraPct,
  }, plan, superAccountOwnerById, incomeRowIds));
}

function hydrateSuperWithdrawals(arr, plan, superAccountOwnerById) {
  if (!Array.isArray(arr)) return [];
  return arr.map((sw) => clampSuperWithdrawal({
    id: typeof sw.id === "string" && sw.id ? sw.id : uid("sw"),
    label: sw.label,
    owner: sw.owner,
    accountId: sw.accountId,
    amount: clampNumber(sw.amount, 0),
    frequency: sw.frequency,
    from: sw.from,
    to: sw.to,
    indexBasis: sw.indexBasis,
    indexExtraPct: sw.indexExtraPct,
  }, plan, superAccountOwnerById));
}

function hydrateIncomeRows(arr, plan) {
  if (!Array.isArray(arr)) return [];
  return arr.map((r, i) => clampIncomeRow({
    id: typeof r.id === "string" && r.id ? r.id : uid("in"),
    label: typeof r.label === "string" && r.label.trim() ? r.label : `Income ${i + 1}`,
    owner: r.owner === "partner" ? "partner" : "client",
    amount: clampNumber(r.amount, 0),
    frequency: r.frequency === "monthly" ? "monthly" : "annual",
    from: r.from, fromAge: r.fromAge,
    to: r.to, toAge: r.toAge,
    indexBasis: r.indexBasis,
    indexExtraPct: r.indexExtraPct,
    indexed: r.indexed,
    incomeType: r.incomeType,
    sgApplies: r.sgApplies,
    category: r.category,
  }, plan));
}

function hydrateExpenseRows(arr, plan) {
  if (!Array.isArray(arr)) return [];
  return arr.map((r, i) => clampExpenseRow({
    id: typeof r.id === "string" && r.id ? r.id : uid("ex"),
    label: typeof r.label === "string" && r.label.trim() ? r.label : `Expense ${i + 1}`,
    amount: clampNumber(r.amount, 0),
    frequency: r.frequency === "monthly" ? "monthly" : "annual",
    from: r.from, fromAge: r.fromAge,
    to: r.to, toAge: r.toAge,
    indexBasis: r.indexBasis,
    indexExtraPct: r.indexExtraPct,
    indexed: r.indexed,
    category: r.category,
  }, plan));
}

function hydrateDeductionRows(arr, plan) {
  if (!Array.isArray(arr)) return [];
  return arr.map((r, i) => clampDeductionRow({
    id: typeof r.id === "string" && r.id ? r.id : uid("ded"),
    label: typeof r.label === "string" && r.label.trim() ? r.label : `Deduction ${i + 1}`,
    owner: r.owner === "partner" ? "partner" : "client",
    category: r.category,
    amount: clampNumber(r.amount, 0),
    frequency: r.frequency === "monthly" ? "monthly" : "annual",
    from: r.from, fromAge: r.fromAge,
    to: r.to, toAge: r.toAge,
    indexBasis: r.indexBasis,
    indexExtraPct: r.indexExtraPct,
    indexed: r.indexed,
  }, plan));
}

// --- derived summaries ---------------------------------------------------

export function annualisedAmount(cf) {
  return cf.frequency === "monthly" ? cf.amount * 12 : cf.amount;
}

export function allocationTotalNominal(alloc, profiles) {
  if (alloc.mode === "custom") return (alloc.incomePct + alloc.growthPct) / 100;
  const p = profiles[alloc.profile];
  return p ? p.totalNominal : 0;
}

export function allocationSummary(alloc, profiles) {
  if (alloc.mode === "custom") {
    const total = (alloc.incomePct + alloc.growthPct).toFixed(1).replace(/\.0$/, "");
    return `Custom · ${total}% p.a.`;
  }
  return alloc.profile || "";
}

// Summary strip figures. Asset-linked cashflows count only when their
// asset is included; income/expenses are plan-level so all rows count.
export function summarise(state) {
  const included = new Set(state.assets.filter((a) => a.include).map((a) => a.id));
  let totalBalance = 0;
  for (const a of state.assets) if (a.include) totalBalance += a.balance;

  const sumRows = (rows, filterByAsset) => {
    let t = 0;
    for (const r of rows) {
      if (filterByAsset && !included.has(r.assetId)) continue;
      t += annualisedAmount(r);
    }
    return t;
  };

  return {
    totalBalance,
    includedCount: included.size,
    annualContributions: sumRows(state.cashflows.contributions, true),
    annualWithdrawals: sumRows(state.cashflows.withdrawals, true),
    annualIncome: sumRows(state.cashflows.income, false),
    annualExpenses: sumRows(state.cashflows.expenses, false),
  };
}

// "50-year projection, 2026–2076 (age 40–90)" — client-anchored.
export function planSummaryText(plan) {
  const years = horizonYears(plan);
  const endYear = plan.start.year + years;
  return `${years}-year projection, ${plan.start.year}–${endYear} (age ${plan.client.currentAge}–${plan.endAge})`;
}
