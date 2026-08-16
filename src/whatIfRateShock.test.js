import { describe, it, expect } from "vitest";
import { buildRateShockView, RATE_SHOCK_DELTAS, eligibleRateShockLoans } from "./whatIfRateShock.js";
import { runShock } from "./whatIf.js";

function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    distributions: "reinvest", balance: 2_000_000,
    allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" },
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
      endAge: over.endAge ?? 46,
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
      surplus: { mode: "accumulate", assetId: null },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

const loan = (over = {}) => ({
  id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
  balance: 100000, interestRatePct: 6, termYears: 10, repayment: "pi",
  ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
  extraRepayments: [], oneOffRepayments: [],
  rateType: "variable", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 },
  revertRatePct: null, commencedOn: null,
  ...over,
});

describe("buildRateShockView", () => {
  it("returns null when there's nothing to shock (no liabilities with a balance)", () => {
    expect(buildRateShockView({ state: mkState(), shockKind: "rateShock", deltaPct: 1 })).toBeNull();
  });

  it("assembles per-loan base/shocked detail via focusDebtPayoff's own reader — never re-derived", () => {
    const state = { ...mkState(), liabilities: [loan()] };
    const view = buildRateShockView({ state, shockKind: "rateShock", deltaPct: 2 });
    expect(view.perLoan).toHaveLength(1);
    const l = view.perLoan[0];
    expect(l.id).toBe("lb1");
    expect(l.rateType).toBe("variable");
    expect(l.base.totalInterest).toBeGreaterThan(0);
    expect(l.shocked.totalInterest).toBeGreaterThan(l.base.totalInterest); // +2pp costs more, always
    expect(l.base.balanceSeries).toHaveLength(l.shocked.balanceSeries.length);
  });

  it("household-level deltas match a direct runShock call with the same shock", () => {
    const state = { ...mkState(), liabilities: [loan()] };
    const view = buildRateShockView({ state, shockKind: "rateShock", deltaPct: 1 });
    const direct = runShock(state, { kind: "rateShock", deltaPct: 1 });
    expect(view.deltas).toEqual(direct.deltas);
  });

  it("a fixed loan's rollover figures surface separately for base and shocked", () => {
    const l = loan({ rateType: "fixed", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: 6.5 });
    const state = { ...mkState({ endAge: 46 }), liabilities: [l] };
    const view = buildRateShockView({ state, shockKind: "rateShock", deltaPct: 2 });
    const row = view.perLoan[0];
    expect(row.base.rollover.toRatePct).toBeCloseTo(6.5, 6);
    expect(row.shocked.rollover.toRatePct).toBeCloseTo(8.5, 6);
    // The FIXED rate itself (before rollover) is identical either way.
    expect(row.base.rollover.fromRatePct).toBeCloseTo(row.shocked.rollover.fromRatePct, 6);
  });

  it("RATE_SHOCK_DELTAS exposes the five spec'd magnitudes", () => {
    expect(RATE_SHOCK_DELTAS).toEqual([-2, -1, 1, 2, 3]);
  });
});

describe("eligibleRateShockLoans (re-exported)", () => {
  it("filters to liabilities with an outstanding balance", () => {
    const state = { liabilities: [{ id: "lb1", balance: 5 }, { id: "lb2", balance: 0 }] };
    expect(eligibleRateShockLoans(state).map((l) => l.id)).toEqual(["lb1"]);
  });
});
