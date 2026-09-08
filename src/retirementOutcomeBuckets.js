// Retirement outcome buckets (docs/specs/36-retirement-outputs.md,
// Commit 1) — pure, no DOM/Plotly. Classifies EVERY Monte Carlo path
// by the lifestyle its own average household after-tax retirement
// income sustains, replacing a single ruin percentage with four
// buckets that describe the SHAPE of the distribution — "the task is
// a legible headline that does not name a winner" (the spec's own
// words). Ruin probability is not removed; it stays available as the
// scenario-to-scenario comparable, it just stops being the headline.
//
// The three boundaries, high to low: ASFA Comfortable, ASFA Modest (or
// Modest (renter), matching whichever standard lifestyleBand.js itself
// selects for this household's tenure — the SAME figure, so the
// buckets and the lifestyle band can never disagree), and the full Age
// Pension rate for this household (data/agePension.js). All three are
// resolved ONCE at today's (year 0) real-dollar value and held fixed
// for the whole classification — the same convention ASFA's own
// figures already use throughout this codebase (a stamped-quarter
// real-dollar anchor, not a figure that drifts year to year within the
// comparison), and consistent with the engine's own "real terms
// everywhere" convention (CLAUDE.md): a path's average income is
// already a real-dollar figure, so it is compared against real-dollar
// anchors.
//
// "When the Age Pension is excluded" (some advisers turn off
// centrelinkEligible for the whole household) — the floor does not
// exist, so the bottom bucket's DEFINITION swaps from a dollar
// comparison to the engine's own single locked ruin definition
// (out.shortfall !== null, monteCarlo.js's own docblock) — "portfolio
// exhausted" is the literal, honest description of what actually
// distinguishes that path, once there is no pension-supported floor
// under it. This never recomputes ruin a second way; it just reads the
// SAME per-path flag monteCarlo.js already tracks.

import { asfaAnnual } from "./data/asfaStandards.js";
import { agePensionRatesFor } from "./data/agePension.js";
import { firstFyStartYear } from "./schedule.js";
import { descriptorsForStandard } from "./lifestyleBand.js";

export const OUTCOME_BUCKET_ORDER = ["aboveComfortable", "comfortable", "modest", "atFloor"];

const OUTCOME_BUCKET_LABELS = {
  aboveComfortable: "Above Comfortable",
  comfortable: "Comfortable",
  modest: "Modest",
  atFloor: "At the Age Pension floor",
};

// The ASFA standard each bucket links its descriptors to (the spec's
// own "each bucket links to its lifestyle descriptors, so 'Modest'
// carries its ten plain-English categories rather than being an
// abstract band") — named literally after the bucket, via
// lifestyleBand.js's own descriptorsForStandard, never a duplicated
// copy of that table.
const OUTCOME_BUCKET_STANDARD = {
  aboveComfortable: "comfortable",
  comfortable: "comfortable",
  modest: (tenure) => (tenure === "renter" ? "modestRenter" : "modest"),
  atFloor: "agePensionOnly",
};

export function outcomeBucketLabel(key, agePensionExcluded) {
  if (key === "atFloor" && agePensionExcluded) return "Portfolio exhausted";
  return OUTCOME_BUCKET_LABELS[key] ?? key;
}

export function outcomeBucketDescriptors(key, tenure) {
  const standard = OUTCOME_BUCKET_STANDARD[key];
  const resolved = typeof standard === "function" ? standard(tenure) : standard;
  return descriptorsForStandard(resolved);
}

// A household has excluded the Age Pension entirely when NEITHER
// member is assessed for it (taxProfile.centrelinkEligible === false
// for the client, and for the partner too if one exists — spec 21a's
// own per-person "Age pension eligible" toggle, "Turn off for someone
// who won't qualify... or a client who simply doesn't want it
// modelled"). A single household with the client turned off already
// satisfies this; a couple needs BOTH turned off, since one eligible
// partner still gives the household a pension-supported floor.
export function agePensionExcludedFor(plan) {
  const clientOff = plan.client?.taxProfile?.centrelinkEligible === false;
  const partnerOff = !plan.partner || plan.partner?.taxProfile?.centrelinkEligible === false;
  return clientOff && partnerOff;
}

// resolveOutcomeThresholds(state, household, tenure) → { comfortable,
// modest, modestStandard, floor } — all today's (year 0) real dollars.
// `household`: "single" | "couple". `tenure`: "homeowner" | "renter"
// (deriveHomeownerStatus's own output — see retirement.js).
export function resolveOutcomeThresholds(state, household, tenure) {
  const f0 = firstFyStartYear(state.plan.start);
  const a = state.assumptions;
  // Age Pension thresholds/rates are driven by bracketMode, NOT the
  // super-threshold indexation toggle (docs/specs/35-retirement-
  // output-view.md, Commit 4's own split) — same reading every other
  // Age Pension figure in this codebase uses. At fyStartYear = f0
  // (today), the indexation mode has no effect anyway (zero elapsed
  // years to drift), so this is today's real dollar figure regardless.
  const rates = agePensionRatesFor(f0, a.bracketMode ?? "indexed", a.cpi, a.awote ?? 0.032);
  const floor = household === "couple" ? rates.couple.rateCombined : rates.single.rate;
  const modestStandard = tenure === "renter" ? "modestRenter" : "modest";
  return {
    comfortable: asfaAnnual("comfortable", household),
    modest: asfaAnnual(modestStandard, household),
    modestStandard,
    floor,
  };
}

// classifyOutcome(avgIncome, thresholds, agePensionExcluded, ruined) →
// one of OUTCOME_BUCKET_ORDER. Pure boundary logic, hand-testable
// against exact threshold values (the spec's own test requirement:
// "classification against hand-computed paths at each boundary").
// Boundaries are upper-inclusive on every bucket but the top one —
// "Above Comfortable" needs avgIncome to EXCEED the Comfortable figure
// (the spec's own word: "exceeds"), so avgIncome exactly AT a
// threshold falls into the bucket below it, never the one above.
export function classifyOutcome(avgIncome, thresholds, agePensionExcluded, ruined) {
  if (avgIncome > thresholds.comfortable) return "aboveComfortable";
  if (avgIncome > thresholds.modest) return "comfortable";
  if (agePensionExcluded) return ruined ? "atFloor" : "modest";
  return avgIncome > thresholds.floor ? "modest" : "atFloor";
}

// computeOutcomeBuckets({pathAvgIncome, pathMinIncome, pathRuined},
// thresholds, agePensionExcluded) → { agePensionExcluded, thresholds,
// totalPaths, buckets: [{key, label, count, pct, dropsToFloorPct}, ...] }
// in OUTCOME_BUCKET_ORDER.
//
// dropsToFloorPct — "report the minimum alongside the average" (the
// spec's own words): of the paths THIS bucket already contains (by
// their average), what share had at least one year in the SAME window
// dip to (or below) the Age Pension floor — a path averaging
// Comfortable while spending five years at the floor is not a
// Comfortable retirement, and this is how that shows up. `null` for
// the bottom bucket itself (it IS the floor — the stat would be
// vacuous) and whenever the Age Pension is excluded (there is no
// dollar floor to drop to in that case — see this module's own
// header; showing a stat named after a switched-off concept would be
// the exact silent-reporting failure the spec calls out for the
// bottom bucket itself).
export function computeOutcomeBuckets(paths, thresholds, agePensionExcluded) {
  const { pathAvgIncome, pathMinIncome, pathRuined } = paths;
  const n = pathAvgIncome.length;
  const counts = Object.fromEntries(OUTCOME_BUCKET_ORDER.map((k) => [k, 0]));
  const dropCounts = Object.fromEntries(OUTCOME_BUCKET_ORDER.map((k) => [k, 0]));
  for (let i = 0; i < n; i++) {
    const key = classifyOutcome(pathAvgIncome[i], thresholds, agePensionExcluded, !!pathRuined[i]);
    counts[key]++;
    if (key !== "atFloor" && !agePensionExcluded && pathMinIncome[i] <= thresholds.floor) dropCounts[key]++;
  }
  return {
    agePensionExcluded,
    thresholds,
    totalPaths: n,
    buckets: OUTCOME_BUCKET_ORDER.map((key) => ({
      key,
      label: outcomeBucketLabel(key, agePensionExcluded),
      count: counts[key],
      pct: n > 0 ? (counts[key] / n) * 100 : 0,
      dropsToFloorPct: key === "atFloor" || agePensionExcluded || counts[key] === 0
        ? null
        : (dropCounts[key] / counts[key]) * 100,
    })),
  };
}
