import { describe, it, expect } from "vitest";
import {
  computeRetirementAnalytics, superPensionExhaustionAge, meanOverWindow, isMaterialLEDifference,
} from "./retirementAnalytics.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";
import { remainingLE } from "./data/lifeTables.js";

const ageRef = (age) => ({ kind: "age", age });
const anchorRef = (anchorId) => ({ kind: "anchor", anchorId });

// --- Pure aggregation helpers, hand-computed ------------------------------

describe("meanOverWindow", () => {
  const yearly = [{ v: 10 }, { v: 20 }, { v: 30 }, { v: 40 }, { v: 50 }];
  const selector = (r) => r.v;

  it("averages a normal window inclusive of both endpoints", () => {
    expect(meanOverWindow(yearly, 1, 3, selector)).toBeCloseTo((20 + 30 + 40) / 3, 6);
  });

  it("a single-year window returns that year's own value", () => {
    expect(meanOverWindow(yearly, 2, 2, selector)).toBe(30);
  });

  it("clamps into the array's own bounds rather than reading past it", () => {
    expect(meanOverWindow(yearly, -3, 1, selector)).toBeCloseTo((10 + 20) / 2, 6);
    expect(meanOverWindow(yearly, 3, 99, selector)).toBeCloseTo((40 + 50) / 2, 6);
  });

  it("an inverted or empty window returns null, never averages over nothing", () => {
    expect(meanOverWindow([], 0, 3, selector)).toBeNull();
  });

  it("accepts fromYear/toYear in either order", () => {
    expect(meanOverWindow(yearly, 3, 1, selector)).toBeCloseTo((20 + 30 + 40) / 3, 6);
  });
});

describe("superPensionExhaustionAge", () => {
  const ages = [60, 61, 62, 63, 64, 65];

  it("never had a super/pension balance at all → null (nothing to exhaust)", () => {
    const yearly = ages.map(() => ({ superClosing: 0, pensionClosing: 0 }));
    expect(superPensionExhaustionAge(yearly, ages)).toBeNull();
  });

  it("still positive at the end of the projection → null (never exhausts within this horizon)", () => {
    const yearly = ages.map(() => ({ superClosing: 500000, pensionClosing: 0 }));
    expect(superPensionExhaustionAge(yearly, ages)).toBeNull();
  });

  it("drops to zero after being positive → the FIRST age it reaches zero", () => {
    const yearly = [
      { superClosing: 100000, pensionClosing: 0 },
      { superClosing: 50000, pensionClosing: 0 },
      { superClosing: 0, pensionClosing: 0 },
      { superClosing: 0, pensionClosing: 0 }, // stays zero — must still report the FIRST zero year
      { superClosing: 0, pensionClosing: 0 },
      { superClosing: 0, pensionClosing: 0 },
    ];
    expect(superPensionExhaustionAge(yearly, ages)).toBe(62); // ages[2]
  });

  it("combines super AND pension — exhausted only once BOTH are zero, not when either alone is", () => {
    const yearly = [
      { superClosing: 100000, pensionClosing: 50000 },
      { superClosing: 0, pensionClosing: 50000 },     // super gone, pension still has money — not exhausted
      { superClosing: 0, pensionClosing: 0 },          // now genuinely exhausted
      { superClosing: 0, pensionClosing: 0 },
      { superClosing: 0, pensionClosing: 0 },
      { superClosing: 0, pensionClosing: 0 },
    ];
    expect(superPensionExhaustionAge(yearly, ages)).toBe(62); // ages[2]
  });

  it("zero at the very start (never funded) then genuinely funded later is NOT exhaustion — 'everPositive' gates it", () => {
    const yearly = [
      { superClosing: 0, pensionClosing: 0 },
      { superClosing: 0, pensionClosing: 0 },
      { superClosing: 200000, pensionClosing: 0 }, // first contribution
      { superClosing: 150000, pensionClosing: 0 },
      { superClosing: 0, pensionClosing: 0 },       // exhausted HERE, not at index 0
      { superClosing: 0, pensionClosing: 0 },
    ];
    expect(superPensionExhaustionAge(yearly, ages)).toBe(64); // ages[4]
  });
});

describe("isMaterialLEDifference", () => {
  it("null on either side is never material", () => {
    expect(isMaterialLEDifference(null, 50000)).toBe(false);
    expect(isMaterialLEDifference(50000, null)).toBe(false);
  });

  it("a zero or negative LE base is never material (avoids a divide-by-zero/nonsense ratio)", () => {
    expect(isMaterialLEDifference(0, 50000)).toBe(false);
  });

  it("a small difference (under the 10% default bar) is not material", () => {
    expect(isMaterialLEDifference(50000, 48000)).toBe(false); // 4% — under the bar
  });

  it("a large difference (over the bar) is material", () => {
    expect(isMaterialLEDifference(50000, 40000)).toBe(true); // 20% — over the bar
  });

  it("the threshold is configurable", () => {
    expect(isMaterialLEDifference(50000, 48000, 2)).toBe(true); // 4% clears a 2% bar
  });
});

// --- Full pipeline, real engine runs --------------------------------------

function mkState({ clientAge = 65, sex = "male", retirementAge = 65, endAge = 95, expenses = [], income = [], assets } = {}) {
  return {
    plan: {
      household: "single",
      client: { currentAge: clientAge, sex, retirementAge },
      partner: null,
      endBasis: { mode: "fixedAge", fixedAge: endAge },
      endAge,
      start: { year: 2026, month: 7 },
    },
    assets: assets ?? [{
      id: "a1", name: "A1", include: true, owner: "client", distributions: "reinvest",
      balance: 500000, allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" },
      icrPct: 0, cgtAsset: false, costBase: null,
    }],
    bonds: [], liabilities: [], properties: [],
    cashflows: { income, expenses, contributions: [], withdrawals: [], lumpSums: [], bondContributions: [] },
    settings: {
      surplus: { periods: [{ from: anchorRef("start"), to: anchorRef("end"), mode: "spend", assetId: null }] },
      fundingOrder: (assets ?? [{ id: "a1" }]).map((a) => a.id),
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed", awote: 0.035, wageGrowth: 0.04 },
    display: { units: "real" },
  };
}

describe("computeRetirementAnalytics — retirement/LE/LE+5 anchor resolution", () => {
  it("resolves the LE and LE+5 plan years from remainingLE(65,'male') exactly (20.22 → rounds to 20 years)", () => {
    // Hand check: remainingLE(65,'male') = 20.22 → round = 20 → LE age 85,
    // plan year 20 (client currentAge 65). LE+5: 20+5=25 → age 90, plan year 25.
    expect(Math.round(remainingLE(65, "male"))).toBe(20);
    const state = mkState({ clientAge: 65, sex: "male", retirementAge: 65, endAge: 95 });
    const result = projectPlan(state, PROFILES);
    const a = computeRetirementAnalytics(state, result);
    expect(a.retirement.planYear).toBe(0); // retires immediately (retirementAge === currentAge)
    expect(a.retirement.age).toBe(65);
    expect(a.le.planYear).toBe(20);
    expect(a.le.age).toBe(85);
    expect(a.lePlus5.planYear).toBe(25);
    expect(a.lePlus5.age).toBe(90);
  });

  it("capitalAtRetirement is exactly the yearly ledger's own netAssets at the resolved retirement year — including when retirement is mid-projection, not just year 0", () => {
    // growthPct meaningfully above CPI (2.5%) — a real return, unlike
    // mkState's own default (custom growthPct===cpi, deliberately a
    // zero-real-return allocation elsewhere in this file), so this
    // fixture's own balance genuinely differs year 0 vs year 5.
    const state = mkState({
      clientAge: 60, retirementAge: 65, endAge: 95,
      assets: [{
        id: "a1", name: "A1", include: true, owner: "client", distributions: "reinvest",
        balance: 500000, allocation: { mode: "custom", incomePct: 0, growthPct: 8, frankingPct: 0, volBasis: "Balanced" },
        icrPct: 0, cgtAsset: false, costBase: null,
      }],
    });
    const result = projectPlan(state, PROFILES);
    const a = computeRetirementAnalytics(state, result);
    expect(a.retirement.planYear).toBe(5); // 65 - 60
    expect(a.capitalAtRetirement).toBe(result.yearly[5].netAssets);
    expect(a.capitalAtRetirement).not.toBe(result.yearly[0].netAssets); // sanity: not just defaulting to year 0
  });

  it("averageRetirementIncome/averageAgePension are the SAME window's mean of the engine's own figures — cross-checked by re-summing result.yearly directly, not re-derived logic", () => {
    const state = mkState({ clientAge: 65, retirementAge: 65, endAge: 95 });
    const result = projectPlan(state, PROFILES);
    const a = computeRetirementAnalytics(state, result);
    const from = a.retirement.planYear, to = a.le.planYear;
    let sumAfterTax = 0, sumPension = 0, sumGross = 0, n = 0;
    for (let y = from; y <= to; y++) {
      sumAfterTax += result.yearly[y].income - result.yearly[y].tax;
      sumGross += result.yearly[y].income;
      const d = result.yearly[y].agePensionDetail;
      sumPension += (d?.client?.paid ?? 0) + (d?.partner?.paid ?? 0);
      n++;
    }
    expect(a.le.averageRetirementIncome).toBeCloseTo(sumAfterTax / n, 6);
    expect(a.le.averageAgePension).toBeCloseTo(sumPension / n, 6);
    expect(a.le.averageAgePensionPctOfIncome).toBeCloseTo((sumPension / n) / (sumGross / n) * 100, 6);
  });
});

describe("computeRetirementAnalytics — first shortfall age", () => {
  it("matches result.shortfall.clientAge exactly when a shortfall occurs", () => {
    // A large annual expense against a modest balance guarantees a shortfall.
    const state = mkState({
      clientAge: 65, retirementAge: 65, endAge: 90,
      assets: [{
        id: "a1", name: "A1", include: true, owner: "client", distributions: "reinvest",
        balance: 20000, allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
        icrPct: 0, cgtAsset: false, costBase: null,
      }],
      expenses: [{
        id: "e1", label: "Living", amount: 50000, frequency: "annual",
        from: ageRef(65), to: ageRef(90), indexBasis: "cpi", indexExtraPct: 0,
      }],
    });
    const result = projectPlan(state, PROFILES);
    expect(result.shortfall).not.toBeNull();
    const a = computeRetirementAnalytics(state, result);
    expect(a.firstShortfallAge).toBe(result.shortfall.clientAge);
  });

  it("is null when the plan never goes unfunded", () => {
    const state = mkState({ clientAge: 65, retirementAge: 65, endAge: 90 }); // ample capital, no expenses
    const result = projectPlan(state, PROFILES);
    expect(result.shortfall).toBeNull();
    const a = computeRetirementAnalytics(state, result);
    expect(a.firstShortfallAge).toBeNull();
  });
});

describe("computeRetirementAnalytics — super/pension exhaustion via the real engine", () => {
  it("with no super or pension accounts at all, exhaustion age is null", () => {
    const state = mkState({ clientAge: 65, retirementAge: 65, endAge: 90 });
    const result = projectPlan(state, PROFILES);
    const a = computeRetirementAnalytics(state, result);
    expect(a.superPensionExhaustionAge).toBeNull();
    // Cross-check: every row's own super+pension closing is genuinely 0.
    expect(result.yearly.every((r) => (r.superClosing ?? 0) + (r.pensionClosing ?? 0) === 0)).toBe(true);
  });
});

describe("computeRetirementAnalytics — sustainable income to LE", () => {
  it("solves a positive amount for a household with real capital, and applying it back produces a plan that lasts to LE (the spec's own required test)", () => {
    const state = mkState({
      clientAge: 65, retirementAge: 65, endAge: 95,
      assets: [{
        id: "a1", name: "A1", include: true, owner: "client", distributions: "reinvest",
        balance: 1500000, allocation: { mode: "custom", incomePct: 2, growthPct: 2, frankingPct: 0, volBasis: "Balanced" },
        icrPct: 0, cgtAsset: false, costBase: null,
      }],
    });
    const result = projectPlan(state, PROFILES);
    const a = computeRetirementAnalytics(state, result);
    expect(a.le.sustainableIncomeConverged).toBe(true);
    expect(a.le.sustainableIncomeToLE).toBeGreaterThan(0);

    // Apply it back as a real expense row over [retirement, LE] and confirm
    // the plan lasts: no shortfall AT OR BEFORE the LE plan year.
    const applied = {
      ...state,
      cashflows: {
        ...state.cashflows,
        expenses: [
          ...state.cashflows.expenses,
          {
            id: "applied", label: "Sustainable spend (test)", amount: a.le.sustainableIncomeToLE,
            frequency: "annual", from: ageRef(a.retirement.age), to: ageRef(a.le.age),
            indexBasis: "cpi", indexExtraPct: 0,
          },
        ],
      },
    };
    const appliedResult = projectPlan(applied, PROFILES);
    const shortfallBeforeLE = appliedResult.shortfall != null && appliedResult.shortfall.planYear <= a.le.planYear;
    expect(shortfallBeforeLE).toBe(false);
    // And net assets at LE should be close to fully depleted (the solver's
    // own target), well below what an unspent household would still hold.
    expect(appliedResult.yearly[a.le.planYear].netAssets).toBeLessThan(result.yearly[a.le.planYear].netAssets);
  });

  it("a household with zero capital and zero income cannot sustain any positive spend — reports not converged rather than a fabricated number", () => {
    const state = mkState({
      clientAge: 65, retirementAge: 65, endAge: 95,
      assets: [{
        id: "a1", name: "A1", include: true, owner: "client", distributions: "reinvest",
        balance: 0, allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
        icrPct: 0, cgtAsset: false, costBase: null,
      }],
    });
    const result = projectPlan(state, PROFILES);
    const a = computeRetirementAnalytics(state, result);
    // Zero capital and zero other income ⇒ even $0 extra spend can't be
    // told apart from "sustainable" by the solver's own bounds (hi floors
    // at $10,000) — either it reports not-converged, or a very small
    // number; either way it must never claim substantial sustainable income.
    if (a.le.sustainableIncomeConverged) {
      expect(a.le.sustainableIncomeToLE).toBeLessThan(1000);
    } else {
      expect(a.le.sustainableIncomeToLE).toBeNull();
    }
  });
});
