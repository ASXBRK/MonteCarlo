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

import { PROFILES } from "./profiles.js";
import { buildSchedules, firstFyStartYear, superContributionAllowed } from "./schedule.js";
import { resolveRef } from "./keyDates.js";
import { superRatesFor, superReleaseAge } from "./data/superRates.js";
import {
  processConcessionalCap, processNonConcessionalCap, div293Tax, availableCarryForward,
} from "./Tax/superContributions.js";
import { levelPayment, monthlyRate, termMonths, ioMonths } from "./liabilities.js";
import { dutyWithConcessions, fhogAmount } from "./data/stampDuty.js";
import { assessPerson } from "./Tax/annual.js";
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
    frankingPct: p ? (p.frankingPct ?? 0) : 0,
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
export function projectPlan(state, profiles = PROFILES) {
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
  const superWarnings = [...schedule.superWarnings]; // age/work-test rejections, resolved in schedule.js

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
      loanId: null,
    };
    propVal[p.id] = owned ? p.currentValue : 0;
    if (!owned && purchaseMonth != null && p.lvrPct > 0) {
      // The purchase loan: 30-year P&I at the mortgage-rate assumption,
      // nominal balance = LVR × nominal price at settlement (known
      // upfront — the projection is deterministic).
      const nominalPrice = p.priceToday * Math.pow(1 + p.growthPct / 100, purchaseMonth / 12);
      const loanNominal = (p.lvrPct / 100) * nominalPrice;
      derivedLoans.push({
        id: `prop-${p.id}`,
        name: `${p.name} loan`,
        owner: p.owner,
        balance: loanNominal,
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
    if (offsetId) (offsetLoansByAsset[offsetId] ??= []).push(l.id);
  }
  const inflAt = (m) => Math.pow(1 + cpi, m / 12);

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

  const yearStart = (y) => (y === 0 ? 0 : schedule.monthsInFirstYear + 12 * (y - 1));
  const yearEnd = (y) => schedule.monthsInFirstYear + 12 * y;

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
    // Per-liability detail (D3), real dollars; closing filled at year
    // end. netAssets = assets + property − liabilities.
    liabilities: Object.fromEntries(liabs.map((l) => [l.id, { interest: 0, principal: 0, closing: 0 }])),
    liabilitiesClosing: 0,
    // Per-property detail (D4), real dollars.
    properties: Object.fromEntries(props.map((p) => [p.id, {
      value: 0, rent: 0, expenses: 0, settlement: 0, costBaseSeed: 0,
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
    superDetail: Object.fromEntries(superIds.map((id) => [id, {
      opening: 0, contributions: 0, contributionsTax: 0,
      earnings: 0, earningsTax: 0, withdrawals: 0, closing: 0, taxFreeClosing: 0,
    }])),
    superClosing: 0,
  });

  // Run one plan year's months. opts:
  //   taxOut  — Float64Array over absolute month indices (real pass) or null
  //   cgtDue  — household CGT payable in this year's first month (July)
  //   row     — ledger row to fill (real pass) or null
  //   trackUnfunded — record into the projection-level shortfall trackers
  // Returns per-person income components + realised gains + months in
  // which each person's income arose.
  function runYear(y, { taxOut, cgtDue, row, trackUnfunded, superOutcome }) {
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
      acc[p] = { ordinary: 0, franked: 0, unfranked: 0, deductions: 0, netCapitalGain: 0, incomeMonths: new Set() };
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
        const offsetting = offsetLoansByAsset[id];
        if (offsetting) {
          const loanReal = offsetting.reduce((s, lid) => s + loanBal[lid], 0) / inflAt(m);
          const excess = Math.max(0, bal[id] - loanReal);
          const offsetPortion = bal[id] - excess;
          g = excess * meta[id].rate + offsetPortion * cpiDecayMonthly;
        } else {
          g = bal[id] * meta[id].rate;
        }
        bal[id] += g;
        if (row) {
          row.growth += g;
          row.perAssetDetail[id].growth += g;
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
        for (const id of superIds) {
          const sm = superMeta[id];
          const grossGrowth = superBal[id] * sm.grossRate;
          const netGrowth = superBal[id] * sm.rate;
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
          const costsReal = (p.purchaseCostsPct / 100) * realPrice;
          const fhogReal = fhogAmount(p.state, nominalPrice, { firstHomeBuyer: p.firstHomeBuyer, newBuild: p.newBuild }) / infl;
          const loanReal = pm.loanId ? (p.lvrPct / 100) * realPrice : 0;
          if (pm.loanId) loanBal[pm.loanId] = liabsById[pm.loanId].balance; // drawdown
          const settle = realPrice - loanReal + dutyReal + costsReal - fhogReal;
          settlementOut += settle;
          propVal[pid] = realPrice;
          if (pm.isCgt) {
            propPools[pid] = createPool(realPrice + dutyReal + costsReal);
          }
          if (row) {
            row.properties[pid].settlement += settle;
            row.properties[pid].costBaseSeed = realPrice + dutyReal + costsReal;
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
          }
          if (row) {
            row.properties[pid].rent += rentM;
            row.properties[pid].expenses += expM;
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
        }
      }

      // d. Household position, including tax outflows (decision 14).
      const inc = schedule.income[m] + cashDist + rentIncome;
      for (const p of persons) {
        const own = p === "partner" ? schedule.incomeByOwner.partner : schedule.incomeByOwner.client;
        if (own && own[m] > 0) {
          acc[p].ordinary += own[m];
          acc[p].incomeMonths.add(m);
        }
      }
      const exp = schedule.expenses[m];
      const tax = (taxOut ? taxOut[m] : 0) + (m === first ? cgtDue : 0);
      const net = inc - (exp + propExpenseOut) - tax - loanPayReal - settlementOut;
      if (row) {
        row.income += inc;
        row.cashDistributions += cashDist;
        row.expenses += exp + propExpenseOut;
        row.tax += tax;
        row.surplusOrDeficit += net;
      }

      if (net > 0) {
        if (surplusTargetId) {
          bal[surplusTargetId] += net;
          if (meta[surplusTargetId].cgt) pools[surplusTargetId] = poolAdd(pools[surplusTargetId], net);
          if (row) {
            row.surplusInvested += net;
            row.perAssetDetail[surplusTargetId].surplusInvested += net;
          }
        }
        // "spend" → disappears.
      } else if (net < 0) {
        let shortfall = -net;
        for (const id of fundingOrder) {
          if (shortfall <= 0) break;
          const paid = sell(id, shortfall, m);
          shortfall -= paid;
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
            row.superDetail[id].withdrawals += paid;
          }
        }
        recordUnfunded(shortfall, m);
      }

      if (row) {
        let total = 0;
        for (const id of ids) {
          series[id][m + 1] = bal[id];
          total += bal[id];
        }
        combined[m + 1] = total;
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
    const div293Due = y > 0 ? pendingDiv293.client + pendingDiv293.partner : 0;
    const div293DueDetail = y > 0 ? pendingDiv293 : { client: 0, partner: 0 };
    const cgtDue = (y > 0 ? pendingCgt.client + pendingCgt.partner : 0) + div293Due;
    const cgtDueDetail = y > 0 ? pendingCgt : { client: 0, partner: 0 };

    // Super contribution caps (Tier 1.2, Commit 2): resolved ONCE per
    // FY, before either pass — concessional carry-forward and NCC
    // bring-forward are year-SEQUENTIAL state that must advance exactly
    // once per real FY, not once per measurement/real pass. The outcome
    // (contributions tax rate, the accepted NCC fraction, dynamic
    // "toConcessionalCap" fills, excess CC, and the Div293 inputs) is
    // handed to runYear for crediting in the real pass only.
    const superRatesY = superRatesFor(fyStart, bracketMode, cpi);
    const superOutcome = { client: null, partner: null };
    for (const p of persons) {
      const tsbPriorJune = superAccountsByOwner[p].reduce((s, id) => s + superBal[id], 0);
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
        fills.push({ accountId: tc.accountId, amount: headroom });
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

    // FY rollover: this-FY pool additions age into old money.
    for (const id of ids) if (meta[id].cgt) pools[id] = poolNewFy(pools[id]);

    // Pass 1 — measure the year's income with no income-tax outflows.
    // Pool objects are immutable, so a shallow copy snapshots them.
    const balSnap = { ...bal };
    const poolSnap = { ...pools };
    const loanSnap = { ...loanBal };
    const propValSnap = { ...propVal };
    const propPoolSnap = { ...propPools };
    const measured = runYear(y, { taxOut: null, cgtDue, row: null, trackUnfunded: false, superOutcome });
    Object.assign(bal, balSnap);
    pools = poolSnap;
    Object.assign(loanBal, loanSnap);
    Object.assign(propVal, propValSnap);
    propPools = propPoolSnap;

    // Negative gearing rules (D4): a net rental loss offsets other
    // income only when the loss year is pre-FY2027-28, the property is
    // a new build, or it was acquired before 12 May 2026
    // (grandfathered). Otherwise the loss is quarantined per owner —
    // carried forward against future net rental profits first, then
    // capital gains. Property flows are balance-independent, so the
    // measured components are exact for both passes.
    const newQuarantine = { client: 0, partner: 0 };
    for (const per of persons) {
      let rentalProfit = 0;
      for (const pid in propMeta) {
        const pm = propMeta[pid];
        if (!pm.invest) continue;
        const pn = measured._propNet[pid];
        const share = pm.shares[per] ?? 0;
        const net = (pn.rent - pn.expenses) * share - pn.interest[per];
        if (net >= 0) { rentalProfit += net; continue; }
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
      });
      assessed[p] = a;
      spreadTax(a.netIncomeTax, measured[p].incomeMonths, yearEnd(y) - 1);
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
    row.openingBalance = combined[yearStart(y)];
    for (const id of ids) row.perAssetDetail[id].opening = series[id][yearStart(y)];
    for (const id of superIds) row.superDetail[id].opening = superSeries[id][yearStart(y)];
    const real = runYear(y, { taxOut: taxOutArr, cgtDue, row, trackUnfunded: true, superOutcome });
    row.closingBalance = combined[yearEnd(y)];
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
    const deflEnd = 1 / Math.pow(1 + cpi, yearEnd(y) / 12);
    for (const l of liabs) {
      const closingReal = loanBal[l.id] * deflEnd;
      row.liabilities[l.id].closing = closingReal;
      row.liabilitiesClosing += closingReal;
    }
    for (const pid in propMeta) {
      row.properties[pid].value = propVal[pid];
      row.propertyClosing += propVal[pid];
    }
    row.netAssets = row.closingBalance + row.propertyClosing + row.superClosing - row.liabilitiesClosing;

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
      cgt: cgtDueDetail[p],
      div293: div293DueDetail[p],
      frankingCredits: assessed[p].frankingCredits,
    } : null;
    for (const p of persons) quarantineCarry[p] += newQuarantine[p]; // available from next FY
    row.taxDetail = {
      client: detail("client"),
      partner: detail("partner"),
      incomeTax: persons.reduce((s, p) => s + assessed[p].netIncomeTax, 0),
      cgt: cgtDue - div293Due, // cgtDue folds in div293Due for the actual cash outflow; reported separately here
      div293: div293Due,
      frankingCredits: persons.reduce((s, p) => s + assessed[p].frankingCredits, 0),
    };
    yearly.push(row);
    pendingCgt = newPending;
    pendingDiv293 = newPendingDiv293;
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
    monthly: { combined, perAsset: series },
    yearly,
    shortfall,
    accruedCgtAtEnd: pendingCgt.client + pendingCgt.partner,
    // Tier 1.2: the final FY's Division 293 is unpayable inside the
    // projection, same as accruedCgtAtEnd; superWarnings collects every
    // rejected/gated contribution (age 75, work test, excess NCC)
    // across the whole projection, not silently dropped.
    accruedDiv293AtEnd: pendingDiv293.client + pendingDiv293.partner,
    superWarnings,
  };
}
