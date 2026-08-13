// Asset class allocation series (Asset class allocations commit) —
// pure, no DOM/Plotly. Derives each plan year's blend across the six
// asset classes (profiles.js's ASSET_CLASS_KEYS) from the engine's own
// per-asset/per-super-account closing balances, weighted by each
// holding's profile's classWeights.
//
// Scope (deliberate, matching the brief): lifestyle assets and
// properties are excluded from the mix entirely — neither carries a
// profile or a classWeights split, so neither has anything meaningful
// to contribute here (this is a different exclusion from the Assets/
// Composite views' chartTreatment, which is about display, not about
// what data exists to show). Super accounts ARE included and follow
// their own allocation, exactly like a financial asset.
//
// A "custom" allocation (bespoke incomePct/growthPct/frankingPct) has
// no class split of its own — per the brief, it borrows its
// volatility-basis profile's (`allocation.volBasis`) classWeights, the
// same profile Monte Carlo already borrows from for variability. Any
// custom-allocation holding included in the mix sets `usesCustom`,
// which the chart surfaces as a footnote.

import { ASSET_CLASS_KEYS } from "./profiles.js";

// The profile object a given allocation resolves to: the selected
// profile directly ("profile" mode), or the volatility-basis profile a
// custom allocation borrows from ("custom" mode) — the same resolution
// Monte Carlo (monteCarlo.js) uses to find a holding's σ/regime
// parameters, and this module uses for its classWeights.
export function profileForAllocation(allocation, profiles) {
  const profileName = allocation?.mode === "custom" ? allocation.volBasis : allocation?.profile;
  return profiles[profileName] ?? null;
}

// The classWeights of the profile a given allocation resolves to (see
// profileForAllocation above).
export function classWeightsForAllocation(allocation, profiles) {
  return profileForAllocation(allocation, profiles)?.classWeights ?? null;
}

function zeroTotals() {
  const t = {};
  for (const k of ASSET_CLASS_KEYS) t[k] = 0;
  return t;
}

// allocationSeries(yearly, assets, superAccounts, profiles) →
//   { perYear: [{ total, byClass: {key: $}, weightPct: {key: %} }, ...],
//     usesCustom: boolean }
//
// byClass/weightPct are always present for every key in
// ASSET_CLASS_KEYS (zero where nothing contributes). weightPct is null
// (rather than a divide-by-zero NaN) for a year with zero total.
export function allocationSeries(yearly, assets, superAccounts, profiles) {
  const holdings = [
    ...assets.filter((a) => a.include && a.class !== "lifestyle")
      .map((a) => ({ id: a.id, allocation: a.allocation, balanceOf: (row) => row.perAssetClosing[a.id] ?? 0 })),
    ...(superAccounts ?? []).filter((sa) => sa.include)
      .map((sa) => ({ id: sa.id, allocation: sa.allocation, balanceOf: (row) => row.superDetail?.[sa.id]?.closing ?? 0 })),
  ];
  const usesCustom = holdings.some((h) => h.allocation?.mode === "custom");

  const perYear = yearly.map((row) => {
    const byClass = zeroTotals();
    let total = 0;
    for (const h of holdings) {
      const balance = h.balanceOf(row);
      if (!balance) continue;
      const weights = classWeightsForAllocation(h.allocation, profiles);
      if (!weights) continue; // stale/unknown profile reference — contributes nothing rather than throwing
      total += balance;
      for (const k of ASSET_CLASS_KEYS) byClass[k] += balance * (weights[k] / 100);
    }
    const weightPct = {};
    for (const k of ASSET_CLASS_KEYS) weightPct[k] = total > 0 ? (byClass[k] / total) * 100 : null;
    return { total, byClass, weightPct };
  });

  return { perYear, usesCustom };
}
