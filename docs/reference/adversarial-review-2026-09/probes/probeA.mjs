import { basePlan, build, createAsset, createExpenseRow, createSuperAccount, createPension, runProjection, PROFILES, r0 } from "./helpers.mjs";
for (const startMonth of [7, 9]) {
  const { base, plan } = basePlan({ age: 70, retirementAge: 65, startMonth, endAge: 76 });
  const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 600000, allocation: { mode: "profile", profile: "Moderate Growth" } };
  const pen = { ...createPension(plan, [], [sup], "client"), name: "ABP", sourceAccountId: sup.id, commenceAt: { kind: "age", age: 70 }, commenceAmount: null, drawdownOption: "minimum", allocation: { mode: "profile", profile: "Moderate Growth" } };
  const savings = { ...createAsset(plan, [], PROFILES), name: "Savings", owner: "client", balance: 40000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
  const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 45000 / 12, frequency: "monthly" };
  const state = build(base, plan, { assets: [savings], expenses: [exp], superAccounts: [sup], pensions: [pen] });
  console.log("pension commenceAt after clamp:", JSON.stringify(state.plan.pensions[0].commenceAt), "start month", startMonth);
  const out = runProjection(state);
  console.log("errors", out.errors);
  for (const row of out.yearly) {
    const pd = row.pensionDetail?.[pen.id];
    console.log(row.fyLabel, "age", row.clientAge, "superClosing", r0(row.superClosing), "pensionClosing", r0(row.pensionClosing), "commence", r0(pd?.commencementAmount), "payments", r0(pd?.payments), "unfunded", r0(row.unfundedCashflow), "closingBal", r0(row.closingBalance));
  }
  console.log("superWarnings", out.superWarnings.map(w => w.type + ":" + w.reason).slice(0, 5));
}
