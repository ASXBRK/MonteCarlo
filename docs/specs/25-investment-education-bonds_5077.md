# Investment and Education Bonds

Conventions per CLAUDE.md. **Three commits, gated.** Independent of specs
20–24.

## Why

Investment bonds are tax-paid structures — earnings taxed at 30% inside the
bond, and withdrawals tax-free after ten years. That makes them relevant for
high-marginal-rate clients and for education funding, and the firm's Xplan
carried up to twenty of them per client
(`docs/reference/xtools-calm-reference.md`, §11 non-goals).

**Education bonds matter more for this client base.** School fees are
already modelled as an expense met from cashflow (spec 15). An education
bond turns that into a fundable target with a materially different tax
outcome — and the comparison between the two is the advice question a family
with young children actually faces.

## A verification requirement before implementing Commit 3

The education benefit mechanics — how the earnings component of an
education-purpose withdrawal is treated, and the size of the benefit —
should be **verified against a provider's PDS or ATO guidance before
implementation**, not asserted from general knowledge. Where verification is
not possible, implement the plain investment bond treatment, flag the
education benefit as unmodelled, and say so. A tool that overstates an
education bond's advantage is worse than one that omits it.

---

## COMMIT 1 — Investment bond structure

```
plan.bonds = [ {
  id, name, owner, type: "investment" | "education",
  balance, startDate,
  allocation, icrPct,           // as any other asset
  contributions: [ Cashflow ],  // per-bond, its own rows
  // education only (Commit 3):
  beneficiaryChildId, educationWithdrawals: [ ... ],
} ]
```

### Tax treatment
- Earnings are taxed **inside the bond at 30%**, not to the investor.
  Franking credits within the bond reduce the effective rate — model the
  effective rate as 30% less the franked proportion's benefit, using each
  bond's allocation and its derived franking, consistent with how the
  engine already derives franking from class weights.
- Bond earnings do **not** appear in the investor's assessable income,
  HELP repayment income, Division 293 income or the Medicare levy
  surcharge base. That exclusion is much of the point for a high earner.
- Bonds are **not** CGT assets — no cost base pool, no disposal event.

### The ten-year rule
- Withdrawals after **ten years** from the start date are entirely tax-free.
- Withdrawals **before** ten years: the earnings component is assessable at
  marginal rates with a **30% tax offset**, so a client on a marginal rate
  above 30% still pays something, and one below 30% may receive a refund of
  the difference.
- Withdrawal splits proportionally between the original investment and
  accumulated earnings.

### The 125% rule
Contributions in a year up to **125% of the previous year's contributions**
do not restart the ten-year clock. A contribution above that **resets the
start date** to the beginning of that year, restarting the ten years for
the whole bond.

This is the trap: a well-intentioned extra contribution can cost a client
their ten-year status. Model it, and **flag it visibly at the point the
reset would occur** — this is the single most important warning in the
feature.

A year with **no contribution** sets the following year's 125% base to nil,
so any contribution the year after restarts the clock. Model that too; it
catches people who pause.

Tests: earnings taxed at 30% inside and absent from every investor income
measure; a post-ten-year withdrawal untaxed; a pre-ten-year withdrawal
assessable with the 30% offset at marginal rates above and below 30%; the
125% rule allowing a compliant increase and resetting on a breach; the
nil-contribution-year consequence; conservation.
Regression gate: scenarios with no bonds bit-identical.
Commit: `Investment bonds: structure, tax, and the ten-year and 125% rules`

---

## COMMIT 2 — Bonds in the engine and outputs

- Bonds participate in the monthly loop like other assets, with their own
  net return after the internal 30% and ICR.
- Bonds are **eligible for deficit funding** (they are liquid), subject to
  the same funding order and minimum balances. A deficit-funded withdrawal
  before ten years triggers the assessable-earnings treatment — which is a
  real cost the plan should show rather than hide.
- Bonds appear in net assets, the Assets view and the allocation chart as
  their own class.
- **Tables → Bonds**: per bond per year — opening, contributions, earnings,
  internal tax, withdrawals, assessable portion, closing, plus years to the
  ten-year date and the current 125% headroom.

Tests: deficit funding from a bond applying the pre-ten-year treatment;
bonds in net assets and allocation; the table reconciling to the engine.
Commit: `Investment bonds: engine integration and outputs`

---

## COMMIT 3 — Education bonds and the funding comparison

Subject to the verification requirement above.

An education bond carries a beneficiary child and an education benefit on
withdrawals used for education expenses. Link it to the education funding
already modelled per child (spec 15 Commit 3) so that a bond can **fund**
those fees rather than them being met from cashflow.

**Focus → Education funding** — the comparison that justifies the structure:
the same dollars, three ways.
1. Saved outside super and outside a bond, meeting fees from cashflow
2. In an investment bond
3. In an education bond, with the education benefit

Show the net cost of funding the same fee schedule under each, with the tax
paid along the way. All three arms run through `projectPlan` on clones, per
the Focus governing principle — do not hand-roll the comparison arms.

Surface the constraints honestly: the ten-year rule interacts badly with a
child close to school age; the 125% rule limits catch-up contributions; and
a bond is not free — 30% inside beats a top marginal rate but loses to a low
one. **Flag when a bond is worse than the alternative for the modelled
client**, since the tool exists to reveal that rather than to sell the
product.

Tests: education withdrawals reducing the modelled fee expense; the
comparison arms reconciling to real projection runs; the worse-than-
alternative flag firing for a low-marginal-rate client.
Commit: `Education bonds and the funding comparison`

---

## Deferred — do not build
Bond ownership by a trust or company. Transfer of ownership and its tax
consequences. Bond-based estate planning and nominated beneficiaries.
Insurance bonds with a life component. Withdrawal of the original capital
before earnings (bonds withdraw proportionally; some products differ —
disclose).
