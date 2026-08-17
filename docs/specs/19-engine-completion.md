# Engine Completion

Conventions per CLAUDE.md, including the conservation rule — several commits
here introduce new money flows and must extend `randomScenario()` and the
invariant in the same commit.

**Seven commits, gated.** All FY2026/27 figures below come from the firm's
reference set; put every one in an FY-keyed data module.

## Why

The accumulation engine is strong but has nameable holes, each of which
currently produces a number that is wrong in a direction that *flatters* the
plan. This closes them.

---

## COMMIT 1 — Smart defaults

A cross-cutting principle, established first because every later commit
follows it.

> Every default is one of three things, and the interface says which:
> **HOUSE VIEW** — the firm's own assumption (profile returns, CPI, AWOTE,
> mortgage rate). **LEGISLATED** — a figure from law or an official rate
> (caps, thresholds, duty, land tax). **DERIVED** — computed from other
> inputs the user has already given.

- A registry mapping each defaulted field to its kind and, for DERIVED, the
  derivation.
- The spec-15 tooltip on any defaulted field states its kind and source:
  "Default: 5.5% — house view (Residential Property profile growth
  component)" or "Default: $16,000 — derived (2% of purchase price)".
- A DERIVED default **recomputes** when its inputs change, until the user
  overrides it; once overridden it stops tracking. This is the behaviour
  that makes derived defaults safe rather than surprising.

Derived defaults to establish now:
- property growth → Residential Property profile growth component
- property expenses → 20% of gross rent (state as an assumption, editable)
- purchase costs → 2% of purchase price
- agent fees on sale → 2.5% of sale price
- LVR → 80%
- rent → 4% of property value where not entered
- education indexation → CPI + 2% (already built; register it)

Commit: `Smart defaults: registry, provenance, and derived recomputation`

---

## COMMIT 2 — Land tax

Annual state land tax on non-exempt land, currently unmodelled. It makes
every investment property projection optimistic.

`src/data/landTax.js`, same pattern as stamp duty: per-jurisdiction
progressive schedules with a stated as-at date, **WA verified against the
revenue office and the rest flagged UNVERIFIED**, plus a per-property
override.

- Assessed on unimproved land value; we hold property value. Default the
  land-value proportion to **60% of total value**, editable per property, and
  disclose it — it is the largest approximation in the feature.
- Principal residence is exempt. Investment and holiday properties are not.
- Aggregated per owner across their properties within a jurisdiction, since
  that is how land tax works and per-property assessment would understate it.
- Deductible against rental income for investment properties.
- Annual outflow through household cashflow.

Tests: WA schedule spot checks at known values; PPR exempt; aggregation
across two properties exceeding a threshold that neither reaches alone;
deductibility; the override; conservation.
Commit: `Land tax`

---

## COMMIT 3 — Redundancy and employment termination

Most valuable for this client base and most likely to be got wrong. Treating
a redundancy payout as ordinary income overstates the tax badly.

**Genuine redundancy tax-free amount (FY2026/27):**
`$13,598 + $6,801 per completed year of service` — indexed with AWOTE.
That portion is non-assessable, non-exempt income.

**The excess is an ETP:**
| Age | Taxable component |
|---|---|
| Under preservation age | 30% up to cap; 45% above |
| Preservation age and over | 15% up to cap; 45% above |

Plus Medicare levy. **ETP cap $270,000.** Genuine redundancy is an *excluded*
ETP, so the whole-of-income cap does not apply to it — use the ETP cap alone.

**Input:** a termination event on an income row — date (DateRef), years of
completed service, type (`genuine redundancy` | `resignation or
retirement`), and any payout components. Genuine redundancy gets the
tax-free base; resignation does not, and its ETP is subject to the
whole-of-income cap of $180,000 less other taxable income.

**Unused leave on termination** is taxed separately from the ETP — model
annual leave and long service leave paid on termination at their own
concessional treatment, or state plainly that leave is not modelled and let
the user enter it as ordinary income. Pick one and disclose it.

The income row ends at the termination date. Whether income resumes is the
user's business — pair this with the existing income-gap what-if.

Tests: tax-free amount at several service lengths; the ETP cap boundary at
both age brackets; genuine redundancy versus resignation producing different
tax on identical payouts; the tax-free portion not appearing in assessable
income, HELP repayment income, or Division 293 income; conservation.
Commit: `Redundancy and employment termination payments`

---

## COMMIT 4 — Property sale

`status` gains `"sold"`, or a planned property gains a sale event:
`saleAt` (DateRef), `agentFeesPct` (derived default 2.5%),
`settlementCosts` (derived default $2,000), and a proceeds destination
(asset, or repay the linked loan first then an asset — default the latter,
since a sale rarely leaves the mortgage outstanding).

On sale: proceeds = value at sale less agent fees and settlement costs; the
linked loan is discharged from proceeds; the remainder goes to the
destination; the property leaves the projection.

**CGT** joins the existing pooled-cost-base machinery: cost base is purchase
price plus duty and incidentals plus capital improvements, less the exempt
proportion (commit 5). Both regimes apply per the existing 1 July 2027
boundary. Agent fees and settlement costs are cost base elements, not
expenses.

"Sell and buy" falls out of this — a sale and a planned purchase in the same
year, which is how people upgrade. Verify the settlement cash from the sale
is available to the purchase in the same month, and test it, since the
research records that Xtools gets a one-year "V" artefact here when timings
mismatch (§9).

Tests: proceeds net of costs; loan discharged; CGT on both sides of the
regime boundary; sell-and-buy in one year with the proceeds funding the
purchase; conservation.
Commit: `Property sale`

---

## COMMIT 5 — Main residence exemption and the six-year rule

The PPR is exempt while it is the main residence. Under the absence rule it
**remains exempt for up to six years** while rented out, and indefinitely if
not producing income — but only one property can be the main residence at a
time.

Model: per property, a timeline of status periods (`main residence` /
`absent — covered` / `absent — exceeded` / `investment`), derived from the
property's own dates plus an explicit "moved out" event with a DateRef. The
exempt proportion of any gain is exempt days over total ownership days.

Restart behaviour: the six-year clock resets if the owner reoccupies as
their main residence. Model this — a client moving back in for a year is a
real strategy and the reset is the reason it works.

**A Focus view for this**, since you asked for it and it is genuinely hard
to reason about otherwise:
- a **timeline bar** per property, colour-coded by status period, with the
  six-year window and its expiry marked;
- a line showing **CGT payable if sold in each year**, which is flat at zero
  while covered and then climbs once the window lapses — the cliff made
  visible;
- a table of exempt days, total days, exempt proportion and the resulting
  taxable gain by year.

Disclose what is not modelled: the six-year rule applied across multiple
successive absences, the choice between two properties as main residence,
and partial-use apportionment for a home office.

Tests: fully exempt while occupied; exempt within six years of absence;
partial exemption once exceeded, at the correct day proportion; the clock
resetting on reoccupation; the Focus view's CGT-if-sold series matching an
actual sale modelled in that year.
Commit: `Main residence exemption and the six-year absence rule`

---

## COMMIT 6 — Spouse contributions, co-contribution and LISTO

Common advice for couples with uneven incomes — which describes much of this
client base.

**Spouse contribution tax offset (FY2026/27):** 18% of the lesser of the
contribution and $3,000, where spouse income ≤ $37,000; phasing out to nil at
$40,000 by reducing the $3,000 by each dollar of income over $37,000. The
spouse must have no excess NCCs and a TSB below the general transfer balance
cap at the prior 30 June.

**Contribution splitting:** up to 85% of the prior year's concessional
contributions may be split to a spouse. Model as an annual election with a
percentage; it moves the balance between accounts and does **not** create a
new contribution or affect caps in the receiving year.

**Government co-contribution:** maximum $500, being 50% of eligible personal
non-concessional contributions, phasing out between $49,293 and $64,293 of
total income. Requires the 10% eligible-income test.

**LISTO:** maximum $500, being 15% of eligible concessional contributions,
where adjusted taxable income is under $37,000, with the 10% earnings test.

Co-contribution and LISTO are government payments *into* super — a genuine
inflow with no household cash movement, so they are a named conservation
term.

Tests: the offset at each income band including the phase-out; splitting
moving balance without touching caps; co-contribution phase-out at both
thresholds; LISTO at the income limit; conservation with government
payments.
Commit: `Spouse contributions, co-contribution and LISTO`

---

## COMMIT 7 — Insurance premiums inside super

Extremely common, reduces the balance every year, currently unmodelled.

Per super account: an annual premium amount with its own indexation (default
to a stated assumption — premiums typically rise faster than CPI with age;
default CPI + 3% and make it visible and editable).

- Premiums are deducted from the account balance, reduce the taxable
  component proportionally, and are **not** a benefit payment.
- Premiums for TPD and income protection held inside super are deductible to
  the fund, which reduces fund tax — model this or disclose that fund-level
  deductibility is not modelled. State which.
- Premiums paid **outside** super need nothing new: they are an expense row.
  Note that in the modal so the whole insurance-cost picture is
  modellable without any needs-analysis machinery.

Tests: premiums reduce the balance and components proportionally; indexation
applies; the premium does not appear as a withdrawal or benefit; conservation.
Commit: `Insurance premiums inside superannuation`

---

## Deferred — do not build
Insurance needs analysis, policy structures, stepped versus level premiums.
Pension phase. Partner death and couple-to-single transition — deliberately
excluded: it is answered by insurance advice, not projected, which is why
Xtools never built it. Land tax surcharges for foreign owners. Capital
improvements as a tracked schedule (fold into cost base as a single figure).
