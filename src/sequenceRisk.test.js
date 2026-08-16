import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { runShock } from "./whatIf.js";
import { buildCrashMc, crashHoldings, runCrashShock } from "./sequenceRisk.js";

// A custom allocation with a KNOWN, easily hand-verified growth
// fraction: growthPct = cpi (real-flat, so the base case never moves —
// isolating the crash's effect entirely) and volBasis picks a profile
// whose classWeights give an exact growth-sleeve fraction (Balanced =
// 50% growth sleeve, Cash = 0%).
const flatAlloc = (volBasis) =>
  ({ mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis });

function mkAsset(over = {}) {
  return {
    id: "a1", name: "Growth asset", include: true, owner: "client",
    distributions: "reinvest", balance: 100000,
    allocation: flatAlloc("Balanced"),
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
      endAge: over.endAge ?? 50,
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

describe("crashHoldings", () => {
  it("includes non-lifestyle assets and included super accounts, excludes lifestyle assets", () => {
    const state = mkState({
      assets: [mkAsset({ id: "a1" }), mkAsset({ id: "a2", class: "lifestyle" })],
      superAccounts: [{ id: "su1", include: true, allocation: flatAlloc("Balanced") }, { id: "su2", include: false, allocation: flatAlloc("Balanced") }],
    });
    const ids = crashHoldings(state).map((h) => h.id);
    expect(ids).toContain("a1");
    expect(ids).toContain("su1");
    expect(ids).not.toContain("a2");
    expect(ids).not.toContain("su2");
  });
});

describe("buildCrashMc", () => {
  it("shockFor returns -dropPct×growthFraction exactly at the crash month, 0 elsewhere with no recovery", () => {
    const state = mkState({ assets: [mkAsset({ allocation: flatAlloc("Balanced") })] }); // growth fraction 0.5
    const mc = buildCrashMc(state, { dropPct: 30, atAge: 42, recoveryYears: 0 });
    expect(mc).not.toBeNull();
    expect(mc.shockFor("a1", mc.crashMonth)).toBeCloseTo(-0.30 * 0.5, 10);
    expect(mc.shockFor("a1", mc.crashMonth - 1)).toBe(0);
    expect(mc.shockFor("a1", mc.crashMonth + 1)).toBe(0);
    expect(mc.recoveryMonths).toBe(0);
  });

  it("a fully-cash holding (0% growth sleeve) is never shocked, regardless of dropPct", () => {
    const state = mkState({ assets: [mkAsset({ allocation: flatAlloc("Cash") })] });
    const mc = buildCrashMc(state, { dropPct: 50, atAge: 42 });
    for (let m = 0; m < 200; m++) expect(mc.shockFor("a1", m)).toBe(0);
  });

  it("returns null when the crash age resolves to a partial-first-year with no July (convention 5's own skip)", () => {
    const state = mkState({ plan: { start: { year: 2026, month: 10 } } }); // partial year 0, no July
    const mc = buildCrashMc(state, { dropPct: 20, atAge: 40 }); // age 40 = plan year 0
    expect(mc).toBeNull();
  });
});

describe("crash — known-value engine integration (real-flat base, isolates the crash exactly)", () => {
  it("reduces the balance by exactly dropPct × growth fraction at the crash month, held flat with no recovery", () => {
    const state = mkState({ assets: [mkAsset({ allocation: flatAlloc("Balanced"), balance: 100000 })] });
    const base = projectPlan(state);
    const mc = buildCrashMc(state, { dropPct: 30, atAge: 42, recoveryYears: 0 });
    const shocked = projectPlan(state, undefined, mc);
    const crashYear = 2; // age 42 - currentAge 40
    // Base stays exactly $100,000 every year (real-flat allocation).
    expect(base.yearly[crashYear].perAssetClosing.a1).toBeCloseTo(100000, 2);
    // Shocked drops by exactly 30% × 50% = 15% at the crash year, and
    // — since there's no recovery and the base rate is 0 — stays there.
    expect(shocked.yearly[crashYear].perAssetClosing.a1).toBeCloseTo(100000 * 0.85, 1);
    expect(shocked.yearly[crashYear + 1].perAssetClosing.a1).toBeCloseTo(100000 * 0.85, 1);
  });

  it("cash holdings are completely unaffected by the crash", () => {
    const state = mkState({ assets: [mkAsset({ allocation: flatAlloc("Cash"), balance: 50000 })] });
    const base = projectPlan(state);
    const mc = buildCrashMc(state, { dropPct: 40, atAge: 42 });
    const shocked = projectPlan(state, undefined, mc);
    for (let y = 0; y < base.yearly.length; y++) {
      expect(shocked.yearly[y].perAssetClosing.a1).toBeCloseTo(base.yearly[y].perAssetClosing.a1, 6);
    }
  });

  it("recovery years restore the balance to trend exactly on schedule", () => {
    const state = mkState({ endAge: 50, assets: [mkAsset({ allocation: flatAlloc("Balanced"), balance: 100000 })] });
    const mc = buildCrashMc(state, { dropPct: 30, atAge: 42, recoveryYears: 2 });
    const shocked = projectPlan(state, undefined, mc);
    const crashYear = 2;
    // Exactly `recoveryYears` later (the recovery window spans
    // crashMonth+1..crashMonth+24, i.e. completes AT the first month of
    // year crashYear+2 — that year's own closing balance already
    // reflects the full restoration, plus 11 more flat months).
    expect(shocked.yearly[crashYear + 2].perAssetClosing.a1).toBeCloseTo(100000, 0);
    // One year further out (past the recovery window), it holds — no overshoot.
    expect(shocked.yearly[crashYear + 3].perAssetClosing.a1).toBeCloseTo(100000, 0);
  });

  it("the same crash produces materially different end outcomes at different ages", () => {
    // A genuinely GROWING allocation (not the real-flat fixture used
    // above) — sequence risk is about how much time is left to
    // compound a recovery via ordinary growth, which a real-flat
    // fixture can't demonstrate at all.
    const growingAsset = mkAsset({ allocation: { mode: "profile", profile: "Balanced" }, balance: 200000 });
    const state = mkState({ endAge: 65, assets: [growingAsset] });
    const early = runCrashShock(state, { dropPct: 40, atAge: 41, recoveryYears: 0 });
    const late = runCrashShock(state, { dropPct: 40, atAge: 63, recoveryYears: 0 });
    const earlyEnd = early.shocked.yearly[early.shocked.yearly.length - 1].netAssets;
    const lateEnd = late.shocked.yearly[late.shocked.yearly.length - 1].netAssets;
    // Identical magnitude crash, decades apart — a crash that early has
    // 20+ years for ordinary growth to compound past the dollar loss;
    // a crash two years before the end does not. Materially different.
    expect(Math.abs(earlyEnd - lateEnd)).toBeGreaterThan(1000);
  });
});

describe("runCrashShock", () => {
  it("returns null when the crash can't fire, without throwing", () => {
    const state = mkState({ plan: { start: { year: 2026, month: 10 } } });
    expect(runCrashShock(state, { dropPct: 20, atAge: 40 })).toBeNull();
  });

  it("never mutates the caller's state", () => {
    const state = mkState();
    const before = JSON.stringify(state);
    runCrashShock(state, { dropPct: 30, atAge: 42, recoveryYears: 2 });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("crash self-registers with whatIf.js's generic runner", () => {
  it("runShock({kind:'crash'}) produces the same shocked figures as runCrashShock", () => {
    const state = mkState({ assets: [mkAsset({ allocation: flatAlloc("Balanced"), balance: 100000 })] });
    const viaRegistry = runShock(state, { kind: "crash", dropPct: 30, atAge: 42, recoveryYears: 0 });
    const direct = runCrashShock(state, { dropPct: 30, atAge: 42, recoveryYears: 0 });
    expect(viaRegistry.shocked.yearly[2].perAssetClosing.a1).toBeCloseTo(direct.shocked.yearly[2].perAssetClosing.a1, 6);
    expect(viaRegistry.base.yearly[2].netAssets).toBeCloseTo(direct.base.yearly[2].netAssets, 6);
  });
});
