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
//         + growth (asset growth + super earnings, NET of fund tax)
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
      + sumVals(row.superDetail, "opening") - sumVals(row.liabilities, "opening");
  const closingN = row.netAssets;

  const superEarningsNet = sumVals(row.superDetail, "earnings") - sumVals(row.superDetail, "earningsTax");
  const contributionsTax = sumVals(row.superDetail, "contributionsTax");
  const sgInflow = sumVals(row.superDetail, "sg");
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
  const growth = row.growth + superEarningsNet + liabilityRevaluation;

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
    income, growth, sgInflow,
    expenses: row.expenses, tax: row.tax, contributionsTax, liabilityInterest,
    surplusSpent: row.surplusSpent, unfundedCashflow: row.unfundedCashflow,
    divReleaseFromSuper,
    propertyGrowth, propertyOneOffCost,
    propertySaleCosts,
    fhsssRelease, fhsssSuperDebit,
    lmiPremium,
    goalSpend,
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
    f.income + f.growth + f.sgInflow
    - f.expenses - f.tax - f.contributionsTax - f.liabilityInterest
    - f.surplusSpent + f.unfundedCashflow - f.divReleaseFromSuper
    + f.propertyGrowth + f.propertyOneOffCost + f.fhsssRelease - f.fhsssSuperDebit - f.lmiPremium
    - f.propertySaleCosts
    - f.goalSpend + f.helpRepayment - f.adviserFeeFromSuper - f.adviserFeeCash;

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
//     + income bucket        (income + sgInflow)
//     + growth bucket        (asset/super/property growth, net of tax;
//                             HELP's PAYG-withheld repayment folded in —
//                             see computeYearFlows' own comment)
//     − tax bucket            (income/CGT tax, contributions tax, Div293/296)
//     − expenses bucket       (expenses + the FY-end spend sweep, net of
//                             any recorded-but-unfunded shortfall)
//     − interest bucket       (liability interest)
//     − fees bucket           (LMI + adviser fees, from super and cash)
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
    income: f.income + f.sgInflow,
    growth: f.growth + f.propertyGrowth + f.helpRepayment,
    tax: f.tax + f.contributionsTax + f.divReleaseFromSuper,
    expenses: f.expenses + f.surplusSpent - f.unfundedCashflow,
    interest: f.liabilityInterest,
    fees: f.lmiPremium + f.adviserFeeFromSuper + f.adviserFeeCash,
    oneOffs: f.propertyOneOffCost - f.propertySaleCosts - f.goalSpend + f.fhsssRelease - f.fhsssSuperDebit,
  };
}
