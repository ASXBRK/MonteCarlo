import { describe, it, expect } from "vitest";
import { buildRetirementReviewGroups, RETIREMENT_REVIEW_GROUP_ORDER } from "./retirementReviewPanel.js";
import { INPUT_SECTIONS } from "./router.js";
import { PROFILES } from "./profiles.js";
import {
  defaultState, clampAllToPlan, createIncomeRow, createExpenseRow, createSuperAccount,
  createSuperContribution, createPension, createAsset,
} from "./planState.js";

function withPersonPatch(state, owner, patch) {
  const key = owner === "partner" ? "partner" : "client";
  return { ...state, plan: { ...state.plan, [key]: { ...state.plan[key], ...patch } } };
}

function coupleState(state) {
  return {
    ...state,
    plan: {
      ...state.plan,
      household: "married",
      partner: { ...state.plan.client, dob: "1982-01-01" },
    },
  };
}

describe("buildRetirementReviewGroups", () => {
  it("a fresh single-client default state shows only the always-present groups", () => {
    const state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const groups = buildRetirementReviewGroups(state);
    const keys = groups.map((g) => g.key);
    // defaultState() seeds exactly one financial asset (this app's own
    // "always at least one" convention — see planState.js's defaultState)
    // and nothing else, so assets + the two always-present singletons.
    expect(keys).toEqual(["assets", "incomeRequired", "retirementAges"]);
  });

  it("retirement ages carries one id for a single client, two for a couple", () => {
    const single = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const singleAges = buildRetirementReviewGroups(single).find((g) => g.key === "retirementAges");
    expect(singleAges.ids).toEqual(["client"]);

    const couple = clampAllToPlan(coupleState(defaultState(PROFILES)), PROFILES);
    const coupleAges = buildRetirementReviewGroups(couple).find((g) => g.key === "retirementAges");
    expect(coupleAges.ids).toEqual(["client", "partner"]);
  });

  it("every populated collection appears, in the spec's own group order", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const income = createIncomeRow(state.plan, []);
    const expense = createExpenseRow(state.plan, []);
    const sa = createSuperAccount(state.plan, [], PROFILES, "client");
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const sc = createSuperContribution(state.plan, state.plan.superAccounts, "client");
    const pn = createPension(state.plan, [], state.plan.superAccounts, "client");
    const extraAsset = createAsset(state.plan, state.assets, PROFILES);
    state = {
      ...state,
      assets: [...state.assets, extraAsset],
      plan: { ...state.plan, pensions: [pn] },
      cashflows: {
        ...state.cashflows, income: [income], expenses: [expense], superContributions: [sc],
      },
    };
    state = clampAllToPlan(state, PROFILES);

    const groups = buildRetirementReviewGroups(state);
    const keys = groups.map((g) => g.key);
    // Every group is populated in this fixture, so the full spec order
    // survives the "populated collections only" filter unchanged.
    expect(keys).toEqual(RETIREMENT_REVIEW_GROUP_ORDER);
  });

  it("an excluded (include:false) super account or asset is absent from every group it would otherwise populate", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const sa = { ...createSuperAccount(state.plan, [], PROFILES, "client"), include: false };
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    state = { ...state, assets: state.assets.map((a) => ({ ...a, include: false })) };
    state = clampAllToPlan(state, PROFILES);

    const groups = buildRetirementReviewGroups(state);
    const keys = groups.map((g) => g.key);
    expect(keys).not.toContain("super");
    expect(keys).not.toContain("glidePath");
    expect(keys).not.toContain("assets");
    // Still present — singletons, unaffected by any collection's contents.
    expect(keys).toContain("incomeRequired");
    expect(keys).toContain("retirementAges");
  });

  it("a lifestyle asset does not populate the financial-assets group", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    // Reclassify the seeded asset to lifestyle — createAsset always makes
    // "financial" (planState.js), so this simulates the other class directly.
    state = { ...state, assets: state.assets.map((a) => ({ ...a, class: "lifestyle" })) };
    state = clampAllToPlan(state, PROFILES);
    const groups = buildRetirementReviewGroups(state);
    expect(groups.map((g) => g.key)).not.toContain("assets");
  });

  it("every group's sectionId is a real router.js INPUT_SECTIONS id (the link-out target)", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const sa = createSuperAccount(state.plan, [], PROFILES, "client");
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const income = createIncomeRow(state.plan, []);
    const expense = createExpenseRow(state.plan, []);
    const sc = createSuperContribution(state.plan, state.plan.superAccounts, "client");
    const pn = createPension(state.plan, [], state.plan.superAccounts, "client");
    state = {
      ...state,
      plan: { ...state.plan, pensions: [pn] },
      cashflows: { ...state.cashflows, income: [income], expenses: [expense], superContributions: [sc] },
    };
    state = clampAllToPlan(state, PROFILES);

    const groups = buildRetirementReviewGroups(state);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(INPUT_SECTIONS, `group "${g.key}" links to unknown section "${g.sectionId}"`).toContain(g.sectionId);
    }
  });

  it("group ids reference real rows — every id round-trips to a row that actually exists in state", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const sa = createSuperAccount(state.plan, [], PROFILES, "client");
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const income = createIncomeRow(state.plan, []);
    state = { ...state, cashflows: { ...state.cashflows, income: [income] } };
    state = clampAllToPlan(state, PROFILES);

    const groups = buildRetirementReviewGroups(state);
    const incomeGroup = groups.find((g) => g.key === "income");
    expect(incomeGroup.ids).toEqual(state.cashflows.income.map((r) => r.id));
    const superGroup = groups.find((g) => g.key === "super");
    expect(superGroup.ids).toEqual(state.plan.superAccounts.filter((s) => s.include !== false).map((s) => s.id));
  });
});
