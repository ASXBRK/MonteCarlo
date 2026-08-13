import { describe, it, expect } from "vitest";
import { thinnedYearIndices } from "./periodThinning.js";

// 30 plan years, client ages 40..69.
const ages = Array.from({ length: 30 }, (_, i) => 40 + i);

describe("thinnedYearIndices", () => {
  it("default (no bounds, everyN 1) keeps every year", () => {
    const out = thinnedYearIndices({ fromAge: null, toAge: null, everyN: 1, forceKeyYears: true }, ages);
    expect(out).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it("full detail across [fromAge, toAge], nothing before, nothing after when everyN covers the tail exactly", () => {
    // From 45 (idx 5) to 55 (idx 15): full detail 5..15; tail from 15+5=20
    // to 29 step 5 → 20, 25 (29 falls outside the exact step so needs forcing).
    const out = thinnedYearIndices({ fromAge: 45, toAge: 55, everyN: 5, forceKeyYears: false }, ages);
    expect(out).toEqual([5,6,7,8,9,10,11,12,13,14,15, 20, 25]);
  });

  it("years before fromAge are hidden entirely (no forcing)", () => {
    const out = thinnedYearIndices({ fromAge: 50, toAge: 50, everyN: 10, forceKeyYears: false }, ages);
    // idx 10 only, then tail 20 (10+10)
    expect(out).toEqual([10, 20]);
    expect(out).not.toContain(0);
  });

  it("forceKeyYears pins the first and last projection years regardless of bounds", () => {
    const out = thinnedYearIndices({ fromAge: 50, toAge: 50, everyN: 10, forceKeyYears: true }, ages);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(29);
    expect(out).toEqual([0, 10, 20, 29]);
  });

  it("forced years (shortfall / purchase) are pinned when forcing is on", () => {
    const out = thinnedYearIndices(
      { fromAge: 40, toAge: 42, everyN: 10, forceKeyYears: true },
      ages,
      [17, 23] // e.g. a shortfall year and a property purchase year
    );
    expect(out).toEqual([0, 1, 2, 12, 17, 22, 23, 29]);
  });

  it("forced years are ignored when forcing is off", () => {
    const out = thinnedYearIndices(
      { fromAge: 40, toAge: 42, everyN: 10, forceKeyYears: false },
      ages,
      [17, 23]
    );
    expect(out).toEqual([0, 1, 2, 12, 22]);
  });

  it("everyN of 1 with a bounded To still shows every year after it (no truncation)", () => {
    const out = thinnedYearIndices({ fromAge: null, toAge: 45, everyN: 1, forceKeyYears: false }, ages);
    expect(out).toEqual(Array.from({ length: 30 }, (_, i) => i)); // step 1 → nothing skipped
  });

  it("toAge before fromAge clamps to a single-year window", () => {
    const out = thinnedYearIndices({ fromAge: 50, toAge: 45, everyN: 5, forceKeyYears: false }, ages);
    expect(out[0]).toBe(10); // fromIdx only, toIdx clamped up to fromIdx
  });

  it("empty client-age array returns nothing", () => {
    expect(thinnedYearIndices({ fromAge: null, toAge: null, everyN: 1, forceKeyYears: true }, [])).toEqual([]);
  });
});
