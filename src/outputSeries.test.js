import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { defaultChartTreatment } from "./planState.js";
import {
  compositeSeries, compositeExpenditure, compositeIncome, compositeDrawdown,
} from "./outputSeries.js";

// A scenario with a liability AND both a PPR and an investment
// property, so every composite-series branch is exercised.
function scenarioWithLiabilitiesAndProperty() {
  const asset = {
    id: "a1", name: "Portfolio", class: "financial", include: true, owner: "client",
    distributions: "reinvest", balance: 500000,
    allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
  };
  const lifestyle = {
    id: "car", name: "Vehicles", class: "lifestyle", include: true, owner: "client",
    balance: 40000, growthPct: 0,
  };
  const ppr = {
    id: "home", name: "Home", owner: "client", state: "NSW", propertyType: "ppr", status: "owned",
    currentValue: 900000, acquisitionDate: "2015-01-01", costBase: 0, priceToday: 0,
    purchaseAge: 40, lvrPct: 0, firstHomeBuyer: false, newBuild: false, purchaseCostsPct: 2,
    dutyOverride: null, growthPct: 2.5,
    rent: { amount: 0, indexBasis: "cpi", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "cpi", indexExtraPct: 0 }, expensesDeductible: true,
  };
  const invest = {
    ...ppr, id: "unit", name: "Investment unit", propertyType: "investment", currentValue: 400000,
    rent: { amount: 20000, indexBasis: "cpi", indexExtraPct: 0 },
    expenses: { amount: 3000, indexBasis: "cpi", indexExtraPct: 0 },
  };
  const liability = {
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 300000, interestRatePct: 6, termYears: 25, repayment: "pi", ioYears: 5,
    deductible: false, linkedAssetId: "home", offsetAssetId: null,
  };
  const state = {
    plan: {
      household: "single",
      client: { currentAge: 40, taxProfile: { residency: "resident", medicareExempt: false, centrelinkEligible: false, openingCapitalLosses: 0 } },
      partner: null,
      endAge: 45,
      endBasis: { mode: "fixedAge", offset: 0, fixedAge: 45, fixedYears: 40 },
      start: { year: 2026, month: 7 },
    },
    assets: [asset, lifestyle],
    properties: [ppr, invest],
    liabilities: [liability],
    cashflows: {
      income: [{ id: "sal", label: "Salary", owner: "client", amount: 100000, frequency: "annual", fromAge: 40, toAge: 45, indexBasis: "cpi", indexExtraPct: 0 }],
      expenses: [{ id: "liv", label: "Living", amount: 40000, frequency: "annual", fromAge: 40, toAge: 45, indexBasis: "cpi", indexExtraPct: 0 }],
      contributions: [], withdrawals: [], lumpSums: [],
    },
    settings: { surplus: { mode: "spend", assetId: null }, fundingOrder: ["a1"] },
    assumptions: { cpi: 0.025, awote: 0.035, mortgageRate: 0.06, bracketMode: "indexed" },
    display: { units: "real" },
  };
  return state;
}

describe("compositeExpenditure / compositeIncome / compositeDrawdown", () => {
  it("reconcile to the engine's yearly ledger for every year", () => {
    const state = scenarioWithLiabilitiesAndProperty();
    const out = projectPlan(state);
    for (const row of out.yearly) {
      const loanService = Object.values(row.liabilities).reduce((s, l) => s + l.interest + l.principal, 0);
      expect(compositeExpenditure(row)).toBeCloseTo(row.expenses + row.tax + loanService, 8);
      expect(compositeIncome(row)).toBe(row.income);
      expect(compositeDrawdown(row)).toBeCloseTo(row.withdrawals + row.deficitFundedFromAssets, 8);
      // The liability actually generated nonzero interest/principal
      // this scenario — a real reconciliation, not a vacuous 0=0 check.
      expect(loanService).toBeGreaterThan(0);
    }
  });
});

describe("compositeSeries — net assets under display treatment", () => {
  it("default treatment (PPR + lifestyle separate) still sums back to the engine's netAssets", () => {
    const state = scenarioWithLiabilitiesAndProperty();
    const out = projectPlan(state);
    const series = compositeSeries(out.yearly, state.assets, state.properties, defaultChartTreatment());
    out.yearly.forEach((row, y) => {
      expect(series.netAssetsArea[y] + series.separateArea[y]).toBeCloseTo(row.netAssets, 6);
    });
    // Default separates PPR + lifestyle out of the main area.
    const y0 = out.yearly[0];
    const expectedSeparate = (y0.perAssetClosing.car ?? 0) + (y0.properties.home?.value ?? 0);
    expect(series.separateArea[0]).toBeCloseTo(expectedSeparate, 4);
  });

  it("'include' folds everything back into the main net-assets area", () => {
    const state = scenarioWithLiabilitiesAndProperty();
    const out = projectPlan(state);
    const allInclude = { pprProperty: "include", otherProperty: "include", lifestyle: "include", liabilities: "include" };
    const series = compositeSeries(out.yearly, state.assets, state.properties, allInclude);
    out.yearly.forEach((row, y) => {
      expect(series.netAssetsArea[y]).toBeCloseTo(row.netAssets, 6);
      expect(series.separateArea[y]).toBe(0);
    });
  });

  it("'exclude' drops a class from both areas entirely", () => {
    const state = scenarioWithLiabilitiesAndProperty();
    const out = projectPlan(state);
    const excludeLifestyle = { ...defaultChartTreatment(), lifestyle: "exclude" };
    const series = compositeSeries(out.yearly, state.assets, state.properties, excludeLifestyle);
    const y0 = out.yearly[0];
    const lifestyleVal = y0.perAssetClosing.car ?? 0;
    expect(series.netAssetsArea[0] + series.separateArea[0]).toBeCloseTo(y0.netAssets - lifestyleVal, 4);
  });

  it("excluding liabilities adds the debt back rather than subtracting it", () => {
    const state = scenarioWithLiabilitiesAndProperty();
    const out = projectPlan(state);
    const withDebt = compositeSeries(out.yearly, state.assets, state.properties, defaultChartTreatment());
    const noDebt = compositeSeries(out.yearly, state.assets, state.properties,
      { ...defaultChartTreatment(), liabilities: "exclude" });
    out.yearly.forEach((row, y) => {
      const diff = (noDebt.netAssetsArea[y] + noDebt.separateArea[y]) - (withDebt.netAssetsArea[y] + withDebt.separateArea[y]);
      expect(diff).toBeCloseTo(row.liabilitiesClosing, 4);
    });
  });

  it("display treatment never touches the underlying ledger rows (tables stay byte-identical)", () => {
    const state = scenarioWithLiabilitiesAndProperty();
    const out = projectPlan(state);
    const before = JSON.parse(JSON.stringify(out.yearly));
    compositeSeries(out.yearly, state.assets, state.properties, { pprProperty: "exclude", otherProperty: "exclude", lifestyle: "exclude", liabilities: "exclude" });
    expect(out.yearly).toEqual(before);
  });
});
