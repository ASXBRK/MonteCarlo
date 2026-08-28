import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { projectStatic } from "./staticProjection.js";
import { legacySurplusPeriod } from "./planState.js";

// Same minimal-fixture conventions as deterministic.test.js's own
// mkState/mkAsset/cf — this file deliberately keeps its own local
// copies rather than importing from there (no shared fixture module
// in this codebase's own convention; see deterministic.test.js's own
// header on why).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "A1", include: true, owner: "client",
    distributions: "reinvest", balance: 100000,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function surplusPeriodsFor(over) {
  if (Array.isArray(over?.periods)) return over.periods;
  return [legacySurplusPeriod(over ?? { mode: "spend", assetId: null })];
}

function superAcct(over = {}) {
  return {
    id: "su1", name: "Super", owner: "client", balance: 0, taxFreeComponent: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 5, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, include: true,
    ...over,
  };
}

function mkState(over = {}) {
  const assets = over.assets ?? [mkAsset()];
  return {
    plan: {
      household: "single", client: { currentAge: 40 }, partner: null,
      endAge: over.endAge ?? 44, start: over.start ?? { year: 2026, month: 7 },
      superAccounts: over.superAccounts ?? [], pensions: over.pensions ?? [],
      ...over.plan,
    },
    assets,
    bonds: over.bonds ?? [],
    liabilities: over.liabilities ?? [],
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

const incomeRow = (over = {}) => ({
  id: "i1", label: "Other income", owner: "client", amount: 3000, frequency: "monthly",
  from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
  indexBasis: "cpi", indexExtraPct: 0, incomeType: "otherTaxable",
  ...over,
});

const expenseRow = (over = {}) => ({
  id: "e1", label: "Living", owner: "client", amount: 2000, frequency: "monthly",
  from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
  indexBasis: "cpi", indexExtraPct: 0,
  ...over,
});

const loan = (over = {}) => ({
  id: "lb1", name: "Home loan", type: "mortgage", owner: "client",
  balance: 50000, interestRatePct: 6, termYears: 10, repayment: "pi",
  ioYears: 0, deductible: false, linkedAssetId: null, offsetAssetId: null,
  ...over,
});

describe("projectStatic (spec 30, Commit 1) — control: nothing evolving", () => {
  it("matches the real engine's own net-worth path when income/expenses/asset return are all genuinely flat in real terms", () => {
    const state = mkState({
      cashflows: { income: [incomeRow()], expenses: [expenseRow()] },
    });
    const out = projectPlan(state);
    const staticYearly = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });

    expect(staticYearly.length).toBe(out.yearly.length);
    // Snapshot year itself: exact agreement by construction.
    expect(staticYearly[0].netAssets).toBeCloseTo(out.yearly[0].netAssets, 6);
    // Every later year: nothing in this scenario evolves (0% real
    // asset return, CPI-indexed income/expenses held flat in real
    // terms, no liabilities) — the two models should track closely.
    // A small tolerance covers the mid-year-flow-timing convention
    // difference from the real engine's own monthly compounding.
    for (let y = 1; y < out.yearly.length; y++) {
      const real = out.yearly[y].netAssets;
      const stat = staticYearly[y].netAssets;
      expect(Math.abs(stat - real)).toBeLessThan(Math.max(50, Math.abs(real) * 0.02));
    }
  });

  it("is the control the spec names: divergence near zero here means any divergence found elsewhere is real, not an implementation artefact", () => {
    const state = mkState({
      cashflows: { income: [incomeRow({ amount: 5000 })], expenses: [expenseRow({ amount: 3000 })] },
      endAge: 60,
    });
    const out = projectPlan(state);
    const staticYearly = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });
    const realFinal = out.yearly[out.yearly.length - 1].netAssets;
    const staticFinal = staticYearly[staticYearly.length - 1].netAssets;
    const pctDiff = Math.abs(staticFinal - realFinal) / Math.abs(realFinal);
    expect(pctDiff).toBeLessThan(0.03);
  });
});

describe("projectStatic — indexation option", () => {
  it("'flat' (hold nominal constant) decays the real figures at CPI; 'cpi' (index nominal at CPI) holds them flat in real terms", () => {
    const state = mkState({
      cashflows: { income: [incomeRow({ amount: 3000 })], expenses: [expenseRow({ amount: 2000 })] },
      cpi: 0.025,
    });
    const flatYearly = projectStatic(state, { snapshotYears: 0, indexation: "flat" });
    const cpiYearly = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });
    const y = flatYearly.length - 1;
    // cpi mode: income stays exactly at the snapshot's real figure.
    expect(cpiYearly[y].income).toBeCloseTo(flatYearly[0].income, 2);
    // flat mode: income has decayed by (1+cpi)^-years relative to cpi mode.
    const years = y;
    expect(flatYearly[y].income).toBeCloseTo(cpiYearly[y].income * Math.pow(1 / 1.025, years), 2);
    expect(flatYearly[y].income).toBeLessThan(cpiYearly[y].income);
  });
});

describe("projectStatic — surplus lost once its liability destination closes", () => {
  it("a liability's extra repayment stops being applied (dropped, not redirected) once its static balance reaches zero", () => {
    const state = mkState({
      liabilities: [loan({ balance: 150000, termYears: 20, interestRatePct: 6 })],
      cashflows: {
        income: [incomeRow({ amount: 4000 })],
        expenses: [expenseRow({ amount: 1500 })],
      },
      fundingOrder: [],
      endAge: 60,
      // Direct all surplus at extra-repaying the loan, so the real
      // engine's own snapshot year shows a real surplusRepayment/
      // extraRepayment figure for this liability to hold/index.
      surplus: {
        periods: [{
          id: "sp1", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
          payNonDeductibleDebtFirst: false, debtOrder: "interestRate", remainderTo: "cash",
          allocations: [{ id: "sa1", targetType: "liability", targetId: "lb1", pct: 100 }],
        }],
      },
    });
    const staticYearly = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });

    // The loan must actually close within this model's own horizon for
    // the test to exercise anything (a real, small starting balance
    // against a real surplus makes this true well before endAge 60).
    const closedIndex = staticYearly.findIndex((row) => row.liabilities.lb1.closing <= 1e-6);
    expect(closedIndex).toBeGreaterThan(0);
    expect(closedIndex).toBeLessThan(staticYearly.length - 1);

    // From the year it closes onward, nothing further is applied to
    // it — this IS the modelled defect (spec 30's own words: "money is
    // not conserved"), not a bug to fix.
    const afterClose = staticYearly[closedIndex + 1].liabilities.lb1;
    expect(afterClose.interest).toBe(0);
    expect(afterClose.principal).toBe(0);
    expect(afterClose.extra).toBe(0);
    expect(afterClose.closing).toBe(0);
  });
});

describe("projectStatic — realism overrides isolate one driver at a time", () => {
  it("realism.loanMaturity redirects the freed-up extra repayment into static cash instead of dropping it", () => {
    const state = mkState({
      liabilities: [loan({ balance: 150000, termYears: 20, interestRatePct: 6 })],
      cashflows: {
        income: [incomeRow({ amount: 4000 })],
        expenses: [expenseRow({ amount: 1500 })],
      },
      fundingOrder: [],
      endAge: 60,
      surplus: {
        periods: [{
          id: "sp1", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
          payNonDeductibleDebtFirst: false, debtOrder: "interestRate", remainderTo: "cash",
          allocations: [{ id: "sa1", targetType: "liability", targetId: "lb1", pct: 100 }],
        }],
      },
    });
    const baseline = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });
    const fixed = projectStatic(state, { snapshotYears: 0, indexation: "cpi", realism: { loanMaturity: true } });
    const closedIndex = baseline.findIndex((row) => row.liabilities.lb1.closing <= 1e-6);
    expect(closedIndex).toBeGreaterThan(0);

    // Baseline: nothing accumulates once the loan is closed.
    expect(baseline[closedIndex + 1].staticCash).toBe(0);
    // Fixed: the freed-up amount is captured instead.
    expect(fixed[closedIndex + 1].staticCash).toBeGreaterThan(0);
    // The fix can only help (or do nothing), never hurt, net worth.
    const lastBaseline = baseline[baseline.length - 1].netAssets;
    const lastFixed = fixed[fixed.length - 1].netAssets;
    expect(lastFixed).toBeGreaterThanOrEqual(lastBaseline);
  });

  it("realism.taxBrackets substitutes the real engine's own per-year tax instead of the held/indexed figure", () => {
    const state = mkState({
      cashflows: { income: [incomeRow({ amount: 8000, incomeType: "employment", sgApplies: false })], expenses: [expenseRow({ amount: 2000 })] },
      endAge: 60,
    });
    const out = projectPlan(state);
    const baseline = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });
    const withRealTax = projectStatic(state, { snapshotYears: 0, indexation: "cpi", realism: { taxBrackets: true } });
    const y = baseline.length - 1;
    expect(withRealTax[y].tax).toBeCloseTo(out.yearly[y].tax, 2);
    // The baseline holds tax at the snapshot's own figure — it should
    // NOT already equal the real engine's later-year figure (otherwise
    // this scenario isn't exercising the override at all).
    expect(baseline[y].tax).not.toBeCloseTo(out.yearly[y].tax, 2);
  });
});

describe("projectStatic — super accounts roll forward too", () => {
  it("a super account's balance grows at its own implied real return and is included in netAssets", () => {
    const state = mkState({
      assets: [],
      fundingOrder: [],
      superAccounts: [superAcct({ balance: 100000, allocation: { mode: "custom", incomePct: 0, growthPct: 5, frankingPct: 0, volBasis: "Balanced" } })],
      cashflows: { income: [], expenses: [] },
      endAge: 50,
    });
    const out = projectPlan(state);
    const staticYearly = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });
    // Growth-only, no contributions this scenario — the static
    // account should keep growing every year, not sit flat, and its
    // balance should feed netAssets (there are no other accounts).
    expect(staticYearly[1].superClosing).toBeGreaterThan(staticYearly[0].superClosing);
    expect(staticYearly[staticYearly.length - 1].netAssets).toBeCloseTo(staticYearly[staticYearly.length - 1].superClosing, 6);
    // Sanity: broadly in the same neighbourhood as the real engine's
    // own super balance path (fund tax mechanics differ slightly from
    // the implied-rate approximation, so this is a loose bound, not an
    // exact-agreement assertion).
    const realFinalSuper = out.yearly[out.yearly.length - 1].superClosing;
    const staticFinalSuper = staticYearly[staticYearly.length - 1].superClosing;
    expect(Math.abs(staticFinalSuper - realFinalSuper) / realFinalSuper).toBeLessThan(0.1);
  });
});

describe("projectStatic — synthetic HELP debt liability", () => {
  it("tracks HELP/HECS debt (a synthetic help_<person> liability with no entry in state.liabilities) at the snapshot year", () => {
    // A HELP balance produces a synthetic `help_client` entry in the
    // real engine's own row.liabilities, with NO corresponding object
    // in state.liabilities at all — this file's liability tracking
    // must key off the REAL row's own liability ids (Object.keys),
    // not state.liabilities.map(l => l.id), or it silently drops any
    // liability that's synthetic rather than user-entered. Found while
    // generating the divergence report (spec 30, Commit 3): a real
    // client with HELP debt showed a 56% "divergence" at the SNAPSHOT
    // YEAR ITSELF, which must be exactly 0 by construction.
    const state = mkState({
      plan: { client: { currentAge: 29, retirementAge: 65, helpBalance: 28000 } },
      cashflows: { income: [incomeRow({ amount: 9000, incomeType: "employment" })], expenses: [expenseRow({ amount: 2000 })] },
      endAge: 50,
    });
    const out = projectPlan(state);
    expect(out.yearly[0].liabilitiesClosing).toBeGreaterThan(0); // sanity: HELP is genuinely active here
    const staticYearly = projectStatic(state, { snapshotYears: 0, indexation: "cpi" });
    expect(staticYearly[0].liabilitiesClosing).toBeCloseTo(out.yearly[0].liabilitiesClosing, 6);
    expect(staticYearly[0].netAssets).toBeCloseTo(out.yearly[0].netAssets, 6);
  });
});

describe("projectStatic — multiple snapshot years", () => {
  it("returns one independent extrapolation per snapshot year when snapshotYears is an array", () => {
    const state = mkState({
      cashflows: { income: [incomeRow()], expenses: [expenseRow()] },
      endAge: 50,
    });
    const results = projectStatic(state, { snapshotYears: [0, 3], indexation: "cpi" });
    expect(results).toHaveLength(2);
    expect(results[0].snapshotYear).toBe(0);
    expect(results[1].snapshotYear).toBe(3);
    // Each series starts its OWN snapshot year's real figures, not a
    // shared/blended base.
    expect(results[0].yearly[0].y).toBe(0);
    expect(results[1].yearly[0].y).toBe(3);
    const out = projectPlan(state);
    expect(results[1].yearly[0].netAssets).toBeCloseTo(out.yearly[3].netAssets, 6);
  });

  it("throws a clear error for a snapshot year outside the projection, rather than silently misbehaving", () => {
    const state = mkState({ endAge: 44 });
    expect(() => projectStatic(state, { snapshotYears: 99 })).toThrow(/outside the projection/);
  });
});
