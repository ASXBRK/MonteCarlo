# Navigation, View Consolidation, and Simple Charts

Conventions per CLAUDE.md. **Four commits, gated.** No engine changes —
presentation and routing only. Every commit's regression gate is
bit-identical projection output.

## Why

The output sidebar carries 30 entries across four flat groups, and the input
sidebar another 15. It is overwhelming before a single number is read.

Two structural causes:

1. **We split by format, not subject.** "Cashflow" exists in Graphs *and*
   Tables. So do Assets, Liabilities and Super. That is the same subject
   listed twice because the chart and the table are separate destinations.
   Xplan's Visualise solves this with chart/table/image icons at the top of
   one view (`docs/reference/xtools-calm-reference.md`, §6).
2. **Everything is flat.** Xtools nests — you expand Input, then Individual,
   then Cashflow, then the screen. Deep, but only a handful of items are
   visible at once.

Consolidating by subject and nesting the groups takes the sidebar from 45
visible entries to roughly a dozen, and — the point — means **adding views
later costs nothing visually.** That is what makes commit 4 affordable.

---

## COMMIT 1 — Subject views with a chart/table toggle

Merge the Graphs and Tables groups into one **Output** group of
subject-based views. Each view carries a chart/table toggle in its header
where both forms exist; where only one form makes sense the toggle is absent
rather than disabled.

| View | Chart | Table |
|---|---|---|
| Projection | ✓ | — |
| Cashflow | ✓ | ✓ |
| Assets | ✓ | ✓ |
| Liabilities | ✓ | ✓ |
| Super | ✓ | ✓ |
| Tax | — | ✓ |
| Net worth | ✓ | ✓ (Key figures) |
| Allocation | ✓ | — |
| Snapshot | — | ✓ |
| Assumptions | — | ✓ |

Mapping from today: `cashflow-bars` + `cashflow` → Cashflow;
`asset-balances` + `assets` → Assets; `liabilities-balances` +
`liabilities` → Liabilities; `super-balances` + `super` → Super;
`net-assets` + `key-figures` → Net worth; `asset-allocation` → Allocation;
`composite` and `money-decomposition` become chart options *within*
Projection and Net worth respectively (see commit 4's chart selector).

The chart/table choice persists per view per scenario in display state.
Routes become `…/output/<subject>` with the form as a query parameter, so a
link to a specific view and form is shareable.

**Audit while you are in here.** Report any view that is a genuine duplicate
of another (not merely the same subject in a different form), and any view
that no longer has a purpose after this consolidation. Do not delete
anything without listing it first.

Commit: `Output: subject views with chart and table forms`

---

## COMMIT 2 — Nested collapsible navigation

Both sidebars become nested and collapsible.

**Input**, grouped:
```
Client        Setup · Tax details · Children
Money in      Income · Deductions
Money out     Expenses · Goals
Assets        Financial assets · Lifestyle assets · Property · Super
Debt          Liabilities
Plan          Implementation · Investment cashflows · Settings
```

**Output**, grouped:
```
Output        Projection · Cashflow · Assets · Liabilities · Super · Tax ·
              Net worth · Allocation · Snapshot · Assumptions
Focus         (7 existing)
What if       (6 existing)
```

Behaviour: one group expanded at a time by default, expanding another
collapses the previous; the group containing the active view is always
expanded; expansion state persists per scenario. Group headers show the
aggregate count and untouched badge of their children, so a collapsed group
still signals what is inside.

Commit: `Navigation: nested collapsible sidebar groups`

---

## COMMIT 3 — Client / Partner / Consolidated selector

Several views answer a materially different question per person. Add the
existing entity-selector pattern (the one the Assets view already uses for
consolidated|per-asset) with options **Consolidated · [Client name] ·
[Partner name]**, shown only when the household is a couple.

Applies to: Cashflow (income, deductions, tax rows), Tax, Super,
Allocation, Net worth, and the Snapshot table — which already has
Client/Partner/Total columns and should use the same control rather than a
separate mechanism.

Where a figure is genuinely household-level and cannot be split (expenses,
working cash, joint liabilities at their joint proportion), show it in all
three modes with a note rather than hiding it or splitting it arbitrarily.

Commit: `Output: client, partner and consolidated views`

---

## COMMIT 4 — Simple single-question charts

The composite chart carries four series on two axes. It is powerful and
dense. Xplan's strength here is the opposite — many charts, each answering
one question ("income funding", "expense funding"). With commit 2's nesting,
more charts cost nothing visually.

Add a **chart selector** within each subject view (a dropdown in the view
header, the way Visualise does it) rather than new sidebar entries:

**Cashflow** → Cashflow bars (existing) · **Income sources** (stacked by
category: salary, rent, distributions, cash interest, capital drawdown) ·
**Expense funding** (stacked: met from income, funded by selling assets,
unfunded — the affordability picture in one image, and probably the single
most useful chart here) · **Tax by type** (income tax, CGT, contributions
tax, Div 293/296, HELP, MLS) · **Where the surplus went** (once spec 16
lands; omit cleanly until then).

**Net worth** → Net assets (existing) · Composite (existing) ·
Where the money went (existing) · **Debt vs assets** (two lines, with the
crossover year annotated — powerful for a young client with a mortgage).

**Super** → Super balances (existing) · **Super vs non-super** (the
salary-sacrifice question made visual, with preservation age marked).

Every chart follows the existing conventions: age axis, units toggle, period
selector, hide-empty, PNG export, and the client/partner/consolidated
selector from commit 3 where the split is meaningful.

Tests: each new chart's series reconcile to the ledger rows they claim to
represent, asserted per year, not just in total.

Commit: `Charts: single-question views within subject selectors`
