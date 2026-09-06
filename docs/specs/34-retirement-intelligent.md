# Retirement Page — Make It Intelligent

Conventions per CLAUDE.md. Five commits, gated. Engine and interaction
only — no outputs, no Word document, no export work in this spec.

## Why

The original brief for retirement work was three things: a lifecycle
investment option showing the shift to defensive; retirement Monte Carlo
with probability of ruin; and outputs. After spec 32 and 33, the first is
built but not on this page, the second does not exist at all, and the
third is deferred.

Worse, the page as built is a flat form. Nine fields, one static
"contributions above SG" number, a risk profile dropdown, and a
projection. It threw away the comprehensive tool's intelligence rather
than its clutter, and those are not the same thing.

Simple should mean fewer decisions, not fewer capabilities. The
comprehensive surface asks the adviser to configure everything. This page
should ask for the few things it cannot infer, be clever about the rest,
and answer questions rather than only reporting.

Almost none of this is new engine work. `runMonteCarlo` already returns
ruin probability, percentile bands and median shortfall age.
`findMinimumThreshold` already solves. Glide paths and the allocation
chart already exist. The page uses none of them. This spec wires what is
there.

---

## COMMIT 1 — The page knows things

Replace static inputs with derived ones. Every derived value shows its
source, per the smart-defaults registry.

- SG derives from salary at the statutory rate, shown as a read-only
  line beneath the salary field: "Super Guarantee: $13,800 (12% of
  $115,000, capped at the maximum contribution base)". Remove any input
  that duplicates it.
- Preservation age and age pension age derive from date of birth. Show
  them; do not ask.
- Concessional cap headroom live, as the comprehensive super section
  already does: "$32,500 cap · $13,800 SG · $10,000 sacrifice · $8,700
  available (incl. $0 carry-forward)". Recompute as the adviser types.
- Division 293 warning when income plus concessional contributions
  approaches $250,000, with the year it first bites.
- Age pension eligibility derived and shown, not a bare toggle: "Age
  pension modelled from age 67 (2049)", with the toggle to suppress it.

Contributions gain from and to using the existing DateRef anchors, so
"salary sacrifice $15,000 from 55 until retirement" is expressible. A
single static number cannot describe any real contribution strategy and
is the clearest example of the page being less capable than it should
be.

Tests: SG derives correctly including the maximum contribution base;
preservation and pension ages from DOB; cap headroom matching the
comprehensive section's own figures; the Division 293 warning firing at
the right year; contributions with windows reaching the engine
correctly.

Commit: `Retirement page: derived inputs and live constraints`

---

## COMMIT 2 — Monte Carlo and probability of ruin

Item 2 of the original brief, and the answer to the objection that
projections for young clients are meaningless. The advisers are right
that a single line thirty years out hides the variance; the answer is
the distribution, and it already exists.

- A Run simulation button on the page. `runMonteCarlo` already runs in a
  worker with progress and cancel — reuse it exactly, do not reimplement.
- Results cache against the existing state fingerprint and invalidate on
  input change, as the comprehensive Monte Carlo view already does.
- Fan chart of net assets with the 10/25/50/75/90 bands and the
  deterministic line overlaid.
- Probability of ruin as a headline number, using the single locked
  definition — the fraction of paths with any unfunded cashflow before
  projection end. Beside it: "your plan lasts to life expectancy in 82%
  of simulations", which is the same number stated the way a client
  hears it.
- Median first-shortfall age where one occurs.
- The custom-allocation flag `runMonteCarlo` already returns, surfaced.

Frame it for the client, not the modeller. The headline is not "ruin
probability 18%" — it is "in about 1 in 5 scenarios you run short before
95". State both; lead with the plain one.

Tests: the button runs and cancels; results cache and invalidate; the
headline figures match `runMonteCarlo`'s own output; the deterministic
line sits above the median, as the existing disclosure explains.

Commit: `Retirement page: Monte Carlo and probability of ruin`

---

## COMMIT 3 — Lifecycle on the page

Item 1 of the original brief. Glide paths exist; this page does not show
them.

- A glide path selector alongside the risk profile — the two presets
  from spec 32 plus any the adviser has defined.
- The asset allocation chart on the page, showing defensive rising over
  time. This is the picture that justifies the strategy and the reason
  the option was asked for.
- Lifecycle versus static, side by side: the same client under a glide
  path and under a fixed profile, as two lines, with the difference in
  capital at retirement and at life expectancy stated.

And with Monte Carlo from Commit 2, run that comparison as distributions
— because the honest answer is that a glide path is not simply worse or
better. It has a narrower distribution: worse median, better tail. That
is the whole argument for lifecycle investing and a deterministic line
cannot show it. Two fan charts, or one chart with both medians and both
10–90 bands.

This is the single most valuable screen in the spec — it answers the
young-client objection and justifies lifecycle investing in one picture.

Tests: the allocation chart reflects the glide path; the comparison arms
both run through `projectPlan` on clones; the distribution comparison
shows the expected narrowing.

Commit: `Retirement page: lifecycle and the glide-versus-static comparison`

---

## COMMIT 4 — It answers questions

The solver exists and this page has never called it. Four questions,
each a button producing an answer inline:

- "What contribution reaches my goal?" — solve the concessional
  contribution that makes Income Required sustainable to life
  expectancy. Show cap headroom alongside; flag when the answer exceeds
  the cap, because then the answer is that contributions alone cannot do
  it.
- "When could I retire?" — solve the earliest retirement age at which
  the plan still lasts. Note this is a fixed point: retiring later means
  more contributions and fewer drawdown years.
- "What can I afford to spend?" — sustainable income to LE and LE+5.
  Already computed by `retirementAnalytics`; surface it as an answer
  rather than a card figure.
- "What if returns are worse?" — the existing what-if shock machinery,
  applied at −1% and −2% to returns, showing the effect on the shortfall
  age.

Each answer states what it changed and offers to apply it to the plan —
never applies silently. Each reports honestly when there is no answer,
using the failure-mode distinction already built for the deposit solver
(cannot be reached versus reached but not sustained).

Tests: each solver produces a plan that satisfies its own question when
applied; cap-exceeded and no-answer cases report rather than converge on
nonsense.

Commit: `Retirement page: solver-backed questions`

---

## COMMIT 5 — It surfaces what matters unasked

Observations computed from the projection and shown without being
requested. Not advice — statements of fact about the modelled plan.

Examples, each with the year it applies:

- "$18,700 of concessional cap unused each year to retirement."
- "Division 293 applies from age 58."
- "Age pension entitlement begins at 67 and reaches $19,900 by 72."
- "Carry-forward contributions available: $46,000, expiring from 2029."
- "Total super balance passes $2m at 63 — transfer balance cap becomes
  relevant."
- "Your plan runs short at 88, seven years before life expectancy."

Rules that keep this useful rather than noisy:

- At most five at a time, ranked by materiality.
- Each states a fact and its year. No recommendations, no "you should" —
  the non-prescriptive convention applies here more than anywhere,
  because an observation that reads as advice is advice.
- Each is dismissible for the session.
- Derived from the projection, never from a rule of thumb. If it cannot
  be computed from the ledger it does not appear.

Tests: each observation fires only when its condition holds; ranking is
stable; the five-item cap holds; dismissal persists for the session.

Commit: `Retirement page: observations`

---

## Deferred — explicitly not this spec

Word output and the tickbox export panel. Prepopulation from a
comprehensive scenario. Mode switching. Any adapter to another system.
Comparison against another tool. Those follow once the engine and the
interaction are right.
