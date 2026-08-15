// Focus: Deposit & home purchase (docs/specs/12-focus-views.md, Commit 2)
// — pure, no DOM/Plotly. Every figure here is read straight off a real
// projectPlan() output (or a solver run over one) — never re-derived
// independently. See the header of each exported function for exactly
// which engine fields it reads.
import { resolveRef } from "./keyDates.js";
import { applyVary, MAX_ITERATIONS } from "./solve.js";
import { projectPlan } from "./deterministic.js";
import { clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";

// The properties this view can possibly answer for — a planned
// purchase with a resolvable date. (An "owned" property has no
// settlement event to analyse; this view is about the purchase itself.)
export function eligibleDepositProperties(state) {
  return (state.properties ?? []).filter((p) => p.status === "planned");
}

// Did property `propertyId`'s purchase actually fire in this row? The
// engine's own record (Commit 2 follow-on fields), not a re-derivation
// of the purchase-date logic — deposit/duty/costs/fhog are all zero
// simultaneously only when nothing settled that year (see
// deterministic.js's own field-header comment for why this is safe:
// a genuine purchase always has a nonzero deposit or costs component).
function purchaseFiredIn(row, propertyId) {
  const d = row?.properties?.[propertyId];
  return !!d && (d.deposit !== 0 || d.duty !== 0 || d.costs !== 0 || d.fhog !== 0);
}

function findPurchaseYear(out, propertyId) {
  return out.yearly.findIndex((row) => purchaseFiredIn(row, propertyId));
}

// Spare cash at settlement = funds available heading into the purchase
// month (the year's OPENING position: financial assets + WCA) minus
// the engine's own net settlement figure. DISPLAY ONLY (buildDepositFocus's
// "spare" figure) — deliberately NOT what either solver below optimises
// for. It only ever looks at the settlement transaction in isolation; a
// property purchase also draws down a NEW loan whose FIRST YEAR of
// repayments falls inside the SAME plan year, and a household with
// enough for the deposit but not enough surplus to service that year's
// interest and principal is not actually funded — the engine's own
// unfundedCashflow catches that, this arithmetic doesn't. FHSSS release
// cancels out of this identity exactly (it's already netted into
// `settlement` on the engine side and would double-count if also added
// to "available" — see buildDepositFocus's own accumulating-series
// comment for where it IS shown, for display, without affecting this
// arithmetic).
function spareCashAt(out, y, propertyId) {
  if (y === -1) return -Number.MAX_SAFE_INTEGER;
  const row = out.yearly[y];
  const detail = row.properties[propertyId];
  const available = row.openingBalance + row.wcaDetail.opening;
  return available - detail.settlement;
}

// Cumulative unfundedCashflow through year `y` inclusive — the engine's
// own ground truth: it's already the result of running the real monthly
// funding cascade, so it naturally accounts for everything a plain
// "opening minus required" subtraction can't see (CGT timing, other
// cash needs the same year, all of it). Used two ways below:
//   - scoped to the PURCHASE year: "can the deposit itself be raised"
//     (settlement affordability) — this alone is NOT what "funded"
//     means; see cumulativeUnfundedWhole's own header.
//   - scoped to the WHOLE projection (cumulativeUnfundedWhole): "does
//     the plan work after the purchase too" (servicing affordability).
function cumulativeUnfundedThroughYear(out, y) {
  if (y === -1) return Number.MAX_SAFE_INTEGER;
  let total = 0;
  for (let k = 0; k <= y; k++) total += out.yearly[k].unfundedCashflow ?? 0;
  return total;
}

// The metric both solvers actually optimise for, and the one
// buildDepositFocus's own "onTrack" uses. A purchase-year-scoped sum
// (the previous version of this fix) catches a new loan's OWN
// first-year repayments — that closed the original "deposit funded but
// the mortgage isn't" bug — but it's still blind to a loan that's
// serviceable in year one and unaffordable in year three: unfunded
// cashflow that only bites AFTER settlement never enters a sum scoped
// to the purchase year. "Funded" has to mean the plan works for the
// rest of the projection too, not just at the moment of settlement —
// summing through the LAST year, not the purchase year, is what makes
// that true rather than assumed.
function cumulativeUnfundedWhole(out) {
  return cumulativeUnfundedThroughYear(out, out.yearly.length - 1);
}
const FUNDED_TOLERANCE = 0.5; // matches buildDepositFocus's own onTrack threshold

// findMinimumFunded — binary search for the SMALLEST x in [lo, hi] at
// which `unfundedAt(x)` (cumulative unfundedCashflow — monotonically
// NON-INCREASING in x, is the working assumption: more savings, or a
// later purchase date, should only reduce or leave unchanged how
// unfunded the plan is) first drops to (or below) `tolerance`.
//
// This is deliberately NOT solve.js's bisectScalar/solveFor: those
// solve f(x) = target for a smoothly invertible f (Commit 1's own
// tests use "closing balance as a function of contribution", which
// never plateaus). unfundedCashflow floors at exactly zero and STAYS
// there for every x beyond the funding point — a genuine plateau, not
// a single root — so "solve f(x) = 0" would converge on an arbitrary
// point in that plateau (typically the search's own upper bound)
// rather than the minimum the spec's two solver actions actually ask
// for ("what would I need to save" / "when could I buy" both want the
// EARLIEST/SMALLEST sufficient answer, not just A sufficient one).
// This is the same "leftmost true in a monotonic predicate" shape
// solveWhenCouldIBuy already uses for its discrete integer-age search;
// this is its continuous-domain sibling, shared by both solvers below.
function findMinimumFunded({ lo, hi, unfundedAt, tolerance = FUNDED_TOLERANCE, maxIterations = MAX_ITERATIONS }) {
  let iterations = 0;
  const atLo = unfundedAt(lo);
  iterations++;
  if (atLo <= tolerance) return { value: lo, achieved: true, iterations, converged: true, reason: "converged" };
  const atHi = unfundedAt(hi);
  iterations++;
  if (atHi > tolerance) {
    // Not fundable anywhere in the searched range — the honest answer,
    // not a plausible-looking guess.
    return { value: null, achieved: false, iterations, converged: false, reason: "out-of-bounds" };
  }
  let a = lo, b = hi;
  // Width threshold: a cent for dollar amounts, or effectively "done"
  // for anything coarser (e.g. the discrete callers round anyway).
  while (b - a > 0.01 && iterations < maxIterations) {
    const mid = (a + b) / 2;
    if (unfundedAt(mid) <= tolerance) b = mid; else a = mid;
    iterations++;
  }
  if (b - a > 0.01) {
    return { value: null, achieved: false, iterations, converged: false, reason: "iteration-cap" };
  }
  // Spot-check the boundary really is a boundary — the same "did the
  // assumed direction actually hold" discipline bisectScalar applies
  // to a continuous equation search, adapted to a threshold predicate.
  const unfundedAtA = unfundedAt(a);
  iterations++;
  const unfundedAtB = unfundedAt(b);
  iterations++;
  if (unfundedAtA <= tolerance || unfundedAtB > tolerance) {
    return { value: null, achieved: false, iterations, converged: false, reason: "non-monotonic" };
  }
  return { value: b, achieved: true, iterations, converged: true, reason: "converged" };
}

// Both solver actions share this shape: search the PRIMARY (whole-of-
// projection) affordability metric first; if nothing in [lo, hi]
// achieves it, a purchase genuinely isn't reachable this way — but
// "isn't reachable" splits into two answers that call for opposite
// advice, so a second pass against the narrower SETTLEMENT-only metric
// (the old, purchase-year-scoped test) tells them apart:
//   - "settlement-unaffordable" — the deposit/settlement cash itself is
//     never raised anywhere in range. Advice: save more, or wait
//     longer before buying at all.
//   - "servicing-unaffordable" — settlement clears somewhere in range,
//     but the resulting loan can't be serviced for the rest of the
//     projection. Advice: this property isn't affordable regardless of
//     timing — the fix isn't a later date, it's a smaller loan (lower
//     price, higher deposit, lower LVR).
// `earliestSettleable` carries the settlement-only answer as CONTEXT
// when the reason is servicing-unaffordable — clearly a different
// question from the one just asked, never presented as the answer
// itself (see main.js's own rendering for how it's labelled).
function solveWithAffordabilitySplit({ lo, hi, wholeUnfundedAt, settlementUnfundedAt, roundUp = false }) {
  const primary = findMinimumFunded({ lo, hi, unfundedAt: wholeUnfundedAt });
  if (primary.converged) {
    return { ...primary, value: roundUp ? Math.ceil(primary.value) : primary.value, earliestSettleable: null };
  }
  // Only "out-of-bounds" (nothing in range clears the bar) is refined
  // into the two named reasons — "non-monotonic"/"iteration-cap" are
  // search-mechanics safety nets, not a real affordability verdict, so
  // they pass through unchanged rather than being mislabelled as one.
  if (primary.reason !== "out-of-bounds") {
    return { ...primary, earliestSettleable: null };
  }
  const settlement = findMinimumFunded({ lo, hi, unfundedAt: settlementUnfundedAt });
  const iterations = primary.iterations + settlement.iterations;
  if (!settlement.converged) {
    return { value: null, achieved: false, iterations, converged: false, reason: "settlement-unaffordable", earliestSettleable: null };
  }
  return {
    value: null, achieved: false, iterations, converged: false, reason: "servicing-unaffordable",
    earliestSettleable: { value: roundUp ? Math.ceil(settlement.value) : settlement.value },
  };
}

// buildDepositFocus({ out, state, propertyId }) → the view's data, or
// null if this property can't be answered for yet (not planned, or its
// purchase date never falls inside the projection — the caller should
// fall back to the empty state).
export function buildDepositFocus({ out, state, propertyId }) {
  const property = (state.properties ?? []).find((p) => p.id === propertyId);
  if (!property || property.status !== "planned") return null;
  const ref = resolveRef(property.purchaseAt, state.plan, out.schedule, "client");
  const y = ref.planYear;
  const row = out.yearly[y];
  if (!purchaseFiredIn(row, propertyId)) return null;
  const detail = row.properties[propertyId];

  // --- Target: the moving price, made explicit -----------------------
  // realPrice isn't its own field (see deterministic.js's field-header
  // comment) — costBaseSeed − duty − costs recovers it exactly, since
  // costBaseSeed is defined as realPrice + duty + costs at the same
  // settlement event.
  const projectedPriceReal = detail.costBaseSeed - detail.duty - detail.costs;
  const target = {
    priceToday: property.priceToday,
    growthPct: property.growthPct,
    purchaseYear: y,
    purchaseAge: ref.age,
    fyLabel: ref.fyLabel,
    projectedPriceReal,
  };

  // --- Required at settlement: the spec's OWN definition excludes the
  // FHSSS release (that's shown as a funding SOURCE below instead), so
  // it's the engine's settlement figure with the release added back —
  // simple arithmetic over two already-reported fields, not a fresh
  // calculation. lmiCapitalised is read from the plan input directly
  // (a flag, not a derived figure) to decide whether `lmi` belongs in
  // this total or was financed inside the loan drawdown instead.
  const lmiInCash = property.lmiPayAtSettlement === true;
  const required = {
    deposit: detail.deposit,
    duty: detail.duty,
    costs: detail.costs,
    fhog: detail.fhog,
    lmi: detail.lmi,
    lmiInCash,
    firstHomeGuarantee: property.firstHomeGuarantee === true,
    total: detail.deposit + detail.duty + detail.costs - detail.fhog + (lmiInCash ? detail.lmi : 0),
  };

  // --- Accumulating: opening financial-asset + WCA position for every
  // year up to and including the purchase year — a consistent "funds
  // heading into this year" basis throughout, so the LAST point is
  // exactly "funds available for the purchase" and the whole series is
  // comparable year to year. The FHSSS release is a lump sum that
  // arrives AT settlement, not something that accrues beforehand, so
  // it's reported alongside the last point rather than smeared across
  // the series.
  const accumulating = [];
  for (let k = 0; k <= y; k++) {
    const r = out.yearly[k];
    accumulating.push({
      year: k,
      age: out.schedule.clientAges[k],
      fyLabel: out.schedule.fyLabels[k],
      availableReal: r.openingBalance + r.wcaDetail.opening,
    });
  }
  const fhsssReleaseAtPurchase = detail.fhsssRelease;

  // --- The answer: on-track determination matches the engine's OWN
  // unfunded flag, not a separate arithmetic threshold — the arithmetic
  // ("spare"/"shortfall $" below) is for DISPLAY only. "On track" needs
  // BOTH halves to hold: the deposit is actually raised (settlement,
  // scoped to the purchase year) AND the resulting loan can be serviced
  // for the rest of the projection (servicing, scoped to the WHOLE
  // projection) — a property that settles but is never serviceable is
  // not "on track with a date problem", it's not affordable, full stop.
  const settlementUnfunded = cumulativeUnfundedThroughYear(out, y);
  const wholeUnfunded = cumulativeUnfundedWhole(out);
  const settlementOk = settlementUnfunded <= FUNDED_TOLERANCE;
  const servicingOk = wholeUnfunded <= FUNDED_TOLERANCE;
  const spare = spareCashAt(out, y, propertyId) + fhsssReleaseAtPurchase;
  let answer;
  if (settlementOk && servicingOk) {
    answer = { onTrack: true, spare };
  } else if (!settlementOk) {
    answer = { onTrack: false, reason: "settlement-unaffordable", shortfall: settlementUnfunded };
  } else {
    // Settles fine on its own; wholeUnfunded − settlementUnfunded is
    // exactly the unfunded cashflow accrued AFTER the purchase year —
    // the ongoing repayment burden the settlement-only view can't see.
    answer = { onTrack: false, reason: "servicing-unaffordable", shortfall: wholeUnfunded - settlementUnfunded };
  }

  return { property: { id: property.id, name: property.name }, target, required, accumulating, fhsssReleaseAtPurchase, answer };
}

// solveDepositContribution — "What would I need to save?" Solves the
// SMALLEST monthly contribution (into `assetId`, an existing financial
// asset) that leaves the plan affordable for the WHOLE projection, not
// just funded at settlement — built on findMinimumFunded via
// solveWithAffordabilitySplit (above); see that function's own header
// for why an equation solver is the wrong tool, and why a
// purchase-year-scoped test isn't enough on its own: a contribution
// that stops before settlement can fund the deposit while doing nothing
// for the mortgage repayments due AFTER it. Builds its OWN draft state
// with a temporary contribution row rather than requiring one to
// already exist in the plan.
//
// The contribution runs from `fromAge` up to (but not including) the
// purchase age itself, deliberately — the purchase fires in JULY, month
// 0 of its own plan year, so any contribution dated INTO that same year
// hasn't arrived yet when settlement needs it. Ending the contribution
// the year before is what makes every contributed dollar actually count
// toward the balance settlement draws on.
export function solveDepositContribution({ state, propertyId, assetId, fromAge }) {
  const property = (state.properties ?? []).find((p) => p.id === propertyId);
  // One extra projectPlan run purely to get a schedule to resolve the
  // purchase date against (cheap — sub-millisecond, per the spec's own
  // framing of why a goal-seek solver is viable at all).
  const ref = resolveRef(property.purchaseAt, state.plan, projectPlan(state).schedule, "client");
  const owner = (state.assets ?? []).find((a) => a.id === assetId)?.owner ?? "client";
  const toAge = Math.max(fromAge, ref.age - 1);

  const trialOut = (amount) => {
    const clone = structuredClone(state);
    clone.cashflows.contributions = [
      ...(clone.cashflows.contributions ?? []),
      {
        id: "__focus-deposit-solve__", assetId, amount, frequency: "monthly",
        from: { kind: "age", age: fromAge }, to: { kind: "age", age: toAge },
        indexed: false, owner, label: "Deposit savings (Focus solver draft)",
      },
    ];
    const validated = clampAllToPlan(clone, PROFILES);
    return projectPlan(validated);
  };

  // A generous cap: $20,000/month. If the true answer needs more than
  // this, the plan genuinely can't get there this way and
  // findMinimumFunded correctly reports non-convergence rather than a
  // number nobody could actually save.
  return solveWithAffordabilitySplit({
    lo: 0, hi: 20000,
    wholeUnfundedAt: (amount) => cumulativeUnfundedWhole(trialOut(amount)),
    settlementUnfundedAt: (amount) => {
      const out = trialOut(amount);
      return cumulativeUnfundedThroughYear(out, findPurchaseYear(out, propertyId));
    },
  });
}

// solveWhenCouldIBuy — "When could I buy?" Solves the earliest purchase
// AGE at which the plan is affordable for the WHOLE projection —
// settling AND servicing the resulting loan for the rest of the plan,
// not just clearing settlement — accounting for the price still growing
// while the client saves — the genuine fixed point the spec calls out:
// moving the date later both grows the price (worse) and grows
// accumulated savings (better), so "later is better" is a real
// assumption, checked (not just hoped for) by findMinimumFunded, not
// just assumed. See solveWithAffordabilitySplit's own header for why a
// purchase-year-scoped test alone isn't enough: it can return a date
// that settles cleanly and then runs the household into unfunded
// cashflow for years afterward once the mortgage bites.
//
// A purchase age only ever resolves to a WHOLE plan year — every trial
// is re-clamped through clampAllToPlan, which rounds a fractional age
// to the nearest integer before projectPlan ever sees it — so
// findMinimumFunded's own fractional crossing point (somewhere within
// a single-year "step") is rounded UP here before returning, not to
// nearest: the point is the earliest FUNDED age, and rounding down
// could land back on the unfunded side of the step. Callers can apply
// the returned `value` directly — it's already a whole age. The same
// rounding applies to `earliestSettleable.value` when present.
export function solveWhenCouldIBuy({ state, propertyId }) {
  const property = (state.properties ?? []).find((p) => p.id === propertyId);
  const lo = state.plan.client.currentAge;
  const hi = state.plan.endAge;
  if (!property || !(hi > lo)) {
    return { value: null, achieved: false, iterations: 0, converged: false, reason: "out-of-bounds", earliestSettleable: null };
  }

  const trialOut = (age) => {
    const clone = structuredClone(state);
    applyVary(clone, { kind: "propertyPurchaseDate", id: propertyId }, age);
    const validated = clampAllToPlan(clone, PROFILES);
    return projectPlan(validated);
  };

  return solveWithAffordabilitySplit({
    lo, hi, roundUp: true,
    wholeUnfundedAt: (age) => cumulativeUnfundedWhole(trialOut(age)),
    settlementUnfundedAt: (age) => {
      const out = trialOut(age);
      return cumulativeUnfundedThroughYear(out, findPurchaseYear(out, propertyId));
    },
  });
}
