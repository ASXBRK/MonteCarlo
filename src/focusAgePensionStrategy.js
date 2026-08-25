// Focus: Age pension strategy (spec 21b, Commit 5) — pure, no DOM/
// Plotly. Every arm comes from a REAL projectPlan() run on a mutated
// clone of the actual plan — never a hand-derived estimate — the same
// "clone, mutate, re-run, zip" pattern focusSalarySacrifice.js already
// uses for its own with/without comparison.
//
// Non-prescriptive (spec's own words): this module reports entitlement
// AND the real wealth position (netAssets) for every arm, side by
// side, and picks no winner — gifting increases entitlement by
// REDUCING actual wealth (the gift itself is a real leak, spec 21b
// Commit 2's own words), so a naive "entitlement went up" reading would
// be actively misleading without the wealth figure sitting right next
// to it. The caller (main.js) must never render one arm as "better".
import { projectPlan } from "./deterministic.js";

// Whether the plan has anyone reaching age pension age at all within
// the projection — the same gate renderFocusAgePensionView's own
// agePensionFocusEligible() already applies to the existing charts;
// this view has nothing to compare without it.
export function agePensionStrategyEligible(out) {
  return (out?.yearly ?? []).some((row) =>
    row.agePensionDetail?.client?.ageEligible || row.agePensionDetail?.partner?.ageEligible);
}

// buildAgePensionStrategyFocus({ state, giftAmount, workIncomeLevels })
// → { arms: [{id,label}], byYear: [{year, fyLabel, age, [armId]: {entitlement, netAssets}}] }
// or null if nobody in the household ever reaches age pension age.
//
// Arms:
//  - "current": the plan exactly as it stands — no mutation.
//  - "gift": ONE illustrative gift (spec 21b Commit 2's own $10,000/yr
//    allowable amount by default), fired at the first FY the household
//    reaches age pension age — only added if that FY exists.
//  - "work{level}": an illustrative flat CLIENT employment income at
//    each requested level, running from the plan's own start through
//    its end, so the Work Bonus's exempt amount and income-bank
//    mechanics show up in the entitlement/wealth trajectory exactly as
//    the real engine computes them — never re-derived by hand.
export function buildAgePensionStrategyFocus({ state, giftAmount = 10000, workIncomeLevels = [10000, 20000] }) {
  const baseOut = projectPlan(state);
  if (!agePensionStrategyEligible(baseOut)) return null;

  const arms = [{ id: "current", label: "Current plan", out: baseOut }];

  const firstEligibleY = baseOut.yearly.findIndex((row) =>
    row.agePensionDetail?.client?.ageEligible || row.agePensionDetail?.partner?.ageEligible);
  if (firstEligibleY >= 0) {
    const giftState = structuredClone(state);
    const giftAge = state.plan.client.currentAge + firstEligibleY;
    giftState.plan.gifts = [
      ...(giftState.plan.gifts ?? []),
      { id: "focus-strategy-gift", owner: "client", amount: giftAmount, at: { kind: "age", age: giftAge }, label: "Illustrative gift" },
    ];
    arms.push({ id: "gift", label: `With a $${giftAmount.toLocaleString()} gift`, out: projectPlan(giftState) });
  }

  for (const level of workIncomeLevels) {
    if (level <= 0) continue;
    const workState = structuredClone(state);
    workState.cashflows.income = [
      ...(workState.cashflows.income ?? []),
      {
        id: `focus-strategy-work-${level}`, label: "Illustrative employment income", owner: "client",
        amount: level, frequency: "annual", incomeType: "employment", sgApplies: false,
        from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
        indexBasis: "cpi", indexExtraPct: 0,
      },
    ];
    arms.push({ id: `work${level}`, label: `Working $${level.toLocaleString()}/yr`, out: projectPlan(workState) });
  }

  const years = baseOut.yearly.length;
  const byYear = [];
  for (let y = 0; y < years; y++) {
    const point = { year: y, fyLabel: baseOut.schedule.fyLabels[y], age: baseOut.schedule.clientAges[y] };
    for (const arm of arms) {
      const row = arm.out.yearly[y];
      point[arm.id] = { entitlement: row.agePensionDetail?.entitlement ?? 0, netAssets: row.netAssets };
    }
    byYear.push(point);
  }

  return { arms: arms.map((a) => ({ id: a.id, label: a.label })), byYear };
}
