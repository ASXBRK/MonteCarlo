import { describe, it, expect } from "vitest";
import {
  AGED_CARE_RATES_BASE, NCCC_LIFETIME_CAP,
  agedCareStalenessWarning, basicDailyFeeAnnual, basicDailyFeeDaily,
  agedCareRatesFor, evaluateTieredAmount, dapAnnualRate, dapDaily,
  combinationPayment, radRefundOnExit, radRealValueAtYear, trackLifetimeCare,
} from "./agedCare.js";
import { agePensionRatesFor, AGE_PENSION_RATES_BASE } from "./agePension.js";

describe("agedCare.js — rates module and fee structure (spec 29, BBB-sourced)", () => {
  describe("basic daily fee — derived from the age pension's BASIC rate, excluding supplements", () => {
    it("reproduces the BBB's own $66.80/day at the base period", () => {
      // Hand calc (BBB): fortnightly all-inclusive $1,200.90, incl.
      // pension supplement $86.50 and energy supplement $14.10 — base
      // $1,100.30/fortnight. 85% of that = $935.255/fortnight, ÷ 14 =
      // $66.804/day.
      const singleRateAnnual = AGE_PENSION_RATES_BASE.singleRate; // 1200.90 * 26
      expect(basicDailyFeeDaily(singleRateAnnual)).toBeCloseTo(66.80, 1);
      expect(basicDailyFeeAnnual(singleRateAnnual)).toBeCloseTo(66.80 * 365, -1); // nearest $10 — small rounding vs the published daily figure
    });

    it("indexes automatically with the age pension rate — never drifts out of step", () => {
      const base = basicDailyFeeDaily(agePensionRatesFor(2026, "indexed", 0.025, 0.032).single.rate);
      const fiveYearsOut = basicDailyFeeDaily(agePensionRatesFor(2031, "indexed", 0.025, 0.032).single.rate);
      const expectedFiveYearsOut = basicDailyFeeDaily(agePensionRatesFor(2031, "indexed", 0.025, 0.032).single.rate);
      expect(fiveYearsOut).toBeCloseTo(expectedFiveYearsOut, 6);
      expect(fiveYearsOut).not.toBeCloseTo(base, 2);
    });
  });

  describe("evaluateTieredAmount — the shared bracket-walk mechanics", () => {
    const brackets = [
      { from: 0, to: 100, mode: "nil", base: 0, rate: 0 },
      { from: 100, to: 200, mode: "taper", base: 0, rate: 0.5 },
      { from: 200, to: 300, mode: "flat", base: 50, rate: 0 }, // literal plateau
      { from: 300, to: Infinity, mode: "taper", base: 50, rate: 0.1 },
    ];
    it("nil below the first threshold", () => {
      expect(evaluateTieredAmount(50, brackets)).toBe(0);
    });
    it("tapers within a taper bracket", () => {
      expect(evaluateTieredAmount(150, brackets)).toBeCloseTo(25, 6); // 0.5*(150-100)
    });
    it("stays FLAT across a plateau band — not a taper", () => {
      expect(evaluateTieredAmount(210, brackets)).toBe(50);
      expect(evaluateTieredAmount(290, brackets)).toBe(50); // same value near the far end of the plateau
      expect(evaluateTieredAmount(210, brackets)).toBe(evaluateTieredAmount(290, brackets));
    });
    it("resumes tapering from the plateau's own base above it", () => {
      expect(evaluateTieredAmount(320, brackets)).toBeCloseTo(52, 6); // 50 + 0.1*(320-300)
    });
    it("handles a value at or above the last bracket's own threshold", () => {
      expect(evaluateTieredAmount(1_000_000, brackets)).toBeCloseTo(50 + 0.1 * (1_000_000 - 300), 4);
    });
  });

  describe("agedCareRatesFor — CPI indexation and overrides", () => {
    it("returns the base-year figures unindexed at the base FY", () => {
      const r = agedCareRatesFor(2026, "indexed", 0.025);
      expect(r.maxAccommodationSupplementAnnual).toBeCloseTo(26317.20, 2);
      expect(r.oldRegime.annualCap).toBeCloseTo(35910.43, 2);
      expect(r.oldRegime.lifetimeCap).toBeCloseTo(86185.23, 2);
      expect(r.ncccLifetimeCap).toBeCloseTo(137917.01, 2);
      expect(r.mpir).toBe(AGED_CARE_RATES_BASE.mpir);
      expect(r.formerHomeCappedValuePerPerson).toBe(214884);
    });

    it("holds real-terms figures flat under bracketMode indexed (matches CPI exactly)", () => {
      const r0 = agedCareRatesFor(2026, "indexed", 0.025);
      const r5 = agedCareRatesFor(2031, "indexed", 0.025);
      expect(r5.oldRegime.annualCap).toBeCloseTo(r0.oldRegime.annualCap, 0);
      expect(r5.newRegime.hotellingMaxAnnual).toBeCloseTo(r0.newRegime.hotellingMaxAnnual, -1);
    });

    it("MPIR stays flat — not part of the CPI/AWOTE regime, and is flagged unconfirmed", () => {
      const r0 = agedCareRatesFor(2026, "indexed", 0.025);
      const r10 = agedCareRatesFor(2036, "indexed", 0.025);
      expect(r10.mpir).toBe(r0.mpir);
      expect(r0.mpir).toBe(0.0796);
      expect(r0.mpirNeedsConfirmation).toBe(true);
    });

    it("an MPIR override clears the needs-confirmation flag", () => {
      const r = agedCareRatesFor(2026, "indexed", 0.025, { mpir: 0.0843 });
      expect(r.mpir).toBe(0.0843);
      expect(r.mpirNeedsConfirmation).toBe(false);
    });

    it("a per-figure override replaces just that one figure, others unaffected", () => {
      const r = agedCareRatesFor(2026, "indexed", 0.025, { hotellingMaxAnnual: 9000 });
      expect(r.newRegime.hotellingMaxAnnual).toBeCloseTo(9000, 2);
      expect(r.oldRegime.annualCap).toBeCloseTo(AGED_CARE_RATES_BASE.oldRegime.annualCap, 2); // untouched
    });
  });

  describe("DAP derivation", () => {
    it("dapDaily = RAD × MPIR ÷ 365 (BBB's own 7.96% figure)", () => {
      expect(dapDaily(500000, 0.0796)).toBeCloseTo((500000 * 0.0796) / 365, 4);
    });
    it("dapAnnualRate is just a pass-through of the entry-fixed MPIR", () => {
      expect(dapAnnualRate(0.0796)).toBe(0.0796);
    });
  });

  describe("combinationPayment — RAD/DAP/combination are one function", () => {
    it("RAD in full: no unpaid balance, no DAP", () => {
      const r = combinationPayment({ accommodationPrice: 500000, radPaid: 500000, mpirAtEntry: 0.0796 });
      expect(r.unpaidBalance).toBe(0);
      expect(r.dapAnnual).toBe(0);
    });
    it("DAP in full: the whole price is unpaid, DAP on the full amount", () => {
      const r = combinationPayment({ accommodationPrice: 500000, radPaid: 0, mpirAtEntry: 0.0796 });
      expect(r.unpaidBalance).toBe(500000);
      expect(r.dapAnnual).toBeCloseTo(500000 * 0.0796, 2);
    });
    it("combination: DAP calculated on the UNPAID balance only", () => {
      const r = combinationPayment({ accommodationPrice: 500000, radPaid: 300000, mpirAtEntry: 0.0796 });
      expect(r.unpaidBalance).toBe(200000);
      expect(r.dapAnnual).toBeCloseTo(200000 * 0.0796, 2);
    });
  });

  describe("radRefundOnExit — retention only for 1 Nov 2025+ entrants", () => {
    it("a pre-1 Nov 2025 entrant gets the full RAD back regardless of any rate passed", () => {
      const r = radRefundOnExit({ radPaid: 500000, yearsInCare: 8, enteredFrom1Nov2025: false, retentionRatePerYear: 0.02 });
      expect(r.refund).toBe(500000);
      expect(r.retained).toBe(0);
    });
    it("a 1 Nov 2025+ entrant has 2%/yr retained, capped at 5 years (10% max)", () => {
      const r = radRefundOnExit({ radPaid: 500000, yearsInCare: 8, enteredFrom1Nov2025: true });
      expect(r.retained).toBeCloseTo(50000, 2); // 2% x 5 years (capped) = 10%
      expect(r.refund).toBeCloseTo(450000, 2);
    });
    it("retention scales with years actually in care, below the cap", () => {
      const r = radRefundOnExit({ radPaid: 500000, yearsInCare: 2, enteredFrom1Nov2025: true });
      expect(r.retained).toBeCloseTo(20000, 2); // 2% x 2 years
    });
  });

  describe("radRealValueAtYear — a RAD refund is fixed in nominal dollars", () => {
    it("stays at face value with no elapsed time", () => {
      expect(radRealValueAtYear(500000, 0.025, 0)).toBeCloseTo(500000, 2);
    });
    it("decays in real terms the longer it's held", () => {
      const after10Years = radRealValueAtYear(500000, 0.025, 10);
      expect(after10Years).toBeLessThan(500000);
    });
  });

  describe("trackLifetimeCare — cumulative, persists across a break in care", () => {
    it("accumulates across years, uncapped while headroom remains", () => {
      let cumulative = 0;
      const cap = 137917.01;
      let r = trackLifetimeCare(cumulative, 40000, cap); cumulative = r.cumulative;
      expect(r.charged).toBe(40000); expect(r.capped).toBe(false);
    });
    it("caps the charge once the lifetime total is reached, and stays capped", () => {
      const cap = 137917.01;
      const r = trackLifetimeCare(130000, 20000, cap);
      expect(r.charged).toBeCloseTo(7917.01, 2);
      expect(r.capped).toBe(true);
    });
  });

  describe("staleness warning", () => {
    it("is null while the projection date is within the loaded period", () => {
      expect(agedCareStalenessWarning("2026-06-01")).toBeNull();
      expect(agedCareStalenessWarning(AGED_CARE_RATES_BASE.periodEnd)).toBeNull();
    });
    it("names the loaded period once the projection runs past it", () => {
      const warning = agedCareStalenessWarning("2027-01-01");
      expect(warning).not.toBeNull();
      expect(warning).toContain(AGED_CARE_RATES_BASE.periodStart);
      expect(warning).toContain(AGED_CARE_RATES_BASE.periodEnd);
    });
  });

  it("the NCCC lifetime cap is the BBB-sourced $137,917.01 figure", () => {
    expect(NCCC_LIFETIME_CAP).toBeCloseTo(137917.01, 2);
  });
});
