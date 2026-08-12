import { describe, it, expect } from "vitest";
import {
  SCHEMA_VERSION, defaultState, createAsset, createCashflow,
  createLumpSum, createIncomeRow, createExpenseRow,
  clampPlan, clampAllToPlan, clampAllocation, clampIncomeRow,
  nearestVolBasis, allocationTotalNominal, allocationSummary,
  normaliseFundingOrder, normaliseSettings,
  partnerOwnedItems, reassignPartnerToClient, deletePartnerOwned,
  removeAsset, ownerWindow, fyLabelForAge, horizonYears,
  serialize, hydrate, summarise, planSummaryText, annualisedAmount,
  tableLumpSumFor, upsertTableLumpSum, canEditOneOffYear, clampTaxProfile,
} from "./planState.js";
import { PROFILES } from "./profiles.js";

const PROFILE_KEYS = Object.keys(PROFILES);
const NOW = new Date("2026-08-12");

function couplePlan() {
  return {
    household: "couple",
    client: { currentAge: 40 },
    partner: { currentAge: 36 },
    endAge: 90,
    start: { year: 2026, month: 8 },
  };
}

describe("defaults (v3)", () => {
  it("produces a valid default state", () => {
    const s = defaultState(PROFILES, NOW);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.plan.household).toBe("single");
    expect(s.plan.client.currentAge).toBe(40);
    expect(s.plan.partner).toBeNull();
    expect(s.plan.start).toEqual({ year: 2026, month: 8 });
    expect(s.assets).toHaveLength(1);
    expect(s.assets[0].owner).toBe("client");
    expect(s.assets[0].distributions).toBe("reinvest");
    expect(s.cashflows.income).toEqual([]);
    expect(s.cashflows.expenses).toEqual([]);
    expect(s.cashflows.contributions).toHaveLength(1);
    expect(s.cashflows.contributions[0].assetId).toBe(s.assets[0].id);
    expect(s.settings.surplus).toEqual({ mode: "spend", assetId: null });
    expect(s.settings.fundingOrder).toEqual([s.assets[0].id]);
  });

  it("income/expense factories default sensibly", () => {
    const plan = couplePlan();
    const inc = createIncomeRow(plan, []);
    expect(inc.owner).toBe("client");
    expect(inc.frequency).toBe("annual");
    expect(inc.fromAge).toBe(40);
    expect(inc.toAge).toBe(90);
    const exp = createExpenseRow(plan, [inc]);
    expect(exp.label).toBe("Expense 2");
  });
});

describe("owner windows + FY labels", () => {
  it("partner window spans the same number of plan years from their own age", () => {
    const plan = couplePlan(); // client 40→90 (50y), partner 36
    expect(horizonYears(plan)).toBe(50);
    expect(ownerWindow(plan, "client")).toEqual({ from: 40, to: 90 });
    expect(ownerWindow(plan, "partner")).toEqual({ from: 36, to: 86 });
  });

  it("FY labels derive from the 1-July tick convention", () => {
    const plan = couplePlan(); // start Aug 2026 → first 1 July is 2027
    // Client is 40 now: current FY is the one that began July 2026.
    expect(fyLabelForAge(plan, "client", 40)).toBe("FY 2026–27");
    expect(fyLabelForAge(plan, "client", 41)).toBe("FY 2027–28");
    expect(fyLabelForAge(plan, "client", 65)).toBe("FY 2051–52");
    // Partner ages tick alongside from their own current age.
    expect(fyLabelForAge(plan, "partner", 36)).toBe("FY 2026–27");
    expect(fyLabelForAge(plan, "partner", 65)).toBe("FY 2055–56");
  });

  it("start month before July shifts the first tick to the same year", () => {
    const plan = { ...couplePlan(), start: { year: 2026, month: 3 } };
    // March 2026 start → first 1 July is 2026 → current FY began July 2025.
    expect(fyLabelForAge(plan, "client", 40)).toBe("FY 2025–26");
    expect(fyLabelForAge(plan, "client", 41)).toBe("FY 2026–27");
  });

  it("clampIncomeRow anchors to the owner window and demotes orphan partners", () => {
    const plan = couplePlan();
    const row = { id: "x", owner: "partner", amount: 1, frequency: "annual", fromAge: 30, toAge: 99, indexed: true };
    const out = clampIncomeRow(row, plan);
    expect(out.fromAge).toBe(36);
    expect(out.toAge).toBe(86);
    const single = clampPlan({ ...plan, household: "single", partner: null });
    const demoted = clampIncomeRow(row, single);
    expect(demoted.owner).toBe("client");
  });
});

describe("fundingOrder invariants", () => {
  it("normalises order to exactly the included assets", () => {
    const a = { id: "a", include: true };
    const b = { id: "b", include: true };
    const c = { id: "c", include: false };
    // Unknown id dropped, excluded dropped, missing included appended.
    expect(normaliseFundingOrder(["zz", "b", "c"], [a, b, c])).toEqual(["b", "a"]);
    // Re-including appends at the end.
    c.include = true;
    expect(normaliseFundingOrder(["b", "a"], [a, b, c])).toEqual(["b", "a", "c"]);
  });

  it("surplus invest mode resets to spend when its target is invalid", () => {
    const assets = [{ id: "a", include: true }, { id: "b", include: false }];
    expect(normaliseSettings({ surplus: { mode: "invest", assetId: "a" }, fundingOrder: [] }, assets).surplus)
      .toEqual({ mode: "invest", assetId: "a" });
    expect(normaliseSettings({ surplus: { mode: "invest", assetId: "b" }, fundingOrder: [] }, assets).surplus)
      .toEqual({ mode: "spend", assetId: null });
    expect(normaliseSettings({ surplus: { mode: "invest", assetId: "gone" }, fundingOrder: [] }, assets).surplus)
      .toEqual({ mode: "spend", assetId: null });
  });

  it("removeAsset cascades cashflows, funding order, and surplus target", () => {
    const s = defaultState(PROFILES, NOW);
    const a2 = createAsset(s.plan, s.assets, PROFILES);
    s.assets.push(a2);
    s.settings = normaliseSettings({ surplus: { mode: "invest", assetId: a2.id }, fundingOrder: s.settings.fundingOrder }, s.assets);
    s.cashflows.withdrawals.push(createCashflow("withdrawal", s.plan, a2.id));

    const out = removeAsset(s, a2.id);
    expect(out.assets).toHaveLength(1);
    expect(out.cashflows.withdrawals).toHaveLength(0);
    expect(out.settings.fundingOrder).toEqual([s.assets[0].id]);
    expect(out.settings.surplus).toEqual({ mode: "spend", assetId: null });
  });

  it("never removes the last asset", () => {
    const s = defaultState(PROFILES, NOW);
    expect(removeAsset(s, s.assets[0].id)).toBe(s);
  });
});

describe("household transitions", () => {
  function coupleState() {
    const s = defaultState(PROFILES, NOW);
    s.plan = couplePlan();
    const pa = createAsset(s.plan, s.assets, PROFILES);
    pa.owner = "partner";
    const ja = createAsset(s.plan, [...s.assets, pa], PROFILES);
    ja.owner = "joint";
    s.assets.push(pa, ja);
    s.settings = normaliseSettings(s.settings, s.assets);
    const inc = createIncomeRow(s.plan, []);
    inc.owner = "partner";
    inc.fromAge = 36; inc.toAge = 65;
    s.cashflows.income.push(inc);
    return { s, pa, ja };
  }

  it("partnerOwnedItems finds partner and joint holdings", () => {
    const { s } = coupleState();
    const found = partnerOwnedItems(s);
    expect(found.assets).toHaveLength(2); // partner + joint
    expect(found.income).toHaveLength(1);
    expect(found.count).toBe(3);
  });

  it("reassignPartnerToClient keeps numeric ages and re-derives ownership", () => {
    const { s } = coupleState();
    const out = reassignPartnerToClient(s);
    expect(out.assets.every((a) => a.owner === "client")).toBe(true);
    expect(out.cashflows.income[0].owner).toBe("client");
    expect(out.cashflows.income[0].fromAge).toBe(36); // numeric ages kept
  });

  it("deletePartnerOwned cascades through cashflows and settings", () => {
    const { s, pa } = coupleState();
    s.cashflows.contributions.push(createCashflow("contribution", s.plan, pa.id));
    const out = deletePartnerOwned(s);
    expect(out.assets).toHaveLength(1);
    expect(out.assets[0].owner).toBe("client");
    expect(out.cashflows.income).toHaveLength(0);
    expect(out.cashflows.contributions.every((c) => c.assetId !== pa.id)).toBe(true);
    expect(out.settings.fundingOrder).toEqual([out.assets[0].id]);
  });
});

describe("migration", () => {
  it("migrates a v1 blob (asset-owned cashflows, startYear)", () => {
    const v1 = {
      schemaVersion: 1,
      plan: { currentAge: 45, endAge: 85, startYear: 2025 },
      assets: [{
        id: "as-old", name: "Legacy", include: true, balance: 50000,
        allocation: { mode: "profile", profile: "Balanced" },
        icrPct: 0.3, cgtAsset: true, costBase: 40000,
        contributions: [{ id: "c1", amount: 500, frequency: "monthly", fromAge: 45, toAge: 65, indexed: true }],
        withdrawals: [],
        lumpSums: [{ id: "l1", amount: 10000, direction: "in", age: 50, source: "input" }],
      }],
      display: { units: "nominal" },
      assumptions: { cpi: 0.03 },
    };
    const s = hydrate(JSON.stringify(v1), PROFILES);
    expect(s).not.toBeNull();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.plan.household).toBe("single");
    expect(s.plan.client.currentAge).toBe(45);
    expect(s.plan.start).toEqual({ year: 2025, month: 7 });
    expect(s.assets[0].owner).toBe("client");
    expect(s.assets[0].distributions).toBe("reinvest");
    expect(s.cashflows.contributions).toHaveLength(1);
    expect(s.cashflows.contributions[0].assetId).toBe("as-old");
    expect(s.cashflows.lumpSums[0].assetId).toBe("as-old");
    expect(s.settings.fundingOrder).toEqual(["as-old"]);
    expect(s.display.units).toBe("nominal");
    expect(s.assumptions.cpi).toBe(0.03);
  });

  it("migrates a v2 blob (central cashflows, flat plan ages)", () => {
    const v2 = {
      schemaVersion: 2,
      plan: { currentAge: 40, endAge: 90, start: { year: 2026, month: 8 } },
      assets: [
        { id: "a1", name: "Cash", include: true, balance: 20000, allocation: { mode: "profile", profile: "Cash" }, icrPct: 0, cgtAsset: false, costBase: null },
        { id: "a2", name: "Shares", include: false, balance: 80000, allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0.2, cgtAsset: true, costBase: 60000 },
      ],
      cashflows: {
        contributions: [{ id: "c1", assetId: "a2", amount: 1000, frequency: "monthly", fromAge: 40, toAge: 65, indexed: true }],
        withdrawals: [],
        lumpSums: [],
      },
      display: { units: "real" },
      assumptions: { cpi: 0.025 },
    };
    const s = hydrate(JSON.stringify(v2), PROFILES);
    expect(s).not.toBeNull();
    expect(s.plan.client.currentAge).toBe(40);
    expect(s.assets.map((a) => a.owner)).toEqual(["client", "client"]);
    expect(s.cashflows.income).toEqual([]);
    expect(s.cashflows.expenses).toEqual([]);
    // fundingOrder = included assets only (a2 is excluded).
    expect(s.settings.fundingOrder).toEqual(["a1"]);
    expect(s.settings.surplus).toEqual({ mode: "spend", assetId: null });
  });

  it("rejects garbage and unknown versions", () => {
    expect(hydrate("not json", PROFILES)).toBeNull();
    expect(hydrate("{}", PROFILES)).toBeNull();
    expect(hydrate(JSON.stringify({ schemaVersion: 99, plan: {}, assets: [{}] }), PROFILES)).toBeNull();
  });
});

describe("persistence round-trip (v3)", () => {
  it("preserves household, ownership, income/expenses, and settings", () => {
    const s = defaultState(PROFILES, NOW);
    s.plan = couplePlan();
    const a2 = createAsset(s.plan, s.assets, PROFILES);
    a2.owner = "joint";
    a2.distributions = "cash";
    s.assets.push(a2);
    s.settings = normaliseSettings({
      surplus: { mode: "invest", assetId: a2.id },
      fundingOrder: [a2.id, s.assets[0].id],
    }, s.assets);

    const inc = createIncomeRow(s.plan, []);
    inc.owner = "partner"; inc.amount = 90000; inc.fromAge = 36; inc.toAge = 65;
    s.cashflows.income.push(inc);
    const exp = createExpenseRow(s.plan, []);
    exp.amount = 60000; exp.label = "Living expenses";
    s.cashflows.expenses.push(exp);

    const back = hydrate(serialize(s), PROFILES);
    expect(back).not.toBeNull();
    expect(back.plan.household).toBe("couple");
    expect(back.plan.partner.currentAge).toBe(36);
    expect(back.assets[1]).toMatchObject({ owner: "joint", distributions: "cash" });
    expect(back.settings.surplus).toEqual({ mode: "invest", assetId: a2.id });
    expect(back.settings.fundingOrder).toEqual([a2.id, s.assets[0].id]);
    expect(back.cashflows.income[0]).toMatchObject({ owner: "partner", amount: 90000, fromAge: 36, toAge: 65 });
    expect(back.cashflows.expenses[0]).toMatchObject({ label: "Living expenses", amount: 60000 });
  });

  it("single households strip partner/joint owners on hydrate", () => {
    const s = defaultState(PROFILES, NOW);
    // Corrupt: single household but a joint asset snuck in.
    s.assets[0].owner = "joint";
    const back = hydrate(serialize(s), PROFILES);
    expect(back.assets[0].owner).toBe("client");
  });
});

describe("summaries", () => {
  it("summarise covers income/expenses and asset-filtered cashflows", () => {
    const s = defaultState(PROFILES, NOW);
    s.assets[0].balance = 100000;
    s.cashflows.contributions[0].amount = 1000; // monthly → 12k
    const inc = createIncomeRow(s.plan, []);
    inc.amount = 90000; // annual
    s.cashflows.income.push(inc);
    const exp = createExpenseRow(s.plan, []);
    exp.amount = 5000; exp.frequency = "monthly"; // → 60k
    s.cashflows.expenses.push(exp);

    const sum = summarise(s);
    expect(sum.totalBalance).toBe(100000);
    expect(sum.annualContributions).toBe(12000);
    expect(sum.annualIncome).toBe(90000);
    expect(sum.annualExpenses).toBe(60000);

    // Excluding the asset removes its contributions but not income/expenses.
    s.assets[0].include = false;
    const sum2 = summarise(s);
    expect(sum2.annualContributions).toBe(0);
    expect(sum2.annualIncome).toBe(90000);
  });

  it("plan summary text stays client-anchored", () => {
    expect(planSummaryText(couplePlan()))
      .toBe("50-year projection, 2026–2076 (age 40–90)");
  });
});

describe("allocation (carried from A.1)", () => {
  it("nearestVolBasis + clampAllocation still behave", () => {
    expect(nearestVolBasis(PROFILES, 7.5)).toBe("High Growth – Income");
    const out = clampAllocation({ mode: "custom", incomePct: 99, growthPct: -5, frankingPct: 250, volBasis: "junk" }, PROFILES);
    expect(out.incomePct).toBe(30);
    expect(out.growthPct).toBe(0);
    expect(out.frankingPct).toBe(100);
    expect(PROFILE_KEYS).toContain(out.volBasis);
  });

  it("profiles carry placeholder franking percentages", () => {
    expect(PROFILES["Cash"].frankingPct).toBe(0);
    expect(PROFILES["High Growth – Income"].frankingPct).toBeGreaterThan(PROFILES["High Growth – Capital"].frankingPct);
    for (const p of Object.values(PROFILES)) {
      expect(p.frankingPct).toBeGreaterThanOrEqual(0);
      expect(p.frankingPct).toBeLessThanOrEqual(100);
    }
  });

  it("allocation summaries unchanged", () => {
    expect(allocationTotalNominal({ mode: "custom", incomePct: 4, growthPct: 3.5 }, PROFILES)).toBeCloseTo(0.075);
    expect(allocationSummary({ mode: "profile", profile: "Balanced" }, PROFILES)).toBe("Balanced");
  });
});

describe("one-off grid helpers (C2)", () => {
  const input = { id: "in1", assetId: "a1", amount: 5000, direction: "in", age: 45, source: "input" };

  it("creates, updates, and deletes the table-sourced entry", () => {
    let ls = upsertTableLumpSum([input], "a1", 45, -20000);
    expect(ls).toHaveLength(2);
    const t = tableLumpSumFor(ls, "a1", 45);
    expect(t).toMatchObject({ assetId: "a1", age: 45, amount: 20000, direction: "out", source: "table" });

    // Update keeps the id and flips direction.
    const ls2 = upsertTableLumpSum(ls, "a1", 45, 7500);
    const t2 = tableLumpSumFor(ls2, "a1", 45);
    expect(t2.id).toBe(t.id);
    expect(t2).toMatchObject({ amount: 7500, direction: "in" });

    // Zero / empty / junk deletes; the input-sourced row survives.
    for (const cleared of [0, "", "abc", null]) {
      const ls3 = upsertTableLumpSum(ls2, "a1", 45, cleared);
      expect(tableLumpSumFor(ls3, "a1", 45)).toBeNull();
      expect(ls3).toContainEqual(input);
    }
  });

  it("cells are keyed by asset AND age", () => {
    let ls = upsertTableLumpSum([], "a1", 45, 1000);
    ls = upsertTableLumpSum(ls, "a1", 50, 2000);
    ls = upsertTableLumpSum(ls, "a2", 45, 3000);
    expect(ls).toHaveLength(3);
    expect(tableLumpSumFor(ls, "a1", 50).amount).toBe(2000);
  });

  it("first-FY editing follows convention 5", () => {
    expect(canEditOneOffYear({ start: { year: 2026, month: 7 } }, 0)).toBe(true);
    expect(canEditOneOffYear({ start: { year: 2026, month: 8 } }, 0)).toBe(false);
    expect(canEditOneOffYear({ start: { year: 2026, month: 8 } }, 1)).toBe(true);
  });
});

describe("schema v4 migration (C3)", () => {
  it("v3 blobs gain default tax profiles for both persons", () => {
    const v3 = {
      schemaVersion: 3,
      plan: {
        household: "couple",
        client: { currentAge: 45 },
        partner: { currentAge: 43 },
        endAge: 90,
        start: { year: 2026, month: 7 },
      },
      assets: [{ id: "a1", name: "A", include: true, owner: "client", distributions: "reinvest",
                 balance: 1000, allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0,
                 cgtAsset: false, costBase: null }],
      cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] },
      settings: { surplus: { mode: "spend", assetId: null }, fundingOrder: ["a1"] },
      display: { units: "real" },
      assumptions: { cpi: 0.025 },
    };
    const s = hydrate(JSON.stringify(v3), PROFILES);
    expect(s).not.toBeNull();
    expect(s.schemaVersion).toBe(4);
    const def = { residency: "resident", medicareExempt: false, centrelinkEligible: false };
    expect(s.plan.client.taxProfile).toEqual(def);
    expect(s.plan.partner.taxProfile).toEqual(def);
  });

  it("explicit v4 tax profiles survive a serialize/hydrate round trip", () => {
    const s = defaultState(PROFILES, NOW);
    s.plan.client.taxProfile = { residency: "nonResident", medicareExempt: true, centrelinkEligible: true };
    const back = hydrate(serialize(s), PROFILES);
    expect(back.plan.client.taxProfile)
      .toEqual({ residency: "nonResident", medicareExempt: true, centrelinkEligible: true });
  });

  it("clampTaxProfile defends junk", () => {
    expect(clampTaxProfile(null))
      .toEqual({ residency: "resident", medicareExempt: false, centrelinkEligible: false });
    expect(clampTaxProfile({ residency: "martian", medicareExempt: "yes", centrelinkEligible: 1 }))
      .toEqual({ residency: "resident", medicareExempt: false, centrelinkEligible: false });
  });
});
