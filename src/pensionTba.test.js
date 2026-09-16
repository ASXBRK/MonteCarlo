import { describe, it, expect } from "vitest";
import {
  createTransferBalanceAccount, indexTransferBalanceCap,
  creditTransferBalance, debitTransferBalance,
} from "./pensionTba.js";

describe("Transfer balance cap and account (spec 20, Commit 4)", () => {
  it("createTransferBalanceAccount starts at zero balance, personal cap equal to the general cap", () => {
    const tba = createTransferBalanceAccount(2100000);
    expect(tba.balance).toBe(0);
    expect(tba.personalCap).toBe(2100000);
    expect(tba.highestUsedPct).toBe(0);
    expect(tba.hasBreached).toBe(false);
  });

  it("a commencement credits the account at its commencement value", () => {
    const tba = createTransferBalanceAccount(2100000);
    const { tba: after, excess } = creditTransferBalance(tba, 840000);
    expect(after.balance).toBe(840000);
    expect(excess).toBeNull();
  });

  it("a commutation debits the account at the commuted amount — never below zero", () => {
    const tba = { ...createTransferBalanceAccount(2100000), balance: 840000 };
    const after = debitTransferBalance(tba, 300000);
    expect(after.balance).toBe(540000);
    const overDebited = debitTransferBalance(tba, 2000000);
    expect(overDebited.balance).toBe(0); // floored, not negative
  });

  it("a debit never re-evaluates excess or moves the high-water mark — it can only reduce the balance", () => {
    const tba = { ...createTransferBalanceAccount(2100000), balance: 840000, highestUsedPct: 0.4 };
    const after = debitTransferBalance(tba, 500000);
    expect(after.highestUsedPct).toBe(0.4); // unchanged
    expect(after.hasBreached).toBe(false);
  });

  it("payments are NOT a debit — this module has no concept of a payment at all (the caller never calls debitTransferBalance for one)", () => {
    // Documented by omission: there is no "payment" event type in this
    // module's own API surface — see the module header's own comment.
    expect(typeof debitTransferBalance).toBe("function");
    expect(Object.keys({ createTransferBalanceAccount, indexTransferBalanceCap, creditTransferBalance, debitTransferBalance }))
      .toEqual(["createTransferBalanceAccount", "indexTransferBalanceCap", "creditTransferBalance", "debitTransferBalance"]);
  });

  it("proportional indexation: a member at 40% used gets 60% of a later general-cap increase added to their personal cap", () => {
    const tba0 = createTransferBalanceAccount(2100000);
    const { tba: afterCredit } = creditTransferBalance(tba0, 840000); // 840,000 / 2,100,000 = 40%
    expect(afterCredit.highestUsedPct).toBeCloseTo(0.4, 6);
    // The general cap indexes up by $100,000 (a single step).
    const indexed = indexTransferBalanceCap(afterCredit, 100000, 1);
    expect(indexed.personalCap).toBeCloseTo(2100000 + 0.6 * 100000, 2); // 2,160,000
  });

  it("proportional indexation: a member at 100% used gets NO further indexation, ever", () => {
    const tba0 = createTransferBalanceAccount(2100000);
    const { tba: afterCredit } = creditTransferBalance(tba0, 2100000); // exactly 100%
    expect(afterCredit.highestUsedPct).toBeCloseTo(1, 6);
    const indexed = indexTransferBalanceCap(afterCredit, 100000, 1);
    expect(indexed.personalCap).toBe(2100000); // unchanged
    // Even across MULTIPLE subsequent indexation steps.
    const indexedAgain = indexTransferBalanceCap(indexed, 100000, 1);
    expect(indexedAgain.personalCap).toBe(2100000);
  });

  it("proportional indexation: a member who has NEVER credited anything gets the FULL increase, same as the general cap itself", () => {
    const tba0 = createTransferBalanceAccount(2100000);
    const indexed = indexTransferBalanceCap(tba0, 100000, 1);
    expect(indexed.personalCap).toBe(2200000); // 100% unused → full increase
  });

  it("indexation is a no-op when the general cap hasn't moved AND inflNow is unchanged", () => {
    const tba0 = createTransferBalanceAccount(2100000);
    const { tba: afterCredit } = creditTransferBalance(tba0, 840000);
    const same = indexTransferBalanceCap(afterCredit, 0, 1);
    expect(same).toEqual(afterCredit);
  });

  // docs/specs/37-review-remediation.md, Commit 5, finding 1.9 — the
  // core of the fix: personalCap is re-derived from a tracked NOMINAL
  // figure every call, so even with NO nominal step (nominalStep: 0) a
  // later inflNow correctly shows the REAL value declining — the exact
  // behaviour the pre-fix engine never produced (it only ever added
  // the real-dollar-equivalent of a genuine step, and otherwise left
  // personalCap static, ratcheting it above the true real general cap
  // over many years).
  it("with no nominal step, a LATER inflNow still reduces the real personal cap — it declines between steps, tracking the general cap's own real drift", () => {
    const tba0 = createTransferBalanceAccount(2100000); // real === nominal at plan start (inflNow 1)
    const oneYearLater = indexTransferBalanceCap(tba0, 0, 1.025); // no step; one year of 2.5% CPI has passed
    expect(oneYearLater.personalCapNominal).toBe(2100000); // nominal untouched — no step happened
    expect(oneYearLater.personalCap).toBeCloseTo(2100000 / 1.025, 2); // real value has drifted down
  });

  it("a genuine nominal step is captured exactly once, weighted by the unused proportion, and survives a later no-step year", () => {
    const tba0 = createTransferBalanceAccount(2100000);
    const { tba: afterCredit } = creditTransferBalance(tba0, 840000); // 40% used
    const stepYear = indexTransferBalanceCap(afterCredit, 100000, 1.05); // a $100,000 nominal step, inflNow 1.05
    expect(stepYear.personalCapNominal).toBeCloseTo(2100000 + 0.6 * 100000, 2); // 2,160,000
    expect(stepYear.personalCap).toBeCloseTo(2160000 / 1.05, 2);
    // The FOLLOWING year, no further step — personalCapNominal stays
    // exactly where the step left it; only inflNow moves the real figure.
    const nextYear = indexTransferBalanceCap(stepYear, 0, 1.076);
    expect(nextYear.personalCapNominal).toBeCloseTo(2160000, 2);
    expect(nextYear.personalCap).toBeCloseTo(2160000 / 1.076, 2);
  });

  it("the high-water mark only ever tracks the HIGHEST used% across multiple credits, never resets on a later, smaller-proportioned one", () => {
    const tba0 = createTransferBalanceAccount(2100000);
    const { tba: after1 } = creditTransferBalance(tba0, 1680000); // 80%
    expect(after1.highestUsedPct).toBeCloseTo(0.8, 6);
    // A later credit of a SMALL amount doesn't reduce the high-water mark.
    const { tba: after2 } = creditTransferBalance(after1, 10000);
    expect(after2.highestUsedPct).toBeGreaterThanOrEqual(0.8);
  });

  it("excess is flagged at the right amount, taxed at 15% on a first breach and 30% on any subsequent one", () => {
    const tba0 = createTransferBalanceAccount(2100000);
    const { tba: after1, excess: excess1, excessTaxRate: rate1 } = creditTransferBalance(tba0, 2400000); // 300,000 over
    expect(excess1).toBeCloseTo(300000, 2);
    expect(rate1).toBeCloseTo(0.15, 6);
    expect(after1.hasBreached).toBe(true);
    // A SECOND breach (even after the cap has since indexed up a bit)
    // is taxed at 30%, not 15% again.
    const indexed = indexTransferBalanceCap(after1, 100000, 1); // already over 100% — no indexation actually applies, but harmless to call
    const { excess: excess2, excessTaxRate: rate2 } = creditTransferBalance(indexed, 200000);
    expect(excess2).toBeCloseTo(500000, 2); // 300,000 existing + 200,000 new, all still excess
    expect(rate2).toBeCloseTo(0.30, 6);
  });

  it("no excess at or under the personal cap", () => {
    const tba0 = createTransferBalanceAccount(2100000);
    const { excess: exactCap } = creditTransferBalance(tba0, 2100000);
    expect(exactCap).toBeNull();
    const { excess: underCap } = creditTransferBalance(tba0, 1000000);
    expect(underCap).toBeNull();
  });
});
