// Asset class profiles — firm's proposed assumption set.
//
// Each profile carries:
//   incomeReturn   — annual nominal income component of total return
//   growthReturn   — annual nominal growth component
//   totalNominal   — sum of the two (annual nominal)
//   sigma          — long-run annual REAL σ (calibrated; see below)
//   sigma_normal, sigma_stress — engine inputs, derived from sigma via
//                     the two-state Markov calibration below
//   p_stay_normal, p_stay_stress — transition probabilities per regime
//
// mu is NOT stored on the profile. Real expected return is derived at
// simulation time as (1 + totalNominal) / (1 + cpi) - 1, so changing
// the CPI parameter in the Parameters modal flows through everywhere.
//
// σ values are already in real terms (the model's engine convention).
// The defensive-end σs (Cash 1.5%, Defensive 3%) are deliberately
// higher than nominal-terms intuition would suggest — real cash and
// bond variance are dominated by inflation variance, not by their
// nominal price fluctuations.

const REGIME = {
  cash:     { p_stay_normal: 0.995, p_stay_stress: 0.85, stressMultiplier: 2.0 },
  balanced: { p_stay_normal: 0.99,  p_stay_stress: 0.92, stressMultiplier: 2.2 },
  equity:   { p_stay_normal: 0.985, p_stay_stress: 0.90, stressMultiplier: 2.5 },
};

function stationary({ p_stay_normal, p_stay_stress }) {
  const denom = (1 - p_stay_normal) + (1 - p_stay_stress);
  return {
    w_normal: (1 - p_stay_stress) / denom,
    w_stress: (1 - p_stay_normal) / denom,
  };
}

// Franking is DERIVED, not stored (Derive franking from class weights
// commit) — a profile's franking level is a property of its asset
// mix (how much is Australian equity, at the firm-standard 4% fully-
// franked yield) and its stated income return, not an independent
// number someone set by eye. Call impliedFrankingPct(profile.
// classWeights, profile.incomeReturn) wherever a profile's franking
// is needed (see deterministic.js's assetReturnComponents and
// main.js's Parameters modal). This was a stored field (frankingPct)
// until the classWeights consistency check below showed it disagreeing
// with the weights it was meant to be checked against — carrying both
// invited permanent disagreement, so only one survives. A custom
// allocation is unaffected: it still carries its own user-entered
// frankingPct (planState.js's clampAllocation), since a custom mix has
// no profile-level class weights to derive one from.
//
// The practical upshot: when the ladder below is replaced with real
// firm allocations, every profile's franking figure updates with it —
// there is nothing left to separately reconfirm.
//
// classWeights: this profile's split across the six asset classes
// (Australian/International equity, Property & infrastructure,
// Australian/International fixed interest, Cash), 0–100, summing to
// 100 — drives the allocation-over-time chart (Commit: asset class
// allocations). Derived, not independently set, from two inputs:
//   growthPct       — the growth/defensive ladder position (0–100),
//                      consistent with the profile's own σ.
//   variant         — "neutral" | "income" | "capital" | "cash" |
//                      "property": which of the growth-sleeve equity
//                      splits below applies (or the two all-one-class
//                      overrides for Cash and Residential Property).
// Growth sleeve (of growthPct%): income variants tilt Australian
// (55/30/15 Aus/Int/Property — Australian equities yield ~4% fully
// franked, so the "Income" variants concentrate there); capital
// variants tilt international (30/55/15 — international's ~2%
// unfranked yield suits the "Capital"/"Growth" variants, which want
// growth, not income); neutral profiles split 45/40/15.
// Defensive sleeve (of (100−growthPct)%): always 50% Australian fixed
// interest / 25% international fixed interest / 25% cash, except the
// Cash profile itself, which is 100% cash outright.
const GROWTH_SPLIT = {
  neutral: { ausEquity: 0.45, intEquity: 0.40, property: 0.15 },
  income:  { ausEquity: 0.55, intEquity: 0.30, property: 0.15 },
  capital: { ausEquity: 0.30, intEquity: 0.55, property: 0.15 },
};
const DEFENSIVE_SPLIT = { ausFixedInterest: 0.50, intFixedInterest: 0.25, cash: 0.25 };

function classWeights(growthPct, variant) {
  if (variant === "cash") {
    return { ausEquity: 0, intEquity: 0, property: 0, ausFixedInterest: 0, intFixedInterest: 0, cash: 100 };
  }
  if (variant === "property") {
    return { ausEquity: 0, intEquity: 0, property: 100, ausFixedInterest: 0, intFixedInterest: 0, cash: 0 };
  }
  const g = GROWTH_SPLIT[variant];
  const defensivePct = 100 - growthPct;
  return {
    ausEquity: growthPct * g.ausEquity,
    intEquity: growthPct * g.intEquity,
    property: growthPct * g.property,
    ausFixedInterest: defensivePct * DEFENSIVE_SPLIT.ausFixedInterest,
    intFixedInterest: defensivePct * DEFENSIVE_SPLIT.intFixedInterest,
    cash: defensivePct * DEFENSIVE_SPLIT.cash,
  };
}

// The firm-standard assumption behind the consistency check below:
// Australian equity income is ~4% fully franked; every other class's
// income (international equity ~2% unfranked, property rent,
// fixed-interest/cash interest) is unfranked, so it contributes
// nothing to a profile's franking figure in this simplified model.
const AUS_EQUITY_FRANKED_YIELD = 0.04;

// The franking % a profile's class weights imply, given the yield
// assumption above and the profile's own stated income return — the
// sole source of a profile's franking figure (see the header comment).
export function impliedFrankingPct(weights, incomeReturn) {
  if (incomeReturn <= 0) return 0;
  const frankedIncome = (weights.ausEquity / 100) * AUS_EQUITY_FRANKED_YIELD;
  return (frankedIncome / incomeReturn) * 100;
}

function makeProfile(incomeReturn, growthReturn, sigma, category, growthPct, variant) {
  const r = REGIME[category];
  const { w_normal, w_stress } = stationary(r);
  const k = r.stressMultiplier;
  const sigma_normal = sigma / Math.sqrt(w_normal + w_stress * k * k);
  const sigma_stress = k * sigma_normal;
  const totalNominal = incomeReturn + growthReturn;
  return {
    incomeReturn, growthReturn, totalNominal, sigma,
    sigma_normal, sigma_stress,
    p_stay_normal: r.p_stay_normal,
    p_stay_stress: r.p_stay_stress,
    classWeights: classWeights(growthPct, variant),
  };
}

// Real expected return at a given CPI. Fisher relation.
export function realMu(profile, cpi) {
  return (1 + profile.totalNominal) / (1 + cpi) - 1;
}

// Derived franking, per profile, at the 4% fully-franked Australian-
// equity yield assumption (see impliedFrankingPct above). Worked
// example (Balanced): 50% growth × 45% Aus equity = 22.5% of
// portfolio; × 4% franked yield = 0.9% of the portfolio's 3.35% total
// income = ~26.9% derived franking.
//
// The "previously-stated" column is history, not a live figure — the
// frankingPct field this commit removes, kept here only so the record
// of what changed (and by how much) isn't lost. profiles.test.js
// checks the six that were already close (≤3pp) still are; it does
// NOT re-flag the other four against this now-deleted number, since
// there is no longer a second, independent figure to disagree with.
//
//   profile                        growthPct  variant   derived%  previously-stated%  gap
//   Cash                           0          cash        0.0            0            0.0
//   Defensive                      15         neutral     7.7            0           +7.7
//   Moderately Defensive           30         neutral    16.1           15           +1.1
//   Balanced                       50         neutral    26.9           25           +1.9
//   Moderate Growth                70         neutral    32.7           30           +2.7
//   High Growth – Income           85         income     41.6           50           -8.4
//   High Growth – Capital          85         capital    40.8           30          +10.8
//   Accelerated Growth – Income    98         income     43.1           60          -16.9
//   Accelerated Growth – Growth    98         capital    58.8           35          +23.8
//   Residential Property           100        property    0.0            0            0.0
//
// RESIDUAL CMA QUESTION (flagged for firm review — not adjusted here):
// the two Accelerated Growth variants' income/growth return SPLIT
// looks inconsistent with their own class weights, independent of
// franking. Accelerated Growth – Growth states 2.00% income against
// 7.50% growth; its class weights (98% growth sleeve, capital-tilted:
// ~29% Australian equity, ~54% international, ~15% property) at the
// same yield assumptions used above (Australian equity ~4%,
// international ~2%, property ~4%) generate roughly
// 0.29×4% + 0.54×2% + 0.15×4% ≈ 2.85% income — well above the 2.00%
// stated. Reaching 2.00% from that mix requires an unusually
// international, low-yield growth allocation. Accelerated Growth –
// Income has the mirror problem: its class weights (~54% Australian,
// ~29% international, ~15% property) imply roughly
// 0.54×4% + 0.29×2% + 0.15×4% ≈ 3.34% income against its 5.00% stated
// figure — an unusually concentrated, high-yield mix would be needed
// to reach that. Both are flagged for CMA review of the income/growth
// split on these two profiles specifically; the class weights
// themselves are the defensible part of this commit and are not
// adjusted to fit.
export const PROFILES = {
  //                                          income  growth  sigma  category  growthPct  variant
  "Cash":                        makeProfile(0.0350, 0.0000, 0.015, "cash",       0,   "cash"),
  "Defensive":                   makeProfile(0.0350, 0.0100, 0.030, "cash",      15,   "neutral"),
  "Moderately Defensive":        makeProfile(0.0335, 0.0185, 0.045, "balanced",  30,   "neutral"),
  "Balanced":                    makeProfile(0.0335, 0.0250, 0.060, "balanced",  50,   "neutral"),
  "Moderate Growth":             makeProfile(0.0385, 0.0300, 0.075, "balanced",  70,   "neutral"),
  "High Growth – Income":        makeProfile(0.0450, 0.0350, 0.095, "equity",    85,   "income"),
  "High Growth – Capital":       makeProfile(0.0250, 0.0550, 0.095, "equity",    85,   "capital"),
  "Accelerated Growth – Income": makeProfile(0.0500, 0.0450, 0.120, "equity",    98,   "income"),
  "Accelerated Growth – Growth": makeProfile(0.0200, 0.0750, 0.120, "equity",    98,   "capital"),
  "Residential Property":        makeProfile(0.0450, 0.0500, 0.110, "equity",   100,   "property"),
};

// Asset class keys (in a fixed, stable display order) and their
// display labels — the allocation-over-time chart's stacking order
// and legend text (Asset class allocations commit).
export const ASSET_CLASS_KEYS = [
  "ausEquity", "intEquity", "property", "ausFixedInterest", "intFixedInterest", "cash",
];
export const ASSET_CLASS_LABELS = {
  ausEquity: "Australian equity",
  intEquity: "International equity",
  property: "Property & infrastructure",
  ausFixedInterest: "Australian fixed interest",
  intFixedInterest: "International fixed interest",
  cash: "Cash",
};

export const DEFAULT_PROFILE = "Balanced";

// The defensive bucket in drawdown holds Cash.
export const DEFENSIVE_PROFILE = "Cash";

// Risk ladder for the tornado's asset-class goal-seek and ±1-step
// perturbations. Each rung represents a distinct risk level. Sibling
// variants inside a rung differ only in income/growth composition —
// stepping between them is a null move on the risk ladder. When
// stepping between rungs, preserve the sibling flavour by index (an
// "Income" variant in one rung maps to the "Income" variant of the
// next). Residential Property is NOT on the ladder — it's a distinct
// asset class, not a step on the diversified risk sequence.
export const RISK_RUNGS = [
  { label: "Cash",                 assets: ["Cash"] },
  { label: "Defensive",            assets: ["Defensive"] },
  { label: "Moderately Defensive", assets: ["Moderately Defensive"] },
  { label: "Balanced",             assets: ["Balanced"] },
  { label: "Moderate Growth",      assets: ["Moderate Growth"] },
  { label: "High Growth",          assets: ["High Growth – Income", "High Growth – Capital"] },
  { label: "Accelerated Growth",   assets: ["Accelerated Growth – Income", "Accelerated Growth – Growth"] },
];

// Find the (rungIndex, variantIndex) of a given asset on the ladder,
// or null if the asset is off-ladder (Residential Property).
export function rungOf(asset) {
  for (let r = 0; r < RISK_RUNGS.length; r++) {
    const v = RISK_RUNGS[r].assets.indexOf(asset);
    if (v >= 0) return { rungIndex: r, variantIndex: v };
  }
  return null;
}

// Neighbour asset on the ladder in a given direction ("up" = riskier,
// "down" = less risky). Preserves variant index when the target rung
// has multiple siblings; clamps to the target rung's variant count.
// Returns null when the current asset is off-ladder or the step falls
// off either end.
export function neighbourAsset(asset, direction) {
  const pos = rungOf(asset);
  if (!pos) return null;
  const next = direction === "up" ? pos.rungIndex + 1 : pos.rungIndex - 1;
  if (next < 0 || next >= RISK_RUNGS.length) return null;
  const rung = RISK_RUNGS[next];
  const v = Math.min(pos.variantIndex, rung.assets.length - 1);
  return rung.assets[v];
}
