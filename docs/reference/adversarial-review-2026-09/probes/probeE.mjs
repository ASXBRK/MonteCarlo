import { basePlan, build, createAsset, createIncomeRow, createSuperAccount, runProjection, PROFILES, r0, clampAllToPlan } from "./helpers.mjs";
// Bonus → super destination vs the NCC cap. TSB $2.6m (≥ $2.1m → NCC cap NIL under law). $300k gross bonus each year directed to super.
const { base, plan } = basePlan({ age: 55, retirementAge: 65, startMonth: 7, endAge: 60 });
const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 2600000, allocation: { mode: "profile", profile: "Balanced" } };
const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", owner: "client", balance: 100000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
const salary = { ...createIncomeRow(plan, []), label: "Salary", owner: "client", incomeType: "employment", amount: 200000, frequency: "annual", from: { kind: "age", age: 55 }, to: { kind: "age", age: 59 } };
const bonus = { ...createIncomeRow(plan, []), label: "Bonus", owner: "client", incomeType: "employment", category: "bonus", amount: 300000, frequency: "annual", bonusMonth: 6, from: { kind: "age", age: 55 }, to: { kind: "age", age: 59 }, bonusDestination: { type: "superContribution", targetId: sup.id } };
const state = build(base, plan, { assets: [cash], income: [salary, bonus], superAccounts: [sup] });
console.log("bonus row after clamp:", JSON.stringify(state.cashflows.income[1].bonusDestination), state.cashflows.income[1].category, state.cashflows.income[1].bonusMonth);
const out = runProjection(state);
console.log("errors", out.errors);
for (const row of out.yearly.slice(0, 6)) {
  const sd = row.superDetail[sup.id];
  console.log(row.fyLabel, "age", row.clientAge, "income", r0(row.income), "superOpening", r0(sd.opening), "contributions", r0(sd.contributions), "NCC field", r0(sd.nonConcessional), "sg", r0(sd.sg), "superClosing", r0(row.superClosing), "taxFreeClosing", r0(sd.taxFreeClosing));
}
console.log(out.superWarnings.map(w => w.fyLabel + " " + w.type + ": " + w.reason));
