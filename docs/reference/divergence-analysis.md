# Divergence Analysis

A point-in-time measurement (spec 30) of the gap between this engine's own
month-by-month projection and a **snapshot-and-extrapolate** approach — the
method the firm's other projection tool uses: take one year's income,
expenses, tax and surplus, hold them constant (or index at CPI), and roll
balances forward from there. `src/staticProjection.js` reimplements that
method faithfully — including its disclosed failure mode, that surplus
directed to a destination which later closes (a loan fully repaid) has
nowhere to go and is simply lost — so the two can be compared on identical
inputs. `src/divergence.js` measures the gap and attributes it to seven
named drivers by re-running the static model with one driver's own realism
switched on at a time.

**This is a measurement, not an argument.** Regenerated deliberately, not on
every commit — see `staticProjection.js`/`divergence.js` for the method and
every disclosed simplification (property, bonds and the Working Cash Account
are not tracked by the static model; the comparison is scope-matched to
what both models actually track: financial assets, super, pension accounts
and liabilities, net of each other).

**Snapshot and indexation**: year 0 of each scenario's own projection,
indexed at CPI (the static model's real-dollar figures held flat, not
decaying) — the more common real-world reading of "extrapolate this year's
numbers forward." The retiree scenario snapshots year 2 instead of year 0
— see its own note below.

## The control result

A flat scenario (constant real income and expenses, a 0%-real-return asset,
no liabilities, no life events) — the case where the two approaches should
agree, since nothing evolves for the real engine to know about that the
static model doesn't.

**Result: exact agreement, every year, to the projection end. Residual: $0.**
This is the control the method's own test (`staticProjection.test.js`) also
asserts: divergence here would mean the comparison is measuring an
implementation difference, not a modelling one. It doesn't — the four
scenarios below are measuring the real thing.

## Scenario 1 — First home buyer

Single, 29, salary $110k, renting, no purchase in this arm (the "Current"
demo scenario — see `docs/reference/demo-clients.md`). 54-year projection.

| Horizon | Divergence |
|---|---|
| 10 years | −2.6% |
| 20 years | −0.8% |
| 30 years | +3.3% |
| End (age 82) | **+32.1%** ($499k on a $1.56m real net worth) |

First divergence over 5%: year 2. Over 10%: year 38.

**Top drivers:** super/pension transitions (−$499k), contributions stopping
(−$159k). Residual: $159k.

The largest driver is superannuation: a snapshot taken at 29 locks in that
year's own super contribution and growth pattern for the next five decades,
missing every subsequent change to contribution rates, balance growth, and
eventually the transition into pension phase near retirement — over a
54-year horizon, that one blind spot accounts for essentially the entire
divergence.

## Scenario 2 — Family with a mortgage

Couple, mid-30s, two children, an $850k mortgage (fixed/variable split),
private school fees from age 12, combined income $260k (the "Current" demo
scenario). 49-year projection.

| Horizon | Divergence |
|---|---|
| 10 years | −49.8% |
| 20 years | −17.3% |
| 30 years | −6.3% |
| End | **+5.0%** ($206k on a $4.16m real net worth) |

First divergence over 5%: year 1. Over 10%: year 2.

**Top drivers:** contributions stopping (−$468k), super/pension transitions
(−$206k). Residual: **$468k** — larger than the total gap itself.

The largest driver is contributions: this household's own contribution
pattern changes materially over the projection (children's education
costs, the mortgage's fixed-rate rollover, retirement), and a static model
holding the snapshot year's contribution level flat for 49 years diverges
from that early and by a wide margin, before narrowing again later as
other effects offset it.

**The residual here is the more important finding than the divergence
figure.** $468k against a $206k total gap means the two isolated drivers,
added together, would suggest a materially different answer to "how much
of the gap does fixing these two things close" than what actually happens
when both are true at once — the drivers interact (contributions stopping
changes how much surplus is available in years super/pension transitions
would otherwise capture, and vice versa) rather than adding linearly. Any
one driver's own isolated contribution should be read as "this is what
changes if this one thing were modelled correctly, holding everything else
naive" — not as an independent slice of the total.

## Scenario 3 — High earner pre-retirement

Couple, early 50s, ~$450k combined income, a negatively geared investment
property, asymmetric super balances either side of the carry-forward
eligibility threshold (the "Current" demo scenario). 34-year projection.

| Horizon | Divergence |
|---|---|
| 10 years | −11.7% |
| 20 years | −6.8% |
| 30 years | +4.1% |
| End | **+7.4%** ($373k on a $5.06m real net worth) |

First divergence over 5%: year 4. Over 10%: year 8.

**Top drivers:** contributions stopping (−$1.20m), super/pension transitions
(−$895k), fixed-rate rollover (−$75k). Residual: **$1.80m** — over four
times the total gap.

The largest driver, again, is contributions: concessional contributions,
carry-forward use and eventually retirement all change this household's
own contribution pattern well before the 34-year horizon ends, and a
snapshot taken in the early 50s can't see any of it.

**The residual is the standout finding for this scenario.** At $1.80m
against a $373k total gap, the drivers' isolated effects are large and
substantially offsetting when combined — this is the most tax/super-
feature-dense of the four scenarios, and the interaction between
contributions stopping, the super/pension transition, and the fixed-rate
rollover is correspondingly the strongest observed. Not a defect in the
measurement: the drivers are each individually correct in isolation
(`divergence.test.js` asserts the expected direction), and the residual
figure exists precisely so this interaction isn't silently smoothed away.

## Scenario 4 — Retiree

Single, 70, retired at 65, $600k rolled into an account-based pension
minimum-drawing, past age pension age, receiving the age pension. 17-year
projection (to age 87).

**Snapshot note:** year 0 is the year BEFORE the account-based pension
formally commences in this fixture (the engine only models a commencement
event inside the projection itself — see `src/demo/retiree.js`), so its own
"opening" balance for the pension is definitionally zero and its net flow
figure would capture the one-off $600k rollover-in rather than an ongoing
drawdown pattern. Year 1 is the commencement year itself — same problem,
the other direction (an inflow this large, held constant forever, produces
a nonsensical multi-thousand-percent divergence that is an artefact of the
snapshot choice, not a real finding). **Year 2 — the first genuinely
steady-state year — is used instead.** This is exactly the kind of
snapshot-year sensitivity a real adviser using either tool needs to be
aware of, not something specific to this measurement.

| Horizon | Divergence |
|---|---|
| 10 years (from snapshot) | +6.9% |
| End (age 87) | **+15.7%** ($71k on a $453k real net worth) |

(20/30-year horizons don't exist within this scenario's shorter, life-
expectancy-bounded projection.)

First divergence over 5%: year 11. Over 10%: year 15.

**Top drivers:** contributions stopping (−$82k), super/pension transitions
(−$71k). Residual: $82k.

The largest driver is, once again, contributions/withdrawals: minimum
pension drawdown rates rise with age (the real engine tracks this; the
static model holds the snapshot year's own dollar drawdown flat), so the
static model draws down more slowly than reality and ends up ahead —
overstating the client's own remaining net worth.

## Summary across all four

| Scenario | Horizon | Divergence at end | Largest driver | Residual vs. total gap |
|---|---|---|---|---|
| Control | — | 0.0% | — | $0 |
| First home buyer | 54y | +32.1% | Super/pension transitions | $159k vs $499k |
| Family with a mortgage | 49y | +5.0% | Contributions stopping | $468k vs $206k |
| High earner pre-retirement | 34y | +7.4% | Contributions stopping | $1.80m vs $373k |
| Retiree | 17y | +15.7% | Contributions stopping | $82k vs $71k |

**Contributions and withdrawals changing over time is the most consistent
driver across every scenario that has one** — every real household's own
contribution or drawdown pattern shifts as life events happen (retirement,
a child's education ending, an age-based drawdown rate increasing), and a
tool that locks in one year's own pattern misses all of it. Super and
pension phase transitions are the second most consistent driver, for the
same underlying reason applied specifically to superannuation.

**The size of the divergence tracks the length of the projection and the
number of major life transitions inside it** — the youngest client (first
home buyer, 54 years) shows the largest end-of-horizon divergence; the
control (no transitions at all) shows none. This is not a claim that either
approach is "wrong" in general — the static approach's own numbers are
exactly right for the year it snapshots, by construction — only that
extrapolating that year forward diverges from what actually happens by an
amount that grows with time and with how much of a client's life is still
ahead of them.

**The residual is frequently large relative to the total gap** — in three
of the four non-control scenarios, the seven drivers' own isolated
contributions do not sum cleanly to the total divergence; they interact.
This is disclosed, not absorbed into any one driver's figure, and is worth
weighing alongside the driver ranking itself: the ranking correctly
identifies WHICH mechanism matters most, but the drivers are not
independent, additive causes of the total gap.
