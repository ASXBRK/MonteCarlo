// Market crash timing and sequence-of-returns risk (docs/specs/
// 14-what-if.md, Commit 3) — pure, no DOM/Plotly.
//
// REWRITTEN from the dormant single-portfolio "Path A vs Path B" DOM
// visualiser this file used to hold (disabled behind
// LEGACY_INSIGHTS_ENABLED since Phase A, written before the current
// multi-asset engine existed). Nothing from that version carries over:
// it generated its own synthetic normal-distributed returns
// (rejection-sampled, then reordered worst-first/worst-last) and
// manipulated the DOM directly — both patterns this codebase has since
// moved away from entirely. Every What-if/Focus view now runs the REAL
// engine on a real clone (or, here, with a real optional overlay) and
// returns plain data for main.js to render; nothing here invents its
// own return-generating process. What survives is the underlying
// insight — sequence matters, the SAME shock at a different age
// produces a radically different outcome — now demonstrated with a
// real deterministic crash against the real multi-asset engine instead
// of a synthetic illustration.
//
// The crash is injected via the SAME mc.shockFor(holdingId, m) hook
// Monte Carlo already uses (deterministic.js's own documented `mc`
// parameter) — no engine change needed. At the crash month, each
// holding's growth return is cut by dropPct scaled by its own
// growth-sleeve weight (classWeights — the same Australian/
// international equity + property split the Asset class allocation
// chart already derives); optionally followed by a recovery period of
// constant above-trend monthly returns that exactly undoes that
// holding's own proportional loss by the end of the period (a
// disclosed "V-shaped" modelling choice, not a re-derivation of
// anything the engine itself asserts).
import { classWeightsForAllocation } from "./allocation.js";
import { buildSchedules, monthsInFirstYear } from "./schedule.js";
import { resolveRef } from "./keyDates.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";
import { registerShockKind } from "./whatIf.js";

// Mirrors schedule.js's own (unexported) julyMonthIndex exactly: full
// years always start in July; year 0 fires only when the projection
// itself starts in July — the partial-first-year skip (convention 5)
// every other annual/one-off event in this engine already follows, so
// a crash at an age landing in a non-July first year simply doesn't
// fire, the same as a property purchase or a super release would.
function julyMonthIndex(plan, y) {
  if (y === 0) return plan.start.month === 7 ? 0 : null;
  return monthsInFirstYear(plan.start) + 12 * (y - 1);
}

// The growth-sleeve fraction of a holding's own resolved classWeights
// — Australian/international equity + property, i.e. everything
// EXCEPT fixed interest and cash — "how much of THIS holding's balance
// is actually exposed to a market crash." A stale/unknown profile
// reference contributes nothing, the same disclosed handling
// allocation.js's own allocationSeries already uses.
function growthFraction(allocation, profiles) {
  const w = classWeightsForAllocation(allocation, profiles);
  if (!w) return 0;
  return (w.ausEquity + w.intEquity + w.property) / 100;
}

// Every holding a crash can act on: non-lifestyle financial assets and
// super accounts — exactly allocation.js's own allocationSeries scope
// ("lifestyle assets and properties are excluded... neither carries a
// profile or a classWeights split").
export function crashHoldings(state) {
  return [
    ...(state.assets ?? []).filter((a) => a.include && a.class !== "lifestyle")
      .map((a) => ({ id: a.id, allocation: a.allocation })),
    ...(state.plan.superAccounts ?? []).filter((sa) => sa.include)
      .map((sa) => ({ id: sa.id, allocation: sa.allocation })),
  ];
}

// buildCrashMc(state, shock, profiles) → an mc-shaped object
// (deterministic.js's own `mc` parameter — {shockFor(holdingId, m)})
// that injects the crash, or null if the crash month can't be
// resolved. `shock` is {dropPct, atAge, recoveryYears}: dropPct is a
// plain percentage (30 means 30%), recoveryYears may be 0/omitted for
// no recovery (a permanent loss — a legitimate, disclosed choice, not
// a bug).
export function buildCrashMc(state, shock, profiles = PROFILES) {
  const { dropPct, atAge, recoveryYears = 0 } = shock;
  const schedule = buildSchedules(state);
  const ref = resolveRef({ kind: "age", age: atAge }, state.plan, schedule, "client");
  const crashMonth = julyMonthIndex(state.plan, ref.planYear);
  if (crashMonth == null) return null;

  const holdings = crashHoldings(state);
  const fractionById = new Map(holdings.map((h) => [h.id, growthFraction(h.allocation, profiles)]));
  const recoveryMonths = Math.max(0, Math.round((recoveryYears ?? 0) * 12));
  const dropFrac = dropPct / 100;

  // Monthly excess return during recovery that compounds, over exactly
  // `recoveryMonths` further months, to exactly reverse THIS holding's
  // own proportional loss: (1 - loss) × (1 + x)^recoveryMonths = 1.
  const recoveryRateById = new Map();
  for (const [id, w] of fractionById) {
    const loss = dropFrac * w;
    recoveryRateById.set(id, (recoveryMonths > 0 && loss > 0 && loss < 1)
      ? Math.pow(1 / (1 - loss), 1 / recoveryMonths) - 1
      : 0);
  }

  return {
    shockFor(holdingId, m) {
      const w = fractionById.get(holdingId);
      if (!w) return 0; // not a crash-eligible holding, or 100% defensive/cash
      if (m === crashMonth) return -dropFrac * w;
      if (m > crashMonth && m <= crashMonth + recoveryMonths) return recoveryRateById.get(holdingId) ?? 0;
      return 0;
    },
    crashMonth, recoveryMonths,
  };
}

// runCrashShock(state, shock) → { base, shocked, mc } | null. Not built
// on whatIf.js's runShock — a crash needs no STATE FIELD changed at
// all (unlike a rate shock), only the separate `mc` side-channel
// deterministic.js already exposes — but the same discipline applies:
// `state` is never mutated, base is a plain unshocked run, shocked is
// the SAME state with the crash's mc override layered on top. Also
// registered as the "crash" shock kind in whatIf.js's own registry
// (see the bottom of this file) so a single-crash comparison can go
// through the SAME generic runner every other shock uses.
export function runCrashShock(state, shock, profiles = PROFILES) {
  const mc = buildCrashMc(state, shock, profiles);
  if (!mc) return null;
  const base = projectPlan(state, profiles);
  const shocked = projectPlan(state, profiles, mc);
  return { base, shocked, mc };
}

// Self-registers with whatIf.js's generic runner (same convention as
// Commit 2's rate shocks) — a single-crash comparison can go through
// runShock exactly like every other shock kind. The applier mutates
// nothing (a crash needs no state field changed) and instead returns
// the mc override runShock now knows how to thread through.
registerShockKind("crash", (clonedState, shock) => buildCrashMc(clonedState, shock, PROFILES));
