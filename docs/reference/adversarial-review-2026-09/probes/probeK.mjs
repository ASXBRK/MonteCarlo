import { basePlan, build, createAsset, createExpenseRow, createSuperAccount, createPension, runProjection, PROFILES, r0 } from "./helpers.mjs";
import { compositeSeries } from "../../../../src/outputSeries.js";
import { debtVsAssetsSeries, superVsNonSuperSeries, expenseFundingSeries } from "../../../../src/chartSeries.js";
import { createBond } from "../../../../src/planState.js";
// Retiree 70, $600k ABP (minimum), $40k savings, $100k investment bond, $45k/yr spend. July start.
const { base, plan } = basePlan({ age: 70, retirementAge: 65, startMonth: 7, endAge: 74 });
const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 600000, allocation: { mode: "profile", profile: "Moderate Growth" } };
const pen = { ...createPension(plan, [], [sup], "client"), name: "ABP", sourceAccountId: sup.id, commenceAt: { kind: "age", age: 70 }, commenceAmount: null, drawdownOption: "minimum", allocation: { mode: "profile", profile: "Moderate Growth" } };
const savings = { ...createAsset(plan, [], PROFILES), name: "Savings", owner: "client", balance: 40000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 45000 / 12, frequency: "monthly" };
const bond = { ...createBond(plan, [], PROFILES), name: "Bond", balance: 100000, allocation: { mode: "profile", profile: "Balanced" } };
const state = build(base, plan, { assets: [savings], expenses: [exp], superAccounts: [sup], pensions: [pen] });
state.bonds = [bond];
const st = (await import("./helpers.mjs")).clampAllToPlan(state, PROFILES);
const out = runProjection(st);
const cs = compositeSeries(out.yearly, st.assets, st.properties, st.display.chartTreatment);
const dva = debtVsAssetsSeries(out.yearly), svn = superVsNonSuperSeries(out.yearly), ef = expenseFundingSeries(out.yearly);
out.yearly.forEach((r, y) => {
  const pd = r.pensionDetail[pen.id];
  console.log(r.fyLabel, "| ledger: income", r0(r.income), "pensionPayments", r0(pd.payments), "expenses", r0(r.expenses), "tax", r0(r.tax), "surplusOrDeficit", r0(r.surplusOrDeficit), "deficitFunded", r0(r.deficitFundedFromAssets), "netAssets", r0(r.netAssets), "pensionClosing", r0(r.pensionClosing), "bonds", r0(r.bondsClosing));
  console.log("   composite: income", r0(cs.income[y]), "agePension", r0(cs.agePension[y]), "drawdown", r0(cs.drawdown[y]), "expenditure", r0(cs.expenditure[y]));
  console.log("   debtVsAssets.assets", r0(dva[y].assets), "superVsNonSuper", r0(svn[y].superBalance), "+", r0(svn[y].nonSuper), "= ", r0(svn[y].superBalance + svn[y].nonSuper), "| expenseFunding met/assets/unfunded", r0(ef[y].metFromIncome), r0(ef[y].fundedFromAssets), r0(ef[y].unfunded));
});
