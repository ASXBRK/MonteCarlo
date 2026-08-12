// Deterministic projection engine — pure, pre-tax, real terms only.
//
// Consumes buildSchedules() output and implements the locked monthly
// ledger loop (conventions 7–11):
//
//   For each month, in order:
//     a. Grow every included asset: B ← B × (1 + r_month).
//     b. Apply asset-targeted flows: contributions in, withdrawals
//        out, one-offs in/out. An outflow exceeding the asset's
//        balance takes what's there; the remainder is UNFUNDED and
//        does NOT cascade to other assets (explicit withdrawals are
//        instructions about a specific asset).
//     c. Household net = income − expenses (these never touch assets
//        directly).
//     d. Surplus: settings.surplus — "spend" → disappears; "invest" →
//        added to the nominated asset (fallback to spend when the
//        target is missing/excluded).
//     e. Deficit: drawn from included assets in settings.fundingOrder,
//        draining each to zero before the next; any remainder is
//        unfunded cashflow.
//
//   Balances never go negative. Excluded assets do not exist to the
//   engine. Returns: nominal gross (profile total or custom
//   income+growth) minus icrPct, converted to real via Fisher, then to
//   a monthly rate geometrically. The engine computes REAL values
//   only; nominal is a display-time scaling.
//
// Distribution treatment and the income/growth split are inert until
// the tax phase — all returns accrue in the asset.

import { PROFILES } from "./profiles.js";
import { buildSchedules } from "./schedule.js";

// Real monthly return for an asset (convention 7).
export function assetMonthlyRate(asset, cpi, profiles = PROFILES) {
  let grossNominal = 0;
  if (asset.allocation.mode === "custom") {
    grossNominal = (asset.allocation.incomePct + asset.allocation.growthPct) / 100;
  } else {
    const p = profiles[asset.allocation.profile];
    grossNominal = p ? p.totalNominal : 0;
  }
  const netNominal = grossNominal - asset.icrPct / 100;
  const realAnnual = (1 + netNominal) / (1 + cpi) - 1;
  return Math.pow(1 + realAnnual, 1 / 12) - 1;
}

// projectPlan(state) → {
//   schedule,                       // the buildSchedules() output
//   monthly: {
//     combined,                     // Float64Array, length months+1 (index 0 = opening)
//     perAsset: { [assetId]: Float64Array },  // same shape
//   },
//   yearly: [ ... one row per plan year ... ],
//   shortfall: { firstMonth, planYear, fyLabel, clientAge, total } | null,
// }
export function projectPlan(state, profiles = PROFILES) {
  const schedule = buildSchedules(state);
  const cpi = state.assumptions.cpi;
  const included = state.assets.filter((a) => a.include);
  const ids = included.map((a) => a.id);
  const months = schedule.months;

  const rate = {};
  const bal = {};
  const series = {};
  for (const a of included) {
    rate[a.id] = assetMonthlyRate(a, cpi, profiles);
    bal[a.id] = a.balance;
    series[a.id] = new Float64Array(months + 1);
    series[a.id][0] = a.balance;
  }
  const combined = new Float64Array(months + 1);
  combined[0] = ids.reduce((s, id) => s + bal[id], 0);

  // Funding order limited to included assets (A.2 invariant holds, but
  // stay defensive).
  const fundingOrder = state.settings.fundingOrder.filter((id) => id in bal);
  const surplusMode = state.settings.surplus.mode;
  const surplusTargetId =
    surplusMode === "invest" && state.settings.surplus.assetId in bal
      ? state.settings.surplus.assetId
      : null;

  // Yearly accumulators.
  const yearly = [];
  const mkYearRow = (y) => ({
    fyLabel: schedule.fyLabels[y],
    clientAge: schedule.clientAges[y],
    partnerAge: schedule.partnerAges ? schedule.partnerAges[y] : null,
    income: 0,
    expenses: 0,
    surplusOrDeficit: 0,
    surplusInvested: 0,
    deficitFundedFromAssets: 0,
    unfundedCashflow: 0,
    contributions: 0,
    withdrawals: 0,
    oneOffsNet: 0,
    growth: 0,
    fees: null,   // reserved
    tax: null,    // reserved for B.1
    openingBalance: 0,
    closingBalance: 0,
    perAssetClosing: {},
  });
  let row = mkYearRow(0);
  row.openingBalance = combined[0];

  let firstUnfundedMonth = -1;
  let totalUnfunded = 0;

  const recordUnfunded = (amount, m) => {
    if (amount <= 0) return;
    totalUnfunded += amount;
    row.unfundedCashflow += amount;
    if (firstUnfundedMonth === -1) firstUnfundedMonth = m;
  };

  for (let m = 0; m < months; m++) {
    const y = schedule.yearOfMonth[m];
    if (y !== yearly.length) {
      // Year rolled over — close out the previous row.
      row.closingBalance = combined[m];
      for (const id of ids) row.perAssetClosing[id] = series[id][m];
      yearly.push(row);
      row = mkYearRow(y);
      row.openingBalance = combined[m];
    }

    // a. Growth.
    for (const id of ids) {
      const g = bal[id] * rate[id];
      bal[id] += g;
      row.growth += g;
    }

    // b. Asset-targeted flows.
    for (const id of ids) {
      const flows = schedule.assetFlows[id];
      const contrib = flows.contributions[m];
      if (contrib > 0) {
        bal[id] += contrib;
        row.contributions += contrib;
      }
      const wd = flows.withdrawals[m];
      if (wd > 0) {
        const paid = Math.min(wd, bal[id]);
        bal[id] -= paid;
        row.withdrawals += paid;
        recordUnfunded(wd - paid, m);
      }
      const oneOff = flows.oneOffs[m];
      if (oneOff > 0) {
        bal[id] += oneOff;
        row.oneOffsNet += oneOff;
      } else if (oneOff < 0) {
        const want = -oneOff;
        const paid = Math.min(want, bal[id]);
        bal[id] -= paid;
        row.oneOffsNet -= paid;
        recordUnfunded(want - paid, m);
      }
    }

    // c. Household position.
    const inc = schedule.income[m];
    const exp = schedule.expenses[m];
    const net = inc - exp;
    row.income += inc;
    row.expenses += exp;
    row.surplusOrDeficit += net;

    if (net > 0) {
      // d. Surplus.
      if (surplusTargetId) {
        bal[surplusTargetId] += net;
        row.surplusInvested += net;
      }
      // "spend" → disappears.
    } else if (net < 0) {
      // e. Deficit funding.
      let shortfall = -net;
      for (const id of fundingOrder) {
        if (shortfall <= 0) break;
        const take = Math.min(shortfall, bal[id]);
        bal[id] -= take;
        shortfall -= take;
        row.deficitFundedFromAssets += take;
      }
      recordUnfunded(shortfall, m);
    }

    // Snapshot month end.
    let total = 0;
    for (const id of ids) {
      series[id][m + 1] = bal[id];
      total += bal[id];
    }
    combined[m + 1] = total;
  }

  // Close the final year.
  row.closingBalance = combined[months];
  for (const id of ids) row.perAssetClosing[id] = series[id][months];
  yearly.push(row);

  let shortfall = null;
  if (firstUnfundedMonth >= 0) {
    const y = schedule.yearOfMonth[firstUnfundedMonth];
    shortfall = {
      firstMonth: firstUnfundedMonth,
      planYear: y,
      fyLabel: schedule.fyLabels[y],
      clientAge: schedule.clientAges[y],
      total: totalUnfunded,
    };
  }

  return {
    schedule,
    monthly: { combined, perAsset: series },
    yearly,
    shortfall,
  };
}
