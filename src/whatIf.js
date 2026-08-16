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
import { buildSchedules } from "./schedule.js";
import { resolveRef } from "./keyDates.js";

const SHOCK_APPLIERS = new Map();

// registerShockKind(kind, applyFn) — applyFn(clonedState, shock) mutates
// the clone IN PLACE according to the shock's own parameters, and may
// optionally RETURN an mc-shaped object ({shockFor(holdingId, m), ...}
// — deterministic.js's own documented Monte Carlo overlay parameter)
// when the shock needs a side-channel return-path override rather than
// a state field change (Commit 3's market crash: no liability/asset
// field changes at all, only a one-off return injected via the same
// mechanism Monte Carlo already uses). Never called with the caller's
// real state (see runShock).
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
  const mc = applyFn(clone, shock) || null;
  const base = projectPlan(state, PROFILES);
  const shocked = projectPlan(clone, PROFILES, mc);
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
// wcaClosing and deficitFunded (What-if cashflow-lens follow-up) carry
// BASE AND SHOCKED absolute values, not a delta — unlike the other
// series, the cashflow lens plots both as their own lines (does the
// buffer hold; what's being sold to bridge a gap), where a single
// difference number would answer the wrong question.
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
      wcaClosing: { base: b.wcaClosing, shocked: s.wcaClosing },
      deficitFunded: { base: b.deficitFundedFromAssets, shocked: s.deficitFundedFromAssets },
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

// --- Commit 4: Income interruption and expense shock ------------------------
//
// Income interruption ({kind: "incomeGap", ownerId, atAge, months,
// replacementPct}) is a genuine STATE-level change (splitting an
// income row across the gap), not an mc side-channel — unlike the
// crash's return shock, income needs to move BOTH sides consistently
// (the household's monthly cash AND that person's ANNUAL taxable
// income, since tax is assessed from the SAME row-level figures
// cashflowStatement.js's own assessableIncome already reads) — an
// mc-only override would reduce cash but leave tax computed on the
// full, un-reduced salary, a real inconsistency, not a simplification.
// Only a state-level row change moves both together correctly.
//
// Every DateRef in this engine resolves to a WHOLE PLAN YEAR (age
// anchors snap to 1 July of the year the age is reached — see
// keyDates.js's resolveOwnerAge; annual rows and one-offs fire in July
// for the same reason, per CLAUDE.md's own Cashflows convention) — there
// is no month-level date granularity anywhere in this schema. `months`
// is therefore rounded to the nearest whole number of plan years (a
// disclosed simplification, not a bug): a plan year is genuinely the
// finest interval a "when" can express here, the same as a fixed-rate
// rollover or a planned purchase.
function applyIncomeGap(clone, shock) {
  const { ownerId, atAge, months, replacementPct } = shock;
  const owner = ownerId === "partner" ? "partner" : "client";
  const ownerCurrentAge = owner === "partner" ? clone.plan.partner?.currentAge : clone.plan.client.currentAge;
  if (ownerCurrentAge == null) return; // no such owner on this household (e.g. shock targets a partner on a single)

  const schedule = buildSchedules(clone);
  const gapStartYear = resolveRef({ kind: "age", age: atAge }, clone.plan, schedule, owner).planYear;
  const years = Math.max(1, Math.round((months ?? 0) / 12));
  const gapEndYear = gapStartYear + years - 1;
  const scale = Math.max(0, replacementPct ?? 0) / 100;
  const ageOf = (y) => ownerCurrentAge + y;

  // Scoped to the owner's own SALARY-category rows — the same category
  // this model treats as PAYG-withheld employment income (planState.js's
  // incomeCategoryTaxTreatment) — matching the spec's own examples
  // (parental leave, illness, a career break, project-based employment:
  // all interruptions to ongoing PAYG salary, not to rental/interest/
  // other income types, which keep flowing regardless).
  const next = [];
  for (const r of clone.cashflows.income ?? []) {
    if (r.owner !== owner || r.category !== "salary") { next.push(r); continue; }
    const fromYear = resolveRef(r.from, clone.plan, schedule, owner).planYear;
    const toYear = resolveRef(r.to, clone.plan, schedule, owner).planYear;
    const overlapStart = Math.max(fromYear, gapStartYear);
    const overlapEnd = Math.min(toYear, gapEndYear);
    if (overlapStart > overlapEnd) { next.push(r); continue; } // this row's own window never touches the gap at all

    if (fromYear < overlapStart) next.push({ ...r, to: { kind: "age", age: ageOf(overlapStart - 1) } });
    next.push({
      ...r, id: `${r.id}__gap`,
      from: { kind: "age", age: ageOf(overlapStart) }, to: { kind: "age", age: ageOf(overlapEnd) },
      amount: (r.amount ?? 0) * scale,
    });
    if (toYear > overlapEnd) next.push({ ...r, id: `${r.id}__after`, from: { kind: "age", age: ageOf(overlapEnd + 1) } });
  }
  clone.cashflows.income = next;
}

// Expense shock ({kind: "expenseShock", pct}) — every household expense
// row runs at `pct`% above (or below, negative pct) plan, for the
// WHOLE projection. Scaling the row's own `amount` (rather than the
// engine's per-month indexed figure) is what makes an indexed row
// scale too: indexation is a multiplicative factor layered on TOP of
// `amount` at each point in time, so scaling the base amount scales
// the entire indexed trajectory proportionally, with no separate
// indexed-vs-flat handling needed. Scoped to state.cashflows.expenses
// specifically — the household "living expenses" input section the
// spec's own framing ("what if we just spend a bit more than we say we
// will?") is about — not property expenses, loan repayments, super
// contributions, or tax, each already its own distinct line item.
function applyExpenseShock(clone, shock) {
  const scale = 1 + (shock.pct ?? 0) / 100;
  for (const r of clone.cashflows.expenses ?? []) r.amount = (r.amount ?? 0) * scale;
}

registerShockKind("incomeGap", applyIncomeGap);
registerShockKind("expenseShock", applyExpenseShock);
