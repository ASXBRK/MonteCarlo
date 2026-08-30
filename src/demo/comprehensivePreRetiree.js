// Demo client: Comprehensive pre-retiree — docs/reference/demo-
// clients.md has the walkthrough. Built through the same factories as
// every other demo client (see firstHomeBuyer.js's own header for why).
//
// Couple, 55 and 53, combined income ~$450k, large (deliberately
// asymmetric) super balances, a negatively geared investment property
// in QLD, an education bond, one defined benefit pension (partner,
// already in payment from an earlier job), Division 293 AND 296
// exposure, death benefit nominations for both, and a residential aged
// care entry late in the projection — exercises the broadest single
// slice of the engine of any demo client. Projected to age 95
// (endBasis fixedAge, not the default LE basis) specifically so the
// aged care entry and 30+ years of pension-phase drawdown both have
// somewhere to land.
//
// Pension-phase design (deliberately kept simple to avoid stacking
// fragile assumptions): "Current" and "Sell the investment property at
// 65" both run income to the household's own "end" anchor rather than
// a retirement age — a disclosed simplification (still working
// indefinitely) that keeps both scenarios trivially affordable without
// needing a pension object at all. "Maximise concessional" adds a
// genuine TTR pension for the client from 60 while they keep working —
// the classic transition-to-retirement strategy, and the ONLY scenario
// that exercises TTR specifically (no earnings-tax exemption, unlike
// an ABP). "Retire at 60" is the one scenario where the client actually
// stops working, at their own retirement-client anchor overridden to
// 60 — a genuine full retirement condition of release, converting to
// an ordinary ABP and crediting the transfer balance account for real.
import { PROFILES } from "../profiles.js";
import {
  defaultState, clampPlan, clampAllToPlan,
  createAsset, createIncomeRow, createExpenseRow, createLiability, createProperty,
  createSuperAccount, createSuperContribution, createPension, createBond,
  createDefinedBenefit, createDeathBenefitBeneficiary, createAgedCareEntry,
} from "../planState.js";

function baseInputs(now) {
  const base = defaultState(PROFILES, now);
  const plan = clampPlan({
    ...base.plan,
    household: "married",
    // No dob spread (see firstHomeBuyer.js's own header on why) — a
    // bare currentAge/retirementAge object lets currentAge win.
    client: {
      currentAge: 55, retirementAge: 65,
      // Death benefits (spec 22, Commit 1) — spouse nominated in full,
      // the factory's own default share for a first beneficiary.
      deathBenefit: { beneficiaries: [createDeathBenefitBeneficiary([])] },
    },
    partner: {
      currentAge: 53, retirementAge: 65,
      deathBenefit: { beneficiaries: [createDeathBenefitBeneficiary([])] },
    },
    // Projected to age 95 (spec's own ask) — a fixed age, not the
    // default life-expectancy basis, so the projection horizon doesn't
    // move if the ABS life tables are ever revised.
    endBasis: { mode: "fixedAge", offset: 0, fixedAge: 95, fixedYears: 40 },
  }, PROFILES);

  const savings = {
    ...createAsset(plan, [], PROFILES), name: "Joint savings & investments", owner: "joint",
    balance: 200_000, allocation: { mode: "profile", profile: "Balanced" },
  };
  const assets = [savings];

  // Combined ~$450k. Working indefinitely (to "end", not a retirement
  // anchor) in this base — see the module header on why; "Retire at
  // 60" overrides the client's own cutoff explicitly.
  const clientSalary = {
    ...createIncomeRow(plan, []), label: "Salary — client", category: "salary", incomeType: "employment",
    owner: "client", amount: 280_000 / 12, frequency: "monthly", sgApplies: true,
    to: { kind: "anchor", anchorId: "end" },
  };
  const partnerSalary = {
    ...createIncomeRow(plan, []), label: "Salary — partner", category: "salary", incomeType: "employment",
    owner: "partner", amount: 170_000 / 12, frequency: "monthly", sgApplies: true,
    to: { kind: "anchor", anchorId: "end" },
  };
  const income = [clientSalary, partnerSalary];

  const living = {
    ...createExpenseRow(plan, []), label: "Household living expenses", category: "discretionary",
    amount: 130_000 / 12, frequency: "monthly",
  };
  const expenses = [living];

  // Negatively geared investment property in QLD — deliberately a
  // third state (A is WA, B is VIC) so the three property-owning demo
  // clients between them exercise three different stamp duty/land tax
  // schedules, not the same one three times over.
  const invLoan = {
    ...createLiability(plan, []), name: "Investment property loan", type: "investment", owner: "joint",
    balance: 500_000, interestRatePct: 6.0, termYears: 25, repayment: "io", ioYears: 5, deductiblePct: 100,
    rateType: "variable",
  };
  const liabilities = [invLoan];
  const investmentProperty = {
    ...createProperty(plan, [], 5), name: "Investment property", owner: "joint", state: "QLD",
    propertyType: "investment", status: "owned",
    currentValue: 780_000, costBase: 750_000, acquisitionDate: "2018-11-01",
    linkedAssetId: invLoan.id,
    rent: { amount: 28_000, indexBasis: "cpi", indexExtraPct: 0 },
    expenses: { amount: 5_000, indexBasis: "cpi", indexExtraPct: 0 },
    expensesDeductible: true, depreciation: 4_000,
    // Property sale (spec 19 Commit 4) — the "Sell the investment
    // property at 65" scenario turns this on; every other scenario
    // leaves it disabled (the regression-neutral default).
    sale: {
      enabled: false, at: { kind: "age", age: 65 }, agentFeesPct: 2.5, settlementCosts: 5000,
      proceedsDestination: "repayLoanThenAsset", assetId: savings.id,
    },
  };
  const properties = [investmentProperty];

  // Deliberately asymmetric — the client's balance clears the $500k
  // total-super-balance threshold (carry-forward unused concessional
  // cap is unavailable to them, realistically) and is itself "large"
  // enough to trigger Division 296; the partner's does not, so
  // carry-forward IS available to them. Not asserted around — the
  // engine's own eligibility rule does this, not the demo (same
  // pattern the old High earner pre-retirement demo established).
  const superClient = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super — client", balance: 3_200_000 };
  const superPartner = { ...createSuperAccount(plan, [superClient], PROFILES, "partner"), name: "Super — partner", balance: 420_000 };
  const superAccounts = [superClient, superPartner];

  // One defined benefit pension (spec 26) — the partner's, from an
  // earlier public-sector job, already in payment. A defined benefit's
  // own commenceAt is resolved against the CLIENT's age regardless of
  // whose pension it is (this engine's own locked convention — see
  // main.js's own dateRefControlHTML call for it) — age 56 is the
  // CLIENT's age one plan year in, the first FULL FY this projection
  // has (year 0 is a partial first year with no July to fire an
  // annual event in, whatever "now" happens to be — the same
  // convention every other age-anchored one-off/annual event in this
  // engine follows). Using the partner's own current age here (53,
  // already behind the client's 55) would resolve to year 0 and — with
  // no July inside a partial first year — silently never fire at all;
  // caught by this file's own sanity check, not asserted around.
  const definedBenefit = {
    ...createDefinedBenefit(plan, [], "partner"), name: "Defined benefit — partner",
    commenceAt: { kind: "age", age: 56 }, annualPension: 15_000,
    taxFreeProportion: 20, untaxedProportion: 30,
  };
  const definedBenefits = [definedBenefit];

  // An education bond (spec 25) — no linked child (this couple has
  // none) so it never funds a real fee; present specifically to
  // exercise the bond engine's OWN "education" tax treatment on
  // withdrawal, distinct from a plain investment bond (BOND_TYPES'
  // other member), which no other demo client holds.
  const educationBond = {
    ...createBond(plan, [], PROFILES), name: "Education bond", type: "education", owner: "joint",
    balance: 50_000, allocation: { mode: "profile", profile: "Balanced" },
  };
  const bonds = [educationBond];

  // Aged care (spec 29) — the client enters residential care late,
  // at 88 (33 years into the projection); the partner (86 by then)
  // remains in the family home, the protected-person exemption this
  // field exists to model.
  const agedCareEntry = {
    ...createAgedCareEntry(plan, [], "client"), name: "Aged care — client",
    entryAt: { kind: "age", age: 88 }, facility: "Riverside Aged Care",
    accommodationPrice: 700_000, paymentMethod: "combination", radAmount: 350_000,
    extraServiceFeesAnnual: 6_000, formerHomeOccupiedByProtectedPerson: true,
  };
  const agedCare = [agedCareEntry];

  const planFull = { ...plan, superAccounts, definedBenefits, agedCare };
  return { base, plan: planFull, assets, income, expenses, liabilities, properties, superAccounts, bonds };
}

function finalize(base, plan, assets, income, expenses, liabilities, properties, superAccounts, bonds, extra = {}) {
  const raw = {
    ...base,
    plan,
    assets,
    bonds,
    cashflows: {
      ...base.cashflows,
      income, expenses, deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: extra.superContributions ?? [],
    },
    liabilities,
    properties,
    goals: [],
    settings: {
      surplus: { periods: [{
        id: "sp-demo", from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
        payNonDeductibleDebtFirst: false, debtOrder: "interestRate", allocations: [], remainderTo: "cash",
      }] },
      fundingOrder: assets.map((a) => a.id),
      deficit: { minimumBalances: {}, sellRule: "order" },
    },
  };
  return clampAllToPlan(raw, PROFILES);
}

function buildCurrent(now) {
  const { base, plan, assets, income, expenses, liabilities, properties, superAccounts, bonds } = baseInputs(now);
  return finalize(base, plan, assets, income, expenses, liabilities, properties, superAccounts, bonds);
}

// TTR from 60 while still working (the client never stops — see the
// module header) plus both maximising concessional contributions —
// for the partner (under the $500k total-super-balance test) this
// includes catching up on unused prior-year cap; for the client it's
// this year's cap only.
function buildMaximiseConcessional(now) {
  const { base, plan, assets, income, expenses, liabilities, properties, superAccounts, bonds } = baseInputs(now);
  const clientCap = {
    ...createSuperContribution(plan, superAccounts, "client"), label: "Concessional — client",
    type: "salarySacrifice", basis: "toConcessionalCap", frequency: "annual",
  };
  const partnerCap = {
    ...createSuperContribution(plan, superAccounts, "partner"), label: "Concessional — partner (incl. carry-forward)",
    type: "salarySacrifice", basis: "toConcessionalCap", frequency: "annual",
  };
  const superClient = superAccounts.find((s) => s.owner === "client");
  const ttr = {
    ...createPension(plan, [], superAccounts, "client"), name: "TTR — client",
    sourceAccountId: superClient.id, commenceAt: { kind: "age", age: 60 },
    type: "ttr", drawdownOption: "minimum",
  };
  const planWithTtr = { ...plan, pensions: [ttr] };
  return finalize(base, planWithTtr, assets, income, expenses, liabilities, properties, superAccounts, bonds, {
    superContributions: [clientCap, partnerCap],
  });
}

// The client actually retires at 60 (retirementAge overridden — see
// the module header on why this alone is enough to move BOTH the
// income cutoff and the pension's own commencement, since both anchor
// to "retirement-client"), converting to a genuine ABP: a real
// retirement condition of release met at/after preservation age, not
// merely the unconditional age-65 rule. The partner keeps working
// unchanged (still anchored to "end").
function buildRetireAt60(now) {
  const { base, plan, assets, income, expenses, liabilities, properties, superAccounts, bonds } = baseInputs(now);
  const planEarlyRetirement = { ...plan, client: { ...plan.client, retirementAge: 60 } };
  const [clientSalary, partnerSalary] = income;
  const retiringIncome = [
    { ...clientSalary, to: { kind: "anchor", anchorId: "retirement-client" } }, // now resolves to 60
    partnerSalary,
  ];
  const superClient = superAccounts.find((s) => s.owner === "client");
  const abp = {
    ...createPension(plan, [], superAccounts, "client"), name: "Account-based pension — client",
    sourceAccountId: superClient.id, commenceAt: { kind: "anchor", anchorId: "retirement-client" },
    type: "abp", drawdownOption: "minimum",
  };
  const planWithPension = { ...planEarlyRetirement, pensions: [abp] };
  return finalize(base, planWithPension, assets, retiringIncome, expenses, liabilities, properties, superAccounts, bonds);
}

function buildSellInvestmentPropertyAt65(now) {
  const { base, plan, assets, income, expenses, liabilities, properties, superAccounts, bonds } = baseInputs(now);
  const [investmentProperty] = properties;
  const sold = { ...investmentProperty, sale: { ...investmentProperty.sale, enabled: true } };
  return finalize(base, plan, assets, income, expenses, liabilities, [sold], superAccounts, bonds);
}

export function build(now = new Date()) {
  return {
    name: "Comprehensive pre-retiree",
    scenarios: [
      { name: "Current", expectAffordable: true, state: buildCurrent(now) },
      { name: "Maximise concessional", expectAffordable: true, state: buildMaximiseConcessional(now) },
      { name: "Retire at 60", expectAffordable: true, state: buildRetireAt60(now) },
      { name: "Sell the investment property at 65", expectAffordable: true, state: buildSellInvestmentPropertyAt65(now) },
    ],
  };
}
