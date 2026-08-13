// Period thinning (D5) — pure, no DOM. Replaces the old All/Next 10/
// Next 20 presets: full detail across [fromAge, toAge], then every
// Nth plan year beyond `toAge` through the projection's actual end
// (rather than truncating there). forceKeyYears pins the first and
// last projection years plus any explicitly forced years (a shortfall
// year, a property purchase year) into the display even when the
// From/To/N bounds would otherwise skip them.
//
// Applies uniformly to every output table, chart x-range, and export.

// Plan-year index of the first year whose client age is >= `age`.
function firstAtLeast(clientAges, age) {
  for (let i = 0; i < clientAges.length; i++) if (clientAges[i] >= age) return i;
  return clientAges.length - 1;
}

// Plan-year index of the last year whose client age is <= `age`.
function lastAtMost(clientAges, age) {
  for (let i = clientAges.length - 1; i >= 0; i--) if (clientAges[i] <= age) return i;
  return 0;
}

// clientAges: the schedule's per-plan-year client age array.
// forcedYears: extra plan-year indices to always keep when forcing
// (e.g. the shortfall year, planned-property purchase years).
export function thinnedYearIndices({ fromAge, toAge, everyN, forceKeyYears }, clientAges, forcedYears = []) {
  const n = clientAges.length;
  if (n === 0) return [];
  const fromIdx = fromAge != null ? Math.min(n - 1, firstAtLeast(clientAges, fromAge)) : 0;
  const toIdx = toAge != null ? Math.max(fromIdx, lastAtMost(clientAges, toAge)) : n - 1;
  const step = Math.max(1, Math.round(everyN) || 1);

  const keep = new Set();
  for (let y = fromIdx; y <= toIdx; y++) keep.add(y); // full detail
  for (let y = toIdx + step; y < n; y += step) keep.add(y); // thinned tail

  if (forceKeyYears) {
    keep.add(0);
    keep.add(n - 1);
    for (const fy of forcedYears) if (fy >= 0 && fy < n) keep.add(fy);
  }
  return [...keep].sort((a, b) => a - b);
}
