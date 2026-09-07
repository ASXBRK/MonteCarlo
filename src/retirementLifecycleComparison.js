// Retirement page — lifecycle vs static comparison (spec 34, Commit 3).
// Pure: clones plan state, forces ONE person's super account allocation
// to a glide path in one clone and to a fixed profile in the other,
// runs BOTH through the SAME projectPlan() the rest of the app uses,
// and reports the difference in capital at retirement and at life
// expectancy. No new engine work — this is a comparison harness over
// the existing engine and glide-path machinery (glidePaths.js,
// allocation.js). "The same client" — everything else about the clone
// (balance, salary, contributions, drawdown, the OTHER person in a
// couple) is untouched; only this one person's own super allocation
// differs between the two arms.

import { clampGlidePath } from "./planState.js";
import { projectPlan } from "./deterministic.js";
import { resolveRef } from "./keyDates.js";
import { glidePathPresetStepsFor } from "./glidePaths.js";

// The glide path this comparison uses: the FIRST glide path already on
// the plan (whatever the adviser has defined, per the spec's own "plus
// any the adviser has defined"), or — when none exists yet — the
// single-step preset (glidePaths.js's own per-owner generator — NOT
// singleStepGlidePathPreset directly, since that hardcodes plan.client's
// own ages and this comparison needs the OWNER's), generated fresh for
// this comparison only (added to a CLONE's own plan.glidePaths, never
// written back to the real plan: this is a what-if, not a commit).
export function resolveComparisonGlidePath(state, owner, profiles) {
  const existing = (state.plan.glidePaths ?? [])[0];
  if (existing) return { glidePath: existing, isPreset: false };
  const gp = clampGlidePath(glidePathPresetStepsFor("single", state.plan, owner), state.plan, profiles);
  return { glidePath: gp, isPreset: true };
}

// The static profile this comparison uses: the person's OWN current
// profile if their allocation is already static, else a neutral
// default ("Balanced" — the same mid-of-the-road fallback the
// retirement page's own allocation selector defaults a new account to).
export function resolveComparisonStaticProfile(state, owner, profiles, fallback = "Balanced") {
  const sa = (state.plan.superAccounts ?? []).find((s) => s.owner === owner);
  if (sa?.allocation?.mode === "profile" && profiles[sa.allocation.profile]) return sa.allocation.profile;
  return profiles[fallback] ? fallback : Object.keys(profiles)[0];
}

function withSuperAllocation(state, owner, allocation, extraGlidePath) {
  const superAccounts = (state.plan.superAccounts ?? []).map((sa) =>
    (sa.owner === owner ? { ...sa, allocation } : sa)
  );
  const glidePaths = extraGlidePath
    ? [...(state.plan.glidePaths ?? []).filter((g) => g.id !== extraGlidePath.id), extraGlidePath]
    : state.plan.glidePaths;
  return { ...state, plan: { ...state.plan, superAccounts, glidePaths } };
}

// buildLifecycleComparison(state, owner, profiles) →
//   { glideState, staticState, glideProjection, staticProjection,
//     glideLabel, staticLabel, glideIsPreset,
//     capitalAtRetirement: { glide, static, diff },
//     capitalAtLE: { glide, static, diff, age } }
// Both projections run through the SAME projectPlan() the rest of the
// app uses, on independent clones (the spec's own test requirement:
// "the comparison arms both run through projectPlan on clones") — never
// a second, differently-derived calculation. `capitalAtRetirement`/
// `capitalAtLE` read household netAssets (the same figure every other
// chart on this page reports), at the OWNER's own retirement anchor and
// at the projection's own final year (the LE-basis end already resolved
// by the plan itself) respectively.
export function buildLifecycleComparison(state, owner, profiles) {
  if (!(state.plan.superAccounts ?? []).some((sa) => sa.owner === owner)) return null;
  const { glidePath, isPreset } = resolveComparisonGlidePath(state, owner, profiles);
  const staticProfile = resolveComparisonStaticProfile(state, owner, profiles);

  const glideState = withSuperAllocation(state, owner, { mode: "glidePath", glidePathId: glidePath.id }, glidePath);
  const staticState = withSuperAllocation(state, owner, { mode: "profile", profile: staticProfile }, null);

  const glideProjection = projectPlan(glideState, profiles);
  const staticProjection = projectPlan(staticState, profiles);

  const anchorId = owner === "partner" ? "retirement-partner" : "retirement-client";
  const retirementRef = resolveRef({ kind: "anchor", anchorId }, state.plan, glideProjection.schedule, owner);
  const retirementY = retirementRef.outOfRange ? null : retirementRef.planYear;
  const leY = glideProjection.yearly.length - 1;

  const glideAtRetirement = retirementY != null ? (glideProjection.yearly[retirementY]?.netAssets ?? 0) : null;
  const staticAtRetirement = retirementY != null ? (staticProjection.yearly[retirementY]?.netAssets ?? 0) : null;
  const glideAtLE = glideProjection.yearly[leY]?.netAssets ?? 0;
  const staticAtLE = staticProjection.yearly[leY]?.netAssets ?? 0;

  return {
    glideState, staticState, glideProjection, staticProjection,
    glideLabel: glidePath.name, glideIsPreset: isPreset, staticLabel: staticProfile,
    capitalAtRetirement: retirementY == null ? null : {
      glide: glideAtRetirement, static: staticAtRetirement, diff: glideAtRetirement - staticAtRetirement,
    },
    capitalAtLE: {
      glide: glideAtLE, static: staticAtLE, diff: glideAtLE - staticAtLE,
      age: glideProjection.schedule.clientAges[leY],
    },
  };
}
