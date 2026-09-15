import { basePlan, build, createAsset, createExpenseRow, createSuperAccount, createPension, PROFILES, r0 } from "./helpers.mjs";
import { runMonteCarlo } from "../../../../src/monteCarlo.js";
for (const mode of ["pension", "accumulation"]) {
  const { base, plan } = basePlan({ age: 66, retirementAge: 65, startMonth: 7, endAge: 80 });
  const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 800000, allocation: { mode: "profile", profile: "High Growth" } };
  const pen = { ...createPension(plan, [], [sup], "client"), name: "ABP", sourceAccountId: sup.id, commenceAt: { kind: "age", age: 66 }, commenceAmount: null, drawdownOption: "expenditure", allocation: { mode: "profile", profile: "High Growth" } };
  const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", owner: "client", balance: 10000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
  const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 70000 / 12, frequency: "monthly" };
  const state = build(base, plan, { assets: [cash], expenses: [exp], superAccounts: [sup], pensions: mode === "pension" ? [pen] : [] });
  const mc = runMonteCarlo(state, PROFILES, { numPaths: 300, seed: 7, cpiSigma: 0 });
  const b = mc.netAssets;
  console.log(mode, "year 13: p10", r0(b.p10[13]), "p50", r0(b.p50[13]), "p90", r0(b.p90[13]), "ruin", mc.ruinProbability);
}
