import { describe, it, expect } from "vitest";
import {
  salarySacrificeCash,
  personalSuperContributionsCash,
  incomeCategorySums,
  expenseCategorySums,
} from "./cashflowCategories.js";

function mkRow(over = {}) {
  return {
    superDetail: {},
    properties: {},
    liabilities: {},
    cashDistributions: 0,
    wcaDetail: { interest: 0 },
    tax: 0,
    ...over,
  };
}

describe("salarySacrificeCash", () => {
  it("sums the salarySacrifice component across every super account", () => {
    const row = mkRow({
      superDetail: {
        su1: { salarySacrifice: 5000, personalDeductible: 0, nonConcessional: 0 },
        su2: { salarySacrifice: 2000, personalDeductible: 0, nonConcessional: 0 },
      },
    });
    expect(salarySacrificeCash(row, [{ id: "su1" }, { id: "su2" }])).toBeCloseTo(7000, 6);
  });

  it("ignores accounts with no detail for the year and defaults to 0 with no accounts", () => {
    const row = mkRow({ superDetail: { su1: { salarySacrifice: 1000, personalDeductible: 0, nonConcessional: 0 } } });
    expect(salarySacrificeCash(row, [{ id: "su1" }, { id: "su2" }])).toBeCloseTo(1000, 6);
    expect(salarySacrificeCash(row, [])).toBe(0);
    expect(salarySacrificeCash(row, undefined)).toBe(0);
  });
});

describe("personalSuperContributionsCash", () => {
  it("sums personal deductible + non-concessional, and EXCLUDES salary sacrifice", () => {
    const row = mkRow({
      superDetail: { su1: { salarySacrifice: 5000, personalDeductible: 3000, nonConcessional: 1000 } },
    });
    // The engine-correctness fix's core read-side assertion: sacrifice is
    // already reflected in reduced income, so it must never also appear
    // as a "household paid for this" expense category, or it is
    // double-counted (the original defect, mirrored on the display side).
    expect(personalSuperContributionsCash(row, [{ id: "su1" }])).toBeCloseTo(4000, 6);
  });
});

describe("incomeCategorySums", () => {
  it("employment is GROSS row totals minus salary sacrifice — reconciling with the engine's net-of-sacrifice income", () => {
    const row = mkRow({
      superDetail: { su1: { salarySacrifice: 5000, personalDeductible: 0, nonConcessional: 0 } },
      cashDistributions: 200,
      wcaDetail: { interest: 50 },
    });
    const incomeRows = [{ id: "i1", incomeType: "employment" }];
    // rowTotals is captured BEFORE the sacrifice reduction (schedule.js) —
    // it is the gross salary, exactly like the Cashflow table's own row.
    const rowTotalsIncome = { i1: [50000] };
    const sums = incomeCategorySums(row, incomeRows, rowTotalsIncome, [], {}, [], [{ id: "su1" }], 0);
    expect(sums.employment).toBeCloseTo(45000, 6); // 50,000 gross − 5,000 sacrificed
    expect(sums.rental).toBe(0);
    expect(sums.investment).toBeCloseTo(200, 6);
    expect(sums.wcaInterest).toBeCloseTo(50, 6);
    expect(sums.other).toBe(0);
  });

  it("rolls up rental income including investment property rent, and one-off inflows into 'other'", () => {
    const row = mkRow({ properties: { p1: { rent: 12000 } } });
    const incomeRows = [
      { id: "i1", incomeType: "rental" },
      { id: "i2", incomeType: "otherTaxable" },
    ];
    const rowTotalsIncome = { i1: [3000], i2: [500] };
    const properties = [{ id: "p1", propertyType: "investment" }];
    const oneOffsByAssetYear = { a1: [1000] };
    const sums = incomeCategorySums(row, incomeRows, rowTotalsIncome, properties, oneOffsByAssetYear, ["a1"], [], 0);
    expect(sums.rental).toBeCloseTo(3000 + 12000, 6);
    expect(sums.other).toBeCloseTo(500 + 1000, 6);
  });
});

describe("expenseCategorySums", () => {
  it("superContributions is personal deductible + non-concessional only — salary sacrifice never appears as a household expense", () => {
    const row = mkRow({
      superDetail: { su1: { salarySacrifice: 5000, personalDeductible: 3000, nonConcessional: 0 } },
      liabilities: { l1: { interest: 400, principal: 600 } },
      tax: 8000,
    });
    const expenseRows = [{ id: "e1" }];
    const rowTotalsExpenses = { e1: [10000] };
    const sums = expenseCategorySums(row, expenseRows, rowTotalsExpenses, [], {}, [], [{ id: "su1" }], 0);
    expect(sums.living).toBeCloseTo(10000, 6);
    expect(sums.investmentExpenses).toBe(0);
    expect(sums.loanInterest).toBeCloseTo(400, 6);
    expect(sums.loanPrincipal).toBeCloseTo(600, 6);
    expect(sums.tax).toBeCloseTo(8000, 6);
    expect(sums.superContributions).toBeCloseTo(3000, 6); // NOT 8000 (which would include the sacrifice)
  });

  it("folds one-off outflows and a planned property's settlement into investment/property expenses", () => {
    const row = mkRow({ properties: { p1: { expenses: 2000, settlement: 50000 } } });
    const properties = [
      { id: "p1", propertyType: "investment", status: "planned" },
    ];
    const oneOffsByAssetYear = { a1: [-1500] };
    const sums = expenseCategorySums(row, [], {}, properties, oneOffsByAssetYear, ["a1"], [], 0);
    expect(sums.investmentExpenses).toBeCloseTo(2000 + 1500 + 50000, 6);
  });

  it("a scenario with no super accounts reports zero super contributions and never throws", () => {
    const row = mkRow();
    expect(() => expenseCategorySums(row, [], {}, [], {}, [], undefined, 0)).not.toThrow();
    expect(expenseCategorySums(row, [], {}, [], {}, [], undefined, 0).superContributions).toBe(0);
  });
});
