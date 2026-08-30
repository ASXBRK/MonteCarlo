import { describe, it, expect } from "vitest";
import {
  incomeTestedAmount, assetsTestedAmount, formerHomeAssessedValue,
  formerHomeRentTreatment, agedCareAssessableAssets,
} from "./agedCareMeansTest.js";

describe("agedCareMeansTest.js — means testing and former home (spec 29 Commit 2)", () => {
  it("incomeTestedAmount/assetsTestedAmount are explicitly not yet configured", () => {
    expect(incomeTestedAmount()).toBeNull();
    expect(assetsTestedAmount()).toBeNull();
  });

  describe("former home — assessed at a capped value, not market value", () => {
    it("counts the lesser of market value and the capped value", () => {
      expect(formerHomeAssessedValue({ marketValue: 900000, occupiedByProtectedPerson: false, cappedValue: 206000 })).toBe(206000);
      expect(formerHomeAssessedValue({ marketValue: 150000, occupiedByProtectedPerson: false, cappedValue: 206000 })).toBe(150000);
    });

    it("is fully exempt while a protected person lives there", () => {
      expect(formerHomeAssessedValue({ marketValue: 900000, occupiedByProtectedPerson: true, cappedValue: 206000 })).toBe(0);
    });

    it("the exemption ends when the protected person leaves — reverts to the capped value", () => {
      const whileOccupied = formerHomeAssessedValue({ marketValue: 900000, occupiedByProtectedPerson: true, cappedValue: 206000 });
      const afterTheyLeave = formerHomeAssessedValue({ marketValue: 900000, occupiedByProtectedPerson: false, cappedValue: 206000 });
      expect(whileOccupied).toBe(0);
      expect(afterTheyLeave).toBe(206000);
      expect(afterTheyLeave).toBeGreaterThan(whileOccupied);
    });

    it("never goes negative for a market value below zero (defensive)", () => {
      expect(formerHomeAssessedValue({ marketValue: -1, occupiedByProtectedPerson: false, cappedValue: 206000 })).toBe(0);
    });
  });

  describe("selling the former home — proceeds become fully assessable, the fee rises", () => {
    it("assessable assets rise once the home is sold and proceeds count in full", () => {
      // Before sale: home occupied-by-nobody-protected, capped at 206k,
      // against a $850k market value.
      const beforeSale = agedCareAssessableAssets({
        otherFinancialAssets: 100000,
        formerHome: formerHomeAssessedValue({ marketValue: 850000, occupiedByProtectedPerson: false, cappedValue: 206000 }),
      });
      // After sale: the property module's own sale event resolves net
      // proceeds (a real $ figure from the engine, not modelled here)
      // — say $820k after agent fees/costs — which the caller now
      // passes straight into `otherFinancialAssets` (no more capped
      // treatment at all, since formerHomeAssessedValue no longer
      // applies to a sold property).
      const afterSale = agedCareAssessableAssets({ otherFinancialAssets: 100000 + 820000, formerHome: 0 });
      expect(beforeSale).toBe(100000 + 206000);
      expect(afterSale).toBe(100000 + 820000);
      expect(afterSale).toBeGreaterThan(beforeSale); // the reversal the adviser is reasoning about
    });
  });

  describe("a RAD counts as an assessable asset, even though it's refundable", () => {
    it("adds the RAD in on the same footing as any other financial asset", () => {
      const withoutRad = agedCareAssessableAssets({ otherFinancialAssets: 300000, formerHome: 206000, radPaid: 0 });
      const withRad = agedCareAssessableAssets({ otherFinancialAssets: 300000, formerHome: 206000, radPaid: 500000 });
      expect(withRad - withoutRad).toBe(500000);
      // The central, easy-to-invert trade-off: paying a larger RAD to
      // reduce (or eliminate) the DAP INCREASES assessable assets, and
      // so — once assetsTestedAmount() is configured — would increase
      // the means-tested fee, not reduce it.
      expect(withRad).toBeGreaterThan(withoutRad);
    });

    it("a bigger RAD strictly increases assessable assets", () => {
      const smallRad = agedCareAssessableAssets({ otherFinancialAssets: 300000, radPaid: 200000 });
      const largeRad = agedCareAssessableAssets({ otherFinancialAssets: 300000, radPaid: 600000 });
      expect(largeRad).toBeGreaterThan(smallRad);
    });
  });

  describe("former home rent — historically exempt for pre-2016 entrants", () => {
    it("exempts rent for an entry date before 1 January 2016", () => {
      const r = formerHomeRentTreatment("2015-06-01");
      expect(r.exempt).toBe(true);
    });

    it("assesses rent for an entry date from 1 January 2016 onward", () => {
      expect(formerHomeRentTreatment("2016-01-01").exempt).toBe(false);
      expect(formerHomeRentTreatment("2026-06-01").exempt).toBe(false);
    });

    it("returns null for an unparseable date rather than guessing", () => {
      expect(formerHomeRentTreatment("not a date")).toBeNull();
    });
  });
});
