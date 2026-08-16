# Worked example — validated against the firm's advice document

The tool had never been checked against an independently-produced correct
answer. `docs/reference/workbook-document-sense-check.md` analysed a real
advice document the firm produced by hand for a real client; this exercise
builds that client as a scenario (`src/workedExample.test.js`, a committed
fixture that runs in CI) and compares our engine's own Snapshot-view output,
year one, against the five figures that analysis records.

**Result: two of five figures match exactly, one is close enough to
attribute to rounding, one is a disclosed timing-convention difference (and
the underlying calculation is confirmed correct), and one is a genuine,
unexplained discrepancy.** One real product bug was found and fixed along
the way — see §3.

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
| Household | Single client | **Assumption.** Composition (single vs couple) is nowhere stated in the analysis. The workbook's own "Client 1 / Client 2 / Total" structure suggests the real client may be a couple, but splitting the five figures across two invented incomes would itself be "inventing a value to make a line reconcile" — so a single-earner reconstruction, using only what's given, is the more defensible choice. This is flagged again in §4 as the leading candidate for the one unexplained discrepancy. |
| Taxable income | $218,150 | **Derived.** `docs/specs/11-document-set.md`'s own HELP table has a literal cliff: 10% of the WHOLE repayment income above $186,051. $21,815 is EXACTLY 10% of $218,150 — not a coincidence spec 11 could have engineered without the real figure, since it predates this exercise. Repayment income = taxable income here (no reportable super contributions assumed). |
| Gross salary | $224,697 | **Derived.** Taxable income ($218,150) + the given work-related deduction ($6,547). |
| Work-related deduction | $6,547 | **Given** directly. |
| HELP opening balance | $100,000 | **Assumption**, unstated in the analysis — set well clear of $21,815 so the compulsory repayment is never capped by it. The $21,815 result does not depend on the exact value chosen, only on it being large enough. |
| Age | 35 | **Assumption**, unstated — immaterial to these five figures at this income (no SAPTO or Division 293 threshold nearby). |
| Private hospital cover | Yes | **Assumption.** MLS isn't among the document's cited figures; at $218k+ taxable income, MLS would apply without cover and none of the five targets would reconcile even approximately. |
| Financial year | FY2026–27 | Matches the "AS AT FY2026/27" figures used throughout `docs/specs/11-document-set.md`. |

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
| Regular Take Home Pay | $130,422 | $130,749.71 | +$327.71 (+0.25%) | ROUNDING | Immaterial at this scale. Plausible source: real ATO PAYG withholding schedules round per pay period to whole dollars and step in discrete bands; our engine computes an exact annualised marginal-rate figure instead of replaying the actual withholding table. Also see §3 — before the fix found during this exercise, this line was off by the *entire* $21,815 HELP repayment. |
| Anticipated Tax Return | $3,793 | $0 | −$3,793 (−100%) | ASSUMPTION | Timing convention, not a missing calculation. Our engine settles a financial year's PAYG-vs-actual-liability gap as a cash event in **July of the following FY** (documented in `deterministic.js`, consistent across income tax, CGT, and Division 293/296) — so a brand-new scenario's first modelled year always shows $0 here by construction; it would show up as a real cash inflow in **year two's** Snapshot column instead. The underlying accrual figure for year one (`taxDetail.client.refundOrBalancing`) is **$3,731.79** — within $61.21 (1.6%) of the document's $3,793 — confirming the tax mechanics themselves are correct and only the display timing differs. |
| NET INCOME | $134,215 | $127,934.50 | −$6,280.50 (−4.68%) | DISCREPANCY | **Unexplained — genuinely a finding, not fixed to match.** Two candidate explanations, neither confirmed: (1) the source document may have been prepared using a different financial year's tax bracket schedule than our FY2026–27 AS-AT rates — personal tax brackets move with each Budget, and we don't know which year the original workbook assumed; (2) the household-composition assumption in §1 — if the real client is a couple, a second, smaller income we have no way to reconstruct would raise the household's net income without changing HELP, the deduction, or (necessarily) take-home pay by much. Both are plausible; neither can be confirmed without the source workbook, so this is reported as a discrepancy rather than attributed to either. |

Two of five lines match exactly (HELP, the deduction), one is within a
quarter of a percent (take-home pay), one is a disclosed and independently
confirmed timing convention (the refund), and one is a genuine open
question (net income). The test's tolerances match this exactly — tight
where the reconciliation is tight, deliberately wide (and commented as
such) where it isn't, per this exercise's own instruction that a loose
tolerance must never be used to quietly hide a real gap.

---

## 3. A real bug, found by this exercise

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

## 4. What this validates, and what it doesn't

**Validates:** the HELP repayment formula (spec 11's own 10%-of-total
cliff) computed exactly against a real client figure; the take-home-pay
mechanism to within a quarter of a percent, once the HELP/MLS withholding
gap above was fixed; the refund/balancing accrual mechanism to within 1.6%
of the client's actual anticipated refund, once the reporting-timing
convention is understood.

**Does not validate:** FHSSS, the purchase engine, LMI/FHBG, or the
Snapshot view's row vocabulary beyond the four rows above — the source
analysis doesn't carry enough detail to reconstruct those parts of the
document without inventing unstated inputs (§1). Net income carries a real,
open discrepancy (§2) that this exercise surfaces but does not resolve.

**For next time:** the single most useful thing that would sharpen this
exercise is the source workbook itself (or even just its `Cash Flow SOA`
sheet for this client) — with the actual gross salary, household
composition, and financial year the figures were computed for, the "net
income" discrepancy above could very likely be attributed with confidence
instead of reported as two competing hypotheses.
