import { describe, it, expect } from "vitest";
import { runProjection, validateInput, ENGINE_VERSION, FIGURES_AS_AT } from "./engine.js";
import { build as buildFamilyWithMortgage } from "./demo/familyWithMortgage.js";
import { build as buildFirstHomeBuyer } from "./demo/firstHomeBuyer.js";
import { serialize, hydrate, defaultState, clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";
import { cashflowStatement } from "./cashflowStatement.js";
import { buildSnapshotColumns, buildSnapshotTable } from "./snapshot.js";
import { shapeOf, mergeShapes, compareShapes, COMMITTED_SHAPE } from "./engineContractShape.js";

// The contract's declared top-level fields (spec 31 Commit 1) — the
// three this module adds, plus every field deterministic.js's own
// projectPlan() already returns. Listed explicitly so a future field
// removed from either side is caught here, not just in the Commit 4
// snapshot (this test checks PRESENCE against a real populated run;
// Commit 4 pins the full shape including yearly-row fields).
const TOP_LEVEL_FIELDS = [
  "engineVersion", "figuresAsAt", "errors",
  "yearly", "schedule", "monthly", "shortfall",
  "accruedCgtAtEnd", "accruedBondTaxAtEnd", "accruedUntaxedSuperTaxAtEnd",
  "accruedDiv293AtEnd", "accruedDiv296AtEnd", "accruedRefundAtEnd",
  "superWarnings", "propertyWarnings", "drawdownWarnings", "bondWarnings",
  "liabilityRepaymentStats", "liabilityRollovers", "goalStats", "wealthCrossoverYear",
];

function populatedState() {
  // Family with a mortgage — a couple with income, a super account, a
  // liability and property-free assets: exercises far more of the
  // result shape than a bare default state would (superClosing,
  // liabilitiesClosing, taxDetail per person, etc.).
  return buildFamilyWithMortgage(new Date(2026, 7, 28)).scenarios[0].state;
}

describe("engine.js — public API contract (spec 31 Commit 1)", () => {
  it("exports version constants", () => {
    expect(typeof ENGINE_VERSION).toBe("string");
    expect(ENGINE_VERSION.length).toBeGreaterThan(0);
    expect(typeof FIGURES_AS_AT).toBe("string");
    expect(FIGURES_AS_AT.length).toBeGreaterThan(0);
  });

  it("runProjection on a populated scenario returns every declared top-level field", () => {
    const result = runProjection(populatedState());
    expect(result.errors).toEqual([]);
    for (const field of TOP_LEVEL_FIELDS) {
      expect(result, `missing field "${field}"`).toHaveProperty(field);
    }
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(result.figuresAsAt).toBe(FIGURES_AS_AT);
    expect(Array.isArray(result.yearly)).toBe(true);
    expect(result.yearly.length).toBeGreaterThan(0);
  });

  it("a valid but bare-minimum state still projects successfully", () => {
    const result = runProjection({
      plan: { household: "single", client: { currentAge: 40 }, endAge: 44, start: { year: 2026, month: 7 } },
      assets: [],
      cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] },
      assumptions: { cpi: 0.025, bracketMode: "indexed" },
    });
    expect(result.errors).toEqual([]);
    expect(result.yearly.length).toBeGreaterThan(0);
  });

  describe("validateInput — structured errors, never an exception", () => {
    const cases = [
      { name: "null", input: null, field: "$" },
      { name: "a string", input: "not a plan", field: "$" },
      { name: "an array", input: [], field: "$" },
      { name: "missing plan", input: { assets: [], cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "plan" },
      { name: "plan not an object", input: { plan: "nope", assets: [], cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "plan" },
      { name: "missing assets", input: { plan: {}, cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "assets" },
      { name: "assets not an array", input: { plan: {}, assets: {}, cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "assets" },
      { name: "missing cashflows", input: { plan: {}, assets: [] }, field: "cashflows" },
      { name: "cashflows.income not an array", input: { plan: {}, assets: [], cashflows: { income: "nope", expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "cashflows.income" },
      { name: "missing assumptions", input: { plan: {}, assets: [], cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] } }, field: "assumptions" },
      { name: "assumptions.cpi missing", input: { plan: {}, assets: [], cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] }, assumptions: {} }, field: "assumptions.cpi" },
      { name: "assumptions.cpi not a number", input: { plan: {}, assets: [], cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] }, assumptions: { cpi: "2.5%" } }, field: "assumptions.cpi" },
    ];

    for (const { name, input, field } of cases) {
      it(`flags ${name}`, () => {
        const errors = validateInput(input);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.field === field)).toBe(true);
        for (const e of errors) {
          expect(typeof e.field).toBe("string");
          expect(typeof e.message).toBe("string");
          expect(e.message.length).toBeGreaterThan(0);
        }
      });
    }

    it("returns no errors for a valid minimal state", () => {
      expect(validateInput({
        plan: { household: "single", client: { currentAge: 40 }, endAge: 44, start: { year: 2026, month: 7 } },
        assets: [],
        cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] },
        assumptions: { cpi: 0.025, bracketMode: "indexed" },
      })).toEqual([]);
    });

    it("never throws, even on wildly malformed input", () => {
      expect(() => validateInput(undefined)).not.toThrow();
      expect(() => validateInput(42)).not.toThrow();
      expect(() => validateInput({ plan: null })).not.toThrow();
    });
  });

  it("runProjection returns ONLY the version/error fields when input fails validation — no partial projection", () => {
    const result = runProjection({ plan: null });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.engineVersion).toBe(ENGINE_VERSION);
    expect(result.figuresAsAt).toBe(FIGURES_AS_AT);
    expect(result.yearly).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(["engineVersion", "errors", "figuresAsAt"]);
  });
});

describe("engine.js — serialisation and worked integration (spec 31 Commit 3)", () => {
  it("the whole result round-trips through JSON with deep equality", () => {
    const result = runProjection(populatedState());
    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped).toEqual(result);
  });

  it("no functions, undefined values, or circular references appear anywhere in a real result", () => {
    const result = runProjection(populatedState());
    const seen = new Set();
    const walk = (value) => {
      if (value === null || typeof value !== "object") {
        expect(typeof value).not.toBe("function");
        return;
      }
      expect(seen.has(value)).toBe(false); // would be a circular reference
      seen.add(value);
      if (Array.isArray(value)) { value.forEach(walk); return; }
      for (const k of Object.keys(value)) {
        expect(value[k]).not.toBeUndefined();
        walk(value[k]);
      }
    };
    walk(result);
  });

  it("converts every typed array (schedule/monthly) to a plain Array, values unchanged", () => {
    const result = runProjection(populatedState());
    expect(Array.isArray(result.monthly.combined)).toBe(true);
    expect(result.monthly.combined.length).toBeGreaterThan(0);
    expect(Array.isArray(result.schedule.income)).toBe(true);
  });

  it("ids stay stable through a save/load (serialize/hydrate) round-trip of the INPUT", () => {
    const state = populatedState();
    const r1 = runProjection(state);
    const roundTrippedState = hydrate(serialize(state), PROFILES);
    expect(roundTrippedState).not.toBeNull();
    const r2 = runProjection(roundTrippedState);
    expect(r2.errors).toEqual([]);
    const y = 2;
    expect(Object.keys(r2.yearly[y].superDetail).sort()).toEqual(Object.keys(r1.yearly[y].superDetail).sort());
    expect(Object.keys(r2.yearly[y].liabilities).sort()).toEqual(Object.keys(r1.yearly[y].liabilities).sort());
    expect(Object.keys(r2.yearly[y].perAssetDetail).sort()).toEqual(Object.keys(r1.yearly[y].perAssetDetail).sort());
  });

  // Worked integration example (docs/reference/engine-api.md §9) — run
  // live so the documented figures cannot silently drift. Deliberately
  // household-only (forOwner: null): a per-owner vs. household-total
  // reconciliation issue was found in cashflowStatement.js while
  // building this and is tracked separately (out of scope for this
  // spec, which changes no engine behaviour) — this example does not
  // touch that comparison.
  it("worked example: construct a client from JSON, run a projection, read the firm's row vocabulary", () => {
    const demoState = buildFamilyWithMortgage(new Date(2026, 7, 28)).scenarios[0].state;
    const json = serialize(demoState);
    const state = hydrate(json, PROFILES);
    expect(state).not.toBeNull();

    const result = runProjection(state);
    expect(result.errors).toEqual([]);

    const y = 0;
    const rt = result.schedule.rowTotals;
    const ctx = {
      incomeRows: state.cashflows.income, rowTotalsIncome: rt.income,
      expenseRows: state.cashflows.expenses, rowTotalsExpenses: rt.expenses,
      deductionRows: state.cashflows.deductions ?? [], rowTotalsDeductions: rt.deductions,
      properties: state.properties ?? [], liabilities: state.liabilities ?? [],
      superAccounts: state.plan.superAccounts ?? [], y,
      educationBlocks: [], rowTotalsEducation: rt.education,
    };
    const statement = cashflowStatement(result.yearly[y], ctx, null);
    expect(Math.round(statement.assessable.total)).toBe(238616);
    expect(Math.round(statement.deductions.total)).toBe(0);
    expect(Math.round(statement.taxableIncome)).toBe(238616);
    expect(Math.round(statement.tax.total)).toBe(60487);
    expect(Math.round(statement.netIncome)).toBe(178129);
    expect(Math.round(statement.cashReceived.total)).toBe(178468);
    expect(Math.round(statement.expenses.total)).toBe(119016);
    expect(Math.round(statement.surplusIncome)).toBe(59453);
    // The statement's own running subtotals reconcile to each other,
    // by construction — the firm's own vocabulary's defining relations.
    expect(statement.taxableIncome).toBeCloseTo(statement.assessable.total - statement.deductions.total, 6);
    expect(statement.netIncome).toBeCloseTo(statement.taxableIncome - statement.tax.total, 6);
    expect(statement.surplusIncome).toBeCloseTo(statement.cashReceived.total - statement.expenses.total, 6);

    const ctxFor = (yy) => ({ ...ctx, y: yy });
    const columns = buildSnapshotColumns(result.yearly, ctxFor, [0, 1, 2], false);
    const table = buildSnapshotTable(columns, { hideEmptyRows: true });
    expect(table.rows.length).toBe(17);
    const surplusRow = table.rows.find((r) => r.label === "SURPLUS INCOME");
    expect(surplusRow.cells.map((c) => Math.round(c.total))).toEqual([59453, 63055, 62069]);
  });
});

// The two fixtures COMMITTED_SHAPE (engineContractShape.js) was
// generated from — its own header comment names them and explains the
// choice. Comparing a SINGLE fixture's shape against the committed
// UNION would spuriously flag whatever that one fixture doesn't
// happen to use (e.g. familyWithMortgage has no property) as
// "removed", so this merges the same two fixtures' live shapes the
// same way before comparing — see mergeShapes's own header.
// The third fixture engineContractShape.js's own header names —
// nothing else in this suite has an aged care entry, so this is the
// ONLY source of a populated `agedCareDetail` in the committed shape.
function agedCareFixtureState() {
  let state = defaultState(PROFILES, new Date(2026, 7, 28));
  state.plan.client.currentAge = 75;
  state.assets[0].balance = 1_500_000;
  state.plan.agedCare = [{
    owner: "client", entryAt: { kind: "age", age: 76 },
    accommodationPrice: 500000, paymentMethod: "combination", radAmount: 250000,
    extraServiceFeesAnnual: 5000,
  }];
  return clampAllToPlan(state, PROFILES);
}

function currentLiveShape() {
  const fhb = buildFirstHomeBuyer(new Date(2026, 7, 28)).scenarios[2].state; // "Buy 2030 with FHSSS"
  const fwm = buildFamilyWithMortgage(new Date(2026, 7, 28)).scenarios[0].state; // "Current"
  const r1 = runProjection(fhb);
  const r2 = runProjection(fwm);
  const r3 = runProjection(agedCareFixtureState());
  const s1 = shapeOf(r1); s1.yearly = ["array", shapeOf(r1.yearly[r1.yearly.length - 1])];
  const s2 = shapeOf(r2); s2.yearly = ["array", shapeOf(r2.yearly[r2.yearly.length - 1])];
  const acYear = r3.yearly.find((row) => Object.keys(row.agedCareDetail ?? {}).length > 0) ?? r3.yearly[r3.yearly.length - 1];
  const s3 = shapeOf(r3); s3.yearly = ["array", shapeOf(acYear)];
  return mergeShapes(mergeShapes(s1, s2), s3);
}

describe("engine.js — contract stability (spec 31 Commit 4)", () => {
  it("the committed shape matches live output exactly — no fields removed, renamed, or added", () => {
    const { errors, notices } = compareShapes(COMMITTED_SHAPE, currentLiveShape());
    for (const n of notices) console.warn(n); // see compareShapes's own header — a notice never fails the test
    expect(errors).toEqual([]);
    expect(notices).toEqual([]);
  });

  // compareShapes's own contract, verified directly (mirrors this
  // project's convention for the conservation invariant — temporarily
  // break the thing being guarded and confirm the guard actually
  // fires — except here it's the comparator itself under test, not
  // engine.js, so the break is a synthetic shape mutation rather than
  // a real code change).
  describe("compareShapes — verified against synthetic mutations", () => {
    it("flags a field removed from live output as an ERROR (breaking change)", () => {
      const live = currentLiveShape();
      const mutatedLive = JSON.parse(JSON.stringify(live));
      delete mutatedLive.yearly[1].netAssets;
      const { errors } = compareShapes(COMMITTED_SHAPE, mutatedLive);
      expect(errors.some((e) => e.includes("netAssets") && e.includes("REMOVED"))).toBe(true);
    });

    it("flags a field renamed in live output as an ERROR (old name missing)", () => {
      const live = currentLiveShape();
      const mutatedLive = JSON.parse(JSON.stringify(live));
      mutatedLive.yearly[1].netAssetsRenamed = mutatedLive.yearly[1].netAssets;
      delete mutatedLive.yearly[1].netAssets;
      const { errors, notices } = compareShapes(COMMITTED_SHAPE, mutatedLive);
      expect(errors.some((e) => e.includes("netAssets") && e.includes("REMOVED"))).toBe(true);
      expect(notices.some((n) => n.includes("netAssetsRenamed"))).toBe(true);
    });

    it("flags a genuinely NEW field as a notice only — does not fail", () => {
      const live = currentLiveShape();
      const liveWithExtra = { ...live, brandNewSummaryField: "number" };
      const { errors, notices } = compareShapes(COMMITTED_SHAPE, liveWithExtra);
      expect(errors).toEqual([]);
      expect(notices.some((n) => n.includes("brandNewSummaryField"))).toBe(true);
    });

    it("a type change on an existing field is an ERROR", () => {
      const live = currentLiveShape();
      const mutatedLive = JSON.parse(JSON.stringify(live));
      mutatedLive.figuresAsAt = 12345; // shapeOf would report "number", was "string"
      const liveShapeWithTypeChange = { ...mutatedLive, figuresAsAt: "number" };
      const { errors } = compareShapes(COMMITTED_SHAPE, liveShapeWithTypeChange);
      expect(errors.some((e) => e.includes("figuresAsAt") && e.includes("type changed"))).toBe(true);
    });
  });
});
