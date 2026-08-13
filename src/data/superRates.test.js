import { describe, it, expect } from "vitest";
import { SUPER_RATES_BASE, superRatesFor, superReleaseAge } from "./superRates.js";

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
    expect(SUPER_RATES_BASE.untaxedPlanCap).toBe(1905000);
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
    expect(r10.untaxedPlanCap).toBeCloseTo(1905000 / k, 6);
    expect(r10.nonConcessionalCap).toBeCloseTo(130000 / k, 6);
    expect(r10.sgMaximumSalary).toBeCloseTo(270830 / k, 6);
    expect(r10.bringForwardTsbThresholds.full).toBeCloseTo(1840000 / k, 6);
    expect(r10.bringForwardTsbThresholds.two).toBeCloseTo(1970000 / k, 6);
    expect(r10.bringForwardTsbThresholds.one).toBeCloseTo(2100000 / k, 6);
    expect(r10.div296LowerThreshold).toBeCloseTo(3000000 / k, 6);
    expect(r10.div296UpperThreshold).toBeCloseTo(10000000 / k, 6);
  });

  it("Division 296 thresholds ARE indexed under the default mode (unlike the lapsed 2023 design) — CPI, $100,000 steps, same mechanism as the transfer balance cap", () => {
    const cpi = 0.025;
    const r0 = superRatesFor(2026, "indexed", cpi, 0.035);
    const r20 = superRatesFor(2046, "indexed", cpi, 0.035);
    expect(r0.div296LowerThreshold).toBe(3000000);
    expect(r0.div296UpperThreshold).toBe(10000000);
    const nomLower20 = Math.round(r20.div296LowerThreshold * Math.pow(1 + cpi, 20));
    expect(nomLower20).toBeGreaterThan(3000000);
    expect(nomLower20 % 100000).toBe(0);
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
