import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { projectStatic } from "./staticProjection.js";
import { legacySurplusPeriod } from "./planState.js";

// Same minimal-fixture conventions as deterministic.test.js's own
// mkState/mkAsset/cf — this file deliberately keeps its own local
// copies rather than importing from there (no shared fixture module
// in this codebase's own convention; see deterministic.test.js's own
// header on why).
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

describe("projectStatic (spec 30, Commit 1) — control: nothing evolving", () => {
  it("matches the real engine's own net-worth path when income/expenses/asset return are all genuinely flat in real terms", () => {
    const state = mkState({
      cashflows: { income: [incomeRow()], expenses: [expenseRow()] },
    });
    const out = projectPlan(state);
    const staticYearly = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });

    expect(staticYearly.length).toBe(out.yearly.length);
    // Snapshot year itself: exact agreement by construction.
    expect(staticYearly[0].netAssets).toBeCloseTo(out.yearly[0].netAssets, 6);
    // Every later year: nothing in this scenario evolves (0% real
    // asset return, CPI-indexed income/expenses held flat in real
    // terms, no liabilities) — the two models should track closely.
    // A small tolerance covers the mid-year-flow-timing convention
    // difference from the real engine's own monthly compounding.
    for (let y = 1; y < out.yearly.length; y++) {
      const real = out.yearly[y].netAssets;
      const stat = staticYearly[y].netAssets;
      expect(Math.abs(stat - real)).toBeLessThan(Math.max(50, Math.abs(real) * 0.02));
    }
  });

  it("is the control the spec names: divergence near zero here means any divergence found elsewhere is real, not an implementation artefact", () => {
    const state = mkState({
      cashflows: { income: [incomeRow({ amount: 5000 })], expenses: [expenseRow({ amount: 3000 })] },
      endAge: 60,
    });
    const out = projectPlan(state);
    const staticYearly = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });
    const realFinal = out.yearly[out.yearly.length - 1].netAssets;
    const staticFinal = staticYearly[staticYearly.length - 1].netAssets;
    const pctDiff = Math.abs(staticFinal - realFinal) / Math.abs(realFinal);
    expect(pctDiff).toBeLessThan(0.03);
  });
});

describe("projectStatic — indexation option", () => {
  it("'flat' (hold nominal constant) decays the real figures at CPI; 'cpi' (index nominal at CPI) holds them flat in real terms", () => {
    const state = mkState({
      cashflows: { income: [incomeRow({ amount: 3000 })], expenses: [expenseRow({ amount: 2000 })] },
      cpi: 0.025,
    });
    const flatYearly = projectStatic(state, { snapshotYears: 0, indexation: "flat" });
    const cpiYearly = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });
    const y = flatYearly.length - 1;
    // cpi mode: income stays exactly at the snapshot's real figure.
    expect(cpiYearly[y].income).toBeCloseTo(flatYearly[0].income, 2);
    // flat mode: income has decayed by (1+cpi)^-years relative to cpi mode.
    const years = y;
    expect(flatYearly[y].income).toBeCloseTo(cpiYearly[y].income * Math.pow(1 / 1.025, years), 2);
    expect(flatYearly[y].income).toBeLessThan(cpiYearly[y].income);
  });
});

describe("projectStatic — surplus lost once its liability destination closes", () => {
  it("a liability's extra repayment stops being applied (dropped, not redirected) once its static balance reaches zero", () => {
    const state = mkState({
      liabilities: [loan({ balance: 150000, termYears: 20, interestRatePct: 6 })],
      cashflows: {
        income: [incomeRow({ amount: 4000 })],
        expenses: [expenseRow({ amount: 1500 })],
      },
      fundingOrder: [],
      endAge: 60,
      // Direct all surplus at extra-repaying the loan, so the real
      // engine's own snapshot year shows a real surplusRepayment/
      // extraRepayment figure for this liability to hold/index.
      surplus: {
        periods: [{
          id: "sp1", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
          payNonDeductibleDebtFirst: false, debtOrder: "interestRate", remainderTo: "cash",
          allocations: [{ id: "sa1", targetType: "liability", targetId: "lb1", pct: 100 }],
        }],
      },
    });
    const staticYearly = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });

    // The loan must actually close within this model's own horizon for
    // the test to exercise anything (a real, small starting balance
    // against a real surplus makes this true well before endAge 60).
    const closedIndex = staticYearly.findIndex((row) => row.liabilities.lb1.closing <= 1e-6);
    expect(closedIndex).toBeGreaterThan(0);
    expect(closedIndex).toBeLessThan(staticYearly.length - 1);

    // From the year it closes onward, nothing further is applied to
    // it — this IS the modelled defect (spec 30's own words: "money is
    // not conserved"), not a bug to fix.
    const afterClose = staticYearly[closedIndex + 1].liabilities.lb1;
    expect(afterClose.interest).toBe(0);
    expect(afterClose.principal).toBe(0);
    expect(afterClose.extra).toBe(0);
    expect(afterClose.closing).toBe(0);
  });
});

describe("projectStatic — multiple snapshot years", () => {
  it("returns one independent extrapolation per snapshot year when snapshotYears is an array", () => {
    const state = mkState({
      cashflows: { income: [incomeRow()], expenses: [expenseRow()] },
      endAge: 50,
    });
    const results = projectStatic(state, { snapshotYears: [0, 3], indexation: "cpi" });
    expect(results).toHaveLength(2);
    expect(results[0].snapshotYear).toBe(0);
    expect(results[1].snapshotYear).toBe(3);
    // Each series starts its OWN snapshot year's real figures, not a
    // shared/blended base.
    expect(results[0].yearly[0].y).toBe(0);
    expect(results[1].yearly[0].y).toBe(3);
    const out = projectPlan(state);
    expect(results[1].yearly[0].netAssets).toBeCloseTo(out.yearly[3].netAssets, 6);
  });

  it("throws a clear error for a snapshot year outside the projection, rather than silently misbehaving", () => {
    const state = mkState({ endAge: 44 });
    expect(() => projectStatic(state, { snapshotYears: 99 })).toThrow(/outside the projection/);
  });
});
