import { describe, it, expect } from "vitest";
import { AGE_PENSION_RATES_BASE, agePensionRatesFor, assetsTestCutOut } from "./agePension.js";

// Source-figure spot checks (encoding tests verify the encoding, not
// the source — CLAUDE.md convention). Homeowner thresholds and the
// reduction rate are the firm's own reference (hand-checked against
// spec 21a); non-homeowner/deeming/income-free-area figures close the
// spec's own data gap and are cross-referenced two ways — see
// agePension.js's own module header.
describe("AGE_PENSION_RATES_BASE — FY2026/27 (20 Mar 2026 rate period) source-figure spot checks", () => {
  it("carries the as-at date and source", () => {
    expect(AGE_PENSION_RATES_BASE.asAt).toBe("2026-03-20");
    expect(AGE_PENSION_RATES_BASE.source).toMatch(/Services Australia/);
  });

  it("age of eligibility is 67", () => {
    expect(AGE_PENSION_RATES_BASE.ageOfEligibility).toBe(67);
  });

  it("maximum rates: single $1,200.90/f, couple $905.20/f each", () => {
    expect(AGE_PENSION_RATES_BASE.singleRate).toBeCloseTo(1200.90 * 26, 6);
    expect(AGE_PENSION_RATES_BASE.coupleRateEach).toBeCloseTo(905.20 * 26, 6);
  });

  it("reduction rate is $78 per $1,000 (assets test)", () => {
    expect(AGE_PENSION_RATES_BASE.reductionRatePer1000).toBe(78);
  });

  it("homeowner assets-test full-pension thresholds match the firm's reference exactly", () => {
    expect(AGE_PENSION_RATES_BASE.assetsFullHomeownerSingle).toBe(333000);
    expect(AGE_PENSION_RATES_BASE.assetsFullHomeownerCouple).toBe(499000);
  });

  it("non-homeowner assets-test full-pension thresholds", () => {
    expect(AGE_PENSION_RATES_BASE.assetsFullNonHomeownerSingle).toBe(600000);
    expect(AGE_PENSION_RATES_BASE.assetsFullNonHomeownerCouple).toBe(766000);
  });

  it("deeming rates and thresholds", () => {
    expect(AGE_PENSION_RATES_BASE.deemingLowerRate).toBe(0.0125);
    expect(AGE_PENSION_RATES_BASE.deemingUpperRate).toBe(0.0325);
    expect(AGE_PENSION_RATES_BASE.deemingThresholdSingle).toBe(66800);
    expect(AGE_PENSION_RATES_BASE.deemingThresholdCouple).toBe(110600);
  });

  it("income-test free areas and reduction rate", () => {
    expect(AGE_PENSION_RATES_BASE.incomeFreeAreaSingle).toBeCloseTo(226 * 26, 6);
    expect(AGE_PENSION_RATES_BASE.incomeFreeAreaCouple).toBeCloseTo(396 * 26, 6);
    expect(AGE_PENSION_RATES_BASE.incomeReductionRate).toBe(0.5);
  });
});

// Cut-outs are derived (never stored) from the full-pension threshold,
// the annual rate, and the reduction rate. Confirms the derivation
// formula independently reproduces the firm's own given homeowner
// cut-out figures ($733,500 single, $1,102,500 couple) to within the
// $500 assets-threshold rounding step — the cross-check documented in
// agePension.js's module header.
describe("assetsTestCutOut — derivation, not storage (Commit 1)", () => {
  it("reproduces the firm's homeowner single cut-out ($733,500) within one rounding step", () => {
    const r = agePensionRatesFor(2026, "indexed", 0.025, 0.035);
    const cutOut = assetsTestCutOut(r.single.assetsFullHomeowner, r.single.rate, r.reductionRatePer1000);
    expect(Math.abs(cutOut - 733500)).toBeLessThan(500);
  });

  it("reproduces the firm's homeowner couple cut-out ($1,102,500) within one rounding step", () => {
    const r = agePensionRatesFor(2026, "indexed", 0.025, 0.035);
    const cutOut = assetsTestCutOut(r.couple.assetsFullHomeowner, r.couple.rateCombined, r.reductionRatePer1000);
    expect(Math.abs(cutOut - 1102500)).toBeLessThan(500);
  });

  it("a hand-computed round-number case", () => {
    // Threshold $300,000, annual rate $30,000, reduction $78/$1,000/yr:
    // excess = 30,000 × 1,000 / 78 = 384,615.38; cut-out = 684,615.38.
    expect(assetsTestCutOut(300000, 30000, 78)).toBeCloseTo(684615.3846, 3);
  });

  it("cut-out rises when the underlying rate rises, all else equal", () => {
    const lo = assetsTestCutOut(300000, 30000, 78);
    const hi = assetsTestCutOut(300000, 31000, 78);
    expect(hi).toBeGreaterThan(lo);
  });
});

// Commit 1's central claim: rates index at AWOTE, thresholds at CPI —
// with AWOTE > CPI (the default assumption set), the pension grows
// gently in real terms relative to the thresholds over a long horizon.
describe("agePensionRatesFor — per-figure indexation bases (Commit 1)", () => {
  it("at FY2026/27 (t=0), figures equal the base exactly", () => {
    const r = agePensionRatesFor(2026, "indexed", 0.025, 0.035);
    expect(r.single.rate).toBeCloseTo(AGE_PENSION_RATES_BASE.singleRate, 6);
    expect(r.single.assetsFullHomeowner).toBe(333000);
    expect(r.couple.assetsFullHomeowner).toBe(499000);
  });

  it("rate indexes at AWOTE: nominal year-10 single rate matches hand-computed compounding, rounded to the nearest $2.60", () => {
    // 31,223.40 × 1.035^10 = 44,057.24...; floor to nearest $2.60 step.
    const base = 1200.90 * 26;
    const nominalY10 = Math.floor((base * Math.pow(1.035, 10)) / 2.60) * 2.60;
    const r = agePensionRatesFor(2036, "indexed", 0.025, 0.035);
    expect(r.single.rate).toBeCloseTo(nominalY10 / Math.pow(1.025, 10), 2);
  });

  it("threshold indexes at CPI, NOT AWOTE — a higher awote assumption doesn't move it", () => {
    const lowAwote = agePensionRatesFor(2036, "indexed", 0.025, 0.02);
    const highAwote = agePensionRatesFor(2036, "indexed", 0.025, 0.06);
    expect(lowAwote.single.assetsFullHomeowner).toBe(highAwote.single.assetsFullHomeowner);
  });

  it("real rate diverges upward from real thresholds over 20 years when awote > cpi (the historical pattern)", () => {
    const y0 = agePensionRatesFor(2026, "indexed", 0.025, 0.035);
    const y20 = agePensionRatesFor(2046, "indexed", 0.025, 0.035);
    const rateGrowth = y20.single.rate / y0.single.rate;
    const thresholdGrowth = y20.single.assetsFullHomeowner / y0.single.assetsFullHomeowner;
    // ~1% p.a. divergence compounded over 20 years is roughly a
    // 15-30% relative gap — a wide but directionally-precise band,
    // since both sides step irregularly via their own rounding.
    expect(rateGrowth).toBeGreaterThan(thresholdGrowth * 1.10);
    expect(rateGrowth).toBeLessThan(thresholdGrowth * 1.35);
  });

  it("flat policy rates (reduction rate, deeming rates, income taper) never move with either basis", () => {
    const y0 = agePensionRatesFor(2026, "indexed", 0.025, 0.035);
    const y20 = agePensionRatesFor(2046, "indexed", 0.025, 0.035);
    expect(y20.reductionRatePer1000).toBe(y0.reductionRatePer1000);
    expect(y20.deemingLowerRate).toBe(y0.deemingLowerRate);
    expect(y20.deemingUpperRate).toBe(y0.deemingUpperRate);
    expect(y20.incomeReductionRate).toBe(y0.incomeReductionRate);
  });

  it("frozen bracket mode pins nominal compounding at the base year but still deflates by actual elapsed CPI years", () => {
    const frozen = agePensionRatesFor(2036, "frozen", 0.025, 0.035);
    const deflateOnly = AGE_PENSION_RATES_BASE.assetsFullHomeownerSingle / Math.pow(1.025, 10);
    expect(frozen.single.assetsFullHomeowner).toBeCloseTo(deflateOnly, 2);
    // Real value under "frozen" strictly declines every year (pure CPI
    // deflation of a nominally-static figure).
    const frozenY0 = agePensionRatesFor(2026, "frozen", 0.025, 0.035);
    expect(frozen.single.assetsFullHomeowner).toBeLessThan(frozenY0.single.assetsFullHomeowner);
  });

  it("non-homeowner thresholds stay above homeowner thresholds at every FY", () => {
    const r = agePensionRatesFor(2040, "indexed", 0.025, 0.035);
    expect(r.single.assetsFullNonHomeowner).toBeGreaterThan(r.single.assetsFullHomeowner);
    expect(r.couple.assetsFullNonHomeowner).toBeGreaterThan(r.couple.assetsFullHomeowner);
  });

  it("couple combined rate is exactly double the each-rate, every FY", () => {
    const r = agePensionRatesFor(2033, "indexed", 0.025, 0.035);
    expect(r.couple.rateCombined).toBeCloseTo(2 * r.couple.rateEach, 6);
  });
});
