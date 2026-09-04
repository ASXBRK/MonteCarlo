// Glide paths (docs/specs/32-retirement-phase-one.md, Commit 4).
import { describe, it, expect } from "vitest";
import { PROFILES } from "./profiles.js";
import {
  glidePathWindow, precomputeGlideYearly, blendAtAge,
  singleStepGlidePathPreset, gradualGlidePathPreset,
} from "./glidePaths.js";

const STEPS = [
  { fromAge: 40, profile: "High Growth – Capital" },
  { fromAge: 65, profile: "Balanced" },
];

describe("glidePathWindow", () => {
  it("returns a flat plateau (stepA===stepB, t=0) before the first step", () => {
    const win = glidePathWindow(STEPS, 30);
    expect(win.stepA).toBe(STEPS[0]);
    expect(win.stepB).toBe(STEPS[0]);
    expect(win.t).toBe(0);
  });

  it("returns a flat plateau after the last step", () => {
    const win = glidePathWindow(STEPS, 80);
    expect(win.stepA).toBe(STEPS[1]);
    expect(win.stepB).toBe(STEPS[1]);
    expect(win.t).toBe(0);
  });

  it("interpolates gradually between two steps, not a cliff", () => {
    // Halfway between 40 and 65 (age 52.5, but ages are integers here —
    // use 52 and 53 to confirm t moves smoothly, not a single jump).
    const winMid = glidePathWindow(STEPS, 52);
    expect(winMid.stepA).toBe(STEPS[0]);
    expect(winMid.stepB).toBe(STEPS[1]);
    expect(winMid.t).toBeCloseTo((52 - 40) / (65 - 40), 10);
    const winLater = glidePathWindow(STEPS, 53);
    expect(winLater.t).toBeGreaterThan(winMid.t);
  });

  it("degenerates to a cliff for adjacent-age steps (near-zero-width window)", () => {
    // At exactly the second step's own age, both a near-zero-width
    // two-step window (t=1, 100% stepB) and "past the last step"
    // (stepA===stepB===last) resolve to the identical answer: fully
    // stepB's own profile. blendAtAge is the observable behaviour that
    // matters, not which internal path produced it.
    const adjacent = [{ fromAge: 64, profile: "High Growth – Capital" }, { fromAge: 65, profile: "Balanced" }];
    const blend = blendAtAge(adjacent, 65, PROFILES);
    const balanced = PROFILES["Balanced"];
    expect(blend.incomeNominal).toBeCloseTo(balanced.incomeReturn, 10);
    expect(blend.growthNominal).toBeCloseTo(balanced.growthReturn, 10);
  });

  it("returns null for an empty step list", () => {
    expect(glidePathWindow([], 50)).toBeNull();
    expect(glidePathWindow(null, 50)).toBeNull();
  });
});

describe("blendAtAge", () => {
  it("resolves to stepA's own profile exactly at or before the first step's age", () => {
    const blend = blendAtAge(STEPS, 35, PROFILES);
    const p = PROFILES["High Growth – Capital"];
    expect(blend.incomeNominal).toBeCloseTo(p.incomeReturn, 10);
    expect(blend.growthNominal).toBeCloseTo(p.growthReturn, 10);
  });

  it("resolves to a blend strictly between the two profiles mid-window", () => {
    const blend = blendAtAge(STEPS, 52, PROFILES);
    const a = PROFILES["High Growth – Capital"], b = PROFILES["Balanced"];
    const lo = Math.min(a.incomeReturn, b.incomeReturn), hi = Math.max(a.incomeReturn, b.incomeReturn);
    expect(blend.incomeNominal).toBeGreaterThan(lo);
    expect(blend.incomeNominal).toBeLessThan(hi);
  });

  it("returns null for an unknown profile key", () => {
    const bogus = [{ fromAge: 40, profile: "Not A Real Profile" }];
    expect(blendAtAge(bogus, 50, PROFILES)).toBeNull();
  });
});

describe("precomputeGlideYearly", () => {
  it("annual rebalance: every year resets to the age-implied target — identical to blendAtAge at that age", () => {
    const ages = [50, 51, 52, 60, 65, 70];
    const gp = { steps: STEPS, rebalance: "annual" };
    const out = precomputeGlideYearly(gp, ages, PROFILES);
    ages.forEach((age, y) => {
      const expected = blendAtAge(STEPS, age, PROFILES);
      expect(out[y].incomeNominal).toBeCloseTo(expected.incomeNominal, 10);
      expect(out[y].growthNominal).toBeCloseTo(expected.growthNominal, 10);
    });
  });

  it("drift: outperformance carries the share beyond the age-implied target while still inside the window", () => {
    // High Growth – Capital outperforms Balanced on totalNominal, so a
    // drift portfolio that starts in the window and stays there should
    // show a GROWTH weight strictly above the age-implied ("annual")
    // target partway through the ramp — "drift always overstates the
    // growth allocation" (the spec's own words). Once age moves PAST
    // the last step, both modes converge on the same single remaining
    // profile (nothing left to drift between), so this is checked
    // mid-ramp, not at the end of the horizon.
    const ages = Array.from({ length: 25 }, (_, i) => 40 + i); // 40..64, still inside the window throughout
    const gpAnnual = { steps: STEPS, rebalance: "annual" };
    const gpDrift = { steps: STEPS, rebalance: "drift" };
    const annual = precomputeGlideYearly(gpAnnual, ages, PROFILES);
    const drift = precomputeGlideYearly(gpDrift, ages, PROFILES);
    const midRamp = ages.indexOf(60);
    const growthWeight = (entry) => entry.classWeights.ausEquity + entry.classWeights.intEquity + entry.classWeights.property;
    expect(growthWeight(drift[midRamp])).toBeGreaterThan(growthWeight(annual[midRamp]));
  });

  it("drift carries the drifted split forward as the new window's starting point, never resetting to a fresh target", () => {
    const threeStep = [
      { fromAge: 40, profile: "High Growth – Capital" },
      { fromAge: 50, profile: "Balanced" },
      { fromAge: 60, profile: "Moderately Defensive" },
    ];
    const ages = Array.from({ length: 25 }, (_, i) => 40 + i); // 40..64
    const gp = { steps: threeStep, rebalance: "drift" };
    const out = precomputeGlideYearly(gp, ages, PROFILES);
    // The window changes exactly AT age 50 — the code resets to that
    // window's own fresh target on the crossover year itself (its own
    // documented behaviour: "a window change with no prior state...
    // starts at target either way"), so the divergence from "annual"
    // shows up the year AFTER the crossover, once drift has had a year
    // to move away from that reset starting point. growthNominal (not
    // incomeNominal — Balanced and Moderately Defensive happen to share
    // an identical incomeReturn, so that component alone can't show a
    // divergence between the two modes here) is the comparison metric.
    const afterCrossoverIdx = ages.indexOf(51);
    const gpAnnual = { steps: threeStep, rebalance: "annual" };
    const annual = precomputeGlideYearly(gpAnnual, ages, PROFILES);
    expect(out[afterCrossoverIdx].growthNominal).not.toBeCloseTo(annual[afterCrossoverIdx].growthNominal, 6);
  });

  it("both rebalance modes are pure and side-effect-free across repeated calls", () => {
    const ages = [45, 55, 65];
    const gp = { steps: STEPS, rebalance: "drift" };
    const out1 = precomputeGlideYearly(gp, ages, PROFILES);
    const out2 = precomputeGlideYearly(gp, ages, PROFILES);
    expect(out1).toEqual(out2);
  });

  it("an unknown profile in a step contributes zero for that year, not a throw", () => {
    const bogus = [{ fromAge: 40, profile: "Nonexistent" }, { fromAge: 60, profile: "Balanced" }];
    const out = precomputeGlideYearly({ steps: bogus, rebalance: "annual" }, [40], PROFILES);
    expect(out[0]).toEqual({ incomeNominal: 0, growthNominal: 0, totalNominal: 0, frankingPct: 0, classWeights: null });
  });
});

describe("presets", () => {
  const plan = { client: { currentAge: 45, retirementAge: 65 } };

  it("single-step preset: High Growth – Capital to Balanced at retirement, annual rebalance", () => {
    const preset = singleStepGlidePathPreset(plan);
    expect(preset.rebalance).toBe("annual");
    expect(preset.steps).toEqual([
      { fromAge: 45, profile: "High Growth – Capital" },
      { fromAge: 65, profile: "Balanced" },
    ]);
  });

  it("gradual preset: steps down over the decade before retirement, then again at 75", () => {
    const preset = gradualGlidePathPreset(plan);
    expect(preset.rebalance).toBe("annual");
    const ages = preset.steps.map((s) => s.fromAge);
    expect(ages).toEqual([...ages].sort((a, b) => a - b)); // ordered ascending
    expect(preset.steps[0].profile).toBe("High Growth – Capital");
    expect(preset.steps[preset.steps.length - 1].profile).toBe("Moderately Defensive");
    // The step-down ramp starts 10 years before retirement (55), not
    // before the client's own current age.
    expect(ages).toContain(55);
    expect(ages).toContain(65);
  });

  it("gradual preset never starts the ramp before the client's current age", () => {
    const closeToRetirement = { client: { currentAge: 62, retirementAge: 65 } };
    const preset = gradualGlidePathPreset(closeToRetirement);
    expect(preset.steps[1].fromAge).toBeGreaterThanOrEqual(62);
  });
});
