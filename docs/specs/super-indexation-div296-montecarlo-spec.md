# Super threshold indexation, Division 296, and Monte Carlo

Conventions per CLAUDE.md. **Two sessions.** Session A is commits 1–2
(threshold indexation and Div 296). Session B is commits 3–5 (Monte Carlo).
Do not start B until A is committed and green — MC re-runs the whole engine
per path, so the engine must be settled first.

---

# SESSION A

## COMMIT 1 — Per-threshold indexation bases (correction)

Tier 1.2 held every super threshold constant in real terms. That is wrong:
the thresholds index on **different bases with different rounding**, and two
of them are not indexed at all. Source: firm reference, "Key Indexation
Notes".

| Figure | Indexed with | Rounding |
|---|---|---|
| Concessional cap | **AWOTE** | down to nearest $2,500 |
| Non-concessional cap | **4 × CC cap** (derived) | — |
| General transfer balance cap | **CPI** | down to nearest $100,000 |
| Bring-forward TSB thresholds | derived from general TBC | — |
| SG maximum salary | with SG rate and CC cap changes | — |
| Untaxed plan cap | AWOTE | down to nearest $5,000 |
| Carry-forward TSB gate ($500,000) | **not indexed** | — |
| Division 293 threshold ($250,000) | **not indexed** | — |

Consequence worth stating plainly: AWOTE (default 3.5%) exceeds CPI (2.5%),
so **the concessional cap grows in real terms** — the current build
understates it, and understates every carry-forward and salary-sacrifice
figure that depends on it. The two unindexed thresholds shrink in real
terms, which is also correct and will surprise users.

**Implementation.** `superRatesFor(fy, …)` computes each figure by
compounding its own basis nominally from the FY2026/27 base year, applying
its rounding increment in nominal dollars, then deflating to real. Rounding
must happen in nominal dollars — that is where the legislated steps exist —
so real-terms values will step irregularly. That is correct, not a bug.

The existing "no indexation" toggle continues to freeze everything
nominally. Under the default setting, each figure follows its own basis.

The Assumptions view gains a Super thresholds group showing each figure per
FY, so the stepping is visible rather than mysterious.

Tests: CC cap at FY2026/27 equals $32,500 exactly; nominal CC cap in year 10
matches a hand-computed AWOTE compounding rounded down to $2,500 (put the
arithmetic in a comment); NCC cap is always 4 × CC cap; TBC steps in
$100,000 increments; the two unindexed thresholds are constant in nominal
terms and decline in real terms; the no-indexation toggle freezes all of
them.
Regression gate: no-super scenarios bit-identical.
Commit: `Super thresholds: per-figure indexation bases and rounding`

## COMMIT 2 — Division 296

Not currently modelled at all. Commenced **1 July 2026**, so it is live for
every projection this tool produces, and a long accumulation projection can
carry a high earner past $3M.

**Legislated design (Royal Assent 13 March 2026 — the October 2025 revision,
not the lapsed 2023 bill):**
```
Div 296 tax = 15% × (proportion above $3M)  × Earnings
            + 10% × (proportion above $10M) × Earnings

proportion above $3M  = max(TSB − $3M, 0) / TSB
proportion above $10M = max(TSB − $10M, 0) / TSB
```
- Both thresholds **are indexed** (unlike the lapsed 2023 design). Add them
  to the commit 1 indexation table; confirm the basis against the firm
  reference before implementing and state which you used.
- In scope when TSB exceeds $3M either at the start or the end of the year.
- TSB used for the proportions is the **higher of opening and closing TSB**.
- **Earnings are realised only** — not TSB movement. In our model that is
  the member's share of fund income plus realised capital gains. Since our
  super accounts accrue earnings smoothly rather than realising lumpily,
  compute earnings as the account's income component plus the growth
  component actually realised in the year, and **disclose the
  simplification** — this is the largest approximation in the feature.
- Assessed to the member personally, paid from **household cashflow** in the
  FY following assessment (same t+1 convention as CGT and Div 293). Do not
  model the release-from-fund election.
- Ignore the SMSF CGT cost-base reset election (SMSF is out of scope).

Outputs: a Div 296 row per person in the Tax view; inclusion in the
household tax line; the Parameters modal gains a Division 296 section
covering the calculation, the realised-earnings simplification, and the
omitted release election.

Tests: the Treasury fact-sheet worked example reproduced exactly (put the
source figures in a comment); the two-tier boundary at $10M; the
higher-of-opening-or-closing TSB rule; no Div 296 below $3M; t+1 payment
timing; a member crossing $3M mid-projection.
Regression gate: scenarios with all TSBs under $3M bit-identical.
Commit: `Division 296: two-tier tax on high super balances`

---

# SESSION B — Monte Carlo

The original tool was a Monte Carlo engine; `src/sim.js` still contains the
regime-switching return model and is currently disconnected. This restores
simulation over the **full scenario** — every asset, super, liabilities,
property, tax, working cash and deficit funding — not a single portfolio.

**Not instant, and that is fine.** Xtools' pattern is a "Run simulation"
button. Ours will likely take seconds rather than minutes (the deterministic
engine is sub-millisecond), but design for a worker with progress regardless.

## COMMIT 3 — Path generation and the simulation engine

### What varies per path
1. **Asset returns**, per plan year, per profile.
2. **CPI**, per plan year.
Nothing else. Salary growth, contribution amounts, expenses and dates are
held at their entered values — this is return-and-inflation uncertainty, not
behavioural uncertainty. State that in the modal.

### Correlation (the decision that has been open since Phase A)
One standardised market shock `z_t` per plan year, shared across all
profiles. Each profile's return:
```
r_profile,t = μ_profile + σ_profile × ( ρ·z_t + √(1−ρ²)·ε_profile,t )
```
`ρ` is a single configurable parameter, **default 0.85**, in Parameters.
This gives realistic co-movement — growth assets fall together — without
requiring a correlation matrix we do not have. Cash and defensive profiles
have small σ and therefore move little regardless.

Preserve the existing **two-state regime-switching variance** from `sim.js`
by applying it to the shared market factor, so the model's original
character survives: quiet regimes and volatile regimes, with all assets
experiencing them together.

### CPI
Drawn per year: mean = `assumptions.cpi`, σ configurable (default 1.0%),
floored at a configurable minimum (default −1%). CPI variation matters
because it changes the real burden of everything nominally fixed — loan
repayments, non-indexed cashflows, and the unindexed Div 293 and
carry-forward thresholds.

### Custom allocations
An asset with a custom allocation has a user-entered return and borrows σ
and regime behaviour from its `volBasis` profile (already in the model since
Phase A). This is an assumption the user did not explicitly make, so the
results **must carry a flag**: "N asset(s) use custom returns. Their
variability is modelled on the volatility basis profile selected for each."
List the assets. Do not block the run.

### Engine
`src/simulate.js` (pure, tested): given state, path count and a seed,
generate the return/CPI matrices and run the existing `projectPlan` per
path with those substituted. Runs in a **worker** with progress callbacks.
Deterministic given a seed — the same seed must reproduce the same results
exactly, and that is a test.

Default 2,000 paths, configurable 500–10,000.

Per-path output kept small (per-year net assets, unfunded totals, end
balance) — do not retain full ledgers for 2,000 paths.

Tests: seeded reproducibility; ρ = 1 makes all profiles perfectly
correlated and ρ = 0 makes them independent (assert on realised
correlations across paths); zero σ everywhere reproduces the deterministic
projection exactly for every path; CPI variation changes real loan burden
in the expected direction.
Commit: `Monte Carlo: path generation and full-scenario simulation engine`

## COMMIT 4 — Results and the fan chart

New Graphs entry **Simulation**, with a Run button, progress indicator and
cancel. Results cache against a hash of the scenario state and invalidate
automatically when any input changes — a stale fan chart beside edited
inputs is worse than no chart.

- **Fan chart**: net assets by client age, percentile bands 10/25/50/75/90,
  with the deterministic projection overlaid as a line. The modal's existing
  volatility-drag disclosure explains why the deterministic line sits above
  the median — link to it rather than repeating it.
- **Headline statistics** beneath: probability of unfunded cashflow before
  the projection end (the single ruin figure — one definition, used
  everywhere, per the locked convention); median and 10th/90th percentile
  end net assets; median first-shortfall age where one occurs.
- The custom-allocation flag from commit 3.
- Real/nominal, period selector and PNG export as with every other chart.

Commit: `Monte Carlo: fan chart and headline statistics`

## COMMIT 5 — Simulation table

New Tables entry **Simulation**: percentile net assets by FY (10/25/50/75/90
as rows, years as columns), plus a distribution summary. CSV export. Only
populated after a run; shows the Run prompt otherwise.

Commit: `Monte Carlo: percentile table`

---

## Note on the legacy insight modules
`firstDecade.js`, `drawdownTolerance.js`, `tornado.js` and `sequenceRisk.js`
remain behind `LEGACY_INSIGHTS_ENABLED = false`. They were written for the
old single-portfolio model and consume a data shape that no longer exists —
they cannot simply be re-enabled. Reworking them against the new per-path
output is a separate phase (Tier 3.4) and should be scoped only once the
fan chart is working and the per-path output shape is settled.
