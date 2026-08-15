// Fortnightly transfer schedule (Implementation/Rates spec, Commit 5) —
// pure, no DOM/Plotly. The firm builds the banking-structure "mud map"
// diagram itself, separately (deferred — see the spec's own "do not
// build" list); this module produces the numbers to copy into it: a
// literal, per-row list of take-home sources and destination transfers
// for one selected plan year, at whatever cadence the adviser is
// working in (fortnightly by default, since the workbook does).
//
// Governing principle unchanged from docs/specs/12-focus-views.md:
// every figure here is read from the SAME projectPlan() output every
// other view reads — never a separate calculation, never a shortcut
// formula.
//
// "Net of PAYG" (the spec's own wording for Sources) mirrors
// cashflowStatement.js's cashReceivedSums exactly: only the "salary"
// income category is withheld in this model at all — every other
// category (otherIncome, interestIncome, dividendIncome,
// otherTaxFreeIncome, afterTaxBonus) is received in full, the same
// disclosed simplification the Cashflow table already carries. A
// person's PAYG (row.taxDetail[owner].paygWithheld) is spread across
// THEIR OWN salary rows proportionally by each row's own gross share of
// their total gross salary for the year — the same convention as the
// Cashflow table's, just carried one level deeper (per ROW, not just
// per household total) — see the reconciliation test for why this
// matters: summed back up, it must equal the Cashflow table's own
// figure exactly, not merely approximately.
//
// Destinations deliberately never re-show tax as a line — it already
// left at the source, the same way a real payslip never shows a
// "transfer to the ATO" the household itself initiates. Salary
// sacrifice is the same shape (a payroll deduction before the money is
// ever "received"), so it is likewise excluded from both sides — it's
// already shown as its own line in the Cashflow table's Deductions
// section; duplicating it here as a destination would double-count
// against a sources figure that was never grossed up to include it in
// the first place (matching cashReceivedSums's own regularTakeHomePay,
// which does the same).

import { monthsInFirstYear } from "./schedule.js";

const FORTNIGHTS_PER_YEAR = 26;

export function perFortnight(annual) { return annual / FORTNIGHTS_PER_YEAR; }
export function perMonth(annual) { return annual / 12; }

// The first FULL plan year (12 months) — year 0 unless the plan starts
// mid-FY, in which case year 0 is a partial year and year 1 is the
// first full one (falls back to 0 for a single-year projection).
export function defaultTransferScheduleYear(state, years) {
  if (monthsInFirstYear(state.plan.start) === 12) return 0;
  return years > 1 ? 1 : 0;
}

function personGrossSalary(incomeRows, rowTotalsIncome, owner, y) {
  return incomeRows
    .filter((r) => r.category === "salary" && r.owner === owner)
    .reduce((s, r) => s + (rowTotalsIncome[r.id]?.[y] ?? 0), 0);
}

// Sources — each income cashflow row, take-home, plus each investment
// property's own rent. One row per plan INPUT row (never a category
// aggregate) since the point of this view is a literal list to copy
// into a banking mud map, not a summary.
function buildSources({ state, row, y, rowTotalsIncome }) {
  const incomeRows = state.cashflows.income ?? [];
  const properties = state.properties ?? [];
  const sources = [];
  for (const r of incomeRows) {
    const gross = rowTotalsIncome[r.id]?.[y] ?? 0;
    let takeHome = gross;
    if (r.category === "salary") {
      const totalGross = personGrossSalary(incomeRows, rowTotalsIncome, r.owner, y);
      const payg = row.taxDetail?.[r.owner]?.paygWithheld ?? 0;
      const share = totalGross > 1e-9 ? gross / totalGross : 0;
      takeHome = gross - share * payg;
    }
    if (Math.abs(takeHome) > 1e-9) sources.push({ id: r.id, label: r.label, owner: r.owner, annual: takeHome });
  }
  for (const p of properties.filter((pr) => pr.propertyType === "investment")) {
    const rent = row.properties?.[p.id]?.rent ?? 0;
    if (rent > 1e-9) sources.push({ id: `rent-${p.id}`, label: `${p.name} — rent`, owner: p.owner, annual: rent });
  }
  return sources;
}

function liabilityLabel(lid, liabilities, properties) {
  const prop = properties.find((p) => `prop-${p.id}` === lid);
  if (prop) return `${prop.name} — loan repayment`;
  const liab = liabilities.find((l) => l.id === lid);
  return liab ? `${liab.name} — loan repayment` : "Loan repayment";
}

// Destinations — each expense row, each loan repayment, each super
// contribution actually paid from household cash, each goal accrual,
// an adviser fee paid from cash, and a settling property's own cash
// contribution. HELP/HECS (row.liabilities.help_*) is excluded — its
// repayment is withheld via PAYG (already netted out of Sources above),
// never a separate household-initiated transfer.
function buildDestinations({ state, row, y, rowTotalsExpenses }) {
  const expenseRows = state.cashflows.expenses ?? [];
  const liabilities = state.liabilities ?? [];
  const properties = state.properties ?? [];
  const superAccounts = state.plan.superAccounts ?? [];
  const goals = state.goals ?? [];
  const destinations = [];

  for (const r of expenseRows) {
    const amt = rowTotalsExpenses[r.id]?.[y] ?? 0;
    if (amt > 1e-9) destinations.push({ id: r.id, label: r.label, kind: "expense", annual: amt });
  }

  for (const [lid, ld] of Object.entries(row.liabilities ?? {})) {
    if (lid === "help_client" || lid === "help_partner") continue;
    const service = (ld.interest ?? 0) + (ld.principal ?? 0);
    if (service <= 1e-9) continue;
    destinations.push({ id: lid, label: liabilityLabel(lid, liabilities, properties), kind: "loan", annual: service });
  }

  for (const sa of superAccounts) {
    const d = row.superDetail?.[sa.id];
    if (!d) continue;
    const amt = (d.personalDeductible ?? 0) + (d.nonConcessional ?? 0);
    if (amt > 1e-9) destinations.push({ id: sa.id, label: `${sa.name} — super contribution`, kind: "super", annual: amt });
  }

  for (const g of goals) {
    const amt = row.goals?.[g.id]?.contribution ?? 0;
    if (amt > 1e-9) destinations.push({ id: g.id, label: `${g.label} — goal`, kind: "goal", annual: amt });
  }

  const feeCash =
    (row.adviserFeesUpfront?.outsideCash ?? 0) + (row.adviserFeesUpfront?.requestedFromSuper ?? 0) - (row.adviserFeesUpfront?.paidFromSuper ?? 0)
    + (row.adviserFeesOngoing?.outsideCash ?? 0) + (row.adviserFeesOngoing?.requestedFromSuper ?? 0) - (row.adviserFeesOngoing?.paidFromSuper ?? 0);
  if (feeCash > 1e-9) destinations.push({ id: "adviser-fees", label: "Adviser fees", kind: "fee", annual: feeCash });

  for (const p of properties) {
    const settle = row.properties?.[p.id]?.settlement ?? 0;
    if (settle > 1e-9) destinations.push({ id: `settle-${p.id}`, label: `${p.name} — settlement`, kind: "property", annual: settle });
  }

  return destinations;
}

// buildTransferScheduleFocus({ out, state, year }) → the full schedule
// for one plan year, or null when the projection has no years at all.
// `year` is clamped to a valid index; omit it to get the default
// (first full year).
export function buildTransferScheduleFocus({ out, state, year }) {
  const years = out.yearly.length;
  if (years === 0) return null;
  const y = year != null && year >= 0 && year < years ? year : defaultTransferScheduleYear(state, years);
  const row = out.yearly[y];
  const rowTotalsIncome = out.schedule.rowTotals.income;
  const rowTotalsExpenses = out.schedule.rowTotals.expenses;

  const sources = buildSources({ state, row, y, rowTotalsIncome });
  const destinations = buildDestinations({ state, row, y, rowTotalsExpenses });

  const sourcesTotal = sources.reduce((s, r) => s + r.annual, 0);
  const destinationsTotal = destinations.reduce((s, r) => s + r.annual, 0);
  const residual = sourcesTotal - destinationsTotal;

  // Initial transfer — Commit 2's implementation allocations, a ONE-OFF
  // at plan start (never fortnightly — a lump sum has no natural
  // per-fortnight rate), shown alongside as context, never folded into
  // the recurring reconciliation above.
  const initialTransfers = (state.plan.implementation?.allocations ?? [])
    .filter((a) => Math.abs(a.amount) > 1e-9)
    .map((a) => ({ id: a.id, label: a.label, amount: a.amount }));

  return {
    year: y, fyLabel: out.schedule.fyLabels[y], age: out.schedule.clientAges[y],
    sources, destinations, sourcesTotal, destinationsTotal, residual,
    initialTransfers,
  };
}
