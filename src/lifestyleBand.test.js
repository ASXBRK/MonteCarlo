import { describe, it, expect } from "vitest";
import {
  resolveLifestyleBand, currentLevelDescriptors, deltaDescriptors, descriptorsForStandard, LIFESTYLE_CATEGORIES,
} from "./lifestyleBand.js";
import { ASFA_LIFESTYLE_DESCRIPTORS, asfaAnnual } from "./data/asfaStandards.js";

describe("descriptorsForStandard", () => {
  it("returns all ten categories, in order, for a known standard", () => {
    const out = descriptorsForStandard("comfortable");
    expect(out).toHaveLength(10);
    expect(out.map((d) => d.category)).toEqual(LIFESTYLE_CATEGORIES);
    expect(out[0].text).toBe(ASFA_LIFESTYLE_DESCRIPTORS.health[0]);
  });

  it("an explicit category subset filters and preserves that subset's own order", () => {
    const out = descriptorsForStandard("modest", ["travel", "health"]);
    expect(out.map((d) => d.category)).toEqual(["travel", "health"]);
  });

  it("an unknown standard returns []", () => {
    expect(descriptorsForStandard("nonsense")).toEqual([]);
  });
});

describe("resolveLifestyleBand — the worked example (spec 32, Commit 5b)", () => {
  // Couple, homeowner, $61,400 average retirement income — the spec's
  // own worked example: "sits between ASFA Modest ($52,473) and
  // Comfortable ($78,566) for a couple... reaching Comfortable would
  // require an additional $17,166 a year."
  it("reproduces the spec's own worked example exactly", () => {
    const band = resolveLifestyleBand(61400, "couple", "homeowner");
    expect(band.position).toBe("between");
    expect(band.currentStandard).toBe("modest");
    expect(band.currentAmount).toBe(52473);
    expect(band.nextStandard).toBe("comfortable");
    expect(band.nextAmount).toBe(78566);
    expect(band.gap).toBe(78566 - 61400);
    expect(Math.round(band.gap)).toBe(17166);
    expect(band.homeExcludedFromDelta).toBe(false); // homeowner — no tenure mismatch
  });

  it("a renter's band uses the Modest(renter) figure as the lower bound, not Modest", () => {
    const modestRenter = asfaAnnual("modestRenter", "single");
    const band = resolveLifestyleBand(modestRenter + 1000, "single", "renter");
    expect(band.position).toBe("between");
    expect(band.currentStandard).toBe("modestRenter");
    expect(band.currentAmount).toBe(modestRenter);
    expect(band.nextStandard).toBe("comfortable"); // no "Comfortable (renter)" is published
  });

  it("below the lower standard: agePensionOnly descriptors as the current level, the lower standard as the target", () => {
    const band = resolveLifestyleBand(5000, "single", "homeowner");
    expect(band.position).toBe("belowLower");
    expect(band.currentStandard).toBe("agePensionOnly");
    expect(band.currentAmount).toBeNull(); // never asserts a $ figure for it — see this module's own header
    expect(band.nextStandard).toBe("modest");
    expect(band.gap).toBe(asfaAnnual("modest", "single") - 5000);
  });

  it("at or above Comfortable: no delta, nextStandard is null", () => {
    const band = resolveLifestyleBand(200000, "couple", "homeowner");
    expect(band.position).toBe("atOrAboveTop");
    expect(band.currentStandard).toBe("comfortable");
    expect(band.nextStandard).toBeNull();
    expect(band.gap).toBeNull();
  });

  it("exactly at a boundary counts as reaching it, not still below", () => {
    const modest = asfaAnnual("modest", "single");
    const band = resolveLifestyleBand(modest, "single", "homeowner");
    expect(band.position).toBe("between");
    expect(band.currentStandard).toBe("modest");
  });

  it("null average income (a degenerate plan with nothing to place) → null, never a fabricated band", () => {
    expect(resolveLifestyleBand(null, "single", "homeowner")).toBeNull();
  });
});

describe("the 'home' nuance (spec 32, Commit 5b) — deliberate handling", () => {
  it("a renter's delta EXCLUDES 'home' — the dwelling-vs-repair-capacity mismatch", () => {
    const band = resolveLifestyleBand(53000, "single", "renter");
    expect(band.homeExcludedFromDelta).toBe(true);
    const delta = deltaDescriptors(band);
    expect(delta.map((d) => d.category)).not.toContain("home");
    expect(delta).toHaveLength(9);
  });

  it("a homeowner's delta INCLUDES 'home' — both standards describe repair capacity, a coherent ladder step", () => {
    const band = resolveLifestyleBand(61400, "couple", "homeowner");
    expect(band.homeExcludedFromDelta).toBe(false);
    const delta = deltaDescriptors(band);
    expect(delta.map((d) => d.category)).toContain("home");
    expect(delta).toHaveLength(10);
  });

  it("a renter's CURRENT-level list still includes 'home' (describing one band, not comparing two)", () => {
    const band = resolveLifestyleBand(53000, "single", "renter");
    const current = currentLevelDescriptors(band);
    expect(current.map((d) => d.category)).toContain("home");
    const homeEntry = current.find((d) => d.category === "home");
    expect(homeEntry.text).toBe(ASFA_LIFESTYLE_DESCRIPTORS.home[2]); // the modestRenter column
  });

  it("the below-the-floor case ALSO excludes 'home' from its delta (the target is modestRenter, the same mismatch)", () => {
    const band = resolveLifestyleBand(5000, "single", "renter");
    expect(band.position).toBe("belowLower");
    expect(band.homeExcludedFromDelta).toBe(true);
    expect(deltaDescriptors(band).map((d) => d.category)).not.toContain("home");
  });

  it("agePensionOnly's own 'home' descriptor reads as repair capacity, not a dwelling type (consistent with the standards it's compared against)", () => {
    const text = ASFA_LIFESTYLE_DESCRIPTORS.home[3]; // agePensionOnly column
    expect(text.toLowerCase()).toContain("repair");
  });
});

describe("currentLevelDescriptors / deltaDescriptors — defensive", () => {
  it("null band → []", () => {
    expect(currentLevelDescriptors(null)).toEqual([]);
    expect(deltaDescriptors(null)).toEqual([]);
  });

  it("atOrAboveTop band → no delta (nextStandard null)", () => {
    const band = resolveLifestyleBand(200000, "couple", "homeowner");
    expect(deltaDescriptors(band)).toEqual([]);
  });
});
