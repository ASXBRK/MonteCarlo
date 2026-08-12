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

export const SCHEMA_VERSION = 5;

import { remainingLE } from "./data/lifeTables.js";

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
    taxProfile: clampTaxProfile(raw?.taxProfile),
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
  };
}

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

export function createCashflow(kind, plan, assetId = null) {
  return {
    id: uid("cf"),
    assetId,
    amount: 0,
    frequency: "monthly",
    fromAge: plan.client.currentAge,
    toAge: plan.endAge,
    indexBasis: "cpi",
    indexExtraPct: 0,
  };
}

export function createLumpSum(plan, assetId = null, source = "input") {
  return {
    id: uid("ls"),
    assetId,
    amount: 0,
    direction: "in",
    age: plan.client.currentAge,
    source: source === "table" ? "table" : "input",
  };
}

export function createIncomeRow(plan, existing = []) {
  return {
    id: uid("in"),
    label: `Income ${existing.length + 1}`,
    owner: "client",
    amount: 0,
    frequency: "annual",
    fromAge: plan.client.currentAge,
    toAge: plan.endAge,
    indexBasis: "cpi",
    indexExtraPct: 0,
  };
}

export function createExpenseRow(plan, existing = []) {
  return {
    id: uid("ex"),
    label: `Expense ${existing.length + 1}`,
    amount: 0,
    frequency: "annual",
    fromAge: plan.client.currentAge,
    toAge: plan.endAge,
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

export function clampLiability(l, plan, assets) {
  const financialIds = new Set(assets.filter((a) => isFinancial(a)).map((a) => a.id));
  const allIds = new Set(assets.map((a) => a.id));
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

export function normaliseLiabilities(liabilities, plan, assets) {
  if (!Array.isArray(liabilities)) return [];
  return liabilities.map((l) => clampLiability(l, plan, assets));
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
    },
    liabilities: [],
    settings: {
      surplus: { mode: "spend", assetId: null },
      fundingOrder: [asset.id],
    },
    display: { units: "real", reportPeriod: { from: null, to: null } },
    assumptions: { cpi: 0.025, awote: 0.035, bracketMode: "indexed" },
  };
}

// --- one-off grid helpers (C2) -------------------------------------------
//
// The Cashflow view's editable one-off cells manage exactly one
// table-sourced lump sum per asset+FY; input-panel-sourced rows for
// the same cell live alongside untouched.

export function tableLumpSumFor(lumpSums, assetId, age) {
  return lumpSums.find(
    (l) => l.source === "table" && l.assetId === assetId && l.age === age
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
    age,
    source: "table",
  }];
}

// Convention 5: one-offs fire in July; a partial first year starting
// after July has no firing July, so its grid cell is not editable.
export function canEditOneOffYear(plan, planYear) {
  return planYear > 0 || plan.start.month === 7;
}

// Report period: FY start years (or null = unbounded). Display state,
// not plan state — it only narrows what the output views show.
export function clampReportPeriod(raw) {
  const fy = (v) => (Number.isInteger(v) && v >= 1900 && v <= 3000 ? v : null);
  const from = fy(raw?.from);
  const to = fy(raw?.to);
  if (from != null && to != null && to < from) return { from, to: from };
  return { from, to };
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

export function clampPlan(plan) {
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

  return { household, client, partner, endAge, endBasis, start };
}

// Clamp a cashflow with client-anchored ages into the plan window.
export function clampCashflow(cf, plan) {
  const fromAge = clampInt(cf.fromAge, plan.client.currentAge, plan.endAge);
  const toAge = clampInt(cf.toAge, fromAge, plan.endAge);
  const { indexed, ...rest } = cf;
  return { ...rest, fromAge, toAge, ...clampIndexation(cf) };
}

export function clampLumpSum(ls, plan) {
  return { ...ls, age: clampInt(ls.age, plan.client.currentAge, plan.endAge) };
}

// Income rows anchor to their owner's window.
export function clampIncomeRow(row, plan) {
  const owner = row.owner === "partner" && plan.partner ? "partner" : "client";
  const win = ownerWindow(plan, owner);
  const fromAge = clampInt(row.fromAge, win.from, win.to);
  const toAge = clampInt(row.toAge, fromAge, win.to);
  const { indexed, ...rest } = row;
  return { ...rest, owner, fromAge, toAge, ...clampIndexation(row) };
}

export function clampExpenseRow(row, plan) {
  const fromAge = clampInt(row.fromAge, plan.client.currentAge, plan.endAge);
  const toAge = clampInt(row.toAge, fromAge, plan.endAge);
  const { indexed, ...rest } = row;
  return { ...rest, fromAge, toAge, ...clampIndexation(row) };
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
// invariants. Returns a new state object (does not mutate).
export function clampAllToPlan(state) {
  const plan = clampPlan(state.plan);
  const assets = state.assets.map((a) => ({ ...a }));
  const cashflows = {
    income: state.cashflows.income.map((r) => clampIncomeRow(r, plan)),
    expenses: state.cashflows.expenses.map((r) => clampExpenseRow(r, plan)),
    contributions: state.cashflows.contributions.map((c) => clampCashflow(c, plan)),
    withdrawals: state.cashflows.withdrawals.map((w) => clampCashflow(w, plan)),
    lumpSums: state.cashflows.lumpSums.map((l) => clampLumpSum(l, plan)),
  };
  const settings = normaliseSettings(state.settings, assets);
  const liabilities = normaliseLiabilities(state.liabilities, plan, assets);
  return { ...state, plan, assets, cashflows, settings, liabilities };
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

// Parse + validate a stored blob, migrating older schema versions
// forward. Returns a clamped v5 state or null (caller falls back to
// defaults). Never throws.
export function hydrate(json, profiles = {}) {
  try {
    let raw = JSON.parse(json);
    if (!raw || typeof raw !== "object") return null;
    if (raw.schemaVersion === 1) raw = migrateV1toV2(raw);
    if (raw.schemaVersion === 2) raw = migrateV2toV3(raw);
    if (raw.schemaVersion === 3) raw = migrateV3toV4(raw);
    if (raw.schemaVersion === 4) raw = migrateV4toV5(raw);
    if (raw.schemaVersion !== SCHEMA_VERSION) return null;
    if (!raw.plan || !Array.isArray(raw.assets) || raw.assets.length === 0) return null;

    const plan = clampPlan(raw.plan);
    const assets = raw.assets.map((a, i) => hydrateAsset(a, i, profiles));
    // Cashflow rows may only target FINANCIAL assets (D2 validation);
    // rows pointing at lifestyle assets drop on hydrate.
    const assetIds = new Set(assets.filter(isFinancial).map((a) => a.id));
    const cf = raw.cashflows || {};

    const state = {
      schemaVersion: SCHEMA_VERSION,
      plan,
      assets,
      cashflows: {
        income: hydrateIncomeRows(cf.income, plan),
        expenses: hydrateExpenseRows(cf.expenses, plan),
        contributions: hydrateCashflows(cf.contributions, plan, assetIds),
        withdrawals: hydrateCashflows(cf.withdrawals, plan, assetIds),
        lumpSums: hydrateLumpSums(cf.lumpSums, plan, assetIds),
      },
      liabilities: normaliseLiabilities(raw.liabilities, plan, assets),
      settings: normaliseSettings(raw.settings, assets),
      display: {
        units: raw.display?.units === "nominal" ? "nominal" : "real",
        reportPeriod: clampReportPeriod(raw.display?.reportPeriod),
      },
      assumptions: {
        cpi: clampNumber(raw.assumptions?.cpi, 0, 0.2) || 0.025,
        awote: clampNumber(raw.assumptions?.awote ?? 0.035, 0, 0.2),
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
      fromAge: c.fromAge,
      toAge: c.toAge,
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
      age: l.age,
      source: l.source === "table" ? "table" : "input",
    }, plan));
}

function hydrateIncomeRows(arr, plan) {
  if (!Array.isArray(arr)) return [];
  return arr.map((r, i) => clampIncomeRow({
    id: typeof r.id === "string" && r.id ? r.id : uid("in"),
    label: typeof r.label === "string" && r.label.trim() ? r.label : `Income ${i + 1}`,
    owner: r.owner === "partner" ? "partner" : "client",
    amount: clampNumber(r.amount, 0),
    frequency: r.frequency === "monthly" ? "monthly" : "annual",
    fromAge: r.fromAge,
    toAge: r.toAge,
    indexBasis: r.indexBasis,
    indexExtraPct: r.indexExtraPct,
    indexed: r.indexed,
  }, plan));
}

function hydrateExpenseRows(arr, plan) {
  if (!Array.isArray(arr)) return [];
  return arr.map((r, i) => clampExpenseRow({
    id: typeof r.id === "string" && r.id ? r.id : uid("ex"),
    label: typeof r.label === "string" && r.label.trim() ? r.label : `Expense ${i + 1}`,
    amount: clampNumber(r.amount, 0),
    frequency: r.frequency === "monthly" ? "monthly" : "annual",
    fromAge: r.fromAge,
    toAge: r.toAge,
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
