import { describe, it, expect } from "vitest";
import { resolveGiftDeprivation, deprivedAssetsAt, GIFT_ANNUAL_LIMIT, GIFT_FIVE_YEAR_LIMIT, GIFT_DEPRIVATION_MONTHS } from "./gifting.js";

describe("resolveGiftDeprivation — known values (spec 21b, Commit 2)", () => {
  it("a $10,000 gift is fully allowable", () => {
    const [g] = resolveGiftDeprivation([{ id: "g1", month: 0, amount: 10000, planYear: 0 }]);
    expect(g.allowable).toBe(10000);
    expect(g.deprived).toBe(0);
  });

  it("a $15,000 gift produces $5,000 deprived", () => {
    const [g] = resolveGiftDeprivation([{ id: "g1", month: 0, amount: 15000, planYear: 0 }]);
    expect(g.allowable).toBe(10000);
    expect(g.deprived).toBe(5000);
  });

  it("three $10,000 gifts in successive years, then a fourth breaching the rolling five-year limit", () => {
    // Julys of years 0, 1, 2, 3 — 12 months apart, all within the same
    // 60-month rolling window.
    const gifts = [
      { id: "g0", month: 0, amount: 10000, planYear: 0 },
      { id: "g1", month: 12, amount: 10000, planYear: 1 },
      { id: "g2", month: 24, amount: 10000, planYear: 2 },
      { id: "g3", month: 36, amount: 10000, planYear: 3 },
    ];
    const resolved = resolveGiftDeprivation(gifts);
    // Each of the first three is individually under BOTH limits (own
    // FY has no other gift; the five-year window has room), so each
    // is fully allowable — $30,000 used by year 3.
    expect(resolved[0].allowable).toBe(10000);
    expect(resolved[1].allowable).toBe(10000);
    expect(resolved[2].allowable).toBe(10000);
    // The fourth: its own FY is fresh ($10,000 annual remainder), but
    // the rolling five-year window (months -24..36) already holds all
    // three prior $10,000 allowable amounts — $30,000 — leaving $0
    // five-year remainder, so the WHOLE fourth gift is deprived.
    expect(resolved[3].allowable).toBe(0);
    expect(resolved[3].deprived).toBe(10000);
  });

  it("the annual limit binds within the SAME financial year even with five-year room to spare", () => {
    // Two gifts in the same plan year — $10,000 then $8,000. Combined
    // five-year exposure ($18,000) is nowhere near $30,000, but the
    // annual limit only leaves $0 remainder for the second gift.
    const resolved = resolveGiftDeprivation([
      { id: "g0", month: 0, amount: 10000, planYear: 0 },
      { id: "g1", month: 1, amount: 8000, planYear: 0 },
    ]);
    expect(resolved[0].allowable).toBe(10000);
    expect(resolved[1].allowable).toBe(0);
    expect(resolved[1].deprived).toBe(8000);
  });

  it("processes gifts in chronological order regardless of input order", () => {
    const outOfOrder = resolveGiftDeprivation([
      { id: "later", month: 12, amount: 10000, planYear: 1 },
      { id: "earlier", month: 0, amount: 15000, planYear: 0 },
    ]);
    const earlier = outOfOrder.find((g) => g.id === "earlier");
    const later = outOfOrder.find((g) => g.id === "later");
    // "earlier" (month 0) is assessed as if nothing preceded it — the
    // full $10,000 annual limit, $5,000 deprived — exactly the single-
    // gift case above, unaffected by "later" appearing first in the array.
    expect(earlier.allowable).toBe(10000);
    expect(earlier.deprived).toBe(5000);
    expect(later.allowable).toBe(10000);
  });

  it("GIFT_ANNUAL_LIMIT/GIFT_FIVE_YEAR_LIMIT/GIFT_DEPRIVATION_MONTHS match the firm reference", () => {
    expect(GIFT_ANNUAL_LIMIT).toBe(10000);
    expect(GIFT_FIVE_YEAR_LIMIT).toBe(30000);
    expect(GIFT_DEPRIVATION_MONTHS).toBe(60);
  });
});

describe("deprivedAssetsAt — the moving five-year window (spec 21b, Commit 2)", () => {
  it("counts a deprived amount from the gift's own month onward", () => {
    const resolved = resolveGiftDeprivation([{ id: "g1", month: 24, amount: 15000, planYear: 2 }]);
    expect(deprivedAssetsAt(resolved, 23)).toBe(0); // before the gift fires
    expect(deprivedAssetsAt(resolved, 24)).toBe(5000); // the month it fires
    expect(deprivedAssetsAt(resolved, 83)).toBe(5000); // 59 months later — still active
  });

  it("drops out EXACTLY five years (60 months) after the gift's own date", () => {
    const resolved = resolveGiftDeprivation([{ id: "g1", month: 24, amount: 15000, planYear: 2 }]);
    expect(deprivedAssetsAt(resolved, 24 + 60)).toBe(0); // exactly 60 months later — dropped out
    expect(deprivedAssetsAt(resolved, 24 + 59)).toBe(5000); // one month before that — still counted
  });

  it("sums multiple concurrently-active deprived amounts", () => {
    const resolved = resolveGiftDeprivation([
      { id: "g0", month: 0, amount: 15000, planYear: 0 }, // $5,000 deprived, active months [0, 60)
      { id: "g1", month: 12, amount: 10000, planYear: 1 }, // fully allowable, $0 deprived
      { id: "g2", month: 24, amount: 40000, planYear: 2 }, // fresh FY: $10,000 allowable, but 5yr window already has g0+g1's $20,000 allowable, remainder $10,000 → allowable $10,000, deprived $30,000
    ]);
    // At month 30: g0's $5,000 still active (drops at 60), g2's
    // $30,000 active (drops at 84) — g1 contributed nothing deprived.
    expect(deprivedAssetsAt(resolved, 30)).toBe(5000 + 30000);
    // At month 60: g0 has just dropped out; only g2 remains.
    expect(deprivedAssetsAt(resolved, 60)).toBe(30000);
  });
});
