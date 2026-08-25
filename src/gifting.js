// Gifting and deprivation (spec 21b, Commit 2) — pure mechanics, no
// DOM/plan-state knowledge. The caller (deterministic.js) resolves
// each gift's DateRef to a firing month first ("fires in July of its
// resolved plan year, or never" — the same convention every other
// one-off event in this engine already uses) and hands this module a
// plain list of { id, month, amount, planYear }.
//
// Rules (firm reference, spec's own words): $10,000 per financial
// year, $30,000 maximum over a ROLLING five years — "it is not five
// financial years from the first gift, it is a moving window". Neither
// figure is indexed. The amount above either limit is a DEPRIVED
// asset, assessed under both the assets test (at face value) and the
// income test (deemed, like any other financial asset) for exactly
// five years from the GIFT'S OWN date, after which it drops out.

export const GIFT_ANNUAL_LIMIT = 10000; // per FY, not indexed
export const GIFT_FIVE_YEAR_LIMIT = 30000; // rolling 5 years, not indexed
export const GIFT_DEPRIVATION_MONTHS = 60; // 5 years

// Resolves every gift (processed in chronological order by firing
// month, regardless of input order) to how much of it is ALLOWABLE
// (within both the annual and rolling-five-year limits, so it drops
// straight out of assessment) vs DEPRIVED (assessed under both means
// tests until it ages out). Each gift's own remainders are computed
// against every EARLIER gift's already-resolved allowable amount —
// never against amounts an earlier gift already had deprived, since
// only the allowable portion is what the annual/five-year limits
// actually track.
export function resolveGiftDeprivation(gifts) {
  const sorted = [...gifts].sort((a, b) => a.month - b.month);
  const resolved = [];
  for (const g of sorted) {
    // Annual remainder: $10,000 less whatever's already allowable from
    // EARLIER gifts in the SAME plan year (financial year).
    const usedThisFy = resolved
      .filter((r) => r.planYear === g.planYear)
      .reduce((s, r) => s + r.allowable, 0);
    const annualRemainder = Math.max(0, GIFT_ANNUAL_LIMIT - usedThisFy);
    // Five-year remainder: $30,000 less whatever's already allowable
    // from EARLIER gifts within the 60 months immediately before (and
    // including) THIS gift's own month — a moving window, not five
    // financial years from the first gift (the spec's own "fiddly
    // part").
    const usedInWindow = resolved
      .filter((r) => r.month > g.month - GIFT_DEPRIVATION_MONTHS && r.month <= g.month)
      .reduce((s, r) => s + r.allowable, 0);
    const fiveYearRemainder = Math.max(0, GIFT_FIVE_YEAR_LIMIT - usedInWindow);
    const allowable = Math.max(0, Math.min(g.amount, annualRemainder, fiveYearRemainder));
    const deprived = g.amount - allowable;
    resolved.push({ ...g, allowable, deprived });
  }
  return resolved;
}

// The sum of every still-active deprived amount as of a given month —
// active means the gift has already fired (month <= asOfMonth) and
// fewer than GIFT_DEPRIVATION_MONTHS have elapsed since (dropping out
// EXACTLY at the five-year mark, not one month either side of it).
export function deprivedAssetsAt(resolvedGifts, asOfMonth) {
  return resolvedGifts
    .filter((g) => g.month <= asOfMonth && g.month + GIFT_DEPRIVATION_MONTHS > asOfMonth)
    .reduce((s, g) => s + g.deprived, 0);
}
