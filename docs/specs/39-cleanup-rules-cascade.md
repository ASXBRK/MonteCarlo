# Cleanup, Rule Gaps, and the Surplus Cascade

Conventions per CLAUDE.md. **Eight commits, gated.**

Ordering is deliberate: the contained work lands first and is banked, then
the cascade — the large engine change — goes last. If the cascade needs
rework, everything before it is already done.

---

## COMMIT 1 — The FHSSS conservation flake

**Highest priority in this spec.** The conservation invariant has fired
twice during spec 37 work with "FHSSS release doesn't net to zero",
non-reproducible on retry both times, and was deferred as out of scope.

That guard has caught **seven money bugs** in this project and does not
produce false positives easily. Intermittent means it depends on generated
values that only sometimes collide — which is a real defect with a narrow
trigger, not noise.

Find it. Approach:
- Capture the failing seed. If `randomScenario()` does not currently report
  its seed on an invariant failure, **make it do so first** — an
  unreproducible failure in this guard is a hole in the guard.
- Once reproducible, reduce to the minimal scenario and identify which FHSSS
  leg fails to balance: the release, the associated earnings, the tax
  withheld, or the cap interaction.
- Fix the cause and add the reduced scenario as a fixed test.

If it proves genuinely benign — a tolerance issue rather than money moving —
say so with the arithmetic, and tighten or document the tolerance so it
cannot fire again for that reason.

Commit: `Fix: FHSSS conservation invariant failure`

---

## COMMIT 2 — Division 296 and HELP income base

Spec 37 Commit 5 fixed the Division 293 income base to include the year's
net capital gain, and **deliberately left the identical gap in Division 296
and HELP repayment income**, disclosed rather than silently fixed.

Close it. Same correction, same source, routed through one shared income-base
function rather than three call sites — the TSB fix in spec 37 Commit 2
found two further defects precisely because it consolidated rather than
patched.

Tests: each of the three income bases including a net capital gain; a year
with a capital loss; the existing Division 293 behaviour unchanged.
Commit: `Fix: Division 296 and HELP income bases exclude net capital gain`

---

## COMMIT 3 — Review findings 2.1 to 2.4

**Read `docs/reference/adversarial-review-2026-09/README.md` §2 for the full
text of each finding and its probe.** Do not work from this summary alone.

- **2.1** — the age pension is treated as non-assessable income and the
  output does not say so. Note spec 37 Commit 4 corrected the cash totals;
  what remains is the **disclosure**.
- **2.2** — bonus-to-super contributions do not appear on the NCC line. Spec
  37 Commit 5 fixed the cap bypass; this is the display half.
- **2.3** — "whole balance" pension commencement leaves the July growth
  behind.
- **2.4** — transfer balance figures in the Super view.

Verify each against its existing probe before and after.
Commit: `Fix: review findings 2.1 to 2.4`

---

## COMMIT 4 — Review findings 2.6, 2.7 and 2.9

- **2.6** — Monte Carlo percentiles shown to the dollar. Note spec 36 added
  a rounding convention for simulation-derived figures; apply the same rule
  here rather than inventing a second one.
- **2.7** — crash timing labels for a retiree.
- **2.9** — the table and CSV of the same view use different rounding and
  sign conventions: tables round to the dollar with parentheses for
  negatives, the transposed CSV writes cents with a minus sign, the Snapshot
  CSV rounds.

For 2.9, **pick one convention and apply it everywhere**, then add a test
asserting that every table and its CSV agree on rounding and sign. The
defect is that three conventions coexist; fixing the instances without
closing the class leaves the fourth to appear later.

**2.5 and 2.8 are already fixed** by spec 37 Commits 4 and 6. Confirm, and
record that they need no work.
Commit: `Fix: review findings 2.6, 2.7, 2.9 and one rounding convention`

---

## COMMITS 5 to 8 — The surplus cascade

### Why

Surplus treatment is split into time periods. To express "pay down the
mortgage, then invest", the adviser must work out which year the mortgage is
repaid and hand that year back as a period boundary. **The engine already
knows that year.** It should be the one working it out.

### The model

An ordered cascade, re-evaluated at each FY-end sweep. Each step has a
destination, a scope, an until-condition, and an optional split.

```
1. Non-deductible debt    until repaid        [which loans: select]
2. Shares                 until $500,000
3. Deductible debt        until repaid
4. Super                  CC to cap, then NCC
```

Surplus fills step 1; what remains cascades to step 2, and so on. When a
step's condition is met it stops taking and everything flows on.

### COMMIT 5 — Conditions and the engine

**Until-conditions:** until repaid · until balance below $X · until value
reaches $X · until an age or date.

The last **absorbs the existing period mechanism** — a period is a
time-based condition. Do not keep two systems. Migrate existing period state
into equivalent cascades and **confirm projections are bit-identical before
and after**; that migration test is the gate for this commit.

**Conditions can un-satisfy.** Shares reach $500k, the market falls, they
are worth $450k, surplus resumes flowing there. Evaluate the cascade fresh
at every sweep; never permanently retire a step. Test a scenario where a
target is met and then lost.

Commit: `Surplus cascade: conditions replace periods`

### COMMIT 6 — Conservation

**Read this before building either commit.**

A cascade is built out of partial fills. Step 1 takes $10k of a $30k surplus
and passes $20k on. Every handoff can create or destroy money, and the super
step can reject a contribution outright.

This is exactly where this project's money bugs have lived. Bug 7 was a
rejected NCC debiting the full requested amount from cash while crediting
only the accepted portion. Bug 5 was multiple claimants on one super balance
each checking availability in isolation — **found twice, in different
features.**

Extend `randomScenario()` to generate multi-step cascades with splits,
rejections and un-satisfying conditions. Confirm the conservation invariant
holds across the full stratified sweep. **This commit gates the rest.**

Commit: `Surplus cascade: conservation coverage`

### COMMIT 7 — The super sub-cascade

"CC to cap, then NCC" is a nested waterfall needing its own stated, tested
rules:
- Behaviour at the CC cap, including available carry-forward
- Behaviour at the NCC cap, including whether bring-forward triggers and
  whether that is **opt-in** rather than automatic
- What happens when a contribution is **rejected** rather than partially
  accepted
- Whether the remainder cascades onward or stops there
- Division 293 and TSB interactions — **note TSB now includes pension
  balances** since spec 37 Commit 2, so gates bind on more clients than
  before

Commit: `Surplus cascade: super sub-cascade`

### COMMIT 8 — Splits and UI

**Splits:** a step divides across destinations by percentage, each branch
carrying its own until-condition, so one branch can fill and close while the
other keeps taking. **State what happens to a closed branch's share** —
redistribute within the step, or cascade on.

**UI:** reuse existing components. Each step is a row — destination, scope
selector where relevant, until-condition, optional split. Add, remove,
reorder. Keep the resolved-effect line the current UI already shows, and add
**the year each condition is projected to be met**. That figure is the whole
point of the redesign.

Commit: `Surplus cascade: splits and UI`

---

## Not in scope
The APL product comparison tool. Hide-if-empty on input sections. Spec 38
Commit 3, deliberately skipped.
