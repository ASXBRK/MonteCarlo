# Tier 1.2 — Superannuation (accumulation phase)

Conventions per CLAUDE.md. **Four commits, gated.** Full suite + build green
and the phase's regression gate holding before starting the next commit. If
a gate fails and the fix isn't obvious, stop and report.

All figures below are FY2026/27 from the firm's reference set. Put them in a
**data module keyed by FY** (`src/data/superRates.js`), never as constants in
engine code — annual updates must be a data edit.

## Scope

**In:** accumulation accounts with tax components; SG on employment income;
salary sacrifice; personal deductible and non-deductible contributions;
spouse contributions; concessional cap with 5-year carry-forward;
non-concessional cap with bring-forward; 15% contributions tax; Division 293;
15% earnings tax with the CGT discount in super; preservation and conditions
of release; lump-sum withdrawals with proportioning.

**Out (do not build):** pension phase of any kind (ABP, TTR, minimum
drawdowns, transfer balance cap), SMSF, defined benefit, insurance premiums
inside super, downsizer, CGT small business cap, FHSSS (Tier 1.5), death
benefits, contribution splitting, co-contribution, LISTO. Where a rule
interacts with an excluded feature, implement the accumulation side only and
disclose the omission in the Parameters modal.

**Engine principle:** super is a new asset class with its own tax treatment,
not a bolt-on. It participates in the existing monthly loop, the existing
surplus/deficit ledger, and the existing per-person tax assessment.

---

## COMMIT 1 — Accounts, contributions, and the monthly loop

### Data module `src/data/superRates.js`
Keyed by FY, FY2026/27 values, with a source comment and as-at date:
```
concessionalCap: 32500
nonConcessionalCap: 130000
bringForwardTsbThresholds: { full: 1840000, two: 1970000, one: 2100000 }
   // TSB < 1.84m → $390,000 over 3 years
   // 1.84m–<1.97m → $260,000 over 2 years
   // 1.97m–<2.1m → $130,000, no bring-forward
   // ≥ 2.1m → nil
carryForwardTsbGate: 500000     // TSB at prior 30 June
carryForwardYears: 5
contributionsTaxRate: 0.15
earningsTaxRate: 0.15
div293Threshold: 250000         // NOT indexed
div293Rate: 0.15                // additional; total 30% on low-tax contributions
sgRate: 0.12
sgMaximumSalary: 270830         // per FY
contributionAgeLimit: 75
workTestAges: [67, 74]
preservationAge: 60             // born from 1 Jul 1964
```
Indexation: caps are held **constant in real terms** by default, consistent
with the existing tax-bracket convention and the same no-indexation toggle.
`div293Threshold` is **not** indexed under either setting — it is not indexed
in law; under the real-terms default it therefore shrinks by CPI each year.
Document this asymmetry in the modal.

### State
```js
plan.superAccounts = [ SuperAccount ]

SuperAccount = {
  id, name,                       // "AustralianSuper", default "Super — <name>"
  owner: "client" | "partner",    // super is never joint
  balance,                        // real $
  taxFreeComponent,               // real $; taxable = balance − taxFree
  allocation,                     // same Allocation shape as financial assets
  icrPct,
  include: true,
}

plan.<person>.super = {
  carryForward: [ /* 5 entries, oldest first, real $ unused cap by FY */ ],
  bringForwardTriggeredYear: null,   // plan year, or null
}
```
Contributions become a new plan-level cashflow section:
```js
cashflows.superContributions = [ SuperContribution ]

SuperContribution = {
  id, label, owner, accountId,
  type: "sg" | "salarySacrifice" | "personalDeductible" | "personalNonDeductible" | "spouse",
  basis: "amount" | "percentOfIncome" | "toConcessionalCap",
  amount,                          // when basis = amount (real $)
  percent,                         // when basis = percentOfIncome
  incomeRowId,                     // when basis = percentOfIncome or type = sg
  frequency, from, to,             // DateRef, per Tier 1.1
  indexBasis, additionalPct,       // per D1
}
```
`toConcessionalCap` contributes whatever fills the remaining cap that FY
(including carry-forward when eligible) — the Xtools "Contributions to Cap"
pattern, and the single most-used input in salary-sacrifice modelling.

### SG
SG is **derived, not entered**: for each employment-type income row, an SG
contribution is generated automatically at `sgRate` on that row's amount,
capped at `sgMaximumSalary` per FY per employer, directed to the owner's
default super account. It appears in the ledger as an ordinary super
contribution but is not user-editable except by a toggle on the income row
(`Superannuation Guarantee: applies / does not apply`, default applies for
employment income, off for other income types).

This requires income rows to gain an **income type** field:
`employment | rental | other taxable | non-taxable` (default employment).
Non-taxable bypasses income tax assessment entirely. Rental income from
properties keeps its existing path — do not route it through income rows.

### Monthly loop
Super accounts grow like financial assets (same Fisher/geometric
convention, ICR deducted) with one difference: **earnings are taxed at 15%**
inside the fund. Implement as a return haircut applied to the *income and
growth components separately*, because realised capital gains in super get a
one-third discount when the asset is held over 12 months:
- income component: taxed at 15%
- growth component: taxed at 15% × (2/3) = 10% effective, on the assumption
  that gains are realised beyond 12 months
Document this as a modelling simplification (real funds realise gains
irregularly; we accrue the tax smoothly).

Contributions enter the account net of contributions tax where applicable
(commit 2). Super accounts are **never** in `fundingOrder` and cannot be
targeted by ordinary contributions, withdrawals, or one-offs — they are
reachable only through super contributions and (commit 3) preserved
withdrawals.

### Tests
SG derivation incl. the maximum-salary cap and the per-income-row toggle;
percent-of-income contributions tracking an indexed salary; account growth
net of 15%/10% haircut against a closed form; super excluded from funding
order and cashflow targeting (validation at every layer).
**Regression gate: scenarios with no super accounts are bit-identical.**
Commit: `Super: accounts, contributions, SG derivation, fund earnings tax`

---

## COMMIT 2 — Caps, contributions tax, Division 293

### Concessional
Per person per FY: total CCs = SG + salary sacrifice + personal deductible.
Cap = `concessionalCap` + available carry-forward.

**Carry-forward:** maintain a rolling 5-year FIFO ledger of unused cap per
person. Unused amounts accrue **regardless of TSB**, but may only be *used*
when the person's **total super balance at the prior 30 June < $500,000**.
Oldest amounts are consumed first; amounts older than 5 years expire.
TSB = sum of that person's super account balances (accumulation only in this
build) at the prior FY end.

**Contributions tax:** 15% on concessional contributions, deducted at the
point of contribution.

**Personal deductible contributions** reduce the owner's assessable income
(they are a deduction in the existing `annual.js` assessment) — this is the
mechanism that makes salary sacrifice vs personal deductible equivalent in
outcome. **Salary sacrifice** instead reduces assessable salary at source:
implement by reducing the income row's taxable amount, not as a deduction.
Both must produce identical tax outcomes for the same dollar amount — assert
this in a test, since it is the clearest correctness check available.

**Excess concessional contributions:** included in the member's assessable
income at MTR with a 15% non-refundable offset; no excess contributions
charge. Model the default (leave in fund); do not model the release election.

### Non-concessional
Cap = `nonConcessionalCap`, with bring-forward triggered automatically when
contributions exceed the annual cap and the person's prior-30-June TSB is
under the relevant threshold: <$1.84m → $390k over 3 years; $1.84m–<$1.97m →
$260k over 2; $1.97m–<$2.1m → $130k no bring-forward; ≥$2.1m → nil.
Track the triggered year and the remaining bring-forward balance.
NCCs are **not** taxed on entry and add to the **tax-free component**.
Excess NCCs: model as rejected with a flagged warning rather than
implementing the excess-NCC tax machinery — disclose.

### Division 293
`Div293 income = taxable income + reportable super contributions +
low-tax contributions` (reportable FBT and net investment loss are not
captured by this tool — disclose). Tax = 15% × lesser of (low-tax
contributions within cap) and (Div293 income − $250,000). Assessed to the
person and paid from **household cashflow** in the FY following assessment
(same t+1 convention as CGT). Do not model the release-from-fund election.

### Contribution acceptance rules
- Age 75 limit for member and spouse contributions (SG has no age limit).
- Work test for **personal deductible** contributions ages 67–74 —
  add a per-person `workTestMet` toggle in Setup, default true, with helper
  text. Do not model the work test exemption.
- Contributions that fail these rules are rejected with a flagged warning
  row, not silently dropped.

### Tests
Carry-forward FIFO accrual, consumption, expiry, and the TSB gate at the
prior 30 June (including the documented trap: crossing $500k *during* the
year does not remove eligibility); bring-forward trigger at each TSB tier;
`toConcessionalCap` fills exactly the available headroom; **salary sacrifice
and personal deductible produce identical net outcomes for equal amounts**;
Div 293 known-value at three income levels including the lesser-of boundary;
excess CC assessable with the 15% offset; age and work-test rejections.
**Regression gate: no-super scenarios bit-identical.**
Commit: `Super: caps, carry-forward, contributions tax, Division 293`

---

## COMMIT 3 — Preservation, withdrawals, proportioning

- **Preservation age 60**; unrestricted access at 65. Model two conditions
  of release only: reaching 65, and retiring at or after preservation age —
  the latter driven by the client's `retirementAge` from Tier 1.1.
- **Withdrawals** from super become available once a condition of release is
  met: a new super withdrawal row type (amount, frequency, DateRef window,
  indexation), and super accounts join `fundingOrder` **only from the year a
  condition of release is met** (before that they are invisible to deficit
  funding, as they must be).
- **Proportioning:** every lump sum is paid in the same tax-free/taxable
  proportion as the interest at the time of payment, recalculated at each
  payment (accumulation interests recalculate — this differs from pensions,
  which fix proportions at commencement; note the distinction in the modal
  since pensions arrive later).
- **Tax on withdrawals:** from age 60, both components are tax-free from a
  taxed source. Below 60 is only reachable via conditions of release we do
  not model, so **block pre-60 withdrawals with a clear message** rather
  than implementing the low-rate cap machinery.

### Tests
Release-condition gating (a super account is invisible to funding order
until released, then available); proportioning across a sequence of
withdrawals with contributions in between; post-60 withdrawals tax-free;
pre-60 blocked.
**Regression gate: no-super scenarios bit-identical.**
Commit: `Super: preservation, withdrawals, proportioning`

---

## COMMIT 4 — UI and outputs

- **Sidebar:** the greyed "Super" entry activates, sitting between Property
  and Liabilities in the fact-find order.
- **Super section:** account cards (name, owner, balance, tax-free
  component, allocation, ICR) and a contributions list reusing the existing
  cashflow row pattern, with the type/basis selects above.
- **Income rows** gain the income-type select and the SG toggle.
- **Setup** gains the per-person work-test toggle (shown only when the
  person is 67–74 at some point in the projection).
- **Cap headroom display:** beside each concessional contribution row, show
  the FY's cap usage — `$32,500 cap · $8,400 SG · $12,000 sacrifice ·
  $12,100 available (incl. $0 carry-forward)`, live. This is the Xtools
  "constraint rows inside the editor" pattern and it is the single most
  useful thing on the screen.
- **Tables:** a Super view (per account: opening, contributions by type,
  contributions tax, earnings, earnings tax, withdrawals, closing;
  plus per person: cap used, carry-forward available, TSB) using the
  existing consolidated|per-account entity selector from C1.
- **Tax view** gains Division 293 and excess-contribution rows per person.
- **Charts:** super included in net assets and the composite chart; a new
  "Super balances" graph.
- **Parameters modal:** a Super section listing what is modelled and the
  disclosed omissions (pension phase, SMSF, insurance in super, downsizer,
  FHSSS, co-contribution/LISTO, excess NCC tax, release elections, work-test
  exemption, reportable FBT and investment losses in Div 293 income, the
  smooth-accrual earnings tax simplification).

Commit: `Super: input UI, super view, chart and tax integration`

---

## Deferred
Pension phase and TTR (Tier 4), FHSSS (Tier 1.5), SMSF (parked),
contribution splitting, downsizer, CGT small business cap, co-contribution
and LISTO, insurance premiums in super, death benefits.
