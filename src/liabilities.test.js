import { describe, it, expect } from "vitest";
import { levelPayment, monthlyRate, termMonths, ioMonths, payoffMonths } from "./liabilities.js";

describe("amortisation helpers (D3)", () => {
  it("level payment matches the closed form", () => {
    // $500k, 6% p.a. (0.5%/mo), 30 years: P·i/(1−(1+i)^−n) = $2,997.75.
    expect(levelPayment(500000, 0.005, 360)).toBeCloseTo(2997.7526, 3);
    // Zero rate → straight-line.
    expect(levelPayment(120000, 0, 120)).toBeCloseTo(1000, 10);
  });

  it("a level payment retires the loan at exactly the final month", () => {
    const i = 0.005;
    const n = 120;
    const pmt = levelPayment(100000, i, n);
    let b = 100000;
    for (let m = 0; m < n; m++) b = b + b * i - Math.min(pmt, b + b * i);
    expect(b).toBeCloseTo(0, 6);
  });

  it("IO/term month helpers clamp sensibly", () => {
    const l = { balance: 1, interestRatePct: 6, termYears: 25, repayment: "io", ioYears: 5 };
    expect(monthlyRate(l)).toBeCloseTo(0.005, 12);
    expect(termMonths(l)).toBe(300);
    expect(ioMonths(l)).toBe(60);
    expect(ioMonths({ ...l, repayment: "pi" })).toBe(0);
    expect(payoffMonths(l)).toBe(300);
  });
});
