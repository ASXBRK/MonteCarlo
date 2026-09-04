// Lifestyle band (docs/specs/32-retirement-phase-one.md, Commit 5b) —
// pure, no DOM/Plotly. "The client-facing artefact, and better than
// any chart for this purpose" — places the household's own average
// retirement income (Commit 3's own averageRetirementIncome, "since a
// single year would mislead" — the spec's own words) on the ASFA scale
// and names the descriptors for its own band and the one above.
//
// The scale has exactly two PUBLISHED per-household dollar figures
// (asfaStandards.js's own annual table) — Modest/Modest(renter) and
// Comfortable; there is no published "Comfortable (renter)" figure, so
// a renter's own "one above" is always Comfortable, a homeowner-
// assumption standard. Below the lower figure, this module uses
// agePensionOnly's own DESCRIPTORS (the ten-category table's fourth,
// general-reference column — always legitimate display content, per
// asfaStandards.js's own header) as the "at this level" line, WITHOUT
// asserting a dollar figure for it — agePensionCrossCheckAnnual is
// documented there as a cross-check figure only, not general display
// data, so this module never reads it.
//
// The "home" nuance (asfaStandards.js's own header explains WHY): nine
// of the ten categories read as a ladder — more or less of the same
// thing across standards. "home" does not — at modestRenter it
// describes the DWELLING ("a modest one or two bedroom apartment"),
// while every other standard (including agePensionOnly) describes
// REPAIR CAPACITY for a home already owned. A delta line ("reaching
// Comfortable buys you...") composed uniformly across all ten
// categories would, for a renter, present a rental unit and a repair
// allowance as two points on the same scale — incoherent, since
// becoming a homeowner is a capital/structural decision, not something
// more INCOME buys. CHOSEN FIX: exclude "home" from the delta
// composition whenever the comparison involves modestRenter (either as
// the current standard or, in the below-the-floor case, as the delta's
// own target) — i.e. whenever tenure is "renter" — never silently: the
// returned `homeExcludedFromDelta` flag says so, for the caller to
// disclose. The alternative (rendering "home" as its own separate
// statement) was rejected: it would need bespoke wording for exactly
// one category on exactly one tenure, adding a special case to what
// the spec asks to stay "the client-facing artefact" — simple. "home"
// still renders normally in the CURRENT-level list (that's just
// describing one band, not comparing two).

import { ASFA_LIFESTYLE_DESCRIPTORS, asfaAnnual } from "./data/asfaStandards.js";

export const LIFESTYLE_CATEGORIES = Object.keys(ASFA_LIFESTYLE_DESCRIPTORS);

const STANDARD_COLUMN = { comfortable: 0, modest: 1, modestRenter: 2, agePensionOnly: 3 };

// descriptorsForStandard(standard, categories) → [{category, text}, ...],
// in `categories`' own order (default: every category). Skips a
// category with no text for that standard rather than rendering an
// empty entry — never reachable today (every standard has all ten),
// but a defensive convention this codebase uses throughout.
export function descriptorsForStandard(standard, categories = LIFESTYLE_CATEGORIES) {
  const col = STANDARD_COLUMN[standard];
  if (col == null) return [];
  return categories
    .map((category) => ({ category, text: ASFA_LIFESTYLE_DESCRIPTORS[category]?.[col] ?? null }))
    .filter((d) => d.text);
}

// resolveLifestyleBand(averageIncome, household, tenure) →
//   { position, household, tenure, currentStandard, nextStandard,
//     currentAmount, nextAmount, gap, homeExcludedFromDelta }
//   | null (no average income to place — e.g. an out-of-range LE window,
//     retirementAnalytics.js's own convention for a degenerate plan)
//
// `tenure`: "homeowner" | "renter" — the SAME derived value
// retirement.js's own deriveHomeownerStatus produces; this module takes
// it as given rather than re-deriving it (that derivation needs the
// engine's own projected ledger, which this module has no reason to
// see — see deriveHomeownerStatus's own header for why it can't be
// re-derived from today's loan terms).
//
// `position`:
//   "belowLower"   — under the Modest/Modest(renter) figure. currentStandard
//                     is "agePensionOnly" (descriptors only, no $ — see
//                     this module's own header); nextStandard is
//                     Modest/Modest(renter), the target to reach it.
//   "between"       — the spec's own worked example: sits between the
//                     lower standard and Comfortable.
//   "atOrAboveTop"  — at or past Comfortable; nextStandard is null (top
//                     of the published scale — no delta to compose).
export function resolveLifestyleBand(averageIncome, household, tenure) {
  const lowerStandard = tenure === "renter" ? "modestRenter" : "modest";
  const upperStandard = "comfortable";
  const lowerAmount = asfaAnnual(lowerStandard, household);
  const upperAmount = asfaAnnual(upperStandard, household);
  if (averageIncome == null || lowerAmount == null || upperAmount == null) return null;

  // See this module's own header — modestRenter is involved in every
  // renter-tenure comparison this function can produce (as the current
  // standard in "between", or as the delta's own target in
  // "belowLower"), so this single flag covers both.
  const homeExcludedFromDelta = tenure === "renter";

  if (averageIncome < lowerAmount) {
    return {
      position: "belowLower", household, tenure,
      currentStandard: "agePensionOnly", nextStandard: lowerStandard,
      currentAmount: null, nextAmount: lowerAmount,
      gap: lowerAmount - averageIncome, homeExcludedFromDelta,
    };
  }
  if (averageIncome < upperAmount) {
    return {
      position: "between", household, tenure,
      currentStandard: lowerStandard, nextStandard: upperStandard,
      currentAmount: lowerAmount, nextAmount: upperAmount,
      gap: upperAmount - averageIncome, homeExcludedFromDelta,
    };
  }
  return {
    position: "atOrAboveTop", household, tenure,
    currentStandard: upperStandard, nextStandard: null,
    currentAmount: upperAmount, nextAmount: null,
    gap: null, homeExcludedFromDelta: false,
  };
}

// The "at this level you would expect" list — always every category
// (this module's own choice: the spec's worked example shows a curated
// handful for prose flow, but picking "the best five" would mean
// hardcoding an editorial subset with no principled cutoff; the full
// ten-category table is the honest, complete answer for a real
// client-facing artefact, and every category already renders in a
// compact "·"-joined line).
export function currentLevelDescriptors(band) {
  if (!band || band.currentStandard == null) return [];
  return descriptorsForStandard(band.currentStandard);
}

// The "reaching <next standard> would buy you" list — "home" excluded
// per band.homeExcludedFromDelta (see this module's own header).
export function deltaDescriptors(band) {
  if (!band || band.nextStandard == null) return [];
  const categories = band.homeExcludedFromDelta
    ? LIFESTYLE_CATEGORIES.filter((c) => c !== "home")
    : LIFESTYLE_CATEGORIES;
  return descriptorsForStandard(band.nextStandard, categories);
}
