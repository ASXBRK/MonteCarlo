# Spec audit against implementation

Audit date: 15 Aug 2026. Scope: the 10 numbered specs in `docs/specs/`, cross-checked
against the current codebase (branch `claude/monte-carlo-investment-app-R9XSB`,
531 tests green, build clean), plus `docs/reference/build-log.md`, `CLAUDE.md`,
and the two corpus-review reference docs.

Method: one independent, full-repo audit per spec (ten in total), plus two
cross-cutting sweeps — undocumented engine behaviour, and stale user-facing
text/comments. Each spec audit read the spec in full, read the relevant source
files and tests directly (not summaries), and classified every numbered
requirement as **DONE**, **PARTIAL**, **MISSING**, or **SUPERSEDED**. This
document consolidates those findings. Where an item is DONE with no
complications, it's listed tersely; PARTIAL/MISSING/SUPERSEDED items and all
drift keep their full specifics (file, line, commit) because that's where the
audit actually earns its keep.

**Numbering used below** (matches "01 through 10" in the request):

| # | Spec file | Phase |
|---|---|---|
| 01 | `phase-A-input-panel-spec.md` | Phase A |
| 02 | `phase-A1-cashflow-fy-spec.md` | Phase A.1 |
| 03 | `phase-A2-household-income-spec.md` | Phase A.2 |
| 04 | `phase-B-engine-chart-table-spec.md` | Phase B (engine) |
| 05 | `phase-B1-tax-spec.md` | Phase B.1 (tax) |
| 06 | `phase-C-output-views-spec.md` | Phase C (C1–C4) |
| 07 | `phase-D1-D4-combined-spec.md` | Phases D1–D4 |
| 08 | `tier1-1-key-dates-spec.md` | Tier 1.1 (key dates) |
| 09 | `tier1-2-super-spec.md` | Tier 1.2 (super) |
| 10 | `super-indexation-div296-montecarlo-spec.md` | Session A + Session B |

**Headline result, upfront:** the engine's own conventions (specs 04, 05, 08, 09)
are in very good shape — almost everything is DONE, and the drift that exists is
disclosed and deliberate. The two weak points are exactly where you'd expect:
**spec 02** (Phase A.1, never actually delivered to the session that built it)
has two genuinely missing features, not just cosmetic drift; and **spec 10's
Session B** (Monte Carlo, built from a one-line paraphrase) has real, undetected
divergences from the actual spec text, including two concrete, currently-shipping
bugs. Both are covered in detail in §2.

---

## 1. Spec by spec

### 01 — Phase A (multi-asset input panel)

Oldest spec; almost every field name and structural decision it specifies has
since been superseded by later phases while the underlying *capability*
survived. Commit `c734897` matches verbatim.

- **Locked decisions 1–7** (real-terms primary, firm-CMA deterministic basis,
  age anchoring, cashflows-attach-to-assets, ad-hoc table cashflows,
  tax-fields-inert, non-prescriptive voice) — DONE or SUPERSEDED by name:
  decision 4 (cashflows attach to assets) was inverted by Phase A.1 (cashflows
  moved *up* to plan level, each row keeping an `assetId`) — same capability,
  opposite direction; decision 6 (tax inert) is now false, tax fully consumes
  cost base/CGT flag/franking since B.1.
- **Removals** (compare mode, drawdown toggle, horizon slider, `strategyCompare.js`,
  legacy insights stubbed) — all DONE, confirmed absent by grep.
- **State model** — SUPERSEDED almost field-for-field: `schemaVersion` is 11,
  not 1; `plan.currentAge` → DOB-derived; `Cashflow.fromAge/toAge` → DateRef
  `from/to` (Tier 1.1); `indexed:true/false` → `indexBasis + indexExtraPct` (D1);
  persistence is a Client→Scenario workspace index (`src/workspace.js`), not a
  single localStorage blob. All capabilities retained under new names/mechanisms.
- **UI layout** — mostly DONE at the time, since restructured into a
  sidebar, one-page-per-section fact-find (`152e745`) rather than the spec's
  single-column layout — a full restructuring, not a regression.
- **Summary strip** (item 01.35) — SUPERSEDED: removed entirely in D1
  ("Slim bar... the input-echo tiles are gone", `main.js`), replaced by full
  output views (Key Figures, Assets, composite chart).
- **MISSING (real gap, small):** a freshly-added asset via "Add asset" no
  longer seeds a default $0/monthly contribution row — only the bootstrap
  asset in `defaultState()` gets one. A user must go to Investment Cashflows
  and add a row manually. Minor, but genuinely not what the spec (or later
  specs) describe.
- **Deferred list** — schedule/engine, table view, MC overlay, tax wiring, and
  super have all since landed. **Insights re-mount as accordions (Phase E)**
  and **entities**/**current-vs-proposed comparison** remain genuinely MISSING
  — still on the backlog (§3).
- **Drift:** `src/planState.js`'s own header comment says "schemaVersion 5"
  while the code below is at v11 — stale self-description.

### 02 — Phase A.1 (plan-level cashflows + FY anchoring)

**This is the spec that was never run.** Confirmed directly from git history:
there is no Phase A.1 commit. History goes `c734897 Phase A` (v1) straight to
`cfdec6a Phase A.2` (v3) — and the A.2 commit message says outright that "the
A.1 spec never reached this session — the v2 shape is reconstructed from A.2's
normative references... flagged for review." That review was never closed out.
Two genuinely missing features surfaced on this pass:

- **02.4 — MISSING.** Spec requires deleting an asset with attached cashflows
  to show a confirm dialog listing the affected rows and offering
  "Reassign to [asset]" or "Delete these cashflows too," never orphaning an
  `assetId`. The actual code (`removeAsset()` in `planState.js`, and the
  `main.js` click handler) unconditionally cascade-deletes every cashflow row
  referencing the removed asset via a generic `window.confirm("...will be
  deleted too.")`. No reassignment path exists anywhere in state logic, and no
  test exercises reassignment (only the cascade-delete is tested).
- **02.5 — MISSING.** Spec requires cashflow rows targeting an excluded
  (`include:false`) asset to be "visibly flagged." No such flagging exists —
  the asset `<select>` lists excluded assets identically to included ones, and
  the `.excluded` CSS class is only ever applied to asset cards, never to
  cashflow rows.
- **02.9 — SUPERSEDED / never built as specified.** The "reserve position, no
  visible placeholder" structural comment for Income/Expenses never existed —
  because A.1's own standalone UI cut never shipped; Income/Expenses arrived
  directly with A.2 instead.
- **02.10 — SUPERSEDED.** "Unchanged" summary-strip totals are gone entirely
  (removed in D1, see spec 01 above).
- **02.14/02.17/02.19 — PARTIAL.** The FY-to-FY derived-summary string
  ("FY2026–27 to FY2076–77 · age 40 to 90") was never literally built —
  `planSummaryText()` still renders plain calendar years ("2026–2076")
  alongside a separately-computed FY string elsewhere, so the two summary
  lines shown together are internally inconsistent about year format. There
  is also no single consolidated "Financial year conventions" Parameters
  section — the content is scattered across "Deterministic projection" and
  "Inflation assumption."
- **02.18 — PARTIAL.** Every *cashflow-row* date field shows its derived FY
  inline, but plan-level bare age inputs (`retirementAge`, fixed-age/years end
  basis) do not — only a separate summary line below shows the resolved value,
  not "alongside the input" as specified.
- **Acceptance criterion 8 — MISSING as literally stated.** The exact commit
  message `"Phase A.1: plan-level cashflows + financial year anchoring"` does
  not exist in git history; the work landed undifferentiated inside the A.2
  commit.
- Everything else (schemaVersion 2 shape, v1 migration, corrupt-blob fallback,
  contribution/withdrawal/one-off row CRUD, FY-label derivation, month/year
  editability) is DONE.
- **Drift:** every FY label in the app renders as `"FY 2036–37"` (space after
  "FY") where the spec (and CLAUDE.md) write `"FY2036–37"` (no space) — a
  trivial but totally consistent formatting mismatch across the whole app.

### 03 — Phase A.2 (household, income & expenses, surplus/deficit)

Commit `cfdec6a` matches verbatim. Mostly DONE; the interesting items are two
default-behaviour supersessions and one outright reversal of a "locked" decision:

- **Decision 3 / surplus default — SUPERSEDED.** Spec locks the default
  surplus mode to "spend." The Working Cash Account phase (`2115792`) added a
  third mode, "accumulate," and made *it* the default. "Spend" survives as a
  selectable option.
- **Decision 7 / franking — SUPERSEDED.** Franking is no longer a stored
  per-profile placeholder field; `profiles.js` derives it from class weights
  (`impliedFrankingPct`, commit `9bd1905`) after the stored field was found to
  disagree with the weights it was meant to be checked against. Custom
  allocations still store their own `frankingPct` unchanged.
- **Decision 7 (super) / "Age pension, super, entities — out of scope for
  this tool entirely (locked)" — SUPERSEDED for super specifically.** Tier 1.2
  built a full super accumulation model. This is an explicit reversal of a
  decision the spec called "locked," not a drift — worth flagging precisely
  because it was labelled locked. Age pension and entities remain out of scope.
- **Summary strip income/expense tiles — SUPERSEDED** (removed in D1, as above).
- Everything else — schemaVersion 3 shape, couple/single toggle, owner/
  distribution fields, income/expense row shapes, fundingOrder invariants,
  couple→single reassignment (this one *is* fully built, unlike spec 02's),
  all 8 acceptance criteria — DONE.
- **Drift:** the deficit-funding-order helper text still literally reads
  ("When the Working Cash Account needs topping up...") rather than the
  spec's original ("When expenses exceed income...") — an intentional
  rewording that tracks the WCA supersession, not an oversight.

### 04 — Phase B (deterministic engine)

One of the two oldest, most-built-upon specs (with 05). The formulas
(Fisher conversion, indexed-decay formula, purity of the two modules) are all
still exactly true. The **monthly loop itself has been substantially
re-architected**, not merely extended — this is the most significant finding
in this spec's audit and matches the brief's expectation of "silent drift":

- **Convention 9 (the monthly loop a–e) — PARTIAL, materially reordered.**
  The Working Cash Account (`2115792`) inserts an interest-bearing buffer
  between "household net" and asset funding: surplus is no longer disposed of
  every month (9d) — it banks in the WCA and sweeps only at FY-end; deficit
  funding no longer fires every month household net is negative (9e) — it
  fires only when the WCA balance drops below `minimumBalance`. This is
  deliberate and disclosed in `deterministic.js`'s own header comment ("the
  Working Cash Account fix"), and old regression tests were explicitly loosened
  to tolerate "a small WCA-interest residue" — but convention 9 as literally
  written no longer describes the running code.
- **A related, more precise drift:** convention 9d's fallback rule ("invest"
  target excluded/missing → falls back to spend) now falls back to
  **"accumulate"** (stays in the WCA), not "spend."
- **Convention 10 ("balances never go negative") — PARTIAL.** True for
  ordinary assets. The WCA, when genuinely unfunded, is now forced to exactly
  `minimumBalance` (which can be > 0) rather than 0 — a new, documented
  exception that didn't exist before the WCA.
- **The Ledger table (spec's View 2) — SUPERSEDED, split in two.** There is no
  single view named "Ledger" anywhere in the app. It split into a full
  post-tax "Cashflow" statement (firm CALM row vocabulary) and a separate
  "Assets" view. CSV exports are accordingly named `-cashflow.csv`/
  `-assets.csv`, not `-ledger.csv` as acceptance criterion 5 specifies.
- **Projection chart x-axis — PARTIAL.** Spec wants FY labels on the x-axis;
  the shipped chart uses client age, with FY relegated to hover text only.
- **Pre-tax banner — SUPERSEDED**, correctly (tax shipped; nothing to disclose).
- **Drift:** the Parameters modal's "Deterministic projection" prose is stale
  — it still describes the original no-tax, no-WCA, no-super, no-liabilities
  loop and doesn't mention any of the four major mechanisms layered in since.
- Modules 1 and 2 (`schedule.js`, `deterministic.js`) remain pure (verified by
  import grep) and every listed unit test still exists and passes.

### 05 — Phase B.1 (tax engine integration)

The other oldest, most-built-upon spec. Result is reassuring: **`costBasePool.js`
has not been touched since the original B.1 commit**, and `Tax/annual.js`'s
bracket-mode/CGT-stacking logic is untouched — only additively extended. So
decisions 7–11 (the pooled-cost-base CGT mechanics, both regimes, the 2027
reset) show **no drift at all** — CLAUDE.md's fuller current wording is
confirmed (via `git diff` against the original commit) to be a restatement of
the same mechanism, not a later replacement regime.

- **Decision 12 (income tax timing) — PARTIAL, real mechanism change.** The
  spec's single even-spread-within-FY-t accrual now only applies to a person
  with *no* employment income. A person with employment income instead has
  PAYG estimated on salary alone, withheld in salary months, with the
  true-up to full liability deferred to a single household outflow in **July
  of FY t+1** — the same t+1 convention the spec reserved for CGT only. This
  is deliberate, tested, and disclosed in the current Parameters modal — but
  decision 12 as literally written is no longer universally true.
- **Drift (small):** `deterministic.js`'s own module-header comment still
  describes only the original universal smooth-spread mechanism, unchanged
  since B.1, even though the code beneath it bifurcated with the PAYG
  commit — the file's own summary comment no longer matches its own code.
- Everything else — the shared `assessPerson` shape, franking gross-up/
  refund, both bracket modes, the two module extractions, all specified tests,
  both regression guards, both commit messages — DONE, unchanged since B.1.

### 06 — Phase C (output views: C1–C4)

- **C1 rail — SUPERSEDED.** Landed as specified, then rebuilt (`152e745`,
  `b321499`, `9d16ae5`) into a two-section Graphs/Tables sidebar with **Super
  and Liabilities now fully live** (not greyed placeholders) and Net assets
  live as both a chart and an Assets-view row. CLAUDE.md's line "Super/
  Liabilities/Net-assets pending" is stale (see §5).
- **C1 auto-hide-empty-rows — PARTIAL/evolved.** Originally unconditional;
  D5 replaced it with a user-facing "Hide empty rows" toggle (default on).
- **C1 report period selector — SUPERSEDED**, deliberately: the FY-range +
  All/Next10/Next20 presets were replaced (D5) by an age-based From/To plus
  Nth-year thinning and a "force key years" toggle, matching the corpus-review
  doc's explicit recommendation.
- **C1 Cashflow view row structure — SUPERSEDED, wholesale.** The spec's
  simple Income/Expenses/Tax/Net-cashflow grouping no longer exists anywhere;
  it was fully rebuilt into the firm's CALM-style Cash Flow SOA vocabulary
  (Assessable Income → Deductions → Tax → Cash Received → Expenses → Funding).
  A plain Total-income/Total-expenses/Surplus list *does* still exist, but
  only in the separate, later "Key figures" view the C spec never mentions.
- **C2 in-grid editing mechanics — PARTIAL, one recommendation not adopted.**
  The dot-marker mechanic from the original C2 commit is still exactly what
  ships. The corpus-review doc's recommendation to replace it with
  "Amount/Special/Total as separate rows" was never adopted — MISSING as a
  later-recommended improvement, not as a C2-spec violation (C2 itself only
  ever asked for the dot marker).
- **C3 (Setup + residency/Medicare wiring)** — fully DONE, including the exact
  Parameters-modal disclosure sentence verbatim.
- **C4 (Tax + Assumptions views)** — fully DONE and since extended (Div293/296
  rows, super-thresholds group) without contradicting the original structure.
- **Drift:** the bracket-mode value CLAUDE.md documents as `"none"` (frozen)
  is never actually used anywhere in code or tests — the real string is
  `"frozen"` throughout. A genuine naming mismatch between the locked-conventions
  doc and shipped code, not just a spec-vs-code gap.
- **Drift:** CLAUDE.md's "MC engine... awaits the Phase D rewire — don't
  touch" is stale; Monte Carlo has been fully rewired and shipped with its own
  UI for some time.

### 07 — Phases D1–D4 (identity/LE, asset classes, liabilities, property)

Comprehensively DONE across all four sub-phases — identity intake, ABS life
tables, the D1 indexation model, financial/lifestyle asset split, liability
amortisation/offset mechanics, and the full property/stamp-duty/purchase-event
pipeline all match their specs closely, with every listed regression gate and
test present. Two findings stand out:

- **A THIRD spec-less phase, independently confirmed.** D1–D4's own "Deferred"
  list explicitly defers a "D5 output restructure" (Graphs|Tables split,
  composite chart, age-first columns, hide-empty-rows toggle, unrealised-gain
  row, per-item display exclusions, balanced banner, scenario lock/metadata).
  **No `phase-D5*` spec file exists anywhere in `docs/specs/`** — confirmed by
  directory listing — yet `git log` shows a real commit,
  `b321499 "D5: graphs and tables split, composite chart, age-primary columns"`,
  that delivers almost the entire deferred D5 list: the Graphs/Tables split,
  the composite Cashflow-Assets-Liabilities chart, the hide-empty-rows toggle
  wired end-to-end, and per-item display-exclusion toggles
  (`pprProperty`/`otherProperty`/`lifestyle`/`liabilities`). Only "scenario
  lock/metadata" and a "balanced banner" appear genuinely never built. **This
  is the same failure pattern as Phase A.1 and Session B** — substantial,
  scoped work shipped under a phase label with no spec document ever created,
  in direct tension with CLAUDE.md's own rule to stop rather than reconstruct
  a missing spec. It's a partial delivery, which makes it a harder gap to spot
  than a clean miss — worth treating as a peer finding to the two the user
  already knew about, not a footnote.
- **Negative-gearing rule has a third, undocumented condition.** Both this
  spec and CLAUDE.md's own "Tax" section state the quarantining exception as
  strictly binary (pre-1 July 2027, OR new build). The actual code (added
  inside the same D4 commit) adds a third escape — acquisition before Budget
  night, 12 May 2026 ("grandfathered") — reflecting the real enacted law more
  accurately than either document currently states. Both the spec and
  CLAUDE.md are stale on this point (see also §4).
- **Drift:** CLAUDE.md's Outputs line ("Super/Liabilities/Net-assets pending")
  is stale here too (same finding as spec 06).
- **Drift (disclosed, not a gap):** the stamp-duty data module self-flags 7 of
  8 states' schedules as "UNVERIFIED this session... built from training
  knowledge," exactly per CLAUDE.md's testing convention — a live risk, not a
  compliance failure.

### 08 — Tier 1.1 (key dates)

Very clean. Both commits (`f2fb60d`, `53a312d`) match their required commit
messages exactly, and the load-bearing migration regression gate (bit-identical
projection across income/expenses/contributions/withdrawals/one-off/liability/
property) is present and passing. All findings are cosmetic:

- The `display` string format (e.g. `Retirement — age 65 (FY2051–52)`) is
  inconsistent even *within the spec itself* (two different example formats at
  two points in the spec text); the shipped code uses a third form
  (`Retirement — Jo Smith — age 65 (FY2051–52)`, double em-dash, no comma) —
  same information, none of the three literal formats match each other.
- The delete-a-referenced-key-date confirmation is a native `window.confirm()`
  with the "convert to age N" phrasing in the message body, not a
  purpose-built dialog with that phrase as a button label — functionally
  identical, presentationally simpler.
- Two of the spec's named unit-test cases ("forced-year inclusion," "column
  annotation selects right years") are exercised only indirectly — the
  underlying generic thinning mechanism is tested, but the specific `main.js`
  composition functions that call it have no dedicated test (consistent with
  the project convention that DOM-touching code in `main.js` isn't
  unit-tested — there is no `main.test.js` anywhere in the repo).

### 09 — Tier 1.2 (superannuation, accumulation phase)

All four commits (`bc46c25`, `f00e165`, `de8ba8e`, `9d16ae5`) match their
required messages. The headline item:

- **"Division 293... paid from household cashflow... do not model the
  release-from-fund election" — SUPERSEDED.** Commit `cdeb76e`
  ("Division 293 and 296: release from super by default") adds a per-person
  `divTaxPaidFrom` setting (default `"super"`) plus an account-selection
  fallback, and explicitly bypasses the preservation/condition-of-release gate
  for the release (a release authority is not a benefit payment). Applies to
  **both** Division 293 and 296. Rationale, per the commit: release-from-fund
  is the realistic default and the common election. Regression-tested against
  the personal-cash election reproducing prior behaviour bit-identically.
- **Indexation mechanism — SUPERSEDED.** The spec's original "held constant
  in real terms by default" description was replaced wholesale (spec 10,
  Session A, Commit 1) by the per-figure nominal-compound-then-round-then-
  deflate mechanism now in `superRates.js` — correctly reflected in spec 10's
  own audit, but spec 09's text is stale on this point.
- **Income-row `incomeType` field — PARTIAL/evolved.** No longer a direct
  user-facing select; superseded by a later `category` select from which
  `incomeType` is now derived. Downstream tax/SG semantics unchanged; the
  concrete field spec 09 describes no longer exists as such.
- Everything else — accounts, SG derivation, concessional/non-concessional
  caps and carry-forward/bring-forward, contributions tax, Division 293's
  base formula, preservation/proportioning/withdrawal gating, all UI
  (account cards, cap-headroom live display, Super table view, Tax view rows,
  Parameters modal disclosures) — DONE.
- **Drift, separate from the audit's main purpose but worth surfacing:**
  `docs/reference/build-log.md` still lists "Super contributions create
  money" as **BLOCKING — not landed** and Division 296/indexation as **"in
  flight"** — both were fixed and landed long ago (`e1eb61a`, `2867768`,
  `dfb51db`, `5ce30c1`, `d73a731`, `cdeb76e`), and the test count is 531, not
  the "~406" the log states. This is a direct violation of CLAUDE.md's own
  workflow rule to keep build-log.md current — see §5.

### 10 — Session A (indexation + Division 296) and Session B (Monte Carlo)

**Session A** (Commits 1–2) is in excellent shape: every figure's indexation
basis and rounding increment, the Division 296 formula, both regression gates,
and both commit messages match the spec exactly, character for character.

**Session B is the one that matters most, and it has real, previously
undetected divergences — including two concrete bugs currently shipping.**
This audit read the actual Monte Carlo source line by line against the real
spec text for the first time since it was built from a paraphrase.

**Critical divergences:**

1. **The correlation formula is not the one the spec specifies, and it changes
   what ρ means.** Spec: `r = μ + σ×(ρ·z + √(1−ρ²)·ε)` — under this formula,
   two holdings sharing one factor have pairwise correlation **ρ²**. Shipped
   code (`monteCarlo.js`): `loading = √ρ`, `idio = √(1−ρ)` — a different,
   equally-plausible parameterisation (the Vasicek/asset-correlation
   convention) under which pairwise correlation is **ρ directly**. At the
   default ρ = 0.85 that's a realised pairwise correlation of **0.85 in the
   shipped code vs. 0.7225 under the spec's literal formula** — a real,
   non-cosmetic difference in what the model actually does. No test catches
   this: the ρ=0/ρ=1 boundary tests collapse identically under either
   formula, and the ρ=0.85 test only asserts the realised correlation falls
   in the wide band (0.5, 0.98). Nobody would find this without doing the
   arithmetic by hand.
2. **The Monte Carlo fan chart's "Export PNG" button is a dead no-op.** The
   click handler enumerates every graph view by name for export — and
   `"monte-carlo"` is missing from that list. The button renders correctly,
   is labelled "Export PNG," and is clickable while viewing the fan chart —
   and does nothing at all when clicked. This directly contradicts the spec's
   "PNG export... as with every other chart," and it's the kind of thing a
   user would hit on the very first real use of the feature.
3. **The Real/Nominal toggle destroys a completed Monte Carlo run.** The spec
   asks for results to be "cached against a hash of the scenario state,"
   invalidating automatically "when any input changes" — but no hash of any
   kind exists anywhere in the codebase. Instead, the app's generic
   `refreshOutputs()` unconditionally nulls the cached result and is called
   from ~28 mutation sites, including the **display-only** Real/Nominal
   toggle. There is nothing to compare against, so toggling units after a run
   silently throws the whole simulation away, forcing a multi-second re-run
   just to see it in different units — the exact "stale chart is worse than
   no chart" problem the spec was written to prevent, inverted into "a valid
   chart is destroyed by an unrelated display toggle."
4. **The deterministic projection is never overlaid on the fan chart, despite
   the app's own Parameters modal claiming it is.** The spec requires "the
   deterministic projection overlaid as a line." The chart's trace list
   contains only the five percentile-band traces — no deterministic line
   anywhere. Meanwhile `index.html`'s Parameters modal explicitly says "the
   deterministic line will visibly sit above the Monte Carlo median when both
   are on screen" and points the reader at the volatility-drag disclosure —
   describing a feature that does not exist in the shipped chart. Nor is
   there a link (as the spec separately asks for) to that disclosure from the
   Monte Carlo view — `openModal()` supports scroll-to-section but is never
   called with one from this view.

**Other real divergences, less severe:**

5. Asset returns are drawn **per month**, not "per plan year" as the spec
   states — a deliberate choice to preserve `sim.js`'s original monthly
   regime-switching character, but a literal mismatch with the spec's own
   "what varies per path" framing (CPI genuinely is drawn per year, so the two
   "per plan year" items in the spec end up resolving at different cadences
   in the code without that being visible anywhere).
6. Regime-switching is tracked **per holding**, each with its own correlated
   (not shared) Markov chain — at ρ < 1, two different assets can and will be
   in different regimes in the same month. The spec's "all assets
   experiencing them together" is not what's built; correlated-but-independent
   regime transitions are.
7. Correlation is modelled at the **holding** level, not the **profile**
   level the spec's own notation (`r_profile,t`) implies — two assets sharing
   a profile do not move identically; each gets independent idiosyncratic noise.
8. ρ, CPI σ, CPI floor, and path count (500–10,000 per the spec) are all
   configurable at the engine/test API layer but **none are exposed in the
   UI** — the shipped Run buttons are static "Run Monte Carlo (2,000 paths)"
   text with no controls, and the real invocation always passes `options: {}`.
9. "Per-path output kept small... do not retain full ledgers" is respected in
   spirit but not to the letter: 20 full per-path ledgers (`samplePaths`) are
   computed and shipped across the worker boundary on **every real run**, for
   a feature the shipped UI never displays (`grep` confirms `samplePaths`
   never appears in render code) — quiet overhead, not a ceiling violation.
10. "Unfunded totals" (the dollar magnitude) are never retained per path —
    only a boolean ruin flag and, for ruined paths, the shortfall age. The
    deterministic engine's own `shortfall.total` field is available and simply
    not captured.
11. The custom-allocation flag's wording doesn't match the spec's verbatim
    text (semicolon + lowercase "their" + appended asset list, vs. the spec's
    two-sentence, capitalised form) — functionally present, textually different.
12. None of Session B's five commit messages match the spec's three specified
    strings — the work shipped as 5 commits (`3d2169b`, `9ef4938`, `297b1ed`,
    `5a67a89`, `09e674e`) against 3 specified ones, and not one message string
    matches character-for-character. (Session A's two messages match exactly
    — a sharp contrast that itself is evidence Session B never had the real
    text in front of it.)

**Things checked and confirmed correct, worth stating plainly since the
brief asked to look hard even at things that "look harmless":** seeded
reproducibility is real and tested (though never used by the shipped UI — no
seed is ever passed from `main.js`); the worker/progress/cancel mechanism is a
genuine Web Worker, not main-thread; the headline statistics (ruin probability
as "the single definition, used everywhere," median/10th/90th end net assets,
conditional median shortfall age) all match exactly; the Simulation table
(percentiles as rows, years as columns) is not actually a special transposition
as initially suspected — it uses the identical `{title, rows:[{label, cell(y)}]}`
shape every other table in the app uses; its CSV export is correctly wired
(unlike the Graphs view's PNG export).

**Also found:** `src/Tax/div296.js`'s own header comment still asserts "not
modelled: the release-from-fund election" — directly contradicted by
`deterministic.js` in the same codebase, which makes it the default. And
`index.html` describes "30 grey paths drawn over the Monte Carlo bands" as an
existing overlay feature — no such overlay traces exist in the chart, and even
the stated count doesn't match the actual sample size (20).

---

## 2. The three flagged areas, summarised

- **Session B (Monte Carlo), spec 10:** covered in full above. Bottom line —
  the shape of the feature (path generation, correlated shocks, regime
  switching, fan chart, percentile table) is broadly right, matching what a
  paraphrase would produce, but the specific numbers are wrong in a way that
  matters (the ρ parameterisation), two features are silently broken in the
  shipped UI (PNG export, the units-toggle cache wipe), and one is
  documented as existing when it doesn't (the deterministic overlay line).
  None of these were caught by the test suite, and none would be obvious from
  using the app casually — this is exactly the "including ones that look
  harmless" case the brief warned about.
- **Spec 02 (Phase A.1):** two genuinely missing features found independently
  of any prior knowledge of "the known two" — the asset-deletion
  reassignment dialog, and excluded-asset row flagging. Both are entirely
  absent, not just implemented differently. Confirmed structurally why: no
  Phase A.1 commit exists at all; the work was absorbed into A.2 without ever
  reading this spec's actual text.
- **Specs 04/05 (engine, tax):** the tax engine (05) has held up remarkably
  well — the CGT/pooled-cost-base mechanics are byte-identical to the
  original commit, and the only real drift (income-tax timing bifurcating on
  employment income, per the later PAYG feature) is deliberate and disclosed.
  The deterministic engine (04) has drifted more, and more consequentially:
  the entire monthly surplus/deficit loop was re-architected around the
  Working Cash Account, which is a real, disclosed, tested change — but
  convention 9 as literally written in the spec is simply no longer an
  accurate description of the code, and the Parameters modal's own
  description of the loop was never updated to match.

---

## 3. Deferred items still deferred (accumulated backlog)

Consolidated from every spec's "Deferred — do not build" section, status
checked against current code. Items already covered elsewhere above (D5,
super's reversal, etc.) aren't repeated.

**Still genuinely deferred / not built, appearing across multiple specs:**
- **Insights re-mounted as collapsed accordions** (specs 01, 02, 03, 04, 06).
  `LEGACY_INSIGHTS_ENABLED = false` remains; the four legacy modules
  (`firstDecade.js`, `drawdownTolerance.js`, `tornado.js`, `sequenceRisk.js`)
  sit unrendered, unchanged, consistent with spec 10's own note that this
  needs the per-path output shape settled first (it now is).
- **Entities** (trusts/companies/SMSF) — deferred in specs 01, 03, 09;
  confirmed parked in build-log.md.
- **Age pension / Centrelink** — deferred in spec 03; confirmed under
  "Later" in build-log.md, not started.
- **Current-vs-proposed scenario comparison** — deferred in spec 01; not
  built; listed as backlog item 14 in build-log.md.
- **Tax-breakdown output view** (separate from the Tax table view) —
  deferred in spec 05; not built.
- **SAPTO, HELP repayment, Medicare Levy Surcharge, family Medicare
  thresholds** — deferred/disclosed-not-modelled across specs 03, 05, 06;
  confirmed still absent from the engine (though HELP/MLS/SAPTO **rows now
  render** in the Cashflow view per spec 06's audit — worth checking whether
  they compute non-zero values or are permanently-zero placeholders, since
  either answer changes whether this is "still deferred" or "quietly started").
- **Non-resident CGT differentiation** — deferred in spec 06; confirmed still
  not modelled (disclosed in Parameters modal).
- **Property sales / main-residence 6-year-rule mechanics, extra/early loan
  repayments, redraw, variable rates** — deferred in spec 07; confirmed absent.
- **Pension phase and TTR, FHSSS, SMSF, contribution splitting, downsizer,
  co-contribution/LISTO, insurance premiums in super, death benefits** —
  deferred in spec 09; confirmed absent, all correctly disclosed in the
  Parameters modal.
- **Anchor-driven report-period controls, market-crash/interest-rate periods
  as key dates, inline key-date creation, FY-based key-date storage** —
  deferred in spec 08; confirmed absent.
- **Scenario templates and locking, Word/PDF export, adjustment rows on tax/
  cashflow tables** — recommended in the Xtools/CALM corpus review, never
  speced as a phase, not built.
- **Drawdown/goal-seek solver** — flagged in build-log.md as the clearest
  unclaimed capability advantage; not built.
- **HECS-HELP, extra/lump-sum loan repayments, FHSSS** — build-log.md's
  original "Tier 1" ordering; still not built; the workbook sense-check
  reference doc argues for reprioritising these ahead of Monte Carlo, which
  shipped first anyway.

**Deferred items that have since landed (deferral correctly lifted):**
schedule builder & deterministic engine, table views & in-grid editing, tax
wiring (income tax/franking/CGT), Monte Carlo rewire, liabilities, super,
Division 296, Division 293, super threshold indexation, D5's output
restructure (see §1's spec-07 finding on the missing D5 spec document itself).

---

## 4. Undocumented behaviour

Engine mechanisms that exist in the code but appear in no spec and no part of
CLAUDE.md. The three named in the brief, confirmed:

- **Working Cash Account.** Mentioned once, in passing, in spec 10's Session B
  intro ("...property, tax, working cash and deficit funding") — never
  described as a mechanism anywhere. CLAUDE.md's "Monthly loop order" section
  describes surplus/deficit as settled monthly with no buffering, which is no
  longer true (see §1, spec 04). The original Phase B spec's convention 9
  explicitly specified *immediate* monthly surplus handling — the WCA is a
  later, undocumented replacement of that spec'd behaviour.
- **PAYG withholding / tax refund timing.** Not mentioned in spec 05 at all
  (predates it). CLAUDE.md's tax paragraph only states the simpler,
  universal-smooth-spread version — not the actual bifurcated mechanism.
- **The conservation invariant.** "Conservation" and "invariant" appear
  nowhere in any spec or in CLAUDE.md; `conservationCheck.js` is documented
  only in its own header comment.

**Further undocumented behaviour found beyond those three, most significant first:**

- **Negative-gearing's third "grandfathered" condition** (acquisition before
  12 May 2026 Budget night) — a real, materially significant modelling
  decision, present since the original D4 commit, that neither spec 07 nor
  CLAUDE.md's Tax section mentions (both still state the rule as strictly
  binary). Already flagged in §1; repeated here because it's the kind of
  decision that should get written up somewhere permanent.
- **Division 293/296 release-from-super default and its account-selection
  fallback** (largest-balance auto-selection; falls back to cash with a
  pushed warning if the owner has no super account). A real, non-trivial
  default policy choice, absent from every spec that touches Division 293/296.
- **Monte Carlo's correlation model diverging from its own spec** (the
  √ρ/√(1−ρ) parameterisation, and monthly rather than annual shock
  resolution) — already covered in full in §1/§2; the underlying commit's own
  header comment explains the deviation, but no spec or CLAUDE.md text was
  ever updated to match.
- **Monte Carlo's seed was previously a silent no-op** (fixed in `9ef4938`) —
  historical only, but worth knowing the class of bug existed: a documented,
  tested-looking option that was actually never wired up. Worth a sweep for
  other "documented but unwired" options elsewhere in the codebase.
- **The "Owned" property + future acquisition date warning and one-click
  "Switch to planned purchase" button** — a UX safety net added in response
  to a specific reported bug, not mentioned in spec 07. The underlying
  decision (acquisitionDate on an owned property is cosmetic/CGT-only and
  does NOT gate rent/value) is a real, non-obvious modelling choice that a
  spec reader would not expect.
- **Franking's move from a stored per-profile field to a derived value**
  (`impliedFrankingPct`) — an internal architecture change no spec reflects;
  every spec that mentions franking (03, 05) still describes it as stored.
- Two minor UI-only implementation details, flagged for completeness rather
  than as design decisions needing write-up: the deferred date-commit
  handling that works around a Chromium `<input type="date">` quirk, and the
  1200ms "clamped" field-flash animation.

---

## 5. Stale documentation

The Cashflow-income-row example from the brief has already been fixed — the
original A.2 spec's helper text ("Enter gross (before tax). Tax is calculated
from Phase B.1.") no longer exists; current text reads "Enter income before
tax." with no forward-looking phase reference. Checked and closed.

**Stale text still present:**

- **`src/main.js`, the per-asset CGT card's cost-base helper text**: *"Used
  for capital gains tax modelling in a future version."* CGT has been fully
  implemented since Phase B.1 — pooled cost bases, auto-selected
  discount/indexed treatment by date, and a full Parameters-modal
  description all exist and consume exactly this field today. This is the
  same pattern as the already-fixed A.2 example, just never caught for this
  second occurrence. Suggested replacement: something like "Cost base used to
  calculate capital gains tax on this asset's withdrawals and sales."
- **`src/Tax/div296.js`'s header comment**: "not modelled: the release-from-
  fund election" — false since `cdeb76e`, which makes exactly that the
  default (see §1, spec 09/10).
- **`index.html`'s Monte Carlo section**: claims a 30-grey-path overlay exists
  on the fan chart ("sampled from the full simulation") and that the
  deterministic line is drawn on it — neither exists in the shipped chart,
  and even the stated sample count (30) doesn't match the code's actual
  default (20). This reads as documentation written for a planned feature
  that was never finished, not documentation that decayed after the fact —
  worth distinguishing from ordinary staleness when it gets fixed.
- **`CLAUDE.md`'s Outputs line**: "View rail (Projection, Cashflow, Assets,
  Tax, Assumptions; Super/Liabilities/Net-assets pending)" — all three are
  live views today, confirmed independently by both the spec-06 and spec-07
  audits.
- **`CLAUDE.md`'s architecture-map line**: "MC engine (`sim.js`,
  regime-switching) awaits the Phase D rewire — don't touch" — the rewire
  happened; `monteCarlo.js` is a fully separate, already-shipped engine with
  its own UI. `sim.js` is now reachable only through the dead legacy-insights
  path. A future session reading CLAUDE.md alone could easily conclude Monte
  Carlo is unbuilt.
- **`CLAUDE.md`'s "bracket modes" naming**: documents the frozen-brackets
  value as `"none"`; the code and every test use `"frozen"` — a real naming
  mismatch, not just a description gap.
- **`docs/reference/build-log.md`** (which CLAUDE.md's own workflow rules say
  to keep current) is itself stale in a way that matters: it lists "Super
  contributions create money" as **BLOCKING — not landed**, and Division 296/
  indexation as **"in flight,"** and states "~406 tests" — all of these
  landed commits ago, and the suite is now at 531 tests. This is a direct
  breach of CLAUDE.md's own maintenance rule, not just an inert doc — anyone
  reading the build log to plan next work would be misled into thinking a
  since-fixed money-creation bug is still blocking.
- **Spec 07's and CLAUDE.md's negative-gearing rule** — both still state the
  binary (pre-2027 OR new-build) rule; the code has a third condition
  (grandfathered pre-Budget-night acquisitions). Whichever is "more correct"
  (the code is, per the enacted law), the documents are stale relative to it.

**Checked and confirmed NOT stale** (patterns the brief specifically asked to
verify): the surplus spend/invest/accumulate model's description matches
current code exactly; the CGT-method description correctly states automatic
date-based selection (no "whichever the user picks" language was ever found);
Centrelink's "coming soon" framing is still accurate (genuinely not built);
the Division 293/296 "paid from" wording is correctly updated everywhere it
appears in `index.html`/`main.js` except the one `div296.js` comment noted
above; dead CSS/comments from Phase A's removals (`.horizon-slider` rules in
`styles.css`, "compare mode" language inside the legacy `sim.js`/`tornado.js`
files) are inert — never rendered while `LEGACY_INSIGHTS_ENABLED` is false —
low-priority cleanup rather than user-facing staleness.

---

## Appendix — phases that shipped without ever having a written spec

Three, not two, now confirmed:

1. **Phase A.1** (spec 02) — the spec existed on disk but never reached the
   implementing session; the actual work was inferred from Phase A.2's
   cross-references and absorbed into the A.2 commit.
2. **Session B / Monte Carlo** (spec 10) — the spec existed on disk but the
   implementing session worked from a one-line paraphrase instead; this audit
   is the first time the real text has been checked against what shipped.
3. **D5** (output restructure) — **no spec file for D5 exists anywhere in
   `docs/specs/`, and none was retroactively provided the way A.1's and
   Session B's eventually were.** The D1–D4 spec's own deferred list names D5
   precisely, and a real commit (`b321499`) delivers most of it. Unlike the
   other two, D5 was never a "the text existed but wasn't read" situation —
   there is simply no record of what was asked for. If a full accounting of
   what D5 was supposed to include (vs. what actually got built — scenario
   lock/metadata and a "balanced banner" appear to be the two genuinely
   missing pieces) matters, that has to be reconstructed from memory or
   commit context now, since no source document exists to check against.
