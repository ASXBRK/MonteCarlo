import { describe, it, expect } from "vitest";
import { runProjection, validateInput, ENGINE_VERSION, FIGURES_AS_AT } from "./engine.js";
import { build as buildFamilyWithMortgage } from "./demo/familyWithMortgage.js";

// The contract's declared top-level fields (spec 31 Commit 1) — the
// three this module adds, plus every field deterministic.js's own
// projectPlan() already returns. Listed explicitly so a future field
// removed from either side is caught here, not just in the Commit 4
// snapshot (this test checks PRESENCE against a real populated run;
// Commit 4 pins the full shape including yearly-row fields).
const TOP_LEVEL_FIELDS = [
  "engineVersion", "figuresAsAt", "errors",
  "yearly", "schedule", "monthly", "shortfall",
  "accruedCgtAtEnd", "accruedBondTaxAtEnd", "accruedUntaxedSuperTaxAtEnd",
  "accruedDiv293AtEnd", "accruedDiv296AtEnd", "accruedRefundAtEnd",
  "superWarnings", "propertyWarnings", "drawdownWarnings", "bondWarnings",
  "liabilityRepaymentStats", "liabilityRollovers", "goalStats", "wealthCrossoverYear",
];

function populatedState() {
  // Family with a mortgage — a couple with income, a super account, a
  // liability and property-free assets: exercises far more of the
  // result shape than a bare default state would (superClosing,
  // liabilitiesClosing, taxDetail per person, etc.).
  return buildFamilyWithMortgage(new Date(2026, 7, 28)).scenarios[0].state;
}

describe("engine.js — public API contract (spec 31 Commit 1)", () => {
  it("exports version constants", () => {
    expect(typeof ENGINE_VERSION).toBe("string");
    expect(ENGINE_VERSION.length).toBeGreaterThan(0);
    expect(typeof FIGURES_AS_AT).toBe("string");
    expect(FIGURES_AS_AT.length).toBeGreaterThan(0);
  });

  it("runProjection on a populated scenario returns every declared top-level field", () => {
    const result = runProjection(populatedState());
    expect(result.errors).toEqual([]);
    for (const field of TOP_LEVEL_FIELDS) {
      expect(result, `missing field "${field}"`).toHaveProperty(field);
    }
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(result.figuresAsAt).toBe(FIGURES_AS_AT);
    expect(Array.isArray(result.yearly)).toBe(true);
    expect(result.yearly.length).toBeGreaterThan(0);
  });

  it("a valid but bare-minimum state still projects successfully", () => {
    const result = runProjection({
      plan: { household: "single", client: { currentAge: 40 }, endAge: 44, start: { year: 2026, month: 7 } },
      assets: [],
      cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] },
      assumptions: { cpi: 0.025, bracketMode: "indexed" },
    });
    expect(result.errors).toEqual([]);
    expect(result.yearly.length).toBeGreaterThan(0);
  });

  describe("validateInput — structured errors, never an exception", () => {
    const cases = [
      { name: "null", input: null, field: "$" },
      { name: "a string", input: "not a plan", field: "$" },
      { name: "an array", input: [], field: "$" },
      { name: "missing plan", input: { assets: [], cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "plan" },
      { name: "plan not an object", input: { plan: "nope", assets: [], cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "plan" },
      { name: "missing assets", input: { plan: {}, cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "assets" },
      { name: "assets not an array", input: { plan: {}, assets: {}, cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "assets" },
      { name: "missing cashflows", input: { plan: {}, assets: [] }, field: "cashflows" },
      { name: "cashflows.income not an array", input: { plan: {}, assets: [], cashflows: { income: "nope", expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "cashflows.income" },
      { name: "missing assumptions", input: { plan: {}, assets: [], cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "assumptions" },
      { name: "assumptions.cpi missing", input: { plan: {}, assets: [], cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] }, assumptions: {} }, field: "assumptions.cpi" },
      { name: "assumptions.cpi not a number", input: { plan: {}, assets: [], cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] }, assumptions: { cpi: "2.5%" } }, field: "assumptions.cpi" },
    ];

    for (const { name, input, field } of cases) {
      it(`flags ${name}`, () => {
        const errors = validateInput(input);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.field === field)).toBe(true);
        for (const e of errors) {
          expect(typeof e.field).toBe("string");
          expect(typeof e.message).toBe("string");
          expect(e.message.length).toBeGreaterThan(0);
        }
      });
    }

    it("returns no errors for a valid minimal state", () => {
      expect(validateInput({
        plan: { household: "single", client: { currentAge: 40 }, endAge: 44, start: { year: 2026, month: 7 } },
        assets: [],
        cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] },
        assumptions: { cpi: 0.025, bracketMode: "indexed" },
      })).toEqual([]);
    });

    it("never throws, even on wildly malformed input", () => {
      expect(() => validateInput(undefined)).not.toThrow();
      expect(() => validateInput(42)).not.toThrow();
      expect(() => validateInput({ plan: null })).not.toThrow();
    });
  });

  it("runProjection returns ONLY the version/error fields when input fails validation — no partial projection", () => {
    const result = runProjection({ plan: null });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(result.figuresAsAt).toBe(FIGURES_AS_AT);
    expect(result.yearly).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(["engineVersion", "errors", "figuresAsAt"]);
  });
});
