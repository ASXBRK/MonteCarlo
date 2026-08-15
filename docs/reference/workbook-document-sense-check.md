# Sense check — the workbook we replace and the document we produce

Reviewed: `X - Cash Flow Workbook (update).xlsm` (41 sheets) and
`Cashflow Strategy - example.docx` (338 paragraphs, 36 tables).

---

## 1. What the workbook actually is

**`Cash Flow SOA` is the spine.** One sheet, six columns —
`Current · Proposed · SOA Proposed 1 · 2 · 3 · 4` — each split
Client 1 / Client 2 / Total. Every table in the Word document is a slice of
this sheet. The row vocabulary is the firm's chart of accounts and the
document reproduces it verbatim.

**Everything else is a satellite calculator** feeding numbers into those six
columns by hand: Tax Calc (×3), Tax workings (×3), FHSSS, HELP projection,
Savings Projections, Home Deposit (×3: base / FHSS / Equity), Stamp Duty
(×3), LMI (×3), Property Calcs, Salary Sacrifice, Investment comparison,
Debt Summary plus eight 390-row amortisation sheets (Current Debt, Offset
Debt 1–4, Inc Repay, Custom 1–2), Mud map, Transaction Analysis, Budget
Analysis.

**The ×3 duplication is manual scenario management.** Three copies of Tax
Calc, Stamp Duty, LMI and Home Deposit exist because each scenario needs its
own. Eight debt sheets exist because each loan variant needs its own
amortisation table. That is the workbook doing by copy-paste what our
client → scenario model already does structurally.

**Your diagnosis is exactly right, and it's structural.** `D5` (Current
salary) and `L5` (SOA Proposed 1 salary) are independent manual inputs.
Nothing connects the surplus in one column to the savings balance in the
next. There is no mechanism anywhere in the workbook that could notice
"$10,000 a year to debt when they only have $6,000" — the columns are
snapshots of unrelated moments, not a projection. Indexation is likewise
per-cell and manual.

**Out of scope, confirmed:** `Transaction Analysis` and `Budget Analysis`.
Clause categorises twelve months of transactions; categorised totals are
typed into our tool. We replace neither sheet.

---

## 2. The row vocabulary — this is the requirement

The document's cashflow tables are this exact sequence. Reproducing it is
non-negotiable if the firm's output is not to change.

```
ASSESSABLE INCOME
  Salary · Taxable Pension Component · Other Income ·
  Government/Centrelink payments · Interest Income · Dividend Income ·
  Franking Credits · Property Income – Gross Rent · Trust Distribution ·
  Foreign Income · Net Taxable Capital Gains
  = Assessable Income
DEDUCTIONS
  Less: Investment Portfolio Interest · Property Interest Deductions ·
  Property Deductions · Property Depreciation · Vehicle Deductions ·
  Social Club (pre-tax) · Deductible Insurance Premiums ·
  Novated Lease pre-tax · Working Expense · Salary sacrifice ·
  Lump sum super contributions · Salary Packaging (Living Expenses) · Other
  = Taxable Income
TAX
  Income Tax · Medicare Levy · Medicare Levy Surcharge · HELP Repayment ·
  SAPTO · LITO · Spouse Splitting Offset · Franking Credit Offset ·
  Taxable Pension Offset (TTR)
  = Tax on Taxable Income
NON-TAXABLE ADD-BACKS
  Reinvested Dividends · Tax-Free Pension Income · Other Tax-Free Income ·
  Novated Lease post-tax
  = NET INCOME
CASH ACTUALLY RECEIVED
  Regular take home pay · Dividend Income · Other income ·
  After tax bonus · Regular rental income · Other tax free income ·
  Anticipated tax return
EXPENSES
  Mortgage Repayments · Other Loan Repayments (P&I) ·
  Non-discretionary Living · Discretionary Living · Grocery & Fuel ·
  Holidays · New Insurance Premiums · Investment Property expenses ·
  Home Maintenance · Other ×5
  = Total Expenses
  SURPLUS INCOME
```

### The most important thing in this document

The firm splits **NET INCOME** (accounting: income less actual tax) from
**Regular take home pay** (cash received after PAYG withholding) and
**Anticipated tax return** (the refund at lodgement). In the worked example:
net income $134,215, take home pay $130,422, anticipated refund $3,793.

Our engine accrues tax PAYG-style across income months and never
distinguishes withheld from payable. **We cannot currently produce these
three lines**, and the document leans on them — the entire FHSSS narrative
is "your refund rises from $3,793 to $10,843, which is how the benefit comes
back to you."

This is also the thing Xtools couldn't do (the withholding-percentage
request that came up twice in the forum). Building it is both a requirement
and an advantage.

---

## 3. What we already do better

- **Continuity.** Every year computed, reconciling, one change flowing
  through — the workbook's central defect, fixed by construction.
- **Scenarios.** Client → scenario replaces twelve duplicated sheets.
- **Indexation.** Per-row basis (CPI / AWOTE / custom) versus manual cells.
- **Affordability flagged.** Deficit funding and unfunded cashflow surface
  the "$10k to debt with $6k available" case the workbook cannot see.
- **CGT across the 1 July 2027 boundary.** The document devotes a section to
  the two treatments applying to one portfolio; our engine already does this
  with pooled cost bases and the deemed reacquisition.
- **Amortisation, offsets, stamp duty, purchase events** — engine features
  rather than eight sheets and three duplicates.

---

## 4. Gaps — what the document needs that we cannot yet emit

**Blocking the document:**

| Gap | Why it matters | Size |
|---|---|---|
| **PAYG withheld vs tax payable** — take home pay + anticipated refund | Three headline rows; the FHSSS benefit narrative depends on it | M |
| **HELP repayment** | $21,815 in the example; changes take-home and every comparison | M |
| **FHSSS** | An entire document section; contributions, deemed earnings, withdrawal tax, release at purchase | M |
| **Snapshot view in the firm's row vocabulary** + Word-ready export | The document is literally this table, six times | M |
| **Work-related deductions** (per person) | $6,547 in the example; a simple deduction input | S |
| **LMI + First Home Guarantee** | Three hidden sheets; the example turns on FHBG avoiding LMI at 93% LVR | M |

**Needed soon after:**

| Gap | Note | Size |
|---|---|---|
| **Goals** as funded targets | "$100k travel by 2030", holiday savings tracked and drawn down — a whole document section | M |
| **Scenario comparison table** | The document compares three scenarios across five snapshots | M |
| **Property depreciation** | Material to any investment property | S |
| **Medicare Levy Surcharge** | Needs a private-health input | S |
| **Debt recycling** | You named it; needs loan drawdowns (Tier 2.5) | M |
| **Salary packaging / novated lease** | Four deduction rows; the firm clearly does this | M |
| **Bonus handling** | Excluded from the base case, added separately | S |

**Deliberately not building:** trust distributions, foreign income, taxable
pension component, TTR offset, SAPTO, Centrelink payments — all belong to
parked areas (entities, pension phase, Centrelink). Emit them as zero rows
so the table shape matches.

---

## 5. What this changes about priorities

The build log ordered Tier 1 as HECS-HELP, extra repayments, FHSSS. This
document says the ordering should be **"what does the deliverable need"**,
and adds items that weren't on the list at all.

**Revised Tier 1 — the document set:**
1. Super contribution fix (still blocking) + conservation pass
2. **PAYG withheld vs payable** — take home pay, anticipated refund
3. **HELP repayment**
4. **Work-related and other per-person deductions** (covers several rows at
   once)
5. **FHSSS**
6. **Snapshot view + Word-ready export** in the firm's row vocabulary
7. LMI and First Home Guarantee on purchases
8. Extra and lump-sum loan repayments

Monte Carlo, currently in flight, is genuinely valuable but is **not on the
path to this document**. It belongs after the document set unless the firm
demo specifically wants it.

**The pitch to the firm writes itself from this comparison:** same document,
same rows, same language — but every year instead of six columns, and the
columns reconcile. Then, quietly, the things the workbook can never do:
change one input and watch it flow through; a plan that flags its own
unaffordability; and simulation on top.
