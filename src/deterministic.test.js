import { describe, it, expect } from "vitest";
import { projectPlan, assetMonthlyRate } from "./deterministic.js";

// Minimal v3-shaped state factory. Custom allocations pin exact
// returns without depending on profile values.
function mkAsset(over = {}) {
  return {
    id: "a1", name: "A1", include: true, owner: "client",
    distributions: "reinvest", balance: 100000,
    allocation: { mode: "custom", incomePct: 3, growthPct: 3, frankingPct: 0, volBasis: "Balanced" },
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
      surplus: over.surplus ?? { mode: "spend", assetId: null },
      fundingOrder: over.fundingOrder ?? assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: over.cpi ?? 0.025 },
    display: { units: "real" },
  };
}

const cf = (over = {}) => ({
  id: "row", assetId: "a1", amount: 0, frequency: "monthly",
  fromAge: 40, toAge: 120, indexed: true, owner: "client", label: "x",
  ...over,
});

// An allocation whose net nominal equals the CPI → real return exactly 0.
const zeroRealAlloc = (cpi = 0.025) =>
  ({ mode: "custom", incomePct: cpi * 100, growthPct: 0, frankingPct: 0, volBasis: "Balanced" });

describe("assetMonthlyRate (convention 7)", () => {
  it("Fisher + geometric monthly compounding", () => {
    const asset = mkAsset({ allocation: { mode: "custom", incomePct: 4, growthPct: 2, frankingPct: 0, volBasis: "Balanced" }, icrPct: 0.5 });
    const netNominal = 0.06 - 0.005;
    const realAnnual = 1.055 / 1.025 - 1;
    expect(assetMonthlyRate(asset, 0.025)).toBeCloseTo(Math.pow(1 + realAnnual, 1 / 12) - 1, 12);
  });

  it("zero-real allocation yields a zero monthly rate", () => {
    const asset = mkAsset({ allocation: zeroRealAlloc() });
    expect(assetMonthlyRate(asset, 0.025)).toBeCloseTo(0, 12);
  });
});

describe("core ledger loop", () => {
  it("zero-return sanity: closing = opening + net flows", () => {
    const s = mkState({
      endAge: 49,
      assets: [mkAsset({ allocation: zeroRealAlloc(), balance: 100000 })],
      cashflows: {
        contributions: [cf({ amount: 500 })],           // +500/mo × 120
        withdrawals: [cf({ id: "w", amount: 200 })],    // −200/mo × 120
      },
    });
    const out = projectPlan(s);
    const months = out.schedule.months;
    expect(months).toBe(120);
    expect(out.monthly.combined[months]).toBeCloseTo(100000 + (500 - 200) * 120, 6);
    expect(out.shortfall).toBeNull();
  });

  it("constant-return closed form for a no-cashflow asset", () => {
    const s = mkState({ endAge: 59 });
    const out = projectPlan(s);
    const rm = assetMonthlyRate(s.assets[0], 0.025);
    const n = out.schedule.months;
    expect(out.monthly.combined[n]).toBeCloseTo(100000 * Math.pow(1 + rm, n), 4);
  });

  it("annuity check: $100k + $500/mo indexed over 20y matches closed form", () => {
    const s = mkState({
      endAge: 59, // ages 40..59 → 20 plan years → 240 months (July start)
      cashflows: { contributions: [cf({ amount: 500, fromAge: 40, toAge: 59 })] },
    });
    const out = projectPlan(s);
    const i = assetMonthlyRate(s.assets[0], 0.025);
    const n = 240;
    expect(out.schedule.months).toBe(n);
    // Loop order is grow-then-contribute → ordinary annuity.
    const closed = 100000 * Math.pow(1 + i, n) + 500 * ((Math.pow(1 + i, n) - 1) / i);
    expect(out.monthly.combined[n]).toBeCloseTo(closed, 2);
  });
});

describe("deficit funding (conventions 9d–e, 10)", () => {
  it("drains fundingOrder in order, switching assets mid-year", () => {
    const cash = mkAsset({ id: "cash", balance: 24000, allocation: zeroRealAlloc() });
    const shares = mkAsset({ id: "shares", balance: 100000, allocation: zeroRealAlloc() });
    const s = mkState({
      endAge: 44,
      assets: [cash, shares],
      fundingOrder: ["cash", "shares"],
      cashflows: { expenses: [cf({ assetId: null, amount: 4000 })] }, // −4k/mo deficit
    });
    const out = projectPlan(s);
    const cashSeries = out.monthly.perAsset.cash;
    const shareSeries = out.monthly.perAsset.shares;
    // Cash covers exactly 6 months, then shares take over mid-year 0.
    expect(cashSeries[6]).toBeCloseTo(0, 6);
    expect(shareSeries[6]).toBeCloseTo(100000, 6);
    expect(shareSeries[7]).toBeCloseTo(96000, 6);
    // Shares never fund before cash is exhausted.
    expect(shareSeries[5]).toBeCloseTo(100000, 6);
    // Year 0 ledger row shows the funding.
    expect(out.yearly[0].deficitFundedFromAssets).toBeCloseTo(48000, 6);
  });

  it("records unfunded deficit after exhaustion with first-shortfall metadata", () => {
    const s = mkState({
      endAge: 44,
      assets: [mkAsset({ balance: 10000, allocation: zeroRealAlloc() })],
      cashflows: { expenses: [cf({ amount: 1000 })] },
    });
    const out = projectPlan(s);
    // 10 months funded, then unfunded from month 10 (still plan year 0).
    expect(out.shortfall).not.toBeNull();
    expect(out.shortfall.firstMonth).toBe(10);
    expect(out.shortfall.clientAge).toBe(40);
    expect(out.shortfall.fyLabel).toBe("FY2026–27");
    expect(out.shortfall.total).toBeCloseTo(1000 * (60 - 10), 6);
  });

  it("explicit withdrawals never cascade — remainder is unfunded", () => {
    const a = mkAsset({ id: "small", balance: 1000, allocation: zeroRealAlloc() });
    const b = mkAsset({ id: "big", balance: 100000, allocation: zeroRealAlloc() });
    const s = mkState({
      endAge: 40, // single plan year
      assets: [a, b],
      fundingOrder: ["small", "big"],
      cashflows: { withdrawals: [cf({ assetId: "small", amount: 5000, toAge: 40 })] },
    });
    const out = projectPlan(s);
    // Month 0: small pays 1000 of 5000; 4000 unfunded; big untouched.
    expect(out.monthly.perAsset.small[1]).toBeCloseTo(0, 6);
    expect(out.monthly.perAsset.big[1]).toBeCloseTo(100000, 6);
    expect(out.shortfall.firstMonth).toBe(0);
    expect(out.yearly[0].unfundedCashflow).toBeCloseTo(4000 + 5000 * 11, 6);
  });

  it("surplus invest routes to the nominated asset; spend disappears", () => {
    const base = {
      endAge: 40,
      assets: [mkAsset({ allocation: zeroRealAlloc() })],
      cashflows: { income: [cf({ assetId: null, amount: 1000, toAge: 40 })] },
    };
    const invest = projectPlan(mkState({ ...base, surplus: { mode: "invest", assetId: "a1" } }));
    expect(invest.monthly.combined[12]).toBeCloseTo(100000 + 12000, 6);
    expect(invest.yearly[0].surplusInvested).toBeCloseTo(12000, 6);
    const spend = projectPlan(mkState({ ...base, surplus: { mode: "spend", assetId: null } }));
    expect(spend.monthly.combined[12]).toBeCloseTo(100000, 6);
  });
});

describe("aggregation + partial first year", () => {
  it("combined = Σ per-asset every year in a 3-asset plan", () => {
    const s = mkState({
      endAge: 50,
      assets: [
        mkAsset({ id: "x", balance: 50000 }),
        mkAsset({ id: "y", balance: 30000, allocation: { mode: "custom", incomePct: 5, growthPct: 3, frankingPct: 0, volBasis: "Balanced" } }),
        mkAsset({ id: "z", balance: 20000, allocation: zeroRealAlloc() }),
      ],
      cashflows: { contributions: [cf({ assetId: "y", amount: 250 })] },
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      const sum = Object.values(row.perAssetClosing).reduce((a, b) => a + b, 0);
      expect(row.closingBalance).toBeCloseTo(sum, 6);
    }
  });

  it("partial first year totals: 11 months of monthly flows, annuals skipped", () => {
    const s = mkState({
      start: { year: 2026, month: 8 },
      endAge: 42,
      assets: [mkAsset({ allocation: zeroRealAlloc() })],
      cashflows: {
        contributions: [cf({ amount: 100 })],
        income: [cf({ id: "inc", assetId: null, amount: 12000, frequency: "annual" })],
      },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].contributions).toBeCloseTo(100 * 11, 6);
    expect(out.yearly[0].income).toBe(0);        // annual skipped in partial year
    expect(out.yearly[1].income).toBe(12000);    // fires July 2027
    expect(out.yearly).toHaveLength(3);
  });

  it("yearly rows carry FY labels, ages, and opening/closing continuity", () => {
    const s = mkState({ endAge: 42 });
    const out = projectPlan(s);
    expect(out.yearly[0].fyLabel).toBe("FY2026–27");
    expect(out.yearly[0].clientAge).toBe(40);
    expect(out.yearly[2].clientAge).toBe(42);
    for (let i = 1; i < out.yearly.length; i++) {
      expect(out.yearly[i].openingBalance).toBeCloseTo(out.yearly[i - 1].closingBalance, 9);
    }
  });
});
