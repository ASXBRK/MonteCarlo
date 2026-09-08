// Retirement input review panel — data layer (docs/specs/35-retirement-
// output-view.md, Commit 2). "The commit that makes this work rather
// than being a relocation": the retirement view carries a review panel
// of every input the projection actually uses, so an adviser never has
// to leave the screen to check what's feeding it or fix the obvious.
//
// Pure: derives the grouped list straight off state, never a hard-coded
// set, per the spec's own instruction ("derive the list from what the
// engine reads... must not drift from what the engine actually
// consumes"). main.js owns turning a group's ids into editable markup
// (option lists, PROFILES, DateRef resolution — all UI-context that
// belongs there); this module only says WHICH rows belong in WHICH
// group, in what order, and which input section "the rest" links out
// to. A group with nothing in it is simply absent from the result —
// the mechanism the spec names as what stops things being missed.
//
// Two groups are always present rather than collection-derived: Income
// Required and Retirement ages are singleton settings that exist for
// every plan (a required-income target, an age), not collections that
// can be empty — "if the scenario has none of something" doesn't apply
// to a value that's always set to *something*.
//
// Excluded from every collection group: rows the scenario has already
// switched off entirely (`include: false` on an asset/super account —
// the SCENARIO-WIDE flag, distinct from the retirement-scoped
// `excludeFromRetirement` docs/specs/35 Commit 3 adds later). An
// excluded row contributes nothing to any projection, retirement
// included, so it does not belong in a panel of "what's feeding this".
import { isCoupleHousehold } from "./planState.js";

export const RETIREMENT_REVIEW_GROUP_ORDER = [
  "income", "super", "contributions", "pensions", "assets", "expenses",
  "incomeRequired", "retirementAges", "glidePath",
];

export const RETIREMENT_REVIEW_GROUP_LABELS = {
  income: "Income rows",
  super: "Super funds and fees",
  contributions: "Contributions",
  pensions: "Pensions",
  assets: "Financial assets",
  expenses: "Expenses",
  incomeRequired: "Income required",
  retirementAges: "Retirement ages",
  glidePath: "Glide path / risk profile",
};

// Where "link out for the rest" sends the adviser — router.js's own
// INPUT_SECTIONS ids, so a stale value here would fail router.test.js's
// exact-match assertion rather than silently 404ing.
export const RETIREMENT_REVIEW_GROUP_SECTIONS = {
  income: "income",
  super: "super",
  contributions: "super", // super contributions/rollovers/withdrawals live in the Super section
  pensions: "pension",
  assets: "financial-assets",
  expenses: "expenses",
  incomeRequired: "settings", // Income Required lives in the Surplus & deficit settings section
  retirementAges: "setup",
  // (glidePath below, out of alphabetical order in the source object but
  // matching RETIREMENT_REVIEW_GROUP_ORDER's own position) — the actual
  // glide path BUILDER (steps, rebalance mode) lives in the Surplus &
  // deficit settings section (docs/specs/32-retirement-phase-one.md,
  // Commit 4); also reachable without leaving the Retirement group at
  // all via Retirement > Balances' own mount of the identical builder
  // (docs/specs/35-retirement-output-view.md, Commit 5).
  glidePath: "settings",
};

export function buildRetirementReviewGroups(state) {
  const plan = state.plan;
  const isCouple = isCoupleHousehold(plan.household) && !!plan.partner;
  const includedSuperAccounts = (plan.superAccounts ?? []).filter((sa) => sa.include !== false);
  const includedAssets = (state.assets ?? []).filter((a) => a.class === "financial" && a.include !== false);

  const idsByGroup = {
    income: (state.cashflows.income ?? []).map((r) => r.id),
    super: includedSuperAccounts.map((sa) => sa.id),
    contributions: (state.cashflows.superContributions ?? []).map((r) => r.id),
    pensions: (plan.pensions ?? []).map((p) => p.id),
    assets: includedAssets.map((a) => a.id),
    expenses: (state.cashflows.expenses ?? []).map((r) => r.id),
    incomeRequired: ["incomeRequired"],
    retirementAges: isCouple ? ["client", "partner"] : ["client"],
    glidePath: includedSuperAccounts.map((sa) => sa.id),
  };

  return RETIREMENT_REVIEW_GROUP_ORDER
    .map((key) => ({
      key,
      label: RETIREMENT_REVIEW_GROUP_LABELS[key],
      sectionId: RETIREMENT_REVIEW_GROUP_SECTIONS[key],
      ids: idsByGroup[key],
    }))
    .filter((g) => g.ids.length > 0);
}
