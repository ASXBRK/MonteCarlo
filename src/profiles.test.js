import { describe, it, expect } from "vitest";
import { PROFILES, ASSET_CLASS_KEYS, ASSET_CLASS_LABELS, impliedFrankingPct } from "./profiles.js";

// The growth/defensive ladder every profile's classWeights must be
// consistent with (Asset class allocations commit) — hand-specified,
// not derived, since this IS the source-of-truth the weights are
// checked against.
const GROWTH_LADDER = {
  "Cash": 0,
  "Defensive": 15,
  "Moderately Defensive": 30,
  "Balanced": 50,
  "Moderate Growth": 70,
  "High Growth – Income": 85,
  "High Growth – Capital": 85,
  "Accelerated Growth – Income": 98,
  "Accelerated Growth – Growth": 98,
  "Residential Property": 100,
};

describe("PROFILES.classWeights — asset class allocations (Commit: allocation-over-time chart)", () => {
  it("every profile's class weights sum to exactly 100%", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const total = ASSET_CLASS_KEYS.reduce((s, k) => s + profile.classWeights[k], 0);
      expect(total, name).toBeCloseTo(100, 9);
    }
  });

  it("every profile's growth/defensive subtotals match the growth/defensive ladder", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const w = profile.classWeights;
      const growthSubtotal = w.ausEquity + w.intEquity + w.property;
      const defensiveSubtotal = w.ausFixedInterest + w.intFixedInterest + w.cash;
      expect(growthSubtotal, name).toBeCloseTo(GROWTH_LADDER[name], 9);
      expect(defensiveSubtotal, name).toBeCloseTo(100 - GROWTH_LADDER[name], 9);
    }
  });

  it("Cash is 100% Cash outright (not the standard 50/25/25 defensive split)", () => {
    expect(PROFILES["Cash"].classWeights).toEqual({
      ausEquity: 0, intEquity: 0, property: 0, ausFixedInterest: 0, intFixedInterest: 0, cash: 100,
    });
  });

  it("Residential Property is 100% Property & infrastructure", () => {
    expect(PROFILES["Residential Property"].classWeights).toEqual({
      ausEquity: 0, intEquity: 0, property: 100, ausFixedInterest: 0, intFixedInterest: 0, cash: 0,
    });
  });

  it("Balanced: 50% growth × 45% Aus equity = 22.5% of portfolio (the worked example in profiles.js)", () => {
    expect(PROFILES["Balanced"].classWeights.ausEquity).toBeCloseTo(22.5, 9);
  });

  it("income variants tilt Australian (55/30/15); capital variants tilt international (30/55/15); neutral profiles split 45/40/15 — all within the growth sleeve", () => {
    // High Growth siblings (growthPct 85, sibling variants) isolate the
    // split itself from the growthPct scaling.
    const income = PROFILES["High Growth – Income"].classWeights;
    const capital = PROFILES["High Growth – Capital"].classWeights;
    expect(income.ausEquity / 85).toBeCloseTo(0.55, 9);
    expect(income.intEquity / 85).toBeCloseTo(0.30, 9);
    expect(income.property / 85).toBeCloseTo(0.15, 9);
    expect(capital.ausEquity / 85).toBeCloseTo(0.30, 9);
    expect(capital.intEquity / 85).toBeCloseTo(0.55, 9);
    expect(capital.property / 85).toBeCloseTo(0.15, 9);

    const neutral = PROFILES["Balanced"].classWeights; // growthPct 50
    expect(neutral.ausEquity / 50).toBeCloseTo(0.45, 9);
    expect(neutral.intEquity / 50).toBeCloseTo(0.40, 9);
    expect(neutral.property / 50).toBeCloseTo(0.15, 9);
  });

  it("the defensive sleeve always splits 50% Aus fixed interest / 25% international fixed interest / 25% cash (profiles other than Cash itself)", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      if (name === "Cash" || name === "Residential Property") continue;
      const w = profile.classWeights;
      const defensiveSubtotal = w.ausFixedInterest + w.intFixedInterest + w.cash;
      if (defensiveSubtotal === 0) continue; // Accelerated Growth variants: 2% defensive, still checked below by ratio
      expect(w.ausFixedInterest / defensiveSubtotal, name).toBeCloseTo(0.50, 9);
      expect(w.intFixedInterest / defensiveSubtotal, name).toBeCloseTo(0.25, 9);
      expect(w.cash / defensiveSubtotal, name).toBeCloseTo(0.25, 9);
    }
  });

  it("ASSET_CLASS_KEYS and ASSET_CLASS_LABELS cover the same six classes, one-to-one", () => {
    expect(ASSET_CLASS_KEYS.length).toBe(6);
    for (const k of ASSET_CLASS_KEYS) expect(ASSET_CLASS_LABELS[k]).toBeTruthy();
    expect(Object.keys(ASSET_CLASS_LABELS).length).toBe(ASSET_CLASS_KEYS.length);
  });
});

// Consistency check (profiles.js's header comment, reproduced here
// programmatically rather than by hand, so it can't drift from the
// weights it's meant to be checking): implied franking, from each
// profile's own class weights and the firm's 4%-fully-franked
// Australian-equity yield assumption, against the profile's stated
// frankingPct. Hand calc for the one worked in profiles.js's comment:
// Balanced — 22.5% Aus equity × 4% = 0.9% of the 3.35% total income =
// 26.87% implied vs 25% stated (1.87pp gap).
describe("impliedFrankingPct — implied-vs-stated franking consistency check", () => {
  const GAP_TOLERANCE = 15; // percentage points — profiles.js's brief: flag beyond this, don't paper over it

  it("Balanced reproduces the ~27% implied franking worked example", () => {
    const p = PROFILES["Balanced"];
    expect(impliedFrankingPct(p.classWeights, p.incomeReturn)).toBeCloseTo(26.865671641791046, 6);
  });

  it("every profile's implied franking is within 15pp of its stated frankingPct, EXCEPT the two flagged Accelerated Growth variants", () => {
    const FLAGGED = new Set(["Accelerated Growth – Income", "Accelerated Growth – Growth"]);
    for (const [name, profile] of Object.entries(PROFILES)) {
      const implied = impliedFrankingPct(profile.classWeights, profile.incomeReturn);
      const gap = Math.abs(implied - profile.frankingPct);
      if (FLAGGED.has(name)) {
        expect(gap, name).toBeGreaterThan(GAP_TOLERANCE);
      } else {
        expect(gap, name).toBeLessThanOrEqual(GAP_TOLERANCE);
      }
    }
  });

  it("Accelerated Growth – Income is under-franked relative to its stated figure by ~17pp (43.1% implied vs 60% stated)", () => {
    const p = PROFILES["Accelerated Growth – Income"];
    expect(impliedFrankingPct(p.classWeights, p.incomeReturn)).toBeCloseTo(43.12, 1);
  });

  it("Accelerated Growth – Growth is over-franked relative to its stated figure by ~24pp (58.8% implied vs 35% stated)", () => {
    const p = PROFILES["Accelerated Growth – Growth"];
    expect(impliedFrankingPct(p.classWeights, p.incomeReturn)).toBeCloseTo(58.8, 1);
  });

  it("Cash and Residential Property have zero Australian equity, so zero implied franking, matching their zero stated figure exactly", () => {
    for (const name of ["Cash", "Residential Property"]) {
      const p = PROFILES[name];
      expect(impliedFrankingPct(p.classWeights, p.incomeReturn)).toBe(0);
      expect(p.frankingPct).toBe(0);
    }
  });
});
