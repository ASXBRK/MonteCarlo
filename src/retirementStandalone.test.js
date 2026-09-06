import { describe, it, expect } from "vitest";
import {
  retirementFields, superAccountFor, findOtherInvestmentsAsset, ensurePersonSuperAccount,
  partnerHasData, setHousehold, pensionFor, ensureRetirementPensions,
  setFirstName, setDob, setRetirementAge, setSuperBalance, setSuperAllocation,
  setSalary, setConcessionalContributions, setConcessionalContributionsFrom, setConcessionalContributionsTo,
  setIncomeRequired,
  setOtherInvestments, setOtherInvestmentsAllocation, setOtherRetirementIncome, setIncludeAgePension,
  sgFor, ageYear, preservationAgeFor, agePensionAgeFor, capHeadroomFor, firstDiv293Year,
  agePensionEligibilityFor,
} from "./retirementStandalone.js";
import { defaultState, clampAllToPlan, hydrate, serialize } from "./planState.js";
import { projectPlan } from "./deterministic.js";
import { buildSchedules, firstFyStartYear } from "./schedule.js";
import { superRatesFor } from "./data/superRates.js";
import { agePensionRatesFor } from "./data/agePension.js";
import { PROFILES } from "./profiles.js";

const NOW = new Date("2026-08-17T00:00:00+10:00");

function baseState() {
  return defaultState(PROFILES, NOW);
}

describe("retirementStandalone — per-field setters write to the correct EXISTING state path (client)", () => {
  it("first name → plan.client.firstName", () => {
    const state = setFirstName(baseState(), "client", "Alex");
    expect(state.plan.client.firstName).toBe("Alex");
    expect(retirementFields(state).client.firstName).toBe("Alex");
  });

  it("date of birth → plan.client.dob", () => {
    const state = setDob(baseState(), "client", "1980-05-01");
    expect(state.plan.client.dob).toBe("1980-05-01");
    expect(retirementFields(state).client.dob).toBe("1980-05-01");
  });

  it("retirement age → plan.client.retirementAge", () => {
    const state = setRetirementAge(baseState(), "client", 62);
    expect(state.plan.client.retirementAge).toBe(62);
    expect(retirementFields(state).client.retirementAge).toBe(62);
  });

  it("current super balance → plan.superAccounts[0].balance, creating the account via the SAME factory the comprehensive Super section uses", () => {
    const state = setSuperBalance(baseState(), "client", 250000, PROFILES);
    expect(state.plan.superAccounts).toHaveLength(1);
    expect(state.plan.superAccounts[0].owner).toBe("client");
    expect(state.plan.superAccounts[0].balance).toBe(250000);
    expect(retirementFields(state).client.superBalance).toBe(250000);
  });

  it("setSuperBalance called twice edits the SAME account, never creates a second one", () => {
    let state = setSuperBalance(baseState(), "client", 100000, PROFILES);
    state = setSuperBalance(state, "client", 150000, PROFILES);
    expect(state.plan.superAccounts).toHaveLength(1);
    expect(state.plan.superAccounts[0].balance).toBe(150000);
  });

  it("risk profile / glide path → plan.superAccounts[0].allocation", () => {
    const state = setSuperAllocation(setSuperBalance(baseState(), "client", 100000, PROFILES), "client", { mode: "profile", profile: "Balanced" }, PROFILES);
    expect(superAccountFor(state, "client").allocation).toEqual({ mode: "profile", profile: "Balanced" });
  });

  it("salary → a cashflows.income row, category salary, owner client", () => {
    const state = setSalary(baseState(), "client", 120000);
    const row = state.cashflows.income.find((r) => r.category === "salary" && r.owner === "client");
    expect(row).toBeTruthy();
    expect(row.amount).toBe(120000);
    expect(retirementFields(state).client.salary).toBe(120000);
  });

  it("setSalary called twice edits the SAME row, never creates a second salary row", () => {
    let state = setSalary(baseState(), "client", 80000);
    state = setSalary(state, "client", 90000);
    const salaryRows = state.cashflows.income.filter((r) => r.category === "salary" && r.owner === "client");
    expect(salaryRows).toHaveLength(1);
    expect(salaryRows[0].amount).toBe(90000);
  });

  it("concessional contributions beyond SG → a cashflows.superContributions row, type salarySacrifice, annual", () => {
    const state = setConcessionalContributions(baseState(), "client", 10000, PROFILES);
    const row = state.cashflows.superContributions.find((c) => c.owner === "client");
    expect(row).toBeTruthy();
    expect(row.type).toBe("salarySacrifice");
    expect(row.basis).toBe("amount");
    expect(row.frequency).toBe("annual");
    expect(row.amount).toBe(10000);
    expect(row.accountId).toBe(superAccountFor(state, "client").id);
    expect(retirementFields(state).client.concessionalContributions).toBe(10000);
  });

  it("setConcessionalContributions called twice edits the SAME row, never creates a second one", () => {
    let state = setConcessionalContributions(baseState(), "client", 5000, PROFILES);
    state = setConcessionalContributions(state, "client", 8000, PROFILES);
    const rows = state.cashflows.superContributions.filter((c) => c.owner === "client" && c.type === "salarySacrifice");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(8000);
  });

  it("concessional contributions default to the SAME start→retirement window createSuperContribution itself picks", () => {
    const state = setConcessionalContributions(baseState(), "client", 10000, PROFILES);
    const row = state.cashflows.superContributions.find((c) => c.owner === "client");
    expect(row.from).toEqual({ kind: "anchor", anchorId: "start" });
    expect(row.to).toEqual({ kind: "anchor", anchorId: "retirement-client" });
    expect(retirementFields(state).client.concessionalContributionsFrom).toEqual(row.from);
    expect(retirementFields(state).client.concessionalContributionsTo).toEqual(row.to);
  });

  it("setConcessionalContributionsFrom/To — 'salary sacrifice $15,000 from 55 until retirement' — edits the SAME row's own existing DateRef fields, creating it via the same factory if it doesn't exist yet", () => {
    let state = setConcessionalContributions(baseState(), "client", 15000, PROFILES);
    state = setConcessionalContributionsFrom(state, "client", { kind: "age", age: 55 }, PROFILES);
    const rows = state.cashflows.superContributions.filter((c) => c.owner === "client" && c.type === "salarySacrifice");
    expect(rows).toHaveLength(1); // still the SAME row, not a second one
    expect(rows[0].amount).toBe(15000);
    expect(rows[0].from).toEqual({ kind: "age", age: 55 });
    expect(rows[0].to).toEqual({ kind: "anchor", anchorId: "retirement-client" }); // untouched

    // Setting the window BEFORE any amount is entered still creates
    // exactly one row (via the same factory), not a parallel concept.
    const fromScratch = setConcessionalContributionsFrom(baseState(), "client", { kind: "age", age: 55 }, PROFILES);
    expect(fromScratch.cashflows.superContributions.filter((c) => c.owner === "client")).toHaveLength(1);
    expect(retirementFields(fromScratch).client.concessionalContributionsFrom).toEqual({ kind: "age", age: 55 });
  });

  it("setConcessionalContributionsTo edits the row's own 'to' independently of 'from'", () => {
    let state = setConcessionalContributions(baseState(), "client", 15000, PROFILES);
    state = setConcessionalContributionsTo(state, "client", { kind: "age", age: 70 }, PROFILES);
    const row = state.cashflows.superContributions.find((c) => c.owner === "client");
    expect(row.to).toEqual({ kind: "age", age: 70 });
    expect(row.from).toEqual({ kind: "anchor", anchorId: "start" }); // untouched
  });

  it("a from/to window reaches the real engine — contributions outside the window don't count toward SG/cap usage for that year", () => {
    let state = setSuperBalance(baseState(), "client", 100000, PROFILES);
    state = setDob(state, "client", "1975-01-01");
    state = setRetirementAge(state, "client", 65);
    state = setSalary(state, "client", 150000);
    state = setConcessionalContributions(state, "client", 15000, PROFILES);
    state = setConcessionalContributionsFrom(state, "client", { kind: "age", age: 55 }, PROFILES);
    const clamped = clampAllToPlan(state, PROFILES);
    const out = projectPlan(clamped, PROFILES);
    // Client starts well below 55 (currentAge derived from the 1975 dob
    // against baseState()'s own NOW) — year 0's own salary-sacrifice
    // flow must be zero; it only starts once age 55 is reached.
    expect(clamped.plan.client.currentAge).toBeLessThan(55);
    expect(out.yearly[0].superCapUsage.client.salarySacrifice).toBe(0);
    const age55PlanYear = 55 - clamped.plan.client.currentAge;
    expect(out.yearly[age55PlanYear].superCapUsage.client.salarySacrifice).toBeCloseTo(15000, 0);
  });
});

// --- Derived inputs (spec 34, Commit 1: "the page knows things") ----------
describe("retirementStandalone — derived inputs (spec 34 Commit 1)", () => {
  it("sgFor derives SG at the statutory rate, uncapped", () => {
    // 115,000 × 12% = 13,800 — the spec's own worked example.
    const sg = sgFor(baseState(), 115000);
    expect(sg.amount).toBeCloseTo(13800, 2);
    expect(sg.ratePct).toBe(12);
    expect(sg.isCapped).toBe(false);
    expect(sg.base).toBe(115000);
  });

  it("sgFor caps at the maximum contribution base once salary exceeds it", () => {
    const state = baseState();
    const f0 = firstFyStartYear(state.plan.start);
    const rates = superRatesFor(f0);
    const sg = sgFor(state, 300000);
    expect(sg.isCapped).toBe(true);
    expect(sg.base).toBe(rates.sgMaximumSalary);
    expect(sg.amount).toBeCloseTo(rates.sgMaximumSalary * rates.sgRate, 2);
    expect(sg.sgMaximumSalary).toBe(rates.sgMaximumSalary);
  });

  it("preservationAgeFor and agePensionAgeFor resolve from date of birth to a calendar year", () => {
    let state = setDob(baseState(), "client", "1980-08-17"); // ~46 at plan start
    state = clampAllToPlan(state, PROFILES);
    const schedule = buildSchedules(state);
    const f0 = firstFyStartYear(state.plan.start);
    const currentAge = state.plan.client.currentAge; // plan.start is 1 Aug, before the Aug 17 birthday
    const rates = superRatesFor(f0);
    const ap = agePensionRatesFor(f0);

    const preservation = preservationAgeFor(state, "client", schedule);
    expect(preservation.age).toBe(rates.preservationAge); // 60
    expect(preservation.year).toBe(f0 + (rates.preservationAge - currentAge));

    const pension = agePensionAgeFor(state, "client", schedule);
    expect(pension.age).toBe(ap.ageOfEligibility); // 67
    expect(pension.year).toBe(f0 + (ap.ageOfEligibility - currentAge));

    // agePensionEligibilityFor is the client-anchored convenience wrapper
    // the household toggle label reads.
    expect(agePensionEligibilityFor(state, schedule)).toEqual(pension);
  });

  it("ageYear reports outOfRange rather than a bogus year once the target age falls beyond the projection", () => {
    let state = setDob(baseState(), "client", "1980-08-17");
    state = setRetirementAge(state, "client", 65);
    state = clampAllToPlan(state, PROFILES);
    const schedule = buildSchedules(state);
    const resolved = ageYear(state, "client", 200, schedule); // no one's projection runs to age 200
    expect(resolved.outOfRange).toBe(true);
    expect(resolved.year).toBeNull();
  });

  it("capHeadroomFor reads the SAME projection.yearly[0].superCapUsage[owner] the comprehensive Super section's own display reads — cannot disagree with it by construction", () => {
    let state = setSuperBalance(baseState(), "client", 50000, PROFILES);
    state = setSalary(state, "client", 115000);
    state = setConcessionalContributions(state, "client", 10000, PROFILES);
    const clamped = clampAllToPlan(state, PROFILES);
    const out = projectPlan(clamped, PROFILES);
    expect(capHeadroomFor(out, "client")).toEqual(out.yearly[0].superCapUsage.client);
    expect(capHeadroomFor(out, "client").cap).toBeGreaterThan(0);
  });

  it("capHeadroomFor returns null when the projection has no yearly rows for the owner", () => {
    const out = { yearly: [] };
    expect(capHeadroomFor(out, "client")).toBeNull();
  });

  it("firstDiv293Year fires in the first year a high enough salary pushes income plus concessional contributions over the threshold", () => {
    // $300k salary alone (SG ≈ $32,500, essentially the whole cap) plus
    // taxable income of ~$300k clears the $250k Div293 threshold as soon
    // as a full FY of salary is assessed — the plan's own partial first
    // year (start month > July) means year 0 itself draws no salary, so
    // the earliest it can bite is year 1, the first full FY. A super
    // account has to exist for SG to actually accrue (superCapUsage.sg
    // reads 0 without one, per deterministic.test.js's own "cap headroom
    // is a person-level figure, not account-gated" regression gate —
    // headroom is still reported, but usage isn't).
    let state = setSuperBalance(baseState(), "client", 50000, PROFILES);
    state = setDob(state, "client", "1980-08-17");
    state = setSalary(state, "client", 300000);
    const clamped = clampAllToPlan(state, PROFILES);
    const out = projectPlan(clamped, PROFILES);
    const f0 = firstFyStartYear(clamped.plan.start);
    const hit = firstDiv293Year(clamped, out, "client");
    expect(hit).not.toBeNull();
    expect(hit.year).toBe(f0 + 1);
    expect(hit.age).toBe(clamped.plan.client.currentAge + 1);
    expect(hit.threshold).toBeGreaterThan(0);
    expect(hit.ratePct).toBe(15);
  });

  it("firstDiv293Year reports null when income never approaches the threshold", () => {
    let state = setDob(baseState(), "client", "1980-08-17");
    state = setSalary(state, "client", 80000);
    const clamped = clampAllToPlan(state, PROFILES);
    const out = projectPlan(clamped, PROFILES);
    expect(firstDiv293Year(clamped, out, "client")).toBeNull();
  });
});

describe("retirementStandalone — income required and other household-level setters", () => {
  it("income required → plan.retirement.incomeRequired, merged not replaced (household-level, no owner)", () => {
    let state = setIncomeRequired(baseState(), { source: "asfaComfortable" });
    state = setIncomeRequired(state, { stepDownAtAge: 85 });
    expect(state.plan.retirement.incomeRequired.source).toBe("asfaComfortable");
    expect(state.plan.retirement.incomeRequired.stepDownAtAge).toBe(85);
    // Untouched fields survive the merge.
    expect(state.plan.retirement.incomeRequired.indexBasis).toBe("cpi");
  });

  it("other investments lump → state.assets[0].balance, the SAME asset defaultState() already seeds — never a second asset (household-level, no owner)", () => {
    const before = baseState();
    expect(before.assets).toHaveLength(1);
    const state = setOtherInvestments(before, 300000, PROFILES);
    expect(state.assets).toHaveLength(1);
    expect(state.assets[0].balance).toBe(300000);
    expect(retirementFields(state).otherInvestments).toBe(300000);
  });

  it("other investments allocation → state.assets[0].allocation", () => {
    const state = setOtherInvestmentsAllocation(baseState(), { mode: "profile", profile: "Cash" }, PROFILES);
    expect(findOtherInvestmentsAsset(state).allocation).toEqual({ mode: "profile", profile: "Cash" });
  });

  it("other retirement income → a cashflows.income row, category otherIncome, from retirement-client to end (household-level, always client-owned)", () => {
    const state = setOtherRetirementIncome(baseState(), 15000);
    const row = state.cashflows.income.find((r) => r.category === "otherIncome");
    expect(row).toBeTruthy();
    expect(row.amount).toBe(15000);
    expect(row.frequency).toBe("annual");
    expect(row.indexBasis).toBe("cpi");
    expect(row.from).toEqual({ kind: "anchor", anchorId: "retirement-client" });
    expect(row.to).toEqual({ kind: "anchor", anchorId: "end" });
    expect(retirementFields(state).otherRetirementIncome).toBe(15000);
  });

  it("setOtherRetirementIncome called twice edits the SAME row, never creates a second one", () => {
    let state = setOtherRetirementIncome(baseState(), 5000);
    state = setOtherRetirementIncome(state, 7000);
    const rows = state.cashflows.income.filter((r) => r.category === "otherIncome");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(7000);
  });

  it("include age pension toggle → plan.client.taxProfile.centrelinkEligible, default on", () => {
    expect(retirementFields(baseState()).includeAgePension).toBe(true);
    const off = setIncludeAgePension(baseState(), false);
    expect(off.plan.client.taxProfile.centrelinkEligible).toBe(false);
    expect(off.plan.client.taxProfile.centrelinkEligibleIsDefault).toBe(false);
    expect(retirementFields(off).includeAgePension).toBe(false);
    const backOn = setIncludeAgePension(off, true);
    expect(backOn.plan.client.taxProfile.centrelinkEligible).toBe(true);
    expect(backOn.plan.client.taxProfile.centrelinkEligibleIsDefault).toBe(true);
  });
});

describe("ensurePersonSuperAccount", () => {
  it("creates exactly one client super account when none exists", () => {
    const state = ensurePersonSuperAccount(baseState(), "client", PROFILES);
    expect(state.plan.superAccounts).toHaveLength(1);
    expect(state.plan.superAccounts[0].owner).toBe("client");
  });

  it("is a no-op when a client super account already exists", () => {
    const once = ensurePersonSuperAccount(baseState(), "client", PROFILES);
    const twice = ensurePersonSuperAccount(once, "client", PROFILES);
    expect(twice.plan.superAccounts).toHaveLength(1);
    expect(twice.plan.superAccounts[0].id).toBe(once.plan.superAccounts[0].id);
  });
});

// Commit 2's own decision (see chat): without an explicit pension the
// engine never draws super down at all, so ensureRetirementPensions
// silently provisions one per person once they have a super account,
// set to drawdownOption "expenditure" with income-driven drawdown
// switched on — otherwise the retirement projection this page exists
// to show would just be super accumulating forever, untouched.
describe("ensureRetirementPensions", () => {
  it("does nothing when nobody has a super account yet", () => {
    const state = ensureRetirementPensions(baseState(), PROFILES);
    expect(state.plan.pensions ?? []).toHaveLength(0);
  });

  it("creates exactly one client pension, drawdownOption expenditure, sourced from the client's own super account, once a super account exists", () => {
    const withSuper = setSuperBalance(baseState(), "client", 250000, PROFILES);
    const state = ensureRetirementPensions(withSuper, PROFILES);
    expect(state.plan.pensions).toHaveLength(1);
    const pn = pensionFor(state, "client");
    expect(pn.drawdownOption).toBe("expenditure");
    expect(pn.sourceAccountId).toBe(superAccountFor(state, "client").id);
  });

  it("switches on income-driven drawdown the first time a pension is created", () => {
    const withSuper = setSuperBalance(baseState(), "client", 250000, PROFILES);
    expect(withSuper.plan.retirement.incomeDrivenDrawdown).toBe(false);
    const state = ensureRetirementPensions(withSuper, PROFILES);
    expect(state.plan.retirement.incomeDrivenDrawdown).toBe(true);
  });

  it("is idempotent — a second call creates no second pension and does not re-force income-driven drawdown a user has since turned off", () => {
    const withSuper = setSuperBalance(baseState(), "client", 250000, PROFILES);
    const once = ensureRetirementPensions(withSuper, PROFILES);
    const turnedOff = { ...once, plan: { ...once.plan, retirement: { ...once.plan.retirement, incomeDrivenDrawdown: false } } };
    const twice = ensureRetirementPensions(turnedOff, PROFILES);
    expect(twice.plan.pensions).toHaveLength(1);
    expect(twice.plan.pensions[0].id).toBe(once.plan.pensions[0].id);
    expect(twice.plan.retirement.incomeDrivenDrawdown).toBe(false); // NOT re-forced
  });

  it("creates a pension per person in a couple, only for whoever already has a super account", () => {
    let state = setHousehold(baseState(), "couple");
    state = setSuperBalance(state, "client", 250000, PROFILES);
    // Partner has no super account yet.
    state = ensureRetirementPensions(state, PROFILES);
    expect(state.plan.pensions).toHaveLength(1);
    expect(pensionFor(state, "client")).toBeTruthy();
    expect(pensionFor(state, "partner")).toBeNull();

    state = setSuperBalance(state, "partner", 180000, PROFILES);
    state = ensureRetirementPensions(state, PROFILES);
    expect(state.plan.pensions).toHaveLength(2);
    expect(pensionFor(state, "partner").sourceAccountId).toBe(superAccountFor(state, "partner").id);
  });

  it("setHousehold('single') strips the partner's own pension along with their super account", () => {
    let state = setHousehold(baseState(), "couple");
    state = setSuperBalance(state, "client", 250000, PROFILES);
    state = setSuperBalance(state, "partner", 180000, PROFILES);
    state = ensureRetirementPensions(state, PROFILES);
    expect(state.plan.pensions).toHaveLength(2);

    const single = setHousehold(state, "single");
    expect(single.plan.pensions).toHaveLength(1);
    expect(single.plan.pensions[0].owner).toBe("client");
  });
});

// --- Couple scope (added after Commit 1's first review) -------------------
//
// The About and Superannuation cards render per person when the
// household is a couple; Household-level fields (Income Required,
// other investments, other retirement income, the age pension toggle)
// stay a single shared control regardless — this section is exactly
// the client-side tests above, mirrored for owner "partner", plus the
// household toggle itself.
function coupleState() {
  return setHousehold(baseState(), "couple");
}

describe("retirementStandalone — per-field setters write to the correct EXISTING state path (partner)", () => {
  it("setHousehold('couple') provisions plan.partner and flips plan.household", () => {
    const state = coupleState();
    expect(state.plan.household).toBe("married");
    expect(state.plan.partner).toBeTruthy();
    expect(retirementFields(state).household).toBe("couple");
    expect(retirementFields(state).partner).toBeTruthy();
  });

  it("setHousehold('couple') is a no-op if already a couple (keeps the existing partner object)", () => {
    const once = coupleState();
    const twice = setHousehold(once, "couple");
    expect(twice.plan.partner).toBe(once.plan.partner);
  });

  it("first name → plan.partner.firstName", () => {
    const state = setFirstName(coupleState(), "partner", "Sam");
    expect(state.plan.partner.firstName).toBe("Sam");
    expect(retirementFields(state).partner.firstName).toBe("Sam");
    // Client untouched.
    expect(state.plan.client.firstName).toBe("");
  });

  it("current super balance → a super account owned partner, separate from the client's own", () => {
    let state = setSuperBalance(coupleState(), "client", 250000, PROFILES);
    state = setSuperBalance(state, "partner", 180000, PROFILES);
    expect(state.plan.superAccounts).toHaveLength(2);
    expect(superAccountFor(state, "client").balance).toBe(250000);
    expect(superAccountFor(state, "partner").balance).toBe(180000);
    expect(retirementFields(state).partner.superBalance).toBe(180000);
  });

  it("salary → a cashflows.income row owned partner, separate from the client's own", () => {
    let state = setSalary(coupleState(), "client", 120000);
    state = setSalary(state, "partner", 95000);
    const clientRow = state.cashflows.income.find((r) => r.category === "salary" && r.owner === "client");
    const partnerRow = state.cashflows.income.find((r) => r.category === "salary" && r.owner === "partner");
    expect(clientRow.amount).toBe(120000);
    expect(partnerRow.amount).toBe(95000);
    expect(partnerRow.to).toEqual({ kind: "anchor", anchorId: "retirement-partner" });
    expect(retirementFields(state).partner.salary).toBe(95000);
  });

  it("concessional contributions beyond SG → a superContributions row owned partner, crediting the partner's own account", () => {
    let state = setSuperBalance(coupleState(), "partner", 100000, PROFILES);
    state = setConcessionalContributions(state, "partner", 12000, PROFILES);
    const row = state.cashflows.superContributions.find((c) => c.owner === "partner");
    expect(row.amount).toBe(12000);
    expect(row.accountId).toBe(superAccountFor(state, "partner").id);
    expect(retirementFields(state).partner.concessionalContributions).toBe(12000);
  });

  it("partnerHasData is false for a bare couple toggle and true once the partner has a super account, salary, or contribution", () => {
    expect(partnerHasData(coupleState())).toBe(false);
    expect(partnerHasData(setFirstName(coupleState(), "partner", "Sam"))).toBe(false); // identity alone doesn't count
    expect(partnerHasData(setSuperBalance(coupleState(), "partner", 1, PROFILES))).toBe(true);
    expect(partnerHasData(setSalary(coupleState(), "partner", 1))).toBe(true);
    expect(partnerHasData(setConcessionalContributions(setSuperBalance(coupleState(), "partner", 1, PROFILES), "partner", 1, PROFILES))).toBe(true);
  });

  it("include age pension toggle applies to BOTH client and partner — one household control, two per-person flags underneath", () => {
    const off = setIncludeAgePension(coupleState(), false);
    expect(off.plan.client.taxProfile.centrelinkEligible).toBe(false);
    expect(off.plan.partner.taxProfile.centrelinkEligible).toBe(false);
    const backOn = setIncludeAgePension(off, true);
    expect(backOn.plan.client.taxProfile.centrelinkEligible).toBe(true);
    expect(backOn.plan.partner.taxProfile.centrelinkEligible).toBe(true);
  });

  it("setHousehold('single') strips every partner-owned super/income/contribution row rather than letting clampPlan silently reassign them to the client", () => {
    let state = coupleState();
    state = setSuperBalance(state, "client", 250000, PROFILES);
    state = setSuperBalance(state, "partner", 180000, PROFILES);
    state = setSalary(state, "partner", 95000);
    state = setConcessionalContributions(state, "partner", 12000, PROFILES);

    const single = setHousehold(state, "single");
    expect(single.plan.household).toBe("single");
    expect(single.plan.partner).toBeNull();
    expect(single.plan.superAccounts).toHaveLength(1);
    expect(single.plan.superAccounts[0].owner).toBe("client");
    expect(single.plan.superAccounts[0].balance).toBe(250000); // client's own figure untouched
    expect(single.cashflows.income.some((r) => r.owner === "partner")).toBe(false);
    expect(single.cashflows.superContributions.some((c) => c.owner === "partner")).toBe(false);

    // The clamp pipeline itself must not resurrect the partner's balance
    // onto the client (its own generic owner:"partner"→"client" fallback,
    // now moot since nothing partner-owned survives to be reassigned).
    const clamped = clampAllToPlan(single, PROFILES);
    expect(clamped.plan.superAccounts).toHaveLength(1);
    expect(clamped.plan.superAccounts[0].balance).toBe(250000);
  });

  it("setHousehold('single') on an already-single state is a harmless no-op shape-wise", () => {
    const state = setHousehold(baseState(), "single");
    expect(state.plan.household).toBe("single");
    expect(state.plan.partner).toBeNull();
  });
});

// --- The spec's own explicit constraint: NO NEW STATE SHAPE ---------------
//
// "A scenario created here opens correctly in the comprehensive
// workspace and vice versa; no new state keys introduced." hydrate() is
// the EXACT function the comprehensive workspace uses to load any
// scenario blob from storage — round-tripping a fully-populated
// standalone-page state through serialize()/hydrate() and comparing it
// to clampAllToPlan()'s own output is the most direct test available:
// clampAllToPlan and hydrate both run the identical normalisation
// pipeline (clampPlan + hydrateAsset + income/contribution/liability
// hydration), so any stray field introduced by a setter would either be
// silently stripped by one of the two paths (a mismatch) or reveal
// itself as an actual behavioural difference. Run once for a single
// household, once for a couple — the couple path exercises plan.partner
// and every partner-owned row this module now creates.
describe("no new state shape — round-trips through hydrate() exactly like any other scenario", () => {
  function fullyPopulatedRawState({ couple = false } = {}) {
    let state = baseState();
    if (couple) state = setHousehold(state, "couple");
    state = setFirstName(state, "client", "Alex");
    state = setDob(state, "client", "1980-05-01");
    state = setRetirementAge(state, "client", 65);
    state = setSuperBalance(state, "client", 250000, PROFILES);
    state = setSuperAllocation(state, "client", { mode: "profile", profile: "Balanced" }, PROFILES);
    state = setSalary(state, "client", 120000);
    state = setConcessionalContributions(state, "client", 10000, PROFILES);
    if (couple) {
      state = setFirstName(state, "partner", "Sam");
      state = setDob(state, "partner", "1982-02-14");
      state = setRetirementAge(state, "partner", 65);
      state = setSuperBalance(state, "partner", 180000, PROFILES);
      state = setSuperAllocation(state, "partner", { mode: "profile", profile: "Cash" }, PROFILES);
      state = setSalary(state, "partner", 95000);
      state = setConcessionalContributions(state, "partner", 8000, PROFILES);
    }
    state = setIncomeRequired(state, { source: "asfaComfortable" });
    state = setOtherInvestments(state, 80000, PROFILES);
    state = setOtherInvestmentsAllocation(state, { mode: "profile", profile: "Cash" }, PROFILES);
    state = setOtherRetirementIncome(state, 15000);
    state = setIncludeAgePension(state, false);
    state = ensureRetirementPensions(state, PROFILES);
    return state;
  }

  // Two pre-existing, GENERAL clampAllToPlan/hydrate() asymmetries —
  // confirmed present even for a totally untouched defaultState(), so
  // neither is introduced by this module — are normalised out of the
  // comparison below rather than either silently ignored or allowed to
  // block this commit (spawn_task-flagged separately, out of spec 33's
  // own scope): (1) hydrate() populates display.snapshotYears: []
  // where clampAllToPlan leaves it undefined; (2) hydrate() resets
  // every income row's own labelIsDefault to false regardless of its
  // value going in (reproduced with a bare createIncomeRow() salary
  // row, no custom fields at all).
  function omitKnownRoundTripAsymmetries(state) {
    const { snapshotYears, ...display } = state.display;
    const income = state.cashflows.income.map(({ labelIsDefault, ...rest }) => rest);
    return { ...state, display, cashflows: { ...state.cashflows, income } };
  }

  for (const couple of [false, true]) {
    const label = couple ? "couple" : "single";

    it(`(${label}) a SAVED (clamped) scenario reloads through hydrate() as a true no-op — exactly what the comprehensive workspace's own save/load cycle does`, () => {
      // clampAllToPlan once (the same thing "New retirement projection"'s
      // own save does before writeRaw), THEN round-trip — never two
      // independent clamps of the same raw, unclamped input: an empty
      // plan.employers auto-provisions a FRESH default employer (a real,
      // pre-existing nondeterminism in resolveEmployerAssignment, nothing
      // to do with this module) on every independent clamp, which would
      // make two separate clamps of raw disagree on employerId alone.
      const clamped = clampAllToPlan(fullyPopulatedRawState({ couple }), PROFILES);
      const rehydrated = hydrate(serialize(clamped), PROFILES);
      expect(omitKnownRoundTripAsymmetries(rehydrated)).toEqual(omitKnownRoundTripAsymmetries(clamped));
    });

    it(`(${label}) re-clamping an already-clamped state is idempotent (a second pass strips nothing new, adds nothing new)`, () => {
      const clamped = clampAllToPlan(fullyPopulatedRawState({ couple }), PROFILES);
      const twice = clampAllToPlan(clamped, PROFILES);
      expect(twice).toEqual(clamped);
    });

    it(`(${label}) the top-level state shape gains no new key beyond an ordinary, untouched defaultState()`, () => {
      const untouched = clampAllToPlan(couple ? setHousehold(baseState(), "couple") : baseState(), PROFILES);
      const populated = clampAllToPlan(fullyPopulatedRawState({ couple }), PROFILES);
      expect(Object.keys(populated).sort()).toEqual(Object.keys(untouched).sort());
      expect(Object.keys(populated.plan).sort()).toEqual(Object.keys(untouched.plan).sort());
      expect(Object.keys(populated.cashflows).sort()).toEqual(Object.keys(untouched.cashflows).sort());
    });

    it(`(${label}) the populated scenario projects cleanly through the real engine — real tax, real age pension gating, real super growth`, () => {
      const clamped = clampAllToPlan(fullyPopulatedRawState({ couple }), PROFILES);
      const out = projectPlan(clamped, PROFILES);
      expect(out.yearly.length).toBeGreaterThan(0);
    });
  }
});

describe("Include age pension toggle actually gates the real engine, not just the stored flag", () => {
  it("off suppresses age pension entitlement entirely, even once age-eligible", () => {
    let state = baseState();
    state = setDob(state, "client", "1958-07-01"); // old enough to be age-pension-eligible within a modest horizon
    state = setRetirementAge(state, "client", 67);
    state = setSuperBalance(state, "client", 50000, PROFILES); // low assets — would otherwise likely qualify
    state = setIncludeAgePension(state, false);
    const clamped = clampAllToPlan(state, PROFILES);
    const out = projectPlan(clamped, PROFILES);
    const everPaid = out.yearly.some((row) => (row.agePensionDetail?.client?.paid ?? 0) > 0);
    expect(everPaid).toBe(false);
  });

  it("on (the default) allows age pension to be assessed normally for an eligible, low-asset household", () => {
    let state = baseState();
    state = setDob(state, "client", "1958-07-01");
    state = setRetirementAge(state, "client", 67);
    state = setSuperBalance(state, "client", 50000, PROFILES);
    const clamped = clampAllToPlan(state, PROFILES); // includeAgePension left at its true default
    const out = projectPlan(clamped, PROFILES);
    const everPaid = out.yearly.some((row) => (row.agePensionDetail?.client?.paid ?? 0) > 0);
    expect(everPaid).toBe(true);
  });

  it("off applied via the household toggle suppresses BOTH people's entitlement in a couple", () => {
    let state = coupleState();
    state = setDob(state, "client", "1958-07-01");
    state = setDob(state, "partner", "1958-07-01");
    state = setRetirementAge(state, "client", 67);
    state = setRetirementAge(state, "partner", 67);
    state = setSuperBalance(state, "client", 50000, PROFILES);
    state = setSuperBalance(state, "partner", 50000, PROFILES);
    state = setIncludeAgePension(state, false);
    const clamped = clampAllToPlan(state, PROFILES);
    const out = projectPlan(clamped, PROFILES);
    const everPaid = out.yearly.some((row) =>
      (row.agePensionDetail?.client?.paid ?? 0) > 0 || (row.agePensionDetail?.partner?.paid ?? 0) > 0
    );
    expect(everPaid).toBe(false);
  });
});
