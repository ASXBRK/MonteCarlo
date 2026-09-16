import { basePlan, build, createAsset, createExpenseRow, createSuperAccount, createPension, runProjection, PROFILES, r0 } from "./helpers.mjs";
import { cashflowStatement } from "../../../../src/cashflowStatement.js";
import { incomeCategorySums, expenseCategorySums } from "../../../../src/cashflowCategories.js";
// Retiree 70: $600k ABP paying the minimum, age pension, $45k/yr spend. What do the Cashflow statement and Key-figures totals say?
const { base, plan } = basePlan({ age: 70, retirementAge: 65, startMonth: 7, endAge: 73 });
const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 600000, allocation: { mode: "profile", profile: "Moderate Growth" } };
const pen = { ...createPension(plan, [], [sup], "client"), name: "ABP", sourceAccountId: sup.id, commenceAt: { kind: "age", age: 70 }, commenceAmount: null, drawdownOption: "minimum", allocation: { mode: "profile", profile: "Moderate Growth" } };
const savings = { ...createAsset(plan, [], PROFILES), name: "Savings", owner: "client", balance: 40000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 45000 / 12, frequency: "monthly" };
const st = build(base, plan, { assets: [savings], expenses: [exp], superAccounts: [sup], pensions: [pen] });
const out = runProjection(st);
const rt = out.schedule.rowTotals;
out.yearly.forEach((row, y) => {
  const s = cashflowStatement(row, { incomeRows: st.cashflows.income, rowTotalsIncome: rt.income, expenseRows: st.cashflows.expenses, rowTotalsExpenses: rt.expenses, deductionRows: [], rowTotalsDeductions: rt.deductions, properties: [], liabilities: [], superAccounts: st.plan.superAccounts, y, educationBlocks: [], rowTotalsEducation: {}, definedBenefits: [] }, null);
  const inc = incomeCategorySums(row, st.cashflows.income, rt.income, [], out.schedule.oneOffsByAssetYear, st.assets.map(a => a.id), st.plan.superAccounts, y);
  console.log(row.fyLabel, "| pension payments", r0(row.pensionDetail[pen.id].payments), "age pension", r0(row.agePensionDetail.entitlement), "| statement: govt payments", r0(s.assessable.governmentPayments), "cashReceived.total", r0(s.cashReceived.total), "otherTaxFree", r0(s.cashReceived.otherTaxFreeIncome), "expenses.total", r0(s.expenses.total), "SURPLUS INCOME", r0(s.surplusIncome), "| key figures Total income", r0(inc.employment + inc.rental + inc.investment + inc.wcaInterest + inc.other), "surplusOrDeficit", r0(row.surplusOrDeficit), "wcaClosing", r0(row.wcaClosing), "closingBalance", r0(row.closingBalance));
});
