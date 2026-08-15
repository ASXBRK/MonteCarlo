# Build Log — Projection Tool (Xtools+ replacement)

Repo `ASXBRK/MonteCarlo`, branch `claude/monte-carlo-investment-app-R9XSB`.
Updated stock-take. Branch head at time of writing: `be278ca`.

---

## STATUS

### Landed

**Foundation (Phases A–C, Tier 0)** — multi-asset input model; plan-level
cashflows; household/couple; FY anchoring with partial first year;
client/scenario pages with hash routing and JSON export/import; deterministic
monthly engine; full personal tax (brackets, Medicare, LITO, franking, both
CGT regimes with pooled cost bases and the 1 Jul 2027 reset); transposed
multi-view output; in-grid one-off editing; sidebar one-section-per-page
navigation; Graphs/Tables split; composite Cashflow-Assets-Liabilities chart
with shared-zero dual axes.

**Assets and structures (D1–D4)** — identity intake with DOB/sex and ABS
life-expectancy anchoring; AWOTE indexation model; financial vs lifestyle
asset classes; liabilities with amortisation, offsets and deductible
interest; property including planned purchases, stamp duty across eight
jurisdictions, FHOG and post-2027 gearing rules.

**Tier 1.1 — Key Dates** — named anchors (Start, End, Retirement, custom)
referenced by every date field; verified as pure indirection (byte-identical
to equivalent explicit ages).

**Tier 1.2 — Super accumulation** — accounts with tax components; SG derived
from employment income; salary sacrifice, personal deductible/non-deductible,
spouse; concessional cap with five-year carry-forward and the prior-30-June
TSB gate; NCC with bring-forward tiers; contributions tax; Division 293;
preservation, release conditions, proportioning.

**Working Cash Account** — household cashflow buffer with FY-end sweep,
replacing monthly surplus destruction. Fixed a second latent bug found during
implementation (unfunded cashflow re-recording cumulatively).

**Output additions** — liabilities table and chart; cashflow bars chart; key
figures table; projection chart moved to annual points on an age axis.

**Document Set (docs/specs/11-document-set.md)** — gap-filling commits found
by the workbook document-sense-check:
- Commit 1, **HELP repayments** (`1f3a5eb`) — FY-keyed bracket table with the
  $186,052 whole-income cliff; per-person `helpBalance`; repayment income =
  taxable income + reportable super contributions (SS+PD, not SG) + net
  investment loss; folded into PAYG withholding/refund settlement.
- Commit 2, **Medicare Levy Surcharge** (`afbfdec`) — single/family band
  tables (AWOTE-indexed), +$1,500/child-after-first family threshold step;
  reuses HELP's repayment-income figure; `privateHospitalCover` (per person)
  and `dependentChildren` (household) inputs. Also fixed a latent bug: the
  Setup plan-bar's commit handler dropped `workingCash` from the next plan
  object, silently resetting the WCA to defaults on every Setup edit.
- Commit 3, **FHSSS** — new `src/fhsss.js` (annual $15,000/lifetime $50,000
  combined cap acceptance, 85%/100% release split); `fhsssEligible` flag per
  voluntary super contribution row (SG/spouse always excluded); the taxable
  release (85% of eligible concessional + all associated earnings) taxed at
  MTR less a 30% offset via a new `assessPerson` parameter, mirroring the
  existing excess-concessional-contributions offset shape; a planned PPR
  purchase's "Release FHSSS at purchase" toggle credits the gross release
  against settlement cash, with the tax settling through the normal FY
  assessment/PAYG-refund mechanism rather than netted at settlement.
  `assumptions.fhsssEarningsRate` (indicative ATO shortfall interest rate,
  needs confirming — see Open Items).
- Commit 4, **LMI and First Home Guarantee** — new `src/data/lmiRates.js`
  (indicative LVR × loan-size premium table, applies above 80% LVR) and
  `src/data/fhbgCaps.js` (indicative per-state price caps, flagged not
  blocked when exceeded); both need firm confirmation — see Open Items.
  Per-purchase `lmiOverride` (nominal $, same precedence as `dutyOverride`),
  `lmiPayAtSettlement` (default false = capitalised into the loan
  drawdown), and `firstHomeGuarantee` (waives LMI; forced off unless
  `firstHomeBuyer` and a planned purchase).
- Commit 5, **Extra and one-off loan repayments** — per liability, a
  repeatable `extraRepayments` list (amount/frequency/DateRef/indexation)
  and a `oneOffRepayments` list (amount/DateRef); both reduce principal the
  same month, through the same WCA/deficit-funding/unfunded cascade the
  scheduled repayment already uses (an unaffordable plan surfaces as
  unfunded, not silently skipped). New `scheduledAmortisation` in
  `liabilities.js` computes the no-extras baseline; the Liabilities table
  reports interest/time saved once a loan with extras is fully repaid
  within the projection.
- Commit 6, **Goals** — `state.goals` (per goal: label, targetAmount,
  targetAt, fundedFrom [assetId | "surplus"], indexation), a new input
  page. Accrues straight-line from plan start to the (indexed) target
  month; asset-funded draws via the same `sell()` every asset-affecting
  cashflow uses (naturally capped at the asset's balance); surplus-funded
  is capped at whatever's actually left over each month (a discretionary
  contribution can't manufacture cash, unlike an instructed transaction —
  no "unfunded" cascade, the shortfall reduces the goal's own accrual
  instead). "Spent at the target date" = the accrual itself, no separate
  goal-balance ledger. Reports achieved/shortfall + an extrapolated
  alternative date; own group in the Cashflow table; dated markers on
  the composite chart.
- Commit 7, **Snapshot view and Word-ready export** — `cashflowStatement.js`
  gained a per-owner `forOwner` breakdown (Client/Partner/Total; jointly-owned
  items split 50/50, income/expense/deduction rows attribute exactly since
  they're never joint) alongside the existing household total, so a new
  `src/snapshot.js` (`buildSnapshotColumns`/`buildSnapshotTable`) reuses it
  directly — a Snapshot column reconciles to the Cashflow table by
  construction, not a second computation. New Snapshot table (Tables), up to
  six DateRef-selected years (default: current, retirement, four spread),
  persisted per scenario (`display.snapshotYears`). "Copy for Word" (HTML
  clipboard) and Export CSV both reuse the same hideEmptyRows-filtered table
  — explicitly no .docx generation, per the spec.

Roughly 653 tests, clean build. **All seven Document Set commits
(docs/specs/11-document-set.md) are now landed.**

**Conservation invariant coverage** — `randomScenario()` extended to
generate every Document Set money flow (goals, FHSSS + a paired planned
property, extra/one-off loan repayments, LMI with/without FHBG, HELP/MLS-
triggering incomes) and `conservationCheck.js` extended with a named term
for each, including an explicit net-to-zero assertion for the FHSSS
transfer. Found and fixed a genuine money-creation bug in the process: the
FHSSS release call site discarded `withdrawFromSuper`'s return value, so
settlement cash could be credited more than the super account actually
gave up.

**HELP as a liability** — a HELP/HECS balance was tracked and repaid
correctly but invisible to net worth: `helpBal` never joined
`liabilitiesClosing`, so a client with a $60,000 balance and one with none
reported identical `netAssets`. Folded into `row.liabilities` (the same
map ordinary loans use) so it's covered by the Liabilities table/chart and
netAssets for free, plus genuine annual indexation at the lower of CPI and
AWOTE (AWOTE proxying WPI, the post-1 June 2023 "lesser of" legislative
basis — confirm against the firm reference). Input moved from Setup into
its own block in the Liabilities section (Xplan's own structure: no
interest rate, term or repayment schedule, so a Liability object's field
set didn't fit). Fixed a related latent double-count: HELP's compulsory
repayment is already reported per-owner via `taxSums()`'s `helpRepayment`
figure, so `cashflowStatement.js`'s generic per-liability expense loop
would have counted it a second time as "Other Loan Repayments" — excluded
explicitly (`isHelpLiability`), with a regression test proving the bug
would have broken the Client + Partner = Total identity.

**Focus views (docs/specs/12-focus-views.md)** — one question, one page,
read from the same `projectPlan()` output every other view reads, never a
separate calculation.
- Commit 1, **scaffold and solver** — `src/solve.js`'s `bisectScalar`
  (monotonic-direction inferred from the two endpoints, non-monotonicity
  detected and reported rather than silently narrowed on) and `solveFor`
  (clones the plan, applies one of three named vary targets, re-validates
  via `clampAllToPlan`, runs the real engine). Third sidebar group
  (Graphs · Tables · Focus) with five empty-state views, each with a
  direct link to the input section it needs.
- Commit 2, **Deposit & home purchase** — `src/focusDeposit.js`. Target
  price/growth/purchase date, required-at-settlement breakdown (deposit,
  duty, LMI or the FHBG waiver, costs, less FHOG — new `deposit`/`duty`/
  `costs`/`fhog` fields on `row.properties[pid]`, exposing figures the
  purchase-event block already computes), an accumulating-funds-vs-
  required chart, and an on-track/shortfall answer keyed to the engine's
  own cumulative `unfundedCashflow` — not a separate arithmetic
  threshold. Two solver actions ("What would I need to save?" / "When
  could I buy?") via a new `findMinimumFunded` search (binary search for
  the SMALLEST/EARLIEST value at which cumulative unfunded cashflow
  drops to zero — deliberately not `solveFor`/`bisectScalar`, since
  "funded" floors at exactly zero and stays there, a plateau rather than
  a single root, which an equation solver would land on arbitrarily
  rather than at the minimum). Caught a genuine bug in its own build:
  an earlier metric that only checked "opening balance vs. required
  settlement cash" could converge on an amount that funded the deposit
  but left the new loan's own first-year repayments unfunded — fixed by
  switching both solvers to the engine's actual `unfundedCashflow`
  ground truth, with a regression test.
- Commit 3, **First Home Super Saver** — `src/focusFhsss.js`. The
  engine tracked FHSSS running balances (`fhsssBal`) purely internally;
  a new `row.fhsssDetail[person]` (contribution accepted/rejected,
  associated earnings accrued, running concessional/non-concessional/
  earnings balance, lifetime contributed) exposes the same accrual step
  already computed each year, and `row.taxDetail[person]` gained
  `fhsssTaxableComponent`/`fhsssTaxFreeComponent` alongside the existing
  gross release/offset. Cap headroom (annual $15,000, lifetime $50,000)
  is derived from that exposure against the fhsss.js constants — the
  engine itself has no headroom concept, only acceptance/rejection.
  "Eligible release" reuses `fhsssReleaseAmounts()` directly (never
  reimplemented) against the latest tracked balance when no release has
  fired yet. The comparison that justifies the strategy — the same
  dollars inside FHSSS versus saved outside super — runs a second real
  `projectPlan()` on a clone that redirects the eligible contribution
  rows into an ordinary asset using the linked super account's own
  allocation (isolating the tax-wrapper difference from the investment
  mix), per the spec's explicit requirement not to hand-roll either arm.
- Commit 4, **Salary sacrifice** — `src/focusSalarySacrifice.js`. Both
  arms from a real `projectPlan()` run: "without" is the same plan with
  the sacrifice row deleted outright — no redirection needed, unlike
  FHSSS's comparison, since the extra take-home pay just flows through
  the household's own existing surplus handling. Per year: income tax
  saved, HELP repayment shown explicitly unchanged across both arms
  (the single most commonly misunderstood interaction), Division 293
  triggered/increased, super gained net of the 15% contributions tax,
  household cash reduced (financial assets AND the Working Cash
  Account — a household on "accumulate" never invests surplus into a
  named asset at all), and net position charted over time. Amount is
  adjustable live in the view as a what-if (not an edit to the real
  row); cap headroom reuses the input panel's own
  `superCapHeadroomHTML` display verbatim, per the spec's explicit
  instruction not to re-derive it.
- Commit 5, **Debt payoff** — `src/focusDebtPayoff.js`. Payoff date and
  lifetime interest work for ANY loan (summed straight off
  `row.liabilities[id]`, no dependency on extras being configured); the
  effect of extra repayments is the engine's own
  `liabilityRepaymentStats`, read through unchanged, `null` (not zero)
  when no extras are configured. The balance-over-time chart runs a
  second real `projectPlan()` on a clone with the loan's own
  `extraRepayments`/`oneOffRepayments` stripped — `scheduledAmortisation`
  only returns summary figures, not a series, so this is a genuine
  counterfactual run rather than a re-derivation. Solver ("What extra
  repayment clears this by [date]?") generalised the deposit view's own
  plateau-search into a shared `findMinimumThreshold` (`solve.js`) —
  a loan's payoff year plateaus at the earliest sufficient extra
  repayment exactly the way cumulative unfunded cashflow does, the same
  reason `solveFor`/`bisectScalar` don't fit. Affordability is checked
  and surfaced separately from convergence: a mathematically sufficient
  extra repayment the household can't fund reports `unfunded > 0`
  rather than a clean "apply this" success. Also closed a scaffold gap
  from Commits 2–4: the sidebar's Export button was wired for every
  other view but not one Focus view — added a CSV export (flat
  section/item/value rows, not the year-columns ledger shape) for all
  four Focus views built so far.

- Commit 6, **Standalone lookups** — `src/focusLookups.js`. The one
  deliberate exception to the governing principle: a lookup, not a
  projection, so it takes no plan/scenario input at all — just state,
  price, FHB/new-build/FHBG flags and an LVR. Calls the SAME functions
  the purchase engine calls (`dutyWithConcessions`, `fhogAmount`,
  `lmiPremium`, `fhbgPriceCapExceeded`), no new rate data; reconciled
  against a real `projectPlan()` run with a property purchasing at
  month 0 (nominal price = today's price exactly at that point,
  regardless of growth/CPI) per the spec's own test requirement. As-at
  dates and verification caveats from each data module's own metadata
  are shown directly in the view, not summarised away.

**Deposit solver: whole-of-projection affordability** — Focus Commit
2's own fix (settlement-year-scoped `cumulativeUnfundedThroughYear`, to
close the "deposit funded but the new loan's first-year repayments
aren't" bug) reintroduced the same class of error one step later: a
metric scoped to the purchase year is still blind to a loan that clears
settlement and then becomes unaffordable to service in year three, five,
or any year after. `solveWhenCouldIBuy` could report a fully "achieved"
date on a mortgage that, once drawn down, produced six figures of
unfunded cashflow for the rest of the projection — it was checking
"did this settle", not "does the plan work". Both solvers now target a
NEW `cumulativeUnfundedWhole` (sum through the LAST projected year, not
the purchase year) as the primary metric, via a shared
`solveWithAffordabilitySplit`. Where nothing in range clears that bar, a
second pass against the old settlement-only metric distinguishes WHY —
`"settlement-unaffordable"` (the deposit itself is never raised) from
`"servicing-unaffordable"` (settlement clears somewhere, but the
resulting loan is never serviceable) — because they call for opposite
advice: save more / wait, versus this property isn't affordable
regardless of timing. The settlement-only figure survives as
`earliestSettleable`, reported as clearly-labelled CONTEXT alongside the
`servicing-unaffordable` result, never as the answer itself (no apply
button — it isn't one). `buildDepositFocus`'s own `answer.onTrack` gained
the same two-reason split, so a property that settles but never
services reads as "cannot afford this purchase" with the servicing
shortfall, not as a shortfall-by-date the client just hasn't reached yet.

**Implementation, Fixed Rates, Equity, and Comparison
(docs/specs/13-implementation-rates-equity-comparison.md)**
- Commit 1, **Fixed-rate loans and rollover** — a liability gains
  `rateType`/`fixedRatePct`/`fixedUntil`/`revertRatePct`/`commencedOn`.
  Interest accrues at `fixedRatePct` until the rollover month (resolved
  via the SAME "fires in July of the resolved plan year" convention
  every other one-off plan event uses), `revertRatePct` after (null =
  falls back to `assumptions.mortgageRate`, the same override-or-default
  shape as `dutyOverride`/`lmiOverride`). The level repayment recomputes
  EXACTLY ONCE, at the later of rollover or IO-end, over the loan's
  actual balance and remaining term at that point — held fixed
  afterward, deliberately not smoothed. The recomputed payment
  (`postRolloverPmt`) is path-dependent (balance-at-trigger), so it gets
  the SAME measurement/real-pass snapshot-and-restore treatment as
  `loanBal` itself. `scheduledAmortisation`'s own "no extras" baseline
  (Document Set Commit 5's interest-saved comparison) now rolls over
  too, or a fixed-then-reverting loan WITH extras would misattribute
  the rate switch's own effect to the extras. New `out.liabilityRollovers`
  gives the Liabilities table's new rate row, the rollover's forced
  annotation on tables/the Liabilities chart (same `forcedYearIndices`
  mechanism a planned property's purchase date already uses), and the
  Focus debt-payoff view's before/after figures — all read straight
  through, never recomputed. Verified (not assumed) that this needs NO
  new conservation-invariant term: `randomScenario()` now generates
  fixed-rate liabilities with a rollover before/during/after the
  projection, and the existing `liabilityInterest`/`liabilityRevaluation`
  terms held across thousands of randomised runs — documented in
  `conservationCheck.js` itself.
- Commit 2, **Adviser fees and flow of initial funds** —
  `plan.adviserFees` (upfront once at plan start, ongoing every year,
  indexed; each split outside/inside super) and `plan.implementation`
  (a reconciliation block, not a new source of truth: total cash
  available less the upfront fee less each allocation equals residual,
  cross-checked against entered opening balances and flagged, never
  overwritten, on mismatch). Inside-super fees are a direct balance
  debit via `withdrawFromSuper` — the SAME mechanic and reasoning as
  the Division 293/296 release (not a benefit payment, no preservation
  gate, applied before that period's growth so growth compounds on the
  post-fee balance). `emergencyFundTarget` writes through to
  `workingCash.minimumBalance` once it's actually set, giving the
  emergency fund a modelled consequence, without clobbering a
  manually-entered minimum on a household that's never touched
  Implementation. Not modelled as deductible (disclosed in the
  Parameters modal — the partial deductibility for advice on existing
  investments needs an apportionment this build doesn't collect).
  **A fourth conservation-invariant bug found via `randomScenario()`**
  (not the reported one, but the SAME class): adviser fees, Division
  293/296, and FHSSS each independently capped their own release
  against a super account's raw balance, so two mechanisms sharing an
  account in the same year could each believe they alone could take
  the full amount and together debit more than the account ever
  held — closed by a new `reserveFromSuper`, which resolves every
  same-year claim on an account in a fixed order (adviser fees, then
  Division 293/296, then FHSSS — matching the order they actually debit)
  against what's genuinely left after the earlier ones, not the raw
  balance. Per CLAUDE.md's rule, the whole class was closed in this
  commit, not just the adviser-fee instance that surfaced it.

### In flight
Spec 13 Commits 3–6 (usable equity,
net worth decomposition, fortnightly transfer schedule, scenario
comparison); super threshold
indexation per figure (AWOTE / CPI / unindexed, with nominal rounding),
then Division 296, then Monte Carlo over the full scenario.

### BLOCKING — not landed
**Super contributions create money.** Personal deductible and salary
sacrifice contributions are credited to super and deducted from taxable
income but never debited from household cash; the working cash account is
only credited with the tax saving. A $20k/year contribution leaves the client
with more super, less tax *and* more cash. This flatters every
salary-sacrifice comparison — the exact question super was built to answer.
Prompt written; must land before Monte Carlo.

---

## THE REAL RISK

Two serious engine defects have been found in this build. Both destroyed or
created money. Both were found by **using the tool and looking at output** —
neither was caught by the test suite, which was green throughout.

- **WCA timing** — annual income spent the month it arrived, so eleven months
  of every year ran deficits funded by selling assets. A client with a
  $16.5k annual surplus was shown running out of money.
- **Super contributions** — funded from nowhere (above).

The suite tests components well and behaviour poorly. Both bugs violated the
same principle and neither had a test that could see it: **money must be
conserved**. Every dollar leaving one place must arrive somewhere or be
explicitly recorded as leaving the model.

### Proposed: a conservation pass before Monte Carlo

1. **Money-conservation invariant.** For every plan year, assert:
   `Δ(all asset balances + super + WCA − liabilities)
    = income − expenses − tax − contributions-tax − fees
      + growth ± external one-offs − unfunded`
   with an explicit, named term for every legitimate leak (surplus spent,
   one-off amounts leaving the model, unfunded cashflow). Anything
   unaccounted for fails.
2. **Run it over randomised scenarios** — property-test style, a few hundred
   generated combinations of income/expenses/assets/super/liabilities/
   property/purchases. This is what would have caught both bugs on the day
   they were written.
3. **Golden scenarios** — five to eight fixed cases with externally verified
   expectations: income tax against the ATO calculator, amortisation against
   a bank calculator, SG and salary sacrifice against MoneySmart, stamp duty
   against the state revenue office. Committed as tests with the source and
   date in comments.

Monte Carlo makes this urgent rather than merely wise: a simulation runs the
engine 2,000 times and presents the result as a probability distribution.
Any engine defect acquires the authority of a fan chart.

---

## WHERE WE'RE GOING

### Next (in order)
1. **Super contribution fix** — blocking, prompt written.
2. **Conservation pass** — invariant + randomised scenarios + golden cases.
3. **Super threshold indexation + Division 296** — in flight.
4. **Monte Carlo** — engine, fan chart, percentile table. Closes the
   cross-asset correlation question with a single shared market factor
   (ρ default 0.85) plus the original regime switching.

### Then — completing the accumulator story
5. **HECS-HELP** — near-universal in the target cohort; changes cashflow and
   the effective marginal rate every salary-sacrifice comparison depends on.
6. **Extra and lump-sum loan repayments** — core debt strategy, currently
   absent.
7. **FHSSS** — unblocked by super; pairs with the property purchase engine
   already built.
8. **Drawdown / goal-seek solver** — sustainable spend to life expectancy,
   required contribution to hit a target. Xtools has no solver ("no magic
   button"); our sub-millisecond engine makes it trivial. Still the clearest
   capability advantage available.

### Then — cashflow intelligence (from the Xtools research)
9. Surplus allocation as a percentage split with **pay non-deductible debt
   first** and interest-rate ordering.
10. Deficit funding with **minimum balance per asset** and optional
    **minimum-capital-gain** sell-down ordering.
11. **Adjustment rows** on tax and cashflow tables — the escape hatch that
    makes an imperfect engine usable.
12. **Goals** as a distinct expense category.
13. Loan **drawdowns** (redraw, equity release, debt recycling).

### Then — advice workflow
14. **Scenario compare** overlay, launched from the client page.
15. Scenario **templates** and **locking** (locking has a compliance
    rationale: point-in-time evidence).
16. Insight modules reworked against the new per-path output (they cannot be
    re-enabled as-is — they read a data shape that no longer exists).
17. Asset allocation over time — blocked on asset-class splits for the firm
    profiles. **Outstanding data ask.**

### Later
Pension phase and TTR; Centrelink; aged care.

### Parked (deliberate, ~1 client in 1000)
SMSF; trusts, companies and other entities; insurance modelling (premiums
already work as expenses); investment bonds; death benefits; defined benefit;
Word merge to firm templates.

---

## OPEN ITEMS NEEDING YOU

- **Asset-class splits** for the firm's risk profiles — blocks the allocation
  chart and improves Monte Carlo correlation realism.
- **Confirm the seven non-WA stamp duty schedules** against revenue offices,
  or continue relying on the per-purchase override.
- **Mortgage rate and term defaults** (currently 6.0% nominal, 30-year P&I)
  — these silently shape every first-home scenario.
- **Div 296 threshold indexation basis** — confirm against the firm
  reference before it is implemented.
- **A real client scenario, run end to end**, once the contribution fix
  lands. Manual testing has found more than the test suite has.
- **FHSSS associated earnings rate** (currently 7.94% nominal, an
  indicative ATO shortfall interest rate) — confirm against the firm's
  reference figures; it's user-adjustable in the meantime (Parameters
  modal / Assumptions view).
- **LMI premium table and FHBG price caps** (`src/data/lmiRates.js`,
  `src/data/fhbgCaps.js`) — both indicative, built from the general shape
  of published figures rather than a live rate card; per-purchase LMI
  override exists as the precision escape hatch in the meantime.
- **HELP/HECS balance indexation basis** — this build indexes the balance
  annually at the lower of CPI and AWOTE (AWOTE proxying WPI, the post-1
  June 2023 "lesser of CPI or WPI" legislative basis). Confirm against the
  firm reference before relying on this for advice.
