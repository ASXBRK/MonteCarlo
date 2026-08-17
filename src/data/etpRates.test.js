import { describe, it, expect } from "vitest";
import { etpRatesFor, redundancyTaxFreeAmount, etpTax, ETP_RATES_BASE } from "./etpRates.js";

describe("etpRatesFor — FY2026-27 base figures resolve unindexed at the base year", () => {
  const r = etpRatesFor(2026, "indexed", 0.025, 0.035);
  it("matches the embedded base figures exactly at t=0", () => {
    expect(r.redundancyBaseAmount).toBeCloseTo(13598, 6);
    expect(r.redundancyPerYearAmount).toBeCloseTo(6801, 6);
    expect(r.etpCap).toBeCloseTo(270000, 6);
    expect(r.wholeOfIncomeCap).toBe(180000);
  });
});

describe("etpRatesFor — indexation and rounding", () => {
  it("the whole-of-income cap never moves under either bracketMode (flat, not indexed in law)", () => {
    const y5indexed = etpRatesFor(2031, "indexed", 0.025, 0.035);
    const y5frozen = etpRatesFor(2031, "frozen", 0.025, 0.035);
    // Both deflate the SAME nominal $180,000 by the same real elapsed years.
    expect(y5indexed.wholeOfIncomeCap).toBeCloseTo(y5frozen.wholeOfIncomeCap, 6);
    expect(y5indexed.wholeOfIncomeCap).toBeLessThan(180000);
  });

  it("the redundancy tax-free base/per-year and the ETP cap grow with AWOTE under 'indexed', frozen under 'frozen'", () => {
    const indexed = etpRatesFor(2031, "indexed", 0.025, 0.035);
    const frozen = etpRatesFor(2031, "frozen", 0.025, 0.035);
    expect(indexed.redundancyBaseAmount).toBeGreaterThan(frozen.redundancyBaseAmount);
    expect(indexed.etpCap).toBeGreaterThanOrEqual(frozen.etpCap);
  });

  it("the ETP cap rounds down to the nearest $5,000 in nominal dollars", () => {
    // Grow it a long way to force a rounding step, then check divisibility
    // of the RE-INFLATED nominal figure.
    const cpi = 0.025;
    const r = etpRatesFor(2036, "indexed", cpi, 0.035);
    const nominal = r.etpCap * Math.pow(1 + cpi, 10);
    expect(Math.round(nominal) % 5000).toBe(0);
  });
});

describe("redundancyTaxFreeAmount", () => {
  const r = etpRatesFor(2026);
  it("at several service lengths", () => {
    expect(redundancyTaxFreeAmount(r, 0)).toBeCloseTo(13598, 2);
    expect(redundancyTaxFreeAmount(r, 1)).toBeCloseTo(13598 + 6801, 2);
    expect(redundancyTaxFreeAmount(r, 10)).toBeCloseTo(13598 + 6801 * 10, 2);
    expect(redundancyTaxFreeAmount(r, 25)).toBeCloseTo(13598 + 6801 * 25, 2);
  });
  it("clamps a negative service length to zero years (defensive)", () => {
    expect(redundancyTaxFreeAmount(r, -3)).toBeCloseTo(13598, 2);
  });
});

describe("etpTax — genuine redundancy (ETP cap alone, whole-of-income cap does not apply)", () => {
  const r = etpRatesFor(2026);
  it("under preservation age: 30% up to the cap", () => {
    const { tax, cap } = etpTax(r, 100000, 45, { genuineRedundancy: true });
    expect(cap).toBeCloseTo(270000, 2);
    expect(tax).toBeCloseTo(100000 * 0.3 + 100000 * 0.02, 2);
  });
  it("at/above preservation age: 15% up to the cap", () => {
    const { tax } = etpTax(r, 100000, 60, { genuineRedundancy: true });
    expect(tax).toBeCloseTo(100000 * 0.15 + 100000 * 0.02, 2);
  });
  it("above the ETP cap: 45% on the excess, at both age brackets", () => {
    const amount = 320000; // 50,000 above the ~270,000 cap
    const under = etpTax(r, amount, 45, { genuineRedundancy: true });
    const over = etpTax(r, amount, 61, { genuineRedundancy: true });
    const excess = amount - under.cap;
    expect(under.tax).toBeCloseTo(under.cap * 0.3 + excess * 0.45 + amount * 0.02, 2);
    expect(over.tax).toBeCloseTo(over.cap * 0.15 + excess * 0.45 + amount * 0.02, 2);
    // Ignoring other taxable income entirely — an excluded ETP.
    const withHighIncome = etpTax(r, amount, 45, { genuineRedundancy: true, otherTaxableIncomeThisFY: 500000 });
    expect(withHighIncome.tax).toBeCloseTo(under.tax, 2);
  });
});

describe("etpTax — resignation/retirement (whole-of-income cap applies)", () => {
  const r = etpRatesFor(2026);
  it("caps at the ETP cap when other income is low", () => {
    const { cap } = etpTax(r, 100000, 45, { genuineRedundancy: false, otherTaxableIncomeThisFY: 10000 });
    expect(cap).toBeCloseTo(Math.min(270000, 180000 - 10000), 2);
  });
  it("caps at (whole-of-income cap − other income) when that's tighter than the ETP cap", () => {
    const { cap, tax } = etpTax(r, 100000, 45, { genuineRedundancy: false, otherTaxableIncomeThisFY: 150000 });
    expect(cap).toBeCloseTo(30000, 2); // 180,000 - 150,000
    const excess = 100000 - 30000;
    expect(tax).toBeCloseTo(30000 * 0.3 + excess * 0.45 + 100000 * 0.02, 2);
  });
  it("other income already exceeding the whole-of-income cap leaves NO concessional room (cap floors at 0)", () => {
    const { cap, tax } = etpTax(r, 50000, 45, { genuineRedundancy: false, otherTaxableIncomeThisFY: 400000 });
    expect(cap).toBe(0);
    expect(tax).toBeCloseTo(50000 * 0.45 + 50000 * 0.02, 2);
  });
  it("genuine redundancy vs resignation produce DIFFERENT tax on an identical payout once other income is high", () => {
    const genuine = etpTax(r, 200000, 45, { genuineRedundancy: true, otherTaxableIncomeThisFY: 150000 });
    const resignation = etpTax(r, 200000, 45, { genuineRedundancy: false, otherTaxableIncomeThisFY: 150000 });
    expect(resignation.tax).toBeGreaterThan(genuine.tax);
  });
});

describe("etpTax edge cases", () => {
  const r = etpRatesFor(2026);
  it("a zero or negative taxable component produces zero tax, not NaN/throw", () => {
    expect(etpTax(r, 0, 45).tax).toBe(0);
    expect(etpTax(r, -100, 45).tax).toBe(0);
  });
});

describe("module metadata", () => {
  it("states its as-at date and verification caveat", () => {
    expect(ETP_RATES_BASE.asAt).toBe("2026-07-01");
    expect(ETP_RATES_BASE.source).toMatch(/UNVERIFIED/i);
  });
});
