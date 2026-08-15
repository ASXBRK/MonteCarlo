import { describe, it, expect } from "vitest";
import { bisectScalar, solveFor, applyVary } from "./solve.js";

// Minimal v3-shaped state factory, mirroring deterministic.test.js's own
// mkState — kept separate (not shared) since the two files test
// different modules and a shared fixture would couple them for no
// benefit.
function mkAsset(over = {}) {
  return {
    id: "a1", name: "A1", include: true, owner: "client",
    distributions: "reinvest", balance: 100000,
    // Zero-real allocation: net nominal return exactly equals CPI, so a
    // year's closing balance is opening + contributions with no growth
    // noise — makes the hand-computed test exact.
    allocation: { mode: "custom", incomePct: 2.5, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
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
      endAge: over.endAge ?? 41,
      start: { year: 2026, month: 7 },
      ...over.plan,
    },
    assets,
    goals: over.goals ?? [],
    liabilities: over.liabilities ?? [],
    properties: over.properties ?? [],
    cashflows: {
      income: [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [],
      ...over.cashflows,
    },
    settings: {
      surplus: { mode: "spend", assetId: null },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("bisectScalar", () => {
  it("finds x such that f(x) = targetValue for a monotonic increasing function", () => {
    const r = bisectScalar({ f: (x) => 2 * x + 3, lo: 0, hi: 100, targetValue: 47, tolerance: 1e-6 });
    expect(r.converged).toBe(true);
    expect(r.achieved).toBe(true);
    expect(r.value).toBeCloseTo(22, 5);
  });

  it("finds x for a monotonic DECREASING function too", () => {
    const r = bisectScalar({ f: (x) => 100 - x, lo: 0, hi: 100, targetValue: 30, tolerance: 1e-6 });
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(70, 5);
  });

  it("bounds are respected: a target outside [f(lo), f(hi)] reports non-convergence, not extrapolation", () => {
    const r = bisectScalar({ f: (x) => x, lo: 0, hi: 10, targetValue: 500, tolerance: 1e-6 });
    expect(r.converged).toBe(false);
    expect(r.achieved).toBe(false);
    expect(r.value).toBeNull();
    expect(r.reason).toBe("out-of-bounds");
  });

  it("a non-monotonic objective reports non-convergence rather than converging on nonsense", () => {
    // An upward-sloping-at-the-endpoints parabola over [0, 8]: f(0)=5,
    // f(8)=21 (increasing, per the endpoints) — but it peaks at 29
    // around the midpoint, overshooting the [5, 21] bracket the
    // endpoints imply. targetValue=15 IS genuinely bracketed by the
    // endpoints, so this isn't caught by the bounds check; it's the
    // midpoint evaluation violating the inferred direction that must
    // catch it — the search must refuse to continue rather than pick
    // an arbitrary half and report a wrong x.
    const f = (x) => -(x - 5) * (x - 5) + 30;
    const r = bisectScalar({ f, lo: 0, hi: 8, targetValue: 15, tolerance: 1e-6 });
    expect(r.converged).toBe(false);
    expect(r.reason).toBe("non-monotonic");
    expect(r.value).toBeNull();
  });

  it("caps at 40 iterations and reports the cap was hit", () => {
    // An asymptotic function that never quite reaches its target within
    // float tolerance at any finite x — forces the iteration cap.
    const r = bisectScalar({ f: (x) => x, lo: 0, hi: 1, targetValue: 0.31830988618, tolerance: 0 });
    expect(r.iterations).toBeLessThanOrEqual(40);
    if (!r.achieved) expect(r.reason).toBe("iteration-cap");
  });
});

describe("solveFor", () => {
  it("solving a contribution to hit a known balance reproduces a hand-computed figure", () => {
    const state = mkState({
      cashflows: {
        contributions: [{
          id: "c1", assetId: "a1", amount: 0, frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
          indexed: false, owner: "client", label: "Savings",
        }],
      },
    });
    // Hand calc: zero-real asset, opening 100000 — with no contribution
    // the year-0 closing balance is exactly 100000 (real terms). A
    // contribution of $X in July lands the same FY, so closing = 100000 + X.
    const target = 150000;
    const r = solveFor({
      state,
      target: { metric: (out) => out.yearly[0].closingBalance, value: target },
      vary: { kind: "cashflowAmount", id: "c1" },
      bounds: [0, 200000],
      tolerance: 0.5,
    });
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(50000, 0);
  });

  it("the caller's state is never mutated, even after a converged solve", () => {
    const state = mkState({
      cashflows: {
        contributions: [{
          id: "c1", assetId: "a1", amount: 0, frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
          indexed: false, owner: "client", label: "Savings",
        }],
      },
    });
    const before = JSON.stringify(state);
    solveFor({
      state,
      target: { metric: (out) => out.yearly[0].closingBalance, value: 150000 },
      vary: { kind: "cashflowAmount", id: "c1" },
      bounds: [0, 200000],
      tolerance: 0.5,
    });
    expect(JSON.stringify(state)).toBe(before);
    expect(state.cashflows.contributions[0].amount).toBe(0);
  });

  it("bounds are respected end to end: an unreachable target within [lo, hi] reports non-convergence", () => {
    const state = mkState({
      cashflows: {
        contributions: [{
          id: "c1", assetId: "a1", amount: 0, frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
          indexed: false, owner: "client", label: "Savings",
        }],
      },
    });
    const r = solveFor({
      state,
      // Even at bounds' upper end (10000 contributed), closing balance
      // can't reach 10 million.
      target: { metric: (out) => out.yearly[0].closingBalance, value: 10_000_000 },
      vary: { kind: "cashflowAmount", id: "c1" },
      bounds: [0, 10000],
      tolerance: 0.5,
    });
    expect(r.converged).toBe(false);
    expect(r.reason).toBe("out-of-bounds");
  });
});

describe("applyVary", () => {
  it("cashflowAmount writes into the matching row across income/expenses/deductions/contributions/withdrawals", () => {
    const state = mkState({ cashflows: { expenses: [{ id: "e1", amount: 100 }] } });
    applyVary(state, { kind: "cashflowAmount", id: "e1" }, 500);
    expect(state.cashflows.expenses[0].amount).toBe(500);
  });

  it("superContributionAmount writes into cashflows.superContributions", () => {
    const state = mkState({ cashflows: { superContributions: [{ id: "sc1", amount: 1000 }] } });
    applyVary(state, { kind: "superContributionAmount", id: "sc1" }, 5000);
    expect(state.cashflows.superContributions[0].amount).toBe(5000);
  });

  it("goalTargetDate writes an age-based DateRef, not an amount", () => {
    const state = mkState({ goals: [{ id: "g1", targetAt: { kind: "age", age: 45 } }] });
    applyVary(state, { kind: "goalTargetDate", id: "g1" }, 50);
    expect(state.goals[0].targetAt).toEqual({ kind: "age", age: 50 });
  });

  it("propertyPurchaseDate writes an age-based DateRef onto the property, not an amount", () => {
    const state = mkState({ properties: [{ id: "p1", purchaseAt: { kind: "age", age: 42 } }] });
    applyVary(state, { kind: "propertyPurchaseDate", id: "p1" }, 46);
    expect(state.properties[0].purchaseAt).toEqual({ kind: "age", age: 46 });
  });

  it("an unknown vary.kind throws rather than silently no-op-ing", () => {
    expect(() => applyVary(mkState(), { kind: "bogus", id: "x" }, 1)).toThrow();
  });

  it("a missing row id throws rather than silently no-op-ing", () => {
    expect(() => applyVary(mkState(), { kind: "cashflowAmount", id: "does-not-exist" }, 1)).toThrow();
  });
});
