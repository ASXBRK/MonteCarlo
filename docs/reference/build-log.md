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
- Commit 3, **Usable equity and borrowing capacity** — per property,
  `usableEquity = value × equityCeilingPct − (linked loan closing −
  offset applied)`, floored at 0 (a capacity, not a signed balance).
  A property's "linked loan" is either the D4-derived purchase loan OR
  any user-entered liability the adviser has explicitly linked via
  `linkedAssetId` — both are real, already-tracked liabilities, netted
  together. No new money flow (a read-only, derived security-constraint
  figure, never a projection input), so no conservation-invariant
  change. New `depositFromEquity`/`depositFromEquitySourcePropertyId`
  on a planned purchase (validated in two stages — self-reference and
  stale ids both fall back to off/null, the same pattern
  `plan.implementation`'s own cross-referencing fields use) flags, at
  the purchase year, when the source property's usable equity falls
  short of the deposit this purchase actually needs
  (`row.properties[pid].deposit`, Focus Commit 2's own field, never
  re-derived) — a flag, never a block; the purchase still completes
  through the ordinary funding order regardless. New Focus view (usable
  equity by property and in total, over the projection) carries the
  spec's own "be explicit about what this is not" disclosure
  prominently, not buried: a security constraint, not a serviceability
  assessment.
- Commit 4, **Where the money went: net worth decomposition** —
  `conservationCheck.js`'s `checkYearConservation` refactored into a
  pure `computeYearFlows(out, y)` (every named term, unchanged
  behaviour — bit-identical, re-verified against the full suite and the
  invariant's own randomised stress test) plus a new
  `decomposeNetWorthChange(out, y)` that regroups those same terms into
  the spec's 7 waterfall buckets (income, growth, tax, expenses,
  interest, fees, oneOffs), with the FHSSS transfer folded into oneOffs
  rather than dropped so the decomposition reconciles to closing net
  worth EXACTLY, not just within the invariant's own tolerance. The
  single scaffolding term `propertyAcquisitionCosts` splits into
  `propertyOneOffCost` (duty+costs−FHOG, zero outside a purchase year)
  and `propertyGrowth` (the residual — organic growth of already-owned
  properties) — the two still sum to exactly what they replaced.
  `deterministic.js` runs this in a post-pass (a pure read of
  already-computed per-year figures, no new money flow, so no
  conservation-invariant change) to populate `row.decomposition` (this
  year's own bucket increments) and `row.cumulativeDecomposition`
  (running totals since projection start) on every yearly row, plus a
  top-level `wealthCrossoverYear` — the first year cumulative investment
  growth overtakes cumulative income, per the spec's own "point" this
  view exists to show. New Graphs view (**Where the money went**): a
  waterfall chart (opening net worth → cumulative buckets → closing net
  worth) for a selectable year, plus a transposed table of both the
  per-year walk and the cumulative totals, CSV export. Tested with a
  known-value growth-only fixture, a crossover-annotation fixture, and —
  per CLAUDE.md's rule for a decomposition of this kind — a dedicated
  test asserting exact reconciliation to closing net worth across
  `randomScenario()`-generated scenarios (not a single case).
- Commit 5, **Fortnightly transfer schedule** — new `src/focusTransferSchedule.js`,
  pure. For a selected plan year (default: the first FULL year —
  `monthsInFirstYear(plan.start) === 12`, else year 1), Sources lists
  every income cashflow row take-home plus every investment property's
  rent; Destinations lists every expense row, every non-HELP liability's
  repayment, every super account's personal (non-sacrifice) contribution,
  every goal's accrual, adviser fees paid from cash, and a settling
  property's own cash contribution. "Net of PAYG" mirrors
  `cashflowStatement.js`'s `cashReceivedSums` exactly — only the
  "salary" category is withheld at all in this model, and a person's
  PAYG is spread across THEIR OWN salary rows proportionally by gross
  share, one level deeper than the Cashflow table's own household
  total — verified to sum back to that exact figure. HELP/HECS never
  appears as a destination (already withheld via PAYG, never a
  household-initiated transfer), and neither does salary sacrifice (a
  payroll deduction before the money is "received", already its own
  line in the Cashflow table). Residual to savings = sources −
  destinations. No new money flow (a pure regrouping of already-taxed,
  already-computed engine figures), so no conservation-invariant
  change. New Focus view (**Transfer schedule**): fortnightly by
  default with monthly/annual toggle, a year selector, an Initial
  transfer section straight from Commit 2's implementation allocations
  (a one-off, never converted to a rate), CSV and "Copy for Word"
  clipboard export (same `ClipboardItem` pattern as the Snapshot view's
  own Word export). Tested: fortnightly/monthly = annual ÷ 26 / ÷ 12;
  a two-salary-row household's summed take-home matches the Cashflow
  table's own `regularTakeHomePay` exactly, with the PAYG split
  correctly proportional to each row's gross share; sources reconcile
  to destinations plus residual; HELP is never a destination; loan/
  super/goal rows each surface correctly; the initial transfer column
  is read straight from `plan.implementation`, never re-derived.
- Commit 6, **Scenario comparison** — new `src/scenarioComparison.js`,
  pure (`planWindowsMatch`, `keyFigureValuesAtYear`,
  `keyFigureComparisonRows`). "Current is simply another scenario — no
  new data model": every compared scenario is a full, independent
  `projectPlan()` run — the active one reuses the SAME `state`/
  `projection` every other view already reads, every other scenario is
  loaded straight from storage via the same `hydrate()` path
  `loadActiveState()` itself uses. `buildKeyFiguresGroups`/
  `incomeCategorySums`/`expenseCategorySums` (main.js) all gained an
  optional `{state, projection}` ctx, defaulting to the active
  workspace's own globals — backward compatible with every existing
  call site — specifically so a comparison column reuses the EXACT SAME
  row definitions the Key figures table itself uses, never a second,
  driftable copy. New Focus view (**Compare scenarios**): pick 2-3 of
  the active client's own scenarios (checkboxes, order = delta base
  order); mismatched plan windows (current age, start date, or end age)
  are refused with a clear message naming which scenarios differ,
  never approximated to fit; matching windows show Net assets over time
  (one line per scenario, age axis, each scenario's OWN CPI driving its
  own nominal conversion), Key figures side by side + a delta column
  per non-base scenario against the first-listed, and Snapshot rows
  side by side at a selected year (household total only — a disclosed
  simplification, since scenarios can differ in household composition
  and each scenario's own Snapshot view still has the full Client/
  Partner split). CSV and "Copy for Word" export (the Snapshot half
  reuses `snapshot.js`'s own `snapshotToHTML`/`snapshotToCSV`
  unchanged, columns relabelled scenario names instead of years). No
  new money flow, so no conservation-invariant change. Tested: each
  scenario's own values pass through unchanged; deltas compute against
  the first-listed scenario specifically (never adjacent pairs); a row
  present in only some scenarios (e.g. HELP balance) never misaligns,
  matched by label not index; mismatched windows refused; cross-client
  scenario ids are structurally impossible to select (the picker only
  ever lists the active client's own scenarios).

This closes all six commits of docs/specs/13-implementation-rates-equity-comparison.md.

- Commit 1 of docs/specs/14-what-if.md, **What if: group scaffold, shock
  runner, Monte Carlo relocation** — new `src/whatIf.js` (pure):
  `runShock(state, shock)` clones the caller's state via
  `structuredClone` (never mutating it — asserted directly in tests via
  a before/after JSON snapshot), applies the shock to the clone only,
  and runs `projectPlan()` on both the untouched original and the
  modified clone. Shock kinds self-register via `registerShockKind`
  rather than growing one switch statement across five commits — each
  later commit registers its own kind at the module that owns its
  logic. `buildDeltas(base, shocked)` — exported and tested
  independently of any shock kind — is "the delta shape" itself: per
  plan year, the shocked-minus-base change in net assets, closing
  balance, tax, surplus, and unfunded cashflow, plus headline figures
  (end net assets, first shortfall age, total unfunded) for BOTH runs,
  since a shock "introducing unfunded cashflow where there was none" is
  itself often the headline the two-runs-plus-delta framing exists to
  show. New **What if** sidebar/output group (Graphs, Tables, Focus,
  What if): the organising distinction is Focus answers "what if I did
  something different" (levers the client controls), What if answers
  "what if the world is different" (things they don't control). Monte
  Carlo relocated here unchanged — the fan chart out of Graphs, the
  percentile table out of Tables, same ids, same render functions, same
  behaviour, only the sidebar grouping and labels moved (disambiguated
  as "Monte Carlo (fan chart)"/"Monte Carlo (percentile table)" now
  that both sit under one group instead of two). Output view ids stay
  flat (router.js's own documented convention) — no nested route
  segment, matching how Focus was actually built despite its own spec
  prose describing a "Focus → " path.
- Commit 2 of docs/specs/14-what-if.md, **What if: interest rate
  shocks** — two shock kinds self-registered into `whatIf.js`:
  `rateShock` (moves a VARIABLE loan's rate immediately; moves only a
  FIXED loan's REVERT rate, leaving its contracted rate untouched until
  its own rollover — no engine change needed, since deterministic.js
  already switches a fixed loan's rate at its own rolloverMonth,
  Implementation/Rates spec Commit 1, and both shocks just move the
  input fields that switch already reads) and `revertRateShock` (the
  same revert-rate move alone, leaving variable loans and the current
  fixed rate completely untouched — "what if you roll off into 8%
  instead of 6.5%"). `revertRatePct`'s null-means-assumptions-default
  is resolved to a concrete number BEFORE the shock is added, so a
  loan that's never had its own revert rate overridden still shocks
  correctly. New `src/whatIfRateShock.js` (pure): reuses
  `focusDebtPayoff.js`'s own `buildDebtPayoffFocus` against BOTH the
  base and shocked outputs for every loan's total interest, rollover
  before/after repayment, and balance path — never a second, re-derived
  copy of that logic. New **Interest rate shocks** What-if view:
  shock-type toggle, magnitude selector (−2/−1/+1/+2/+3pp, base always
  shown), loan balance paths overlaid (base solid, shocked dashed), an
  affordability callout naming whether the shock introduces or grows
  unfunded cashflow, per-loan interest/repayment table, CSV export.
  Tested: a variable loan's interest changes from month one; a fixed
  loan's rate is unchanged until its own rollover and changes after
  (rateShock); a revert-rate shock leaves the fixed period AND every
  variable loan untouched; a shock sized to break affordability
  produces unfunded cashflow in the shocked run only.
- Commit 3 of docs/specs/14-what-if.md, **What if: market crash timing
  and sequence risk** — `src/sequenceRisk.js` REWRITTEN entirely (per
  the spec's own instruction: "read it, salvage what is useful... do
  not simply re-enable it"). Nothing from the old dormant single-
  portfolio "Path A vs Path B" DOM visualiser survived — it generated
  its own synthetic normal-distributed returns and manipulated the DOM
  directly, both patterns this codebase moved away from before this
  file went dormant. The crash is injected via the SAME
  `mc.shockFor(holdingId, m)` hook Monte Carlo already uses
  (deterministic.js's own documented overlay parameter) — no engine
  change needed: at the crash month, each holding's growth return is
  cut by `dropPct` scaled by its own growth-sleeve weight
  (`classWeights` — the Australian/international equity + property
  split the Asset class allocation chart already derives, excluding
  fixed interest and cash entirely, matching allocation.js's own scope);
  an optional recovery period applies a constant above-trend monthly
  return that exactly reverses that holding's own proportional loss by
  the end of the period. `whatIf.js`'s `runShock` gained the ability
  for an applier to return an `mc` override (rather than only mutating
  a cloned state) — backward compatible, Commit 2's shocks are
  unaffected — since a crash needs no liability/asset FIELD changed at
  all. New `src/whatIfCrash.js` (pure): runs the identical crash at
  three representative ages (early/mid-career/near-retirement, spread
  across the accumulation phase) against the same base. New **Market
  crash timing** What-if view: crash-size and recovery-period
  selectors, net assets over time (base + three age lines), an
  end-net-assets-by-timing table, an explicit note that this is the
  deterministic counterpart to the (also relocated) Monte Carlo view,
  CSV export. Tested: the balance drop matches dropPct × growth
  fraction exactly; a 100%-cash holding is completely unaffected; a
  recovery period restores the balance to trend exactly on schedule;
  the identical crash produces materially different end outcomes at
  different ages; the crash self-registers with `runShock`'s generic
  registry, producing identical figures to calling it directly.
- Commit 4 of docs/specs/14-what-if.md, **What if: income interruption
  and expense shock** — two more kinds self-registered into
  `whatIf.js`. `incomeGap` ({ownerId, atAge, months, replacementPct})
  is a genuine STATE-level change (splitting the owner's own
  salary-category income row(s) across the gap), not an mc side-channel
  like the crash — income needs to move BOTH the household's monthly
  cash AND that person's annual taxable income together (tax is
  assessed from the SAME row-level yearly totals cashflowStatement.js
  already reads), and only a state-level row change moves both
  consistently. Every DateRef in this engine resolves to a WHOLE PLAN
  YEAR (age anchors snap to 1 July — keyDates.js's resolveOwnerAge;
  annual rows and one-offs fire in July for the same reason, per
  CLAUDE.md's own Cashflows convention) — there is no month-level date
  granularity anywhere in this schema, so `months` is rounded to the
  nearest whole number of plan years, a disclosed simplification
  matching how every other timed event in this engine already works
  (a fixed-rate rollover, a planned purchase — nothing resolves finer
  than a plan year). `expenseShock` ({pct}) is far simpler: scales
  every household expense row's own `amount` by `1+pct/100` — since
  indexation is layered multiplicatively on top of `amount` at each
  point in time, scaling the base amount scales the entire indexed
  trajectory for free, no separate indexed-vs-flat handling needed.
  Both shocks read through `runShock`'s existing generic deltas (net
  assets, tax, surplus, unfunded cashflow, headline figures for both
  runs) — neither needed a dedicated per-shock reader module the way
  rate shocks and crash timing did. New **Income interruption** and
  **Expense shock** What-if views: owner/age/length/replacement
  controls (income gap) or a single percentage control (expense shock),
  a shared base-vs-shocked net-assets-over-time chart, an affordability
  callout naming whether the shock introduces or grows unfunded
  cashflow, CSV export. Tested: the income reduction lands in exactly
  the gap year(s) and no others; replacementPct of 0/50/100 all apply
  correctly; only the named owner's salary rows are touched (other
  income categories and the partner's own income keep flowing); the
  expense shock scales every row, including an indexed one, by exactly
  the same factor at every year of the projection; both shocks produce
  unfunded cashflow in scenarios sized to break affordability, and
  never in scenarios that shouldn't.
- Commit 5 of docs/specs/14-what-if.md, **Monte Carlo: interest rates
  driven by the simulated CPI path** — interest rates are NOT modelled
  as an independent stochastic process; they're driven off the SAME
  simulated CPI path each Monte Carlo path already generates:
  `marketRate(path, year) = neutralRealRate + cpi(path, year) + margin`
  (two new configurable parameters, defaults 1.0%/2.5%, chosen so their
  sum with the 2.5% CPI default reproduces the 6.0% mortgage rate
  default). Applied as a DEVIATION from each loan's own deterministic
  rate rather than an absolute override — the formula's own
  neutralRealRate/margin terms algebraically cancel out of the applied
  delta, leaving exactly `cpi(path, year) − cpiMean`, which is what
  makes "zero CPI volatility reproduces the deterministic projection
  exactly" hold for ANY loan regardless of what rate it was entered at,
  not just ones that happen to match the default assumption. Applied to
  variable loans immediately and to fixed loans only after their own
  rollover (Commit 2's differential, again) via a new
  `mc.mortgageRateDeltaForYear` parameter alongside `shockFor`/
  `cpiForYear` — always absent for a deterministic run, so the change
  is zero-risk there (confirmed: the full suite stayed bit-identical
  throughout implementation). The level payment now recomputes once
  every simulated July (not just once at rollover) whenever this
  parameter is active, via a new `mcActivePmt` cache alongside
  `postRolloverPmt` (same measurement/real-pass snapshot-and-restore
  treatment) — this is what lets "repayments rise" under a high-
  inflation path show up as a genuine, observable figure rather than
  only the interest component moving; recomputing at an UNCHANGED rate
  reproduces the IDENTICAL payment every time (amortisation's own
  self-consistency), which is also why this is safe at zero CPI
  volatility. Parameters modal updated: documents the formula, the two
  new parameters and their calibration, and states plainly that rates
  are a function of simulated inflation, not an independent process —
  also corrected a stale "one constant interest rate for the whole
  projection" claim left over from before fixed-rate rollover (Commit 1
  of this same spec) already superseded it. Tested: a variable loan's
  rate moves by exactly the delta every year; a fixed loan ignores the
  delta entirely before its own rollover and applies it after; the
  level payment reproduces the identical NOMINAL figure when the rate
  doesn't change and genuinely rises when it does; a null/absent mc
  leaves every liability figure bit-identical to before this commit;
  across real Monte Carlo runs — rate genuinely varies path to path and
  tracks that path's own CPI; a fixed loan's rate is invariant across
  paths until its own rollover, then varies; zero CPI volatility
  reproduces the deterministic projection exactly for a plan with BOTH
  a variable and a fixed-rate liability (entered at rates that
  deliberately don't match the linkage formula's own defaults); the
  conservation invariant holds across sampled paths through a fixed
  loan's own rollover with the annual repayment recompute active
  (stress-tested across 16 additional seeds/1,920 checks beyond the
  committed test suite); seeded reproducibility (already-existing
  regression coverage, confirmed still byte-identical with the new code
  path active). Timing impact measured directly (not assumed): a
  2,000-path run with one liability went from ~4.3-4.6s to ~4.7-5.3s
  (roughly 10-15% slower) — reported here per the spec's own
  instruction, not optimised away.

This closes all five commits of docs/specs/14-what-if.md.

### In flight
Super threshold indexation per figure (AWOTE / CPI / unindexed, with
nominal rounding), then Division 296, then Monte Carlo over the full
scenario.

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
