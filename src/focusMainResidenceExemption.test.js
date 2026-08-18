import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";
import {
  mainResidenceStatusAt, buildMainResidenceTimeline, buildCgtIfSoldSeries,
  eligibleMainResidenceProperties,
} from "./focusMainResidenceExemption.js";

function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client", balance: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function pprProperty(over = {}) {
  return {
    id: "p1", name: "Home", owner: "client", state: "NSW",
    propertyType: "ppr", status: "owned",
    currentValue: 600000, acquisitionDate: "2020-01-15", costBase: 500000,
    priceToday: 0, purchaseAt: { kind: "age", age: 45 },
    lvrPct: 0, firstHomeBuyer: false, newBuild: false,
    purchaseCostsPct: 0, dutyOverride: null, growthPct: 0,
    rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expensesDeductible: true, landValuePct: 60, landTaxOverride: 0,
    sale: { enabled: false, at: { kind: "age", age: 60 }, agentFeesPct: 2.5, settlementCosts: 2000, proceedsDestination: "asset", assetId: "a1" },
    mainResidence: { movedOutAt: null, producingIncome: false, movedBackInAt: null },
    ...over,
  };
}

function mkState(over = {}) {
  const assets = over.assets ?? [mkAsset()];
  return {
    plan: {
      household: "single", client: { currentAge: 40 }, partner: null,
      endAge: over.endAge ?? 46, start: { year: 2026, month: 7 },
      superAccounts: [], workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 },
      ...over.plan,
    },
    assets, goals: [], liabilities: [],
    properties: over.properties ?? [pprProperty()],
    cashflows: {
      income: over.income ?? [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [],
    },
    settings: {
      surplus: { periods: [{ id: "sp1", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" }, payNonDeductibleDebtFirst: false, debtOrder: "interestRate", allocations: [], remainderTo: "cash" }] },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("eligibleMainResidenceProperties", () => {
  it("includes only ppr properties", () => {
    const state = mkState({ properties: [pprProperty({ id: "p1" }), pprProperty({ id: "p2", propertyType: "investment" })] });
    expect(eligibleMainResidenceProperties(state).map((p) => p.id)).toEqual(["p1"]);
  });
});

describe("mainResidenceStatusAt", () => {
  const acquisition = "2020-01-01";

  it("is 'main-residence' throughout when never absent", () => {
    expect(mainResidenceStatusAt(acquisition, "2030-01-01", { movedOutAt: null })).toBe("main-residence");
  });

  it("is 'absent-covered' within six years of a producing-income absence", () => {
    const mr = { movedOutAt: "2022-01-01", producingIncome: true, movedBackInAt: null };
    expect(mainResidenceStatusAt(acquisition, "2023-01-01", mr)).toBe("absent-covered");
    expect(mainResidenceStatusAt(acquisition, "2027-06-01", mr)).toBe("absent-covered"); // just under 6yr
  });

  it("is 'absent-exceeded' once the six-year window lapses", () => {
    const mr = { movedOutAt: "2022-01-01", producingIncome: true, movedBackInAt: null };
    expect(mainResidenceStatusAt(acquisition, "2028-06-01", mr)).toBe("absent-exceeded");
  });

  it("is 'absent-covered' indefinitely (no clock) when not producing income", () => {
    const mr = { movedOutAt: "2022-01-01", producingIncome: false, movedBackInAt: null };
    expect(mainResidenceStatusAt(acquisition, "2040-01-01", mr)).toBe("absent-covered");
  });

  it("returns to 'main-residence' after moving back in, resetting the clock", () => {
    const mr = { movedOutAt: "2022-01-01", producingIncome: true, movedBackInAt: "2027-01-01" };
    expect(mainResidenceStatusAt(acquisition, "2028-06-01", mr)).toBe("main-residence");
  });
});

describe("buildMainResidenceTimeline", () => {
  it("returns one row per plan year with exempt days/proportion matching mainResidence.js's own exemptProportion", () => {
    const state = mkState({
      endAge: 50,
      properties: [pprProperty({
        acquisitionDate: "2020-07-01",
        mainResidence: { movedOutAt: { kind: "age", age: 41 }, producingIncome: true, movedBackInAt: null },
      })],
    });
    const out = projectPlan(clampAllToPlan(state, PROFILES));
    const rows = buildMainResidenceTimeline({ property: state.properties[0], plan: state.plan, schedule: out.schedule });
    expect(rows.length).toBe(out.yearly.length);
    // Year 0 (July 2026) — still occupied, fully exempt.
    expect(rows[0].status).toBe("main-residence");
    expect(rows[0].exemptProportion).toBe(1);
    // Year 8 (July 2034) — 7 years after moving out in July 2027, past the 6-year mark.
    const y8 = rows.find((r) => r.fyLabel.includes("2034"));
    expect(y8.status).toBe("absent-exceeded");
    expect(y8.exemptProportion).toBeLessThan(1);
    expect(y8.exemptDays).toBeLessThan(y8.totalDays);
  });

  it("reports 'investment' throughout for a non-ppr property", () => {
    const state = mkState({ properties: [pprProperty({ propertyType: "investment" })] });
    const out = projectPlan(clampAllToPlan(state, PROFILES));
    const rows = buildMainResidenceTimeline({ property: state.properties[0], plan: state.plan, schedule: out.schedule });
    expect(rows.every((r) => r.status === "investment")).toBe(true);
  });
});

describe("buildCgtIfSoldSeries", () => {
  it("matches the actual incremental tax of a real sale modelled in that year", () => {
    // A property that's lost its exemption by the sale year (moved out
    // at plan start, producing income, sold 10 years later — 4 years
    // past the 6-year mark) so a sale genuinely triggers CGT to compare.
    const propOver = {
      acquisitionDate: "2010-07-01",
      currentValue: 800000, costBase: 300000,
      // Nominal growth comfortably above the 2.5% CPI assumption — flat
      // (0%) growth would DECAY in real terms and could produce a
      // capital LOSS instead of a gain by the sale year (the CPI/
      // real-dollar decay pitfall this whole codebase's fixtures have
      // to watch for), which would defeat the point of this fixture.
      growthPct: 6,
      mainResidence: { movedOutAt: { kind: "age", age: 40 }, producingIncome: true, movedBackInAt: null },
    };
    const income = [{
      id: "i1", label: "Salary", owner: "client", amount: 150000, frequency: "annual",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
      indexBasis: "none", indexExtraPct: 0, incomeType: "employment", sgApplies: false,
    }];
    const targetYear = 10;
    const endAge = 53; // room for targetYear (10) + 1, past the sale

    // "Actual" run: the sale is genuinely enabled in the target year.
    const actualState = mkState({ income, endAge, properties: [pprProperty({ ...propOver, sale: {
      enabled: true, at: { kind: "age", age: 40 + targetYear }, agentFeesPct: 2.5, settlementCosts: 2000,
      proceedsDestination: "asset", assetId: "a1",
    } })] });
    const actualOut = projectPlan(clampAllToPlan(actualState, PROFILES));

    // Baseline: same plan, no sale at all — computed the SAME way
    // buildCgtIfSoldSeries computes its own baseline internally.
    const baselineState = mkState({ income, endAge, properties: [pprProperty({ ...propOver, sale: { ...pprProperty().sale, enabled: false } })] });
    const baselineOut = projectPlan(clampAllToPlan(baselineState, PROFILES));

    // CGT on a sale in targetYear is paid in July of targetYear+1 —
    // this engine's own accrual convention (see CLAUDE.md's Tax
    // section) — not the sale year's own tax figure.
    const actualIncrementalTax = actualOut.yearly[targetYear + 1].tax - baselineOut.yearly[targetYear + 1].tax;
    expect(actualIncrementalTax).toBeGreaterThan(0); // the fixture is built to genuinely owe CGT

    // The function under test, asked about the SAME year on the
    // UN-sold state (it builds its own baseline+sale runs internally).
    const noSaleState = mkState({ income, endAge, properties: [pprProperty({ ...propOver, sale: { ...pprProperty().sale, enabled: false } })] });
    const noSaleOut = projectPlan(clampAllToPlan(noSaleState, PROFILES));
    const series = buildCgtIfSoldSeries({ state: noSaleState, property: noSaleState.properties[0], out: noSaleOut, years: [targetYear] });

    expect(series).toHaveLength(1);
    expect(series[0].y).toBe(targetYear);
    expect(series[0].cgtPayable).toBeCloseTo(actualIncrementalTax, 0);
  });

  it("is flat at (near) zero while the exemption is fully intact", () => {
    const state = mkState({ properties: [pprProperty({ mainResidence: { movedOutAt: null, producingIncome: false, movedBackInAt: null } })] });
    const out = projectPlan(clampAllToPlan(state, PROFILES));
    const series = buildCgtIfSoldSeries({ state, property: state.properties[0], out, years: [1, 2, 3] });
    for (const row of series) expect(row.cgtPayable).toBeCloseTo(0, 0);
  });

  it("stays zero for a fully-exempt sale even when the plan's OWN destination asset earns real income (the confound this function's own measurement asset exists to avoid)", () => {
    // a1's own allocation earns real income/growth, unlike this file's
    // other fixtures' zero-yield mkAsset default — routing a sale's
    // proceeds through the REAL asset (as the user's own property.sale
    // is configured to) must not leak that asset's OWN earnings into
    // the reported "CGT payable" figure.
    const state = mkState({
      assets: [mkAsset({ id: "a1", allocation: { mode: "custom", incomePct: 4, growthPct: 3, frankingPct: 0, volBasis: "Balanced" } })],
      properties: [pprProperty({
        mainResidence: { movedOutAt: null, producingIncome: false, movedBackInAt: null },
        sale: { enabled: false, at: { kind: "age", age: 60 }, agentFeesPct: 2.5, settlementCosts: 2000, proceedsDestination: "asset", assetId: "a1" },
      })],
    });
    const out = projectPlan(clampAllToPlan(state, PROFILES));
    const series = buildCgtIfSoldSeries({ state, property: state.properties[0], out, years: [3] });
    expect(series[0].cgtPayable).toBeCloseTo(0, 0);
  });
});
