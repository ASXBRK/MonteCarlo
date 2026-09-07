// Retirement comparison fixture (docs/specs/33-retirement-standalone.md,
// Commit 4) — one demo client sized for a side-by-side session with the
// firm's second retirement tool, documented in
// docs/reference/retirement-comparison.md.
//
// Originally built through the standalone retirement page's own setters
// (src/retirementStandalone.js) — that page was withdrawn by docs/specs/
// 35-retirement-output-view.md ("retirement accuracy needs the full
// comprehensive input set... it is an OUTPUT over those inputs, not a
// second surface"), so this fixture now uses the SAME raw planState.js
// factories every OTHER demo fixture in this directory uses (see
// src/demo/retiree.js's own header) — a scenario built with a super
// account/salary/other-investments/income-required, same figures as
// before, still reachable from the comprehensive workspace exactly the
// same way. Living expenses is added directly via createExpenseRow, the
// same factory the comprehensive workspace's own Money Out section
// uses; disclosed as such in the comparison document.
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
// — for two independent reasons. (1) build()'s own age must stay
// EXACTLY 45 across every future run of its own test and every future
// read of the documented figures, which a fixed `now` guarantees (a
// dob-based fixture, unlike most of this directory's own currentAge-
// based ones, would otherwise drift). (2) The fixed date is deliberately
// pinned to JULY, not "whenever this was written" — CLAUDE.md's own
// locked convention ("Annual rows and one-offs fire in July; skipped in
// the partial first year if start month > July") would otherwise skip
// the salary row's entire first-year income (an ANNUAL row) while the
// monthly living-expense row still fires every month of that same
// partial year — a real shortfall in year one purely from that
// interaction, caught while tuning this fixture's own numbers.
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
import {
  defaultState, clampAllToPlan, createExpenseRow, createSuperAccount, createIncomeRow,
  createAsset, createIncomeRequired, createPension,
} from "../planState.js";

export function build(now = RETIREMENT_COMPARISON_NOW) {
  let state = defaultState(PROFILES, now);
  state = { ...state, plan: { ...state.plan, client: { ...state.plan.client, dob: RETIREMENT_COMPARISON_DOB, retirementAge: RETIREMENT_COMPARISON_RETIREMENT_AGE } } };
  state = clampAllToPlan(state, PROFILES); // resolve currentAge from dob before any factory below reads it

  const sa = {
    ...createSuperAccount(state.plan, [], PROFILES, "client"),
    balance: RETIREMENT_COMPARISON_SUPER_BALANCE,
    allocation: { mode: "profile", profile: RETIREMENT_COMPARISON_SUPER_ALLOCATION },
  };
  state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };

  const salary = { ...createIncomeRow(state.plan, []), amount: RETIREMENT_COMPARISON_SALARY };
  state = { ...state, cashflows: { ...state.cashflows, income: [salary] } };

  const otherInvestments = {
    ...createAsset(state.plan, [], PROFILES),
    balance: RETIREMENT_COMPARISON_OTHER_INVESTMENTS,
    allocation: { mode: "profile", profile: RETIREMENT_COMPARISON_OTHER_INVESTMENTS_ALLOCATION },
  };
  state = {
    ...state, assets: [otherInvestments],
    settings: { ...state.settings, fundingOrder: [otherInvestments.id] },
  };

  state = {
    ...state,
    plan: {
      ...state.plan,
      retirement: { ...state.plan.retirement, incomeRequired: { ...createIncomeRequired(), source: RETIREMENT_COMPARISON_INCOME_REQUIRED_SOURCE } },
    },
  };

  const livingExpenses = {
    ...createExpenseRow(state.plan, []),
    label: "Living expenses", category: "nonDiscretionary",
    amount: RETIREMENT_COMPARISON_LIVING_EXPENSES / 12, frequency: "monthly",
  };
  state = { ...state, cashflows: { ...state.cashflows, expenses: [livingExpenses] } };

  // Without a pension, super would never draw down at all, and
  // "drawdown... bites" would be false for this fixture — same
  // "fund expenditure shortfall" drawdown + income-driven-drawdown
  // provisioning the standalone page itself used to apply automatically
  // (spec 33 Commit 2), now set explicitly since that page is gone.
  const pension = {
    ...createPension(state.plan, [], state.plan.superAccounts, "client"),
    drawdownOption: "expenditure",
  };
  state = {
    ...state,
    plan: { ...state.plan, pensions: [pension], retirement: { ...state.plan.retirement, incomeDrivenDrawdown: true } },
  };
  const clamped = clampAllToPlan(state, PROFILES);

  return {
    name: "Retirement comparison",
    scenarios: [
      { name: "Current", expectAffordable: true, state: clamped },
    ],
  };
}
