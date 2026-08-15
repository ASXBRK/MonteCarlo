import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { fhsssReleaseAmounts, FHSSS_ANNUAL_CAP, FHSSS_LIFETIME_CAP } from "./fhsss.js";
import { eligibleFhsssPersons, buildFhsssFocus, buildFhsssComparison } from "./focusFhsss.js";

// Minimal v3-shaped state factory — mirrors deterministic.test.js's own
// mkState (kept separate, not shared — see solve.test.js's header for why).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    distributions: "reinvest", balance: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

// Real-zero for a SUPER account specifically needs to gross up for the
// fund's own 15% earnings tax (a plain incomePct: cpi*100 still decays
// slightly after tax) — see deterministic.test.js's own
// zeroRealSuperAlloc for the same wrinkle. Needed here so the real
// account balance never falls below the FHSSS notional balance and
// silently CAPS the release (deterministic.js's own "cap at what's
// actually in the account" — the exact mechanism this fixture must
// avoid triggering for its hand-calc to hold).
function zeroRealSuperAlloc(cpi = 0.025, earningsTaxRate = 0.15) {
  return { mode: "custom", incomePct: (cpi / (1 - earningsTaxRate)) * 100, growthPct: 0, frankingPct: 0, volBasis: "Balanced" };
}

function superAcct(over = {}) {
  return {
    id: "su1", name: "Super", owner: "client", balance: 0, taxFreeComponent: 0,
    allocation: zeroRealSuperAlloc(),
    icrPct: 0, include: true,
    ...over,
  };
}

function employmentRow(over = {}) {
  return {
    id: "i1", label: "Salary", owner: "client", amount: 150000, frequency: "annual",
    from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 },
    indexBasis: "cpi", indexExtraPct: 0, incomeType: "employment", sgApplies: false,
    ...over,
  };
}

function scRow(over = {}) {
  return {
    id: "sc1", label: "Contribution", owner: "client", accountId: "su1",
    type: "salarySacrifice", basis: "amount", amount: 10000, percent: 0, incomeRowId: null,
    frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 },
    indexBasis: "cpi", indexExtraPct: 0, fhsssEligible: true,
    ...over,
  };
}

function fhsssProp(over = {}) {
  return {
    id: "p1", name: "First home", owner: "client", state: "NSW",
    propertyType: "ppr", status: "planned",
    currentValue: 0, acquisitionDate: null, costBase: 0,
    priceToday: 500000, purchaseAt: { kind: "age", age: 42 },
    lvrPct: 0, firstHomeBuyer: false, newBuild: false,
    purchaseCostsPct: 0, dutyOverride: 0, growthPct: 2.5, // = cpi, real price stays $500,000
    rent: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "none", indexExtraPct: 0 },
    expensesDeductible: true, depreciation: 0,
    releaseFhsssAtPurchase: true,
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
      endAge: over.endAge ?? 45,
      start: { year: 2026, month: 7 },
      superAccounts: over.superAccounts ?? [],
      workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
      ...over.plan,
    },
    assets,
    goals: [],
    liabilities: over.liabilities ?? [],
    properties: over.properties ?? [],
    cashflows: {
      income: [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [],
      ...over.cashflows,
    },
    settings: {
      surplus: over.surplus ?? { mode: "accumulate", assetId: null },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed", fhsssEarningsRate: 0.025, ...over.assumptions },
    display: { units: "real" },
  };
}

// Two years (ages 40-41) of $10,000/year eligible salary sacrifice —
// $20,000 total, well under both caps — then a PPR purchase at 42
// releases it. Earnings rate pinned to cpi (real-zero) for exact hand
// calcs, matching deterministic.test.js's own FHSSS fixture.
function baseState(over = {}) {
  return mkState({
    plan: { superAccounts: [superAcct()] },
    cashflows: {
      income: [employmentRow()],
      superContributions: [scRow()],
    },
    properties: [fhsssProp()],
    ...over,
  });
}

describe("eligibleFhsssPersons", () => {
  it("finds the person behind an FHSSS-eligible contribution", () => {
    expect(eligibleFhsssPersons(baseState())).toEqual(["client"]);
  });

  it("returns nothing for a plan with no FHSSS-eligible contributions", () => {
    const state = mkState({ plan: { superAccounts: [superAcct()] } });
    expect(eligibleFhsssPersons(state)).toEqual([]);
  });
});

describe("buildFhsssFocus", () => {
  it("returns null when the person has no FHSSS activity at all", () => {
    const state = mkState({ plan: { superAccounts: [superAcct()] } });
    const out = projectPlan(state);
    expect(buildFhsssFocus({ out, state, person: "client" })).toBeNull();
  });

  it("contributions/earnings by year reconcile to row.fhsssDetail exactly", () => {
    const state = baseState();
    const out = projectPlan(state);
    const f = buildFhsssFocus({ out, state, person: "client" });
    // Years 0, 1 and 2 — the release fires LATER in year 2's own
    // processing (see deterministic.js's ordering comment), so year 2
    // itself still gets a normal (pre-release) entry; fhsssDetail only
    // goes null from year 3 onward.
    expect(f.byYear.length).toBe(3);
    expect(f.byYear[0].contributionAccepted).toBeCloseTo(10000, 2);
    expect(f.byYear[1].contributionAccepted).toBeCloseTo(10000, 2);
    expect(f.byYear[2].contributionAccepted).toBe(0); // nothing contributed this year, just accrual + the release
    for (const row of f.byYear) {
      const d = out.yearly[row.year].fhsssDetail.client;
      expect(row.contributionAccepted).toBe(d.contributionAccepted);
      expect(row.contributionRejected).toBe(d.contributionRejected);
      expect(row.earningsAccrued).toBe(d.earningsAccrued);
    }
  });

  it("cap headroom reconciles to the fhsss.js cap constants against the latest tracked balance", () => {
    const state = baseState();
    const out = projectPlan(state);
    const f = buildFhsssFocus({ out, state, person: "client" });
    // Latest tracked year is year 2 (the release year itself — see above).
    expect(f.capHeadroom.year).toBe(2);
    expect(f.capHeadroom.lifetimeContributed).toBeCloseTo(20000, 2);
    expect(f.capHeadroom.lifetimeRemaining).toBeCloseTo(FHSSS_LIFETIME_CAP - 20000, 2);
    expect(f.capHeadroom.annualUsed).toBe(0); // nothing contributed in year 2 itself
    expect(f.capHeadroom.annualRemaining).toBeCloseTo(FHSSS_ANNUAL_CAP, 2);
  });

  it("eligible-release-now uses the SAME formula as an actual release (fhsssReleaseAmounts, not reimplemented)", () => {
    const state = baseState();
    const out = projectPlan(state);
    const f = buildFhsssFocus({ out, state, person: "client" });
    const d = out.yearly[f.capHeadroom.year].fhsssDetail.client;
    const expected = fhsssReleaseAmounts({
      concessionalBalance: d.concessionalBalance, nonConcessionalBalance: d.nonConcessionalBalance, earnings: d.earningsBalance,
    });
    expect(f.eligibleReleaseNow.grossRelease).toBeCloseTo(expected.grossRelease, 6);
    expect(f.eligibleReleaseNow.taxableComponent).toBeCloseTo(expected.taxableComponent, 6);
  });

  it("the actual release reconciles to row.taxDetail exactly, including the taxable/tax-free split and the offset", () => {
    const state = baseState();
    const out = projectPlan(state);
    const f = buildFhsssFocus({ out, state, person: "client" });
    const td = out.yearly[2].taxDetail.client;
    expect(f.actualRelease.year).toBe(2);
    expect(f.actualRelease.grossRelease).toBe(td.fhsssRelease);
    expect(f.actualRelease.taxableComponent).toBe(td.fhsssTaxableComponent);
    expect(f.actualRelease.taxFreeComponent).toBe(td.fhsssTaxFreeComponent);
    expect(f.actualRelease.offset).toBe(td.fhsssOffset);
    // Known-value: 85% of $20,000 concessional = $17,000 (see deterministic.test.js's own hand calc).
    expect(f.actualRelease.grossRelease).toBeCloseTo(17000, 0);
  });
});

describe("buildFhsssComparison", () => {
  it("returns null for a person with no FHSSS-eligible contributions", () => {
    const state = mkState({ plan: { superAccounts: [superAcct()] } });
    expect(buildFhsssComparison({ state, person: "client" })).toBeNull();
  });

  it("both arms come from a real projectPlan() run — the outside-super value reconciles to an independent engine run on the same clone shape", () => {
    const state = baseState();
    const comparison = buildFhsssComparison({ state, person: "client" });
    expect(comparison).not.toBeNull();
    expect(comparison.comparisonYear).toBe(2);
    // insideValue is exactly the actual release (already verified above).
    expect(comparison.insideValue).toBeCloseTo(17000, 0);

    // Independently reconstruct the SAME outside-super clone by hand and
    // confirm buildFhsssComparison's outsideValue matches an engine run
    // over it exactly — proving it isn't a hand-rolled tax calculation.
    const outsideState = structuredClone(state);
    outsideState.assets.push({
      id: "__focus-fhsss-comparison__", name: "x", class: "financial", include: true, owner: "client",
      distributions: "reinvest", balance: 0, allocation: superAcct().allocation, icrPct: 0, cgtAsset: true, costBase: 0,
    });
    outsideState.cashflows.superContributions = [];
    outsideState.cashflows.contributions = [{
      id: "manual", assetId: "__focus-fhsss-comparison__", amount: 10000, frequency: "annual",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 41 }, indexed: false, owner: "client", label: "x",
    }];
    outsideState.properties = outsideState.properties.map((p) => ({ ...p, releaseFhsssAtPurchase: false }));
    outsideState.settings.fundingOrder = [...outsideState.settings.fundingOrder, "__focus-fhsss-comparison__"];
    const out = projectPlan(outsideState);
    expect(comparison.outsideValue).toBeCloseTo(out.yearly[2].perAssetClosing["__focus-fhsss-comparison__"], 2);
  });

  it("the difference is exactly insideValue minus outsideValue", () => {
    const comparison = buildFhsssComparison({ state: baseState(), person: "client" });
    expect(comparison.difference).toBeCloseTo(comparison.insideValue - comparison.outsideValue, 6);
  });
});
