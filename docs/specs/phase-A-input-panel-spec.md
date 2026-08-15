# Phase A — Multi-Asset Input Panel (Xtools+ Replacement Build)

## Context for the executing session

This repo (`MonteCarlo`, branch `claude/monte-carlo-investment-app-R9XSB`) is pivoting from a
Monte Carlo dispersion-pedagogy tool to a working investment projection engine — an Xtools+
replacement for an advice firm that does not use Xplan. This phase rebuilds the **input panel
and application state model only**. Engine wiring (deterministic projection, table view, MC
overlay) comes in later phases. Do not build projection logic in this phase beyond what is
needed to keep the app rendering.

Stack: Vite + vanilla JS + Plotly. Key files: `index.html`, `src/main.js`, `src/profiles.js`,
`src/styles.css`. Commit at the end of this phase before starting anything else.

## Locked decisions (do not relitigate)

1. **Real terms primary.** Simulation and inputs are in today's dollars; nominal is a
   display-only toggle using fixed CPI (default 2.5%, configurable in Parameters).
   Carries over unchanged from the existing build.
2. **Deterministic return basis = firm CMA means.** The per-profile expected returns in
   `src/profiles.js` are the firm's house-view CMAs and the single assumption set. The
   future deterministic engine uses each allocation's expected real return; the MC engine
   uses the full regime-switching model. Note for later phases: the deterministic line
   will sit above the MC median (volatility drag) — this gets a one-line disclosure when
   both are on screen. Nothing to build now; do not "fix" the discrepancy when it appears.
3. **Age anchoring.** Time is anchored by current age → projection end age. Start year
   defaults to the current calendar year and is editable. Tables and charts will show
   both Year and Age. The horizon-years slider is removed.
4. **Cashflows attach to assets, not the plan.** Each asset owns its contributions,
   withdrawals, and lump sums. Advice fees are not a fee field — they are modelled as
   ordinary withdrawals (typically from a cash asset), matching how the firm charges.
5. **Ad-hoc cashflows are first-class state.** Manual entries made later in the table
   view (Xplan-style "type a withdrawal into year 10") are stored as lump sums with
   `source: "table"` on the owning asset. The table is an alternative editor of the same
   state — never a separate ledger. This phase builds the model; Phase C builds the grid
   editing.
6. **Tax fields are captured but inert.** Franking, cost base, and the CGT-asset flag
   are collected now so the schema never migrates, but nothing consumes them until the
   v1.1 tax phase. The `src/Tax/` engine stays in the repo untouched.
7. **Non-prescriptive voice.** No winner labelling, no editorialising. Carries over.

## Removals (this phase)

- **Compare mode** (Scenario A/B): remove the toggle, `buildScenarioBlock`'s B branch,
  and all compare-mode rendering paths. Current-vs-proposed comparison is deferred and
  will be rebuilt at plan level later.
- **Drawdown toggle**: remove. Withdrawals are ordinary cashflow rows on an asset.
- **Horizon slider**: remove (replaced by age anchoring).
- **`src/strategyCompare.js` and its UI mount** (`#strategyCompare`): delete the file
  and all references. The withdrawal-strategy comparison panel is permanently cut.
- Leave the other insight modules (`firstDecade`, `drawdownTolerance`, `tornado`,
  `sequenceRisk`) in place but stub their render calls behind
  `LEGACY_INSIGHTS_ENABLED = false` rather than deleting them. They return in the
  insights phase as collapsed accordions.

## New state model

Replace `state.scenarios` with:

```js
state = {
  plan: {
    currentAge: 40,          // integer, 18–100
    endAge: 90,              // integer, must exceed currentAge
    startYear: <current calendar year>,  // editable integer
  },
  assets: [ Asset ],         // ordered array, at least one
  display: { units: "real" | "nominal" },   // existing toggle, unchanged
  assumptions: { cpi: 0.025 },              // existing Parameters modal, unchanged
  schemaVersion: 1,
}

Asset = {
  id: <stable unique string>,     // never reused; used as DOM key
  name: "Asset 1",                // user-editable free text, defaults to "Asset N"
                                  // (users will name these "Cash", "CommSec Portfolio",
                                  // "Investment Property" etc.)
  include: true,                  // checkbox: include in projection totals
  balance: 100000,                // current value, real $

  allocation: Allocation,         // see below

  icrPct: 0,                      // indirect cost ratio, % p.a. of balance.
                                  // The only fee field. Advice fees are withdrawals.

  // --- Tax fields: captured now, consumed in v1.1 ---
  cgtAsset: true,                 // tick box: subject to CGT
  costBase: null,                 // $; enabled + required only when cgtAsset is true.
                                  // Defaults to the entered balance when first ticked
                                  // (editable), matching the common "cost base ≈
                                  // current value for new money" starting point.

  contributions: [ Cashflow ],    // regular savings plans (repeatable rows)
  withdrawals:  [ Cashflow ],     // regular drawdowns incl. advice fees (repeatable)
  lumpSums:     [ LumpSum ],      // one-off in/outflows (repeatable rows)
}

Allocation =
  // Mode 1: firm profile (default)
  { mode: "profile", profile: <key of PROFILES> }
  |
  // Mode 2: custom (Xtools-style manual assumption entry)
  {
    mode: "custom",
    incomePct: 0,          // income return, % p.a. nominal
    growthPct: 0,          // growth return, % p.a. nominal
    frankingPct: 0,        // franking level of income, 0–100. Inert until v1.1.
    volBasis: <key of PROFILES>,  // which firm profile's σ / regime category the MC
                                  // engine will borrow. Pre-select the profile whose
                                  // total nominal return is nearest to
                                  // incomePct + growthPct; user can override.
  }

Cashflow = {
  id: <stable unique string>,
  amount: 0,                      // real $ per period, always positive
  frequency: "monthly" | "annual",
  fromAge: <int>,                 // defaults: contributions from currentAge;
  toAge: <int>,                   //           withdrawals default fromAge = currentAge too
  indexed: true,                  // maintain real value (default true). A non-indexed
                                  // cashflow is fixed-nominal and therefore declines
                                  // in real terms; the panel captures the flag, the
                                  // engine phase implements the decay.
}

LumpSum = {
  id: <stable unique string>,
  amount: 0,                      // real $, positive
  direction: "in" | "out",
  age: <int>,                     // applied at the start of that plan year
  source: "input" | "table",      // "input" = entered in this panel;
                                  // "table" = created by in-grid editing in Phase C.
                                  // Both render identically in this panel's lump sum
                                  // list (table-sourced rows get a small "from table"
                                  // tag and remain editable/deletable here).
}
```

Notes:
- Custom allocation and the engines: the deterministic engine (Phase B) uses
  `incomePct + growthPct` converted to real via the Fisher relation, identical to how
  profile returns are handled. The MC engine (Phase D) uses the same mean with the
  `volBasis` profile's σ and regime category. Nothing to implement now beyond storing it.
- Validation: `fromAge ≥ currentAge`, `toAge ≤ endAge`, `toAge ≥ fromAge`, lump sum
  `age` within [currentAge, endAge]; `costBase ≥ 0`; allocation percentages within
  0–30 for income/growth, 0–100 franking. Clamp silently on plan-age changes where
  possible; show inline field errors otherwise. Never throw.
- Persist state to `localStorage` on change and rehydrate on load (single JSON blob,
  keyed on `schemaVersion` so later phases can migrate).

## UI layout

Single-column layout, top to bottom:

### 1. Plan details bar
Compact horizontal strip: Current age | Projection end age | Start year.
Derived display alongside: "50-year projection, 2026–2076 (age 40–90)" style summary
updating live. Replaces the old header toggles and slider section.

### 2. Asset cards
- Vertical stack of collapsible cards, one per asset. Collapsed card shows: name,
  allocation summary (profile name, or "Custom · X.X% p.a."), balance,
  include-checkbox, expand affordance.
- Expanded card sections, in order:
  - **Details row**: name (inline-editable text), current value ($).
  - **Asset allocation**: segmented control `Firm profile | Custom`.
    - Firm profile: select over `PROFILES` keys (existing behaviour).
    - Custom: income % + growth % + franking % inputs, computed total shown
      ("Total: 7.5% p.a. nominal"), and a "Volatility basis" select over `PROFILES`
      keys with the nearest-return profile pre-selected. One line of helper text:
      "Monte Carlo variability for this asset is modelled on the selected profile."
    - Switching modes preserves the other mode's last values within the session.
  - **Costs row**: ICR (% p.a.). Single field. Helper text: "Advice fees can be
    added as a withdrawal."
  - **CGT row**: "CGT asset" tick box; when ticked, a cost base ($) field appears,
    defaulting to the current value. Helper text: "Used for capital gains tax
    modelling in a future version."
  - **Contributions**: repeatable rows (amount, frequency monthly/annual, from age,
    to age, indexed toggle, remove) + "Add contribution". Default new-asset state:
    one row, $0/monthly, from currentAge to endAge, indexed.
  - **Withdrawals**: same row shape + "Add withdrawal". Default: no rows.
  - **Lump sums**: repeatable rows (amount, in/out, age, remove) + "Add lump sum".
    Default: no rows. Rows with `source: "table"` display a small tag but edit
    like any other row.
- **"Add asset"** button below the stack. New assets take the next "Asset N" name,
  default to profile mode with the middle profile, copy plan ages into cashflow
  defaults.
- **Remove asset**: available when more than one exists; confirm before removing.
- **Include checkbox** greys the card when unchecked (state retained, excluded from
  totals).

### 3. Summary strip
Below the cards: total current value across included assets, count of assets
included, total regular contributions and withdrawals $/yr (annualised, included
assets only). Live-updating. Placeholder for the results header later phases will
extend — keep markup generic.

### 4. Existing sections
- Keep the chart mount, display-units toggle, and Parameters modal. The chart
  renders a flat placeholder ("Projection engine arrives in Phase B") rather than a
  broken Plotly call.
- Parameters modal prose: remove references to the horizon slider, drawdown mode,
  and compare mode. Add one sentence noting custom allocations borrow σ/regime from
  their selected volatility basis profile.

## Styling

Match the existing `styles.css` design language. Aim for the Xplan data-entry feel:
dense but scannable, labels above inputs, consistent column widths across repeatable
rows. No new dependencies.

## Acceptance criteria

1. App loads with one default asset and a valid default plan; no console errors.
2. Add / remove / rename / collapse assets; state survives a page reload
   (localStorage round-trip).
3. Allocation mode switches between profile and custom; custom totals compute live;
   volatility basis pre-selects the nearest-return profile and is overridable;
   switching modes round-trips values within the session.
4. CGT tick box shows/hides cost base; cost base defaults to current value on first
   tick and stays editable.
5. Repeatable cashflow and lump sum rows add, edit, and remove correctly on every
   asset independently; age validation clamps or flags as specified.
6. Changing plan currentAge/endAge updates defaults for new rows and clamps existing
   out-of-range rows.
7. Compare toggle, drawdown toggle, horizon slider, and strategy-comparison panel
   are gone from the DOM and `main.js`; `strategyCompare.js` is deleted.
8. Legacy insight modules are stubbed behind `LEGACY_INSIGHTS_ENABLED = false` with
   no errors.
9. Summary strip totals are correct across include-toggles and edits.
10. `npm run build` succeeds; commit made with message
    `Phase A: multi-asset input panel + plan state model`.

## Deferred (explicitly not this phase — do not build)

- Deterministic projection engine and shared cashflow schedule builder (Phase B).
- Table view / ledger, in-grid ad-hoc cashflow editing, CSV export (Phase C).
- MC opt-in overlay against the new state model (Phase D).
- Insights re-mount as collapsed accordions (Phase E).
- Cross-asset return correlation policy: assets sharing a profile (or volatility
  basis) will share return paths; cross-profile correlation is an open decision to
  be locked before Phase D. The state model must not pre-commit to either answer
  (it doesn't).
- Tax wiring — franking, cost base, CGT flag consumption (v1.1). Entities, super,
  current-vs-proposed comparison.
