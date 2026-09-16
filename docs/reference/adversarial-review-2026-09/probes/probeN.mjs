import { basePlan, build, createAsset, createSuperAccount, runProjection, PROFILES, r0 } from "./helpers.mjs";
import { createSuperWithdrawal, createSuperContribution } from "../../../../src/planState.js";
const { base: b0, plan } = basePlan({ age: 66, retirementAge: 65, startMonth: 7, endAge: 70 });
plan.client.deathBenefit = { beneficiaries: [{ id: "b1", label: "Adult child", relationship: "adultChild", sharePct: 100 }] };
const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 500000, taxFreeComponent: 0, allocation: { mode: "profile", profile: "Balanced" } };
const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", owner: "client", balance: 50000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
const wd = { ...createSuperWithdrawal(plan, [sup], "client"), accountId: sup.id, amount: 120000, frequency: "annual", from: { kind: "age", age: 66 }, to: { kind: "age", age: 66 } };
const sc = { ...createSuperContribution(plan, [sup], "client"), accountId: sup.id, type: "personalNonDeductible", amount: 120000, frequency: "annual", from: { kind: "age", age: 66 }, to: { kind: "age", age: 66 } };
for (const [label, opts] of [["with", { superWithdrawals: [wd], superContributions: [sc] }], ["without", {}]]) {
  const st = build(b0, plan, { assets: [cash], superAccounts: [sup], ...opts });
  const out = runProjection(st);
  const last = out.yearly[out.yearly.length - 1];
  const sd = last.superDetail[sup.id];
  console.log(label, "errors", out.errors.length, "yr0 withdrawals", r0(out.yearly[0].superDetail[sup.id].withdrawals), "yr0 NCC", r0(out.yearly[0].superDetail[sup.id].nonConcessional), "final closing", r0(sd.closing), "taxFree", r0(sd.taxFreeClosing), "deathBenefit", JSON.stringify(last.deathBenefitDetail?.client?.totals), "warnings", out.superWarnings.map(w => w.type + ":" + w.reason).slice(0, 3));
  if (label === "with") console.log("  withdrawal row:", JSON.stringify(st.cashflows.superWithdrawals[0]));
}
