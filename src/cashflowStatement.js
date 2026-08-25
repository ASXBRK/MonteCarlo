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

// Adjustment rows (spec 18) — row.adjustments (deterministic.js) is the
// resolved, per-FY amount for every adjustment active this year,
// already tagged with its own target/owner; this just sums the ones
// matching `target` for forOwner, same shareOf() convention as every
// other figure here ("household"-owned targets — only `expenses` — are
// treated as "joint": split 50/50 for a specific person, in full for
// the consolidated/null case, exactly like WCA interest above).
function adjustmentSum(row, target, forOwner) {
  return (row.adjustments ?? [])
    .filter((a) => a.target === target)
    .reduce((s, a) => s + a.amount * shareOf(a.owner === "household" ? "joint" : a.owner, forOwner), 0);
}

// A liability id is property-linked iff it matches "prop-<propertyId>"
// for one of the plan's properties — same convention main.js's
// loanName() already uses.
function isPropertyLoan(lid, properties) {
  return properties.some((p) => `prop-${p.id}` === lid);
}

// HELP-as-liability follow-up fix: help_<person> entries in row.liabilities
// are NOT ordinary loans (deterministic.js) — no interest rate, no
// repayment schedule of their own, and not in state.liabilities at all
// (so `liabilities.find(...)` below would silently return undefined for
// one). Their cash impact is already reported per-owner via taxSums()'s
// own helpRepayment figure (row.taxDetail.<owner>.helpRepayment) — folding
// them into otherLoanRepayments here too would double-count the same
// dollar as both a tax line and an expense line.
function isHelpLiability(lid) {
  return lid === "help_client" || lid === "help_partner";
}

export function assessableIncome(row, ctx, forOwner = null) {
  const { incomeRows = [], rowTotalsIncome = {}, properties = [], y = 0 } = ctx;
  const byCat = (cat) => sumByCategory(incomeRows, rowTotalsIncome, cat, y, forOwner);
  const investmentProps = properties.filter((p) => p.propertyType === "investment");
  const salary = byCat("salary");
  // Pension phase (spec 20, Commit 2/5) — the taxable component of a
  // pre-60 TTR payment, assessable at marginal rates. Always 0 in this
  // build's own reachable states (every payment is post-60 — see
  // deterministic.js's acc[p] header) but wired for genuine
  // correctness, same "sum across both owners, or read one" shape
  // every other per-person taxDetail figure here already uses.
  const taxablePensionComponent = forOwner == null
    ? (row.taxDetail?.client?.taxablePensionComponent ?? 0) + (row.taxDetail?.partner?.taxablePensionComponent ?? 0)
    : (row.taxDetail?.[forOwner]?.taxablePensionComponent ?? 0);
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
  const computedTotal = salary + taxablePensionComponent + otherIncome + governmentPayments + interestIncome
    + dividendIncome + frankingCredits + propertyIncomeGross + trustDistribution + foreignIncome + netTaxableCapitalGains;
  // Adjustment rows (spec 18) — an "income.assessable" adjustment is a
  // leak-free income term (the registry's own description), so it folds
  // straight into the section total; `computedTotal` (pre-adjustment) is
  // kept alongside `total` (post-adjustment) so the Cashflow table's
  // Commit 2 Computed/Adjustment/Total sub-rows can show all three
  // without re-deriving one from another.
  const adjAssessable = adjustmentSum(row, "income.assessable", forOwner);
  const total = computedTotal + adjAssessable;
  return {
    salary, taxablePensionComponent, otherIncome, governmentPayments, interestIncome, dividendIncome,
    frankingCredits, propertyIncomeGross, trustDistribution, foreignIncome, netTaxableCapitalGains,
    computedTotal, adjAssessable, total,
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
    if (isHelpLiability(lid)) continue; // see isHelpLiability's header
    const interest = row.liabilities[lid].interest;
    const liab = liabilities.find((l) => l.id === lid);
    if (isPropertyLoan(lid, properties)) {
      const prop = properties.find((p) => `prop-${p.id}` === lid);
      propertyInterestDeductions += interest * shareOf(prop?.owner, forOwner);
    } else if (liab) {
      // Surplus/deficit allocation spec, Commit 1: deductiblePct
      // replaces the old boolean — a part-deductible loan reports only
      // its deductible proportion here, same as the tax assessment.
      const frac = typeof liab.deductiblePct === "number" ? liab.deductiblePct / 100 : (liab.deductible === true ? 1 : 0);
      if (frac > 0) investmentPortfolioInterest += interest * frac * shareOf(liab.owner, forOwner);
    }
  }
  const propertyDeductions = investmentProps.reduce((s, p) =>
    s + (row.properties?.[p.id]?.expenses ?? 0) * shareOf(p.owner, forOwner), 0);
  const propertyDepreciation = investmentProps.reduce((s, p) =>
    s + (row.properties?.[p.id]?.depreciation ?? 0) * shareOf(p.owner, forOwner), 0);
  // Land tax (spec 19 Commit 2) — deductible for an INVESTMENT property
  // only (a holiday home earns no assessable income to offset against;
  // see deterministic.js's own comment on why it's routed differently).
  const propertyLandTax = investmentProps.reduce((s, p) =>
    s + (row.properties?.[p.id]?.landTax ?? 0) * shareOf(p.owner, forOwner), 0);
  const vehicle = byCat("vehicle");
  const socialClub = byCat("socialClub");
  const insurance = byCat("insurance");
  const novatedLease = byCat("novatedLease");
  const workingExpense = byCat("workingExpense");
  const salarySacrifice = salarySacrificeCash(row, ownerSuperAccounts);
  const lumpSumSuperContributions = personalSuperContributionsCash(row, ownerSuperAccounts);
  const salaryPackaging = byCat("salaryPackaging");
  const other = byCat("other");
  const computedTotal = investmentPortfolioInterest + propertyInterestDeductions + propertyDeductions + propertyDepreciation
    + propertyLandTax + vehicle + socialClub + insurance + novatedLease + workingExpense + salarySacrifice
    + lumpSumSuperContributions + salaryPackaging + other;
  // Adjustment rows (spec 18) — a "deductions" adjustment (either sign)
  // folds into the section total; the engine credits the same amount to
  // measured[owner].deductions (deterministic.js), so this reconciles
  // Taxable Income against the real assessment rather than the
  // pre-adjustment figure. computedTotal kept alongside for Commit 2's
  // sub-rows, same convention as assessableIncome above.
  const adjDeductions = adjustmentSum(row, "deductions", forOwner);
  const total = computedTotal + adjDeductions;
  return {
    investmentPortfolioInterest, propertyInterestDeductions, propertyDeductions, propertyDepreciation, propertyLandTax,
    vehicle, socialClub, insurance, novatedLease, workingExpense, salarySacrifice, lumpSumSuperContributions,
    salaryPackaging, other, computedTotal, adjDeductions, total,
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
  // Adjustment rows (spec 18) — tax.* adjustments settle as a lump-sum
  // cash effect (deterministic.js's spreadTax against taxAdjustmentTotal)
  // rather than into taxDetail's own per-component fields, so each is
  // folded in here, at display time, against the specific component its
  // own target names. tax.cgt has no dedicated line in THIS section
  // (CGT payable is embedded in the household "Income Tax" row here —
  // buildTaxGroups' own per-person Tax view is where it gets its own
  // line) so it folds into incomeTax; exposed separately too so a
  // caller that DOES break CGT out can still mark it on its own row.
  const incomeTaxAdjustment = adjustmentSum(row, "tax.incomeTax", forOwner);
  const medicareAdjustment = adjustmentSum(row, "tax.medicare", forOwner);
  const helpAdjustment = adjustmentSum(row, "tax.help", forOwner);
  const cgtAdjustment = adjustmentSum(row, "tax.cgt", forOwner);
  const incomeTaxComputed = forOwner == null ? (client.grossTax ?? 0) + (partner.grossTax ?? 0) : (person.grossTax ?? 0);
  const incomeTax = incomeTaxComputed + incomeTaxAdjustment + cgtAdjustment;
  const medicareLevyComputed = forOwner == null ? (client.medicare ?? 0) + (partner.medicare ?? 0) : (person.medicare ?? 0);
  const medicareLevy = medicareLevyComputed + medicareAdjustment;
  // Document Set Commit 2.
  const medicareLevySurcharge = forOwner == null
    ? (row.taxDetail?.medicareLevySurcharge ?? 0)
    : (person.medicareLevySurcharge ?? 0);
  // Document Set Commit 1 — compulsory HELP repayment, assessed per
  // person (row.taxDetail.helpRepayment already sums both for the
  // household total).
  const helpRepaymentComputed = forOwner == null ? (row.taxDetail?.helpRepayment ?? 0) : (person.helpRepayment ?? 0);
  const helpRepayment = helpRepaymentComputed + helpAdjustment;
  const sapto = 0; // [zero]
  const lito = forOwner == null ? -((client.lito ?? 0) + (partner.lito ?? 0)) : -(person.lito ?? 0);
  const spouseSplittingOffset = 0; // [zero]
  const frankingCreditOffset = forOwner == null
    ? -(row.taxDetail?.frankingCredits ?? 0)
    : -(person.frankingCredits ?? 0);
  // Pension phase (spec 20, Commit 2/5) — the 15% non-refundable offset
  // on a pre-60 TTR payment's taxable component. Same negative-sign
  // convention as lito/frankingCreditOffset (an offset REDUCES tax).
  // Always 0 in this build's own reachable states — see
  // assessableIncome's own taxablePensionComponent comment above.
  const taxablePensionOffsetRaw = forOwner == null
    ? (client.ttrPensionOffset ?? 0) + (partner.ttrPensionOffset ?? 0)
    : (person.ttrPensionOffset ?? 0);
  const taxablePensionOffset = -taxablePensionOffsetRaw || 0; // avoid a -0 when it's genuinely zero
  const div293 = forOwner == null ? (row.taxDetail?.div293 ?? 0) : (person.div293 ?? 0);
  const div296 = forOwner == null ? (row.taxDetail?.div296 ?? 0) : (person.div296 ?? 0);
  const total = incomeTax + medicareLevy + medicareLevySurcharge + helpRepayment + sapto + lito
    + spouseSplittingOffset + frankingCreditOffset + taxablePensionOffset + div293 + div296;
  return {
    incomeTax, medicareLevy, medicareLevySurcharge, helpRepayment, sapto, lito,
    spouseSplittingOffset, frankingCreditOffset, taxablePensionOffset, div293, div296, total,
    incomeTaxComputed, medicareLevyComputed, helpRepaymentComputed,
    incomeTaxAdjustment, medicareAdjustment, helpAdjustment, cgtAdjustment,
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
  // Worked-example validation follow-up: HELP and MLS are ALSO
  // withheld through PAYG, same mechanism as income tax
  // (deterministic.js's own comment where these are computed) — this
  // used to net off paygWithheld alone, overstating take-home pay by
  // the full HELP/MLS withholding for anyone with either. Found by
  // reconciling a real worked example, not assumed.
  const withheldOf = (person) => (person.paygWithheld ?? 0) + (person.helpWithheld ?? 0) + (person.mlsWithheld ?? 0);
  const totalWithheld = forOwner == null
    ? withheldOf(client) + withheldOf(partner)
    : withheldOf(row.taxDetail?.[forOwner] ?? {});
  const regularTakeHomePay = byCat("salary") - totalWithheld;
  const anticipatedTaxReturn = forOwner == null
    ? (row.taxDetail?.refundSettled ?? 0)
    : (row.taxDetail?.[forOwner]?.refundSettled ?? 0);
  const afterTaxBonus = byCat("afterTaxBonus");
  // Adjustment rows (spec 18) — "income.nonTaxable" is a non-assessable
  // cash receipt (the registry's own description), so it folds into the
  // existing otherTaxFreeIncome line rather than needing a line of its
  // own; the engine credits it to `inc` the same way (deterministic.js).
  // otherTaxFreeIncomeComputed (pre-adjustment) is kept alongside for
  // Commit 2's sub-rows, same convention as the other three functions.
  const otherTaxFreeIncomeComputed = byCat("otherTaxFreeIncome");
  const adjNonTaxable = adjustmentSum(row, "income.nonTaxable", forOwner);
  const otherTaxFreeIncome = otherTaxFreeIncomeComputed + adjNonTaxable;
  const total = regularTakeHomePay + anticipatedTaxReturn + afterTaxBonus + otherTaxFreeIncome;
  return {
    regularTakeHomePay, anticipatedTaxReturn, afterTaxBonus,
    otherTaxFreeIncomeComputed, adjNonTaxable, otherTaxFreeIncome, total,
  };
}

export function expenseSums(row, ctx, forOwner = null) {
  const {
    expenseRows = [], rowTotalsExpenses = {}, properties = [], liabilities = [], y = 0,
    educationBlocks = [], rowTotalsEducation = {},
  } = ctx;
  const byCat = (cat) => sumByCategory(expenseRows, rowTotalsExpenses, cat, y, forOwner);
  // Education fees are a household cost, not owned by either parent
  // individually (children aren't owned by a specific parent in this
  // model) — split 50/50 for a per-owner view, same disclosed
  // simplification as Working Cash Account interest, full total when
  // forOwner is omitted.
  const education = educationBlocks.reduce((s, b) => s + (rowTotalsEducation[b.id]?.[y] ?? 0), 0) * shareOf("joint", forOwner);
  const investmentProps = properties.filter((p) => p.propertyType === "investment");
  let mortgageRepayments = 0, otherLoanRepayments = 0;
  for (const lid of Object.keys(row.liabilities ?? {})) {
    if (isHelpLiability(lid)) continue; // see isHelpLiability's header
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
  // Land tax (spec 19 Commit 2) — a cash outflow for EVERY non-PPR
  // property (investment or holiday alike; deductibility is investment-
  // only, handled separately in deductionSums above).
  const nonPprProps = properties.filter((p) => p.propertyType !== "ppr");
  const landTax = nonPprProps.reduce((s, p) =>
    s + (row.properties?.[p.id]?.landTax ?? 0) * shareOf(p.owner, forOwner), 0);
  const computedTotal = mortgageRepayments + otherLoanRepayments + nonDiscretionary + discretionary + groceryFuel
    + holidays + insurance + investmentPropertyExpenses + homeMaintenance + other + education + landTax;
  // Adjustment rows (spec 18) — "expenses" is household-owned (a joint
  // leak, per the registry), so it's split the same 50/50 way as
  // education above for a per-person view, in full for the household.
  // computedTotal (pre-adjustment) kept alongside for Commit 2's
  // sub-rows, same convention as the other three functions.
  const adjExpenses = adjustmentSum(row, "expenses", forOwner);
  const total = computedTotal + adjExpenses;
  return {
    mortgageRepayments, otherLoanRepayments, nonDiscretionary, discretionary, groceryFuel, holidays,
    insurance, investmentPropertyExpenses, homeMaintenance, other, education, landTax, computedTotal, adjExpenses, total,
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
