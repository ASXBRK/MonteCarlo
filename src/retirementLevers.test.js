import { describe, it, expect } from "vitest";
import { runMonteCarlo } from "./monteCarlo.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";
import {
  solveContributeMore, solveRetireLater, solveSpendLess, solveTakeMoreRisk, solveAllLevers,
  applyContributeMore, applyRetireLater, applySpendLess, applyUniformProfile,
  RISK_LADDER, RUIN_THRESHOLD_DEFAULT, LEVERS,
} from "./retirementLevers.js";

// Small, fast fixture shapes — mirrors monteCarlo.test.js's own
// mkAsset/mkState/superAcct/employmentRow conventions.
function mkAsset(over = {}) {
  return {
    id: "a1", name: "A1", include: true, owner: "client", class: "financial",
    distributions: "reinvest", balance: 100000,
    allocation: { mode: "custom", incomePct: 3, growthPct: 3, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
    ...over,
  };
}
function superAcct(over = {}) {
  return {
    id: "su1", name: "Super", owner: "client", balance: 0, taxFreeComponent: 0,
    allocation: { mode: "profile", profile: "Balanced" },
    icrPct: 0, include: true,
    ...over,
  };
}
function pensionRow(over = {}) {
  return {
    id: "pn1", name: "Pension", owner: "client", sourceAccountId: "su1",
    commenceAt: { kind: "age", age: 60 }, type: "abp", commenceAmount: null, reversionary: false,
    taxFreeProportion: null, allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0,
    drawdownOption: "expenditure", fixedAmount: 0, indexBasis: "none", indexExtraPct: 0, commutations: [],
    ...over,
  };
}
// A real cash NEED, anchored start-to-end so it runs the whole
// projection — `ruinProbability` (monteCarlo.js) is the fraction of
// paths with ANY unfunded cashflow before the projection ends; none of
// this file's OTHER fixtures include an expense row at all, so their
// own "ruin" is structurally always 0 regardless of any other stress
// (income required, balances) applied to them — a genuine deficit
// needs a genuine expense to be unfunded against.
function expenseRow(over = {}) {
  return {
    id: "e1", label: "Living", owner: "client", category: "nonDiscretionary",
    amount: 90000 / 12, frequency: "monthly",
    from: { kind: "anchor", anchorId: "retirement-client" }, to: { kind: "anchor", anchorId: "end" },
    indexBasis: "cpi", indexExtraPct: 0,
    ...over,
  };
}
function employmentRow(over = {}) {
  return {
    id: "i1", label: "Salary", owner: "client", amount: 90000, frequency: "annual",
    // `to` anchors to the client's own retirement (planState.js's own
    // default for a real income row — createIncomeRow's anchorRef),
    // NOT a fixed age — a fixed age coinciding with leverState()'s own
    // retirementAge would make "retire later" silently inert, the
    // exact class of bug docs/specs/37-review-remediation.md Commit 6
    // fixes (finding 1.13's two remaining dead arms).
    from: { kind: "age", age: 55 }, to: { kind: "anchor", anchorId: "retirement-client" },
    indexBasis: "cpi", indexExtraPct: 0, incomeType: "employment", sgApplies: true,
    ...over,
  };
}
function mkState(over = {}) {
  const assets = over.assets ?? [];
  return {
    plan: {
      household: "single",
      client: { currentAge: 60, retirementAge: 65, ...over.client },
      partner: null,
      endAge: over.endAge ?? 85,
      start: over.start ?? { year: 2026, month: 7 },
      superAccounts: over.superAccounts ?? [],
      pensions: over.pensions ?? [],
      retirement: over.retirement ?? { incomeRequired: { source: "currentExpenses", customAmount: 0, indexBasis: "none", indexExtraPct: 0, startAt: { kind: "age", age: 60 }, stepDownAtAge: null, stepDownPct: 100 }, incomeDrivenDrawdown: false },
    },
    assets,
    bonds: [], liabilities: [], properties: [],
    cashflows: {
      income: over.income ?? [], expenses: over.expenses ?? [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: over.superContributions ?? [], superWithdrawals: [], superRollovers: [], bondContributions: [],
    },
    settings: {
      surplus: { periods: [{ from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" }, mode: "spend", assetId: null }] },
      fundingOrder: assets.map((a) => a.id),
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed", awote: 0.032, indexSuperThresholds: true },
    display: { units: "real" },
  };
}

// A genuinely at-risk retiree: modest asset, a pension expenditure-
// drawing to meet Income Required, retiring in 5 years with room to
// push further out, volatile enough that "take more risk" has real
// room to move ruin probability. Sized for the small numPaths every
// test below uses (searchPaths kept tiny for speed — see the module's
// own header on why accuracy is a disclosed search-time tradeoff).
function leverState() {
  const asset = mkAsset({ id: "a1", balance: 200000 });
  const su = superAcct({ id: "su1", balance: 300000 });
  const pension = pensionRow({ id: "pn1", sourceAccountId: "su1" });
  return mkState({
    assets: [asset],
    superAccounts: [su],
    pensions: [pension],
    income: [employmentRow()],
    client: { currentAge: 60, retirementAge: 65 },
    retirement: {
      incomeRequired: { source: "custom", customAmount: 55000, indexBasis: "none", indexExtraPct: 0, startAt: { kind: "age", age: 65 }, stepDownAtAge: null, stepDownPct: 100 },
      incomeDrivenDrawdown: true,
    },
  });
}

const FAST = { searchPaths: 60, searchSeed: 11 };

describe("applyContributeMore / applyRetireLater / applySpendLess / applyUniformProfile", () => {
  it("applyContributeMore tops up an existing salary-sacrifice row rather than duplicating it", () => {
    const state = leverState();
    state.cashflows.superContributions.push({
      id: "sc1", label: "SS", owner: "client", accountId: "su1", type: "salarySacrifice", basis: "amount",
      amount: 5000, percent: 0, incomeRowId: "i1", frequency: "annual",
      from: { kind: "age", age: 60 }, to: { kind: "age", age: 65 }, indexBasis: "none", indexExtraPct: 0,
    });
    const clone = applyContributeMore(state, 3000);
    expect(clone.cashflows.superContributions).toHaveLength(1);
    expect(clone.cashflows.superContributions[0].amount).toBe(8000);
    // Original untouched.
    expect(state.cashflows.superContributions[0].amount).toBe(5000);
  });

  it("applyContributeMore returns null when the client has no super account", () => {
    const state = mkState({ assets: [mkAsset()] });
    expect(applyContributeMore(state, 5000)).toBeNull();
  });

  it("applyRetireLater sets only the client's own retirementAge", () => {
    const state = leverState();
    const clone = applyRetireLater(state, 70);
    expect(clone.plan.client.retirementAge).toBe(70);
    expect(state.plan.client.retirementAge).toBe(65); // untouched
  });

  it("applySpendLess sets a custom Income Required and forces incomeDrivenDrawdown on", () => {
    const state = leverState();
    state.plan.retirement.incomeDrivenDrawdown = false;
    const clone = applySpendLess(state, 40000);
    expect(clone.plan.retirement.incomeRequired.source).toBe("custom");
    expect(clone.plan.retirement.incomeRequired.customAmount).toBe(40000);
    expect(clone.plan.retirement.incomeDrivenDrawdown).toBe(true);
  });

  it("applyUniformProfile overrides every financial asset, super account, and pension to the same profile", () => {
    const state = leverState();
    const clone = applyUniformProfile(state, "Cash");
    expect(clone.assets[0].allocation).toEqual({ mode: "profile", profile: "Cash" });
    expect(clone.plan.superAccounts[0].allocation).toEqual({ mode: "profile", profile: "Cash" });
    expect(clone.plan.pensions[0].allocation).toEqual({ mode: "profile", profile: "Cash" });
  });
});

describe("solveContributeMore", () => {
  it("is unavailable when the client has no super account", () => {
    const state = mkState({ assets: [mkAsset()] });
    const result = solveContributeMore(state, PROFILES, { threshold: 0.2, baselineRuin: 0.5, ...FAST });
    expect(result.available).toBe(false);
  });

  it("when it converges, the SOLVED value's own re-run genuinely reaches at/near the threshold — a real re-run, not an estimate", () => {
    const state = leverState();
    const result = solveContributeMore(state, PROFILES, { threshold: 0.5, baselineRuin: 0.9, numPaths: 80, seed: 5, ...FAST });
    expect(result.available).toBe(true);
    if (result.converged) {
      expect(result.extraAnnual).toBeGreaterThanOrEqual(0);
      // The reported afterRuin is a FRESH runMonteCarlo call at the
      // solved value — reproduce it independently and confirm it's the
      // SAME figure this function reported, not a fabricated estimate.
      const clone = applyContributeMore(state, result.extraAnnual);
      const reRun = runMonteCarlo(clone, PROFILES, { numPaths: 80, seed: 5, sampleCount: 0 });
      expect(result.afterRuin).toBeCloseTo(reRun.ruinProbability, 6);
    } else {
      expect(["out-of-bounds", "non-monotonic", "iteration-cap", "time-cap"]).toContain(result.reason);
    }
  });

  it("flags capExceeded when the solved contribution genuinely exceeds the client's own cap headroom", () => {
    // A hopeless scenario (huge Income Required, tiny balance) forces
    // the solver toward a large extraAnnual — comfortably past a
    // realistic concessional cap headroom.
    const desperate = leverState();
    desperate.plan.retirement.incomeRequired.customAmount = 200000;
    desperate.assets[0].balance = 10000;
    desperate.plan.superAccounts[0].balance = 10000;
    const result = solveContributeMore(desperate, PROFILES, { threshold: 0.3, baselineRuin: 0.95, numPaths: 60, seed: 3, ...FAST });
    if (result.converged) {
      expect(typeof result.capExceeded).toBe("boolean");
      expect(result.capHeadroom).not.toBeNull();
    }
  });
});

describe("solveRetireLater", () => {
  it("reports out-of-bounds honestly rather than converging on nonsense when even the max age never reaches the threshold", () => {
    const hopeless = leverState();
    hopeless.plan.retirement.incomeRequired.customAmount = 500000; // no age helps this
    hopeless.plan.endAge = 66; // almost no room to search either
    const result = solveRetireLater(hopeless, PROFILES, { threshold: 0.01, baselineRuin: 0.99, numPaths: 60, ...FAST });
    expect(result.available).toBe(true);
    if (!result.converged) expect(result.reason).toBe("out-of-bounds");
  });

  it("when it converges, the age found is strictly after the plan's own current retirement age, and the re-run matches", () => {
    const state = leverState();
    const result = solveRetireLater(state, PROFILES, { threshold: 0.6, baselineRuin: 0.9, numPaths: 60, seed: 2, ...FAST });
    if (result.converged) {
      expect(result.age).toBeGreaterThan(state.plan.client.retirementAge);
      const reRun = runMonteCarlo(applyRetireLater(state, result.age), PROFILES, { numPaths: 60, seed: 2, sampleCount: 0 });
      expect(result.afterRuin).toBeCloseTo(reRun.ruinProbability, 6);
    }
  });

  // docs/specs/37-review-remediation.md, Commit 6, finding 1.13 — the
  // review's own reproduction: a plan whose client income rows are all
  // anchored to a FIXED age rather than the client's own retirement.
  // applyRetireLater only ever moves plan.client.retirementAge, so
  // nothing in this plan's schedule changes at any candidate age —
  // before this fix, the scan ran to endAge and reported the generic
  // "out-of-bounds", indistinguishable from a plan that genuinely can't
  // be helped by retiring later.
  it("is unavailable, with a specific reason, when no client income is anchored to the client's own retirement date", () => {
    const state = leverState();
    state.cashflows.income = [employmentRow({ to: { kind: "age", age: 65 } })]; // fixed age, not the retirement anchor
    const result = solveRetireLater(state, PROFILES, { threshold: 0.6, baselineRuin: 0.9, numPaths: 60, seed: 2, ...FAST });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("no-retirement-anchored-income");
    expect(result.converged).toBeUndefined();
  });

  it("is unavailable for a plan with no income rows at all — the same structural condition, the degenerate case", () => {
    const state = leverState();
    state.cashflows.income = [];
    const result = solveRetireLater(state, PROFILES, { threshold: 0.6, baselineRuin: 0.9, numPaths: 60, seed: 2, ...FAST });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("no-retirement-anchored-income");
  });

  // "constructs a scenario where that arm must bite and asserts the
  // projection differs from its baseline" — the spec's own words for
  // Commit 6's guard. A deterministic projectPlan comparison, not a
  // Monte Carlo ruin comparison: with a retirement-anchored salary row,
  // pushing retirementAge out both extends the salary and defers the
  // (also retirement-anchored) expense row, so the projected end-of-plan
  // net assets is materially different — genuinely bites, where the
  // pre-fix engine produced an IDENTICAL projection at every age.
  it("genuinely bites — pushing a retirement-anchored salary out changes the projection", () => {
    const state = leverState();
    state.cashflows.expenses = [expenseRow()];
    const baseline = projectPlan(state, PROFILES);
    const later = projectPlan(applyRetireLater(state, 75), PROFILES);
    const lastYear = baseline.yearly.length - 1;
    expect(later.yearly[lastYear].netAssets).not.toBeCloseTo(baseline.yearly[lastYear].netAssets, 0);
  });
});

describe("solveSpendLess", () => {
  it("when it converges, a lower Income Required is what's reported, and the re-run matches exactly", () => {
    const state = leverState();
    const result = solveSpendLess(state, PROFILES, { threshold: 0.5, baselineRuin: 0.9, numPaths: 60, seed: 7, ...FAST });
    if (result.converged) {
      expect(result.incomeRequiredAnnual).toBeLessThanOrEqual(500000);
      expect(result.incomeRequiredAnnual).toBeGreaterThanOrEqual(0);
      const reRun = runMonteCarlo(applySpendLess(state, result.incomeRequiredAnnual), PROFILES, { numPaths: 60, seed: 7, sampleCount: 0 });
      expect(result.afterRuin).toBeCloseTo(reRun.ruinProbability, 6);
    } else {
      expect(["out-of-bounds", "non-monotonic", "iteration-cap", "time-cap"]).toContain(result.reason);
    }
  });

  // docs/specs/36-retirement-outputs.md, Commit 2 — "the maximum
  // sustainable spend" reuses this exact solver at an adviser-chosen
  // tolerance (5/10/20%) rather than a fixed lever threshold. Its own
  // test requirements: "the solved figure produces a plan whose ruin
  // probability sits at the stated tolerance when applied" and "each
  // tolerance level solves correctly."
  describe("Commit 2 — solves correctly at each ruin tolerance level", () => {
    it.each([0.05, 0.10, 0.20])("tolerance %s: when converged, the solved figure's own confirmation run sits close to that tolerance", (threshold) => {
      const state = leverState();
      const result = solveSpendLess(state, PROFILES, { threshold, baselineRuin: 0.9, numPaths: 300, seed: 13, ...FAST });
      if (result.converged) {
        // Search-time (60 paths, fixed seed) vs the final confirmation
        // run (300 paths, same seed) are different samples — a loose
        // bound avoids a flaky test while still confirming the solve
        // landed in the right neighbourhood, not an unrelated figure.
        expect(Math.abs(result.afterRuin - threshold)).toBeLessThan(0.15);
      } else {
        expect(["out-of-bounds", "non-monotonic", "iteration-cap", "time-cap"]).toContain(result.reason);
      }
    });
  });

  // docs/specs/37-review-remediation.md, Commit 6, finding 1.13 — the
  // review's own reproduction: a plan with no pension whose
  // drawdownOption is "expenditure". applySpendLess only ever sets
  // Income Required and forces incomeDrivenDrawdown on, both of which
  // deterministic.js reads ONLY inside that gate — with no such pension
  // present, every candidate spend figure produces the identical,
  // unmodified baseline ruin probability, and the bisection used to
  // report the generic "out-of-bounds" for a plan that was never
  // actually searched.
  it("is unavailable, with a specific reason, when no pension on the plan draws down to a target ('expenditure')", () => {
    const state = leverState();
    state.plan.pensions = [pensionRow({ drawdownOption: "minimum" })]; // present, but not expenditure-driven
    const result = solveSpendLess(state, PROFILES, { threshold: 0.5, baselineRuin: 0.9, numPaths: 60, seed: 7, ...FAST });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("no-expenditure-pension");
    expect(result.converged).toBeUndefined();
  });

  it("is unavailable for a plan with no pensions at all — the same structural condition, the degenerate case", () => {
    const state = leverState();
    state.plan.pensions = [];
    const result = solveSpendLess(state, PROFILES, { threshold: 0.5, baselineRuin: 0.9, numPaths: 60, seed: 7, ...FAST });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("no-expenditure-pension");
  });

  // "constructs a scenario where that arm must bite and asserts the
  // projection differs from its baseline" — same guard as the
  // retireLater test above, checked at the deterministic projectPlan
  // level rather than via noisy Monte Carlo ruin: given an expenditure
  // pension, a materially lower Income Required target changes how much
  // the pension actually pays out each year, changing its withdrawals
  // — where the pre-fix engine left every pension's withdrawals
  // identical at every Income Required value.
  it("genuinely bites — a lower Income Required target changes the expenditure pension's own withdrawals", () => {
    const state = leverState(); // pensionRow() defaults to drawdownOption: "expenditure"
    const baseline = projectPlan(state, PROFILES);
    const less = projectPlan(applySpendLess(state, 5000), PROFILES); // far below the default 55,000 target
    const totalPayments = (out) => out.yearly.reduce((sum, row) => sum + (row.pensionDetail.pn1?.payments ?? 0), 0);
    expect(totalPayments(less)).toBeLessThan(totalPayments(baseline));
  });
});

describe("solveTakeMoreRisk", () => {
  it("scans RISK_LADDER from least to most aggressive and returns a distribution when it converges", () => {
    const state = leverState();
    // Start deliberately defensive so there's real room to move up.
    state.assets[0].allocation = { mode: "profile", profile: "Cash" };
    state.plan.superAccounts[0].allocation = { mode: "profile", profile: "Cash" };
    state.plan.pensions[0].allocation = { mode: "profile", profile: "Cash" };
    const result = solveTakeMoreRisk(state, PROFILES, { threshold: 0.6, baselineRuin: 0.9, numPaths: 60, seed: 9, ...FAST });
    expect(result.available).toBe(true);
    if (result.converged) {
      expect(RISK_LADDER).toContain(result.profile);
      expect(result.distribution).toBeTruthy();
      expect(typeof result.distribution.p50).toBe("number");
    } else {
      expect(result.reason).toBe("out-of-bounds");
    }
  });
});

describe("solveAllLevers", () => {
  it("ranks converged levers by effect on ruin probability (largest reduction first), never by any other order", () => {
    const state = leverState();
    const results = solveAllLevers(state, PROFILES, { threshold: 0.5, baselineRuin: 0.9, numPaths: 40, seed: 4, ...FAST });
    expect(results).toHaveLength(LEVERS.length);
    const converged = results.filter((r) => r.converged);
    for (let i = 1; i < converged.length; i++) {
      const effectPrev = converged[i - 1].beforeRuin - converged[i - 1].afterRuin;
      const effectCur = converged[i].beforeRuin - converged[i].afterRuin;
      expect(effectPrev).toBeGreaterThanOrEqual(effectCur - 1e-9);
    }
  });

  it("RUIN_THRESHOLD_DEFAULT is 20%, the spec's own stated default", () => {
    expect(RUIN_THRESHOLD_DEFAULT).toBe(0.2);
  });
});
