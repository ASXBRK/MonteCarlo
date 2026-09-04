import { describe, it, expect } from "vitest";
import {
  incomeBySourceForYear, incomeBySourceSeries, firstShortfallCrossover, goalVsPositionSummary,
} from "./goalVsPosition.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";

// --- Pure unit tests, hand-built fixtures ---------------------------------

function mkSchedule({ months = 12, employmentClient = [], employmentPartner = [], clientAges = [40] } = {}) {
  const yearOfMonth = Array.from({ length: months }, () => 0);
  return {
    months, yearOfMonth, clientAges,
    employmentIncomeByOwner: { client: employmentClient, partner: employmentPartner },
  };
}

function mkRow(over = {}) {
  return {
    pensionDetail: {}, superDetail: {}, cashDistributions: 0, agePensionDetail: null,
    deficitFundedFromAssets: 0, withdrawals: 0, tax: 0,
    ...over,
  };
}

describe("incomeBySourceForYear", () => {
  it("sums employment across the FY's own months, both owners", () => {
    const schedule = mkSchedule({
      employmentClient: Array(12).fill(10000),
      employmentPartner: Array(12).fill(5000),
    });
    const row = mkRow();
    const out = incomeBySourceForYear(row, schedule, 0);
    expect(out.employment).toBe(12 * 10000 + 12 * 5000);
  });

  it("sums pension payments across every pension in pensionDetail", () => {
    const schedule = mkSchedule();
    const row = mkRow({ pensionDetail: { pn1: { payments: 30000 }, pn2: { payments: 12000 } } });
    const out = incomeBySourceForYear(row, schedule, 0);
    expect(out.pensionDrawdown).toBe(42000);
  });

  it("investment income is exactly row.cashDistributions", () => {
    const schedule = mkSchedule();
    const row = mkRow({ cashDistributions: 8500 });
    expect(incomeBySourceForYear(row, schedule, 0).investmentIncome).toBe(8500);
  });

  it("age pension sums both owners, 0 for a single household with no entitlement", () => {
    const schedule = mkSchedule();
    const row = mkRow({ agePensionDetail: { client: { paid: 15000 }, partner: { paid: 9000 } } });
    expect(incomeBySourceForYear(row, schedule, 0).agePension).toBe(24000);
    expect(incomeBySourceForYear(mkRow(), schedule, 0).agePension).toBe(0);
  });

  it("asset drawdown combines deficit-funded sells, explicit withdrawals, and every super account's own withdrawals", () => {
    const schedule = mkSchedule();
    const row = mkRow({
      deficitFundedFromAssets: 5000,
      withdrawals: 3000,
      superDetail: { su1: { withdrawals: 20000 }, su2: { withdrawals: 4000 } },
    });
    expect(incomeBySourceForYear(row, schedule, 0).assetDrawdown).toBe(5000 + 3000 + 20000 + 4000);
  });

  it("grossTotal is the sum of all five buckets; deliveredIncome nets off row.tax", () => {
    const schedule = mkSchedule({ employmentClient: Array(12).fill(1000) });
    const row = mkRow({
      cashDistributions: 2000,
      pensionDetail: { pn1: { payments: 3000 } },
      agePensionDetail: { client: { paid: 1500 }, partner: null },
      deficitFundedFromAssets: 500,
      tax: 1200,
    });
    const out = incomeBySourceForYear(row, schedule, 0);
    const expectedGross = 12000 + 3000 + 2000 + 1500 + 500;
    expect(out.grossTotal).toBe(expectedGross);
    expect(out.deliveredIncome).toBe(expectedGross - 1200);
  });

  it("never throws on a bare-minimum row/schedule (every field optional/defensive)", () => {
    const schedule = { months: 0, yearOfMonth: [], clientAges: [], employmentIncomeByOwner: {} };
    expect(() => incomeBySourceForYear({}, schedule, 0)).not.toThrow();
  });
});

describe("firstShortfallCrossover", () => {
  const series = [
    { deliveredIncome: 90000 },
    { deliveredIncome: 91000 },
    { deliveredIncome: 60000 }, // first year below requirement
    { deliveredIncome: 40000 },
  ];

  it("returns the first year index where delivered income drops below the requirement", () => {
    const req = [90000, 90000, 90000, 90000];
    expect(firstShortfallCrossover(series, req)).toBe(2);
  });

  it("skips years before Income Required's own startAt (null), never treating null as a breach", () => {
    const req = [null, null, 90000, 90000];
    expect(firstShortfallCrossover(series, req)).toBe(2);
  });

  it("never crosses → null", () => {
    const req = [1, 1, 1, 1];
    expect(firstShortfallCrossover(series, req)).toBeNull();
  });

  it("all years null (Income Required never active) → null, never a false crossover", () => {
    expect(firstShortfallCrossover(series, [null, null, null, null])).toBeNull();
  });
});

describe("goalVsPositionSummary — full pipeline", () => {
  it("bundles the series, crossover year/age, delivered-at-crossover, and the passed-through target", () => {
    const schedule = mkSchedule({ months: 0, clientAges: [65, 66, 67, 68] });
    schedule.months = 0;
    const yearly = [
      mkRow({ tax: 0 }), // grossTotal 0 each (no sources set) — use direct override instead
    ];
    // Build a 4-year series directly via a schedule with per-year distinguishable rows.
    const yearly4 = [0, 1, 2, 3].map((y) => mkRow({ cashDistributions: y === 2 ? 10000 : 90000 }));
    const sched4 = { months: 0, yearOfMonth: [], clientAges: [65, 66, 67, 68], employmentIncomeByOwner: {} };
    const req = [80000, 80000, 80000, 80000];
    const summary = goalVsPositionSummary(yearly4, sched4, req, 80000);
    expect(summary.series).toHaveLength(4);
    expect(summary.crossoverYear).toBe(2);
    expect(summary.crossoverAge).toBe(67);
    expect(summary.deliveredAtCrossover).toBe(10000);
    expect(summary.targetAmount).toBe(80000);
  });

  it("no crossover → crossoverYear/age/deliveredAtCrossover all null", () => {
    const yearly4 = [0, 1].map(() => mkRow({ cashDistributions: 100000 }));
    const sched4 = { months: 0, yearOfMonth: [], clientAges: [65, 66], employmentIncomeByOwner: {} };
    const summary = goalVsPositionSummary(yearly4, sched4, [50000, 50000], 50000);
    expect(summary.crossoverYear).toBeNull();
    expect(summary.crossoverAge).toBeNull();
    expect(summary.deliveredAtCrossover).toBeNull();
  });
});

// --- Real engine integration ------------------------------------------

function mkState({ clientAge = 65, endAge = 68, assets, pensions = [], superAccounts = [], workingCash } = {}) {
  return {
    plan: {
      household: "single",
      client: { currentAge: clientAge, retirementAge: clientAge },
      partner: null,
      endBasis: { mode: "fixedAge", fixedAge: endAge },
      endAge,
      start: { year: 2026, month: 7 },
      superAccounts, pensions,
      workingCash: workingCash ?? { balance: 500000, minimumBalance: 0, ratePct: 0 },
    },
    assets: assets ?? [],
    bonds: [], liabilities: [], properties: [],
    cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [], bondContributions: [] },
    settings: {
      surplus: { periods: [{ from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" }, mode: "spend", assetId: null }] },
      fundingOrder: (assets ?? []).map((a) => a.id),
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed", awote: 0.035, wageGrowth: 0.04 },
    display: { units: "real" },
  };
}

describe("incomeBySourceSeries — real engine integration", () => {
  it("a pension-only household's pensionDrawdown bucket matches the ledger's own pension payments exactly", () => {
    const state = mkState({
      superAccounts: [{ id: "su1", owner: "client", balance: 500000, allocation: { mode: "custom", incomePct: 2.5, growthPct: 0, frankingPct: 0, volBasis: "Balanced" }, icrPct: 0, include: true, taxFreeComponent: 0 }],
      pensions: [{
        id: "pn1", owner: "client", sourceAccountId: "su1", commenceAt: { kind: "age", age: 65 }, type: "abp",
        commenceAmount: null, reversionary: false, taxFreeProportion: null,
        allocation: { mode: "custom", incomePct: 2.5, growthPct: 0, frankingPct: 0, volBasis: "Balanced" }, icrPct: 0,
        drawdownOption: "expenditure", fixedAmount: 0, indexBasis: "cpi", indexExtraPct: 0, commutations: [],
      }],
    });
    const result = projectPlan(state, PROFILES);
    const series = incomeBySourceSeries(result.yearly, result.schedule);
    expect(series[1].pensionDrawdown).toBeCloseTo(result.yearly[1].pensionDetail.pn1.payments, 6);
    expect(series[1].pensionDrawdown).toBeGreaterThan(0);
  });

  it("grossTotal never exceeds a sane bound and deliveredIncome tracks grossTotal minus that year's own tax exactly", () => {
    const state = mkState({
      assets: [{ id: "a1", name: "A1", include: true, owner: "client", distributions: "cash", balance: 400000, allocation: { mode: "custom", incomePct: 4, growthPct: 0, frankingPct: 0, volBasis: "Balanced" }, icrPct: 0, cgtAsset: false, costBase: null }],
    });
    const result = projectPlan(state, PROFILES);
    const series = incomeBySourceSeries(result.yearly, result.schedule);
    series.forEach((s, y) => {
      expect(s.deliveredIncome).toBeCloseTo(s.grossTotal - result.yearly[y].tax, 6);
    });
  });
});
