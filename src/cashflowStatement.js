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

import { salarySacrificeCash, personalSuperContributionsCash } from "./cashflowCategories.js";

function sumByCategory(rows, rowTotals, category, y) {
  return rows.filter((r) => r.category === category)
    .reduce((s, r) => s + (rowTotals[r.id]?.[y] ?? 0), 0);
}

// A liability id is property-linked iff it matches "prop-<propertyId>"
// for one of the plan's properties — same convention main.js's
// loanName() already uses.
function isPropertyLoan(lid, properties) {
  return properties.some((p) => `prop-${p.id}` === lid);
}

export function assessableIncome(row, ctx) {
  const { incomeRows = [], rowTotalsIncome = {}, properties = [], y = 0 } = ctx;
  const byCat = (cat) => sumByCategory(incomeRows, rowTotalsIncome, cat, y);
  const investmentProps = properties.filter((p) => p.propertyType === "investment");
  const salary = byCat("salary");
  const taxablePensionComponent = 0; // [zero] — pension phase not modelled
  const otherIncome = byCat("otherIncome");
  const governmentPayments = 0; // [zero] — Centrelink not modelled
  const interestIncome = row.wcaDetail.interest + byCat("interestIncome");
  const dividendIncome = row.cashDistributions + byCat("dividendIncome");
  const frankingCredits = row.taxDetail?.frankingCredits ?? 0;
  const propertyIncomeGross = investmentProps.reduce((s, p) => s + (row.properties?.[p.id]?.rent ?? 0), 0);
  const trustDistribution = 0; // [zero]
  const foreignIncome = 0; // [zero]
  const netTaxableCapitalGains = row.taxDetail?.netCapitalGain ?? 0;
  const total = salary + taxablePensionComponent + otherIncome + governmentPayments + interestIncome
    + dividendIncome + frankingCredits + propertyIncomeGross + trustDistribution + foreignIncome + netTaxableCapitalGains;
  return {
    salary, taxablePensionComponent, otherIncome, governmentPayments, interestIncome, dividendIncome,
    frankingCredits, propertyIncomeGross, trustDistribution, foreignIncome, netTaxableCapitalGains, total,
  };
}

export function deductionSums(row, ctx) {
  const { deductionRows = [], rowTotalsDeductions = {}, properties = [], liabilities = [], superAccounts = [], y = 0 } = ctx;
  const byCat = (cat) => sumByCategory(deductionRows, rowTotalsDeductions, cat, y);
  const investmentProps = properties.filter((p) => p.propertyType === "investment");

  let propertyInterestDeductions = 0;
  let investmentPortfolioInterest = 0;
  for (const lid of Object.keys(row.liabilities ?? {})) {
    const interest = row.liabilities[lid].interest;
    if (isPropertyLoan(lid, properties)) {
      propertyInterestDeductions += interest;
    } else if (liabilities.find((l) => l.id === lid)?.deductible) {
      investmentPortfolioInterest += interest;
    }
  }
  const propertyDeductions = investmentProps.reduce((s, p) => s + (row.properties?.[p.id]?.expenses ?? 0), 0);
  const propertyDepreciation = investmentProps.reduce((s, p) => s + (row.properties?.[p.id]?.depreciation ?? 0), 0);
  const vehicle = byCat("vehicle");
  const socialClub = byCat("socialClub");
  const insurance = byCat("insurance");
  const novatedLease = byCat("novatedLease");
  const workingExpense = byCat("workingExpense");
  const salarySacrifice = salarySacrificeCash(row, superAccounts);
  const lumpSumSuperContributions = personalSuperContributionsCash(row, superAccounts);
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
export function taxSums(row) {
  const client = row.taxDetail?.client ?? {};
  const partner = row.taxDetail?.partner ?? {};
  const incomeTax = (client.grossTax ?? 0) + (partner.grossTax ?? 0);
  const medicareLevy = (client.medicare ?? 0) + (partner.medicare ?? 0);
  const medicareLevySurcharge = 0; // [zero]
  // Document Set Commit 1 — compulsory HELP repayment, assessed per
  // person and summed (row.taxDetail.helpRepayment already sums both).
  const helpRepayment = row.taxDetail?.helpRepayment ?? 0;
  const sapto = 0; // [zero]
  const lito = -((client.lito ?? 0) + (partner.lito ?? 0));
  const spouseSplittingOffset = 0; // [zero]
  const frankingCreditOffset = -(row.taxDetail?.frankingCredits ?? 0);
  const taxablePensionOffset = 0; // [zero]
  const div293 = row.taxDetail?.div293 ?? 0;
  const div296 = row.taxDetail?.div296 ?? 0;
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
export function cashReceivedSums(row, ctx) {
  const { incomeRows = [], rowTotalsIncome = {}, y = 0 } = ctx;
  const byCat = (cat) => sumByCategory(incomeRows, rowTotalsIncome, cat, y);
  const client = row.taxDetail?.client ?? {};
  const partner = row.taxDetail?.partner ?? {};
  const paygWithheldTotal = (client.paygWithheld ?? 0) + (partner.paygWithheld ?? 0);
  const regularTakeHomePay = byCat("salary") - paygWithheldTotal;
  const anticipatedTaxReturn = row.taxDetail?.refundSettled ?? 0;
  const afterTaxBonus = byCat("afterTaxBonus");
  const otherTaxFreeIncome = byCat("otherTaxFreeIncome");
  const total = regularTakeHomePay + anticipatedTaxReturn + afterTaxBonus + otherTaxFreeIncome;
  return { regularTakeHomePay, anticipatedTaxReturn, afterTaxBonus, otherTaxFreeIncome, total };
}

export function expenseSums(row, ctx) {
  const { expenseRows = [], rowTotalsExpenses = {}, properties = [], y = 0 } = ctx;
  const byCat = (cat) => sumByCategory(expenseRows, rowTotalsExpenses, cat, y);
  const investmentProps = properties.filter((p) => p.propertyType === "investment");
  let mortgageRepayments = 0, otherLoanRepayments = 0;
  for (const lid of Object.keys(row.liabilities ?? {})) {
    const service = row.liabilities[lid].interest + row.liabilities[lid].principal;
    if (isPropertyLoan(lid, properties)) mortgageRepayments += service;
    else otherLoanRepayments += service;
  }
  const nonDiscretionary = byCat("nonDiscretionary");
  const discretionary = byCat("discretionary");
  const groceryFuel = byCat("groceryFuel");
  const holidays = byCat("holidays");
  const insurance = byCat("insurance");
  const investmentPropertyExpenses = investmentProps.reduce((s, p) => s + (row.properties?.[p.id]?.expenses ?? 0), 0);
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
export function cashflowStatement(row, ctx) {
  const assessable = assessableIncome(row, ctx);
  const deductions = deductionSums(row, ctx);
  const taxableIncome = assessable.total - deductions.total;
  const tax = taxSums(row);
  const netIncome = taxableIncome - tax.total;
  const cashReceived = cashReceivedSums(row, ctx);
  const expenses = expenseSums(row, ctx);
  const surplusIncome = cashReceived.total - expenses.total;
  return { assessable, deductions, taxableIncome, tax, netIncome, cashReceived, expenses, surplusIncome };
}
