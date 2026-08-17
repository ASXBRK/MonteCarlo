// Demo client: Family with a mortgage — docs/reference/demo-clients.md
// has the walkthrough. Built through the same factories as every other
// demo client (see firstHomeBuyer.js's own header for why).
import { PROFILES } from "../profiles.js";
import {
  defaultState, clampPlan, clampAllToPlan,
  createAsset, createIncomeRow, createExpenseRow, createLiability, createExtraRepayment,
  createSuperAccount, createSuperContribution, createChild, createEducationBlock,
} from "../planState.js";

// Couple, mid-30s, two children, an $850k mortgage split fixed/
// variable, private school from age 12, combined income ~$260k —
// exercises couple tax, children and education funding, fixed-rate
// rollover, salary sacrifice Focus, and the MLS family threshold.
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
  const assets = [savings];

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

  // $850k mortgage, split: $500k fixed (rolls over in 2 years — the
  // rollover this scenario exists to show), $350k variable.
  const fixedPortion = {
    ...createLiability(plan, []), name: "Home loan — fixed portion", type: "mortgage", owner: "joint",
    balance: 500_000, termYears: 25, repayment: "pi", deductible: false,
    rateType: "fixed", fixedRatePct: 5.8, fixedUntil: { kind: "age", age: 37 }, revertRatePct: 6.5,
  };
  const variablePortion = {
    ...createLiability(plan, [fixedPortion]), name: "Home loan — variable portion", type: "mortgage", owner: "joint",
    balance: 350_000, interestRatePct: 6.2, termYears: 25, repayment: "pi", deductible: false,
    rateType: "variable",
  };
  const liabilities = [fixedPortion, variablePortion];

  const superClient = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super — client", balance: 180_000 };
  const superPartner = { ...createSuperAccount(plan, [superClient], PROFILES, "partner"), name: "Super — partner", balance: 120_000 };
  const superAccounts = [superClient, superPartner];

  // Two children: the elder starts private school (Secondary-style
  // fees from age 12) within the first couple of plan years — the
  // education-funding path this client exists to exercise; the
  // younger follows a few years later.
  let planWithSuper = { ...plan, superAccounts };
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

  return { base, plan: planWithSuper, assets, income, expenses, liabilities, superAccounts };
}

// Age N as of `now`, expressed as a DOB — same convention planState.js's
// own synthDob uses (age ticks at 1 July), just anchored to today's
// real date rather than the plan's own start.
function dobForAge(now, age) {
  return `${now.getFullYear() - age}-01-01`;
}

function finalize(base, plan, assets, income, expenses, liabilities, superAccounts, extra = {}) {
  const raw = {
    ...base,
    plan,
    assets,
    cashflows: {
      ...base.cashflows,
      income, expenses, deductions: [], contributions: [], withdrawals: [], lumpSums: [],
      superContributions: extra.superContributions ?? [],
    },
    liabilities,
    properties: [],
    goals: [],
    settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: assets.map((a) => a.id) },
  };
  return clampAllToPlan(raw, PROFILES);
}

function buildCurrent(now) {
  const { base, plan, assets, income, expenses, liabilities, superAccounts } = baseInputs(now);
  return finalize(base, plan, assets, income, expenses, liabilities, superAccounts);
}

function buildSalarySacrifice(now) {
  const { base, plan, assets, income, expenses, liabilities, superAccounts } = baseInputs(now);
  const sacrificeClient = {
    ...createSuperContribution(plan, superAccounts, "client"), label: "Salary sacrifice — client",
    type: "salarySacrifice", basis: "amount", amount: 15_000 / 12, frequency: "monthly",
  };
  const sacrificePartner = {
    ...createSuperContribution(plan, superAccounts, "partner"), label: "Salary sacrifice — partner",
    type: "salarySacrifice", basis: "amount", amount: 15_000 / 12, frequency: "monthly",
  };
  return finalize(base, plan, assets, income, expenses, liabilities, superAccounts, {
    superContributions: [sacrificeClient, sacrificePartner],
  });
}

function buildExtraRepayments(now) {
  const { base, plan, assets, income, expenses, liabilities, superAccounts } = baseInputs(now);
  const [fixedPortion, variablePortion] = liabilities;
  const extra = {
    ...createExtraRepayment(plan, []), label: "Extra repayment", amount: 1_000, frequency: "monthly",
  };
  const withExtra = { ...variablePortion, extraRepayments: [extra] };
  return finalize(base, plan, assets, income, expenses, [fixedPortion, withExtra], superAccounts);
}

export function build(now = new Date()) {
  return {
    name: "Family with a mortgage",
    scenarios: [
      { name: "Current", expectAffordable: true, state: buildCurrent(now) },
      { name: "Salary sacrifice $15k each", expectAffordable: true, state: buildSalarySacrifice(now) },
      { name: "Extra repayments $1k/mo", expectAffordable: true, state: buildExtraRepayments(now) },
    ],
  };
}
