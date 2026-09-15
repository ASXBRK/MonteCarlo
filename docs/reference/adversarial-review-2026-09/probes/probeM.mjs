// Comparison / what-if / focus arms: does each arm change the projection?
import { buildDemoClients } from "../../../../src/demo/index.js";
import { PROFILES } from "../../../../src/profiles.js";
import { projectPlan } from "../../../../src/deterministic.js";
import { clampAllToPlan, createAgedCareEntry, createSuperWithdrawal, createSuperContribution, createPension } from "../../../../src/planState.js";
import { buildAgePensionStrategyFocus } from "../../../../src/focusAgePensionStrategy.js";
import { buildAgedCarePlanningFocus } from "../../../../src/focusAgedCarePlanning.js";
import { buildSalarySacrificeFocus } from "../../../../src/focusSalarySacrifice.js";
import { buildFhsssComparison } from "../../../../src/focusFhsss.js";
import { projectSingleDestinationAlternative, nonDeductibleFirstBenefit } from "../../../../src/focusSurplusAllocation.js";
import { applyContributeMore, applyRetireLater, applySpendLess, applyUniformProfile } from "../../../../src/retirementLevers.js";
import { runShock } from "../../../../src/whatIf.js";
import { buildCrashTimingView } from "../../../../src/whatIfCrash.js";
import { buildRecontributionFocus } from "../../../../src/focusDeathBenefits.js";
import { buildDebtPayoffFocus } from "../../../../src/focusDebtPayoff.js";
import { buildDebtRecyclingFocus } from "../../../../src/focusDebtRecycling.js";
import { buildEducationFundingFocus } from "../../../../src/focusEducationFunding.js";
import { buildLifecycleComparison } from "../../../../src/retirementLifecycleComparison.js";
import { buildAgedCareAccommodationFocus } from "../../../../src/focusAgedCareAccommodation.js";
import { basePlan, build, createAsset, createExpenseRow, createSuperAccount } from "./helpers.mjs";

const demos = Object.fromEntries(buildDemoClients(new Date(2026, 8, 15)).map((c) => [c.name, Object.fromEntries(c.scenarios.map((s) => [s.name, s.state]))]));
const preRet = demos["Comprehensive pre-retiree"]["Current"];
const preRetSS = demos["Comprehensive pre-retiree"]["Maximise concessional"];
const family = demos["Family with a mortgage"]["Current"];
const familyExtra = demos["Family with a mortgage"]["Extra repayments $1k/mo"];
const familyRecycle = demos["Family with a mortgage"]["Debt recycling"];
const fhb = demos["First home buyer"]["Buy 2030 with FHSSS"];
const retiree = demos["Modest retiree"]["Current"];
const maxDiff = (a, b, f = (r) => r.netAssets) => Math.max(...a.yearly.map((r, i) => Math.abs(f(r) - f(b.yearly[i] ?? {}))));
const report = (label, d, extra = "") => console.log(`${d === 0 ? "IDENTICAL " : "differs   "} ${label}: max |Δ net assets| ${Math.round(d).toLocaleString()} ${extra}`);

// 1. Age pension strategy (modest retiree, September start)
{
  const f = buildAgePensionStrategyFocus({ state: retiree });
  for (const arm of f.arms.filter((a) => a.id !== "current")) {
    const d = Math.max(...f.byYear.map((p) => Math.abs(p[arm.id].netAssets - p.current.netAssets)));
    const dE = Math.max(...f.byYear.map((p) => Math.abs(p[arm.id].entitlement - p.current.entitlement)));
    report(`agePensionStrategy/${arm.id}`, d, `entitlement Δ ${Math.round(dE)}`);
  }
}
// 2. Aged care planning gift arm — entry at 76 with the default 6 years before → gift resolves to age 70 = plan year 0 of a September-start plan
{
  for (const entryAge of [76, 80]) {
    const s = structuredClone(retiree);
    const ac = { ...createAgedCareEntry(s.plan, [], "client"), entryAt: { kind: "age", age: entryAge }, radAmount: 300000 };
    s.plan.agedCare = [ac];
    const st = clampAllToPlan(s, PROFILES);
    const f = buildAgedCarePlanningFocus({ state: st, agedCareEntryId: st.plan.agedCare[0].id, giftAmount: 50000, giftYearsBeforeEntry: 6 });
    if (!f) { console.log("agedCarePlanning entry", entryAge, "→ null (entry never fires)"); continue; }
    const cur = f.arms[0], gift = f.arms[1];
    report(`agedCarePlanning gift arm (entry ${entryAge}, gift at ${gift.giftAge})`, Math.abs(gift.estatePosition - cur.estatePosition), `cost of care Δ ${Math.round(gift.totalCostOfCare - cur.totalCostOfCare)}`);
  }
}
// 3. Salary sacrifice focus (pre-retiree "Maximise concessional" has $0 rows; set amount 20000)
{
  const row = preRetSS.cashflows.superContributions[0];
  const f = buildSalarySacrificeFocus({ state: preRetSS, contributionId: row.id, amount: 20000 });
  const d = Math.max(...f.byYear.map((p) => Math.abs(p.netAssetsWith - p.netAssetsWithout)));
  report("salarySacrifice with vs without", d, `tax saved yr1 ${Math.round(f.byYear[1].incomeTaxSaved)}`);
}
// 4. FHSSS comparison
{
  const c = buildFhsssComparison({ state: fhb, person: "client" });
  console.log(c ? `differs?  fhsssComparison inside ${Math.round(c.insideValue)} vs outside ${Math.round(c.outsideValue)} (${c.fyLabel})` : "fhsssComparison → null");
}
// 5. Surplus allocation alternative + non-deductible-first
{
  const base = projectPlan(family);
  const liab = family.liabilities.find((l) => l.rateType === "variable");
  const alt = projectSingleDestinationAlternative(family, { targetType: "liability", targetId: liab.id });
  report("surplusAllocation single destination (variable home loan)", maxDiff(base, alt));
  const s2 = structuredClone(family); s2.settings.surplus.periods[0].payNonDeductibleDebtFirst = true;
  const st2 = clampAllToPlan(s2, PROFILES);
  const b = nonDeductibleFirstBenefit(st2, projectPlan(st2));
  console.log("nonDeductibleFirstBenefit:", b ? `interestSaved ${Math.round(b.interestSaved)}` : "null");
}
// 6. Retirement levers (deterministic effect)
{
  const base = projectPlan(preRet);
  report("lever contributeMore +$20k", maxDiff(base, projectPlan(clampAllToPlan(applyContributeMore(preRet, 20000), PROFILES))));
  report("lever retireLater 65→68", maxDiff(base, projectPlan(clampAllToPlan(applyRetireLater(preRet, 68), PROFILES))));
  report("lever spendLess $40k (pre-retiree, no expenditure pension)", maxDiff(base, projectPlan(clampAllToPlan(applySpendLess(preRet, 40000), PROFILES))));
  const rBase = projectPlan(retiree);
  report("lever spendLess $30k (modest retiree, minimum pensions)", maxDiff(rBase, projectPlan(clampAllToPlan(applySpendLess(retiree, 30000), PROFILES))));
  report("lever takeMoreRisk High Growth", maxDiff(base, projectPlan(clampAllToPlan(applyUniformProfile(preRet, "High Growth"), PROFILES))));
}
// 7. What-if shocks
{
  for (const shock of [
    { kind: "rateShock", deltaPct: 2 }, { kind: "revertRateShock", deltaPct: 2 },
    { kind: "incomeGap", ownerId: "client", atAge: 40, months: 12, replacementPct: 0 },
    { kind: "expenseShock", pct: 20 },
  ]) {
    const { base, shocked } = runShock(family, shock);
    report(`whatIf ${shock.kind}`, maxDiff(base, shocked));
  }
}
// 8. Crash timing — pre-retiree vs pension-only retiree
{
  for (const [label, st] of [["pre-retiree", preRet], ["modest retiree (pensions, Sept start)", retiree]]) {
    const v = buildCrashTimingView({ state: st, dropPct: 30, recoveryYears: 3 });
    if (!v) { console.log(`crash ${label} → null`); continue; }
    for (const run of v.ages) report(`crash ${label} @${run.age} (${run.label})`, run.out ? maxDiff(v.base, run.out) : NaN);
  }
  // July-start retiree with ALL wealth in a pension
  const { base: b0, plan } = basePlan({ age: 66, retirementAge: 65, startMonth: 7, endAge: 80 });
  const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 800000, allocation: { mode: "profile", profile: "High Growth" } };
  const pen = { ...createPension(plan, [], [sup], "client"), name: "ABP", sourceAccountId: sup.id, commenceAt: { kind: "age", age: 66 }, commenceAmount: null, drawdownOption: "expenditure", allocation: { mode: "profile", profile: "High Growth" } };
  const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", owner: "client", balance: 10000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
  const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 70000 / 12, frequency: "monthly" };
  const st = build(b0, plan, { assets: [cash], expenses: [exp], superAccounts: [sup], pensions: [pen] });
  const v = buildCrashTimingView({ state: st, dropPct: 30, recoveryYears: 3 });
  for (const run of v.ages) report(`crash pension-only retiree @${run.age} (${run.label})`, run.out ? maxDiff(v.base, run.out) : NaN);
}
// 9. Recontribution focus (July-start retiree, taxed account, adult child beneficiary)
{
  const { base: b0, plan } = basePlan({ age: 66, retirementAge: 65, startMonth: 7, endAge: 70 });
  plan.client.deathBenefit = { beneficiaries: [{ id: "b1", label: "Adult child", relationship: "adultChild", sharePct: 100 }] };
  const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 500000, taxFreeComponent: 0, allocation: { mode: "profile", profile: "Balanced" } };
  const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", owner: "client", balance: 50000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
  const wd = { ...createSuperWithdrawal(plan, [sup], "client"), accountId: sup.id, amount: 120000, frequency: "once", from: { kind: "age", age: 66 }, to: { kind: "age", age: 66 } };
  const sc = { ...createSuperContribution(plan, [sup], "client"), accountId: sup.id, type: "personalNonDeductible", amount: 120000, frequency: "annual", from: { kind: "age", age: 66 }, to: { kind: "age", age: 66 } };
  const st = build(b0, plan, { assets: [cash], superAccounts: [sup], superWithdrawals: [wd], superContributions: [sc] });
  const f = buildRecontributionFocus({ state: st, owner: "client", withdrawalId: st.cashflows.superWithdrawals[0].id, contributionId: st.cashflows.superContributions[0].id });
  console.log(`recontribution: withTax ${Math.round(f.withTax)} withoutTax ${Math.round(f.withoutTax)} saved ${Math.round(f.taxSaved)}`);
}
// 10. Debt payoff counterfactual; 11. Debt recycling
{
  const out = projectPlan(familyExtra);
  const l = familyExtra.liabilities.find((x) => (x.extraRepayments ?? []).length > 0);
  const f = buildDebtPayoffFocus({ out, state: familyExtra, liabilityId: l.id });
  const d = Math.max(...f.balanceSeries.map((r) => Math.abs(r.actual - r.noExtras)));
  report("debtPayoff actual vs no-extras", d);
  const out2 = projectPlan(familyRecycle);
  const l2 = familyRecycle.liabilities.find((x) => x.recycling?.enabled);
  const f2 = buildDebtRecyclingFocus({ out: out2, state: familyRecycle, liabilityId: l2.id });
  report("debtRecycling with vs without (investment balance)", Math.max(...f2.series.map((r) => Math.abs(r.investmentBalance - r.investmentBalanceWithout))));
}
// 12. Education funding arms (family has 2 children)
{
  const child = family.plan.children[0];
  const f = buildEducationFundingFocus({ out: projectPlan(family), state: family, childId: child.id });
  if (!f) console.log("educationFunding → null (child not eligible)");
  else {
    const last = f.series[f.series.length - 1];
    console.log(`educationFunding: baseline ${Math.round(last.netAssetsBaseline)} investment bond ${Math.round(last.netAssetsInvestment)} education bond ${Math.round(last.netAssetsEducation)}`);
  }
}
// 13. Lifecycle comparison
{
  const c = buildLifecycleComparison(preRet, "client", PROFILES);
  report("lifecycle glide vs static", maxDiff(c.glideProjection, c.staticProjection));
}
// 14. Aged care accommodation arms (retiree, RAD vs DAP)
{
  const asset = retiree.assets[0];
  const f = buildAgedCareAccommodationFocus({ state: retiree, accommodationPrice: 500000, radAmount: 250000, entryAge: 80, fundingAssetId: asset.id });
  if (!f) console.log("agedCareAccommodation → null"); else console.log("agedCareAccommodation arms:", f.arms.map((a) => `${a.id}: end net ${Math.round(a.estatePosition ?? a.netAssetsAtEnd ?? NaN)}`).join(" | "), Object.keys(f.arms[0]).join(","));
}
