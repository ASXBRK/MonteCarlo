# Surplus Cascade — Condition-Based Waterfall

Conventions per CLAUDE.md. **Four commits, gated, engine first.**

## Why

Surplus treatment is period-based today: to express "pay down the mortgage,
then invest", the adviser works out which year the mortgage is repaid and
hands that year back as a manually-chosen period boundary. The engine
already knows that year — the boundary should be derived, not entered.

## The model

An ordered cascade, re-evaluated at every FY-end sweep. Each STEP has one or
more BRANCHES (a split); each branch has a destination and its own list of
until-conditions (implicit AND). Surplus fills the first step's open
branches; whatever an open branch can't absorb (capacity-capped or the
branch never opened) stays in the pool and reaches the next step. A step
with no open branches is skipped entirely — its whole share flows on.

```
1. Debt      → non-deductible loans, until repaid
2. Asset     → Shares, until value reaches $500,000
3. Debt      → deductible loans, until repaid
4. Super     → CC to cap, then NCC
(implicit)   → cash, unconditional — appended automatically if the
               adviser's own cascade doesn't end in one
```

## Data model

**Condition** — `{ kind, amount?, ref?, direction? }`.
- `repaid` — debt branches only; open while the branch's own scoped loans'
  summed balance > 0.
- `balanceBelow` — open while the branch's own destination balance ≥ amount
  (partial paydown, not full repayment).
- `valueReaches` — open while the branch's own destination balance < amount.
- `date` — open while now < `ref` (`direction: "before"`, the default and
  the only one ever authored). `direction: "atOrAfter"` is internal-only,
  used solely by migration (below) — never exposed to the adviser.

No `targetType`/`targetId` on the condition itself — a non-debt condition
reads the SAME target its own branch's destination already points at.
There is no fifth condition kind; `atOrAfter` is `date` wearing a different
comparator, not a new primitive.

**Destination** (on a branch) — one of:
- `debt` — `{ deductibility: "nonDeductible" | "deductible" | "any", loanIds: [...] | null, order: "interestRate" | "manual" }`. `loanIds` non-null is an explicit selection (deductibility ignored); null uses every loan matching `deductibility`. Generalises today's `payNonDeductibleDebtFirst` (`deductibility: "nonDeductible"`, `loanIds: null`) and the new "deductible debt" step.
- `asset` — `{ targetId }`.
- `superConcessional` — `{ targetId }` (a salary-sacrifice/personal-deductible contribution row — same v1 scope as today).
- `superNonConcessional` — `{ targetId, allowBringForward }` (Commit 2).
- `goal` — `{ targetId }`.
- `cash` / `expenditure` — no target. Replace today's bolted-on `remainderTo` — they are ordinary destinations now, not a special third step. If the adviser's own cascade doesn't end in an unconditional `cash` or `expenditure` branch, the engine appends an implicit unconditional `cash` step so surplus never has nowhere to go.

**Branch** — `{ id, destination, pct, conditions: [] }`.
**Step** — `{ id, branches: [branch, ...] }`.
**Cascade** — `state.settings.surplus.periods` (field name unchanged — see
"Migration" — each array element is now a step, not a time period).

## Sweep algorithm (generalises today's Step 1/2/3)

```
remaining = wcaBal - minimumBalance
for step of cascade:
  if remaining <= 0: break
  pool = remaining                      // fixed for this step, same as today's poolForPct
  for branch of step.branches:
    if remaining <= 0: break
    if !isOpen(branch, liveState): continue   // closed — its pct share is simply never subtracted; cascades on
    share = min(remaining, pool * branch.pct / 100)
    consumed = applyDestination(branch.destination, share, liveState)  // type-specific capacity cap, unchanged per-type logic
    remaining -= consumed
if remaining > 0: implicit cash fallback   // should not fire if the cascade ends in an unconditional branch
```

`isOpen` is a pure function of CURRENT state, called fresh every sweep —
nothing is cached, nothing is permanently retired. A branch that closes and
later re-opens (shares hit $500k, the market falls, surplus resumes) is
handled by this alone; there is no flag to reset.

**Splits — closed branch's share cascades to the *next step*, never
redistributed to siblings.** Redistributing would silently change a stated
percentage the adviser didn't ask to change; cascading onward is consistent
with how fall-through already works everywhere else in this engine (a
capacity-capped entry already falls through to later entries today), and
lets the adviser add a later step for "more to the other branch" if that's
genuinely what they want.

## Migration — periods become unconditional (usually) steps

The wire field stays `state.settings.surplus.periods`; only the SHAPE of
each element changes. Backward tolerance, checked in this order:

1. An element already shaped like a step (has `branches`) — used as-is.
2. An element shaped like an old period (`from`/`to`/`payNonDeductibleDebtFirst`/`allocations`/`remainderTo`) — converted via `migratePeriodToStep`.
3. The pre-v17 `{mode, assetId}` shorthand — converted via `legacySurplusPeriod`, itself now emitting the new step shape.

**The single-period case (the overwhelming majority of real and test
state) needs no time-window condition at all.** Today's `resolveSurplusPeriod`
falls back to the LAST period for any year outside its own `[fromYear,
toYear]` — so a single period already behaves as if unconditional for the
whole projection regardless of its own stated bounds. `migratePeriodToStep`
exploits this: a period array of length 1 always migrates to an
UNCONDITIONAL step (or up to three: debt-first, allocations, remainder —
see below), no `date` condition attached, because none is needed for
bit-identical behaviour.

**A genuine multi-period array** (real adviser data, contiguous
mutually-exclusive time windows) needs each migrated period's own step
wrapped so it only fires in its own window: `conditions: [{kind:"date",
ref: prevBoundary, direction:"atOrAfter"}, {kind:"date", ref: ownBoundary,
direction:"before"}]` (the first period omits the `atOrAfter` clause, the
last omits the `before` clause — exactly mirroring "period 0's from is
static Start" / "the last period's to is static End" in the old UI).

**Each migrated period becomes up to three steps**, in order, sharing that
period's own window conditions:
1. (only if `payNonDeductibleDebtFirst`) a `debt` step, `deductibility: "nonDeductible"`, `order: debtOrder`, condition `repaid`.
2. (only if `allocations` non-empty) one step whose branches are the old allocations 1:1 (`targetType`→destination type, `targetId`, `pct`), no conditions — matching today's "no stopping condition on an allocation" exactly.
3. A remainder step: one branch, destination = old `remainderTo` (`cash`/`expenditure`), pct 100, no conditions.

Proof of fidelity: golden-number characterization tests captured from the
current code BEFORE this commit's engine changes, re-asserted identically
after (`deterministic.test.js`'s "Surplus and deficit allocation" describe
block, rewritten to the new vocabulary, plus a hydrate()-from-v16 migration
test asserting the same numeric outcome as before).

## The super sub-cascade — "CC to cap, then NCC" (Commit 2)

- **CC fill** — capped at the existing `concessionalHeadroomAfterFills`
  ledger (carry-forward already folded in). Unchanged from today; never
  deliberately pushed into excess.
- **NCC fill** — a new mirrored ledger, `nonConcessionalHeadroomAfterFills`,
  decremented the same way `concessionalHeadroomAfterFills` is — the
  money-bug-5 fix (multiple same-year claimants on one account, each
  believing they alone have the full amount) applied to this destination
  before it ships, not discovered after.
- **Bring-forward triggering from a surplus sweep is opt-in**
  (`allowBringForward` on the destination, default OFF). A manually-entered
  $300k NCC row is a deliberate one-off; a sweep quietly locking a client
  into a 3-year bring-forward because surplus happened to be large one year
  is a different risk and does not default on.
  - Opt-in OFF: the surplus-driven NCC is capped at whatever headroom this
    year's EXPLICIT NCC rows already decided (their own `processNonConcessionalCap`
    call, unchanged) — the surplus contribution never itself expands the
    window or triggers a new bring-forward.
  - Opt-in ON: `processNonConcessionalCap` is re-run at sweep time with the
    combined (explicit + surplus-candidate) requested amount, so the
    surplus contribution can genuinely trigger bring-forward the same way
    an explicit row would; `superBringForward[owner]` is updated to this
    resolved outcome.
- **Rejected NCC** — the excess is neither credited nor taxed; the cash
  debit is sized off the ACCEPTED amount only, via the same accept-ratio
  pattern that closed money bug 7 (a rejected contribution previously
  debited the full requested amount) — applied at this new call site
  explicitly, never assumed inherited.
- **Rejected/unabsorbed remainder cascades onward** through the ordinary
  "unconsumed share → next step" mechanism — no special case.
- **Division 293 / TSB** — both already downstream of the contribution
  amounts this sweep produces (Div293 at tax-assessment time reading
  `reportableSuperContributions`/`lowTaxContributions`; TSB gates read from
  the PRIOR 30 June, so this year's own surplus contribution can't
  retroactively change this year's own gate). Verified wired correctly in
  Commit 2, not redesigned.

## Conservation

Commit 1 re-plumbs existing flows (debt repayment, asset investment, CC
super, goal funding, cash/expenditure remainder) under the new cascade —
every one already has a named conservation term (or correctly needs none,
being a same-pockets transfer). No new term expected; confirmed, not
assumed, once `randomScenario()` is generating real cascades.

Commit 2 introduces a genuinely new flow (surplus → NCC) — mandatory
same-commit `randomScenario()` + `conservationCheck.js` extension per
CLAUDE.md. Expected to need no new conservation term either (an NCC
contribution is post-tax cash moving into an already-counted pocket, the
same shape as an explicit NCC row today, which needs none) — confirmed
once built, documented either way.

`randomScenario()` gains: variable-length cascades (1-4 steps), splits
(2-3 branches on a step), every condition kind including deliberately
engineered met-then-lost scenarios (an asset's `valueReaches` condition
that the random walk crosses in both directions), and NCC-cap-boundary
scenarios once Commit 2 lands. `THRESHOLD_REGISTRY` gains entries for
condition-value boundaries reached via the surplus path specifically.

## Commits

1. **Cascade engine core** — schema, migration, sweep rewrite, splits and
   un-satisfying conditions built in from the start. Super stays CC-only,
   bug-for-bug identical to today. `randomScenario()` rewritten.
   `engineContractShape.js`/`ENGINE_VERSION`/`engine-api.md` updated
   (breaking rename of `schedule.surplusPeriods`' own shape — MAJOR bump,
   no external consumer found beyond the engine itself). The OLD UI (main.js)
   is untouched and keeps working unchanged — it still authors old-shaped
   period objects, which the tolerance chain above upgrades transparently;
   it just can't express any of the new capability yet.
   Commit: `Surplus: condition-based cascade engine`
2. **NCC destination + CC-then-NCC sub-cascade** — the new ledger, opt-in
   bring-forward, rejection-aware debit, Div293/TSB verification.
   Commit: `Surplus: non-concessional destination and CC-then-NCC sub-cascade`
3. **Debt scope generalisation** — only if not already fully covered by
   Commit 1's schema (likely is; drop this commit if so).
4. **UI** — reuses `.cf-section`/`alloc-row`/`data-pfield`/`data-paction`,
   restyled for steps: destination, scope, condition, split, add/remove/
   reorder step. Extends `surplusDestinationBreakdown` with the year each
   condition is projected to be met. `focusSurplusAllocation.js` updated.
   Commit: `Surplus: cascade step editor`

## Tests (per commit, non-exhaustive — see each commit's own list)

- Every condition kind, at its own boundary (met, not yet met, exactly at).
- Un-satisfying: a `valueReaches` condition met then lost within the SAME
  run (market falls after the target is hit) — surplus resumes flowing.
- Splits: two branches, one closes, its share reaches the next step, not
  the sibling branch.
- Migration: single-period bit-identical (no condition attached);
  multi-period bit-identical (windowed correctly); hydrate()-from-v16
  bit-identical.
- Conservation: the full existing suite plus every new randomScenario()
  shape.
- Super sub-cascade (Commit 2): CC cap behaviour including carry-forward;
  NCC cap behaviour including bring-forward opt-in on/off; rejection debits
  only the accepted amount; rejected remainder cascades on; Div293/TSB
  read the right numbers.
