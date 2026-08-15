import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { eligibleSalarySacrificeRows, buildSalarySacrificeFocus } from "./focusSalarySacrifice.js";

// Minimal v3-shaped state factory — mirrors deterministic.test.js's own
// mkState (kept separate, not shared — see solve.test.js's header for why).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    distributions: "reinvest", balance: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function superAcct(over = {}) {
  return {
    id: "su1", name: "Super", owner: "client", balance: 0, taxFreeComponent: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, include: true,
    ...over,
  };
}

function employmentRow(over = {}) {
  return {
    id: "i1", label: "Salary", owner: "client", amount: 150000, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 },
    indexBasis: "cpi", indexExtraPct: 0, incomeType: "employment", sgApplies: false,
    ...over,
  };
}

function scRow(over = {}) {
  return {
    id: "sc1", label: "Sacrifice", owner: "client", accountId: "su1",
    type: "salarySacrifice", basis: "amount", amount: 20000, percent: 0, incomeRowId: null,
    frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 },
    indexBasis: "cpi", indexExtraPct: 0,
    ...over,
  };
}

function mkState(over = {}) {
  const assets = over.assets ?? [mkAsset()];
  return {
    plan: {
      household: "single",
      client: { currentAge: 40, helpBalance: over.helpBalance ?? 0 },
      partner: null,
      endAge: over.endAge ?? 41,
      start: { year: 2026, month: 7 },
      superAccounts: over.superAccounts ?? [],
      workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
      ...over.plan,
    },
    assets,
    goals: [],
    liabilities: [],
    properties: [],
    cashflows: {
      income: [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [],
      ...over.cashflows,
    },
    settings: {
      surplus: { mode: "accumulate", assetId: null },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

function baseState(over = {}) {
  return mkState({
    plan: { superAccounts: [superAcct()] },
    cashflows: { income: [employmentRow()], superContributions: [scRow()] },
    ...over,
  });
}

describe("eligibleSalarySacrificeRows", () => {
  it("finds salary-sacrifice rows only, not personal deductible/SG", () => {
    const state = baseState({
      cashflows: {
        superContributions: [
          scRow({ id: "sc1", type: "salarySacrifice" }),
          scRow({ id: "sc2", type: "personalDeductible" }),
        ],
      },
    });
    expect(eligibleSalarySacrificeRows(state).map((r) => r.id)).toEqual(["sc1"]);
  });
});

describe("buildSalarySacrificeFocus", () => {
  it("the no-sacrifice arm equals the projection with the contribution deleted", () => {
    const state = baseState();
    const f = buildSalarySacrificeFocus({ state, contributionId: "sc1", amount: 20000 });
    // Independently reconstruct the "without" clone by hand.
    const manualWithout = structuredClone(state);
    manualWithout.cashflows.superContributions = [];
    const manualOut = projectPlan(manualWithout);
    for (let y = 0; y < f.byYear.length; y++) {
      expect(f.byYear[y].netAssetsWithout).toBeCloseTo(manualOut.yearly[y].netAssets, 6);
      expect(f.byYear[y].incomeTaxWithout).toBeCloseTo(manualOut.yearly[y].taxDetail.client.incomeTax, 6);
    }
  });

  it("HELP is identical across arms — reportable super contributions add the sacrifice straight back", () => {
    const state = baseState({ helpBalance: 100000 });
    const f = buildSalarySacrificeFocus({ state, contributionId: "sc1", amount: 20000 });
    for (const row of f.byYear) {
      expect(row.helpWith).toBeCloseTo(row.helpWithout, 2);
    }
    // Not a vacuous check — HELP is genuinely due in this scenario.
    expect(f.byYear[0].helpWith).toBeGreaterThan(0);
  });

  it("income tax saved is positive, and cash is reduced, when sacrificing", () => {
    const state = baseState();
    const f = buildSalarySacrificeFocus({ state, contributionId: "sc1", amount: 20000 });
    expect(f.byYear[0].incomeTaxSaved).toBeGreaterThan(0);
    expect(f.byYear[0].cashReduced).toBeGreaterThan(0);
    // Sacrificing should never leave the household worse off overall
    // once super is counted — net assets should be close either way
    // (the difference is just contributions tax + the tax saved),
    // not wildly divergent.
    expect(Math.abs(f.byYear[0].netAssetsWith - f.byYear[0].netAssetsWithout)).toBeLessThan(20000);
  });

  it("super gained is net of the 15% contributions tax, matching superDetail exactly", () => {
    const state = baseState();
    const f = buildSalarySacrificeFocus({ state, contributionId: "sc1", amount: 20000 });
    const out = projectPlan(state);
    const d = out.yearly[0].superDetail.su1;
    expect(f.byYear[0].superGainedNet).toBeCloseTo(d.contributions - d.contributionsTax, 2);
    expect(f.byYear[0].superGainedNet).toBeCloseTo(20000 * 0.85, 0);
  });

  it("the adjustable amount changes the comparison without touching the caller's state", () => {
    const state = baseState();
    const before = JSON.stringify(state);
    const small = buildSalarySacrificeFocus({ state, contributionId: "sc1", amount: 5000 });
    const large = buildSalarySacrificeFocus({ state, contributionId: "sc1", amount: 20000 });
    expect(large.byYear[0].superGainedNet).toBeGreaterThan(small.byYear[0].superGainedNet);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("returns null for an unknown contribution id", () => {
    expect(buildSalarySacrificeFocus({ state: baseState(), contributionId: "nope", amount: 1000 })).toBeNull();
  });
});
