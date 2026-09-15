import { basePlan, build, createAsset, createIncomeRow, createSuperAccount, runProjection, PROFILES, r0 } from "./helpers.mjs";
import { createCashflow } from "../../../../src/planState.js";
// Div 293 and capital gains: salary $230k (SG 12% = $27.6k). Year 1: sell $400k of a $500k asset with $100k cost base → gross gain $320k, discounted $160k.
// Law: Div 293 income = taxable income (incl. net capital gain) + low-tax contributions = 230k + 160k + 27.6k = 417.6k > 250k → Div 293 = 15% × 27,600 = $4,140.
const { base, plan } = basePlan({ age: 50, retirementAge: 65, startMonth: 7, endAge: 54 });
const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 300000, allocation: { mode: "profile", profile: "Balanced" } };
const shares = { ...createAsset(plan, [], PROFILES), name: "Shares", owner: "client", balance: 500000, distributions: "reinvest", cgtAsset: true, costBase: 100000, allocation: { mode: "profile", profile: "High Growth" } };
const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", owner: "client", balance: 50000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
const salary = { ...createIncomeRow(plan, []), label: "Salary", owner: "client", incomeType: "employment", amount: 230000, frequency: "annual", from: { kind: "age", age: 50 }, to: { kind: "age", age: 54 } };
const wd = { ...createCashflow("withdrawal", plan, shares.id), amount: 400000, frequency: "once", from: { kind: "age", age: 50 }, to: { kind: "age", age: 50 } };
const state = build(base, plan, { assets: [cash, shares], income: [salary], superAccounts: [sup] });
state.cashflows.withdrawals = [wd];
const st2 = (await import("./helpers.mjs")).clampAllToPlan(state, PROFILES);
const out = runProjection(st2);
console.log("errors", out.errors, "withdrawal row", JSON.stringify(st2.cashflows.withdrawals[0]));
for (const row of out.yearly) {
  const c = row.taxDetail.client;
  console.log(row.fyLabel, "income", r0(row.income), "taxable", r0(c.taxableIncome), "netCapGain", r0(c.netCapitalGain), "cgt", r0(c.cgt), "div293 assessed (pending)", r0(c.div293), "sg", r0(row.superDetail[sup.id].sg), "withdrawals", r0(row.withdrawals));
}
console.log("accruedDiv293AtEnd", r0(out.accruedDiv293AtEnd));
