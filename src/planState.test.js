import { describe, it, expect } from "vitest";
import {
  SCHEMA_VERSION, defaultState, createAsset, createCashflow,
  createLumpSum, clampPlan, clampAllToPlan, clampAllocation,
  nearestVolBasis, allocationTotalNominal, allocationSummary,
  serialize, hydrate, summarise, planSummaryText, annualisedAmount,
} from "./planState.js";
import { PROFILES } from "./profiles.js";

const PROFILE_KEYS = Object.keys(PROFILES);

describe("defaults", () => {
  it("produces a valid default state with one asset", () => {
    const s = defaultState(PROFILES, new Date("2026-08-12"));
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.plan).toEqual({ currentAge: 40, endAge: 90, startYear: 2026 });
    expect(s.assets).toHaveLength(1);
    const a = s.assets[0];
    expect(a.name).toBe("Asset 1");
    expect(a.include).toBe(true);
    expect(a.balance).toBe(100000);
    expect(a.allocation.mode).toBe("profile");
    expect(PROFILE_KEYS).toContain(a.allocation.profile);
    expect(a.icrPct).toBe(0);
    expect(a.cgtAsset).toBe(true);
    expect(a.costBase).toBe(100000); // defaults to entered balance
    expect(a.contributions).toHaveLength(1);
    expect(a.withdrawals).toHaveLength(0);
    expect(a.lumpSums).toHaveLength(0);
  });

  it("default contribution spans currentAge to endAge, monthly, indexed", () => {
    const s = defaultState(PROFILES);
    const c = s.assets[0].contributions[0];
    expect(c.fromAge).toBe(40);
    expect(c.toAge).toBe(90);
    expect(c.frequency).toBe("monthly");
    expect(c.indexed).toBe(true);
  });

  it("withdrawals default fromAge = currentAge (advice fees run from today)", () => {
    const w = createCashflow("withdrawal", { currentAge: 40, endAge: 90 });
    expect(w.fromAge).toBe(40);
    expect(w.toAge).toBe(90);
  });

  it("lump sums default to source: 'input'; table source is preserved", () => {
    const plan = { currentAge: 40, endAge: 90 };
    expect(createLumpSum(plan).source).toBe("input");
    expect(createLumpSum(plan, "table").source).toBe("table");
  });

  it("asset names increment and ids are unique", () => {
    const plan = { currentAge: 40, endAge: 90, startYear: 2026 };
    const a = createAsset(plan, [], PROFILES);
    const b = createAsset(plan, [a], PROFILES);
    const c = createAsset(plan, [a, b], PROFILES);
    expect(a.name).toBe("Asset 1");
    expect(b.name).toBe("Asset 2");
    expect(c.name).toBe("Asset 3");
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });
});

describe("allocation", () => {
  it("nearestVolBasis picks the profile with closest total nominal return", () => {
    // 7.5% total → nearest is a 8.0% or 6.85% profile: 8.00 is 0.5 away,
    // 6.85 is 0.65 away → High Growth wins.
    expect(nearestVolBasis(PROFILES, 7.5)).toBe("High Growth – Income");
    expect(nearestVolBasis(PROFILES, 3.4)).toBe("Cash");
    expect(nearestVolBasis(PROFILES, 20)).toMatch(/Accelerated|Residential/);
  });

  it("clampAllocation bounds custom percentages and repairs volBasis", () => {
    const out = clampAllocation({
      mode: "custom", incomePct: 99, growthPct: -5, frankingPct: 250,
      volBasis: "Not A Profile",
    }, PROFILES);
    expect(out.incomePct).toBe(30);   // clamped to ALLOC_PCT_MAX
    expect(out.growthPct).toBe(0);
    expect(out.frankingPct).toBe(100);
    expect(PROFILE_KEYS).toContain(out.volBasis);
  });

  it("clampAllocation falls back to profile mode for junk", () => {
    const out = clampAllocation({ mode: "nonsense" }, PROFILES);
    expect(out.mode).toBe("profile");
    expect(PROFILE_KEYS).toContain(out.profile);
  });

  it("allocationTotalNominal handles both modes", () => {
    expect(allocationTotalNominal({ mode: "profile", profile: "Balanced" }, PROFILES))
      .toBeCloseTo(0.0585);
    expect(allocationTotalNominal({ mode: "custom", incomePct: 4, growthPct: 3.5 }, PROFILES))
      .toBeCloseTo(0.075);
  });

  it("allocationSummary renders both modes", () => {
    expect(allocationSummary({ mode: "profile", profile: "Balanced" }, PROFILES)).toBe("Balanced");
    expect(allocationSummary({ mode: "custom", incomePct: 4, growthPct: 3.5 }, PROFILES))
      .toBe("Custom · 7.5% p.a.");
  });
});

describe("clamping", () => {
  it("clampPlan enforces endAge > currentAge", () => {
    expect(clampPlan({ currentAge: 60, endAge: 50, startYear: 2026 }))
      .toEqual({ currentAge: 60, endAge: 61, startYear: 2026 });
  });

  it("plan-age changes clamp existing cashflows and lump sums", () => {
    const s = defaultState(PROFILES);
    const a = s.assets[0];
    a.withdrawals.push({ ...createCashflow("withdrawal", s.plan), fromAge: 65 });
    a.lumpSums.push({ ...createLumpSum(s.plan), age: 88 });

    // Shrink the window: 50..60.
    s.plan = { currentAge: 50, endAge: 60, startYear: 2026 };
    const out = clampAllToPlan(s);
    const q = out.assets[0];
    expect(q.contributions[0].fromAge).toBe(50);
    expect(q.contributions[0].toAge).toBe(60);
    expect(q.withdrawals[0].fromAge).toBe(60); // 65 clamped down
    expect(q.lumpSums[0].age).toBe(60);        // 88 clamped down
  });

  it("toAge never falls below fromAge after clamping", () => {
    const plan = { currentAge: 55, endAge: 58, startYear: 2026 };
    const out = clampAllToPlan({
      plan,
      assets: [{
        contributions: [{ id: "x", amount: 1, frequency: "monthly", fromAge: 57, toAge: 40, indexed: true }],
        withdrawals: [], lumpSums: [],
      }],
    });
    const c = out.assets[0].contributions[0];
    expect(c.fromAge).toBe(57);
    expect(c.toAge).toBeGreaterThanOrEqual(c.fromAge);
  });
});

describe("persistence round-trip", () => {
  it("serialize → hydrate preserves the state including new fields", () => {
    const s = defaultState(PROFILES, new Date("2026-08-12"));
    const a = s.assets[0];
    a.name = "CommSec Portfolio";
    a.balance = 250000;
    a.icrPct = 0.4;
    a.cgtAsset = true;
    a.costBase = 180000;
    a.allocation = {
      mode: "custom", incomePct: 4.5, growthPct: 3.5, frankingPct: 80,
      volBasis: "High Growth – Capital",
    };
    a.withdrawals.push(createCashflow("withdrawal", s.plan));
    a.lumpSums.push({ ...createLumpSum(s.plan, "table"), amount: 30000, direction: "out", age: 55 });

    const back = hydrate(serialize(s), PROFILES);
    expect(back).not.toBeNull();
    expect(back.plan).toEqual(s.plan);
    const b = back.assets[0];
    expect(b.name).toBe("CommSec Portfolio");
    expect(b.balance).toBe(250000);
    expect(b.icrPct).toBe(0.4);
    expect(b.costBase).toBe(180000);
    expect(b.allocation).toEqual(a.allocation);
    expect(b.withdrawals).toHaveLength(1);
    expect(b.lumpSums[0]).toMatchObject({ amount: 30000, direction: "out", age: 55, source: "table" });
  });

  it("rejects garbage, wrong version, and empty assets", () => {
    expect(hydrate("not json", PROFILES)).toBeNull();
    expect(hydrate("{}", PROFILES)).toBeNull();
    expect(hydrate(JSON.stringify({ schemaVersion: 99, plan: {}, assets: [{}] }), PROFILES)).toBeNull();
    expect(hydrate(JSON.stringify({ schemaVersion: 1, plan: { currentAge: 40, endAge: 90, startYear: 2026 }, assets: [] }), PROFILES)).toBeNull();
    // Old portfolio-shaped blobs (pre-rename) are rejected, not migrated.
    expect(hydrate(JSON.stringify({ schemaVersion: 1, plan: { currentAge: 40, endAge: 90, startYear: 2026 }, portfolios: [{}] }), PROFILES)).toBeNull();
  });

  it("repairs unknown profiles, missing cost base, and bad ages on hydrate", () => {
    const blob = JSON.stringify({
      schemaVersion: 1,
      plan: { currentAge: 40, endAge: 90, startYear: 2026 },
      assets: [{
        id: "as-1", name: "Old", include: true, balance: 5000,
        allocation: { mode: "profile", profile: "Emerging Markets" }, // gone
        cgtAsset: true, // costBase missing → default to balance
        contributions: [{ id: "c1", amount: 100, frequency: "monthly", fromAge: 10, toAge: 200, indexed: true }],
        withdrawals: [], lumpSums: [],
      }],
    });
    const s = hydrate(blob, PROFILES);
    expect(PROFILE_KEYS).toContain(s.assets[0].allocation.profile);
    expect(s.assets[0].costBase).toBe(5000);
    expect(s.assets[0].contributions[0].fromAge).toBe(40);
    expect(s.assets[0].contributions[0].toAge).toBe(90);
  });

  it("non-CGT assets keep costBase null through hydrate", () => {
    const s = defaultState(PROFILES);
    s.assets[0].cgtAsset = false;
    s.assets[0].costBase = null;
    const back = hydrate(serialize(s), PROFILES);
    expect(back.assets[0].cgtAsset).toBe(false);
    expect(back.assets[0].costBase).toBeNull();
  });
});

describe("summaries", () => {
  it("summarise counts included assets only, annualises both directions", () => {
    const s = defaultState(PROFILES);
    s.assets[0].balance = 100000;
    s.assets[0].contributions[0].amount = 1000; // monthly → 12k/yr
    const w = createCashflow("withdrawal", s.plan);
    w.amount = 3300; // advice fee, annual
    w.frequency = "annual";
    s.assets[0].withdrawals.push(w);

    const a2 = createAsset(s.plan, s.assets, PROFILES);
    a2.balance = 50000;
    a2.contributions[0].amount = 6000;
    a2.contributions[0].frequency = "annual"; // → 6k/yr
    s.assets.push(a2);

    let sum = summarise(s);
    expect(sum.totalBalance).toBe(150000);
    expect(sum.includedCount).toBe(2);
    expect(sum.annualContributions).toBe(18000);
    expect(sum.annualWithdrawals).toBe(3300);

    a2.include = false;
    sum = summarise(s);
    expect(sum.totalBalance).toBe(100000);
    expect(sum.includedCount).toBe(1);
    expect(sum.annualContributions).toBe(12000);
  });

  it("annualisedAmount handles both frequencies", () => {
    expect(annualisedAmount({ amount: 500, frequency: "monthly" })).toBe(6000);
    expect(annualisedAmount({ amount: 500, frequency: "annual" })).toBe(500);
  });

  it("plan summary text includes years, calendar span, and age span", () => {
    expect(planSummaryText({ currentAge: 40, endAge: 90, startYear: 2026 }))
      .toBe("50-year projection, 2026–2076 (age 40–90)");
  });
});
