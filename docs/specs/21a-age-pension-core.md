# Age Pension — Core Means Testing

Conventions per CLAUDE.md. **Four commits, gated.** Depends on spec 20:
the assessment of super turns on whether an interest is in accumulation or
pension phase, so pension phase must land first.

**Refinements are spec 21b** — Work Bonus, gifting and deprivation, pre-2015
deeming grandfathering, Commonwealth Seniors Health Card, Home Equity Access
Scheme. This spec delivers a working age pension without them.

## Why

For anyone within fifteen years of retirement the age pension is often the
largest single income source, and the means tests drive strategy entirely.
Without it every retirement projection understates income and cannot
evaluate the strategies advisers actually recommend. The firm's own
vocabulary has `Government/Centrelink payments` sitting at zero.

## A data gap to close first

**The firm's reference does not carry non-homeowner thresholds** — it says
to obtain them from the Big Black Book's non-homeowner tab or Services
Australia before advising a non-homeowner. Obtain them before implementing
Commit 2. Non-homeowner is a materially different calculation, not a
variant, and guessing the thresholds would be worse than omitting the
feature.

---

## COMMIT 1 — Rates, thresholds, and per-figure indexation

`src/data/agePension.js`, FY2026/27, with each figure declaring its own
indexation basis — the pattern already built for super thresholds
(spec 10 Commit 1) and Division 296.

**The indexation detail that matters most:** pension *rates* index to the
greater of CPI and PBLCI twice yearly, **with a floor of 27.7% of MTAWE for
the single rate**. MTAWE is a wage measure, and over long horizons that
floor binds. So model **rates indexing at AWOTE** and **thresholds indexing
at CPI**. In real terms the pension therefore grows roughly 1% a year
relative to the thresholds, which is what has historically happened.
Modelling rates at CPI instead would understate the age pension by around a
third over thirty years — state this reasoning in a comment, because it
looks like an error otherwise.

Assets test (20 Mar 2026 – 19 Sep 2026), **homeowner**:
| Status | Full pension | Cut-out |
|---|---|---|
| Single | $333,000 | $733,500 |
| Couple | $499,000 | $1,102,500 |

Reduction rate **$78 pa per $1,000** above the full-pension threshold — a
rate, not indexed. Cut-outs are derived from the rate and the taper rather
than stored, so they stay consistent when rates index.

Our engine is annual; Centrelink steps on 20 March and 20 September. Apply
indexation once at 1 July and disclose the simplification.

Tests: each figure indexes on its declared basis; the real-terms divergence
between rates and thresholds over twenty years is in the expected direction
and magnitude; cut-outs derive correctly from rate and taper.
Commit: `Age pension: rates, thresholds, and indexation bases`

---

## COMMIT 2 — Assets test and income test

### Age pension age
67 for anyone born from 1 January 1957. Derive from date of birth; do not
ask.

### Assets test
Assessable assets = financial assets + lifestyle assets at market value +
investment property + super **in pension phase** + business assets, **less**
the principal residence (exempt) and any liability secured against an
assessed asset.

**The rule that drives strategy:** superannuation in **accumulation** phase
is exempt until the member reaches age pension age; in **pension** phase it
is assessed regardless of age. This single rule is what makes the
younger-spouse strategy work, and it must be exactly right. Test it
explicitly for a couple with an age gap.

### Income test
Deemed income on financial assets, plus actual income from non-financial
sources (rent net of expenses, employment income, business income).

**Deeming (FY2026/27):** a two-tier rate on total financial assets, with the
lower threshold differing for single and couple. Take the current rates and
thresholds from the firm reference and state the as-at date. Account-based
pensions are deemed like any other financial asset (grandfathering is
spec 21b).

**Reduction:** 50c per dollar of income above the free area for a single;
50c per dollar of combined income for a couple, split between them.

### Taking the lower
Entitlement = **the lesser of** the assets test result and the income test
result, floored at zero. Both tests always run; the binding test is worth
reporting, because which one binds determines the advice.

Tests: each test in isolation at known values; the lower binding; a couple's
combined assessment; accumulation super exempt below age pension age and
assessed above it; pension-phase super assessed at any age; the principal
residence exempt; homeowner versus non-homeowner thresholds.
Regression gate: scenarios with no eligible member bit-identical.
Commit: `Age pension: assets test, income test, and entitlement`

---

## COMMIT 3 — Engine integration

- Entitlement is computed per person per FY and paid as **non-assessable
  income** into household cashflow through the working cash account.
  Age pension is taxable in principle but the pensioner tax offset almost
  always reduces tax to nil for a full or part pensioner — model it as
  taxable income with SAPTO applied, or as non-assessable with the
  simplification disclosed. **Pick one and say which**; do not leave it
  ambiguous.
- Entitlement is a **new money flow** — a government payment with no
  offsetting household outflow. Named conservation term, `randomScenario()`
  extended in the same commit.
- The `Government/Centrelink payments` row in the firm's cashflow vocabulary
  populates.
- A per-person `centrelinkEligible` flag returns to Setup (removed in spec
  15 Commit 1 as inert). Default true for anyone reaching age pension age
  within the projection; false suppresses assessment entirely for those who
  will not qualify — residency, or a client who simply does not want it
  modelled.

Tests: entitlement paid in the right years and amounts; the payment reaching
household cashflow; conservation with age pension present; the eligibility
flag suppressing it.
Commit: `Age pension: engine integration and cashflow`

---

## COMMIT 4 — Outputs

- **Tables → Age pension**: per person per year — assessable assets, assets
  test result, deemed income, other assessable income, income test result,
  **which test binds**, and entitlement. The binding test is the most
  useful column on the screen because it names the lever.
- **Chart**: entitlement over time with the two test results overlaid, so
  the crossover — the point at which the binding test changes — is visible.
- **Focus → Age pension**: assets and income against their thresholds by
  year, with the full-pension and cut-out lines drawn, so the distance to
  each threshold is legible. This is the view an adviser uses to reason
  about whether a strategy moves someone across a threshold.
- Age pension joins the composite chart and the income-sources chart as its
  own band.

Tests: table values reconcile to the engine per year; the binding-test
column matches the entitlement calculation; the chart series match the
table.
Commit: `Age pension: tables, chart, and Focus view`

---

## Deferred — spec 21b
Work Bonus and the income bank; gifting and deprivation (the $10,000/year
and $30,000/five-year limits, and deprived assets assessed for five years);
pre-2015 account-based pension deeming grandfathering; Commonwealth Seniors
Health Card; Home Equity Access Scheme; income maintenance and liquid assets
waiting periods; special disability trusts; rent assistance; the pension
supplement and energy supplement as separately visible components.
