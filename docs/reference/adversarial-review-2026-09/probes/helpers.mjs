import { PROFILES } from "../../../../src/profiles.js";
import { defaultState, clampPlan, clampAllToPlan, createAsset, createExpenseRow, createIncomeRow, createSuperAccount, createPension, createSuperContribution } from "../../../../src/planState.js";
import { runProjection } from "../../../../src/engine.js";
export { PROFILES, runProjection, createAsset, createExpenseRow, createIncomeRow, createSuperAccount, createPension, createSuperContribution, clampAllToPlan };
export function basePlan({ age = 70, retirementAge = 65, startYear = 2026, startMonth = 7, endAge = null, partner = null } = {}) {
  const base = defaultState(PROFILES, new Date(startYear, startMonth - 1, 1));
  const plan = clampPlan({
    ...base.plan,
    household: partner ? "couple" : "single",
    client: { currentAge: age, retirementAge },
    partner: partner ? { currentAge: partner.age, retirementAge: partner.retirementAge ?? 65 } : null,
    start: { year: startYear, month: startMonth },
    ...(endAge ? { endAge, endBasis: { mode: "fixed", age: endAge } } : {}),
  }, PROFILES);
  return { base, plan };
}
export function build(base, plan, { assets = [], expenses = [], income = [], superAccounts = [], pensions = [], superContributions = [], superWithdrawals = [], liabilities = [], properties = [] } = {}) {
  const raw = {
    ...base,
    plan: { ...plan, superAccounts, pensions },
    assets,
    cashflows: { ...base.cashflows, income, expenses, deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions, superWithdrawals },
    liabilities, properties, goals: [],
    settings: {
      surplus: { periods: [{ id: "sp", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" }, payNonDeductibleDebtFirst: false, debtOrder: "interestRate", allocations: [], remainderTo: "cash" }] },
      fundingOrder: assets.map((a) => a.id),
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
  };
  return clampAllToPlan(raw, PROFILES);
}
export const r0 = (v) => Math.round(v ?? 0);
