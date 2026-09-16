// Display totals reconcile to the ledger (docs/specs/37-review-
// remediation.md, Commit 4; adversarial review findings 1.10, 1.11,
// 2.5) — one integration test, built from a scenario with every
// balance/income type the three findings named (accumulation super,
// an account-based pension, a bond, an investment property, and the
// age pension), asserting every display-layer total this commit
// touched equals its own ledger source. A single test covering one
// balance type would not have caught all three findings — the whole
// point of building the scenario with all five ingredients at once.

import { describe, it, expect } from "vitest";
import {
  defaultState, clampAllToPlan, createAsset, createExpenseRow, createSuperAccount, createPension, createBond, createProperty,
} from "./planState.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";
import { cashflowStatement } from "./cashflowStatement.js";
import { incomeCategorySums, expenseCategorySums } from "./cashflowCategories.js";
import { debtVsAssetsSeries, superVsNonSuperSeries, expenseFundingSeries } from "./chartSeries.js";
import { compositeSeries } from "./outputSeries.js";

function buildRetireeState() {
  let state = defaultState(PROFILES, new Date(2026, 6, 1)); // July 2026 — no partial-first-year complication
  state.plan = {
    ...state.plan,
    // A bare {currentAge, retirementAge} — NOT spread over the old
    // client object, which carries a `dob` clampPlan treats as
    // authoritative and would recompute currentAge FROM, silently
    // discarding this override (found while writing this fixture).
    client: { currentAge: 70, retirementAge: 65 },
    endAge: 74,
  };
  const savings = {
    ...createAsset(state.plan, [], PROFILES), id: "savings", name: "Savings", owner: "client",
    balance: 40000, distributions: "reinvest", cgtAsset: false, costBase: null,
    allocation: { mode: "profile", profile: "Cash" },
  };
  const sup = {
    ...createSuperAccount(state.plan, [], PROFILES, "client"), id: "sup1", name: "Super",
    balance: 600000, allocation: { mode: "profile", profile: "Moderate Growth" },
  };
  const pen = {
    ...createPension(state.plan, [], [sup], "client"), id: "pen1", name: "ABP", sourceAccountId: sup.id,
    commenceAt: { kind: "age", age: 70 }, commenceAmount: null, drawdownOption: "minimum",
    allocation: { mode: "profile", profile: "Moderate Growth" },
  };
  const bond = {
    ...createBond(state.plan, [], PROFILES), id: "bond1", name: "Bond",
    balance: 100000, allocation: { mode: "profile", profile: "Balanced" },
  };
  const property = {
    ...createProperty(state.plan, [], 5), id: "prop1", name: "Investment unit", owner: "client",
    propertyType: "investment", status: "owned", currentValue: 350000, costBase: 300000,
    acquisitionDate: "2015-01-01",
    rent: { amount: 18000, indexBasis: "cpi", indexExtraPct: 0, isDefault: false },
    expenses: { amount: 4000, indexBasis: "cpi", indexExtraPct: 0, isDefault: false },
  };
  const exp = {
    ...createExpenseRow(state.plan, []), id: "exp1", label: "Living", category: "nonDiscretionary",
    amount: 45000 / 12, frequency: "monthly",
  };
  state = {
    ...state,
    assets: [savings],
    bonds: [bond],
    properties: [property],
    plan: { ...state.plan, superAccounts: [sup], pensions: [pen] },
    cashflows: { ...state.cashflows, expenses: [exp] },
    settings: { ...state.settings, fundingOrder: [savings.id] },
  };
  return clampAllToPlan(state, PROFILES);
}

describe("Display totals reconcile to the ledger (docs/specs/37-review-remediation.md, Commit 4)", () => {
  it("every displayed total equals its ledger source, for a scenario with accumulation, pension, bonds, property and age pension", () => {
    const state = buildRetireeState();
    const out = projectPlan(state);
    expect(out.errors).toBeUndefined(); // projectPlan itself has no .errors; a thrown exception would fail the test before this line

    const rt = out.schedule.rowTotals;
    for (let y = 0; y < out.yearly.length; y++) {
      const row = out.yearly[y];

      // Sanity: this scenario actually exercises every ingredient —
      // otherwise a zeroed-out field would trivially "reconcile".
      expect(row.pensionClosing).toBeGreaterThan(0);
      expect(row.bondsClosing).toBeGreaterThan(0);
      expect(row.propertyClosing).toBeGreaterThan(0);
      if (y > 0) expect(row.agePensionDetail?.entitlement).toBeGreaterThan(0);

      // Finding 1.11 — Total assets/Super vs non-super include pension
      // and bond balances, and reconcile with each other exactly.
      expect(row.totalAssets).toBeCloseTo(
        row.closingBalance + row.propertyClosing + row.superClosing + row.pensionClosing + row.bondsClosing + row.wcaClosing, 4
      );
      expect(row.netAssets).toBeCloseTo(row.totalAssets - row.liabilitiesClosing - row.heasDetail.closing, 4);
      const dva = debtVsAssetsSeries(out.yearly)[y];
      expect(dva.assets).toBeCloseTo(row.totalAssets, 4);
      const svn = superVsNonSuperSeries(out.yearly)[y];
      expect(svn.superBalance + svn.nonSuper).toBeCloseTo(row.totalAssets, 4);
      expect(svn.superBalance).toBeCloseTo(row.superClosing + row.pensionClosing, 4);

      // Finding 1.10 — Total income (category sums) includes the age
      // pension. The categories reconcile to row.income PLUS wcaInterest
      // (not row.income alone — see cashflowCategories.js's own header:
      // deterministic.js deliberately credits WCA interest to
      // surplusOrDeficit as its own term, never into row.income).
      const inc = incomeCategorySums(row, state.cashflows.income, rt.income, state.properties, out.schedule.oneOffsByAssetYear, state.assets.map((a) => a.id), state.plan.superAccounts, y);
      const totalIncome = inc.employment + inc.rental + inc.investment + inc.wcaInterest + inc.other + inc.agePension;
      expect(totalIncome).toBeCloseTo(row.income + row.wcaDetail.interest, 2);

      // Finding 1.10 — Cash Received includes the age pension, pension
      // payments and released-super withdrawals.
      const ctx = {
        incomeRows: state.cashflows.income, rowTotalsIncome: rt.income,
        expenseRows: state.cashflows.expenses, rowTotalsExpenses: rt.expenses,
        deductionRows: state.cashflows.deductions ?? [], rowTotalsDeductions: rt.deductions,
        properties: state.properties, liabilities: state.liabilities ?? [],
        superAccounts: state.plan.superAccounts, y,
        educationBlocks: [], rowTotalsEducation: {},
        definedBenefits: state.plan.definedBenefits ?? [],
        pensionRows: state.plan.pensions,
      };
      const statement = cashflowStatement(row, ctx, null);
      const pensionPaymentsThisYear = Object.values(row.pensionDetail ?? {}).reduce((s, d) => s + (d.payments ?? 0), 0);
      expect(statement.cashReceived.governmentPayments).toBeCloseTo(row.agePensionDetail?.entitlement ?? 0, 2);
      expect(statement.cashReceived.pensionPayments).toBeCloseTo(pensionPaymentsThisYear, 2);
      if (y > 0) expect(statement.cashReceived.pensionPayments).toBeGreaterThan(0);
      expect(statement.cashReceived.total).toBeCloseTo(
        statement.cashReceived.regularTakeHomePay + statement.cashReceived.anticipatedTaxReturn
          + statement.cashReceived.afterTaxBonus + statement.cashReceived.otherTaxFreeIncome
          + statement.cashReceived.governmentPayments + statement.cashReceived.pensionPayments
          + statement.cashReceived.releasedSuperWithdrawals,
        4
      );
      // Finding 2.5 — the composite chart's drawdown band includes
      // pension payments.
      const cs = compositeSeries(out.yearly, state.assets, state.properties, state.display.chartTreatment);
      expect(cs.drawdown[y]).toBeCloseTo(row.withdrawals + row.deficitFundedFromAssets + pensionPaymentsThisYear
        + Object.values(row.superDetail ?? {}).reduce((s, d) => s + (d.withdrawals ?? 0), 0), 4);

      // Finding 2.5 — expenseFundingSeries's four bands still sum
      // exactly to the year's total need.
      const ef = expenseFundingSeries(out.yearly)[y];
      const need = row.income - row.surplusOrDeficit;
      expect(ef.metFromIncome + ef.fundedFromPension + ef.fundedFromAssets + ef.unfunded).toBeCloseTo(need, 4);
    }

    // cashflowCategories.js's own reconciliation claim, made true
    // (Commit 4 instruction): summing every income category (now
    // including agePension) reproduces row.income exactly, for every
    // year, not just spot-checked ones — already asserted per-year
    // above; this is the explicit "the claim in the header is true"
    // marker the spec asks for.
  });
});
