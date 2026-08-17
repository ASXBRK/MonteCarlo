// Smart defaults (spec 19, Commit 1) — a registry naming what kind of
// default every pre-filled field is, so the interface can say so rather
// than let a computed-looking number pass as a considered one.
//
// Every default is one of three kinds (the spec's own words):
//   HOUSE      — the firm's own assumption (profile returns, CPI, AWOTE,
//                mortgage rate, an LVR ceiling convention).
//   LEGISLATED — a figure from law or an official rate (caps, thresholds,
//                duty, land tax).
//   DERIVED    — computed from other inputs the user has already given;
//                a derived default RECOMPUTES while it tracks its inputs
//                and stops the moment the user overrides the field
//                directly (see planState.js's property rent/expenses
//                `isDefault` flag — the only two fields here whose
//                SOURCE value changes during a session; every other
//                entry is a fixed constant, so "recomputing" it is
//                vacuous and only the provenance disclosure matters).
//
// Pure — no DOM. main.js's tooltipHTML(describeDefault(...)) is the only
// consumer; each entry's `describe(ctx)` returns the exact sentence
// spec 19 asks for: "Default: 5.5% — house view (Residential Property
// profile growth component)" / "Default: $16,000 — derived (2% of
// purchase price)".

export const DEFAULT_KIND = { HOUSE: "house", LEGISLATED: "legislated", DERIVED: "derived" };

export const SMART_DEFAULTS = {
  "property.growthPct": {
    kind: DEFAULT_KIND.HOUSE,
    describe: (ctx) => `Default: ${fmtPct(ctx.value)} — house view (Residential Property profile growth component)`,
  },
  "property.expensesAmount": {
    kind: DEFAULT_KIND.DERIVED,
    describe: (ctx) => `Default: ${fmtDollars(ctx.value)} — derived (20% of gross rent); recomputes as rent changes until you enter your own figure`,
  },
  "property.purchaseCostsPct": {
    kind: DEFAULT_KIND.DERIVED,
    describe: () => `Default: 2% — derived (2% of purchase price)`,
  },
  "property.agentFeesPct": {
    kind: DEFAULT_KIND.DERIVED,
    describe: () => `Default: 2.5% — derived (2.5% of sale price)`,
  },
  "property.lvrPct": {
    kind: DEFAULT_KIND.HOUSE,
    describe: () => `Default: 80% — house view (typical lender LVR ceiling for a security property)`,
  },
  "property.rentAmount": {
    kind: DEFAULT_KIND.DERIVED,
    describe: (ctx) => `Default: ${fmtDollars(ctx.value)} — derived (4% of property value); recomputes as value changes until you enter your own figure`,
  },
  "education.indexExtraPct": {
    kind: DEFAULT_KIND.HOUSE,
    describe: () => `Default: CPI + 2.0% — house view (school fees have historically outrun CPI)`,
  },
  "assumptions.cpi": {
    kind: DEFAULT_KIND.HOUSE,
    describe: (ctx) => `Default: ${fmtPct(ctx.value)} — house view (firm CPI assumption)`,
  },
  "assumptions.awote": {
    kind: DEFAULT_KIND.HOUSE,
    describe: (ctx) => `Default: ${fmtPct(ctx.value)} — house view (firm wage-growth assumption)`,
  },
  "assumptions.mortgageRate": {
    kind: DEFAULT_KIND.HOUSE,
    describe: (ctx) => `Default: ${fmtPct(ctx.value)} — house view (firm mortgage-rate assumption)`,
  },
};

function fmtPct(n) {
  return `${Number(n ?? 0).toFixed(1)}%`;
}
function fmtDollars(n) {
  return `$${Math.round(Number(n ?? 0)).toLocaleString()}`;
}

// describeDefault(key, ctx) → the tooltip sentence for a registered
// default, or null for an unregistered key (callers render nothing
// rather than a broken tooltip).
export function describeDefault(key, ctx = {}) {
  return SMART_DEFAULTS[key]?.describe(ctx) ?? null;
}

export function defaultKind(key) {
  return SMART_DEFAULTS[key]?.kind ?? null;
}
