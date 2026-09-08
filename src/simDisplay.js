// Display honesty (docs/specs/36-retirement-outputs.md, Commit 3) —
// pure, no DOM/Plotly. Every simulation-derived probability shown
// anywhere in this tool (ruin probability, "lasts to life expectancy",
// each outcome bucket's own share, a lever's before/after figure, the
// sustainable-spend baseline) is meant to go through formatSimPct
// before it reaches a template, so the two rules below apply
// EVERYWHERE, not just where someone remembered to add them by hand.
//
// The 99% cap. "No probability figure derived from simulation ever
// displays above 99%" — the spec's own words, citing Timeline's own
// stated rationale for the identical convention: capping and rounding
// this way is to avoid implying a guarantee a 2,000-path simulation
// cannot actually support, however extreme the raw figure. This caps
// the DISPLAY STRING only — formatSimPct never mutates the number it's
// given, and every solver/scenario-comparison call site keeps reading
// the exact, uncapped, unrounded value directly off mcResult/
// leversResults/etc. (never this module).
//
// The 1% rounding. "92.6% invites a conversation about a 0.6% that
// 2,000 paths cannot support" — the spec's own words. Rounded here,
// once, rather than at each of the many call sites that would
// otherwise each roll their own Math.round.
export function formatSimPct(p) {
  if (p == null || Number.isNaN(p)) return "—";
  const clamped = Math.max(0, Math.min(1, p));
  const displayPct = Math.round(clamped * 100);
  return displayPct >= 100 ? "99%+" : `${displayPct}%`;
}

// Whether formatSimPct's own output for `p` is the capped "99%+" form
// — main.js uses this to decide whether to attach the "why capped"
// tooltip (tooltipHTML is DOM-adjacent, kept out of this pure module).
export function isSimPctCapped(p) {
  return formatSimPct(p) === "99%+";
}

export const SIM_PCT_CAP_EXPLANATION =
  "Capped at 99% — a simulation can't support a claim of certainty, however high the raw figure. The underlying value is unaffected; solvers and scenario comparison still use the exact figure.";
