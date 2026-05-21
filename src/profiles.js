// Asset class profiles. Tune (mu, sigma) here.
// mu and sigma are annual: expected return and standard deviation.
export const PROFILES = {
  Cash:               { mu: 0.030, sigma: 0.01 },
  Conservative:       { mu: 0.050, sigma: 0.05 },
  Balanced:           { mu: 0.065, sigma: 0.08 },
  Growth:             { mu: 0.075, sigma: 0.11 },
  "High Growth":      { mu: 0.085, sigma: 0.14 },
  "Australian Shares":{ mu: 0.090, sigma: 0.17 },
  "Emerging Markets": { mu: 0.100, sigma: 0.22 },
};

export const DEFAULT_PROFILE = "Growth";
