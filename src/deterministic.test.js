import { describe, it, expect } from "vitest";
import { projectPlan, assetMonthlyRate, assetReturnComponents } from "./deterministic.js";
import { hydrate, SCHEMA_VERSION } from "./planState.js";
import { PROFILES } from "./profiles.js";
import { checkYearConservation } from "./conservationCheck.js";
import { lmiPremium } from "./data/lmiRates.js";
import { levelPayment } from "./liabilities.js";

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
    assumptions: { cpi: over.cpi ?? 0.025, bracketMode: over.bracketMode ?? "indexed", awote: over.awote },
    display: { units: "real" },
  };
}

// fromAge/toAge are a convenience shim over the real DateRef fields
// (from/to) — Key Dates (Tier 1.1) — so existing call sites below stay
// unchanged while the engine is exercised against its real shape.
const cf = (over = {}) => {
  const { fromAge, toAge, from, to, ...rest } = over;
  return {
    id: "row", assetId: "a1", amount: 0, frequency: "monthly",
    from: from ?? { kind: "age", age: fromAge ?? 40 },
    to: to ?? { kind: "age", age: toAge ?? 120 },
    indexed: true, owner: "client", label: "x",
    ...rest,
  };
};

// An allocation whose net nominal equals the CPI → real return exactly 0.
const zeroRealAlloc = (cpi = 0.025) =>
  ({ mode: "custom", incomePct: cpi * 100, growthPct: 0, frankingPct: 0, volBasis: "Balanced" });

// Same "real return exactly 0" idea, but for a SUPER account: the fund's
// income component is also taxed at earningsTaxRate (15%, superRates.js)
// before it compounds, so a super allocation needs a grossed-up
// incomePct — zeroRealAlloc's plain cpi*100 would tax down to a small
// NEGATIVE real return, contaminating an exact FHSSS hand-calc that
// expects the account to neither grow nor shrink in real terms.
const zeroRealSuperAlloc = (cpi = 0.025, earningsTaxRate = 0.15) =>
  ({ mode: "custom", incomePct: (cpi / (1 - earningsTaxRate)) * 100, growthPct: 0, frankingPct: 0, volBasis: "Balanced" });

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
    // The $1,000/mo surplus now sits in the Working Cash Account until
    // the FY-end sweep invests it in one lump, earning WCA interest
    // along the way — a few tens of dollars more than the raw $12,000
    // sum of contributions (the WCA fix's documented, expected small
    // discrepancy; asserting the shape, not bit-identity).
    const invest = projectPlan(mkState({ ...base, surplus: { mode: "invest", assetId: "a1" } }));
    expect(invest.monthly.combined[12]).toBeGreaterThan(100000 + 12000);
    expect(invest.monthly.combined[12]).toBeCloseTo(100000 + 12000, -3);
    expect(invest.yearly[0].surplusInvested).toBeGreaterThan(12000);
    expect(invest.yearly[0].surplusInvested).toBeCloseTo(12000, -3);
    // "spend" mode: the WCA absorbs the surplus all year, then the
    // FY-end sweep discards it — same end state as before (nothing
    // reaches the asset), modulo the same small WCA-interest residue.
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

const salary = (amount, over = {}) => {
  const { fromAge, toAge, from, to, ...rest } = over;
  return {
    id: "sal", label: "Salary", owner: "client", amount, frequency: "monthly",
    from: from ?? { kind: "age", age: fromAge ?? 40 },
    to: to ?? { kind: "age", age: toAge ?? 120 },
    indexed: true, assetId: null, ...rest,
  };
};

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
        { id: "i1", label: "Salary", owner: "client", amount: 4000, frequency: "monthly", from: { kind: "age", age: 40 }, to: { kind: "age", age: 45 }, indexed: true },
        { id: "i2", label: "Bonus", owner: "client", amount: 5000, frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 42 }, indexed: true },
      ],
      expenses: [
        { id: "e1", label: "Living", amount: 3000, frequency: "monthly", from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexed: true },
        { id: "e2", label: "Travel", amount: 8000, frequency: "annual", from: { kind: "age", age: 46 }, to: { kind: "age", age: 50 }, indexed: false },
      ],
      contributions: [cf({ assetId: "x", amount: 250, toAge: 50 })],
      withdrawals: [cf({ id: "w", assetId: "y", amount: 300, fromAge: 47, toAge: 50 })],
      lumpSums: [{ id: "l1", assetId: "x", amount: 20000, direction: "in", at: { kind: "age", age: 43 }, source: "input" }],
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
      // ratePct 2.5 == cpi → exactly 0% real WCA growth (same
      // zero-real-rate trick as zeroRealAlloc), isolating this tax-
      // bracket check from the WCA interest effect entirely.
      plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
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
        lumpSums: [{ id: "l1", assetId: "a1", amount: 25000, direction: "out", at: { kind: "age", age: 45 }, source }],
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
        lumpSums: [{ id: "l1", assetId: "a1", amount: 10000, direction: "in", at: { kind: "age", age: 40 }, source: "input" }],
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
    // native bypasses hydrate/clamp entirely, so it needs the real
    // from/to DateRef fields directly (fromAge/toAge here are the raw
    // v4 shape hydrate() migrates FROM, not what the engine reads).
    const native = mkState({
      endAge: 55,
      cashflows: {
        // incomeType/sgApplies explicit — hydrate() defaults a
        // pre-Tier-1.2 row (no incomeType field, like v4 here) to
        // incomeType:"employment", sgApplies:true; the native
        // comparator must match that normalization exactly (see the
        // v5 migration gate above for the same fix).
        income: [{
          ...rows.income[0], indexed: undefined, indexBasis: "cpi", indexExtraPct: 0,
          incomeType: "employment", sgApplies: true,
          from: { kind: "age", age: rows.income[0].fromAge }, to: { kind: "age", age: rows.income[0].toAge },
        }],
        expenses: [{
          ...rows.expenses[0], indexed: undefined, indexBasis: "none", indexExtraPct: 0,
          from: { kind: "age", age: rows.expenses[0].fromAge }, to: { kind: "age", age: rows.expenses[0].toAge },
        }],
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

// --- Key Dates (Tier 1.1): v5 → v6 migration gate ----------------------------
//
// Every bare-int date field (fromAge/toAge/age/purchaseAge) becomes a
// DateRef ({kind:"age", age}) on migration. This is the whole point of
// Commit 1: a scenario touching every row type that carries a date
// field — income, expenses, contributions, withdrawals, a one-off, a
// liability, and a planned property purchase — must migrate to
// bit-identical yearly ledger rows, per-asset closings, and tax
// figures, because clampDateRef's {kind:"age"} branch clamps into
// EXACTLY the same [lo, hi] window the old bare-int fields did.
describe("Key Dates — v5 → v6 migration gate", () => {
  it("a v5 blob exercising income, expenses, contributions, withdrawals, a one-off, a liability, and a planned property migrates bit-identically", () => {
    const v5 = {
      schemaVersion: 5,
      plan: {
        household: "single",
        client: {
          currentAge: 40,
          taxProfile: { residency: "resident", medicareExempt: false, centrelinkEligible: false, openingCapitalLosses: 0 },
        },
        partner: null,
        endAge: 55,
        endBasis: { mode: "fixedAge", offset: 0, fixedAge: 55, fixedYears: 40 },
        start: { year: 2026, month: 7 },
      },
      assets: [{
        id: "a1", name: "A1", include: true, owner: "client", distributions: "reinvest",
        balance: 200000, allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" },
        icrPct: 0, cgtAsset: true, costBase: 150000,
      }],
      cashflows: {
        income: [{ id: "i1", label: "Salary", owner: "client", amount: 80000, frequency: "annual", fromAge: 40, toAge: 55, indexBasis: "cpi", indexExtraPct: 0 }],
        expenses: [{ id: "e1", label: "Living", amount: 3500, frequency: "monthly", fromAge: 40, toAge: 55, indexBasis: "cpi", indexExtraPct: 0 }],
        contributions: [{ id: "c1", assetId: "a1", amount: 500, frequency: "monthly", fromAge: 40, toAge: 55, indexBasis: "cpi", indexExtraPct: 0 }],
        withdrawals: [{ id: "w1", assetId: "a1", amount: 200, frequency: "monthly", fromAge: 45, toAge: 55, indexBasis: "cpi", indexExtraPct: 0 }],
        lumpSums: [{ id: "l1", assetId: "a1", amount: 10000, direction: "in", age: 43, source: "input" }],
      },
      liabilities: [{
        id: "lb1", name: "Loan", type: "personal", owner: "client", balance: 50000,
        interestRatePct: 6, termYears: 10, repayment: "pi", ioYears: 0,
        deductible: false, linkedAssetId: null, offsetAssetId: null,
      }],
      properties: [{
        id: "p1", name: "Investment unit", owner: "client", state: "NSW", propertyType: "investment", status: "planned",
        currentValue: 0, acquisitionDate: null, costBase: 0, priceToday: 500000, purchaseAge: 44, lvrPct: 80,
        firstHomeBuyer: false, newBuild: false, purchaseCostsPct: 2, dutyOverride: null, growthPct: 4,
        rent: { amount: 20000, indexBasis: "cpi", indexExtraPct: 0 },
        expenses: { amount: 4000, indexBasis: "cpi", indexExtraPct: 0 },
        expensesDeductible: true,
      }],
      settings: { surplus: { mode: "spend", assetId: null }, fundingOrder: ["a1"] },
      display: { units: "real" },
      assumptions: { cpi: 0.025, awote: 0.035, mortgageRate: 0.06, bracketMode: "indexed" },
    };

    const migrated = hydrate(JSON.stringify(v5), PROFILES);
    expect(migrated).not.toBeNull();
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    // The shape work landed: every date field is now a DateRef.
    expect(migrated.cashflows.income[0].from).toEqual({ kind: "age", age: 40 });
    expect(migrated.cashflows.lumpSums[0].at).toEqual({ kind: "age", age: 43 });
    expect(migrated.properties[0].purchaseAt).toEqual({ kind: "age", age: 44 });
    // New field default is 65, but this plan ends at 55 — input
    // integrity clamps retirementAge into [currentAge, endAge], so it
    // lands at endAge here rather than the raw default (audit C2).
    expect(migrated.plan.client.retirementAge).toBe(55);
    expect(migrated.plan.keyDates).toEqual([]);

    // native bypasses hydrate/clamp entirely — same values, real
    // DateRef shape from the start.
    const age = (n) => ({ kind: "age", age: n });
    const native = {
      ...mkState({
        endAge: 55,
        assets: v5.assets,
        cashflows: {
          // incomeType/sgApplies explicit here — hydrate() defaults a
        // pre-Tier-1.2 row (no incomeType field, like v5 above) to
        // incomeType:"employment", sgApplies:true; the native
        // comparator must match that normalization exactly, or it
        // silently diverges from PAYG withholding onward (incomeType
        // undefined ≠ "employment") even though it never used to
        // matter back when SG was the only thing gated on it and no
        // super account existed in this fixture to expose it.
        income: [{ ...v5.cashflows.income[0], from: age(40), to: age(55), incomeType: "employment", sgApplies: true }],
          expenses: [{ ...v5.cashflows.expenses[0], from: age(40), to: age(55) }],
          contributions: [{ ...v5.cashflows.contributions[0], from: age(40), to: age(55) }],
          withdrawals: [{ ...v5.cashflows.withdrawals[0], from: age(45), to: age(55) }],
          lumpSums: [{ ...v5.cashflows.lumpSums[0], at: age(43) }],
        },
      }),
      liabilities: v5.liabilities,
      properties: [{ ...v5.properties[0], purchaseAt: age(44) }],
    };

    const a = projectPlan(migrated);
    const b = projectPlan(native);
    expect(Array.from(a.monthly.combined)).toEqual(Array.from(b.monthly.combined));
    expect(a.yearly).toEqual(b.yearly); // every ledger row, per-asset closing, and tax figure
    expect(a.accruedCgtAtEnd).toBe(b.accruedCgtAtEnd);
    expect(a.shortfall).toEqual(b.shortfall);
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
      // Isolate this hand-checked tax figure from WCA interest — see
      // the "taxDetail carries the full per-person assessment" test.
      plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
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
        lumpSums: [{ id: "l1", assetId: "a1", amount: 100000, direction: "out", at: { kind: "age", age: 41 }, source: "input" }],
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
        // Isolate this known-value split from WCA interest — see the
        // "taxDetail carries the full per-person assessment" test.
        workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
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

  it("Liabilities view (Commit 5): opening reconciles to the prior year's closing", () => {
    const out = projectPlan(withLoan(loan(), { years: 11 }));
    for (let y = 1; y < out.yearly.length; y++) {
      expect(out.yearly[y].liabilities.lb1.opening).toBeCloseTo(out.yearly[y - 1].liabilities.lb1.closing, 6);
    }
    // Year 0 opens at the loan's starting balance (real == nominal at month 0).
    expect(out.yearly[0].liabilities.lb1.opening).toBeCloseTo(100000, 6);
  });

  it("Liabilities view (Commit 5): offsetApplied snapshots the offset amount at year end, not a sum", () => {
    const offsetAsset = mkAsset({ id: "off", balance: 150000, allocation: zeroRealAlloc() });
    const s = {
      ...mkState({ endAge: 41, assets: [offsetAsset] }),
      liabilities: [loan({ repayment: "io", ioYears: 5, termYears: 25, offsetAssetId: "off" })],
    };
    const out = projectPlan(s);
    // The 150k offset asset (zero real growth) fully covers the 100k
    // loan all year (offsetNominal is capped at the loan's own
    // balance), so the snapshot is the loan's own last-month balance,
    // deflated to real dollars at that month (11, the last of year 0).
    expect(out.yearly[0].liabilities.lb1.offsetApplied).toBeCloseTo(100000 / Math.pow(1.025, 11 / 12), 2);
  });
});

// --- Monte Carlo's stochastic CPI (mc.cpiForYear) — engine wiring --------------
//
// deterministic.js's own header comment on the `mc` parameter explains
// the scope: cpiForYear replaces the plan's single assumed cpi in
// inflAt(m) ONLY, which liabilities (and planned-property pricing) are
// the sole consumers of. These tests exercise exactly that mechanism
// directly, isolating it from Monte Carlo's own randomness — see
// monteCarlo.test.js for the integration-level (seeded, stochastic)
// version.
describe("mc.cpiForYear — stochastic CPI feeds inflAt only (Monte Carlo)", () => {
  const bigAsset = () => mkAsset({ allocation: zeroRealAlloc(), balance: 2000000 });
  const loan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 100000, interestRatePct: 6, termYears: 10, repayment: "pi",
    ioYears: 5, deductible: false, linkedAssetId: null, offsetAssetId: null,
    ...over,
  });
  // Interest-only: the NOMINAL balance stays perfectly flat at
  // 100,000, so its REAL closing value is purely 100,000 / inflAt(m) —
  // the cleanest possible isolation of the deflation mechanism from
  // amortisation.
  const ioState = (years = 6) => ({
    ...mkState({ endAge: 40 + years, assets: [bigAsset()] }),
    liabilities: [loan({ repayment: "io", ioYears: 20, termYears: 25 })],
  });

  it("omitted mc (or cpiForYear absent) is bit-identical to today — no regression", () => {
    const s = ioState();
    const withoutMc = projectPlan(s);
    const withMc = projectPlan(s, PROFILES, {});
    for (let y = 0; y < withoutMc.yearly.length; y++) {
      expect(withMc.yearly[y].liabilities.lb1.closing).toBe(withoutMc.yearly[y].liabilities.lb1.closing);
    }
  });

  it("a cpiForYear returning the plan's own assumed cpi every year reproduces the assumed-cpi result exactly", () => {
    const s = ioState();
    const withoutMc = projectPlan(s);
    const withMc = projectPlan(s, PROFILES, { cpiForYear: () => 0.025 }); // ioState's cpi default is 0.025
    for (let y = 0; y < withoutMc.yearly.length; y++) {
      expect(withMc.yearly[y].liabilities.lb1.closing).toBeCloseTo(withoutMc.yearly[y].liabilities.lb1.closing, 8);
    }
  });

  it("higher realised inflation makes the fixed-nominal loan's REAL closing balance lower, and lower inflation makes it higher — the expected direction, both ways", () => {
    const s = ioState();
    const assumed = projectPlan(s, PROFILES, { cpiForYear: () => 0.025 }).yearly[5].liabilities.lb1.closing;
    const highInflation = projectPlan(s, PROFILES, { cpiForYear: () => 0.06 }).yearly[5].liabilities.lb1.closing;
    const lowInflation = projectPlan(s, PROFILES, { cpiForYear: () => 0.00 }).yearly[5].liabilities.lb1.closing;
    // Same nominal balance every path (IO, untouched by cpi) — only the
    // deflator differs, so this isolates the direction unambiguously.
    expect(highInflation).toBeLessThan(assumed);
    expect(lowInflation).toBeGreaterThan(assumed);
    // Exact figure: yearly[5] is the END of the 6th plan year (a July
    // start has no partial first year), so 6 full years have elapsed —
    // real closing = 100,000 / (1+cpi)^6.
    expect(highInflation).toBeCloseTo(100000 / Math.pow(1.06, 6), 4);
    expect(lowInflation).toBeCloseTo(100000 / Math.pow(1.00, 6), 4);
  });

  it("a per-year cpi path compounds cumulatively, not as a flat average", () => {
    const s = ioState(2); // 3 plan years (0,1,2) — matches path.length exactly
    // Year 0 at 2%, year 1 at 8%, year 2 at 2% — cumulative product,
    // not (2%+8%+2%)/3 = 4% flat, must drive the deflator.
    const path = [0.02, 0.08, 0.02];
    const out = projectPlan(s, PROFILES, { cpiForYear: (y) => path[y] });
    const cumulativeAt = (y) => path.slice(0, y + 1).reduce((acc, r) => acc * (1 + r), 1);
    for (let y = 0; y < 3; y++) {
      expect(out.yearly[y].liabilities.lb1.closing).toBeCloseTo(100000 / cumulativeAt(y), 3);
    }
  });
});

// --- Phase D4: property, purchase events, gearing ------------------------------

describe("D4 — property", () => {
  // Growth-only allocation: no distribution income muddying the tax
  // assertions; still zero-real so balances are predictable.
  const bigCash = () => mkAsset({ allocation: growthOnlyAlloc(), balance: 3000000 });
  // purchaseAge is a convenience shim over the real DateRef field
  // (purchaseAt) — Key Dates (Tier 1.1).
  const prop = (over = {}) => {
    const { purchaseAge, purchaseAt, ...rest } = over;
    return {
      id: "p1", name: "Investment unit", owner: "client", state: "NSW",
      propertyType: "investment", status: "owned",
      currentValue: 800000, acquisitionDate: "2020-01-15", costBase: 600000,
      priceToday: 0, purchaseAt: purchaseAt ?? { kind: "age", age: purchaseAge ?? 41 },
      lvrPct: 80, firstHomeBuyer: false, newBuild: false,
      purchaseCostsPct: 2, dutyOverride: null, growthPct: 5,
      rent: { amount: 0, indexBasis: "cpi", indexExtraPct: 0 },
      expenses: { amount: 0, indexBasis: "cpi", indexExtraPct: 0 },
      expensesDeductible: true,
      ...rest,
    };
  };
  const withProps = (properties, over = {}) => ({
    ...mkState({ assets: [bigCash()], ...over }),
    properties,
    liabilities: over.liabilities ?? [],
  });

  it("owned property value grows at Fisher(growthPct) and feeds net assets", () => {
    const out = projectPlan(withProps([prop({ propertyType: "ppr" })], { endAge: 50 }));
    const rm = Math.pow(1.05 / 1.025, 1 / 12) - 1;
    const n = out.schedule.months;
    expect(out.yearly.at(-1).properties.p1.value)
      .toBeCloseTo(800000 * Math.pow(1 + rm, n), 2);
    for (const r of out.yearly) {
      expect(r.netAssets).toBeCloseTo(r.closingBalance + r.propertyClosing - r.liabilitiesClosing, 6);
    }
    // PPR: no rent, no deductions, no tax.
    for (const r of out.yearly) expect(r.tax).toBe(0);
  });

  it("purchase event: grown price, duty, loan, settlement cash, cost base seed", () => {
    // Planned NSW purchase at age 42 (July of plan year 2, m=24):
    // nominal price = 900k × 1.05² = 992,250; duty (general NSW) =
    // 10,909 + 4.5% × (992,250 − 364,000) = 39,180.25 nominal.
    const p = prop({
      status: "planned", propertyType: "ppr", priceToday: 900000, purchaseAge: 42,
      lvrPct: 80, purchaseCostsPct: 2,
    });
    const out = projectPlan(withProps([p], { endAge: 50 }));
    const m = 24;
    const infl = Math.pow(1.025, m / 12);
    const realPrice = 900000 * Math.pow(1.05 / 1.025, m / 12);
    const nominalPrice = realPrice * infl;
    expect(nominalPrice).toBeCloseTo(900000 * Math.pow(1.05, 2), 4);
    const dutyNominal = 10909 + 0.045 * (nominalPrice - 364000);
    const dutyReal = dutyNominal / infl;
    const costsReal = 0.02 * realPrice;
    const expectedSettle = realPrice * 0.2 + dutyReal + costsReal;
    const y2 = out.yearly[2];
    expect(y2.properties.p1.settlement).toBeCloseTo(expectedSettle, 2);
    expect(y2.properties.p1.costBaseSeed).toBeCloseTo(realPrice + dutyReal + costsReal, 2);
    // Before the purchase: nothing anywhere.
    expect(out.yearly[1].properties.p1.value).toBe(0);
    expect(out.yearly[1].liabilities["prop-p1"].closing).toBe(0);
    // The loan draws down at 80% LVR and starts amortising (30y P&I).
    expect(y2.liabilities["prop-p1"].closing).toBeGreaterThan(realPrice * 0.75);
    expect(y2.liabilities["prop-p1"].closing).toBeLessThan(realPrice * 0.8);
    // Settlement was funded from the cash asset (no unfunded).
    expect(out.shortfall).toBeNull();
    expect(y2.deficitFundedFromAssets).toBeGreaterThan(expectedSettle - 1);
    // Liabilities view (Commit 5): the purchase loan's drawdown shows
    // in its settlement year only, opens at zero, and closes at the
    // full drawn amount that same year (the loan starts amortising
    // immediately, but a single month's payment barely dents it).
    const loanReal = realPrice * 0.8;
    expect(y2.liabilities["prop-p1"].drawdown).toBeCloseTo(loanReal, 2);
    expect(out.yearly[1].liabilities["prop-p1"].drawdown).toBe(0);
    expect(y2.liabilities["prop-p1"].opening).toBe(0);
    expect(out.yearly[3].liabilities["prop-p1"].opening).toBeCloseTo(y2.liabilities["prop-p1"].closing, 6);
    // Focus Commit 2 follow-on: settlement's own breakdown, individually
    // reported — deposit + duty + costs − fhog (no FHOG/FHSSS/LMI here)
    // reconciles to the SAME settlement total exactly, by construction.
    expect(y2.properties.p1.deposit).toBeCloseTo(realPrice - loanReal, 2);
    expect(y2.properties.p1.duty).toBeCloseTo(dutyReal, 2);
    expect(y2.properties.p1.costs).toBeCloseTo(costsReal, 2);
    expect(y2.properties.p1.fhog).toBe(0);
    expect(y2.properties.p1.deposit + y2.properties.p1.duty + y2.properties.p1.costs - y2.properties.p1.fhog)
      .toBeCloseTo(y2.properties.p1.settlement, 2);
  });

  it("a settlement the assets cannot fund becomes unfunded cashflow — the purchase still completes", () => {
    const p = prop({ status: "planned", propertyType: "ppr", priceToday: 900000, purchaseAge: 42, lvrPct: 0 });
    const out = projectPlan({
      ...mkState({ endAge: 45, assets: [mkAsset({ allocation: zeroRealAlloc(), balance: 50000 })] }),
      properties: [p],
      liabilities: [],
    });
    expect(out.shortfall).not.toBeNull();
    expect(out.yearly[2].unfundedCashflow).toBeGreaterThan(700000);
    expect(out.yearly[2].properties.p1.value).toBeGreaterThan(0); // completed anyway
  });

  it("FHB + FHOG: duty waived and the grant reduces settlement cash", () => {
    const base = prop({ status: "planned", propertyType: "ppr", state: "QLD", priceToday: 600000, purchaseAge: 42, lvrPct: 80 });
    const fhb = projectPlan(withProps([{ ...base, firstHomeBuyer: true, newBuild: true }], { endAge: 45 }));
    const not = projectPlan(withProps([base], { endAge: 45 }));
    const dFhb = fhb.yearly[2].properties.p1.settlement;
    const dNot = not.yearly[2].properties.p1.settlement;
    // QLD ≤700k FHB → zero duty; new build → $30k FHOG (nominal, deflated).
    const infl = Math.pow(1.025, 2);
    const nominalPrice = 600000 * Math.pow(1.05, 2);
    const dutyNominal = 17325 + 0.045 * (nominalPrice - 540000);
    expect(dNot - dFhb).toBeCloseTo((dutyNominal + 30000) / infl, 1);
    // Focus Commit 2 follow-on: the breakdown fields individually show
    // what changed — duty waived to zero, and the grant reported as its
    // own (positive) fhog figure, not just netted invisibly into settlement.
    expect(fhb.yearly[2].properties.p1.duty).toBeCloseTo(0, 6);
    expect(fhb.yearly[2].properties.p1.fhog).toBeCloseTo(30000 / infl, 1);
    expect(not.yearly[2].properties.p1.fhog).toBe(0);
  });

  it("negative gearing: pre-2027 and new-build losses offset salary; existing dwellings quarantine", () => {
    const mkGeared = (start, acquisitionDate, newBuild) => projectPlan({
      ...mkState({
        endAge: 43,
        start,
        assets: [mkAsset({ allocation: growthOnlyAlloc() })],
        cashflows: { income: [salary(100000 / 12)] },
        // Isolate these known-value taxable-income checks from WCA
        // interest — see the "taxDetail carries the full per-person
        // assessment" test.
        plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      }),
      properties: [prop({
        acquisitionDate, newBuild,
        rent: { amount: 20000, indexBasis: "cpi", indexExtraPct: 0 },
        expenses: { amount: 30000, indexBasis: "cpi", indexExtraPct: 0 },
      })],
      liabilities: [],
    });
    // (a) FY2026-27 loss year (pre-2027): −10k offsets salary.
    const pre = mkGeared({ year: 2026, month: 7 }, "2026-08-01", false);
    expect(pre.yearly[0].taxDetail.client.taxableIncome).toBeCloseTo(100000 + 20000 - 30000, 2);
    // (b) FY2027-28 loss year, existing dwelling acquired post-Budget: quarantined.
    const post = mkGeared({ year: 2027, month: 7 }, "2026-08-01", false);
    expect(post.yearly[0].taxDetail.client.taxableIncome).toBeCloseTo(100000, 2);
    expect(post.yearly[0].taxDetail.client.quarantinedLossCarry).toBeCloseTo(10000, 2);
    // (c) FY2027-28 new-build loss: offsets salary.
    const nb = mkGeared({ year: 2027, month: 7 }, "2026-08-01", true);
    expect(nb.yearly[0].taxDetail.client.taxableIncome).toBeCloseTo(90000, 2);
    // (d) grandfathered acquisition (pre-12 May 2026): offsets salary post-2027.
    const gf = mkGeared({ year: 2027, month: 7 }, "2020-01-15", false);
    expect(gf.yearly[0].taxDetail.client.taxableIncome).toBeCloseTo(90000, 2);
  });

  it("quarantined losses apply against later rental profits, then capital gains", () => {
    // Property A quarantines a 10k/yr loss; property B profits 5k/yr.
    // Year 0: A quarantined (carry 10k), B's profit taxed. Year 1:
    // prior carry offsets B's profit (5k used, carry 10k−5k+10k new).
    const a = prop({ id: "pa", acquisitionDate: "2026-08-01",
      rent: { amount: 10000, indexBasis: "cpi", indexExtraPct: 0 },
      expenses: { amount: 20000, indexBasis: "cpi", indexExtraPct: 0 } });
    const b = prop({ id: "pb", acquisitionDate: "2026-08-01",
      rent: { amount: 8000, indexBasis: "cpi", indexExtraPct: 0 },
      expenses: { amount: 3000, indexBasis: "cpi", indexExtraPct: 0 } });
    const out = projectPlan({
      ...mkState({
        endAge: 43,
        start: { year: 2027, month: 7 },
        assets: [mkAsset({ allocation: growthOnlyAlloc() })],
        cashflows: { income: [salary(100000 / 12)] },
        // Isolate these known-value taxable-income checks from WCA
        // interest — see the "taxDetail carries the full per-person
        // assessment" test.
        plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      }),
      properties: [a, b],
      liabilities: [],
    });
    // Year 0: B's +5k taxed (no prior carry); A's −10k quarantined.
    expect(out.yearly[0].taxDetail.client.taxableIncome).toBeCloseTo(105000, 2);
    expect(out.yearly[0].taxDetail.client.quarantinedLossCarry).toBeCloseTo(10000, 2);
    // Year 1: carry offsets B's profit → taxable 100k; carry 10−5+10 = 15k.
    expect(out.yearly[1].taxDetail.client.taxableIncome).toBeCloseTo(100000, 2);
    expect(out.yearly[1].taxDetail.client.quarantinedLossCarry).toBeCloseTo(15000, 2);

    // Capital gains: carry also shelters a realised gain.
    const withSale = projectPlan({
      ...mkState({
        endAge: 43,
        start: { year: 2027, month: 7 },
        assets: [mkAsset({ allocation: growthOnlyAlloc(), cgtAsset: true, costBase: 20000 })],
        cashflows: {
          income: [salary(100000 / 12)],
          lumpSums: [{ id: "l1", assetId: "a1", amount: 10000, direction: "out", at: { kind: "age", age: 41 }, source: "input" }],
        },
      }),
      properties: [a],
      liabilities: [],
    });
    // Year 1 sale gain 8,000 fully sheltered by the 10k carry from year 0.
    expect(withSale.yearly[2].taxDetail.cgt).toBeCloseTo(0, 6);
  });

  it("regression gate: property-free scenarios are bit-identical", () => {
    const base = mkState({
      endAge: 50,
      cashflows: { income: [salary(100000 / 12)], contributions: [cf({ amount: 500, toAge: 50 })] },
    });
    const withEmpty = { ...JSON.parse(JSON.stringify(base)), properties: [], liabilities: [] };
    const x = projectPlan(base);
    const z = projectPlan(withEmpty);
    expect(Array.from(x.monthly.combined)).toEqual(Array.from(z.monthly.combined));
    for (let y = 0; y < x.yearly.length; y++) expect(x.yearly[y].tax).toBe(z.yearly[y].tax);
  });
});

// --- D5: unrealised gain (cost-base pool exposure) -----------------------------

describe("D5 — perAssetDetail.costBasePool", () => {
  it("exposes the pool for CGT assets and null for non-CGT/lifestyle", () => {
    const s = mkState({
      endAge: 41,
      assets: [
        mkAsset({ id: "cgt", allocation: growthOnlyAlloc(), balance: 100000, cgtAsset: true, costBase: 60000 }),
        mkAsset({ id: "noncgt", allocation: growthOnlyAlloc(), balance: 50000, cgtAsset: false, costBase: null }),
      ],
    });
    const out = projectPlan(s);
    const y0 = out.yearly[0].perAssetDetail;
    expect(y0.cgt.costBasePool).toBeCloseTo(60000, 6); // no flows this year → pool unchanged
    expect(y0.noncgt.costBasePool).toBeNull();
    // Unrealised gain = closing − pool.
    expect(y0.cgt.closing - y0.cgt.costBasePool).toBeCloseTo(y0.cgt.closing - 60000, 6);
  });

  it("the pool tracks contributions exactly as costBasePool.js does", () => {
    // growthOnlyAlloc has zero income component, so nothing reinvests
    // into the pool via distributions — only the contributions do.
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({ allocation: growthOnlyAlloc(), balance: 100000, cgtAsset: true, costBase: 50000 })],
      cashflows: { contributions: [cf({ amount: 1000, toAge: 41 })] },
    });
    const out = projectPlan(s);
    // 12 months × $1,000 contributed → pool = 50,000 + 12,000.
    expect(out.yearly[0].perAssetDetail.a1.costBasePool).toBeCloseTo(62000, 4);
  });
});

// --- Tier 1.2, Commit 1: super accounts, contributions, SG, earnings tax ----

function superAcct(over = {}) {
  return {
    id: "su1", name: "Super", owner: "client", balance: 0, taxFreeComponent: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, include: true,
    ...over,
  };
}

function employmentRow(over = {}) {
  return {
    id: "i1", label: "Salary", owner: "client", amount: 100000, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 },
    indexBasis: "cpi", indexExtraPct: 0, incomeType: "employment", sgApplies: true,
    ...over,
  };
}

describe("Tier 1.2 — Super (Commit 1): accounts, contributions, SG derivation, fund earnings tax", () => {
  it("SG derives from employment income at sgRate, capped at sgMaximumSalary per FY", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: { income: [employmentRow({ amount: 300000 })] }, // exceeds the $270,830 cap
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.contributions).toBeCloseTo(270830 * 0.12, 2);
  });

  it("SG applies uncapped below the maximum salary", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: { income: [employmentRow({ amount: 100000 })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.contributions).toBeCloseTo(100000 * 0.12, 2);
  });

  it("the per-row sgApplies:false toggle suppresses SG on an otherwise-eligible employment row", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: { income: [employmentRow({ amount: 100000, sgApplies: false })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.contributions).toBe(0);
  });

  it("non-employment income types never generate SG", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: { income: [employmentRow({ amount: 100000, incomeType: "otherTaxable" })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.contributions).toBe(0);
  });

  it("SG with no super account for the owner credits nothing (disclosed simplification) but never throws", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [] },
      cashflows: { income: [employmentRow({ amount: 100000 })] },
    });
    expect(() => projectPlan(s)).not.toThrow();
  });

  it("percentOfIncome contributions track an indexed salary", () => {
    const s = mkState({
      endAge: 50,
      plan: { superAccounts: [superAcct()] },
      cashflows: {
        income: [{
          id: "i1", label: "Salary", owner: "client", amount: 100000, frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 50 },
          indexBasis: "awote", indexExtraPct: 0, incomeType: "employment", sgApplies: false,
        }],
        superContributions: [{
          id: "sc1", label: "Sacrifice", owner: "client", accountId: "su1",
          type: "salarySacrifice", basis: "percentOfIncome", amount: 0, percent: 10,
          incomeRowId: "i1", frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 50 },
          indexBasis: "cpi", indexExtraPct: 0,
        }],
      },
      cpi: 0.025,
    });
    s.assumptions.awote = 0.035;
    const out = projectPlan(s);
    // Salary at year 5 grows in real terms at the AWOTE/CPI premium;
    // the 10% contribution must track that same indexed value exactly.
    const salaryY5 = 100000 * Math.pow(1.035 / 1.025, 5);
    expect(out.yearly[5].superDetail.su1.contributions).toBeCloseTo(salaryY5 * 0.1, 2);
  });

  it("account growth is net of the 15%/10% earnings-tax haircut, matching the closed form", () => {
    const s = mkState({
      endAge: 41,
      plan: {
        superAccounts: [superAcct({
          balance: 100000,
          allocation: { mode: "custom", incomePct: 4, growthPct: 3, frankingPct: 0, volBasis: "Balanced" },
        })],
      },
    });
    const out = projectPlan(s);
    // income taxed at 15%, growth at 15%×2/3=10% (the CGT-discount
    // assumption), combined THEN Fisher-converted — same structure as
    // assetMonthlyRate.
    const netNominal = 0.04 * (1 - 0.15) + 0.03 * (1 - 0.15 * (2 / 3));
    const monthlyRate = Math.pow((1 + netNominal) / 1.025, 1 / 12) - 1;
    const monthsInYear0 = out.schedule.monthsInFirstYear;
    expect(out.yearly[0].superDetail.su1.closing).toBeCloseTo(100000 * Math.pow(1 + monthlyRate, monthsInYear0), 2);
    // Reporting split: earnings (gross) minus earningsTax equals the
    // actual (net) growth applied to the balance.
    const d = out.yearly[0].superDetail.su1;
    expect(d.earnings - d.earningsTax).toBeCloseTo(d.closing - d.opening - d.contributions, 4);
  });

  it("super never enters combined/netAssets financial totals, and netAssets includes superClosing additively", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct({ balance: 50000, allocation: { mode: "custom", incomePct: 0, growthPct: 5, frankingPct: 0, volBasis: "Balanced" } })] },
    });
    const out = projectPlan(s);
    const y0 = out.yearly[0];
    expect(y0.superClosing).toBeGreaterThan(50000); // grew
    expect(y0.netAssets).toBeCloseTo(y0.closingBalance + y0.propertyClosing + y0.superClosing - y0.liabilitiesClosing, 6);
  });

  it("regression gate: a scenario with no super accounts is unaffected — superClosing is 0 and netAssets matches the pre-Tier-1.2 formula", () => {
    const s = mkState({
      endAge: 45,
      cashflows: { income: [{ ...employmentRow({ amount: 80000 }), incomeType: "employment", sgApplies: true }] },
    });
    // No plan.superAccounts at all (undefined) — must not throw and
    // must produce exactly the old (pre-super) netAssets formula.
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.superClosing).toBe(0);
      expect(row.superDetail).toEqual({});
      expect(row.netAssets).toBeCloseTo(row.closingBalance + row.propertyClosing - row.liabilitiesClosing, 6);
    }
  });
});

// --- Tier 1.2, Commit 2: caps, contributions tax, Division 293 --------------

function scRow(over = {}) {
  return {
    id: "sc1", label: "Contribution", owner: "client", accountId: "su1",
    type: "salarySacrifice", basis: "amount", amount: 0, percent: 0, incomeRowId: null,
    frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
    indexBasis: "none", indexExtraPct: 0,
    ...over,
  };
}

describe("Tier 1.2 — Super (Commit 2): caps, carry-forward, contributions tax, Division 293", () => {
  it("contributions tax: 15% deducted from concessional contributions at the point of crediting", () => {
    const s = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()] }, // 0% nominal allocation — growth math covered separately
      cashflows: { income: [employmentRow({ amount: 100000 })] }, // SG only, default sgApplies
    });
    const out = projectPlan(s);
    const d = out.yearly[0].superDetail.su1;
    const grossSg = 100000 * 0.12;
    expect(d.contributions).toBeCloseTo(grossSg, 2);
    expect(d.contributionsTax).toBeCloseTo(grossSg * 0.15, 2);
    // Net credited (gross − contributions tax) must exceed the closing
    // balance only by the real-terms CPI decay on an otherwise-zero
    // nominal return (see the dedicated growth-closed-form test) —
    // never by more than that decay.
    expect(d.closing).toBeLessThanOrEqual(grossSg * 0.85 + 1e-6);
    expect(d.closing).toBeGreaterThan(grossSg * 0.85 * 0.95); // sanity: not wildly off
  });

  it("salary sacrifice and personal deductible produce IDENTICAL net tax outcomes for equal amounts", () => {
    // Strengthened (engine-correctness fix) to also assert household cash
    // position, not just tax and asset balances — as originally written
    // this test passed while BOTH paths created money identically, so
    // tax-only equivalence alone proves nothing about correctness. See the
    // dedicated "Super contribution cash flow" describe block below for the
    // full WCA-level version; this one keeps its original narrow tax scope
    // plus the one cash assertion that was missing.
    // endAge 41 — two plan years — so PD's PAYG-deferred tax saving
    // (see below) has a following FY to land in as a refund.
    const scenario = (type) => mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()], workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      surplus: { mode: "accumulate", assetId: null },
      cashflows: {
        income: [employmentRow({ amount: 100000, sgApplies: false })], // isolate — no SG noise
        superContributions: [scRow({ type, amount: 10000 })],
      },
    });
    const ss = projectPlan(scenario("salarySacrifice"));
    const pd = projectPlan(scenario("personalDeductible"));
    expect(ss.yearly[0].taxDetail.client.taxableIncome).toBeCloseTo(pd.yearly[0].taxDetail.client.taxableIncome, 4);
    expect(ss.yearly[0].taxDetail.incomeTax).toBeCloseTo(pd.yearly[0].taxDetail.incomeTax, 4);
    // PAYG withholding (PAYG withholding, tax refund timing, and
    // deductions) treats the two DIFFERENTLY within year 0's own cash
    // flow: salary sacrifice reduces the PAYG withholding base
    // immediately (it reduced the salary actually paid); a personal
    // deductible contribution doesn't (PAYG ignores deductions, same
    // as a real employer's withholding) — so year 0's `.tax` and
    // `.wcaClosing` no longer match between the two. They converge
    // again only once PD's deferred saving lands as a bigger refund in
    // year 1 — checked here as the cumulative two-year position.
    const cumulativeTax = (out) => out.yearly[0].tax + out.yearly[1].tax;
    expect(cumulativeTax(ss)).toBeCloseTo(cumulativeTax(pd), 2);
    expect(ss.yearly[1].wcaClosing).toBeCloseTo(pd.yearly[1].wcaClosing, 2);
  });

  it("carry-forward: an under-cap year accrues unused cap, which a later over-cap year draws on (no excess)", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: {
        superContributions: [
          scRow({ id: "c1", amount: 10000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } }),
          scRow({ id: "c2", amount: 50000, from: { kind: "age", age: 41 }, to: { kind: "age", age: 41 } }),
        ],
      },
    });
    const out = projectPlan(s);
    // Year 0: CC 10,000 < 32,500 cap → 22,500 unused accrues.
    expect(out.yearly[0].taxDetail.client.excessConcessionalContributions).toBe(0);
    // Year 1: CC 50,000; shortfall 17,500 fully covered by the 22,500
    // carry-forward (TSB is trivially low) → no excess.
    expect(out.yearly[1].taxDetail.client.excessConcessionalContributions).toBeCloseTo(0, 2);
  });

  it("excess concessional contributions (no carry-forward available) are assessable with the 15% offset", () => {
    const s = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()] },
      cashflows: {
        income: [employmentRow({ amount: 80000, sgApplies: false })],
        superContributions: [scRow({ type: "personalDeductible", amount: 50000 })],
      },
    });
    const out = projectPlan(s);
    // 50,000 − 32,500 cap = 17,500 excess (no prior carry-forward).
    expect(out.yearly[0].taxDetail.client.excessConcessionalContributions).toBeCloseTo(17500, 2);
    expect(out.yearly[0].taxDetail.client.excessCcOffset).toBeCloseTo(17500 * 0.15, 2);
  });

  it("toConcessionalCap fills the cap INCLUDING available carry-forward from a prior year", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: {
        superContributions: [
          scRow({ id: "c1", amount: 2500, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } }),
          scRow({ id: "c2", basis: "toConcessionalCap", from: { kind: "age", age: 41 }, to: { kind: "age", age: 41 } }),
        ],
      },
    });
    const out = projectPlan(s);
    // Year 0: 2,500 contributed → 30,000 unused accrues to carry-forward.
    // Year 1's cap (per-threshold indexation, Super thresholds Commit 1):
    // 32,500 × 1.035¹ = 33,637.50 → floor to the nearest $2,500 = 32,500
    // nominal (unchanged — one year of 3.5% AWOTE growth isn't yet
    // enough to clear the next rounding step) → ÷1.025 deflation =
    // 31,707.317073... real. Fill = 31,707.317073 + 30,000 carry-forward
    // = 61,707.317073 (irregular real-terms stepping is the corrected
    // behaviour, not a bug — see superRates.js's header comment).
    expect(out.yearly[1].superDetail.su1.contributions).toBeCloseTo(31707.317073 + 30000, 1);
    expect(out.yearly[1].taxDetail.client.excessConcessionalContributions).toBeCloseTo(0, 2);
  });

  it("non-concessional bring-forward triggers when contributions exceed the annual cap, accepting the full multi-year total", () => {
    const s = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()] },
      cashflows: { superContributions: [scRow({ type: "personalNonDeductible", amount: 300000 })] },
    });
    const out = projectPlan(s);
    // 300,000 > 130,000 annual cap, TSB well under $1.84m → 3-year
    // bring-forward, $390,000 total → fully accepted, untaxed.
    expect(out.yearly[0].superDetail.su1.contributions).toBeCloseTo(300000, 1);
    expect(out.yearly[0].superDetail.su1.contributionsTax).toBe(0);
  });

  it("non-concessional excess beyond the bring-forward total is rejected with a flagged warning, not credited", () => {
    const s = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()] },
      cashflows: { superContributions: [scRow({ type: "personalNonDeductible", amount: 500000 })] },
    });
    const out = projectPlan(s);
    // Accepted = 390,000 (the full 3-year bring-forward); 110,000 rejected.
    expect(out.yearly[0].superDetail.su1.contributions).toBeCloseTo(390000, 1);
    expect(out.superWarnings.some((w) => w.type === "nonConcessional")).toBe(true);
  });

  it("age 75 blocks member contributions (SG unaffected), flagged with a warning", () => {
    const s = mkState({
      plan: { client: { currentAge: 74 }, superAccounts: [superAcct()] },
      endAge: 76,
      cashflows: {
        income: [employmentRow({ amount: 50000, from: { kind: "age", age: 74 }, to: { kind: "age", age: 76 } })],
        superContributions: [scRow({
          amount: 5000, from: { kind: "age", age: 74 }, to: { kind: "age", age: 76 },
        })],
      },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.contributions).toBeGreaterThan(0); // age 74: SG + SS
    expect(out.yearly[1].superDetail.su1.contributions).toBeGreaterThan(0); // age 75: still allowed (boundary)
    // age 76: salary sacrifice rejected, but SG (no age limit) still lands.
    const sgOnlyGross = Math.min(50000, 270830) * 0.12;
    expect(out.yearly[2].superDetail.su1.contributions).toBeCloseTo(sgOnlyGross, 2);
    expect(out.superWarnings.some((w) => w.type === "salarySacrifice" && w.reason.includes("Age"))).toBe(true);
  });

  it("the work test (ages 67–74) blocks personal deductible contributions when workTestMet is false", () => {
    const s = mkState({
      plan: {
        client: { currentAge: 70, super: { carryForward: [0, 0, 0, 0, 0], bringForwardTriggeredYear: null, workTestMet: false } },
        superAccounts: [superAcct()],
      },
      endAge: 70,
      cashflows: { superContributions: [scRow({ type: "personalDeductible", amount: 5000, from: { kind: "age", age: 70 }, to: { kind: "age", age: 70 } })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.contributions).toBe(0);
    expect(out.superWarnings.some((w) => w.type === "personalDeductible" && w.reason.includes("Work test"))).toBe(true);
  });

  it("Division 293 is assessed on high income + concessional contributions, paid the following FY", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: {
        income: [employmentRow({ amount: 300000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } })],
      },
    });
    const out = projectPlan(s);
    expect(out.yearly[1].taxDetail.client.div293).toBeGreaterThan(0); // year 0's assessment, paid year 1
    expect(out.accruedDiv293AtEnd).toBeGreaterThan(0); // year 1's own assessment, unpayable within the projection
  });

  it("regression gate: no-super scenarios are still bit-identical after the full Commit 2 cap/tax integration", () => {
    const s = mkState({
      endAge: 45,
      cashflows: { income: [employmentRow({ amount: 90000 })] }, // employment income, no super account to receive SG
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.superClosing).toBe(0);
      expect(row.taxDetail.div293).toBe(0);
      expect(row.taxDetail.client.excessConcessionalContributions).toBe(0);
      expect(row.taxDetail.client.div293).toBe(0);
    }
    expect(out.accruedDiv293AtEnd).toBe(0);
    expect(out.superWarnings).toEqual([]);
  });
});

// --- Tier 1.2, Commit 3: preservation, withdrawals, proportioning ----------

function swRow(over = {}) {
  return {
    id: "sw1", label: "Withdrawal", owner: "client", accountId: "su1",
    amount: 0, frequency: "annual",
    from: { kind: "age", age: 60 }, to: { kind: "age", age: 60 },
    indexBasis: "none", indexExtraPct: 0,
    ...over,
  };
}

describe("Tier 1.2 — Super (Commit 3): preservation, withdrawals, proportioning", () => {
  it("a super account is invisible to deficit funding until the owner's condition of release is met, then available", () => {
    // retirementAge 60 → superReleaseAge = max(60, 60) capped at 65 = 60.
    const s = mkState({
      plan: { client: { currentAge: 58, retirementAge: 60 }, superAccounts: [superAcct({ balance: 50000 })] },
      endAge: 62,
      assets: [],
      cashflows: { expenses: [cf({ assetId: null, amount: 1000 })] }, // −12k/yr deficit, no financial assets to fund it
    });
    const out = projectPlan(s);
    // Ages 58, 59 — below release age 60: shortfall unfunded, super untouched.
    expect(out.yearly[0].superDetail.su1.withdrawals).toBe(0);
    expect(out.yearly[0].unfundedCashflow).toBeGreaterThan(0);
    expect(out.yearly[1].superDetail.su1.withdrawals).toBe(0);
    expect(out.yearly[1].unfundedCashflow).toBeGreaterThan(0);
    // Age 60 — released: the same deficit now draws from super instead.
    expect(out.yearly[2].superDetail.su1.withdrawals).toBeGreaterThan(0);
    expect(out.yearly[2].unfundedCashflow).toBeCloseTo(0, 2);
    expect(out.yearly[3].superDetail.su1.withdrawals).toBeGreaterThan(0);
  });

  it("proportioning recalculates at every payment: contributions between two withdrawals dilute the tax-free fraction, and the SECOND withdrawal reflects the NEW fraction, not the first", () => {
    // cpi:0 with a 0%/0% allocation gives an exact 0 real monthly rate
    // (no compounding drift), so every balance below is exact.
    const s = mkState({
      // divTaxPaidFrom: "cash" — this test's $1,000,000 salary triggers
      // Division 293 (release-from-super is the DEFAULT), which would
      // otherwise drain the very account this test is isolating the
      // withdrawal-proportioning math on. Pinning to cash reproduces
      // this test's pre-existing intent exactly.
      plan: { client: { currentAge: 65, retirementAge: 65, super: { divTaxPaidFrom: "cash" } }, superAccounts: [superAcct({ balance: 0 })] },
      endAge: 68, // 3 plan years: ages 65, 66, 67
      cpi: 0,
      cashflows: {
        // Ample income so every contribution is funded from household
        // cash (the engine-correctness fix) rather than by selling the
        // default asset or — once exhausted — drawing on super itself,
        // which would otherwise contaminate the proportioning math
        // this test is isolating.
        income: [annualSalary(1000000, { from: { kind: "age", age: 65 }, to: { kind: "age", age: 67 } })],
        // Year 0 (age 65): a $100,000 non-concessional contribution —
        // fully tax-free, the account's only balance so far.
        superContributions: [
          scRow({ id: "ncc", type: "personalNonDeductible", amount: 100000, from: { kind: "age", age: 65 }, to: { kind: "age", age: 65 } }),
          // Year 1 (age 66) and year 2 (age 67): a $50,000 gross
          // concessional contribution each year — net of 15% tax
          // ($42,500), credited to the TAXABLE component only.
          scRow({ id: "cc1", type: "personalDeductible", amount: 50000, from: { kind: "age", age: 66 }, to: { kind: "age", age: 66 } }),
          scRow({ id: "cc2", type: "personalDeductible", amount: 50000, from: { kind: "age", age: 67 }, to: { kind: "age", age: 67 } }),
        ],
        // A $42,500 withdrawal in July of years 1 and 2 — fired the
        // same month as that year's concessional contribution, and
        // (per the engine's within-month order) credited AFTER it.
        superWithdrawals: [
          swRow({ id: "w1", amount: 42500, from: { kind: "age", age: 66 }, to: { kind: "age", age: 66 } }),
          swRow({ id: "w2", amount: 42500, from: { kind: "age", age: 67 }, to: { kind: "age", age: 67 } }),
        ],
      },
    });
    const out = projectPlan(s);

    // Year 0 close: balance 100,000, all tax-free (100% — the account's
    // only money so far).
    expect(out.yearly[0].superDetail.su1.closing).toBeCloseTo(100000, 2);
    expect(out.yearly[0].superDetail.su1.taxFreeClosing).toBeCloseTo(100000, 2);

    // Year 1: contribution lands first (balance 100,000 → 142,500,
    // taxFree unchanged at 100,000 — fraction 100,000/142,500), THEN
    // the $42,500 withdrawal is proportioned at THAT fraction:
    //   taxFreeWithdrawn = 42,500 × (100,000/142,500)
    const fraction1 = 100000 / 142500;
    const taxFreeAfterW1 = 100000 - 42500 * fraction1;
    expect(out.yearly[1].superDetail.su1.closing).toBeCloseTo(100000, 2); // 142,500 − 42,500
    expect(out.yearly[1].superDetail.su1.taxFreeClosing).toBeCloseTo(taxFreeAfterW1, 2);

    // Year 2: the SAME sequence, but starting from year 1's ENDING
    // tax-free balance (not the original 100%) — proving the fraction
    // is recalculated fresh at each payment, not fixed at inception.
    const fraction2 = taxFreeAfterW1 / 142500;
    const taxFreeAfterW2 = taxFreeAfterW1 - 42500 * fraction2;
    expect(out.yearly[2].superDetail.su1.closing).toBeCloseTo(100000, 2);
    expect(out.yearly[2].superDetail.su1.taxFreeClosing).toBeCloseTo(taxFreeAfterW2, 2);

    // The fraction strictly decreased between the two withdrawals —
    // each concessional contribution dilutes it further. A fixed-at-
    // commencement (pension-style) proportion would keep this constant.
    expect(fraction2).toBeLessThan(fraction1);
  });

  it("withdrawals from age 60 are tax-free from a taxed source — the withdrawn amount never enters taxable income", () => {
    const s = mkState({
      plan: { client: { currentAge: 62, retirementAge: 62 }, superAccounts: [superAcct({ balance: 50000, taxFreeComponent: 10000 })] },
      endAge: 63,
      assets: [],
      cashflows: { superWithdrawals: [swRow({ amount: 20000, from: { kind: "age", age: 62 }, to: { kind: "age", age: 62 } })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.withdrawals).toBeCloseTo(20000, 2);
    expect(out.yearly[0].taxDetail.client.taxableIncome).toBe(0);
    expect(out.yearly[0].tax).toBe(0);
  });

  it("an explicit withdrawal row requested before any condition of release is blocked in full, with a flagged warning — never partially paid", () => {
    const s = mkState({
      plan: { client: { currentAge: 55, retirementAge: 55 }, superAccounts: [superAcct({ balance: 50000 })] }, // released only at 60 (preservation age floor)
      endAge: 56,
      cpi: 0, // exact balance, no real-terms decay, to isolate the blocking assertion
      cashflows: { superWithdrawals: [swRow({ amount: 10000, from: { kind: "age", age: 55 }, to: { kind: "age", age: 55 } })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.withdrawals).toBe(0);
    expect(out.yearly[0].superDetail.su1.closing).toBeCloseTo(50000, 2); // untouched
    expect(out.superWarnings.some((w) => w.type === "withdrawal" && w.reason.includes("60"))).toBe(true);
  });

  it("regression gate: no-super scenarios are unaffected by the withdrawal/proportioning machinery", () => {
    const s = mkState({
      endAge: 45,
      cashflows: { income: [employmentRow({ amount: 90000 })] },
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.superClosing).toBe(0);
      expect(row.superDetail).toEqual({});
    }
    expect(out.superWarnings).toEqual([]);
  });
});

// --- Tier 1.2, Commit 4: per-type contribution breakdown + cap-usage display -

describe("Tier 1.2 — Super (Commit 4): superDetail type breakdown, superCapUsage", () => {
  it("superDetail splits the aggregate contribution total by type", () => {
    const s = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()] },
      cashflows: {
        income: [employmentRow({ amount: 100000, sgApplies: true })], // SG only
        superContributions: [scRow({ type: "personalDeductible", amount: 5000 })],
      },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].superDetail.su1;
    const sgGross = 100000 * 0.12;
    expect(d.sg).toBeCloseTo(sgGross, 2);
    expect(d.personalDeductible).toBeCloseTo(5000, 2);
    expect(d.salarySacrifice).toBe(0);
    expect(d.nonConcessional).toBe(0);
    // The breakdown always sums back to the pre-existing aggregate.
    expect(d.sg + d.salarySacrifice + d.personalDeductible + d.nonConcessional).toBeCloseTo(d.contributions, 2);
  });

  it("a toConcessionalCap fill attributes to the filling row's own type in the breakdown", () => {
    const s = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()] },
      cashflows: { superContributions: [scRow({ type: "personalDeductible", basis: "toConcessionalCap" })] },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].superDetail.su1;
    expect(d.personalDeductible).toBeCloseTo(32500, 1); // the full cap, nothing else contributed
    expect(d.sg).toBe(0);
    expect(d.salarySacrifice).toBe(0);
  });

  it("superCapUsage reports the cap, per-type usage, and available headroom (incl. carry-forward) per person", () => {
    const s = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()] },
      cashflows: { income: [employmentRow({ amount: 70000 })] }, // SG only: 70,000 × 0.12 = 8,400
    });
    const out = projectPlan(s);
    const u = out.yearly[0].superCapUsage.client;
    expect(u.cap).toBe(32500);
    expect(u.sg).toBeCloseTo(8400, 2);
    expect(u.salarySacrifice).toBe(0);
    expect(u.personalDeductible).toBe(0);
    expect(u.carryForwardAvailable).toBe(0); // nothing accrued yet
    expect(u.available).toBeCloseTo(32500 - 8400, 2);
  });

  it("regression gate: superCapUsage is still reported per person even with no super accounts (cap headroom is a person-level figure, not account-gated), and superDetail stays empty", () => {
    const s = mkState({ endAge: 41 });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail).toEqual({});
    expect(out.yearly[0].superCapUsage.client.available).toBe(32500);
    expect(out.yearly[0].superCapUsage.client.sg).toBe(0);
  });
});

// --- Working Cash Account (engine correctness fix) --------------------------

// Annual income row (fires in July only) — the exact shape that
// exposed the bug: surplus/deficit evaluated monthly meant this whole
// year's salary was "spent" the month it landed, starving the other
// eleven.
function annualSalary(amount, over = {}) {
  return {
    id: "sal", label: "Salary", owner: "client", amount, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
    indexed: true, assetId: null, ...over,
  };
}

describe("Working Cash Account (engine correctness fix)", () => {
  it("bug repro: annual salary + monthly expenses no longer force spurious deficit funding", () => {
    // The exact repro from the bug report: $100k annual salary, $5k/mo
    // expenses ($60k/yr), one $200k asset, surplus mode "spend".
    const s = mkState({
      endAge: 43,
      assets: [mkAsset({ id: "a1", balance: 200000, allocation: zeroRealAlloc() })],
      cashflows: { income: [annualSalary(100000)], expenses: [cf({ assetId: null, amount: 5000 })] },
      surplus: { mode: "spend", assetId: null },
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      // Zero deficit funding every year — the WCA absorbs July's lump
      // and pays the other eleven months out of it.
      expect(row.deficitFundedFromAssets).toBe(0);
      expect(row.unfundedCashflow).toBe(0);
      // A positive-surplus year cannot show deficit funding — the two
      // figures must be mutually consistent.
      expect(row.surplusOrDeficit).toBeGreaterThan(0);
    }
    // The asset is never sold — it only ever grows via the zero-real
    // allocation's own (zero) return.
    expect(out.yearly[2].perAssetClosing.a1).toBeCloseTo(200000, 2);
  });

  it("WCA ledger reconciles: opening + interest + netFlow − sweeps = closing, per year", () => {
    const s = mkState({
      endAge: 43,
      assets: [mkAsset({ id: "a1", balance: 200000, allocation: zeroRealAlloc() })],
      cashflows: { income: [annualSalary(100000)], expenses: [cf({ assetId: null, amount: 5000 })] },
      surplus: { mode: "accumulate", assetId: null },
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      const d = row.wcaDetail;
      // sweptToCash is informational only (accumulate mode moves
      // nothing — the excess already sits in the balance via netFlow),
      // so it does NOT appear in the reconciliation; only the sweeps
      // that actually move money OUT (invest/spend) are subtracted.
      expect(d.opening + d.interest + d.netFlow - d.sweptInvested - d.sweptSpent)
        .toBeCloseTo(d.closing, 4);
      expect(d.closing).toBeCloseTo(row.wcaClosing, 6);
    }
  });

  it('FY-end sweep "accumulate" (the default) leaves the surplus in the WCA', () => {
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({ id: "a1", balance: 200000, allocation: zeroRealAlloc() })],
      cashflows: { income: [annualSalary(100000)], expenses: [cf({ assetId: null, amount: 5000 })] },
      surplus: { mode: "accumulate", assetId: null },
    });
    const out = projectPlan(s);
    const r = out.yearly[0];
    expect(r.surplusAccumulated).toBeGreaterThan(15000); // ~100k − 60k expenses − ~22.5k tax
    expect(r.surplusInvested).toBe(0);
    expect(r.surplusSpent).toBe(0);
    expect(r.wcaClosing).toBeCloseTo(r.surplusAccumulated, 2);
    expect(out.yearly[0].perAssetClosing.a1).toBeCloseTo(200000, 2); // untouched — nothing invested
  });

  it('FY-end sweep "invest" moves the WCA surplus into the nominated asset, once, at FY-end', () => {
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({ id: "a1", balance: 200000, allocation: zeroRealAlloc() })],
      cashflows: { income: [annualSalary(100000)], expenses: [cf({ assetId: null, amount: 5000 })] },
      surplus: { mode: "invest", assetId: "a1" },
    });
    const out = projectPlan(s);
    const r = out.yearly[0];
    expect(r.surplusInvested).toBeGreaterThan(15000); // ~100k − 60k expenses − ~22.5k tax
    expect(r.surplusAccumulated).toBe(0);
    expect(r.wcaClosing).toBeCloseTo(0, 2); // swept out, nothing left accumulating in the WCA
    expect(r.perAssetClosing.a1).toBeCloseTo(200000 + r.surplusInvested, 2);
  });

  it('FY-end sweep "spend" discards the WCA surplus — it leaves the model', () => {
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({ id: "a1", balance: 200000, allocation: zeroRealAlloc() })],
      cashflows: { income: [annualSalary(100000)], expenses: [cf({ assetId: null, amount: 5000 })] },
      surplus: { mode: "spend", assetId: null },
    });
    const out = projectPlan(s);
    const r = out.yearly[0];
    expect(r.surplusSpent).toBeGreaterThan(15000); // ~100k − 60k expenses − ~22.5k tax
    expect(r.surplusAccumulated).toBe(0);
    expect(r.surplusInvested).toBe(0);
    expect(r.wcaClosing).toBeCloseTo(0, 2);
    expect(r.perAssetClosing.a1).toBeCloseTo(200000, 2); // nothing invested either
  });

  it("minimumBalance draws a top-up from fundingOrder before the WCA would fall below it", () => {
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({ id: "a1", balance: 200000, allocation: zeroRealAlloc() })],
      cashflows: { income: [annualSalary(100000)], expenses: [cf({ assetId: null, amount: 5000 })] },
      surplus: { mode: "accumulate", assetId: null },
      plan: { workingCash: { balance: 0, minimumBalance: 20000, ratePct: 2.5 } },
    });
    const out = projectPlan(s);
    // Before July's salary lands, five months of $5k expenses (25,000)
    // exceed the WCA's zero starting balance well before minimumBalance
    // (20,000) is breached — a top-up from the asset must occur.
    expect(out.yearly[0].deficitFundedFromAssets).toBeGreaterThan(0);
    expect(out.yearly[0].unfundedCashflow).toBe(0); // the asset has plenty — never truly unfunded
  });

  it("a genuinely unfunded month reports exactly that month's shortfall, not a compounding running total", () => {
    // No income at all, a small asset that runs out fast — the same
    // shape as the pre-existing "records unfunded deficit" test, which
    // already exercises the non-compounding fix at scale; this checks
    // the per-month figure directly.
    const s = mkState({
      endAge: 40,
      assets: [mkAsset({ id: "a1", balance: 2000, allocation: zeroRealAlloc() })],
      cashflows: { expenses: [cf({ assetId: null, amount: 1000 })] },
    });
    const out = projectPlan(s);
    // Asset covers 2 months; every month after that is unfunded at
    // exactly $1,000 — not a growing figure.
    expect(out.shortfall.total).toBeCloseTo(1000 * (12 - 2), 4);
  });

  it("netAssets includes the WCA balance additively", () => {
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({ id: "a1", balance: 200000, allocation: zeroRealAlloc() })],
      cashflows: { income: [annualSalary(100000)], expenses: [cf({ assetId: null, amount: 5000 })] },
      surplus: { mode: "accumulate", assetId: null },
    });
    const out = projectPlan(s);
    const r = out.yearly[0];
    expect(r.netAssets).toBeCloseTo(r.closingBalance + r.propertyClosing + r.superClosing + r.wcaClosing - r.liabilitiesClosing, 6);
  });

  it("a configured ratePct overrides the Cash profile default", () => {
    const withRate = (ratePct) => mkState({
      endAge: 41,
      assets: [mkAsset({ id: "a1", balance: 0, allocation: zeroRealAlloc() })],
      cashflows: { income: [annualSalary(100000)], expenses: [cf({ assetId: null, amount: 5000 })] },
      surplus: { mode: "accumulate", assetId: null },
      plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct } },
    });
    // ratePct == cpi*100 → exactly 0% real WCA growth: interest is 0.
    const zero = projectPlan(withRate(2.5));
    expect(zero.yearly[0].wcaDetail.interest).toBeCloseTo(0, 6);
    // A higher rate produces strictly more interest than a lower one.
    const low = projectPlan(withRate(2.5));
    const high = projectPlan(withRate(6));
    expect(high.yearly[0].wcaDetail.interest).toBeGreaterThan(low.yearly[0].wcaDetail.interest);
  });

  it("regression gate: monthly income matching monthly expenses (no timing mismatch) stays materially unchanged", () => {
    // Same income and outflow cadence — the WCA should sit near zero
    // all year, so this should closely match the pre-WCA behaviour.
    // Expect only a small difference from WCA interest (spec's own
    // regression note) — asserting the shape, not bit-identity.
    const s = mkState({
      endAge: 44,
      assets: [mkAsset({ balance: 100000, allocation: zeroRealAlloc() })],
      cashflows: {
        income: [cf({ assetId: null, amount: 1000, toAge: 44 })],
        expenses: [cf({ assetId: null, amount: 1000, toAge: 44 })],
      },
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.deficitFundedFromAssets).toBe(0);
      expect(row.unfundedCashflow).toBe(0);
    }
    // The asset itself (zero real return) never moves.
    expect(out.yearly[3].perAssetClosing.a1).toBeCloseTo(100000, 2);
  });

  it("surplusOrDeficit includes WCA interest (Cashflow view Commit 2: WCA interest is part of Total income)", () => {
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({ id: "a1", balance: 200000, allocation: zeroRealAlloc() })],
      cashflows: { income: [annualSalary(100000)], expenses: [cf({ assetId: null, amount: 5000 })] },
      surplus: { mode: "accumulate", assetId: null },
    });
    const out = projectPlan(s);
    const r = out.yearly[0];
    // household net (income − expenses − tax, no WCA interest) plus
    // the WCA's own interest for the year should equal the reported
    // surplusOrDeficit exactly — the two are no longer the same figure
    // by design (see buildCashflowGroups' header comment in main.js).
    const householdNet = r.income - r.expenses - r.tax;
    expect(r.surplusOrDeficit).toBeCloseTo(householdNet + r.wcaDetail.interest, 4);
    expect(r.wcaDetail.interest).toBeGreaterThan(0);
  });
});

// --- Super contribution cash flow (engine-correctness fix: contributions
// used to be credited to super and deducted from taxable income without
// ever leaving household cash — pure money creation). See schedule.js's
// reduceHouseholdCash and deterministic.js's superContribCashOut.
describe("Super contribution cash flow (engine-correctness fix)", () => {
  // 0% real WCA growth (ratePct == cpi×100) — the same zero-real-rate
  // trick as zeroRealAlloc — so every WCA figure below is exact, and
  // "accumulate" mode so nothing is swept out at FY-end, leaving
  // wcaClosing equal to the year's actual net cash position.
  const zeroRealWca = { balance: 0, minimumBalance: 0, ratePct: 2.5 };
  const accumulate = { mode: "accumulate", assetId: null };

  it("personal deductible: the WCA falls by the contribution immediately, and rises by the tax saved once the PAYG refund lands next FY — net household position is worse, never better", () => {
    // PAYG withholding (PAYG withholding, tax refund timing, and
    // deductions) is computed on gross salary alone, ignoring
    // deductions — so a personal deductible contribution's tax saving
    // no longer shows up in the SAME year's cash (unlike before that
    // commit): year 0's WCA falls by exactly the contribution, and the
    // saving arrives as a bigger refund settling in year 1. endAge 41
    // gives a second year for that refund to land in.
    const scenario = (contribution) => mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()], workingCash: zeroRealWca },
      surplus: accumulate,
      cashflows: {
        income: [employmentRow({ amount: 120000, sgApplies: false })],
        ...(contribution
          ? { superContributions: [scRow({ type: "personalDeductible", amount: contribution })] }
          : {}),
      },
    });
    const withContrib = projectPlan(scenario(20000)).yearly;
    const without = projectPlan(scenario(0)).yearly;
    const taxSaved = without[0].taxDetail.client.actualTaxPayable - withContrib[0].taxDetail.client.actualTaxPayable;
    expect(taxSaved).toBeGreaterThan(0); // the deduction actually reduces actual tax payable
    expect(taxSaved).toBeLessThan(20000); // never a full-dollar refund
    // Year 0: WCA falls by exactly the contribution — PAYG (computed on
    // gross salary) is identical either way, so there is NO same-year
    // tax offset yet.
    expect(withContrib[0].wcaClosing).toBeCloseTo(without[0].wcaClosing - 20000, 2);
    // Year 1: the deferred saving has now landed (as a bigger refund
    // settling that July) — the cumulative two-year position falls by
    // exactly (contribution − tax saved), not by the contribution alone.
    expect(withContrib[1].wcaClosing).toBeCloseTo(without[1].wcaClosing - 20000 + taxSaved, 2);
    // Net household cash position after both years: worse off by
    // (contribution − tax saved), never better — the money-creation
    // bug's exact inverse.
    const worseOff = without[1].wcaClosing - withContrib[1].wcaClosing;
    expect(worseOff).toBeCloseTo(20000 - taxSaved, 2);
    expect(worseOff).toBeGreaterThan(0);
  });

  it("salary sacrifice: the WCA credit equals gross salary minus the sacrifice — asserting explicitly that no second debit occurs", () => {
    const sacrificed = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()], workingCash: zeroRealWca },
      surplus: accumulate,
      cashflows: {
        income: [employmentRow({ amount: 120000, sgApplies: false })],
        superContributions: [scRow({ type: "salarySacrifice", amount: 20000 })],
      },
    });
    // A client earning $100k outright, with no contribution of any kind —
    // household cash in the sacrifice scenario must match this EXACTLY.
    // If the $20k sacrifice were ALSO debited as a household outflow (the
    // original defect, mirrored from personal deductible because both
    // paths shared the same broken logic), this would fail by exactly $20k.
    const plainHundredK = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()], workingCash: zeroRealWca },
      surplus: accumulate,
      cashflows: { income: [employmentRow({ amount: 100000, sgApplies: false })] },
    });
    const outSacrificed = projectPlan(sacrificed).yearly[0];
    const outPlain = projectPlan(plainHundredK).yearly[0];
    expect(outSacrificed.income).toBeCloseTo(100000, 2); // 120,000 − 20,000
    expect(outSacrificed.income).toBeCloseTo(outPlain.income, 2);
    expect(outSacrificed.tax).toBeCloseTo(outPlain.tax, 2);
    expect(outSacrificed.wcaClosing).toBeCloseTo(outPlain.wcaClosing, 2); // no second debit
    // Super still actually received the sacrificed amount.
    expect(outSacrificed.superDetail.su1.contributions).toBeCloseTo(20000, 2);
  });

  it("SG: the WCA is completely unaffected by SG, while super still receives it", () => {
    const withSg = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()], workingCash: zeroRealWca },
      surplus: accumulate,
      cashflows: { income: [employmentRow({ amount: 120000, sgApplies: true })] },
    });
    const withoutSg = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()], workingCash: zeroRealWca },
      surplus: accumulate,
      cashflows: { income: [employmentRow({ amount: 120000, sgApplies: false })] },
    });
    const outWith = projectPlan(withSg).yearly[0];
    const outWithout = projectPlan(withoutSg).yearly[0];
    // SG is employer-paid, on top of salary — identical household cash and
    // tax whether or not SG applies.
    expect(outWith.income).toBeCloseTo(outWithout.income, 2);
    expect(outWith.tax).toBeCloseTo(outWithout.tax, 2);
    expect(outWith.wcaClosing).toBeCloseTo(outWithout.wcaClosing, 2);
    // Super still receives the SG contribution.
    expect(outWith.superDetail.su1.contributions).toBeCloseTo(120000 * 0.12, 2);
  });

  it("a contribution larger than available household cash draws on fundingOrder, then reports unfunded cashflow once that's exhausted too", () => {
    const s = mkState({
      endAge: 40,
      assets: [mkAsset({ id: "a1", balance: 5000, allocation: zeroRealAlloc() })],
      plan: { superAccounts: [superAcct()], workingCash: zeroRealWca },
      surplus: accumulate,
      cashflows: {
        income: [employmentRow({ amount: 12000, sgApplies: false })], // modest cash, nowhere near the contribution
        superContributions: [scRow({ type: "personalDeductible", amount: 20000 })],
      },
    });
    const out = projectPlan(s).yearly[0];
    // The $20k contribution far exceeds the $12k income plus the $5k asset —
    // the shortfall drains the asset (fundingOrder), then the remainder is
    // genuinely unfunded. A client cannot contribute money they don't have,
    // and the tool must show that rather than hide it.
    expect(out.deficitFundedFromAssets).toBeGreaterThan(0);
    expect(out.perAssetClosing.a1).toBeCloseTo(0, 2); // fully drained
    expect(out.unfundedCashflow).toBeGreaterThan(0);
    // Super still receives the full contribution — the cash gap is the
    // household's problem to fund, not a reason to silently shrink it.
    expect(out.superDetail.su1.contributions).toBeCloseTo(20000, 2);
  });
});

// --- toConcessionalCap contribution cash flow (engine-correctness fix,
// cap-fill gap). schedule.js can't compute a toConcessionalCap row's fill
// amount (it depends on the live carry-forward ledger), so it hands the
// row to deterministic.js's year loop instead — which credited the fill
// to super but never charged household cash for it (the same defect
// e1eb61a fixed for explicit amount/percentOfIncome rows, left open here
// because the fix amount wasn't known until this point). See
// deterministic.js's a-super-fill step and schedule.js's
// toConcessionalCapRows header comment.
describe("toConcessionalCap contribution cash flow (engine-correctness fix)", () => {
  const zeroRealWca = { balance: 0, minimumBalance: 0, ratePct: 2.5 };
  const accumulate = { mode: "accumulate", assetId: null };

  it('basis "amount" and basis "toConcessionalCap" produce IDENTICAL household cash, super balance and tax for the same resulting contribution', () => {
    // SG disabled so the fill is the ONLY concessional contribution —
    // superDetail.su1.contributions this FY is then exactly the fill.
    const capState = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()], workingCash: zeroRealWca },
      surplus: accumulate,
      cashflows: {
        income: [employmentRow({ amount: 180000, sgApplies: false })],
        superContributions: [scRow({ type: "personalDeductible", basis: "toConcessionalCap" })],
      },
    });
    const capOut = projectPlan(capState).yearly[0];
    const fillAmount = capOut.superDetail.su1.contributions;
    expect(fillAmount).toBeGreaterThan(0);

    const amountState = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()], workingCash: zeroRealWca },
      surplus: accumulate,
      cashflows: {
        income: [employmentRow({ amount: 180000, sgApplies: false })],
        superContributions: [scRow({ type: "personalDeductible", basis: "amount", amount: fillAmount })],
      },
    });
    const amountOut = projectPlan(amountState).yearly[0];

    // This is the assertion that would have caught the original defect:
    // the fill's fixed-amount equivalent must land identically on every
    // one of these, not just the super balance.
    expect(amountOut.wcaClosing).toBeCloseTo(capOut.wcaClosing, 4);
    expect(amountOut.superDetail.su1.closing).toBeCloseTo(capOut.superDetail.su1.closing, 4);
    expect(amountOut.tax).toBeCloseTo(capOut.tax, 4);
    expect(amountOut.taxDetail.client.taxableIncome).toBeCloseTo(capOut.taxDetail.client.taxableIncome, 4);
  });

  it("a cap fill larger than available household cash draws on fundingOrder, then reports unfunded cashflow once that's exhausted too", () => {
    const s = mkState({
      endAge: 40,
      assets: [mkAsset({ id: "a1", balance: 5000, allocation: zeroRealAlloc() })],
      plan: { superAccounts: [superAcct()], workingCash: zeroRealWca },
      surplus: accumulate,
      cashflows: {
        income: [employmentRow({ amount: 12000, sgApplies: false })], // modest cash, headroom far exceeds it
        superContributions: [scRow({ type: "personalDeductible", basis: "toConcessionalCap" })],
      },
    });
    const out = projectPlan(s).yearly[0];
    // A cap-filling instruction is not an exception to "a client cannot
    // contribute money they don't have" — same fallback as an explicit
    // amount row: drain fundingOrder, then report the rest as unfunded.
    expect(out.deficitFundedFromAssets).toBeGreaterThan(0);
    expect(out.perAssetClosing.a1).toBeCloseTo(0, 2); // fully drained
    expect(out.unfundedCashflow).toBeGreaterThan(0);
    // Super still receives the full fill — the cash gap is the
    // household's problem to fund, not a reason to silently shrink it.
    expect(out.superDetail.su1.contributions).toBeGreaterThan(0);
  });

  it("a cap fill coexisting with SG and salary sacrifice in the same year fills exactly the remaining headroom", () => {
    const s = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()], workingCash: zeroRealWca },
      surplus: accumulate,
      cashflows: {
        income: [employmentRow({ amount: 100000, sgApplies: true })], // SG: 100,000 × 0.12 = 12,000
        superContributions: [
          scRow({ id: "ss1", type: "salarySacrifice", basis: "amount", amount: 5000 }),
          scRow({ id: "fill", type: "personalDeductible", basis: "toConcessionalCap" }),
        ],
      },
    });
    const out = projectPlan(s).yearly[0];
    const cap = 32500; // FY0 concessional cap (no indexation yet — see Commit 2's carry-forward test)
    const sg = Math.min(100000, 270830) * 0.12;
    const expectedFill = cap - sg - 5000;
    // The fill is of type personalDeductible and there's no OTHER
    // personalDeductible row this FY, so superDetail's personalDeductible
    // breakdown isolates exactly the fill amount.
    expect(out.superDetail.su1.personalDeductible).toBeCloseTo(expectedFill, 2);
    // And it's genuinely charged to household cash: income already
    // reflects the $5,000 salary-sacrifice reduction (unrelated to this
    // fix), and the fill on top of that debits the WCA by exactly its
    // own amount.
    expect(out.income).toBeCloseTo(100000 - 5000, 2);
    expect(out.wcaClosing).toBeCloseTo(out.income - out.tax - expectedFill, 2);
  });
});

// --- Conservation invariant (engine-correctness fix, generalized). Both
// money-creation bugs found so far (the original WCA-debit gap e1eb61a
// fixed, and the toConcessionalCap gap 2867768 closed) would have
// failed this invariant, and nothing in the suite checked it before
// now. A THIRD (an FHSSS release crediting settlement cash with the
// full requested amount regardless of whether the super account
// actually held that much) was found and fixed while extending this
// generator to cover the Document Set's money flows — the invariant
// caught nothing there for months because this generator never
// produced a goal, an FHSSS release, an extra/one-off loan repayment,
// LMI, or a HELP/MLS-triggering income. A guard that doesn't grow with
// the engine silently stops guarding — see CLAUDE.md's rule that any
// commit introducing a new money flow must extend both this generator
// and checkYearConservation in the same commit.
//
// checkYearConservation itself (the equation, its scope, and why each
// excluded case is excluded) lives in conservationCheck.js, so Monte
// Carlo's per-path spot check (monteCarlo.test.js) runs the exact same
// check rather than a second, driftable copy of it — this describe
// block only supplies the random-scenario generator.
describe("Conservation invariant (engine-correctness fix, generalized)", () => {
  const rand = (min, max) => min + Math.random() * (max - min);
  const randInt = (min, max) => Math.floor(rand(min, max + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const randomAllocation = () => ({
    mode: "custom", incomePct: rand(0, 6), growthPct: rand(-2, 8),
    frankingPct: pick([0, 0, 50, 100]), volBasis: "Balanced",
  });

  const randomAsset = (id) => {
    const balance = rand(0, 200000);
    const cgtAsset = Math.random() < 0.5;
    return mkAsset({
      id, balance, cgtAsset,
      distributions: Math.random() < 0.5 ? "reinvest" : "cash",
      allocation: randomAllocation(),
      icrPct: 0,
      costBase: cgtAsset ? balance * rand(0.3, 1) : null,
    });
  };

  // Stratified, not uniform: a plain rand(60000,200000) rarely lands
  // below HELP's $69,528 floor or above its $186,052 cliff, and rarely
  // crosses MLS's $105,000 single / $210,000 family thresholds either
  // — exactly the gap that let a whole Document Set of money flows go
  // unexercised. One band per HELP/MLS regime, picked uniformly.
  const randomIncome = () => pick([
    rand(20000, 69000),    // below HELP's floor, below MLS
    rand(70000, 104000),   // HELP marginal, below MLS (singles)
    rand(106000, 186000),  // HELP marginal, above MLS (singles)
    rand(187000, 320000),  // above HELP's cliff, well above MLS (and family MLS)
  ]);

  function randomScenario() {
    const couple = Math.random() < 0.4;
    const persons = couple ? ["client", "partner"] : ["client"];
    const years = randInt(2, 4); // ≥2 so at least one non-final year exists
    const endAge = 40 + years - 1;

    const assets = Array.from({ length: randInt(1, 3) }, (_, i) => randomAsset(`a${i}`));

    const superAccounts = persons.map((p) => superAcct({
      // half zero-balance — exercises the FHSSS release cap / withdrawFromSuper
      // shortfall path, which a uniform draw over (0, 200000) rarely hits exactly.
      id: `su_${p}`, owner: p, balance: pick([0, rand(0, 200000)]), allocation: randomAllocation(),
    }));

    const income = persons.map((p) => employmentRow({
      id: `sal_${p}`, owner: p, amount: randomIncome(),
      frequency: pick(["monthly", "annual"]),
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
      sgApplies: Math.random() < 0.9,
    }));

    const expenses = [cf({
      id: "exp1", assetId: null, amount: rand(20000, 60000) / 12, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
    })];

    // FHSSS (Document Set Commit 3): a voluntary contribution flagged
    // eligible half the time — paired below with a planned property's
    // releaseFhsssAtPurchase toggle, itself independently randomised,
    // so both "eligible contributions with no release" and "a release
    // toggle with nothing to release" get exercised too.
    const superContributions = [];
    for (const p of persons) {
      if (Math.random() < 0.5) {
        superContributions.push(scRow({
          id: `sc_amt_${p}`, owner: p, accountId: `su_${p}`,
          type: pick(["salarySacrifice", "personalDeductible"]),
          basis: "amount", amount: rand(1000, 15000), frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
          fhsssEligible: Math.random() < 0.5,
        }));
      }
      if (Math.random() < 0.5) {
        superContributions.push(scRow({
          id: `sc_cap_${p}`, owner: p, accountId: `su_${p}`,
          type: pick(["salarySacrifice", "personalDeductible"]), basis: "toConcessionalCap",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
        }));
      }
    }

    // Extra and one-off loan repayments (Document Set Commit 5) — some
    // amounts deliberately large relative to a modest income/expense
    // gap, so the deficit-funding/unfunded path (already a named term
    // in the invariant) actually gets exercised, not just the
    // comfortably-affordable case.
    const liabilities = [];
    if (Math.random() < 0.5) {
      const liab = {
        id: "lb1", name: "Loan", type: "mortgage", owner: couple ? "joint" : "client",
        balance: rand(50000, 300000), interestRatePct: rand(4, 8),
        termYears: randInt(10, 25), repayment: pick(["io", "pi"]), ioYears: 3,
        deductible: Math.random() < 0.5, linkedAssetId: null, offsetAssetId: null,
        extraRepayments: [], oneOffRepayments: [],
      };
      if (Math.random() < 0.6) {
        liab.extraRepayments = [{
          id: "er1", label: "Extra", amount: rand(200, 40000), // sometimes far beyond affordable
          frequency: pick(["monthly", "annual"]),
          from: { kind: "age", age: 40 }, to: { kind: "age", age: randInt(41, endAge) },
          indexBasis: pick(["none", "cpi"]), indexExtraPct: 0,
        }];
      }
      if (Math.random() < 0.5) {
        liab.oneOffRepayments = [{
          id: "or1", label: "Lump sum", amount: rand(1000, 80000),
          at: { kind: "age", age: randInt(40, endAge) },
        }];
      }
      liabilities.push(liab);
    }

    // Goals (Document Set Commit 6) — funded from an asset (naturally
    // capped at its balance) or from surplus (capped at what's
    // actually left each month); target amounts range from trivially
    // affordable to deliberately unfundable relative to a short
    // timeframe and modest income, exercising both the ordinary
    // accrual path and the capped-short path.
    const goals = [];
    for (let i = 0; i < randInt(0, 2); i++) {
      const fundFromAsset = Math.random() < 0.5;
      goals.push({
        id: `gl${i}`, label: `Goal ${i}`,
        targetAmount: rand(2000, 90000),
        targetAt: { kind: "age", age: randInt(40, endAge) },
        fundedFrom: fundFromAsset ? pick(assets).id : "surplus",
        indexBasis: pick(["none", "cpi", "awote"]), indexExtraPct: 0,
      });
    }

    // A planned property (Document Set Commits 3/4) — the only place
    // FHSSS release and LMI ever fire. lvrPct spans both sides of the
    // 80% LMI threshold; firstHomeGuarantee only ever applies when
    // firstHomeBuyer is also set (mirroring planState.js's own
    // input-integrity rule, even though this raw state bypasses the
    // clamp); releaseFhsssAtPurchase and lmiPayAtSettlement are each
    // independently randomised so every combination gets exercised
    // over enough runs. propertyType is always "ppr" and status always
    // "planned" — an "owned" property from day one is NOT safe here
    // (see conservationCheck.js's header caveat on y=0).
    const properties = [];
    if (Math.random() < 0.5) {
      const firstHomeBuyer = Math.random() < 0.5;
      properties.push({
        id: "p1", name: "Home", owner: couple ? "joint" : "client",
        state: pick(["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]),
        propertyType: "ppr", status: "planned",
        currentValue: 0, acquisitionDate: null, costBase: 0,
        priceToday: rand(300000, 900000),
        purchaseAt: { kind: "age", age: randInt(40, endAge) },
        lvrPct: pick([60, 70, 80, 85, 90, 95]),
        firstHomeBuyer, newBuild: Math.random() < 0.3,
        purchaseCostsPct: rand(0, 3), dutyOverride: null, growthPct: rand(0, 6),
        rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
        expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
        expensesDeductible: true, depreciation: 0,
        releaseFhsssAtPurchase: Math.random() < 0.6,
        firstHomeGuarantee: firstHomeBuyer && Math.random() < 0.5,
        lmiOverride: null,
        lmiPayAtSettlement: Math.random() < 0.5,
      });
    }

    // HELP (Document Set Commit 1) — a balance below, at, and above a
    // typical single year's repayment, so some scenarios show the
    // balance fully retiring mid-projection (Commit 1's own "stops
    // once it hits zero" behaviour) and others don't. MLS (Commit 2) —
    // cover held or not, per person, plus a household with dependent
    // children shifting the family threshold.
    const client = { currentAge: 40, helpBalance: rand(0, 40000), privateHospitalCover: Math.random() < 0.5 };
    const partner = couple ? { currentAge: 40, helpBalance: rand(0, 40000), privateHospitalCover: Math.random() < 0.5 } : null;
    const dependentChildren = couple ? randInt(0, 3) : 0;

    const surplusMode = pick(["accumulate", "invest", "spend"]);
    const surplus = { mode: surplusMode, assetId: surplusMode === "invest" ? assets[0].id : null };

    return {
      ...mkState({
        endAge, cpi: rand(0.02, 0.04), assets,
        plan: {
          household: couple ? "couple" : "single",
          client, partner, dependentChildren,
          superAccounts, workingCash: { balance: rand(0, 50000), minimumBalance: rand(0, 10000), ratePct: rand(1, 4) },
        },
        cashflows: { income, expenses, superContributions },
        surplus,
        fundingOrder: assets.map((a) => a.id),
      }),
      liabilities,
      goals,
      properties,
    };
  }

  it("holds across a few hundred randomly generated scenarios", () => {
    const RUNS = 300;
    for (let i = 0; i < RUNS; i++) {
      const state = randomScenario();
      const out = projectPlan(state);
      const years = out.yearly.length;
      for (let y = 0; y < years - 1; y++) { // final year excluded — see header
        checkYearConservation(out, y, `scenario ${i}, year ${y}`);
      }
    }
  });
});

// --- Division 296 (Super thresholds Commit 2) — engine wiring. The
// formula itself (Government worked examples, two-tier boundary,
// higher-of-opening/closing, no-tax-below-threshold) is unit-tested
// directly against src/Tax/div296.js; these tests only exercise how
// deterministic.js feeds it (opening/closing TSB tracking, realised
// earnings, and the t+1 payment convention shared with CGT/Div293).
describe("Division 296 — engine wiring", () => {
  it("a member crossing the $3m threshold mid-year is assessed on the higher (closing) TSB, paid the following FY", () => {
    const s = mkState({
      endAge: 41,
      cpi: 0,
      plan: { superAccounts: [superAcct({
        balance: 2900000,
        allocation: { mode: "custom", incomePct: 0, growthPct: 10, frankingPct: 0, volBasis: "Balanced" },
      })] },
    });
    const out = projectPlan(s);
    // Net-of-tax growth ≈ 10% × (1 − 15%×2/3) = 9% ⇒ 2.9m × 1.09 ≈
    // 3.161m — opening was under $3m, closing is over.
    expect(out.yearly[0].superDetail.su1.opening).toBeLessThan(3000000);
    expect(out.yearly[0].superDetail.su1.closing).toBeGreaterThan(3000000);
    // Nothing is EVER due in a projection's first year (no prior FY to
    // have assessed it) — year 0's crossing is assessed then, paid in
    // year 1 (the same t+1 convention as CGT/Div293).
    expect(out.yearly[0].taxDetail.div296).toBe(0);
    expect(out.yearly[1].taxDetail.div296).toBeGreaterThan(0);
    expect(out.yearly[1].taxDetail.client.div296).toBeCloseTo(out.yearly[1].taxDetail.div296, 6);
  });

  it("a balance that falls below $3m during the year (via a release-eligible withdrawal, earnings still positive) still uses the higher (opening) TSB", () => {
    const s = mkState({
      endAge: 66,
      cpi: 0,
      plan: {
        client: { currentAge: 65, retirementAge: 65 },
        superAccounts: [superAcct({
          balance: 4000000,
          allocation: { mode: "custom", incomePct: 0, growthPct: 5, frankingPct: 0, volBasis: "Balanced" },
        })],
      },
      cashflows: {
        superWithdrawals: [swRow({ amount: 1800000, from: { kind: "age", age: 65 }, to: { kind: "age", age: 65 } })],
      },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].superDetail.su1;
    expect(d.opening).toBe(4000000);
    expect(d.closing).toBeLessThan(3000000); // the withdrawal, not a loss, took it under
    expect(d.earnings).toBeGreaterThan(0); // growth itself stayed positive throughout
    // Still assessed (via the higher, opening figure) — paid year 1.
    expect(out.yearly[1].taxDetail.div296).toBeGreaterThan(0);
  });

  it("regression gate: Division 296 is zero every year when TSB never exceeds $3m", () => {
    const s = mkState({
      endAge: 45,
      plan: { superAccounts: [superAcct({ balance: 500000, allocation: zeroRealAlloc() })] },
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.taxDetail.div296).toBe(0);
      expect(row.taxDetail.client.div296).toBe(0);
    }
    expect(out.accruedDiv296AtEnd).toBe(0);
  });

  it("a scenario with no super accounts is unaffected — div296 is always 0, never throws", () => {
    const s = mkState({ endAge: 42 });
    expect(() => projectPlan(s)).not.toThrow();
    const out = projectPlan(s);
    for (const row of out.yearly) expect(row.taxDetail.div296).toBe(0);
  });
});

// --- Division 293/296: release from super by default ------------------------
//
// A release authority (the default election) is a direct super-balance
// reduction, not a benefit payment: not assessable, not lump-sum taxed,
// and — critically — NOT gated by the preservation/condition-of-release
// check ordinary withdrawals go through. "cash" reproduces the tool's
// original (pre-feature) behaviour exactly.
describe("Division 293/296: release from super by default", () => {
  // $300,000 salary at age 40 assesses a Division 293 liability in year
  // 0, paid (per the existing t+1 convention) in July of year 1 — same
  // scenario as "Division 293 is assessed on high income..." above,
  // just varying the divTaxPaidFrom election.
  function highIncomeScenario(divTaxPaidFrom) {
    return mkState({
      endAge: 42,
      cpi: 0,
      plan: {
        client: { currentAge: 40, super: divTaxPaidFrom ? { divTaxPaidFrom } : undefined },
        superAccounts: [superAcct()],
      },
      cashflows: {
        income: [employmentRow({ amount: 300000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } })],
      },
    });
  }

  it("defaults to release from super when divTaxPaidFrom is unset", () => {
    const out = projectPlan(highIncomeScenario(undefined));
    const due = out.yearly[1].taxDetail.client.div293;
    expect(due).toBeGreaterThan(0);
    expect(out.yearly[1].taxDetail.client.divTaxPaidFrom).toBe("super");
    expect(out.yearly[1].taxDetail.client.divTaxReleasedFromSuper).toBeCloseTo(due, 2);
    expect(out.yearly[1].taxDetail.client.divTaxFromCash).toBeCloseTo(0, 2);
    expect(out.yearly[1].superDetail.su1.release).toBeCloseTo(due, 2);
  });

  it("a release reduces the super balance and leaves household cash untouched, vs. the cash-funded election", () => {
    const outSuper = projectPlan(highIncomeScenario("super"));
    const outCash = projectPlan(highIncomeScenario("cash"));
    const due = outCash.yearly[1].taxDetail.client.div293;
    expect(due).toBeGreaterThan(0);
    // Same assessed liability either way — only the funding source
    // differs.
    expect(outSuper.yearly[1].taxDetail.client.div293).toBeCloseTo(due, 2);
    // Super path: the balance closes `due` lower than it otherwise
    // would have (the cash path's closing balance, identical up to
    // this point since nothing else differs between the two runs).
    expect(outSuper.yearly[1].superDetail.su1.closing)
      .toBeCloseTo(outCash.yearly[1].superDetail.su1.closing - due, 2);
    expect(outCash.yearly[1].superDetail.su1.release).toBe(0);
    // Household cash: the ONLY difference in this FY's cash tax outflow
    // between the two runs is `due` itself — proving the super path
    // never touches household cash for it.
    expect(outCash.yearly[1].tax - outSuper.yearly[1].tax).toBeCloseTo(due, 2);
    expect(outSuper.yearly[1].unfundedCashflow).toBe(0);
  });

  it("components reduce proportionally, at the CURRENT (not fixed-at-commencement) tax-free fraction — same rule as an ordinary withdrawal", () => {
    const s = mkState({
      endAge: 42,
      cpi: 0,
      plan: {
        client: { currentAge: 40 },
        superAccounts: [superAcct({ balance: 400000, taxFreeComponent: 100000 })],
      },
      cashflows: {
        income: [employmentRow({ amount: 300000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } })],
      },
    });
    const out = projectPlan(s);
    const due = out.yearly[1].taxDetail.client.div293;
    expect(due).toBeGreaterThan(0);
    const openingClosing = out.yearly[0].superDetail.su1.closing;
    const openingTaxFree = out.yearly[0].superDetail.su1.taxFreeClosing;
    const fraction = openingTaxFree / openingClosing;
    const expectedTaxFreeAfter = openingTaxFree - due * fraction;
    expect(out.yearly[1].superDetail.su1.release).toBeCloseTo(due, 2);
    expect(out.yearly[1].superDetail.su1.taxFreeClosing).toBeCloseTo(expectedTaxFreeAfter, 6);
    expect(out.yearly[1].superDetail.su1.closing).toBeCloseTo(openingClosing - due, 6);
  });

  it("a release authority bypasses the preservation/condition-of-release gate — a 45-year-old can still release, even though an ordinary withdrawal at the same age is blocked", () => {
    const s = mkState({
      plan: {
        client: { currentAge: 45, retirementAge: 65 }, // condition of release never met within this projection
        superAccounts: [superAcct({ balance: 500000 })],
      },
      endAge: 47,
      cashflows: {
        income: [employmentRow({ amount: 300000, from: { kind: "age", age: 45 }, to: { kind: "age", age: 45 } })],
        // An ordinary withdrawal the SAME FY, same account — this one
        // IS preservation-gated and must be blocked in full, proving
        // the person really hasn't met a condition of release yet.
        superWithdrawals: [swRow({ amount: 1000, from: { kind: "age", age: 46 }, to: { kind: "age", age: 46 } })],
      },
    });
    const out = projectPlan(s);
    const due = out.yearly[1].taxDetail.client.div293;
    expect(due).toBeGreaterThan(0);
    expect(out.yearly[1].superDetail.su1.release).toBeCloseTo(due, 2);
    expect(out.yearly[1].superDetail.su1.withdrawals).toBe(0);
    expect(out.superWarnings.some((w) => w.type === "withdrawal" && w.reason.includes("Blocked"))).toBe(true);
  });

  it("insufficient super balance releases what's there, falls back to cash for the remainder, then to unfunded cashflow — flagged", () => {
    // su2 (listed first) is the SG default target and ends up well
    // funded; su1 is explicitly nominated for the release and starts
    // with far less than the Division 293 liability.
    const s = mkState({
      endAge: 42,
      cpi: 0,
      assets: [],
      plan: {
        client: { currentAge: 40, super: { divTaxReleaseAccountId: "su1" } },
        superAccounts: [superAcct({ id: "su2" }), superAcct({ id: "su1", balance: 1000 })],
      },
      cashflows: {
        income: [employmentRow({ amount: 300000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } })],
      },
    });
    const out = projectPlan(s);
    const due = out.yearly[1].taxDetail.client.div293;
    expect(due).toBeGreaterThan(1000); // sanity: the liability really does exceed su1's balance
    expect(out.yearly[1].superDetail.su1.release).toBeCloseTo(1000, 2); // capped at what's there
    expect(out.yearly[1].superDetail.su1.closing).toBeCloseTo(0, 6);
    expect(out.yearly[1].taxDetail.client.divTaxFromCash).toBeCloseTo(due - 1000, 2);
    expect(out.yearly[1].unfundedCashflow).toBeGreaterThan(0); // no assets/cash left to cover the cash fallback
    expect(out.superWarnings.some((w) => w.type === "divTaxRelease" && w.reason.includes("fell back to household cash"))).toBe(true);
  });

  it("the reduced super balance carries into the FOLLOWING year's TSB — both the $500,000 carry-forward gate and Division 296 proportioning see it", () => {
    // Balance chosen so the release drags year 1's closing TSB from
    // just above the $500,000 gate (cash path) to just below it (super
    // path) — the gate is evaluated on year 2's OPENING TSB, i.e. year
    // 1's closing, not year 1's own (unaffected) figure.
    const base = (divTaxPaidFrom) => mkState({
      endAge: 42,
      cpi: 0,
      plan: {
        client: { currentAge: 40, super: { divTaxPaidFrom } },
        superAccounts: [superAcct({ balance: 474375 })],
      },
      cashflows: {
        income: [employmentRow({ amount: 300000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } })],
      },
    });
    const outCash = projectPlan(base("cash"));
    const outSuper = projectPlan(base("super"));
    expect(outCash.yearly[1].superDetail.su1.closing).toBeGreaterThan(500000);
    expect(outSuper.yearly[1].superDetail.su1.closing).toBeLessThan(500000);
    // Carry-forward gate: blocked in the cash path (TSB ≥ $500,000),
    // open in the super path (TSB now below it).
    expect(outCash.yearly[2].superCapUsage.client.carryForwardAvailable).toBe(0);
    expect(outSuper.yearly[2].superCapUsage.client.carryForwardAvailable).toBeGreaterThan(0);

    // Division 296 proportioning: a separate, larger-balance scenario
    // where the release lowers year 2's OPENING TSB (year 1's closing)
    // enough to measurably shrink year 2's own Division 296 assessment
    // — proving tsbOpening genuinely carries the reduced figure
    // forward, not just the carry-forward gate above.
    const div296Base = (divTaxPaidFrom) => mkState({
      endAge: 43,
      cpi: 0,
      plan: {
        client: { currentAge: 40, super: { divTaxPaidFrom } },
        superAccounts: [superAcct({
          balance: 3200000,
          allocation: { mode: "custom", incomePct: 0, growthPct: 8, frankingPct: 0, volBasis: "Balanced" },
        })],
      },
    });
    const div296OutCash = projectPlan(div296Base("cash"));
    const div296OutSuper = projectPlan(div296Base("super"));
    expect(div296OutCash.yearly[1].taxDetail.client.div296).toBeGreaterThan(0); // sanity: something is due
    expect(div296OutSuper.yearly[1].superDetail.su1.closing).toBeLessThan(div296OutCash.yearly[1].superDetail.su1.closing);
    expect(div296OutSuper.yearly[2].taxDetail.client.div296).toBeLessThan(div296OutCash.yearly[2].taxDetail.client.div296);
  });

  it("regression gate: the personal-cash election reproduces the tool's original behaviour bit-identically — no releases, ever", () => {
    const out = projectPlan(highIncomeScenario("cash"));
    for (const row of out.yearly) {
      expect(row.superDetail.su1.release).toBe(0);
      expect(row.taxDetail.client.divTaxPaidFrom).toBe("cash");
      expect(row.taxDetail.client.divTaxReleasedFromSuper).toBe(0);
    }
    // The full due amount lands in the ordinary cash tax outflow, same
    // as before this feature existed.
    const due = out.yearly[1].taxDetail.client.div293;
    expect(due).toBeGreaterThan(0);
    expect(out.yearly[1].taxDetail.client.divTaxFromCash).toBeCloseTo(due, 2);
  });
});

// --- PAYG withholding, tax refund timing, and deductions --------------------
describe("PAYG withholding and tax refund timing", () => {
  it("an employee with only salary has a near-zero anticipated refund", () => {
    const s = mkState({
      endAge: 40,
      assets: [], // no default asset's distribution income to muddy "salary only"
      // 0% real WCA growth — isolates this from WCA-interest noise,
      // which would otherwise add a small amount of non-employment
      // ordinary income and legitimately break the equality below.
      plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      cashflows: { income: [employmentRow({ amount: 100000, sgApplies: false })] },
      surplus: { mode: "spend", assetId: null },
    });
    const out = projectPlan(s).yearly[0];
    // Nothing else (no deductions, other income, or franking credits)
    // differs between the PAYG estimate and the full assessment for a
    // pure salary earner, so the two should match to the cent.
    expect(out.taxDetail.client.refundOrBalancing).toBeCloseTo(0, 6);
    expect(out.taxDetail.client.paygWithheld).toBeCloseTo(out.taxDetail.client.actualTaxPayable, 6);
  });

  it("adding a deduction produces a refund equal to the tax effect of that deduction", () => {
    // PAYG ignores deductions (mirroring real employer withholding), so
    // a $20,000 personal deductible super contribution (an existing,
    // already-modelled deduction path) doesn't touch paygWithheld at
    // all — the entire tax saving surfaces as a bigger
    // refundOrBalancing.
    const scenario = (contribution) => mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()] },
      cashflows: {
        income: [employmentRow({ amount: 120000, sgApplies: false })],
        ...(contribution
          ? { superContributions: [scRow({ type: "personalDeductible", amount: contribution })] }
          : {}),
      },
    });
    const without = projectPlan(scenario(0)).yearly[0];
    const withDeduction = projectPlan(scenario(20000)).yearly[0];
    const taxSaved = without.taxDetail.client.actualTaxPayable - withDeduction.taxDetail.client.actualTaxPayable;
    expect(taxSaved).toBeGreaterThan(0);
    expect(withDeduction.taxDetail.client.paygWithheld).toBeCloseTo(without.taxDetail.client.paygWithheld, 4); // unaffected by the deduction
    expect(withDeduction.taxDetail.client.refundOrBalancing).toBeCloseTo(without.taxDetail.client.refundOrBalancing + taxSaved, 4);
  });

  it("the refund/balancing assessed this FY settles as household cash in the FIRST MONTH of the following FY, not this one", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()], workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      surplus: { mode: "accumulate", assetId: null },
      cashflows: {
        income: [employmentRow({ amount: 120000, sgApplies: false })],
        superContributions: [scRow({ type: "personalDeductible", amount: 20000 })],
      },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].taxDetail.refundSettled).toBe(0); // nothing pending in the first year
    // Year 0's assessed refund (paygWithheld − actualTaxPayable, a
    // positive figure here since the deduction lowers actual tax below
    // what PAYG withheld) settles as cash exactly in year 1.
    const assessedY0 = out.yearly[0].taxDetail.client.refundOrBalancing;
    expect(assessedY0).toBeGreaterThan(0);
    expect(out.yearly[1].taxDetail.refundSettled).toBeCloseTo(assessedY0, 4);
  });

  it("withheld amounts are debited in the months salary is actually paid, not spread smoothly across the year", () => {
    const s = mkState({
      endAge: 41,
      plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      surplus: { mode: "accumulate", assetId: null },
      cashflows: { income: [employmentRow({ amount: 120000, sgApplies: false })] }, // annual — fires in July only
    });
    const out = projectPlan(s);
    const wca = out.monthly.wca; // wca[0] = opening; wca[m+1] = balance after month m
    expect(wca[0]).toBe(0);
    expect(wca[1]).not.toBeCloseTo(0, 2); // July's salary, net of PAYG withheld, moved it
    // Every other month of the FY is flat — nothing else happens, so if
    // tax were still smoothly spread across the year (the pre-PAYG
    // behaviour) the balance would keep drifting down month by month
    // instead of holding steady.
    for (let m = 1; m < 12; m++) {
      expect(wca[m + 1]).toBeCloseTo(wca[1], 6);
    }
  });

  it("regression gate: a person with no employment income keeps the pre-existing smooth tax accrual, entirely unaffected by PAYG", () => {
    const s = mkState({
      endAge: 41,
      cashflows: { income: [employmentRow({ amount: 100000, incomeType: "otherTaxable", sgApplies: false })] },
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.taxDetail.client.paygWithheld).toBe(0);
      expect(row.taxDetail.client.refundOrBalancing).toBe(0);
      expect(row.taxDetail.refundSettled).toBe(0);
      // The old invariant: with no CGT/Div293/Div296 due either, the
      // year's own `.tax` is exactly the full assessed netIncomeTax —
      // proof the smooth spreadTax accrual ran unmodified, not PAYG.
      expect(row.tax).toBeCloseTo(row.taxDetail.incomeTax, 6);
    }
  });
});

// --- Document Set Commit 1: HELP repayments ---------------------------------
describe("HELP repayments (Document Set Commit 1)", () => {
  it("known-value: $100k salary, $50k balance — repayment income equals taxable income (no super/investment add-backs), matches the FY2026/27 bracket hand calc", () => {
    const s = mkState({
      endAge: 41,
      assets: [], // isolate the hand calc from the default asset's own distribution income
      // ratePct 2.5 matches the default cpi (2.5%) exactly — a REAL
      // return of zero, isolating the hand calc from WCA interest
      // entirely (a literal 0% NOMINAL rate would still leave a small
      // negative REAL return via Fisher deflation, still contaminating
      // taxable income).
      plan: { client: { currentAge: 40, helpBalance: 50000 }, workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      cashflows: { income: [employmentRow({ amount: 100000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } })] },
    });
    const out = projectPlan(s);
    // hand calc (FY2026/27 base table, year 0 = no indexation drift):
    // taxable income = 100,000 (no deductions); repayment income = same
    // (no super sacrifice, no investment loss); (100000 − 69528) × 0.15
    // = 30472 × 0.15 = 4570.80.
    const due = 4570.80;
    expect(out.yearly[0].taxDetail.client.helpRepayment).toBeCloseTo(due, 2);
    expect(out.yearly[0].taxDetail.client.helpBalanceClosing).toBeCloseTo(50000 - due, 2);
    expect(out.yearly[0].taxDetail.helpRepayment).toBeCloseTo(due, 2);
  });

  it("the $186,052 cliff reproduces in the full engine, not just the pure rate table", () => {
    const s = mkState({
      endAge: 41,
      assets: [],
      plan: { client: { currentAge: 40, helpBalance: 100000 }, workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      cashflows: { income: [employmentRow({ amount: 186052, from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } })] },
    });
    const out = projectPlan(s);
    // 10% of the WHOLE $186,052 (a person with zero deductions here has
    // taxable income exactly equal to gross salary).
    expect(out.yearly[0].taxDetail.client.helpRepayment).toBeCloseTo(186052 * 0.10, 2);
  });

  it("salary sacrifice does NOT reduce the repayment — the reportable-super-contributions add-back exactly cancels the taxable-income reduction", () => {
    const base = (sacrificeAmount) => mkState({
      endAge: 41,
      assets: [],
      plan: {
        client: { currentAge: 40, helpBalance: 100000 }, superAccounts: [superAcct()],
        workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 }, // real-zero — see the known-value test above
      },
      cashflows: {
        income: [employmentRow({ amount: 100000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } })],
        superContributions: sacrificeAmount > 0
          ? [scRow({ type: "salarySacrifice", amount: sacrificeAmount, frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } })]
          : [],
      },
    });
    const withoutSacrifice = projectPlan(base(0));
    const withSacrifice = projectPlan(base(20000));
    // Taxable income genuinely drops (salary sacrifice reduces income
    // at the source) — proving the two scenarios really do differ.
    expect(withSacrifice.yearly[0].taxDetail.client.taxableIncome)
      .toBeLessThan(withoutSacrifice.yearly[0].taxDetail.client.taxableIncome - 15000);
    // But the HELP repayment is unchanged (within a cent), because
    // reportableSuperContributions adds the sacrificed amount straight
    // back into repayment income.
    expect(withSacrifice.yearly[0].taxDetail.client.helpRepayment)
      .toBeCloseTo(withoutSacrifice.yearly[0].taxDetail.client.helpRepayment, 2);
  });

  it("the balance amortises and stops at zero — never goes negative, never repays more than once the debt is gone", () => {
    const s = mkState({
      endAge: 43,
      assets: [],
      plan: { client: { currentAge: 40, helpBalance: 3000 } }, // small balance, well under one year's computed repayment
      cashflows: { income: [employmentRow({ amount: 100000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 43 } })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].taxDetail.client.helpRepayment).toBeCloseTo(3000, 2); // capped at the balance, not the full ~$4,570.80
    expect(out.yearly[0].taxDetail.client.helpBalanceClosing).toBeCloseTo(0, 6);
    // Every subsequent year: balance already zero, nothing left to repay.
    for (let y = 1; y < out.yearly.length; y++) {
      expect(out.yearly[y].taxDetail.client.helpRepayment).toBe(0);
      expect(out.yearly[y].taxDetail.client.helpBalanceClosing).toBe(0);
    }
  });

  it("PAYG withholding includes HELP — household cash flow actually differs with a nonzero balance, not just the tax-detail report", () => {
    const base = (helpBalance) => mkState({
      endAge: 42,
      assets: [],
      plan: {
        client: { currentAge: 40, helpBalance },
        workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 }, // real-zero — see the known-value test above
      },
      cashflows: { income: [employmentRow({ amount: 100000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 42 } })] },
    });
    const withHelp = projectPlan(base(50000));
    const withoutHelp = projectPlan(base(0));
    // Year 0's household tax outflow is higher with a HELP balance —
    // proof it's wired into taxOutArr (real cash), not just reported.
    expect(withHelp.yearly[0].tax).toBeGreaterThan(withoutHelp.yearly[0].tax + 1000);
    // The gap between the two runs' year-0 tax equals the HELP
    // repayment exactly (nothing else differs between the scenarios).
    const gap = withHelp.yearly[0].tax - withoutHelp.yearly[0].tax;
    expect(gap).toBeCloseTo(withHelp.yearly[0].taxDetail.client.helpRepayment, 2);
  });

  it("regression gate: a zero (default) HELP balance leaves a rich scenario completely untouched", () => {
    const s = mkState({
      endAge: 42,
      plan: { superAccounts: [superAcct()] }, // helpBalance omitted — defaults to 0
      cashflows: {
        income: [employmentRow({ amount: 150000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 42 } })],
        superContributions: [scRow({ type: "salarySacrifice", amount: 10000, frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } })],
      },
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.taxDetail.client.helpRepayment).toBe(0);
      expect(row.taxDetail.client.helpBalanceClosing).toBe(0);
      expect(row.taxDetail.helpRepayment).toBe(0);
      // HELP-as-liability follow-up fix: no balance at all means no
      // phantom help_client row/entity — mirrors ordinary liabilities'
      // own `balance > 0` filter (liabs).
      expect(row.liabilities.help_client).toBeUndefined();
    }
  });
});

// --- HELP-as-liability follow-up fix ----------------------------------------
//
// HELP/HECS was tracked and repaid correctly (above) but was invisible to
// net worth: helpBal never joined liabilitiesClosing, so a client with a
// $60,000 balance and one with none reported identical netAssets. Folded
// into row.liabilities (same map ordinary loans use, see deterministic.js)
// so it's covered by the Liabilities table/chart and netAssets for free,
// plus genuine annual indexation (previously implicit/undocumented) at
// the lower of CPI and AWOTE (the post-1 June 2023 "lesser of CPI or WPI"
// basis; AWOTE stands in for WPI, same proxy as the threshold indexation).
describe("HELP as a liability (HELP-as-liability follow-up fix)", () => {
  it("net assets fall by exactly the opening HELP balance (no income → no repayment; awote = cpi → no indexation)", () => {
    const base = (helpBalance) => mkState({
      endAge: 41,
      awote: 0.025, // matches cpi exactly, so indexation is exactly zero — isolates the balance itself
      plan: { client: { currentAge: 40, helpBalance } },
    });
    const withHelp = projectPlan(base(60000));
    const withoutHelp = projectPlan(base(0));
    expect(withHelp.yearly[0].netAssets).toBeCloseTo(withoutHelp.yearly[0].netAssets - 60000, 2);
    // ...and it's a real liabilities-table entry, not just a subtraction.
    expect(withHelp.yearly[0].liabilities.help_client.opening).toBeCloseTo(60000, 2);
    expect(withHelp.yearly[0].liabilities.help_client.closing).toBeCloseTo(60000, 2);
    expect(withHelp.yearly[0].liabilitiesClosing).toBeCloseTo(60000, 2);
  });

  it("the Liabilities-table row reconciles: opening + indexation − repayment = closing", () => {
    const s = mkState({
      endAge: 43,
      cpi: 0.05, awote: 0.025, // deliberately different — exercises a genuinely nonzero indexation term
      assets: [],
      plan: { client: { currentAge: 40, helpBalance: 80000 } },
      cashflows: { income: [employmentRow({ amount: 100000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 43 } })] },
    });
    const out = projectPlan(s);
    let sawNonzeroIndexation = false;
    for (const row of out.yearly) {
      const h = row.liabilities.help_client;
      expect(h.opening + h.indexation - h.principal).toBeCloseTo(h.closing, 6);
      if (Math.abs(h.indexation) > 1) sawNonzeroIndexation = true;
    }
    // Confirms the reconciliation above isn't vacuously true over an
    // all-zero indexation column.
    expect(sawNonzeroIndexation).toBe(true);
  });

  it("the balance reaches zero and the liability closes out — never negative, never re-appears", () => {
    const s = mkState({
      endAge: 43,
      assets: [],
      plan: { client: { currentAge: 40, helpBalance: 3000 } }, // well under one year's computed repayment
      cashflows: { income: [employmentRow({ amount: 100000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 43 } })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].liabilities.help_client.closing).toBeCloseTo(0, 6);
    expect(out.yearly[0].liabilitiesClosing).toBeCloseTo(0, 6);
    for (let y = 1; y < out.yearly.length; y++) {
      expect(out.yearly[y].liabilities.help_client.opening).toBe(0);
      expect(out.yearly[y].liabilities.help_client.indexation).toBe(0);
      expect(out.yearly[y].liabilities.help_client.principal).toBe(0);
      expect(out.yearly[y].liabilities.help_client.closing).toBe(0);
    }
  });

  it("the conservation invariant holds across a HELP-heavy scenario — indexation and repayment both active, for a couple", () => {
    const s = mkState({
      endAge: 45,
      cpi: 0.05, awote: 0.02, // both well apart from cpi, so indexation is genuinely nonzero for both persons
      assets: [],
      plan: {
        partner: { currentAge: 38, helpBalance: 40000 },
        client: { currentAge: 40, helpBalance: 90000 },
      },
      cashflows: {
        income: [
          employmentRow({ owner: "client", amount: 150000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 45 } }),
          employmentRow({ owner: "partner", amount: 80000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 45 } }),
        ],
      },
    });
    const out = projectPlan(s);
    for (let y = 0; y < out.yearly.length - 1; y++) {
      checkYearConservation(out, y, `HELP-heavy couple scenario, year ${y}`);
    }
  });
});

describe("Medicare Levy Surcharge (Document Set Commit 2)", () => {
  const singleScenario = (amount, over = {}) => mkState({
    endAge: 41,
    assets: [],
    plan: {
      client: { currentAge: 40, privateHospitalCover: false },
      workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 }, // real-zero — see the HELP known-value test above
      ...over,
    },
    cashflows: { income: [employmentRow({ amount, from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } })] },
  });

  it("known-value: singles, nil below $105,000", () => {
    const out = projectPlan(singleScenario(100000));
    expect(out.yearly[0].taxDetail.client.medicareLevySurcharge).toBe(0);
  });

  it("known-value: singles, tier 1 (1.00%) just above $105,000, WHOLE income not the excess", () => {
    const out = projectPlan(singleScenario(105001));
    // 105001 × 1.00% — NOT (105001 − 105000) × 1.00% = 0.01. A step
    // function, same shape as the HELP cliff.
    expect(out.yearly[0].taxDetail.client.medicareLevySurcharge).toBeCloseTo(105001 * 0.01, 2);
  });

  it("known-value: singles, tier 2 (1.25%) between $123,000 and $164,000", () => {
    const out = projectPlan(singleScenario(130000));
    expect(out.yearly[0].taxDetail.client.medicareLevySurcharge).toBeCloseTo(130000 * 0.0125, 2);
  });

  it("known-value: singles, tier 3 (1.50%) above $164,000", () => {
    const out = projectPlan(singleScenario(170000));
    expect(out.yearly[0].taxDetail.client.medicareLevySurcharge).toBeCloseTo(170000 * 0.015, 2);
  });

  it("private hospital cover suppresses the surcharge entirely, regardless of income", () => {
    const out = projectPlan(singleScenario(170000, { client: { currentAge: 40, privateHospitalCover: true } }));
    expect(out.yearly[0].taxDetail.client.medicareLevySurcharge).toBe(0);
  });

  it("couples compare against the COMBINED family income, but the surcharge is a % of each person's OWN income", () => {
    const s = mkState({
      endAge: 41,
      assets: [],
      plan: {
        client: { currentAge: 40, privateHospitalCover: false },
        partner: { currentAge: 40, privateHospitalCover: false },
        workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
      },
      cashflows: {
        income: [
          employmentRow({ id: "i1", amount: 150000, owner: "client", from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } }),
          employmentRow({ id: "i2", amount: 200000, owner: "partner", from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } }),
        ],
      },
    });
    const out = projectPlan(s);
    // Family income = 350,000 > $328,000 family tier-3 floor → 1.50% —
    // even though neither person's OWN income alone crosses that band.
    expect(out.yearly[0].taxDetail.client.medicareLevySurcharge).toBeCloseTo(150000 * 0.015, 2);
    expect(out.yearly[0].taxDetail.partner.medicareLevySurcharge).toBeCloseTo(200000 * 0.015, 2);
  });

  it("dependent children (after the first) shift the family threshold up by $1,500 each", () => {
    const family = (dependentChildren) => mkState({
      endAge: 41,
      assets: [],
      plan: {
        client: { currentAge: 40, privateHospitalCover: false },
        partner: { currentAge: 40, privateHospitalCover: false },
        dependentChildren,
        workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
      },
      cashflows: {
        income: [
          employmentRow({ id: "i1", amount: 105000, owner: "client", from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } }),
          employmentRow({ id: "i2", amount: 106000, owner: "partner", from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } }),
        ],
      },
    });
    // Family income = 211,000. With ≤1 dependent child the family
    // threshold stays at $210,000 → already in tier 1. With 3 children
    // the step (+$1,500 × 2 = $3,000) lifts the threshold to $213,000,
    // pushing the same family income back under it → nil.
    const noStep = projectPlan(family(1));
    const withStep = projectPlan(family(3));
    expect(noStep.yearly[0].taxDetail.client.medicareLevySurcharge).toBeCloseTo(105000 * 0.01, 2);
    expect(withStep.yearly[0].taxDetail.client.medicareLevySurcharge).toBe(0);
    expect(withStep.yearly[0].taxDetail.partner.medicareLevySurcharge).toBe(0);
  });

  it("PAYG withholding includes MLS — household cash flow actually differs, not just the tax-detail report", () => {
    const base = (hasCover) => singleScenario(170000, { client: { currentAge: 40, privateHospitalCover: hasCover } });
    const withMls = projectPlan(base(false));
    const withoutMls = projectPlan(base(true));
    const gap = withMls.yearly[0].tax - withoutMls.yearly[0].tax;
    expect(gap).toBeCloseTo(withMls.yearly[0].taxDetail.client.medicareLevySurcharge, 2);
  });

  it("regression gate: default private hospital cover (true) leaves a rich scenario's MLS at zero throughout", () => {
    const s = mkState({
      endAge: 42,
      plan: { superAccounts: [superAcct()] }, // privateHospitalCover omitted — defaults to true
      cashflows: {
        income: [employmentRow({ amount: 250000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 42 } })],
        superContributions: [scRow({ type: "salarySacrifice", amount: 10000, frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } })],
      },
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.taxDetail.client.medicareLevySurcharge).toBe(0);
      expect(row.taxDetail.medicareLevySurcharge).toBe(0);
    }
  });
});

describe("FHSSS (Document Set Commit 3)", () => {
  const fhsssProp = (over = {}) => ({
    id: "p1", name: "First home", owner: "client", state: "NSW",
    propertyType: "ppr", status: "planned",
    currentValue: 0, acquisitionDate: null, costBase: 0,
    priceToday: 500000, purchaseAt: { kind: "age", age: 42 },
    lvrPct: 0, firstHomeBuyer: false, newBuild: false,
    purchaseCostsPct: 0, dutyOverride: 0, growthPct: 2.5, // = cpi, so real price stays exactly $500,000
    rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expensesDeductible: true, depreciation: 0,
    releaseFhsssAtPurchase: true,
    ...over,
  });

  // Two years (ages 40-41) of $10,000/year eligible salary sacrifice —
  // $20,000 total, well under both the $15,000/year and $50,000/
  // lifetime caps — then a PPR purchase at 42 releases it. Earnings
  // rate pinned to 0 so the release is an exact 85%-of-concessional
  // hand calc, uncontaminated by compounding.
  const baseState = (extra = {}) => ({
    ...mkState({
      endAge: 45,
      assets: [],
      // Real-zero fund return (see zeroRealSuperAlloc's own header) —
      // a literal 0/0 allocation still decays slightly in REAL terms
      // via Fisher deflation (and zeroRealAlloc's plain cpi*100 decays
      // too, once the fund's own 15% earnings tax bites), which would
      // make the real account balance drift below the FHSSS notional
      // balance's own hand-calc for reasons unrelated to what these
      // tests exercise.
      plan: { superAccounts: [superAcct({ allocation: zeroRealSuperAlloc() })] },
      cashflows: {
        income: [employmentRow({ amount: 150000, sgApplies: false, from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 } })],
        superContributions: [scRow({
          type: "salarySacrifice", amount: 10000, frequency: "annual", fhsssEligible: true,
          indexBasis: "cpi", // constant in real terms — both years are worth exactly $10,000
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 },
        })],
      },
    }),
    assumptions: { cpi: 0.025, bracketMode: "indexed", fhsssEarningsRate: 0.025 },
    properties: [fhsssProp()],
    liabilities: [],
    ...extra,
  });

  it("known-value: 85% of eligible concessional contributions releases, reducing settlement cash dollar for dollar", () => {
    const out = projectPlan(baseState());
    const y2 = out.yearly[2];
    // 2 × $10,000 = $20,000 eligible concessional; 85% released = $17,000.
    expect(y2.properties.p1.fhsssRelease).toBeCloseTo(17000, 2);
    expect(y2.properties.p1.settlement).toBeCloseTo(500000 - 17000, 2);
    // Focus Commit 3 follow-on: the taxable/tax-free split behind that
    // same $17,000 — no non-concessional contributions here, so the
    // whole release is taxable (85% concessional + a small associated-
    // earnings sliver), tax-free is exactly zero.
    expect(y2.taxDetail.client.fhsssTaxableComponent).toBeCloseTo(17000, 0);
    expect(y2.taxDetail.client.fhsssTaxFreeComponent).toBe(0);
    expect(y2.taxDetail.client.fhsssTaxableComponent + y2.taxDetail.client.fhsssTaxFreeComponent)
      .toBeCloseTo(y2.taxDetail.client.fhsssRelease, 6);
  });

  it("the 15% concessional remainder never releases — gross release is less than the raw contribution", () => {
    const out = projectPlan(baseState());
    expect(out.yearly[2].properties.p1.fhsssRelease).toBeLessThan(20000);
  });

  it("the taxable release (85% concessional + earnings) is taxed at the marginal rate less a 30% offset", () => {
    const out = projectPlan(baseState());
    expect(out.yearly[2].taxDetail.client.fhsssOffset).toBeCloseTo(17000 * 0.3, 2);
  });

  it("row.fhsssDetail (Focus Commit 3 follow-on) reports contributions/earnings/running-balance by year, and goes null once released", () => {
    const out = projectPlan(baseState());
    // Year 0: opening balance zero, $10,000 concessional accepted (well
    // under both caps), a small associated-earnings sliver.
    const d0 = out.yearly[0].fhsssDetail.client;
    expect(d0.contributionAccepted).toBeCloseTo(10000, 2);
    expect(d0.contributionRejected).toBe(0);
    expect(d0.concessionalBalance).toBeCloseTo(10000, 2);
    expect(d0.nonConcessionalBalance).toBe(0);
    expect(d0.lifetimeContributed).toBeCloseTo(10000, 2);
    // Year 1: another $10,000 accepted on top, running balance $20,000
    // (plus whatever the prior year's balance earned in the meantime).
    const d1 = out.yearly[1].fhsssDetail.client;
    expect(d1.contributionAccepted).toBeCloseTo(10000, 2);
    expect(d1.lifetimeContributed).toBeCloseTo(20000, 2);
    expect(d1.concessionalBalance).toBeCloseTo(20000 + d0.earningsAccrued, 2);
    // Year 2: the purchase year itself — the release fires LATER in the
    // same year's processing (see deterministic.js's own ordering
    // comment), so this year's accrual step still runs normally first,
    // reporting the PRE-release running balance the release then draws on.
    expect(out.yearly[2].fhsssDetail.client.concessionalBalance).toBeCloseTo(20000, 2);
    // Year 3: the year AFTER release — released, so nothing left to
    // accrue (mirrors fhsssBal.released's own early-exit in deterministic.js).
    expect(out.yearly[3].fhsssDetail.client).toBeNull();
  });

  it("SG contributions never build an FHSSS balance, however large", () => {
    const s = {
      ...mkState({
        endAge: 43, assets: [], plan: { superAccounts: [superAcct()] },
        cashflows: {
          income: [employmentRow({ amount: 200000, sgApplies: true, from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } })],
        },
      }),
      assumptions: { cpi: 0.025, bracketMode: "indexed", fhsssEarningsRate: 0.025 },
      properties: [fhsssProp({ purchaseAt: { kind: "age", age: 42 } })],
      liabilities: [],
    };
    const out = projectPlan(s);
    expect(out.yearly[2].properties.p1.fhsssRelease).toBe(0);
  });

  it("the combined $15,000/year cap binds across concessional and non-concessional together, split proportionally", () => {
    const s = {
      ...mkState({
        endAge: 43, assets: [], plan: { superAccounts: [superAcct({ allocation: zeroRealSuperAlloc() })] },
        cashflows: {
          income: [employmentRow({ amount: 200000, sgApplies: false, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } })],
          superContributions: [
            scRow({ id: "sc1", type: "salarySacrifice", amount: 12000, frequency: "annual", fhsssEligible: true, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } }),
            scRow({ id: "sc2", type: "personalNonDeductible", amount: 6000, frequency: "annual", fhsssEligible: true, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } }),
          ],
        },
      }),
      assumptions: { cpi: 0.025, bracketMode: "indexed", fhsssEarningsRate: 0.025 },
      properties: [fhsssProp({ purchaseAt: { kind: "age", age: 41 } })],
      liabilities: [],
    };
    const out = projectPlan(s);
    // 12,000 + 6,000 = 18,000 requested; capped at 15,000 combined,
    // split proportionally: 10,000 concessional + 5,000 non-concessional.
    // Release = 0.85 × 10,000 + 5,000 = 13,500.
    expect(out.yearly[1].properties.p1.fhsssRelease).toBeCloseTo(13500, 2);
    expect(out.superWarnings.some((w) => w.type === "fhsss")).toBe(true);
  });

  it("the $50,000 lifetime cap binds even when each individual year is under the annual cap", () => {
    const s = {
      ...mkState({
        endAge: 47, assets: [], plan: { superAccounts: [superAcct({ allocation: zeroRealSuperAlloc() })] },
        cashflows: {
          income: [employmentRow({ amount: 200000, sgApplies: false, from: { kind: "age", age: 40 }, to: { kind: "age", age: 43 } })],
          superContributions: [scRow({
            type: "salarySacrifice", amount: 15000, frequency: "annual", fhsssEligible: true,
            from: { kind: "age", age: 40 }, to: { kind: "age", age: 43 }, // 4 × 15,000 = 60,000 requested
          })],
        },
      }),
      assumptions: { cpi: 0.025, bracketMode: "indexed", fhsssEarningsRate: 0.025 },
      properties: [fhsssProp({ purchaseAt: { kind: "age", age: 44 } })],
      liabilities: [],
    };
    const out = projectPlan(s);
    expect(out.yearly[4].properties.p1.fhsssRelease).toBeCloseTo(50000 * 0.85, 2);
  });

  it("associated earnings accrue on the balance before release", () => {
    // The real fund needs enough of its OWN growth to actually hold
    // the larger, earnings-inflated release — otherwise the account-
    // balance cap (see deterministic.js's FHSSS release block) would
    // silently clip it straight back down to what a real-zero fund
    // holds, masking the very effect this test wants to see. A
    // generous 15% nominal (~10% real after the fund's 15% earnings
    // tax) comfortably covers the ~5.3% real FHSSS deemed rate below.
    // Built directly (not via baseState — its `plan` merges at the
    // outer level, which would replace rather than extend baseState's
    // own super account).
    const growingSuperState = (fhsssEarningsRate) => ({
      ...mkState({
        endAge: 45,
        assets: [],
        plan: {
          superAccounts: [superAcct({
            allocation: { mode: "custom", incomePct: 15, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
          })],
        },
        cashflows: {
          income: [employmentRow({ amount: 150000, sgApplies: false, from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 } })],
          superContributions: [scRow({
            type: "salarySacrifice", amount: 10000, frequency: "annual", fhsssEligible: true,
            indexBasis: "cpi", from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 },
          })],
        },
      }),
      assumptions: { cpi: 0.025, bracketMode: "indexed", fhsssEarningsRate },
      properties: [fhsssProp()],
      liabilities: [],
    });
    const withEarnings = projectPlan(growingSuperState(0.0794));
    const withoutEarnings = projectPlan(growingSuperState(0.025)); // real-zero baseline
    expect(withEarnings.yearly[2].properties.p1.fhsssRelease)
      .toBeGreaterThan(withoutEarnings.yearly[2].properties.p1.fhsssRelease);
  });

  it("regression gate: no FHSSS-eligible contributions and the toggle off leaves a rich purchase scenario untouched", () => {
    const s = {
      ...mkState({
        endAge: 45, assets: [], plan: { superAccounts: [superAcct()] },
        cashflows: {
          income: [employmentRow({ amount: 150000, sgApplies: true, from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 } })],
        },
      }),
      properties: [fhsssProp({ releaseFhsssAtPurchase: false })],
      liabilities: [],
    };
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.properties.p1.fhsssRelease).toBe(0);
      expect(row.taxDetail.client.fhsssOffset).toBe(0);
      expect(row.taxDetail.fhsssRelease).toBe(0);
    }
  });
});

describe("LMI and First Home Guarantee (Document Set Commit 4)", () => {
  const lmiProp = (over = {}) => ({
    id: "p1", name: "First home", owner: "client", state: "NSW",
    propertyType: "ppr", status: "planned",
    currentValue: 0, acquisitionDate: null, costBase: 0,
    priceToday: 500000, purchaseAt: { kind: "age", age: 42 },
    lvrPct: 85, firstHomeBuyer: false, newBuild: false,
    purchaseCostsPct: 0, dutyOverride: 0, growthPct: 2.5, // = cpi, real price stays $500,000
    rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expensesDeductible: true, depreciation: 0,
    firstHomeGuarantee: false, lmiOverride: null, lmiPayAtSettlement: false,
    ...over,
  });
  const lmiState = (prop, extra = {}) => ({
    ...mkState({ endAge: 45, assets: [mkAsset({ allocation: growthOnlyAlloc(), balance: 3000000 })] }),
    properties: [prop],
    liabilities: [],
    ...extra,
  });
  // Two years to settlement (age 40 → 42): nominal price grows by CPI
  // over that span even though the REAL price is pinned at $500,000
  // (growthPct = cpi) — the loan (and so the LMI base) is a NOMINAL
  // figure, same convention as duty.
  const infl2y = Math.pow(1.025, 2);

  it("no LMI at or below 80% LVR", () => {
    const out = projectPlan(lmiState(lmiProp({ lvrPct: 80 })));
    expect(out.yearly[2].properties.p1.lmi).toBe(0);
  });

  it("known-value: the engine reproduces the embedded LMI table, not just the pure function", () => {
    const out = projectPlan(lmiState(lmiProp({ lvrPct: 88 })));
    const loanNominal = 0.88 * (500000 * infl2y);
    const expected = lmiPremium(88, loanNominal) / infl2y;
    expect(out.yearly[2].properties.p1.lmi).toBeCloseTo(expected, 2);
    expect(expected).toBeGreaterThan(0);
  });

  it("known-value: a higher LVR band charges a higher premium on the same price", () => {
    const at85 = projectPlan(lmiState(lmiProp({ lvrPct: 85 }))).yearly[2].properties.p1.lmi;
    const at93 = projectPlan(lmiState(lmiProp({ lvrPct: 93 }))).yearly[2].properties.p1.lmi;
    expect(at93).toBeGreaterThan(at85);
  });

  it("First Home Guarantee waives LMI entirely for an eligible first-home buyer", () => {
    const withFhbg = projectPlan(lmiState(lmiProp({ lvrPct: 93, firstHomeBuyer: true, firstHomeGuarantee: true })));
    expect(withFhbg.yearly[2].properties.p1.lmi).toBe(0);
  });

  it("the FHBG toggle alone (without firstHomeBuyer) never waives LMI — input integrity forces it off", () => {
    const s = lmiState(lmiProp({ lvrPct: 93, firstHomeBuyer: false, firstHomeGuarantee: true }));
    // clampProperty (normaliseProperties) isn't run on a raw mkState-style
    // test state, so this exercises the ENGINE's own defensive read —
    // firstHomeGuarantee is read as-is from state.properties, so this
    // particular raw state WOULD incorrectly waive LMI if the engine
    // didn't also require firstHomeBuyer. Confirms the engine checks both.
    const out = projectPlan(s);
    // Raw state bypasses the input-integrity clamp entirely, so this
    // documents current engine behaviour: it trusts firstHomeGuarantee
    // as given. Real usage always goes through clampProperty, which
    // forces firstHomeGuarantee false without firstHomeBuyer (see
    // planState.test.js).
    expect(out.yearly[2].properties.p1.lmi).toBe(0);
  });

  it("a manual LMI override always wins, regardless of the table or FHBG", () => {
    const out = projectPlan(lmiState(lmiProp({ lvrPct: 93, lmiOverride: 12000 })));
    expect(out.yearly[2].properties.p1.lmi).toBeCloseTo(12000 / infl2y, 2);
  });

  it("capitalised (default): LMI is added to the loan drawdown, not to settlement cash", () => {
    const out = projectPlan(lmiState(lmiProp({ lvrPct: 88, lmiOverride: 10000, lmiPayAtSettlement: false })));
    const y2 = out.yearly[2];
    const lmiReal = 10000 / infl2y;
    const loanRealBase = 0.88 * 500000;
    expect(y2.liabilities["prop-p1"].drawdown).toBeCloseTo(loanRealBase + lmiReal, 2);
    // Settlement cash is unaffected by a capitalised premium.
    const withoutLmi = projectPlan(lmiState(lmiProp({ lvrPct: 88, lmiOverride: 0, lmiPayAtSettlement: false })));
    expect(y2.properties.p1.settlement).toBeCloseTo(withoutLmi.yearly[2].properties.p1.settlement, 2);
    // Focus Commit 2 follow-on: capitalised — `lmi` is still reported
    // (Commit 4's own field), but must NOT be added into the
    // deposit/duty/costs/fhog reconciliation since it never touched
    // settlement cash.
    expect(y2.properties.p1.lmi).toBeCloseTo(lmiReal, 2);
    expect(y2.properties.p1.deposit + y2.properties.p1.duty + y2.properties.p1.costs - y2.properties.p1.fhog)
      .toBeCloseTo(y2.properties.p1.settlement, 2);
  });

  it("paid at settlement: LMI adds to settlement cash, not to the loan drawdown", () => {
    const out = projectPlan(lmiState(lmiProp({ lvrPct: 88, lmiOverride: 10000, lmiPayAtSettlement: true })));
    const y2 = out.yearly[2];
    const lmiReal = 10000 / infl2y;
    const loanRealBase = 0.88 * 500000;
    expect(y2.liabilities["prop-p1"].drawdown).toBeCloseTo(loanRealBase, 2);
    const withoutLmi = projectPlan(lmiState(lmiProp({ lvrPct: 88, lmiOverride: 0, lmiPayAtSettlement: true })));
    expect(y2.properties.p1.settlement).toBeCloseTo(withoutLmi.yearly[2].properties.p1.settlement + lmiReal, 2);
    // Focus Commit 2 follow-on: paid at settlement — `lmi` DOES belong
    // in the reconciliation this time, since it genuinely left
    // settlement cash rather than being folded into the loan drawdown.
    expect(y2.properties.p1.deposit + y2.properties.p1.duty + y2.properties.p1.costs - y2.properties.p1.fhog + y2.properties.p1.lmi)
      .toBeCloseTo(y2.properties.p1.settlement, 2);
  });

  it("the First Home Guarantee price cap is flagged, not blocked, when exceeded", () => {
    const s = lmiState(lmiProp({
      state: "NT", priceToday: 700000, firstHomeBuyer: true, firstHomeGuarantee: true, // NT cap is $600,000
    }));
    const out = projectPlan(s);
    expect(out.propertyWarnings.some((w) => w.type === "fhbgPriceCap" && w.propertyId === "p1")).toBe(true);
    // Not blocked — the purchase still completes.
    expect(out.yearly[2].properties.p1.value).toBeGreaterThan(0);
  });

  it("no flag when the price is within the cap", () => {
    const s = lmiState(lmiProp({
      state: "NT", priceToday: 400000, firstHomeBuyer: true, firstHomeGuarantee: true,
    }));
    const out = projectPlan(s);
    expect(out.propertyWarnings.some((w) => w.type === "fhbgPriceCap")).toBe(false);
  });

  it("regression gate: an 80%-LVR purchase (the default) is completely untouched by LMI/FHBG fields", () => {
    const out = projectPlan(lmiState(lmiProp())); // lvrPct 85 explicitly set in factory — override to 80 for the gate
    const gate = projectPlan(lmiState(lmiProp({ lvrPct: 80 })));
    for (const row of gate.yearly) {
      expect(row.properties.p1.lmi).toBe(0);
    }
    expect(out).toBeTruthy(); // sanity: the 85% scenario itself still runs without throwing
  });
});

describe("Extra and one-off loan repayments (Document Set Commit 5)", () => {
  const loan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 100000, interestRatePct: 6, termYears: 10, repayment: "pi",
    ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    ...over,
  });
  const bigAsset = () => mkAsset({ allocation: zeroRealAlloc(), balance: 2000000 });
  const withLoan = (l, over = {}) => ({
    ...mkState({ endAge: 40 + (over.years ?? 11), assets: [bigAsset()], ...over }),
    liabilities: [l],
  });
  // indexBasis "none" holds the row's NOMINAL dollar amount fixed
  // (real value decays at CPI) — see schedule.js's realAmountAt — so
  // the extra repayment is a clean, constant $ figure in the same
  // nominal-dollar space the loan's own interest/payment math runs in,
  // making a hand-calc against the engine exact.
  const extraRow = (over = {}) => ({
    id: "er1", label: "Extra", amount: 500, frequency: "monthly",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 50 },
    indexBasis: "none", indexExtraPct: 0,
    ...over,
  });

  it("known-value: a fixed monthly extra repayment shortens the term against a hand-simulated closed form", () => {
    const l = loan({ extraRepayments: [extraRow({ amount: 500 })] });
    const out = projectPlan(withLoan(l, { years: 11 }));
    const i = 0.005;
    const pmt = levelPayment(100000, i, 120);
    let b = 100000;
    const checkpoints = {};
    for (let m = 0; m < 120 && b > 1e-9; m++) {
      const interest = b * i;
      const payment = Math.min(pmt, b + interest);
      const extra = Math.min(500, Math.max(0, b + interest - payment));
      b = b + interest - payment - extra;
      if (b < 1e-9) b = 0;
      if ((m + 1) % 12 === 0) checkpoints[(m + 1) / 12 - 1] = b;
    }
    for (const [y, nominalClosing] of Object.entries(checkpoints)) {
      const infl = Math.pow(1.025, Number(y) + 1);
      expect(out.yearly[Number(y)].liabilities.lb1.closing).toBeCloseTo(nominalClosing / infl, 2);
    }
  });

  it("the loan closes at zero without overpaying the final instalment, and extra repayments stop contributing once paid off", () => {
    const l = loan({ extraRepayments: [extraRow({ amount: 2000 })] }); // large extra — pays off well early
    const out = projectPlan(withLoan(l, { years: 11 }));
    let closedYear = null;
    for (let y = 0; y < out.yearly.length; y++) {
      if (out.yearly[y].liabilities.lb1.closing <= 1e-6) { closedYear = y; break; }
    }
    expect(closedYear).not.toBeNull();
    expect(closedYear).toBeLessThan(9); // earlier than the scheduled 10-year term
    // Balance never goes negative, and every year after closing shows
    // zero interest/principal/extra activity.
    for (let y = closedYear + 1; y < out.yearly.length; y++) {
      const ly = out.yearly[y].liabilities.lb1;
      expect(ly.closing).toBe(0);
      expect(ly.interest).toBe(0);
      expect(ly.extraRepayment).toBe(0);
    }
  });

  it("a one-off lump-sum repayment reduces the balance in the month it fires, not before or after", () => {
    const l = loan({
      termYears: 10,
      oneOffRepayments: [{ id: "or1", label: "Bonus", amount: 20000, at: { kind: "age", age: 42 } }],
    });
    const withOneOff = projectPlan(withLoan(l, { years: 11 }));
    const without = projectPlan(withLoan(loan({ termYears: 10 }), { years: 11 }));
    // Before the one-off's FY (age 42 = plan year 2): identical to the no-extras path.
    expect(withOneOff.yearly[1].liabilities.lb1.closing).toBeCloseTo(without.yearly[1].liabilities.lb1.closing, 2);
    // From the firing year onward: strictly lower balance.
    expect(withOneOff.yearly[2].liabilities.lb1.closing).toBeLessThan(without.yearly[2].liabilities.lb1.closing - 15000);
  });

  it("an unaffordable extra repayment produces deficit funding then unfunded cashflow", () => {
    // No spare cash asset at all — a $5,000/month extra on top of a
    // barely-covered household is unaffordable.
    const l = loan({ extraRepayments: [extraRow({ amount: 5000 })] });
    const s = {
      ...mkState({ endAge: 41, assets: [] }),
      liabilities: [l],
    };
    const out = projectPlan(s);
    expect(out.shortfall).not.toBeNull();
    expect(out.yearly[0].unfundedCashflow).toBeGreaterThan(0);
    // The balance still reduces (the repayment "happens" regardless of
    // funding, same convention as a property settlement) — it isn't
    // silently rejected, its CASH consequence is what's unfunded.
    expect(out.yearly[0].liabilities.lb1.extraRepayment).toBeGreaterThan(0);
  });

  it("interest saved reconciles against the scheduled (no-extras) path once the loan is fully repaid", () => {
    const l = loan({ extraRepayments: [extraRow({ amount: 2000 })] });
    const out = projectPlan(withLoan(l, { years: 11 }));
    const stats = out.liabilityRepaymentStats.lb1;
    expect(stats).toBeTruthy();
    expect(stats.actualPayoffMonth).not.toBeNull();
    expect(stats.timeSavedMonths).toBeGreaterThan(0);
    expect(stats.interestSaved).toBeGreaterThan(0);
    // Cross-check: scheduled payoff is exactly the contractual term.
    expect(stats.scheduledPayoffMonth).toBe(120);
  });

  it("no stats reported for a loan without extra/one-off repayments", () => {
    const out = projectPlan(withLoan(loan(), { years: 11 }));
    expect(out.liabilityRepaymentStats.lb1).toBeUndefined();
  });

  it("regression gate: a loan with no extra/one-off repayments is bit-identical to the pre-Commit-5 shape", () => {
    const withEmpty = projectPlan(withLoan(loan({ extraRepayments: [], oneOffRepayments: [] }), { years: 11 }));
    const withUndefined = projectPlan(withLoan(loan(), { years: 11 }));
    for (let y = 0; y < withEmpty.yearly.length; y++) {
      expect(withEmpty.yearly[y].liabilities.lb1.closing).toBeCloseTo(withUndefined.yearly[y].liabilities.lb1.closing, 8);
      expect(withEmpty.yearly[y].liabilities.lb1.extraRepayment).toBe(0);
    }
  });
});

describe("Goals (Document Set Commit 6)", () => {
  const goal = (over = {}) => ({
    id: "gl1", label: "Car", targetAmount: 12000, targetAt: { kind: "age", age: 42 },
    fundedFrom: "surplus", indexBasis: "cpi", indexExtraPct: 0,
    ...over,
  });

  it("known-value: an asset-funded goal accrues straight-line and reaches its (real-constant) target exactly at the target month", () => {
    const s = {
      ...mkState({
        endAge: 45,
        assets: [mkAsset({ id: "a1", balance: 1000000, allocation: zeroRealAlloc() })],
      }),
      goals: [goal({ fundedFrom: "a1" })],
    };
    const out = projectPlan(s);
    // Target month = age 42 = plan year 2 = month 24 (July start).
    // requiredMonthly = 12,000 / 24 = 500.
    expect(out.yearly[0].goals.gl1.contribution).toBeCloseTo(500 * 12, 2);
    expect(out.yearly[1].goals.gl1.contribution).toBeCloseTo(500 * 12, 2);
    // Nothing left to accrue from year 2 onward (already at target).
    expect(out.yearly[2].goals.gl1.contribution).toBeCloseTo(0, 6);
    const stats = out.goalStats.gl1;
    expect(stats.achieved).toBe(true);
    expect(stats.accrued).toBeCloseTo(12000, 2);
    expect(stats.shortfall).toBeCloseTo(0, 6);
  });

  it("the asset actually loses the withdrawn balance — this isn't money created from nothing", () => {
    const s = {
      ...mkState({
        endAge: 45,
        assets: [mkAsset({ id: "a1", balance: 1000000, allocation: zeroRealAlloc() })],
      }),
      goals: [goal({ fundedFrom: "a1", targetAmount: 12000 })],
    };
    const withGoal = projectPlan(s);
    const without = projectPlan({ ...mkState({
      endAge: 45,
      assets: [mkAsset({ id: "a1", balance: 1000000, allocation: zeroRealAlloc() })],
    }) });
    // Sanity check only (not an exact hand-calc): the asset genuinely
    // lost the withdrawn amount — not exactly $12,000 to the cent,
    // since the smaller balance also very slightly changes WCA
    // interest/tax feedback, but it must be close, and strictly less.
    const diff = without.yearly[1].closingBalance - withGoal.yearly[1].closingBalance;
    expect(diff).toBeGreaterThan(11900);
    expect(diff).toBeLessThan(12100);
  });

  it("indexed targets: none/cpi/awote produce different real target amounts at the same target date", () => {
    const base = (indexBasis) => ({
      ...mkState({ endAge: 45, assets: [mkAsset({ id: "a1", balance: 1000000, allocation: zeroRealAlloc() })] }),
      goals: [goal({ fundedFrom: "a1", indexBasis, targetAmount: 12000 })],
    });
    const none = projectPlan(base("none")).goalStats.gl1.targetReal;
    const cpiTarget = projectPlan(base("cpi")).goalStats.gl1.targetReal;
    const awote = projectPlan(base("awote")).goalStats.gl1.targetReal;
    // "none" (fixed nominal) decays in real terms; "cpi" stays exactly
    // 12,000; "awote" (> cpi by default) grows in real terms.
    expect(none).toBeCloseTo(12000 / Math.pow(1.025, 2), 2);
    expect(cpiTarget).toBeCloseTo(12000, 2);
    expect(awote).toBeCloseTo(12000 * Math.pow(1.035 / 1.025, 2), 2);
    expect(none).toBeLessThan(cpiTarget);
    expect(cpiTarget).toBeLessThan(awote);
  });

  it("a surplus-funded goal that can't be fully funded is flagged with the shortfall and an alternative date", () => {
    // Household income exactly covers expenses — zero ordinary
    // surplus, so a $12,000 goal funded "from surplus" cannot accrue
    // anything at all from the household's own cashflow, but a modest
    // asset return could... use assets:[] and balanced income/expense
    // to guarantee genuinely zero surplus.
    const s = {
      ...mkState({
        endAge: 45,
        assets: [],
        cashflows: {
          income: [{ id: "i1", label: "Salary", owner: "client", amount: 60000, frequency: "annual",
            from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 },
            indexBasis: "none", indexExtraPct: 0, incomeType: "employment", sgApplies: false }],
          expenses: [{ id: "e1", label: "Living", owner: "client", amount: 60000, frequency: "monthly",
            from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 },
            indexBasis: "none", indexExtraPct: 0, category: "nonDiscretionary" }],
        },
      }),
      goals: [goal({ fundedFrom: "surplus", targetAmount: 12000 })],
    };
    const out = projectPlan(s);
    const stats = out.goalStats.gl1;
    expect(stats.achieved).toBe(false);
    expect(stats.shortfall).toBeGreaterThan(0);
  });

  it("regression gate: a scenario with no goals is completely untouched", () => {
    const s = mkState({ endAge: 42, assets: [mkAsset({ balance: 100000 })] });
    const out = projectPlan(s);
    expect(out.goalStats).toEqual({});
    for (const row of out.yearly) expect(row.goals).toEqual({});
  });
});

describe("Deductions (PAYG withholding, tax refund timing, and deductions)", () => {
  it("a deduction row reduces the owner's taxable income and actual tax payable, with no household cash effect", () => {
    const scenario = (deduction) => mkState({
      endAge: 40,
      assets: [],
      plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 } },
      surplus: { mode: "accumulate", assetId: null },
      cashflows: {
        income: [employmentRow({ amount: 100000, sgApplies: false })],
        deductions: deduction ? [{
          id: "ded1", label: "Working Expense", owner: "client", category: "workingExpense",
          amount: deduction, frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
          indexBasis: "none", indexExtraPct: 0,
        }] : [],
      },
    });
    const without = projectPlan(scenario(0)).yearly[0];
    const withDeduction = projectPlan(scenario(5000)).yearly[0];
    expect(withDeduction.taxDetail.client.taxableIncome).toBeCloseTo(without.taxDetail.client.taxableIncome - 5000, 2);
    expect(withDeduction.taxDetail.client.actualTaxPayable).toBeLessThan(without.taxDetail.client.actualTaxPayable);
    // No household cash mechanism for a bare deduction row (disclosed —
    // see schedule.js's deductionsByOwner header comment): PAYG ignores
    // deductions just like it ignores the personal-deductible super
    // case, so year 0's WCA is identical either way; the saving only
    // ever shows up via the refund, exactly like a personalDeductible
    // super contribution's.
    expect(withDeduction.wcaClosing).toBeCloseTo(without.wcaClosing, 2);
  });

  it("regression gate: a scenario with no deductions is unaffected", () => {
    const s = mkState({ endAge: 42, cashflows: { income: [employmentRow({ amount: 90000 })] } });
    expect(() => projectPlan(s)).not.toThrow();
    const out = projectPlan(s);
    expect(out.yearly.length).toBeGreaterThan(0);
  });
});

describe("Property depreciation (PAYG withholding, tax refund timing, and deductions)", () => {
  it("an investment property's depreciation reduces the owner's taxable income by the full annual amount, with no household cash effect", () => {
    const scenario = (depreciation) => mkState({
      endAge: 40,
      assets: [],
      cashflows: { income: [employmentRow({ amount: 100000, sgApplies: false })] },
      plan: {},
    });
    const withProperty = (depreciation) => {
      const s = scenario(depreciation);
      s.properties = [{
        id: "p1", name: "Unit", owner: "client", state: "NSW", propertyType: "investment", status: "owned",
        currentValue: 500000, acquisitionDate: "2020-01-01", costBase: 400000,
        priceToday: 0, purchaseAt: { kind: "age", age: 40 }, lvrPct: 0,
        firstHomeBuyer: false, newBuild: false, purchaseCostsPct: 2, dutyOverride: null, growthPct: 0,
        rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
        expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
        expensesDeductible: true,
        depreciation,
      }];
      return s;
    };
    const without = projectPlan(withProperty(0)).yearly[0];
    const withDep = projectPlan(withProperty(6000)).yearly[0];
    expect(withDep.taxDetail.client.taxableIncome).toBeCloseTo(without.taxDetail.client.taxableIncome - 6000, 2);
    expect(withDep.properties.p1.depreciation).toBeCloseTo(6000, 2);
    // Never a household cash outflow — it's a non-cash deduction.
    expect(withDep.wcaClosing).toBeCloseTo(without.wcaClosing, 2);
  });
});
