# Demo clients

Three committed fixtures under `src/demo/`, loadable from the Clients page
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

Every scenario is anchored to whatever day it's loaded, not a fixed
calendar date — plan year 0 is therefore almost always a partial FY (no
July), which is why every income/expense/contribution row here uses
monthly, not annual, frequency (an annual-frequency row fires once, in
July — see `schedule.js`'s `applyRegular` — and would silently contribute
nothing in year one otherwise).

## First home buyer

Single, 29, salary $110k, $28k HELP debt, $35k savings, renting. Exercises
HELP repayment, FHSSS, the purchase engine, stamp duty, LMI/First Home
Guarantee, and the Focus deposit/FHSSS views.

- **Current** — no purchase; HELP repayment draws the balance down over the
  projection.
- **Buy 2030** — plans a $650k purchase at age 33, 95% LVR. First Home
  Guarantee waives LMI at this LVR (a genuine feature of the purchase, not
  asserted around).
- **Buy 2030 with FHSSS** — same purchase, but voluntary super
  contributions from now until settlement are flagged FHSSS-eligible and
  released at purchase, with deemed earnings accrued in the meantime.

## Family with a mortgage

Couple, mid-30s (35/34), two children, an $850k mortgage split fixed/
variable, private school fees from age 12, combined income $260k.
Exercises couple tax, dependent children and education funding, the
fixed-rate rollover, salary sacrifice, and the Medicare Levy Surcharge
family threshold (no private cover, income above it).

- **Current** — the mortgage's fixed portion ($500k) rolls to variable
  partway through the projection; education fees begin once the elder
  child reaches school age; the household's MLS applies throughout.
- **Salary sacrifice $15k each** — both partners sacrifice $15k/year;
  take-home pay drops relative to Current in the year it's paid.
- **Extra repayments $1k/mo** — an extra $1,000/month against the variable
  portion pays it off ahead of its scheduled amortisation.

## High earner pre-retirement

Couple, early 50s (52/50), ~$450k combined income, a negatively geared
investment property, and large but deliberately asymmetric super balances
($650k client / $380k partner) either side of the $500k total-super-balance
carry-forward eligibility threshold. Exercises Division 293, carry-forward
(available to the partner, not the client — the engine's own eligibility
rule doing the work, not the demo), negative gearing, an income-interruption
what-if, and retirement drawdown.

- **Current** — Division 293 applies from the first full year; the
  investment property's rent doesn't cover interest + expenses (the point
  of the negative gearing).
- **Maximise concessional** — both max out their concessional cap
  (including the partner's carry-forward); household taxable income falls
  relative to Current.
- **Reduce work at 58** — both partners stop working at 58/56, well
  short of either person's own super access age of 65, with a
  retirement lifestyle spending step-up. Genuinely unaffordable, not
  merely labelled so: only the investment property's net rental remains
  against the higher spend, the $150k joint savings buffer runs dry
  within about a year, and the household goes without for years before
  either super balance becomes accessible. Marked affordable: false and
  asserted to actually produce unfunded cashflow — the one scenario in
  this demo set meant to show a plan that doesn't hold up.

## Suggested walkthrough order

1. **First home buyer** — the smallest state, good for a first look at the
   purchase engine and FHSSS without couple-tax noise.
2. **Family with a mortgage** — introduces couple tax, children, and the
   fixed-rate rollover.
3. **High earner pre-retirement** — the most tax-feature-dense of the
   three; best seen last once Division 293/carry-forward context from the
   other two is familiar.

## Loading

"Load demo clients" on the Clients page rebuilds all three from today's
date and writes them into the workspace exactly like a JSON client import
(it reuses `importFile`'s "client" kind wholesale). Loading never silently
overwrites: if a demo client of the same name is already in the workspace,
you're asked to Replace (delete the existing client, load fresh) or Add as
a copy (loads alongside, named `<name> (imported)`) — or Cancel.
