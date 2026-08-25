import { describe, it, expect } from "vitest";
import {
  assessableIncome, deductionSums, taxSums, cashReceivedSums, expenseSums, cashflowStatement,
} from "./cashflowStatement.js";
import { projectPlan } from "./deterministic.js";

function mkRow(over = {}) {
  return {
    superDetail: {},
    properties: {},
    liabilities: {},
    cashDistributions: 0,
    wcaDetail: { interest: 0 },
    tax: 0,
    taxDetail: {
      client: { grossTax: 0, medicare: 0, lito: 0, paygWithheld: 0 },
      partner: {},
      frankingCredits: 0,
      div293: 0,
      div296: 0,
      netCapitalGain: 0,
      refundSettled: 0,
    },
    ...over,
  };
}

describe("assessableIncome", () => {
  it("sums category rows plus derived figures, and totals every field including the [zero] placeholders", () => {
    const row = mkRow({
      wcaDetail: { interest: 50 },
      cashDistributions: 200,
      properties: { p1: { rent: 1000 } },
      taxDetail: { client: {}, partner: {}, frankingCredits: 300, netCapitalGain: 400 },
    });
    const incomeRows = [
      { id: "i1", category: "salary" },
      { id: "i2", category: "otherIncome" },
      { id: "i3", category: "interestIncome" },
      { id: "i4", category: "dividendIncome" },
    ];
    const rowTotalsIncome = { i1: [80000], i2: [1500], i3: [100], i4: [250] };
    const properties = [{ id: "p1", propertyType: "investment" }];
    const a = assessableIncome(row, { incomeRows, rowTotalsIncome, properties, y: 0 });
    expect(a.salary).toBe(80000);
    expect(a.otherIncome).toBe(1500);
    expect(a.interestIncome).toBe(50 + 100); // WCA interest + category row
    expect(a.dividendIncome).toBe(200 + 250); // distributions + category row
    expect(a.frankingCredits).toBe(300);
    expect(a.propertyIncomeGross).toBe(1000);
    expect(a.netTaxableCapitalGains).toBe(400);
    expect(a.taxablePensionComponent).toBe(0);
    expect(a.governmentPayments).toBe(0);
    expect(a.trustDistribution).toBe(0);
    expect(a.foreignIncome).toBe(0);
    // Assessable Income = the sum of every constituent row.
    const manualSum = a.salary + a.taxablePensionComponent + a.otherIncome + a.governmentPayments
      + a.interestIncome + a.dividendIncome + a.frankingCredits + a.propertyIncomeGross
      + a.trustDistribution + a.foreignIncome + a.netTaxableCapitalGains;
    expect(a.total).toBeCloseTo(manualSum, 6);
  });

  // Pension phase (spec 20, Commit 2/5) — the reserved "Taxable Pension
  // Component" row reads the engine's own figure, not a hardcoded 0 —
  // see taxSums' own sibling test above for why this is exercised
  // directly rather than via a real projection.
  it("Taxable Pension Component reads from taxDetail, summed across both persons", () => {
    const row = mkRow({
      taxDetail: {
        client: { taxablePensionComponent: 4000 },
        partner: { taxablePensionComponent: 1500 },
        frankingCredits: 0, netCapitalGain: 0,
      },
    });
    const a = assessableIncome(row, {});
    expect(a.taxablePensionComponent).toBe(5500);
    const aClient = assessableIncome(row, {}, "client");
    expect(aClient.taxablePensionComponent).toBe(4000);
  });

  // Age pension (spec 21a, Commit 3) — the reserved "Government/
  // Centrelink payments" row reads the engine's own figure, but
  // (Commit 3's own non-assessable tax-treatment decision) is
  // deliberately EXCLUDED from computedTotal/total despite living in
  // this section — its firm-template home, not a taxability promise.
  it("Government/Centrelink payments reads from agePensionDetail, per-owner, but never joins the assessable total", () => {
    const row = mkRow({
      agePensionDetail: {
        entitlement: 20000,
        client: { paid: 14000 }, partner: { paid: 6000 },
      },
    });
    const a = assessableIncome(row, {});
    expect(a.governmentPayments).toBe(20000);
    expect(a.total).toBe(0); // every other constituent is 0 in this fixture — governmentPayments must not sneak in
    const aClient = assessableIncome(row, {}, "client");
    expect(aClient.governmentPayments).toBe(14000);
    const aPartner = assessableIncome(row, {}, "partner");
    expect(aPartner.governmentPayments).toBe(6000);
  });

  it("Government/Centrelink payments defaults to 0 with no agePensionDetail on the row (pre-spec-21a rows)", () => {
    const a = assessableIncome(mkRow(), {});
    expect(a.governmentPayments).toBe(0);
  });
});

describe("deductionSums", () => {
  it("reconciles property interest/expenses/depreciation rows to the property module directly", () => {
    const row = mkRow({
      properties: { p1: { expenses: 3000, depreciation: 6000 } },
      liabilities: { "prop-p1": { interest: 12000, principal: 8000 } },
    });
    const properties = [{ id: "p1", propertyType: "investment" }];
    const d = deductionSums(row, { properties, liabilities: [], y: 0 });
    expect(d.propertyInterestDeductions).toBe(12000); // matches row.liabilities["prop-p1"].interest exactly
    expect(d.propertyDeductions).toBe(3000); // matches row.properties.p1.expenses exactly
    expect(d.propertyDepreciation).toBe(6000); // matches row.properties.p1.depreciation exactly
  });

  it("land tax (spec 19 Commit 2) is deductible for an investment property, split by owner share", () => {
    const row = mkRow({ properties: { p1: { landTax: 1000 }, p2: { landTax: 500 } } });
    const properties = [
      { id: "p1", propertyType: "investment", owner: "client" },
      { id: "p2", propertyType: "holiday", owner: "client" }, // NOT deductible — excluded here
    ];
    const d = deductionSums(row, { properties, liabilities: [], y: 0 });
    expect(d.propertyLandTax).toBe(1000);
  });

  it("splits a standalone deductible liability into Investment Portfolio Interest, never Property Interest Deductions", () => {
    const row = mkRow({ liabilities: { margin1: { interest: 900, principal: 0 } } });
    const liabilities = [{ id: "margin1", deductible: true }];
    const d = deductionSums(row, { properties: [], liabilities, y: 0 });
    expect(d.investmentPortfolioInterest).toBe(900);
    expect(d.propertyInterestDeductions).toBe(0);
  });

  it("a non-deductible standalone liability contributes to neither interest deduction row", () => {
    const row = mkRow({ liabilities: { personal1: { interest: 500, principal: 0 } } });
    const liabilities = [{ id: "personal1", deductible: false }];
    const d = deductionSums(row, { properties: [], liabilities, y: 0 });
    expect(d.investmentPortfolioInterest).toBe(0);
    expect(d.propertyInterestDeductions).toBe(0);
  });

  it("HELP-as-liability follow-up fix: a help_<person> entry is never deductible interest — it isn't in state.liabilities at all, so treating it as one would be a silent lookup miss, not a deliberate zero", () => {
    const row = mkRow({ liabilities: { help_client: { interest: 0, principal: 4570.80 } } });
    const d = deductionSums(row, { properties: [], liabilities: [], y: 0 });
    expect(d.investmentPortfolioInterest).toBe(0);
    expect(d.propertyInterestDeductions).toBe(0);
  });

  it("category rows aggregate correctly and the total sums every field", () => {
    const row = mkRow();
    const deductionRows = [
      { id: "d1", category: "vehicle" }, { id: "d2", category: "vehicle" },
      { id: "d3", category: "workingExpense" }, { id: "d4", category: "other" },
    ];
    const rowTotalsDeductions = { d1: [1000], d2: [500], d3: [2000], d4: [300] };
    const d = deductionSums(row, { deductionRows, rowTotalsDeductions, y: 0 });
    expect(d.vehicle).toBe(1500); // aggregates BOTH vehicle rows
    expect(d.workingExpense).toBe(2000);
    expect(d.other).toBe(300);
    const manualSum = d.investmentPortfolioInterest + d.propertyInterestDeductions + d.propertyDeductions
      + d.propertyDepreciation + d.vehicle + d.socialClub + d.insurance + d.novatedLease + d.workingExpense
      + d.salarySacrifice + d.lumpSumSuperContributions + d.salaryPackaging + d.other;
    expect(d.total).toBeCloseTo(manualSum, 6);
  });
});

describe("taxSums", () => {
  it("Tax on Taxable Income equals plain addition of every row, LITO and franking offset negative", () => {
    const row = mkRow({
      taxDetail: {
        client: { grossTax: 20000, medicare: 1000, lito: 500 },
        partner: { grossTax: 8000, medicare: 400, lito: 200 },
        frankingCredits: 300, div293: 1200, div296: 0,
      },
    });
    const t = taxSums(row);
    expect(t.incomeTax).toBe(28000);
    expect(t.medicareLevy).toBe(1400);
    expect(t.lito).toBe(-700); // negative — reduces tax
    expect(t.frankingCreditOffset).toBe(-300); // negative — reduces tax
    expect(t.div293).toBe(1200);
    expect(t.medicareLevySurcharge).toBe(0);
    expect(t.helpRepayment).toBe(0);
    expect(t.sapto).toBe(0);
    expect(t.spouseSplittingOffset).toBe(0);
    expect(t.taxablePensionOffset).toBe(0);
    // Matches the household net-income-tax identity directly: gross −
    // medicare − lito − franking + div293 + div296.
    expect(t.total).toBeCloseTo(28000 + 1400 - 700 - 300 + 1200 + 0, 6);
  });

  // Pension phase (spec 20, Commit 2/5) — the reserved "Taxable Pension
  // Offset (TTR)" row actually reads the engine's own figure now,
  // rather than a hardcoded 0 — genuinely unreachable end-to-end via a
  // real projection (see deterministic.js's acc[p] header), so wired
  // and tested directly against the row shape here instead.
  it("Taxable Pension Offset (TTR) reads from taxDetail, negative like every other offset, summed across both persons", () => {
    const row = mkRow({
      taxDetail: {
        client: { grossTax: 20000, ttrPensionOffset: 900 },
        partner: { grossTax: 8000, ttrPensionOffset: 150 },
        frankingCredits: 0, div293: 0, div296: 0,
      },
    });
    const t = taxSums(row);
    expect(t.taxablePensionOffset).toBe(-1050);
    // Per-person split reads the SAME field, not the household sum.
    const tClient = taxSums(row, "client");
    expect(tClient.taxablePensionOffset).toBe(-900);
  });
});

describe("cashReceivedSums", () => {
  it("Regular take home pay is salary category cash net of PAYG withheld", () => {
    const row = mkRow({ taxDetail: { client: { paygWithheld: 15000 }, partner: {} } });
    const incomeRows = [{ id: "i1", category: "salary" }];
    const rowTotalsIncome = { i1: [90000] };
    const c = cashReceivedSums(row, { incomeRows, rowTotalsIncome, y: 0 });
    expect(c.regularTakeHomePay).toBe(90000 - 15000);
  });

  // Worked-example validation follow-up: HELP and MLS are withheld
  // through the SAME PAYG mechanism as income tax (deterministic.js's
  // own comment where these are computed) — take-home pay must net
  // off all three, or it overstates what actually lands in the
  // account for anyone with a HELP debt or an MLS liability. Found by
  // reconciling a real firm-produced worked example against the
  // Snapshot view, where the gap was the full $21,815 HELP repayment.
  it("Regular take home pay ALSO nets off HELP withheld, not just income tax", () => {
    const row = mkRow({ taxDetail: { client: { paygWithheld: 15000, helpWithheld: 5000 }, partner: {} } });
    const incomeRows = [{ id: "i1", category: "salary" }];
    const rowTotalsIncome = { i1: [90000] };
    const c = cashReceivedSums(row, { incomeRows, rowTotalsIncome, y: 0 });
    expect(c.regularTakeHomePay).toBe(90000 - 15000 - 5000);
  });

  it("Regular take home pay ALSO nets off MLS withheld", () => {
    const row = mkRow({ taxDetail: { client: { paygWithheld: 15000, mlsWithheld: 1200 }, partner: {} } });
    const incomeRows = [{ id: "i1", category: "salary" }];
    const rowTotalsIncome = { i1: [90000] };
    const c = cashReceivedSums(row, { incomeRows, rowTotalsIncome, y: 0 });
    expect(c.regularTakeHomePay).toBe(90000 - 15000 - 1200);
  });

  it("nets off HELP/MLS withheld for BOTH persons in the household total, and per-person when forOwner is given", () => {
    const row = mkRow({
      taxDetail: {
        client: { paygWithheld: 15000, helpWithheld: 5000, mlsWithheld: 0 },
        partner: { paygWithheld: 8000, helpWithheld: 0, mlsWithheld: 600 },
      },
    });
    const incomeRows = [
      { id: "i1", category: "salary", owner: "client" },
      { id: "i2", category: "salary", owner: "partner" },
    ];
    const rowTotalsIncome = { i1: [90000], i2: [50000] };
    const ctx = { incomeRows, rowTotalsIncome, y: 0 };
    expect(cashReceivedSums(row, ctx, "client").regularTakeHomePay).toBe(90000 - 15000 - 5000);
    expect(cashReceivedSums(row, ctx, "partner").regularTakeHomePay).toBe(50000 - 8000 - 600);
    expect(cashReceivedSums(row, ctx, null).regularTakeHomePay).toBe((90000 + 50000) - (15000 + 5000 + 8000 + 600));
  });

  it("Anticipated tax return is the amount actually settling THIS year (refundSettled)", () => {
    const row = mkRow({ taxDetail: { client: {}, partner: {}, refundSettled: 3793 } });
    const c = cashReceivedSums(row, { y: 0 });
    expect(c.anticipatedTaxReturn).toBe(3793);
  });

  it("After tax bonus and Other tax-free income aggregate their own categories and the total sums all four", () => {
    const row = mkRow();
    const incomeRows = [
      { id: "i1", category: "afterTaxBonus" }, { id: "i2", category: "otherTaxFreeIncome" },
    ];
    const rowTotalsIncome = { i1: [5000], i2: [1200] };
    const c = cashReceivedSums(row, { incomeRows, rowTotalsIncome, y: 0 });
    expect(c.afterTaxBonus).toBe(5000);
    expect(c.otherTaxFreeIncome).toBe(1200);
    expect(c.total).toBeCloseTo(c.regularTakeHomePay + c.anticipatedTaxReturn + 5000 + 1200, 6);
  });
});

describe("expenseSums", () => {
  it("land tax (spec 19 Commit 2) is a cash outflow for BOTH investment and holiday properties, split by owner share; PPR is excluded", () => {
    const row = mkRow({ properties: { p1: { landTax: 1000 }, p2: { landTax: 500 }, p3: { landTax: 99 } } });
    const properties = [
      { id: "p1", propertyType: "investment", owner: "client" },
      { id: "p2", propertyType: "holiday", owner: "client" },
      { id: "p3", propertyType: "ppr", owner: "client" },
    ];
    const e = expenseSums(row, { properties, y: 0 });
    expect(e.landTax).toBe(1500); // p1 + p2, NOT p3 (PPR is exempt, and never even assessed)
  });

  it("mortgage repayments reconcile to a property-linked liability's own interest+principal exactly", () => {
    const row = mkRow({ liabilities: { "prop-p1": { interest: 9000, principal: 4000 } } });
    const properties = [{ id: "p1", propertyType: "investment" }];
    const e = expenseSums(row, { properties, y: 0 });
    expect(e.mortgageRepayments).toBe(13000);
    expect(e.otherLoanRepayments).toBe(0);
  });

  it("a standalone liability's service is Other Loan Repayments, never Mortgage Repayments", () => {
    const row = mkRow({ liabilities: { car1: { interest: 200, principal: 800 } } });
    const e = expenseSums(row, { properties: [], y: 0 });
    expect(e.otherLoanRepayments).toBe(1000);
    expect(e.mortgageRepayments).toBe(0);
  });

  it("HELP-as-liability follow-up fix: a help_<person> entry contributes NOTHING here — its repayment is already the Tax section's own helpRepayment line (taxSums), so counting it again as Other Loan Repayments would double it", () => {
    const row = mkRow({ liabilities: { help_client: { interest: 0, principal: 4570.80, opening: 50000, closing: 45429.20, indexation: 0 } } });
    const e = expenseSums(row, { properties: [], liabilities: [], y: 0 });
    expect(e.otherLoanRepayments).toBe(0);
    expect(e.mortgageRepayments).toBe(0);
    expect(e.total).toBe(0);
  });

  it("investment property expenses reconcile to the property module directly", () => {
    const row = mkRow({ properties: { p1: { expenses: 4200 } } });
    const properties = [{ id: "p1", propertyType: "investment" }];
    const e = expenseSums(row, { properties, y: 0 });
    expect(e.investmentPropertyExpenses).toBe(4200);
  });

  it("category rows aggregate and Total Expenses sums every field", () => {
    const row = mkRow();
    const expenseRows = [
      { id: "e1", category: "discretionary" }, { id: "e2", category: "discretionary" },
      { id: "e3", category: "groceryFuel" },
    ];
    const rowTotalsExpenses = { e1: [500], e2: [700], e3: [900] };
    const e = expenseSums(row, { expenseRows, rowTotalsExpenses, y: 0 });
    expect(e.discretionary).toBe(1200);
    expect(e.groceryFuel).toBe(900);
    const manualSum = e.mortgageRepayments + e.otherLoanRepayments + e.nonDiscretionary + e.discretionary
      + e.groceryFuel + e.holidays + e.insurance + e.investmentPropertyExpenses + e.homeMaintenance + e.other;
    expect(e.total).toBeCloseTo(manualSum, 6);
  });
});

describe("cashflowStatement — integration against a real projectPlan run", () => {
  it("every identity holds against real engine output, with a property, a loan, and a deduction", () => {
    const state = {
      plan: {
        household: "single",
        client: { currentAge: 40 },
        partner: null,
        endAge: 40,
        start: { year: 2026, month: 7 },
        workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 }, // 0% real — no interest noise
      },
      assets: [],
      cashflows: {
        income: [{
          id: "i1", label: "Salary", owner: "client", amount: 120000, frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
          indexBasis: "cpi", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
        }],
        expenses: [{
          id: "e1", label: "Groceries", category: "groceryFuel", amount: 500, frequency: "monthly",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "cpi", indexExtraPct: 0,
        }],
        deductions: [{
          id: "d1", label: "Working Expense", owner: "client", category: "workingExpense", amount: 2000,
          frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
          indexBasis: "cpi", indexExtraPct: 0,
        }],
        contributions: [], withdrawals: [], lumpSums: [],
      },
      liabilities: [],
      properties: [{
        id: "p1", name: "Unit", owner: "client", state: "NSW", propertyType: "investment", status: "owned",
        currentValue: 500000, acquisitionDate: "2020-01-01", costBase: 400000,
        priceToday: 0, purchaseAt: { kind: "age", age: 40 }, lvrPct: 0,
        firstHomeBuyer: false, newBuild: false, purchaseCostsPct: 2, dutyOverride: null, growthPct: 0,
        rent: { amount: 20000, indexBasis: "cpi", indexExtraPct: 0 },
        expenses: { amount: 3000, indexBasis: "cpi", indexExtraPct: 0 },
        expensesDeductible: true, depreciation: 5000,
      }],
      settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: [] },
      display: { units: "real" },
      assumptions: { cpi: 0.025, awote: 0.035, mortgageRate: 0.06, bracketMode: "indexed" },
    };
    const out = projectPlan(state);
    const row = out.yearly[0];
    const ctx = {
      incomeRows: state.cashflows.income, rowTotalsIncome: out.schedule.rowTotals.income,
      expenseRows: state.cashflows.expenses, rowTotalsExpenses: out.schedule.rowTotals.expenses,
      deductionRows: state.cashflows.deductions, rowTotalsDeductions: out.schedule.rowTotals.deductions,
      properties: state.properties, liabilities: state.liabilities, superAccounts: [], y: 0,
    };
    const s = cashflowStatement(row, ctx);

    expect(s.assessable.salary).toBeCloseTo(120000, 2);
    expect(s.assessable.propertyIncomeGross).toBeCloseTo(20000, 2);
    expect(s.deductions.workingExpense).toBeCloseTo(2000, 2);
    expect(s.deductions.propertyDeductions).toBeCloseTo(3000, 2);
    expect(s.deductions.propertyDepreciation).toBeCloseTo(5000, 2);
    expect(s.expenses.investmentPropertyExpenses).toBeCloseTo(3000, 2);
    expect(s.expenses.groceryFuel).toBeCloseTo(6000, 2); // $500/mo × 12

    // The four identities, verified against the same real row.
    expect(s.taxableIncome).toBeCloseTo(s.assessable.total - s.deductions.total, 4);
    expect(s.netIncome).toBeCloseTo(s.taxableIncome - s.tax.total, 4);
    expect(s.surplusIncome).toBeCloseTo(s.cashReceived.total - s.expenses.total, 4);
    // Tax on Taxable Income reconciles to the engine's own household
    // net-income-tax + Div293 + Div296 (the same identity the pure
    // unit tests assert algebraically, now checked against real
    // assessPerson output rather than a hand-built fixture).
    expect(s.tax.total).toBeCloseTo(row.taxDetail.incomeTax + row.taxDetail.div293 + row.taxDetail.div296, 4);
  });
});

describe("cashflowStatement — the four running subtotals", () => {
  it("Taxable Income = Assessable Income − Deductions", () => {
    const row = mkRow();
    const incomeRows = [{ id: "i1", category: "salary" }];
    const rowTotalsIncome = { i1: [100000] };
    const deductionRows = [{ id: "d1", category: "workingExpense" }];
    const rowTotalsDeductions = { d1: [4000] };
    const s = cashflowStatement(row, { incomeRows, rowTotalsIncome, deductionRows, rowTotalsDeductions, y: 0 });
    expect(s.assessable.total).toBe(100000);
    expect(s.deductions.total).toBe(4000);
    expect(s.taxableIncome).toBe(96000);
  });

  it("NET INCOME = Taxable Income − Tax on Taxable Income", () => {
    const row = mkRow({
      taxDetail: { client: { grossTax: 20000, medicare: 1000, lito: 0 }, partner: {}, frankingCredits: 0, div293: 0, div296: 0 },
    });
    const incomeRows = [{ id: "i1", category: "salary" }];
    const rowTotalsIncome = { i1: [100000] };
    const s = cashflowStatement(row, { incomeRows, rowTotalsIncome, y: 0 });
    expect(s.tax.total).toBe(21000);
    expect(s.netIncome).toBeCloseTo(s.taxableIncome - 21000, 6);
  });

  it("SURPLUS INCOME = Cash received − Total Expenses", () => {
    const row = mkRow({ liabilities: { car1: { interest: 200, principal: 800 } } });
    const incomeRows = [{ id: "i1", category: "salary" }];
    const rowTotalsIncome = { i1: [50000] };
    const expenseRows = [{ id: "e1", category: "discretionary" }];
    const rowTotalsExpenses = { e1: [3000] };
    const s = cashflowStatement(row, { incomeRows, rowTotalsIncome, expenseRows, rowTotalsExpenses, y: 0 });
    expect(s.surplusIncome).toBeCloseTo(s.cashReceived.total - s.expenses.total, 6);
  });

  it("a scenario with nothing entered still computes cleanly to all zeros, never throws", () => {
    const row = mkRow();
    expect(() => cashflowStatement(row, {})).not.toThrow();
    const s = cashflowStatement(row, {});
    expect(s.assessable.total).toBe(0);
    expect(s.deductions.total).toBe(0);
    expect(s.taxableIncome).toBe(0);
    expect(s.tax.total).toBe(0);
    expect(s.netIncome).toBe(0);
    expect(s.cashReceived.total).toBe(0);
    expect(s.expenses.total).toBe(0);
    expect(s.surplusIncome).toBe(0);
  });
});

describe("per-owner breakdown (Document Set Commit 7 — Snapshot view)", () => {
  it("Client + Partner reconciles to Total on assessableIncome: owned income rows, a joint property, and the household-only WCA/distribution split", () => {
    const row = mkRow({
      wcaDetail: { interest: 100 }, // no per-person attribution — 50/50
      cashDistributions: 400, // pooled across assets — 50/50
      properties: { p1: { rent: 6000 } }, // joint property — 50/50
      taxDetail: {
        client: { frankingCredits: 120, netCapitalGain: 500 },
        partner: { frankingCredits: 80, netCapitalGain: 300 },
        frankingCredits: 200, netCapitalGain: 800,
      },
    });
    const incomeRows = [
      { id: "i1", category: "salary", owner: "client" },
      { id: "i2", category: "salary", owner: "partner" },
    ];
    const rowTotalsIncome = { i1: [90000], i2: [60000] };
    const properties = [{ id: "p1", propertyType: "investment", owner: "joint" }];
    const ctx = { incomeRows, rowTotalsIncome, properties, y: 0 };
    const client = assessableIncome(row, ctx, "client");
    const partner = assessableIncome(row, ctx, "partner");
    const total = assessableIncome(row, ctx, null);
    expect(client.salary).toBe(90000);
    expect(partner.salary).toBe(60000);
    expect(client.propertyIncomeGross).toBeCloseTo(3000, 6); // 50% of the joint property's rent
    expect(partner.propertyIncomeGross).toBeCloseTo(3000, 6);
    expect(client.interestIncome + partner.interestIncome).toBeCloseTo(total.interestIncome, 6);
    expect(client.dividendIncome + partner.dividendIncome).toBeCloseTo(total.dividendIncome, 6);
    expect(client.total + partner.total).toBeCloseTo(total.total, 6);
  });

  it("Client + Partner reconciles to Total on taxSums, reading the per-person taxDetail already computed by the engine", () => {
    const row = mkRow({
      taxDetail: {
        client: { grossTax: 15000, medicare: 500, lito: 200, helpRepayment: 1000, medicareLevySurcharge: 0, div293: 0, div296: 0 },
        partner: { grossTax: 8000, medicare: 300, lito: 0, helpRepayment: 0, medicareLevySurcharge: 400, div293: 100, div296: 0 },
        frankingCredits: 0, helpRepayment: 1000, medicareLevySurcharge: 400, div293: 100, div296: 0,
      },
    });
    const client = taxSums(row, "client");
    const partner = taxSums(row, "partner");
    const total = taxSums(row, null);
    expect(client.total + partner.total).toBeCloseTo(total.total, 6);
    expect(client.helpRepayment).toBe(1000);
    expect(partner.medicareLevySurcharge).toBe(400);
  });

  it("Client + Partner reconciles to Total on deductionSums and expenseSums for a joint liability", () => {
    const row = mkRow({ liabilities: { lb1: { interest: 4000, principal: 2000 } } });
    const liabilities = [{ id: "lb1", owner: "joint", deductible: true }];
    const deductionRows = [];
    const rowTotalsDeductions = {};
    const expenseRows = [{ id: "e1", category: "discretionary", owner: "client" }];
    const rowTotalsExpenses = { e1: [5000] };
    const dCtx = { deductionRows, rowTotalsDeductions, liabilities, y: 0 };
    const eCtx = { expenseRows, rowTotalsExpenses, liabilities, y: 0 };
    const dClient = deductionSums(row, dCtx, "client");
    const dPartner = deductionSums(row, dCtx, "partner");
    const dTotal = deductionSums(row, dCtx, null);
    expect(dClient.investmentPortfolioInterest).toBeCloseTo(2000, 6); // 50% of the joint loan's interest
    expect(dClient.total + dPartner.total).toBeCloseTo(dTotal.total, 6);
    const eClient = expenseSums(row, eCtx, "client");
    const ePartner = expenseSums(row, eCtx, "partner");
    const eTotal = expenseSums(row, eCtx, null);
    expect(eClient.discretionary).toBe(5000);
    expect(ePartner.discretionary).toBe(0);
    expect(eClient.total + ePartner.total).toBeCloseTo(eTotal.total, 6);
  });

  it("HELP-as-liability follow-up fix: a help_client balance doesn't break the Client + Partner = Total identity on deductionSums/expenseSums — it isn't owner-attributed via shareOf at all (undefined itemOwner), so a naive read would silently count it once for Total (shareOf(undefined,null)=1) but zero for either named owner (shareOf(undefined,'client'|'partner')=0), breaking reconciliation", () => {
    const row = mkRow({ liabilities: { help_client: { interest: 0, principal: 4570.80 } } });
    const liabilities = [];
    const dCtx = { liabilities, y: 0 };
    const eCtx = { liabilities, y: 0 };
    const dClient = deductionSums(row, dCtx, "client");
    const dPartner = deductionSums(row, dCtx, "partner");
    const dTotal = deductionSums(row, dCtx, null);
    expect(dClient.total + dPartner.total).toBeCloseTo(dTotal.total, 6);
    expect(dTotal.investmentPortfolioInterest).toBe(0);
    const eClient = expenseSums(row, eCtx, "client");
    const ePartner = expenseSums(row, eCtx, "partner");
    const eTotal = expenseSums(row, eCtx, null);
    expect(eClient.total + ePartner.total).toBeCloseTo(eTotal.total, 6);
    expect(eTotal.otherLoanRepayments).toBe(0); // already counted once via taxSums().helpRepayment — see isHelpLiability
  });

  it("Client + Partner reconciles to Total on cashReceivedSums", () => {
    const row = mkRow({
      taxDetail: {
        client: { paygWithheld: 10000, refundSettled: 500 },
        partner: { paygWithheld: 4000, refundSettled: -200 },
        refundSettled: 300,
      },
    });
    const incomeRows = [
      { id: "i1", category: "salary", owner: "client" },
      { id: "i2", category: "salary", owner: "partner" },
    ];
    const rowTotalsIncome = { i1: [90000], i2: [50000] };
    const ctx = { incomeRows, rowTotalsIncome, y: 0 };
    const client = cashReceivedSums(row, ctx, "client");
    const partner = cashReceivedSums(row, ctx, "partner");
    const total = cashReceivedSums(row, ctx, null);
    expect(client.total + partner.total).toBeCloseTo(total.total, 6);
  });

  it("the full cashflowStatement() per-owner breakdown reconciles Client + Partner = Total, end to end", () => {
    const row = mkRow({
      wcaDetail: { interest: 50 },
      cashDistributions: 100,
      properties: { p1: { rent: 4000, expenses: 500, depreciation: 200 } },
      liabilities: { lb1: { interest: 1000, principal: 500 } },
      taxDetail: {
        client: { grossTax: 12000, medicare: 400, lito: 0, paygWithheld: 9000, refundSettled: 100, frankingCredits: 50, netCapitalGain: 0 },
        partner: { grossTax: 5000, medicare: 200, lito: 0, paygWithheld: 3000, refundSettled: 0, frankingCredits: 30, netCapitalGain: 0 },
        frankingCredits: 80, netCapitalGain: 0, refundSettled: 100,
      },
    });
    const incomeRows = [
      { id: "i1", category: "salary", owner: "client" },
      { id: "i2", category: "salary", owner: "partner" },
    ];
    const rowTotalsIncome = { i1: [80000], i2: [40000] };
    const expenseRows = [{ id: "e1", category: "discretionary", owner: "partner" }];
    const rowTotalsExpenses = { e1: [2000] };
    const properties = [{ id: "p1", propertyType: "investment", owner: "joint" }];
    const liabilities = [{ id: "lb1", owner: "client", deductible: false }];
    const ctx = { incomeRows, rowTotalsIncome, expenseRows, rowTotalsExpenses, properties, liabilities, y: 0 };
    const client = cashflowStatement(row, ctx, "client");
    const partner = cashflowStatement(row, ctx, "partner");
    const total = cashflowStatement(row, ctx, null);
    expect(client.assessable.total + partner.assessable.total).toBeCloseTo(total.assessable.total, 6);
    expect(client.deductions.total + partner.deductions.total).toBeCloseTo(total.deductions.total, 6);
    expect(client.tax.total + partner.tax.total).toBeCloseTo(total.tax.total, 6);
    expect(client.cashReceived.total + partner.cashReceived.total).toBeCloseTo(total.cashReceived.total, 6);
    expect(client.expenses.total + partner.expenses.total).toBeCloseTo(total.expenses.total, 6);
    expect(client.netIncome + partner.netIncome).toBeCloseTo(total.netIncome, 6);
    expect(client.surplusIncome + partner.surplusIncome).toBeCloseTo(total.surplusIncome, 6);
  });

  it("regression gate: omitting forOwner (every pre-Commit-7 call site) is identical to explicit null", () => {
    const row = mkRow({
      properties: { p1: { rent: 1000 } },
      liabilities: { lb1: { interest: 100, principal: 50 } },
    });
    const properties = [{ id: "p1", propertyType: "investment", owner: "joint" }];
    const liabilities = [{ id: "lb1", owner: "joint", deductible: true }];
    const incomeRows = [{ id: "i1", category: "salary", owner: "client" }];
    const rowTotalsIncome = { i1: [50000] };
    const ctx = { incomeRows, rowTotalsIncome, properties, liabilities, y: 0 };
    expect(cashflowStatement(row, ctx)).toEqual(cashflowStatement(row, ctx, null));
  });
});

// Adjustment rows (spec 18, Commit 2) — the Cashflow/Snapshot section
// totals are an independent re-derivation from rowTotals/taxDetail, not
// a read of the engine's own (already-adjusted) row.income/expenses/tax
// — each of these functions must separately fold row.adjustments in, or
// the table's own totals would silently disagree with the real
// projection. adjustmentAtYear() shape (deterministic.js) is just
// {target, owner, amount, ...}.
function adj(over = {}) {
  return { id: "a1", target: "expenses", owner: "household", amount: 100, label: "Test", note: "", superAccountId: null, ...over };
}

describe("Adjustment rows (spec 18, Commit 2) — folded into section totals", () => {
  it("income.assessable folds into assessableIncome's total as adjAssessable", () => {
    const row = mkRow({ adjustments: [adj({ target: "income.assessable", owner: "client", amount: 5000 })] });
    const a = assessableIncome(row, { y: 0 });
    expect(a.adjAssessable).toBe(5000);
    expect(a.total).toBe(5000);
  });

  it("income.nonTaxable folds into cashReceivedSums' otherTaxFreeIncome, not a separate line", () => {
    const row = mkRow({ adjustments: [adj({ target: "income.nonTaxable", owner: "client", amount: 800 })] });
    const c = cashReceivedSums(row, { y: 0 });
    expect(c.otherTaxFreeIncome).toBe(800);
    expect(c.adjNonTaxable).toBe(800);
  });

  it("deductions folds into deductionSums' total as adjDeductions", () => {
    const row = mkRow({ adjustments: [adj({ target: "deductions", owner: "partner", amount: 1200 })] });
    const d = deductionSums(row, { y: 0 });
    expect(d.adjDeductions).toBe(1200);
    expect(d.total).toBe(1200);
  });

  it("expenses is household-owned and splits 50/50 for a per-person view, in full for household", () => {
    const row = mkRow({ adjustments: [adj({ target: "expenses", amount: 400 })] });
    expect(expenseSums(row, { y: 0 }, "client").adjExpenses).toBe(200);
    expect(expenseSums(row, { y: 0 }, "partner").adjExpenses).toBe(200);
    expect(expenseSums(row, { y: 0 }, null).adjExpenses).toBe(400);
  });

  it("tax.incomeTax, tax.medicare, tax.help each fold into their own taxSums line", () => {
    const row = mkRow({
      adjustments: [
        adj({ target: "tax.incomeTax", owner: "client", amount: 2000 }),
        adj({ target: "tax.medicare", owner: "client", amount: 300 }),
        adj({ target: "tax.help", owner: "client", amount: 150 }),
      ],
    });
    const t = taxSums(row, "client");
    expect(t.incomeTaxAdjustment).toBe(2000);
    expect(t.medicareAdjustment).toBe(300);
    expect(t.helpAdjustment).toBe(150);
    expect(t.incomeTax).toBe(2000); // client.grossTax defaults to 0 in mkRow
    expect(t.medicareLevy).toBe(300);
    expect(t.helpRepayment).toBe(150);
  });

  it("tax.cgt folds into taxSums' incomeTax line (no dedicated CGT line in this vocabulary) but is exposed separately as cgtAdjustment", () => {
    const row = mkRow({ adjustments: [adj({ target: "tax.cgt", owner: "client", amount: 900 })] });
    const t = taxSums(row, "client");
    expect(t.cgtAdjustment).toBe(900);
    expect(t.incomeTax).toBe(900);
  });

  it("an adjustment for a DIFFERENT target/owner does not leak into an unrelated total", () => {
    const row = mkRow({ adjustments: [adj({ target: "expenses", amount: 999 })] });
    expect(assessableIncome(row, { y: 0 }).total).toBe(0);
    expect(deductionSums(row, { y: 0 }).total).toBe(0);
    expect(cashReceivedSums(row, { y: 0 }).total).toBe(0);
    expect(taxSums(row).total).toBe(0);
  });
});
