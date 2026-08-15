# Phase B — Deterministic Engine, Projection Chart & Ledger Table (Demo Milestone)

## Context for the executing session

Continues the Xtools+ replacement build on branch
`claude/monte-carlo-investment-app-R9XSB`, on top of commits A.3 (fact-find layout)
and A.4 (client/scenario management). If A.3/A.4 are not yet committed, do them
first from their own prompt — this phase assumes them.

This phase makes the tool demoable: the cashflow schedule builder, the deterministic
projection engine (pre-tax), a projection chart, and a CALM-style year-by-year
ledger table, with per-view export. **No tax, no Monte Carlo, no insights** — those
are later phases. Everything runs in real (today's dollars) terms with the existing
nominal display toggle.

This spec is fully self-contained: every convention it depends on is restated here.
Where anything in the current codebase's Parameters modal or comments contradicts
this spec, the spec wins.

Commit at the end of this phase. If it is more natural to commit the engine modules
and the UI separately, two commits are fine (engine first), messages given at the end.

## The state model being consumed (recap)

`src/planState.js` schemaVersion 3+ (post A.2/A.4): `plan` (household single|couple,
client/partner currentAge, endAge client-anchored, start {year, month});
`assets[]` (balance, allocation profile|custom, icrPct, owner, distributions
reinvest|cash, include, cgtAsset/costBase inert until tax); `cashflows`
(income[], expenses[], contributions[], withdrawals[], lumpSums[] — income rows
anchored to the OWNER's age, everything else to the client's); `settings`
(surplus spend|invest+assetId, fundingOrder over included assets);
`assumptions.cpi`; `display.units` real|nominal.

## Locked conventions (implement exactly; the MC phase inherits these)

### Time
1. Plan years are Australian financial years (1 July – 30 June), labelled
   "FY2026–27". Monthly steps throughout.
2. The projection starts at `start` {year, month} and the first plan year is
   **partial**, running from the start month to the following 30 June (an August
   2026 start gives an 11-month FY2026–27). Subsequent years are full FYs. The
   final plan year is the FY in which the client is `endAge`.
3. Ages tick over each 1 July: `currentAge` as entered is the age at the start
   date, incrementing at each FY boundary. Partner ages the same way from their
   own `currentAge`. Income-row from/to ages are on the owner's age; all other
   ages are on the client's.

### Cashflow timing
4. Monthly cashflows apply every month within their [fromAge, toAge] window,
   inclusive of both boundary plan years.
5. Annual cashflows and one-off (lump sum) amounts fire in **July**, the first
   month of each FY. In the partial first year, if the start month is after July,
   that year's annual flows and July-scheduled one-offs for that FY are **skipped**
   (assumed already made earlier in the FY). Monthly cashflows simply run for the
   partial year's months.
6. Indexed cashflows are constant in real terms. Non-indexed cashflows are
   fixed-nominal and therefore decay in real terms:
   real amount at month m = amount / (1 + cpi)^(m/12).

### Returns
7. Nominal gross return for an asset: profile mode → the profile's total nominal
   return from `src/profiles.js`; custom mode → (incomePct + growthPct)/100.
   Net nominal = gross − icrPct/100. Real annual = (1 + netNominal)/(1 + cpi) − 1
   (Fisher). Monthly rate = (1 + realAnnual)^(1/12) − 1 (geometric compounding —
   exact, not /12).
8. The income/growth split and franking are **not used** this phase (they activate
   with tax in B.1). Distribution treatment (reinvest vs cash) is also inert this
   phase: model all returns as accruing in the asset. Note this in the pre-tax
   banner copy ("distributions and tax arrive with the tax engine").

### The monthly ledger loop (the heart of the engine)
9. For each month, in this order:
   a. Grow every included asset: B ← B × (1 + r_month).
   b. Apply asset-targeted flows from the schedule: contributions in,
      withdrawals out, one-offs in/out, per their target asset. A withdrawal
      or outbound one-off exceeding the asset's balance takes what's there;
      the remainder is **unfunded** (recorded; it does NOT cascade to other
      assets — explicit withdrawals are instructions about a specific asset).
   c. Compute the month's household cashflow position:
      net = income − expenses (from the schedule; income and expenses do not
      touch assets directly).
   d. If net > 0 (surplus): settings.surplus — "spend" → it disappears;
      "invest" → add to the nominated asset (if that asset is excluded or
      missing, fall back to spend; A.2 normalisation should prevent this).
   e. If net < 0 (deficit): draw the shortfall from included assets in
      `settings.fundingOrder`, draining each to zero before the next. If all
      are exhausted, the remainder is **unfunded cashflow** (recorded).
10. Balances never go negative. Track per month: total unfunded amount and,
    per asset and overall, the first month/age any shortfall occurred.
11. Excluded assets: no growth, no flows, invisible to funding order and totals.
    Rows targeting an excluded asset contribute nothing (consistent with the
    input panel's flagging).

### Display
12. The engine computes real values only. Nominal is a display-time scaling:
    value × (1 + cpi)^(m/12) — applied in chart/table rendering, never inside
    the engine.

## Module 1 — `src/schedule.js` (pure, unit-tested)

`buildSchedules(state)` → per-month arrays for the whole projection:
- per-asset net targeted flows (contributions/withdrawals/one-offs by assetId),
- household income and expenses (separately, for the ledger and future tax),
keeping conventions 1–6. Also export helpers: month count, month→FY label,
month→client age, month→owner age mapping. No engine or DOM knowledge.

Tests: annual/July timing incl. the partial-first-year skip (convention 5, exact
month indices for July and August starts); indexed vs non-indexed decay
(closed-form spot check at year 10); boundary-year inclusivity; owner-age
anchoring for a couple with different ages; excluded-asset rows contribute zero.

## Module 2 — `src/deterministic.js` (pure, unit-tested)

`projectPlan(state)` →
- per-asset monthly balances (index 0 = opening) and the combined series;
- a `yearly` ledger, one row per plan year (partial first year included), with:
  fyLabel, clientAge (and partnerAge when couple), income, expenses,
  surplusOrDeficit, deficitFundedFromAssets, unfundedCashflow,
  contributions, withdrawals, oneOffsNet, growth, fees: null (reserved),
  tax: null (reserved for B.1), opening and closing combined balance,
  and per-asset closing balances;
- shortfall summary: first unfunded age (explicit-withdrawal and deficit kinds
  can share one "first shortfall" for display), total unfunded.

Implements conventions 7–11 on Module 1's output.

Tests: zero-return sanity (closing = opening + net flows); constant-return
closed form for a no-cashflow asset; the classic annuity check (single asset,
$100k, $500/month indexed, 20y, zero cashflow elsewhere — closing equals the
closed-form value within tolerance); deficit funding drains fundingOrder in
order and switches assets mid-year correctly; unfunded amounts recorded for
both kinds; surplus invest routes to the nominated asset; combined = Σ
per-asset every year in a 3-asset plan; partial first year totals.

## UI — output shell, chart view, table view

Replace the chart placeholder area with an **output shell**: a view switcher
(tabs or segmented control matching existing styles) that later phases extend.
This phase ships two views; the shell is the pattern (each view = a render
function + an export button slot).

**Pre-tax banner** across the top of the output area, dismissible per session:
"Pre-tax projection — income tax, CGT, franking and distribution treatment
arrive with the tax engine (next phase)."

### View 1 — Projection (chart)
- Combined balance line over plan years; x-axis FY labels (thinned to fit),
  hover shows FY, client age, value.
- "Show individual assets" toggle: adds a line per included asset.
- If any unfunded amount exists: a marker at the first-shortfall year and one
  neutral line beneath the chart: "Planned outflows exceed available funds from
  age X (FY…); $Y of outflows are unfunded over the projection." No advice
  language.
- Real/nominal display toggle applies (convention 12).
- Export button: download the chart as PNG (Plotly.toImage) named
  <client>-<scenario>-projection.png.
- Live-recompute on any input change (the engine at this size is
  sub-millisecond; no worker, no debounce).

### View 2 — Ledger (table)
- One row per plan year from `yearly`. Column groups, CALM-style:
  Year (FY, age) | Cashflow: income, expenses, surplus/(deficit) |
  Investment flows: contributions, withdrawals, one-offs, deficit funding,
  unfunded | Assets: growth, closing balance (combined) | per-asset closing
  balances (one column each, toggleable "Show per-asset columns").
- Columns that are all zeros across the projection are hidden automatically
  (a portfolio-only scenario shows a clean asset ledger, not a wall of
  zero cashflow columns).
- Negative values in parentheses, thousands separators; real/nominal toggle
  applies.
- Export button: CSV of exactly the visible columns, named
  <client>-<scenario>-ledger.csv.

### Summary strip
Gains: projected end balance (active display units) and, when present, first
shortfall age. Existing tiles unchanged.

### Parameters modal
Add a "Deterministic projection" section in user-facing language: the monthly
loop order (grow → asset flows → household surplus/deficit → funding), the
July/annual convention recap, unfunded-cashflow meaning, and the existing
note that the deterministic line uses expected returns (sits above the future
Monte Carlo median — that disclosure text already exists in the modal; link
the two rather than duplicating).

## Acceptance criteria

1. `schedule.js` and `deterministic.js` are pure modules (no DOM/Plotly
   imports) with all specified tests passing alongside the existing suite.
2. A portfolio-only scenario (no income/expenses) projects correctly and the
   ledger auto-hides the empty cashflow columns.
3. A drawdown scenario (expenses only, two assets, funding order cash-first)
   shows deficit funding draining assets in order and reports the correct
   first-shortfall age in chart, table, and summary strip.
4. Real/nominal toggle: nominal year-10 combined balance = real × 1.025^10 at
   default CPI (test or scripted check).
5. Chart PNG and ledger CSV exports download with the specified names; CSV
   matches visible columns.
6. Pre-tax banner shows on both views, dismisses for the session.
7. Everything live-updates on input changes with no console errors;
   `npm run build` clean.
8. Commit message(s): `Phase B: cashflow schedule + deterministic engine`
   and (if split) `Phase B: projection chart + ledger table views`.

## Deferred — do not build

- Tax (B.1): income tax on owner-attributed income, franking, pooled-cost-base
  CGT across both regimes (pre/post 1 July 2027), CPI-indexed brackets with a
  no-indexation toggle, tax on FY t paid first month of FY t+1, distribution
  reinvest-vs-cash activation. The ledger's reserved tax column fills then.
- Monte Carlo rewire to the shared schedule (D; cross-asset correlation
  decision must be locked first). Additional chart views — cashflow bars,
  stacked assets, allocation over time (later; the view shell is the hook).
- Scenario compare chart, report period selector, in-grid ledger editing
  (creates lumpSums with source:"table"), insights accordions, liabilities,
  super, what-if crash lever.
