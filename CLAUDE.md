# CLAUDE.md — MonteCarlo (Xtools+ replacement)

Client cashflow & portfolio projection tool for an Australian advice firm
(Xplan Xtools+/CALM replacement). Vite + vanilla JS + Plotly + Vitest.
Branch: `claude/monte-carlo-investment-app-R9XSB`. Specs arrive from a
separate planning session; this file holds the permanent conventions so
specs only describe new work. **If a spec conflicts with this file, the
spec wins and says so explicitly.**

## Workflow rules
- One commit per phase minimum; full suite + build green before the next
  phase; regression gates are bit-identical unless the spec says otherwise.
- If a gate fails and the fix isn't obvious: stop and report.
- Run tests quietly (`npx vitest run --reporter=dot` or pipe to a summary);
  never paste full test output.
- No Playwright/e2e authoring unless the spec explicitly asks.
- Final reports: terse bullet-per-phase — what landed, gates, flags. No
  narration of the coding process.
- Never modify: locked conventions below, `dutyOverride`/as-at patterns,
  the non-prescriptive output voice (no advice language, no winner-labels).
- Specs live in `docs/specs/`, reference material in `docs/reference/`.
- If a task references a spec, READ IT FROM DISK before starting. Never
  work from a summary or paraphrase of a spec — if context has been
  compacted and only a summary remains, re-read the file.
- If a task references a spec you cannot find on disk, stop and say so
  rather than reconstructing it.
- Keep `docs/reference/build-log.md` current: move completed items to
  DONE with their commit hashes as they land.
- When a bug is found, the fix must close the whole class, not just the
  reported instance — check for sibling cases before calling it done.
  The property acquisition-date bug and the super-contribution
  money-creation bug each needed two rounds because the first fix
  addressed only the one case that was reported.

## Architecture map
- `src/planState.js` — schema (v5+), migrations, factories. localStorage via
  workspace index (`src/workspace.js`: Client → Scenarios, JSON export/import).
- `src/schedule.js` — pure cashflow schedules (per-month, per-asset flows +
  household income/expenses).
- `src/deterministic.js` — monthly engine + yearly ledger + perAssetDetail.
- `src/Tax/annual.js` — per-person FY assessment; `src/Tax/engine.js` —
  vendored primitives (LEG, marginalTax, medicareLevy, both CGT regimes).
- `src/costBasePool.js` — pooled cost bases, 1 Jul 2027 reset.
- `src/data/lifeTables.js` (ABS 2020–22), `src/data/stampDuty.js` (8
  jurisdictions, as-at stamped, dutyOverride escape hatch).
- `src/main.js` — UI: fact-find input column, output view rail, hash-routed
  pages (#/clients/...). `src/chart.js` — Plotly (guarded: CDN may be blocked).
- Legacy insight modules behind `LEGACY_INSIGHTS_ENABLED = false`; MC engine
  (`sim.js`, regime-switching) awaits the Phase D rewire — don't touch.

## Locked conventions
**Time.** Australian FYs (Jul–Jun), labelled "FY2026–27". Monthly steps.
Partial first year from start month to 30 June. Ages tick each 1 July (DOB
stored; precision used for LE lookup only). Income-row ages anchor to the
OWNER; everything else to the client. Projection end = resolved endAge
(client-anchored) from the LE-basis control (longest LE for couples).

**Cashflows.** Monthly rows run every month in [fromAge, toAge] inclusive of
boundary years. Annual rows and one-offs fire in July; skipped in the partial
first year if start month > July. Indexation: g = basis (None|CPI|AWOTE) +
additional %; real amount at month m = amount × ((1+g)/(1+cpi))^(m/12).

**Returns.** Real terms everywhere in the engine; nominal is display-time
scaling ×(1+cpi)^(m/12). Net nominal = gross − ICR; real via Fisher; monthly
geometric. Firm CMA profiles in `profiles.js` are the single assumption set.

**Monthly loop order.** Grow assets → asset-targeted flows (excess is
unfunded; NO cross-asset cascade for explicit withdrawals) → household net
(income − expenses ± property rent/expenses − loan repayments) → surplus per
settings (spend|invest) → deficit via fundingOrder (drain in order; remainder
unfunded). Balances floor at 0. Excluded assets are invisible everywhere.
Liabilities: nominal amortisation deflated at ledger; offset portion earns
zero nominal; loan interest deductible per flag to owner (joint 50/50).

**Tax.** Per person per FY via `annual.js`: brackets + Medicare (shading,
single thresholds) + LITO + refundable franking; non-residents: own brackets,
no Medicare/LITO. Bracket modes: "indexed" = constant real (default) |
"none" = nominal frozen (real thresholds shrink). Income tax accrues
PAYG-style across the FY's income months; CGT paid July of FY t+1; final-FY
CGT surfaces as accrued liability. Pooled cost bases; deemed reacquisition
resets pools to market value at 1 Jul 2027 (no CGT event); pre-reform sales:
50% discount (same-FY contributions pro-rata undiscounted); post-reform:
constant-real pool, tax = max(marginal, 30% × gain); losses per person,
gains-only offset. Rental losses: offset other income if pre-1 Jul 2027 OR
new build; else quarantined per owner (future rental profit, then gains).
PPR CGT-exempt. Not modelled (disclosed): SAPTO, HELP, MLS, Div 293, family
Medicare thresholds, non-resident CGT differentiation, property sales.

**Purchases (planned property).** July of purchase FY: price grown at
growthPct → duty from state schedule (or dutyOverride) with FHB/FHOG rules →
loan = LVR × price (D3 liability, linked) → settlement cash through the
normal fundingOrder (shortfall = unfunded, purchase still completes) → pool
seeds price + duty + costs. Duty computed in nominal dollars of purchase
year, deflated for the ledger; brackets held at as-at values.

**Outputs.** View rail (Projection, Cashflow, Assets, Tax, Assumptions;
Super/Liabilities/Net-assets pending). Transposed tables: years as columns,
sticky labels, all-zero rows hidden, negatives in parentheses, per-view CSV
of visible cells; period selector per scenario. In-grid one-off cells edit
plan state (`source:"table"`); first-FY cells blocked when annual-skip
applies. Real names from Setup flow through all labels.

## Input integrity
Impossible states must be UNENTERABLE, not warned about: bound the control
(min/max, a disabled option, dependent visibility) where a bound can express
the constraint, or reject the commit outright with an inline message naming
the conflict when it can't (cross-field constraints — an age before another
anchor, a period longer than its own term). Improbable-but-legal states may
be warned about instead (a validation warning is for judgement calls the
user is entitled to make deliberately). Nothing that would produce a wrong
projection may be silently accepted — clamping a value with no visible cue
is not a fix, it's the same bug with the evidence hidden. The property
acquisition-date bug (a legal-looking "Owned" property with a future date
silently produced rent from year one) is the canonical example: the fix
that matters is making the state unenterable, not warning about it after
the fact.

## Testing conventions
Pure modules never import DOM/Plotly. Known-value tests carry the hand
calculation (or external source figure) in a comment. Regression gates:
scenarios not using a new feature stay bit-identical. Embedded external data
(life tables, duty) gets source-figure spot checks + an as-at date; encoding
tests verify the encoding, not the source — flag unverified data in comments.
