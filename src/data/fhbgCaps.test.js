import { describe, it, expect } from "vitest";
import { fhbgPriceCapExceeded, FHBG_PRICE_CAPS } from "./fhbgCaps.js";

describe("fhbgPriceCapExceeded", () => {
  it("flags a price over the state's cap", () => {
    expect(fhbgPriceCapExceeded("NSW", 950000)).toBe(true);
  });

  it("does not flag a price at or under the state's cap", () => {
    expect(fhbgPriceCapExceeded("NSW", 900000)).toBe(false);
    expect(fhbgPriceCapExceeded("NSW", 800000)).toBe(false);
  });

  it("every property state has a cap", () => {
    for (const s of ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]) {
      expect(FHBG_PRICE_CAPS[s]).toBeGreaterThan(0);
    }
  });

  it("an unknown state code never throws and is never flagged", () => {
    expect(fhbgPriceCapExceeded("XX", 10000000)).toBe(false);
  });
});
