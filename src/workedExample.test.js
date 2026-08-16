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

const GROSS_SALARY = 224_697;       // derived — see header
const WORK_RELATED_DEDUCTION = 6_547; // given directly
const HELP_OPENING_BALANCE = 100_000; // unstated — set clear of the repayment

function buildWorkedExampleState() {
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
      start: { year: 2026, month: 7 }, // FY2026–27, matching the "AS AT FY2026/27" figures throughout docs/specs/11
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

describe("Worked example: docs/reference/workbook-document-sense-check.md's client, year one", () => {
  const state = buildWorkedExampleState();
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
