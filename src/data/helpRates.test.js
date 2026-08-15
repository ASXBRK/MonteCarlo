import { describe, it, expect } from "vitest";
import { HELP_RATES_BASE, helpRatesFor, helpRepaymentAmount } from "./helpRates.js";

describe("HELP repayment rates — FY2026/27 base table", () => {
  it("nil below/at the first threshold ($69,528)", () => {
    expect(helpRepaymentAmount(0)).toBe(0);
    expect(helpRepaymentAmount(50000)).toBe(0);
    expect(helpRepaymentAmount(69528)).toBe(0); // exactly at the boundary — still nil
  });

  it("15% of each $1 over $69,528, up to $129,717", () => {
    // hand calc: (75000 − 69528) × 0.15 = 5472 × 0.15 = 820.80
    expect(helpRepaymentAmount(75000)).toBeCloseTo(820.80, 2);
    // at the top of the 15% band: (129717 − 69528) × 0.15 = 60189 × 0.15 = 9028.35
    expect(helpRepaymentAmount(129717)).toBeCloseTo(9028.35, 2);
  });

  it("$9,028 + 17% of each $1 over $129,717, up to $186,051 (the $9,028 falls out of the marginal calc, not a separate constant)", () => {
    // hand calc: 9028.35 + (150000 − 129717) × 0.17 = 9028.35 + 20283×0.17 = 9028.35 + 3448.11 = 12476.46
    expect(helpRepaymentAmount(150000)).toBeCloseTo(12476.46, 2);
    // one dollar into the 17% band
    expect(helpRepaymentAmount(129718)).toBeCloseTo(9028.35 + 0.17, 2);
    // top of the 17% band, one dollar short of the cliff
    // hand calc: 9028.35 + (186051 − 129717) × 0.17 = 9028.35 + 56334×0.17 = 9028.35 + 9576.78 = 18605.13
    expect(helpRepaymentAmount(186051)).toBeCloseTo(18605.13, 2);
  });

  it("the $186,052 cliff — 10% of the WHOLE income, not marginal (a genuine discontinuity)", () => {
    // hand calc: 186052 × 0.10 = 18605.20 — barely above the $18,605.13
    // it would have been one dollar lower, under the marginal formula
    expect(helpRepaymentAmount(186052)).toBeCloseTo(18605.20, 2);
    // Far above the cliff: 10% of the total, e.g. $250,000 × 10% = $25,000
    expect(helpRepaymentAmount(250000)).toBeCloseTo(25000, 2);
    // The cliff genuinely produces a HIGHER repayment for a marginally
    // higher income — assert the discontinuity exists, not just its size.
    expect(helpRepaymentAmount(186052)).toBeGreaterThan(helpRepaymentAmount(186051));
  });

  it("negative or zero repayment income never produces a negative repayment", () => {
    expect(helpRepaymentAmount(-1000)).toBe(0);
  });

  it("helpRatesFor: indexed mode compounds thresholds at AWOTE and deflates to real; FY2026/27 (base year) reproduces the base table exactly", () => {
    const rates = helpRatesFor(2026, "indexed", 0.025, 0.035);
    expect(rates.brackets).toEqual(HELP_RATES_BASE.brackets);
    expect(rates.cliffThreshold).toBe(HELP_RATES_BASE.cliffThreshold);
  });

  it("helpRatesFor: ten years out, indexed thresholds grow relative to frozen ones (AWOTE compounding, deflated)", () => {
    const indexed = helpRatesFor(2036, "indexed", 0.025, 0.035);
    const frozen = helpRatesFor(2036, "frozen", 0.025, 0.035);
    // hand calc: factor = (1.035^10)/(1.025^10) — AWOTE(3.5%) exceeds
    // CPI(2.5%), so the indexed real threshold grows relative to base.
    const expectedFactor = Math.pow(1.035, 10) / Math.pow(1.025, 10);
    expect(indexed.cliffThreshold).toBeCloseTo(HELP_RATES_BASE.cliffThreshold * expectedFactor, 2);
    // Frozen mode: nominal pinned at the base year, only CPI deflation
    // applies, so it's strictly less than the indexed figure here.
    expect(frozen.cliffThreshold).toBeLessThan(indexed.cliffThreshold);
    expect(frozen.cliffThreshold).toBeCloseTo(HELP_RATES_BASE.cliffThreshold / Math.pow(1.025, 10), 2);
  });
});
