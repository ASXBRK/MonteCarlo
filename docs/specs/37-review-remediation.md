# Review Remediation

Conventions per CLAUDE.md. **Six commits, gated.**

Source: `docs/reference/adversarial-review-2026-09/README.md` and its
probes, on branch `claude/lucid-ptolemy-rxca4k`. **Merge or cherry-pick that
branch first** so the document and probes are on the main branch before any
fix lands — every commit below is verified against a probe that already
exists.

## The shape of the problem

Fourteen critical findings resolve to **four root causes**. This spec is
organised by cause, not by finding, because fixing a cause fixes its whole
class and fixing instances leaves siblings behind.

| Cause | Findings |
|---|---|
| `julyOf(0)` returns null in a partial first year | 1.1, three of the four dead arms in 1.13 |
| The display layer re-derives totals instead of reading the ledger | 1.10, 1.11, 2.5 |
| Total superannuation balance computed accumulation-only | 1.2 |
| `holdingsFor` omits pension and bond balances | 1.6, 1.14 |

**Every commit adds a regression test for the class, not the instance.** A
test that only covers the reported case leaves the sibling defects live —
which is how `reserveFromSuper` was found twice and how the silent
comparison arm has now appeared four times.

**The engine is largely sound.** Conservation held on every probe in both
passes. Most of what follows is wrong *rules* and wrong *display*, which is
precisely what the conservation invariant cannot catch — worth stating in
the build log so the guard is not over-trusted.

---

## COMMIT 1 — Partial-first-year events

**Finding 1.1**, and the cause of three dead comparison arms in 1.13.

Six event types resolve through `julyOf(0)`, which returns null in a partial
first year, so the event does not fire **at all** rather than being
deferred: pension commencement, defined benefit commencement, gifts,
rollovers, commutations, aged care entry.

**The rule, decided:** resolve each event to its actual month and fire it
there. **Plan start is the fallback only where the anchor resolves to a
month before the plan begins.** A September-start plan with a gift dated
March 2027 fires in March; one with a pension commencement anchored to "now"
fires in September.

This differs deliberately from recurring annual rows, which are anchored to
July and skip a partial first year. A one-off has a date the user chose;
honour it.

Tests: a scenario for **each of the six event types** with a partial-year
start, asserting the event fires in the correct month; an anchor resolving
before plan start falling back to plan start; the July-anchored recurring
behaviour unchanged. **A single test covering one event type is not
sufficient** — the defect is the class.

Also fixes: the aged care planning gift arm and the RAD/DAP arms (1.13),
which were dead for this reason. Verify each now changes the projection.
Commit: `Fix: one-off events dated in a partial first year never fire`

---

## COMMIT 2 — Total superannuation balance

**Finding 1.2.** TSB in law is accumulation **plus** the retirement-phase
value. The engine sums accumulation only, at every site that tests it.

Six legislative gates are affected: carry-forward eligibility (<$500,000),
bring-forward tier selection, the nil NCC cap, Division 296, the
co-contribution, and the spouse contribution offset.

**This will make outcomes worse for affected clients, correctly.** A client
with $1.9m in pension and $100k in accumulation currently reads as TSB
$100k and is offered the full $390,000 bring-forward. Correctly tested at
$2m, they lose carry-forward, drop to a nil bring-forward, and come into
Division 296. One probe shows a $90,000 personal deductible contribution
currently accepted in full that should produce ~$58,293 of excess
contributions.

Fix at the single source that computes TSB; do not patch call sites. If no
single source exists, create one and route every gate through it.

Tests: each of the six gates with pension balances present, asserting the
correct outcome; the probe scenario producing the excess; a client with no
pension unchanged. Document the change in the build log as a **deliberate
tightening**, since scenarios saved before this will project differently.
Commit: `Fix: total superannuation balance excludes pension-phase balances`

---

## COMMIT 3 — Monte Carlo shocks pensions and bonds

**Findings 1.6 and 1.14.** `holdingsFor` builds its shock set from assets
and super accounts only. The deterministic engine asks for a pension shock
and always receives zero.

Measured: a High Growth pension shows a ±3% fan after fourteen years against
−45%/+58% for the same money in accumulation. A 30% crash what-if moves a
pension-only retiree by **$357**.

**Every retiree's probability of ruin is currently understated**, and every
output built on the simulation inherits it — the fan charts, the levers
panel, and specs 34 to 36 in their entirety.

Shock pension-phase balances and bonds on the same basis as accumulation,
using each holding's own allocation.

Tests: a pension-only scenario producing a fan comparable to the same money
in accumulation; a bond-holding scenario likewise; the crash what-if moving
a pension retiree materially; **an assertion that every balance type
carrying market exposure appears in the shock set**, so a future balance
type cannot be silently omitted.

**After this lands, re-verify the spec 34–36 outputs.** Their figures will
change and the documented examples will be stale.
Commit: `Fix: Monte Carlo applies no market shock to pensions or bonds`

---

## COMMIT 4 — The display layer reads the ledger

**Findings 1.10, 1.11, 2.5.** `main.js`, `cashflowStatement.js`,
`cashflowCategories.js`, `chartSeries.js` and `outputSeries.js` each
re-derive their own totals rather than reading what the engine computed.
They have drifted.

**Total assets** omits pension and bond balances — $51,582 displayed
against `row.netAssets` of $746,846, on adjacent rows, with no liabilities
to explain the gap. Affects Key figures, Debt vs assets, Super vs
non-super, and the Scenario comparison series.

**Cash received** omits pension payments, expenditure-pension draws and
released-super draws. **Total income** omits the age pension, which is in
`row.income` but in no category. A retiree shows a $45,000 annual deficit
on the Snapshot view — the table the build log describes as the one pasted
into the file note — while their cash rises. Total income reads **$42**.

The age pension is non-assessable for tax and **is** cash. It belongs in
every cash and income total; it does not belong in assessable income.
Currently it is in neither.

The composite chart gains a drawdown bar; the Expense funding chart stops
describing drawdown as "met from income".

**Read `row.netAssets`, `row.income` and the engine's own sub-totals rather
than recomputing them.** Where a display needs a breakdown the engine does
not publish, add it to the engine's output rather than deriving it
separately — that is what allowed the drift.

Tests: a reconciliation test asserting **every displayed total equals its
ledger source** for a scenario containing accumulation, pension, bonds,
property and age pension — one test that would have caught all three
findings; the retiree probe reconciling; `cashflowCategories.js`'s
reconciliation claim in its own header made true or removed.
Commit: `Fix: display totals omit pension, bond and age pension amounts`

---

## COMMIT 5 — Rule corrections

Six contained fixes, each with its own test.

| Finding | Fix |
|---|---|
| 1.3 | `hydrate` whitelist drops fields `clampAllToPlan` keeps (`fhsssEligible`, `excludeFromRetirement`). Saved plans reopen with different numbers. **Add a test asserting hydrate and clamp agree on the full field set**, so the next added field cannot drift. |
| 1.4 | A bonus directed to super bypasses the NCC cap. Route through the same cap logic as an NCC row — two entry paths must not give two answers. |
| 1.5 | An open bring-forward window ignores a later TSB at or above the general cap. |
| 1.7 | Death benefit tax on an untaxed-status account uses the taxed-element rate. Should be 30% + Medicare. ~$130,000 understated per probe. Relevant to GESB West State holders. |
| 1.8 | Division 293 and HELP repayment income exclude the year's net capital gain. **Note: this corrects the brief — the issue is the income base, not timing.** |
| 1.9 | The personal transfer balance cap ratchets upward in real terms — a nominal cap leaking into a real computation, against the locked convention. |
| 1.12 | The deficit fallback drains a super account excluded from retirement funding. `fundingOrder` already honours the flag; make the fallback match. |

Commit: `Fix: rule corrections from the 2026-09 review`

---

## COMMIT 6 — Dead levers, and the guard that catches the class

**Finding 1.13**, remaining two. "Retire later" and "Spend less" do nothing
on a plan without retirement-anchored income rows or an expenditure pension.

**A lever that cannot bite and a lever that is broken are indistinguishable
from outside** — both report non-convergence. That is why spec 35's tests
passed. Fix the levers to detect the condition and say so specifically
("this plan has no retirement-anchored income to defer") rather than
reporting a generic no-answer.

**Then close the class.** This has now occurred four times: a gift arm in
spec 21b, a deposit solver, the aged care arms, and these two levers. Add a
test that, **for every comparison arm, what-if shock and lever in the
application**, constructs a scenario where that arm must bite and asserts
the projection differs from its baseline. Register arms so a new one cannot
be added without appearing in the test.

Also: **finding 2.8** — the "Comprehensive pre-retiree" demo client never
retires. It is one of the four fixtures built for the firm presentation.
Fix the fixture and assert the retirement key date is reached within the
projection.

Commit: `Fix: dead comparison arms, and a guard covering every arm`

---

## Serious findings — separate spec

Findings 2.1 to 2.9 are misleading-output rather than wrong-number defects:
disclosure gaps, precision and sign-convention mismatches between tables and
CSVs, crash-timing labels, the transfer balance figures in the Super view.
They deserve a spec of their own rather than being folded in here, where
they would compete with corrections that change client numbers.
