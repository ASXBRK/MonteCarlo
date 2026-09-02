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

A second objection from the firm matters just as much. Advisers see
retirement projections for young clients as near-meaningless, because a
single deterministic line thirty years out hides enormous variance. **They
are right**, and the honest answer is a distribution rather than a line —
which we already have. Phase one lays the groundwork; the Monte Carlo
framing follows.

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
    source: "currentExpenses" | "custom" | "asfaComfortable" | "asfaModest",
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
- **ASFA options are deferred to Commit 2** — they carry a data dependency.

**Income Required is a reference line, not a driver, in this commit.** The
projection continues to draw per the existing pension drawdown settings; the
requirement is measured against what the plan delivers. A toggle to *drive*
drawdown from it comes in Commit 4.

**Interpretation to fix and state:** Income Required is **after-tax income
received by the household**, matching how a client thinks about it and how
Midwinter's chart reads. Compare it against net income after tax, not gross
drawdown. State this on the input and in the modal.

Tests: each source resolving correctly; indexation; the step-down applying
from the right age; the requirement appearing in the ledger as a reference
figure without altering any projection value.
Regression gate: scenarios without a retirement block bit-identical.
Commit: `Retirement: income required`

---

## COMMIT 2 — ASFA benchmarks

The reframing that turns a shortfall into a calibration. Rather than "you
fall short", the answer becomes *"your $90,000 target is met until 87; at
the ASFA Comfortable standard of $73,000 it lasts past 95."*

`src/data/asfaStandards.js` — the ASFA Retirement Standard, **comfortable**
and **modest**, for **single and couple**. Quarterly figures.

**⚠ Sourcing.** Ask the user for the current quarter's figures from ASFA or
the Big Black Book. Do not web-search them — same protocol as aged care and
state duty schedules. Stamp with the quarter and warn when stale.

**Two things must be disclosed on screen, not buried:**
1. The ASFA standards **assume a homeowner with no mortgage**. Quoting
   "Comfortable" to a client who will still have a mortgage at 67 is
   misleading. Show the assumption wherever the figure appears.
2. **"Comfortable" is ASFA's term with a specific meaning.** Label it
   "ASFA Comfortable (couple, homeowner)" rather than as our own judgement
   about what is comfortable for that client.

The benchmarks render as **reference lines alongside the target**, not as
alternatives to it — three lines on one chart, so the gap is legible in
lifestyle terms rather than only in dollars.

Tests: single and couple variants; the homeowner disclosure present
wherever a figure renders; staleness warning past the stamped quarter.
Commit: `Retirement: ASFA benchmark standards`

---

## COMMIT 3 — Retirement analytics

Five to seven numbers that answer what the client actually asked. We compute
every one of these and surface none as a headline.

`src/retirementAnalytics.js` (pure, tested):

| Figure | Definition |
|---|---|
| **First shortfall age** | The existing unfunded-cashflow measure. **Household-wide**, not super-specific — state the difference from Midwinter's "Age ABP Runs Out", which is super-only. |
| **Super/pension exhaustion age** | When super and pension balances reach zero, reported separately. This is Midwinter's headline and advisers will look for it. |
| Capital at retirement | Net assets at the retirement key date |
| Capital at life expectancy | Net assets at the LE anchor |
| Average retirement income | Mean household after-tax income from retirement to LE |
| Average age pension | Mean entitlement, and **as a percentage of total income** |
| **Sustainable income to LE** | The solver's answer: what could be drawn and last to the LE anchor |

**Life expectancy handling.** Report against the LE anchor, and also at
**LE + 5** — outliving the average is the risk that matters, and the
existing anchor already supports LE ± offsets. Where the two differ
materially, that difference is itself worth showing.

**Sustainable income** uses the existing `solveFor` machinery. Where a
client's target is not sustainable, this number *is* the advice.

Rendered as a summary card at the top of the retirement view, and available
to the Word output later.

Tests: each figure against a hand-computed scenario; shortfall age matching
the engine's own; sustainable income producing a plan that lasts to LE when
applied; the LE and LE+5 variants.
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
Assigned to a super account, pension or financial asset in place of a fixed
profile.

- **Interpolate between profiles** by age using the class weights, so the
  shift is gradual rather than a cliff, unless two steps are adjacent.
- **Annual rebalancing is the default** and it matters more than it looks:
  over thirty years, rebalancing back to target versus letting growth assets
  drift produces materially different outcomes, and drift always overstates
  the growth allocation. Annual rebalance is what a managed portfolio
  actually does. Make drift the option, not the default.
- Ship two **preset glide paths** so this is usable immediately: a moderate
  one (High Growth → Balanced at retirement) and a gradual one (stepping
  down over the ten years before retirement, then again at 75).

**Outputs:** the existing asset allocation chart already shows class weights
over time — with a glide path it will show defensive rising, which is
exactly the picture that justifies the strategy. Verify it renders correctly
with a glide path applied; that chart is a deliverable of this commit.

Also add the **income-driven drawdown toggle** deferred from Commit 1: when
on, pension drawdown targets Income Required (floored at the statutory
minimum, per the existing "expend" behaviour). When off, drawdown follows
its own settings and Income Required stays a reference line. **Both
behaviours are wanted** — one shows the plan running out, the other shows
the shortfall against target.

Tests: interpolation between profiles; annual rebalance versus drift
producing the expected divergence; the allocation chart reflecting the
glide; the drawdown toggle floored at the statutory minimum.
Commit: `Retirement: glide paths and income-driven drawdown`

---

## COMMIT 5 — The goal-versus-position chart

The chart most conversations need, and possibly the only one a client sees.

**Two axes at most, four colours, one sentence beneath.**

- Stacked bars: household after-tax income by source — employment, pension
  drawdown, investment income, age pension, asset drawdown
- Line: **Income Required**
- Optional lines: ASFA comfortable and modest
- Annotate the year the delivered income first falls below the requirement
- A generated sentence beneath: *"Your $90,000 target is met until 87, then
  falls to $52,000."*

**Deliberately not** the Midwinter/Xplan approach of welding wealth and
expenditure onto one dual-axis chart — that chart is unreadable and its
concept is better served by two. Wealth over time already has its own views.

**On the deterministic-versus-Monte-Carlo question**, settled in discussion:
comparison charts use **deterministic lines** for readability. But note in
the modal, and carry forward to the sensitivity phase, that our deterministic
projection sits above the Monte Carlo median by roughly σ²/2 a year — about
0.45% for High Growth against 0.045% for Defensive. Over thirty years that
is ~13% and it **always favours the higher-volatility option**. Phase two
must either plot geometric-equivalent returns or disclose the bias
prominently. Do not build the sensitivity comparison in this phase.

**Open question to raise, not resolve:** whether the firm's CMA returns are
stated as arithmetic or geometric means. If geometric, no drag adjustment is
needed. Same person as the Accelerated Growth query.

Tests: the chart's series reconcile to the ledger per year; the crossover
annotation lands on the right year; the generated sentence matches the
plotted figures.
Commit: `Retirement: goal versus position chart`

---

## Deferred — later phases
The simplified retirement *mode* surface (a filter over the same scenario,
hiding sections without data). The Word output builder with its tickbox
panel. Sensitivity comparison charts across profiles and expenditure levels.
Monte Carlo framing for young clients — lifecycle versus growth as
distributions. The expenditure-funding chart (already in the spec 17 list,
retitled for retirement). Comparison documents across scenarios.
