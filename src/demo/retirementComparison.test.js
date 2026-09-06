// Tests for the retirement comparison fixture (docs/specs/33-
// retirement-standalone.md, Commit 4). Two things the spec asks for
// directly: "the fixture projects cleanly and the conservation
// invariant holds; the documented figures match a live run." The
// figures asserted below are EXACTLY docs/reference/retirement-
// comparison.md's own "Our figure" column — if this test ever fails
// after a genuine engine change, that document is the other half of
// what needs updating, not just this file.
import { describe, it, expect } from "vitest";
import { build, RETIREMENT_COMPARISON_NOW } from "./retirementComparison.js";
import { PROFILES } from "../profiles.js";
import { projectPlan } from "../deterministic.js";
import { computeRetirementAnalytics } from "../retirementAnalytics.js";
import { checkYearConservation } from "../conservationCheck.js";

describe("retirementComparison fixture", () => {
  it("projects cleanly — 39 years, no error, no unfunded shortfall anywhere in the projection", () => {
    const state = build().scenarios[0].state;
    const out = projectPlan(state, PROFILES);
    expect(out.yearly.length).toBe(39);
    expect(out.shortfall).toBeNull();
  });

  it("the conservation invariant holds for every year (except the final year's own accrued-CGT boundary, per this codebase's own convention)", () => {
    const state = build().scenarios[0].state;
    const out = projectPlan(state, PROFILES);
    for (let y = 0; y < out.yearly.length - 1; y++) {
      checkYearConservation(out, y, `retirementComparison fixture, year ${y}`);
    }
  });

  it("uses a fixed reference date so the client's age (and every downstream figure) never drifts across future runs", () => {
    const state = build().scenarios[0].state;
    expect(state.plan.client.currentAge).toBe(45);
    expect(state.plan.start).toEqual({ year: 2026, month: 7 }); // July — see the module's own header on why
    // build()'s own default IS RETIREMENT_COMPARISON_NOW, not "new Date()".
    expect(RETIREMENT_COMPARISON_NOW.getUTCFullYear()).toBe(2026);
  });

  it("every named effect actually fires — tax, age pension, and drawdown all bite, not just nominally present", () => {
    const state = build().scenarios[0].state;
    const out = projectPlan(state, PROFILES);
    // Tax bites during the working years.
    expect(out.yearly[0].tax).toBeGreaterThan(15000);
    // The pension actually draws down from commencement to exhaustion
    // within the projection (not sitting untouched, and not lasting
    // forever either — a real drawdown story).
    const retirementYear = 20; // age 65, see the analytics assertion below
    let commencedPension = 0;
    for (const id of Object.keys(out.yearly[retirementYear].pensionDetail ?? {})) {
      commencedPension += out.yearly[retirementYear].pensionDetail[id]?.closing ?? 0;
    }
    expect(commencedPension).toBeGreaterThan(400000);
    const lastYear = out.yearly[out.yearly.length - 1];
    let finalPension = 0;
    for (const id of Object.keys(lastYear.pensionDetail ?? {})) finalPension += lastYear.pensionDetail[id]?.closing ?? 0;
    expect(finalPension).toBe(0); // exhausted well before the projection ends
    // The age pension supplies a material share of retirement income —
    // not a token amount, and not the whole of it either.
    const a = computeRetirementAnalytics(state, out);
    expect(a.le.averageAgePensionPctOfIncome).toBeGreaterThan(20);
    expect(a.le.averageAgePensionPctOfIncome).toBeLessThan(80);
  });

  // The documented figures (docs/reference/retirement-comparison.md's
  // own "Our figure" column) — asserted to 2 decimal places via
  // toBeCloseTo so a genuinely tiny floating-point difference doesn't
  // fail this test, while any real engine-behaviour change still would.
  it("matches the figures documented in docs/reference/retirement-comparison.md exactly", () => {
    const state = build().scenarios[0].state;
    const out = projectPlan(state, PROFILES);
    const a = computeRetirementAnalytics(state, out);

    expect(a.retirement.age).toBe(65);
    expect(a.retirement.planYear).toBe(20);
    expect(a.capitalAtRetirement).toBeCloseTo(996421.62, 2);
    expect(a.firstShortfallAge).toBeNull();
    expect(a.superPensionExhaustionAge).toBeNull(); // combined super+pension never both hit zero — see this module's own header
    expect(a.le.age).toBe(83);
    expect(a.le.capitalAtLE).toBeCloseTo(674161.96, 2);
    expect(a.le.averageRetirementIncome).toBeCloseTo(54345.93, 2);
    expect(a.le.averageAgePension).toBeCloseTo(19858.81, 2);
    expect(a.le.averageAgePensionPctOfIncome).toBeCloseTo(35.94, 2);
    expect(a.le.sustainableIncomeConverged).toBe(true);
    expect(a.le.sustainableIncomeToLE).toBeCloseTo(41306.03, 2);
    expect(a.materialLEDifference).toBe(false);
  });
});
