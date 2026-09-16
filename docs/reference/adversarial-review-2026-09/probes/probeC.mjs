import { basePlan, build, createAsset, createSuperAccount, createSuperContribution, runProjection, PROFILES, r0 } from "./helpers.mjs";
// Bring-forward: age 60, TSB $1.80m at start (< $1.84m → 3-year window). NCC $200k in year 0 triggers the window (remaining $190k).
// By 30 June year 0 TSB ≈ $2.0m+; by 30 June year 1 ≥ $2.1m. Law (s292-85(2)): NCC cap is NIL in any year TSB at prior 30 June ≥ GTBC, even mid-window.
const { base, plan } = basePlan({ age: 60, retirementAge: 65, startMonth: 7, endAge: 64 });
const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 1800000, allocation: { mode: "profile", profile: "High Growth" } };
const savings = { ...createAsset(plan, [], PROFILES), name: "Savings", owner: "client", balance: 900000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
const sc0 = { ...createSuperContribution(plan, [sup], "client"), accountId: sup.id, type: "personalNonDeductible", amount: 200000, frequency: "annual", from: { kind: "age", age: 60 }, to: { kind: "age", age: 60 } };
const sc1 = { ...createSuperContribution(plan, [sup], "client"), accountId: sup.id, type: "personalNonDeductible", amount: 190000, frequency: "annual", from: { kind: "age", age: 62 }, to: { kind: "age", age: 62 } };
const state = build(base, plan, { assets: [savings], superAccounts: [sup], superContributions: [sc0, sc1] });
const out = runProjection(state);
console.log("errors", out.errors);
for (const row of out.yearly) {
  const sd = row.superDetail[sup.id];
  console.log(row.fyLabel, "age", row.clientAge, "superOpening", r0(sd.opening), "NCC accepted", r0(sd.nonConcessional), "superClosing", r0(row.superClosing), "savings", r0(row.closingBalance));
}
console.log(out.superWarnings.map(w => w.fyLabel + " " + w.type + ": " + w.reason));
