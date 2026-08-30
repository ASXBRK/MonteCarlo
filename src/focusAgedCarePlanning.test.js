import { describe, it, expect } from "vitest";
import { defaultState, clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";
import { buildAgedCarePlanningFocus } from "./focusAgedCarePlanning.js";

function fixtureState({ balance = 1_500_000, entryAge = 82 } = {}) {
  let state = defaultState(PROFILES, new Date(2026, 7, 28));
  state.assets[0].balance = balance;
  state.plan.agedCare = [{
    id: "ac-1", name: "Aged care — Client", owner: "client",
    entryAt: { kind: "age", age: entryAge },
    facility: "", accommodationPrice: 500000, paymentMethod: "combination",
    radAmount: 250000, extraServiceFeesAnnual: 0,
    formerHomeOccupiedByProtectedPerson: false, optedIntoNewRegime: false,
  }];
  return clampAllToPlan(state, PROFILES);
}

describe("focusAgedCarePlanning.js — pre-entry planning (spec 29 Commit 5)", () => {
  it("returns null when the entry id doesn't match a real aged care entry", () => {
    const state = fixtureState();
    expect(buildAgedCarePlanningFocus({ state, agedCareEntryId: "not-a-real-entry" })).toBeNull();
  });

  it("with no gift amount, returns only the current-plan arm", () => {
    const state = fixtureState();
    const result = buildAgedCarePlanningFocus({ state, agedCareEntryId: "ac-1" });
    expect(result).not.toBeNull();
    expect(result.arms.map((a) => a.id)).toEqual(["current"]);
    expect(result.arms[0].totalCostOfCare).toBeGreaterThan(0);
  });

  it("a pre-entry gift produces a second arm with its own total cost of care and estate position", () => {
    const state = fixtureState();
    const result = buildAgedCarePlanningFocus({ state, agedCareEntryId: "ac-1", giftAmount: 20000, giftYearsBeforeEntry: 6 });
    expect(result.arms.map((a) => a.id)).toEqual(["current", "gift"]);
    const giftArm = result.arms.find((a) => a.id === "gift");
    expect(giftArm.giftAmount).toBe(20000);
    expect(giftArm.giftAge).toBeLessThan(result.entryAge);
    expect(typeof giftArm.totalCostOfCare).toBe("number");
    expect(typeof giftArm.estatePosition).toBe("number");
  });

  it("a gift given 6+ years before entry, within the exempt limits, is not caught by deprivation", () => {
    const state = fixtureState();
    const result = buildAgedCarePlanningFocus({ state, agedCareEntryId: "ac-1", giftAmount: 10000, giftYearsBeforeEntry: 6 });
    const giftArm = result.arms.find((a) => a.id === "gift");
    expect(giftArm.deprivationCaught).toBe(false);
  });

  it("a large gift given within five years of entry is caught by the deprivation rules", () => {
    const state = fixtureState();
    const result = buildAgedCarePlanningFocus({ state, agedCareEntryId: "ac-1", giftAmount: 100000, giftYearsBeforeEntry: 2 });
    const giftArm = result.arms.find((a) => a.id === "gift");
    expect(giftArm.deprivationCaught).toBe(true);
  });

  it("the same large gift given 5+ years before entry is not caught (the window has lapsed by entry)", () => {
    const state = fixtureState();
    const result = buildAgedCarePlanningFocus({ state, agedCareEntryId: "ac-1", giftAmount: 100000, giftYearsBeforeEntry: 5 });
    const giftArm = result.arms.find((a) => a.id === "gift");
    expect(giftArm.deprivationCaught).toBe(false);
  });

  it("the gift age is clamped to no earlier than the client's current age", () => {
    const state = fixtureState({ entryAge: 82 });
    const currentAge = state.plan.client.currentAge;
    const result = buildAgedCarePlanningFocus({ state, agedCareEntryId: "ac-1", giftAmount: 10000, giftYearsBeforeEntry: 50 });
    const giftArm = result.arms.find((a) => a.id === "gift");
    expect(giftArm.giftAge).toBe(currentAge);
  });
});
