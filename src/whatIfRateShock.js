// What if: Interest rate shocks (docs/specs/14-what-if.md, Commit 2) —
// pure, no DOM/Plotly. Runs the real shock via whatIf.js's runShock,
// then reads every per-loan figure through focusDebtPayoff.js's own
// buildDebtPayoffFocus (total interest, rollover before/after
// repayment, balance path) against BOTH the base and shocked outputs —
// never a second, re-derived copy of that logic. `state` is passed
// unchanged to both calls: only interest-rate FIELDS differ between
// base and shocked, never a liability's id/name, so the same state
// safely resolves either output's liability lookup.
import { runShock, eligibleRateShockLoans } from "./whatIf.js";
import { buildDebtPayoffFocus } from "./focusDebtPayoff.js";

export { eligibleRateShockLoans };

// The five magnitudes the spec calls for, base always shown alongside.
export const RATE_SHOCK_DELTAS = [-2, -1, 1, 2, 3];

// buildRateShockView({ state, shockKind, deltaPct }) → per-loan detail
// under both scenarios, plus the household-level deltas — or null when
// there's nothing to shock (no liabilities with an outstanding balance).
export function buildRateShockView({ state, shockKind, deltaPct }) {
  const loans = eligibleRateShockLoans(state);
  if (loans.length === 0) return null;

  const { base, shocked, deltas } = runShock(state, { kind: shockKind, deltaPct });

  const perLoan = loans.map((l) => ({
    id: l.id,
    name: l.name,
    rateType: l.rateType === "fixed" ? "fixed" : "variable",
    base: buildDebtPayoffFocus({ out: base, state, liabilityId: l.id }),
    shocked: buildDebtPayoffFocus({ out: shocked, state, liabilityId: l.id }),
  }));

  return {
    shockKind, deltaPct,
    perLoan,
    deltas,
    base, shocked,
    schedule: base.schedule,
  };
}
