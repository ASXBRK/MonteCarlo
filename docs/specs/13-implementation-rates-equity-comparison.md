# Implementation, Fixed Rates, Equity, and Comparison

Conventions per CLAUDE.md — including the conservation rule: any commit
introducing a new money flow extends `randomScenario()` and the invariant in
the same commit. **Six commits, gated.**

Derived from a second pass over the firm's workbook, covering sheets not
examined in the first review: `Input Page` (flow of initial funds and adviser
fee structure), `Debt Summary` (fixed rates and rollover), `Property Calcs`
(usable equity and sale), `Mud map` (banking structure) and
`Investment comparison`.

**Validation note worth recording:** the workbook's `Investment comparison`
sheet states the firm's return assumptions as Cash 3.5%, Defensive 4.5%,
Moderately Defensive 5.2%, Balanced 5.85%, Moderate Growth 6.85%, High
Growth 8.0%, Accelerated Growth 9.5%. `profiles.js` matches every one to the
basis point. The CMAs are confirmed as the firm's own.

---

## COMMIT 1 — Fixed-rate loans and rollover

The workbook's `Debt Summary` carries `Fixed?`, `Fixed date ending` and
`Date loan commenced` per loan. We model one rate for the life of the loan.
For Australian mortgages the fixed-rate rollover is the single most
significant scheduled event in a client's debt position, and it cannot
currently be modelled at all.

Liability gains:
```
rateType: "variable" | "fixed"        // default variable
fixedRatePct                           // when fixed
fixedUntil                             // DateRef — the rollover point
revertRatePct                          // default assumptions.mortgageRate
commencedOn                            // date; informational, drives nothing yet
```
- While fixed, interest accrues at `fixedRatePct`. From the rollover month,
  at `revertRatePct`.
- At rollover, **recompute the level repayment** over the remaining balance
  and remaining term. The step change in repayment is the point of the
  feature — do not smooth it.
- An extra repayment made during a fixed period is permitted here (break
  costs and fixed-period repayment caps are real but out of scope —
  disclose).
- The rollover is a **key date**, so it annotates table headers and charts
  automatically via the Tier 1.1 machinery, and the Period View can force
  its year to display.

Outputs: the Liabilities table gains a rate row showing the rate applying
each year; the rollover year is annotated; the Focus debt-payoff view shows
the repayment before and after.

Tests: interest accrues at the fixed rate up to the rollover month and the
revert rate after; the recomputed repayment matches a closed form over the
remaining balance and term; a rollover mid-projection produces the expected
step; variable loans are bit-identical to current behaviour.
Commit: `Fixed-rate loans and rollover`

---

## COMMIT 2 — Implementation: flow of initial funds and adviser fees

From `Input Page`. Two related things happen at implementation that we do
not model: starting cash is allocated, and an upfront adviser fee is paid —
possibly partly from super.

### Adviser fees
```
plan.adviserFees = {
  upfront: { total, fromSuperAmount, superAccountId },
  ongoing: { annualAmount, fromSuperAmount, superAccountId, indexBasis },
}
```
- The outside-super portion is a household cash outflow; the inside-super
  portion is debited from the nominated super account.
- **Inside-super fees are capped** by what that account can bear — the
  workbook tracks "maximum available fee inside super" against "desired
  total fee" and reports the "remaining difference". Reproduce that: show
  the cap, the requested amount, and any shortfall that must be paid
  personally.
- Upfront fees apply in the first month; ongoing fees monthly, indexed.
- Deductibility: financial advice fees are **not** modelled as deductible.
  The partial deductibility available for advice relating to existing
  investments is real but requires an apportionment we do not collect —
  disclose in the Parameters modal.
- Fees paid from super are **not** a benefit payment and are not assessable
  to the member; they reduce the interest proportionally (same treatment as
  the Division 293/296 release built in `cdeb76e`).

### Flow of initial funds
A reconciliation block, not a new source of truth. Assets already carry
opening balances; this shows how the client's starting cash gets there.
```
plan.implementation = {
  totalCashAvailable,                 // as stated by the client
  emergencyFundTarget,                // sets plan.workingCash.minimumBalance
  allocations: [ { label, amount, targetAssetId | "workingCash" | "goal:<id>" } ],
}
```
Display: total cash available, less upfront adviser fee, less each
allocation, equals residual. **Reconcile against the sum of entered opening
balances plus the working cash opening balance, and flag any difference.**
Do not silently overwrite entered balances — an adviser who has typed real
account balances should not have them replaced by an allocation model.

`emergencyFundTarget` writing through to `workingCash.minimumBalance` gives
the emergency fund a modelled consequence: deficit funding will not draw the
buffer below it, so a plan that would eat the emergency fund shows as
unfunded instead.

Tests: outside/inside split debits the right pockets; the inside-super cap
binds and reports the shortfall; the reconciliation flags a mismatch;
emergency fund target prevents the buffer being drawn down; conservation
invariant holds with fees present (fees are a leak, super-paid fees are a
leak from super).
Commit: `Adviser fees and flow of initial funds`

---

## COMMIT 3 — Usable equity and borrowing capacity

From `Property Calcs`. We model property purchases without ever asking
whether the client could borrow for them.

Per property: `usable equity = value × equityCeiling − (loan balance −
offset balance)`, with `equityCeiling` configurable, default 80%.
Aggregate across all properties = total available equity, per year.

Two uses:
1. A **Focus view** showing usable equity by property and in total over the
   projection, so "when could we release equity for a deposit" is visible.
2. A **check on planned purchases**: where a purchase's deposit is intended
   to come from equity, flag when available equity at the purchase date is
   insufficient. Add an optional `depositFromEquity` flag and source
   property on planned purchases.

**Be explicit about what this is not.** Usable equity is a security
constraint, not a serviceability assessment — a bank also tests income
against the loan. State this on the view and in the modal; the tool must not
imply a purchase is approvable.

Tests: usable equity matches a hand calculation including offset; aggregates
correctly across properties; the insufficient-equity flag fires at the right
year; the ceiling is configurable.
Commit: `Usable equity and borrowing capacity`

---

## COMMIT 4 — Where the money went

The most persuasive single output available for an accumulator, and nothing
in Xtools does it.

Cumulative decomposition of the change in net worth from projection start to
any year:
```
opening net worth
  + cumulative income received
  + cumulative investment growth (assets, super, property)
  − cumulative tax paid (income, CGT, contributions tax, Div 293/296, HELP)
  − cumulative expenses
  − cumulative interest paid
  − cumulative fees (ICR, adviser)
  ± cumulative one-offs and goals spent
= closing net worth
```
Requires new cumulative fields on the yearly ledger — derive them from
existing per-year figures rather than re-deriving from the monthly loop.

Presented as a **waterfall chart** (Graphs → Where the money went) and a
table. The point it makes: for a long accumulation, investment growth
eventually exceeds cumulative contributions, and the year that happens is
worth annotating.

**The decomposition must reconcile exactly** to closing net worth for every
year — that is the same discipline as the conservation invariant, so assert
it as a test over randomised scenarios rather than a single case.

Commit: `Where the money went: net worth decomposition`

---

## COMMIT 5 — Fortnightly transfer schedule

The firm builds a banking-structure "mud map" separately. This does not
build it; it produces the numbers to copy into it.

Focus → Transfer schedule. For a selected plan year (default: the first full
year):
- **Sources**: each income row, net of PAYG — i.e. take-home pay per source —
  plus rental income and any other inflow, expressed **per fortnight**
  (annual ÷ 26), per person where owned.
- **Destinations**: each expense category, each loan repayment, each super
  contribution, each goal accrual, and the residual to savings — also per
  fortnight.
- An **initial transfer** column, populated from the implementation
  allocations in Commit 2.
- Totals reconcile: sources = destinations + residual.

Display fortnightly by default with monthly and annual toggles, since the
workbook works in `p.f` but some clients are paid monthly. CSV and
paste-into-Word HTML export, because copying is the entire purpose.

Tests: fortnightly figures are the annual ledger ÷ 26; sources reconcile to
destinations plus residual; take-home pay matches the Cashflow table's
figure.
Commit: `Fortnightly transfer schedule`

---

## COMMIT 6 — Scenario comparison

Current versus proposed is the core advice narrative, and the document
compares three scenarios across five snapshots.

**Current is simply another scenario** — no new data model. Focus →
Compare scenarios: pick two or three scenarios belonging to the active
client and show:
- **Net assets over time**, one line per scenario, age axis, legend by
  scenario name, with the deterministic projections only (Monte Carlo
  comparison is deferred).
- **Key figures side by side** at a selected year: the Key figures rows, one
  column per scenario, plus a delta column against the first-listed
  scenario.
- **Snapshot rows side by side** in the firm's vocabulary at a selected
  year — this is the document's comparison table.

Constraints and honesty:
- Scenarios must belong to the same client; disable cross-client comparison.
- Scenarios with different plan windows (different current age, start date
  or end age) cannot be meaningfully compared on an age axis — detect and
  refuse with a clear message rather than aligning them approximately.
- Note on screen that scenarios are independent copies, so client facts
  entered in one are not reflected in another.

Export: CSV and paste-into-Word HTML of the side-by-side tables.

Tests: each scenario's column equals that scenario's own Key figures view;
deltas compute against the correct base; mismatched plan windows are
refused; cross-client selection is impossible.
Commit: `Scenario comparison`

---

## Deferred — do not build
The banking-structure diagram itself (produced separately; Commit 5 feeds
it). Property sale with CGT. School fees as a distinct input shape. Bonus
and allowance income as distinct types. Income-interruption modelling.
Fixed-rate break costs and fixed-period repayment caps. Serviceability
assessment. Monte Carlo scenario comparison. A shared client-facts model
underlying scenarios.
