import { describe, it, expect } from "vitest";
import { remainingLE, LIFE_TABLES_META } from "./lifeTables.js";

describe("ABS life tables 2020–2022", () => {
  it("matches the embedded ABS source values at the test ages", () => {
    // ABS Life Tables 2020–2022 (see lifeTables.js source comment):
    // males ex(40) = 42.7, ex(65) = 20.2; females ex(40) = 46.2,
    // ex(65) = 22.8; at birth 81.2 / 85.3.
    expect(remainingLE(40, "male")).toBeCloseTo(42.7, 6);
    expect(remainingLE(65, "male")).toBeCloseTo(20.2, 6);
    expect(remainingLE(40, "female")).toBeCloseTo(46.2, 6);
    expect(remainingLE(65, "female")).toBeCloseTo(22.8, 6);
    expect(remainingLE(0, "male")).toBeCloseTo(81.2, 6);
    expect(remainingLE(0, "female")).toBeCloseTo(85.3, 6);
  });

  it("is monotone decreasing and defensive at the edges", () => {
    for (const sex of ["male", "female"]) {
      for (let a = 1; a <= 100; a++) {
        expect(remainingLE(a, sex)).toBeLessThan(remainingLE(a - 1, sex));
      }
    }
    expect(remainingLE(150, "male")).toBe(remainingLE(100, "male")); // clamp
    expect(remainingLE(-5, "female")).toBe(remainingLE(0, "female"));
  });

  it("carries its source metadata", () => {
    expect(LIFE_TABLES_META.source).toContain("2020–2022");
  });
});
