// Demo client: Modest retiree — docs/reference/demo-clients.md has the
// walkthrough. Built through the same factories as every other demo
// client (see firstHomeBuyer.js's own header for why).
//
// Couple, 70 and 68, ~$420k combined super already in pension phase
// (both drawing the minimum), own their home outright, minimal other
// assets, and a small casual income for the partner — exercises the
// age pension where it actually binds (near-full, not zero, unlike
// the wealthier demo clients), deeming, the Work Bonus, gifting and
// deprivation, minimum drawdowns, and the age pension strategy Focus
// view.
import { PROFILES } from "../profiles.js";
import {
  defaultState, clampPlan, clampAllToPlan,
  createAsset, createIncomeRow, createExpenseRow, createSuperAccount, createPension,
  createProperty, createGift,
} from "../planState.js";

function baseInputs(now) {
  const base = defaultState(PROFILES, now);
  const plan = clampPlan({
    ...base.plan,
    household: "married",
    // No dob spread (see firstHomeBuyer.js's own header on why) — a
    // bare currentAge/retirementAge object lets currentAge win.
    client: { currentAge: 70, retirementAge: 65 },
    partner: { currentAge: 68, retirementAge: 65 },
  }, PROFILES);

  const superClient = {
    ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super — client", balance: 250_000,
    allocation: { mode: "profile", profile: "Moderate Growth" },
  };
  const superPartner = {
    ...createSuperAccount(plan, [superClient], PROFILES, "partner"), name: "Super — partner", balance: 170_000,
    allocation: { mode: "profile", profile: "Moderate Growth" },
  };
  const superAccounts = [superClient, superPartner];

  // Already retired, on a pension since — commence one plan year after
  // currentAge, not at it (this engine's own locked convention: annual
  // events fire in July, skipped in a partial first year — a demo
  // anchored to "today" almost never starts in July; see retiree.js's
  // own header for the full reasoning, unchanged here).
  const pensionClient = {
    ...createPension(plan, [], superAccounts, "client"), name: "Account-based pension — client",
    sourceAccountId: superClient.id, commenceAt: { kind: "age", age: 71 },
    commenceAmount: null, drawdownOption: "minimum",
    allocation: { mode: "profile", profile: "Moderate Growth" },
  };
  const pensionPartner = {
    ...createPension(plan, [], superAccounts, "partner"), name: "Account-based pension — partner",
    sourceAccountId: superPartner.id, commenceAt: { kind: "age", age: 69 },
    commenceAmount: null, drawdownOption: "minimum",
    allocation: { mode: "profile", profile: "Moderate Growth" },
  };
  const pensions = [pensionClient, pensionPartner];

  // Own their home outright — no linked loan, PPR (CGT-exempt
  // regardless of what happens to it — CLAUDE.md's own locked
  // convention), and the Downsize scenario's own subject.
  const home = {
    ...createProperty(plan, [], 3), name: "Family home", owner: "joint", state: "NSW",
    propertyType: "ppr", status: "owned",
    currentValue: 650_000, acquisitionDate: "1998-04-01", costBase: 180_000,
  };
  const properties = [home];

  const savings = {
    ...createAsset(plan, [], PROFILES), name: "Savings", owner: "joint",
    balance: 25_000, distributions: "reinvest", cgtAsset: false, costBase: null,
    allocation: { mode: "profile", profile: "Cash" },
  };
  const assets = [savings];

  // A small casual income for the partner — the Work Bonus (spec 21b,
  // Commit 1) exists specifically for a pensioner who still does SOME
  // paid work; without it, this fill has nothing to exercise.
  const partnerCasual = {
    ...createIncomeRow(plan, []), label: "Casual work — partner", category: "salary", incomeType: "employment",
    owner: "partner", amount: 8_000 / 12, frequency: "monthly", sgApplies: true,
    to: { kind: "anchor", anchorId: "end" },
  };
  const income = [partnerCasual];

  // Monthly, not annual — see firstHomeBuyer.js's own header on why a
  // demo fixture anchored to "today" needs monthly rows.
  const living = {
    ...createExpenseRow(plan, []), label: "Living expenses", category: "nonDiscretionary",
    amount: 52_000 / 12, frequency: "monthly",
  };
  const expenses = [living];

  const planFull = { ...plan, superAccounts, pensions };
  return { base, plan: planFull, assets, income, expenses, properties, superAccounts };
}

function finalize(base, plan, assets, income, expenses, properties) {
  const raw = {
    ...base,
    plan,
    assets,
    cashflows: {
      ...base.cashflows,
      income, expenses, deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [], superWithdrawals: [],
    },
    liabilities: [],
    properties,
    goals: [],
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
  const { base, plan, assets, income, expenses, properties } = baseInputs(now);
  return finalize(base, plan, assets, income, expenses, properties);
}

// A single $30,000 gift, well above the $10,000 annual limit (spec
// 21b, Commit 2) — $10,000 of it is allowable, the remaining $20,000
// is a DEPRIVED asset assessed under the age pension means test for
// five years from the gift's own date. The exact figure the spec
// asked for turns out to demonstrate the annual limit binding, not
// just the five-year one — a $30k gift is exactly at the five-year
// limit but nowhere near the $10k/FY one.
function buildGift(now) {
  const { base, plan, assets, income, expenses, properties } = baseInputs(now);
  const gift = {
    ...createGift(plan, []), owner: "joint", amount: 30_000,
    at: { kind: "age", age: 73 }, label: "Gift to children",
  };
  const planWithGift = { ...plan, gifts: [gift] };
  return finalize(base, planWithGift, assets, income, expenses, properties);
}

// Downsizing at 75 — sells the family home outright, proceeds landing
// in Savings. Buying a smaller replacement home is out of scope (this
// engine has no re-purchase-on-sale mechanic yet) — a disclosed
// simplification, not a real downsizer contribution: the freed-up cash
// lands in an ordinary financial asset, assessable under the age
// pension means test exactly like any other financial asset (whereas
// the home itself was fully exempt) — the point this scenario exists
// to show, since it can materially REDUCE the pension from here.
function buildDownsize(now) {
  const { base, plan, assets, income, expenses, properties } = baseInputs(now);
  const [home] = properties;
  const savings = assets.find((a) => a.name === "Savings");
  const sold = {
    ...home,
    sale: {
      enabled: true, at: { kind: "age", age: 75 }, agentFeesPct: 2.5, settlementCosts: 3000,
      proceedsDestination: "asset", assetId: savings.id,
    },
  };
  return finalize(base, plan, assets, income, expenses, [sold]);
}

export function build(now = new Date()) {
  return {
    name: "Modest retiree",
    scenarios: [
      { name: "Current", expectAffordable: true, state: buildCurrent(now) },
      { name: "Gift $30k to children", expectAffordable: true, state: buildGift(now) },
      { name: "Downsize at 75", expectAffordable: true, state: buildDownsize(now) },
    ],
  };
}
