import { describe, it, expect } from "vitest";
import {
  computeRetirementAnalytics, superPensionExhaustionAge, meanOverWindow, isMaterialLEDifference,
  householdCashIncome, sgFor, ageYear, preservationAgeFor, agePensionAgeFor, capHeadroomFor,
  firstDiv293Year, agePensionEligibilityFor,
} from "./retirementAnalytics.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";
import { remainingLE } from "./data/lifeTables.js";
import { defaultState, clampAllToPlan, createSuperAccount, createPension, createIncomeRow } from "./planState.js";
import { superRatesFor } from "./data/superRates.js";
import { agePensionRatesFor } from "./data/agePension.js";
import { firstFyStartYear } from "./schedule.js";

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

// Bug found while building spec 33 Commit 2 (the standalone retirement
// page): row.income (deterministic.js's own accumulator) deliberately
// excludes account-based pension payments — non-assessable non-exempt
// income for someone past preservation age, correctly left out of the
// TAX-relevant figure it tracks — but "Average retirement income to LE"
// is a CASH concept, and a pension is typically retirement's single
// largest cash inflow. householdCashIncome(row) is the fix: row.income
// PLUS every pension's own payments this row.
describe("householdCashIncome", () => {
  it("equals row.income when there is no pension at all (the common case this module's OTHER tests already exercise)", () => {
    expect(householdCashIncome({ income: 42000 })).toBe(42000);
    expect(householdCashIncome({ income: 42000, pensionDetail: {} })).toBe(42000);
  });

  it("adds every pension's own payments on top of row.income", () => {
    const row = { income: 10000, pensionDetail: { p1: { payments: 30000 }, p2: { payments: 12000 } } };
    expect(householdCashIncome(row)).toBe(10000 + 30000 + 12000);
  });
});

describe("computeRetirementAnalytics — average retirement income folds in pension payments (bug fix, closes the whole class within this module)", () => {
  it("averageRetirementIncome/averageAgePensionPctOfIncome reconcile against row.income + pension payments — re-summed from result.yearly directly, not re-derived logic — and are NOT close to the old (broken) row.income-only figure", () => {
    // Retiring mid-projection (currentAge well below retirementAge), not
    // in the plan's own opening year — a client retiring in plan year 0
    // hits an unrelated commencement edge case (retirement-client
    // resolves inside a partial first year) where the pension never
    // actually commences at all, orthogonal to the bug under test here.
    let state = defaultState(PROFILES);
    state = { ...state, plan: { ...state.plan, client: { ...state.plan.client, dob: "1970-01-01", retirementAge: 65 } } };
    state = clampAllToPlan(state, PROFILES); // resolve currentAge from dob BEFORE createPension reads it
    const sa = { ...createSuperAccount(state.plan, [], PROFILES, "client"), balance: 600000 };
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const pn = { ...createPension(state.plan, [], state.plan.superAccounts, "client"), drawdownOption: "minimum" };
    state = { ...state, plan: { ...state.plan, pensions: [pn] } };
    state = clampAllToPlan(state, PROFILES);

    const result = projectPlan(state, PROFILES);
    const a = computeRetirementAnalytics(state, result);
    const from = a.retirement.planYear, to = a.le.planYear;

    let sumCash = 0, sumAfterTaxOld = 0, pensionEverPaid = false, n = 0;
    for (let y = from; y <= to; y++) {
      const row = result.yearly[y];
      let pensionPaid = 0;
      for (const id of Object.keys(row.pensionDetail ?? {})) pensionPaid += row.pensionDetail[id]?.payments ?? 0;
      if (pensionPaid > 0) pensionEverPaid = true;
      sumCash += row.income + pensionPaid - row.tax;
      sumAfterTaxOld += row.income - row.tax;
      n++;
    }
    expect(pensionEverPaid).toBe(true); // sanity: the fixture genuinely exercises a paying pension
    expect(a.le.averageRetirementIncome).toBeCloseTo(sumCash / n, 6);
    // The bug this fix closes: the OLD formula (row.income - row.tax alone)
    // would have reported a materially smaller figure — pension payments
    // are the dominant cash flow in this fixture (drawdownOption
    // "minimum" against a $600k+ balance).
    expect(a.le.averageRetirementIncome).not.toBeCloseTo(sumAfterTaxOld / n, 0);
    expect(a.le.averageRetirementIncome).toBeGreaterThan((sumAfterTaxOld / n) * 2);
  });
});

// --- Per-person derived figures (relocated from retirementStandalone.js
// by docs/specs/35-retirement-output-view.md, Commit 1) --------------

describe("sgFor", () => {
  it("derives SG at the statutory rate, uncapped", () => {
    // 115,000 × 12% = 13,800.
    const state = defaultState(PROFILES);
    const sg = sgFor(state, 115000);
    expect(sg.amount).toBeCloseTo(13800, 2);
    expect(sg.ratePct).toBe(12);
    expect(sg.isCapped).toBe(false);
  });

  it("caps at the maximum contribution base once salary exceeds it", () => {
    const state = defaultState(PROFILES);
    const f0 = firstFyStartYear(state.plan.start);
    const rates = superRatesFor(f0);
    const sg = sgFor(state, 300000);
    expect(sg.isCapped).toBe(true);
    expect(sg.base).toBe(rates.sgMaximumSalary);
    expect(sg.amount).toBeCloseTo(rates.sgMaximumSalary * rates.sgRate, 2);
  });
});

describe("preservationAgeFor / agePensionAgeFor / ageYear", () => {
  it("resolve from date of birth to a calendar year", () => {
    let state = defaultState(PROFILES);
    state = { ...state, plan: { ...state.plan, client: { ...state.plan.client, dob: "1980-01-01", retirementAge: 65 } } };
    state = clampAllToPlan(state, PROFILES);
    const result = projectPlan(state, PROFILES);
    const f0 = firstFyStartYear(state.plan.start);
    const currentAge = state.plan.client.currentAge;
    const superRates = superRatesFor(f0);
    const apRates = agePensionRatesFor(f0);

    const preservation = preservationAgeFor(state, "client", result.schedule);
    expect(preservation.age).toBe(superRates.preservationAge);
    expect(preservation.year).toBe(f0 + (superRates.preservationAge - currentAge));

    const pension = agePensionAgeFor(state, "client", result.schedule);
    expect(pension.age).toBe(apRates.ageOfEligibility);
    expect(pension.year).toBe(f0 + (apRates.ageOfEligibility - currentAge));

    expect(agePensionEligibilityFor(state, result.schedule)).toEqual(pension);
  });

  it("reports outOfRange rather than a bogus year once the target age falls beyond the projection", () => {
    let state = defaultState(PROFILES);
    state = { ...state, plan: { ...state.plan, client: { ...state.plan.client, dob: "1980-01-01", retirementAge: 65 } } };
    state = clampAllToPlan(state, PROFILES);
    const result = projectPlan(state, PROFILES);
    const resolved = ageYear(state, "client", 200, result.schedule);
    expect(resolved.outOfRange).toBe(true);
    expect(resolved.year).toBeNull();
  });
});

describe("capHeadroomFor / firstDiv293Year", () => {
  // A super account plus a salary income row, via the same factories
  // planState.js's own callers use — the plan's own start month (this
  // real session's "now") makes year 0 a partial FY (CLAUDE.md's own
  // locked convention: annual rows skip a partial first year), so these
  // checks read year 1, the first full FY, same as every other test in
  // this codebase that hits this same quirk.
  function stateWithSalaryAndSuper(dob, salary) {
    let state = defaultState(PROFILES);
    state = { ...state, plan: { ...state.plan, client: { ...state.plan.client, dob, retirementAge: 65 } } };
    state = clampAllToPlan(state, PROFILES);
    const sa = { ...createSuperAccount(state.plan, [], PROFILES, "client"), balance: 50000 };
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const income = { ...createIncomeRow(state.plan, []), amount: salary };
    state = { ...state, cashflows: { ...state.cashflows, income: [income] } };
    return clampAllToPlan(state, PROFILES);
  }

  it("capHeadroomFor reads the SAME projection.yearly[0].superCapUsage[owner] the comprehensive Super section's own display reads", () => {
    const state = stateWithSalaryAndSuper("1980-01-01", 115000);
    const result = projectPlan(state, PROFILES);
    expect(capHeadroomFor(result, "client")).toEqual(result.yearly[0].superCapUsage.client);
    expect(capHeadroomFor(result, "client").cap).toBeGreaterThan(0);
  });

  it("capHeadroomFor returns null when the projection has no yearly rows for the owner", () => {
    expect(capHeadroomFor({ yearly: [] }, "client")).toBeNull();
  });

  it("firstDiv293Year fires in the first full FY a high salary clears the threshold", () => {
    const state = stateWithSalaryAndSuper("1980-01-01", 300000);
    const result = projectPlan(state, PROFILES);
    const f0 = firstFyStartYear(state.plan.start);
    const hit = firstDiv293Year(state, result, "client");
    expect(hit).not.toBeNull();
    expect(hit.year).toBe(f0 + 1);
    expect(hit.ratePct).toBe(15);
  });

  it("firstDiv293Year reports null when income never approaches the threshold", () => {
    const state = stateWithSalaryAndSuper("1980-01-01", 80000);
    const result = projectPlan(state, PROFILES);
    expect(firstDiv293Year(state, result, "client")).toBeNull();
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
