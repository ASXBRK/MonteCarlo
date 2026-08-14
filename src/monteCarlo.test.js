import { describe, it, expect } from "vitest";
import { runMonteCarlo, holdingsFor, createRng, MARKET_RHO } from "./monteCarlo.js";
import { checkYearConservation } from "./conservationCheck.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";

// Minimal v3-shaped state factory — mirrors deterministic.test.js's
// mkAsset/mkState conventions so a reviewer doesn't have to learn a
// second dialect for the same shapes.
function mkAsset(over = {}) {
  return {
    id: "a1", name: "A1", include: true, owner: "client",
    distributions: "reinvest", balance: 100000,
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
      client: { currentAge: 40 },
      partner: null,
      endAge: over.endAge ?? 44,
      start: over.start ?? { year: 2026, month: 7 },
      ...over.plan,
    },
    assets,
    cashflows: {
      income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [],
      ...over.cashflows,
    },
    settings: {
      surplus: over.surplus ?? { mode: "accumulate", assetId: null },
      fundingOrder: over.fundingOrder ?? assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: over.cpi ?? 0.025, bracketMode: over.bracketMode ?? "indexed" },
    display: { units: "real" },
  };
}
function superAcct(over = {}) {
  return {
    id: "su1", name: "Super", owner: "client", balance: 0, taxFreeComponent: 0,
    allocation: { mode: "profile", profile: "Balanced" },
    icrPct: 0, include: true,
    ...over,
  };
}
function employmentRow(over = {}) {
  return {
    id: "i1", label: "Salary", owner: "client", amount: 100000, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
    indexBasis: "cpi", indexExtraPct: 0, incomeType: "employment", sgApplies: true,
    ...over,
  };
}

describe("holdingsFor", () => {
  it("includes profile-mode financial assets and super accounts, resolved to their profile", () => {
    const state = mkState({
      assets: [mkAsset({ id: "a1", allocation: { mode: "profile", profile: "Balanced" } })],
      plan: { superAccounts: [superAcct({ id: "su1", allocation: { mode: "profile", profile: "Cash" } })] },
    });
    const holdings = holdingsFor(state, PROFILES);
    expect(holdings.map((h) => h.id).sort()).toEqual(["a1", "su1"]);
    expect(holdings.find((h) => h.id === "a1").profile).toBe(PROFILES["Balanced"]);
    expect(holdings.find((h) => h.id === "su1").profile).toBe(PROFILES["Cash"]);
  });

  it("resolves a custom allocation to its volatility-basis profile, same as the allocation chart", () => {
    const state = mkState({
      assets: [mkAsset({
        id: "a1",
        allocation: { mode: "custom", incomePct: 3, growthPct: 2, frankingPct: 0, volBasis: "High Growth – Income" },
      })],
    });
    const holdings = holdingsFor(state, PROFILES);
    expect(holdings[0].profile).toBe(PROFILES["High Growth – Income"]);
  });

  it("excludes lifestyle assets (no profile, no volatility concept) and excluded assets/accounts", () => {
    const state = mkState({
      assets: [
        mkAsset({ id: "a1", allocation: { mode: "profile", profile: "Balanced" } }),
        mkAsset({ id: "life", class: "lifestyle", growthPct: 0, allocation: { mode: "profile", profile: "Balanced" } }),
        mkAsset({ id: "excl", include: false, allocation: { mode: "profile", profile: "Cash" } }),
      ],
      plan: { superAccounts: [superAcct({ id: "su1", include: false })] },
    });
    expect(holdingsFor(state, PROFILES).map((h) => h.id)).toEqual(["a1"]);
  });
});

describe("runMonteCarlo", () => {
  it("with no shockable holdings, every percentile equals the single deterministic path exactly", () => {
    // A lifestyle-only plan: nothing in holdingsFor, so shockFor is 0
    // everywhere and every one of the (still-many) simulated paths is
    // byte-identical to the deterministic run.
    const state = mkState({
      assets: [mkAsset({ id: "a1", class: "lifestyle", growthPct: 3, allocation: undefined })],
    });
    const result = runMonteCarlo(state, PROFILES, { numPaths: 10, sampleCount: 3, rng: createRng(1) });
    for (let y = 0; y < result.years; y++) {
      expect(result.netAssets.p10[y]).toBeCloseTo(result.netAssets.p50[y], 6);
      expect(result.netAssets.p50[y]).toBeCloseTo(result.netAssets.p90[y], 6);
    }
  });

  it("percentiles are monotonic (p10 ≤ p25 ≤ p50 ≤ p75 ≤ p90) every year, for a genuinely shocked plan", () => {
    const state = mkState({
      endAge: 55,
      assets: [mkAsset({ id: "a1", balance: 200000, allocation: { mode: "profile", profile: "High Growth – Capital" } })],
      cashflows: { income: [employmentRow({ amount: 80000 })] },
      plan: { superAccounts: [superAcct({ id: "su1", balance: 50000 })] },
    });
    const result = runMonteCarlo(state, PROFILES, { numPaths: 60, sampleCount: 5, rng: createRng(7) });
    for (let y = 0; y < result.years; y++) {
      const { p10, p25, p50, p75, p90 } = result.netAssets;
      expect(p10[y]).toBeLessThanOrEqual(p25[y]);
      expect(p25[y]).toBeLessThanOrEqual(p50[y]);
      expect(p50[y]).toBeLessThanOrEqual(p75[y]);
      expect(p75[y]).toBeLessThanOrEqual(p90[y]);
    }
  });

  it("is reproducible given the same seeded rng", () => {
    const state = mkState({
      assets: [mkAsset({ allocation: { mode: "profile", profile: "Balanced" } })],
    });
    const a = runMonteCarlo(state, PROFILES, { numPaths: 15, sampleCount: 4, rng: createRng(42) });
    const b = runMonteCarlo(state, PROFILES, { numPaths: 15, sampleCount: 4, rng: createRng(42) });
    expect(a.netAssets.p50).toEqual(b.netAssets.p50);
    expect(a.ruinProbability).toBe(b.ruinProbability);
  });

  // Regression test for the exact reported defect: options.seed was
  // documented but never actually consumed, so every run used
  // Math.random regardless — two calls with the same seed produced
  // different netAssets. Fixed via createRng(seed); this asserts the
  // fix at the exact call shape the defect was reported with.
  it("options.seed alone (no rng override) makes two runs byte-identical — the reported defect", () => {
    const state = {
      ...mkState({
        endAge: 46,
        assets: [mkAsset({ id: "a1", balance: 200000, allocation: { mode: "profile", profile: "High Growth – Capital" } })],
        cashflows: { income: [employmentRow({ amount: 90000 })] },
        plan: { superAccounts: [superAcct({ id: "su1", balance: 50000 })] },
      }),
      liabilities: [{
        id: "lb1", name: "Loan", type: "mortgage", owner: "client",
        balance: 200000, interestRatePct: 6, termYears: 20, repayment: "pi",
        ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
      }],
    };
    const a = runMonteCarlo(state, PROFILES, { numPaths: 30, seed: 42 });
    const b = runMonteCarlo(state, PROFILES, { numPaths: 30, seed: 42 });
    expect(a.netAssets).toEqual(b.netAssets);
    expect(a.ruinProbability).toBe(b.ruinProbability);
    expect(a.samplePaths.map((o) => o.yearly.map((r) => r.netAssets)))
      .toEqual(b.samplePaths.map((o) => o.yearly.map((r) => r.netAssets)));
    // And a different seed genuinely produces a different result —
    // otherwise "byte-identical" above would trivially hold because
    // nothing is actually random.
    const c = runMonteCarlo(state, PROFILES, { numPaths: 30, seed: 43 });
    expect(c.netAssets.p50).not.toEqual(a.netAssets.p50);
  });

  it("ρ = 1 makes two identical-profile assets' returns perfectly correlated; ρ = 0 makes them independent", () => {
    const stateFor = () => mkState({
      assets: [
        mkAsset({ id: "a1", balance: 100000, allocation: { mode: "profile", profile: "High Growth – Capital" } }),
        mkAsset({ id: "a2", balance: 100000, allocation: { mode: "profile", profile: "High Growth – Capital" } }),
      ],
      endAge: 41,
    });
    const correlationOf = (rho, seed) => {
      const result = runMonteCarlo(stateFor(), PROFILES, { numPaths: 300, sampleCount: 300, rho, seed });
      const r1 = result.samplePaths.map((out) => out.yearly[0].perAssetClosing.a1);
      const r2 = result.samplePaths.map((out) => out.yearly[0].perAssetClosing.a2);
      const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
      const m1 = mean(r1), m2 = mean(r2);
      const cov = mean(r1.map((v, i) => (v - m1) * (r2[i] - m2)));
      const sd1 = Math.sqrt(mean(r1.map((v) => (v - m1) ** 2)));
      const sd2 = Math.sqrt(mean(r2.map((v) => (v - m2) ** 2)));
      return cov / (sd1 * sd2);
    };
    expect(correlationOf(1, 1)).toBeCloseTo(1, 6);
    expect(Math.abs(correlationOf(0, 2))).toBeLessThan(0.15); // sampling noise band at N=300, not exactly 0
  });

  it("zero σ on every profile (and zero CPI variation) reproduces the deterministic projection exactly on every path", () => {
    const zeroSigmaProfiles = Object.fromEntries(
      Object.entries(PROFILES).map(([name, p]) => [name, { ...p, sigma_normal: 0, sigma_stress: 0 }])
    );
    const state = mkState({
      endAge: 50,
      assets: [mkAsset({ id: "a1", balance: 150000, allocation: { mode: "profile", profile: "High Growth – Capital" } })],
      cashflows: { income: [employmentRow({ amount: 90000 })] },
      plan: { superAccounts: [superAcct({ id: "su1", balance: 60000 })] },
    });
    const deterministic = projectPlan(state, zeroSigmaProfiles);
    const result = runMonteCarlo(state, zeroSigmaProfiles, { numPaths: 12, sampleCount: 12, seed: 5, cpiSigma: 0 });
    for (let y = 0; y < result.years; y++) {
      expect(result.netAssets.p10[y]).toBeCloseTo(deterministic.yearly[y].netAssets, 6);
      expect(result.netAssets.p90[y]).toBeCloseTo(deterministic.yearly[y].netAssets, 6);
    }
    for (const out of result.samplePaths) {
      for (let y = 0; y < out.yearly.length; y++) {
        expect(out.yearly[y].netAssets).toBeCloseTo(deterministic.yearly[y].netAssets, 6);
      }
    }
  });

  it("a shared market factor at ρ 0.85 makes two assets' realised returns strongly, but not perfectly, correlated", () => {
    // Two identical-profile assets, otherwise independent — the only
    // thing linking their outcomes is the shared market factor.
    // Compare EACH path's realised total return (not the percentile
    // bands, which mix regime-state and idiosyncratic noise across
    // paths in a way that would obscure this) via the sample paths'
    // own per-asset closing balances.
    const state = mkState({
      assets: [
        mkAsset({ id: "a1", balance: 100000, allocation: { mode: "profile", profile: "High Growth – Capital" } }),
        mkAsset({ id: "a2", balance: 100000, allocation: { mode: "profile", profile: "High Growth – Capital" } }),
      ],
      endAge: 41,
    });
    const N = 200;
    const result = runMonteCarlo(state, PROFILES, { numPaths: N, sampleCount: N, rng: createRng(3) });
    const r1 = result.samplePaths.map((out) => out.yearly[0].perAssetClosing.a1);
    const r2 = result.samplePaths.map((out) => out.yearly[0].perAssetClosing.a2);
    const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const m1 = mean(r1), m2 = mean(r2);
    const cov = mean(r1.map((v, i) => (v - m1) * (r2[i] - m2)));
    const sd1 = Math.sqrt(mean(r1.map((v) => (v - m1) ** 2)));
    const sd2 = Math.sqrt(mean(r2.map((v) => (v - m2) ** 2)));
    const corr = cov / (sd1 * sd2);
    // Sampling noise at N=200 keeps this a loose band, not a tight
    // reproduction of ρ — the point is "clearly correlated, clearly
    // not 1.0", which a broken/independent-shock implementation would
    // fail in one direction or the other.
    expect(corr).toBeGreaterThan(0.5);
    expect(corr).toBeLessThan(0.98);
    expect(MARKET_RHO).toBe(0.85);
  });

  it("elapsedMs is reported and positive", () => {
    const state = mkState({ assets: [mkAsset({ allocation: { mode: "profile", profile: "Balanced" } })] });
    const result = runMonteCarlo(state, PROFILES, { numPaths: 5, rng: createRng(1) });
    expect(result.elapsedMs).toBeGreaterThan(0);
  });

  it("onProgress is called periodically, ending exactly at numPaths — the worker's progress bar depends on this", () => {
    const state = mkState({ assets: [mkAsset({ allocation: { mode: "profile", profile: "Balanced" } })] });
    const calls = [];
    runMonteCarlo(state, PROFILES, { numPaths: 250, rng: createRng(1), onProgress: (done, total) => calls.push([done, total]) });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([, total]) => total === 250)).toBe(true);
    expect(calls.every(([done], i) => i === 0 || done > calls[i - 1][0])).toBe(true); // strictly increasing
    expect(calls[calls.length - 1][0]).toBe(250); // always fires on the final path, regardless of throttling
  });

  // Single ruin definition (item 5 of the CPI/seed follow-up): ANY
  // unfunded cashflow before projection end, out.shortfall !== null —
  // ruinProbability is the ONLY statistic this module derives from it;
  // there is no separate "success" counter to disagree with it.
  it("ruinProbability is exactly 0 for an ample plan and exactly 1 for a hopeless one — both directly from out.shortfall", () => {
    const ample = mkState({
      assets: [mkAsset({ id: "a1", balance: 2000000, allocation: { mode: "profile", profile: "Cash" } })],
      cashflows: { expenses: [{ id: "e1", assetId: null, amount: 500, frequency: "monthly",
        from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexed: true, owner: "client", label: "x" }] },
    });
    const ampleResult = runMonteCarlo(ample, PROFILES, { numPaths: 20, seed: 1, cpiSigma: 0 });
    expect(ampleResult.ruinProbability).toBe(0);
    expect(ampleResult.medianShortfallAge).toBeNull();

    const hopeless = mkState({
      assets: [mkAsset({ id: "a1", balance: 1000, allocation: { mode: "profile", profile: "Cash" } })],
      cashflows: { expenses: [{ id: "e1", assetId: null, amount: 5000, frequency: "monthly",
        from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexed: true, owner: "client", label: "x" }] },
    });
    const hopelessResult = runMonteCarlo(hopeless, PROFILES, { numPaths: 20, seed: 1, cpiSigma: 0 });
    expect(hopelessResult.ruinProbability).toBe(1);
    expect(hopelessResult.medianShortfallAge).not.toBeNull();
    expect(hopelessResult.medianShortfallAge).toBeGreaterThanOrEqual(40);
  });

  it("customHoldings lists only the included, custom-allocation holdings, with their volatility-basis profile", () => {
    const state = mkState({
      assets: [
        mkAsset({ id: "a1", name: "Direct shares", allocation: { mode: "profile", profile: "Balanced" } }),
        mkAsset({ id: "a2", name: "Managed fund", allocation: { mode: "custom", incomePct: 3, growthPct: 4, frankingPct: 0, volBasis: "High Growth – Income" } }),
      ],
      plan: { superAccounts: [superAcct({ id: "su1", name: "My Super", allocation: { mode: "profile", profile: "Cash" } })] },
    });
    const result = runMonteCarlo(state, PROFILES, { numPaths: 3, seed: 1 });
    expect(result.customHoldings).toEqual([{ id: "a2", name: "Managed fund", volBasis: "High Growth – Income" }]);
  });
});

// The conservation invariant caught two money-creation bugs in the
// deterministic engine before any test could see them directly — a
// stochastic engine that quietly violated it would only ever present
// as a probability distribution, never a single failing assertion.
// This spot-checks a genuinely multi-holding, multi-cashflow plan
// (assets + super + a liability + income + expenses) across every
// sampled path's every non-final year.
describe("Monte Carlo paths satisfy the conservation invariant", () => {
  it("holds for ~20 randomly sampled simulated paths, every year", () => {
    const state = {
      ...mkState({
        endAge: 48,
        assets: [
          mkAsset({ id: "a1", balance: 120000, cgtAsset: true, costBase: 90000, allocation: { mode: "profile", profile: "Moderate Growth" } }),
          mkAsset({ id: "a2", balance: 60000, distributions: "cash", allocation: { mode: "profile", profile: "High Growth – Income" } }),
        ],
        plan: {
          superAccounts: [superAcct({ id: "su1", balance: 80000, allocation: { mode: "profile", profile: "Balanced" } })],
          workingCash: { balance: 10000, minimumBalance: 5000, ratePct: 3 },
        },
        cashflows: {
          income: [employmentRow({ amount: 110000 })],
          expenses: [{ id: "exp1", assetId: null, amount: 4000, frequency: "monthly",
            from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexed: true, owner: "client", label: "living" }],
        },
        surplus: { mode: "invest", assetId: "a1" },
        fundingOrder: ["a1", "a2"],
      }),
      liabilities: [{
        id: "lb1", name: "Loan", type: "mortgage", owner: "client",
        balance: 150000, interestRatePct: 6, termYears: 20, repayment: "pi",
        ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
      }],
    };
    const result = runMonteCarlo(state, PROFILES, { numPaths: 80, sampleCount: 20, rng: createRng(11) });
    expect(result.samplePaths.length).toBe(20);
    for (let i = 0; i < result.samplePaths.length; i++) {
      const out = result.samplePaths[i];
      for (let y = 0; y < out.yearly.length - 1; y++) { // final year excluded — see conservationCheck.js
        checkYearConservation(out, y, `sampled path ${i}, year ${y}`);
      }
    }
  });
});
