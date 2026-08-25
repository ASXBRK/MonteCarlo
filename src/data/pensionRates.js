// Pension phase reference rates — spec 20, Commit 2.
//
// AS AT FY2026/27, sourced from the firm's reference set (Macquarie Big
// Black Book 2026/27, 20 Mar 2026 rate period edition — same source as
// au-fy-figures) unless flagged otherwise below.
//
// Minimum drawdown factors: age bands, applied to the pension's 1 July
// balance every FY (ITAA97 s 1.06(9A), Sch 7). Flat percentages, not
// indexed — these are legislated rates, not dollar thresholds.
export const MIN_DRAWDOWN_BANDS = Object.freeze([
  { minAge: 0, maxAge: 64, pct: 0.04 },
  { minAge: 65, maxAge: 74, pct: 0.05 },
  { minAge: 75, maxAge: 79, pct: 0.06 },
  { minAge: 80, maxAge: 84, pct: 0.07 },
  { minAge: 85, maxAge: 89, pct: 0.09 },
  { minAge: 90, maxAge: 94, pct: 0.11 },
  { minAge: 95, maxAge: Infinity, pct: 0.14 },
]);

export function minDrawdownPct(age) {
  const band = MIN_DRAWDOWN_BANDS.find((b) => age >= b.minAge && age <= b.maxAge);
  return band ? band.pct : MIN_DRAWDOWN_BANDS[MIN_DRAWDOWN_BANDS.length - 1].pct;
}

// TTR maximum drawdown: 10% of the 1 July balance, TTR only (not
// available once a TTR has converted to retirement phase — spec 20
// Commit 3 — a disclosed simplification of this build: the drawdown
// OPTION stays tied to the stored pension.type, which never itself
// changes on conversion, only the earnings-tax treatment does).
export const TTR_MAX_DRAWDOWN_PCT = 0.10;

// The minimum, pro-rated to the number of whole months remaining in the
// FY from commencement (or from a commutation, spec 20 Commit 5) to 30
// June — the ATO's own day-count rule, applied here at MONTH
// granularity to match this engine's own one-off-events-fire-in-July
// resolution (see keyDates.js/deterministic.js's `julyOf` convention:
// every age-anchored one-off event resolves to a WHOLE plan year,
// firing at 1 July or not at all). Because of that convention, a
// commencement or commutation in THIS engine can only ever land exactly
// on 1 July (a full 12 months remaining) or not fire in that FY at all
// — the <12 and 0 branches below are therefore never reached by the
// full engine (deterministic.js always calls this with
// monthsRemaining=12), but are implemented correctly and unit-tested
// directly, both because the ATO rule itself is monthly, not annual
// (12/12 would be a silent simplification, not a faithful model), and
// because a finer-grained future resolution should not need this
// function to change. monthsRemaining <= 0 (the ATO's own "commenced in
// June" exception) requires no minimum at all.
export function minDrawdownAmount(balanceAtStart, age, monthsRemaining = 12) {
  if (monthsRemaining <= 0) return 0;
  const months = Math.min(12, monthsRemaining);
  return balanceAtStart * minDrawdownPct(age) * (months / 12);
}
