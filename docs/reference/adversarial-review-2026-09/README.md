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

Scope not covered, stated plainly so nobody assumes it was: the chart and
table renderers in `main.js`, the CSV export, the what-if / focus /
comparison arms, and the non-prescriptive-voice audit. Four parallel
auditors were assigned to those areas and all four were terminated by an
API rate limit before doing any work. Section 7 lists what I looked at
briefly in those areas without being able to verify.

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

Probes I intended to run but could not (auditor lost): zero/negative
balances, client past life-table end, 25-year couple age gap, death in
year 0, same-month buy/sell, early loan repayment, fixed-rate rollover in
the final month, six super accounts, leap-year stepping. None of these is
claimed sound.

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

Not audited (auditor lost): comparison/what-if/focus arms, routing,
workspace import/export, smart defaults disclosure.

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
- **Non-prescriptive voice**: not audited.

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

---

## 7. Suspected, unverified

- **Monte Carlo CPI path does not feed indexation or real returns.** The
  header says the randomised CPI affects "liabilities and planned-property
  pricing only"; income/expense indexation `((1+g)/(1+cpi))` and the real
  asset return keep the deterministic CPI. For a plan with wage-indexed
  income this understates dispersion. Read only; not quantified.
- **`superReleased` fallback and the `excludeFromRetirement` flag.** The
  deficit fallback (line 4136) draws from any released super account; it
  does not check the account's `excludeFromRetirement` flag, while
  `fundingOrder` does drop excluded assets. Read only.
- **Charts, tables, CSV, comparison arms, non-prescriptive voice**: not
  examined. The auditors assigned to them were terminated before starting.

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
