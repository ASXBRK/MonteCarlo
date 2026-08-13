// Conservation invariant (engine-correctness fix, generalized) — pure,
// no DOM/Plotly. Extracted from deterministic.test.js's "Conservation
// invariant" describe block so Monte Carlo (monteCarlo.js) can run the
// exact same check against simulated paths, not a re-typed copy of it
// (a second copy is how an invariant meant to catch drift quietly
// drifts itself). Both money-creation bugs found so far (the original
// WCA-debit gap e1eb61a fixed, and the toConcessionalCap gap
// 2867768 closed) would have failed this invariant, and nothing in the
// suite checked it before deterministic.test.js added it.
//
// For every plan year (excluding the projection's final year — see
// below), the change in total net position must equal the sum of
// every NAMED source of cash entering or leaving the household —
// nothing left unaccounted:
//
//   N(y) = financial assets + super + working cash − liabilities
//        = out.yearly[y].netAssets (the engine's own figure)
//
//   ΔN(y) = income (incl. WCA interest — real household income — and any
//           salary-sacrifice contribution, gross: it never touches
//           `row.income`, since schedule.js/a-super-fill reduce that at
//           the source like a real payroll would, but it's still real
//           earned value, just redirected into super net of the
//           contributions tax below — omitting it here would double-
//           subtract it)
//         + growth (asset growth + super earnings, NET of fund tax)
//         + externalInflows (employer SG — money the household never
//           had to forgo, entering only through super)
//         − expenses
//         − tax (income tax, CGT, Div293/296 — whatever `row.tax` is
//           this FY)
//         − contributionsTax (the 15%/30% skimmed off a contribution on
//           the way into super — the one place a contribution's gross
//           cash debit and net super credit are legitimately allowed to
//           differ)
//         − liabilityInterest (the real cost of debt; principal
//           repayment is conservation-neutral — the WCA falls by the
//           payment, the liability falls by the same principal, and the
//           two mostly cancel in N)
//         + liabilityRevaluation (a fixed nominal debt's REAL value
//           erodes with inflation faster than cash principal repayment
//           alone explains — a real gain to net worth with no cash flow
//           behind it, the mirror image of an offset asset's CPI decay)
//         − surplusSpent (the FY-end "spend" sweep — money that leaves
//           the WCA with no asset on the other side, by design)
//         + unfundedCashflow (an outflow the ledger recorded that the
//           household couldn't actually pay — the WCA is forced back up
//           to its minimum rather than left negative (convention 11), so
//           this must be added back or the convention itself would read
//           as a leak)
//
// Deliberately out of scope, so the invariant stays unambiguous rather
// than merely thorough — each is its own already-tested subsystem:
//  - properties (their own duty/FHOG/settlement cost accounting, D4)
//  - explicit asset/super withdrawal rows (a shortfall there is cash the
//    household simply didn't receive, not a leak — mixing it into the
//    same `unfundedCashflow` figure as the WCA top-up's shortfall would
//    make that one figure ambiguous)
//  - non-concessional contributions (a rejected excess is a separate,
//    already-tested modelling choice — Commit 2's "rejected... not
//    credited" — not a target of this invariant)
//  - the projection's final year (its CGT/Div293/Div296 assessment
//    surfaces as an accrued liability, not a cashflow — decision 13/14 —
//    so N doesn't yet reflect it; that's the documented convention, not
//    a leak)
//
// Monte Carlo's random return shocks (Session B) touch none of the
// terms above except `row.growth`/superDetail's earnings figures
// themselves — those are accumulated from whatever return was actually
// realised that path, shock included — so this invariant should hold
// identically on a stochastic path as on a deterministic one. If it
// doesn't, the shock injection broke the engine's bookkeeping, not the
// invariant's accounting.
//
// Throws on violation (rather than returning a boolean) so a caller
// can drop it straight into a loop without adding its own assertion —
// see monteCarlo.test.js's per-path spot check for the pattern.
export function checkYearConservation(out, y, ctx) {
  const row = out.yearly[y];
  const prev = y > 0 ? out.yearly[y - 1] : null;
  const sumVals = (obj, key) => Object.values(obj).reduce((s, v) => s + v[key], 0);

  const openingN = prev
    ? prev.netAssets
    : row.openingBalance + row.wcaDetail.opening
      + sumVals(row.superDetail, "opening") - sumVals(row.liabilities, "opening");
  const closingN = row.netAssets;

  const superEarningsNet = sumVals(row.superDetail, "earnings") - sumVals(row.superDetail, "earningsTax");
  const contributionsTax = sumVals(row.superDetail, "contributionsTax");
  const sgInflow = sumVals(row.superDetail, "sg");
  const salarySacrificed = sumVals(row.superDetail, "salarySacrifice");
  const liabilityInterest = sumVals(row.liabilities, "interest");
  // A liability's nominal balance amortises independently of CPI, but
  // its REAL value (opening/closing, both deflated by that month's
  // cumulative CPI factor) erodes faster than cash principal
  // repayment alone accounts for — the rest is inflation quietly
  // shrinking the real burden of a fixed nominal debt, a genuine gain
  // to net worth with no cash flow behind it at all (the mirror image
  // of an offset asset's cpiDecayMonthly in deterministic.js's growth
  // step). Deriving it from the engine's own opening/closing/principal
  // figures (rather than reconstructing month-by-month deflation)
  // keeps this exact regardless of the rate path.
  const liabilityRevaluation = sumVals(row.liabilities, "opening") - sumVals(row.liabilities, "closing")
    - sumVals(row.liabilities, "principal");

  // A salary-sacrifice contribution (explicit or a toConcessionalCap
  // fill of that type) never touches `row.income` — schedule.js/
  // a-super-fill reduce it upstream, at the source, the same way an
  // employer's payroll would. But the sacrificed amount is still real
  // earned value, just redirected: it reappears net-of-contributions-
  // tax in super. Add it back here so only the contributions tax
  // itself (below) is counted as the leak — otherwise this formula
  // would double-subtract it (once by excluding it from income, again
  // implicitly by not crediting where it actually landed).
  const income = row.income + row.wcaDetail.interest + salarySacrificed;
  const growth = row.growth + superEarningsNet + liabilityRevaluation;

  const expected =
    income + growth + sgInflow
    - row.expenses - row.tax - contributionsTax - liabilityInterest
    - row.surplusSpent + row.unfundedCashflow;

  const delta = closingN - openingN;
  const gap = delta - expected;
  const tol = Math.max(0.05, Math.abs(closingN) * 1e-6);
  if (Math.abs(gap) > tol) {
    throw new Error(
      `Conservation invariant violated by ${gap.toFixed(4)} (tol ${tol.toFixed(4)}) at ${ctx}: ` +
      `delta=${delta.toFixed(2)} expected=${expected.toFixed(2)}`
    );
  }
}
