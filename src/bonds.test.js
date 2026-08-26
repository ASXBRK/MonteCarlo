import { describe, it, expect } from "vitest";
import {
  BOND_TAX_RATE, bondEffectiveTaxRate, bondMaturityMonth, bondHasMatured,
  bondStartMonthIndex, bondContributionCapCheck, bondWithdrawalTax,
  bondWithdrawalSplit, bondEducationBenefit, EDUCATION_BENEFIT_RATIO,
} from "./bonds.js";

describe("bondEffectiveTaxRate", () => {
  it("is the full 30% with no franking", () => {
    expect(bondEffectiveTaxRate(0)).toBeCloseTo(0.30, 10);
  });
  it("is reduced proportionally to the franked share (full imputation)", () => {
    expect(bondEffectiveTaxRate(50)).toBeCloseTo(0.15, 10);
    expect(bondEffectiveTaxRate(100)).toBeCloseTo(0, 10);
  });
  it("clamps an out-of-range franking figure rather than producing a negative/over-100% rate", () => {
    expect(bondEffectiveTaxRate(-10)).toBeCloseTo(BOND_TAX_RATE, 10);
    expect(bondEffectiveTaxRate(150)).toBeCloseTo(0, 10);
  });
});

describe("bondMaturityMonth / bondHasMatured", () => {
  it("matures exactly 120 months after its start month", () => {
    expect(bondMaturityMonth(0)).toBe(120);
    expect(bondMaturityMonth(-36)).toBe(84);
  });
  it("has not matured the month before, has matured from the maturity month on", () => {
    expect(bondHasMatured(0, 119)).toBe(false);
    expect(bondHasMatured(0, 120)).toBe(true);
    expect(bondHasMatured(0, 121)).toBe(true);
  });
});

describe("bondStartMonthIndex", () => {
  it("is 0 for a bond starting the same month the plan starts", () => {
    expect(bondStartMonthIndex("2026-07-01", { year: 2026, month: 7 })).toBe(0);
  });
  it("is negative for a bond already established before the plan starts", () => {
    // Established 1 July 2021, plan starts 1 July 2026 — five years (60
    // months) of the ten-year clock already elapsed.
    expect(bondStartMonthIndex("2021-07-01", { year: 2026, month: 7 })).toBe(-60);
  });
  it("is positive for a bond planned to open after the plan starts", () => {
    expect(bondStartMonthIndex("2027-01-01", { year: 2026, month: 7 })).toBe(6);
  });
});

describe("bondContributionCapCheck (the 125% rule)", () => {
  it("a contribution at or below 125% of last year's does not breach", () => {
    expect(bondContributionCapCheck(10000, 12500).breach).toBe(false);
    expect(bondContributionCapCheck(10000, 8000).breach).toBe(false);
  });
  it("a contribution above 125% of last year's breaches", () => {
    const { cap, breach } = bondContributionCapCheck(10000, 12501);
    expect(cap).toBeCloseTo(12500, 6);
    expect(breach).toBe(true);
  });
  it("a nil-contribution year sets the following year's cap to nil — any positive contribution breaches", () => {
    const { cap, breach } = bondContributionCapCheck(0, 1);
    expect(cap).toBe(0);
    expect(breach).toBe(true);
  });
  it("a nil-contribution year followed by another nil contribution does not breach", () => {
    expect(bondContributionCapCheck(0, 0).breach).toBe(false);
  });
});

describe("bondWithdrawalTax", () => {
  it("splits the withdrawal proportionally between capital and earnings", () => {
    // $100k balance, $60k of it original capital → 40% earnings.
    const r = bondWithdrawalTax({ withdrawalAmount: 10000, balance: 100000, costBase: 60000, matured: false });
    expect(r.earningsWithdrawn).toBeCloseTo(4000, 6);
    expect(r.capitalWithdrawn).toBeCloseTo(6000, 6);
    expect(r.earningsWithdrawn + r.capitalWithdrawn).toBeCloseTo(10000, 6);
  });
  it("a matured bond's withdrawal is entirely tax-free — nothing assessable", () => {
    const r = bondWithdrawalTax({ withdrawalAmount: 10000, balance: 100000, costBase: 60000, matured: true });
    expect(r.assessableEarnings).toBe(0);
  });
  it("an unmatured bond's earnings component is assessable", () => {
    const r = bondWithdrawalTax({ withdrawalAmount: 10000, balance: 100000, costBase: 60000, matured: false });
    expect(r.assessableEarnings).toBeCloseTo(4000, 6);
  });
  it("a withdrawal from an all-capital bond (no earnings yet) has nothing assessable either way", () => {
    const r = bondWithdrawalTax({ withdrawalAmount: 10000, balance: 100000, costBase: 100000, matured: false });
    expect(r.assessableEarnings).toBe(0);
  });
  it("handles a zero/negative withdrawal or balance without dividing by zero", () => {
    expect(bondWithdrawalTax({ withdrawalAmount: 0, balance: 100000, costBase: 60000, matured: false })).toEqual({
      earningsWithdrawn: 0, capitalWithdrawn: 0, assessableEarnings: 0,
    });
    expect(bondWithdrawalTax({ withdrawalAmount: 5000, balance: 0, costBase: 0, matured: false })).toEqual({
      earningsWithdrawn: 0, capitalWithdrawn: 5000, assessableEarnings: 0,
    });
  });
});

describe("bondWithdrawalSplit (the same earnings/capital split, reused by the education benefit)", () => {
  it("matches bondWithdrawalTax's own split exactly", () => {
    const full = bondWithdrawalTax({ withdrawalAmount: 10000, balance: 100000, costBase: 60000, matured: false });
    const split = bondWithdrawalSplit({ withdrawalAmount: 10000, balance: 100000, costBase: 60000 });
    expect(split.earningsWithdrawn).toBeCloseTo(full.earningsWithdrawn, 6);
    expect(split.capitalWithdrawn).toBeCloseTo(full.capitalWithdrawn, 6);
  });
});

describe("bondEducationBenefit (spec 25, Commit 3 — verified via provider-sourced content, see bonds.js's own header)", () => {
  it("is $30 for every $70 of earnings withdrawn — the verified provider mechanic", () => {
    expect(EDUCATION_BENEFIT_RATIO).toBeCloseTo(30 / 70, 10);
    expect(bondEducationBenefit(70)).toBeCloseTo(30, 6);
    expect(bondEducationBenefit(700)).toBeCloseTo(300, 6);
  });
  it("zero earnings withdrawn gives zero benefit", () => {
    expect(bondEducationBenefit(0)).toBe(0);
  });
  it("a negative input (should never occur) clamps to zero rather than going negative", () => {
    expect(bondEducationBenefit(-100)).toBe(0);
  });
});
