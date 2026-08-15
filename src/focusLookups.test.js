import { describe, it, expect } from "vitest";
import { projectPlan } from "./deterministic.js";
import { transferDuty, dutyWithConcessions, fhogAmount } from "./data/stampDuty.js";
import { lmiPremium } from "./data/lmiRates.js";
import { computeStampDutyLookup, computeLmiLookup, STATES } from "./focusLookups.js";

describe("computeStampDutyLookup", () => {
  it("duty/general/fhog reconcile exactly to the underlying stampDuty.js functions", () => {
    for (const stateCode of STATES) {
      const r = computeStampDutyLookup({ stateCode, price: 600000, firstHomeBuyer: true, newBuild: true });
      expect(r.general).toBe(transferDuty(stateCode, 600000));
      expect(r.duty).toBe(dutyWithConcessions(stateCode, 600000, { firstHomeBuyer: true, newBuild: true }));
      expect(r.fhog).toBe(fhogAmount(stateCode, 600000, { firstHomeBuyer: true, newBuild: true }));
      expect(r.concessionSaving).toBeCloseTo(r.general - r.duty, 6);
    }
  });

  it("no concession requested — duty equals the general schedule, no saving", () => {
    const r = computeStampDutyLookup({ stateCode: "NSW", price: 900000, firstHomeBuyer: false, newBuild: false });
    expect(r.duty).toBe(r.general);
    expect(r.concessionSaving).toBe(0);
  });
});

describe("computeLmiLookup", () => {
  it("LMI reconciles exactly to lmiPremium for a standard (non-FHBG) purchase", () => {
    const r = computeLmiLookup({ stateCode: "NSW", price: 600000, lvrPct: 90 });
    expect(r.loanAmount).toBeCloseTo(540000, 6);
    expect(r.lmi).toBe(lmiPremium(90, 540000));
    expect(r.lmi).toBeGreaterThan(0);
    expect(r.waived).toBe(false);
  });

  it("at or below 80% LVR, LMI is zero", () => {
    const r = computeLmiLookup({ stateCode: "NSW", price: 600000, lvrPct: 80 });
    expect(r.lmi).toBe(0);
  });

  it("First Home Guarantee waives LMI outright, regardless of LVR", () => {
    const r = computeLmiLookup({ stateCode: "NSW", price: 600000, lvrPct: 95, firstHomeGuarantee: true });
    expect(r.lmi).toBe(0);
    expect(r.waived).toBe(true);
  });

  it("flags (never blocks) a price over the state's FHBG cap", () => {
    // NSW's FHBG cap is $900,000 (src/data/fhbgCaps.js).
    const overCap = computeLmiLookup({ stateCode: "NSW", price: 950000, lvrPct: 95, firstHomeGuarantee: true });
    expect(overCap.capExceeded).toBe(true);
    expect(overCap.lmi).toBe(0); // still waived — a flag, not a refusal

    const underCap = computeLmiLookup({ stateCode: "NSW", price: 800000, lvrPct: 95, firstHomeGuarantee: true });
    expect(underCap.capExceeded).toBe(false);
  });

  it("the cap flag never fires without First Home Guarantee selected", () => {
    const r = computeLmiLookup({ stateCode: "NSW", price: 5_000_000, lvrPct: 90, firstHomeGuarantee: false });
    expect(r.capExceeded).toBe(false);
  });
});

describe("reconciliation against the purchase engine (docs/specs/12-focus-views.md's own test requirement)", () => {
  // A property purchasing in month 0 of the projection (purchaseAt ===
  // currentAge) has nominalPrice === priceToday exactly, regardless of
  // growthPct/cpi — the cleanest apples-to-apples comparison against a
  // "purchase at this price today" lookup.
  function mkAsset(over = {}) {
    return {
      id: "a1", name: "Savings", include: true, owner: "client",
      distributions: "reinvest", balance: 3_000_000,
      allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
      icrPct: 0, cgtAsset: false, costBase: null,
      ...over,
    };
  }
  function prop(over = {}) {
    return {
      id: "p1", name: "First home", owner: "client", state: "NSW",
      propertyType: "ppr", status: "planned",
      currentValue: 0, acquisitionDate: null, costBase: null,
      priceToday: 600000, purchaseAt: { kind: "age", age: 40 },
      lvrPct: 90, firstHomeBuyer: true, newBuild: true,
      purchaseCostsPct: 2, dutyOverride: null, growthPct: 5,
      rent: { amount: 0, indexBasis: "cpi", indexExtraPct: 0 },
      expenses: { amount: 0, indexBasis: "cpi", indexExtraPct: 0 },
      expensesDeductible: true, depreciation: 0,
      releaseFhsssAtPurchase: false, firstHomeGuarantee: false,
      lmiOverride: null, lmiPayAtSettlement: true,
      ...over,
    };
  }
  function mkState(over = {}) {
    const assets = [mkAsset()];
    return {
      plan: {
        household: "single", client: { currentAge: 40 }, partner: null,
        endAge: 41, start: { year: 2026, month: 7 },
        superAccounts: [], workingCash: { balance: 0, minimumBalance: 0, ratePct: 2.5 },
      },
      assets, goals: [], liabilities: [], properties: [prop(over.propOver)],
      cashflows: {
        income: [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
        superContributions: [],
      },
      settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: ["a1"] },
      assumptions: { cpi: 0.025, bracketMode: "indexed" },
      display: { units: "real" },
    };
  }

  it("duty and FHOG match the lookup exactly for a purchase firing at month 0", () => {
    // 750,000 sits inside QLD's FHB taper (exempt to 700k, full duty
    // from 800k) and at the FHOG cap itself — both duty AND the grant
    // are genuinely nonzero here, not a degenerate edge case.
    const state = mkState({ propOver: { state: "QLD", priceToday: 750000, firstHomeBuyer: true, newBuild: true } });
    const out = projectPlan(state);
    const row = out.yearly[0].properties.p1;
    expect(row.duty).toBeGreaterThan(0); // sanity: the purchase actually fired this year
    expect(row.fhog).toBeGreaterThan(0);
    const lookup = computeStampDutyLookup({ stateCode: "QLD", price: 750000, firstHomeBuyer: true, newBuild: true });
    expect(row.duty).toBeCloseTo(lookup.duty, 2);
    expect(row.fhog).toBeCloseTo(lookup.fhog, 2);
  });

  it("LMI matches the lookup exactly for a purchase above 80% LVR", () => {
    const state = mkState({ propOver: { state: "VIC", priceToday: 500000, lvrPct: 90, firstHomeBuyer: false, newBuild: false } });
    const out = projectPlan(state);
    const row = out.yearly[0].properties.p1;
    const lookup = computeLmiLookup({ stateCode: "VIC", price: 500000, lvrPct: 90 });
    expect(lookup.lmi).toBeGreaterThan(0);
    expect(row.lmi).toBeCloseTo(lookup.lmi, 2);
  });

  it("the First Home Guarantee waiver matches the lookup: LMI zero despite a high LVR", () => {
    const state = mkState({ propOver: { state: "SA", priceToday: 500000, lvrPct: 95, firstHomeGuarantee: true } });
    const out = projectPlan(state);
    const row = out.yearly[0].properties.p1;
    const lookup = computeLmiLookup({ stateCode: "SA", price: 500000, lvrPct: 95, firstHomeGuarantee: true });
    expect(lookup.lmi).toBe(0);
    expect(row.lmi).toBe(0);
  });
});
