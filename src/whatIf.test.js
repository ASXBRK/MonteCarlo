import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { runShock, buildDeltas, registerShockKind, eligibleRateShockLoans } from "./whatIf.js";

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
      wcaClosing: 1000 + i * 10, deficitFundedFromAssets: i === 2 ? 300 : 0,
    })),
    shortfall,
  });

  it("computes shocked-minus-base for every named field, per year", () => {
    const base = fakeOut([1000, 1100, 1200]);
    const shocked = fakeOut([900, 950, 1000]);
    const d = buildDeltas(base, shocked);
    expect(d.byYear).toHaveLength(3);
    expect(d.byYear[0]).toEqual({
      year: 0, netAssets: -100, closingBalance: -50, totalTax: 0, surplus: 0, unfundedCashflow: 0,
      wcaClosing: { base: 1000, shocked: 1000 }, deficitFunded: { base: 0, shocked: 0 },
    });
    expect(d.byYear[2].unfundedCashflow).toBe(0); // both have 200 at y=2 in this fixture — delta is 0
  });

  it("wcaClosing and deficitFunded carry BASE AND SHOCKED absolute values, not a delta — the cashflow lens plots both as their own lines", () => {
    const base = fakeOut([1000, 1100, 1200]);
    const shocked = fakeOut([900, 950, 1000]);
    // Give the shocked run its own distinct wcaClosing/deficitFundedFromAssets
    // so base and shocked genuinely differ, not just netAssets.
    shocked.yearly[1] = { ...shocked.yearly[1], wcaClosing: 5000, deficitFundedFromAssets: 750 };
    const d = buildDeltas(base, shocked);
    expect(d.byYear[1].wcaClosing).toEqual({ base: base.yearly[1].wcaClosing, shocked: 5000 });
    expect(d.byYear[1].deficitFunded).toEqual({ base: 0, shocked: 750 });
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

describe("Interest rate shocks (What-if spec, Commit 2)", () => {
  const bigAsset = () => mkAsset({
    allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" }, // = cpi, real 0
    balance: 2_000_000,
  });
  const loan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 100000, interestRatePct: 6, termYears: 10, repayment: "pi",
    ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    rateType: "variable", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 },
    revertRatePct: null, commencedOn: null,
    ...over,
  });
  const withLoan = (l, years = 6) => ({
    ...mkState({ endAge: 40 + years, assets: [bigAsset()], surplus: { mode: "accumulate", assetId: null } }),
    liabilities: [l],
  });

  it("a variable loan's interest changes from month one", () => {
    const state = withLoan(loan({ rateType: "variable", interestRatePct: 6 }));
    const { base, shocked } = runShock(state, { kind: "rateShock", deltaPct: 2 });
    expect(shocked.yearly[0].liabilities.lb1.ratePct).toBeCloseTo(8, 6);
    expect(base.yearly[0].liabilities.lb1.ratePct).toBeCloseTo(6, 6);
    expect(shocked.yearly[0].liabilities.lb1.interest).toBeGreaterThan(base.yearly[0].liabilities.lb1.interest);
  });

  it("a fixed loan's rate is unchanged until its own rollover month, and changes after — a uniform shock would erase this differential", () => {
    const l = loan({ rateType: "fixed", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: 6.5 });
    const state = withLoan(l, 6);
    const { base, shocked } = runShock(state, { kind: "rateShock", deltaPct: 2 });
    // Fixed period (years 0-2, rollover at age 43 = year 3): untouched.
    for (const y of [0, 1, 2]) {
      expect(shocked.yearly[y].liabilities.lb1.ratePct).toBeCloseTo(base.yearly[y].liabilities.lb1.ratePct, 6);
      expect(shocked.yearly[y].liabilities.lb1.ratePct).toBeCloseTo(6, 6);
    }
    // After rollover: shocked reverts into 6.5+2=8.5%, base into 6.5%.
    expect(shocked.yearly[3].liabilities.lb1.ratePct).toBeCloseTo(8.5, 6);
    expect(base.yearly[3].liabilities.lb1.ratePct).toBeCloseTo(6.5, 6);
  });

  it("a revert-rate shock leaves the fixed period untouched and leaves variable loans completely alone", () => {
    const fixed = loan({ id: "lb1", rateType: "fixed", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: 6.5 });
    const variable = loan({ id: "lb2", rateType: "variable", interestRatePct: 7, balance: 50000 });
    const state = {
      ...mkState({ endAge: 46, assets: [bigAsset()], surplus: { mode: "accumulate", assetId: null } }),
      liabilities: [fixed, variable],
    };
    const { base, shocked } = runShock(state, { kind: "revertRateShock", deltaPct: 1.5 });
    for (const y of [0, 1, 2]) {
      expect(shocked.yearly[y].liabilities.lb1.ratePct).toBeCloseTo(6, 6);
    }
    expect(shocked.yearly[3].liabilities.lb1.ratePct).toBeCloseTo(8, 6); // 6.5 + 1.5
    // Variable loan (lb2) is completely untouched by a revert-rate shock.
    for (let y = 0; y < 4; y++) {
      expect(shocked.yearly[y].liabilities.lb2.ratePct).toBeCloseTo(base.yearly[y].liabilities.lb2.ratePct, 6);
      expect(shocked.yearly[y].liabilities.lb2.ratePct).toBeCloseTo(7, 6);
    }
  });

  it("a shock large enough to make repayments unaffordable produces unfunded cashflow rather than silently succeeding", () => {
    // Income covers the base 6% repayment ($500k/25y ≈ $38.6k/year)
    // comfortably, but not the +5pp shocked 11% repayment (≈$58.8k/year)
    // — a shock genuinely breaking affordability, not just widening an
    // already-comfortable margin.
    const tightAsset = mkAsset({
      allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" },
      balance: 1000,
    });
    const income = [{
      id: "sal1", label: "Salary", owner: "client", amount: 60000, frequency: "annual",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
      indexBasis: "none", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
    }];
    const l = loan({ rateType: "variable", interestRatePct: 6, balance: 500000, termYears: 25 });
    const state = {
      ...mkState({
        endAge: 45, assets: [tightAsset],
        plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
        cashflows: { income, expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [] },
        surplus: { mode: "accumulate", assetId: null },
      }),
      liabilities: [l],
    };
    const { base, shocked } = runShock(state, { kind: "rateShock", deltaPct: 5 });
    expect(base.shortfall).toBeNull();
    expect(shocked.shortfall).not.toBeNull();
    expect(shocked.shortfall.total).toBeGreaterThan(0);
  });
});

describe("eligibleRateShockLoans", () => {
  it("filters to liabilities with an outstanding balance", () => {
    const state = { liabilities: [{ id: "lb1", balance: 100000 }, { id: "lb2", balance: 0 }] };
    expect(eligibleRateShockLoans(state).map((l) => l.id)).toEqual(["lb1"]);
  });
});

describe("Income interruption (What-if spec, Commit 4)", () => {
  const salaryRow = (over = {}) => ({
    id: "sal1", label: "Salary", owner: "client", amount: 8000, frequency: "monthly",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
    indexBasis: "none", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
    ...over,
  });
  const withIncome = (income, over = {}) => ({
    ...mkState({ endAge: 46, assets: [mkAsset({ balance: 500000 })], ...over }),
    cashflows: { income, expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [] },
  });

  it("reduces income by exactly (1 - replacementPct) for exactly the gap year(s), no earlier and no later", () => {
    const state = withIncome([salaryRow()]);
    const { base, shocked } = runShock(state, { kind: "incomeGap", ownerId: "client", atAge: 42, months: 12, replacementPct: 50 });
    const gapYear = 2; // age 42 - currentAge 40
    for (const y of [0, 1]) expect(shocked.yearly[y].income).toBeCloseTo(base.yearly[y].income, 2);
    expect(shocked.yearly[gapYear].income).toBeCloseTo(base.yearly[gapYear].income * 0.5, 1);
    for (const y of [3, 4, 5]) expect(shocked.yearly[y].income).toBeCloseTo(base.yearly[y].income, 2);
  });

  it("replacementPct: 0 fully stops income for the gap year; 100 leaves it untouched", () => {
    const state = withIncome([salaryRow()]);
    const stopped = runShock(state, { kind: "incomeGap", ownerId: "client", atAge: 42, months: 12, replacementPct: 0 });
    const untouched = runShock(state, { kind: "incomeGap", ownerId: "client", atAge: 42, months: 12, replacementPct: 100 });
    expect(stopped.shocked.yearly[2].income).toBeCloseTo(0, 1);
    expect(untouched.shocked.yearly[2].income).toBeCloseTo(untouched.base.yearly[2].income, 1);
  });

  it("only affects the named owner's salary rows — a partner's own income and other income categories are untouched", () => {
    const other = salaryRow({ id: "sal2", label: "Other income", category: "otherIncome", incomeType: "otherTaxable", amount: 1000 });
    const partnerSalary = salaryRow({ id: "sal3", owner: "partner" });
    const state = withIncome([salaryRow(), other, partnerSalary], {
      plan: { household: "couple", partner: { currentAge: 38 } },
    });
    const { base, shocked } = runShock(state, { kind: "incomeGap", ownerId: "client", atAge: 42, months: 12, replacementPct: 0 });
    // The client's salary drops to 0 for the gap year, but total income
    // doesn't drop to 0 — the other row and the partner's row keep flowing.
    expect(shocked.yearly[2].income).toBeGreaterThan(0);
    expect(shocked.yearly[2].income).toBeLessThan(base.yearly[2].income);
  });

  it("a gap large enough to break affordability produces unfunded cashflow the base run never sees", () => {
    const tightAsset = mkAsset({ balance: 500, allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" } });
    const expenses = [{
      id: "e1", label: "Living", category: "groceryFuel", amount: 4000, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "none", indexExtraPct: 0,
    }];
    const state = {
      ...withIncome([salaryRow({ amount: 6000 })], {
        assets: [tightAsset],
        plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      }),
      cashflows: { income: [salaryRow({ amount: 6000 })], expenses, deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [] },
    };
    const { base, shocked } = runShock(state, { kind: "incomeGap", ownerId: "client", atAge: 42, months: 12, replacementPct: 0 });
    expect(base.shortfall).toBeNull();
    expect(shocked.shortfall).not.toBeNull();
    expect(shocked.shortfall.total).toBeGreaterThan(0);
  });

  it("never mutates the caller's state", () => {
    const state = withIncome([salaryRow()]);
    const before = JSON.stringify(state);
    runShock(state, { kind: "incomeGap", ownerId: "client", atAge: 42, months: 12, replacementPct: 50 });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("Expense shock (What-if spec, Commit 4)", () => {
  const expenseRow = (over = {}) => ({
    id: "e1", label: "Groceries", category: "groceryFuel", amount: 1000, frequency: "monthly",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "cpi", indexExtraPct: 0,
    ...over,
  });
  const withExpenses = (expenses, over = {}) => ({
    ...mkState({ endAge: 45, assets: [mkAsset({ balance: 500000 })], ...over }),
    cashflows: { income: [], expenses, deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [] },
  });

  it("scales every expense row by exactly (1+pct/100), for the whole projection", () => {
    const state = withExpenses([expenseRow({ amount: 1000 }), expenseRow({ id: "e2", amount: 500 })]);
    const { base, shocked } = runShock(state, { kind: "expenseShock", pct: 10 });
    for (let y = 0; y < base.yearly.length; y++) {
      expect(shocked.yearly[y].expenses).toBeCloseTo(base.yearly[y].expenses * 1.10, 1);
    }
  });

  it("scales an INDEXED row's trajectory proportionally, not just its year-0 figure", () => {
    // indexExtraPct above CPI so the row genuinely grows in real terms —
    // proves the shock scales the base amount (carrying through every
    // future year's indexation), not a one-off year-0 adjustment.
    const state = withExpenses([expenseRow({ indexBasis: "cpi", indexExtraPct: 3 })]);
    const { base, shocked } = runShock(state, { kind: "expenseShock", pct: -10 });
    for (let y = 0; y < base.yearly.length; y++) {
      expect(shocked.yearly[y].expenses).toBeCloseTo(base.yearly[y].expenses * 0.90, 1);
    }
    // The base itself is genuinely growing in real terms year over year
    // (confirms this test fixture actually exercises indexation).
    expect(base.yearly[4].expenses).toBeGreaterThan(base.yearly[0].expenses);
  });

  it("a large enough expense increase produces unfunded cashflow the base run never sees", () => {
    const tightAsset = mkAsset({ balance: 500, allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" } });
    const income = [{
      id: "sal1", label: "Salary", owner: "client", amount: 60000, frequency: "annual",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
      indexBasis: "none", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
    }];
    const state = {
      ...withExpenses([expenseRow({ amount: 3500, indexBasis: "none" })], {
        assets: [tightAsset],
        plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      }),
      cashflows: { income, expenses: [expenseRow({ amount: 3500, indexBasis: "none" })], deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [] },
    };
    const { base, shocked } = runShock(state, { kind: "expenseShock", pct: 50 });
    expect(base.shortfall).toBeNull();
    expect(shocked.shortfall).not.toBeNull();
    expect(shocked.shortfall.total).toBeGreaterThan(0);
  });

  it("never mutates the caller's state", () => {
    const state = withExpenses([expenseRow()]);
    const before = JSON.stringify(state);
    runShock(state, { kind: "expenseShock", pct: 25 });
    expect(JSON.stringify(state)).toBe(before);
  });
});
