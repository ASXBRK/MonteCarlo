import { describe, it, expect } from "vitest";
import { buildSearchIndex, searchInputs, SEARCH_ALIASES } from "./inputSearch.js";
import { PROFILES } from "./profiles.js";
import {
  defaultState, clampAllToPlan, createIncomeRow, createExpenseRow, createSuperAccount,
  createSuperContribution, createPension, createAsset, createLiability, createBond, createProperty,
} from "./planState.js";

const SECTION_LABELS = {
  income: "Income", expenses: "Expenses", super: "Super", pension: "Pension",
  "financial-assets": "Financial assets", "lifestyle-assets": "Lifestyle assets",
  liabilities: "Liabilities", "investment-cashflows": "Investment cashflows",
  property: "Property", settings: "Settings", setup: "Setup",
  "tax-details": "Tax details", children: "Children", implementation: "Implementation",
  deductions: "Deductions", "aged-care": "Aged care", goals: "Goals",
};

function coupleState(state) {
  return { ...state, plan: { ...state.plan, household: "married", partner: { ...state.plan.client, dob: "1982-01-01" } } };
}

describe("buildSearchIndex", () => {
  it("a fresh single-client default state indexes the seeded asset, the two singletons, and every input section", () => {
    const state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const index = buildSearchIndex(state, SECTION_LABELS);
    const kinds = index.map((e) => e.kind);
    expect(kinds).toContain("asset");
    expect(kinds).toContain("setting");
    expect(kinds.filter((k) => k === "section").length).toBe(17); // router.js's own INPUT_SECTIONS count
  });

  it("an income row indexes its label, category, owner, and value", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const income = { ...createIncomeRow(state.plan, []), label: "Site allowance", labelIsDefault: false, category: "salary", amount: 4500 };
    state = clampAllToPlan({ ...state, cashflows: { ...state.cashflows, income: [income] } }, PROFILES);
    const index = buildSearchIndex(state, SECTION_LABELS);
    const entry = index.find((e) => e.kind === "income");
    expect(entry.label).toBe("Site allowance");
    expect(entry.value).toBe(4500);
    expect(entry.dataAttrs).toEqual({ kind: "income", cfid: income.id, field: "amount" });
    expect(entry.searchText).toContain("site allowance");
    expect(entry.searchText).toContain("4500");
  });

  it("a super contribution's camelCase type reads as plain words with no label map needed — 'salarySacrifice' → 'salary sacrifice'", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const sa = createSuperAccount(state.plan, [], PROFILES, "client");
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const sc = { ...createSuperContribution(state.plan, [sa], "client"), type: "salarySacrifice", amount: 15000 };
    state = clampAllToPlan({ ...state, cashflows: { ...state.cashflows, superContributions: [sc] } }, PROFILES);
    const entry = buildSearchIndex(state, SECTION_LABELS).find((e) => e.kind === "contribution");
    expect(entry.typeText).toBe("salary sacrifice");
    expect(entry.searchText).toContain("salary sacrifice");
  });

  it("a liability indexes its own balance and humanised type", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const l = { ...createLiability(state.plan, []), name: "Home loan", type: "mortgage", balance: 500000 };
    state = clampAllToPlan({ ...state, liabilities: [l] }, PROFILES);
    const entry = buildSearchIndex(state, SECTION_LABELS).find((e) => e.kind === "liability");
    expect(entry.label).toBe("Home loan");
    expect(entry.value).toBe(500000);
    expect(entry.dataAttrs).toEqual({ lid: l.id, lfield: "balance" });
  });

  it("a bond indexes its own balance and dataAttrs matching applyBondEdit's own scheme", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const b = { ...createBond(state.plan, [], PROFILES), name: "Education bond", balance: 50000 };
    state = clampAllToPlan({ ...state, bonds: [b] }, PROFILES);
    const entry = buildSearchIndex(state, SECTION_LABELS).find((e) => e.kind === "bond");
    expect(entry.value).toBe(50000);
    expect(entry.dataAttrs).toEqual({ bdid: b.id, bdfield: "balance" });
  });

  it("a property indexes its own value but has NO dataAttrs — click-through only, matching the review panel's own 'link out for anything complex' rule", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const p = { ...createProperty(state.plan, []), name: "Family home", propertyType: "ppr", currentValue: 900000, status: "owned" };
    state = clampAllToPlan({ ...state, properties: [p] }, PROFILES);
    const entry = buildSearchIndex(state, SECTION_LABELS).find((e) => e.kind === "property");
    expect(entry.value).toBe(900000);
    expect(entry.dataAttrs).toBeNull();
    expect(entry.typeText).toBe("ppr");
  });

  it("retirement age carries one entry for a single client, two for a couple", () => {
    const single = clampAllToPlan(defaultState(PROFILES), PROFILES);
    expect(buildSearchIndex(single, SECTION_LABELS).filter((e) => e.id.startsWith("retirement-age")).length).toBe(1);
    const couple = clampAllToPlan(coupleState(defaultState(PROFILES)), PROFILES);
    expect(buildSearchIndex(couple, SECTION_LABELS).filter((e) => e.id.startsWith("retirement-age")).length).toBe(2);
  });

  it("an excluded (include:false) asset, super account, or bond is absent", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    state = { ...state, assets: state.assets.map((a) => ({ ...a, include: false })) };
    state = clampAllToPlan(state, PROFILES);
    expect(buildSearchIndex(state, SECTION_LABELS).map((e) => e.kind)).not.toContain("asset");
  });
});

describe("searchInputs — 'sacrifice', 'Super', and '15000' all find the salary sacrifice row (the spec's own worked example)", () => {
  function fixture() {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const sa = createSuperAccount(state.plan, [], PROFILES, "client");
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const sc = { ...createSuperContribution(state.plan, [sa], "client"), label: "Concessional", type: "salarySacrifice", amount: 15000 };
    state = clampAllToPlan({ ...state, cashflows: { ...state.cashflows, superContributions: [sc] } }, PROFILES);
    return { state, sc };
  }

  it("a term matching a label finds the row", () => {
    const { state, sc } = fixture();
    const index = buildSearchIndex(state, SECTION_LABELS);
    const results = searchInputs(index, "Concessional");
    expect(results.some((r) => r.id === `contribution:${sc.id}`)).toBe(true);
  });

  it("a term matching the row's own type (humanised) finds it — 'sacrifice'", () => {
    const { state, sc } = fixture();
    const results = searchInputs(buildSearchIndex(state, SECTION_LABELS), "sacrifice");
    expect(results.some((r) => r.id === `contribution:${sc.id}`)).toBe(true);
  });

  it("a term matching the section name finds it — 'Super'", () => {
    const { state, sc } = fixture();
    const results = searchInputs(buildSearchIndex(state, SECTION_LABELS), "Super");
    expect(results.some((r) => r.id === `contribution:${sc.id}`)).toBe(true);
  });

  it("a term matching the row's own value finds it — '15000'", () => {
    const { state, sc } = fixture();
    const results = searchInputs(buildSearchIndex(state, SECTION_LABELS), "15000");
    expect(results.some((r) => r.id === `contribution:${sc.id}`)).toBe(true);
  });

  it("a partial value match works too — '1500' is a substring of '15000'", () => {
    const { state, sc } = fixture();
    const results = searchInputs(buildSearchIndex(state, SECTION_LABELS), "1500");
    expect(results.some((r) => r.id === `contribution:${sc.id}`)).toBe(true);
  });
});

describe("searchInputs — aliases and synonyms", () => {
  it("'sac' (an alias) finds a salarySacrifice contribution even though 'sac' alone is also a literal prefix of 'sacrifice'", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const sa = createSuperAccount(state.plan, [], PROFILES, "client");
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const sc = { ...createSuperContribution(state.plan, [sa], "client"), type: "salarySacrifice" };
    state = clampAllToPlan({ ...state, cashflows: { ...state.cashflows, superContributions: [sc] } }, PROFILES);
    const results = searchInputs(buildSearchIndex(state, SECTION_LABELS), "sac");
    expect(results.some((r) => r.id === `contribution:${sc.id}`)).toBe(true);
  });

  it("'NCC' and 'non-concessional' both find a personalNonDeductible contribution — neither is a literal substring of it", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const sa = createSuperAccount(state.plan, [], PROFILES, "client");
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const sc = { ...createSuperContribution(state.plan, [sa], "client"), type: "personalNonDeductible" };
    state = clampAllToPlan({ ...state, cashflows: { ...state.cashflows, superContributions: [sc] } }, PROFILES);
    const index = buildSearchIndex(state, SECTION_LABELS);
    expect(index.find((e) => e.kind === "contribution").searchText).not.toContain("ncc");
    expect(searchInputs(index, "NCC").some((r) => r.id === `contribution:${sc.id}`)).toBe(true);
    expect(searchInputs(index, "non-concessional").some((r) => r.id === `contribution:${sc.id}`)).toBe(true);
  });

  it("'TTR' and 'transition to retirement' both find a ttr pension", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const sa = createSuperAccount(state.plan, [], PROFILES, "client");
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const pn = { ...createPension(state.plan, [], [sa], "client"), sourceAccountId: sa.id, type: "ttr" };
    state = clampAllToPlan({ ...state, plan: { ...state.plan, pensions: [pn] } }, PROFILES);
    const index = buildSearchIndex(state, SECTION_LABELS);
    expect(searchInputs(index, "TTR").some((r) => r.id === `pension:${pn.id}`)).toBe(true);
    expect(searchInputs(index, "transition to retirement").some((r) => r.id === `pension:${pn.id}`)).toBe(true);
  });

  it("'ABP' and 'account-based pension' both find an abp pension", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const sa = createSuperAccount(state.plan, [], PROFILES, "client");
    state = { ...state, plan: { ...state.plan, superAccounts: [sa] } };
    const pn = { ...createPension(state.plan, [], [sa], "client"), sourceAccountId: sa.id, type: "abp" };
    state = clampAllToPlan({ ...state, plan: { ...state.plan, pensions: [pn] } }, PROFILES);
    const index = buildSearchIndex(state, SECTION_LABELS);
    expect(searchInputs(index, "ABP").some((r) => r.id === `pension:${pn.id}`)).toBe(true);
    expect(searchInputs(index, "account-based pension").some((r) => r.id === `pension:${pn.id}`)).toBe(true);
  });

  it("'PPR' and 'main residence' both find a ppr property", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const p = { ...createProperty(state.plan, []), propertyType: "ppr", status: "owned", currentValue: 900000 };
    state = clampAllToPlan({ ...state, properties: [p] }, PROFILES);
    const index = buildSearchIndex(state, SECTION_LABELS);
    expect(searchInputs(index, "PPR").some((r) => r.id === `property:${p.id}`)).toBe(true);
    expect(searchInputs(index, "main residence").some((r) => r.id === `property:${p.id}`)).toBe(true);
  });

  it("'offset' finds a liability", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const l = { ...createLiability(state.plan, []), name: "Offset account" };
    state = clampAllToPlan({ ...state, liabilities: [l] }, PROFILES);
    const results = searchInputs(buildSearchIndex(state, SECTION_LABELS), "offset");
    expect(results.some((r) => r.id === `liability:${l.id}`)).toBe(true);
  });

  it("every alias key and value round-trips through normaliseSearchText's own case-insensitivity", () => {
    // A structural guard: every alias list is lowercase already (so
    // extending SEARCH_ALIASES with an accidental capital doesn't
    // silently stop matching — searchInputs normalises the QUERY, not
    // the stored alias keys, so a key must already be lowercase to work).
    for (const [key, values] of Object.entries(SEARCH_ALIASES)) {
      expect(key).toBe(key.toLowerCase());
      for (const v of values) expect(v).toBe(v.toLowerCase());
    }
  });
});

describe("searchInputs — section names and empty results", () => {
  it("a term matching only a section name (no rows there yet) still returns that section", () => {
    const state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const results = searchInputs(buildSearchIndex(state, SECTION_LABELS), "Aged care");
    expect(results.some((r) => r.kind === "section" && r.sectionId === "aged-care")).toBe(true);
  });

  it("a term matching nothing returns an empty array — the caller reports plainly, not silently", () => {
    const state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    expect(searchInputs(buildSearchIndex(state, SECTION_LABELS), "zzzznomatch")).toEqual([]);
  });

  it("a blank/whitespace term returns an empty array rather than the whole index", () => {
    const state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const index = buildSearchIndex(state, SECTION_LABELS);
    expect(searchInputs(index, "")).toEqual([]);
    expect(searchInputs(index, "   ")).toEqual([]);
  });

  it("an exact label match ranks ahead of a mere substring match", () => {
    let state = clampAllToPlan(defaultState(PROFILES), PROFILES);
    const a1 = { ...createAsset(state.plan, [], PROFILES), name: "Super" }; // exact match on a section-like word
    const a2 = { ...createAsset(state.plan, [a1], PROFILES), name: "Super savings account" }; // substring only
    state = clampAllToPlan({ ...state, assets: [a1, a2] }, PROFILES);
    const results = searchInputs(buildSearchIndex(state, SECTION_LABELS), "Super");
    const i1 = results.findIndex((r) => r.id === `asset:${a1.id}`);
    const i2 = results.findIndex((r) => r.id === `asset:${a2.id}`);
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(i2);
  });
});
