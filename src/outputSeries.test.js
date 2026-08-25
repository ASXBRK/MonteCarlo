import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { defaultChartTreatment } from "./planState.js";
import {
  compositeSeries, compositeExpenditure, compositeIncome, compositeDrawdown, compositeAgePension,
  sharedZeroRanges, seriesIsAllZero, axisTickVals,
} from "./outputSeries.js";

const zeroFractionOfRange = ([min, max]) => -min / (max - min);

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
    purchaseAt: { kind: "age", age: 40 }, lvrPct: 0, firstHomeBuyer: false, newBuild: false, purchaseCostsPct: 2,
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
      income: [{ id: "sal", label: "Salary", owner: "client", amount: 100000, frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 45 }, indexBasis: "cpi", indexExtraPct: 0 }],
      expenses: [{ id: "liv", label: "Living", amount: 40000, frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 45 }, indexBasis: "cpi", indexExtraPct: 0 }],
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

  // Age pension (spec 21a, Commit 4) — joins the composite chart as its
  // own band: compositeIncome() no longer includes the entitlement
  // (row.income does, since deterministic.js credits it there), but
  // income + compositeAgePension() must still sum back to row.income
  // exactly — no double-count, no dropped dollar.
  it("compositeAgePension pulls the entitlement out of compositeIncome without losing it", () => {
    const row = { income: 50000, agePensionDetail: { entitlement: 12000 } };
    expect(compositeAgePension(row)).toBe(12000);
    expect(compositeIncome(row)).toBe(38000);
    expect(compositeIncome(row) + compositeAgePension(row)).toBe(row.income);
  });

  it("compositeAgePension is 0 with no agePensionDetail on the row (pre-spec-21a rows)", () => {
    const row = { income: 50000 };
    expect(compositeAgePension(row)).toBe(0);
    expect(compositeIncome(row)).toBe(50000);
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

describe("sharedZeroRanges — shared zero baseline across both y-axes", () => {
  it("negative-left/positive-right: both axes place zero at the same (unclamped) fraction", () => {
    // Left crosses zero (mortgage-era negative net assets through to a
    // positive balance later) — its natural zero fraction sits well
    // inside [0.05, 0.95], so it passes through unclamped.
    const left = [-100, 50, 200];
    const right = [0, 300, 600];
    const { leftRange, rightRange, zeroFraction } = sharedZeroRanges(left, right);
    expect(zeroFractionOfRange(leftRange)).toBeCloseTo(zeroFraction, 10);
    expect(zeroFractionOfRange(rightRange)).toBeCloseTo(zeroFraction, 10);
    // Expand-only: the right axis's top must not be cut below its own
    // padded data max.
    const rawRightMax = 600 * 1.05;
    expect(rightRange[1]).toBeCloseTo(rawRightMax, 6);
  });

  it("all-positive case: the fraction clamps to the 0.05 floor and BOTH axes are rescaled to it", () => {
    const left = [100, 200, 300];
    const right = [50, 80, 120];
    const { leftRange, rightRange, zeroFraction } = sharedZeroRanges(left, right);
    expect(zeroFraction).toBeCloseTo(0.05, 10);
    // Left's own natural fraction (~0.045) is below the floor — it
    // must be rescaled to the clamp too, not left at its natural value.
    expect(zeroFractionOfRange(leftRange)).toBeCloseTo(zeroFraction, 9);
    expect(zeroFractionOfRange(rightRange)).toBeCloseTo(zeroFraction, 9);
  });

  it("all-negative case: the fraction clamps to the 0.95 ceiling and both axes agree", () => {
    const left = [-300, -200, -100];
    const right = [-120, -80, -50];
    const { leftRange, rightRange, zeroFraction } = sharedZeroRanges(left, right);
    expect(zeroFraction).toBeCloseTo(0.95, 10);
    expect(zeroFractionOfRange(leftRange)).toBeCloseTo(zeroFraction, 9);
    expect(zeroFractionOfRange(rightRange)).toBeCloseTo(zeroFraction, 9);
  });

  it("both axes' zero fractions agree to within 1e-9 in all-positive, all-negative and straddle cases", () => {
    const cases = [
      [[100, 200, 300], [50, 80, 120]],       // all-positive → clamps to 0.05
      [[-300, -200, -100], [-120, -80, -50]], // all-negative → clamps to 0.95
      [[-100, 50, 200], [0, 300, 600]],       // straddle → unclamped
    ];
    for (const [left, right] of cases) {
      const { leftRange, rightRange, zeroFraction } = sharedZeroRanges(left, right);
      expect(Math.abs(zeroFractionOfRange(leftRange) - zeroFraction)).toBeLessThan(1e-9);
      expect(Math.abs(zeroFractionOfRange(rightRange) - zeroFraction)).toBeLessThan(1e-9);
    }
  });
});

describe("axisTickVals — confine tick labels to the axis's own data span", () => {
  it("suppresses ticks in the stretch of axis added purely to align zero", () => {
    // All-negative left, small positive-only right: the right axis
    // gets pulled far negative to match the left's clamped zero
    // fraction, but the right series never goes below ~0.
    const left = [-1400000, -900000, -200000];
    const right = [50000, 80000, 120000];
    const { rightRange, rightDataRange } = sharedZeroRanges(left, right);
    const ticks = axisTickVals(rightRange, rightDataRange);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(rightDataRange[0]);
      expect(t).toBeLessThanOrEqual(rightDataRange[1]);
    }
    // The whole point: no tick anywhere near the axis's stretched-out
    // negative floor, which no series ever reaches.
    expect(ticks.every((t) => t > rightRange[0] + 1)).toBe(true);
  });

  it("produces evenly spaced nice values covering an ordinary range", () => {
    const range = [-15, 315];
    const ticks = axisTickVals(range, range);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i] - ticks[i - 1]).toBeCloseTo(ticks[1] - ticks[0], 9);
    }
  });
});

describe("seriesIsAllZero — auto-hide flat series", () => {
  it("treats a series as all-zero when every value is within threshold of 0", () => {
    expect(seriesIsAllZero([0, 0.001, -0.002, 0])).toBe(true);
  });

  it("is false as soon as one value clears the threshold", () => {
    expect(seriesIsAllZero([0, 0, 0.01, 0])).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(seriesIsAllZero([1, 2], 5)).toBe(true);
    expect(seriesIsAllZero([1, 6], 5)).toBe(false);
  });
});
