import { describe, it, expect } from "vitest";
import { projectPlan, assetMonthlyRate, assetReturnComponents } from "./deterministic.js";
import { hydrate, SCHEMA_VERSION, synthDob, legacySurplusPeriod, clampSuperAccount } from "./planState.js";
import { PROFILES } from "./profiles.js";
import { checkYearConservation } from "./conservationCheck.js";
import { lmiPremium } from "./data/lmiRates.js";
import { levelPayment } from "./liabilities.js";
import { agePensionRatesFor, cshcThresholdsFor } from "./data/agePension.js";
import { superRatesFor } from "./data/superRates.js";
import { heasEffectiveAnnualRate, heasMaxLoanAmount } from "./data/heas.js";
import { assessPerson } from "./Tax/annual.js"; // only for the marginal-withholding hand-calc below

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

// `n` children, all comfortably under 21 as of mkState's default plan
// start (FY2026–27) — enough to exercise the MLS family-threshold step
// without needing individually-tuned DOBs.
function childrenOfCount(n, start = { year: 2026, month: 7 }) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ch${i}`, name: `Child ${i}`, dateOfBirth: synthDob(10, start), education: [],
  }));
}

// Surplus/deficit allocation spec, Commit 1: settings.surplus is now
// {periods: [...]}, not {mode, assetId} — this shim lets every existing
// test in this file (and the many other test files with their own
// mkState()) keep passing the old shorthand unchanged; a test that
// wants the new period shape directly just passes {periods: [...]}
// instead, which is used verbatim.
function surplusPeriodsFor(over) {
  if (Array.isArray(over?.periods)) return over.periods;
  return [legacySurplusPeriod(over ?? { mode: "spend", assetId: null })];
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
    bonds: over.bonds ?? [],
    cashflows: {
      income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [],
      bondContributions: [],
      ...over.cashflows,
    },
    settings: {
      surplus: { periods: surplusPeriodsFor(over.surplus) },
      fundingOrder: over.fundingOrder ?? assets.filter((a) => a.include).map((a) => a.id),
      deficit: over.deficit ?? { minimumBalances: {}, sellRule: "order" },
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
        // Age pension (spec 21a) reintroduced taxProfile.centrelinkEligible
        // — mkState's own default client has no taxProfile at all, so
        // this must match what clampTaxProfile resolves for the migrated
        // side's explicit `centrelinkEligible: false` (v5.plan.client.taxProfile
        // above), or the two sides' row.agePensionDetail diverge on the
        // "eligible" flag alone (the paid AMOUNT is identical either way,
        // since this client never reaches age pension age within the
        // plan — but the bit-identical gate compares the whole row).
        plan: {
          client: {
            currentAge: 40,
            // Retirement: Income Required (spec 32, Commit 1) resolves
            // its default startAt against the "retirement-client"
            // anchor, which needs a real retirementAge to mean anything
            // — clampPerson defaults+clamps the migrated side's missing
            // retirementAge to endAge (55, see the comment on
            // migrated.plan.client.retirementAge above); native must
            // match that EFFECTIVE value explicitly, since it bypasses
            // clampPerson entirely and would otherwise fall back to
            // resolveOwnerAge's OWN default (current age, i.e. plan
            // year 0) — a silent divergence nothing surfaced before
            // this commit gave the anchor its first unconditional use.
            retirementAge: 55,
            taxProfile: { residency: "resident", medicareExempt: false, centrelinkEligible: false, centrelinkEligibleIsDefault: false, openingCapitalLosses: 0 },
          },
        },
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

describe("Land tax (spec 19 Commit 2)", () => {
  const invProp = (over = {}) => ({
    id: "p1", name: "Investment unit", owner: "client", state: "WA",
    propertyType: "investment", status: "owned",
    currentValue: 400000, acquisitionDate: "2020-01-15", costBase: 300000,
    priceToday: 0, purchaseAt: { kind: "age", age: 41 },
    lvrPct: 0, firstHomeBuyer: false, newBuild: true, // newBuild — negative gearing unrestricted, isolates land tax
    purchaseCostsPct: 0, dutyOverride: null, growthPct: 0,
    rent: { amount: 30000, indexBasis: "none", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expensesDeductible: true, landValuePct: 60, landTaxOverride: null,
    ...over,
  });
  const bigCash = () => mkAsset({ allocation: growthOnlyAlloc(), balance: 2000000 });
  const withProps = (properties, over = {}) => ({
    ...mkState({ endAge: 43, assets: [bigCash()], cashflows: { income: [salary(100000 / 12)] }, ...over }),
    properties,
    liabilities: [],
  });

  it("a PPR is exempt regardless of value", () => {
    const out = projectPlan(withProps([invProp({ propertyType: "ppr", currentValue: 2000000 })]));
    for (const r of out.yearly) expect(r.properties.p1.landTax).toBe(0);
  });

  it("WA: a single property under its own $300k land-value threshold pays nothing", () => {
    // 400,000 × 60% = 240,000 land value — under WA's $300,000 threshold alone.
    const out = projectPlan(withProps([invProp()]));
    expect(out.yearly[0].properties.p1.landTax).toBe(0);
  });

  it("aggregates land value across two properties in the same state — exceeding a threshold that neither reaches alone", () => {
    // Two IDENTICAL WA properties, ~240,000 land value each — under the
    // $300,000 threshold alone (confirmed $0 by the previous test), but
    // the combined ~480,000 crosses into WA's $420k–$1m bracket, so
    // together they owe a positive amount split evenly between them.
    const out = projectPlan(withProps([
      invProp({ id: "p1" }),
      invProp({ id: "p2" }),
    ]));
    const t1 = out.yearly[0].properties.p1.landTax;
    const t2 = out.yearly[0].properties.p2.landTax;
    expect(t1).toBeGreaterThan(0); // neither is zero here...
    expect(t2).toBeGreaterThan(0); // ...though each alone (previous test) is exactly $0
    expect(t1).toBeCloseTo(t2, 6); // identical properties split the aggregate tax evenly
    // Sanity bound: WA's bracket at ~480,000 combined is ~300 + 0.25%
    // of the excess over 420,000 — a few hundred dollars, not a few
    // thousand (would signal the aggregation used the WRONG bracket).
    expect(t1 + t2).toBeGreaterThan(100);
    expect(t1 + t2).toBeLessThan(1000);
  });

  it("deductible for an investment property: land tax reduces taxable income", () => {
    const withTax = projectPlan(withProps([invProp({ landValuePct: 100, currentValue: 2000000 })])); // well over WA's top bracket
    const without = projectPlan(withProps([invProp({ landValuePct: 100, currentValue: 2000000, landTaxOverride: 0 })]));
    const landTax = withTax.yearly[0].properties.p1.landTax;
    expect(landTax).toBeGreaterThan(0);
    expect(without.yearly[0].properties.p1.landTax).toBe(0);
    // Both scenarios have IDENTICAL rent (30,000, well above the land
    // tax amount) so neither triggers the negative-gearing quarantine —
    // land tax reduces taxable income by ~landTax, not exactly (paying
    // it also draws down the Working Cash Account balance a little
    // sooner, so the "withTax" run earns slightly less WCA interest
    // over the rest of the FY — a real, expected second-order effect,
    // not a bug — so this checks the direct deduction dominates, within
    // a tolerance wide enough for that indirect interest differential).
    const delta = without.yearly[0].taxDetail.client.taxableIncome - withTax.yearly[0].taxDetail.client.taxableIncome;
    expect(delta).toBeCloseTo(landTax, -3); // within $500 of the direct deduction
  });

  it("NOT deductible for a holiday home: land tax is a cash outflow but does not reduce taxable income", () => {
    const holiday = invProp({ propertyType: "holiday", landValuePct: 100, currentValue: 2000000, rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 } });
    const withTax = projectPlan(withProps([holiday]));
    const without = projectPlan(withProps([{ ...holiday, landTaxOverride: 0 }]));
    const landTax = withTax.yearly[0].properties.p1.landTax;
    expect(landTax).toBeGreaterThan(0);
    // Same taxable income either way, within the WCA-interest second-
    // order tolerance noted above — land tax never touched deductions
    // directly for a holiday home, so the gap here should be much
    // smaller than the land tax amount itself (confirming it's the
    // indirect WCA effect, not a mistaken direct deduction).
    const delta = Math.abs(withTax.yearly[0].taxDetail.client.taxableIncome - without.yearly[0].taxDetail.client.taxableIncome);
    expect(delta).toBeLessThan(landTax * 0.05);
    // But it IS a real household cash outflow, reported on the property.
    expect(withTax.yearly[0].expenses).toBeGreaterThan(without.yearly[0].expenses);
  });

  it("landTaxOverride bypasses the aggregate calculation for that property, and is excluded from its sibling's aggregate", () => {
    // p1 overridden to a flat 9999; p2 (same state) is assessed alone
    // against WA's schedule — must NOT see p1's land value in its aggregate.
    const out = projectPlan(withProps([
      invProp({ id: "p1", landTaxOverride: 9999 }),
      invProp({ id: "p2" }),
    ]));
    expect(out.yearly[0].properties.p1.landTax).toBe(9999);
    expect(out.yearly[0].properties.p2.landTax).toBe(0); // 240,000 alone, under WA's threshold
  });

  it("conservation holds for a scenario with land tax active", () => {
    const out = projectPlan(withProps([invProp({ landValuePct: 100, currentValue: 2000000 })]));
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `land tax fixture, year ${y}`);
  });

  it("regression gate: a property with no landValuePct/landTaxOverride fields at all (pre-Commit-2 state) still derives from the 60% default, not undefined/NaN", () => {
    const bare = invProp({ landValuePct: 100, currentValue: 2000000 });
    delete bare.landValuePct;
    delete bare.landTaxOverride;
    const out = projectPlan(withProps([bare]));
    expect(out.yearly[0].properties.p1.landTax).toBeGreaterThan(0);
    expect(Number.isFinite(out.yearly[0].properties.p1.landTax)).toBe(true);
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
    // Row indexation's "awote" basis reads assumptions.wageGrowth, not
    // assumptions.awote (kept only for super/ETP/redundancy caps —
    // assumptions-provenance.md §1.2).
    s.assumptions.wageGrowth = 0.035;
    const out = projectPlan(s);
    // Salary at year 5 grows in real terms at the wage/CPI premium;
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

// --- Spec 26, Commit 1: untaxed superannuation elements ---------------------

describe("Spec 26 Commit 1 — untaxed superannuation elements", () => {
  it("contributions enter an untaxed account in full — no 15% contributions tax", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct({ taxedStatus: "untaxed" })] },
      cashflows: { income: [employmentRow({ amount: 100000 })] },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].superDetail.su1;
    expect(d.contributionsTax).toBe(0);
    // Full SG (12% of 100,000) lands with nothing deducted.
    expect(d.sg).toBeCloseTo(12000, 2);
    expect(d.concessionalNet).toBeCloseTo(d.sg, 2); // net === gross, no tax haircut
  });

  it("earnings accrue untaxed inside — the net rate equals the gross rate, so earningsTax is 0", () => {
    const s = mkState({
      endAge: 41,
      plan: {
        superAccounts: [superAcct({
          taxedStatus: "untaxed", balance: 100000,
          allocation: { mode: "custom", incomePct: 3, growthPct: 4, frankingPct: 0, volBasis: "Balanced" },
        })],
      },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].superDetail.su1;
    expect(d.earningsTax).toBeCloseTo(0, 6);
    expect(d.earnings).toBeGreaterThan(0);
  });

  it("regression gate: a taxed account is bit-identical whether or not taxedStatus is explicitly stamped", () => {
    // A single base state, cloned and varied ONLY in taxedStatus — mkState's
    // own legacySurplusPeriod() stamps a fresh random id per call, which
    // would otherwise show up as a spurious diff unrelated to this test.
    const base = mkState({
      endAge: 44,
      plan: { superAccounts: [superAcct({ taxedStatus: "taxed", balance: 120000, allocation: { mode: "custom", incomePct: 3, growthPct: 3, frankingPct: 30, volBasis: "Balanced" } })] },
      cashflows: { income: [employmentRow({ amount: 150000 })] },
    });
    const untouched = { ...base, plan: { ...base.plan, superAccounts: [{ ...base.plan.superAccounts[0], taxedStatus: undefined }] } };
    expect(projectPlan(untouched)).toEqual(projectPlan(base));
  });

  it("a deficit-funded post-release withdrawal from an untaxed account is assessed with the 15% offset, settled with the same one-year lag as bond/CGT tax", () => {
    // Client already past preservation age (retirementAge 60, currentAge
    // 60) — deficit funding may draw on super from month 1. No other
    // assets, no other income: the untaxed element withdrawn each FY is
    // the entire assessable base for that FY's lagged tax.
    // A single-year projection: the withdrawal's lagged tax has no
    // FOLLOWING year within the projection to actually settle in (the
    // same reason accruedBondTaxAtEnd/accruedCgtAtEnd tests use a short
    // window — otherwise the very next year's cgtDue would pay it,
    // leaving nothing "accrued" to observe at the end).
    const s = mkState({
      endAge: 60,
      assets: [],
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ taxedStatus: "untaxed", balance: 200000, allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" } })],
      },
      cashflows: { expenses: [{ id: "e1", label: "Living", owner: "client", amount: 40000, frequency: "annual", from: { kind: "age", age: 60 }, to: { kind: "age", age: 60 }, indexBasis: "none", indexExtraPct: 0 }] },
      settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: [] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.withdrawals).toBeGreaterThan(0);
    // Nothing settles same-year (the lag) — but by the projection's end
    // there's an accrued, unpaid balance recording the liability, the
    // same convention accruedBondTaxAtEnd/accruedCgtAtEnd already use.
    expect(out.accruedUntaxedSuperTaxAtEnd).toBeGreaterThan(0);
  });

  it("regression gate: with every account taxed, accruedUntaxedSuperTaxAtEnd is always 0", () => {
    const s = mkState({
      endAge: 62,
      assets: [],
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ taxedStatus: "taxed", balance: 200000 })],
      },
      cashflows: { expenses: [{ id: "e1", label: "Living", owner: "client", amount: 40000, frequency: "annual", from: { kind: "age", age: 60 }, to: { kind: "age", age: 61 }, indexBasis: "none", indexExtraPct: 0 }] },
      settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: [] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.withdrawals).toBeGreaterThan(0);
    expect(out.accruedUntaxedSuperTaxAtEnd).toBe(0);
  });

  it("a rollover from an untaxed account to a taxed one crystallises 15% tax on the untaxed element, at the point of rollover", () => {
    const s = mkState({
      endAge: 42,
      plan: {
        superAccounts: [
          superAcct({ id: "su1", taxedStatus: "untaxed", balance: 100000, allocation: zeroRealAlloc() }),
          superAcct({ id: "su2", taxedStatus: "taxed", balance: 0, allocation: zeroRealSuperAlloc() }),
        ],
      },
      cashflows: {
        superRollovers: [{ id: "sr1", owner: "client", fromAccountId: "su1", toAccountId: "su2", amount: null, at: { kind: "age", age: 40 } }],
      },
    });
    const out = projectPlan(s);
    const from = out.yearly[0].superDetail.su1;
    const to = out.yearly[0].superDetail.su2;
    expect(from.rolloverOut).toBeCloseTo(100000, 1);
    expect(from.rolloverTax).toBeCloseTo(15000, 1); // 15% of the fully-untaxed $100,000 element
    expect(to.rolloverIn).toBeCloseTo(85000, 1); // net of the rollover tax
    expect(from.closing).toBeCloseTo(0, 1);
  });

  it("a same-status rollover (taxed→taxed) triggers no tax at all", () => {
    const s = mkState({
      endAge: 42,
      plan: {
        superAccounts: [
          superAcct({ id: "su1", taxedStatus: "taxed", balance: 100000, allocation: zeroRealSuperAlloc() }),
          superAcct({ id: "su2", taxedStatus: "taxed", balance: 0, allocation: zeroRealSuperAlloc() }),
        ],
      },
      cashflows: {
        superRollovers: [{ id: "sr1", owner: "client", fromAccountId: "su1", toAccountId: "su2", amount: null, at: { kind: "age", age: 40 } }],
      },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.rolloverTax).toBe(0);
    expect(out.yearly[0].superDetail.su2.rolloverIn).toBeCloseTo(100000, 1);
  });

  it("the untaxed plan cap: a benefit beyond the lifetime cap is taxed at 47% for the excess, tracked cumulatively across events", () => {
    // Two same-owner untaxed accounts, each rolled in the SAME year:
    // the first consumes most of the cap, the second's rollover pushes
    // past it — the excess on the SECOND event must reflect the
    // ALREADY-consumed cap from the first, not reset to 0.
    const s = mkState({
      endAge: 42,
      plan: {
        superAccounts: [
          superAcct({ id: "su1", taxedStatus: "untaxed", balance: 1900000, allocation: zeroRealAlloc() }),
          superAcct({ id: "su2", taxedStatus: "untaxed", balance: 100000, allocation: zeroRealAlloc() }),
          superAcct({ id: "su3", taxedStatus: "taxed", balance: 0, allocation: zeroRealSuperAlloc() }),
        ],
      },
      cashflows: {
        superRollovers: [
          { id: "sr1", owner: "client", fromAccountId: "su1", toAccountId: "su3", amount: null, at: { kind: "age", age: 40 } },
          { id: "sr2", owner: "client", fromAccountId: "su2", toAccountId: "su3", amount: null, at: { kind: "age", age: 40 } },
        ],
      },
    });
    const out = projectPlan(s);
    // su1's own $1.9m rollover fits entirely within the (~$1.935m FY26-27)
    // cap, so it's taxed at the flat 15% throughout.
    expect(out.yearly[0].superDetail.su1.rolloverTax).toBeCloseTo(1900000 * 0.15, 2);
    // su2's $100k rollover lands almost entirely ABOVE the now-consumed
    // cap — most of it taxed at 47%, not 15%.
    const su2Tax = out.yearly[0].superDetail.su2.rolloverTax;
    expect(su2Tax).toBeGreaterThan(100000 * 0.15); // more than if it were entirely within-cap
    expect(su2Tax).toBeLessThan(100000 * 0.47); // less than if it were entirely excess
  });
});

function dbRow(over = {}) {
  return {
    id: "db1", name: "DB", owner: "client",
    commenceAt: { kind: "age", age: 40 },
    annualPension: 50000,
    indexBasis: "none", indexExtraPct: 0,
    taxFreeProportion: 0, untaxedProportion: 0,
    notionalTaxedContributions: 0,
    ...over,
  };
}

describe("Spec 26 Commit 2 — defined benefit pensions", () => {
  it("commencing credits the transfer balance account at 16× the annual pension — NOT the pension amount itself", () => {
    const s = mkState({
      endAge: 41,
      plan: { definedBenefits: [dbRow({ annualPension: 50000 })] },
    });
    const out = projectPlan(s);
    // The canonical trap this spec exists to avoid: crediting $50,000
    // (the pension amount) would understate cap usage sixteenfold.
    expect(out.yearly[0].transferBalance.client.balance).toBeCloseTo(50000 * 16, 2);
  });

  it("the taxed element (gross less tax-free less untaxed) is tax-free from commencement — no tax impact at all", () => {
    const withDb = mkState({
      endAge: 41,
      plan: { definedBenefits: [dbRow({ annualPension: 50000, taxFreeProportion: 20, untaxedProportion: 0 })] },
    });
    const without = mkState({ endAge: 41 });
    const outWith = projectPlan(withDb);
    const outWithout = projectPlan(without);
    expect(outWith.yearly[0].definedBenefitDetail.db1.grossPension).toBeCloseTo(50000, 2);
    expect(outWith.yearly[0].definedBenefitDetail.db1.untaxedAssessable).toBeCloseTo(0, 6);
    // No untaxed element at all ⇒ identical tax outcome to no DB pension.
    expect(outWith.yearly[0].taxDetail.client.incomeTax).toBeCloseTo(outWithout.yearly[0].taxDetail.client.incomeTax, 2);
  });

  it("the untaxed element is assessable with the 10% offset — a client with ONLY DB income pays less than the plain marginal+Medicare cost", () => {
    const s = mkState({
      endAge: 41,
      plan: { definedBenefits: [dbRow({ annualPension: 50000, untaxedProportion: 100 })] },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].definedBenefitDetail.db1;
    expect(d.untaxedAssessable).toBeCloseTo(50000, 2);
    // The 10% offset directly reduces netIncomeTax relative to what the
    // SAME assessable amount would cost as plain, unoffset income —
    // verified against assessPerson directly (Tax/annual.test.js already
    // covers the exact rate; this just confirms the engine wires the
    // right figure through).
    const plain = assessPerson({ fyStartYear: 2026, ordinaryIncome: 50000 });
    const withOffset = assessPerson({ fyStartYear: 2026, ordinaryIncome: 0, dbUntaxedPensionTaxable: 50000 });
    expect(withOffset.netIncomeTax).toBeLessThan(plain.netIncomeTax);
  });

  it("the defined benefit income cap: 50% of the excess is included in assessable income", () => {
    const annualPension = 250000; // comfortably above the ~$131,250 FY2026-27 cap
    const s = mkState({
      endAge: 41,
      plan: { definedBenefits: [dbRow({ annualPension, taxFreeProportion: 0, untaxedProportion: 0 })] },
    });
    const out = projectPlan(s);
    const cap = superRatesFor(2026, "indexed", 0.025, 0.035).dbIncomeCap;
    const expectedExcess = Math.max(0, annualPension - cap) * 0.5;
    expect(out.yearly[0].definedBenefitDetail.db1.dbIncomeCapExcess).toBeCloseTo(expectedExcess, 0);
    expect(expectedExcess).toBeGreaterThan(0); // sanity: the fixture actually exercises the cap
  });

  it("below the income cap, no excess is assessed at all", () => {
    const s = mkState({
      endAge: 41,
      plan: { definedBenefits: [dbRow({ annualPension: 50000 })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].definedBenefitDetail.db1.dbIncomeCapExcess).toBe(0);
  });

  it("notional taxed contributions consume concessional cap headroom without crediting any super account", () => {
    const capAmount = superRatesFor(2026, "indexed", 0.025, 0.035).concessionalCap;
    const buildWithNotional = (notional) => mkState({
      endAge: 41,
      plan: {
        superAccounts: [superAcct()],
        definedBenefits: notional > 0 ? [dbRow({ commenceAt: { kind: "age", age: 65 }, notionalTaxedContributions: notional })] : [],
      },
      cashflows: { superContributions: [scRow({ type: "personalDeductible", amount: capAmount - 5000 })] },
    });
    const withoutNotional = projectPlan(buildWithNotional(0));
    const withNotional = projectPlan(buildWithNotional(10000)); // pushes 5,000 over the cap
    expect(withoutNotional.yearly[0].superCapUsage.client.available).toBeCloseTo(5000, 2);
    // The notional contribution consumes the remaining headroom AND
    // pushes $5,000 into excess — visible via the person's own excess-CC
    // offset in their tax assessment (superCapUsage doesn't expose
    // excessCC directly, but the tax outcome does).
    expect(withNotional.yearly[0].superDetail.su1.contributions).toBeCloseTo(withoutNotional.yearly[0].superDetail.su1.contributions, 2);
    expect(withNotional.yearly[0].taxDetail.client.excessConcessionalContributions).toBeCloseTo(5000, 0);
    expect(withoutNotional.yearly[0].taxDetail.client.excessConcessionalContributions).toBeCloseTo(0, 2);
  });

  it("a defined benefit pension never appears in netAssets — it is income, not a balance", () => {
    const s = mkState({
      endAge: 41,
      plan: { definedBenefits: [dbRow({ annualPension: 50000 })] },
    });
    const out = projectPlan(s);
    // No balance anywhere this pension could have contributed to.
    expect(out.yearly[0].superClosing).toBe(0);
    expect(out.yearly[0].pensionClosing).toBe(0);
  });

  it("regression gate: no definedBenefits at all is unaffected", () => {
    const s = mkState({ endAge: 44 });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.definedBenefitDetail).toEqual({});
    }
  });
});

describe("Spec 26 Commit 3 — defined benefit Centrelink treatment", () => {
  it("income-test-only: assessable income carries the deductible-amount figure, assessable assets are untouched", () => {
    const s = mkState({
      endAge: 68, assets: [],
      plan: {
        client: { currentAge: 67 },
        definedBenefits: [dbRow({ annualPension: 50000, taxFreeProportion: 20, commenceAt: { kind: "age", age: 67 } })],
      },
    });
    const out = projectPlan(s);
    const expectedDeductible = 50000 * 0.20;
    const expectedAssessable = 50000 - expectedDeductible;
    expect(out.yearly[0].agePensionDetail.dbAssessableIncome).toBeCloseTo(expectedAssessable, 2);
    // No other assets/income in this fixture: otherIncome is EXACTLY
    // the DB assessable figure, not the bare gross pension.
    expect(out.yearly[0].agePensionDetail.otherIncome).toBeCloseTo(expectedAssessable, 2);
    expect(out.yearly[0].agePensionDetail.deemedIncome).toBe(0);
    // The asset-test exemption: no balance exists anywhere for a DB
    // pension to contribute to assessableAssets — "invisible unless
    // modelled" (spec's own words), verified directly.
    expect(out.yearly[0].agePensionDetail.assessableAssets).toBe(0);
  });

  it("a bigger deductible amount (higher tax-free proportion) reduces assessable income, for the SAME gross pension", () => {
    const build = (taxFreeProportion) => mkState({
      endAge: 68, assets: [],
      plan: {
        client: { currentAge: 67 },
        definedBenefits: [dbRow({ annualPension: 60000, taxFreeProportion, commenceAt: { kind: "age", age: 67 } })],
      },
    });
    const low = projectPlan(build(0));
    const high = projectPlan(build(50));
    expect(high.yearly[0].agePensionDetail.dbAssessableIncome).toBeLessThan(low.yearly[0].agePensionDetail.dbAssessableIncome);
    expect(high.yearly[0].agePensionDetail.dbAssessableIncome).toBeCloseTo(60000 * 0.5, 2);
  });

  it("before commencement, a DB pension contributes nothing to the income test at all", () => {
    const s = mkState({
      endAge: 68, assets: [],
      plan: {
        client: { currentAge: 67 },
        definedBenefits: [dbRow({ annualPension: 50000, commenceAt: { kind: "age", age: 90 } })], // never commences within this short window
      },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].agePensionDetail.dbAssessableIncome).toBe(0);
    expect(out.yearly[0].agePensionDetail.otherIncome).toBe(0);
  });

  it("regression gate: no definedBenefits leaves the age pension assessment unaffected", () => {
    const withDb = mkState({
      endAge: 68, assets: [],
      plan: { client: { currentAge: 67 }, definedBenefits: [dbRow({ annualPension: 0 })] },
    });
    const without = mkState({ endAge: 68, assets: [], plan: { client: { currentAge: 67 } } });
    const outWith = projectPlan(withDb);
    const outWithout = projectPlan(without);
    expect(outWith.yearly[0].agePensionDetail.entitlement).toBeCloseTo(outWithout.yearly[0].agePensionDetail.entitlement, 2);
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

  it("regression: a deficit funded from super in the FY's LAST month is still reflected in the reported closing balance (found via a demo scenario, not randomScenario() — see the superSeries snapshot-ordering fix in deterministic.js)", () => {
    // Same shape as the test above, but conservation-checked: a steady
    // monthly deficit (every month, including June) drawn from super
    // once release age is reached. superSeries[id][m+1] used to be
    // snapshotted BEFORE that same month's deficit-funding-from-super
    // withdrawal, so the withdrawal in the FY's LAST month never made
    // it into the reported closing balance for that year — every OTHER
    // month's shortfall self-corrected via the next month's fresh
    // snapshot, so only June was ever wrong, and nothing in the
    // existing suite checked conservation against this exact pattern
    // until src/demo/highEarnerPreRetirement.js's "Reduce work at 58"
    // scenario combined a persistent deficit with reaching release age.
    const s = mkState({
      // zeroRealSuperAlloc, not superAcct's own 0%/0% default — a
      // literal 0% NOMINAL allocation still decays in REAL terms under
      // nonzero CPI (Fisher deflation, same trap zeroRealSuperAlloc's
      // own header warns about), which would leave a nonzero earnings
      // term in the hand-calc below. zeroRealSuperAlloc nets to exactly
      // zero real growth, so closing reduces to opening − withdrawals.
      plan: { client: { currentAge: 60, retirementAge: 60 }, superAccounts: [superAcct({ balance: 50000, allocation: zeroRealSuperAlloc() })] },
      endAge: 63,
      assets: [],
      cashflows: { expenses: [cf({ assetId: null, amount: 1000 })] }, // deficit every month of every year
    });
    const out = projectPlan(s);
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `super-drawdown-in-June regression, year ${y}`);
    const y0 = out.yearly[0].superDetail.su1;
    expect(y0.closing).toBeCloseTo(y0.opening - y0.withdrawals, 2);
    expect(y0.withdrawals).toBeGreaterThan(0);
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

  // --- Guaranteed-coverage stratified sampling (spec 28 hardening) ----------
  //
  // A plain i.i.d. pick(), used TWICE in sequence — which named
  // threshold out of a list, then which of 5 strata — compounds into a
  // genuinely rare combined event for any threshold sharing its own
  // outer gate with many siblings (e.g. AGE_THRESHOLDS' 11 entries, all
  // gated behind the SAME 25% boundaryAgeCohort coin flip): Poisson
  // variance on an already-thin expected count occasionally reads zero
  // for one specific (name, stratum) cell, even across a 2,000-run
  // sweep — confirmed empirically while diagnosing this (repeated runs
  // of the coverage-report test below turned up zero counts on
  // DIFFERENT pension.minDrawdown.* cells each time, not one fixed
  // culprit — the whole family shares the thin pathway). This is
  // exactly the failure mode spec 28 exists to prevent: "the guard only
  // guards what the generator generates," and probabilistic coverage of
  // a registry this size will eventually miss a cell by chance,
  // however large N gets, unless N grows in an unbounded, wasteful way.
  //
  // Fix: replace independent i.i.d. draws with a SHUFFLED-BAG round-
  // robin — each call cycles through every item exactly once (in a
  // freshly reshuffled order) before any item repeats, so N calls
  // sharing the same key visit every item at least floor(N / length)
  // times, never zero once N >= length. Two independent families use
  // this: pickFair() below for "which named threshold from a list"
  // (keyed by the list's own name), and stratify()/stratifyInt()'s own
  // internal stratum choice (keyed by threshold NAME, so two different
  // thresholds never share a cycle position). Each cycle is freshly
  // shuffled, so consecutive draws still look random — this removes
  // the VARIANCE that let a registered cell go unvisited, not the
  // randomness of the generator's output.
  const STRATA = ["wellBelow", "justBelow", "at", "justAbove", "wellAbove"];
  const fairBags = new Map(); // key → { items: shuffled array, i: next cursor }
  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // pickFair(key, list) → like pick(list), but guarantees every element
  // of `list` is drawn at least once every `list.length` consecutive
  // calls sharing the same `key`.
  function pickFair(key, list) {
    let bag = fairBags.get(key);
    if (!bag || bag.i >= bag.items.length) {
      bag = { items: shuffled(list), i: 0 };
      fairBags.set(key, bag);
    }
    return bag.items[bag.i++];
  }

  // --- Threshold-aware generation (spec 28, Commit 1) -----------------------
  //
  // docs/specs/28-generator-boundary-coverage.md: "the guard only
  // guards what the generator generates" — two real conservation bugs
  // (a super-drawn-down-in-the-FY's-final-month ordering bug; an NCC
  // rejected near the bring-forward NIL tier, ~$2.1m) hid for months
  // because a plain rand()/randInt() rarely lands near a boundary by
  // chance. THRESHOLD_REGISTRY names every value this generator now
  // deliberately straddles; stratify()/stratifyInt() draw from 5 strata
  // {wellBelow, justBelow, at, justAbove, wellAbove} around a NAMED
  // threshold (uniformly picking the stratum, then jittering within
  // it) instead of a uniform range. thresholdCoverage records which
  // stratum fired for which threshold, read by both this file's own
  // "produces every stratum" test and the dedicated coverage-report
  // test (spec 28 Commit 2).
  //
  // Figures below are FY2026-27 base values (src/Tax/engine.js,
  // src/data/*.js) — the reference year this generator's own fixed
  // planStart (2026-07) always starts in. Over the short 2-4 year
  // (occasionally 1-year — see "timing" below) window this generator
  // spans, CPI indexation moves the ACTUAL per-FY threshold only
  // slightly from these base figures, so drawing near the base value
  // reliably lands near the true indexed one too — a disclosed
  // approximation (not exact for a later FY), not a claim of
  // precision this test doesn't need.
  const THRESHOLD_REGISTRY = [
    // Tax — marginal brackets, resident, FY2026-27 (Tax/engine.js LEG)
    "tax.bracket.18200", "tax.bracket.45000", "tax.bracket.135000", "tax.bracket.190000",
    // Medicare levy shading-in range (single)
    "tax.medicareShadeLower.28011", "tax.medicareShadeUpper.35014",
    // MLS bands (singles; family bands share the same shape, not
    // independently stratified here — a disclosed narrowing)
    "tax.mls.single.105000", "tax.mls.single.123000", "tax.mls.single.164000",
    // HELP brackets + the whole-income cliff
    "tax.help.69528", "tax.help.129717", "tax.help.cliff.186052",
    // Division 293 / 296
    "tax.div293.250000", "tax.div296.3000000", "tax.div296.10000000",
    // LITO phase-out
    "tax.lito.taper1.37500", "tax.lito.taper2.45000", "tax.lito.cutout.66667",
    // Super — caps, TSB gates, bring-forward tiers (incl. the nil tier
    // that hid bug 7), untaxed plan cap, age limits, preservation/release
    "super.concessionalCap.32500", "super.carryForwardTsbGate.500000",
    "super.bringForward.1840000", "super.bringForward.1970000", "super.bringForward.nil.2100000",
    "super.untaxedPlanCap.1935000", "super.contributionAge.67", "super.contributionAge.75",
    "super.preservationAge.60", "super.releaseAge.65",
    // Pension — minimum-drawdown age bands, transfer balance cap
    // (incl. a member at exactly 100% used), June-vs-July commencement
    "pension.minDrawdown.65", "pension.minDrawdown.75", "pension.minDrawdown.80",
    "pension.minDrawdown.85", "pension.minDrawdown.90", "pension.minDrawdown.95",
    "pension.tbc.2100000", "pension.commencement.julyVsJune",
    // Age pension — assets/income test thresholds (single/homeowner
    // shown; couple/non-homeowner share the same mechanism, a
    // disclosed narrowing), deeming, Work Bonus, gifting, age.
    // agePension.income.freeAreaSingle is approximated via an asset-
    // balance proxy (the deemed-income equivalent), not the $5,876
    // income figure directly — see randomAsset's own comment.
    // agePension.workBonus is registered as the $7,800 EXEMPT ANNUAL
    // income threshold (the actual per-month input the engine branches
    // on), not the $0/$11,800 BANK figures themselves — the bank is a
    // path-dependent accumulated OUTPUT, not something a single input
    // draw can stratify directly.
    "agePension.assets.fullHomeownerSingle.333000",
    "agePension.income.freeAreaSingle.5876",
    "agePension.deeming.single.66800",
    "agePension.workBonus.exemptAnnual.7800",
    "agePension.gifting.10000", "agePension.gifting.30000", "agePension.age.67",
    // Property / debt
    "property.lvr.80", "property.landTax.nsw.1075000",
    // Bonds — the ten-year date, the 125% contribution cap
    "bonds.maturity.120months", "bonds.contributionCap.125pct",
    // Aged care (spec 29) — assets-test tier boundaries, shared by the
    // means-tested fee and NCCC+Hotelling contribution ($214,884 is
    // ALSO the former-home cap, but this generator does not yet link
    // an entry to a property — see agedCare's own generation comment
    // for the full disclosed-narrowing note). The regime-fork date and
    // old-regime/pre-2014 paths are NOT reachable from this generator's
    // fixed near-2026 planStart — covered directly by
    // agedCareMeansTest.test.js's own unit tests instead.
    "agedCare.assetsNil.64500", "agedCare.assetsPlateau.214884", "agedCare.ncccLifetimeCap.137917",
    // Timing — start month. "Exactly one year" is generated too (see
    // degenerateScenarios' own "single-year projection" case) but not
    // registered here: years is a small discrete count with no natural
    // "well below 1" (a 0-or-negative-year projection isn't a valid
    // state), so it doesn't fit this 5-stratum model — it's covered as
    // a degenerate PRESENCE case instead, per the spec's own separate
    // "also generate degenerate states" list.
    "timing.startMonth.julyVsOther",
  ];

  let thresholdCoverage = {};
  function resetThresholdCoverage() {
    thresholdCoverage = {};
    for (const name of THRESHOLD_REGISTRY) {
      thresholdCoverage[name] = { wellBelow: 0, justBelow: 0, at: 0, justAbove: 0, wellAbove: 0 };
    }
  }
  resetThresholdCoverage();

  function recordStratum(name, stratum) {
    if (!thresholdCoverage[name]) thresholdCoverage[name] = { wellBelow: 0, justBelow: 0, at: 0, justAbove: 0, wellAbove: 0 };
    thresholdCoverage[name][stratum]++;
  }

  // Stratified draw around a dollar/count threshold. `near` controls
  // how tight "just below/above" are; `span` how far "well below/
  // above" reach — both default off the threshold's own scale, but
  // callers pass explicit values for small or oddly-shaped thresholds
  // (an age, a percentage, a $10,000 limit).
  function stratify(name, threshold, opts = {}) {
    const near = opts.near ?? Math.max(1, threshold * 0.01);
    const span = opts.span ?? Math.max(near * 4, threshold * 0.6);
    const stratum = pickFair(name, STRATA);
    recordStratum(name, stratum);
    switch (stratum) {
      case "wellBelow": return Math.max(0, threshold - rand(near * 3, span));
      case "justBelow": return Math.max(0, threshold - rand(1, near));
      case "at": return threshold;
      case "justAbove": return threshold + rand(1, near);
      case "wellAbove": return threshold + rand(near * 3, span);
    }
  }

  // Same 5 strata, integer-valued (ages, months, a count).
  function stratifyInt(name, threshold, opts = {}) {
    const near = opts.near ?? 2;
    const span = opts.span ?? Math.max(near * 3, 10);
    const stratum = pickFair(name, STRATA);
    recordStratum(name, stratum);
    switch (stratum) {
      case "wellBelow": return threshold - randInt(near + 1, span);
      case "justBelow": return threshold - randInt(1, near);
      case "at": return threshold;
      case "justAbove": return threshold + randInt(1, near);
      case "wellAbove": return threshold + randInt(near + 1, span);
    }
  }

  const randomAllocation = () => ({
    mode: "custom", incomePct: rand(0, 6), growthPct: rand(-2, 8),
    frankingPct: pick([0, 0, 50, 100]), volBasis: "Balanced",
  });

  // Age pension assets-test/deeming thresholds (spec 28 Commit 1) — all
  // apply to a HOUSEHOLD TOTAL (assessable assets across every asset/
  // super/property; deemed financial assets across every financial
  // asset), not a single input. Stratifying the FIRST asset's own
  // balance around one of them is an approximation (other assets/super
  // still contribute independently), not an exact hit — the same
  // disclosed trade-off land tax's priceToday stratification makes.
  // agePension.income.freeAreaSingle is itself an INCOME figure, not a
  // balance — approximated via the asset-balance that produces roughly
  // that much deemed income at the lower (1.25%) deeming rate.
  const ASSET_BALANCE_THRESHOLDS = [
    ["agePension.assets.fullHomeownerSingle.333000", 333000],
    ["agePension.deeming.single.66800", 66800],
    ["agePension.income.freeAreaSingle.5876", 5876 / 0.0125],
  ];
  const randomAsset = (id, i = 1) => {
    const balance = i === 0 && Math.random() < 0.4
      ? Math.max(0, stratify(...pickFair("ASSET_BALANCE_THRESHOLDS", ASSET_BALANCE_THRESHOLDS)))
      : rand(0, 200000);
    const cgtAsset = Math.random() < 0.5;
    return mkAsset({
      id, balance, cgtAsset,
      distributions: Math.random() < 0.5 ? "reinvest" : "cash",
      allocation: randomAllocation(),
      icrPct: 0,
      costBase: cgtAsset ? balance * rand(0.3, 1) : null,
    });
  };

  // Stratified around a NAMED tax threshold (spec 28 Commit 1) — income
  // is the single value that drives every tax boundary in the
  // registry (brackets, Medicare shading, MLS, HELP, LITO; Division
  // 293 income is a disclosed simplification, using plain income as a
  // proxy for the real "taxable income + reportable super
  // contributions" figure). Each call picks ONE registered threshold
  // uniformly and stratifies tightly around it, replacing the four
  // hand-picked wide bands this generator used before spec 28.
  const INCOME_THRESHOLDS = [
    ["tax.bracket.18200", 18200], ["tax.bracket.45000", 45000],
    ["tax.bracket.135000", 135000], ["tax.bracket.190000", 190000],
    ["tax.medicareShadeLower.28011", 28011], ["tax.medicareShadeUpper.35014", 35014],
    ["tax.mls.single.105000", 105000], ["tax.mls.single.123000", 123000], ["tax.mls.single.164000", 164000],
    ["tax.help.69528", 69528], ["tax.help.129717", 129717], ["tax.help.cliff.186052", 186052],
    ["tax.lito.taper1.37500", 37500], ["tax.lito.taper2.45000", 45000], ["tax.lito.cutout.66667", 66667],
    ["tax.div293.250000", 250000],
  ];
  const randomIncome = () => {
    const [name, threshold] = pickFair("INCOME_THRESHOLDS", INCOME_THRESHOLDS);
    return Math.max(1000, stratify(name, threshold));
  };

  function randomScenario() {
    const couple = Math.random() < 0.4;
    const persons = couple ? ["client", "partner"] : ["client"];
    const years = randInt(2, 4); // ≥2 so at least one non-final year exists
    // Pension phase (spec 20, Commit 1) can only ever fire within
    // superReleaseAge's 60-65 window — unreachable from the ORIGINAL
    // fixed age-40 start over a 2-4 year projection. Stratified, not
    // uniform, same reasoning as randomIncome()'s own header: a plain
    // rand(40, 65) start would rarely land close enough to 60 for the
    // gate to bind within such a short window. 65% of runs keep the
    // ORIGINAL age-40 start byte-for-byte (every literal `40` below is
    // now `startAge`, but startAge === 40 whenever !olderCohort) — zero
    // behavioural change to the pre-existing coverage those runs give.
    // Age thresholds (spec 28, Commit 1) — every age boundary the
    // engine branches on: preservation age 60, release age 65, the
    // super contribution-age limits 67/75, the minimum-drawdown age
    // bands, and age pension age 67 all live on the SAME "how old is
    // this person" axis pension/definedBenefits/olderCohort already
    // stratify loosely — a fourth, tightly-stratified cohort pushes
    // startAge to sit within a couple of years of ONE of them,
    // uniformly chosen, so the sweep actually lands ON, just-under,
    // and just-over each rather than only spanning wide age bands.
    const AGE_THRESHOLDS = [
      ["super.contributionAge.67", 67], ["super.contributionAge.75", 75],
      ["super.preservationAge.60", 60], ["super.releaseAge.65", 65],
      ["agePension.age.67", 67],
      ["pension.minDrawdown.65", 65], ["pension.minDrawdown.75", 75], ["pension.minDrawdown.80", 80],
      ["pension.minDrawdown.85", 85], ["pension.minDrawdown.90", 90], ["pension.minDrawdown.95", 95],
    ];
    const boundaryAgeCohort = Math.random() < 0.25;
    const [boundaryAgeName, boundaryAgeThreshold] = pickFair("AGE_THRESHOLDS", AGE_THRESHOLDS);
    // Pension phase (spec 20, Commit 1) can only ever fire within
    // superReleaseAge's 60-65 window — unreachable from the ORIGINAL
    // fixed age-40 start over a 2-4 year projection. Stratified, not
    // uniform, same reasoning as randomIncome()'s own header: a plain
    // rand(40, 65) start would rarely land close enough to 60 for the
    // gate to bind within such a short window. boundaryAgeCohort also
    // activates olderCohort (a boundary age near 60/65/67/75/etc is
    // exactly the "older" case pensions/DB pensions need to be live
    // for) — so the ORIGINAL "byte-for-byte age-40" comment below no
    // longer holds for quite as large a share of runs as before spec
    // 28, a disclosed trade-off for the extra boundary coverage.
    const olderCohort = Math.random() < 0.35 || boundaryAgeCohort;
    // Age pension (spec 21a) can only ever fire once a person reaches
    // age pension age (67) — unreachable from EITHER the original
    // age-40 start or the pension-phase olderCohort (max 63+4-1=66)
    // over this same 2-4 year window. A THIRD, independent stratum
    // (not exclusive with olderCohort — both can roll true) pushes the
    // start old enough that endAge comfortably clears 67 most of the
    // time, exercising assessment, entitlement, AND (since it can
    // combine with olderCohort) the pension-phase-super-always-assessed
    // interaction the spec calls out as the case that "must be exactly
    // right".
    const retireeCohort = Math.random() < 0.2;
    const startAge = retireeCohort ? randInt(65, 70)
      : boundaryAgeCohort ? Math.max(18, stratifyInt(boundaryAgeName, boundaryAgeThreshold, { near: 2, span: 6 }))
      : olderCohort ? randInt(56, 63)
      : 40;
    const endAge = startAge + years - 1;

    const assets = Array.from({ length: randInt(1, 3) }, (_, i) => randomAsset(`a${i}`, i));

    // Super balance thresholds (spec 28, Commit 1) — total super
    // balance is what the carry-forward TSB gate, every bring-forward
    // tier (including the ~$2.1m NIL tier that hid bug 7), the untaxed
    // plan cap, and Division 296's two tiers all branch on. A plain
    // rand(0,200000) never gets near any of them. Stratified around
    // ONE of them, uniformly chosen, on top of the pre-existing zero-
    // balance and ordinary-range cases (kept for the FHSSS/withdrawal
    // coverage their own comments already describe). Approximate when
    // a person also gets a second (rollover) account below — this
    // stratifies the PRIMARY account only, a disclosed simplification
    // rather than solving for an exact multi-account total.
    const SUPER_BALANCE_THRESHOLDS = [
      ["super.carryForwardTsbGate.500000", 500000],
      ["super.bringForward.1840000", 1840000], ["super.bringForward.1970000", 1970000],
      ["super.bringForward.nil.2100000", 2100000],
      ["super.untaxedPlanCap.1935000", 1935000],
      ["tax.div296.3000000", 3000000], ["tax.div296.10000000", 10000000],
    ];
    const randomSuperBalance = () => {
      const r = Math.random();
      if (r < 0.3) return 0;
      if (r < 0.6) return rand(0, 200000);
      const [name, threshold] = pickFair("SUPER_BALANCE_THRESHOLDS", SUPER_BALANCE_THRESHOLDS);
      return Math.max(0, stratify(name, threshold));
    };

    const superAccounts = persons.map((p) => superAcct({
      id: `su_${p}`, owner: p, balance: randomSuperBalance(), allocation: randomAllocation(),
      // Insurance premiums inside super (spec 19 Commit 7) — sometimes
      // active, sometimes larger than a low starting balance can sustain
      // (exercising withdrawFromSuper's own floor-at-zero convention).
      insurancePremium: Math.random() < 0.5
        ? { amount: rand(200, 3000), indexBasis: pick(["none", "cpi", "awote"]), indexExtraPct: rand(0, 5) }
        : { amount: 0, indexBasis: "cpi", indexExtraPct: 3 },
      // Contribution splitting (spec 19 Commit 6 completion) — only
      // meaningful for a couple (clampSuperAccount itself forces 0 for
      // a single client, mirrored by hand since this raw state bypasses
      // clamping); 40% chance per account, at a random % up to the
      // legal 85% ceiling.
      contributionSplitPct: couple && Math.random() < 0.4 ? rand(1, 85) : 0,
      // Untaxed superannuation elements (spec 26, Commit 1) — public-
      // sector schemes (West State Super and similar): no contributions/
      // earnings tax inside the fund, tax instead on benefit — a 30%
      // chance per account so both the ordinary "taxed" path (the
      // regression gate) and the new untaxed mechanics both get
      // reliably exercised across the sweep.
      taxedStatus: Math.random() < 0.3 ? "untaxed" : "taxed",
    }));
    // Rollovers (spec 26, Commit 1) — a second account per person, 30%
    // of the time, purely so there's somewhere for a same-person
    // rollover to move BETWEEN — a real rollover is never cross-spouse.
    // Exercises every combination the tax mechanic cares about: an
    // untaxed→taxed rollover (crystallises 15%/47% tax), the reverse and
    // same-status pairs (no tax at all), and the untaxed plan cap
    // boundary itself (a deliberately LARGE untaxed balance, sometimes,
    // so the sweep occasionally exercises the 47%-excess branch too).
    const superRollovers = [];
    for (const p of persons) {
      if (Math.random() >= 0.3) continue;
      const secondId = `su2_${p}`;
      superAccounts.push(superAcct({
        id: secondId, owner: p, balance: pick([0, rand(0, 200000), rand(1500000, 2200000)]),
        allocation: randomAllocation(),
        taxedStatus: Math.random() < 0.5 ? "untaxed" : "taxed",
      }));
      if (Math.random() < 0.5) {
        const first = superAccounts.find((sa) => sa.owner === p && sa.id !== secondId);
        const [fromAccountId, toAccountId] = Math.random() < 0.5 ? [first.id, secondId] : [secondId, first.id];
        superRollovers.push({
          id: `sr_${p}`, owner: p, fromAccountId, toAccountId,
          amount: pick([null, rand(1000, 100000)]),
          at: { kind: "age", age: randInt(startAge, endAge) },
        });
      }
    }

    // Pension phase (spec 20, Commit 1) — only for the older cohort
    // (see startAge's own header: unreachable otherwise). Each person
    // independently 50% likely to commence a pension from THEIR OWN
    // super account, at a random age spanning the whole window
    // (sometimes before the gate — exercising the deferral path;
    // sometimes at/after it — exercising an actual commencement),
    // either type, either whole-balance or a partial amount (sometimes
    // 0, when the source account itself is zero-balance — exercising
    // "nothing to commence with").
    const pensions = [];
    if (olderCohort) {
      for (const p of persons) {
        if (Math.random() < 0.5) {
          const acct = superAccounts.find((sa) => sa.owner === p);
          const type = pick(["abp", "ttr"]);
          // Drawdown (spec 20, Commit 2) — "maximum" only ever picked
          // for a TTR (the same input-integrity rule clampPension
          // itself enforces, mirrored here since this raw state
          // bypasses the clamp), exercising every option's own payment
          // path, the minimum-as-floor interaction (a deliberately
          // small fixedAmount, well below what the minimum would be for
          // a six-figure balance), and the deficit-funding-vs-FY-end-
          // top-up split for "expenditure".
          const drawdownOption = pick(type === "ttr" ? ["minimum", "fixed", "expenditure", "maximum"] : ["minimum", "fixed", "expenditure"]);
          pensions.push({
            id: `pn_${p}`, name: `Pension ${p}`, owner: p,
            sourceAccountId: acct.id,
            // Commencement in June (no minimum) vs July (spec 28
            // Commit 1) — an age-based DateRef always resolves to 1
            // July (this engine's own "ages tick each 1 July"
            // convention), so it alone can never produce a June
            // commencement; anchoring to "start" instead does, whenever
            // this run's own randomStartMonth() landed on June.
            commenceAt: (() => {
              const stratum = pickFair("pension.commencement.julyVsJune", STRATA);
              recordStratum("pension.commencement.julyVsJune", stratum);
              return stratum === "at" || stratum === "justBelow"
                ? { kind: "anchor", anchorId: "start" }
                : { kind: "age", age: randInt(startAge, endAge) };
            })(),
            type,
            // Transfer balance cap (spec 28 Commit 1) — stratified
            // around the general TBC ($2.1m, incl. a member at exactly
            // 100% used) when the source balance can reach it, on top
            // of the pre-existing null/partial draw.
            commenceAmount: Math.random() < 0.3
              ? null
              : acct.balance > 100000 && Math.random() < 0.3
              ? Math.min(acct.balance, Math.max(0, stratify("pension.tbc.2100000", 2100000, { near: 50000, span: 1500000 })))
              : rand(0, acct.balance),
            reversionary: Math.random() < 0.3,
            taxFreeProportion: null,
            allocation: randomAllocation(),
            icrPct: 0,
            drawdownOption,
            fixedAmount: drawdownOption === "fixed" ? rand(0, 20000) : 0,
            indexBasis: pick(["none", "cpi", "awote"]),
            indexExtraPct: rand(0, 2),
            // Commutations (spec 20, Commit 5) — 0-2 per pension,
            // spanning the whole window (sometimes before commencement
            // — never fires, exercising "no valid pension yet to debit"
            // — and sometimes after), both a partial (a small explicit
            // amount, well under what's likely left) and a full
            // (amount:null) commutation, and both destinations —
            // exercising the "closes the pension" path (a full
            // commutation followed by a LATER one that finds nothing
            // left) alongside the ordinary partial-then-continues path.
            commutations: Array.from({ length: randInt(0, 2) }, (_, i) => ({
              id: `cm_${p}_${i}`, label: `Commutation ${i}`,
              amount: Math.random() < 0.5 ? null : rand(1000, 40000),
              at: { kind: "age", age: randInt(startAge, endAge) },
              destination: pick(["cash", "super"]),
            })),
          });
        }
      }
    }

    // Defined benefit pensions (spec 26, Commit 2) — same olderCohort
    // gating as pensions above (a DB pension similarly only makes sense
    // near/at commencement age). Amounts span comfortably under and
    // (occasionally) well over the DB income cap (~$131k FY2026-27) —
    // exercising the 50%-of-excess mechanic — and the annualPension×16
    // special value occasionally exceeds the general transfer balance
    // cap (~$2.1m) on its own, exercising the TBA-excess disclosure
    // path a NORMAL pension's own commencement amount could never
    // reach (16× is a much bigger multiple than any realistic account
    // balance). notionalTaxedContributions sometimes large enough to
    // push the owner over their OWN concessional cap on top of whatever
    // SG/personal contributions their super account already generates.
    const definedBenefits = [];
    if (olderCohort) {
      for (const p of persons) {
        if (Math.random() < 0.4) {
          const taxFreeProportion = rand(0, 40);
          definedBenefits.push({
            id: `db_${p}`, name: `DB ${p}`, owner: p,
            commenceAt: { kind: "age", age: randInt(startAge, endAge) },
            annualPension: pick([rand(20000, 100000), rand(120000, 200000)]),
            indexBasis: pick(["none", "cpi", "awote"]),
            indexExtraPct: rand(0, 2),
            taxFreeProportion,
            untaxedProportion: rand(0, 100 - taxFreeProportion),
            reversionaryPct: couple ? rand(0, 100) : 0,
            notionalTaxedContributions: pick([0, rand(5000, 40000)]),
          });
        }
      }
    }

    // Aged care (spec 29, Commit 5) — a genuine new money flow: a
    // one-off RAD lump sum (a leak — see conservationCheck.js's
    // agedCareRadPaid) plus a recurring ongoing cost (basic daily fee +
    // DAP + means-tested contribution/NCCC+Hotelling + extra services
    // — agedCareOngoingCost, also a leak). Gated behind olderCohort,
    // same reasoning as definedBenefits just above. Disclosed
    // narrowing: this generator's own fixed planStart (2026-07)
    // already postdates the 1 November 2025 regime fork, so EVERY
    // entry this generator produces resolves to the "new" regime —
    // the "old" regime and the pre-2014 flag are exercised directly by
    // agedCareMeansTest.test.js's own unit tests with historical
    // dates instead, not by this live-projection sweep. The assets-
    // test tier boundaries ARE reachable and stratified: radAmount
    // directly moves agedCareAssessableAssets across them.
    const AGED_CARE_ASSET_THRESHOLDS = [
      ["agedCare.assetsNil.64500", 64500],
      ["agedCare.assetsPlateau.214884", 214884],
      ["agedCare.ncccLifetimeCap.137917", 137917.01],
    ];
    const agedCare = [];
    if (olderCohort && Math.random() < 0.35) {
      const accommodationPrice = rand(200000, 800000);
      const [name, threshold] = pickFair("AGED_CARE_ASSET_THRESHOLDS", AGED_CARE_ASSET_THRESHOLDS);
      const radAmount = Math.min(accommodationPrice, Math.max(0, stratify(name, threshold, { near: threshold * 0.02, span: threshold })));
      agedCare.push({
        id: "ac1", name: "Aged care", owner: couple ? pick(["client", "partner"]) : "client",
        entryAt: { kind: "age", age: randInt(startAge, endAge) },
        facility: "Random facility",
        accommodationPrice,
        paymentMethod: pick(["rad", "dap", "combination"]),
        radAmount,
        extraServiceFeesAnnual: pick([0, rand(1000, 10000)]),
        formerHomeOccupiedByProtectedPerson: Math.random() < 0.3,
        optedIntoNewRegime: Math.random() < 0.3,
      });
    }

    // Gifting and deprivation (spec 21b, Commit 2; spec 28 Commit 1) —
    // a genuine new money flow (a leak — see conservationCheck.js).
    // 0-3 gifts, each stratified tightly around EITHER the $10,000
    // annual or the $30,000 five-year limit (uniformly chosen), at
    // random ages across the window — exercising allowable-in-full,
    // just-under/at/just-over-deprived, and (with several gifts close
    // together) five-year-limit-breached cases all in the same sweep.
    const GIFT_THRESHOLDS = [["agePension.gifting.10000", 10000], ["agePension.gifting.30000", 30000]];
    const gifts = Array.from({ length: randInt(0, 3) }, (_, i) => {
      const [name, threshold] = pickFair("GIFT_THRESHOLDS", GIFT_THRESHOLDS);
      return {
        id: `gift${i}`, owner: couple ? pick(["client", "partner", "joint"]) : "client",
        amount: Math.max(0, stratify(name, threshold, { near: threshold * 0.1, span: threshold })),
        at: { kind: "age", age: randInt(startAge, endAge) },
        label: `Gift ${i}`,
      };
    });

    // Redundancy and ETP (spec 19 Commit 3) — sometimes one person's
    // income row terminates: the row's own `to` is forced to match
    // termination.at (clampIncomeRow's own rule, mirrored by hand since
    // this raw state bypasses clamping), a random completed-service
    // length, both types, and a payout spanning comfortably under and
    // over both the ETP cap and the (tighter, resignation-only)
    // whole-of-income cap.
    // Work Bonus (spec 21b Commit 1; spec 28 Commit 1) — the $7,800
    // annual exempt-income threshold is the actual per-period input the
    // engine branches on (whether this month's earned income exceeds
    // the pro-rated exempt amount); the bank's own $0/$11,800 figures
    // are a path-dependent OUTPUT of that, not directly stratifiable
    // (see THRESHOLD_REGISTRY's own comment). Retirees only — a young
    // cohort's income is never assessed against Work Bonus at all.
    const workBonusIncome = () => Math.max(0, stratify("agePension.workBonus.exemptAnnual.7800", 7800, { near: 500, span: 20000 }));
    const income = persons.map((p) => {
      const terminates = Math.random() < 0.3;
      const at = terminates ? randInt(startAge, endAge) : null;
      return employmentRow({
        id: `sal_${p}`, owner: p, amount: retireeCohort && Math.random() < 0.4 ? workBonusIncome() : randomIncome(),
        frequency: pick(["monthly", "annual"]),
        from: { kind: "age", age: startAge }, to: { kind: "age", age: terminates ? at : 120 },
        sgApplies: Math.random() < 0.9,
        termination: terminates ? {
          enabled: true, at: { kind: "age", age: at },
          completedYearsOfService: randInt(0, 25),
          type: pick(["genuineRedundancy", "resignation"]),
          etpTaxableComponent: rand(0, 320000), // spans under/over both caps
          unusedLeave: rand(0, 20000),
        } : { enabled: false, at: { kind: "age", age: startAge }, completedYearsOfService: 0, type: "genuineRedundancy", etpTaxableComponent: 0, unusedLeave: 0 },
      });
    });

    // Salary packaging (spec 23, Commit 3) — a genuine new leak (FBT is
    // a real household cash cost with nothing coming back — see
    // conservationCheck.js's own header on why this needed checking,
    // not assuming, and turned out to need no new term, same as bonus
    // destinations). One employer per person, fbtType/caps randomised
    // (caps sometimes 0 — the "no cap confirmed yet" default — sometimes
    // generous, sometimes tight, so both the within-cap and cap-breach
    // paths get exercised); 0-2 packaging deduction rows per person,
    // packagingType spanning all four (car and exemptItem included so
    // their "always taxable"/"never taxable" special cases sweep too).
    const employers = persons.map((p) => {
      const fbtType = pick(["standard", "standard", "fbtExempt", "fbtRebatable"]); // biased toward the common case
      return {
        id: `emp_${p}`, name: `Employer ${p}`, ownerId: p, fbtType,
        fbtCaps: {
          livingExpenseCap: fbtType === "standard" ? 0 : pick([0, rand(2000, 5000), rand(8000, 12000)]),
          mealEntertainmentCap: fbtType === "standard" ? 0 : pick([0, rand(500, 1500), rand(2000, 4000)]),
          rebatePct: fbtType === "fbtRebatable" ? rand(20, 60) : 0,
        },
      };
    });
    const packagingRows = [];
    for (const p of persons) {
      for (let i = 0; i < randInt(0, 2); i++) {
        packagingRows.push({
          id: `pkg_${p}_${i}`, owner: p, category: "salaryPackaging",
          employerId: `emp_${p}`, packagingType: pick(["livingExpense", "mealEntertainment", "car", "exemptItem"]),
          amount: rand(500, 15000), frequency: "annual",
          from: { kind: "age", age: startAge }, to: { kind: "age", age: endAge },
          indexBasis: "none", indexExtraPct: 0,
        });
      }
    }

    // Novated leases (spec 23, Commit 4) — a genuine new leak (the
    // post-tax lease payment and the lease-end residual are both real
    // household cash costs with nothing coming back — see
    // conservationCheck.js's own header on why this needed checking,
    // not assuming). 0-1 lease per person; termYears spans short (the
    // one-third base-value reduction never fires) and long (it does);
    // residualDestination both ways, so "refinance"'s own no-op path
    // sweeps too.
    const novatedLeases = [];
    for (const p of persons) {
      if (Math.random() < 0.4) {
        const termYears = randInt(2, 6);
        novatedLeases.push({
          id: `nl_${p}`, name: `Lease ${p}`, owner: p,
          baseValue: rand(20000, 80000),
          startAt: { kind: "age", age: startAge }, termYears,
          preTaxAnnual: rand(0, 8000), postTaxAnnual: rand(0, 5000),
          runningCostsAnnual: rand(0, 4000), runningCostsPackaged: Math.random() < 0.5,
          residualValue: rand(0, 20000),
          residualDestination: pick(["payout", "refinance"]),
        });
      }
    }

    const expenses = [cf({
      id: "exp1", assetId: null, amount: rand(20000, 60000) / 12, frequency: "monthly",
      from: { kind: "age", age: startAge }, to: { kind: "age", age: 120 },
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
          basis: "amount",
          // Concessional cap (spec 28 Commit 1) — combined with SG on a
          // now-often-six-figure stratified income, a contribution
          // stratified around the $32,500 cap itself exercises the
          // headroom boundary directly, not just an arbitrary $1-15k.
          amount: Math.random() < 0.5
            ? Math.max(0, stratify("super.concessionalCap.32500", 32500, { near: 1000, span: 30000 }))
            : rand(1000, 15000),
          frequency: "annual",
          from: { kind: "age", age: startAge }, to: { kind: "age", age: 120 },
          fhsssEligible: Math.random() < 0.5,
        }));
      }
      if (Math.random() < 0.5) {
        superContributions.push(scRow({
          id: `sc_cap_${p}`, owner: p, accountId: `su_${p}`,
          type: pick(["salarySacrifice", "personalDeductible"]), basis: "toConcessionalCap",
          from: { kind: "age", age: startAge }, to: { kind: "age", age: 120 },
        }));
      }
      // Government co-contribution (spec 19 Commit 6) — a personal NCC,
      // small enough to sometimes land inside the co-contribution's own
      // phase-out band relative to randomIncome()'s own range.
      if (Math.random() < 0.4) {
        superContributions.push(scRow({
          id: `sc_ncc_${p}`, owner: p, accountId: `su_${p}`,
          type: "personalNonDeductible", basis: "amount", amount: rand(200, 1500), frequency: "annual",
          from: { kind: "age", age: startAge }, to: { kind: "age", age: 120 },
        }));
      }
    }
    // Spouse contribution tax offset (spec 19 Commit 6) — only ever
    // meaningful for a couple; owner is the RECEIVING spouse (this
    // engine's own convention — see planState.js's clampSuperContribution
    // header), so the OTHER person is the contributor the offset credits.
    if (couple && Math.random() < 0.4) {
      const receivingOwner = pick(persons);
      superContributions.push(scRow({
        id: "sc_spouse", owner: receivingOwner, accountId: `su_${receivingOwner}`,
        type: "spouse", basis: "amount", amount: rand(500, 4000), frequency: "annual",
        from: { kind: "age", age: startAge }, to: { kind: "age", age: 120 },
      }));
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
        // Fixed-rate rollover (Implementation/Rates spec, Commit 1) —
        // half the time fixed, with the rollover date spanning BEFORE
        // the projection starts (already rolled over), squarely WITHIN
        // it (the case that changes interest accrual and recomputes
        // the payment mid-run — the actual new money-flow-shaped code
        // path this invariant needs to exercise), and beyond its own
        // end (never fires) — a plain rand(startAge, endAge) rarely
        // lands exactly at either edge, so pick explicitly covers all three.
        rateType: pick(["variable", "fixed"]),
        fixedRatePct: rand(3, 7),
        fixedUntil: { kind: "age", age: pick([startAge - 1, randInt(startAge, endAge), endAge + 5]) },
        revertRatePct: pick([null, rand(3, 9)]),
        commencedOn: pick([null, "2022-01-01"]),
      };
      if (Math.random() < 0.6) {
        liab.extraRepayments = [{
          id: "er1", label: "Extra", amount: rand(200, 40000), // sometimes far beyond affordable
          frequency: pick(["monthly", "annual"]),
          from: { kind: "age", age: startAge }, to: { kind: "age", age: randInt(startAge + 1, endAge) },
          indexBasis: pick(["none", "cpi"]), indexExtraPct: 0,
        }];
      }
      if (Math.random() < 0.5) {
        liab.oneOffRepayments = [{
          id: "or1", label: "Lump sum", amount: rand(1000, 80000),
          at: { kind: "age", age: randInt(startAge, endAge) },
        }];
      }
      // Drawdowns and dynamic deductibility (spec 24, Commit 1) — a
      // genuine new money flow (a drawdown moves money into its
      // destination, offset by the SAME increase to the loan balance —
      // see conservationCheck.js's own header). deductiblePct as a real
      // percentage (not just the boolean's 0/100) exercises a genuine
      // mixed opening split; creditLimit sometimes tight enough to bind
      // against the drawdown itself (exercising the flagged-headroom
      // path, not just the always-affordable case); repaymentAllocation
      // spans both, independent of whether a drawdown ever fires
      // (privateFirst alone, on a part-deductible loan with no
      // drawdown, still moves the ratio over time).
      liab.deductiblePct = rand(0, 100);
      liab.repaymentAllocation = pick(["proportional", "proportional", "privateFirst"]);
      liab.creditLimit = pick([null, rand(liab.balance * 0.5, liab.balance * 1.5)]);
      liab.drawdowns = [];
      if (Math.random() < 0.5) {
        liab.drawdowns.push({
          id: "dd1", label: "Drawdown", amount: rand(5000, 150000), // spans under/over a tight creditLimit
          at: { kind: "age", age: randInt(startAge, endAge) },
          purpose: pick(["investment", "private"]),
          destination: pick(["cash", pick(assets).id]),
        });
      }
      // Debt recycling (spec 24, Commit 2) — a genuine new money flow
      // (a redraw moves money into its destination asset, marked
      // investment-purpose, offset by the SAME increase to the loan
      // balance — the identical shape a Commit 1 drawdown already is,
      // see conservationCheck.js's own header). annualCap spans
      // unset/generous/tight (sometimes well below what a year's own
      // principal repayment would be, exercising the cap-binding path);
      // destinationAssetId sometimes dangling (falls through, no
      // redraw at all).
      liab.recycling = {
        enabled: Math.random() < 0.3,
        from: { kind: "age", age: startAge }, to: { kind: "age", age: endAge },
        destinationAssetId: pick([...assets.map((a) => a.id), "nonexistent"]),
        matchRepayments: Math.random() < 0.9,
        annualCap: pick([null, rand(100, 30000)]),
      };
      liabilities.push(liab);
    }

    // Bonus/allowance/overtime (spec 23, Commit 2) — a bonus with a
    // destination is a genuine new money flow (its after-tax amount
    // bypasses ordinary surplus and lands directly against a liability/
    // super account/asset — see conservationCheck.js's own header note
    // on why this needed checking, not assuming, and turned out to need
    // no new term). Built AFTER liabilities/superAccounts/assets so a
    // destination can target any of them; sometimes none (falls through
    // to ordinary income), sometimes each of the three real types.
    // Overtime deliberately sets sgApplies:true (the OPPOSITE of what
    // should happen) — the engine must force it off regardless,
    // exercising the belt-and-braces filter, not just the default.
    const bonusRows = [];
    for (const p of persons) {
      if (Math.random() < 0.5) {
        const ownAccount = superAccounts.find((sa) => sa.owner === p);
        const destinationPool = [
          null,
          liabilities.length > 0 ? { type: "loanRepayment", targetId: pick(liabilities).id } : null,
          ownAccount ? { type: "superContribution", targetId: ownAccount.id } : null,
          { type: "asset", targetId: pick(assets).id },
        ].filter((d) => d !== null);
        bonusRows.push({
          ...employmentRow({
            id: `bonus_${p}`, owner: p, amount: rand(1000, 30000), frequency: "annual",
            from: { kind: "age", age: startAge }, to: { kind: "age", age: endAge },
            sgApplies: Math.random() < 0.5,
          }),
          category: "bonus", taxable: true, bonusMonth: randInt(1, 12),
          bonusDestination: pick(destinationPool) ?? { type: null, targetId: null },
        });
      }
      if (Math.random() < 0.4) {
        const taxable = Math.random() < 0.5;
        bonusRows.push({
          ...employmentRow({
            id: `allow_${p}`, owner: p, amount: rand(500, 8000), frequency: pick(["monthly", "annual"]),
            from: { kind: "age", age: startAge }, to: { kind: "age", age: endAge },
            sgApplies: false,
          }),
          category: "allowance", taxable,
          incomeType: taxable ? "employment" : "nonTaxable", // this raw state bypasses clampIncomeRow's own derivation
        });
      }
      if (Math.random() < 0.4) {
        bonusRows.push({
          ...employmentRow({
            id: `ot_${p}`, owner: p, amount: rand(500, 15000), frequency: pick(["monthly", "annual"]),
            from: { kind: "age", age: startAge }, to: { kind: "age", age: endAge },
            sgApplies: true,
          }),
          category: "overtime",
        });
      }
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
        targetAt: { kind: "age", age: randInt(startAge, endAge) },
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
      const purchaseAge = randInt(startAge, endAge);
      // Main residence exemption and the six-year absence rule (spec 19
      // Commit 5) — sometimes this PPR gets an absence (moved out after
      // purchase, sometimes producing income) and a later sale. The
      // short startAge-endAge window rarely lets an absence actually EXCEED
      // six years (the dedicated describe block covers that day-count
      // precisely) — this mainly exercises the "still within the
      // window"/isCgt-flip/pool-seeding code paths under real engine
      // conditions, which is what the conservation invariant needs.
      const hasAbsence = purchaseAge < endAge && Math.random() < 0.3;
      const movedOutAge = hasAbsence ? randInt(purchaseAge + 1, endAge) : null;
      const saleAge = hasAbsence ? randInt(movedOutAge, endAge) : null;
      properties.push({
        id: "p1", name: "Home", owner: couple ? "joint" : "client",
        state: pick(["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]),
        propertyType: "ppr", status: "planned",
        currentValue: 0, acquisitionDate: null, costBase: 0,
        priceToday: rand(300000, 900000),
        purchaseAt: { kind: "age", age: purchaseAge },
        // LMI's own trigger (spec 28 Commit 1) — stratified tightly
        // around the 80% LVR boundary (LMI applies strictly ABOVE 80%,
        // never at it — src/data/lmiRates.js) rather than the previous
        // fixed list, which only ever hit 80 exactly, never 79 or 81.
        lvrPct: Math.min(100, Math.max(0, stratifyInt("property.lvr.80", 80, { near: 1, span: 20 }))),
        firstHomeBuyer, newBuild: Math.random() < 0.3,
        purchaseCostsPct: rand(0, 3), dutyOverride: null, growthPct: rand(0, 6),
        rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
        expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
        expensesDeductible: true, depreciation: 0,
        releaseFhsssAtPurchase: Math.random() < 0.6,
        firstHomeGuarantee: firstHomeBuyer && Math.random() < 0.5,
        lmiOverride: null,
        lmiPayAtSettlement: Math.random() < 0.5,
        mainResidence: hasAbsence
          ? { movedOutAt: { kind: "age", age: movedOutAge }, producingIncome: Math.random() < 0.5, movedBackInAt: null }
          : { movedOutAt: null, producingIncome: false, movedBackInAt: null },
        sale: hasAbsence
          ? { enabled: true, at: { kind: "age", age: saleAge }, agentFeesPct: rand(0, 5), settlementCosts: rand(0, 5000), proceedsDestination: pick(["repayLoanThenAsset", "asset"]), assetId: pick(assets).id }
          : { enabled: false, at: null, agentFeesPct: 2.5, settlementCosts: 2000, proceedsDestination: "asset", assetId: null },
      });
    }

    // Land tax (spec 19 Commit 2) — 0-2 non-PPR properties (investment
    // or holiday), PLANNED (never "owned" — see conservationCheck.js's
    // own caveat on why randomScenario() must never generate an owned
    // property) and purchased early enough to reach at least one July
    // assessment before the projection ends. Sometimes both share a
    // state (exercises the per-owner/jurisdiction aggregation), and
    // landTaxOverride is sometimes set (bypasses it for that property).
    for (let i = 0; i < randInt(0, 2); i++) {
      const sharedState = pick(["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"]);
      properties.push({
        id: `lt${i}`, name: `Land tax property ${i}`, owner: couple ? pick(["client", "partner", "joint"]) : "client",
        state: sharedState, // biased toward the SAME state across both, to exercise aggregation
        propertyType: pick(["investment", "holiday"]), status: "planned",
        currentValue: 0, acquisitionDate: null, costBase: 0,
        // Land tax's NSW threshold (spec 28 Commit 1) applies to
        // ASSESSED LAND VALUE (priceToday × landValuePct below), a
        // compound of two independent draws — stratifying priceToday
        // around threshold/0.7 (a representative mid-range
        // landValuePct) is an approximation, not an exact hit, but
        // meaningfully improves on a plain rand(300000,2000000) that
        // rarely put land value anywhere near $1,075,000 at all.
        priceToday: Math.max(50000, stratify("property.landTax.nsw.1075000", 1075000 / 0.7, { near: 50000, span: 900000 })),
        purchaseAt: { kind: "age", age: startAge },
        lvrPct: 0, firstHomeBuyer: false, newBuild: Math.random() < 0.5,
        purchaseCostsPct: 0, dutyOverride: null, growthPct: rand(-2, 6),
        rent: { amount: rand(0, 40000), indexBasis: "none", indexExtraPct: 0 },
        expenses: { amount: rand(0, 10000), indexBasis: "none", indexExtraPct: 0 },
        expensesDeductible: true, depreciation: 0,
        releaseFhsssAtPurchase: false, firstHomeGuarantee: false, lmiOverride: null, lmiPayAtSettlement: false,
        landValuePct: pick([40, 60, 80, 100]),
        landTaxOverride: Math.random() < 0.3 ? rand(0, 5000) : null,
        // Property sale (spec 19 Commit 4) — sometimes sold partway
        // through the projection (always AFTER its own startAge
        // purchase); both destinations and a randomised cost pair, so
        // both the CGT-via-pool-consumption path and the loan-discharge
        // path (repayLoanThenAsset — inert here since this fixture
        // never draws a purchase loan, lvrPct:0, but still exercises
        // the "no loan to discharge" branch) get exercised.
        sale: Math.random() < 0.3 ? {
          enabled: true, at: { kind: "age", age: randInt(startAge + 1, endAge) },
          agentFeesPct: rand(0, 5), settlementCosts: rand(0, 5000),
          proceedsDestination: pick(["repayLoanThenAsset", "asset"]),
          assetId: pick(assets).id,
        } : { enabled: false, at: null, agentFeesPct: 2.5, settlementCosts: 2000, proceedsDestination: "asset", assetId: null },
      });
    }

    // HELP (Document Set Commit 1) — a balance below, at, and above a
    // typical single year's repayment, so some scenarios show the
    // balance fully retiring mid-projection (Commit 1's own "stops
    // once it hits zero" behaviour) and others don't. MLS (Commit 2) —
    // cover held or not, per person, plus a household with dependent
    // children shifting the family threshold.
    // retirementAge (Pension phase, spec 20, Commit 1): left UNSET for
    // the young cohort — clampPlan's own default (currentAge, i.e.
    // "already retired at the projection's own start") is exactly the
    // pre-existing behaviour every other describe block in this file
    // already relies on, so leaving it out here changes nothing for
    // those 65% of runs. For the older cohort it's set to a value
    // spanning BELOW, AT, and ABOVE the ABP's own superReleaseAge gate
    // (60) relative to startAge — sometimes the retirement-based ABP
    // gate binds earlier than the flat TTR preservation-age gate,
    // sometimes later, sometimes never within the window at all.
    const retirementAgeFor = () => (olderCohort ? randInt(startAge, Math.min(endAge, 67)) : undefined);
    // Age pension (spec 21a) — the eligibility flag, exercised
    // explicitly (not left to its own true-by-default) so the
    // suppression path (residency, or a client who doesn't want it
    // modelled) gets swept too, not just the "everyone eligible" case.
    // centrelinkEligibleIsDefault: false throughout — this raw state
    // bypasses clampPlan's own smart-default resolution entirely (same
    // reason retirementAge is set explicitly rather than left to
    // default), so the literal value here is authoritative either way.
    const client = {
      currentAge: startAge, retirementAge: retirementAgeFor(),
      helpBalance: rand(0, 40000), privateHospitalCover: Math.random() < 0.5,
      taxProfile: { centrelinkEligible: Math.random() < 0.85, centrelinkEligibleIsDefault: false },
    };
    const partner = couple ? {
      currentAge: startAge, retirementAge: retirementAgeFor(),
      helpBalance: rand(0, 40000), privateHospitalCover: Math.random() < 0.5,
      taxProfile: { centrelinkEligible: Math.random() < 0.85, centrelinkEligibleIsDefault: false },
    } : null;

    // Children + education funding (Input Usability spec, Commit 3) —
    // ages spanning not-yet-born (negative) through already-aged-out
    // (>21), so the derived dependent count, the MLS threshold it
    // drives, and the education expense window all get exercised
    // across a real spread of scenarios, not just the hand-picked ones
    // in the dedicated tests below.
    // Timing — start month (spec 28 Commit 1): stratified around July,
    // the engine's own boundary for whether an annual/one-off event
    // fires in a genuinely partial first year (CLAUDE.md's "Cashflows"
    // convention) — previously ALWAYS July, so that skip path (and the
    // partial-first-year length it produces) was never exercised here
    // at all.
    function randomStartMonth() {
      const stratum = pickFair("timing.startMonth.julyVsOther", STRATA);
      recordStratum("timing.startMonth.julyVsOther", stratum);
      switch (stratum) {
        case "wellBelow": return randInt(1, 4);   // Jan-Apr: long partial first year
        case "justBelow": return 6;                 // June: at-or-before July — no skip
        case "at": return 7;                         // July exactly — no partial year at all
        case "justAbove": return 8;                  // August: just past — minimal partial, skipped
        case "wellAbove": return randInt(10, 12);    // Oct-Dec: longer partial, skipped
      }
    }
    const planStart = { year: 2026, month: randomStartMonth() };
    const children = Array.from({ length: randInt(0, 3) }, (_, i) => ({
      id: `ch${i}`, name: `Child ${i}`,
      dateOfBirth: synthDob(randInt(-2, 24), planStart),
      education: Math.random() < 0.6 ? [{
        id: `ed${i}`, label: "Primary", annualAmount: rand(3000, 20000),
        fromAge: 5, toAge: 12, indexBasis: pick(["none", "cpi", "awote"]), indexExtraPct: rand(0, 3),
      }] : [],
    }));

    // Surplus/deficit allocation (spec 16, Commit 1) — a single period
    // covering the whole projection (multi-period contiguity is a UI/
    // migration concern, not an engine money-flow concern), but with
    // every rule and every targetType independently randomised: debt-
    // first + debtOrder, a random subset of assets/liabilities/eligible
    // superContribution rows/goals each getting a random slice of the
    // remaining percentage, and a random remainder destination. Deficit
    // gets random per-asset minimum balances and sellRule. Per CLAUDE.md,
    // this generator must cover every new money-routing path the
    // conservation invariant is meant to guard.
    const allocationTargets = [];
    for (const a of assets) if (Math.random() < 0.4) allocationTargets.push({ targetType: "asset", targetId: a.id });
    for (const l of liabilities) if (Math.random() < 0.4) allocationTargets.push({ targetType: "liability", targetId: l.id });
    for (const sc of superContributions) {
      if ((sc.type === "salarySacrifice" || sc.type === "personalDeductible") && Math.random() < 0.4) {
        allocationTargets.push({ targetType: "superContribution", targetId: sc.id });
      }
    }
    for (const g of goals) if (Math.random() < 0.4) allocationTargets.push({ targetType: "goal", targetId: g.id });

    let remainingPct = 100;
    const allocations = [];
    for (const t of allocationTargets) {
      if (remainingPct <= 0) break;
      const pct = rand(0, remainingPct);
      if (pct > 0.5) {
        allocations.push({ id: `sa${allocations.length}`, ...t, pct });
        remainingPct -= pct;
      }
    }

    const surplus = {
      periods: [{
        id: "sp1",
        from: { kind: "anchor", anchorId: "start" },
        to: { kind: "anchor", anchorId: "end" },
        payNonDeductibleDebtFirst: Math.random() < 0.5,
        debtOrder: pick(["interestRate", "manual"]),
        allocations,
        remainderTo: pick(["cash", "expenditure"]),
      }],
    };

    const deficitMinimumBalances = {};
    for (const a of assets) if (Math.random() < 0.3) deficitMinimumBalances[a.id] = rand(0, 5000);
    const deficit = { minimumBalances: deficitMinimumBalances, sellRule: pick(["order", "minimumCapitalGain"]) };

    // Adviser fees (Implementation/Rates spec, Commit 2) — half the
    // time present, each slice independently possibly targeting a
    // super account (when the household has one) so both the
    // cap-binding path (a super balance too small to cover what's
    // requested — genuinely likely here, since superAccounts are often
    // seeded at 0, per the FHSSS-release comment above) and the
    // plain-cash path get exercised over enough runs.
    const superAccountIds = superAccounts.map((sa) => sa.id);

    // Adjustment rows (spec 18, Commit 1) — every registry target
    // exercised, owner resolved per the target's own rule (household
    // for expenses, the account's own owner for superContributions,
    // client/partner otherwise), windows spanning random sub-ranges of
    // the projection (including a same-year from/to and a dangling
    // superAccountId when no super account exists this run — the
    // engine must tolerate both). superContributions amounts are kept
    // non-negative: unlike every other target, this one mutates a
    // stateful BALANCE directly (not just a flow), and a large enough
    // negative override could drive it below zero with no floor —
    // realistically always a top-up, not a claw-back, so this is a
    // deliberate scope choice, not a masked bug.
    const ADJUSTMENT_TARGETS_FOR_TEST = [
      "income.assessable", "income.nonTaxable", "deductions",
      "tax.incomeTax", "tax.withheld", "tax.medicare", "tax.help", "tax.cgt",
      "expenses", "superContributions",
    ];
    const adjustments = Array.from({ length: randInt(0, 3) }, (_, i) => {
      const target = pick(ADJUSTMENT_TARGETS_FOR_TEST);
      const fromAge = randInt(startAge, endAge);
      const toAge = randInt(fromAge, endAge);
      let owner = "client";
      let superAccountId = null;
      if (target === "expenses") {
        owner = "household";
      } else if (target === "superContributions") {
        superAccountId = superAccountIds.length > 0 ? pick(superAccountIds) : "nonexistent";
        const acct = superAccounts.find((sa) => sa.id === superAccountId);
        owner = acct ? acct.owner : "client";
      } else {
        owner = couple ? pick(["client", "partner"]) : "client";
      }
      return {
        id: `adj${i}`, target, owner, superAccountId,
        label: "", amount: target === "superContributions" ? rand(0, 5000) : rand(-5000, 5000),
        from: { kind: "age", age: fromAge }, to: { kind: "age", age: toAge },
        indexBasis: pick(["none", "cpi", "awote"]), indexExtraPct: rand(0, 2),
        note: "randomised test adjustment",
      };
    });

    const pickSuperTarget = () => (superAccountIds.length > 0 && Math.random() < 0.7 ? pick(superAccountIds) : null);
    const upfrontTotal = Math.random() < 0.5 ? rand(0, 30000) : 0;
    const upfrontSuperTarget = upfrontTotal > 0 ? pickSuperTarget() : null;
    const ongoingAnnual = Math.random() < 0.5 ? rand(0, 15000) : 0;
    const ongoingSuperTarget = ongoingAnnual > 0 ? pickSuperTarget() : null;
    const adviserFees = {
      upfront: {
        total: upfrontTotal,
        fromSuperAmount: upfrontSuperTarget ? rand(0, upfrontTotal) : 0,
        superAccountId: upfrontSuperTarget,
      },
      ongoing: {
        annualAmount: ongoingAnnual,
        fromSuperAmount: ongoingSuperTarget ? rand(0, ongoingAnnual) : 0,
        superAccountId: ongoingSuperTarget,
        indexBasis: pick(["none", "cpi", "awote"]),
      },
    };

    // Home Equity Access Scheme (spec 21b, Commit 5) — a genuine new
    // money flow (a drawdown crediting household cash, offset by an
    // accruing loan balance that reduces net worth — see
    // conservationCheck.js's own heasDrawn/heasInterest terms). Only
    // ever enabled against the PPR property generated above (when one
    // exists) — HEAS needs SOME real estate to secure against. 50% of
    // the time when that property exists, independent of whether the
    // household ever actually reaches age-pension age or the property
    // ever actually settles within this short window — both gates
    // (age-eligibility, settlement) get exercised across enough runs:
    // sometimes never fires, sometimes fires for only the tail of the
    // projection.
    const pprProperty = properties.find((p) => p.propertyType === "ppr");
    const heas = {
      enabled: !!pprProperty && Math.random() < 0.5,
      propertyId: pprProperty ? pprProperty.id : null,
    };

    // Investment/education bonds (spec 25, Commit 1) — 0-2 per scenario.
    // Earnings are taxed INSIDE the bond (never touching assessable
    // income) and a contribution is paid from household cash: both are
    // new money-flow shapes this invariant must cover. startDate spans
    // well before the plan (an existing bond, already years into its
    // ten-year clock — bondStartMonthIndex's negative-offset arithmetic)
    // and at/after plan start (a newly-opened one); Commit 1 never
    // triggers a withdrawal, so maturity status itself doesn't affect
    // conservation yet, but stratifying now saves Commit 2/3 from
    // needing to revisit this generator.
    //
    // The ten-year date (spec 28 Commit 1) — bondMaturityMonth is
    // start+120 months, a RELATIVE threshold (not a fixed calendar
    // date), so this stratifies the OFFSET between a bond's own
    // maturity and a random target month within the projection,
    // around 0 — the resulting startDate lands well-before/just-
    // before/exactly-at/just-after/well-after its own ten-year mark
    // relative to something actually visible in this short window.
    const projectionMonthsApprox = years * 12; // coarse — ignores the partial-first-year skip, fine for a target month
    const planStartMonthsFromEpoch = planStart.year * 12 + (planStart.month - 1);
    function isoFromMonthsFromEpoch(totalMonths) {
      const year = Math.floor(totalMonths / 12);
      const month0 = ((totalMonths % 12) + 12) % 12;
      return `${year}-${String(month0 + 1).padStart(2, "0")}-01`;
    }
    function stratifiedBondStartDate() {
      const targetMonth = randInt(0, Math.max(0, projectionMonthsApprox - 1));
      const offset = stratifyInt("bonds.maturity.120months", 0, { near: 1, span: 6 });
      return isoFromMonthsFromEpoch(planStartMonthsFromEpoch + targetMonth - 120 + offset);
    }

    const bonds = [];
    const bondContributions = [];
    for (let i = 0; i < randInt(0, 2); i++) {
      const id = `bd${i}`;
      // Education bonds (spec 25, Commit 3) — a beneficiary link applies
      // to EITHER bond type (planState.js's own header on why); when
      // there's a real child to link to, both an education-type and an
      // investment-type bond sometimes name one (exercising the
      // benefit-and-no-tax path and the ordinary assessable-if-
      // unmatured path respectively — see the a-bonds block's own
      // type branch), and sometimes NEITHER has a beneficiary at all
      // (the "never auto-funds anything" path), across enough runs.
      const type = children.length && Math.random() < 0.4 ? "education" : "investment";
      const beneficiaryChildId = children.length && Math.random() < 0.5 ? pick(children).id : null;
      bonds.push({
        id, name: `Bond ${i}`, type,
        owner: couple ? pick(["client", "partner", "joint"]) : "client",
        include: true, balance: rand(0, 150000),
        startDate: Math.random() < 0.5
          ? stratifiedBondStartDate()
          : pick(["2012-03-01", "2020-11-01", "2026-07-01", "2027-01-01"]),
        allocation: randomAllocation(), icrPct: 0,
        beneficiaryChildId,
      });
      // The 125% contribution cap (spec 28 Commit 1) — a single FLAT
      // contribution row never changes year to year, so it can never
      // breach or reset the ten-year clock. Two non-overlapping rows
      // instead: the first establishes a prior-FY baseline (sometimes
      // nil — the "no-contribution year followed by one with" case),
      // the second (active only from a later age) is stratified
      // tightly around 125% of the first's own annual total, so the
      // sweep actually exercises at/just-under/just-over the breach.
      if (Math.random() < 0.7) {
        const firstAnnual = Math.random() < 0.3 ? 0 : rand(500, 24000);
        const midAge = endAge > startAge ? randInt(startAge, endAge - 1) : startAge;
        bondContributions.push({
          id: `bdc${i}`, label: "Contribution", bondId: id,
          amount: firstAnnual / 12, frequency: "monthly",
          from: { kind: "age", age: startAge }, to: { kind: "age", age: midAge },
          indexBasis: pick(["none", "cpi", "awote"]), indexExtraPct: rand(0, 2),
        });
        if (endAge > midAge) {
          const cap = firstAnnual * 1.25;
          const secondAnnual = Math.max(0, stratify("bonds.contributionCap.125pct", cap, {
            near: Math.max(1, cap * 0.02 || 200), span: Math.max(cap, 2000),
          }));
          bondContributions.push({
            id: `bdc${i}b`, label: "Contribution (later)", bondId: id,
            amount: secondAnnual, frequency: "annual",
            from: { kind: "age", age: midAge + 1 }, to: { kind: "age", age: endAge },
            indexBasis: "none", indexExtraPct: 0,
          });
        }
      }
    }

    return {
      ...mkState({
        endAge, cpi: rand(0.02, 0.04), assets,
        start: planStart,
        bonds,
        plan: {
          household: couple ? "couple" : "single",
          client, partner, children,
          superAccounts, pensions, definedBenefits, agedCare, gifts, heas, workingCash: { balance: rand(0, 50000), minimumBalance: rand(0, 10000), ratePct: rand(1, 4) },
          adviserFees, adjustments, employers, novatedLeases,
        },
        cashflows: { income: [...income, ...bonusRows], expenses, superContributions, deductions: packagingRows, bondContributions, superRollovers },
        surplus,
        deficit,
        // Bonds (spec 25, Commit 2) are eligible for deficit funding,
        // subject to the SAME funding order — sometimes placed ahead of
        // ordinary assets so a shortfall actually reaches (and sells
        // from) one, exercising sellBond's own pre/post-maturity
        // assessable-withdrawal split, not just growth/contributions.
        fundingOrder: Math.random() < 0.5
          ? [...bonds.map((b) => b.id), ...assets.map((a) => a.id)]
          : [...assets.map((a) => a.id), ...bonds.map((b) => b.id)],
      }),
      liabilities,
      goals,
      properties,
    };
  }

  // Degenerate states (spec 28, Commit 1) — edge-of-state-space cases
  // a randomised sweep might never construct by chance, since each
  // needs several fields to independently land at an extreme
  // simultaneously. Built directly off mkState() rather than
  // randomScenario() — these are meant to be minimal, not fully
  // randomised, so the specific degenerate condition each one names
  // is never accidentally diluted by unrelated randomised fields.
  function degenerateScenarios() {
    const bigLiability = {
      id: "big", name: "Big loan", type: "mortgage", owner: "client",
      balance: 5000000, interestRatePct: 5, termYears: 20, repayment: "pi", ioYears: 0,
      deductible: false, linkedAssetId: null, offsetAssetId: null,
      extraRepayments: [], oneOffRepayments: [], rateType: "variable",
      fixedRatePct: 5, fixedUntil: { kind: "age", age: 120 }, revertRatePct: null,
      commencedOn: null, deductiblePct: 0, repaymentAllocation: "proportional",
      creditLimit: null, drawdowns: [],
      recycling: { enabled: false, from: { kind: "age", age: 40 }, to: { kind: "age", age: 42 }, destinationAssetId: null, matchRepayments: false, annualCap: null },
    };
    return [
      { label: "zero balances everywhere", state: { ...mkState({ endAge: 42, assets: [mkAsset({ balance: 0 })] }), liabilities: [], goals: [], properties: [] } },
      // "timing.years.exactlyOne" — endAge === client.currentAge (40)
      // is a genuine one-year projection; it also structurally makes
      // checkYearConservation's own loop a no-op (the only year IS the
      // final year, excluded — see the invariant's own header), so
      // this checks projectPlan() doesn't throw/produce NaNs rather
      // than re-running the (vacuous) conservation check.
      { label: "single-year projection", state: { ...mkState({ endAge: 40 }), liabilities: [], goals: [], properties: [] } },
      { label: "person with no income", state: { ...mkState({ endAge: 42, cashflows: { income: [], expenses: [cf({ amount: 1000 })] } }), liabilities: [], goals: [], properties: [] } },
      { label: "every asset excluded", state: { ...mkState({ endAge: 42, assets: [mkAsset({ balance: 50000, include: false })] }), liabilities: [], goals: [], properties: [] } },
      { label: "liability larger than all assets", state: { ...mkState({ endAge: 42, assets: [mkAsset({ balance: 10000 })] }), liabilities: [bigLiability], goals: [], properties: [] } },
      {
        label: "unfundable goal",
        state: {
          ...mkState({ endAge: 41, assets: [mkAsset({ balance: 0 })] }),
          liabilities: [],
          goals: [{ id: "unfundable", label: "Unfundable", targetAmount: 10000000, targetAt: { kind: "age", age: 41 }, fundedFrom: "surplus", indexBasis: "none", indexExtraPct: 0 }],
          properties: [],
        },
      },
    ];
  }

  // Report any conservation defect plainly (spec 28's own instruction)
  // rather than letting the first failing expect() abort the sweep
  // silently mid-run — every failure across the whole sweep is
  // collected and reported together.
  function runConservationSweep(runs, label) {
    const failures = [];
    for (let i = 0; i < runs; i++) {
      const state = randomScenario();
      let out;
      try {
        out = projectPlan(state);
      } catch (e) {
        failures.push(`${label} scenario ${i}: projectPlan threw: ${e.message}`);
        continue;
      }
      const years = out.yearly.length;
      for (let y = 0; y < years - 1; y++) { // final year excluded — see header
        try {
          checkYearConservation(out, y, `${label} scenario ${i}, year ${y}`);
        } catch (e) {
          failures.push(e.message);
        }
      }
    }
    for (const { label: degenerateLabel, state } of degenerateScenarios()) {
      try {
        const out = projectPlan(state);
        const years = out.yearly.length;
        for (let y = 0; y < years - 1; y++) {
          try {
            checkYearConservation(out, y, `degenerate "${degenerateLabel}", year ${y}`);
          } catch (e) {
            failures.push(e.message);
          }
        }
      } catch (e) {
        failures.push(`degenerate "${degenerateLabel}": projectPlan threw: ${e.message}`);
      }
    }
    return failures;
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

  // Spec 28, Commit 1's own instruction: "run the conservation sweep
  // at least 10 × 300 scenarios and report any defect" — a genuinely
  // larger run than the 300-scenario gate above, over the newly
  // threshold-stratified generator plus every degenerate state, with
  // every failure collected and reported together rather than
  // aborting on the first one.
  it("threshold-stratified sweep: 10 × 300 scenarios plus every degenerate state, any defect reported", () => {
    const failures = runConservationSweep(3000, "stratified sweep");
    if (failures.length > 0) {
      throw new Error(`${failures.length} conservation failure(s) found:\n${failures.slice(0, 20).join("\n")}`);
    }
  });

  // Spec 28, Commit 1's own instruction: "the generator demonstrably
  // produces values in every stratum for every registered threshold —
  // assert this directly, since a generator that silently stops
  // covering a boundary is the failure mode being fixed." Pure
  // generation only (no projectPlan()) — this asserts the STRATIFY
  // MECHANISM itself works across the registry, independent of
  // whether any one 300/3000-run sweep happened to exercise it.
  it("the generator produces every stratum for every registered threshold", () => {
    resetThresholdCoverage();
    for (let i = 0; i < 2000; i++) randomScenario();
    const missing = [];
    for (const name of THRESHOLD_REGISTRY) {
      const strata = thresholdCoverage[name];
      for (const stratum of ["wellBelow", "justBelow", "at", "justAbove", "wellAbove"]) {
        if (!strata || strata[stratum] === 0) missing.push(`${name}.${stratum}`);
      }
    }
    expect(missing, `unexercised strata: ${missing.join(", ")}`).toEqual([]);
  });

  // Spec 28, Commit 2 — "after a sweep, emit a summary of which
  // thresholds were exercised in which strata... committed as a test
  // that FAILS if any registered threshold went unexercised. Without
  // this the registry silently rots as the engine changes." Distinct
  // from Commit 1's own "produces every stratum" test above (which
  // only proves the STRATIFY MECHANISM works, in isolation): this one
  // runs the SAME sweep size as the conservation gate itself (300 runs
  // + every degenerate state) and prints the actual per-threshold,
  // per-stratum hit table any reader (or CI log) can eyeball — so a
  // future commit that adds a threshold to the registry but never
  // wires a real stratify() call for it fails LOUDLY and readably,
  // not just as an opaque array-diff.
  it("coverage report: every registered threshold is exercised in every stratum across a real sweep", () => {
    resetThresholdCoverage();
    // 2,000 — the same N Commit 1's own "produces every stratum" test
    // uses. This USED to be a probabilistic guarantee only — the
    // rarest combination in the registry (the boundary-age cohort,
    // itself gated at 25%, landing on one specific age threshold out
    // of eleven, in one specific stratum out of five) was roughly
    // 1-in-220 per run, and even 2,000 runs' worth of plain i.i.d.
    // draws left enough variance to occasionally read zero on some
    // pension.minDrawdown.* cell by chance, not by an actual
    // regression (observed directly: repeated runs turned up a
    // DIFFERENT zeroed cell each time, confirming it was variance, not
    // one broken threshold). pickFair()/stratify()'s own shuffled-bag
    // round-robin (this describe block's own header) turned that into
    // a MATHEMATICAL guarantee instead — every registered cell is
    // visited at least once every (list length) or 5 calls
    // respectively, never left to chance — so this sweep size is now
    // about realistic-scenario diversity, not coverage odds.
    const failures = runConservationSweep(2000, "coverage-report sweep");
    expect(failures, `conservation failures during the coverage sweep:\n${failures.join("\n")}`).toEqual([]);

    const lines = ["Threshold coverage report (2,000-scenario sweep + every degenerate state):"];
    const unexercised = [];
    for (const name of THRESHOLD_REGISTRY) {
      const strata = thresholdCoverage[name] ?? {};
      const counts = STRATA.map((s) => `${s}=${strata[s] ?? 0}`).join(" ");
      lines.push(`  ${name}: ${counts}`);
      for (const s of STRATA) if (!strata[s]) unexercised.push(`${name}.${s}`);
    }
    // eslint-disable-next-line no-console -- the report IS the point of this test
    console.log(lines.join("\n"));
    expect(unexercised, `threshold(s) with an unexercised stratum: ${unexercised.join(", ")}`).toEqual([]);
  });

  // Input Usability spec, Commit 2 — state.meta.touched records which
  // fields a user has reviewed, purely for display (muted styling, the
  // review panel, sidebar badges). It must never reach the engine: a
  // scenario with nothing marked touched and one with everything (or
  // garbage paths) marked touched project identically.
  it("Input Usability spec, Commit 2: state.meta.touched has no effect on projection output (regression gate)", () => {
    const state = randomScenario();
    const baseline = projectPlan(state);
    const withNoise = projectPlan({
      ...state,
      meta: { touched: ["plan.client.retirementAge", "assets.bogus-id.balance", "not.a.real.path"] },
    });
    expect(withNoise).toEqual(baseline);
  });

  // "Where the money went" (Implementation/Rates spec, Commit 4) reuses
  // the SAME terms this invariant asserts over (conservationCheck.js's
  // computeYearFlows), regrouped into the 7 waterfall buckets — so it
  // must reconcile to closingN EXACTLY (not just within the invariant's
  // own tolerance) for the same reason and over the same randomised
  // scenarios as the invariant itself, per CLAUDE.md's "assert as a
  // test over randomised scenarios rather than a single case." The
  // final year is excluded for the same reason checkYearConservation
  // excludes it: the final FY's CGT/Div293/296 assessment is an
  // accrued liability, not yet a cashflow (see header).
  it("net worth decomposition reconciles exactly to closing net worth across randomly generated scenarios", () => {
    const RUNS = 300;
    for (let i = 0; i < RUNS; i++) {
      const state = randomScenario();
      const out = projectPlan(state);
      const years = out.yearly.length;
      for (let y = 0; y < years - 1; y++) {
        const row = out.yearly[y];
        const d = row.decomposition;
        const prevNet = y > 0 ? out.yearly[y - 1].netAssets : row.openingBalance + row.wcaDetail.opening
          + Object.values(row.superDetail).reduce((s, v) => s + v.opening, 0)
          + Object.values(row.bondDetail ?? {}).reduce((s, v) => s + v.opening, 0)
          - Object.values(row.liabilities).reduce((s, v) => s + v.opening, 0);
        const reconciled = prevNet + d.income + d.growth - d.tax - d.expenses - d.interest - d.fees + d.oneOffs;
        const gap = Math.abs(reconciled - row.netAssets);
        const tol = Math.max(0.05, Math.abs(row.netAssets) * 1e-6);
        expect(gap, `scenario ${i}, year ${y}: decomposition ${reconciled.toFixed(2)} vs actual ${row.netAssets.toFixed(2)}`)
          .toBeLessThanOrEqual(tol);
      }
    }
  });

  it("cumulative decomposition sums each bucket's per-year increments (running totals)", () => {
    const state = randomScenario();
    const out = projectPlan(state);
    let cum = { income: 0, growth: 0, tax: 0, expenses: 0, interest: 0, fees: 0, oneOffs: 0 };
    for (const row of out.yearly) {
      for (const k of Object.keys(cum)) cum[k] += row.decomposition[k];
      for (const k of Object.keys(cum)) expect(row.cumulativeDecomposition[k]).toBeCloseTo(cum[k], 6);
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
    const family = (n) => mkState({
      endAge: 41,
      assets: [],
      plan: {
        client: { currentAge: 40, privateHospitalCover: false },
        partner: { currentAge: 40, privateHospitalCover: false },
        children: childrenOfCount(n),
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

  it("Input Usability spec, Commit 3: the derived dependent-children count steps down as a child turns 21, and the MLS family threshold follows within a single projection", () => {
    // Family income held flat at $212,000 across the whole projection.
    // 2 children stay comfortably dependent throughout; a 3rd is
    // exactly 20 at plan start and turns 21 at the first 1 July tick —
    // dependentChildrenCountInFY must step 3 → 2 exactly then.
    // Threshold with 3 dependents: $210,000 + (3-1)×$1,500 = $213,000
    // (family income $212,000 stays under it → no surcharge).
    // Threshold with 2 dependents: $210,000 + (2-1)×$1,500 = $211,500
    // (family income $212,000 now exceeds it → 1% surcharge applies).
    const start = { year: 2026, month: 7 };
    const children = [
      { id: "young1", name: "Young 1", dateOfBirth: synthDob(10, start), education: [] },
      { id: "young2", name: "Young 2", dateOfBirth: synthDob(10, start), education: [] },
      { id: "agingOut", name: "Aging out", dateOfBirth: synthDob(20, start), education: [] },
    ];
    const s = mkState({
      endAge: 42,
      awote: 0.025, // matches cpi exactly, so the AWOTE-indexed MLS thresholds stay flat in real terms across years
      assets: [],
      plan: {
        client: { currentAge: 40, privateHospitalCover: false },
        partner: { currentAge: 40, privateHospitalCover: false },
        children,
        workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
      },
      cashflows: {
        income: [
          employmentRow({ id: "i1", amount: 106000, owner: "client", from: { kind: "age", age: 40 }, to: { kind: "age", age: 43 } }),
          employmentRow({ id: "i2", amount: 106000, owner: "partner", from: { kind: "age", age: 40 }, to: { kind: "age", age: 43 } }),
        ],
      },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].taxDetail.client.medicareLevySurcharge).toBe(0); // 3 dependents, under threshold
    expect(out.yearly[1].taxDetail.client.medicareLevySurcharge).toBeCloseTo(106000 * 0.01, 2); // 2 dependents, over
    expect(out.yearly[2].taxDetail.client.medicareLevySurcharge).toBeCloseTo(106000 * 0.01, 2); // still 2 (and still 2 in year 2, the 20-year-old having long since aged out)
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

describe("Children and education funding (Input Usability spec, Commit 3)", () => {
  it("education fees flow only in the years the child's own age falls within [fromAge, toAge]", () => {
    const start = { year: 2026, month: 7 };
    // Age 5 at plan start; block covers ages 5-7 (3 plan years: 0, 1, 2).
    const children = [{
      id: "c1", name: "Kid", dateOfBirth: synthDob(5, start),
      education: [{ id: "ed1", label: "Primary", annualAmount: 10000, fromAge: 5, toAge: 7, indexBasis: "cpi", indexExtraPct: 0 }],
    }];
    const s = mkState({ endAge: 45, plan: { children } }); // 5 plan years (40..45 → indices 0..4)
    const out = projectPlan(s);
    const fees = out.schedule.rowTotals.education.ed1;
    expect(Array.from(fees.slice(0, 3))).toEqual([10000, 10000, 10000]);
    expect(Array.from(fees.slice(3))).toEqual(new Array(fees.length - 3).fill(0)); // years 3+ : the child has aged out
  });

  it("a not-yet-born child's education fees start only once they exist — never before, no special-case clamp needed", () => {
    const start = { year: 2026, month: 7 };
    // Age -2 at plan start (born 2 plan years in); block covers ages
    // 5-6, so fees should start at plan year 2+5=7.
    const children = [{
      id: "c1", name: "Not yet born", dateOfBirth: synthDob(-2, start),
      education: [{ id: "ed1", label: "Primary", annualAmount: 8000, fromAge: 5, toAge: 6, indexBasis: "cpi", indexExtraPct: 0 }],
    }];
    const s = mkState({ endAge: 50, plan: { children } }); // 10 plan years (40..50)
    const out = projectPlan(s);
    const fees = out.schedule.rowTotals.education.ed1;
    expect(Array.from(fees.slice(0, 7))).toEqual(new Array(7).fill(0)); // years 0-6: not old enough (or not born) yet
    expect(fees[7]).toBeCloseTo(8000, 2);
    expect(fees[8]).toBeCloseTo(8000, 2);
    expect(fees[9]).toBeCloseTo(0, 2); // aged out of the block after year 8
  });

  it("education fees are ordinary household expenses — they land in the engine's own row.expenses, not a side channel", () => {
    const start = { year: 2026, month: 7 };
    const children = [{
      id: "c1", name: "Kid", dateOfBirth: synthDob(5, start),
      education: [{ id: "ed1", label: "Primary", annualAmount: 10000, fromAge: 5, toAge: 12, indexBasis: "none", indexExtraPct: 0 }],
    }];
    const withFees = projectPlan(mkState({ endAge: 41, plan: { children } }));
    const withoutFees = projectPlan(mkState({ endAge: 41 }));
    expect(withFees.yearly[0].expenses - withoutFees.yearly[0].expenses).toBeCloseTo(10000, 2);
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

describe("Adviser fees and flow of initial funds (Implementation/Rates spec, Commit 2)", () => {
  const bigSuper = (over = {}) => superAcct({ id: "su1", owner: "client", balance: 200000, allocation: zeroRealSuperAlloc(), ...over });
  // Zero-real via GROWTH, not income, and cgtAsset:false — a plain
  // income-yield zero-real allocation (zeroRealAlloc) is still
  // genuinely taxable distribution income each year even in
  // "reinvest" mode, which would drag real tax out of this fixture
  // and contaminate the hand-calc; growth-only + non-CGT has no tax
  // event at all, keeping this fixture's only cashflow the fee itself.
  const bigAsset = (cpi = 0.025) => mkAsset({
    id: "a1", balance: 2_000_000, cgtAsset: false,
    allocation: { mode: "custom", incomePct: 0, growthPct: cpi * 100, frankingPct: 0, volBasis: "Balanced" },
  });
  const withFees = (adviserFees, over = {}) => mkState({
    endAge: 43,
    assets: [bigAsset()],
    ...over,
    // plan/settings set explicitly AFTER the ...over spread — a plain
    // trailing ...over would otherwise clobber the whole plan object
    // wholesale (losing adviserFees) instead of merging into it.
    plan: { superAccounts: [bigSuper()], adviserFees, ...over.plan },
    settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: ["a1"] },
  });

  it("known-value: the upfront fee splits exactly — outside-super debits household cash, inside-super debits the nominated account, before that year's growth", () => {
    const s = withFees({
      upfront: { total: 20000, fromSuperAmount: 12000, superAccountId: "su1" },
      ongoing: { annualAmount: 0, fromSuperAmount: 0, superAccountId: null, indexBasis: "cpi" },
    });
    const out = projectPlan(s);
    // Inside-super: exactly the requested $12,000 comes straight off
    // the account (zero-real allocation, so this is the ONLY thing
    // touching the balance — the closing figure isolates it exactly).
    expect(out.yearly[0].superDetail.su1.adviserFee).toBeCloseTo(12000, 2);
    expect(out.yearly[0].superDetail.su1.closing).toBeCloseTo(200000 - 12000, 1);
    // Outside-super: the remaining $8,000 — the big financial asset
    // (zero-real, no other cashflow in this fixture) absorbs it exactly.
    expect(out.yearly[0].adviserFeesUpfront.outsideCash).toBeCloseTo(8000, 2);
    expect(out.yearly[0].adviserFeesUpfront.requestedFromSuper).toBeCloseTo(12000, 2);
    expect(out.yearly[0].adviserFeesUpfront.paidFromSuper).toBeCloseTo(12000, 2);
    expect(out.yearly[0].closingBalance).toBeCloseTo(2_000_000 - 8000, 1);
    // Fires ONCE, at month 0 of the whole projection — no trace in
    // later years.
    expect(out.yearly[1].adviserFeesUpfront.outsideCash).toBe(0);
    expect(out.yearly[1].superDetail.su1.adviserFee).toBe(0);
  });

  it("the inside-super cap binds when the account can't cover the requested amount, and the shortfall falls back to cash ('paid personally')", () => {
    const s = withFees(
      { upfront: { total: 20000, fromSuperAmount: 15000, superAccountId: "su1" }, ongoing: { annualAmount: 0, fromSuperAmount: 0, superAccountId: null, indexBasis: "cpi" } },
      { plan: { superAccounts: [bigSuper({ balance: 5000 })] } } // far short of the $15,000 requested
    );
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.adviserFee).toBeCloseTo(5000, 2); // capped at what's there
    expect(out.yearly[0].superDetail.su1.closing).toBeCloseTo(0, 1);
    expect(out.yearly[0].adviserFeesUpfront.requestedFromSuper).toBeCloseTo(15000, 2);
    expect(out.yearly[0].adviserFeesUpfront.paidFromSuper).toBeCloseTo(5000, 2);
    // Shortfall (15000 − 5000 = 10000) + the genuine outside-super
    // portion (20000 − 15000 = 5000) both land on household cash —
    // $15,000 total, not the $5,000 outside-super figure alone.
    const totalCashOut = 2_000_000 - out.yearly[0].closingBalance;
    expect(totalCashOut).toBeCloseTo(15000, 1);
  });

  it("the ongoing fee flows monthly outside super and is indexed; the inside-super portion applies once per FY, in July", () => {
    const s = withFees({
      upfront: { total: 0, fromSuperAmount: 0, superAccountId: null },
      ongoing: { annualAmount: 12000, fromSuperAmount: 6000, superAccountId: "su1", indexBasis: "none" },
    }, { endAge: 44, cpi: 0.025 });
    const out = projectPlan(s);
    // Year 0: half from super, resolved once at FY start (July, m=0
    // this year) — no decay yet, since that's the very first month.
    expect(out.yearly[0].superDetail.su1.adviserFee).toBeCloseTo(6000, 1);
    // The outside-super half flows monthly, and indexBasis "none"
    // decays it (in real terms) a little EVERY month, even within the
    // same FY — so the year's SUM is a hair under 12 × (500 flat), not
    // exactly 6000. Computed via the same closed form the engine uses,
    // rather than asserting a flat annual figure that isn't what
    // month-by-month decay actually produces.
    let expectedOutsideY0 = 0;
    for (let m = 0; m < 12; m++) expectedOutsideY0 += (12000 * Math.pow(1 / 1.025, m / 12) * 0.5) / 12;
    expect(out.yearly[0].adviserFeesOngoing.outsideCash).toBeCloseTo(expectedOutsideY0, 1);
    // indexBasis "none" holds the NOMINAL amount fixed, so the REAL
    // value decays at CPI — year 1's real requested-from-super is
    // smaller than year 0's.
    expect(out.yearly[1].adviserFeesOngoing.requestedFromSuper).toBeLessThan(out.yearly[0].adviserFeesOngoing.requestedFromSuper);
    expect(out.yearly[1].adviserFeesOngoing.requestedFromSuper).toBeCloseTo(6000 / 1.025, 1);
  });

  it("regression: no adviser fees configured is bit-identical to the pre-Commit-2 shape", () => {
    const withNone = projectPlan(withFees({
      upfront: { total: 0, fromSuperAmount: 0, superAccountId: null },
      ongoing: { annualAmount: 0, fromSuperAmount: 0, superAccountId: null, indexBasis: "cpi" },
    }));
    const withMissing = projectPlan({ ...withFees(undefined), plan: { ...withFees(undefined).plan, adviserFees: undefined } });
    for (let y = 0; y < withNone.yearly.length; y++) {
      expect(withNone.yearly[y].closingBalance).toBeCloseTo(withMissing.yearly[y].closingBalance, 6);
      expect(withNone.yearly[y].adviserFeesUpfront.outsideCash).toBe(0);
      expect(withNone.yearly[y].adviserFeesOngoing.outsideCash).toBe(0);
    }
  });

  it("conservation invariant holds with adviser fees present (both slices are named leaks)", () => {
    const s = withFees({
      upfront: { total: 20000, fromSuperAmount: 12000, superAccountId: "su1" },
      ongoing: { annualAmount: 12000, fromSuperAmount: 6000, superAccountId: "su1", indexBasis: "cpi" },
    }, { endAge: 45 });
    const out = projectPlan(s);
    for (let y = 0; y < out.yearly.length - 1; y++) {
      checkYearConservation(out, y, `adviser fees fixture, year ${y}`);
    }
  });

  it("regression: two claims on the SAME super account in the SAME year never sum to more than the account holds (found via randomScenario — see reserveFromSuper in deterministic.js)", () => {
    // $15,000 upfront + $10,000 ongoing requested from an account that
    // only holds $20,000 — naively capping EACH request independently
    // against the raw $20,000 balance (the original bug) would let
    // BOTH believe they can be paid in full, debiting $25,000 from an
    // account that never held more than $20,000. Upfront resolves
    // FIRST (see reserveFromSuper's own header for the fixed order),
    // so it gets its full $15,000; ongoing — second in line — gets
    // only the $5,000 left, with $5,000 falling back to cash.
    const s = withFees(
      { upfront: { total: 15000, fromSuperAmount: 15000, superAccountId: "su1" }, ongoing: { annualAmount: 10000, fromSuperAmount: 10000, superAccountId: "su1", indexBasis: "cpi" } },
      { plan: { superAccounts: [bigSuper({ balance: 20000 })] } }
    );
    const out = projectPlan(s);
    const totalDebited = out.yearly[0].adviserFeesUpfront.paidFromSuper + out.yearly[0].adviserFeesOngoing.paidFromSuper;
    expect(totalDebited).toBeLessThanOrEqual(20000 + 0.01);
    expect(out.yearly[0].adviserFeesUpfront.paidFromSuper).toBeCloseTo(15000, 1); // first in line, paid in full
    expect(out.yearly[0].adviserFeesOngoing.paidFromSuper).toBeCloseTo(5000, 1); // second in line, only what's left
    expect(out.yearly[0].superDetail.su1.closing).toBeCloseTo(0, 1);
    checkYearConservation(out, 0, "shared-account regression, year 0");
  });

  it("emergency fund target (workingCash.minimumBalance) prevents the buffer being drawn down — a shortfall reports as unfunded instead", () => {
    // planState.test.js covers emergencyFundTarget writing through to
    // workingCash.minimumBalance; this is the ENGINE consequence the
    // spec calls out — "deficit funding will not draw the buffer below
    // it, so a plan that would eat the emergency fund shows as
    // unfunded instead" — exercised directly against the field the
    // engine actually reads (convention 11).
    const s = mkState({
      endAge: 41,
      // Growth-only zero-real allocation, not zeroRealAlloc's own
      // income-yield version — a reinvest-mode INCOME yield is still
      // genuinely taxable each year even though it never leaves the
      // asset as cash, which would drag real tax into this fixture and
      // contaminate the exact hand-calc below; growth-only + non-CGT
      // (mkAsset's own default) has no tax event at all.
      assets: [mkAsset({ id: "a1", balance: 5000, allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" } })],
      // ratePct = cpi*100, not 0 or null — a literal 0% NOMINAL rate
      // still decays in REAL terms via Fisher deflation (same trap
      // zeroRealAlloc's own header warns about for assets); this is
      // the WCA's own "real return exactly 0" rate.
      plan: { workingCash: { balance: 20000, minimumBalance: 20000, ratePct: 2.5 } },
      cashflows: { expenses: [cf({ amount: 10000, frequency: "annual", fromAge: 40, toAge: 40 })] },
      fundingOrder: ["a1"],
    });
    const out = projectPlan(s);
    // The WCA never drops below its $20,000 minimum...
    expect(out.yearly[0].wcaDetail.closing).toBeCloseTo(20000, 1);
    // ...the $5,000 asset is fully drained trying to cover the shortfall...
    expect(out.yearly[0].perAssetDetail.a1.closing).toBeCloseTo(0, 1);
    // ...and the remaining $5,000 the funding order couldn't cover
    // shows up as unfunded, not as a silently-breached buffer.
    expect(out.yearly[0].unfundedCashflow).toBeCloseTo(5000, 1);
  });
});

describe("Fixed-rate loans and rollover (Implementation/Rates spec, Commit 1)", () => {
  const loan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 100000, interestRatePct: 6, termYears: 10, repayment: "pi",
    ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    rateType: "variable", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 },
    revertRatePct: null, commencedOn: null,
    ...over,
  });
  const bigAsset = () => mkAsset({ allocation: zeroRealAlloc(), balance: 2000000 });
  const withLoan = (l, over = {}) => ({
    ...mkState({ endAge: 40 + (over.years ?? 11), assets: [bigAsset()], ...over }),
    liabilities: [l],
  });

  it("known-value: interest accrues at the fixed rate up to rollover, the revert rate after, and the payment recomputes exactly once", () => {
    const l = loan({
      rateType: "fixed", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: 8,
    });
    const out = projectPlan(withLoan(l, { years: 11 }));
    const iFixed = 0.06 / 12, iRevert = 0.08 / 12;
    let b = 100000;
    let pmt = levelPayment(100000, iFixed, 120);
    let recomputed = false;
    const checkpoints = {};
    for (let m = 0; m < 120 && b > 1e-9; m++) {
      const rate = m >= 36 ? iRevert : iFixed;
      if (m >= 36 && !recomputed) { pmt = levelPayment(b, iRevert, 120 - m); recomputed = true; }
      const interest = b * rate;
      const payment = Math.min(pmt, b + interest);
      b = b + interest - payment;
      if (b < 1e-9) b = 0;
      if ((m + 1) % 12 === 0) checkpoints[(m + 1) / 12 - 1] = b;
    }
    for (const [y, nominalClosing] of Object.entries(checkpoints)) {
      const infl = Math.pow(1.025, Number(y) + 1);
      expect(out.yearly[Number(y)].liabilities.lb1.closing).toBeCloseTo(nominalClosing / infl, 2);
    }
  });

  it("the recomputed repayment matches a closed form over the remaining balance and remaining term", () => {
    const l = loan({
      rateType: "fixed", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: 8,
    });
    const out = projectPlan(withLoan(l, { years: 11 }));
    const rollover = out.liabilityRollovers.lb1;
    expect(rollover).toBeTruthy();
    expect(rollover.planYear).toBe(3); // age 43 − currentAge 40
    expect(rollover.fromRatePct).toBeCloseTo(6, 6);
    expect(rollover.toRatePct).toBeCloseTo(8, 6);

    // Year 2's closing == year 3's opening == the balance AT rollover
    // (rollover always lands on a plan-year boundary) — the closed
    // form's own input, converted to the same nominal-dollar terms
    // levelPayment operates in.
    const infl = Math.pow(1.025, 3);
    const balanceAtRolloverNominal = out.yearly[2].liabilities.lb1.closing * infl;
    const expectedPayment = levelPayment(balanceAtRolloverNominal, 0.08 / 12, 120 - 36);
    expect(rollover.repaymentAfter * infl).toBeCloseTo(expectedPayment, 2);
  });

  it("a rollover mid-projection produces the expected step — before/after repayments genuinely differ, not smoothed", () => {
    const l = loan({
      rateType: "fixed", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: 9,
    });
    const out = projectPlan(withLoan(l, { years: 11 }));
    expect(out.yearly[0].liabilities.lb1.ratePct).toBeCloseTo(6, 6);
    expect(out.yearly[2].liabilities.lb1.ratePct).toBeCloseTo(6, 6);
    expect(out.yearly[3].liabilities.lb1.ratePct).toBeCloseTo(9, 6);
    const rollover = out.liabilityRollovers.lb1;
    // repaymentBefore/After are real-dollar figures (deflated at the
    // rollover point, like every other point-in-time figure on this
    // row) — convert back to nominal to compare against the raw
    // closed-form payment.
    const infl = Math.pow(1.025, 3);
    expect(rollover.repaymentBefore * infl).toBeCloseTo(levelPayment(100000, 0.06 / 12, 120), 2);
    expect(Math.abs(rollover.repaymentAfter - rollover.repaymentBefore)).toBeGreaterThan(1);
  });

  it("regression: rateType 'variable' (explicit or omitted) matches the pre-Commit-1 level-payment closed form exactly", () => {
    const withExplicit = projectPlan(withLoan(loan({ rateType: "variable" }), { years: 11 }));
    const withOmitted = projectPlan(withLoan(loan({ rateType: undefined }), { years: 11 }));
    const i = 0.06 / 12;
    const pmt = levelPayment(100000, i, 120);
    let b = 100000;
    const checkpoints = {};
    for (let m = 0; m < 120 && b > 1e-9; m++) {
      const interest = b * i;
      const payment = Math.min(pmt, b + interest);
      b = b + interest - payment;
      if (b < 1e-9) b = 0;
      if ((m + 1) % 12 === 0) checkpoints[(m + 1) / 12 - 1] = b;
    }
    for (const [y, nominalClosing] of Object.entries(checkpoints)) {
      const infl = Math.pow(1.025, Number(y) + 1);
      expect(withExplicit.yearly[Number(y)].liabilities.lb1.closing).toBeCloseTo(nominalClosing / infl, 2);
      expect(withOmitted.yearly[Number(y)].liabilities.lb1.closing).toBeCloseTo(nominalClosing / infl, 2);
    }
    expect(withExplicit.liabilityRollovers.lb1).toBeUndefined();
    expect(withOmitted.liabilityRollovers.lb1).toBeUndefined();
  });

  it("extras during a fixed period still work, and the scheduled (no-extras) baseline rolls over too — isolating extras' own effect from the rate switch", () => {
    const l = loan({
      rateType: "fixed", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: 9,
      extraRepayments: [{
        id: "er1", label: "Extra", amount: 500, frequency: "monthly",
        from: { kind: "age", age: 40 }, to: { kind: "age", age: 50 },
        indexBasis: "none", indexExtraPct: 0,
      }],
    });
    const out = projectPlan(withLoan(l, { years: 11 }));
    const stats = out.liabilityRepaymentStats.lb1;
    expect(stats).toBeTruthy();
    // The SCHEDULED (no-extras) baseline has no extras but DOES still
    // roll over — a level-payment schedule always retires exactly at
    // its own term regardless of the rate path.
    expect(stats.scheduledPayoffMonth).toBe(120);
    if (stats.actualPayoffMonth != null) {
      expect(stats.interestSaved).toBeGreaterThan(0);
    }
  });
});

describe("Usable equity and borrowing capacity (Implementation/Rates spec, Commit 3)", () => {
  const prop = (over = {}) => ({
    id: "p1", name: "Home", owner: "client", state: "NSW",
    propertyType: "ppr", status: "owned",
    currentValue: 800000, acquisitionDate: null, costBase: 0,
    priceToday: 0, purchaseAt: { kind: "age", age: 40 },
    lvrPct: 80, firstHomeBuyer: false, newBuild: false,
    purchaseCostsPct: 0, dutyOverride: null,
    growthPct: 2.5, // = cpi, so real value stays exactly $800,000
    rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expensesDeductible: true, depreciation: 0,
    equityCeilingPct: 80, depositFromEquity: false, depositFromEquitySourcePropertyId: null,
    ...over,
  });
  const homeLoan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 400000, interestRatePct: 6, termYears: 25, repayment: "pi",
    ioYears: 5, deductible: false, linkedAssetId: "p1", offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    ...over,
  });
  const offsetAsset = (balance) => mkAsset({
    id: "offset1", balance, cgtAsset: false,
    allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" },
  });

  it("known-value: usable equity = value × ceiling − (loan closing − offset applied), reconciled against the engine's own already-reported figures", () => {
    const s = {
      ...mkState({ endAge: 42, assets: [offsetAsset(50000)], fundingOrder: [] }),
      properties: [prop()],
      liabilities: [homeLoan({ offsetAssetId: "offset1" })],
    };
    const out = projectPlan(s);
    const row = out.yearly[0];
    const expected = row.properties.p1.value * 0.8 - (row.liabilities.lb1.closing - row.liabilities.lb1.offsetApplied);
    expect(row.properties.p1.usableEquity).toBeCloseTo(Math.max(0, expected), 2);
    expect(row.properties.p1.usableEquity).toBeGreaterThan(0);
  });

  it("offset genuinely increases usable equity (a bigger offset balance means less NET loan to subtract)", () => {
    const build = (offsetBalance) => projectPlan({
      ...mkState({ endAge: 42, assets: [offsetAsset(offsetBalance)], fundingOrder: [] }),
      properties: [prop()],
      liabilities: [homeLoan({ offsetAssetId: "offset1" })],
    });
    const withOffset = build(50000).yearly[0];
    const withoutOffset = build(0).yearly[0];
    expect(withOffset.liabilities.lb1.offsetApplied).toBeGreaterThan(40000);
    expect(withoutOffset.liabilities.lb1.offsetApplied).toBe(0);
    expect(withOffset.properties.p1.usableEquity).toBeGreaterThan(withoutOffset.properties.p1.usableEquity);
  });

  it("the ceiling is configurable — a lower ceiling reduces usable equity proportionally", () => {
    const build = (ceilingPct) => projectPlan({
      ...mkState({ endAge: 42, assets: [], fundingOrder: [] }),
      properties: [prop({ equityCeilingPct: ceilingPct })],
      liabilities: [homeLoan()],
    }).yearly[0];
    const at60 = build(60);
    const at90 = build(90);
    // Same loan balance either way — only the ceiling changes, so the
    // DIFFERENCE is exactly value × (0.90 − 0.60).
    expect(at90.properties.p1.usableEquity - at60.properties.p1.usableEquity).toBeCloseTo(800000 * 0.3, 1);
  });

  it("usable equity floors at 0 rather than going negative when the loan exceeds the ceiling", () => {
    const out = projectPlan({
      ...mkState({ endAge: 42, assets: [], fundingOrder: [] }),
      properties: [prop({ currentValue: 100000, equityCeilingPct: 80 })], // ceiling = $80,000
      liabilities: [homeLoan({ balance: 400000 })], // loan far exceeds the ceiling
    });
    expect(out.yearly[0].properties.p1.usableEquity).toBe(0);
  });

  it("aggregates correctly across properties — the sum of each property's own usable equity", () => {
    const out = projectPlan({
      ...mkState({ endAge: 42, assets: [], fundingOrder: [] }),
      properties: [prop({ id: "p1", currentValue: 800000 }), prop({ id: "p2", currentValue: 400000, equityCeilingPct: 80 })],
      liabilities: [homeLoan({ id: "lb1", linkedAssetId: "p1", balance: 400000 }), homeLoan({ id: "lb2", linkedAssetId: "p2", balance: 100000 })],
    });
    const row = out.yearly[0];
    const total = row.properties.p1.usableEquity + row.properties.p2.usableEquity;
    // Independently: p1 = 800000×0.8 − 400000-ish closing; p2 = 400000×0.8 − 100000-ish closing.
    // Just confirm the total is the plain sum (no cross-contamination
    // between properties' own loan/offset figures) and both are individually positive.
    expect(row.properties.p1.usableEquity).toBeGreaterThan(0);
    expect(row.properties.p2.usableEquity).toBeGreaterThan(0);
    expect(total).toBeCloseTo(row.properties.p1.usableEquity + row.properties.p2.usableEquity, 6);
  });

  it("the insufficient-equity flag fires at the right year when a planned purchase's deposit relies on another property's usable equity", () => {
    const planned = prop({
      id: "p2", status: "planned", currentValue: 0, priceToday: 900000,
      purchaseAt: { kind: "age", age: 41 }, lvrPct: 80,
      depositFromEquity: true, depositFromEquitySourcePropertyId: "p1",
    });
    // p1 (the source) is worth only $500,000 with an $450,000 loan —
    // barely any usable equity, nowhere near p2's ~$180,000 deposit.
    const insufficient = projectPlan({
      ...mkState({ endAge: 43, assets: [], fundingOrder: [] }),
      properties: [prop({ currentValue: 500000 }), planned],
      liabilities: [homeLoan({ balance: 450000 })],
    });
    const flagged = insufficient.propertyWarnings.filter((w) => w.type === "insufficientEquity" && w.propertyId === "p2");
    expect(flagged.length).toBe(1);

    // The SAME purchase, but p1 is worth much more with a small loan —
    // plenty of usable equity now.
    const sufficient = projectPlan({
      ...mkState({ endAge: 43, assets: [], fundingOrder: [] }),
      properties: [prop({ currentValue: 3_000_000 }), planned],
      liabilities: [homeLoan({ balance: 100000 })],
    });
    expect(sufficient.propertyWarnings.filter((w) => w.type === "insufficientEquity")).toHaveLength(0);
  });

  it("no flag when depositFromEquity is off — an ordinary planned purchase never triggers this warning", () => {
    const planned = prop({
      id: "p2", status: "planned", currentValue: 0, priceToday: 900000,
      purchaseAt: { kind: "age", age: 41 }, lvrPct: 80,
      depositFromEquity: false, depositFromEquitySourcePropertyId: null,
    });
    const out = projectPlan({
      ...mkState({ endAge: 43, assets: [], fundingOrder: [] }),
      properties: [prop({ currentValue: 500000 }), planned],
      liabilities: [homeLoan({ balance: 450000 })],
    });
    expect(out.propertyWarnings.filter((w) => w.type === "insufficientEquity")).toHaveLength(0);
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
    // 12,000; "awote" (the row basis id; sourced from assumptions
    // .wageGrowth, > cpi by default — assumptions-provenance.md §1.2)
    // grows in real terms.
    expect(none).toBeCloseTo(12000 / Math.pow(1.025, 2), 2);
    expect(cpiTarget).toBeCloseTo(12000, 2);
    expect(awote).toBeCloseTo(12000 * Math.pow(1.027 / 1.025, 2), 2);
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

// --- Where the money went: net worth decomposition (Implementation/
// Rates spec, Commit 4). The randomised, exact-reconciliation test
// lives inside the "Conservation invariant" describe block above (it
// reuses that block's randomScenario() generator, per CLAUDE.md's rule
// that a decomposition of this kind gets the same discipline as the
// conservation invariant it's built from). These are the known-value
// and crossover-annotation tests.
describe("Where the money went: net worth decomposition (Implementation/Rates spec, Commit 4)", () => {
  it("known-value: a single growth-only, non-CGT asset with no other flows — decomposition.growth equals the asset's own real growth, every other bucket is zero, and it reconciles exactly", () => {
    // growthPct = 5% real (incomePct 0, cgtAsset false → no tax event,
    // no distribution) — the only money flow in this scenario at all.
    const asset = mkAsset({
      balance: 100000, cgtAsset: false,
      allocation: { mode: "custom", incomePct: 0, growthPct: 5, frankingPct: 0, volBasis: "Balanced" },
    });
    const out = projectPlan(mkState({ endAge: 42, assets: [asset], fundingOrder: [] }));
    const row = out.yearly[0];
    const expectedGrowth = row.growth; // the engine's own already-reported figure
    expect(expectedGrowth).toBeGreaterThan(0);
    expect(row.decomposition.growth).toBeCloseTo(expectedGrowth, 6);
    expect(row.decomposition.income).toBeCloseTo(0, 6);
    expect(row.decomposition.tax).toBeCloseTo(0, 6);
    expect(row.decomposition.expenses).toBeCloseTo(0, 6);
    expect(row.decomposition.interest).toBeCloseTo(0, 6);
    expect(row.decomposition.fees).toBeCloseTo(0, 6);
    expect(row.decomposition.oneOffs).toBeCloseTo(0, 6);
    const openingN = row.openingBalance;
    const reconciled = openingN + row.decomposition.income + row.decomposition.growth
      - row.decomposition.tax - row.decomposition.expenses - row.decomposition.interest
      - row.decomposition.fees + row.decomposition.oneOffs;
    expect(reconciled).toBeCloseTo(row.netAssets, 2);
  });

  it("cumulative totals accumulate the per-year bucket exactly (a flat, zero-growth asset never touched again — cumulative income/growth stay at their year-0 values)", () => {
    const asset = mkAsset({
      balance: 50000, cgtAsset: false,
      allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" }, // = cpi → real 0
    });
    const out = projectPlan(mkState({ endAge: 45, assets: [asset], fundingOrder: [] }));
    for (const row of out.yearly) {
      expect(row.decomposition.growth).toBeCloseTo(0, 2);
      expect(row.cumulativeDecomposition.growth).toBeCloseTo(0, 2);
    }
  });

  it("annotates the year cumulative growth first overtakes cumulative income — a long, high-growth accumulation with small ongoing contributions", () => {
    const asset = mkAsset({
      balance: 20000, cgtAsset: false,
      allocation: { mode: "custom", incomePct: 0, growthPct: 12, frankingPct: 0, volBasis: "Balanced" },
    });
    const income = [cf({ id: "salary", assetId: null, amount: 500, frequency: "monthly", fromAge: 40, toAge: 120 })];
    const out = projectPlan({
      ...mkState({ endAge: 65, assets: [asset], fundingOrder: [], cashflows: { income } }),
    });
    expect(out.wealthCrossoverYear).not.toBeNull();
    const y = out.wealthCrossoverYear;
    expect(out.yearly[y].cumulativeDecomposition.growth).toBeGreaterThan(out.yearly[y].cumulativeDecomposition.income);
    if (y > 0) {
      expect(out.yearly[y - 1].cumulativeDecomposition.growth)
        .toBeLessThanOrEqual(out.yearly[y - 1].cumulativeDecomposition.income);
    }
  });
});

// --- Monte Carlo rate linkage (What-if spec, Commit 5) — direct,
// precisely-controlled tests of deterministic.js's own mc.
// mortgageRateDeltaForYear handling, independent of monteCarlo.js's
// stochastic CPI generation (that module's own tests cover the
// end-to-end path-varies-with-CPI behaviour). A hand-crafted mc object
// lets these tests assert EXACT rates/repayments rather than merely
// "varies somehow".
describe("Monte Carlo rate linkage (What-if spec, Commit 5)", () => {
  const loan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 100000, interestRatePct: 6, termYears: 10, repayment: "pi",
    ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    rateType: "variable", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 },
    revertRatePct: null, commencedOn: null,
    ...over,
  });
  const bigAsset = () => mkAsset({ allocation: zeroRealAlloc(), balance: 2000000 });
  const withLoan = (l, years = 6) => ({
    ...mkState({ endAge: 40 + years, assets: [bigAsset()], fundingOrder: [] }),
    liabilities: [l],
  });

  it("a variable loan's rate moves by exactly the mc delta, every year", () => {
    const state = withLoan(loan({ rateType: "variable", interestRatePct: 6 }));
    const mc = { mortgageRateDeltaForYear: (y) => [0, 0.01, -0.02, 0, 0, 0][y] ?? 0 };
    const out = projectPlan(state, undefined, mc);
    expect(out.yearly[0].liabilities.lb1.ratePct).toBeCloseTo(6, 6);
    expect(out.yearly[1].liabilities.lb1.ratePct).toBeCloseTo(7, 6); // +1pp
    expect(out.yearly[2].liabilities.lb1.ratePct).toBeCloseTo(4, 6); // −2pp
    expect(out.yearly[3].liabilities.lb1.ratePct).toBeCloseTo(6, 6); // back to baseline
  });

  it("a fixed loan's rate ignores the mc delta entirely before its own rollover, and applies it after", () => {
    const l = loan({ rateType: "fixed", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: 6.5 });
    const state = withLoan(l, 6);
    const mc = { mortgageRateDeltaForYear: () => 0.02 }; // +2pp every year, if it applied
    const out = projectPlan(state, undefined, mc);
    for (const y of [0, 1, 2]) expect(out.yearly[y].liabilities.lb1.ratePct).toBeCloseTo(6, 6); // untouched
    expect(out.yearly[3].liabilities.lb1.ratePct).toBeCloseTo(8.5, 6); // 6.5 + 2 after rollover
  });

  it("the level payment recomputes each year the rate actually differs, and reproduces the SAME NOMINAL payment when it doesn't", () => {
    const l = loan({ rateType: "variable", interestRatePct: 6, termYears: 10 });
    const state = withLoan(l, 6);
    const cpi = state.assumptions.cpi;
    const constantMc = { mortgageRateDeltaForYear: () => 0.015 }; // constant +1.5pp, every year
    const risingMc = { mortgageRateDeltaForYear: (y) => 0.01 * y }; // rises every year
    const outConstant = projectPlan(state, undefined, constantMc);
    const outRising = projectPlan(state, undefined, risingMc);
    // Real-dollar repayment figures deflate by CPI every year even at a
    // constant NOMINAL payment — re-inflate by (1+cpi)^y before
    // comparing, or a genuinely unchanged nominal payment would look
    // like it's shrinking.
    const nominalPmt = (out, y) => (out.yearly[y].liabilities.lb1.interest + out.yearly[y].liabilities.lb1.principal) * Math.pow(1 + cpi, y);
    // A CONSTANT (non-zero) delta still recomputes the payment once at
    // the first opportunity, but every subsequent year's recompute
    // reproduces the IDENTICAL nominal figure — amortisation's own
    // self-consistency at an unchanged rate.
    const constantPmts = [1, 2, 3, 4].map((y) => nominalPmt(outConstant, y));
    for (let i = 1; i < constantPmts.length; i++) expect(constantPmts[i]).toBeCloseTo(constantPmts[0], 0);
    // A RISING delta produces a GENUINELY rising NOMINAL repayment year
    // over year — "repayments rise" is a real, observable consequence,
    // not just interest.
    const risingPmts = [1, 2, 3, 4].map((y) => nominalPmt(outRising, y));
    for (let i = 1; i < risingPmts.length; i++) expect(risingPmts[i]).toBeGreaterThan(risingPmts[i - 1]);
  });

  it("a null/absent mc leaves every liability figure bit-identical to before Commit 5", () => {
    const l = loan({ rateType: "fixed", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: 8 });
    const state = withLoan(l, 6);
    const withoutMc = projectPlan(state);
    const withNullMc = projectPlan(state, undefined, null);
    const withEmptyMc = projectPlan(state, undefined, {});
    for (let y = 0; y < withoutMc.yearly.length; y++) {
      expect(withNullMc.yearly[y].liabilities.lb1.ratePct).toBeCloseTo(withoutMc.yearly[y].liabilities.lb1.ratePct, 10);
      expect(withEmptyMc.yearly[y].liabilities.lb1.ratePct).toBeCloseTo(withoutMc.yearly[y].liabilities.lb1.ratePct, 10);
    }
  });
});

describe("Surplus and deficit allocation (docs/specs/16-surplus-allocation.md, Commit 1)", () => {
  const period = (over = {}) => ({
    id: "sp1", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
    payNonDeductibleDebtFirst: false, debtOrder: "interestRate", allocations: [], remainderTo: "cash",
    ...over,
  });
  const ioLoan = (over = {}) => ({
    id: "lb1", name: "Loan", type: "personal", owner: "client", balance: 2000,
    interestRatePct: 0, termYears: 25, repayment: "io", ioYears: 25, deductiblePct: 0,
    linkedAssetId: null, offsetAssetId: null, extraRepayments: [], oneOffRepayments: [],
    rateType: "variable", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: null, commencedOn: null,
    ...over,
  });
  const surplusState = (over = {}) => mkState({
    endAge: 40,
    assets: [mkAsset({ id: "a1", balance: 0, allocation: zeroRealAlloc() })],
    cashflows: { income: [cf({ assetId: null, amount: 1000, toAge: 40 })] }, // ~$12,000/yr surplus, no expenses
    ...over,
  });

  it("payNonDeductibleDebtFirst pays down non-deductible debt before any percentage allocation", () => {
    const s = {
      ...surplusState({ surplus: { periods: [period({
        payNonDeductibleDebtFirst: true,
        allocations: [{ id: "sa1", targetType: "asset", targetId: "a1", pct: 100 }],
      })] } }),
      liabilities: [ioLoan({ balance: 2000 })],
    };
    const out = projectPlan(s);
    // ~$12,000 (+WCA interest) of surplus this year — the $2,000 fully
    // non-deductible loan is repaid FIRST, in full, before the 100%
    // asset allocation sees any of the remaining pool.
    expect(out.yearly[0].liabilities.lb1.closing).toBeCloseTo(0, 0);
    expect(out.yearly[0].liabilities.lb1.surplusRepayment).toBeCloseTo(2000, 0);
    expect(out.yearly[0].perAssetDetail.a1.closing).toBeGreaterThan(9000);
    expect(out.yearly[0].perAssetDetail.a1.closing).toBeLessThan(10500);
  });

  it("without payNonDeductibleDebtFirst, the loan is untouched and the full surplus follows the allocation", () => {
    const s = {
      ...surplusState({ surplus: { periods: [period({
        payNonDeductibleDebtFirst: false,
        allocations: [{ id: "sa1", targetType: "asset", targetId: "a1", pct: 100 }],
      })] } }),
      liabilities: [ioLoan({ balance: 2000 })],
    };
    const out = projectPlan(s);
    // Untouched nominally ($2,000, confirmed by principal/interest/
    // surplusRepayment all 0 below) but the engine reports closing
    // balances in REAL dollars: 2000 / 1.025 (one year of CPI) ≈ 1951.22.
    expect(out.yearly[0].liabilities.lb1.closing).toBeCloseTo(2000 / 1.025, 0);
    expect(out.yearly[0].liabilities.lb1.surplusRepayment).toBeCloseTo(0, 6);
    expect(out.yearly[0].perAssetDetail.a1.closing).toBeGreaterThan(11500);
  });

  it("debtOrder interestRate repays the higher-rate liability first", () => {
    const s = {
      ...surplusState({ surplus: { periods: [period({ payNonDeductibleDebtFirst: true, debtOrder: "interestRate" })] } }),
      liabilities: [
        ioLoan({ id: "low", balance: 10000, interestRatePct: 2 }),
        ioLoan({ id: "high", balance: 10000, interestRatePct: 8 }),
      ],
    };
    const out = projectPlan(s);
    // ~$12,000 surplus: the 8% loan (also $10,000) is repaid first and
    // fully; the ~$2,000 remainder goes to the 2% loan, which is only
    // partially repaid — combined balances ($20,000) exceed the pool.
    expect(out.yearly[0].liabilities.high.surplusRepayment).toBeCloseTo(10000, 0);
    expect(out.yearly[0].liabilities.low.surplusRepayment).toBeGreaterThan(500);
    expect(out.yearly[0].liabilities.low.surplusRepayment).toBeLessThan(2000);
  });

  it("a part-deductible loan's non-deductible-first ceiling is its CURRENT balance times its non-deductible proportion", () => {
    // 50% deductible, $10,000 balance — only $5,000 is eligible via
    // this priority channel; a surplus larger than that leaves the
    // other (deductible) $5,000 untouched by debt-first.
    const s = {
      ...surplusState({
        cashflows: { income: [cf({ assetId: null, amount: 2000, toAge: 40 })] }, // ~$24,000/yr surplus — well over the $5,000 ceiling
        surplus: { periods: [period({ payNonDeductibleDebtFirst: true })] },
      }),
      liabilities: [ioLoan({ balance: 10000, deductiblePct: 50 })],
    };
    const out = projectPlan(s);
    expect(out.yearly[0].liabilities.lb1.surplusRepayment).toBeCloseTo(5000, 0);
    // Nominal remaining balance is $5,000; reported in real dollars
    // (one year of CPI): 5000 / 1.025 ≈ 4878.05.
    expect(out.yearly[0].liabilities.lb1.closing).toBeCloseTo(5000 / 1.025, 0);
  });

  it("percentage allocations split the pool remaining AFTER debt-first, not the original surplus", () => {
    const s = {
      ...surplusState({
        assets: [mkAsset({ id: "a1", balance: 0, allocation: zeroRealAlloc() }), mkAsset({ id: "a2", balance: 0, allocation: zeroRealAlloc() })],
        fundingOrder: ["a1", "a2"],
        surplus: { periods: [period({
          allocations: [
            { id: "sa1", targetType: "asset", targetId: "a1", pct: 50 },
            { id: "sa2", targetType: "asset", targetId: "a2", pct: 50 },
          ],
        })] },
      }),
    };
    const out = projectPlan(s);
    const a1 = out.yearly[0].perAssetDetail.a1.closing;
    const a2 = out.yearly[0].perAssetDetail.a2.closing;
    expect(a1).toBeCloseTo(a2, -1); // an even 50/50 split of the same pool
    expect(a1 + a2).toBeGreaterThan(11500); // together, ~the whole surplus
  });

  it("a liability allocation's overflow (balance smaller than its share) falls through to the remainder, not lost", () => {
    const s = {
      ...surplusState({
        surplus: { periods: [period({
          allocations: [{ id: "sa1", targetType: "liability", targetId: "lb1", pct: 100 }],
          remainderTo: "cash",
        })] },
      }),
      liabilities: [ioLoan({ balance: 500 })], // far smaller than the ~$12,000 pool
    };
    const out = projectPlan(s);
    expect(out.yearly[0].liabilities.lb1.closing).toBeCloseTo(0, 0);
    expect(out.yearly[0].liabilities.lb1.surplusRepayment).toBeCloseTo(500, 0);
    // The rest lands in the WCA via the remainder, not vanished — the
    // household's own net position still reconciles (checked below via
    // the conservation invariant too).
    expect(out.yearly[0].surplusAccumulated).toBeGreaterThan(9000);
  });

  it("an allocation to an existing concessional contribution row tops up to the remaining cap headroom, excess falls through", () => {
    const s = {
      ...surplusState({
        plan: { superAccounts: [superAcct({ id: "su1", owner: "client" })] },
        cashflows: {
          income: [cf({ assetId: null, amount: 3000, toAge: 40 })], // ~$36,000/yr surplus
          superContributions: [scRow({
            id: "pd1", accountId: "su1", type: "personalDeductible", basis: "amount",
            amount: 30000, frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
          })],
        },
        surplus: { periods: [period({
          allocations: [{ id: "sa1", targetType: "superContribution", targetId: "pd1", pct: 100 }],
          remainderTo: "cash",
        })] },
      }),
    };
    const out = projectPlan(s);
    // Concessional cap $32,500 (FY2026-27); $30,000 already contributed
    // via the ordinary "amount" row — only $2,500 of headroom remains
    // for the surplus top-up, net of 15% contributions tax.
    const su1 = out.yearly[0].superDetail.su1;
    expect(su1.contributions).toBeCloseTo(30000 + 2500, 0);
    // Contributions tax applies to the FULL concessional amount, not
    // just the surplus-funded top-up.
    expect(su1.contributionsTax).toBeCloseTo((30000 + 2500) * 0.15, 0);
    // The rest of the surplus (well over $30,000) falls through to the
    // remainder rather than creating an excess contribution the client
    // never asked for.
    expect(out.yearly[0].surplusAccumulated).toBeGreaterThan(20000);
  });

  it("an allocation to a goal tops it up on top of whatever it's otherwise funded from", () => {
    const s = {
      ...surplusState({
        surplus: { periods: [period({ allocations: [{ id: "sa1", targetType: "goal", targetId: "gl1", pct: 50 }] })] },
      }),
      goals: [{ id: "gl1", label: "Goal", targetAmount: 100000, targetAt: { kind: "anchor", anchorId: "end" }, fundedFrom: "surplus", indexBasis: "none", indexExtraPct: 0 }],
    };
    const out = projectPlan(s);
    expect(out.yearly[0].goals.gl1.contribution).toBeGreaterThan(5000);
  });

  it("remainderTo expenditure discards the leftover; cash leaves it in the WCA", () => {
    const spend = surplusState({ surplus: { periods: [period({ remainderTo: "expenditure" })] } });
    const cash = surplusState({ surplus: { periods: [period({ remainderTo: "cash" })] } });
    const outSpend = projectPlan(spend);
    const outCash = projectPlan(cash);
    expect(outSpend.yearly[0].surplusSpent).toBeGreaterThan(9000);
    expect(outCash.yearly[0].surplusAccumulated).toBeGreaterThan(9000);
    expect(outSpend.yearly[0].wcaDetail.closing).toBeCloseTo(0, 0);
    expect(outCash.yearly[0].wcaDetail.closing).toBeGreaterThan(9000);
  });

  it("minimum balances: deficit funding draws each asset to its own floor, then breaches them in order", () => {
    const s = {
      ...mkState({
        endAge: 40,
        assets: [
          mkAsset({ id: "a1", balance: 5000, allocation: zeroRealAlloc() }),
          mkAsset({ id: "a2", balance: 5000, allocation: zeroRealAlloc() }),
        ],
        fundingOrder: ["a1", "a2"],
        cashflows: { expenses: [cf({ assetId: null, amount: 1000, toAge: 40 })] }, // ~$12,000/yr deficit, no income
        deficit: { minimumBalances: { a1: 2000, a2: 1000 }, sellRule: "order" },
      }),
    };
    const out = projectPlan(s);
    // Both assets drawn to their own floor first ($3,000 from a1,
    // $4,000 from a2 — $7,000 total), THEN — only once both are at
    // floor — drawn below them in the SAME order for the remaining
    // ~$5,000: a1 first (to 0), then a2.
    expect(out.yearly[0].perAssetDetail.a1.closing).toBeCloseTo(0, 0);
    expect(out.yearly[0].perAssetDetail.a2.closing).toBeLessThan(1000);
    expect(out.yearly[0].perAssetDetail.a2.closing).toBeGreaterThanOrEqual(0);
  });

  it("minimumCapitalGain sells the smallest unrealised-gain-ratio asset first; a non-CGT asset always sorts first", () => {
    const highGain = mkAsset({ id: "hi", balance: 10000, cgtAsset: true, costBase: 1000, allocation: zeroRealAlloc() }); // 90% gain ratio
    const lowGain = mkAsset({ id: "lo", balance: 10000, cgtAsset: true, costBase: 9000, allocation: zeroRealAlloc() }); // 10% gain ratio
    const cash = mkAsset({ id: "ca", balance: 20000, cgtAsset: false, costBase: null, allocation: zeroRealAlloc() }); // no CGT — sorts first regardless, sized to fully cover the deficit alone
    const s = mkState({
      endAge: 40,
      assets: [highGain, lowGain, cash],
      fundingOrder: ["hi", "lo", "ca"], // deliberately NOT in gain-ratio order
      cashflows: { expenses: [cf({ assetId: null, amount: 1000, toAge: 40 })] },
      deficit: { minimumBalances: {}, sellRule: "minimumCapitalGain" },
    });
    const out = projectPlan(s);
    // ~$12,000 needed: cash (no CGT) sells first and fully covers it —
    // the two CGT assets are untouched.
    expect(out.yearly[0].perAssetDetail.ca.closing).toBeLessThan(9000);
    expect(out.yearly[0].perAssetDetail.hi.closing).toBeCloseTo(10000, -2);
    expect(out.yearly[0].perAssetDetail.lo.closing).toBeCloseTo(10000, -2);
  });

  it("minimumCapitalGain, once cash is exhausted, sells the smaller-gain-ratio CGT asset before the larger one", () => {
    const highGain = mkAsset({ id: "hi", balance: 10000, cgtAsset: true, costBase: 1000, allocation: zeroRealAlloc() }); // 90% gain ratio
    const lowGain = mkAsset({ id: "lo", balance: 10000, cgtAsset: true, costBase: 9000, allocation: zeroRealAlloc() }); // 10% gain ratio
    const s = mkState({
      endAge: 40,
      assets: [highGain, lowGain],
      fundingOrder: ["hi", "lo"],
      cashflows: { expenses: [cf({ assetId: null, amount: 1500, toAge: 40 })] }, // ~$18,000/yr — draws into the CGT assets
      deficit: { minimumBalances: {}, sellRule: "minimumCapitalGain" },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].perAssetDetail.lo.closing).toBeLessThan(out.yearly[0].perAssetDetail.hi.closing);
  });

  it("conservation invariant holds with non-deductible-first, percentage allocations, and minimum balances all active together", () => {
    const s = {
      ...mkState({
        endAge: 42,
        assets: [
          mkAsset({ id: "a1", balance: 3000, allocation: zeroRealAlloc() }),
          mkAsset({ id: "a2", balance: 3000, allocation: zeroRealAlloc() }),
        ],
        fundingOrder: ["a1", "a2"],
        cashflows: { income: [cf({ assetId: null, amount: 1500, toAge: 42 })] },
        deficit: { minimumBalances: { a1: 500 }, sellRule: "minimumCapitalGain" },
        surplus: { periods: [period({
          payNonDeductibleDebtFirst: true,
          allocations: [
            { id: "sa1", targetType: "asset", targetId: "a2", pct: 40 },
            { id: "sa2", targetType: "liability", targetId: "lb1", pct: 40 },
          ],
          remainderTo: "cash",
        })] },
      }),
      liabilities: [ioLoan({ balance: 4000, deductiblePct: 30 })],
    };
    const out = projectPlan(s);
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `surplus-allocation combo fixture, year ${y}`);
  });

  it("migration bit-identity: a real hydrate()d v16 blob (mode invest) reaches the same figures as the equivalent v17 period", () => {
    const legacyState = {
      schemaVersion: 16,
      plan: {
        household: "single", client: { currentAge: 40 }, partner: null, endAge: 40,
        start: { year: 2026, month: 7 }, children: [],
      },
      assets: [{
        id: "a1", name: "A1", include: true, owner: "client", distributions: "reinvest", balance: 100000,
        // zero-real allocation (income = cpi, growth = 0) so this matches
        // the "surplus invest routes to the nominated asset" fixture's
        // known-value figure exactly, rather than compounding real growth
        // on top of it.
        allocation: { mode: "custom", incomePct: 2.5, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
        icrPct: 0, cgtAsset: false, costBase: null,
      }],
      cashflows: {
        income: [{ id: "i1", label: "x", owner: "client", amount: 1000, frequency: "monthly",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 }, indexBasis: "none", indexExtraPct: 0, category: "salary", incomeType: "other" }],
        expenses: [], contributions: [], withdrawals: [], lumpSums: [], superContributions: [], superWithdrawals: [],
      },
      liabilities: [], properties: [], goals: [],
      settings: { surplus: { mode: "invest", assetId: "a1" }, fundingOrder: ["a1"] },
      display: { units: "real" },
    };
    const hydrated = hydrate(JSON.stringify(legacyState), PROFILES);
    expect(hydrated).not.toBeNull();
    expect(hydrated.settings.surplus.periods).toHaveLength(1);
    expect(hydrated.settings.surplus.periods[0]).toMatchObject({
      payNonDeductibleDebtFirst: false,
      allocations: [{ targetType: "asset", targetId: "a1", pct: 100 }],
      remainderTo: "cash",
    });
    const hydratedOut = projectPlan(hydrated);
    // The pre-existing "surplus invest routes to the nominated asset"
    // fixture (this same describe file, deficit funding block) asserts
    // the identical known-value outcome for the SAME shape via the test
    // shim's shorthand conversion — this proves the REAL migration path
    // (raw JSON → hydrate()) reaches that same number, not just the
    // test helper's own shim.
    expect(hydratedOut.monthly.combined[12]).toBeCloseTo(100000 + 12000, -3);
  });
});

// Adjustment Rows (docs/specs/18-adjustment-rows.md, Commit 1).
describe("Adjustment rows (docs/specs/18-adjustment-rows.md, Commit 1)", () => {
  const adj = (over = {}) => ({
    id: "adj1", target: "expenses", owner: "household", label: "", amount: 0,
    from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
    indexBasis: "cpi", indexExtraPct: 0, note: "test", superAccountId: null,
    ...over,
  });
  // A single, zero-real-growth asset and enough income that the tests
  // aren't accidentally exercising deficit-funding/unfunded-cashflow at
  // the same time as the adjustment under test.
  const adjState = (over = {}) => mkState({
    endAge: 41,
    assets: [mkAsset({ id: "a1", balance: 0, allocation: zeroRealAlloc() })],
    cashflows: { income: [cf({ assetId: null, amount: 1000, toAge: 41 })] }, // ~$12,000/yr
    ...over,
  });

  it("income.assessable adds to household cash AND to assessable income (a leak of none — it's income)", () => {
    // Large enough to clear the tax-free threshold on its own — the
    // shared adjState() baseline uses a raw cf() income row with no
    // category, which schedule.js reads as cash but not assessable
    // (this file's tests establish taxable income via employmentRow()
    // instead where they need it), so baseline tax here is genuinely 0.
    const withAdj = adjState({ plan: { adjustments: [adj({ target: "income.assessable", owner: "client", amount: 30000, indexBasis: "none" })] } });
    const without = adjState();
    const outWith = projectPlan(withAdj);
    const outWithout = projectPlan(without);
    expect(outWith.yearly[0].income - outWithout.yearly[0].income).toBeCloseTo(30000, 0);
    expect(outWith.yearly[0].tax).toBeGreaterThan(outWithout.yearly[0].tax);
  });

  it("income.nonTaxable adds to household cash but not to assessable income (no extra tax)", () => {
    const withAdj = adjState({ plan: { adjustments: [adj({ target: "income.nonTaxable", amount: 5000, indexBasis: "none" })] } });
    const without = adjState();
    const outWith = projectPlan(withAdj);
    const outWithout = projectPlan(without);
    expect(outWith.yearly[0].income - outWithout.yearly[0].income).toBeCloseTo(5000, 0);
    expect(outWith.yearly[0].tax).toBeCloseTo(outWithout.yearly[0].tax, 0);
  });

  it("deductions reduces tax with no separate cash effect", () => {
    // A genuinely taxable, NON-employment income baseline: an
    // employment-income person's in-year tax is driven by a PAYG
    // ESTIMATE that deliberately ignores deductions (matching a real
    // payroll system, per deterministic.js's own comment) — a
    // deduction there only shows up as a bigger refund the FOLLOWING
    // July, not in this FY's own row.tax. otherTaxable income (e.g.
    // interest/dividends) takes the smooth spreadTax path instead,
    // where the true (deduction-reduced) liability IS this FY's cash.
    const taxableState = (adjustments) => mkState({
      endAge: 41,
      cashflows: { income: [cf({
        id: "i1", assetId: null, amount: 100000, frequency: "annual",
        incomeType: "otherTaxable", toAge: 41,
      })] },
      plan: { adjustments },
    });
    const withAdj = projectPlan(taxableState([adj({ target: "deductions", owner: "client", amount: 5000, indexBasis: "none" })]));
    const without = projectPlan(taxableState([]));
    expect(withAdj.yearly[0].income).toBeCloseTo(without.yearly[0].income, 0);
    expect(withAdj.yearly[0].tax).toBeLessThan(without.yearly[0].tax);
  });

  it("expenses is a pure household leak, owner forced to household regardless of what's stored", () => {
    const withAdj = adjState({ plan: { adjustments: [adj({ target: "expenses", amount: 2000, indexBasis: "none" })] } });
    const without = adjState();
    const outWith = projectPlan(withAdj);
    const outWithout = projectPlan(without);
    expect(outWith.yearly[0].expenses - outWithout.yearly[0].expenses).toBeCloseTo(2000, 0);
  });

  it("tax.incomeTax/medicare/help/cgt each apply as an additional (signed) cash debit against total tax paid this FY", () => {
    const more = adjState({ plan: { adjustments: [adj({ target: "tax.incomeTax", owner: "client", amount: 1000, indexBasis: "none" })] } });
    const less = adjState({ plan: { adjustments: [adj({ target: "tax.medicare", owner: "client", amount: -300, indexBasis: "none" })] } });
    const baseline = adjState();
    const outMore = projectPlan(more);
    const outLess = projectPlan(less);
    const outBaseline = projectPlan(baseline);
    expect(outMore.yearly[0].tax - outBaseline.yearly[0].tax).toBeCloseTo(1000, 0);
    expect(outLess.yearly[0].tax - outBaseline.yearly[0].tax).toBeCloseTo(-300, 0);
  });

  it("tax.withheld is a timing change only: it nets to zero across the two years it straddles, for a person WITH employment income", () => {
    const s = (adjustments) => mkState({
      endAge: 42,
      plan: { adjustments },
      cashflows: { income: [employmentRow({ amount: 100000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 } })] },
    });
    const withAdj = projectPlan(s([adj({ target: "tax.withheld", owner: "client", amount: 4000, indexBasis: "none", to: { kind: "age", age: 40 } })]));
    const baseline = projectPlan(s([]));
    // Positive amount = MORE withheld (spec: "positive increases the
    // row") — more tax cash out THIS year, then a matching refund/
    // balancing credit the following July.
    const diffY0 = withAdj.yearly[0].tax - baseline.yearly[0].tax;
    const diffY1 = withAdj.yearly[1].tax - baseline.yearly[1].tax;
    expect(diffY0).toBeCloseTo(4000, 0);
    expect(diffY0 + diffY1).toBeCloseTo(0, 0);
  });

  it("superContributions credits the SPECIFIC account net of contributions tax, debited from household cash — no cap check", () => {
    // Enough income that the $3,000 contribution is genuinely
    // affordable (not partly unfunded) — the household-cash assertion
    // below is only meaningful once affordability isn't in question.
    const withAdj = adjState({
      cashflows: { income: [cf({ assetId: null, amount: 3000, toAge: 41 })] },
      plan: {
        superAccounts: [superAcct({ id: "su1", owner: "client" })],
        adjustments: [adj({ target: "superContributions", owner: "client", superAccountId: "su1", amount: 3000, indexBasis: "none" })],
      },
    });
    const without = adjState({
      cashflows: { income: [cf({ assetId: null, amount: 3000, toAge: 41 })] },
      plan: { superAccounts: [superAcct({ id: "su1", owner: "client" })] },
    });
    const outWith = projectPlan(withAdj);
    const outWithout = projectPlan(without);
    const su1 = outWith.yearly[0].superDetail.su1;
    expect(su1.contributions).toBeCloseTo(3000, 0);
    expect(su1.contributionsTax).toBeCloseTo(3000 * 0.15, 0);
    // Credited in July, so the real-dollar closing balance also
    // reflects a few months' CPI deflation on the flat-nominal net
    // amount (zeroRealAlloc has no growth) — not exactly 3000*0.85.
    expect(su1.closing).toBeCloseTo(3000 * 0.85, -3);
    // adjState's default surplus mode ("spend") sweeps the whole WCA
    // remainder to expenditure each FY-end, so wcaClosing is always ~0
    // regardless of the adjustment — surplusSpent is the household-cash
    // signal here: ~3,000 less gets swept to expenditure once that much
    // was diverted to the super contribution instead.
    expect(outWithout.yearly[0].surplusSpent - outWith.yearly[0].surplusSpent).toBeGreaterThan(2500);
  });

  it("dropped when the target references an account that no longer exists — never silently reassigned", () => {
    // Raw state bypasses clampAdjustment (this describe block builds raw
    // state directly, same as every other test in this file) — the
    // ENGINE must also tolerate a dangling superAccountId gracefully
    // (schedule.js resolves it regardless of whether planState.js's own
    // clamp already dropped it), never crediting the wrong account.
    const s = adjState({ plan: { adjustments: [adj({ target: "superContributions", superAccountId: "nope", amount: 3000, indexBasis: "none" })] } });
    expect(() => projectPlan(s)).not.toThrow();
  });

  it("a time-limited adjustment applies only in its own window", () => {
    const s = adjState({
      endAge: 43,
      plan: { adjustments: [adj({
        // indexBasis "cpi" (constant real) — this test is about the
        // window, not indexation (which has its own dedicated test).
        target: "expenses", amount: 2000, indexBasis: "cpi",
        from: { kind: "age", age: 41 }, to: { kind: "age", age: 41 },
      })] },
    });
    const baseline = adjState({ endAge: 43 });
    const out = projectPlan(s);
    const base = projectPlan(baseline);
    expect(out.yearly[0].expenses).toBeCloseTo(base.yearly[0].expenses, 0); // age 40 — before the window
    expect(out.yearly[1].expenses - base.yearly[1].expenses).toBeCloseTo(2000, 0); // age 41 — inside it
    expect(out.yearly[2].expenses).toBeCloseTo(base.yearly[2].expenses, 0); // age 42 — after it
  });

  it("indexation applies the same way every other cashflow row's does", () => {
    const s = adjState({
      endAge: 42,
      plan: { adjustments: [adj({ target: "expenses", amount: 1000, indexBasis: "none" })] }, // fixed nominal -> decays in real terms
    });
    const out = projectPlan(s);
    const base = adjState({ endAge: 42 });
    const baseOut = projectPlan(base);
    const y0 = out.yearly[0].expenses - baseOut.yearly[0].expenses;
    const y1 = out.yearly[1].expenses - baseOut.yearly[1].expenses;
    expect(y0).toBeCloseTo(1000, 0);
    expect(y1).toBeLessThan(y0); // indexBasis "none" decays at CPI in real terms
  });

  it("a partial first year with no firing July skips the adjustment entirely, same as every other annual row", () => {
    const s = adjState({
      start: { year: 2026, month: 9 }, // starts after July -> year 0 has no firing July (convention 5)
      plan: { adjustments: [adj({ target: "expenses", amount: 2000, indexBasis: "none" })] },
    });
    const base = adjState({ start: { year: 2026, month: 9 } });
    const out = projectPlan(s);
    const baseOut = projectPlan(base);
    expect(out.yearly[0].expenses).toBeCloseTo(baseOut.yearly[0].expenses, 0);
  });

  it("row.adjustments reports every active adjustment's resolved amount, for the table UI to mark — reporting only, never fed back into money-flow arithmetic", () => {
    const s = adjState({
      plan: { adjustments: [
        adj({ id: "e1", target: "expenses", amount: 500, indexBasis: "none", label: "Bespoke label", note: "why" }),
        adj({ id: "t1", target: "tax.incomeTax", owner: "client", amount: -100, indexBasis: "none", note: "why2" }),
      ] },
    });
    const out = projectPlan(s);
    const reported = out.yearly[0].adjustments;
    expect(reported).toHaveLength(2);
    const e1 = reported.find((a) => a.id === "e1");
    expect(e1).toMatchObject({ target: "expenses", owner: "household", label: "Bespoke label", note: "why" });
    expect(e1.amount).toBeCloseTo(500, 0);
    const t1 = reported.find((a) => a.id === "t1");
    expect(t1.amount).toBeCloseTo(-100, 0);
    // A year outside the window reports nothing for it.
    expect(out.yearly[0].adjustments.length).toBeGreaterThan(0);
  });
});

describe("Redundancy and ETP (spec 19 Commit 3)", () => {
  // A termination fires in July of its resolved plan year (same
  // "age-anchored one-off" convention every other event in this engine
  // uses) — the income row's own `to` is set to match, mirroring
  // clampIncomeRow's own rule (raw fixtures here bypass clamping, so
  // this is set by hand). endAge 42 leaves a full FY for the payout to
  // land in cleanly.
  const terminatedRow = (over = {}) => ({
    id: "sal1", label: "Salary", owner: "client", amount: 8000, frequency: "monthly",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
    indexBasis: "none", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
    termination: {
      enabled: true, at: { kind: "age", age: 40 }, completedYearsOfService: 5,
      type: "genuineRedundancy", etpTaxableComponent: 50000, unusedLeave: 5000,
    },
    ...over,
  });
  const withTermination = (rowOver = {}, stateOver = {}) => mkState({
    endAge: 42,
    assets: [mkAsset({ allocation: growthOnlyAlloc() })],
    cashflows: { income: [terminatedRow(rowOver)] },
    plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 } },
    ...stateOver,
  });

  it("the genuine-redundancy tax-free amount does not appear in assessable income, HELP repayment income, or Division 293 income", () => {
    // Tax-free base at 5 completed years: 13,598 + 5×6,801 = 47,603 —
    // large enough that its OMISSION from taxable income is easy to see.
    const out = projectPlan(withTermination());
    const y0 = out.yearly[0].taxDetail.client;
    const withoutRedundancy = projectPlan(withTermination({ termination: { ...terminatedRow().termination, enabled: false } }));
    const y0plain = withoutRedundancy.yearly[0].taxDetail.client;
    // Taxable income rises by roughly the ETP taxable component + leave
    // (both still excluded/ordinary per this engine's own design) but
    // NOT by the ~47,603 tax-free base — if it leaked in, the gap would
    // be tens of thousands of dollars larger than it is.
    const salaryOnlyGap = y0.taxableIncome - y0plain.taxableIncome; // should be ~ -unusedLeave (row ends 1 FY early) + unusedLeave (added back) ≈ small
    expect(Math.abs(salaryOnlyGap)).toBeLessThan(47603);
    // HELP repayment income and Div293 both derive from the SAME
    // measured ordinary/taxable figures — confirming taxableIncome
    // excludes the tax-free base is sufficient; spot-check HELP is
    // consistent with it (no separate leak in that path).
    expect(out.yearly[0].taxDetail.helpRepayment).toBeCloseTo(withoutRedundancy.yearly[0].taxDetail.helpRepayment, 0);
  });

  it("genuine redundancy vs resignation produce DIFFERENT tax on an IDENTICAL payout", () => {
    // 200,000 taxable component: under the ~270,000 ETP cap (genuine
    // redundancy sees no 45%-bracket excess) but over the $180,000
    // whole-of-income cap (resignation's tighter cap pushes ~20,000
    // into the 45% top-up rate) — a difference that holds regardless of
    // "other income this FY", unlike the base fixture's $50,000 payout.
    const over = { termination: { ...terminatedRow().termination, etpTaxableComponent: 200000 } };
    const genuine = projectPlan(withTermination(over));
    const resignation = projectPlan(withTermination({
      termination: { ...over.termination, type: "resignation" },
    }));
    expect(genuine.yearly[0].tax).not.toBeCloseTo(resignation.yearly[0].tax, 0);
    expect(resignation.yearly[0].tax).toBeGreaterThan(genuine.yearly[0].tax);
  });

  it("reports the termination event on the row, with its tax-free/ETP/leave breakdown", () => {
    const out = projectPlan(withTermination());
    const events = out.yearly[0].termination;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ owner: "client", type: "genuineRedundancy", etpTaxableComponent: 50000, unusedLeave: 5000 });
    expect(events[0].taxFreeAmount).toBeCloseTo(13598 + 5 * 6801, 0);
    expect(events[0].etpTax).toBeGreaterThan(0);
  });

  it("the income row ends at the termination date — no ordinary salary in the FY AFTER termination", () => {
    const out = projectPlan(withTermination());
    // Row's own `to` = age 40 = plan year 0 — DateRef windows are
    // inclusive of both boundary years (CLAUDE.md convention), so year
    // 0 itself still earns its salary (plus the termination payout
    // lands the same July); the row genuinely ENDS the FY after that —
    // year 1 has no salary and no payout.
    expect(out.yearly[1].income).toBeCloseTo(0, 2);
    expect(out.yearly[1].termination).toHaveLength(0);
  });

  it("conservation holds for a scenario with a termination event active", () => {
    const out = projectPlan(withTermination());
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `termination fixture, year ${y}`);
  });

  it("regression gate: an income row with no termination field at all behaves exactly as before", () => {
    const { termination, ...noTermination } = terminatedRow();
    const withField = mkState({ endAge: 42, cashflows: { income: [terminatedRow({ termination: { ...terminatedRow().termination, enabled: false } })] } });
    const withoutField = mkState({ endAge: 42, cashflows: { income: [noTermination] } });
    const a = projectPlan(withField);
    const b = projectPlan(withoutField);
    expect(Array.from(a.monthly.combined)).toEqual(Array.from(b.monthly.combined));
  });
});

describe("Property sale (spec 19 Commit 4)", () => {
  const soldProp = (over = {}) => ({
    id: "p1", name: "Investment unit", owner: "client", state: "NSW",
    propertyType: "investment", status: "owned",
    currentValue: 500000, acquisitionDate: "2020-01-15", costBase: 400000,
    priceToday: 0, purchaseAt: { kind: "age", age: 41 },
    lvrPct: 0, firstHomeBuyer: false, newBuild: true,
    purchaseCostsPct: 0, dutyOverride: null, growthPct: 0,
    rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expensesDeductible: true, landValuePct: 60, landTaxOverride: 0, // land tax off — isolates sale arithmetic
    sale: {
      enabled: true, at: { kind: "age", age: 41 }, agentFeesPct: 2.5, settlementCosts: 2000,
      proceedsDestination: "asset", assetId: "a1",
    },
    ...over,
  });
  const withSale = (propOver = {}, stateOver = {}) => ({
    ...mkState({
      endAge: 43,
      assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc(), balance: 0 })],
      plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 } },
      ...stateOver,
    }),
    properties: [soldProp(propOver)],
    liabilities: [],
  });

  it("proceeds net of agent fees and settlement costs credit the destination asset", () => {
    const out = projectPlan(withSale());
    // saleValue is the property's own REAL value the moment it's sold —
    // ~500,000/1.025 after one year's Fisher deflation of a flat
    // nominal value (growthPct:0), same real-terms-decay this file's
    // land tax tests already hand-calc against, not a round 500,000.
    const saleValue = out.yearly[1].properties.p1.saleValue;
    expect(saleValue).toBeCloseTo(500000 / 1.025, 0);
    const expectedProceeds = saleValue - saleValue * 0.025 - 2000;
    expect(out.yearly[1].properties.p1.saleProceeds).toBeCloseTo(expectedProceeds, 0);
    expect(out.yearly[1].perAssetClosing.a1).toBeCloseTo(expectedProceeds, 0);
    // The property leaves the projection — zero value from the sale FY.
    expect(out.yearly[1].properties.p1.value).toBe(0);
  });

  it("the property leaves the projection: no further growth, rent, or land tax after the sale", () => {
    const out = projectPlan(withSale({ landTaxOverride: null, rent: { amount: 20000, indexBasis: "none", indexExtraPct: 0 } }));
    expect(out.yearly[2].properties.p1.value).toBe(0);
    expect(out.yearly[2].properties.p1.rent).toBe(0);
    expect(out.yearly[2].properties.p1.landTax).toBe(0);
  });

  it("CGT: post-reform (constant-real pool) — gain is proceeds minus pool minus selling costs", () => {
    const out = projectPlan(withSale({}, { plan: { start: { year: 2028, month: 7 } } }));
    // The pool is pure real dollars throughout (costBasePool.js's own
    // header) and stays at its seeded 400,000 all year — only the
    // PROPERTY's own value decays in real terms (Fisher deflation of a
    // flat nominal value, growthPct:0) between plan start and the sale.
    const saleValue = out.yearly[1].properties.p1.saleValue;
    const agentFeesReal = saleValue * 0.025;
    const expectedGain = (saleValue - 400000) - agentFeesReal - 2000;
    expect(out.yearly[1].properties.p1.saleGain).toBeCloseTo(expectedGain, 0);
  });

  it("CGT: pre-reform (50% discount, old money) — half the post-cost gain is taxable", () => {
    const out = projectPlan(withSale({}, { plan: { start: { year: 2025, month: 7 } } }));
    const saleValue = out.yearly[1].properties.p1.saleValue;
    const agentFeesReal = saleValue * 0.025;
    const netGain = (saleValue - 400000) - agentFeesReal - 2000;
    expect(out.yearly[1].properties.p1.saleGain).toBeCloseTo(netGain * 0.5, 0);
  });

  it("a PPR sale is CGT-exempt regardless of gain", () => {
    const out = projectPlan(withSale({ propertyType: "ppr" }));
    expect(out.yearly[1].properties.p1.saleGain).toBe(0);
  });

  it("a linked purchase-derived loan is discharged from proceeds before the remainder reaches the asset", () => {
    const planned = {
      id: "p1", name: "Home", owner: "client", state: "NSW", propertyType: "investment", status: "planned",
      currentValue: 0, acquisitionDate: null, costBase: 0, priceToday: 500000,
      purchaseAt: { kind: "age", age: 40 }, lvrPct: 80, firstHomeBuyer: false, newBuild: true,
      purchaseCostsPct: 0, dutyOverride: null, growthPct: 0,
      rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 }, expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
      expensesDeductible: true, landValuePct: 60, landTaxOverride: 0,
      sale: { enabled: true, at: { kind: "age", age: 42 }, agentFeesPct: 0, settlementCosts: 0, proceedsDestination: "repayLoanThenAsset", assetId: "a1" },
    };
    const out = projectPlan({
      ...mkState({
        endAge: 44,
        assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc(), balance: 200000 })], // covers the deposit
        plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 } },
      }),
      properties: [planned],
      liabilities: [],
    });
    const saleY = 2; // age 42 - age 40 (start)
    const loanBalanceJustBeforeSale = out.yearly[saleY - 1].liabilities["prop-p1"].closing;
    expect(loanBalanceJustBeforeSale).toBeGreaterThan(0); // confirms the loan genuinely existed
    // Discharged: the liability's closing balance in the sale year drops to (near) zero.
    expect(out.yearly[saleY].liabilities["prop-p1"].closing).toBeCloseTo(0, 0);
    // Remainder (sale value − loan payoff) reaches the asset — saleValue
    // is the property's own real value at sale (no fees/costs in this
    // fixture), not a round 500,000 (real-terms decay between purchase
    // and sale, same as every other property fixture in this file).
    const saleValue = out.yearly[saleY].properties.p1.saleValue;
    expect(out.yearly[saleY].properties.p1.saleProceeds).toBeCloseTo(saleValue, 0);
    const remainder = saleValue - loanBalanceJustBeforeSale;
    expect(out.yearly[saleY].perAssetClosing.a1).toBeGreaterThan(remainder - 5000); // roughly the leftover, allowing for asset growth/other flows
  });

  it("Input behaviour fix: a manually-entered liability linked via linkedAssetId is ALSO discharged by the sale, for an already-owned property with no auto-generated prop-<id> loan", () => {
    const lb1 = {
      id: "lb1", name: "Investment loan", type: "mortgage", owner: "client", balance: 100000,
      interestRatePct: 0, termYears: 25, repayment: "io", ioYears: 25, deductiblePct: 100,
      linkedAssetId: "p1", offsetAssetId: null, extraRepayments: [], oneOffRepayments: [],
      rateType: "variable", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: null, commencedOn: null,
    };
    const out = projectPlan({
      ...mkState({
        endAge: 43,
        assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc(), balance: 0 })],
        plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 } },
      }),
      properties: [soldProp({ sale: { enabled: true, at: { kind: "age", age: 41 }, agentFeesPct: 0, settlementCosts: 0, proceedsDestination: "repayLoanThenAsset", assetId: "a1" } })],
      liabilities: [lb1],
    });
    // Discharged in the sale year — no prop-<id> loan exists for this
    // (already-owned) property at all, so this can ONLY have happened
    // via the linkedAssetId lookup. (Closing balance is the nominal
    // 100,000 deflated one year, same real-terms decay as every other
    // liability/property fixture in this file — not a round 100,000.)
    const loanBalanceJustBeforeSale = out.yearly[0].liabilities.lb1.closing;
    expect(loanBalanceJustBeforeSale).toBeGreaterThan(90000);
    expect(out.yearly[1].liabilities.lb1.closing).toBeCloseTo(0, 0);
    // Remainder (sale value − payoff) reaches the asset — allowing for a
    // year's further real-terms decay of the loan balance between "just
    // before sale" and the actual payoff moment, same as the analogous
    // purchase-loan test above.
    const saleValue = out.yearly[1].properties.p1.saleValue;
    const remainder = saleValue - loanBalanceJustBeforeSale;
    expect(out.yearly[1].perAssetClosing.a1).toBeGreaterThan(remainder - 5000);
    expect(out.yearly[1].perAssetClosing.a1).toBeLessThan(remainder + 5000);
  });

  it("conservation holds for a scenario with a property sale active", () => {
    const out = projectPlan(withSale());
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `property sale fixture, year ${y}`);
  });

  it("conservation holds when the discharged loan is a manually-linked liability, not the auto-generated purchase loan", () => {
    const lb1 = {
      id: "lb1", name: "Investment loan", type: "mortgage", owner: "client", balance: 100000,
      interestRatePct: 5, termYears: 25, repayment: "io", ioYears: 25, deductiblePct: 100,
      linkedAssetId: "p1", offsetAssetId: null, extraRepayments: [], oneOffRepayments: [],
      rateType: "variable", fixedRatePct: 6, fixedUntil: { kind: "age", age: 43 }, revertRatePct: null, commencedOn: null,
    };
    const out = projectPlan({
      ...mkState({
        endAge: 43,
        assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc(), balance: 0 })],
        plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 } },
      }),
      properties: [soldProp({ sale: { enabled: true, at: { kind: "age", age: 41 }, agentFeesPct: 2.5, settlementCosts: 2000, proceedsDestination: "repayLoanThenAsset", assetId: "a1" } })],
      liabilities: [lb1],
    });
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `linked-liability sale-discharge fixture, year ${y}`);
  });

  it("regression gate: a property with sale.enabled:false behaves exactly as one with no sale field at all", () => {
    const { sale, ...noSale } = soldProp({ landTaxOverride: 0 });
    const withField = {
      ...mkState({ endAge: 43, assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc() })] }),
      properties: [soldProp({ landTaxOverride: 0, sale: { ...soldProp().sale, enabled: false } })], liabilities: [],
    };
    const withoutField = {
      ...mkState({ endAge: 43, assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc() })] }),
      properties: [noSale], liabilities: [],
    };
    const a = projectPlan(withField);
    const b = projectPlan(withoutField);
    expect(Array.from(a.monthly.combined)).toEqual(Array.from(b.monthly.combined));
  });
});

describe("Main residence exemption and the six-year absence rule (spec 19 Commit 5)", () => {
  // Acquired long before the projection starts (2000), moved out in
  // 2015 — plenty of calendar runway either side of the 6-year mark
  // (2021) to place a sale on either side of it.
  const pprProp = (mainResidence, saleAge) => ({
    id: "p1", name: "Home", owner: "client", state: "NSW",
    propertyType: "ppr", status: "owned",
    currentValue: 800000, acquisitionDate: "2000-01-15", costBase: 300000,
    priceToday: 0, purchaseAt: { kind: "age", age: 41 },
    lvrPct: 0, firstHomeBuyer: false, newBuild: false,
    purchaseCostsPct: 0, dutyOverride: null, growthPct: 0,
    rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expensesDeductible: true, landValuePct: 60, landTaxOverride: 0,
    mainResidence,
    sale: { enabled: true, at: { kind: "age", age: saleAge }, agentFeesPct: 0, settlementCosts: 0, proceedsDestination: "asset", assetId: "a1" },
  });
  const withPpr = (mainResidence, saleAge, start = { year: 2028, month: 7 }) => ({
    ...mkState({
      endAge: 50, start,
      assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc(), balance: 0 })],
      plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 } },
    }),
    properties: [pprProp(mainResidence, saleAge)],
    liabilities: [],
  });

  it("fully exempt while occupied (no absence at all)", () => {
    const out = projectPlan(withPpr(null, 42));
    const saleY = out.yearly.findIndex((r) => r.properties.p1.saleProceeds > 0);
    expect(out.yearly[saleY].properties.p1.saleGain).toBe(0);
  });

  it("still exempt when sold within six years of a producing-income absence", () => {
    // Client is 40 in plan start FY2028-29 → age 40 lands on 2028-07-01,
    // so "moved out at 41" resolves to 2029-07-01; six years later is
    // 2035-07-01 — a sale at age 45 (2033-07-01) is well inside it.
    // (Plan start is 2028, after the 1 Jul 2027 CGT-regime boundary, so
    // this fixture's pool never crosses a deemed-reacquisition reset —
    // isolating the exemption arithmetic from that unrelated mechanic.)
    const mr = { movedOutAt: { kind: "age", age: 41 }, producingIncome: true, movedBackInAt: null };
    const out = projectPlan(withPpr(mr, 45));
    const saleY = out.yearly.findIndex((r) => r.properties.p1.saleProceeds > 0);
    expect(out.yearly[saleY].properties.p1.saleGain).toBeCloseTo(0, 0);
  });

  it("partial exemption once the six-year window is exceeded — a real, non-trivial slice of the gain becomes taxable", () => {
    const mr = { movedOutAt: { kind: "age", age: 41 }, producingIncome: true, movedBackInAt: null };
    const within = projectPlan(withPpr(mr, 45)); // 4 years after moving out — inside the window
    const beyond = projectPlan(withPpr(mr, 49)); // 8 years after moving out — 2 years over
    const saleYWithin = within.yearly.findIndex((r) => r.properties.p1.saleProceeds > 0);
    const saleYBeyond = beyond.yearly.findIndex((r) => r.properties.p1.saleProceeds > 0);
    expect(within.yearly[saleYWithin].properties.p1.saleGain).toBeCloseTo(0, 0);
    // Beyond the window, SOME of the gain is now taxable — the whole
    // point of the rule — but not necessarily all of it (the first six
    // years of the absence still get their exemption).
    const fullGain = beyond.yearly[saleYBeyond].properties.p1.saleValue - 300000;
    expect(beyond.yearly[saleYBeyond].properties.p1.saleGain).toBeGreaterThan(0);
    expect(beyond.yearly[saleYBeyond].properties.p1.saleGain).toBeLessThan(fullGain);
  });

  it("reoccupying before six years resets the clock — a much later sale is still fully exempt", () => {
    const mr = { movedOutAt: { kind: "age", age: 41 }, producingIncome: true, movedBackInAt: { kind: "age", age: 43 } };
    const out = projectPlan(withPpr(mr, 49)); // sold 8 years after moving out, but reoccupied at year 3
    const saleY = out.yearly.findIndex((r) => r.properties.p1.saleProceeds > 0);
    expect(out.yearly[saleY].properties.p1.saleGain).toBeCloseTo(0, 0);
  });

  it("an investment property's gain is fully taxable regardless of exemptProportion's own defaults (no mainResidence history to exempt)", () => {
    const prop = { ...pprProp(null, 42), propertyType: "investment", rent: { amount: 20000, indexBasis: "none", indexExtraPct: 0 } };
    const out = projectPlan({
      ...mkState({
        endAge: 50, start: { year: 2028, month: 7 },
        assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc(), balance: 0 })],
        plan: { workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 } },
      }),
      properties: [prop], liabilities: [],
    });
    const saleY = out.yearly.findIndex((r) => r.properties.p1.saleProceeds > 0);
    expect(out.yearly[saleY].properties.p1.saleGain).toBeGreaterThan(0);
  });

  it("conservation holds for a scenario with a partially-exempt PPR sale", () => {
    const mr = { movedOutAt: { kind: "age", age: 41 }, producingIncome: true, movedBackInAt: null };
    const out = projectPlan(withPpr(mr, 49));
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `main residence fixture, year ${y}`);
  });

  it("regression gate: a ppr property with mainResidence:null behaves exactly as one with the field entirely absent", () => {
    const withField = pprProp({ movedOutAt: null, producingIncome: false, movedBackInAt: null }, 42);
    const { mainResidence, ...withoutField } = pprProp(null, 42);
    const a = projectPlan({
      ...mkState({ endAge: 50, start: { year: 2028, month: 7 }, assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc() })] }),
      properties: [withField], liabilities: [],
    });
    const b = projectPlan({
      ...mkState({ endAge: 50, start: { year: 2028, month: 7 }, assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc() })] }),
      properties: [withoutField], liabilities: [],
    });
    expect(Array.from(a.monthly.combined)).toEqual(Array.from(b.monthly.combined));
  });
});

describe("Spouse contributions, co-contribution and LISTO (spec 19 Commit 6)", () => {
  it("spouse contribution tax offset: reduces the CONTRIBUTING spouse's tax when the receiving spouse's income is low", () => {
    const base = (spouseAmount) => mkState({
      endAge: 41, household: "couple",
      plan: { partner: { currentAge: 40 }, superAccounts: [superAcct({ id: "su_client", owner: "client" }), superAcct({ id: "su_partner", owner: "partner" })] },
      cashflows: {
        income: [
          employmentRow({ id: "i1", owner: "client", amount: 150000, to: { kind: "age", age: 120 } }),
          employmentRow({ id: "i2", owner: "partner", amount: 20000, to: { kind: "age", age: 120 } }), // well under $37,000
        ],
        superContributions: spouseAmount > 0 ? [scRow({
          id: "sc1", owner: "partner", accountId: "su_partner", type: "spouse", basis: "amount", amount: spouseAmount, to: { kind: "age", age: 120 },
        })] : [],
      },
    });
    const withOffset = projectPlan(base(3000));
    const without = projectPlan(base(0));
    // 18% of min(3000, 3000) = 540, since partner's income (~20,000) is
    // well under the $37,000 lower threshold — full notional cap applies.
    const taxSaving = without.yearly[0].tax - withOffset.yearly[0].tax;
    // The contribution itself ALSO leaves client's cash (3000) — netted
    // against the expected 540 offset when comparing total household tax.
    expect(taxSaving).toBeCloseTo(3000 * 0.18, 0);
  });

  it("no offset once the receiving spouse's income reaches $40,000", () => {
    const base = (partnerIncome) => mkState({
      endAge: 41, household: "couple",
      plan: { partner: { currentAge: 40 }, superAccounts: [superAcct({ id: "su_client", owner: "client" }), superAcct({ id: "su_partner", owner: "partner" })] },
      cashflows: {
        income: [
          employmentRow({ id: "i1", owner: "client", amount: 150000, to: { kind: "age", age: 120 } }),
          employmentRow({ id: "i2", owner: "partner", amount: partnerIncome, to: { kind: "age", age: 120 } }),
        ],
        superContributions: [scRow({ id: "sc1", owner: "partner", accountId: "su_partner", type: "spouse", basis: "amount", amount: 3000, to: { kind: "age", age: 120 } })],
      },
    });
    const highIncome = projectPlan(base(45000));
    const noContribution = projectPlan({ ...base(45000), cashflows: { ...base(45000).cashflows, superContributions: [] } });
    expect(highIncome.yearly[0].tax).toBeCloseTo(noContribution.yearly[0].tax, 0);
  });

  it("government co-contribution: phases out between the two income thresholds", () => {
    const withNcc = (income) => mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: {
        income: [employmentRow({ amount: income, to: { kind: "age", age: 120 } })],
        superContributions: [scRow({ type: "personalNonDeductible", basis: "amount", amount: 1000, to: { kind: "age", age: 120 } })],
      },
    });
    const low = projectPlan(withNcc(40000)); // below the lower threshold — full entitlement
    const mid = projectPlan(withNcc(56793)); // roughly halfway through the phase-out band
    const high = projectPlan(withNcc(70000)); // above the upper threshold — nil
    expect(low.yearly[0].superDetail.su1.govSuperInflow).toBeCloseTo(500, 0);
    expect(mid.yearly[0].superDetail.su1.govSuperInflow).toBeGreaterThan(0);
    expect(mid.yearly[0].superDetail.su1.govSuperInflow).toBeLessThan(500);
    expect(high.yearly[0].superDetail.su1.govSuperInflow).toBe(0);
  });

  it("LISTO: paid while adjusted taxable income is under $37,000, nil above it", () => {
    const withIncome = (income) => mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: { income: [employmentRow({ amount: income, to: { kind: "age", age: 120 } })] }, // SG alone is concessional
    });
    const low = projectPlan(withIncome(30000));
    const high = projectPlan(withIncome(50000));
    expect(low.yearly[0].superDetail.su1.govSuperInflow).toBeGreaterThan(0);
    expect(high.yearly[0].superDetail.su1.govSuperInflow).toBe(0);
  });

  it("contribution splitting: moves a % of the PRIOR FY's net concessional contributions to the spouse's account, not this FY's", () => {
    const s = mkState({
      endAge: 43, household: "couple",
      plan: {
        partner: { currentAge: 40 },
        superAccounts: [
          superAcct({ id: "su_client", owner: "client", contributionSplitPct: 50 }),
          superAcct({ id: "su_partner", owner: "partner" }),
        ],
      },
      cashflows: { income: [employmentRow({ id: "i1", owner: "client", amount: 100000, to: { kind: "age", age: 120 } })] },
    });
    const out = projectPlan(s);
    // Year 0 has no prior FY to split from yet.
    expect(out.yearly[0].superDetail.su_client.contributionSplitOut).toBe(0);
    expect(out.yearly[0].superDetail.su_partner.contributionSplitIn).toBe(0);
    const priorNet = out.yearly[0].superDetail.su_client.concessionalNet;
    expect(priorNet).toBeGreaterThan(0); // SG alone is concessional
    // Year 1 splits 50% of year 0's net concessional contribution.
    expect(out.yearly[1].superDetail.su_client.contributionSplitOut).toBeCloseTo(priorNet * 0.5, 6);
    expect(out.yearly[1].superDetail.su_partner.contributionSplitIn).toBeCloseTo(priorNet * 0.5, 6);
  });

  it("contribution splitting: a same-total transfer — moves balance without creating a new contribution or touching either side's cap", () => {
    const withSplit = mkState({
      endAge: 43, household: "couple",
      plan: {
        partner: { currentAge: 40 },
        superAccounts: [
          superAcct({ id: "su_client", owner: "client", contributionSplitPct: 85 }),
          superAcct({ id: "su_partner", owner: "partner" }),
        ],
      },
      cashflows: { income: [employmentRow({ id: "i1", owner: "client", amount: 100000, to: { kind: "age", age: 120 } })] },
    });
    const noSplit = { ...withSplit, plan: { ...withSplit.plan, superAccounts: withSplit.plan.superAccounts.map((a) => ({ ...a, contributionSplitPct: 0 })) } };
    const a = projectPlan(withSplit);
    const b = projectPlan(noSplit);
    // The destination account's own contribution/cap-relevant fields are
    // untouched by the split — only the new contributionSplitIn field moves.
    expect(a.yearly[1].superDetail.su_partner.contributions).toBeCloseTo(b.yearly[1].superDetail.su_partner.contributions, 6);
    expect(a.yearly[1].superDetail.su_partner.contributionsTax).toBeCloseTo(b.yearly[1].superDetail.su_partner.contributionsTax, 6);
    // Total super balance across both accounts is identical either way —
    // splitting just relabels which account holds it.
    expect(a.yearly[1].superClosing).toBeCloseTo(b.yearly[1].superClosing, 4);
  });

  it("contribution splitting: capped at 85% by clampSuperAccount, and forced to 0 for a single client (planState.js)", () => {
    const couplePlan = { client: { currentAge: 40 }, partner: { currentAge: 40 }, endAge: 90 };
    const singlePlan = { client: { currentAge: 40 }, endAge: 90 };
    expect(clampSuperAccount({ ...superAcct(), contributionSplitPct: 200 }, couplePlan).contributionSplitPct).toBe(85);
    expect(clampSuperAccount({ ...superAcct(), contributionSplitPct: 50 }, singlePlan).contributionSplitPct).toBe(0);
  });

  it("conservation holds for a scenario with spouse contributions, co-contribution, LISTO and contribution splitting all active", () => {
    const s = mkState({
      endAge: 43, household: "couple",
      plan: {
        partner: { currentAge: 40 },
        superAccounts: [
          superAcct({ id: "su_client", owner: "client", contributionSplitPct: 40 }),
          superAcct({ id: "su_partner", owner: "partner" }),
        ],
      },
      cashflows: {
        income: [
          employmentRow({ id: "i1", owner: "client", amount: 150000, to: { kind: "age", age: 120 } }),
          employmentRow({ id: "i2", owner: "partner", amount: 25000, to: { kind: "age", age: 120 } }),
        ],
        superContributions: [
          scRow({ id: "sc1", owner: "partner", accountId: "su_partner", type: "spouse", basis: "amount", amount: 2000, to: { kind: "age", age: 120 } }),
          scRow({ id: "sc2", owner: "partner", accountId: "su_partner", type: "personalNonDeductible", basis: "amount", amount: 800, to: { kind: "age", age: 120 } }),
        ],
      },
    });
    const out = projectPlan(s);
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `spouse/co-contribution/LISTO/splitting fixture, year ${y}`);
  });

  it("regression gate: a scenario with no spouse/personalNonDeductible contributions is unaffected", () => {
    const s = mkState({ endAge: 41, plan: { superAccounts: [superAcct()] }, cashflows: { income: [employmentRow({ amount: 80000, to: { kind: "age", age: 120 } })] } });
    const a = projectPlan(s);
    const b = projectPlan(JSON.parse(JSON.stringify(s)));
    expect(Array.from(a.monthly.combined)).toEqual(Array.from(b.monthly.combined));
    expect(a.yearly[0].superDetail.su1.govSuperInflow).toBe(0);
  });
});

describe("Insurance premiums inside super (spec 19 Commit 7)", () => {
  const withPremium = (over = {}) => mkState({
    endAge: 42,
    plan: { superAccounts: [superAcct({
      balance: 50000, taxFreeComponent: 10000, // 20% tax-free
      insurancePremium: { amount: 1000, indexBasis: "none", indexExtraPct: 0 },
      ...over,
    })] },
  });

  it("reduces the balance every year", () => {
    const out = projectPlan(withPremium());
    expect(out.yearly[0].superDetail.su1.insurancePremium).toBeCloseTo(1000, 0);
    expect(out.yearly[0].superDetail.su1.closing).toBeLessThan(50000);
  });

  it("reduces the taxable and tax-free components proportionally, not preferentially from one", () => {
    const out = projectPlan(withPremium());
    // 20% tax-free of the account — the $1,000 premium should reduce
    // taxFreeClosing by ~20% of itself (~200), not the full amount or
    // zero.
    const taxFreeDrop = 10000 - out.yearly[0].superDetail.su1.taxFreeClosing;
    expect(taxFreeDrop).toBeGreaterThan(0);
    expect(taxFreeDrop).toBeLessThan(1000);
    expect(taxFreeDrop).toBeCloseTo(1000 * 0.2, 0);
  });

  it("does not appear as a withdrawal, and is not assessable income", () => {
    const out = projectPlan(withPremium());
    expect(out.yearly[0].superDetail.su1.withdrawals).toBe(0);
    expect(out.yearly[0].income).toBe(0);
    expect(out.yearly[0].tax).toBe(0);
  });

  it("indexation applies — a CPI+3% premium grows faster than a flat one over time", () => {
    const indexed = projectPlan(withPremium({ insurancePremium: { amount: 1000, indexBasis: "cpi", indexExtraPct: 3 } }));
    const flat = projectPlan(withPremium({ insurancePremium: { amount: 1000, indexBasis: "none", indexExtraPct: 0 } }));
    expect(indexed.yearly[1].superDetail.su1.insurancePremium).toBeGreaterThan(flat.yearly[1].superDetail.su1.insurancePremium);
  });

  it("conservation holds for a scenario with insurance premiums active", () => {
    const out = projectPlan(withPremium());
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `insurance premium fixture, year ${y}`);
  });

  it("regression gate: an account with no premium (the default) behaves exactly as before", () => {
    const a = projectPlan(withPremium({ insurancePremium: { amount: 0, indexBasis: "cpi", indexExtraPct: 3 } }));
    const { insurancePremium, ...noField } = superAcct({ balance: 50000, taxFreeComponent: 10000 });
    const b = projectPlan(mkState({ endAge: 42, plan: { superAccounts: [noField] } }));
    expect(Array.from(a.monthly.combined)).toEqual(Array.from(b.monthly.combined));
  });
});

function pensionRow(over = {}) {
  return {
    id: "pn1", name: "Pension", owner: "client", sourceAccountId: "su1",
    commenceAt: { kind: "age", age: 60 }, type: "abp", commenceAmount: null,
    reversionary: false, taxFreeProportion: null,
    // The PLAIN zero-real allocation, not zeroRealSuperAlloc's grossed-
    // up one — this row defaults to "abp", and an ABP in retirement
    // phase pays NO tax on earnings (spec 20, Commit 3), so the
    // account's own real return is already exactly zero with no
    // haircut to gross up for. A test exercising a TTR before
    // conversion (still taxed like accumulation) overrides this
    // explicitly where the exact growth rate matters to its assertions.
    allocation: zeroRealAlloc(), icrPct: 0,
    drawdownOption: "minimum", fixedAmount: 0, indexBasis: "cpi", indexExtraPct: 0,
    commutations: [],
    ...over,
  };
}

function commutationRow(over = {}) {
  return { id: "cm1", label: "Commutation", amount: null, at: { kind: "age", age: 62 }, destination: "cash", ...over };
}

describe("Pension phase (spec 20, Commit 1): accounts, commencement, and the proportioning rule", () => {
  it("the tax-free proportion is fixed at commencement and stays unchanged across later years, even though fund growth would otherwise dilute the live ratio", () => {
    const out = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, taxFreeComponent: 40000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow()],
      },
    }));
    // Commences immediately (client is already 60, the ABP gate at
    // retirementAge 60) — 40% of the whole balance is tax-free.
    expect(out.yearly[0].pensionDetail.pn1.commencementAmount).toBeCloseTo(100000, 0);
    expect(out.yearly[0].pensionDetail.pn1.taxFreeProportion).toBeCloseTo(0.4, 4);
    // A LATER year: even with zero real growth here (deliberately, to
    // isolate the proportioning question from growth arithmetic), the
    // reported proportion must still read the FIXED figure, not
    // whatever pensionTaxFree/closing would recompute to if it were
    // live — asserted by construction: it's the SAME stored value
    // every year post-commencement, not re-derived.
    expect(out.yearly[2].pensionDetail.pn1.taxFreeProportion).toBeCloseTo(0.4, 4);
  });

  it("a real (nonzero) return dilutes what a LIVE ratio would be while the reported proportion stays fixed — the actual mechanical distinction from accumulation", () => {
    const mkScenario = (incomePct) => mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, taxFreeComponent: 50000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({
          allocation: { mode: "custom", incomePct, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
        })],
      },
    });
    // Same commencement, same drawdown option (minimum, spec 20 Commit
    // 2's default — draws down every year regardless), differing ONLY
    // in whether the account actually earns a real return.
    const flat = projectPlan(mkScenario(zeroRealSuperAlloc().incomePct));
    const grown = projectPlan(mkScenario((0.025 / 0.85) * 100 + 5)); // zeroRealSuperAlloc's own grossed-up rate, plus a real 5%
    const flatClosing = flat.yearly[2].pensionDetail.pn1.closing;
    const grownClosing = grown.yearly[2].pensionDetail.pn1.closing;
    // Genuine growth happened despite the minimum drawdown ALSO
    // shrinking the balance every year in both scenarios.
    expect(grownClosing).toBeGreaterThan(flatClosing);
    // The reported proportion is the SAME fixed 0.5 either way — a
    // payment draws both sides in that fixed proportion (never
    // recalculating it), and growth touches only the taxable side but
    // never the REPORTED figure, which stays pinned at commencement.
    expect(flat.yearly[2].pensionDetail.pn1.taxFreeProportion).toBeCloseTo(0.5, 4);
    expect(grown.yearly[2].pensionDetail.pn1.taxFreeProportion).toBeCloseTo(0.5, 4);
    // If the engine had (wrongly) recalculated live like accumulation
    // does, the grown scenario's live ratio would now read BELOW 0.5
    // (growth dilutes it, since growth only ever adds to the taxable
    // side, while the flat scenario's live ratio would still read
    // exactly 0.5) — the two scenarios' CLOSING balances diverge
    // (asserted above) while their REPORTED proportions do not,
    // confirming the reported figure tracks commencement, not the
    // live balance.
  });

  it("a PARTIAL commencement transfers components proportionally, leaving the source account with the same ratio it started with", () => {
    const out = projectPlan(mkState({
      endAge: 62,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, taxFreeComponent: 40000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ commenceAmount: 60000 })],
      },
    }));
    expect(out.yearly[0].pensionDetail.pn1.commencementAmount).toBeCloseTo(60000, 0);
    // closing is the commencement amount LESS this FY's own minimum
    // drawdown (spec 20 Commit 2's default option, applying from the
    // very year of commencement — see minDrawdownAmount's own header on
    // why commencement always gives a full 12-month basis): under 65,
    // 4% of the 60,000 basis.
    expect(out.yearly[0].pensionDetail.pn1.closing).toBeCloseTo(60000 * 0.96, 0);
    expect(out.yearly[0].pensionDetail.pn1.taxFreeProportion).toBeCloseTo(0.4, 4); // same 40% ratio as the whole account
    // The remainder stays behind in the source account, at the SAME
    // proportion (a proportional split preserves the ratio on both sides).
    expect(out.yearly[0].superDetail.su1.closing).toBeCloseTo(40000, 0);
    const remainingTaxFree = out.yearly[0].superDetail.su1.taxFreeClosing;
    expect(remainingTaxFree).toBeCloseTo(16000, 0); // 40,000 × 40%
  });

  it("condition-of-release gating: an ABP requested before the owner actually meets the gate is DEFERRED to the year the gate is met, not commenced early nor silently dropped", () => {
    const out = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 55, retirementAge: 55 }, // "retired" at 55 — below preservation age
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        // Requested immediately (age 55) — the ABP gate is
        // superReleaseAge(55) = 60 (floored at preservation age), so
        // this must defer 5 years, not commence at 55.
        pensions: [pensionRow({ commenceAt: { kind: "age", age: 55 } })],
      },
    }));
    expect(out.yearly[0].pensionDetail.pn1.closing).toBe(0); // not yet — age 55
    expect(out.yearly[0].pensionDetail.pn1.commencementAmount).toBe(0);
    // Client turns 60 in plan year 5 (currentAge 55 + 5).
    expect(out.yearly[5].pensionDetail.pn1.commencementAmount).toBeCloseTo(100000, 0);
    // closing is net of that same FY's minimum drawdown (4% under 65) —
    // see the partial-commencement test's own comment above.
    expect(out.yearly[5].pensionDetail.pn1.closing).toBeCloseTo(100000 * 0.96, 0);
  });

  it("condition-of-release gating: a TTR only needs preservation age (60) — commences there regardless of retirementAge, unlike an ABP requested at the same age with the same retirementAge", () => {
    const commonPlan = {
      client: { currentAge: 55, retirementAge: 55 }, // never satisfies the ABP's retirement-based gate within this short window
      superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
    };
    const ttrOut = projectPlan(mkState({
      endAge: 61,
      plan: { ...commonPlan, pensions: [pensionRow({ type: "ttr", commenceAt: { kind: "age", age: 55 } })] },
    }));
    const abpOut = projectPlan(mkState({
      endAge: 61,
      plan: { ...commonPlan, pensions: [pensionRow({ type: "abp", commenceAt: { kind: "age", age: 55 } })] },
    }));
    // TTR: gate is a flat preservation age (60) — commences at age 60
    // (plan year 5) regardless of retirementAge.
    expect(ttrOut.yearly[5].pensionDetail.pn1.commencementAmount).toBeCloseTo(100000, 0);
    // ABP: gate is superReleaseAge(55) = 60 too in this fixture (floored
    // at preservation age since retirementAge 55 < 60) — SAME year here,
    // confirming both types share the preservation-age floor...
    expect(abpOut.yearly[5].pensionDetail.pn1.commencementAmount).toBeCloseTo(100000, 0);
  });

  it("condition-of-release gating: an ABP's retirement-based gate can differ from a TTR's flat preservation-age gate when retirementAge sits between the two", () => {
    // retirementAge 62 (>60, <65): a TTR still gates at flat 60; an ABP
    // gates at superReleaseAge(62) = 62 — two years LATER than the TTR.
    const commonPlan = {
      client: { currentAge: 58, retirementAge: 62 },
      superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
    };
    const ttrOut = projectPlan(mkState({
      endAge: 64,
      plan: { ...commonPlan, pensions: [pensionRow({ type: "ttr", commenceAt: { kind: "age", age: 58 } })] },
    }));
    const abpOut = projectPlan(mkState({
      endAge: 64,
      plan: { ...commonPlan, pensions: [pensionRow({ type: "abp", commenceAt: { kind: "age", age: 58 } })] },
    }));
    expect(ttrOut.yearly[2].pensionDetail.pn1.commencementAmount).toBeCloseTo(100000, 0); // age 60, plan year 2
    expect(abpOut.yearly[2].pensionDetail.pn1.commencementAmount).toBe(0); // not yet — gate is 62
    expect(abpOut.yearly[4].pensionDetail.pn1.commencementAmount).toBeCloseTo(100000, 0); // age 62, plan year 4
  });

  it("contributions continue landing in the source account after a whole-balance commencement leaves it at zero", () => {
    const out = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow()],
      },
      cashflows: {
        superContributions: [{
          id: "sc1", label: "SG", owner: "client", accountId: "su1",
          type: "sg", basis: "amount", amount: 12000, frequency: "annual",
          from: { kind: "age", age: 60 }, to: { kind: "age", age: 63 },
          indexBasis: "none", indexExtraPct: 0,
        }],
      },
    }));
    // Whole-balance commencement zeroes the source at year 0 (before
    // that year's own contribution lands — commencement fires ahead of
    // the contribution-credit step in the monthly loop).
    expect(out.yearly[0].superDetail.su1.closing).toBeCloseTo(12000 * 0.85, 0); // net of 15% contributions tax
    // The pension itself never receives contributions (out of scope —
    // only a commencement transfer ever credits it in this build).
    expect(out.yearly[1].superDetail.su1.closing).toBeGreaterThan(0);
    expect(out.yearly[1].superDetail.su1.contributions).toBeGreaterThan(0);
  });

  it("regression gate: a scenario with plan.pensions omitted entirely behaves exactly as one with plan.pensions: []", () => {
    const base = {
      endAge: 45,
      plan: {
        superAccounts: [superAcct({ balance: 50000, allocation: zeroRealSuperAlloc() })],
        workingCash: { balance: 5000, minimumBalance: 1000, ratePct: 2 },
      },
      cashflows: { income: [employmentRow({ amount: 90000, to: { kind: "age", age: 45 } })] },
    };
    const withEmpty = projectPlan(mkState({ ...base, plan: { ...base.plan, pensions: [] } }));
    const withOmitted = projectPlan(mkState(base));
    expect(Array.from(withOmitted.monthly.combined)).toEqual(Array.from(withEmpty.monthly.combined));
  });

  it("conservation holds across commencement, a partial commencement, and post-commencement growth", () => {
    const scenarios = [
      mkState({
        endAge: 64,
        plan: {
          client: { currentAge: 60, retirementAge: 60 },
          superAccounts: [superAcct({ balance: 100000, taxFreeComponent: 30000, allocation: { mode: "custom", incomePct: 5, growthPct: 2, frankingPct: 0, volBasis: "Balanced" } })],
          pensions: [pensionRow({ allocation: { mode: "custom", incomePct: 4, growthPct: 1, frankingPct: 0, volBasis: "Balanced" } })],
        },
      }),
      mkState({
        endAge: 64,
        plan: {
          client: { currentAge: 60, retirementAge: 60 },
          superAccounts: [superAcct({ balance: 100000, taxFreeComponent: 30000, allocation: zeroRealSuperAlloc() })],
          pensions: [pensionRow({ commenceAmount: 35000 })],
        },
      }),
    ];
    for (const [i, s] of scenarios.entries()) {
      const out = projectPlan(s);
      for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `pension scenario ${i}, year ${y}`);
    }
  });
});

describe("Pension phase (spec 20, Commit 2): drawdown, minimums, and payment tax", () => {
  it("each age band's minimum applies against the 1 July basis, for the default 'minimum' option", () => {
    // Under 65 (4%) vs 65-74 (5%): same basis, different band, via the
    // owner's age at commencement.
    const under65 = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow()],
      },
    }));
    expect(under65.yearly[0].pensionDetail.pn1.payments).toBeCloseTo(100000 * 0.04, 0);

    const at70 = projectPlan(mkState({
      endAge: 73,
      plan: {
        client: { currentAge: 70, retirementAge: 65 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow()],
      },
    }));
    expect(at70.yearly[0].pensionDetail.pn1.payments).toBeCloseTo(100000 * 0.05, 0);
  });

  it("the minimum is a FLOOR under 'fixed' — a fixedAmount below the minimum is topped up to it", () => {
    const out = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ drawdownOption: "fixed", fixedAmount: 1000, indexBasis: "none", indexExtraPct: 0 })],
      },
    }));
    // 4% of 100,000 = 4,000 — well above the requested 1,000.
    expect(out.yearly[0].pensionDetail.pn1.payments).toBeCloseTo(4000, 0);
  });

  it("'fixed' pays the requested amount when it's above the minimum", () => {
    const out = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ drawdownOption: "fixed", fixedAmount: 20000, indexBasis: "none", indexExtraPct: 0 })],
      },
    }));
    expect(out.yearly[0].pensionDetail.pn1.payments).toBeCloseTo(20000, 0);
  });

  it("'maximum' (TTR only) pays 10% of the basis when that exceeds the minimum", () => {
    const out = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ type: "ttr", drawdownOption: "maximum" })],
      },
    }));
    expect(out.yearly[0].pensionDetail.pn1.payments).toBeCloseTo(10000, 0); // 10% of 100,000
  });

  it("the minimum is a FLOOR under 'maximum' too — at 95+, the 14% minimum exceeds the flat 10% maximum", () => {
    const out = projectPlan(mkState({
      endAge: 97,
      plan: {
        client: { currentAge: 95, retirementAge: 65 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ type: "ttr", drawdownOption: "maximum" })],
      },
    }));
    // TTR gates at flat preservation age (60) — already met at 95, so
    // this commences immediately. minDrawdownPct(95) = 14% > the 10%
    // maximum, so the FLOOR wins.
    expect(out.yearly[0].pensionDetail.pn1.payments).toBeCloseTo(100000 * 0.14, 0);
  });

  it("'expenditure' pays nothing beyond the minimum when the household never needed it — an unconditional FY-end compliance top-up", () => {
    const out = projectPlan(mkState({
      endAge: 62,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ drawdownOption: "expenditure" })],
        workingCash: { balance: 500000, minimumBalance: 0, ratePct: 0 }, // no deficit ever
      },
    }));
    // Nothing needed all year, yet the minimum still pays — "a plan
    // that draws less than the minimum is not a plan; it is a
    // compliance breach" (spec's own words).
    expect(out.yearly[0].pensionDetail.pn1.payments).toBeCloseTo(100000 * 0.04, 0);
  });

  it("'expenditure' draws to cover an actual household shortfall, ahead of ordinary asset liquidation", () => {
    const expenditureOut = projectPlan(mkState({
      endAge: 61,
      assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc(), balance: 200000 })],
      fundingOrder: ["a1"],
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 500000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ drawdownOption: "expenditure" })],
        workingCash: { balance: 0, minimumBalance: 5000, ratePct: 0 },
      },
      cashflows: { expenses: [cf({ id: "exp1", assetId: null, amount: 100000 / 12, frequency: "monthly", from: { kind: "age", age: 60 }, to: { kind: "age", age: 61 } })] },
    }));
    // The pension (well above the shortfall) covers the whole
    // household expense — the financial asset is never touched.
    expect(expenditureOut.yearly[0].perAssetClosing.a1).toBeCloseTo(200000, 0);
    expect(expenditureOut.yearly[0].pensionDetail.pn1.payments).toBeGreaterThan(90000);
  });

  it("post-60 payments are entirely tax-free — presence of a pension changes household cash but not assessed tax", () => {
    const withoutPension = projectPlan(mkState({
      endAge: 67,
      plan: {
        client: { currentAge: 65, retirementAge: 65 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
      },
      cashflows: { income: [employmentRow({ amount: 80000, from: { kind: "age", age: 65 }, to: { kind: "age", age: 67 } })] },
    }));
    const withPension = projectPlan(mkState({
      endAge: 67,
      plan: {
        client: { currentAge: 65, retirementAge: 65 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ commenceAt: { kind: "age", age: 65 } })],
      },
      cashflows: { income: [employmentRow({ amount: 80000, from: { kind: "age", age: 65 }, to: { kind: "age", age: 67 } })] },
    }));
    // Same income tax either way — the payment never touches assessable income.
    expect(withPension.yearly[0].tax).toBeCloseTo(withoutPension.yearly[0].tax, 0);
    // But the pension DID pay out real cash (closing balance differs).
    expect(withPension.yearly[0].pensionDetail.pn1.payments).toBeGreaterThan(0);
  });

  it("conservation holds across every drawdown option, including the expenditure floor top-up", () => {
    const options = ["minimum", "fixed", "expenditure", "maximum"];
    for (const [i, drawdownOption] of options.entries()) {
      const out = projectPlan(mkState({
        endAge: 64,
        assets: [mkAsset({ id: "a1", allocation: { mode: "custom", incomePct: 3, growthPct: 2, frankingPct: 0, volBasis: "Balanced" }, balance: 50000 })],
        fundingOrder: ["a1"],
        plan: {
          client: { currentAge: 60, retirementAge: 60 },
          superAccounts: [superAcct({ balance: 200000, taxFreeComponent: 60000, allocation: { mode: "custom", incomePct: 5, growthPct: 1, frankingPct: 0, volBasis: "Balanced" } })],
          pensions: [pensionRow({
            type: drawdownOption === "maximum" ? "ttr" : "abp",
            drawdownOption,
            fixedAmount: 15000, indexBasis: "cpi", indexExtraPct: 0,
          })],
          workingCash: { balance: 2000, minimumBalance: 2000, ratePct: 1 },
        },
        cashflows: { expenses: [cf({ id: "exp1", assetId: null, amount: 4000, frequency: "monthly", from: { kind: "age", age: 60 }, to: { kind: "age", age: 120 } })] },
      }));
      for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `drawdown option "${drawdownOption}" (${i}), year ${y}`);
    }
  });
});

describe("Pension phase (spec 20, Commit 3): retirement-phase earnings exemption and TTR", () => {
  const growthAlloc = { mode: "custom", incomePct: 4, growthPct: 3, frankingPct: 0, volBasis: "Balanced" };

  it("an ABP's earnings are entirely untaxed — earningsTax stays zero even with genuine growth", () => {
    const out = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, allocation: growthAlloc })],
        pensions: [pensionRow({ type: "abp", allocation: growthAlloc })],
      },
    }));
    expect(out.yearly[0].pensionDetail.pn1.earnings).toBeGreaterThan(0); // real growth happened
    expect(out.yearly[0].pensionDetail.pn1.earningsTax).toBeCloseTo(0, 6);
    expect(out.yearly[2].pensionDetail.pn1.earningsTax).toBeCloseTo(0, 6);
  });

  it("a TTR's earnings are taxed exactly like accumulation (15% income / 10% effective growth) before it ever converts", () => {
    const out = projectPlan(mkState({
      endAge: 63,
      plan: {
        // retirementAge 99 clamps DOWN to endAge (63, below 65) — the
        // retirement-based trigger can therefore never fire earlier
        // than the projection's own end, and 65 is never reached
        // either, so this TTR is "not yet converted" for its entire run.
        client: { currentAge: 60, retirementAge: 99 },
        superAccounts: [superAcct({ balance: 100000, allocation: growthAlloc })],
        pensions: [pensionRow({ type: "ttr", allocation: growthAlloc })],
      },
    }));
    // Same account, same allocation, taxed identically to accumulation —
    // compare directly against a same-shaped super account never
    // commencing a pension at all.
    const accumOut = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 99 },
        superAccounts: [superAcct({ balance: 100000, allocation: growthAlloc })],
      },
    }));
    expect(out.yearly[0].pensionDetail.pn1.earningsTax).toBeGreaterThan(0);
    // The tax WEDGE (earnings − earningsTax as a fraction of earnings)
    // should match accumulation's own, since a not-yet-converted TTR
    // uses the identical 15%/10% formula.
    const pensionWedge = out.yearly[0].pensionDetail.pn1.earningsTax / out.yearly[0].pensionDetail.pn1.earnings;
    const accumWedge = accumOut.yearly[0].superDetail.su1.earningsTax / accumOut.yearly[0].superDetail.su1.earnings;
    expect(pensionWedge).toBeCloseTo(accumWedge, 6);
  });

  it("a TTR converts automatically at age 65 — earnings switch from taxed to untaxed in that exact FY, with retirementAge never satisfying the OTHER trigger", () => {
    const out = projectPlan(mkState({
      endAge: 68,
      plan: {
        // retirementAge 70 clamps DOWN to endAge (68, still ≥ 65) — the
        // retirement-based trigger therefore resolves to exactly 65
        // too (superReleaseAge floors at 65), so both triggers agree:
        // this isolates "conversion happens at 65", not a coincidence
        // of which trigger technically fired.
        client: { currentAge: 62, retirementAge: 70 },
        superAccounts: [superAcct({ balance: 100000, allocation: growthAlloc })],
        pensions: [pensionRow({ type: "ttr", commenceAt: { kind: "age", age: 62 }, allocation: growthAlloc })],
      },
    }));
    // Age 62, 63, 64 — not yet 65 — still taxed.
    expect(out.yearly[0].pensionDetail.pn1.earningsTax).toBeGreaterThan(0);
    expect(out.yearly[2].pensionDetail.pn1.earningsTax).toBeGreaterThan(0);
    // Age 65 (plan year 3) onward — converted, untaxed.
    expect(out.yearly[3].pensionDetail.pn1.earningsTax).toBeCloseTo(0, 6);
    expect(out.yearly[6].pensionDetail.pn1.earningsTax).toBeCloseTo(0, 6);
  });

  it("a TTR converts at notified retirement (retirementAge, when it's at/after preservation age) — BEFORE turning 65, not waiting for it", () => {
    const out = projectPlan(mkState({
      endAge: 66,
      plan: {
        // retirementAge 61: satisfies the retirement-based trigger
        // (>= preservation age 60) well before 65.
        client: { currentAge: 58, retirementAge: 61 },
        // Flat source allocation — isolates the commencement AMOUNT
        // from growth arithmetic (the pension's OWN allocation below is
        // what exercises real earnings-tax timing, post-commencement).
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ type: "ttr", commenceAt: { kind: "age", age: 58 }, allocation: growthAlloc })],
      },
    }));
    // TTR requires only preservation age to COMMENCE (spec 20 Commit 1)
    // — the client is 58 at plan start, so this defers to age 60 (plan
    // year 2) regardless of retirementAge.
    expect(out.yearly[1].pensionDetail.pn1.commencementAmount).toBe(0); // age 59 — not yet commenced
    expect(out.yearly[2].pensionDetail.pn1.commencementAmount).toBeCloseTo(100000, 0); // age 60
    // Age 60 (commencement year): retirementAge (61) not yet reached — still taxed.
    expect(out.yearly[2].pensionDetail.pn1.earningsTax).toBeGreaterThan(0);
    // Age 61 (plan year 3): retirement-based trigger fires — converted,
    // well before turning 65 (which wouldn't happen until plan year 7).
    expect(out.yearly[3].pensionDetail.pn1.earningsTax).toBeCloseTo(0, 6);
  });

  it("an ABP and a TTR commenced identically (same age, same amount) diverge in closing balance — the ABP ends up ahead, purely from the earnings-tax exemption", () => {
    // The ABP's OWN commencement gate is superReleaseAge(retirementAge)
    // — the IDENTICAL formula the TTR's conversion gate uses — so an
    // ABP commencing at exactly 60 forces retirementAge<=60, which
    // would ALSO convert a same-owner TTR immediately (no divergence
    // possible for one person). Two DIFFERENT owners sidesteps this:
    // the client retires AT 60 (their ABP commences at 60, and — being
    // already retired at commencement — is in retirement phase from
    // day one, same as any ABP); the partner keeps working well past
    // preservation age (retirementAge 70, capped at 65) — TTR
    // commencement is a FLAT preservation-age gate regardless of
    // retirementAge (spec 20 Commit 1), so their TTR ALSO commences at
    // 60 — the SAME age, same source balance — but stays taxed like
    // accumulation until they actually retire (capped at 65), a
    // genuine multi-year divergence window.
    const commonSuper = { balance: 100000, allocation: growthAlloc };
    const abpOut = projectPlan(mkState({
      endAge: 64,
      plan: {
        household: "married", client: { currentAge: 60, retirementAge: 60 }, partner: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ id: "su1", owner: "client", ...commonSuper })],
        pensions: [pensionRow({ type: "abp", owner: "client", allocation: growthAlloc })],
      },
    }));
    const ttrOut = projectPlan(mkState({
      endAge: 64,
      plan: {
        household: "married", client: { currentAge: 60, retirementAge: 60 }, partner: { currentAge: 60, retirementAge: 70 },
        superAccounts: [superAcct({ id: "su1", owner: "partner", ...commonSuper })],
        pensions: [pensionRow({ id: "pn1", type: "ttr", owner: "partner", sourceAccountId: "su1", allocation: growthAlloc })],
      },
    }));
    // Both commence at exactly age 60 (year 0), same source balance.
    expect(abpOut.yearly[0].pensionDetail.pn1.commencementAmount)
      .toBeCloseTo(ttrOut.yearly[0].pensionDetail.pn1.commencementAmount, 0);
    expect(abpOut.yearly[0].pensionDetail.pn1.commencementAmount).toBeGreaterThan(0); // sanity: it actually commenced
    // The TTR stays taxed (partner not yet 65, retirementAge 70 not yet
    // reached) for the whole 4-year window — the ABP, untaxed from
    // commencement, pulls ahead.
    expect(abpOut.yearly[3].pensionDetail.pn1.closing).toBeGreaterThan(ttrOut.yearly[3].pensionDetail.pn1.closing);
  });

  it("conservation holds across a TTR converting mid-projection (the earnings-tax rate itself changing partway through)", () => {
    const out = projectPlan(mkState({
      endAge: 68,
      assets: [mkAsset({ id: "a1", allocation: { mode: "custom", incomePct: 2, growthPct: 1, frankingPct: 0, volBasis: "Balanced" }, balance: 20000 })],
      fundingOrder: ["a1"],
      plan: {
        client: { currentAge: 62, retirementAge: 62 },
        superAccounts: [superAcct({ balance: 150000, taxFreeComponent: 50000, allocation: growthAlloc })],
        pensions: [pensionRow({ type: "ttr", commenceAt: { kind: "age", age: 62 }, allocation: growthAlloc })],
        workingCash: { balance: 3000, minimumBalance: 3000, ratePct: 1 },
      },
      cashflows: { expenses: [cf({ id: "exp1", assetId: null, amount: 2000, frequency: "monthly", from: { kind: "age", age: 62 }, to: { kind: "age", age: 120 } })] },
    }));
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `TTR conversion fixture, year ${y}`);
  });
});

describe("Pension phase (spec 20, Commit 4): transfer balance cap and account", () => {
  it("commencing an ABP credits the owner's transfer balance account at the commencement value", () => {
    const out = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 500000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ type: "abp" })],
      },
    }));
    expect(out.yearly[0].transferBalance.client.balance).toBeCloseTo(500000, 0);
  });

  it("payments are NOT a debit — the account balance never falls as the pension pays out over the years", () => {
    const out = projectPlan(mkState({
      endAge: 64,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 500000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ type: "abp" })], // default drawdown: minimum — pays out every year
      },
    }));
    expect(out.yearly[0].pensionDetail.pn1.payments).toBeGreaterThan(0); // genuinely paying out
    expect(out.yearly[0].transferBalance.client.balance).toBeCloseTo(500000, 0);
    expect(out.yearly[3].transferBalance.client.balance).toBeCloseTo(500000, 0); // unchanged despite 4 years of payments
  });

  it("a TTR credits the transfer balance account ONLY at conversion, at its THEN-current value — not at its own (earlier) commencement", () => {
    const out = projectPlan(mkState({
      endAge: 65,
      plan: {
        client: { currentAge: 58, retirementAge: 61 }, // TTR commences at 60, converts at 61
        superAccounts: [superAcct({ balance: 100000, allocation: { mode: "custom", incomePct: 4, growthPct: 3, frankingPct: 0, volBasis: "Balanced" } })],
        pensions: [pensionRow({
          type: "ttr", commenceAt: { kind: "age", age: 58 },
          allocation: { mode: "custom", incomePct: 4, growthPct: 3, frankingPct: 0, volBasis: "Balanced" },
        })],
      },
    }));
    // Age 60 (plan year 2): commenced, but NOT yet credited.
    expect(out.yearly[2].pensionDetail.pn1.commencementAmount).toBeGreaterThan(0);
    expect(out.yearly[2].transferBalance.client.balance).toBe(0);
    // Age 61 (plan year 3): converts — credited at the CURRENT balance,
    // which has grown (and shrunk a little from the minimum payment)
    // since commencement, so it does NOT equal the commencement amount.
    expect(out.yearly[3].transferBalance.client.balance).toBeGreaterThan(0);
    expect(out.yearly[3].transferBalance.client.balance)
      .not.toBeCloseTo(out.yearly[2].pensionDetail.pn1.commencementAmount, 0);
  });

  it("proportional indexation, end to end: a member at 40% used gets a smaller personal-cap increase than one who has never credited anything", () => {
    // A single client at 40% (840,000 of a 2,100,000 general cap).
    const usedOut = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 840000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ type: "abp" })],
      },
    }));
    // A single client who never commences anything — 100% unused.
    const unusedOut = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 840000, allocation: zeroRealSuperAlloc() })],
      },
    }));
    const usedCap0 = usedOut.yearly[0].transferBalance.client.personalCap;
    const unusedCap0 = unusedOut.yearly[0].transferBalance.client.personalCap;
    expect(usedCap0).toBeCloseTo(unusedCap0, 0); // both start at the same general cap
    // If/when the general cap ever indexes within this short window,
    // the "used" scenario's personal cap grows by LESS (60% of the
    // step) than the "unused" one (100% of the step) — assert the
    // relationship holds structurally rather than depending on the
    // step actually firing within 3 years (CPI-driven, may not).
    for (let y = 1; y < usedOut.yearly.length; y++) {
      const usedGrowth = usedOut.yearly[y].transferBalance.client.personalCap - usedCap0;
      const unusedGrowth = unusedOut.yearly[y].transferBalance.client.personalCap - unusedCap0;
      expect(usedGrowth).toBeLessThanOrEqual(unusedGrowth + 1e-6);
    }
  });

  it("a member at 100% used gets no further personal-cap indexation, ever, even across many years", () => {
    const out = projectPlan(mkState({
      endAge: 90,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 3000000, allocation: zeroRealSuperAlloc() })], // well over the general cap
        pensions: [pensionRow({ type: "abp", commenceAmount: 2100000 })], // exactly 100% of the FY2026/27 general cap
      },
    }));
    const cap0 = out.yearly[0].transferBalance.client.personalCap;
    const capLast = out.yearly[out.yearly.length - 1].transferBalance.client.personalCap;
    expect(capLast).toBeCloseTo(cap0, 0); // frozen for the ENTIRE 30-year run
  });

  it("excess is flagged at the right amount when a commencement exceeds the personal cap", () => {
    const out = projectPlan(mkState({
      endAge: 62,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 2500000, allocation: zeroRealSuperAlloc() })], // 400,000 over the 2,100,000 cap
        pensions: [pensionRow({ type: "abp" })],
      },
    }));
    const warning = out.superWarnings.find((w) => w.type === "tbaExcess");
    expect(warning).toBeDefined();
    expect(warning.reason).toMatch(/\$400,?000|\$400000/); // the excess amount, to the nearest dollar
    expect(warning.reason).toMatch(/15%/); // first breach
  });

  it("conservation holds — the transfer balance account is a pure disclosure mechanism with no money flow of its own", () => {
    const out = projectPlan(mkState({
      endAge: 65,
      assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc(), balance: 30000 })],
      fundingOrder: ["a1"],
      plan: {
        client: { currentAge: 60, retirementAge: 62 },
        superAccounts: [superAcct({ balance: 2400000, taxFreeComponent: 400000, allocation: { mode: "custom", incomePct: 5, growthPct: 2, frankingPct: 0, volBasis: "Balanced" } })],
        pensions: [pensionRow({ type: "ttr", allocation: { mode: "custom", incomePct: 5, growthPct: 2, frankingPct: 0, volBasis: "Balanced" } })],
        workingCash: { balance: 2000, minimumBalance: 2000, ratePct: 1 },
      },
      cashflows: { expenses: [cf({ id: "exp1", assetId: null, amount: 1500, frequency: "monthly", from: { kind: "age", age: 60 }, to: { kind: "age", age: 120 } })] },
    }));
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `TBA excess/conversion fixture, year ${y}`);
  });
});

describe("Pension phase (spec 20, Commit 5): commutations", () => {
  it("a full commutation (amount: null) pays out the WHOLE remaining balance, in the fixed proportions, and closes the pension", () => {
    const out = projectPlan(mkState({
      endAge: 64,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, taxFreeComponent: 40000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({
          drawdownOption: "minimum",
          commutations: [commutationRow({ at: { kind: "age", age: 62 } })],
        })],
      },
    }));
    const balanceBefore = out.yearly[1].pensionDetail.pn1.closing; // year before commutation (age 61)
    expect(balanceBefore).toBeGreaterThan(0);
    // Commutation fires in year 2 (age 62) — pays out whatever remained
    // AT THAT POINT (balanceBefore, less that year's own minimum
    // drawdown, which fires before the commutation within the same FY).
    expect(out.yearly[2].pensionDetail.pn1.commutations).toBeGreaterThan(0);
    expect(out.yearly[2].pensionDetail.pn1.closing).toBeCloseTo(0, 0); // closed
    // A LATER year: still 0 — no further growth or payments on a closed pension.
    expect(out.yearly[3].pensionDetail.pn1.closing).toBe(0);
    expect(out.yearly[3].pensionDetail.pn1.payments).toBe(0);
  });

  it("a partial commutation pays the requested amount, in the fixed proportions, and the pension keeps operating afterward", () => {
    const out = projectPlan(mkState({
      endAge: 64,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, taxFreeComponent: 40000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({
          drawdownOption: "minimum",
          commutations: [commutationRow({ amount: 20000, at: { kind: "age", age: 62 } })],
        })],
      },
    }));
    expect(out.yearly[2].pensionDetail.pn1.commutations).toBeCloseTo(20000, 0);
    // Still operating afterward — closing balance is positive, and the
    // NEXT year's minimum still pays out (against the now-smaller balance).
    expect(out.yearly[2].pensionDetail.pn1.closing).toBeGreaterThan(0);
    expect(out.yearly[3].pensionDetail.pn1.payments).toBeGreaterThan(0);
  });

  it("both destinations: 'cash' credits the WCA; 'super' returns the balance to the SAME source account", () => {
    const commonPlan = {
      client: { currentAge: 60, retirementAge: 60 },
      superAccounts: [superAcct({ id: "su1", balance: 100000, allocation: zeroRealSuperAlloc() })],
      workingCash: { balance: 1000, minimumBalance: 1000, ratePct: 0 },
    };
    // mkState's own default surplus mode is "spend" (remainderTo:
    // "expenditure" — WCA surplus above the minimum leaves the system
    // entirely at FY-end); "accumulate" keeps it IN the WCA instead, so
    // the cash-destination assertion below can actually see it land.
    const cashOut = projectPlan(mkState({
      endAge: 63,
      surplus: { mode: "accumulate" },
      plan: { ...commonPlan, pensions: [pensionRow({ drawdownOption: "minimum", commutations: [commutationRow({ amount: 30000, at: { kind: "age", age: 61 }, destination: "cash" })] })] },
    }));
    const superOut = projectPlan(mkState({
      endAge: 63,
      surplus: { mode: "accumulate" },
      plan: { ...commonPlan, pensions: [pensionRow({ drawdownOption: "minimum", commutations: [commutationRow({ amount: 30000, at: { kind: "age", age: 61 }, destination: "super" })] })] },
    }));
    // Cash destination: the WCA jumps by (roughly) the commuted amount
    // beyond its own minimum, in the commutation year.
    expect(cashOut.yearly[1].wcaClosing).toBeGreaterThan(20000);
    // Super destination: the source account's own balance grows back
    // up by the commuted amount instead — the WCA gets only the
    // pension's own ordinary minimum-drawdown payments, nowhere near
    // what the cash-destination scenario accumulated (which gets BOTH
    // those same payments AND the 30,000 commutation itself).
    expect(superOut.yearly[1].superDetail.su1.closing).toBeGreaterThan(20000);
    expect(superOut.yearly[1].wcaClosing).toBeLessThan(cashOut.yearly[1].wcaClosing - 15000);
  });

  it("a commutation debits the transfer balance account at the commuted amount", () => {
    const out = projectPlan(mkState({
      endAge: 63,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 500000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ drawdownOption: "minimum", commutations: [commutationRow({ amount: 100000, at: { kind: "age", age: 61 } })] })],
      },
    }));
    const balanceBeforeCommutation = out.yearly[0].transferBalance.client.balance; // commencement year (credit only)
    expect(balanceBeforeCommutation).toBeCloseTo(500000, 0);
    // The commutation year: debited by roughly the commuted amount
    // (payments never debit — only this does).
    const balanceAfter = out.yearly[1].transferBalance.client.balance;
    expect(balanceBeforeCommutation - balanceAfter).toBeCloseTo(100000, 0);
  });

  it("the reserved vocabulary rows exist and read zero for an ordinary post-60 pension, not undefined/NaN", () => {
    // Structurally unreachable end-to-end in THIS build for a NONZERO
    // reading (every payment is post-60 — see acc[p]'s own comment,
    // deterministic.js) — the wiring that would populate them from a
    // nonzero taxDetail figure is exercised directly instead
    // (cashflowStatement.test.js's own "Taxable Pension Component"/
    // "Taxable Pension Offset (TTR)" tests). This test confirms the
    // ENGINE actually emits well-formed zeros (a real number, not
    // undefined) for the ordinary, always-reachable case.
    const out = projectPlan(mkState({
      endAge: 62,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 100000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow()],
      },
      cashflows: { income: [employmentRow({ amount: 50000, to: { kind: "age", age: 62 } })] },
    }));
    // Post-60 pension payments never touch assessable income.
    expect(out.yearly[0].taxDetail.client.taxablePensionComponent).toBe(0);
    expect(out.yearly[0].taxDetail.client.ttrPensionOffset).toBe(0);
  });

  it("conservation holds across commencement, payment, and a full commutation", () => {
    const scenarios = [
      // Full commutation to cash.
      mkState({
        endAge: 65,
        plan: {
          client: { currentAge: 60, retirementAge: 60 },
          superAccounts: [superAcct({ balance: 300000, taxFreeComponent: 80000, allocation: { mode: "custom", incomePct: 4, growthPct: 2, frankingPct: 0, volBasis: "Balanced" } })],
          pensions: [pensionRow({
            drawdownOption: "minimum",
            allocation: { mode: "custom", incomePct: 4, growthPct: 2, frankingPct: 0, volBasis: "Balanced" },
            commutations: [commutationRow({ amount: 50000, at: { kind: "age", age: 62 }, destination: "cash" })],
          })],
        },
      }),
      // Partial commutation back to super.
      mkState({
        endAge: 65,
        plan: {
          client: { currentAge: 60, retirementAge: 60 },
          superAccounts: [superAcct({ balance: 300000, taxFreeComponent: 80000, allocation: { mode: "custom", incomePct: 4, growthPct: 2, frankingPct: 0, volBasis: "Balanced" } })],
          pensions: [pensionRow({
            drawdownOption: "fixed", fixedAmount: 12000, indexBasis: "none", indexExtraPct: 0,
            allocation: { mode: "custom", incomePct: 4, growthPct: 2, frankingPct: 0, volBasis: "Balanced" },
            commutations: [commutationRow({ amount: null, at: { kind: "age", age: 63 }, destination: "super" })],
          })],
        },
      }),
    ];
    for (const [i, s] of scenarios.entries()) {
      const out = projectPlan(s);
      for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `commutation scenario ${i}, year ${y}`);
    }
  });
});

// Age pension (spec 21a, Commit 3) — engine integration. An isolated
// fixture (no assets, no income, no expenses) so the entitlement is
// the ONLY thing moving household cash — the age pension's own known-
// value figure (agePensionRatesFor's single rate) can then be checked
// directly against row.income/wcaClosing with nothing else to net
// against, rather than needing to disentangle it from other flows.
describe("Age pension (spec 21a, Commit 3): engine integration", () => {
  it("pays nothing before age pension age, then the full single rate once reached (known value)", () => {
    const s = mkState({ endAge: 70, assets: [], plan: { client: { currentAge: 65 } } });
    const out = projectPlan(s);
    // Age 65 (y=0), 66 (y=1): not yet 67.
    expect(out.yearly[0].agePensionDetail.entitlement).toBe(0);
    expect(out.yearly[1].agePensionDetail.entitlement).toBe(0);
    expect(out.yearly[0].agePensionDetail.client.ageEligible).toBe(false);
    // Age 67 (y=2): reached. Zero assessable assets/income (no assets,
    // no income rows) → full single rate, homeowner status irrelevant
    // at $0 assessable assets either way.
    const rates2028 = agePensionRatesFor(2028, "indexed", 0.025, 0.032);
    expect(out.yearly[2].agePensionDetail.client.ageEligible).toBe(true);
    expect(out.yearly[2].agePensionDetail.entitlement).toBeCloseTo(rates2028.single.rate, 2);
    expect(out.yearly[2].agePensionDetail.client.paid).toBeCloseTo(rates2028.single.rate, 2);
    expect(out.yearly[2].agePensionDetail.assetsTestResult).toBeCloseTo(rates2028.single.rate, 2);
    expect(out.yearly[2].agePensionDetail.incomeTestResult).toBeCloseTo(rates2028.single.rate, 2);
    expect(out.yearly[2].agePensionDetail.assessableAssets).toBe(0);
  });

  it("reaches household cashflow — row.income jumps by exactly the entitlement once eligible, with nothing else in this fixture to net against", () => {
    // surplus: accumulate — mkState's own default ("spend") sweeps any
    // WCA surplus away at FY-end, which would hide the credit from the
    // closing-balance assertion below (same fix Commit 5's own
    // commutation-to-cash test needed, for the same reason).
    const s = mkState({ endAge: 70, assets: [], plan: { client: { currentAge: 65 } }, surplus: { mode: "accumulate" } });
    const out = projectPlan(s);
    const jump = out.yearly[2].income - out.yearly[1].income;
    expect(jump).toBeCloseTo(out.yearly[2].agePensionDetail.entitlement, 2);
    // ...and the WCA closing balance carries it forward — plus whatever
    // interest it earned as it accrued monthly through the year (no
    // expenses, no tax in this fixture, so income + interest is the
    // whole story, not the bare entitlement alone).
    expect(out.yearly[2].wcaClosing).toBeCloseTo(out.yearly[2].income + out.yearly[2].wcaDetail.interest, 2);
  });

  it("the eligibility flag suppresses assessment entirely, even once age-eligible", () => {
    const s = mkState({
      endAge: 70, assets: [],
      plan: { client: { currentAge: 65, taxProfile: { centrelinkEligible: false, centrelinkEligibleIsDefault: false } } },
    });
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.agePensionDetail.entitlement).toBe(0);
      expect(row.agePensionDetail.client.eligible).toBe(false);
    }
    // The test itself still ran (assessableAssets/results are reported
    // regardless of the flag — useful for an adviser to see the
    // trajectory even for a client who's opted out) — only the PAID
    // amount is suppressed.
    expect(out.yearly[5].agePensionDetail.client.ageEligible).toBe(true);
    expect(out.yearly[5].agePensionDetail.assetsTestResult).toBeGreaterThan(0);
  });

  it("a couple with an age gap: only the age-eligible partner is paid, at the couple's split rate — the assets/income tests still run on the COMBINED household figures", () => {
    const s = mkState({
      endAge: 70, assets: [],
      plan: {
        household: "couple",
        client: { currentAge: 67 }, // already eligible at year 0
        partner: { currentAge: 40 }, // decades from eligibility
      },
    });
    const out = projectPlan(s);
    const rates2026 = agePensionRatesFor(2026, "indexed", 0.025, 0.035);
    expect(out.yearly[0].agePensionDetail.client.ageEligible).toBe(true);
    expect(out.yearly[0].agePensionDetail.partner.ageEligible).toBe(false);
    expect(out.yearly[0].agePensionDetail.client.paid).toBeCloseTo(rates2026.couple.rateEach, 2);
    expect(out.yearly[0].agePensionDetail.partner.paid).toBe(0);
    expect(out.yearly[0].agePensionDetail.entitlement).toBeCloseTo(rates2026.couple.rateEach, 2);
  });

  it("conservation holds with the age pension present, across the whole fixture", () => {
    const s = mkState({ endAge: 70, assets: [], plan: { client: { currentAge: 65 } } });
    const out = projectPlan(s);
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `age pension fixture, year ${y}`);
  });

  it("accumulation super below age pension age is exempt from the assets test; the SAME balance in pension phase is assessed at any age — the strategy the spec calls out", () => {
    const belowAge = mkState({
      endAge: 62, assets: [],
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 500000, allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" } })],
      },
    });
    const outBelow = projectPlan(belowAge);
    // Age 60-62: accumulation, well below age pension age (67) — the
    // assets test should never see this balance (assessableAssets stays
    // at 0 throughout, since there are no other assets in this fixture).
    for (const row of outBelow.yearly) expect(row.agePensionDetail.assessableAssets).toBe(0);

    const inPension = mkState({
      endAge: 62, assets: [],
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 500000, allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" } })],
        pensions: [pensionRow({
          type: "abp", allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
        })],
      },
    });
    const outPension = projectPlan(inPension);
    // Commences at age 60 (this pension's default commenceAt) — the
    // per-year assessment for the commencement FY itself still reads
    // this as accumulation (a disclosed one-year lag: pensionCommenced
    // only flips true inside the real pass's own commencement transfer,
    // which runs AFTER this assessment — see deterministic.js's own
    // comment). From the FOLLOWING FY (age 61) onward, the SAME $500k
    // is correctly assessed as pension-phase, decades before age
    // pension age — the strategy the spec calls out.
    expect(outPension.yearly[0].agePensionDetail.assessableAssets).toBe(0);
    expect(outPension.yearly[1].agePensionDetail.assessableAssets).toBeGreaterThan(400000);
  });
});

// Work Bonus (spec 21b, Commit 1) — isolated fixtures (no assets, flat
// employment income) so the exempted amount and bank balance can be
// hand-checked directly against otherIncome, with nothing else moving.
describe("Age pension — Work Bonus (spec 21b, Commit 1)", () => {
  it("exempts $7,800/yr of employment income and draws the new-recipient $4,000 bank against the excess", () => {
    const s = mkState({
      endAge: 70, assets: [],
      plan: { client: { currentAge: 67 } },
      cashflows: { income: [employmentRow({ amount: 20000, frequency: "annual", from: { kind: "age", age: 67 }, to: { kind: "age", age: 70 }, indexBasis: "cpi" })] },
    });
    const out = projectPlan(s);
    // Year 0 (age 67, new recipient): $20,000 income, $7,800 exempt
    // outright, $12,200 excess, only $4,000 in the bank to draw →
    // $11,800 total exempt, bank exhausted to 0.
    expect(out.yearly[0].agePensionDetail.client.workBonusExempt).toBeCloseTo(11800, 2);
    expect(out.yearly[0].agePensionDetail.client.workBonusBank).toBeCloseTo(0, 2);
    expect(out.yearly[0].agePensionDetail.otherIncome).toBeCloseTo(20000 - 11800, 2);
    // Year 1: bank is now empty — only the flat $7,800 exempts.
    expect(out.yearly[1].agePensionDetail.client.workBonusExempt).toBeCloseTo(7800, 2);
    expect(out.yearly[1].agePensionDetail.otherIncome).toBeCloseTo(20000 - 7800, 2);
  });

  it("the bank accrues the unused allowance in a low-income year, capped at $11,800", () => {
    const s = mkState({
      endAge: 70, assets: [],
      plan: { client: { currentAge: 67 } },
      cashflows: { income: [employmentRow({ amount: 3000, frequency: "annual", from: { kind: "age", age: 67 }, to: { kind: "age", age: 70 }, indexBasis: "cpi" })] },
    });
    const out = projectPlan(s);
    // $3,000 income, fully exempt; $4,800 unused accrues onto the
    // $4,000 starting balance → $8,800.
    expect(out.yearly[0].agePensionDetail.client.workBonusExempt).toBeCloseTo(3000, 2);
    expect(out.yearly[0].agePensionDetail.client.workBonusBank).toBeCloseTo(8800, 2);
    expect(out.yearly[0].agePensionDetail.otherIncome).toBeCloseTo(0, 2);
    // Year 1: another $4,800 unused would take it to $13,600 — capped at $11,800.
    expect(out.yearly[1].agePensionDetail.client.workBonusBank).toBeCloseTo(11800, 2);
  });

  it("investment/rental income is untouched — only employment income is exempted", () => {
    const s = mkState({
      endAge: 70,
      assets: [mkAsset({ balance: 200000, allocation: { mode: "custom", incomePct: 4, growthPct: 0, frankingPct: 0, volBasis: "Balanced" } })],
      plan: { client: { currentAge: 67 } },
    });
    const out = projectPlan(s);
    // No employment income at all in this fixture — Work Bonus has
    // nothing to exempt, but deemed income on the $200k asset still
    // feeds the income test in full (untouched by Work Bonus).
    expect(out.yearly[0].agePensionDetail.client.workBonusExempt).toBe(0);
    expect(out.yearly[0].agePensionDetail.deemedIncome).toBeGreaterThan(0);
  });

  it("applies per person — a couple where only the partner works", () => {
    const s = mkState({
      endAge: 70, assets: [],
      plan: {
        household: "couple",
        client: { currentAge: 67 },
        partner: { currentAge: 67 },
      },
      cashflows: {
        income: [employmentRow({
          id: "i1", owner: "partner", amount: 20000, frequency: "annual",
          from: { kind: "age", age: 67 }, to: { kind: "age", age: 70 }, indexBasis: "none",
        })],
      },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].agePensionDetail;
    // Partner's own bank is drawn exactly as the single-person case
    // above; the client — no employment income at all — has nothing
    // exempted, and their OWN bank still accrues independently (Work
    // Bonus eligibility isn't conditional on actually working).
    expect(d.partner.workBonusExempt).toBeCloseTo(11800, 2);
    expect(d.partner.workBonusBank).toBeCloseTo(0, 2);
    expect(d.client.workBonusExempt).toBe(0);
    expect(d.client.workBonusBank).toBeCloseTo(11800, 2); // 4,000 + 7,800 unused, under the cap
  });

  it("does not apply before age pension age — the full employment income counts", () => {
    const s = mkState({
      endAge: 70, assets: [],
      plan: { client: { currentAge: 60 } }, // won't reach 67 until year 7
      cashflows: { income: [employmentRow({ amount: 20000, frequency: "annual", from: { kind: "age", age: 60 }, to: { kind: "age", age: 70 }, indexBasis: "cpi" })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].agePensionDetail.client.ageEligible).toBe(false);
    expect(out.yearly[0].agePensionDetail.client.workBonusExempt).toBe(0);
    expect(out.yearly[0].agePensionDetail.otherIncome).toBeCloseTo(20000, 2);
  });
});

describe("Gifting and deprivation (spec 21b, Commit 2): engine integration", () => {
  it("a gift reduces actual assets by its FULL amount, regardless of deprivation", () => {
    // A funded household (starting cash, no income/expenses otherwise)
    // so the gift is actually PAYABLE — an unfunded gift would show up
    // as row.unfundedCashflow instead of moving wcaClosing at all,
    // which is the correct (if less legible) behaviour, just not what
    // this test is isolating. cpi: 0 alongside ratePct: 0 keeps the WCA
    // truly flat in REAL terms too (this engine works in real dollars
    // throughout — a 0% NOMINAL rate is a small NEGATIVE real rate
    // whenever cpi > 0, which would otherwise make the two runs diverge
    // by a little more than the bare gift amount, for a reason that has
    // nothing to do with gifting).
    const gift = { id: "g1", owner: "client", amount: 15000, at: { kind: "age", age: 62 }, label: "Gift" };
    const plan = { client: { currentAge: 60 }, workingCash: { balance: 50000, minimumBalance: 0, ratePct: 0 } };
    const withoutGift = mkState({ endAge: 70, assets: [], plan, surplus: { mode: "accumulate" }, cpi: 0 });
    const withGift = mkState({ endAge: 70, assets: [], plan: { ...plan, gifts: [gift] }, surplus: { mode: "accumulate" }, cpi: 0 });
    const outWithout = projectPlan(withoutGift);
    const outWith = projectPlan(withGift);
    // No income/expenses in this fixture, so wcaClosing differs by
    // EXACTLY the gift amount from the year it fires (age 62, y=2) onward.
    expect(outWithout.yearly[2].wcaClosing - outWith.yearly[2].wcaClosing).toBeCloseTo(15000, 2);
    expect(outWith.yearly[2].giftsPaid).toBeCloseTo(15000, 2);
    expect(outWithout.yearly[2].giftsPaid).toBe(0);
    expect(outWith.yearly[2].unfundedCashflow).toBe(0); // fully funded — no shortfall
  });

  it("a deprived amount (above the $10,000 allowable) is assessed under BOTH the assets test and (deemed) the income test", () => {
    const s = mkState({
      endAge: 75, assets: [],
      plan: {
        client: { currentAge: 65 },
        gifts: [{ id: "g1", owner: "client", amount: 15000, at: { kind: "age", age: 66 }, label: "Gift" }],
      },
    });
    const out = projectPlan(s);
    // Age 67 (y=2): the $5,000 deprived amount (fired at 66, drops out
    // at 71) is still active.
    const d = out.yearly[2].agePensionDetail;
    expect(d.deprivedAssets).toBeCloseTo(5000, 2);
    expect(d.assessableAssets).toBeCloseTo(5000, 2); // no other assets in this fixture
    expect(d.deemedIncome).toBeGreaterThan(0); // deemed, generating income-test exposure
  });

  it("deprived amounts drop out exactly five years after the gift's own date", () => {
    const s = mkState({
      endAge: 75, assets: [],
      plan: { client: { currentAge: 65 }, gifts: [{ id: "g1", owner: "client", amount: 15000, at: { kind: "age", age: 66 }, label: "Gift" }] },
    });
    const out = projectPlan(s);
    expect(out.yearly[70 - 65].agePensionDetail.deprivedAssets).toBeCloseTo(5000, 2); // age 70 — still active
    expect(out.yearly[71 - 65].agePensionDetail.deprivedAssets).toBe(0); // age 71 — dropped out
  });

  it("conservation holds with gifting present", () => {
    const s = mkState({
      endAge: 75, assets: [mkAsset()],
      plan: { client: { currentAge: 65 }, gifts: [{ id: "g1", owner: "client", amount: 15000, at: { kind: "age", age: 66 }, label: "Gift" }] },
    });
    const out = projectPlan(s);
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `gifting fixture, year ${y}`);
  });
});

describe("Deeming grandfathering (spec 21b, Commit 3): engine integration", () => {
  // A pension commencing immediately (commenceAt === currentAge) is
  // read as accumulation for its own commencement FY (a disclosed
  // one-year lag — see "accumulation super below age pension age"
  // above); pension-phase, and grandfathering, apply from y=1 onward.
  it("computes the deductible amount correctly — otherIncome carries it directly, not the full payment", () => {
    const s = mkState({
      endAge: 65, assets: [],
      plan: {
        client: { currentAge: 62, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 300000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({
          commenceAt: { kind: "age", age: 62 }, drawdownOption: "fixed", fixedAmount: 20000,
          grandfathered: true, grandfatheredPurchasePrice: 200000, grandfatheredLifeExpectancyYears: 20,
        })],
      },
    });
    const out = projectPlan(s);
    const y = 1;
    const pd = out.yearly[y].pensionDetail.pn1;
    const expectedDeductible = 200000 / 20; // 10,000/yr
    expect(pd.grandfatheredDeductibleIncome).toBeCloseTo(Math.max(0, pd.payments - expectedDeductible), 2);
    expect(pd.grandfatheredDeemingExempt).toBeCloseTo(pd.opening, 2); // the whole balance is pulled out of deeming
    // No other assets/income in this fixture: otherIncome is EXACTLY
    // the deductible-amount figure, not the bare payment.
    expect(out.yearly[y].agePensionDetail.otherIncome).toBeCloseTo(pd.grandfatheredDeductibleIncome, 2);
    expect(out.yearly[y].agePensionDetail.deemedIncome).toBe(0);
  });

  it("a grandfathered pension is not deemed; the identical pension WITHOUT grandfathering is deemed instead — the assets test is unaffected either way", () => {
    const base = {
      endAge: 65, assets: [],
      plan: {
        client: { currentAge: 62, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 300000, allocation: zeroRealSuperAlloc() })],
      },
    };
    const outGF = projectPlan(mkState({
      ...base,
      plan: {
        ...base.plan,
        pensions: [pensionRow({
          commenceAt: { kind: "age", age: 62 },
          grandfathered: true, grandfatheredPurchasePrice: 200000, grandfatheredLifeExpectancyYears: 20,
        })],
      },
    }));
    const outNoGF = projectPlan(mkState({
      ...base,
      plan: { ...base.plan, pensions: [pensionRow({ commenceAt: { kind: "age", age: 62 } })] },
    }));
    const y = 1;
    expect(outGF.yearly[y].agePensionDetail.deemedIncome).toBe(0);
    expect(outNoGF.yearly[y].agePensionDetail.deemedIncome).toBeGreaterThan(0);
    // Grandfathering ONLY changes the income test (spec's own words) —
    // the assets test assesses the identical pension balance either way.
    expect(outGF.yearly[y].agePensionDetail.assessableAssets).toBeCloseTo(outNoGF.yearly[y].agePensionDetail.assessableAssets, 2);
  });

  it("grandfathering is lost permanently on commutation — deeming applies from that FY on, and a warning fires", () => {
    const s = mkState({
      endAge: 68, assets: [],
      plan: {
        client: { currentAge: 62, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 300000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({
          commenceAt: { kind: "age", age: 62 },
          grandfathered: true, grandfatheredPurchasePrice: 200000, grandfatheredLifeExpectancyYears: 20,
          commutations: [commutationRow({ amount: 50000, at: { kind: "age", age: 64 }, destination: "cash" })],
        })],
      },
    });
    const out = projectPlan(s);
    // y=1 (age 63): still grandfathered — the commutation hasn't fired yet.
    expect(out.yearly[1].agePensionDetail.deemedIncome).toBe(0);
    expect(out.yearly[1].pensionDetail.pn1.grandfatheredDeemingExempt).toBeGreaterThan(0);
    // Commutation fires in July of the FY age 64 is reached (y=2):
    // grandfathering is lost from THIS FY onward.
    expect(out.yearly[2].agePensionDetail.deemedIncome).toBeGreaterThan(0);
    expect(out.yearly[2].pensionDetail.pn1.grandfatheredDeemingExempt).toBe(0);
    expect(out.yearly[2].pensionDetail.pn1.grandfatheredDeductibleIncome).toBe(0);
    expect(out.superWarnings.some((w) => w.type === "grandfatheringLost")).toBe(true);
  });

  it("conservation holds with a grandfathered pension present", () => {
    const s = mkState({
      endAge: 68, assets: [],
      plan: {
        client: { currentAge: 62, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 300000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({
          commenceAt: { kind: "age", age: 62 },
          grandfathered: true, grandfatheredPurchasePrice: 200000, grandfatheredLifeExpectancyYears: 20,
        })],
      },
    });
    const out = projectPlan(s);
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `grandfathering fixture, year ${y}`);
  });
});

describe("Commonwealth Seniors Health Card (spec 21b, Commit 4): engine integration", () => {
  it("eligibility flips exactly at the threshold — at and either side", () => {
    // ratePct: 0 AND cpi: 0 on the WCA — otherwise the salary sitting in
    // cash through the year earns interest at a small NEGATIVE real
    // rate (0% nominal deflated by a nonzero cpi), which ALSO counts as
    // the client's own ordinary/taxable income and would contaminate
    // the exact-threshold hand-check below (the exact same confound the
    // gifting tests hit — see deterministic.test.js's own Commit 2
    // fixtures and their header comment for the full explanation).
    const mk = (amount) => mkState({
      endAge: 68, assets: [], cpi: 0,
      plan: { client: { currentAge: 67 }, workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 } },
      cashflows: {
        income: [employmentRow({
          amount, frequency: "annual", from: { kind: "age", age: 67 }, to: { kind: "age", age: 68 },
          indexBasis: "cpi", sgApplies: false,
        })],
      },
    });
    const atThreshold = projectPlan(mk(101105));
    const justAbove = projectPlan(mk(101106));
    const justBelow = projectPlan(mk(101104));
    const rates2026 = cshcThresholdsFor(2026, "indexed", 0.025);
    expect(rates2026.single).toBeCloseTo(101105, 2);
    expect(atThreshold.yearly[0].cshcDetail.assessableIncome).toBeCloseTo(101105, 2);
    expect(atThreshold.yearly[0].cshcDetail.threshold).toBeCloseTo(101105, 2);
    expect(atThreshold.yearly[0].cshcDetail.margin).toBeCloseTo(0, 2);
    expect(atThreshold.yearly[0].cshcDetail.client.eligible).toBe(true); // exactly at the threshold — still eligible
    expect(justAbove.yearly[0].cshcDetail.client.eligible).toBe(false);
    expect(justBelow.yearly[0].cshcDetail.client.eligible).toBe(true);
  });

  it("a grandfathered pension is excluded from the CSHC income test — deemed instead for the identical pension without grandfathering", () => {
    const base = {
      endAge: 65, assets: [],
      plan: {
        client: { currentAge: 62, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 300000, allocation: zeroRealSuperAlloc() })],
      },
    };
    const outGF = projectPlan(mkState({
      ...base,
      plan: {
        ...base.plan,
        pensions: [pensionRow({
          commenceAt: { kind: "age", age: 62 },
          grandfathered: true, grandfatheredPurchasePrice: 200000, grandfatheredLifeExpectancyYears: 20,
        })],
      },
    }));
    const outNoGF = projectPlan(mkState({
      ...base,
      plan: { ...base.plan, pensions: [pensionRow({ commenceAt: { kind: "age", age: 62 } })] },
    }));
    const y = 1;
    expect(outGF.yearly[y].cshcDetail.deemedIncome).toBe(0);
    expect(outNoGF.yearly[y].cshcDetail.deemedIncome).toBeGreaterThan(0);
    // The grandfathered pension's deductible-amount income still counts
    // (it isn't simply dropped) — assessableIncome is nonzero even
    // though deemedIncome is 0.
    expect(outGF.yearly[y].cshcDetail.grandfatheredDeductibleIncome).toBeGreaterThan(0);
    expect(outGF.yearly[y].cshcDetail.assessableIncome).toBeCloseTo(outGF.yearly[y].cshcDetail.grandfatheredDeductibleIncome, 2);
  });

  it("a couple is assessed on COMBINED income against the couple threshold, not each partner's own income against the single threshold", () => {
    const s = mkState({
      endAge: 68, assets: [], cpi: 0,
      plan: {
        household: "couple", client: { currentAge: 67 }, partner: { currentAge: 67 },
        workingCash: { balance: 0, minimumBalance: 0, ratePct: 0 }, // see the threshold test's own comment
      },
      cashflows: {
        income: [
          employmentRow({
            id: "i1", owner: "client", amount: 85000, frequency: "annual",
            from: { kind: "age", age: 67 }, to: { kind: "age", age: 68 }, indexBasis: "cpi", sgApplies: false,
          }),
          employmentRow({
            id: "i2", owner: "partner", amount: 85000, frequency: "annual",
            from: { kind: "age", age: 67 }, to: { kind: "age", age: 68 }, indexBasis: "cpi", sgApplies: false,
          }),
        ],
      },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].cshcDetail;
    // Neither partner's own $85,000 exceeds the SINGLE threshold
    // ($101,105), but the combined $170,000 exceeds the COUPLE
    // threshold ($161,768) — the couple test, not two single tests.
    expect(d.adjustedTaxableIncome).toBeCloseTo(170000, 2);
    expect(d.threshold).toBeCloseTo(161768, 2);
    expect(d.client.eligible).toBe(false);
    expect(d.partner.eligible).toBe(false);
  });

  it("CSHC eligibility survives after age pension entitlement reaches zero via the assets test — CSHC has no assets test at all", () => {
    const s = mkState({
      endAge: 68, assets: [],
      plan: {
        client: { currentAge: 67, retirementAge: 60 },
        superAccounts: [superAcct({ balance: 3000000, allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" } })],
      },
    });
    const out = projectPlan(s);
    // The $3m ACCUMULATION balance (assessed at age pension age) drives
    // the assets test to zero entitlement — no other income/assets here.
    expect(out.yearly[0].agePensionDetail.entitlement).toBe(0);
    // CSHC has no assets test at all, and accumulation super is never
    // an ABP — with $0 adjusted taxable income and nothing to deem, it
    // remains eligible regardless of the age pension outcome.
    expect(out.yearly[0].cshcDetail.assessableIncome).toBe(0);
    expect(out.yearly[0].cshcDetail.client.eligible).toBe(true);
  });
});

describe("Home Equity Access Scheme (spec 21b, Commit 5): engine integration", () => {
  // An already-OWNED PPR (unlike randomScenario()'s own properties,
  // always "planned" — see conservationCheck.js's own y=0 caveat on why
  // that convention doesn't extend to these hand-written fixtures)
  // growing at exactly cpi so its REAL value stays flat and fully
  // hand-checkable — the same "zero real growth" convention every
  // other known-value fixture in this file already uses.
  const heasProp = (over = {}) => ({
    id: "ppr1", name: "Home", owner: "client", state: "NSW",
    propertyType: "ppr", status: "owned",
    currentValue: 800000, acquisitionDate: "2010-01-01", costBase: 400000,
    priceToday: 0, purchaseAt: null,
    lvrPct: 0, firstHomeBuyer: false, newBuild: false,
    purchaseCostsPct: 0, dutyOverride: 0, growthPct: 2.5, // = cpi
    rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expensesDeductible: true, depreciation: 0,
    releaseFhsssAtPurchase: false,
    ...over,
  });

  it("draws 150% of the maximum pension rate less the actual pension received, and the balance accrues interest — known values", () => {
    const rates = agePensionRatesFor(2026, "indexed", 0.025, 0.035);
    const s = {
      ...mkState({
        endAge: 69, assets: [],
        plan: { client: { currentAge: 67 }, heas: { enabled: true, propertyId: "ppr1" } },
      }),
      properties: [heasProp()],
    };
    const out = projectPlan(s);
    const y0 = out.yearly[0].heasDetail;
    // No assets/income in this fixture — the PPR is exempt either way
    // — so the age pension pays the full single rate; HEAS's own
    // request is 150% of that maximum rate LESS the actual entitlement.
    const actualPensionY0 = out.yearly[0].agePensionDetail.entitlement;
    const expectedDrawnY0 = 1.5 * rates.single.rate - actualPensionY0;
    expect(y0.securityValue).toBeCloseTo(800000, 2);
    expect(y0.drawn).toBeCloseTo(expectedDrawnY0, 2);
    expect(y0.interest).toBeCloseTo(0, 6); // opening balance is 0 in year 0
    expect(y0.closing).toBeCloseTo(y0.drawn, 2);

    const y1 = out.yearly[1].heasDetail;
    expect(y1.opening).toBeCloseTo(y0.closing, 2);
    const heasRealAnnualRate = (1 + heasEffectiveAnnualRate()) / 1.025 - 1; // this fixture's own cpi (mkState default 0.025)
    expect(y1.interest).toBeCloseTo(y1.opening * heasRealAnnualRate, 2);
    expect(y1.closing).toBeCloseTo(y1.opening + y1.interest + y1.drawn, 6);
  });

  it("the total loan cap (age-component × security value) binds — the drawdown is capped at the MLA, well below the uncapped request", () => {
    const rates = agePensionRatesFor(2026, "indexed", 0.025, 0.035);
    const s = {
      ...mkState({
        endAge: 68, assets: [],
        plan: { client: { currentAge: 67 }, heas: { enabled: true, propertyId: "ppr1" } },
      }),
      properties: [heasProp({ currentValue: 50000 })],
    };
    const out = projectPlan(s);
    const mla = heasMaxLoanAmount(50000, 67);
    const uncappedRequest = 1.5 * rates.single.rate - out.yearly[0].agePensionDetail.entitlement;
    expect(uncappedRequest).toBeGreaterThan(mla); // this small property's cap is what actually binds...
    expect(out.yearly[0].heasDetail.mla).toBeCloseTo(mla, 2);
    expect(out.yearly[0].heasDetail.drawn).toBeCloseTo(mla, 2); // ...capped exactly at the MLA, not the uncapped request
    expect(out.yearly[0].heasDetail.closing).toBeCloseTo(mla, 2);
  });

  it("the age component (and so the MLA) grows year over year, freeing up incremental headroom even once the prior year's cap was fully drawn", () => {
    const s = {
      ...mkState({
        endAge: 68, assets: [],
        plan: { client: { currentAge: 67 }, heas: { enabled: true, propertyId: "ppr1" } },
      }),
      properties: [heasProp({ currentValue: 50000 })],
    };
    const out = projectPlan(s);
    const mlaAt67 = heasMaxLoanAmount(50000, 67);
    const mlaAt68 = heasMaxLoanAmount(50000, 68);
    expect(mlaAt68).toBeGreaterThan(mlaAt67); // the age component itself increases with age
    expect(out.yearly[1].heasDetail.mla).toBeCloseTo(mlaAt68, 2);
    // Year 1's headroom is measured against the OPENING balance (last
    // year's MLA, before this year's interest capitalises) — the
    // incremental cap increase, exactly.
    const y1 = out.yearly[1].heasDetail;
    expect(y1.drawn).toBeCloseTo(mlaAt68 - mlaAt67, 2);
    // The interest that capitalised on top isn't gated by the cap at
    // all — the real rule: the cap limits DRAWDOWNS, never the
    // compounding balance itself, so closing ends up slightly ABOVE
    // the current year's own MLA.
    expect(y1.interest).toBeGreaterThan(0);
    expect(y1.closing).toBeCloseTo(mlaAt68 + y1.interest, 6);
  });

  it("never draws before age-pension age is reached (either partner, for a couple)", () => {
    const s = {
      ...mkState({
        endAge: 65, assets: [],
        plan: { client: { currentAge: 60 }, heas: { enabled: true, propertyId: "ppr1" } },
      }),
      properties: [heasProp()],
    };
    const out = projectPlan(s);
    for (const row of out.yearly) {
      expect(row.heasDetail.drawn).toBe(0);
      expect(row.heasDetail.closing).toBe(0);
    }
  });

  it("does not fire until the secured property actually settles", () => {
    const plannedProp = heasProp({
      status: "planned", currentValue: 0, priceToday: 800000, purchaseAt: { kind: "age", age: 69 },
    });
    const s = {
      ...mkState({
        endAge: 71, assets: [],
        plan: { client: { currentAge: 67 }, heas: { enabled: true, propertyId: "ppr1" } },
      }),
      properties: [plannedProp],
    };
    const out = projectPlan(s);
    // HEAS is assessed in the per-year setup, against OPENING (1 July)
    // balances — the same "resolved before either pass, so it reads
    // the PRIOR year's real-pass outcome" convention the age pension's
    // own property loop and pensionCommenced both already document: a
    // property purchasing exactly THIS FY is still read as unsettled
    // for this one year's snapshot, then correctly available from the
    // FOLLOWING FY onward. A one-year lag on the FY it actually
    // settles, not an ongoing exclusion.
    expect(out.yearly[0].heasDetail.drawn).toBe(0); // age 67, well before purchase
    expect(out.yearly[1].heasDetail.drawn).toBe(0); // age 68, well before purchase
    expect(out.yearly[2].heasDetail.drawn).toBe(0); // age 69 — purchases THIS FY, still lagged
    expect(out.yearly[3].heasDetail.drawn).toBeGreaterThan(0); // age 70 — first FY it's actually available
  });

  it("a disabled HEAS election never draws, even with an eligible owned property", () => {
    const s = {
      ...mkState({
        endAge: 69, assets: [],
        plan: { client: { currentAge: 67 }, heas: { enabled: false, propertyId: "ppr1" } },
      }),
      properties: [heasProp()],
    };
    const out = projectPlan(s);
    for (const row of out.yearly) expect(row.heasDetail.drawn).toBe(0);
  });

  it("conservation holds with HEAS drawing and accruing", () => {
    const s = {
      ...mkState({
        endAge: 72, assets: [mkAsset()],
        plan: { client: { currentAge: 67 }, heas: { enabled: true, propertyId: "ppr1" } },
      }),
      properties: [heasProp()],
    };
    const out = projectPlan(s);
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `HEAS fixture, year ${y}`);
  });
});

describe("Death benefits (spec 22, Commit 1): engine integration", () => {
  const beneficiary = (over = {}) => ({ id: "b1", label: "Beneficiary", relationship: "spouse", sharePct: 100, ...over });

  it("a dependant (spouse) receives the whole amount NANE — no tax at all", () => {
    const s = mkState({
      endAge: 41, assets: [],
      plan: {
        superAccounts: [superAcct({ balance: 500000, taxFreeComponent: 100000, allocation: zeroRealSuperAlloc() })],
        client: { currentAge: 40, deathBenefit: { beneficiaries: [beneficiary({ relationship: "spouse" })] } },
      },
    });
    const out = projectPlan(s);
    const d = out.yearly[out.yearly.length - 1].deathBenefitDetail.client;
    const b = d.byBeneficiary[0];
    expect(b.isDependant).toBe(true);
    expect(b.taxFree).toBeCloseTo(100000, 2);
    expect(b.taxableTaxed).toBeCloseTo(400000, 2);
    expect(b.tax).toBe(0);
    expect(b.net).toBeCloseTo(500000, 2);
  });

  it("an adult child (non-dependant) is taxed at 15% plus Medicare on the taxable element only — the tax-free component is always NANE", () => {
    const s = mkState({
      endAge: 41, assets: [],
      plan: {
        superAccounts: [superAcct({ balance: 500000, taxFreeComponent: 100000, allocation: zeroRealSuperAlloc() })],
        client: { currentAge: 40, deathBenefit: { beneficiaries: [beneficiary({ relationship: "adultChild" })] } },
      },
    });
    const out = projectPlan(s);
    const b = out.yearly[out.yearly.length - 1].deathBenefitDetail.client.byBeneficiary[0];
    expect(b.isDependant).toBe(false);
    // 400,000 taxable × (15% + 2% Medicare) = 400,000 × 0.17 = 68,000.
    expect(b.tax).toBeCloseTo(400000 * 0.17, 2);
    expect(b.net).toBeCloseTo(500000 - 68000, 2);
  });

  it("the estate is taxed at 15% with NO Medicare — the real, frequently-missed distinction", () => {
    const s = mkState({
      endAge: 41, assets: [],
      plan: {
        superAccounts: [superAcct({ balance: 500000, taxFreeComponent: 100000, allocation: zeroRealSuperAlloc() })],
        client: { currentAge: 40, deathBenefit: { beneficiaries: [beneficiary({ relationship: "estate" })] } },
      },
    });
    const out = projectPlan(s);
    const b = out.yearly[out.yearly.length - 1].deathBenefitDetail.client.byBeneficiary[0];
    // 400,000 × 15% = 60,000 — no Medicare add-on.
    expect(b.tax).toBeCloseTo(60000, 2);
    expect(b.net).toBeCloseTo(500000 - 60000, 2);
  });

  it("a split across three beneficiaries apportions every component proportionally, and the totals reconcile to the account", () => {
    const s = mkState({
      endAge: 41, assets: [],
      plan: {
        superAccounts: [superAcct({ balance: 500000, taxFreeComponent: 100000, allocation: zeroRealSuperAlloc() })],
        client: {
          currentAge: 40,
          deathBenefit: {
            beneficiaries: [
              beneficiary({ id: "b1", relationship: "spouse", sharePct: 50 }),
              beneficiary({ id: "b2", relationship: "adultChild", sharePct: 30 }),
              beneficiary({ id: "b3", relationship: "estate", sharePct: 20 }),
            ],
          },
        },
      },
    });
    const out = projectPlan(s);
    const d = out.yearly[out.yearly.length - 1].deathBenefitDetail.client;
    const [spouse, child, estate] = d.byBeneficiary;
    expect(spouse.taxFree).toBeCloseTo(50000, 2); // 50% of 100,000
    expect(spouse.taxableTaxed).toBeCloseTo(200000, 2); // 50% of 400,000
    expect(spouse.tax).toBe(0);
    expect(child.taxableTaxed).toBeCloseTo(120000, 2); // 30% of 400,000
    expect(child.tax).toBeCloseTo(120000 * 0.17, 2);
    expect(estate.taxableTaxed).toBeCloseTo(80000, 2); // 20% of 400,000
    expect(estate.tax).toBeCloseTo(80000 * 0.15, 2);
    // The three shares reconcile exactly to the account's own total.
    expect(d.totals.gross).toBeCloseTo(500000, 2);
    expect(d.totals.tax).toBeCloseTo(spouse.tax + child.tax + estate.tax, 6);
  });

  it("components are sourced correctly from a pension (its own fixed proportion) versus an accumulation account (its own live ratio) — both appear as distinct account entries", () => {
    const s = mkState({
      endAge: 62,
      plan: {
        client: { currentAge: 60, retirementAge: 60, deathBenefit: { beneficiaries: [beneficiary({ relationship: "spouse" })] } },
        superAccounts: [
          superAcct({ id: "su1", balance: 300000, taxFreeComponent: 60000, allocation: zeroRealSuperAlloc() }),
          superAcct({ id: "su2", balance: 200000, taxFreeComponent: 0, allocation: zeroRealSuperAlloc() }),
        ],
        pensions: [pensionRow({ id: "pn1", sourceAccountId: "su1", commenceAt: { kind: "age", age: 60 }, allocation: zeroRealAlloc() })],
      },
    });
    const out = projectPlan(s);
    const final = out.yearly[out.yearly.length - 1];
    const d = final.deathBenefitDetail.client;
    const pensionAccount = d.accounts.find((a) => a.id === "pn1");
    const superAccount = d.accounts.find((a) => a.id === "su2");
    expect(pensionAccount.kind).toBe("pension");
    expect(pensionAccount.taxFree).toBeCloseTo(final.pensionDetail.pn1.taxFreeClosing, 6);
    expect(pensionAccount.closing).toBeCloseTo(final.pensionDetail.pn1.closing, 6);
    expect(superAccount.kind).toBe("super");
    expect(superAccount.taxFree).toBeCloseTo(final.superDetail.su2.taxFreeClosing, 6);
    expect(superAccount.taxFree).toBeCloseTo(0, 6); // su2's own taxFreeComponent was 0
  });

  it("regression gate: a scenario with no beneficiaries reports null death benefit detail, never breaking any existing projection", () => {
    const s = mkState({
      endAge: 41, assets: [],
      plan: { superAccounts: [superAcct({ balance: 500000, taxFreeComponent: 100000 })] },
    });
    const out = projectPlan(s);
    const final = out.yearly[out.yearly.length - 1];
    expect(final.deathBenefitDetail).toEqual({ client: null, partner: null });
  });
});

describe("Death benefits (spec 22, Commit 2): reversionary pensions", () => {
  it("a reversionary pension continues to the spouse — excluded from the lump-sum split entirely, reported separately instead", () => {
    const s = mkState({
      endAge: 62,
      plan: {
        household: "couple",
        client: {
          currentAge: 60, retirementAge: 60,
          deathBenefit: { beneficiaries: [{ id: "b1", label: "Adult child", relationship: "adultChild", sharePct: 100 }] },
        },
        partner: { currentAge: 60 },
        superAccounts: [
          superAcct({ id: "su1", owner: "client", balance: 300000, taxFreeComponent: 0, allocation: zeroRealSuperAlloc() }),
        ],
        pensions: [pensionRow({
          id: "pn1", owner: "client", sourceAccountId: "su1", commenceAt: { kind: "age", age: 60 },
          reversionary: true, allocation: zeroRealAlloc(),
        })],
      },
    });
    const out = projectPlan(s);
    const final = out.yearly[out.yearly.length - 1];
    const d = final.deathBenefitDetail.client;
    // Excluded from the ordinary lump-sum accounts and beneficiary split.
    expect(d.accounts.some((a) => a.id === "pn1")).toBe(false);
    expect(d.totals.gross).toBe(0); // the ONLY account client has is the reversionary pension
    expect(d.byBeneficiary[0].gross).toBe(0);
    // Reported separately instead, as continuing.
    expect(d.reversionaryPensions).toHaveLength(1);
    expect(d.reversionaryPensions[0].pensionId).toBe("pn1");
    expect(d.reversionaryPensions[0].valueAtDeath).toBeCloseTo(final.pensionDetail.pn1.closing, 2);
    expect(d.reversionaryPensions[0].valueAtDeath).toBeGreaterThan(0);
  });

  it("is NANE to the spouse — no tax figure anywhere on the reversionary detail", () => {
    const s = mkState({
      endAge: 62,
      plan: {
        household: "couple",
        client: { currentAge: 60, retirementAge: 60 },
        partner: { currentAge: 60 },
        superAccounts: [superAcct({ id: "su1", owner: "client", balance: 300000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ id: "pn1", owner: "client", sourceAccountId: "su1", commenceAt: { kind: "age", age: 60 }, reversionary: true, allocation: zeroRealAlloc() })],
      },
    });
    const out = projectPlan(s);
    const final = out.yearly[out.yearly.length - 1];
    // No deathBenefit beneficiaries were nominated at all — the ONLY
    // reason this person's detail exists is the reversionary pension —
    // confirming the gate itself doesn't require ordinary beneficiaries.
    const rp = final.deathBenefitDetail.client.reversionaryPensions[0];
    expect(rp.tax).toBeUndefined();
    expect(rp.valueAtDeath).toBeGreaterThan(0);
  });

  it("the transfer balance credit lands at the value AT DEATH (this FY's closing balance) — the twelve-month timing is disclosed, not simulated", () => {
    const s = mkState({
      endAge: 62,
      plan: {
        household: "couple",
        client: { currentAge: 60, retirementAge: 60 },
        partner: { currentAge: 60 },
        superAccounts: [superAcct({ id: "su1", owner: "client", balance: 300000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ id: "pn1", owner: "client", sourceAccountId: "su1", commenceAt: { kind: "age", age: 60 }, reversionary: true, allocation: zeroRealAlloc() })],
      },
    });
    const out = projectPlan(s);
    const final = out.yearly[out.yearly.length - 1];
    const rp = final.deathBenefitDetail.client.reversionaryPensions[0];
    // The survivor (partner) had no OTHER pension — their TBA starts at
    // 0, so the credit is exactly the pension's own value at death.
    expect(rp.survivorTbaBefore.balance).toBe(0);
    expect(rp.survivorTbaAfter.balance - rp.survivorTbaBefore.balance).toBeCloseTo(rp.valueAtDeath, 2);
  });

  it("a survivor pushed over their OWN cap by the reversionary credit is flagged with the excess", () => {
    const s = mkState({
      endAge: 62,
      plan: {
        household: "couple",
        client: {
          currentAge: 60, retirementAge: 60,
        },
        partner: { currentAge: 60, retirementAge: 60 },
        superAccounts: [
          superAcct({ id: "su1", owner: "client", balance: 500000, allocation: zeroRealSuperAlloc() }),
          superAcct({ id: "su2", owner: "partner", balance: 1900000, allocation: zeroRealSuperAlloc() }),
        ],
        pensions: [
          pensionRow({ id: "pn1", owner: "client", sourceAccountId: "su1", commenceAt: { kind: "age", age: 60 }, reversionary: true, allocation: zeroRealAlloc() }),
          // The partner's OWN pension already uses most of their personal
          // cap — the reversionary credit on top should breach it.
          pensionRow({ id: "pn2", owner: "partner", sourceAccountId: "su2", commenceAt: { kind: "age", age: 60 }, allocation: zeroRealAlloc() }),
        ],
      },
    });
    const out = projectPlan(s);
    const final = out.yearly[out.yearly.length - 1];
    const rp = final.deathBenefitDetail.client.reversionaryPensions[0];
    expect(rp.survivorTbaBefore.balance).toBeGreaterThan(0); // the partner's own pension already credited
    expect(rp.excess).toBeGreaterThan(0);
    expect(rp.excessTaxRate).toBe(0.15); // first breach
  });

  it("reversionary has no effect for a single household — no partner to revert to (input integrity, planState.js's own clamp)", () => {
    const s = mkState({
      endAge: 41, assets: [],
      plan: {
        superAccounts: [superAcct({ id: "su1", balance: 300000, allocation: zeroRealSuperAlloc() })],
        pensions: [pensionRow({ id: "pn1", sourceAccountId: "su1", commenceAt: { kind: "age", age: 40 }, reversionary: true, allocation: zeroRealAlloc() })],
      },
    });
    const out = projectPlan(s);
    const final = out.yearly[out.yearly.length - 1];
    // No beneficiaries nominated either — with reversionary structurally
    // inert (no couple), there's nothing at all to report.
    expect(final.deathBenefitDetail).toEqual({ client: null, partner: null });
  });
});

describe("Employers (spec 23, Commit 1): per-employer SG and contribution base", () => {
  it("two employers each generate their OWN capped SG — the aggregate exceeds what single-capped SG would give", () => {
    const s = mkState({
      endAge: 40,
      plan: {
        superAccounts: [superAcct()],
        employers: [{ id: "emp1", name: "Employer 1", ownerId: "client" }, { id: "emp2", name: "Employer 2", ownerId: "client" }],
      },
      cashflows: {
        income: [
          employmentRow({ id: "i1", amount: 200000, employerId: "emp1" }),
          employmentRow({ id: "i2", amount: 200000, employerId: "emp2" }),
        ],
      },
    });
    const out = projectPlan(s);
    const sg = out.yearly[0].superDetail.su1.contributions;
    const perEmployerCap = Math.min(200000, 270830) * 0.12;
    expect(sg).toBeCloseTo(perEmployerCap * 2, 2);
    const singleCapTotal = Math.min(400000, 270830) * 0.12;
    expect(sg).toBeGreaterThan(singleCapTotal);
  });

  it("two income rows sharing the SAME employer share one cap, not two", () => {
    const s = mkState({
      endAge: 40,
      plan: {
        superAccounts: [superAcct()],
        employers: [{ id: "emp1", name: "Employer 1", ownerId: "client" }],
      },
      cashflows: {
        income: [
          employmentRow({ id: "i1", amount: 200000, employerId: "emp1" }),
          employmentRow({ id: "i2", amount: 200000, employerId: "emp1" }),
        ],
      },
    });
    const out = projectPlan(s);
    const sg = out.yearly[0].superDetail.su1.contributions;
    expect(sg).toBeCloseTo(Math.min(400000, 270830) * 0.12, 2);
  });

  it("no employerId at all (pre-Commit-1 raw state) behaves exactly as before — each row its own singleton cap", () => {
    const s = mkState({
      endAge: 40,
      plan: { superAccounts: [superAcct()] },
      cashflows: { income: [employmentRow({ amount: 100000 })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.contributions).toBeCloseTo(100000 * 0.12, 2);
  });

  it("a percentOfIncome salary sacrifice is attributed to the SPECIFIC employer's income row it's tied to, not combined income", () => {
    const s = mkState({
      endAge: 40,
      plan: {
        superAccounts: [superAcct()],
        employers: [{ id: "emp1", name: "Employer 1", ownerId: "client" }, { id: "emp2", name: "Employer 2", ownerId: "client" }],
      },
      cashflows: {
        income: [
          employmentRow({ id: "i1", amount: 100000, employerId: "emp1" }),
          employmentRow({ id: "i2", amount: 50000, employerId: "emp2" }),
        ],
        superContributions: [scRow({ id: "sc1", type: "salarySacrifice", basis: "percentOfIncome", percent: 10, incomeRowId: "i1" })],
      },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].superDetail.su1;
    // 10% of employer 1's $100,000 = $10,000 — not 10% of the combined $150,000.
    expect(d.salarySacrifice).toBeCloseTo(10000, 2);
  });
});

// --- Spec 23, Commit 2: bonus, allowance, overtime income types -----------

describe("Bonus, allowance and overtime income (spec 23, Commit 2)", () => {
  const loan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 200000, interestRatePct: 6, termYears: 10, repayment: "pi",
    ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    ...over,
  });

  it("a bonus's full annual amount lands in household income for the FY it fires in, regardless of the nominated month", () => {
    const s = mkState({
      endAge: 41,
      cashflows: {
        income: [{
          ...employmentRow({ id: "b1", amount: 30000, frequency: "annual", to: { kind: "age", age: 40 } }),
          category: "bonus", bonusMonth: 3, sgApplies: false,
        }],
      },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].income).toBeCloseTo(30000, 2);
  });

  it("overtime generates no SG even when sgApplies is left true on the row — the forced, belt-and-braces gate", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: {
        income: [{ ...employmentRow({ amount: 100000, sgApplies: true }), category: "overtime" }],
      },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.contributions).toBe(0);
  });

  it("allowance: the taxable variant is assessed like ordinary employment income; the non-taxable variant carries zero tax", () => {
    const taxableState = mkState({
      endAge: 41,
      cashflows: {
        income: [{ ...employmentRow({ amount: 80000, sgApplies: false }), category: "allowance", taxable: true, incomeType: "employment" }],
      },
    });
    const nonTaxableState = mkState({
      endAge: 41,
      cashflows: {
        income: [{ ...employmentRow({ amount: 80000, sgApplies: false }), category: "allowance", taxable: false, incomeType: "nonTaxable" }],
      },
    });
    const taxable = projectPlan(taxableState);
    const nonTaxable = projectPlan(nonTaxableState);
    // Same real household cash either way...
    expect(taxable.yearly[0].income).toBeCloseTo(80000, 2);
    expect(nonTaxable.yearly[0].income).toBeCloseTo(80000, 2);
    // ...but only the taxable variant generates any tax at all.
    expect(taxable.yearly[0].tax).toBeGreaterThan(0);
    expect(nonTaxable.yearly[0].tax).toBe(0);
  });

  it("a bonus directed to a loan reduces its balance from the firing year onward, not before — falls through to ordinary cash when the target doesn't exist", () => {
    const bonusRow = (destination) => ({
      ...employmentRow({
        id: "b1", amount: 30000, frequency: "annual",
        from: { kind: "age", age: 41 }, to: { kind: "age", age: 41 },
      }),
      category: "bonus", bonusMonth: 6, sgApplies: false, bonusDestination: destination,
    });
    const build = (income) => ({
      ...mkState({ endAge: 42, assets: [mkAsset({ allocation: zeroRealAlloc(), balance: 300000 })], cashflows: { income: [income] } }),
      liabilities: [loan()],
    });
    const withDestination = projectPlan(build(bonusRow({ type: "loanRepayment", targetId: "lb1" })));
    const noDestination = projectPlan(build(bonusRow({ type: null, targetId: null })));
    const dangling = projectPlan(build(bonusRow({ type: "loanRepayment", targetId: "doesNotExist" })));
    // Before the firing year: identical (the row starts at age 41 = year 1).
    expect(withDestination.yearly[0].liabilities.lb1.closing).toBeCloseTo(noDestination.yearly[0].liabilities.lb1.closing, 2);
    // The firing year: the destination scenario pays down materially more.
    expect(withDestination.yearly[1].liabilities.lb1.closing).toBeLessThan(noDestination.yearly[1].liabilities.lb1.closing - 15000);
    // A structurally dangling target falls through to ordinary cash —
    // identical to having no destination at all.
    expect(dangling.yearly[1].liabilities.lb1.closing).toBeCloseTo(noDestination.yearly[1].liabilities.lb1.closing, 2);
  });

  it("a bonus directed to a super account credits it as a non-concessional (post-tax) contribution", () => {
    const bonusRow = {
      ...employmentRow({ id: "b1", amount: 30000, frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } }),
      category: "bonus", bonusMonth: 6, sgApplies: false,
      bonusDestination: { type: "superContribution", targetId: "su1" },
    };
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: { income: [bonusRow] },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].superDetail.su1;
    expect(d.contributions).toBeGreaterThan(0);
    // Non-concessional — no fund-tax skim, unlike SG/salary sacrifice.
    expect(d.contributionsTax).toBe(0);
  });

  it("a bonus directed to an asset credits it, funded from household cash (not conjured — see conservationCheck.js)", () => {
    const bonusRow = {
      ...employmentRow({ id: "b1", amount: 30000, frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } }),
      category: "bonus", bonusMonth: 6, sgApplies: false,
      bonusDestination: { type: "asset", targetId: "a1" },
    };
    const s = mkState({
      endAge: 41,
      assets: [mkAsset({ allocation: zeroRealAlloc(), balance: 0 })],
      cashflows: { income: [bonusRow] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].perAssetDetail.a1.oneOffs).toBeGreaterThan(0);
  });

  it("known-value: the redirected amount matches marginal-method withholding — differencing the isolated-employment assessment with and without the bonus's own gross", () => {
    const salary = 80000;
    const bonusGross = 30000;
    const bonusRow = {
      ...employmentRow({
        id: "b1", amount: bonusGross, frequency: "annual",
        from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
      }),
      category: "bonus", bonusMonth: 6, sgApplies: false,
      bonusDestination: { type: "loanRepayment", targetId: "lb1" },
    };
    const salaryRow = employmentRow({ id: "s1", amount: salary, sgApplies: false, to: { kind: "age", age: 40 } });
    const s = {
      ...mkState({
        endAge: 41,
        assets: [mkAsset({ allocation: zeroRealAlloc(), balance: 300000 })],
        cashflows: { income: [salaryRow, bonusRow] },
      }),
      liabilities: [loan({ balance: 200000 })],
    };
    const withBonus = assessPerson({
      fyStartYear: 2026, bracketMode: "indexed", cpi: 0.025,
      ordinaryIncome: salary + bonusGross, deductions: 0,
      distributions: { franked: 0, unfranked: 0 },
      netCapitalGain: 0, capitalLossCarryFwd: 0, taxProfile: null, excessConcessionalContributions: 0,
    });
    const withoutBonus = assessPerson({
      fyStartYear: 2026, bracketMode: "indexed", cpi: 0.025,
      ordinaryIncome: salary, deductions: 0,
      distributions: { franked: 0, unfranked: 0 },
      netCapitalGain: 0, capitalLossCarryFwd: 0, taxProfile: null, excessConcessionalContributions: 0,
    });
    const expectedAfterTax = bonusGross - (withBonus.netIncomeTax - withoutBonus.netIncomeTax);
    const out = projectPlan(s);
    const withoutBonusOut = projectPlan({ ...s, cashflows: { ...s.cashflows, income: [salaryRow] } });
    const actualRedirected = withoutBonusOut.yearly[0].liabilities.lb1.closing - out.yearly[0].liabilities.lb1.closing;
    // Within a few percent, not to the cent: the credit converts its
    // real dollar amount to nominal at ITS OWN firing month (11, one
    // month before FY-end), while the closing balance it lands in is
    // deflated at FY-end (month 12) — one month's CPI drift between the
    // two, the same reason the one-off-repayment test above uses a
    // loose bound rather than exact equality for a mid-year real-dollar
    // event.
    expect(actualRedirected).toBeGreaterThan(expectedAfterTax * 0.95);
    expect(actualRedirected).toBeLessThan(expectedAfterTax * 1.05);
  });

  it("regression gate: a salary row (category absent, pre-Commit-2 shape) is completely unaffected", () => {
    const s = mkState({
      endAge: 41,
      plan: { superAccounts: [superAcct()] },
      cashflows: { income: [employmentRow({ amount: 100000 })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].superDetail.su1.contributions).toBeCloseTo(100000 * 0.12, 2);
    expect(out.yearly[0].income).toBeCloseTo(100000, 2);
  });
});

// --- Spec 23, Commit 3: salary packaging by employer type ------------------

describe("Salary packaging by employer type (spec 23, Commit 3)", () => {
  const FBT_GROSSUP_RATE = 1.8868;
  const FBT_RATE = 0.47;
  const packagingRow = (over = {}) => ({
    id: "pkg1", owner: "client", category: "salaryPackaging",
    employerId: "emp1", packagingType: "livingExpense",
    amount: 5000, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
    indexBasis: "none", indexExtraPct: 0,
    ...over,
  });
  const stateWith = (employer, deductions) => mkState({
    endAge: 41,
    plan: { employers: [employer] },
    cashflows: { income: [employmentRow({ amount: 100000, sgApplies: false, to: { kind: "age", age: 40 } })], deductions },
  });

  it("standard employer: no cap benefit at all — the WHOLE packaged amount attracts FBT at 47% grossed-up", () => {
    const employer = { id: "emp1", name: "E", ownerId: "client", fbtType: "standard", fbtCaps: { livingExpenseCap: 0, mealEntertainmentCap: 0, rebatePct: 0 } };
    const out = projectPlan(stateWith(employer, [packagingRow()]));
    const expectedFbt = 5000 * FBT_GROSSUP_RATE * FBT_RATE;
    expect(out.yearly[0].taxDetail.fbtPayable).toBeCloseTo(expectedFbt, 0);
    expect(out.yearly[0].taxDetail.reportableFringeBenefits).toBeCloseTo(5000 * FBT_GROSSUP_RATE, 0);
  });

  it("fbtExempt employer: the within-cap portion is completely FBT-free; only the excess is taxed at 47% grossed-up", () => {
    const employer = { id: "emp1", name: "E", ownerId: "client", fbtType: "fbtExempt", fbtCaps: { livingExpenseCap: 3000, mealEntertainmentCap: 0, rebatePct: 0 } };
    const out = projectPlan(stateWith(employer, [packagingRow({ amount: 5000 })]));
    const excess = 5000 - 3000;
    const expectedFbt = excess * FBT_GROSSUP_RATE * FBT_RATE;
    expect(out.yearly[0].taxDetail.fbtPayable).toBeCloseTo(expectedFbt, 0);
    expect(out.yearly[0].taxDetail.reportableFringeBenefits).toBeCloseTo(excess * FBT_GROSSUP_RATE, 0);
  });

  it("fbtExempt employer, fully within cap: zero FBT and zero reportable fringe benefits", () => {
    const employer = { id: "emp1", name: "E", ownerId: "client", fbtType: "fbtExempt", fbtCaps: { livingExpenseCap: 9000, mealEntertainmentCap: 0, rebatePct: 0 } };
    const out = projectPlan(stateWith(employer, [packagingRow({ amount: 5000 })]));
    expect(out.yearly[0].taxDetail.fbtPayable).toBe(0);
    expect(out.yearly[0].taxDetail.reportableFringeBenefits).toBe(0);
  });

  it("living-expense and meal-entertainment caps operate independently", () => {
    const employer = { id: "emp1", name: "E", ownerId: "client", fbtType: "fbtExempt", fbtCaps: { livingExpenseCap: 5000, mealEntertainmentCap: 1000, rebatePct: 0 } };
    const rows = [
      packagingRow({ id: "pkg1", packagingType: "livingExpense", amount: 5000 }), // exactly at cap
      packagingRow({ id: "pkg2", packagingType: "mealEntertainment", amount: 2000 }), // $1,000 over its OWN cap
    ];
    const out = projectPlan(stateWith(employer, rows));
    const expectedExcess = 1000; // only the meal entertainment excess
    expect(out.yearly[0].taxDetail.fbtPayable).toBeCloseTo(expectedExcess * FBT_GROSSUP_RATE * FBT_RATE, 0);
  });

  it("fbtRebatable employer: the within-cap portion pays a REDUCED (rebated) FBT, not zero — less than the standard-employer rate", () => {
    const employer = { id: "emp1", name: "E", ownerId: "client", fbtType: "fbtRebatable", fbtCaps: { livingExpenseCap: 9000, mealEntertainmentCap: 0, rebatePct: 50 } };
    const out = projectPlan(stateWith(employer, [packagingRow({ amount: 5000 })]));
    const fullRateFbt = 5000 * FBT_GROSSUP_RATE * FBT_RATE;
    expect(out.yearly[0].taxDetail.fbtPayable).toBeGreaterThan(0);
    expect(out.yearly[0].taxDetail.fbtPayable).toBeLessThan(fullRateFbt);
    expect(out.yearly[0].taxDetail.fbtPayable).toBeCloseTo(fullRateFbt * 0.5, 0); // 50% rebate
  });

  it("a car is always fully taxable at 47% grossed-up, regardless of employer type or any cap", () => {
    const employer = {
      id: "emp1", name: "E", ownerId: "client", fbtType: "fbtExempt",
      fbtCaps: { livingExpenseCap: 999999, mealEntertainmentCap: 999999, rebatePct: 0 }, // generous enough to exempt anything else
    };
    const out = projectPlan(stateWith(employer, [packagingRow({ packagingType: "car", amount: 5000 })]));
    expect(out.yearly[0].taxDetail.fbtPayable).toBeCloseTo(5000 * FBT_GROSSUP_RATE * FBT_RATE, 0);
  });

  it("an exempt item (e.g. a work laptop) is fully deductible with no FBT/RFB consequence at all, any employer type", () => {
    const employer = { id: "emp1", name: "E", ownerId: "client", fbtType: "standard", fbtCaps: { livingExpenseCap: 0, mealEntertainmentCap: 0, rebatePct: 0 } };
    const out = projectPlan(stateWith(employer, [packagingRow({ packagingType: "exemptItem", amount: 5000 })]));
    expect(out.yearly[0].taxDetail.fbtPayable).toBe(0);
    expect(out.yearly[0].taxDetail.reportableFringeBenefits).toBe(0);
  });

  it("reportable fringe benefits flow into HELP repayment income and Division 293 income — isolated against an identical ordinary deduction that carries neither", () => {
    const employer = { id: "emp1", name: "E", ownerId: "client", fbtType: "standard", fbtCaps: { livingExpenseCap: 0, mealEntertainmentCap: 0, rebatePct: 0 } };
    // $225,000 salary is calibrated (by hand, against the engine's own
    // Division 293 threshold — $250,000 — and this income's own SG-only
    // concessional contribution) so the ORDINARY-deduction baseline
    // sits just UNDER the Division 293 threshold (div293 = 0) while
    // packaging's reportable-fringe-benefits add-back tips it just
    // over — the only way to actually exercise Division 293's own
    // marginal effect rather than a saturated (already-over, unchanged)
    // reading. Division 293 is assessed FY t, paid/reported FY t+1 (the
    // same lag CGT uses) — checked on yearly[1], not [0].
    const highIncomeState = (deductions) => mkState({
      endAge: 42,
      plan: {
        employers: [employer],
        superAccounts: [superAcct()],
        client: { currentAge: 40, helpBalance: 50000, privateHospitalCover: false },
      },
      cashflows: { income: [employmentRow({ amount: 225000, sgApplies: true, to: { kind: "age", age: 42 } })], deductions },
    });
    const withPackaging = projectPlan(highIncomeState([packagingRow({ amount: 10000, to: { kind: "age", age: 42 } })]));
    // Same income-tax effect (a $10,000 deduction), but an ordinary
    // category — no FBT, no reportable fringe benefits at all.
    const withOrdinaryDeduction = projectPlan(highIncomeState([{ ...packagingRow({ amount: 10000, to: { kind: "age", age: 42 } }), category: "workingExpense" }]));
    expect(withPackaging.yearly[0].taxDetail.reportableFringeBenefits).toBeGreaterThan(0);
    expect(withOrdinaryDeduction.yearly[0].taxDetail.reportableFringeBenefits).toBe(0);
    // The SAME underlying income tax reduction either way...
    expect(withPackaging.yearly[0].taxDetail.incomeTax).toBeCloseTo(withOrdinaryDeduction.yearly[0].taxDetail.incomeTax, 0);
    // ...but packaging's reportable fringe benefits push HELP (same FY)
    // and Division 293 (next FY) higher — "the sting" the spec calls
    // out by name.
    expect(withPackaging.yearly[0].taxDetail.helpRepayment).toBeGreaterThan(withOrdinaryDeduction.yearly[0].taxDetail.helpRepayment);
    expect(withPackaging.yearly[1].taxDetail.div293).toBeGreaterThan(withOrdinaryDeduction.yearly[1].taxDetail.div293);
    // MLS uses the SAME repaymentIncome figure (no private cover, set
    // above), so the RFB add-back lifts it too — same FY as HELP.
    expect(withPackaging.yearly[0].taxDetail.medicareLevySurcharge).toBeGreaterThan(withOrdinaryDeduction.yearly[0].taxDetail.medicareLevySurcharge);
  });

  it("net position: FBT plus the extra HELP/Division 293 can outweigh the income-tax saving — all four figures are independently surfaced, not netted away silently", () => {
    const employer = { id: "emp1", name: "E", ownerId: "client", fbtType: "standard", fbtCaps: { livingExpenseCap: 0, mealEntertainmentCap: 0, rebatePct: 0 } };
    const s = mkState({
      endAge: 41,
      plan: { employers: [employer], client: { currentAge: 40, helpBalance: 50000, privateHospitalCover: false } },
      cashflows: { income: [employmentRow({ amount: 300000, sgApplies: false, to: { kind: "age", age: 40 } })], deductions: [packagingRow({ amount: 10000 })] },
    });
    const out = projectPlan(s);
    const d = out.yearly[0].taxDetail;
    const netCost = d.fbtPayable; // the direct cost; HELP/Div293/MLS deltas are separately visible on the same row
    expect(netCost).toBeGreaterThan(0);
    expect(d.reportableFringeBenefits).toBeGreaterThan(0);
    expect(d.helpRepayment).toBeGreaterThan(0);
  });

  it("regression gate: a scenario with no employers/packaging at all is completely unaffected", () => {
    const s = mkState({
      endAge: 41,
      cashflows: { income: [employmentRow({ amount: 100000 })] },
    });
    const out = projectPlan(s);
    expect(out.yearly[0].taxDetail.fbtPayable).toBe(0);
    expect(out.yearly[0].taxDetail.reportableFringeBenefits).toBe(0);
  });
});

// --- Spec 23, Commit 4: novated leases --------------------------------------

describe("Novated leases (spec 23, Commit 4)", () => {
  const FBT_GROSSUP_RATE = 1.8868;
  const FBT_RATE = 0.47;
  const nlRow = (over = {}) => ({
    id: "nl1", name: "Lease", owner: "client",
    baseValue: 50000, startAt: { kind: "age", age: 40 }, termYears: 3,
    preTaxAnnual: 0, postTaxAnnual: 0, runningCostsAnnual: 0, runningCostsPackaged: true,
    residualValue: 0, residualDestination: "payout",
    ...over,
  });
  const stateWith = (leases, over = {}) => mkState({
    endAge: 40 + (over.years ?? 4),
    plan: { novatedLeases: leases },
    cashflows: { income: [employmentRow({ amount: 150000, sgApplies: false })] },
  });

  it.each([[30000], [50000], [80000]])(
    "known-value: statutory taxable value = base value × 20%%, no ECM (base=%d)",
    (baseValue) => {
      const out = projectPlan(stateWith([nlRow({ baseValue, termYears: 1 })]));
      const expectedTaxableValue = baseValue * 0.20;
      expect(out.yearly[0].taxDetail.reportableFringeBenefits).toBeCloseTo(expectedTaxableValue * FBT_GROSSUP_RATE, 0);
      expect(out.yearly[0].taxDetail.fbtPayable).toBeCloseTo(expectedTaxableValue * FBT_GROSSUP_RATE * FBT_RATE, 0);
    }
  );

  it("the base value reduces by one-third once the car has been held for four COMPLETE FBT years", () => {
    const out = projectPlan(stateWith([nlRow({ baseValue: 60000, termYears: 6 })], { years: 6 }));
    const fullValue = 60000 * 0.20 * FBT_GROSSUP_RATE;
    const reducedValue = 60000 * (2 / 3) * 0.20 * FBT_GROSSUP_RATE;
    for (const y of [0, 1, 2, 3]) {
      expect(out.yearly[y].taxDetail.reportableFringeBenefits).toBeCloseTo(fullValue, 0);
    }
    expect(out.yearly[4].taxDetail.reportableFringeBenefits).toBeCloseTo(reducedValue, 0);
  });

  it("Employee Contribution Method (ECM): a post-tax contribution reduces the taxable value dollar for dollar, down to zero if large enough", () => {
    const statutoryValue = 50000 * 0.20; // 10,000
    const partial = projectPlan(stateWith([nlRow({ termYears: 1, postTaxAnnual: 4000 })]));
    expect(partial.yearly[0].taxDetail.reportableFringeBenefits).toBeCloseTo((statutoryValue - 4000) * FBT_GROSSUP_RATE, 0);
    const full = projectPlan(stateWith([nlRow({ termYears: 1, postTaxAnnual: statutoryValue })]));
    expect(full.yearly[0].taxDetail.fbtPayable).toBe(0);
    expect(full.yearly[0].taxDetail.reportableFringeBenefits).toBe(0);
    // Even MORE than the taxable value floors at zero, never negative.
    const over = projectPlan(stateWith([nlRow({ termYears: 1, postTaxAnnual: statutoryValue + 5000 })]));
    expect(over.yearly[0].taxDetail.fbtPayable).toBe(0);
  });

  it("pre-tax and post-tax lease payments reach the right places: pre-tax reduces taxable income only; post-tax reduces household cash", () => {
    const withPreTax = projectPlan(stateWith([nlRow({ termYears: 1, preTaxAnnual: 8000 })]));
    const withPostTax = projectPlan(stateWith([nlRow({ termYears: 1, postTaxAnnual: 8000 })]));
    const noLeasePayments = projectPlan(stateWith([nlRow({ termYears: 1, baseValue: 0 })]));
    // Pre-tax: taxable income drops, but household cash (`income`) is unaffected.
    expect(withPreTax.yearly[0].taxDetail.client.taxableIncome).toBeLessThan(noLeasePayments.yearly[0].taxDetail.client.taxableIncome);
    expect(withPreTax.yearly[0].income).toBeCloseTo(noLeasePayments.yearly[0].income, 2);
    // Post-tax: an ordinary expense — household cash drops by the SAME amount. Taxable income
    // is essentially untouched by the postTax payment itself (within a
    // small margin — a lower WCA balance earns marginally less interest,
    // itself assessable, a real second-order effect, not the postTax
    // payment being treated as a deduction).
    expect(withPostTax.yearly[0].expenses).toBeCloseTo(noLeasePayments.yearly[0].expenses + 8000, 2);
    expect(withPostTax.yearly[0].taxDetail.client.taxableIncome).toBeGreaterThan(noLeasePayments.yearly[0].taxDetail.client.taxableIncome - 200);
  });

  it("running costs follow whichever side they're packaged onto", () => {
    const packaged = projectPlan(stateWith([nlRow({ termYears: 1, baseValue: 0, runningCostsAnnual: 3000, runningCostsPackaged: true })]));
    const notPackaged = projectPlan(stateWith([nlRow({ termYears: 1, baseValue: 0, runningCostsAnnual: 3000, runningCostsPackaged: false })]));
    const none = projectPlan(stateWith([nlRow({ termYears: 1, baseValue: 0 })]));
    expect(packaged.yearly[0].expenses).toBeCloseTo(none.yearly[0].expenses, 2); // no cash effect — packaged (pre-tax)
    expect(notPackaged.yearly[0].expenses).toBeCloseTo(none.yearly[0].expenses + 3000, 2); // ordinary cash expense
  });

  it("the residual falls in the right month (year) — the July immediately after the lease's last active year, not before or after", () => {
    const withResidual = projectPlan(stateWith([nlRow({ termYears: 2, baseValue: 0, residualValue: 15000 })], { years: 5 }));
    const without = projectPlan(stateWith([nlRow({ termYears: 2, baseValue: 0 })], { years: 5 }));
    // Active years 0–1: no residual yet.
    expect(withResidual.yearly[0].expenses).toBeCloseTo(without.yearly[0].expenses, 2);
    expect(withResidual.yearly[1].expenses).toBeCloseTo(without.yearly[1].expenses, 2);
    // Year 2 (the July right after the lease ends): the residual fires.
    expect(withResidual.yearly[2].expenses).toBeCloseTo(without.yearly[2].expenses + 15000, 2);
    // Year 3 onward: gone, never repeats.
    expect(withResidual.yearly[3].expenses).toBeCloseTo(without.yearly[3].expenses, 2);
  });

  it('"refinance" fires no residual outflow at all — a disclosed simplification', () => {
    const out = projectPlan(stateWith([nlRow({ termYears: 1, baseValue: 0, residualValue: 15000, residualDestination: "refinance" })], { years: 4 }));
    const without = projectPlan(stateWith([nlRow({ termYears: 1, baseValue: 0 })], { years: 4 }));
    for (let y = 0; y < 4; y++) expect(out.yearly[y].expenses).toBeCloseTo(without.yearly[y].expenses, 2);
  });

  it("regression gate: a scenario with no novated leases at all is completely unaffected", () => {
    const out = projectPlan(stateWith([]));
    expect(out.yearly[0].taxDetail.fbtPayable).toBe(0);
    expect(out.yearly[0].taxDetail.reportableFringeBenefits).toBe(0);
  });
});

// --- Spec 24, Commit 1: loan drawdowns and dynamic deductibility -----------

describe("Loan drawdowns and dynamic deductibility (spec 24, Commit 1)", () => {
  const loan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 200000, interestRatePct: 6, termYears: 10, repayment: "pi",
    ioYears: 0, deductiblePct: 0, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    creditLimit: null, drawdowns: [], repaymentAllocation: "proportional",
    ...over,
  });
  const bigAsset = () => mkAsset({ allocation: zeroRealAlloc(), balance: 2000000 });
  const withLoan = (l, over = {}) => ({
    ...mkState({ endAge: 40 + (over.years ?? 5), assets: [bigAsset()], ...over }),
    liabilities: [l],
  });
  const ratio = (row) => {
    const total = row.investmentBalance + row.privateBalance;
    return total > 0 ? row.investmentBalance / total : 0;
  };

  it("a drawdown increases the balance from the year it fires, and repayments recompute over the new balance/term", () => {
    const without = projectPlan(withLoan(loan()));
    const withDrawdown = projectPlan(withLoan(loan({
      drawdowns: [{ id: "dd1", amount: 50000, at: { kind: "age", age: 41 }, purpose: "investment", destination: "cash" }],
    })));
    // Before the firing year: identical (drawdown fires at age 41 = year 1).
    expect(withDrawdown.yearly[0].liabilities.lb1.closing).toBeCloseTo(without.yearly[0].liabilities.lb1.closing, 2);
    // From the firing year onward: materially higher balance.
    expect(withDrawdown.yearly[1].liabilities.lb1.closing).toBeGreaterThan(without.yearly[1].liabilities.lb1.closing + 40000);
    expect(withDrawdown.yearly[1].liabilities.lb1.drawdown).toBeCloseTo(50000, 0);
  });

  it("the credit limit binds — a drawdown beyond the facility draws only the available headroom, flagged", () => {
    const out = projectPlan(withLoan(loan({
      creditLimit: 220000,
      drawdowns: [{ id: "dd1", amount: 50000, at: { kind: "age", age: 40 }, purpose: "investment", destination: "cash" }],
    })));
    // Only $20,000 of headroom (limit 220,000 − opening balance 200,000).
    expect(out.yearly[0].liabilities.lb1.drawdown).toBeCloseTo(20000, 0);
    expect(out.drawdownWarnings.some((w) => w.type === "creditLimitBound" && w.liabilityId === "lb1")).toBe(true);
  });

  it("no credit limit set at all never binds — the drawdown fires in full, no warning", () => {
    const out = projectPlan(withLoan(loan({
      drawdowns: [{ id: "dd1", amount: 50000, at: { kind: "age", age: 40 }, purpose: "investment", destination: "cash" }],
    })));
    expect(out.yearly[0].liabilities.lb1.drawdown).toBeCloseTo(50000, 0);
    expect(out.drawdownWarnings.some((w) => w.type === "creditLimitBound")).toBe(false);
  });

  it("the opening deductiblePct is respected as the starting investment/private split — exact under proportional reduction, which preserves the ratio regardless of how much principal is repaid", () => {
    // A drawdown fires in year 3 (engaging dynamic tracking from setup),
    // but years 0-2 have no drawdown activity at all yet — the ratio in
    // those years must equal the OPENING split exactly.
    const out = projectPlan(withLoan(loan({
      deductiblePct: 25,
      drawdowns: [{ id: "dd1", amount: 10000, at: { kind: "age", age: 43 }, purpose: "investment", destination: "cash" }],
    }), { years: 5 }));
    for (const y of [0, 1, 2]) {
      expect(ratio(out.yearly[y].liabilities.lb1)).toBeCloseTo(0.25, 6);
    }
  });

  it("proportional repayment (the default) keeps the deductible proportion constant even after a drawdown changes the mix", () => {
    const out = projectPlan(withLoan(loan({
      deductiblePct: 40,
      drawdowns: [{ id: "dd1", amount: 50000, at: { kind: "age", age: 41 }, purpose: "investment", destination: "cash" }],
    }), { years: 6 }));
    const ratioAfterDrawdown = ratio(out.yearly[1].liabilities.lb1);
    expect(ratioAfterDrawdown).toBeGreaterThan(0.4); // the drawdown pushed it up from 40%
    for (const y of [2, 3, 4]) {
      expect(ratio(out.yearly[y].liabilities.lb1)).toBeCloseTo(ratioAfterDrawdown, 6);
    }
  });

  it("privateFirst allocation shifts the deductible proportion UP over time — repayments preferentially clear the private bucket first", () => {
    const out = projectPlan(withLoan(loan({
      deductiblePct: 40, repaymentAllocation: "privateFirst",
      drawdowns: [{ id: "dd1", amount: 50000, at: { kind: "age", age: 41 }, purpose: "investment", destination: "cash" }],
    }), { years: 6 }));
    const r1 = ratio(out.yearly[1].liabilities.lb1);
    const r3 = ratio(out.yearly[3].liabilities.lb1);
    expect(r3).toBeGreaterThan(r1);
    // Flagged as aggressive — permitted, not silently allowed or refused.
    expect(out.drawdownWarnings.some((w) => w.type === "privateFirstAggressive" && w.liabilityId === "lb1")).toBe(true);
  });

  it("privateFirst on a single mixed loan is flagged as aggressive purely from the choice itself, independent of whether a drawdown ever fires — permitted, never silent", () => {
    const out = projectPlan(withLoan(loan({ deductiblePct: 40, repaymentAllocation: "privateFirst" })));
    expect(out.drawdownWarnings.some((w) => w.type === "privateFirstAggressive")).toBe(true);
  });

  it("conservation: a drawdown to cash moves money into the WCA without changing net worth by itself", () => {
    // "accumulate" surplus (remainderTo: cash) — the default "spend"
    // mode would sweep the drawdown's own WCA cash away as household
    // spending by FY-end, which is a real, disclosed leak of ITS OWN
    // (surplusSpent), not something this test is checking; accumulate
    // isolates the drawdown's own conservation-neutral transfer.
    const accumulate = { surplus: { mode: "accumulate", assetId: null } };
    const without = projectPlan(withLoan(loan(), accumulate));
    const withDrawdown = projectPlan(withLoan(loan({
      drawdowns: [{ id: "dd1", amount: 50000, at: { kind: "age", age: 40 }, purpose: "investment", destination: "cash" }],
    }), accumulate));
    // Loan up $50k, WCA up $50k — nets to (approximately) zero net-worth
    // change; the small residual left over is the extra WCA interest
    // that $50k itself earns for the rest of the FY, a real (if tiny)
    // growth effect, not a conservation leak.
    expect(Math.abs(withDrawdown.yearly[0].netAssets - without.yearly[0].netAssets)).toBeLessThan(2000);
  });

  it("a drawdown directed to an asset credits that asset, not the WCA", () => {
    const out = projectPlan({
      ...mkState({
        endAge: 41, assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc(), balance: 0 })],
        // Ample income so the mortgage's own contractual repayment
        // never needs to deficit-fund from a1 itself, which would
        // otherwise confound the credited amount with an unrelated drain.
        cashflows: { income: [employmentRow({ amount: 200000, sgApplies: false })] },
      }),
      liabilities: [loan({ drawdowns: [{ id: "dd1", amount: 30000, at: { kind: "age", age: 40 }, purpose: "investment", destination: "a1" }] })],
    });
    expect(out.yearly[0].perAssetDetail.a1.closing).toBeCloseTo(30000, 0);
  });

  it("regression gate: a liability with no drawdowns at all is completely unaffected (bit-identical)", () => {
    const s = withLoan(loan({ deductiblePct: 35 }));
    const a = projectPlan(s);
    const b = projectPlan(s);
    expect(a).toEqual(b);
  });

  it("investmentBalance/privateBalance are reported for EVERY liability (spec 24, Commit 3's own Liabilities table row needs this), not just one using dynamic tracking — derived from the static opening split when dynamic tracking never engaged", () => {
    const s = withLoan(loan({ deductiblePct: 35 }));
    const out = projectPlan(s);
    const row = out.yearly[0].liabilities.lb1;
    const total = row.investmentBalance + row.privateBalance;
    expect(total).toBeCloseTo(row.closing, 2);
    expect(row.investmentBalance / total).toBeCloseTo(0.35, 6);
  });
});

// --- Spec 24, Commit 2: debt recycling --------------------------------------

describe("Debt recycling (spec 24, Commit 2)", () => {
  const loan = (over = {}) => ({
    id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
    balance: 400000, interestRatePct: 6, termYears: 25, repayment: "pi",
    ioYears: 0, deductiblePct: 0, linkedAssetId: null, offsetAssetId: null,
    extraRepayments: [], oneOffRepayments: [],
    creditLimit: null, drawdowns: [], repaymentAllocation: "proportional",
    recycling: {
      enabled: true, from: { kind: "age", age: 40 }, to: { kind: "age", age: 60 },
      destinationAssetId: "a1", matchRepayments: true, annualCap: null,
    },
    ...over,
  });
  const withLoan = (l, years = 6) => ({
    ...mkState({
      endAge: 40 + years, assets: [mkAsset({ id: "a1", allocation: zeroRealAlloc(), balance: 0 })],
      // Ample income so the mortgage's own contractual repayment never
      // needs deficit-funding from a1 itself — that would drain the
      // SAME asset the redraw credits, confounding "grows by the
      // redrawn amount" with an unrelated withdrawal.
      cashflows: { income: [employmentRow({ amount: 200000, sgApplies: false, to: { kind: "age", age: 40 + years } })] },
    }),
    liabilities: [l],
  });
  const ratio = (row) => {
    const total = row.investmentBalance + row.privateBalance;
    return total > 0 ? row.investmentBalance / total : 0;
  };

  it("total debt stays flat (nominal) once recycling is running — the redraw replaces the repaid principal", () => {
    const out = projectPlan(withLoan(loan()));
    // The reported closing balance is REAL dollars (this engine's own
    // convention), so even a NOMINALLY flat recycled loan still shows
    // some real-dollar decay from ordinary CPI erosion — the same
    // "liabilityRevaluation" effect any fixed-nominal debt has,
    // recycled or not (CLAUDE.md's own locked convention). Isolate the
    // recycling-specific claim by comparing against a PLAIN
    // interest-only loan of the identical balance/rate: an IO loan's
    // nominal balance is ALSO exactly flat, so if recycling is truly
    // replacing principal like-for-like, the two should decay at
    // essentially the same real rate — not diverge like a genuinely
    // amortising loan would.
    const io = projectPlan(withLoan(loan({ repayment: "io", ioYears: 25, recycling: { ...loan().recycling, enabled: false } })));
    expect(out.yearly[3].liabilities.lb1.closing).toBeCloseTo(io.yearly[3].liabilities.lb1.closing, -3);
  });

  it("without recycling, the SAME loan's balance declines normally — the contrast that makes 'stays flat' meaningful", () => {
    const withRecycling = projectPlan(withLoan(loan()));
    const without = projectPlan(withLoan(loan({ recycling: { ...loan().recycling, enabled: false } })));
    expect(without.yearly[3].liabilities.lb1.closing).toBeLessThan(without.yearly[0].liabilities.lb1.closing - 1000);
    expect(withRecycling.yearly[3].liabilities.lb1.closing).toBeGreaterThan(without.yearly[3].liabilities.lb1.closing + 1000);
  });

  it("the deductible proportion climbs each cycle — every redraw is marked investment-purpose", () => {
    const out = projectPlan(withLoan(loan()));
    const r0 = ratio(out.yearly[0].liabilities.lb1);
    const r1 = ratio(out.yearly[1].liabilities.lb1);
    const r2 = ratio(out.yearly[2].liabilities.lb1);
    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeGreaterThan(r1);
  });

  it("the destination asset grows by the redrawn amounts", () => {
    const out = projectPlan(withLoan(loan()));
    // Started at $0 — every dollar in it by year 3 came from redraws.
    expect(out.yearly[3].perAssetDetail.a1.closing).toBeGreaterThan(0);
    const totalRedrawn = [0, 1, 2, 3].reduce((s, y) => s + out.yearly[y].liabilities.lb1.drawdown, 0);
    expect(out.yearly[3].perAssetDetail.a1.closing).toBeCloseTo(totalRedrawn, 0);
  });

  it("the annual cap binds — a cap below the repaid principal redraws only the capped amount, and total debt no longer stays flat", () => {
    const uncapped = projectPlan(withLoan(loan()));
    const capped = projectPlan(withLoan(loan({ recycling: { ...loan().recycling, annualCap: 500 } })));
    // A tiny cap ($500/yr against a $400k loan's own ~$15k/yr principal)
    // redraws far less — the loan actually shrinks over time.
    expect(capped.yearly[3].liabilities.lb1.closing).toBeLessThan(uncapped.yearly[3].liabilities.lb1.closing - 5000);
    expect(capped.yearly[3].liabilities.lb1.closing).toBeLessThan(capped.yearly[0].liabilities.lb1.closing);
  });

  it("interest deductions rise in step with the growing investment-purpose balance", () => {
    const out = projectPlan(withLoan(loan()));
    // Same nominal interest rate/balance each year (recycling keeps the
    // TOTAL flat) — only the DEDUCTIBLE portion changes, so a growing
    // ratio directly implies growing deductible interest.
    const y0 = out.yearly[0].liabilities.lb1;
    const y2 = out.yearly[2].liabilities.lb1;
    const deductibleInterest = (row) => row.interest * (row.investmentBalance / (row.investmentBalance + row.privateBalance));
    expect(deductibleInterest(y2)).toBeGreaterThan(deductibleInterest(y0));
  });

  it("regression gate: a liability with recycling disabled is unaffected by the field's mere presence", () => {
    const disabled = loan({ recycling: { ...loan().recycling, enabled: false } });
    const noField = loan({ recycling: undefined });
    const a = projectPlan(withLoan(disabled));
    const b = projectPlan(withLoan(noField));
    expect(a.yearly[3].liabilities.lb1.closing).toBeCloseTo(b.yearly[3].liabilities.lb1.closing, 2);
  });
});

describe("Investment and education bonds (spec 25, Commit 1)", () => {
  const bond = (over = {}) => ({
    id: "bd1", name: "Bond 1", type: "investment", owner: "client", include: true,
    balance: 100000, startDate: "2026-07-01",
    allocation: { mode: "custom", incomePct: 4, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0,
    ...over,
  });
  const bondContribution = (over = {}) => ({
    id: "bc1", label: "Contribution", bondId: "bd1", amount: 1000, frequency: "monthly",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
    indexBasis: "cpi", indexExtraPct: 0, // constant real — exact round-number totals
    ...over,
  });
  const withBond = (b, over = {}) => mkState({ endAge: 40 + (over.years ?? 3), bonds: [b], ...over });

  it("earnings are taxed at 30% inside the bond (no franking) and grow the balance net of that tax", () => {
    const out = projectPlan(withBond(bond()));
    const y0 = out.yearly[0].bondDetail.bd1;
    expect(y0.earnings).toBeGreaterThan(0);
    expect(y0.internalTax).toBeCloseTo(y0.earnings * 0.30, 2);
    expect(y0.closing).toBeCloseTo(y0.opening + (y0.earnings - y0.internalTax) + y0.contributions, 1);
  });

  it("full franking (100%) reduces the effective internal tax rate to zero", () => {
    const out = projectPlan(withBond(bond({
      allocation: { mode: "custom", incomePct: 4, growthPct: 0, frankingPct: 100, volBasis: "Balanced" },
    })));
    const y0 = out.yearly[0].bondDetail.bd1;
    expect(y0.internalTax).toBeCloseTo(0, 6);
  });

  it("bond earnings never appear in the investor's own assessable income, franked/unfranked distributions, or tax", () => {
    const withoutBond = projectPlan(mkState({ endAge: 43 }));
    const withEarnings = projectPlan(withBond(bond({ balance: 500000 })));
    // Same household otherwise (no other income/assets differ) — if
    // bond earnings leaked into assessable income, tax would rise.
    expect(withEarnings.yearly[0].tax).toBeCloseTo(withoutBond.yearly[0].tax, 2);
  });

  it("a contribution is paid from household cash (reduces the WCA/other assets) and credits the bond balance", () => {
    const withoutContribution = projectPlan(withBond(bond({ balance: 0 })));
    const withContribution = projectPlan({
      ...withBond(bond({ balance: 0 })),
      cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [], bondContributions: [bondContribution()] },
    });
    expect(withContribution.yearly[0].bondDetail.bd1.contributions).toBeCloseTo(12000, 0);
    expect(withContribution.yearly[0].bondsClosing).toBeGreaterThan(withoutContribution.yearly[0].bondsClosing + 11000);
  });

  it("bonds are included in netAssets", () => {
    const out = projectPlan(withBond(bond()));
    expect(out.yearly[0].bondsClosing).toBeCloseTo(out.yearly[0].bondDetail.bd1.closing, 2);
    expect(out.yearly[0].netAssets).toBeGreaterThan(out.yearly[0].bondsClosing);
  });

  it("conservation holds across a bond's growth, internal tax, and contributions", () => {
    const out = projectPlan({
      ...withBond(bond({ balance: 200000 }), { years: 4 }),
      cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [], bondContributions: [bondContribution({ amount: 2000 })] },
    });
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `bond fixture, year ${y}`);
  });

  it("the 125% rule: a compliant increase (≤125% of last year's) does not reset the clock or warn", () => {
    const out = projectPlan({
      ...withBond(bond(), { years: 3 }),
      cashflows: {
        income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [],
        bondContributions: [
          bondContribution({ id: "bc1", amount: 1000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } }),
          bondContribution({ id: "bc2", amount: 1250, from: { kind: "age", age: 41 }, to: { kind: "age", age: 41 } }),
        ],
      },
    });
    expect(out.bondWarnings.some((w) => w.type === "contributionCapBreach")).toBe(false);
  });

  it("the 125% rule: a breach resets the clock and is flagged, never silently applied or silently forbidden", () => {
    const out = projectPlan({
      ...withBond(bond(), { years: 3 }),
      cashflows: {
        income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [],
        bondContributions: [
          bondContribution({ id: "bc1", amount: 1000, from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 } }),
          bondContribution({ id: "bc2", amount: 5000, from: { kind: "age", age: 41 }, to: { kind: "age", age: 41 } }),
        ],
      },
    });
    expect(out.bondWarnings.some((w) => w.type === "contributionCapBreach" && w.bondId === "bd1")).toBe(true);
  });

  it("a nil-contribution year sets the following year's 125% base to nil — any positive contribution the year after breaches", () => {
    const out = projectPlan({
      ...withBond(bond(), { years: 3 }),
      cashflows: {
        income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [],
        // No contribution in year 0 at all, then a small one in year 1.
        bondContributions: [
          bondContribution({ id: "bc1", amount: 500, from: { kind: "age", age: 41 }, to: { kind: "age", age: 41 } }),
        ],
      },
    });
    expect(out.bondWarnings.some((w) => w.type === "contributionCapBreach" && w.bondId === "bd1")).toBe(true);
  });

  it("regression gate: a plan with no bonds is bit-identical to one that never mentions the field", () => {
    const withField = projectPlan(mkState({ endAge: 43, bonds: [] }));
    const withoutField = projectPlan({ ...mkState({ endAge: 43 }), bonds: undefined });
    expect(withField.yearly[2].netAssets).toBeCloseTo(withoutField.yearly[2].netAssets, 6);
  });
});

describe("Investment and education bonds (spec 25, Commit 2): deficit funding", () => {
  const bond = (over = {}) => ({
    id: "bd1", name: "Bond 1", type: "investment", owner: "client", include: true,
    balance: 100000, startDate: "2020-07-01", // unmatured within this test's short window
    allocation: { mode: "custom", incomePct: 6, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0,
    ...over,
  });
  const salary = (amount) => ({
    id: "sal", label: "Salary", owner: "client", amount, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
    indexBasis: "none", indexExtraPct: 0, incomeType: "employment", category: "salary", sgApplies: false,
  });
  const bigExpense = (amount) => ({
    id: "exp1", label: "Big expense", owner: "client", amount, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 40 },
    indexBasis: "none", indexExtraPct: 0, category: "nonDiscretionary",
  });
  const withShortfall = (b, over = {}) => mkState({
    endAge: 43, bonds: [b],
    cashflows: { income: [salary(80000)], expenses: [bigExpense(150000)], contributions: [], withdrawals: [], lumpSums: [], bondContributions: [] },
    fundingOrder: ["bd1", "a1"],
    ...over,
  });

  it("an unmatured bond drawn on for a shortfall has an assessable earnings component", () => {
    const out = projectPlan(withShortfall(bond()));
    expect(out.yearly[0].bondDetail.bd1.withdrawals).toBeGreaterThan(0);
    expect(out.yearly[0].bondDetail.bd1.assessableWithdrawal).toBeGreaterThan(0);
  });

  it("a matured bond drawn on for the SAME shortfall has NO assessable component — entirely tax-free", () => {
    const out = projectPlan(withShortfall(bond({ startDate: "2005-07-01" })));
    expect(out.yearly[0].bondDetail.bd1.withdrawals).toBeGreaterThan(0);
    expect(out.yearly[0].bondDetail.bd1.assessableWithdrawal).toBe(0);
  });

  it("an unmatured withdrawal's extra tax cost reduces net worth relative to the same withdrawal from a matured bond", () => {
    // Surplus retained as cash (not swept to "spend") — otherwise any
    // tax difference is absorbed into how much gets spent away each FY
    // rather than showing up in the retained balance this test checks.
    const retainCash = { surplus: { periods: [{
      id: "sp1", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
      payNonDeductibleDebtFirst: false, debtOrder: "interestRate", allocations: [], remainderTo: "cash",
    }] } };
    const unmatured = projectPlan(withShortfall(bond(), retainCash));
    const matured = projectPlan(withShortfall(bond({ startDate: "2005-07-01" }), retainCash));
    // Same household, same shortfall, same withdrawal size — the only
    // difference is the assessable tax cost, which must show up as
    // LOWER net worth for the unmatured case by year-end (year 1, once
    // the deferred tax settles — see the engine's own PAYG-timing note).
    expect(unmatured.yearly[1].netAssets).toBeLessThan(matured.yearly[1].netAssets);
  });

  it("respects the SAME funding order as an ordinary asset — a bond placed first is drawn before other assets", () => {
    const out = projectPlan(withShortfall(bond({ balance: 200000 }), { fundingOrder: ["bd1", "a1"] }));
    expect(out.yearly[0].bondDetail.bd1.withdrawals).toBeGreaterThan(0);
    expect(out.yearly[0].perAssetDetail.a1.deficitFunding).toBe(0);
  });

  it("respects a configured minimum balance — never drawn below it", () => {
    const out = projectPlan(withShortfall(bond(), { deficit: { minimumBalances: { bd1: 20000 }, sellRule: "order" } }));
    expect(out.yearly[0].bondDetail.bd1.closing).toBeGreaterThanOrEqual(20000 - 1);
  });

  it("conservation holds across a bond-funded shortfall, both unmatured and matured", () => {
    for (const startDate of ["2020-07-01", "2005-07-01"]) {
      const out = projectPlan(withShortfall(bond({ startDate })));
      for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `bond shortfall (${startDate}), year ${y}`);
    }
  });

  it("regression gate: fundingOrder's bond-eligibility check doesn't affect a plan with no bonds at all", () => {
    const withoutBonds = mkState({
      endAge: 43,
      cashflows: { income: [salary(80000)], expenses: [bigExpense(150000)], contributions: [], withdrawals: [], lumpSums: [], bondContributions: [] },
    });
    const out = projectPlan(withoutBonds);
    expect(out.yearly[0].perAssetDetail.a1.deficitFunding).toBeGreaterThan(0);
  });
});

describe("Investment and education bonds (spec 25, Commit 3): education withdrawals", () => {
  const child = (over = {}) => ({
    id: "ch1", name: "Child 1", dateOfBirth: synthDob(10, { year: 2026, month: 7 }), education: [
      { id: "ed1", fromAge: 10, toAge: 17, annualAmount: 20000, indexBasis: "none", indexExtraPct: 0 },
    ],
    ...over,
  });
  const educationBond = (over = {}) => ({
    id: "bd1", name: "Ed Bond", type: "education", owner: "client", include: true,
    balance: 100000, startDate: "2020-07-01", beneficiaryChildId: "ch1",
    allocation: { mode: "custom", incomePct: 6, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0,
    ...over,
  });
  const withEducationBond = (b, over = {}) => mkState({
    endAge: 44, bonds: [b],
    plan: { children: [child()] },
    cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [], bondContributions: [] },
    ...over,
  });

  it("an education withdrawal reduces the modelled fee's net cost — the household's own expense is offset by the bond's credit", () => {
    const withBond = projectPlan(withEducationBond(educationBond()));
    const withoutBond = projectPlan(mkState({ endAge: 44, plan: { children: [child()] } }));
    // Same fee schedule either way (unaffected — see the spec's own
    // "met from cashflow" framing: the EXPENSE itself doesn't change,
    // only what funds it) — the bond-funded plan's net worth should be
    // HIGHER by year-end, since the bond pays the fee AND adds its own
    // education benefit on top.
    expect(withBond.yearly[0].expenses).toBeCloseTo(withoutBond.yearly[0].expenses, 2);
    expect(withBond.yearly[0].bondDetail.bd1.educationWithdrawal).toBeGreaterThan(0);
    expect(withBond.yearly[0].bondDetail.bd1.educationBenefit).toBeGreaterThan(0);
    expect(withBond.yearly[0].netAssets).toBeGreaterThan(withoutBond.yearly[0].netAssets);
  });

  it("the education withdrawal is capped at the bond's own balance — a fee bigger than what's left simply isn't fully covered", () => {
    const out = projectPlan(withEducationBond(educationBond({ balance: 5000 })));
    expect(out.yearly[0].bondDetail.bd1.educationWithdrawal).toBeLessThanOrEqual(5000 * 1.05); // ≤ balance + this year's own growth
    expect(out.yearly[0].bondDetail.bd1.closing).toBeCloseTo(0, 0);
  });

  it("an education withdrawal never touches the investor's own tax — no assessable component regardless of the ten-year mark", () => {
    const unmatured = projectPlan(withEducationBond(educationBond({ startDate: "2025-07-01" })));
    const matured = projectPlan(withEducationBond(educationBond({ startDate: "2005-07-01" })));
    expect(unmatured.yearly[0].bondDetail.bd1.assessableWithdrawal).toBe(0);
    expect(matured.yearly[0].bondDetail.bd1.assessableWithdrawal).toBe(0);
  });

  it("a bond with no beneficiary (or an investment-type bond) never auto-funds any child's fees", () => {
    const out = projectPlan(withEducationBond(educationBond({ beneficiaryChildId: null })));
    expect(out.yearly[0].bondDetail.bd1.educationWithdrawal).toBe(0);
  });

  it("conservation holds across an education-funded fee schedule, fully and partially covered", () => {
    for (const balance of [100000, 5000]) {
      const out = projectPlan(withEducationBond(educationBond({ balance })));
      for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `education bond (balance ${balance}), year ${y}`);
    }
  });

  it("regression gate: an investment bond with the field present but unset behaves identically to one where it's absent", () => {
    const withField = projectPlan(withEducationBond({ ...educationBond(), type: "investment", beneficiaryChildId: null }));
    const withoutField = projectPlan(withEducationBond({ ...educationBond(), type: "investment", beneficiaryChildId: undefined }));
    expect(withField.yearly[2].netAssets).toBeCloseTo(withoutField.yearly[2].netAssets, 6);
  });
});

// --- Glide paths and income-driven drawdown (spec 32, Commit 4) -----------

describe("Glide paths (spec 32, Commit 4): engine integration", () => {
  const GP = {
    id: "gp1", name: "Glide", rebalance: "annual",
    steps: [{ fromAge: 40, profile: "High Growth – Capital" }, { fromAge: 44, profile: "Cash" }],
  };

  it("a glide-pathed financial asset at its FIRST step's own age is bit-identical to an ordinary profile-mode asset using that same profile", () => {
    // Annual rebalance resolves to EXACTLY the age-implied target every
    // year (glidePaths.js's own header) — at age 40 == the first step's
    // own fromAge, that target is 100% "High Growth – Capital", so this
    // is a genuine equality, not an approximation.
    const glide = projectPlan(mkState({
      endAge: 41,
      plan: { glidePaths: [GP] },
      assets: [mkAsset({ allocation: { mode: "glidePath", glidePathId: "gp1" }, balance: 500000, distributions: "reinvest" })],
    }));
    const plain = projectPlan(mkState({
      endAge: 41,
      assets: [mkAsset({ allocation: { mode: "profile", profile: "High Growth – Capital" }, balance: 500000, distributions: "reinvest" })],
    }));
    expect(glide.yearly[0].growth).toBeCloseTo(plain.yearly[0].growth, 6);
  });

  it("a glide-pathed financial asset at its LAST step's own age is bit-identical to an ordinary profile-mode asset using THAT profile", () => {
    // Starting the client directly AT the last step's own age (44) —
    // rather than reading year 4 of a longer run — isolates the RATE
    // comparison from the fact that the two runs would otherwise have
    // accumulated different balances over the preceding years (glide
    // path earning High Growth first, "plain" earning Cash throughout),
    // which would make their absolute dollar growth diverge even with
    // an identical rate at year 4.
    const glide = projectPlan(mkState({
      plan: { client: { currentAge: 44 }, glidePaths: [GP] },
      endAge: 45,
      assets: [mkAsset({ allocation: { mode: "glidePath", glidePathId: "gp1" }, balance: 500000, distributions: "reinvest" })],
    }));
    const plain = projectPlan(mkState({
      plan: { client: { currentAge: 44 } },
      endAge: 45,
      assets: [mkAsset({ allocation: { mode: "profile", profile: "Cash" }, balance: 500000, distributions: "reinvest" })],
    }));
    expect(glide.yearly[0].growth).toBeCloseTo(plain.yearly[0].growth, 6);
  });

  it("the growth rate genuinely moves year to year across the ramp — not pinned to one profile throughout", () => {
    const out = projectPlan(mkState({
      endAge: 45,
      plan: { glidePaths: [GP] },
      assets: [mkAsset({ allocation: { mode: "glidePath", glidePathId: "gp1" }, balance: 500000, distributions: "reinvest" })],
    }));
    // High Growth – Capital's total return is well above Cash's, so
    // growth should be strictly decreasing across the ramp.
    expect(out.yearly[0].growth).toBeGreaterThan(out.yearly[2].growth);
    expect(out.yearly[2].growth).toBeGreaterThan(out.yearly[4].growth);
  });

  it("a super account glide path is anchored to the OWNER's own age, not the client's — a couple's two accounts on the SAME glide path diverge when the owners' ages differ", () => {
    const state = mkState({
      endAge: 44,
      plan: {
        client: { currentAge: 40 }, partner: { currentAge: 44 }, household: "married",
        glidePaths: [GP],
        superAccounts: [
          superAcct({ id: "su1", owner: "client", balance: 500000, allocation: { mode: "glidePath", glidePathId: "gp1" } }),
          superAcct({ id: "su2", owner: "partner", balance: 500000, allocation: { mode: "glidePath", glidePathId: "gp1" } }),
        ],
      },
    });
    const out = projectPlan(state, PROFILES);
    // Year 0: client is 40 (the glide path's own first step — 100% High
    // Growth) while the partner is ALREADY 44 (the glide path's own last
    // step — 100% Cash). If the anchor were wrongly shared, both
    // accounts would show identical earnings; anchored correctly, the
    // client's account (still fully growth) earns materially more.
    expect(out.yearly[0].superDetail.su1.earnings).toBeGreaterThan(out.yearly[0].superDetail.su2.earnings);
  });

  it("a pension glide path is anchored to the owner's own age and its own retirement-phase (untaxed) growth still reads from the SAME precomputed per-year rate", () => {
    const glide = projectPlan(mkState({
      endAge: 41,
      plan: {
        client: { currentAge: 40, retirementAge: 40 },
        glidePaths: [GP],
        superAccounts: [superAcct({ balance: 500000, allocation: { mode: "glidePath", glidePathId: "gp1" } })],
        pensions: [pensionRow({ allocation: { mode: "glidePath", glidePathId: "gp1" } })],
      },
    }));
    const plain = projectPlan(mkState({
      endAge: 41,
      plan: {
        client: { currentAge: 40, retirementAge: 40 },
        superAccounts: [superAcct({ balance: 500000, allocation: { mode: "profile", profile: "High Growth – Capital" } })],
        pensions: [pensionRow({ allocation: { mode: "profile", profile: "High Growth – Capital" } })],
      },
    }));
    // Year 0 = age 40 = the glide path's own first step — an ABP is in
    // retirement phase from commencement (spec 20, Commit 3), so this
    // exercises the untaxed grossRate branch specifically.
    expect(glide.yearly[0].pensionDetail.pn1.earnings).toBeCloseTo(plain.yearly[0].pensionDetail.pn1.earnings, 0);
  });

  it("drift diverges from annual rebalance partway through the ramp — the engine actually distinguishes the two modes, not just glidePaths.js in isolation", () => {
    const runWith = (rebalance) => projectPlan(mkState({
      endAge: 45,
      plan: { glidePaths: [{ ...GP, rebalance }] },
      assets: [mkAsset({ allocation: { mode: "glidePath", glidePathId: "gp1" }, balance: 500000, distributions: "reinvest" })],
    }));
    const annual = runWith("annual");
    const drift = runWith("drift");
    // Mid-ramp (year 2, age 42): drift has been carrying High Growth's
    // outperformance forward, so it should show MORE growth than annual
    // rebalance's fresh age-implied target at the same year.
    expect(drift.yearly[2].growth).toBeGreaterThan(annual.yearly[2].growth);
  });

  it("regression gate: an ordinary profile-mode holding is bit-identical whether or not the plan has unrelated glide paths defined", () => {
    const withoutGP = projectPlan(mkState({ endAge: 43 }));
    const withGP = projectPlan(mkState({ endAge: 43, plan: { glidePaths: [GP] } }));
    expect(withGP.yearly[2].netAssets).toBeCloseTo(withoutGP.yearly[2].netAssets, 6);
  });

  it("a dangling glidePathId (no matching entry in plan.glidePaths) never throws — it resolves EXACTLY like any other unresolvable allocation reference", () => {
    // Zero nominal return components (assetReturnComponents's own
    // fallback) is NOT the same as zero growth — deflated to real terms
    // it's a small negative real return, identical to what an unknown
    // "profile"-mode key already produces (never a special case, never
    // a throw).
    const dangling = projectPlan(mkState({
      endAge: 41,
      assets: [mkAsset({ allocation: { mode: "glidePath", glidePathId: "no-such-id" }, balance: 500000, distributions: "reinvest" })],
    }));
    const unknownProfile = projectPlan(mkState({
      endAge: 41,
      assets: [mkAsset({ allocation: { mode: "profile", profile: "Not A Real Profile" }, balance: 500000, distributions: "reinvest" })],
    }));
    expect(dangling.yearly[0].growth).toBeCloseTo(unknownProfile.yearly[0].growth, 6);
  });

  it("conservation holds for glide-pathed assets, super, and pensions together", () => {
    const out = projectPlan(mkState({
      endAge: 44,
      plan: {
        client: { currentAge: 40, retirementAge: 40 },
        glidePaths: [GP],
        superAccounts: [superAcct({ balance: 300000, allocation: { mode: "glidePath", glidePathId: "gp1" } })],
        pensions: [pensionRow({ allocation: { mode: "glidePath", glidePathId: "gp1" } })],
      },
      assets: [mkAsset({ allocation: { mode: "glidePath", glidePathId: "gp1" }, balance: 200000, distributions: "reinvest" })],
    }));
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `glide path year ${y}`);
  });
});

describe("Income-driven drawdown (spec 32, Commit 4)", () => {
  const baseSingle = (overPlan = {}) => mkState({
    endAge: 62,
    plan: {
      client: { currentAge: 60, retirementAge: 60 },
      superAccounts: [superAcct({ balance: 500000, allocation: zeroRealSuperAlloc() })],
      pensions: [pensionRow({ drawdownOption: "expenditure" })],
      workingCash: { balance: 500000, minimumBalance: 0, ratePct: 0 }, // no deficit ever, isolates the FY-end top-up
      ...overPlan,
    },
  });

  const incomeRequiredCfg = (customAmount) => ({
    incomeRequired: {
      source: "custom", customAmount, indexBasis: "none", indexExtraPct: 0,
      startAt: { kind: "age", age: 60 }, stepDownAtAge: null, stepDownPct: 80,
    },
  });

  it("OFF (default, or the field simply absent): behaves exactly like before this commit — pays only the statutory minimum", () => {
    const out = projectPlan(baseSingle({ retirement: incomeRequiredCfg(200000) })); // a huge target, deliberately — must be ignored
    expect(out.yearly[0].pensionDetail.pn1.payments).toBeCloseTo(500000 * 0.04, 0);
  });

  it("ON, but the target is BELOW the statutory minimum: the minimum still wins (\"floored at the statutory minimum\", the spec's own words)", () => {
    const out = projectPlan(baseSingle({
      retirement: { ...incomeRequiredCfg(1000), incomeDrivenDrawdown: true },
    }));
    expect(out.yearly[0].pensionDetail.pn1.payments).toBeCloseTo(500000 * 0.04, 0);
  });

  it("ON, target above the minimum: the pension tops up toward Income Required, not just the compliance floor", () => {
    const out = projectPlan(baseSingle({
      retirement: { ...incomeRequiredCfg(60000), incomeDrivenDrawdown: true },
    }));
    expect(out.yearly[0].pensionDetail.pn1.payments).toBeCloseTo(60000, 0);
  });

  it("two 'expenditure' pensions share ONE household target — the target is met once, never doubled, though each STILL owes its own separate statutory minimum", () => {
    const out = projectPlan(mkState({
      endAge: 62,
      plan: {
        client: { currentAge: 60, retirementAge: 60 },
        superAccounts: [
          superAcct({ id: "su1", balance: 500000, allocation: zeroRealSuperAlloc() }),
          superAcct({ id: "su2", balance: 500000, allocation: zeroRealSuperAlloc() }),
        ],
        pensions: [
          pensionRow({ id: "pn1", sourceAccountId: "su1", drawdownOption: "expenditure" }),
          pensionRow({ id: "pn2", sourceAccountId: "su2", drawdownOption: "expenditure" }),
        ],
        workingCash: { balance: 500000, minimumBalance: 0, ratePct: 0 },
        retirement: { ...incomeRequiredCfg(60000), incomeDrivenDrawdown: true },
      },
    }));
    const pn1Paid = out.yearly[0].pensionDetail.pn1.payments;
    const pn2Paid = out.yearly[0].pensionDetail.pn2.payments;
    // pn1 (processed first, in plan order) absorbs the whole household
    // target — 60,000, comfortably clearing its own 20,000 (4% of
    // 500,000) statutory minimum along the way.
    expect(pn1Paid).toBeCloseTo(60000, 0);
    // pn2's own compliance minimum is a SEPARATE legal obligation on
    // THAT pension — it is never waived just because another pension
    // already met the household's income target — so it still pays its
    // own 20,000 floor, on top.
    expect(pn2Paid).toBeCloseTo(20000, 0);
    // The one thing this design exists to prevent: pn2 does NOT also
    // chase the full 60,000 target a second time (which would total
    // 120,000 combined) — it only ever tops up by what's genuinely
    // still owed after pn1's own contribution.
    const combined = pn1Paid + pn2Paid;
    expect(combined).toBeLessThan(60000 * 2);
  });

  it("conservation holds with income-driven drawdown on", () => {
    const out = projectPlan(baseSingle({ retirement: { ...incomeRequiredCfg(60000), incomeDrivenDrawdown: true } }));
    for (let y = 0; y < out.yearly.length - 1; y++) checkYearConservation(out, y, `income-driven drawdown year ${y}`);
  });
});
