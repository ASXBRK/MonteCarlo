# Tier 1.1 — Key Dates (named anchors)

Conventions per CLAUDE.md. Two commits: model first, then UI.

## Why

Every date field in the app currently stores a bare integer age
(`fromAge`, `toAge`, `age`, `purchaseAge`). Change a client's intended
retirement from 65 to 67 and you must hand-edit every affected row.
Xtools+ solves this with **Key Dates** — named anchors (`Retirement`,
`Buy a Home`) referenced by every start/end field, so moving the anchor
moves everything that points at it.

This also retires the `ASSUMED_RETIREMENT_AGE = 65` constant introduced as
a stopgap in the composite-chart work, and it lands before super because
every super date field ("salary sacrifice until retirement", "preservation
age") would otherwise hard-code an integer and need unpicking later.

**Engine semantics do not change in this phase.** Anchors resolve to
exactly the plan years that integer ages resolved to. The regression gate
below is the point of the whole exercise.

---

## COMMIT 1 — Model, resolution, migration

### New intake field
Each person gains **`retirementAge`** (integer, default 65) in their Setup
block, beside the existing tax-profile fields. Helper text: "Used as the
Retirement key date and as the default report period anchor."

### Key dates
```js
plan.keyDates = [ KeyDate ]      // user-defined, may be empty

KeyDate = {
  id,
  label,                         // free text, e.g. "Buy a home"
  basis: "client" | "partner",   // whose age; partner only when couple
  age,                           // integer
}
```

**Built-in anchors** are not stored — they are derived and always
available:
- `start` — plan year 0
- `end` — final plan year
- `retirement-client` — from `plan.client.retirementAge`
- `retirement-partner` — from `plan.partner.retirementAge` (couple only)

### Date references
Every date field becomes a reference:
```js
DateRef = { kind: "anchor", anchorId }     // built-in id or a keyDate id
        | { kind: "age", age }             // explicit, as today
```
Fields converted: cashflow `fromAge`/`toAge` → `from`/`to`; lump sum
`age` → `at`; property `purchaseAge` → `purchaseAt`.

### Resolution (`src/keyDates.js`, pure, tested)
```
resolveRef(ref, plan, schedule, ownerForAges) → { planYear, age, fyLabel }
listAnchors(plan, schedule) → [{ id, label, planYear, age, fyLabel, display }]
```
- Anchor resolution: `start` → 0; `end` → last plan year;
  retirement anchors → the plan year in which that person reaches their
  retirement age; user key dates → the plan year for their `age` on their
  `basis` person.
- `{kind:"age"}` resolution keeps the existing rule exactly: income rows
  resolve against the **owner's** age, everything else against the
  **client's**.
- Out-of-window anchors **clamp** to the first/last plan year and set an
  `outOfRange: true` flag for the UI to surface. Never throw.
- `display` string format: `Retirement — age 65 (FY2051–52)`.

### Wiring
`schedule.js` and `deterministic.js` consume resolved plan years. Resolve
once, at the top of schedule building — do not thread refs into the engine
loop. The engine's own signature and behaviour are unchanged.

### Defaults for newly created rows (important — this is what makes anchors usable)
New rows must open **already anchored**, not with a number typed into an age
box. Entering a salary should be "Start → Retirement" out of the box, and
living expenses "Start → End", with no arithmetic from the user.

| Row type | Default `from` / `at` | Default `to` |
|---|---|---|
| Income | `anchor: start` | `anchor: retirement-<owner>` |
| Expense | `anchor: start` | `anchor: end` |
| Contribution | `anchor: start` | `anchor: retirement-client` |
| Withdrawal | `anchor: start` | `anchor: end` |
| One-off amount | `age: <client current age>` | — |
| Planned property purchase | `age: <client current age + 5>` | — |

Rationale: salary and contributions stop at retirement; living costs and
advice fees run for life; one-offs and purchases are point events the user
will always set deliberately, so they default to an explicit age rather than
an anchor.

These defaults apply to **new** rows only. Migration never changes an
existing row's dates — migrated rows keep `{kind:"age"}` with their original
integers, per the regression gate.

Second-order benefit worth preserving: a row anchored to `start` follows
automatically when the client's DOB or the projection start date changes,
where an explicit age would silently drift out of alignment.

### Migration (schemaVersion bump)
- Every integer date field → `{ kind: "age", age: <the integer> }`.
- `retirementAge` defaults to 65 per person; `keyDates` defaults to `[]`.
- **Regression gate (the point of this phase): a scenario migrated from
  the previous schema must produce bit-identical projections — every
  yearly ledger row, every per-asset closing, every tax figure.** Write
  this as a test over a scenario exercising income, expenses,
  contributions, withdrawals, one-offs, a liability and a planned
  property.

### Default report period
Replace `ASSUMED_RETIREMENT_AGE` with the client's `retirementAge`:
`toAge = min(endAge, retirementAge + 25)`, `everyN` rule unchanged.
Delete the constant and its comment.

Commit: `Key dates: named anchors, date references, resolution`

---

## COMMIT 2 — UI and annotation

### Setup section
- Retirement age input per person (couple → two).
- A **Key dates** block below the timeline: repeatable rows of
  label · basis (hidden when single) · age, with the derived
  `age 34 (FY2031–32)` shown alongside, plus Add/Remove. Built-in anchors
  are listed above as read-only reference rows so the user can see what's
  available without being able to delete them.

### Date fields everywhere
Every from/to/at field becomes a single select listing, in this order:

1. `Start` and `End`
2. `Retirement — <client name>` (and `Retirement — <partner name>` when couple)
3. user key dates, in the order defined in Setup
4. `Specific age…` — reveals the existing number input

Each option label carries its resolved value so the user never has to work
it out: `Start — age 40 (FY2026–27)`, `Retirement — Sarah, age 65
(FY2051–52)`, `Buy a home — age 34 (FY2031–32)`. When an anchor is
selected, the resolved `age N (FY…)` also shows beside the select.

An out-of-range reference renders with the existing inline-error treatment
and the message "Falls outside the projection window — clamped to age N".

### Deleting a referenced key date
Confirm dialog lists the rows pointing at it and offers **"Convert those
references to age N"** (default) or **Cancel**. Never orphan a reference,
never silently drop data.

### Table and chart annotation
- Transposed table year columns whose plan year matches a key date show
  the label as a third header line beneath age and FY (truncate long
  labels with a title attribute).
- `forcedYearIndices()` gains every resolved key date year, so forcing
  pins them through thinning alongside the existing shortfall and
  property-purchase years.
- The composite chart adds a light vertical rule plus label at each key
  date year. Keep it subtle — thin, low-opacity, no fill.

### Tests
Anchor resolution for all four built-ins plus user key dates on both
bases; owner-vs-client resolution for `{kind:"age"}` rows; out-of-range
clamping; key-date deletion converting references; forced-year inclusion;
column annotation selects the right years. Unit level only.

Commit: `Key dates: setup UI, anchor selects, table and chart annotation`

---

## Deferred — not this phase
Anchor-driven report period controls (the default derivation above is
enough for now); market-crash and interest-rate periods as key dates;
inline key-date creation from within a date select; key dates stored as
explicit FYs rather than ages.
