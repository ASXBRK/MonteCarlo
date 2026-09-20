// assessmentIncomeBase — docs/specs/41-dependency-ordering-density.md
// Commit 3. One function, the base as a parameter, replacing what were
// two independently-spelled-out formulas (Division 293's own inline
// arithmetic, HELP/MLS's own inline arithmetic in deterministic.js).
// Known-value cases carry the hand calculation per this project's own
// testing convention (CLAUDE.md).

import { describe, it, expect } from "vitest";
import { assessmentIncomeBase } from "./assessmentIncomeBase.js";

describe("assessmentIncomeBase", () => {
  it("div293: taxable income + reportable super contributions + low-tax contributions + reportable fringe benefits", () => {
    // 200,000 + 15,000 + 12,000 + 3,000 = 230,000
    const income = assessmentIncomeBase("div293", {
      taxableIncome: 200_000, reportableSuperContributions: 15_000,
      lowTaxContributions: 12_000, reportableFringeBenefits: 3_000,
    });
    expect(income).toBe(230_000);
  });

  it("div293: net investment losses are NOT added back (documented gap, unchanged by this consolidation)", () => {
    const income = assessmentIncomeBase("div293", {
      taxableIncome: 100_000, reportableSuperContributions: 10_000,
      lowTaxContributions: 8_000, reportableFringeBenefits: 0, netInvestmentLoss: 20_000,
    });
    expect(income).toBe(118_000); // netInvestmentLoss silently ignored for this base
  });

  it("help: taxable income + reportable super contributions + net investment loss + reportable fringe benefits", () => {
    // 150,000 + 10,000 + 8,000 + 2,000 = 170,000
    const income = assessmentIncomeBase("help", {
      taxableIncome: 150_000, reportableSuperContributions: 10_000,
      netInvestmentLoss: 8_000, reportableFringeBenefits: 2_000,
    });
    expect(income).toBe(170_000);
  });

  it("help: low-tax contributions are NOT added back (that term is Division-293-specific)", () => {
    const income = assessmentIncomeBase("help", {
      taxableIncome: 100_000, reportableSuperContributions: 5_000,
      netInvestmentLoss: 0, reportableFringeBenefits: 0, lowTaxContributions: 50_000,
    });
    expect(income).toBe(105_000); // lowTaxContributions silently ignored for this base
  });

  it("mls: identical formula to help (same base, kept as a distinct id for a future refinement)", () => {
    const params = { taxableIncome: 90_000, reportableSuperContributions: 4_000, netInvestmentLoss: 1_000, reportableFringeBenefits: 500 };
    expect(assessmentIncomeBase("mls", params)).toBe(assessmentIncomeBase("help", params));
  });

  it("defaults every add-back term to 0", () => {
    expect(assessmentIncomeBase("div293", { taxableIncome: 80_000 })).toBe(80_000);
    expect(assessmentIncomeBase("help", { taxableIncome: 80_000 })).toBe(80_000);
  });

  it("rejects an unknown base rather than silently returning something wrong", () => {
    expect(() => assessmentIncomeBase("div296", { taxableIncome: 100_000 })).toThrow(/unknown base/);
    expect(() => assessmentIncomeBase("not-a-real-base", {})).toThrow(/unknown base/);
  });
});
