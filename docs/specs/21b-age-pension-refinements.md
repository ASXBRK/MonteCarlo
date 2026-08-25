# Age Pension — Refinements

Conventions per CLAUDE.md. **Five commits, gated.** Depends on spec 21a.

All FY2026/27 figures from the firm's reference; FY-keyed data module.

## Why

21a delivers a working age pension. These are the parts advisers actively
*use* — gifting is a recommended strategy, the Work Bonus changes whether
part-time work is worth it, and grandfathering can be worth thousands a year
to a client who commenced a pension before 2015. Without them the tool
computes an entitlement but cannot evaluate the levers.

---

## COMMIT 1 — Work Bonus

Exempts employment income from the income test.

| Parameter | Value |
|---|---|
| Exempt employment income | $300 per fortnight |
| Maximum accrued balance | $11,800 |
| Starting balance (new recipients) | $4,000 |

Mechanics: $300 per fortnight of *employment* income is disregarded. Unused
amounts accrue to an **income bank** up to $11,800, drawn on in fortnights
where employment income exceeds $300. New recipients start with a $4,000
balance.

Our engine is annual. Model as **$7,800 per year exempt** ($300 × 26) with
the income bank as an annual carry-forward balance, and disclose the
fortnightly-to-annual simplification — a client with lumpy seasonal work is
modelled slightly differently to reality, and that should be stated rather
than discovered.

Applies to **employment and self-employment income only**, not investment
or rental income. It is per person, not per couple.

Tests: $300/fortnight equivalent exempted; the bank accruing to its cap and
no further; the bank drawn down in a high-income year; new-recipient
starting balance; investment income unaffected; per-person application in a
couple where only one works.
Commit: `Age pension: Work Bonus and income bank`

---

## COMMIT 2 — Gifting and deprivation

An active strategy, and one the tool currently cannot evaluate.

Rules: **$10,000 per financial year, maximum $30,000 over five years.**
Neither figure is indexed. Amounts above either limit are **deprived
assets** — assessed under *both* the assets and income tests (deemed) for
**five years from the date of the gift**, after which they drop out.

Model:
```
plan.gifts = [ { id, owner, amount, at (DateRef), label } ]
```
Per FY, compute the allowable amount (the lesser of the $10,000 annual
remainder and the $30,000 rolling five-year remainder), treat the excess as
a deprived asset, and carry each deprived amount for exactly five years from
its own gift date. The rolling five-year window is the fiddly part — it is
not five financial years from the first gift, it is a moving window.

The gifted amount leaves the client's assets regardless; the deprivation
rules only affect what Centrelink *counts*. So a gift always reduces real
wealth and may or may not reduce assessed wealth — that gap is precisely
what an adviser is reasoning about.

Tests: a $10,000 gift fully allowable; $15,000 producing $5,000 deprived;
three $10,000 gifts in successive years with the fourth breaching the
five-year limit; deprived amounts dropping out exactly five years later;
deprived amounts assessed under both tests; the gift reducing actual assets
in every case; conservation (a gift is a leak).
Commit: `Age pension: gifting and deprivation`

---

## COMMIT 3 — Deeming grandfathering

Account-based pensions commenced **before 1 January 2015** and held
continuously by a member on an income support payment since before that date
are **not deemed**. Instead they are assessed under the deductible amount
method: assessable income = annual payment less (purchase price ÷ relevant
life expectancy at commencement).

This can be worth thousands a year and is lost permanently if the pension is
commuted or restructured — which makes it a live consideration whenever a
client with an old pension is advised to change anything.

Model: a per-pension `grandfathered` flag with its commencement date and
purchase price, and a life-expectancy factor at commencement (use the ABS
tables already embedded for the LE anchoring). Grandfathering is **lost** on
commutation or on the member ceasing income support — model the commutation
case; disclose that the income-support-cessation case is not modelled.

Add a visible warning when a grandfathered pension is commuted, since the
consequence is permanent and invisible in the entitlement figure until the
following year.

Tests: deductible amount computed correctly; a grandfathered pension not
deemed; grandfathering lost on commutation and deeming applying from that
point; the warning firing.
Commit: `Age pension: pre-2015 deeming grandfathering`

---

## COMMIT 4 — Commonwealth Seniors Health Card

For clients above the age pension cut-out, the CSHC is often the remaining
benefit and it is asked about constantly.

Income-tested only — **no assets test**. Assessable income is adjusted
taxable income plus deemed income from account-based pensions (with the same
pre-2015 grandfathering exclusion as Commit 3). Take the current thresholds
from the firm reference and state the as-at date.

Report eligibility per person per year, with the margin to the threshold —
the margin is what an adviser acts on.

Tests: eligibility at and either side of the threshold; grandfathered
pensions excluded from the income test; a couple assessed on combined
income; eligibility surviving after age pension entitlement reaches zero.
Commit: `Commonwealth Seniors Health Card`

---

## COMMIT 5 — Home Equity Access Scheme and outputs

**HEAS**: a government loan against Australian real estate, up to **150% of
the maximum pension** per fortnight less actual pension received, at
**3.95% pa compounded fortnightly**, with a total loan cap based on an age
component times the value of real assets.

Model as an optional income stream with an accruing loan balance secured
against the property, appearing as a liability. It reduces the estate rather
than cashflow, which is the trade-off being evaluated.

**Outputs across 21b:**
- The Age pension table gains Work Bonus applied, deprived assets, and the
  binding-test column already built.
- A Focus → Age pension strategy view: entitlement under the current plan
  versus with a gift, versus with the Work Bonus at different work levels —
  the levers side by side. Non-prescriptive: show the entitlement and the
  real wealth position for each, and let the adviser weigh them, since
  gifting increases entitlement by reducing actual wealth and the tool must
  not imply that is free.
- CSHC eligibility and HEAS balance in the Key figures table.

Tests: HEAS drawdown at the correct rate with the balance accruing;
the total loan cap binding; the Focus view's alternatives each reconciling
to a real projection run.
Commit: `Home Equity Access Scheme and age pension strategy view`

---

## Deferred — do not build
Income maintenance period and liquid assets waiting period (they affect
timing of first entitlement, not the projection's substance). Special
disability trusts. Rent assistance. Pension supplement and energy supplement
as separately visible components — they remain inside the rate. Carer and
disability payments. Deeming exemptions for funeral bonds.
