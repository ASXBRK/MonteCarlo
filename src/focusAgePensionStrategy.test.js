import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { agePensionStrategyEligible, buildAgePensionStrategyFocus } from "./focusAgePensionStrategy.js";

// Minimal v3-shaped state factory — mirrors focusSalarySacrifice.test.js's
// own (kept separate, not shared, per that file's header).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    distributions: "reinvest", balance: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function mkState(over = {}) {
  const assets = over.assets ?? [];
  return {
    plan: {
      household: "single",
      client: { currentAge: 40 },
      partner: null,
      endAge: over.endAge ?? 44,
      start: { year: 2026, month: 7 },
      superAccounts: [], pensions: [], gifts: [],
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

describe("agePensionStrategyEligible", () => {
  it("false when nobody ever reaches age pension age within the projection", () => {
    const state = mkState({ plan: { client: { currentAge: 40 } }, endAge: 44 });
    expect(agePensionStrategyEligible(projectPlan(state))).toBe(false);
  });

  it("true once someone in the household reaches it", () => {
    const state = mkState({ plan: { client: { currentAge: 67 } }, endAge: 68 });
    expect(agePensionStrategyEligible(projectPlan(state))).toBe(true);
  });
});

describe("buildAgePensionStrategyFocus (spec 21b, Commit 5)", () => {
  it("returns null when nobody ever reaches age pension age — nothing to compare", () => {
    const state = mkState({ plan: { client: { currentAge: 40 } }, endAge: 44 });
    expect(buildAgePensionStrategyFocus({ state })).toBeNull();
  });

  it("includes the current, gift, and work-income arms, each from a REAL projectPlan run", () => {
    const state = mkState({
      plan: { client: { currentAge: 67 } }, endAge: 68,
      assets: [mkAsset({ balance: 500000 })],
    });
    const result = buildAgePensionStrategyFocus({ state, giftAmount: 10000, workIncomeLevels: [10000] });
    expect(result.arms.map((a) => a.id)).toEqual(["current", "gift", "work10000"]);
    expect(result.byYear).toHaveLength(2);
    // Each arm's own figures come from a genuinely different engine
    // run — not the same output relabelled three times.
    const y0 = result.byYear[0];
    expect(y0.current.netAssets).not.toBe(y0.gift.netAssets);
  });

  it("the gift arm's net worth is always lower than the current plan's — the real leak the spec calls out (gifting is not free)", () => {
    const state = mkState({
      plan: { client: { currentAge: 67 } }, endAge: 70,
      assets: [mkAsset({ balance: 500000 })],
    });
    const result = buildAgePensionStrategyFocus({ state, giftAmount: 10000, workIncomeLevels: [] });
    for (const point of result.byYear) {
      expect(point.gift.netAssets).toBeLessThan(point.current.netAssets);
    }
  });

  it("a work-income arm's entitlement never exceeds the current plan's — extra income can only reduce or hold it, even net of the Work Bonus exemption", () => {
    const state = mkState({
      plan: { client: { currentAge: 67 } }, endAge: 68,
      assets: [mkAsset({ balance: 500000 })],
    });
    const result = buildAgePensionStrategyFocus({ state, giftAmount: 0, workIncomeLevels: [10000] });
    for (const point of result.byYear) {
      expect(point.work10000.entitlement).toBeLessThanOrEqual(point.current.entitlement);
    }
  });

  it("the gift arm is present whenever ANY later year is eligible, even if year 0 itself isn't", () => {
    const state = mkState({ plan: { client: { currentAge: 65 } }, endAge: 68 });
    const result = buildAgePensionStrategyFocus({ state });
    expect(result.arms.some((a) => a.id === "gift")).toBe(true);
  });

  it("omits work-income arms entirely when workIncomeLevels is empty — never fabricates an arm nobody asked for", () => {
    const state = mkState({ plan: { client: { currentAge: 67 } }, endAge: 68 });
    const result = buildAgePensionStrategyFocus({ state, workIncomeLevels: [] });
    expect(result.arms.some((a) => a.id.startsWith("work"))).toBe(false);
  });
});
