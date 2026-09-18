// Input review panel — data layer (docs/specs/35-retirement-output-
// view.md, Commit 2; generalised beyond Retirement by docs/specs/38-
// finding-and-editing-inputs.md, Commit 1). "The commit that makes this
// work rather than being a relocation": every output view carries a
// review panel of every input the projection actually uses, so an
// adviser never has to leave the screen to check what's feeding it or
// fix the obvious.
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
// switched off entirely (`include: false` on an asset/super account/
// bond — the SCENARIO-WIDE flag, distinct from the retirement-scoped
// `excludeFromRetirement` docs/specs/35 Commit 3 adds later). An
// excluded row contributes nothing to any projection, retirement
// included, so it does not belong in a panel of "what's feeding this".
//
// ONE builder, not two (docs/specs/38, Commit 1's own "do not fork the
// module"): buildReviewGroups(state, order) is what every mount — the
// original Retirement one and every new general one — actually calls.
// buildRetirementReviewGroups(state) is a thin, behaviour-preserving
// wrapper kept for the existing Retirement > Projection mount and its
// own tests (docs/specs/38's own "the existing retirement mount is
// unchanged"): same nine groups, same order, nothing added. The general
// mounts pass REVIEW_GROUP_ORDER instead — the same nine groups PLUS
// liabilities and bonds, the two money-holding collections a narrowly
// retirement-scoped panel never needed but "everything the projection
// uses", read from every OTHER output view, does (a debt chart with no
// Liabilities group in its own review panel would be exactly the kind
// of incompleteness this spec exists to close) — reordered by relevance
// to whichever view is mounting it (main.js's own
// reviewPanelGroupOrderFor), never filtered.
import { isCoupleHousehold } from "./planState.js";

export const RETIREMENT_REVIEW_GROUP_ORDER = [
  "income", "super", "contributions", "pensions", "assets", "expenses",
  "incomeRequired", "retirementAges", "glidePath",
];

// docs/specs/38-finding-and-editing-inputs.md, Commit 1 — the general
// set every non-Retirement mount uses (see this file's own header).
export const REVIEW_GROUP_ORDER = [
  "income", "super", "contributions", "pensions", "assets", "liabilities", "bonds", "expenses",
  "incomeRequired", "retirementAges", "glidePath",
];

export const RETIREMENT_REVIEW_GROUP_LABELS = {
  income: "Income rows",
  super: "Super funds and fees",
  contributions: "Contributions",
  pensions: "Pensions",
  assets: "Financial assets",
  liabilities: "Liabilities",
  bonds: "Bonds",
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
  liabilities: "liabilities",
  bonds: "investment-cashflows", // bonds live in the Investment cashflows section
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

export function buildReviewGroups(state, order = REVIEW_GROUP_ORDER) {
  const plan = state.plan;
  const isCouple = isCoupleHousehold(plan.household) && !!plan.partner;
  const includedSuperAccounts = (plan.superAccounts ?? []).filter((sa) => sa.include !== false);
  const includedAssets = (state.assets ?? []).filter((a) => a.class === "financial" && a.include !== false);
  const includedBonds = (state.bonds ?? []).filter((b) => b.include !== false);

  const idsByGroup = {
    income: (state.cashflows.income ?? []).map((r) => r.id),
    super: includedSuperAccounts.map((sa) => sa.id),
    contributions: (state.cashflows.superContributions ?? []).map((r) => r.id),
    pensions: (plan.pensions ?? []).map((p) => p.id),
    assets: includedAssets.map((a) => a.id),
    liabilities: (state.liabilities ?? []).map((l) => l.id),
    bonds: includedBonds.map((b) => b.id),
    expenses: (state.cashflows.expenses ?? []).map((r) => r.id),
    incomeRequired: ["incomeRequired"],
    retirementAges: isCouple ? ["client", "partner"] : ["client"],
    glidePath: includedSuperAccounts.map((sa) => sa.id),
  };

  return order
    .map((key) => ({
      key,
      label: RETIREMENT_REVIEW_GROUP_LABELS[key],
      sectionId: RETIREMENT_REVIEW_GROUP_SECTIONS[key],
      ids: idsByGroup[key],
    }))
    .filter((g) => g.ids.length > 0);
}

// Unchanged behaviour, unchanged call site (Retirement > Projection) —
// see this file's own header on why this stays a thin wrapper rather
// than every caller passing RETIREMENT_REVIEW_GROUP_ORDER by hand.
export function buildRetirementReviewGroups(state) {
  return buildReviewGroups(state, RETIREMENT_REVIEW_GROUP_ORDER);
}

// docs/specs/38-finding-and-editing-inputs.md, Commit 1 — "looking at
// debt charts should surface liabilities first; looking at super
// balances should surface super. Order by relevance to the current
// view, with everything else still present below." Pure data (kept
// here, not in main.js, specifically so reviewPanelGroupOrderFor's own
// "reorders, never filters" guarantee is unit-testable — main.js has no
// DOM test harness in this codebase, so any logic worth a direct test
// belongs in a module that doesn't import one). One entry per activeView
// id (main.js's own VIEW_MOUNTS/renderActiveView keys) naming the
// group(s) that view's own chart/table most directly reads, promoted to
// the front of REVIEW_GROUP_ORDER; every group NOT listed here still
// follows, in its own default order. A view with no entry (or an empty
// list) simply gets the default order, which is itself a reasonable
// "most plans care about income/super/assets first" starting point.
export const REVIEW_PANEL_RELEVANT_GROUPS = {
  projection: ["assets", "super", "pensions", "liabilities"],
  composite: ["income", "expenses", "assets", "super"],
  "net-assets": ["assets", "super", "liabilities"],
  "asset-balances": ["assets"],
  "asset-allocation": ["assets", "glidePath"],
  "monte-carlo": ["assets", "super", "glidePath"],
  "super-balances": ["super", "contributions", "glidePath"],
  "liabilities-balances": ["liabilities"],
  "cashflow-bars": ["income", "expenses"],
  "money-decomposition": ["income", "expenses"],
  "income-sources": ["income"],
  "expense-funding": ["expenses"],
  "tax-by-type": ["income"],
  "debt-vs-assets": ["liabilities", "assets"],
  "super-vs-non-super": ["super", "assets"],
  "age-pension-chart": ["incomeRequired", "retirementAges"],
  cashflow: ["income", "expenses"],
  assets: ["assets"],
  tax: ["income"],
  super: ["super", "contributions", "glidePath"],
  pension: ["pensions"],
  "age-pension-table": ["incomeRequired", "retirementAges"],
  "death-benefits": ["pensions", "super"],
  liabilities: ["liabilities"],
  bonds: ["bonds"],
  "aged-care": ["assets"],
  "monte-carlo-table": ["assets", "super"],
  "focus-deposit": ["assets", "liabilities"],
  "focus-fhsss": ["contributions", "super"],
  "focus-salary-sacrifice": ["contributions", "income"],
  "focus-debt-payoff": ["liabilities"],
  "focus-debt-recycling": ["liabilities", "assets"],
  "focus-education-funding": ["expenses"],
  "focus-surplus-allocation": ["income", "expenses"],
  "focus-ppr-exemption": ["assets"],
  "focus-age-pension": ["retirementAges", "assets"],
  "focus-death-benefits": ["pensions", "super"],
  "focus-aged-care-accommodation": ["assets"],
  "focus-aged-care-planning": ["assets"],
  "focus-equity": ["assets", "liabilities"],
  "focus-transfer-schedule": ["assets"],
  "whatif-rate-shock": ["liabilities"],
  "whatif-crash": ["assets", "super"],
  "whatif-income-gap": ["income"],
  "whatif-expense-shock": ["expenses"],
  "retirement-balances": ["super", "pensions", "glidePath"],
  "retirement-monte-carlo": ["incomeRequired", "glidePath"],
  "retirement-lifecycle": ["glidePath"],
};

// Reorders REVIEW_GROUP_ORDER by relevance to `view` — relevant groups
// (filtered to real keys, so a typo above can't silently invent a
// group) lead, then every remaining group follows in its own original
// order. Never drops a key: `reviewPanelGroupOrderFor(view).sort()` is
// always exactly `REVIEW_GROUP_ORDER.sort()` for every view, mapped or
// not — the property the spec's own "with everything else still
// present below" names, and the one this function's own test suite
// checks directly rather than trusting by construction alone.
export function reviewPanelGroupOrderFor(view) {
  const relevant = (REVIEW_PANEL_RELEVANT_GROUPS[view] ?? []).filter((k) => REVIEW_GROUP_ORDER.includes(k));
  const rest = REVIEW_GROUP_ORDER.filter((k) => !relevant.includes(k));
  return [...relevant, ...rest];
}
