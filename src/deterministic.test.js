import { describe, it, expect } from "vitest";
import { projectPlan, assetMonthlyRate, assetReturnComponents } from "./deterministic.js";
import { hydrate } from "./planState.js";
import { PROFILES } from "./profiles.js";

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
    assumptions: { cpi: over.cpi ?? 0.025, bracketMode: over.bracketMode ?? "indexed" },
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

// --- Phase B.1: tax through the engine ---------------------------------------

// A zero-real asset with NO income component (all growth) — keeps
// distributions out of tax scenarios that don't want them.
const growthOnlyAlloc = (cpi = 0.025) =>
  ({ mode: "custom", incomePct: 0, growthPct: cpi * 100, frankingPct: 0, volBasis: "Balanced" });

const salary = (amount, over = {}) => ({
  id: "sal", label: "Salary", owner: "client", amount, frequency: "monthly",
  fromAge: 40, toAge: 120, indexed: true, assetId: null, ...over,
});

// --- Phase C1: per-line and per-asset reconciliation --------------------------

describe("output view reconciliation (C1)", () => {
  const comprehensive = () => mkState({
    endAge: 50,
    assets: [
      mkAsset({ id: "x", balance: 50000 }),
      mkAsset({ id: "y", balance: 30000, allocation: zeroRealAlloc(), distributions: "cash" }),
    ],
    fundingOrder: ["x", "y"],
    surplus: { mode: "invest", assetId: "x" },
    cashflows: {
      income: [
        { id: "i1", label: "Salary", owner: "client", amount: 4000, frequency: "monthly", fromAge: 40, toAge: 45, indexed: true },
        { id: "i2", label: "Bonus", owner: "client", amount: 5000, frequency: "annual", fromAge: 40, toAge: 42, indexed: true },
      ],
      expenses: [
        { id: "e1", label: "Living", amount: 3000, frequency: "monthly", fromAge: 40, toAge: 120, indexed: true },
        { id: "e2", label: "Travel", amount: 8000, frequency: "annual", fromAge: 46, toAge: 50, indexed: false },
      ],
      contributions: [cf({ assetId: "x", amount: 250, toAge: 50 })],
      withdrawals: [cf({ id: "w", assetId: "y", amount: 300, fromAge: 47, toAge: 50 })],
      lumpSums: [{ id: "l1", assetId: "x", amount: 20000, direction: "in", age: 43, source: "input" }],
    },
  });

  it("per-line income/expense FY totals reconcile with the ledger rows", () => {
    const out = projectPlan(comprehensive());
    const rt = out.schedule.rowTotals;
    for (let y = 0; y < out.yearly.length; y++) {
      const r = out.yearly[y];
      const incomeLines = Object.values(rt.income).reduce((s, arr) => s + arr[y], 0);
      expect(incomeLines + r.cashDistributions).toBeCloseTo(r.income, 6);
      const expenseLines = Object.values(rt.expenses).reduce((s, arr) => s + arr[y], 0);
      expect(expenseLines).toBeCloseTo(r.expenses, 6);
    }
  });

  it("per-asset detail blocks reconcile and sum to the combined closing", () => {
    const out = projectPlan(comprehensive());
    for (const r of out.yearly) {
      let totalClosing = 0;
      for (const d of Object.values(r.perAssetDetail)) {
        expect(d.opening + d.contributions - d.withdrawals + d.oneOffs
          - d.deficitFunding + d.surplusInvested + d.growth).toBeCloseTo(d.closing, 6);
        totalClosing += d.closing;
      }
      expect(totalClosing).toBeCloseTo(r.closingBalance, 6);
      // Detail totals also reconcile with the household row.
      const sum = (k) => Object.values(r.perAssetDetail).reduce((s, d) => s + d[k], 0);
      expect(sum("contributions")).toBeCloseTo(r.contributions, 6);
      expect(sum("withdrawals")).toBeCloseTo(r.withdrawals, 6);
      expect(sum("deficitFunding")).toBeCloseTo(r.deficitFundedFromAssets, 6);
      expect(sum("growth")).toBeCloseTo(r.growth, 6);
    }
  });

  it("one-off asset-year totals match the schedule's monthly one-offs", () => {
    const out = projectPlan(comprehensive());
    expect(out.schedule.oneOffsByAssetYear.x[3]).toBe(20000); // age 43 → year 3
    expect(out.yearly[3].perAssetDetail.x.oneOffs).toBeCloseTo(20000, 6);
  });

  it("taxDetail carries the full per-person assessment (C4 Tax view)", () => {
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({ allocation: growthOnlyAlloc() })],
      cashflows: { income: [salary(100000 / 12)] },
    });
    const d = projectPlan(s).yearly[1].taxDetail.client; // FY2027-28
    expect(d.taxableIncome).toBeCloseTo(100000, 4);
    expect(d.grossTax).toBeCloseTo(20252, 4);
    expect(d.medicare).toBeCloseTo(2000, 4);
    expect(d.lito).toBe(0);
    expect(d.incomeTax).toBeCloseTo(22252, 4); // net = gross + medicare − lito − credits
  });

  it("assumptions net real return matches the engine's rate (C4)", () => {
    const a = mkAsset({ icrPct: 0.5 });
    const { incomeNominal, growthNominal } = assetReturnComponents(a);
    const netRealAnnual = (1 + incomeNominal + growthNominal - 0.005) / 1.025 - 1;
    expect(Math.pow(1 + assetMonthlyRate(a, 0.025), 12) - 1).toBeCloseTo(netRealAnnual, 12);
  });

  it("a table-sourced one-off is engine-identical to an input-sourced one (C2)", () => {
    const mk = (source) => mkState({
      endAge: 50,
      cashflows: {
        lumpSums: [{ id: "l1", assetId: "a1", amount: 25000, direction: "out", age: 45, source }],
      },
    });
    const a = projectPlan(mk("input"));
    const b = projectPlan(mk("table"));
    expect(Array.from(b.monthly.combined)).toEqual(Array.from(a.monthly.combined));
    expect(b.yearly[5].oneOffsNet).toBe(a.yearly[5].oneOffsNet);
  });
});

// --- Phase D1: opening losses + migration gates -------------------------------

describe("D1 — opening capital losses and migration gates", () => {
  it("opening carry-forward losses offset a year-1 gain (known value)", () => {
    // Post-reform. $10k one-off sale slice: value 100k, pool 20k →
    // f = 0.1 → gain 10,000 − 2,000 = 8,000. Opening losses 5,000 →
    // taxable 3,000. Zero income → 30% floor: 900 (no Medicare below
    // the threshold), paid July of year 1.
    const s = mkState({
      endAge: 42,
      start: { year: 2027, month: 7 },
      plan: {
        client: {
          currentAge: 40,
          taxProfile: { residency: "resident", medicareExempt: false, centrelinkEligible: false, openingCapitalLosses: 5000 },
        },
      },
      assets: [mkAsset({ allocation: growthOnlyAlloc(), cgtAsset: true, costBase: 20000 })],
      cashflows: {
        lumpSums: [{ id: "l1", assetId: "a1", amount: 10000, direction: "in", age: 40, source: "input" }],
      },
    });
    // direction out for a sale:
    s.cashflows.lumpSums[0].direction = "out";
    const out = projectPlan(s);
    expect(out.yearly[1].taxDetail.cgt).toBeCloseTo(0.3 * 3000, 6);
  });

  it("hydrated v4 blobs project bit-identically to native v5 states (gate)", () => {
    const rows = {
      income: [{ id: "i1", label: "Salary", owner: "client", amount: 100000, frequency: "annual", fromAge: 40, toAge: 50, indexed: true }],
      expenses: [{ id: "e1", label: "Living", amount: 4000, frequency: "monthly", fromAge: 40, toAge: 55, indexed: false }],
    };
    const v4 = {
      schemaVersion: 4,
      plan: {
        household: "single",
        client: { currentAge: 40, taxProfile: { residency: "resident", medicareExempt: false, centrelinkEligible: false } },
        partner: null,
        endAge: 55,
        start: { year: 2026, month: 7 },
      },
      assets: [{ id: "a1", name: "A1", include: true, owner: "client", distributions: "reinvest",
                 balance: 100000, allocation: { mode: "custom", incomePct: 3, growthPct: 3, frankingPct: 0, volBasis: "Balanced" },
                 icrPct: 0, cgtAsset: false, costBase: null }],
      cashflows: { ...rows, contributions: [], withdrawals: [], lumpSums: [] },
      settings: { surplus: { mode: "spend", assetId: null }, fundingOrder: ["a1"] },
      display: { units: "real" },
      assumptions: { cpi: 0.025 },
    };
    const migrated = hydrate(JSON.stringify(v4), PROFILES);
    expect(migrated).not.toBeNull();
    const native = mkState({
      endAge: 55,
      cashflows: {
        income: [{ ...rows.income[0], indexed: undefined, indexBasis: "cpi", indexExtraPct: 0 }],
        expenses: [{ ...rows.expenses[0], indexed: undefined, indexBasis: "none", indexExtraPct: 0 }],
      },
    });
    const a = projectPlan(migrated);
    const b = projectPlan(native);
    expect(Array.from(a.monthly.combined)).toEqual(Array.from(b.monthly.combined));
    for (let y = 0; y < a.yearly.length; y++) {
      expect(a.yearly[y].tax).toBe(b.yearly[y].tax);
      expect(a.yearly[y].income).toBe(b.yearly[y].income);
      expect(a.yearly[y].expenses).toBe(b.yearly[y].expenses);
    }
  });
});

describe("tax — regression guards", () => {
  it("portfolio-only, cgtAsset:false, no income → zero tax everywhere", () => {
    const s = mkState({ endAge: 60 });
    const out = projectPlan(s);
    for (const r of out.yearly) {
      expect(r.tax).toBe(0);
      expect(r.taxDetail.cgt).toBe(0);
    }
    expect(out.accruedCgtAtEnd).toBe(0);
    // And Phase B balance behaviour is untouched.
    const rm = assetMonthlyRate(s.assets[0], 0.025);
    expect(out.monthly.combined[out.schedule.months])
      .toBeCloseTo(100000 * Math.pow(1 + rm, out.schedule.months), 4);
  });

  it("reinvest distributions leave balances identical for a tax-free person", () => {
    // zeroReal alloc has a 2.5% income component; reinvest mode keeps
    // the full-rate growth path, so the balance must stay put.
    const s = mkState({ endAge: 49, assets: [mkAsset({ allocation: zeroRealAlloc() })] });
    const out = projectPlan(s);
    expect(out.monthly.combined[out.schedule.months]).toBeCloseTo(100000, 6);
    for (const r of out.yearly) expect(r.tax).toBe(0);
  });
});

describe("tax — income tax and franking", () => {
  it("salary income tax accrues in-year (hand-checked FY2026-27 figure)", () => {
    // $100k salary FY2026-27: 26,800 × 0.15 + 55,000 × 0.30 = 20,520;
    // Medicare 2,000; LITO 0 → $22,520, spread across the year.
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({ allocation: growthOnlyAlloc() })],
      cashflows: { income: [salary(100000 / 12)] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].tax).toBeCloseTo(22520, 4);
    expect(out.yearly[0].taxDetail.client.incomeTax).toBeCloseTo(22520, 4);
    // FY2027-28 table: 26,800 × 0.14 + 55,000 × 0.30 = 20,252 + 2,000.
    expect(out.yearly[1].tax).toBeCloseTo(22252, 4);
    // Surplus (spend mode) absorbs the tax — no funding sales needed.
    expect(out.yearly[0].deficitFundedFromAssets).toBe(0);
  });

  it("fully-franked distributions to a low-income person refund the credit", () => {
    // Constant $100k balance (zero real, reinvest), 2.5% income fully
    // franked → $2,500/yr distributions, credits 2,500 × 30/70 =
    // 1,071.43 refunded → tax is negative.
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({
        allocation: { mode: "custom", incomePct: 2.5, growthPct: 0, frankingPct: 100, volBasis: "Balanced" },
      })],
    });
    const out = projectPlan(s);
    expect(out.yearly[0].taxDetail.frankingCredits).toBeCloseTo(2500 * (30 / 70), 2);
    expect(out.yearly[0].tax).toBeCloseTo(-2500 * (30 / 70), 2);
  });

  it("paid-as-cash distributions strip income from growth and feed the household", () => {
    // Nominal-flat asset (income 2.5%, growth 0) paying out: real
    // balance decays by CPI; the payout lands as household income.
    const cash = mkState({
      endAge: 41,
      assets: [mkAsset({ allocation: zeroRealAlloc(), distributions: "cash" })],
    });
    const out = projectPlan(cash);
    expect(out.yearly[0].closingBalance).toBeCloseTo(100000 / 1.025, 2);
    expect(out.yearly[0].income).toBeGreaterThan(2300);
    expect(out.yearly[0].income).toBeLessThan(2520);
    // Reinvest mode: same asset holds its real value instead.
    const reinvest = mkState({ endAge: 41, assets: [mkAsset({ allocation: zeroRealAlloc() })] });
    expect(projectPlan(reinvest).yearly[0].closingBalance).toBeCloseTo(100000, 6);
  });

  it("bracket modes match in the first two FYs and diverge by year 20", () => {
    const mk = (bracketMode) => mkState({
      endAge: 60,
      bracketMode,
      assets: [mkAsset({ allocation: growthOnlyAlloc() })],
      cashflows: { income: [salary(100000 / 12)] },
    });
    const indexed = projectPlan(mk("indexed"));
    const frozen = projectPlan(mk("frozen"));
    expect(frozen.yearly[0].tax).toBeCloseTo(indexed.yearly[0].tax, 6); // FY2026-27
    expect(frozen.yearly[1].tax).toBeCloseTo(indexed.yearly[1].tax, 6); // FY2027-28
    expect(frozen.yearly[20].tax).toBeGreaterThan(indexed.yearly[20].tax + 1000);
  });
});

describe("tax — CGT timing and pools through the engine", () => {
  it("deficit-funding sales in year t are taxed as a July year-t+1 outflow", () => {
    // Start July 2027 (post-reform throughout). $500k asset, pool
    // $250k, zero real growth, no distributions. $10k/mo expenses
    // force sales: each $10k sale realises a $5k gain (pool ratio ½)
    // → year-0 gains $60k. CGT = max(marginal(60k), 30%×60k) +
    // Medicare = 18,000 + 1,200 = 19,200, paid in July of year 1.
    const s = mkState({
      endAge: 42,
      start: { year: 2027, month: 7 },
      assets: [mkAsset({ allocation: growthOnlyAlloc(), balance: 500000, cgtAsset: true, costBase: 250000 })],
      cashflows: { expenses: [cf({ assetId: null, amount: 10000 })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].tax).toBe(0); // no income tax; CGT not yet due
    expect(out.yearly[1].taxDetail.cgt).toBeCloseTo(19200, 2);
    expect(out.yearly[1].tax).toBeCloseTo(19200, 2); // no other tax that year
  });

  it("the final year's CGT lands in accruedCgtAtEnd, not the cashflow", () => {
    // Reinvested distributions uplift the pool: $100k constant balance
    // (zero real), 2.5% income reinvested, pool seeded $50k. A one-off
    // sale of the lot in July of the final year has pool 50,000 + 13
    // months × 208.33 = 52,708.33 → gain 47,291.67. The year's only
    // distribution is July's $208.33 (the sale empties the asset), so
    // the 30% floor (14,187.50) beats the marginal figure and Medicare
    // runs on gain + that income: 2% × 47,500 = 950. Accrued
    // 15,137.50, unpayable inside the projection.
    const s = mkState({
      endAge: 41,
      start: { year: 2027, month: 7 },
      assets: [mkAsset({ allocation: zeroRealAlloc(), cgtAsset: true, costBase: 50000 })],
      cashflows: {
        lumpSums: [{ id: "l1", assetId: "a1", amount: 100000, direction: "out", age: 41, source: "input" }],
      },
    });
    const out = projectPlan(s);
    const dist = 100000 * 0.025 / 12;
    const gain = 100000 - (50000 + 13 * dist);
    const expected = 0.30 * gain + 0.02 * (gain + dist);
    expect(out.accruedCgtAtEnd).toBeCloseTo(expected, 2);
    expect(expected).toBeCloseTo(15137.5, 1);
    for (const r of out.yearly) expect(r.taxDetail.cgt).toBe(0); // nothing paid in-projection
  });

  it("pre-reform sales get the 50% discount; deemed reacquisition erases history", () => {
    // FY2026-27 sale: $1k/mo withdrawals from a zero-real asset with
    // pool ratio ½ realise $500/mo gains, discounted to $250 (all old
    // money) → $3k taxable on top of a $100k salary. 2026-27 table:
    // 3,000 × 0.30 + Medicare 60 = 960, paid July 2027 (year 1).
    const s = mkState({
      endAge: 42,
      assets: [mkAsset({ allocation: growthOnlyAlloc(), cgtAsset: true, costBase: 50000 })],
      cashflows: {
        income: [salary(100000 / 12)],
        withdrawals: [cf({ assetId: "a1", amount: 1000, fromAge: 40, toAge: 40 })],
      },
    });
    const out = projectPlan(s);
    expect(out.yearly[1].taxDetail.cgt).toBeCloseTo(960, 2);

    // Deemed reacquisition: pool 100k on a 100k asset crossing 1 July
    // 2027 untouched, then sold at unchanged real value → zero gain.
    const s2 = mkState({
      endAge: 42,
      assets: [mkAsset({ allocation: growthOnlyAlloc(), cgtAsset: true, costBase: 20000 })],
      cashflows: { withdrawals: [cf({ assetId: "a1", amount: 1000, fromAge: 41, toAge: 42 })] },
    });
    const out2 = projectPlan(s2);
    for (const r of out2.yearly) expect(r.taxDetail.cgt).toBe(0);
    expect(out2.accruedCgtAtEnd).toBe(0);
  });

  it("capital losses carry forward against later gains", () => {
    // Year 0 (post-reform): sell from an asset whose pool exceeds its
    // value → loss. Year 1: sell from a gain asset — the loss offsets
    // the gain before tax.
    const lossAsset = mkAsset({ id: "lossy", allocation: growthOnlyAlloc(), balance: 50000, cgtAsset: true, costBase: 100000 });
    const gainAsset = mkAsset({ id: "gainy", allocation: growthOnlyAlloc(), balance: 100000, cgtAsset: true, costBase: 0 });
    const s = mkState({
      endAge: 42,
      start: { year: 2027, month: 7 },
      assets: [lossAsset, gainAsset],
      fundingOrder: ["lossy", "gainy"],
      cashflows: {
        income: [salary(100000 / 12)],
        withdrawals: [
          cf({ id: "w1", assetId: "lossy", amount: 1000, fromAge: 40, toAge: 40 }),  // −$1k gain/mo → −12k
          cf({ id: "w2", assetId: "gainy", amount: 500, fromAge: 41, toAge: 41 }),   // +$500 gain/mo → +6k
        ],
      },
    });
    const out = projectPlan(s);
    // Year 0's 12k loss fully shelters year 1's 6k gain.
    expect(out.yearly[1].taxDetail.cgt).toBeCloseTo(0, 8); // year 0 assessed: loss, no tax
    expect(out.yearly[2].taxDetail.cgt).toBeCloseTo(0, 8); // year 1 assessed: gain sheltered
    expect(out.accruedCgtAtEnd).toBeCloseTo(0, 8);
  });
});

// --- Phase D2: financial vs lifestyle asset classes ----------------------------

describe("D2 — lifestyle assets", () => {
  const lifestyle = (over = {}) => ({
    id: "car", name: "Vehicles", class: "lifestyle", include: true,
    owner: "client", balance: 60000, growthPct: 0, ...over,
  });

  it("grows at the Fisher-converted simple rate (closed form)", () => {
    const s = mkState({
      endAge: 49,
      assets: [mkAsset({ allocation: zeroRealAlloc() }), lifestyle({ growthPct: 4 })],
    });
    const out = projectPlan(s);
    const rm = Math.pow(1.04 / 1.025, 1 / 12) - 1;
    const n = out.schedule.months;
    expect(out.monthly.perAsset.car[n]).toBeCloseTo(60000 * Math.pow(1 + rm, n), 4);
    // 0% growth → declines at CPI in real terms.
    const flat = projectPlan(mkState({
      endAge: 49, assets: [mkAsset({ allocation: zeroRealAlloc() }), lifestyle()],
    }));
    expect(flat.monthly.perAsset.car[n]).toBeCloseTo(60000 / Math.pow(1.025, 10), 2);
    // And it joins the combined closing balance.
    expect(flat.yearly.at(-1).closingBalance)
      .toBeCloseTo(100000 + flat.monthly.perAsset.car[n], 4);
  });

  it("never funds deficits, earns no distribution income, pays no tax", () => {
    const s = mkState({
      endAge: 44,
      assets: [mkAsset({ allocation: zeroRealAlloc(), balance: 24000 }), lifestyle({ growthPct: 2.5 })],
      fundingOrder: ["a1", "car"], // engine must ignore the lifestyle id
      cashflows: { expenses: [cf({ assetId: null, amount: 4000 })] },
    });
    const out = projectPlan(s);
    // Financial asset drains in 6 months; the car is untouched and the
    // rest is unfunded.
    expect(out.monthly.perAsset.a1[6]).toBeCloseTo(0, 6);
    expect(out.monthly.perAsset.car[12]).toBeCloseTo(60000, 4);
    expect(out.shortfall.firstMonth).toBe(6);
    for (const r of out.yearly) expect(r.tax).toBe(0);
  });

  it("carries no flow arrays and cannot be a surplus target", () => {
    const s = mkState({
      endAge: 44,
      assets: [mkAsset(), lifestyle()],
      surplus: { mode: "invest", assetId: "car" }, // invalid — engine falls back to spend
      cashflows: { income: [cf({ assetId: null, amount: 1000, toAge: 44 })] },
    });
    const out = projectPlan(s);
    expect(out.schedule.assetFlows.car).toBeUndefined();
    expect(out.yearly[0].surplusInvested).toBe(0);
    expect(out.monthly.perAsset.car[12]).toBeCloseTo(60000 / 1.025, 2);
  });

  it("regression gate: explicit class 'financial' is bit-identical to no class", () => {
    const base = mkState({
      endAge: 50,
      cashflows: { contributions: [cf({ amount: 500, toAge: 50 })] },
    });
    const stamped = JSON.parse(JSON.stringify(base));
    stamped.assets = stamped.assets.map((a) => ({ ...a, class: "financial" }));
    const a = projectPlan(base);
    const b = projectPlan(stamped);
    expect(Array.from(a.monthly.combined)).toEqual(Array.from(b.monthly.combined));
  });
});

// --- Phase D3: liabilities, offsets, amortisation ------------------------------

describe("D3 — liabilities", () => {
  const bigAsset = () => mkAsset({ allocation: zeroRealAlloc(), balance: 2000000 });
  const loan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 100000, interestRatePct: 6, termYears: 10, repayment: "pi",
    ioYears: 5, deductible: false, linkedAssetId: null, offsetAssetId: null,
    ...over,
  });
  const withLoan = (l, over = {}) => ({
    ...mkState({ endAge: 40 + (over.years ?? 11), assets: [bigAsset()], ...over }),
    liabilities: [l],
  });

  it("P&I amortisation pays off at exactly the term's final month", () => {
    const out = projectPlan(withLoan(loan(), { years: 11 }));
    // 10-year term from a July start: 120 payments, balance zero at
    // the end of plan year 9; year 10 has no loan activity.
    expect(out.yearly[8].liabilities.lb1.closing).toBeGreaterThan(0);
    expect(out.yearly[9].liabilities.lb1.closing).toBeCloseTo(0, 6);
    expect(out.yearly[10].liabilities.lb1.interest).toBeCloseTo(0, 8);
    expect(out.yearly[10].liabilities.lb1.principal).toBeCloseTo(0, 8);
    // Nominal principal repaid = the full loan: Σ principal × infl.
    // Spot-check year 0 payment total against the level payment.
    const pmt = 100000 * 0.005 / (1 - Math.pow(1.005, -120));
    let expectReal = 0;
    for (let m = 0; m < 12; m++) expectReal += pmt / Math.pow(1.025, m / 12);
    const y0 = out.yearly[0].liabilities.lb1;
    expect(y0.interest + y0.principal).toBeCloseTo(expectReal, 4);
    // Net assets = assets − liabilities, every year.
    for (const r of out.yearly) {
      expect(r.netAssets).toBeCloseTo(r.closingBalance - r.liabilitiesClosing, 8);
    }
  });

  it("IO holds the balance flat (nominal), then P&I retires the remainder", () => {
    const out = projectPlan(withLoan(loan({ repayment: "io", ioYears: 2, termYears: 12 }), { years: 13 }));
    // During IO the nominal balance is unchanged → real closing decays at CPI.
    expect(out.yearly[0].liabilities.lb1.principal).toBeCloseTo(0, 8);
    expect(out.yearly[1].liabilities.lb1.closing).toBeCloseTo(100000 / Math.pow(1.025, 2), 4);
    // Year-0 interest is 500/mo nominal, deflated.
    let expInterest = 0;
    for (let m = 0; m < 12; m++) expInterest += 500 / Math.pow(1.025, m / 12);
    expect(out.yearly[0].liabilities.lb1.interest).toBeCloseTo(expInterest, 4);
    // Then amortises to zero over the remaining 10 years.
    expect(out.yearly[11].liabilities.lb1.closing).toBeCloseTo(0, 6);
  });

  it("nominal-fixed repayments decay at CPI in real terms", () => {
    const out = projectPlan(withLoan(loan({ repayment: "io", ioYears: 20, termYears: 25 }), { years: 12 }));
    const pay = (y) => out.yearly[y].liabilities.lb1.interest + out.yearly[y].liabilities.lb1.principal;
    expect(pay(11) / pay(1)).toBeCloseTo(1 / Math.pow(1.025, 10), 6);
  });

  it("an offset reduces interest and the offset asset earns only on the excess", () => {
    // IO loan 100k @ 6% offset by a 150k financial asset with a real
    // 3% growth rate: interest accrues on (100k − offsetNominal); the
    // asset's return applies to the excess over the loan while the
    // offset portion decays at CPI (earning nothing nominally).
    const offsetAsset = mkAsset({ id: "off", balance: 150000,
      allocation: { mode: "custom", incomePct: 0, growthPct: 5.575, frankingPct: 0, volBasis: "Balanced" } });
    const s = {
      ...mkState({ endAge: 41, assets: [offsetAsset] }),
      liabilities: [loan({ repayment: "io", ioYears: 5, termYears: 25, offsetAssetId: "off" })],
    };
    const out = projectPlan(s);
    // Month 0: growth applies to 50k excess at ~0.2457%/mo; offset
    // portion (100k) decays at CPI. Interest = (100k − balNominal
    // capped at loan)×0.005 = 0 up to full offset → fully offset.
    expect(out.yearly[0].liabilities.lb1.interest).toBeCloseTo(0, 6);
    // The asset must NOT grow at the full rate on its whole balance.
    const fullRate = Math.pow(1.055750 / 1.025, 1 / 12) - 1;
    const naive = 150000 * Math.pow(1 + fullRate, 12);
    expect(out.monthly.perAsset.off[12]).toBeLessThan(naive - 1000);
    expect(out.monthly.perAsset.off[12]).toBeGreaterThan(150000 * 0.97);
  });

  it("deductible interest reduces the owner's taxable income (known value)", () => {
    const mk = (deductible, owner = "client") => projectPlan({
      ...mkState({
        endAge: 41,
        assets: [mkAsset({ allocation: growthOnlyAlloc() })],
        cashflows: { income: [salary(100000 / 12)] },
      }),
      liabilities: [loan({ balance: 200000, interestRatePct: 5, repayment: "io", ioYears: 10, termYears: 25, deductible, owner })],
    });
    const ded = mk(true);
    const not = mk(false);
    const interestReal = ded.yearly[0].liabilities.lb1.interest;
    expect(interestReal).toBeGreaterThan(9800); // ~10k nominal deflated
    expect(ded.yearly[0].taxDetail.client.taxableIncome)
      .toBeCloseTo(not.yearly[0].taxDetail.client.taxableIncome - interestReal, 4);
    expect(ded.yearly[0].tax).toBeLessThan(not.yearly[0].tax);
  });

  it("joint deductible interest splits 50/50 between owners", () => {
    const couplePlanOver = {
      plan: {
        household: "married",
        client: { currentAge: 40 },
        partner: { currentAge: 40 },
      },
    };
    const out = projectPlan({
      ...mkState({
        endAge: 41,
        ...couplePlanOver,
        assets: [mkAsset({ allocation: growthOnlyAlloc() })],
        cashflows: {
          income: [
            salary(100000 / 12),
            { ...salary(100000 / 12), id: "sal2", owner: "partner" },
          ],
        },
      }),
      liabilities: [loan({ balance: 200000, interestRatePct: 5, repayment: "io", ioYears: 10, termYears: 25, deductible: true, owner: "joint" })],
    });
    const interestReal = out.yearly[0].liabilities.lb1.interest;
    expect(out.yearly[0].taxDetail.client.taxableIncome)
      .toBeCloseTo(100000 - interestReal / 2, 4);
    expect(out.yearly[0].taxDetail.partner.taxableIncome)
      .toBeCloseTo(100000 - interestReal / 2, 4);
  });

  it("regression gate: liability-free scenarios are bit-identical", () => {
    const base = mkState({
      endAge: 50,
      cashflows: { contributions: [cf({ amount: 500, toAge: 50 })] },
    });
    const withEmpty = { ...JSON.parse(JSON.stringify(base)), liabilities: [] };
    const a = projectPlan(base);
    const b = projectPlan(withEmpty);
    expect(Array.from(a.monthly.combined)).toEqual(Array.from(b.monthly.combined));
    for (let y = 0; y < a.yearly.length; y++) {
      expect(a.yearly[y].tax).toBe(b.yearly[y].tax);
      expect(a.yearly[y].netAssets).toBe(a.yearly[y].closingBalance);
    }
  });
});
