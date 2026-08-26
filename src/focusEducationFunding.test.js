import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { eligibleEducationFundingChildren, buildEducationFundingFocus } from "./focusEducationFunding.js";

// Minimal v3-shaped state factory — mirrors focusDebtRecycling.test.js's
// own mkState (kept separate per Focus test file convention).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "Cash", include: true, owner: "client",
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

function child(over = {}) {
  return {
    id: "ch1", name: "Child 1", dateOfBirth: "2018-01-01",
    education: [{ id: "ed1", label: "School", annualAmount: 15000, fromAge: 5, toAge: 12, indexBasis: "none", indexExtraPct: 0 }],
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
      endAge: over.endAge ?? 48,
      start: { year: 2026, month: 7 },
      superAccounts: [],
      workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
      children: over.children ?? [child()],
      ...over.plan,
    },
    assets,
    bonds: over.bonds ?? [],
    goals: [],
    liabilities: [],
    properties: [],
    cashflows: {
      income: over.income ?? [employmentRow()],
      expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [], bondContributions: [],
    },
    settings: {
      surplus: over.surplus ?? { mode: "accumulate", assetId: null },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("eligibleEducationFundingChildren", () => {
  it("includes a child with a real fee amount, excludes one with none", () => {
    const state = mkState({ children: [child({ id: "ch1" }), child({ id: "ch2", education: [] })] });
    expect(eligibleEducationFundingChildren(state).map((c) => c.id)).toEqual(["ch1"]);
  });
});

describe("buildEducationFundingFocus", () => {
  it("returns null for an unknown child id, and for a child with no fee schedule", () => {
    const state = mkState();
    const out = projectPlan(state);
    expect(buildEducationFundingFocus({ out, state, childId: "nope" })).toBeNull();
    const noFees = mkState({ children: [child({ education: [] })] });
    expect(buildEducationFundingFocus({ out: projectPlan(noFees), state: noFees, childId: "ch1" })).toBeNull();
  });

  it("all three arms reconcile to real, independent projectPlan() runs — same seed, same fee schedule", () => {
    const state = mkState();
    const out = projectPlan(state);
    const f = buildEducationFundingFocus({ out, state, childId: "ch1" });
    expect(f.seed).toBeCloseTo(15000 * 8, 2); // 8 years (age 5-12 inclusive)
    // Three genuinely different runs — not a single hand-derived one.
    const y0 = f.series[0];
    expect(y0.netAssetsBaseline).not.toBeCloseTo(y0.netAssetsInvestment, 0);
    expect(y0.netAssetsInvestment).not.toBeCloseTo(y0.netAssetsEducation, 0);
  });

  it("the education bond's own benefit shows up in the series once fees start drawing it down", () => {
    const state = mkState();
    const out = projectPlan(state);
    const f = buildEducationFundingFocus({ out, state, childId: "ch1" });
    // Fees fire from age 5 — the household starts at age 40 (client),
    // so this test's child (born 2018, plan starts 2026) is already 8
    // at plan start — the fee fires from year 0.
    expect(f.series[0].educationBenefit).toBeGreaterThan(0);
  });

  it("flags a bond as worse than the alternative for a low-marginal-rate client", () => {
    // No income at all → 0% marginal rate throughout: the bond's own
    // flat internal tax (up to 30%) can only ever be a worse deal than
    // an ordinary asset paying 0% tax on the same growth.
    const state = mkState({ income: [] });
    const out = projectPlan(state);
    const f = buildEducationFundingFocus({ out, state, childId: "ch1" });
    expect(f.flags.investmentWorseThanBaseline).toBe(true);
    expect(f.flags.educationWorseThanBaseline).toBe(true);
  });

  it("carries the non-prescriptive disclosure text on the ten-year/125%/marginal-rate constraints", () => {
    const state = mkState();
    const f = buildEducationFundingFocus({ out: projectPlan(state), state, childId: "ch1" });
    expect(f.disclosure).toMatch(/ten-year/i);
    expect(f.disclosure).toMatch(/125%/);
  });

  it("never mutates the caller's state", () => {
    const state = mkState();
    const before = JSON.stringify(state);
    const out = projectPlan(state);
    buildEducationFundingFocus({ out, state, childId: "ch1" });
    expect(JSON.stringify(state)).toBe(before);
  });
});
