import { describe, it, expect } from "vitest";
import { SUPER_RATES_BASE, superRatesFor, superReleaseAge } from "./superRates.js";
import { div296Tax } from "../Tax/div296.js";

// Source-figure spot checks (encoding tests verify the encoding, not
// the source — CLAUDE.md convention). Hand-checked against the spec's
// FY2026/27 figures.
describe("SUPER_RATES_BASE — FY2026/27 source-figure spot checks", () => {
  it("carries the as-at date and source", () => {
    expect(SUPER_RATES_BASE.asAt).toBe("2026-07-01");
    expect(SUPER_RATES_BASE.source).toMatch(/Macquarie/);
  });

  it("concessional and non-concessional caps", () => {
    expect(SUPER_RATES_BASE.concessionalCap).toBe(32500);
    expect(SUPER_RATES_BASE.nonConcessionalCap).toBe(130000);
  });

  it("general transfer balance cap and untaxed plan cap", () => {
    expect(SUPER_RATES_BASE.generalTransferBalanceCap).toBe(2100000);
    expect(SUPER_RATES_BASE.untaxedPlanCap).toBe(1935000);
  });

  it("bring-forward TSB thresholds", () => {
    expect(SUPER_RATES_BASE.bringForwardTsbThresholds).toEqual({
      full: 1840000, two: 1970000, one: 2100000,
    });
  });

  it("carry-forward gate and window", () => {
    expect(SUPER_RATES_BASE.carryForwardTsbGate).toBe(500000);
    expect(SUPER_RATES_BASE.carryForwardYears).toBe(5);
  });

  it("contributions and earnings tax rates", () => {
    expect(SUPER_RATES_BASE.contributionsTaxRate).toBe(0.15);
    expect(SUPER_RATES_BASE.earningsTaxRate).toBe(0.15);
  });

  it("Division 293 threshold and rate", () => {
    expect(SUPER_RATES_BASE.div293Threshold).toBe(250000);
    expect(SUPER_RATES_BASE.div293Rate).toBe(0.15);
  });

  it("Division 296 thresholds", () => {
    expect(SUPER_RATES_BASE.div296LowerThreshold).toBe(3000000);
    expect(SUPER_RATES_BASE.div296UpperThreshold).toBe(10000000);
  });

  it("SG rate, maximum salary, and contribution age settings", () => {
    expect(SUPER_RATES_BASE.sgRate).toBe(0.12);
    expect(SUPER_RATES_BASE.sgMaximumSalary).toBe(270830);
    expect(SUPER_RATES_BASE.contributionAgeLimit).toBe(75);
    expect(SUPER_RATES_BASE.workTestAges).toEqual([67, 74]);
    expect(SUPER_RATES_BASE.preservationAge).toBe(60);
    expect(SUPER_RATES_BASE.unrestrictedAccessAge).toBe(65);
  });
});

// Super thresholds Commit 1: each figure indexes on its OWN legislated
// basis and rounding step, compounded nominally from the FY2026/27 base
// year and only deflated to real afterwards — so real values step
// irregularly rather than staying perfectly flat. This replaces the
// pre-Commit-1 model, which (incorrectly) held every cap uniformly
// constant in real terms under "indexed" mode.
describe("superRatesFor — per-figure indexation bases and rounding (Commit 1)", () => {
  it("concessional cap at FY2026/27 is exactly $32,500", () => {
    expect(superRatesFor(2026, "indexed", 0.025, 0.035).concessionalCap).toBe(32500);
  });

  it("nominal concessional cap in year 10 matches hand-computed AWOTE compounding, rounded down to $2,500", () => {
    // 32,500 × 1.035^10 = 32,500 × 1.410598986... = 45,844.47 nominal →
    // floor to the nearest $2,500 = $45,000 nominal; real = that ÷ 1.025^10.
    const nominalY10 = Math.floor((32500 * Math.pow(1.035, 10)) / 2500) * 2500;
    expect(nominalY10).toBe(45000);
    const r = superRatesFor(2036, "indexed", 0.025, 0.035);
    expect(r.concessionalCap).toBeCloseTo(nominalY10 / Math.pow(1.025, 10), 4);
  });

  it("non-concessional cap is always exactly 4× the concessional cap, every FY", () => {
    for (const fy of [2026, 2027, 2031, 2036, 2050]) {
      const r = superRatesFor(fy, "indexed", 0.025, 0.035);
      expect(r.nonConcessionalCap).toBeCloseTo(r.concessionalCap * 4, 6);
    }
  });

  it("the general transfer balance cap steps in whole $100,000 nominal increments, never gliding smoothly, and never decreases", () => {
    const cpi = 0.025;
    let prevNominal = null;
    for (let fy = 2026; fy <= 2046; fy++) {
      const r = superRatesFor(fy, "indexed", cpi, 0.035);
      const nominal = Math.round(r.generalTransferBalanceCap * Math.pow(1 + cpi, fy - 2026));
      if (prevNominal != null) {
        expect((nominal - prevNominal) % 100000).toBe(0);
        expect(nominal).toBeGreaterThanOrEqual(prevNominal);
      }
      prevNominal = nominal;
    }
    // and over 20 years at 2.5% CPI it does step up at least once.
    expect(prevNominal).toBeGreaterThan(2100000);
  });

  it("bring-forward TSB thresholds are always derived from the general transfer balance cap, not independently indexed", () => {
    const r = superRatesFor(2036, "indexed", 0.025, 0.035);
    expect(r.bringForwardTsbThresholds.one).toBeCloseTo(r.generalTransferBalanceCap, 6);
    expect(r.bringForwardTsbThresholds.two).toBeCloseTo(r.generalTransferBalanceCap - r.nonConcessionalCap, 6);
    expect(r.bringForwardTsbThresholds.full).toBeCloseTo(r.generalTransferBalanceCap - 2 * r.nonConcessionalCap, 6);
  });

  it("sgMaximumSalary tracks the concessional cap and sgRate, floored to the nearest $10 in nominal dollars", () => {
    // 32,500 / 0.12 = 270,833.33 → floor to nearest $10 = 270,830.
    expect(superRatesFor(2026, "indexed", 0.025, 0.035).sgMaximumSalary).toBe(270830);
  });

  it("carryForwardTsbGate and div293Threshold: constant nominal, declining real, under EITHER bracketMode (the disclosed asymmetry)", () => {
    for (const mode of ["indexed", "frozen"]) {
      const r0 = superRatesFor(2026, mode, 0.025);
      const r10 = superRatesFor(2036, mode, 0.025);
      const k = Math.pow(1.025, 10);
      expect(r0.carryForwardTsbGate).toBe(500000);
      expect(r0.div293Threshold).toBe(250000);
      expect(r10.carryForwardTsbGate).toBeCloseTo(500000 / k, 6);
      expect(r10.div293Threshold).toBeCloseTo(250000 / k, 6);
      expect(r10.carryForwardTsbGate).toBeLessThan(r0.carryForwardTsbGate);
    }
  });

  it('the "no indexation" toggle (bracketMode "frozen") freezes every indexed figure nominally — only CPI deflation moves the real value', () => {
    const r10 = superRatesFor(2036, "frozen", 0.025, 0.035);
    const k = Math.pow(1.025, 10);
    expect(r10.concessionalCap).toBeCloseTo(32500 / k, 6);
    expect(r10.generalTransferBalanceCap).toBeCloseTo(2100000 / k, 6);
    expect(r10.untaxedPlanCap).toBeCloseTo(1935000 / k, 6);
    expect(r10.nonConcessionalCap).toBeCloseTo(130000 / k, 6);
    expect(r10.sgMaximumSalary).toBeCloseTo(270830 / k, 6);
    expect(r10.bringForwardTsbThresholds.full).toBeCloseTo(1840000 / k, 6);
    expect(r10.bringForwardTsbThresholds.two).toBeCloseTo(1970000 / k, 6);
    expect(r10.bringForwardTsbThresholds.one).toBeCloseTo(2100000 / k, 6);
    expect(r10.div296LowerThreshold).toBeCloseTo(3000000 / k, 6);
    expect(r10.div296UpperThreshold).toBeCloseTo(10000000 / k, 6);
  });

  it("Division 296 thresholds ARE indexed under the default mode (unlike the lapsed 2023 design) — CPI, but each with its OWN distinct rounding step: $150,000 for the lower threshold, $500,000 for the upper", () => {
    const cpi = 0.025;
    const r0 = superRatesFor(2026, "indexed", cpi, 0.035);
    const r20 = superRatesFor(2046, "indexed", cpi, 0.035);
    expect(r0.div296LowerThreshold).toBe(3000000);
    expect(r0.div296UpperThreshold).toBe(10000000);
    const nomLower20 = Math.round(r20.div296LowerThreshold * Math.pow(1 + cpi, 20));
    const nomUpper20 = Math.round(r20.div296UpperThreshold * Math.pow(1 + cpi, 20));
    expect(nomLower20).toBeGreaterThan(3000000);
    expect(nomLower20 % 150000).toBe(0);
    expect(nomUpper20).toBeGreaterThan(10000000);
    expect(nomUpper20 % 500000).toBe(0);
  });

  it("the untaxed plan cap steps in whole $5,000 nominal increments on AWOTE, never gliding smoothly, never decreasing", () => {
    const awote = 0.035;
    let prevNominal = null;
    for (let fy = 2026; fy <= 2036; fy++) {
      const r = superRatesFor(fy, "indexed", 0.025, awote);
      const nominal = Math.round(r.untaxedPlanCap * Math.pow(1.025, fy - 2026));
      if (prevNominal != null) {
        expect((nominal - prevNominal) % 5000).toBe(0);
        expect(nominal).toBeGreaterThanOrEqual(prevNominal);
      }
      prevNominal = nominal;
    }
    expect(prevNominal).toBeGreaterThan(1935000);
  });

  it('the Division 296 $3m threshold is basis-sensitive to CPI, not AWOTE — a materially different rate would move it a different amount, and this confirms it is the CPI figure that lands', () => {
    // AWOTE (3.5%) and CPI (2.5%) diverge deliberately here so a
    // basis mix-up (indexing to AWOTE instead of CPI, the original
    // placeholder mistake this commit confirms was NOT shipped) would
    // fail this assertion.
    const cpi = 0.025, awote = 0.05;
    const r1 = superRatesFor(2027, "indexed", cpi, awote);
    const nominal1 = Math.round(r1.div296LowerThreshold * Math.pow(1 + cpi, 1));
    // 3,000,000 × 1.025¹ = 3,075,000 → floor to $150,000 = 3,000,000
    // (CPI basis, unchanged). Had AWOTE (5% here) been used instead,
    // 3,000,000 × 1.05¹ = 3,150,000 → floor = 3,150,000 (a full step,
    // one year early) — the two bases are far enough apart at year 1
    // that this distinguishes them unambiguously.
    expect(nominal1).toBe(3000000);
  });

  it("Division 296 $3m threshold: does NOT move in year 1 (cumulative CPI hasn't yet implied a full $150,000 increment), then steps by exactly $150,000 in year 2 — step indexation, not continuous", () => {
    const cpi = 0.025, awote = 0.035;
    const r0 = superRatesFor(2026, "indexed", cpi, awote);
    const r1 = superRatesFor(2027, "indexed", cpi, awote);
    const r2 = superRatesFor(2028, "indexed", cpi, awote);
    const nominalAt = (r, t) => Math.round(r.div296LowerThreshold * Math.pow(1 + cpi, t));
    expect(nominalAt(r0, 0)).toBe(3000000);
    expect(nominalAt(r1, 1)).toBe(3000000); // unchanged — 3,075,000 still floors to 3,000,000
    expect(nominalAt(r2, 2)).toBe(3150000); // 3,151,875 floors to exactly one $150,000 step up
    expect(nominalAt(r2, 2) - nominalAt(r1, 1)).toBe(150000);
  });

  it("a client comfortably under the Division 296 $3m threshold is never assessed, in any early year, purely from the threshold's real-terms erosion between steps", () => {
    // The threshold's REAL value legitimately drifts down a little
    // every year it hasn't stepped (disclosed in superRates.js's
    // header: nominal is flat, CPI deflation still applies) — that is
    // the corrected, intended behaviour, not something to hide. What
    // must NOT happen is a client comfortably below $3m ever being
    // caught by that drift alone, the way an accidentally-unindexed
    // threshold (held nominally flat forever, like div293Threshold)
    // would eventually catch them through unbounded erosion.
    const cpi = 0.025, awote = 0.035;
    const comfortablyUnder = 2500000; // real dollars, well clear of the erosion band around $3m
    for (let fy = 2026; fy <= 2036; fy++) {
      const r = superRatesFor(fy, "indexed", cpi, awote);
      const { tax } = div296Tax({
        openingTsb: comfortablyUnder, closingTsb: comfortablyUnder, earnings: 50000,
        lowerThreshold: r.div296LowerThreshold, upperThreshold: r.div296UpperThreshold,
      });
      expect(tax).toBe(0);
    }
  });

  it("flat rates and ages never scale under either mode", () => {
    for (const mode of ["indexed", "frozen"]) {
      const r = superRatesFor(2036, mode, 0.025, 0.035);
      expect(r.contributionsTaxRate).toBe(0.15);
      expect(r.earningsTaxRate).toBe(0.15);
      expect(r.div293Rate).toBe(0.15);
      expect(r.sgRate).toBe(0.12);
      expect(r.contributionAgeLimit).toBe(75);
      expect(r.preservationAge).toBe(60);
    }
  });

  it("the base FY (2026-27) is unscaled under frozen mode too", () => {
    const r = superRatesFor(2026, "frozen", 0.025, 0.035);
    expect(r.concessionalCap).toBe(32500);
    expect(r.div293Threshold).toBe(250000);
    expect(r.generalTransferBalanceCap).toBe(2100000);
  });
});

describe("superReleaseAge — condition of release", () => {
  it("retiring before preservation age still can't release before 60", () => {
    expect(superReleaseAge(55)).toBe(60);
  });
  it("retiring between 60 and 65 releases at the retirement age", () => {
    expect(superReleaseAge(62)).toBe(62);
  });
  it("retiring at or after 65 releases at the unrestricted-access age (65), not later", () => {
    expect(superReleaseAge(70)).toBe(65);
  });
  it("retiring exactly at preservation age releases at 60", () => {
    expect(superReleaseAge(60)).toBe(60);
  });
});
