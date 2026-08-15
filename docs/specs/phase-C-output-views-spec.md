# Phase C — Output Views (Transposed Ledgers, View Rail, Setup, In-Grid Editing)

## Context for the executing session

Continues the Xtools+ replacement on branch `claude/monte-carlo-investment-app-R9XSB`.
Depends on Phase B (`6edd9f9`) and — for the Tax and Assumptions views and the
residency wiring — on Phase B.1 (tax). If B.1 is not yet merged, build commits C1
and C2 now and C3/C4 after it lands.

This phase restructures the output area into an Xplan-style multi-view layout with
a left view rail and **transposed tables (years as columns, line items as rows)**,
adds a report period selector, an expanded Setup section with tax-profile inputs,
and in-grid editing of one-off amounts. Four commits, in order:

- **C1** — transpose infrastructure, view rail, Projection + Cashflow + Assets
  views, report period selector.
- **C2** — in-grid one-off editing in the Cashflow view.
- **C3** — Setup section + residency/Medicare-exemption wiring into tax
  (requires B.1).
- **C4** — Tax view + Assumptions view (requires B.1).

Commit after each. All existing conventions (FY anchoring, real-terms engine,
display-time nominal scaling, auto-hiding of empty data) carry over unchanged.

## C1 — View rail, transposed tables, core views, period selector

### Layout
The output area becomes: a slim **left rail** listing views, and the view canvas.
Rail entries: Projection, Cashflow, Assets, Tax, Assumptions, then greyed
coming-soon entries: Super, Liabilities, Net assets. (Tax and Assumptions appear
greyed until C4 ships them; don't hide them.) Active view highlighted; the
per-view export button and the units toggle live in the view header as now.
On narrow viewports the rail collapses to a horizontal tab strip.

### Transposed table infrastructure (shared by every table view)
- Years as columns (`FY26–27` short labels), line items as rows.
- Sticky left label column; horizontal scroll for the year columns.
- Negatives in parentheses; en-dash for zero; thousands separators.
- **All-zero rows auto-hidden** (transposed equivalent of the current
  column-hiding). Subtotal/total rows always show.
- Row group headers (visual bands) for the sections described per view.
- Units toggle applies (nominal = display-time × (1+cpi)^t as now).
- CSV export per view exports the transposed orientation, visible period,
  visible rows, named <client>-<scenario>-<view>.csv.

### Report period selector
In the output header, applying to every view including the chart x-range and
all exports: From FY / To FY selects plus presets **All | Next 10 | Next 20**.
Default **All**. Persist the selection per scenario (display state, not plan
state — a small `display.reportPeriod` field is fine).

### View: Projection
The existing chart, unchanged except: x-range follows the period selector, and
the view moves into the rail structure.

### View: Cashflow
Row structure (Xplan CALM style), top to bottom:
- **Income** group: one row per income row as entered (user's label, owner tag
  when couple), then **Total income**.
- **Expenses** group: one row per expense row (labels), then **Total expenses**.
- **Tax** row(s): total tax paid that FY (fills from B.1; renders zero/hidden
  pre-B.1 by the auto-hide rule).
- **Net cashflow** row: income − expenses − tax, labelled
  **Surplus / (deficit)**.
- **Funding** group: Surplus invested (to [asset name]), Deficit funded from
  assets, Unfunded cashflow.
- **One-off amounts** row group: one row per asset that has (or can have)
  one-offs — see C2; read-only in C1 showing net one-offs per asset per year.
Monthly rows annualise into their FY column (the ledger already aggregates by
FY; reuse it — but note the per-line breakdown needs the schedule builder's
per-row annual totals, so extend `deterministic.js`/`schedule.js` to expose
per-cashflow-row FY totals rather than recomputing in the UI).

### View: Assets
An **entity selector** across the top: `Consolidated | <each included asset>`.
- **Consolidated**: the combined detail block as rows — Opening balance,
  Contributions, Withdrawals, One-off amounts, Deficit funding, Growth,
  Tax attributable (post-B.1; auto-hides before), Closing balance — followed
  by a **Closing balance by asset** group: one row per included asset plus
  **Total** (equals the combined closing; assert in a test).
- **Single asset**: the same detail block computed for that asset alone
  (its targeted flows, its share of deficit funding, its growth).
Build the selector as a reusable component — the future Super view uses the
identical pattern (consolidated | per fund).

### C1 acceptance
- Rail navigation switches views without recompute glitches; period selector
  narrows every view + exports; transposed CSVs match visible cells.
- Per-line cashflow rows reconcile: Total income/expenses rows equal the
  Phase B ledger's income/expenses for every FY (test).
- Assets view: per-asset closing rows sum to Total = combined closing every
  year (test); single-asset blocks internally reconcile
  (opening + flows + growth = closing) (test).
- Existing suite passes. Commit:
  `Phase C1: view rail, transposed ledgers, period selector`.

## C2 — In-grid one-off editing (Cashflow view)

The One-off amounts row group becomes editable — the Xplan "type a withdrawal
into year 10" workflow:
- One editable row per included asset (labelled with the asset name). Click a
  year cell → inline numeric input. Enter a positive number = inflow, negative
  = outflow, for that asset in that FY. Committing (Enter/blur) **creates or
  updates a lump sum in plan state** with `source: "table"`, `age` derived from
  the FY, targeting that row's asset. Clearing a cell deletes the table-sourced
  entry.
- Cells summarise: a cell shows the net of ALL one-offs for that asset+FY
  (input-panel-sourced included). Editing a cell that contains input-sourced
  rows edits only the table-sourced amount alongside them — show a small dot
  marker on cells that also contain input-sourced amounts, with a tooltip
  ("includes amounts entered in the input panel").
- Everything downstream updates live (single source of truth — these are
  ordinary lumpSums; the input panel's One-off amounts list shows them with
  the existing "from table" tag, already built in A.1).
- Partial-first-year rule applies: a table entry in the first FY when the
  start month is after July would be skipped by convention 5 — block editing
  that cell with a tooltip explaining why, rather than accepting a value that
  does nothing.

Tests: create/update/delete round-trips through plan state; input-panel list
reflects table edits and vice versa; engine output changes match an equivalent
input-panel entry exactly; first-FY blocking. E2E: edit a year-10 cell, see the
chart and Assets view move, reload, persisted.
Commit: `Phase C2: in-grid one-off editing`.

## C3 — Setup section + tax-profile wiring (requires B.1)

### Setup section
The Plan details bar grows into a full **Setup** section at the top of the
input column (first in the fact-find order), containing:
- Household: Single | Couple; client and partner current ages (existing).
- Timeline: start month/year, projection end age (existing), plus a read-only
  derived summary line (existing).
- **Tax profile, per person** (new; partner column when couple):
  - Tax residency: `Australian resident | Non-resident` (default resident).
  - Medicare levy: `Applies | Exempt` (default applies).
  - Eligible for Centrelink benefits: yes/no — **captured, inert**, tagged
    "Used when Centrelink modelling arrives". No engine effect.
State: `plan.client.taxProfile` / `plan.partner.taxProfile` =
`{ residency, medicareExempt, centrelinkEligible }`, schemaVersion bump with
migration defaulting existing plans to resident / applies / no.

### Engine wiring (extends B.1's `annual.js`)
Per person, when **non-resident**: non-resident bracket table (no tax-free
threshold; current legislated non-resident rates, added to `LEG` alongside the
resident tables and covered by the same bracket-mode scaling), **no Medicare**,
**no LITO**. Franking credits remain refundable offsets in the model —
disclose that non-resident CGT treatment (discount/indexation eligibility
differences under both regimes) is NOT differentiated in this version; the
Parameters modal's tax section gains one sentence on this simplification.
When **Medicare exempt** (resident): levy skipped for that person.

Tests: resident vs non-resident known-value comparison at the same income;
Medicare exemption zeroes the levy only for the exempt person in a couple;
migration defaults.
Commit: `Phase C3: setup section + residency and Medicare wiring`.

## C4 — Tax view + Assumptions view (requires B.1)

### View: Tax
Transposed, from B.1's `taxDetail`. Row groups per person (Client / Partner
when couple), each: Taxable income, Gross tax, Medicare levy, LITO, Franking
credits, Net income tax, CGT payable (in the FY it's PAID, with the accrual
convention noted in the view footer), then a **Household total tax** group.
Auto-hide keeps single-person or no-tax scenarios clean. Footer line for the
end-of-projection accrued CGT when nonzero.

### View: Assumptions
The thresholds-through-time table. Row groups:
- **Economic**: CPI; each included asset's gross nominal return, ICR, net real
  return (per the Fisher convention).
- **Tax brackets**: one row per bracket threshold (both persons' applicable
  table if residencies differ), Medicare lower/upper thresholds, LITO
  parameters — each rendered per FY under the active bracket mode. Under
  "Indexed" + today's dollars these rows are flat (the point of indexation);
  under "No indexation" the real thresholds visibly shrink; future dollars
  shows the nominal picture. Add a one-line caption explaining exactly that,
  so the view teaches the toggle.
- CSV export as with other views. This view is the audit trail for "what
  assumptions did this projection use" — keep labels SOA-friendly.

Tests: assumptions rows reproduce engine inputs (spot-check net real return
matches the deterministic engine's rate for an asset); bracket rows respond to
the bracket-mode toggle and units toggle correctly.
Commit: `Phase C4: tax and assumptions views`.

## Deferred — do not build
- Super / Liabilities / Net assets views (rail placeholders only).
- Monte Carlo rewire (Phase D; correlation decision pending). Additional chart
  types; scenario compare chart; PDF/Word output; insights accordions;
  Centrelink modelling (flag captured only); HELP/MLS/SAPTO/Div 293;
  non-resident CGT differentiation.
