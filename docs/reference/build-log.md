# Build Log — Projection Tool (Xtools+ replacement)

Repo `ASXBRK/MonteCarlo`, branch `claude/monte-carlo-investment-app-R9XSB`.
Rewritten stock-take, grouped by area rather than by spec — the specs
themselves (`docs/specs/`) hold the full commit-by-commit reasoning; this
file is the map of where things landed. 229 commits in, branch head at
time of writing `317f9ec`.

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

### Surplus and deficit allocation (spec 16, Commit 4 of 4 — non-deductible-first advice signal)
Wires up `nonDeductibleFirstBenefit` (shipped and tested in Commit 3)
into the Focus → Surplus allocation view: one paragraph, present only
when at least one configured period has the rule on and the client
holds both a deductible and a non-deductible liability. States the
total-interest difference against the pro-rata counterfactual and WHY
non-deductible-first is prioritised (after-tax cost) — deliberately
does **not** claim this always means less total interest paid, since it
doesn't: whichever debt happens to carry the higher rate wins that
particular comparison, independent of deductibility, and a real
browser test in this same session produced exactly that case (a
non-deductible loan at a LOWER rate than the deductible one, non-
deductible-first paying $45,999 MORE total interest here) — the
paragraph's wording handles both signs and neither implies a
"winner," per the locked non-prescriptive convention (no advice
language, no winner-labels).
No engine or model change; no new tests (Commit 3's own test file
already covers both the "more" and "less" cases via
`nonDeductibleFirstBenefit`'s own unit tests). Regression gate: full
suite green unchanged (1144 tests). Verified in a real browser with a
scenario carrying two liabilities (one deductible at 5%, one
non-deductible at 8%) and real income: the paragraph rendered
correctly with the "more interest" wording for the constructed case
where it's true, zero console errors.

This closes out spec 16 in full (Commits 1–4).

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

### Property sale and main residence exemption: input UI
Closes a real gap: spec 19 Commits 4 (property sale) and 5 (main
residence exemption) shipped fully engine/model-complete with no way
to configure either from the app. This is pure UI wiring — no engine
or model change, no new tests (the underlying mechanics were already
covered by Commits 4/5's own test suites).

Property card gains a "Sale" section (enable checkbox; when on: sale
date via the existing DateRef control, agent fees % with the smart-
defaults tooltip already registered for it since Commit 1
(`property.agentFeesPct` — the registry anticipated this UI before it
existed), settlement costs, proceeds destination, and a destination
asset select) and, for a `ppr` property only, a "Main residence
exemption" section (a "moved out" toggle exposing the DateRef plus a
"producing income while absent" checkbox, and a "moved back in" toggle
exposing its own DateRef — the six-year clock's own reset event).

One real bug found and fixed while wiring this in: `normaliseProperties`
already forces `sale.enabled` back to `false` whenever `assetId`
doesn't resolve to a real financial asset (correct, pre-existing input-
integrity behaviour from Commit 4 — a sale with nowhere for the
proceeds to land is exactly the state CLAUDE.md's input-integrity
section rules out) — but the new UI rendered the destination-asset
select ONLY once `sale.enabled` was true, and left `assetId` null when
the checkbox was first ticked, creating a genuine catch-22: checking
the box couldn't reveal the field that would have kept it checked.
Fixed by defaulting `assetId` to the first eligible financial asset in
the SAME commit that sets `enabled: true`, so the two can never
disagree even for the single render in between.

Verified in a real browser (Vite dev server + Playwright, not only
`node --check`): added a property, enabled sale (destination asset
correctly auto-selected and visible), set agent fees/destination,
enabled "moved out" and "moved back in" — all fields render and persist
correctly, zero console errors at every step.

### Main residence exemption: the Focus view spec 19 Commit 5 named but never built
Closes the last piece of that gap. New pure module
`src/focusMainResidenceExemption.js` (11 tests):

- `mainResidenceStatusAt` — the four statuses the spec names (main
  residence / absent-covered / absent-exceeded / investment) at a given
  calendar date, built on `mainResidence.js`'s own day-count rules
  (never re-derived — one definition of the six-year clock, shared with
  the real engine); `buildMainResidenceTimeline` runs it for every plan
  year plus `exemptProportion` for the exempt-days table, resolving
  `mainResidence.movedOutAt/movedBackInAt`'s own DateRefs to calendar
  dates the SAME way `deterministic.js`'s `resolveMainResidenceDates`
  does. "investment" is reported for a genuinely non-ppr property
  (included in the same timeline for comparison — this model has no
  mechanism for a ppr to become one).
- `buildCgtIfSoldSeries` — "CGT payable if sold that year" is a REAL
  `projectPlan()` re-run per candidate year (never a shortcut formula:
  CGT tax payable depends on the person's marginal rate and whatever
  else that FY, which this engine already assesses correctly), isolated
  as the INCREMENTAL household tax of a synthetic sale that year against
  the same plan with no sale at all. Paid in July of the FOLLOWING FY
  (this engine's own CGT accrual convention) — comparing the sale year's
  own tax figure would silently read zero every time; a sale in the
  final plan year reads `accruedCgtAtEnd` instead, since there's no
  following-year row to read from.
  A real, found-while-building-this confound: routing the synthetic
  sale to one of the plan's own real assets measures CGT PLUS whatever
  that asset's own earnings are on the extra cash for the rest of that
  FY, not CGT alone — a browser test in this session caught it directly
  (CGT reading nonzero years before the exempt-days table said the
  exemption had even lapsed). Fixed with a dedicated zero-income,
  zero-growth "measurement" asset injected into the throwaway clone
  only, parking the proceeds somewhere that earns nothing so the only
  tax difference a sale can create is the sale's own CGT — locked in
  with a dedicated regression test using a real, earning destination
  asset as the confound.

Focus view: a colour-coded timeline bar (CSS, one segment per plan
year) with a legend, the CGT-if-sold series, and the exempt-days table
(exempt days / total days / exempt % by year) — reachable only for a
`ppr` property with a "moved out" date set (an empty state otherwise,
naming exactly what's missing). Disclosed simplification: "CGT payable
if sold" is a TABLE, not a Plotly line — a chart would need new
chart-wiring this commit doesn't add, and the cliff (flat, then
climbing once the six-year window lapses) is legible in the numbers
themselves without one.

New route id `focus-ppr-exemption` added to `router.js`'s `OUTPUT_VIEWS`
(the same gotcha Commit 3's own build-log entry already names — Focus
view ids ARE output views for routing purposes).

No engine/model change (spec 19 Commit 5 shipped that already) —
regression gate: full suite green (1155 tests, +11 new). Verified in a
real browser end to end: configured a property's moved-out/producing-
income fields, viewed the Focus page, confirmed the timeline bar's
colour transitions, the CGT table reading exactly $0 through the
covered years and climbing precisely from the FY the exempt-days table
marks "exceeded," zero console errors.

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

### Input behaviour: derived values track their source until overridden
Three fixes sharing one principle. (1) The touched dot now clears on any
edit that changes a field's value, not only the explicit tick — closes a
real coverage gap where table-row (`<td>`-based) fields across every
Cashflow-style section (income, expenses, deductions, super contributions/
withdrawals, liability extra/one-off repayments) got no touched decoration
at all, because `decorateTouchedFields()`'s container resolution only knew
`.cf-cell`/`.plan-field`. Fixing this surfaced a second, unrelated
pre-existing bug: native `<select>`s fire "input" before "change", and
several `applyRowEdit` cases unconditionally replaced `rowEl.outerHTML` on
every invocation — including the "input" call — destroying the original
element and silently suppressing the subsequent "change" event the
touch-marking listener depends on. Fixed across all 9 occurrences (owner,
type, basis, indexBasis, category, both DateRef anchor branches), gated on
`commit`. (2) Income/expense/deduction row labels now derive from the
selected category (`labelIsDefault`, mirroring the property rent/expenses
convention) until the user types their own label, then freeze — with a
provenance tooltip while tracking. (3) A liability's "Relates to / secured
by" now offers properties as well as assets; once linked to a property,
`commencedOn` (from the property's acquisition/purchase date) and
`deductiblePct` (100 for investment, 0 for PPR/holiday) derive from it,
each independently stopping once the user edits it directly
(`commencementIsDefault`/`deductiblePctIsDefault`). The derivation itself
lives in main.js, not `clampLiability` — resolving a planned property's
purchaseAt needs a built schedule, which the pure clamp pipeline never
has. `deterministic.js`'s sale-proceeds loan discharge (already defaulting
to "repay linked loan first") was extended to recognise a manually-linked
liability, not only the auto-generated `prop-<id>` purchase loan, so an
already-owned property with no purchase-derived loan still discharges its
linked mortgage on sale. Two missing `state.properties` arguments in
main.js's `normaliseLiabilities` calls were fixed in the same pass — they
were silently dropping any property link on the next liability edit.
Browser-verified end to end: dot clears on edit, label tracks then
freezes, property appears grouped in the link select, commencedOn/
deductiblePct populate with tooltips and freeze independently on
override, and the sale-proceeds default resolves to the linked loan.

### Pension phase (spec 20 — accounts through commutations, 5 commits)
`f3239b3` accounts/commencement; `0246b71` drawdown/minimums/payment
tax; `bb4357a` retirement-phase earnings exemption and TTR; `6d83dd3`
transfer balance cap and account; `5d53723` commutations, input UI,
and outputs. Account-based and TTR pensions: the tax-free/taxable
proportioning rule fixed at commencement (snapshotted from the source
account's then-current components, never recalculated the way
accumulation is); minimum drawdown by age band with fixed/expenditure/
maximum(TTR-only 10%) options, the minimum always a floor under any
other option; retirement-phase earnings exempt from fund tax, TTR
converting automatically once the owner reaches release age; the
transfer balance cap and account, general-cap indexation plus the
unused-proportion personal-cap mechanism; partial/full commutations in
the pension's fixed proportions, both destinations (cash or back to
super). New money flow: pension earnings (net of fund tax) — named in
conservationCheck.js; commencement/payments/commutations are pure
transfers between already-counted pockets, needing no term.
`reserveFromSuper` (a shared per-account "already spoken for" ledger,
resolved once per FY before either pass, in a fixed order across
adviser fees/Div293/296/FHSSS/pension commencement) closes a real bug
the 300-scenario conservation sweep caught: pension commencement
originally bypassed it, so an FHSSS release could over-credit
settlement cash relative to what the shared super account actually
still held after the pension had already drained it earlier the same
month. Input UI: a Pensions section between Super and Liabilities;
outputs: a Pensions table, pension balances joining the Super balances
chart as a separate band, and the firm's reserved `Taxable Pension
Component`/`Taxable Pension Offset (TTR)` cashflow rows now populate
(previously hardcoded zero). Browser-verified end to end; conservation
holds across 15–25×300-scenario sweeps per commit.

### Age pension — core means testing (spec 21a, 4 commits)
`190a178` rates/thresholds/indexation; `cca035c` assets test/income
test/entitlement; `c2270b7` engine integration and cashflow; `8eaeb50`
tables, chart, and Focus view. Depended on Pension phase landing first
— the assets test's central rule (accumulation super exempt below age
pension age, pension-phase assessed regardless of age) needs pension
phase to exist. FY2026/27 rates per-figure indexed (rates at AWOTE,
thresholds at CPI — modelling rates at CPI instead would understate
the pension by roughly a third over 30 years, since the real legislated
floor is 27.7% of MTAWE, which AWOTE proxies). Data gap closed: the
firm's reference doesn't carry non-homeowner asset thresholds;
cross-referenced against Services Australia's published 2026 rates via
two independent public sources, then validated internally by
confirming the sourced pension-rate figure reproduces the firm's own
given homeowner cut-outs to within the $500 rounding step. Assets test
(financial + lifestyle + non-PPR property at market value, less
liabilities secured against an assessed asset) and two-tier-deeming
income test, both run on a couple's COMBINED figures against the
couple rate/thresholds, entitlement the lesser of the two, split 50/50
and paid only to whichever partner(s) are both age-eligible (67) and
flagged eligible. Tax treatment (the spec's own "pick one and say
which"): non-assessable income — SAPTO isn't modelled anywhere in this
engine, so taxing the payment without it would overstate tax.
`centrelinkEligible` reintroduced on taxProfile (removed as inert in
spec 15 Commit 1) as a smart default, true for anyone reaching age
pension age within the projection. New money flow: entitlement, a
government payment with no offsetting outflow — needs no dedicated
conservation term since it's credited straight into `row.income`, the
existing `income` term (documented in conservationCheck.js, not just
assumed); `randomScenario()` gained a `retireeCohort` age stratum,
since neither the original age-40 start nor the pension-phase
`olderCohort` (max age 66) could otherwise ever reach age pension age
within the 2–4 year sweep window. Outputs: an Age pension table/chart
subject, a Focus view with full-pension/cut-out threshold lines, and
the entitlement joining the composite and income-sources charts as its
own band (pulled back out of `row.income` so it's never double-counted
against the existing Income band). Browser-verified end to end: the
table showed the binding test correctly switching from Assets to
Income as assets grew over a 15-year window; conservation holds across
20×300-scenario sweeps.

### Age pension — refinements (spec 21b, 5 commits)
`6161282` Work Bonus and income bank; `a59f2c8` gifting and deprivation;
`1289a32` pre-2015 deeming grandfathering; `a04af60` Commonwealth
Seniors Health Card; `d78c145`+`9829943` (HEAS engine/outputs +
Settings input control)+`78c30d7` (browser-verification fix) Home
Equity Access Scheme and the age pension strategy Focus view. Work
Bonus: $7,800/yr exempt (26-fortnight annual-equivalent of the real
$300/fortnight scheme) plus an $11,800-cap income bank, employment/
self-employment income only, per person. Gifting: the $10,000/yr,
$30,000/five-year deprivation limits as a genuinely moving five-year
window (not five FYs from the first gift) — new module `src/gifting.js`
— a leak (`giftsPaid`), the full amount leaving real wealth regardless
of how much Centrelink counts as deprived. Grandfathering: pre-2015 ABPs
get the deductible-amount income test instead of deeming (assets test
unaffected either way), modelled via the existing `commenceAt` mechanism
(a grandfathered pension is necessarily one the client already holds at
plan start) with a fixed LE-at-commencement factor never recomputed
engine-side; lost permanently on commutation (modelled, with a warning)
or ceasing income support (disclosed, not modelled — no such event
exists in this engine). CSHC: income-tested only, adjusted taxable
income (the same disclosed-simplified figure HELP/MLS already use) plus
deemed ABP income only (narrower than the age pension's own deeming
base — never accumulation super or other financial assets), same
grandfathering exclusion, assessed on combined income for a couple,
independent of the age pension's own entitlement. HEAS: `plan.heas`
(`{enabled, propertyId}`) as its own top-level election rather than
forced into the liability shape (no term/repayment schedule fits an
interest-only, never-repaid, drawn-as-income government loan);
3.95%pa/fortnightly-compounding interest and the 150%-of-max-pension
drawdown cap are well-sourced, but the total-loan-cap age-component
table is a disclosed sparse-anchor linear interpolation — direct access
to Services Australia's own published table was blocked by network
egress in this environment (see `src/data/heas.js`'s own header; every
anchor point itself is sourced and cross-checked). New money flows in
this spec (gifts, HEAS drawdown+interest) extended both
`randomScenario()` and `conservationCheck.js` in the same commits that
introduced them, per CLAUDE.md's own rule. Outputs: Age pension table
gained Deprived assets/Work Bonus rows; Key Figures gained CSHC
eligible/HEAS loan balance; a new Focus → Age pension "Strategy
comparison" table (current plan vs an illustrative gift vs illustrative
work-income levels, non-prescriptive — entitlement AND net assets for
every arm, no arm labelled preferred). Browser-verification caught one
real bug before it reached main: the illustrative gift arm could
silently never fire (a partial first plan year's own July-only firing
rule) when a client was already age-pension-eligible at plan start,
producing a no-op arm indistinguishable from "Current plan" with no
visible cue — fixed same session. Conservation holds across 5+ sweeps
per commit.

### Superannuation death benefits (spec 22, 3 commits)
`8dbbc6e` lump sum tax on the terminal balance; `faa752c` reversionary
pensions and the survivor's cap; `f4847d7` outputs and re-contribution
comparison. Depended on Pension phase (spec 20) — reversionary pensions
and the transfer balance account on death both need it. Explicitly NOT
partner-death modelling (the spec's own words) — no projection branch,
no survivor scenario; a terminal planning figure only, computed once
against the FINAL projection year's already-closed balances: "if this
balance passes to these beneficiaries, this is what they receive."

`plan.<person>.deathBenefit = { beneficiaries: [{id, label,
relationship, sharePct}] }` — a person-level election (like taxProfile/
super), not a top-level row-list, since each person nominates
beneficiaries for their OWN super/pension death benefit only.
`relationship` (spouse/adultChild/minorChild/interdependent/
financialDependant/estate) alone derives tax dependency — the user is
never asked to classify dependant status directly, the spec's own
"that is the part they get wrong." Tax: a dependant is NANE regardless
of component; a non-dependant (the common, expensive case — an adult
child) pays 15%/30% plus a flat 2% Medicare (no shading — there is no
"other income" to shade against for a beneficiary this tool doesn't
model as a taxpayer); the estate is taxed like a non-dependant but
WITHOUT Medicare, the real, frequently-missed ATO distinction the
spec's header calls out. Components sourced straight from the existing
superTaxFree/pensionTaxFree tracking (fixed-at-commencement for a
pension, live ratio for accumulation) — correct by construction, not
re-derived. The untaxed element is disclosed as not modelled (this
tool has no untaxed-source-fund concept), always 0, its own column.

Reversionary pensions (spec 20 Commit 1's inert flag, given real
consequences): continue directly to the spouse instead of being paid
as a lump sum, NANE always; the transfer balance credit lands at the
value AT THE DATE OF DEATH (this FY's closing balance, no further
growth simulated) against the survivor's OWN transfer balance account
(pensionTba.js's existing creditTransferBalance), with the excess and
its notional tax rate flagged when it pushes the survivor over their
own cap — the real planning issue. The twelve-month legal delay before
the credit applies is disclosed as a timing fact only, never simulated.
Input integrity: `reversionary` now resets to false with no partner in
the household (meaningless with nobody to revert to).

Outputs: a new Output table (a plain table, not the year-columns
transposed-ledger machinery — this is a single terminal figure, not a
year series) listing tax-free/taxable/tax/net per person per account
per beneficiary share, reversionary pensions as their own rows, plus a
household total; a new Focus → Death benefits view comparing the
current nomination against alternative single-beneficiary types (a
pure recombination of the same final-year components, no
re-projection needed — deathBenefitTax() exported from deterministic.js
so the two can never quietly diverge) and, when the plan already models
an actual super withdrawal + non-concessional contribution pair, a
re-contribution comparison (both arms real projectPlan() runs on
clones) with a `cannotHelp` flag when every beneficiary is already a
tax dependant. Non-prescriptive throughout: reports the tax difference
and constraints, never labels a nomination or strategy as "better."

Neither Commit 1's lump sum tax nor Commit 2's reversionary credit is a
new money flow (both are terminal disclosures with no cash actually
moving inside the projection), so randomScenario()/conservationCheck.js
needed no extension for this spec. Browser-verified end to end
(empty and populated states, both views, plus the re-contribution
picker) with zero bugs found. Full suite green throughout (1390 tests
at Commit 3).

**Known gap, disclosed:** no dedicated input UI exists yet for adding/
editing `plan.<person>.deathBenefit.beneficiaries` — settable via
state/JSON import only. This matches gifts (spec 21b Commit 2), which
has the identical gap; both are candidates for a future input-UI pass.

---

### Income completeness (spec 23, 4 commits)
`1e7632d` employers as a first-class concept; `6c1fb82` bonus,
allowance and overtime income types; `a98299b` salary packaging by
employer type; `dbdfdad` novated leases.

`plan.employers = [{id, name, ownerId}]` — SG and the maximum
contribution base now apply PER EMPLOYER, not to a person's aggregated
income (two $200k jobs generate SG on both, up to the cap on each).
Bonus/allowance/overtime are now distinct income categories: a bonus
pays once, in a nominated month, and can be directed
(loanRepayment/superContribution/asset) via `bonusDestination`, its
after-tax amount resolved by differencing two isolated-employment
`assessPerson` calls; an allowance carries its own `taxable` flag;
**overtime is assessable but never generates SG** — forced off in both
`clampIncomeRow` and defensively in schedule.js's own SG-loop filter,
closing the "SG on all employment income" gap the user's own briefing
flagged directly (shift-worker overtime was overstating super before
this commit). Salary packaging: `employer.fbtType`
(standard/fbtExempt/fbtRebatable) with independent living-expense/meal-
entertainment caps; novated leases get their own always-FBT-liable
statutory-formula calculation regardless of employer type. **The FBT
caps are NOT in the firm reference at all** (unlike every other
indicative figure in this file) — `employer.fbtCaps` therefore carries
NO built-in default, not even an indicative one: both start at 0
(nothing exempt) until the adviser enters the real, current ATO figure.
Reportable fringe benefits correctly feed HELP/MLS/Division 293 income
— "the sting" that packaging can increase, not just decrease, a
client's obligations elsewhere.

None of these four commits needed a new conservation term (SG-cap
grouping, bonus/lease cash costs and FBT all reuse existing pockets —
each checked against and confirmed, not assumed). Full suite 1450
tests at Commit 4 close-out; conservation sweep clean throughout.

### Drawdowns and debt recycling (spec 24, 3 commits)
`c3e837c` loan drawdowns and dynamic deductibility; `5ee11f7` debt
recycling; `2e066e2` outputs and Focus view.

"Deductibility follows the USE of borrowed funds, not the security" —
`deductiblePct` becomes the OPENING investment/private split, engine-
derived from there via two live nominal buckets that always sum to the
loan's own balance. Repayments reduce both buckets PROPORTIONALLY by
default (keeps the deductible proportion constant, the legally correct
reading); `repaymentAllocation: "privateFirst"` reduces the private
bucket first instead — **permitted on a single mixed loan, but flagged
as an aggressive assumption the ATO wouldn't accept**, exactly the
"permit and disclose, neither silently allow nor silently forbid"
instruction this feature was built against. Debt recycling
(`liability.recycling`) redraws the FY's own repaid principal (or an
annual cap) into a destination asset, marking it investment-purpose,
so the deductible proportion climbs every cycle while total nominal
debt stays flat. A drawdown's cash/asset side needed a genuine fix, not
just a check, mid-Commit-1: the conservation sweep caught a gap exactly
equal to the drawdown amount from an initial "credit the destination
directly" attempt, fixed by routing through the SAME non-assessable
`inc` channel HEAS's own drawdown already used. Outputs: Liabilities
table gains investment/private balance columns and a Deductible
proportion row; Focus → Debt recycling compares the recycled plan
against the same plan without recycling (years-to-break-even = first
year the recycled arm's own netAssets catches up), stating the
strategy's real risk (total debt does not fall) in the view itself.
Full suite 1479 tests at Commit 2; conservation sweep clean across 10+
runs (5 reproduced the drawdown-credit bug every time before the fix,
5 confirmed it gone after).

### Investment and education bonds (spec 25, 3 commits)
`5545705` structure, tax, and the ten-year/125% rules; `12a1163`
engine integration and outputs; `a896449` education bonds and the
funding comparison.

A top-level `bonds` array (sibling of assets/liabilities, this
codebase's own convention) with the ten-year maturity clock, the 125%
contribution-cap rule, and the internal 30%-less-franking tax
(`bonds.js`, pure). Growth nets the internal tax haircut; only gains
are taxed (no fund-level CGT discount modelled, disclosed). Bonds
participate in deficit funding on the same footing as any financial
asset; an unmatured bond's withdrawal earnings are assessed via a NEW
`pendingBondTax` mechanism mirroring `pendingCgt` exactly — required
for the same structural reason CGT has its own one-year lag (a deficit
sale's exact size depends on that month's real tax outflow, which the
measurement pass never simulates, so the two passes can genuinely draw
different amounts; the first version of this wiring sized the tax from
the measurement pass and was wrong, caught by a full standalone
reproduction). Education bonds recover the internal tax on withdrawals
used for eligible education expenses (`bondEducationBenefit`, the
verified $30-per-$70 mechanic — see the "Unverified data" note below
for how this was checked and what remains unconfirmed) and auto-fund a
linked child's own modelled fee schedule. Focus → Education funding
runs the SAME seed lump sum through three real `projectPlan()` clones —
an ordinary taxable asset, a plain investment bond, an education bond —
explicitly flagging whenever a bond arm ends up worse than saving
outside one (verified against a deliberately low-marginal-rate
scenario). Full suite green throughout; conservation sweep and the net
worth decomposition's exact-reconciliation sweep both clean across
10+ runs.

### Defined benefit superannuation (spec 26, 3 commits)
`8432826` untaxed superannuation elements; `79fb638` defined benefit
pensions; `11398ab` Centrelink treatment and outputs.

Untaxed-status super accounts (`taxedStatus: "untaxed"` — West State
Super and similar): no 15% contributions/earnings tax inside the fund;
a post-60 benefit (withdrawal or rollover) is instead assessed on the
member, on its untaxed-element proportion, against a lifetime per-
person cap (`superRates.js`'s already-CONFIRMED `untaxedPlanCap`,
reused directly, never hardcoded) — 15% offset within the cap, a flat
47% above it, via a NEW `pendingUntaxedSuperTax` mechanism mirroring
`pendingBondTax`. A rollover crystallises the SAME 15%/47% as a direct
fund-level tax (no lag — it's not a personal income-tax event at all).
Found and fixed along the way: a REJECTED non-concessional
contribution was debiting the FULL requested amount from household
cash while crediting only the accepted portion to super — a pre-
existing, unrelated latent bug this spec's own cap-boundary fixture
newly exposed (a client's TSB had never before approached the bring-
forward "nil" tier in `randomScenario()`), closed at its source
(`superContribCashOut` now sized off the accepted amount).

`plan.definedBenefits` — a WA state-scheme pension the client's own
statement states (no source account, no balance: "we do not compute
what the fund's actuary computes"). **The transfer balance account
credits at the pension's special value, annual pension × 16 — NOT the
pension amount itself** — the canonical trap this spec named directly
("getting this wrong... understates cap usage sixteenfold"), verified
by a dedicated test. The untaxed element is assessable with its OWN
10% offset (distinct from the untaxed-lump-sum 15%); the taxed element
is tax-free from commencement. **The defined benefit income cap is NOT
a standalone firm-reference figure** — the spec's own $125,000 is
stale against the current $2,100,000 general transfer balance cap, so
it is instead DERIVED as that cap ÷ 16 (ITAA97 s307-462(3)), computed
fresh per FY so it moves with the SAME indexation the GTBC already
gets — a stronger basis than either a bare assertion or a manual-
override placeholder, and disclosed as such in `superRates.js`'s own
header. Where a person's DB income exceeds the derived cap, 50% of the
excess is added to assessable income with no offset. Notional taxed
contributions consume concessional cap headroom while the member is
still accruing (before their own commencement) without crediting any
account (grandfathering of that cap is disclosed, not modelled).
Centrelink: income-test-only, never an assessable asset (structurally
guaranteed — a DB pension is never merged into any account list the
assets test reads), assessable income = gross less its own deductible
amount, mirroring the existing grandfathered-pension pattern exactly.
A first attempt at a dedicated `dbPensionInflow` conservation term
double-counted the DB payment (it is credited directly into `inc`, the
same channel `agePensionMonthly` already uses, and was therefore
already inside `row.income`) — caught immediately by the net-worth-
decomposition reconciliation sweep and reverted in favour of the age
pension's own established convention. Full suite 1598 tests at Commit
3 close-out; conservation sweep and the decomposition-reconciliation
sweep both clean across 5+ runs.

**Gap closed by spec 27 (UI gap sweep, below):** the input UI for
bonds/superRollovers/definedBenefits/gifts/death-benefit beneficiaries
named here as missing, and the Pensions/Age pension/Key figures table
output work spec 26 Commit 3 described but never wired, all landed —
see the spec 27 entry below.

### UI gap sweep (spec 27, 5 commits)
`365ab26` defined benefit pensions and super rollovers; `5873c31` gifts
and death benefit nominations; `7031e47` investment and education
bonds; `034f446` outstanding output views; `a1ab5a9` reachability test
and verification.

Closed the input-UI gap disclosed above (spec 26's own entry): a
defined-benefit-pension card (own commencement, tax components, and
the 16× transfer-balance-cap credit shown distinctly at entry, e.g.
"$80,000 pa uses $1,280,000 of your transfer balance cap"); super
rollovers as a new cashflow-row kind (from/to account, whole-balance-
or-amount, a live untaxed→taxed rollover-tax estimate); a household-
level Gifts block in Settings (no natural "Age pension" input section
exists, so this resolves the spec's own open question) with the live
$10,000/yr and $30,000/five-year running position and deprived amount;
per-person death-benefit-nomination editors in Tax details (share %
clamped to remaining headroom so the total can never exceed 100%,
mirroring the surplus-allocation percentage field's own convention;
tax dependency derived from relationship and shown directly, never
asked for); bond cards + contributions in Investment cashflows, with
the ten-year date and 125% headroom shown live, sourced straight off
engine output. Output-side: the Pensions table gained a "Defined
benefit" group (gross/deductible/assessable — deliberately no "tax"
row, since the engine assesses tax at the whole-of-person level with
no per-DB-pension figure to show) and the 16× TBA credit as a distinct
footnote; the Age pension table gained the already-computed
`dbAssessableIncome` as its own row; Key figures gained a DB-income
line (explicitly not a balance); the Cashflow table (and Snapshot/
Compare via `cashflowStatement.js`) gained DB income and a Gifts
outflow row, with the DB pension's genuinely-assessable portion folded
into Assessable Income's own total (unlike the age pension row, which
stays display-only) so Taxable Income keeps reconciling to what Tax on
Taxable Income was actually calculated on.

Found and fixed along the way, all disclosed as reachability gaps
rather than new engine work: `router.js`'s `OUTPUT_VIEWS`/
`OUTPUT_SUBJECT_FORMS` never listed bonds, focus-debt-recycling, or
focus-education-funding — all three were fully built (specs 24/25) but
`resolveRoute()` silently bounced every visit back to Setup, and
`router.test.js`'s own coverage assertions had been asserting the
broken list as correct; `createDeathBenefitBeneficiary()` defaulted
every new beneficiary to 100% regardless of what was already nominated
(inert until this spec built the UI to add a second one, at which
point it would have silently double-counted); the Super output table
never displayed `rolloverIn`/`rolloverOut`/`rolloverTax` despite the
engine computing them since spec 26 Commit 1, so a rolled-over account
never reconciled visibly. **Known gap, disclosed, found by the new
reachability test (Commit 5), NOT fixed here:** `plan.employers` (spec
23) has zero reachable UI anywhere in `main.js` — no input section, no
output view, no employerId control on an income row — pre-dating this
spec and outside its own five-commit scope; documented via a
deliberately-failing (`it.fails`) test that will itself start failing,
forcing an update, the moment someone builds it.

### Conservation generator: boundary coverage (spec 28, 2 commits)
`f41b63c` threshold-aware value generation; `317f9ec` coverage
reporting and threshold rule.

`randomScenario()` (`src/deterministic.test.js`) now draws every
registered threshold's value from 5 strata — wellBelow/justBelow/at/
justAbove/wellAbove around it — instead of a uniform range that might
never land near a boundary by chance: every tax bracket/Medicare-
shading/MLS/HELP/LITO/Division-293/296 boundary; the concessional cap,
carry-forward TSB gate, every bring-forward tier (incl. the ~$2.1m nil
tier that hid a real bug), the untaxed plan cap, contribution age
limits, preservation/release age; minimum-drawdown age bands and the
transfer balance cap; age-pension assets/income-test thresholds,
deeming, the Work Bonus's own exempt-annual input, gifting, age
pension age; the 80% LMI/LVR boundary, a land tax threshold; the bond
ten-year date and 125% contribution cap; the projection's own start
month (previously always July). Added 6 degenerate states (zero
balances; a single-year projection; no income; every asset excluded; a
liability larger than all assets; an unfundable goal) and a fourth age
cohort landing near a boundary age. Two spec-named items are
deliberately NOT in the tight registry, disclosed in code: the Work
Bonus BANK figures ($0/$11,800) are a path-dependent accumulated
output no single input draw can stratify (the $7,800 exempt-annual
INPUT that drives it is registered instead); "exactly one year"
doesn't fit a 5-stratum model (no valid "well below 1") and is covered
as a degenerate-state presence case instead. A new coverage-report
test runs a real 2,000-scenario sweep, prints the per-threshold hit
table, and fails if any registered threshold has an unexercised
stratum — CLAUDE.md's "new money flow" rule gained a parallel "new
threshold" rule requiring the same discipline going forward.

Defects found: **none** — a 3,000-scenario sweep (Commit 1) and a
2,000-scenario sweep (Commit 2), both plus every degenerate state,
passed conservation cleanly. The two blind spots that motivated this
spec (the FY-final-month super-drawdown ordering bug; the bring-
forward-nil-tier NCC rejection) were already fixed in earlier work;
this pass found no third instance of the class.

### Employers UI (spec 23 Commit 1, gap closed)
`2f119bd` input UI and per-income-row assignment.

Closes the gap disclosed above and by spec 27 Commit 5's reachability
test (an `it.fails`): `plan.employers` existed in `planState.js`
(`createEmployer`, `resolveEmployerAssignment`, per-employer FBT caps)
with zero reachable UI, so per-employer SG, the maximum contribution
base, and salary packaging by employer type all computed correctly and
could not be configured. Added: a per-person Employers block in Tax
details (name, FBT type, and — when exempt/rebatable — cap fields,
with "Cap not set — enter your employer's current cap" replacing a
silent zero); an employer select on employment income rows defaulting
to the owner's first employer, with a live derived note ("SG 12% on
$X, capped at the maximum contribution base for this employer");
migration handled by the pre-existing `resolveEmployerAssignment`, plus
eager resolution at three live-edit sites (add-row, category change,
employerId edit) so a mid-session edit never sees a stale assignment; a
derived, read-only employer note on `percentOfIncome` salary sacrifice
rows (via `incomeRowId → employerId`, since sacrifice rows carry no
employerId of their own); an employer suffix on the Cashflow table's
income rows, shown only when a person has more than one employer.
`reachability.test.js`'s `it.fails` replaced with a real registry
entry. `createEmployer`/`clampEmployer` gained `nameIsDefault`/
`fbtTypeIsDefault` provenance flags (pure UI flags, never read by the
engine).

Not fixed, disclosed: salary packaging deduction rows have zero UI
(spec 23 Commit 3); bonus/overtime/allowance income categories have no
UI for their own special fields (spec 23 Commit 2).

Regression: new fields are pure provenance flags never read by
`schedule.js`/`annual.js`, so single-employer scenarios are
bit-identical. Browser-verified: one employer at $300k salary → SG
$32,500 (`min($300k, $270,830) × 12%`); a second employer at the same
salary → SG $64,999 (~double, each employer's contribution base capped
independently).

### Salary packaging and income category fields UI (spec 23 Commits 2/3, gaps closed)
Input UI and per-income-row assignment for the two adjacent gaps
disclosed (not fixed) in the entry above.

Salary packaging (Commit 3): a `salaryPackaging` deduction row gains an
employer select and a `packagingType` select. A live note beside them —
reading this row's own FY0 row total off the live projection, plus its
employer's `fbtType`/`fbtCaps`, the same math schedule.js's own
packaging resolution uses — shows cap usage and, where FBT/reportable
fringe benefits apply, states the add-back consequence plainly rather
than a "$ saved" figure (that side needs a full marginal-rate
assessment this row-level note doesn't attempt): a standard employer
gets "no cap benefit — the whole $X packaged is FBT-liable"; an
exempt/rebatable employer gets "$X of the $Y cap used, $Z over" plus
the FBT/RFB figures once either is non-zero; "car" gets a static "never
covered by either cap" note; "exemptItem" gets a static "no cap
consequence" note. The add-back note names all three downstream
effects (HELP repayment income, Division 293 income, Medicare levy
surcharge base) every time it fires.

Income category fields (Commit 2): a "bonus" row gains a payment-month
select and a destination select (loan/super/asset, "the bonus goes to
the mortgage"), reusing the row's own `bonusMonth`/`bonusDestination`
fields that already drove the engine with no UI; an "allowance" row
gains the `taxable` checkbox (some allowances are assessable, some
aren't); an "overtime" row gains a static, read-only "No SG applies —
overtime isn't ordinary time earnings" note (sgApplies is forced off by
the engine, not user-set — the surprising part is worth stating rather
than leaving silent).

`reachability.test.js` gained a FIELD-level registry (not just
collection-level): the existing sweep passed the whole time both gaps
existed, since `DEDUCTION_CATEGORIES`/`INCOME_CATEGORIES` were
themselves genuinely reachable — a collection being reachable doesn't
mean every field on it is. Seven new assertions cover
packagingType/employerId (salary packaging)/the cap-usage note/
bonusMonth/bonusDestination/taxable/the overtime no-SG note
individually.

Regression: no engine files touched, no new plan-state fields — every
field involved already existed with engine treatment and no UI;
scenarios not using these fields are bit-identical. Browser-verified:
an FBT-exempt employer with a $5,000 cap and $7,700 packaged shows "$5,000
of the $5,000 cap used, $2,700 over... ≈$2,394/yr FBT... $5,094 added to
reportable fringe benefits" (exactly `2,700 × 1.8868 × 0.47` and
`2,700 × 1.8868`); switching to a standard employer shows "no cap
benefit... the whole $7,700 packaged is FBT-liable... ≈$6,828/yr FBT...
$14,528 added to reportable fringe benefits" (exactly `7,700 × 1.8868`
and `× 0.47`); a $50,000 bonus redirected to a $300,000 loan reduces its
FY1 closing balance from $251,673 to $232,942 and pays it off three
years earlier (FY5 vs FY8) versus the same bonus with no destination.

### FBT caps: cash labelling, presets, and grossed-up warning; four provenance-doc corrections
`docs/reference/assumptions-provenance.md` (591 lines, verified against
primary sources) landed and identified five defects, all fixed here.

**FBT caps (§4) — the caps were entered as grossed-up, not cash.** The
engine already compared packaged amounts against the cap in CASH terms
and grossed up only the excess (correct), but nothing in the UI ever
said which form to enter, and the ATO publishes the grossed-up figure —
entering $30,000 where $15,900 was meant silently doubled the real
cap. Fixed: both cap fields relabelled "($ cash benefit, not
grossed-up)"; a tooltip giving both forms, the conversion (cash =
grossed-up ÷ 1.8868), and the source/as-at date (ATO, unchanged 31 Mar
2023 – 31 Mar 2027); a warning above $20,000 ("That looks like a
grossed-up figure. The cash equivalent is $X.") with a one-click
"Convert to cash" button; one-click cash-figure presets per employer
subtype (PBI/health promotion charity $15,900, hospital/ambulance
$9,010, FBT-rebatable $15,900, meal entertainment $2,650 for either).

**FHSSS earnings rate (§1.4): 7.94% → 7.43%.** The ATO Shortfall
Interest Charge rate (90-day BAB + 3%, reset quarterly) — 7.43% is the
Jul–Sep 2026 rate. A comment beside the constant now notes the
quarterly refresh requirement.

**Wage growth split by basis (§1.2), a firm decision.** Was a single
3.5% figure used for both row indexation and super-cap indexation.
Now: `assumptions.wageGrowth` (new field, 2.70%, WPI concept —
Xplan-aligned) drives every row's "awote"-labelled indexBasis option
(income/expense/deduction/property/pension/DB/goal/adviser-fee rows —
the stored basis id stays "awote" for schema stability, but the NUMBER
it means changed) and HELP indexation (§5.3 — HELP is legislated to
the lower of CPI and WPI, and 2.70% is itself a WPI-basis rate, a
materially closer proxy than the AWOTE figure it replaces);
`assumptions.awote` (3.2%, was 3.5%) is kept only for what the statute
actually indexes on AWOTE — super contribution caps, the ETP cap,
redundancy base/per-year, the age pension's MTAWE benchmark. Both are
separate Parameters-modal inputs now ("Salary and wage indexation
(WPI)" / "Super cap indexation (AWOTE)"). `realAmountAt`'s (schedule.js)
4th parameter renamed `wageGrowth` throughout, since every call site
already passed the row-indexation figure, never true AWOTE.
Migration (v17→v18): a stored `awote`/`fhsssEarningsRate` value EXACTLY
equal to the old universal default is treated as never having been
deliberately typed and corrected; anything else (a real customisation)
is preserved untouched — disclosed heuristic, see the migration
function's own comment.

**Land value (§7.4): 60% flat → 50% houses / 20% units.** A unit's
land is shared across the whole strata, so it needs its own default,
much lower than a house's. New `dwellingType` field ("house"/"unit")
plus a `landValuePctIsDefault` flag (same one-way-flip convention as
property rent/expenses — recomputes on dwellingType change until the
user types their own figure or the actual unimproved value from a
rates notice, then stops). Defaults FALSE for any property predating
this field (same regression reasoning as rent/expenses' own header) —
existing scenarios keep whatever landValuePct they already resolved to,
bit-identical; only new properties get the dwelling-type-aware default.

**Property expenses (§7.2): 20% → 25% of gross rent.** The midpoint of
the researched 20–30% range, not its floor. Already behind the
existing rent/expenses `isDefault` mechanism, so this is a one-line
multiplier change — a property still tracking the default recomputes
at 25% immediately; an overridden one is unaffected.

**Super caps (§5.4) — confirmed correct, no change.** General transfer
balance cap $2,100,000 and non-concessional cap $130,000 were flagged
by conflicting (stale) secondary sources; the firm confirmed both are
right for FY2026-27. A comment now sits beside each in superRates.js
so this doesn't get "fixed" back down without a firm-confirmed reason.

Gates: full suite 1663/1663, build green. Regression: land-value
default only applies to properties created after this commit (existing
data preserved exactly); property-expenses default recomputes only for
rows already tracking it (isDefault mechanism, pre-existing); wage-
growth/FHSSS-rate corrections apply going forward via the v17→v18
migration's old-default-equality heuristic, disclosed above. Browser-
verified: FBT-exempt $30,000 entry → "That looks like a grossed-up
figure. The cash equivalent is $15,900" with a working Convert button;
PBI/HPC preset button fills $15,900 directly; a new investment
property defaults to 50% land value as a house, 20% as a unit, and
freezes at a typed value even after the dwelling type is changed again;
Parameters modal shows Salary and wage indexation 2.7%, Super cap
indexation (AWOTE) 3.2%, FHSSS associated earnings rate 7.43%.

### Divergence analysis (spec 30, 3 commits)
Measures the engine rather than extending it — quantifies the gap
between this full projection and the naive "snapshot one year, then
hold constant or index at CPI" extrapolation a simpler tool (or a
back-of-envelope guess) would produce, and attributes it to seven named
drivers.

**Commit 1 — static extrapolation model** (`src/staticProjection.js`,
`4165cca`, extended to super/pension in `20c691b`). `projectStatic(state,
opts)` rolls a chosen snapshot year's own per-account real return/rate
(backed out directly from that year's already-computed real-dollar
outcome, never re-deriving fund tax or amortisation) forward flat or
CPI-indexed. Tracks assets, super, pension, and liabilities (closing on
payoff); does NOT track property, bonds, or the Working Cash Account —
disclosed in the module header, and the reason `divergence.js` compares
on a narrowed, scope-matched net-assets figure rather than the real
engine's full one. A `realism` flag bag (7 booleans, default off,
reproduces the naive baseline exactly) substitutes the real engine's own
per-year figure for one component at a time — the mechanism Commit 2's
driver attribution runs on.

**Bug found and fixed in the same area:** the liability tracker read
`state.liabilities` (the plan-state array) for which ids to track, which
never includes the engine's own synthetic `help_<person>` HELP/HECS-debt
entries that DO appear in the real per-year `liabilities` map — a First
Home Buyer scenario diverged 56% AT THE SNAPSHOT YEAR (must be exactly 0
by construction). Fixed by iterating `Object.keys(snap.liabilities)`
instead (`e693e6d`) — generalizes to any future synthetic liability, not
just HELP, per CLAUDE.md's close-the-whole-class rule. Regression test
added with a real HELP-debt scenario.

**Commit 2 — divergence measurement and driver attribution**
(`src/divergence.js`, `4f868ca`). `measureDivergence(state, opts)`
computes the real engine's own comparable net-assets figure per year
(assets + super + pension − liabilities, scope-matched to what the
static model tracks), the by-year gap and % divergence, summary
statistics (divergence at +10/+20/+30 years and at end; first year
exceeding 5%/10%), and re-runs the static model once per driver with
just that one `realism` flag enabled to attribute the final-year gap.
The seven drivers sum to the gap only approximately since they interact
(a loan closing changes how much surplus is available for a
contribution that also stops) — the residual is reported explicitly,
never folded into any one driver's figure.

**Commit 3 — Focus view and committed report.** Focus → Approach
comparison (`src/focusApproachComparison.js`, wired into `router.js`/
`main.js`/`index.html`) runs on the active scenario: a snapshot-year and
indexation-basis selector, the summary strip, a net-assets-over-time
chart (real vs. static), and the driver table with the residual and
total gap as their own rows. `docs/reference/divergence-analysis.md` —
a committed report across four scenarios (First home buyer, Family with
a mortgage, High earner pre-retirement, and a new Retiree demo fixture,
`src/demo/retiree.js`, deliberately NOT added to the "Load demo clients"
list) — is locked in by `src/divergenceReport.test.js` recomputing the
same figures live, not a `toMatchSnapshot`. Two more findings surfaced
while generating it, both disclosed in the report rather than smoothed
over: the residual frequently exceeds the total gap itself (Family
$468k residual vs. $206k gap; High earner $1.80m residual vs. $373k
gap — over four times it); and the retiree scenario's snapshot year 1
(the pension's own commencement year) produces a ~20× larger, dominated-
by-the-one-off-rollover divergence than year 2, so year 2 is used for
that scenario, with the reason stated in the report and covered by a
dedicated regression test.

Gates: full suite 1682/1682, build green. Regression: N/A (new files
and a new Focus view only; no existing money flow or output changed).
Browser-verified: Focus → Approach comparison on a populated demo
scenario (Family with a mortgage) shows the summary strip, driver table,
and residual/total-gap rows with figures matching the committed report;
changing the snapshot-year selector re-renders all figures live; the
net-assets chart falls back to "Chart unavailable" cleanly when Plotly's
CDN is blocked, same as every other chart in this app.

### Engine API (spec 31, 4 commits)
No engine behaviour changed anywhere in this work — it defines and
documents a stable, versioned public boundary (`src/engine.js`) around
the projection engine that already existed, so a second in-house
projection tool (or an external consumer) can run a projection without
reading `deterministic.js`'s internals.

**Commit 1 — public surface and versioned contract.**
`runProjection(input, profiles)` → `ProjectionResult`: on valid input,
`{ engineVersion, figuresAsAt, errors: [], ...projectPlan()'s own
result }`; on invalid input, only `{ engineVersion, figuresAsAt, errors
}` — no partial projection. `validateInput(input)` returns structured
`{ field, message }` errors, never throws; deliberately narrow — only
the handful of shapes (`plan`, `assets`, `cashflows` and its five row
arrays, `assumptions.cpi`) that `clampAllToPlan`/`deterministic.js`
assume without a fallback and would otherwise crash on or silently
corrupt every figure with, since every other collection already
tolerates absence via its own existing guard. `ENGINE_VERSION`
("1.0.0", semantic — a removed/renamed field bumps the major, an added
field bumps the minor) and `FIGURES_AS_AT` ("2026-08"), independent of
`planState.js`'s `SCHEMA_VERSION` (which versions the input).

**Commit 2 — developer documentation.**
`docs/reference/engine-api.md` — getting started with a real worked
example, the full input reference, the output reference (every
top-level and yearly-ledger field, verified directly against
`deterministic.js` rather than assumed from field names — two claims
corrected while verifying: `netAssets`'s exact formula includes
`wcaClosing` and subtracts `heasDetail.closing`; `heasDetail` is always
an object with zeros when no HEAS applies, not object-or-null),
conventions that will surprise a consumer, the versioning rule, the
assumptions a consumer inherits, and what the engine does not model.

**Commit 3 — serialisation and a worked integration example.**
`runProjection`'s result now passes through a `toJSONSafe` transform —
`deterministic.js` uses `Float64Array` throughout `schedule`/`monthly`
for performance, and `JSON.stringify` does not turn a typed array into
a JSON array (it serialises to an object keyed by string indices),
silently breaking the "JSON out" guarantee — found by actually
round-tripping a real result, not assumed. `docs/reference/engine-api.md`
gained a worked integration example (construct a client from JSON via
this app's own `serialize`/`hydrate`, run a projection, read the firm's
row vocabulary via `cashflowStatement.js` and the Snapshot table via
`snapshot.js`) and a stable-identifiers section, both run live as
tests so they cannot rot. A per-owner vs. household-total reconciliation
issue was found in `cashflowStatement.js` while building the worked
example (client + partner does not sum to the household total for a
couple, despite the module's own header comment promising it does) —
out of scope for this spec, queued separately for investigation.

**Commit 4 — contract stability test.**
`src/engineContractShape.js` — `COMMITTED_SHAPE` (a hand-reviewed,
deliberately-updated literal, never a `toMatchSnapshot`), generated by
unioning two demo fixtures' result shapes (First home buyer's FHSSS
scenario + Family with a mortgage, since neither alone exercises
everything) and `compareShapes(committed, live)`: a field the
committed shape has but live output doesn't is an ERROR (fails the
test — a removal or rename); a field live output has but the committed
shape doesn't is a NOTICE only (passes, printed, prompting a deliberate
minor-version bump and snapshot update). Verified directly against
synthetic mutations (a removed field, a renamed field, a type change,
a genuinely new field) before relying on it, same discipline as the
conservation invariant's own guard-verification. `CLAUDE.md` gained the
spec's own stated rule: any commit changing the result shape must
update the contract snapshot and bump the result version in the same
commit.

Gates: full suite 1710/1710, build green. Regression: none (no engine
code touched — `src/engine.js`/`src/engineContractShape.js` are new
files; the only production-code behaviour change anywhere is
`toJSONSafe`'s typed-array-to-Array conversion, which is INSIDE the new
public boundary, not `deterministic.js` itself, so every existing
output/view is untouched).

---

### Aged care (spec 29, 5 commits)
The last large domain gap — residential aged care fees, the RAD/DAP
accommodation decision, the former home's dual treatment, and the 2025
reforms' permanent dual fee regime. Every dollar figure is user/BBB-
supplied (Macquarie Big Black Book, a primary source superseding an
earlier secondary-sourced seed — `23d51de` then `d2f20e9`), stamped with
its covering period and source, never web-searched, with a staleness
warning once a projection runs past that period's end.

**Commit 1 — rates module and fee structure** (`23d51de`, superseded
`d2f20e9`). `src/data/agedCare.js`: `AGED_CARE_RATES_BASE` (old-regime
means-tested-fee brackets/caps; new-regime NCCC+Hotelling brackets/caps;
MPIR; accommodation caps), `basicDailyFeeAnnual` DERIVED from the age
pension's own base rate (85% of the BASIC rate excluding supplements
÷14 days/fortnight — reproduces BBB's $66.80 to the cent; naively using
the all-inclusive rate ÷365 gives a materially wrong $72.71),
`agedCareRatesFor(fyStartYear, ...)` (per-FY bracket/MPIR resolution
with per-figure overrides), `evaluateTieredAmount` (shared nil/taper/
flat bracket-walk for both regimes), `agedCareStalenessWarning`.

**Commit 2 — means testing and the former home** (`e4940ea`, folded
into `d2f20e9`). `src/agedCareMeansTest.js`: two former-home functions
never conflated — `formerHomeAssessedValueForMeansTest` (capped per
person, exempt with a protected person in residence) vs.
`formerHomeValueForAccommodationAssessment` (full market value, same
asset, different purpose). `agedCareAssessableAssets` adds a RAD back in
as assessable — the central, easy-to-invert trade-off the spec names
explicitly (a RAD is Centrelink-exempt but assessable here; a bigger RAD
INCREASES the ongoing fee).

**Commit 3 — accommodation payments and the RAD/DAP decision**
(`c0ef334`). `combinationPayment`/`radRefundOnExit`/`radRealValueAtYear`
(RAD retention, 2025 reforms; nominal refund value decays in real terms
the longer it's held). `src/focusAgedCareAccommodation.js` — RAD-in-
full/DAP-in-full/combination side by side, every arm a real
`projectPlan()` run on a mutated clone (the Focus governing principle),
non-prescriptive.

**Commit 4 — 2025 reforms and the no-worse-off principle** (`c824a42`).
`agedCareRegimeFor(entryDate, optedIn)` → `"old" | "new" | "pre2014" |
null` — a genuine dual fork by entry date, never a migration; a pre-1
Nov 2025 entrant may explicitly opt in but is never silently switched.
`newRegimeContributions` (NCCC+Hotelling, NCCC only after Hotelling
saturates its own max, lifetime cap shared with Support at Home — a
disclosed narrowing since this engine only tracks aged care on it).
`noWorseOffComparison`. The old-regime/pre-2014 paths are structurally
unreachable from any live forward-looking projection (today already
postdates 1 Nov 2025) — disclosed in comments, covered instead by direct
unit tests using historical entry dates.

**Commit 5 — first-class engine integration, input, outputs, and
pre-entry planning** (`279f986`, `2e14150`, this commit). `plan.agedCare[]`
(`createAgedCareEntry`/`clampAgedCareEntry`/`normaliseAgedCare`, no
`superAccounts`/`assets` dependency, single-pass — mirrors
`definedBenefits`' own shape) is now a genuine engine money flow:
`deterministic.js` resolves each entry's `entryAt` exactly like a
defined benefit's `commenceAt`, draws the RAD as a one-off through the
ordinary deficit-funding path, and recomputes the ongoing cost (basic
daily fee, DAP at the entry-fixed MPIR, the means-tested fee/NCCC
contribution) EACH YEAR from that year's real per-person assessable
income/assets — reusing the same figures the Age Pension already
computed, never a second calculation. `ENGINE_VERSION` bumped to
`1.1.0` (additive: `agedCareWarnings`, `row.agedCareDetail`,
`row.agedCareRadPaid`) per spec 31's own contract-versioning rule, with
`engineContractShape.js`/`engine-api.md` updated in the same commit.
`conservationCheck.js` gained `agedCareRadPaid`/`agedCareOngoingCost` as
named leaks, and `randomScenario()`/`THRESHOLD_REGISTRY` gained an
`agedCare` generator stratified around the three governing thresholds —
per CLAUDE.md's own mandatory extension rule, and it earned its keep
immediately: a sign error in `decomposeNetWorthChange()`'s `expenses`
bucket (mirrored from `oneOffs`' own convention instead of accounting
for `expenses` being subtracted, not added, by its caller) was caught on
the very first scenario generated with an active entry — it was silently
creating money equal to 2× the ongoing cost every active year, fixed and
re-verified across four full conservation runs.

Input: an "Aged care" fact-find section (name/owner/entry date/facility/
accommodation price/payment method/RAD amount/extra service fees/
former-home-protected-person/opt-into-new-regime), grouped under Assets
alongside Pension — its own life event, not a pension type. Outputs:
Tables → Aged care (per entry, per year: basic daily fee/DAP/contribution/
extra services/total/cumulative against the applicable lifetime cap —
ids read as the UNION across every year, since an entry's own detail
stays empty before it fires, unlike Bonds' year-0 assumption — a real
bug this view had until browser verification caught it); Key figures
gained "Total cost of aged care (cumulative)" (no separate "estate
position" row — that's exactly what the existing NET ASSETS row already
tracks). Focus → Aged care planning (`src/focusAgedCarePlanning.js`) —
unlike Commit 3's ad hoc estimate, both arms are genuine `plan.agedCare[]`
and `plan.gifts[]` entries run through the real `projectPlan()`: the
current plan against one pre-entry gift, with the gift's timing relative
to the entry demonstrating the deprivation caveat directly (move it
inside five years and the engine's own `gifting.js` deprivation modelling
— not a hand-rolled re-derivation — still counts it at entry).

Gates: full suite 1784/1784, build green. Browser-verified end to end:
add an aged care entry, edit every field, payment-method switch (RAD
disables/zeroes), Tables view populating from the entry's own firing
year onward, Key figures reconciling exactly to the Focus view's own
lifetime total, and the Focus planning view's deprivation caveat firing
correctly for a within-five-years gift and not for a 5+-year one.
Outstanding, tracked separately per the user's own instruction: the
`cashflowStatement.js` household-total reconciliation bug flagged during
spec 31 Commit 3.

---

### Demo clients: comprehensive coverage set
Replaced the three-client demo set with four, chosen for coverage as a
set — every `router.js` output view now has at least one demo client/
scenario producing real data for it, enforced by a new `src/demo/
coverage.test.js` rather than left to a presenter to discover the hard
way. Each client is still a coherent, individually plausible person
first (a feature bolted onto a client with no real reason to have it
undermines a demo more than a missing view), built through the same
real factories and `clampAllToPlan` as before — never a hand-written
state object.

**A — First home buyer** (lightly revised): unchanged single/29/HELP/
FHSSS shape, planned purchase moved to Perth (WA) rather than NSW —
deliberately, so the three property-owning demo clients between them
exercise three different states' stamp duty/land tax schedules, not the
same one three times over.

**B — Family with a mortgage** (substantially extended): gained a
negatively geared investment property in VIC (its own land tax
threshold is low — $50,000 of land value — so an ordinary-priced
property clears it, unlike NSW's $1,075,000), salary packaging through
the partner's FBT-exempt employer, a travel goal, and a fourth "Debt
recycling" scenario. The added property/packaging/goal genuinely
changed this fixture's own numbers, which cascaded into two other
places that had come to depend on its OLD exact figures — both fixed
as part of this same commit, not deferred:
- `engine.test.js`'s worked integration example (docs/reference/
  engine-api.md §9) hardcoded this fixture's own dollar figures;
  recomputed and updated, and its own contract-stability test picked up
  three fields (`goals`, `goalStats`, `schedule.rowTotals.deductions`)
  that had been sitting on `engineContractShape.js`'s own disclosed-gap
  list since spec 31 (no fixture had ever populated them) — now
  captured with their real shape instead of an empty placeholder.
  `ENGINE_VERSION` bumped to `1.2.0` (additive; no new engine fields, an
  existing gap finally closed by richer fixture data).
- `divergenceReport.test.js` and its committed `docs/reference/
  divergence-analysis.md` (spec 30) both reconcile against this exact
  fixture's own numbers; regenerated Scenario 2's own section (the
  divergence at end genuinely flipped sign, +5.0% → −2.5%, and gained a
  third driver) with the real new output, including a note on why the
  10-year horizon shows an eye-catching −438%: a percentage against a
  still-small net-worth base early in a geared property's own equity
  build, not a computation error — the same caution the Retiree
  scenario's own commencement-year note already raises.
- `demo/highEarnerPreRetirement.js` — superseded as a live demo option
  by the new Comprehensive pre-retiree below, but RETAINED (not
  deleted) purely because `divergenceReport.test.js` and its own
  committed report figures are separately anchored to it — the same
  "internal fixture, not a live option" role `demo/retiree.js` already
  has. No numbers there changed.

**C — Comprehensive pre-retiree** (new, replaces High earner pre-
retirement as a live demo option): couple 55/53, $450k combined
income, a deliberately asymmetric $3.2m/$420k super split either side
of the carry-forward threshold (also large enough on the client's side
to trigger Division 296 alongside 293), a negatively geared QLD
property, an education bond (no linked child — present to exercise the
bond engine's own "education" tax treatment specifically), one defined
benefit pension already in payment, death benefit nominations for both,
and an aged care entry firing at 88. Projected to age 95 (`endBasis`
fixedAge, not the default life-expectancy basis). Two real, non-obvious
findings while building it:
- A defined benefit's `commenceAt` resolves against the CLIENT's age
  regardless of whose pension it is (this engine's own documented
  convention) — setting it to the PARTNER's own current age put it
  inside the projection's partial first year (no July to fire an annual
  event in), so it silently never fired at all. Caught by this file's
  own sanity check before it ever reached a test, not discovered later;
  fixed by using the client's own age one plan year in instead.
  Every other age-anchored one-off across all four new clients was
  re-checked against the same class of mistake once this one surfaced.
- The pension-phase design deliberately splits TTR and a genuine
  retirement ABP across two DIFFERENT scenarios (Maximise concessional;
  Retire at 60) rather than both in one, specifically so the
  retirement-phase earnings-tax exemption's presence/absence is
  directly, separately visible (verified: the TTR pension's own
  `earningsTax` is nonzero, the ABP's is exactly zero, on otherwise
  near-identical pensions).

**D — Modest retiree** (new): couple 70/68, ~$420k combined super
already in pension phase, own their home outright, minimal other
assets, a small casual income for the partner (the Work Bonus needs
someone still working to exempt). Draws a near-full age pension — the
age pension actually binding, not the token/zero amount the two
wealthier clients see. The $30,000 gift scenario lands exactly on the
spec's own worked example of the annual ($10,000) vs. five-year
($30,000) limits interacting: $10,000 of a single $30k gift is
allowable, the remaining $20,000 is deprived — verified directly
(`toBeCloseTo(20_000, 0)`), not just asserted nonzero.

**Coverage test and map.** `src/demo/coverage.test.js` — one checker
per `OUTPUT_VIEWS` id (mirroring each view's own Focus-module null-gate
where one exists, e.g. `focus-debt-recycling` requires a real
`liability.recycling.enabled`, rather than re-deriving the condition
from scratch) — asserts every view has at least one populating client/
scenario, and separately asserts every `OUTPUT_VIEWS` id has a checker
registered at all (so a newly added view without one fails loudly
rather than silently passing by omission). `docs/reference/demo-
coverage.md` is the resulting presenter's map — one best client/
scenario per view, with a one-line reason.

Gates: full suite 1854/1854, build green. Browser-swept all four
clients' first scenario across every one of the 37 output views: zero
console errors, zero near-blank renders; every view's own "empty" state
across the sweep was independently confirmed to be a legitimate
per-client gap already covered by a DIFFERENT client/scenario per the
coverage test above, not a real bug.

---

### Retirement: income required (spec 32, Commit 1)
The concept the engine lacked: a stated target retirement income,
tracked as a REFERENCE line against what the plan actually delivers —
never a driver. `plan.retirement.incomeRequired` (`planState.js`):
source (`currentExpenses` default | `custom` — ASFA sources deliberately
excluded from `INCOME_REQUIRED_SOURCES` until Commit 2 gives them
something to resolve against, per CLAUDE.md's Input integrity rule),
`indexBasis`/`indexExtraPct`, `startAt` (a DateRef, defaults to the
`retirement-client` key date), and an optional step-down age/percentage.
New pure module `src/retirement.js`'s `resolveIncomeRequired` reuses
`schedule.js`'s own canonical `realAmountAt` indexation ratio (treating
"months since startAt" as the reference point, rather than literal plan
start — the ratio formula is reference-point-agnostic) and reads
`currentExpenses` from the schedule's own household expense rows at the
resolved start year, not `deterministic.js`'s richer post-property
`row.expenses`. Defensively falls back to the same schema default when
`plan.retirement` is absent entirely (a hand-built fixture that never
went through `clampPlan`), matching `keyDates.js`'s own convention for a
missing `retirementAge` — this is what keeps every pre-existing
`mkState()`-style test in the whole suite behaviour-identical without
individually updating them.

`deterministic.js` writes the resolved figure onto every yearly row as
`row.incomeRequired` (`null` before the requirement's own start year —
never `0`, the same null-means-not-yet-applicable convention as the
aged-care work) via a post-pass once `yearly` is built; nothing else on
any row changes, verified directly (two full projections, one with a
non-default retirement config, differ ONLY in `incomeRequired` once
stripped). `ENGINE_VERSION` bumped `1.2.0` → `1.3.0` (additive);
`engineContractShape.js`'s `COMMITTED_SHAPE` and `engine-api.md`'s
version table/Output reference updated in the same commit.

**Interpretation fixed and stated, per the spec's own explicit
requirement:** Income Required is after-tax income received by the
household — compare it against `income − tax` on the same row, never
against gross drawdown. Stated on the Settings input (a new "Income
Required" block — no other input section fit; the same reasoning gifts/
HEAS already used) and in a new Parameters-modal section
(`#retirement-income-required`), reached via a "More on this" link using
the same `openModal(scrollToId)` mechanism the Monte Carlo view's
volatility-drag link already established, generalised into a reusable
`modalLinkHTML()` since this is dynamically-rendered content (a fixed-id
listener, `openModal`'s own original pattern, would be orphaned on
re-render).

One test fixture fallout, fixed in the same commit: `deterministic.
test.js`'s v5→v6 migration-equivalence gate compares a `hydrate()`ed
plan against a hand-built "native" one that "bypasses hydrate/clamp
entirely" by design — its `retirementAge` had never been set explicitly
because nothing before this commit ever resolved the `retirement-client`
anchor unconditionally for every projected plan. Fixed by setting it
explicitly to the same effective value `clampPerson` derives for the
migrated side, with a comment explaining why.

Tests: `src/retirement.test.js` (11 — both sources, three indexation
bases, step-down before/at/after the trigger age, the no-retirement-
block fallback) plus `planState.test.js` additions (clamp bounds, the
ASFA-source rejection, `clampPlan` always populating the block) plus two
engine-integration tests (reference-only — no other field changes;
regression gate — a bare plan projects bit-identically to one with the
explicit default). Full suite 1872/1872, build green. Browser-verified:
the Settings block renders, source toggle reveals the custom-amount
field, the step-down toggle reveals its fields, and the modal link opens
Parameters scrolled to the new section — zero console errors beyond the
sandbox's own pre-existing Plotly-CDN-blocked network failure.

---

### Retirement: ASFA benchmark standards (spec 32, Commit 2)
`src/data/asfaStandards.js` — the ASFA Retirement Standard, comfortable
and modest (single and couple), plus a modest-renter variant, figures
supplied DIRECTLY by the firm for the March quarter 2026 in this
session's chat (not web-searched — same protocol as aged care/state
duty). **Note on the spec itself:** the user initially pointed to a
"Figures — supplied by the firm, March quarter 2026" subsection of
`docs/specs/32-retirement-phase-one.md`'s Commit 2 as already containing
these figures; re-reading the spec on disk found no such subsection —
only the sourcing INSTRUCTION to ask the user, no figures. Reported back
per CLAUDE.md's "stop and say so" rule rather than silently using the
figures anyway; the user then supplied them directly in chat, which is
what Commit 2 actually needed either way. The spec file itself was not
edited (out of scope for this commit; the user said they'd fix it
separately).

`INCOME_REQUIRED_SOURCES` (planState.js) widens from Commit 1's
`[currentExpenses, custom]` to include `asfaComfortable`/`asfaModest` —
extended in this SAME commit, the one that gives them something to
resolve against, per CLAUDE.md's Input integrity rule.
`retirement.js`'s own re-exported copy was removed in favour of
importing the single source of truth from planState.js (a duplication
from Commit 1, caught and fixed here). `resolveIncomeRequired`'s base-
amount resolution gained a third branch: ASFA sources look up
`asfaAnnual(standard, household)` for the plan's own single/couple
status, then index forward through the SAME formula as every other
source — no special-casing beyond the base figure itself.

**The two disclosures the spec requires "not buried":** the homeowner-
no-mortgage assumption and the "these are ASFA's own terms, not this
firm's judgement" framing render UNCONDITIONALLY in a new Settings
block (`asfaReferenceBlockHTML()`) — comfortable/modest/modest-renter
figures, the household's own single/couple status, always visible
whether or not an ASFA source is actually selected — and again, with
the concrete $ figures, in a new Parameters-modal section
(`#retirement-asfa-standard`). The Source dropdown's own two new options
render as `asfaStandardLabel()`'s exact wording ("ASFA Comfortable
(couple, homeowner)"), matching the spec's own worked example verbatim.

**Ten-category lifestyle descriptor table** — reproduced VERBATIM from
the firm's supplied text (comfortable/modest/modest-renter/age-pension-
only columns), stored in `ASFA_LIFESTYLE_DESCRIPTORS`; a committed test
spot-checks two entries against the exact supplied wording rather than
re-deriving or paraphrasing it. The "home" category is the one place the
renter column describes a different dwelling rather than a degree of
the homeowner column's own repair capacity — ASFA's own framing,
reproduced as given, called out in both the code comment and a
dedicated test.

**Age Pension cross-check, reported not reconciled** (spec's own
instruction): the ASFA source's own quoted maximum Age Pension figures
($31,223 single, $47,070 couple, incl. supplements) are compared
directly against `data/agePension.js`'s independently-sourced
`AGE_PENSION_RATES_BASE` in a dedicated test — **no mismatch found**:
`1200.90 × 26 = $31,223.40` and `2 × 905.20 × 26 = $47,070.40`, both
rounding to the exact firm-supplied figures.

**Staleness** — `asfaStalenessWarning()` mirrors `agedCareStalenessWarning()`'s
own convention exactly (checked against the projection's own final
calendar month, not "today"); surfaced as a new top-level
`retirementWarnings` array, gated on an ASFA source actually being
selected (never raised for a household that never quotes ASFA at all).
`ENGINE_VERSION` bumped `1.3.0` → `1.4.0` (additive); contract shape and
`engine-api.md` updated in the same commit. No new money flow and no
new threshold the engine branches on (ASFA sources swap in a different
FIXED base figure, nothing more) — `randomScenario()`/
`conservationCheck.js` deliberately untouched, same reasoning as
Commit 1.

Tests: `src/data/asfaStandards.test.js` (15 — both household types, the
homeowner-label wording, staleness in/out of window, all ten lifestyle
categories present with four columns each, the age pension cross-check)
plus `retirement.test.js` additions (ASFA sources resolving and
indexing/stepping-down correctly; `retirementWarnings` gating) plus a
`planState.test.js` update (the widened enum). Full suite 1891/1891,
build green. Browser-verified: the Source dropdown carries all four
options with the exact disclosure wording, the reference block and its
staleness warning render in Settings, and the Parameters modal's new
section shows the full comfortable/modest/modest-renter table and the
Age Pension cross-check — zero new console errors.

---

### Retirement: ASFA renter standard and derived homeowner status (spec 32, Commit 2 gap-fill)
The user rewrote `docs/specs/32-retirement-phase-one.md` after supplying
the Commit 2 figures and hadn't pushed the update yet when Commit 2
landed — the version this repo had at the time genuinely lacked the
renter-source and derived-homeowner-status requirements (confirmed by
re-reading the file, same "stop and say so" protocol as the earlier
figures-location question). Once the current spec landed, closed the
gap before starting Commit 3, since Commit 3 doesn't depend on it but
leaving it unresolved risked compounding.

**Homeowner status derived, not asked** (the spec's own heading) —
`src/retirement.js`'s new `deriveHomeownerStatus(properties, liabilities,
retirementYearRow)`: a household owns outright at the Retirement key
date only if it has a `propertyType: "ppr"` property, already purchased
by that plan year, with no balance remaining on any liability whose
`linkedAssetId` points at it. Read from the engine's OWN projected
`yearly` ledger at that year (never re-derived from today's loan terms —
extra repayments, an offset account, and rate changes all move the real
payoff date). No principal residence, or no data at all, defaults to
"renter" — the spec's own stated default, and what every pre-existing
bare test fixture in the suite now resolves to for `asfaModest` (a real,
if narrow, behaviour change from the original Commit 2 landing, where
ASFA sources always assumed homeowner unconditionally).

`INCOME_REQUIRED_SOURCES` widens again to include `asfaModestRenter` —
not disclosed-only reference data as originally built, but the spec's
own "provide an override" mechanism: `asfaModest` auto-derives;
`asfaModestRenter` forces the renter figure regardless, a deliberate
adviser choice expressed as a distinct source value rather than a second
boolean field. `asfaComfortable` is untouched — there is no
Comfortable-renter figure in the firm's own source table, so it never
derives anything.

`resolveIncomeRequired` gained an optional `ctx` parameter
(`{properties, liabilities, yearly}`) — only `asfaModest`'s own
derivation consults it; every other source (and every pre-existing
caller that doesn't pass it) is unaffected. `deterministic.js` threads
`state.properties`/`state.liabilities`/the now-complete `yearly` array
through at the same post-pass call site Commit 1 already established.

Staleness window corrected to match the CURRENT spec's own wording
("more than two quarters old", not Commit 2's original one-quarter
guess) — `ASFA_STANDARDS_BASE.periodEnd` moved from 2026-06-01 to
2026-09-01.

UI: the Settings block's Source dropdown gained the renter option,
labelled "— derived"/"— override" so an adviser can see at a glance
which of the two ASFA-Modest entries is the smart one; a new disclosure
line states the plan's own derived status in plain language, computed
via the SAME exported `deriveHomeownerStatus` the engine itself uses
(main.js calls it directly against `state.properties`/`state.liabilities`
and the real `projection.yearly`, so the UI can never show an answer
that disagrees with what the engine actually resolved). The Parameters
modal's ASFA section gained a paragraph on the derivation mechanism and
the corrected two-quarter staleness wording.

Tests: a new `deriveHomeownerStatus` describe block (7 cases — no PPR,
no data, not-yet-purchased, no loan, loan outstanding, loan paid off,
a loan linked to an unrelated asset); a `resolveIncomeRequired` describe
block covering the same cases through the full resolution+indexation
path; two REAL engine-integration tests using `createProperty`/
`createLiability` and a genuine `projectPlan()` run (not a hand-built
yearly row) to prove the derivation threads correctly end-to-end from
`deterministic.js`. Two pre-existing Commit 2 tests updated to reflect
the corrected (spec-accurate) behaviour — a bare fixture's `asfaModest`
now resolves the renter figure, not the old always-homeowner assumption.
Full suite 1904/1904, build green. Browser-verified: the dropdown's
five options, the derived-status disclosure text, zero new console
errors.

---

### Retirement: analytics summary (spec 32, Commit 3)
`src/retirementAnalytics.js` (pure, tested) — five to seven numbers
answering what the client actually asked; none surfaced as a headline,
per the spec's own instruction. `computeRetirementAnalytics(state,
result)` returns: `retirement` (the Retirement key date's own plan
year/age), `firstShortfallAge` (the existing household-wide unfunded-
cashflow measure — passed through, stated explicitly as different from
Midwinter's super-only "Age ABP Runs Out"), `superPensionExhaustionAge`
(Midwinter's own headline, computed separately: the first plan year the
combined super+pension balance drops to zero after genuinely having
been positive), `capitalAtRetirement`, and two identically-shaped
windows `le`/`lePlus5` (capitalAtLE, averageRetirementIncome,
averageAgePension, averageAgePensionPctOfIncome, sustainableIncomeToLE)
plus a `materialLEDifference` flag comparing the two.

**Life expectancy handling.** The LE anchor reuses `resolveEndBasis`'s
own `{mode:"le"}` calculation — the SAME one `endBasis:{mode:"le"}`
uses for the projection's own end — as a pure REPORTING anchor,
independent of whatever endBasis a given plan actually ends on (a plan
fixed to age 95 still wants "capital at LE" reported against the
client's actual life expectancy). LE+5 is the same calculation at
`offset:5`.

**Sustainable income to LE** is the one figure that couldn't be a
straight pass-through — genuinely needs new trial projections for a
spend level nobody has entered. The spec says "uses the existing
solveFor machinery"; built with `bisectScalar`/`solveFor` targeting net
assets at LE = 0 first, per that literal wording, then found — verified
empirically, not assumed — that net assets at LE PLATEAUS above zero
once spend exceeds what's fundable (assets floor at 0, the excess goes
unfunded, per this engine's own convention), making zero an
UNREACHABLE root for bisection. Switched to `findMinimumThreshold`
instead — also "the existing machinery" in `solve.js`, and the
primitive its own header names for exactly this plateau shape — solving
"the smallest spend that first triggers a shortfall by LE," minus a $1
safety margin so the reported figure is confirmed on the safe side, not
sitting on the boundary that fails. `solve.js` gained a new
`"syntheticExpense"` vary kind — the first that APPENDS a new household
expense row to the cloned state rather than editing one, since there's
no real row to vary (a hypothetical retirement spend, not something the
client has entered).

Tests: `superPensionExhaustionAge`/`meanOverWindow`/
`isMaterialLEDifference` exported and hand-verified directly against
synthetic yearly-row arrays (no engine run needed — exact, fast);
`solve.test.js` covers the new vary kind; `retirementAnalytics.test.js`
covers the full pipeline through real `projectPlan()` runs — LE/LE+5
plan-year resolution checked against `remainingLE(65,'male')=20.22`'s
own hand-verified figure (from `lifeTables.test.js`), capital-at-
retirement at a genuinely mid-projection retirement age, average-
income/average-pension cross-checked by independently re-summing
`result.yearly` in the test itself, first-shortfall-age matched exactly
against `result.shortfall`, and — the spec's own required test —
applying the solved sustainable income back as a real expense row and
confirming the plan lasts to LE with no shortfall. Full suite
1928/1928, build green. (One pre-existing, unrelated flake observed and
confirmed not caused by this commit: `deterministic.test.js`'s
randomized threshold-coverage sweep occasionally misses the narrow
`pension.minDrawdown.90.at` stratum by chance across its fixed sample
size — nothing in `randomScenario()` or pension code was touched here.)

**Scope note:** the spec's "rendered as a summary card at the top of
the retirement view" describes forward-looking consumption, not a
Commit 3 deliverable — no "Retirement" output view exists yet to host
one (Commits 1–2 only touched the Settings input and Parameters modal),
the commit is explicitly named `(pure, tested)`, and its own Tests line
lists computational checks only. Treated as scope for whichever later
commit actually builds that view, same as Commit 1's own reasoning for
deferring ASFA sources to Commit 2.

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
- **HEAS age-component table** (`src/data/heas.js`) — the interest rate
  (3.95% pa, fortnightly compounding) and the 150%-of-maximum-pension
  drawdown cap are well-sourced; the total-loan-cap age-component table
  is a SPARSE set of publicly-quoted anchor points, piecewise-linearly
  interpolated — direct access to Services Australia's/DVA's own
  published tables was blocked by network egress in this environment.
  Confirm the full table against the firm reference before relying on
  the loan-cap figure for advice.
- **HELP/HECS balance indexation basis** — indexed annually at the lower
  of CPI and AWOTE (AWOTE proxying WPI, the post-1 June 2023 "lesser of"
  legislative basis) — confirm against the firm reference before relying
  on this for advice.
- **FBT caps for salary packaging** (`employer.fbtCaps` — living-expense
  cap, meal-entertainment cap, and the rebate percentage for an
  FBT-rebatable employer) — NOT in the firm reference at all, unlike
  every other item on this list, so there is deliberately NO built-in
  default figure (not even an "indicative" one) — the fields start at 0
  (nothing exempt) until the adviser enters the real, current cap.
  Confirm the ATO's published FBT-exempt/rebatable caps before relying
  on this for advice. The gross-up rate (1.8868) and the FBT rate (47%)
  are the ATO's own long-standing statutory constants, not caps, and are
  built in.
- **Education bond benefit mechanics** (`bonds.js`'s `bondEducationBenefit`,
  spec 25 Commit 3) — direct fetch of a PDS or ATO page was blocked by
  this environment's own egress controls for every provider/ATO/
  financial-media domain tried. The specific numeric mechanic built
  ("$30 recovered for every $70 withdrawn from the earnings component,
  for an eligible education expense") is corroborated across two
  independent web searches that both surfaced the SAME figure quoted
  from a named provider's own education-bond materials (Australian
  Unity's Lifeplan Education Bond) — judged adequate to implement the
  real mechanic rather than falling back to the plain-investment-bond
  treatment, but this is corroboration, not a primary-source
  confirmation. Confirm against the actual PDS before relying on this
  for advice. Not modelled at all (no source found either way): any
  annual/lifetime cap on the benefit itself.
- **Defined benefit income cap** (`superRates.js`'s `dbIncomeCap`, spec
  26 Commit 2) — not a standalone firm-reference figure; DERIVED as the
  general transfer balance cap ÷ 16 (ITAA97 s307-462(3)), which the
  au-fy-figures skill's own current $131,250 figure confirms exactly
  against the $2,100,000 GTBC already in this file. A stronger basis
  than a bare assertion, but still confirm against the firm's own
  current published DB income cap before relying on this for advice —
  particularly in a year the GTBC itself hasn't just moved, where a
  directly-published cap could in principle diverge from the derived
  one.

### Deferred — do not build

Accumulated across specs 11–15; see each spec's own "Deferred" section
for the reasoning behind each item.
- Salary packaging and novated leases (FBT mechanics are a separate
  build); debt recycling (needs loan drawdowns); trust distributions,
  foreign income, and SAPTO (spec 11 — these still emit as zero rows to
  preserve the worked document's table shape; taxable pension
  component, TTR offset, and Centrelink/age pension payments — also
  spec 11 zero-rows originally — are done, see specs 20/21a above).
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
