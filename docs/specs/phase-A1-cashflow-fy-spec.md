# Phase A.1 — Plan-Level Cashflow Sections + Financial Year Anchoring

## Context for the executing session

Amendment phase on branch `claude/monte-carlo-investment-app-R9XSB`, on top of Phase A
(`c734897`). Two structural changes before the engine phase: (1) cashflows move from
per-asset arrays to plan-level sections with asset targeting, matching the Xplan model;
(2) time anchoring moves from calendar years to Australian financial years (1 July –
30 June) with a partial first year. **State model + input panel only** — no engine.

This is the first of two input-restructure phases. Phase A.2 (separate spec, do not
start until this is committed) adds household/couple support, income & expenses
sections, and surplus/deficit settings. Where this spec says "reserve space", A.2 is
what fills it.

Commit at the end of this phase before starting anything else.

## Change 1 — Plan-level cashflows

### Why
In Xplan, cashflows are defined at client level, each nominating a funding/destination
account. Per-asset cashflow entry (Phase A) buries flows inside cards and doesn't match
how advisers think ("the client contributes $2k/month" first, "into which account"
second). It also blocks the Income & Expenses sections arriving in A.2, which are
inherently plan-level.

Withdrawals remain a first-class section: regular withdrawals ("$20k every year from
the portfolio") and one-off amounts ("$50k from cash in FY2030–31") are both real
adviser workflows targeting specific assets, distinct from the expense-driven deficit
funding that A.2/B introduce.

### State model (schemaVersion: 2)

Remove `contributions`, `withdrawals`, `lumpSums` from `Asset`. Add at plan level:

```js
state = {
  plan: { ... },                  // see Change 2 for time fields
  assets: [ Asset ],              // unchanged minus cashflow arrays
  cashflows: {
    contributions: [ Cashflow ],  // each gains: assetId (destination)
    withdrawals:  [ Cashflow ],   // each gains: assetId (source)
    lumpSums:     [ LumpSum ],    // each gains: assetId + keeps direction, source tag
  },
  display: { ... }, assumptions: { ... },
  schemaVersion: 2,
}
```

- `assetId` must reference an existing asset. Rows targeting an excluded
  (`include: false`) asset are retained in state but visually flagged and ignored by
  future engine phases (same semantics as the asset itself).
- **Asset deletion with attached cashflows**: confirm dialog lists the affected rows
  and offers "Reassign to [asset select]" or "Delete these cashflows too". Never
  orphan an assetId.
- Migration: hydration of `schemaVersion: 1` blobs lifts per-asset cashflow arrays to
  plan level, stamping each row with its former parent's `assetId`. If migration
  fails for any reason, fall back to defaults cleanly (existing behaviour).

### UI

The single-column layout becomes:

1. **Plan details bar** (see Change 2 for revised fields).
2. **Assets section** — the Phase A cards minus their cashflow subsections. Cards now
   contain: details row, asset allocation, ICR, CGT row. Collapsed summary unchanged.
3. **Cashflows section** — new top-level section with three subsections, each a
   repeatable-row list in the established row style:
   - **Contributions**: To [asset select] · amount · frequency (monthly/annual) ·
     from age · to age · indexed · remove. "Add contribution" button.
   - **Withdrawals**: From [asset select] · same row shape. Helper text retained:
     "Advice fees can be added as a withdrawal."
   - **One-off amounts**: [asset select] · amount · In/Out · age · remove.
     `source: "table"` rows keep their tag and remain editable here.
   - Each from/to/one-off age input shows the derived FY label alongside
     ("age 50 · FY2036–37"), updating live.
   - Layout reserves position for the **Income** and **Expenses** subsections
     arriving in Phase A.2 — a structural comment in the markup is enough; no
     visible placeholder.
4. **Summary strip** — unchanged tiles; annualised contribution/withdrawal totals now
   sum the plan-level sections (included-asset rows only).

Defaults for a fresh plan: one contribution row ($0/monthly, full window, indexed,
targeting the first asset); no withdrawals; no one-offs.

## Change 2 — Financial year anchoring

### Conventions (locked; Phases B/B.1 consume these verbatim)

1. **Plan years are Australian financial years** (1 July – 30 June), labelled
   "FY2026–27" style everywhere a year is shown.
2. **Start point**: the plan stores `start: { year, month }` (calendar), defaulting to
   the current month, both editable in the plan details bar. The projection's first
   plan year runs from the start month to the following 30 June — a **partial first
   year** (e.g. an August 2026 start gives an 11-month FY2026–27).
3. **Projection end**: `endAge` unchanged in meaning; the final plan year is the FY in
   which the client is `endAge` (ages per convention 4). The derived summary line
   becomes e.g. "FY2026–27 to FY2076–77 · age 40 to 90".
4. **Ages tick over each 1 July.** `currentAge` as entered is the client's age at the
   start date; it increments at each FY boundary thereafter. This is a deliberate
   approximation (birthdays are not modelled) — add one sentence to the Parameters
   modal disclosing it.
5. **Annual cashflow timing** (recorded here, implemented in Phase B): annual
   cashflows and one-off amounts fire in July, the first month of each FY. In the
   partial first year, if the start month is after July, that year's annual flows are
   **skipped** — assumed already made earlier in the FY. Monthly cashflows simply run
   for the partial year's months. Document this in the Parameters modal now.

### UI

- Plan details bar: Current age · Projection end age · Start (month + year selects).
- All age inputs across the app display their derived FY alongside as above.
- Parameters modal: add a "Financial year conventions" section covering conventions
  1–5 in user-facing language.

## Acceptance criteria

1. State model matches the schemaVersion 2 shape; v1 localStorage blobs migrate with
   cashflows correctly lifted and stamped; corrupt blobs fall back to defaults.
2. Cashflow rows create/edit/delete in the new sections; asset selects list current
   assets and update on rename; deleting an asset with attached rows walks the
   reassign-or-delete dialog and never orphans an assetId.
3. Rows targeting an excluded asset are visibly flagged.
4. FY labels derive correctly from age inputs everywhere, including the partial first
   year (spot-check: start Aug 2026, age 40 → "age 50 · FY2036–37").
5. Start month/year editable; changing them re-derives all FY labels live.
6. Parameters modal contains the FY conventions and age-approximation disclosures.
7. All existing tests pass or are updated to the new model; new unit tests cover
   migration, FY-label derivation (including July vs August starts), and the
   asset-deletion reassignment path.
8. `npm run build` succeeds; commit made with message
   `Phase A.1: plan-level cashflows + financial year anchoring`.

## Deferred (do not build in this phase)

- Household/couple, ownership, Income & Expenses sections, surplus/deficit settings,
  deficit funding order, distribution treatment toggles, profile franking parameters
  → **Phase A.2** (spec provided separately).
- Schedule builder + deterministic engine (Phase B, pre-tax).
- Annual tax function — income tax, franking, pooled-cost-base CGT, FY t paid in
  FY t+1 (Phase B.1).
- Table view / in-grid editing / CSV (Phase C). MC rewire + tax-in-paths (Phase D).
  Insights accordions (Phase E).
