# Xtools+ / CALM — Reference Notes (complete corpus review)

Internal design reference for the projection tool build. Built from a full
pass over all 50 scraped Iress Community threads (243 posts) and all 149
images, plus six adviser-supplied screenshots. Source material is Iress
copyright: this is feature-parity and workflow intelligence only — nothing
here is reproduced in the product or any client-facing material.

**Corpus quality, honestly:** ~12 threads carry substantial product detail
(the four Lana Graham AMAs above all), ~14 are thin hints with one useful
screenshot each, ~24 are marketing or cover other products (WealthSolver,
Risk Researcher, XBI). Of 149 images, roughly 25 are genuine Xtools+ UI; the
rest are promo tiles, headshots, emoji and stock photography. The 25 are
disproportionately informative — most are full-screen captures.

---

## 1. Information architecture

Global icon rail → collapsible tree → content area. Content header:
`Xtools: <Surname, Client & Partner>: <Scenario name> ▾` (the scenario
switcher lives in the page title), a `‹ Previous` button, then a purple
breadcrumb banner: `Individual → Super → Client → SOP Transactions`.

Tree top level: **Input ▾ · Display ▾ · Chart ▾ · Assumption ▾ ·
Scenario Index**.

Input, fully expanded:
```
Basic Details · Children (n) ·
Individual ▾
    Cashflow ▾ [Income · Expenses · …]
    Assets ▾
    Investment Bonds
    Super ▾
        Client ▾ [Historical · Accounts · Year to Date Conts ·
                  SOP Transactions · Regular CCs · Regular NCCs ·
                  Regular Cashouts · EOP Transactions]
        Partner ▾ · Other SMSF ▾
    Pensions ▾ · Insurance
    Liabilities ▾ [Loan Details · Rates and Fees · Repayments ·
                   Drawdowns · Associate · HECS-HELP]
    Cashflow Allocation ▾ [Surplus · Deficit]
    Year to Date ▾
SMSF Admin ▾ [Key Details · Cashflow · Assets · Liabilities ·
              Cashflow Allocation]
Tax Details ▾ · Investment Returns · Strategy · What if · Options
(Legacy Data — appears post-migration only)
```
Display: `CALM · Individual ▾ [CALM · Cashflow ▾ (Consolidated, Summary,
Taxation ▾ (Client/Partner/Annual Summary), Income Support ▾ (Gifting, Rent
Assistance, Pension Summary, Pension Details, Cth Seniors Health Card)) ·
Assets ▾ · Super ▾ · Death Benefit]`.

Chart: `Individual ▾ [CALM · CALM (PV) · Returns · Cashflow ▾ · Assets ▾
(Total Assets, Total Assets (PV), Net Assets, Net Assets (PV), Death Benefit,
Death Benefit (PV)) · Liabilities ▾ · Insurance ▾ · Super ▾ · Pension Assets ▾
· Pension Income ▾ · SMSF ▾ · Aged Care ▾ · Asset Allocation · Scenario Index]`.

**Takeaway.** Input / Display / Chart as three sibling groups; one screen per
page throughout; no long scrolls anywhere. Our sidebar phase should follow
this, collapsing Display+Chart into Tables and Graphs.

---

## 2. Universal table conventions

Dates as columns. Header rows: `Date · Event · Age - <Client> ·
Age - <Partner>`. Indented sub-rows prefixed `>`. A **pencil icon** marks
adjustable rows. Row labels that are hyperlinks open a row editor. The
part-year first column appears as its own date (`1 Jun 26`, then `1 Jul 26`).
Date dropdowns embed both ages: `01 Jul 25 (C:56.0 P:52.0)`.
Ages display with a decimal when the date isn't 1 July aligned (`Wayne 75.3`).

### The "Edit Row Information" dialog — their in-grid editing
Clicking a row label opens a modal:
- Name (read-only); **Value Type [Future Value | Present Value]**
- **Special Dates** — one input per key date, e.g. `Bob's Retirement - 66 -
  01 Jul 2036`, `Current Part Year Start - Bob 56, Betty 52 - 01 Jun 2026`
- A period grid: Date row · Age row · **read-only reference rows** ·
  editable **Amount** row · **Special** row (amounts from the special-date
  inputs) · **Total (Click to Update)** · **derived/breach rows**
- Observed reference rows: `Non Concessional Contribution Cap Available`,
  `Total Super Balance`, `General Transfer Balance Cap`, `Balance`; derived
  rows below: `Total Non Concessional Contributions`, **`Excess Non
  Concessional Contributions`**, `Net Balance as per SOP Transactions…`.
  The caps visibly react to what you type.

**Two things to steal.** (a) Constraint and reference rows *inside* the
editor — this is their "live data points, no memory test" feature.
(b) **Amount vs Special as separate rows plus a Total** — a cleaner solution
than our planned dot-marker for cells holding both input-panel and
table-sourced amounts.

---

## 3. Cashflow allocation — the richest area, and where we're thinnest

### Surplus: percentage model
`Individual → Cashflow Allocation → Surplus`
- **Surplus Option [Custom]**
- **Interest Rate Order [Descending]** — debt repayment ordering (avalanche)
- **Allocate Remainder to [Expenditure]**
- Per period: Allocation Start / End (key dates), **Pay Non Deductible Debt
  First [Yes/No]**, then a **percentage per destination** — each financial
  asset, each loan, and per person each super contribution type (Salary
  Sacrifice / Personal NCC / Spouse / Personal CC to Accumulation)
- Footer: `Additional Expenditure (Click to Update) 100.0%` /
  `Total (Click to Update) 0.0%` — percentages must reconcile

### Deficit: priority model ("Cashflow Treatment" dialog)
- Columns per period; From/To are **key-date dropdowns**
  (`Retmt C - 69.7 (01 Jul 39)`)
- **Priority 1..5** destination dropdowns, then **Remainder → Working Cash
  Account** (fixed catch-all)
- **Apply Auto Allocation [Yes/No]**
- Tabs assign each asset to a **Cashflow Group**, and set a **Minimum
  Balance** per group with an ordering rule — observed value
  **"Minimum Capital Gain"**

**Limits (from posts):** 2 surplus periods, 3 deficit periods; users
repeatedly ask for more, and for the ability to **fund deficits from
entities** (trust/company), which currently requires manual year-by-year
capital withdrawals with hand-calculated tax.

**What to steal, in priority order:**
1. **"Pay non-deductible debt first"** — tax-aware, one toggle, exactly the
   kind of rule that makes a tool feel expert. Now meaningful for us since
   liabilities exist.
2. **"Minimum Capital Gain" as a sell-down rule** — instead of a fixed user
   order, draw from the asset with the least unrealised gain. We have pooled
   cost bases already; this is cheap and genuinely tax-aware.
3. **Minimum balance per asset/group** — keep $X in cash before drawing
   elsewhere.
4. **Percentage split across destinations** rather than our all-or-nothing
   spend|invest, with a remainder destination.
5. Interest-rate-descending debt ordering.

---

## 4. Key Dates — the best structural idea in the corpus

Named events (`Retirement`, `Buy a Home`, `Existing`, `Start`, `End`) defined
once and referenced *everywhere* as start/end anchors — on income rows,
contributions, allocation periods, pension drawdowns. Dropdown labels show
the resolved date and both ages. Key Dates can be added inline from the SOP
and EOP screens via hyperlinks, annotate table headers with the event label,
and the Period View can force key-date years to display.

**Why it matters for us.** We anchor cashflows to integer ages
(`fromAge`/`toAge`). Change retirement from 65 to 67 in Xplan and every row
anchored to "Retirement" moves automatically; in ours you edit every row by
hand. For a tool whose whole purpose is iterating scenarios, named anchors
are materially better. Recommend: Key Dates as a first-class concept, with
age entry remaining as the fallback.

---

## 5. Period View — solves the 50-column problem

Reached from a "Date" hyperlink at the top of most display pages.
- Date: Projection Start Date · Initial Frequency [Annual] · Display Period ·
  Display Start/End Period Date · Display <Client> Age · Display <Partner>
  Age · Display Event label · Display Client/Partner Work Transition Period
  in Header · **Display Market Crash Period in Header** · **Display Interest
  Rate Period in Header** · Specify Future Key Dates (label + date)
- Projection View: **Based on [Longest Life Expectancy | client | partner]** ·
  Period [`Life Expectancy (Liam aged 84 | Lyla aged 87)`] · Show all periods ·
  **Force Retirement Years to Display [Yes]** · **From period [1] · To period
  [10] · Then every [5 period]**
- Row View: **Hide Null Rows [Yes/No]**

**Steal the thinning model**: full detail for the first N periods, then every
Nth, with key/retirement years always forced in. Much better than our plain
From/To range. Also note **Market Crash Period** and **Interest Rate Period**
exist as modellable what-if periods with header display.

---

## 6. Charts

**The flagship — CALM / CALM (PV): "Cashflow, Assets & Liabilities
(Discounted by CPI)"**, four series on a dual axis, x-axis = age:
- purple area — Total Net Non Financial Assets (incl PPR, Acc Deposit, Non Fin
  Assets and Mortgages)
- blue bars — Total Net Assets
- red line — Expenditure (Including Tax)
- green bars — Income and Capital Drawdown

Directly below sits a **"Data" accordion** holding display settings:
`Apply Automated Aged Care settings`, then per item (Home / Home Mortgage and
Reverse Mortgage / Accommodation Deposit / Non Financial Assets) a
**[Exclude | Include | Include Separately]** select. Include Separately
renders the item as its own stacked area; the legend states which assets are
treated as non-financial. Defaults were changed in Sep 2024 after a user
survey.

**Projected Asset Allocation (incl Super)** — 100% stacked bars by age across
seven classes: Domestic Equity, International Equity, Domestic Property,
International Property, Domestic Fixed Interest, International Fixed
Interest, Domestic Cash. (Our profiles need class splits to build this.)

**Compare Charts** — launched from the **scenario list**, not from inside a
scenario: CALM → scenario list → `Compare Chart` → pick chart from the left
menu → tick scenarios → Compare. Net Assets, Cashflow, Asset Allocation.
*IA implication: our Compare button belongs on the client page.*

**Visualise charts** (same engine, client-facing): stacked bars by category
(Investments / Superannuation / Income Streams / Mortgage, or Cash /
Lifestyle / Liabilities) with **liabilities as negative bars below the axis**
and a **Net Worth line** overlaid; age on x; PV by default. Top bar: chart
selector dropdown + three view icons (chart | table | image).

Chart headers carry a gear (settings) and download icon. Every chart is
duplicated for PV — our units toggle is cleaner.

---

## 7. Input screens — field-level detail

### Income (`Individual → Cashflow → Income`)
Screen tabs: **Income | Term Payments | Reportable Fringe Benefits | Income
Support**. Dialog tabs: **Income Details | Other Linked Superannuation
Contributions**.
Income Details: Owner · **Type [Employment]** · Description ·
**Income start [key-date dropdown]** · Amount pa · **Indexation [Sal Inf]**.
Linked contributions: `Add Concessional` / `Add Non Concessional` /
**`Add Concessional Contributions to Cap`**; rows carry Super Account · Start ·
End · Amount · Indexation, or for the cap variant **Target [General Cap |
Available Cap]**. Employer and salary-sacrifice contributions attach to the
*income*, not to super — hence the limitation that you can't model employer
contributions without employment income.

### Investment Returns (tabs: Overall Return · Detailed Return · Risk Profile)
One grid of every asset grouped by category (Working Cash Account, Financial
Assets Group 1, Property, Super Accumulation, Individual Pension):
`Balance · Investment Profile · Return Type [System|Custom] · Income % ·
Franking % · Growth % · Total %`. Property swaps Franking for `Rent $` and
adds a Period column. Super adds `Taxable Portion of Growth %`.
Custom returns may be capped by licensee settings.

### Asset/account detail popup
```
Investment                       Fees
  Profile [select] [Custom]        Entry %
  Income (pa) %                    ICR (pa) [List|Custom] %
  > Percentage of Income Franked   Ongoing (pa) $
  Growth (pa) %                    > Annual Indexation [None|…]
  Total Return (pa) %              Adviser Fee (% pa)
                                   Adviser Fee ($ pa)
                                   > Annual Indexation [None|…]
```

### Liabilities (six screens)
`Loan Details · Rates and Fees · Repayments · Drawdowns · Associate ·
HECS-HELP`.
- **Associate**: links a loan to an asset (Loan / Type / Associated Asset) and
  separately **Mortgage Offset**: Offset Liability ↔ Offset Asset.
- **Deductibility is a percentage, not a flag** ("set it to 100% tax
  deductible") — mixed-purpose loans are common.
- Loans carry a **credit limit** (and a group credit limit feature); a loan
  with nil balance and a credit limit plus a **Start of Period Drawdown** is
  how equity release is modelled.
- Offset: interest computed on the reduced balance ($100k loan − $10k offset →
  interest $10k → $9k). **Confirms our D3 model exactly.**

### SMSF Key Details — the reconciliation pattern
Plan description; Tax Settings (**Unused Capital Losses $**, Div 296 cost base
reset toggle); ACCOUNTS block per member (Client / Partner / Other / Total)
with Total Balance, Tax Free, Taxable–Taxed; NET ASSETS block (Working Cash
Account, Total Financial Assets, Total Property, Total Assets, Total
Liabilities, Net Assets); ending in a live assertion **"ACCOUNTS and NET
ASSETS are BALANCED"**.

### Options → tabs: Projection · Economic · **Indexation** · Other Options
Indexation tab: `Specify Custom Indexation [Use None]`, then per person
**Salary Indexation**: `Link Salary to AWOTE [Yes]` · `AWOTE 2.70%` ·
`Additional Indexation [3.0%/5.0%]` · `Total Salary Indexation 5.70%/7.70%`.

### Life Stages (their glide path) — site-level admin config
`Admin > Site > Assumptions > Risk Profiles > Life Stages`. Define age stages
(stage 1 starts at 0, final ends at 99) plus **investment-balance cohorts**,
then complete a **stage × cohort matrix** mapping to risk profiles. In CALM,
set an account's Investment Profile to "Life Stages". Applies to Super and
ABP. Note the profile is driven by age *and* balance.

### SOP / EOP Transactions
Left-to-right tabs "displayed in the order they impact calculations":
`Net Opening Balance · Pension Cashouts · Pension Rollback · Super Cashouts 1 ·
Concessional Contributions · Super Cashouts 2, FHSSS · Super Rollovers ·
NCC, Spouse, Downsizer & Business Contributions · Rollover Pensions`, ending
in a **Final Opening Balance** rollup showing every account with components,
caps remaining, and cashflow surplus/deficit. EOP centralises year-end tasks
(Voluntary Contributions, Government Benefits, Tax Releases) with caps and
totals at the bottom of the same screen.

### Edit Pension dialog (pattern, though super is out of our scope)
Tabs Details|Asset Summary|Income Summary. Read-only computed context inline
(`Transfer Balance Cap Available`, `Min: $0 Max: $0`). **Drawdown Option is a
period sub-grid inside the dialog**: From | To | Option [Custom $] | Income
(pa) | Indexation. Social security selects show the system's answer beside
them (`Calculated` → "Deemed"; `Apply System` → "System: 100% Asset Tested").

---

## 8. Display tables — row structures worth copying

### Cashflow (Consolidated)
Inflow: Earned Income > per person > `> Ordinary Wages`; Income Paid > per
account; Tax Refund > per person; **Total Inflow**.
Outflow: Expenditure > per named expense (General Expenses, Holidays, Car
Upgrade, Retirement Lifestyle); **Goals** > per named goal (Alaska);
Taxation > per person > Income Tax, High Income Contribution Surcharge;
Working Cash Account; Financing > Repayment of Borrowings, **Expenses
Adjustment**; **Total Outflow**.
Net: **Net Cashflow**, with `Surplus Allocation Option` and `Deficit
Allocation Option` as hyperlinks into the allocation dialogs; Allocated
to/from Assets > per asset; Allocated to/from Working Cash Account; Allocated
to/from Super > per person.
**Note: Goals are a distinct expense category from ordinary expenses.**

### Taxation (per person) — full row list
Pre Tax Expenditure · Other Deductions · Total Deductions · **Taxable
Income** · Gross Tax Payable (> Tax Payable (Calculated), > **Tax
Adjustment**) · Refundable Tax Offsets (Franking Credits, Total) ·
Non Refundable Tax Offsets (Low Income Tax Offset, Senior Australians
Pensioner Tax Offset, Investment Bond Tax Offset [Assessable, Offset Rate,
Offset From Trust], Beneficiary Tax Offset, Spouse Contribution, First Home
Super Saver Scheme Tax Offset, Superannuation Income Streams Rebate, Excess
Concessional Contribution, Super Lump Sum Tax Reduction, ETP/Leave Lumpsum
Rebate, **Other Offsets**, Total) · Non Concessional Contribution Tax ·
**Tax Payable** · Medicare (Levy, Surcharge, **Adjustment**) · Compulsory
HECS-HELP Repayment · **Total Payable**.

**Gap analysis for our Tax view.** We have brackets, Medicare, LITO, franking,
CGT. Cheap additions when relevant: Medicare surcharge, HECS-HELP, SAPTO,
spouse contribution offset. But the important pattern is the **adjustment
rows and an "Other Offsets" free-entry row** — the escape hatch that makes an
imperfect engine usable.

### Pension Details (Centrelink — reference only, out of our scope)
Deemed Investment Income by account → Total Deemed Financial Assets →
Assessable Deemed Income → Plus Assessable Income Adjustment → Total
Assessable Income → Allowable Income Threshold → Excess Income → Pension
Payable Under Income Test → Pension Entitlement incl Supplements (Test to
Apply, Taxable Base Pension, Supplement, adjustments, Non Taxable components,
Rent Assistance, Energy Supplement).

---

## 9. Conventions confirmed

- **Longest life expectancy** is the default projection basis (client/partner/
  longest selectable; longest was previously the only option). Elsewhere in
  their stack, LE is framed as a **confidence percentage** — 50% is the
  statistical midpoint ("a coin flip on whether the client outlives the
  strategy"), default 75%, 80% a robust buffer; for couples they track the
  probability of *at least one* surviving. A good future insight for us.
- **Part-year start periods** shown explicitly in table headers.
- **Auto allocation** force-balances cashflows at strategy commencement so
  earnings and Centrelink use correct opening balances; it confused users
  enough that an off switch shipped. A caution about invisible engine
  behaviour.
- **Indexation defaults**: income → Salary Inflation (AWOTE); super
  contributions → None (changed from Salary Inflation in May 2026 because
  users kept overriding it). Working Cash Account interest formerly inherited
  the first Cash asset's system return (e.g. Domestic Cash 3.3%).
- **Property sale + repurchase must be same-period**, or the chart shows a
  one-year "V" dip — the mismatch comes from routing proceeds through surplus
  allocation instead of an explicit same-period transaction. Property carries
  a **`Linked Asset on Disposal`** field. Our same-month settlement design
  avoids this by construction.
- **Age Pension age reached mid-year**: tests reconcile at start of FY so the
  whole FY is excluded; a Key Date is the workaround. Period-boundary
  approximations are genre-standard, and Key Dates are the escape hatch.
- Xmerge display path syntax exposes the standard display params:
  `Display|Individual|Cashflow|Taxation|Client` with
  `View_All, Hide_Nulls, Start, End, Frequency`.
- **Consolidation guidance**: their own advice is to combine holdings into one
  line ("Share Portfolio") unless per-asset returns matter — validates our
  flexible asset count rather than mandating detail.

---

## 10. Their pain points — our positioning

1. **No drawdown solver.** "Is there an option to calculate what client could
   draw from pension to extinguish in full at LE?" → "we don't have a magic
   button"; the workaround is manual back-and-forth across slow screens.
   **Our engine is sub-millisecond; a binary search for sustainable spend is
   trivial. Clearest capability gap we can beat.**
2. **"Expend" removed from SMSF pensions** because it was "an incredibly heavy
   calculation that was impeding performance" — i.e. draw what's needed to
   cover expenses. **That is our deficit funding, and ours is fast.** They
   intend to rebuild it.
3. **No withholding-tax % option.** Raised twice (PAYG variation as forced
   savings; non-resident 10% interest withholding). Only lever is
   claim-tax-free-threshold yes/no. An **adjustment/override row solves this
   whole class of problem.**
4. **Interest-rate change and IO→P&I conversion can't be done within one
   loan** — documented workaround required. (Our D3 defers it too; now known
   to be a real ask.)
5. **Surplus allocation can't be capped to contribution caps** — it
   over-contributes past them automatically.
6. **Deficits can't be funded from entities** (trust/company).
7. **Only one offset account per scenario**, linkable to only one loan.
   Workaround: reduce the loan balance instead. **We already beat this.**
8. **Screens are slow** — 5+ seconds per page; outputs live on separate
   Display screens; "Click to Update" was retrofitted because auto-recalc was
   too slow. The official workaround is **duplicating the browser tab** so you
   can watch output while editing input (with a warning that doing it across
   two scenarios corrupts data). Lana concedes Xtools+ is harder to navigate
   than Visualise.
9. Working Cash Account row always shows even at $0 and can't be hidden.
10. Investment bond tax fixed at 30% (users want ~20% effective).
11. Only two super accounts; >2 needs component workarounds. Four trusts: no.
12. **Partner death / couple→single transition not modelled** ("a huge
    undertaking"); workaround is manually zeroing the deceased's Age Pension
    from their LE year.
13. Max Deductible contributions consume all unused cap in year one — needs
    manual staging across two input phases.
14. Legislative lag: Div 296 support was still pending as of May 2026.

---

## 11. Actions for our build

**Change existing plans:**
- D3: `deductible: bool` → **`deductiblePct`**.
- D1 indexation defaults: income → **wage index (AWOTE)**, not CPI.
- Surplus model: replace `spend | invest to [asset]` with a **percentage
  allocation across destinations + remainder**, plus **"pay non-deductible
  debt first"** and interest-rate ordering now that liabilities exist.
- Deficit model: keep the ordered list, add **minimum balance per asset** and
  an optional **"minimum capital gain"** ordering rule.
- C2 in-grid editing: adopt **Amount / Special / Total as separate rows**
  instead of a dot marker.
- Period selector: adopt **from/to/then-every thinning** with forced key-date
  years, not a plain range.

**Add (ordered by value):**
1. Composite Cashflow-Assets-Liabilities chart with liabilities as negative
   bars and a net-worth line — the headline artefact.
2. **Key Dates** as named anchors referenced by cashflow start/end.
3. **Adjustment rows** on tax and cashflow tables (plus an "Other" free-entry
   row) — the escape hatch that makes an imperfect engine usable.
4. Include / Exclude / **Include Separately** display toggles per asset class.
5. **Drawdown solver** — sustainable spend to LE. Our standout advantage.
6. Loan **drawdowns** as a first-class input (equity release).
7. Scenario compare overlay, launched from the **client page**.
8. Scenario **templates** and **locking** (locking has a stated compliance
   rationale: point-in-time evidence for audit).
9. Consolidated Investment Returns grid — all assets' assumptions on one
   screen.
10. Balance assertions ("assets and net assets are balanced") as trust devices.
11. Asset allocation over time chart (needs class splits on our profiles).
12. Goals as a distinct expense category.
13. Word/table-format merge (long-term).

**Deliberate non-goals** (their scope, not ours): entities/trusts/companies,
SMSF admin, insurance, Centrelink/aged care, investment bonds, death benefit
projections, defined benefit funds.

**Positioning.** Their navigation depth, 5-second page loads, separated
Display screens and retrofitted manual recalculation are all symptoms of one
thing: a large engine behind a slow UI. Ours computes in under a millisecond.
A fast, one-page-per-section, live-updating tool with fewer features and no
treasure hunts is a defensible product — and it is what we are building.

---

## Appendix — scrape quality note

The scraper's content-verification step rejected 318 of 369 discovered
threads. Spot-checking `rejected.json` turned up five wrongly-discarded
threads worth re-fetching, all short Xplan Hints that never say "CALM" or
"Xtools" in the visible text:
- Offset Account — Financial Information, Liabilities (`/discussion/100825`)
- Xplan Hint: Smarter Defaults for Super Contributions (`/discussion/102802`)
- Xplan Hint: Tracking Super Contributions (`/discussion/102139`)
- Xplan Hint: Import Super Contribution Data from Client Focus (`/discussion/102666`)
- Xplan Hint: Best practice: lock your scenarios (`/discussion/102670`)
The filter is otherwise sound — the remaining rejects are genuinely
unrelated (Perspectives, Consumer duty, Real world stories boards).
