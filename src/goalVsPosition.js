// Goal versus position chart (docs/specs/32-retirement-phase-one.md,
// Commit 5a) — pure, no DOM/Plotly. "The chart most conversations need"
// — deliberately restrained: two axes at most, four colours, one
// sentence beneath. Never re-derives a number the engine already
// produces (spec 12's own governing principle) — every bucket below
// reads an already-labelled sub-total off the yearly ledger; the only
// arithmetic here is which sub-totals to add together under which of
// the spec's five named sources.
//
// Household income by source — the five buckets, and where each comes
// from:
//   employment       — schedule.employmentIncomeByOwner (gross wages,
//                       already computed as engine INPUT, not output —
//                       same read retirementAnalytics.js/deterministic.js
//                       already use for SG/HELP/etc.)
//   pensionDrawdown   — row.pensionDetail[*].payments, every pension
//   investmentIncome  — row.cashDistributions (payout-mode asset
//                       distributions). Disclosed simplification: a
//                       manually-entered interest/dividend CASHFLOW row
//                       (as opposed to a modelled financial asset) is
//                       not folded in here — this chart's own "two axes,
//                       four colours" restraint is explicit about not
//                       chasing every cent; the bulk of investment
//                       income in a real retirement plan comes from
//                       modelled financial assets.
//   agePension        — retirementAnalytics.js's own agePensionPaid
//                       (client + partner), the SAME figure the
//                       Commit 3 summary card already reports.
//   assetDrawdown     — row.deficitFundedFromAssets (financial assets
//                       AND bonds sold to cover a shortfall) +
//                       row.withdrawals (explicit financial-asset
//                       withdrawal rows) + every super account's own
//                       row.superDetail[id].withdrawals (deficit-funded
//                       or explicit). Disclosed simplification: bond-
//                       specific withdrawals (row.bondDetail[*].
//                       withdrawals) are excluded — a bond's own
//                       DEFICIT sells are already counted once, inside
//                       deficitFundedFromAssets (see deterministic.js's
//                       own "a." step, which credits that field
//                       unconditionally for both financial assets and
//                       bonds); adding bondDetail's own withdrawals on
//                       top would double-count that same dollar. A
//                       bond's own EXPLICIT (non-deficit) withdrawal is
//                       therefore the one path genuinely left out here,
//                       same "bonds are out of scope" restraint spec 32
//                       already applies to glide paths.
//
// Tax: the bars themselves are GROSS by source — attributing one
// household tax bill back to five income sources would need an
// invented per-source apportionment this engine has no basis for (tax
// is assessed on TOTAL taxable income, never per-stream). Instead,
// `deliveredIncome` (gross total − row.tax) is the one NET figure this
// module produces, and it is what actually gets compared against
// Income Required (an after-tax figure, retirement.js's own
// interpretation) for the crossover/sentence below — the bars show
// composition, the line-vs-line comparison is the apples-to-apples one.

import { agePensionPaid } from "./retirementAnalytics.js";

function sumOverFy(monthlyArray, schedule, y) {
  if (!monthlyArray) return 0;
  let total = 0;
  for (let m = 0; m < schedule.months; m++) {
    if (schedule.yearOfMonth[m] === y) total += monthlyArray[m] ?? 0;
  }
  return total;
}

// incomeBySourceForYear(row, schedule, y) → { employment, pensionDrawdown,
//   investmentIncome, agePension, assetDrawdown, grossTotal, deliveredIncome }
export function incomeBySourceForYear(row, schedule, y) {
  const employment = sumOverFy(schedule.employmentIncomeByOwner?.client, schedule, y)
    + sumOverFy(schedule.employmentIncomeByOwner?.partner, schedule, y);
  let pensionDrawdown = 0;
  for (const id of Object.keys(row.pensionDetail ?? {})) pensionDrawdown += row.pensionDetail[id]?.payments ?? 0;
  const investmentIncome = row.cashDistributions ?? 0;
  const agePension = agePensionPaid(row);
  let assetDrawdown = (row.deficitFundedFromAssets ?? 0) + (row.withdrawals ?? 0);
  for (const id of Object.keys(row.superDetail ?? {})) assetDrawdown += row.superDetail[id]?.withdrawals ?? 0;
  const grossTotal = employment + pensionDrawdown + investmentIncome + agePension + assetDrawdown;
  const deliveredIncome = grossTotal - (row.tax ?? 0);
  return { employment, pensionDrawdown, investmentIncome, agePension, assetDrawdown, grossTotal, deliveredIncome };
}

// incomeBySourceSeries(yearly, schedule) → one incomeBySourceForYear per
// plan year, in order.
export function incomeBySourceSeries(yearly, schedule) {
  return yearly.map((row, y) => incomeBySourceForYear(row, schedule, y));
}

// firstShortfallCrossover(series, incomeRequiredByYear) → the plan-year
// INDEX of the first year delivered income falls below Income Required
// (the spec's own "annotate the year delivered income first falls below
// the requirement"), or null if it never does within the projection.
// Years before Income Required's own startAt (incomeRequiredByYear[y]
// === null) are skipped — "not yet applicable" is not "already short",
// the same null convention retirement.js's own resolveIncomeRequired
// header states.
export function firstShortfallCrossover(series, incomeRequiredByYear) {
  for (let y = 0; y < series.length; y++) {
    const req = incomeRequiredByYear[y];
    if (req == null) continue;
    if (series[y].deliveredIncome < req) return y;
  }
  return null;
}

// goalVsPositionSummary(yearly, schedule, incomeRequiredByYear, targetAmount) →
//   { series, crossoverYear, crossoverAge, deliveredAtCrossover, targetAmount }
// `targetAmount` is the single headline figure the generated sentence
// names ("Your $90,000 target...") — the caller's choice of WHICH year's
// Income Required to quote as "the" target (this module has no opinion;
// main.js passes the figure at the Retirement key date, matching
// computeRetirementAnalytics's own retirement anchor). Formatting
// (currency strings, the sentence's own words) is a display concern —
// left to the caller, same "pure module returns numbers, main.js
// composes text" convention every other Commit 3/4 module here follows.
export function goalVsPositionSummary(yearly, schedule, incomeRequiredByYear, targetAmount) {
  const series = incomeBySourceSeries(yearly, schedule);
  const crossoverYear = firstShortfallCrossover(series, incomeRequiredByYear);
  return {
    series,
    crossoverYear,
    crossoverAge: crossoverYear != null ? schedule.clientAges[crossoverYear] : null,
    deliveredAtCrossover: crossoverYear != null ? series[crossoverYear].deliveredIncome : null,
    targetAmount,
  };
}
