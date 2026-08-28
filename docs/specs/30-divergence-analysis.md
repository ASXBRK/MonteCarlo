# Divergence Analysis

Conventions per CLAUDE.md. **Three commits, gated.** No engine changes —
this measures the engine rather than extending it.

## Why

The firm holds a second projection tool, module-based, which produces a
polished document in house format. Its structural limitation is that it
models **a snapshot year and extrapolates**: income, expenses and surplus are
assumed static, and consequences that only appear over time are invisible.
Two failure modes have already been observed in practice:

1. **Surplus directed to a loan that later repays** — once the loan is gone
   the surplus has nowhere to go and is simply lost. Money is not conserved.
2. **A surplus that grows** — as a loan amortises, as school fees end, as a
   contribution stops at retirement. A static model assumes today's surplus
   forever.

This phase **quantifies the gap** rather than asserting it. That is a more
useful artefact than an argument, and it works in both directions: where the
two approaches agree, the extrapolation is fine and saying so is what makes
the disagreements credible.

**Frame it as validation, not advocacy.** The output should be equally
publishable if it shows the gap is small.

---

## COMMIT 1 — The static extrapolation model

`src/staticProjection.js` (pure, tested) — a deliberate reimplementation of
the *other* approach, so the two can be compared on identical inputs.

```
projectStatic(state, { snapshotYears }) → yearly[]
```

Method: run the real engine for the snapshot year only, take that year's
income, expenses, tax and surplus, and hold them constant (or index at CPI —
support both, since tools differ) for every year to the projection end.
Balances roll forward at the profile return. Loans amortise on their
schedule. **Surplus goes to its nominated destination and, when that
destination closes, is lost** — reproducing the observed behaviour rather
than an idealised version.

Support multiple snapshot years, since the comparison tool uses several
columns (Current, Proposed, and up to four future snapshots), each
extrapolated from its own base.

**Be scrupulously fair.** The point is a measurement, not a strawman. Two
rules:
- Where a behaviour is ambiguous, model the *more favourable* interpretation
  for the static approach.
- Document each modelling choice and its effect on the result.

If the static model can be made to conserve money by a reasonable reading,
model it that way and note that the observed tool does not.

Tests: with genuinely static inputs — flat income, flat expenses, no loan
maturity, no life events — the static and full projections should agree
closely. **That is the control**: if they diverge on a scenario with nothing
evolving, the comparison is measuring an implementation difference rather
than the modelling approach, and the analysis is invalid until it is fixed.
Commit: `Static extrapolation model for comparison`

---

## COMMIT 2 — Divergence measurement

`src/divergence.js` (pure, tested):
```
measureDivergence(state, { snapshotYears, indexation }) →
  { byYear: [...], summary: {...}, drivers: [...] }
```

Report per year: net assets under each approach, the difference, and the
percentage difference. Summarise: divergence at 10, 20 and 30 years and at
projection end; the year at which divergence first exceeds 5% and 10%.

**Attribute the divergence to drivers**, since a number without a cause is
not persuasive. Compute each driver's contribution by re-running the static
model with that single evolving feature enabled:
- **Loan maturity** — surplus lost or redirected after payoff
- **Expense windows closing** — school fees ending, a goal funded
- **Contributions stopping** — at retirement, or when a cap binds
- **Tax bracket effects** — as income and thresholds move relative to each
  other
- **Fixed-rate rollover**
- **Age pension entitlement** — starting, or changing as means change
- **Super preservation and pension phase** transitions

Ordering the drivers by contribution answers the question that matters:
*which specific real-world event does a static model miss most?*

Tests: each driver isolated reproduces the expected divergence direction;
the drivers sum to the total within a stated tolerance, with any residual
reported rather than absorbed.
Commit: `Divergence measurement and driver attribution`

---

## COMMIT 3 — Report and Focus view

**Focus → Approach comparison:** net assets under both approaches over time,
the divergence charted, and the driver attribution as a ranked table. Runs
on the active scenario, so any client can be examined this way.

**A committed analysis** at `docs/reference/divergence-analysis.md`, generated
from four scenarios spanning the firm's client base — reuse the demo clients
and add a retiree:
1. First home buyer with HELP and a deposit plan
2. Family with a mortgage, school fees, and salary sacrifice
3. High earner approaching retirement with Division 293 exposure
4. A retiree drawing a pension with age pension entitlement

Per scenario: the divergence at 10, 20 and 30 years, the top three drivers,
and one plain-language sentence explaining the largest.

**Include the control result** — the flat scenario where the two approaches
should agree — and report the residual. If it is not near zero, say so
prominently; that finding matters more than any divergence figure.

**Write it in a neutral register.** Report what the measurement shows,
including any scenario where the difference is immaterial. A document that
finds a small gap for simple clients and a large one for complex clients is
more credible, and more useful, than one that finds a large gap everywhere.

Tests: the report's figures reconcile to `measureDivergence` output for each
scenario; the Focus view matches the committed analysis for the same inputs.
Commit: `Divergence analysis: Focus view and committed report`

---

## Deferred — do not build
Divergence under Monte Carlo. Comparison against any specific third-party
tool's actual output. Automated regeneration of the report on every commit —
it is a point-in-time analysis, regenerated deliberately.
