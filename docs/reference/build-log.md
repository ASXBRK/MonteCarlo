# Build Log — Projection Tool (Xtools+ replacement)

Repo `ASXBRK/MonteCarlo`, branch `claude/monte-carlo-investment-app-R9XSB`.
Rewritten stock-take, grouped by area rather than by spec — the specs
themselves (`docs/specs/`) hold the full commit-by-commit reasoning; this
file is the map of where things landed. 107 commits in, branch head at
time of writing `9d6bf04`.

This file is updated in the SAME commit as the work it describes, per
CLAUDE.md's Workflow rules ("Keep `docs/reference/build-log.md` current:
move completed items to DONE with their commit hashes as they land"). A
build log that lags the code is worse than none — it reads as current
when it isn't.

---

## STATUS — DONE

### Engine and tax core
Monthly deterministic engine over a plan-year ledger (`e48e471`, `6edd9f9`)
with FY anchoring and a genuinely partial first year; household/couple
with per-owner ages (`8f19300`/`c734897`, `cfdec6a`); client/scenario
workspace with hash routing and JSON export/import (`edd0820`, `a9cfcda`).
Full personal tax — brackets, Medicare, LITO, franking, both CGT regimes
with pooled cost bases and the 1 Jul 2027 deemed-reacquisition reset
(`e15ef1b`, `733ff6e`, `6971a7d`). Identity intake with DOB/sex and ABS
life-expectancy anchoring, AWOTE indexation (`77aeb08`). Tier 1.1 **Key
Dates** — named anchors (Start, End, Retirement, custom) referenced by
every date field, verified as pure indirection, byte-identical to
equivalent explicit ages (`f2fb60d`, `53a312d`). **Working Cash Account**
— household cashflow buffer with an FY-end sweep, replacing monthly
surplus destruction; a second latent bug (unfunded cashflow re-recording
cumulatively) was found and fixed in the same work (`2115792`). Fixed-rate
loans and rollover, and adviser fees with a `plan.implementation`
reconciliation block for the flow of initial funds, both landed as part
of the Implementation/Rates spec (`9240f52`, `c86e8d0`). Input UX: the
dense Setup block split into Setup/Tax details/Super-settings, with
tooltip-hidden helper text (`60d249f`); `state.meta.touched` distinguishes
a value the adviser actually entered from an unreviewed default, covering
every `.cf-cell`/`.plan-field` field in the app with zero per-field
markup (`0bba12c`).

### Assets, liabilities and property
Financial vs lifestyle asset classes (`8b51272`); liabilities with
amortisation, offsets and deductible interest (`19d7475`); planned
property purchases, stamp duty across eight jurisdictions, FHOG and
post-2027 gearing rules (`534dced`); a data-accuracy pass completing the
ABS life table and the WA FHB/FHOG figures, with unverified-state flags on
anything not yet confirmed (`8409440`). Asset-class allocations and an
allocation-over-time chart, franking derived from class weights with CMA
inconsistencies flagged rather than silently accepted (`2805921`,
`9bd1905`). Lenders mortgage insurance and the First Home Guarantee
(indicative premium table and price caps, `eac776b`);
extra and one-off loan repayments through the same funding-order/unfunded
cascade the scheduled repayment already uses, never silently skipped
(`a7b4a58`); usable equity and borrowing capacity as a read-only,
security-constraint figure (`283be1b`). Input integrity, Part C
(`1047ceb`) and the property-specific follow-ups: an "Owned" property with
a future acquisition date is now unenterable rather than merely warned
about, with an actionable "switch to planned purchase" fix in the same
warning (`9a1f985`, `8d1b643`) — the canonical example CLAUDE.md's own
Input integrity section now cites. Asset-deletion reassignment dialog and
an excluded-asset row flag closed the remaining Phase A.1 gaps found by
the spec audit (`94b88f9`).

### Super, including Division 293 and 296
Accounts with tax components, SG derived from employment income, salary
sacrifice/personal deductible/non-deductible/spouse contributions
(`bc46c25`); concessional cap with five-year carry-forward and the
prior-30-June TSB gate, NCC with bring-forward tiers, contributions tax,
Division 293 (`f00e165`); preservation, release conditions, and
payment-time proportioning of the tax-free/taxable split (`de8ba8e`).
Division 296 — the two-tier tax on high super balances, with confirmed
untaxed-plan-cap and indexation bases (`dfb51db`, `d73a731`); Division
293/296 release from super as the default, not cash, with `divTaxPaidFrom`
as the per-person override (`cdeb76e`). **Two money-creation bugs found
and fixed here, both now permanently guarded by the conservation
invariant**: personal deductible and salary-sacrifice contributions
credited super and cut taxable income without ever debiting household
cash (`e1eb61a`); the same gap for cap-based ("toConcessionalCap")
contributions specifically, landed alongside the conservation invariant's
own introduction so the fix and its guard shipped together (`2867768`).
Per-figure super threshold indexation (AWOTE/CPI/unindexed, with nominal
rounding) (`5ce30c1`). A third bug, found via this session's demo-client
work rather than `randomScenario()`: the super account's reported closing
balance silently omitted a deficit-funded-from-super withdrawal made in
the FY's LAST month — `superSeries[id][m+1]` was snapshotted BEFORE that
withdrawal ran, and every OTHER month's shortfall self-corrected via the
next month's fresh snapshot, so only June was ever wrong. Fixed by moving
the snapshot to the true end of the month's processing, alongside the
financial-asset equivalent; locked in with a standalone regression test
(`deterministic.test.js`, not a `randomScenario()` extension — see that
test's own header for why this exact pattern wasn't reachable by the
existing fuzzer) — housekeeping commit, this session.

### HELP, FHSSS, MLS, deductions and PAYG withholding
Document Set commits (`docs/specs/11-document-set.md`), found by a
workbook document-sense-check: **HELP repayments** (`1f3a5eb`) — FY-keyed
bracket table with the $186,052 whole-income cliff, per-person
`helpBalance`, repayment income folding in reportable super contributions
and net investment loss. **Medicare Levy Surcharge** (`afbfdec`) —
single/family band tables, the $1,500/child-after-first family threshold
step, `privateHospitalCover`/`dependentChildren` inputs (also fixed a
latent bug: Setup's commit handler was dropping `workingCash` from the
next plan object on every edit). **FHSSS** (`caa13fb`) — annual
$15,000/lifetime $50,000 combined cap, 85%/100% release split, the
taxable release taxed at MTR less a 30% offset, a planned PPR purchase's
"release at purchase" toggle. PAYG withholding, tax refund timing, and
deductions as their own commit (`ef7cafa`) — income tax accrues
PAYG-style across a person's salary months, the gap to actual liability
settles as a single outflow in July of FY t+1. HELP folded into
`row.liabilities` so it's finally visible to net worth and the
Liabilities table/chart, with the double-counted "Other Loan Repayments"
line fixed alongside it (`132e7cd`). A real display-layer bug found
during worked-example validation, independent of the document itself:
`cashReceivedSums`'s take-home-pay figure netted off income-tax PAYG
withholding only, never HELP or MLS withholding, despite both being
withheld through the identical mechanism — overstated take-home pay by
the client's full HELP repayment before the fix (`65e27d0`).

### Goals and education funding
`state.goals` — label, target amount, target date, funded from an asset
or from surplus, its own indexation; asset-funded draws through the same
`sell()` every cashflow uses, surplus-funded capped at what's actually
left over each month rather than manufacturing cash (`227b12a`). Children
replace the flat `dependentChildren` count entirely
(`plan.children = [{ id, name, dateOfBirth, education }]`), migrated from
an existing count via plausible placeholder DOBs surfaced in the Review
panel; per-child education funding blocks anchor to the child's own age
via a self-contained affine shift, deliberately not wired into the
shared owner/anchor system built for client/partner (`b3724c5`). A real
bug caught by extending `randomScenario()` to generate children and
education before this shipped: the schedule read `block.amount` where the
model calls the field `annualAmount`, producing NaN expenses for every
scenario with an education block — caught by the conservation test on
run 5, not by hand.

### Output — Graphs, Tables, Focus, What if, and the client-level Comparison
**Graphs/Tables split** (`152e745`, `b321499`) with the composite
Cashflow-Assets-Liabilities chart on shared-zero dual axes (`2feca18`,
`d290b4c`); transposed multi-view ledgers with in-grid one-off editing
and a period selector (`0966705`, `d9212d0`); Snapshot view with firm row
vocabulary and "Copy for Word" clipboard export (`ab6b20e`); **Where the
money went** — a 7-bucket waterfall decomposition of net worth change,
reconciling to closing net worth exactly, not just within the invariant's
tolerance (`3a6feb5`). **Focus** (`docs/specs/12-focus-views.md`) — one
question, one page, read from the same `projectPlan()` output every other
view reads: scaffold and a monotonic-direction goal-seek solver
(`9bf12bb`), Deposit & home purchase with two solver actions and the
`unfundedCashflow`-driven, whole-of-projection affordability fix
(`4ae6fdf`, `277bd02`), FHSSS comparison (`7981d6c`), salary sacrifice
comparison (`9c02b04`), debt payoff (`ddaf123`), stamp duty/LMI standalone
lookups (`a1a6869`), usable equity, fortnightly transfer schedule
(`0aa4cd6`). **What if** (`docs/specs/14-what-if.md`) — the mirror of
Focus ("what if the world is different" vs "what if I did something
different"): scaffold with a self-registering shock runner
(`24c848a`), interest rate shocks (`2a6ff83`), market crash timing with a
fully rewritten `sequenceRisk.js` (`d590705`), income interruption and
expense shock (`a0a741b`); a later pass made cashflow — surplus and
working cash, not net assets — the PRIMARY lens for the three cashflow
shocks, since "do we get through it" is the real question for an income
gap, not net worth in 2060 (`c431a9e`). **Client-level Comparison** — a
Focus view originally (`438e0f4`), relocated off the workspace entirely
onto its own client-level page with no input sidebar
(`#/clients/<cid>/compare?s=<id>,<id>`), selection via a capped checkbox
picker on the client page, and an 8-option view selector (6 charts, 2
tables) replacing the old single stacked-everything page (`9d6bf04`). The
comparison math itself (`planWindowsMatch`/`keyFigureValuesAtYear`/
`keyFigureComparisonRows`) is untouched by the relocation — a relocation
plus a view selector, not a rewrite. A latent bug found by testing the
relocation end-to-end: a scenario with no stored blob yet (the
workspace's bootstrap scenario, before any save) silently dropped out of
a comparison instead of showing as the defaults it actually is — fixed
with the same fallback `loadActiveState()` already used.

### Monte Carlo, with CPI-linked interest rates
Full-plan simulation with its own conservation checks and a timing report
(`3d2169b`); a properly-seeded RNG with per-path CPI variation
(`9ef4938`); 10/25/50/75/90 bands and a single ruin definition
(`5a67a89`); a worker with progress and cancel so the tab never blocks
(`297b1ed`); Tables view, distribution summary, CSV export (`09e674e`);
a later audit fixed PNG export, the results cache, and the deterministic
overlay (`f09cc43`). Relocated into the new **What if** group unchanged —
same ids, same render functions, only the sidebar grouping moved
(`24c848a`). **Interest rates driven by the simulated CPI path**, not an
independent stochastic process: `marketRate = neutralRealRate +
cpi(path, year) + margin`, applied as a deviation from each loan's own
deterministic rate so zero CPI volatility reproduces the deterministic
projection exactly for ANY loan, regardless of its entered rate
(`9a70991`) — variable loans move immediately, fixed loans only after
their own rollover, consistent with the fixed-rate-rollover work. An
errata was needed, not a code fix: the spec had predicted a fixed-rate
client's fan chart would be genuinely NARROWER during the fixed period;
verified opposite — it's wider, because the hedge only holds while the
client's own rate is fixed, and the erratum is recorded at the end of the
spec, body untouched (`7ecdfc7`).

### Conservation invariant and input-integrity work
Motivated by two real engine defects found by using the tool and looking
at output, not by the test suite (WCA timing spending annual income the
month it arrived; the super money-creation bug above) — both violated the
same principle, "money must be conserved," and neither had a test that
could see it. `conservationCheck.js` now asserts, for every plan year,
that the change in net position equals the sum of every named source of
cash entering or leaving the household, with `randomScenario()`
(`deterministic.test.js`) generating the money flows to exercise it.
**Four bugs found via this invariant since**, each the same class —
"a guard that doesn't grow with the engine silently stops guarding" — and
each closed by extending BOTH the generator and the invariant in the same
commit, per CLAUDE.md's explicit rule: an FHSSS release crediting
settlement cash with more than the super account actually gave up
(`0d205aa`); two claims on the same super account in the same year (adviser
fees, Division 293/296, FHSSS) each believing they alone could take the
full balance, closed by a fixed-order `reserveFromSuper` (Implementation/
Rates Commit 2); the property acquisition-date bug — a legal-looking
"Owned" property with a future date silently producing rent from year one
— now the canonical unenterable-state example (`1047ceb`, `9a1f985`); and
this session's super-closing-balance snapshot-ordering bug (see Super,
above). Input integrity: Part C of the spec audit made impossible states
unenterable rather than merely warned about (`1047ceb`); Input UX
(`docs/specs/15-input-usability.md`) added `state.meta.touched` so an
unreviewed default is visibly distinguished from a deliberate entry,
covering the whole app with a generic path-computation function rather
than per-field markup (`0bba12c`).

### Worked-example validation
The tool had never been checked against an independently-produced
correct answer. `docs/reference/workbook-document-sense-check.md`
analysed a real advice document the firm produced by hand;
`src/workedExample.test.js` builds that client as a committed fixture
(never localStorage) and asserts the Snapshot view's year-one column
against the document's own five figures — HELP and the work-related
deduction match exactly, take-home pay within 0.25%, the refund gap a
disclosed timing convention (`65e27d0`). NET INCOME carried a genuine
~4.7% discrepancy after that first pass; a follow-up resolved it against
PRIMARY SOURCES rather than assuming the firm's hand-built, prior-FY
workbook was correct: a first-principles derivation reproduces the
document's implied pre-HELP figure exactly and is defensible on its own;
HELP's own bracket shape makes the reconstructed taxable income
provably UNIQUE for a single earner, so no single-earner input set
reaches the document's NET INCOME figure — a second-earner household
does, exactly, a demonstrated-consistent candidate, not a confirmed one;
and the "workbook predates this FY" hypothesis was tested directly by
re-running under FY2025–26 brackets and REJECTED — the prior year taxes
MORE, moving further from the document's figure, not closer (`cfa36b4`).
The standing precedence rule this established, now the project
convention: "Where our figure and the workbook disagree, ours stands if
it traces to a primary source with the source and date cited. The
workbook is a second opinion from a point in time, not a reference
implementation. Divergences are recorded, attributed where possible, and
only treated as our defect where a primary source says so."

### Surplus and deficit allocation (spec 16, Commit 1 of 4 — model and engine)
`settings.surplus` moves from a single whole-of-surplus choice (spend /
invest to one asset / accumulate) to a list of periods, each splitting the
surplus by percentage across asset/liability/superContribution/goal
destinations, with an always-explicit remainder. Pay-non-deductible-debt-
first (ranked by `deductiblePct`, a percentage rather than a boolean, so a
part-deductible loan's priority ceiling is proportional) runs before the
percentage split; a liability allocation's overflow and a superContribution
allocation's cap-breach both fall through to later destinations rather than
being lost or silently exceeding a cap. Deficit funding gained per-asset
minimum balances (drawn to floor, then breached in the funding order, only
once every asset is at floor) and a minimum-capital-gain sell rule (sorts
by unrealised-gain ratio via the existing pooled cost bases; no-CGT assets
sort first). Migration (`{mode,assetId}` → a single Start→End period) is
bit-identical for existing scenarios. `randomScenario()` now generates
allocation plans across every rule and target type; this surfaced a real
conservation-invariant gap — a surplus top-up of an existing
salary-sacrifice row writes into the same display field a genuine
payroll-reduced sacrifice does, but (unlike the genuine case) it passes
through the household's own cash pocket on the way in, so it must not also
get the invariant's usual salary-sacrifice add-back; fixed by naming that
slice separately (`surplusSalarySacrifice`) rather than widening the
existing field's meaning. Also found and fixed: `liabSeries` (like
`superSeries` before it) was snapshotting a liability's closing balance
before the same month's later surplus-repayment code had a chance to
change it — the same "snapshot taken too early" bug class, a second
occurrence. UI (Commit 2), outputs and a Focus view (Commit 3), and the
non-deductible-first advice signal (Commit 4) are tracked in
"Where we're going" below until they land.

### Surplus and deficit allocation (spec 16, Commit 2 of 4 — settings UI)
Replaces the Commit-1 placeholder text with a real period editor.
Structural design choice: only ONE boundary per period is ever directly
edited — a non-first period's own `from` — bounded at input to strictly
between its two neighbours' resolved ages, so the control itself can
never produce a gap or overlap (the spec's own "incapable of displaying
an allocation that does not total 100%" principle extended to periods
generally). Editing that boundary writes the PRECEDING period's `to` in
the same commit (one age below), keeping the pair contiguous by
construction rather than validated after the fact; the outermost edges
(period 0's `from`, the last period's `to`) are never exposed as editable
at all — always Start/End — so the period list keeps covering the whole
projection even if the plan's own bounds move later. "Split into two
periods" inserts a new period at the current range's midpoint age (as an
explicit age, not an anchor — the user can then repoint it at an anchor
via the same boundary control); "Remove period" merges into a neighbour
(the first period is absorbed forward, any other backward) rather than
leaving a gap. An allocation row is a single grouped select ("type:id"
value) rather than a dependent type-then-target pair, so there's no
intermediate state where a type is chosen but the target isn't (which
`clampAllocationEntry` would silently drop on the next clamp); a percent
input is clamped LIVE to its own row's remaining headroom (100% minus
every other row's share), and "+ Add allocation" is hidden outright once
the remainder reaches 0% — both make "cannot exceed 100%" true at the
input, not merely enforced afterwards. The remainder line is always
rendered, computed fresh from the stored allocations every render, never
tracked as separate state that could drift.

New shared reader, `surplusDestinationBreakdown(row)`: turns the
engine's own already-resolved per-target reporting fields (per-asset
`surplusInvested`, per-liability `surplusRepayment`, per-super-account
`surplusSalarySacrifice`/`surplusPersonalDeductible`, per-goal
`surplusContribution`, `surplusSpent`, `surplusAccumulated`) into one
row per destination that actually received money that FY — built once,
reused by this settings UI's own "resolved effect" line (spec's own
worked example: "$2,340/month: $1,400 to Home loan..."), by Commit 3's
Cashflow table breakdown, and by the Commit 3 Focus view, so there is
exactly one definition of "where did the surplus go" across the whole
app rather than three independent re-derivations that could disagree.
Two new REPORTING-ONLY engine fields (no new money, no conservation
term needed) support it: `superDetail[id].surplusPersonalDeductible`
and `goals[id].surplusContribution` — mirroring the existing
`surplusSalarySacrifice` field's purpose but for the two other surplus
destination types that previously had no way to isolate "how much of
this FY's total came from surplus specifically" from the ordinary flow
to the same target.

Deficit block: a minimum-balance number input per asset in the existing
ordered list, plus the sell-rule select with its own explanatory line.

No engine change beyond the two new reporting fields (both additive,
read-only duplicates of money already accounted for elsewhere) — full
suite green unchanged, and this is a pure UI commit for `randomScenario()`/
the conservation invariant's own purposes. Verified in a real browser
(Vite dev server + Playwright against the built app, not only the test
suite): split a period, added/edited/removed an allocation row, toggled
pay-non-deductible-debt-first, set a deficit minimum balance, changed the
sell rule — no console errors, correct resolved-$ figures at every step.

### Surplus and deficit allocation (spec 16, Commit 3 of 4 — outputs and Focus view)
Cashflow table: the Funding group's single "Surplus invested/swept/spent"
lines are replaced by `surplusPerDestinationRows(yl)` — one row per
destination that EXISTS in the plan (every financial asset, every
liability, every super account, every goal, plus the two destination-
agnostic outcomes), each reading the same per-target reporting field
`surplusDestinationBreakdown()` reads elsewhere; a destination no
period's rules ever actually reach in a given FY reads zero and
disappears under the pre-existing all-zero-rows-hidden convention,
rather than needing its own presence check. Shared between the Cashflow
table and the new Focus view below so the two can never disagree about
the row set. Liabilities table: a new "Surplus-driven repayment" row,
reading the existing `surplusRepayment` field, distinct from "Extra
repayments" (the client's own entered figure) — a real gap closed in
the SAME "Combined" (all-loans-summed) accumulator this commit found:
its own zero-skeleton object was missing the field entirely, which
would have silently summed to zero regardless of the per-loan value.
Money decomposition ("Where the money went"): confirmed still
reconciles exactly — `decomposeNetWorthChange` is built from the SAME
named terms the conservation invariant already uses, and this whole
commit adds no new term (both new reporting fields are read-only
duplicates), so the "reconciles exactly" test that already runs
`randomScenario()`-generated allocation plans through it needed no
changes and still passes.

New pure module `src/focusSurplusAllocation.js` (7 tests): 
`surplusDestinationBreakdown` (the shared reader, now imported by
main.js rather than duplicated locally as it briefly was in Commit 2),
`buildSurplusAllocationFocus` (year-by-year totals for the new Focus
view), and `projectSingleDestinationAlternative` — a REAL second
`projectPlan()` run (via `clampAllToPlan`, the same pattern
`focusDebtPayoff.js`'s own counterfactual already establishes) with
every configured period replaced by one sending 100% of surplus to a
single nominated destination, for the "should we put it all on the
mortgage or split it?" comparison the spec names outright. The new
Focus → Surplus allocation view shows the per-destination table
(reusing `renderTransposed`/`exportTransposedCSV`, the same generic
transposed-table machinery the Output tables use, for a free CSV export
and nominal/real toggle) plus the comparison figure and its own explicit
non-prescriptive framing ("one alternative, not a recommendation").
`nonDeductibleFirstBenefit` (Commit 4's own calculation) shipped in this
same file and is fully tested here too, but its UI wiring is deliberately
deferred to Commit 4's own commit, per the specs' own gating.

New route id `focus-surplus-allocation` needed adding to
`router.js`'s `OUTPUT_VIEWS` list — Focus view ids ARE output views for
routing purposes (a real, previously-unremarked gotcha this commit hit
directly: the view rendered an empty container with no error at all
until this was found, because `showSection` silently falls back to the
default output view for any section id `OUTPUT_VIEWS` doesn't list).
Regression gate: full suite green (1144 tests, +7 new); no engine
change. Verified in a real browser: Cashflow table (table form) shows
the new per-destination Funding rows, the Focus view renders with a
correct comparison figure and a populated per-year table, all with zero
console errors.

### Navigation and charts (spec 17, Commit 1 — Output subject views)
The Graphs and Tables sidebar groups (17 entries) collapsed into one
Output group of 10 subject views (Projection, Cashflow, Assets,
Liabilities, Super, Tax, Net worth, Allocation, Snapshot, Assumptions),
each carrying a chart/table toggle in its header where both forms exist.
No engine change — a thin compatibility layer: the sidebar/route now
address a canonical subject id, resolved (via `state.display.outputForm`,
persisted per scenario like every other display-state field, or an
explicit `?form=` query param for a shareable link) to the SAME
pre-existing view id every render/export/mount dispatcher already keyed
on, so none of the 16 individual chart/table render functions needed
touching. Bookmarked pre-spec-17 links (`cashflow-bars`, `key-figures`,
etc.) redirect to their new subject+form home rather than bouncing to
Setup. Audit requested by the spec: the four chart/table pairs
(cashflow-bars/cashflow, asset-balances/assets, liabilities-balances/
liabilities, super-balances/super) and the net-assets/key-figures pair
are format-splits of one subject, not duplicates — exactly the
consolidation case, not a deletion case. `composite` and
`money-decomposition` fold into Projection's and Net worth's own chart
selector in Commit 4; until then they land on the plain chart form of
their new home.

### Navigation and charts (spec 17, Commit 2 — nested collapsible sidebar)
Both areas of the sidebar (Input's 15 sections, Output's 10 subjects +
Focus + What if) are now grouped into collapsible subgroups — Input:
Client/Money in/Money out/Assets/Debt/Plan; Output: Output/Focus/What
if — one expanded at a time per area, persisted per scenario
(`state.display.navExpanded`, same free-form-string/main.js-owns-the-
enum pattern as `chartTreatment`). Navigating (deep link, sidebar click,
or any other route change) always force-expands the group containing
the new active section, so the active view is never hidden inside a
collapsed group. A collapsed group's header still carries an aggregate
item count and untouched-badge OR ("Assets ●1" style) for input groups,
matching the spec's "a collapsed group still signals what is inside."

### Navigation and charts (spec 17, Commit 3 — Client/Partner/Consolidated selector)
Added the shared Consolidated/Client/Partner selector (`renderPersonSelector`,
hidden entirely for a single-person household) to Cashflow, Tax, Super,
Allocation, Net worth (both forms), and Snapshot. Tax and Super were
already internally split per person (`row.taxDetail.client/.partner`,
never-joint super accounts) — the selector just picks which existing
group renders; Cashflow reused `cashflowStatement.js`'s own `forOwner`
parameter (Document Set Commit 7's Snapshot mechanism), so threading it
through was the entire change; Snapshot's existing three-column
mechanism is that same `forOwner` machinery, so the selector projects
its already-computed Client/Partner/Total result down to one column
rather than touching the well-tested `snapshot.js` module at all.
**Net worth is a genuinely new derivation** — the engine only ever
computes the household total (`row.netAssets`) — built from each
holding's own owner (joint assets/property/liabilities split 50/50,
matching `cashflowStatement.js`'s existing convention; super and HELP
are never joint and split exactly); the Working Cash Account has no
owner anywhere in the ledger and is deliberately left OUT of a
per-person NET ASSETS figure (labelled "excl. working cash", with a
note) rather than split arbitrarily, so Client + Partner does not sum
to the household figure by exactly that amount, disclosed on screen.
Cashflow's Funding/One-off/Goals groups and Tax's Household group are
similarly shown in full regardless of the selection, titled to say so.
No engine change.

### Navigation and charts (spec 17, Commit 4 — single-question charts)
A chart-type dropdown in the view header (`state.display.chartSelection`,
same persistence pattern as Commits 1/2) lets Cashflow, Net worth, and
Super each offer more than one chart: Cashflow gains Income sources,
Expense funding, and Tax by type; Net worth gains Debt vs assets
(crossover year annotated) alongside its existing Net assets/Composite/
Where-the-money-went; Super gains Super vs non-super (preservation age
marked). New pure module `src/chartSeries.js` computes each new chart's
series and is unit-tested to reconcile against the ledger rows it
claims to represent — the expense-funding split in particular relies on
an exact identity (`metFromIncome + fundedFromAssets + unfunded = income
− surplusOrDeficit`) verified against a real `projectPlan()` run, not
just hand-built fixtures. "Where the surplus went" is deliberately
**not** built yet: surplus allocation's engine (spec 16, Commit 1) only
tags asset/liability destinations distinctly from ordinary flows —
super/goal surplus contributions still land in the same generic fields
an ordinary contribution uses, so an accurate per-destination chart
needs spec 16's own Commit 3 first. No engine change; the four existing
charts folded into these two selectors needed no changes at all (same
compatibility-layer ids Commit 1 established).

### Adjustment rows (spec 18, Commit 1 — model and engine)
`plan.adjustments`: a narrow registry (10 targets — income.assessable/
nonTaxable, deductions, tax.incomeTax/withheld/medicare/help/cgt,
expenses, superContributions), each a signed real-$ amount over a
DateRef window with required indexation and note. `expenses` is the
only household-owned target; every other target anchors to its owner's
own age window (ownerWindow, same as an income/deduction row);
superContributions resolves its owner from the target ACCOUNT, not the
stored value, and is dropped entirely if the account doesn't exist —
same "unenterable state" principle as a surplus-allocation destination.
Engine: schedule.js resolves each adjustment's bounds AND its indexed
real-dollar amount per FY (the same convention every other row's
indexation already follows there, not deferred to deterministic.js);
deterministic.js applies income/deductions/expenses/superContributions
inside the FY's July month (ungated where they must feed the tax
measurement pass), and folds tax.incomeTax/medicare/help/cgt into the
SAME PAYG-style spread every ordinary tax debit already uses — a
disclosed simplification: which specific line an amount is labelled
against is a display concern (Commit 2), not a distinct settlement
mechanic today. `tax.withheld` adjusts PAYG withheld only (adding to
`paygWithheld`, before both the in-year debit and the following-July
refund/balancing settlement read it) — this makes "nets to zero across
the two years it straddles" fall out of the EXISTING refund mechanism
with no new code, but is a genuine no-op for a person with no
employment income this FY (no separate withheld-vs-liability gap
exists there to adjust), disclosed rather than silently reinterpreted.
Every target reuses an EXISTING reported ledger field (row.income,
row.expenses, row.tax, row.superDetail[*].contributionsTax) rather than
inventing a new pocket, so the conservation invariant needed no new
named term — verified, not assumed: `randomScenario()` now generates
every target (owners, windows, and — for superContributions — a
dangling account id) and the existing invariant holds across hundreds
of randomised runs unchanged. Regression gate: a scenario with no
adjustments is bit-identical (the array is empty by default and every
new term evaluates to zero).

### Adjustment rows (spec 18, Commit 2 — table integration and marking)
The Cashflow and Tax tables' section totals (`cashflowStatement.js`'s
`assessableIncome`/`deductionSums`/`taxSums`/`cashReceivedSums`/
`expenseSums`) are an INDEPENDENT re-derivation from rowTotals/taxDetail,
not a read of the engine's own already-adjusted `row.income`/`expenses`/
`tax` — each now folds its matching adjustment(s) in via a shared
`adjustmentSum(row, target, forOwner)` helper (same `shareOf` 50/50
convention as every other joint figure there), and exposes BOTH the
pre-adjustment `computedX` and the post-adjustment `total`/named field so
a caller can show all three without re-deriving one from another.
`taxSums`'s tax.incomeTax/medicare/help/cgt fold in similarly — these
settle in the engine as a lump-sum PAYG-style spread (Commit 1), never
touching `taxDetail`'s own per-component fields, so `taxSums` is where
the per-target split actually happens for the Cashflow table; the Tax
view's own per-person breakdown (`buildTaxGroups`) reads `taxDetail`
directly, which is why THAT figure is already the "Computed" one with no
subtraction needed.

main.js's `adjustableRow(label, computedCell, adjCell, target, forOwner,
opts)` is the single Computed/Adjustment/Total (Xtools "Amount/Special/
Total") builder both tables use: Total is always Computed + Adjustment,
never a separately-tracked figure that could drift from the other two.
Returns the ORIGINAL single row unchanged when nothing is active for
that target/owner scope — the regression gate (a scenario with no
adjustments renders byte-identical) falls out of that early return
rather than needing a separate code path. Both the Adjustment sub-row
and the Total row carry `data-adj-marker`/`data-adj-owner`/`title`
(reusing the existing delegated click handler from Commit 1's modal
groundwork) and a tinted background + trailing pencil via
`.tl-adjustment-row`/`.tl-adjusted` in styles.css — clicking either row
opens the same create/edit form. Wired for income.assessable, deductions
(surfaced on the "Taxable Income" line, since the Deductions section has
no separate total row of its own), expenses, income.nonTaxable (Cash
Received's "Other tax free income" — skipped when the individual-rows
toggle is showing itemised entries instead, a disclosed gap rather than
a silent one, since the Adjustments panel still lists it), and all four
tax.* targets (tax.incomeTax and tax.cgt share the Cashflow table's
single "Income Tax" line, since it carries no separate CGT row there;
the Tax view's own "Net income tax"/"CGT payable" lines mark them
separately). `superContributions` and `tax.withheld` are not marked in
any table — the former has no Super-balance table view in this build yet
and the latter is a pure timing shift with no ledger line of its own —
both remain fully visible in the Commit 3 review panel, a disclosed
scope reduction rather than an invisible one.
Regression gate: full suite green with the new folding logic exercised
against zero-adjustment fixtures (identical results) and populated ones
(reconciling exactly); no engine change, so `randomScenario()`/the
conservation invariant are unchanged from Commit 1.

### Adjustment rows (spec 18, Commit 3 — review panel and disclosure)
The Adjustments modal (built as part of Commit 2's editor groundwork)
already covered the review list, count badge, and edit/delete — Commit 3
adds: a "View" jump-to link per adjustment row to whichever output
subject (Cashflow or Tax) Commit 2 marked its target on (superContributions
and tax.withheld have no table row of their own, so no link, not a dead
one); a "This projection includes N manual adjustments" one-line
disclosure footer on the Cashflow table, Tax table, Snapshot table, the
Snapshot Word-clipboard export, and every CSV export (a scenario
property, so it appears regardless of which view is exported); and
integration with the spec-15 Review Defaults panel.

Adjustments live in a modal, not a rendered `[data-section]` input area,
so they're outside that panel's generic DOM-attribute scan — instead,
each adjustment gets its own `adjustments.<id>` touched-path (marked
touched on create/edit, per spec 15's "changed OR confirmed" rule, and
untracked on delete) and the Review Defaults panel lists any untouched
one explicitly, with its own jump-to (opens the adjustment editor
directly) and mark-reviewed. Duplicating a scenario copies the raw
serialized blob byte-for-byte including `meta.touched` — `duplicate`
now strips `adjustments.*` paths from the COPY specifically
(`untouchAdjustmentsInBlob`), so every adjustment reappears unreviewed
in the new scenario ("an override that made sense in one scenario may
not in another" — the spec's own words) without disturbing any other
touched path or the source scenario.
Regression gate: no engine change; full suite green.

### Smart defaults (spec 19, Commit 1 — registry, provenance, and derived recomputation)
`src/smartDefaults.js`: a pure registry naming each defaulted field's
kind (house view / legislated / derived) and a `describe(ctx)` sentence
matching the spec's own worked examples exactly ("Default: 5.5% — house
view (Residential Property profile growth component)"). Of the seven
fields the spec lists, five (property growth, purchase costs, LVR, agent
fees, education indexation) derive from a CONSTANT that never changes
mid-session (a fixed % or the firm's own profile assumption) — for
those, "recomputes when its inputs change" is vacuous, so only the
provenance tooltip matters, wired via the existing `tooltipHTML()`
affordance (spec 15). The other two — property rent (4% of value) and
expenses (20% of gross rent) — genuinely cross-reference another
user-editable field, so THOSE get real recompute-until-overridden
tracking: a new `isDefault` flag on each `Property.rent`/`.expenses`
sub-object (planState.js), true only on a brand-new property
(`createProperty`); `clampProperty` recomputes the amount from its
source on every clamp while the flag holds, and main.js's field handler
sets it false the instant the user types an amount directly, never
re-arming. Regression gate: a pre-Commit-1 property blob has no
`isDefault` key at all — defaulting the check to `=== true` (not
`!== false`) means an absent flag reads as "already user-entered", so
every existing saved rent/expenses figure passes through clampProperty
unchanged rather than being silently overwritten by the new derivation
— verified directly (a raw fixture with rent=20000/expenses=3000 and no
`isDefault` key stays exactly 20000/3000 after clamping, not the 4%/20%
derived figures). No new money flow (a derived default replaces a
manual entry; it doesn't add a leak), so no `randomScenario()`/
conservation-invariant change needed.

### Land tax (spec 19, Commit 2)
`src/data/landTax.js`: per-jurisdiction progressive bracket schedules,
same [floor, base, rate] encoding as stampDuty.js. WA's general scale was
cross-checked this session against multiple independently-converging
secondary sources (calculator sites + RSM Australia commentary) via web
search — RevenueWA's own site could not be reached directly (network
egress to *.wa.gov.au is blocked from this build environment), so it's
disclosed as corroborated-but-not-primary-sourced rather than the spec's
own "verified" — an honest downgrade from the instruction, not a silent
one. Every other jurisdiction is a disclosed UNVERIFIED simplified (2-4
bracket) approximation from training knowledge; NT genuinely levies no
general land tax at all.

Engine (deterministic.js): assessed annually (July only) on the
AGGREGATED unimproved land value of each owner's non-PPR properties
within a jurisdiction — a two-pass computation (sum land values per
person per state, look up each group's tax, then apportion back to each
contributing property in proportion to its own share) so a threshold
crossed only by the SUM of two properties neither reaches alone is
caught, and so deductibility/reporting stay meaningful per property
despite the shared progressive scale. `landValuePct` (default 60%,
editable per property — smartDefaults.js registers it) estimates the
unimproved-land share of total value, the feature's largest disclosed
approximation; `landTaxOverride` bypasses the aggregate calculation for
one property (dutyOverride's own precedence convention), excluded from
its siblings' aggregate. Deductible against rental income for an
INVESTMENT property only — routed through the SAME `_propNet[pid].expenses`
bucket ordinary property expenses use (not a bare deduction credit
alone), so a land-tax-driven loss is subject to the SAME negative-
gearing quarantine rule as everything else; a holiday home's land tax is
a real cash outflow with no deduction at all, since it earns no
assessable income to offset against. Folds into the SAME `row.expenses`/
`net` computation as ordinary property expenses, so the conservation
invariant needed NO new named term (verified across 5×300 randomised
runs after extending `randomScenario()` to generate 0-2 planned
investment/holiday properties, sometimes sharing a jurisdiction to
exercise the aggregation, with a randomised land-tax override).
cashflowStatement.js's independent re-derivation (Cashflow table) gained
matching `propertyLandTax` (deductions, investment-only) and `landTax`
(expenses, investment+holiday) fields — the same blind spot spec 18's
own Commit 2 found and fixed for adjustments.
Regression gate: full suite green unchanged; every pre-existing property
test fixture's land value happens to fall under its state's own
threshold (empirically confirmed, not engineered), so no existing dollar
assertion needed updating — a NEW property crossing a threshold gets the
new (correct) tax, which is the point of the commit.

### Redundancy and ETP (spec 19, Commit 3)
`src/data/etpRates.js`: genuine redundancy tax-free base ($13,598 +
$6,801/completed year, AWOTE-indexed — NOT rounded to a step, since
those figures are themselves the ATO's own already-rounded FY2026/27
numbers rather than round numbers to begin with, unlike the ETP cap's
$5,000 step), the $270,000 ETP cap (AWOTE-indexed), and the $180,000
whole-of-income cap (a flat figure, genuinely not indexed in law).
Training-knowledge figures, UNVERIFIED against ato.gov.au this session —
disclosed the same way as every other embedded schedule.

Model (planState.js): a `termination` object on an income row —
enabled, date, completed years of service, type (genuine redundancy |
resignation/retirement), ETP taxable component, unused leave (taxed as
ordinary income — the spec's own "pick one and disclose it" choice;
no distinct leave-specific concessional treatment modelled).
`clampIncomeRow` forces the row's own `to` to equal `termination.at`
when enabled — "the income row ends at the termination date" falls out
of the row's EXISTING from/to mechanism for free, needing no separate
truncation logic; DateRef year-granularity means the row still earns
its salary for the WHOLE of the termination FY (inclusive-boundary
convention, same as every other row) with the payout landing the same
July, not a mid-year cutoff — disclosed.

Engine: schedule.js resolves each termination to a month + age once
(same "fires in July of its resolved plan year" convention as every
other age-anchored one-off — property purchases, FHSSS releases), into
`schedule.terminationEvents`; deterministic.js applies it UNGATED (the
unused-leave credit to `acc[owner].ordinary` must feed the tax
measurement pass) except the actual tax-outflow WRITE, which is
pass-gated (`if (taxOut)`) to avoid double-counting across the
measured/real `runYear` calls — mirroring `spreadTax`'s own convention.
The tax-free base and the ETP taxable component are BOTH excluded from
`acc[owner].ordinary` entirely (not merely untaxed) — the spec's own
test that neither appears in assessable income, HELP repayment income,
or Division 293 income falls out for free, since all three read
`acc[*].ordinary`/`measured[*].taxableIncome`. The ETP's own flat tax
(concessional rate to the relevant cap, 45% above, plus Medicare) is
computed via `etpRates.js` and settles in full the same month, not
spread or PAYG-estimated. Genuine redundancy uses the ETP cap alone
(an excluded ETP); resignation/retirement uses the tighter of the ETP
cap and (whole-of-income cap − other taxable income this FY) —
"other taxable income" approximates using whatever the person has
already accrued THIS FY before the event fires, a disclosed
simplification (often ~$0 for a same-July termination, likely
understating other income for that case — a real multi-month-precision
model would need finer DateRef granularity than this engine supports
anywhere else either).
Regression gate: an income row with no `termination` field behaves
byte-identically (verified); extended `randomScenario()` (0.3 chance
per person, both types, a payout spanning under/over both caps) and
held across 5×300 randomised conservation runs — no new named
conservation term needed (the payout and its tax both flow through the
existing income/tax terms).
Known gap, disclosed rather than silently absent: cashflowStatement.js's
independent re-derivation (the Cashflow table) does not yet break the
termination payout out as its own line — `row.income`/`row.tax` are
correct and reconcile exactly (verified), but an adviser scanning the
Cashflow table's category rows won't see "Redundancy" as a distinct
line yet; the raw ledger and Tax view figures are unaffected.

### Property sale (spec 19, Commit 4)
Property gains a `sale` object: enabled, date, agentFeesPct (derived
default 2.5%), settlementCosts (derived default $2,000), and a
proceeds destination (a real financial asset, or repay the linked loan
first then that asset — the default, since a sale rarely leaves the
mortgage outstanding). `normaliseProperties` now takes `assets` (every
call site updated) to validate the destination the same two-stage way
`depositFromEquitySourcePropertyId` already validates a sibling
property — an invalid/dangling asset id disables the sale entirely
rather than defaulting proceeds somewhere unchosen.

Engine: a dedicated pre-pass fires in July of the sale's resolved plan
year (same convention as a purchase), BEFORE that month's property
growth/rent/land-tax loop (so a sold property isn't also grown/taxed
the same month) and before the liability loop (so a discharged loan
accrues no further interest this FY). CGT joins the SAME pooled cost-
base machinery (`poolConsume`) a financial asset sale already uses —
full disposal (f=1, whole pool consumed), PPR exempt (skipped
entirely), both regimes (pre/post 1 Jul 2027) apply via the existing
boundary. Agent fees and settlement costs are a cost-base element (the
spec's own words) — mathematically identical to reducing the taxable
gain directly (proceeds − pool − costs), which is what the engine does,
rather than expensing them separately. Only a purchase-derived linked
loan (id `prop-<propertyId>`, the SAME naming convention
`isPropertyLoan` uses everywhere else in this codebase) is ever
discharged by "repay loan then asset" — a standalone liability the user
separately entered against an already-owned property was never
formally linked to begin with (this tool has no such link for that
case today), so it continues unaffected; disclosed, not a new gap. The
discharge amount is reported as the liability's own `principal` field
so the existing liabilityRevaluation formula treats it like an
oversized repayment rather than misreading it as a mystery CPI gain.
The property "leaves the projection" simply by `propVal` reaching zero
— every existing gate (`propVal > 0`) already treats that as "doesn't
exist", so rent/expenses/land tax/growth all stop for free, no separate
flag needed.

Conservation: a THIRD property-shaped event (alongside ordinary growth
and a purchase) needed its own term — `propertySaleCosts` (agent fees +
settlement costs, the only genuine leak; the net proceeds themselves
are a transfer already reflected in the destination asset's/liability's
own closing balance). The existing purchase-era
propertyResidual/propertyAcquisitionCosts formula has no concept of a
sale and would misread a sold property's value dropping to zero as a
nonsensical "negative purchase" — fixed by adding the gross sale value
back into `propertyValueDelta` before that formula runs, cancelling the
drop so the rest of the year's property activity reads exactly as if
the sale never happened, then naming the sale's own real effect
separately. Folded into `decomposeNetWorthChange`'s `oneOffs` bucket
alongside duty/costs/FHOG (same category of figure). Extended
`randomScenario()` (30% chance per land-tax-generating property, both
proceeds destinations, randomised costs) and verified across 5×300
randomised conservation + net-worth-decomposition runs.
"Sell and buy in the same year" (the spec's own named scenario) is
verified BY CONSTRUCTION — the sale pre-pass credits the destination
asset before that month's purchase-settlement funding draw runs — but
does not yet have a dedicated committed test exercising a simultaneous
sale+purchase pair; a known gap, disclosed rather than silently assumed
airtight.
Known gaps, disclosed: no dedicated UI for entering a sale (the engine,
model, and tests are complete; the property card doesn't yet expose
`sale.*` fields — an adviser can model a sale via direct JSON import/
export today, not through the input panel); the Cashflow table doesn't
yet show sale proceeds as its own line, mirroring land tax's own
Commit 2 gap.

### Main residence exemption and the six-year absence rule (spec 19, Commit 5)
`src/mainResidence.js`: a pure day-count module (`exemptProportion`) —
never moved out ⇒ fully exempt; moved out but not producing income
(vacant) ⇒ exempt indefinitely, no clock; moved out AND producing
income (rented) ⇒ exempt for the absence's first six years, the
remainder (up to reoccupation or the sale, whichever comes first)
taxable at exempt-days/total-days. Only ONE moved-out/moved-back-in
cycle is modelled — the spec's own disclosed limit (no successive
absences, no choice between two properties, no home-office
apportionment). Property gains a `mainResidence` object (movedOutAt,
producingIncome, movedBackInAt), meaningful only for `propertyType:
"ppr"`; `movedBackInAt` can't precede `movedOutAt` (input integrity).

Engine: `isCgt` (deterministic.js) now also fires for a "ppr" property
WITH an absence event, alongside every non-PPR property — the pool
seeds and tracks exactly like an investment property's — but the
exemption reduction (`exemptProportion`) is gated explicitly on
`propertyType === "ppr"`, not just `isCgt`, since an ordinary
investment/holiday property's gain must stay fully taxable regardless
of `exemptProportion`'s own "never moved out ⇒ exempt" default (which
assumes a PPR history a genuine investment property never had).
DateRef-anchored events (movedOutAt/movedBackInAt/the sale itself)
resolve to literal ISO calendar dates at 1 July of their resolved plan
year — the same convention every other age-anchored one-off in this
engine already uses — so the pure day-count module works on real
dates, exactly like `Property.acquisitionDate` already does. A
still-to-be-purchased property's own eventual purchase date stands in
for its acquisitionDate (a purchased-then-vacated-then-sold PPR within
the SAME projection gets a real ownership period, not a silent
"fully exempt" default from a missing date).
No new conservation term needed — this changes the SIZE of the
existing property-sale CGT flow (Commit 4's own term), not its shape;
verified directly (a dedicated "conservation holds" test) and via the
existing property-sale randomised fuzz coverage, now also generating a
PPR absence+sale about 30% of the time.
A genuine, non-obvious interaction FOUND while testing (not a bug):
crossing the 1 July 2027 deemed-reacquisition boundary resets a
property's cost-base pool to its market value AT THAT DATE — for a
property held flat-nominal (real value declining via CPI) across that
boundary, the pool can end up ABOVE the eventual sale value, producing
a genuine capital LOSS even though the nominal purchase price was much
lower than the sale price. Correct, pre-existing engine behaviour (not
new to this commit) — it just needed accounting for when hand-picking
fixture dates that happened to straddle the boundary.
Known gap, disclosed: no Focus view yet (the spec's own timeline bar +
CGT-if-sold-by-year line + exempt-days table) — the underlying figures
(`row.properties[pid].saleGain`, and `mainResidence.js`'s pure
`exemptProportion` for a what-if year) are all available for one to be
built from directly, same "engine first" scoping as Commits 2 and 4.

### Spouse contributions, co-contribution and LISTO (spec 19, Commit 6)
`src/data/spouseSuperRates.js`: the spouse contribution tax offset
(18% of the lesser of the contribution and $3,000, phasing to nil as
the RECEIVING spouse's income runs from $37,000 to $40,000), government
co-contribution (50% of eligible personal NCCs up to $500, phasing out
$49,293–$64,293), and LISTO (15% of eligible concessional
contributions up to $500, nil at/above $37,000 adjusted taxable
income) — training-knowledge figures, UNVERIFIED against ato.gov.au
this session, disclosed the same way as every other embedded schedule.

The schema already had `personalNonDeductible` and `spouse` contribution
types (and their existing UI dropdown labels) from Tier 1.2 — this
commit is the first to give them real tax/government-payment
consequences beyond the non-concessional-cap bucketing they already
had. schedule.js gained two ADDITIVE per-FY-per-owner totals
(`spouseContributionsByOwner`, `personalNccByOwner`), accumulated
alongside the EXISTING merged `nonConcessional` flow key rather than
splitting it — a smaller, lower-risk change than reshaping a
widely-read core structure. Government inflows credit the person's own
default (first-listed, included) account, same convention SG uses; the
"10% eligible income" test collapses to "10%+ from employment" (this
tool has no separate self-employment/business income category to test
against, disclosed) and both payments are credited in the SAME FY
they're earned — a disclosed simplification of the real ~12-18 month
ATO payment lag. Spouse offset TSB check uses the receiving spouse's
CURRENT super balance as a proxy for "at the prior 30 June"; the "no
excess NCCs" condition is not modelled (disclosed, a rare edge case
next to the income-based phase-out). Contribution SPLITTING (up to 85%
of the prior year's concessional contributions moved to a spouse's
account, no new contribution, no cap effect) is NOT built — a
disclosed, deliberate scope cut for this commit, distinct from the two
genuine-inflow mechanisms the spec itself names as needing a
conservation term.

Two real ordering bugs were found and fixed via this very invariant
while wiring this in (not hypothetical — both reproduced against a
randomly generated scenario before the fix):
1. Crediting `govSuperInflow` to `superBal` BEFORE the real pass let
   that FY's adviser-fee-from-super reservation see an inflated
   balance, silently shifting some of ITS OWN funding from cash to
   super with no cash-vs-super term accounting for the shift — fixed by
   applying the credit strictly AFTER the real pass completes (once
   every other same-year super-balance decision has already settled),
   the same "resolve in a fixed order against what's actually left"
   principle `reserveFromSuper`'s own header already documents.
2. The spouse offset's own `spreadTax` call landed BEFORE
   `taxOutArr.fill(...)` resets that FY's tax-outflow array for the
   ordinary PAYG/adjustment settlement below it — the offset's write
   was silently wiped every time. Fixed by moving it to run AFTER that
   per-person settlement loop, mirroring where `taxAdjustmentTotal`'s
   own spreadTax calls already sit.
`govSuperInflow` is a new named conservation term (a genuine inflow
with no household cash movement — the spec's own words); extended
`randomScenario()` (spouse/personalNonDeductible contributions, ~40%
each, couple-only for spouse) and verified across 1500+ randomised
conservation + net-worth-decomposition runs.
No new UI needed — `spouse`/`personalNonDeductible` were already
selectable in the existing super contribution row editor with their
own labels ("Spouse contribution", "Personal (non-deductible)"); this
commit is engine-complete end to end.

**Follow-up (same session): contribution splitting.** An earlier pass
through this build mischaracterised splitting as out of scope for
Commit 6; re-reading the spec found it listed as an in-scope
requirement (its own test line: "splitting moving balance without
touching caps") — only co-contribution/LISTO were the spec's *named
conservation term*, not a statement that splitting itself was deferred.
Built to close the gap: a new per-account `contributionSplitPct`
(0–85%, forced to 0 for a single client — clampSuperAccount) is an
annual election moving that % of the account's own PRIOR FY's net
concessional contributions to the owner's spouse's default account.
A new `superDetail[id].concessionalNet` tracks the actual $ credited
each FY from every concessional source (the ordinary flow, a
toConcessionalCap fill, and an adjustment-row super contribution all
feed it) so next year's split has a single correct base to work from.
Applied at the very top of each year's loop — BEFORE the measured
pass, reserveFromSuper, or the Division 293/296 TSB check ever read
`superBal` — since, unlike govSuperInflow, the split's basis (last
FY's already-finalised figure) creates no same-year feedback loop; it's
the same "resolve before either pass touches the balance" treatment
adviser fees/Division 293/296/FHSSS already get. A same-total transfer
between two pockets already both inside `superClosing` — conservation
needed NO new named term (verified across 1500+ randomised runs after
extending `randomScenario()`, same reasoning already applied to land
tax/redundancy/the PPR exemption). UI: a "Contribution splitting"
section in `superAccountCardHTML`, shown only for a couple.

### Insurance premiums inside superannuation (spec 19, Commit 7)
A super account gained an `insurancePremium: {amount, indexBasis,
indexExtraPct}` field (`clampInsurancePremium` in planState.js,
`indexExtraPct` defaulting to 3 rather than `clampIndexation`'s usual 0
— premiums typically outrun CPI, disclosed via the field's own tooltip
rather than silently assumed). schedule.js resolves it to a per-account,
per-month real-dollar Float64Array the same way every other indexed
figure is resolved (`realAmountAt`, CPI/AWOTE + extra%).

Engine-side, the premium debits the account every July via the
EXISTING `withdrawFromSuper` helper — no new balance-reduction logic
needed, since proportionally reducing the tax-free component on a
withdrawal is exactly what that helper already does for any other
super outflow. This is a direct balance reduction: not a withdrawal to
the member, not assessable income, not a contribution against any cap.
Reported per-account on `row.superDetail[id].insurancePremium`.
Fund-level tax deductibility of the premium (relevant for TPD/income
protection inside super, which can generate a small offsetting
tax benefit to the fund) is NOT modelled — disclosed via the same
in-app tooltip, consistent with the ICR/costs section already sitting
next to it in the account card.

`superInsurancePremium` is a new named conservation term (a leak out of
super with no other pocket receiving it). Extended `randomScenario()`
(50% chance per super account, random amount/indexation) and verified
across 1500+ randomised conservation + net-worth-decomposition runs.

UI is complete this commit: a new "Insurance premium" section in
`superAccountCardHTML` (amount, index basis, +extra% with the
CPI+3%-default tooltip) alongside three new `applySuperAccountEdit`
cases, mirroring the account's existing ICR/Costs section.

### Demo clients
Three committed fixtures under `src/demo/` (First home buyer; Family with
a mortgage; High earner pre-retirement), each built through the real
factories and `clampAllToPlan` rather than a hand-written state object, so
a schema change breaks the demo at build/test time instead of drifting
silently out of sync; a "Load demo clients" action on the Clients page
reuses `importFile`'s "client" kind wholesale (`d004642`). Two real bugs
found while building these, fixed at the source: a `{...base.plan.client,
currentAge: N}` override pattern silently did nothing, because
`clampPerson` derives `currentAge` from a stale `dob` whenever one is
present; and an annual-frequency income/expense row fires once, in July,
so a demo client anchored to today's date (almost always a partial first
year) contributed nothing in year one until every such row was made
monthly (`d004642`). This session's housekeeping pass found and fixed a
third: "Reduce work at 58" was marked `expectAffordable: false` but
projected with zero unfunded cashflow — an `expectAffordable:false`
scenario exempted from the affordability check rather than tested for the
failure it exists to show, passing vacuously. Both partners now wind down
together, well short of either person's own super access age, with a
retirement lifestyle spending step-up; the scenario now GENUINELY produces
sustained unfunded cashflow (the $150k joint savings buffer runs dry
within about a year, and the household goes without for years before
super becomes accessible), and `demo.test.js` now asserts non-zero
unfunded cashflow for any `expectAffordable:false` scenario rather than
skipping the check — this is what surfaced the super-closing-balance bug
above. The other eight scenarios were checked for the same vacuity; all
are genuinely affordable as constructed.

---

## WHERE WE'RE GOING

1. **Surplus allocation outputs and advice signal** (spec 16, Commits
   3–4) — the Cashflow/Liabilities table breakdown and a Focus → Surplus
   allocation view, and the non-deductible-first interest-saved figure.
   The model/engine (Commit 1) and settings UI (Commit 2) are done — see
   DONE above.
2. **Bonus and allowance income as distinct types** — lumpy, variable
   income, matching the firm's own "Site/Locality Allowance" and "After
   tax bonus" rows (previously deferred in specs 11 and 13; promoted here).
3. **Drawdown solver** — sustainable spend to life expectancy.

---

## PARKED AND OPEN ITEMS

### Unverified data — needs firm confirmation
- **The seven non-WA stamp duty schedules** (`src/data/stampDuty.js`) —
  WA and the ABS life table were confirmed in a data-accuracy pass
  (`8409440`); the other seven jurisdictions have not been. The
  per-purchase `dutyOverride` is the precision escape hatch meanwhile.
- **LMI premium table and FHBG price caps** (`src/data/lmiRates.js`,
  `src/data/fhbgCaps.js`) — indicative, built from the general shape of
  published figures rather than a live rate card; `lmiOverride` exists as
  the escape hatch.
- **FHSSS associated earnings rate** (`assumptions.fhsssEarningsRate`,
  currently 7.94% nominal) — an indicative ATO shortfall interest rate;
  user-adjustable in the meantime (Parameters modal / Assumptions view).
- **HELP/HECS balance indexation basis** — indexed annually at the lower
  of CPI and AWOTE (AWOTE proxying WPI, the post-1 June 2023 "lesser of"
  legislative basis) — confirm against the firm reference before relying
  on this for advice.

### Deferred — do not build

Accumulated across specs 11–15; see each spec's own "Deferred" section
for the reasoning behind each item.
- Salary packaging and novated leases (FBT mechanics are a separate
  build); debt recycling (needs loan drawdowns); trust distributions,
  foreign income, taxable pension component, TTR offset, SAPTO, and
  Centrelink payments (spec 11 — these currently emit as zero rows to
  preserve the worked document's table shape).
- Investment product comparison (research, not projection); solver
  targets beyond the three Focus already has (spec 12).
- The banking-structure diagram itself (produced separately); property
  sale with CGT; fixed-rate break costs and fixed-period repayment caps;
  serviceability assessment; Monte Carlo run ACROSS compared scenarios
  (ordinary scenario comparison is done; a stochastic version is not)
  (spec 13).
- Stacked or combined What-if shocks; shock probabilities or likelihood
  weighting (Monte Carlo is deliberately where probability lives, not
  here); yield-curve/term-structure modelling; asset-class-specific
  crash shocks beyond the growth/defensive split; the other dormant
  insight modules (`firstDecade`, `drawdownTolerance`, `tornado`) —
  assessed separately if a home for them turns up (spec 14).
- Childcare costs and CCS; Family Tax Benefit; the under-25-studying
  dependency condition; child death benefit pensions; education savings
  vehicles (bonds, trusts) as distinct structures; per-child asset
  ownership (spec 15).

### Standing design note
**Scenarios are independent copies — there is no shared client-facts
model.** A fact entered in one scenario (income, an asset balance, a
child's DOB) is not reflected in any other scenario for the same client;
each is a fully separate plan state. Deferred since spec 13; still true
today, including for the relocated Comparison page. Surfaced to the user
directly wherever scenarios are compared, rather than silently assumed.
