# Defined Benefit Superannuation

Conventions per CLAUDE.md. **Three commits, gated.** Depends on spec 20 for
the pension-phase and transfer balance machinery.

## Why

Rare nationally, common in Perth. WA state government employees — teachers,
police, health, public service — hold GESB Gold State Super (a true defined
benefit) and West State Super (an accumulation scheme with an **untaxed**
element). Both behave differently to ordinary super, and both are currently
unmodellable.

Getting them wrong is worse than omitting them: an untaxed element taxed as
though it were taxed-source understates tax substantially, and a defined
benefit pension counted against the transfer balance cap at face value
overstates the cap used by a factor of ten.

## Scope

**In:** defined benefit pensions with their income cap and special value for
transfer balance purposes; untaxed elements and their tax treatment; notional
taxed contributions against the concessional cap.

**Out:** actuarial valuation of a defined benefit interest; benefit
multiples and salary-based accrual formulas beyond a user-entered figure;
commutation of a defined benefit pension; scheme-specific rules.

**The scoping principle:** we do not compute what the fund's actuary
computes. The client's annual statement tells them their benefit multiple,
their notional contributions and their projected pension — we take those as
inputs and model the *tax and Centrelink consequences* correctly, which is
what an adviser actually needs.

---

## COMMIT 1 — Untaxed elements

Some public sector schemes are **untaxed** — no 15% contributions tax and no
15% earnings tax inside the fund, with tax instead falling on the member at
benefit time.

Super accounts gain `taxedStatus: "taxed" | "untaxed"` (default taxed).

For an untaxed account:
- Contributions enter **without** the 15% contributions tax. Concessional
  contributions still count against the cap.
- Earnings accrue **without** the 15%/10% internal haircut.
- The balance carries an **untaxed element** of the taxable component.
- On withdrawal from age 60, the untaxed element is assessable at marginal
  rates with a **15% offset**, up to the **untaxed plan cap ($1,935,000,
  indexed with AWOTE in $5,000 steps)**; above the cap it is taxed at 47%.
  This is the significant divergence from a taxed fund, where a post-60
  withdrawal is tax-free.
- Rolling an untaxed benefit to a taxed fund triggers **15% tax on the
  untaxed element at the point of rollover**, capped at the untaxed plan
  cap. Model the rollover, since "should I roll West State into an
  accumulation fund" is a live question for this cohort.

Tests: contributions entering an untaxed account in full; earnings untaxed
inside; a post-60 withdrawal assessable with the 15% offset; the untaxed
plan cap boundary at 47%; a rollover to a taxed fund taxed at 15% on the
untaxed element; taxed accounts bit-identical.
Commit: `Untaxed superannuation elements`

---

## COMMIT 2 — Defined benefit pensions

```
plan.definedBenefits = [ {
  id, name, owner,
  commenceAt,               // DateRef
  annualPension,            // real $, as stated by the fund
  indexation,               // basis + additional; DB pensions commonly index at CPI
  taxFreeProportion,        // from the member's statement
  untaxedProportion,        // untaxed element, where applicable
  reversionaryPct,          // to spouse on death, typically 67%
  notionalTaxedContributions, // annual, counts against the concessional cap
} ]
```

### Tax on payments
From age 60: the taxed element is tax-free; the **untaxed element remains
assessable at marginal rates with a 10% offset**. That offset differs from
the 15% on an untaxed lump sum — a distinction easily conflated.

### Defined benefit income cap
Where a member's defined benefit income exceeds the cap (**$125,000** for
FY2026/27 — take the current figure from the firm reference and state the
as-at date), **50% of the excess** is included in assessable income even
though it would otherwise be tax-free. Model it.

### Transfer balance account — the factor of ten
A defined benefit pension credits the transfer balance account at its
**special value: annual pension × 16**, not at a notional capital amount.
Getting this wrong by using the pension amount directly understates cap
usage sixteenfold and would let a client appear to have room they do not
have.

### Concessional cap
**Notional taxed contributions** count toward the concessional cap. Members
of certain grandfathered schemes have their notional contributions capped at
the concessional cap so they cannot involuntarily exceed it — model the
plain case and disclose the grandfathering.

Tests: payments tax-free from a taxed source at 60; untaxed element
assessable with the 10% offset; the DB income cap including 50% of the
excess; the transfer balance credit at 16× annual pension; notional
contributions consuming concessional cap headroom.
Commit: `Defined benefit pensions`

---

## COMMIT 3 — Centrelink treatment and outputs

**Centrelink** (requires spec 21a): a defined benefit pension is assessed
under the **income test only** — it is not an assessable asset, since there
is no account balance to assess. Assessable income is the pension less its
**deductible amount** (the tax-free component). That asset-test exemption is
a material planning advantage and is invisible unless modelled.

**Outputs:**
- Defined benefit pensions appear in the Pensions table with their own rows,
  marked as defined benefit, showing gross pension, deductible amount,
  assessable portion and tax.
- The transfer balance account shows the 16× special value credit
  distinctly, since it looks wrong otherwise.
- The Age pension table shows the income-test-only treatment.
- Key figures gains defined benefit income as its own line, since it is not
  a balance and does not appear in net assets — which surprises people.

Tests: income-test-only assessment with no asset value; the deductible
amount reducing assessable income; the special value in the transfer balance
account; the table rows reconciling.
Commit: `Defined benefit: Centrelink treatment and outputs`

---

## Deferred — do not build
Actuarial valuation and benefit multiple accrual. Commutation of a defined
benefit pension. Scheme-specific rules (Gold State, West State, PSS, CSS,
military schemes) beyond the generic untaxed and defined benefit mechanics.
Defined benefit death benefits beyond the reversionary percentage. Notional
contribution grandfathering for pre-2013 members.
