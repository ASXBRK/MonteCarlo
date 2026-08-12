import { describe, it, expect } from "vitest";
import {
  SCHEMA_VERSION, defaultState, createPortfolio, createCashflow,
  createLumpSum, clampPlan, clampAllToPlan, serialize, hydrate,
  summarise, planSummaryText, annualisedAmount,
} from "./planState.js";

const PROFILE_KEYS = [
  "Cash", "Defensive", "Moderately Defensive", "Balanced",
  "Moderate Growth", "High Growth – Income", "High Growth – Capital",
  "Accelerated Growth – Income", "Accelerated Growth – Growth",
  "Residential Property",
];

describe("defaults", () => {
  it("produces a valid default state with one portfolio", () => {
    const s = defaultState(PROFILE_KEYS, new Date("2026-08-12"));
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.plan).toEqual({ currentAge: 40, endAge: 90, startYear: 2026 });
    expect(s.portfolios).toHaveLength(1);
    const p = s.portfolios[0];
    expect(p.name).toBe("Portfolio 1");
    expect(p.include).toBe(true);
    expect(p.balance).toBe(100000);
    expect(PROFILE_KEYS).toContain(p.profile);
    expect(p.contributions).toHaveLength(1);
    expect(p.withdrawals).toHaveLength(0);
    expect(p.lumpSums).toHaveLength(0);
  });

  it("default contribution spans currentAge to endAge, monthly, indexed", () => {
    const s = defaultState(PROFILE_KEYS);
    const c = s.portfolios[0].contributions[0];
    expect(c.fromAge).toBe(40);
    expect(c.toAge).toBe(90);
    expect(c.frequency).toBe("monthly");
    expect(c.indexed).toBe(true);
  });

  it("withdrawal default starts at 65 clamped into the plan window", () => {
    const w1 = createCashflow("withdrawal", { currentAge: 40, endAge: 90 });
    expect(w1.fromAge).toBe(65);
    expect(w1.toAge).toBe(90);
    const w2 = createCashflow("withdrawal", { currentAge: 70, endAge: 90 });
    expect(w2.fromAge).toBe(70); // 65 clamped up to currentAge
    const w3 = createCashflow("withdrawal", { currentAge: 30, endAge: 60 });
    expect(w3.fromAge).toBe(60); // 65 clamped down to endAge
  });

  it("portfolio names increment and ids are unique", () => {
    const plan = { currentAge: 40, endAge: 90, startYear: 2026 };
    const a = createPortfolio(plan, [], PROFILE_KEYS);
    const b = createPortfolio(plan, [a], PROFILE_KEYS);
    const c = createPortfolio(plan, [a, b], PROFILE_KEYS);
    expect(a.name).toBe("Portfolio 1");
    expect(b.name).toBe("Portfolio 2");
    expect(c.name).toBe("Portfolio 3");
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });
});

describe("clamping", () => {
  it("clampPlan enforces endAge > currentAge", () => {
    expect(clampPlan({ currentAge: 60, endAge: 50, startYear: 2026 }))
      .toEqual({ currentAge: 60, endAge: 61, startYear: 2026 });
  });

  it("plan-age changes clamp existing cashflows and lump sums", () => {
    const s = defaultState(PROFILE_KEYS);
    const p = s.portfolios[0];
    p.withdrawals.push({ ...createCashflow("withdrawal", s.plan) }); // 65..90
    p.lumpSums.push({ ...createLumpSum(s.plan), age: 88 });

    // Shrink the window: 50..60.
    s.plan = { currentAge: 50, endAge: 60, startYear: 2026 };
    const out = clampAllToPlan(s);
    const q = out.portfolios[0];
    expect(q.contributions[0].fromAge).toBe(50);
    expect(q.contributions[0].toAge).toBe(60);
    expect(q.withdrawals[0].fromAge).toBe(60); // 65 clamped down
    expect(q.withdrawals[0].toAge).toBe(60);
    expect(q.lumpSums[0].age).toBe(60);        // 88 clamped down
  });

  it("toAge never falls below fromAge after clamping", () => {
    const plan = { currentAge: 55, endAge: 58, startYear: 2026 };
    const out = clampAllToPlan({
      plan,
      portfolios: [{
        contributions: [{ id: "x", amount: 1, frequency: "monthly", fromAge: 57, toAge: 40, indexed: true }],
        withdrawals: [], lumpSums: [],
      }],
    });
    const c = out.portfolios[0].contributions[0];
    expect(c.fromAge).toBe(57);
    expect(c.toAge).toBeGreaterThanOrEqual(c.fromAge);
  });
});

describe("persistence round-trip", () => {
  it("serialize → hydrate preserves the state", () => {
    const s = defaultState(PROFILE_KEYS, new Date("2026-08-12"));
    s.portfolios[0].name = "Super";
    s.portfolios[0].balance = 250000;
    s.portfolios[0].fees.adviserPct = 0.5;
    s.portfolios[0].withdrawals.push(createCashflow("withdrawal", s.plan));
    s.portfolios[0].lumpSums.push({ ...createLumpSum(s.plan), amount: 30000, direction: "out", age: 55 });

    const back = hydrate(serialize(s), PROFILE_KEYS);
    expect(back).not.toBeNull();
    expect(back.plan).toEqual(s.plan);
    expect(back.portfolios[0].name).toBe("Super");
    expect(back.portfolios[0].balance).toBe(250000);
    expect(back.portfolios[0].fees.adviserPct).toBe(0.5);
    expect(back.portfolios[0].withdrawals).toHaveLength(1);
    expect(back.portfolios[0].lumpSums[0]).toMatchObject({ amount: 30000, direction: "out", age: 55 });
  });

  it("rejects garbage, wrong version, and empty portfolios", () => {
    expect(hydrate("not json", PROFILE_KEYS)).toBeNull();
    expect(hydrate("{}", PROFILE_KEYS)).toBeNull();
    expect(hydrate(JSON.stringify({ schemaVersion: 99, plan: {}, portfolios: [{}] }), PROFILE_KEYS)).toBeNull();
    expect(hydrate(JSON.stringify({ schemaVersion: 1, plan: { currentAge: 40, endAge: 90, startYear: 2026 }, portfolios: [] }), PROFILE_KEYS)).toBeNull();
  });

  it("repairs unknown profiles and out-of-range ages on hydrate", () => {
    const blob = JSON.stringify({
      schemaVersion: 1,
      plan: { currentAge: 40, endAge: 90, startYear: 2026 },
      portfolios: [{
        id: "pf-1", name: "Old", include: true, balance: 5000,
        profile: "Emerging Markets", // no longer exists
        fees: {},
        contributions: [{ id: "c1", amount: 100, frequency: "monthly", fromAge: 10, toAge: 200, indexed: true }],
        withdrawals: [], lumpSums: [],
      }],
    });
    const s = hydrate(blob, PROFILE_KEYS);
    expect(PROFILE_KEYS).toContain(s.portfolios[0].profile);
    expect(s.portfolios[0].contributions[0].fromAge).toBe(40);
    expect(s.portfolios[0].contributions[0].toAge).toBe(90);
  });
});

describe("summaries", () => {
  it("summarise counts included portfolios only and annualises", () => {
    const s = defaultState(PROFILE_KEYS);
    s.portfolios[0].balance = 100000;
    s.portfolios[0].contributions[0].amount = 1000; // monthly → 12k/yr
    const p2 = createPortfolio(s.plan, s.portfolios, PROFILE_KEYS);
    p2.balance = 50000;
    p2.contributions[0].amount = 6000;
    p2.contributions[0].frequency = "annual"; // → 6k/yr
    s.portfolios.push(p2);

    let sum = summarise(s);
    expect(sum.totalBalance).toBe(150000);
    expect(sum.includedCount).toBe(2);
    expect(sum.annualContributions).toBe(18000);

    p2.include = false;
    sum = summarise(s);
    expect(sum.totalBalance).toBe(100000);
    expect(sum.includedCount).toBe(1);
    expect(sum.annualContributions).toBe(12000);
  });

  it("annualisedAmount handles both frequencies", () => {
    expect(annualisedAmount({ amount: 500, frequency: "monthly" })).toBe(6000);
    expect(annualisedAmount({ amount: 500, frequency: "annual" })).toBe(500);
  });

  it("plan summary text", () => {
    expect(planSummaryText({ currentAge: 40, endAge: 90, startYear: 2026 }))
      .toBe("50-year projection, 2026–2076");
  });
});
