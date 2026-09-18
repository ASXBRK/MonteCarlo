import { describe, it, expect } from "vitest";
import {
  buildRetirementReviewGroups, buildReviewGroups, RETIREMENT_REVIEW_GROUP_ORDER, REVIEW_GROUP_ORDER,
  reviewPanelGroupOrderFor, REVIEW_PANEL_RELEVANT_GROUPS,
} from "./retirementReviewPanel.js";
import { INPUT_SECTIONS } from "./router.js";
import { PROFILES } from "./profiles.js";
import {
  defaultState, clampAllToPlan, createIncomeRow, createExpenseRow, createSuperAccount,
  createSuperContribution, createPension, createAsset, createLiability, createBond,
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

// docs/specs/38-finding-and-editing-inputs.md, Commit 1 — the general
// builder every mount OTHER than Retirement > Projection uses. Same
// underlying function as buildRetirementReviewGroups (this file's own
// header on why there is only one), called with the wider REVIEW_GROUP_
// ORDER — which adds liabilities and bonds, the two collections a
// retirement-scoped panel never needed.
describe("buildReviewGroups (the general builder)", () => {
  it("defaults to REVIEW_GROUP_ORDER, a strict superset of RETIREMENT_REVIEW_GROUP_ORDER (adds liabilities and bonds only)", () => {
    const extra = REVIEW_GROUP_ORDER.filter((k) => !RETIREMENT_REVIEW_GROUP_ORDER.includes(k));
    expect(extra.sort()).toEqual(["bonds", "liabilities"]);
    for (const k of RETIREMENT_REVIEW_GROUP_ORDER) expect(REVIEW_GROUP_ORDER).toContain(k);
  });

  it("buildReviewGroups(state, RETIREMENT_REVIEW_GROUP_ORDER) is IDENTICAL to buildRetirementReviewGroups(state) — the same function underneath, not a fork", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const sa = createSuperAccount(state.plan, [], PROFILES, "client");
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    state = clampAllToPlan(state, PROFILES);
    expect(buildReviewGroups(state, RETIREMENT_REVIEW_GROUP_ORDER)).toEqual(buildRetirementReviewGroups(state));
  });

  it("a liability populates a new Liabilities group, ordered and sectioned correctly, absent when there are none", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    expect(buildReviewGroups(state).map((g) => g.key)).not.toContain("liabilities");
    const liability = createLiability(state.plan, []);
    state = { ...state, liabilities: [liability] };
    state = clampAllToPlan(state, PROFILES);
    const group = buildReviewGroups(state).find((g) => g.key === "liabilities");
    expect(group).toBeTruthy();
    expect(group.ids).toEqual([liability.id]);
    expect(group.sectionId).toBe("liabilities");
    expect(INPUT_SECTIONS).toContain(group.sectionId);
  });

  it("a bond populates a new Bonds group; an excluded (include:false) bond is absent", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const bond = createBond(state.plan, [], PROFILES);
    state = { ...state, bonds: [bond] };
    state = clampAllToPlan(state, PROFILES);
    const group = buildReviewGroups(state).find((g) => g.key === "bonds");
    expect(group.ids).toEqual([bond.id]);
    expect(INPUT_SECTIONS).toContain(group.sectionId);

    const excludedState = { ...state, bonds: [{ ...bond, include: false }] };
    expect(buildReviewGroups(clampAllToPlan(excludedState, PROFILES)).map((g) => g.key)).not.toContain("bonds");
  });

  it("accepts a custom order — relevance reordering (main.js's own job) is just a different array, not a different builder", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const liability = createLiability(state.plan, []);
    state = clampAllToPlan({ ...state, liabilities: [liability] }, PROFILES);
    const reordered = ["liabilities", "assets", "incomeRequired", "retirementAges"];
    const groups = buildReviewGroups(state, reordered);
    expect(groups.map((g) => g.key)).toEqual(reordered); // liabilities first, exactly as passed
  });
});

// docs/specs/38-finding-and-editing-inputs.md, Commit 1 — "relevance
// ordering differs by view while the full set remains" is the spec's
// own required test. Checked directly here, not trusted by
// construction, because a typo'd group key in REVIEW_PANEL_RELEVANT_
// GROUPS (this file's own data) would otherwise silently either drop a
// group from a specific view's own panel or duplicate one — exactly the
// "do not filter" defect this spec exists to prevent, in a NEW place.
describe("reviewPanelGroupOrderFor", () => {
  it("every view's own ordering is a permutation of REVIEW_GROUP_ORDER — same set, never filtered, for every mapped view", () => {
    for (const view of Object.keys(REVIEW_PANEL_RELEVANT_GROUPS)) {
      const ordered = reviewPanelGroupOrderFor(view);
      expect([...ordered].sort()).toEqual([...REVIEW_GROUP_ORDER].sort());
    }
  });

  it("an unmapped/unknown view falls back to the plain default order", () => {
    expect(reviewPanelGroupOrderFor("some-view-nobody-registered")).toEqual(REVIEW_GROUP_ORDER);
  });

  it("relevance genuinely differs by view — liabilities lead for a debt view, super leads for a super view", () => {
    const debt = reviewPanelGroupOrderFor("liabilities");
    expect(debt[0]).toBe("liabilities");
    const superView = reviewPanelGroupOrderFor("super");
    expect(superView[0]).toBe("super");
    expect(debt).not.toEqual(superView);
  });

  it("relevant groups lead in the order given; every other group keeps its own default relative order behind them", () => {
    const ordered = reviewPanelGroupOrderFor("projection"); // ["assets", "super", "pensions", "liabilities"]
    expect(ordered.slice(0, 4)).toEqual(["assets", "super", "pensions", "liabilities"]);
    const rest = ordered.slice(4);
    const defaultRest = REVIEW_GROUP_ORDER.filter((k) => !["assets", "super", "pensions", "liabilities"].includes(k));
    expect(rest).toEqual(defaultRest);
  });

  it("every group named anywhere in REVIEW_PANEL_RELEVANT_GROUPS is a real REVIEW_GROUP_ORDER key — no dead/typo'd entries", () => {
    for (const [view, groups] of Object.entries(REVIEW_PANEL_RELEVANT_GROUPS)) {
      for (const g of groups) {
        expect(REVIEW_GROUP_ORDER, `"${view}" names unknown group "${g}"`).toContain(g);
      }
    }
  });
});
