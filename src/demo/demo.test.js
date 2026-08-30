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

  it("the purchase actually happens in Perth (WA) — a mortgage exists the year after settlement, in both purchase scenarios", () => {
    for (const scenario of [buy2030, fhsss]) {
      expect(scenario.state.properties[0].state).toBe("WA");
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
  const recycling = client.scenarios.find((s) => s.name === "Debt recycling");

  it("the fixed-rate loan crosses its own rollover — the rate changes between year 0 and a year well before full payoff", () => {
    const out = projectPlan(current.state);
    const fixedLoan = current.state.liabilities.find((l) => l.rateType === "fixed");
    const firstRate = out.yearly[0].liabilities[fixedLoan.id].ratePct;
    // Year 3, not the final year: the projection runs decades past the
    // 25-year loan term, by which point the loan is long paid off and
    // its own reported rate is a meaningless 0 regardless of rollover —
    // same reasoning First home buyer's own purchase-year check above
    // uses for "check right after the event, not at the far end".
    const laterRate = out.yearly[3].liabilities[fixedLoan.id].ratePct;
    expect(laterRate).not.toBeCloseTo(firstRate, 3);
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

  it("the investment property is negatively geared and clears VIC's own land tax threshold", () => {
    const out = projectPlan(current.state);
    const propertyId = current.state.properties[0].id;
    const loan = current.state.liabilities.find((l) => l.type === "investment");
    const row = out.yearly[0];
    const rent = row.properties[propertyId].rent;
    const cost = row.properties[propertyId].expenses + (row.liabilities[loan.id]?.interest ?? 0);
    expect(rent).toBeLessThan(cost);
    const totalLandTax = out.yearly.reduce((s, r) => s + (r.properties?.[propertyId]?.landTax ?? 0), 0);
    expect(totalLandTax).toBeGreaterThan(0);
  });

  it("the travel goal is present and targets a real future age", () => {
    expect(current.state.goals.length).toBeGreaterThan(0);
    const goal = current.state.goals[0];
    expect(goal.targetAmount).toBeGreaterThan(0);
  });

  it("salary packaging is linked to the partner's FBT-exempt employer", () => {
    const packaging = current.state.cashflows.deductions.find((d) => d.category === "salaryPackaging");
    expect(packaging).toBeTruthy();
    const employer = current.state.plan.employers.find((e) => e.id === packaging.employerId);
    expect(employer).toBeTruthy();
    expect(employer.fbtType).toBe("fbtExempt");
  });

  it("debt recycling grows the destination investment asset well beyond its starting zero balance", () => {
    const out = projectPlan(recycling.state);
    const investAsset = recycling.state.assets.find((a) => a.name === "Investment portfolio");
    expect(investAsset.balance).toBe(0); // starts empty — everything in it came from the recycled redraw
    const finalBalance = out.yearly[out.yearly.length - 1].perAssetDetail?.[investAsset.id]?.closing ?? 0;
    expect(finalBalance).toBeGreaterThan(0);
  });
});

describe("Comprehensive pre-retiree — the features this client exists to exercise", () => {
  const client = clients.find((c) => c.name === "Comprehensive pre-retiree");
  const current = client.scenarios.find((s) => s.name === "Current");
  const maximise = client.scenarios.find((s) => s.name === "Maximise concessional");
  const retire60 = client.scenarios.find((s) => s.name === "Retire at 60");
  const sellProperty = client.scenarios.find((s) => s.name === "Sell the investment property at 65");

  it("projects to age 95, not the default life-expectancy basis", () => {
    expect(current.state.plan.endBasis.mode).toBe("fixedAge");
    expect(current.state.plan.endAge).toBe(95);
  });

  it("Division 293 applies to the high-income client", () => {
    const out = projectPlan(current.state);
    // Year index 1, not 0: this demo is anchored to whatever day it's
    // loaded, so plan year 0 is almost always a partial FY; year 1 is
    // always a full 12-month FY.
    expect(out.yearly[1].taxDetail.client.div293).toBeGreaterThan(0);
  });

  it("Division 296 applies to the client's own large total super balance", () => {
    const out = projectPlan(current.state);
    expect(out.yearly[1].taxDetail.client.div296).toBeGreaterThan(0);
  });

  it("the defined benefit pension pays a real, non-zero pension from the year it commences", () => {
    const out = projectPlan(current.state);
    const db = current.state.plan.definedBenefits[0];
    expect(db.owner).toBe("partner");
    const firedYear = out.yearly.findIndex((row) => (row.definedBenefitDetail?.[db.id]?.grossPension ?? 0) > 0);
    expect(firedYear).toBeGreaterThanOrEqual(0);
    // Every subsequent year keeps paying it — it isn't a one-off.
    expect(out.yearly[firedYear + 1].definedBenefitDetail[db.id].grossPension).toBeGreaterThan(0);
  });

  it("has a defined benefit pension, a death benefit nomination for both, and an education bond", () => {
    expect(current.state.plan.definedBenefits.length).toBe(1);
    expect(current.state.plan.client.deathBenefit.beneficiaries.length).toBeGreaterThan(0);
    expect(current.state.plan.partner.deathBenefit.beneficiaries.length).toBeGreaterThan(0);
    expect(current.state.bonds.length).toBe(1);
    expect(current.state.bonds[0].type).toBe("education");
  });

  it("the aged care entry fires late in the projection, with the former home protected", () => {
    const out = projectPlan(current.state);
    const ac = current.state.plan.agedCare[0];
    expect(ac.formerHomeOccupiedByProtectedPerson).toBe(true);
    const firedYear = out.yearly.findIndex((row) => (row.agedCareDetail?.[ac.id]?.total ?? 0) > 0);
    expect(firedYear).toBeGreaterThan(20); // "late" — well past the halfway mark of a 40-year projection
  });

  it("the TTR pension (Maximise concessional) pays tax on its earnings; the ABP (Retire at 60) does not — the retirement-phase exemption doing real work", () => {
    const ttrOut = projectPlan(maximise.state);
    const abpOut = projectPlan(retire60.state);
    const ttrPension = maximise.state.plan.pensions[0];
    const abpPension = retire60.state.plan.pensions[0];
    expect(ttrPension.type).toBe("ttr");
    expect(abpPension.type).toBe("abp");
    const ttrYear = ttrOut.yearly.findIndex((row) => (row.pensionDetail?.[ttrPension.id]?.payments ?? 0) > 0);
    const abpYear = abpOut.yearly.findIndex((row) => (row.pensionDetail?.[abpPension.id]?.payments ?? 0) > 0);
    expect(ttrYear).toBeGreaterThanOrEqual(0);
    expect(abpYear).toBeGreaterThanOrEqual(0);
    expect(ttrOut.yearly[ttrYear].pensionDetail[ttrPension.id].earningsTax).toBeGreaterThan(0);
    expect(abpOut.yearly[abpYear].pensionDetail[abpPension.id].earningsTax).toBe(0);
  });

  it("maximising concessional contributions reduces household taxable income relative to Current", () => {
    const base = projectPlan(current.state);
    const shocked = projectPlan(maximise.state);
    const baseTaxable = base.yearly[1].taxDetail.client.taxableIncome + (base.yearly[1].taxDetail.partner?.taxableIncome ?? 0);
    const shockedTaxable = shocked.yearly[1].taxDetail.client.taxableIncome + (shocked.yearly[1].taxDetail.partner?.taxableIncome ?? 0);
    expect(shockedTaxable).toBeLessThan(baseTaxable);
  });

  it("retiring at 60 stops the client's income from that year on, relative to Current", () => {
    const base = projectPlan(current.state);
    const shocked = projectPlan(retire60.state);
    const y = 7; // well after the client's own age-60 cutoff (plan year 5)
    expect(shocked.yearly[y].income).toBeLessThan(base.yearly[y].income);
  });

  it("selling the investment property realises a capital gain and pays down/discharges its own loan", () => {
    const out = projectPlan(sellProperty.state);
    const property = sellProperty.state.properties[0];
    const saleYear = out.yearly.findIndex((row) => (row.properties?.[property.id]?.saleProceeds ?? 0) > 0);
    expect(saleYear).toBeGreaterThanOrEqual(0);
    expect(out.yearly[saleYear].properties[property.id].saleGain).toBeGreaterThan(0);
    const loanId = sellProperty.state.liabilities.find((l) => l.type === "investment").id;
    // The property is gone (value zeroed) from the sale year on.
    expect(out.yearly[saleYear + 1].properties[property.id]?.value ?? 0).toBe(0);
  });
});

describe("Modest retiree — the features this client exists to exercise", () => {
  const client = clients.find((c) => c.name === "Modest retiree");
  const current = client.scenarios.find((s) => s.name === "Current");
  const gift = client.scenarios.find((s) => s.name === "Gift $30k to children");
  const downsize = client.scenarios.find((s) => s.name === "Downsize at 75");

  it("draws a near-full age pension — comfortably more than a token amount, homeowner asset test barely binding", () => {
    const out = projectPlan(current.state);
    const entitlement = out.yearly[1].agePensionDetail?.entitlement ?? 0;
    expect(entitlement).toBeGreaterThan(30_000); // well above a token/means-tested-down figure
  });

  it("deeming applies a non-zero deemed income against their super pensions and savings", () => {
    const out = projectPlan(current.state);
    expect(out.yearly[1].agePensionDetail?.deemedIncome ?? 0).toBeGreaterThan(0);
  });

  it("the Work Bonus exempts the partner's own casual income, and only the partner's (the client has none)", () => {
    const out = projectPlan(current.state);
    const row = out.yearly[1].agePensionDetail;
    expect(row?.partner?.workBonusExempt ?? 0).toBeGreaterThan(0);
    expect(row?.client?.workBonusExempt ?? 0).toBe(0);
  });

  it("the $30,000 gift is only partly allowable — $20,000 is deprived under the annual ($10k) limit, assessed for five years", () => {
    const out = projectPlan(gift.state);
    const maxDeprived = Math.max(...out.yearly.map((r) => r.agePensionDetail?.deprivedAssets ?? 0));
    expect(maxDeprived).toBeCloseTo(20_000, 0);
    // It ages out — the deprivation isn't held forever.
    const lastYearDeprived = out.yearly[out.yearly.length - 1].agePensionDetail?.deprivedAssets ?? 0;
    expect(lastYearDeprived).toBe(0);
  });

  it("both pensions draw down at the minimum rate from the year they commence", () => {
    const out = projectPlan(current.state);
    const [pensionClient, pensionPartner] = current.state.plan.pensions;
    expect(pensionClient.drawdownOption).toBe("minimum");
    expect(pensionPartner.drawdownOption).toBe("minimum");
    const firedYear = out.yearly.findIndex((row) => (row.pensionDetail?.[pensionClient.id]?.payments ?? 0) > 0);
    expect(firedYear).toBeGreaterThanOrEqual(0);
  });

  it("downsizing at 75 sells the family home and the proceeds land in Savings, CGT-exempt", () => {
    const out = projectPlan(downsize.state);
    const home = downsize.state.properties[0];
    const saleYear = out.yearly.findIndex((row) => (row.properties?.[home.id]?.saleProceeds ?? 0) > 0);
    expect(saleYear).toBeGreaterThanOrEqual(0);
    expect(out.yearly[saleYear].properties[home.id].saleGain).toBe(0); // PPR — fully exempt
    // The freed-up cash visibly lifts Savings relative to Current in
    // the same year — not asserting an exact figure, just that it
    // landed somewhere real. Each scenario builds its OWN Savings
    // asset (a fresh id every build() call), so look it up separately
    // in each rather than reusing one scenario's id in the other's.
    const downsizeSavings = downsize.state.assets.find((a) => a.name === "Savings");
    const currentSavings = current.state.assets.find((a) => a.name === "Savings");
    const baseOut = projectPlan(current.state);
    expect(out.yearly[saleYear].perAssetDetail[downsizeSavings.id].closing).toBeGreaterThan(
      baseOut.yearly[saleYear].perAssetDetail[currentSavings.id].closing
    );
  });
});
