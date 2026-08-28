# Engine API Boundary

Conventions per CLAUDE.md. **Four commits, gated.** No behaviour changes —
this defines and documents a contract around what already exists.

## Why

The engine may be consumed by another tool: the firm holds a second
projection system that produces a polished house-format document but models
a snapshot year and extrapolates (spec 30 measures the consequence). The
plausible combination is **their document, our engine**.

That is only actionable if `projectPlan(state)` has a stated, stable
contract. Today the engine is excellent and entirely undocumented as an
interface — a developer wanting to consume it would have to read
`deterministic.js` and infer the shape. This turns "we should combine these"
into something someone can do in an afternoon.

**It is also good hygiene regardless.** A documented result shape is what
lets us change internals without breaking every view.

---

## COMMIT 1 — Define and version the contract

`src/engine.js` — a thin public surface over the existing modules. It adds
no logic; it names what is already there and fixes its shape.

```
runProjection(input) → ProjectionResult
```

**Input** — the existing plan state, validated on entry. Validation must
produce **structured errors** naming the field and the problem, not
exceptions: a consumer needs to tell its user what to fix. Reuse the
existing clamp and normalise functions rather than writing a second
validator, or the two will diverge.

**Output** — the existing yearly ledger plus the summary fields, with every
field named and typed. Add `engineVersion` and `figuresAsAt` to the result:
a consumer must be able to tell which rate period produced a number, and a
projection is only meaningful alongside the figures that generated it.

**Versioning.** Semantic: the schema version already exists for state; add
one for the *result*. Breaking changes to the result shape bump the major;
additive fields bump the minor. Record the current version and the rule in
`docs/reference/engine-api.md`.

Tests: the contract's declared fields all exist in real output for a
populated scenario; validation returns structured errors for each of a
representative set of invalid inputs; the version constants are present.
Commit: `Engine API: public surface and versioned contract`

---

## COMMIT 2 — Documentation

`docs/reference/engine-api.md`, written for a developer who has never seen
this repo:

- **Getting started** — minimum viable input for a projection, and the
  result you get back. A worked example with actual figures.
- **Input reference** — every collection and field, with types, units, and
  which are required. State plainly that **all amounts are in today's
  dollars** and that FY anchoring means a partial first year.
- **Output reference** — every field in the yearly ledger and the summary,
  with its meaning and units.
- **Conventions that will surprise a consumer**, drawn from
  `docs/reference/assumptions-provenance.md` §10: real terms throughout;
  ages tick 1 July; annual cashflows fire in July and are skipped in a
  partial first year beginning after July; growth precedes cashflow within a
  month; tax timing (PAYG in-year, CGT and Division 293/296 in July of the
  following FY); explicit withdrawals do not cascade.
- **The assumptions the consumer inherits** — link to the provenance
  document, and state that a consumer displaying our numbers is adopting our
  assumptions and should say so.
- **What the engine does not model** — the deferred list, consolidated.

Commit: `Engine API: developer documentation`

---

## COMMIT 3 — Serialisation and a worked integration

- **JSON in, JSON out.** The state already serialises (the export/import
  path exists); ensure the result does too, with no functions, no undefined,
  and no circular references. Verify by round-tripping through
  `JSON.stringify`/`parse` and asserting deep equality.
- **A worked integration example** in the docs: construct a client from
  JSON, run a projection, and read the figures a document generator would
  need — the firm's own row vocabulary (`cashflowStatement.js`) and the
  snapshot view, since those are exactly what a document tool consumes.
- **A stable identifier convention** so a consumer can correlate rows across
  runs: asset, liability and cashflow ids already exist and are stable
  through save/load; document that guarantee explicitly, because a consumer
  will depend on it.

Tests: result round-trips through JSON with deep equality; the worked
example runs as a test, so the documentation cannot rot; ids are stable
across serialisation.
Commit: `Engine API: serialisation and worked integration example`

---

## COMMIT 4 — Contract stability test

The durable piece.

A test asserting the **full result shape** against a committed snapshot of
its field structure — names and types, not values. Values change whenever a
bug is fixed and that is correct; the *shape* is the contract and must not
change silently.

- Removing or renaming a result field **fails the test**, forcing either a
  version bump or a reconsideration.
- Adding a field passes but **prints a notice** that the minor version
  should increment.
- The snapshot is committed and updated deliberately, never regenerated
  automatically — an auto-updating snapshot tests nothing.

Add to CLAUDE.md:

> The engine result shape is a published contract. Any commit changing it
> must update the contract snapshot and bump the result version in the same
> commit. Removing or renaming a field is a breaking change.

Tests: the shape snapshot matches current output; a deliberately removed
field fails the test (verify by temporarily removing one, as you did for the
conservation invariant).
Commit: `Engine API: contract stability test`

---

## Deferred — do not build
An HTTP service or any network layer. Authentication. A published npm
package. Streaming or incremental results. Backward-compatibility shims for
old result versions — consumers pin a version. Monte Carlo through the
public API (deterministic only for now; add it once a consumer needs it).
