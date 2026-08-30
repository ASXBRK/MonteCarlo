// Demo client: Family with a mortgage — docs/reference/demo-clients.md
// has the walkthrough. Built through the same factories as every other
// demo client (see firstHomeBuyer.js's own header for why).
import { PROFILES } from "../profiles.js";
import {
  defaultState, clampPlan, clampAllToPlan,
  createAsset, createIncomeRow, createExpenseRow, createDeductionRow, createLiability, createExtraRepayment,
  createSuperAccount, createSuperContribution, createChild, createEducationBlock,
  createProperty, createGoal, createEmployer,
} from "../planState.js";

// Couple, mid-30s, two children, an $850k mortgage split fixed/
// variable, private school from age 12, combined income ~$260k, an
// investment property that clears VIC's own (low) land tax threshold,
// a travel goal, and salary packaging through the partner's FBT-exempt
// employer — exercises couple tax, children and education funding,
// fixed-rate rollover, salary sacrifice/salary packaging, the MLS
// family threshold, negative gearing, goals, and debt recycling.
function baseInputs(now) {
  const base = defaultState(PROFILES, now);
  const plan = clampPlan({
    ...base.plan,
    household: "married",
    // No `...base.plan.client` spread: defaultState's default client carries
    // a real dob string, and clampPerson derives currentAge from dob when
    // present, silently overriding an explicit currentAge alongside it.
    client: { currentAge: 35, retirementAge: 65, privateHospitalCover: false },
    partner: { currentAge: 34, retirementAge: 65, privateHospitalCover: false },
  }, PROFILES);

  const savings = {
    ...createAsset(plan, [], PROFILES), name: "Joint savings", owner: "joint",
    balance: 40_000, cgtAsset: false, costBase: null,
    allocation: { mode: "profile", profile: "Defensive" },
  };
  // A separate investment portfolio — starts empty; it's the debt-
  // recycling scenario's own redraw destination (a recycled dollar
  // needs somewhere to land that isn't the offset it just came out
  // of). Present in every scenario (not just Debt recycling) so the
  // asset id is stable across scenario variants of the SAME base plan.
  const investPortfolio = {
    ...createAsset(plan, [savings], PROFILES), name: "Investment portfolio", owner: "joint",
    balance: 0, allocation: { mode: "profile", profile: "Balanced" },
  };
  const assets = [savings, investPortfolio];

  // Monthly, not annual: an annual-frequency row fires once, in July
  // (see schedule.js's applyRegular) — a demo client anchored to
  // whatever day it's loaded almost always starts partway through a
  // FY, so an annual row would silently contribute nothing in year
  // one. Monthly is also just how a salary/living expense actually
  // arrives.
  const clientSalary = {
    ...createIncomeRow(plan, []), label: "Salary — client", category: "salary", incomeType: "employment",
    owner: "client", amount: 150_000 / 12, frequency: "monthly", sgApplies: true,
  };
  const partnerSalary = {
    ...createIncomeRow(plan, []), label: "Salary — partner", category: "salary", incomeType: "employment",
    owner: "partner", amount: 110_000 / 12, frequency: "monthly", sgApplies: true,
    to: { kind: "anchor", anchorId: "retirement-partner" },
  };
  const income = [clientSalary, partnerSalary];

  const living = {
    ...createExpenseRow(plan, []), label: "Household living expenses", category: "nonDiscretionary",
    amount: 65_000 / 12, frequency: "monthly",
  };
  const expenses = [living];

  // Salary packaging (spec 23, Commit 3) — the partner works for a
  // public hospital (FBT-exempt employer), packaging living expenses
  // up to the real capped-benefit threshold. Genuinely worthwhile
  // (unlike packaging through a "standard" employer, which just pays
  // the FBT in full) — the point of putting it on an fbtExempt
  // employer specifically.
  const partnerEmployer = {
    ...createEmployer(plan, [], "partner"), name: "St Luke's Hospital", nameIsDefault: false,
    fbtType: "fbtExempt", fbtTypeIsDefault: false,
    fbtCaps: { livingExpenseCap: 15_900, mealEntertainmentCap: 0, rebatePct: 0 },
  };
  const employers = [partnerEmployer];
  const packaging = {
    ...createDeductionRow(plan, []), label: "Salary packaging — living expenses", category: "salaryPackaging",
    owner: "partner", amount: 12_000 / 12, frequency: "monthly",
    employerId: partnerEmployer.id, packagingType: "livingExpense",
  };
  const deductions = [packaging];

  // $850k mortgage, split: $500k fixed (rolls over in 2 years — the
  // rollover this scenario exists to show), $350k variable.
  const fixedPortion = {
    ...createLiability(plan, []), name: "Home loan — fixed portion", type: "mortgage", owner: "joint",
    balance: 500_000, termYears: 25, repayment: "pi", deductiblePct: 0,
    rateType: "fixed", fixedRatePct: 5.8, fixedUntil: { kind: "age", age: 37 }, revertRatePct: 6.5,
  };
  const variablePortion = {
    ...createLiability(plan, [fixedPortion]), name: "Home loan — variable portion", type: "mortgage", owner: "joint",
    balance: 350_000, interestRatePct: 6.2, termYears: 25, repayment: "pi", deductiblePct: 0,
    rateType: "variable",
  };
  const liabilities = [fixedPortion, variablePortion];

  // Investment property in VIC, deliberately — VIC's own land tax
  // threshold is $50,000 of land value (NSW's is $1,075,000; this
  // property's land value would clear NSW's threshold too, but VIC
  // guarantees land tax fires at an entirely ordinary investment-
  // property price, not an implausibly large one). Negatively geared:
  // rent doesn't cover interest + expenses, so it throws off a
  // deductible loss against the couple's other income.
  const investLoan = {
    ...createLiability(plan, [fixedPortion, variablePortion]), name: "Investment property loan", type: "investment", owner: "joint",
    balance: 440_000, interestRatePct: 6.1, termYears: 25, repayment: "io", ioYears: 5, deductiblePct: 100,
    rateType: "variable",
  };
  const investmentProperty = {
    ...createProperty(plan, [], 4), name: "Investment property", owner: "joint", state: "VIC",
    propertyType: "investment", status: "owned",
    currentValue: 550_000, costBase: 530_000, acquisitionDate: "2021-06-01",
    linkedAssetId: investLoan.id,
    rent: { amount: 24_000, indexBasis: "cpi", indexExtraPct: 0 },
    expenses: { amount: 4_500, indexBasis: "cpi", indexExtraPct: 0 },
    expensesDeductible: true, depreciation: 2_500,
  };
  const properties = [investmentProperty];

  const superClient = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super — client", balance: 180_000 };
  const superPartner = { ...createSuperAccount(plan, [superClient], PROFILES, "partner"), name: "Super — partner", balance: 120_000 };
  const superAccounts = [superClient, superPartner];

  // A travel goal — funded from surplus, the default fundedFrom, same
  // as the firm's own template treats a lifestyle goal that isn't
  // earmarked against one specific asset.
  const travelGoal = {
    ...createGoal(plan, []), label: "Family overseas trip", targetAmount: 18_000,
    targetAt: { kind: "age", age: 40 },
  };
  const goals = [travelGoal];

  // Two children: the elder starts private school (Secondary-style
  // fees from age 12) within the first couple of plan years — the
  // education-funding path this client exists to exercise; the
  // younger follows a few years later.
  let planWithSuper = { ...plan, superAccounts, employers };
  const elder = { ...createChild([], planWithSuper), name: "Child 1", dateOfBirth: dobForAge(now, 11) };
  const younger = { ...createChild([elder], planWithSuper), name: "Child 2", dateOfBirth: dobForAge(now, 8) };
  const educationElder = {
    ...createEducationBlock([]), label: "Private school", annualAmount: 22_000,
    fromAge: 12, toAge: 18, indexBasis: "cpi", indexExtraPct: 2.0,
  };
  const educationYounger = {
    ...createEducationBlock([]), label: "Private school", annualAmount: 22_000,
    fromAge: 12, toAge: 18, indexBasis: "cpi", indexExtraPct: 2.0,
  };
  const children = [
    { ...elder, education: [educationElder] },
    { ...younger, education: [educationYounger] },
  ];
  planWithSuper = { ...planWithSuper, children };

  return {
    base, plan: planWithSuper, assets, income, expenses, deductions,
    liabilities: [...liabilities, investLoan], properties, superAccounts, goals,
  };
}

// Age N as of `now`, expressed as a DOB — same convention planState.js's
// own synthDob uses (age ticks at 1 July), just anchored to today's
// real date rather than the plan's own start.
function dobForAge(now, age) {
  return `${now.getFullYear() - age}-01-01`;
}

function finalize(base, plan, assets, income, expenses, deductions, liabilities, properties, superAccounts, goals, extra = {}) {
  const raw = {
    ...base,
    plan,
    assets,
    cashflows: {
      ...base.cashflows,
      income, expenses, deductions, contributions: [], withdrawals: [], lumpSums: [],
      superContributions: extra.superContributions ?? [],
    },
    liabilities,
    properties,
    goals,
    // Surplus/deficit allocation spec, Commit 1: settings.surplus is now
    // a list of periods, not {mode, assetId} — a single period covering
    // the whole projection with no allocations and remainderTo "cash"
    // reproduces this demo's original "accumulate" intent exactly.
    // payNonDeductibleDebtFirst is off, same reasoning the v16->v17
    // migration uses for an existing scenario: this fixture's numbers
    // were built and are tested against the neutral behaviour, not the
    // new default (a future demo could turn it on deliberately, to
    // actually showcase the feature).
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
  const { base, plan, assets, income, expenses, deductions, liabilities, properties, superAccounts, goals } = baseInputs(now);
  return finalize(base, plan, assets, income, expenses, deductions, liabilities, properties, superAccounts, goals);
}

function buildSalarySacrifice(now) {
  const { base, plan, assets, income, expenses, deductions, liabilities, properties, superAccounts, goals } = baseInputs(now);
  const sacrificeClient = {
    ...createSuperContribution(plan, superAccounts, "client"), label: "Salary sacrifice — client",
    type: "salarySacrifice", basis: "amount", amount: 15_000 / 12, frequency: "monthly",
  };
  const sacrificePartner = {
    ...createSuperContribution(plan, superAccounts, "partner"), label: "Salary sacrifice — partner",
    type: "salarySacrifice", basis: "amount", amount: 15_000 / 12, frequency: "monthly",
  };
  return finalize(base, plan, assets, income, expenses, deductions, liabilities, properties, superAccounts, goals, {
    superContributions: [sacrificeClient, sacrificePartner],
  });
}

function buildExtraRepayments(now) {
  const { base, plan, assets, income, expenses, deductions, liabilities, properties, superAccounts, goals } = baseInputs(now);
  const [fixedPortion, variablePortion, investLoan] = liabilities;
  const extra = {
    ...createExtraRepayment(plan, []), label: "Extra repayment", amount: 1_000, frequency: "monthly",
  };
  const withExtra = { ...variablePortion, extraRepayments: [extra] };
  return finalize(base, plan, assets, income, expenses, deductions, [fixedPortion, withExtra, investLoan], properties, superAccounts, goals);
}

// Debt recycling (spec 24, Commit 2): surplus pays down the NON-
// DEDUCTIBLE variable portion of the home loan; an equal amount is
// redrawn into the investment portfolio asset created in baseInputs —
// total debt is unchanged, but a growing SHARE of it becomes
// deductible over time, exactly the point of the strategy.
function buildDebtRecycling(now) {
  const { base, plan, assets, income, expenses, deductions, liabilities, properties, superAccounts, goals } = baseInputs(now);
  const [fixedPortion, variablePortion, investLoan] = liabilities;
  const investPortfolio = assets.find((a) => a.name === "Investment portfolio");
  const recycled = {
    ...variablePortion,
    recycling: {
      enabled: true,
      from: { kind: "anchor", anchorId: "start" }, to: { kind: "anchor", anchorId: "end" },
      destinationAssetId: investPortfolio.id, matchRepayments: true, annualCap: null,
    },
  };
  return finalize(base, plan, assets, income, expenses, deductions, [fixedPortion, recycled, investLoan], properties, superAccounts, goals);
}

export function build(now = new Date()) {
  return {
    name: "Family with a mortgage",
    scenarios: [
      { name: "Current", expectAffordable: true, state: buildCurrent(now) },
      { name: "Salary sacrifice $15k each", expectAffordable: true, state: buildSalarySacrifice(now) },
      { name: "Extra repayments $1k/mo", expectAffordable: true, state: buildExtraRepayments(now) },
      { name: "Debt recycling", expectAffordable: true, state: buildDebtRecycling(now) },
    ],
  };
}
