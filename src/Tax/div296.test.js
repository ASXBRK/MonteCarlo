import { describe, it, expect } from "vitest";
import { div296Tax } from "./div296.js";

// Source figures: two widely-published Government worked examples for
// the October 2025 revised (two-tier) Division 296 design.
describe("div296Tax — Government worked examples reproduced exactly", () => {
  it("single-tier example: $4m TSB, $200,000 realised earnings → $7,500 tax", () => {
    // Sarah: TSB $4m at 30 June 2026 (both opening and closing, for this
    // example), fund earns $200,000. Proportion above $3m = ($4m−$3m)/
    // $4m = 25%. Tax = 15% × 25% × $200,000 = $7,500.
    const r = div296Tax({
      openingTsb: 4_000_000, closingTsb: 4_000_000, earnings: 200_000,
      lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    });
    expect(r.proportionAboveLower).toBeCloseTo(0.25, 6);
    expect(r.proportionAboveUpper).toBe(0); // below the upper threshold — second tier inert
    expect(r.tax).toBeCloseTo(7500, 2);
  });

  it("two-tier example: $12m TSB, $960,000 realised earnings → $124,000 tax", () => {
    // PB1 = ($12m−$3m)/$12m = 75.0%; PB2 = ($12m−$10m)/$12m = 16.667%.
    // Tax = 15% × 75.0% × $960,000 + 10% × 16.667% × $960,000
    //     = $108,000 + $16,000 = $124,000.
    const r = div296Tax({
      openingTsb: 12_000_000, closingTsb: 12_000_000, earnings: 960_000,
      lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    });
    expect(r.proportionAboveLower).toBeCloseTo(0.75, 6);
    expect(r.proportionAboveUpper).toBeCloseTo(2 / 12, 6);
    expect(r.tax).toBeCloseTo(124_000, 6);
  });
});

describe("div296Tax — two-tier boundary at $10m", () => {
  it("exactly at $10m, the upper tier contributes nothing (proportion is 0)", () => {
    const r = div296Tax({
      openingTsb: 10_000_000, closingTsb: 10_000_000, earnings: 500_000,
      lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    });
    expect(r.proportionAboveUpper).toBe(0);
    // Only the 15% lower-tier term applies: (10m−3m)/10m × 15% × earnings.
    expect(r.tax).toBeCloseTo(0.15 * 0.7 * 500_000, 2);
  });

  it("$1 above $10m, the upper tier contributes a nonzero (small) extra amount", () => {
    const below = div296Tax({
      openingTsb: 10_000_000, closingTsb: 10_000_000, earnings: 500_000,
      lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    });
    const above = div296Tax({
      openingTsb: 10_000_001, closingTsb: 10_000_001, earnings: 500_000,
      lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    });
    expect(above.tax).toBeGreaterThan(below.tax);
  });
});

describe("div296Tax — TSB for the proportions is the HIGHER of opening/closing", () => {
  it("a balance that fell during the year still uses the higher (opening) figure", () => {
    const r = div296Tax({
      openingTsb: 12_000_000, closingTsb: 8_000_000, earnings: 100_000,
      lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    });
    expect(r.tsb).toBe(12_000_000);
    expect(r.proportionAboveUpper).toBeGreaterThan(0); // only true because opening (12m) > 10m, not closing (8m)
  });

  it("a balance that rose during the year uses the higher (closing) figure", () => {
    const r = div296Tax({
      openingTsb: 2_000_000, closingTsb: 4_000_000, earnings: 100_000,
      lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    });
    expect(r.tsb).toBe(4_000_000);
    expect(r.tax).toBeGreaterThan(0); // in scope because closing (4m) exceeds the lower threshold
  });
});

describe("div296Tax — no Division 296 below the lower threshold", () => {
  it("TSB (higher of opening/closing) at or under $3m: zero tax regardless of earnings", () => {
    const atThreshold = div296Tax({
      openingTsb: 3_000_000, closingTsb: 2_900_000, earnings: 1_000_000,
      lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    });
    expect(atThreshold.tax).toBe(0);
    const under = div296Tax({
      openingTsb: 1_000_000, closingTsb: 2_000_000, earnings: 500_000,
      lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    });
    expect(under.tax).toBe(0);
  });

  it("a negative-earnings year pays zero, not a rebate, even when TSB is in scope", () => {
    const r = div296Tax({
      openingTsb: 5_000_000, closingTsb: 5_000_000, earnings: -200_000,
      lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    });
    expect(r.tax).toBe(0);
  });

  it("zero TSB never divides by zero", () => {
    expect(() => div296Tax({
      openingTsb: 0, closingTsb: 0, earnings: 0, lowerThreshold: 3_000_000, upperThreshold: 10_000_000,
    })).not.toThrow();
  });
});
