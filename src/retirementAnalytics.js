// Retirement analytics (docs/specs/32-retirement-phase-one.md, Commit 3)
// — pure, no DOM/Plotly. Five to seven numbers that answer what the
// client actually asked; we compute every one and surface none as a
// headline (the spec's own instruction — this module has no opinion on
// which figure a UI leads with).
//
// Every figure is derived from an ALREADY-RUN projectPlan() result —
// never re-derives a number the engine already produces (the Focus
// views' own governing principle, spec 12) — except "Sustainable income
// to LE", which genuinely needs new trial projections (a hypothetical
// spend level nobody has entered) and so reuses solve.js's existing
// solving machinery, via a new "syntheticExpense" vary kind (solve.js)
// that appends a household expense row to a cloned state rather than
// editing one.
//
// That reuse is findMinimumThreshold, not bisectScalar/solveFor,
// despite the spec's own "uses the existing solveFor machinery"
// wording — both are "the existing machinery" in solve.js, and only
// one of them fits this shape. Net assets at the LE year is NOT a
// clean root of "spend amount": once spend exceeds what the household
// can fund, the excess goes unfunded (assets floor at 0, per this
// engine's own convention — see CLAUDE.md) and net assets at LE
// PLATEAUS above zero rather than continuing to fall — verified
// empirically while building this (a $1.5m household's own net assets
// at LE floored at ~$35k, not $0, once spending overshot). Targeting
// net-assets-equals-zero via bisectScalar is therefore chasing an
// UNREACHABLE root — solve.js's own findMinimumThreshold header names
// exactly this shape ("cumulative unfunded cashflow floors at exactly
// zero and STAYS there... a genuine plateau, not a single root").
// Sustainable income is instead the boundary of "does a shortfall
// occur at or before LE" — a clean plateau predicate, found as the
// SMALLEST spend that first triggers one, minus a $1 safety margin
// (findMinimumThreshold's own convergence width is $0.01; $1 is a
// comfortable margin above that, negligible against any real income
// figure) so the reported figure is confirmed on the SAFE side, not
// sitting exactly on the boundary that fails.

import { resolveRef } from "./keyDates.js";
import { resolveEndBasis, clampAllToPlan } from "./planState.js";
import { applyVary, findMinimumThreshold } from "./solve.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";
import { superRatesFor } from "./data/superRates.js";
import { agePensionRatesFor } from "./data/agePension.js";
import { div293Tax } from "./Tax/superContributions.js";
import { firstFyStartYear } from "./schedule.js";

// The Retirement key date and the LE anchor (at a given offset, 0 or 5)
// both resolve to a plan year the same way — { planYear, age, fyLabel,
// outOfRange }. The LE anchor reuses resolveEndBasis's OWN "le" basis
// calculation (the same one endBasis:{mode:"le"} uses for the
// projection's own end) as a REPORTING anchor, independent of whatever
// endBasis this particular plan actually uses to end its projection —
// a plan ending at a fixed age still wants "capital at LE" reported
// against the client's actual life expectancy. `anchor` names which
// person's LE drove the offset (informational only: resolveEndBasis's
// own returned age is always expressed as an addition to the CLIENT's
// current age regardless of anchor, so no partner-specific resolution
// is needed here).
function leAnchor(plan, schedule, offsetYears) {
  const { endAge, anchor } = resolveEndBasis({ mode: "le", offset: offsetYears }, plan.client, plan.partner);
  const resolved = resolveRef({ kind: "age", age: endAge }, plan, schedule, "client");
  return { ...resolved, anchor };
}

function retirementAnchor(plan, schedule) {
  return resolveRef({ kind: "anchor", anchorId: "retirement-client" }, plan, schedule, "client");
}

// First shortfall age — the existing unfunded-cashflow measure,
// HOUSEHOLD-WIDE by construction (result.shortfall already spans every
// funding source, not just super/pension) — unlike Midwinter's own
// "Age ABP Runs Out", which is super-only and so cannot see a shortfall
// that arises from, say, a fully-drawn financial asset with super
// still intact. Stated as a difference, not silently presented as if
// it were the same measure.
function firstShortfallAge(result) {
  return result.shortfall?.clientAge ?? null;
}

// Super/pension exhaustion age — Midwinter's own headline figure,
// reported here SEPARATELY from the household-wide shortfall above
// (the two can differ materially: super could exhaust while other
// assets carry the household, or vice versa). The first plan year the
// combined super+pension balance drops to (near) zero AFTER having
// been genuinely positive at some point — null when there was never
// anything to exhaust, or when it's still positive at the end of the
// projection (never exhausts within this horizon).
export function superPensionExhaustionAge(yearly, clientAges) {
  let everPositive = false;
  for (let y = 0; y < yearly.length; y++) {
    const combined = (yearly[y].superClosing ?? 0) + (yearly[y].pensionClosing ?? 0);
    if (combined > 1e-6) { everPositive = true; continue; }
    if (everPositive) return clientAges[y];
  }
  return null;
}

// Mean of `selector(row)` over plan years [fromYear, toYear] inclusive,
// clamped into the projection's own bounds. `null` when the window is
// empty (e.g. an out-of-range LE anchor clamped below the retirement
// year — a degenerate plan, not silently averaged over nothing).
export function meanOverWindow(yearly, fromYear, toYear, selector) {
  const from = Math.max(0, Math.min(fromYear, toYear));
  const to = Math.min(yearly.length - 1, Math.max(fromYear, toYear));
  if (to < from) return null;
  let sum = 0, n = 0;
  for (let y = from; y <= to; y++) { sum += selector(yearly[y]); n++; }
  return n > 0 ? sum / n : null;
}

// Household age pension paid this row — both persons summed (a single
// household has only "client"; a couple has both). agePensionDetail is
// always present (spec 21a's own convention), so this never throws on
// a plan with no age pension entitlement at all — it just sums to 0.
// Exported — goalVsPosition.js's own age-pension bucket reuses this
// exact figure rather than re-deriving it.
export function agePensionPaid(row) {
  const d = row.agePensionDetail;
  return (d?.client?.paid ?? 0) + (d?.partner?.paid ?? 0);
}

// Total household CASH income received this row, including every
// account-based pension's own payment. row.income (deterministic.js's
// own accumulator) deliberately excludes these — an account-based
// pension payment to someone past preservation age is non-assessable
// non-exempt income, correctly left out of the TAX-relevant "income"
// figure it otherwise tracks — but "average retirement income" is a
// CASH concept, not a tax concept, and a pension is typically the
// LARGEST single cash inflow in retirement. Bug found while building
// spec 33 Commit 2 (the standalone retirement page): its goal-versus-
// position chart (spec 32 Commit 5a's own goalVsPosition.js, which
// already folds pension payments in via its own pensionDrawdown
// bucket) and this module's own "Average retirement income to LE"
// figure disagreed on the SAME household by roughly the pension
// payment itself, every single year post-retirement — an internal
// contradiction on one page, not a hypothetical. Exported so
// goalVsPosition.js/main.js could reuse it too, though neither
// currently needs to (goalVsPosition.js already computes its own
// equivalent total from its five named buckets).
export function householdCashIncome(row) {
  let pensionPayments = 0;
  for (const id of Object.keys(row.pensionDetail ?? {})) pensionPayments += row.pensionDetail[id]?.payments ?? 0;
  return (row.income ?? 0) + pensionPayments;
}

// A single trial: clone `state`, add the synthetic retirement-to-LE
// expense at `x`, re-clamp (the same "never hand a mutated object
// straight to the engine" discipline solveFor's own evaluate() uses),
// and report whether a shortfall occurs AT OR BEFORE the LE plan year.
function hasShortfallByLE(state, from, to, lePlanYear, x) {
  const clone = structuredClone(state);
  applyVary(clone, { kind: "syntheticExpense", from, to }, x);
  const validated = clampAllToPlan(clone, PROFILES);
  const out = projectPlan(validated);
  return out.shortfall != null && out.shortfall.planYear <= lePlanYear;
}

// Sustainable income to LE — "what could be drawn and last to the LE
// anchor" (the spec's own words). See this module's own header for why
// this is findMinimumThreshold over "does a shortfall occur by LE",
// not bisectScalar/solveFor over net assets (which plateaus above
// zero rather than reaching it, an unreachable root). `null` when the
// household can't sustain even the search's own lower bound.
function sustainableIncomeToLE(state, retirementRef, leRef, capitalAtRetirement) {
  if (leRef.planYear <= retirementRef.planYear) return { value: null, converged: false };
  const years = leRef.planYear - retirementRef.planYear;
  // Upper bound: capital spread over a QUARTER of the retirement-to-LE
  // window, comfortably above any genuinely sustainable figure for a
  // portfolio of this size — the search only needs to bracket the real
  // boundary, not pin it exactly.
  const hi = Math.max(10000, (Math.max(0, capitalAtRetirement) / years) * 4);
  const from = { kind: "age", age: retirementRef.age };
  const to = { kind: "age", age: leRef.age };
  // metric: 1 while safe, drops to 0 once a shortfall first occurs by
  // LE — monotonically NON-INCREASING in spend, exactly the shape
  // findMinimumThreshold is built for. threshold 0 + tolerance <1 means
  // only the "just turned unsafe" value clears; anything still safe (1)
  // never does.
  const search = findMinimumThreshold({
    lo: 0, hi,
    metric: (x) => (hasShortfallByLE(state, from, to, leRef.planYear, x) ? 0 : 1),
    threshold: 0,
    tolerance: 0.5,
  });
  if (!search.converged || search.value == null) return { value: null, converged: false };
  // search.value is the SMALLEST spend that first fails — subtract a
  // $1 margin (its own convergence width is $0.01) so the reported
  // figure is confirmed on the safe side, not sitting exactly on the
  // boundary that fails.
  return { value: Math.max(0, search.value - 1), converged: true };
}

// "Where the two differ materially, that difference is itself worth
// showing" — a plain relative-difference check against a deliberately
// loose 10% bar (a disclosure trigger, not a precision claim). `null`
// on either side means "not comparable", never treated as a difference.
export function isMaterialLEDifference(le, lePlus5, thresholdPct = 10) {
  if (le == null || lePlus5 == null || le <= 0) return false;
  return (Math.abs(le - lePlus5) / le) * 100 > thresholdPct;
}

// computeRetirementAnalytics(state, result) → the summary figures.
// `state` is the SAME plan state `result` was produced from
// (projectPlan(state, profiles)) — needed only for the sustainable-
// income solve, which must run its own trial projections.
export function computeRetirementAnalytics(state, result) {
  const plan = state.plan;
  const schedule = result.schedule;
  const yearly = result.yearly;

  const retirementRef = retirementAnchor(plan, schedule);
  const capitalAtRetirement = yearly[retirementRef.planYear]?.netAssets ?? null;

  const windowFigures = (leRef) => {
    const averageRetirementIncome = meanOverWindow(yearly, retirementRef.planYear, leRef.planYear, (r) => householdCashIncome(r) - r.tax);
    const averageAgePension = meanOverWindow(yearly, retirementRef.planYear, leRef.planYear, agePensionPaid);
    const averageGrossIncome = meanOverWindow(yearly, retirementRef.planYear, leRef.planYear, householdCashIncome);
    const averageAgePensionPctOfIncome = averageAgePension != null && averageGrossIncome
      ? (averageAgePension / averageGrossIncome) * 100
      : null;
    const sustainable = sustainableIncomeToLE(state, retirementRef, leRef, capitalAtRetirement ?? 0);
    return {
      planYear: leRef.planYear, age: leRef.age, fyLabel: leRef.fyLabel, outOfRange: leRef.outOfRange, anchor: leRef.anchor,
      capitalAtLE: yearly[leRef.planYear]?.netAssets ?? null,
      averageRetirementIncome, averageAgePension, averageAgePensionPctOfIncome,
      sustainableIncomeToLE: sustainable.value, sustainableIncomeConverged: sustainable.converged,
    };
  };

  const le = windowFigures(leAnchor(plan, schedule, 0));
  const lePlus5 = windowFigures(leAnchor(plan, schedule, 5));

  // "Where the two differ materially, that difference is itself worth
  // showing" — checked on the figure most directly comparable between
  // the two windows (sustainable income), rather than a bespoke
  // threshold per figure.
  const materialLEDifference = isMaterialLEDifference(le.sustainableIncomeToLE, lePlus5.sustainableIncomeToLE);

  return {
    retirement: { planYear: retirementRef.planYear, age: retirementRef.age, fyLabel: retirementRef.fyLabel },
    firstShortfallAge: firstShortfallAge(result),
    superPensionExhaustionAge: superPensionExhaustionAge(yearly, schedule.clientAges),
    capitalAtRetirement,
    le, lePlus5,
    materialLEDifference,
    // Retirement exclusions (docs/specs/35-retirement-output-view.md,
    // Commit 3) — "the analytics card carries a line when anything is
    // excluded" (the spec's own words). TODAY's total (year 0's own
    // close), the same figure the year table's own excluded band starts
    // from — a straight read of the engine's own already-computed sum,
    // never re-derived.
    excludedFromRetirementBalance: yearly[0]?.excludedFromRetirementBalance ?? 0,
  };
}

// --- Per-person derived figures (docs/specs/34-retirement-intelligent.md,
// Commit 1; relocated from retirementStandalone.js by docs/specs/35-
// retirement-output-view.md, Commit 1 — spec 33's standalone page is
// withdrawn, but these are generic per-person derivations off ANY
// state/projection, not standalone-page-specific, so they survive and
// move here alongside computeRetirementAnalytics rather than being
// deleted with the rest of that module). Pure, no DOM/Plotly.

// Super Guarantee for `owner`, resolved for TODAY's FY (year 0) — via
// the SAME formula schedule.js's own SG crediting uses
// (Math.min(salary, sgMaximumSalary) * sgRate).
export function sgFor(state, salary) {
  const a = state.assumptions;
  const f0 = firstFyStartYear(state.plan.start);
  // Threshold indexation toggle (docs/specs/35-retirement-output-view.md,
  // Commit 4) — sgMaximumSalary is derived from the concessional cap, an
  // indexed SUPER threshold, so this reads indexSuperThresholds, not
  // bracketMode (see deterministic.js's own header on the split).
  const mode = a.indexSuperThresholds === false ? "frozen" : "indexed";
  const rates = superRatesFor(f0, mode, a.cpi, a.awote ?? 0.032);
  const isCapped = salary > rates.sgMaximumSalary;
  const base = Math.min(salary, rates.sgMaximumSalary);
  return { amount: base * rates.sgRate, ratePct: rates.sgRate * 100, base, sgMaximumSalary: rates.sgMaximumSalary, isCapped, salary };
}

// The calendar year `owner` reaches `age`, resolved the SAME way every
// other age-to-year figure in this app is (resolveRef's own
// {kind:"age"} resolution — ages tick each 1 July, CLAUDE.md's own
// locked convention — not a naive dob-year-plus-age approximation).
// `year: null` when the age falls beyond the projection window.
export function ageYear(state, owner, age, schedule) {
  const resolved = resolveRef({ kind: "age", age }, state.plan, schedule, owner);
  const f0 = firstFyStartYear(state.plan.start);
  return { age, year: resolved.outOfRange ? null : f0 + resolved.planYear, outOfRange: resolved.outOfRange };
}

// Preservation age (a flat constant for the only cohort this tool
// models — superRatesFor's own preservationAge) resolved to a year for
// `owner`.
export function preservationAgeFor(state, owner, schedule) {
  const f0 = firstFyStartYear(state.plan.start);
  const rates = superRatesFor(f0);
  return ageYear(state, owner, rates.preservationAge, schedule);
}

// Age pension age (agePensionRatesFor's own ageOfEligibility), same
// shape as preservationAgeFor.
export function agePensionAgeFor(state, owner, schedule) {
  const f0 = firstFyStartYear(state.plan.start);
  const rates = agePensionRatesFor(f0);
  return ageYear(state, owner, rates.ageOfEligibility, schedule);
}

// Concessional cap headroom for `owner`, TODAY's FY (year 0) — reads
// the SAME projection.yearly[0].superCapUsage[owner] the comprehensive
// Super section's own superCapHeadroomHTML reads, so this can never
// disagree with that figure. `null` when no super account/projection
// exists yet for this owner.
export function capHeadroomFor(projection, owner) {
  return projection.yearly?.[0]?.superCapUsage?.[owner] ?? null;
}

// Division 293 — the FIRST plan year `owner`'s reconstructed Division
// 293 tax is actually positive. Reconstructed via the SAME pure
// div293Tax the engine itself calls (Tax/superContributions.js) — never
// a duplicated rule — fed from what's ALREADY exposed per year
// (row.superCapUsage for this person's own SG/salary-sacrifice/cap-and-
// carry-forward position, row.taxDetail[owner].taxableIncome).
// Deliberately NOT row.taxDetail[owner].div293 — that field reports the
// PRIOR year's tax, paid this July (deterministic.js's own CGT-style
// payment-timing convention), which would name the wrong (later) year
// as "when it first bites". `null` when it never bites within the
// projection.
export function firstDiv293Year(state, projection, owner) {
  const a = state.assumptions;
  const f0 = firstFyStartYear(state.plan.start);
  // Threshold indexation toggle (docs/specs/35-retirement-output-view.md,
  // Commit 4) — same super-threshold toggle as sgFor's own, for
  // consistency, though it has no visible effect on the two fields read
  // below (div293Threshold/div293Rate are never indexed under EITHER
  // mode — superRates.js's own header explains why).
  const mode = a.indexSuperThresholds === false ? "frozen" : "indexed";
  const ages = owner === "partner" ? projection.schedule.partnerAges : projection.schedule.clientAges;
  for (let y = 0; y < projection.yearly.length; y++) {
    const row = projection.yearly[y];
    const usage = row.superCapUsage?.[owner];
    const taxDetail = row.taxDetail?.[owner];
    if (!usage || !taxDetail) continue;
    const rates = superRatesFor(f0 + y, mode, a.cpi, a.awote ?? 0.032);
    const reportableSuperContributions = usage.sg + usage.salarySacrifice + usage.personalDeductible;
    const lowTaxContributions = Math.min(reportableSuperContributions, usage.cap + usage.carryForwardAvailable);
    const { tax } = div293Tax({
      taxableIncome: taxDetail.taxableIncome,
      reportableSuperContributions, lowTaxContributions, reportableFringeBenefits: 0,
      threshold: rates.div293Threshold, rate: rates.div293Rate,
    });
    if (tax > 1e-6) {
      return { year: f0 + y, age: ages?.[y] ?? null, threshold: rates.div293Threshold, ratePct: rates.div293Rate * 100 };
    }
  }
  return null;
}

// Age pension eligibility, derived — client-anchored, the same
// simplification every other client-anchored household-level display in
// this app already uses (the age-pension toggle applies to the whole
// household).
export function agePensionEligibilityFor(state, schedule) {
  return agePensionAgeFor(state, "client", schedule);
}
