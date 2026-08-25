# Pension Phase

Conventions per CLAUDE.md, including the conservation rule — several commits
introduce new money flows and must extend `randomScenario()` and the
invariant in the same commit.

**Five commits, gated.** All FY2026/27 figures from the firm's reference;
FY-keyed data module as usual.

## Why

The engine serves accumulation completely and retirement not at all. The
firm's own row vocabulary already reserves space for this — `Taxable Pension
Component` and `Taxable Pension Offset (TTR)` currently emit zeros. This is
the last structural gap before the engine covers a full lifecycle.

## Scope

**In:** account-based pensions; minimum drawdown factors; the proportioning
rule fixed at commencement; transfer balance cap and transfer balance
account with indexation; retirement-phase earnings exemption; transition to
retirement with its own treatment; commutations; reversionary nomination as
a flag.

**Out (do not build):** defined benefit pensions and the defined benefit
income cap; market-linked and lifetime products; death benefit pensions;
Centrelink assessment of pensions (spec 21); pre-2015 grandfathering
(spec 21b). Emit zero rows where the firm's vocabulary expects them.

---

## COMMIT 1 — Pension accounts and commencement

### State
```
plan.pensions = [ Pension ]

Pension = {
  id, name, owner,
  sourceAccountId,        // the super account it commences from
  commenceAt,             // DateRef
  type: "abp" | "ttr",    // account-based pension | transition to retirement
  commenceAmount,         // real $, or null for "whole balance"
  reversionary: bool,     // flag only; consequences are out of scope
  // set at commencement, then fixed:
  taxFreeProportion,      // null until commenced
  allocation, icrPct,     // as any other account
}
```

### The proportioning rule — get this exactly right
At commencement the tax-free and taxable proportions are **fixed for the
life of the pension**. Every subsequent payment and commutation is made in
those proportions, regardless of later earnings. This is the single most
important mechanical difference from accumulation, where components
recalculate on every payment (as built in Tier 1.2 Commit 3), and it is what
makes a re-contribution strategy work.

Implement as a snapshot taken at the commencement month from the source
account's then-current components. Document the contrast with the
accumulation treatment in the Parameters modal, since having both behaviours
in one engine invites confusion.

### Commencement mechanics
- The amount moves from the super account to the pension account; components
  transfer proportionally from the source.
- A commencement requires a condition of release for an ABP: age 65, or
  retirement at or after preservation age (60). Reuse the existing gate.
  A TTR requires only preservation age.
- Commencing with the whole balance closes the source account to zero but
  leaves it open for future contributions — that is what actually happens,
  and a client contributing after commencing a pension is ordinary.

Tests: proportions fixed at commencement and unchanged by later earnings;
partial commencement transfers components proportionally; condition-of-
release gating for ABP versus TTR; contributions continuing to the source
account after commencement.
Regression gate: scenarios with no pensions bit-identical.
Commit: `Pension phase: accounts, commencement, and the proportioning rule`

---

## COMMIT 2 — Drawdown, minimums, and payments

### Minimum drawdown factors (FY2026/27)
| Age | Minimum |
|---|---|
| Under 65 | 4% |
| 65–74 | 5% |
| 75–79 | 6% |
| 80–84 | 7% |
| 85–89 | 9% |
| 90–94 | 11% |
| 95+ | 14% |

Applied to the 1 July balance. **Pro-rated when a pension commences
part-year, and no minimum at all if it commences 1–30 June.** Pro-rated to
the commutation date in a commutation year. These pro-rating rules are
easy to omit and produce visibly wrong first-year figures.

### Drawdown options, per pension
`minimum` (default) · `fixed amount` (real $, indexed) · `to expenditure`
(draw what the household needs, floored at the minimum — this is the
"Expend" behaviour Xtools removed for performance and our engine handles
natively; see `docs/reference/xtools-calm-reference.md` §10 item 2) ·
`maximum` (TTR only — 10% of the 1 July balance).

Whichever is chosen, **the minimum always applies as a floor**. A plan that
draws less than the minimum is not a plan; it is a compliance breach.

### Tax on payments
From age 60, payments from a taxed source are **tax-free** and do not appear
in assessable income. Below 60 is only reachable via a TTR: the taxable
component is assessable at marginal rates with a **15% offset**, and the
tax-free component is tax-free. That offset is the `Taxable Pension Offset
(TTR)` row the firm's vocabulary expects.

Payments flow into household cashflow through the working cash account like
any other income.

Tests: each age band's minimum; part-year pro-rating and the 1–30 June
exception; the minimum acting as a floor under every drawdown option; TTR
maximum; post-60 payments absent from assessable income; pre-60 TTR taxable
component assessable with the 15% offset; conservation.
Commit: `Pension phase: drawdown, minimums, and payment tax`

---

## COMMIT 3 — Retirement-phase earnings exemption and TTR

The reason pension phase exists.

- An **ABP in retirement phase pays no tax on earnings** — replace the
  15%/10% haircut built for accumulation (Tier 1.2 Commit 1) with zero for
  these accounts. Capital gains inside the account are likewise untaxed.
- A **TTR is not in retirement phase**: its earnings are taxed as
  accumulation, at 15% on income and 10% effective on growth. A TTR converts
  to retirement phase when the member meets a full condition of release —
  turning 65, or notifying retirement at or after preservation age. Model
  the age-65 conversion automatically; model retirement notification from
  the client's `retirementAge` where it falls at or after preservation age.

This distinction is the entire point of the TTR-versus-ABP question and
getting it backwards would make TTR look better than it is.

Tests: ABP earnings untaxed; TTR earnings taxed as accumulation; automatic
conversion at 65 and at notified retirement; the resulting balance
divergence between an ABP and a TTR commenced identically.
Commit: `Pension phase: retirement-phase earnings exemption and TTR`

---

## COMMIT 4 — Transfer balance cap and account

**General transfer balance cap: $2,100,000** (FY2026/27), indexed with CPI
in $100,000 increments — the step indexation already built for Division 296.

- Each person has a **transfer balance account**: commencing a retirement-
  phase pension is a **credit** at its commencement value; a commutation is
  a **debit** at the commuted amount. Pension payments are **not** debits —
  a common misunderstanding and worth a comment.
- **Personal transfer balance cap** with proportional indexation: a member
  who has never used their full cap gets indexation on the *unused
  proportion* only. A member who has used 100% never gets indexation again.
  This is the fiddly part and the one most likely to be implemented as
  simple indexation of the general cap — it isn't.
- A **TTR does not count** toward the cap until it converts to retirement
  phase, at which point it credits at its then-current value.
- **Excess**: model as a flagged warning with the excess amount and the
  earnings tax that would apply (15% first breach, 30% subsequent), but do
  **not** model the commutation authority process. Disclose.

Tests: credit on commencement, debit on commutation, payments not debiting;
proportional indexation for a member at 40% used versus 100% used; TTR
crediting only on conversion; excess flagged at the right amount.
Commit: `Pension phase: transfer balance cap and account`

---

## COMMIT 5 — Commutations, UI and outputs

- **Commutation**: a partial or full withdrawal from a pension as a lump
  sum, in the fixed proportions, debiting the transfer balance account.
  Post-60 it is tax-free. A full commutation closes the pension and may
  return the balance to accumulation — model both destinations (cash or back
  to super).
- **Input**: a Pensions section in the sidebar between Super and Liabilities.
  Cards carry the field set above plus the drawdown option; commencement
  uses the DateRef anchor control.
- **Outputs**: a Pensions table (per pension: opening, payments, earnings,
  commutations, closing, plus components); pension balances joining the
  super chart as a separate band; the `Taxable Pension Component` and
  `Taxable Pension Offset (TTR)` rows in the firm's cashflow vocabulary
  populating; transfer balance account and remaining cap in the Tax view.
- **Smart defaults** per the spec 19 registry: commencement defaults to the
  owner's retirement key date; drawdown defaults to minimum; type defaults
  to ABP when the owner is at or over 65 and TTR when between preservation
  age and 65.

Tests: commutation in fixed proportions with the TBA debit; both
destinations; the reserved vocabulary rows populating; conservation across
commencement, payment and commutation.
Commit: `Pension phase: commutations, input UI, and outputs`

---

## Deferred — do not build
Defined benefit pensions and the DB income cap; market-linked and lifetime
products; death benefit and reversionary pension mechanics beyond the flag;
Centrelink assessment (spec 21); pre-2015 deeming grandfathering (spec 21b);
the commutation authority process for TBC excess; segregated versus
proportionate SMSF exempt current pension income.
