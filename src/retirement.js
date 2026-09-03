// Retirement: Income Required (docs/specs/32-retirement-phase-one.md,
// Commits 1-2) — pure, no DOM/engine mutation.
//
// Income Required is a REFERENCE line, not a driver, in this commit:
// the projection keeps drawing per the existing pension/drawdown
// settings; this module only computes what the client said they need,
// in the same real-dollar/indexation vocabulary as every other
// cashflow row, for deterministic.js to attach to each yearly row
// (`row.incomeRequired`) without it ever feeding projection arithmetic.
// A toggle to actually DRIVE drawdown from it is Commit 4.
//
// Interpretation fixed by the spec: Income Required is AFTER-TAX
// income received by the household — compare it against
// `row.income - row.tax` (net income after tax), never against gross
// drawdown. This is stated on the input and in the Parameters modal
// (index.html's #retirement-income-required section); this module has
// no part in enforcing that beyond keeping the figure itself pre-tax
// (a stated target, not a tax computation).

import { resolveRef } from "./keyDates.js";
import { realAmountAt } from "./schedule.js";
import { createIncomeRequired, isCoupleHousehold, INCOME_REQUIRED_SOURCES } from "./planState.js";
import { asfaAnnual } from "./data/asfaStandards.js";

// Re-exported so existing callers/tests importing the enum from this
// module (its own natural "resolution" home) keep working — the single
// source of truth is planState.js (a schema/clamp concern), never
// duplicated here.
export { INCOME_REQUIRED_SOURCES };

// Total household living-expense rows (state.cashflows.expenses only —
// never property costs, loan repayments, adviser fees, or tax) for
// plan year `y`, summed across its own months. Mirrors schedule.js's
// own "income[m], expenses[m], // household, real $" header comment —
// deliberately the pre-property/pre-tax figure, not deterministic.js's
// richer `row.expenses` (which folds in property expenses and land
// tax too), since "total household living expenses" is the plain-
// English concept the spec names.
function livingExpensesForYear(schedule, y) {
  let total = 0;
  for (let m = 0; m < schedule.months; m++) {
    if (schedule.yearOfMonth[m] === y) total += schedule.expenses[m];
  }
  return total;
}

// Homeowner status derived, not asked (spec 32, Commit 2's own
// heading). The household owns outright at the Retirement key date
// only if it has a principal residence (propertyType "ppr"), ALREADY
// purchased by that plan year, with no balance remaining on any loan
// linked to it. Read from the engine's OWN projected yearly ledger at
// that year — never re-derived from today's loan terms, since extra
// repayments, an offset account, and rate changes all move the real
// payoff date away from a naive amortisation calculation.
//
// No principal residence, or no data at all (a bare test fixture, or
// a plan not yet given a property) → "renter", the spec's own stated
// default ("the honest comparison is the renter standard").
export function deriveHomeownerStatus(properties, liabilities, retirementYearRow) {
  const ppr = (properties ?? []).find((p) => p.propertyType === "ppr");
  if (!ppr || !retirementYearRow) return "renter";
  const owned = (retirementYearRow.properties?.[ppr.id]?.value ?? 0) > 0;
  if (!owned) return "renter"; // not yet purchased by the retirement year
  const loan = (liabilities ?? []).find((l) => l.linkedAssetId === ppr.id);
  if (!loan) return "homeowner"; // no linked mortgage at all
  const closing = retirementYearRow.liabilities?.[loan.id]?.closing ?? 0;
  return closing > 0 ? "renter" : "homeowner";
}

// The un-indexed base figure for `cfg.source`, resolved at `startYear`
// — indexation/step-down are applied uniformly afterwards regardless
// of source (see resolveIncomeRequired below).
//
// `asfaModest` auto-derives homeowner vs renter (above) and resolves
// the matching figure; `asfaModestRenter` is the spec's own "provide
// an override" mechanism — it forces the renter figure regardless of
// what's derived, a deliberate adviser choice rather than a second
// boolean field bolted on. `asfaComfortable` has no renter variant in
// the firm's own source table, so it never derives anything.
function incomeRequiredBaseAmount(cfg, plan, schedule, startYear, ctx) {
  if (cfg.source === "custom") return cfg.customAmount;
  const household = isCoupleHousehold(plan.household) ? "couple" : "single";
  if (cfg.source === "asfaComfortable") return asfaAnnual("comfortable", household) ?? 0;
  if (cfg.source === "asfaModestRenter") return asfaAnnual("modestRenter", household) ?? 0;
  if (cfg.source === "asfaModest") {
    const { planYear: retirementYear } = resolveRef({ kind: "anchor", anchorId: "retirement-client" }, plan, schedule, "client");
    const status = deriveHomeownerStatus(ctx.properties, ctx.liabilities, ctx.yearly?.[retirementYear]);
    return asfaAnnual(status === "renter" ? "modestRenter" : "modest", household) ?? 0;
  }
  return livingExpensesForYear(schedule, startYear); // currentExpenses, and any unrecognised value
}

// resolveIncomeRequired(plan, schedule, cpi, wageGrowth, ctx?) → (y) => amount|null
//
// `ctx` ({ properties, liabilities, yearly }) is only consulted for
// `asfaModest`'s own derivation above; every other source ignores it
// entirely, so omitting it is safe for any caller not exercising that
// one source (defaults derive "renter" — see deriveHomeownerStatus).
//
// The returned accessor gives the resolved, indexed, step-down-applied
// Income Required figure for plan year `y` — real $, after-tax
// interpretation per the header above. `null` for every year before
// `startAt`'s own resolved year (never 0 — 0 is a real, distinguishable
// value once the requirement is actually active; null means "not yet
// applicable", the same convention used elsewhere in this codebase for
// pre-commencement figures).
export function resolveIncomeRequired(plan, schedule, cpi, wageGrowth, ctx = {}) {
  // A plan that never went through clampPlan (a hand-built test
  // fixture, mostly) has no `retirement` block at all — fall back to
  // the same schema default clampPlan itself would have supplied,
  // rather than going inert, so this behaves identically whether or
  // not the caller clamped first (the same defensive convention
  // keyDates.js's resolveOwnerAge already uses for a missing
  // retirementAge).
  const cfg = plan.retirement?.incomeRequired ?? createIncomeRequired();
  const { planYear: startYear } = resolveRef(cfg.startAt, plan, schedule, "client");
  const baseAmount = incomeRequiredBaseAmount(cfg, plan, schedule, startYear, ctx);
  // A pseudo cashflow-row shape so this reuses schedule.js's OWN
  // canonical indexation ratio (realAmountAt) rather than
  // re-deriving it — the ratio formula is reference-point-agnostic:
  // `m` here is months elapsed since startYear, not literal plan start.
  const pseudoRow = { amount: baseAmount, indexBasis: cfg.indexBasis, indexExtraPct: cfg.indexExtraPct };
  return (y) => {
    if (y < startYear) return null;
    let amount = realAmountAt(pseudoRow, (y - startYear) * 12, cpi, wageGrowth);
    if (cfg.stepDownAtAge != null && schedule.clientAges[y] >= cfg.stepDownAtAge) {
      amount *= (cfg.stepDownPct ?? 100) / 100;
    }
    return amount;
  };
}
