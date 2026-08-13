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

// impliedFrankingPct is now the ONLY source of a profile's franking
// (Derive franking from class weights commit) — PROFILES no longer
// carries a stored frankingPct to compare against. PREVIOUSLY_STATED
// is the number that field used to hold, kept here purely as a
// historical record so this test can confirm the derived figure
// landed where the old placeholder already agreed, without implying
// there are still two independent figures to reconcile going forward.
// Hand calc for the one worked in profiles.js's comment: Balanced —
// 22.5% Aus equity × 4% = 0.9% of the 3.35% total income = 26.87%
// derived (1.87pp from the old 25% placeholder).
const PREVIOUSLY_STATED_FRANKING = {
  "Cash": 0, "Defensive": 0, "Moderately Defensive": 15, "Balanced": 25, "Moderate Growth": 30,
  "High Growth – Income": 50, "High Growth – Capital": 30,
  "Accelerated Growth – Income": 60, "Accelerated Growth – Growth": 35,
  "Residential Property": 0,
};

describe("impliedFrankingPct — franking derived from class weights", () => {
  const derived = (name) => impliedFrankingPct(PROFILES[name].classWeights, PROFILES[name].incomeReturn);

  it("Balanced reproduces the ~27% derived franking worked example", () => {
    expect(derived("Balanced")).toBeCloseTo(26.865671641791046, 6);
  });

  // Only 5 of the 10 profiles land within 3pp of the old placeholder —
  // Cash, Moderately Defensive, Balanced, Moderate Growth, Residential
  // Property. Defensive (+7.7pp), High Growth – Income (-8.4pp) and
  // High Growth – Capital (+10.8pp) sit further out than that but
  // still inside the old 15pp flag threshold — they're not part of
  // this "already agreed" group, but they're also not the CMA-flagged
  // pair below. Listed explicitly rather than asserted as a blanket
  // "within 3pp for everyone but the flagged two", since that blanket
  // claim isn't actually true of these three.
  const CLOSELY_AGREED = ["Cash", "Moderately Defensive", "Balanced", "Moderate Growth", "Residential Property"];
  it("the closely-agreed profiles' derived franking is within 3pp of the old placeholder", () => {
    for (const name of CLOSELY_AGREED) {
      const gap = Math.abs(derived(name) - PREVIOUSLY_STATED_FRANKING[name]);
      expect(gap, name).toBeLessThanOrEqual(3);
    }
  });

  it("Defensive and the two High Growth variants agreed with the old placeholder within the old 15pp tolerance, but not within 3pp", () => {
    for (const name of ["Defensive", "High Growth – Income", "High Growth – Capital"]) {
      const gap = Math.abs(derived(name) - PREVIOUSLY_STATED_FRANKING[name]);
      expect(gap, name).toBeGreaterThan(3);
      expect(gap, name).toBeLessThanOrEqual(15);
    }
  });

  // CMA REVIEW: these two aren't a franking problem any more (franking
  // is derived, so it can't disagree with itself) — they're a return-
  // SPLIT problem. See profiles.js's "RESIDUAL CMA QUESTION" comment:
  // each profile's own class weights, at the same yield assumptions
  // used to derive franking, imply a total income return well away
  // from the profile's stated incomeReturn (Accelerated Growth –
  // Growth: ~2.85% implied vs 2.00% stated; Accelerated Growth –
  // Income: ~3.34% implied vs 5.00% stated). Asserted here at their
  // exact derived franking figures, unchanged from before this commit
  // (the weights were not adjusted), so this stays the anchor for that
  // open question.
  it("Accelerated Growth – Income derives to ~43.1% franking (60% under the old placeholder) — flagged for CMA review of its return split, not adjusted", () => {
    expect(derived("Accelerated Growth – Income")).toBeCloseTo(43.12, 1);
  });

  it("Accelerated Growth – Growth derives to ~58.8% franking (35% under the old placeholder) — flagged for CMA review of its return split, not adjusted", () => {
    expect(derived("Accelerated Growth – Growth")).toBeCloseTo(58.8, 1);
  });

  it("Cash and Residential Property have zero Australian equity, so zero derived franking", () => {
    for (const name of ["Cash", "Residential Property"]) {
      expect(derived(name)).toBe(0);
    }
  });
});
