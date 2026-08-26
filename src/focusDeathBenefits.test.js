import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { alternativeNominations, buildRecontributionFocus } from "./focusDeathBenefits.js";

// Minimal v3-shaped state factory — mirrors focusSalarySacrifice.test.js's
// own (kept separate, not shared, per that file's header).
function mkAsset(over = {}) {
  return {
    id: "a1", name: "Savings", include: true, owner: "client",
    distributions: "reinvest", balance: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}

function superAcct(over = {}) {
  return {
    id: "su1", name: "Super", owner: "client", balance: 0, taxFreeComponent: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, include: true,
    ...over,
  };
}

function swRow(over = {}) {
  return {
    id: "sw1", label: "Withdrawal", owner: "client", accountId: "su1",
    amount: 0, frequency: "annual",
    from: { kind: "age", age: 61 }, to: { kind: "age", age: 61 },
    indexBasis: "none", indexExtraPct: 0,
    ...over,
  };
}

function scRow(over = {}) {
  return {
    id: "sc1", label: "Re-contribution", owner: "client", accountId: "su1",
    type: "personalNonDeductible", basis: "amount", amount: 0, percent: 0, incomeRowId: null,
    frequency: "annual", from: { kind: "age", age: 61 }, to: { kind: "age", age: 61 },
    indexBasis: "none", indexExtraPct: 0,
    ...over,
  };
}

function mkState(over = {}) {
  const assets = over.assets ?? [];
  return {
    plan: {
      household: "single",
      client: { currentAge: 61, retirementAge: 60, ...over.client },
      partner: null,
      endAge: over.endAge ?? 63,
      start: { year: 2026, month: 7 },
      superAccounts: over.superAccounts ?? [],
      pensions: [], gifts: [],
      workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
      ...over.plan,
    },
    assets,
    goals: [],
    liabilities: [],
    properties: [],
    cashflows: {
      income: [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: [], superWithdrawals: [],
      ...over.cashflows,
    },
    settings: {
      surplus: { mode: "accumulate", assetId: null },
      fundingOrder: assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("alternativeNominations (spec 22, Commit 3)", () => {
  it("returns null when there's no death benefit detail at all", () => {
    expect(alternativeNominations(null)).toBeNull();
  });

  it("each alternative's own tax reconciles EXACTLY to a real projection actually nominating that relationship", () => {
    const base = mkState({
      plan: { superAccounts: [superAcct({ balance: 300000, taxFreeComponent: 60000 })] },
    });
    for (const relationship of ["spouse", "adultChild", "minorChild", "interdependent", "financialDependant", "estate"]) {
      const s = {
        ...base,
        plan: {
          ...base.plan,
          client: { ...base.plan.client, deathBenefit: { beneficiaries: [{ id: "b1", label: "B", relationship, sharePct: 100 }] } },
        },
      };
      const out = projectPlan(s);
      const detail = out.yearly[out.yearly.length - 1].deathBenefitDetail.client;
      const alternatives = alternativeNominations(detail);
      const match = alternatives.find((a) => a.relationship === relationship);
      expect(match.tax).toBeCloseTo(detail.totals.tax, 2);
      expect(match.gross).toBeCloseTo(detail.totals.gross, 2);
      expect(match.net).toBeCloseTo(detail.totals.net, 2);
    }
  });

  it("an adult child costs strictly more tax than a spouse, on the identical underlying balance", () => {
    const s = mkState({
      plan: {
        superAccounts: [superAcct({ balance: 300000, taxFreeComponent: 60000 })],
        client: { currentAge: 61, retirementAge: 60, deathBenefit: { beneficiaries: [{ id: "b1", label: "B", relationship: "spouse", sharePct: 100 }] } },
      },
    });
    const out = projectPlan(s);
    const detail = out.yearly[out.yearly.length - 1].deathBenefitDetail.client;
    const alternatives = alternativeNominations(detail);
    const spouse = alternatives.find((a) => a.relationship === "spouse");
    const adultChild = alternatives.find((a) => a.relationship === "adultChild");
    expect(spouse.tax).toBe(0);
    expect(adultChild.tax).toBeGreaterThan(0);
    expect(adultChild.gross).toBeCloseTo(spouse.gross, 6); // same underlying balance either way
  });
});

describe("buildRecontributionFocus (spec 22, Commit 3)", () => {
  it("returns null when the nominated withdrawal/contribution isn't actually in the plan — never fabricates one", () => {
    const s = mkState({
      plan: {
        superAccounts: [superAcct({ balance: 300000 })],
        client: { currentAge: 61, retirementAge: 60, deathBenefit: { beneficiaries: [{ id: "b1", label: "B", relationship: "adultChild", sharePct: 100 }] } },
      },
    });
    expect(buildRecontributionFocus({ state: s, owner: "client", withdrawalId: "nonexistent", contributionId: "nonexistent" })).toBeNull();
  });

  it("reflects an actually-modelled re-contribution (real withdrawal + NCC rows), not a synthetic estimate — tax is lower WITH it than without", () => {
    const s = mkState({
      plan: {
        superAccounts: [superAcct({ balance: 300000, taxFreeComponent: 0 })],
        client: { currentAge: 61, retirementAge: 60, deathBenefit: { beneficiaries: [{ id: "b1", label: "B", relationship: "adultChild", sharePct: 100 }] } },
      },
      cashflows: {
        superWithdrawals: [swRow({ amount: 100000 })],
        superContributions: [scRow({ amount: 100000 })],
      },
    });
    const result = buildRecontributionFocus({ state: s, owner: "client", withdrawalId: "sw1", contributionId: "sc1" });
    expect(result).not.toBeNull();
    expect(result.hasNonDependant).toBe(true);
    expect(result.cannotHelp).toBe(false);
    // The re-contribution converts taxable component to tax-free —
    // less tax WITH it modelled than without it.
    expect(result.withTax).toBeLessThan(result.withoutTax);
    expect(result.taxSaved).toBeGreaterThan(0);
  });

  it('the "cannot help" flag fires when every beneficiary is a tax dependant — even though the rows are genuinely modelled', () => {
    const s = mkState({
      plan: {
        superAccounts: [superAcct({ balance: 300000, taxFreeComponent: 0 })],
        client: { currentAge: 61, retirementAge: 60, deathBenefit: { beneficiaries: [{ id: "b1", label: "Spouse", relationship: "spouse", sharePct: 100 }] } },
      },
      cashflows: {
        superWithdrawals: [swRow({ amount: 100000 })],
        superContributions: [scRow({ amount: 100000 })],
      },
    });
    const result = buildRecontributionFocus({ state: s, owner: "client", withdrawalId: "sw1", contributionId: "sc1" });
    expect(result.hasNonDependant).toBe(false);
    expect(result.cannotHelp).toBe(true);
    // Tax is (correctly) zero either way — a dependant is NANE regardless.
    expect(result.withTax).toBe(0);
    expect(result.withoutTax).toBe(0);
    expect(result.taxSaved).toBe(0);
  });
});
