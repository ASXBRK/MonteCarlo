# Finding and Editing Inputs

Conventions per CLAUDE.md. **Three commits, gated.**

## Why

The tool has 45 input sections. Changing one number means remembering which
section holds it — is salary sacrifice under Super or under Income? — then
navigating there, editing, then navigating back to whatever output prompted
the change. For manual adjustment work, that navigation is most of the time
spent.

Spec 35 already solved this for one view. The retirement input review panel
lists every input the projection uses, editable in place, with a link out
for anything complex, derived from what the engine actually reads. It works,
and it exists in exactly one place.

**This generalises it, and adds search.** The ordering is deliberate: bring
the inputs to wherever you are, make them findable, and only then consider
pushing previews into input sections — because the first two may remove the
need for the third.

### One constraint that is not negotiable

Every reused component must read **the same series and ledger functions the
output views read**. Spec 37 Commit 4 fixed a whole class of defect caused
by `main.js` holding its own parallel notions of "total assets" and "total
income" that had drifted from the engine. A second or third rendering path
with its own derivations would recreate that, and would drift the same way.
Same functions, different container.

---

## COMMIT 1 — The review panel, available everywhere

Generalise `retirementReviewPanel.js` so it can mount under any output view,
not only Retirement > Projection.

- **A toggle on every output view** — collapsed by default, remembered per
  session, opening a panel below the chart or table.
- **Same behaviour as today**: grouped by collection, derived from what the
  engine reads, absent groups simply absent, edit in place through the same
  commit functions the real input sections use, add inline for the four
  kinds already supported, link out for anything more complex.
- **Scope the panel to the view where that is meaningful.** Looking at debt
  charts should surface liabilities first; looking at super balances should
  surface super. Order by relevance to the current view, with everything
  else still present below. Do not filter — hiding an input in a panel whose
  purpose is "everything the projection uses" defeats the point.
- **Editing re-renders the view above it**, so the feedback loop closes
  without navigation.

Do not fork the module. One panel, mounted in more places.

Tests: the panel mounts under every output view; an edit from any mount
reaches the engine and re-renders; relevance ordering differs by view while
the full set remains; the existing retirement mount is unchanged.
Commit: `Input review panel available from every output view`

---

## COMMIT 2 — Search across inputs

A single box at the top of the input rail. Type a term, get matching rows
from every section.

- **Search over row labels, section names, and the values themselves** — so
  "sacrifice", "Super", and "15000" all find the salary sacrifice row.
- **Include aliases and synonyms** for the terms advisers actually use:
  "sac" for salary sacrifice, "NCC" and "non-concessional", "TTR" and
  "transition to retirement", "ABP" and "account-based pension", "offset",
  "PPR" and "main residence". Keep this list in one place so it can be
  extended without hunting through the search code.
- **Results show the section, the row, and its current value**, and click
  through to the row with it focused and highlighted.
- **Edit inline from a result** where the field is simple, matching the
  review panel's own rule.
- **Keyboard**: a shortcut to focus the box, arrow keys through results,
  enter to jump.

This is the fix that keeps working as sections are added. Navigation gets
worse with every new section; search does not.

Tests: a term matching a label, a section name, a value and an alias each
returning the right rows; click-through focusing the correct row; inline
edit reaching the engine; an empty result reporting plainly.
Commit: `Search across all inputs`

---

## COMMIT 3 — Chart and table preview on input sections

**Build this last, and reassess whether it is still needed.** Commits 1 and
2 may have removed most of the pain. If they have, a preview on 45 sections
is 45 places for something to drift.

If it is still wanted:

- **A preview at the bottom of an input section**, collapsible, remembered
  per section.
- **Two tabs: chart and table.** The table is where the value is — a chart
  says something moved, a table says what and when, which is how a wrong
  date window or an event that never fired gets caught.
- **Whole projection, not a window**, per the decision made in discussion.
- **Contextual, not universal**: the section decides which series shows.
  Super sections show super balances, liabilities show debt, income shows
  cashflow. A generic cashflow chart on all 45 is noise.
- **Reuse the existing transposed year table** — years as columns, sticky
  labels — since advisers already read it fluently and a second compact
  table would be a second thing to maintain.

**Do not build a new chart or table implementation.** Mount the existing
ones. If a series is needed that no output view publishes, add it to the
engine's output rather than deriving it in the preview.

**Start with one section — cashflow — and report before extending.** That
will show whether the pattern earns its place.

Tests: the preview reflects an edit in the same section immediately; the
table matches the corresponding output view's table for the same scenario;
collapse state persists.
Commit: `Chart and table preview on input sections`

---

## Not in scope
Any change to the input sections themselves, their ordering, or their
contents. Hide-if-empty on input sections — worth doing, deferred from spec
35, and a separate question from findability.
