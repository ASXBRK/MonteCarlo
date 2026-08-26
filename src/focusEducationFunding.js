// Focus: Education funding (spec 25, Commit 3) — pure, no DOM/Plotly.
// "The same dollars, three ways" (the spec's own words): the SAME
// lump sum, funding the SAME already-modelled fee schedule for one
// child, held in three different vehicles —
//   1. an ordinary (non-super, non-bond) financial asset, fully
//      taxable each year, drawn down to cover the fees via the SAME
//      deficit-funding mechanism every other asset already uses;
//   2. a plain investment bond, linked to the child (beneficiaryChildId)
//      so it auto-funds those SAME fees, taxed at the ordinary
//      ten-year-rule rate on withdrawal;
//   3. an education bond, linked the same way, with the education
//      benefit on top and no personal tax on the withdrawal at all.
// All three arms are real projectPlan() runs on clones — per the Focus
// governing principle, never a hand-rolled approximation of what a
// bond would do. Only the VEHICLE differs between arms; the fee
// schedule, the household's other income/expenses, and the seed
// amount are identical, so any difference in the ending net worth is
// attributable to the vehicle alone.

import { projectPlan } from "./deterministic.js";
import { clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";

// A child worth running this comparison for: at least one education
// block with a real fee amount (otherwise there's nothing to fund).
export function eligibleEducationFundingChildren(state) {
  return (state.plan.children ?? []).filter((c) => (c.education ?? []).some((b) => b.annualAmount > 0));
}

// The lump sum that would cover the child's own fee schedule if it
// earned nothing at all — the "same dollars" seed handed to each arm.
// Deliberately simple (no discounting/growth assumption of its own):
// the POINT of the comparison is what each VEHICLE does with this
// exact amount, not a separate judgement about how much to save.
function totalFeeCost(child) {
  return (child.education ?? []).reduce(
    (s, b) => s + Math.max(0, b.annualAmount ?? 0) * Math.max(0, (b.toAge ?? 0) - (b.fromAge ?? 0) + 1),
    0
  );
}

// A middling profile (same one createAsset/createBond themselves
// default to) — held IDENTICAL across all three arms so any
// difference in outcome is attributable to the vehicle, not to a
// different assumed return.
function middleProfileName(profiles) {
  const keys = Object.keys(profiles);
  return keys.length ? keys[Math.floor((keys.length - 1) / 2)] : null;
}

// buildEducationFundingFocus({ out, state, childId }) → the view's
// data, or null if the child doesn't exist or has no fee schedule.
export function buildEducationFundingFocus({ out, state, childId }) {
  const child = (state.plan.children ?? []).find((c) => c.id === childId);
  if (!child || !eligibleEducationFundingChildren(state).some((c) => c.id === childId)) return null;

  const seed = totalFeeCost(child);
  const profileName = middleProfileName(PROFILES);
  const startDate = `${state.plan.start.year}-${String(state.plan.start.month).padStart(2, "0")}-01`;

  // Arm 1: an ordinary financial asset, fully taxable each year (no
  // pool/discount concession beyond the engine's own standard CGT
  // treatment), first in its own clone's funding order so it's what
  // actually covers the fee-driven shortfall — the same mechanism
  // every other asset-funded expense in this engine already uses, not
  // a new one built for this comparison.
  const baselineState = structuredClone(state);
  const baselineAssetId = "focus-edu-baseline";
  baselineState.assets = [
    ...(baselineState.assets ?? []),
    {
      id: baselineAssetId, name: `${child.name} — savings (outside a bond)`, class: "financial",
      include: true, owner: "client", distributions: "reinvest", balance: seed,
      allocation: { mode: "profile", profile: profileName }, icrPct: 0, cgtAsset: true, costBase: seed,
    },
  ];
  baselineState.settings = {
    ...baselineState.settings,
    fundingOrder: [baselineAssetId, ...(baselineState.settings?.fundingOrder ?? [])],
  };
  const baselineOut = projectPlan(clampAllToPlan(baselineState, PROFILES));

  // Arms 2/3 share everything except type — a plain investment bond
  // vs an education bond, same seed, same beneficiary link.
  const bondArm = (type) => {
    const clone = structuredClone(state);
    const bondId = `focus-edu-${type}`;
    clone.bonds = [
      ...(clone.bonds ?? []),
      {
        id: bondId, name: `${child.name} — ${type === "education" ? "education" : "investment"} bond`,
        type, owner: "client", include: true, balance: seed, startDate,
        allocation: { mode: "profile", profile: profileName }, icrPct: 0,
        beneficiaryChildId: childId,
      },
    ];
    const out2 = projectPlan(clampAllToPlan(clone, PROFILES));
    return { bondId, out: out2 };
  };
  const investment = bondArm("investment");
  const education = bondArm("education");

  const years = baselineOut.yearly.length;
  const series = [];
  let cumTaxBaseline = 0, cumTaxInvestment = 0, cumTaxEducation = 0;
  for (let y = 0; y < years; y++) {
    cumTaxBaseline += baselineOut.yearly[y].tax;
    cumTaxInvestment += investment.out.yearly[y].tax;
    cumTaxEducation += education.out.yearly[y].tax;
    series.push({
      year: y, age: out.schedule.clientAges[y], fyLabel: out.schedule.fyLabels[y],
      netAssetsBaseline: baselineOut.yearly[y].netAssets,
      netAssetsInvestment: investment.out.yearly[y].netAssets,
      netAssetsEducation: education.out.yearly[y].netAssets,
      cumTaxBaseline, cumTaxInvestment, cumTaxEducation,
      educationBenefit: education.out.yearly[y].bondDetail[education.bondId]?.educationBenefit ?? 0,
    });
  }

  const last = series[years - 1];
  // Non-prescriptive: the tool reports what THIS client's own numbers
  // show, never a recommendation. Flagged explicitly per the spec's
  // own instruction — "the tool exists to reveal that rather than to
  // sell the product" — whenever a bond arm ends up WORSE than simply
  // saving outside one for this client (a low marginal rate can make
  // the bond's flat internal rate a worse deal than paying tax on the
  // ordinary asset each year, especially once its own CGT discount is
  // considered).
  const investmentWorseThanBaseline = last.netAssetsInvestment < last.netAssetsBaseline;
  const educationWorseThanBaseline = last.netAssetsEducation < last.netAssetsBaseline;

  return {
    child: { id: child.id, name: child.name },
    seed,
    series,
    flags: { investmentWorseThanBaseline, educationWorseThanBaseline },
    // Surfaced constraints (the spec's own words) — disclosure text,
    // not a calculation the engine can check for an arbitrary plan:
    // the ten-year rule interacts badly with a child already close to
    // school-leaving age (little time for the clock to run before fees
    // start drawing the bond down), and the 125% rule limits how much a
    // late-starting family can catch up in one year.
    disclosure: "A bond's own tax treatment depends on holding it past the ten-year mark — a child already close to " +
      "school-leaving age may not give it time to mature before fees start drawing it down. The 125% rule limits how " +
      "much a late start can be caught up in a single year without resetting that clock. And a bond is not free: its " +
      "flat internal rate beats a top marginal rate but loses to a low one — nothing here recommends the structure, " +
      "only shows what this client's own numbers do with it.",
  };
}
