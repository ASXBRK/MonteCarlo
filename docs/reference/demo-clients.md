# Demo clients

Four committed fixtures under `src/demo/`, loadable from the Clients page
("Load demo clients"). Each is built through the same factories
(`createIncomeRow`, `createLiability`, `createProperty`, ...) and
`clampAllToPlan` the app itself uses — never a hand-written state object —
so a schema change breaks `src/demo/demo.test.js` at build/test time
instead of silently drifting out of sync with what the app produces.

`demo.test.js` is structural only: it checks the projection builds, holds
the conservation invariant, and that the feature each scenario exists to
exercise actually fires. It never asserts a dollar figure — when a bug is
fixed the demo numbers are supposed to move, and a snapshot assertion would
just fail (and get trained away) on every legitimate change.

`docs/reference/demo-coverage.md` is the companion map: for every output
view, which client and scenario shows it with real data. Load it in
another tab when presenting — it's the answer to "where do I click to show
X".

Every scenario is anchored to whatever day it's loaded, not a fixed
calendar date — plan year 0 is therefore almost always a partial FY (no
July), which is why every income/expense/contribution row here uses
monthly, not annual, frequency (an annual-frequency row fires once, in
July — see `schedule.js`'s `applyRegular` — and would silently contribute
nothing in year one otherwise).

Chosen as a set for coverage (`src/demo/coverage.test.js` enforces it: every
`router.js` output view must have at least one client/scenario producing
real data for it) — but each client is still a coherent, individually
plausible person first. A feature bolted onto a client with no real reason
to have it undermines a demo more than a missing view would.

## First home buyer

Single, 29, salary $110k, $28k HELP debt, $35k savings, renting. Exercises
HELP repayment, FHSSS, the purchase engine, WA's own stamp duty schedule,
LMI/First Home Guarantee, and the Focus deposit/FHSSS views.

- **Current** — no purchase; HELP repayment draws the balance down over the
  projection.
- **Buy 2030** — plans a $650k Perth (WA) purchase at age 33, 95% LVR.
  First Home Guarantee waives LMI at this LVR (a genuine feature of the
  purchase, not asserted around).
- **Buy 2030 with FHSSS** — same purchase, but voluntary super
  contributions from now until settlement are flagged FHSSS-eligible and
  released at purchase, with deemed earnings accrued in the meantime.

## Family with a mortgage

Couple, mid-30s (35/34), two children, an $850k mortgage split fixed/
variable, private school fees from age 12, combined income $260k, a
negatively geared investment property in VIC (land tax applies at an
entirely ordinary price — VIC's own threshold is low), salary packaging
through the partner's FBT-exempt employer, and a travel goal. Exercises
couple tax, dependent children and education funding, the fixed-rate
rollover, salary sacrifice/salary packaging, the Medicare Levy Surcharge
family threshold, negative gearing, goals, and debt recycling.

- **Current** — the mortgage's fixed portion ($500k) rolls to variable
  partway through the projection; education fees begin once the elder
  child reaches school age; the household's MLS applies throughout; the
  investment property throws off land tax and a deductible loss.
- **Salary sacrifice $15k each** — both partners sacrifice $15k/year;
  take-home pay drops relative to Current in the year it's paid.
- **Extra repayments $1k/mo** — an extra $1,000/month against the variable
  portion pays it off ahead of its scheduled amortisation.
- **Debt recycling** — the variable portion redraws into a separate
  investment portfolio asset as it's paid down, converting non-deductible
  debt into deductible without changing total debt.

## Comprehensive pre-retiree

Couple, 55 and 53, combined income $450k, a deliberately asymmetric large
super balance ($3.2m client / $420k partner — the client clears the $500k
total-super-balance carry-forward threshold, the partner doesn't), a
negatively geared investment property in QLD, an education bond (no
linked child — present to exercise the bond engine's own "education" tax
treatment, distinct from Family's plain investment-style property), one
defined benefit pension (the partner's, already in payment), death benefit
nominations for both, and a residential aged care entry late in the
projection. **Projected to age 95** (a fixed end age, not the default
life-expectancy basis). The single densest client in the set — Division
293 AND 296, pension phase (both TTR and a genuine retirement ABP,
deliberately kept in separate scenarios so the retirement-phase earnings
exemption's presence/absence is directly visible), the transfer balance
account, the age pension means test at a wealthy household, property sale
with CGT, bonds, defined benefits, death benefits, aged care (input,
Tables, and the pre-entry planning Focus view), and the usable-equity
Focus view.

- **Current** — both work indefinitely (a disclosed simplification — see
  the module's own header on why no retirement-age cutoff is used here);
  Division 293 and 296 both apply; the defined benefit pays from year 1;
  the aged care entry fires at the client's age 88, the partner remaining
  in the (protected) family home.
- **Maximise concessional** — both maximise concessional contributions
  (the partner's own catch-up/carry-forward genuinely available, the
  client's not); the client ALSO runs a TTR pension from 60 while still
  working — earnings inside it are taxed, unlike a genuine retirement
  pension.
- **Retire at 60** — the client actually retires at 60 (their own
  `retirementAge` overridden, which moves both the income cutoff and the
  pension's own commencement together); a real ABP, retirement-phase
  earnings exemption included, crediting the transfer balance account.
  The partner keeps working.
- **Sell the investment property at 65** — the property sale fires at the
  client's age 65: a real capital gain, loan discharge, and net proceeds
  landing in Savings.

## Modest retiree

Couple, 70 and 68, ~$420k combined super already in pension phase (both
drawing the minimum), own their home outright, $25k savings, and a small
casual income for the partner. Exercises the age pension where it
actually binds (near-full, not the token/zero amount the wealthier demo
clients see), deeming, the Work Bonus, gifting and deprivation, minimum
drawdowns, and the age pension strategy Focus view.

- **Current** — draws a near-full age pension; deeming applies against
  the super pensions and savings; the Work Bonus exempts part of the
  partner's own casual income (the client has none to exempt).
- **Gift $30k to children** — a single $30,000 gift, well above the
  $10,000/FY allowable limit: $10,000 is exempt, the remaining $20,000 is
  a deprived asset assessed under the age pension means test for five
  years from the gift's own date.
- **Downsize at 75** — sells the family home outright (CGT-exempt — a
  PPR) at 75; buying a smaller replacement is out of scope (no
  re-purchase mechanic in this engine), a disclosed simplification —
  the freed-up cash lands in Savings, now assessable where the home
  itself was fully exempt.

## Suggested walkthrough order

1. **First home buyer** — the smallest state, good for a first look at the
   purchase engine and FHSSS without couple-tax noise.
2. **Family with a mortgage** — introduces couple tax, children, the
   fixed-rate rollover, and negative gearing.
3. **Comprehensive pre-retiree** — the most feature-dense of the four;
   best seen once Division 293/carry-forward context from Family is
   already familiar, since it goes further (296, pension phase, TBC,
   aged care).
4. **Modest retiree** — closes the loop with the age pension actually
   binding, having only seen it apply at zero/near-zero on the two
   wealthier households so far.

## Loading

"Load demo clients" on the Clients page rebuilds all four from today's
date and writes them into the workspace exactly like a JSON client import
(it reuses `importFile`'s "client" kind wholesale). Loading never silently
overwrites: if a demo client of the same name is already in the workspace,
you're asked to Replace (delete the existing client, load fresh) or Add as
a copy (loads alongside, named `<name> (imported)`) — or Cancel.
