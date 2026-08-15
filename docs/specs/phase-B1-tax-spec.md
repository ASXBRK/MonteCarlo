# Phase B.1 — Tax Engine Integration (Income Tax, Franking, CGT)

## Context for the executing session

Continues the Xtools+ replacement on branch `claude/monte-carlo-investment-app-R9XSB`,
on top of Phase B (`6edd9f9`). This phase activates tax: personal income tax on
owner-attributed income, franking gross-up and refundable offsets, and CGT on asset
sell-downs using a pooled cost base across both legislative regimes. The ledger's
reserved `tax` column fills; the pre-tax banner comes down.

The repo already contains `src/Tax/engine.js` with tested primitives this phase must
reuse, not duplicate: `marginalTax(income, fy)`, `medicareLevy(taxableIncome)`, the
`LEG` constants (both regimes, bracket tables, medicare thresholds, 30% minimum tax,
indexation), and the bucket/regime logic. Build the new annual tax function around
these. The standalone parcel-sale calculator paths (`runCGTProjection` etc.) are for
a different tool surface and are not wired here.

Design this phase so the tax function is **shared**: a pure function the
deterministic engine calls now and the Monte Carlo engine will call per-path later.
No DOM knowledge anywhere in it.

Commit at the end (two commits fine: tax modules, then ledger/UI wiring).

## Locked decisions

### Scope of tax modelled
1. Resident individual income tax (marginal brackets), Medicare levy with
   shading-in (single thresholds per person — family thresholds not modelled,
   disclosed), and **LITO** (low income tax offset, current design: $700 max,
   withdrawing per current law — implement from the current legislated schedule,
   non-refundable). SAPTO, HELP, Medicare levy surcharge, and Div 293 are NOT
   modelled — disclose in the Parameters modal.
2. Franking: the franked portion of distribution income is grossed up
   (credit = franked amount × 30/70) and included in taxable income; the credit
   is a **refundable** offset. Net tax for a person can therefore be negative
   (a refund, which increases household cashflow).
3. Everything runs in **real dollars**, consistent with the engine. Under the
   default bracket setting this is exact, not an approximation (see 5).

### Income attribution and components
4. Per FY, per person, assessable income =
   - income rows owned by that person (gross, from the schedule), plus
   - distribution income from assets they own (joint assets: 50/50 split), plus
   - net capital gains attributed to them (see CGT section),
   less deductions: each asset's ICR × balance is deductible against its owner's
   income (investment cost), attributed like the income.
   Distribution income for an asset-year = the asset's **nominal income yield ×
   its (real) balance**, accrued monthly. Profile mode: the profile's income
   component from `src/profiles.js`; custom mode: `incomePct`. The franked
   proportion comes from the profile's `frankingPct` (A.2 placeholders) or the
   custom allocation's `frankingPct`.

### Distribution treatment (activates the A.2 toggle)
5. **Reinvest** (default): the income component stays in the asset (asset
   continues to grow at the full net return, as Phase B already models) and the
   reinvested amount is **added to the asset's cost-base pool** monthly. It is
   still taxable income to the owner — reinvestment does not avoid tax.
   **Paid as cash**: the income component leaves the asset monthly (the asset's
   growth rate becomes the growth-only component net of ICR — rebuild the
   monthly rate accordingly) and enters household cashflow as income in that
   month, feeding the surplus/deficit line. Taxable identically.

### Brackets over the projection
6. Default — "Indexed (real-constant)": tax brackets, Medicare thresholds, and
   LITO parameters are held **constant in real terms** for every FY from
   FY2027–28 onward, using the `LEG` 2027-28 tables as the base (FY2026–27 uses
   its own legislated table). This models CPI-indexed tax settings and is exact
   in the real-dollar frame.
   Toggle — "No indexation (bracket creep)": nominal settings frozen at the
   FY2027–28 tables, which in real dollars means every threshold shrinks by
   CPI annually: real threshold in plan year y = nominal / (1+cpi)^y.
   The toggle lives in the Parameters modal, default Indexed, with one
   sentence explaining each.

### CGT — pooled cost base, both regimes
7. Each asset carries **one cost-base pool** (no parcels). Seeded from the
   user's `costBase` (assets with `cgtAsset: false` never generate CGT and skip
   all of this). Contributions and one-off inflows add to the pool at their
   real amount; reinvested distributions add monthly (decision 5). Any sale
   (explicit withdrawal, outbound one-off, or deficit-funding draw) removes a
   proportional slice: if fraction f of the asset's value is sold, f of the
   pool is consumed and the realised gain = proceeds − f × pool.
8. **Deemed reacquisition at 1 July 2027** (enacted law): at that month, every
   CGT asset's pool is reset to its market value. Gains accrued before that
   date are NOT taxed at that point (no CGT event for the deemed disposal in
   our modelling scope — the reset is the transition mechanism); they simply
   never enter the post-reform pool. Note in the modal that this follows the
   transition rules at the level this tool models.
9. **Post-reform sales** (on/after 1 July 2027): the pool is CPI-indexed, which
   in real dollars means it is constant — real gain = real proceeds − f × pool,
   directly. Tax on the gain per person per FY = the greater of (a) marginal
   tax (with Medicare) on the indexed gain and (b) 30% × the gain, consistent
   with `LEG.minimumTaxRate` and the engine's `simple_max` application. Losses:
   a negative pool-relative result is a capital loss, carried forward per
   person and offset against future gains before tax (never against ordinary
   income).
10. **Pre-reform sales** (before 1 July 2027 — at most the first FY or two):
    old rules; apply the 50% discount, assuming all holdings qualify for the
    12-month holding period EXCEPT amounts contributed within the same FY as
    the sale (pool the year's contributions separately for this check, or
    simply flag: if the asset received contributions that FY, the sold slice
    is treated as coming proportionally from old and new money with only the
    old portion discounted). Keep this simple and disclosed — the window is
    tiny and the deemed reacquisition erases it.
11. Joint assets: gains and losses split 50/50 between owners.

### Timing (amends the earlier all-in-t+1 decision — this is the locked version)
12. **Income tax** (on income rows, distributions, less deductions and offsets)
    for FY t accrues **within FY t**, deducted from household cashflow evenly
    across the months of that FY in which the underlying income arises
    (a PAYG-withholding approximation). The deterministic engine knows the
    year's schedule upfront, so compute the FY's income tax, then spread it.
    A net refund (excess refundable franking credits) is credited in the
    final month of the FY.
13. **CGT** assessed on FY t's realised net gains is paid as a single household
    outflow in **July of FY t+1** (assessment timing). This breaks the
    circularity: deficit-funding sales in year t create tax that is simply
    part of year t+1's cashflow needs. The final FY's accrued CGT cannot be
    paid inside the projection — surface it as "CGT liability accrued at end
    of projection: $X" in the summary strip and ledger footer.
14. Tax outflows enter the household surplus/deficit line like any expense and
    are funded by the same mechanics (surplus first, then fundingOrder, then
    unfunded). Tax is NOT itself an income-row or expense-row — it is computed.

## Modules

### `src/Tax/annual.js` (new, pure, unit-tested)
The shared annual tax function. Suggested shape:
`assessPerson({ fy, planYear, bracketMode, cpi, ordinaryIncome, deductions,
distributions: { franked, unfranked }, netCapitalGain, capitalLossCarryFwd })`
→ `{ incomeTax, medicare, lito, frankingCredits, netIncomeTax, cgtTax,
lossCarryFwd }`, using `LEG`/`marginalTax`/`medicareLevy` internally with the
bracket-mode scaling from decision 6. No knowledge of assets or the ledger.

### `src/costBasePool.js` (new, pure, unit-tested)
Pool mechanics per asset: seed, add (contribution/reinvestment), proportional
consume returning realised gain/loss, the 1 July 2027 reset, pre-reform
same-FY contribution handling. Real-dollar throughout.

### `src/deterministic.js` (extended)
The monthly loop gains: distribution accrual per mode, pool maintenance,
sale-slice gain recording per owner, the FY-boundary tax assessment feeding
decisions 12–13, and tax outflows through the existing surplus/deficit path.
The `yearly` ledger's `tax` field fills (household total, income tax + CGT
paid that FY); add `taxDetail` per row ({client, partner, incomeTax, cgt,
frankingCredits}) for a future breakdown view, and the end-of-projection
accrued-CGT figure to the plan result.

## Tests (beyond per-module unit tests)
- Known-value checks: a single person, $100k salary, FY2027–28 tables, no
  investments — net tax matches a hand-computed figure including Medicare and
  LITO (put the hand calculation in a comment).
- Franking: fully-franked $7,000 distribution to a person with zero other
  income → refund of the full credit.
- Bracket modes diverge over time: same scenario, year-20 tax higher under
  "no indexation" (and equal in year 0/1).
- Pool: contribute → partial sale → gain matches hand-computed proportional
  slice; reinvested distributions uplift the pool; loss carry-forward offsets
  a later gain; the 2027 reset zeroes unrealised history (sale immediately
  after reset at unchanged real value → zero gain).
- Timing: CGT from a year-t deficit-funding sale appears as a July year-t+1
  outflow; a final-year sale's CGT lands in the accrued liability, not the
  cashflow.
- Distributions paid-as-cash reduce the asset's growth to growth-only and
  appear as household income; reinvest mode leaves Phase B balance behaviour
  identical for a zero-franking, zero-tax person (regression guard).
- Whole-suite regression: all existing tests still pass; portfolio-only
  scenarios with `cgtAsset: false` and no income produce zero tax everywhere
  (second regression guard — the simple demo case must not change).

## UI
- Pre-tax banner removed. Ledger `Tax` column renders (all-zero auto-hide
  still applies, so untaxed scenarios stay clean); ledger footer and summary
  strip show the accrued end-of-projection CGT when nonzero.
- Parameters modal: new "Tax" section — what's modelled (brackets, Medicare,
  LITO, franking, both CGT regimes, deemed reacquisition, pooled cost base,
  PAYG-in-year vs CGT-in-arrears) and what's not (SAPTO, HELP, MLS, Div 293,
  family Medicare thresholds, trusts/companies/super); the bracket-indexation
  toggle with its two one-line explanations. Keep the tone of the existing
  modal sections.
- No new views this phase (a tax-breakdown view can come later off
  `taxDetail`).

## Acceptance criteria
1. All specified tests pass alongside the full existing suite; build clean.
2. A comprehensive scenario (couple, salaries, expenses, franked portfolio,
   drawdowns crossing 1 July 2027) runs with plausible, hand-checkable year-1
   and year-20 tax figures and no console errors.
3. The two regression guards hold exactly.
4. Ledger/summary/Parameters updates as specified; banner gone.
5. Commit message(s): `Phase B.1: annual tax function + cost base pools` and
   (if split) `Phase B.1: tax wired into ledger + parameters`.

## Deferred — do not build
- Tax inside Monte Carlo paths (Phase D — the shared `annual.js` +
  `costBasePool.js` design is what makes that feasible; per-path scalar pools,
  no parcels).
- Tax-breakdown output view; SAPTO/HELP/MLS/Div 293; entities; super;
  in-grid ledger editing; additional chart views; scenario compare; report
  period selector; insights; liabilities.
