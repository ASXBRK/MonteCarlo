# Superannuation Death Benefits

Conventions per CLAUDE.md. **Three commits, gated.** Depends on spec 20 —
reversionary pensions and the transfer balance account on death both require
pension phase.

All FY2026/27 figures from the firm's reference.

## Why

Super is frequently a client's largest asset and it does not pass by will —
it passes by nomination, taxed by the recipient's status. A benefit going to
an adult child is taxed where the same benefit to a spouse is not, and the
difference on a $600,000 taxable component is around $100,000. That is a
number every client should see and currently cannot.

**This is not partner-death modelling.** We deliberately excluded projecting
a partner's death and the couple-to-single transition — that is an insurance
question answered by needs analysis, not a projection, which is why Xtools
never built it. This spec models the **tax outcome of the super balance at
the projection's end**, as a planning figure: *if this balance passes to
these beneficiaries, this is what they receive.* No projection branches, no
survivor scenario.

## Scope

**In:** lump sum death benefit tax by beneficiary status; the dependant
versus non-dependant distinction; nomination as an input; reversionary
pensions continuing to a spouse with their transfer balance credit;
re-contribution as an evaluable strategy.

**Out:** child death benefit pensions; estate and testamentary trust
mechanics; binding nomination validity and lapsing; SMSF-specific rules;
anti-detriment (abolished); AFCA processes; insurance proceeds inside super.

---

## COMMIT 1 — Death benefit tax on the terminal balance

### Tax on lump sum death benefits
| Beneficiary (tax definition) | Tax-free component | Taxable — taxed element | Taxable — untaxed element |
|---|---|---|---|
| Dependant | NANE | NANE | NANE |
| Non-dependant | NANE | **15%** + Medicare | **30%** + Medicare |
| Estate | NANE | taxed per ultimate beneficiary | taxed per ultimate beneficiary |

Medicare is **not** payable where the benefit is paid to the deceased's
estate — a real and frequently missed distinction.

### The dependant definition that matters
A **tax dependant** is a spouse, a child under 18, a person in an
interdependency relationship, or a financial dependant. An **adult child is
not a tax dependant** — which is the single most common and most expensive
case, and the reason this feature exists.

Note the trap: an adult child *is* a SIS dependant (so the fund may pay them
directly) but *is not* a tax dependant (so they pay tax). Both facts are
true simultaneously and confusing them produces wrong advice in both
directions. State it in the modal.

### Model
```
plan.<person>.deathBenefit = {
  beneficiaries: [ { id, label, relationship, sharePct } ],
}
```
`relationship` ∈ `spouse` · `adultChild` · `minorChild` · `interdependent`
· `financialDependant` · `estate`. Tax dependency derives from
relationship; do not ask the user to classify it — that is the part they get
wrong.

Computed per person at the **final projection year**: for each super and
pension account, the tax-free and taxable components at that point, split by
beneficiary share, taxed per the table, giving gross benefit, tax, and net
to each beneficiary.

The untaxed element applies only to untaxed-source funds (some public
sector). We do not model untaxed schemes — emit the column, populate zero,
and disclose.

Tests: dependant receives the whole amount untaxed; adult child taxed at 15%
plus Medicare on the taxable element; estate taxed at 15% with no Medicare;
a split across three beneficiaries apportioning components proportionally;
components sourced correctly from a pension (fixed proportions) versus an
accumulation account (recalculated).
Regression gate: scenarios with no beneficiaries bit-identical.
Commit: `Death benefits: lump sum tax on the terminal balance`

---

## COMMIT 2 — Reversionary pensions

A pension nominated as reversionary continues to the spouse on death rather
than being paid as a lump sum.

- The `reversionary` flag already exists on pensions (spec 20 Commit 1) as a
  flag with no consequences. Give it consequences.
- On death, a reversionary pension **continues to the spouse** and is
  **NANE** to them as a tax dependant.
- The transfer balance credit for the reversionary beneficiary arises
  **twelve months after the date of death**, at the value at the date of
  death — not at the date of reversion. That delay is deliberate in the law
  (it gives the survivor time to restructure) and modelling it as immediate
  would misstate their remaining cap.
- Report the spouse's resulting transfer balance position, since a
  reversionary pension can push a survivor over their own cap, which is the
  planning issue.

Do **not** branch the projection into a survivor scenario. Report the
position as a terminal figure, consistent with Commit 1.

Tests: a reversionary pension shown as continuing rather than as a lump sum;
NANE to the spouse; the twelve-month credit at the date-of-death value; a
survivor pushed over their cap flagged with the excess.
Commit: `Death benefits: reversionary pensions and the survivor's cap`

---

## COMMIT 3 — Outputs and the re-contribution strategy

### Outputs
- **Tables → Death benefits**: per person, per account, at the final year —
  tax-free component, taxable component, per beneficiary share, tax, and net
  received. Plus a household total.
- A **Focus → Death benefits** view showing the tax cost under the current
  nomination against alternatives, so the cost of nominating an adult child
  rather than a spouse, or paying via the estate, is a number rather than an
  assertion.

### Re-contribution, as an evaluable strategy
Withdrawing a taxable amount after age 60 (tax-free at that age) and
re-contributing it as a non-concessional contribution converts taxable
component to tax-free component, reducing the eventual death benefit tax to
non-dependants.

This is already expressible with existing machinery — a super withdrawal
plus a non-concessional contribution. What is missing is *showing what it
achieved*. Add to the Focus view a comparison of the death benefit tax with
and without the re-contribution actually modelled in the scenario, both arms
run through `projectPlan` on clones per the Focus governing principle.

Constraints to respect and surface: the non-concessional cap and
bring-forward limit how much can be re-contributed per year; the client must
be under 75; and the strategy only helps if there is a non-dependant
beneficiary. Flag when it is modelled but cannot help.

**Non-prescriptive**, per the locked convention: state the tax difference
and the constraints. Do not label a nomination or a strategy as better.

Tests: the Focus alternatives each reconcile to a real projection; the
re-contribution comparison reflects an actually-modelled re-contribution,
not a synthetic estimate; the "cannot help" flag fires when every
beneficiary is a tax dependant.
Commit: `Death benefits: outputs and re-contribution comparison`

---

## Deferred — do not build
Child death benefit pensions and their cessation at 25. Estate and
testamentary trust taxation. Binding nomination validity, lapsing and
renewal. SMSF death benefit rules and trustee discretion. Insurance proceeds
inside super and their untaxed element. Partner death as a projection
branch — deliberately and permanently excluded.
