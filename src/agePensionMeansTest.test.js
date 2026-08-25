import { describe, it, expect } from "vitest";
import { agePensionRatesFor, WORK_BONUS } from "./data/agePension.js";
import {
  assessableAssets, assetsTestResult, deemedIncome, assessableIncome, incomeTestResult,
  agePensionEntitlement, singleAgePensionAssessment, coupleAgePensionAssessment, workBonusApply,
} from "./agePensionMeansTest.js";

const RATES = agePensionRatesFor(2026, "indexed", 0.025, 0.035); // FY2026/27 base — exact firm figures

describe("assessableAssets — the accumulation-vs-pension-phase super rule (Commit 2)", () => {
  it("accumulation super is exempt below age pension age", () => {
    const total = assessableAssets({
      financialAssets: 100000, accumulationSuper: 500000, agePensionAgeReached: false,
    });
    expect(total).toBe(100000); // the $500k accumulation balance is entirely exempt
  });

  it("accumulation super is assessed once age pension age is reached", () => {
    const total = assessableAssets({
      financialAssets: 100000, accumulationSuper: 500000, agePensionAgeReached: true,
    });
    expect(total).toBe(600000);
  });

  it("pension-phase super is assessed REGARDLESS of age — the rule that drives strategy", () => {
    const belowAge = assessableAssets({
      financialAssets: 100000, pensionSuper: 500000, agePensionAgeReached: false,
    });
    const atAge = assessableAssets({
      financialAssets: 100000, pensionSuper: 500000, agePensionAgeReached: true,
    });
    expect(belowAge).toBe(600000);
    expect(atAge).toBe(600000);
  });

  it("a couple with an age gap: the younger-spouse strategy — moving super to pension phase changes the household total even while the younger partner is below age pension age", () => {
    // Household total when the younger partner's super stays in
    // accumulation (exempt) vs is moved to pension phase (assessed) —
    // this is exactly the strategic lever the spec calls out.
    const stillAccumulating = assessableAssets({
      financialAssets: 50000, accumulationSuper: 400000, agePensionAgeReached: false,
    });
    const movedToPension = assessableAssets({
      financialAssets: 50000, pensionSuper: 400000, agePensionAgeReached: false,
    });
    expect(stillAccumulating).toBe(50000);
    expect(movedToPension).toBe(450000);
  });

  it("liabilities secured against an assessed asset reduce the total", () => {
    const total = assessableAssets({ financialAssets: 100000, investmentProperty: 500000, securedLiabilities: 300000 });
    expect(total).toBe(300000);
  });

  it("floors at zero when secured liabilities exceed gross assessable assets", () => {
    const total = assessableAssets({ financialAssets: 10000, securedLiabilities: 50000 });
    expect(total).toBe(0);
  });

  it("the principal residence never appears here — it's excluded by the caller before assembly, not by this function", () => {
    // Structural proof: no ppr/mainResidence parameter exists to pass.
    const total = assessableAssets({ financialAssets: 20000 });
    expect(total).toBe(20000);
  });

  // Gifting and deprivation (spec 21b, Commit 2) — a deprived asset is
  // assessed at face value here, on top of every other bucket.
  it("adds deprived assets on top of every other bucket", () => {
    const total = assessableAssets({ financialAssets: 20000, deprivedAssets: 5000 });
    expect(total).toBe(25000);
  });
});

describe("assetsTestResult — known values (Commit 2)", () => {
  it("full rate at or below the threshold", () => {
    expect(assetsTestResult({ assessableAssets: 300000, maxRate: 31223.40, fullPensionThreshold: 333000, reductionRatePer1000: 78 })).toBe(31223.40);
    expect(assetsTestResult({ assessableAssets: 333000, maxRate: 31223.40, fullPensionThreshold: 333000, reductionRatePer1000: 78 })).toBe(31223.40);
  });

  it("reduces by $78/yr per $1,000 above the threshold — hand-computed", () => {
    // $50,000 above threshold → 50 × $78 = $3,900/yr reduction.
    const result = assetsTestResult({ assessableAssets: 383000, maxRate: 31223.40, fullPensionThreshold: 333000, reductionRatePer1000: 78 });
    expect(result).toBeCloseTo(31223.40 - 3900, 6);
  });

  it("floors at zero beyond the cut-out", () => {
    const result = assetsTestResult({ assessableAssets: 5000000, maxRate: 31223.40, fullPensionThreshold: 333000, reductionRatePer1000: 78 });
    expect(result).toBe(0);
  });
});

describe("deemedIncome and assessableIncome — known values (Commit 2)", () => {
  it("all financial assets deemed at the lower rate, below the threshold", () => {
    expect(deemedIncome({ financialAssets: 50000, lowerRate: 0.0125, upperRate: 0.0325, threshold: 66800 })).toBeCloseTo(625, 6);
  });

  it("two-tier deeming above the threshold — hand-computed", () => {
    // 66,800 × 1.25% + (150,000 - 66,800) × 3.25% = 835 + 2,704 = 3,539.
    const result = deemedIncome({ financialAssets: 150000, lowerRate: 0.0125, upperRate: 0.0325, threshold: 66800 });
    expect(result).toBeCloseTo(66800 * 0.0125 + 83200 * 0.0325, 6);
  });

  it("assessableIncome combines deemed and other income", () => {
    expect(assessableIncome({ deemedIncome: 3539, otherIncome: 10000 })).toBe(13539);
  });
});

describe("incomeTestResult — known values (Commit 2)", () => {
  it("full rate at or below the free area", () => {
    expect(incomeTestResult({ assessableIncome: 5000, maxRate: 31223.40, freeArea: 5876, reductionRate: 0.5 })).toBe(31223.40);
  });

  it("reduces 50c per dollar above the free area — hand-computed", () => {
    // $2,000 above the free area → 2,000 × 0.5 = $1,000 reduction.
    const result = incomeTestResult({ assessableIncome: 7876, maxRate: 31223.40, freeArea: 5876, reductionRate: 0.5 });
    expect(result).toBeCloseTo(31223.40 - 1000, 6);
  });

  it("floors at zero", () => {
    const result = incomeTestResult({ assessableIncome: 1000000, maxRate: 31223.40, freeArea: 5876, reductionRate: 0.5 });
    expect(result).toBe(0);
  });
});

describe("agePensionEntitlement — the lower test binds (Commit 2)", () => {
  it("assets test binds when it's the lower result", () => {
    const r = agePensionEntitlement({ assetsResult: 10000, incomeResult: 20000 });
    expect(r.entitlement).toBe(10000);
    expect(r.bindingTest).toBe("assets");
  });

  it("income test binds when it's the lower result", () => {
    const r = agePensionEntitlement({ assetsResult: 25000, incomeResult: 8000 });
    expect(r.entitlement).toBe(8000);
    expect(r.bindingTest).toBe("income");
  });

  it("a tie reports 'assets' deterministically", () => {
    const r = agePensionEntitlement({ assetsResult: 15000, incomeResult: 15000 });
    expect(r.entitlement).toBe(15000);
    expect(r.bindingTest).toBe("assets");
  });

  it("never negative even if a caller hands in a negative result", () => {
    const r = agePensionEntitlement({ assetsResult: -100, incomeResult: 5000 });
    expect(r.entitlement).toBe(0);
  });
});

describe("singleAgePensionAssessment — homeowner vs non-homeowner (Commit 2)", () => {
  it("a homeowner single with modest assets gets the full rate", () => {
    const r = singleAgePensionAssessment({ assessableAssets: 100000, assessableIncome: 0, rates: RATES, homeowner: true });
    expect(r.entitlement).toBeCloseTo(RATES.single.rate, 6);
  });

  it("the SAME assets level assessed as a non-homeowner is still under the (higher) non-homeowner threshold, so still full rate", () => {
    const r = singleAgePensionAssessment({ assessableAssets: 550000, assessableIncome: 0, rates: RATES, homeowner: false });
    expect(r.entitlement).toBeCloseTo(RATES.single.rate, 6);
  });

  it("the SAME assets level as a homeowner (above the lower homeowner threshold) is reduced", () => {
    const r = singleAgePensionAssessment({ assessableAssets: 550000, assessableIncome: 0, rates: RATES, homeowner: true });
    expect(r.entitlement).toBeLessThan(RATES.single.rate);
  });
});

describe("coupleAgePensionAssessment — combined assessment, split entitlement (Commit 2)", () => {
  it("a couple's combined assets are tested against the combined threshold, then entitlement is split in half", () => {
    const r = coupleAgePensionAssessment({ assessableAssets: 200000, assessableIncome: 0, rates: RATES, homeowner: true });
    expect(r.entitlement).toBeCloseTo(RATES.couple.rateCombined, 6);
    expect(r.each).toBeCloseTo(RATES.couple.rateCombined / 2, 6);
    expect(r.each).toBeCloseTo(RATES.couple.rateEach, 6); // full rate → each gets the full each-rate
  });

  it("reduces the combined entitlement, still split evenly, once above the combined threshold", () => {
    const r = coupleAgePensionAssessment({ assessableAssets: 599000, assessableIncome: 0, rates: RATES, homeowner: true }); // 100,000 above 499,000
    const expectedCombined = RATES.couple.rateCombined - (100000 / 1000) * 78;
    expect(r.entitlement).toBeCloseTo(expectedCombined, 6);
    expect(r.each).toBeCloseTo(expectedCombined / 2, 6);
  });

  it("income test binds for a couple with heavy deemed income but modest assets", () => {
    const highDeemedIncome = 60000; // well above the couple free area
    const r = coupleAgePensionAssessment({ assessableAssets: 50000, assessableIncome: highDeemedIncome, rates: RATES, homeowner: true });
    expect(r.bindingTest).toBe("income");
    expect(r.entitlement).toBeLessThan(RATES.couple.rateCombined);
  });
});

describe("workBonusApply — Work Bonus and the income bank (spec 21b, Commit 1)", () => {
  const { exemptAnnual, bankCap } = WORK_BONUS;

  it("exempts up to $7,800/yr ($300/fortnight equivalent) of employment income outright", () => {
    const r = workBonusApply({ employmentIncome: 5000, bank: 0, exemptAnnual, bankCap });
    expect(r.exempt).toBe(5000); // fully under the annual allowance
  });

  it("the bank accrues the UNUSED allowance, capped, and no further", () => {
    // $0 employment income → the whole $7,800 allowance goes unused.
    const r1 = workBonusApply({ employmentIncome: 0, bank: 10000, exemptAnnual, bankCap });
    expect(r1.bank).toBe(bankCap); // 10,000 + 7,800 would exceed the cap — pinned at 11,800
    const r2 = workBonusApply({ employmentIncome: 0, bank: 0, exemptAnnual, bankCap });
    expect(r2.bank).toBe(exemptAnnual); // 0 + 7,800, well under the cap
  });

  it("the bank is drawn down in a high-employment-income year", () => {
    // $10,000 employment income: $7,800 exempt outright, $2,200 excess
    // drawn from an existing bank of $5,000.
    const r = workBonusApply({ employmentIncome: 10000, bank: 5000, exemptAnnual, bankCap });
    expect(r.exempt).toBe(exemptAnnual + 2200);
    expect(r.bank).toBe(5000 - 2200);
  });

  it("draws only as much as the bank actually holds, leaving the rest assessable", () => {
    // $20,000 employment income, $10,200 excess, but only $1,000 in the bank.
    const r = workBonusApply({ employmentIncome: 20000, bank: 1000, exemptAnnual, bankCap });
    expect(r.exempt).toBe(exemptAnnual + 1000);
    expect(r.bank).toBe(0);
  });

  it("new-recipient starting balance is a caller concern (WORK_BONUS.startingBalance), not this function's default", () => {
    expect(WORK_BONUS.startingBalance).toBe(4000);
  });

  it("investment/rental income is structurally unaffected — this function only ever sees employmentIncome", () => {
    // The caller passes ONLY employment income; deemed/rental income
    // never reaches this function at all, so there is nothing here to
    // assert beyond the parameter's own name — a real "does the caller
    // wire it correctly" check belongs in the engine-integration tests.
    const r = workBonusApply({ employmentIncome: 0, bank: 0, exemptAnnual, bankCap });
    expect(r.exempt).toBe(0);
  });
});
