# What If — Shock Testing and Rate Uncertainty

Conventions per CLAUDE.md, including the conservation rule: any commit
introducing a new money flow extends `randomScenario()` and the invariant in
the same commit. **Five commits, gated.**

## The organising distinction

A fifth output group joins Graphs, Tables and Focus:

> **Focus** answers *what if I did something different* — levers the client
> controls: save more, sacrifice, pay down debt faster, buy later.
>
> **What if** answers *what if the world is different* — things they do not
> control: interest rates, market returns, inflation, losing a job.

That line is immediately legible to an adviser, and it resolves an existing
untidiness: Monte Carlo currently lives split between Graphs (fan chart) and
Tables (percentile table). Both move here, because a simulation is the
probabilistic form of exactly this question.

## The governing principle, unchanged from Focus

> A What-if view is a VIEW. It runs `projectPlan()` on a modified clone of
> the scenario and compares the result to the base run. It never re-derives
> a figure the engine produces, and it never mutates the saved scenario.

Every shock is therefore a full projection re-run. At sub-millisecond each
this is free, but **do not allow shocks to be stacked or combined** in this
phase — combinations multiply runs and, more importantly, multiply
interpretation. One shock at a time against the base.

---

## COMMIT 1 — Group scaffold and the shock runner

### `src/whatIf.js` (pure, tested)
```
runShock(state, shock) → { base, shocked, deltas }
```
where `shock` is a declarative description applied to a deep clone before
projection. Supported shock kinds are added by later commits; this commit
establishes the runner, the clone-and-apply discipline, and the delta shape.

`deltas` carries, per plan year: net assets, closing balance, total tax,
surplus, unfunded cashflow — plus headline figures (end net assets, first
shortfall age, total unfunded) for both base and shocked.

The runner must never mutate the caller's state. Assert it.

### Navigation
- New `What if` group in the output sidebar and router
  (`…/output/whatif/<view>`).
- **Move** the existing Monte Carlo fan chart out of Graphs and the Monte
  Carlo percentile table out of Tables into this group, unchanged in
  behaviour. Update the router's view lists and any tests that assert the
  Graphs/Tables membership.
- Empty views follow the established empty-state pattern, naming what the
  shock does and what input it needs.

Every What-if view carries the standard period selector, units toggle and
export conventions.

Commit: `What if: group scaffold, shock runner, Monte Carlo relocation`

---

## COMMIT 2 — Interest rate shocks

The cheapest view to build and the most immediately persuasive.

Shock: `{ kind: "rateShock", deltaPct }` for −2, −1, +1, +2, +3 percentage
points, selectable, with the base always shown.

**The behaviour that makes this worth building:** apply the delta to
**variable** loans immediately, and to **fixed** loans only from their
rollover date. A client with a fixed loan sees a flat repayment until
rollover and then a step — which demonstrates the value of a fixed rate
without anyone having to argue it. Do not shortcut this by shocking all
loans uniformly; the differential is the entire point.

Add a second, separately selectable shock:
`{ kind: "revertRateShock", deltaPct }` — leaves the current rate alone and
changes only the **revert rate** a fixed loan rolls into. "What if you roll
off into 8% instead of 6.5%" is the question clients with fixed loans
actually have.

Display: repayments and total interest under each scenario, the loan balance
paths overlaid, the change in surplus, and whether the shock introduces
unfunded cashflow — the affordability answer matters more than the interest
figure.

Tests: a variable loan's interest changes from month one; a fixed loan's is
unchanged until its rollover month and changes after; a revert-rate shock
leaves the fixed period untouched; a shock large enough to make repayments
unaffordable produces unfunded cashflow rather than silently succeeding.
Commit: `What if: interest rate shocks`

---

## COMMIT 3 — Market crash timing

Sequence-of-returns risk made concrete, and the most persuasive single
picture in retirement planning.

Shock: `{ kind: "crash", dropPct, atAge, recoveryYears }` — a one-off return
shock applied to growth assets and super (not cash, not fixed interest;
scale by each holding's growth allocation from `classWeights`), optionally
followed by a recovery period of above-trend returns.

Default presentation: the same crash at **three different ages** — early,
mid, and near retirement — as three lines against the base. Identical
magnitude, radically different outcome, which is the lesson.

Note in the view that this is a deterministic what-if and the Monte Carlo
view models the same risk probabilistically; link between them.

**`src/sequenceRisk.js` is the right home for the underlying calculation.**
It has been dormant behind `LEGACY_INSIGHTS_ENABLED = false` since Phase A
and was written for the old single-portfolio model. Read it, salvage what is
useful, and rewrite it against the current engine — do not simply re-enable
it. If nothing is salvageable, delete it and say so; a dormant module that
no longer reflects the engine is worse than none.

Tests: a crash at a given age reduces balances by the expected amount scaled
by growth allocation; cash holdings are unaffected; the same crash produces
materially different end outcomes at different ages; recovery years restore
on schedule.
Commit: `What if: market crash timing and sequence risk`

---

## COMMIT 4 — Income interruption and expense shock

Two small shocks, one commit.

**Income interruption**: `{ kind: "incomeGap", ownerId, atAge, months,
replacementPct }` — income stops (or drops to a replacement percentage) for
a period. Relevant well beyond redundancy: parental leave, illness, a career
break, and project-based employment.

Show: the cash drawn down to bridge the gap, whether the buffer holds, the
recovery path, and the permanent cost at the end of the projection — which
is always larger than clients expect, because the compounding is lost too.

**Expense shock**: `{ kind: "expenseShock", pct }` — all expenses run at a
percentage above (or below) plan for the whole projection. Default ±10%.
This is the question every client has privately: *what if we just spend a
bit more than we say we will?*

Tests: an income gap produces the expected shortfall over the right months
and no longer; replacement percentage applies correctly; the expense shock
scales every expense row including indexed ones; both produce unfunded
cashflow where the plan cannot absorb them.
Commit: `What if: income interruption and expense shock`

---

## COMMIT 5 — Rate uncertainty in Monte Carlo

The design decision here matters more than the code.

**Do not model interest rates as an independent stochastic process.** Drive
them off the CPI path the simulation already generates:

```
mortgageRate(path, year) = neutralRealRate + cpi(path, year) + margin
```

with `neutralRealRate` and `margin` configurable in Parameters (state the
defaults used and the reasoning in a comment). Central banks respond to
inflation, so this produces the correlation for free, is economically
defensible, adds two parameters rather than a whole process, and — most
importantly — is **more honest**: an independent rate process would permit
paths with high inflation and low rates, which is not a world that exists.

Consequences to surface, because they pull in opposite directions and the
tool should show which wins for a given client:
- high-inflation paths carry higher rates, so **repayments rise**;
- high-inflation paths also **erode nominal debt** faster in real terms.

Apply the path rate to variable loans, and to fixed loans only after their
rollover — the same differential as Commit 2, so a fixed-rate client's fan
chart is genuinely narrower during the fixed period. This is a real and
useful result.

**Requirements this commit must meet, given it changes simulation output:**
- Seeded reproducibility must still hold byte-identically.
- Zero CPI volatility must still collapse every path to the deterministic
  projection exactly.
- The conservation invariant must hold on sampled paths, as it does today.
- Report the timing impact; if a 2,000-path run materially slows, say so
  rather than optimising unilaterally.

Parameters modal: document the rate linkage, the two new parameters, and
state plainly that rates are modelled as a function of simulated inflation
rather than independently.

Tests: rate varies across paths and tracks that path's CPI; a fixed loan's
rate is invariant to the path until rollover; seeded reproducibility; zero
CPI sigma reproduces the deterministic projection.
Commit: `Monte Carlo: interest rates driven by the simulated CPI path`

---

## Deferred — do not build
Stacked or combined shocks (each additional dimension multiplies runs and
interpretation). Shock probabilities or likelihood weighting — these are
deliberately deterministic what-ifs; the Monte Carlo view is where
probability lives. Yield-curve or term-structure modelling. Asset-class
specific crash shocks beyond the growth/defensive split. Reverting the other
dormant insight modules (`firstDecade`, `drawdownTolerance`, `tornado`) —
assess them separately once this group exists and it is clear which have a
home here.
