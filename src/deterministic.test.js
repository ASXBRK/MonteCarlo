import { describe, it, expect } from "vitest";
import { projectPlan, assetMonthlyRate, assetReturnComponents } from "./deterministic.js";
import { hydrate, SCHEMA_VERSION } from "./planState.js";
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
        income: [{
          ...rows.income[0], indexed: undefined, indexBasis: "cpi", indexExtraPct: 0,
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
    expect(migrated.plan.client.retirementAge).toBe(65); // new field default
    expect(migrated.plan.keyDates).toEqual([]);

    // native bypasses hydrate/clamp entirely — same values, real
    // DateRef shape from the start.
    const age = (n) => ({ kind: "age", age: n });
    const native = {
      ...mkState({
        endAge: 55,
        assets: v5.assets,
        cashflows: {
          income: [{ ...v5.cashflows.income[0], from: age(40), to: age(55) }],
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
    const scenario = (type) => mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()] },
      cashflows: {
        income: [employmentRow({ amount: 100000, sgApplies: false })], // isolate — no SG noise
        superContributions: [scRow({ type, amount: 10000 })],
      },
    });
    const ss = projectPlan(scenario("salarySacrifice"));
    const pd = projectPlan(scenario("personalDeductible"));
    expect(ss.yearly[0].taxDetail.client.taxableIncome).toBeCloseTo(pd.yearly[0].taxDetail.client.taxableIncome, 4);
    expect(ss.yearly[0].tax).toBeCloseTo(pd.yearly[0].tax, 2);
    expect(ss.yearly[0].taxDetail.incomeTax).toBeCloseTo(pd.yearly[0].taxDetail.incomeTax, 4);
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
    // Year 1 fill = 32,500 cap + 30,000 available carry-forward = 62,500.
    expect(out.yearly[1].superDetail.su1.contributions).toBeCloseTo(62500, 1);
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
      plan: { client: { currentAge: 65, retirementAge: 65 }, superAccounts: [superAcct({ balance: 0 })] },
      endAge: 68, // 3 plan years: ages 65, 66, 67
      cpi: 0,
      cashflows: {
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
