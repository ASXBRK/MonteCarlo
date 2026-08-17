import { describe, it, expect } from "vitest";
import {
  spouseSuperRatesFor, spouseContributionOffset, coContribution, listo, SPOUSE_SUPER_RATES_BASE,
} from "./spouseSuperRates.js";

const rates = spouseSuperRatesFor(2026);

describe("spouseContributionOffset — the offset at each income band including the phase-out", () => {
  it("full 18% of the lesser of the contribution and $3,000 when spouse income is at/below $37,000", () => {
    expect(spouseContributionOffset(rates, 3000, 0)).toBeCloseTo(3000 * 0.18, 6);
    expect(spouseContributionOffset(rates, 3000, 37000)).toBeCloseTo(3000 * 0.18, 6);
    expect(spouseContributionOffset(rates, 5000, 30000)).toBeCloseTo(3000 * 0.18, 6); // capped at $3,000
  });

  it("a smaller contribution offsets only that amount, not the full $3,000", () => {
    expect(spouseContributionOffset(rates, 1000, 0)).toBeCloseTo(1000 * 0.18, 6);
  });

  it("phases out linearly between $37,000 and $40,000", () => {
    // At $38,500 (halfway): notional cap = 3000 - 1500 = 1500.
    expect(spouseContributionOffset(rates, 3000, 38500)).toBeCloseTo(1500 * 0.18, 6);
    // At $39,000: notional cap = 3000 - 2000 = 1000.
    expect(spouseContributionOffset(rates, 3000, 39000)).toBeCloseTo(1000 * 0.18, 6);
  });

  it("nil at/above $40,000", () => {
    expect(spouseContributionOffset(rates, 3000, 40000)).toBe(0);
    expect(spouseContributionOffset(rates, 3000, 60000)).toBe(0);
  });

  it("zero for a zero/negative contribution", () => {
    expect(spouseContributionOffset(rates, 0, 0)).toBe(0);
    expect(spouseContributionOffset(rates, -100, 0)).toBe(0);
  });
});

describe("coContribution — phase-out at both thresholds", () => {
  it("maximum $500 (50% of an eligible $1,000 NCC) at/below the lower threshold", () => {
    expect(coContribution(rates, 1000, 0)).toBeCloseTo(500, 6);
    expect(coContribution(rates, 1000, 49293)).toBeCloseTo(500, 6);
  });

  it("50% of the contribution when that's less than $500", () => {
    expect(coContribution(rates, 600, 0)).toBeCloseTo(300, 6);
  });

  it("phases out linearly between the two thresholds", () => {
    const mid = (49293 + 64293) / 2;
    expect(coContribution(rates, 1000, mid)).toBeCloseTo(250, 1);
  });

  it("nil at/above the upper threshold", () => {
    expect(coContribution(rates, 1000, 64293)).toBe(0);
    expect(coContribution(rates, 1000, 100000)).toBe(0);
  });

  it("zero for zero eligible contributions", () => {
    expect(coContribution(rates, 0, 0)).toBe(0);
  });
});

describe("listo — at the income limit", () => {
  it("15% of eligible concessional contributions, capped at $500", () => {
    expect(listo(rates, 2000, 0)).toBeCloseTo(300, 6);
    expect(listo(rates, 5000, 0)).toBeCloseTo(500, 6); // capped
  });

  it("nil at/above the $37,000 income threshold", () => {
    expect(listo(rates, 2000, 37000)).toBe(0);
    expect(listo(rates, 2000, 50000)).toBe(0);
  });

  it("still payable just below the threshold", () => {
    expect(listo(rates, 2000, 36999)).toBeGreaterThan(0);
  });
});

describe("spouseSuperRatesFor — indexation", () => {
  it("co-contribution thresholds grow with AWOTE under 'indexed', frozen under 'frozen'", () => {
    const indexed = spouseSuperRatesFor(2031, "indexed", 0.025, 0.035);
    const frozen = spouseSuperRatesFor(2031, "frozen", 0.025, 0.035);
    expect(indexed.coContributionLowerThreshold).toBeGreaterThan(frozen.coContributionLowerThreshold);
  });

  it("the spouse offset's flat figures never move under either bracketMode (not indexed in law)", () => {
    const indexed = spouseSuperRatesFor(2031, "indexed", 0.025, 0.035);
    const frozen = spouseSuperRatesFor(2031, "frozen", 0.025, 0.035);
    expect(indexed.spouseOffsetContributionCap).toBeCloseTo(frozen.spouseOffsetContributionCap, 6);
  });

  it("states its verification caveat", () => {
    expect(SPOUSE_SUPER_RATES_BASE.source).toMatch(/UNVERIFIED/i);
  });
});
