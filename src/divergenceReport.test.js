// Reconciles docs/reference/divergence-analysis.md's own committed
// figures against measureDivergence()'s live output for each of the
// four scenarios (spec 30, Commit 3's own test requirement: "the
// report's figures reconcile to measureDivergence output for each
// scenario"). This is NOT a snapshot test — the report is
// regenerated deliberately, by hand, whenever the engine changes
// enough to move these numbers; this test exists so that if it DOES
// move and the report is NOT updated, CI catches the drift rather
// than a reader trusting a stale document.
//
// Anchored to the same "now" the report's own figures were generated
// from (2026-08-28) — every demo fixture is anchored to "today", so a
// different date would shift every age/FY-partial-year boundary and
// genuinely change the numbers, not just re-verify them.
import { describe, it, expect } from "vitest";
import { build as buildFirstHomeBuyer } from "./demo/firstHomeBuyer.js";
import { build as buildFamilyWithMortgage } from "./demo/familyWithMortgage.js";
import { build as buildHighEarnerPreRetirement } from "./demo/highEarnerPreRetirement.js";
import { build as buildRetiree } from "./demo/retiree.js";
import { measureDivergence } from "./divergence.js";
import { legacySurplusPeriod } from "./planState.js";

const NOW = new Date("2026-08-28");

// The control fixture — flat income/expenses, a 0%-real-return asset,
// no liabilities — same shape as staticProjection.test.js's own
// control scenario.
function controlState() {
  const asset = {
    id: "a1", name: "A1", include: true, owner: "client",
    distributions: "reinvest", balance: 100000,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
  };
  return {
    plan: {
      household: "single", client: { currentAge: 40 }, partner: null,
      endAge: 70, start: { year: 2026, month: 7 }, superAccounts: [], pensions: [],
    },
    assets: [asset], bonds: [], liabilities: [],
    cashflows: {
      income: [{ id: "i1", label: "Income", owner: "client", amount: 5000, frequency: "monthly", from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "cpi", indexExtraPct: 0, incomeType: "otherTaxable" }],
      expenses: [{ id: "e1", label: "Living", owner: "client", amount: 3000, frequency: "monthly", from: { kind: "age", age: 40 }, to: { kind: "age", age: 120 }, indexBasis: "cpi", indexExtraPct: 0 }],
      contributions: [], withdrawals: [], lumpSums: [], bondContributions: [],
    },
    settings: {
      surplus: { periods: [legacySurplusPeriod({ mode: "spend", assetId: null })] },
      fundingOrder: ["a1"],
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
    assumptions: { cpi: 0.025, bracketMode: "indexed" },
    display: { units: "real" },
  };
}

describe("Divergence analysis report reconciles to measureDivergence (spec 30, Commit 3)", () => {
  it("control: exact agreement, zero residual", () => {
    const result = measureDivergence(controlState(), { snapshotYears: 0, indexation: "cpi" });
    expect(result.summary.atEnd.pctDiff).toBeCloseTo(0, 6);
    expect(result.totalGap).toBeCloseTo(0, 4);
    expect(result.residual).toBeCloseTo(0, 4);
  });

  it("First home buyer: +32.1% at end, super/pension transitions the largest driver", () => {
    const state = buildFirstHomeBuyer(NOW).scenarios[0].state;
    const result = measureDivergence(state, { snapshotYears: 0, indexation: "cpi" });
    expect(result.summary.atEnd.pctDiff * 100).toBeCloseTo(32.1, 0);
    expect(result.drivers[0].key).toBe("superPensionTransitions");
    expect(result.drivers[0].contribution).toBeCloseTo(-498964, -2);
    expect(result.residual).toBeCloseTo(158680, -2);
  });

  it("Family with a mortgage: +5.0% at end, contributions stopping the largest driver, residual exceeds the total gap", () => {
    const state = buildFamilyWithMortgage(NOW).scenarios[0].state;
    const result = measureDivergence(state, { snapshotYears: 0, indexation: "cpi" });
    expect(result.summary.atEnd.pctDiff * 100).toBeCloseTo(5.0, 0);
    expect(result.drivers[0].key).toBe("contributionsStopping");
    expect(Math.abs(result.residual)).toBeGreaterThan(Math.abs(result.totalGap));
  });

  it("High earner pre-retirement: +7.4% at end, contributions stopping the largest driver, residual several times the total gap", () => {
    const state = buildHighEarnerPreRetirement(NOW).scenarios[0].state;
    const result = measureDivergence(state, { snapshotYears: 0, indexation: "cpi" });
    expect(result.summary.atEnd.pctDiff * 100).toBeCloseTo(7.4, 0);
    expect(result.drivers[0].key).toBe("contributionsStopping");
    expect(Math.abs(result.residual)).toBeGreaterThan(Math.abs(result.totalGap) * 3);
  });

  it("Retiree (snapshot year 2, the first steady-state year): +15.7% at end, contributions stopping the largest driver", () => {
    const state = buildRetiree(NOW).scenarios[0].state;
    // Snapshot years 0 and 1 straddle the pension's own commencement
    // event (opening balance definitionally 0 either just before or
    // during the one-off rollover-in) — see the report's own note and
    // demo/retiree.js's header. Year 2 is the first genuinely
    // steady-state year.
    const result = measureDivergence(state, { snapshotYears: 2, indexation: "cpi" });
    expect(result.summary.atEnd.pctDiff * 100).toBeCloseTo(15.7, 0);
    expect(result.drivers[0].key).toBe("contributionsStopping");
  });

  it("Retiree: snapshotting the commencement year itself (year 1) produces a degenerate, not-representative result — the reason year 2 is used", () => {
    const state = buildRetiree(NOW).scenarios[0].state;
    const atCommencement = measureDivergence(state, { snapshotYears: 1, indexation: "cpi" });
    const steadyState = measureDivergence(state, { snapshotYears: 2, indexation: "cpi" });
    // Two full orders of magnitude apart — not a close call.
    expect(Math.abs(atCommencement.summary.atEnd.pctDiff)).toBeGreaterThan(Math.abs(steadyState.summary.atEnd.pctDiff) * 10);
  });
});
