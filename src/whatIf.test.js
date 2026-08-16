import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { runShock, buildDeltas, registerShockKind } from "./whatIf.js";

function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    distributions: "reinvest", balance: 100000,
    allocation: { mode: "custom", incomePct: 0, growthPct: 5, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function mkState(over = {}) {
  const assets = over.assets ?? [mkAsset()];
  return {
    plan: {
      household: "single",
      client: { currentAge: 40 },
      partner: null,
      endAge: over.endAge ?? 44,
      start: { year: 2026, month: 7 },
      superAccounts: [],
      workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
      ...over.plan,
    },
    assets,
    goals: [],
    liabilities: over.liabilities ?? [],
    properties: [],
    cashflows: {
      income: [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [],
      ...over.cashflows,
    },
    settings: {
      surplus: over.surplus ?? { mode: "accumulate", assetId: null },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: over.cpi ?? 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("buildDeltas — the delta shape, independent of any shock kind", () => {
  const fakeOut = (netAssetsSeries, shortfall = null) => ({
    yearly: netAssetsSeries.map((netAssets, i) => ({
      netAssets, closingBalance: netAssets * 0.5, tax: 100 + i, surplusOrDeficit: 50 + i, unfundedCashflow: i === 2 ? 200 : 0,
    })),
    shortfall,
  });

  it("computes shocked-minus-base for every named field, per year", () => {
    const base = fakeOut([1000, 1100, 1200]);
    const shocked = fakeOut([900, 950, 1000]);
    const d = buildDeltas(base, shocked);
    expect(d.byYear).toHaveLength(3);
    expect(d.byYear[0]).toEqual({ year: 0, netAssets: -100, closingBalance: -50, totalTax: 0, surplus: 0, unfundedCashflow: 0 });
    expect(d.byYear[2].unfundedCashflow).toBe(0); // both have 200 at y=2 in this fixture — delta is 0
  });

  it("carries headline figures for BOTH runs, not just the delta", () => {
    const base = fakeOut([1000, 1100, 1200]);
    const shocked = fakeOut([900, 950, 800], { clientAge: 43, total: 5000 });
    const d = buildDeltas(base, shocked);
    expect(d.headline.base).toEqual({ endNetAssets: 1200, firstShortfallAge: null, totalUnfunded: 0 });
    expect(d.headline.shocked).toEqual({ endNetAssets: 800, firstShortfallAge: 43, totalUnfunded: 5000 });
  });

  it("handles a shorter shocked run (a shock cannot lengthen/shorten the schedule in practice, but the function must not crash if it did)", () => {
    const base = fakeOut([1000, 1100, 1200]);
    const shocked = fakeOut([900, 950]);
    const d = buildDeltas(base, shocked);
    expect(d.byYear).toHaveLength(2);
  });
});

describe("runShock — the clone-and-apply discipline", () => {
  it("never mutates the caller's state, even when the shock changes the clone", () => {
    registerShockKind("__test_bump_cpi__", (clone, shock) => { clone.assumptions.cpi += shock.deltaPct; });
    const state = mkState({ cpi: 0.025 });
    const before = JSON.stringify(state);
    runShock(state, { kind: "__test_bump_cpi__", deltaPct: 0.05 });
    expect(JSON.stringify(state)).toBe(before);
    expect(state.assumptions.cpi).toBe(0.025);
  });

  it("returns a real base run (against the unmodified state) and a real shocked run (against the modified clone)", () => {
    registerShockKind("__test_bump_cpi__", (clone, shock) => { clone.assumptions.cpi += shock.deltaPct; });
    const state = mkState({ cpi: 0.01 });
    const { base, shocked } = runShock(state, { kind: "__test_bump_cpi__", deltaPct: 0.05 });
    const directBase = projectPlan(state);
    const directShocked = projectPlan({ ...state, assumptions: { ...state.assumptions, cpi: 0.06 } });
    expect(base.yearly[3].netAssets).toBeCloseTo(directBase.yearly[3].netAssets, 6);
    expect(shocked.yearly[3].netAssets).toBeCloseTo(directShocked.yearly[3].netAssets, 6);
    // A higher CPI (real growth held at 5% nominal-equivalent via the
    // fixture's allocation) erodes REAL returns — the shocked run must
    // differ from the base, proving the clone's mutation actually took.
    expect(shocked.yearly[3].netAssets).not.toBeCloseTo(base.yearly[3].netAssets, 2);
  });

  it("deltas returned by runShock match buildDeltas applied to the same base/shocked pair", () => {
    registerShockKind("__test_bump_cpi__", (clone, shock) => { clone.assumptions.cpi += shock.deltaPct; });
    const state = mkState({ cpi: 0.02 });
    const result = runShock(state, { kind: "__test_bump_cpi__", deltaPct: 0.03 });
    expect(result.deltas).toEqual(buildDeltas(result.base, result.shocked));
  });

  it("throws a clear error for an unregistered shock kind, rather than silently running the base scenario twice", () => {
    const state = mkState();
    expect(() => runShock(state, { kind: "__totally_unknown_kind__" })).toThrow(/Unknown shock kind/);
  });
});
