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
// their own allocation, exactly like a financial asset. Bonds (spec
// 25, Commit 2) are included the same way — "as their own class" (the
// spec's own words) simply means folded into the SAME class-weighted
// mix every other holding already contributes to, not a separate
// bucket of its own.
//
// A "custom" allocation (bespoke incomePct/growthPct/frankingPct) has
// no class split of its own — per the brief, it borrows its
// volatility-basis profile's (`allocation.volBasis`) classWeights, the
// same profile Monte Carlo already borrows from for variability. Any
// custom-allocation holding included in the mix sets `usesCustom`,
// which the chart surfaces as a footnote.

import { ASSET_CLASS_KEYS } from "./profiles.js";
import { precomputeGlideYearly } from "./glidePaths.js";

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

// allocationSeries(yearly, assets, superAccounts, profiles, bonds, glidePaths, ages) →
//   { perYear: [{ total, byClass: {key: $}, weightPct: {key: %} }, ...],
//     usesCustom: boolean }
//
// byClass/weightPct are always present for every key in
// ASSET_CLASS_KEYS (zero where nothing contributes). weightPct is null
// (rather than a divide-by-zero NaN) for a year with zero total.
//
// `glidePaths`/`ages` (spec 32, Commit 4) are this module's OWN
// independent read of plan.glidePaths — never sourced from the engine's
// result (which carries no glide-path field at all: adding one would be
// an engine-contract-shape change for a figure this chart can derive
// itself from plan state alone). Both this chart and deterministic.js
// call the SAME pure precomputeGlideYearly with the SAME inputs, so the
// two can never show a different glide position for the same plan — the
// "one source of truth" glidePaths.js's own header promises. `ages` is
// `{ client, partner }` FULL, absolute-plan-year age arrays (schedule.
// clientAges/partnerAges — never pre-sliced to a period selection: see
// `yearIndexOf` below for why) — financial assets anchor to the client
// (the schema's default anchor for a joint-ownable row), super accounts
// to their own owner, matching deterministic.js's own anchor choice
// exactly.
//
// `yearIndexOf(y)` maps a `yearly`-array index to its ABSOLUTE plan year
// (identity by default, for a caller passing the full, unsliced yearly
// array). A caller under a period selector passes a pre-sliced/reordered
// `yearly` (main.js's own `yearIdxs.map(y => projection.yearly[y])`) —
// `ages` must stay UNSLICED and indexed via this mapping instead of
// slicing it the same way, because "drift" rebalance mode carries state
// year over year (glidePaths.js's own header): slicing the age array
// would restart that carried state at the selection's own first year,
// silently changing what "drift" reports for a period view. Rebalance
// mode "annual" is unaffected either way (it never carries state), so
// this only matters for drift — but there is no way to know which mode a
// referenced glide path uses without already having resolved it, so the
// full-range precompute is used unconditionally.
export function allocationSeries(yearly, assets, superAccounts, profiles, bonds = [], glidePaths = [], ages = {}, yearIndexOf = (y) => y) {
  const glidePathById = (id) => (glidePaths ?? []).find((gp) => gp.id === id) ?? null;
  const holdings = [
    ...assets.filter((a) => a.include && a.class !== "lifestyle")
      .map((a) => ({ id: a.id, allocation: a.allocation, ownerAges: ages.client, balanceOf: (row) => row.perAssetClosing[a.id] ?? 0 })),
    ...(superAccounts ?? []).filter((sa) => sa.include)
      .map((sa) => ({ id: sa.id, allocation: sa.allocation, ownerAges: sa.owner === "partner" ? ages.partner : ages.client, balanceOf: (row) => row.superDetail?.[sa.id]?.closing ?? 0 })),
    ...(bonds ?? []).filter((b) => b.include)
      .map((b) => ({ id: b.id, allocation: b.allocation, ownerAges: null, balanceOf: (row) => row.bondDetail?.[b.id]?.closing ?? 0 })),
  ];
  const usesCustom = holdings.some((h) => h.allocation?.mode === "custom");

  // Per-holding, per-plan-year class weights for every glidePath-mode
  // holding, precomputed ONCE (not per year inside the loop below) —
  // same "resolve once, index by year" shape deterministic.js's own
  // meta[id].glideYearly uses. A dangling glidePathId or a holding whose
  // owner has no age array (bonds — out of scope for glide paths, see
  // this module's own header) contributes nothing, same as an unknown
  // profile reference already does below.
  const glideWeightsById = {};
  for (const h of holdings) {
    if (h.allocation?.mode !== "glidePath" || !h.ownerAges) continue;
    const gp = glidePathById(h.allocation.glidePathId);
    if (gp) glideWeightsById[h.id] = precomputeGlideYearly(gp, h.ownerAges, profiles).map((gy) => gy.classWeights);
  }

  const perYear = yearly.map((row, y) => {
    const byClass = zeroTotals();
    let total = 0;
    for (const h of holdings) {
      const balance = h.balanceOf(row);
      if (!balance) continue;
      const weights = glideWeightsById[h.id] ? glideWeightsById[h.id][yearIndexOf(y)] : classWeightsForAllocation(h.allocation, profiles);
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
