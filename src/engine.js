// Engine API boundary (spec 31, Commit 1) — a thin public surface over
// the existing engine (deterministic.js) and normalisation pipeline
// (planState.js). No new projection logic lives here: this module
// names what already exists and fixes its shape, so a consumer — an
// external tool, or a second in-house projection system producing a
// polished document from a snapshot-year extrapolation (spec 30
// measures the consequence of that) — can run a projection without
// reading deterministic.js's internals.
//
// See docs/reference/engine-api.md for the full developer-facing
// contract (Commit 2), a worked integration example (Commit 3), and
// the contract-stability test (Commit 4) that pins the result SHAPE
// (field names/types, not values) against silent drift.
//
// Note: `runProjection` also exists, unrelated, in Tax/projection.js —
// a FIFO capital-gains parcel-sale utility with a different signature
// (`runProjection(scenario)`). Different module, no import collision,
// but worth knowing the name isn't unique in this codebase.
import { clampAllToPlan } from "./planState.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";

// The RESULT contract's own version — independent of planState.js's
// SCHEMA_VERSION, which versions the INPUT (a stored plan state).
// Semantic versioning: removing or renaming a result field is a
// breaking change (bump the major); adding a field is additive (bump
// the minor); anything else that doesn't change the shape (a bug fix
// changing VALUES, a new internal implementation) bumps the patch or
// nothing at all. Any commit that changes the result shape must update
// this constant, docs/reference/engine-api.md's version history, and
// the Commit 4 contract snapshot in the SAME commit — see CLAUDE.md.
export const ENGINE_VERSION = "1.0.0";

// The period the embedded figures (tax brackets, super caps, age
// pension thresholds, CMA profile returns — see
// docs/reference/assumptions-provenance.md) were last verified
// against a primary source. A projection is only meaningful alongside
// the figures that produced it, so every result carries this
// alongside the numbers. Keep in sync with that document's own "Last
// verification pass" line when it updates.
export const FIGURES_AS_AT = "2026-08"; // "Last verification pass: August 2026"

// validateInput(input) → [{ field, message }, ...] (empty when valid)
//
// Deliberately NOT a second clamp/normalise pass — clampAllToPlan
// already silently defaults everything that CAN be defaulted (a
// missing household, a missing client age, a missing endAge all
// resolve to a sensible value; that's existing, intentional behaviour
// this commit must not change). This checks only the handful of
// shapes clampAllToPlan itself assumes without a fallback and would
// otherwise throw an unstructured exception on, or silently corrupt
// every figure in, the projection: `state.plan` is accessed directly
// (no `??`); `state.assets` and each of
// `state.cashflows.{income,expenses,contributions,withdrawals,
// lumpSums}` are `.map()`'d directly with no `?? []` guard;
// `state.assumptions` is accessed directly (schedule.js's
// `buildSchedules`, the engine's own first step) and `.cpi` has no
// fallback anywhere, unlike `bracketMode`/`awote`/`wageGrowth`/
// `mortgageRate`/`fhsssEarningsRate`, which all default via `??` —
// a missing/non-numeric cpi wouldn't throw, it would silently feed
// NaN into every real-terms growth/indexation calculation in the
// engine, which is worse. Every other collection (bonds/liabilities/
// properties/goals/settings/plan's own sub-collections) already
// tolerates absence via its own `Array.isArray(...) ? ... : []` or
// `?.` guard — flagging those here too would just be a second,
// divergent validator, which is exactly what the spec warns against.
export function validateInput(input) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    fail("$", "Input must be a plan state object.");
    return errors;
  }
  if (input.plan == null || typeof input.plan !== "object" || Array.isArray(input.plan)) {
    fail("plan", "Required — the plan's identity, household and timing fields.");
  }
  if (!Array.isArray(input.assets)) {
    fail("assets", "Required — an array of asset rows (may be empty).");
  }
  if (input.cashflows == null || typeof input.cashflows !== "object" || Array.isArray(input.cashflows)) {
    fail("cashflows", "Required — an object grouping the income/expense/contribution/withdrawal/lump-sum arrays.");
  } else {
    for (const key of ["income", "expenses", "contributions", "withdrawals", "lumpSums"]) {
      if (!Array.isArray(input.cashflows[key])) {
        fail(`cashflows.${key}`, "Required — an array (may be empty).");
      }
    }
  }
  if (input.assumptions == null || typeof input.assumptions !== "object" || Array.isArray(input.assumptions)) {
    fail("assumptions", "Required — must at minimum carry cpi.");
  } else if (typeof input.assumptions.cpi !== "number" || !Number.isFinite(input.assumptions.cpi)) {
    fail("assumptions.cpi", "Required — a finite number (annual CPI assumption, e.g. 0.025 for 2.5%).");
  }
  return errors;
}

// runProjection(input, profiles = PROFILES) → ProjectionResult
//
// ProjectionResult is always the SAME shape: { engineVersion,
// figuresAsAt, errors, ...rest }. `errors` is an empty array on
// success; when non-empty, every other field EXCEPT the three above
// is absent (there is no partial/best-effort projection of invalid
// input — deterministic.js's own yearly loop assumes the state it's
// given already clamps to something coherent). On success, `...rest`
// is exactly deterministic.js's own projectPlan() result, unmodified —
// `yearly` (the per-year ledger), `schedule`, `monthly`, `shortfall`,
// the accrued-tax summary fields, the warning arrays, and the rest —
// see docs/reference/engine-api.md for the full field-by-field
// reference (Commit 2).
export function runProjection(input, profiles = PROFILES) {
  const errors = validateInput(input);
  if (errors.length > 0) {
    return { engineVersion: ENGINE_VERSION, figuresAsAt: FIGURES_AS_AT, errors };
  }
  const state = clampAllToPlan(input, profiles);
  const out = projectPlan(state, profiles);
  return { engineVersion: ENGINE_VERSION, figuresAsAt: FIGURES_AS_AT, errors: [], ...out };
}
