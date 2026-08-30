# Demo coverage — which client shows which view

The presenter's map: for every output view, the single client/scenario
that shows it best (real, non-trivial data — not just "technically
non-empty"). Enforced by `src/demo/coverage.test.js`, which asserts every
`router.js` `OUTPUT_VIEWS` id has at least one populating demo client/
scenario and fails, naming the view, if a future change breaks that. Run
`DEMO_COVERAGE_VERBOSE=1 npx vitest run src/demo/coverage.test.js` to see
every scenario that populates a given view, not just the one picked below.

See `docs/reference/demo-clients.md` for the full client descriptions and
the suggested walkthrough order.

## Output

| View | Best client — scenario | Why |
|---|---|---|
| Projection | First home buyer — Current | Smallest, cleanest state for a first look |
| Cashflow | Family with a mortgage — Current | MLS, land tax, salary packaging, education all in one household |
| Assets | Comprehensive pre-retiree — Current | Savings + two large, deliberately asymmetric super balances |
| Liabilities | Family with a mortgage — Current | Fixed/variable split loan (rollover mid-projection) + a negatively geared investment loan |
| Bonds | Comprehensive pre-retiree — Current | The only client with a bond (education-type) |
| Super | Comprehensive pre-retiree — Current | $3.2m/$420k asymmetric balances either side of the carry-forward threshold |
| Pension | Modest retiree — Current | Both partners' pensions active and drawing from day one |
| Aged care | Comprehensive pre-retiree — Current | The only client with an aged care entry (fires at 88) |
| Age pension | Modest retiree — Current | Near-full pension — the age pension actually binding, not a token/zero amount |
| Death benefits | Comprehensive pre-retiree — Current | The only client with death benefit nominations for both |
| Tax | Comprehensive pre-retiree — Current | Division 293 AND 296 both visible in the same household |
| Net worth | Comprehensive pre-retiree — Current | Property, super, bond, and the aged care cost all move the trajectory |
| Allocation | Family with a mortgage — Current | Multiple assets across both owners plus a joint one |
| Snapshot | Family with a mortgage — Current | The richest Cash Flow SOA row set of the four (children, property, packaging) |
| Assumptions | First home buyer — Current | Any client shows the same assumption set — the simplest is clearest |

## Focus

| View | Best client — scenario | Why |
|---|---|---|
| Deposit & home purchase | First home buyer — Buy 2030 | The purpose-built scenario for this exact view |
| FHSSS | First home buyer — Buy 2030 with FHSSS | The purpose-built scenario for this exact view |
| Salary sacrifice | Family with a mortgage — Salary sacrifice $15k each | Both partners sacrificing at once, clean before/after |
| Debt payoff | Family with a mortgage — Extra repayments $1k/mo | The purpose-built scenario for this exact view |
| Stamp duty & LMI | First home buyer — Buy 2030 | A real purchase in progress to size the lookup against |
| Usable equity | Comprehensive pre-retiree — Current | The richest property + asset base to draw equity from |
| Transfer schedule | Family with a mortgage — Current | A genuinely funded household with real monthly flows |
| Surplus allocation | Family with a mortgage — Current | Three liabilities with mixed deductibility — the most interesting routing choice |
| Main residence exemption | Modest retiree — Current | A single, long-held family home |
| Age pension strategy | Modest retiree — Current | The pension actually binds, so gift/work-income levers visibly move it |
| Death benefits | Comprehensive pre-retiree — Current | The only client with real nominations to compare |
| Approach comparison (static vs. real engine) | Family with a mortgage — Current | `docs/reference/divergence-analysis.md`'s own Scenario 2 is exactly this client |
| Aged care accommodation | Comprehensive pre-retiree — Current | The one client for whom an aged care decision is a real, relevant question |
| Aged care planning (pre-entry) | Comprehensive pre-retiree — Current | The only client with a real aged care entry to plan against |
| Debt recycling | Family with a mortgage — Debt recycling | The purpose-built scenario for this exact view |
| Education funding | Family with a mortgage — Current | The only client with school-age children |

## What if

| View | Best client — scenario | Why |
|---|---|---|
| Monte Carlo (fan chart / percentile table) | Comprehensive pre-retiree — Current | The richest, most complex simulation of the four |
| Interest rate shocks | Family with a mortgage — Current | A fixed/variable mix makes the shock's own mechanics visible |
| Market crash timing | Comprehensive pre-retiree — Current | The largest asset/super base — a crash is most visible here |
| Income interruption | Family with a mortgage — Current | Two incomes, MLS threshold effects if one stops |
| Expense shock | Family with a mortgage — Current | Education and living costs both present to shock |

## Reading this table

Most rows point at "Comprehensive pre-retiree" or "Family with a
mortgage" — expected, since those two are deliberately the densest
clients in the set (per `docs/reference/demo-clients.md`). "First home
buyer" and "Modest retiree" each still own several rows outright — the
views that are specifically THEIRS (FHSSS, the deposit solver, the age
pension actually binding, deeming/Work Bonus/gift deprivation) are not
shown anywhere else in the set, by design.
