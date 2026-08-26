import { describe, it, expect } from "vitest";
import {
  SCHEMA_VERSION, defaultState, createAsset, createCashflow,
  createLumpSum, createIncomeRow, createExpenseRow, clampExpenseRow,
  clampPlan, clampAllToPlan, clampAllocation, clampIncomeRow,
  INCOME_CATEGORY_LABELS, EXPENSE_CATEGORY_LABELS,
  nearestVolBasis, allocationTotalNominal, allocationSummary,
  normaliseFundingOrder, normaliseSettings,
  partnerOwnedItems, reassignPartnerToClient, deletePartnerOwned,
  removeAsset, cashflowRowsForAsset, ownerWindow, fyLabelForAge, horizonYears,
  serialize, hydrate, summarise, planSummaryText, annualisedAmount,
  tableLumpSumFor, upsertTableLumpSum, canEditOneOffYear, clampTaxProfile,
  ageAtDate, synthDob, resolveEndBasis, clampCashflow, createLifestyleAsset,
  clampLastVisited, isScenarioEffectivelyEmpty, sectionCounts,
  createLiability, clampLiability, createProperty, clampProperty,
  clampReportPeriod, clampChartTreatment, defaultChartTreatment,
  defaultReportPeriod, createKeyDate, clampKeyDate, normaliseKeyDates,
  clampDateRef, removeKeyDate, referencesToAnchor, convertAnchorReferences,
  DEFAULT_RETIREMENT_AGE,
  createSuperAccount, clampSuperAccount, normaliseSuperAccounts,
  createSuperContribution, clampSuperContribution, normaliseSuperContributions,
  createSuperWithdrawal, clampSuperWithdrawal, normaliseSuperWithdrawals,
  createPension, clampPension, normalisePensions, pensionMinCommenceAge, PENSION_TYPES,
  INCOME_TYPES, SUPER_CONTRIBUTION_TYPES, SUPER_CONTRIBUTION_BASES, CARRY_FORWARD_YEARS,
  clampWorkingCash,
  createDeductionRow, clampDeductionRow, DEDUCTION_CATEGORIES, DEDUCTION_CATEGORY_LABELS,
  createGoal, clampGoal, normaliseGoals,
  clampSnapshotYears, MAX_SNAPSHOT_YEARS,
  defaultAdviserFees, clampAdviserFees, defaultImplementation,
  clampImplementationBasic, refineImplementationAllocations, createAllocation,
  clampTouched,
  createChild, createEducationBlock, childCurrentAgeInfo, dependentChildrenCountInFY,
  childEducationPlanYearBounds, normaliseChildren, flatEducationBlocks,
  createSurplusPeriod, legacySurplusPeriod, clampSurplusPeriod, normaliseSurplusPeriods,
  ADJUSTMENT_TARGETS, ADJUSTMENT_TARGET_LABELS, createAdjustment, clampAdjustment, normaliseAdjustments,
  createHeas, clampHeas, refineHeasProperty,
  DEATH_BENEFIT_RELATIONSHIPS, isDeathBenefitTaxDependant,
  createDeathBenefitBeneficiary, clampDeathBenefitBeneficiary, clampDeathBenefit,
  createEmployer, clampEmployer, normaliseEmployers, resolveEmployerAssignment,
  INCOME_CATEGORIES, BONUS_DESTINATION_TYPES, clampBonusDestination, incomeCategoryTaxTreatment,
  FBT_TYPES, PACKAGING_TYPES,
  createNovatedLease, clampNovatedLease, normaliseNovatedLeases, RESIDUAL_DESTINATIONS,
  createDrawdown, clampDrawdown, DRAWDOWN_PURPOSES, REPAYMENT_ALLOCATIONS,
} from "./planState.js";
import { remainingLE } from "./data/lifeTables.js";
import { PROFILES, impliedFrankingPct } from "./profiles.js";

const PROFILE_KEYS = Object.keys(PROFILES);
const NOW = new Date("2026-08-12");

function couplePlan() {
  return {
    household: "couple",
    client: { currentAge: 40 },
    partner: { currentAge: 36 },
    endAge: 90,
    start: { year: 2026, month: 8 },
  };
}

describe("defaults (v3)", () => {
  it("produces a valid default state", () => {
    const s = defaultState(PROFILES, NOW);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.plan.household).toBe("single");
    expect(s.plan.client.currentAge).toBe(40);
    expect(s.plan.partner).toBeNull();
    expect(s.plan.start).toEqual({ year: 2026, month: 8 });
    expect(s.assets).toHaveLength(1);
    expect(s.assets[0].owner).toBe("client");
    expect(s.assets[0].distributions).toBe("reinvest");
    expect(s.cashflows.income).toEqual([]);
    expect(s.cashflows.expenses).toEqual([]);
    expect(s.cashflows.contributions).toHaveLength(1);
    expect(s.cashflows.contributions[0].assetId).toBe(s.assets[0].id);
    expect(s.settings.surplus.periods).toHaveLength(1);
    expect(s.settings.surplus.periods[0]).toMatchObject({
      payNonDeductibleDebtFirst: true, debtOrder: "interestRate", allocations: [], remainderTo: "cash",
      from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
    });
    expect(s.settings.fundingOrder).toEqual([s.assets[0].id]);
  });

  it("income/expense factories default sensibly", () => {
    const plan = couplePlan();
    const inc = createIncomeRow(plan, []);
    expect(inc.owner).toBe("client");
    expect(inc.frequency).toBe("annual");
    // New rows open already anchored (Tier 1.1): Start → Retirement for
    // income, no numbers typed into an age box.
    expect(inc.from).toEqual({ kind: "anchor", anchorId: "start" });
    expect(inc.to).toEqual({ kind: "anchor", anchorId: "retirement-client" });
    const exp = createExpenseRow(plan, [inc]);
    // Label defaults to the category name (Cashflow table: firm row
    // vocabulary and category grouping), not a numbered placeholder.
    expect(exp.label).toBe("Non-discretionary Living Expenses");
    expect(exp.category).toBe("nonDiscretionary");
    expect(exp.from).toEqual({ kind: "anchor", anchorId: "start" });
    expect(exp.to).toEqual({ kind: "anchor", anchorId: "end" });
  });

  it("deduction rows default sensibly (PAYG withholding, tax refund timing, and deductions)", () => {
    const plan = couplePlan();
    const ded = createDeductionRow(plan, []);
    expect(ded.owner).toBe("client");
    expect(ded.category).toBe("workingExpense");
    expect(ded.label).toBe(DEDUCTION_CATEGORY_LABELS.workingExpense);
    expect(ded.frequency).toBe("annual");
    expect(DEDUCTION_CATEGORIES).toContain(ded.category);
  });
});

describe("clampAllToPlan re-clamps deductions too (Cashflow table: firm row vocabulary and category grouping)", () => {
  it("preserves deduction rows through a household/plan change instead of dropping the whole array", () => {
    const s = defaultState(PROFILES, NOW);
    s.cashflows.deductions.push(createDeductionRow(s.plan, []));
    const reclamped = clampAllToPlan({ ...s, plan: { ...s.plan, household: "couple", partner: { currentAge: 38 } } }, PROFILES);
    expect(reclamped.cashflows.deductions).toHaveLength(1);
    expect(reclamped.cashflows.deductions[0].category).toBe("workingExpense");
  });

  it("a pre-Commit-2 state with no deductions array at all doesn't throw", () => {
    const s = defaultState(PROFILES, NOW);
    delete s.cashflows.deductions;
    expect(() => clampAllToPlan(s, PROFILES)).not.toThrow();
    expect(clampAllToPlan(s, PROFILES).cashflows.deductions).toEqual([]);
  });
});

describe("Property depreciation (PAYG withholding, tax refund timing, and deductions)", () => {
  it("defaults to 0 and round-trips through clampProperty", () => {
    const plan = couplePlan();
    const p = createProperty(plan, []);
    expect(p.depreciation).toBe(0);
    const clamped = clampProperty({ ...p, depreciation: 6000 }, plan);
    expect(clamped.depreciation).toBe(6000);
    // A pre-Commit-1 property blob has no depreciation field at all —
    // must default to 0, not NaN/undefined.
    const { depreciation, ...withoutField } = p;
    expect(clampProperty(withoutField, plan).depreciation).toBe(0);
  });
});

describe("Smart defaults (spec 19, Commit 1) — property rent/expenses recompute until overridden", () => {
  it("a brand-new property's rent/expenses derive from value and stay isDefault:true", () => {
    const plan = couplePlan();
    const p = createProperty(plan, []);
    expect(p.rent.isDefault).toBe(true);
    expect(p.expenses.isDefault).toBe(true);
    const clamped = clampProperty({ ...p, propertyType: "investment", currentValue: 500000 }, plan);
    expect(clamped.rent.amount).toBeCloseTo(500000 * 0.04, 6); // 4% of property value
    expect(clamped.expenses.amount).toBeCloseTo(clamped.rent.amount * 0.2, 6); // 20% of gross rent
  });

  it("recomputes again on a later clamp as value changes, while still isDefault", () => {
    const plan = couplePlan();
    let p = clampProperty({ ...createProperty(plan, []), propertyType: "investment", currentValue: 500000 }, plan);
    expect(p.rent.amount).toBeCloseTo(20000, 6);
    p = clampProperty({ ...p, currentValue: 800000 }, plan);
    expect(p.rent.amount).toBeCloseTo(32000, 6); // still tracking — 4% of the NEW value
    expect(p.expenses.amount).toBeCloseTo(32000 * 0.2, 6);
  });

  it("typing an amount directly (main.js sets isDefault:false) freezes it — no further recompute", () => {
    const plan = couplePlan();
    let p = clampProperty({ ...createProperty(plan, []), propertyType: "investment", currentValue: 500000 }, plan);
    // Simulate main.js's field handler: user types a rent figure.
    p = clampProperty({ ...p, rent: { ...p.rent, amount: 15000, isDefault: false }, currentValue: 900000 }, plan);
    expect(p.rent.amount).toBe(15000); // untouched by the value change
    expect(p.rent.isDefault).toBe(false);
    // expenses is still tracking rent's amount, which is now the user's own 15000.
    expect(p.expenses.amount).toBeCloseTo(15000 * 0.2, 6);
  });

  it("regression gate: a pre-Commit-1 property blob (no isDefault field at all) is treated as already user-entered, not overwritten", () => {
    const plan = couplePlan();
    const raw = {
      ...createProperty(plan, []), propertyType: "investment", currentValue: 500000,
      rent: { amount: 20000, indexBasis: "cpi", indexExtraPct: 0 }, // no isDefault key — pre-existing saved state
      expenses: { amount: 3000, indexBasis: "cpi", indexExtraPct: 0 },
    };
    const clamped = clampProperty(raw, plan);
    expect(clamped.rent.amount).toBe(20000); // NOT recomputed to 4% of value (20000)
    expect(clamped.expenses.amount).toBe(3000); // NOT recomputed to 20% of rent (4000)
    expect(clamped.rent.isDefault).toBe(false);
    expect(clamped.expenses.isDefault).toBe(false);
  });

  it("a planned purchase derives from priceToday, not currentValue", () => {
    const plan = couplePlan();
    const p = createProperty(plan, []);
    const clamped = clampProperty({ ...p, propertyType: "investment", status: "planned", priceToday: 600000, currentValue: 0 }, plan);
    expect(clamped.rent.amount).toBeCloseTo(600000 * 0.04, 6);
  });
});

describe("clampDeductionRow", () => {
  it("clamps owner to the household window and defaults an invalid category to 'other'", () => {
    const plan = couplePlan();
    const row = clampDeductionRow({
      id: "ded1", label: "Custom", owner: "partner", category: "notARealCategory",
      amount: 500, frequency: "annual", fromAge: 30, toAge: 90,
    }, plan);
    expect(row.owner).toBe("partner");
    expect(row.category).toBe("other");
    expect(row.amount).toBe(500);
  });

  it("a single household reassigns a stray partner owner to client (mirrors income/expense rows)", () => {
    const plan = { ...couplePlan(), household: "single", partner: null };
    const row = clampDeductionRow({ id: "ded1", label: "X", owner: "partner", category: "other", amount: 100, frequency: "annual" }, plan);
    expect(row.owner).toBe("client");
  });
});

describe("owner windows + FY labels", () => {
  it("partner window spans the same number of plan years from their own age", () => {
    const plan = couplePlan(); // client 40→90 (50y), partner 36
    expect(horizonYears(plan)).toBe(50);
    expect(ownerWindow(plan, "client")).toEqual({ from: 40, to: 90 });
    expect(ownerWindow(plan, "partner")).toEqual({ from: 36, to: 86 });
  });

  it("FY labels derive from the 1-July tick convention", () => {
    const plan = couplePlan(); // start Aug 2026 → first 1 July is 2027
    // Client is 40 now: current FY is the one that began July 2026.
    expect(fyLabelForAge(plan, "client", 40)).toBe("FY 2026–27");
    expect(fyLabelForAge(plan, "client", 41)).toBe("FY 2027–28");
    expect(fyLabelForAge(plan, "client", 65)).toBe("FY 2051–52");
    // Partner ages tick alongside from their own current age.
    expect(fyLabelForAge(plan, "partner", 36)).toBe("FY 2026–27");
    expect(fyLabelForAge(plan, "partner", 65)).toBe("FY 2055–56");
  });

  it("start month before July shifts the first tick to the same year", () => {
    const plan = { ...couplePlan(), start: { year: 2026, month: 3 } };
    // March 2026 start → first 1 July is 2026 → current FY began July 2025.
    expect(fyLabelForAge(plan, "client", 40)).toBe("FY 2025–26");
    expect(fyLabelForAge(plan, "client", 41)).toBe("FY 2026–27");
  });

  it("clampIncomeRow anchors to the owner window and demotes orphan partners", () => {
    const plan = couplePlan();
    const row = {
      id: "x", owner: "partner", amount: 1, frequency: "annual",
      from: { kind: "age", age: 30 }, to: { kind: "age", age: 99 }, indexed: true,
    };
    const out = clampIncomeRow(row, plan);
    expect(out.from).toEqual({ kind: "age", age: 36 });
    expect(out.to).toEqual({ kind: "age", age: 86 });
    const single = clampPlan({ ...plan, household: "single", partner: null });
    const demoted = clampIncomeRow(row, single);
    expect(demoted.owner).toBe("client");
  });
});

describe("fundingOrder invariants", () => {
  it("normalises order to exactly the included assets", () => {
    const a = { id: "a", include: true };
    const b = { id: "b", include: true };
    const c = { id: "c", include: false };
    // Unknown id dropped, excluded dropped, missing included appended.
    expect(normaliseFundingOrder(["zz", "b", "c"], [a, b, c])).toEqual(["b", "a"]);
    // Re-including appends at the end.
    c.include = true;
    expect(normaliseFundingOrder(["b", "a"], [a, b, c])).toEqual(["b", "a", "c"]);
  });

  it("an asset allocation drops when its target is invalid, surviving allocations keep their pct", () => {
    const plan = { client: { currentAge: 40 }, partner: null, endAge: 90 };
    const assets = [{ id: "a", include: true }, { id: "b", include: false }];
    const withTarget = (targetId) => ({
      surplus: { periods: [{ ...createSurplusPeriod(), allocations: [{ id: "sa1", targetType: "asset", targetId, pct: 40 }] }] },
      fundingOrder: [],
    });
    expect(normaliseSettings(withTarget("a"), assets, plan).surplus.periods[0].allocations)
      .toEqual([{ id: "sa1", targetType: "asset", targetId: "a", pct: 40 }]);
    // "b" is excluded, "gone" doesn't exist — both drop the allocation
    // entirely (never coerced to some other target), leaving none.
    expect(normaliseSettings(withTarget("b"), assets, plan).surplus.periods[0].allocations).toEqual([]);
    expect(normaliseSettings(withTarget("gone"), assets, plan).surplus.periods[0].allocations).toEqual([]);
  });

  it("remainderTo is preserved as-is (a valid, explicit choice — never silently upgraded)", () => {
    const plan = { client: { currentAge: 40 }, partner: null, endAge: 90 };
    const assets = [{ id: "a", include: true }];
    const settings = { surplus: { periods: [{ ...createSurplusPeriod(), remainderTo: "expenditure" }] }, fundingOrder: [] };
    expect(normaliseSettings(settings, assets, plan).surplus.periods[0].remainderTo).toBe("expenditure");
  });

  it("removeAsset cascades cashflows, funding order, and a surplus allocation targeting it", () => {
    const s = defaultState(PROFILES, NOW);
    const a2 = createAsset(s.plan, s.assets, PROFILES);
    s.assets.push(a2);
    s.settings = normaliseSettings({
      surplus: { periods: [{ ...createSurplusPeriod(), allocations: [{ id: "sa1", targetType: "asset", targetId: a2.id, pct: 100 }] }] },
      fundingOrder: s.settings.fundingOrder,
    }, s.assets, s.plan);
    s.cashflows.withdrawals.push(createCashflow("withdrawal", s.plan, a2.id));

    const out = removeAsset(s, a2.id);
    expect(out.assets).toHaveLength(1);
    expect(out.cashflows.withdrawals).toHaveLength(0);
    expect(out.settings.fundingOrder).toEqual([s.assets[0].id]);
    expect(out.settings.surplus.periods[0].allocations).toEqual([]);
  });

  it("never removes the last asset", () => {
    const s = defaultState(PROFILES, NOW);
    expect(removeAsset(s, s.assets[0].id)).toBe(s);
  });

  // Phase A.1's asset-deletion dialog (audit follow-up B1): reassigning
  // a removed asset's cashflow rows to another asset instead of
  // deleting them — the reassignToId branch never exercised until now.
  it("cashflowRowsForAsset lists every contribution/withdrawal/one-off targeting an asset", () => {
    const s = defaultState(PROFILES, NOW);
    const victim = s.assets[0];
    s.cashflows.withdrawals.push({ ...createCashflow("withdrawal", s.plan, victim.id), amount: 500 });
    s.cashflows.lumpSums.push({ ...createLumpSum(s.plan, victim.id), amount: 1000, direction: "out" });
    // The default plan already seeds one $0 monthly contribution on this asset.
    const rows = cashflowRowsForAsset(s, victim.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.kind)).toEqual(["Contribution", "Withdrawal", "One-off amount"]);
    expect(rows.find((r) => r.kind === "Withdrawal").summary).toMatch(/\$500.*monthly/);
    expect(rows.find((r) => r.kind === "One-off amount").summary).toMatch(/outflow/);
  });

  it("removeAsset(state, id, reassignToId) retargets cashflow rows instead of deleting them", () => {
    const s = defaultState(PROFILES, NOW);
    const victim = s.assets[0];
    const keeper = createAsset(s.plan, s.assets, PROFILES);
    s.assets.push(keeper);
    s.cashflows.withdrawals.push(createCashflow("withdrawal", s.plan, victim.id));
    s.cashflows.lumpSums.push(createLumpSum(s.plan, victim.id));

    const out = removeAsset(s, victim.id, keeper.id);
    expect(out.assets.map((a) => a.id)).toEqual([keeper.id]);
    // Nothing orphaned: every row that pointed at the victim now points
    // at the keeper — none deleted, none left dangling.
    expect(out.cashflows.contributions.every((c) => c.assetId === keeper.id)).toBe(true);
    expect(out.cashflows.withdrawals.every((w) => w.assetId === keeper.id)).toBe(true);
    expect(out.cashflows.lumpSums.every((l) => l.assetId === keeper.id)).toBe(true);
    expect(out.cashflows.withdrawals).toHaveLength(1);
    expect(out.cashflows.lumpSums).toHaveLength(1);
  });

  it("removeAsset ignores an invalid reassignToId (stale/missing/lifestyle) and falls back to cascade-delete — never orphans", () => {
    const s = defaultState(PROFILES, NOW);
    const victim = s.assets[0];
    const keeper = createAsset(s.plan, s.assets, PROFILES);
    s.assets.push(keeper);
    const lifestyle = createLifestyleAsset(s.plan, s.assets);
    s.assets.push(lifestyle);
    s.cashflows.withdrawals.push(createCashflow("withdrawal", s.plan, victim.id));

    for (const badId of ["not-a-real-id", lifestyle.id, null]) {
      const out = removeAsset(s, victim.id, badId);
      expect(out.cashflows.withdrawals).toHaveLength(0); // deleted, not orphaned to a bad id
      expect(out.assets.some((a) => a.id === victim.id)).toBe(false);
    }
  });
});

describe("household transitions", () => {
  function coupleState() {
    const s = defaultState(PROFILES, NOW);
    s.plan = couplePlan();
    const pa = createAsset(s.plan, s.assets, PROFILES);
    pa.owner = "partner";
    const ja = createAsset(s.plan, [...s.assets, pa], PROFILES);
    ja.owner = "joint";
    s.assets.push(pa, ja);
    s.settings = normaliseSettings(s.settings, s.assets, s.plan);
    const inc = createIncomeRow(s.plan, []);
    inc.owner = "partner";
    inc.from = { kind: "age", age: 36 }; inc.to = { kind: "age", age: 65 };
    s.cashflows.income.push(inc);
    return { s, pa, ja };
  }

  it("partnerOwnedItems finds partner and joint holdings", () => {
    const { s } = coupleState();
    const found = partnerOwnedItems(s);
    expect(found.assets).toHaveLength(2); // partner + joint
    expect(found.income).toHaveLength(1);
    expect(found.count).toBe(3);
  });

  it("reassignPartnerToClient keeps numeric ages and re-derives ownership", () => {
    const { s } = coupleState();
    const out = reassignPartnerToClient(s);
    expect(out.assets.every((a) => a.owner === "client")).toBe(true);
    expect(out.cashflows.income[0].owner).toBe("client");
    expect(out.cashflows.income[0].from).toEqual({ kind: "age", age: 36 }); // numeric ages kept
  });

  it("deletePartnerOwned cascades through cashflows and settings", () => {
    const { s, pa } = coupleState();
    s.cashflows.contributions.push(createCashflow("contribution", s.plan, pa.id));
    const out = deletePartnerOwned(s);
    expect(out.assets).toHaveLength(1);
    expect(out.assets[0].owner).toBe("client");
    expect(out.cashflows.income).toHaveLength(0);
    expect(out.cashflows.contributions.every((c) => c.assetId !== pa.id)).toBe(true);
    expect(out.settings.fundingOrder).toEqual([out.assets[0].id]);
  });
});

describe("migration", () => {
  it("migrates a v1 blob (asset-owned cashflows, startYear)", () => {
    const v1 = {
      schemaVersion: 1,
      plan: { currentAge: 45, endAge: 85, startYear: 2025 },
      assets: [{
        id: "as-old", name: "Legacy", include: true, balance: 50000,
        allocation: { mode: "profile", profile: "Balanced" },
        icrPct: 0.3, cgtAsset: true, costBase: 40000,
        contributions: [{ id: "c1", amount: 500, frequency: "monthly", fromAge: 45, toAge: 65, indexed: true }],
        withdrawals: [],
        lumpSums: [{ id: "l1", amount: 10000, direction: "in", age: 50, source: "input" }],
      }],
      display: { units: "nominal" },
      assumptions: { cpi: 0.03 },
    };
    const s = hydrate(JSON.stringify(v1), PROFILES);
    expect(s).not.toBeNull();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.plan.household).toBe("single");
    expect(s.plan.client.currentAge).toBe(45);
    expect(s.plan.start).toEqual({ year: 2025, month: 7 });
    expect(s.assets[0].owner).toBe("client");
    expect(s.assets[0].distributions).toBe("reinvest");
    expect(s.cashflows.contributions).toHaveLength(1);
    expect(s.cashflows.contributions[0].assetId).toBe("as-old");
    expect(s.cashflows.lumpSums[0].assetId).toBe("as-old");
    expect(s.settings.fundingOrder).toEqual(["as-old"]);
    expect(s.display.units).toBe("nominal");
    expect(s.assumptions.cpi).toBe(0.03);
  });

  it("migrates a v2 blob (central cashflows, flat plan ages)", () => {
    const v2 = {
      schemaVersion: 2,
      plan: { currentAge: 40, endAge: 90, start: { year: 2026, month: 8 } },
      assets: [
        { id: "a1", name: "Cash", include: true, balance: 20000, allocation: { mode: "profile", profile: "Cash" }, icrPct: 0, cgtAsset: false, costBase: null },
        { id: "a2", name: "Shares", include: false, balance: 80000, allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0.2, cgtAsset: true, costBase: 60000 },
      ],
      cashflows: {
        contributions: [{ id: "c1", assetId: "a2", amount: 1000, frequency: "monthly", fromAge: 40, toAge: 65, indexed: true }],
        withdrawals: [],
        lumpSums: [],
      },
      display: { units: "real" },
      assumptions: { cpi: 0.025 },
    };
    const s = hydrate(JSON.stringify(v2), PROFILES);
    expect(s).not.toBeNull();
    expect(s.plan.client.currentAge).toBe(40);
    expect(s.assets.map((a) => a.owner)).toEqual(["client", "client"]);
    expect(s.cashflows.income).toEqual([]);
    expect(s.cashflows.expenses).toEqual([]);
    // fundingOrder = included assets only (a2 is excluded).
    expect(s.settings.fundingOrder).toEqual(["a1"]);
    // v2→v3's own migration stamps the old "spend" mode — migrated
    // forward to v17's period model, that's 100% remainder to
    // expenditure, non-deductible-first off (bit-identical projection).
    expect(s.settings.surplus.periods).toHaveLength(1);
    expect(s.settings.surplus.periods[0]).toMatchObject({ payNonDeductibleDebtFirst: false, allocations: [], remainderTo: "expenditure" });
  });

  it("rejects garbage and unknown versions", () => {
    expect(hydrate("not json", PROFILES)).toBeNull();
    expect(hydrate("{}", PROFILES)).toBeNull();
    expect(hydrate(JSON.stringify({ schemaVersion: 99, plan: {}, assets: [{}] }), PROFILES)).toBeNull();
  });
});

describe("persistence round-trip (v3)", () => {
  it("preserves household, ownership, income/expenses, and settings", () => {
    const s = defaultState(PROFILES, NOW);
    s.plan = couplePlan();
    const a2 = createAsset(s.plan, s.assets, PROFILES);
    a2.owner = "joint";
    a2.distributions = "cash";
    s.assets.push(a2);
    s.settings = normaliseSettings({
      surplus: { periods: [{ ...createSurplusPeriod(), allocations: [{ id: "sa1", targetType: "asset", targetId: a2.id, pct: 100 }] }] },
      fundingOrder: [a2.id, s.assets[0].id],
    }, s.assets, s.plan);

    const inc = createIncomeRow(s.plan, []);
    inc.owner = "partner"; inc.amount = 90000;
    inc.from = { kind: "age", age: 36 }; inc.to = { kind: "age", age: 65 };
    s.cashflows.income.push(inc);
    const exp = createExpenseRow(s.plan, []);
    exp.amount = 60000; exp.label = "Living expenses";
    s.cashflows.expenses.push(exp);

    const back = hydrate(serialize(s), PROFILES);
    expect(back).not.toBeNull();
    expect(back.plan.household).toBe("married"); // v5 splits marital status
    expect(back.plan.partner.currentAge).toBe(36);
    expect(back.assets[1]).toMatchObject({ owner: "joint", distributions: "cash" });
    expect(back.settings.surplus.periods[0].allocations).toEqual([{ id: "sa1", targetType: "asset", targetId: a2.id, pct: 100 }]);
    expect(back.settings.fundingOrder).toEqual([a2.id, s.assets[0].id]);
    expect(back.cashflows.income[0]).toMatchObject({
      owner: "partner", amount: 90000,
      from: { kind: "age", age: 36 }, to: { kind: "age", age: 65 },
    });
    expect(back.cashflows.expenses[0]).toMatchObject({ label: "Living expenses", amount: 60000 });
  });

  it("single households strip partner/joint owners on hydrate", () => {
    const s = defaultState(PROFILES, NOW);
    // Corrupt: single household but a joint asset snuck in.
    s.assets[0].owner = "joint";
    const back = hydrate(serialize(s), PROFILES);
    expect(back.assets[0].owner).toBe("client");
  });
});

describe("summaries", () => {
  it("summarise covers income/expenses and asset-filtered cashflows", () => {
    const s = defaultState(PROFILES, NOW);
    s.assets[0].balance = 100000;
    s.cashflows.contributions[0].amount = 1000; // monthly → 12k
    const inc = createIncomeRow(s.plan, []);
    inc.amount = 90000; // annual
    s.cashflows.income.push(inc);
    const exp = createExpenseRow(s.plan, []);
    exp.amount = 5000; exp.frequency = "monthly"; // → 60k
    s.cashflows.expenses.push(exp);

    const sum = summarise(s);
    expect(sum.totalBalance).toBe(100000);
    expect(sum.annualContributions).toBe(12000);
    expect(sum.annualIncome).toBe(90000);
    expect(sum.annualExpenses).toBe(60000);

    // Excluding the asset removes its contributions but not income/expenses.
    s.assets[0].include = false;
    const sum2 = summarise(s);
    expect(sum2.annualContributions).toBe(0);
    expect(sum2.annualIncome).toBe(90000);
  });

  it("plan summary text stays client-anchored", () => {
    expect(planSummaryText(couplePlan()))
      .toBe("50-year projection, 2026–2076 (age 40–90)");
  });
});

describe("allocation (carried from A.1)", () => {
  it("nearestVolBasis + clampAllocation still behave", () => {
    expect(nearestVolBasis(PROFILES, 7.5)).toBe("High Growth – Income");
    const out = clampAllocation({ mode: "custom", incomePct: 99, growthPct: -5, frankingPct: 250, volBasis: "junk" }, PROFILES);
    expect(out.incomePct).toBe(30);
    expect(out.growthPct).toBe(0);
    expect(out.frankingPct).toBe(100);
    expect(PROFILE_KEYS).toContain(out.volBasis);
  });

  it("profiles' derived franking (from class weights, not a stored field) stays in range", () => {
    const franking = (name) => impliedFrankingPct(PROFILES[name].classWeights, PROFILES[name].incomeReturn);
    expect(franking("Cash")).toBe(0);
    expect(franking("High Growth – Income")).toBeGreaterThan(franking("High Growth – Capital"));
    for (const p of Object.values(PROFILES)) {
      const f = impliedFrankingPct(p.classWeights, p.incomeReturn);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(100);
    }
  });

  it("allocation summaries unchanged", () => {
    expect(allocationTotalNominal({ mode: "custom", incomePct: 4, growthPct: 3.5 }, PROFILES)).toBeCloseTo(0.075);
    expect(allocationSummary({ mode: "profile", profile: "Balanced" }, PROFILES)).toBe("Balanced");
  });
});

describe("one-off grid helpers (C2)", () => {
  const input = { id: "in1", assetId: "a1", amount: 5000, direction: "in", at: { kind: "age", age: 45 }, source: "input" };

  it("creates, updates, and deletes the table-sourced entry", () => {
    let ls = upsertTableLumpSum([input], "a1", 45, -20000);
    expect(ls).toHaveLength(2);
    const t = tableLumpSumFor(ls, "a1", 45);
    expect(t).toMatchObject({ assetId: "a1", at: { kind: "age", age: 45 }, amount: 20000, direction: "out", source: "table" });

    // Update keeps the id and flips direction.
    const ls2 = upsertTableLumpSum(ls, "a1", 45, 7500);
    const t2 = tableLumpSumFor(ls2, "a1", 45);
    expect(t2.id).toBe(t.id);
    expect(t2).toMatchObject({ amount: 7500, direction: "in" });

    // Zero / empty / junk deletes; the input-sourced row survives.
    for (const cleared of [0, "", "abc", null]) {
      const ls3 = upsertTableLumpSum(ls2, "a1", 45, cleared);
      expect(tableLumpSumFor(ls3, "a1", 45)).toBeNull();
      expect(ls3).toContainEqual(input);
    }
  });

  it("cells are keyed by asset AND age", () => {
    let ls = upsertTableLumpSum([], "a1", 45, 1000);
    ls = upsertTableLumpSum(ls, "a1", 50, 2000);
    ls = upsertTableLumpSum(ls, "a2", 45, 3000);
    expect(ls).toHaveLength(3);
    expect(tableLumpSumFor(ls, "a1", 50).amount).toBe(2000);
  });

  it("first-FY editing follows convention 5", () => {
    expect(canEditOneOffYear({ start: { year: 2026, month: 7 } }, 0)).toBe(true);
    expect(canEditOneOffYear({ start: { year: 2026, month: 8 } }, 0)).toBe(false);
    expect(canEditOneOffYear({ start: { year: 2026, month: 8 } }, 1)).toBe(true);
  });
});

describe("schema v4 migration (C3)", () => {
  it("v3 blobs gain default tax profiles for both persons", () => {
    const v3 = {
      schemaVersion: 3,
      plan: {
        household: "couple",
        client: { currentAge: 45 },
        partner: { currentAge: 43 },
        endAge: 90,
        start: { year: 2026, month: 7 },
      },
      assets: [{ id: "a1", name: "A", include: true, owner: "client", distributions: "reinvest",
                 balance: 1000, allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0,
                 cgtAsset: false, costBase: null }],
      cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] },
      settings: { surplus: { mode: "spend", assetId: null }, fundingOrder: ["a1"] },
      display: { units: "real" },
      assumptions: { cpi: 0.025 },
    };
    const s = hydrate(JSON.stringify(v3), PROFILES);
    expect(s).not.toBeNull();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    // Age pension (spec 21a, Commit 3) reintroduced centrelinkEligible —
    // a migrated v3 blob has no such field, so clampTaxProfile's own
    // default (true, still tracking) applies, then clampPlan's smart
    // default resolves it against this plan's (LE-derived) endAge,
    // which is well past age pension age for a 40-year-old default.
    const def = {
      residency: "resident", medicareExempt: false, openingCapitalLosses: 0,
      centrelinkEligible: true, centrelinkEligibleIsDefault: true,
    };
    expect(s.plan.client.taxProfile).toEqual(def);
    expect(s.plan.partner.taxProfile).toEqual(def);
  });

  it("explicit v4 tax profiles survive a serialize/hydrate round trip", () => {
    const s = defaultState(PROFILES, NOW);
    s.plan.client.taxProfile = { residency: "nonResident", medicareExempt: true, openingCapitalLosses: 2500 };
    const back = hydrate(serialize(s), PROFILES);
    expect(back.plan.client.taxProfile)
      .toEqual({
        residency: "nonResident", medicareExempt: true, openingCapitalLosses: 2500,
        centrelinkEligible: true, centrelinkEligibleIsDefault: true,
      });
  });

  it("clampTaxProfile defends junk", () => {
    expect(clampTaxProfile(null))
      .toEqual({
        residency: "resident", medicareExempt: false, openingCapitalLosses: 0,
        centrelinkEligible: true, centrelinkEligibleIsDefault: true,
      });
    expect(clampTaxProfile({ residency: "martian", medicareExempt: "yes", centrelinkEligible: 1, openingCapitalLosses: -5 }))
      .toEqual({
        residency: "resident", medicareExempt: false, openingCapitalLosses: 0,
        centrelinkEligible: true, centrelinkEligibleIsDefault: true,
      });
  });

  // Age pension (spec 21a, Commit 3) — reintroduced now that Centrelink
  // modelling exists (Input Usability spec, Commit 1 had removed it as
  // inert). clampTaxProfile reads the raw stored value; clampPlan's own
  // applyCentrelinkEligibleDefault (not exercised here, since that needs
  // a resolved endAge) is what actually recomputes the SMART default.
  it("clampTaxProfile preserves an explicit centrelinkEligible: false override", () => {
    expect(clampTaxProfile({ centrelinkEligible: false, centrelinkEligibleIsDefault: false }))
      .toEqual({
        residency: "resident", medicareExempt: false, openingCapitalLosses: 0,
        centrelinkEligible: false, centrelinkEligibleIsDefault: false,
      });
  });
});

describe("Input Usability spec, Commit 2 — touched-field tracking", () => {
  it("a new scenario starts fully untouched", () => {
    const s = defaultState(PROFILES, NOW);
    expect(s.meta).toEqual({ touched: [] });
  });

  it("clampTouched dedupes and drops non-string/empty junk", () => {
    expect(clampTouched(null)).toEqual([]);
    expect(clampTouched("not-an-array")).toEqual([]);
    expect(clampTouched(["a", "b", "a", "", 5, null, "c"])).toEqual(["a", "b", "c"]);
  });

  it("touched paths survive a serialize/hydrate round trip", () => {
    const s = defaultState(PROFILES, NOW);
    s.meta.touched = ["plan.client.retirementAge", "assets.a1.balance"];
    const back = hydrate(serialize(s), PROFILES);
    expect(back.meta.touched.sort()).toEqual(["assets.a1.balance", "plan.client.retirementAge"]);
  });

  it("a pre-Commit-2 scenario (no meta at all) hydrates with nothing marked touched — honest, not guessed", () => {
    const s = defaultState(PROFILES, NOW);
    const raw = JSON.parse(serialize(s));
    delete raw.meta;
    raw.schemaVersion = 14; // pre-Commit-2 shape, migrates forward
    const back = hydrate(JSON.stringify(raw), PROFILES);
    expect(back).not.toBeNull();
    expect(back.meta).toEqual({ touched: [] });
  });

  it("clampAllToPlan preserves meta.touched untouched (not a plan/asset/cashflow field, passed through as-is)", () => {
    const s = defaultState(PROFILES, NOW);
    s.meta.touched = ["plan.client.retirementAge"];
    const clamped = clampAllToPlan(s, PROFILES);
    expect(clamped.meta.touched).toEqual(["plan.client.retirementAge"]);
  });
});

describe("Input Usability spec, Commit 3 — children and education funding", () => {
  const start = { year: 2026, month: 7 };

  it("a new scenario has no children; defaultPlan/clampPlan both default to an empty array", () => {
    const s = defaultState(PROFILES, NOW);
    expect(s.plan.children).toEqual([]);
  });

  it("createChild seeds a plausible placeholder DOB (age 5), not a guess at a real one", () => {
    const c = createChild([], { start });
    expect(c.name).toBe("Child 1");
    expect(ageAtDate(c.dateOfBirth, start.year, start.month)).toBe(5);
    expect(c.education).toEqual([]);
  });

  it("createEducationBlock defaults to CPI + 2% — school fees have historically outrun CPI", () => {
    const e = createEducationBlock([]);
    expect(e.indexBasis).toBe("cpi");
    expect(e.indexExtraPct).toBe(2.0);
    expect(e.fromAge).toBeLessThan(e.toAge);
  });

  it("normaliseChildren clamps junk: an invalid DOB falls back to the same placeholder createChild uses, toAge can never precede fromAge", () => {
    const raw = [{
      id: "ch1", name: "  ", dateOfBirth: "not-a-date",
      education: [{ fromAge: 12, toAge: 5, annualAmount: -100 }],
    }];
    const [c] = normaliseChildren(raw, start);
    expect(c.name).toBe("Child"); // blank name falls back
    expect(ageAtDate(c.dateOfBirth, start.year, start.month)).toBe(5);
    expect(c.education[0].toAge).toBeGreaterThanOrEqual(c.education[0].fromAge);
    expect(c.education[0].annualAmount).toBe(0);
  });

  it("dependentChildrenCountInFY steps down as a child passes 21 — the real correctness improvement over a fixed count", () => {
    // Born 1 July 2005: age 21 exactly at 1 July 2026 (ages tick 1
    // July), so FY2025–26 (still 20) counts them; FY2026–27 (turns 21)
    // does not.
    const child = { dateOfBirth: "2005-07-01" };
    expect(dependentChildrenCountInFY([child], 2025)).toBe(1);
    expect(dependentChildrenCountInFY([child], 2026)).toBe(0);
  });

  it("dependentChildrenCountInFY excludes a not-yet-born child (negative age), not counts them as a phantom dependent", () => {
    const child = { dateOfBirth: "2030-01-01" };
    expect(dependentChildrenCountInFY([child], 2026)).toBe(0);
  });

  it("childCurrentAgeInfo clamps a not-yet-born child's display age to 0 and flags it, rather than showing a negative age", () => {
    const child = { dateOfBirth: "2029-01-01" };
    const info = childCurrentAgeInfo(child, { start });
    expect(info.notYetBorn).toBe(true);
    expect(info.age).toBe(0);
    expect(info.bornFYLabel).toBe("FY2029–30");
  });

  it("childCurrentAgeInfo reports a plain age for an already-born child", () => {
    const child = { dateOfBirth: "2020-01-01" };
    expect(childCurrentAgeInfo(child, { start })).toEqual({ age: 6, notYetBorn: false });
  });

  it("childEducationPlanYearBounds shifts a child's own fromAge/toAge into plan-year bounds — an already-5-year-old child's ages-5-12 block is active from plan year 0", () => {
    const child = { dateOfBirth: "2021-07-01" }; // age 5 at plan start
    const bounds = childEducationPlanYearBounds(child, { start }, 5, 12);
    expect(bounds).toEqual({ from: 0, to: 7 });
  });

  it("childEducationPlanYearBounds pushes the window later for a not-yet-born child — never before they exist", () => {
    const child = { dateOfBirth: "2029-07-01" }; // age -3 at plan start (born 3 plan years in)
    const bounds = childEducationPlanYearBounds(child, { start }, 5, 12);
    expect(bounds).toEqual({ from: 8, to: 15 }); // fromAge(5) - (-3) = 8
  });

  it("flatEducationBlocks flattens every child's education blocks, in order", () => {
    const plan = {
      children: [
        { id: "c1", education: [{ id: "e1" }, { id: "e2" }] },
        { id: "c2", education: [{ id: "e3" }] },
        { id: "c3" }, // no education field at all
      ],
    };
    expect(flatEducationBlocks(plan).map((b) => b.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("migration (v15→v16): an existing dependentChildren count becomes that many placeholder children, none marked touched", () => {
    const s = defaultState(PROFILES, NOW);
    const raw = JSON.parse(serialize(s));
    delete raw.plan.children;
    raw.plan.dependentChildren = 3;
    raw.schemaVersion = 15;
    const back = hydrate(JSON.stringify(raw), PROFILES);
    expect(back).not.toBeNull();
    expect(back.plan.children).toHaveLength(3);
    expect(back.plan.children.map((c) => c.name)).toEqual(["Child 1", "Child 2", "Child 3"]);
    // Placeholders are genuinely unknown ages — flagged untouched per
    // Commit 2 by simply never being added to state.meta.touched.
    expect(back.meta.touched).toEqual([]);
    // dependentChildren itself is gone, not carried through as a stray field.
    expect(back.plan).not.toHaveProperty("dependentChildren");
  });

  it("migration (v15→v16): dependentChildren of 0 (or absent) migrates to no children at all", () => {
    const s = defaultState(PROFILES, NOW);
    const raw = JSON.parse(serialize(s));
    delete raw.plan.children;
    raw.schemaVersion = 15;
    const back = hydrate(JSON.stringify(raw), PROFILES);
    expect(back.plan.children).toEqual([]);
  });
});

describe("D1 — identity, DOB, and end basis", () => {
  const start = { year: 2026, month: 8 };

  it("derives age at start as the floor of exact age; ages tick 1 July", () => {
    expect(ageAtDate("1986-07-01", 2026, 8)).toBe(40);
    expect(ageAtDate("1986-09-15", 2026, 8)).toBe(39); // birthday not yet reached
    expect(ageAtDate("1986-07-01", 2026, 3)).toBe(39);
    expect(synthDob(40, { year: 2026, month: 3 })).toBe("1985-07-01"); // FY-aligned
    expect(ageAtDate(synthDob(40, { year: 2026, month: 3 }), 2026, 3)).toBe(40);
  });

  it("LE basis resolves to the household's longest life expectancy", () => {
    const client = clampPlan({
      household: "married",
      client: { dob: "1986-07-01", sex: "male" },
      partner: { dob: "1990-07-01", sex: "female" },
      endBasis: { mode: "le", offset: 0 },
      start,
    });
    // Client male 40: LE 42.54 → 43y. Partner female 36: LE 49.95 →
    // 50y — the longer horizon anchors the projection.
    const years = Math.round(remainingLE(36, "female"));
    expect(client.endAge).toBe(40 + years);
    expect(resolveEndBasis(client.endBasis, client.client, client.partner).anchor).toBe("partner");
  });

  it("re-resolves when sex or partner changes while an LE basis is active", () => {
    const base = {
      household: "married",
      client: { dob: "1986-07-01", sex: "male" },
      partner: { dob: "1990-07-01", sex: "female" },
      endBasis: { mode: "le", offset: 5 },
      start,
    };
    const withPartner = clampPlan(base);
    expect(withPartner.endAge).toBe(40 + Math.round(remainingLE(36, "female")) + 5);
    const single = clampPlan({ ...base, household: "single", partner: null });
    expect(single.endAge).toBe(40 + Math.round(remainingLE(40, "male")) + 5);
    const maleP = clampPlan({ ...base, partner: { dob: "1990-07-01", sex: "male" } });
    const expected = Math.max(
      Math.round(remainingLE(40, "male")),
      Math.round(remainingLE(36, "male"))
    );
    expect(maleP.endAge).toBe(40 + expected + 5);
  });

  it("fixed bases resolve directly", () => {
    const p = clampPlan({
      client: { dob: "1986-07-01" },
      endBasis: { mode: "fixedAge", fixedAge: 92 },
      start,
    });
    expect(p.endAge).toBe(92);
    const y = clampPlan({
      client: { dob: "1986-07-01" },
      endBasis: { mode: "fixedYears", fixedYears: 30 },
      start,
    });
    expect(y.endAge).toBe(70);
  });

  it("v4 migration preserves ages and endAge exactly (regression gate)", () => {
    const v4 = {
      schemaVersion: 4,
      plan: {
        household: "couple",
        client: { currentAge: 45 },
        partner: { currentAge: 43 },
        endAge: 90,
        start: { year: 2026, month: 3 }, // pre-July start — the tricky case
      },
      assets: [{ id: "a1", name: "A", include: true, owner: "client", distributions: "reinvest",
                 balance: 1000, allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0,
                 cgtAsset: false, costBase: null }],
      cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [] },
      settings: { surplus: { mode: "spend", assetId: null }, fundingOrder: ["a1"] },
      display: { units: "real" },
      assumptions: { cpi: 0.025 },
    };
    const s = hydrate(JSON.stringify(v4), PROFILES);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.plan.household).toBe("married");
    expect(s.plan.client.currentAge).toBe(45);
    expect(s.plan.partner.currentAge).toBe(43);
    expect(s.plan.endAge).toBe(90); // fixed basis at the stored endAge
    expect(s.plan.endBasis.mode).toBe("fixedAge");
    expect(s.plan.client.taxProfile.openingCapitalLosses).toBe(0);
  });

  it("indexed flags migrate to CPI/None bases", () => {
    const plan = clampPlan({ client: { dob: "1986-07-01" }, endBasis: { mode: "fixedAge", fixedAge: 90 }, start });
    const t = clampCashflow({ id: "a", fromAge: 40, toAge: 90, amount: 1, frequency: "monthly", indexed: true }, plan);
    expect(t.indexBasis).toBe("cpi");
    expect(t.indexExtraPct).toBe(0);
    expect("indexed" in t).toBe(false);
    const f = clampCashflow({ id: "b", fromAge: 40, toAge: 90, amount: 1, frequency: "monthly", indexed: false }, plan);
    expect(f.indexBasis).toBe("none");
  });
});

describe("D2 — asset class model", () => {
  it("migration stamps existing assets financial; lifestyle round-trips", () => {
    const s = defaultState(PROFILES, NOW);
    const lf = createLifestyleAsset(s.plan, s.assets);
    lf.balance = 25000;
    lf.growthPct = 3;
    s.assets.push(lf);
    const back = hydrate(serialize(s), PROFILES);
    expect(back.assets[0].class).toBe("financial");
    const backLf = back.assets.find((a) => a.class === "lifestyle");
    expect(backLf).toMatchObject({ balance: 25000, growthPct: 3 });
    expect(backLf.allocation).toBeUndefined();
    expect(backLf.cgtAsset).toBeUndefined();
  });

  it("lifestyle assets never join fundingOrder or surplus targets", () => {
    const plan = { client: { currentAge: 40 }, partner: null, endAge: 90 };
    const fin = { id: "f", include: true, class: "financial" };
    const lf = { id: "l", include: true, class: "lifestyle" };
    expect(normaliseFundingOrder(["l", "f"], [fin, lf])).toEqual(["f"]);
    const settings = {
      surplus: { periods: [{ ...createSurplusPeriod(), allocations: [{ id: "sa1", targetType: "asset", targetId: "l", pct: 100 }] }] },
      fundingOrder: [],
    };
    expect(normaliseSettings(settings, [fin, lf], plan).surplus.periods[0].allocations).toEqual([]);
  });

  it("cashflow rows targeting lifestyle assets drop on hydrate", () => {
    const s = defaultState(PROFILES, NOW);
    const lf = createLifestyleAsset(s.plan, s.assets);
    s.assets.push(lf);
    s.cashflows.contributions.push({ ...createCashflow("contribution", s.plan, lf.id) });
    s.cashflows.lumpSums.push({ id: "x", assetId: lf.id, amount: 1000, direction: "in", age: 45, source: "input" });
    const back = hydrate(serialize(s), PROFILES);
    expect(back.cashflows.contributions.every((c) => c.assetId !== lf.id)).toBe(true);
    expect(back.cashflows.lumpSums).toHaveLength(0);
  });

  it("the last financial asset survives removal; lifestyle is always removable", () => {
    const s = defaultState(PROFILES, NOW);
    const lf = createLifestyleAsset(s.plan, s.assets);
    s.assets.push(lf);
    expect(removeAsset(s, s.assets[0].id)).toBe(s); // last financial — refused
    const out = removeAsset(s, lf.id);
    expect(out.assets).toHaveLength(1);
  });
});

describe("sidebar navigation (page-per-section)", () => {
  it("clampLastVisited accepts known area/section pairs", () => {
    expect(clampLastVisited({ area: "input", section: "liabilities" }))
      .toEqual({ area: "input", section: "liabilities" });
    expect(clampLastVisited({ area: "output", section: "tax" }))
      .toEqual({ area: "output", section: "tax" });
  });

  it("clampLastVisited defends junk by falling back to input/setup", () => {
    expect(clampLastVisited(null)).toEqual({ area: "input", section: "setup" });
    expect(clampLastVisited({ area: "input", section: "bogus" })).toEqual({ area: "input", section: "setup" });
    expect(clampLastVisited({ area: "output", section: "financial-assets" })).toEqual({ area: "input", section: "setup" });
    expect(clampLastVisited({ area: "bogus", section: "setup" })).toEqual({ area: "input", section: "setup" });
  });

  it("lastVisited round-trips through serialize/hydrate", () => {
    const s = defaultState(PROFILES, NOW);
    s.display.lastVisited = { area: "output", section: "tax" };
    const back = hydrate(serialize(s), PROFILES);
    expect(back.display.lastVisited).toEqual({ area: "output", section: "tax" });
  });

  it("a fresh default scenario is effectively empty", () => {
    const s = defaultState(PROFILES, NOW);
    expect(isScenarioEffectivelyEmpty(s)).toBe(true);
  });

  it("any real content makes a scenario not empty", () => {
    const withIncome = defaultState(PROFILES, NOW);
    withIncome.cashflows.income.push(createIncomeRow(withIncome.plan, []));
    expect(isScenarioEffectivelyEmpty(withIncome)).toBe(false);

    const withSecondAsset = defaultState(PROFILES, NOW);
    withSecondAsset.assets.push(createAsset(withSecondAsset.plan, withSecondAsset.assets, PROFILES));
    expect(isScenarioEffectivelyEmpty(withSecondAsset)).toBe(false);

    const withLifestyle = defaultState(PROFILES, NOW);
    withLifestyle.assets.push(createLifestyleAsset(withLifestyle.plan, withLifestyle.assets));
    expect(isScenarioEffectivelyEmpty(withLifestyle)).toBe(false);

    const withLiability = defaultState(PROFILES, NOW);
    withLiability.liabilities.push(createLiability(withLiability.plan, []));
    expect(isScenarioEffectivelyEmpty(withLiability)).toBe(false);

    const withProperty = defaultState(PROFILES, NOW);
    withProperty.properties.push(createProperty(withProperty.plan, []));
    expect(isScenarioEffectivelyEmpty(withProperty)).toBe(false);
  });

  it("sectionCounts reports item counts, zero omits no entry (no badge is the caller's job)", () => {
    const s = defaultState(PROFILES, NOW);
    s.cashflows.income.push(createIncomeRow(s.plan, []));
    s.cashflows.income.push(createIncomeRow(s.plan, s.cashflows.income));
    s.assets.push(createAsset(s.plan, s.assets, PROFILES));
    s.assets.push(createLifestyleAsset(s.plan, s.assets));
    s.liabilities.push(createLiability(s.plan, []));
    const counts = sectionCounts(s);
    expect(counts.income).toBe(2);
    expect(counts.expenses).toBe(0);
    expect(counts["financial-assets"]).toBe(2); // default + the added one
    expect(counts["lifestyle-assets"]).toBe(1);
    expect(counts.liabilities).toBe(1);
    expect(counts.property).toBe(0);
    expect(counts["investment-cashflows"]).toBe(1); // the default contribution row
  });
});

describe("D5 — report period + chart treatment display state", () => {
  it("clampReportPeriod defaults and clamps ages", () => {
    expect(clampReportPeriod(null)).toEqual({ fromAge: null, toAge: null, everyN: 1, forceKeyYears: true });
    expect(clampReportPeriod({ fromAge: 50, toAge: 45, everyN: 5, forceKeyYears: false }))
      .toEqual({ fromAge: 50, toAge: 50, everyN: 5, forceKeyYears: false }); // toAge lifted to fromAge
    expect(clampReportPeriod({ everyN: 7 }).everyN).toBe(1); // not one of 1/2/5/10 → default
    expect(clampReportPeriod({ fromAge: -5, toAge: 999 })).toEqual({ fromAge: null, toAge: null, everyN: 1, forceKeyYears: true });
  });

  it("clampChartTreatment defaults to PPR + lifestyle separate, property + liabilities included", () => {
    expect(defaultChartTreatment())
      .toEqual({ pprProperty: "separate", otherProperty: "include", lifestyle: "separate", liabilities: "include" });
    expect(clampChartTreatment(null)).toEqual(defaultChartTreatment());
    expect(clampChartTreatment({ pprProperty: "bogus", lifestyle: "exclude" }))
      .toEqual({ pprProperty: "separate", otherProperty: "include", lifestyle: "exclude", liabilities: "include" });
  });

  it("reportPeriod and chartTreatment round-trip through serialize/hydrate", () => {
    const s = defaultState(PROFILES, NOW);
    s.display.reportPeriod = { fromAge: 45, toAge: 60, everyN: 5, forceKeyYears: false };
    s.display.chartTreatment = { pprProperty: "include", otherProperty: "exclude", lifestyle: "include", liabilities: "exclude" };
    s.display.hideEmptyRows = false;
    const back = hydrate(serialize(s), PROFILES);
    expect(back.display.reportPeriod).toEqual({ fromAge: 45, toAge: 60, everyN: 5, forceKeyYears: false });
    expect(back.display.chartTreatment).toEqual({ pprProperty: "include", otherProperty: "exclude", lifestyle: "include", liabilities: "exclude" });
    expect(back.display.hideEmptyRows).toBe(false);
  });

  it("defaultReportPeriod defaults toAge to retirement+25 (capped at endAge) and thins beyond a 25-year span", () => {
    // Short horizon: retirement+25 exceeds endAge, so toAge is just
    // endAge, and the span is short enough that no thinning applies.
    expect(defaultReportPeriod({ client: { currentAge: 60, retirementAge: 65 }, endAge: 70 }))
      .toEqual({ fromAge: null, toAge: 70, everyN: 1, forceKeyYears: true });

    // Long horizon (>25 years, but endAge still under retirement+25):
    // toAge equals endAge, but the overall span triggers thinning.
    expect(defaultReportPeriod({ client: { currentAge: 40, retirementAge: 65 }, endAge: 80 }))
      .toEqual({ fromAge: null, toAge: 80, everyN: 5, forceKeyYears: true });

    // Very long horizon: retirement+25 caps toAge well short of
    // endAge — "a 63-year x-axis with 38 flat years at the end" is
    // exactly what this cap avoids.
    expect(defaultReportPeriod({ client: { currentAge: 30, retirementAge: 65 }, endAge: 110 }))
      .toEqual({ fromAge: null, toAge: 90, everyN: 5, forceKeyYears: true });

    // A non-default retirementAge feeds straight into the horizon.
    expect(defaultReportPeriod({ client: { currentAge: 30, retirementAge: 60 }, endAge: 110 }))
      .toEqual({ fromAge: null, toAge: 85, everyN: 5, forceKeyYears: true });
  });

  it("defaultState wires display.reportPeriod through defaultReportPeriod for the initial plan", () => {
    const s = defaultState(PROFILES, NOW);
    expect(s.display.reportPeriod).toEqual(defaultReportPeriod(s.plan));
  });
});

describe("Key Dates (Tier 1.1) — retirementAge, keyDates, DateRef clamping", () => {
  it("every person defaults to retirementAge 65, clamped to [18, 120] and then to [currentAge, endAge]", () => {
    const s = defaultState(PROFILES, NOW);
    expect(s.plan.client.retirementAge).toBe(DEFAULT_RETIREMENT_AGE);
    const withCustom = clampPlan({ ...couplePlan(), client: { ...couplePlan().client, retirementAge: 60 } });
    expect(withCustom.client.retirementAge).toBe(60);
    expect(withCustom.partner.retirementAge).toBe(DEFAULT_RETIREMENT_AGE);
    // The static [18,120] bound alone would allow 5 through; input
    // integrity requires the tighter [currentAge, endAge] bound (a
    // retirement before "now" or after the projection's own end isn't
    // a real retirement date this tool can model) — couplePlan()'s
    // client is 40, endAge 90, so 5 clamps up to 40, not down to 18.
    expect(clampPlan({ ...couplePlan(), client: { ...couplePlan().client, retirementAge: 5 } }).client.retirementAge).toBe(40);
    // Above the projection's own end clamps down to endAge.
    expect(clampPlan({ ...couplePlan(), client: { ...couplePlan().client, retirementAge: 200 } }).client.retirementAge).toBe(90);
  });

  it("defaultPlan/clampPlan carry an empty keyDates array by default", () => {
    const s = defaultState(PROFILES, NOW);
    expect(s.plan.keyDates).toEqual([]);
  });

  it("createKeyDate/clampKeyDate/normaliseKeyDates: basis falls back to client without a partner", () => {
    const plan = clampPlan(couplePlan());
    const kd = createKeyDate(plan);
    expect(kd.basis).toBe("client");
    const clamped = clampKeyDate({ label: "Buy a home", basis: "partner", age: 46 }, plan);
    expect(clamped).toMatchObject({ label: "Buy a home", basis: "partner", age: 46 });
    const single = clampPlan({ ...couplePlan(), household: "single", partner: null });
    expect(clampKeyDate({ basis: "partner", age: 46 }, single).basis).toBe("client");
    // Defends junk the same way normaliseProperties/normaliseLiabilities
    // do elsewhere in this module: every entry is coerced, not dropped.
    expect(normaliseKeyDates([{ label: "A", age: 50 }, "junk", null], plan)).toHaveLength(3);
    expect(normaliseKeyDates(null, plan)).toEqual([]);
  });

  it("clampDateRef keeps a valid anchor reference as-is; an unknown anchor or bare number clamps to an explicit age", () => {
    const plan = clampPlan({ ...couplePlan(), keyDates: [{ id: "kd1", label: "Buy a home", basis: "client", age: 46 }] });
    expect(clampDateRef({ kind: "anchor", anchorId: "start" }, 40, 90, plan))
      .toEqual({ kind: "anchor", anchorId: "start" });
    expect(clampDateRef({ kind: "anchor", anchorId: "kd1" }, 40, 90, plan))
      .toEqual({ kind: "anchor", anchorId: "kd1" });
    expect(clampDateRef({ kind: "anchor", anchorId: "nope" }, 40, 90, plan).kind).toBe("age");
    expect(clampDateRef({ kind: "age", age: 55 }, 40, 90, plan)).toEqual({ kind: "age", age: 55 });
    expect(clampDateRef(55, 40, 90, plan)).toEqual({ kind: "age", age: 55 }); // legacy bare number
    expect(clampDateRef({ kind: "age", age: 200 }, 40, 90, plan)).toEqual({ kind: "age", age: 90 }); // clamped
  });

  it("removeKeyDate drops exactly the matching key date", () => {
    const plan = clampPlan({ ...couplePlan(), keyDates: [{ id: "kd1", label: "A", age: 46 }, { id: "kd2", label: "B", age: 50 }] });
    const out = removeKeyDate(plan, "kd1");
    expect(out.keyDates.map((k) => k.id)).toEqual(["kd2"]);
  });

  it("referencesToAnchor finds every row pointing at a key date, across every row type", () => {
    const plan = clampPlan({ ...couplePlan(), keyDates: [{ id: "kd1", label: "Buy a home", basis: "client", age: 46 }] });
    const anchorTo = (id) => ({ kind: "anchor", anchorId: id });
    const state = {
      cashflows: {
        income: [{ id: "i1", label: "Salary", from: anchorTo("start"), to: anchorTo("kd1") }],
        expenses: [{ id: "e1", label: "Living", from: anchorTo("kd1"), to: anchorTo("end") }],
        contributions: [{ id: "c1", from: anchorTo("kd1"), to: anchorTo("end") }],
        withdrawals: [{ id: "w1", from: anchorTo("start"), to: anchorTo("end") }], // no reference
        lumpSums: [{ id: "l1", at: anchorTo("kd1") }],
      },
      properties: [{ id: "p1", name: "Investment unit", purchaseAt: anchorTo("kd1") }],
    };
    const refs = referencesToAnchor(state, "kd1");
    expect(refs).toHaveLength(5); // income.to, expenses.from, contributions.from, lumpSums.at, properties.purchaseAt
    expect(refs.map((r) => r.id).sort()).toEqual(["c1", "e1", "i1", "l1", "p1"].sort());
    // Scanning works generically for any anchorId, including built-ins
    // — here, exactly the two rows anchored to "start".
    expect(referencesToAnchor(state, "start")).toHaveLength(2);
    expect(referencesToAnchor(state, "nonexistent-id")).toHaveLength(0);
  });

  it("convertAnchorReferences swaps every matching reference to an explicit age and leaves everything else untouched", () => {
    const anchorTo = (id) => ({ kind: "anchor", anchorId: id });
    const state = {
      cashflows: {
        income: [{ id: "i1", from: anchorTo("start"), to: anchorTo("kd1") }],
        expenses: [{ id: "e1", from: anchorTo("kd1"), to: anchorTo("end") }],
        contributions: [], withdrawals: [],
        lumpSums: [{ id: "l1", at: anchorTo("kd1") }],
      },
      properties: [{ id: "p1", purchaseAt: anchorTo("kd1") }],
    };
    const out = convertAnchorReferences(state, "kd1", 46);
    expect(out.cashflows.income[0].to).toEqual({ kind: "age", age: 46 });
    expect(out.cashflows.income[0].from).toEqual({ kind: "anchor", anchorId: "start" }); // untouched
    expect(out.cashflows.expenses[0].from).toEqual({ kind: "age", age: 46 });
    expect(out.cashflows.expenses[0].to).toEqual({ kind: "anchor", anchorId: "end" }); // untouched
    expect(out.cashflows.lumpSums[0].at).toEqual({ kind: "age", age: 46 });
    expect(out.properties[0].purchaseAt).toEqual({ kind: "age", age: 46 });
    // No references left afterwards.
    expect(referencesToAnchor(out, "kd1")).toHaveLength(0);
  });
});

describe("Tier 1.2 — Super (Commit 1): accounts, per-person state, contributions, income type", () => {
  it("defaultPlan/defaultState ship an empty superAccounts array and empty superContributions", () => {
    const s = defaultState(PROFILES, NOW);
    expect(s.plan.superAccounts).toEqual([]);
    expect(s.cashflows.superContributions).toEqual([]);
  });

  it("every person defaults to an empty 5-entry carry-forward ledger, no bring-forward trigger, work test met", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    for (const person of [plan.client, plan.partner]) {
      expect(person.super.carryForward).toEqual([0, 0, 0, 0, 0]);
      expect(person.super.carryForward).toHaveLength(CARRY_FORWARD_YEARS);
      expect(person.super.bringForwardTriggeredYear).toBeNull();
      expect(person.super.workTestMet).toBe(true);
    }
  });

  it("clampPersonSuper (via clampPlan) pads/truncates carryForward to exactly 5 entries and clamps values", () => {
    const raw = { ...couplePlan(), client: { ...couplePlan().client, super: { carryForward: [-5, 100, 200] } } };
    const plan = clampPlan(raw, PROFILES);
    expect(plan.client.super.carryForward).toEqual([0, 100, 200, 0, 0]);
  });

  it("createSuperAccount defaults to the owner's default (mid) profile and a name derived from their identity", () => {
    const plan = clampPlan({ ...couplePlan(), client: { ...couplePlan().client, firstName: "Jo" } }, PROFILES);
    const sa = createSuperAccount(plan, [], PROFILES, "client");
    expect(sa.owner).toBe("client");
    expect(sa.name).toBe("Super — Jo");
    expect(sa.balance).toBe(0);
    expect(sa.taxFreeComponent).toBe(0);
    expect(sa.include).toBe(true);
    expect(Object.keys(PROFILES)).toContain(sa.allocation.profile);
  });

  it("clampSuperAccount clamps taxFreeComponent to [0, balance] and demotes an orphan partner owner", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const sa = clampSuperAccount({ owner: "partner", balance: 100000, taxFreeComponent: 999999 }, plan, PROFILES);
    expect(sa.taxFreeComponent).toBe(100000); // clamped to the balance
    const single = clampPlan({ ...couplePlan(), household: "single", partner: null }, PROFILES);
    expect(clampSuperAccount({ owner: "partner", balance: 0 }, single, PROFILES).owner).toBe("client");
  });

  it("insurancePremium (spec 19 Commit 7) defaults to CPI + 3%, not clampIndexation's usual +0%", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const created = createSuperAccount(plan, [], PROFILES, "client");
    expect(created.insurancePremium).toEqual({ amount: 0, indexBasis: "cpi", indexExtraPct: 3 });
    // A bare clamp of a pre-Commit-7 account (no insurancePremium field
    // at all) gets the same default, not a silently-zeroed indexation.
    const clamped = clampSuperAccount({ owner: "client", balance: 0 }, plan, PROFILES);
    expect(clamped.insurancePremium).toEqual({ amount: 0, indexBasis: "cpi", indexExtraPct: 3 });
    // An explicit amount/indexation round-trips untouched.
    const withAmount = clampSuperAccount({ owner: "client", balance: 0, insurancePremium: { amount: 1500, indexBasis: "none", indexExtraPct: 0 } }, plan, PROFILES);
    expect(withAmount.insurancePremium).toEqual({ amount: 1500, indexBasis: "none", indexExtraPct: 0 });
  });

  it("contributionSplitPct (spec 19 Commit 6 completion) is clamped to [0, 85] for a couple, and forced to 0 for a single client", () => {
    const couple = clampPlan(couplePlan(), PROFILES);
    const single = clampPlan({ ...couplePlan(), household: "single", partner: null }, PROFILES);
    expect(createSuperAccount(couple, [], PROFILES, "client").contributionSplitPct).toBe(0); // opt-in only
    expect(clampSuperAccount({ owner: "client", balance: 0, contributionSplitPct: 200 }, couple, PROFILES).contributionSplitPct).toBe(85);
    expect(clampSuperAccount({ owner: "client", balance: 0, contributionSplitPct: -10 }, couple, PROFILES).contributionSplitPct).toBe(0);
    // A single client has no spouse to split to — the field would look
    // entered but do nothing downstream, so it's forced to 0 rather
    // than left to silently mean nothing (input integrity).
    expect(clampSuperAccount({ owner: "client", balance: 0, contributionSplitPct: 50 }, single, PROFILES).contributionSplitPct).toBe(0);
  });

  it("normaliseSuperAccounts defends non-array input", () => {
    expect(normaliseSuperAccounts(null, clampPlan(couplePlan(), PROFILES), PROFILES)).toEqual([]);
  });

  it("pensionMinCommenceAge (spec 20, Commit 1): ABP is superReleaseAge's two-condition gate; TTR is the flat preservation age only", () => {
    expect(pensionMinCommenceAge("ttr", 45)).toBe(60); // retirementAge irrelevant to TTR
    expect(pensionMinCommenceAge("ttr", 70)).toBe(60);
    expect(pensionMinCommenceAge("abp", 50)).toBe(60); // floored at preservation age
    expect(pensionMinCommenceAge("abp", 62)).toBe(62); // retirement at/after 60
    expect(pensionMinCommenceAge("abp", 70)).toBe(65); // capped at unrestricted access
  });

  it("createPension defaults to the owner's own super account, tracks the owner's retirement key date, and picks ABP/TTR from the owner's current age", () => {
    const plan = clampPlan(couplePlan(), PROFILES); // client 40, partner 36
    const su = createSuperAccount(plan, [], PROFILES, "client");
    const pn = createPension(plan, [], [su], "client");
    expect(pn.owner).toBe("client");
    expect(pn.sourceAccountId).toBe(su.id);
    expect(pn.commenceAt).toEqual({ kind: "anchor", anchorId: "retirement-client" });
    expect(pn.type).toBe("ttr"); // 40 < unrestrictedAccessAge (65)
    expect(pn.commenceAmount).toBeNull(); // whole balance
    expect(pn.reversionary).toBe(false);
    expect(pn.taxFreeProportion).toBeNull();

    const old = clampPlan({ ...couplePlan(), client: { currentAge: 66 } }, PROFILES);
    expect(createPension(old, [], [su], "client").type).toBe("abp");
  });

  it("clampPension drops a sourceAccountId belonging to the OTHER person — never attributes one person's future income stream to the other's super", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const suClient = createSuperAccount(plan, [], PROFILES, "client");
    const suPartner = createSuperAccount(plan, [], PROFILES, "partner");
    const pn = clampPension(
      { owner: "client", sourceAccountId: suPartner.id, type: "abp", commenceAt: { kind: "age", age: 65 } },
      plan, [suClient, suPartner], PROFILES
    );
    expect(pn.sourceAccountId).toBeNull();
    // The correct pairing round-trips untouched.
    const ok = clampPension(
      { owner: "client", sourceAccountId: suClient.id, type: "abp", commenceAt: { kind: "age", age: 65 } },
      plan, [suClient, suPartner], PROFILES
    );
    expect(ok.sourceAccountId).toBe(suClient.id);
  });

  it("clampPension (spec 22, Commit 2): reversionary resets to false with no partner in the household — meaningless with nobody to revert to", () => {
    const couple = clampPlan(couplePlan(), PROFILES);
    const suCouple = createSuperAccount(couple, [], PROFILES, "client");
    const withPartner = clampPension(
      { owner: "client", sourceAccountId: suCouple.id, type: "abp", commenceAt: { kind: "age", age: 65 }, reversionary: true },
      couple, [suCouple], PROFILES
    );
    expect(withPartner.reversionary).toBe(true);

    const single = clampPlan({ ...couplePlan(), household: "single", partner: null }, PROFILES);
    const suSingle = createSuperAccount(single, [], PROFILES, "client");
    const withoutPartner = clampPension(
      { owner: "client", sourceAccountId: suSingle.id, type: "abp", commenceAt: { kind: "age", age: 65 }, reversionary: true },
      single, [suSingle], PROFILES
    );
    expect(withoutPartner.reversionary).toBe(false);
  });

  it("clampPension bounds commenceAt to a plain CLIENT-anchored age window, NOT the owner's own condition-of-release gate — a partner's pension age is never compared against the wrong person's ages", () => {
    const plan = clampPlan(couplePlan(), PROFILES); // client 40-90, partner 36
    const su = createSuperAccount(plan, [], PROFILES, "partner");
    // An age-45 request (well below any release gate for EITHER type) is
    // still perfectly enterable — see pensionMinCommenceAge's own header
    // for why the gate is enforced engine-side, not here.
    const pn = clampPension(
      { owner: "partner", sourceAccountId: su.id, type: "abp", commenceAt: { kind: "age", age: 45 } },
      plan, [su], PROFILES
    );
    expect(pn.commenceAt).toEqual({ kind: "age", age: 45 });
    // Still bounded to the plan's own client-anchored window — an age
    // below currentAge or beyond endAge is genuinely unenterable.
    const clampedLow = clampPension(
      { owner: "partner", sourceAccountId: su.id, type: "abp", commenceAt: { kind: "age", age: 10 } },
      plan, [su], PROFILES
    );
    expect(clampedLow.commenceAt.age).toBe(40); // plan.client.currentAge
    const clampedHigh = clampPension(
      { owner: "partner", sourceAccountId: su.id, type: "abp", commenceAt: { kind: "age", age: 999 } },
      plan, [su], PROFILES
    );
    expect(clampedHigh.commenceAt.age).toBe(90); // plan.endAge
  });

  it("clampPension: type defends against a junk value, and taxFreeProportion is always null (engine-derived only, never stored here)", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const su = createSuperAccount(plan, [], PROFILES, "client");
    const pn = clampPension(
      { owner: "client", sourceAccountId: su.id, type: "not-a-real-type", commenceAt: { kind: "age", age: 65 }, taxFreeProportion: 0.4 },
      plan, [su], PROFILES
    );
    expect(PENSION_TYPES).toContain(pn.type);
    expect(pn.type).toBe("abp"); // the defensive default
    expect(pn.taxFreeProportion).toBeNull(); // never trusts a stored value
  });

  it("normalisePensions defends non-array input", () => {
    expect(normalisePensions(null, clampPlan(couplePlan(), PROFILES), [], PROFILES)).toEqual([]);
  });

  it("createPension defaults to the minimum drawdown option (spec 20, Commit 2)", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const su = createSuperAccount(plan, [], PROFILES, "client");
    const pn = createPension(plan, [], [su], "client");
    expect(pn.drawdownOption).toBe("minimum");
    expect(pn.fixedAmount).toBe(0);
  });

  it("clampPension: 'maximum' is TTR-only — an ABP with it stored is reset to 'minimum', never silently honoured (input integrity)", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const su = createSuperAccount(plan, [], PROFILES, "client");
    const abpWithMax = clampPension(
      { owner: "client", sourceAccountId: su.id, type: "abp", drawdownOption: "maximum", commenceAt: { kind: "age", age: 65 } },
      plan, [su], PROFILES
    );
    expect(abpWithMax.drawdownOption).toBe("minimum");
    // The same option is preserved for a TTR.
    const ttrWithMax = clampPension(
      { owner: "client", sourceAccountId: su.id, type: "ttr", drawdownOption: "maximum", commenceAt: { kind: "age", age: 65 } },
      plan, [su], PROFILES
    );
    expect(ttrWithMax.drawdownOption).toBe("maximum");
  });

  it("clampPension defends a junk drawdownOption and clamps fixedAmount to non-negative", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const su = createSuperAccount(plan, [], PROFILES, "client");
    const pn = clampPension(
      { owner: "client", sourceAccountId: su.id, type: "abp", drawdownOption: "not-a-real-option", fixedAmount: -500, commenceAt: { kind: "age", age: 65 } },
      plan, [su], PROFILES
    );
    expect(pn.drawdownOption).toBe("minimum");
    expect(pn.fixedAmount).toBe(0);
  });

  it("clampPension (grandfathering, spec 21b Commit 3): a valid pre-2015 commencement with a resolvable owner DOB computes the life-expectancy factor at commencement", () => {
    const plan = clampPlan(couplePlan(), PROFILES); // client dob synthesised to 1986-07-01, male (start FY2026/27, age 40)
    const su = createSuperAccount(plan, [], PROFILES, "client");
    const pn = clampPension(
      {
        owner: "client", sourceAccountId: su.id, type: "abp", commenceAt: { kind: "age", age: 65 },
        grandfathered: true, grandfatheredCommencedOn: "2010-07-01", grandfatheredPurchasePrice: 300000,
      },
      plan, [su], PROFILES
    );
    expect(pn.grandfathered).toBe(true);
    expect(pn.grandfatheredCommencedOn).toBe("2010-07-01");
    expect(pn.grandfatheredPurchasePrice).toBe(300000);
    // dob 1986-07-01 → exact age 24 at 2010-07-01 → ABS male ex(24) = 57.88 (see lifeTables.js header)
    expect(pn.grandfatheredLifeExpectancyYears).toBeCloseTo(57.88, 6);
  });

  it("clampPension (grandfathering): a commencement on/after 1 January 2015 is not a real grandfathering case — resets to false rather than silently keeping it (input integrity)", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const su = createSuperAccount(plan, [], PROFILES, "client");
    const pn = clampPension(
      {
        owner: "client", sourceAccountId: su.id, type: "abp", commenceAt: { kind: "age", age: 65 },
        grandfathered: true, grandfatheredCommencedOn: "2015-01-01", grandfatheredPurchasePrice: 300000,
      },
      plan, [su], PROFILES
    );
    expect(pn.grandfathered).toBe(false);
    expect(pn.grandfatheredCommencedOn).toBeNull();
    expect(pn.grandfatheredPurchasePrice).toBe(0); // clamps to 0 once not grandfathered
    expect(pn.grandfatheredLifeExpectancyYears).toBeNull();
  });

  it("clampPension (grandfathering): an owner with no resolvable DOB also prevents grandfathering from taking effect — no valid factor, no claim", () => {
    const plan = { client: { currentAge: 40 }, partner: null, endAge: 90 }; // hand-built, no dob on the owner
    const su = { id: "su1", owner: "client" };
    const pn = clampPension(
      {
        owner: "client", sourceAccountId: su.id, type: "abp", commenceAt: { kind: "age", age: 65 },
        grandfathered: true, grandfatheredCommencedOn: "2010-07-01", grandfatheredPurchasePrice: 300000,
      },
      plan, [su], PROFILES
    );
    expect(pn.grandfathered).toBe(false);
    expect(pn.grandfatheredLifeExpectancyYears).toBeNull();
    expect(pn.grandfatheredPurchasePrice).toBe(0);
  });

  it("clampPension (grandfathering): grandfatheredPurchasePrice always clamps to 0 when not grandfathered, regardless of the stored raw value", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const su = createSuperAccount(plan, [], PROFILES, "client");
    const pn = clampPension(
      { owner: "client", sourceAccountId: su.id, type: "abp", commenceAt: { kind: "age", age: 65 }, grandfathered: false, grandfatheredPurchasePrice: 500000 },
      plan, [su], PROFILES
    );
    expect(pn.grandfathered).toBe(false);
    expect(pn.grandfatheredPurchasePrice).toBe(0);
  });

  it("super accounts are structurally invisible to fundingOrder and settings — there is no path to include one", () => {
    // normaliseFundingOrder/normaliseSettings only ever consult
    // state.assets; a super account id is never even a candidate.
    const plan = { client: { currentAge: 40 }, partner: null, endAge: 90 };
    expect(normaliseFundingOrder(["su1"], [])).toEqual([]);
    const raw = {
      surplus: { periods: [{ ...createSurplusPeriod(), allocations: [{ id: "sa1", targetType: "asset", targetId: "su1", pct: 100 }] }] },
      fundingOrder: ["su1"],
    };
    const settings = normaliseSettings(raw, [], plan);
    expect(settings.fundingOrder).toEqual([]);
    expect(settings.surplus.periods[0].allocations).toEqual([]);
  });

  it("hydrate drops contribution/withdrawal/lump-sum rows that target a super account id (not a financial asset)", () => {
    const s = defaultState(PROFILES, NOW);
    s.plan.superAccounts = [{ id: "su1", owner: "client", balance: 1000 }];
    s.cashflows.contributions.push({
      id: "c2", assetId: "su1", amount: 500, frequency: "monthly",
      from: { kind: "age", age: 40 }, to: { kind: "age", age: 90 }, indexBasis: "cpi", indexExtraPct: 0,
    });
    const back = hydrate(serialize(s), PROFILES);
    expect(back.cashflows.contributions.some((c) => c.assetId === "su1")).toBe(false);
  });

  it("income rows default to category salary / incomeType employment with sgApplies true; other categories force sgApplies false", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const row = createIncomeRow(plan, []);
    expect(row.category).toBe("salary");
    expect(row.incomeType).toBe("employment");
    expect(row.sgApplies).toBe(true);
    // category is authoritative going forward — setting a non-salary
    // category forces incomeType/sgApplies to follow it, regardless of
    // whatever was stored for either.
    const clamped = clampIncomeRow({ ...row, category: "afterTaxBonus", incomeType: "employment", sgApplies: true }, plan);
    expect(clamped.incomeType).toBe("nonTaxable");
    expect(clamped.sgApplies).toBe(false); // forced off — SG only ever applies to employment income
    expect(INCOME_TYPES).toEqual(["employment", "rental", "otherTaxable", "nonTaxable"]);
  });

  it("Input behaviour fix: label tracks the category for income/expense/deduction rows, and stops once the user types their own", () => {
    const plan = clampPlan(couplePlan(), PROFILES);

    // Fresh rows start tracking (labelIsDefault: true) and follow a
    // category change.
    const inc = createIncomeRow(plan, []);
    expect(inc.labelIsDefault).toBe(true);
    expect(inc.label).toBe(INCOME_CATEGORY_LABELS.salary);
    const incChanged = clampIncomeRow({ ...inc, category: "afterTaxBonus" }, plan);
    expect(incChanged.label).toBe(INCOME_CATEGORY_LABELS.afterTaxBonus);
    expect(incChanged.labelIsDefault).toBe(true);
    // Once overridden, a further category change leaves the label alone.
    const incOverridden = clampIncomeRow({ ...incChanged, label: "My bonus", labelIsDefault: false, category: "dividendIncome" }, plan);
    expect(incOverridden.label).toBe("My bonus");
    expect(incOverridden.labelIsDefault).toBe(false);

    const exp = createExpenseRow(plan, []);
    expect(exp.labelIsDefault).toBe(true);
    const expChanged = clampExpenseRow({ ...exp, category: "holidays" }, plan);
    expect(expChanged.label).toBe(EXPENSE_CATEGORY_LABELS.holidays);
    const expOverridden = clampExpenseRow({ ...expChanged, label: "Bali trip", labelIsDefault: false, category: "other" }, plan);
    expect(expOverridden.label).toBe("Bali trip");

    const ded = createDeductionRow(plan, []);
    expect(ded.labelIsDefault).toBe(true);
    const dedChanged = clampDeductionRow({ ...ded, category: "vehicle" }, plan);
    expect(dedChanged.label).toBe(DEDUCTION_CATEGORY_LABELS.vehicle);
    const dedOverridden = clampDeductionRow({ ...dedChanged, label: "Ute", labelIsDefault: false, category: "other" }, plan);
    expect(dedOverridden.label).toBe("Ute");

    // Regression: a pre-this-fix row has an explicit label and no
    // labelIsDefault field at all — must never be silently overwritten.
    const legacy = clampExpenseRow({ id: "ex1", label: "Council rates", category: "nonDiscretionary", amount: 3000, frequency: "annual" }, plan);
    expect(legacy.label).toBe("Council rates");
    expect(legacy.labelIsDefault).toBe(false);
  });

  it("a pre-Commit-2 row (incomeType only, no category — including the legacy 'rental' value) migrates on read", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const legacyEmployment = clampIncomeRow({ id: "i1", label: "Salary", owner: "client", amount: 100000, frequency: "annual", incomeType: "employment", sgApplies: true }, plan);
    expect(legacyEmployment.category).toBe("salary");
    expect(legacyEmployment.incomeType).toBe("employment");

    const legacyRental = clampIncomeRow({ id: "i2", label: "Rent", owner: "client", amount: 20000, frequency: "annual", incomeType: "rental", sgApplies: false }, plan);
    expect(legacyRental.category).toBe("otherIncome"); // no dedicated category for the old "rental" value
    expect(legacyRental.incomeType).toBe("otherTaxable");
    expect(legacyRental.sgApplies).toBe(false);

    const legacyNonTaxable = clampIncomeRow({ id: "i3", label: "Gift", owner: "client", amount: 5000, frequency: "annual", incomeType: "nonTaxable" }, plan);
    expect(legacyNonTaxable.category).toBe("otherTaxFreeIncome");
    expect(legacyNonTaxable.incomeType).toBe("nonTaxable");
  });

  it("createSuperContribution/clampSuperContribution: shape, type/basis validation, account and income-row reference checks", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const account = createSuperAccount(plan, [], PROFILES, "client");
    const sc = createSuperContribution(plan, [account], "client");
    expect(sc.accountId).toBe(account.id);
    expect(sc.type).toBe("salarySacrifice");
    expect(sc.basis).toBe("amount");

    const accountIds = new Map([[account.id, "client"]]);
    const incomeIds = new Set(["i1"]);
    const clamped = clampSuperContribution(
      { type: "bogus", basis: "bogus", accountId: "nope", incomeRowId: "nope", amount: -5, percent: 200 },
      plan, accountIds, incomeIds
    );
    expect(SUPER_CONTRIBUTION_TYPES).toContain(clamped.type);
    expect(clamped.type).toBe("salarySacrifice"); // default fallback
    expect(SUPER_CONTRIBUTION_BASES).toContain(clamped.basis);
    expect(clamped.basis).toBe("amount");
    expect(clamped.accountId).toBeNull(); // unknown account dropped
    expect(clamped.incomeRowId).toBeNull(); // unknown income row dropped
    expect(clamped.amount).toBe(0);
    expect(clamped.percent).toBe(100); // clamped to [0, 100]

    const valid = clampSuperContribution(
      { accountId: account.id, incomeRowId: "i1", type: "spouse", basis: "percentOfIncome" },
      plan, accountIds, incomeIds
    );
    expect(valid.accountId).toBe(account.id);
    expect(valid.incomeRowId).toBe("i1");
    expect(valid.type).toBe("spouse");
    expect(valid.basis).toBe("percentOfIncome");
  });

  it("normaliseSuperContributions defends non-array input", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    expect(normaliseSuperContributions(null, plan, new Map(), new Set())).toEqual([]);
  });
});

describe("Tier 1.2 — Super (Commit 3): withdrawals, preservation, proportioning", () => {
  it("createSuperWithdrawal defaults to the owner's account, retirement-anchored from, plan-end to", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const account = createSuperAccount(plan, [], PROFILES, "client");
    const sw = createSuperWithdrawal(plan, [account], "client");
    expect(sw.owner).toBe("client");
    expect(sw.accountId).toBe(account.id);
    expect(sw.amount).toBe(0);
    expect(sw.frequency).toBe("monthly");
    expect(sw.from).toEqual({ kind: "anchor", anchorId: "retirement-client" });
    expect(sw.to).toEqual({ kind: "anchor", anchorId: "end" });
  });

  it("createSuperWithdrawal with no matching account for the owner leaves accountId null", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const sw = createSuperWithdrawal(plan, [], "client");
    expect(sw.accountId).toBeNull();
  });

  it("clampSuperWithdrawal validates amount, frequency, and drops an unknown account reference", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const account = createSuperAccount(plan, [], PROFILES, "client");
    const accountIds = new Map([[account.id, "client"]]);
    const clamped = clampSuperWithdrawal(
      { owner: "client", accountId: "nope", amount: -500, frequency: "bogus" },
      plan, accountIds
    );
    expect(clamped.accountId).toBeNull(); // unknown account dropped, row itself survives
    expect(clamped.amount).toBe(0); // clamped to >= 0
    expect(clamped.frequency).toBe("monthly"); // invalid → default

    const valid = clampSuperWithdrawal(
      { owner: "client", accountId: account.id, amount: 2000, frequency: "annual" },
      plan, accountIds
    );
    expect(valid.accountId).toBe(account.id);
    expect(valid.amount).toBe(2000);
    expect(valid.frequency).toBe("annual");
  });

  it("clampSuperWithdrawal demotes an orphan partner owner to client", () => {
    const single = clampPlan({ ...couplePlan(), household: "single", partner: null }, PROFILES);
    const clamped = clampSuperWithdrawal({ owner: "partner", accountId: null, amount: 0 }, single, new Map());
    expect(clamped.owner).toBe("client");
  });

  it("normaliseSuperWithdrawals defends non-array input", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    expect(normaliseSuperWithdrawals(null, plan, new Map())).toEqual([]);
  });

  it("hydrate round-trips cashflows.superWithdrawals", () => {
    const s = defaultState(PROFILES, NOW);
    const account = createSuperAccount(s.plan, [], PROFILES, "client");
    s.plan.superAccounts = [account];
    s.cashflows.superWithdrawals.push({
      id: "sw1", label: "Lump sum", owner: "client", accountId: account.id,
      amount: 1000, frequency: "monthly",
      from: { kind: "age", age: 65 }, to: { kind: "age", age: 90 },
      indexBasis: "cpi", indexExtraPct: 0,
    });
    const back = hydrate(serialize(s), PROFILES);
    expect(back.cashflows.superWithdrawals).toHaveLength(1);
    expect(back.cashflows.superWithdrawals[0].accountId).toBe(account.id);
  });
});

describe("Working Cash Account (engine correctness fix)", () => {
  it("clampWorkingCash defaults balance/minimumBalance to 0 and ratePct to null", () => {
    expect(clampWorkingCash(undefined)).toEqual({ balance: 0, minimumBalance: 0, ratePct: null });
    expect(clampWorkingCash(null)).toEqual({ balance: 0, minimumBalance: 0, ratePct: null });
  });

  it("clampWorkingCash clamps balance/minimumBalance to >= 0 and ratePct into [-10, 30] when set", () => {
    expect(clampWorkingCash({ balance: -500, minimumBalance: -10, ratePct: 4 }))
      .toEqual({ balance: 0, minimumBalance: 0, ratePct: 4 });
    expect(clampWorkingCash({ balance: 20000, minimumBalance: 5000, ratePct: 999 }))
      .toEqual({ balance: 20000, minimumBalance: 5000, ratePct: 30 });
    expect(clampWorkingCash({ balance: 20000, minimumBalance: 5000, ratePct: null }).ratePct).toBeNull();
  });

  it("defaultPlan ships a zeroed workingCash with a null (profile-derived) rate", () => {
    const s = defaultState(PROFILES, NOW);
    expect(s.plan.workingCash).toEqual({ balance: 0, minimumBalance: 0, ratePct: null });
  });

  it("clampPlan stamps workingCash even when the raw plan never had one (pre-WCA migration)", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    expect(plan.workingCash).toEqual({ balance: 0, minimumBalance: 0, ratePct: null });
  });

  it("clampPlan preserves an explicit workingCash through the clamp", () => {
    const raw = { ...couplePlan(), workingCash: { balance: 15000, minimumBalance: 2000, ratePct: 4.5 } };
    const plan = clampPlan(raw, PROFILES);
    expect(plan.workingCash).toEqual({ balance: 15000, minimumBalance: 2000, ratePct: 4.5 });
  });

  it("defaultState's default surplus treatment is accumulate, not spend", () => {
    const s = defaultState(PROFILES, NOW);
    expect(s.settings.surplus.periods[0]).toMatchObject({ allocations: [], remainderTo: "cash" });
  });

  it("hydrate migrates a pre-WCA (v8) blob forward, stamping the default workingCash", () => {
    const v8 = {
      schemaVersion: 8,
      plan: {
        household: "single",
        client: { currentAge: 40 },
        partner: null,
        endAge: 90,
        start: { year: 2026, month: 7 },
      },
      assets: [{ id: "a1", name: "A", include: true, owner: "client", distributions: "reinvest",
                 balance: 1000, allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0,
                 cgtAsset: false, costBase: null }],
      cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [],
                   superContributions: [], superWithdrawals: [] },
      settings: { surplus: { mode: "spend", assetId: null }, fundingOrder: ["a1"] },
      display: { units: "real" },
      assumptions: { cpi: 0.025 },
    };
    const s = hydrate(JSON.stringify(v8), PROFILES);
    expect(s).not.toBeNull();
    expect(s.plan.workingCash).toEqual({ balance: 0, minimumBalance: 0, ratePct: null });
    // An existing scenario's explicit "spend" choice is preserved —
    // migrated to the period model's equivalent (100% remainder to
    // expenditure, non-deductible-first off for bit-identity) — the
    // new payNonDeductibleDebtFirst-true default only applies to
    // brand-new scenarios.
    expect(s.settings.surplus.periods).toHaveLength(1);
    expect(s.settings.surplus.periods[0]).toMatchObject({ payNonDeductibleDebtFirst: false, allocations: [], remainderTo: "expenditure" });
  });
});

describe("Adviser fees and flow of initial funds (Implementation/Rates spec, Commit 2)", () => {
  const superAccounts = [{ id: "su1", owner: "client" }, { id: "su2", owner: "partner" }];

  it("defaultAdviserFees/defaultImplementation ship an all-zero, no-op shape", () => {
    expect(defaultAdviserFees()).toEqual({
      upfront: { total: 0, fromSuperAmount: 0, superAccountId: null },
      ongoing: { annualAmount: 0, fromSuperAmount: 0, superAccountId: null, indexBasis: "cpi" },
    });
    expect(defaultImplementation()).toEqual({ totalCashAvailable: 0, emergencyFundTarget: 0, allocations: [] });
  });

  it("clampAdviserFees bounds fromSuperAmount to [0, the fee it covers] but does not zero it just because no account is nominated yet", () => {
    const clamped = clampAdviserFees({
      upfront: { total: 10000, fromSuperAmount: 15000, superAccountId: null }, // over-requested AND no account yet
      ongoing: { annualAmount: 5000, fromSuperAmount: 2000, superAccountId: "nope", indexBasis: "bogus" },
    }, superAccounts);
    expect(clamped.upfront.fromSuperAmount).toBe(10000); // capped at the fee total
    expect(clamped.upfront.superAccountId).toBeNull(); // preserved as null, not defaulted to a guess
    expect(clamped.ongoing.superAccountId).toBeNull(); // a stale/unknown account id falls back to null
    expect(clamped.ongoing.fromSuperAmount).toBe(2000); // NOT wiped by the invalid account id
    expect(clamped.ongoing.indexBasis).toBe("cpi"); // invalid basis falls back to cpi
  });

  it("clampAdviserFees accepts a valid nominated super account", () => {
    const clamped = clampAdviserFees({
      upfront: { total: 20000, fromSuperAmount: 12000, superAccountId: "su1" },
      ongoing: { annualAmount: 0, fromSuperAmount: 0, superAccountId: null, indexBasis: "awote" },
    }, superAccounts);
    expect(clamped.upfront).toEqual({ total: 20000, fromSuperAmount: 12000, superAccountId: "su1" });
    expect(clamped.ongoing.indexBasis).toBe("awote");
  });

  it("clampPlan wires adviserFees/implementation with defaults when the raw plan never had them", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    expect(plan.adviserFees).toEqual(defaultAdviserFees());
    expect(plan.implementation).toEqual(defaultImplementation());
  });

  it("emergencyFundTarget writes through to workingCash.minimumBalance once it's set, without clobbering a manually-entered minimum when it's still zero", () => {
    const untouched = clampPlan({ ...couplePlan(), workingCash: { balance: 0, minimumBalance: 8000, ratePct: null } }, PROFILES);
    expect(untouched.workingCash.minimumBalance).toBe(8000); // implementation never touched — the manual value survives

    const withTarget = clampPlan({
      ...couplePlan(),
      workingCash: { balance: 0, minimumBalance: 8000, ratePct: null },
      implementation: { totalCashAvailable: 0, emergencyFundTarget: 25000, allocations: [] },
    }, PROFILES);
    expect(withTarget.workingCash.minimumBalance).toBe(25000); // now authoritative
  });

  it("clampImplementationBasic accepts any string targetAssetId shape (existence is checked later, by refineImplementationAllocations)", () => {
    const raw = { totalCashAvailable: 500000, emergencyFundTarget: 20000, allocations: [{ label: "Home deposit", amount: 100000, targetAssetId: "does-not-exist-yet" }] };
    const clamped = clampImplementationBasic(raw);
    expect(clamped.totalCashAvailable).toBe(500000);
    expect(clamped.allocations[0].targetAssetId).toBe("does-not-exist-yet");
    expect(clamped.allocations[0].id).toBeTruthy();
  });

  it("refineImplementationAllocations falls a stale/unknown targetAssetId back to workingCash, without dropping the row", () => {
    const impl = clampImplementationBasic({
      allocations: [
        { id: "al1", label: "To an asset", amount: 100, targetAssetId: "a1" },
        { id: "al2", label: "To a goal", amount: 200, targetAssetId: "goal:g1" },
        { id: "al3", label: "Stale", amount: 300, targetAssetId: "no-longer-exists" },
        { id: "al4", label: "Already WCA", amount: 400, targetAssetId: "workingCash" },
      ],
    });
    const refined = refineImplementationAllocations(impl, [{ id: "a1" }], [{ id: "g1" }]);
    expect(refined.allocations.map((a) => a.targetAssetId)).toEqual(["a1", "goal:g1", "workingCash", "workingCash"]);
    expect(refined.allocations).toHaveLength(4); // nothing dropped, only redirected
  });

  it("clampAllToPlan performs the second-stage refinement automatically", () => {
    const state = {
      ...defaultState(PROFILES, NOW),
      plan: {
        ...defaultState(PROFILES, NOW).plan,
        implementation: { totalCashAvailable: 0, emergencyFundTarget: 0, allocations: [createAllocation()] },
      },
    };
    state.plan.implementation.allocations[0].targetAssetId = "some-asset-that-does-not-exist";
    const out = clampAllToPlan(state, PROFILES);
    expect(out.plan.implementation.allocations[0].targetAssetId).toBe("workingCash");
  });
});

describe("hydrate migrates a pre-Commit-1 (v9) blob forward (PAYG withholding, tax refund timing, and deductions)", () => {
  it("stamps an empty deductions array and defaults property depreciation to 0", () => {
    const v9 = {
      schemaVersion: 9,
      plan: {
        household: "single", client: { currentAge: 40 }, partner: null,
        endAge: 90, start: { year: 2026, month: 7 },
        workingCash: { balance: 0, minimumBalance: 0, ratePct: null },
      },
      assets: [{ id: "a1", name: "A", include: true, owner: "client", distributions: "reinvest",
                 balance: 1000, allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0,
                 cgtAsset: false, costBase: null }],
      cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [],
                   superContributions: [], superWithdrawals: [] },
      properties: [{ id: "p1", name: "Unit", owner: "client", state: "NSW", propertyType: "investment",
                     status: "owned", currentValue: 500000, acquisitionDate: null, costBase: 400000,
                     priceToday: 0, purchaseAge: 40, lvrPct: 0, rent: { amount: 0 }, expenses: { amount: 0 } }],
      settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: ["a1"] },
      display: { units: "real" },
      assumptions: { cpi: 0.025 },
    };
    const s = hydrate(JSON.stringify(v9), PROFILES);
    expect(s).not.toBeNull();
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.cashflows.deductions).toEqual([]);
    expect(s.properties[0].depreciation).toBe(0);
  });
});

// --- Input integrity (audit follow-up, Part C) ------------------------------
//
// Impossible states must be unenterable, not warned about (CLAUDE.md).
// Each test below asserts BOTH halves of C4's requirement: the invalid
// state cannot be produced through the normal edit path (clamping on a
// freshly-built row), AND a scenario hydrated with that state already
// stored (legacy save, hand-edited JSON, an older schema) loads without
// throwing and comes out corrected rather than preserved.
describe("Input integrity — unenterable states (audit Part C)", () => {
  it("retirementAge clamps into [currentAge, endAge], not just the static [18,120] bound", () => {
    const plan = clampPlan({
      household: "single", client: { currentAge: 50, retirementAge: 30 }, partner: null,
      endAge: 70, start: { year: 2026, month: 7 },
    });
    expect(plan.client.retirementAge).toBe(50); // below current age → clamped up to it
    const plan2 = clampPlan({
      household: "single", client: { currentAge: 50, retirementAge: 200 }, partner: null,
      endAge: 70, start: { year: 2026, month: 7 },
    });
    expect(plan2.client.retirementAge).toBe(70); // above projection end → clamped down to it
  });

  it("clampLiability bounds the IO period to the loan's own term — never longer, even via legacy/hand-edited state", () => {
    const s = defaultState(PROFILES, NOW);
    const clamped = clampLiability(
      { id: "lb1", name: "Loan", type: "mortgage", owner: "client", balance: 100000,
        interestRatePct: 6, termYears: 5, repayment: "io", ioYears: 30, deductible: false,
        linkedAssetId: null, offsetAssetId: null },
      s.plan, s.assets
    );
    expect(clamped.termYears).toBe(5);
    expect(clamped.ioYears).toBe(5); // was 30, capped to the term
  });

  it("Input behaviour fix: a new liability defaults to tracking a linked property's commencement/deductibility; a legacy row (flags absent) reads as already-overridden", () => {
    const s = defaultState(PROFILES, NOW);
    const fresh = createLiability(s.plan, []);
    expect(fresh.commencementIsDefault).toBe(true);
    expect(fresh.deductiblePctIsDefault).toBe(true);

    // Legacy/hand-edited state predating this fix has neither flag —
    // must read as false (already user-entered), never silently start
    // overwriting a value someone already relied on.
    const legacy = clampLiability(
      { id: "lb1", name: "Loan", type: "mortgage", owner: "client", balance: 100000,
        interestRatePct: 6, termYears: 25, repayment: "io", ioYears: 5, deductiblePct: 40,
        linkedAssetId: null, offsetAssetId: null },
      s.plan, s.assets
    );
    expect(legacy.commencementIsDefault).toBe(false);
    expect(legacy.deductiblePctIsDefault).toBe(false);
  });

  it("Input behaviour fix: 'Relates to / secured by' accepts a PROPERTY id, not just an asset id", () => {
    const s = defaultState(PROFILES, NOW);
    const property = createProperty(s.plan, [], 5);
    const linkedToProperty = clampLiability(
      { id: "lb1", name: "Investment loan", type: "mortgage", owner: "client", balance: 100000,
        interestRatePct: 6, termYears: 25, repayment: "io", ioYears: 5, deductiblePct: 100,
        linkedAssetId: property.id, offsetAssetId: null },
      s.plan, s.assets, [property]
    );
    expect(linkedToProperty.linkedAssetId).toBe(property.id); // preserved, not dropped

    // Without the property in scope (e.g. properties argument omitted,
    // the exact bug this fix closed at two call sites), the same link
    // is silently wiped rather than crashing — confirms the guard is
    // real, not a coincidence of some other field matching.
    const droppedWithoutProperties = clampLiability(
      { id: "lb1", name: "Investment loan", type: "mortgage", owner: "client", balance: 100000,
        interestRatePct: 6, termYears: 25, repayment: "io", ioYears: 5, deductiblePct: 100,
        linkedAssetId: property.id, offsetAssetId: null },
      s.plan, s.assets
    );
    expect(droppedWithoutProperties.linkedAssetId).toBeNull();
  });

  it("clampLiability never allows a zero term even from legacy state (a zero-length loan with a real balance is meaningless)", () => {
    const s = defaultState(PROFILES, NOW);
    const clamped = clampLiability(
      { id: "lb1", name: "Loan", type: "personal", owner: "client", balance: 50000,
        interestRatePct: 6, termYears: 0, repayment: "pi", ioYears: 0, deductible: false,
        linkedAssetId: null, offsetAssetId: null },
      s.plan, s.assets
    );
    expect(clamped.termYears).toBeGreaterThanOrEqual(1);
  });

  it("clampSuperContribution drops an accountId belonging to the other person — never credits the wrong owner's account", () => {
    const plan = clampPlan({
      household: "married", client: { currentAge: 45 }, partner: { currentAge: 43 },
      endAge: 90, start: { year: 2026, month: 7 },
      superAccounts: [
        { id: "su-client", name: "Client fund", owner: "client", balance: 100000, taxFreeComponent: 0,
          allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0, include: true },
        { id: "su-partner", name: "Partner fund", owner: "partner", balance: 50000, taxFreeComponent: 0,
          allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0, include: true },
      ],
    }, PROFILES);
    const ownerById = new Map(plan.superAccounts.map((s) => [s.id, s.owner]));
    // A client-owned contribution naming the PARTNER's account — the
    // kind of mismatch that survives untouched through JSON import or
    // an older schema, unlike the live UI's owner-change handler which
    // already clears this on the spot.
    const clamped = clampSuperContribution(
      { owner: "client", accountId: "su-partner", type: "salarySacrifice", basis: "amount", amount: 1000 },
      plan, ownerById, new Set()
    );
    expect(clamped.accountId).toBeNull(); // dropped, not silently credited to the wrong person
    // The matching same-owner account is accepted normally.
    const valid = clampSuperContribution(
      { owner: "client", accountId: "su-client", type: "salarySacrifice", basis: "amount", amount: 1000 },
      plan, ownerById, new Set()
    );
    expect(valid.accountId).toBe("su-client");
  });

  it("clampSuperWithdrawal drops an accountId belonging to the other person", () => {
    const plan = clampPlan({
      household: "married", client: { currentAge: 65 }, partner: { currentAge: 63 },
      endAge: 90, start: { year: 2026, month: 7 },
      superAccounts: [
        { id: "su-client", name: "Client fund", owner: "client", balance: 200000, taxFreeComponent: 0,
          allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0, include: true },
        { id: "su-partner", name: "Partner fund", owner: "partner", balance: 150000, taxFreeComponent: 0,
          allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0, include: true },
      ],
    }, PROFILES);
    const ownerById = new Map(plan.superAccounts.map((s) => [s.id, s.owner]));
    const clamped = clampSuperWithdrawal(
      { owner: "partner", accountId: "su-client", amount: 5000, frequency: "monthly" },
      plan, ownerById
    );
    expect(clamped.accountId).toBeNull();
  });

  it("a scenario hydrated with every C2 impossible state already stored loads without throwing and comes out corrected", () => {
    const bad = {
      schemaVersion: SCHEMA_VERSION,
      plan: {
        household: "married",
        client: { currentAge: 50, retirementAge: 200, dob: synthDob(50, { year: 2026, month: 7 }) },
        partner: { currentAge: 48, retirementAge: 10, dob: synthDob(48, { year: 2026, month: 7 }) },
        endAge: 70,
        endBasis: { mode: "fixedAge", offset: 0, fixedAge: 70, fixedYears: 40 },
        start: { year: 2026, month: 7 },
        keyDates: [],
        superAccounts: [
          { id: "su-c", name: "Client fund", owner: "client", balance: 100000, taxFreeComponent: 0,
            allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0, include: true },
          { id: "su-p", name: "Partner fund", owner: "partner", balance: 80000, taxFreeComponent: 0,
            allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0, include: true },
        ],
      },
      assets: [{ id: "a1", name: "A1", include: true, owner: "client", distributions: "reinvest",
                 balance: 100000, allocation: { mode: "profile", profile: "Balanced" }, icrPct: 0,
                 cgtAsset: false, costBase: null }],
      cashflows: {
        income: [], expenses: [], deductions: [], contributions: [], withdrawals: [], lumpSums: [],
        superContributions: [
          { id: "sc1", label: "Sacrifice", owner: "client", accountId: "su-p", type: "salarySacrifice",
            basis: "amount", amount: 5000, percent: 0, incomeRowId: null, frequency: "annual",
            from: { kind: "age", age: 50 }, to: { kind: "age", age: 65 }, indexBasis: "none", indexExtraPct: 0 },
        ],
        superWithdrawals: [],
      },
      liabilities: [
        { id: "lb1", name: "Loan", type: "mortgage", owner: "client", balance: 300000,
          interestRatePct: 6, termYears: 5, repayment: "io", ioYears: 25, deductible: false,
          linkedAssetId: null, offsetAssetId: null },
      ],
      properties: [],
      settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: ["a1"] },
      display: { units: "real" },
      assumptions: { cpi: 0.025, awote: 0.035, mortgageRate: 0.06, bracketMode: "indexed" },
    };
    const s = hydrate(JSON.stringify(bad), PROFILES);
    expect(s).not.toBeNull(); // never throws
    expect(s.plan.client.retirementAge).toBe(70); // clamped down to endAge
    expect(s.plan.partner.retirementAge).toBe(48); // clamped up to partner's currentAge
    expect(s.cashflows.superContributions[0].accountId).toBeNull(); // wrong-owner account dropped
    expect(s.liabilities[0].ioYears).toBe(5); // capped to the loan's own term
    // Every clamped field is independently correctable from here — none
    // of this required discarding the row/person/account, only the
    // specific bad value.
    expect(s.cashflows.superContributions[0].amount).toBe(5000); // rest of the row survives untouched
  });

  it("clampGoal drops a stale/removed fundedFrom asset — falls back to surplus, never funds from nothing", () => {
    const s = defaultState(PROFILES, NOW);
    const clamped = clampGoal(
      { id: "gl1", label: "Car", targetAmount: 20000, targetAt: { kind: "age", age: s.plan.endAge },
        fundedFrom: "no-such-asset", indexBasis: "cpi", indexExtraPct: 0 },
      s.plan, s.assets
    );
    expect(clamped.fundedFrom).toBe("surplus");
  });

  it("clampSnapshotYears caps at MAX_SNAPSHOT_YEARS and clamps each DateRef into the plan window", () => {
    const s = defaultState(PROFILES, NOW);
    const many = Array.from({ length: 10 }, (_, i) => ({ kind: "age", age: s.plan.client.currentAge + i }));
    const clamped = clampSnapshotYears(many, s.plan);
    expect(clamped.length).toBe(MAX_SNAPSHOT_YEARS);
    const outOfRange = clampSnapshotYears([{ kind: "age", age: s.plan.endAge + 50 }], s.plan);
    expect(outOfRange[0].age).toBeLessThanOrEqual(s.plan.endAge);
  });

  it("clampSnapshotYears defaults to empty for anything that isn't an array", () => {
    const s = defaultState(PROFILES, NOW);
    expect(clampSnapshotYears(undefined, s.plan)).toEqual([]);
    expect(clampSnapshotYears(null, s.plan)).toEqual([]);
  });

  it("clampGoal keeps a valid fundedFrom asset reference", () => {
    const s = defaultState(PROFILES, NOW);
    const assetId = s.assets[0].id;
    const clamped = clampGoal(
      { id: "gl1", label: "Car", targetAmount: 20000, targetAt: { kind: "age", age: s.plan.endAge },
        fundedFrom: assetId, indexBasis: "cpi", indexExtraPct: 0 },
      s.plan, s.assets
    );
    expect(clamped.fundedFrom).toBe(assetId);
  });
});

// Adjustment rows (spec 18, Commit 1).
describe("Adjustment rows", () => {
  const plan = clampPlan(couplePlan());
  const superAccounts = [
    { id: "su1", owner: "client", include: true },
    { id: "su2", owner: "partner", include: true },
  ];

  it("createAdjustment defaults to a household expense adjustment covering the whole projection", () => {
    const a = createAdjustment();
    expect(a.target).toBe("expenses");
    expect(a.owner).toBe("household");
    expect(a.amount).toBe(0);
    expect(a.note).toBe("");
  });

  it("label defaults to the target's own label until the user actually types one", () => {
    const defaulted = clampAdjustment({ target: "tax.help", amount: 100, note: "x" }, plan);
    expect(defaulted.label).toBe(ADJUSTMENT_TARGET_LABELS["tax.help"]);
    const custom = clampAdjustment({ target: "tax.help", amount: 100, label: "My own label", note: "x" }, plan);
    expect(custom.label).toBe("My own label");
    // A blank/whitespace label is treated as "not set" — the default
    // keeps applying rather than showing empty forever.
    const blank = clampAdjustment({ target: "tax.help", amount: 100, label: "   ", note: "x" }, plan);
    expect(blank.label).toBe(ADJUSTMENT_TARGET_LABELS["tax.help"]);
  });

  it("an invalid target is dropped entirely, not coerced to a fallback", () => {
    expect(clampAdjustment({ target: "not.a.real.target", amount: 500 }, plan)).toBeNull();
    expect(clampAdjustment({ amount: 500 }, plan)).toBeNull();
  });

  it("expenses is always owner household, regardless of what was stored", () => {
    const a = clampAdjustment({ target: "expenses", owner: "client", amount: 100, note: "test" }, plan);
    expect(a.owner).toBe("household");
  });

  it("a person-scoped target defaults to client and accepts partner when one exists", () => {
    const client = clampAdjustment({ target: "tax.incomeTax", amount: 500, note: "x" }, plan);
    expect(client.owner).toBe("client");
    const partner = clampAdjustment({ target: "tax.incomeTax", owner: "partner", amount: 500, note: "x" }, plan);
    expect(partner.owner).toBe("partner");
  });

  it("a partner-owned adjustment falls back to client when the household has no partner", () => {
    const single = clampPlan({ ...couplePlan(), household: "single", partner: null });
    const a = clampAdjustment({ target: "income.assessable", owner: "partner", amount: 1000, note: "x" }, single);
    expect(a.owner).toBe("client");
  });

  it("superContributions requires a real account and adopts that account's owner — dropped if the account doesn't exist", () => {
    const valid = clampAdjustment(
      { target: "superContributions", superAccountId: "su2", amount: 2000, note: "top-up" }, plan, { superAccounts }
    );
    expect(valid.owner).toBe("partner");
    expect(valid.superAccountId).toBe("su2");
    expect(clampAdjustment({ target: "superContributions", superAccountId: "nope", amount: 2000, note: "x" }, plan, { superAccounts }))
      .toBeNull();
    expect(clampAdjustment({ target: "superContributions", amount: 2000, note: "x" }, plan)).toBeNull();
  });

  it("a person-scoped adjustment's window anchors to that owner's own age, via ownerWindow", () => {
    const win = ownerWindow(plan, "partner");
    const a = clampAdjustment(
      { target: "deductions", owner: "partner", amount: 1000, from: { kind: "age", age: win.from - 50 }, to: { kind: "age", age: win.to + 50 }, note: "x" },
      plan
    );
    expect(a.from.age).toBe(win.from);
    expect(a.to.age).toBe(win.to);
  });

  it("indexation clamps the same way every other cashflow row does — defaults to cpi, extra% bounded to [-10,10]", () => {
    const a = clampAdjustment({ target: "expenses", amount: 100, indexBasis: "bogus", indexExtraPct: 999, note: "x" }, plan);
    expect(a.indexBasis).toBe("cpi");
    expect(a.indexExtraPct).toBe(10);
  });

  it("normaliseAdjustments drops invalid entries and keeps valid ones, tolerating a non-array input", () => {
    expect(normaliseAdjustments(undefined, plan)).toEqual([]);
    expect(normaliseAdjustments(null, plan)).toEqual([]);
    const result = normaliseAdjustments([
      { target: "expenses", amount: 100, note: "keep" },
      { target: "bogus", amount: 100, note: "drop" },
      { target: "superContributions", superAccountId: "nope", amount: 100, note: "drop" },
    ], plan, { superAccounts });
    expect(result).toHaveLength(1);
    expect(result[0].note).toBe("keep");
  });

  it("ADJUSTMENT_TARGETS covers exactly the registry the spec names", () => {
    expect(ADJUSTMENT_TARGETS).toEqual([
      "income.assessable", "income.nonTaxable", "deductions",
      "tax.incomeTax", "tax.withheld", "tax.medicare", "tax.help", "tax.cgt",
      "expenses", "superContributions",
    ]);
  });
});

// Age pension (spec 21a, Commit 3) — centrelinkEligible's smart default
// (true for anyone reaching age pension age, 67, within the projection)
// can only resolve once endAge is known, so it's clampPlan's own job,
// not clampTaxProfile's (see applyCentrelinkEligibleDefault's header).
describe("clampPlan — centrelinkEligible smart default (spec 21a, Commit 3)", () => {
  const start = { year: 2026, month: 8 };

  it("defaults eligible when the person reaches 67 within the projection", () => {
    const p = clampPlan({
      client: { dob: "1986-07-01", sex: "male" }, // age 40
      endBasis: { mode: "fixedAge", fixedAge: 90 },
      start,
    });
    expect(p.client.taxProfile.centrelinkEligible).toBe(true);
    expect(p.client.taxProfile.centrelinkEligibleIsDefault).toBe(true);
  });

  it("defaults ineligible when the projection ends before age pension age", () => {
    const p = clampPlan({
      client: { dob: "1986-07-01", sex: "male" }, // age 40
      endBasis: { mode: "fixedAge", fixedAge: 60 }, // never reaches 67
      start,
    });
    expect(p.client.taxProfile.centrelinkEligible).toBe(false);
  });

  it("an explicit override survives and stops tracking, even when endAge would otherwise flip the default", () => {
    const p = clampPlan({
      client: {
        dob: "1986-07-01", sex: "male",
        taxProfile: { centrelinkEligible: false, centrelinkEligibleIsDefault: false },
      },
      endBasis: { mode: "fixedAge", fixedAge: 90 }, // would default to eligible
      start,
    });
    expect(p.client.taxProfile.centrelinkEligible).toBe(false);
    expect(p.client.taxProfile.centrelinkEligibleIsDefault).toBe(false);
  });

  it("recomputes while still tracking as endAge changes (derived-default convention)", () => {
    const shortened = clampPlan({
      client: { dob: "1986-07-01", sex: "male" },
      endBasis: { mode: "fixedAge", fixedAge: 90 },
      start,
    });
    expect(shortened.client.taxProfile.centrelinkEligible).toBe(true);
    const cutShort = clampPlan({ ...shortened, endBasis: { mode: "fixedAge", fixedAge: 50 } });
    expect(cutShort.client.taxProfile.centrelinkEligible).toBe(false);
  });

  it("resolves independently per person for a couple with an age gap — endAge is CLIENT-anchored, so a partner's own age-at-end is NOT the same figure", () => {
    const p = clampPlan({
      household: "married",
      client: { dob: "1961-07-01", sex: "male" }, // age 65 at start
      partner: { dob: "1996-07-01", sex: "female" }, // age 30 at start
      endBasis: { mode: "fixedAge", fixedAge: 70 }, // client's own endAge — client reaches 70, partner only reaches 30+5=35
      start,
    });
    expect(p.endAge).toBe(70);
    expect(p.client.taxProfile.centrelinkEligible).toBe(true); // 65 → 70 within the projection
    expect(p.partner.taxProfile.centrelinkEligible).toBe(false); // 30 → 35 within the same 5-year window
  });
});

describe("Home Equity Access Scheme (spec 21b, Commit 5): plan model", () => {
  it("createHeas defaults to disabled with no security", () => {
    const h = createHeas();
    expect(h.enabled).toBe(false);
    expect(h.propertyId).toBeNull();
  });

  it("clampHeas is a basic type/shape clamp only — no property cross-validation at this stage", () => {
    expect(clampHeas({ enabled: true, propertyId: "p1" })).toEqual({ enabled: true, propertyId: "p1" });
    expect(clampHeas({ enabled: "yes", propertyId: 123 })).toEqual({ enabled: false, propertyId: null });
    expect(clampHeas(undefined)).toEqual({ enabled: false, propertyId: null });
  });

  it("refineHeasProperty drops a propertyId that isn't among the household's own properties — and resets enabled with it", () => {
    const properties = [{ id: "p1" }, { id: "p2" }];
    const valid = refineHeasProperty({ enabled: true, propertyId: "p1" }, properties);
    expect(valid).toEqual({ enabled: true, propertyId: "p1" });
    const stale = refineHeasProperty({ enabled: true, propertyId: "deleted-property" }, properties);
    expect(stale.propertyId).toBeNull();
    expect(stale.enabled).toBe(false); // an enabled HEAS with no valid security is the unenterable case
  });

  it("refineHeasProperty leaves a disabled HEAS with no propertyId untouched", () => {
    const properties = [{ id: "p1" }];
    expect(refineHeasProperty({ enabled: false, propertyId: null }, properties)).toEqual({ enabled: false, propertyId: null });
  });

  it("defaultState round-trips a valid HEAS election through clampAllToPlan without dropping it", () => {
    const plan = couplePlan();
    const property = { ...createProperty(plan, []), propertyType: "ppr", currentValue: 800000 };
    const s = { ...defaultState(PROFILES, NOW), plan: { ...defaultState(PROFILES, NOW).plan, heas: { enabled: true, propertyId: property.id } }, properties: [property] };
    const clamped = clampAllToPlan(s, PROFILES);
    expect(clamped.plan.heas).toEqual({ enabled: true, propertyId: property.id });
  });
});

describe("Death benefits (spec 22, Commit 1): plan model", () => {
  it("isDeathBenefitTaxDependant: spouse/minorChild/interdependent/financialDependant are dependants; adultChild and estate are not", () => {
    expect(isDeathBenefitTaxDependant("spouse")).toBe(true);
    expect(isDeathBenefitTaxDependant("minorChild")).toBe(true);
    expect(isDeathBenefitTaxDependant("interdependent")).toBe(true);
    expect(isDeathBenefitTaxDependant("financialDependant")).toBe(true);
    expect(isDeathBenefitTaxDependant("adultChild")).toBe(false);
    expect(isDeathBenefitTaxDependant("estate")).toBe(false);
  });

  it("createDeathBenefitBeneficiary defaults to a spouse at 100%", () => {
    const b = createDeathBenefitBeneficiary();
    expect(b.relationship).toBe("spouse");
    expect(b.sharePct).toBe(100);
  });

  it("clampDeathBenefitBeneficiary defends a junk relationship and clamps sharePct to [0,100]", () => {
    const b = clampDeathBenefitBeneficiary({ id: "b1", label: "Jo", relationship: "not-a-real-one", sharePct: 150 });
    expect(DEATH_BENEFIT_RELATIONSHIPS).toContain(b.relationship);
    expect(b.relationship).toBe("spouse"); // the defensive default
    expect(b.sharePct).toBe(100);
    expect(clampDeathBenefitBeneficiary({ sharePct: -10 }).sharePct).toBe(0);
  });

  it("clampDeathBenefit defends non-array input and clamps every beneficiary", () => {
    expect(clampDeathBenefit(undefined)).toEqual({ beneficiaries: [] });
    expect(clampDeathBenefit({ beneficiaries: "not-an-array" })).toEqual({ beneficiaries: [] });
    const d = clampDeathBenefit({ beneficiaries: [{ relationship: "adultChild", sharePct: 60 }] });
    expect(d.beneficiaries).toHaveLength(1);
    expect(d.beneficiaries[0].relationship).toBe("adultChild");
    expect(d.beneficiaries[0].sharePct).toBe(60);
  });

  it("clampPerson (via clampPlan) always carries a deathBenefit field, defaulting to no beneficiaries", () => {
    const plan = clampPlan(couplePlan());
    expect(plan.client.deathBenefit).toEqual({ beneficiaries: [] });
    expect(plan.partner.deathBenefit).toEqual({ beneficiaries: [] });
  });

  it("clampPlan round-trips a real nomination", () => {
    const plan = clampPlan({
      ...couplePlan(),
      client: { currentAge: 40, deathBenefit: { beneficiaries: [{ id: "b1", label: "Spouse", relationship: "spouse", sharePct: 70 }, { id: "b2", label: "Adult child", relationship: "adultChild", sharePct: 30 }] } },
    });
    expect(plan.client.deathBenefit.beneficiaries).toHaveLength(2);
    expect(plan.client.deathBenefit.beneficiaries[1].relationship).toBe("adultChild");
  });
});

describe("Employers (spec 23, Commit 1): plan model", () => {
  it("createEmployer defaults to the given owner, numbering per-owner", () => {
    const plan = clampPlan(couplePlan());
    const e1 = createEmployer(plan, [], "client");
    expect(e1.ownerId).toBe("client");
    expect(e1.name).toBe("Employer 1");
    const e2 = createEmployer(plan, [e1], "client");
    expect(e2.name).toBe("Employer 2");
    const e3 = createEmployer(plan, [e1, e2], "partner");
    expect(e3.name).toBe("Employer 1"); // partner's own first employer
  });

  it("clampEmployer defends a junk ownerId and a missing partner", () => {
    const couple = clampPlan(couplePlan());
    expect(clampEmployer({ ownerId: "partner" }, couple).ownerId).toBe("partner");
    const single = clampPlan({ ...couplePlan(), household: "single", partner: null });
    expect(clampEmployer({ ownerId: "partner" }, single).ownerId).toBe("client");
    expect(clampEmployer({ id: "e1", name: "  " }, couple).name).toBe("Employer");
  });

  it("normaliseEmployers defends non-array input", () => {
    expect(normaliseEmployers(null, clampPlan(couplePlan()))).toEqual([]);
  });

  it("resolveEmployerAssignment auto-provisions a default employer per owner with employment income, leaving single-employer scenarios' income rows otherwise untouched", () => {
    const plan = clampPlan(couplePlan());
    const income = [
      { id: "i1", owner: "client", incomeType: "employment", employerId: null },
      { id: "i2", owner: "client", incomeType: "otherTaxable", employerId: null },
    ];
    const { employers, income: resolved } = resolveEmployerAssignment([], income, plan);
    expect(employers).toHaveLength(1);
    expect(employers[0].ownerId).toBe("client");
    expect(resolved[0].employerId).toBe(employers[0].id);
    expect(resolved[1].employerId).toBeNull(); // non-employment row never carries one
  });

  it("resolveEmployerAssignment resets a stale/cross-owner employerId to that row's OWN owner's first employer", () => {
    const plan = clampPlan(couplePlan());
    const employers = [
      { id: "empClient", name: "Client's employer", ownerId: "client" },
      { id: "empPartner", name: "Partner's employer", ownerId: "partner" },
    ];
    const income = [
      { id: "i1", owner: "client", incomeType: "employment", employerId: "empPartner" }, // wrong owner
      { id: "i2", owner: "client", incomeType: "employment", employerId: "nonexistent" }, // stale
    ];
    const { income: resolved } = resolveEmployerAssignment(employers, income, plan);
    expect(resolved[0].employerId).toBe("empClient");
    expect(resolved[1].employerId).toBe("empClient");
  });

  it("resolveEmployerAssignment leaves a valid employerId untouched", () => {
    const plan = clampPlan(couplePlan());
    const employers = [{ id: "emp1", name: "Employer", ownerId: "client" }];
    const income = [{ id: "i1", owner: "client", incomeType: "employment", employerId: "emp1" }];
    const { income: resolved } = resolveEmployerAssignment(employers, income, plan);
    expect(resolved[0].employerId).toBe("emp1");
  });
});

describe("Bonus, allowance and overtime income (spec 23, Commit 2): plan model", () => {
  it("INCOME_CATEGORIES gains the three new categories; createIncomeRow defaults taxable/bonusMonth/bonusDestination", () => {
    expect(INCOME_CATEGORIES).toEqual(expect.arrayContaining(["bonus", "allowance", "overtime"]));
    const plan = clampPlan(couplePlan(), PROFILES);
    const row = createIncomeRow(plan, []);
    expect(row.taxable).toBe(true);
    expect(row.bonusMonth).toBe(6); // June — last month of the FY
    expect(row.bonusDestination).toEqual({ type: null, targetId: null });
  });

  it("incomeCategoryTaxTreatment: allowance follows the taxable flag; every other category is fixed", () => {
    expect(incomeCategoryTaxTreatment("allowance", true)).toBe("employment");
    expect(incomeCategoryTaxTreatment("allowance", false)).toBe("nonTaxable");
    expect(incomeCategoryTaxTreatment("bonus")).toBe("employment");
    expect(incomeCategoryTaxTreatment("overtime")).toBe("employment");
  });

  it("clampIncomeRow: a bonus row is forced to annual frequency and its bonusMonth clamps into [1, 12]", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const row = { ...createIncomeRow(plan, []), category: "bonus", frequency: "monthly", bonusMonth: 15 };
    const clamped = clampIncomeRow(row, plan);
    expect(clamped.frequency).toBe("annual");
    expect(clamped.bonusMonth).toBe(12);
  });

  it("clampIncomeRow: overtime forces sgApplies false even when the stored row says true — the belt-and-braces gate", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const row = { ...createIncomeRow(plan, []), category: "overtime", sgApplies: true };
    const clamped = clampIncomeRow(row, plan);
    expect(clamped.incomeType).toBe("employment"); // still assessable
    expect(clamped.sgApplies).toBe(false); // just never contributes SG
  });

  it("clampIncomeRow: allowance's incomeType tracks its own taxable flag, not a fixed per-category answer", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const taxable = clampIncomeRow({ ...createIncomeRow(plan, []), category: "allowance", taxable: true }, plan);
    const nonTaxable = clampIncomeRow({ ...createIncomeRow(plan, []), category: "allowance", taxable: false }, plan);
    expect(taxable.incomeType).toBe("employment");
    expect(nonTaxable.incomeType).toBe("nonTaxable");
  });

  it("BONUS_DESTINATION_TYPES lists the three real destinations", () => {
    expect(BONUS_DESTINATION_TYPES).toEqual(["loanRepayment", "superContribution", "asset"]);
  });

  it("clampBonusDestination keeps a valid destination of each type and drops an invalid one — never a fallback target", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const ctx = {
      liabilities: [{ id: "lb1" }],
      assets: [{ id: "a1", include: true, class: "financial" }],
    };
    plan.superAccounts = [{ id: "su1", owner: "client", include: true }];
    const row = { owner: "client" };

    expect(clampBonusDestination({ type: "loanRepayment", targetId: "lb1" }, row, plan, ctx))
      .toEqual({ type: "loanRepayment", targetId: "lb1" });
    expect(clampBonusDestination({ type: "superContribution", targetId: "su1" }, row, plan, ctx))
      .toEqual({ type: "superContribution", targetId: "su1" });
    expect(clampBonusDestination({ type: "asset", targetId: "a1" }, row, plan, ctx))
      .toEqual({ type: "asset", targetId: "a1" });
    // Unknown type, dangling target, and null all drop to "no destination".
    expect(clampBonusDestination({ type: "bogus", targetId: "lb1" }, row, plan, ctx))
      .toEqual({ type: null, targetId: null });
    expect(clampBonusDestination({ type: "loanRepayment", targetId: "nonexistent" }, row, plan, ctx))
      .toEqual({ type: null, targetId: null });
    expect(clampBonusDestination(null, row, plan, ctx)).toEqual({ type: null, targetId: null });
  });

  it("clampBonusDestination scopes a super account destination to the ROW'S OWN owner — a spouse's account never qualifies", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    plan.superAccounts = [{ id: "su_partner", owner: "partner", include: true }];
    const clientRow = { owner: "client" };
    expect(clampBonusDestination({ type: "superContribution", targetId: "su_partner" }, clientRow, plan, {}))
      .toEqual({ type: null, targetId: null });
  });

  it("clampAllToPlan second stage: a bonus row's destination resolves against real liabilities, dropping a dangling target", () => {
    const s = defaultState(PROFILES, NOW);
    const liability = createLiability(s.plan, []);
    s.liabilities = [liability];
    const validRow = { ...createIncomeRow(s.plan, []), category: "bonus", bonusDestination: { type: "loanRepayment", targetId: liability.id } };
    const danglingRow = { ...createIncomeRow(s.plan, []), category: "bonus", bonusDestination: { type: "loanRepayment", targetId: "nonexistent" } };
    s.cashflows.income = [validRow, danglingRow];
    const out = clampAllToPlan(s, PROFILES);
    expect(out.cashflows.income[0].bonusDestination).toEqual({ type: "loanRepayment", targetId: liability.id });
    expect(out.cashflows.income[1].bonusDestination).toEqual({ type: null, targetId: null });
  });

  it("hydrate round-trips a bonus row's destination the same way clampAllToPlan does", () => {
    const s = defaultState(PROFILES, NOW);
    const liability = createLiability(s.plan, []);
    s.liabilities = [liability];
    s.cashflows.income = [{
      ...createIncomeRow(s.plan, []), category: "bonus", bonusMonth: 3,
      bonusDestination: { type: "loanRepayment", targetId: liability.id },
    }];
    const back = hydrate(serialize(s), PROFILES);
    expect(back.cashflows.income[0].category).toBe("bonus");
    expect(back.cashflows.income[0].bonusMonth).toBe(3);
    expect(back.cashflows.income[0].bonusDestination).toEqual({ type: "loanRepayment", targetId: liability.id });
  });
});

describe("Salary packaging by employer type (spec 23, Commit 3): plan model", () => {
  it("createEmployer defaults to standard fbtType with zeroed caps", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const e = createEmployer(plan, []);
    expect(e.fbtType).toBe("standard");
    expect(e.fbtCaps).toEqual({ livingExpenseCap: 0, mealEntertainmentCap: 0, rebatePct: 0 });
  });

  it("clampEmployer clamps an unknown fbtType to standard and keeps a valid one", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    expect(clampEmployer({ fbtType: "bogus" }, plan).fbtType).toBe("standard");
    expect(clampEmployer({ fbtType: "fbtExempt" }, plan).fbtType).toBe("fbtExempt");
    expect(FBT_TYPES).toEqual(["standard", "fbtExempt", "fbtRebatable"]);
  });

  it("clampEmployer only carries a rebatePct for fbtRebatable — forced to 0 for every other type", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const exempt = clampEmployer({ fbtType: "fbtExempt", fbtCaps: { rebatePct: 40 } }, plan);
    expect(exempt.fbtCaps.rebatePct).toBe(0);
    const rebatable = clampEmployer({ fbtType: "fbtRebatable", fbtCaps: { rebatePct: 40 } }, plan);
    expect(rebatable.fbtCaps.rebatePct).toBe(40);
  });

  it("clampEmployer clamps rebatePct into [0, 100] and caps to non-negative", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const e = clampEmployer({ fbtType: "fbtRebatable", fbtCaps: { livingExpenseCap: -500, mealEntertainmentCap: -1, rebatePct: 150 } }, plan);
    expect(e.fbtCaps.livingExpenseCap).toBe(0);
    expect(e.fbtCaps.mealEntertainmentCap).toBe(0);
    expect(e.fbtCaps.rebatePct).toBe(100);
  });

  it("createDeductionRow defaults packagingType to livingExpense with no employer linked", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const row = createDeductionRow(plan, []);
    expect(row.employerId).toBeNull();
    expect(row.packagingType).toBe("livingExpense");
    expect(PACKAGING_TYPES).toEqual(["livingExpense", "mealEntertainment", "car", "exemptItem"]);
  });

  it("clampDeductionRow clamps an unknown packagingType to livingExpense and passes through a valid employerId", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const row = { ...createDeductionRow(plan, []), category: "salaryPackaging", packagingType: "bogus", employerId: "emp1" };
    const clamped = clampDeductionRow(row, plan);
    expect(clamped.packagingType).toBe("livingExpense");
    expect(clamped.employerId).toBe("emp1");
    const carRow = clampDeductionRow({ ...row, packagingType: "car" }, plan);
    expect(carRow.packagingType).toBe("car");
  });

  it("hydrate round-trips an employer's fbtType/fbtCaps and a deduction row's employerId/packagingType", () => {
    const s = defaultState(PROFILES, NOW);
    s.plan.employers = [{ id: "emp1", name: "Charity Co", ownerId: "client", fbtType: "fbtExempt", fbtCaps: { livingExpenseCap: 9010, mealEntertainmentCap: 2650, rebatePct: 0 } }];
    s.cashflows.deductions = [{
      ...createDeductionRow(s.plan, []), category: "salaryPackaging", employerId: "emp1", packagingType: "mealEntertainment", amount: 2000,
    }];
    const back = hydrate(serialize(s), PROFILES);
    expect(back.plan.employers[0]).toEqual({
      id: "emp1", name: "Charity Co", ownerId: "client", fbtType: "fbtExempt",
      fbtCaps: { livingExpenseCap: 9010, mealEntertainmentCap: 2650, rebatePct: 0 },
    });
    expect(back.cashflows.deductions[0].employerId).toBe("emp1");
    expect(back.cashflows.deductions[0].packagingType).toBe("mealEntertainment");
  });
});

describe("Novated leases (spec 23, Commit 4): plan model", () => {
  it("createNovatedLease defaults to a zero-cost, 3-year, payout-at-end lease with no employer linkage", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const nl = createNovatedLease(plan, []);
    expect(nl.owner).toBe("client");
    expect(nl.baseValue).toBe(0);
    expect(nl.termYears).toBe(3);
    expect(nl.runningCostsPackaged).toBe(true);
    expect(nl.residualDestination).toBe("payout");
    expect(RESIDUAL_DESTINATIONS).toEqual(["payout", "refinance"]);
  });

  it("clampNovatedLease clamps negative dollar figures to 0 and an unknown residualDestination to payout", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const nl = clampNovatedLease({
      baseValue: -100, preTaxAnnual: -1, postTaxAnnual: -1, runningCostsAnnual: -1,
      residualValue: -1, residualDestination: "bogus", termYears: 0,
    }, plan);
    expect(nl.baseValue).toBe(0);
    expect(nl.preTaxAnnual).toBe(0);
    expect(nl.postTaxAnnual).toBe(0);
    expect(nl.runningCostsAnnual).toBe(0);
    expect(nl.residualValue).toBe(0);
    expect(nl.residualDestination).toBe("payout");
    expect(nl.termYears).toBe(1); // clamped into [1, 10]
  });

  it("clampNovatedLease demotes an orphan partner's lease to client, same as every other owner-scoped row", () => {
    const single = clampPlan({ household: "single", client: { currentAge: 40 } }, PROFILES);
    const nl = clampNovatedLease({ owner: "partner" }, single);
    expect(nl.owner).toBe("client");
  });

  it("normaliseNovatedLeases tolerates a non-array and clamps every entry", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    expect(normaliseNovatedLeases(undefined, plan)).toEqual([]);
    const out = normaliseNovatedLeases([{ baseValue: 40000 }], plan);
    expect(out).toHaveLength(1);
    expect(out[0].baseValue).toBe(40000);
  });

  it("hydrate round-trips a novated lease through plan.novatedLeases", () => {
    const s = defaultState(PROFILES, NOW);
    s.plan.novatedLeases = [{
      id: "nl1", name: "Company car", owner: "client", baseValue: 45000,
      startAt: { kind: "anchor", anchorId: "start" }, termYears: 4,
      preTaxAnnual: 6000, postTaxAnnual: 2000, runningCostsAnnual: 1500, runningCostsPackaged: false,
      residualValue: 12000, residualDestination: "payout",
    }];
    const back = hydrate(serialize(s), PROFILES);
    expect(back.plan.novatedLeases).toHaveLength(1);
    const nl = back.plan.novatedLeases[0];
    expect(nl.baseValue).toBe(45000);
    expect(nl.termYears).toBe(4);
    expect(nl.preTaxAnnual).toBe(6000);
    expect(nl.postTaxAnnual).toBe(2000);
    expect(nl.runningCostsPackaged).toBe(false);
    expect(nl.residualValue).toBe(12000);
  });
});

describe("Loan drawdowns and dynamic deductibility (spec 24, Commit 1): plan model", () => {
  it("createLiability defaults to no credit limit, no drawdowns, proportional repayment allocation", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const l = createLiability(plan, []);
    expect(l.creditLimit).toBeNull();
    expect(l.drawdowns).toEqual([]);
    expect(l.repaymentAllocation).toBe("proportional");
  });

  it("clampLiability: creditLimit null stays null (no facility modelled); a negative figure clamps to 0", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const assets = [];
    expect(clampLiability({ creditLimit: null }, plan, assets).creditLimit).toBeNull();
    expect(clampLiability({}, plan, assets).creditLimit).toBeNull(); // absent reads as null, not 0
    expect(clampLiability({ creditLimit: -500 }, plan, assets).creditLimit).toBe(0);
    expect(clampLiability({ creditLimit: 300000 }, plan, assets).creditLimit).toBe(300000);
  });

  it("clampLiability: an unknown repaymentAllocation clamps to proportional; privateFirst passes through", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    expect(clampLiability({ repaymentAllocation: "bogus" }, plan, []).repaymentAllocation).toBe("proportional");
    expect(clampLiability({ repaymentAllocation: "privateFirst" }, plan, []).repaymentAllocation).toBe("privateFirst");
    expect(REPAYMENT_ALLOCATIONS).toEqual(["proportional", "privateFirst"]);
  });

  it("createDrawdown defaults to investment purpose, destination cash", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const d = createDrawdown(plan, []);
    expect(d.purpose).toBe("investment");
    expect(d.destination).toBe("cash");
    expect(DRAWDOWN_PURPOSES).toEqual(["investment", "private"]);
  });

  it("clampDrawdown: an unknown purpose clamps to investment; a dangling destination falls back to cash", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const destinationIds = new Set(["a1"]);
    const d = clampDrawdown({ purpose: "bogus", destination: "nonexistent" }, plan, destinationIds);
    expect(d.purpose).toBe("investment");
    expect(d.destination).toBe("cash");
    const valid = clampDrawdown({ purpose: "private", destination: "a1" }, plan, destinationIds);
    expect(valid.purpose).toBe("private");
    expect(valid.destination).toBe("a1");
    // "cash" is always a valid destination, independent of destinationIds.
    const cash = clampDrawdown({ destination: "cash" }, plan, new Set());
    expect(cash.destination).toBe("cash");
  });

  it("clampLiability clamps every drawdown in the array, validating destination against assets AND properties", () => {
    const plan = clampPlan(couplePlan(), PROFILES);
    const assets = [{ id: "a1", class: "financial", include: true }];
    const properties = [{ id: "p1" }];
    const l = clampLiability({
      drawdowns: [
        { id: "dd1", amount: 10000, at: { kind: "age", age: 45 }, purpose: "investment", destination: "a1" },
        { id: "dd2", amount: 5000, at: { kind: "age", age: 46 }, purpose: "private", destination: "p1" },
        { id: "dd3", amount: 2000, at: { kind: "age", age: 47 }, purpose: "investment", destination: "nonexistent" },
      ],
    }, plan, assets, properties);
    expect(l.drawdowns).toHaveLength(3);
    expect(l.drawdowns[0].destination).toBe("a1");
    expect(l.drawdowns[1].destination).toBe("p1");
    expect(l.drawdowns[2].destination).toBe("cash"); // dangling — falls back, never dropped
  });

  it("hydrate round-trips a liability's creditLimit, drawdowns and repaymentAllocation", () => {
    const s = defaultState(PROFILES, NOW);
    const liability = createLiability(s.plan, []);
    s.liabilities = [{
      ...liability, balance: 200000, creditLimit: 250000, repaymentAllocation: "privateFirst",
      drawdowns: [{ id: "dd1", label: "Investment drawdown", amount: 40000, at: { kind: "age", age: 45 }, purpose: "investment", destination: "cash" }],
    }];
    const back = hydrate(serialize(s), PROFILES);
    const l = back.liabilities[0];
    expect(l.creditLimit).toBe(250000);
    expect(l.repaymentAllocation).toBe("privateFirst");
    expect(l.drawdowns).toHaveLength(1);
    expect(l.drawdowns[0].amount).toBe(40000);
    expect(l.drawdowns[0].purpose).toBe("investment");
  });
});
