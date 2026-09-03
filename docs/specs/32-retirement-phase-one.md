# Retirement Projections — Phase One

Conventions per CLAUDE.md. **Five commits, gated.**

## Why, and what this is not

The firm currently produces retirement projections in Midwinter, with super
and investment projections sometimes done separately in Excel. **The two
disagree** — Excel says $2m at retirement, Midwinter starts its projection
from $1.8m, and nobody can reconcile them because they are separate models.
That reconciliation failure is the strongest argument for this work: our
super projection *is* our cashflow projection *is* our retirement
projection.

A second objection from the firm matters as much. Advisers see retirement
projections for young clients as near-meaningless, because a single
deterministic line thirty years out hides enormous variance. **They are
right**, and the honest answer is a distribution rather than a line — which
we already have. Phase one lays the groundwork; the Monte Carlo framing
follows.

**This is not a separate engine.** Numbers must reconcile with the main
projection by construction. Phase one adds inputs and outputs to the
existing engine; the simplified retirement *surface* is a later phase and
will be a filter over the same scenario, not a second model.

---

## COMMIT 1 — Income Required

The concept the engine lacks. It models expenses and reports outcomes;
retirement planning asks whether a *desired income* is achievable.

```
plan.retirement = {
  incomeRequired: {
    source: "currentExpenses" | "custom" | "asfaComfortable" | "asfaModest"
          | "asfaModestRenter",
    customAmount,            // real $, when source = custom
    indexBasis, indexExtraPct,
    startAt,                 // DateRef — defaults to the Retirement key date
    stepDownAtAge,           // optional; default null
    stepDownPct,             // e.g. 80% from that age
  },
}
```

- **`currentExpenses` is the default**, since expenses are already entered
  in the wider program. It resolves to total household living expenses at
  the retirement year, indexed forward.
- **`custom`** is free text, for a client who has stated a target.
- ASFA sources are wired in Commit 2.

**Income Required is a reference line, not a driver, in this commit.** The
projection continues to draw per the existing pension drawdown settings; the
requirement is measured against what the plan delivers. A toggle to *drive*
drawdown from it comes in Commit 4.

**Interpretation to fix and state:** Income Required is **after-tax income
received by the household**. Compare it against net income after tax, not
gross drawdown. State this on the input and in the Parameters modal.

Tests: each source resolving correctly; indexation; step-down applying from
the right age; the requirement appearing in the ledger as a reference figure
without altering any projection value.
Regression gate: scenarios without a retirement block bit-identical.
Commit: `Retirement: income required`

---

## COMMIT 2 — ASFA Retirement Standard

The reframing that turns a shortfall into a calibration. Rather than "you
fall short", the answer becomes *"your $90,000 target is met until 87; at
the ASFA Comfortable standard of $78,566 it lasts past 95."*

### Figures — supplied by the firm, March quarter 2026

`src/data/asfaStandards.js`, stamped **"ASFA Retirement Standard, March
quarter 2026"**, every figure overridable.

| | Comfortable | Modest | Modest (renter) |
|---|---|---|---|
| **Single** | $55,923 | $36,434 | $51,164 |
| **Couple** | $78,566 | $52,473 | $69,002 |

Cross-check available in the same source: the Age Pension including
supplements is $31,223 single and $47,070 couple — these should match the
age pension figures already in `agePension.js` from the Big Black Book. **If
they do not, report it rather than reconciling silently.**

**Note the renter figures sit between modest and comfortable.** A couple
renting needs $69,002 — well above modest homeowner ($52,473) and
approaching comfortable. Renting in retirement is a materially different
plan, not a minor adjustment.

ASFA publishes **quarterly**. Warn when a projection runs and the stamped
quarter is more than two quarters old. Do not web-search updates — ask.

### Homeowner status derived, not asked
Whether the client will own outright at retirement is something the engine
already knows. Derive it: if there is no principal residence, **or** a
mortgage secured against it still has a balance at the Retirement key date,
the honest comparison is the **renter** standard. Provide an override, but
default to the derived answer — quoting "Comfortable" to a client who will
still be paying a mortgage at 67 is misleading, and the tool should not
require the adviser to remember that.

### Lifestyle descriptors — as data, not prose
Store the ASFA lifestyle descriptions as **ten categories × four standards**
so any comparison can be rendered — the client's own band, the band above,
or the difference between them.

Categories: private health · connectivity · vehicle · leisure · home repairs
and appliances · haircuts · utilities · meals out · clothing · travel.

Four standards: Comfortable · Modest · Modest (renter) · Age Pension only.

Full text as supplied by the firm; reproduce it faithfully rather than
paraphrasing. Example rows (Comfortable / Modest / Modest renter / Age
Pension):
- **travel**: "Annual domestic trip to visit family, one overseas trip every
  seven years" / "Annual domestic trip or a few short breaks" / "Annual
  domestic trip or a few short breaks" / "Occasional short break or day trip
  in your own city"
- **vehicle**: "Own a reasonable car, car insurance and maintenance/upkeep" /
  "Owning a cheaper, older, more basic car" / same / "Limited budget to own,
  maintain or repair a car"

**Labelling.** "Comfortable" is ASFA's term with a specific meaning. Label
it "ASFA Comfortable (couple, homeowner)" rather than as our judgement about
what is comfortable for that client. Show the homeowner assumption wherever
a figure appears.

Tests: single and couple variants for all three standards; homeowner status
derived correctly from a mortgage running past retirement and from an absent
principal residence, with the override working; the age pension cross-check
against `agePension.js`; staleness warning past two quarters; descriptors
addressable by category and standard.
Commit: `Retirement: ASFA Retirement Standard and lifestyle descriptors`

---

## COMMIT 3 — Retirement analytics

Five to seven numbers that answer what the client actually asked. We compute
every one and surface none as a headline.

`src/retirementAnalytics.js` (pure, tested):

| Figure | Definition |
|---|---|
| **First shortfall age** | The existing unfunded-cashflow measure. **Household-wide** — state the difference from Midwinter's "Age ABP Runs Out", which is super-only. |
| **Super/pension exhaustion age** | When super and pension balances reach zero, reported separately. This is Midwinter's headline and advisers will look for it. |
| Capital at retirement | Net assets at the Retirement key date |
| Capital at life expectancy | Net assets at the LE anchor |
| Average retirement income | Mean household after-tax income, retirement to LE |
| Average age pension | Mean entitlement, **and as a percentage of total income** |
| **Sustainable income to LE** | The solver's answer: what could be drawn and last to the LE anchor |

**Life expectancy handling.** Report against the LE anchor **and at LE + 5**
— outliving the average is the risk that matters, and the anchor already
supports offsets. Where the two differ materially, that difference is itself
worth showing.

**Sustainable income** uses the existing `solveFor` machinery. Where a
client's target is not sustainable, this number *is* the advice.

Rendered as a summary card at the top of the retirement view, and available
to the Word output in a later phase.

Tests: each figure against a hand-computed scenario; shortfall age matching
the engine's own; sustainable income producing a plan that lasts to LE when
applied; both LE and LE+5 variants.
Commit: `Retirement: analytics summary`

---

## COMMIT 4 — Glide path

The firm already does lifecycle investing by hand — the Midwinter output
assumes **8% accumulation and 5.85% pension**, which is a single-step glide
path expressed as two return assumptions.

```
plan.glidePaths = [ {
  id, name,
  steps: [ { fromAge, profile } ],   // ordered
  rebalance: "annual" | "drift",     // default annual
} ]
```
Assignable to a super account, pension or financial asset in place of a
fixed profile.

- **Interpolate between profiles** by age using the class weights, so the
  shift is gradual rather than a cliff, unless two steps are adjacent.
- **Annual rebalancing is the default** and it matters more than it looks:
  over thirty years, rebalancing to target versus letting growth assets
  drift produces materially different outcomes, and drift always overstates
  the growth allocation. Annual rebalance is what a managed portfolio
  actually does. Make drift the option.
- Ship **two presets** so it is usable immediately: a single-step one
  (High Growth → Balanced at retirement, matching current firm practice) and
  a gradual one (stepping down over the ten years before retirement, then
  again at 75).

**Outputs:** the existing asset allocation chart already plots class weights
over time — with a glide path it will show defensive rising, which is
exactly the picture that justifies the strategy. Verify it renders correctly
with a glide path applied; that chart is a deliverable of this commit.

Also add the **income-driven drawdown toggle** deferred from Commit 1: when
on, pension drawdown targets Income Required, floored at the statutory
minimum (the existing "expend" behaviour). When off, drawdown follows its
own settings and Income Required stays a reference line. **Both are
wanted** — one shows the plan running out, the other shows the shortfall
against target.

Tests: interpolation between profiles; annual rebalance versus drift
diverging as expected; the allocation chart reflecting the glide; the
drawdown toggle floored at the statutory minimum.
Commit: `Retirement: glide paths and income-driven drawdown`

---

## COMMIT 5 — Goal versus position, and the lifestyle band

### 5a. The goal-versus-position chart
The chart most conversations need, and possibly the only one a client sees.
**Two axes at most, four colours, one sentence beneath.**

- Stacked bars: household after-tax income by source — employment, pension
  drawdown, investment income, age pension, asset drawdown
- Line: **Income Required**
- Optional lines: the applicable ASFA standards
- Annotate the year delivered income first falls below the requirement
- A generated sentence: *"Your $90,000 target is met until 87, then falls to
  $52,000."*

**Deliberately not** the Midwinter/Xplan approach of welding wealth and
expenditure onto one dual-axis chart — that chart is unreadable and its
concept is better served by two. Wealth over time already has its own views.

### 5b. The lifestyle band
The client-facing artefact, and better than any chart for this purpose.
Place the projected retirement income on the ASFA scale and render the
descriptors for their band and the one above:

> Your projected retirement income of **$61,400** sits between ASFA Modest
> ($52,473) and Comfortable ($78,566) for a couple.
>
> At this level you would expect: basic private health insurance · an older
> basic car · infrequent leisure · limited budget for home repairs · an
> annual domestic trip.
>
> Reaching Comfortable would require an additional **$17,166 a year**, which
> buys: top-level health cover · a reasonable car · regular leisure and club
> membership · restaurant meals · an overseas trip every seven years.

Uses the applicable standards for the household — renter figures where
homeowner status is derived as renting. Which income figure to place on the
scale: **average retirement income from Commit 3**, stated as such, since a
single year would mislead.

### On deterministic versus Monte Carlo
Settled in discussion: comparison charts use **deterministic lines** for
readability. Note in the modal, and carry forward, that our deterministic
projection sits above the Monte Carlo median by roughly σ²/2 a year — about
0.45% for High Growth against 0.045% for Defensive. Over thirty years that
is ~13% and it **always favours the higher-volatility option**. Phase two
must either plot geometric-equivalent returns or disclose the bias
prominently. **Do not build the sensitivity comparison in this phase.**

**Open question to raise, not resolve:** whether the firm's CMA returns are
arithmetic or geometric means. If geometric, no drag adjustment is needed.
Same person as the Accelerated Growth query.

Tests: chart series reconcile to the ledger per year; the crossover
annotation lands on the right year; the generated sentence matches the
plotted figures; the lifestyle band selects the correct standards for
household type and homeowner status.
Commit: `Retirement: goal versus position chart and lifestyle band`

---

## Deferred — later phases
The simplified retirement *mode* surface (a filter over the same scenario,
hiding sections without data). The Word output builder and its tickbox
panel. Sensitivity comparison charts across profiles and expenditure levels.
Monte Carlo framing for young clients — lifecycle versus growth as
distributions. The expenditure-funding chart. Comparison documents across
scenarios.

