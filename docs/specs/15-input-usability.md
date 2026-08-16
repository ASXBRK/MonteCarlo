# Input Usability — Structure, Defaults, and Children

Conventions per CLAUDE.md. **Three commits, gated.** Commit 1 moves fields
between sections; Commit 2 tracks field paths — doing them in the other
order would mean rewriting every path.

## The problem

The Setup section currently renders eight fields per person, each with a
full sentence of permanently-displayed helper text, in a four-column grid.
It is dense to the point of being hard to scan, and it mixes identity, tax
profile and super settings in one block.

Worse, and the reason Commit 2 exists: **a user cannot tell which values
they entered and which are defaults the app supplied.** A fact find is
gathered over several sittings — you enter what you know, go and find the
rest, come back. A retirement age showing 65 might be confirmed or might be
untouched, and nothing distinguishes them. That is how a wrong default
survives into a projection an adviser signs.

---

## COMMIT 1 — Section restructure and helper text

### Move fields to where they belong
Follow Xplan's own division (Basic Details / Children / Tax Details):

**Setup** keeps identity and timeline only:
first name, surname, date of birth, sex, marital status, retirement age;
plus the existing plan-level projection basis, start date and end age.

**New `Tax details` section** (sidebar, after Setup) takes, per person:
tax residency, Medicare levy, private hospital cover, opening carry-forward
capital losses, work test met. Household `dependentChildren` moves here too
until Commit 3 replaces it.

**Super section** takes the Division 293/296 "tax paid from" selector and
its release-account nomination. These are super settings and belong beside
the accounts they draw on, not in identity.

**Remove `eligibleForCentrelinkBenefits` entirely.** It is inert, drives
nothing, and a field that does nothing is noise in a form that already has
too much. Reintroduce it with Centrelink modelling; migration drops it
silently.

### Helper text becomes tooltips
Every field's explanatory sentence moves into an `(i)` affordance beside the
label — hover on desktop, tap on touch. The label and control are all that
render by default.

Two exceptions stay inline, because they change what the field *means*
rather than merely explaining it:
- the derived age beside date of birth (`· AGE 29`)
- resolved values beneath anchor selects (`age 65 (FY2062–63)`)

Keep tooltip copy to one or two sentences; anything longer belongs in the
Parameters modal, linked from the tooltip.

### Layout
Person blocks render as a two-column grid on wide viewports, single column
narrow — not the current four-column grid, which forces the cramped
wrapping visible today.

Tests: router and section-list updates; migration drops the Centrelink flag
and relocates moved fields without changing any projection output
(regression gate: bit-identical).
Commit: `Input UX: section restructure and tooltip helper text`

---

## COMMIT 2 — Distinguish entered values from defaults

The important one.

### Model
```
state.meta.touched = [ "<dotted field path>", … ]
```
A path is added when the user **changes** a field, and also when they
**confirm** it without changing it. "Touched" therefore means *the user has
attended to this*, not *this differs from the default* — a cleaner and more
honest statement, and it avoids needing a registry of default values to
compare against.

Paths use the existing identifiers, e.g. `plan.client.retirementAge`,
`assets.<id>.balance`, `cashflows.income.<id>.amount`.

### Rendering
Untouched fields render **visually distinct** — muted label and value with a
small dot marker — and their tooltip gains a line: "Not yet reviewed — this
is a default." Touched fields render normally. The distinction must be
legible at a glance without being alarming: this is a status, not an error.

### Confirming a default
When the default is correct, the user needs a way to say so. Provide both:
- a small tick affordance on each untouched field that marks it touched
  without changing the value;
- a section-level **"Mark all remaining as reviewed"**.

Without this the untouched list never empties and the feature becomes noise
people learn to ignore.

### Review panel
A **Review defaults** view listing every untouched field grouped by section,
with its current value and a jump-to link. This is the pre-advice check:
*what in this plan has nobody looked at?*

Sidebar section badges gain a subtle indicator when a section contains
untouched fields, alongside the existing count badge.

### Migration and new scenarios
Existing saved scenarios have no touched data. Mark nothing — showing
everything as unreviewed is honest — but offer "Mark all as reviewed" in the
review panel so an established scenario can be cleared in one action. A
newly created scenario likewise starts fully untouched, which is correct:
nobody has reviewed it yet.

Tests: changing a field marks it; confirming marks it without altering the
value; the review panel lists exactly the untouched fields; mark-all clears
a section; touched state round-trips through save/load and through scenario
duplication; touched state has **no effect on projection output**
(regression gate: bit-identical).
Commit: `Input UX: distinguish entered values from defaults`

---

## COMMIT 3 — Children

Children currently exist only as a bare `dependentChildren` count used for
the Medicare levy surcharge family threshold. They drive far more than that.

### Model
```
plan.children = [ { id, name, dateOfBirth } ]
```
`dependentChildren` becomes **derived** — the count of children under 21 (or
under 25 and studying; do not model the studying condition, use 21 and
disclose) in each projection year, so the MLS family threshold steps down
correctly as children age out rather than being a fixed number for fifty
years. That is a real correctness improvement over the current input.

New **Children** section in the sidebar, after Tax details, matching Xplan's
placement. Each child: name, date of birth, derived current age.

### Education funding
Per child, an optional education funding block — school fees have a specific
shape that Goals and ordinary expenses both fit badly:
```
education: [ { label, annualAmount, fromAge, toAge, indexBasis, indexExtraPct } ]
```
e.g. "Primary" ages 5–12, "Secondary" ages 13–18, each with its own amount.
Fees are **household expenses** flowing through the normal cashflow
mechanism — they are not a new money flow, so no conservation change is
needed. Ages anchor to the **child's** age, which is a new anchoring basis
alongside client and partner; extend the key-date resolution accordingly.

Default indexation for education should be **CPI plus an additional
percentage** rather than plain CPI — school fees have historically outrun
CPI. Default the additional to 2.0% and make it visible and editable rather
than buried, since it is an assumption doing real work over a fifteen-year
schooling window.

Outputs: education fees appear as their own category in the Cashflow table
(the firm's row vocabulary has room under expenses) and as a distinct band
in the cashflow bars chart. Fifteen years of school fees is one of the
largest cashflow items this client base faces and it should be visible as
its own thing, not buried in living expenses.

Tests: derived dependent-children count steps down correctly as children
pass 21, and the MLS family threshold follows; education fees flow to the
right years anchored to the child's age; child-age anchoring resolves
correctly for a child not yet born at projection start (clamp to their birth
year and flag); migration converts an existing `dependentChildren` count
into that many placeholder children with unknown DOBs, flagged as untouched
per Commit 2.
Commit: `Children and education funding`

---

## Deferred — do not build
Childcare costs and Child Care Subsidy; Family Tax Benefit; the under-25
studying condition for dependency; child death benefit pensions; education
savings vehicles (bonds, trusts) as distinct structures; per-child asset
ownership.
