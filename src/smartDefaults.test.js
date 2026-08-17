import { describe, it, expect } from "vitest";
import { SMART_DEFAULTS, DEFAULT_KIND, describeDefault, defaultKind } from "./smartDefaults.js";

describe("smartDefaults registry", () => {
  it("every entry names one of the three kinds", () => {
    const valid = new Set(Object.values(DEFAULT_KIND));
    for (const [key, entry] of Object.entries(SMART_DEFAULTS)) {
      expect(valid.has(entry.kind), `${key} has an invalid kind`).toBe(true);
    }
  });

  it("the spec's own commit-1 list is registered: property growth, expenses, purchase costs, agent fees, LVR, rent, education indexation", () => {
    for (const key of [
      "property.growthPct", "property.expensesAmount", "property.purchaseCostsPct",
      "property.agentFeesPct", "property.lvrPct", "property.rentAmount", "education.indexExtraPct",
    ]) {
      expect(SMART_DEFAULTS[key]).toBeTruthy();
    }
  });

  it("property.growthPct is HOUSE VIEW (profile assumption), not DERIVED", () => {
    expect(defaultKind("property.growthPct")).toBe(DEFAULT_KIND.HOUSE);
  });

  it("property.expensesAmount and property.rentAmount are DERIVED (their source value changes with other inputs)", () => {
    expect(defaultKind("property.expensesAmount")).toBe(DEFAULT_KIND.DERIVED);
    expect(defaultKind("property.rentAmount")).toBe(DEFAULT_KIND.DERIVED);
  });

  it("describeDefault states the kind and the source, per the spec's own worked example shape", () => {
    expect(describeDefault("property.growthPct", { value: 5.5 })).toBe(
      "Default: 5.5% — house view (Residential Property profile growth component)"
    );
    expect(describeDefault("property.purchaseCostsPct")).toMatch(/derived.*2% of purchase price/);
  });

  it("returns null for an unregistered key rather than throwing", () => {
    expect(describeDefault("not.a.real.key")).toBeNull();
    expect(defaultKind("not.a.real.key")).toBeNull();
  });
});
