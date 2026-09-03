import { describe, it, expect } from "vitest";
import {
  ASFA_STANDARDS_BASE, ASFA_STANDARD_KEYS, ASFA_LIFESTYLE_DESCRIPTORS,
  asfaAnnual, asfaStandardLabel, asfaStalenessWarning, ASFA_HOMEOWNER_ASSUMPTION_NOTE,
} from "./asfaStandards.js";
import { AGE_PENSION_RATES_BASE } from "./agePension.js";

describe("ASFA Retirement Standard — single and couple variants", () => {
  it("asfaAnnual resolves comfortable and modest for both household types", () => {
    expect(asfaAnnual("comfortable", "single")).toBe(55923);
    expect(asfaAnnual("modest", "single")).toBe(36434);
    expect(asfaAnnual("modestRenter", "single")).toBe(51164);
    expect(asfaAnnual("comfortable", "couple")).toBe(78566);
    expect(asfaAnnual("modest", "couple")).toBe(52473);
    expect(asfaAnnual("modestRenter", "couple")).toBe(69002);
  });

  it("asfaAnnual returns null for agePensionOnly (a descriptor column, not a resolvable dollar figure) and for unknown inputs", () => {
    expect(asfaAnnual("agePensionOnly", "single")).toBeNull();
    expect(asfaAnnual("comfortable", "unknown")).toBeNull();
    expect(asfaAnnual("nonsense", "single")).toBeNull();
  });

  it("couple figures are not simply double the single figures (each is its own ASFA-published number)", () => {
    expect(asfaAnnual("comfortable", "couple")).not.toBe(asfaAnnual("comfortable", "single") * 2);
  });
});

describe("ASFA Retirement Standard — homeowner disclosure", () => {
  it("asfaStandardLabel reads exactly per the spec's own worked example", () => {
    expect(asfaStandardLabel("comfortable", "couple")).toBe("ASFA Comfortable (couple, homeowner)");
    expect(asfaStandardLabel("modest", "single")).toBe("ASFA Modest (single, homeowner)");
  });

  it("the renter variant labels tenure as renter, not homeowner — the one column where the assumption doesn't apply", () => {
    expect(asfaStandardLabel("modestRenter", "couple")).toBe("ASFA Modest (couple, renter)");
  });

  it("the homeowner-no-mortgage assumption note exists and names both conditions it excludes", () => {
    expect(ASFA_HOMEOWNER_ASSUMPTION_NOTE.toLowerCase()).toContain("homeowner");
    expect(ASFA_HOMEOWNER_ASSUMPTION_NOTE.toLowerCase()).toContain("no mortgage");
  });
});

describe("ASFA Retirement Standard — staleness warning", () => {
  it("is null for a date within the loaded quarter's assumed validity window", () => {
    expect(asfaStalenessWarning("2026-03-15")).toBeNull();
    expect(asfaStalenessWarning(ASFA_STANDARDS_BASE.periodEnd)).toBeNull(); // boundary itself is not yet stale
  });

  it("warns, naming the loaded quarter, once past the window", () => {
    const w = asfaStalenessWarning("2026-09-03"); // this session's own currentDate
    expect(w).not.toBeNull();
    expect(w).toContain(ASFA_STANDARDS_BASE.quarter);
  });

  it("returns null for an unparseable date rather than throwing", () => {
    expect(asfaStalenessWarning("not-a-date")).toBeNull();
  });
});

describe("ASFA lifestyle descriptors — ten categories, verbatim, four columns each", () => {
  const CATEGORIES = ["health", "connectivity", "vehicle", "leisure", "home", "haircuts", "utilities", "mealsOut", "clothing", "travel"];

  it("has exactly these ten categories, no more, no fewer", () => {
    expect(Object.keys(ASFA_LIFESTYLE_DESCRIPTORS).sort()).toEqual([...CATEGORIES].sort());
  });

  it("every category has exactly one entry per ASFA_STANDARD_KEYS column, in that order", () => {
    for (const cat of CATEGORIES) {
      expect(ASFA_LIFESTYLE_DESCRIPTORS[cat]).toHaveLength(ASFA_STANDARD_KEYS.length);
      for (const entry of ASFA_LIFESTYLE_DESCRIPTORS[cat]) expect(typeof entry).toBe("string");
    }
  });

  it("home is the one category where the renter column describes a different dwelling, not a degree of the homeowner column's own repair capacity (ASFA's own framing, per the spec's own note)", () => {
    const [, modest, renter] = ASFA_LIFESTYLE_DESCRIPTORS.home;
    expect(modest).not.toBe(renter);
    expect(renter.toLowerCase()).toContain("apartment");
  });

  it("spot check: the comfortable/health and agePensionOnly/vehicle entries match the firm-supplied text exactly", () => {
    expect(ASFA_LIFESTYLE_DESCRIPTORS.health[0]).toBe(
      "Top level private health insurance, doctor/specialist visits, pharmacy needs"
    );
    expect(ASFA_LIFESTYLE_DESCRIPTORS.vehicle[3]).toBe(
      "Limited budget to own, maintain or repair a car"
    );
  });
});

// Cross-check, not reconciliation (spec's own instruction): the
// firm-supplied Age Pension figures the ASFA source quotes alongside
// its own standards are compared here against data/agePension.js's own
// independently-sourced rates. A mismatch fails THIS test loudly,
// naming both figures — neither source is adjusted to force agreement.
describe("ASFA source's own Age Pension cross-check vs data/agePension.js", () => {
  it("single rate: ASFA-quoted figure matches agePension.js's own maximum annual rate", () => {
    const fromAgePensionModule = Math.round(AGE_PENSION_RATES_BASE.singleRate);
    const fromAsfaSource = ASFA_STANDARDS_BASE.agePensionCrossCheckAnnual.single;
    expect(fromAgePensionModule).toBe(fromAsfaSource);
  });

  it("couple rate (combined): ASFA-quoted figure matches agePension.js's own maximum annual rate", () => {
    const fromAgePensionModule = Math.round(2 * AGE_PENSION_RATES_BASE.coupleRateEach);
    const fromAsfaSource = ASFA_STANDARDS_BASE.agePensionCrossCheckAnnual.couple;
    expect(fromAgePensionModule).toBe(fromAsfaSource);
  });
});
