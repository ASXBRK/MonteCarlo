import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import {
  eligibleDepositProperties, buildDepositFocus, solveDepositContribution, solveWhenCouldIBuy,
} from "./focusDeposit.js";

// Minimal v3-shaped state factory — mirrors deterministic.test.js's own
// mkState (kept separate, not shared — see solve.test.js's header for why).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    distributions: "reinvest", balance: 100000,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function prop(over = {}) {
  return {
    id: "p1", name: "First home", owner: "client", state: "NSW",
    propertyType: "ppr", status: "planned",
    currentValue: 0, acquisitionDate: null, costBase: null,
    priceToday: 600000, purchaseAt: { kind: "age", age: 44 },
    lvrPct: 80, firstHomeBuyer: false, newBuild: false,
    purchaseCostsPct: 2, dutyOverride: null, growthPct: 5,
    rent: { amount: 0, indexBasis: "cpi", indexExtraPct: 0 },
    expenses: { amount: 0, indexBasis: "cpi", indexExtraPct: 0 },
    expensesDeductible: true, depreciation: 0,
    releaseFhsssAtPurchase: false, firstHomeGuarantee: false,
    lmiOverride: null, lmiPayAtSettlement: false,
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
    liabilities: over.liabilities ?? [],
    properties: over.properties ?? [],
    cashflows: {
      income: [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [],
      ...over.cashflows,
    },
    settings: {
      // "accumulate" (into the WCA) so a household's ordinary surplus
      // actually builds toward a deposit over time — "spend" would
      // sweep it out of the model every FY, making every save-toward-
      // a-purchase scenario impossible by construction.
      surplus: over.surplus ?? { mode: "accumulate", assetId: null },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("eligibleDepositProperties", () => {
  it("filters to planned properties only", () => {
    const state = mkState({ properties: [prop({ id: "p1", status: "planned" }), prop({ id: "p2", status: "owned" })] });
    const result = eligibleDepositProperties(state);
    expect(result.map((p) => p.id)).toEqual(["p1"]);
  });
});

describe("buildDepositFocus", () => {
  it("returns null for a property that isn't planned", () => {
    const state = mkState({ properties: [prop({ status: "owned" })] });
    const out = projectPlan(state);
    expect(buildDepositFocus({ out, state, propertyId: "p1" })).toBeNull();
  });

  it("required-cash total reconciles to the engine's settlement figure to the dollar (no FHSSS)", () => {
    const state = mkState({
      assets: [mkAsset({ balance: 3_000_000 })],
      properties: [prop({ priceToday: 600000, purchaseAt: { kind: "age", age: 44 } })],
    });
    const out = projectPlan(state);
    const f = buildDepositFocus({ out, state, propertyId: "p1" });
    expect(f).not.toBeNull();
    const row = out.yearly[f.target.purchaseYear];
    expect(f.required.total).toBeCloseTo(row.properties.p1.settlement, 2);
    expect(f.required.deposit + f.required.duty + f.required.costs - f.required.fhog).toBeCloseTo(f.required.total, 2);
  });

  it("required total EXCLUDES the FHSSS release — it's shown as a funding source, not netted into required cash", () => {
    const state = mkState({
      assets: [mkAsset({ balance: 3_000_000 })],
      plan: {
        superAccounts: [{
          id: "su1", name: "Super", owner: "client", balance: 60000, taxFreeComponent: 0,
          allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
          icrPct: 0, include: true,
        }],
      },
      cashflows: {
        superContributions: [{
          id: "sc1", accountId: "su1", type: "personalDeductible", basis: "amount", amount: 15000,
          frequency: "annual", from: { kind: "age", age: 40 }, to: { kind: "age", age: 43 },
          fhsssEligible: true,
        }],
      },
      properties: [prop({ priceToday: 600000, purchaseAt: { kind: "age", age: 44 }, releaseFhsssAtPurchase: true })],
    });
    const out = projectPlan(state);
    const f = buildDepositFocus({ out, state, propertyId: "p1" });
    expect(f).not.toBeNull();
    expect(f.fhsssReleaseAtPurchase).toBeGreaterThan(0);
    const row = out.yearly[f.target.purchaseYear];
    // settlement = required.total − fhsssRelease (the engine's own net
    // figure); required.total adds the release back.
    expect(f.required.total).toBeCloseTo(row.properties.p1.settlement + f.fhsssReleaseAtPurchase, 2);
  });

  it("the on-track/shortfall determination matches the projection's own unfunded flag", () => {
    // Funded case: plenty of cash.
    const funded = mkState({
      assets: [mkAsset({ balance: 3_000_000 })],
      properties: [prop({ priceToday: 600000, purchaseAt: { kind: "age", age: 44 } })],
    });
    const outFunded = projectPlan(funded);
    const fFunded = buildDepositFocus({ out: outFunded, state: funded, propertyId: "p1" });
    expect(fFunded.answer.onTrack).toBe(true);
    expect(outFunded.shortfall).toBeNull();
    expect(fFunded.answer.spare).toBeGreaterThan(0);

    // Shortfall case: almost no cash, no borrowing (lvrPct 0) so nearly
    // the whole price must be funded from assets.
    const short = mkState({
      assets: [mkAsset({ balance: 5000 })],
      properties: [prop({ priceToday: 600000, purchaseAt: { kind: "age", age: 44 }, lvrPct: 0 })],
    });
    const outShort = projectPlan(short);
    const fShort = buildDepositFocus({ out: outShort, state: short, propertyId: "p1" });
    expect(fShort.answer.onTrack).toBe(false);
    expect(outShort.shortfall).not.toBeNull();
    // Reconciles to the SAME cumulative unfunded figure the engine itself recorded.
    let cumulative = 0;
    for (let y = 0; y <= fShort.target.purchaseYear; y++) cumulative += outShort.yearly[y].unfundedCashflow;
    expect(fShort.answer.shortfall).toBeCloseTo(cumulative, 2);
    expect(fShort.answer.shortfall).toBeGreaterThan(0);
  });

  it("the accumulating series runs opening balances through the purchase year, ending at the purchase year", () => {
    const state = mkState({
      assets: [mkAsset({ balance: 200000 })],
      properties: [prop({ priceToday: 300000, purchaseAt: { kind: "age", age: 43 }, lvrPct: 90 })],
    });
    const out = projectPlan(state);
    const f = buildDepositFocus({ out, state, propertyId: "p1" });
    expect(f.accumulating.length).toBe(f.target.purchaseYear + 1);
    expect(f.accumulating[0].availableReal).toBeCloseTo(out.yearly[0].openingBalance + out.yearly[0].wcaDetail.opening, 2);
    expect(f.accumulating.at(-1).age).toBe(f.target.purchaseAge);
  });
});

describe("solveDepositContribution — What would I need to save?", () => {
  it("produces a plan that, when applied, results in a funded purchase", () => {
    const state = mkState({
      assets: [mkAsset({ balance: 5000 })],
      // lvrPct 0 — no loan, so this isolates the deposit-accumulation
      // question from ongoing mortgage-serviceability (a separate
      // question this income-free fixture isn't meant to test).
      properties: [prop({ priceToday: 300000, purchaseAt: { kind: "age", age: 44 }, lvrPct: 0 })],
    });
    const r = solveDepositContribution({ state, propertyId: "p1", assetId: "a1", fromAge: 40 });
    expect(r.converged).toBe(true);
    expect(r.value).toBeGreaterThan(0);

    // Apply it for real: add the same contribution row to a fresh clone
    // and confirm the purchase is now funded.
    const applied = structuredClone(state);
    applied.cashflows.contributions.push({
      // to: 43, not 44 — see solveDepositContribution's own header: a
      // contribution dated INTO the purchase year itself hasn't arrived
      // by the July settlement that needs it.
      id: "applied-savings", assetId: "a1", amount: r.value, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 43 },
      indexed: false, owner: "client", label: "Deposit savings",
    });
    const out = projectPlan(applied);
    const f = buildDepositFocus({ out, state: applied, propertyId: "p1" });
    expect(f.answer.onTrack).toBe(true);
  });

  it("never mutates the caller's state", () => {
    const state = mkState({
      assets: [mkAsset({ balance: 5000 })],
      // lvrPct 0 — no loan, so this isolates the deposit-accumulation
      // question from ongoing mortgage-serviceability (a separate
      // question this income-free fixture isn't meant to test).
      properties: [prop({ priceToday: 300000, purchaseAt: { kind: "age", age: 44 }, lvrPct: 0 })],
    });
    const before = JSON.stringify(state);
    solveDepositContribution({ state, propertyId: "p1", assetId: "a1", fromAge: 40 });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("regression: 'funded' means the settlement AND the new loan's own first-year repayments — not the deposit in isolation", () => {
    // A purchase with a real loan (80% LVR) and NO income at all: even
    // once the deposit itself is fully saved, the household still can't
    // service the new mortgage's first year of interest and principal.
    // A metric that only checks "opening balance >= required cash at
    // settlement" would report this as solved; cumulativeUnfundedThroughYear
    // (the actual fix) must not.
    const state = mkState({
      assets: [mkAsset({ balance: 5000 })],
      properties: [prop({ priceToday: 700000, purchaseAt: { kind: "age", age: 45 }, lvrPct: 80 })],
    });
    const r = solveDepositContribution({ state, propertyId: "p1", assetId: "a1", fromAge: 40 });
    // Either it correctly refuses to converge (no contribution amount
    // fixes an income-free household's mortgage serviceability)...
    if (r.converged) {
      // ...or, if it does converge, applying it must ACTUALLY fund the
      // purchase (deposit AND first-year repayments), not just the
      // deposit — this is the exact check that would have caught the bug.
      const applied = structuredClone(state);
      applied.cashflows.contributions.push({
        id: "applied", assetId: "a1", amount: r.value, frequency: "monthly",
        from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 },
        indexed: false, owner: "client", label: "Deposit savings",
      });
      const out = projectPlan(applied);
      const f = buildDepositFocus({ out, state: applied, propertyId: "p1" });
      expect(f.answer.onTrack).toBe(true);
    } else {
      expect(r.value).toBeNull();
    }
  });
});

describe("solveWhenCouldIBuy — When could I buy?", () => {
  it("produces a purchase age that, when applied, results in a funded purchase", () => {
    const state = mkState({
      endAge: 55,
      // Enough ongoing income/expenses that assets genuinely grow year
      // to year (savings accumulate), so a later date is actually better.
      assets: [mkAsset({ balance: 5000, allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" } })],
      cashflows: {
        income: [{
          id: "sal1", label: "Salary", owner: "client", amount: 100000, frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
          indexBasis: "cpi", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
        }],
        expenses: [{
          id: "exp1", label: "Living", category: "nonDiscretionary", amount: 3000, frequency: "monthly",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "cpi", indexExtraPct: 0,
        }],
      },
      properties: [prop({ priceToday: 400000, purchaseAt: { kind: "age", age: 41 }, lvrPct: 80 })],
    });
    const r = solveWhenCouldIBuy({ state, propertyId: "p1" });
    expect(r.converged).toBe(true);
    expect(r.value).toBeGreaterThan(41); // later than the original (underfunded) date

    const applied = structuredClone(state);
    // r.value is already a whole age — the discrete search returns the
    // integer age itself, not a fractional crossing point.
    applied.properties[0].purchaseAt = { kind: "age", age: r.value };
    const out = projectPlan(applied);
    // "A funded purchase" — funded THROUGH the purchase itself, the
    // question this view answers (same check buildDepositFocus's own
    // answer.onTrack makes); not "the whole rest of the plan is
    // shortfall-free forever after", a different question entirely.
    const f = buildDepositFocus({ out, state: applied, propertyId: "p1" });
    expect(f.answer.onTrack).toBe(true);
  });

  it("never mutates the caller's state", () => {
    const state = mkState({
      endAge: 55,
      assets: [mkAsset({ balance: 5000 })],
      cashflows: {
        income: [{
          id: "sal1", label: "Salary", owner: "client", amount: 100000, frequency: "annual",
          from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 },
          indexBasis: "cpi", indexExtraPct: 0, category: "salary", incomeType: "employment", sgApplies: false,
        }],
      },
      properties: [prop({ priceToday: 400000, purchaseAt: { kind: "age", age: 41 }, lvrPct: 80 })],
    });
    const before = JSON.stringify(state);
    solveWhenCouldIBuy({ state, propertyId: "p1" });
    expect(JSON.stringify(state)).toBe(before);
  });
});
