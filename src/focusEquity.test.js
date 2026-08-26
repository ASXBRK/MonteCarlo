import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { eligibleEquityProperties, buildEquityFocus } from "./focusEquity.js";

// Minimal v3-shaped state factory — mirrors focusDeposit.test.js's own
// mkState (kept separate, not shared — see solve.test.js's header for why).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    distributions: "reinvest", balance: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function prop(over = {}) {
  return {
    id: "p1", name: "Home", owner: "client", state: "NSW",
    propertyType: "ppr", status: "owned",
    currentValue: 800000, acquisitionDate: null, costBase: 0,
    priceToday: 0, purchaseAt: { kind: "age", age: 40 },
    lvrPct: 80, firstHomeBuyer: false, newBuild: false,
    purchaseCostsPct: 0, dutyOverride: null, growthPct: 2.5,
    rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expensesDeductible: true, depreciation: 0,
    equityCeilingPct: 80, depositFromEquity: false, depositFromEquitySourcePropertyId: null,
    ...over,
  };
}

function loan(over = {}) {
  return {
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 400000, interestRatePct: 6, termYears: 25, repayment: "pi",
    ioYears: 5, deductible: false, linkedAssetId: "p1", offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    ...over,
  };
}

function mkState(over = {}) {
  const assets = over.assets ?? [];
  return {
    plan: {
      household: "single", client: { currentAge: 40 }, partner: null,
      endAge: over.endAge ?? 42, start: { year: 2026, month: 7 },
      superAccounts: [], workingCash: { balance: 0, minimumBalance: 0, ratePct: null },
    },
    assets,
    goals: [],
    liabilities: over.liabilities ?? [],
    properties: over.properties ?? [],
    cashflows: {
      income: [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [],
    },
    settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: [] },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("eligibleEquityProperties", () => {
  it("includes an owned property with a value, and a planned one with a price", () => {
    const state = mkState({
      properties: [prop({ id: "p1", status: "owned", currentValue: 800000 }), prop({ id: "p2", status: "planned", currentValue: 0, priceToday: 600000 })],
    });
    expect(eligibleEquityProperties(state).map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("excludes an owned property with no value and a planned one with no price", () => {
    const state = mkState({
      properties: [prop({ id: "p1", status: "owned", currentValue: 0 }), prop({ id: "p2", status: "planned", currentValue: 0, priceToday: 0 })],
    });
    expect(eligibleEquityProperties(state)).toHaveLength(0);
  });
});

describe("buildEquityFocus", () => {
  it("returns null when there are no properties", () => {
    const state = mkState({ properties: [] });
    const out = projectPlan(state);
    expect(buildEquityFocus({ out, state })).toBeNull();
  });

  it("reads usableEquity straight off the engine, per property and year, and sums it for the total", () => {
    const state = mkState({ properties: [prop()], liabilities: [loan()] });
    const out = projectPlan(state);
    const f = buildEquityFocus({ out, state });
    expect(f).not.toBeNull();
    expect(f.properties).toEqual([{ id: "p1", name: "Home", equityCeilingPct: 80 }]);
    for (let y = 0; y < f.byYear.length; y++) {
      expect(f.byYear[y].byProperty.p1).toBeCloseTo(out.yearly[y].properties.p1.usableEquity, 6);
      expect(f.byYear[y].total).toBeCloseTo(out.yearly[y].properties.p1.usableEquity, 6);
    }
  });

  it("sums across multiple properties correctly", () => {
    const state = mkState({
      properties: [prop({ id: "p1" }), prop({ id: "p2", currentValue: 400000 })],
      liabilities: [loan({ id: "lb1", linkedAssetId: "p1" }), loan({ id: "lb2", linkedAssetId: "p2", balance: 100000 })],
    });
    const out = projectPlan(state);
    const f = buildEquityFocus({ out, state });
    const y0 = f.byYear[0];
    expect(y0.total).toBeCloseTo(y0.byProperty.p1 + y0.byProperty.p2, 6);
    expect(y0.byProperty.p1).toBeGreaterThan(0);
    expect(y0.byProperty.p2).toBeGreaterThan(0);
  });

  it("surfaces the engine's own insufficient-equity warnings, filtered to this concern, and carries the not-a-serviceability-assessment disclosure", () => {
    const planned = prop({
      id: "p2", status: "planned", currentValue: 0, priceToday: 900000,
      purchaseAt: { kind: "age", age: 41 }, lvrPct: 80,
      depositFromEquity: true, depositFromEquitySourcePropertyId: "p1",
    });
    const state = mkState({
      endAge: 43,
      properties: [prop({ id: "p1", currentValue: 500000 }), planned],
      liabilities: [loan({ id: "lb1", linkedAssetId: "p1", balance: 450000 })],
    });
    const out = projectPlan(state);
    const f = buildEquityFocus({ out, state });
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0].propertyId).toBe("p2");
    expect(f.disclosure).toMatch(/not a serviceability assessment/i);
  });

  it("notes when a drawdown or recycling plan against a linked loan is already consuming usable equity (spec 24, Commit 3)", () => {
    const withDrawdown = mkState({
      properties: [prop()],
      liabilities: [loan({ drawdowns: [{ id: "dd1", amount: 20000, at: { kind: "age", age: 40 }, purpose: "investment", destination: "cash" }] })],
    });
    const f1 = buildEquityFocus({ out: projectPlan(withDrawdown), state: withDrawdown });
    expect(f1.drawdownNote).toMatch(/Home loan/);

    const plain = mkState({ properties: [prop()], liabilities: [loan()] });
    const f2 = buildEquityFocus({ out: projectPlan(plain), state: plain });
    expect(f2.drawdownNote).toBeNull();
  });

  it("never mutates the caller's state", () => {
    const state = mkState({ properties: [prop()], liabilities: [loan()] });
    const before = JSON.stringify(state);
    const out = projectPlan(state);
    buildEquityFocus({ out, state });
    expect(JSON.stringify(state)).toBe(before);
  });
});
