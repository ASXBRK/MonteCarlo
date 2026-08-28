# Engine API — Developer Reference

Spec 31. The public boundary around the projection engine: `src/engine.js`'s
`runProjection(input, profiles)`. Written for a developer who has never seen
this repo — someone wiring this engine into a second tool (a document
generator, another advice platform) rather than building a UI on top of it.

`engine.js` adds no logic of its own. Everything it returns comes straight
out of `deterministic.js` (`projectPlan`) and `planState.js`
(`clampAllToPlan`) — this document names and stabilises that existing
shape; it does not describe anything new the engine now does.

---

## 1. Getting started

```js
import { runProjection } from "./src/engine.js";

const input = {
  plan: {
    household: "single",
    client: { currentAge: 40 },
    endAge: 45,
    start: { year: 2026, month: 7 },
  },
  assets: [
    {
      id: "portfolio", name: "Investment portfolio", include: true, owner: "client",
      distributions: "reinvest", balance: 250000,
      allocation: { mode: "profile", profile: "Balanced" },
      icrPct: 0.5, cgtAsset: true, costBase: 180000,
    },
  ],
  cashflows: {
    income: [
      { id: "salary", label: "Salary", owner: "client", amount: 120000, frequency: "annual", fromAge: 40, toAge: 44, indexed: true },
    ],
    expenses: [
      { id: "living", label: "Living expenses", amount: 5500, frequency: "monthly", fromAge: 40, toAge: 120, indexed: true },
    ],
    contributions: [], withdrawals: [], lumpSums: [],
  },
  assumptions: { cpi: 0.025, bracketMode: "indexed" },
};

const result = runProjection(input);
```

`result.errors` is `[]`. The first row of `result.yearly` (FY2026–27, the
client's age-40 year) —

```
fyLabel: "FY2026–27"
income: 120000          tax: 28920            expenses: 66000
surplusOrDeficit: 25600  closingBalance: 256951  netAssets: 282551
```

`result.yearly` has **6** entries — one per FY from the start month to the
FY the client turns `endAge` (45), inclusive. The last year has `income: 0`
(the salary row's `toAge` is 44) and a negative `surplusOrDeficit` funded
from the portfolio — the projection doesn't stop just because the modelled
income does.

This is the **minimum viable input**: `plan` (household, the client's age,
`endAge`, and `start`), `assets` (may be `[]`), `cashflows` with its five
row arrays present (each may be `[]`), and `assumptions.cpi`. Everything
else — `partner`, `liabilities`, `properties`, `goals`, `bonds`,
`settings`, `plan.superAccounts`/`pensions`/`definedBenefits`/etc. — is
optional and defaults sensibly if omitted (see §2).

`runProjection` never throws. Pass it something structurally broken and you
get back `{ engineVersion, figuresAsAt, errors: [...] }` with no `yearly`
at all — see §4.

---

## 2. Input reference

The plan state (`input` above) is the same object this app itself stores
per scenario — nothing engine-specific about its shape. Every amount
everywhere in the input (and the output) is in **today's dollars — real
terms, not nominal**. The engine works entirely in real terms; a consumer
wanting nominal (future-dollar) figures scales at display time:
`nominal = real × (1 + cpi)^(months since start ÷ 12)`. This app's own
`display.units` toggle and `nominalFactor()` helper (`schedule.js`) show
the exact scaling — engine.js does not do this for you.

FY anchoring: the projection runs in Australian financial years (1 Jul–30
Jun), labelled `"FY2026–27"`. If `plan.start.month > 7`, the FIRST year is
a genuinely partial year (start month → 30 June) — annual/one-off
cashflows that fire in July are skipped entirely that first year (§3).

### `plan` (required)
| Field | Type | Required | Meaning |
|---|---|---|---|
| `household` | `"single"` \| `"couple"` | no (defaults `"single"`) | |
| `client` | `{ currentAge, dob?, retirementAge?, ... }` | no (defaults a 40-year-old) | ages tick each 1 July, not on the birthday |
| `partner` | same shape as `client` | only meaningful if `household: "couple"` | |
| `endAge` | number | no (defaults via `endBasis`) | client-anchored; the projection's last FY is the one the client turns this age |
| `start` | `{ year, month }` | no (defaults sensibly) | month is 1–12; `month > 7` makes year 0 partial |
| `superAccounts`, `pensions`, `definedBenefits`, `employers`, `novatedLeases`, `gifts`, `heas`, `keyDates`, `implementation` | arrays/objects | no | each defaults to `[]`/`{}`/absent if omitted |

### `assets` (required, array, may be empty)
Each: `{ id, name, include, owner: "client"|"partner"|"joint", distributions: "reinvest"|"cash", balance, allocation, icrPct, cgtAsset, costBase }`.
`allocation` is `{ mode: "profile", profile: <name in profiles.js> }` or
`{ mode: "custom", incomePct, growthPct, frankingPct, volBasis }`.

### `cashflows` (required)
`{ income, expenses, contributions, withdrawals, lumpSums }` — **all five
arrays must be present** (may be `[]`); `deductions`,
`superContributions`, `superWithdrawals`, `superRollovers`,
`bondContributions` are optional. Every row shares the timing shape:
`{ fromAge, toAge, frequency: "monthly"|"annual"|"once", amount, indexed
(or indexBasis) }`.

### `liabilities`, `properties`, `goals`, `bonds` (all optional, default `[]`)
Each row shape mirrors what the fact-find UI collects — see
`planState.js`'s `clampLiability`/`clampProperty`/`clampGoal`/`clampBond`
for the authoritative field list; nothing here is engine-specific.

### `assumptions` (required, minimally `{ cpi }`)
| Field | Default if omitted | Meaning |
|---|---|---|
| `cpi` | **none — required** | annual CPI, e.g. `0.025` |
| `bracketMode` | `"indexed"` | `"indexed"` = tax brackets held constant in REAL terms (the statutory default); `"frozen"` = nominal brackets frozen, so real thresholds shrink |
| `mortgageRate` | `0.06` | |
| `awote` | `0.032` | indexes super/ETP/redundancy caps only |
| `wageGrowth` | `0.027` | indexes income/expense/property/pension/goal rows using the `"awote"`-labelled basis, and HELP |
| `fhsssEarningsRate` | `0.0743` | |

### `settings` (optional)
`{ surplus: { periods: [...] }, fundingOrder: [assetId, ...], deficit: { minimumBalances, sellRule } }`.
Missing entirely is fine — `fundingOrder` defaults from `assets`.

### `display` (optional)
`{ units: "real" | "nominal" }` — a UI display concern only; the engine
itself always computes and returns real-terms figures regardless of this
flag (see §3, "real terms throughout").

---

## 3. Conventions that will surprise a consumer

Drawn from this project's own locked conventions (`CLAUDE.md`) and
`docs/reference/assumptions-provenance.md` — read those for the full
detail; this is the short, consumer-facing version of the parts most
likely to produce a subtly wrong number if assumed otherwise.

- **Real terms throughout the engine.** Every dollar figure `runProjection`
  returns is in today's (start-of-projection) dollars. Nominal is a
  display-time scaling this API does not perform (see §2).
- **Ages tick on 1 July, not the birthday.** `plan.client.currentAge`
  advances once per FY regardless of the actual DOB; DOB (when supplied)
  is used only for life-expectancy lookups.
- **Annual and one-off cashflows fire in July** and are **skipped
  entirely** in a partial first year that starts after July (no
  catch-up, no pro-rating) — monthly rows still run every month in range.
- **Growth precedes cashflow within a month** — a contribution or
  withdrawal posted mid-month earns no partial-month return that month.
- **Tax timing:** income tax (PAYG-style) accrues across the FY's income
  months; CGT, Division 293 and Division 296 are paid in **July of the
  FOLLOWING FY** (`t+1`) — the final projection year's CGT/Div293/Div296
  surfaces only as an *accrued* liability (`accruedCgtAtEnd` etc., §4),
  never actually paid within the projection.
- **Explicit withdrawals do not cascade.** A withdrawal targeting a
  specific asset draws down only that asset; if the balance is
  insufficient the shortfall is recorded as unfunded, it is never
  redirected to a different asset. (Household surplus/deficit funding —
  a separate mechanism — DOES follow `settings.fundingOrder`.)
- **Balances floor at zero** — nothing goes negative; a deficit that can't
  be funded from any source in `fundingOrder` is recorded (`unfundedCashflow`)
  rather than silently borrowed.
- **Liabilities amortise in nominal terms**, then get deflated back to
  real for the ledger — loan interest/principal splits are computed on the
  actual nominal repayment schedule, not a real-terms approximation.

---

## 4. Output reference

`ProjectionResult` — the object `runProjection` returns. Two shapes only:

**Invalid input** → `{ engineVersion, figuresAsAt, errors: [{field, message}, ...] }` — no other field. See `engine.js`'s `validateInput`.

**Valid input** → `{ engineVersion, figuresAsAt, errors: [], ...everything below }`.

### Envelope
| Field | Type | Meaning |
|---|---|---|
| `engineVersion` | string (semver) | this result contract's version — see §5 |
| `figuresAsAt` | string | the period the embedded rate/threshold figures were last verified against, e.g. `"2026-08"` |
| `errors` | array | empty on success |

### Summary fields (whole-of-projection)
| Field | Type | Meaning |
|---|---|---|
| `schedule` | object | the resolved monthly schedule (ages, FY boundaries, per-row monthly flow series) `buildSchedules()` produced — internal detail, stable but not itself documented field-by-field here |
| `monthly` | `{ combined, perAsset, wca }` | month-by-month `Float64Array` balance series, real dollars |
| `shortfall` | `{ fyLabel, ... }` \| `null` | the FIRST FY (if any) a required cashflow went entirely unfunded across the whole projection |
| `accruedCgtAtEnd` | number | CGT on unrealised gains as at the projection's last day — never actually paid within the projection (see §3) |
| `accruedBondTaxAtEnd` | number | investment-bond internal tax accrued but not yet paid |
| `accruedUntaxedSuperTaxAtEnd` | number | tax on untaxed super elements accrued but not yet paid |
| `accruedDiv293AtEnd` / `accruedDiv296AtEnd` | number | as `accruedCgtAtEnd`, for Division 293/296 |
| `accruedRefundAtEnd` | number | a pending PAYG refund/balancing amount not yet settled |
| `superWarnings` / `propertyWarnings` / `drawdownWarnings` / `bondWarnings` | array | non-fatal conditions the engine flagged while running (e.g. a contribution cap breach, a rejected FHSSS request) — always present, may be empty |
| `liabilityRepaymentStats` | object | extra-repayment interest/time-saved figures, keyed by liability id |
| `liabilityRollovers` | object | fixed-rate rollover events, keyed by liability id |
| `goalStats` | object | achievement/shortfall detail per goal, keyed by goal id |
| `wealthCrossoverYear` | number \| `null` | the first plan year (if any) investment income exceeds expenses |

### `yearly[y]` — the per-year ledger row

One row per plan year, in order. **All dollar fields are real (today's)
dollars.** Fields marked "keyed" are objects keyed by the relevant id,
present (possibly `{}`) even when nothing of that kind exists in the plan.

**Identity & headline**
`fyLabel` (string), `clientAge`/`partnerAge` (number, partner `null` if
single), `openingBalance`/`closingBalance` (combined financial-asset
balance), `netAssets` (`closingBalance + propertyClosing + superClosing +
pensionClosing + bondsClosing + wcaClosing − liabilitiesClosing −
heasDetail.closing`), `income`, `cashDistributions`, `expenses`, `tax`.

**Cashflow mechanics**
`surplusOrDeficit`, `surplusInvested`, `surplusSpent`, `surplusAccumulated`,
`deficitFundedFromAssets`, `unfundedCashflow`, `contributions`,
`withdrawals`, `oneOffsNet`, `growth`, `adjustments` (array), `termination`
(array — redundancy/ETP events this FY), `giftsPaid`.

**Per-asset** — `perAssetDetail` (keyed by asset id): `{ opening,
contributions, withdrawals, oneOffs, deficitFunding, surplusInvested,
growth, closing, costBasePool }` (`costBasePool` is `null` for a
non-CGT/lifestyle asset). `perAssetClosing` (keyed by asset id, closing
balance only).

**Tax** — `taxDetail`: `{ client, partner, incomeTax, cgt, div293, div296,
divTaxReleasedFromSuper, divTaxFromCash, refundSettled, frankingCredits,
netCapitalGain, helpRepayment, medicareLevySurcharge, fhsssRelease,
fbtPayable, reportableFringeBenefits }`. `client`/`partner` (`null` for a
single household's partner) each carry the FULL per-person assessment:
`quarantinedLossCarry, taxableIncome, grossTax, medicare, lito,
excessCcOffset, excessConcessionalContributions, incomeTax,
netCapitalGain, cgt, div293, div296, divTaxPaidFrom, divTaxReleasedFromSuper,
divTaxFromCash, frankingCredits, paygWithheld, helpWithheld, mlsWithheld,
actualTaxPayable, refundOrBalancing, refundSettled, helpRepayment,
helpBalanceClosing, medicareLevySurcharge, fhsssRelease,
fhsssTaxableComponent, fhsssTaxFreeComponent, fhsssOffset,
taxablePensionComponent, ttrPensionOffset`.

**Liabilities** — `liabilities` (keyed by liability id — **also keyed by
the synthetic ids `help_client`/`help_partner`** for a person with a HELP
balance; a consumer must iterate `Object.keys(row.liabilities)`, never a
liability array from the input, or the synthetic HELP debt is silently
dropped): `{ opening, interest, principal, drawdown, offsetApplied,
closing, extraRepayment, surplusRepayment, indexation, ratePct,
investmentBalance, privateBalance }`. `liabilitiesClosing` (total).

**Super** — `superDetail` (keyed by super account id, only for accounts
that exist): `{ opening, contributions, contributionsTax, sg,
salarySacrifice, personalDeductible, nonConcessional, govSuperInflow,
concessionalNet, contributionSplitOut, contributionSplitIn,
insurancePremium, earnings, earningsTax, withdrawals, release,
fhsssRelease, adviserFee, surplusSalarySacrifice,
surplusPersonalDeductible, rolloverOut, rolloverIn, rolloverTax, closing,
taxFreeClosing }`. `superClosing` (total). `superCapUsage`:
`{ client, partner }`, each `null` or `{ cap, carryForwardAvailable, sg,
salarySacrifice, personalDeductible, available }`.

**Pensions** — `pensionDetail` (keyed by pension id, only if any exist):
`{ opening, commencementAmount, earnings, earningsTax, payments,
paymentsTaxFree, paymentsTaxable, commutations, closing, taxFreeClosing,
taxFreeProportion, grandfatheredDeductibleIncome,
grandfatheredDeemingExempt }`. `pensionClosing` (total). `transferBalance`:
`{ client: { balance, personalCap, remainingCap }, partner? }`.
`definedBenefitDetail` (keyed by DB id, only if any exist): `{ grossPension,
taxFreeAmount, untaxedAssessable, dbIncomeCapExcess, tax }`.

**Bonds** — `bondDetail` (keyed by bond id, only if any exist): `{ opening,
contributions, earnings, internalTax, withdrawals, assessableWithdrawal,
educationWithdrawal, educationBenefit, closing, costBase, yearsToMaturity,
contributionHeadroom }`. `bondsClosing` (total).

**Property** — `properties` (keyed by property id): `{ value, rent,
expenses, depreciation, settlement, costBaseSeed, fhsssRelease, lmi,
deposit, duty, costs, fhog, landTax, saleProceeds, saleGain, saleValue,
usableEquity }`. `propertySaleProceeds`, `propertyClosing`.

**Goals** — `goals` (keyed by goal id): `{ contribution,
surplusContribution }`.

**FHSSS** — `fhsssDetail`: `{ client, partner }`, each `null` or
`{ contributionAccepted, contributionRejected, earningsAccrued,
concessionalBalance, nonConcessionalBalance, earningsBalance,
lifetimeContributed }`.

**Age pension / CSHC / HEAS** — `agePensionDetail` (object; the module's
own comment notes its `null` initializer is defensive only — the
assessment that fills it runs unconditionally every year): `{ homeowner,
deprivedAssets, assessableAssets,
assetsTestResult, deemedIncome, otherIncome, assessableIncome,
incomeTestResult, bindingTest, entitlement, grandfatheredDeductibleIncome,
grandfatheredDeemingExempt, dbAssessableIncome, client, partner }`, where
`client`/`partner` are `{ ageEligible, eligible, paid, workBonusExempt,
workBonusBank }` (`partner` is `null` for a single household).
`cshcDetail` (object): `{ threshold, adjustedTaxableIncome, deemedIncome,
grandfatheredDeductibleIncome, assessableIncome, margin, client, partner }`
where `client`/`partner` are `{ ageEligible, eligible }`. `heasDetail`
(object, always present — every field is `0` with no Home Equity Access
Scheme in the plan): `{ opening, interest, drawn, mla, securityValue,
closing }`.

**Working Cash Account** — `wcaDetail`: `{ opening, interest, netFlow,
sweptToCash, sweptInvested, sweptSpent, closing }`. `wcaClosing`.

**Adviser fees** — `adviserFeesUpfront` / `adviserFeesOngoing`:
`{ outsideCash, requestedFromSuper, paidFromSuper }`.

**Death benefits** — `deathBenefitDetail`: `null` on every row **except
the final projection year**, where it becomes `{ client, partner }` (each
`null` or the death-benefit tax breakdown for that person's terminal
super/pension balances).

**Always-present but currently unused** — `fees`: always `null` (reserved).

---

## 5. Versioning

`ENGINE_VERSION` (`engine.js`) is this result contract's own semantic
version — independent of `planState.js`'s `SCHEMA_VERSION`, which versions
the STORED INPUT (the plan state schema; currently 18). Rule:

- **Major** — a result field is removed or renamed, or an existing field's
  type/meaning changes. Breaking.
- **Minor** — a new field is added, nothing existing changes shape.
- **Patch or none** — internal behaviour/bug fixes that change VALUES but
  not the shape.

| Version | Change |
|---|---|
| `1.0.0` | Initial published contract (spec 31, Commit 1). |

Any commit that changes the result shape must update `ENGINE_VERSION`,
this table, and the Commit 4 contract-shape snapshot in the SAME commit
— see `CLAUDE.md`.

---

## 6. The assumptions you inherit

Every figure this engine uses that isn't a hard legislated fact — CMA
profile returns, CPI/wage-growth defaults, super/ETP/redundancy caps,
stamp duty and LMI tables, the age pension thresholds, and so on — is
this firm's own house view or a researched/derived figure, documented
with its source and confidence in
**`docs/reference/assumptions-provenance.md`**. A consumer displaying
these numbers in another document is adopting this firm's assumptions,
not a neutral or universal set, and should say so to whoever reads that
document — the same way this app's own output surfaces its assumptions
in the Assumptions view rather than presenting bare numbers.

---

## 7. JSON serialisation

`ProjectionResult` is JSON-safe end to end: `JSON.parse(JSON.stringify(result))`
deep-equals `result` for a real populated scenario — verified directly, not
assumed (`engine.test.js`, Commit 3). The one thing this actually required:
deterministic.js uses `Float64Array` internally throughout `schedule` and
`monthly` for performance, and `JSON.stringify` does **not** turn a typed
array into a JSON array — it serialises to an object keyed by string
indices (`{"0":1.5,"1":2.5,...}`), which is silently wrong for a consumer
expecting an array back. `runProjection` converts every typed array in the
result to a plain `Array` before returning (`engine.js`'s `toJSONSafe`) —
field names and nesting are unchanged, only the concrete JS type of
array-like leaves. No field anywhere in a real result contains a function,
an `undefined` value, or a circular reference.

The **input** already had this guarantee — `planState.js`'s
`serialize(state)`/`hydrate(json, profiles)` are this app's own export/
import path, and are exactly what "construct a client from JSON" (§9)
uses. `hydrate` takes the JSON **string** (it calls `JSON.parse` itself),
not a pre-parsed object.

## 8. Stable identifiers

Every asset, liability, property, goal, bond, super account, pension and
cashflow row carries an `id` (a short string, e.g. `"as-mtd3okej-4-fm56"`)
that is stable across a save/load round-trip — `serialize`/`hydrate`
preserve every id unchanged, verified directly (`engine.test.js`, Commit
3: the same ids appear as `superDetail`/`liabilities`/`perAssetDetail`
keys in the result both before and after a state round-trips through
`serialize`/`hydrate`). A consumer correlating rows across two separate
`runProjection` calls (e.g. a "before" and "after" comparison, or a
re-run after the client's data changes) can rely on an id continuing to
identify the same underlying row, as long as the input it constructed
that id from is itself unchanged. The one exception: a HELP/HECS debt is
represented in the output only, as the synthetic id `help_client` /
`help_partner` (§4, "Liabilities") — it has no corresponding row in the
input's own `liabilities` array at all, so it is stable by construction
(derived from a fixed template, not a stored id) rather than by the
save/load guarantee.

## 9. Worked integration example

The scenario a document-generation consumer actually has: a client
exported from this app (or another system) as JSON, which it needs to
turn into the figures its own house-format document expects — the
firm's own row vocabulary (`cashflowStatement.js`) and the Snapshot
view's multi-year table (`snapshot.js`), the same two things this app's
own Cashflow table and Snapshot page are built from. This example runs
as a live test (`engine.test.js`, `describe("worked integration example")`)
so these figures cannot silently drift from what's printed here.

```js
import { runProjection } from "./src/engine.js";
import { serialize, hydrate } from "./src/planState.js";
import { cashflowStatement } from "./src/cashflowStatement.js";
import { buildSnapshotColumns, buildSnapshotTable } from "./src/snapshot.js";

// 1. "Construct a client from JSON" — exactly this app's own export/
//    import path (a couple, income, expenses, a liability).
const json = serialize(someClientState);
const state = hydrate(json, PROFILES);

// 2. Run the projection through the public API.
const result = runProjection(state);

// 3. Read the figures a document generator needs, for one FY — the
//    firm's own row vocabulary. ctx mirrors what main.js's own
//    Cashflow/Snapshot views already build (see engine-api.md §4's
//    `schedule.rowTotals`).
const y = 0;
const rt = result.schedule.rowTotals;
const ctx = {
  incomeRows: state.cashflows.income, rowTotalsIncome: rt.income,
  expenseRows: state.cashflows.expenses, rowTotalsExpenses: rt.expenses,
  deductionRows: state.cashflows.deductions ?? [], rowTotalsDeductions: rt.deductions,
  properties: state.properties ?? [], liabilities: state.liabilities ?? [],
  superAccounts: state.plan.superAccounts ?? [], y,
  educationBlocks: [], rowTotalsEducation: rt.education,
};
const statement = cashflowStatement(result.yearly[y], ctx, null); // null = household
```

For the "Family with a mortgage" demo client (`src/demo/familyWithMortgage.js`),
FY2026–27's household statement is —

```
assessable.total: 238616    deductions.total: 0        taxableIncome: 238616
tax.total: 60487             netIncome: 178129           cashReceived.total: 178468
expenses.total: 119016       surplusIncome: 59453
```

`assessable`/`deductions`/`tax`/`cashReceived`/`expenses` are each a
**breakdown object** (every category the firm's template shows as its own
row — salary, franking credits, mortgage repayments, and so on) with a
`.total` field; `taxableIncome`, `netIncome`, and `surplusIncome` are
plain numbers, each the difference the spec's own vocabulary names:
`taxableIncome = assessable.total − deductions.total`; `netIncome =
taxableIncome − tax.total`; `surplusIncome = cashReceived.total −
expenses.total`.

For a MULTI-year table matching the Snapshot page exactly,
`buildSnapshotColumns(result.yearly, ctxFor, [0, 1, 2], couple)` (one
column per requested plan-year index) then `buildSnapshotTable(columns)`
→ `{ rows: [{ section, label, total, cells: [...] }] }`, one row per
non-empty line in the firm's own template (17 rows survive
`hideEmptyRows` for this client — the SURPLUS INCOME row's household
total across the first three years is `[59453, 63055, 62069]`).
`cashflowStatement`'s optional third argument (`"client"` / `"partner"` /
`null`) also supports a per-person breakdown — see the module's own
header comment for the owner-attribution rules it applies (a jointly-
owned item splits 50/50).

## 10. What the engine does not model

The current, authoritative list is `docs/reference/build-log.md`'s own
"Deferred — do not build" and "PARKED AND OPEN ITEMS" sections — read
those for the full, maintained list (this document does not duplicate it,
to avoid the two drifting apart). The items most likely to matter to a
document-generation consumer specifically:

- **Aged care** (residential/home care fees, means testing, RAD/DAP) —
  not built at all yet (spec 29, blocked pending sourced rate figures).
- Trust distributions, foreign income, SAPTO, Family Tax Benefit and
  childcare/CCS — still emit as zero rows to preserve the worked
  document's table shape, never actually computed.
- Property SALE with CGT is not modelled as a decision the engine can
  simulate choosing (a property purchase, and disposal-outside-the-
  engine cost-base handling, are — see the property fields in §4).
- Monte Carlo / stochastic simulation is not exposed through this public
  API at all (deferred — see `Workflow`/`sim.js`; add it if a consumer
  needs it).
- Backward-compatibility shims for an old result version — a consumer
  pins the `engineVersion` it was built against.
