import { describe, it, expect } from "vitest";
import {
  consumeCarryForward, accrueCarryForward, availableCarryForward,
  processConcessionalCap, bringForwardTierFor, processNonConcessionalCap,
  div293Tax,
} from "./superContributions.js";

const ZERO5 = [0, 0, 0, 0, 0];
const THRESHOLDS = { full: 1840000, two: 1970000, one: 2100000 };
const BASE_CAP = 130000;

describe("carry-forward: accrual, FIFO consumption, expiry", () => {
  it("accrueCarryForward appends the newest entry and expires the oldest beyond 5 years", () => {
    const cf = [1000, 2000, 3000, 4000, 5000];
    expect(accrueCarryForward(cf, 6000)).toEqual([2000, 3000, 4000, 5000, 6000]);
    // The oldest ($1,000) is gone — it's aged out past the 5-year window.
  });

  it("consumeCarryForward spends the OLDEST entries first (FIFO)", () => {
    const cf = [1000, 2000, 3000, 0, 0];
    const { consumed, carryForward } = consumeCarryForward(cf, 2500);
    expect(consumed).toBe(2500);
    expect(carryForward).toEqual([0, 500, 3000, 0, 0]); // 1000 fully spent, 2000 partly
  });

  it("consumeCarryForward never over-consumes when the request exceeds total available", () => {
    const cf = [1000, 500, 0, 0, 0];
    const { consumed, carryForward } = consumeCarryForward(cf, 10000);
    expect(consumed).toBe(1500);
    expect(carryForward).toEqual([0, 0, 0, 0, 0]);
  });

  it("availableCarryForward is gated by the prior-30-June TSB snapshot only", () => {
    const cf = [1000, 2000, 3000, 4000, 5000];
    const total = cf.reduce((s, v) => s + v, 0);
    expect(availableCarryForward(cf, 499999, 500000)).toBe(total); // under the gate
    expect(availableCarryForward(cf, 500000, 500000)).toBe(0); // at/over the gate
    expect(availableCarryForward(cf, 600000, 500000)).toBe(0);
  });
});

describe("processConcessionalCap", () => {
  it("under the base cap: no excess, the shortfall accrues as new (unused) carry-forward", () => {
    const r = processConcessionalCap({ totalCC: 20000, baseCap: 32500, carryForward: ZERO5, tsbPriorJune: 0, gate: 500000 });
    expect(r.excess).toBe(0);
    expect(r.carryForwardUsed).toBe(0);
    expect(r.newCarryForward).toEqual([0, 0, 0, 0, 12500]); // 32500-20000 accrues as the newest entry
  });

  it("over the base cap, with eligible carry-forward: the shortfall is covered FIFO, no true excess", () => {
    const cf = [10000, 5000, 0, 0, 0];
    const r = processConcessionalCap({ totalCC: 40000, baseCap: 32500, carryForward: cf, tsbPriorJune: 100000, gate: 500000 });
    // shortfall = 7500, covered from the oldest $10,000 entry (2,500
    // left over). The oldest slot still ages out at FY end regardless
    // — a 5-year-old entry expires whether or not it was fully used
    // this year — so that $2,500 remainder is lost, not carried on;
    // the $5,000 entry shifts down to the oldest slot, and this FY's
    // own unused amount (zero — the cap was exceeded) is the newest.
    expect(r.carryForwardUsed).toBeCloseTo(7500, 6);
    expect(r.excess).toBe(0);
    expect(r.newCarryForward).toEqual([5000, 0, 0, 0, 0]);
  });

  it("over the base cap with carry-forward exhausted: the remainder is true excess", () => {
    const cf = [1000, 0, 0, 0, 0];
    const r = processConcessionalCap({ totalCC: 40000, baseCap: 32500, carryForward: cf, tsbPriorJune: 0, gate: 500000 });
    // shortfall = 7500; only $1,000 of carry-forward covers it → $6,500 true excess.
    expect(r.carryForwardUsed).toBeCloseTo(1000, 6);
    expect(r.excess).toBeCloseTo(6500, 6);
  });

  it("the documented trap: TSB at/over the gate blocks carry-forward USE even though it keeps accruing", () => {
    const cf = [10000, 0, 0, 0, 0];
    const r = processConcessionalCap({ totalCC: 40000, baseCap: 32500, carryForward: cf, tsbPriorJune: 600000, gate: 500000 });
    expect(r.carryForwardUsed).toBe(0);
    expect(r.excess).toBeCloseTo(7500, 6); // the full shortfall, since carry-forward isn't usable
    expect(r.capAvailable).toBe(32500); // base only — carry-forward isn't counted as available either
  });

  it("crossing $500k DURING the FY (not at the prior 30 June) does not remove eligibility", () => {
    // The caller always passes the PRIOR 30 June snapshot — a TSB that
    // grew past the gate mid-year is irrelevant to this FY's test.
    const cf = [10000, 0, 0, 0, 0];
    const r = processConcessionalCap({ totalCC: 40000, baseCap: 32500, carryForward: cf, tsbPriorJune: 499000, gate: 500000 });
    expect(r.carryForwardUsed).toBeCloseTo(7500, 6);
    expect(r.excess).toBe(0);
  });
});

describe("bringForwardTierFor", () => {
  it("under $1.84m: 3-year bring-forward, 3× the base cap", () => {
    expect(bringForwardTierFor(1000000, THRESHOLDS, BASE_CAP)).toEqual({ years: 3, total: 390000 });
  });
  it("$1.84m–<$1.97m: 2-year bring-forward, 2× the base cap", () => {
    expect(bringForwardTierFor(1900000, THRESHOLDS, BASE_CAP)).toEqual({ years: 2, total: 260000 });
  });
  it("$1.97m–<$2.1m: no bring-forward — a single year at the flat cap", () => {
    expect(bringForwardTierFor(2000000, THRESHOLDS, BASE_CAP)).toEqual({ years: 1, total: 130000 });
  });
  it("≥$2.1m: nil — no NCCs accepted", () => {
    expect(bringForwardTierFor(2100000, THRESHOLDS, BASE_CAP)).toEqual({ years: 0, total: 0 });
  });
});

describe("processNonConcessionalCap", () => {
  it("within the flat annual cap: fully accepted, no bring-forward triggered", () => {
    const r = processNonConcessionalCap({
      requestedNCC: 100000, baseCap: BASE_CAP, tsbPriorJune: 1000000, thresholds: THRESHOLDS, bringForward: null, planYear: 0,
    });
    expect(r.accepted).toBe(100000);
    expect(r.rejected).toBe(0);
    expect(r.bringForward).toBeNull();
  });

  it("exceeding the annual cap triggers bring-forward sized by the TSB tier, accepting up to the full multi-year total", () => {
    const r = processNonConcessionalCap({
      requestedNCC: 390000, baseCap: BASE_CAP, tsbPriorJune: 1000000, thresholds: THRESHOLDS, bringForward: null, planYear: 2,
    });
    expect(r.accepted).toBe(390000);
    expect(r.rejected).toBe(0);
    expect(r.bringForward).toEqual({ triggeredYear: 2, years: 3, remaining: 0 });
  });

  it("excess beyond the triggered bring-forward total is REJECTED with a warning, not taxed", () => {
    const r = processNonConcessionalCap({
      requestedNCC: 500000, baseCap: BASE_CAP, tsbPriorJune: 1000000, thresholds: THRESHOLDS, bringForward: null, planYear: 0,
    });
    expect(r.accepted).toBe(390000);
    expect(r.rejected).toBe(110000);
  });

  it("the $1.97m–<$2.1m tier never triggers a multi-year bring-forward even over cap — excess is simply rejected", () => {
    const r = processNonConcessionalCap({
      requestedNCC: 200000, baseCap: BASE_CAP, tsbPriorJune: 2000000, thresholds: THRESHOLDS, bringForward: null, planYear: 0,
    });
    expect(r.accepted).toBe(130000);
    expect(r.rejected).toBe(70000);
    expect(r.bringForward).toBeNull();
  });

  it("≥$2.1m TSB rejects every dollar of NCC", () => {
    const r = processNonConcessionalCap({
      requestedNCC: 50000, baseCap: BASE_CAP, tsbPriorJune: 2200000, thresholds: THRESHOLDS, bringForward: null, planYear: 0,
    });
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(50000);
  });

  it("an active bring-forward window persists across years, tracking remaining capacity", () => {
    const triggered = { triggeredYear: 0, years: 3, remaining: 390000 };
    const year1 = processNonConcessionalCap({
      requestedNCC: 100000, baseCap: BASE_CAP, tsbPriorJune: 1000000, thresholds: THRESHOLDS, bringForward: triggered, planYear: 1,
    });
    expect(year1.accepted).toBe(100000);
    expect(year1.bringForward).toEqual({ triggeredYear: 0, years: 3, remaining: 290000 });
  });

  it("a bring-forward window expires after its triggered number of years, resetting to the flat annual cap", () => {
    const stale = { triggeredYear: 0, years: 3, remaining: 50000 };
    // planYear 3 is the 4th FY since trigger (0,1,2 are the 3-year
    // window) — expired.
    const r = processNonConcessionalCap({
      requestedNCC: 100000, baseCap: BASE_CAP, tsbPriorJune: 1000000, thresholds: THRESHOLDS, bringForward: stale, planYear: 3,
    });
    expect(r.accepted).toBe(100000);
    expect(r.bringForward).toBeNull(); // back to the flat annual cap (no new trigger, since 100k <= 130k)
  });
});

describe("div293Tax", () => {
  // Known-value cases hand-checked against the tool's formula:
  //   div293Income = taxableIncome + reportableSuperContributions + lowTaxContributions
  //   tax = rate × min(lowTaxContributions, div293Income − threshold)
  it("below the threshold: no tax", () => {
    const r = div293Tax({ taxableIncome: 200000, reportableSuperContributions: 10000, lowTaxContributions: 20000, threshold: 250000, rate: 0.15 });
    // div293Income = 230,000 < 250,000 threshold.
    expect(r.div293Income).toBe(230000);
    expect(r.tax).toBe(0);
  });

  it("over the threshold, low-tax contributions are the binding (smaller) amount", () => {
    const r = div293Tax({ taxableIncome: 260000, reportableSuperContributions: 10000, lowTaxContributions: 15000, threshold: 250000, rate: 0.15 });
    // div293Income = 285,000; over threshold by 35,000; lesser of (15,000, 35,000) = 15,000.
    expect(r.div293Income).toBe(285000);
    expect(r.tax).toBeCloseTo(0.15 * 15000, 6);
  });

  it("over the threshold, the excess-over-threshold amount is the binding (smaller) amount — the lesser-of boundary", () => {
    const r = div293Tax({ taxableIncome: 249000, reportableSuperContributions: 0, lowTaxContributions: 30000, threshold: 250000, rate: 0.15 });
    // div293Income = 279,000; over threshold by 29,000; lesser of (30,000, 29,000) = 29,000.
    expect(r.div293Income).toBe(279000);
    expect(r.tax).toBeCloseTo(0.15 * 29000, 6);
  });

  it("exactly at the lesser-of boundary (equal values) still taxes the shared amount once", () => {
    const r = div293Tax({ taxableIncome: 250000, reportableSuperContributions: 0, lowTaxContributions: 20000, threshold: 250000, rate: 0.15 });
    // div293Income = 270,000; over threshold by 20,000 = lowTaxContributions exactly.
    expect(r.tax).toBeCloseTo(0.15 * 20000, 6);
  });
});
