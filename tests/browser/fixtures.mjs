// Browser-harness fixtures (docs/specs/40-browser-test-harness.md,
// Commit 1) — built through the SAME factories/clamp pipeline the demo
// clients (src/demo/*.js) and hydrate() itself use, never a hand-
// written state object literal (this project's own stated policy —
// see src/demo/index.js's header). A fixture built this way is
// guaranteed schema-valid without having to track schema changes by
// hand: whatever clampAllToPlan currently produces IS the shape.
//
// These are pure Node-importable ES modules (src/planState.js touches
// no DOM/Plotly — the same "pure modules never import DOM" convention
// CLAUDE.md's testing section states), so they run directly under
// node:test with no bundler in between.
import {
  defaultState, clampPlan, clampAllToPlan, serialize,
  createAsset, createIncomeRow, createExpenseRow,
  createSuperAccount, createPension, createSuperContribution,
  createBond, createProperty, createLiability,
} from "../../src/planState.js";
import { PROFILES } from "../../src/profiles.js";

// "Nearly empty" (Commit 4) — the absolute floor the app can boot
// with: defaultState()'s own single default financial asset, nothing
// else. hydrate() itself refuses a state with zero assets (see
// support.mjs's own header), so this — not a genuinely empty state —
// IS the minimum seedable fixture.
export function nearlyEmptyState(now = new Date(2026, 8, 1)) {
  return clampAllToPlan(defaultState(PROFILES, now), PROFILES);
}

// "Single data point" (Commit 4) — the structural floor PLUS exactly
// one real piece of client data (a salary row), distinct from nearly-
// empty: a client who has entered ONE thing so far, not nothing.
export function singleDataPointState(now = new Date(2026, 8, 1)) {
  const base = defaultState(PROFILES, now);
  const salary = {
    ...createIncomeRow(base.plan, []), label: "Salary", category: "salary", incomeType: "employment",
    owner: "client", amount: 90_000, frequency: "annual", sgApplies: true,
  };
  const raw = { ...base, cashflows: { ...base.cashflows, income: [salary] } };
  return clampAllToPlan(raw, PROFILES);
}

// "Fully populated" (Commits 2 and 3) — a couple exercising
// accumulation super, an already-commenced pension, a bond, a PPR
// property, a liability, AND age-pension eligibility together, so a
// single fixture covers both "every control has something real to
// operate on" (Commit 2) and "every displayed total has a genuine,
// non-trivial figure to reconcile against" (Commit 3). Kept modest in
// total assessable wealth deliberately — a wealthy couple would price
// the age pension out entirely, the one ingredient the demo clients
// (src/demo/index.js) never combine with the other five in one place.
export function fullyPopulatedState(now = new Date(2026, 8, 1)) {
  const base = defaultState(PROFILES, now);
  const plan = clampPlan({
    ...base.plan,
    household: "married",
    client: { currentAge: 68, retirementAge: 65 },
    partner: { currentAge: 63, retirementAge: 65 },
  }, PROFILES);

  // Client: one super account, PARTIALLY commenced — $60k still
  // accumulating, $140k already in an ABP — so accumulation and
  // pension phase both exist on the same person, the common real
  // shape (spec 20's own "partial commencement" case).
  const superClient = {
    ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super — client", balance: 60_000,
    allocation: { mode: "profile", profile: "Moderate Growth" },
  };
  const superPartner = {
    ...createSuperAccount(plan, [superClient], PROFILES, "partner"), name: "Super — partner", balance: 90_000,
    allocation: { mode: "profile", profile: "Moderate Growth" },
  };
  const superAccounts = [superClient, superPartner];

  const pensionClient = {
    ...createPension(plan, [], superAccounts, "client"), name: "Account-based pension — client",
    sourceAccountId: superClient.id, commenceAt: { kind: "age", age: 68 },
    commenceAmount: 140_000, drawdownOption: "minimum",
    allocation: { mode: "profile", profile: "Moderate Growth" },
  };
  const pensions = [pensionClient];

  // Partner still working — the one active super-contribution row
  // (salary sacrifice) this fixture needs for Commit 2 to have a
  // genuine "add/remove contribution row" control to exercise.
  const contribution = {
    ...createSuperContribution(plan, superAccounts, "partner"), accountId: superPartner.id,
    type: "salarySacrifice", basis: "amount", amount: 5_000, frequency: "annual",
  };
  const partnerIncome = {
    ...createIncomeRow(plan, []), label: "Casual work — partner", category: "salary", incomeType: "employment",
    owner: "partner", amount: 28_000, frequency: "annual", sgApplies: true,
  };
  const income = [partnerIncome];

  const living = {
    ...createExpenseRow(plan, []), label: "Living expenses", category: "nonDiscretionary",
    amount: 42_000 / 12, frequency: "monthly",
  };
  const expenses = [living];

  // PPR — exempt from the age pension assets test regardless of
  // value, so its own value doesn't crowd out eligibility the way an
  // investment property would.
  const home = {
    ...createProperty(plan, [], 3), name: "Family home", owner: "joint", state: "NSW",
    propertyType: "ppr", status: "owned",
    currentValue: 620_000, acquisitionDate: "2001-06-01", costBase: 210_000,
  };
  const properties = [home];

  const savings = {
    ...createAsset(plan, [], PROFILES), name: "Savings", owner: "joint",
    balance: 15_000, distributions: "reinvest", cgtAsset: false, costBase: null,
    allocation: { mode: "profile", profile: "Cash" },
  };
  const bond = {
    ...createBond(plan, [], PROFILES), name: "Investment bond", owner: "client",
    balance: 20_000, allocation: { mode: "profile", profile: "Balanced" },
  };
  const assets = [savings];

  // A small personal loan — unlinked, so it's a plain liability rather
  // than a purchase-derived one, keeping this fixture's own liability
  // simple to reconcile against.
  const loan = {
    ...createLiability(plan, []), name: "Car loan", type: "personal", owner: "client",
    balance: 15_000, interestRatePct: 7, termYears: 5, repayment: "pi",
  };
  const liabilities = [loan];

  const planFull = { ...plan, superAccounts, pensions };
  const raw = {
    ...base,
    plan: planFull,
    assets,
    cashflows: {
      ...base.cashflows,
      income, expenses, deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [contribution], superWithdrawals: [],
    },
    liabilities,
    properties,
    goals: [],
    bonds: [bond],
    settings: {
      surplus: { periods: [{
        id: "sp-fixture", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
        payNonDeductibleDebtFirst: true, debtOrder: "interestRate", allocations: [], remainderTo: "cash",
      }] },
      fundingOrder: assets.map((a) => a.id),
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
  };
  return clampAllToPlan(raw, PROFILES);
}

// serialize() is planState.js's own — re-exported here so every
// caller (support.mjs, test files) gets it from one place alongside
// the fixtures it's always used with.
export { serialize };
