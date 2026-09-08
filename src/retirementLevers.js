// Retirement levers (docs/specs/35-retirement-output-view.md, Commit 6)
// — "from the tool's original design, and the thing that made the Monte
// Carlo useful rather than merely informative: when a plan does not
// reach its goal, what would fix it." Pure, no DOM/Plotly.
//
// Four levers, each a REAL solve over runMonteCarlo — never an
// estimate, the same "never a shortcut formula" discipline solve.js's
// own header already states for the deterministic Focus solvers. Two
// are continuous (contribute more, spend less) and use bisectScalar
// (solve.js) directly; two are ordinal over a small, discrete domain
// (retire later: a handful of ages; take more risk: RISK_RUNGS) and use
// a plain forward scan instead — bisection assumes monotonicity a
// small discrete domain doesn't need, and a scan reports "reached
// nowhere in the domain" exactly as plainly as bisectScalar's own
// "out-of-bounds".
//
// Search-time accuracy is a disclosed, deliberate tradeoff: bisection/
// scan evaluations run at LEVER_SEARCH_PATHS (well under the caller's
// own full path count) with a FIXED seed, so the search itself is fast
// and internally consistent (same noise realisation compared across
// evaluations — required for the monotonicity check to mean anything).
// The number actually SHOWN to the adviser — "moves ruin from X% to
// Y%" — is always a fresh run at the caller's OWN numPaths/seed once
// the solve lands on a value, never the noisier search figure.
import { runMonteCarlo, DEFAULT_NUM_PATHS } from "./monteCarlo.js";
import { projectPlan } from "./deterministic.js";
import { clampAllToPlan, createSuperContribution } from "./planState.js";
import { bisectScalar } from "./solve.js";
import { RISK_RUNGS } from "./profiles.js";
import { capHeadroomFor } from "./retirementAnalytics.js";

export const RUIN_THRESHOLD_DEFAULT = 0.2;
// Well under the caller's own full path count — each search-time
// evaluation is a full runMonteCarlo call, expensive enough (unlike
// the deterministic engine solve.js was built for) that bisectScalar's
// own 2-second default time budget would otherwise cut a search off
// after one or two evaluations; every solve below passes an explicit,
// much larger maxMs instead (LEVER_MAX_MS) so the search actually runs
// to convergence rather than timing out prematurely.
export const LEVER_SEARCH_PATHS = 200;
export const LEVER_SEED = 20260908;
export const LEVER_MAX_MS = 45000;
export const LEVERS = ["contributeMore", "retireLater", "spendLess", "takeMoreRisk"];

// One representative profile per risk rung, ascending — RISK_RUNGS'
// own order (profiles.js), a sibling variant picked by index-0 where a
// rung has more than one (the "Income" flavour throughout; a null move
// on the risk ladder either way — see that module's own header).
export const RISK_LADDER = RISK_RUNGS.map((r) => r.assets[0]);

// searchPaths/searchSeed default to the module constants but are
// overridable per call — tests use a much smaller searchPaths so the
// whole suite stays fast without touching the module's own production
// defaults.
function ruinAtSearch(state, profiles, searchPaths, searchSeed) {
  return runMonteCarlo(state, profiles, {
    numPaths: searchPaths, seed: searchSeed, sampleCount: 0,
  }).ruinProbability;
}

// --- per-lever plan mutation (pure — always returns a NEW clone) -----

// Tops up (or creates) the CLIENT's own salary-sacrifice contribution
// into their own super account — client-anchored, the same convention
// every other single-scalar Focus solver in this app uses. `null` when
// the client has no super account at all to contribute into (reported
// as unavailable by the caller, never fabricated).
export function applyContributeMore(state, extraAnnual) {
  const account = (state.plan.superAccounts ?? []).find((s) => s.owner === "client" && s.include !== false);
  if (!account) return null;
  const clone = structuredClone(state);
  const existing = clone.cashflows.superContributions.find(
    (c) => c.owner === "client" && c.type === "salarySacrifice" && c.accountId === account.id && c.basis === "amount"
  );
  if (existing) {
    const currentAnnual = existing.frequency === "monthly" ? existing.amount * 12 : existing.amount;
    existing.amount = currentAnnual + extraAnnual;
    existing.frequency = "annual";
  } else {
    clone.cashflows.superContributions.push({
      ...createSuperContribution(clone.plan, clone.plan.superAccounts, "client"),
      accountId: account.id, type: "salarySacrifice", basis: "amount", amount: extraAnnual, frequency: "annual",
    });
  }
  return clone;
}

export function applyRetireLater(state, age) {
  const clone = structuredClone(state);
  clone.plan.client = { ...clone.plan.client, retirementAge: age };
  return clone;
}

// Income Required is a reference line, not a driver, EXCEPT when
// incomeDrivenDrawdown is on (spec 32, Commit 4) — forced on here for
// the trial, since a "spend less" lever with no engine effect on ruin
// probability would be meaningless. A real, disclosed choice: this
// lever answers "if pension drawdown collectively targeted this
// figure, floored at the statutory minimum, what's the most you could
// spend" — not "what if the displayed reference line were smaller".
export function applySpendLess(state, incomeRequiredAnnual) {
  const clone = structuredClone(state);
  const ir = clone.plan.retirement?.incomeRequired ?? {};
  clone.plan.retirement = {
    ...clone.plan.retirement,
    incomeRequired: { ...ir, source: "custom", customAmount: incomeRequiredAnnual },
    incomeDrivenDrawdown: true,
  };
  return clone;
}

// Overrides EVERY financial asset/super account/pension to the SAME
// single risk profile — a disclosed simplification: "take more risk"
// as a per-holding optimisation problem has no single well-defined
// answer, so this lever answers the coarser, still genuinely useful
// question "what if the whole household's own investment risk moved
// together".
export function applyUniformProfile(state, profileKey) {
  const clone = structuredClone(state);
  const setProfile = (h) => ({ ...h, allocation: { mode: "profile", profile: profileKey } });
  clone.assets = clone.assets.map((a) => (a.class === "financial" ? setProfile(a) : a));
  clone.plan.superAccounts = (clone.plan.superAccounts ?? []).map(setProfile);
  clone.plan.pensions = (clone.plan.pensions ?? []).map(setProfile);
  return clone;
}

// --- solves -------------------------------------------------------

// Contribute more — bisects real annual extra salary sacrifice, $0 to a
// generous $100,000/yr ceiling, for the value at which search-time ruin
// probability crosses `threshold`. Cap headroom is read from the
// ORIGINAL (unmodified) state's own year-0 concessional-cap usage —
// "the additional contribution needed, with cap headroom shown" (the
// spec's own words) means headroom BEFORE this lever's own top-up.
export function solveContributeMore(state, profiles, {
  threshold, baselineRuin, numPaths = DEFAULT_NUM_PATHS, seed = LEVER_SEED,
  searchPaths = LEVER_SEARCH_PATHS, searchSeed = LEVER_SEED,
} = {}) {
  const account = (state.plan.superAccounts ?? []).find((s) => s.owner === "client" && s.include !== false);
  if (!account) return { lever: "contributeMore", available: false, reason: "no-super-account" };

  const f = (extra) => ruinAtSearch(clampAllToPlan(applyContributeMore(state, extra), profiles), profiles, searchPaths, searchSeed);
  const search = bisectScalar({ f, lo: 0, hi: 100000, targetValue: threshold, tolerance: 0.02, maxMs: LEVER_MAX_MS });
  if (!search.converged || search.value == null) {
    return { lever: "contributeMore", available: true, converged: false, reason: search.reason, beforeRuin: baselineRuin };
  }
  const extraAnnual = Math.round(search.value / 100) * 100; // rounded — a solved-to-the-cent figure misrepresents the search's own noise
  const finalClone = clampAllToPlan(applyContributeMore(state, extraAnnual), profiles);
  const afterRuin = runMonteCarlo(finalClone, profiles, { numPaths, seed, sampleCount: 0 }).ruinProbability;
  const baselineHeadroom = capHeadroomFor(projectPlan(clampAllToPlan(state, profiles), profiles), "client");
  const capExceeded = baselineHeadroom != null && extraAnnual > baselineHeadroom.available;
  return {
    lever: "contributeMore", available: true, converged: true,
    extraAnnual, beforeRuin: baselineRuin, afterRuin, capExceeded,
    capHeadroom: baselineHeadroom?.available ?? null,
  };
}

// Retire later — a plain forward scan over integer ages (current+1 to
// endAge inclusive): small, discrete domain, no monotonicity assumption
// needed. Reports the FIRST age reaching the threshold; `converged:
// false` when even retiring at endAge itself doesn't get there.
export function solveRetireLater(state, profiles, {
  threshold, baselineRuin, numPaths = DEFAULT_NUM_PATHS, seed = LEVER_SEED,
  searchPaths = LEVER_SEARCH_PATHS, searchSeed = LEVER_SEED,
} = {}) {
  const currentAge = state.plan.client.retirementAge;
  const endAge = state.plan.endAge;
  for (let age = currentAge + 1; age <= endAge; age++) {
    const trial = clampAllToPlan(applyRetireLater(state, age), profiles);
    if (ruinAtSearch(trial, profiles, searchPaths, searchSeed) <= threshold) {
      const afterRuin = runMonteCarlo(trial, profiles, { numPaths, seed, sampleCount: 0 }).ruinProbability;
      return { lever: "retireLater", available: true, converged: true, age, beforeRuin: baselineRuin, afterRuin };
    }
  }
  return { lever: "retireLater", available: true, converged: false, reason: "out-of-bounds", beforeRuin: baselineRuin };
}

// Spend less — bisects Income Required (real $/yr, today's dollars)
// down from a generous $500,000 ceiling to $0, for the figure at which
// search-time ruin probability crosses `threshold` (spending less ⇒
// lower ruin, so this is the MOST the household could spend and stay
// at/under it — the max sustainable Income Required, not a minimum).
export function solveSpendLess(state, profiles, {
  threshold, baselineRuin, numPaths = DEFAULT_NUM_PATHS, seed = LEVER_SEED,
  searchPaths = LEVER_SEARCH_PATHS, searchSeed = LEVER_SEED,
} = {}) {
  const f = (income) => ruinAtSearch(clampAllToPlan(applySpendLess(state, income), profiles), profiles, searchPaths, searchSeed);
  const search = bisectScalar({ f, lo: 0, hi: 500000, targetValue: threshold, tolerance: 0.02, maxMs: LEVER_MAX_MS });
  if (!search.converged || search.value == null) {
    return { lever: "spendLess", available: true, converged: false, reason: search.reason, beforeRuin: baselineRuin };
  }
  const incomeRequiredAnnual = Math.round(search.value / 500) * 500;
  const finalClone = clampAllToPlan(applySpendLess(state, incomeRequiredAnnual), profiles);
  const afterRuin = runMonteCarlo(finalClone, profiles, { numPaths, seed, sampleCount: 0 }).ruinProbability;
  return { lever: "spendLess", available: true, converged: true, incomeRequiredAnnual, beforeRuin: baselineRuin, afterRuin };
}

// Take more risk — a plain forward scan up RISK_LADDER (least to most
// aggressive), stopping at the first rung reaching the threshold.
// "WITH the distribution shown" (the spec's own words, its own
// emphasis) — the final confirmation run keeps sampleCount at its
// default (20) specifically so the caller has real path samples to
// chart, not just the headline ruin figure; every other lever's own
// final run above sets sampleCount:0 since none of them need one.
export function solveTakeMoreRisk(state, profiles, {
  threshold, baselineRuin, numPaths = DEFAULT_NUM_PATHS, seed = LEVER_SEED,
  searchPaths = LEVER_SEARCH_PATHS, searchSeed = LEVER_SEED,
} = {}) {
  for (const profileKey of RISK_LADDER) {
    const trial = clampAllToPlan(applyUniformProfile(state, profileKey), profiles);
    if (ruinAtSearch(trial, profiles, searchPaths, searchSeed) <= threshold) {
      const result = runMonteCarlo(trial, profiles, { numPaths, seed });
      return {
        lever: "takeMoreRisk", available: true, converged: true, profile: profileKey,
        beforeRuin: baselineRuin, afterRuin: result.ruinProbability, distribution: result.endDistribution,
      };
    }
  }
  return { lever: "takeMoreRisk", available: true, converged: false, reason: "out-of-bounds", beforeRuin: baselineRuin };
}

export const LEVER_SOLVERS = {
  contributeMore: solveContributeMore,
  retireLater: solveRetireLater,
  spendLess: solveSpendLess,
  takeMoreRisk: solveTakeMoreRisk,
};

// Every lever's own result, ranked by effect on ruin probability
// (largest reduction first) — "ranking is by effect on ruin
// probability, and that is stated" (the spec's own non-prescriptive
// requirement: never by desirability, never a recommendation).
// Unavailable/non-converged levers sort last, in LEVERS' own order.
export function solveAllLevers(state, profiles, opts) {
  const results = LEVERS.map((lever) => LEVER_SOLVERS[lever](state, profiles, opts));
  const effect = (r) => (r.converged ? r.beforeRuin - r.afterRuin : -Infinity);
  return results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (effect(b.r) - effect(a.r)) || (a.i - b.i))
    .map(({ r }) => r);
}
