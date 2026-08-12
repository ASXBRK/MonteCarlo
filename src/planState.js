// Plan/portfolio state model for the multi-portfolio input panel.
//
// Pure functions only — no DOM, no storage. main.js owns persistence
// (localStorage) and rendering; this module owns shape, defaults,
// validation/clamping, and derived summaries, so the whole model is
// unit-testable in Node.
//
// Schema is versioned (schemaVersion) so later phases can migrate
// stored blobs instead of discarding them.

export const SCHEMA_VERSION = 1;

// --- id generation ---------------------------------------------------

let counter = 0;
export function uid(prefix = "id") {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// --- defaults ---------------------------------------------------------

export function defaultPlan(now = new Date()) {
  return {
    currentAge: 40,
    endAge: 90,
    startYear: now.getFullYear(),
  };
}

// Contributions default to the full accumulation window; withdrawals
// default to starting at a retirement-ish age (65, clamped into the
// plan window) and running to end age.
export function createCashflow(kind, plan) {
  const from = kind === "withdrawal"
    ? clampInt(65, plan.currentAge, plan.endAge)
    : plan.currentAge;
  return {
    id: uid("cf"),
    amount: 0,
    frequency: "monthly",
    fromAge: from,
    toAge: plan.endAge,
    indexed: true,
  };
}

export function createLumpSum(plan) {
  return {
    id: uid("ls"),
    amount: 0,
    direction: "in",
    age: plan.currentAge,
  };
}

export function createPortfolio(plan, existing = [], profileKeys = []) {
  const n = nextPortfolioNumber(existing);
  const middleProfile = profileKeys.length
    ? profileKeys[Math.floor((profileKeys.length - 1) / 2)]
    : null;
  return {
    id: uid("pf"),
    name: `Portfolio ${n}`,
    include: true,
    balance: 100000,
    profile: middleProfile,
    fees: { adviserPct: 0, icrPct: 0, flatPa: 0 },
    contributions: [createCashflow("contribution", plan)],
    withdrawals: [],
    lumpSums: [],
  };
}

function nextPortfolioNumber(existing) {
  let max = 0;
  for (const p of existing) {
    const m = /^Portfolio (\d+)$/.exec(p.name || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Math.max(max, existing.length) + 1;
}

export function defaultState(profileKeys = [], now = new Date()) {
  const plan = defaultPlan(now);
  return {
    schemaVersion: SCHEMA_VERSION,
    plan,
    portfolios: [createPortfolio(plan, [], profileKeys)],
    display: { units: "real" },
    assumptions: { cpi: 0.025 },
  };
}

// --- validation / clamping ---------------------------------------------

export function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function clampNumber(v, lo = 0, hi = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// Clamp plan fields themselves into legal ranges.
export function clampPlan(plan) {
  const currentAge = clampInt(plan.currentAge, 18, 100);
  let endAge = clampInt(plan.endAge, 18, 120);
  if (endAge <= currentAge) endAge = currentAge + 1;
  const startYear = clampInt(plan.startYear, 1900, 2200);
  return { currentAge, endAge, startYear };
}

// Clamp one cashflow's ages into the plan window. Silent, per spec —
// used when plan ages change under existing rows.
export function clampCashflow(cf, plan) {
  const fromAge = clampInt(cf.fromAge, plan.currentAge, plan.endAge);
  const toAge = clampInt(cf.toAge, fromAge, plan.endAge);
  return { ...cf, fromAge, toAge };
}

export function clampLumpSum(ls, plan) {
  return { ...ls, age: clampInt(ls.age, plan.currentAge, plan.endAge) };
}

// Re-clamp every cashflow/lump sum in every portfolio after a plan-age
// change. Returns a new state object (does not mutate).
export function clampAllToPlan(state) {
  const plan = clampPlan(state.plan);
  const portfolios = state.portfolios.map((p) => ({
    ...p,
    contributions: p.contributions.map((c) => clampCashflow(c, plan)),
    withdrawals: p.withdrawals.map((w) => clampCashflow(w, plan)),
    lumpSums: p.lumpSums.map((l) => clampLumpSum(l, plan)),
  }));
  return { ...state, plan, portfolios };
}

// --- persistence helpers ------------------------------------------------

export function serialize(state) {
  return JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION });
}

// Parse + validate a stored blob. Returns a clamped state or null if
// the blob is unusable (caller falls back to defaultState). Never
// throws.
export function hydrate(json, profileKeys = []) {
  try {
    const raw = JSON.parse(json);
    if (!raw || typeof raw !== "object") return null;
    if (raw.schemaVersion !== SCHEMA_VERSION) return null; // future: migrate
    if (!raw.plan || !Array.isArray(raw.portfolios) || raw.portfolios.length === 0) return null;

    const plan = clampPlan(raw.plan);
    const knownProfiles = new Set(profileKeys);
    const fallbackProfile = profileKeys.length
      ? profileKeys[Math.floor((profileKeys.length - 1) / 2)]
      : null;

    const portfolios = raw.portfolios.map((p, i) => ({
      id: typeof p.id === "string" && p.id ? p.id : uid("pf"),
      name: typeof p.name === "string" && p.name.trim() ? p.name : `Portfolio ${i + 1}`,
      include: p.include !== false,
      balance: clampNumber(p.balance, 0),
      profile: knownProfiles.has(p.profile) ? p.profile : fallbackProfile,
      fees: {
        adviserPct: clampNumber(p.fees?.adviserPct, 0, 100),
        icrPct: clampNumber(p.fees?.icrPct, 0, 100),
        flatPa: clampNumber(p.fees?.flatPa, 0),
      },
      contributions: hydrateCashflows(p.contributions, plan),
      withdrawals: hydrateCashflows(p.withdrawals, plan),
      lumpSums: hydrateLumpSums(p.lumpSums, plan),
    }));

    return {
      schemaVersion: SCHEMA_VERSION,
      plan,
      portfolios,
      display: { units: raw.display?.units === "nominal" ? "nominal" : "real" },
      assumptions: { cpi: clampNumber(raw.assumptions?.cpi, 0, 0.2) || 0.025 },
    };
  } catch {
    return null;
  }
}

function hydrateCashflows(arr, plan) {
  if (!Array.isArray(arr)) return [];
  return arr.map((c) => clampCashflow({
    id: typeof c.id === "string" && c.id ? c.id : uid("cf"),
    amount: clampNumber(c.amount, 0),
    frequency: c.frequency === "annual" ? "annual" : "monthly",
    fromAge: c.fromAge,
    toAge: c.toAge,
    indexed: c.indexed !== false,
  }, plan));
}

function hydrateLumpSums(arr, plan) {
  if (!Array.isArray(arr)) return [];
  return arr.map((l) => clampLumpSum({
    id: typeof l.id === "string" && l.id ? l.id : uid("ls"),
    amount: clampNumber(l.amount, 0),
    direction: l.direction === "out" ? "out" : "in",
    age: l.age,
  }, plan));
}

// --- derived summaries ---------------------------------------------------

export function annualisedAmount(cf) {
  return cf.frequency === "monthly" ? cf.amount * 12 : cf.amount;
}

// Summary strip figures across INCLUDED portfolios only.
export function summarise(state) {
  let totalBalance = 0;
  let includedCount = 0;
  let annualContributions = 0;
  for (const p of state.portfolios) {
    if (!p.include) continue;
    includedCount += 1;
    totalBalance += p.balance;
    for (const c of p.contributions) annualContributions += annualisedAmount(c);
  }
  return { totalBalance, includedCount, annualContributions };
}

// "50-year projection, 2026–2076" style live summary for the plan bar.
export function planSummaryText(plan) {
  const years = plan.endAge - plan.currentAge;
  const endYear = plan.startYear + years;
  return `${years}-year projection, ${plan.startYear}–${endYear}`;
}
