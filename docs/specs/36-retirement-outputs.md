# Retirement Outputs — Distribution, Not Verdict

Conventions per CLAUDE.md. **Four commits, gated.**

## Why

Two research passes across ProjectionLab, Income Lab, RightCapital, eMoney,
MoneyGuidePro, Boldin, Pralana, Timeline, Voyant, FICalc, cFIREsim,
Xtools+/CALM, Midwinter, Otivo and the ASIC/super-fund calculators produced
one consistent conclusion: **the engine here is ahead of the presentation.**

Every competitor leads with a single anchor — a success percentage, or "your
money lasts until age X". This project has deliberately resisted that, and
the resistance is right: a bare probability frames retirement planning around
fear and failure, and clients do not succeed or fail, they adjust. But the
client will always compare against an anchor. **The task is a legible
headline that does not name a winner.**

Three findings drive this spec:

1. **The Australian floor changes what failure means.** ProjectionLab's
   "Failed Early" describes portfolio exhaustion, which in the US is close
   to destitution. Here the Age Pension is a lifetime income floor, so
   running short means falling back to a pension-supported lifestyle. Our
   buckets should describe **which lifestyle a path sustains**, not whether
   a portfolio survived.
2. **A spend figure beats a probability.** Voyant ships "Retirement Spending
   Insight" — one click, how much can be spent without running out. A dollar
   figure at a stated tolerance answers the question clients actually ask.
3. **The best tools actively discourage over-reading their own outputs.**
   Timeline caps its success rate at 99% and rounds to 1%, stating outright
   that this is to avoid implying a guarantee. RightCapital's own
   documentation warns advisers off its median: *"at best, this only has a
   1/1,000 chance of being exactly true."* Both are nearly free and both
   serve the non-prescriptive convention directly.

**Everything added here must be traceable.** Every default, boundary and
benchmark goes into `docs/reference/assumptions-provenance.md` with its
source and classification, as with every other figure. Xtools+ has a Monte
Carlo and does not disclose its assumptions; ours are disclosed. Under best
interests duty that is the point, not a nicety.

---

## COMMIT 1 — Lifestyle-anchored outcome buckets

Replace one success number with four that describe the shape of the
distribution.

Classify **every Monte Carlo path** by the average household after-tax
retirement income it sustains from the retirement key date to the LE anchor
— the same window and the same measure `retirementAnalytics.js` already uses
for the lifestyle band, so the two can never disagree.

| Bucket | Definition |
|---|---|
| **Above Comfortable** | Average exceeds ASFA Comfortable |
| **Comfortable** | Between ASFA Comfortable and ASFA Modest |
| **Modest** | Between ASFA Modest and the Age Pension floor |
| **At the Age Pension floor** | Average at or below the full Age Pension |

Household type and homeowner status resolve as they already do, so a renting
household is measured against the **renter** standards.

**Report the minimum alongside the average**, because average hides the
question that matters. A path averaging Comfortable while spending five
years at the floor is not a Comfortable retirement:

> **63% of paths sustain ASFA Comfortable or better on average.**
> Of those, 12% drop to the Age Pension floor for a period.

**Do not use "most years" as a classification rule.** It requires an
arbitrary threshold and is no more truthful than either measure above.

**When the Age Pension is excluded** — spec 35 supports this and some
advisers use it — the floor does not exist. The bottom bucket becomes
"portfolio exhausted" and the panel must say so, rather than silently
reporting a floor that has been switched off.

**Ruin probability stays available and stops being the headline.** The
buckets describe the distribution; ruin remains the comparable
scenario-to-scenario figure. Both are shown; the buckets lead.

Each bucket links to its lifestyle descriptors, so "Modest" carries its ten
plain-English categories rather than being an abstract band.

Tests: classification against hand-computed paths at each boundary; renter
standards selected correctly; the minimum figure computed over the same
window; the age-pension-excluded case relabelling the bottom bucket; bucket
percentages summing to 100.
Commit: `Retirement: lifestyle-anchored outcome buckets`

---

## COMMIT 2 — Maximum sustainable spend at a stated tolerance

The headline figure. *"At a 10% ruin tolerance you can spend $72,000 a
year."*

A solver over the **distribution**, not the deterministic projection: find
the highest Income Required at which no more than the chosen share of paths
run short. This is distinct from the existing sustainable-income figure,
which solves against a single deterministic path — state the difference
wherever both appear.

**Tolerance is a selector: 5% / 10% / 20%, defaulting to 10%.** The chosen
figure always appears in the sentence; never report a bare dollar amount.

An info tooltip explains each level and its basis:
- **5%** — conservative. Roughly 1 in 20 paths run short. Defensible where
  there is no Age Pension backstop or a strong bequest motive.
- **10%** — the common planning benchmark in the retirement literature
  (Pfau, Vanguard, Schwab, Morningstar's annual safe-withdrawal work).
  Default.
- **20%** — accepts 1 in 5 paths running short, on the basis that real
  retirees adjust spending rather than continuing blindly into ruin.
  **This assumes a client who will adjust** — say so, because it is a
  different assumption about behaviour, not simply more risk tolerance.

**Report against the ASFA bands**, not as a bare figure: *"$72,000 a year —
between ASFA Modest and Comfortable for a couple."*

**Performance.** Bisection over full Monte Carlo runs is roughly 15
iterations × 2,000 paths. This is a **button with progress and cancel**, not
a live figure — reuse the worker, caching and fingerprint-invalidation
already built for the levers panel in spec 35. Apply the same reduced
search-path count with a full-path confirmation run, and the same explicit
time budget.

Tests: the solved figure produces a plan whose ruin probability sits at the
stated tolerance when applied; each tolerance level solves correctly; the
non-convergent case reports rather than returning a number; caching
invalidates on input change.
Commit: `Retirement: maximum sustainable spend at a ruin tolerance`

---

## COMMIT 3 — Display honesty

Three small changes, all cheap, all serving the non-prescriptive voice.

**The 99% cap.** No probability figure derived from simulation ever displays
above 99%. **Cap the display, not the computation** — the underlying value
stays exact for solvers and scenario comparison, or the spend solver would
converge oddly near the top and two genuinely different scenarios would both
read 99%. Render as `99%+` with the reason in the tooltip, so it is visibly
a cap rather than a coincidence an adviser might mistake for a bug.

**Round to the nearest 1%** everywhere a simulation-derived probability
appears. 92.6% invites a conversation about a 0.6% that 2,000 paths cannot
support.

**Worded confidence bands.** The existing fan chart labels its bands by
percentile. Replace with wording that says what each means, and warn against
the median explicitly — it is the figure every client fixates on and the one
least likely to occur:

> The wide band holds most outcomes, but it is too wide to plan a lifestyle
> around. The narrow band is what to plan against. The median line is
> possible, but almost certainly not exactly what happens.

Apply to every fan chart, including the lifecycle comparison.

Tests: no rendered probability exceeds 99%; underlying values remain
uncapped and unrounded where solvers consume them; rounding applied at every
display site.
Commit: `Retirement: display honesty — 99% cap, rounding, worded bands`

---

## COMMIT 4 — The stat box

A row of figures at the top of Retirement > Projection, at the same visual
weight as the existing analytics card. **Not a banner** — a sentence in a
coloured strip reads as chrome and gets skipped; a number in a box gets
read.

| Savings last until | Providing | Age Pension share | Max sustainable spend |
|---|---|---|---|
| **84** | **$55,920** a year | **41%** | **$72,000** at 10% |

Every figure already exists — this is arrangement, not computation.

**Counterfactuals belong in the levers panel, not here.** "Work two more
years and it lasts until 93" is the *retire later* lever with its answer
filled in, and spec 35 already built that. Do not duplicate it.

**Age Pension in its own colour** on the income stack, so the floor rising
as the portfolio draws down is visible without words. A chart property, not
a callout.

Tests: each figure matches its source; the box reflects tolerance changes;
the age pension series is distinctly coloured across every income chart.
Commit: `Retirement: stat box`

---

## Provenance — required, not optional

Add to `docs/reference/assumptions-provenance.md`:
- The 5/10/20% tolerance levels and the 10% default, classified RESEARCHED,
  with sources.
- The bucket boundaries, classified DERIVED, noting they are ASFA standards
  (RESEARCHED, quarterly) and the Age Pension floor (LEGISLATED).
- The 99% cap and 1% rounding, classified HOUSE VIEW, with Timeline's own
  stated rationale cited as precedent.

---

## Deferred — not this spec
The time scrubber with a per-year metric panel. Pralana's
deterministic-line-through-decile-envelope chart. FICalc's start-year grid.
Criteria-based milestones. A current-versus-scenario two-column comparison.
Word output. Validating the regime-switching variance model against
historical tail behaviour — worth doing, but it is an engine question rather
than a presentation one and deserves its own spec.
