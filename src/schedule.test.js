import { describe, it, expect } from "vitest";
import {
  buildSchedules, monthsInFirstYear, firstFyStartYear, planYearCount,
  totalMonths, planYearOfMonth, calendarMonthOf, fyLabel, nominalFactor,
} from "./schedule.js";

// Minimal v3-shaped state factory.
function mkState({
  start = { year: 2026, month: 7 },
  clientAge = 40,
  partnerAge = null,
  endAge = 44,
  assets = [{ id: "a1", include: true }],
  income = [], expenses = [], contributions = [], withdrawals = [], lumpSums = [],
  bonds = [], bondContributions = [],
  cpi = 0.025,
  fundingOrder = null,
} = {}) {
  return {
    plan: {
      household: partnerAge != null ? "couple" : "single",
      client: { currentAge: clientAge },
      partner: partnerAge != null ? { currentAge: partnerAge } : null,
      endAge,
      start,
    },
    assets,
    bonds,
    cashflows: { income, expenses, contributions, withdrawals, lumpSums, bondContributions },
    settings: {
      surplus: { mode: "spend", assetId: null },
      fundingOrder: fundingOrder ?? assets.filter((a) => a.include).map((a) => a.id),
    },
    assumptions: { cpi },
    display: { units: "real" },
  };
}

// fromAge/toAge are a convenience shim over the real DateRef fields
// (from/to) — Key Dates (Tier 1.1) — so existing call sites below stay
// unchanged while schedule.js is exercised against its real shape.
const cf = (over = {}) => {
  const { fromAge, toAge, from, to, ...rest } = over;
  return {
    id: "row", assetId: "a1", amount: 100, frequency: "monthly",
    from: from ?? { kind: "age", age: fromAge ?? 40 },
    to: to ?? { kind: "age", age: toAge ?? 44 },
    indexed: true, owner: "client", label: "x",
    ...rest,
  };
};

describe("time helpers", () => {
  it("partial first year month counts", () => {
    expect(monthsInFirstYear({ year: 2026, month: 7 })).toBe(12);  // July start = full
    expect(monthsInFirstYear({ year: 2026, month: 8 })).toBe(11);  // August
    expect(monthsInFirstYear({ year: 2026, month: 6 })).toBe(1);   // June
    expect(monthsInFirstYear({ year: 2026, month: 1 })).toBe(6);   // January
  });

  it("FY start year + labels", () => {
    expect(firstFyStartYear({ year: 2026, month: 8 })).toBe(2026);
    expect(firstFyStartYear({ year: 2026, month: 3 })).toBe(2025);
    const plan = { start: { year: 2026, month: 8 } };
    expect(fyLabel(plan, 0)).toBe("FY2026–27");
    expect(fyLabel(plan, 10)).toBe("FY2036–37");
  });

  it("plan year / calendar month mapping", () => {
    const plan = { start: { year: 2026, month: 8 }, client: { currentAge: 40 }, endAge: 44 };
    expect(planYearCount(plan)).toBe(5);
    expect(totalMonths(plan)).toBe(11 + 12 * 4);
    expect(planYearOfMonth(plan, 0)).toBe(0);
    expect(planYearOfMonth(plan, 10)).toBe(0);  // last month of partial year (June)
    expect(planYearOfMonth(plan, 11)).toBe(1);  // July of first full year
    expect(calendarMonthOf(plan, 0)).toBe(8);
    expect(calendarMonthOf(plan, 11)).toBe(7);
  });
});

describe("annual/July timing (convention 5)", () => {
  it("July start fires annuals at exact July month indices", () => {
    const s = mkState({
      start: { year: 2026, month: 7 },
      contributions: [cf({ frequency: "annual", amount: 1200 })],
    });
    const out = buildSchedules(s);
    const flows = out.assetFlows.a1.contributions;
    // Fires at month 0 (July 2026) and each subsequent July (12, 24, ...).
    expect(flows[0]).toBe(1200);
    expect(flows[12]).toBe(1200);
    expect(flows[1]).toBe(0);
    const total = flows.reduce((a, b) => a + b, 0);
    expect(total).toBe(1200 * 5); // 5 plan years, all fire
  });

  it("August start skips the partial first year's annuals", () => {
    const s = mkState({
      start: { year: 2026, month: 8 },
      contributions: [cf({ frequency: "annual", amount: 1200 })],
    });
    const out = buildSchedules(s);
    const flows = out.assetFlows.a1.contributions;
    // No firing anywhere in the 11-month partial year.
    for (let m = 0; m < 11; m++) expect(flows[m]).toBe(0);
    // First firing at m=11 = July 2027 (start of FY2027–28).
    expect(flows[11]).toBe(1200);
    expect(flows.reduce((a, b) => a + b, 0)).toBe(1200 * 4); // year 0 skipped
  });

  it("a pre-July start has no July in the partial year → annuals skip it too", () => {
    const s = mkState({
      start: { year: 2026, month: 3 }, // Mar–Jun partial FY2025–26
      contributions: [cf({ frequency: "annual", amount: 1200 })],
    });
    const out = buildSchedules(s);
    const flows = out.assetFlows.a1.contributions;
    for (let m = 0; m < 4; m++) expect(flows[m]).toBe(0);
    expect(flows[4]).toBe(1200); // July 2026
  });

  it("one-offs follow the same July convention", () => {
    const s = mkState({
      start: { year: 2026, month: 8 },
      lumpSums: [
        { id: "l1", assetId: "a1", amount: 50000, direction: "in", at: { kind: "age", age: 40 }, source: "input" }, // partial year → skipped
        { id: "l2", assetId: "a1", amount: 20000, direction: "out", at: { kind: "age", age: 42 }, source: "input" },
      ],
    });
    const out = buildSchedules(s);
    const oneOffs = out.assetFlows.a1.oneOffs;
    expect(oneOffs.reduce((a, b) => a + Math.abs(b), 0)).toBe(20000); // l1 skipped
    expect(oneOffs[11 + 12]).toBe(-20000); // July of plan year 2 (age 42)
  });
});

describe("indexation (convention 6)", () => {
  it("indexed rows are constant in real terms", () => {
    const s = mkState({ endAge: 50, contributions: [cf({ amount: 500, toAge: 50 })] });
    const out = buildSchedules(s);
    expect(out.assetFlows.a1.contributions[0]).toBe(500);
    expect(out.assetFlows.a1.contributions[120]).toBe(500);
  });

  it("non-indexed rows decay by the closed form at year 10", () => {
    const s = mkState({ endAge: 55, contributions: [cf({ amount: 500, indexed: false, toAge: 55 })] });
    const out = buildSchedules(s);
    const m = 120; // exactly 10 years after a July start
    const expected = 500 / Math.pow(1.025, 10);
    expect(out.assetFlows.a1.contributions[m]).toBeCloseTo(expected, 10);
  });
});

describe("age windows (conventions 3–4)", () => {
  it("boundary plan years are inclusive", () => {
    const s = mkState({
      clientAge: 40, endAge: 50,
      contributions: [cf({ fromAge: 42, toAge: 44, amount: 100 })],
    });
    const out = buildSchedules(s);
    const flows = out.assetFlows.a1.contributions;
    // Plan years 2..4 (ages 42..44) → months 24..59 active.
    expect(flows[23]).toBe(0);
    expect(flows[24]).toBe(100);
    expect(flows[59]).toBe(100);
    expect(flows[60]).toBe(0);
    expect(flows.reduce((a, b) => a + b, 0)).toBe(100 * 36);
  });

  it("income rows anchor to the owner's age (couple, different ages)", () => {
    const s = mkState({
      clientAge: 40, partnerAge: 36, endAge: 50,
      income: [
        { ...cf({ amount: 1000, fromAge: 40, toAge: 40 }), owner: "client" },
        { ...cf({ id: "p", amount: 2000, fromAge: 40, toAge: 40 }), owner: "partner" },
      ],
    });
    const out = buildSchedules(s);
    // Client is 40 in plan year 0 → months 0..11.
    expect(out.income[0]).toBe(1000);
    expect(out.income[12]).toBe(0 + 0); // client row inactive; partner still 37
    // Partner is 40 in plan year 4 → months 48..59.
    expect(out.income[48]).toBe(2000);
    expect(out.income[59]).toBe(2000);
    expect(out.income[60]).toBe(0);
  });
});

describe("exclusions + display scaling", () => {
  it("rows targeting an excluded asset contribute zero", () => {
    const s = mkState({
      assets: [{ id: "a1", include: false }],
      contributions: [cf({ amount: 500 })],
    });
    const out = buildSchedules(s);
    expect(out.assetFlows.a1).toBeUndefined();
  });

  it("nominalFactor matches (1+cpi)^(m/12)", () => {
    expect(nominalFactor(120, 0.025)).toBeCloseTo(Math.pow(1.025, 10), 12);
    expect(nominalFactor(0, 0.025)).toBe(1);
  });
});

describe("indexation model (D1)", () => {
  const at = (row, m) => {
    const s = mkState({ endAge: 55, contributions: [{ ...cf({ toAge: 55 }), ...row }] });
    s.assumptions.awote = 0.035;
    return buildSchedules(s).assetFlows.a1.contributions[m];
  };

  it("CPI + 0% is constant real (old indexed:true)", () => {
    expect(at({ indexBasis: "cpi", indexExtraPct: 0, amount: 500 }, 120)).toBe(500);
  });

  it("None + 0% decays at CPI (old indexed:false)", () => {
    expect(at({ indexBasis: "none", indexExtraPct: 0, amount: 500 }, 120))
      .toBeCloseTo(500 / Math.pow(1.025, 10), 10);
  });

  it("AWOTE-linked rows grow in real terms by the wage premium", () => {
    expect(at({ indexBasis: "awote", indexExtraPct: 0, amount: 500 }, 120))
      .toBeCloseTo(500 * Math.pow(1.035 / 1.025, 10), 10);
  });

  it("additional % stacks on the basis (CPI 2.5% + 1% = 3.5% nominal)", () => {
    expect(at({ indexBasis: "cpi", indexExtraPct: 1, amount: 500 }, 120))
      .toBeCloseTo(500 * Math.pow(1.035 / 1.025, 10), 10);
  });

  it("legacy indexed flags produce identical schedules to their bases", () => {
    expect(at({ indexed: true, indexBasis: undefined, amount: 500 }, 120))
      .toBe(at({ indexBasis: "cpi", indexExtraPct: 0, amount: 500 }, 120));
    expect(at({ indexed: false, indexBasis: undefined, amount: 500 }, 120))
      .toBe(at({ indexBasis: "none", indexExtraPct: 0, amount: 500 }, 120));
  });
});

describe("Investment/education bonds (spec 25, Commit 1) — bond contribution flows", () => {
  it("a bond contribution resolves into bondFlows[bondId].contributions, not assetFlows", () => {
    const s = mkState({
      bonds: [{ id: "bd1", include: true }],
      bondContributions: [{ id: "bc1", bondId: "bd1", amount: 500, frequency: "monthly", from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 }, indexBasis: "none", indexExtraPct: 0 }],
    });
    const out = buildSchedules(s);
    expect(out.bondFlows.bd1.contributions[0]).toBe(500);
    expect(out.assetFlows.a1.contributions[0]).toBe(0);
  });

  it("an excluded bond carries no flow arrays; a contribution targeting it is simply not applied", () => {
    const s = mkState({
      bonds: [{ id: "bd1", include: false }],
      bondContributions: [{ id: "bc1", bondId: "bd1", amount: 500, frequency: "monthly", from: { kind: "age", age: 40 }, to: { kind: "age", age: 44 }, indexBasis: "none", indexExtraPct: 0 }],
    });
    const out = buildSchedules(s);
    expect(out.bondFlows.bd1).toBeUndefined();
  });

  it("no bonds at all leaves bondFlows an empty object, no crash", () => {
    const out = buildSchedules(mkState());
    expect(out.bondFlows).toEqual({});
  });
});
