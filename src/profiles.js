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
// 0–100. PLACEHOLDER values pending firm confirmation — set high for
// Australian-equity-heavy profiles (their income is dominated by
// franked dividends), zero for cash / fixed-interest-dominant
// profiles and direct property (rent is unfranked). Inert until the
// v1.1 tax phase consumes them.
function makeProfile(incomeReturn, growthReturn, sigma, category, frankingPct = 0) {
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
  };
}

// Real expected return at a given CPI. Fisher relation.
export function realMu(profile, cpi) {
  return (1 + profile.totalNominal) / (1 + cpi) - 1;
}

export const PROFILES = {
  //                                          income  growth  sigma  category  franking%
  "Cash":                        makeProfile(0.0350, 0.0000, 0.015, "cash",      0),
  "Defensive":                   makeProfile(0.0350, 0.0100, 0.030, "cash",      0),
  "Moderately Defensive":        makeProfile(0.0335, 0.0185, 0.045, "balanced", 15),
  "Balanced":                    makeProfile(0.0335, 0.0250, 0.060, "balanced", 25),
  "Moderate Growth":             makeProfile(0.0385, 0.0300, 0.075, "balanced", 30),
  "High Growth – Income":        makeProfile(0.0450, 0.0350, 0.095, "equity",   50),
  "High Growth – Capital":       makeProfile(0.0250, 0.0550, 0.095, "equity",   30),
  "Accelerated Growth – Income": makeProfile(0.0500, 0.0450, 0.120, "equity",   60),
  "Accelerated Growth – Growth": makeProfile(0.0200, 0.0750, 0.120, "equity",   35),
  "Residential Property":        makeProfile(0.0450, 0.0500, 0.110, "equity",    0),
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
