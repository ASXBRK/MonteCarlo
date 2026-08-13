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

export const SCHEMA_VERSION = 8;

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
// capital losses). centrelinkEligible is captured but inert until
// Centrelink modelling arrives.
export function defaultTaxProfile() {
  return { residency: "resident", medicareExempt: false, centrelinkEligible: false, openingCapitalLosses: 0 };
}

export function clampTaxProfile(raw) {
  return {
    residency: raw?.residency === "nonResident" ? "nonResident" : "resident",
    medicareExempt: raw?.medicareExempt === true,
    centrelinkEligible: raw?.centrelinkEligible === true,
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

export function createIncomeRow(plan, existing = []) {
  return {
    id: uid("in"),
    label: `Income ${existing.length + 1}`,
    owner: "client",
    amount: 0,
    frequency: "annual",
    from: anchorRef("start"),
    to: anchorRef("retirement-client"), // new rows always default owner "client"
    indexBasis: "cpi",
    indexExtraPct: 0,
    incomeType: "employment",
    sgApplies: true, // Super Guarantee (Tier 1.2) — default on for employment income
  };
}

export function createExpenseRow(plan, existing = []) {
  return {
    id: uid("ex"),
    label: `Expense ${existing.length + 1}`,
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
  };
}

export function clampProperty(p, plan) {
  const flow = (f) => ({ amount: clampNumber(f?.amount, 0), ...clampIndexation(f ?? {}) });
  return {
    id: typeof p.id === "string" && p.id ? p.id : uid("pr"),
    name: typeof p.name === "string" && p.name.trim() ? p.name : "Property",
    owner: ["client", "partner", "joint"].includes(p.owner) && (p.owner === "client" || plan.partner)
      ? p.owner : "client",
    state: PROPERTY_STATES.includes(p.state) ? p.state : "NSW",
    propertyType: PROPERTY_TYPES.includes(p.propertyType) ? p.propertyType : "ppr",
    status: p.status === "planned" ? "planned" : "owned",
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
    growthPct: clampNumber(p.growthPct ?? 5, -10, 30),
    rent: flow(p.rent),
    expenses: flow(p.expenses),
    expensesDeductible: p.expensesDeductible !== false,
  };
}

export function normaliseProperties(properties, plan) {
  if (!Array.isArray(properties)) return [];
  return properties.map((p) => clampProperty(p, plan));
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
    interestRatePct: 6.0, // nominal p.a.
    termYears: 25,
    repayment: "pi",      // "pi" | "io" (ioYears of IO, then P&I)
    ioYears: 5,
    deductible: false,    // interest deducts against the owner's income
    linkedAssetId: null,  // informational; used by D4 purchases
    offsetAssetId: null,  // financial asset whose balance offsets interest
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
  return {
    id: typeof l.id === "string" && l.id ? l.id : uid("lb"),
    name: typeof l.name === "string" && l.name.trim() ? l.name : "Loan",
    type,
    owner: ["client", "partner", "joint"].includes(l.owner) && (l.owner === "client" || plan.partner)
      ? l.owner : "client",
    balance: clampNumber(l.balance, 0),
    interestRatePct: clampNumber(l.interestRatePct ?? 6, 0, 30),
    termYears: clampInt(l.termYears ?? 25, 1, 50),
    repayment: l.repayment === "io" ? "io" : "pi",
    ioYears: clampInt(l.ioYears ?? 5, 1, 30),
    deductible: l.deductible === true,
    linkedAssetId: allIds.has(l.linkedAssetId) ? l.linkedAssetId : null,
    offsetAssetId: financialIds.has(l.offsetAssetId) ? l.offsetAssetId : null,
  };
}

export function normaliseLiabilities(liabilities, plan, assets, properties = []) {
  if (!Array.isArray(liabilities)) return [];
  return liabilities.map((l) => clampLiability(l, plan, assets, properties));
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

export function clampSuperContribution(sc, plan, superAccountIds, incomeRowIds) {
  const owner = sc.owner === "partner" && plan.partner ? "partner" : "client";
  const type = SUPER_CONTRIBUTION_TYPES.includes(sc.type) ? sc.type : "salarySacrifice";
  const basis = SUPER_CONTRIBUTION_BASES.includes(sc.basis) ? sc.basis : "amount";
  const { from, to } = clampFromTo(sc, plan.client.currentAge, plan.endAge, plan);
  return {
    id: typeof sc.id === "string" && sc.id ? sc.id : uid("sc"),
    label: typeof sc.label === "string" && sc.label.trim() ? sc.label : "Contribution",
    owner,
    accountId: superAccountIds.has(sc.accountId) ? sc.accountId : null,
    type,
    basis,
    amount: clampNumber(sc.amount, 0),
    percent: clampNumber(sc.percent, 0, 100),
    incomeRowId: incomeRowIds.has(sc.incomeRowId) ? sc.incomeRowId : null,
    frequency: sc.frequency === "annual" ? "annual" : "monthly",
    from, to,
    ...clampIndexation(sc),
  };
}

export function normaliseSuperContributions(rows, plan, superAccountIds, incomeRowIds) {
  if (!Array.isArray(rows)) return [];
  return rows.map((sc) => clampSuperContribution(sc, plan, superAccountIds, incomeRowIds));
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

export function clampSuperWithdrawal(sw, plan, superAccountIds) {
  const owner = sw.owner === "partner" && plan.partner ? "partner" : "client";
  const { from, to } = clampFromTo(sw, plan.client.currentAge, plan.endAge, plan);
  return {
    id: typeof sw.id === "string" && sw.id ? sw.id : uid("sw"),
    label: typeof sw.label === "string" && sw.label.trim() ? sw.label : "Withdrawal",
    owner,
    accountId: superAccountIds.has(sw.accountId) ? sw.accountId : null,
    amount: clampNumber(sw.amount, 0),
    frequency: sw.frequency === "annual" ? "annual" : "monthly",
    from, to,
    ...clampIndexation(sw),
  };
}

export function normaliseSuperWithdrawals(rows, plan, superAccountIds) {
  if (!Array.isArray(rows)) return [];
  return rows.map((sw) => clampSuperWithdrawal(sw, plan, superAccountIds));
}

function nextAssetNumber(existing) {
  let max = 0;
  for (const a of existing) {
    const m = /^Asset (\d+)$/.exec(a.name || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Math.max(max, existing.length) + 1;
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
      contributions: [createCashflow("contribution", plan, asset.id)],
      withdrawals: [],
      lumpSums: [],
      superContributions: [],
      superWithdrawals: [],
    },
    liabilities: [],
    properties: [],
    settings: {
      surplus: { mode: "spend", assetId: null },
      fundingOrder: [asset.id],
    },
    display: {
      units: "real",
      reportPeriod: defaultReportPeriod(plan),
      lastVisited: { area: "input", section: DEFAULT_INPUT_SECTION },
      chartTreatment: defaultChartTreatment(),
      hideEmptyRows: true,
    },
    assumptions: { cpi: 0.025, awote: 0.035, mortgageRate: 0.06, bracketMode: "indexed" },
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
    expenses: cf.expenses.length,
    "financial-assets": state.assets.filter(isFinancial).length,
    "lifestyle-assets": state.assets.filter(isLifestyle).length,
    property: (state.properties ?? []).length,
    super: (state.plan.superAccounts ?? []).length,
    liabilities: (state.liabilities ?? []).length,
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

  const client = clampPerson(plan.client, start);
  const partner = isCoupleHousehold(household)
    ? clampPerson(plan.partner ?? { currentAge: client.currentAge }, start)
    : null;

  // Missing basis (pre-D1 blob or partial edit): fix at the stored
  // endAge so migrated projections are behaviour-identical.
  const endBasis = clampEndBasis(
    plan.endBasis ?? { mode: "fixedAge", fixedAge: clampInt(plan.endAge, 19, 120) }
  );
  const { endAge } = resolveEndBasis(endBasis, client, partner);
  // keyDates are validated against the PRE-clamp partner presence too
  // (normaliseKeyDates itself falls a partner-basis date back to
  // client when there's no partner), so this order is safe either way.
  const keyDates = normaliseKeyDates(plan.keyDates, { client, partner });
  // Super accounts (Tier 1.2) live on the plan, alongside client/
  // partner — they are always person-owned, never joint, so they
  // belong with identity rather than with the joint-ownable financial
  // asset list.
  const superAccounts = normaliseSuperAccounts(plan.superAccounts, { client, partner }, profiles);

  return { household, client, partner, endAge, endBasis, start, keyDates, superAccounts };
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

// Income rows anchor to their owner's window. incomeType (Tier 1.2)
// gates sgApplies: SG only ever makes sense for employment income, so
// a non-employment row's toggle is force-cleared regardless of what
// was stored (defensive — the UI hides the toggle for those rows too).
export function clampIncomeRow(row, plan) {
  const owner = row.owner === "partner" && plan.partner ? "partner" : "client";
  const win = ownerWindow(plan, owner);
  const { from, to } = clampFromTo(row, win.from, win.to, plan);
  const { indexed, fromAge, toAge, from: _f, to: _t, ...rest } = row;
  const incomeType = INCOME_TYPES.includes(row.incomeType) ? row.incomeType : "employment";
  const sgApplies = incomeType === "employment" && row.sgApplies !== false;
  return { ...rest, owner, from, to, incomeType, sgApplies, ...clampIndexation(row) };
}

export function clampExpenseRow(row, plan) {
  const { from, to } = clampFromTo(row, plan.client.currentAge, plan.endAge, plan);
  const { indexed, fromAge, toAge, from: _f, to: _t, ...rest } = row;
  return { ...rest, from, to, ...clampIndexation(row) };
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
  const superAccountIds = new Set(plan.superAccounts.map((s) => s.id));
  const cashflows = {
    income,
    expenses: state.cashflows.expenses.map((r) => clampExpenseRow(r, plan)),
    contributions: state.cashflows.contributions.map((c) => clampCashflow(c, plan)),
    withdrawals: state.cashflows.withdrawals.map((w) => clampCashflow(w, plan)),
    lumpSums: state.cashflows.lumpSums.map((l) => clampLumpSum(l, plan)),
    superContributions: normaliseSuperContributions(
      state.cashflows.superContributions, plan, superAccountIds, incomeRowIds
    ),
    superWithdrawals: normaliseSuperWithdrawals(state.cashflows.superWithdrawals, plan, superAccountIds),
  };
  const settings = normaliseSettings(state.settings, assets);
  const liabilities = normaliseLiabilities(state.liabilities, plan, assets, state.properties);
  const properties = normaliseProperties(state.properties, plan);
  return { ...state, plan, assets, cashflows, settings, liabilities, properties };
}

export function normaliseSettings(settings, assets) {
  const fundingOrder = normaliseFundingOrder(settings?.fundingOrder, assets);
  let surplus = settings?.surplus || { mode: "spend", assetId: null };
  if (surplus.mode === "invest") {
    const valid = assets.some((a) => a.include && isFinancial(a) && a.id === surplus.assetId);
    surplus = valid ? { mode: "invest", assetId: surplus.assetId } : { mode: "spend", assetId: null };
  } else {
    surplus = { mode: "spend", assetId: null };
  }
  return { surplus, fundingOrder };
}

// --- household transitions ----------------------------------------------

// Everything currently owned by the partner (or jointly), for the
// couple → single prompt.
export function partnerOwnedItems(state) {
  const assets = state.assets.filter((a) => a.owner === "partner" || a.owner === "joint");
  const income = state.cashflows.income.filter((r) => r.owner === "partner");
  return { assets, income, count: assets.length + income.length };
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
  const liabilities = (state.liabilities ?? []).map((l) =>
    l.owner === "partner" || l.owner === "joint" ? { ...l, owner: "client" } : l
  );
  return { ...state, assets, cashflows: { ...state.cashflows, income }, liabilities };
}

// Delete everything partner-owned (income rows; partner/joint assets
// cascade to their cashflows, funding order, and surplus target).
export function deletePartnerOwned(state) {
  const keepAssets = state.assets.filter((a) => a.owner !== "partner" && a.owner !== "joint");
  const removedIds = new Set(state.assets.filter((a) => !keepAssets.includes(a)).map((a) => a.id));
  const cf = state.cashflows;
  const cashflows = {
    income: cf.income.filter((r) => r.owner !== "partner"),
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

// Remove one asset with full cascade. Never removes the last asset.
export function removeAsset(state, assetId) {
  // The last FINANCIAL asset can never be removed; lifestyle assets
  // (D2) are always removable.
  const victim = state.assets.find((a) => a.id === assetId);
  if (!victim) return state;
  if (isFinancial(victim) && state.assets.filter(isFinancial).length <= 1) return state;
  const assets = state.assets.filter((a) => a.id !== assetId);
  const cf = state.cashflows;
  const cashflows = {
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

// Parse + validate a stored blob, migrating older schema versions
// forward. Returns a clamped v8 state or null (caller falls back to
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
    if (raw.schemaVersion !== SCHEMA_VERSION) return null;
    if (!raw.plan || !Array.isArray(raw.assets) || raw.assets.length === 0) return null;

    const plan = clampPlan(raw.plan, profiles);
    const assets = raw.assets.map((a, i) => hydrateAsset(a, i, profiles));
    // Cashflow rows may only target FINANCIAL assets (D2 validation);
    // rows pointing at lifestyle assets drop on hydrate.
    const assetIds = new Set(assets.filter(isFinancial).map((a) => a.id));
    const cf = raw.cashflows || {};
    const income = hydrateIncomeRows(cf.income, plan);
    const superAccountIds = new Set(plan.superAccounts.map((s) => s.id));
    const incomeRowIds = new Set(income.map((r) => r.id));

    const state = {
      schemaVersion: SCHEMA_VERSION,
      plan,
      assets,
      cashflows: {
        income,
        expenses: hydrateExpenseRows(cf.expenses, plan),
        contributions: hydrateCashflows(cf.contributions, plan, assetIds),
        withdrawals: hydrateCashflows(cf.withdrawals, plan, assetIds),
        lumpSums: hydrateLumpSums(cf.lumpSums, plan, assetIds),
        superContributions: hydrateSuperContributions(cf.superContributions, plan, superAccountIds, incomeRowIds),
        superWithdrawals: hydrateSuperWithdrawals(cf.superWithdrawals, plan, superAccountIds),
      },
      liabilities: normaliseLiabilities(raw.liabilities, plan, assets, raw.properties),
      properties: normaliseProperties(raw.properties, plan),
      settings: normaliseSettings(raw.settings, assets),
      display: {
        units: raw.display?.units === "nominal" ? "nominal" : "real",
        reportPeriod: clampReportPeriod(raw.display?.reportPeriod),
        lastVisited: clampLastVisited(raw.display?.lastVisited),
        chartTreatment: clampChartTreatment(raw.display?.chartTreatment),
        hideEmptyRows: raw.display?.hideEmptyRows !== false,
      },
      assumptions: {
        cpi: clampNumber(raw.assumptions?.cpi, 0, 0.2) || 0.025,
        awote: clampNumber(raw.assumptions?.awote ?? 0.035, 0, 0.2),
        mortgageRate: clampNumber(raw.assumptions?.mortgageRate ?? 0.06, 0, 0.3),
        bracketMode: raw.assumptions?.bracketMode === "frozen" ? "frozen" : "indexed",
      },
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

function hydrateSuperContributions(arr, plan, superAccountIds, incomeRowIds) {
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
  }, plan, superAccountIds, incomeRowIds));
}

function hydrateSuperWithdrawals(arr, plan, superAccountIds) {
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
  }, plan, superAccountIds));
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
