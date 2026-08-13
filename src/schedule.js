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
//
// Key Dates (Tier 1.1): every row's from/to/at is a DateRef, resolved
// to a plan-year bound HERE, once, before any month is walked — never
// inside the per-month loop. Engine semantics are unchanged: an anchor
// resolves to exactly the plan year an equivalent integer age did.

import { resolveRef } from "./keyDates.js";
import { superRatesFor } from "./data/superRates.js";

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

// Per-row indexation (D1): nominal growth g = basis rate + additional
// %, so the real amount at month m is amount × ((1+g)/(1+cpi))^(m/12).
// CPI+0 → constant real; None+0 → decays at CPI (fixed nominal);
// AWOTE-linked rows grow in real terms. Rows carrying only the pre-D1
// `indexed` flag fall back to its CPI/None equivalents.
function realAmountAt(row, m, cpi, awote) {
  let basis = row.indexBasis;
  if (basis == null) basis = row.indexed === false ? "none" : "cpi";
  const basisRate = basis === "awote" ? awote : basis === "cpi" ? cpi : 0;
  const g = basisRate + (row.indexExtraPct ?? 0) / 100;
  if (g === cpi) return row.amount; // exact constant-real fast path
  return row.amount * Math.pow((1 + g) / (1 + cpi), m / 12);
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
  const awote = state.assumptions.awote ?? 0.035;
  const bracketMode = state.assumptions.bracketMode === "frozen" ? "frozen" : "indexed";
  const fy0 = firstFyStartYear(plan.start);
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
  // Per-owner income split — the tax layer attributes income rows to
  // the person who owns them. income = incomeByOwner.client + .partner.
  const incomeByOwner = {
    client: new Float64Array(months),
    partner: plan.partner ? new Float64Array(months) : null,
  };

  // Cashflows may only target included FINANCIAL assets (D2) —
  // lifestyle assets carry no flow arrays at all.
  const includedIds = new Set(
    state.assets.filter((a) => a.include && a.class !== "lifestyle").map((a) => a.id)
  );
  const assetFlows = {};
  for (const id of includedIds) {
    assetFlows[id] = {
      contributions: new Float64Array(months),
      withdrawals: new Float64Array(months),
      oneOffs: new Float64Array(months),
    };
  }

  // Per-row FY totals for the transposed output views (one line per
  // entered row) — filled alongside the monthly arrays.
  const rowTotals = { income: {}, expenses: {} };
  // Net one-off amounts per asset per FY (signed) for the one-off grid.
  const oneOffsByAssetYear = {};
  for (const id of includedIds) oneOffsByAssetYear[id] = new Float64Array(planYears);

  // Key Dates: a partial schedule — just enough for resolveRef
  // (planYears/fyLabels/clientAges) — built from the arrays above, so
  // every row's from/to/at resolves against the SAME plan-year numbering
  // the rest of this function uses. Resolved once per row below, never
  // per month.
  const dateSchedule = { planYears, fyLabels, clientAges };

  // A regular cashflow row is active in plan year y iff y lies within
  // its resolved [from, to] plan-year bounds (inclusive of both
  // boundary plan years — convention 4).
  const activeInPlanYear = (bounds, y) => y >= bounds.from && y <= bounds.to;

  // Accumulate a regular row into a target Float64Array (and its
  // per-FY totals when a `totals` array is supplied).
  const applyRegular = (row, owner, target, totals = null) => {
    if (row.amount <= 0) return;
    const bounds = {
      from: resolveRef(row.from, plan, dateSchedule, owner).planYear,
      to: resolveRef(row.to, plan, dateSchedule, owner).planYear,
    };
    if (row.frequency === "monthly") {
      for (let m = 0; m < months; m++) {
        if (activeInPlanYear(bounds, yearOfMonth[m])) {
          const v = realAmountAt(row, m, cpi, awote);
          target[m] += v;
          if (totals) totals[yearOfMonth[m]] += v;
        }
      }
    } else { // annual — fires in July (convention 5)
      for (let y = 0; y < planYears; y++) {
        if (!activeInPlanYear(bounds, y)) continue;
        const jm = julyMonthIndex(plan, y);
        if (jm == null) continue; // partial first year without a firing July
        const v = realAmountAt(row, jm, cpi, awote);
        target[jm] += v;
        if (totals) totals[y] += v;
      }
    }
  };

  for (const row of state.cashflows.income) {
    rowTotals.income[row.id] = new Float64Array(planYears);
    applyRegular(row, row.owner, income, rowTotals.income[row.id]);
    // Non-taxable income (Tier 1.2) is real household cashflow (still
    // counted in `income`/`rowTotals`) but bypasses tax assessment
    // entirely — incomeByOwner feeds ONLY the tax layer, so it's the
    // one place this row is excluded.
    if (row.incomeType !== "nonTaxable") {
      const ownerArr = row.owner === "partner" && incomeByOwner.partner
        ? incomeByOwner.partner
        : incomeByOwner.client;
      applyRegular(row, row.owner, ownerArr);
    }
  }
  for (const row of state.cashflows.expenses) {
    rowTotals.expenses[row.id] = new Float64Array(planYears);
    applyRegular(row, "client", expenses, rowTotals.expenses[row.id]);
  }

  for (const row of state.cashflows.contributions) {
    const flows = assetFlows[row.assetId];
    if (flows) applyRegular(row, "client", flows.contributions);
  }
  for (const row of state.cashflows.withdrawals) {
    const flows = assetFlows[row.assetId];
    if (flows) applyRegular(row, "client", flows.withdrawals);
  }

  // One-offs fire in the July of the plan year resolved from ls.at,
  // subject to convention 5's partial-first-year skip. They carry no
  // indexed flag — amounts are real as entered.
  for (const ls of state.cashflows.lumpSums) {
    const flows = assetFlows[ls.assetId];
    if (!flows || ls.amount <= 0) continue;
    const y = resolveRef(ls.at, plan, dateSchedule, "client").planYear;
    const jm = julyMonthIndex(plan, y);
    if (jm == null) continue;
    const signed = ls.direction === "out" ? -ls.amount : ls.amount;
    flows.oneOffs[jm] += signed;
    oneOffsByAssetYear[ls.assetId][y] += signed;
  }

  // --- superannuation (Tier 1.2, accumulation phase) ------------------------
  //
  // superFlows parallels assetFlows, but for included super accounts.
  // Contributions come from two sources: derived SG (never
  // user-entered) on employment income rows, and user-entered
  // cashflows.superContributions rows. Caps, contributions tax, and
  // carry-forward all arrive in Commit 2 — every contribution here
  // enters at its full gross amount. Concessional caps are NOT yet
  // carry-forward-aware (Commit 2 adds that); "toConcessionalCap"
  // below is the simple version: cap minus this FY's other
  // concessional contributions only.
  const superAccounts = (plan.superAccounts ?? []).filter((s) => s.include);
  const superFlows = {};
  for (const s of superAccounts) superFlows[s.id] = { contributions: new Float64Array(months) };
  const yearStartM = (y) => (y === 0 ? 0 : firstYearMonths + 12 * (y - 1));
  const yearEndM = (y) => firstYearMonths + 12 * y;
  const isConcessionalType = (type) => type === "sg" || type === "salarySacrifice" || type === "personalDeductible";
  // Per person per FY, so toConcessionalCap rows (processed last) know
  // how much headroom SG + explicit concessional rows have already used.
  const concessionalByOwnerFy = {
    client: new Float64Array(planYears),
    partner: new Float64Array(planYears),
  };

  // SG: one "employer" per employment income row (sgApplies, default
  // on), capped at sgMaximumSalary per FY, credited to the owner's
  // default (first-listed, included) super account. No account for
  // that owner → nothing to credit (disclosed simplification — SG
  // still legally accrues, but this tool has nowhere to put it).
  for (const row of state.cashflows.income) {
    if (row.incomeType !== "employment" || row.sgApplies === false) continue;
    const account = superAccounts.find((s) => s.owner === row.owner);
    if (!account) continue;
    const flows = superFlows[account.id];
    const bounds = {
      from: resolveRef(row.from, plan, dateSchedule, row.owner).planYear,
      to: resolveRef(row.to, plan, dateSchedule, row.owner).planYear,
    };
    const fyTotals = rowTotals.income[row.id];
    for (let y = Math.max(0, bounds.from); y <= Math.min(planYears - 1, bounds.to); y++) {
      const salaryFy = fyTotals[y];
      if (!(salaryFy > 0)) continue;
      const rates = superRatesFor(fy0 + y, bracketMode, cpi);
      const sgFy = Math.min(salaryFy, rates.sgMaximumSalary) * rates.sgRate;
      if (sgFy <= 0) continue;
      if (row.frequency === "monthly") {
        const s = yearStartM(y), e = yearEndM(y);
        if (e > s) {
          const per = sgFy / (e - s);
          for (let m = s; m < e; m++) flows.contributions[m] += per;
        }
      } else {
        const jm = julyMonthIndex(plan, y);
        if (jm != null) flows.contributions[jm] += sgFy;
      }
      concessionalByOwnerFy[row.owner][y] += sgFy;
    }
  }

  // User-entered contributions: "amount" and "percentOfIncome" bases
  // first (their concessional total must be known before
  // "toConcessionalCap" rows, processed after, can compute headroom).
  const incomeRowsById = Object.fromEntries(state.cashflows.income.map((r) => [r.id, r]));
  const toConcessionalRows = [];
  for (const sc of state.cashflows.superContributions ?? []) {
    const flows = superFlows[sc.accountId];
    if (!flows) continue;
    if (sc.basis === "toConcessionalCap") { toConcessionalRows.push(sc); continue; }
    const concessional = isConcessionalType(sc.type);

    if (sc.basis === "amount") {
      const fyTotals = concessional ? new Float64Array(planYears) : null;
      applyRegular(sc, "client", flows.contributions, fyTotals);
      if (concessional) {
        for (let y = 0; y < planYears; y++) concessionalByOwnerFy[sc.owner][y] += fyTotals[y];
      }
    } else if (sc.basis === "percentOfIncome") {
      const incomeRow = incomeRowsById[sc.incomeRowId];
      if (!incomeRow || !(sc.percent > 0)) continue;
      const bounds = {
        from: resolveRef(sc.from, plan, dateSchedule, "client").planYear,
        to: resolveRef(sc.to, plan, dateSchedule, "client").planYear,
      };
      const incBounds = {
        from: resolveRef(incomeRow.from, plan, dateSchedule, incomeRow.owner).planYear,
        to: resolveRef(incomeRow.to, plan, dateSchedule, incomeRow.owner).planYear,
      };
      for (let m = 0; m < months; m++) {
        const y = yearOfMonth[m];
        if (y < bounds.from || y > bounds.to) continue;
        if (y < incBounds.from || y > incBounds.to) continue;
        let incomeAtM = 0;
        if (incomeRow.frequency === "monthly") incomeAtM = realAmountAt(incomeRow, m, cpi, awote);
        else if (julyMonthIndex(plan, y) === m) incomeAtM = realAmountAt(incomeRow, m, cpi, awote);
        if (incomeAtM <= 0) continue;
        const contrib = incomeAtM * (sc.percent / 100);
        flows.contributions[m] += contrib;
        if (concessional) concessionalByOwnerFy[sc.owner][y] += contrib;
      }
    }
  }

  // "toConcessionalCap": fills whatever headroom remains that FY —
  // credited once, in the FY's July (a cap-fill is an annual-scale
  // concept; the row's own frequency field doesn't apply to it).
  // Processed after every other concessional contribution so the
  // headroom is accurate; a second such row (unusual) sees the first
  // row's fill via the same running total.
  for (const sc of toConcessionalRows) {
    const flows = superFlows[sc.accountId];
    if (!flows) continue;
    const bounds = {
      from: resolveRef(sc.from, plan, dateSchedule, "client").planYear,
      to: resolveRef(sc.to, plan, dateSchedule, "client").planYear,
    };
    for (let y = Math.max(0, bounds.from); y <= Math.min(planYears - 1, bounds.to); y++) {
      const jm = julyMonthIndex(plan, y);
      if (jm == null) continue;
      const rates = superRatesFor(fy0 + y, bracketMode, cpi);
      const headroom = Math.max(0, rates.concessionalCap - concessionalByOwnerFy[sc.owner][y]);
      if (headroom <= 0) continue;
      flows.contributions[jm] += headroom;
      concessionalByOwnerFy[sc.owner][y] += headroom;
    }
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
    incomeByOwner,
    expenses,
    assetFlows,
    superFlows,
    rowTotals,
    oneOffsByAssetYear,
  };
}
