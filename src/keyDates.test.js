import { describe, it, expect } from "vitest";
import { resolveRef, listAnchors, isValidAnchorId, isBuiltInAnchor } from "./keyDates.js";

// A minimal single-household plan/schedule pair: client currentAge 40,
// endAge 70 → 31 plan years (ages 40..70), FY labels FY2026–27.. .
function singlePlan(overrides = {}) {
  return {
    client: { firstName: "Jo", surname: "Smith", currentAge: 40, retirementAge: 65 },
    partner: null,
    endAge: 70,
    keyDates: [],
    start: { year: 2026, month: 7 },
    ...overrides,
  };
}

function couplePlan(overrides = {}) {
  return {
    client: { firstName: "Jo", surname: "Smith", currentAge: 40, retirementAge: 65 },
    partner: { firstName: "Sam", surname: "Smith", currentAge: 38, retirementAge: 63 },
    endAge: 70,
    keyDates: [],
    start: { year: 2026, month: 7 },
    ...overrides,
  };
}

function scheduleFor(plan) {
  const planYears = plan.endAge - plan.client.currentAge + 1;
  const clientAges = Array.from({ length: planYears }, (_, y) => plan.client.currentAge + y);
  const partnerAges = plan.partner
    ? Array.from({ length: planYears }, (_, y) => plan.partner.currentAge + y)
    : null;
  const fyLabels = Array.from({ length: planYears }, (_, y) => {
    const fy = 2026 + y;
    return `FY${fy}–${String((fy + 1) % 100).padStart(2, "0")}`;
  });
  return { planYears, clientAges, partnerAges, fyLabels };
}

describe("resolveRef — built-in anchors", () => {
  it("start resolves to plan year 0", () => {
    const plan = singlePlan();
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "anchor", anchorId: "start" }, plan, schedule);
    expect(r).toEqual({ planYear: 0, age: 40, fyLabel: "FY2026–27", outOfRange: false });
  });

  it("end resolves to the final plan year", () => {
    const plan = singlePlan();
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "anchor", anchorId: "end" }, plan, schedule);
    expect(r).toEqual({ planYear: 30, age: 70, fyLabel: schedule.fyLabels[30], outOfRange: false });
  });

  it("retirement-client resolves to the plan year the client reaches retirementAge", () => {
    const plan = singlePlan();
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "anchor", anchorId: "retirement-client" }, plan, schedule);
    // client is 40 at plan year 0, retires at 65 → plan year 25.
    expect(r).toEqual({ planYear: 25, age: 65, fyLabel: schedule.fyLabels[25], outOfRange: false });
  });

  it("retirement-partner resolves against the partner's own age and retirementAge", () => {
    const plan = couplePlan();
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "anchor", anchorId: "retirement-partner" }, plan, schedule);
    // partner is 38 at plan year 0, retires at 63 → plan year 25.
    expect(r).toEqual({ planYear: 25, age: 63, fyLabel: schedule.fyLabels[25], outOfRange: false });
  });
});

describe("resolveRef — user key dates on both bases", () => {
  it("resolves a client-basis key date", () => {
    const plan = couplePlan({ keyDates: [{ id: "kd1", label: "Buy a home", basis: "client", age: 46 }] });
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "anchor", anchorId: "kd1" }, plan, schedule);
    expect(r).toEqual({ planYear: 6, age: 46, fyLabel: schedule.fyLabels[6], outOfRange: false });
  });

  it("resolves a partner-basis key date", () => {
    const plan = couplePlan({ keyDates: [{ id: "kd1", label: "Downsize", basis: "partner", age: 50 }] });
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "anchor", anchorId: "kd1" }, plan, schedule);
    // partner is 38 at plan year 0 → age 50 is plan year 12.
    expect(r).toEqual({ planYear: 12, age: 50, fyLabel: schedule.fyLabels[12], outOfRange: false });
  });

  it("a partner-basis key date on a single household falls back to the client", () => {
    const plan = singlePlan({ keyDates: [{ id: "kd1", label: "Odd", basis: "partner", age: 46 }] });
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "anchor", anchorId: "kd1" }, plan, schedule);
    expect(r.age).toBe(46); // resolved against the client (currentAge 40 + 6)
    expect(r.planYear).toBe(6);
  });
});

describe("resolveRef — {kind:'age'} owner-vs-client resolution", () => {
  it("resolves against the CLIENT by default (expenses, contributions, withdrawals, lump sums, purchases)", () => {
    const plan = couplePlan();
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "age", age: 50 }, plan, schedule); // ownerForAges defaults to "client"
    expect(r).toEqual({ planYear: 10, age: 50, fyLabel: schedule.fyLabels[10], outOfRange: false });
  });

  it("resolves against the OWNER for income rows", () => {
    const plan = couplePlan();
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "age", age: 50 }, plan, schedule, "partner");
    // partner is 38 at plan year 0 → age 50 is plan year 12, not 10.
    expect(r).toEqual({ planYear: 12, age: 50, fyLabel: schedule.fyLabels[12], outOfRange: false });
  });
});

describe("resolveRef — out-of-range clamping", () => {
  it("an age before the plan start clamps to plan year 0 and flags outOfRange", () => {
    const plan = singlePlan();
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "age", age: 20 }, plan, schedule);
    expect(r).toEqual({ planYear: 0, age: 40, fyLabel: schedule.fyLabels[0], outOfRange: true });
  });

  it("an age beyond the plan end clamps to the last plan year and flags outOfRange", () => {
    const plan = singlePlan();
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "age", age: 200 }, plan, schedule);
    const last = schedule.planYears - 1;
    expect(r).toEqual({ planYear: last, age: 70, fyLabel: schedule.fyLabels[last], outOfRange: true });
  });

  it("a retirement anchor before the plan start clamps and flags", () => {
    // Client retires at 30, but the plan starts at currentAge 40 — the
    // "retirement" year already happened before the projection began.
    const plan = singlePlan({ client: { ...singlePlan().client, retirementAge: 30 } });
    const schedule = scheduleFor(plan);
    const r = resolveRef({ kind: "anchor", anchorId: "retirement-client" }, plan, schedule);
    expect(r.planYear).toBe(0);
    expect(r.outOfRange).toBe(true);
  });

  it("never throws for a dangling/unknown anchor id — falls back to plan start", () => {
    const plan = singlePlan();
    const schedule = scheduleFor(plan);
    expect(() => resolveRef({ kind: "anchor", anchorId: "nope" }, plan, schedule)).not.toThrow();
    const r = resolveRef({ kind: "anchor", anchorId: "nope" }, plan, schedule);
    expect(r.planYear).toBe(0);
  });
});

describe("listAnchors", () => {
  it("lists start/end/retirement-client for a single household, resolved and displayable", () => {
    const plan = singlePlan();
    const schedule = scheduleFor(plan);
    const anchors = listAnchors(plan, schedule);
    expect(anchors.map((a) => a.id)).toEqual(["start", "end", "retirement-client"]);
    const retirement = anchors.find((a) => a.id === "retirement-client");
    // display format: "Retirement — Jo Smith — age 65 (FY2051–52)"
    expect(retirement.display).toBe(`Retirement — Jo Smith — age 65 (${schedule.fyLabels[25]})`);
    expect(retirement.display).toMatch(/^Retirement — Jo Smith — age 65 \(FY\d{4}–\d{2}\)$/);
  });

  it("adds retirement-partner for a couple, and user key dates in definition order", () => {
    const plan = couplePlan({
      keyDates: [
        { id: "kd1", label: "Buy a home", basis: "client", age: 46 },
        { id: "kd2", label: "Downsize", basis: "partner", age: 55 },
      ],
    });
    const schedule = scheduleFor(plan);
    const anchors = listAnchors(plan, schedule);
    expect(anchors.map((a) => a.id)).toEqual(["start", "end", "retirement-client", "retirement-partner", "kd1", "kd2"]);
    expect(anchors.find((a) => a.id === "kd1").display).toMatch(/^Buy a home — age 46 \(FY\d{4}–\d{2}\)$/);
  });

  it("flags an out-of-range anchor in its listing entry", () => {
    const plan = singlePlan({ keyDates: [{ id: "kd1", label: "Too late", basis: "client", age: 200 }] });
    const schedule = scheduleFor(plan);
    const anchors = listAnchors(plan, schedule);
    const kd = anchors.find((a) => a.id === "kd1");
    expect(kd.outOfRange).toBe(true);
    expect(kd.age).toBe(70); // clamped to the last plan year's client age
  });
});

describe("isBuiltInAnchor / isValidAnchorId", () => {
  it("recognises the three universal built-ins and retirement-partner only for couples", () => {
    const single = singlePlan();
    const couple = couplePlan();
    for (const id of ["start", "end", "retirement-client"]) {
      expect(isBuiltInAnchor(id, single)).toBe(true);
      expect(isBuiltInAnchor(id, couple)).toBe(true);
    }
    expect(isBuiltInAnchor("retirement-partner", single)).toBe(false);
    expect(isBuiltInAnchor("retirement-partner", couple)).toBe(true);
  });

  it("validates a user key date id only when it currently exists on the plan", () => {
    const plan = singlePlan({ keyDates: [{ id: "kd1", label: "Buy a home", basis: "client", age: 46 }] });
    expect(isValidAnchorId("kd1", plan)).toBe(true);
    expect(isValidAnchorId("kd2", plan)).toBe(false);
    expect(isValidAnchorId("start", plan)).toBe(true);
  });
});
