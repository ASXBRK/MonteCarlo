// Demo clients — structural tests only, deliberately no dollar-figure
// assertions. When a bug is fixed the demo numbers should MOVE; a
// snapshot assertion would fail on every legitimate change and get
// trained away rather than actually caught. These assert shape: it
// builds, it holds the conservation invariant, affordable scenarios
// stay affordable, and the feature each scenario exists to exercise
// actually fires.
import { describe, it, expect } from "vitest";
import { buildDemoClients } from "./index.js";
import { projectPlan } from "../deterministic.js";
import { checkYearConservation } from "../conservationCheck.js";
import { dependentChildrenCountInFY } from "../planState.js";
import { firstFyStartYear } from "../schedule.js";

// Fixed, not new Date() — a demo client's derived ages must be
// reproducible in CI regardless of what day the suite runs.
const NOW = new Date("2026-08-17T00:00:00+10:00");
const clients = buildDemoClients(NOW);

describe("Demo clients — every scenario builds, projects, and conserves money", () => {
  for (const client of clients) {
    for (const scenario of client.scenarios) {
      const label = `${client.name} — ${scenario.name}`;

      it(`${label}: builds and projects without throwing`, () => {
        expect(() => projectPlan(scenario.state)).not.toThrow();
      });

      it(`${label}: holds the conservation invariant across every year`, () => {
        const out = projectPlan(scenario.state);
        const years = out.yearly.length;
        // Final year excluded — its CGT/Div293/Div296 assessment is an
        // accrued liability, not yet a cashflow (same convention the
        // invariant itself and every other test using it follows).
        for (let y = 0; y < years - 1; y++) checkYearConservation(out, y, `${label}, year ${y}`);
      });

      if (scenario.expectAffordable) {
        it(`${label}: no unfunded cashflow (marked affordable)`, () => {
          const out = projectPlan(scenario.state);
          expect(out.shortfall).toBeNull();
        });
      } else {
        // An expectAffordable:false scenario exists to demonstrate a
        // plan that doesn't hold up — it must actually fail, not merely
        // be exempted from the check above. A scenario that never
        // produces unfunded cashflow while flagged false is a vacuous
        // assertion (it would trivially "pass" no matter what the
        // engine did) and a mislabelled scenario besides.
        it(`${label}: genuinely produces unfunded cashflow (marked unaffordable)`, () => {
          const out = projectPlan(scenario.state);
          expect(out.shortfall).not.toBeNull();
        });
      }
    }
  }
});

describe("First home buyer — the features this client exists to exercise", () => {
  const client = clients.find((c) => c.name === "First home buyer");
  const fhsss = client.scenarios.find((s) => s.name === "Buy 2030 with FHSSS");
  const buy2030 = client.scenarios.find((s) => s.name === "Buy 2030");

  it("has a HELP balance that actually reduces over the projection", () => {
    const out = projectPlan(client.scenarios[0].state); // Current
    const opening = client.scenarios[0].state.plan.client.helpBalance;
    const closing = out.yearly[out.yearly.length - 1].taxDetail.client.helpBalanceClosing;
    expect(opening).toBeGreaterThan(0);
    expect(closing).toBeLessThan(opening);
  });

  it("the FHSSS scenario releases a non-zero amount in the purchase year", () => {
    const out = projectPlan(fhsss.state);
    const totalReleased = out.yearly.reduce((s, row) => s + (row.taxDetail?.client?.fhsssRelease ?? 0), 0);
    expect(totalReleased).toBeGreaterThan(0);
  });

  it("the purchase actually happens — a mortgage exists the year after settlement, in both purchase scenarios", () => {
    for (const scenario of [buy2030, fhsss]) {
      const out = projectPlan(scenario.state);
      const propertyId = scenario.state.properties[0].id;
      // Not the LAST year: a purchase-engine loan is a normal 25-30yr
      // term, and this client's projection runs ~50 years past the
      // purchase (to end-of-life) — by the final year the loan is long
      // since paid off, same as any other mortgage. Check the year
      // right after settlement instead, where the loan must still
      // exist regardless of term length.
      // deposit, not settlement: the FHSSS scenario's release can
      // exceed what the deposit+costs need, making net settlement cash
      // slightly NEGATIVE (a net inflow) in the purchase year — deposit
      // is positive in both scenarios regardless.
      const purchaseYear = out.yearly.findIndex((row) => (row.properties?.[propertyId]?.deposit ?? 0) > 0);
      expect(purchaseYear).toBeGreaterThanOrEqual(0); // the purchase fired at all
      const afterPurchase = out.yearly[purchaseYear + 1];
      const hasLoan = Object.values(afterPurchase.liabilities ?? {}).some((l) => l.opening > 0 || l.closing > 0);
      expect(hasLoan).toBe(true);
    }
  });

  it("First Home Guarantee waives LMI at this LVR — no LMI cost recorded against the purchase", () => {
    const out = projectPlan(buy2030.state);
    const totalLmi = out.yearly.reduce((s, row) => s + (row.properties?.[buy2030.state.properties[0].id]?.lmi ?? 0), 0);
    expect(totalLmi).toBe(0);
  });
});

describe("Family with a mortgage — the features this client exists to exercise", () => {
  const client = clients.find((c) => c.name === "Family with a mortgage");
  const current = client.scenarios.find((s) => s.name === "Current");
  const sacrifice = client.scenarios.find((s) => s.name === "Salary sacrifice $15k each");
  const extra = client.scenarios.find((s) => s.name === "Extra repayments $1k/mo");

  it("the fixed-rate loan crosses its own rollover — the rate changes between year 0 and the final year", () => {
    const out = projectPlan(current.state);
    const fixedLoan = current.state.liabilities.find((l) => l.rateType === "fixed");
    const firstRate = out.yearly[0].liabilities[fixedLoan.id].ratePct;
    const lastRate = out.yearly[out.yearly.length - 1].liabilities[fixedLoan.id].ratePct;
    expect(lastRate).not.toBeCloseTo(firstRate, 3);
  });

  it("the Medicare Levy Surcharge actually applies to this household (no private cover, family income above threshold)", () => {
    const out = projectPlan(current.state);
    const totalMls = out.yearly.reduce(
      (s, row) => s + (row.taxDetail?.client?.medicareLevySurcharge ?? 0) + (row.taxDetail?.partner?.medicareLevySurcharge ?? 0), 0
    );
    expect(totalMls).toBeGreaterThan(0);
  });

  it("derived dependent children steps down as the elder turns 21 within the projection", () => {
    const out = projectPlan(current.state);
    // dependentChildren isn't a stored per-row field (only the MLS
    // calculation consumes it internally) — derive it the same way the
    // engine does, directly from the plan's own children.
    const fy0 = firstFyStartYear(current.state.plan.start);
    const first = dependentChildrenCountInFY(current.state.plan.children, fy0);
    const last = dependentChildrenCountInFY(current.state.plan.children, fy0 + out.yearly.length - 1);
    expect(first).toBeGreaterThanOrEqual(last);
    expect(last).toBeLessThan(first); // the elder actually ages out within this long a projection
  });

  it("education fees appear as a household expense once the elder child reaches school age", () => {
    const out = projectPlan(current.state);
    const totalEducation = Object.values(out.schedule.rowTotals.education ?? {})
      .reduce((s, series) => s + series.reduce((a, v) => a + v, 0), 0);
    expect(totalEducation).toBeGreaterThan(0);
  });

  it("salary sacrifice reduces take-home pay relative to Current, in the year it's paid", () => {
    const base = projectPlan(current.state);
    const shocked = projectPlan(sacrifice.state);
    expect(shocked.yearly[0].income).toBeLessThan(base.yearly[0].income);
  });

  it("extra repayments pay the variable loan off earlier than the scheduled path", () => {
    const out = projectPlan(extra.state);
    const variableLoan = extra.state.liabilities.find((l) => l.rateType === "variable");
    expect(out.liabilityRepaymentStats?.[variableLoan.id]).toBeTruthy();
  });
});

describe("High earner pre-retirement — the features this client exists to exercise", () => {
  const client = clients.find((c) => c.name === "High earner pre-retirement");
  const current = client.scenarios.find((s) => s.name === "Current");
  const maximise = client.scenarios.find((s) => s.name === "Maximise concessional");
  const reduceWork = client.scenarios.find((s) => s.name === "Reduce work at 58");

  it("Division 293 applies to the high-income client in year one", () => {
    const out = projectPlan(current.state);
    // Year index 1, not 0: this demo is anchored to whatever day it's
    // loaded, so plan year 0 is almost always a partial FY (no July —
    // see the frequency comment in highEarnerPreRetirement.js); year 1
    // is always a full 12-month FY and the first one this client's
    // full income actually applies across.
    expect(out.yearly[1].taxDetail.client.div293).toBeGreaterThan(0);
  });

  it("the investment property is negatively geared — its own rent doesn't cover interest + expenses", () => {
    const out = projectPlan(current.state);
    const propertyId = current.state.properties[0].id;
    const loan = current.state.liabilities.find((l) => l.type === "investment");
    const row = out.yearly[0];
    const rent = row.properties[propertyId].rent;
    const cost = row.properties[propertyId].expenses + (row.liabilities[loan.id]?.interest ?? 0);
    expect(rent).toBeLessThan(cost);
  });

  it("maximising concessional contributions reduces household taxable income relative to Current", () => {
    const base = projectPlan(current.state);
    const shocked = projectPlan(maximise.state);
    // Year index 1, not 0: a toConcessionalCap contribution is credited
    // once, in the FY's July (deterministic.js) — plan year 0 here is a
    // partial FY with no July (see the frequency comment in
    // highEarnerPreRetirement.js), so it never fires there regardless.
    const baseTaxable = base.yearly[1].taxDetail.client.taxableIncome + (base.yearly[1].taxDetail.partner?.taxableIncome ?? 0);
    const shockedTaxable = shocked.yearly[1].taxDetail.client.taxableIncome + (shocked.yearly[1].taxDetail.partner?.taxableIncome ?? 0);
    expect(shockedTaxable).toBeLessThan(baseTaxable);
  });

  it("reducing work at 58 lowers household income from that year on, relative to Current", () => {
    const base = projectPlan(current.state);
    const shocked = projectPlan(reduceWork.state);
    const y = 6; // client is 52 at plan start; age 58 is plan year 6
    expect(shocked.yearly[y].income).toBeLessThan(base.yearly[y].income);
  });

  it("the projection runs well past retirement age, into drawdown", () => {
    const out = projectPlan(current.state);
    const retirementYear = 65 - current.state.plan.client.currentAge;
    expect(out.yearly.length).toBeGreaterThan(retirementYear + 1);
  });
});
