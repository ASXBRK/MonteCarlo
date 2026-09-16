// Section 7 item: superReleased fallback vs excludeFromRetirement
import { basePlan, build, createAsset, createExpenseRow, createSuperAccount, runProjection, PROFILES, r0 } from "./helpers.mjs";
const { base, plan } = basePlan({ age: 66, retirementAge: 65, startMonth: 7, endAge: 70 });
const supA = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super A (excluded)", balance: 300000, excludeFromRetirement: true, excludeFromRetirementReason: "Legacy for children", allocation: { mode: "profile", profile: "Balanced" } };
const supB = { ...createSuperAccount(plan, [supA], PROFILES, "client"), name: "Super B", balance: 20000, allocation: { mode: "profile", profile: "Balanced" } };
const cash = { ...createAsset(plan, [], PROFILES), name: "Cash (excluded)", owner: "client", balance: 100000, excludeFromRetirement: true, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
const exp = { ...createExpenseRow(plan, []), label: "Living", category: "nonDiscretionary", amount: 60000 / 12, frequency: "monthly" };
const st = build(base, plan, { assets: [cash], expenses: [exp], superAccounts: [supA, supB] });
console.log("flags after clamp: cash", st.assets[0].excludeFromRetirement, "superA", st.plan.superAccounts[0].excludeFromRetirement);
const out = runProjection(st);
for (const r of out.yearly) console.log(r.fyLabel, "cash closing", r0(r.closingBalance), "superA withdrawals", r0(r.superDetail[supA.id].withdrawals), "superB withdrawals", r0(r.superDetail[supB.id].withdrawals), "unfunded", r0(r.unfundedCashflow));
