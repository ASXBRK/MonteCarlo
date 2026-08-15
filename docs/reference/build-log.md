# Build Log — Projection Tool (Xtools+ replacement)

Repo `ASXBRK/MonteCarlo`, branch `claude/monte-carlo-investment-app-R9XSB`.
Updated stock-take. Branch head at time of writing: `be278ca`.

---

## STATUS

### Landed

**Foundation (Phases A–C, Tier 0)** — multi-asset input model; plan-level
cashflows; household/couple; FY anchoring with partial first year;
client/scenario pages with hash routing and JSON export/import; deterministic
monthly engine; full personal tax (brackets, Medicare, LITO, franking, both
CGT regimes with pooled cost bases and the 1 Jul 2027 reset); transposed
multi-view output; in-grid one-off editing; sidebar one-section-per-page
navigation; Graphs/Tables split; composite Cashflow-Assets-Liabilities chart
with shared-zero dual axes.

**Assets and structures (D1–D4)** — identity intake with DOB/sex and ABS
life-expectancy anchoring; AWOTE indexation model; financial vs lifestyle
asset classes; liabilities with amortisation, offsets and deductible
interest; property including planned purchases, stamp duty across eight
jurisdictions, FHOG and post-2027 gearing rules.

**Tier 1.1 — Key Dates** — named anchors (Start, End, Retirement, custom)
referenced by every date field; verified as pure indirection (byte-identical
to equivalent explicit ages).

**Tier 1.2 — Super accumulation** — accounts with tax components; SG derived
from employment income; salary sacrifice, personal deductible/non-deductible,
spouse; concessional cap with five-year carry-forward and the prior-30-June
TSB gate; NCC with bring-forward tiers; contributions tax; Division 293;
preservation, release conditions, proportioning.

**Working Cash Account** — household cashflow buffer with FY-end sweep,
replacing monthly surplus destruction. Fixed a second latent bug found during
implementation (unfunded cashflow re-recording cumulatively).

**Output additions** — liabilities table and chart; cashflow bars chart; key
figures table; projection chart moved to annual points on an age axis.

Roughly 406 tests, clean build.

### In flight
Super threshold indexation per figure (AWOTE / CPI / unindexed, with nominal
rounding), then Division 296, then Monte Carlo over the full scenario.

### BLOCKING — not landed
**Super contributions create money.** Personal deductible and salary
sacrifice contributions are credited to super and deducted from taxable
income but never debited from household cash; the working cash account is
only credited with the tax saving. A $20k/year contribution leaves the client
with more super, less tax *and* more cash. This flatters every
salary-sacrifice comparison — the exact question super was built to answer.
Prompt written; must land before Monte Carlo.

---

## THE REAL RISK

Two serious engine defects have been found in this build. Both destroyed or
created money. Both were found by **using the tool and looking at output** —
neither was caught by the test suite, which was green throughout.

- **WCA timing** — annual income spent the month it arrived, so eleven months
  of every year ran deficits funded by selling assets. A client with a
  $16.5k annual surplus was shown running out of money.
- **Super contributions** — funded from nowhere (above).

The suite tests components well and behaviour poorly. Both bugs violated the
same principle and neither had a test that could see it: **money must be
conserved**. Every dollar leaving one place must arrive somewhere or be
explicitly recorded as leaving the model.

### Proposed: a conservation pass before Monte Carlo

1. **Money-conservation invariant.** For every plan year, assert:
   `Δ(all asset balances + super + WCA − liabilities)
    = income − expenses − tax − contributions-tax − fees
      + growth ± external one-offs − unfunded`
   with an explicit, named term for every legitimate leak (surplus spent,
   one-off amounts leaving the model, unfunded cashflow). Anything
   unaccounted for fails.
2. **Run it over randomised scenarios** — property-test style, a few hundred
   generated combinations of income/expenses/assets/super/liabilities/
   property/purchases. This is what would have caught both bugs on the day
   they were written.
3. **Golden scenarios** — five to eight fixed cases with externally verified
   expectations: income tax against the ATO calculator, amortisation against
   a bank calculator, SG and salary sacrifice against MoneySmart, stamp duty
   against the state revenue office. Committed as tests with the source and
   date in comments.

Monte Carlo makes this urgent rather than merely wise: a simulation runs the
engine 2,000 times and presents the result as a probability distribution.
Any engine defect acquires the authority of a fan chart.

---

## WHERE WE'RE GOING

### Next (in order)
1. **Super contribution fix** — blocking, prompt written.
2. **Conservation pass** — invariant + randomised scenarios + golden cases.
3. **Super threshold indexation + Division 296** — in flight.
4. **Monte Carlo** — engine, fan chart, percentile table. Closes the
   cross-asset correlation question with a single shared market factor
   (ρ default 0.85) plus the original regime switching.

### Then — completing the accumulator story
5. **HECS-HELP** — near-universal in the target cohort; changes cashflow and
   the effective marginal rate every salary-sacrifice comparison depends on.
6. **Extra and lump-sum loan repayments** — core debt strategy, currently
   absent.
7. **FHSSS** — unblocked by super; pairs with the property purchase engine
   already built.
8. **Drawdown / goal-seek solver** — sustainable spend to life expectancy,
   required contribution to hit a target. Xtools has no solver ("no magic
   button"); our sub-millisecond engine makes it trivial. Still the clearest
   capability advantage available.

### Then — cashflow intelligence (from the Xtools research)
9. Surplus allocation as a percentage split with **pay non-deductible debt
   first** and interest-rate ordering.
10. Deficit funding with **minimum balance per asset** and optional
    **minimum-capital-gain** sell-down ordering.
11. **Adjustment rows** on tax and cashflow tables — the escape hatch that
    makes an imperfect engine usable.
12. **Goals** as a distinct expense category.
13. Loan **drawdowns** (redraw, equity release, debt recycling).

### Then — advice workflow
14. **Scenario compare** overlay, launched from the client page.
15. Scenario **templates** and **locking** (locking has a compliance
    rationale: point-in-time evidence).
16. Insight modules reworked against the new per-path output (they cannot be
    re-enabled as-is — they read a data shape that no longer exists).
17. Asset allocation over time — blocked on asset-class splits for the firm
    profiles. **Outstanding data ask.**

### Later
Pension phase and TTR; Centrelink; aged care.

### Parked (deliberate, ~1 client in 1000)
SMSF; trusts, companies and other entities; insurance modelling (premiums
already work as expenses); investment bonds; death benefits; defined benefit;
Word merge to firm templates.

---

## OPEN ITEMS NEEDING YOU

- **Asset-class splits** for the firm's risk profiles — blocks the allocation
  chart and improves Monte Carlo correlation realism.
- **Confirm the seven non-WA stamp duty schedules** against revenue offices,
  or continue relying on the per-purchase override.
- **Mortgage rate and term defaults** (currently 6.0% nominal, 30-year P&I)
  — these silently shape every first-home scenario.
- **Div 296 threshold indexation basis** — confirm against the firm
  reference before it is implemented.
- **A real client scenario, run end to end**, once the contribution fix
  lands. Manual testing has found more than the test suite has.
