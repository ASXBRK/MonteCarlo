import { basePlan, build, createAsset, createExpenseRow, createIncomeRow, createSuperAccount, createPension, runProjection, PROFILES, r0 } from "./helpers.mjs";
import { conserve } from "./conserve.mjs";
// Conservation on the probe scenarios: bonus→super at TSB≥cap; pension-only retiree; untaxed death benefit; September-start retiree.
{
  const { base, plan } = basePlan({ age: 55, retirementAge: 65, startMonth: 7, endAge: 60 });
  const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 2600000, allocation: { mode: "profile", profile: "Balanced" } };
  const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", owner: "client", balance: 100000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
  const salary = { ...createIncomeRow(plan, []), label: "Salary", owner: "client", incomeType: "employment", amount: 200000, frequency: "annual", from: { kind: "age", age: 55 }, to: { kind: "age", age: 59 } };
  const bonus = { ...createIncomeRow(plan, []), label: "Bonus", owner: "client", incomeType: "employment", category: "bonus", amount: 300000, frequency: "annual", bonusMonth: 6, from: { kind: "age", age: 55 }, to: { kind: "age", age: 59 }, bonusDestination: { type: "superContribution", targetId: sup.id } };
  const state = build(base, plan, { assets: [cash], income: [salary, bonus], superAccounts: [sup] });
  console.log("bonus→super conservation fails:", conserve(runProjection(state), "bonus"));
}
{
  const { base, plan } = basePlan({ age: 70, retirementAge: 65, startMonth: 9, endAge: 76 });
  const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 600000, allocation: { mode: "profile", profile: "Moderate Growth" } };
  const pen = { ...createPension(plan, [], [sup], "client"), name: "ABP", sourceAccountId: sup.id, commenceAt: { kind: "age", age: 70 }, commenceAmount: null, drawdownOption: "minimum", allocation: { mode: "profile", profile: "Moderate Growth" } };
  const savings = { ...createAsset(plan, [], PROFILES), name: "Savings", owner: "client", balance: 40000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
  const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 45000 / 12, frequency: "monthly" };
  const state = build(base, plan, { assets: [savings], expenses: [exp], superAccounts: [sup], pensions: [pen] });
  console.log("Sept-start retiree conservation fails:", conserve(runProjection(state), "sept"));
}
