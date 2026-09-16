import { basePlan, build, createAsset, createExpenseRow, createIncomeRow, createSuperAccount, createPension, createSuperContribution, runProjection, PROFILES, r0 } from "./helpers.mjs";
// B1: Div 296 — $3.6m in ABP (commenced year 0), $100k accumulation. Law: TSB 3.7m > 3m → Div 296 applies every year on earnings. Engine?
{
  const { base, plan } = basePlan({ age: 66, retirementAge: 65, startMonth: 7, endAge: 72 });
  const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 3700000, allocation: { mode: "profile", profile: "Moderate Growth" } };
  const pen = { ...createPension(plan, [], [sup], "client"), name: "ABP", sourceAccountId: sup.id, commenceAt: { kind: "age", age: 66 }, commenceAmount: 3600000, drawdownOption: "minimum", allocation: { mode: "profile", profile: "Moderate Growth" } };
  const savings = { ...createAsset(plan, [], PROFILES), name: "Savings", owner: "client", balance: 40000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
  const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 60000 / 12, frequency: "monthly" };
  const state = build(base, plan, { assets: [savings], expenses: [exp], superAccounts: [sup], pensions: [pen] });
  const out = runProjection(state);
  console.log("B1 errors", out.errors);
  for (const row of out.yearly) {
    console.log(row.fyLabel, "superClosing", r0(row.superClosing), "pensionClosing", r0(row.pensionClosing), "pensionEarnings", r0(row.pensionDetail?.[pen.id]?.earnings), "superEarnings", r0(row.superDetail?.[sup.id]?.earnings), "div296 paid", r0(row.taxDetail?.div296), "accruedDiv296", r0(out.accruedDiv296AtEnd));
  }
}
// B2: carry-forward gate — $300k accumulation + $900k ABP (TSB $1.2m ≥ $500k → NO carry-forward under law). Personal deductible $60k in year 1 with 5 years of unused cap seeded.
{
  const { base, plan } = basePlan({ age: 61, retirementAge: 60, startMonth: 7, endAge: 65 });
  plan.client.super = { ...(plan.client.super ?? {}), carryForward: [20000, 20000, 20000, 20000, 20000], workTestMet: true };
  const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 1200000, allocation: { mode: "profile", profile: "Moderate Growth" } };
  const pen = { ...createPension(plan, [], [sup], "client"), name: "ABP", sourceAccountId: sup.id, commenceAt: { kind: "age", age: 61 }, commenceAmount: 900000, drawdownOption: "minimum", allocation: { mode: "profile", profile: "Moderate Growth" } };
  const savings = { ...createAsset(plan, [], PROFILES), name: "Savings", owner: "client", balance: 400000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
  const sc = { ...createSuperContribution(plan, [sup], "client"), accountId: sup.id, type: "personalDeductible", amount: 90000, frequency: "annual", from: { kind: "age", age: 62 }, to: { kind: "age", age: 62 } };
  const state = build(base, plan, { assets: [savings], superAccounts: [sup], pensions: [pen], superContributions: [sc] });
  console.log("B2 contribution row after clamp:", JSON.stringify(state.cashflows.superContributions[0]));
  const out = runProjection(state);
  console.log("B2 errors", out.errors);
  for (const row of out.yearly) {
    const cu = row.superCapUsage?.client;
    console.log(row.fyLabel, "age", row.clientAge, "superClosing", r0(row.superClosing), "pensionClosing", r0(row.pensionClosing), "PD", r0(row.superDetail?.[sup.id]?.personalDeductible), "capUsage", cu && JSON.stringify({cap: r0(cu.cap), cf: r0(cu.carryForwardAvailable), avail: r0(cu.available)}), "excessCC", r0(row.taxDetail?.client?.excessConcessionalContributions));
  }
  console.log(out.superWarnings.map(w => w.fyLabel + " " + w.type + ": " + w.reason));
}
