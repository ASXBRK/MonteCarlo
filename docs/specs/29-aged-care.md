# Aged Care

Conventions per CLAUDE.md. **Five commits, gated.** Depends on spec 21a —
aged care means testing sits on the Centrelink assets and income tests.

## ⚠ Rate sourcing rule — read first

The firm's rate reference carries an explicit protocol for this domain:

> **Never web-search aged care rates.** Figures index 20 March and 20
> September; MPIR is quarterly. If the period has rolled, ask the user for
> figures from Services Australia, My Aged Care or the current Big Black
> Book.

Follow it. Aged care rates are the most volatile figures in Australian
financial planning and the most consequential to get wrong — a stale
means-tested fee misstates a client's cost of care by thousands a year.
**Build the data module with the figures the user supplies, stamped with
the period they cover, and a visible staleness warning when the projection
runs past that period's end.**

## Why

The last large domain gap. It serves the oldest cohort and, often, their
adult children — a different but real client relationship. The engine
already models everything it depends on: Centrelink means testing, the
principal residence, property sale, and pension phase.

## Scope

**In:** residential aged care fees (basic daily fee, means-tested fee,
accommodation payment), the RAD versus DAP decision, former home treatment,
the 2025 reforms, the "no worse off" principle, and pre-entry planning as a
modellable scenario.

**Out:** Support at Home / home care packages beyond a flat cost input;
respite care; the pre-1 July 2014 grandfathered regime beyond a flag;
facility-specific extra service fees beyond a user-entered amount.

---

## COMMIT 1 — Rates data module and the fee structure

`src/data/agedCare.js`, keyed by rate period (not FY — these index 20 March
and 20 September), carrying: basic daily fee, means-tested fee thresholds
and taper rates, maximum accommodation supplement, annual and lifetime caps,
MPIR, the accommodation cap, and the 2025 reform contributions.

Every figure carries the **period it covers** and its **source**. A
projection that runs past the loaded period's end must display a staleness
warning naming the period — not silently extrapolate.

**Basic daily fee** = 85% of the single basic Age Pension rate, indexed 20
March and 20 September. Since the engine already models the age pension
rate, **derive it** rather than storing it — it then indexes correctly and
cannot drift out of step.

**Means-tested fee** =
`(income tested amount + assets tested amount) − maximum accommodation
supplement`, further capped at the lesser of: the subsidy the government
would otherwise pay, the annual cap, and the lifetime cap (cumulative across
all care received).

The lifetime cap is cumulative and persists across a break in care — track
it as a running total on the person, not per admission.

Tests: basic daily fee derives correctly from the age pension rate and
follows its indexation; means-tested fee at several income and asset levels;
each of the three caps binding in turn; the lifetime cap accumulating across
years.
Commit: `Aged care: rates module and fee structure`

---

## COMMIT 2 — Means testing and the former home

Aged care means testing is **not** the age pension means test, though it
shares inputs. Implement it separately and reuse the assets and income
figures rather than the entitlement.

**The former home** is the substance of this commit and the largest planning
lever:
- Assessed at a **capped value** for the assets test, not market value.
- **Fully exempt** while a protected person lives there — a spouse, or a
  dependent child, or a carer or close relative meeting the eligibility
  conditions.
- If rented out and the resident pays a DAP, the rent was historically
  exempt for pre-2016 entrants — **flag the entry date** and disclose which
  treatment applies.
- If sold, the proceeds become fully assessable financial assets, which
  usually **increases** the means-tested fee. That reversal is exactly what
  an adviser is reasoning about, and the tool must show it.

**A RAD is an assessable asset** for the means-tested fee even though it is
refundable. Paying a large RAD to reduce accommodation cost therefore
*increases* the means-tested fee — the central trade-off in the RAD/DAP
decision (Commit 3). Model it explicitly; getting this backwards would
invert the advice.

Tests: former home at the capped value; full exemption with a protected
person and the exemption ending when they leave; sale converting to
assessable financial assets with the fee rising; a RAD counting as an
assessable asset.
Commit: `Aged care: means testing and former home treatment`

---

## COMMIT 3 — Accommodation: RAD, DAP, and the decision

Three ways to pay, and the choice is the main advice question:
- **RAD** — a refundable lump sum, capped (the cap rose under the 2025
  reforms; take the current figure from the user).
- **DAP** — a daily payment = `RAD × MPIR ÷ 365`. MPIR is set **quarterly**
  and is fixed at the rate applying on the date of entry for that resident.
- **Combination** — a partial RAD with the DAP calculated on the unpaid
  balance.

**The trade-off to surface, because it is genuinely non-obvious:**
- Paying a RAD frees the resident from the DAP but **increases the
  means-tested fee** (the RAD is an assessable asset).
- Paying a DAP preserves assessable assets elsewhere but costs the MPIR
  rate, which may exceed what those assets earn.
- Selling the former home to fund a RAD converts a capped asset into a fully
  assessable one — often the worst outcome for the means-tested fee even
  though it feels like the tidy choice.

**Focus → Aged care accommodation:** the three options side by side over the
projection — total cost of care, means-tested fee, remaining assets, and the
estate position at the end. All three arms run through `projectPlan` on
clones, per the Focus governing principle. Non-prescriptive: show the
outcomes and the trade-offs, do not label a winner.

Under the 2025 reforms a **retention amount** may be deducted from a RAD —
include it if the user supplies the rate, otherwise flag as unmodelled.

Tests: DAP derived from RAD and MPIR; combination payments; MPIR fixed at
entry date and not re-indexed for that resident; the means-tested fee rising
with a RAD; all three Focus arms reconciling to real projection runs.
Commit: `Aged care: accommodation payments and the RAD/DAP decision`

---

## COMMIT 4 — The 2025 reforms and the no-worse-off principle

From 1 November 2025 a new regime applies to new entrants:
- **Hotelling contribution** — a means-tested contribution toward everyday
  living costs.
- **Non-clinical care contribution** — a means-tested contribution toward
  non-clinical care, with a lifetime cap and a time limit.
- **Accommodation cap increase** and the retention amount.
- Clinical care remains government-funded.

**The "no worse off" principle:** residents who entered before 1 November
2025 continue under the previous arrangements and cannot be made worse off
by the reforms. So the engine needs **two fee regimes running side by side**,
selected by entry date. Model both; do not migrate old entrants to the new
rules.

Pre-1 July 2014 residents are grandfathered again under an older regime —
**flag it and disclose that it is not modelled** rather than approximating.

Take every reform figure from the user per the sourcing rule.

Tests: entry before and after 1 November 2025 producing different fees on
identical circumstances; the no-worse-off comparison; the non-clinical care
lifetime cap and time limit binding; the pre-2014 flag.
Commit: `Aged care: 2025 reforms and the no-worse-off principle`

---

## COMMIT 5 — Input, outputs, and pre-entry planning

**Input:** an Aged care section — entry date, facility, accommodation price,
payment method (RAD / DAP / combination with amounts), extra service fees,
and the protected-person status of the former home.

**Outputs:**
- **Tables → Aged care**: per year — basic daily fee, means-tested fee,
  accommodation payment, extra services, total cost, and cumulative against
  the annual and lifetime caps.
- The cost flows into household cashflow and is funded through the normal
  deficit path, so an unaffordable care plan shows as unfunded.
- Key figures gains total cost of care and the estate position.

**Pre-entry planning** is where advisers add value, and it falls out of what
already exists rather than needing new machinery — gifting (spec 21b),
property sale, and RAD funding are all modellable today. Add a **Focus →
Aged care planning** view comparing the current position against one or two
pre-entry strategies, with the honest caveat that **gifting within five
years of entry is caught by the deprivation rules** the engine already
models.

Tests: fees flowing through household cashflow and deficit funding; an
unaffordable plan showing unfunded; the cumulative caps in the table; the
Focus arms reconciling.
Commit: `Aged care: input, outputs, and pre-entry planning`

---

## Deferred — do not build
Support at Home and home care packages beyond a flat cost input. Respite
care. The pre-1 July 2014 regime beyond a flag. Facility-specific extra
service schedules. Refund timing and interest on RAD refunds after death.
Aged care as a Monte Carlo variable.
