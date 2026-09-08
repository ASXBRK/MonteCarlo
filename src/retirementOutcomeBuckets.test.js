import { describe, it, expect } from "vitest";
import {
  OUTCOME_BUCKET_ORDER, outcomeBucketLabel, outcomeBucketDescriptors,
  agePensionExcludedFor, resolveOutcomeThresholds, classifyOutcome, computeOutcomeBuckets,
} from "./retirementOutcomeBuckets.js";

// Hand-set thresholds for every boundary test below — deliberately
// round numbers, not real ASFA/Age Pension figures, so each test's own
// expected bucket is obvious from the numbers themselves.
const T = { comfortable: 60000, modest: 40000, floor: 30000 };

describe("classifyOutcome — boundary classification (docs/specs/36-retirement-outputs.md, Commit 1)", () => {
  it("strictly above the Comfortable figure → aboveComfortable", () => {
    expect(classifyOutcome(60001, T, false, false)).toBe("aboveComfortable");
  });
  it("exactly AT the Comfortable figure → comfortable, not aboveComfortable (the spec's own word is 'exceeds')", () => {
    expect(classifyOutcome(60000, T, false, false)).toBe("comfortable");
  });
  it("between Modest and Comfortable → comfortable", () => {
    expect(classifyOutcome(50000, T, false, false)).toBe("comfortable");
  });
  it("exactly AT the Modest figure → modest, not comfortable", () => {
    expect(classifyOutcome(40000, T, false, false)).toBe("modest");
  });
  it("between the floor and Modest → modest", () => {
    expect(classifyOutcome(35000, T, false, false)).toBe("modest");
  });
  it("exactly AT the Age Pension floor → atFloor ('at or below', the spec's own word)", () => {
    expect(classifyOutcome(30000, T, false, false)).toBe("atFloor");
  });
  it("below the floor → atFloor", () => {
    expect(classifyOutcome(10000, T, false, false)).toBe("atFloor");
  });

  describe("Age Pension excluded — the bottom bucket swaps from a dollar comparison to the ruin flag", () => {
    it("below Modest, not ruined → modest (there is no floor to have fallen below)", () => {
      expect(classifyOutcome(5000, T, true, false)).toBe("modest");
    });
    it("below Modest, ruined → atFloor ('portfolio exhausted' at display time)", () => {
      expect(classifyOutcome(5000, T, true, true)).toBe("atFloor");
    });
    it("above Comfortable is unaffected by exclusion or ruin", () => {
      expect(classifyOutcome(70000, T, true, true)).toBe("aboveComfortable");
    });
  });
});

describe("outcomeBucketLabel", () => {
  it("labels every bucket per the spec's own table when the Age Pension is in play", () => {
    expect(outcomeBucketLabel("aboveComfortable", false)).toBe("Above Comfortable");
    expect(outcomeBucketLabel("comfortable", false)).toBe("Comfortable");
    expect(outcomeBucketLabel("modest", false)).toBe("Modest");
    expect(outcomeBucketLabel("atFloor", false)).toBe("At the Age Pension floor");
  });
  it("relabels ONLY the bottom bucket when the Age Pension is excluded — 'the panel must say so, rather than silently reporting a floor that has been switched off'", () => {
    expect(outcomeBucketLabel("atFloor", true)).toBe("Portfolio exhausted");
    expect(outcomeBucketLabel("modest", true)).toBe("Modest"); // unaffected
    expect(outcomeBucketLabel("aboveComfortable", true)).toBe("Above Comfortable"); // unaffected
  });
});

describe("outcomeBucketDescriptors — each bucket links to its own lifestyle descriptors", () => {
  it("'Modest' links to the Modest standard's own ten categories (renter variant selected by tenure)", () => {
    const homeowner = outcomeBucketDescriptors("modest", "homeowner");
    const renter = outcomeBucketDescriptors("modest", "renter");
    expect(homeowner.length).toBe(10);
    expect(renter.length).toBe(10);
    // The one category ASFA itself frames differently for a renter (see
    // lifestyleBand.js's own header) — confirms the renter/homeowner
    // split actually reaches a different descriptor set, not the same
    // one twice.
    const homeownerHome = homeowner.find((d) => d.category === "home").text;
    const renterHome = renter.find((d) => d.category === "home").text;
    expect(homeownerHome).not.toBe(renterHome);
  });
  it("'At the Age Pension floor' links to the agePensionOnly descriptors", () => {
    expect(outcomeBucketDescriptors("atFloor", "homeowner").length).toBe(10);
  });
});

describe("agePensionExcludedFor", () => {
  it("false when the client alone is eligible (single household)", () => {
    expect(agePensionExcludedFor({ client: { taxProfile: { centrelinkEligible: true } }, partner: null })).toBe(false);
  });
  it("true when the client is turned off and there is no partner", () => {
    expect(agePensionExcludedFor({ client: { taxProfile: { centrelinkEligible: false } }, partner: null })).toBe(true);
  });
  it("false for a couple where only ONE partner is turned off — the household still has a pension-supported floor", () => {
    expect(agePensionExcludedFor({
      client: { taxProfile: { centrelinkEligible: false } },
      partner: { taxProfile: { centrelinkEligible: true } },
    })).toBe(false);
  });
  it("true for a couple where BOTH are turned off", () => {
    expect(agePensionExcludedFor({
      client: { taxProfile: { centrelinkEligible: false } },
      partner: { taxProfile: { centrelinkEligible: false } },
    })).toBe(true);
  });
});

describe("resolveOutcomeThresholds", () => {
  const baseState = { plan: { start: { year: 2026, month: 7 } }, assumptions: { cpi: 0.025, bracketMode: "indexed", awote: 0.032 } };

  it("selects the renter standard for the Modest boundary when tenure is renter, and a DIFFERENT (higher) figure for homeowner — the same standard the lifestyle band itself picks", () => {
    const homeowner = resolveOutcomeThresholds(baseState, "single", "homeowner");
    const renter = resolveOutcomeThresholds(baseState, "single", "renter");
    expect(homeowner.modestStandard).toBe("modest");
    expect(renter.modestStandard).toBe("modestRenter");
    expect(renter.modest).toBeGreaterThan(homeowner.modest); // ASFA's own modestRenter > modest — renting costs more
    expect(homeowner.comfortable).toBe(renter.comfortable); // no published "Comfortable (renter)" figure — same for both
  });

  it("a couple's floor exceeds a single's floor, and its ASFA figures exceed a single's", () => {
    const single = resolveOutcomeThresholds(baseState, "single", "homeowner");
    const couple = resolveOutcomeThresholds(baseState, "couple", "homeowner");
    expect(couple.floor).toBeGreaterThan(single.floor);
    expect(couple.comfortable).toBeGreaterThan(single.comfortable);
    expect(couple.modest).toBeGreaterThan(single.modest);
  });

  it("the floor sits below the Modest figure — Age Pension floor < ASFA Modest, so the four buckets never collapse into three", () => {
    const t = resolveOutcomeThresholds(baseState, "single", "homeowner");
    expect(t.floor).toBeLessThan(t.modest);
    expect(t.modest).toBeLessThan(t.comfortable);
  });
});

describe("computeOutcomeBuckets", () => {
  // 10 synthetic paths, average income hand-placed against T (comfortable
  // 60000 / modest 40000 / floor 30000) — hand-counted below:
  //   idx 0,1 (70000,65000)        > comfortable        → aboveComfortable (2)
  //   idx 2,3,4 (55000,50000,45000) modest < avg <= comfortable → comfortable (3)
  //   idx 5,6,7 (40000,35000,32000) floor < avg <= modest       → modest (3)
  //   idx 8,9 (25000,15000)         avg <= floor                → atFloor (2)
  const avgIncomes = [70000, 65000, 55000, 50000, 45000, 40000, 35000, 32000, 25000, 15000];
  const minIncomes = [65000, 60000, 50000, 45000, 40000, 38000, 28000, 20000, 20000, 10000];
  const pathAvgIncome = Float64Array.from(avgIncomes);
  const pathMinIncome = Float64Array.from(minIncomes);
  const pathRuined = new Uint8Array(10); // none ruined — irrelevant while the Age Pension is in play

  it("partitions every path into exactly one bucket, percentages summing to exactly 100", () => {
    const result = computeOutcomeBuckets({ pathAvgIncome, pathMinIncome, pathRuined }, T, false);
    const totalPct = result.buckets.reduce((s, b) => s + b.pct, 0);
    expect(totalPct).toBeCloseTo(100, 9);
    const totalCount = result.buckets.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(10);
  });

  it("counts match a hand-count of the fixture (2 above, 3 comfortable, 3 modest, 2 at floor)", () => {
    const result = computeOutcomeBuckets({ pathAvgIncome, pathMinIncome, pathRuined }, T, false);
    const byKey = Object.fromEntries(result.buckets.map((b) => [b.key, b.count]));
    expect(byKey.aboveComfortable).toBe(2);
    expect(byKey.comfortable).toBe(3);
    expect(byKey.modest).toBe(3);
    expect(byKey.atFloor).toBe(2);
    expect(result.buckets.map((b) => b.key)).toEqual(OUTCOME_BUCKET_ORDER);
  });

  it("dropsToFloorPct reports the share of a bucket's own paths whose MINIMUM (not average) fell to the floor — the spec's own 'report the minimum alongside the average'", () => {
    const result = computeOutcomeBuckets({ pathAvgIncome, pathMinIncome, pathRuined }, T, false);
    const modest = result.buckets.find((b) => b.key === "modest");
    // modest bucket = indices 5,6,7 (avg 40000,35000,32000); their own
    // minIncomes are 38000,28000,20000 — two (28000, 20000) are <= floor
    // (30000) → 2/3.
    expect(modest.dropsToFloorPct).toBeCloseTo((2 / 3) * 100, 9);
    // comfortable/aboveComfortable never dip that low in this fixture.
    expect(result.buckets.find((b) => b.key === "comfortable").dropsToFloorPct).toBe(0);
    expect(result.buckets.find((b) => b.key === "aboveComfortable").dropsToFloorPct).toBe(0);
  });

  it("dropsToFloorPct is null for the bottom bucket itself (it IS the floor — the stat would be vacuous)", () => {
    const result = computeOutcomeBuckets({ pathAvgIncome, pathMinIncome, pathRuined }, T, false);
    expect(result.buckets.find((b) => b.key === "atFloor").dropsToFloorPct).toBeNull();
  });

  it("dropsToFloorPct is null everywhere when the Age Pension is excluded — no dollar floor to drop to", () => {
    const result = computeOutcomeBuckets({ pathAvgIncome, pathMinIncome, pathRuined }, T, true);
    for (const b of result.buckets) expect(b.dropsToFloorPct).toBeNull();
  });

  it("the age-pension-excluded case relabels the bottom bucket via outcomeBucketLabel, and reclassifies every avg<=modest path by ruin instead of the dollar floor", () => {
    // Without exclusion, indices 5-9 (avg <= modest = 40000) split
    // modest(5,6,7)/atFloor(8,9) by dollar comparison. WITH exclusion
    // that whole avg<=modest group (5 paths) splits purely by the
    // ruined flag — mark only the lowest path (idx 9) as ruined.
    const ruined = new Uint8Array(10);
    ruined[9] = 1;
    const result = computeOutcomeBuckets({ pathAvgIncome, pathMinIncome, pathRuined: ruined }, T, true);
    const byKey = Object.fromEntries(result.buckets.map((b) => [b.key, b.count]));
    expect(byKey.atFloor).toBe(1); // only idx 9, the one actually ruined
    expect(byKey.modest).toBe(4); // idx 5,6,7,8 — idx 8 (not ruined) moves out of atFloor
    expect(byKey.comfortable).toBe(3); // unaffected
    expect(byKey.aboveComfortable).toBe(2); // unaffected
    expect(result.buckets.find((b) => b.key === "atFloor").label).toBe("Portfolio exhausted");
  });

  it("an empty path set returns 0% everywhere, not NaN/Infinity", () => {
    const result = computeOutcomeBuckets({ pathAvgIncome: new Float64Array(0), pathMinIncome: new Float64Array(0), pathRuined: new Uint8Array(0) }, T, false);
    expect(result.totalPaths).toBe(0);
    for (const b of result.buckets) { expect(b.pct).toBe(0); expect(b.count).toBe(0); }
  });
});
