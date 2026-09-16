// Deferred edge-case probes. Each: no errors, no NaN/Infinity in yearly, conservation holds, expected behaviour.
import { basePlan, build, createAsset, createExpenseRow, createIncomeRow, createSuperAccount, runProjection, PROFILES, r0, clampAllToPlan } from "./helpers.mjs";
import { createLiability, createCashflow } from "../../../../src/planState.js";
import { conserve } from "./conserve.mjs";
function scanNaN(obj, path = "", out = []) {
  if (typeof obj === "number") { if (!Number.isFinite(obj)) out.push(path); return out; }
  if (obj && typeof obj === "object" && !(obj instanceof Float64Array)) for (const k of Object.keys(obj)) scanNaN(obj[k], path + "." + k, out);
  return out;
}
function check(label, st, extra = () => "") {
  const out = runProjection(st);
  const nan = out.errors.length ? [] : scanNaN(out.yearly, "yearly");
  const fails = out.errors.length ? [] : conserve(out, label);
  const neg = out.errors.length ? [] : out.yearly.flatMap((r) => Object.entries(r.perAssetClosing ?? {}).filter(([, v]) => v < -0.01).map(([k, v]) => `${r.fyLabel}:${k}=${r0(v)}`));
  console.log(`${label}: years ${out.yearly?.length ?? "-"} errors ${JSON.stringify(out.errors).slice(0, 120)} NaN ${nan.length ? nan.slice(0, 3).join(",") : "none"} conservation ${fails.length ? "FAIL " + fails[0] : "ok"} negativeAssets ${neg.length ? neg.slice(0, 3) : "none"} ${extra(out, st)}`);
  return out;
}
// (a) zero everything; negative balance
{
  const { base, plan } = basePlan({ age: 40, startMonth: 7, endAge: 42 });
  check("zero plan", build(base, plan, {}));
  const a = { ...createAsset(plan, [], PROFILES), name: "Neg", balance: -50000, distributions: "reinvest", cgtAsset: false, allocation: { mode: "profile", profile: "Cash" } };
  const st = build(base, plan, { assets: [a] });
  console.log("  negative balance after clamp:", st.assets[0].balance);
}
// (b) client past the life table end
{
  const { base, plan } = basePlan({ age: 104, retirementAge: 65, startMonth: 7 });
  const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", balance: 200000, distributions: "reinvest", cgtAsset: false, allocation: { mode: "profile", profile: "Cash" } };
  const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 4000, frequency: "monthly" };
  check("age 104 at start (LE-basis end)", build(base, plan, { assets: [cash], expenses: [exp] }), (o, s) => `endAge ${s.plan.endAge} agePension yr0 ${r0(o.yearly[0].agePensionDetail?.entitlement)}`);
}
// (c) couple 67 / 42
{
  const { base, plan } = basePlan({ age: 67, retirementAge: 65, startMonth: 7, partner: { age: 42, retirementAge: 65 } });
  const supP = { ...createSuperAccount(plan, [], PROFILES, "partner"), name: "Partner super", balance: 200000, allocation: { mode: "profile", profile: "Balanced" } };
  const supC = { ...createSuperAccount(plan, [supP], PROFILES, "client"), name: "Client super", balance: 300000, allocation: { mode: "profile", profile: "Balanced" } };
  const sal = { ...createIncomeRow(plan, []), label: "Salary", owner: "partner", incomeType: "employment", amount: 90000, frequency: "annual", from: { kind: "age", age: 42 }, to: { kind: "age", age: 64 } };
  const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 5000, frequency: "monthly" };
  const st = build(base, plan, { income: [sal], expenses: [exp], superAccounts: [supP, supC] });
  check("couple 67/42", st, (o, s) => `endAge ${s.plan.endAge} (client) partnerAge at end ${o.yearly[o.yearly.length - 1].partnerAge}; salary row to after clamp ${JSON.stringify(s.cashflows.income[0].to)}; income final yr ${r0(o.yearly[o.yearly.length - 1].income)}; yr0 agePension ${r0(o.yearly[0].agePensionDetail?.entitlement)} partner accum assessed? assessableAssets ${r0(o.yearly[0].agePensionDetail?.assessableAssets)}`);
}
// (d) one-year projection (death / end in year 0), July and September starts
for (const m of [7, 9]) {
  const { base, plan } = basePlan({ age: 70, retirementAge: 65, startMonth: m, endAge: 70 });
  const sup = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super", balance: 400000, taxFreeComponent: 100000, allocation: { mode: "profile", profile: "Balanced" } };
  const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 4000, frequency: "monthly" };
  plan.client.deathBenefit = { beneficiaries: [{ id: "b", label: "Child", relationship: "adultChild", sharePct: 100 }] };
  check(`one-year projection start month ${m}`, build(base, plan, { expenses: [exp], superAccounts: [sup] }), (o) => `deathBenefit tax ${r0(o.yearly[0].deathBenefitDetail?.client?.totals?.tax)} shortfall ${JSON.stringify(o.shortfall)?.slice(0, 80)}`);
}
// (e) same-month buy and sell on one CGT asset
{
  const { base, plan } = basePlan({ age: 50, retirementAge: 65, startMonth: 7, endAge: 53 });
  const shares = { ...createAsset(plan, [], PROFILES), name: "Shares", balance: 100000, distributions: "reinvest", cgtAsset: true, costBase: 50000, allocation: { mode: "profile", profile: "High Growth" } };
  const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", balance: 200000, distributions: "reinvest", cgtAsset: false, allocation: { mode: "profile", profile: "Cash" } };
  const st = build(base, plan, { assets: [cash, shares] });
  st.cashflows.contributions = [{ ...createCashflow("contribution", plan, shares.id), amount: 50000, frequency: "once", from: { kind: "age", age: 51 }, to: { kind: "age", age: 51 } }];
  st.cashflows.withdrawals = [{ ...createCashflow("withdrawal", plan, shares.id), amount: 50000, frequency: "once", from: { kind: "age", age: 51 }, to: { kind: "age", age: 51 } }];
  check("same-month buy and sell", clampAllToPlan(st, PROFILES), (o) => `yr1 shares contributions ${r0(o.yearly[1].perAssetDetail[shares.id].contributions)} withdrawals ${r0(o.yearly[1].perAssetDetail[shares.id].withdrawals)} netCapGain ${r0(o.yearly[1].taxDetail.client.netCapitalGain)} pool ${r0(o.yearly[1].perAssetDetail[shares.id].costBasePool)}`);
}
// (f) early loan repayment via one-off larger than the balance; (g) fixed rate rolling over in the final year
{
  const { base, plan } = basePlan({ age: 40, retirementAge: 65, startMonth: 7, endAge: 45 });
  const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", balance: 400000, distributions: "reinvest", cgtAsset: false, allocation: { mode: "profile", profile: "Cash" } };
  const sal = { ...createIncomeRow(plan, []), label: "Salary", owner: "client", incomeType: "employment", amount: 120000, frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 45 } };
  const loan = { ...createLiability(plan, []), name: "Loan", balance: 200000, interestRatePct: 6, termYears: 20, oneOffRepayments: [{ id: "or1", label: "Payout", amount: 250000, at: { kind: "age", age: 40 } }] };
  const st = build(base, plan, { assets: [cash], income: [sal], liabilities: [loan] });
  check("early repayment > balance", st, (o) => o.yearly.slice(0, 3).map((r) => `${r.fyLabel}: closing ${r0(r.liabilities[loan.id].closing)} interest ${r0(r.liabilities[loan.id].interest)} principal ${r0(r.liabilities[loan.id].principal)} extra ${r0(r.liabilities[loan.id].extraRepayment)}`).join("; "));
  const fixed = { ...createLiability(plan, []), name: "Fixed", balance: 300000, rateType: "fixed", fixedRatePct: 5, revertRatePct: 7, termYears: 25, fixedUntil: { kind: "age", age: 45 } };
  const st2 = build(base, plan, { assets: [cash], income: [sal], liabilities: [fixed] });
  check("fixed rate rolls over in the final year", st2, (o) => `rollovers ${JSON.stringify(o.liabilityRollovers)} final ratePct ${o.yearly[o.yearly.length - 1].liabilities[fixed.id].ratePct} prev ${o.yearly[o.yearly.length - 2].liabilities[fixed.id].ratePct}`);
}
// (h) six super accounts, one owner, SG salary above the maximum contribution base
{
  const { base, plan } = basePlan({ age: 45, retirementAge: 65, startMonth: 7, endAge: 47 });
  const accounts = [];
  for (let i = 0; i < 6; i++) accounts.push({ ...createSuperAccount(plan, accounts, PROFILES, "client"), name: `S${i}`, balance: 50000 * (i + 1), allocation: { mode: "profile", profile: "Balanced" } });
  const sal = { ...createIncomeRow(plan, []), label: "Salary", owner: "client", incomeType: "employment", amount: 300000, frequency: "annual", from: { kind: "age", age: 45 }, to: { kind: "age", age: 47 } };
  const st = build(base, plan, { income: [sal], superAccounts: accounts });
  check("six super accounts", st, (o) => `SG by account yr0 ${accounts.map((a) => r0(o.yearly[0].superDetail[a.id].sg)).join("/")} (cap 12%×270,830 = 32,500)`);
}
