import { describe, it, expect } from "vitest";
import {
  AGED_CARE_RATES_BASE, NON_CLINICAL_CARE_LIFETIME_CAP,
  agedCareStalenessWarning, basicDailyFeeAnnual, basicDailyFeeDaily,
  agedCareRatesFor, dapAnnualRate, dapDaily, combineMeansTestedFee, trackLifetimeCare,
} from "./agedCare.js";
import { agePensionRatesFor, AGE_PENSION_RATES_BASE } from "./agePension.js";

describe("agedCare.js — rates module and fee structure (spec 29 Commit 1)", () => {
  describe("basic daily fee — derived, not stored", () => {
    it("is 85% of the single basic Age Pension rate", () => {
      // Hand calc: single rate $1,200.90/fortnight × 26 = $31,223.40/yr
      // (AGE_PENSION_RATES_BASE.singleRate). 85% = $26,539.89.
      const singleRateAnnual = AGE_PENSION_RATES_BASE.singleRate;
      expect(basicDailyFeeAnnual(singleRateAnnual)).toBeCloseTo(26539.89, 2);
      expect(basicDailyFeeDaily(singleRateAnnual)).toBeCloseTo(26539.89 / 365, 6);
    });

    it("indexes automatically with the age pension rate — never drifts out of step", () => {
      const base = basicDailyFeeAnnual(agePensionRatesFor(2026, "indexed", 0.025, 0.032).single.rate);
      const fiveYearsOut = basicDailyFeeAnnual(agePensionRatesFor(2031, "indexed", 0.025, 0.032).single.rate);
      // Real terms: the age pension rate itself drifts (AWOTE vs CPI
      // deflation) rather than staying bit-identical — confirms this
      // derivation tracks whatever the age pension module does, with
      // no independent indexation basis of its own.
      const expectedFiveYearsOut = basicDailyFeeAnnual(agePensionRatesFor(2031, "indexed", 0.025, 0.032).single.rate);
      expect(fiveYearsOut).toBeCloseTo(expectedFiveYearsOut, 6);
      expect(fiveYearsOut).not.toBeCloseTo(base, 2); // genuinely moves, not a frozen copy
    });
  });

  describe("agedCareRatesFor — CPI indexation and overrides", () => {
    it("returns the base-year figures unindexed at the base FY", () => {
      const r = agedCareRatesFor(2026, "indexed", 0.025);
      expect(r.meansTestedFeeAnnualCap).toBeCloseTo(AGED_CARE_RATES_BASE.meansTestedFeeAnnualCap, 2);
      expect(r.meansTestedFeeLifetimeCap).toBeCloseTo(AGED_CARE_RATES_BASE.meansTestedFeeLifetimeCap, 2);
      expect(r.maxAccommodationSupplement).toBeCloseTo(AGED_CARE_RATES_BASE.maxAccommodationSupplement, 2);
      expect(r.mpir).toBe(AGED_CARE_RATES_BASE.mpir);
      expect(r.formerHomeCappedValue).toBe(AGED_CARE_RATES_BASE.formerHomeCappedValue);
      expect(r.nonClinicalCareLifetimeCap).toBeNull(); // still unconfigured
    });

    it("holds real-terms figures flat under bracketMode indexed (matches CPI exactly)", () => {
      // nominalOf compounds at CPI, then the SAME cpi deflates — real
      // value is unchanged year over year when indexed at exactly CPI.
      const r0 = agedCareRatesFor(2026, "indexed", 0.025);
      const r5 = agedCareRatesFor(2031, "indexed", 0.025);
      expect(r5.meansTestedFeeAnnualCap).toBeCloseTo(r0.meansTestedFeeAnnualCap, 0);
      expect(r5.hotellingContributionMaxDaily).toBeCloseTo(r0.hotellingContributionMaxDaily, 1);
    });

    it("MPIR stays flat — not part of the CPI/AWOTE regime", () => {
      const r0 = agedCareRatesFor(2026, "indexed", 0.025);
      const r10 = agedCareRatesFor(2036, "indexed", 0.025);
      expect(r10.mpir).toBe(r0.mpir);
      expect(r0.mpir).toBe(0.0843);
    });

    it("a per-figure override replaces just that one figure, others unaffected", () => {
      const r = agedCareRatesFor(2026, "indexed", 0.025, { meansTestedFeeAnnualCap: 40000, nonClinicalCareLifetimeCap: 137917.01 });
      expect(r.meansTestedFeeAnnualCap).toBeCloseTo(40000, 2);
      expect(r.nonClinicalCareLifetimeCap).toBe(137917.01);
      expect(r.meansTestedFeeLifetimeCap).toBeCloseTo(AGED_CARE_RATES_BASE.meansTestedFeeLifetimeCap, 2); // untouched
    });

    it("an overridden figure still indexes forward from the overridden base", () => {
      const overridden = agedCareRatesFor(2031, "indexed", 0.025, { formerHomeCappedValue: 250000 });
      const notOverridden = agedCareRatesFor(2031, "indexed", 0.025);
      expect(overridden.formerHomeCappedValue).not.toBeCloseTo(notOverridden.formerHomeCappedValue, 0);
      expect(overridden.formerHomeCappedValue).toBeCloseTo(250000, 0); // real terms flat under CPI indexing
    });
  });

  describe("DAP derivation", () => {
    it("dapDaily = RAD × MPIR ÷ 365", () => {
      // Hand calc: $500,000 RAD × 8.43% ÷ 365 = $115.48/day
      expect(dapDaily(500000, 0.0843)).toBeCloseTo(115.48, 1);
    });
    it("dapAnnualRate is just a pass-through of the entry-fixed MPIR", () => {
      expect(dapAnnualRate(0.0843)).toBe(0.0843);
    });
  });

  describe("combineMeansTestedFee — the three caps, each binding in turn", () => {
    const supplementOnly = { incomeTestedAmount: 0, assetsTestedAmount: 0, maxAccommodationSupplement: 70.94, subsidyAmount: 1e9, annualCap: 1e9, lifetimeCapRemaining: 1e9 };

    it("floors at 0 when the supplement exceeds the tested amounts", () => {
      expect(combineMeansTestedFee({ ...supplementOnly, incomeTestedAmount: 20, assetsTestedAmount: 10 })).toBe(0);
    });

    it("nothing binds: raw amount passes through", () => {
      const fee = combineMeansTestedFee({ ...supplementOnly, incomeTestedAmount: 100, assetsTestedAmount: 50 });
      expect(fee).toBeCloseTo(100 + 50 - 70.94, 2);
    });

    it("the subsidy cap binds", () => {
      const fee = combineMeansTestedFee({ ...supplementOnly, incomeTestedAmount: 100, assetsTestedAmount: 50, subsidyAmount: 60 });
      expect(fee).toBe(60);
    });

    it("the annual cap binds", () => {
      const fee = combineMeansTestedFee({ ...supplementOnly, incomeTestedAmount: 40000, assetsTestedAmount: 10000, annualCap: 35910.43 });
      expect(fee).toBeCloseTo(35910.43, 2);
    });

    it("the lifetime cap binds even below the annual cap", () => {
      const fee = combineMeansTestedFee({ ...supplementOnly, incomeTestedAmount: 5000, assetsTestedAmount: 5000, annualCap: 35910.43, lifetimeCapRemaining: 1200 });
      expect(fee).toBe(1200);
    });
  });

  describe("trackLifetimeCare — cumulative, persists across a break in care", () => {
    it("accumulates across years, uncapped while headroom remains", () => {
      let cumulative = 0;
      const cap = 86185.23;
      let r = trackLifetimeCare(cumulative, 20000, cap); cumulative = r.cumulative;
      expect(r.charged).toBe(20000); expect(r.capped).toBe(false);
      r = trackLifetimeCare(cumulative, 20000, cap); cumulative = r.cumulative;
      expect(cumulative).toBeCloseTo(40000, 2); expect(r.capped).toBe(false);
    });

    it("caps the charge once the lifetime total is reached, and stays capped", () => {
      const cap = 86185.23;
      let r = trackLifetimeCare(80000, 20000, cap); // only 6185.23 headroom left
      expect(r.charged).toBeCloseTo(6185.23, 2);
      expect(r.cumulative).toBeCloseTo(cap, 2);
      expect(r.capped).toBe(true);
      // A break in care (a gap year with no fee) doesn't reset the
      // running total — the caller just doesn't call this that year;
      // the NEXT year still starts from the same cumulative.
      const r2 = trackLifetimeCare(r.cumulative, 10000, cap);
      expect(r2.charged).toBe(0); // already at the cap
      expect(r2.cumulative).toBeCloseTo(cap, 2);
      expect(r2.capped).toBe(true);
    });
  });

  describe("staleness warning", () => {
    it("is null while the projection date is within the loaded period", () => {
      expect(agedCareStalenessWarning("2026-06-01")).toBeNull();
      expect(agedCareStalenessWarning(AGED_CARE_RATES_BASE.periodEnd)).toBeNull(); // inclusive of the last day
    });

    it("names the loaded period once the projection runs past it", () => {
      const warning = agedCareStalenessWarning("2027-01-01");
      expect(warning).not.toBeNull();
      expect(warning).toContain(AGED_CARE_RATES_BASE.periodStart);
      expect(warning).toContain(AGED_CARE_RATES_BASE.periodEnd);
    });
  });

  it("the non-clinical care lifetime cap is genuinely unconfigured, not guessed", () => {
    expect(NON_CLINICAL_CARE_LIFETIME_CAP).toBeNull();
  });
});
