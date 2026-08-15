import { describe, it, expect } from "vitest";
import { MLS_RATES_BASE, mlsRatesFor, mlsSurchargeAmount } from "./mlsRates.js";

describe("Medicare Levy Surcharge rates — FY2026/27 base table", () => {
  it("singles: nil at/below $105,000", () => {
    expect(mlsSurchargeAmount({ ownIncome: 100000, comparisonIncome: 100000, hasCover: false })).toBe(0);
    expect(mlsSurchargeAmount({ ownIncome: 105000, comparisonIncome: 105000, hasCover: false })).toBe(0);
  });

  it("singles: 1.00% of the WHOLE income from $105,001, not the excess", () => {
    // hand calc: 120,000 × 1.00% = 1,200 — NOT (120000-105000)*0.01=150
    expect(mlsSurchargeAmount({ ownIncome: 120000, comparisonIncome: 120000, hasCover: false })).toBeCloseTo(1200, 2);
  });

  it("singles: 1.25% from $123,001, 1.50% above $164,000", () => {
    expect(mlsSurchargeAmount({ ownIncome: 140000, comparisonIncome: 140000, hasCover: false })).toBeCloseTo(140000 * 0.0125, 2);
    expect(mlsSurchargeAmount({ ownIncome: 200000, comparisonIncome: 200000, hasCover: false })).toBeCloseTo(200000 * 0.015, 2);
  });

  it("private hospital cover suppresses the surcharge entirely, regardless of income", () => {
    expect(mlsSurchargeAmount({ ownIncome: 500000, comparisonIncome: 500000, hasCover: true })).toBe(0);
  });

  it("families: nil at/below $210,000, bands scale to the family thresholds", () => {
    expect(mlsSurchargeAmount({ ownIncome: 200000, comparisonIncome: 200000, hasCover: false, isFamily: true })).toBe(0);
    expect(mlsSurchargeAmount({ ownIncome: 220000, comparisonIncome: 220000, hasCover: false, isFamily: true }))
      .toBeCloseTo(220000 * 0.01, 2);
  });

  it("family threshold: +$1,500 per dependent child AFTER THE FIRST — one child changes nothing, a second shifts the threshold", () => {
    const rates = MLS_RATES_BASE;
    // Family income sitting $1,000 above the base $210,000 threshold —
    // triggers the surcharge with 0 or 1 child, but not with 2 (the
    // threshold has moved to $211,500, above this income).
    const familyIncome = 211000;
    expect(mlsSurchargeAmount({ ownIncome: familyIncome, comparisonIncome: familyIncome, hasCover: false, isFamily: true, dependentChildren: 0, rates }))
      .toBeGreaterThan(0);
    expect(mlsSurchargeAmount({ ownIncome: familyIncome, comparisonIncome: familyIncome, hasCover: false, isFamily: true, dependentChildren: 1, rates }))
      .toBeGreaterThan(0); // the first child adds nothing — threshold still $210,000
    expect(mlsSurchargeAmount({ ownIncome: familyIncome, comparisonIncome: familyIncome, hasCover: false, isFamily: true, dependentChildren: 2, rates }))
      .toBe(0); // the second child shifts the threshold to $211,500 — now below it
  });

  it("mlsSurchargeAmount applies the RATE (from comparisonIncome) to the person's OWN income, not the comparison income — the family-threshold/individual-surcharge split", () => {
    // A lower-earning spouse (ownIncome $50,000) in a high-income
    // family ($300,000 combined) pays the surcharge on their OWN
    // $50,000, at the rate the FAMILY income triggers (1.25% band).
    const amount = mlsSurchargeAmount({
      ownIncome: 50000, comparisonIncome: 300000, hasCover: false, isFamily: true, dependentChildren: 0,
    });
    expect(amount).toBeCloseTo(50000 * 0.0125, 2);
  });

  it("mlsRatesFor: FY2026/27 (base year) reproduces the base table exactly; ten years out, indexed thresholds grow at AWOTE relative to frozen", () => {
    const base = mlsRatesFor(2026, "indexed", 0.025, 0.035);
    expect(base.singleBands).toEqual(MLS_RATES_BASE.singleBands);
    expect(base.familyBands).toEqual(MLS_RATES_BASE.familyBands);

    const indexed = mlsRatesFor(2036, "indexed", 0.025, 0.035);
    const frozen = mlsRatesFor(2036, "frozen", 0.025, 0.035);
    const expectedFactor = Math.pow(1.035, 10) / Math.pow(1.025, 10);
    expect(indexed.singleBands[1][0]).toBeCloseTo(MLS_RATES_BASE.singleBands[1][0] * expectedFactor, 2);
    expect(frozen.singleBands[1][0]).toBeLessThan(indexed.singleBands[1][0]);
  });

  it("no cover and zero/negative own income never produces a negative surcharge", () => {
    expect(mlsSurchargeAmount({ ownIncome: 0, comparisonIncome: 500000, hasCover: false })).toBe(0);
    expect(mlsSurchargeAmount({ ownIncome: -5000, comparisonIncome: 500000, hasCover: false })).toBe(0);
  });
});
