# A Browser Test Harness for the Display Layer

Conventions per CLAUDE.md. **Four commits, gated.**

## Why

`src/main.js` is 19,142 lines and has **no automated tests**. The engine
beneath it has 2,253 and a conservation invariant over randomised scenarios.
That asymmetry has now produced a consistent class of defect:

- **Spec 37, the adversarial review** — display totals drifted from the
  ledger. "Total assets" showed $51,582 against net assets of $746,846 on
  adjacent rows. Three separate re-derivations of figures the engine already
  published.
- **Spec 38** — an edit through the review panel updated the engine
  correctly while leaving the input section's own cached DOM stale.
- **Spec 39 Commit 8** — four dead controls in a feature that had just been
  built and hand-verified: a destination dropdown showing the wrong type, a
  silent branch deletion, a permanently unreachable split button, and an
  **entirely non-functional "Add step" button**. The cascade UI shipped in a
  state where a step could not be added.

Every one was found by a person driving a browser, and every one would have
survived the full unit suite indefinitely.

**Playwright is already a dependency** and has been used ad hoc in several
sessions. This makes that standing rather than remembered.

### What this is not

Not a rewrite, not a framework migration, not coverage for its own sake.
**Four commits, then stop.** The goal is a harness that catches dead
controls and drifted displays, not exhaustive UI tests — an over-broad
browser suite is slow, brittle, and gets disabled, which is worse than none.

---

## COMMIT 1 — The harness

Make browser testing a first-class, runnable thing.

- A `test:browser` script alongside the existing `test`, running against a
  built preview rather than the dev server, so it tests what ships.
- Fixture loading through `localStorage` seeding, as the ad-hoc scripts in
  spec 38 and 39 already did — no clicking through setup to reach a state.
- Stable selectors. Where a control lacks one, **add a `data-` attribute
  rather than selecting on text or structure.** Text selectors break on
  copy changes and are the reason ad-hoc scripts kept needing repair.
- **Console errors fail the test.** Several defects in this project
  announced themselves in the console and were only noticed because someone
  happened to look.
- Screenshots on failure, to a gitignored directory.

Keep it fast. If the suite takes more than a couple of minutes it will stop
being run.

Tests: the harness itself runs green against the current build; a
deliberately broken selector fails clearly rather than hanging.
Commit: `Browser test harness`

---

## COMMIT 2 — Every control is alive

The defect class from spec 39 Commit 8: a button that renders and does
nothing.

For **every interactive control in the application** — buttons, selects,
checkboxes, add/remove/reorder actions — assert that operating it produces
an observable change: state changes, the DOM updates, or a recognised
no-op is reported to the user.

**Derive the control list from the DOM rather than hard-coding it**, so a
control added later is covered without anyone remembering. Where a control
is legitimately conditional, the test asserts the condition and then
satisfies it — "the split button appears only with leftover headroom" is a
test, not an exemption.

This single test would have caught all four spec 39 bugs.

Tests: every control in a fully populated scenario; one deliberately
disconnected control failing the suite.
Commit: `Browser: every interactive control is alive`

---

## COMMIT 3 — Displays reconcile to the ledger

The defect class from the adversarial review.

For a scenario containing accumulation, pension, bonds, property, liabilities
and age pension, assert that **every displayed total equals its ledger
source**: totals in Key figures, the Snapshot, the Cashflow statement, every
chart's series sum, every table's totals row, and every CSV export.

Spec 37 Commit 4 added a unit-level reconciliation test. This is the same
assertion **against what actually renders**, which is where the three
original drifts lived.

Include the round trip: edit a value through the review panel or search,
assert the engine changed **and** that every open display followed.

Tests: the reconciliation across all display surfaces; a deliberately
introduced drift failing.
Commit: `Browser: displayed totals reconcile to the ledger`

---

## COMMIT 4 — Smoke across every view

Cheap breadth, to catch the "renders blank" and "throws on empty data"
class.

For **every output view and every input section**, against three fixtures —
a fully populated client, a nearly empty one, and one with a single data
point — assert the view renders, no console errors, and any chart mounts
with a non-zero height. The blank-chart bug in an earlier spec was 19 chart
containers built via `innerHTML` with no CSS height; this is the test that
would have caught it.

Derive the view list from `OUTPUT_VIEWS` and the input section registry, so
a new view is covered on the day it is added.

Tests: all views across all three fixtures.
Commit: `Browser: smoke across every view`

---

## Then stop

Do not extend into exhaustive interaction testing, visual regression, or
per-feature browser tests. Four commits. If a later defect class emerges
that these would not have caught, that is a reason for a specific test, not
a broader suite.
