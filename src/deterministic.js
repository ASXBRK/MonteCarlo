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
import { levelPayment, monthlyRate, termMonths, ioMonths } from "./liabilities.js";
import { dutyWithConcessions, fhogAmount } from "./data/stampDuty.js";
import { fhbgPriceCapExceeded } from "./data/fhbgCaps.js";
import { assessPerson } from "./Tax/annual.js";
import { div296Tax } from "./Tax/div296.js";
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
        deductible: invest, // investment loans deduct by default
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
  for (const l of liabs) {
    const i = monthlyRate(l);
    const termM = termMonths(l);
    const ioM = ioMonths(l);
    const offsetId = l.offsetAssetId && l.offsetAssetId in bal && !meta[l.offsetAssetId].lifestyle
      ? l.offsetAssetId : null;
    liabMeta[l.id] = {
      i,
      termM,
      ioM,
      startMonth: l.startMonth ?? 0, // purchase loans (D4) start at settlement
      pmtPI: levelPayment(l.balance, i, termM - ioM),
      offsetId,
      deductible: l.deductible === true,
      shares: ownerShares(l, couple),
      propertyId: l.propertyId ?? null, // interest joins that property's gearing calc
    };
    // Purchase loans hold zero until the settlement month sets them.
    loanBal[l.id] = (l.startMonth ?? 0) > 0 ? 0 : l.balance;
    liabSeries[l.id] = new Float64Array(months + 1);
    liabSeries[l.id][0] = loanBal[l.id]; // real == nominal at month 0
    if (offsetId) (offsetLoansByAsset[offsetId] ??= []).push(l.id);
  }

  // Lifestyle assets are illiquid to the engine: never funding
  // sources, never surplus targets (defensive — settings invariants
  // already exclude them).
  const fundingOrder = state.settings.fundingOrder.filter((id) => id in bal && !meta[id].lifestyle);
  const surplusMode = state.settings.surplus.mode;
  const surplusTargetId =
    surplusMode === "invest" &&
    state.settings.surplus.assetId in bal &&
    !meta[state.settings.surplus.assetId].lifestyle
      ? state.settings.surplus.assetId
      : null;

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
  // Document Set Commit 1 — HELP/HECS outstanding balance, real $. Held
  // constant in real terms except for actual dollar repayments below
  // (see src/data/helpRates.js's header for why); the loan ends when
  // this reaches zero.
  const helpBal = {
    client: Math.max(0, state.plan.client?.helpBalance ?? 0),
    partner: Math.max(0, state.plan.partner?.helpBalance ?? 0),
  };
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
    liabilities: Object.fromEntries(liabs.map((l) => [l.id, {
      opening: 0, interest: 0, principal: 0, drawdown: 0, offsetApplied: 0, closing: 0,
    }])),
    liabilitiesClosing: 0,
    // Per-property detail (D4), real dollars.
    properties: Object.fromEntries(props.map((p) => [p.id, {
      value: 0, rent: 0, expenses: 0, depreciation: 0, settlement: 0, costBaseSeed: 0, fhsssRelease: 0, lmi: 0,
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
      closing: 0, taxFreeClosing: 0,
    }])),
    superClosing: 0,
    superCapUsage: { client: null, partner: null },
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
  function runYear(y, { taxOut, cgtDue, row, trackUnfunded, superOutcome, divReleaseFromSuper, divReleaseAccountId, fhsssRelease }) {
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
        for (const id of superIds) superSeries[id][m + 1] = superBal[id];
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
              const accountId = superAccountsByOwner[per]?.[0];
              if (accountId) withdrawFromSuper(accountId, rel.grossRelease);
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
        const interest = (b0 - offsetNom) * md.i;
        const contractual = mRel < md.ioM ? interest : md.pmtPI;
        const payment = Math.min(Math.max(contractual, 0), b0 + interest);
        let b1 = b0 + interest - payment;
        if (b1 < 1e-9) b1 = 0;
        loanBal[l.id] = b1;
        const defl = 1 / infl;
        loanPayReal += payment * defl;
        const interestReal = interest * defl;
        if (md.deductible && interestReal > 0) {
          for (const p of persons) {
            if (md.shares[p]) {
              acc[p].deductions += interestReal * md.shares[p];
              // Interest on a loan tied to an investment property joins
              // that property's gearing calculation (D4).
              if (md.propertyId && propMeta[md.propertyId]?.invest) {
                acc._propNet[md.propertyId].interest[p] += interestReal * md.shares[p];
              }
            }
          }
        }
        if (row) {
          row.liabilities[l.id].interest += interestReal;
          row.liabilities[l.id].principal += (payment - interest) * defl;
          // Snapshot, not a sum — overwritten every month so it holds
          // the year-end value, same convention as closing.
          row.liabilities[l.id].offsetApplied = offsetNom * defl;
          liabSeries[l.id][m + 1] = b1 / inflAt(m + 1);
        }
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
      const net = inc - (exp + propExpenseOut) - tax - loanPayReal - settlementOut - superContribCashOut;
      wcaBal += net;
      if (row) {
        row.income += inc;
        row.cashDistributions += cashDist;
        row.expenses += exp + propExpenseOut;
        row.tax += tax;
        row.surplusOrDeficit += net;
        row.wcaDetail.netFlow += net;
      }

      // d. Top the WCA back up to its minimum from fundingOrder (then
      // released super, same fallback as before) when this month's net
      // has pushed it below — fundingOrder never touches the WCA above
      // minimum; it only ever refills it. No monthly surplus sweep:
      // surplus just sits in the WCA, growing, until FY-end below.
      if (wcaBal < wca.minimumBalance) {
        let shortfall = wca.minimumBalance - wcaBal;
        for (const id of fundingOrder) {
          if (shortfall <= 0) break;
          const paid = sell(id, shortfall, m);
          shortfall -= paid;
          wcaBal += paid;
          if (row) {
            row.deficitFundedFromAssets += paid;
            row.perAssetDetail[id].deficitFunding += paid;
          }
        }
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

      // FY-end sweep: the WCA's balance above minimumBalance, only on
      // the FY's final month, per settings.surplus.mode. Ungated (runs
      // in both passes, the same way the old monthly surplus-invest
      // step did) — bal/wcaBal are snapshotted and discarded after the
      // measurement pass regardless, and the sweep can't affect this
      // year's already-accrued income, so there is nothing to gate.
      if (m === last - 1 && wcaBal > wca.minimumBalance) {
        const excess = wcaBal - wca.minimumBalance;
        if (surplusMode === "invest" && surplusTargetId) {
          wcaBal -= excess;
          bal[surplusTargetId] += excess;
          if (meta[surplusTargetId].cgt) pools[surplusTargetId] = poolAdd(pools[surplusTargetId], excess);
          if (row) {
            row.surplusInvested += excess;
            row.perAssetDetail[surplusTargetId].surplusInvested += excess;
            row.wcaDetail.sweptInvested += excess;
          }
        } else if (surplusMode === "spend") {
          wcaBal -= excess;
          if (row) {
            row.surplusSpent += excess;
            row.wcaDetail.sweptSpent += excess;
          }
        } else if (row) {
          // "accumulate" (default): stays in the WCA — nothing moves,
          // just recorded for the Funding section's "swept to cash" row.
          row.surplusAccumulated += excess;
          row.wcaDetail.sweptToCash += excess;
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
      const released = Math.min(personDue, superBal[accountId]);
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
      };
    }

    // Document Set Commit 3 (FHSSS) — resolved once per FY, before
    // either pass (same "year-sequential state" reasoning as the super
    // cap outcome above): associated earnings accrue for the year on
    // the OPENING balance, then this FY's FHSSS-eligible voluntary
    // contributions (schedule.fhsssFlows) are accepted up to the
    // combined $15,000/year, $50,000/lifetime cap.
    for (const p of persons) {
      const fb = fhsssBal[p];
      if (fb.released) continue; // one lifetime release per person — nothing left to accrue
      const opening = fb.concessional + fb.nonConcessional + fb.earnings;
      fb.earnings += opening * fhsssAnnualReal;
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
        fhsssRelease[per] = { ...amounts, propertyId: p.id };
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
    const propValSnap = { ...propVal };
    const propPoolSnap = { ...propPools };
    const wcaBalSnap = wcaBal;
    const measured = runYear(y, {
      taxOut: null, cgtDue, row: null, trackUnfunded: false, superOutcome,
      divReleaseFromSuper, divReleaseAccountId, fhsssRelease,
    });
    Object.assign(bal, balSnap);
    pools = poolSnap;
    Object.assign(loanBal, loanSnap);
    Object.assign(propVal, propValSnap);
    propPools = propPoolSnap;
    wcaBal = wcaBalSnap;

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
    const dependentChildren = state.plan.dependentChildren ?? 0;

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
        const helpWithheld = Math.min(helpRepaymentAmount(employmentIncomeFy, helpRatesY), helpBal[p]);
        const mlsWithheld = mlsSurchargeAmount({
          ownIncome: employmentIncomeFy,
          comparisonIncome: isFamily ? familyIncome : employmentIncomeFy,
          hasCover: (p === "partner" ? state.plan.partner : state.plan.client)?.privateHospitalCover !== false,
          isFamily, dependentChildren, rates: mlsRatesY,
        });
        for (let m = yearStart(y); m < yearEnd(y); m++) {
          if (empArr[m] > 0) taxOutArr[m] += (paygWithheld[p] + helpWithheld + mlsWithheld) * (empArr[m] / employmentIncomeFy);
        }
        newPendingRefund[p] = (paygWithheld[p] + helpWithheld + mlsWithheld) - (a.netIncomeTax + helpDue[p] + mlsDue[p]);
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
    row.openingBalance = combined[yearStart(y)];
    row.wcaDetail.opening = wcaSeries[yearStart(y)];
    for (const l of liabs) row.liabilities[l.id].opening = liabSeries[l.id][yearStart(y)];
    for (const id of ids) row.perAssetDetail[id].opening = series[id][yearStart(y)];
    for (const id of superIds) row.superDetail[id].opening = superSeries[id][yearStart(y)];
    const real = runYear(y, {
      taxOut: taxOutArr, cgtDue, row, trackUnfunded: true, superOutcome,
      divReleaseFromSuper, divReleaseAccountId, fhsssRelease,
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
      actualTaxPayable: assessed[p].netIncomeTax,
      // Reuses newPendingRefund[p] rather than recomputing — that value
      // is already 0 for a no-employment-income person (their tax
      // stayed on the smooth accrual entirely; there is no PAYG
      // estimate to compare against, so reporting a "balancing payment"
      // here would be a number that never corresponds to any real cash
      // event).
      refundOrBalancing: newPendingRefund[p],
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
      // component), for the Tax view's visibility of "the tax benefit".
      fhsssRelease: fhsssRelease?.[p]?.grossRelease ?? 0,
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
  };
}
