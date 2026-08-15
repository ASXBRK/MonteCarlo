// Snapshot view (Document Set Commit 7) — pure, no DOM/Plotly. Builds
// the firm's full Cash Flow SOA row vocabulary as one column per
// selected plan year, with Client/Partner/Total sub-columns, reusing
// cashflowStatement.js's per-owner breakdown exactly (Commit 7's own
// addition to that module) — so every snapshot figure reconciles to
// the Cashflow table for that year by construction, not by a second,
// separately-maintained computation.
//
// Up to six years may be selected; a plan year appears once even if
// picked twice (DateRef selectors can resolve to the same year).

import { cashflowStatement } from "./cashflowStatement.js";

export const MAX_SNAPSHOT_YEARS = 6;

// SNAPSHOT_ROWS mirrors cashflowStatement.js's own section/field
// structure exactly (not the Cashflow table's expanded one-off/funding
// extras, which sit outside the firm's row vocabulary) — every row
// with a `path` accessor into a cashflowStatement() result, grouped
// under the firm's own section headings.
export const SNAPSHOT_ROWS = [
  { section: "Assessable Income", label: "Salary", path: (s) => s.assessable.salary },
  { section: "Assessable Income", label: "Taxable Pension Component", path: (s) => s.assessable.taxablePensionComponent },
  { section: "Assessable Income", label: "Other Income", path: (s) => s.assessable.otherIncome },
  { section: "Assessable Income", label: "Government/Centrelink Payments", path: (s) => s.assessable.governmentPayments },
  { section: "Assessable Income", label: "Interest Income", path: (s) => s.assessable.interestIncome },
  { section: "Assessable Income", label: "Dividend Income", path: (s) => s.assessable.dividendIncome },
  { section: "Assessable Income", label: "Franking Credits", path: (s) => s.assessable.frankingCredits },
  { section: "Assessable Income", label: "Property Income – Gross Rent", path: (s) => s.assessable.propertyIncomeGross },
  { section: "Assessable Income", label: "Trust Distribution", path: (s) => s.assessable.trustDistribution },
  { section: "Assessable Income", label: "Foreign Income", path: (s) => s.assessable.foreignIncome },
  { section: "Assessable Income", label: "Net Taxable Capital Gains", path: (s) => s.assessable.netTaxableCapitalGains },
  { section: "Assessable Income", label: "Assessable Income", path: (s) => s.assessable.total, total: true },

  { section: "Deductions", label: "Investment Portfolio Interest", path: (s) => -s.deductions.investmentPortfolioInterest },
  { section: "Deductions", label: "Property Interest Deductions", path: (s) => -s.deductions.propertyInterestDeductions },
  { section: "Deductions", label: "Property Deductions", path: (s) => -s.deductions.propertyDeductions },
  { section: "Deductions", label: "Property Depreciation", path: (s) => -s.deductions.propertyDepreciation },
  { section: "Deductions", label: "Vehicle Deductions", path: (s) => -s.deductions.vehicle },
  { section: "Deductions", label: "Social Club (pre-tax)", path: (s) => -s.deductions.socialClub },
  { section: "Deductions", label: "Deductible Insurance Premiums", path: (s) => -s.deductions.insurance },
  { section: "Deductions", label: "Novated Lease pre-tax", path: (s) => -s.deductions.novatedLease },
  { section: "Deductions", label: "Working Expense", path: (s) => -s.deductions.workingExpense },
  { section: "Deductions", label: "Salary Sacrifice", path: (s) => -s.deductions.salarySacrifice },
  { section: "Deductions", label: "Lump Sum Super Contributions", path: (s) => -s.deductions.lumpSumSuperContributions },
  { section: "Deductions", label: "Salary Packaging (Living Expenses)", path: (s) => -s.deductions.salaryPackaging },
  { section: "Deductions", label: "Other", path: (s) => -s.deductions.other },
  { section: "Deductions", label: "Taxable Income", path: (s) => s.taxableIncome, total: true },

  { section: "Tax", label: "Income Tax", path: (s) => -s.tax.incomeTax },
  { section: "Tax", label: "Medicare Levy", path: (s) => -s.tax.medicareLevy },
  { section: "Tax", label: "Medicare Levy Surcharge", path: (s) => -s.tax.medicareLevySurcharge },
  { section: "Tax", label: "HELP Repayment", path: (s) => -s.tax.helpRepayment },
  { section: "Tax", label: "SAPTO", path: (s) => -s.tax.sapto },
  { section: "Tax", label: "LITO", path: (s) => -s.tax.lito },
  { section: "Tax", label: "Spouse Splitting Offset", path: (s) => -s.tax.spouseSplittingOffset },
  { section: "Tax", label: "Franking Credit Offset", path: (s) => -s.tax.frankingCreditOffset },
  { section: "Tax", label: "Taxable Pension Offset (TTR)", path: (s) => -s.tax.taxablePensionOffset },
  { section: "Tax", label: "Division 293", path: (s) => -s.tax.div293 },
  { section: "Tax", label: "Division 296", path: (s) => -s.tax.div296 },
  { section: "Tax", label: "Tax on Taxable Income", path: (s) => -s.tax.total, total: true },
  { section: "Tax", label: "NET INCOME", path: (s) => s.netIncome, total: true },

  { section: "Cash Received", label: "Regular Take Home Pay", path: (s) => s.cashReceived.regularTakeHomePay },
  { section: "Cash Received", label: "Anticipated Tax Return", path: (s) => s.cashReceived.anticipatedTaxReturn },
  { section: "Cash Received", label: "After Tax Bonus", path: (s) => s.cashReceived.afterTaxBonus },
  { section: "Cash Received", label: "Other Tax Free Income", path: (s) => s.cashReceived.otherTaxFreeIncome },

  { section: "Expenses", label: "Mortgage Repayments", path: (s) => -s.expenses.mortgageRepayments },
  { section: "Expenses", label: "Other Loan Repayments (P&I)", path: (s) => -s.expenses.otherLoanRepayments },
  { section: "Expenses", label: "Non-discretionary Living Expenses", path: (s) => -s.expenses.nonDiscretionary },
  { section: "Expenses", label: "Discretionary Living Expenses", path: (s) => -s.expenses.discretionary },
  { section: "Expenses", label: "Grocery & Fuel Expenses", path: (s) => -s.expenses.groceryFuel },
  { section: "Expenses", label: "Holidays", path: (s) => -s.expenses.holidays },
  { section: "Expenses", label: "New Insurance Premiums", path: (s) => -s.expenses.insurance },
  { section: "Expenses", label: "Investment Property Expenses", path: (s) => -s.expenses.investmentPropertyExpenses },
  { section: "Expenses", label: "Home Maintenance Expenses", path: (s) => -s.expenses.homeMaintenance },
  { section: "Expenses", label: "Other", path: (s) => -s.expenses.other },
  { section: "Expenses", label: "Total Expenses", path: (s) => -s.expenses.total, total: true },
  { section: "Expenses", label: "SURPLUS INCOME", path: (s) => s.surplusIncome, total: true },
];

// buildSnapshotColumns(yearly, ctxFor, planYears, couple) → one column
// per resolved plan year (duplicates collapsed, order preserved,
// clamped into [0, yearly.length)), each { y, client, partner, total }
// where client/partner/total are full cashflowStatement() results.
// ctxFor(y) supplies the per-year ctx object main.js already builds
// for the Cashflow table (incomeRows, rowTotalsIncome, etc, y baked in).
export function buildSnapshotColumns(yearly, ctxFor, planYears, couple) {
  const seen = new Set();
  const columns = [];
  for (const y of planYears) {
    if (y == null || y < 0 || y >= yearly.length || seen.has(y)) continue;
    seen.add(y);
    const row = yearly[y];
    const ctx = ctxFor(y);
    columns.push({
      y,
      client: cashflowStatement(row, ctx, "client"),
      partner: couple ? cashflowStatement(row, ctx, "partner") : null,
      total: cashflowStatement(row, ctx, null),
    });
  }
  return columns;
}

// buildSnapshotTable(...) → { rows: [{ section, label, total, cells: [{client,partner,total}, ...] }] }
// — a hideEmptyRows-filtered row list (Outputs convention: all-zero
// rows hidden), still returning every column for every surviving row
// so the caller (HTML/CSV export) shows EXACTLY the visible rows.
export function buildSnapshotTable(columns, { hideEmptyRows = true } = {}) {
  const rows = SNAPSHOT_ROWS.map((def) => {
    const cells = columns.map((col) => ({
      client: def.path(col.client),
      partner: col.partner ? def.path(col.partner) : null,
      total: def.path(col.total),
    }));
    return { section: def.section, label: def.label, total: def.total === true, cells };
  });
  if (!hideEmptyRows) return { rows };
  const isZero = (v) => !v || Math.abs(v) < 0.005;
  return { rows: rows.filter((r) => r.total || r.cells.some((c) => !isZero(c.total) || !isZero(c.client) || !isZero(c.partner))) };
}

const fmt = (n) => (Math.round(n) === 0 ? "–" : Math.round(n).toLocaleString("en-AU"));

// snapshotToHTML(table, columnLabels, couple) → a clipboard-friendly
// <table> — pasting this into Word retains the table structure (rows/
// columns/bold subtotal rows), per the spec's explicit "not .docx"
// scope: this is deliberately plain, semantic HTML, not a Word file.
export function snapshotToHTML(table, columnLabels, couple) {
  const headCols = couple
    ? columnLabels.flatMap((l) => [`${l} — Client`, `${l} — Partner`, `${l} — Total`])
    : columnLabels.map((l) => l);
  const head = `<tr><th>Item</th>${headCols.map((h) => `<th>${escapeHTML(h)}</th>`).join("")}</tr>`;
  let lastSection = null;
  const body = table.rows.map((r) => {
    const sectionRow = r.section !== lastSection
      ? `<tr><td colspan="${headCols.length + 1}"><strong>${escapeHTML(r.section)}</strong></td></tr>` : "";
    lastSection = r.section;
    const cells = r.cells.flatMap((c) => couple ? [fmt(c.client), fmt(c.partner), fmt(c.total)] : [fmt(c.total)]);
    const style = r.total ? ' style="font-weight:bold;"' : "";
    return sectionRow + `<tr${style}><td${style}>${escapeHTML(r.label)}</td>${cells.map((v) => `<td${style}>${v}</td>`).join("")}</tr>`;
  }).join("");
  return `<table border="1" cellspacing="0" cellpadding="4">${head}${body}</table>`;
}

// snapshotToCSV(table, columnLabels, couple) → plain CSV, same rows
// and column ordering as the HTML export.
export function snapshotToCSV(table, columnLabels, couple) {
  const headCols = couple
    ? columnLabels.flatMap((l) => [`${l} - Client`, `${l} - Partner`, `${l} - Total`])
    : columnLabels.map((l) => l);
  const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [["Item", ...headCols].map(esc).join(",")];
  for (const r of table.rows) {
    const cells = r.cells.flatMap((c) => couple ? [c.client, c.partner, c.total] : [c.total]);
    lines.push([r.label, ...cells.map((v) => Math.round(v))].map((v) => esc(String(v))).join(","));
  }
  return lines.join("\r\n");
}

function escapeHTML(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
