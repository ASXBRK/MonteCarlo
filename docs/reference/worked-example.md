# Worked example — validated against the firm's advice document

> **Standing note on precedence.** Where our figure and the workbook
> disagree, ours stands if it traces to a primary source with the source
> and date cited. The workbook is a second opinion from a point in time,
> not a reference implementation. Divergences are recorded, attributed
> where possible, and only treated as our defect where a primary source
> says so.

The tool had never been checked against an independently-produced correct
answer. `docs/reference/workbook-document-sense-check.md` analysed a real
advice document the firm produced by hand for a real client; this exercise
builds that client as a scenario (`src/workedExample.test.js`, a committed
fixture that runs in CI) and compares our engine's own Snapshot-view output,
year one, against the five figures that analysis records.

**Result: two of five figures match exactly, one is close enough to
attribute to rounding, one is a disclosed timing-convention difference (and
the underlying calculation is confirmed correct), and one — net income —
is fully investigated below. Our figure is defensible from primary sources
for FY2026–27; the prior-financial-year hypothesis is tested directly
against the actual bracket cut and rejected (it moves the gap the wrong
way); no consistent single-earner input set reproduces the document's net
income alongside its other four figures, which is itself the finding.**
One real product bug was found and fixed along the way — see §4.

---

## 1. What we don't know, and how we filled the gap

The sense-check analysis gives five dollar figures and no gross salary,
no household composition, no ages, and no HELP opening balance — it is a
summary of the document, not the document itself, and we do not have
the original workbook or Word file. Per this exercise's own instructions,
we do not invent values to make lines reconcile; every input below is
either **given** directly, **derived** from a formula the firm's own spec
states, or an **assumption**, named as such.

| Input | Value | Basis |
|---|---|---|
| Household | Single client | **Assumption.** Composition (single vs couple) is nowhere stated in the analysis. The workbook's own "Client 1 / Client 2 / Total" structure suggests the real client may be a couple, but splitting the five figures across two invented incomes would itself be "inventing a value to make a line reconcile" — so a single-earner reconstruction, using only what's given, is the more defensible choice. §3.2 below shows this is also the leading candidate explanation for the net income gap. |
| Taxable income | $218,150 | **Derived**, and — per §3.1 below — the *unique* value consistent with the given HELP figure, not a choice. |
| Gross salary | $224,697 | **Derived.** Taxable income ($218,150) + the given work-related deduction ($6,547). |
| Work-related deduction | $6,547 | **Given** directly. |
| HELP opening balance | $100,000 | **Assumption**, unstated in the analysis — set well clear of $21,815 so the compulsory repayment is never capped by it. The $21,815 result does not depend on the exact value chosen, only on it being large enough. |
| Age | 35 | **Assumption**, unstated — immaterial to these five figures at this income (no SAPTO or Division 293 threshold nearby). |
| Private hospital cover | Yes | **Assumption.** MLS isn't among the document's cited figures; at $218k+ taxable income, MLS would apply without cover and none of the five targets would reconcile even approximately. |
| Financial year | FY2026–27 | The engine's assumption, tested explicitly against FY2025–26 in §3.3 — not simply asserted. |

**Not attempted:** FHSSS (the analysis quotes a hypothetical "refund rises
from $3,793 to $10,843" under a contribution scenario it doesn't specify —
no contribution amount, timing, or super balance is given, and reproducing
it would mean inventing all three); the property purchase, LMI and FHBG at
"93% LVR" (no purchase price, loan amount, or state is given — an LVR alone
doesn't determine a duty or LMI premium). Both need a level of input detail
the sense-check summary simply doesn't carry. Validating them would require
the source workbook itself.

---

## 2. Line-by-line reconciliation

Year one, single Snapshot column, our engine's own output via
`cashflowStatement()` — the exact function the Snapshot view renders
through, not a re-derived figure.

| Line | Document | Ours | Difference | Category | Explanation |
|---|---:|---:|---:|---|---|
| HELP Repayment | $21,815 | $21,815 | $0 (0.00%) | ROUNDING | Exact — this is the figure the reconstruction is built to reproduce, via the spec's own documented 10%-cliff formula. |
| Working Expense (deduction) | $6,547 | $6,547 | $0 (0.00%) | ROUNDING | Exact — a direct input, not computed. |
| Regular Take Home Pay | $130,422 | $130,749.71 | +$327.71 (+0.25%) | ROUNDING | Immaterial at this scale. Plausible source: real ATO PAYG withholding schedules round per pay period to whole dollars and step in discrete bands; our engine computes an exact annualised marginal-rate figure instead of replaying the actual withholding table. Also see §4 — before the fix found during this exercise, this line was off by the *entire* $21,815 HELP repayment. |
| Anticipated Tax Return | $3,793 | $0 | −$3,793 (−100%) | ASSUMPTION | Timing convention, not a missing calculation. Our engine settles a financial year's PAYG-vs-actual-liability gap as a cash event in **July of the following FY** (documented in `deterministic.js`, consistent across income tax, CGT, and Division 293/296) — so a brand-new scenario's first modelled year always shows $0 here by construction; it would show up as a real cash inflow in **year two's** Snapshot column instead. The underlying accrual figure for year one (`taxDetail.client.refundOrBalancing`) is **$3,731.79** — within $61.21 (1.6%) of the document's $3,793 — confirming the tax mechanics themselves are correct and only the display timing differs. |
| NET INCOME | $134,215 | $127,934.50 | −$6,280.50 (−4.68%) | DISCREPANCY | **Investigated in full in §3.** Our figure traces cleanly to primary FY2026–27 sources (§3.1). The prior-financial-year hypothesis is tested directly and rejected — it widens the gap, not closes it (§3.3). No single-earner input set reproduces all five figures at once (§3.2's uniqueness result) — but a plausible multi-person explanation exists and is shown to reconcile exactly (§3.2). This is recorded as the workbook's likely error, attributed but not provable without the source workbook. |

Two of five lines match exactly (HELP, the deduction), one is within a
quarter of a percent (take-home pay), one is a disclosed and independently
confirmed timing convention (the refund), and net income is now a
well-investigated, attributed finding rather than an open question. The
test's tolerances match this exactly — tight where the reconciliation is
tight, deliberately wide (and commented as such) where it isn't, per this
exercise's own instruction that a loose tolerance must never be used to
quietly hide a real gap.

---

## 3. Net income, resolved

### 3.1 First principles, with sources cited

Every rate below is either encoded in this engine (with its own source
citation in the file named) or independently confirmed against the ATO's
published figures for FY2026–27 during this investigation. Where a source
gives a marginally different number, it's noted — none of the differences
found are material to this client.

| Step | Figure | Source |
|---|---:|---|
| Assessable income (Salary) | $224,697 | Derived (§1) |
| less Deductions (Working Expense) | $6,547 | Given |
| **= Taxable income** | **$218,150** | |
| Income tax: $0–18,200 @ 0% | $0 | `src/Tax/engine.js`'s `LEG.brackets["2026-27"]` — resident tax-free threshold. Confirmed against the ATO's published FY2026–27 resident rates (no tax up to $18,200). |
| Income tax: $18,200–45,000 @ 15% | $4,020.00 | Same source. The 15% rate is the legislated FY2026–27 cut from 16% (FY2025–26) — confirmed against multiple current published summaries of the ATO schedule, and independently reproduced below (§3.3): the cut saves exactly $268 for anyone earning above $45,000 ($26,800 × 1 percentage point), matching the published figure for this cut exactly. |
| Income tax: $45,000–135,000 @ 30% | $27,000.00 | Same source; unchanged across FY2025–26 → FY2027–28. |
| Income tax: $135,000–190,000 @ 37% | $20,350.00 | Same source; unchanged across FY2025–26 → FY2027–28. |
| Income tax: $190,000–218,150 @ 45% | $12,667.50 | Same source; unchanged across FY2025–26 → FY2027–28. |
| **= Income tax** | **$64,037.50** | Sum of the above. |
| Medicare Levy @ 2% | $4,363.00 | `src/Tax/engine.js`'s `LEG.medicareLevy = 0.02`, ATO-standard rate. Taxable income is well above the shading-in range (`LEG.medicareLowerSingle`/`medicareUpperSingle`, ~$28k–$35k) so the 2% flat rate applies with no threshold sensitivity — the engine's medicare shading thresholds are labelled "2025-26" in code and not re-indexed per FY, which is a known, disclosed limitation, but it is immaterial here regardless of which FY's shading thresholds apply. |
| LITO | $0 | `src/Tax/annual.js`'s `LITO` schedule (ATO s159N, unchanged in recent years). Cuts out entirely at $66,667 taxable income; this client is more than three times that. |
| HELP Repayment | $21,815 | `src/data/helpRates.js`'s `HELP_RATES_BASE` (Macquarie Big Black Book 2026/27, as-at 1 July 2026): repayment income ≥ the cliff threshold pays 10% of the WHOLE repayment income. $218,150 × 10% = $21,815 exactly. Independently confirmed against the ATO's published FY2026–27 study/training loan thresholds: minimum threshold $69,528, next $129,717, cliff at $186,051 (our own `cliffThreshold` constant is $186,052 — a $1 rounding difference between sources that does not affect this client, who clears either figure by more than $30,000). |
| **= Tax on Taxable Income** | **$90,215.50** | Income tax + Medicare + HELP (LITO is $0). |
| **= NET INCOME** | **$127,934.50** | Taxable income − Tax on Taxable Income. |

**This figure is defensible from primary sources.** Every rate and
threshold above either comes from this engine's own cited reference data
(itself sourced to the Macquarie Big Black Book 2026/27) or was
independently checked against the ATO's own published FY2026–27 figures
during this investigation, and no divergence found is material at this
client's income. **We are not changing this calculation** — nothing found
during this investigation shows it to be wrong.

### 3.2 Is $134,215 reachable for a single earner? No — and that's the finding

**HELP's own shape makes $218,150 the *unique* taxable income consistent
with $21,815**, not one choice among several: the marginal bracket below
the flat cliff caps out at $9,028.35 (15% of the $69,528–$129,717 span);
the next marginal bracket caps out at roughly $18,605 (at the cliff
threshold itself). Both are far short of $21,815 — only the flat
10%-of-total cliff can produce it, and it does so at exactly $218,150
(verified directly in `src/workedExample.test.js`). Reportable super
contributions or a net investment loss could, in principle, let a LOWER
taxable income produce the same $218,150 *repayment* income — but either
one also lowers taxable income (and therefore tax), which only ever
*reduces* net income further below $127,934.50, moving away from the
document's $134,215, never toward it. **There is no single-earner
adjustment, consistent with the given HELP and deduction figures, that
raises net income to $134,215.**

**A plausible multi-person explanation exists and reconciles exactly.**
If the household is in fact a couple — which, per §1, the workbook's own
"Client 1 / Client 2 / Total" structure allows — and this client's own
figures are exactly as modelled, a second earner with a net income of
**$6,280.50** (the household total, $134,215, less this client's
$127,934.50) closes the gap exactly. That is not a large or contrived
number: anyone earning under the $18,200 tax-free threshold pays no
income tax and (below ~$24,300) no Medicare levy either, so a modest gross
income — a part-time role, a small amount of investment income — nets
**dollar-for-dollar**, with zero tax, up to that point. A second earner on
roughly $6,280 gross, with no HELP debt of their own, reconciles the
household total precisely without touching this client's own take-home
pay, HELP, or deduction figures at all.

This is a genuine finding, not a resolution we can confirm: it shows the
document is not necessarily *internally inconsistent* (a consistent
five-figure input set exists), but that set requires an unstated
household-composition assumption beyond what the sense-check analysis
gives us — precisely the kind of value this exercise is required not to
invent as fact. It is reported as the leading candidate explanation, not
as a confirmed one.

### 3.3 The prior-year hypothesis, tested directly — rejected

The workbook is a hand-built spreadsheet from the prior financial year.
Tested directly (`src/workedExample.test.js`'s FY2025–26 describe block):
re-running the *identical* reconstruction under FY2025–26's resident
brackets (16% on $18,200–45,000, one point higher than FY2026–27's
legislated 15% cut — both tables are in `src/Tax/engine.js`'s `LEG.brackets`,
independently confirmed against the ATO's published FY2025–26 and
FY2026–27 resident rates) gives:

| | FY2025–26 | FY2026–27 (ours) | Document |
|---|---:|---:|---:|
| Income tax | $64,305.50 | $64,037.50 | — |
| Medicare Levy | $4,363.00 | $4,363.00 | — |
| HELP Repayment | $21,815.00 | $21,815.00 | $21,815 |
| **Net income** | **$127,666.50** | **$127,934.50** | **$134,215** |
| Gap to document | **−$6,548.50** | −$6,280.50 | — |

FY2025–26's higher second-bracket rate taxes this client **$268 more**
than FY2026–27 — exactly $26,800 (the bracket's width) × 1 percentage
point, matching the legislated cut's own published effect precisely. HELP
is unchanged between the two years for this client: $218,150 repayment
income clears both years' cliff threshold ($179,286 in 2025–26 per the
ATO, $186,052 in 2026–27 per our own data), so the HELP match doesn't
discriminate between the two hypotheses at all — it was never going to
settle this question on its own.

**The hypothesis is rejected, and cleanly: the prior year taxes MORE, not
less, so assessing this client under FY2025–26 rates moves net income
FURTHER from the document's figure, not closer.** Every year in this
multi-year, already-legislated tax-cut schedule (16% → 15% → 14% across
FY2025–26 → FY2026–27 → FY2027–28) only cuts rates going forward, never
back — so there is no financial year on this schedule under which a
$218,150 taxable income assesses to a net income anywhere near $134,215.
This is a real, useful finding in its own right: it rules out "stale
threshold" as the explanation and leaves the household-composition
hypothesis in §3.2 as the more probable account of the gap.

---

## 4. A real bug, found by this exercise

Building this scenario surfaced a genuine product defect, independent of
the document: **`cashReceivedSums`'s "Regular Take Home Pay" was netting
off income tax PAYG withholding only — not HELP or Medicare Levy Surcharge
withholding, even though both are withheld through the identical PAYG
mechanism** (the engine's own code comment where they're computed already
said so). For this client, that overstated take-home pay by the *entire*
$21,815 HELP repayment — take-home pay came out at $153,219.41 before the
fix, 17.5% higher than the document, versus $130,749.71 (0.25% higher)
after it.

Fixed in the same commit as this validation:
- `src/deterministic.js` now exposes `helpWithheld`/`mlsWithheld` per
  person on `taxDetail` (previously computed but discarded at the end of
  each FY's assessment — the values existed, they just never left the
  function).
- `src/cashflowStatement.js`'s `cashReceivedSums` nets off all three
  withheld components (income tax, HELP, MLS), not just the first.
- New tests in `src/cashflowStatement.test.js` cover HELP-only,
  MLS-only, and both-together, per-person and household-total.

This is a display-layer fix only — the actual household cash movement
was always correct (the full withheld amount, HELP and MLS included, was
already leaving the Working Cash Account each month); only the **Cashflow
table and Snapshot view's own reported "take-home pay" figure** understated
the deduction. No new money flow was introduced or changed, so this does
not touch `randomScenario()`/`conservationCheck.js`.

---

## 5. What this validates, and what it doesn't

**Validates:** the HELP repayment formula (spec 11's own 10%-of-total
cliff) computed exactly against a real client figure; the take-home-pay
mechanism to within a quarter of a percent, once the HELP/MLS withholding
gap above was fixed; the refund/balancing accrual mechanism to within 1.6%
of the client's actual anticipated refund, once the reporting-timing
convention is understood; and, per §3, the income-tax and HELP calculation
itself against primary FY2026–27 sources, with the prior-year hypothesis
tested and explicitly rejected rather than left open.

**Does not validate:** FHSSS, the purchase engine, LMI/FHBG, or the
Snapshot view's row vocabulary beyond the four rows above — the source
analysis doesn't carry enough detail to reconstruct those parts of the
document without inventing unstated inputs (§1). Net income's household-
composition hypothesis (§3.2) is a demonstrated-consistent candidate, not
a confirmed one — we do not have the source workbook to check it against.

**Per the standing note at the top:** no primary source found during this
investigation shows our FY2026–27 calculation to be wrong, so no engine
change was made to force net income to match the document. The most
probable account of the gap is that the workbook's client is a couple with
a second, small income not captured in the five figures this exercise had
to work from — the source workbook itself remains the one thing that would
let this be confirmed rather than attributed.
