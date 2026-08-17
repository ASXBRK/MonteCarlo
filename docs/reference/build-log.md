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

1. **Surplus allocation UI, outputs, and advice signal** (spec 16, Commits
   2–4) — the settings editor for periods/allocations/remainder, the
   Cashflow/Liabilities table breakdown and a Focus → Surplus allocation
   view, and the non-deductible-first interest-saved figure. The model and
   engine (Commit 1) are done — see DONE above.
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
