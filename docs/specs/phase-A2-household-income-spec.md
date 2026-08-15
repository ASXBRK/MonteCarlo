# Phase A.2 — Household, Income & Expenses, Surplus/Deficit Settings

## Context for the executing session

Second input-restructure phase on branch `claude/monte-carlo-investment-app-R9XSB`,
directly on top of Phase A.1. Adds the inputs the tax-aware engine (Phases B/B.1)
will consume: single-or-couple household, asset ownership, gross income and expense
sections, surplus/deficit treatment settings, deficit funding order, per-asset
distribution treatment, and per-profile franking assumptions. **State model + input
panel only** — the ledger logic that consumes these arrives in Phase B; the tax that
makes gross income meaningful arrives in B.1.

Commit at the end of this phase before starting anything else.

## Design decisions (locked)

1. **Timeline anchor.** The projection timeline runs on the *client's* age. A partner
   ages alongside (own current age, ticking over each 1 July per the A.1 convention);
   there is no separate partner end age and no mortality modelling — the projection
   ends at the client's endAge with both alive throughout. One-sentence disclosure in
   the Parameters modal.
   **Exception**: income rows anchor from/to ages to the *owner's* age, because
   "partner's salary ends at partner's 65" is how these are specified in practice.
   The FY label derived next to each age input makes the anchor unambiguous.
2. **Expenses are household-level** — no owner field. Only income and assets carry
   ownership (they drive tax attribution in B.1). Contributions, withdrawals, and
   one-offs from A.1 are also ownerless: tax attribution follows the owner of the
   asset they touch.
3. **Surplus treatment is a global setting**, default "additional expenses" (the
   surplus is spent and disappears), alternative "invest to [asset select]".
4. **Deficit funding order** is an explicit, user-reorderable list over included
   assets, defaulting to asset display order. Engine semantics (Phase B): drain the
   first asset to zero, then the next; exhausted → unfunded cashflow. The order is
   user-controlled now partly because it acquires per-owner CGT consequences in B.1.
5. **Distribution treatment is per-asset**: "reinvested" (default — distributions
   stay in the asset and, from B.1, uplift its cost-base pool) or "paid as cash"
   (distributions enter the ledger as income of the asset's owner in that FY,
   feeding the surplus/deficit line; they do not target another asset).
6. **Income is entered gross.** It produces honest numbers only once B.1's tax lands;
   until then the ledger (Phase B) will run pre-tax and say so. Do not add any
   interim "after-tax" labelling.
7. **Franking assumptions live in `profiles.js`**, one `frankingPct` per profile,
   alongside the CMA figures. Ship defensible placeholders (high for
   Australian-equity-heavy profiles, zero for cash and fixed-interest-dominant
   profiles) marked as placeholders pending firm confirmation, and surface them as a
   column in the Parameters modal's asset assumptions table so they are visible, not
   buried. Custom allocations already capture franking per Phase A.

## State model (schemaVersion: 3)

```js
state = {
  plan: {
    household: "single" | "couple",        // default "single"
    client:  { currentAge },               // was plan.currentAge
    partner: { currentAge } | null,        // present iff couple
    endAge,                                 // client-anchored, unchanged meaning
    start: { year, month },                 // unchanged from A.1
  },
  assets: [ Asset ],   // each gains:
                       //   owner: "client" | "partner" | "joint"   (default "client";
                       //     "joint" = 50/50 for future tax attribution)
                       //   distributions: "reinvest" | "cash"      (default "reinvest")
  cashflows: {
    income:   [ IncomeRow ],   // NEW
    expenses: [ ExpenseRow ],  // NEW
    contributions, withdrawals, lumpSums,   // unchanged from A.1
  },
  settings: {
    surplus: { mode: "spend" | "invest", assetId: <id|null> },  // default spend
    fundingOrder: [ assetId ],   // ordered, included assets; see invariants below
  },
  display, assumptions,
  schemaVersion: 3,
}

IncomeRow = {
  id, label,                    // free text, e.g. "Salary", default "Income N"
  owner: "client" | "partner",  // partner option only when household is couple
  amount,                       // gross, real $
  frequency: "monthly" | "annual",
  fromAge, toAge,               // OWNER's age (decision 1); derived FY shown
  indexed: true,
}

ExpenseRow = {
  id, label,                    // e.g. "Living expenses", default "Expense N"
  amount, frequency, fromAge, toAge, indexed,   // ages on CLIENT timeline
}
```

Invariants and migration:
- `fundingOrder` always contains exactly the included assets, in order. Adding an
  asset appends it; excluding/removing one drops it; re-including appends at the end.
  Normalise defensively on hydration.
- Switching couple → single: prompt if any income rows or assets are owned by
  partner ("Reassign to client" / "Delete"); never orphan an owner. Partner ages on
  income rows reanchor sensibly on reassignment (keep the numeric ages, re-derive FY
  labels).
- Migration from schemaVersion 2: wrap existing `currentAge` into `client`, default
  household single, stamp asset defaults (`owner: "client"`,
  `distributions: "reinvest"`), build `fundingOrder` from display order, empty
  income/expenses, surplus default. Failed migration falls back to defaults.

## UI

1. **Plan details bar** gains a `Single | Couple` segmented control; couple reveals a
   partner current-age input beside the client's. Derived summary line unchanged
   (client-anchored).
2. **Assets section**: each card's details row gains an Owner select (hidden entirely
   when household is single — defaulting silently to client) and a
   `Distributions: Reinvested | Paid as cash` control with one line of helper text
   per decision 5.
3. **Cashflows section** gains two subsections *above* contributions (the position
   A.1 reserved):
   - **Income**: label · [owner select, couple only] · gross amount · frequency ·
     from age · to age (owner's age, FY label alongside) · indexed · remove.
     Helper text: "Enter gross (before tax). Tax is calculated from Phase B.1."
     Phrase it in user terms: "Enter income before tax."
   - **Expenses**: label · amount · frequency · from age · to age · indexed · remove.
   Defaults for a fresh plan: no income rows, no expense rows (do not pre-seed —
   an empty section with an add button is clearer than a $0 row here, unlike
   contributions where the row doubles as the primary affordance).
4. **Settings section** (new, compact, below Cashflows):
   - Surplus treatment: "Spend (additional expenses)" | "Invest to [asset]".
   - Deficit funding order: reorderable list (drag or up/down buttons — match
     whatever the existing style supports cleanly) of included assets with a one-line
     explanation: "When expenses exceed income, money is drawn from these assets in
     this order."
5. **Summary strip** gains: annualised gross income and annualised expenses tiles
   (all rows, real terms, current-FY rates).
6. **Parameters modal**: franking column added to the asset assumptions table with a
   placeholder-pending-confirmation note; partner/no-mortality disclosure sentence
   added.

## Acceptance criteria

1. schemaVersion 3 shape as specified; v2 blobs migrate correctly (spot-check asset
   defaults and fundingOrder construction); corrupt blobs fall back cleanly.
2. Couple toggle shows/hides partner age, owner selects, and income owner column;
   couple → single walks the reassignment prompt and never orphans an owner.
3. Income row ages anchor to the selected owner and re-derive FY labels when the
   owner changes; expense ages anchor to the client.
4. fundingOrder invariants hold through add/remove/include/exclude/reorder; order
   survives reload.
5. Surplus "invest" mode requires and retains a valid assetId; target deletion walks
   the same reassign-or-reset dialog pattern.
6. Distribution toggle round-trips per asset; franking column renders in the
   Parameters table for every profile.
7. All existing tests pass or are updated; new unit tests cover migration, owner
   reassignment, and fundingOrder normalisation.
8. `npm run build` succeeds; commit made with message
   `Phase A.2: household, income & expenses, surplus/deficit settings`.

## Deferred (do not build in this phase)

- The ledger itself — monthly surplus/deficit evaluation, deficit funding engine,
  unfunded cashflow tracking (Phase B, pre-tax).
- The annual tax function — per-owner assessment, joint 50/50 attribution, franking
  gross-up and refundable offsets, pooled-cost-base CGT across both regimes,
  CPI-indexed brackets with a no-indexation toggle, FY t paid in FY t+1 (Phase B.1).
- Table view (C), MC rewire + per-path tax (D), insights (E).
- Age pension, super, entities — out of scope for this tool entirely (locked).
