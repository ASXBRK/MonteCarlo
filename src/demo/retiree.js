// Demo fixture: retiree drawing a pension with age pension entitlement
// — built for the divergence analysis (spec 30, Commit 3: "a retiree
// drawing a pension with age pension entitlement", the fourth of the
// four scenarios spanning the firm's client base). Same convention as
// every other demo fixture (src/demo/index.js's own header): every
// state built through the real factories and clampAllToPlan, never a
// hand-written object literal.
//
// Deliberately NOT added to DEMO_BUILDERS (src/demo/index.js) — this
// exists for the divergence report/Focus view, not as a fourth "Load
// demo clients" option. Promoting it to that user-facing feature is a
// separate, larger decision (a new client-facing demo, its own
// walkthrough entry in demo-clients.md, its own structural test in
// demo.test.js) that spec 30 doesn't ask for.
//
// Single, 70, already retired at 65, super rolled into an account-
// based pension five years ago, drawing the minimum, and past age
// pension age (67) — the age pension is genuinely part of household
// income here, not a hypothetical. Exercises pension-phase drawdown,
// the age pension assets/income test, and CSHC alongside it.
import { PROFILES } from "../profiles.js";
import {
  defaultState, clampPlan, clampAllToPlan,
  createAsset, createExpenseRow, createSuperAccount, createPension,
} from "../planState.js";

export function build(now = new Date()) {
  const base = defaultState(PROFILES, now);
  const plan = clampPlan({
    ...base.plan,
    household: "single",
    // No dob spread (see firstHomeBuyer.js's own header on why) — a
    // bare currentAge/retirementAge object lets currentAge win.
    client: { currentAge: 70, retirementAge: 65 },
  }, PROFILES);

  // Commences at age 71 (plan year 1), not 70 (plan year 0) — this
  // engine's own locked convention (CLAUDE.md: annual events fire in
  // July, skipped in a partial first year beginning after July)
  // applies to pension commencement too (pensionCommenceMonth,
  // deterministic.js), and a demo anchored to "today" almost never
  // starts in July. Commencing one year later than currentAge lands
  // in a real, full FY instead of a partial one with no July to fire
  // in — a one-year narrative gap ("already retired at 65, on a
  // pension since" vs. the pension technically commencing in year 1)
  // this tool doesn't otherwise model anyway, since it never models a
  // client's history before the plan's own start date.
  const superAccount = {
    ...createSuperAccount(plan, [], PROFILES, "client"),
    name: "Super — client", balance: 600_000,
    allocation: { mode: "profile", profile: "Moderate Growth" },
  };
  const pension = {
    ...createPension(plan, [], [superAccount], "client"),
    name: "Account-based pension", sourceAccountId: superAccount.id,
    commenceAt: { kind: "age", age: 71 },
    commenceAmount: null, // whole balance
    drawdownOption: "minimum",
    allocation: { mode: "profile", profile: "Moderate Growth" },
  };

  const savings = {
    ...createAsset(plan, [], PROFILES), name: "Savings", owner: "client",
    balance: 40_000, distributions: "reinvest", cgtAsset: false, costBase: null,
    allocation: { mode: "profile", profile: "Cash" },
  };
  const assets = [savings];

  // Monthly, not annual — see firstHomeBuyer.js's own header on why a
  // demo fixture anchored to "today" needs monthly rows.
  const livingExpenses = {
    ...createExpenseRow(plan, []), label: "Living expenses", category: "nonDiscretionary",
    amount: 45_000 / 12, frequency: "monthly",
  };
  const expenses = [livingExpenses];

  const raw = {
    ...base,
    plan: { ...plan, superAccounts: [superAccount], pensions: [pension] },
    assets,
    cashflows: {
      ...base.cashflows,
      income: [], expenses, deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [], superWithdrawals: [],
    },
    liabilities: [],
    properties: [],
    goals: [],
    // Same "single period, no allocations, remainder to cash" shape
    // every other demo fixture uses — see firstHomeBuyer.js's own
    // header on why.
    settings: {
      surplus: { periods: [{
        id: "sp-demo", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
        payNonDeductibleDebtFirst: false, debtOrder: "interestRate", allocations: [], remainderTo: "cash",
      }] },
      fundingOrder: assets.map((a) => a.id),
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
  };

  return {
    name: "Retiree",
    scenarios: [
      { name: "Current", expectAffordable: true, state: clampAllToPlan(raw, PROFILES) },
    ],
  };
}
