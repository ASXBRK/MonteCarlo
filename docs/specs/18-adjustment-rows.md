# Adjustment Rows

Conventions per CLAUDE.md. **Three commits, gated.** This introduces a new
money flow — extend `randomScenario()` and the conservation invariant in the
same commit that adds it.

## Why

Ranked third on the research's own value list
(`docs/reference/xtools-calm-reference.md`, §11) and still unbuilt. Every
Xtools display table carries editable override rows — `Tax Adjustment`,
`Plus Assessable Income Adjustment`, `Expenses Adjustment`, `Medicare
Adjustment` — marked with a pencil icon, plus a free-entry `Other Offsets`
row (§8).

That is how they survive an imperfect engine. The adviser overrides the one
number that is wrong instead of abandoning the tool. Two forum requests were
answered with "you can't" that an adjustment row would have solved outright:
a PAYG withholding variation, and non-resident interest withholding at 10%
(§10, items 3).

We will always have gaps — some deliberate, some not yet found. Adjustment
rows retire a whole class of feature request rather than one instance.

**The risk, and the design constraint that answers it.** An override that is
invisible is a lie: a figure an adviser assumes was computed but was in fact
typed. So every adjustment must be visibly marked wherever it appears, listed
in one place, and included in exports. An adjusted projection must never be
mistakable for a computed one.

---

## COMMIT 1 — Model and engine

### State
```
plan.adjustments = [ Adjustment ]

Adjustment = {
  id,
  target,          // which row — see the registry below
  owner,           // "client" | "partner" | "household"
  label,           // free text; defaults to the target's own label
  amount,          // real $, signed — positive increases the row
  from, to,        // DateRef window, so an adjustment can be time-limited
  indexBasis, indexExtraPct,
  note,            // free text — WHY. Required; an unexplained override is
                   // worse than none, and this is what an adviser reads in
                   // six months.
}
```

### Adjustable targets (a registry, not arbitrary paths)
Deliberately narrow. Each entry names the ledger field it adjusts and the
side of the conservation invariant it lands on:

- `income.assessable` — increases/decreases assessable income (leak: none;
  it is income)
- `income.nonTaxable` — non-assessable receipt
- `deductions` — increases/decreases deductions
- `tax.incomeTax` — the PAYG/assessment case: adjusts tax payable
- `tax.withheld` — adjusts PAYG withheld only, leaving liability alone;
  this is the withholding-variation case the forum asked for twice, and it
  settles through the existing refund mechanism
- `tax.medicare`, `tax.help`, `tax.cgt` — per-component overrides
- `expenses` — household expense adjustment
- `superContributions` — per account

Plus a free-entry **Other** on the income, deduction, tax and expense
sections, which is the same mechanism with a user-supplied label.

**Do not make arbitrary fields adjustable.** A registry keeps the
conservation invariant tractable and stops the feature becoming a way to
make any number say anything.

### Conservation
Each adjustment is a named term. An income adjustment is income; a tax
adjustment is a leak; an expense adjustment is a leak; a withheld adjustment
is a *timing* change only and must net to zero across the two years it
straddles — assert that explicitly, since it is the one that could silently
create money.

Tests: each target adjusts the right ledger field and nothing else; a
withheld-only adjustment leaves total tax unchanged across the pair of years;
time-limited adjustments apply only in their window; indexation applies;
conservation holds with `randomScenario()` generating adjustments.
Regression gate: scenarios with no adjustments bit-identical.
Commit: `Adjustment rows: model, registry, and engine`

---

## COMMIT 2 — Table integration and marking

- Adjustable rows in the Cashflow and Tax tables gain an edit affordance.
  Clicking opens a small editor: amount, window, indexation, and the
  required note.
- **An adjusted row is visibly marked in every view it appears in** — a
  distinct icon and a tinted cell, with the note as its tooltip. Use the
  same treatment consistently; an adviser must be able to scan a table and
  see instantly which figures were touched.
- The adjustment appears as its own sub-row beneath the computed figure
  (`Computed` / `Adjustment` / `Total`), following the Xtools "Amount /
  Special / Total" pattern from §2 of the reference rather than silently
  replacing the number.
- Exports carry the marking: CSV gains an adjustment column; the
  paste-into-Word HTML keeps the sub-rows.

Commit: `Adjustment rows: table editing and visible marking`

---

## COMMIT 3 — Adjustments review panel

A single place listing every adjustment in the scenario: target, owner,
amount, window, note, and a jump-to link. Reachable from the output header
beside Parameters.

- A count badge appears whenever any adjustment exists — an adjusted
  scenario should announce itself.
- Any view or export produced from a scenario containing adjustments carries
  a one-line footer: "This projection includes N manual adjustments." Not a
  warning, a fact.
- Adjustments survive scenario duplication and are listed as untouched in
  the spec-15 review panel when copied, since an override that made sense in
  one scenario may not in another.

Commit: `Adjustment rows: review panel and disclosure`

---

## Deferred — do not build
Adjusting arbitrary ledger fields outside the registry. Per-year adjustment
grids (the DateRef window plus indexation covers the realistic cases).
Adjustments inside Monte Carlo paths beyond what falls out of the
deterministic run. Adjustment templates.
