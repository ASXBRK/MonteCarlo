// Divergence measurement (spec 30, Commit 2) — quantifies the gap
// between the real engine and the static extrapolation model
// (staticProjection.js), and attributes it to the seven named drivers.
// No engine changes; this measures the engine rather than extending it
// (the spec's own words).
//
// Scope-matched comparison: the real engine's own `netAssets` includes
// property, bonds and the Working Cash Account, which
// staticProjection.js does NOT track (disclosed there). Comparing the
// real engine's FULL netAssets against the static model's NARROWER one
// would measure a scope difference, not a modelling one — exactly the
// "implementation difference, not a modelling one" trap the spec's own
// control test (staticProjection.test.js) exists to catch. This file
// instead computes a REAL, SAME-SCOPE net worth figure per year
// (assets + super + pension − liabilities, straight off the real
// engine's own per-year totals) and compares like for like.
//
// Driver attribution: for each driver, re-run the static model with
// JUST that one `realism` flag enabled (staticProjection.js's own
// mechanism) and see how much of the final-year gap closes. The seven
// drivers sum to the total gap only approximately — drivers can
// interact (e.g. a loan closing changes how much surplus is available
// for a contribution that also stops) — so the residual is reported
// explicitly, never silently folded into any one driver's own figure.

import { projectPlan } from "./deterministic.js";
import { projectStatic } from "./staticProjection.js";
import { PROFILES } from "./profiles.js";

export const DRIVERS = [
  { key: "loanMaturity", label: "Loan maturity (surplus lost after payoff)" },
  { key: "expenseWindows", label: "Expense windows closing" },
  { key: "contributionsStopping", label: "Contributions stopping" },
  { key: "taxBrackets", label: "Tax bracket effects" },
  { key: "fixedRateRollover", label: "Fixed-rate rollover" },
  { key: "agePension", label: "Age pension entitlement" },
  { key: "superPensionTransitions", label: "Super preservation and pension phase transitions" },
];

// The real engine's own per-year total, narrowed to exactly the
// accounts staticProjection.js tracks — see this file's own header.
function comparableNetAssets(row) {
  return (row.closingBalance ?? 0) + (row.superClosing ?? 0) + (row.pensionClosing ?? 0) - (row.liabilitiesClosing ?? 0);
}

function pctDiffOf(diff, real) {
  if (real !== 0) return diff / Math.abs(real);
  return diff === 0 ? 0 : Infinity;
}

// measureDivergence(state, { snapshotYears, indexation }) →
//   { byYear, summary, drivers, totalGap, residual }
//
// `snapshotYears` follows staticProjection.js's own naming (a single
// plan-year index the extrapolation starts from); an array is accepted
// for the same reason it is there — this measures only its FIRST entry
// (a divergence measurement is inherently about ONE baseline; run this
// function once per snapshot year for a multi-column comparison, the
// same way the Focus view and committed report, Commit 3, do).
export function measureDivergence(state, opts = {}) {
  const indexation = opts.indexation ?? "flat";
  const profiles = opts.profiles ?? PROFILES;
  const snapshotYear = Array.isArray(opts.snapshotYears) ? opts.snapshotYears[0] : (opts.snapshotYears ?? 0);

  const out = projectPlan(state, profiles);
  const planYears = out.yearly.length;
  const staticYearly = projectStatic(state, { snapshotYears: snapshotYear, indexation, profiles });

  const byYear = staticYearly.map((row, i) => {
    const y = snapshotYear + i;
    const real = comparableNetAssets(out.yearly[y]);
    const diff = row.netAssets - real;
    return {
      y, fyLabel: out.yearly[y].fyLabel,
      netAssetsReal: real, netAssetsStatic: row.netAssets,
      diff, pctDiff: pctDiffOf(diff, real),
    };
  });

  const atYearsAfter = (n) => byYear.find((r) => r.y === snapshotYear + n) ?? null;
  const firstExceeding = (threshold) => byYear.find((r) => Math.abs(r.pctDiff) > threshold)?.y ?? null;
  const summary = {
    at10: atYearsAfter(10),
    at20: atYearsAfter(20),
    at30: atYearsAfter(30),
    atEnd: byYear[byYear.length - 1] ?? null,
    firstExceeds5Pct: firstExceeding(0.05),
    firstExceeds10Pct: firstExceeding(0.10),
  };

  const finalReal = comparableNetAssets(out.yearly[planYears - 1]);
  const finalBaseline = byYear[byYear.length - 1]?.netAssetsStatic ?? 0;
  const totalGap = finalReal - finalBaseline;

  const drivers = DRIVERS.map(({ key, label }) => {
    const fixed = projectStatic(state, { snapshotYears: snapshotYear, indexation, profiles, realism: { [key]: true } });
    const fixedFinal = fixed[fixed.length - 1]?.netAssets ?? finalBaseline;
    return { key, label, contribution: fixedFinal - finalBaseline };
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const residual = totalGap - drivers.reduce((s, d) => s + d.contribution, 0);

  return { byYear, summary, drivers, totalGap, residual };
}
