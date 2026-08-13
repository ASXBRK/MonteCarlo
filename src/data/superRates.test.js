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

  it("SG rate, maximum salary, and contribution age settings", () => {
    expect(SUPER_RATES_BASE.sgRate).toBe(0.12);
    expect(SUPER_RATES_BASE.sgMaximumSalary).toBe(270830);
    expect(SUPER_RATES_BASE.contributionAgeLimit).toBe(75);
    expect(SUPER_RATES_BASE.workTestAges).toEqual([67, 74]);
    expect(SUPER_RATES_BASE.preservationAge).toBe(60);
    expect(SUPER_RATES_BASE.unrestrictedAccessAge).toBe(65);
  });
});

describe("superRatesFor — indexation asymmetry", () => {
  it("indexed mode (default): every cap stays at its real FY2026/27 value indefinitely", () => {
    const r0 = superRatesFor(2026, "indexed", 0.025);
    const r10 = superRatesFor(2036, "indexed", 0.025);
    expect(r10.concessionalCap).toBe(r0.concessionalCap);
    expect(r10.nonConcessionalCap).toBe(r0.nonConcessionalCap);
    expect(r10.sgMaximumSalary).toBe(r0.sgMaximumSalary);
    expect(r10.bringForwardTsbThresholds).toEqual(r0.bringForwardTsbThresholds);
  });

  it("indexed mode: div293Threshold still shrinks in real terms (not indexed in law)", () => {
    const r0 = superRatesFor(2026, "indexed", 0.025);
    const r10 = superRatesFor(2036, "indexed", 0.025);
    expect(r0.div293Threshold).toBe(250000);
    expect(r10.div293Threshold).toBeCloseTo(250000 / Math.pow(1.025, 10), 6);
    expect(r10.div293Threshold).toBeLessThan(r0.div293Threshold);
  });

  it("frozen mode: every scaled cap shrinks in real terms by the same factor", () => {
    const r10 = superRatesFor(2036, "frozen", 0.025);
    const k = Math.pow(1.025, 10);
    expect(r10.concessionalCap).toBeCloseTo(32500 / k, 6);
    expect(r10.nonConcessionalCap).toBeCloseTo(130000 / k, 6);
    expect(r10.carryForwardTsbGate).toBeCloseTo(500000 / k, 6);
    expect(r10.sgMaximumSalary).toBeCloseTo(270830 / k, 6);
    expect(r10.bringForwardTsbThresholds.full).toBeCloseTo(1840000 / k, 6);
  });

  it("frozen mode: div293Threshold shrinks identically to indexed mode (the asymmetry — it never depends on bracketMode)", () => {
    const frozen = superRatesFor(2036, "frozen", 0.025);
    const indexed = superRatesFor(2036, "indexed", 0.025);
    expect(frozen.div293Threshold).toBe(indexed.div293Threshold);
  });

  it("flat rates and ages never scale under either mode", () => {
    for (const mode of ["indexed", "frozen"]) {
      const r = superRatesFor(2036, mode, 0.025);
      expect(r.contributionsTaxRate).toBe(0.15);
      expect(r.earningsTaxRate).toBe(0.15);
      expect(r.div293Rate).toBe(0.15);
      expect(r.sgRate).toBe(0.12);
      expect(r.contributionAgeLimit).toBe(75);
      expect(r.preservationAge).toBe(60);
    }
  });

  it("the base FY (2026-27) is unscaled under frozen mode too", () => {
    const r = superRatesFor(2026, "frozen", 0.025);
    expect(r.concessionalCap).toBe(32500);
    expect(r.div293Threshold).toBe(250000);
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
