// What if: Market crash timing (docs/specs/14-what-if.md, Commit 3) —
// pure, no DOM/Plotly. Runs the SAME crash (dropPct, recoveryYears) at
// three representative ages — early, mid-career, and near retirement —
// against the SAME base, via sequenceRisk.js's real engine crash
// injection. Identical magnitude, radically different outcome:
// sequence-of-returns risk made concrete, without a single random path
// in sight — this is the deterministic what-if; the Monte Carlo view
// models the same risk probabilistically (see the disclosure the view
// itself carries, linking the two).
import { resolveRef } from "./keyDates.js";
import { buildCrashMc, crashHoldings } from "./sequenceRisk.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";

export { crashHoldings as eligibleCrashHoldings };

// Three ages spread across the accumulation phase, clamped inside the
// plan's own window: 15% of the way from now to retirement ("early"),
// halfway ("mid-career"), and 10% short of retirement ("near
// retirement"). A short plan may collapse two of these to the same
// age — an honest reflection of a genuinely short horizon, not a bug.
export function representativeCrashAges(state, schedule) {
  const currentAge = state.plan.client.currentAge;
  const endAge = state.plan.endAge;
  const retirementAge = resolveRef({ kind: "anchor", anchorId: "retirement-client" }, state.plan, schedule, "client").age;
  const span = Math.max(2, retirementAge - currentAge);
  const clamp = (a) => Math.min(endAge - 1, Math.max(currentAge + 1, Math.round(a)));
  return [
    { label: "Early", age: clamp(currentAge + span * 0.15) },
    { label: "Mid-career", age: clamp(currentAge + span * 0.5) },
    { label: "Near retirement", age: clamp(retirementAge - span * 0.1) },
  ];
}

// buildCrashTimingView({ state, dropPct, recoveryYears }) → null when
// there's nothing a crash could act on (no growth-exposed holdings at
// all), else { base, ages: [{label, age, out, mc}] } — `out` is null
// for an age whose crash month can't be resolved (see buildCrashMc),
// so the view can show that age's line as "unavailable" rather than
// silently omitting it.
export function buildCrashTimingView({ state, dropPct, recoveryYears }) {
  if (crashHoldings(state).length === 0) return null;
  const base = projectPlan(state, PROFILES);
  const ages = representativeCrashAges(state, base.schedule);
  const runs = ages.map(({ label, age }) => {
    const mc = buildCrashMc(state, { dropPct, atAge: age, recoveryYears }, PROFILES);
    return { label, age, mc, out: mc ? projectPlan(state, PROFILES, mc) : null };
  });
  return { base, ages: runs };
}
