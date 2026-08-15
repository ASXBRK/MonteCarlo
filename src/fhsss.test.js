import { describe, it, expect } from "vitest";
import { fhsssAcceptContribution, fhsssReleaseAmounts, FHSSS_ANNUAL_CAP, FHSSS_LIFETIME_CAP } from "./fhsss.js";

describe("fhsssAcceptContribution", () => {
  it("accepts the full request when under both caps", () => {
    const r = fhsssAcceptContribution({ requestedConcessional: 5000, requestedNonConcessional: 3000, lifetimeContributed: 0 });
    expect(r.acceptedConcessional).toBeCloseTo(5000, 6);
    expect(r.acceptedNonConcessional).toBeCloseTo(3000, 6);
    expect(r.rejected).toBeCloseTo(0, 6);
    expect(r.newLifetimeContributed).toBeCloseTo(8000, 6);
  });

  it("the annual cap ($15,000) binds and splits proportionally across the two types", () => {
    // 12,000 concessional + 6,000 non-concessional = 18,000 requested;
    // capped at 15,000 → 5/6 accepted of each.
    const r = fhsssAcceptContribution({ requestedConcessional: 12000, requestedNonConcessional: 6000, lifetimeContributed: 0 });
    expect(r.acceptedConcessional).toBeCloseTo(10000, 2);
    expect(r.acceptedNonConcessional).toBeCloseTo(5000, 2);
    expect(r.rejected).toBeCloseTo(3000, 2);
  });

  it("the lifetime cap ($50,000) binds even when the annual cap wouldn't", () => {
    const r = fhsssAcceptContribution({ requestedConcessional: 10000, requestedNonConcessional: 0, lifetimeContributed: 45000 });
    expect(r.acceptedConcessional).toBeCloseTo(5000, 2); // only 5,000 of lifetime headroom left
    expect(r.rejected).toBeCloseTo(5000, 2);
    expect(r.newLifetimeContributed).toBeCloseTo(FHSSS_LIFETIME_CAP, 2);
  });

  it("zero headroom rejects the whole request", () => {
    const r = fhsssAcceptContribution({ requestedConcessional: 1000, requestedNonConcessional: 0, lifetimeContributed: 50000 });
    expect(r.acceptedConcessional).toBe(0);
    expect(r.rejected).toBeCloseTo(1000, 6);
  });

  it("a zero request accepts zero without dividing by zero", () => {
    const r = fhsssAcceptContribution({ requestedConcessional: 0, requestedNonConcessional: 0, lifetimeContributed: 0 });
    expect(r.acceptedConcessional).toBe(0);
    expect(r.acceptedNonConcessional).toBe(0);
    expect(r.rejected).toBe(0);
  });

  it("the annual cap is exactly $15,000", () => {
    expect(FHSSS_ANNUAL_CAP).toBe(15000);
  });
});

describe("fhsssReleaseAmounts", () => {
  it("known-value: 85% of concessional + 100% of non-concessional + all earnings", () => {
    const r = fhsssReleaseAmounts({ concessionalBalance: 20000, nonConcessionalBalance: 5000, earnings: 1200 });
    expect(r.taxFreeComponent).toBeCloseTo(5000, 6);
    expect(r.taxableComponent).toBeCloseTo(20000 * 0.85 + 1200, 6); // 18,200
    expect(r.grossRelease).toBeCloseTo(5000 + 17000 + 1200, 6); // 23,200
  });

  it("the 15% concessional remainder is never released", () => {
    const r = fhsssReleaseAmounts({ concessionalBalance: 10000, nonConcessionalBalance: 0, earnings: 0 });
    expect(r.grossRelease).toBeCloseTo(8500, 6); // not 10,000
  });

  it("non-concessional only is entirely tax-free", () => {
    const r = fhsssReleaseAmounts({ concessionalBalance: 0, nonConcessionalBalance: 12000, earnings: 300 });
    expect(r.taxFreeComponent).toBeCloseTo(12000, 6);
    expect(r.taxableComponent).toBeCloseTo(300, 6); // earnings only
  });

  it("zero balances release nothing", () => {
    const r = fhsssReleaseAmounts({ concessionalBalance: 0, nonConcessionalBalance: 0, earnings: 0 });
    expect(r.grossRelease).toBe(0);
  });
});
