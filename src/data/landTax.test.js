import { describe, it, expect } from "vitest";
import { landTaxOnValue, LAND_TAX_STATES, LAND_TAX_META } from "./landTax.js";

// Expected figures are hand-computed from the embedded schedules — see
// landTax.js's per-state source comments and its verification caveat
// (WA corroborated via secondary sources this session; every other
// jurisdiction is a disclosed UNVERIFIED approximation; NT genuinely
// has no general land tax).
describe("land tax — bracket schedules (spot checks per jurisdiction)", () => {
  it("is tax-free below every jurisdiction's own threshold", () => {
    expect(landTaxOnValue("WA", 250000)).toBe(0);
    expect(landTaxOnValue("NSW", 1000000)).toBe(0);
    expect(landTaxOnValue("VIC", 40000)).toBe(0);
    expect(landTaxOnValue("QLD", 500000)).toBe(0);
    expect(landTaxOnValue("SA", 700000)).toBe(0);
    expect(landTaxOnValue("TAS", 40000)).toBe(0);
  });

  const cases = [
    // WA: $300k-$420k is a flat $300; $420k-$1m adds 0.25% of the excess.
    ["WA", 360000, 300],
    ["WA", 700000, 300 + 0.0025 * (700000 - 420000)],
    ["WA", 2000000, 8950 + 0.018 * (2000000 - 1800000)],
    // NSW: $1.5m → 100 + 1.6% × 425,000 = 6,900
    ["NSW", 1500000, 100 + 0.016 * (1500000 - 1075000)],
    // VIC: $200k → 100 + 0.5% × 100,000 = 600
    ["VIC", 200000, 100 + 0.005 * (200000 - 100000)],
    // QLD: $800k → 500 + 1% × 200,000 = 2,500
    ["QLD", 800000, 500 + 0.01 * (800000 - 600000)],
    // SA: $1m → 0 + 0.5% × 268,000 = 1,340
    ["SA", 1000000, 0.005 * (1000000 - 732000)],
    // TAS: $200k → 50 + 0.55% × 150,000 = 875
    ["TAS", 200000, 50 + 0.0055 * (200000 - 50000)],
    // ACT: no tax-free threshold — even a modest land value carries the
    // fixed charge (landTaxOnValue's own value>0 guard is what a literal
    // $0 land value hits, same as every other state — not tested here
    // since no real property has zero land value).
    ["ACT", 100000, 1392 + 0.0068 * 100000],
    ["ACT", 500000, 1392 + 0.0068 * 500000],
  ];
  for (const [st, value, expected] of cases) {
    it(`${st} @ $${value.toLocaleString()}`, () => {
      expect(landTaxOnValue(st, value)).toBeCloseTo(expected, 2);
    });
  }

  it("the Northern Territory levies no general land tax at any value", () => {
    expect(landTaxOnValue("NT", 0)).toBe(0);
    expect(landTaxOnValue("NT", 50000000)).toBe(0);
  });

  it("is progressive: tax at a higher value is never less than at a lower one, for every jurisdiction", () => {
    for (const st of LAND_TAX_STATES) {
      let prev = 0;
      for (const v of [0, 100000, 500000, 1000000, 2000000, 5000000, 12000000]) {
        const tax = landTaxOnValue(st, v);
        expect(tax).toBeGreaterThanOrEqual(prev);
        prev = tax;
      }
    }
  });

  it("all 8 jurisdictions are present, and the module states its verification caveat", () => {
    expect(LAND_TAX_STATES.sort()).toEqual(["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"]);
    expect(LAND_TAX_META.asAt).toBe("2025-07-01");
    expect(LAND_TAX_META.note).toMatch(/UNVERIFIED|unreachable/i);
  });

  it("an unrecognised state code or a non-positive value returns 0, not NaN/throw", () => {
    expect(landTaxOnValue("XX", 500000)).toBe(0);
    expect(landTaxOnValue("WA", 0)).toBe(0);
    expect(landTaxOnValue("WA", -100)).toBe(0);
  });
});
