import { describe, it, expect } from "vitest";
import { transferDuty, dutyWithConcessions, fhogAmount, STATES } from "./stampDuty.js";

// Expected figures are hand-computed from the embedded schedules (see
// stampDuty.js per-state source comments and the as-at date; the
// schedules themselves carry the verification caveat).
describe("stamp duty — general schedules (two spot checks per state)", () => {
  const cases = [
    // NSW: 500k → 10,909 + 4.5% × 136,000 = 17,029; 1.5m → 49,069 + 5.5% × 288,000 = 64,909
    ["NSW", 500000, 10909 + 0.045 * (500000 - 364000)],
    ["NSW", 1500000, 49069 + 0.055 * (1500000 - 1212000)],
    // VIC: 500k → 2,870 + 6% × 370,000 = 25,070; 1.2m → 5.5% flat = 66,000
    ["VIC", 500000, 2870 + 0.06 * (500000 - 130000)],
    ["VIC", 1200000, 1200000 * 0.055],
    // QLD: 500k → 1,050 + 3.5% × 425,000 = 15,925; 750k → 17,325 + 4.5% × 210,000 = 26,775
    ["QLD", 500000, 1050 + 0.035 * (500000 - 75000)],
    ["QLD", 750000, 17325 + 0.045 * (750000 - 540000)],
    // WA: 500k → 11,115 + 4.75% × 140,000 = 17,765; 800k → 28,453 + 5.15% × 75,000 = 32,315.5
    ["WA", 500000, 11115 + 0.0475 * (500000 - 360000)],
    ["WA", 800000, 28453 + 0.0515 * (800000 - 725000)],
    // SA: 500k → 11,330 + 5% × 200,000 = 21,330; 700k → 21,330 + 5.5% × 200,000 = 32,330
    ["SA", 500000, 11330 + 0.05 * (500000 - 300000)],
    ["SA", 700000, 21330 + 0.055 * (700000 - 500000)],
    // TAS: 500k → 12,935 + 4.25% × 125,000 = 18,247.5; 800k → 27,810 + 4.5% × 75,000 = 31,185
    ["TAS", 500000, 12935 + 0.0425 * (500000 - 375000)],
    ["TAS", 800000, 27810 + 0.045 * (800000 - 725000)],
    // ACT: 500k → 4,600 + 3.4% × 0 = ... 500k hits the 500k row: 11,400 + 4.32% × 0 = 11,400;
    // 2m → flat 4.54% = 90,800
    ["ACT", 500000, 11400],
    ["ACT", 2000000, 2000000 * 0.0454],
    // NT: 500k → 0.06571441 × 500² + 15 × 500 = 23,928.60; 1m → 4.95% = 49,500
    ["NT", 500000, 0.06571441 * 500 * 500 + 15 * 500],
    ["NT", 1000000, 49500],
  ];
  for (const [st, price, expected] of cases) {
    it(`${st} @ $${price.toLocaleString()}`, () => {
      expect(transferDuty(st, price)).toBeCloseTo(expected, 2);
    });
  }

  it("covers all eight jurisdictions", () => {
    expect(STATES.sort()).toEqual(["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"].sort());
  });
});

describe("stamp duty — FHB concessions + FHOG", () => {
  it("NSW FHB: exempt to 800k, linear taper to 1m, full duty beyond", () => {
    expect(dutyWithConcessions("NSW", 750000, { firstHomeBuyer: true })).toBe(0);
    const general900 = transferDuty("NSW", 900000);
    expect(dutyWithConcessions("NSW", 900000, { firstHomeBuyer: true }))
      .toBeCloseTo(general900 * 0.5, 6);
    expect(dutyWithConcessions("NSW", 1100000, { firstHomeBuyer: true }))
      .toBeCloseTo(transferDuty("NSW", 1100000), 6);
  });

  it("SA FHB relief is new-build only", () => {
    expect(dutyWithConcessions("SA", 700000, { firstHomeBuyer: true, newBuild: true })).toBe(0);
    expect(dutyWithConcessions("SA", 700000, { firstHomeBuyer: true, newBuild: false }))
      .toBeCloseTo(transferDuty("SA", 700000), 6);
  });

  it("FHOG pays on new builds under the cap only", () => {
    expect(fhogAmount("QLD", 700000, { firstHomeBuyer: true, newBuild: true })).toBe(30000);
    expect(fhogAmount("QLD", 700000, { firstHomeBuyer: true, newBuild: false })).toBe(0);
    expect(fhogAmount("QLD", 800000, { firstHomeBuyer: true, newBuild: true })).toBe(0); // over cap
    expect(fhogAmount("NT", 600000, { firstHomeBuyer: true, newBuild: true })).toBe(50000);
    expect(fhogAmount("ACT", 600000, { firstHomeBuyer: true, newBuild: true })).toBe(0); // abolished
  });
});
