import { describe, it, expect } from "vitest";
import { measureDivergence, DRIVERS } from "./divergence.js";
import { legacySurplusPeriod } from "./planState.js";

function mkAsset(over = {}) {
  return {
    id: "a1", name: "A1", include: true, owner: "client",
    distributions: "reinvest", balance: 100000,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function surplusPeriodsFor(over) {
  if (Array.isArray(over?.periods)) return over.periods;
  return [legacySurplusPeriod(over ?? { mode: "spend", assetId: null })];
}

function mkState(over = {}) {
  const assets = over.assets ?? [mkAsset()];
  return {
    plan: {
      household: "single", client: { currentAge: 40 }, partner: null,
      endAge: over.endAge ?? 44, start: over.start ?? { year: 2026, month: 7 },
      superAccounts: over.superAccounts ?? [], pensions: over.pensions ?? [],
      ...over.plan,
    },
    assets,
    bonds: over.bonds ?? [],
    liabilities: over.liabilities ?? [],
    cashflows: {
      income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [],
      bondContributions: [],
      ...over.cashflows,
    },
    settings: {
      surplus: { periods: surplusPeriodsFor(over.surplus) },
      fundingOrder: over.fundingOrder ?? assets.filter((a) => a.include).map((a) => a.id),
      deficit: over.deficit ?? { minimumBalances: {}, sellRule: "order" },
    },
    assumptions: { cpi: over.cpi ?? 0.025, bracketMode: over.bracketMode ?? "indexed", awote: over.awote },
    display: { units: "real" },
  };
}

const incomeRow = (over = {}) => ({
  id: "i1", label: "Other income", owner: "client", amount: 3000, frequency: "monthly",
  from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
  indexBasis: "cpi", indexExtraPct: 0, incomeType: "otherTaxable",
  ...over,
});

const expenseRow = (over = {}) => ({
  id: "e1", label: "Living", owner: "client", amount: 2000, frequency: "monthly",
  from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
  indexBasis: "cpi", indexExtraPct: 0,
  ...over,
});

const loan = (over = {}) => ({
  id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
  balance: 50000, interestRatePct: 6, termYears: 10, repayment: "pi",
  ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
  ...over,
});

describe("measureDivergence (spec 30, Commit 2) — control", () => {
  it("reports near-zero divergence and near-zero driver contributions when nothing evolves", () => {
    const state = mkState({
      cashflows: { income: [incomeRow()], expenses: [expenseRow()] },
      endAge: 60,
    });
    const result = measureDivergence(state, { snapshotYears: 0, indexation: "cpi" });
    expect(Math.abs(result.summary.atEnd.pctDiff)).toBeLessThan(0.03);
    for (const d of result.drivers) {
      // Nothing to fix in a scenario with nothing evolving — every
      // driver's own contribution should be negligible relative to the
      // household's own net worth scale.
      expect(Math.abs(d.contribution)).toBeLessThan(Math.abs(result.summary.atEnd.netAssetsReal) * 0.02 + 50);
    }
    expect(Number.isFinite(result.residual)).toBe(true);
  });
});

describe("measureDivergence — shape", () => {
  it("returns byYear/summary/drivers with the documented fields, drivers sorted by |contribution| descending", () => {
    const state = mkState({
      liabilities: [loan({ balance: 150000, termYears: 20, interestRatePct: 6 })],
      cashflows: { income: [incomeRow({ amount: 4000 })], expenses: [expenseRow({ amount: 1500 })] },
      fundingOrder: [],
      endAge: 60,
      surplus: {
        periods: [{
          id: "sp1", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
          payNonDeductibleDebtFirst: false, debtOrder: "interestRate", remainderTo: "cash",
          allocations: [{ id: "sa1", targetType: "liability", targetId: "lb1", pct: 100 }],
        }],
      },
    });
    const result = measureDivergence(state, { snapshotYears: 0, indexation: "cpi" });

    expect(result.byYear.length).toBeGreaterThan(0);
    expect(result.byYear[0]).toHaveProperty("netAssetsReal");
    expect(result.byYear[0]).toHaveProperty("netAssetsStatic");
    expect(result.byYear[0]).toHaveProperty("diff");
    expect(result.byYear[0]).toHaveProperty("pctDiff");
    expect(result.summary).toHaveProperty("atEnd");
    expect(result.summary).toHaveProperty("firstExceeds5Pct");
    expect(result.summary).toHaveProperty("firstExceeds10Pct");
    expect(result.drivers).toHaveLength(DRIVERS.length);
    for (let i = 1; i < result.drivers.length; i++) {
      expect(Math.abs(result.drivers[i - 1].contribution)).toBeGreaterThanOrEqual(Math.abs(result.drivers[i].contribution));
    }

    // Loan maturity is the driver actually exercised by this scenario
    // (a loan that fully repays from surplus within the horizon) — its
    // own contribution must be in the expected direction: fixing "drop
    // the freed-up surplus" can only recover value, never lose it.
    const loanDriver = result.drivers.find((d) => d.key === "loanMaturity");
    expect(loanDriver.contribution).toBeGreaterThanOrEqual(0);

    // The drivers approximate the total gap; any shortfall is the
    // reported residual, never silently folded into one driver.
    const sum = result.drivers.reduce((s, d) => s + d.contribution, 0);
    expect(result.residual).toBeCloseTo(result.totalGap - sum, 6);
  });

  it("accepts snapshotYears as an array and measures its first entry, same convention as staticProjection.js", () => {
    const state = mkState({ cashflows: { income: [incomeRow()], expenses: [expenseRow()] }, endAge: 50 });
    const single = measureDivergence(state, { snapshotYears: 2, indexation: "cpi" });
    const fromArray = measureDivergence(state, { snapshotYears: [2, 5], indexation: "cpi" });
    expect(fromArray.byYear[0].y).toBe(single.byYear[0].y);
    expect(fromArray.summary.atEnd.y).toBe(single.summary.atEnd.y);
  });
});
