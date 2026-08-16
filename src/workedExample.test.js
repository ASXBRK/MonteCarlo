// Worked-example validation — the tool has never been checked against
// an independently-produced correct answer until this test. Builds the
// client described (indirectly) in
// docs/reference/workbook-document-sense-check.md as a real scenario
// and asserts the Snapshot view's year-one column against the firm's
// own hand-produced figures: net income $134,215, take-home pay
// $130,422, anticipated refund $3,793, HELP $21,815, work-related
// expenses $6,547.
//
// See docs/reference/worked-example.md for the line-by-line
// reconciliation and the reasoning behind every figure below —
// including which inputs are GIVEN, which are DERIVED from a stated
// formula, and which are UNSTATED (never invented; disclosed as such).
// This file only needs to reproduce the derivation precisely enough to
// re-run it; the write-up carries the argument.
//
// Reconstruction summary (full reasoning in worked-example.md):
//   - The sense-check analysis gives five figures but no gross salary,
//     household composition, ages, or HELP opening balance. It is a
//     SINGLE client scenario here — an assumption, not a given, made
//     because household composition (single vs couple) is nowhere
//     stated in the analysis and splitting the figures across two
//     invented incomes would be exactly the "inventing a value to make
//     a line reconcile" this exercise is required to avoid.
//   - Taxable income is DERIVED, not invented: docs/specs/11-document-
//     set.md's own HELP table has a literal 10% of TOTAL repayment
//     income cliff above $186,051, and $21,815 is EXACTLY 10% of
//     $218,150 — not a coincidence spec 11 could have engineered
//     without the real figure, since it predates this test. Taxable
//     income = repayment income (no reportable super contributions
//     assumed) = $218,150.
//   - Gross salary = taxable income + the stated $6,547 work-related
//     deduction = $224,697.
//   - HELP opening balance is UNSTATED — set well above $21,815 so the
//     compulsory repayment is never capped by it; the $21,815 result
//     does not depend on its exact value as long as it clears that bar.
import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { cashflowStatement } from "./cashflowStatement.js";
import { buildSnapshotTable } from "./snapshot.js";
import { HELP_RATES_BASE, helpRepaymentAmount } from "./data/helpRates.js";

const GROSS_SALARY = 224_697;       // derived — see header
const WORK_RELATED_DEDUCTION = 6_547; // given directly
const HELP_OPENING_BALANCE = 100_000; // unstated — set clear of the repayment

// startYear parameterises the FY-vintage check below (Follow-up §3):
// plan.start.year drives which bracket table src/Tax/annual.js's
// bracketSettings() selects (fyStartYear <= 2025 → "2025-26",
// fyStartYear === 2026 → "2026-27"). Everything else about the
// reconstruction is unchanged between the two runs.
function buildWorkedExampleState(startYear = 2026) {
  return {
    plan: {
      household: "single", // ASSUMPTION — see header; not stated in the analysis
      client: {
        currentAge: 35, // unstated; immaterial to these five figures at this income (no SAPTO/Div293 threshold nearby)
        privateHospitalCover: true, // ASSUMPTION — MLS isn't part of the document's cited figures; without cover, MLS would apply at this income and none of the five targets would reconcile
        helpBalance: HELP_OPENING_BALANCE,
      },
      partner: null,
      endAge: 36, // only year 1 (plan year 0) is asserted
      start: { year: startYear, month: 7 },
      superAccounts: [],
      workingCash: { balance: 5000, minimumBalance: 0, ratePct: 2.5 }, // ratePct = cpi: zero REAL WCA interest, so it can't leak into assessable income
    },
    assets: [{
      id: "a1", name: "Savings", include: true, owner: "client",
      distributions: "reinvest", balance: 10_000,
      allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
      icrPct: 0, cgtAsset: false, costBase: null,
    }],
    goals: [], liabilities: [], properties: [],
    cashflows: {
      income: [{
        id: "sal1", label: "Salary", owner: "client", amount: GROSS_SALARY, frequency: "annual",
        from: { kind: "age", age: 35 }, to: { kind: "age", age: 120 },
        indexBasis: "none", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: true,
      }],
      expenses: [],
      deductions: [{
        id: "ded1", label: "Working Expense", owner: "client", category: "workingExpense",
        amount: WORK_RELATED_DEDUCTION, frequency: "annual",
        from: { kind: "age", age: 35 }, to: { kind: "age", age: 120 },
        indexBasis: "none", indexExtraPct: 0,
      }],
      contributions: [], withdrawals: [], lumpSums: [], superContributions: [],
    },
    settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: ["a1"] },
    assumptions: { cpi: 0.025, awote: 0.035, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

function snapshotRowValue(table, label) {
  const row = table.rows.find((r) => r.label === label);
  if (!row) throw new Error(`No Snapshot row named "${label}" — SNAPSHOT_ROWS may have changed`);
  return row.cells[0].total;
}

// Runs the reconstruction for a given FY-start year and returns
// everything the assertions below need — shared by the FY2026-27
// (primary) and FY2025-26 (Follow-up §3 hypothesis test) runs.
function assessYearOne(startYear = 2026) {
  const state = buildWorkedExampleState(startYear);
  const out = projectPlan(state);
  const row = out.yearly[0];
  const ctx = {
    incomeRows: state.cashflows.income, rowTotalsIncome: { sal1: [GROSS_SALARY] },
    deductionRows: state.cashflows.deductions, rowTotalsDeductions: { ded1: [WORK_RELATED_DEDUCTION] },
    expenseRows: [], rowTotalsExpenses: {},
    properties: [], liabilities: [], superAccounts: [], y: 0,
  };
  const stmt = cashflowStatement(row, ctx, null);
  const table = buildSnapshotTable([{ y: 0, client: stmt, partner: null, total: stmt }], { hideEmptyRows: false });
  return { state, out, row, stmt, table };
}

describe("Worked example: docs/reference/workbook-document-sense-check.md's client, year one", () => {
  const { row, stmt, table } = assessYearOne(2026);

  // Sanity check on the derivation itself, before comparing to the
  // document: confirms the reconstructed inputs actually produce the
  // taxable income the derivation assumed, so a later engine change
  // that silently shifts this doesn't make the comparisons below
  // meaningless without anyone noticing why.
  it("the derived taxable income is $218,150 (repayment income implied by the given $21,815 HELP figure)", () => {
    expect(stmt.taxableIncome).toBeCloseTo(218_150, 2);
  });

  // --- The five targets, each with its own justified tolerance -----------
  //
  // Tolerances are deliberately NOT uniform: HELP and the deduction are
  // exact by construction (one is a direct input, the other reproduces
  // the document's own formula precisely). Take-home pay is close but
  // not exact — a small, plausible rounding/withholding-table gap.
  // Net income is NOT tightly asserted: it carries a real, unexplained
  // ~4.7% gap (see worked-example.md's DISCREPANCY entry) that a tight
  // tolerance would hide. The wide tolerance here proves the figure is
  // stable and in the right order of magnitude without pretending the
  // gap is understood — narrowing it later should mean the discrepancy
  // was actually resolved, not that the assertion was quietly loosened
  // further.

  it("HELP repayment matches the document's $21,815 exactly (this is the figure the whole reconstruction is built from)", () => {
    expect(snapshotRowValue(table, "HELP Repayment")).toBeCloseTo(-21_815, 2); // Snapshot rows show tax as a negative (a deduction from income)
  });

  it("Working Expense deduction matches the document's $6,547 exactly (a direct input, not computed)", () => {
    expect(snapshotRowValue(table, "Working Expense")).toBeCloseTo(-6_547, 2);
  });

  it("Regular take-home pay is within $500 (0.4%) of the document's $130,422", () => {
    const takeHome = snapshotRowValue(table, "Regular Take Home Pay");
    expect(Math.abs(takeHome - 130_422)).toBeLessThan(500);
  });

  it("Anticipated Tax Return is $0 for year one, BY DESIGN — the engine settles a FY's PAYG/actual gap as cash in July of the FOLLOWING FY (docs/reference/worked-example.md's ASSUMPTION entry), so a brand-new scenario's first year always shows nothing here", () => {
    expect(snapshotRowValue(table, "Anticipated Tax Return")).toBe(0);
  });

  it("the UNDERLYING accrual-basis refund for year one (settling in year two) is within $200 of the document's $3,793 — confirming the gap above is genuinely just timing, not a missing calculation", () => {
    expect(Math.abs(row.taxDetail.client.refundOrBalancing - 3_793)).toBeLessThan(200);
  });

  it("NET INCOME is within $6,500 (4.8%) of the document's $134,215 — a real, disclosed, unexplained gap (see worked-example.md), not hidden by a tighter number", () => {
    const netIncome = snapshotRowValue(table, "NET INCOME");
    expect(Math.abs(netIncome - 134_215)).toBeLessThan(6_500);
  });
});

// --- Follow-up: is the workbook just a year out of date? --------------------
//
// The workbook is a hand-built spreadsheet from the PRIOR financial
// year. Hypothesis: if it used FY2025-26 tax brackets (16% second
// bracket, not FY2026-27's legislated 15% cut — src/Tax/engine.js's
// own LEG.brackets table, cross-checked against the ATO's published
// FY2025-26/FY2026-27 resident rates), that alone might explain the
// $134,215 net income figure.
//
// It doesn't. FY2025-26 rates are HIGHER, not lower, than FY2026-27's
// (the legislated cut runs 16% → 15% → 14% over FY2025-26/26-27/27-28)
// — so assessing this exact client under FY2025-26 rates produces a
// SMALLER net income, moving further from the document's figure, not
// closer. This rejects the stale-threshold hypothesis outright: no
// financial year on this multi-year tax-cut schedule assesses this
// client's $218,150 taxable income at a net income anywhere near
// $134,215 — every year AFTER FY2026-27 only cuts rates FURTHER
// (moving the same direction as the FY2026-27 case, away from the
// document), and every year BEFORE it taxes MORE, not less.
describe("Follow-up: the FY2025-26 hypothesis (the workbook predates this FY) is rejected", () => {
  const fy2526 = assessYearOne(2025);
  const fy2627 = assessYearOne(2026);

  it("FY2025-26's 16% second bracket taxes this client $268 more than FY2026-27's 15% — exactly the width of the bracket cut ($26,800 × 1pp)", () => {
    const diff = fy2526.stmt.tax.incomeTax - fy2627.stmt.tax.incomeTax;
    expect(diff).toBeCloseTo(268, 2);
  });

  it("HELP is UNCHANGED across both years for this client — $218,150 repayment income clears both years' cliff threshold ($179,286 in 2025-26 per the ATO, $186,052 in 2026-27 per our own data), so the HELP match doesn't discriminate between the two hypotheses at all", () => {
    expect(fy2526.stmt.tax.helpRepayment).toBeCloseTo(fy2627.stmt.tax.helpRepayment, 2);
    expect(fy2526.stmt.tax.helpRepayment).toBeCloseTo(21_815, 2);
  });

  it("net income under FY2025-26 rates is FURTHER from the document's $134,215 than FY2026-27's, not closer — the stale-threshold hypothesis is rejected", () => {
    const gap2526 = Math.abs(fy2526.stmt.netIncome - 134_215);
    const gap2627 = Math.abs(fy2627.stmt.netIncome - 134_215);
    expect(gap2526).toBeGreaterThan(gap2627);
  });
});

// --- Follow-up: is $134,215 reachable at all for a single earner? ----------
//
// HELP's own bracket shape makes $21,815 a UNIQUE result: it can only
// arise from the flat 10%-of-total cliff, never from either marginal
// bracket below it, because both marginal brackets cap out well short
// of $21,815 at their own ceiling. That pins repayment income (and, in
// this single-income reconstruction with no reportable-super-
// contribution add-back, taxable income) to exactly $218,150 — there
// is no OTHER taxable income a single earner could have and still
// report this exact HELP figure.
describe("Follow-up: $21,815 HELP uniquely determines $218,150 repayment income — no other single-earner reconstruction is possible", () => {
  it("the marginal bracket below the cliff caps out at $9,028.35 — far short of $21,815", () => {
    const maxBracket2 = helpRepaymentAmount(129_717, HELP_RATES_BASE);
    expect(maxBracket2).toBeCloseTo(9_028.35, 1);
    expect(maxBracket2).toBeLessThan(21_815);
  });

  it("the marginal bracket just below the flat cliff caps out at ~$18,605 — still short of $21,815", () => {
    const maxBracket3 = helpRepaymentAmount(HELP_RATES_BASE.cliffThreshold - 1, HELP_RATES_BASE);
    expect(maxBracket3).toBeLessThan(21_815);
    expect(maxBracket3).toBeGreaterThan(18_000);
  });

  it("only the flat 10% cliff can produce $21,815, and it does so at exactly $218,150 — confirming the reconstruction's taxable income is the UNIQUE solution, not a choice among several", () => {
    expect(helpRepaymentAmount(218_150, HELP_RATES_BASE)).toBeCloseTo(21_815, 2);
  });
});
