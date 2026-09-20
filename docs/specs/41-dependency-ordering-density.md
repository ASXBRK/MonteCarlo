# Dependency, Ordering, and Density

Conventions per CLAUDE.md. **Six commits, gated.**

Three unrelated pieces of long-standing debt, ordered smallest first so each
is banked before the next begins.

---

## COMMITS 1–2 — Vendor Plotly

### Why

`index.html` loads Plotly from `https://cdn.plot.ly/plotly-2.35.2.min.js`.
This has been a known latent dependency since early in the project and now
costs something concrete:

- **The tool does not work offline or behind a restrictive network.** It
  happens to work on the firm's network today. That is luck, not design, and
  the failure mode is every chart in the application rendering "Plotly failed
  to load" during a client meeting.
- **Spec 40 Commit 3 could not complete.** The chart-series reconciliation
  test is written and guarded, because Plotly cannot load in the test
  sandbox. Charts are currently smoke-tested for mount and height only —
  their series are never checked against the ledger, which is precisely the
  class of defect the adversarial review found three times.
- A third-party CDN is an uncontrolled dependency in a tool producing
  numbers that go into Statements of Advice.

### COMMIT 1 — Vendor it

Install Plotly as a dependency and bundle it. Remove the CDN script tag.

- **Pin the version already in use** (2.35.2) so nothing about rendering
  changes in this commit. Upgrading is a separate decision.
- Consider a **partial bundle** if the full one is heavy — this application
  uses a limited set of chart types, and `plotly.js-basic-dist` or a custom
  bundle may cover them. Measure the difference and report it; if the saving
  is small, take the full bundle for simplicity.
- Verify **every chart in the application** still renders identically. The
  browser smoke test from spec 40 Commit 4 covers 59 areas and is the right
  gate.

Also remove the "Plotly failed to load" guard path, or keep it and note that
it should now be unreachable — decide which, and say why.

Tests: the build contains no reference to `cdn.plot.ly`; the browser suite
passes with network access to that host blocked.
Commit: `Vendor Plotly; remove the CDN dependency`

### COMMIT 2 — Complete the chart reconciliation

With Plotly available in the test environment, **un-guard spec 40 Commit 3's
chart-series test** and make it real.

For a scenario containing accumulation, pension, bonds, property,
liabilities and the age pension: assert that **every chart's plotted series
sums to its ledger source**. This is the assertion that would have caught
findings 1.10, 1.11 and 2.5 in the adversarial review, and it has never been
able to run.

Where a chart legitimately plots something the ledger does not publish
directly, add that to the engine's output rather than deriving it in the
chart — per spec 37 Commit 4, parallel derivation is what caused the drift.

Tests: series reconciliation across every chart; a deliberately introduced
drift failing the suite.
Commit: `Browser: chart series reconcile to the ledger`

---

## COMMITS 3–4 — The assessment-ordering gap

### Why

The same income base has now required attention **three times**:

- Spec 37 Commit 5 — Division 293 excluded the year's net capital gain
- Spec 39 Commit 2 — Division 296 and HELP had the identical gap
- Spec 39 Commit 6 — Division 293, HELP and MLS do not see a
  surplus-cascade-sourced concessional contribution in the year it is made

The third was logged rather than patched, on the reasoning that a fourth
patch to the same surface is the wrong move. That reasoning holds: the
defect is **ordering**, not arithmetic. Assessment runs before the surplus
sweep, so anything the sweep does is invisible to it within that year.

### COMMIT 3 — One income base, one source

Consolidate. There should be **one function** answering "what is this
person's assessment income for year Y", with the specific base (Division 293,
Division 296, HELP, MLS) as a parameter rather than four independent
computations.

The TSB consolidation in spec 37 Commit 2 found two further defects purely
by routing every gate through one source — a gate comparing against a field
that did not exist, and a missing gate entirely. Expect the same here and
report what consolidation exposes.

Do not change behaviour in this commit. Consolidate, assert the outputs are
bit-identical, and commit that before altering the ordering.

Tests: each base producing identical results to today across a range of
scenarios; the consolidation covered by its own test.
Commit: `Consolidate the assessment income base`

### COMMIT 4 — Fix the ordering

With one source, close the ordering gap. Two approaches; pick one and say
why:

1. **Re-run assessment after the sweep**, so it sees the sweep's actual
   contributions. Correct, and costs a second pass.
2. **Lagged differencing** — a deferred top-up next FY, mirroring the
   `pendingDiv293` / `pendingHelpMlsTopUp` pattern spec 39 Commit 2 already
   established for the net-capital-gain version of this same base. Cheaper,
   and consistent with an existing mechanism.

**Conservation is at risk here.** Any change to when an assessment is
computed changes when tax is paid, and this project has produced nine money
bugs, several from exactly this shape — a value decided in one place and
settled in another. Extend `randomScenario()` to generate cascade-sourced
concessional contributions in Division 293 and HELP territory, and confirm
the invariant holds across a stratified sweep. Seeded reproduction from spec
39 Commit 1 means any failure is replayable.

Tests: a cascade-sourced concessional contribution appearing in the correct
assessment year for all four bases; conservation across the extended sweep.
Commit: `Fix: assessment ordering misses cascade-sourced contributions`

---

## COMMITS 5–6 — Input density

### Why

45 input sections, of which a typical retirement client uses six or seven.
Deferred from spec 35 and again from spec 38, on the reasoning that
findability mattered more. Spec 38 delivered findability — the review panel
on every output view, and search across all inputs. **Density is what is
left.**

### COMMIT 5 — Hide-if-empty

An input section with no data collapses to a single line with an add
control, rather than rendering its full empty form.

- **Off by default for a new scenario**, so nothing is hidden while an
  adviser is still entering data. A toggle turns it on; remember the choice
  per user, not per scenario.
- **Never hide a section that has data**, under any circumstance.
- **A collapsed section stays reachable** — by search, by the review panel's
  link-out, and by its own add control. Collapsed is not hidden.
- Show the count of sections currently collapsed, so it is visible that
  something is being withheld rather than missing.

Tests: a populated section never collapses; a collapsed section is reachable
by all three routes; the toggle persists; the count is accurate.
Commit: `Hide-if-empty on input sections`

### COMMIT 6 — Retirement-focused ordering

Deferred alongside hide-if-empty in spec 35.

An ordering of the input rail that puts what a retirement conversation needs
at the top — super, income, contributions, expenses, assets — with
everything else beneath. **An ordering, not a filter**: every section remains
present and reachable.

Selectable rather than automatic, since a debt-recycling conversation wants a
different order than a retirement one. Ship two orderings — default and
retirement — and leave the mechanism open for more.

Tests: both orderings present every section; switching preserves state and
scroll position where sensible.
Commit: `Retirement-focused input ordering`

---

## Not in scope
The APL product comparison tool — blocked on resolving the overlap with the
firm's separate super and insurance tool. Any further browser tests beyond
Commit 2, per spec 40's own "then stop".
