# Income Completeness

Conventions per CLAUDE.md. **Four commits, gated.** Independent of specs
20–22; can run in parallel with them.

## Why

Three gaps on the income side, all common in this client base and all
currently modelled wrongly rather than merely absent:

1. Every income is treated as smooth recurring salary. The firm's own
   `Cash Flow SOA` has **Site/Locality Allowance** and **After tax bonus**
   as distinct rows, and a resources-sector book has large variable
   components.
2. SG is calculated on aggregated income, but the **maximum contribution
   base applies per employer**. Anyone with two jobs is modelled wrongly
   today, in the direction of understating SG.
3. Salary packaging is unmodelled despite the firm's spreadsheet carrying
   four deduction rows for it.

---

## COMMIT 1 — Employers as a first-class concept

SG and the maximum contribution base apply **per employer**, not to
aggregated income. Two jobs at $200,000 each generate SG on both up to the
cap on each — materially more than SG on $400,000 capped once.

```
plan.employers = [ { id, name, ownerId } ]
```
Employment income rows gain `employerId`. SG derives per employer, capped at
the maximum contribution base per employer per quarter (model annually,
disclose).

Salary sacrifice is also per employer — you sacrifice from a specific
employer's salary, not from a pooled income.

Migration: existing employment rows get a default employer per owner, so
behaviour is unchanged for single-employer clients.

Tests: two employers each generating capped SG; the aggregate exceeding
what single-capped SG would give; sacrifice attributed to the right
employer; single-employer scenarios bit-identical after migration.
Commit: `Employers: per-employer SG and contribution base`

---

## COMMIT 2 — Bonus and allowance income types

New income categories with timing that differs from salary:

- **Bonus** — paid in a nominated month (default: the last month of the FY,
  editable), taxed in the year received. PAYG withholding on a bonus uses
  the marginal method rather than the regular schedule; model it as withheld
  at the recipient's marginal rate on the bonus amount, which is closer to
  reality than spreading it, and disclose.
- **Allowance** — site, locality, travel. Some allowances are assessable and
  some are not; carry a `taxable` flag rather than assuming. Paid with
  salary frequency.
- **Overtime** — assessable, but **not** ordinary time earnings, so **no SG
  applies**. This is a real distinction and getting it wrong overstates
  super for shift workers.

Each carries its own indexation, since a bonus that is a fixed percentage of
salary indexes with salary while a flat allowance may not.

**Directing a bonus** is where the value is: a bonus row can nominate a
destination — additional loan repayment, super contribution, or an asset —
so "the bonus goes to the mortgage" is expressible. Falls through to the
normal surplus treatment if the destination is unavailable.

Tests: bonus taxed in the month received with marginal withholding;
allowance taxable and non-taxable variants; overtime generating no SG;
bonus directed to a loan reducing the balance in that month; conservation.
Commit: `Bonus, allowance and overtime income types`

---

## COMMIT 3 — Salary packaging

Three employer types, each behaving differently. **Take the caps from the
firm reference; if they are not present there, flag them as requiring
confirmation and use the manual-override pattern rather than asserting
figures.**

- **FBT-exempt** (public benevolent institutions, health promotion
  charities, public and non-profit hospitals, public ambulance): a **living
  expense cap** with benefits inside it completely FBT-exempt and excess
  taxable at 47%, plus a **separate meal entertainment cap**. Both operate
  independently.
- **FBT-rebatable** (registered charities, non-profit schools, unions,
  community not-for-profits): a rebate rather than an exemption.
- **Standard**: no cap benefit; packaging only helps for FBT-exempt *items*.

**Cars are never covered by either cap** and are always fully taxable at
47% regardless of employer type. State this prominently — it is the most
common misunderstanding in the area.

Model: `employer.fbtType`, and packaged amounts as deduction rows with a
`packagingType`. Packaged amounts reduce taxable income; amounts above a cap
attract FBT at 47% on the grossed-up value.

**Reportable fringe benefits are the sting.** Packaged amounts appear as a
reportable fringe benefits amount, which is added back for HELP repayment
income, Division 293 income, the Medicare levy surcharge, and family
assistance. We already compute all four — so packaging that reduces income
tax may increase HELP and Division 293. Model it, and surface the net
position, because that reversal is exactly what an adviser needs to see.

Tests: each employer type; a cap breach taxed at 47% grossed-up; a car
taxable regardless of type; reportable benefits flowing into HELP, Division
293 and MLS; the net position after all four.
Commit: `Salary packaging by employer type`

---

## COMMIT 4 — Novated leases

A car packaged through a novated lease, with the FBT consequence.

**Statutory formula method** (the default; the operating cost method
requires logbook data we do not collect — disclose):
```
Taxable value = (Base value × 20% × Days provided / 365) − Employee contribution
```
Base value is the cost price including GST, warranties and delivery, but
excluding registration and stamp duty. Reduced by one-third once the car has
been held for four complete FBT years.

**Employee contribution method (ECM)** — post-tax contributions reduce the
taxable value dollar for dollar and are the usual structure. Model both
pre-tax and post-tax components, as the firm's own worked example does.

Lease payments split into pre-tax and post-tax; the pre-tax portion reduces
taxable income; the post-tax portion is an ordinary expense. Running costs
(fuel, servicing, tyres, registration, insurance) can be packaged with the
lease.

At lease end, a **residual** is payable — model it as a one-off outflow at
the lease end date, with the option to refinance instead.

Tests: statutory taxable value at several base values and terms; the
one-third reduction after four years; ECM reducing taxable value; pre-tax
and post-tax split reaching the right places; the residual falling in the
right month.
Commit: `Novated leases`

---

## Deferred — do not build
Operating cost method (needs logbook data). FBT on non-car benefits beyond
the packaging caps. Employee share schemes. Fringe benefits provided
directly by an employer outside a packaging arrangement. Childcare packaging
and its interaction with the Child Care Subsidy.
