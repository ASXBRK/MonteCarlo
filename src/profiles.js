// Asset class profiles. Tune (mu, sigma) here.
// mu and sigma are annual. mu is a REAL expected return (net of
// inflation) — the simulation runs in today's-dollar terms throughout.
export const PROFILES = {
  Cash:               { mu: 0.005, sigma: 0.01 },
  Conservative:       { mu: 0.020, sigma: 0.05 },
  Balanced:           { mu: 0.035, sigma: 0.08 },
  Growth:             { mu: 0.050, sigma: 0.11 },
  "High Growth":      { mu: 0.060, sigma: 0.14 },
  "Australian Shares":{ mu: 0.065, sigma: 0.17 },
  "Emerging Markets": { mu: 0.075, sigma: 0.22 },
};

export const DEFAULT_PROFILE = "Growth";
