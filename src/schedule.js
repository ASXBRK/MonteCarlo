// Cashflow schedule builder — pure, no DOM/Plotly/engine knowledge.
//
// Converts a schemaVersion-3 plan state into per-month cashflow arrays
// for the whole projection, implementing the locked time conventions:
//
//  1. Plan years are Australian FYs (1 July – 30 June), "FY2026–27".
//     Monthly steps throughout.
//  2. The projection starts at plan.start {year, month}; the first plan
//     year is partial (start month → following 30 June). The final plan
//     year is the FY in which the client is endAge.
//  3. Ages tick over each 1 July. Income rows anchor to the OWNER's
//     age; everything else anchors to the client's.
//  4. Monthly cashflows apply every month within [fromAge, toAge],
//     inclusive of both boundary plan years.
//  5. Annual cashflows and one-offs fire in July. In the partial first
//     year, if the start month is after July (or the partial year
//     contains no July at all), that FY's annual flows and one-offs
//     are skipped (assumed already made earlier in the FY).
//  6. Indexed cashflows are constant in real terms; non-indexed are
//     fixed-nominal and decay: real at month m = amount/(1+cpi)^(m/12).
//
// All amounts in the output are REAL dollars. Nominal is a display
// scaling applied by the renderer via nominalFactor().

// --- time helpers -------------------------------------------------------

// Months in the partial first plan year (12 when starting in July).
export function monthsInFirstYear(start) {
  return 12 - ((start.month - 7 + 12) % 12);
}

// Calendar year in which the first plan year's FY began (its 1 July).
export function firstFyStartYear(start) {
  return start.month >= 7 ? start.year : start.year - 1;
}

// Number of plan years: the client is endAge in the final one.
export function planYearCount(plan) {
  return plan.endAge - plan.client.currentAge + 1;
}

export function totalMonths(plan) {
  return monthsInFirstYear(plan.start) + 12 * (planYearCount(plan) - 1);
}

// Plan year (0-based) containing month index m (m = 0 is the start month).
export function planYearOfMonth(plan, m) {
  const first = monthsInFirstYear(plan.start);
  return m < first ? 0 : 1 + Math.floor((m - first) / 12);
}

// Calendar month (1–12) of month index m.
export function calendarMonthOf(plan, m) {
  return ((plan.start.month - 1 + m) % 12) + 1;
}

// "FY2026–27" label for a 0-based plan year.
export function fyLabel(plan, planYear) {
  const fy = firstFyStartYear(plan.start) + planYear;
  return `FY${fy}–${String((fy + 1) % 100).padStart(2, "0")}`;
}

export function clientAgeAt(plan, planYear) {
  return plan.client.currentAge + planYear;
}

export function partnerAgeAt(plan, planYear) {
  return plan.partner ? plan.partner.currentAge + planYear : null;
}

export function ownerAgeAt(plan, owner, planYear) {
  if (owner === "partner" && plan.partner) return partnerAgeAt(plan, planYear);
  return clientAgeAt(plan, planYear);
}

// Display-time nominal scaling for a value observed at month index m.
export function nominalFactor(m, cpi) {
  return Math.pow(1 + cpi, m / 12);
}

// Non-indexed cashflows are fixed-nominal → decay in real terms.
function realAmountAt(row, m, cpi) {
  return row.indexed ? row.amount : row.amount / Math.pow(1 + cpi, m / 12);
}

// Whether plan year y contains a July month that fires annual flows.
// Full years (y > 0) always start in July. Year 0 fires only when the
// projection itself starts in July (convention 5).
function julyMonthIndex(plan, y) {
  if (y === 0) return plan.start.month === 7 ? 0 : null;
  return monthsInFirstYear(plan.start) + 12 * (y - 1);
}

// --- schedule builder ------------------------------------------------------

// buildSchedules(state) → {
//   months, planYears, monthsInFirstYear,
//   fyLabels[y], clientAges[y], partnerAges[y]|null,
//   yearOfMonth[m],
//   income[m], expenses[m],                        // household, real $
//   assetFlows: { [assetId]: {
//     contributions[m], withdrawals[m], oneOffs[m] // real $; oneOffs signed (+in / −out)
//   } },  // included assets only
// }
export function buildSchedules(state) {
  const plan = state.plan;
  const cpi = state.assumptions.cpi;
  const months = totalMonths(plan);
  const planYears = planYearCount(plan);
  const firstYearMonths = monthsInFirstYear(plan.start);

  const fyLabels = [];
  const clientAges = [];
  const partnerAges = plan.partner ? [] : null;
  for (let y = 0; y < planYears; y++) {
    fyLabels.push(fyLabel(plan, y));
    clientAges.push(clientAgeAt(plan, y));
    if (partnerAges) partnerAges.push(partnerAgeAt(plan, y));
  }

  const yearOfMonth = new Array(months);
  for (let m = 0; m < months; m++) yearOfMonth[m] = planYearOfMonth(plan, m);

  const income = new Float64Array(months);
  const expenses = new Float64Array(months);

  const includedIds = new Set(state.assets.filter((a) => a.include).map((a) => a.id));
  const assetFlows = {};
  for (const id of includedIds) {
    assetFlows[id] = {
      contributions: new Float64Array(months),
      withdrawals: new Float64Array(months),
      oneOffs: new Float64Array(months),
    };
  }

  // A regular cashflow row is active in plan year y iff the anchor
  // owner's age that year lies in [fromAge, toAge] (inclusive of both
  // boundary plan years — convention 4).
  const activeInYear = (row, owner, y) => {
    const age = ownerAgeAt(plan, owner, y);
    return age >= row.fromAge && age <= row.toAge;
  };

  // Accumulate a regular row into a target Float64Array.
  const applyRegular = (row, owner, target, sign = 1) => {
    if (row.amount <= 0) return;
    if (row.frequency === "monthly") {
      for (let m = 0; m < months; m++) {
        if (activeInYear(row, owner, yearOfMonth[m])) {
          target[m] += sign * realAmountAt(row, m, cpi);
        }
      }
    } else { // annual — fires in July (convention 5)
      for (let y = 0; y < planYears; y++) {
        if (!activeInYear(row, owner, y)) continue;
        const jm = julyMonthIndex(plan, y);
        if (jm == null) continue; // partial first year without a firing July
        target[jm] += sign * realAmountAt(row, jm, cpi);
      }
    }
  };

  for (const row of state.cashflows.income) applyRegular(row, row.owner, income);
  for (const row of state.cashflows.expenses) applyRegular(row, "client", expenses);

  for (const row of state.cashflows.contributions) {
    const flows = assetFlows[row.assetId];
    if (flows) applyRegular(row, "client", flows.contributions);
  }
  for (const row of state.cashflows.withdrawals) {
    const flows = assetFlows[row.assetId];
    if (flows) applyRegular(row, "client", flows.withdrawals);
  }

  // One-offs fire in the July of the plan year where the client is
  // ls.age, subject to convention 5's partial-first-year skip. They
  // carry no indexed flag — amounts are real as entered.
  for (const ls of state.cashflows.lumpSums) {
    const flows = assetFlows[ls.assetId];
    if (!flows || ls.amount <= 0) continue;
    const y = ls.age - plan.client.currentAge;
    if (y < 0 || y >= planYears) continue;
    const jm = julyMonthIndex(plan, y);
    if (jm == null) continue;
    flows.oneOffs[jm] += ls.direction === "out" ? -ls.amount : ls.amount;
  }

  return {
    months,
    planYears,
    monthsInFirstYear: firstYearMonths,
    fyLabels,
    clientAges,
    partnerAges,
    yearOfMonth,
    income,
    expenses,
    assetFlows,
  };
}
