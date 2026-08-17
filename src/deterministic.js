// Deterministic projection engine — pure, real terms, post-tax (B.1).
//
// Monthly ledger loop (conventions 7–11), each month in order:
//   a. Grow every included asset. Reinvest-mode assets grow at the
//      full net return; paid-as-cash assets grow at the growth-only
//      component net of ICR (their income component is paid out).
//   b. Accrue distribution income (nominal income yield × real
//      balance, monthly) and ICR deductions, attributed to owners
//      (joint: 50/50). Cash-mode distributions enter household income
//      this month; reinvest-mode distributions stay in the asset and
//      uplift its cost-base pool. Taxable either way.
//   c. Apply asset-targeted flows. Outflows are SALES: a proportional
//      slice of the cost-base pool is consumed and the realised
//      gain/loss recorded per owner. Explicit withdrawals never
//      cascade — the remainder is unfunded.
//   d. Household net = income (rows + cash distributions) − expenses
//      − tax outflows (see below). Surplus per settings; deficit
//      drawn down the funding order (those draws are sales too);
//      remainder unfunded. Balances never go negative.
//
// Tax (locked decisions 12–14): per FY each person is assessed via
// the shared assessPerson(). Income tax accrues within the FY, spread
// evenly across the months in which that person's income arises (a
// PAYG-withholding approximation); a net refund (excess refundable
// franking credits) lands in the FY's final month. Because
// distribution income depends on balances, each year runs twice: a
// measurement pass (no income-tax outflows) fixes the year's income,
// then the real pass replays the year with the tax spread applied.
// CGT on FY t's realised net gains is a single household outflow in
// July of FY t+1; the final year's assessment is surfaced as
// accruedCgtAtEnd instead. Tax is not a cashflow row — it is computed,
// and it is funded by the same surplus/deficit mechanics as any
// outflow.
//
// CGT pools: one pooled cost base per cgtAsset (src/costBasePool.js),
// deemed-reacquisition reset at 1 July 2027, pre-reform sales
// discounted per decision 10, per-person capital-loss carry-forward.
//
// The engine computes REAL values only; nominal is display-time
// scaling. No DOM knowledge anywhere.

import { PROFILES, DEFENSIVE_PROFILE, impliedFrankingPct } from "./profiles.js";
import { buildSchedules, firstFyStartYear, superContributionAllowed } from "./schedule.js";
import { resolveRef } from "./keyDates.js";
import { superRatesFor, superReleaseAge } from "./data/superRates.js";
import { helpRatesFor, helpRepaymentAmount } from "./data/helpRates.js";
import { mlsRatesFor, mlsSurchargeAmount } from "./data/mlsRates.js";
import { fhsssAcceptContribution, fhsssReleaseAmounts } from "./fhsss.js";
import { lmiPremium } from "./data/lmiRates.js";
import {
  processConcessionalCap, processNonConcessionalCap, div293Tax, availableCarryForward,
} from "./Tax/superContributions.js";
import { levelPayment, monthlyRate, termMonths, ioMonths, scheduledAmortisation, deductibleFraction } from "./liabilities.js";
import { dutyWithConcessions, fhogAmount } from "./data/stampDuty.js";
import { fhbgPriceCapExceeded } from "./data/fhbgCaps.js";
import { assessPerson } from "./Tax/annual.js";
import { div296Tax } from "./Tax/div296.js";
import { decomposeNetWorthChange } from "./conservationCheck.js";
import { dependentChildrenCountInFY } from "./planState.js";
import {
  createPool, poolAdd, poolConsume, poolNewFy,
  poolDeemedReacquisition, preReformTaxableGain,
} from "./costBasePool.js";

const toMonthlyReal = (netNominal, cpi) =>
  Math.pow((1 + netNominal) / (1 + cpi), 1 / 12) - 1;

// Nominal return components + franking level for an asset. Lifestyle
// assets (D2) have a bare growth rate and nothing else.
export function assetReturnComponents(asset, profiles = PROFILES) {
  if (asset.class === "lifestyle") {
    return { incomeNominal: 0, growthNominal: (asset.growthPct ?? 0) / 100, frankingPct: 0 };
  }
  if (asset.allocation.mode === "custom") {
    return {
      incomeNominal: asset.allocation.incomePct / 100,
      growthNominal: asset.allocation.growthPct / 100,
      frankingPct: asset.allocation.frankingPct ?? 0,
    };
  }
  const p = profiles[asset.allocation.profile];
  return {
    incomeNominal: p ? p.incomeReturn : 0,
    growthNominal: p ? p.growthReturn : 0,
    // Derived from the profile's class weights (Derive franking from
    // class weights commit) — no longer a stored figure, so it can't
    // drift out of step with the weights it's checked against.
    frankingPct: p ? impliedFrankingPct(p.classWeights, p.incomeReturn) : 0,
  };
}

// Full net real monthly return (convention 7) — the balance growth
// rate for reinvest-mode assets. Unchanged from Phase B.
export function assetMonthlyRate(asset, cpi, profiles = PROFILES) {
  const { incomeNominal, growthNominal } = assetReturnComponents(asset, profiles);
  return toMonthlyReal(incomeNominal + growthNominal - asset.icrPct / 100, cpi);
}

function ownerShares(asset, couple) {
  if (couple && asset.owner === "partner") return { partner: 1 };
  if (couple && asset.owner === "joint") return { client: 0.5, partner: 0.5 };
  return { client: 1 };
}

// projectPlan(state) → {
//   schedule,
//   monthly: { combined, perAsset: { [assetId]: Float64Array } },
//   yearly: [ ...one row per plan year, tax + taxDetail filled... ],
//   shortfall: { firstMonth, planYear, fyLabel, clientAge, total } | null,
//   accruedCgtAtEnd,   // final FY's CGT, unpayable inside the projection
// }
// mc (Monte Carlo overlay, Session B): optional {
//   shockFor(holdingId, m)  — REAL monthly return shock (zero-mean; mu
//     stays exactly the deterministic rate below) for a financial
//     asset or super account id, at absolute month index m. Read at
//     the single point each holding's monthly return is realised (the
//     "a. Growth" step for assets, "a-super-credit" for super) so the
//     SAME value is seen by both the measurement and real passes of a
//     plan year — critical, since those two passes must replay
//     identical balances for the tax timing split to mean anything
//     (see the module header).
//   cpiForYear(y)  — the ACTUAL (possibly stochastic) inflation rate
//     realised in plan year y, replacing the single assumed
//     state.assumptions.cpi for inflAt(m) (below) only. Deliberately
//     scoped to the two things inflAt actually feeds — a fixed-nominal
//     liability's real burden and a planned property purchase's real
//     price — NOT to asset/super/WCA expected returns (meta[id].rate
//     etc., computed once, below, from the plan's single assumed cpi):
//     those are modelled as holding a constant REAL return regardless
//     of the inflation path (the same assumption the deterministic
//     engine already makes everywhere), whereas a fixed-nominal
//     instrument's real value genuinely does depend on which inflation
//     path is realised. This is why a high-inflation path makes a
//     geared client's debt burden lighter in real terms without also
//     silently changing their portfolio's expected real return.
// Both pre-generated for the whole path before either pass of any year
// runs (monteCarlo.js) — never drawn from inline, for the same
// measurement/real-pass replay reason as shockFor. Omitted (the
// default), both are exactly the plan's normal deterministic
// expectation — bit-identical to every existing regression gate.
export function projectPlan(state, profiles = PROFILES, mc = null) {
  const shockFor = mc?.shockFor ?? (() => 0);
  // Monte Carlo rate linkage (What-if spec, Commit 5): the deviation
  // (in annual, real terms) a given plan year's rate should move by,
  // relative to whatever the deterministic rate already is — Monte
  // Carlo only, always absent for a deterministic run (mc null). See
  // the liability loop below for how it's applied (added to the rate,
  // never replacing it — same convention as shockFor for asset
  // returns) and monteCarlo.js's own header for the formula and the
  // two configurable parameters behind it.
  const mortgageRateDeltaForYear = mc?.mortgageRateDeltaForYear ?? null;
  const schedule = buildSchedules(state);
  const cpi = state.assumptions.cpi;
  const bracketMode = state.assumptions.bracketMode === "frozen" ? "frozen" : "indexed";
  const included = state.assets.filter((a) => a.include);
  const ids = included.map((a) => a.id);
  const months = schedule.months;
  const years = schedule.planYears;
  const fy0 = firstFyStartYear(state.plan.start);
  const couple = !!state.plan.partner;
  const persons = couple ? ["client", "partner"] : ["client"];

  const meta = {};
  for (const a of included) {
    const { incomeNominal, growthNominal, frankingPct } = assetReturnComponents(a, profiles);
    const icr = a.class === "lifestyle" ? 0 : a.icrPct / 100;
    const payout = a.class !== "lifestyle" && a.distributions === "cash";
    meta[a.id] = {
      rate: payout
        ? toMonthlyReal(growthNominal - icr, cpi)
        : toMonthlyReal(incomeNominal + growthNominal - icr, cpi),
      incomeNominal,
      frankingPct,
      icr,
      payout,
      cgt: a.class !== "lifestyle" && a.cgtAsset === true,
      lifestyle: a.class === "lifestyle",
      shares: ownerShares(a, couple),
    };
  }

  const bal = {};
  const series = {};
  let pools = {};
  for (const a of included) {
    bal[a.id] = a.balance;
    series[a.id] = new Float64Array(months + 1);
    series[a.id][0] = a.balance;
    if (meta[a.id].cgt) pools[a.id] = createPool(a.costBase ?? a.balance);
  }
  const combined = new Float64Array(months + 1);
  combined[0] = ids.reduce((s, id) => s + bal[id], 0);

  // --- superannuation (Tier 1.2, accumulation phase) --------------------------
  //
  // A distinct asset class, never merged into `bal`/`combined`/
  // fundingOrder (same pattern as properties/liabilities): its own
  // balance series, its own per-year detail block. 100% reinvest —
  // there is no "cash payout" mode in accumulation phase, so nothing
  // here ever feeds household cashflow (that starts in Commit 3, once
  // preserved withdrawals exist). Earnings tax is a return haircut,
  // applied to the income and growth components SEPARATELY because
  // realised gains in super get a one-third discount (15% × 2/3 = 10%
  // effective on growth, vs the full 15% on income) — a documented
  // simplification: real funds realise gains irregularly, not smoothly.
  const superAccounts = (state.plan.superAccounts ?? []).filter((s) => s.include);
  const superIds = superAccounts.map((s) => s.id);
  const superMeta = {};
  for (const s of superAccounts) {
    const { incomeNominal, growthNominal } = assetReturnComponents(s, profiles);
    const icr = s.icrPct / 100;
    const rates = superRatesFor(fy0, bracketMode, cpi); // flat rates — FY-invariant, safe to fix once
    const growthTaxRate = rates.earningsTaxRate * (2 / 3);
    superMeta[s.id] = {
      // Actual compounding rate: both components taxed, THEN combined
      // and Fisher-converted — same structure assetMonthlyRate uses.
      rate: toMonthlyReal(incomeNominal * (1 - rates.earningsTaxRate) + growthNominal * (1 - growthTaxRate) - icr, cpi),
      // Pre-tax rate, for the earnings/earnings-tax reporting split only.
      grossRate: toMonthlyReal(incomeNominal + growthNominal - icr, cpi),
      owner: s.owner,
    };
  }
  const superBal = {};
  const superSeries = {};
  // Taxable component = balance − taxFreeComponent (Tier 1.2, Commit 3
  // proportioning). Growth and concessional contributions build the
  // TAXABLE component implicitly (they grow `superBal` without
  // touching `superTaxFree`); non-concessional contributions and the
  // opening seed build the tax-free component explicitly.
  const superTaxFree = {};
  for (const s of superAccounts) {
    superBal[s.id] = s.balance;
    superSeries[s.id] = new Float64Array(months + 1);
    superSeries[s.id][0] = s.balance;
    superTaxFree[s.id] = Math.min(s.taxFreeComponent ?? 0, s.balance);
  }
  const superAccountsByOwner = { client: [], partner: [] };
  for (const s of superAccounts) superAccountsByOwner[s.owner]?.push(s.id);
  const workTestMetFor = (owner) =>
    (owner === "partner" ? state.plan.partner?.super?.workTestMet : state.plan.client?.super?.workTestMet) !== false;

  // Pay `want` real dollars from a super account, proportioning
  // tax-free/taxable at the CURRENT interest — recalculated at every
  // payment (this is what distinguishes accumulation interests from
  // pensions, which fix the proportion once at commencement; pensions
  // are out of scope for this tier). Never cascades to another
  // account — same convention as explicit financial-asset withdrawals.
  function withdrawFromSuper(id, want) {
    const balance = superBal[id];
    const paid = Math.min(want, balance);
    if (paid <= 0) return 0;
    const taxFreeFraction = balance > 0 ? superTaxFree[id] / balance : 0;
    superTaxFree[id] -= paid * taxFreeFraction;
    superBal[id] -= paid;
    return paid;
  }

  // Concessional carry-forward (5-year FIFO) SEEDS from the plan's
  // opening ledger (a real client's already-accrued unused cap, same
  // convention as openingCapitalLosses) and evolves FY over FY.
  // Non-concessional bring-forward is engine-INTERNAL running state —
  // every projection starts it fresh at year 0; plan.<person>.super.
  // bringForwardTriggeredYear is informational only in this build (see
  // src/Tax/superContributions.js's header for why a single stored
  // field can't safely seed a mid-window resume).
  const superCarryForward = {
    client: [...(state.plan.client?.super?.carryForward ?? [0, 0, 0, 0, 0])],
    partner: [...(state.plan.partner?.super?.carryForward ?? [0, 0, 0, 0, 0])],
  };
  let superBringForward = { client: null, partner: null };
  let pendingDiv293 = { client: 0, partner: 0 }; // assessed FY t, paid July t+1 (same convention as CGT)
  let pendingDiv296 = { client: 0, partner: 0 }; // assessed FY t, paid July t+1 (same convention as CGT/Div293)
  // PAYG withholding / tax refund timing: assessed FY t (paygWithheld −
  // actualTaxPayable, per person with employment income that FY), paid
  // July t+1 (same convention). 0 for a person with no employment
  // income that FY — their tax stays on the pre-existing smooth
  // spreadTax accrual entirely (see the assessment loop below).
  let pendingRefund = { client: 0, partner: 0 };
  const superWarnings = [...schedule.superWarnings]; // age/work-test rejections, resolved in schedule.js
  // Document Set Commit 4 — flagged (never blocking, since price caps
  // change) when a First Home Guarantee purchase's price exceeds the
  // embedded state cap at settlement time.
  const propertyWarnings = [];

  // --- properties (D4) -------------------------------------------------------
  //
  // Owned properties carry their value from day one; planned purchases
  // fire in the July of the purchase FY (one-off conventions,
  // including the partial-first-year skip). Values are real; duty is
  // computed on the NOMINAL price of the purchase year (brackets are
  // nominal law) and deflated. Properties are illiquid: never in
  // fundingOrder, no sales in v1.
  const mortgageRateAssum = state.assumptions.mortgageRate ?? 0.06;
  const awoteAssum = state.assumptions.awote ?? 0.035;
  const props = (state.properties ?? []).filter((p) =>
    p.status === "owned" ? p.currentValue > 0 : p.priceToday > 0);
  const yearStartIdx = (y) => (y === 0 ? 0 : schedule.monthsInFirstYear + 12 * (y - 1));
  const julyOf = (y) => (y === 0 ? (state.plan.start.month === 7 ? 0 : null) : yearStartIdx(y));
  const propMeta = {};
  const propVal = {};    // real value; 0 until purchased
  const derivedLoans = []; // purchase loans, activated at settlement
  for (const p of props) {
    const owned = p.status === "owned";
    let purchaseMonth = null;
    if (!owned) {
      // Key Dates: resolved once here (not per month) — an anchor or
      // an explicit age both clamp into the projection window, so this
      // never needs a separate bounds check.
      const y = resolveRef(p.purchaseAt, state.plan, schedule, "client").planYear;
      purchaseMonth = julyOf(y); // null = never fires (convention 5's partial-year skip)
    }
    const invest = p.propertyType === "investment";
    // Negative gearing is unrestricted when the loss year is pre-FY2027-28,
    // the property is a new build, or it was acquired before Budget
    // night 12 May 2026 (grandfathered under the enacted restriction).
    const grandfathered = owned && p.acquisitionDate != null && p.acquisitionDate < "2026-05-12";
    propMeta[p.id] = {
      rate: toMonthlyReal(p.growthPct / 100, cpi),
      shares: ownerShares(p, couple),
      owned,
      purchaseMonth,
      invest,
      isCgt: p.propertyType !== "ppr", // PPR exempt — assessment skipped (disclosed)
      newBuild: p.newBuild === true,
      grandfathered,
      rent: p.rent,
      expensesFlow: p.expenses,
      expensesDeductible: p.expensesDeductible !== false,
      // PAYG withholding, tax refund timing, and deductions: a flat
      // annual $ deduction to the owner, entered in today's (real)
      // dollars and not indexed — spread evenly across the 12 months,
      // same as ICR, while the property is an active investment. Never
      // a household cash outflow (there is no cash event to debit —
      // depreciation isn't money leaving the household).
      depreciationMonthly: (p.depreciation ?? 0) / 12,
      loanId: null,
      // Document Set Commit 4 (LMI / FHBG) — filled in below when a
      // purchase loan exists; used by the settlement-month block for
      // the pay-at-settlement case (capitalised LMI is folded straight
      // into the loan's drawdown balance instead, right below).
      lmiNominal: 0,
      lmiCapitalised: p.lmiPayAtSettlement !== true,
    };
    propVal[p.id] = owned ? p.currentValue : 0;
    if (!owned && purchaseMonth != null && p.lvrPct > 0) {
      // The purchase loan: 30-year P&I at the mortgage-rate assumption,
      // nominal balance = LVR × nominal price at settlement (known
      // upfront — the projection is deterministic).
      const nominalPrice = p.priceToday * Math.pow(1 + p.growthPct / 100, purchaseMonth / 12);
      const loanNominal = (p.lvrPct / 100) * nominalPrice;
      // LMI (Document Set Commit 4): a manual override always wins
      // (same precedence as dutyOverride — entered in NOMINAL dollars
      // of the purchase year, deflated at the ledger below); otherwise
      // the First Home Guarantee waives it entirely for an eligible
      // first-home buyer, otherwise it's looked up from the embedded
      // LVR × loan-size table (0 at or below 80% LVR).
      const lmiNominal = p.lmiOverride != null
        ? p.lmiOverride
        : p.firstHomeGuarantee ? 0 : lmiPremium(p.lvrPct, loanNominal);
      propMeta[p.id].lmiNominal = lmiNominal;
      derivedLoans.push({
        id: `prop-${p.id}`,
        name: `${p.name} loan`,
        owner: p.owner,
        // Capitalised by default (the norm): the premium is added
        // straight to the drawn balance rather than paid as cash.
        balance: loanNominal + (propMeta[p.id].lmiCapitalised ? lmiNominal : 0),
        interestRatePct: mortgageRateAssum * 100,
        termYears: 30,
        repayment: "pi",
        ioYears: 0,
        deductiblePct: invest ? 100 : 0, // investment loans deduct by default
        startMonth: purchaseMonth,
        propertyId: p.id,
      });
      propMeta[p.id].loanId = `prop-${p.id}`;
    }
  }

  // Real monthly amount of an annual property flow under its D1
  // indexation settings.
  const propFlowAt = (flow, m) => {
    if (!flow || !(flow.amount > 0)) return 0;
    const basisRate = flow.indexBasis === "awote" ? awoteAssum : flow.indexBasis === "cpi" ? cpi : 0;
    const g = basisRate + (flow.indexExtraPct ?? 0) / 100;
    return (flow.amount / 12) * Math.pow((1 + g) / (1 + cpi), m / 12);
  };

  // --- adviser fees (Implementation/Rates spec, Commit 2) ---------------
  //
  // Two independent slices — upfront (once, at plan start) and ongoing
  // (every year, indexed) — each split outside/inside super. The
  // outside-super portion is an ordinary household cash outflow,
  // flowing through the monthly `net` calc exactly like any other
  // outflow (never deductible — financial advice fees aren't; the
  // partial deductibility available for advice relating to EXISTING
  // investments needs an apportionment this build doesn't collect —
  // disclosed in the Parameters modal). The inside-super portion is a
  // DIRECT balance debit via withdrawFromSuper — the SAME mechanic and
  // reasoning as the Division 293/296 release further below: not a
  // benefit payment, no preservation gate, no assessable income,
  // applied BEFORE that period's growth so growth compounds on the
  // post-fee balance ("reduce the interest proportionally" — not a
  // special formula, just growth reading an already-reduced balance).
  const adviserFeesPlan = state.plan.adviserFees ?? {
    upfront: { total: 0, fromSuperAmount: 0, superAccountId: null },
    ongoing: { annualAmount: 0, fromSuperAmount: 0, superAccountId: null, indexBasis: "cpi" },
  };
  const upfrontFee = adviserFeesPlan.upfront;
  // The household's own cash cost: the outside-super slice PLUS
  // whatever the nominated account couldn't cover — "any shortfall
  // that must be paid personally" (the spec's own words). The from-
  // super side (paid/shortfall) is resolved per-year, in the main year
  // loop below, alongside every other release mechanism that can
  // target the same account (Division 293/296, FHSSS) — see
  // reserveFromSuper's own header for why this can't be resolved here,
  // once and for all, the way Commit 1's own top-level setup can.
  const upfrontOutsideOnly = Math.max(0, upfrontFee.total - upfrontFee.fromSuperAmount);

  const ongoingFee = adviserFeesPlan.ongoing;
  const ongoingSuperFraction = ongoingFee.annualAmount > 0 ? ongoingFee.fromSuperAmount / ongoingFee.annualAmount : 0;
  const ongoingBasisRate = ongoingFee.indexBasis === "awote" ? awoteAssum : ongoingFee.indexBasis === "none" ? 0 : cpi;
  // Real-dollar ANNUAL figure at month m — the same indexed-real
  // convention every other annual flow here uses (propFlowAt, goal
  // targets): real amount = annual × ((1+g)/(1+cpi))^(m/12).
  const ongoingAnnualRealAt = (m) => ongoingFee.annualAmount * Math.pow((1 + ongoingBasisRate) / (1 + cpi), m / 12);
  // The outside-super slice genuinely flows monthly (the household's
  // own cash experience); the inside-super slice is resolved and
  // applied once per FY, in July (see the per-year block below) — a
  // disclosed simplification of "monthly" for the mechanics only, not
  // for what the household actually pays each month.
  const ongoingOutsideMonthlyAt = (m) => (ongoingAnnualRealAt(m) * (1 - ongoingSuperFraction)) / 12;

  // --- liabilities (D3): simulated in NOMINAL dollars, deflated at the
  // ledger. Repayments are nominal-fixed (basis-None behaviour), so
  // their real burden falls at CPI. Constant rate for the projection
  // (v1 limitation, disclosed).
  const liabs = [
    ...(state.liabilities ?? []).filter((l) => l.balance > 0),
    ...derivedLoans,
  ];
  const liabMeta = {};
  const loanBal = {}; // nominal
  // Real-dollar balance over time (Liabilities table/chart, Commit 5) —
  // same convention as series/superSeries/wcaSeries: only the real
  // pass ever writes into it, deflating loanBal at the point of write.
  const liabSeries = {};
  const offsetLoansByAsset = {}; // assetId → [liability ids]
  // Fixed-rate rollover (Implementation/Rates spec, Commit 1) — the
  // recomputed post-rollover level payment, keyed by liability id.
  // null/absent until the recompute trigger month is actually reached
  // (see the liability loop below) — snapshotted/restored alongside
  // loanBal (measurement vs real pass) since it's derived from the
  // path-dependent balance AT that month, not a static setup value.
  const postRolloverPmt = {};
  // Monte Carlo rate linkage (What-if spec, Commit 5) — a SEPARATE
  // cache from postRolloverPmt above, used ONLY when
  // mortgageRateDeltaForYear is provided: the level payment recomputes
  // once every July (the same cadence the rate itself can move, since
  // CPI is drawn once per plan year), not just once at rollover. A
  // level-payment schedule recomputed at an UNCHANGED rate reproduces
  // the IDENTICAL figure every time (amortisation's own self-
  // consistency property), so this is a genuine no-op whenever the
  // rate hasn't actually moved — which is always true for a
  // deterministic run (never reaches this branch at all) and for a
  // zero-CPI-volatility Monte Carlo path (reaches it, but recomputes
  // the same value every July), satisfying "zero volatility collapses
  // to the deterministic projection exactly" by construction rather
  // than by coincidence.
  const mcActivePmt = {};
  const mcJulyMonths = mortgageRateDeltaForYear
    ? new Set(Array.from({ length: schedule.planYears }, (_, y) => julyOf(y)).filter((m) => m != null))
    : null;
  for (const l of liabs) {
    const termM = termMonths(l);
    const ioM = ioMonths(l);
    const offsetId = l.offsetAssetId && l.offsetAssetId in bal && !meta[l.offsetAssetId].lifestyle
      ? l.offsetAssetId : null;
    // rateType is only ever "fixed" for user-entered liabilities — D4
    // purchase loans (derivedLoans) never set it, so they default to
    // "variable" here exactly like every other field they don't supply.
    const rateType = l.rateType === "fixed" ? "fixed" : "variable";
    const revertPct = l.revertRatePct != null ? l.revertRatePct : mortgageRateAssum * 100;
    const revertRate = revertPct / 100 / 12;
    // The rate in force UNTIL rollover — the plain variable rate, or
    // the loan's own fixed rate. Rollover resolves via the SAME
    // "fires in July of the resolved plan year, null = never within
    // this projection" convention every other one-off plan event uses
    // (goals, property purchases) — see julyOf's own definition above.
    const i = rateType === "fixed" ? (l.fixedRatePct ?? 0) / 100 / 12 : monthlyRate(l);
    let rolloverMonth = null;
    let rolloverYear = null;
    if (rateType === "fixed") {
      rolloverYear = resolveRef(l.fixedUntil, state.plan, schedule, "client").planYear;
      rolloverMonth = julyOf(rolloverYear);
    }
    liabMeta[l.id] = {
      i,
      termM,
      ioM,
      startMonth: l.startMonth ?? 0, // purchase loans (D4) start at settlement
      pmtPI: levelPayment(l.balance, i, termM - ioM),
      offsetId,
      deductibleFraction: deductibleFraction(l),
      shares: ownerShares(l, couple),
      propertyId: l.propertyId ?? null, // interest joins that property's gearing calc
      rateType, revertRate, rolloverMonth, rolloverYear,
      // The payment recomputes at the LATER of rollover or IO-end —
      // rolling over mid-IO changes nothing about the (still
      // interest-only) contractual payment, so recompute waits for
      // whichever actually starts the level-payment phase.
      recomputeTriggerMonth: rolloverMonth != null ? Math.max(rolloverMonth, (l.startMonth ?? 0) + ioM) : null,
    };
    // Purchase loans hold zero until the settlement month sets them.
    loanBal[l.id] = (l.startMonth ?? 0) > 0 ? 0 : l.balance;
    liabSeries[l.id] = new Float64Array(months + 1);
    liabSeries[l.id][0] = loanBal[l.id]; // real == nominal at month 0
    if (offsetId) (offsetLoansByAsset[offsetId] ??= []).push(l.id);
  }

  // --- goals (Document Set Commit 6) ------------------------------------
  //
  // Straight-line accrual from plan start to the (indexed) target
  // month — "spent at the target date" is modelled as the accrual
  // itself: the money progressively leaves its funding source exactly
  // as it's earmarked, so by the target month the indexed target has
  // already left the model; there is no separate goal-balance ledger
  // holding money in limbo between accrual and spend. Target month
  // resolves via the SAME "fires in July of the resolved plan year"
  // convention every other one-off event in this engine uses.
  const goals = state.goals ?? [];
  const goalMeta = {};
  for (const g of goals) {
    const targetYear = resolveRef(g.targetAt, state.plan, schedule, "client").planYear;
    const targetMonth = julyOf(targetYear); // null = never fires (partial-first-year skip, convention 5)
    if (targetMonth == null) continue;
    const basisRate = g.indexBasis === "awote" ? awoteAssum : g.indexBasis === "cpi" ? cpi : 0;
    const gRate = basisRate + (g.indexExtraPct ?? 0) / 100;
    const targetReal = g.targetAmount * Math.pow((1 + gRate) / (1 + cpi), targetMonth / 12);
    const totalMonths = Math.max(1, targetMonth);
    goalMeta[g.id] = {
      targetMonth,
      targetReal,
      requiredMonthly: targetReal / totalMonths,
      fundedFrom: g.fundedFrom,
      // A stale/removed asset reference falls back to "surplus" at the
      // planState clamp layer already — this is a defensive re-check
      // for a raw/imported state that could still reach here with one.
      assetOk: g.fundedFrom !== "surplus" && g.fundedFrom in bal,
    };
  }
  // Reporting-only running total per goal (real $, this-FY-only reset
  // by `row` — summed across years for the final accrued figure).
  // Gated on `row` exactly like row.liabilities[l.id].extraRepayment
  // above: the ACTUAL sell()/cash effect runs unconditionally in both
  // passes (bal/pools/net are snapshotted and restored around them,
  // same as every other asset-affecting cashflow), only the reporting
  // accumulation needs to avoid double-counting the measure pass.
  const goalAccruedTotal = {};
  for (const g of goals) goalAccruedTotal[g.id] = 0;

  // Lifestyle assets are illiquid to the engine: never funding
  // sources, never surplus targets (defensive — settings invariants
  // already exclude them).
  const fundingOrder = state.settings.fundingOrder.filter((id) => id in bal && !meta[id].lifestyle);
  // Deficit side (Surplus and Deficit Allocation spec, Commit 1):
  // per-asset minimum balances and the sell-rule choice. fundingOrder
  // itself is untouched by this phase.
  const deficitSettings = state.settings.deficit ?? { minimumBalances: {}, sellRule: "order" };
  const deficitMinimums = deficitSettings.minimumBalances ?? {};
  const deficitSellRule = deficitSettings.sellRule === "minimumCapitalGain" ? "minimumCapitalGain" : "order";

  // Concessional contribution rows a surplus allocation may top up
  // (v1 scope — see planState.js's clampAllocationEntry for why only
  // these two types are eligible): keyed by contribution row id →
  // { accountId, owner, type }, so the FY-end sweep can credit the
  // right account under the right person's cap without re-deriving it.
  const surplusSuperTargets = Object.fromEntries(
    (state.cashflows.superContributions ?? [])
      .filter((sc) => (sc.type === "salarySacrifice" || sc.type === "personalDeductible") && sc.accountId in superBal)
      .map((sc) => [sc.id, { accountId: sc.accountId, owner: sc.owner, type: sc.type }])
  );

  // Surplus side: an ordered list of periods, each covering part of the
  // projection (schedule.js resolved from/to into plan years already).
  // Re-validated against live engine state the same defensive way
  // fundingOrder is above — clampAllToPlan should already guarantee
  // valid references, but this module has never fully trusted that for
  // anything that moves real money.
  const surplusPeriods = (schedule.surplusPeriods ?? []).map((p) => ({
    ...p,
    allocations: (p.allocations ?? []).filter((a) => {
      if (a.targetType === "asset") return a.targetId in bal && !meta[a.targetId].lifestyle;
      if (a.targetType === "liability") return liabs.some((l) => l.id === a.targetId);
      if (a.targetType === "superContribution") return a.targetId in surplusSuperTargets;
      if (a.targetType === "goal") return a.targetId in goalMeta;
      return false;
    }),
  }));
  // The period covering plan year y — periods are supposed to be
  // contiguous and cover the whole projection (Commit 2's UI makes
  // gaps/overlaps impossible to enter), but this engine never assumes
  // its inputs are perfect: an uncovered year falls back to the LAST
  // period rather than leaving the FY-end sweep with nothing to do.
  function resolveSurplusPeriod(y) {
    if (surplusPeriods.length === 0) return null;
    return surplusPeriods.find((p) => y >= p.fromYear && y <= p.toYear) ?? surplusPeriods[surplusPeriods.length - 1];
  }

  // --- Working Cash Account (household cashflow buffer) ----------------------
  //
  // All household cashflow (income, expenses, tax, loan repayments,
  // property settlement) passes through the WCA rather than being
  // netted and immediately spent/sold within the same month. Without
  // it, annual income (e.g. a July salary) is "spent" that one month
  // and the other eleven run spurious deficits, selling down assets
  // that the same year's income would in reality have covered — cash
  // that exists is not available to the months that need it. The WCA
  // fixes this: it grows like a cash asset every month, absorbs that
  // month's net cashflow, tops itself back up from fundingOrder only
  // when it falls below its minimum, and only sweeps surplus above the
  // minimum at FY-end (per settings.surplus.mode) — see runYear below.
  const wca = state.plan.workingCash ?? { balance: 0, minimumBalance: 0, ratePct: null };
  // A pure cash instrument has no growth component to split from its
  // income component the way a diversified asset does — its whole
  // real return IS its interest (disclosed simplification: unlike
  // ordinary distributions, there is no separate nominal-rate-for-tax
  // figure; the same real, Fisher-converted rate drives both the
  // balance and the taxable amount).
  const wcaAnnualNominal = wca.ratePct != null ? wca.ratePct / 100 : (profiles[DEFENSIVE_PROFILE]?.incomeReturn ?? 0);
  const wcaMonthlyRate = toMonthlyReal(wcaAnnualNominal, cpi);
  let wcaBal = wca.balance;
  const wcaSeries = new Float64Array(months + 1);
  wcaSeries[0] = wcaBal;

  const yearStart = (y) => (y === 0 ? 0 : schedule.monthsInFirstYear + 12 * (y - 1));
  const yearEnd = (y) => schedule.monthsInFirstYear + 12 * y;

  // inflAt(m): cumulative nominal-to-real deflation factor at absolute
  // month m. Every existing call site (liability interest/deflation,
  // planned-property purchase pricing — see the module's mc parameter
  // header comment for why it's scoped to exactly these) is unchanged;
  // only what feeds it differs. Default: the closed-form (1+cpi)^(m/12)
  // this has always been. Monte Carlo's stochastic CPI (mc.cpiForYear)
  // replaces the exponent with the CUMULATIVE PRODUCT of each plan
  // year's own realised rate, built once up front since every month
  // needs the same path regardless of which pass or which later month
  // reads it.
  const inflAt = mc?.cpiForYear
    ? (() => {
        const cum = new Float64Array(months + 1);
        cum[0] = 1;
        for (let y = 0; y < years; y++) {
          const monthlyFactor = Math.pow(1 + mc.cpiForYear(y), 1 / 12);
          for (let m = yearStart(y); m < yearEnd(y); m++) cum[m + 1] = cum[m] * monthlyFactor;
        }
        return (m) => cum[m];
      })()
    : (m) => Math.pow(1 + cpi, m / 12);

  // Deemed reacquisition (1 July 2027): the first month of the plan
  // year whose FY starts in 2027 — but only when the projection
  // actually CROSSES that date. A projection starting on or after
  // 1 July 2027 is already post-reform: the user's costBase is by
  // definition the post-reset value and seeds the pool as-is.
  let resetMonth = null;
  {
    const y2027 = 2027 - fy0;
    if (y2027 > 0 && y2027 < years) resetMonth = yearStart(y2027);
  }

  // --- outer trackers (real passes only) -----------------------------------
  const yearly = [];
  let firstUnfundedMonth = -1;
  let totalUnfunded = 0;
  // Opening carry-forward capital losses (D1) seed the B.1 loss
  // mechanism in the first assessment year.
  const lossCarryFwd = {
    client: Math.max(0, state.plan.client?.taxProfile?.openingCapitalLosses ?? 0),
    partner: Math.max(0, state.plan.partner?.taxProfile?.openingCapitalLosses ?? 0),
  };
  let pendingCgt = { client: 0, partner: 0 }; // assessed in FY t, payable July t+1
  const quarantineCarry = { client: 0, partner: 0 }; // D4 quarantined rental losses
  // Document Set Commit 1 — HELP/HECS outstanding balance, real $.
  // Indexed annually and reduced by actual dollar repayments below (see
  // the indexation step later in the per-year loop, and src/data/
  // helpRates.js's header for the indexation basis); the loan ends when
  // this reaches zero. Surfaced on the balance sheet as its own
  // liabilities-table entry (see helpLiabPersons) — a real debt, not
  // just a Tax-view memo figure.
  const helpBal = {
    client: Math.max(0, state.plan.client?.helpBalance ?? 0),
    partner: Math.max(0, state.plan.partner?.helpBalance ?? 0),
  };
  // Which persons actually carry a HELP debt at plan start — gates
  // whether a help_<person> entry exists in row.liabilities at all,
  // same convention as ordinary liabilities' own `balance > 0` filter
  // (liabs, above) so a client with no HELP balance never sees a phantom
  // zero row or a phantom entry in the Liabilities entity selector.
  const helpLiabPersons = persons.filter((p) => helpBal[p] > 0);
  // Document Set Commit 3 — FHSSS running balances. Every projection
  // starts fresh at zero (same disclosed simplification as the NCC
  // bring-forward and concessional carry-forward's "no way to seed a
  // real client's already-accrued state" — see Tax/superContributions.js's
  // header): a real client's prior FHSSS contributions/releases aren't
  // modelled. `released` is a one-shot flag — this build models a
  // single lifetime release per person (the spec's own scope: "do not
  // model... the maximum release request", i.e. multiple partial
  // releases), so once true the balances stay zero for the rest of the
  // projection even if further FHSSS-eligible contributions are made.
  const fhsssBal = {
    client: { concessional: 0, nonConcessional: 0, earnings: 0, lifetimeContributed: 0, released: false },
    partner: { concessional: 0, nonConcessional: 0, earnings: 0, lifetimeContributed: 0, released: false },
  };
  const fhsssEarningsRateAssum = state.assumptions.fhsssEarningsRate ?? 0.0794;
  // Fisher-deflated to the engine's real-terms convention, same as
  // every other nominal assumption rate (mortgageRate, growthPct).
  const fhsssAnnualReal = (1 + fhsssEarningsRateAssum) / (1 + cpi) - 1;

  const propsById = Object.fromEntries(props.map((p) => [p.id, p]));
  const liabsById = Object.fromEntries(liabs.map((l) => [l.id, l]));
  // Cost base pools for non-PPR properties (no sales in v1 — the pool
  // exists for the deemed reacquisition and future sale modelling; the
  // seed is exposed on the purchase-year row).
  let propPools = {};
  for (const p of props) {
    if (propMeta[p.id].owned && propMeta[p.id].isCgt) {
      propPools[p.id] = createPool(p.costBase ?? p.currentValue);
    }
  }

  const mkYearRow = (y) => ({
    fyLabel: schedule.fyLabels[y],
    clientAge: schedule.clientAges[y],
    partnerAge: schedule.partnerAges ? schedule.partnerAges[y] : null,
    income: 0,
    cashDistributions: 0, // portion of income that is paid-out distributions
    expenses: 0,
    tax: 0,
    surplusOrDeficit: 0,
    surplusInvested: 0,
    // FY-end sweep of WCA surplus above minimumBalance (Working Cash
    // Account fix), per settings.surplus.mode. surplusInvested (above)
    // is reused for "invest" — same field, same meaning as before,
    // just swept once at FY-end instead of monthly; these two are new,
    // one for each of the other two modes.
    surplusSpent: 0,
    surplusAccumulated: 0,
    deficitFundedFromAssets: 0,
    unfundedCashflow: 0,
    contributions: 0,
    withdrawals: 0,
    oneOffsNet: 0,
    growth: 0,
    fees: null, // reserved
    taxDetail: null,
    openingBalance: 0,
    closingBalance: 0,
    perAssetClosing: {},
    // Per-liability detail (D3), real dollars; opening/closing filled
    // at year start/end. netAssets = assets + property − liabilities.
    // drawdown (Commit 5): a new loan settling this FY (property
    // purchases only — v1 has no other way to originate a loan mid-
    // projection). offsetApplied is a year-end snapshot (like closing,
    // not a sum) of how much of the balance is currently offset.
    // indexation: a liability's own balance growing with no cash
    // movement — always 0 for an ordinary loan (nominal balance is
    // fixed, not indexed; its real erosion is the DIFFERENT
    // liabilityRevaluation effect the conservation invariant derives
    // separately) but genuinely populated for a HELP entry below, so
    // opening + indexation − principal = closing reconciles for either
    // kind of row through the same generic table renderer.
    //
    // help_<person> (HELP/HECS follow-up fix): folded into this SAME
    // map, not a separate structure, so it's covered by the ordinary
    // Liabilities table/chart/liabilitiesClosing code for free — it has
    // no interest, term, drawdown or offset, so those fields simply stay
    // 0 (and are hidden by the all-zero-rows convention). `principal`
    // holds the FY's compulsory repayment (see helpDue below) — reusing
    // the field name that "reduces the balance via an actual repayment"
    // already means for an ordinary loan.
    liabilities: Object.fromEntries([
      ...liabs.map((l) => [l.id, {
        opening: 0, interest: 0, principal: 0, drawdown: 0, offsetApplied: 0, closing: 0, extraRepayment: 0, surplusRepayment: 0, indexation: 0, ratePct: 0,
      }]),
      ...helpLiabPersons.map((p) => [`help_${p}`, {
        opening: 0, interest: 0, principal: 0, drawdown: 0, offsetApplied: 0, closing: 0, extraRepayment: 0, surplusRepayment: 0, indexation: 0, ratePct: 0,
      }]),
    ]),
    liabilitiesClosing: 0,
    // Adviser fees (Implementation/Rates spec, Commit 2) — outsideCash
    // is the genuine outside-super household cash cost (excluding any
    // from-super shortfall, which is already folded into it via
    // adviserFeeCashOut at the point net is computed — see that
    // comment); requestedFromSuper/paidFromSuper (the latter credited
    // onto superDetail[id].adviserFee, same account) let the UI derive
    // "shortfall paid personally" without re-deriving anything.
    // adviserFeesUpfront is nonzero only in the projection's first
    // year (the upfront fee fires once, at month 0); adviserFeesOngoing
    // accrues every year.
    adviserFeesUpfront: { outsideCash: 0, requestedFromSuper: 0, paidFromSuper: 0 },
    adviserFeesOngoing: { outsideCash: 0, requestedFromSuper: 0, paidFromSuper: 0 },
    // Per-goal detail (Document Set Commit 6), real dollars — this
    // FY's contribution only (summed across years for the lifetime
    // accrued figure; see goalStats in the final return object).
    goals: Object.fromEntries(goals.map((g) => [g.id, { contribution: 0 }])),
    // Per-property detail (D4), real dollars. deposit/duty/costs/fhog
    // (Focus Commit 2 follow-on): the purchase-year breakdown behind
    // `settlement`'s single net figure — by construction (same local
    // variables the purchase-event block already computes for
    // `settlement` itself, just also written out individually so a
    // Focus view can show the breakdown without re-deriving it):
    //   settlement === deposit + duty + costs − fhog − fhsssRelease
    //                  + lmi, IF the purchase's own lmiPayAtSettlement
    //                  flag is true — `lmi` is reported unconditionally
    //                  (Commit 4) even when capitalised, but a
    //                  capitalised premium is folded into the linked
    //                  liability's own `drawdown` instead and must NOT
    //                  be added again here.
    properties: Object.fromEntries(props.map((p) => [p.id, {
      value: 0, rent: 0, expenses: 0, depreciation: 0, settlement: 0, costBaseSeed: 0, fhsssRelease: 0, lmi: 0,
      deposit: 0, duty: 0, costs: 0, fhog: 0,
      // Usable equity and borrowing capacity (Implementation/Rates
      // spec, Commit 3) — filled in by a post-pass once `yearly` is
      // complete (needs the property's own linked liabilities' closing
      // balances, which are only final at year-end).
      usableEquity: 0,
    }])),
    propertyClosing: 0,
    netAssets: 0,
    // Per-asset flow detail for the Assets view: opening + contributions
    // − withdrawals + oneOffs − deficitFunding + surplusInvested +
    // growth = closing, per asset.
    perAssetDetail: Object.fromEntries(ids.map((id) => [id, {
      opening: 0, contributions: 0, withdrawals: 0, oneOffs: 0,
      deficitFunding: 0, surplusInvested: 0, growth: 0, closing: 0,
      // costBasePool: this asset's pooled cost base at year end (D5's
      // unrealised-gain row = closing − costBasePool). null for
      // non-CGT assets (no pool exists), including lifestyle.
      costBasePool: meta[id].cgt ? 0 : null,
    }])),
    // Per-super-account detail (Tier 1.2): opening/closing balance,
    // contributions in (gross in Commit 1; contributionsTax arrives in
    // Commit 2), fund earnings and the earnings tax haircut, and
    // withdrawals (Commit 3). opening + contributions − contributionsTax
    // + earnings − earningsTax − withdrawals = closing, per account.
    // taxFreeClosing (Commit 3): the tax-free-component balance at year
    // end — recalculated proportionally on every withdrawal/NCC, per
    // the accumulation-phase proportioning rule (see withdrawFromSuper).
    // sg/salarySacrifice/personalDeductible/nonConcessional (Commit 4):
    // the same total as `contributions`, broken out by type for the
    // Super table view — kept in the engine so the UI never re-derives
    // cap/fill arithmetic itself.
    superDetail: Object.fromEntries(superIds.map((id) => [id, {
      opening: 0, contributions: 0, contributionsTax: 0,
      sg: 0, salarySacrifice: 0, personalDeductible: 0, nonConcessional: 0,
      earnings: 0, earningsTax: 0, withdrawals: 0,
      // Division 293/296 release authority payments — a direct balance
      // reduction, separate from `withdrawals` (a benefit payment) since
      // it's not assessable and not preservation-gated. See the Division
      // 293/296 release-from-super feature.
      release: 0,
      // Document Set Commit 3 (FHSSS) — the amount ACTUALLY debited
      // from this account for a release, independent of
      // row.properties[pid].fhsssRelease (the amount credited against
      // settlement cash): the two are computed from different places
      // and must agree — see conservationCheck.js's explicit transfer
      // assertion, added after this being asymmetric (settlement
      // credited the full requested amount; the account paid only what
      // it had) was found to silently create money.
      fhsssRelease: 0,
      // Adviser fees (Implementation/Rates spec, Commit 2) — the amount
      // ACTUALLY debited from this account for a fee, same shape as
      // `release` above (a direct balance reduction, not a withdrawal:
      // no preservation gate, not assessable).
      adviserFee: 0,
      // Surplus/deficit allocation spec, Commit 1: the slice of
      // `salarySacrifice` above (if any) that arrived via a surplus
      // allocation topping up an existing salary-sacrifice row, rather
      // than via schedule.js's normal payroll-reduction path. Unlike a
      // real salary sacrifice — which never touches wcaBal/row.income at
      // all, hence conservationCheck.js's `salarySacrificed` add-back —
      // this money DID pass through the household's own WCA pocket (the
      // FY-end sweep debits it just like a personalDeductible top-up
      // would), so it must NOT also be added back or the invariant
      // double-counts it. Tracked separately so conservationCheck.js can
      // subtract it back out of that add-back without touching the
      // genuine payroll figure.
      surplusSalarySacrifice: 0,
      closing: 0, taxFreeClosing: 0,
    }])),
    superClosing: 0,
    superCapUsage: { client: null, partner: null },
    // Focus Commit 3 (docs/specs/12-focus-views.md) follow-on: the
    // FHSSS running-balance snapshot (src/fhsss.js's fhsssBal) was
    // tracked internally but never exposed — a Focus view showing
    // "contributions by year, associated earnings" would otherwise have
    // to re-derive the whole accrual/cap-acceptance sequence itself.
    // null once a person has already released (nothing left to accrue —
    // mirrors fhsssBal.released's own early-exit).
    fhsssDetail: { client: null, partner: null },
    // Working Cash Account detail: opening + interest + netFlow +
    // sweptToCash − sweptInvested − sweptSpent = closing (the top-up-
    // from-assets draws are reported under deficitFundedFromAssets
    // above, same field as before — the WCA is just its new trigger).
    wcaDetail: {
      opening: 0, interest: 0, netFlow: 0,
      sweptToCash: 0, sweptInvested: 0, sweptSpent: 0, closing: 0,
    },
    wcaClosing: 0,
  });

  // Run one plan year's months. opts:
  //   taxOut  — Float64Array over absolute month indices (real pass) or null
  //   cgtDue  — household CGT payable in this year's first month (July)
  //   row     — ledger row to fill (real pass) or null
  //   trackUnfunded — record into the projection-level shortfall trackers
  // Returns per-person income components + realised gains + months in
  // which each person's income arose.
  function runYear(y, {
    taxOut, cgtDue, row, trackUnfunded, superOutcome, divReleaseFromSuper, divReleaseAccountId, fhsssRelease,
    ongoingFromSuperRequested = 0, ongoingFromSuperShortfall = 0, upfrontFromSuperShortfall = 0,
  }) {
    const fyStart = fy0 + y;
    // Condition of release (Tier 1.2, Commit 3): static for the whole
    // projection (retirementAge doesn't change), so cheap to recompute
    // identically every runYear call rather than threading it through
    // as year-sequential state like the cap outcome above.
    const superReleased = {};
    for (const p of persons) {
      const person = p === "partner" ? state.plan.partner : state.plan.client;
      const releaseAge = superReleaseAge(person?.retirementAge ?? 65);
      const age = p === "partner" ? schedule.partnerAges?.[y] : schedule.clientAges[y];
      superReleased[p] = age != null && age >= releaseAge;
    }
    const acc = {};
    for (const p of persons) {
      acc[p] = { ordinary: 0, franked: 0, unfranked: 0, deductions: 0, netCapitalGain: 0, incomeMonths: new Set(), fhsssTaxableRelease: 0 };
    }
    // Per-property net-rental tracking for the gearing rules (D4).
    acc._propNet = Object.fromEntries(props.map((p) => [p.id, {
      rent: 0, expenses: 0, interest: { client: 0, partner: 0 },
    }]));
    const markIncome = (sharesObj, m) => {
      for (const p of persons) if (sharesObj[p]) acc[p].incomeMonths.add(m);
    };
    const recordUnfunded = (amount, m) => {
      if (amount <= 0) return;
      if (row) row.unfundedCashflow += amount;
      if (trackUnfunded) {
        totalUnfunded += amount;
        if (firstUnfundedMonth === -1) firstUnfundedMonth = m;
      }
    };
    // A sale of `want` real dollars from an asset: pays what the
    // balance covers, consumes the pool slice, records the gain per
    // owner (pre-reform sales discounted at sale time). Returns paid.
    const sell = (id, want, m) => {
      const value = bal[id];
      const paid = Math.min(want, value);
      if (paid <= 0) return 0;
      const mt = meta[id];
      if (mt.cgt) {
        const { state: p2, gain, newMoneyFraction } = poolConsume(pools[id], paid, value);
        pools[id] = p2;
        const taxable = fyStart < 2027 ? preReformTaxableGain(gain, newMoneyFraction) : gain;
        for (const p of persons) {
          if (mt.shares[p]) acc[p].netCapitalGain += taxable * mt.shares[p];
        }
      }
      bal[id] -= paid;
      return paid;
    };

    const first = yearStart(y);
    const last = yearEnd(y);
    for (let m = first; m < last; m++) {
      // Deemed reacquisition happens at the top of 1 July 2027.
      if (m === resetMonth) {
        for (const id of ids) {
          if (meta[id].cgt) pools[id] = poolDeemedReacquisition(pools[id], bal[id]);
        }
        for (const pid in propPools) {
          if (propVal[pid] > 0) propPools[pid] = poolDeemedReacquisition(propPools[pid], propVal[pid]);
        }
      }

      // a. Growth (mode-dependent rate). An offset asset earns its
      // return only on the excess above the loan balance(s) it offsets;
      // the offset portion earns nothing nominally (its real value
      // decays at CPI) — it is "earning" the loan rate implicitly via
      // the interest saved.
      const cpiDecayMonthly = Math.pow(1 / (1 + cpi), 1 / 12) - 1;
      for (const id of ids) {
        let g;
        // Monte Carlo shock (Session B): added to the rate, never
        // applied to the offset portion below — that portion never
        // "invests" (it just decays at CPI, earning the loan rate
        // implicitly), so it has no market exposure to shock. A
        // payout-mode asset's distribution yield (mt.incomeNominal,
        // paid at step b below) is deliberately left unshocked too —
        // disclosed simplification: real-world income yields are far
        // more stable than capital values, which is where this rate
        // already concentrates the shock.
        const rate = meta[id].rate + shockFor(id, m);
        const offsetting = offsetLoansByAsset[id];
        if (offsetting) {
          const loanReal = offsetting.reduce((s, lid) => s + loanBal[lid], 0) / inflAt(m);
          const excess = Math.max(0, bal[id] - loanReal);
          const offsetPortion = bal[id] - excess;
          g = excess * rate + offsetPortion * cpiDecayMonthly;
        } else {
          g = bal[id] * rate;
        }
        bal[id] += g;
        if (row) {
          row.growth += g;
          row.perAssetDetail[id].growth += g;
        }
      }

      // a-wca. Working Cash Account growth (interest) — grows on the
      // OPENING balance, before this month's net household cashflow
      // lands, same convention as asset growth above. Interest is
      // assessable ordinary income to the client (joint: 50/50, the
      // same split every other jointly-shared income source uses).
      const wcaInterest = wcaBal * wcaMonthlyRate;
      wcaBal += wcaInterest;
      if (wcaInterest !== 0) {
        for (const p of persons) acc[p].ordinary += wcaInterest * (couple ? 0.5 : 1);
        markIncome(couple ? { client: 0.5, partner: 0.5 } : { client: 1 }, m);
        if (row) {
          row.wcaDetail.interest += wcaInterest;
          // WCA interest is real household income (Cashflow view's
          // Income section, Commit 2) — the household net below is
          // "the rest of household cashflow", so surplusOrDeficit
          // (income − expenses) needs this added on top of it to stay
          // the sum of everything the Cashflow view now shows as income
          // minus everything it shows as expenses.
          row.surplusOrDeficit += wcaInterest;
        }
      }

      // a-super-deduct. Personal deductible super contributions
      // (Tier 1.2, Commit 2) reduce the owner's assessable income like
      // any other deduction — on the FULL (gross, pre-contributions-tax)
      // amount, exactly mirroring how salary sacrifice already reduced
      // incomeByOwner upstream in schedule.js. This is what makes the
      // two produce identical net tax outcomes for equal amounts.
      // UNGATED (runs in both passes): it feeds the tax measurement
      // pass just like ICR/interest deductions do.
      for (const id of superIds) {
        const flows = schedule.superFlows[id];
        const pd = flows ? flows.personalDeductible[m] : 0;
        if (pd > 0) acc[superMeta[id].owner].deductions += pd;
      }

      // a-super-fill. "toConcessionalCap" fills (resolved once per FY,
      // above, in the caller — headroom isn't known at schedule-build
      // time) apply their tax and household-cash effects here, UNGATED,
      // for the same reason as a-super-deduct above: this must feed the
      // tax measurement pass, not only the real pass's super-balance
      // credit later in this same iteration (that credit stays
      // row-gated below — accumulation-phase balances never feed
      // measurement). Credited once, in the FY's July, matching where
      // the balance credit lands. A personalDeductible fill is a full
      // deduction funded like any other outflow (added to
      // superContribCashOut below, so an unaffordable fill runs the
      // same funding-order-then-unfunded fallback as everything else);
      // a salarySacrifice fill is already pre-tax — it reduces the
      // owner's assessable salary and the household's cash income by
      // the same amount, exactly like an explicit salary-sacrifice row
      // upstream in schedule.js. This closes the gap schedule.js's
      // toConcessionalCapRows header comment tracks ("DISCLOSED GAP").
      let fillCashDebit = 0;
      const fillSalarySacrifice = { client: 0, partner: 0 };
      if (m === julyOf(y)) {
        for (const p of persons) {
          for (const fill of superOutcome[p].fills) {
            if (fill.type === "personalDeductible") {
              acc[p].deductions += fill.amount;
              fillCashDebit += fill.amount;
            } else {
              fillSalarySacrifice[p] += fill.amount;
            }
          }
        }
      }

      // a-deductions. Deductions (PAYG withholding, tax refund timing,
      // and deductions): each row reduces its OWNER's assessable income
      // directly — no household cash effect (see schedule.js's
      // deductionsByOwner header comment). UNGATED, same as every other
      // deduction here.
      for (const p of persons) {
        const dedArr = schedule.deductionsByOwner[p];
        if (dedArr && dedArr[m] > 0) acc[p].deductions += dedArr[m];
      }

      // a-super-credit. Superannuation grows like a financial asset
      // (net-of-earnings-tax rate), then receives contributions net of
      // the 15% contributions tax (concessional) or scaled by the
      // accepted fraction (non-concessional, excess rejected) — both
      // resolved once per FY by the caller (superOutcome), since caps/
      // carry-forward/bring-forward are year-sequential state. Gated on
      // `row` only: unlike the deduction above, crediting the actual
      // balance never feeds the tax measurement pass (no household
      // income, no realised gains in accumulation phase), so there is
      // nothing to snapshot/roll back for that pass, unlike `bal`/
      // `pools` above.
      if (row) {
        // Adviser fees, inside-super portion (Implementation/Rates
        // spec, Commit 2) — direct balance debits via the SAME
        // withdrawFromSuper the Division 293/296 release uses just
        // below, applied BEFORE growth for the same reason. Upfront
        // fires once, at month 0 of the whole projection; ongoing
        // fires once per FY, in July (ongoingFromSuperShortfall was
        // already resolved against the SAME opening-of-year balance
        // this call will now debit — see the per-year setup for why).
        if (m === 0 && upfrontFee.superAccountId && upfrontFee.fromSuperAmount > 0) {
          const paid = withdrawFromSuper(upfrontFee.superAccountId, upfrontFee.fromSuperAmount);
          row.superDetail[upfrontFee.superAccountId].adviserFee += paid;
          row.adviserFeesUpfront.paidFromSuper += paid;
        }
        if (m === first && ongoingFee.superAccountId && ongoingFromSuperRequested > 0) {
          const paid = withdrawFromSuper(ongoingFee.superAccountId, ongoingFromSuperRequested);
          row.superDetail[ongoingFee.superAccountId].adviserFee += paid;
          row.adviserFeesOngoing.paidFromSuper += paid;
        }
        // Division 293/296 release authority: resolved once per FY
        // (above, before either pass, against the opening balance) —
        // applied here, at the very top of July's month, before growth/
        // contributions/withdrawals touch `superBal` for the year. A
        // release authority is not a benefit payment: no preservation
        // gate, no assessable income, no lump-sum tax — just a direct
        // balance reduction via the same proportioning withdrawFromSuper
        // already uses for ordinary withdrawals.
        if (m === first) {
          for (const p of persons) {
            const accountId = divReleaseAccountId?.[p];
            const want = divReleaseFromSuper?.[p] ?? 0;
            if (!accountId || want <= 0) continue;
            const paid = withdrawFromSuper(accountId, want);
            row.superDetail[accountId].release += paid;
          }
        }
        for (const id of superIds) {
          const sm = superMeta[id];
          // Monte Carlo shock (Session B): the SAME shock added to
          // both gross and net — the 15%/10% earnings-tax wedge is a
          // fixed proportional tax on whatever the fund actually
          // earned, not something that itself needs to be redrawn per
          // path (this block runs real-pass-only already — see the
          // header comment above — so there's no measurement/real
          // replay concern here the way there is for asset growth).
          const shock = shockFor(id, m);
          const grossGrowth = superBal[id] * (sm.grossRate + shock);
          const netGrowth = superBal[id] * (sm.rate + shock);
          superBal[id] += netGrowth;
          row.superDetail[id].earnings += grossGrowth;
          row.superDetail[id].earningsTax += grossGrowth - netGrowth;
        }
        for (const id of superIds) {
          const flows = schedule.superFlows[id];
          if (!flows) continue;
          const outcome = superOutcome[superMeta[id].owner];
          const ccGross = flows.sg[m] + flows.salarySacrifice[m] + flows.personalDeductible[m];
          const nccGross = flows.nonConcessional[m];
          const ccTax = ccGross * outcome.contributionsTaxRate;
          const nccAccepted = nccGross * outcome.nccAcceptRatio;
          superBal[id] += (ccGross - ccTax) + nccAccepted;
          // Non-concessional contributions build the tax-free
          // component explicitly (Commit 3 proportioning); concessional
          // contributions and growth build the taxable component
          // implicitly (they grow the balance without touching this).
          superTaxFree[id] += nccAccepted;
          row.superDetail[id].contributions += ccGross + nccAccepted;
          row.superDetail[id].contributionsTax += ccTax;
          row.superDetail[id].sg += flows.sg[m];
          row.superDetail[id].salarySacrifice += flows.salarySacrifice[m];
          row.superDetail[id].personalDeductible += flows.personalDeductible[m];
          row.superDetail[id].nonConcessional += nccAccepted;
        }
        // "toConcessionalCap" fills: credited once, in the FY's July
        // (see schedule.js's toConcessionalCapRows header comment) —
        // skipped entirely in a partial first year with no firing July
        // (convention 5), same as every other annual/one-off flow.
        if (m === julyOf(y)) {
          for (const p of persons) {
            for (const fill of superOutcome[p].fills) {
              const tax = fill.amount * superOutcome[p].contributionsTaxRate;
              superBal[fill.accountId] += fill.amount - tax; // concessional fill — taxable, no taxFree change
              row.superDetail[fill.accountId].contributions += fill.amount;
              row.superDetail[fill.accountId].contributionsTax += tax;
              if (fill.type === "personalDeductible") row.superDetail[fill.accountId].personalDeductible += fill.amount;
              else row.superDetail[fill.accountId].salarySacrifice += fill.amount;
            }
          }
        }
        // Explicit super withdrawals (Tier 1.2, Commit 3) — already
        // release-gated in schedule.js; proportioned tax-free/taxable
        // at THIS payment (accumulation interests recalculate every
        // time, unlike pensions, which fix the proportion once at
        // commencement — pensions are out of scope for this tier).
        // Never cascades, same as an explicit financial-asset
        // withdrawal — any shortfall is simply unfunded.
        for (const id of superIds) {
          const flows = schedule.superFlows[id];
          const want = flows ? flows.withdrawals[m] : 0;
          if (want > 0) {
            const paid = withdrawFromSuper(id, want);
            row.superDetail[id].withdrawals += paid;
            recordUnfunded(want - paid, m);
          }
        }
        // superSeries[id][m+1] is snapshotted at the TRUE end of this
        // month's processing (alongside series[id][m+1]/wcaSeries[m+1]
        // below), not here — step "d" (funding a WCA shortfall from
        // released super, further down this same month) still has to
        // debit superBal AFTER this point, and a snapshot taken here
        // would freeze the pre-debit balance, silently overstating the
        // reported closing balance by that debit whenever it fell in
        // the FY's last month (the only month with no following
        // month's fresh snapshot to catch it up) — found via the
        // conservation invariant once a demo scenario finally combined
        // a persistent monthly deficit with reaching super release age
        // (src/demo/highEarnerPreRetirement.js's "Reduce work at 58").
      }

      // a2. Properties (D4): planned purchases fire at this month's
      // top (July of the purchase FY); values grow at their rate;
      // investment rent and expenses accrue monthly.
      let settlementOut = 0;
      let rentIncome = 0;
      let propExpenseOut = 0;
      for (const pid in propMeta) {
        const pm = propMeta[pid];
        const p = propsById[pid];
        if (!pm.owned && pm.purchaseMonth === m) {
          // Purchase event: grown price, duty (nominal-law), costs,
          // FHOG, loan drawdown, settlement cash, cost base seed.
          const infl = inflAt(m);
          const realPrice = p.priceToday * Math.pow((1 + p.growthPct / 100) / (1 + cpi), m / 12);
          const nominalPrice = realPrice * infl;
          const dutyNominal = p.dutyOverride != null
            ? p.dutyOverride
            : dutyWithConcessions(p.state, nominalPrice, { firstHomeBuyer: p.firstHomeBuyer, newBuild: p.newBuild });
          const dutyReal = dutyNominal / infl;
          if (row && p.firstHomeGuarantee && fhbgPriceCapExceeded(p.state, nominalPrice)) {
            propertyWarnings.push({
              propertyId: pid, type: "fhbgPriceCap",
              reason: `Purchase price $${Math.round(nominalPrice).toLocaleString()} exceeds the ${p.state} First Home Guarantee price cap — confirm current eligibility`,
            });
          }
          const costsReal = (p.purchaseCostsPct / 100) * realPrice;
          const fhogReal = fhogAmount(p.state, nominalPrice, { firstHomeBuyer: p.firstHomeBuyer, newBuild: p.newBuild }) / infl;
          const loanReal = pm.loanId ? (p.lvrPct / 100) * realPrice : 0;
          // LMI (Document Set Commit 4), real-dollar equivalent of the
          // nominal premium fixed at loan setup above. Capitalised: the
          // lender actually advances loanReal + lmiReal, so the
          // reported drawdown must include it (settlement cash is
          // untouched — the extra borrowing pays for itself). Paid at
          // settlement: the loan itself is unaffected, but the buyer
          // needs lmiReal of extra cash at settlement instead.
          const lmiReal = pm.lmiNominal / infl;
          if (pm.loanId) {
            loanBal[pm.loanId] = liabsById[pm.loanId].balance; // drawdown, already includes capitalised LMI if any
            if (row) row.liabilities[pm.loanId].drawdown += loanReal + (pm.lmiCapitalised ? lmiReal : 0);
          }
          // Document Set Commit 3 (FHSSS) — the GROSS release reduces
          // settlement cash dollar for dollar (the ATO determination
          // amount really does arrive as cash before tax time); the
          // taxable component (85% of eligible concessional
          // contributions + all associated earnings) is recorded
          // against this FY's ordinary assessment instead of netted
          // here — the true marginal rate depends on the WHOLE FY's
          // income, most of which is still to come at a July
          // settlement, so it settles through the same PAYG/refund
          // mechanism as every other tax component in this engine
          // (HELP, MLS, CGT, Division 293/296). The actual super-
          // account debit is real-pass-only (gated on `row`, same
          // convention as every other balance mutation) — this
          // computation itself is deterministic and side-effect-free,
          // safe to run in both the measure and real pass.
          let fhsssReleasedHere = 0;
          for (const per of persons) {
            const rel = fhsssRelease?.[per];
            if (!rel || rel.propertyId !== pid) continue;
            fhsssReleasedHere += rel.grossRelease;
            acc[per].fhsssTaxableRelease += rel.taxableComponent;
            if (row) {
              // rel.grossRelease is already capped at the account's
              // available balance (see the outer per-year loop above),
              // so this should always pay the full amount — captured
              // and reported (row.superDetail[accountId].fhsssRelease)
              // rather than discarded, so the settlement-side credit
              // and the super-side debit are independently verifiable
              // as the same figure (conservationCheck.js's explicit
              // transfer assertion), not just assumed to match.
              const accountId = superAccountsByOwner[per]?.[0];
              if (accountId) {
                const paidFromSuper = withdrawFromSuper(accountId, rel.grossRelease);
                row.superDetail[accountId].fhsssRelease += paidFromSuper;
              }
            }
          }
          const lmiCash = pm.lmiCapitalised ? 0 : lmiReal;
          const settle = realPrice - loanReal + dutyReal + costsReal - fhogReal - fhsssReleasedHere + lmiCash;
          settlementOut += settle;
          propVal[pid] = realPrice;
          if (pm.isCgt) {
            propPools[pid] = createPool(realPrice + dutyReal + costsReal);
          }
          if (row) {
            row.properties[pid].settlement += settle;
            row.properties[pid].costBaseSeed = realPrice + dutyReal + costsReal;
            row.properties[pid].fhsssRelease = fhsssReleasedHere;
            row.properties[pid].lmi = lmiReal;
            // Focus Commit 2 follow-on: the same local variables above,
            // individually — see the field's own header comment.
            row.properties[pid].deposit = realPrice - loanReal;
            row.properties[pid].duty = dutyReal;
            row.properties[pid].costs = costsReal;
            row.properties[pid].fhog = fhogReal;
          }
        } else if (propVal[pid] > 0) {
          propVal[pid] *= 1 + pm.rate;
        }
        if (propVal[pid] > 0 && pm.invest) {
          const rentM = propFlowAt(pm.rent, m);
          const expM = propFlowAt(pm.expensesFlow, m);
          rentIncome += rentM;
          propExpenseOut += expM;
          acc._propNet[pid].rent += rentM;
          if (pm.expensesDeductible) acc._propNet[pid].expenses += expM;
          for (const per of persons) {
            const s = pm.shares[per];
            if (!s) continue;
            if (rentM > 0) {
              acc[per].ordinary += rentM * s;
              acc[per].incomeMonths.add(m);
            }
            if (pm.expensesDeductible) acc[per].deductions += expM * s;
            if (pm.depreciationMonthly > 0) acc[per].deductions += pm.depreciationMonthly * s;
          }
          if (row) {
            row.properties[pid].rent += rentM;
            row.properties[pid].expenses += expM;
            row.properties[pid].depreciation += pm.depreciationMonthly;
          }
        }
      }

      // b. Distribution + deduction accrual on the grown balance.
      let cashDist = 0;
      for (const id of ids) {
        const mt = meta[id];
        if (mt.incomeNominal > 0 && bal[id] > 0) {
          const dist = bal[id] * mt.incomeNominal / 12;
          const franked = dist * mt.frankingPct / 100;
          for (const p of persons) {
            const s = mt.shares[p];
            if (!s) continue;
            acc[p].franked += franked * s;
            acc[p].unfranked += (dist - franked) * s;
          }
          markIncome(mt.shares, m);
          if (mt.payout) cashDist += dist;
          else if (mt.cgt) pools[id] = poolAdd(pools[id], dist);
        }
        if (mt.icr > 0 && bal[id] > 0) {
          const ded = bal[id] * mt.icr / 12;
          for (const p of persons) {
            if (mt.shares[p]) acc[p].deductions += ded * mt.shares[p];
          }
        }
      }

      // c. Asset-targeted flows (lifestyle assets carry none).
      for (const id of ids) {
        const flows = schedule.assetFlows[id];
        if (!flows) continue;
        const contrib = flows.contributions[m];
        if (contrib > 0) {
          bal[id] += contrib;
          if (meta[id].cgt) pools[id] = poolAdd(pools[id], contrib);
          if (row) {
            row.contributions += contrib;
            row.perAssetDetail[id].contributions += contrib;
          }
        }
        const wd = flows.withdrawals[m];
        if (wd > 0) {
          const paid = sell(id, wd, m);
          if (row) {
            row.withdrawals += paid;
            row.perAssetDetail[id].withdrawals += paid;
          }
          recordUnfunded(wd - paid, m);
        }
        const oneOff = flows.oneOffs[m];
        if (oneOff > 0) {
          bal[id] += oneOff;
          if (meta[id].cgt) pools[id] = poolAdd(pools[id], oneOff);
          if (row) {
            row.oneOffsNet += oneOff;
            row.perAssetDetail[id].oneOffs += oneOff;
          }
        } else if (oneOff < 0) {
          const paid = sell(id, -oneOff, m);
          if (row) {
            row.oneOffsNet -= paid;
            row.perAssetDetail[id].oneOffs -= paid;
          }
          recordUnfunded(-oneOff - paid, m);
        }
      }

      // c2. Liabilities (D3): accrue interest on the offset-reduced
      // nominal balance, pay the contractual amount (IO = interest as
      // charged; P&I = the level payment; final month part-pays), and
      // deflate for the ledger. Deductible interest joins the owner's
      // deductions like ICR.
      let loanPayReal = 0;
      for (const l of liabs) {
        const md = liabMeta[l.id];
        const b0 = loanBal[l.id];
        if (b0 <= 0 || m < md.startMonth) continue;
        const mRel = m - md.startMonth;
        const infl = inflAt(m);
        const offsetNom = md.offsetId ? Math.min(bal[md.offsetId] * infl, b0) : 0;
        // Fixed-rate rollover (Implementation/Rates spec, Commit 1): the
        // rate switches exactly at rolloverMonth, unconditional on
        // IO/P&I status — md.i already IS the correct pre-rollover rate
        // (fixed or plain variable) from setup, so a variable loan
        // (rolloverMonth stays null) takes this branch's `false` arm
        // every month and is bit-identical to before this feature.
        const baseRate = md.rolloverMonth != null && m >= md.rolloverMonth ? md.revertRate : md.i;
        // Monte Carlo rate linkage (What-if spec, Commit 5): the delta
        // is ADDED to the deterministic rate, never replaces it (same
        // convention as shockFor for asset returns) — a fixed loan's
        // own CONTRACTED rate stays untouched before its own rollover
        // (the whole point of a fixed loan), exactly the differential
        // Commit 2's deterministic rate shocks already established;
        // every other case (a variable loan, or a fixed one past its
        // own rollover) tracks the simulated path's own CPI deviation.
        const isFixedPreRollover = md.rateType === "fixed" && (md.rolloverMonth == null || m < md.rolloverMonth);
        const rateDelta = mortgageRateDeltaForYear && !isFixedPreRollover
          ? mortgageRateDeltaForYear(schedule.yearOfMonth[m]) / 12
          : 0;
        const rate = baseRate + rateDelta;
        let pmtPI;
        if (mortgageRateDeltaForYear && !isFixedPreRollover) {
          // See mcActivePmt's own declaration above for why recomputing
          // every July is safe even when the rate never actually moves.
          if (mRel >= md.ioM && (mcActivePmt[l.id] == null || mcJulyMonths.has(m))) {
            mcActivePmt[l.id] = levelPayment(b0, rate, md.termM - mRel);
          }
          pmtPI = mcActivePmt[l.id] ?? md.pmtPI;
        } else {
          // Unchanged from before Commit 5 — recomputes exactly ONCE, at
          // the trigger month, over the CURRENT balance and remaining
          // term — then holds fixed exactly like the original
          // pre-rollover payment ("the step change in repayment is the
          // point of the feature — do not smooth it"). Guarded by
          // postRolloverPmt[l.id] == null so a later month revisiting
          // this branch (there is none within a single pass, but the
          // measurement/real replay reaches this month twice per year)
          // doesn't re-derive it from an already-amortised balance.
          if (md.recomputeTriggerMonth != null && m >= md.recomputeTriggerMonth && postRolloverPmt[l.id] == null) {
            postRolloverPmt[l.id] = levelPayment(b0, md.revertRate, md.termM - mRel);
          }
          pmtPI = postRolloverPmt[l.id] ?? md.pmtPI;
        }
        const interest = (b0 - offsetNom) * rate;
        const contractual = mRel < md.ioM ? interest : pmtPI;
        const payment = Math.min(Math.max(contractual, 0), b0 + interest);
        // Extra/lump-sum repayments (Document Set Commit 5): a
        // household cash outflow through the WCA exactly like the
        // contractual payment above — an unaffordable amount still
        // reduces the balance (same "the event happens regardless of
        // funding" convention property settlement already uses), while
        // the CASH side flows into `net` below and hits the EXISTING
        // deficit-funding/unfunded cascade, which is where
        // unaffordability actually surfaces. Capped at whatever
        // balance remains after the contractual payment — never
        // overpays, and stops contributing once the loan reaches zero
        // (the b0 <= 0 guard above).
        const extraReal = schedule.liabilityExtraFlows?.[l.id]?.[m] ?? 0;
        const extraNominal = extraReal * infl;
        const extraApplied = Math.min(Math.max(0, extraNominal), Math.max(0, b0 + interest - payment));
        let b1 = b0 + interest - payment - extraApplied;
        if (b1 < 1e-9) b1 = 0;
        loanBal[l.id] = b1;
        const defl = 1 / infl;
        loanPayReal += (payment + extraApplied) * defl;
        const interestReal = interest * defl;
        // Surplus/deficit allocation spec, Commit 1: deductibleFraction
        // replaces the old all-or-nothing boolean — a part-deductible
        // loan deducts that proportion of its interest, same as before
        // when the fraction is exactly 0 or 1.
        if (md.deductibleFraction > 0 && interestReal > 0) {
          const deductibleInterestReal = interestReal * md.deductibleFraction;
          for (const p of persons) {
            if (md.shares[p]) {
              acc[p].deductions += deductibleInterestReal * md.shares[p];
              // Interest on a loan tied to an investment property joins
              // that property's gearing calculation (D4).
              if (md.propertyId && propMeta[md.propertyId]?.invest) {
                acc._propNet[md.propertyId].interest[p] += deductibleInterestReal * md.shares[p];
              }
            }
          }
        }
        if (row) {
          row.liabilities[l.id].interest += interestReal;
          row.liabilities[l.id].principal += (payment - interest) * defl;
          row.liabilities[l.id].extraRepayment += extraApplied * defl;
          // Snapshot, not a sum — overwritten every month so it holds
          // the year-end value, same convention as closing.
          row.liabilities[l.id].offsetApplied = offsetNom * defl;
          // Nominal annual rate applying THIS month (Commit 1) —
          // rollover always lands on a plan-year boundary (July), so a
          // full plan year only ever sees one rate; this snapshot holds
          // whichever one was current at year-end, same convention as
          // closing/offsetApplied. Genuinely 0 for HELP (no separate
          // liab loop entry — see mkYearRow's own header), which is
          // correct: HELP charges no interest, only indexation.
          row.liabilities[l.id].ratePct = rate * 12 * 100;
          liabSeries[l.id][m + 1] = b1 / inflAt(m + 1);
        }
      }

      // Goals (Document Set Commit 6), asset-funded: a scheduled
      // withdrawal via the SAME sell() every other asset-affecting
      // cashflow uses — unconditional in both passes (bal/pools are
      // snapshotted/restored around them), naturally capped at the
      // asset's own balance, so a goal simply accrues slower once its
      // funding asset runs low (no separate "unfunded" plumbing needed
      // the way a surplus-funded goal needs, below).
      for (const g of goals) {
        const gm = goalMeta[g.id];
        if (!gm || gm.fundedFrom === "surplus" || !gm.assetOk || m >= gm.targetMonth) continue;
        const contributed = sell(gm.fundedFrom, gm.requiredMonthly, m);
        if (row) { row.goals[g.id].contribution += contributed; goalAccruedTotal[g.id] += contributed; }
      }

      // c. Household net, including tax outflows (decision 14) —
      // applied to the WCA balance rather than spent/sold immediately
      // (Working Cash Account fix): this is what lets an annual lump
      // of income (e.g. a July salary) cover the months before and
      // after it, instead of being "spent" that one month while the
      // rest of the year runs spurious deficit-funding sales.
      // A salarySacrifice-type toConcessionalCap fill reduces household
      // cash income the same month it's resolved, exactly like an
      // explicit salary-sacrifice row already does upstream in
      // schedule.js (see a-super-fill above).
      const inc = schedule.income[m] + cashDist + rentIncome - fillSalarySacrifice.client - fillSalarySacrifice.partner;
      for (const p of persons) {
        const own = p === "partner" ? schedule.incomeByOwner.partner : schedule.incomeByOwner.client;
        if (own && own[m] > 0) {
          acc[p].ordinary += own[m];
          acc[p].incomeMonths.add(m);
        }
        if (fillSalarySacrifice[p] > 0) acc[p].ordinary -= fillSalarySacrifice[p];
      }
      const exp = schedule.expenses[m];
      const tax = (taxOut ? taxOut[m] : 0) + (m === first ? cgtDue : 0);
      // Personal deductible/non-deductible/spouse super contributions
      // (engine-correctness fix) are paid from household cash, exactly
      // like any other outflow — SG (employer-paid, on top of salary)
      // and salary sacrifice (already reflected as reduced income,
      // upstream in schedule.js) are excluded here, or they'd be
      // debited twice. Without this, super gains the contribution and
      // tax falls by the deduction, but nothing ever leaves the
      // household — the original defect. fillCashDebit (a-super-fill
      // above) extends this to a personalDeductible toConcessionalCap
      // fill — same rule, same fallback if cash can't cover it.
      const superContribCashOut = superIds.reduce((s, id) => {
        const flows = schedule.superFlows[id];
        return s + (flows ? flows.personalDeductible[m] + flows.nonConcessional[m] : 0);
      }, 0) + fillCashDebit;
      // Adviser fees, outside-super cash (Implementation/Rates spec,
      // Commit 2) — UNGATED, exactly like exp/tax/superContribCashOut
      // above: this can force a deficit-funded asset sale (a real
      // realised gain), which the tax measurement pass must see too,
      // not just the real pass. Upfront fires once, at month 0 of the
      // whole projection; ongoing flows monthly. Each also carries its
      // OWN shortfall — whatever the nominated super account couldn't
      // cover falls back to cash here, "paid personally" per the spec.
      const upfrontCashOut = m === 0 ? upfrontOutsideOnly + upfrontFromSuperShortfall : 0;
      const ongoingCashOut = ongoingOutsideMonthlyAt(m) + (m === first ? ongoingFromSuperShortfall : 0);
      const adviserFeeCashOut = upfrontCashOut + ongoingCashOut;
      let net = inc - (exp + propExpenseOut) - tax - loanPayReal - settlementOut - superContribCashOut - adviserFeeCashOut;
      // Goals, surplus-funded: capped at whatever's actually left over
      // this month (a goal can't manufacture cash that doesn't exist,
      // unlike an instructed transaction such as a loan repayment or a
      // property purchase — those happen regardless of funding, with
      // ONLY their cash consequence flowing to deficit-then-unfunded;
      // a discretionary savings contribution has no equivalent "happens
      // anyway" event). Multiple surplus-funded goals in the same month
      // compete for the SAME pool, in plan order — a disclosed
      // simplification, not a priority system.
      for (const g of goals) {
        const gm = goalMeta[g.id];
        if (!gm || gm.fundedFrom !== "surplus" || m >= gm.targetMonth) continue;
        const contributed = Math.min(gm.requiredMonthly, Math.max(0, net));
        net -= contributed;
        if (row) { row.goals[g.id].contribution += contributed; goalAccruedTotal[g.id] += contributed; }
      }
      wcaBal += net;
      if (row) {
        row.income += inc;
        row.cashDistributions += cashDist;
        row.expenses += exp + propExpenseOut;
        row.tax += tax;
        // Adviser fees (Commit 2) — outsideCash/requestedFromSuper let
        // the UI show "cap, requested, shortfall" without recomputing
        // anything (shortfall = requestedFromSuper − paidFromSuper,
        // the latter credited above, before growth, alongside
        // superDetail[id].adviserFee). outsideCash deliberately excludes
        // any from-super shortfall — that's already folded into
        // adviserFeeCashOut/net above; keeping it separate here is what
        // makes "requested vs paid vs shortfall" a clean read.
        if (m === 0) {
          row.adviserFeesUpfront.outsideCash += upfrontOutsideOnly;
          row.adviserFeesUpfront.requestedFromSuper += upfrontFee.fromSuperAmount;
        }
        row.adviserFeesOngoing.outsideCash += ongoingOutsideMonthlyAt(m);
        if (m === first) row.adviserFeesOngoing.requestedFromSuper += ongoingFromSuperRequested;
        row.surplusOrDeficit += net;
        row.wcaDetail.netFlow += net;
      }

      // d. Top the WCA back up to its minimum from fundingOrder (then
      // released super, same fallback as before) when this month's net
      // has pushed it below — fundingOrder never touches the WCA above
      // minimum; it only ever refills it. No monthly surplus sweep:
      // surplus just sits in the WCA, growing, until FY-end below.
      //
      // Deficit side (Surplus and Deficit Allocation spec, Commit 1):
      // sellOrder is fundingOrder itself, or — under "minimumCapitalGain"
      // — fundingOrder's own ids re-ranked by smallest unrealised gain
      // as a proportion of value (a non-CGT asset, e.g. cash, always
      // sorts first, since selling it realises nothing); recomputed
      // fresh every month this fires, since balances/pools move between
      // months. Two passes over that SAME order: first draw each asset
      // down to its own minimumBalances floor (default 0 — the pre-
      // Commit-1 behaviour when nothing is configured), then — only
      // once every asset is AT its floor — draw below them, same order,
      // before falling back to super then truly unfunded.
      if (wcaBal < wca.minimumBalance) {
        let shortfall = wca.minimumBalance - wcaBal;
        const gainRatio = (id) => {
          if (!meta[id].cgt) return -Infinity; // no CGT — realises nothing, always sells first
          const value = bal[id];
          if (value <= 0) return Infinity;
          return (value - pools[id].pool) / value;
        };
        const sellOrder = deficitSellRule === "minimumCapitalGain"
          ? [...fundingOrder].sort((a, b) => gainRatio(a) - gainRatio(b))
          : fundingOrder;
        const drawTo = (floorOf) => {
          for (const id of sellOrder) {
            if (shortfall <= 0) break;
            const floor = floorOf(id);
            const available = Math.max(0, bal[id] - floor);
            if (available <= 0) continue;
            const paid = sell(id, Math.min(shortfall, available), m);
            shortfall -= paid;
            wcaBal += paid;
            if (row) {
              row.deficitFundedFromAssets += paid;
              row.perAssetDetail[id].deficitFunding += paid;
            }
          }
        };
        drawTo((id) => deficitMinimums[id] ?? 0);
        if (shortfall > 0) drawTo(() => 0); // every asset's own minimum exhausted — draw below them, same order
        // Super (Tier 1.2, Commit 3): drawn ONLY after the ordinary
        // funding order is exhausted, in account-list order, and ONLY
        // from accounts whose owner has met a condition of release
        // this plan year — before that, they are invisible to deficit
        // funding, as they must be. Real pass only: super never
        // affects the tax measurement pass (no realised-gain/CGT
        // concept in accumulation phase), so there is nothing to
        // snapshot/roll back here, unlike the financial-asset sells
        // above.
        if (row && shortfall > 0) {
          for (const id of superIds) {
            if (shortfall <= 0) break;
            if (!superReleased[superMeta[id].owner]) continue;
            const paid = withdrawFromSuper(id, shortfall);
            shortfall -= paid;
            wcaBal += paid;
            row.superDetail[id].withdrawals += paid;
          }
        }
        if (shortfall > 0) {
          // Truly unfunded — same "balances never go negative"
          // convention as every other balance in this engine. The
          // shortfall is reported once, here, via recordUnfunded; it
          // must NOT persist as a negative WCA balance, or it would
          // compound (via WCA interest) and be rediscovered — bigger
          // each time — every subsequent month (unchanged semantics
          // means one unfunded month reports that month's gap, not a
          // running total of every gap since the funding order ran
          // out).
          wcaBal = wca.minimumBalance;
        }
        recordUnfunded(shortfall, m);
      }

      // FY-end sweep (Surplus and Deficit Allocation spec, Commit 1):
      // the WCA's balance above minimumBalance, only on the FY's final
      // month, routed through the period covering this plan year —
      // replaces the old single-destination settings.surplus.mode
      // sweep with a waterfall: non-deductible debt first (optional),
      // then percentage allocations across up to four destination
      // types, then an explicit remainder. Asset/liability balance
      // moves are UNGATED (bal/loanBal are snapshotted and restored
      // around the measurement pass, same as every other mutation to
      // them — see loanSnap/balSnap above); super crediting and goal
      // accrual are real-pass-only, same as every other super/goal
      // mutation in this engine, since neither has that snapshot and
      // neither feeds the tax measurement pass regardless of when
      // (both settle with zero tax effect in the SAME year they're
      // paid — this whole sweep only ever fires in the FY's LAST
      // month, so nothing it does can still be growing/earning income
      // measured in this same year either way).
      if (m === last - 1 && wcaBal > wca.minimumBalance) {
        const surplusPeriod = resolveSurplusPeriod(y);
        if (surplusPeriod) {
          let remaining = wcaBal - wca.minimumBalance;

          // Step 1 — pay non-deductible debt first. Ranked by
          // interest rate (descending) or manual (state.liabilities'
          // own order); a part-deductible loan's eligible amount is
          // its CURRENT balance times its non-deductible proportion,
          // recomputed fresh each year (a disclosed simplification —
          // not a separately tracked non-deductible sub-balance, see
          // docs/specs/16-surplus-allocation.md's own Commit 1 for why
          // this proportional reading is what "treat a part-deductible
          // loan proportionally" means here).
          if (surplusPeriod.payNonDeductibleDebtFirst && remaining > 0) {
            const rateAt = (l) => {
              const md = liabMeta[l.id];
              return md.rolloverMonth != null && julyOf(y) >= md.rolloverMonth ? md.revertRate : md.i;
            };
            const candidates = liabs.filter((l) => loanBal[l.id] > 0 && liabMeta[l.id].deductibleFraction < 1);
            const ordered = surplusPeriod.debtOrder === "interestRate"
              ? [...candidates].sort((a, b) => rateAt(b) - rateAt(a))
              : candidates; // "manual" — the order liabilities are entered in the Liabilities section
            for (const l of ordered) {
              if (remaining <= 0) break;
              const nonDeductibleBalance = loanBal[l.id] * (1 - liabMeta[l.id].deductibleFraction);
              const pay = Math.min(remaining, nonDeductibleBalance);
              if (pay <= 0) continue;
              loanBal[l.id] -= pay;
              wcaBal -= pay;
              remaining -= pay;
              if (row) row.liabilities[l.id].surplusRepayment += pay;
            }
          }

          // Step 2 — percentage allocations, applied to whatever's
          // left after Step 1 (not the original excess) — a period
          // that pays non-deductible debt first and ALSO allocates
          // 60%/40% splits the REMAINING pool that way, not the whole
          // surplus. Repayments/contributions stop at their own
          // ceiling (a liability's balance, a person's remaining
          // concessional cap headroom); whatever an entry couldn't
          // absorb falls through to the NEXT entry — never lost —
          // exactly like a liability's own extra repayment already
          // stops at its balance.
          const poolForPct = remaining;
          for (const a of surplusPeriod.allocations) {
            if (remaining <= 0) break;
            const share = Math.min(remaining, poolForPct * (a.pct / 100));
            if (share <= 0) continue;
            let consumed = 0;
            if (a.targetType === "asset") {
              consumed = share;
              wcaBal -= consumed;
              bal[a.targetId] += consumed;
              if (meta[a.targetId].cgt) pools[a.targetId] = poolAdd(pools[a.targetId], consumed);
              if (row) {
                row.surplusInvested += consumed;
                row.perAssetDetail[a.targetId].surplusInvested += consumed;
                row.wcaDetail.sweptInvested += consumed;
              }
            } else if (a.targetType === "liability") {
              consumed = Math.min(share, loanBal[a.targetId]);
              if (consumed > 0) {
                loanBal[a.targetId] -= consumed;
                wcaBal -= consumed;
                if (row) row.liabilities[a.targetId].surplusRepayment += consumed;
              }
            } else if (a.targetType === "superContribution" && row) {
              // Real pass only — superBal has no measurement-pass
              // snapshot/restore, same as every other super credit.
              // Disclosed simplification: capped at the person's
              // remaining concessional cap headroom and taxed at the
              // concessional rate like any other concessional
              // contribution, but — because the allocated amount isn't
              // known until the WCA's own FY-end balance is, well
              // after this FY's tax has already been measured — it
              // does NOT reduce this FY's assessable income the way an
              // ordinary personal-deductible contribution would. The
              // cash/super-balance movement is correct; the tax timing
              // is a documented gap, not a silent one.
              const target = surplusSuperTargets[a.targetId];
              const headroom = Math.max(0, superOutcome[target.owner]?.concessionalHeadroomAfterFills ?? 0);
              consumed = Math.min(share, headroom);
              if (consumed > 0) {
                const taxRate = superOutcome[target.owner].contributionsTaxRate;
                const tax = consumed * taxRate;
                superBal[target.accountId] += consumed - tax;
                wcaBal -= consumed;
                row.superDetail[target.accountId].contributions += consumed;
                row.superDetail[target.accountId].contributionsTax += tax;
                if (target.type === "personalDeductible") {
                  row.superDetail[target.accountId].personalDeductible += consumed;
                } else {
                  row.superDetail[target.accountId].salarySacrifice += consumed;
                  // See the field's own comment: this slice passed
                  // through wcaBal above, unlike a genuine payroll
                  // salary sacrifice — conservationCheck.js needs it
                  // named separately so it isn't also added back.
                  row.superDetail[target.accountId].surplusSalarySacrifice += consumed;
                }
                // So a LATER allocation entry targeting a different
                // contribution row for the SAME person can't also
                // believe the full headroom is still available — the
                // exact class of bug reserveFromSuper closed for
                // adviser fees/Division 293/296/FHSSS sharing one
                // account (conservationCheck.js's own header).
                superOutcome[target.owner].concessionalHeadroomAfterFills -= consumed;
              }
            } else if (a.targetType === "goal" && row) {
              // Real pass only, same as every other goal accrual —
              // goalAccruedTotal has no measurement-pass equivalent.
              consumed = share;
              wcaBal -= consumed;
              row.goals[a.targetId].contribution += consumed;
              goalAccruedTotal[a.targetId] += consumed;
            }
            remaining -= consumed;
          }

          // Step 3 — remainder.
          if (remaining > 0) {
            if (surplusPeriod.remainderTo === "expenditure") {
              wcaBal -= remaining;
              if (row) {
                row.surplusSpent += remaining;
                row.wcaDetail.sweptSpent += remaining;
              }
            } else if (row) {
              // "cash" (default): stays in the WCA — nothing moves,
              // just recorded for the Funding section's own row.
              row.surplusAccumulated += remaining;
              row.wcaDetail.sweptToCash += remaining;
            }
          }
        }
      }

      if (row) {
        let total = 0;
        for (const id of ids) {
          series[id][m + 1] = bal[id];
          total += bal[id];
        }
        combined[m + 1] = total;
        wcaSeries[m + 1] = wcaBal;
        // Taken here, at the TRUE end of the month — after step "d"'s
        // possible deficit-funding-from-super debit above — so a
        // shortfall funded from super in the FY's last month isn't
        // silently missing from the reported closing balance (see the
        // comment where this used to live, earlier in this function).
        for (const id of superIds) superSeries[id][m + 1] = superBal[id];
        // Surplus/deficit allocation spec, Commit 1: liabSeries is
        // ALSO snapshotted too early for the same reason — the
        // per-liability loop (above, earlier this month) sets it right
        // after the scheduled payment/extraRepayment, but the FY-end
        // surplus sweep's non-deductible-first step and any liability
        // allocation both debit loanBal LATER in this same month.
        // Refreshed here, unconditionally, exactly like superSeries —
        // cheap, and correct regardless of whether this month actually
        // carried a surplus repayment.
        for (const l of liabs) liabSeries[l.id][m + 1] = loanBal[l.id] / inflAt(m + 1);
      }
    }
    return acc;
  }

  // Even spread of a person's income tax across their income months;
  // a refund (negative) lands whole in the FY's final month.
  const taxOutArr = new Float64Array(months);
  function spreadTax(amount, incomeMonths, lastM) {
    if (amount === 0) return;
    if (amount < 0 || incomeMonths.size === 0) {
      taxOutArr[lastM] += amount;
      return;
    }
    const per = amount / incomeMonths.size;
    for (const m of incomeMonths) taxOutArr[m] += per;
  }

  // --- year loop -------------------------------------------------------------
  for (let y = 0; y < years; y++) {
    const fyStart = fy0 + y;

    // Shared per-account "already spoken for" tally (Implementation/
    // Rates spec, Commit 2 follow-on) — FOUR independent mechanisms can
    // each want to release from super in the SAME year (adviser fees,
    // Division 293/296, FHSSS), all resolved "once per FY, before
    // either pass, against the opening balance" for the SAME reason
    // (a shortfall mustn't depend on which pass computes it). But
    // "before either pass" means none of them has actually touched
    // superBal yet — read independently, EACH would see the FULL
    // current balance and could believe it alone can cover its full
    // request, even though another mechanism targeting the SAME
    // account already claimed part of it this same year. reserve()
    // resolves them in a FIXED order (adviser fees, then Division
    // 293/296, then FHSSS — matching the order they actually debit
    // inside runYear) against what's left AFTER earlier claims, so the
    // SUM of what every mechanism believes it can take never exceeds
    // what the account actually holds. This is the same class of bug
    // as the FHSSS-release money-creation fix this file's own header
    // references (conservationCheck.js) — found here via the identical
    // invariant, once adviser fees made two draws on the same account
    // in the same year common enough to hit in the random-scenario
    // suite.
    const superReservedThisYear = {};
    const reserveFromSuper = (accountId, amount) => {
      if (!accountId || !(amount > 0)) return 0;
      const already = superReservedThisYear[accountId] ?? 0;
      const remaining = Math.max(0, (superBal[accountId] ?? 0) - already);
      const claimed = Math.min(amount, remaining);
      superReservedThisYear[accountId] = already + claimed;
      return claimed;
    };

    // Adviser fees (Commit 2) — resolved first (see reserveFromSuper's
    // own header for the ordering this depends on). Upfront only ever
    // has anything to resolve in year 0 (it fires once, at month 0 of
    // the whole projection); ongoing resolves every year.
    const upfrontFromSuperPaid = y === 0 ? reserveFromSuper(upfrontFee.superAccountId, upfrontFee.fromSuperAmount) : 0;
    const upfrontFromSuperShortfall = y === 0 ? upfrontFee.fromSuperAmount - upfrontFromSuperPaid : 0;
    const ongoingFromSuperRequested = ongoingFee.superAccountId
      ? ongoingAnnualRealAt(yearStart(y)) * ongoingSuperFraction : 0;
    const ongoingFromSuperPaid = reserveFromSuper(ongoingFee.superAccountId, ongoingFromSuperRequested);
    const ongoingFromSuperShortfall = ongoingFromSuperRequested - ongoingFromSuperPaid;

    const div293DueDetail = y > 0 ? pendingDiv293 : { client: 0, partner: 0 };
    const div296DueDetail = y > 0 ? pendingDiv296 : { client: 0, partner: 0 };
    const div293Due = div293DueDetail.client + div293DueDetail.partner;
    const div296Due = div296DueDetail.client + div296DueDetail.partner;
    // Positive refundDue = net refund settling this FY (reduces the
    // household's tax outflow); negative = a net balancing payment
    // owed (increases it) — see the assessment loop below.
    const refundDue = y > 0 ? pendingRefund.client + pendingRefund.partner : 0;

    // Division 293/296: release from super by default. Resolved ONCE
    // per FY, here, BEFORE either pass runs — using `superBal` at its
    // opening-of-year value (neither pass has touched it yet this
    // year), the same "resolve once against pre-pass state" pattern
    // superOutcome/tsbOpening below already use for contribution caps.
    // A release authority is NOT a benefit payment: it's not
    // assessable, not subject to lump-sum tax, and — critically —
    // NOT gated by the preservation/condition-of-release check
    // (superReleased in runYear) that ordinary withdrawals go through.
    // withdrawFromSuper() itself has no such gate built in (the gate is
    // applied at ordinary-withdrawal call sites only), so calling it
    // directly here is sufficient to bypass preservation correctly.
    const divReleaseFromSuper = { client: 0, partner: 0 };
    const divReleaseAccountId = { client: null, partner: null };
    const divReleaseCash = { client: 0, partner: 0 };
    for (const p of persons) {
      const person = p === "partner" ? state.plan.partner : state.plan.client;
      const personDue = div293DueDetail[p] + div296DueDetail[p];
      if (personDue <= 0) continue;
      const paidFrom = person?.super?.divTaxPaidFrom === "cash" ? "cash" : "super";
      if (paidFrom === "cash") { divReleaseCash[p] = personDue; continue; }
      const candidateIds = superAccountsByOwner[p] ?? [];
      const nominated = person?.super?.divTaxReleaseAccountId;
      // Defensive fallback (same pattern as fundingOrder/
      // surplusTargetId elsewhere): a stale/missing nomination falls
      // back to the largest-balance account for this owner, or to cash
      // if the owner has no super account at all.
      let accountId = candidateIds.includes(nominated)
        ? nominated
        : candidateIds.reduce((best, id) => (best === null || superBal[id] > superBal[best] ? id : best), null);
      if (accountId === null) {
        divReleaseCash[p] = personDue;
        superWarnings.push({
          fyLabel: schedule.fyLabels[y], owner: p, type: "divTaxRelease",
          reason: `Division 293/296 is set to release from super, but ${p} has no super account — $${Math.round(personDue)} paid from household cash instead`,
        });
        continue;
      }
      // reserveFromSuper, not a plain Math.min against superBal — see
      // its own header: adviser fees may have already claimed part of
      // this SAME account this SAME year, resolved just above.
      const released = reserveFromSuper(accountId, personDue);
      divReleaseFromSuper[p] = released;
      divReleaseAccountId[p] = accountId;
      // Insufficient balance: take what's there, fall back to cash for
      // the remainder (which then flows through the normal fundingOrder
      // → unfunded cascade like any other household outflow).
      divReleaseCash[p] = personDue - released;
      if (divReleaseCash[p] > 1e-6) {
        superWarnings.push({
          fyLabel: schedule.fyLabels[y], owner: p, type: "divTaxRelease",
          reason: `Super balance couldn't cover the full Division 293/296 release — $${Math.round(divReleaseCash[p])} fell back to household cash`,
        });
      }
    }
    const cgtDue = (y > 0 ? pendingCgt.client + pendingCgt.partner : 0)
      + divReleaseCash.client + divReleaseCash.partner - refundDue;
    const cgtDueDetail = y > 0 ? pendingCgt : { client: 0, partner: 0 };

    // Super contribution caps (Tier 1.2, Commit 2): resolved ONCE per
    // FY, before either pass — concessional carry-forward and NCC
    // bring-forward are year-SEQUENTIAL state that must advance exactly
    // once per real FY, not once per measurement/real pass. The outcome
    // (contributions tax rate, the accepted NCC fraction, dynamic
    // "toConcessionalCap" fills, excess CC, and the Div293 inputs) is
    // handed to runYear for crediting in the real pass only.
    const superRatesY = superRatesFor(fyStart, bracketMode, cpi, awoteAssum);
    const helpRatesY = helpRatesFor(fyStart, bracketMode, cpi, awoteAssum);
    const mlsRatesY = mlsRatesFor(fyStart, bracketMode, cpi, awoteAssum);
    const superOutcome = { client: null, partner: null };
    // Cap headroom snapshot (Tier 1.2, Commit 4 UI): the cap and
    // carry-forward available BEFORE this FY's toConcessionalCap fills
    // consume it — the "constraint row" figure shown live beside each
    // concessional contribution row. Reported alongside superOutcome,
    // not folded into it, since it's display-only and never feeds tax.
    const superCapUsage = { client: null, partner: null };
    // TSB at the start of the FY, per person — captured here (before
    // this year's crediting) for Division 296's "higher of opening or
    // closing TSB" rule below, once the real pass has produced closing.
    const tsbOpening = { client: 0, partner: 0 };
    for (const p of persons) {
      const tsbPriorJune = superAccountsByOwner[p].reduce((s, id) => s + superBal[id], 0);
      tsbOpening[p] = tsbPriorJune;
      let grossSG = 0, grossSS = 0, grossPD = 0, grossNCC = 0;
      for (const id of superAccountsByOwner[p]) {
        const flows = schedule.superFlows[id];
        if (!flows) continue;
        for (let m = yearStart(y); m < yearEnd(y); m++) {
          grossSG += flows.sg[m];
          grossSS += flows.salarySacrifice[m];
          grossPD += flows.personalDeductible[m];
          grossNCC += flows.nonConcessional[m];
        }
      }
      const otherConcessional = grossSG + grossSS + grossPD;
      const carryForwardAvailable = availableCarryForward(
        superCarryForward[p], tsbPriorJune, superRatesY.carryForwardTsbGate
      );
      superCapUsage[p] = {
        cap: superRatesY.concessionalCap,
        carryForwardAvailable,
        sg: grossSG,
        salarySacrifice: grossSS,
        personalDeductible: grossPD,
        available: Math.max(0, superRatesY.concessionalCap + carryForwardAvailable - otherConcessional),
      };

      // "toConcessionalCap": fills whatever headroom remains — resolved
      // here (not schedule.js) because it needs the LIVE carry-forward
      // ledger. Processed in row order so a second such row (unusual)
      // sees the first row's fill.
      let fillTotal = 0;
      const fills = [];
      for (const tc of schedule.toConcessionalCapRows) {
        if (tc.owner !== p || y < tc.fromYear || y > tc.toYear) continue;
        const age = p === "partner" ? schedule.partnerAges?.[y] : schedule.clientAges[y];
        const allowed = superContributionAllowed(tc.type, age, workTestMetFor(p), superRatesY);
        if (!allowed.ok) {
          superWarnings.push({ fyLabel: schedule.fyLabels[y], owner: p, type: tc.type, reason: allowed.reason });
          continue;
        }
        const capAvailableNow = superRatesY.concessionalCap +
          availableCarryForward(superCarryForward[p], tsbPriorJune, superRatesY.carryForwardTsbGate);
        const headroom = Math.max(0, capAvailableNow - otherConcessional - fillTotal);
        if (headroom <= 0) continue;
        fills.push({ accountId: tc.accountId, amount: headroom, type: tc.type });
        fillTotal += headroom;
      }

      const totalCC = otherConcessional + fillTotal;
      const ccResult = processConcessionalCap({
        totalCC, baseCap: superRatesY.concessionalCap, carryForward: superCarryForward[p],
        tsbPriorJune, gate: superRatesY.carryForwardTsbGate,
      });
      superCarryForward[p] = ccResult.newCarryForward;

      const nccResult = processNonConcessionalCap({
        requestedNCC: grossNCC, baseCap: superRatesY.nonConcessionalCap, tsbPriorJune,
        thresholds: superRatesY.bringForwardTsbThresholds, bringForward: superBringForward[p], planYear: y,
      });
      superBringForward[p] = nccResult.bringForward;
      if (nccResult.rejected > 1e-6) {
        superWarnings.push({
          fyLabel: schedule.fyLabels[y], owner: p, type: "nonConcessional",
          reason: `Exceeds the non-concessional cap — $${Math.round(nccResult.rejected)} rejected`,
        });
      }

      superOutcome[p] = {
        contributionsTaxRate: superRatesY.contributionsTaxRate,
        nccAcceptRatio: grossNCC > 0 ? nccResult.accepted / grossNCC : 1,
        fills,
        excessCC: ccResult.excess,
        reportableSuperContributions: grossSS + grossPD + fillTotal,
        lowTaxContributions: Math.min(totalCC, ccResult.capAvailable),
        // Surplus/deficit allocation spec, Commit 1: remaining
        // concessional headroom AFTER this FY's toConcessionalCap fills
        // (fillTotal, above) — the ceiling a surplus allocation to an
        // existing salary-sacrifice/personal-deductible row can still
        // fill, resolved here so it can't independently believe it has
        // the SAME headroom toConcessionalCap already consumed (the
        // exact class of bug reserveFromSuper closed for adviser fees/
        // Division 293/296/FHSSS sharing one account).
        concessionalHeadroomAfterFills: Math.max(0, superCapUsage[p].available - fillTotal),
      };
    }

    // Document Set Commit 3 (FHSSS) — resolved once per FY, before
    // either pass (same "year-sequential state" reasoning as the super
    // cap outcome above): associated earnings accrue for the year on
    // the OPENING balance, then this FY's FHSSS-eligible voluntary
    // contributions (schedule.fhsssFlows) are accepted up to the
    // combined $15,000/year, $50,000/lifetime cap.
    //
    // fhsssYearDetail (Focus Commit 3 follow-on): the same figures,
    // captured for row.fhsssDetail below — written onto the row in Pass
    // 2 (deterministic, side-effect-free arithmetic, safe to compute
    // once here like superCapUsage). Captured BEFORE the release block
    // further down deliberately: it reports the accrual step alone, not
    // this year's release (which is already fully reported via
    // row.superDetail[...].fhsssRelease / row.properties[pid].fhsssRelease
    // / row.taxDetail[p].fhsssRelease+fhsssOffset).
    const fhsssYearDetail = { client: null, partner: null };
    for (const p of persons) {
      const fb = fhsssBal[p];
      if (fb.released) continue; // one lifetime release per person — nothing left to accrue
      const opening = fb.concessional + fb.nonConcessional + fb.earnings;
      const earningsAccrued = opening * fhsssAnnualReal;
      fb.earnings += earningsAccrued;
      let requestedConcessional = 0, requestedNonConcessional = 0;
      for (let m = yearStart(y); m < yearEnd(y); m++) {
        requestedConcessional += schedule.fhsssFlows[p].concessional[m];
        requestedNonConcessional += schedule.fhsssFlows[p].nonConcessional[m];
      }
      const accept = fhsssAcceptContribution({
        requestedConcessional, requestedNonConcessional, lifetimeContributed: fb.lifetimeContributed,
      });
      fb.concessional += accept.acceptedConcessional;
      fb.nonConcessional += accept.acceptedNonConcessional;
      fb.lifetimeContributed = accept.newLifetimeContributed;
      if (accept.rejected > 1e-6) {
        superWarnings.push({
          fyLabel: schedule.fyLabels[y], owner: p, type: "fhsss",
          reason: `Exceeds the FHSSS annual/lifetime cap — $${Math.round(accept.rejected)} not eligible for release`,
        });
      }
      fhsssYearDetail[p] = {
        contributionAccepted: accept.acceptedConcessional + accept.acceptedNonConcessional,
        contributionRejected: accept.rejected,
        earningsAccrued,
        concessionalBalance: fb.concessional,
        nonConcessionalBalance: fb.nonConcessional,
        earningsBalance: fb.earnings,
        lifetimeContributed: fb.lifetimeContributed,
      };
    }

    // FHSSS release at a planned property purchase: decided here (not
    // inside runYear) so the amount is IDENTICAL and side-effect-free
    // in both the measure and real pass — the same treatment the
    // settlement price/duty/FHOG figures already get. Only the actual
    // super-account debit (withdrawFromSuper, inside runYear) is
    // deferred to the real pass, gated on `row`, same convention as
    // every other real balance mutation.
    const fhsssRelease = { client: null, partner: null };
    for (const p of props) {
      if (!p.releaseFhsssAtPurchase) continue;
      const pm = propMeta[p.id];
      if (pm.owned || pm.purchaseMonth !== yearStart(y)) continue;
      for (const per of persons) {
        if (!pm.shares[per]) continue; // not an owner of this property
        const fb = fhsssBal[per];
        if (fb.released) continue;
        const amounts = fhsssReleaseAmounts({
          concessionalBalance: fb.concessional, nonConcessionalBalance: fb.nonConcessional, earnings: fb.earnings,
        });
        if (amounts.grossRelease <= 0) continue;
        // Cap at what's actually AVAILABLE — via reserveFromSuper, not
        // a plain read of superBal: the FHSSS notional balance is a
        // running subset of real contributions credited to the real
        // account, but something else touching the SAME account first
        // this FY (adviser fees, a Division 293/296 release, an
        // explicit withdrawal) could have drained it below the notional
        // figure, OR already reserved part of it this same year (see
        // reserveFromSuper's own header — resolved fourth, after
        // adviser fees and Division 293/296, matching the order these
        // mechanisms actually debit inside runYear). Capping here —
        // before either pass runs, so both see the identical,
        // already-capped amount — keeps the settlement-cash credit and
        // the super debit exactly in sync; requesting more than the
        // account holds and crediting the settlement with the uncapped
        // figure anyway is the same class of money-creation bug the
        // conservation invariant exists to catch (found via this exact
        // check — see conservationCheck.js).
        const accountId = superAccountsByOwner[per]?.[0];
        const claimed = reserveFromSuper(accountId, amounts.grossRelease);
        const scale = amounts.grossRelease > 0 ? claimed / amounts.grossRelease : 1;
        const capped = scale >= 1 ? amounts : {
          taxableComponent: amounts.taxableComponent * scale,
          taxFreeComponent: amounts.taxFreeComponent * scale,
          grossRelease: claimed,
        };
        if (capped.grossRelease <= 0) continue;
        fhsssRelease[per] = { ...capped, propertyId: p.id };
        fb.concessional = 0; fb.nonConcessional = 0; fb.earnings = 0; fb.released = true;
      }
    }

    // FY rollover: this-FY pool additions age into old money.
    for (const id of ids) if (meta[id].cgt) pools[id] = poolNewFy(pools[id]);

    // Pass 1 — measure the year's income with no income-tax outflows.
    // Pool objects are immutable, so a shallow copy snapshots them.
    // wcaBal evolves ungated in both passes (its interest feeds
    // acc[p].ordinary, and each month's evolution depends on the
    // last), so it's snapshotted and restored the same way bal is.
    const balSnap = { ...bal };
    const poolSnap = { ...pools };
    const loanSnap = { ...loanBal };
    // Fixed-rate rollover (Commit 1): postRolloverPmt is derived from
    // loanBal at the trigger month, so it's path-dependent the same way
    // — measurement-pass writes must roll back exactly like loanBal's
    // own, or the real pass would start with an already-recomputed
    // payment for months BEFORE it actually reaches the trigger.
    const pmtSnap = { ...postRolloverPmt };
    // Monte Carlo rate linkage (Commit 5): mcActivePmt is path-dependent
    // the exact same way postRolloverPmt is (derived from loanBal at
    // whatever month it was last recomputed) — same snapshot/restore
    // requirement, same reason.
    const mcPmtSnap = { ...mcActivePmt };
    const propValSnap = { ...propVal };
    const propPoolSnap = { ...propPools };
    const wcaBalSnap = wcaBal;
    const measured = runYear(y, {
      taxOut: null, cgtDue, row: null, trackUnfunded: false, superOutcome,
      divReleaseFromSuper, divReleaseAccountId, fhsssRelease,
      ongoingFromSuperRequested, ongoingFromSuperShortfall, upfrontFromSuperShortfall,
    });
    Object.assign(bal, balSnap);
    pools = poolSnap;
    Object.assign(loanBal, loanSnap);
    for (const k of Object.keys(postRolloverPmt)) delete postRolloverPmt[k];
    Object.assign(postRolloverPmt, pmtSnap);
    for (const k of Object.keys(mcActivePmt)) delete mcActivePmt[k];
    Object.assign(mcActivePmt, mcPmtSnap);
    Object.assign(propVal, propValSnap);
    propPools = propPoolSnap;
    wcaBal = wcaBalSnap;

    // HELP/HECS annual indexation (HELP-as-liability follow-up fix):
    // applied ONCE per FY, before this year's compulsory repayment below
    // — matching the real program's 1 June indexation date. The two
    // orderings give an identical closing balance regardless (compulsory
    // repayment is a fixed % of INCOME, never of the balance), but
    // indexing first means the repayment cap a few lines down is
    // measured against the balance HELP itself would actually cap
    // against. Basis: the LOWER of CPI and the wage-index proxy AWOTE —
    // the post-1 June 2023 "lesser of CPI or WPI" legislative basis;
    // AWOTE stands in for WPI, the same proxy helpRatesFor already uses
    // for threshold indexation (data/helpRates.js's header). CONFIRM
    // against the firm reference before relying on this for advice —
    // see Open Items (build-log.md). Captured as an explicit, reported
    // per-person amount (helpIndexation) — not just applied silently —
    // so the Liabilities table and the conservation invariant can both
    // show opening + indexation − repayment = closing exactly, the
    // mirror of the liabilityRevaluation term ordinary (un-indexed)
    // liabilities already get for free from nominal/real conversion.
    const helpOpening = { client: helpBal.client, partner: helpBal.partner };
    const helpIndexRate = Math.min(cpi, awoteAssum);
    const helpIndexation = { client: 0, partner: 0 };
    for (const p of persons) {
      helpIndexation[p] = helpOpening[p] * ((1 + helpIndexRate) / (1 + cpi) - 1);
      helpBal[p] += helpIndexation[p];
    }

    // Negative gearing rules (D4): a net rental loss offsets other
    // income only when the loss year is pre-FY2027-28, the property is
    // a new build, or it was acquired before 12 May 2026
    // (grandfathered). Otherwise the loss is quarantined per owner —
    // carried forward against future net rental profits first, then
    // capital gains. Property flows are balance-independent, so the
    // measured components are exact for both passes.
    const newQuarantine = { client: 0, partner: 0 };
    // HELP/MLS repayment-income add-back (Document Set Commit 1/2): the
    // property's net LOSS itself, before the quarantine decision above
    // — a net investment loss adds back to repayment/surcharge income
    // whether or not it's currently allowed to offset other income.
    // Disclosed narrower than the full ATO definition: a leveraged
    // financial-asset portfolio's loss (deductible interest exceeding
    // its distributions) is not tracked as a discrete loss figure
    // anywhere in this engine and so isn't added back here — only
    // property negative gearing is, since that's the only investment-
    // loss concept this tool actually models end to end.
    const netInvestmentLoss = { client: 0, partner: 0 };
    for (const per of persons) {
      let rentalProfit = 0;
      for (const pid in propMeta) {
        const pm = propMeta[pid];
        if (!pm.invest) continue;
        const pn = measured._propNet[pid];
        const share = pm.shares[per] ?? 0;
        const net = (pn.rent - pn.expenses) * share - pn.interest[per];
        if (net >= 0) { rentalProfit += net; continue; }
        netInvestmentLoss[per] += -net;
        const allowed = fyStart < 2027 || pm.newBuild || pm.grandfathered;
        if (!allowed) {
          measured[per].deductions -= -net; // quarantine: pull the loss out
          newQuarantine[per] += -net;
        }
      }
      const use = Math.min(quarantineCarry[per], rentalProfit);
      if (use > 0) {
        measured[per].deductions += use; // prior carry offsets rental profit
        quarantineCarry[per] -= use;
      }
    }

    // Assess income tax per person on the measured components.
    // Excess concessional super contributions (Tier 1.2, Commit 2) are
    // assessable here too — same treatment as ordinary income.
    const assessed = {};
    const paygWithheld = { client: 0, partner: 0 };
    // Worked-example validation follow-up: HELP and MLS are ALSO
    // withheld through PAYG (same mechanism as income tax — the
    // comment below this block always said so), but only paygWithheld
    // was ever exposed on taxDetail; cashflowStatement.js's "regular
    // take home pay" therefore never netted either off, overstating
    // take-home pay by the full HELP/MLS withholding every FY a person
    // has one. Hoisted into per-person accumulators (same shape as
    // paygWithheld) so they survive past the loop below and can be
    // exposed on taxDetail alongside it.
    const helpWithheld = { client: 0, partner: 0 };
    const mlsWithheld = { client: 0, partner: 0 };
    const newPendingRefund = { client: 0, partner: 0 };
    // Document Set Commit 1 — HELP repayment for THIS FY, capped at the
    // opening balance (never below zero). Assessed and applied to the
    // balance in the same FY it's due (a modelling simplification, see
    // helpRates.js's header); the CASH impact still follows the exact
    // same PAYG-withheld-vs-actual settlement as income tax, landing as
    // part of the same FY t+1 refund/balancing figure.
    const helpDue = { client: 0, partner: 0 };
    const mlsDue = { client: 0, partner: 0 };
    // Document Set Commits 1/2 — "income for [HELP repayment / MLS
    // surcharge] purposes": taxable income + reportable super
    // contributions + net investment loss. The spec gives HELP a fifth
    // component (reportable fringe benefits, exempt foreign employment
    // income) neither of which this tool models, so the two figures
    // are IDENTICAL here — computed once, used for both. Kept as two
    // separately-named reads at the call site (not merged into one
    // "surchargeableIncome" concept) since the spec defines them
    // independently and a future refinement could diverge them.
    //
    // Computed in its OWN pass, before the main per-person loop below:
    // MLS's family threshold needs BOTH persons' income at once (the
    // ATO compares the COMBINED family income against one threshold,
    // then applies the resulting rate to each uncovered person's own
    // income separately) — which the main loop, processed one person
    // at a time, can't see ahead of itself. assessPerson is pure and
    // cheap; calling it here duplicates none of its side effects (there
    // are none), just this one lightweight number.
    const repaymentIncome = { client: 0, partner: 0 };
    for (const p of persons) {
      const pre = assessPerson({
        fyStartYear: fyStart, bracketMode, cpi,
        ordinaryIncome: measured[p].ordinary,
        deductions: measured[p].deductions,
        distributions: { franked: measured[p].franked, unfranked: measured[p].unfranked },
        netCapitalGain: 0,
        capitalLossCarryFwd: lossCarryFwd[p],
        taxProfile: state.plan[p]?.taxProfile ?? null,
        excessConcessionalContributions: superOutcome[p]?.excessCC ?? 0,
        fhsssTaxableRelease: measured[p].fhsssTaxableRelease ?? 0,
      });
      // Disclosed simplification: excludes this FY's own realised
      // capital gain, which this engine only ever assesses in a later,
      // separately-timed block.
      repaymentIncome[p] = pre.taxableIncome
        + (superOutcome[p]?.reportableSuperContributions ?? 0)
        + netInvestmentLoss[p];
    }
    const isFamily = persons.length > 1; // a couple — MLS family thresholds apply to both
    const familyIncome = repaymentIncome.client + repaymentIncome.partner;
    // Input Usability spec, Commit 3 — derived per FY from each child's
    // own DOB, so the family threshold steps down as children age out
    // instead of being a fixed number for the life of the projection.
    const dependentChildren = dependentChildrenCountInFY(state.plan.children, fyStart);

    taxOutArr.fill(0, yearStart(y), yearEnd(y));
    for (const p of persons) {
      const a = assessPerson({
        fyStartYear: fyStart,
        bracketMode,
        cpi,
        ordinaryIncome: measured[p].ordinary,
        deductions: measured[p].deductions,
        distributions: { franked: measured[p].franked, unfranked: measured[p].unfranked },
        netCapitalGain: 0,
        capitalLossCarryFwd: lossCarryFwd[p],
        taxProfile: state.plan[p]?.taxProfile ?? null,
        excessConcessionalContributions: superOutcome[p]?.excessCC ?? 0,
        fhsssTaxableRelease: measured[p].fhsssTaxableRelease ?? 0,
      });
      assessed[p] = a;

      helpDue[p] = Math.min(helpRepaymentAmount(repaymentIncome[p], helpRatesY), helpBal[p]);
      // MLS: comparison income is the FAMILY total for a couple (both
      // compare against the SAME family bands), or the person's own
      // income when single; the surcharge itself, once triggered, is a
      // % of THIS person's own income only — see mlsRates.js's header.
      mlsDue[p] = mlsSurchargeAmount({
        ownIncome: repaymentIncome[p],
        comparisonIncome: isFamily ? familyIncome : repaymentIncome[p],
        hasCover: (p === "partner" ? state.plan.partner : state.plan.client)?.privateHospitalCover !== false,
        isFamily,
        dependentChildren,
        rates: mlsRatesY,
      });

      // PAYG withholding, tax refund timing, and deductions: computed
      // on employment income ALONE — the tax-free threshold, Medicare
      // levy, and LITO only, ignoring deductions, every other income
      // type, and franking credits, mirroring what an employer
      // actually withholds. A person with no employment income this FY
      // keeps the pre-existing smooth spreadTax accrual UNCHANGED (the
      // no-employment-income regression gate); a person WITH employment
      // income instead has PAYG debited in their salary months, and the
      // full gap to their actual (whole-picture) tax liability settles
      // as a single household outflow in July of FY t+1, same
      // convention as CGT/Div293/Div296 — see pendingRefund above.
      const empArr = schedule.employmentIncomeByOwner[p];
      let employmentIncomeFy = 0;
      if (empArr) for (let m = yearStart(y); m < yearEnd(y); m++) employmentIncomeFy += empArr[m];
      if (employmentIncomeFy > 0) {
        const payg = assessPerson({
          fyStartYear: fyStart, bracketMode, cpi,
          ordinaryIncome: employmentIncomeFy, deductions: 0,
          distributions: { franked: 0, unfranked: 0 },
          netCapitalGain: 0, capitalLossCarryFwd: 0,
          taxProfile: state.plan[p]?.taxProfile ?? null,
          excessConcessionalContributions: 0,
        });
        paygWithheld[p] = payg.netIncomeTax;
        // Employer HELP withholding (also PAYG, same mechanism as
        // income tax): estimated on employment income alone — a real
        // payroll system has no visibility into the super/investment-
        // loss add-backs — and capped at the opening balance, same as
        // the actual repayment above. MLS withholding is estimated the
        // same way, on employment income alone (a payroll system knows
        // the employee's private-cover declaration but not their
        // spouse's income, so this too is an approximation of the real
        // family-income comparison).
        helpWithheld[p] = Math.min(helpRepaymentAmount(employmentIncomeFy, helpRatesY), helpBal[p]);
        mlsWithheld[p] = mlsSurchargeAmount({
          ownIncome: employmentIncomeFy,
          comparisonIncome: isFamily ? familyIncome : employmentIncomeFy,
          hasCover: (p === "partner" ? state.plan.partner : state.plan.client)?.privateHospitalCover !== false,
          isFamily, dependentChildren, rates: mlsRatesY,
        });
        for (let m = yearStart(y); m < yearEnd(y); m++) {
          if (empArr[m] > 0) taxOutArr[m] += (paygWithheld[p] + helpWithheld[p] + mlsWithheld[p]) * (empArr[m] / employmentIncomeFy);
        }
        newPendingRefund[p] = (paygWithheld[p] + helpWithheld[p] + mlsWithheld[p]) - (a.netIncomeTax + helpDue[p] + mlsDue[p]);
      } else {
        spreadTax(a.netIncomeTax + helpDue[p] + mlsDue[p], measured[p].incomeMonths, yearEnd(y) - 1);
      }
      helpBal[p] -= helpDue[p];
    }

    // Division 293 (Tier 1.2, Commit 2): assessed this FY on the
    // taxable income just computed, paid as a household outflow in
    // July of FY t+1 (same convention as CGT — folded into cgtDue
    // above, reported separately via div293DueDetail/taxDetail).
    const newPendingDiv293 = { client: 0, partner: 0 };
    for (const p of persons) {
      const outcome = superOutcome[p];
      if (!outcome) continue;
      const { tax } = div293Tax({
        taxableIncome: assessed[p].taxableIncome,
        reportableSuperContributions: outcome.reportableSuperContributions,
        lowTaxContributions: outcome.lowTaxContributions,
        threshold: superRatesY.div293Threshold,
        rate: superRatesY.div293Rate,
      });
      newPendingDiv293[p] = tax;
    }

    // Pass 2 — the real year, with the PAYG spread applied.
    const row = mkYearRow(y);
    row.superCapUsage = superCapUsage;
    row.fhsssDetail = fhsssYearDetail;
    row.openingBalance = combined[yearStart(y)];
    row.wcaDetail.opening = wcaSeries[yearStart(y)];
    for (const l of liabs) row.liabilities[l.id].opening = liabSeries[l.id][yearStart(y)];
    // HELP-as-liability follow-up fix: opening/indexation/repayment were
    // all fully resolved above (before Pass 2 even starts), so they're
    // set here alongside ordinary liabilities' own opening; closing is
    // set later, alongside liabilitiesClosing, since that's the existing
    // convention for every liability.
    for (const p of helpLiabPersons) {
      const hid = `help_${p}`;
      row.liabilities[hid].opening = helpOpening[p];
      row.liabilities[hid].indexation = helpIndexation[p];
      row.liabilities[hid].principal = helpDue[p];
    }
    for (const id of ids) row.perAssetDetail[id].opening = series[id][yearStart(y)];
    for (const id of superIds) row.superDetail[id].opening = superSeries[id][yearStart(y)];
    const real = runYear(y, {
      taxOut: taxOutArr, cgtDue, row, trackUnfunded: true, superOutcome,
      divReleaseFromSuper, divReleaseAccountId, fhsssRelease,
      ongoingFromSuperRequested, ongoingFromSuperShortfall, upfrontFromSuperShortfall,
    });
    row.closingBalance = combined[yearEnd(y)];
    row.wcaDetail.closing = wcaSeries[yearEnd(y)];
    row.wcaClosing = wcaSeries[yearEnd(y)];
    for (const id of ids) {
      row.perAssetClosing[id] = series[id][yearEnd(y)];
      row.perAssetDetail[id].closing = series[id][yearEnd(y)];
      if (meta[id].cgt) row.perAssetDetail[id].costBasePool = pools[id].pool;
    }
    for (const id of superIds) {
      row.superDetail[id].closing = superSeries[id][yearEnd(y)];
      row.superDetail[id].taxFreeClosing = superTaxFree[id];
      row.superClosing += superSeries[id][yearEnd(y)];
    }

    // Division 296 (Super thresholds Commit 2): assessed this FY, per
    // person, on the higher of opening/closing TSB and this FY's
    // REALISED earnings (the same gross "earnings" figure the fund's
    // own 15%/10% earnings tax already applies to — see div296.js's
    // header comment for the disclosed smoothing simplification this
    // implies). Paid as a household outflow in July of FY t+1, same
    // convention as CGT/Div293 (folded into cgtDue next year).
    const newPendingDiv296 = { client: 0, partner: 0 };
    for (const p of persons) {
      const closingTsb = superAccountsByOwner[p].reduce((s, id) => s + row.superDetail[id].closing, 0);
      const earnings = superAccountsByOwner[p].reduce((s, id) => s + row.superDetail[id].earnings, 0);
      const { tax } = div296Tax({
        openingTsb: tsbOpening[p], closingTsb, earnings,
        lowerThreshold: superRatesY.div296LowerThreshold,
        upperThreshold: superRatesY.div296UpperThreshold,
      });
      newPendingDiv296[p] = tax;
    }

    for (const l of liabs) {
      const closingReal = liabSeries[l.id][yearEnd(y)];
      row.liabilities[l.id].closing = closingReal;
      row.liabilitiesClosing += closingReal;
    }
    // HELP-as-liability follow-up fix: a real debt, so it belongs in
    // liabilitiesClosing (and therefore netAssets) the same as any other
    // liability — previously tracked (helpBal) and repaid correctly but
    // invisible to net worth, the Liabilities table and both charts.
    for (const p of helpLiabPersons) {
      row.liabilities[`help_${p}`].closing = helpBal[p];
      row.liabilitiesClosing += helpBal[p];
    }
    for (const pid in propMeta) {
      row.properties[pid].value = propVal[pid];
      row.propertyClosing += propVal[pid];
    }
    row.netAssets = row.closingBalance + row.propertyClosing + row.superClosing + row.wcaClosing - row.liabilitiesClosing;

    // CGT assessment on the year's realised net gains (decision 13),
    // stacked on the same measured income base.
    const newPending = { client: 0, partner: 0 };
    for (const p of persons) {
      // Remaining quarantined carry offsets this year's realised gains.
      if (quarantineCarry[p] > 0 && real[p].netCapitalGain > 0) {
        const useGain = Math.min(quarantineCarry[p], real[p].netCapitalGain);
        real[p].netCapitalGain -= useGain;
        quarantineCarry[p] -= useGain;
      }
      const a2 = assessPerson({
        fyStartYear: fyStart,
        bracketMode,
        cpi,
        ordinaryIncome: measured[p].ordinary,
        deductions: measured[p].deductions,
        distributions: { franked: measured[p].franked, unfranked: measured[p].unfranked },
        netCapitalGain: real[p].netCapitalGain,
        capitalLossCarryFwd: lossCarryFwd[p],
        taxProfile: state.plan[p]?.taxProfile ?? null,
        excessConcessionalContributions: superOutcome[p]?.excessCC ?? 0,
      });
      lossCarryFwd[p] = a2.lossCarryFwd;
      newPending[p] = a2.cgtTax;
    }

    const detail = (p) => persons.includes(p) ? {
      quarantinedLossCarry: quarantineCarry[p], // already includes this FY's quarantined losses
      taxableIncome: assessed[p].taxableIncome,
      grossTax: assessed[p].incomeTax,
      medicare: assessed[p].medicare,
      lito: assessed[p].lito,
      excessCcOffset: assessed[p].excessCcOffset,
      excessConcessionalContributions: superOutcome[p]?.excessCC ?? 0,
      incomeTax: assessed[p].netIncomeTax,
      // The realised net capital gain actually assessed this FY (after
      // quarantined-loss offset above) — for the Cashflow table's "Net
      // Taxable Capital Gains" row (Cashflow table: firm row
      // vocabulary and category grouping).
      netCapitalGain: real[p].netCapitalGain,
      cgt: cgtDueDetail[p],
      div293: div293DueDetail[p],
      div296: div296DueDetail[p],
      // Division 293/296 release-from-super (default) — how THIS year's
      // due amount (div293 + div296 above) was actually funded: the
      // person's election, the amount released from their nominated
      // super account (0 if paid from cash, or if nothing was due), and
      // any shortfall that fell back to household cash (either because
      // the election is "cash", or because super).
      divTaxPaidFrom: (p === "partner" ? state.plan.partner : state.plan.client)?.super?.divTaxPaidFrom === "cash"
        ? "cash" : "super",
      divTaxReleasedFromSuper: divReleaseFromSuper[p],
      divTaxFromCash: divReleaseCash[p],
      frankingCredits: assessed[p].frankingCredits,
      // PAYG withholding, tax refund timing, and deductions — THIS FY's
      // own assessment (not a payment-year figure like cgt/div293/
      // div296 above): paygWithheld is 0 for a person with no
      // employment income this FY (their tax stayed on the smooth
      // accrual instead). actualTaxPayable is the same number as
      // incomeTax above, named to match "NET INCOME = income − actual
      // tax" directly. refundOrBalancing = paygWithheld −
      // actualTaxPayable (positive = refund, negative = balancing
      // payment) — settles as cash in July of FY t+1, see
      // taxDetail.refundSettled below for the amount actually hitting
      // cash THIS year (last year's figure).
      paygWithheld: paygWithheld[p],
      // Worked-example validation follow-up: HELP/MLS are withheld
      // through the SAME PAYG mechanism (see the comment where these
      // are computed, above) — exposed here so cashReceivedSums's
      // "regular take home pay" can net all three off, not just income
      // tax. Both 0 for a no-employment-income person, same reason
      // paygWithheld is.
      helpWithheld: helpWithheld[p],
      mlsWithheld: mlsWithheld[p],
      actualTaxPayable: assessed[p].netIncomeTax,
      // Reuses newPendingRefund[p] rather than recomputing — that value
      // is already 0 for a no-employment-income person (their tax
      // stayed on the smooth accrual entirely; there is no PAYG
      // estimate to compare against, so reporting a "balancing payment"
      // here would be a number that never corresponds to any real cash
      // event).
      refundOrBalancing: newPendingRefund[p],
      // The cash amount actually settling THIS year, per person (last
      // year's refundOrBalancing) — Document Set Commit 7's Snapshot
      // view needs a per-person "Anticipated tax return" figure;
      // row.taxDetail.refundSettled (household) already summed this.
      refundSettled: pendingRefund[p],
      // Document Set Commit 1 — this FY's compulsory HELP repayment
      // (already capped at the opening balance) and the balance as it
      // stands after it, for the Tax view's HELP row + closing balance
      // and the Key figures table's HELP balance row.
      helpRepayment: helpDue[p],
      helpBalanceClosing: helpBal[p],
      // Document Set Commit 2 — this FY's Medicare Levy Surcharge.
      medicareLevySurcharge: mlsDue[p],
      // Document Set Commit 3 — this FY's FHSSS release, if any: the
      // gross amount (already netted into the property's settlement
      // figure above) and the resulting tax offset (30% of the taxable
      // component, capped at remaining tax — see assessPerson), for the
      // Tax view's visibility of "the tax benefit". taxableComponent/
      // taxFreeComponent (Focus Commit 3 follow-on): the same capped
      // split already computed for the release decision itself (see
      // fhsssRelease[per], above) — exposed so a Focus view can show
      // "tax on release" without re-deriving the 85%/100% split.
      fhsssRelease: fhsssRelease?.[p]?.grossRelease ?? 0,
      fhsssTaxableComponent: fhsssRelease?.[p]?.taxableComponent ?? 0,
      fhsssTaxFreeComponent: fhsssRelease?.[p]?.taxFreeComponent ?? 0,
      fhsssOffset: assessed[p].fhsssOffset,
    } : null;
    for (const p of persons) quarantineCarry[p] += newQuarantine[p]; // available from next FY
    row.taxDetail = {
      client: detail("client"),
      partner: detail("partner"),
      incomeTax: persons.reduce((s, p) => s + assessed[p].netIncomeTax, 0),
      // cgtDue folds in the CASH-funded portion of div293/div296 (any
      // amount not released from super) AND −refundDue for the actual
      // cash outflow; div293/div296 below report the FULL assessed
      // amounts regardless of how they were paid.
      cgt: cgtDue - divReleaseCash.client - divReleaseCash.partner + refundDue,
      div293: div293Due,
      div296: div296Due,
      // Division 293/296 release from super — household totals (see
      // detail(p) above for the per-person breakdown).
      divTaxReleasedFromSuper: divReleaseFromSuper.client + divReleaseFromSuper.partner,
      divTaxFromCash: divReleaseCash.client + divReleaseCash.partner,
      // The cash amount actually settling THIS year (last year's
      // paygWithheld − actualTaxPayable, per person) — positive = net
      // refund received, negative = net balancing payment owed. 0 in a
      // projection's first year (nothing was assessed yet).
      refundSettled: refundDue,
      frankingCredits: persons.reduce((s, p) => s + assessed[p].frankingCredits, 0),
      netCapitalGain: persons.reduce((s, p) => s + real[p].netCapitalGain, 0),
      helpRepayment: helpDue.client + helpDue.partner,
      medicareLevySurcharge: mlsDue.client + mlsDue.partner,
      fhsssRelease: (fhsssRelease.client?.grossRelease ?? 0) + (fhsssRelease.partner?.grossRelease ?? 0),
    };
    yearly.push(row);
    pendingCgt = newPending;
    pendingDiv293 = newPendingDiv293;
    pendingDiv296 = newPendingDiv296;
    pendingRefund = newPendingRefund;
  }

  // Document Set Commit 5 — interest saved / time saved versus the
  // SCHEDULED (no-extras) path, for every liability with at least one
  // extra or one-off repayment configured. Only reported once the
  // ACTUAL loan reaches zero WITHIN the projection: if it doesn't, the
  // comparison would understate the true lifetime interest (the loan
  // keeps accruing beyond the horizon, unobserved), so it's left
  // undetermined (null) rather than shown as a misleadingly generous
  // saving. liabMeta/liabSeries are still in scope here (declared
  // above the year loop, at function level) — this is a pure
  // post-processing read, no engine state is mutated.
  const liabilityRepaymentStats = {};
  for (const l of state.liabilities ?? []) {
    const hasExtras = (l.extraRepayments?.length ?? 0) > 0 || (l.oneOffRepayments?.length ?? 0) > 0;
    if (!hasExtras) continue;
    const md = liabMeta[l.id];
    if (!md) continue;
    const scheduled = scheduledAmortisation({
      balance: l.balance, i: md.i, ioM: md.ioM, termM: md.termM, pmtPI: md.pmtPI,
      startMonth: md.startMonth, inflAt,
      rolloverMonth: md.rolloverMonth, revertRate: md.revertRate,
    });
    let actualPayoffMonth = null;
    const series = liabSeries[l.id];
    for (let m = md.startMonth + 1; m <= schedule.months; m++) {
      if (series[m] <= 1e-6) { actualPayoffMonth = m - md.startMonth; break; }
    }
    const actualTotalInterest = yearly.reduce((s, row) => s + (row.liabilities[l.id]?.interest ?? 0), 0);
    liabilityRepaymentStats[l.id] = actualPayoffMonth == null
      ? { scheduledPayoffMonth: scheduled.payoffMonth, actualPayoffMonth: null, interestSaved: null, timeSavedMonths: null }
      : {
          scheduledPayoffMonth: scheduled.payoffMonth,
          actualPayoffMonth,
          interestSaved: scheduled.totalInterestReal - actualTotalInterest,
          timeSavedMonths: scheduled.payoffMonth - actualPayoffMonth,
        };
  }

  // Fixed-rate rollover (Implementation/Rates spec, Commit 1) — one
  // entry per liability with rateType "fixed" whose rollover actually
  // fires (resolves within the projection) WHILE the loan is still
  // open, giving the Liabilities table/chart and the Focus debt-payoff
  // view the "before vs after" figures without recomputing anything
  // the engine already derived. Gated on postRolloverPmt actually
  // having been set — a loan paid off (or never reaching b0 > 0 at the
  // trigger month) before rollover never ran the recompute, so there's
  // no "after" to report. repaymentBefore/After are real-dollar monthly
  // $ figures at the rollover point (deflated the same way every other
  // point-in-time figure on this row is).
  const liabilityRollovers = {};
  for (const l of state.liabilities ?? []) {
    const md = liabMeta[l.id];
    if (!md || md.rolloverMonth == null || postRolloverPmt[l.id] == null) continue;
    const infl = inflAt(md.rolloverMonth);
    liabilityRollovers[l.id] = {
      planYear: md.rolloverYear,
      fyLabel: schedule.fyLabels[md.rolloverYear],
      fromRatePct: md.i * 12 * 100,
      toRatePct: md.revertRate * 12 * 100,
      repaymentBefore: md.pmtPI / infl,
      repaymentAfter: postRolloverPmt[l.id] / infl,
    };
  }

  // --- Usable equity and borrowing capacity (Implementation/Rates
  // spec, Commit 3) — a SECURITY constraint only: usable equity =
  // value × equityCeilingPct − (loan balance − offset balance). This
  // tool never asks whether income could service the resulting loan —
  // "be explicit about what this is not" (the spec's own words) — so
  // it is deliberately NOT folded into anything that could read as a
  // serviceability or approval signal. Every input is a figure the
  // engine already reports per year (value, a linked liability's own
  // closing balance and offsetApplied); no new money moves, so no new
  // conservation-invariant term is needed. Floored at 0 — "usable
  // equity" is a capacity, not a signed balance; a loan bigger than the
  // ceiling allows means none available, not a negative amount.
  const allPropsForEquity = state.properties ?? [];
  const loanIdsForProperty = {};
  for (const p of allPropsForEquity) loanIdsForProperty[p.id] = [];
  for (const l of state.liabilities ?? []) {
    if (l.linkedAssetId && loanIdsForProperty[l.linkedAssetId]) loanIdsForProperty[l.linkedAssetId].push(l.id);
  }
  for (const p of allPropsForEquity) {
    const derivedId = `prop-${p.id}`;
    if (liabMeta[derivedId]) loanIdsForProperty[p.id].push(derivedId);
  }
  for (const row of yearly) {
    for (const p of allPropsForEquity) {
      const detail = row.properties[p.id];
      if (!detail) continue;
      let loanClosing = 0, offsetApplied = 0;
      for (const lid of loanIdsForProperty[p.id]) {
        const ld = row.liabilities[lid];
        if (!ld) continue;
        loanClosing += ld.closing;
        offsetApplied += ld.offsetApplied;
      }
      detail.usableEquity = Math.max(0, detail.value * ((p.equityCeilingPct ?? 80) / 100) - (loanClosing - offsetApplied));
    }
  }

  // The purchase-check: where a planned purchase's deposit is meant to
  // come from another property's usable equity, flag when that source
  // property's usable equity — AS AT the purchase year (year-level
  // granularity, the same coarseness every other year-resolved check
  // in this engine uses) — falls short of the deposit this purchase
  // actually needs (row.properties[pid].deposit, the SAME figure Focus
  // Commit 2 already exposes — never re-derived here). A flag, never a
  // block: the purchase still completes through the ordinary funding
  // order regardless, same as every other "insufficient funds" case in
  // this engine.
  for (const p of allPropsForEquity) {
    if (!p.depositFromEquity || !p.depositFromEquitySourcePropertyId) continue;
    const ref = resolveRef(p.purchaseAt, state.plan, schedule, "client");
    const row = yearly[ref.planYear];
    if (!row) continue;
    const required = row.properties[p.id]?.deposit ?? 0;
    if (required <= 0) continue; // purchase didn't actually fire this year
    const available = row.properties[p.depositFromEquitySourcePropertyId]?.usableEquity ?? 0;
    if (available < required) {
      propertyWarnings.push({
        propertyId: p.id, type: "insufficientEquity",
        reason: `Deposit of $${Math.round(required).toLocaleString()} at ${ref.fyLabel} relies on usable equity from another property, but only $${Math.round(available).toLocaleString()} is available then — a security constraint, not a serviceability assessment`,
      });
    }
  }

  // --- Where the money went (Implementation/Rates spec, Commit 4) —
  // per-year decomposition of the change in net worth into 7 named
  // buckets, PLUS running cumulative totals, both derived from the
  // engine's own per-year figures via conservationCheck.js's
  // decomposeNetWorthChange (the SAME terms the conservation invariant
  // itself asserts over — never a second, independently-derived copy).
  // A pure read: no new money moves, so no new conservation term.
  const outSoFar = { yearly };
  let cumIncome = 0, cumGrowth = 0, cumTax = 0, cumExpenses = 0, cumInterest = 0, cumFees = 0, cumOneOffs = 0;
  let wealthCrossoverYear = null;
  for (let y = 0; y < yearly.length; y++) {
    const d = decomposeNetWorthChange(outSoFar, y);
    yearly[y].decomposition = {
      income: d.income, growth: d.growth, tax: d.tax, expenses: d.expenses,
      interest: d.interest, fees: d.fees, oneOffs: d.oneOffs,
    };
    cumIncome += d.income; cumGrowth += d.growth; cumTax += d.tax;
    cumExpenses += d.expenses; cumInterest += d.interest; cumFees += d.fees; cumOneOffs += d.oneOffs;
    yearly[y].cumulativeDecomposition = {
      income: cumIncome, growth: cumGrowth, tax: cumTax, expenses: cumExpenses,
      interest: cumInterest, fees: cumFees, oneOffs: cumOneOffs,
    };
    // The point the spec calls out: for a long accumulation, cumulative
    // investment growth eventually overtakes cumulative income/
    // contributions received — the year that first happens, once and
    // never reverting back (a single crossing is what the spec means by
    // "annotate the year that happens", not every fluctuation around it).
    if (wealthCrossoverYear == null && cumGrowth > cumIncome) wealthCrossoverYear = y;
  }

  // Document Set Commit 6 — per-goal outcome: achieved in full, or
  // short by the target date. The "reached instead" date extrapolates
  // the goal's OWN average funding rate achieved so far forward at the
  // same pace — a disclosed simplification (the real rate could
  // improve or worsen; this assumes it stays constant).
  const goalStats = {};
  for (const g of goals) {
    const gm = goalMeta[g.id];
    if (!gm) { goalStats[g.id] = null; continue; }
    const accrued = goalAccruedTotal[g.id] ?? 0;
    const shortfallAmount = Math.max(0, gm.targetReal - accrued);
    let alternativeMonth = null;
    if (shortfallAmount > 1e-6) {
      const avgMonthlyRate = gm.targetMonth > 0 ? accrued / gm.targetMonth : 0;
      alternativeMonth = avgMonthlyRate > 1e-9
        ? gm.targetMonth + Math.ceil(shortfallAmount / avgMonthlyRate)
        : null; // never, at this rate
    }
    goalStats[g.id] = {
      targetReal: gm.targetReal,
      targetMonth: gm.targetMonth,
      accrued,
      shortfall: shortfallAmount,
      achieved: shortfallAmount <= 1e-6,
      alternativeMonth,
    };
  }

  let shortfall = null;
  if (firstUnfundedMonth >= 0) {
    const y = schedule.yearOfMonth[firstUnfundedMonth];
    shortfall = {
      firstMonth: firstUnfundedMonth,
      planYear: y,
      fyLabel: schedule.fyLabels[y],
      clientAge: schedule.clientAges[y],
      total: totalUnfunded,
    };
  }

  return {
    schedule,
    monthly: { combined, perAsset: series, wca: wcaSeries },
    yearly,
    shortfall,
    accruedCgtAtEnd: pendingCgt.client + pendingCgt.partner,
    // Tier 1.2: the final FY's Division 293 is unpayable inside the
    // projection, same as accruedCgtAtEnd; superWarnings collects every
    // rejected/gated contribution (age 75, work test, excess NCC)
    // across the whole projection, not silently dropped.
    accruedDiv293AtEnd: pendingDiv293.client + pendingDiv293.partner,
    // Same unpayable-final-FY convention as accruedCgtAtEnd/accruedDiv293AtEnd.
    accruedDiv296AtEnd: pendingDiv296.client + pendingDiv296.partner,
    // PAYG withholding / tax refund timing: the final FY's assessed
    // refund/balancing (signed — positive = refund owed TO the
    // household) can't be settled inside the projection either.
    accruedRefundAtEnd: pendingRefund.client + pendingRefund.partner,
    superWarnings,
    propertyWarnings,
    liabilityRepaymentStats,
    liabilityRollovers,
    goalStats,
    wealthCrossoverYear,
  };
}
