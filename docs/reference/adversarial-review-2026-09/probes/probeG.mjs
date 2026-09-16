import { basePlan, build, createAsset, createSuperAccount, runProjection, PROFILES, r0 } from "./helpers.mjs";
import { createGift, createAgedCareEntry, createSuperRollover } from "../../../../src/planState.js";
// Gift of $100k "at age 70" and aged care entry "at age 70" and a super rollover at 70, plan starting September with client aged 70.
for (const startMonth of [7, 9]) {
  const { base, plan } = basePlan({ age: 70, retirementAge: 65, startMonth, endAge: 74 });
  const supA = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "A", balance: 400000, allocation: { mode: "profile", profile: "Balanced" } };
  const supB = { ...createSuperAccount(plan, [supA], PROFILES, "client"), name: "B", balance: 10000, allocation: { mode: "profile", profile: "Balanced" } };
  const cash = { ...createAsset(plan, [], PROFILES), name: "Cash", owner: "client", balance: 600000, distributions: "reinvest", cgtAsset: false, costBase: null, allocation: { mode: "profile", profile: "Cash" } };
  const gift = { ...createGift(plan, []), amount: 100000, at: { kind: "age", age: 70 } };
  const ac = { ...createAgedCareEntry(plan, [], "client"), entryAt: { kind: "age", age: 70 }, radAmount: 400000 };
  plan.gifts = [gift]; plan.agedCare = [ac];
  const roll = { ...createSuperRollover(plan, [supA, supB], "client"), fromAccountId: supA.id, toAccountId: supB.id, amount: 100000, at: { kind: "age", age: 70 } };
  const state = build(base, plan, { assets: [cash], superAccounts: [supA, supB] });
  state.cashflows.superRollovers = [roll];
  const st = (await import("./helpers.mjs")).clampAllToPlan(state, PROFILES);
  console.log("start month", startMonth, "gift at", JSON.stringify(st.plan.gifts[0]?.at), "aged care entry", JSON.stringify(st.plan.agedCare[0]?.entryAt), "rollover at", JSON.stringify(st.cashflows.superRollovers[0]?.at));
  const out = runProjection(st);
  console.log(" errors", out.errors.length, out.yearly.map(r => `${r.fyLabel}: gifts ${r0(r.giftsPaid)} rad ${r0(r.agedCareRadPaid)} agedCareTotal ${r0(Object.values(r.agedCareDetail ?? {}).reduce((s, d) => s + d.total, 0))} rolloverOut ${r0(r.superDetail[supA.id].rolloverOut)}`).join("\n "));
  console.log(" warnings", [...out.superWarnings, ...out.agedCareWarnings].map(w => w.type + ": " + (w.reason ?? w.message)).slice(0, 4));
}
