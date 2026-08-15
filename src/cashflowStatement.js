// Cashflow statement (Cashflow table: firm row vocabulary and category
// grouping) — pure, no DOM/Plotly. Builds the firm's Cash Flow SOA
// section sums for one plan year from the engine's yearly ledger plus
// the plan's income/expense/deduction rows, so the reconciliation
// between each section's category rows and its own subtotal is a
// committed unit test instead of a manual browser check — see
// outputSeries.js/cashflowCategories.js for the same pattern.
//
// ctx bundles the plain data the caller (main.js) already has:
//   incomeRows, expenseRows, deductionRows   — state.cashflows.*
//   rowTotalsIncome, rowTotalsExpenses,
//   rowTotalsDeductions                      — projection.schedule.rowTotals.*
//   properties                               — state.properties
//   liabilities                               — state.liabilities (for the
//                                              investment-portfolio-interest
//                                              deductible check)
//   superAccounts                             — state.plan.superAccounts
//   y                                          — plan-year index
//
// Disclosed simplification: property interest/expenses/depreciation
// rows are the property module's own GROSS figures (matching the
// property module exactly, so they reconcile trivially) — they are NOT
// adjusted for the negative-gearing quarantine that may reduce the
// USABLE deduction in a loss year; that adjustment already happens
// inside the person-level tax assessment (measured[p].deductions),
// which is what actually drives Taxable Income and every tax row.
//
// Every function here takes an optional forOwner ("client" | "partner"
// | omitted/null) — Document Set Commit 7's Snapshot view needs a
// Client/Partner/Total breakdown of the SAME row vocabulary the
// Cashflow table already shows only as a household Total. A jointly-
// owned property or liability splits 50/50; income/expense/deduction
// rows are never joint (planState.js) so they match their own owner
// exactly. Two figures have no per-person attribution anywhere in the
// ledger at all — Working Cash Account interest (a joint cash buffer)
// and pooled asset cash distributions (summed across every asset
// regardless of owner) — both also split 50/50, a disclosed
// simplification. Client + Partner always reconciles to Total.

import { salarySacrificeCash, personalSuperContributionsCash } from "./cashflowCategories.js";

// forOwner ("client" | "partner" | null) — Document Set Commit 7's
// Snapshot view needs a per-person Client/Partner breakdown alongside
// the household Total every function here already computed; null (the
// default, every pre-Commit-7 call site) means "household", unchanged.
//
// shareOf(itemOwner, forOwner) → the fraction of a possibly-joint item
// (a property, a liability — income/expense/deduction rows are never
// joint, see planState.js's clampIncomeRow/clampExpenseRow) belonging
// to forOwner. A few figures (WCA interest, pooled asset cash
// distributions) have no per-person attribution anywhere in the ledger
// at all — a disclosed 50/50 split for those specifically, applied the
// same way a joint property/liability already splits.
function shareOf(itemOwner, forOwner) {
  if (forOwner == null) return 1;
  if (itemOwner === "joint") return 0.5;
  return itemOwner === forOwner ? 1 : 0;
}

function sumByCategory(rows, rowTotals, category, y, forOwner = null) {
  return rows.filter((r) => r.category === category && (forOwner == null || r.owner === forOwner))
    .reduce((s, r) => s + (rowTotals[r.id]?.[y] ?? 0), 0);
}

// A liability id is property-linked iff it matches "prop-<propertyId>"
// for one of the plan's properties — same convention main.js's
// loanName() already uses.
function isPropertyLoan(lid, properties) {
  return properties.some((p) => `prop-${p.id}` === lid);
}

export function assessableIncome(row, ctx, forOwner = null) {
  const { incomeRows = [], rowTotalsIncome = {}, properties = [], y = 0 } = ctx;
  const byCat = (cat) => sumByCategory(incomeRows, rowTotalsIncome, cat, y, forOwner);
  const investmentProps = properties.filter((p) => p.propertyType === "investment");
  const salary = byCat("salary");
  const taxablePensionComponent = 0; // [zero] — pension phase not modelled
  const otherIncome = byCat("otherIncome");
  const governmentPayments = 0; // [zero] — Centrelink not modelled
  const interestIncome = row.wcaDetail.interest * shareOf("joint", forOwner) + byCat("interestIncome");
  const dividendIncome = row.cashDistributions * shareOf("joint", forOwner) + byCat("dividendIncome");
  const frankingCredits = forOwner == null
    ? (row.taxDetail?.frankingCredits ?? 0)
    : (row.taxDetail?.[forOwner]?.frankingCredits ?? 0);
  const propertyIncomeGross = investmentProps.reduce((s, p) =>
    s + (row.properties?.[p.id]?.rent ?? 0) * shareOf(p.owner, forOwner), 0);
  const trustDistribution = 0; // [zero]
  const foreignIncome = 0; // [zero]
  const netTaxableCapitalGains = forOwner == null
    ? (row.taxDetail?.netCapitalGain ?? 0)
    : (row.taxDetail?.[forOwner]?.netCapitalGain ?? 0);
  const total = salary + taxablePensionComponent + otherIncome + governmentPayments + interestIncome
    + dividendIncome + frankingCredits + propertyIncomeGross + trustDistribution + foreignIncome + netTaxableCapitalGains;
  return {
    salary, taxablePensionComponent, otherIncome, governmentPayments, interestIncome, dividendIncome,
    frankingCredits, propertyIncomeGross, trustDistribution, foreignIncome, netTaxableCapitalGains, total,
  };
}

export function deductionSums(row, ctx, forOwner = null) {
  const { deductionRows = [], rowTotalsDeductions = {}, properties = [], liabilities = [], superAccounts = [], y = 0 } = ctx;
  const byCat = (cat) => sumByCategory(deductionRows, rowTotalsDeductions, cat, y, forOwner);
  const investmentProps = properties.filter((p) => p.propertyType === "investment");
  // Super accounts are never joint (planState.js) — filter to this
  // owner's own accounts, same as every other owner-specific split here.
  const ownerSuperAccounts = forOwner == null ? superAccounts : superAccounts.filter((s) => s.owner === forOwner);

  let propertyInterestDeductions = 0;
  let investmentPortfolioInterest = 0;
  for (const lid of Object.keys(row.liabilities ?? {})) {
    const interest = row.liabilities[lid].interest;
    const liab = liabilities.find((l) => l.id === lid);
    if (isPropertyLoan(lid, properties)) {
      const prop = properties.find((p) => `prop-${p.id}` === lid);
      propertyInterestDeductions += interest * shareOf(prop?.owner, forOwner);
    } else if (liab?.deductible) {
      investmentPortfolioInterest += interest * shareOf(liab.owner, forOwner);
    }
  }
  const propertyDeductions = investmentProps.reduce((s, p) =>
    s + (row.properties?.[p.id]?.expenses ?? 0) * shareOf(p.owner, forOwner), 0);
  const propertyDepreciation = investmentProps.reduce((s, p) =>
    s + (row.properties?.[p.id]?.depreciation ?? 0) * shareOf(p.owner, forOwner), 0);
  const vehicle = byCat("vehicle");
  const socialClub = byCat("socialClub");
  const insurance = byCat("insurance");
  const novatedLease = byCat("novatedLease");
  const workingExpense = byCat("workingExpense");
  const salarySacrifice = salarySacrificeCash(row, ownerSuperAccounts);
  const lumpSumSuperContributions = personalSuperContributionsCash(row, ownerSuperAccounts);
  const salaryPackaging = byCat("salaryPackaging");
  const other = byCat("other");
  const total = investmentPortfolioInterest + propertyInterestDeductions + propertyDeductions + propertyDepreciation
    + vehicle + socialClub + insurance + novatedLease + workingExpense + salarySacrifice + lumpSumSuperContributions
    + salaryPackaging + other;
  return {
    investmentPortfolioInterest, propertyInterestDeductions, propertyDeductions, propertyDepreciation,
    vehicle, socialClub, insurance, novatedLease, workingExpense, salarySacrifice, lumpSumSuperContributions,
    salaryPackaging, other, total,
  };
}

// Signs are chosen so plain addition of every field below reproduces
// "Tax on Taxable Income" exactly: LITO and the franking credit offset
// REDUCE tax, so they're negative; everything else that adds to the
// bill is positive.
export function taxSums(row, forOwner = null) {
  const client = row.taxDetail?.client ?? {};
  const partner = row.taxDetail?.partner ?? {};
  const person = forOwner == null ? null : (row.taxDetail?.[forOwner] ?? {});
  const incomeTax = forOwner == null ? (client.grossTax ?? 0) + (partner.grossTax ?? 0) : (person.grossTax ?? 0);
  const medicareLevy = forOwner == null ? (client.medicare ?? 0) + (partner.medicare ?? 0) : (person.medicare ?? 0);
  // Document Set Commit 2.
  const medicareLevySurcharge = forOwner == null
    ? (row.taxDetail?.medicareLevySurcharge ?? 0)
    : (person.medicareLevySurcharge ?? 0);
  // Document Set Commit 1 — compulsory HELP repayment, assessed per
  // person (row.taxDetail.helpRepayment already sums both for the
  // household total).
  const helpRepayment = forOwner == null ? (row.taxDetail?.helpRepayment ?? 0) : (person.helpRepayment ?? 0);
  const sapto = 0; // [zero]
  const lito = forOwner == null ? -((client.lito ?? 0) + (partner.lito ?? 0)) : -(person.lito ?? 0);
  const spouseSplittingOffset = 0; // [zero]
  const frankingCreditOffset = forOwner == null
    ? -(row.taxDetail?.frankingCredits ?? 0)
    : -(person.frankingCredits ?? 0);
  const taxablePensionOffset = 0; // [zero]
  const div293 = forOwner == null ? (row.taxDetail?.div293 ?? 0) : (person.div293 ?? 0);
  const div296 = forOwner == null ? (row.taxDetail?.div296 ?? 0) : (person.div296 ?? 0);
  const total = incomeTax + medicareLevy + medicareLevySurcharge + helpRepayment + sapto + lito
    + spouseSplittingOffset + frankingCreditOffset + taxablePensionOffset + div293 + div296;
  return {
    incomeTax, medicareLevy, medicareLevySurcharge, helpRepayment, sapto, lito,
    spouseSplittingOffset, frankingCreditOffset, taxablePensionOffset, div293, div296, total,
  };
}

// "Regular take home pay" exists specifically because salary is the
// one income source that's withheld before it reaches the household —
// every other assessable-income row above (Other/Interest/Dividend/
// etc.) is already received in full, so it needs no separate cash-
// received line here.
export function cashReceivedSums(row, ctx, forOwner = null) {
  const { incomeRows = [], rowTotalsIncome = {}, y = 0 } = ctx;
  const byCat = (cat) => sumByCategory(incomeRows, rowTotalsIncome, cat, y, forOwner);
  const client = row.taxDetail?.client ?? {};
  const partner = row.taxDetail?.partner ?? {};
  const paygWithheld = forOwner == null
    ? (client.paygWithheld ?? 0) + (partner.paygWithheld ?? 0)
    : (row.taxDetail?.[forOwner]?.paygWithheld ?? 0);
  const regularTakeHomePay = byCat("salary") - paygWithheld;
  const anticipatedTaxReturn = forOwner == null
    ? (row.taxDetail?.refundSettled ?? 0)
    : (row.taxDetail?.[forOwner]?.refundSettled ?? 0);
  const afterTaxBonus = byCat("afterTaxBonus");
  const otherTaxFreeIncome = byCat("otherTaxFreeIncome");
  const total = regularTakeHomePay + anticipatedTaxReturn + afterTaxBonus + otherTaxFreeIncome;
  return { regularTakeHomePay, anticipatedTaxReturn, afterTaxBonus, otherTaxFreeIncome, total };
}

export function expenseSums(row, ctx, forOwner = null) {
  const { expenseRows = [], rowTotalsExpenses = {}, properties = [], liabilities = [], y = 0 } = ctx;
  const byCat = (cat) => sumByCategory(expenseRows, rowTotalsExpenses, cat, y, forOwner);
  const investmentProps = properties.filter((p) => p.propertyType === "investment");
  let mortgageRepayments = 0, otherLoanRepayments = 0;
  for (const lid of Object.keys(row.liabilities ?? {})) {
    const service = row.liabilities[lid].interest + row.liabilities[lid].principal;
    if (isPropertyLoan(lid, properties)) {
      const prop = properties.find((p) => `prop-${p.id}` === lid);
      mortgageRepayments += service * shareOf(prop?.owner, forOwner);
    } else {
      const liab = liabilities.find((l) => l.id === lid);
      otherLoanRepayments += service * shareOf(liab?.owner, forOwner);
    }
  }
  const nonDiscretionary = byCat("nonDiscretionary");
  const discretionary = byCat("discretionary");
  const groceryFuel = byCat("groceryFuel");
  const holidays = byCat("holidays");
  const insurance = byCat("insurance");
  const investmentPropertyExpenses = investmentProps.reduce((s, p) =>
    s + (row.properties?.[p.id]?.expenses ?? 0) * shareOf(p.owner, forOwner), 0);
  const homeMaintenance = byCat("homeMaintenance");
  const other = byCat("other");
  const total = mortgageRepayments + otherLoanRepayments + nonDiscretionary + discretionary + groceryFuel
    + holidays + insurance + investmentPropertyExpenses + homeMaintenance + other;
  return {
    mortgageRepayments, otherLoanRepayments, nonDiscretionary, discretionary, groceryFuel, holidays,
    insurance, investmentPropertyExpenses, homeMaintenance, other, total,
  };
}

// cashflowStatement(row, ctx) → the full firm-vocabulary breakdown for
// one plan year — assessable/deductions/tax/cashReceived/expenses
// section sums, plus the four running subtotals in the spec's own
// order: Taxable Income = Assessable − Deductions; NET INCOME =
// Taxable Income − Tax on Taxable Income; SURPLUS INCOME = Cash
// received − Total Expenses.
export function cashflowStatement(row, ctx, forOwner = null) {
  const assessable = assessableIncome(row, ctx, forOwner);
  const deductions = deductionSums(row, ctx, forOwner);
  const taxableIncome = assessable.total - deductions.total;
  const tax = taxSums(row, forOwner);
  const netIncome = taxableIncome - tax.total;
  const cashReceived = cashReceivedSums(row, ctx, forOwner);
  const expenses = expenseSums(row, ctx, forOwner);
  const surplusIncome = cashReceived.total - expenses.total;
  return { assessable, deductions, taxableIncome, tax, netIncome, cashReceived, expenses, surplusIncome };
}
