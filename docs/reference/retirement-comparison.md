# Retirement projection comparison record

Spec: `docs/specs/33-retirement-standalone.md`, Commit 4. Fixture:
`src/demo/retirementComparison.js` (verified in
`src/demo/retirementComparison.test.js`).

**Purpose.** The firm holds a second retirement projection tool. This
document gives one client, built the same way in both tools, so a
comparison produces a specific list of differences rather than a vague
"ours feels different." Fill in the "Other tool" and "Which is right and
why" columns during the session — this document is written so that can
happen live, not be reconstructed afterwards.

## The client

Single, mid-forties, retiring at 65. Every field below except "Living
expenses" (see its own note) is one of the standalone retirement page's
own nine inputs — enter these into the other tool exactly as written.

| Field | Value |
|---|---|
| Household | Single |
| Date of birth | 15 June 1981 (age 45 as at 15 July 2026, this document's own "as at" date) |
| Retirement age | 65 |
| Current super balance | $150,000 |
| Super risk profile | Balanced (this firm's CMA: 5.9% p.a. nominal gross return, before fees) |
| Salary | $90,000 p.a. |
| Concessional contributions beyond SG | $0 |
| Other investments — lump sum | $30,000 |
| Other investments — risk profile | Balanced |
| Income required | ASFA Comfortable (single, homeowner) — $55,923/yr as at March 2026 |
| Include age pension | Yes |

**Living expenses — $52,000 p.a. (indexed to CPI), NOT one of the
standalone page's own nine fields.** That page collects no expense
input at all; this figure was entered directly in the comprehensive
workspace against the same underlying scenario. No retirement
comparison is meaningful without a living-expense figure (it is what
actually drives pre-retirement saving capacity and, alongside Income
Required, what a drawdown strategy targets), so give the other tool
this same figure even though it does not correspond to a field on our
own standalone page.

**As-at date: 15 July 2026.** The fixture is pinned to this date (not
"whenever this document is read") so the figures below stay reproducible
— see `src/demo/retirementComparison.js`'s own header for why the date
is pinned to July specifically (a mechanical detail of this engine's own
annual-cashflow timing, not a modelling choice worth replicating in the
other tool).

## Our outputs

Figures below are `computeRetirementAnalytics`'s own output, run
directly against the fixture above — asserted byte-for-byte in
`src/demo/retirementComparison.test.js`, so this table can never quietly
drift from what the engine actually computes.

| Figure | Our figure | Other tool | Which is right, and why |
|---|---|---|---|
| Retirement age | 65 | | |
| Capital at retirement | $996,422 | | |
| First shortfall age | None — never occurs | | |
| Super/pension exhaustion age | None — see note below | | |
| Life expectancy (used for the figures below) | Age 83 | | |
| Capital at life expectancy | $674,162 | | |
| Average retirement income to life expectancy | $54,346/yr | | |
| Average age pension to life expectancy | $19,859/yr (35.9% of income) | | |
| Sustainable income to life expectancy | $41,306/yr | | |

**"Life expectancy" and "life expectancy + 5" coincide at age 83 for
this fixture** (both resolve to the same figure: sustainable income to
LE+5 is also $41,306/yr) — the projection's own end age is itself set
by life expectancy with no offset, so LE+5 clamps back to the same last
available year rather than genuinely projecting five years further.
Not a material-LE-difference finding; a mechanical consequence of this
fixture's own end-date setting, not shown as a separate row above.

**"Super/pension exhaustion age: none"** does not mean the pension
lasts forever — it draws down from ~$447,000 at commencement (age 65)
to fully exhausted by the late 70s, a genuine multi-decade drawdown
story. The combined super+pension balance never reaches exactly zero
because a small residual balance is left behind in the original super
account at pension commencement (this engine's own known, disclosed
mechanic — see `computeRetirementAnalytics`'s own
`superPensionExhaustionAge` header) and continues earning investment
returns on its own. As the pension itself depletes, the age pension
rises to make up the difference (visible directly in the year-by-year
table on the standalone page) — the household's own income stays
intact throughout via that substitution, which is the reason "no
shortfall" and "pension exhausted by the late 70s" are both true at
once.

**Every one of tax, age pension, and drawdown genuinely bites in this
fixture** (the spec's own requirement for Commit 4): real income tax is
paid throughout the working years (~$19,000–21,000/yr on the $90,000
salary); the age pension supplies over a third of average retirement
income and grows as the pension itself depletes; the pension balance
draws down from ~$447,000 to zero over roughly twelve years. None of
these are token amounts.

## Differences we already expect

Stated before any comparison is run, as predictions rather than
excuses. When the comparison happens, differences are findings, not
verdicts — some will be ours.

- **We model real tax; a simpler tool may apply a flat rate.** Our
  $19,000–21,000/yr working-years tax figure reflects actual resident
  marginal brackets, Medicare levy, and LITO on a $90,000 salary — a
  flat-rate estimate would land at a different number even given
  identical income.
- **We model the age pension with means testing (assets test, income
  test, deeming); the comparison tool may not model it at all.** If it
  doesn't, expect its own "average retirement income" figure to sit
  roughly $19,859/yr (35.9%) below ours for the same household — that
  gap IS the age pension, not a disagreement about anything else.
- **We work in real terms with nominal as display; conventions may
  differ.** Every figure in this document is real (today's) dollars.
  If the other tool's own default output is nominal, either convert
  before comparing or note the mismatch explicitly per line — comparing
  a real figure against a nominal one three decades out will look like
  a large disagreement that isn't actually one.
- **Our SG follows the current statutory rate; check theirs.** SG
  contributions accrue automatically from the salary row at this
  engine's own current statutory percentage — confirm the other tool
  uses the same rate for the same projection years (SG is legislated to
  keep stepping up), not a rate frozen at whatever value it shipped
  with.
- **Our deterministic projection sits above the Monte Carlo median by
  roughly σ²/2 per year — relevant if the other tool's returns are
  geometric means.** This fixture's own figures are the deterministic
  (arithmetic-mean-return) case, not a stochastic median; if the other
  tool quotes a Monte Carlo median outcome, expect ours to run
  materially higher over a multi-decade projection purely from that
  convention difference, independent of any other modelling choice.
