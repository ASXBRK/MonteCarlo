import { describe, it, expect } from "vitest";
import { exemptProportion } from "./mainResidence.js";

describe("exemptProportion — main residence exemption and the six-year absence rule", () => {
  it("fully exempt while occupied (never moved out)", () => {
    expect(exemptProportion("2010-01-01", "2030-01-01", null)).toBe(1);
    expect(exemptProportion("2010-01-01", "2030-01-01", { movedOutAt: null })).toBe(1);
  });

  it("exempt within six years of a producing-income absence (sold before the clock runs out)", () => {
    const mr = { movedOutAt: "2020-01-01", producingIncome: true, movedBackInAt: null };
    // Sold 5 years after moving out — well within the 6-year window.
    expect(exemptProportion("2010-01-01", "2025-01-01", mr)).toBe(1);
  });

  it("partial exemption once the six-year window is exceeded, at the correct day proportion", () => {
    const acquisition = "2000-01-01";
    const movedOutAt = "2010-01-01";
    const saleDate = "2020-01-01"; // 10 years after moving out — 4 years non-exempt
    const mr = { movedOutAt, producingIncome: true, movedBackInAt: null };
    const totalDays = (new Date(saleDate) - new Date(acquisition)) / 86400000;
    const nonExemptDays = (new Date(saleDate) - new Date("2016-01-01")) / 86400000; // 6 years after movedOutAt
    const expected = (totalDays - nonExemptDays) / totalDays;
    expect(exemptProportion(acquisition, saleDate, mr)).toBeCloseTo(expected, 6);
    expect(exemptProportion(acquisition, saleDate, mr)).toBeGreaterThan(0);
    expect(exemptProportion(acquisition, saleDate, mr)).toBeLessThan(1);
  });

  it("a vacant (non-income-producing) absence is exempt indefinitely, regardless of length", () => {
    const mr = { movedOutAt: "2000-01-01", producingIncome: false, movedBackInAt: null };
    expect(exemptProportion("1990-01-01", "2030-01-01", mr)).toBe(1); // 30 years vacant — still fully exempt
  });

  it("reoccupation before six years resets exposure — the absence never crosses the clock", () => {
    const mr = { movedOutAt: "2010-01-01", producingIncome: true, movedBackInAt: "2013-01-01" };
    // Moved back in after only 3 years (under 6) — absence window never
    // exceeded, so even a sale long after reoccupation is fully exempt.
    expect(exemptProportion("2000-01-01", "2030-01-01", mr)).toBe(1);
  });

  it("reoccupation after six years caps the non-exempt window at the reoccupation date, not the later sale", () => {
    const acquisition = "2000-01-01";
    const movedOutAt = "2010-01-01";
    const movedBackInAt = "2020-01-01"; // 10 years absent — 4 years over the 6-year mark
    const saleDate = "2030-01-01"; // sold 10 years AFTER moving back in
    const mr = { movedOutAt, producingIncome: true, movedBackInAt };
    const totalDays = (new Date(saleDate) - new Date(acquisition)) / 86400000;
    const nonExemptDays = (new Date(movedBackInAt) - new Date("2016-01-01")) / 86400000; // capped at reoccupation
    const expected = (totalDays - nonExemptDays) / totalDays;
    expect(exemptProportion(acquisition, saleDate, mr)).toBeCloseTo(expected, 6);
  });

  it("a zero or negative ownership period returns fully exempt rather than dividing by zero", () => {
    expect(exemptProportion("2020-01-01", "2020-01-01", { movedOutAt: "2019-01-01", producingIncome: true })).toBe(1);
  });
});
