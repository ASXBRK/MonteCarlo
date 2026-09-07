# Retirement as an Output View

Conventions per CLAUDE.md. **Six commits, gated.**

## Why, and what this replaces

Spec 33 built a standalone retirement page with its own simplified input set.
**That was the wrong approach and it is being withdrawn.** The reason is
worth recording so it is not attempted again:

Retirement accuracy requires multiple super funds, fees per fund, real
contributions with date windows, pension-phase consolidation, and proper
income rows with SG treatment per row. Simplify any of those and the numbers
become wrong — which is worse than a busy form. **There was never a
simplification available.** A "simple" retirement surface is either
inaccurate or it converges on the comprehensive one.

So retirement becomes an **output**, over the comprehensive inputs. One set
of inputs, nothing that can disagree, no aggregation problem, no mode
switching, no prepopulation, and one input model to map when this engine is
consumed by another tool.

**But the original concern stands**: with fifteen input sections, things get
missed — an investment account added in one tab is easy to overlook from
another. The answer is not a second input surface. It is that **the
retirement view carries a review panel of the inputs it actually uses**,
editable in place, so the adviser never leaves the screen to check or
correct what is feeding the projection.

### What survives from spec 33
All outputs: analytics card, goal-versus-position chart, lifestyle band,
super and pension balance chart, year table, Monte Carlo, lifecycle
comparison, allocation chart. Every one moves into the new view.

### What is removed
The standalone page's **input surface** and its route. The nine-field form,
the household toggle on that page, and the per-page setters in
`retirementStandalone.js` that exist only to write single flat values.
Report anything in that module worth keeping before deleting it.

---

## COMMIT 1 — The Retirement output group

A fifth group in the output rail alongside Graphs, Tables, Focus and What if.
Route `…/output/retirement/<view>`.

Move, unchanged, from the standalone page:
- Analytics card
- Goal versus position, with its generated sentence
- Lifestyle band
- Super and pension balance chart
- Year-by-year table
- Asset allocation over time
- Monte Carlo with probability of ruin
- Lifecycle versus static, as distributions

Delete the standalone page and its route. Update the reachability and
coverage tests for the new view ids.

Regression gate: the outputs produce identical figures to the standalone
page for the same scenario — this is a move, not a rewrite.
Commit: `Retirement: output group, standalone page removed`

---

## COMMIT 2 — The input review panel

The commit that makes this work rather than being a relocation.

A panel within the retirement view listing **every input the projection
actually uses**, grouped: income rows · super funds and their fees ·
contributions · pensions · financial assets · expenses · income required ·
retirement ages · glide path or risk profile.

Three requirements:

**Edit in place.** Amount, and the one or two fields that matter per row —
enough to correct a number without leaving the screen. The projection
updates live, as everywhere else.

**Add inline.** A new income row, super fund, contribution or asset, created
with defaults, so a missing item is fixed where it is noticed.

**Link out for the rest.** Anything beyond a simple correction — date
windows, indexation, allocation detail, fee structures — links to that
input section. Do not attempt full editing here; the panel is for seeing
what is feeding the projection and fixing the obvious, not replacing the
input surface.

**Derive the list from what the engine reads**, not a hard-coded set. If a
collection contributes to the projection it appears; if the scenario has
none of something, that group is absent rather than empty. This is the
mechanism that stops things being missed, so it must not drift from what the
engine actually consumes.

Tests: every populated collection appears; empty groups are absent; an
in-place edit reaches the engine and changes the projection; an inline add
creates a valid row; the link-out targets the right section.
Commit: `Retirement: input review panel`

---

## COMMIT 3 — Retirement exclusions

A tickbox per asset, super fund and income row in the review panel:
**exclude from retirement**.

```
asset.excludeFromRetirement       // bool, default false
superAccount.excludeFromRetirement
incomeRow.excludeFromRetirement
```

**Retirement-scoped, not scenario-wide.** An excluded item still exists,
still grows, still appears in net assets and every other view. It is simply
**not drawn on to fund retirement** — removed from the funding order and
from the drawdown that meets Income Required. This is distinct from the
existing `include` flag, which removes an item from the scenario entirely.

The use case is real: a portfolio earmarked for an inheritance, a business
asset, or the conservatism the firm's own document already practises — *"this
does not include Vicky's salary sacrifice contributions to be
conservative."*

Because an item behaving differently in one view is exactly the kind of
thing that surprises people later, it must be **visible, not silent**:
- Excluded rows render distinctly in the panel with the reason field beside
  them (free text, optional, but shown when present).
- The analytics card carries a line when anything is excluded: *"$340,000
  excluded from retirement funding."*
- The year table and charts show excluded balances as a separate band or
  series, so the money is visibly there and visibly untouched.

**Engine handling:** exclusion affects the funding order and Income Required
drawdown only. Earnings, tax, fees and balances all continue as normal.
Conservation must still hold — the money does not leave, it is simply not
spent. Extend `randomScenario()` to generate exclusions and confirm the
invariant.

Tests: an excluded asset is not drawn on for retirement but still grows and
still appears in net assets; conservation holds with exclusions present; the
analytics disclosure appears; the flag is independent of `include`.
Commit: `Retirement: exclude assets from retirement funding`

---

## COMMIT 4 — Threshold indexation toggle

A projection reaching 2056 currently shows a transfer balance cap of roughly
$20m. That is technically correct and useless in a client conversation, and
advisers differ on whether to index at all over thirty-year horizons.

A single toggle in the retirement view and the Parameters modal: **index
legislated thresholds** (default on). When off, freeze at their current
nominal values: transfer balance cap, concessional and non-concessional
caps, total super balance thresholds, Division 293 and Division 296
thresholds, and the untaxed plan cap.

**Not affected**: tax brackets (which already have their own bracket-mode
toggle), age pension rates and thresholds, and anything not a super
threshold. Keep the two toggles distinct and say what each covers.

State the consequence plainly in the modal: freezing thresholds means real
bracket creep — more clients breach caps over time, which is a *deliberately
conservative* assumption rather than a neutral one.

Tests: each listed threshold freezes when off and indexes when on; tax
brackets are unaffected; the projection differs in the expected direction.
Commit: `Threshold indexation toggle`

---

## COMMIT 5 — The glide path builder

The current selector offers presets. Advisers want to build a ladder.

A builder in the retirement view: a starting profile, then a row per step —
**profile, and the age it takes effect**. High Growth → 60 Moderate Growth →
65 Balanced → 70 Moderately Defensive → 75 Defensive. Add and remove steps;
the existing interpolation and annual rebalancing apply unchanged.

Two presets seed it rather than replacing it: **single step** (current
profile → Balanced at retirement, matching current firm practice) and
**gradual** (step down one profile every five years from ten years before
retirement to Defensive).

Keep the risk profile and glide path as **separate controls**, since they
are separate decisions — a static profile is a valid choice, not a
degenerate glide path.

The allocation chart already shows defensive rising; verify it reflects a
custom ladder.

Tests: a custom ladder produces the expected profile at each age;
interpolation between adjacent steps; presets generate the described
ladders; removing a step leaves a valid path.
Commit: `Retirement: glide path builder`

---

## COMMIT 6 — The levers panel

From the tool's original design, and the thing that made the Monte Carlo
useful rather than merely informative: **when a plan does not reach its goal,
what would fix it.**

When ruin probability exceeds a threshold (default 20%, configurable), show
the levers ranked by effect on ruin probability:

- **Contribute more** — the additional annual concessional contribution
  needed, with cap headroom shown, and flagged when the answer exceeds the
  cap.
- **Retire later** — the age at which the plan becomes acceptable.
- **Spend less** — the Income Required that reaches the threshold, expressed
  against the ASFA bands so the lifestyle cost is legible.
- **Take more risk** — the profile or glide path that reaches it, **with the
  distribution shown**, because more risk widens the spread as well as
  lifting the median and presenting it as a free improvement would be
  dishonest.

Each lever states its effect: *"contributing $12,000 more a year moves ruin
from 34% to 11%."* Each is computed by re-running, not estimated.

**Non-prescriptive, per the locked convention.** The panel states what each
lever does. It does not rank them by desirability, recommend one, or imply
the client should take more risk. Ranking is by *effect on ruin
probability*, and that is stated.

Performance: each lever is a solve over Monte Carlo runs. Compute on demand
behind a button, not automatically, and reuse the debounce and caching
already built.

Tests: each lever's stated effect matches a real re-run; the cap-exceeded
case reports rather than converging on nonsense; the panel appears only
above the threshold; the risk lever shows its distribution.
Commit: `Retirement: levers panel`

---

## Deferred — not this spec
Word output and the export panel. Hide-if-empty on input sections and any
retirement-focused input ordering — worth doing, but separately, once the
retirement view is working. Assumptions tabs (life expectancy, risk, fees,
economic, super) — worth doing, but they belong with the Assumptions view
rather than here. Any adapter to another system.
