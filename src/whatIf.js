// What If — shock testing (docs/specs/14-what-if.md). Pure, no DOM/
// Plotly. The governing principle, unchanged from Focus
// (docs/specs/12-focus-views.md): a What-if view is a VIEW. It runs
// projectPlan() on a modified CLONE of the scenario and compares the
// result to the base run — it never re-derives a figure the engine
// produces, and it never mutates the caller's own state.
//
// Shock kinds are declarative ({kind, ...params}) and self-register via
// registerShockKind — each commit that adds a kind (Commits 2-4) calls
// it once, at the bottom of the module that owns that shock's logic.
// This avoids one switch statement growing across five commits, and
// keeps runShock() itself completely stable: it has never needed to
// change since Commit 1, only the registry has grown.
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";

const SHOCK_APPLIERS = new Map();

// registerShockKind(kind, applyFn) — applyFn(clonedState, shock) mutates
// the clone IN PLACE according to the shock's own parameters. Never
// called with the caller's real state (see runShock).
export function registerShockKind(kind, applyFn) {
  SHOCK_APPLIERS.set(kind, applyFn);
}

// runShock(state, shock) → { base, shocked, deltas }. `state` is never
// mutated: applyFn only ever sees a structuredClone (state is plain
// JSON, the same convention solve.js/every Focus solver already uses —
// see solve.js's own header for why). Base and shocked are both full,
// independent projectPlan() runs — the base is the caller's OWN scenario,
// completely unmodified.
export function runShock(state, shock) {
  const applyFn = SHOCK_APPLIERS.get(shock?.kind);
  if (!applyFn) throw new Error(`Unknown shock kind: ${shock?.kind}`);
  const clone = structuredClone(state);
  applyFn(clone, shock);
  const base = projectPlan(state, PROFILES);
  const shocked = projectPlan(clone, PROFILES);
  return { base, shocked, deltas: buildDeltas(base, shocked) };
}

// buildDeltas(base, shocked) — per plan year: the shocked-minus-base
// change in net assets, closing balance, total tax, surplus, and
// unfunded cashflow; plus headline figures (end net assets, first
// shortfall age, total unfunded) for EACH run, not just the delta,
// since "the shock introduces unfunded cashflow where there was none"
// is itself often the headline (Commits 2/4's own affordability
// framing) and a delta of two zeros vs a delta of two non-zeros both
// read as "0" without the underlying figures alongside them.
//
// Exported and tested independently of any shock kind — this is "the
// delta shape" the spec's Commit 1 is about, and it never depends on
// what produced `shocked` (a rate shock, a crash, an income gap, or a
// synthetic test fixture are all the same shape to this function).
export function buildDeltas(base, shocked) {
  const years = Math.min(base.yearly.length, shocked.yearly.length);
  const byYear = [];
  for (let y = 0; y < years; y++) {
    const b = base.yearly[y], s = shocked.yearly[y];
    byYear.push({
      year: y,
      netAssets: s.netAssets - b.netAssets,
      closingBalance: s.closingBalance - b.closingBalance,
      totalTax: s.tax - b.tax,
      surplus: s.surplusOrDeficit - b.surplusOrDeficit,
      unfundedCashflow: s.unfundedCashflow - b.unfundedCashflow,
    });
  }
  const headlineFor = (out) => ({
    endNetAssets: out.yearly.length ? out.yearly[out.yearly.length - 1].netAssets : 0,
    firstShortfallAge: out.shortfall?.clientAge ?? null,
    totalUnfunded: out.shortfall?.total ?? 0,
  });
  return { byYear, headline: { base: headlineFor(base), shocked: headlineFor(shocked) } };
}

// --- Commit 2: Interest rate shocks -----------------------------------------
//
// The behaviour that makes this worth building: a VARIABLE loan's rate
// moves immediately (it always does, in reality); a FIXED loan's
// contracted rate cannot move before its own rollover date — only the
// rate it rolls INTO can. Shocking every loan uniformly would erase
// that differential, which is the entire point of the view (a fixed
// loan shields a client from a rate rise until rollover; a shock that
// doesn't show that teaches nothing). No engine change is needed for
// either shock — deterministic.js already switches a fixed loan's rate
// at its own rolloverMonth (Implementation/Rates spec, Commit 1); both
// shocks below just move the INPUT fields that switch already reads.
//
// revertRatePct is nullable (defaults to assumptions.mortgageRate — see
// planState.js's clampLiability and deterministic.js's own resolution)
// — resolving it to a concrete number BEFORE adding the shock is what
// makes the shock apply even to a loan that has never had its own
// revert rate overridden.
function resolvedRevertPct(l, assumptions) {
  return l.revertRatePct != null ? l.revertRatePct : (assumptions.mortgageRate ?? 0.06) * 100;
}

export function eligibleRateShockLoans(state) {
  return (state.liabilities ?? []).filter((l) => l.balance > 0);
}

function applyRateShock(clone, shock) {
  for (const l of clone.liabilities ?? []) {
    if (l.rateType === "fixed") {
      l.revertRatePct = resolvedRevertPct(l, clone.assumptions) + shock.deltaPct;
    } else {
      l.interestRatePct = (l.interestRatePct ?? 0) + shock.deltaPct;
    }
  }
}

function applyRevertRateShock(clone, shock) {
  for (const l of clone.liabilities ?? []) {
    if (l.rateType !== "fixed") continue; // leaves the current rate alone, and has nothing to act on for a variable loan
    l.revertRatePct = resolvedRevertPct(l, clone.assumptions) + shock.deltaPct;
  }
}

registerShockKind("rateShock", applyRateShock);
registerShockKind("revertRateShock", applyRevertRateShock);
