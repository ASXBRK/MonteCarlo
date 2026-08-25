import { describe, it, expect } from "vitest";
import { MIN_DRAWDOWN_BANDS, minDrawdownPct, minDrawdownAmount, TTR_MAX_DRAWDOWN_PCT } from "./pensionRates.js";

describe("Minimum drawdown factors (spec 20, Commit 2) — FY2026/27 age bands", () => {
  it("each band's own boundary — under 65: 4%, 65-74: 5%, 75-79: 6%, 80-84: 7%, 85-89: 9%, 90-94: 11%, 95+: 14%", () => {
    expect(minDrawdownPct(0)).toBeCloseTo(0.04, 6);
    expect(minDrawdownPct(64)).toBeCloseTo(0.04, 6);
    expect(minDrawdownPct(65)).toBeCloseTo(0.05, 6);
    expect(minDrawdownPct(74)).toBeCloseTo(0.05, 6);
    expect(minDrawdownPct(75)).toBeCloseTo(0.06, 6);
    expect(minDrawdownPct(79)).toBeCloseTo(0.06, 6);
    expect(minDrawdownPct(80)).toBeCloseTo(0.07, 6);
    expect(minDrawdownPct(84)).toBeCloseTo(0.07, 6);
    expect(minDrawdownPct(85)).toBeCloseTo(0.09, 6);
    expect(minDrawdownPct(89)).toBeCloseTo(0.09, 6);
    expect(minDrawdownPct(90)).toBeCloseTo(0.11, 6);
    expect(minDrawdownPct(94)).toBeCloseTo(0.11, 6);
    expect(minDrawdownPct(95)).toBeCloseTo(0.14, 6);
    expect(minDrawdownPct(110)).toBeCloseTo(0.14, 6); // no upper bound
  });

  it("MIN_DRAWDOWN_BANDS covers every age with no gaps and no overlaps", () => {
    for (let age = 0; age <= 110; age++) {
      const matches = MIN_DRAWDOWN_BANDS.filter((b) => age >= b.minAge && age <= b.maxAge);
      expect(matches.length).toBe(1);
    }
  });

  it("minDrawdownAmount applies the age band's percentage to the opening balance, full year (12/12) by default", () => {
    expect(minDrawdownAmount(100000, 70)).toBeCloseTo(5000, 2); // 5% band
    expect(minDrawdownAmount(200000, 96)).toBeCloseTo(28000, 2); // 14% band
  });

  it("pro-rates to whole months remaining in the FY — the ATO's own day-count rule, applied at month granularity", () => {
    // 6 of 12 months remaining: half the annual minimum.
    expect(minDrawdownAmount(120000, 63, 6)).toBeCloseTo(120000 * 0.04 * 0.5, 2);
    // 3 of 12 months remaining.
    expect(minDrawdownAmount(120000, 70, 3)).toBeCloseTo(120000 * 0.05 * 0.25, 2);
    // More than 12 months remaining is clamped to a full year, not
    // scaled up past 100%.
    expect(minDrawdownAmount(120000, 63, 15)).toBeCloseTo(minDrawdownAmount(120000, 63, 12), 6);
  });

  it("no minimum at all when commenced with zero (or negative) whole months remaining in the FY — the 1-30 June exception", () => {
    expect(minDrawdownAmount(120000, 63, 0)).toBe(0);
    expect(minDrawdownAmount(120000, 63, -1)).toBe(0);
  });

  it("TTR maximum is a flat 10% of the balance, independent of age", () => {
    expect(TTR_MAX_DRAWDOWN_PCT).toBeCloseTo(0.10, 6);
  });
});
