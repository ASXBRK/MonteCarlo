import { describe, it, expect } from "vitest";
import { buildSchedules } from "./schedule.js";
import { resolveIncomeRequired, INCOME_REQUIRED_SOURCES, deriveHomeownerStatus } from "./retirement.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";
import { createProperty, createLiability } from "./planState.js";

// Minimal v3-shaped state factory, same shape as schedule.test.js's own
// mkState — this module is pure and only needs a built schedule, not the
// full engine.
function mkState({
  start = { year: 2026, month: 7 },
  clientAge = 55,
  endAge = 65,
  retirementAge,
  expenses = [],
  cpi = 0.025,
  awote = 0.035,
  wageGrowth = 0.04,
} = {}) {
  const assets = [{ id: "a1", include: true }];
  return {
    plan: {
      household: "single",
      client: { currentAge: clientAge, retirementAge },
      partner: null,
      endAge,
      start,
    },
    assets,
    bonds: [],
    cashflows: { income: [], expenses, contributions: [], withdrawals: [], lumpSums: [], bondContributions: [] },
    settings: {
      surplus: { mode: "spend", assetId: null },
      fundingOrder: ["a1"],
    },
    assumptions: { cpi, awote, wageGrowth },
    display: { units: "real" },
  };
}

const ageRef = (age) => ({ kind: "age", age });
const anchorRef = (anchorId) => ({ kind: "anchor", anchorId });

const expenseRow = (amount, over = {}) => ({
  id: "e1", label: "Living", amount, frequency: "monthly",
  from: ageRef(0), to: ageRef(120), indexBasis: "cpi", indexExtraPct: 0,
  ...over,
});

describe("resolveIncomeRequired — sources", () => {
  it("currentExpenses resolves to total household living expenses AT the startAt year, not the plan's own current expenses", () => {
    // $2,000/month living expenses = $24,000/yr, flat throughout (CPI
    // indexed, so constant in real terms) — the total doesn't depend on
    // which year it's read from here, which is deliberate: this test
    // only needs to prove it reads the SCHEDULE's own expense total,
    // not the customAmount field.
    const state = mkState({ clientAge: 55, endAge: 65, retirementAge: 60, expenses: [expenseRow(2000)] });
    const schedule = buildSchedules(state);
    state.plan.retirement = {
      incomeRequired: {
        source: "currentExpenses", customAmount: 0,
        indexBasis: "cpi", indexExtraPct: 0,
        startAt: anchorRef("retirement-client"), stepDownAtAge: null, stepDownPct: 80,
      },
    };
    const at = resolveIncomeRequired(state.plan, schedule, state.assumptions.cpi, state.assumptions.wageGrowth);
    // startYear = age 60 - age 55 = plan year 5.
    expect(at(4)).toBeNull(); // before retirement — not yet applicable
    expect(at(5)).toBeCloseTo(24000, 2);
    expect(at(9)).toBeCloseTo(24000, 2); // CPI-indexed expense row + CPI-basis requirement ⇒ flat real
  });

  it("custom resolves to customAmount directly, ignoring expense rows entirely", () => {
    const state = mkState({ clientAge: 55, endAge: 65, retirementAge: 60, expenses: [expenseRow(9999)] });
    const schedule = buildSchedules(state);
    state.plan.retirement = {
      incomeRequired: {
        source: "custom", customAmount: 50000,
        indexBasis: "cpi", indexExtraPct: 0,
        startAt: anchorRef("retirement-client"), stepDownAtAge: null, stepDownPct: 80,
      },
    };
    const at = resolveIncomeRequired(state.plan, schedule, state.assumptions.cpi, state.assumptions.wageGrowth);
    expect(at(5)).toBeCloseTo(50000, 2);
  });

  it("INCOME_REQUIRED_SOURCES includes all three ASFA sources (Commit 2) — asfaModestRenter is the derivation's own override, not omitted", () => {
    expect(INCOME_REQUIRED_SOURCES).toEqual(["currentExpenses", "custom", "asfaComfortable", "asfaModest", "asfaModestRenter"]);
  });

  it("asfaComfortable resolves the household's own single/couple figure directly, ignoring customAmount, expense rows, and homeowner status entirely (no renter variant exists for Comfortable)", () => {
    const single = mkState({ clientAge: 60, endAge: 70, retirementAge: 60, expenses: [expenseRow(9999)] });
    single.plan.retirement = {
      incomeRequired: {
        source: "asfaComfortable", customAmount: 1,
        indexBasis: "cpi", indexExtraPct: 0,
        startAt: ageRef(60), stepDownAtAge: null, stepDownPct: 80,
      },
    };
    const scheduleSingle = buildSchedules(single);
    const atSingle = resolveIncomeRequired(single.plan, scheduleSingle, single.assumptions.cpi, single.assumptions.wageGrowth);
    expect(atSingle(0)).toBeCloseTo(55923, 2); // ASFA Comfortable, single, March quarter 2026

    const couple = { ...single, plan: { ...single.plan, household: "married", partner: { currentAge: 60 } } };
    const scheduleCouple = buildSchedules(couple);
    const atCouple = resolveIncomeRequired(couple.plan, scheduleCouple, couple.assumptions.cpi, couple.assumptions.wageGrowth);
    expect(atCouple(0)).toBeCloseTo(78566, 2); // ASFA Comfortable, couple
  });

  it("an ASFA-sourced requirement still indexes forward and steps down like any other source", () => {
    const cpi = 0.025, wageGrowth = 0.04;
    const state = mkState({ clientAge: 60, endAge: 70, retirementAge: 60, cpi, wageGrowth });
    const schedule = buildSchedules(state);
    state.plan.retirement = {
      incomeRequired: {
        source: "asfaComfortable", customAmount: 0,
        indexBasis: "awote", indexExtraPct: 0,
        startAt: ageRef(60), stepDownAtAge: 65, stepDownPct: 50,
      },
    };
    const at = resolveIncomeRequired(state.plan, schedule, cpi, wageGrowth);
    const base = 55923;
    expect(at(0)).toBeCloseTo(base, 2);
    const expectedY3 = base * Math.pow((1 + wageGrowth) / (1 + cpi), 3);
    expect(at(3)).toBeCloseTo(expectedY3, 2);
    const expectedY5 = base * Math.pow((1 + wageGrowth) / (1 + cpi), 5) * 0.5;
    expect(at(5)).toBeCloseTo(expectedY5, 2); // age 65 — step-down applies on top of indexation
  });
});

// --- Homeowner status derived, not asked (spec 32, Commit 2) ---------------

describe("deriveHomeownerStatus", () => {
  it("no principal residence at all → renter, the spec's own stated default", () => {
    expect(deriveHomeownerStatus([], [], { properties: {}, liabilities: {} })).toBe("renter");
  });

  it("no data at all (a bare fixture, or no retirement-year row yet) → renter", () => {
    expect(deriveHomeownerStatus(undefined, undefined, undefined)).toBe("renter");
  });

  it("a principal residence not yet purchased by the retirement year (projected value still 0) → renter", () => {
    const properties = [{ id: "p1", propertyType: "ppr" }];
    const row = { properties: { p1: { value: 0 } }, liabilities: {} };
    expect(deriveHomeownerStatus(properties, [], row)).toBe("renter");
  });

  it("an owned principal residence with no linked loan at all → homeowner", () => {
    const properties = [{ id: "p1", propertyType: "ppr" }];
    const row = { properties: { p1: { value: 900000 } }, liabilities: {} };
    expect(deriveHomeownerStatus(properties, [], row)).toBe("homeowner");
  });

  it("an owned principal residence whose linked loan still carries a projected balance at the retirement year → renter", () => {
    const properties = [{ id: "p1", propertyType: "ppr" }];
    const liabilities = [{ id: "l1", linkedAssetId: "p1" }];
    const row = { properties: { p1: { value: 900000 } }, liabilities: { l1: { closing: 120000 } } };
    expect(deriveHomeownerStatus(properties, liabilities, row)).toBe("renter");
  });

  it("an owned principal residence whose linked loan is fully paid off by the retirement year → homeowner", () => {
    const properties = [{ id: "p1", propertyType: "ppr" }];
    const liabilities = [{ id: "l1", linkedAssetId: "p1" }];
    const row = { properties: { p1: { value: 900000 } }, liabilities: { l1: { closing: 0 } } };
    expect(deriveHomeownerStatus(properties, liabilities, row)).toBe("homeowner");
  });

  it("a loan linked to some OTHER asset (not the PPR) is irrelevant to the PPR's own status", () => {
    const properties = [{ id: "p1", propertyType: "ppr" }];
    const liabilities = [{ id: "l1", linkedAssetId: "some-other-asset" }];
    const row = { properties: { p1: { value: 900000 } }, liabilities: { l1: { closing: 500000 } } };
    expect(deriveHomeownerStatus(properties, liabilities, row)).toBe("homeowner");
  });
});

describe("resolveIncomeRequired — asfaModest derives homeowner/renter; asfaModestRenter overrides it", () => {
  const irCfg = (source) => ({
    incomeRequired: {
      source, customAmount: 0, indexBasis: "cpi", indexExtraPct: 0,
      startAt: anchorRef("retirement-client"), stepDownAtAge: null, stepDownPct: 80,
    },
  });

  it("with no property data at all, asfaModest derives renter and resolves the renter figure — never silently falls back to the homeowner assumption", () => {
    const state = mkState({ clientAge: 55, endAge: 65, retirementAge: 60 });
    const schedule = buildSchedules(state);
    state.plan.retirement = irCfg("asfaModest");
    const at = resolveIncomeRequired(state.plan, schedule, state.assumptions.cpi, state.assumptions.wageGrowth); // no ctx supplied
    expect(at(5)).toBeCloseTo(51164, 2); // single, ASFA Modest (renter)
  });

  it("with an owned, mortgage-free PPR, asfaModest derives homeowner and resolves the homeowner figure", () => {
    const state = mkState({ clientAge: 55, endAge: 65, retirementAge: 60 });
    const schedule = buildSchedules(state);
    state.plan.retirement = irCfg("asfaModest");
    const properties = [{ id: "p1", propertyType: "ppr" }];
    const yearly = []; yearly[5] = { properties: { p1: { value: 900000 } }, liabilities: {} };
    const at = resolveIncomeRequired(state.plan, schedule, state.assumptions.cpi, state.assumptions.wageGrowth, { properties, liabilities: [], yearly });
    expect(at(5)).toBeCloseTo(36434, 2); // single, ASFA Modest (homeowner)
  });

  it("with an owned PPR but a mortgage still owing at the retirement year, asfaModest derives renter", () => {
    const state = mkState({ clientAge: 55, endAge: 65, retirementAge: 60 });
    const schedule = buildSchedules(state);
    state.plan.retirement = irCfg("asfaModest");
    const properties = [{ id: "p1", propertyType: "ppr" }];
    const liabilities = [{ id: "l1", linkedAssetId: "p1" }];
    const yearly = []; yearly[5] = { properties: { p1: { value: 900000 } }, liabilities: { l1: { closing: 150000 } } };
    const at = resolveIncomeRequired(state.plan, schedule, state.assumptions.cpi, state.assumptions.wageGrowth, { properties, liabilities, yearly });
    expect(at(5)).toBeCloseTo(51164, 2); // still paying it off — renter comparison
  });

  it("asfaModestRenter is the spec's own explicit override — forces the renter figure even when derivation would say homeowner", () => {
    const state = mkState({ clientAge: 55, endAge: 65, retirementAge: 60 });
    const schedule = buildSchedules(state);
    state.plan.retirement = irCfg("asfaModestRenter");
    const properties = [{ id: "p1", propertyType: "ppr" }];
    const yearly = []; yearly[5] = { properties: { p1: { value: 900000 } }, liabilities: {} }; // mortgage-free → would derive homeowner
    const at = resolveIncomeRequired(state.plan, schedule, state.assumptions.cpi, state.assumptions.wageGrowth, { properties, liabilities: [], yearly });
    expect(at(5)).toBeCloseTo(51164, 2); // forced renter regardless of the derived answer
  });
});

describe("resolveIncomeRequired — indexation", () => {
  it("a wage(AWOTE)-basis requirement grows in real terms relative to CPI, matching the hand-computed ratio", () => {
    const cpi = 0.025, wageGrowth = 0.04;
    const state = mkState({ clientAge: 60, endAge: 70, retirementAge: 60, cpi, wageGrowth });
    const schedule = buildSchedules(state);
    state.plan.retirement = {
      incomeRequired: {
        source: "custom", customAmount: 10000,
        indexBasis: "awote", indexExtraPct: 0,
        startAt: ageRef(60), stepDownAtAge: null, stepDownPct: 80,
      },
    };
    const at = resolveIncomeRequired(state.plan, schedule, cpi, wageGrowth);
    expect(at(0)).toBeCloseTo(10000, 2);
    const expectedY1 = 10000 * Math.pow((1 + wageGrowth) / (1 + cpi), 1);
    expect(at(1)).toBeCloseTo(expectedY1, 2);
    const expectedY5 = 10000 * Math.pow((1 + wageGrowth) / (1 + cpi), 5);
    expect(at(5)).toBeCloseTo(expectedY5, 2);
  });

  it("a none-basis requirement decays in real terms at CPI (fixed nominal), matching the hand-computed ratio", () => {
    const cpi = 0.025;
    const state = mkState({ clientAge: 60, endAge: 70, retirementAge: 60, cpi });
    const schedule = buildSchedules(state);
    state.plan.retirement = {
      incomeRequired: {
        source: "custom", customAmount: 10000,
        indexBasis: "none", indexExtraPct: 0,
        startAt: ageRef(60), stepDownAtAge: null, stepDownPct: 80,
      },
    };
    const at = resolveIncomeRequired(state.plan, schedule, cpi, 0.04);
    const expectedY3 = 10000 * Math.pow(1 / (1 + cpi), 3);
    expect(at(3)).toBeCloseTo(expectedY3, 2);
  });

  it("indexExtraPct adds to the basis rate", () => {
    const cpi = 0.025;
    const state = mkState({ clientAge: 60, endAge: 70, retirementAge: 60, cpi });
    const schedule = buildSchedules(state);
    state.plan.retirement = {
      incomeRequired: {
        source: "custom", customAmount: 10000,
        indexBasis: "cpi", indexExtraPct: 2,
        startAt: ageRef(60), stepDownAtAge: null, stepDownPct: 80,
      },
    };
    const at = resolveIncomeRequired(state.plan, schedule, cpi, 0.04);
    // g = cpi + 2% ⇒ real growth of 2%/yr relative to CPI.
    const expectedY4 = 10000 * Math.pow((1 + cpi + 0.02) / (1 + cpi), 4);
    expect(at(4)).toBeCloseTo(expectedY4, 2);
  });
});

describe("resolveIncomeRequired — step-down", () => {
  it("applies stepDownPct only from stepDownAtAge onward, never before", () => {
    const cpi = 0.025;
    const state = mkState({ clientAge: 55, endAge: 70, retirementAge: 55, cpi });
    const schedule = buildSchedules(state);
    state.plan.retirement = {
      incomeRequired: {
        source: "custom", customAmount: 10000,
        indexBasis: "cpi", indexExtraPct: 0, // flat real — isolates the step-down effect
        startAt: ageRef(55), stepDownAtAge: 60, stepDownPct: 50,
      },
    };
    const at = resolveIncomeRequired(state.plan, schedule, cpi, 0.04);
    expect(at(4)).toBeCloseTo(10000, 2);  // age 59 — not yet
    expect(at(5)).toBeCloseTo(5000, 2);   // age 60 — steps down
    expect(at(10)).toBeCloseTo(5000, 2);  // age 65 — stays down
  });

  it("a null stepDownAtAge never steps down, at any age", () => {
    const cpi = 0.025;
    const state = mkState({ clientAge: 55, endAge: 95, retirementAge: 55, cpi });
    const schedule = buildSchedules(state);
    state.plan.retirement = {
      incomeRequired: {
        source: "custom", customAmount: 10000,
        indexBasis: "cpi", indexExtraPct: 0,
        startAt: ageRef(55), stepDownAtAge: null, stepDownPct: 50,
      },
    };
    const at = resolveIncomeRequired(state.plan, schedule, cpi, 0.04);
    expect(at(39)).toBeCloseTo(10000, 2); // age 94, still full
  });
});

describe("resolveIncomeRequired — no retirement block configured", () => {
  it("falls back to the schema default (currentExpenses from the client's own retirement age) rather than going inert", () => {
    const state = mkState({ clientAge: 55, endAge: 65, retirementAge: 60, expenses: [expenseRow(1000)] });
    const schedule = buildSchedules(state);
    // No state.plan.retirement at all — the mkState()-style raw fixture
    // every other test file in this codebase already uses.
    const at = resolveIncomeRequired(state.plan, schedule, state.assumptions.cpi, state.assumptions.wageGrowth);
    expect(at(4)).toBeNull();
    expect(at(5)).toBeCloseTo(12000, 2); // $1,000/month
  });
});

// --- Engine integration: reference-only, no side effects -------------------

function mkEngineState({ retirement, properties = [], liabilities = [] } = {}) {
  return {
    plan: {
      household: "single",
      client: { currentAge: 55, retirementAge: 60 },
      partner: null,
      endAge: 65,
      start: { year: 2026, month: 7 },
      retirement,
    },
    assets: [{
      id: "a1", name: "A1", include: true, owner: "client", distributions: "reinvest",
      balance: 200000, allocation: { mode: "custom", incomePct: 3, growthPct: 2, frankingPct: 0, volBasis: "Balanced" },
      icrPct: 0, cgtAsset: false, costBase: null,
    }],
    bonds: [],
    cashflows: {
      income: [{
        id: "i1", label: "Salary", owner: "client", amount: 80000, frequency: "annual",
        from: ageRef(55), to: ageRef(60), indexBasis: "cpi", indexExtraPct: 0, incomeType: "employment", sgApplies: false,
      }],
      expenses: [expenseRow(3000)],
      contributions: [], withdrawals: [], lumpSums: [], bondContributions: [],
    },
    liabilities,
    properties,
    settings: {
      surplus: { periods: [{ from: ageRef(55), to: ageRef(120), mode: "spend", assetId: null }] },
      fundingOrder: ["a1"],
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed", awote: 0.035, wageGrowth: 0.04 },
    display: { units: "real" },
  };
}

describe("engine integration — Income Required is reference-only", () => {
  it("appears on every yearly row, null before retirement, resolved from it, and changes NOTHING else in the projection", () => {
    const withDefault = projectPlan(mkEngineState(), PROFILES);
    const withCustom = projectPlan(mkEngineState({
      retirement: {
        incomeRequired: {
          source: "custom", customAmount: 42000,
          indexBasis: "cpi", indexExtraPct: 0,
          startAt: anchorRef("retirement-client"), stepDownAtAge: null, stepDownPct: 80,
        },
      },
    }), PROFILES);

    // Before retirement (plan years 0-4, ages 55-59): not yet applicable.
    for (let y = 0; y < 5; y++) {
      expect(withDefault.yearly[y].incomeRequired).toBeNull();
      expect(withCustom.yearly[y].incomeRequired).toBeNull();
    }
    // From retirement (plan year 5, age 60) onward: resolved per source.
    expect(withCustom.yearly[5].incomeRequired).toBeCloseTo(42000, 2);
    // Default source is currentExpenses ⇒ the $3,000/month expense row, $36,000/yr.
    expect(withDefault.yearly[5].incomeRequired).toBeCloseTo(36000, 2);

    // Every OTHER field on every row is byte-identical between the two
    // runs — the whole point of "reference line, not a driver" (spec 32,
    // Commit 1). Strip incomeRequired and compare the rest.
    const strip = (r) => r.yearly.map(({ incomeRequired, ...rest }) => rest);
    expect(strip(withCustom)).toEqual(strip(withDefault));
    expect(withCustom.accruedCgtAtEnd).toBe(withDefault.accruedCgtAtEnd);
    expect(Array.from(withCustom.monthly.combined)).toEqual(Array.from(withDefault.monthly.combined));
  });

  it("regression gate: a plan with no retirement block at all still projects bit-identically to one with the explicit default, aside from incomeRequired itself", () => {
    const bare = mkEngineState({ retirement: undefined });
    const explicit = mkEngineState({
      retirement: {
        incomeRequired: {
          source: "currentExpenses", customAmount: 0,
          indexBasis: "cpi", indexExtraPct: 0,
          startAt: anchorRef("retirement-client"), stepDownAtAge: null, stepDownPct: 80,
        },
      },
    });
    const a = projectPlan(bare, PROFILES);
    const b = projectPlan(explicit, PROFILES);
    expect(a.yearly).toEqual(b.yearly);
    expect(Array.from(a.monthly.combined)).toEqual(Array.from(b.monthly.combined));
  });
});

// This fixture's own plan (start 2026-07, endAge 65 from client age 55 —
// 10 plan years) runs its final month well past ASFA_STANDARDS_BASE's
// own periodEnd (2026-06-01), so any ASFA-sourced run here is
// unconditionally past the assumed validity window — the point of these
// tests is the GATING (only warn when an ASFA source is actually
// selected), not the date arithmetic itself (already covered in
// data/asfaStandards.test.js).
describe("engine integration — retirementWarnings (spec 32, Commit 2)", () => {
  it("is empty when no ASFA source is selected, even on a projection that runs well past the loaded ASFA quarter", () => {
    const result = projectPlan(mkEngineState(), PROFILES); // default source: currentExpenses
    expect(result.retirementWarnings).toEqual([]);
  });

  it("carries a staleness entry once an ASFA source is selected and the projection runs past the loaded quarter", () => {
    const result = projectPlan(mkEngineState({
      retirement: {
        incomeRequired: {
          source: "asfaComfortable", customAmount: 0,
          indexBasis: "cpi", indexExtraPct: 0,
          startAt: anchorRef("retirement-client"), stepDownAtAge: null, stepDownPct: 80,
        },
      },
    }), PROFILES);
    expect(result.retirementWarnings).toHaveLength(1);
    expect(result.retirementWarnings[0].type).toBe("staleness");
    expect(result.retirementWarnings[0].reason).toContain("March quarter 2026");
  });
});

describe("engine integration — asfaModest derives homeowner/renter from a REAL projected property and loan", () => {
  const irCfg = {
    source: "asfaModest", customAmount: 0, indexBasis: "cpi", indexExtraPct: 0,
    startAt: anchorRef("retirement-client"), stepDownAtAge: null, stepDownPct: 80,
  };
  const tinyPlan = { client: { currentAge: 55 } };

  it("a PPR with no loan at all resolves the HOMEOWNER modest figure through the real engine wiring (state.properties/state.liabilities threaded from deterministic.js into resolveIncomeRequired)", () => {
    const home = { ...createProperty(tinyPlan, [], 4), name: "Home", currentValue: 900000, acquisitionDate: "2000-01-01", costBase: 300000 };
    const result = projectPlan(mkEngineState({ retirement: { incomeRequired: irCfg }, properties: [home] }), PROFILES);
    expect(result.yearly[5].incomeRequired).toBeCloseTo(36434, 2); // single, ASFA Modest homeowner
  });

  it("a PPR with a 25-year loan not yet paid off by year 5 (retirement) resolves the RENTER modest figure — read from the loan's own PROJECTED closing balance, not its opening one", () => {
    const home = { ...createProperty(tinyPlan, [], 4), name: "Home", currentValue: 900000, acquisitionDate: "2000-01-01", costBase: 300000 };
    const loan = { ...createLiability(tinyPlan, []), name: "Mortgage", balance: 500000, termYears: 25, linkedAssetId: home.id };
    const result = projectPlan(mkEngineState({ retirement: { incomeRequired: irCfg }, properties: [home], liabilities: [loan] }), PROFILES);
    expect(result.yearly[5].incomeRequired).toBeCloseTo(51164, 2); // single, ASFA Modest renter — still paying it off
  });
});
