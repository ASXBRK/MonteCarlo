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

// frankingPct: franking level of the profile's income component,
// 0–100. CONFIRMED — set high for Australian-equity-heavy profiles
// (their income is dominated by franked dividends), zero for cash /
// fixed-interest-dominant profiles and direct property (rent is
// unfranked). Inert until the v1.1 tax phase consumes them. See the
// classWeights consistency check below the profile table: these
// figures are independently reproduced (within tolerance) from each
// profile's class weights and a firm-standard 4% fully-franked
// Australian-equity yield.
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

// The implied franking % a profile's class weights reproduce, given
// the yield assumption above — reproduced independently of the stated
// frankingPct so the two can be cross-checked (see the profile table's
// trailing comment column).
export function impliedFrankingPct(weights, incomeReturn) {
  if (incomeReturn <= 0) return 0;
  const frankedIncome = (weights.ausEquity / 100) * AUS_EQUITY_FRANKED_YIELD;
  return (frankedIncome / incomeReturn) * 100;
}

function makeProfile(incomeReturn, growthReturn, sigma, category, frankingPct, growthPct, variant) {
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
    frankingPct,
    classWeights: classWeights(growthPct, variant),
  };
}

// Real expected return at a given CPI. Fisher relation.
export function realMu(profile, cpi) {
  return (1 + profile.totalNominal) / (1 + cpi) - 1;
}

// Consistency check (implied vs stated franking, per profile, at 4%
// fully-franked Australian-equity yield — see impliedFrankingPct
// above). Worked example (Balanced): 50% growth × 45% Aus equity =
// 22.5% of portfolio; × 4% franked yield = 0.9% of the portfolio's
// 3.35% total income = ~26.9% implied franking against the stated
// 25% — a 1.9pp gap, well inside tolerance.
//
//   profile                        growthPct  variant   implied%  stated%  gap
//   Cash                           0          cash        0.0       0      0.0
//   Defensive                      15         neutral     7.7       0     +7.7
//   Moderately Defensive           30         neutral    16.1      15     +1.1
//   Balanced                       50         neutral    26.9      25     +1.9
//   Moderate Growth                70         neutral    32.7      30     +2.7
//   High Growth – Income           85         income     41.6      50     -8.4
//   High Growth – Capital          85         capital    40.8      30    +10.8
//   Accelerated Growth – Income    98         income     43.1      60    -16.9  ← FLAG (>15pp)
//   Accelerated Growth – Growth    98         capital    58.8      35    +23.8  ← FLAG (>15pp)
//   Residential Property           100        property    0.0       0      0.0
//
// The two Accelerated Growth variants are more than 15 percentage
// points out. Per this commit's brief, that is a signal for the firm
// to review the stated franking (or the income/growth return split)
// on those two profiles specifically — not something to paper over by
// adjusting the class weights to fit. See profiles.test.js for the
// programmatic version of this table (computed from the weights below,
// not retyped by hand) and its explicit flag on those two profiles.
export const PROFILES = {
  //                                          income  growth  sigma  category  franking%  growthPct  variant
  "Cash":                        makeProfile(0.0350, 0.0000, 0.015, "cash",      0,         0,   "cash"),
  "Defensive":                   makeProfile(0.0350, 0.0100, 0.030, "cash",      0,        15,   "neutral"),
  "Moderately Defensive":        makeProfile(0.0335, 0.0185, 0.045, "balanced", 15,        30,   "neutral"),
  "Balanced":                    makeProfile(0.0335, 0.0250, 0.060, "balanced", 25,        50,   "neutral"),
  "Moderate Growth":             makeProfile(0.0385, 0.0300, 0.075, "balanced", 30,        70,   "neutral"),
  "High Growth – Income":        makeProfile(0.0450, 0.0350, 0.095, "equity",   50,        85,   "income"),
  "High Growth – Capital":       makeProfile(0.0250, 0.0550, 0.095, "equity",   30,        85,   "capital"),
  "Accelerated Growth – Income": makeProfile(0.0500, 0.0450, 0.120, "equity",   60,        98,   "income"),
  "Accelerated Growth – Growth": makeProfile(0.0200, 0.0750, 0.120, "equity",   35,        98,   "capital"),
  "Residential Property":        makeProfile(0.0450, 0.0500, 0.110, "equity",    0,       100,   "property"),
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
