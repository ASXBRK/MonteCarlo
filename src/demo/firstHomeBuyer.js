// Demo client: First home buyer — docs/reference/demo-clients.md has
// the walkthrough. Every scenario is built through the SAME factories
// (createAsset, createIncomeRow, etc.) main.js itself uses, then run
// through clampAllToPlan — never a hand-written object literal — so a
// schema change breaks this file at build/test time instead of
// silently drifting out of sync with what the app actually produces.
import { PROFILES } from "../profiles.js";
import {
  defaultState, clampPlan, clampAllToPlan,
  createAsset, createIncomeRow, createExpenseRow, createSuperAccount, createSuperContribution,
  createProperty,
} from "../planState.js";

// Single, 29, salary ~$110k, HELP debt, modest savings, renting —
// exercises HELP, FHSSS, the purchase engine, stamp duty, LMI/FHBG,
// the deposit Focus view and its solver.
function baseInputs(now) {
  const base = defaultState(PROFILES, now);
  const plan = clampPlan({
    ...base.plan,
    household: "single",
    // No `...base.plan.client` spread here: defaultState's default client
    // carries a real `dob` string, and clampPerson derives currentAge from
    // dob when one is present, silently overriding any currentAge given
    // alongside it. Passing a bare object with no dob lets currentAge win.
    client: { currentAge: 29, retirementAge: 65, helpBalance: 28_000 },
  }, PROFILES);

  const savings = {
    ...createAsset(plan, [], PROFILES), name: "Savings", owner: "client",
    balance: 35_000, distributions: "reinvest", cgtAsset: false, costBase: null,
    allocation: { mode: "profile", profile: "Cash" },
  };
  const assets = [savings];

  // Monthly, not annual: an annual-frequency row fires once, in July
  // (see schedule.js's applyRegular) — a demo client anchored to
  // whatever day it's loaded almost always starts partway through a
  // FY, so an annual row would silently contribute nothing in year
  // one. Monthly is also just how a salary/rent actually arrives.
  const salary = {
    ...createIncomeRow(plan, []), label: "Salary", category: "salary", incomeType: "employment",
    owner: "client", amount: 110_000 / 12, frequency: "monthly", sgApplies: true,
  };
  const income = [salary];

  const rent = {
    ...createExpenseRow(plan, []), label: "Rent", category: "nonDiscretionary",
    amount: 26_000 / 12, frequency: "monthly",
  };
  const expenses = [rent];

  const super1 = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super — client", balance: 18_000 };
  const superAccounts = [super1];

  return { base, plan: { ...plan, superAccounts }, assets, income, expenses, superAccounts };
}

function finalize(base, plan, assets, income, expenses, superAccounts, extra = {}) {
  const raw = {
    ...base,
    plan,
    assets,
    cashflows: {
      ...base.cashflows,
      income, expenses, deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: extra.superContributions ?? [],
    },
    liabilities: extra.liabilities ?? [],
    properties: extra.properties ?? [],
    goals: [],
    // Surplus/deficit allocation spec, Commit 1: settings.surplus is now
    // a list of periods, not {mode, assetId} — a single period covering
    // the whole projection with no allocations and remainderTo "cash"
    // reproduces this demo's original "accumulate" intent exactly.
    // payNonDeductibleDebtFirst is off, same reasoning the v16->v17
    // migration uses for an existing scenario: this fixture's numbers
    // were built and are tested against the neutral behaviour, not the
    // new default (a future demo could turn it on deliberately, to
    // actually showcase the feature).
    settings: {
      surplus: { periods: [{
        id: "sp-demo", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
        payNonDeductibleDebtFirst: false, debtOrder: "interestRate", allocations: [], remainderTo: "cash",
      }] },
      fundingOrder: assets.map((a) => a.id),
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
  };
  return clampAllToPlan(raw, PROFILES);
}

function buildCurrent(now) {
  const { base, plan, assets, income, expenses, superAccounts } = baseInputs(now);
  return finalize(base, plan, assets, income, expenses, superAccounts);
}

// A planned first-home purchase in Perth, ~4 years out (2030 from a
// present-day "now") at a high LVR — the First Home Guarantee waives
// LMI here rather than the client paying it, the point of the feature
// this scenario exists to show. WA rather than NSW/VIC deliberately —
// this is the only demo client that exercises WA's own stamp duty
// schedule (docs/reference/demo-coverage.md tracks which client covers
// which state).
function plannedHome(plan) {
  return {
    ...createProperty(plan, [], 5),
    name: "First home (Perth)", owner: "client", state: "WA", propertyType: "ppr", status: "planned",
    priceToday: 650_000, purchaseAt: { kind: "age", age: 33 },
    lvrPct: 95, firstHomeBuyer: true, firstHomeGuarantee: true, newBuild: false,
    purchaseCostsPct: 2,
  };
}

function buildBuy2030(now) {
  const { base, plan, assets, income, expenses, superAccounts } = baseInputs(now);
  const property = plannedHome(plan);
  return finalize(base, plan, assets, income, expenses, superAccounts, { properties: [property] });
}

// Same purchase, but voluntary super contributions from now until
// purchase are flagged FHSSS-eligible and released at settlement —
// deemed earnings accrue on them in the meantime (fhsss.js).
function buildBuy2030Fhsss(now) {
  const { base, plan, assets, income, expenses, superAccounts } = baseInputs(now);
  const property = { ...plannedHome(plan), releaseFhsssAtPurchase: true };
  const sacrifice = {
    ...createSuperContribution(plan, superAccounts, "client"),
    label: "FHSSS voluntary contribution", type: "salarySacrifice", basis: "amount",
    amount: 15_000 / 12, frequency: "monthly", // monthly, same reason as salary/rent above
    from: { kind: "age", age: 29 }, to: { kind: "age", age: 32 },
    fhsssEligible: true,
  };
  return finalize(base, plan, assets, income, expenses, superAccounts, {
    properties: [property], superContributions: [sacrifice],
  });
}

export function build(now = new Date()) {
  return {
    name: "First home buyer",
    scenarios: [
      { name: "Current", expectAffordable: true, state: buildCurrent(now) },
      { name: "Buy 2030", expectAffordable: true, state: buildBuy2030(now) },
      { name: "Buy 2030 with FHSSS", expectAffordable: true, state: buildBuy2030Fhsss(now) },
    ],
  };
}
