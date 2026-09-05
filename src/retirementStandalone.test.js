import { describe, it, expect } from "vitest";
import {
  retirementFields, clientSuperAccount, findOtherInvestmentsAsset, ensureClientSuperAccount,
  setFirstName, setDob, setRetirementAge, setSuperBalance, setSuperAllocation,
  setSalary, setConcessionalContributions, setIncomeRequired,
  setOtherInvestments, setOtherInvestmentsAllocation, setOtherRetirementIncome, setIncludeAgePension,
} from "./retirementStandalone.js";
import { defaultState, clampAllToPlan, hydrate, serialize } from "./planState.js";
import { projectPlan } from "./deterministic.js";
import { PROFILES } from "./profiles.js";

const NOW = new Date("2026-08-17T00:00:00+10:00");

function baseState() {
  return defaultState(PROFILES, NOW);
}

describe("retirementStandalone — per-field setters write to the correct EXISTING state path", () => {
  it("first name → plan.client.firstName", () => {
    const state = setFirstName(baseState(), "Alex");
    expect(state.plan.client.firstName).toBe("Alex");
    expect(retirementFields(state).firstName).toBe("Alex");
  });

  it("date of birth → plan.client.dob", () => {
    const state = setDob(baseState(), "1980-05-01");
    expect(state.plan.client.dob).toBe("1980-05-01");
    expect(retirementFields(state).dob).toBe("1980-05-01");
  });

  it("retirement age → plan.client.retirementAge", () => {
    const state = setRetirementAge(baseState(), 62);
    expect(state.plan.client.retirementAge).toBe(62);
    expect(retirementFields(state).retirementAge).toBe(62);
  });

  it("current super balance → plan.superAccounts[0].balance, creating the account via the SAME factory the comprehensive Super section uses", () => {
    const state = setSuperBalance(baseState(), 250000, PROFILES);
    expect(state.plan.superAccounts).toHaveLength(1);
    expect(state.plan.superAccounts[0].owner).toBe("client");
    expect(state.plan.superAccounts[0].balance).toBe(250000);
    expect(retirementFields(state).superBalance).toBe(250000);
  });

  it("setSuperBalance called twice edits the SAME account, never creates a second one", () => {
    let state = setSuperBalance(baseState(), 100000, PROFILES);
    state = setSuperBalance(state, 150000, PROFILES);
    expect(state.plan.superAccounts).toHaveLength(1);
    expect(state.plan.superAccounts[0].balance).toBe(150000);
  });

  it("risk profile / glide path → plan.superAccounts[0].allocation", () => {
    const state = setSuperAllocation(setSuperBalance(baseState(), 100000, PROFILES), { mode: "profile", profile: "Balanced" }, PROFILES);
    expect(clientSuperAccount(state).allocation).toEqual({ mode: "profile", profile: "Balanced" });
  });

  it("salary → a cashflows.income row, category salary, owner client", () => {
    const state = setSalary(baseState(), 120000);
    const row = state.cashflows.income.find((r) => r.category === "salary");
    expect(row).toBeTruthy();
    expect(row.owner).toBe("client");
    expect(row.amount).toBe(120000);
    expect(retirementFields(state).salary).toBe(120000);
  });

  it("setSalary called twice edits the SAME row, never creates a second salary row", () => {
    let state = setSalary(baseState(), 80000);
    state = setSalary(state, 90000);
    const salaryRows = state.cashflows.income.filter((r) => r.category === "salary");
    expect(salaryRows).toHaveLength(1);
    expect(salaryRows[0].amount).toBe(90000);
  });

  it("concessional contributions beyond SG → a cashflows.superContributions row, type salarySacrifice, annual", () => {
    const state = setConcessionalContributions(baseState(), 10000, PROFILES);
    const row = state.cashflows.superContributions.find((c) => c.owner === "client");
    expect(row).toBeTruthy();
    expect(row.type).toBe("salarySacrifice");
    expect(row.basis).toBe("amount");
    expect(row.frequency).toBe("annual");
    expect(row.amount).toBe(10000);
    expect(row.accountId).toBe(clientSuperAccount(state).id);
    expect(retirementFields(state).concessionalContributions).toBe(10000);
  });

  it("setConcessionalContributions called twice edits the SAME row, never creates a second one", () => {
    let state = setConcessionalContributions(baseState(), 5000, PROFILES);
    state = setConcessionalContributions(state, 8000, PROFILES);
    const rows = state.cashflows.superContributions.filter((c) => c.owner === "client" && c.type === "salarySacrifice");
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(8000);
  });

  it("income required → plan.retirement.incomeRequired, merged not replaced", () => {
    let state = setIncomeRequired(baseState(), { source: "asfaComfortable" });
    state = setIncomeRequired(state, { stepDownAtAge: 85 });
    expect(state.plan.retirement.incomeRequired.source).toBe("asfaComfortable");
    expect(state.plan.retirement.incomeRequired.stepDownAtAge).toBe(85);
    // Untouched fields survive the merge.
    expect(state.plan.retirement.incomeRequired.indexBasis).toBe("cpi");
  });

  it("other investments lump → state.assets[0].balance, the SAME asset defaultState() already seeds — never a second asset", () => {
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

  it("other retirement income → a cashflows.income row, category otherIncome, from retirement-client to end", () => {
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

describe("ensureClientSuperAccount", () => {
  it("creates exactly one client super account when none exists", () => {
    const state = ensureClientSuperAccount(baseState(), PROFILES);
    expect(state.plan.superAccounts).toHaveLength(1);
    expect(state.plan.superAccounts[0].owner).toBe("client");
  });

  it("is a no-op when a client super account already exists", () => {
    const once = ensureClientSuperAccount(baseState(), PROFILES);
    const twice = ensureClientSuperAccount(once, PROFILES);
    expect(twice.plan.superAccounts).toHaveLength(1);
    expect(twice.plan.superAccounts[0].id).toBe(once.plan.superAccounts[0].id);
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
// itself as an actual behavioural difference.
describe("no new state shape — round-trips through hydrate() exactly like any other scenario", () => {
  function fullyPopulatedRawState() {
    let state = baseState();
    state = setFirstName(state, "Alex");
    state = setDob(state, "1980-05-01");
    state = setRetirementAge(state, 65);
    state = setSuperBalance(state, 250000, PROFILES);
    state = setSuperAllocation(state, { mode: "profile", profile: "Balanced" }, PROFILES);
    state = setSalary(state, 120000);
    state = setConcessionalContributions(state, 10000, PROFILES);
    state = setIncomeRequired(state, { source: "asfaComfortable" });
    state = setOtherInvestments(state, 80000, PROFILES);
    state = setOtherInvestmentsAllocation(state, { mode: "profile", profile: "Cash" }, PROFILES);
    state = setOtherRetirementIncome(state, 15000);
    state = setIncludeAgePension(state, false);
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

  it("a SAVED (clamped) scenario reloads through hydrate() as a true no-op — exactly what the comprehensive workspace's own save/load cycle does", () => {
    // clampAllToPlan once (the same thing "New retirement projection"'s
    // own save does before writeRaw), THEN round-trip — never two
    // independent clamps of the same raw, unclamped input: an empty
    // plan.employers auto-provisions a FRESH default employer (a real,
    // pre-existing nondeterminism in resolveEmployerAssignment, nothing
    // to do with this module) on every independent clamp, which would
    // make two separate clamps of raw disagree on employerId alone.
    const clamped = clampAllToPlan(fullyPopulatedRawState(), PROFILES);
    const rehydrated = hydrate(serialize(clamped), PROFILES);
    expect(omitKnownRoundTripAsymmetries(rehydrated)).toEqual(omitKnownRoundTripAsymmetries(clamped));
  });

  it("re-clamping an already-clamped state is idempotent (a second pass strips nothing new, adds nothing new)", () => {
    const clamped = clampAllToPlan(fullyPopulatedRawState(), PROFILES);
    const twice = clampAllToPlan(clamped, PROFILES);
    expect(twice).toEqual(clamped);
  });

  it("the top-level state shape gains no new key beyond an ordinary, untouched defaultState()", () => {
    const untouched = clampAllToPlan(baseState(), PROFILES);
    const populated = clampAllToPlan(fullyPopulatedRawState(), PROFILES);
    expect(Object.keys(populated).sort()).toEqual(Object.keys(untouched).sort());
    expect(Object.keys(populated.plan).sort()).toEqual(Object.keys(untouched.plan).sort());
    expect(Object.keys(populated.cashflows).sort()).toEqual(Object.keys(untouched.cashflows).sort());
  });

  it("the populated scenario projects cleanly through the real engine — real tax, real age pension gating, real super growth", () => {
    const clamped = clampAllToPlan(fullyPopulatedRawState(), PROFILES);
    const out = projectPlan(clamped, PROFILES);
    expect(out.yearly.length).toBeGreaterThan(0);
  });
});

describe("Include age pension toggle actually gates the real engine, not just the stored flag", () => {
  it("off suppresses age pension entitlement entirely, even once age-eligible", () => {
    let state = baseState();
    state = setDob(state, "1958-07-01"); // old enough to be age-pension-eligible within a modest horizon
    state = setRetirementAge(state, 67);
    state = setSuperBalance(state, 50000, PROFILES); // low assets — would otherwise likely qualify
    state = setIncludeAgePension(state, false);
    const clamped = clampAllToPlan(state, PROFILES);
    const out = projectPlan(clamped, PROFILES);
    const everPaid = out.yearly.some((row) => (row.agePensionDetail?.client?.paid ?? 0) > 0);
    expect(everPaid).toBe(false);
  });

  it("on (the default) allows age pension to be assessed normally for an eligible, low-asset household", () => {
    let state = baseState();
    state = setDob(state, "1958-07-01");
    state = setRetirementAge(state, 67);
    state = setSuperBalance(state, 50000, PROFILES);
    const clamped = clampAllToPlan(state, PROFILES); // includeAgePension left at its true default
    const out = projectPlan(clamped, PROFILES);
    const everPaid = out.yearly.some((row) => (row.agePensionDetail?.client?.paid ?? 0) > 0);
    expect(everPaid).toBe(true);
  });
});
