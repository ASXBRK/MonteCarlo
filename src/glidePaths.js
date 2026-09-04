// Glide paths (docs/specs/32-retirement-phase-one.md, Commit 4) — pure,
// no DOM/engine mutation. A glide path is an ORDERED list of {fromAge,
// profile} steps, assignable to a super account, pension, or financial
// asset in place of a single fixed profile — the firm already does
// this lifecycle-investing shift by hand (Midwinter's own "8%
// accumulation, 5.85% pension" is a single-step glide path expressed
// as two return assumptions).
//
// Two things this module owns:
//   1. Age-based interpolation between the two steps surrounding a
//      given age — gradual, not a cliff, unless two steps sit at
//      (near-)adjacent ages, which degenerates to a cliff by
//      construction (a near-zero-width interpolation window), not a
//      special case.
//   2. Annual rebalance vs drift (rebalance: "annual" | "drift") — see
//      precomputeGlideYearly's own header for the exact mechanism and
//      the disclosed modeling choice it rests on (this firm's CMA data
//      publishes whole-profile total returns, never per-asset-class
//      returns, so "drift" is modelled at the level of which GLIDE-
//      PATH STEP's own return currently dominates the mix, not a
//      fabricated per-class return series).
//
// Both the deterministic engine (deterministic.js, for the actual
// return applied) and the allocation-over-time chart (allocation.js,
// for the class-weight display) consume the SAME precomputed per-year
// array from this module — one source of truth, so the chart can never
// show a different glide position than the one the engine actually
// used that year.

import { ASSET_CLASS_KEYS, impliedFrankingPct } from "./profiles.js";

export const GLIDE_PATH_REBALANCE_MODES = ["annual", "drift"];

// The two steps surrounding `age` (sorted ascending by fromAge), and
// the interpolation fraction `t` between them (0 at stepA's own age, 1
// at stepB's). Before the first step or after the last, stepA===stepB
// and t is 0 — a flat plateau, not extrapolation.
export function glidePathWindow(steps, age) {
  if (!steps || steps.length === 0) return null;
  if (age <= steps[0].fromAge) return { stepA: steps[0], stepB: steps[0], t: 0 };
  for (let i = 0; i < steps.length - 1; i++) {
    const a = steps[i], b = steps[i + 1];
    if (age < b.fromAge) {
      const span = b.fromAge - a.fromAge;
      const t = span > 0 ? (age - a.fromAge) / span : 1;
      return { stepA: a, stepB: b, t };
    }
  }
  const last = steps[steps.length - 1];
  return { stepA: last, stepB: last, t: 0 };
}

// blendAtAge(steps, age, profiles) — the age-implied target blend at a
// SINGLE age, with no drift memory (equivalent to precomputeGlideYearly's
// own "reset to target" branch, standalone). For callers that only ever
// need one snapshot — a display figure (main.js's Assumptions view "gross
// return" row) or a test — never for the engine's own monthly rate, which
// needs the FULL per-year path (precomputeGlideYearly, below) so drift
// mode's carried-forward share is visible. `null` on an empty glide path
// or an unknown profile key, same convention as precomputeGlideYearly's
// own per-year `null` entries.
export function blendAtAge(steps, age, profiles) {
  const win = glidePathWindow(steps, age);
  if (!win) return null;
  const profileA = profiles[win.stepA.profile] ?? null;
  const profileB = profiles[win.stepB.profile] ?? null;
  if (!profileA || !profileB) return null;
  const bShare = win.t, aShare = 1 - bShare;
  const totalNominal = aShare * profileA.totalNominal + bShare * profileB.totalNominal;
  const incomeNominal = aShare * profileA.incomeReturn + bShare * profileB.incomeReturn;
  const growthNominal = aShare * profileA.growthReturn + bShare * profileB.growthReturn;
  const classWeights = {};
  for (const k of ASSET_CLASS_KEYS) classWeights[k] = aShare * profileA.classWeights[k] + bShare * profileB.classWeights[k];
  const frankingPct = impliedFrankingPct(classWeights, incomeNominal);
  return { incomeNominal, growthNominal, totalNominal, frankingPct, classWeights };
}

// precomputeGlideYearly(glidePath, clientAges, profiles) →
//   [{ incomeNominal, growthNominal, totalNominal, frankingPct, classWeights }, ...]
//   one entry per plan year (clientAges.length), computed ONCE, up
//   front — never mutated or re-derived during the engine's monthly
//   loop, and in particular never touched by the measurement-vs-real
//   two-pass replay a plan year's tax timing needs (that replay must
//   see IDENTICAL balances on both passes — see deterministic.js's own
//   header — so any state this module tracks is resolved entirely
//   BEFORE that replay ever starts).
//
// Rebalance ("annual", the default): every year, the two-step window
// for that year's age is resolved FRESH — aShare/bShare (the dollar
// split between stepA's own profile and stepB's) are reset to the
// age-implied target every year. This is mathematically IDENTICAL to
// reading resolveGlidePathBlend's own age-interpolated figures fresh
// each year — no persisted state survives between years.
//
// Drift: aShare/bShare are NOT reset. Each year, whichever of the two
// step profiles had the higher total return grows its OWN dollar share
// of the (notional, always renormalised to sum to 1) split — so if
// stepA (the earlier, typically more growth-oriented step) keeps
// outperforming stepB (the later, typically more defensive step), its
// share drifts ABOVE what the age schedule intends, and stays there
// even once age has moved the TARGET further toward stepB. This is the
// spec's own "drift always overstates the growth allocation," modelled
// using only each step's own published whole-profile total return —
// no per-asset-class return data is fabricated. When age crosses into
// a genuinely different pair of surrounding steps, the drifted split
// carries forward as the new starting point for the new window (it is
// never reset to that window's own fresh target, on drift).
export function precomputeGlideYearly(glidePath, clientAges, profiles) {
  const steps = glidePath.steps;
  let aShare = null, bShare = null;
  let lastStepA = null, lastStepB = null;
  const out = [];
  for (let y = 0; y < clientAges.length; y++) {
    const age = clientAges[y];
    const win = glidePathWindow(steps, age);
    if (!win) { out.push({ incomeNominal: 0, growthNominal: 0, totalNominal: 0, frankingPct: 0, classWeights: null }); continue; }
    const profileA = profiles[win.stepA.profile] ?? null;
    const profileB = profiles[win.stepB.profile] ?? null;
    if (!profileA || !profileB) { out.push({ incomeNominal: 0, growthNominal: 0, totalNominal: 0, frankingPct: 0, classWeights: null }); continue; }

    const windowChanged = win.stepA !== lastStepA || win.stepB !== lastStepB;
    const freshTargetB = win.t; // target share of stepB at this age
    if (aShare === null || glidePath.rebalance === "annual" || windowChanged) {
      // Reset to the age-implied target — either the very first year,
      // annual rebalance (every year), or drift carrying into a newly
      // entered step window (see header: the drifted split becomes the
      // NEW window's starting point, not a fresh target — but a window
      // change with no prior state, i.e. the very first year, has
      // nothing to carry, so it starts at target either way).
      bShare = freshTargetB;
      aShare = 1 - bShare;
    }
    const totalNominal = aShare * profileA.totalNominal + bShare * profileB.totalNominal;
    const incomeNominal = aShare * profileA.incomeReturn + bShare * profileB.incomeReturn;
    const growthNominal = aShare * profileA.growthReturn + bShare * profileB.growthReturn;
    const blendedWeights = {};
    for (const k of ASSET_CLASS_KEYS) blendedWeights[k] = aShare * profileA.classWeights[k] + bShare * profileB.classWeights[k];
    const frankingPct = impliedFrankingPct(blendedWeights, incomeNominal);
    out.push({ incomeNominal, growthNominal, totalNominal, frankingPct, classWeights: blendedWeights });

    if (glidePath.rebalance === "drift") {
      // Advance the split for NEXT year based on THIS year's realized
      // differential return — never reset, this is the whole point.
      const newA = aShare * (1 + profileA.totalNominal);
      const newB = bShare * (1 + profileB.totalNominal);
      const total = newA + newB;
      aShare = total > 0 ? newA / total : aShare;
      bShare = total > 0 ? newB / total : bShare;
    }
    lastStepA = win.stepA;
    lastStepB = win.stepB;
  }
  return out;
}

// --- Presets (spec's own instruction: "ship two presets so it is
// usable immediately") -------------------------------------------------
//
// Profile names match src/profiles.js's own PROFILES keys exactly —
// "High Growth" has no single neutral entry there (only the Income/
// Capital variants), so "High Growth – Capital" is used throughout:
// the capital-appreciation variant, matching what an EARLY-accumulation
// glide path step actually wants (growth, not income yield).
export function singleStepGlidePathPreset(plan) {
  return {
    name: "Single-step (High Growth → Balanced at retirement)",
    steps: [
      { fromAge: plan.client.currentAge, profile: "High Growth – Capital" },
      { fromAge: plan.client.retirementAge, profile: "Balanced" },
    ],
    rebalance: "annual",
  };
}

export function gradualGlidePathPreset(plan) {
  const stepDownStart = Math.max(plan.client.currentAge, plan.client.retirementAge - 10);
  return {
    name: "Gradual (steps down over the 10 years before retirement, then again at 75)",
    steps: [
      { fromAge: plan.client.currentAge, profile: "High Growth – Capital" },
      { fromAge: stepDownStart, profile: "High Growth – Capital" }, // holds flat until the ramp starts
      { fromAge: plan.client.retirementAge, profile: "Balanced" },   // ramps down across the last decade
      { fromAge: Math.max(plan.client.retirementAge, 74), profile: "Balanced" }, // holds flat until 75
      { fromAge: Math.max(plan.client.retirementAge + 1, 75), profile: "Moderately Defensive" }, // steps again at 75
    ],
    rebalance: "annual",
  };
}
