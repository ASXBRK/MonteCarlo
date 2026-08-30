import { describe, it, expect } from "vitest";
import {
  formerHomeAssessedValueForMeansTest, formerHomeValueForAccommodationAssessment,
  formerHomeRentTreatment, agedCareAssessableAssets,
  oldRegimeIncomeTestedAmount, oldRegimeAssetsTestedAmount, oldRegimeMeansTestedFee,
  newRegimeIncomeTestedAmount, newRegimeAssetsTestedAmount, newRegimeContributions,
  agedCareRegimeFor,
} from "./agedCareMeansTest.js";
import { agedCareRatesFor } from "./data/agedCare.js";

const rates = agedCareRatesFor(2026, "indexed", 0.025);

describe("agedCareMeansTest.js — means testing and former home (spec 29, BBB-sourced)", () => {
  describe("former home — TWO treatments of the same asset", () => {
    it("means test: capped at $214,884 per person, not market value", () => {
      expect(formerHomeAssessedValueForMeansTest({ marketValue: 900000, occupiedByProtectedPerson: false, cappedValuePerPerson: 214884 })).toBe(214884);
      expect(formerHomeAssessedValueForMeansTest({ marketValue: 150000, occupiedByProtectedPerson: false, cappedValuePerPerson: 214884 })).toBe(150000);
    });
    it("means test: fully exempt while a protected person lives there, reverting when they leave", () => {
      const occupied = formerHomeAssessedValueForMeansTest({ marketValue: 900000, occupiedByProtectedPerson: true, cappedValuePerPerson: 214884 });
      const vacated = formerHomeAssessedValueForMeansTest({ marketValue: 900000, occupiedByProtectedPerson: false, cappedValuePerPerson: 214884 });
      expect(occupied).toBe(0);
      expect(vacated).toBe(214884);
    });
    it("accommodation assessment: NOT capped — full market value", () => {
      expect(formerHomeValueForAccommodationAssessment({ marketValue: 900000, occupiedByProtectedPerson: false })).toBe(900000);
    });
    it("the same $900k home is assessed at TWO different figures for the two purposes", () => {
      const forMeansTest = formerHomeAssessedValueForMeansTest({ marketValue: 900000, occupiedByProtectedPerson: false, cappedValuePerPerson: 214884 });
      const forAccommodation = formerHomeValueForAccommodationAssessment({ marketValue: 900000, occupiedByProtectedPerson: false });
      expect(forMeansTest).toBe(214884);
      expect(forAccommodation).toBe(900000);
      expect(forAccommodation).toBeGreaterThan(forMeansTest);
    });
  });

  it("a RAD counts as an assessable asset for the aged care means test", () => {
    const withoutRad = agedCareAssessableAssets({ otherFinancialAssets: 300000, formerHome: 214884, radPaid: 0 });
    const withRad = agedCareAssessableAssets({ otherFinancialAssets: 300000, formerHome: 214884, radPaid: 500000 });
    expect(withRad - withoutRad).toBe(500000);
    expect(withRad).toBeGreaterThan(withoutRad); // the central, easy-to-invert trade-off
  });

  describe("former home rent — historically exempt for pre-2016 entrants", () => {
    it("exempts rent before 1 January 2016, assesses it from that date", () => {
      expect(formerHomeRentTreatment("2015-06-01").exempt).toBe(true);
      expect(formerHomeRentTreatment("2016-01-01").exempt).toBe(false);
    });
  });

  describe("old regime (1 Jul 2014 – 31 Oct 2025) — simple single taper, no plateau", () => {
    it("income tested amount: 50% above the single threshold", () => {
      const amount = oldRegimeIncomeTestedAmount(45313.20, false, rates); // 10,000 above $35,313.20
      expect(amount).toBeCloseTo(5000, 2);
    });
    it("income tested amount: couple uses the per-member threshold", () => {
      const amount = oldRegimeIncomeTestedAmount(44585.20, true, rates); // 10,000 above $34,585.20
      expect(amount).toBeCloseTo(5000, 2);
    });
    it("assets tested amount follows the 4-bracket table, each tier binding in turn", () => {
      expect(oldRegimeAssetsTestedAmount(50000, rates)).toBe(0); // below the nil threshold
      expect(oldRegimeAssetsTestedAmount(100000, rates)).toBeCloseTo(0.175 * (100000 - 64500), 2);
      expect(oldRegimeAssetsTestedAmount(300000, rates)).toBeCloseTo(26317.20 + 0.01 * (300000 - 214884), 2);
      expect(oldRegimeAssetsTestedAmount(600000, rates)).toBeCloseTo(29324.88 + 0.02 * (600000 - 515652), 2);
    });
    it("the fee combines both amounts, less the supplement, and each cap binds in turn", () => {
      // income $80,000, assets $400,000: incomeTested $22,343.40,
      // assetsTested $28,168.36, raw = 22343.40+28168.36-26317.20 =
      // $24,194.56 — comfortably below every cap, so "uncapped" means
      // exactly that here.
      const base = { assessableIncome: 80000, assessableAssets: 400000, isCouple: false, rates };
      const uncapped = oldRegimeMeansTestedFee(base);
      expect(uncapped.raw).toBeCloseTo(24194.56, 1);
      expect(uncapped.fee).toBeCloseTo(uncapped.raw, 6);

      const annualCapped = oldRegimeMeansTestedFee({ assessableIncome: 200000, assessableAssets: 600000, isCouple: false, rates });
      expect(annualCapped.fee).toBeCloseTo(rates.oldRegime.annualCap, 2);

      const lifetimeCapped = oldRegimeMeansTestedFee({ ...base, lifetimeCumulative: rates.oldRegime.lifetimeCap - 500 });
      expect(lifetimeCapped.fee).toBeCloseTo(500, 2);

      const subsidyCapped = oldRegimeMeansTestedFee({ ...base, subsidyAmount: 100 });
      expect(subsidyCapped.fee).toBe(100);
    });
  });

  describe("new regime (1 Nov 2025+) — literal plateau bands, not a taper", () => {
    it("income test: nil below the threshold", () => {
      expect(newRegimeIncomeTestedAmount(20000, false, rates)).toBe(0);
    });
    it("income test: tapers in the first band", () => {
      const amount = newRegimeIncomeTestedAmount(50313.20, false, rates); // 15,000 above $35,313.20
      expect(amount).toBeCloseTo(7500, 2);
    });
    it("income test: FLAT across the first plateau — same value throughout the band", () => {
      const nearStart = newRegimeIncomeTestedAmount(88000, false, rates);
      const nearEnd = newRegimeIncomeTestedAmount(101000, false, rates);
      expect(nearStart).toBeCloseTo(26317.20, 2);
      expect(nearEnd).toBeCloseTo(26317.20, 2);
      expect(nearStart).toBeCloseTo(nearEnd, 6);
    });
    it("income test: resumes tapering above the first plateau", () => {
      const amount = newRegimeIncomeTestedAmount(110000, false, rates); // partway into the second taper band
      expect(amount).toBeGreaterThan(26317.20);
      expect(amount).toBeCloseTo(26317.20 + 0.5 * (110000 - 101105.00), 1);
    });
    it("income test: FLAT across the SECOND plateau too", () => {
      const nearStart = newRegimeIncomeTestedAmount(118000, false, rates);
      const nearEnd = newRegimeIncomeTestedAmount(141000, false, rates);
      expect(nearStart).toBeCloseTo(34379.80, 1);
      expect(nearEnd).toBeCloseTo(34379.80, 1);
    });
    it("income test: couple uses its own (slightly different) thresholds", () => {
      const single = newRegimeIncomeTestedAmount(90000, false, rates);
      const couple = newRegimeIncomeTestedAmount(90000, true, rates);
      // Couple's first plateau starts at a lower income ($87,219.60 vs
      // $87,947.60) — at $90,000 both are already inside their own
      // plateau, so both equal $26,317.20, but reached via different bands.
      expect(single).toBeCloseTo(26317.20, 1);
      expect(couple).toBeCloseTo(26317.20, 1);
    });

    it("assets test: FLAT across its own two plateaus", () => {
      const plateau1a = newRegimeAssetsTestedAmount(220000, rates);
      const plateau1b = newRegimeAssetsTestedAmount(257000, rates);
      expect(plateau1a).toBeCloseTo(26317.20, 2);
      expect(plateau1b).toBeCloseTo(26317.20, 2);
      const plateau2a = newRegimeAssetsTestedAmount(362000, rates);
      const plateau2b = newRegimeAssetsTestedAmount(536000, rates);
      expect(plateau2a).toBeCloseTo(34379.80, 1);
      expect(plateau2b).toBeCloseTo(34379.80, 1);
    });

    it("ordering rule: NCCC is zero while Hotelling hasn't yet reached its own max", () => {
      const result = newRegimeContributions({ assessableIncome: 60000, assessableAssets: 100000, isCouple: false, rates });
      expect(result.hotelling).toBeLessThan(rates.newRegime.hotellingMaxAnnual);
      expect(result.nccc).toBe(0);
    });

    it("ordering rule: NCCC only starts once Hotelling is fully saturated", () => {
      const result = newRegimeContributions({ assessableIncome: 200000, assessableAssets: 700000, isCouple: false, rates });
      expect(result.hotelling).toBeCloseTo(rates.newRegime.hotellingMaxAnnual, 2);
      expect(result.nccc).toBeGreaterThan(0);
    });

    it("Hotelling has no lifetime/annual cap beyond its own daily max", () => {
      const result = newRegimeContributions({ assessableIncome: 1_000_000, assessableAssets: 5_000_000, isCouple: false, rates });
      expect(result.hotelling).toBeCloseTo(rates.newRegime.hotellingMaxAnnual, 2); // never exceeds its own max, but nothing further caps it
    });

    it("NCCC stops at its own lifetime cap even with room left in the daily max", () => {
      const result = newRegimeContributions({
        assessableIncome: 1_000_000, assessableAssets: 5_000_000, isCouple: false, rates,
        ncccLifetimeCumulative: rates.ncccLifetimeCap - 100,
      });
      expect(result.nccc).toBeCloseTo(100, 2);
      expect(result.ncccCapped).toBe(true);
    });

    it("NCCC stops at 4 years even with lifetime cap headroom remaining", () => {
      const result = newRegimeContributions({
        assessableIncome: 1_000_000, assessableAssets: 5_000_000, isCouple: false, rates,
        ncccYearsSoFar: 4,
      });
      expect(result.nccc).toBe(0);
      expect(result.ncccTimeLimitReached).toBe(true);
    });
  });

  describe("agedCareRegimeFor — regime fork by entry date, opt-in flag, never a migration", () => {
    it("an entrant before 1 Nov 2025 gets the old regime by default", () => {
      expect(agedCareRegimeFor("2024-06-01")).toBe("old");
    });
    it("an entrant from 1 Nov 2025 gets the new regime, opt-in or not", () => {
      expect(agedCareRegimeFor("2025-11-01")).toBe("new");
      expect(agedCareRegimeFor("2026-06-01", false)).toBe("new");
    });
    it("a pre-1 Nov 2025 entrant can explicitly opt in to the new regime", () => {
      expect(agedCareRegimeFor("2024-06-01", true)).toBe("new");
      expect(agedCareRegimeFor("2024-06-01", false)).toBe("old"); // never switched without the flag
    });
    it("flags a pre-1 July 2014 entry as its own unmodelled regime", () => {
      expect(agedCareRegimeFor("2013-01-01")).toBe("pre2014");
    });
  });
});
