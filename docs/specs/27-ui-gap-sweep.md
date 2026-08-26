# UI Gap Sweep

Conventions per CLAUDE.md. **Five commits, gated.** No engine changes —
every figure this exposes already exists in `projectPlan()` output. The
regression gate for every commit is bit-identical projection output.

## Why

Across specs 21b–26, input and output surfaces were repeatedly deferred to
keep engine work moving. Each deferral was disclosed at the time. They have
now accumulated, and the result is a set of features that compute correctly
and cannot be reached:

| Feature | Engine | Input | Output |
|---|---|---|---|
| Defined benefit pensions | ✅ | ✗ | ✗ |
| Super rollovers | ✅ | ✗ | ✗ |
| Gifts | ✅ | ✗ | partial |
| Investment / education bonds | ✅ | partial | partial |
| Death benefit nominations | ✅ | ✗ | ✅ |
| Age pension additions (spec 26) | ✅ | — | ✗ |

**An engine figure nobody can enter or see is not a feature.** This is one
consolidated sweep so the pattern stops recurring.

**Before starting:** audit the codebase yourself against every spec from 21b
onward and report anything else in this category that the table above
misses. Do not assume the list is complete — it was assembled from grep
counts, not from reading each spec.

---

## COMMIT 1 — Defined benefit pensions and super rollovers

**Defined benefit** — a new input block within the existing Pensions
section, not a separate sidebar entry (it is a kind of pension). Fields per
spec 26: name, owner, commencement DateRef, annual pension, indexation,
tax-free proportion, untaxed proportion, reversionary percentage, notional
taxed contributions. Smart-default provenance tooltips throughout.

Make the **16× transfer balance credit visible** at the point of entry —
"$80,000 pa uses $1,280,000 of your transfer balance cap" — because it is
counter-intuitive and an adviser needs to see it before they are surprised
by it in a table.

**Super rollovers** — a rollover between two super accounts, moving balance
and components proportionally. Where the source is untaxed and the
destination taxed, the 15% tax on the untaxed element applies at rollover
(spec 26 Commit 1) — surface that cost at the point of entry, since
"should I roll West State into an accumulation fund" is the live question
and the tax is the answer.

Commit: `UI: defined benefit pensions and super rollovers`

---

## COMMIT 2 — Gifts and death benefit nominations

**Gifts** — a block in the Age pension or Settings area (choose the more
natural home and say which): amount, date, owner, label. Show the running
five-year window position and the deprived amount live, since the
$10,000/$30,000 interaction is the whole point and is opaque otherwise.

**Death benefit nominations** — a block per person in the Super section:
beneficiaries with relationship and share percentage, with shares required
to total 100%. Derive tax dependency from relationship and **show it** —
"Adult child — not a tax dependant" — because that is the fact clients get
wrong, and stating it at entry is worth more than a table later.

Commit: `UI: gifts and death benefit nominations`

---

## COMMIT 3 — Bonds

Audit what exists first; `planState.js` and `main.js` both reference bonds,
so this may be partial rather than absent. Report what was already there.

Complete the Bonds input section: bond cards (name, owner, type, balance,
start date, allocation, ICR), per-bond contribution rows, and for education
bonds the beneficiary child and education withdrawals.

Two things must be visible at entry because they are the traps:
- **the ten-year date** and years remaining;
- **the 125% headroom** — the maximum contribution that will not reset the
  clock — with a clear warning when an entered contribution would reset it.

Commit: `UI: investment and education bonds`

---

## COMMIT 4 — Outstanding output views

- **Pensions table** gains defined benefit rows: gross pension, deductible
  amount, assessable portion, tax, with the 16× special value shown
  distinctly in the transfer balance display.
- **Age pension table** gains the spec 26 additions — the income-test-only
  treatment of defined benefit income.
- **Key figures** gains defined benefit income as its own line, since it is
  not a balance and does not appear in net assets, which surprises people.
- **Bonds table** — per bond per year: opening, contributions, earnings,
  internal tax, withdrawals, assessable portion, closing, years to ten-year
  date, 125% headroom.
- **Gifts** appear in the Age pension table as deprived assets, and in the
  cashflow as an outflow.

Every table follows the existing conventions: period selector, units
toggle, hide-empty rows, client/partner/consolidated where meaningful,
CSV and paste-into-Word export.

Commit: `UI: outstanding output views`

---

## COMMIT 5 — Reachability check

A test asserting that **every** major state collection has a corresponding
input section and appears in at least one output view. Not a UI test — a
structural one over the state shape and the nav registries:

```
for each collection in [assets, properties, liabilities, superAccounts,
  pensions, definedBenefits, bonds, goals, children, gifts, employers,
  adjustments, superRollovers]:
    assert an INPUT_NAV section renders it
    assert at least one output view reads it
```

This is what stops the gap reopening. When a future spec adds a collection,
this test fails until it is reachable — which is the point.

Also: browser-verify every section added in commits 1–4, and for each,
confirm that entering a value **changes the projection**. A form that saves
state but does not reach the engine is the same defect in a different place,
and the Focus comparison arms have silently done nothing twice already.

Commit: `UI: reachability test and verification`

---

## Deferred — do not build
Aged care inputs (spec not yet written). Any new engine capability — this
sweep exposes what exists and adds nothing.
