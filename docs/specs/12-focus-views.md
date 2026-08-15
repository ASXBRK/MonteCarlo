# Focus Views

Conservation and workflow conventions per CLAUDE.md. **Six commits, gated** —
full suite + build green and the regression gate holding before each next.

## Why

The tool models everything at once and reconciles. That is its central
advantage over the firm's workbook. But advisers often want one question
answered on one page: *how long until they have a deposit? what does FHSSS
actually gain them? is salary sacrifice worth it?* The workbook had a
dedicated sheet for each — Home Deposit (×3), FHSSS, Salary Sacrifice, HELP
projection, Savings Projections, Stamp Duty (×3), LMI (×3), Investment
comparison. We have none.

**The governing principle, and the thing that must not be compromised:**

> A Focus view is a VIEW, never a separate calculation. It reads the same
> `projectPlan()` output every other view reads, filtered and presented to
> answer one question. It never re-derives a figure the engine already
> produces, and it never accepts inputs that bypass the plan.

This is precisely the disease we are replacing. The workbook's Home Deposit
sheet could report "$120,000 by 2031" while its Cashflow sheet showed the
client could not afford it, because they were independent calculations.
Ours cannot diverge, because there is only one.

**Structure:** a third output group in the sidebar — `Graphs · Tables ·
Focus` — containing the views below. Each carries its own export (PNG for
charts, CSV and paste-into-Word HTML for tables), because these are
client-conversation one-pagers rather than internal working.

---

## COMMIT 1 — Focus group scaffold and the solver

### Solver (`src/solve.js`, pure, tested)
The engine runs a 50-year projection in well under a millisecond, which makes
goal-seek trivial. Xtools has no equivalent — the documented answer to "what
can this client sustainably draw?" is "we don't have a magic button."

```
solveFor({ state, target, vary, bounds, tolerance }) →
  { value, achieved, iterations, converged }
```
Binary search over one scalar, re-running `projectPlan` each iteration.
Monotonicity is assumed and must be checked: if the objective is not
monotonic over `bounds`, return `converged: false` with an explanation
rather than a plausible wrong answer.

Supported `vary` targets in this commit:
- a named cashflow row's amount
- a named super contribution's amount
- a goal's target date (solving for *when*, not *how much*)

Cap at 40 iterations and 2 seconds; report both. Never mutate the caller's
state — clone per iteration.

Tests: solving a contribution to hit a known balance reproduces a
hand-computed figure; a non-monotonic objective reports non-convergence
rather than converging on nonsense; bounds are respected; the caller's state
is unmodified.

### Scaffold
`Focus` group in the output sidebar and router (`…/output/focus/<view>`),
with the existing period selector, units toggle and export conventions.
Empty views render a one-line explanation of what they answer and what input
they need, in the established empty-state pattern.

Commit: `Focus views: group scaffold and goal-seek solver`

---

## COMMIT 2 — Deposit & home purchase

The headline view, and the one most asked for.

For the selected planned property (a picker when there are several):

**Target** — price today, growth rate, projected price at purchase, and the
purchase date. Make the moving target explicit: an $800,000 property at 5%
is not $800,000 in 2031, and clients consistently underestimate this.

**Required at settlement** — deposit (price − loan at the entered LVR),
stamp duty, LMI or the FHBG waiver, transfer and legal costs, less FHOG.
Total cash required. Every figure read from the purchase engine, not
recomputed.

**Accumulating** — projected available funds at the purchase date: working
cash, financial assets nominated as deposit sources, and the FHSSS release
if the property has `releaseFhsssAtPurchase` set. Charted year by year
against the required-cash line, so the crossover (or the gap) is visible.

**The answer** — either "on track: funded by FY20XX–YY, $X to spare" or
"short by $X at the purchase date; on current savings the target is reached
in FY20XX–YY". The second uses the solver.

**Two solver actions**, each stating what it changes and offering to apply
it to the plan (never applying silently):
- *"What would I need to save?"* — solves the required monthly contribution
  to fund the purchase on time.
- *"When could I buy?"* — solves the earliest purchase date fundable from
  current savings, accounting for the price growing in the meantime. Note
  in a comment that this is the non-obvious one: the target moves while you
  save, so it is a genuine fixed-point, and the solver must converge on the
  crossing rather than a fixed target.

Tests: required-cash total reconciles to the engine's settlement figure to
the dollar; the on-track/shortfall determination matches the projection's
own unfunded flag; both solver actions produce plans that, when applied,
result in a funded purchase.
Commit: `Focus: deposit and home purchase`

---

## COMMIT 3 — FHSSS

Contributions by year, associated earnings, eligible release, tax on
release, and net amount received.

**The comparison that justifies the strategy**, and which is currently
invisible anywhere in the tool: the same dollars contributed to FHSSS versus
saved outside super. Show both paths' net position at the release date, the
difference, and its drivers — contributions tax at 15% versus marginal rate
on the way in, and the 30% offset on the way out. This is the whole reason
the scheme exists.

Also show cap headroom (annual $15,000, lifetime $50,000) and flag when a
contribution is ineligible or would breach.

Tests: the comparison's outside-super arm uses the same tax treatment the
engine would apply to an ordinary savings plan (do not hand-roll it — build
the comparison arm by running `projectPlan` on a modified clone, so both
sides come from the same engine); release figures reconcile to the
engine's.
Commit: `Focus: First Home Super Saver`

---

## COMMIT 4 — Salary sacrifice

Sacrifice versus not, on the current plan:
- income tax saved
- **HELP repayment unchanged** — show this explicitly with a one-line
  explanation, because it is the single most commonly misunderstood
  interaction and the tool now models it correctly
- Division 293 triggered or increased, where relevant
- super gained net of 15% contributions tax
- household cash reduced
- net position over time, both paths charted

Amount is adjustable within the view, with the concessional cap headroom
(including carry-forward) shown live, reusing the existing headroom display.

Implement by running `projectPlan` on a clone with the sacrifice removed —
both arms from the same engine, per the governing principle.

Tests: the no-sacrifice arm equals the projection with the contribution
deleted; HELP is identical across arms; cap headroom matches the input
panel's.
Commit: `Focus: salary sacrifice comparison`

---

## COMMIT 5 — Debt payoff

Per loan: payoff date, total interest over the life, and the effect of extra
repayments — interest saved and time saved, both already computed by
`liabilityRepaymentStats`. Chart the balance against the no-extra-repayment
counterfactual.

Solver action: *"What extra repayment clears this by [date]?"* — with the
affordability check surfaced, since an unaffordable answer is still the
honest answer and the projection already models it as unfunded.

Tests: interest and time saved reconcile to the Liabilities view; the solver's
answer produces the requested payoff date when applied.
Commit: `Focus: debt payoff`

---

## COMMIT 6 — Standalone lookups

The one deliberate exception to the governing principle. Stamp duty and LMI
are *lookups*, not projections — they take no input from the scenario and
therefore cannot contradict it. Sometimes you want duty on an $800,000 Perth
purchase without building a client.

Two small calculators under Focus: state, price, first-home-buyer and
new-build flags → duty, FHB concession, FHOG, LMI at a given LVR, and the
FHBG waiver. Reuse `stampDuty.js` and the LMI module directly; no new rate
data.

Carry the existing as-at dates and the unverified-schedule caveats visibly —
a standalone calculator invites more trust than an embedded figure, so the
provenance must be on screen.

Tests: outputs match the purchase engine's for identical inputs (this is the
guard against the lookup drifting from the projection).
Commit: `Focus: stamp duty and LMI lookups`

---

## Deferred — do not build
Investment comparison (the workbook's sheet compares products, which is
research rather than projection); savings projections as a separate view
(the deposit view covers it); scenario comparison (its own phase); solver
targets beyond the three listed.
