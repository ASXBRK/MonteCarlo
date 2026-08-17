// Demo client: High earner pre-retirement — docs/reference/demo-
// clients.md has the walkthrough. Built through the same factories as
// every other demo client (see firstHomeBuyer.js's own header for why).
import { PROFILES } from "../profiles.js";
import {
  defaultState, clampPlan, clampAllToPlan,
  createAsset, createIncomeRow, createExpenseRow, createLiability, createProperty,
  createSuperAccount, createSuperContribution,
} from "../planState.js";

// Couple, early 50s, ~$450k combined income, large (asymmetric) super
// balances, a negatively-geared investment property, Division 293
// exposure — exercises Division 293/296, carry-forward (available to
// the lower-balance partner, blocked for the higher — the $500k
// eligibility rule doing real work, not asserted around), negative
// gearing, the income-interruption what-if, and retirement drawdown.
function baseInputs(now) {
  const base = defaultState(PROFILES, now);
  const plan = clampPlan({
    ...base.plan,
    household: "married",
    // No `...base.plan.client` spread: defaultState's default client carries
    // a real dob string, and clampPerson derives currentAge from dob when
    // present, silently overriding an explicit currentAge alongside it.
    client: { currentAge: 52, retirementAge: 65 },
    partner: { currentAge: 50, retirementAge: 65 },
  }, PROFILES);

  const savings = {
    ...createAsset(plan, [], PROFILES), name: "Joint savings & investments", owner: "joint",
    balance: 150_000, allocation: { mode: "profile", profile: "Balanced" },
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
    owner: "client", amount: 270_000 / 12, frequency: "monthly", sgApplies: true,
  };
  const partnerSalary = {
    ...createIncomeRow(plan, []), label: "Salary — partner", category: "salary", incomeType: "employment",
    owner: "partner", amount: 180_000 / 12, frequency: "monthly", sgApplies: true,
    to: { kind: "anchor", anchorId: "retirement-partner" },
  };
  const income = [clientSalary, partnerSalary];

  const living = {
    ...createExpenseRow(plan, []), label: "Household living expenses", category: "discretionary",
    amount: 110_000 / 12, frequency: "monthly",
  };
  const expenses = [living];

  // Negatively geared investment property: rent doesn't cover interest
  // + expenses, so it throws off a deductible loss against the
  // couple's other (high) income — the point of the feature.
  const invLoan = {
    ...createLiability(plan, []), name: "Investment property loan", type: "investment", owner: "joint",
    balance: 600_000, interestRatePct: 6.0, termYears: 25, repayment: "io", ioYears: 5, deductible: true,
    rateType: "variable",
  };
  const liabilities = [invLoan];
  const investmentProperty = {
    ...createProperty(plan, [], 5), name: "Investment property", owner: "joint", state: "VIC",
    propertyType: "investment", status: "owned",
    currentValue: 800_000, costBase: 780_000, acquisitionDate: "2019-03-01",
    linkedAssetId: invLoan.id,
    rent: { amount: 30_000, indexBasis: "cpi", indexExtraPct: 0 },
    expenses: { amount: 6_000, indexBasis: "cpi", indexExtraPct: 0 },
    expensesDeductible: true, depreciation: 3_000,
  };
  const properties = [investmentProperty];

  // Client's balance clears the $500k total-super-balance threshold —
  // carry-forward unused cap is unavailable to them, realistically;
  // the partner's does not, so it's available to them. Not asserted
  // around — the engine's own eligibility rule does this, not the demo.
  const superClient = { ...createSuperAccount(plan, [], PROFILES, "client"), name: "Super — client", balance: 650_000 };
  const superPartner = { ...createSuperAccount(plan, [superClient], PROFILES, "partner"), name: "Super — partner", balance: 380_000 };
  const superAccounts = [superClient, superPartner];

  return { base, plan: { ...plan, superAccounts }, assets, income, expenses, liabilities, properties, superAccounts };
}

function finalize(base, plan, assets, income, expenses, liabilities, properties, superAccounts, extra = {}) {
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
    properties,
    goals: [],
    settings: { surplus: { mode: "accumulate", assetId: null }, fundingOrder: assets.map((a) => a.id) },
  };
  return clampAllToPlan(raw, PROFILES);
}

function buildCurrent(now) {
  const { base, plan, assets, income, expenses, liabilities, properties, superAccounts } = baseInputs(now);
  return finalize(base, plan, assets, income, expenses, liabilities, properties, superAccounts);
}

// Both maximise concessional contributions — for the partner (under
// the $500k total-super-balance test) this includes catching up on
// unused prior-year cap; for the client it's this year's cap only.
function buildMaximiseConcessional(now) {
  const { base, plan, assets, income, expenses, liabilities, properties, superAccounts } = baseInputs(now);
  const clientCap = {
    ...createSuperContribution(plan, superAccounts, "client"), label: "Concessional — client",
    type: "salarySacrifice", basis: "toConcessionalCap", frequency: "annual",
  };
  const partnerCap = {
    ...createSuperContribution(plan, superAccounts, "partner"), label: "Concessional — partner (incl. carry-forward)",
    type: "salarySacrifice", basis: "toConcessionalCap", frequency: "annual",
  };
  return finalize(base, plan, assets, income, expenses, liabilities, properties, superAccounts, {
    superContributions: [clientCap, partnerCap],
  });
}

// The client steps down to part-time/consulting work from 58, ahead of
// full retirement at 65 — a real wind-down, not guaranteed to be fully
// funded from cash flow alone at this household's spend rate, which is
// why this is the one scenario allowed to show unfunded cashflow.
function buildReduceWorkAt58(now) {
  const { base, plan, assets, income, expenses, liabilities, properties, superAccounts } = baseInputs(now);
  const [clientSalary, partnerSalary] = income;
  const reducedIncome = [
    { ...clientSalary, to: { kind: "age", age: 57 } },
    { ...clientSalary, id: `${clientSalary.id}-reduced`, label: "Salary — client (reduced)", amount: 60_000 / 12, from: { kind: "age", age: 58 } },
    partnerSalary,
  ];
  return finalize(base, plan, assets, reducedIncome, expenses, liabilities, properties, superAccounts);
}

export function build(now = new Date()) {
  return {
    name: "High earner pre-retirement",
    scenarios: [
      { name: "Current", expectAffordable: true, state: buildCurrent(now) },
      { name: "Maximise concessional", expectAffordable: true, state: buildMaximiseConcessional(now) },
      { name: "Reduce work at 58", expectAffordable: false, state: buildReduceWorkAt58(now) },
    ],
  };
}
