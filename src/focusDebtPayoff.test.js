import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import {
  eligibleDebtPayoffLoans, buildDebtPayoffFocus, solveExtraRepaymentForPayoffDate,
} from "./focusDebtPayoff.js";

// Minimal v3-shaped state factory — mirrors focusDeposit.test.js's own
// mkState (kept separate, not shared — see solve.test.js's header for why).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    distributions: "reinvest", balance: 2_000_000,
    // Zero-real allocation, so a big asset's own growth never
    // contaminates the loan-focused assertions below.
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function loan(over = {}) {
  return {
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 100000, interestRatePct: 6, termYears: 10, repayment: "pi",
    ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    ...over,
  };
}

function extraRow(over = {}) {
  return {
    id: "er1", label: "Extra", amount: 500, frequency: "monthly",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 50 },
    indexBasis: "none", indexExtraPct: 0,
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
      endAge: over.endAge ?? 50,
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
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("eligibleDebtPayoffLoans", () => {
  it("filters to loans with an outstanding balance", () => {
    const state = mkState({ liabilities: [loan({ id: "lb1", balance: 100000 }), loan({ id: "lb2", balance: 0 })] });
    expect(eligibleDebtPayoffLoans(state).map((l) => l.id)).toEqual(["lb1"]);
  });
});

describe("buildDebtPayoffFocus", () => {
  it("returns null for an unknown liability id", () => {
    const state = mkState({ liabilities: [loan()] });
    const out = projectPlan(state);
    expect(buildDebtPayoffFocus({ out, state, liabilityId: "nope" })).toBeNull();
  });

  it("total interest reconciles to the sum of the engine's own per-year interest figures", () => {
    const state = mkState({ endAge: 51, liabilities: [loan({ termYears: 10 })] });
    const out = projectPlan(state);
    const f = buildDebtPayoffFocus({ out, state, liabilityId: "lb1" });
    const manualTotal = out.yearly.reduce((s, row) => s + (row.liabilities.lb1?.interest ?? 0), 0);
    expect(f.totalInterest).toBeCloseTo(manualTotal, 6);
    expect(f.totalInterest).toBeGreaterThan(0);
  });

  it("payoff date is the first year the engine's own balance reaches zero", () => {
    const state = mkState({ endAge: 51, liabilities: [loan({ termYears: 10 })] });
    const out = projectPlan(state);
    const f = buildDebtPayoffFocus({ out, state, liabilityId: "lb1" });
    expect(f.payoff).not.toBeNull();
    expect(out.yearly[f.payoff.year].liabilities.lb1.closing).toBeLessThanOrEqual(0.5);
    if (f.payoff.year > 0) expect(out.yearly[f.payoff.year - 1].liabilities.lb1.closing).toBeGreaterThan(0.5);
  });

  it("payoff is null when the loan outlives the projection", () => {
    const state = mkState({ endAge: 42, liabilities: [loan({ termYears: 25 })] });
    const out = projectPlan(state);
    const f = buildDebtPayoffFocus({ out, state, liabilityId: "lb1" });
    expect(f.payoff).toBeNull();
  });

  it("stats is null when no extras are configured — not a zero-effect result", () => {
    const state = mkState({ endAge: 51, liabilities: [loan({ termYears: 10 })] });
    const out = projectPlan(state);
    const f = buildDebtPayoffFocus({ out, state, liabilityId: "lb1" });
    expect(f.stats).toBeNull();
    expect(out.liabilityRepaymentStats.lb1).toBeUndefined();
  });

  it("stats reconciles to out.liabilityRepaymentStats exactly, read through not recomputed", () => {
    const state = mkState({ endAge: 51, liabilities: [loan({ termYears: 10, extraRepayments: [extraRow({ amount: 2000 })] })] });
    const out = projectPlan(state);
    const f = buildDebtPayoffFocus({ out, state, liabilityId: "lb1" });
    expect(f.stats).toEqual(out.liabilityRepaymentStats.lb1);
    expect(f.stats.interestSaved).toBeGreaterThan(0);
    expect(f.stats.timeSavedMonths).toBeGreaterThan(0);
  });

  it("the counterfactual balance series equals the actual series when there are no extras", () => {
    const state = mkState({ endAge: 51, liabilities: [loan({ termYears: 10 })] });
    const out = projectPlan(state);
    const f = buildDebtPayoffFocus({ out, state, liabilityId: "lb1" });
    for (const row of f.balanceSeries) expect(row.actual).toBeCloseTo(row.noExtras, 6);
  });

  it("the counterfactual balance series diverges (no-extras stays higher) once extras are configured", () => {
    const state = mkState({ endAge: 51, liabilities: [loan({ termYears: 10, extraRepayments: [extraRow({ amount: 2000 })] })] });
    const out = projectPlan(state);
    const f = buildDebtPayoffFocus({ out, state, liabilityId: "lb1" });
    const midYear = f.balanceSeries.find((r) => r.actual > 0 && r.actual < r.noExtras);
    expect(midYear).toBeTruthy();
    // The no-extras arm reaches the scheduled term; the actual arm pays
    // off strictly earlier.
    const noExtrasPayoffYear = f.balanceSeries.findIndex((r) => r.noExtras <= 0.5);
    expect(f.payoff.year).toBeLessThan(noExtrasPayoffYear);
  });

  it("never mutates the caller's state", () => {
    const state = mkState({ endAge: 51, liabilities: [loan({ termYears: 10, extraRepayments: [extraRow({ amount: 2000 })] })] });
    const before = JSON.stringify(state);
    const out = projectPlan(state);
    buildDebtPayoffFocus({ out, state, liabilityId: "lb1" });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("rollover is null for a variable loan, and reports the engine's own before/after figures for a fixed one (Implementation/Rates spec, Commit 1)", () => {
    const variable = mkState({ endAge: 51, liabilities: [loan({ termYears: 10 })] });
    const outVariable = projectPlan(variable);
    expect(buildDebtPayoffFocus({ out: outVariable, state: variable, liabilityId: "lb1" }).rollover).toBeNull();

    const fixed = mkState({
      endAge: 51,
      liabilities: [loan({
        termYears: 10, rateType: "fixed", fixedRatePct: 5, revertRatePct: 8,
        fixedUntil: { kind: "age", age: 43 },
      })],
    });
    const outFixed = projectPlan(fixed);
    const f = buildDebtPayoffFocus({ out: outFixed, state: fixed, liabilityId: "lb1" });
    expect(f.rollover).toEqual(outFixed.liabilityRollovers.lb1);
    expect(f.rollover.repaymentAfter).not.toBeCloseTo(f.rollover.repaymentBefore, 0);
  });
});

describe("solveExtraRepaymentForPayoffDate — What extra repayment clears this by [date]?", () => {
  it("produces an extra repayment that, when applied, clears the loan by (or before) the target age", () => {
    const state = mkState({ endAge: 51, liabilities: [loan({ termYears: 10 })] });
    const r = solveExtraRepaymentForPayoffDate({ state, liabilityId: "lb1", targetAge: 45 });
    expect(r.converged).toBe(true);
    expect(r.value).toBeGreaterThan(0);
    expect(r.unfunded).toBe(0);

    const applied = structuredClone(state);
    const l = applied.liabilities.find((x) => x.id === "lb1");
    l.extraRepayments = [
      ...l.extraRepayments,
      { id: "applied", label: "Extra", amount: r.value, frequency: "monthly", from: { kind: "age", age: 40 }, to: { kind: "age", age: 45 }, indexBasis: "none", indexExtraPct: 0 },
    ];
    const out = projectPlan(applied);
    const f = buildDebtPayoffFocus({ out, state: applied, liabilityId: "lb1" });
    expect(f.payoff).not.toBeNull();
    expect(f.payoff.age).toBeLessThanOrEqual(45);
  });

  it("a target already met without any extra repayment returns 0, not a spurious positive amount", () => {
    // Natural (no-extra) payoff for a 10-year loan from age 40 is age 50
    // — asking for "by 50" needs nothing extra.
    const state = mkState({ endAge: 51, liabilities: [loan({ termYears: 10 })] });
    const r = solveExtraRepaymentForPayoffDate({ state, liabilityId: "lb1", targetAge: 50 });
    expect(r.converged).toBe(true);
    expect(r.value).toBe(0);
    expect(r.unfunded).toBe(0);
  });

  it("affordability is surfaced honestly: a mathematically sufficient extra the household can't fund reports unfunded, not a clean success", () => {
    // No spare assets or income at all — mirrors deterministic.test.js's
    // own "an unaffordable extra repayment produces ... unfunded
    // cashflow" fixture. A very early target forces a large extra that
    // this household genuinely cannot source.
    const state = mkState({ endAge: 45, assets: [], liabilities: [loan({ termYears: 10 })] });
    const r = solveExtraRepaymentForPayoffDate({ state, liabilityId: "lb1", targetAge: 41 });
    if (r.converged) {
      expect(r.unfunded).toBeGreaterThan(0);
    } else {
      // Equally honest: findMinimumThreshold correctly refusing to
      // converge at all is not a failure of this test.
      expect(r.value).toBeNull();
    }
  });

  it("an unknown liability id reports non-convergence rather than throwing", () => {
    const state = mkState({ liabilities: [loan()] });
    const r = solveExtraRepaymentForPayoffDate({ state, liabilityId: "nope", targetAge: 45 });
    expect(r.converged).toBe(false);
    expect(r.value).toBeNull();
  });

  it("never mutates the caller's state", () => {
    const state = mkState({ endAge: 51, liabilities: [loan({ termYears: 10 })] });
    const before = JSON.stringify(state);
    solveExtraRepaymentForPayoffDate({ state, liabilityId: "lb1", targetAge: 45 });
    expect(JSON.stringify(state)).toBe(before);
  });
});
