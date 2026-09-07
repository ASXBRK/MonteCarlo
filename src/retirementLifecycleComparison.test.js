import { describe, it, expect } from "vitest";
import {
  resolveComparisonGlidePath, resolveComparisonStaticProfile, buildLifecycleComparison,
} from "./retirementLifecycleComparison.js";
import {
  defaultState, clampAllToPlan, createGlidePath, clampGlidePath, createSuperAccount, createIncomeRow,
} from "./planState.js";
import { PROFILES } from "./profiles.js";

const NOW = new Date("2026-08-17T00:00:00+10:00");

function baseState() {
  return defaultState(PROFILES, NOW);
}

function withPersonPatch(state, owner, patch) {
  const key = owner === "partner" ? "partner" : "client";
  return { ...state, plan: { ...state.plan, [key]: { ...state.plan[key], ...patch } } };
}

// A client with a super account, salary, and a reasonable balance —
// the minimum a lifecycle comparison needs to have something to grow.
// Built via the SAME planState.js factories the comprehensive
// workspace's own "+ Add..." buttons call (retirementStandalone.js,
// which used to wrap these for a single-page form, was withdrawn by
// docs/specs/35-retirement-output-view.md — this test now builds the
// fixture directly, matching the rest of this codebase's own test
// convention, e.g. retirementAnalytics.test.js).
function clientWithSuper(state = baseState()) {
  let s = withPersonPatch(state, "client", { dob: "1980-05-01", retirementAge: 65 });
  s = clampAllToPlan(s, PROFILES); // resolve currentAge from dob before any factory reads it
  const sa = { ...createSuperAccount(s.plan, [], PROFILES, "client"), balance: 100000 };
  s = { ...s, plan: { ...s.plan, superAccounts: [sa] } };
  const income = { ...createIncomeRow(s.plan, []), amount: 90000 };
  s = { ...s, cashflows: { ...s.cashflows, income: [income] } };
  return clampAllToPlan(s, PROFILES);
}

describe("resolveComparisonGlidePath", () => {
  it("falls back to a generated single-step preset when the plan has no glide path defined", () => {
    const state = clientWithSuper();
    expect(state.plan.glidePaths ?? []).toHaveLength(0);
    const { glidePath, isPreset } = resolveComparisonGlidePath(state, "client", PROFILES);
    expect(isPreset).toBe(true);
    expect(glidePath.steps.length).toBeGreaterThan(0);
    expect(glidePath.steps[0].fromAge).toBe(state.plan.client.currentAge);
    expect(glidePath.steps.at(-1).fromAge).toBe(state.plan.client.retirementAge);
  });

  it("uses the plan's own first glide path when one already exists, rather than the preset", () => {
    let state = clientWithSuper();
    const gp = clampGlidePath(createGlidePath(state.plan, [], PROFILES), state.plan, PROFILES);
    state = { ...state, plan: { ...state.plan, glidePaths: [gp] } };
    const { glidePath, isPreset } = resolveComparisonGlidePath(state, "client", PROFILES);
    expect(isPreset).toBe(false);
    expect(glidePath.id).toBe(gp.id);
  });
});

describe("resolveComparisonStaticProfile", () => {
  it("uses the person's own current profile when already static", () => {
    const state = clientWithSuper();
    // createSuperAccount's own middle-profile default (setSuperBalance
    // creates the account via ensurePersonSuperAccount).
    const sa = state.plan.superAccounts.find((s) => s.owner === "client");
    expect(sa.allocation.mode).toBe("profile");
    expect(resolveComparisonStaticProfile(state, "client", PROFILES)).toBe(sa.allocation.profile);
  });

  it("falls back to Balanced when the person's own allocation is a glide path", () => {
    let state = clientWithSuper();
    state = {
      ...state,
      plan: {
        ...state.plan,
        superAccounts: state.plan.superAccounts.map((s) =>
          (s.owner === "client" ? { ...s, allocation: { mode: "glidePath", glidePathId: "gp-x" } } : s)),
      },
    };
    expect(resolveComparisonStaticProfile(state, "client", PROFILES)).toBe("Balanced");
  });
});

describe("buildLifecycleComparison", () => {
  it("returns null when the owner has no super account at all", () => {
    expect(buildLifecycleComparison(baseState(), "client", PROFILES)).toBeNull();
  });

  it("runs both arms through the real projectPlan on independent clones — same starting facts, only the allocation differs", () => {
    const state = clientWithSuper();
    const result = buildLifecycleComparison(state, "client", PROFILES);
    expect(result).not.toBeNull();
    expect(result.glideState.plan.superAccounts.find((s) => s.owner === "client").allocation.mode).toBe("glidePath");
    expect(result.staticState.plan.superAccounts.find((s) => s.owner === "client").allocation.mode).toBe("profile");
    // Everything else about the clone is untouched.
    expect(result.glideState.plan.client.dob).toBe(state.plan.client.dob);
    expect(result.staticState.plan.client.dob).toBe(state.plan.client.dob);
    expect(result.glideState.cashflows.income).toEqual(state.cashflows.income);
    // Both projections actually ran (non-trivial output, not a stub).
    expect(result.glideProjection.yearly.length).toBeGreaterThan(0);
    expect(result.staticProjection.yearly.length).toBe(result.glideProjection.yearly.length);
    // Capital at retirement and at LE are reported, with a computed diff.
    expect(result.capitalAtRetirement).not.toBeNull();
    expect(result.capitalAtRetirement.diff).toBeCloseTo(result.capitalAtRetirement.glide - result.capitalAtRetirement.static, 2);
    expect(result.capitalAtLE.diff).toBeCloseTo(result.capitalAtLE.glide - result.capitalAtLE.static, 2);
    expect(result.capitalAtLE.age).toBe(result.glideProjection.schedule.clientAges.at(-1));
  });

  it("uses the OWNER's own retirement age for the generated preset's end step in a couple, not the client's", () => {
    let state = clientWithSuper();
    state = { ...state, plan: { ...state.plan, household: "married", partner: { currentAge: state.plan.client.currentAge } } };
    state = withPersonPatch(state, "partner", { dob: "1985-01-01", retirementAge: 60 });
    state = clampAllToPlan(state, PROFILES);
    const partnerSa = { ...createSuperAccount(state.plan, state.plan.superAccounts, PROFILES, "partner"), balance: 50000 };
    state = { ...state, plan: { ...state.plan, superAccounts: [...state.plan.superAccounts, partnerSa] } };
    state = clampAllToPlan(state, PROFILES);
    const result = buildLifecycleComparison(state, "partner", PROFILES);
    expect(result).not.toBeNull();
    const gp = result.glideState.plan.glidePaths.find(
      (g) => g.id === result.glideState.plan.superAccounts.find((s) => s.owner === "partner").allocation.glidePathId
    );
    // The end step is genuinely the partner's own retirement age (60,
    // younger than the client's 65) — proves this isn't just reusing
    // the client's own preset wholesale.
    expect(gp.steps.at(-1).fromAge).toBe(60);
    // The START step, however, clamps to plan.client.currentAge (46) —
    // clampGlidePath (planState.js) floors EVERY glide path's steps at
    // the client's own current age, because glide paths are a single
    // plan-level list (plan.glidePaths), not owner-scoped, the same
    // constraint the comprehensive workspace's own Settings panel
    // already lives with for every glide path on the plan. Not a defect
    // introduced here — asserting the real, pre-existing behaviour
    // rather than one this comparison can't actually produce.
    expect(gp.steps[0].fromAge).toBe(state.plan.client.currentAge);
    expect(state.plan.partner.currentAge).toBeLessThan(state.plan.client.currentAge);
  });

  it("capitalAtRetirement is reported for a normal in-range retirement age", () => {
    const state = clientWithSuper();
    const result = buildLifecycleComparison(state, "client", PROFILES);
    expect(result.capitalAtRetirement).not.toBeNull();
    expect(result.capitalAtLE).not.toBeNull();
  });
});
