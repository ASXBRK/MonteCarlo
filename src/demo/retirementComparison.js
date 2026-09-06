// Retirement comparison fixture (docs/specs/33-retirement-standalone.md,
// Commit 4) — one demo client sized for a side-by-side session with the
// firm's second retirement tool, documented in
// docs/reference/retirement-comparison.md.
//
// Built through the SAME setters the standalone retirement page itself
// uses (src/retirementStandalone.js) for every one of its own nine
// fields, not the raw factory calls every OTHER demo fixture in this
// directory uses (see src/demo/retiree.js's own header for that
// convention) — this fixture's whole purpose is "what you'd type into
// that page," so building it through the page's own inputs is the most
// direct proof it's reachable there, and these exact constants double
// as the literal "inputs" column in the comparison document. The ONE
// exception is living expenses (below) — the standalone page has no
// expense field at all, but no retirement comparison is meaningful
// without one, so it's added directly via createExpenseRow, the same
// factory the comprehensive workspace's own Money Out section uses;
// disclosed as such in the comparison document rather than silently
// blended in as if it came from the page's own nine fields.
//
// Deliberately NOT added to DEMO_BUILDERS (src/demo/index.js) — same
// reasoning as retiree.js's own header: this exists for the comparison
// record, not as a fifth "Load demo clients" option.
//
// Single, mid-forties, one super account, a salary, modest other
// investments, retiring at 65 — "simple enough that another tool can be
// given identical inputs without ambiguity; rich enough that tax, age
// pension and drawdown all bite" (the spec's own words). Verified
// (src/demo/retirementComparison.test.js): no shortfall ever occurs,
// tax is material during working years, the age pension supplies ~36%
// of average retirement income (and grows as the pension itself
// depletes), and the pension visibly draws down from ~$447k at
// commencement to exhausted by the late 70s — every one of the spec's
// named effects genuinely fires, not just nominally present.
//
// A FIXED reference date (RETIREMENT_COMPARISON_NOW), not "new Date()"
// — for two independent reasons. (1) Every OTHER demo fixture in this
// directory sidesteps age drift by using a bare currentAge instead of a
// dob (see firstHomeBuyer.js's own header); retirementStandalone.js has
// no such setter (setDob takes a real date of birth, by design — this
// page's own field IS "date of birth"), and since this fixture is never
// wired into "Load demo clients" the tradeoff runs the other way here:
// build()'s own age must stay EXACTLY 45 across every future run of its
// own test and every future read of the documented figures, which a
// fixed `now` guarantees. (2) The fixed date is deliberately pinned to
// JULY, not "whenever this was written" — CLAUDE.md's own locked
// convention ("Annual rows and one-offs fire in July; skipped in the
// partial first year if start month > July") would otherwise skip the
// salary row's entire first-year income (an ANNUAL row, this page's
// own default frequency) while the monthly living-expense row still
// fires every month of that same partial year — a real shortfall in
// year one purely from that interaction, caught while tuning this
// fixture's own numbers, not a defect in the standalone page itself
// (which never collects an expense row at all, so no real user of that
// page alone can ever trigger this specific combination).
export const RETIREMENT_COMPARISON_NOW = new Date("2026-07-15T00:00:00+10:00");
export const RETIREMENT_COMPARISON_DOB = "1981-06-15"; // → 45 as at the fixed NOW above
export const RETIREMENT_COMPARISON_RETIREMENT_AGE = 65;
export const RETIREMENT_COMPARISON_SUPER_BALANCE = 150_000;
export const RETIREMENT_COMPARISON_SUPER_ALLOCATION = "Balanced";
export const RETIREMENT_COMPARISON_SALARY = 90_000;
export const RETIREMENT_COMPARISON_OTHER_INVESTMENTS = 30_000;
export const RETIREMENT_COMPARISON_OTHER_INVESTMENTS_ALLOCATION = "Balanced";
export const RETIREMENT_COMPARISON_INCOME_REQUIRED_SOURCE = "asfaComfortable";
// NOT one of the standalone page's own nine fields — see this module's
// own header. CPI-indexed, the schema's own default for a new expense
// row (clampExpenseRow), so this needs no explicit override.
export const RETIREMENT_COMPARISON_LIVING_EXPENSES = 52_000;

import { PROFILES } from "../profiles.js";
import { defaultState, clampAllToPlan, createExpenseRow } from "../planState.js";
import {
  setDob, setRetirementAge, setSuperBalance, setSuperAllocation,
  setSalary, setOtherInvestments, setOtherInvestmentsAllocation,
  setIncomeRequired, ensureRetirementPensions,
} from "../retirementStandalone.js";

export function build(now = RETIREMENT_COMPARISON_NOW) {
  let state = defaultState(PROFILES, now);
  state = setDob(state, "client", RETIREMENT_COMPARISON_DOB);
  state = setRetirementAge(state, "client", RETIREMENT_COMPARISON_RETIREMENT_AGE);
  state = setSuperBalance(state, "client", RETIREMENT_COMPARISON_SUPER_BALANCE, PROFILES);
  state = setSuperAllocation(state, "client", { mode: "profile", profile: RETIREMENT_COMPARISON_SUPER_ALLOCATION }, PROFILES);
  state = setSalary(state, "client", RETIREMENT_COMPARISON_SALARY);
  state = setOtherInvestments(state, RETIREMENT_COMPARISON_OTHER_INVESTMENTS, PROFILES);
  state = setOtherInvestmentsAllocation(state, { mode: "profile", profile: RETIREMENT_COMPARISON_OTHER_INVESTMENTS_ALLOCATION }, PROFILES);
  state = setIncomeRequired(state, { source: RETIREMENT_COMPARISON_INCOME_REQUIRED_SOURCE });

  const livingExpenses = {
    ...createExpenseRow(state.plan, []),
    label: "Living expenses", category: "nonDiscretionary",
    amount: RETIREMENT_COMPARISON_LIVING_EXPENSES / 12, frequency: "monthly",
  };
  state = { ...state, cashflows: { ...state.cashflows, expenses: [livingExpenses] } };

  // Same pension auto-provisioning the standalone page itself applies
  // (spec 33 Commit 2) — without it, super would never draw down at
  // all, and "drawdown... bites" would be false for this fixture.
  state = ensureRetirementPensions(state, PROFILES);
  const clamped = clampAllToPlan(state, PROFILES);

  return {
    name: "Retirement comparison",
    scenarios: [
      { name: "Current", expectAffordable: true, state: clamped },
    ],
  };
}
