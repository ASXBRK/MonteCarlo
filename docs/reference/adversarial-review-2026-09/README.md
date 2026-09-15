# Adversarial review — MonteCarlo projection engine

Reviewed: `ASXBRK/MonteCarlo` at commit `c0a27df` (branches
`claude/monte-carlo-investment-app-R9XSB` and `claude/lucid-ptolemy-rxca4k`
point at the same commit). Suite: 86 files, 2,127 tests, all green.
Figures checked against the Macquarie Big Black Book 2026/27 (20 Mar 2026
rate period), the firm's own source.

Every finding below was reproduced by running `runProjection` (or the pure
module) with a constructed scenario. The scripts are in `probes/` and run
from that directory with `node <name>.mjs`. Nothing here rests on reading
alone. Where a hand calculation is given it is in real (today's) dollars,
the engine's own unit.

Scope. Two passes. The first covered the engine's money movement, the
Australian rules, plan-state hydration and the Monte Carlo core (findings
1.1–1.9, 2.1–2.4). The second pass, done serially after four parallel
auditors were lost to an API rate limit, covered the chart and table
renderers in `main.js` and the pure series modules behind them, the CSV
exports, every comparison / what-if / focus arm, the non-prescriptive-voice
audit, the edge-case probes the first pass had listed but not run, and the
section 7 suspicions (each now confirmed or cleared). `main.js` imports the
DOM and Plotly so it cannot be executed in Node; its renderers were read
line by line and every series they plot was reproduced through the pure
module it calls (`outputSeries.js`, `chartSeries.js`,
`cashflowCategories.js`, `cashflowStatement.js`, `snapshot.js`) and
reconciled against the ledger by probe. Findings from the second pass are
1.10–1.14, 2.5–2.9, and the additions to sections 3–8.

---

## 1. Critical — wrong numbers

Ordered by consequence.

### 1.1 One-off events dated in a partial first year never happen at all

**Where.** `src/deterministic.js` — `julyOf(y)` (line 909) returns `null`
for plan year 0 whenever `plan.start.month !== 7`. Six event types resolve
their firing month as `julyOf(resolvedYear)` and treat `null` as "never
fires within the projection": pension commencement (`pensionCommenceMonth`,
line 935), defined-benefit commencement (line 946), gifts (line ~1070),
super rollovers (line ~1041), pension commutations (line ~1027) and aged
care entry (`agedCareEntryMonth`, line 989). None of them walks forward to
the next July and none emits a warning. The UI's date controls for all six
allow the client's current age as the minimum (`clampDateRef(...,
plan.client.currentAge, ...)`, `planState.js` 2165/2263; `main.js` 7493,
7753, 8028), so the state is enterable.

**What is wrong.** The locked convention says annual rows and one-offs
"skip" a partial first year. For a recurring annual row that means the
row resumes next July. For these six events "skip" means the event is
deleted from the projection. A retiree entered in September who "commences
an account-based pension at 70 (now)" never gets a pension: super stays in
accumulation for the whole projection, taxed at 15% on earnings, no
minimum drawdown, no pension payments; the household's deficit is met from
the released-super fallback instead. An aged care entry "at 85 (now)"
produces no fees for the rest of the projection. A gift "now" never leaves
the estate and is never assessed as deprivation.

**Reproduction.** `probes/probeA.mjs` and `probes/probeG.mjs`. Client 70,
retired, $600k super, ABP commencing at age 70 drawing the minimum, $45k/yr
living expenses.

| Start month | Pension commenced | Pension payments yr 1 | Super closing yr 17 | Pension closing yr 17 |
|---|---|---|---|---|
| July | $600,000 | $30,000 | $2,931 | $406,745 |
| September | never | $0 | $692,281 | $0 |

`probeG.mjs`: gift $100k at 70, aged care entry at 70 with $400k RAD, super
rollover $100k at 70. July start: gift $100,000, aged care $71,511 in year
1 and every year after, rollover $100,000. September start: all three are
$0 in every year. `superWarnings` and `agedCareWarnings` are empty in both
cases apart from the standing rate-staleness note.

**Correct behaviour.** Either fire the event at the plan start month (a
commencement or entry is a state change, not a July cashflow), or walk
forward to the next July as the pension gate already does for the
condition-of-release age, or make the date unenterable and say why. The
property purchase control already does the third (`main.js` 6263) — that
is the pattern to copy. The demo fixtures work around this by hand
(`src/demo/retiree.js` header, `modestRetiree.js` line 40): "commence one
plan year after currentAge... a demo anchored to today almost never starts
in July". A workaround the demos need is a defect real clients will hit.

**How verified.** Code read of `julyOf` and each resolver; probes above;
conservation invariant passes on the September scenario (the money is not
leaking, the event simply does not exist).

### 1.2 Total superannuation balance excludes pension-phase balances

**Where.** `src/deterministic.js` line 5035:
`tsbPriorJune = superAccountsByOwner[p].reduce((s, id) => s + superBal[id], 0)`.
Only accumulation accounts are summed. `tsbOpening` and the Division 296
`closingTsb` (line 5967) are built the same way; Division 296 `earnings`
(line 5968) sums accumulation earnings only. The spouse-offset TSB test
(line 5782) and the co-contribution path use the same accumulation-only
sum.

**What the law says.** Total superannuation balance (ITAA97 s307-230) is
the accumulation phase value plus the transfer balance (retirement-phase
value) plus rollovers in transit. An account-based pension is inside TSB.
TSB gates: the carry-forward concession (< $500,000), the bring-forward
tiers ($1.84m / $1.97m / $2.1m), the nil NCC cap (≥ $2.1m), Division 296
(> $3m), the co-contribution (< $2.1m) and the spouse offset (< GTBC).
Division 296 earnings include net exempt current pension income, i.e. the
pension account's earnings.

**Consequence.** Any client with money in pension phase is tested on the
wrong figure. Four probes:

- `probeB.mjs` B1 — client 66, $3.6m ABP + $100k accumulation (TSB $3.7m).
  Engine Division 296: $485 in FY2027–28 (from the year-0 opening balance
  before the commencement transfer), then $0 every year for 18 years.
  Hand calculation year 1 (FY2027–28): TSB ≈ $3.64m, earnings ≈ $152k
  (pension $147k + accumulation $5k); tax = 0.15 × (0.64/3.64) × 152k ≈
  $4,000, continuing until the balance falls below $3m around FY2039–40.
  Roughly $35k of tax over the projection reported as $485.
- `probeB.mjs` B2 — client 61, $312k accumulation + $898k ABP (TSB
  $1.21m), $90k personal deductible contribution in FY2027–28 with five
  years of unused cap seeded. Engine: `carryForwardAvailable` $112,500,
  contribution accepted in full, `excessConcessionalContributions` 0.
  Law: TSB ≥ $500k at prior 30 June, no carry-forward; excess CC ≈
  $90,000 − $31,707 = $58,293, taxed at marginal rate less 15% offset.
- Bring-forward tiers and the nil tier: a client with $1.9m in pension and
  $100k in accumulation is read as TSB $100k and offered the full $390k
  bring-forward. Not separately probed; same line of code.
- Division 296 for the pension itself is never assessed even when the
  accumulation TSB test happens to pass, because `earnings` excludes
  pension earnings.

**Correct.** TSB = Σ accumulation + Σ pension balances (+ DB interests
where relevant) for the same owner, at the same measurement date, in every
one of these tests. Division 296 earnings = accumulation gross earnings +
pension gross earnings.

### 1.3 Saved plans reopen with different numbers: `hydrate` drops fields `clampAllToPlan` keeps

**Where.** `src/planState.js` `hydrateSuperContributions` (line 4169)
rebuilds each row from an explicit field list that omits `fhsssEligible`,
so `clampSuperContribution` (line 1924) receives `undefined` and forces
`false`. `hydrateAsset` (4106) and `hydrateIncomeRows` (4205) likewise omit
`excludeFromRetirement` / `excludeFromRetirementReason` (spec 35 Commit 3).
Super accounts keep theirs (line 1619) — the asset and income-row copies of
the same feature do not.

**Consequence.** Every path that reads a stored plan — page load from
localStorage, JSON import, scenario duplication if it goes through
`hydrate` — silently turns FHSSS off and un-excludes every excluded asset
and income row. `probeJ.mjs` runs all 15 demo scenarios through
`hydrate(JSON.stringify(state))` and diffs the projections:

| Scenario | Field lost | Max `netAssets` difference |
|---|---|---|
| First home buyer / Buy 2030 with FHSSS | `fhsssEligible: true → false` | **$192,213** |
| all 14 others | `excludeFromRetirement` (false → undefined, no numeric effect while false) | $0.00 |

Setting `excludeFromRetirement: true` on an asset and an income row in the
comprehensive pre-retiree demo and round-tripping: both revert to
`undefined`; the super account's flag survives. The engine reads the asset
flag at `deterministic.js` 1514 to drop the asset from `fundingOrder`, so
a saved exclusion reappears in deficit funding on reload.

**Class.** `hydrate*` functions are field whitelists maintained by hand
and lag the schema. The brief already knew about `display.snapshotYears`
and `labelIsDefault`; these are two more of the same shape. The fix that
closes the class is to make `hydrate` delegate to the same clamp path
`clampAllToPlan` uses, or to add a test that round-trips
`randomScenario()` output through `hydrate` and asserts a bit-identical
projection.

### 1.4 A bonus directed to super bypasses the non-concessional cap entirely

**Where.** `src/deterministic.js` lines 4010–4020 (bonus destination
credit): `superBal[target] += consumed; superTaxFree[target] += consumed;`
with no call to `processNonConcessionalCap`, no addition to `grossNCC`, no
bring-forward tracking, and no TSB test. The amount is also recorded only
in `superDetail.contributions`, never in `superDetail.nonConcessional`, so
the Super table's NCC line understates it.

**Reproduction.** `probes/probeE.mjs`: client 55, TSB $2.6m (≥ $2.1m, so
the NCC cap is nil under s292-85(2)), $200k salary plus a $300k bonus each
year with `bonusDestination: superContribution`. The engine credits
~$159k after-tax to super every year for five years ($790k of tax-free
component by age 60) with no warning. Law: the whole $790k is excess NCC —
either refunded with associated earnings taxed, or taxed at 47% if left in
the fund. The same $159k entered as an ordinary NCC row is rejected with a
warning, so the two entry paths for the same money give different answers.

### 1.5 An open bring-forward window ignores a later TSB at or above the general cap

**Where.** `src/Tax/superContributions.js` `processNonConcessionalCap`
lines 111–115: when `bringForward` is active, `capThisYear = bf.remaining`
with no TSB check.

**Law.** ITAA97 s292-85(2): the NCC cap for a year is nil if TSB
immediately before the start of that year ≥ the general transfer balance
cap, whether or not a bring-forward period is running. The BBB states it
directly: "Existing bring-forward period: remaining cap is nil for
FY2026/27 if TSB ≥ $2.1m at 30 Jun 2026."

**Reproduction.** `probes/probeC.mjs`: client 60, super $1.8m, NCC $200k
in FY2026–27 (triggers a 3-year window, $190k remaining), NCC $190k in
FY2028–29 when the opening balance is $2,137,215 real (≈ $2.245m nominal,
above the GTBC). Engine accepts $190,000 with no warning. Law: nil.

### 1.6 Monte Carlo applies no market shock to pension-phase balances

**Where.** `src/monteCarlo.js` `holdingsFor` (line ~207) builds the shock
set from `state.assets` and `plan.superAccounts` only. `deterministic.js`
line 2810 does call `shockFor(id, m)` for a pension id, but the generator
never produced a series for it, so the shock is always 0. Bonds are
likewise never shocked (line 2374 calls `shockFor(b.id, m)` for an id that
is not a holding).

**Reproduction.** `probes/probeH2.mjs`: identical client (66, $800k High
Growth, $70k/yr spend, 300 paths, seed 7, CPI σ 0), held either as an ABP
commenced at 66 or left in accumulation.

| Holding | p10 at year 13 | p50 | p90 | Probability of ruin |
|---|---|---|---|---|
| Account-based pension | $514,764 | $531,765 | $549,288 | 0.0% |
| Same money in accumulation | $241,778 | $435,626 | $690,440 | 4.3% |

The pension fan is ±3% around the median after 14 years of a High Growth
allocation; the accumulation fan is −45% / +58%. Every retiree whose
wealth is in pension phase — the tool's core audience — gets a probability
of ruin and a fan chart that carry no market risk. The Retirement page's
"probability of ruin", "maximum sustainable spend at a ruin tolerance" and
outcome buckets (specs 34–36) are built on this output.

### 1.7 Death benefit tax on an untaxed-status account uses the taxed-element rate

**Where.** `src/deterministic.js` `computeDeathBenefitForPerson` (line
~278): `taxableUntaxed: 0` unconditionally for every super account; the
comment says "this tool has no untaxed-source fund concept anywhere", but
spec 26 added `taxedStatus: "untaxed"` to super accounts (`planState.js`
1605) and the engine uses it for lump-sum tax (`creditUntaxedCap`,
`withdrawFromSuperTaxed`).

**Law.** Lump-sum death benefit to a non-dependant: taxable component,
element untaxed 30% + Medicare = 32%; element taxed 15% + Medicare = 17%.
GESB West State Super is an untaxed scheme and the firm is in Perth.

**Reproduction.** `probes/probeF.mjs`: client 70, $500k account, adult
child (non-dependant) 100% beneficiary, projection to 72.

| `taxedStatus` | Terminal balance | Engine tax | Law |
|---|---|---|---|
| taxed | $765,129 | $130,072 (17.0%) | $130,072 |
| untaxed | $863,792 | $146,845 (17.0%) | $276,413 (32%) |

Understated by ~$130k. `focusDeathBenefits.js` reuses the same
`deathBenefitTax` and the same `taxableUntaxed: 0` inputs, so the
alternative-nomination comparison inherits it.

### 1.8 Division 293 income (and HELP repayment income) exclude the year's net capital gain

**Where.** `src/deterministic.js` line 5799: `taxableIncome:
assessed[p].taxableIncome`, where `assessed` is the pre-CGT assessment
(`netCapitalGain: 0`, line 5623). `newPendingDiv293` is never recomputed
after the a2 block adds the realised gain (`real[p].netCapitalGain`, line
6061). HELP repayment income (line 5474) is built the same way; its
comment discloses the omission, the Division 293 code does not.

**Law.** Division 293 income = income for surcharge purposes (taxable
income including net capital gains + reportable fringe benefits + net
investment loss + ...) + low-tax contributions. HELP repayment income
starts from taxable income, which includes the net capital gain.

**Reproduction.** `probes/probeD.mjs`: client 50, $230k salary (SG $27,600),
sells $400k of a $500k share portfolio with $100k cost base in July 2026
(net discounted gain $159,918).

| | Engine | Law |
|---|---|---|
| Div 293 income FY2026–27 | 233,815 + 27,600 = 261,415 | 233,815 + 159,918 + 27,600 = 421,333 |
| Div 293 paid July 2027 | $1,712 | 15% × 27,600 = **$4,140** |

On the "known discrepancy" the brief asked about: the spec
(`tier1-2-super-spec.md` §Division 293), `assumptions-provenance.md`,
`engine-api.md` and the code all agree — assessed on FY t's own
contributions and income, paid July of FY t+1. That is the right basis. In
practice the ATO issues the notice after the return and the fund's
reporting, so payment usually lands mid FY t+1 rather than in July; a
timing simplification, not a wrong annual total. The wrong number is the
income base above, not the timing.

### 1.9 The personal transfer balance cap ratchets upward in real terms

**Where.** `src/deterministic.js` line 5014:
`generalCapDelta = superRatesY.generalTransferBalanceCap − lastTransferBalanceCap`,
where both are the **real** (deflated) GTBC from `superRatesFor`.
`indexTransferBalanceCap` (`pensionTba.js` 46) applies only positive
deltas. The real GTBC falls every year the nominal cap does not step
(nominal held, deflated by CPI) and jumps when it rounds up $100k. Only
the jumps are added; the drift down is never subtracted.

**Reproduction.** `probes/tbc-ratchet.mjs`, CPI 2.5%, a person who has
never started a pension (0% used, so by law personal cap = general cap):

| FY | Real GTBC | Engine personal cap |
|---|---|---|
| 2036 | $2,031,116 | $2,285,484 |
| 2046 | $2,074,921 | $2,431,001 |
| 2066 | $2,085,611 | $2,563,738 |

23% overstated after 40 years. `row.transferBalance.personalCap` and
`remainingCap` (shown in the Super view) are wrong from year 1 of the first
step onward, and a $2.4m commencement in 2046 that is ~$325k over the cap
raises no `tbaExcess` warning. This is a nominal-versus-real leak: the
stored TBA credits are real dollars at credit time and, because
proportional indexation tracks CPI, comparing them against a real personal
cap that simply *stays* at its plan-start value would have been
approximately right. Adding the real jumps on top is the error. The fix is
to compute the delta in nominal dollars (`nominal_t − nominal_{t−1}`,
deflated once), or to index the personal cap by the unused proportion of
the **nominal** step and hold it in nominal terms alongside nominal
credits.

### 1.10 Every cashflow-side output omits pension payments, and the age pension is in `row.income` but not in any category

**Where.** Pension payments are credited straight to the working cash
account (`deterministic.js` c-pension block, ~3660: "NOT folded into
`inc`/row.income"), as are the released-super deficit draws (line 4140)
and "expenditure" pension draws (line 4060). Nothing on the display side
adds them back:

- `cashflowStatement.js` has no pension-payment or super-withdrawal line
  at all (grep for `pensionDetail`/`payments`/`withdrawals` finds only
  comments). "Cash Received" is take-home pay + tax return + after-tax
  bonus + other tax-free income; "SURPLUS INCOME" = cash received − expenses.
  The age pension is placed in the Assessable Income section as
  "Government/Centrelink Payments" but deliberately excluded from every
  total (line 127 comment).
- `cashflowCategories.js` `incomeCategorySums` (line 56) sums employment,
  rental, distributions, WCA interest and "other"; the age pension is in
  none of them, although `row.income` includes it. The module header
  claims the categories "reproduce the engine's row.income exactly".
- `main.js` `buildKeyFiguresGroups` "Total income" (line 11134) and
  "Surplus / (deficit)" read those sums and `row.surplusOrDeficit`; the
  Cashflow bars chart (10160) and Income sources chart (10236) read the
  same sums (Income sources adds the age pension as its own band; Cashflow
  bars does not).

**Reproduction.** `probes/probeL.mjs`, `probes/probeK.mjs`. Client 70,
$600k ABP paying the minimum, $40k savings, $45k/yr living expenses, July
start. The working cash account grows every year.

| FY2026–27 | Ledger | Cashflow statement / Snapshot | Key figures |
|---|---|---|---|
| Pension payments received | $30,000 | not shown | not shown |
| Age pension received | $24,429 | shown in Assessable Income, excluded from totals | not in Total income |
| Cash Received total | | **$0** | Total income **$42** (WCA interest) |
| Expenses | $45,000 | $45,000 | $45,000 |
| SURPLUS INCOME / Surplus (deficit) | WCA +$9,471 | **($45,000)** | **($20,529)** |

The Snapshot view is the table the build log describes as the one pasted
into the file note. For a retiree it shows a $45,000 annual deficit while
the household's cash rises. The Cashflow bars chart shows income bars of
$42, expense bars of $45,000 and a surplus line at −$20,529; the composite
chart (2.5) shows nothing at all for the $30,000 of pension drawdown.

**Correct.** Pension payments, expenditure-pension draws and released-super
draws are household cash receipts and belong in Cash Received (and in a
drawdown category on the charts); the age pension belongs in every income
total that claims to reconcile to `row.income`. Until then the reconciliation
claims in `cashflowCategories.js` and `outputSeries.js` are false for any
household past age pension age.

### 1.11 "Total assets", "Super balance" and two charts omit pension-phase and bond balances

**Where.** `main.js` 11104 (Key figures, Total assets): `closingBalance +
propertyClosing + superClosing + wcaClosing`; 11143 (Key figures, Super
balance): `superClosing`; 16738 (Scenario comparison "total-assets" and
"super-balance" series): the same two formulas; `chartSeries.js` 63–101
(`debtVsAssetsSeries`, `superVsNonSuperSeries`): the same, so the Debt vs
assets and Super vs non-super charts inherit it. `pensionClosing` and
`bondsClosing` are part of `row.netAssets` (engine-api §4) but not of any of
these.

**Reproduction.** `probes/probeK.mjs`, same retiree plus a $100k bond:

| FY2026–27 | Value |
|---|---|
| `row.netAssets` (no liabilities) | $746,846 |
| Key figures / Debt vs assets "Total assets" | **$51,582** |
| Key figures "Super balance" / Super vs non-super "Super" | **$1,720** |
| Pension closing (omitted) | $592,722 |
| Bond closing (omitted) | $102,543 |

Key figures shows Total assets $51,582 and NET ASSETS $746,846 on adjacent
rows with no liabilities to explain the gap. Every retiree with an
account-based pension is affected; the Scenario comparison page compares
scenarios on the same wrong series.

### 1.12 The deficit fallback drains a super account that is excluded from retirement funding

**Where.** `deterministic.js` 4136: the released-super fallback iterates
`superIds` and checks only `superReleased[owner]`; it never reads
`superMeta[id].excludeFromRetirement`. The same flag is honoured for
financial assets (1514, dropped from `fundingOrder`) and for the
income-driven pension top-up (~4175). The Setup control says the account is
"excluded from retirement funding".

**Reproduction.** `probes/probeR.mjs`. Client 66, Super A $300k marked
excluded ("Legacy for children"), Super B $20k, cash $100k marked excluded,
$60k/yr spend, no other income.

| | Excluded cash | Excluded Super A |
|---|---|---|
| Drawn on to fund the deficit | never ($100k → $121k over 20 years) | **$60,000 in year 1, then ~$30k/yr until empty in FY2036–37** |

Once Super A and Super B are exhausted the projection reports unfunded
cashflow of ~$25k/yr while $120k of cash sits excluded — the two exclusion
flags behave oppositely. This was section 7's second item; confirmed.

### 1.13 Comparison arms that produce the same projection as their baseline

This is the failure mode the brief said had happened twice before. It has
happened again, in four places. `probes/probeM.mjs` runs every arm listed
in section 8 and prints the maximum year-by-year net-assets difference
between arm and baseline; `probes/probeO.mjs` covers the aged care
accommodation arms.

| Arm | Scenario | Difference | Cause |
|---|---|---|---|
| Aged care planning, "Gift N years before entry" | Modest retiree demo (Sept start), entry at 76, default 6 years → gift at current age 70 | **0** in every year and in cost of care | 1.1: gift resolves to plan year 0 of a partial year, never fires. `focusAgedCarePlanning.js` 62 clamps the gift age up to `currentAge`, not to the first year that has a July |
| Aged care accommodation, RAD vs DAP vs combination | Same demo, entry at current age 70 | RAD arm pays **no RAD** ($500,000 lump sum at `age: entryAge` never fires); fees start a year late | 1.1 again (`focusAgedCareAccommodation.js` 118–147). The RAD arm then shows the *most* remaining assets ($1,095,315 vs DAP $1,077,561 in FY2027–28) and an estate of $1,182,971 that includes a real-adjusted refund of a RAD that was never paid — the RAD is presented as free |
| Retirement lever "Retire later" (65 → 68) | Comprehensive pre-retiree demo | **0** | `applyRetireLater` changes `plan.client.retirementAge` only. It bites only through rows anchored to the retirement key date. The demo's salary rows run start → end (see 2.8), and any client whose salary row ends at an explicit age gets the same nothing |
| Retirement lever "Spend less" ($40k / $30k) | Pre-retiree demo; Modest retiree demo | **0** and **0** | `applySpendLess` sets Income Required and `incomeDrivenDrawdown`, which only alter "Fund expenditure shortfall" pensions. Expense rows are untouched, so spending, shortfall and ruin cannot change for any plan without such a pension. `solveSpendLess` then bisects a flat function |

The levers panel reports a non-converged lever as "This lever alone did not
converge — even at its own outer bound, the effect on ruin probability isn't
enough by itself" (`main.js` 16268). For the two levers above the effect is
zero because the lever changed nothing, and the sentence says otherwise.

The focus age-pension-strategy gift arm handles the partial first year
correctly (`focusAgePensionStrategy.js` 47 bumps the gift to year 1) —
the fix exists in one module and not in the other two.

### 1.14 The crash what-if inherits 1.6: a 30% crash barely moves a pension-phase retiree

`sequenceRisk.js` `crashHoldings` (line 65) builds the crash set from
assets and accumulation accounts only, like `monteCarlo.js` `holdingsFor`.
`probes/probeM.mjs`: client 66 with $800k in a High Growth ABP, 30% drop
with a 3-year recovery at every representative age → maximum net-assets
difference **$357** (the single July month before commencement). The same
money left in accumulation moves by $632k–$840k in the pre-retiree demo.
The What-if crash view for a retiree is a chart of three near-identical
lines labelled "Early", "Mid-career" and "Near retirement" (see 2.7).

---

## 2. Serious — misleading output

### 2.1 Age pension is treated as non-assessable income, and the output does not say so

`deterministic.js` (age pension block, ~4700) and `cashflowStatement.js`
127 treat the age pension as non-assessable because SAPTO is not modelled.
The only disclosure is a code comment; `main.js` contains no user-visible
statement of this choice (grep for "non-assessable", "SAPTO" finds one
always-zero table row). The age pension is taxable income; SAPTO offsets
it for a full pensioner with no other income, but a part-pensioner with
other taxable income pays real tax on it. Example, single, $30k other
taxable income + $15k age pension: with the pension assessable, tax ≈
$4,020 + $900 Medicare − $325 LITO − $1,109 SAPTO ≈ $3,486; with the
engine's treatment ≈ $1,269. About $2,200/yr understated for a common
client shape. This needs a stated caveat on the Tax view and the Cashflow
statement, not a comment.

### 2.2 Bonus-to-super contributions do not appear on the NCC line

See 1.4: the credit is reported in `superDetail.contributions` only. A
reader of the Super table sees NCC $0 while the tax-free component grows
$159k a year.

### 2.3 "Whole balance" pension commencement leaves the July growth behind

`probeA.mjs`, July start: `commenceAmount: null` transfers $600,000 and
leaves $1,720 (one month's growth) in accumulation, which then compounds
untouched for 17 years to $2,931 and appears in `superClosing`, the Super
table and the assets test forever. The commencement should transfer the
balance after that month's growth, or the reserve should be recomputed at
the firing month.

### 2.4 Transfer balance figures in the Super view

See 1.9 — `personalCap` and `remainingCap` are displayed and wrong.

### 2.5 The composite chart's flow bars do not include pension drawdown; the Expense funding chart calls it "met from income"

`outputSeries.js`: `compositeIncome` = `row.income − agePension`,
`compositeDrawdown` = `withdrawals + deficitFundedFromAssets`. Pension
payments are in neither. `probes/probeK.mjs` (same retiree as 1.10):
composite bars Income $0, Age pension $24,429, Capital drawdown $0, against
an expenditure line of $45,000, every year — $30,000 of drawdown is
missing from the chart that is the tool's headline picture.
`chartSeries.js` `expenseFundingSeries` relies on the identity
`deficitFundedFromAssets + unfundedCashflow = −surplusOrDeficit`, which
pension payments break (they refill the WCA outside both channels): the
Expense funding chart shows "Met from income" $44,958 of a $44,958 need
when income was $24,429 and the rest was drawn from the pension. Same
root cause as 1.10; listed here because the fix is in the series
modules, not the statement.

### 2.6 Monte Carlo percentiles shown to the dollar

`monteCarloPercentileGroups` renders through `renderTransposed`
(`Math.round`, en-AU), so the 10th percentile of net assets from 2,000
(or fewer — the control is user-set) paths reads as, e.g., "514,764". The
CSV export writes the same figures to the cent (`toFixed(2)`). The
Retirement page's own "display honesty" work (spec 36 Commit 3) capped and
rounded the ruin figure; the percentile table and its CSV were not
included. The deterministic tables share the to-the-dollar convention, and
for them it is defensible; for a sampled quantile it is not.

### 2.7 Crash timing labels for a retiree

`whatIfCrash.js` `representativeCrashAges` derives "Early", "Mid-career"
and "Near retirement" from the span `retirementAge − currentAge`, floored
at 2. For the Modest retiree demo (70, retired at 70) all three resolve to
age 71 (`probes/probeM.mjs`: three identical runs, Δ $83,329 each), so the
view draws three coincident lines labelled with working-life stages for
a 71-year-old.

### 2.8 The "Comprehensive pre-retiree" demo never retires

Both salary rows in every scenario of that demo run from the `start`
anchor to the `end` anchor, so the household earns $493,000 a year at ages
65, 75 and 85 (`probes/probeO.mjs`) while `retirementAge` is 65 and the
"Retire at 60" scenario changes nothing about income. The demo presents a
retirement picture that has no retirement in it, and it is why the
"Retire later" lever shows zero effect on it (1.13).

### 2.9 Table and CSV of the same view use different rounding and sign conventions

`renderTransposed` shows `Math.round(|v|)` in en-AU with negatives in
parentheses and anything under $0.005 as "–"; `exportTransposedCSV` writes
the same cells as `toFixed(2)` with a leading minus and "0.00". Row set,
column set, thinning and the real/nominal factor are identical (both go
through `visibleTransposed`), so the CSV is the table to two more decimal
places than the table shows. The Snapshot CSV (`snapshot.js` 151) rounds
to the dollar like its HTML, so the two exports disagree with each other on
precision. The death-benefits and focus CSVs also write cents.

---

## 3. Edge cases that break

- **Partial first year × one-off events** (1.1) — the largest class found.
  Repro: `probeA.mjs`, `probeG.mjs`. Also applies, by the same
  `julyOf(0) === null` path, to `superRollovers`, `commutations` and
  `definedBenefits.commenceAt`.
- **Pension in year 0 with TSB test** (1.2, B1): the year-0 Division 296
  assessment uses the pre-commencement opening TSB and post-commencement
  accumulation earnings — $485 of tax on a mixed basis, then nothing.
- **Whole-balance commencement residual** (2.3).

The deferred probes, now run (`probes/probeP.mjs`; every case: no
`errors`, no NaN/Infinity anywhere in `yearly`, conservation holds):

- **Negative asset balance is accepted and projected.** `clampAsset` does
  not floor `balance` at 0 (unlike liabilities at `planState.js` 1436 and
  bonds at 1701). An asset entered at −$50,000 — reachable by JSON import
  or a programmatic edit; the UI input carries `min="0"` — earns negative
  growth (−$1,634 in year 1), and `closingBalance` and `netAssets` go
  negative, against the "balances floor at 0" convention. Repro in the
  probe's section (a).
- **Client aged 104 at start** (past the ABS table): endAge resolves to
  102, below the current age; the engine projects 3 years anyway with the
  age pension paid. No crash, but an end age below the start age is an
  impossible state that was accepted.
- **Couple 67 / 42**: end age 108 on the client (partner's LE, correctly
  the longer), partner's accumulation super correctly exempt from the
  assets test, salary row clamped to the partner's own age. Sound.
- **One-year projection** (endAge = currentAge, July and September starts):
  2 rows, death-benefit detail present, no NaN. Sound.
- **Same-month buy and sell** of a CGT asset: pool and gain behave. Sound.
- **Early repayment larger than the balance**: closing exactly 0,
  `extraRepayment` capped at the balance, no interest afterwards. Sound.
- **Fixed rate rolling over in the final year**: rollover recorded, rate
  moves 5% → 7% in the final row. Sound.
- **Six super accounts, one owner, salary above the maximum contribution
  base**: SG $32,500 (cap honoured), all of it to the first-listed
  account, nothing to the other five. A convention, not a defect, but the
  Setup UI does not say which account receives SG.
- **Leap years / February**: no day-of-month arithmetic anywhere in the
  monthly stepping (`schedule.js`, `deterministic.js`, `liabilities.js`
  build only `Date(y, m, 1)` for labels and the aged care regime date).
  Sound by inspection; nothing to probe.

---

## 4. State and UI defects

- **`hydrate` field whitelists lag the schema** (1.3): `fhsssEligible` on
  super contribution rows; `excludeFromRetirement` /
  `excludeFromRetirementReason` on assets and income rows. Both are wrong
  numbers on reload, not cosmetic.
- **Enterable states that produce a silent non-event** (1.1): pension
  `commenceAt`, DB `commenceAt`, gift `at`, aged care `entryAt`, rollover
  `at`, commutation `at` all accept `plan.client.currentAge` in a plan
  starting after July. Gifts show a helper that reads "Falls outside the
  projection window (or before the projection start)" — the date is inside
  the window; the text misdiagnoses. The others show nothing. Per
  CLAUDE.md's input-integrity rule these should be unenterable or carry an
  inline message naming the conflict, as the property purchase already
  does.
- **Two entry paths, two answers** (1.4): the same after-tax dollar into
  super is capped when entered as an NCC row and uncapped when entered as
  a bonus destination.

- **Comparison arms** — see 1.13 (four arms that do nothing) and 1.14.
  Every other arm changes the projection in the expected direction; the
  list is in section 8.
- **CSV exports** — row set, column set, period thinning and the
  real/nominal factor match the visible table exactly for every
  `exportTransposedCSV` view and for the Monte Carlo and Snapshot exports;
  labels are quoted and escaped; the adjustments footer is carried. The
  only mismatch is precision and sign convention (2.9). Not audited:
  routing, workspace import/export beyond `hydrate` (1.3), smart-defaults
  disclosure.

---

## 5. Convention violations

- **Real terms primary.** 1.9 mixes real jumps with an un-deflated real
  base — a nominal quantity (the personal cap) leaking into a real
  computation.
- **FY anchoring / partial first year.** 1.1 is the convention applied
  past its intent: "skipped" became "deleted" for events with no next
  firing.
- **Money conservation.** No leak found. `checkYearConservation` passes on
  every scenario in `probes/probeI.mjs` (bonus-to-super at nil cap,
  September-start retiree) and on all other probes I ran it against. The
  defects above are wrong rules, not created or destroyed money — which is
  exactly why the invariant did not catch them.
- **Division 293 timing** (1.8): spec and code agree with each other;
  the brief's "known discrepancy" is not a timing disagreement in this
  codebase. The rule error is the income base.
- **Non-prescriptive voice** — audited: every template literal and label
  in `main.js` and every generated sentence in the pure output modules
  (`whatIfCashflowLens.js`, `goalVsPosition.js`, `retirementAnalytics.js`,
  `retirementOutcomeBuckets.js`, `lifestyleBand.js`, `simDisplay.js`,
  `focus*.js`, `divergence*.js`) grepped for recommending, ranking and
  evaluative language and each hit read in context. The convention is
  well kept: the levers panel says "ranked by its own effect on that
  probability — not a recommendation"; the ASFA block says "for
  comparison, not a recommendation"; education funding says "nothing here
  recommends the structure"; outcome buckets are named by what they are
  ("Above Comfortable", "At the Age Pension floor"). Three passages lean
  toward advice and should be reworded:
  - `main.js` 16095, ruin-tolerance descriptors: "Conservative. Roughly 1
    in 20 paths run short. **Defensible where** there is no Age Pension
    backstop or a strong bequest motive." and "The common planning
    benchmark ... **Default.**" — the first tells the reader when a
    tolerance is justified. State the consequence only: "Roughly 1 in 20
    paths run short."
  - `main.js` 13833, salary-sacrifice empty state: "**Whether salary
    sacrifice is worth it** for this client — income tax saved, HELP
    repayment unchanged, super gained net of contributions tax". Say what
    the view shows: "Income tax, HELP repayment and super balance with and
    without the salary sacrifice row".
  - `main.js` 14550–14560, surplus allocation: "Non-deductible interest is
    paid from after-tax income; deductible interest is not — **that is the
    basis for prioritising it**". This argues for a strategy. Keep the
    first clause (a fact) and drop the second.
  - `main.js` 6389 tooltip "Use the actual unimproved value ... it always
    beats either ratio" is an instruction about data entry, not advice
    about the client's affairs; left as is.

---

## 6. Gaps — missing disclosures, warnings, caveats

- Age pension non-assessable / SAPTO absent (2.1): no user-facing caveat.
- Division 293 income excludes the year's net capital gain (1.8): not
  disclosed anywhere (HELP's equivalent omission is disclosed in code
  only). MLS comparison income has the same base.
- TSB definition excludes pension phase (1.2): no disclosure; the cap
  headroom shown live beside contribution rows (`superCapUsage`) is
  computed on it.
- Monte Carlo excludes pension and bond balances from market risk (1.6):
  no disclosure on the Retirement page or the fan chart.
- Clients already in pension phase cannot be entered (`planState.js`
  header; `deterministic.js` 580: "there is no 'already in pension phase
  at plan start' input"). Re-commencing an existing pension inside the
  projection credits the TBA at today's value rather than the historical
  commencement value, resets proportioning, resets the minimum-drawdown
  basis, and (with 1.1) may not commence at all. The demo fixtures
  acknowledge the gap in comments; the UI does not.
- Division 296 uses the higher of opening and closing TSB (`div296.js`
  header) where the law uses closing TSB, and gross smooth earnings where
  the law uses realised taxable income (with the one-third discount on
  gains) plus ECPI. Disclosed in code; not seen in the UI (not fully
  audited).
- Minimum pension drawdown is not rounded to the nearest $10 (immaterial;
  noted for completeness).
- An annual-frequency salary row in a plan starting after July yields zero
  income for the partial first year (convention). The only cue is the
  in-grid tooltip on one-off cells ("already made earlier in the FY"),
  which is not true of salary. The demos avoid it with monthly rows.
- **Monte Carlo CPI path reaches only liabilities and planned-property
  pricing.** Confirmed by `probes/probeQ.mjs`: a plan with an AWOTE-indexed
  salary, CPI-indexed expenses and no debt gives byte-identical p10/p50/p90
  at CPI σ = 0 and σ = 2%. In a real-terms engine that is a coherent
  choice (the real wage margin and real returns are the stochastic
  variables), and `monteCarlo.js`'s header states it — but no user-facing
  text does. The Parameters modal and the fan chart should say that the
  inflation draw moves nominal debt only. This was section 7's first item;
  cleared as a disclosed-in-code design choice with a missing disclosure,
  not a wrong number.
- **Which account receives SG** is not stated anywhere in Setup: the
  first-listed included account for the owner gets all of it (probe P,
  six accounts).
- **Pension payments are absent from every cashflow view** (1.10) with no
  note on the Cashflow view, Snapshot or Key figures saying so; the only
  footer on the Cashflow view concerns the 50/50 split of pooled items.

---

## 7. Suspected, unverified

The first pass's three items are settled: the Monte Carlo CPI path is
quantified and moved to section 6 (zero effect outside liabilities — a
design choice lacking disclosure, not a wrong number); the released-super
fallback is confirmed and is now 1.12; charts, tables, CSV, arms and voice
are covered above. What remains unverified:

- **Education funding arms.** `probes/probeM.mjs`: the "savings outside a
  bond" baseline ends $650k ahead of both bond arms for the Family demo
  (baseline $8.27m, investment bond $7.62m, education bond $7.64m). The
  baseline asset is placed first in `fundingOrder` while the bonds are
  drawn only for fees, so the arms differ in more than tax treatment. I did
  not establish whether the gap is the intended comparison or an artefact
  of the funding-order placement; worth a hand check.
- **Non-deductible-first "interest saved" is negative on the Family demo**
  (−$110,419: paying non-deductible debt first costs more total interest
  than pro-rata). The view's wording handles a negative result, and the
  sign may well be right (the fixed-rate portion sits in the pro-rata
  arm), but I did not trace the figure.
- **Div 296 earnings and TSB measurement** (first pass): gross smooth
  earnings versus the law's taxable-income-plus-ECPI, and max(opening,
  closing) versus closing TSB. Disclosed in `div296.js`; not quantified.
- **`clampSuperWithdrawal` coerces `frequency: "once"` to monthly** (line
  1967) — reached only by import or programmatic construction (the UI
  offers monthly/annual), where a one-off $120k becomes $120k a month. Not
  user-reachable as far as I could see; noted because the recontribution
  focus builds its withdrawal from the same row shape.

---

## 8. Checked and found sound

- **Data tables vs BBB 2026/27**: CC cap $32,500 (AWOTE, $2,500 down);
  NCC $130,000 = 4×CC; bring-forward thresholds $1.84m/$1.97m/$2.1m; GTBC
  $2.1m ($100k down, CPI); untaxed plan cap $1,935,000; Div 293 threshold
  $250,000 unindexed; SG 12%; SG maximum salary $270,830 applied annually
  on gross pre-sacrifice salary per employer (`schedule.js` 598 —
  `rowTotals.income` is filled before `reduceTaxableIncome` runs); carry-
  forward gate $500,000; preservation 60, unrestricted 65; age pension
  67; single $1,200.90 pf, couple $905.20 pf each; homeowner assets
  thresholds $333,000/$499,000, non-homeowner $600,000/$766,000; $78 pa
  per $1,000; income free areas $226/$396 pf; deeming 1.25%/3.25% at
  $66,800/$110,600; Work Bonus $300 pf, $11,800 cap, $4,000 start; minimum
  drawdown factors 4/5/6/7/9/11/14%; TTR maximum 10%; Div 296 tiers 15%
  above $3m, +10% above $10m with $150k/$500k rounding.
- **Concessional cap arithmetic** (`processConcessionalCap`): current-year
  cap first, then oldest unused year; five-year expiry regardless of TSB;
  low-tax contributions for Div 293 = CC − excess.
- **NCC requested vs accepted** (money bug 7): cash debits
  `nonConcessional × nccAcceptRatio`, super credits the same; conservation
  holds through the nil tier in my probes.
- **`reserveFromSuper`** correctly sequences adviser fees, Div 293/296,
  FHSSS and pension commencement against one account.
- **Age pension means test**: accumulation super assessed and deemed once
  the *owner* reaches 67, exempt before (per owner, so a younger partner
  is shielded); pension-phase always assessed; PPR exempt; liabilities
  against assessed assets netted; deprived gifts counted five years; Work
  Bonus on employment income only; entitlement is the lower of the two
  tests; couple thresholds used for couples.
- **Transfer balance account mechanics themselves**: credits at
  commencement (ABP) / conversion (TTR) / 16× for DB; payments are not
  debits; commutations debit; proportional indexation by highest-ever used
  percentage; excess reported at 15% then 30%. Only the real/nominal delta
  (1.9) is wrong.
- **Proportioning**: fixed at commencement for pensions, live ratio for
  accumulation, both correct.
- **Death benefit rates** for taxed element: dependant nil, non-dependant
  15%+2%, estate 15% without Medicare; reversionary credit to the survivor's
  TBA at date-of-death value.
- **Conservation invariant** holds on every constructed scenario,
  including the ones exhibiting rule defects above.
- **Hydrate round-trip** is numerically identical for 14 of 15 demo
  scenarios (the 15th is 1.3).
- **Test suite**: 2,127 tests pass.

Second pass:

- **Comparison arms that do change the projection** (`probes/probeM.mjs`,
  `probeN.mjs`; maximum year-by-year |Δ net assets| in brackets): age
  pension strategy gift arm ($10k) and both work-income arms ($107k, $208k);
  aged care planning gift arm when the gift lands in a full year ($17k);
  salary sacrifice with vs without ($2.8k on the demo's window); FHSSS
  inside vs outside ($49k vs $62k); surplus allocation single-destination
  alternative ($194k); levers "contribute more" ($230k) and "take more
  risk" ($426k); what-if rate shock ($404k), revert-rate shock ($164k),
  income gap ($215k), expense shock ($776k); crash timing on accumulation
  holdings ($632k–$840k); recontribution focus (death-benefit tax $140k →
  $106k); debt payoff counterfactual ($171k); debt recycling with vs
  without ($468k); glide-versus-static lifecycle comparison ($2.3m); RAD /
  DAP / combination arms when entry lands in a full year (distinct costs
  and estates).
- **Chart construction**: balance charts pin the y-axis at zero
  (`rangemode: "tozero"`); the composite chart's dual axes share a zero
  baseline (`sharedZeroRanges`) and confine ticks to each axis's own data
  range; all-zero series are dropped from legend and stack
  (`seriesIsAllZero`); every chart's axis title carries "today's" or
  "future" dollars from the same `displayFactor` the tables use; Plotly
  absent degrades to a message, not a blank; hover formats are `$,.0f`
  throughout. The Retirement balances chart does include pensions and
  excluded balances as their own bands.
- **Stacked-chart double counting**: none found. The composite chart's
  Income and Age pension bands sum to `row.income`; the cashflow
  categories and the Cashflow table read the same functions; the Super
  balances chart stacks accumulation and pension accounts once each.
- **CSV parity** with the on-screen table on rows, columns, thinning and
  units (2.9 is the only difference).
- **Edge cases** listed in section 3 that passed: couple age gap, one-year
  projection, same-month buy/sell, early repayment beyond balance,
  fixed-rate rollover in the final year, six accounts, leap years, the
  zero plan.
- **`hydrate` on super accounts** keeps `excludeFromRetirement` (only the
  asset and income-row copies lose it, 1.3).
