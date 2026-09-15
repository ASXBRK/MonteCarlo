// Section 7: does the Monte Carlo CPI path reach income indexation / real returns? Plan with AWOTE-indexed salary, no liabilities.
import { basePlan, build, createAsset, createExpenseRow, createIncomeRow, PROFILES, r0 } from "./helpers.mjs";
import { runMonteCarlo } from "../../../../src/monteCarlo.js";
const { base, plan } = basePlan({ age: 40, retirementAge: 65, startMonth: 7, endAge: 60 });
const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", balance: 50000, distributions: "reinvest", cgtAsset: false, allocation: { mode: "custom", incomePct: 3, growthPct: 0, frankingPct: 0, volBasis: "Cash" } };
const sal = { ...createIncomeRow(plan, []), label: "Salary", owner: "client", incomeType: "employment", amount: 120000, frequency: "annual", indexBasis: "awote", indexExtraPct: 0, from: { kind: "age", age: 40 }, to: { kind: "age", age: 60 } };
const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 5000, frequency: "monthly", indexBasis: "cpi" };
const st = build(base, plan, { assets: [cash], income: [sal], expenses: [exp] });
console.log("salary indexBasis after clamp:", st.cashflows.income[0].indexBasis, "assumptions wageGrowth", st.assumptions.wageGrowth, "cpi", st.assumptions.cpi);
for (const cpiSigma of [0, 0.02]) {
  const mc = runMonteCarlo(st, PROFILES, { numPaths: 200, seed: 3, cpiSigma });
  const y = 19;
  console.log(`cpiSigma ${cpiSigma}: net assets yr${y} p10 ${r0(mc.netAssets.p10[y])} p50 ${r0(mc.netAssets.p50[y])} p90 ${r0(mc.netAssets.p90[y])}`);
}
