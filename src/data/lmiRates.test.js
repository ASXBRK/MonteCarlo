import { describe, it, expect } from "vitest";
import { lmiPremium } from "./lmiRates.js";

describe("lmiPremium", () => {
  it("no LMI at or below 80% LVR", () => {
    expect(lmiPremium(80, 500000)).toBe(0);
    expect(lmiPremium(70, 500000)).toBe(0);
  });

  it("known-value: 82% LVR, $250,000 loan — first loan band, first LVR band", () => {
    // 80-85% band, <$300k loan band → 0.50%.
    expect(lmiPremium(82, 250000)).toBeCloseTo(250000 * 0.005, 6);
  });

  it("known-value: 88% LVR, $400,000 loan — second loan band, second LVR band", () => {
    // 85-90% band, $300k-$500k loan band → 1.15%.
    expect(lmiPremium(88, 400000)).toBeCloseTo(400000 * 0.0115, 6);
  });

  it("known-value: 93% LVR, $600,000 loan — third loan band, third LVR band", () => {
    // 90-95% band, $500k-$750k loan band → 2.60%.
    expect(lmiPremium(93, 600000)).toBeCloseTo(600000 * 0.026, 6);
  });

  it("known-value: 97% LVR, $900,000 loan — top loan band, top LVR band", () => {
    // 95-100% band, >$750k loan band → 4.70%.
    expect(lmiPremium(97, 900000)).toBeCloseTo(900000 * 0.047, 6);
  });

  it("the rate strictly increases with LVR band at a fixed loan size", () => {
    const loan = 400000;
    const at82 = lmiPremium(82, loan);
    const at88 = lmiPremium(88, loan);
    const at93 = lmiPremium(93, loan);
    const at97 = lmiPremium(97, loan);
    expect(at88).toBeGreaterThan(at82);
    expect(at93).toBeGreaterThan(at88);
    expect(at97).toBeGreaterThan(at93);
  });

  it("exactly 80% LVR pays nothing; just above it does", () => {
    expect(lmiPremium(80, 500000)).toBe(0);
    expect(lmiPremium(80.01, 500000)).toBeGreaterThan(0);
  });

  it("a zero or negative loan amount is safe", () => {
    expect(lmiPremium(90, 0)).toBe(0);
  });
});
