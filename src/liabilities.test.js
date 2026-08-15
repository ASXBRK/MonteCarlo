import { describe, it, expect } from "vitest";
import { levelPayment, monthlyRate, termMonths, ioMonths, payoffMonths, scheduledAmortisation } from "./liabilities.js";

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

describe("scheduledAmortisation (Document Set Commit 5)", () => {
  const flatInfl = () => 1; // no inflation → real == nominal, isolating the amortisation math

  it("payoff month always equals termM by construction", () => {
    const i = 0.005, termM = 120;
    const pmtPI = levelPayment(100000, i, termM);
    const out = scheduledAmortisation({ balance: 100000, i, ioM: 0, termM, pmtPI, inflAt: flatInfl });
    expect(out.payoffMonth).toBe(termM);
  });

  it("total interest matches a hand-tracked simulation", () => {
    const i = 0.005, termM = 120;
    const pmtPI = levelPayment(100000, i, termM);
    let b = 100000, expected = 0;
    for (let m = 0; m < termM; m++) {
      const interest = b * i;
      expected += interest;
      b = b + interest - Math.min(pmtPI, b + interest);
    }
    const out = scheduledAmortisation({ balance: 100000, i, ioM: 0, termM, pmtPI, inflAt: flatInfl });
    expect(out.totalInterestReal).toBeCloseTo(expected, 4);
  });

  it("an IO period accrues its own interest before the P&I phase begins", () => {
    const i = 0.005, termM = 120, ioM = 24;
    const pmtPI = levelPayment(100000, i, termM - ioM);
    const withIo = scheduledAmortisation({ balance: 100000, i, ioM, termM, pmtPI, inflAt: flatInfl });
    const noIo = scheduledAmortisation({ balance: 100000, i, ioM: 0, termM, pmtPI: levelPayment(100000, i, termM), inflAt: flatInfl });
    // An IO period defers principal reduction, so total interest is higher.
    expect(withIo.totalInterestReal).toBeGreaterThan(noIo.totalInterestReal);
  });

  it("inflAt deflates each month's interest to real dollars", () => {
    const i = 0.005, termM = 12;
    const pmtPI = levelPayment(100000, i, termM);
    const nominal = scheduledAmortisation({ balance: 100000, i, ioM: 0, termM, pmtPI, inflAt: flatInfl });
    const cpiMonthly = Math.pow(1.025, 1 / 12);
    const real = scheduledAmortisation({ balance: 100000, i, ioM: 0, termM, pmtPI, inflAt: (m) => Math.pow(cpiMonthly, m) });
    expect(real.totalInterestReal).toBeLessThan(nominal.totalInterestReal);
  });

  it("startMonth offsets which inflAt index each month reads", () => {
    const i = 0.005, termM = 12;
    const pmtPI = levelPayment(100000, i, termM);
    const inflAt = (m) => 1 + m * 0.01; // any monotonic stand-in
    const at0 = scheduledAmortisation({ balance: 100000, i, ioM: 0, termM, pmtPI, startMonth: 0, inflAt });
    const at24 = scheduledAmortisation({ balance: 100000, i, ioM: 0, termM, pmtPI, startMonth: 24, inflAt });
    // Same nominal path, but deflated at a later (larger) inflAt index throughout → smaller real total.
    expect(at24.totalInterestReal).toBeLessThan(at0.totalInterestReal);
  });
});
