import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { runShock } from "./whatIf.js";
import { bufferBreach, incomeGapHeadline, expenseShockHeadline, rateShockHeadline } from "./whatIfCashflowLens.js";

// --- Pure unit tests against hand-built fixtures ----------------------------

function fakeOut(deficitFundedSeries, extra = {}) {
  return {
    yearly: deficitFundedSeries.map((deficitFundedFromAssets, y) => ({
      deficitFundedFromAssets, unfundedCashflow: 0,
      surplusOrDeficit: 0, expenses: 0, liabilities: {},
      ...(extra.perYear?.[y] ?? {}),
    })),
    ...extra.out,
  };
}

describe("bufferBreach", () => {
  it("fires at the first year money had to be drawn from other assets to top up the working cash account", () => {
    const out = fakeOut([0, 0, 1500, 0]);
    expect(bufferBreach(out)).toEqual({ breached: true, year: 2 });
  });

  it("reports not breached when the buffer never needed external funding", () => {
    const out = fakeOut([0, 0, 0]);
    expect(bufferBreach(out)).toEqual({ breached: false, year: null });
  });

  it("also fires on a genuine shortfall (unfundedCashflow), not only a successful draw", () => {
    const out = fakeOut([0, 0], { perYear: [{}, { unfundedCashflow: 2000 }] });
    expect(bufferBreach(out)).toEqual({ breached: true, year: 1 });
  });

  it("does not fire on the WCA's reported closing balance alone — this engine floors it at its own minimum by construction, so that comparison would never fire", () => {
    // wcaClosing sitting exactly at a hypothetical minimum is NOT, on
    // its own, evidence of a breach — only deficitFundedFromAssets/
    // unfundedCashflow are.
    const out = fakeOut([0, 0], { perYear: [{ wcaClosing: 3000 }, { wcaClosing: 3000 }] });
    expect(bufferBreach(out)).toEqual({ breached: false, year: null });
  });
});

describe("incomeGapHeadline", () => {
  const deltasWith = (deficitFundedPairs) => ({
    byYear: deficitFundedPairs.map((d) => ({ deficitFunded: d })),
    headline: { base: { endNetAssets: 1_000_000 }, shocked: { endNetAssets: 940_000 } },
  });

  it("total cash drawn sums the INCREMENTAL draw (shocked minus base), not the shocked run's whole total", () => {
    const deltas = deltasWith([
      { base: 0, shocked: 0 },
      { base: 500, shocked: 8500 }, // +8000 attributable to the gap
      { base: 0, shocked: 1200 },   // +1200
    ]);
    const shocked = fakeOut([0, 8500, 1200]);
    const h = incomeGapHeadline({ shocked, deltas });
    expect(h.totalCashDrawn).toBeCloseTo(9200, 2);
  });

  it("clamps total cash drawn at 0 rather than going negative", () => {
    const deltas = deltasWith([{ base: 500, shocked: 100 }]); // shocked drew LESS than base — never negative
    const h = incomeGapHeadline({ shocked: fakeOut([100]), deltas });
    expect(h.totalCashDrawn).toBe(0);
  });

  it("reports the buffer held when the shocked run never needed to draw from other assets", () => {
    const deltas = deltasWith([{ base: 0, shocked: 0 }, { base: 0, shocked: 0 }]);
    const shocked = fakeOut([0, 0]);
    const h = incomeGapHeadline({ shocked, deltas });
    expect(h.bufferHeld).toBe(true);
    expect(h.breachYear).toBeNull();
  });

  it("reports the exact year the buffer was breached", () => {
    const deltas = deltasWith([{ base: 0, shocked: 0 }, { base: 0, shocked: 500 }, { base: 0, shocked: 500 }]);
    const shocked = fakeOut([0, 500, 500]);
    const h = incomeGapHeadline({ shocked, deltas });
    expect(h.bufferHeld).toBe(false);
    expect(h.breachYear).toBe(1);
  });

  it("permanent cost is the shocked-minus-base end net assets gap", () => {
    const deltas = deltasWith([{ base: 0, shocked: 0 }]);
    const h = incomeGapHeadline({ shocked: fakeOut([0]), deltas });
    expect(h.permanentCost).toBe(940_000 - 1_000_000);
  });
});

describe("expenseShockHeadline", () => {
  const base = (surplusSeries, expensesSeries) => fakeOut(surplusSeries.map(() => 0), {
    perYear: surplusSeries.map((s, y) => ({ surplusOrDeficit: s, expenses: expensesSeries[y] })),
  });

  it("finds the first year surplus turns negative under the shock", () => {
    const shocked = base([500, 200, -100, -300], [1000, 1000, 1000, 1000]);
    const baseRun = base([500, 400, 300, 200], [900, 900, 900, 900]);
    const deltas = { headline: { base: { endNetAssets: 500_000 }, shocked: { endNetAssets: 420_000 } } };
    const h = expenseShockHeadline({ base: baseRun, shocked, deltas });
    expect(h.firstNegativeSurplusYear).toBe(2);
  });

  it("returns null when surplus never turns negative under the shock", () => {
    const shocked = base([500, 200, 100], [1000, 1000, 1000]);
    const baseRun = base([600, 400, 300], [900, 900, 900]);
    const deltas = { headline: { base: { endNetAssets: 1 }, shocked: { endNetAssets: 1 } } };
    expect(expenseShockHeadline({ base: baseRun, shocked, deltas }).firstNegativeSurplusYear).toBeNull();
  });

  it("total additional spending sums the per-year expenses delta, including indexation drift already baked into each row.expenses", () => {
    const baseRun = base([0, 0, 0], [10000, 10250, 10506]); // ~2.5% real growth already applied
    const shocked = base([0, 0, 0], [11000, 11275, 11557]); // 10% higher, every year
    const deltas = { headline: { base: { endNetAssets: 0 }, shocked: { endNetAssets: 0 } } };
    const h = expenseShockHeadline({ base: baseRun, shocked, deltas });
    expect(h.totalAdditionalSpending).toBeCloseTo(1000 + 1025 + 1051, 0);
  });

  it("permanent cost matches the headline end-net-assets gap", () => {
    const baseRun = base([0], [0]);
    const shocked = base([0], [0]);
    const deltas = { headline: { base: { endNetAssets: 800_000 }, shocked: { endNetAssets: 750_000 } } };
    expect(expenseShockHeadline({ base: baseRun, shocked, deltas }).permanentCost).toBe(-50_000);
  });
});

describe("rateShockHeadline", () => {
  const withLoans = (perYearLoans) => fakeOut(perYearLoans.map(() => 0), {
    perYear: perYearLoans.map((liabilities) => ({ liabilities })),
  });

  it("finds the first year household repayments actually differ, immediately for a variable loan", () => {
    const base = withLoans([{ l1: { interest: 500, principal: 300 } }, { l1: { interest: 480, principal: 320 } }]);
    const shocked = withLoans([{ l1: { interest: 700, principal: 300 } }, { l1: { interest: 680, principal: 320 } }]);
    const deltas = { headline: { base: { totalUnfunded: 0 }, shocked: { totalUnfunded: 0 } } };
    const h = rateShockHeadline({ base, shocked, deltas });
    expect(h.firstAffectedYear).toBe(0);
    expect(h.changeInRepayments).toBeCloseTo(200, 6);
  });

  it("finds a later first-affected year for a fixed loan whose repayment only changes at rollover", () => {
    const base = withLoans([
      { l1: { interest: 500, principal: 300 } },
      { l1: { interest: 500, principal: 300 } },
      { l1: { interest: 650, principal: 300 } }, // rollover here in the base too
    ]);
    const shocked = withLoans([
      { l1: { interest: 500, principal: 300 } }, // fixed period: untouched
      { l1: { interest: 500, principal: 300 } },
      { l1: { interest: 800, principal: 300 } }, // rollover: now shocked
    ]);
    const deltas = { headline: { base: { totalUnfunded: 0 }, shocked: { totalUnfunded: 0 } } };
    const h = rateShockHeadline({ base, shocked, deltas });
    expect(h.firstAffectedYear).toBe(2);
    expect(h.changeInRepayments).toBeCloseTo(150, 6);
  });

  it("sums total additional interest across every loan and every year", () => {
    const base = withLoans([
      { l1: { interest: 500, principal: 0 }, l2: { interest: 200, principal: 0 } },
      { l1: { interest: 480, principal: 0 }, l2: { interest: 190, principal: 0 } },
    ]);
    const shocked = withLoans([
      { l1: { interest: 700, principal: 0 }, l2: { interest: 300, principal: 0 } },
      { l1: { interest: 680, principal: 0 }, l2: { interest: 290, principal: 0 } },
    ]);
    const deltas = { headline: { base: { totalUnfunded: 0 }, shocked: { totalUnfunded: 0 } } };
    const h = rateShockHeadline({ base, shocked, deltas });
    // (700-500)+(300-200)+(680-480)+(290-190) = 200+100+200+100 = 600
    expect(h.totalAdditionalInterest).toBeCloseTo(600, 6);
  });

  it("reports whether the shock introduces unfunded cashflow, from the SAME deltas headline other views already read", () => {
    const base = withLoans([{ l1: { interest: 500, principal: 300 } }]);
    const shocked = withLoans([{ l1: { interest: 700, principal: 300 } }]);
    const noneIntroduced = rateShockHeadline({ base, shocked, deltas: { headline: { base: { totalUnfunded: 0 }, shocked: { totalUnfunded: 0 } } } });
    expect(noneIntroduced.introducesUnfunded).toBe(false);
    const introduced = rateShockHeadline({ base, shocked, deltas: { headline: { base: { totalUnfunded: 0 }, shocked: { totalUnfunded: 4000 } } } });
    expect(introduced.introducesUnfunded).toBe(true);
  });

  it("firstAffectedYear is null when repayments never actually differ", () => {
    const base = withLoans([{ l1: { interest: 500, principal: 300 } }, { l1: { interest: 480, principal: 320 } }]);
    const shocked = withLoans([{ l1: { interest: 500, principal: 300 } }, { l1: { interest: 480, principal: 320 } }]);
    const deltas = { headline: { base: { totalUnfunded: 0 }, shocked: { totalUnfunded: 0 } } };
    const h = rateShockHeadline({ base, shocked, deltas });
    expect(h.firstAffectedYear).toBeNull();
    expect(h.changeInRepayments).toBe(0);
  });
});

// --- Real-engine reconciliation ---------------------------------------------
//
// The pure-fixture tests above prove the arithmetic; these prove the
// same functions reconcile correctly against a REAL runShock() output
// — "the headline figures reconcile to the plotted series", and "the
// buffer-breach detection fires in the right year" against the actual
// engine, not just a hand-built stand-in for it.

function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    distributions: "reinvest", balance: 500,
    allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function mkState(over = {}) {
  const assets = over.assets ?? [mkAsset()];
  return {
    plan: {
      household: "single", client: { currentAge: 40 }, partner: null,
      endAge: over.endAge ?? 45, start: { year: 2026, month: 7 },
      superAccounts: [], workingCash: over.workingCash ?? { balance: 8000, minimumBalance: 5000, ratePct: 2.5 },
      ...over.plan,
    },
    assets, goals: [], liabilities: over.liabilities ?? [], properties: [],
    cashflows: {
      income: [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [],
      ...over.cashflows,
    },
    settings: { surplus: over.surplus ?? { mode: "accumulate", assetId: null }, fundingOrder: assets.filter((a) => a.include).map((a) => a.id) },
    assumptions: { cpi: over.cpi ?? 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("incomeGapHeadline — reconciles against a real income-gap shock", () => {
  it("total cash drawn matches the sum of the plotted deficitFunded delta series exactly", () => {
    const income = [{
      id: "sal1", label: "Salary", owner: "client", amount: 4500, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
      indexBasis: "none", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
    }];
    const expenses = [{
      id: "e1", label: "Living", category: "groceryFuel", amount: 4000, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "none", indexExtraPct: 0,
    }];
    const state = mkState({ cashflows: { income, expenses }, workingCash: { balance: 8000, minimumBalance: 5000, ratePct: 2.5 } });
    const shock = { kind: "incomeGap", ownerId: "client", atAge: 42, months: 12, replacementPct: 0 };
    const { base, shocked, deltas } = runShock(state, shock);
    const h = incomeGapHeadline({ shocked, deltas });
    const expectedTotal = Math.max(0, deltas.byYear.reduce((s, y) => s + (y.deficitFunded.shocked - y.deficitFunded.base), 0));
    expect(h.totalCashDrawn).toBeCloseTo(expectedTotal, 6);
    // The gap year (age 42, plan year 2) is where the household loses
    // its full salary — the buffer must show SOME stress there or the
    // fixture isn't exercising the shock at all.
    expect(shocked.yearly[2].income).toBeLessThan(base.yearly[2].income);
  });

  it("buffer-breach detection fires in the right year against the real engine", () => {
    // A small buffer and a genuine income stop — engineered so the WCA
    // dips below its own minimum during the gap year specifically.
    const income = [{
      id: "sal1", label: "Salary", owner: "client", amount: 5000, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
      indexBasis: "none", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
    }];
    const expenses = [{
      id: "e1", label: "Living", category: "groceryFuel", amount: 3500, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "none", indexExtraPct: 0,
    }];
    const state = mkState({
      cashflows: { income, expenses },
      workingCash: { balance: 3000, minimumBalance: 3000, ratePct: 0 },
      assets: [mkAsset({ balance: 0 })], // nothing to draw down from — the gap must hit the buffer directly
      surplus: { mode: "accumulate", assetId: null },
    });
    const shock = { kind: "incomeGap", ownerId: "client", atAge: 41, months: 12, replacementPct: 0 };
    const { base, shocked, deltas } = runShock(state, shock);
    expect(base.yearly[0].surplusOrDeficit).toBeGreaterThan(0); // the base household is comfortable — the gap is what breaks it
    const h = incomeGapHeadline({ shocked, deltas });
    expect(h.bufferHeld).toBe(false);
    expect(h.breachYear).toBe(1); // age 41 - currentAge 40
  });
});

describe("expenseShockHeadline — reconciles against a real expense shock", () => {
  it("total additional spending equals the sum of shocked.expenses minus base.expenses, exactly", () => {
    const expenses = [{
      id: "e1", label: "Living", category: "groceryFuel", amount: 2000, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "cpi", indexExtraPct: 0,
    }];
    const state = mkState({ cashflows: { expenses } });
    const { base, shocked, deltas } = runShock(state, { kind: "expenseShock", pct: 20 });
    const h = expenseShockHeadline({ base, shocked, deltas });
    let expected = 0;
    for (let y = 0; y < base.yearly.length; y++) expected += shocked.yearly[y].expenses - base.yearly[y].expenses;
    expect(h.totalAdditionalSpending).toBeCloseTo(expected, 6);
    expect(h.permanentCost).toBeCloseTo(deltas.headline.shocked.endNetAssets - deltas.headline.base.endNetAssets, 6);
  });

  it("finds the exact year surplus first turns negative under a large enough expense shock, leaving a healthy base run untouched", () => {
    const income = [{
      id: "sal1", label: "Salary", owner: "client", amount: 6000, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
      indexBasis: "none", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
    }];
    const expenses = [{
      id: "e1", label: "Living", category: "groceryFuel", amount: 2800, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "none", indexExtraPct: 0,
    }];
    const state = mkState({ cashflows: { income, expenses } });
    const { base, shocked, deltas } = runShock(state, { kind: "expenseShock", pct: 80 });
    const h = expenseShockHeadline({ base, shocked, deltas });
    expect(base.yearly[0].surplusOrDeficit).toBeGreaterThanOrEqual(0); // base itself is fine — the shock is what breaks it
    expect(h.firstNegativeSurplusYear).toBe(0);
  });
});

describe("rateShockHeadline — reconciles against a real rate shock", () => {
  const loan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 400000, interestRatePct: 6, termYears: 20, repayment: "pi",
    ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    rateType: "variable", fixedRatePct: 6, fixedUntil: null, revertRatePct: null, commencedOn: null,
    ...over,
  });

  it("total additional interest equals the sum of the per-year household interest delta, exactly", () => {
    const state = { ...mkState({ endAge: 48, assets: [mkAsset({ balance: 2_000_000 })] }), liabilities: [loan()] };
    const { base, shocked, deltas } = runShock(state, { kind: "rateShock", deltaPct: 2 });
    const h = rateShockHeadline({ base, shocked, deltas });
    let expected = 0;
    for (let y = 0; y < base.yearly.length; y++) {
      expected += (shocked.yearly[y].liabilities.lb1?.interest ?? 0) - (base.yearly[y].liabilities.lb1?.interest ?? 0);
    }
    expect(h.totalAdditionalInterest).toBeCloseTo(expected, 6);
  });

  it("a variable loan is affected from year 0", () => {
    const state = { ...mkState({ endAge: 48, assets: [mkAsset({ balance: 2_000_000 })] }), liabilities: [loan({ rateType: "variable" })] };
    const { base, shocked, deltas } = runShock(state, { kind: "rateShock", deltaPct: 2 });
    const h = rateShockHeadline({ base, shocked, deltas });
    expect(h.firstAffectedYear).toBe(0);
    expect(h.changeInRepayments).toBeGreaterThan(0);
  });

  it("a fixed loan is affected only from its own rollover year, not year 0", () => {
    const l = loan({ rateType: "fixed", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: 6.5 });
    const state = { ...mkState({ endAge: 48, assets: [mkAsset({ balance: 2_000_000 })] }), liabilities: [l] };
    const { base, shocked, deltas } = runShock(state, { kind: "rateShock", deltaPct: 2 });
    const h = rateShockHeadline({ base, shocked, deltas });
    expect(h.firstAffectedYear).toBe(3); // age 43 - currentAge 40
  });
});
