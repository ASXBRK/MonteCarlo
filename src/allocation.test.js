import { describe, it, expect } from "vitest";
import { allocationSeries, classWeightsForAllocation } from "./allocation.js";
import { PROFILES } from "./profiles.js";

// Minimal per-year row shape — only the fields allocationSeries reads.
function row(perAssetClosing, superDetail = {}, bondDetail = {}) {
  return { perAssetClosing, superDetail, bondDetail };
}

describe("classWeightsForAllocation", () => {
  it("profile mode uses the selected profile's classWeights", () => {
    const w = classWeightsForAllocation({ mode: "profile", profile: "Balanced" }, PROFILES);
    expect(w).toBe(PROFILES["Balanced"].classWeights);
  });

  it("custom mode borrows the volatility-basis profile's classWeights, not any incomePct/growthPct of its own", () => {
    const w = classWeightsForAllocation(
      { mode: "custom", incomePct: 9, growthPct: 1, frankingPct: 0, volBasis: "High Growth – Income" },
      PROFILES
    );
    expect(w).toBe(PROFILES["High Growth – Income"].classWeights);
  });

  it("an unknown/stale profile reference resolves to null rather than throwing", () => {
    expect(classWeightsForAllocation({ mode: "profile", profile: "Nonexistent" }, PROFILES)).toBeNull();
  });
});

describe("allocationSeries", () => {
  it("a single Balanced financial asset reproduces Balanced's own classWeights exactly", () => {
    const assets = [{ id: "a1", include: true, class: "financial", allocation: { mode: "profile", profile: "Balanced" } }];
    const yearly = [row({ a1: 100000 })];
    const { perYear, usesCustom } = allocationSeries(yearly, assets, [], PROFILES);
    expect(usesCustom).toBe(false);
    for (const k of Object.keys(PROFILES["Balanced"].classWeights)) {
      expect(perYear[0].weightPct[k]).toBeCloseTo(PROFILES["Balanced"].classWeights[k], 9);
    }
  });

  it("reconciles to the underlying asset balances × profile weights — a two-asset blend", () => {
    // $60k Balanced + $40k Cash. Expected Aus-equity weight: only
    // Balanced contributes (Cash's is 0) — 60,000 × 22.5% (Balanced's
    // ausEquity) ÷ 100,000 total = 13.5%.
    const assets = [
      { id: "a1", include: true, class: "financial", allocation: { mode: "profile", profile: "Balanced" } },
      { id: "a2", include: true, class: "financial", allocation: { mode: "profile", profile: "Cash" } },
    ];
    const yearly = [row({ a1: 60000, a2: 40000 })];
    const { perYear } = allocationSeries(yearly, assets, [], PROFILES);
    const expectedDollars = 60000 * (PROFILES["Balanced"].classWeights.ausEquity / 100)
      + 40000 * (PROFILES["Cash"].classWeights.ausEquity / 100);
    expect(perYear[0].byClass.ausEquity).toBeCloseTo(expectedDollars, 6);
    expect(perYear[0].weightPct.ausEquity).toBeCloseTo((expectedDollars / 100000) * 100, 6);
    expect(perYear[0].weightPct.ausEquity).toBeCloseTo(13.5, 6);
  });

  it("every year's weightPct sums to 100% whenever the total is nonzero", () => {
    const assets = [
      { id: "a1", include: true, class: "financial", allocation: { mode: "profile", profile: "Moderate Growth" } },
      { id: "a2", include: true, class: "financial", allocation: { mode: "profile", profile: "High Growth – Capital" } },
    ];
    const superAccounts = [{ id: "su1", include: true, allocation: { mode: "profile", profile: "Cash" } }];
    const yearly = [
      row({ a1: 50000, a2: 30000 }, { su1: { closing: 20000 } }),
      row({ a1: 55000, a2: 33000 }, { su1: { closing: 22000 } }),
    ];
    const { perYear } = allocationSeries(yearly, assets, superAccounts, PROFILES);
    for (const y of perYear) {
      const sum = Object.values(y.weightPct).reduce((s, v) => s + v, 0);
      expect(sum).toBeCloseTo(100, 6);
    }
  });

  it("super accounts are included and follow their own profile", () => {
    const superAccounts = [{ id: "su1", include: true, allocation: { mode: "profile", profile: "Residential Property" } }];
    const yearly = [row({}, { su1: { closing: 100000 } })];
    const { perYear } = allocationSeries(yearly, [], superAccounts, PROFILES);
    expect(perYear[0].weightPct.property).toBeCloseTo(100, 9);
    expect(perYear[0].total).toBe(100000);
  });

  it("lifestyle assets and excluded assets/accounts are excluded from the mix entirely", () => {
    const assets = [
      { id: "a1", include: true, class: "financial", allocation: { mode: "profile", profile: "Balanced" } },
      { id: "life", include: true, class: "lifestyle", allocation: { mode: "profile", profile: "Balanced" } },
      { id: "excl", include: false, class: "financial", allocation: { mode: "profile", profile: "Cash" } },
    ];
    const superAccounts = [{ id: "su1", include: false, allocation: { mode: "profile", profile: "Cash" } }];
    const yearly = [row({ a1: 10000, life: 500000, excl: 200000 }, { su1: { closing: 300000 } })];
    const { perYear } = allocationSeries(yearly, assets, superAccounts, PROFILES);
    // Only a1's $10,000 should count.
    expect(perYear[0].total).toBe(10000);
  });

  it("usesCustom is true when any included, non-lifestyle holding is in custom mode", () => {
    const assets = [{
      id: "a1", include: true, class: "financial",
      allocation: { mode: "custom", incomePct: 3, growthPct: 2, frankingPct: 0, volBasis: "Balanced" },
    }];
    const { usesCustom } = allocationSeries([row({ a1: 100000 })], assets, [], PROFILES);
    expect(usesCustom).toBe(true);
  });

  it("a year with zero total gives null weightPct rather than NaN", () => {
    const assets = [{ id: "a1", include: true, class: "financial", allocation: { mode: "profile", profile: "Balanced" } }];
    const { perYear } = allocationSeries([row({ a1: 0 })], assets, [], PROFILES);
    expect(perYear[0].total).toBe(0);
    for (const v of Object.values(perYear[0].weightPct)) expect(v).toBeNull();
  });

  it("bonds (spec 25, Commit 2) contribute to the mix like any other holding, folded into the SAME class blend", () => {
    const assets = [{ id: "a1", include: true, class: "financial", allocation: { mode: "profile", profile: "Cash" } }];
    const bonds = [{ id: "bd1", include: true, allocation: { mode: "profile", profile: "Balanced" } }];
    const yearly = [row({ a1: 40000 }, {}, { bd1: { closing: 60000 } })];
    const { perYear } = allocationSeries(yearly, assets, [], PROFILES, bonds);
    expect(perYear[0].total).toBe(100000);
    const expected = 60000 * (PROFILES["Balanced"].classWeights.ausEquity / 100) / 100000 * 100;
    expect(perYear[0].weightPct.ausEquity).toBeCloseTo(expected, 6);
  });

  it("an excluded bond contributes nothing", () => {
    const bonds = [{ id: "bd1", include: false, allocation: { mode: "profile", profile: "Balanced" } }];
    const yearly = [row({}, {}, { bd1: { closing: 60000 } })];
    const { perYear } = allocationSeries(yearly, [], [], PROFILES, bonds);
    expect(perYear[0].total).toBe(0);
  });

  // --- Glide paths (spec 32, Commit 4) ------------------------------------

  describe("glide paths", () => {
    const GP = {
      id: "gp1", rebalance: "annual",
      steps: [{ fromAge: 40, profile: "High Growth – Capital" }, { fromAge: 42, profile: "Cash" }],
    };

    it("a glide-pathed asset at its first step's own age reproduces that profile's classWeights exactly", () => {
      const assets = [{ id: "a1", include: true, class: "financial", allocation: { mode: "glidePath", glidePathId: "gp1" } }];
      const yearly = [row({ a1: 100000 })];
      const { perYear } = allocationSeries(yearly, assets, [], PROFILES, [], [GP], { client: [40] });
      const hg = PROFILES["High Growth – Capital"].classWeights;
      for (const k of Object.keys(hg)) expect(perYear[0].weightPct[k]).toBeCloseTo(hg[k], 6);
    });

    it("the class mix moves year to year across the ramp, ending at the last step's own profile", () => {
      const assets = [{ id: "a1", include: true, class: "financial", allocation: { mode: "glidePath", glidePathId: "gp1" } }];
      const yearly = [row({ a1: 100000 }), row({ a1: 100000 }), row({ a1: 100000 })]; // ages 40, 41, 42
      const { perYear } = allocationSeries(yearly, assets, [], PROFILES, [], [GP], { client: [40, 41, 42] });
      const cash = PROFILES["Cash"].classWeights;
      // year 0 (age 40) is 100% High Growth — Cash carries no ausEquity
      // at all, so High Growth's own (well above zero) ausEquity weight
      // is the clean divergence to check.
      expect(perYear[0].weightPct.ausEquity).toBeGreaterThan(0);
      // year 2 (age 42, the last step) is 100% Cash.
      for (const k of Object.keys(cash)) expect(perYear[2].weightPct[k]).toBeCloseTo(cash[k], 6);
      // year 1 sits strictly between the two.
      expect(perYear[1].weightPct.ausEquity).toBeGreaterThan(perYear[2].weightPct.ausEquity);
      expect(perYear[1].weightPct.ausEquity).toBeLessThan(perYear[0].weightPct.ausEquity);
    });

    it("a super account's glide path anchors to ITS OWN owner's age, not the client's", () => {
      const superAccounts = [{ id: "su1", include: true, owner: "partner", allocation: { mode: "glidePath", glidePathId: "gp1" } }];
      const yearly = [row({}, { su1: { closing: 100000 } })];
      // Client is 30 (well before the glide path even starts); the
      // OWNER (partner) is 42 (the last step) — the result must follow
      // the partner's own age, not the client's.
      const { perYear } = allocationSeries(yearly, [], superAccounts, PROFILES, [], [GP], { client: [30], partner: [42] });
      const cash = PROFILES["Cash"].classWeights;
      for (const k of Object.keys(cash)) expect(perYear[0].weightPct[k]).toBeCloseTo(cash[k], 6);
    });

    it("a period-sliced yearly array still resolves against the FULL, unsliced age array via yearIndexOf — never restarting the glide at the selection's own first year", () => {
      const assets = [{ id: "a1", include: true, class: "financial", allocation: { mode: "glidePath", glidePathId: "gp1" } }];
      const fullYearly = [row({ a1: 100000 }), row({ a1: 100000 }), row({ a1: 100000 })]; // ages 40, 41, 42
      const fullAges = [40, 41, 42];
      const sliceIdxs = [2]; // only the last year selected (age 42)
      const sliced = sliceIdxs.map((y) => fullYearly[y]);
      const { perYear } = allocationSeries(
        sliced, assets, [], PROFILES, [], [GP], { client: fullAges }, (i) => sliceIdxs[i]
      );
      const cash = PROFILES["Cash"].classWeights;
      // Without yearIndexOf, index 0 of the SLICED array would
      // (wrongly) look up age 40 (100% High Growth) instead of the
      // true absolute year 2 (age 42, 100% Cash).
      for (const k of Object.keys(cash)) expect(perYear[0].weightPct[k]).toBeCloseTo(cash[k], 6);
    });

    it("a dangling glidePathId contributes nothing, same as an unknown profile reference", () => {
      const assets = [{ id: "a1", include: true, class: "financial", allocation: { mode: "glidePath", glidePathId: "no-such-id" } }];
      const yearly = [row({ a1: 100000 })];
      const { perYear } = allocationSeries(yearly, assets, [], PROFILES, [], [GP], { client: [40] });
      expect(perYear[0].total).toBe(0);
    });

    it("regression gate: an ordinary profile-mode holding is unaffected by unrelated glide paths being passed in", () => {
      const assets = [{ id: "a1", include: true, class: "financial", allocation: { mode: "profile", profile: "Balanced" } }];
      const yearly = [row({ a1: 100000 })];
      const withoutGP = allocationSeries(yearly, assets, [], PROFILES);
      const withGP = allocationSeries(yearly, assets, [], PROFILES, [], [GP], { client: [40] });
      expect(withGP.perYear[0].weightPct).toEqual(withoutGP.perYear[0].weightPct);
    });
  });
});
