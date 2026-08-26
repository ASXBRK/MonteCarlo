// Conservation invariant (engine-correctness fix, generalized) — pure,
// no DOM/Plotly. Extracted from deterministic.test.js's "Conservation
// invariant" describe block so Monte Carlo (monteCarlo.js) can run the
// exact same check against simulated paths, not a re-typed copy of it
// (a second copy is how an invariant meant to catch drift quietly
// drifts itself). Both money-creation bugs found so far (the original
// WCA-debit gap e1eb61a fixed, and the toConcessionalCap gap
// 2867768 closed) would have failed this invariant, and nothing in the
// suite checked it before deterministic.test.js added it. A THIRD —
// an FHSSS release crediting settlement cash with the full requested
// amount regardless of whether the super account actually held that
// much — was found and fixed while extending this invariant to cover
// the Document Set's new money flows (see the FHSSS section below). A
// FOURTH — adviser fees, Division 293/296, and FHSSS each independently
// capping their own release against the SAME account's raw balance,
// so two mechanisms sharing an account in the same year could each
// believe they alone could take the full amount and together debit
// more than the account ever held — was found via THIS invariant
// again, once adviser fees (Implementation/Rates spec, Commit 2) made
// that combination common enough for randomScenario() to hit it; fixed
// by deterministic.js's reserveFromSuper, which resolves every
// same-year claim on an account in a fixed order against what's
// actually left after the earlier ones.
//
// IMPORTANT — any commit that introduces a new money flow (a new leak,
// external inflow, or transfer between two pockets of net worth) MUST
// extend randomScenario() (deterministic.test.js) to generate it AND
// extend this file to name and account for it, in the SAME commit. A
// guard that doesn't grow with the engine silently stops guarding —
// this invariant caught nothing when the Document Set landed because
// randomScenario() never generated goals, FHSSS, extra/one-off loan
// repayments, LMI, or HELP/MLS-triggering incomes. See CLAUDE.md.
//
// For every plan year (excluding the projection's final year — see
// below), the change in total net position must equal the sum of
// every NAMED source of cash entering or leaving the household —
// nothing left unaccounted:
//
//   N(y) = financial assets + super + working cash + property − liabilities
//        = out.yearly[y].netAssets (the engine's own figure)
//
//   ΔN(y) = income (incl. WCA interest — real household income — and any
//           salary-sacrifice contribution, gross: it never touches
//           `row.income`, since schedule.js/a-super-fill reduce that at
//           the source like a real payroll would, but it's still real
//           earned value, just redirected into super net of the
//           contributions tax below — omitting it here would double-
//           subtract it)
//         + growth (asset growth + super earnings + PENSION earnings —
//           spec 20, Commit 1 — all NET of fund tax; a pension's own
//           COMMENCEMENT transfer needs no term of its own, since both
//           pockets it moves between, superClosing and pensionClosing,
//           are already inside netAssets — a same-total move between
//           two already-counted pockets nets to zero by construction,
//           the same reasoning already applied to contribution
//           splitting/land tax/the PPR exemption elsewhere in this file)
//         + externalInflows (employer SG — money the household never
//           had to forgo, entering only through super)
//         − expenses
//         − tax (income tax, CGT, Div293/296, AND HELP/MLS repayments —
//           whatever `row.tax` is this FY; HELP/MLS are folded into the
//           exact same PAYG-withheld/settled cash mechanism as ordinary
//           income tax, so they need no separate subtraction — see the
//           "HELP repayment" section below for why it's still named)
//         − contributionsTax (the 15%/30% skimmed off a contribution on
//           the way into super — the one place a contribution's gross
//           cash debit and net super credit are legitimately allowed to
//           differ)
//         − liabilityInterest (the real cost of debt; ordinary principal
//           repayment, an extra/one-off repayment (Document Set Commit
//           5), and a purchase loan's drawdown are all conservation-
//           neutral the same way — see "liabilityRevaluation" below for
//           why each has to be pulled OUT of that term specifically)
//         + liabilityRevaluation (a fixed nominal debt's REAL value
//           erodes with inflation faster than cash principal repayment
//           alone explains — a real gain to net worth with no cash flow
//           behind it, the mirror image of an offset asset's CPI decay)
//         − surplusSpent (the FY-end "spend" sweep — money that leaves
//           the WCA with no asset on the other side, by design)
//         + unfundedCashflow (an outflow the ledger recorded that the
//           household couldn't actually pay — the WCA is forced back up
//           to its minimum rather than left negative (convention 11), so
//           this must be added back or the convention itself would read
//           as a leak)
//         − divReleaseFromSuper (Division 293/296 release-from-super
//           default: a real tax payment funded by a direct super-balance
//           reduction rather than cash, so it never shows up in
//           `row.tax` — sumVals(row.superDetail, "release") is the only
//           place it's recorded)
//         + propertyAcquisitionCosts (Document Set Commits 3/4 brought
//           properties into scope — see "Properties" below — duty and
//           purchase costs are a leak, an FHOG grant is an external
//           inflow; bundled into one term since neither is separately
//           reported on the row, unlike the two Document Set flows
//           extracted below)
//         + fhsssRelease − fhsssSuperDebit (Document Set Commit 3: a
//           TRANSFER, not a leak — money moves from a super account to
//           reduce a property purchase's settlement cash requirement.
//           The two sides are sourced independently (one from
//           row.properties, one from row.superDetail) and must be
//           EQUAL — asserted explicitly, not just assumed, since they
//           nets to zero here only because they're forced equal below)
//         − lmiPremium (Document Set Commit 4: a leak either way a
//           premium is financed — capitalised, it's already inside a
//           bigger loan drawdown (liabilityRevaluation's own
//           adjustment handles that side); paid at settlement, it's
//           inside settlementCash — either way the SAME −lmiPremium
//           residual falls out of the property derivation, so one term
//           covers both payment methods without an if/else)
//         − goalSpend (Document Set Commit 6: "spent at the target
//           date" is modelled as the accrual itself — every dollar
//           reported in row.goals[...].contribution has already left
//           the model, whether pulled from an asset via sell() or
//           diverted from surplus before it reaches the WCA — a leak,
//           the same shape as an ordinary expense)
//         − giftsPaid (spec 21b, Commit 2: the FULL gift amount leaves
//           household cash at its own resolved month regardless of how
//           much Centrelink counts as deprived — deprivation only
//           affects the age pension assessment, never actual net
//           worth, so the whole gift is a leak here, the same shape as
//           goalSpend just above)
//         − heasDrawn − heasInterest (spec 21b, Commit 5: HEAS lives
//           OUTSIDE row.liabilities — see deterministic.js's own header
//           on why — so its balance growth needs its own term. A
//           drawdown credits household cash (already inside `income`
//           above, folded into `inc` the same way the age pension's
//           own entitlement is) while the loan balance grows by the
//           SAME amount plus this FY's capitalised interest; row.netAssets
//           subtracts the closing balance directly. Net effect: the
//           `+drawn` cash gain is exactly cancelled by subtracting the
//           full balance growth here, leaving only `−interest` as a
//           real, cash-free loss to net worth — the mirror image of
//           liabilityRevaluation's own `+ drawdown` add-back for an
//           ordinary purchase loan, just folded into one combined term
//           here since HEAS has no separate "interest" row of its own
//           the way row.liabilities does)
//         + helpRepayment (HELP-as-liability follow-up fix: HELP/HECS
//           now lives in row.liabilities like any other debt, so its
//           balance is inside openingN/closingN and its indexation nets
//           out of liabilityRevaluation for free — see that term's own
//           comment below. But its REPAYMENT isn't like an ordinary
//           loan's principal: the cash is withheld from PAYG before it
//           ever reaches the household, already counted once as a leak
//           via `row.tax`. The dollar withheld would otherwise have
//           become take-home pay and an asset; instead it extinguishes
//           debt — a real gain `-row.tax` alone doesn't credit back, so
//           it's added back here, the same shape as `salarySacrificed`)
//
// Properties (Document Set Commits 3/4): brought into scope
// specifically to test FHSSS release and LMI, which only ever fire
// inside a property purchase event — not because general property
// economics (growth, duty, FHOG, rent, depreciation, loan drawdown)
// are newly a target of this invariant. row.propertyClosing's
// year-over-year delta covers both a purchase-year's value injection
// and ordinary capital growth of an already-purchased property
// uniformly; subtracting the financed portion (the new loan's
// drawdown) and the household's own cash contribution (settlement)
// leaves exactly "duty + costs − FHOG − FHSSS release + LMI" as a
// residual (derivable algebraically from how settlementOut itself is
// computed in deterministic.js's purchase-event block). FHSSS release
// and LMI are separately reported on the row and extracted as their
// own named terms; duty/costs/FHOG are not separately reported, so
// they stay bundled as one "propertyAcquisitionCosts" scaffolding term.
//
// CAVEAT: this only works for a PLANNED (not-yet-purchased) property,
// whose opening value is genuinely zero — an ALREADY-OWNED property
// present from day one would need its opening value subtracted in
// openingN too (below), which this formula does not do. randomScenario()
// must never generate an "owned" property for this reason.
//
// Deliberately out of scope, so the invariant stays unambiguous rather
// than merely thorough — each is its own already-tested subsystem:
//  - explicit asset/super withdrawal rows (a shortfall there is cash the
//    household simply didn't receive, not a leak — mixing it into the
//    same `unfundedCashflow` figure as the WCA top-up's shortfall would
//    make that one figure ambiguous)
//  - non-concessional contributions (a rejected excess is a separate,
//    already-tested modelling choice — Commit 2's "rejected... not
//    credited" — not a target of this invariant)
//  - the projection's final year (its CGT/Div293/Div296 assessment
//    surfaces as an accrued liability, not a cashflow — decision 13/14 —
//    so N doesn't yet reflect it; that's the documented convention, not
//    a leak)
//
// Fixed-rate rollover (Implementation/Rates spec, Commit 1) — changes
// HOW `row.liabilities[l.id].interest`/the payment are computed (the
// rate and the level payment both switch at the rollover month), but
// not WHAT is reported or what pocket it moves through: it's still the
// same interest-accrues-then-gets-paid shape, folded into the SAME
// liabilityInterest/liabilityRevaluation terms above regardless of
// whether the rate was constant for the whole projection or switched
// once. Verified, not assumed: randomScenario() (deterministic.test.js)
// generates fixed-rate liabilities with a rollover date spanning
// before/during/after the projection, and this invariant holds against
// it across hundreds of randomised runs with NO new named term —
// exactly the kind of change this file's header asks a new-money-flow
// commit to check for, even when the answer turns out to be "the
// existing terms already cover it."
//
// Age pension (spec 21a) — a genuinely NEW money flow (a government
// payment with no offsetting household outflow, the spec's own
// words), unlike every "no new term needed" case above (all of which
// are TRANSFERS between two already-counted pockets). Checked, per
// this file's own header instruction, and the answer is: still no new
// formula term — Commit 3's own tax-treatment decision (non-assessable
// income) credits the entitlement into the household's ordinary cash
// stream (deterministic.js's `inc`, the same variable schedule.income/
// cashDist/rentIncome already flow through), which lands in row.income
// exactly like any other income dollar — and row.income is ALREADY the
// `income` term above. No separate pocket, no separate leak/inflow
// name required. randomScenario() (deterministic.test.js) was extended
// with a THIRD age stratum (retireeCohort) specifically because neither
// the original age-40 start nor the pension-phase olderCohort (max
// age 66) could ever reach age pension age (67) within the 2-4 year
// sweep window — without it, this invariant would have silently never
// exercised the age pension path at all, the exact "guard that doesn't
// grow with the engine" failure this file's header warns about.
//
// Bonus destinations (spec 23, Commit 2) — a bonus can redirect its own
// after-tax amount straight to a loan/super/asset instead of ordinary
// household cash. Checked, per this file's own header instruction, and
// the answer is again: no new formula term. The bonus's GROSS amount
// always flows through row.income exactly like any other employment
// dollar (schedule.js's applyBonus never excludes it), so it's already
// inside the `income` term above regardless of destination. The
// redirect itself deliberately reuses THREE ALREADY-neutral mechanisms
// rather than inventing a fourth pocket: a loan credit adds to
// row.liabilities[*].extraRepayment (already pulled out of
// liabilityRevaluation, same as an ordinary extra repayment); a super
// credit adds to row.superDetail[*].contributions with no
// contributionsTax (a non-concessional/post-tax credit, exactly like an
// ordinary personalNonDeductible "amount" contribution, which also
// needs no term); an asset credit adds to row.perAssetDetail[*].oneOffs
// with a matching wcaBal debit (unlike a genuine lump sum, which has
// none — see "deliberately out of scope" above — this one takes real
// cash FROM the WCA, a pocket already inside netAssets, so it's a
// transfer between two already-counted pockets, not an external
// inflow). All three are WCA-funded, capped at whatever surplus that
// month's cash actually has — verified across hundreds of randomised
// runs (randomScenario() generates a bonus per person 50% of the time,
// with a destination drawn from all three types plus "none", after
// liabilities/superAccounts/assets are known) with NO new named term.
//
// Salary packaging (spec 23, Commit 3) — FBT is a genuinely NEW leak
// (real household cash, nothing coming back), unlike bonus destinations
// above. Checked, and it needs no new term either: FBT is folded
// directly into taxOutArr/row.tax (deterministic.js, the same "fires
// once, added at the FY's first month" pattern cgtDue already uses,
// deliberately OUTSIDE the paygWithheld/pendingRefund reconciliation so
// it can never be trued-up/refunded away next year) — and `tax:
// row.tax` is ALREADY a named term above, the same reason HELP/MLS
// (also folded into row.tax) need no term of their own. The packaged
// amount itself is an ordinary deduction (reduces assessable income,
// no cash movement of its own — ordinary deduction-row behaviour,
// unchanged). Verified across hundreds of randomised runs
// (randomScenario() generates an employer per person with a randomised
// fbtType/caps, plus 0-2 packaging deduction rows spanning all four
// packagingTypes) with NO new named term.
//
// Novated leases (spec 23, Commit 4) — a genuine new leak (the post-tax
// lease payment and the lease-end residual are both real household cash
// costs with nothing coming back), unlike salary packaging's FBT above.
// Checked, and it needs no new term either: both the post-tax payment
// and the residual are added directly into schedule.js's ordinary
// `expenses` array (the SAME household-wide pocket every other expense
// row already uses), so they're already covered by the `expenses: row.
// expenses` term above — no separate pocket, no separate leak name
// required. The pre-tax portion is an ordinary deduction (no cash
// movement of its own, unchanged); the FBT/reportable-fringe-benefits
// consequence reuses the SAME packagingByOwnerYear mechanism Commit 3
// already verified needs no term. Verified across hundreds of
// randomised runs (randomScenario() generates 0-1 lease per person,
// termYears spanning both sides of the one-third base-value reduction,
// both residualDestinations) with NO new named term.
//
// Loan drawdowns and dynamic deductibility (spec 24, Commit 1) — a
// drawdown moves money, it does not create it, but this needed a real
// fix, not just a check: the FIRST attempt credited the destination
// (cash/an asset) DIRECTLY (a raw wcaBal/bal mutation), reasoning
// "loan up, cash up, cancels via closingN, like a bonus-to-asset
// redirect" — WRONG, and the randomised sweep caught it immediately
// (a gap exactly equal to the drawdown amount, every run touching a
// drawdown). The two cases aren't the same shape: a bonus redirect
// moves money BETWEEN two pockets ALREADY inside closingN (WCA and the
// target), so debiting one and crediting the other cancels with no
// term. A drawdown's cash side has no such debit anywhere — the loan
// side alone is already made neutral by liabilityRevaluation's own
// "+drawdown" term (there specifically so the balance increase isn't
// misread as a free CPI gain), but that term explains ONLY the
// liability; crediting the cash/asset side with nothing debited is a
// genuine unexplained gain unless it's actually named. Fixed the same
// way HEAS's own drawdown already is (see heasDrawn's header above):
// routed through `inc` (drawdownIncomeThisMonth, deterministic.js),
// which is non-assessable (never touches acc[p].ordinary, the same
// reason the age pension's entitlement doesn't) but IS already inside
// the `income` term — an asset destination is a received-then-invested
// shape (the same cash transfers OUT of the WCA into the asset right
// after wcaBal += net, mirroring surplus-allocation's own "asset"
// target transfer). No new named term, once routed correctly — but
// this one was found by running the sweep, not by inspection, exactly
// the point of extending randomScenario() BEFORE trusting the reasoning.
//
// Debt recycling (spec 24, Commit 2) — a redraw here is EXACTLY the
// same shape as a Commit 1 drawdown (money moves into a destination
// asset, offset by the same increase to the loan balance, marked
// investment-purpose), just resolved dynamically each FY from that
// year's own principal repayment instead of a fixed user-entered
// amount — it reuses the identical drawdownIncomeThisMonth/
// drawdownAssetCredits channel, so it needs no term of its own either.
// Verified across hundreds of randomised runs (randomScenario() enables
// recycling on ~30% of generated liabilities, with a sometimes-tight
// annualCap and a sometimes-dangling destination) with NO new named term.
//
// Monte Carlo's random return shocks (Session B) touch none of the
// terms above except `row.growth`/superDetail's earnings figures
// themselves — those are accumulated from whatever return was actually
// realised that path, shock included — so this invariant should hold
// identically on a stochastic path as on a deterministic one. If it
// doesn't, the shock injection broke the engine's bookkeeping, not the
// invariant's accounting.
//
// computeYearFlows(out, y) — every NAMED term the invariant above
// reasons about, as a plain object. Extracted (Implementation/Rates
// spec, Commit 4, "Where the money went") so the net-worth-decomposition
// feature can read the SAME figures checkYearConservation asserts over,
// rather than re-deriving them a second time — "a second copy is how an
// invariant meant to catch drift quietly drifts itself" (see header).
// This is a PURE, bit-identical extraction: checkYearConservation below
// is now a thin wrapper that calls this and asserts.
//
// One deliberate change in shape, not value: the single scaffolding
// term `propertyAcquisitionCosts` (duty+costs-FHOG for a purchasing
// property, blended with ordinary organic growth for an already-owned
// one — see the header's "Properties" section) is split into two here:
//   propertyOneOffCost = -duty -costs +fhog        (zero unless a
//                         purchase actually fires this property this year)
//   propertyGrowth     = propertyAcquisitionCosts - propertyOneOffCost
//                         (whatever's left — organic growth of
//                         already-owned properties, plus any growth
//                         accrued after settlement within a purchase
//                         year itself, a disclosed simplification)
// The two sum back to exactly propertyAcquisitionCosts, so every caller
// that only wants the invariant's own `expected` figure is unaffected;
// the decomposition (below) is the only consumer that needs them apart.
export function computeYearFlows(out, y) {
  const row = out.yearly[y];
  const prev = y > 0 ? out.yearly[y - 1] : null;
  const sumVals = (obj, key) => Object.values(obj).reduce((s, v) => s + v[key], 0);
  const sumProps = (key) => Object.values(row.properties ?? {}).reduce((s, p) => s + (p[key] ?? 0), 0);

  const openingN = prev
    ? prev.netAssets
    : row.openingBalance + row.wcaDetail.opening
      + sumVals(row.superDetail, "opening") + sumVals(row.pensionDetail ?? {}, "opening")
      - sumVals(row.liabilities, "opening") - (row.heasDetail?.opening ?? 0);
  const closingN = row.netAssets;

  const superEarningsNet = sumVals(row.superDetail, "earnings") - sumVals(row.superDetail, "earningsTax");
  // Pension phase (spec 20, Commit 1) — a genuine leak, same shape as
  // superEarningsNet just above (the 15%/10% fund-tax haircut, a
  // Commit 1 placeholder — Commit 3 zero-rates an ABP in retirement
  // phase). The COMMENCEMENT transfer itself needs no term of its own:
  // both pockets (superClosing, pensionClosing) are already inside
  // netAssets, so a same-total move between them is invisible to this
  // invariant by construction — see the engine's own commencement
  // comment (deterministic.js).
  const pensionEarningsNet = sumVals(row.pensionDetail ?? {}, "earnings") - sumVals(row.pensionDetail ?? {}, "earningsTax");
  const contributionsTax = sumVals(row.superDetail, "contributionsTax");
  const sgInflow = sumVals(row.superDetail, "sg");
  // Government co-contribution + LISTO (spec 19 Commit 6) — a genuine
  // inflow FROM the government INTO super, exactly the same shape as
  // sgInflow above (money the household never had, entering only
  // through super) — the spec's own words: "a genuine inflow with no
  // household cash movement, so they are a named conservation term."
  const govSuperInflow = sumVals(row.superDetail, "govSuperInflow");
  // Insurance premiums inside super (spec 19 Commit 7) — a genuine
  // leak: money paid to an insurer, gone from the system entirely (not
  // a transfer to another pocket the way a withdrawal or a release
  // authority payment is already accounted for elsewhere).
  const superInsurancePremium = sumVals(row.superDetail, "insurancePremium");
  // Surplus/deficit allocation spec, Commit 1: a surplus allocation that
  // tops up an existing salary-sacrifice row writes into the SAME
  // `salarySacrifice` field as a genuine payroll-reduced contribution
  // (for display), but unlike the genuine case it DID pass through
  // wcaBal/row.income on its way in (a real, ordinary-cash top-up, the
  // same shape as a personalDeductible one) — so it must NOT also be
  // added back below, or the invariant double-counts it. Named
  // separately (surplusSalarySacrifice) so only the genuine, upstream-
  // reduced portion gets the add-back.
  const salarySacrificed = sumVals(row.superDetail, "salarySacrifice") - sumVals(row.superDetail, "surplusSalarySacrifice");
  const divReleaseFromSuper = sumVals(row.superDetail, "release");
  const liabilityInterest = sumVals(row.liabilities, "interest");
  // A liability's nominal balance amortises independently of CPI, but
  // its REAL value (opening/closing, both deflated by that month's
  // cumulative CPI factor) erodes faster than cash principal
  // repayment alone accounts for — the rest is inflation quietly
  // shrinking the real burden of a fixed nominal debt, a genuine gain
  // to net worth with no cash flow behind it at all (the mirror image
  // of an offset asset's cpiDecayMonthly in deterministic.js's growth
  // step). Deriving it from the engine's own opening/closing/principal
  // figures (rather than reconstructing month-by-month deflation)
  // keeps this exact regardless of the rate path. extraRepayment
  // (Document Set Commit 5) is cash-funded-vs-balance-shrinks the same
  // way ordinary principal is, so it's pulled out here too; drawdown
  // (a purchase loan settling this FY, Document Set Commits 3/4) is a
  // BRAND NEW liability appearing — not revaluation at all — added
  // back so it doesn't get misread as a free CPI gain.
  // surplusRepayment (Surplus and Deficit Allocation spec, Commit 1) is
  // cash-funded-vs-balance-shrinks the SAME way principal/extraRepayment
  // already are — a genuine transfer (WCA down, liability down by the
  // identical amount), not a free CPI gain — so it's pulled out here
  // too, same reasoning as extraRepayment's own comment above it.
  const liabilityRevaluation = sumVals(row.liabilities, "opening") - sumVals(row.liabilities, "closing")
    - sumVals(row.liabilities, "principal") - sumVals(row.liabilities, "extraRepayment")
    - sumVals(row.liabilities, "surplusRepayment")
    + sumVals(row.liabilities, "drawdown");

  // A salary-sacrifice contribution (explicit or a toConcessionalCap
  // fill of that type) never touches `row.income` — schedule.js/
  // a-super-fill reduce it upstream, at the source, the same way an
  // employer's payroll would. But the sacrificed amount is still real
  // earned value, just redirected: it reappears net-of-contributions-
  // tax in super. Add it back here so only the contributions tax
  // itself (below) is counted as the leak — otherwise this formula
  // would double-subtract it (once by excluding it from income, again
  // implicitly by not crediting where it actually landed).
  const income = row.income + row.wcaDetail.interest + salarySacrificed;
  const growth = row.growth + superEarningsNet + pensionEarningsNet + liabilityRevaluation;

  // --- Properties (Document Set Commits 3/4) — see the header derivation.
  // Property sale (spec 19 Commit 4) adds a THIRD property-shaped event
  // alongside ordinary growth and a purchase: a sale zeroes propVal,
  // which the purchase-era propertyResidual/propertyAcquisitionCosts
  // formula below (drawdown/settlementCash/fhsssRelease/lmiPremium —
  // all purchase-shaped) has no term for and would misread as a huge,
  // nonsensical "negative purchase". Adding the gross sale value BACK
  // into propertyValueDelta before that formula runs cancels the drop
  // entirely, so the REST of this year's property activity (an
  // unrelated purchase, ordinary growth on other properties) is read
  // exactly as if the sale never happened; the sale's own real effect —
  // property shrinks by its gross value, the destination asset/loan
  // payoff pocket grows by the NET proceeds, the gap between them
  // (agent fees + settlement costs) genuinely leaves the household — is
  // named explicitly as propertySaleCosts below instead.
  const propertySaleGrossValue = sumProps("saleValue");
  const propertySaleProceeds = sumProps("saleProceeds");
  const propertySaleCosts = propertySaleGrossValue - propertySaleProceeds;
  const propertyValueDelta = row.propertyClosing - (prev ? prev.propertyClosing : 0) + propertySaleGrossValue;
  const drawdown = sumVals(row.liabilities, "drawdown");
  const settlementCash = sumProps("settlement");
  const fhsssRelease = sumProps("fhsssRelease");
  const lmiPremium = sumProps("lmi");
  // = -duty -costs +fhog +fhsssRelease -lmiPremium, algebraically (see
  // header) — isolate the bundled duty/costs/FHOG scaffolding term by
  // removing the two Document Set flows this task specifically names.
  const propertyResidual = propertyValueDelta - drawdown - settlementCash;
  const propertyAcquisitionCosts = propertyResidual - fhsssRelease + lmiPremium;
  const propertyOneOffCost = -sumProps("duty") - sumProps("costs") + sumProps("fhog");
  const propertyGrowth = propertyAcquisitionCosts - propertyOneOffCost;

  // --- FHSSS release (Document Set Commit 3) — a TRANSFER between two
  // pockets, sourced independently from each side; the gap between them
  // is asserted (not just assumed) by checkYearConservation below.
  const fhsssSuperDebit = sumVals(row.superDetail, "fhsssRelease");

  // --- Goals (Document Set Commit 6) — a leak; see header.
  const goalSpend = Object.values(row.goals ?? {}).reduce((s, g) => s + (g.contribution ?? 0), 0);

  // --- Gifting (spec 21b, Commit 2) — a genuine leak, the same shape
  // as goalSpend just above: the FULL gift amount leaves household
  // cash regardless of how much of it Centrelink counts as deprived
  // (deprivation is an assessment-only concept, invisible to net
  // worth). row.giftsPaid is a plain household total (deterministic.js
  // sums it straight from the resolved gift events, not accumulated
  // per-month), so no further derivation is needed here.
  const giftsPaid = row.giftsPaid ?? 0;

  // --- HEAS (spec 21b, Commit 5) — a genuine new money flow: a
  // drawdown credits household cash (folded into `row.income` the
  // SAME way the age pension's own entitlement is — deterministic.js's
  // `inc`), while SIMULTANEOUSLY the loan balance grows by that exact
  // amount PLUS this FY's capitalised interest — heasDetail lives
  // OUTSIDE row.liabilities (see deterministic.js's own header on why),
  // so row.netAssets subtracts heasDetail.closing directly and this
  // growth needs its own term here, the same shape liabilityRevaluation's
  // own `+ drawdown` already establishes for an ordinary purchase loan:
  // the drawdown itself is a wash (+cash via income, −liability via
  // closingN — nets to zero) and only the CAPITALISED INTEREST is a
  // genuine, cash-free loss to net worth. One term covers both: the
  // household's `+drawn` cash gain already inside `income` above is
  // exactly cancelled by subtracting the FULL balance growth
  // (drawn + interest) here, leaving only `−interest` as the residual —
  // matching what closingN actually reflects.
  const heasDrawn = row.heasDetail?.drawn ?? 0;
  const heasInterest = row.heasDetail?.interest ?? 0;

  // --- HELP/HECS (HELP-as-liability follow-up fix) — folded into the
  // SAME row.liabilities map as ordinary loans (deterministic.js), so
  // its opening/closing are already inside openingN/closingN and its
  // (always-zero) interest is already inside liabilityInterest above.
  // Its indexation nets out of the liabilityRevaluation derivation
  // above for free, exactly like an ordinary loan's own `principal` term
  // does — closing = opening + indexation − principal, so
  // opening − closing − principal ≡ −indexation regardless of the
  // repayment amount — named here for the record, not summed again.
  // eslint-disable-next-line no-unused-vars
  const helpIndexation = sumVals(row.liabilities, "indexation");
  // Repayment is NOT the same shape as an ordinary loan's principal,
  // though: that cash is drawn from an asset pocket already inside
  // netAssets (so reducing the liability by $X exactly cancels the $X
  // the household would otherwise still have as an asset — no term
  // needed, see liabilityRevaluation's own derivation above). HELP's
  // compulsory repayment is instead withheld from PAYG BEFORE it ever
  // reaches the household — folded into `row.tax` (already subtracted
  // as a leak in `expected` below) the same way ordinary income tax is,
  // per row.tax's own header note. That withheld dollar would otherwise
  // have become take-home pay and eventually an asset; instead it
  // extinguishes debt — a real gain to net worth that `-row.tax` alone
  // doesn't credit back. Added back explicitly, the same shape as
  // `salarySacrificed` being added back to `income` above for the same
  // reason (real value redirected somewhere `row.tax`/`row.income`
  // can't see, but already reflected in `closingN` via liabilitiesClosing).
  const helpRepayment = row.taxDetail?.helpRepayment ?? 0;

  // --- Adviser fees (Implementation/Rates spec, Commit 2) — TWO leaks,
  // one per pocket, exactly the shape divReleaseFromSuper already
  // established: adviserFeeFromSuper is a direct super-balance
  // reduction (row.superDetail[*].adviserFee, same mechanic as
  // release — no preservation gate, not assessable, applied before
  // growth); adviserFeeCash is the household's own cash cost — the
  // genuine outside-super slice PLUS whatever a nominated account
  // couldn't cover (requestedFromSuper − paidFromSuper, "paid
  // personally" per the spec), which the engine already folds into
  // net/wcaBal, so it must be named here too or the invariant would
  // read those months as gaining money into netAssets with nothing to
  // explain it. Both slices — upfront (year 0 only) and ongoing (every
  // year) — are summed into the same two terms; the projection reports
  // them separately (row.adviserFeesUpfront/row.adviserFeesOngoing)
  // purely for the UI's "requested vs paid vs shortfall" display.
  const adviserFeeFromSuper = sumVals(row.superDetail, "adviserFee");
  const zeroFees = { outsideCash: 0, requestedFromSuper: 0, paidFromSuper: 0 };
  const adviserFeesUpfront = row.adviserFeesUpfront ?? zeroFees;
  const adviserFeesOngoing = row.adviserFeesOngoing ?? zeroFees;
  const adviserFeeCash =
    adviserFeesUpfront.outsideCash + (adviserFeesUpfront.requestedFromSuper - adviserFeesUpfront.paidFromSuper)
    + adviserFeesOngoing.outsideCash + (adviserFeesOngoing.requestedFromSuper - adviserFeesOngoing.paidFromSuper);

  return {
    openingN, closingN, delta: closingN - openingN,
    income, growth, sgInflow, govSuperInflow, superInsurancePremium,
    expenses: row.expenses, tax: row.tax, contributionsTax, liabilityInterest,
    surplusSpent: row.surplusSpent, unfundedCashflow: row.unfundedCashflow,
    divReleaseFromSuper,
    propertyGrowth, propertyOneOffCost,
    propertySaleCosts,
    fhsssRelease, fhsssSuperDebit,
    lmiPremium,
    goalSpend,
    giftsPaid,
    heasDrawn, heasInterest,
    helpRepayment,
    adviserFeeFromSuper, adviserFeeCash,
  };
}

// Throws on violation (rather than returning a boolean) so a caller
// can drop it straight into a loop without adding its own assertion —
// see monteCarlo.test.js's per-path spot check for the pattern.
export function checkYearConservation(out, y, ctx) {
  const f = computeYearFlows(out, y);

  // --- FHSSS release (Document Set Commit 3) — a TRANSFER, asserted
  // explicitly to net to zero across its two pockets, not just assumed.
  const fhsssGap = Math.abs(f.fhsssRelease - f.fhsssSuperDebit);
  const fhsssTol = Math.max(0.05, Math.abs(f.fhsssRelease) * 1e-6);
  if (fhsssGap > fhsssTol) {
    throw new Error(
      `FHSSS release doesn't net to zero across super and settlement cash — gap ${fhsssGap.toFixed(4)} ` +
      `(tol ${fhsssTol.toFixed(4)}) at ${ctx}: settlement was credited ${f.fhsssRelease.toFixed(2)}, ` +
      `super was debited ${f.fhsssSuperDebit.toFixed(2)}. A transfer must move the SAME amount both ways — ` +
      `if the super account couldn't cover the full release, the settlement credit must be capped to match.`
    );
  }

  const expected =
    f.income + f.growth + f.sgInflow + f.govSuperInflow
    - f.expenses - f.tax - f.contributionsTax - f.liabilityInterest
    - f.surplusSpent + f.unfundedCashflow - f.divReleaseFromSuper
    + f.propertyGrowth + f.propertyOneOffCost + f.fhsssRelease - f.fhsssSuperDebit - f.lmiPremium
    - f.propertySaleCosts - f.superInsurancePremium
    - f.goalSpend - f.giftsPaid - f.heasDrawn - f.heasInterest + f.helpRepayment - f.adviserFeeFromSuper - f.adviserFeeCash;

  const gap = f.delta - expected;
  const tol = Math.max(0.05, Math.abs(f.closingN) * 1e-6);
  if (Math.abs(gap) > tol) {
    throw new Error(
      `Conservation invariant violated by ${gap.toFixed(4)} (tol ${tol.toFixed(4)}) at ${ctx}: ` +
      `delta=${f.delta.toFixed(2)} expected=${expected.toFixed(2)}`
    );
  }
}

// decomposeNetWorthChange(out, y) — the SAME terms above, regrouped
// into the 7 buckets docs/specs/13-implementation-rates-equity-
// comparison.md's Commit 4 ("Where the money went") shows as a
// waterfall: income, growth, tax, expenses, interest, fees, oneOffs.
// Built from computeYearFlows so the feature and the invariant can
// never silently disagree about what a given dollar is. The FHSSS
// transfer (~0 net, but not exactly 0 until checkYearConservation's own
// tolerance is applied) is folded into oneOffs rather than dropped, so
// this reconciles to closingN EXACTLY, not just within tolerance —
// verified by a dedicated test over randomScenario()-generated plans.
//
//   opening net worth
//     + income bucket        (income + sgInflow + govSuperInflow)
//     + growth bucket        (asset/super/property growth, net of tax;
//                             HELP's PAYG-withheld repayment folded in —
//                             see computeYearFlows' own comment)
//     − tax bucket            (income/CGT tax, contributions tax, Div293/296)
//     − expenses bucket       (expenses + the FY-end spend sweep, net of
//                             any recorded-but-unfunded shortfall)
//     − interest bucket       (liability interest)
//     − fees bucket           (LMI + adviser fees, from super and cash,
//                             + insurance premiums paid inside super)
//     ± one-offs bucket       (property duty/costs/FHOG, a property
//                             sale's agent fees + settlement costs, goal
//                             spend, the FHSSS transfer)
//   = closing net worth
//
// ICR/platform fees are NOT separately extractable — they're already
// netted into each asset's return rate at the source (assetReturnComponents),
// with no separate ledger field — so they're absorbed into growth
// (understated, not double-counted), a disclosed limitation, not
// re-derived from the monthly loop.
export function decomposeNetWorthChange(out, y) {
  const f = computeYearFlows(out, y);
  return {
    openingN: f.openingN,
    closingN: f.closingN,
    delta: f.delta,
    // HEAS's drawdown (spec 21b, Commit 5) is loan proceeds, not earned
    // income — pulled OUT of the income bucket entirely (not relocated
    // elsewhere: it's already fully cancelled by row.netAssets's own
    // subtraction of the closing balance, the same "a same-total move
    // between two already-counted pockets nets to zero by construction"
    // reasoning this file already applies to a pension's own
    // commencement transfer — see pensionEarningsNet's header). Its
    // capitalised interest, unlike the drawdown, has no offsetting
    // pocket anywhere — a real, cash-free cost — folded into the
    // interest bucket alongside liability interest.
    income: f.income + f.sgInflow + f.govSuperInflow - f.heasDrawn,
    growth: f.growth + f.propertyGrowth + f.helpRepayment,
    tax: f.tax + f.contributionsTax + f.divReleaseFromSuper,
    expenses: f.expenses + f.surplusSpent - f.unfundedCashflow,
    interest: f.liabilityInterest + f.heasInterest,
    fees: f.lmiPremium + f.adviserFeeFromSuper + f.adviserFeeCash + f.superInsurancePremium,
    oneOffs: f.propertyOneOffCost - f.propertySaleCosts - f.goalSpend - f.giftsPaid + f.fhsssRelease - f.fhsssSuperDebit,
  };
}
