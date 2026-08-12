// Plan/asset state model for the multi-asset input panel.
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

// Contributions and withdrawals both default to the full plan window
// (fromAge = currentAge). Advice fees are modelled as withdrawals, and
// those typically run from today — so currentAge is the natural start
// for both kinds.
export function createCashflow(kind, plan) {
  return {
    id: uid("cf"),
    amount: 0,
    frequency: "monthly",
    fromAge: plan.currentAge,
    toAge: plan.endAge,
    indexed: true,
  };
}

export function createLumpSum(plan, source = "input") {
  return {
    id: uid("ls"),
    amount: 0,
    direction: "in",
    age: plan.currentAge,
    source: source === "table" ? "table" : "input",
  };
}

// Pick the firm profile whose total nominal return sits nearest to a
// custom allocation's income+growth total. Used to pre-select the
// volatility basis; the user can override.
export function nearestVolBasis(profiles, totalPct) {
  let best = null;
  let bestDist = Infinity;
  for (const [key, p] of Object.entries(profiles)) {
    const dist = Math.abs(p.totalNominal * 100 - totalPct);
    if (dist < bestDist) { bestDist = dist; best = key; }
  }
  return best;
}

export function createAsset(plan, existing = [], profiles = {}) {
  const keys = Object.keys(profiles);
  const n = nextAssetNumber(existing);
  const middleProfile = keys.length ? keys[Math.floor((keys.length - 1) / 2)] : null;
  const balance = 100000;
  return {
    id: uid("as"),
    name: `Asset ${n}`,
    include: true,
    balance,
    allocation: { mode: "profile", profile: middleProfile },
    icrPct: 0,
    // Tax fields: captured now, consumed in v1.1. Cost base defaults to
    // the current value — the common "cost base ≈ current value for new
    // money" starting point — and stays editable.
    cgtAsset: true,
    costBase: balance,
    contributions: [createCashflow("contribution", plan)],
    withdrawals: [],
    lumpSums: [],
  };
}

function nextAssetNumber(existing) {
  let max = 0;
  for (const a of existing) {
    const m = /^Asset (\d+)$/.exec(a.name || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Math.max(max, existing.length) + 1;
}

export function defaultState(profiles = {}, now = new Date()) {
  const plan = defaultPlan(now);
  return {
    schemaVersion: SCHEMA_VERSION,
    plan,
    assets: [createAsset(plan, [], profiles)],
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

// Allocation percentage bounds (per spec): income/growth 0–30% p.a.,
// franking 0–100%.
export const ALLOC_PCT_MAX = 30;

export function clampAllocation(alloc, profiles) {
  const keys = Object.keys(profiles);
  const fallback = keys.length ? keys[Math.floor((keys.length - 1) / 2)] : null;
  if (!alloc || alloc.mode !== "custom") {
    const profile = keys.includes(alloc?.profile) ? alloc.profile : fallback;
    return { mode: "profile", profile };
  }
  const incomePct = clampNumber(alloc.incomePct, 0, ALLOC_PCT_MAX);
  const growthPct = clampNumber(alloc.growthPct, 0, ALLOC_PCT_MAX);
  const frankingPct = clampNumber(alloc.frankingPct, 0, 100);
  const volBasis = keys.includes(alloc.volBasis)
    ? alloc.volBasis
    : nearestVolBasis(profiles, incomePct + growthPct);
  return { mode: "custom", incomePct, growthPct, frankingPct, volBasis };
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

// Re-clamp every cashflow/lump sum in every asset after a plan-age
// change. Returns a new state object (does not mutate).
export function clampAllToPlan(state) {
  const plan = clampPlan(state.plan);
  const assets = state.assets.map((a) => ({
    ...a,
    contributions: a.contributions.map((c) => clampCashflow(c, plan)),
    withdrawals: a.withdrawals.map((w) => clampCashflow(w, plan)),
    lumpSums: a.lumpSums.map((l) => clampLumpSum(l, plan)),
  }));
  return { ...state, plan, assets };
}

// --- persistence helpers ------------------------------------------------

export function serialize(state) {
  return JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION });
}

// Parse + validate a stored blob. Returns a clamped state or null if
// the blob is unusable (caller falls back to defaultState). Never
// throws.
export function hydrate(json, profiles = {}) {
  try {
    const raw = JSON.parse(json);
    if (!raw || typeof raw !== "object") return null;
    if (raw.schemaVersion !== SCHEMA_VERSION) return null; // future: migrate
    if (!raw.plan || !Array.isArray(raw.assets) || raw.assets.length === 0) return null;

    const plan = clampPlan(raw.plan);

    const assets = raw.assets.map((a, i) => {
      const balance = clampNumber(a.balance, 0);
      const cgtAsset = a.cgtAsset !== false;
      return {
        id: typeof a.id === "string" && a.id ? a.id : uid("as"),
        name: typeof a.name === "string" && a.name.trim() ? a.name : `Asset ${i + 1}`,
        include: a.include !== false,
        balance,
        allocation: clampAllocation(a.allocation, profiles),
        icrPct: clampNumber(a.icrPct, 0, 100),
        cgtAsset,
        costBase: cgtAsset
          ? clampNumber(a.costBase ?? balance, 0)
          : (a.costBase == null ? null : clampNumber(a.costBase, 0)),
        contributions: hydrateCashflows(a.contributions, plan),
        withdrawals: hydrateCashflows(a.withdrawals, plan),
        lumpSums: hydrateLumpSums(a.lumpSums, plan),
      };
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      plan,
      assets,
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
    source: l.source === "table" ? "table" : "input",
  }, plan));
}

// --- derived summaries ---------------------------------------------------

export function annualisedAmount(cf) {
  return cf.frequency === "monthly" ? cf.amount * 12 : cf.amount;
}

// Nominal total return for an asset's allocation, as a decimal
// (0.075 = 7.5% p.a.). Profile mode reads the profile; custom mode
// sums income + growth.
export function allocationTotalNominal(alloc, profiles) {
  if (alloc.mode === "custom") return (alloc.incomePct + alloc.growthPct) / 100;
  const p = profiles[alloc.profile];
  return p ? p.totalNominal : 0;
}

// Collapsed-card allocation summary: profile name, or
// "Custom · 7.5% p.a.".
export function allocationSummary(alloc, profiles) {
  if (alloc.mode === "custom") {
    const total = (alloc.incomePct + alloc.growthPct).toFixed(1).replace(/\.0$/, "");
    return `Custom · ${total}% p.a.`;
  }
  return alloc.profile || "";
}

// Summary strip figures across INCLUDED assets only.
export function summarise(state) {
  let totalBalance = 0;
  let includedCount = 0;
  let annualContributions = 0;
  let annualWithdrawals = 0;
  for (const a of state.assets) {
    if (!a.include) continue;
    includedCount += 1;
    totalBalance += a.balance;
    for (const c of a.contributions) annualContributions += annualisedAmount(c);
    for (const w of a.withdrawals) annualWithdrawals += annualisedAmount(w);
  }
  return { totalBalance, includedCount, annualContributions, annualWithdrawals };
}

// "50-year projection, 2026–2076 (age 40–90)" style live summary.
export function planSummaryText(plan) {
  const years = plan.endAge - plan.currentAge;
  const endYear = plan.startYear + years;
  return `${years}-year projection, ${plan.startYear}–${endYear} (age ${plan.currentAge}–${plan.endAge})`;
}
