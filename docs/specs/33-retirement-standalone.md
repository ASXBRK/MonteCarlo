# Retirement Projection — Standalone Surface

Conventions per CLAUDE.md. **Four commits, gated.**

## Why this, and why now

Phase one (spec 32) built the capability — Income Required, ASFA standards
and lifestyle descriptors, retirement analytics, glide paths, the
goal-versus-position chart, the lifestyle band. It did not build a surface.
The result is that none of it can be shown to anyone without navigating a
45-entry sidebar built for comprehensive strategy work.

This builds the surface, deliberately narrow: **a page where you type nine
numbers and get a retirement projection.**

**The immediate purpose is a side-by-side comparison.** The firm holds a
second projection tool with its own retirement module. Being able to enter
the same client in both and compare outputs is worth more right now than any
integration, because it turns "ours is better" into a specific list of
differences that can be examined one at a time — some of which will be ours
to fix.

**Deliberately not in scope:** prepopulation from a comprehensive scenario,
mode switching, any adapter to another system, any document output. Those
follow once the comparison has happened. Building them first would be
building on an assumption.

**This is the same surface a retirement mode would need**, built without
prepopulation. It is not a throwaway.

---

## COMMIT 1 — The page and its inputs

A new client-level page, reached from the client page beside "New scenario":
**"New retirement projection"**. It creates a scenario like any other — same
`CLIENT` state, same engine, same storage — so nothing about it is a second
model. What differs is only what is shown.

Route: `#/clients/<cid>/scenarios/<sid>/retirement`, a single page with no
input sidebar.

### The input set — nine fields per person, four household
Kept deliberately short. Anything not listed uses its existing default.

**Per person:** first name · date of birth · retirement age · current super
balance · salary · concessional contributions beyond SG (annual) · risk
profile or glide path.

**Household:** income required (the spec 32 control, all sources) · other
investments as a single lump · other retirement income (annual, indexed) ·
"Include age pension" toggle, default on.

Everything writes to the **existing** state fields — `plan.client.dob`,
`plan.superAccounts[0].balance`, `cashflows.income`, `plan.retirement`, and
so on. **No new state shape.** A scenario created here is a normal scenario
with a small subset populated, and opening it in the comprehensive workspace
shows exactly that.

### Two things that must be visible on the page
- **A one-line assumption summary**: return, fee, inflation, and whether a
  glide path applies. Not buried in a modal — the whole point of the
  comparison is that assumptions are legible.
- **Every derived default labelled**, per the smart-defaults registry.
  "Income required: $73,400 — derived from current expenses" or "— ASFA
  Comfortable (couple, homeowner), March 2026".

Tests: each field writes to the correct existing state path; a scenario
created here opens correctly in the comprehensive workspace and vice versa;
no new state keys introduced.
Regression gate: existing scenarios bit-identical.
Commit: `Retirement: standalone page and input set`

---

## COMMIT 2 — Outputs on the page

Mount what phase one already built, in this order:

1. **Analytics card** (`retirementAnalytics.js`) — first shortfall age,
   super/pension exhaustion age, capital at retirement, capital at LE and
   LE+5, average retirement income, average age pension and its percentage,
   sustainable income to LE.
2. **Goal-versus-position chart** (`goalVsPosition.js`) with its generated
   sentence.
3. **Lifestyle band** (`lifestyleBand.js`).
4. **A super and pension balance chart** — accumulation through drawdown on
   one axis. This is the chart the comparison tool leads with and the one an
   adviser will look for first.
5. **A year-by-year table**: age, super balance, pension balance, drawdown,
   age pension, other income, total income, income required. One screen,
   no entity selector, no period thinning beyond a sensible default.

**Everything updates live as inputs change.** No recalculate button. The
engine is sub-millisecond and immediate feedback is most of why this surface
is worth having.

Tests: each output reconciles to the engine's yearly ledger; the table's
totals match the chart; the analytics card matches `retirementAnalytics.js`
directly.
Commit: `Retirement: standalone page outputs`

---

## COMMIT 3 — Comparison support

The features that make a side-by-side session productive. Small, and they
are the reason the page exists.

- **An assumptions panel**, expandable, listing every assumption in play
  with its value and source: returns by profile, fees, inflation, wage
  growth, contributions tax, earnings tax, drawdown minimums, age pension
  rates and thresholds. Read-only, with a link to Parameters for editing.
  **When two projections disagree, this is the first thing anyone will want
  to see.**
- **Print / PDF of the page** — the whole page as one printable view, so a
  comparison session produces an artefact rather than a screenshot.
- **CSV export of the year-by-year table**, so the two tools' numbers can be
  diffed in a spreadsheet line by line. This is how a disagreement gets
  resolved.
- **A copy-figures action** putting the headline numbers on the clipboard as
  plain text — balance at retirement, first shortfall age, sustainable
  income — for pasting into a comparison note.

Tests: the assumptions panel lists every value the engine actually used, not
a hard-coded list — derive it from the same source the engine reads, so it
cannot drift; the CSV matches the on-screen table.
Commit: `Retirement: comparison support`

---

## COMMIT 4 — A worked comparison fixture

One demo client sized for this exact conversation, plus a written record.

**`src/demo/retirementComparison.js`** — a single person, mid-forties, one
super account, a salary, modest other investments, retiring at 65. Simple
enough that another tool can be given identical inputs without ambiguity;
rich enough that tax, age pension and drawdown all bite.

**`docs/reference/retirement-comparison.md`** — the inputs, our outputs, and
an empty column for the other tool's. Written so the comparison can be filled
in during the session rather than reconstructed afterwards.

State plainly in that document, before any comparison is run, the
**differences we already expect** so they are predictions rather than
excuses:
- We model real tax; a simpler tool may apply a flat rate.
- We model the age pension with means testing; the comparison tool may not
  model it at all.
- We work in real terms with nominal as display; conventions may differ.
- Our SG follows the current statutory rate; check theirs.
- Our deterministic projection sits above the Monte Carlo median by roughly
  σ²/2 per year — relevant if the other tool's returns are geometric means.

**When the comparison happens, differences are findings, not verdicts.**
Some will be ours. The document should have a column for "which is right and
why", filled in per line.

Tests: the fixture projects cleanly and the conservation invariant holds;
the documented figures match a live run.
Commit: `Retirement: comparison fixture and record`

---

## Deferred — after the comparison
Prepopulation from an existing comprehensive scenario. Mode switching.
Any adapter to another system's client record. Document output. Monte Carlo
framing on this surface. Whether this page becomes "retirement mode" or
stays a standalone entry point — that depends on what the comparison
concludes.
