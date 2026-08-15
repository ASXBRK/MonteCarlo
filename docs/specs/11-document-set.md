# Document Set — HELP, FHSSS, MLS, LMI/FHBG, extra repayments, goals, snapshot export

Conventions per CLAUDE.md. **Seven commits, gated** — full suite + build green
and the phase's regression gate holding before starting the next.

## Why these, together

`docs/reference/workbook-document-sense-check.md` analysed the firm's
`Cash Flow SOA` workbook and the Word deliverable it feeds. These are the
remaining items that document needs and the tool cannot yet produce. Each
either fills a row that currently emits zero, or unlocks a section of the
document that has no data behind it.

All FY2026/27 figures below come from the firm reference. Put every one in
an FY-keyed data module, never as a constant in engine code.

---

## COMMIT 1 — HELP repayments

The largest remaining gap: $21,815 in the worked example, near-universal in
the target cohort, and it sits inside the effective marginal rate that every
salary-sacrifice comparison depends on.

**Rates (FY2026/27), marginal within brackets:**
| Repayment income | Repayment |
|---|---|
| $0 – $69,528 | Nil |
| $69,529 – $129,717 | 15% of each $1 over $69,528 |
| $129,718 – $186,051 | $9,028 + 17% of each $1 over $129,717 |
| $186,052 + | 10% of **total** repayment income |

Note the top bracket is 10% of the *whole* income, not marginal — a genuine
cliff at $186,052. Implement it literally and test the discontinuity.

**Repayment income** = taxable income + reportable super contributions +
total net investment loss + reportable fringe benefits + exempt foreign
employment income. We model the first three; disclose the omissions.
**Reportable super contributions here means salary sacrifice and personal
deductible contributions — not SG.** This is why HELP interacts with
salary-sacrifice advice: sacrificing reduces taxable income but adds back
into repayment income, so the HELP liability does not fall.

**State:** `plan.<person>.helpBalance` (real $, default 0) in Setup beside
the tax profile. Balance indexed annually (basis: as the firm reference
specifies — confirm before implementing and state which you used).
Repayments reduce it; the loan ends when it reaches zero.

**Cashflow:** the compulsory repayment is withheld through PAYG alongside
income tax (employers withhold for HELP), so it belongs in the PAYG
calculation and in take-home pay, with any over/under-withholding settling
in the following year's refund — the same mechanism built in `ef7cafa`.

**Outputs:** the Cashflow table's existing `HELP Repayment` row (currently
zero-emitting) populates; the Tax view gains a per-person HELP row and a
closing balance; a HELP balance row joins the Key figures table when
non-zero.

Tests: each bracket boundary at known values, especially the $186,052 cliff;
salary sacrifice does **not** reduce the repayment (the add-back works);
the balance amortises and stops at zero; PAYG withholding includes HELP.
Regression gate: zero-balance scenarios bit-identical.
Commit: `HELP repayments`

---

## COMMIT 2 — Medicare Levy Surcharge

Small, and it fills another zero-emitting row.

| Singles | Families | Surcharge |
|---|---|---|
| ≤ $105,000 | ≤ $210,000 | Nil |
| $105,001 – $123,000 | $210,001 – $246,000 | 1.00% |
| $123,001 – $164,000 | $246,001 – $328,000 | 1.25% |
| > $164,000 | > $328,000 | 1.50% |

Family thresholds +$1,500 per dependent child after the first; indexed
1 July with AWOTE. Applies on income for surcharge purposes (taxable income
+ reportable fringe benefits + net investment loss + reportable super
contributions) when the person has no private hospital cover.

**New inputs:** per person, `privateHospitalCover` (bool, default true — so
MLS is off unless the user says otherwise, which is the safer default for an
advice tool); household `dependentChildren` (integer, default 0) in Setup.
Couples use the family thresholds.

Tests: each band; the family threshold with and without children; cover
suppresses the surcharge entirely; the surcharge applies to the whole
income, not the excess.
Commit: `Medicare levy surcharge`

---

## COMMIT 3 — FHSSS

An entire section of the document. Unblocked now that super exists.

| Parameter | Value |
|---|---|
| Max eligible contributions per year | $15,000 |
| Lifetime cap | $50,000 plus associated earnings |
| Concessional release amount | 85% of eligible concessional contributions |
| Tax on released CC + earnings | MTR less a 30% offset |

**Mechanics:**
- Eligible contributions are **voluntary** only — SG is never eligible.
  Concessional (salary sacrifice, personal deductible) and non-concessional
  both count toward the $15,000/year and $50,000 lifetime caps.
- Associated earnings accrue on eligible contributions at the ATO's shortfall
  interest rate — use a configurable `assumptions.fhsssEarningsRate`
  (state the default used and its source in a comment).
- On release: 85% of eligible concessional contributions plus 100% of
  eligible non-concessional plus associated earnings. The concessional and
  earnings components are assessable at MTR with a 30% offset; the
  non-concessional component is tax-free.
- Release is a request to the ATO, then the fund — model it as occurring in
  the month of the linked property purchase.

**State:** per super contribution row, an `fhsssEligible` flag (default
false). Per person, an FHSSS block tracking eligible contributions by year,
associated earnings, and released amounts.

**Integration with the purchase engine:** a planned property gains an
optional **"Release FHSSS at purchase"** toggle. When set, the released net
amount arrives as household cash in the settlement month and reduces the
cash required at settlement. This is the scenario the tool exists for —
deposit built through super, released at purchase, with the tax benefit
visible.

**Do not model:** the 12-month recontribution requirement if a home is not
purchased, first-home-buyer eligibility conditions, or the maximum
release request. Disclose all three.

Tests: annual and lifetime caps enforced; SG excluded from eligibility; the
85% concessional release; the MTR-less-30% tax on release; a release at a
planned purchase reducing the settlement cash requirement; earnings accrual.
Regression gate: scenarios with no FHSSS-flagged contributions
bit-identical.
Commit: `First Home Super Saver Scheme`

---

## COMMIT 4 — LMI and the First Home Guarantee

The worked example turns on the FHBG avoiding LMI at 93% LVR — currently
unmodellable.

- **LMI**: premium as a function of LVR band and loan amount, from an
  embedded rate table with a stated source and as-at date, plus a manual
  override field per purchase (same escape hatch as stamp duty). Applies
  above 80% LVR. Add the premium to the loan balance by default
  (capitalised, which is the norm) with an option to pay at settlement.
- **First Home Guarantee**: a per-purchase toggle. When on and the buyer is
  flagged first-home, LMI is waived. Model the property price cap as data
  (per state/region, with source and date); flag rather than block when the
  purchase price exceeds the cap, since caps change.

Tests: LMI at several LVR bands against the embedded table; no LMI at or
below 80%; FHBG waives it; the price-cap flag; capitalised vs
paid-at-settlement.
Commit: `Lenders mortgage insurance and First Home Guarantee`

---

## COMMIT 5 — Extra and lump-sum loan repayments

Core debt strategy, currently absent — only scheduled repayments exist.

- Per liability: a repeatable list of **extra repayments** (amount,
  frequency, DateRef window, indexation) and **one-off repayments** (amount,
  DateRef).
- Extra repayments reduce principal, shorten the term, and stop when the
  balance reaches zero. Recompute the payoff date accordingly.
- Extra repayments are household cash outflows through the working cash
  account — if cash is short they become a deficit, then unfunded. A
  repayment plan the client cannot afford must show as unaffordable; this is
  the exact failure mode the spreadsheet cannot see.
- The Liabilities table gains an Extra repayments row and shows interest
  saved and time saved versus the scheduled path.

Tests: extra repayments shorten the term correctly against a closed form;
the loan closes at zero without overpaying the final instalment; an
unaffordable extra repayment produces deficit funding then unfunded;
interest-saved reconciles.
Regression gate: loans without extra repayments bit-identical.
Commit: `Extra and one-off loan repayments`

---

## COMMIT 6 — Goals

The document tracks named savings goals separately from living expenses.

`plan.goals = [{ id, label, targetAmount, targetAt (DateRef), fundedFrom
(assetId | "surplus"), indexation }]`.

- A goal accrues toward its target and is **spent at the target date** — the
  money leaves the model, like an expense.
- Goals appear as their own group in the Cashflow table (matching the
  workbook's separate Goals block) and as markers on the composite chart.
- A goal that cannot be funded by its target date is flagged with the
  shortfall and the date it would be reached instead.

Tests: accrual and spend timing; indexed targets; the unfunded flag with the
correct alternative date; goals appear separately from expenses in the
Cashflow table.
Commit: `Goals`

---

## COMMIT 7 — Snapshot view and Word-ready export

The document is the firm's `Cash Flow SOA` sheet reproduced for a handful of
chosen years. This is what makes the tool produce their deliverable rather
than merely compute it.

- New **Snapshot** entry under Tables. Pick up to six plan years
  (DateRef selectors, defaulting to the current year, retirement, and four
  spread between); the view renders the firm's full row vocabulary — the
  existing `cashflowStatement.js` structure — as one column per selected
  year, with Client / Partner / Total sub-columns per the workbook.
- **Export**: HTML clipboard-friendly output that pastes into Word retaining
  table structure, plus CSV. Do not attempt .docx generation — the firm's
  template alignment is a separate exercise and pasting into their existing
  document is what they actually do today.
- Snapshot year selections persist per scenario in display state.

Tests: each snapshot column reconciles to the Cashflow table for that year;
Client + Partner = Total on every applicable row; export contains exactly
the visible rows.
Commit: `Snapshot view and Word-ready export`

---

## Deferred — do not build
Salary packaging and novated leases (four deduction rows exist; the FBT
mechanics are a separate build); debt recycling (needs loan drawdowns);
bonus handling as a distinct income type; scenario comparison table;
trust distributions, foreign income, taxable pension component, TTR offset,
SAPTO and Centrelink payments — all emit as zero rows to preserve the
document's table shape.
