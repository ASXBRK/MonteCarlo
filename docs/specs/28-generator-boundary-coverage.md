# Conservation Generator: Boundary Coverage

Conventions per CLAUDE.md. **Two commits, gated.** Test infrastructure only
— no engine or UI changes. Any engine defect this surfaces is fixed in the
same commit, per the existing rule.

## Why

The conservation invariant has caught seven money defects. Two of them hid
for months in ranges `randomScenario()` never generated:

1. **Super drawn down for household deficits in a financial year's final
   month** — a snapshot-ordering bug present since Tier 1.2, surfaced only
   when a demo scenario was made to genuinely fail.
2. **A non-concessional contribution rejected because total super balance
   sat near the bring-forward nil tier (~$2.1m)** — the rejected portion
   was debited from household cash but never credited to super. Surfaced
   only when spec 26's own fixtures wandered into that range.

Both were invisible to inspection and both were found by accident. **The
guard only guards what the generator generates**, and the generator has been
extended feature-by-feature rather than to cover the space. Its blind spots
are systematically at *boundaries* — the exact places where branch logic
lives and therefore where defects concentrate.

This closes that class deliberately rather than waiting for the next
accident.

---

## COMMIT 1 — Threshold-aware generation

Rewrite `randomScenario()`'s value generation so that, for every modelled
threshold, values are drawn **at, just below, and just above** it — not
uniformly across a range that may never reach it.

### Method
Build a registry of thresholds the engine branches on, and for each,
generate values from a stratified set: `{ well below, just below, exactly
at, just above, well above }`. Draw the stratum uniformly, then jitter
within it, so every run exercises boundaries rather than reaching them by
chance.

### Thresholds to cover, at minimum
**Tax** — every marginal bracket boundary; the Medicare shading-in range;
the MLS band boundaries; the HELP bracket boundaries including the
whole-income cliff at the top bracket; the Division 293 $250,000 threshold;
the Division 296 $3m and $10m tiers; LITO phase-out.

**Super** — concessional cap with and without carry-forward; the $500,000
carry-forward TSB gate **exactly at, just under and just over**; every
bring-forward TSB tier including the nil tier that hid bug 7; the untaxed
plan cap; the age 67 and 75 contribution limits; preservation age 60 and
release at 65.

**Pension** — every minimum-drawdown age band boundary; the general and
personal transfer balance cap including a member at exactly 100% used;
commencement in June (no minimum) versus July.

**Age pension** — assets and income test full-pension thresholds and
cut-outs for both homeowner and non-homeowner, single and couple; the
deeming tier boundary; the Work Bonus income bank at zero and at its cap;
gifting at exactly $10,000 and $30,000 over five years; age pension age.

**Property and debt** — LVR at exactly 80% (the LMI boundary); land tax
thresholds; the six-year absence rule at exactly six years; the 1 July 2027
CGT regime boundary; fixed-rate rollover in the first and last month.

**Bonds** — exactly ten years; a contribution at exactly 125% and at
125% + $1; a year with no contribution followed by one with.

**Timing** — projections starting in June, July and mid-year; a projection
of exactly one year; an event on the first and last month of the
projection; a cashflow window of exactly one month.

### Also generate degenerate states
Zero balances everywhere; a single-year projection; a person with no income;
every asset excluded; a liability larger than all assets; a goal that can
never be funded.

Tests: the generator demonstrably produces values in every stratum for
every registered threshold — assert this directly, since a generator that
silently stops covering a boundary is the failure mode being fixed. Run
the conservation sweep at least 10 × 300 scenarios and report any defect.

Commit: `Conservation generator: threshold-aware value generation`

---

## COMMIT 2 — Coverage reporting and a standing rule

### Coverage report
After a sweep, emit a summary of which thresholds were exercised and in
which strata across the run — committed as a test that **fails if any
registered threshold went unexercised**. Without this the registry silently
rots as the engine changes.

### CLAUDE.md addition
Extend the existing rule. Currently: *any commit introducing a new money
flow must extend `randomScenario()` and the invariant in the same commit.*
Add:

> Any commit introducing a new **threshold** — a value the engine branches
> on — must register it in the generator's threshold registry in the same
> commit. Thresholds are where defects concentrate; a threshold the
> generator cannot reach is unguarded.

### Report
State plainly in the final report: how many defects this surfaced, and for
each, how long it had been present. If it surfaces none, say so — that is
also informative, and it would mean the two known blind spots were unlucky
rather than symptomatic.

Commit: `Conservation generator: coverage reporting and threshold rule`

---

## Deferred — do not build
Property-based shrinking of failing cases (useful but a larger change).
Mutation testing. Coverage-guided generation. Fuzzing the UI layer.
