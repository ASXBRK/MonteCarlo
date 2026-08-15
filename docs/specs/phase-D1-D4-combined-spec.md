# Phases D1–D4 — Intake, Asset Classes, Liabilities, Property

## Context and execution rules

Continues the Xtools+ replacement on branch `claude/monte-carlo-investment-app-R9XSB`,
on top of Phase C4 (`69d867b`). Four phases in one spec. **Execution rules:**

1. Build strictly in order D1 → D2 → D3 → D4. **One commit per phase minimum**
   (split a phase into engine/UI commits if natural).
2. After each phase: full test suite + build must pass, and the phase's
   regression gates must hold, BEFORE starting the next phase.
3. If a regression gate fails and the fix isn't obvious, stop and report
   rather than pushing on — later phases depend on earlier ones being right.
4. Report per phase in the final summary.

All existing conventions hold throughout: FY anchoring, partial first year,
1 July age ticks, July annual-flow timing with partial-year skip, real-terms
engine with display-time nominal scaling, Fisher return conversion, pooled
cost bases, both CGT regimes with the 1 July 2027 deemed reacquisition,
PAYG-in-year income tax / CGT paid t+1, surplus/deficit with fundingOrder.

---

# D1 — Identity intake, life-expectancy anchoring, indexation model

## 1. Identity intake (Setup section)
- **Client**: first name, surname, **date of birth**, **sex** (Male | Female —
  helper text: used for life expectancy), marital status
  (**Single | Married | De facto**). Married/De facto reveals **Partner**:
  first name, surname, DOB, sex.
- Per-person tax profile (residency, Medicare, Centrelink flag) moves into
  each person's block and gains **Opening carry-forward capital losses ($)**
  (default 0), seeding the B.1 loss mechanism in the first assessment year.
- Names flow through everywhere: Tax view row groups, owner selects and tags,
  the client page (workspace client name defaults from the client's full name
  on first entry, independently renameable after).
- DOB replaces `currentAge` as stored. Age at start = floor of exact age at
  the start date; ages still tick each 1 July (unchanged; DOB precision is
  for LE lookup only — extend the modal disclosure). Live age shown by each
  DOB input.
- Migration (schemaVersion bump): synthesise DOB = 1 July of
  (startYear − currentAge); household "couple" → "married"; placeholder names
  the UI treats as unset; openingCapitalLosses 0. Projections must be
  behaviour-identical post-migration (regression gate).

## 2. Life-expectancy-anchored projection end
- Embed ABS Life Tables 2020–2022 (remaining LE by single year of age and
  sex, 0–100+) as `src/data/lifeTables.js` with source comment and published
  date; `remainingLE(age, sex)`. Include the ABS source values for the test
  ages in comments.
- Projection end control replaces the plain end-age input. Basis:
  `Life expectancy` (default) | `LE +5/+10/+15/+20` | `LE −5/−10/−15` |
  `Fixed age` | `Fixed number of years`.
- Couples: LE bases anchor to the **longest** LE in the household, labelled
  with whose it is. Resolution line under the control:
  "Projecting to age 92 (FY2078–79) — life expectancy of [name] + 5".
- Store resolved `endAge` (client-anchored; engine consumes it unchanged)
  plus basis metadata; **re-resolve** on any DOB/sex/marital/partner change
  while an LE basis is active.

## 3. Indexation model (replaces the `indexed` tick box on every cashflow row)
- Per row: **Index basis** `None | CPI | Wage index (AWOTE)` (default CPI) +
  **Additional %** (default 0) + live computed total ("CPI 2.5% + 1.0% = 3.5%").
- `assumptions.awote` (nominal, default 3.5%) joins the Parameters modal.
- Engine: nominal indexation g = basis + additional; real amount at month m =
  `amount × ((1+g)/(1+cpi))^(m/12)`. So CPI+0 = constant real (old
  `indexed:true`); None+0 = decays at CPI (old `false`); AWOTE-linked income
  grows in real terms. Closed-form unit test per case.
- Migration: `indexed:true` → CPI+0, `false` → None+0. **Regression gate:**
  one scenario of each kind bit-identical to pre-migration output.

## 4. Summary tiles removed
Remove the input-echo tiles (current value, assets included, annualised
flows). Keep only projected end balance + first-shortfall tile. Slim bar.

## D1 tests
LE spot checks vs ABS figures (M/F at 40 and 65); longest-LE resolution and
re-resolution; fixed bases; indexation closed forms; both migration gates;
opening losses offset a year-1 gain (known value). Commit:
`Phase D1: identity, life expectancy anchoring, indexation model`.

---

# D2 — Asset classes: financial vs lifestyle

## Model
`Asset` gains `class: "financial" | "lifestyle"` (migration: all existing →
financial). **Lifestyle assets** (contents, vehicles, jewellery, other):
name, owner, value, simple **growth % p.a.** (nominal, default 0), nothing
else — no allocation, no ICR, no distributions, no CGT fields (exempt
personal-use treatment; disclose the simplification that collectables are
not separately modelled), no cashflow targeting, **never** in fundingOrder or
surplus-invest targets, no contributions/withdrawals/one-offs may target them
(validation + migration check).

## UI
Assets section splits into **Financial assets** and **Lifestyle assets**
subsections (property arrives in D4 as its own section). Lifestyle cards are
the minimal field set. Add-asset buttons per subsection.

## Engine/outputs
Lifestyle values grow at their rate (real = Fisher of nominal, as ever) and
appear: in the Assets view as their own group with closing balances, and in
the combined closing balance. (When D5 later adds per-item display
exclusions, lifestyle is the natural exclude — nothing to build now.)

## D2 tests
Lifestyle growth closed form; funding order and targeting validation;
migration. **Regression gate:** financial-only scenarios bit-identical.
Commit: `Phase D2: financial and lifestyle asset classes`.

---

# D3 — Liabilities

## Model
New plan-level `liabilities: [ Liability ]`:
```
Liability = { id, name, type: mortgage|investment|personal|other,
  owner: client|partner|joint, balance, interestRatePct (nominal p.a.),
  termYears, repayment: "pi" | "io" ( + ioYears then P&I for the remainder ),
  deductible: bool (interest deducts against owner's income),
  linkedAssetId: <asset id|null> (what it relates to / is secured by — a
    financial, lifestyle, or (from D4) property asset; informational now,
    used by D4 purchases and future sale events),
  offsetAssetId: <financial asset id|null> }
```

## Engine (monthly, inside the existing loop)
- Interest accrues monthly on the **interest-bearing balance** = loan balance
  − min(offset asset's balance, loan balance). The offset asset earns its
  investment return **only on the excess** above the loan balance (the offset
  portion earns nothing; it is "earning" the loan rate implicitly). The offset
  asset otherwise behaves normally (flows, funding order, CGT).
- Repayments: standard amortisation. P&I: level monthly payment from rate ×
  remaining term, recomputed if the rate assumption ever changes (it can't
  mid-projection in v1 — constant rate; note as a limitation). IO: interest
  only for ioYears, then P&I over the remaining term. Repayments are
  **nominal-fixed** in reality; in the real-terms frame they therefore decay
  at CPI — implement via the D1 indexation machinery with basis None
  (regression-friendly and correct: this is why real mortgage burdens fall
  over time, and the composite chart in D5 will show exactly that).
- Repayments (interest + principal) are household outflows through the
  normal surplus/deficit path. Principal reduces the balance; loan ends when
  balance hits zero (final part-payment, not a full level payment).
- Deductible interest joins the owner's deductions (joint: 50/50), same
  mechanism as ICR deductions.
- No extra/early repayments, no redraws, no rate changes in v1 (disclose).

## UI
Liabilities section replaces its placeholder: repeatable cards (field set
above), offset select lists financial assets only, linked-asset select lists
all assets. Derived display per card: monthly repayment, payoff FY.

## Outputs
- Cashflow view: a **Liabilities** row group (interest, principal, per loan
  or aggregated — per loan, labels from names) feeding the existing totals.
- Assets view (Consolidated): a **Liabilities** group (closing balance per
  loan, negative) and a **NET ASSETS** total row (assets − liabilities).
- Tax view: deductible interest appears within each person's deductions.
- The Net assets rail placeholder can now be retired IF trivial — otherwise
  leave for D5's chart work; the table-side net assets row is required now.

## D3 tests
Amortisation closed form (level payment formula, payoff month exact); IO→P&I
transition; offset reduces interest and the offset asset earns only on the
excess (known-value month); real-terms decay of nominal repayments;
deductible interest reduces tax (known value); joint split. **Regression
gate:** liability-free scenarios bit-identical.
Commit: `Phase D3: liabilities, offsets, amortisation`.

---

# D4 — Property (owned and planned purchases)

## Model
New plan-level `properties: [ Property ]`:
```
Property = { id, name, owner, state: NSW|VIC|QLD|WA|SA|TAS|ACT|NT,
  propertyType: ppr | holiday | investment,
  status: "owned" | "planned",
  // owned:
  currentValue, acquisitionDate (past; drives CGT regime + gearing rules),
  costBase (seed; as financial assets),
  // planned:
  priceToday (today's $; grows at growthPct until purchase),
  purchaseAge (client age; July of that FY per one-off conventions),
  lvrPct, firstHomeBuyer: bool, newBuild: bool,
  purchaseCostsPct (transfer/legal, default 2%... use 1.5% if a better
    standard exists; overridable), dutyOverride: $|null,
  // both:
  growthPct (nominal, default: the Residential Property profile's growth
    component from profiles.js; overridable),
  // investment type only:
  rentPa (today's $, D1 indexation controls, default basis CPI),
  expensesPa (same), expensesDeductible: bool (default true) }
```

## Purchase event (planned → owned, in the purchase FY's July month)
1. Purchase price = priceToday grown at growthPct to the purchase month
   (real-terms equivalent via Fisher, consistent with everything else).
2. **Stamp duty** from the embedded state schedules (below), or dutyOverride.
   FHB concessions applied when firstHomeBuyer per that state's rules; FHOG
   (new-build grants) added as a cash inflow where applicable.
3. Loan created = lvrPct × purchase price, as a D3 liability (type mortgage
   for ppr/holiday, investment for investment properties → deductible
   interest default accordingly; linkedAssetId = the property; default 30-year
   P&I at a `assumptions.mortgageRate` (nominal, default 6.0%, Parameters).
4. Cash at settlement = purchase price − loan + duty + costs − FHOG. This
   enters household cashflow as a one-off outflow that month, funded through
   the **normal funding order**; a shortfall is unfunded cashflow (the
   purchase still completes — the gap is the finding).
5. Cost base pool seeds = purchase price + duty + costs (duty and incidentals
   are cost base elements).
6. Before the purchase month the property contributes nothing to any output;
   the input card shows a live helper: "Projected price at purchase
   (age 34, FY2032–33): $978,000 · duty ≈ $36,000 · cash required ≈ $141,000".

## Stamp duty data
`src/data/stampDuty.js`: all eight jurisdictions' general residential
transfer duty schedules + first-home concession rules + FHOG amounts
(new-build), as at a stated date, with source comments per state. Keep the
structures simple (bracket tables + FHB threshold/phase-out parameters).
Duty amounts are computed in nominal dollars of the purchase year (brackets
are nominal law): compute nominal price at purchase, apply schedule, deflate
to real for the ledger. Note in the modal that duty brackets are held at
their as-at values (not indexed) and the override field exists for precision.

## Ongoing property behaviour
- Value grows at growthPct (Fisher to real). Appears in Assets view (own
  **Property** group), in net assets, with unrealised-gain visibility coming
  in D5.
- Investment properties: rent → owner's assessable income; expenses (when
  deductible) and loan interest (via D3 deductible flag) → deductions.
  **Negative gearing:** net rental losses (rent − expenses − deductible
  interest, per property, per owner share) offset other income when EITHER
  the loss year is pre-1 July 2027 OR the property is a new build; otherwise
  the loss is **quarantined** per owner — carried forward and applied against
  future net rental income first, then capital gains (consistent with the
  enacted restriction; disclose in the modal's tax section).
- PPR and holiday: no income, no deductions (holiday home expenses
  non-deductible — not asked, not modelled; disclose).
- CGT: properties are CGT assets (PPR **exempt** — flag and skip assessment;
  disclose that main-residence complexities like the 6-year rule are out of
  scope until sales are modelled). No property sales in v1 — properties held
  to projection end; their unrealised position simply exists.
- Properties are NOT in fundingOrder (illiquid; disclose).

## UI
**Property** section (own top-level section between Lifestyle assets and
Liabilities in the fact-find order): repeatable cards, field set above,
status toggle switching the owned/planned field groups, investment type
revealing rent/expenses. The live purchase-projection helper line on planned
cards. Setup gains nothing; Parameters gains mortgageRate, the duty
as-at/source note, and the tax-section additions above.

## Outputs
Cashflow view: rent rows (per investment property, owner-tagged), property
expense rows, and the settlement outflow appearing in the one-off group in
its year. Assets view: Property group + net assets already handled by D3.
Tax view: rental income/deductions inside each person's figures; quarantined
loss carry-forward visible as a row when nonzero.

## D4 tests
Duty schedule spot checks: at least two known values per state at the as-at
date (source figures in comments), plus one FHB-concession case and one FHOG
new-build case. Purchase event end-to-end: grown price, duty, loan creation,
settlement cash through funding order (funded and shortfall variants), cost
base seeding. Negative gearing: pre-2027 loss offsets salary; post-2027
existing-dwelling loss quarantines then applies against later rental profit;
post-2027 new-build loss offsets salary. PPR exemption skips assessment.
**Regression gates:** property-free scenarios bit-identical; the B.1
comprehensive couple scenario unchanged.
Commit: `Phase D4: property, purchase events, stamp duty, gearing rules`.

---

## Deferred — do not build in any of these phases
Property sales and main-residence exemption mechanics; extra/early loan
repayments, redraw, variable rates; D5 output restructure (Graphs|Tables
split, composite Cashflow-Assets-Liabilities chart, age-first columns,
hide-empty-rows toggle, unrealised gain row, per-item display exclusions,
balanced banner, scenario lock/metadata, real names already done in D1);
Monte Carlo rewire; insights; super; entities; aged care; Centrelink.
