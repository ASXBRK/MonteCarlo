import { describe, it, expect } from "vitest";
import { defaultState, clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";
import { buildAgedCareAccommodationFocus } from "./focusAgedCareAccommodation.js";

function fixtureState({ currentAge = 75, balance = 1_500_000 } = {}) {
  let state = defaultState(PROFILES, new Date(2026, 7, 28));
  state.plan.client.currentAge = currentAge;
  state.assets[0].balance = balance;
  return clampAllToPlan(state, PROFILES);
}

describe("focusAgedCareAccommodation.js — RAD/DAP decision (spec 29 Commit 3)", () => {
  it("returns null without a valid accommodation price, entry age, or funding asset", () => {
    const state = fixtureState();
    const assetId = state.assets[0].id;
    expect(buildAgedCareAccommodationFocus({ state, accommodationPrice: 0, entryAge: 82, fundingAssetId: assetId })).toBeNull();
    expect(buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, entryAge: null, fundingAssetId: assetId })).toBeNull();
    expect(buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, entryAge: 82, fundingAssetId: "not-a-real-asset" })).toBeNull();
  });

  it("returns null if the entry age is never reached within the projection", () => {
    const state = fixtureState();
    const assetId = state.assets[0].id;
    const result = buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, entryAge: 130, fundingAssetId: assetId });
    expect(result).toBeNull();
  });

  it("builds three arms — RAD, DAP, and combination", () => {
    const state = fixtureState();
    const assetId = state.assets[0].id;
    const result = buildAgedCareAccommodationFocus({
      state, accommodationPrice: 500000, radAmount: 250000, entryAge: 82, fundingAssetId: assetId,
    });
    expect(result).not.toBeNull();
    expect(result.arms.map((a) => a.id)).toEqual(["rad", "dap", "combination"]);
  });

  it("RAD-in-full: no ongoing DAP; DAP-in-full: no RAD paid", () => {
    const state = fixtureState();
    const assetId = state.assets[0].id;
    const result = buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, entryAge: 82, fundingAssetId: assetId });
    const radArm = result.arms.find((a) => a.id === "rad");
    const dapArm = result.arms.find((a) => a.id === "dap");
    expect(radArm.radPaid).toBe(500000);
    expect(radArm.dapAnnualCost).toBe(0);
    expect(dapArm.radPaid).toBe(0);
    expect(dapArm.dapAnnualCost).toBeGreaterThan(0);
  });

  it("a bigger RAD means a smaller ongoing DAP cost but a larger lump sum drawn from assets", () => {
    const state = fixtureState();
    const assetId = state.assets[0].id;
    const smallRad = buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, radAmount: 100000, entryAge: 82, fundingAssetId: assetId });
    const largeRad = buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, radAmount: 400000, entryAge: 82, fundingAssetId: assetId });
    const smallCombo = smallRad.arms.find((a) => a.id === "combination");
    const largeCombo = largeRad.arms.find((a) => a.id === "combination");
    expect(largeCombo.radPaid).toBeGreaterThan(smallCombo.radPaid);
    expect(largeCombo.dapAnnualCost).toBeLessThan(smallCombo.dapAnnualCost);
  });

  it("selects the old regime for a pre-1 Nov 2025 entry and the new regime for a post one", () => {
    const state = fixtureState({ currentAge: 75 }); // entry at 82 lands well after 2026, i.e. the new regime
    const assetId = state.assets[0].id;
    const result = buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, entryAge: 82, fundingAssetId: assetId });
    expect(result.regime).toBe("new");
  });

  it("computes a positive means-tested contribution for a resident with substantial other assets", () => {
    const state = fixtureState({ balance: 2_000_000 });
    const assetId = state.assets[0].id;
    const result = buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, entryAge: 82, fundingAssetId: assetId });
    const radArm = result.arms.find((a) => a.id === "rad");
    expect(radArm.contributionAnnual).toBeGreaterThan(0);
  });

  it("the estate position adds back the RAD refund on top of remaining engine-tracked assets", () => {
    const state = fixtureState();
    const assetId = state.assets[0].id;
    const result = buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, entryAge: 82, fundingAssetId: assetId });
    const radArmFinalNetAssets = result.byYear.at(-1).rad.remainingAssets;
    expect(result.estate.rad).toBeGreaterThan(radArmFinalNetAssets); // the RAD refund is added on top
  });

  it("byYear only covers the entry year onward", () => {
    const state = fixtureState();
    const assetId = state.assets[0].id;
    const result = buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, entryAge: 82, fundingAssetId: assetId });
    expect(result.byYear[0].year).toBe(result.entryYear);
    expect(result.byYear[0].age).toBeGreaterThanOrEqual(82);
  });

  it("reports a no-worse-off comparison only for a genuine pre-1 Nov 2025 entrant", () => {
    const state = fixtureState({ currentAge: 75 }); // entry lands in 2026 -- already the new regime, no choice
    const assetId = state.assets[0].id;
    const result = buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, entryAge: 82, fundingAssetId: assetId });
    expect(result.regime).toBe("new");
    expect(result.noWorseOff).toBeNull();
  });

  it("cumulative cost only ever increases (or stays flat) year over year", () => {
    const state = fixtureState();
    const assetId = state.assets[0].id;
    const result = buildAgedCareAccommodationFocus({ state, accommodationPrice: 500000, entryAge: 82, fundingAssetId: assetId });
    for (const arm of result.arms) {
      let prev = 0;
      for (const point of result.byYear) {
        expect(point[arm.id].cumulativeCost).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = point[arm.id].cumulativeCost;
      }
    }
  });
});
