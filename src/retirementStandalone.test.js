import { describe, it, expect } from "vitest";
import {
  retirementFields, superAccountFor, findOtherInvestmentsAsset, ensurePersonSuperAccount,
  partnerHasData, setHousehold,
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
