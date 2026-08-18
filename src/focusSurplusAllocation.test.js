import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import {
  surplusDestinationBreakdown, buildSurplusAllocationFocus,
  projectSingleDestinationAlternative, nonDeductibleFirstBenefit,
} from "./focusSurplusAllocation.js";

// Minimal v3-shaped state factory, periods-array surplus shape (the
// shape schedule.js/deterministic.js actually read) — kept local, not
// shared with other Focus test files, matching their own stated
// convention (see focusDebtPayoff.test.js's header).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    balance: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function loan(over = {}) {
  return {
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 100000, interestRatePct: 6, termYears: 20, repayment: "pi",
    ioYears: 0, deductiblePct: 0, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    ...over,
  };
}

function period(over = {}) {
  return {
    id: "sp1", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
    payNonDeductibleDebtFirst: false, debtOrder: "interestRate",
    allocations: [], remainderTo: "cash",
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
      workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 },
      ...over.plan,
    },
    assets,
    goals: over.goals ?? [],
    liabilities: over.liabilities ?? [],
    properties: [],
    cashflows: {
      income: over.income ?? [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [],
      ...over.cashflows,
    },
    settings: {
      surplus: { periods: over.periods ?? [period()] },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
      deficit: { minimumBalances: {}, sellRule: "order" },
      ...over.settings,
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

function employmentRow(over = {}) {
  return {
    id: "i1", label: "Salary", owner: "client", amount: 120000, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
    indexBasis: "none", indexExtraPct: 0, incomeType: "employment", sgApplies: false,
    ...over,
  };
}

describe("surplusDestinationBreakdown", () => {
  it("returns one entry per destination that actually received a nonzero amount", () => {
    const row = {
      perAssetDetail: { a1: { surplusInvested: 500 } },
      liabilities: { lb1: { surplusRepayment: 0 } },
      superDetail: {},
      goals: {},
      surplusSpent: 0,
      surplusAccumulated: 200,
    };
    const state = mkState({ liabilities: [loan()] });
    const items = surplusDestinationBreakdown(row, state);
    expect(items).toEqual([
      { label: "Savings", amount: 500 },
      { label: "Cash", amount: 200 },
    ]);
  });

  it("returns [] for a null/undefined row", () => {
    expect(surplusDestinationBreakdown(null, mkState())).toEqual([]);
  });
});

describe("buildSurplusAllocationFocus", () => {
  it("builds one entry per plan year, summing to the same total as manual iteration", () => {
    const state = mkState({
      income: [employmentRow()],
      periods: [period({ remainderTo: "cash" })],
    });
    const out = projectPlan(state);
    const focus = buildSurplusAllocationFocus({ out, state });
    expect(focus.years.length).toBe(out.yearly.length);
    const manualTotal = out.yearly.reduce((s, row) => s + (row.surplusAccumulated ?? 0), 0);
    expect(focus.totalSwept).toBeCloseTo(manualTotal, 2);
  });
});

describe("projectSingleDestinationAlternative", () => {
  it("sends 100% of surplus to the nominated asset regardless of the configured periods", () => {
    const state = mkState({
      assets: [mkAsset({ id: "a1" }), mkAsset({ id: "a2", name: "Portfolio" })],
      income: [employmentRow()],
      // Configured to send everything to cash — the alternative should
      // override this entirely.
      periods: [period({ remainderTo: "cash" })],
    });
    const alt = projectSingleDestinationAlternative(state, { targetType: "asset", targetId: "a2" });
    const totalToA2 = alt.yearly.reduce((s, row) => s + (row.perAssetDetail?.a2?.surplusInvested ?? 0), 0);
    const totalToCash = alt.yearly.reduce((s, row) => s + (row.surplusAccumulated ?? 0), 0);
    expect(totalToA2).toBeGreaterThan(0);
    expect(totalToCash).toBe(0);
  });
});

describe("nonDeductibleFirstBenefit", () => {
  it("returns null when no period has the rule on", () => {
    const state = mkState({
      liabilities: [loan({ id: "lb1", deductiblePct: 100 }), loan({ id: "lb2", deductiblePct: 0 })],
      periods: [period({ payNonDeductibleDebtFirst: false })],
    });
    const out = projectPlan(state);
    expect(nonDeductibleFirstBenefit(state, out)).toBeNull();
  });

  it("returns null when the client holds only one kind of debt", () => {
    const state = mkState({
      liabilities: [loan({ id: "lb1", deductiblePct: 0 })],
      periods: [period({ payNonDeductibleDebtFirst: true })],
    });
    const out = projectPlan(state);
    expect(nonDeductibleFirstBenefit(state, out)).toBeNull();
  });

  it("returns a figure (and its disclosure note) when both debt types exist and the rule is on", () => {
    // Non-deductible carries the HIGHER rate here (a plain debt-avalanche
    // case) — paying it down first is then optimal on BOTH the after-tax
    // basis (the feature's real premise) AND total pre-tax interest,
    // giving a directional result this test can safely assert without
    // overclaiming what "non-deductible first" guarantees in general
    // (it does not always minimise pre-tax interest — only after-tax
    // cost — when rates run the other way).
    const state = mkState({
      income: [employmentRow()],
      liabilities: [
        loan({ id: "lb1", name: "Investment loan", balance: 100000, interestRatePct: 5, deductiblePct: 100 }),
        loan({ id: "lb2", name: "Home loan", balance: 100000, interestRatePct: 8, deductiblePct: 0 }),
      ],
      // Once non-deductible debt clears, the REST of the surplus keeps
      // going to the (deductible) investment loan rather than
      // evaporating to cash — the realistic configuration this feature
      // is meant to compare against a pro-rata split of the SAME total.
      periods: [period({
        payNonDeductibleDebtFirst: true,
        allocations: [{ id: "sa1", targetType: "liability", targetId: "lb1", pct: 100 }],
        remainderTo: "cash",
      })],
    });
    const out = projectPlan(state);
    const result = nonDeductibleFirstBenefit(state, out);
    expect(result).not.toBeNull();
    expect(typeof result.interestSaved).toBe("number");
    expect(result.note).toMatch(/pro-rata/i);
    expect(result.interestSaved).toBeGreaterThan(0);
  });
});
