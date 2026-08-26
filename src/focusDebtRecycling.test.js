import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { eligibleDebtRecyclingLoans, buildDebtRecyclingFocus } from "./focusDebtRecycling.js";

// Minimal v3-shaped state factory — mirrors focusDebtPayoff.test.js's
// own mkState (kept separate, not shared — see solve.test.js's header
// on why fixtures aren't shared across Focus test files).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "Investment", include: true, owner: "client",
    distributions: "reinvest", balance: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function employmentRow(over = {}) {
  return {
    id: "i1", label: "Salary", owner: "client", amount: 150000, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
    indexBasis: "cpi", indexExtraPct: 0, incomeType: "employment", sgApplies: false,
    ...over,
  };
}

function loan(over = {}) {
  return {
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 400000, interestRatePct: 6, termYears: 25, repayment: "pi",
    ioYears: 0, deductiblePct: 0, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    creditLimit: null, drawdowns: [], repaymentAllocation: "proportional",
    recycling: {
      enabled: true, from: { kind: "age", age: 40 }, to: { kind: "age", age: 60 },
      destinationAssetId: "a1", matchRepayments: true, annualCap: null,
    },
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
      income: over.income ?? [employmentRow()],
      expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [],
    },
    settings: {
      surplus: over.surplus ?? { mode: "accumulate", assetId: null },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("eligibleDebtRecyclingLoans", () => {
  it("filters to loans with recycling actually enabled", () => {
    const state = mkState({
      liabilities: [loan({ id: "lb1" }), loan({ id: "lb2", recycling: { ...loan().recycling, enabled: false } })],
    });
    expect(eligibleDebtRecyclingLoans(state).map((l) => l.id)).toEqual(["lb1"]);
  });
});

describe("buildDebtRecyclingFocus", () => {
  it("returns null for an unknown liability id, and for a loan that isn't recycling", () => {
    const state = mkState({ liabilities: [loan()] });
    const out = projectPlan(state);
    expect(buildDebtRecyclingFocus({ out, state, liabilityId: "nope" })).toBeNull();
    const notRecycling = mkState({ liabilities: [loan({ recycling: { ...loan().recycling, enabled: false } })] });
    expect(buildDebtRecyclingFocus({ out: projectPlan(notRecycling), state: notRecycling, liabilityId: "lb1" })).toBeNull();
  });

  it("the deductible proportion in the series matches the engine's own investmentBalance/privateBalance", () => {
    const state = mkState({ liabilities: [loan()] });
    const out = projectPlan(state);
    const f = buildDebtRecyclingFocus({ out, state, liabilityId: "lb1" });
    for (let y = 0; y < out.yearly.length; y++) {
      const row = out.yearly[y].liabilities.lb1;
      const total = row.investmentBalance + row.privateBalance;
      const expectedDeductibleInterest = total > 0 ? row.interest * (row.investmentBalance / total) : 0;
      expect(f.series[y].deductibleInterest).toBeCloseTo(expectedDeductibleInterest, 6);
    }
  });

  it("both arms reconcile to real, independent projectPlan() runs — not a hand-derived approximation", () => {
    const state = mkState({ liabilities: [loan()] });
    const out = projectPlan(state);
    const f = buildDebtRecyclingFocus({ out, state, liabilityId: "lb1" });
    // The "with recycling" arm's total debt IS the real projection's own figure.
    for (let y = 0; y < out.yearly.length; y++) {
      expect(f.series[y].totalDebt).toBeCloseTo(out.yearly[y].liabilities.lb1.closing, 6);
    }
    // The "without" arm genuinely differs — a separate run, not a copy.
    const last = f.series.length - 1;
    expect(f.series[last].totalDebtWithout).toBeLessThan(f.series[last].totalDebt - 1000);
    expect(f.series[last].investmentBalance).toBeGreaterThan(f.series[last].investmentBalanceWithout + 1000);
  });

  it("total debt stays materially flat WITH recycling, but declines normally WITHOUT it — the whole point of the strategy, visible in the series", () => {
    const state = mkState({ endAge: 46, liabilities: [loan()] });
    const out = projectPlan(state);
    const f = buildDebtRecyclingFocus({ out, state, liabilityId: "lb1" });
    const last = f.series.length - 1;
    expect(f.series[last].totalDebt).toBeGreaterThan(f.series[0].totalDebt * 0.85);
    expect(f.series[last].totalDebtWithout).toBeLessThan(f.series[0].totalDebtWithout * 0.85);
  });

  it("break-even, when reached, matches the year the plotted series shows the recycled arm's net worth catching up", () => {
    const state = mkState({ endAge: 65, liabilities: [loan({ balance: 100000, termYears: 15 })] });
    const out = projectPlan(state);
    const f = buildDebtRecyclingFocus({ out, state, liabilityId: "lb1" });
    if (f.breakEven) {
      const clone = structuredClone(state);
      clone.liabilities[0].recycling = { ...clone.liabilities[0].recycling, enabled: false };
      const withoutOut = projectPlan(clone);
      const y = f.breakEven.year;
      expect(out.yearly[y].netAssets).toBeGreaterThanOrEqual(withoutOut.yearly[y].netAssets);
      if (y > 0) expect(out.yearly[y - 1].netAssets).toBeLessThan(withoutOut.yearly[y - 1].netAssets);
    }
  });

  it("breakEven is either null or a real year within the projection, whether the strategy's own investment return beats the borrowing cost or not", () => {
    // The strategy's own stated risk: it depends on the investment
    // return exceeding the after-tax borrowing cost. Sweep a losing
    // (negative real return) and a winning (positive) destination
    // asset — either way, breakEven must be a structurally valid
    // answer, not a crash or an out-of-range year.
    for (const growthPct of [-5, 5]) {
      const asset = mkAsset({ allocation: { mode: "custom", incomePct: 0, growthPct, frankingPct: 0, volBasis: "Balanced" } });
      const state = mkState({ endAge: 55, assets: [asset], liabilities: [loan({ interestRatePct: 8, balance: 400000, termYears: 25 })] });
      const out = projectPlan(state);
      const f = buildDebtRecyclingFocus({ out, state, liabilityId: "lb1" });
      if (f.breakEven != null) {
        expect(f.breakEven.year).toBeGreaterThanOrEqual(0);
        expect(f.breakEven.year).toBeLessThan(out.yearly.length);
      }
    }
  });
});
