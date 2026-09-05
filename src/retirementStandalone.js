// Retirement Projection — Standalone Surface (docs/specs/33-retirement-
// standalone.md, Commit 1) — pure, no DOM/Plotly.
//
// Maps the standalone page's own eleven inputs onto EXISTING state
// fields — plan.client.*, plan.superAccounts[*], cashflows.income,
// cashflows.superContributions, state.assets[*], plan.retirement — and
// nothing else. This is the spec's own explicit constraint, restated in
// the chat that commissioned this commit: "NO NEW STATE SHAPE... A
// scenario created on this page is an ordinary scenario with a subset
// populated, and must open correctly in the comprehensive workspace."
// A parallel state shape would recreate, inside this tool, the exact
// "two models disagreeing" problem spec 32/33 exist to let a firm
// diagnose in ANOTHER tool — building one here would be absurd.
//
// Scope: single ("household: single") only — the spec's own field list
// is written in the singular ("Per person" as ONE block, no household-
// type selector among the nine-ish fields, and Commit 4's own fixture is
// "a single person"). A couple is out of scope for this page; the
// comprehensive workspace already covers that.
//
// Every setter takes a state and returns a NEW state (never mutates its
// argument) with exactly the touched path replaced — the caller is
// responsible for re-validating through clampAllToPlan(state, profiles)
// afterwards, the same "mutate, then clamp once" shape every other
// main.js commit function already uses. Where a target row/account
// doesn't exist yet (a brand-new scenario's own super account, financial
// asset, or income row), the setter creates ONE using the SAME factory
// the comprehensive workspace's own "+ Add..." buttons call
// (createSuperAccount/createAsset/createIncomeRow/createSuperContribution)
// — never a bespoke shape of its own.

import {
  createSuperAccount, createAsset, createIncomeRow, createSuperContribution, createIncomeRequired,
} from "./planState.js";

const RETIREMENT_CLIENT_ANCHOR = { kind: "anchor", anchorId: "retirement-client" };
const END_ANCHOR = { kind: "anchor", anchorId: "end" };

// --- Reads (own account/row per concern) ------------------------------

export function clientSuperAccount(state) {
  return (state.plan.superAccounts ?? []).find((s) => s.owner === "client") ?? null;
}

function findSalaryRow(state) {
  return (state.cashflows.income ?? []).find((r) => r.owner === "client" && r.category === "salary") ?? null;
}

function findConcessionalContributionRow(state) {
  return (state.cashflows.superContributions ?? []).find((c) => c.owner === "client" && c.type === "salarySacrifice") ?? null;
}

// Structural match, not a marker field (no new field anywhere) — the
// one income row owned by the client, categorised "otherIncome", that
// starts at the retirement-client anchor specifically. A household that
// separately adds a SECOND otherIncome row via the comprehensive
// workspace (starting elsewhere) is out of this simple page's own
// reach — a disclosed limitation of "deliberately narrow", not a
// silent miscount.
function findOtherRetirementIncomeRow(state) {
  return (state.cashflows.income ?? []).find((r) =>
    r.owner === "client" && r.category === "otherIncome"
    && r.from?.kind === "anchor" && r.from?.anchorId === "retirement-client"
  ) ?? null;
}

export function findOtherInvestmentsAsset(state) {
  return (state.assets ?? [])[0] ?? null;
}

// retirementFields(state) → the eleven fields' own CURRENT values, read
// straight off the existing state paths above — the read side symmetric
// with every setter below, so the page can populate its form from
// whatever state it loaded (a fresh scenario, or one edited earlier in
// this same session) without tracking any of its own local copy.
export function retirementFields(state) {
  const sa = clientSuperAccount(state);
  const salary = findSalaryRow(state);
  const contribution = findConcessionalContributionRow(state);
  const otherIncome = findOtherRetirementIncomeRow(state);
  const asset = findOtherInvestmentsAsset(state);
  return {
    firstName: state.plan.client.firstName,
    dob: state.plan.client.dob,
    retirementAge: state.plan.client.retirementAge,
    superBalance: sa?.balance ?? 0,
    superAllocation: sa?.allocation ?? null,
    salary: salary?.amount ?? 0,
    concessionalContributions: contribution?.amount ?? 0,
    incomeRequired: state.plan.retirement?.incomeRequired ?? createIncomeRequired(),
    otherInvestments: asset?.balance ?? 0,
    otherInvestmentsAllocation: asset?.allocation ?? null,
    otherRetirementIncome: otherIncome?.amount ?? 0,
    includeAgePension: state.plan.client.taxProfile?.centrelinkEligible !== false,
  };
}

// --- Per-person setters -------------------------------------------------

export function setFirstName(state, value) {
  return { ...state, plan: { ...state.plan, client: { ...state.plan.client, firstName: value } } };
}

export function setDob(state, value) {
  return { ...state, plan: { ...state.plan, client: { ...state.plan.client, dob: value } } };
}

export function setRetirementAge(state, value) {
  return { ...state, plan: { ...state.plan, client: { ...state.plan.client, retirementAge: value } } };
}

// Ensures exactly one super account for the client exists, creating one
// via the SAME factory the comprehensive Super input section's own
// "+ Add super account" button calls, if none does yet. Never a second,
// parallel concept of "the retirement page's own super account" — a
// scenario created here has ordinary plan.superAccounts entries, full
// stop.
export function ensureClientSuperAccount(state, profiles) {
  if (clientSuperAccount(state)) return state;
  const sa = createSuperAccount(state.plan, state.plan.superAccounts ?? [], profiles, "client");
  return { ...state, plan: { ...state.plan, superAccounts: [...(state.plan.superAccounts ?? []), sa] } };
}

function withClientSuperAccount(state, profiles, patch) {
  const next = ensureClientSuperAccount(state, profiles);
  const superAccounts = next.plan.superAccounts.map((s) => (s.owner === "client" ? { ...s, ...patch(s) } : s));
  return { ...next, plan: { ...next.plan, superAccounts } };
}

export function setSuperBalance(state, value, profiles) {
  return withClientSuperAccount(state, profiles, () => ({ balance: value }));
}

// `allocation` is either { mode: "profile", profile } or
// { mode: "glidePath", glidePathId } — the same shape clampAllocation
// already validates for every other allocation-bearing row; this
// setter stores it as given and leaves validation to the caller's own
// clampAllToPlan pass (a dangling glidePathId falls back to a firm
// profile there, same as everywhere else).
export function setSuperAllocation(state, allocation, profiles) {
  return withClientSuperAccount(state, profiles, () => ({ allocation }));
}

function withSalaryRow(state, patch) {
  const existing = findSalaryRow(state);
  if (existing) {
    const income = state.cashflows.income.map((r) => (r.id === existing.id ? { ...r, ...patch } : r));
    return { ...state, cashflows: { ...state.cashflows, income } };
  }
  const row = { ...createIncomeRow(state.plan, state.cashflows.income ?? []), ...patch };
  return { ...state, cashflows: { ...state.cashflows, income: [...(state.cashflows.income ?? []), row] } };
}

export function setSalary(state, value) {
  return withSalaryRow(state, { amount: value });
}

// "Concessional contributions beyond SG (annual)" — salarySacrifice is
// the natural fit (createSuperContribution's own default type, and the
// spec's own wording: additional to SG, not SG itself — see schedule.js
// for why SG needs no explicit contribution row at all: it's derived
// automatically from every sgApplies:true income row).
export function setConcessionalContributions(state, value, profiles) {
  const withAccount = ensureClientSuperAccount(state, profiles);
  const existing = findConcessionalContributionRow(withAccount);
  if (existing) {
    const superContributions = withAccount.cashflows.superContributions.map((c) =>
      (c.id === existing.id ? { ...c, amount: value, basis: "amount", frequency: "annual" } : c)
    );
    return { ...withAccount, cashflows: { ...withAccount.cashflows, superContributions } };
  }
  const row = {
    ...createSuperContribution(withAccount.plan, withAccount.plan.superAccounts, "client"),
    amount: value, basis: "amount", frequency: "annual",
  };
  return {
    ...withAccount,
    cashflows: { ...withAccount.cashflows, superContributions: [...(withAccount.cashflows.superContributions ?? []), row] },
  };
}

// --- Household setters ---------------------------------------------------

// plan.retirement.incomeRequired is the SPEC 32 CONTROL, all sources —
// this setter merges a partial patch (e.g. { source: "asfaComfortable" }
// or { customAmount: 90000 }) rather than requiring the caller to
// reconstruct the whole object, matching main.js's own
// commitIncomeRequired convention on the comprehensive Settings page.
export function setIncomeRequired(state, patch) {
  const incomeRequired = { ...(state.plan.retirement?.incomeRequired ?? createIncomeRequired()), ...patch };
  return { ...state, plan: { ...state.plan, retirement: { ...state.plan.retirement, incomeRequired } } };
}

function withOtherInvestmentsAsset(state, profiles, patch) {
  const assets = state.assets && state.assets.length > 0
    ? state.assets.map((a, i) => (i === 0 ? { ...a, ...patch(a) } : a))
    : [{ ...createAsset(state.plan, [], profiles), ...patch(null) }];
  const fundingOrder = state.settings.fundingOrder.length > 0 || assets.length === 0
    ? state.settings.fundingOrder
    : [assets[0].id];
  return { ...state, assets, settings: { ...state.settings, fundingOrder } };
}

// "Other investments as a single lump" — defaultState() already seeds
// exactly one financial asset (assets[0]); this writes into THAT row
// rather than adding a second one, so a scenario created here still
// carries the ordinary single-asset shape every fresh scenario has.
export function setOtherInvestments(state, value, profiles) {
  return withOtherInvestmentsAsset(state, profiles, () => ({ balance: value }));
}

export function setOtherInvestmentsAllocation(state, allocation, profiles) {
  return withOtherInvestmentsAsset(state, profiles, () => ({ allocation }));
}

// "Other retirement income (annual, indexed)" — an ordinary
// cashflows.income row, category "otherIncome" (clampIncomeRow derives
// incomeType "otherTaxable" and sgApplies false from that category
// alone — never set manually here), running from the retirement-client
// anchor to the plan's own end, indexed to CPI by default.
export function setOtherRetirementIncome(state, value) {
  const existing = findOtherRetirementIncomeRow(state);
  if (existing) {
    const income = state.cashflows.income.map((r) => (r.id === existing.id ? { ...r, amount: value } : r));
    return { ...state, cashflows: { ...state.cashflows, income } };
  }
  const row = {
    ...createIncomeRow(state.plan, state.cashflows.income ?? []),
    category: "otherIncome",
    amount: value,
    frequency: "annual",
    indexBasis: "cpi",
    indexExtraPct: 0,
    from: RETIREMENT_CLIENT_ANCHOR,
    to: END_ANCHOR,
  };
  return { ...state, cashflows: { ...state.cashflows, income: [...(state.cashflows.income ?? []), row] } };
}

// "Include age pension" toggle, default on. There is no single
// household-level Centrelink flag in this schema (planState.js's
// applyCentrelinkEligibleDefault sets plan.client.taxProfile.
// centrelinkEligible / centrelinkEligibleIsDefault PER PERSON) — for
// this single-person page that IS the household flag. ON restores the
// smart default (age-based eligibility, still tracked); OFF is an
// explicit, permanent override — never age-pension-eligible regardless
// of age — same one-way "stop tracking the smart default" convention
// every other derived-default field in this schema already uses.
export function setIncludeAgePension(state, included) {
  const taxProfile = {
    ...state.plan.client.taxProfile,
    centrelinkEligible: included ? true : false,
    centrelinkEligibleIsDefault: included,
  };
  return { ...state, plan: { ...state.plan, client: { ...state.plan.client, taxProfile } } };
}
