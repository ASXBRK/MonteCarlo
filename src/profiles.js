// Asset class profiles. Each profile carries:
//   mu             — annual real expected return
//   sigma          — long-run annual real σ (display only, e.g. bell curves)
//   sigma_normal   — annual σ during NORMAL regime  (engine input)
//   sigma_stress   — annual σ during STRESS regime  (engine input)
//   p_stay_normal  — P(stay NORMAL | currently NORMAL)
//   p_stay_stress  — P(stay STRESS | currently STRESS)
//
// The two state-dependent σ values are calibrated so that the
// stationary-distribution-weighted variance equals sigma². Calibration
// is transparent below: profile inputs are mu + long-run sigma +
// regime category; the σ_normal / σ_stress numbers are derived.

const REGIME = {
  equity:   { p_stay_normal: 0.985, p_stay_stress: 0.90, stressMultiplier: 2.5 },
  balanced: { p_stay_normal: 0.99,  p_stay_stress: 0.92, stressMultiplier: 2.2 },
  cash:     { p_stay_normal: 0.995, p_stay_stress: 0.85, stressMultiplier: 2.0 },
};

// Stationary weights for a 2-state Markov chain with the given
// "stay" probabilities. Derived from the balance equation
// w_normal * (1 - p_stay_normal) = w_stress * (1 - p_stay_stress).
function stationary({ p_stay_normal, p_stay_stress }) {
  const denom = (1 - p_stay_normal) + (1 - p_stay_stress);
  return {
    w_normal: (1 - p_stay_stress) / denom,
    w_stress: (1 - p_stay_normal) / denom,
  };
}

function makeProfile(mu, sigma, category) {
  const r = REGIME[category];
  const { w_normal, w_stress } = stationary(r);
  const k = r.stressMultiplier;
  const sigma_normal = sigma / Math.sqrt(w_normal + w_stress * k * k);
  const sigma_stress = k * sigma_normal;
  return {
    mu,
    sigma,
    sigma_normal,
    sigma_stress,
    p_stay_normal: r.p_stay_normal,
    p_stay_stress: r.p_stay_stress,
  };
}

export const PROFILES = {
  Cash:               makeProfile(0.005, 0.015, "cash"),
  Conservative:       makeProfile(0.020, 0.050, "balanced"),
  Balanced:           makeProfile(0.035, 0.080, "balanced"),
  Growth:             makeProfile(0.050, 0.110, "equity"),
  "High Growth":      makeProfile(0.060, 0.140, "equity"),
  "Australian Shares":makeProfile(0.065, 0.170, "equity"),
  "Emerging Markets": makeProfile(0.075, 0.220, "equity"),
};

export const DEFAULT_PROFILE = "Growth";
