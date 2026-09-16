import { basePlan, build, createAsset, createSuperAccount, runProjection, PROFILES, r0 } from "./helpers.mjs";
// Death benefit tax on an UNTAXED-status account (e.g. GESB West State Super) left to an adult child (non-dependant).
// Law: taxable component, element untaxed → 30% + 2% Medicare = 32%. Element taxed → 15% + 2% = 17%.
for (const taxedStatus of ["taxed", "untaxed"]) {
  const { base, plan } = basePlan({ age: 70, retirementAge: 65, startMonth: 7, endAge: 72 });
  plan.client.deathBenefit = { beneficiaries: [{ id: "b1", label: "Adult child", relationship: "adultChild", sharePct: 100 }] };
  const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "West State", balance: 500000, taxFreeComponent: 0, taxedStatus, allocation: { mode: "profile", profile: "Balanced" } };
  const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", owner: "client", balance: 300000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
  const state = build(base, plan, { assets: [cash], superAccounts: [sup] });
  console.log("clamped taxedStatus:", state.plan.superAccounts[0].taxedStatus, "beneficiaries:", JSON.stringify(state.plan.client.deathBenefit));
  const out = runProjection(state);
  const last = out.yearly[out.yearly.length - 1];
  const db = last.deathBenefitDetail?.client;
  console.log(taxedStatus, "final superClosing", r0(last.superClosing), "accounts", JSON.stringify(db?.accounts.map(a => ({ closing: r0(a.closing), taxFree: r0(a.taxFree), taxableTaxed: r0(a.taxableTaxed), taxableUntaxed: r0(a.taxableUntaxed) }))), "tax", r0(db?.totals.tax), "effective rate", (db.totals.tax / db.totals.gross).toFixed(3));
}
