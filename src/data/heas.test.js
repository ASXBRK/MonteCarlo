import { describe, it, expect } from "vitest";
import { HEAS_BASE, heasEffectiveAnnualRate, heasAgeComponentPerTenK, heasMaxLoanAmount } from "./heas.js";

describe("HEAS_BASE — source-figure spot checks (spec 21b, Commit 5)", () => {
  it("carries the as-at date and source, and flags the age-component table as a disclosed approximation", () => {
    expect(HEAS_BASE.asAt).toBe("2026-03-20");
    expect(HEAS_BASE.source).toMatch(/Services Australia/);
    expect(HEAS_BASE.source).toMatch(/SPARSE/);
  });

  it("interest rate is 3.95% pa, compounding fortnightly (26/yr)", () => {
    expect(HEAS_BASE.interestRateAnnual).toBe(0.0395);
    expect(HEAS_BASE.fortnightsPerYear).toBe(26);
  });

  it("drawdown cap is 150% of the maximum pension rate", () => {
    expect(HEAS_BASE.drawdownCapPctOfMaxPension).toBe(1.5);
  });

  it("age of eligibility is 67, matching the age pension's own", () => {
    expect(HEAS_BASE.ageOfEligibility).toBe(67);
  });
});

describe("heasEffectiveAnnualRate — fortnightly compounding, hand-computed", () => {
  it("(1 + 0.0395/26)^26 - 1", () => {
    const expected = Math.pow(1 + 0.0395 / 26, 26) - 1;
    expect(heasEffectiveAnnualRate()).toBeCloseTo(expected, 10);
    // Slightly above the nominal rate — fortnightly compounding beats flat annual.
    expect(heasEffectiveAnnualRate()).toBeGreaterThan(0.0395);
    expect(heasEffectiveAnnualRate()).toBeLessThan(0.041);
  });
});

describe("heasAgeComponentPerTenK — anchors exact, interpolated between, flat beyond both ends", () => {
  it("returns the exact anchor value at each published anchor age", () => {
    expect(heasAgeComponentPerTenK(55)).toBe(1710);
    expect(heasAgeComponentPerTenK(65)).toBe(2530);
    expect(heasAgeComponentPerTenK(66)).toBe(2630);
    expect(heasAgeComponentPerTenK(69)).toBe(2960);
    expect(heasAgeComponentPerTenK(70)).toBe(3080);
    expect(heasAgeComponentPerTenK(84)).toBe(5330);
    expect(heasAgeComponentPerTenK(85)).toBe(5550);
    expect(heasAgeComponentPerTenK(90)).toBe(6750);
  });

  it("linearly interpolates between two anchors — hand-computed midpoint", () => {
    // Age 67.5, midway between 66 ($2,630) and 69 ($2,960) at t=0.5/3: not
    // a clean midpoint — use age 67, exactly 1/3 of the way from 66 to 69.
    const expected = 2630 + (1 / 3) * (2960 - 2630);
    expect(heasAgeComponentPerTenK(67)).toBeCloseTo(expected, 6);
  });

  it("holds flat below the youngest anchor and at/above the oldest", () => {
    expect(heasAgeComponentPerTenK(40)).toBe(1710);
    expect(heasAgeComponentPerTenK(95)).toBe(6750);
    expect(heasAgeComponentPerTenK(120)).toBe(6750);
  });

  it("is monotonically non-decreasing with age (older age never gets a smaller loan cap)", () => {
    for (let age = 40; age < 100; age++) {
      expect(heasAgeComponentPerTenK(age + 1)).toBeGreaterThanOrEqual(heasAgeComponentPerTenK(age));
    }
  });
});

describe("heasMaxLoanAmount — the published MLA formula", () => {
  it("rounds security value DOWN to the nearest $10,000 before applying the age component", () => {
    // $505,000 rounds down to $500,000 → 50 tens-of-thousands.
    const atRoundedValue = heasMaxLoanAmount(500000, 70);
    const atUnroundedValue = heasMaxLoanAmount(505000, 70);
    expect(atUnroundedValue).toBe(atRoundedValue);
    expect(atRoundedValue).toBeCloseTo(50 * 3080, 6);
  });

  it("known value: $700,000 security at age 85", () => {
    expect(heasMaxLoanAmount(700000, 85)).toBeCloseTo(70 * 5550, 6);
  });

  it("zero security value gives a zero cap", () => {
    expect(heasMaxLoanAmount(0, 70)).toBe(0);
  });
});
