import { describe, it, expect } from "vitest";
import { buildCrashTimingView, representativeCrashAges } from "./whatIfCrash.js";
import { buildSchedules } from "./schedule.js";

function mkAsset(over = {}) {
  return {
    id: "a1", name: "Balanced", include: true, owner: "client",
    distributions: "reinvest", balance: 200000,
    allocation: { mode: "profile", profile: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function mkState(over = {}) {
  const assets = over.assets ?? [mkAsset()];
  return {
    plan: {
      household: "single",
      client: { currentAge: 40, retirementAge: 65 },
      partner: null,
      endAge: over.endAge ?? 90,
      start: { year: 2026, month: 7 },
      superAccounts: [],
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

describe("representativeCrashAges", () => {
  it("returns three ages spread across the accumulation phase, all within the plan window", () => {
    const state = mkState({ endAge: 65 }); // retirement anchor defaults to endAge absent an explicit retirement input
    const schedule = buildSchedules(state);
    const ages = representativeCrashAges(state, schedule);
    expect(ages).toHaveLength(3);
    expect(ages.map((a) => a.label)).toEqual(["Early", "Mid-career", "Near retirement"]);
    for (const a of ages) {
      expect(a.age).toBeGreaterThan(state.plan.client.currentAge);
      expect(a.age).toBeLessThan(state.plan.endAge);
    }
    // Ages should be non-decreasing (early ≤ mid ≤ near-retirement).
    expect(ages[0].age).toBeLessThanOrEqual(ages[1].age);
    expect(ages[1].age).toBeLessThanOrEqual(ages[2].age);
  });
});

describe("buildCrashTimingView", () => {
  it("returns null when there's nothing a crash could act on", () => {
    const cashOnly = mkAsset({ allocation: { mode: "profile", profile: "Cash" } });
    const state = mkState({ assets: [cashOnly] });
    // Cash is a valid holding (it's not lifestyle), so this should NOT
    // be null — crashHoldings includes it, it just never gets shocked.
    expect(buildCrashTimingView({ state, dropPct: 30, recoveryYears: 0 })).not.toBeNull();
    // Genuinely nothing to act on: no assets, no super at all.
    const empty = { ...state, assets: [] };
    expect(buildCrashTimingView({ state: empty, dropPct: 30, recoveryYears: 0 })).toBeNull();
  });

  it("runs the SAME shock at three ages against the SAME base — identical magnitude, different outcomes", () => {
    const state = mkState();
    const view = buildCrashTimingView({ state, dropPct: 40, recoveryYears: 0 });
    expect(view.ages).toHaveLength(3);
    for (const a of view.ages) {
      expect(a.out).not.toBeNull();
      expect(a.out.yearly.length).toBe(view.base.yearly.length);
    }
    const ends = view.ages.map((a) => a.out.yearly[a.out.yearly.length - 1].netAssets);
    // At least one pair of ages must differ materially — the entire
    // point of the three-ages presentation.
    const spread = Math.max(...ends) - Math.min(...ends);
    expect(spread).toBeGreaterThan(1000);
  });
});
