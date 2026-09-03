// ASFA Retirement Standard (spec 32, Commit 2) — the calibration that
// turns "you fall short of $90,000" into "your $90,000 target is met
// until 87; at the ASFA Comfortable standard of $73,000 it lasts past
// 95."
//
// ⚠ Sourcing: these figures were supplied DIRECTLY by the firm (chat,
// this session) for the March quarter 2026 — NOT web-searched, the same
// protocol this codebase already uses for aged care and state duty
// schedules (CLAUDE.md). Do not update these figures from a search
// result; ask the firm for the next quarter's release instead.
//
// Two disclosures the spec requires wherever a figure from this module
// renders (never buried):
//   1. Comfortable and Modest both assume a HOMEOWNER WITH NO MORTGAGE
//      — see ASFA_HOMEOWNER_ASSUMPTION_NOTE.
//   2. "Comfortable"/"Modest" are ASFA's own terms, not this firm's
//      judgement about what is comfortable for a given client — see
//      asfaStandardLabel(), which always renders "ASFA <Standard>
//      (<household>, homeowner)".
export const ASFA_STANDARDS_BASE = Object.freeze({
  quarter: "March quarter 2026",
  // ASFA republishes quarterly; no firm-confirmed release date for the
  // next (June) quarter's figures was supplied, so the validity window
  // is assumed to be one quarter (~3 months) from the stamped quarter's
  // own start — see asfaStalenessWarning() below. Confirm the actual
  // release cadence against ASFA's own publication schedule before
  // relying on this window for anything beyond "warn eventually".
  periodStart: "2026-03-01",
  periodEnd: "2026-06-01",
  source: "ASFA Retirement Standard, supplied by the firm, March quarter 2026.",

  // Annual figures, real (today's) dollars at the stamped quarter.
  // "modestRenter" has no dedicated plan.retirement.incomeRequired
  // source value (the schema's own enum is deliberately just
  // currentExpenses|custom|asfaComfortable|asfaModest — see
  // retirement.js) — it exists here purely as disclosed reference data
  // alongside the other three, matching the firm's own source table.
  annual: {
    single: { comfortable: 55923, modest: 36434, modestRenter: 51164 },
    couple: { comfortable: 78566, modest: 52473, modestRenter: 69002 },
  },

  // Cross-check figures from the SAME firm-supplied source (Age Pension
  // incl. supplements) — NOT consumed by the engine anywhere. Compared
  // against data/agePension.js's own AGE_PENSION_RATES_BASE by
  // asfaStandards.test.js; a mismatch is REPORTED (the test fails,
  // naming both figures) rather than silently reconciled by adjusting
  // either source — see that test for the result.
  agePensionCrossCheckAnnual: { single: 31223, couple: 47070 },
});

// Column order throughout this module and wherever it's rendered:
// comfortable | modest | modestRenter | agePensionOnly — the firm's own
// source table order.
export const ASFA_STANDARD_KEYS = ["comfortable", "modest", "modestRenter", "agePensionOnly"];

// The ten-category lifestyle descriptor table, VERBATIM from ASFA's own
// Retirement Standard methodology (supplied directly by the firm — do
// not paraphrase or reconstruct this wording from general knowledge of
// ASFA's methodology). Every category has exactly four entries, in
// ASFA_STANDARD_KEYS order.
//
// The "home" row is the one place the renter column describes a
// different THING (the dwelling itself) rather than a degree of the
// same thing (repair/maintenance capacity) — that's ASFA's own framing,
// reproduced as given, not a data-entry inconsistency.
export const ASFA_LIFESTYLE_DESCRIPTORS = Object.freeze({
  health: [
    "Top level private health insurance, doctor/specialist visits, pharmacy needs",
    "Basic private health insurance, limited gap payments",
    "Basic private health insurance, limited gap payments",
    "No private health insurance",
  ],
  connectivity: [
    "Fast reliable NBN, computer and iPhone with good data allowance/streaming services",
    "Fast reliable NBN, computer and android mobile, modest mobile internet data allowance",
    "Fast reliable NBN, computer and basic android mobile, modest internet data allowance",
    "Very basic mobile and limited internet connectivity",
  ],
  vehicle: [
    "Own a reasonable car, car insurance and maintenance/upkeep",
    "Owning a cheaper, older, more basic car",
    "Owning a cheaper, older, more basic car",
    "Limited budget to own, maintain or repair a car",
  ],
  leisure: [
    "Regular leisure activities including club membership, cinema visits, exhibitions, dance/yoga classes",
    "Infrequent leisure activities, occasional trip to the cinema",
    "Infrequent leisure activities, occasional trip to the cinema",
    "Rare trips to the cinema",
  ],
  home: [
    "Home repairs, updates and maintenance to kitchen and bathroom appliances over 20 years",
    "Limited budget for home repairs, household appliances",
    "Modest one or two bedroom apartment in a middle to outer ring suburb",
    "Struggle to pay for repairs, such as leaky roofs or major plumbing problem",
  ],
  haircuts: [
    "Regular professional haircuts",
    "Budget haircuts",
    "Budget haircuts",
    "Less frequent haircuts, or self-haircuts",
  ],
  utilities: [
    "Confidence to use air conditioning in the home, afford all utilities",
    "Need to keep a close watch on all utility costs and make sacrifices",
    "Need to keep a close watch on all utility costs and make sacrifices",
    "Limited budget for home heating in winter",
  ],
  mealsOut: [
    "Occasional restaurant meals, home-delivery meals, take-away coffee",
    "Limited meals out at inexpensive restaurants, infrequent home-delivery or take-away",
    "Limited meals out at inexpensive restaurants, infrequent home-delivery or take-away",
    "Only local club special meals or inexpensive take-away",
  ],
  clothing: [
    "Replace worn-out clothing and footwear items, modest wardrobe updates",
    "Limited budget to replace or update worn items",
    "Limited budget to replace or update worn items",
    "Very basic clothing and footwear budget",
  ],
  travel: [
    "Annual domestic trip to visit family, one overseas trip every seven years",
    "Annual domestic trip or a few short breaks",
    "Annual domestic trip or a few short breaks",
    "Occasional short break or day trip in your own city",
  ],
});

export const ASFA_HOMEOWNER_ASSUMPTION_NOTE =
  "ASFA's Comfortable and Modest standards assume a homeowner with no mortgage. A client who will still have a mortgage, or who rents, will need more than these figures suggest — see the Modest (renter) figure for the renter case.";

// asfaAnnual(standard, household) → the annual dollar figure, or null
// for an unknown standard/household (never throws — a caller iterating
// a list of standards can pass anything through safely).
export function asfaAnnual(standard, household) {
  const h = household === "couple" ? "couple" : household === "single" ? "single" : null;
  if (!h || standard === "agePensionOnly") return null;
  return ASFA_STANDARDS_BASE.annual[h]?.[standard] ?? null;
}

// "ASFA Comfortable (couple, homeowner)" — the spec's own exact wording
// (Commit 2: 'Label it "ASFA Comfortable (couple, homeowner)" rather
// than as our own judgement'). modestRenter labels as "renter" instead
// of "homeowner", since that's the one figure that ISN'T the homeowner
// assumption.
export function asfaStandardLabel(standard, household) {
  const householdWord = household === "couple" ? "couple" : "single";
  const names = { comfortable: "ASFA Comfortable", modest: "ASFA Modest", modestRenter: "ASFA Modest" };
  const name = names[standard];
  if (!name) return "";
  const tenure = standard === "modestRenter" ? "renter" : "homeowner";
  return `${name} (${householdWord}, ${tenure})`;
}

// asfaStalenessWarning(calendarDate, base) → null, or a string flagging
// that the loaded quarter's figures are past their assumed validity
// window — same convention as data/agedCare.js's own
// agedCareStalenessWarning(): `calendarDate` is whichever date the
// caller wants checked (e.g. today, or a projection year's own
// calendar date), never assumed to be "today" internally.
export function asfaStalenessWarning(calendarDate, base = ASFA_STANDARDS_BASE) {
  const d = calendarDate instanceof Date ? calendarDate : new Date(calendarDate);
  const periodEnd = new Date(base.periodEnd);
  if (Number.isNaN(d.getTime()) || d <= periodEnd) return null;
  return `ASFA Retirement Standard figures loaded for the ${base.quarter} — this date falls after that quarter's assumed validity window. ASFA republishes quarterly; confirm the current figures (asfa.org.au or the firm's current Big Black Book) before quoting them to a client.`;
}
