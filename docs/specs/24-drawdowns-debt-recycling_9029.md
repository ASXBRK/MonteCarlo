# Loan Drawdowns and Debt Recycling

Conventions per CLAUDE.md. **Three commits, gated.** Independent of specs
20–23. Pairs with the surplus allocation model (spec 16).

## Why

Loans can only shrink in the current model. Real loans are redrawn, and
equity is released — which is how people fund investments, renovations and
subsequent purchases. Xtools models this as a first-class input screen
(`Liabilities → Drawdowns`, `docs/reference/xtools-calm-reference.md` §7)
and it is how the equity-release workaround in the forum is performed.

More importantly, drawdowns are what make **debt recycling** expressible —
the strategy of paying down non-deductible home debt and redrawing for
investment, converting non-deductible interest into deductible interest
without changing total debt. It is one of the most commonly recommended
strategies for exactly this client base, and the tool currently cannot model
it at all.

## The rule everything turns on

**Deductibility follows the USE of the borrowed funds, not the security.**
A loan secured against the family home is deductible if the money bought
income-producing assets. This is why debt recycling works, and why
`deductiblePct` must become *dynamic* — it changes as drawdowns for
different purposes accumulate against the same loan.

---

## COMMIT 1 — Drawdowns and dynamic deductibility

### Model
```
liability.creditLimit          // NEW — the facility limit; balance may not exceed it
liability.drawdowns = [ {
  id, amount, at (DateRef),
  purpose: "investment" | "private",
  destination: assetId | "cash" | propertyId,
  label,
} ]
```

### Mechanics
- A drawdown increases the loan balance at its month, capped at the credit
  limit. Attempting to exceed the limit is a flagged warning and draws only
  the available headroom — a bank would not lend beyond the facility, and
  silently allowing it would model an impossible plan.
- The money arrives at its destination: an asset (credited), cash (into the
  working cash account), or a property (funding a purchase or improvement).
- **Repayments recompute** over the increased balance and remaining term,
  the same recalculation as the fixed-rate rollover in spec 13.

### Dynamic deductibility — the substance of this commit
Track the loan's balance in two buckets: **investment-purpose** and
**private-purpose**. `deductiblePct` becomes derived:
`investmentBalance / totalBalance`.

- A drawdown adds to its purpose's bucket.
- **A repayment reduces the buckets proportionally by default.** This is the
  legally correct treatment for a mixed-purpose loan and it is the reason
  debt recycling requires a *separate split facility* rather than redrawing
  on one mixed loan — you cannot direct repayments at the private portion of
  a mixed loan.
- Add a `repaymentAllocation` option — `proportional` (default, correct) or
  `privateFirst` — so a split facility can be modelled as a second loan with
  private-first allocation, and flag `privateFirst` on a single mixed loan
  as an assumption the ATO would not accept. **The tool should let the
  adviser model it and tell them it is aggressive, not silently permit or
  silently forbid it.**

The user-entered `deductiblePct` becomes the *opening* proportion; from
there it is engine-derived unless overridden, per the derived-until-overridden
convention.

Tests: a drawdown increasing the balance and repayments recomputing; the
credit limit binding with a warning; proportional repayment keeping the
deductible proportion constant; private-first allocation shifting it; the
opening proportion respected; conservation — a drawdown moves money, it does
not create it.
Regression gate: liabilities without drawdowns bit-identical.
Commit: `Loan drawdowns and dynamic deductibility`

---

## COMMIT 2 — Debt recycling as a modelled strategy

With drawdowns and surplus allocation both present, debt recycling is
expressible: surplus pays down the home loan, an equal amount is drawn for
investment, and the deductible proportion rises each cycle.

Add a **recycling plan** on a liability so the adviser does not have to
hand-enter a drawdown per year:
```
liability.recycling = {
  enabled, from, to,            // DateRef window
  destinationAssetId,           // where redrawn funds are invested
  matchRepayments: bool,        // redraw an amount equal to principal repaid
  annualCap,                    // optional limit per year
}
```
Each year, redraw an amount equal to the principal repaid (or the capped
amount), direct it to the destination asset, and mark it investment-purpose.
Total debt stays flat; the deductible proportion climbs.

**State the risks in the view, not just the benefit.** Total debt does not
reduce; the strategy depends on the investment return exceeding the
after-tax borrowing cost; and it converts a repaid home loan into a
maintained investment loan. Non-prescriptive, as always — the tool shows
the outcome and the exposure, and does not recommend.

Tests: total debt flat across a recycling cycle; the deductible proportion
increasing at the expected rate; the destination asset growing by the
redrawn amounts; the annual cap binding; interest deductions rising in step;
conservation across the cycle.
Commit: `Debt recycling`

---

## COMMIT 3 — Outputs

- **Liabilities table**: drawdowns as their own row, plus a **deductible
  proportion** row showing how it moves — which is the point of the whole
  feature and invisible otherwise.
- **Focus → Debt recycling**: the recycled plan against the same plan
  without recycling. Show deductible interest, tax saved, investment balance
  and total debt for both arms, both run through `projectPlan` on clones per
  the Focus governing principle. Include the years-to-break-even figure,
  since the strategy costs money early and pays later.
- The equity Focus view (spec 13) gains a note where usable equity is being
  consumed by drawdowns, so the two views agree about how much room is left.

Tests: the table's deductible proportion matches the engine's; both Focus
arms reconcile to real projection runs; break-even matches the plotted
series.
Commit: `Debt recycling outputs and Focus view`

---

## Deferred — do not build
Interest capitalisation on investment loans (Part IVA territory — advisers
should not model it casually). Split facility as a distinct product type
beyond modelling it as a second loan. Offset-versus-redraw tax
differences. Line-of-credit products. Borrowing to contribute to super.
