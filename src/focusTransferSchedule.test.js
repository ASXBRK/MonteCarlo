import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { cashReceivedSums } from "./cashflowStatement.js";
import {
  buildTransferScheduleFocus, defaultTransferScheduleYear, perFortnight, perMonth,
} from "./focusTransferSchedule.js";

function incomeRow(over = {}) {
  return {
    id: "i1", label: "Salary", owner: "client", amount: 120000, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
    indexBasis: "cpi", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
    ...over,
  };
}

function expenseRow(over = {}) {
  return {
    id: "e1", label: "Groceries", category: "groceryFuel", amount: 500, frequency: "monthly",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "cpi", indexExtraPct: 0,
    ...over,
  };
}

function mkState(over = {}) {
  return {
    plan: {
      household: "single",
      client: { currentAge: 40 },
      partner: null,
      endAge: 44,
      start: { year: 2026, month: 7 },
      superAccounts: [],
      workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
      implementation: { totalCashAvailable: 0, emergencyFundTarget: 0, allocations: [] },
      ...over.plan,
    },
    assets: over.assets ?? [],
    goals: over.goals ?? [],
    liabilities: over.liabilities ?? [],
    properties: over.properties ?? [],
    cashflows: {
      income: [incomeRow()], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [],
      ...over.cashflows,
    },
    settings: {
      surplus: over.surplus ?? { mode: "accumulate", assetId: null },
      fundingOrder: [],
    },
    assumptions: { cpi: 0.025, awote: 0.035, mortgageRate: 0.06, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("perFortnight / perMonth", () => {
  it("fortnightly = annual ÷ 26, monthly = annual ÷ 12", () => {
    expect(perFortnight(26000)).toBeCloseTo(1000, 6);
    expect(perMonth(12000)).toBeCloseTo(1000, 6);
  });
});

describe("defaultTransferScheduleYear", () => {
  it("year 0 when the plan starts in July (a full first year)", () => {
    const state = mkState({ plan: { start: { year: 2026, month: 7 } } });
    expect(defaultTransferScheduleYear(state, 5)).toBe(0);
  });
  it("year 1 when the plan starts mid-FY (a partial first year), if more than one year exists", () => {
    const state = mkState({ plan: { start: { year: 2026, month: 10 } } });
    expect(defaultTransferScheduleYear(state, 5)).toBe(1);
  });
  it("falls back to year 0 for a partial first year if it's the ONLY year", () => {
    const state = mkState({ plan: { start: { year: 2026, month: 10 } } });
    expect(defaultTransferScheduleYear(state, 1)).toBe(0);
  });
});

describe("buildTransferScheduleFocus", () => {
  it("returns null when the projection has no years", () => {
    expect(buildTransferScheduleFocus({ out: { yearly: [] }, state: mkState() })).toBeNull();
  });

  it("take-home pay (summed across a person's own salary rows) matches the Cashflow table's own regularTakeHomePay figure — even split across TWO salary rows for the same person", () => {
    const state = mkState({
      cashflows: {
        income: [
          incomeRow({ id: "i1", label: "Primary job", amount: 80000 }),
          incomeRow({ id: "i2", label: "Side job", amount: 40000 }),
        ],
        expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [],
      },
    });
    const out = projectPlan(state);
    const f = buildTransferScheduleFocus({ out, state, year: 0 });
    expect(f).not.toBeNull();

    const salarySources = f.sources.filter((s) => s.id === "i1" || s.id === "i2");
    expect(salarySources).toHaveLength(2);
    const summedTakeHome = salarySources.reduce((s, r) => s + r.annual, 0);

    const cashReceived = cashReceivedSums(out.yearly[0], {
      incomeRows: state.cashflows.income, rowTotalsIncome: out.schedule.rowTotals.income, y: 0,
    });
    expect(summedTakeHome).toBeCloseTo(cashReceived.regularTakeHomePay, 2);

    // Split proportional to each row's own gross share — the $80k row
    // should carry exactly 2× the PAYG deduction of the $40k row.
    const i1 = f.sources.find((s) => s.id === "i1");
    const i2 = f.sources.find((s) => s.id === "i2");
    const paygOnI1 = 80000 - i1.annual;
    const paygOnI2 = 40000 - i2.annual;
    expect(paygOnI1).toBeCloseTo(2 * paygOnI2, 2);
  });

  it("non-salary income rows are received in full (no PAYG deducted) — the same disclosed simplification as the Cashflow table", () => {
    const state = mkState({
      cashflows: {
        income: [incomeRow({ id: "i1" }), incomeRow({
          id: "i2", label: "Bank interest", category: "interestIncome", incomeType: "otherTaxable", amount: 3000,
        })],
        expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [],
      },
    });
    const out = projectPlan(state);
    const f = buildTransferScheduleFocus({ out, state, year: 0 });
    const interest = f.sources.find((s) => s.id === "i2");
    expect(interest.annual).toBeCloseTo(3000, 2);
  });

  it("sources reconcile to destinations plus residual", () => {
    const state = mkState({
      liabilities: [{
        id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
        balance: 100000, interestRatePct: 6, termYears: 10, repayment: "pi",
        ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
        extraRepayments: [], oneOffRepayments: [],
      }],
      cashflows: {
        income: [incomeRow()],
        expenses: [expenseRow()],
        deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [],
      },
    });
    const out = projectPlan(state);
    const f = buildTransferScheduleFocus({ out, state, year: 0 });
    expect(f.sourcesTotal).toBeCloseTo(f.destinationsTotal + f.residual, 6);
    // Fortnightly figures are the annual ledger ÷ 26.
    expect(perFortnight(f.sourcesTotal)).toBeCloseTo(f.sourcesTotal / 26, 6);
    expect(perFortnight(f.destinationsTotal)).toBeCloseTo(f.destinationsTotal / 26, 6);
  });

  it("HELP/HECS never appears as a destination — its repayment is already withheld via PAYG, not a household-initiated transfer", () => {
    const state = mkState({
      cashflows: {
        income: [incomeRow({ amount: 100000 })],
        expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [],
      },
      plan: { start: { year: 2026, month: 7 }, client: { currentAge: 40, helpBalance: 20000 } },
    });
    const out = projectPlan(state);
    const f = buildTransferScheduleFocus({ out, state, year: 0 });
    expect(f.destinations.some((d) => d.id === "help_client" || d.id === "help_partner")).toBe(false);
  });

  it("a loan repayment, a super contribution, and a goal accrual each surface as their own destination row", () => {
    const state = mkState({
      liabilities: [{
        id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
        balance: 100000, interestRatePct: 6, termYears: 10, repayment: "pi",
        ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
        extraRepayments: [], oneOffRepayments: [],
      }],
      goals: [{ id: "g1", label: "Wedding", targetAmount: 20000, targetAt: { kind: "age", age: 42 }, fundedFrom: "surplus", indexBasis: "none", indexExtraPct: 0 }],
      plan: {
        start: { year: 2026, month: 7 },
        superAccounts: [{ id: "su1", name: "Super — Client", owner: "client", balance: 0, taxFreeComponent: 0, allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" }, icrPct: 0, include: true }],
      },
      cashflows: {
        income: [incomeRow({ amount: 150000 })],
        expenses: [],
        deductions: [], contributions: [], withdrawals: [], lumpSums: [],
        superContributions: [{
          id: "sc1", accountId: "su1", owner: "client", type: "personalDeductible", basis: "amount",
          amount: 5000, percent: 0, incomeRowId: null, frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 }, indexBasis: "none", indexExtraPct: 0,
        }],
      },
    });
    const out = projectPlan(state);
    const f = buildTransferScheduleFocus({ out, state, year: 0 });
    expect(f.destinations.some((d) => d.id === "lb1" && d.kind === "loan")).toBe(true);
    expect(f.destinations.some((d) => d.id === "su1" && d.kind === "super")).toBe(true);
    expect(f.destinations.some((d) => d.id === "g1" && d.kind === "goal")).toBe(true);
  });

  it("the initial transfer column comes straight from Commit 2's implementation allocations, never re-derived", () => {
    const state = mkState({
      plan: {
        start: { year: 2026, month: 7 },
        implementation: {
          totalCashAvailable: 50000, emergencyFundTarget: 10000,
          allocations: [{ id: "al1", label: "Working cash top-up", amount: 10000, targetAssetId: "workingCash" }],
        },
      },
    });
    const out = projectPlan(state);
    const f = buildTransferScheduleFocus({ out, state, year: 0 });
    expect(f.initialTransfers).toEqual([{ id: "al1", label: "Working cash top-up", amount: 10000 }]);
  });
});
