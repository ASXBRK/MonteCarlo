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
import { minDrawdownAmount, TTR_MAX_DRAWDOWN_PCT } from "./data/pensionRates.js";
import { createTransferBalanceAccount, indexTransferBalanceCap, creditTransferBalance, debitTransferBalance } from "./pensionTba.js";
import { agePensionRatesFor, WORK_BONUS, cshcThresholdsFor } from "./data/agePension.js";
import { HEAS_BASE, heasEffectiveAnnualRate, heasMaxLoanAmount } from "./data/heas.js";
import { isDeathBenefitTaxDependant } from "./planState.js";
import { LEG } from "./Tax/engine.js";
import {
  assessableAssets as agePensionAssessableAssets, deemedIncome as agePensionDeemedIncome,
  assessableIncome as agePensionAssessableIncome, singleAgePensionAssessment, coupleAgePensionAssessment,
  workBonusApply,
} from "./agePensionMeansTest.js";
import { resolveGiftDeprivation, deprivedAssetsAt } from "./gifting.js";
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
import { landTaxOnValue } from "./data/landTax.js";
import { etpRatesFor, redundancyTaxFreeAmount, etpTax } from "./data/etpRates.js";
import { exemptProportion } from "./mainResidence.js";
import { spouseSuperRatesFor, spouseContributionOffset, coContribution, listo } from "./data/spouseSuperRates.js";
import { assessPerson } from "./Tax/annual.js";
import { div296Tax } from "./Tax/div296.js";
import { decomposeNetWorthChange } from "./conservationCheck.js";
import { dependentChildrenCountInFY, pensionMinCommenceAge } from "./planState.js";
import {
  createPool, poolAdd, poolConsume, poolNewFy,
  poolDeemedReacquisition, preReformTaxableGain,
} from "./costBasePool.js";
import {
  bondEffectiveTaxRate, bondStartMonthIndex, bondContributionCapCheck, bondHasMatured, bondWithdrawalTax,
  bondMaturityMonth, bondWithdrawalSplit, bondEducationBenefit,
} from "./bonds.js";

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
// Death benefits (spec 22, Commit 1) — a TERMINAL planning figure only,
// computed ONCE against the FINAL projection year's already-closed
// super/pension balances: "if this balance passes to these
// beneficiaries, this is what they receive" (spec's own words) — no
// projection branches, not partner-death modelling. Pure and
// side-effect-free; called once per person after the year loop
// finishes, never per-year.
//
// Components are read straight from the SAME superTaxFree/
// pensionTaxFree tracking every other engine feature already relies
// on — a pension's tax-free proportion is FIXED at commencement
// (pensionFixedProportion), an accumulation account's is the LIVE
// ratio — so "sourced correctly from a pension (fixed) versus an
// accumulation account (recalculated)" (the spec's own test) is
// already true by construction, not something this function derives
// itself.
//
// The untaxed element applies only to untaxed-source funds (some
// public sector); NOT modelled (disclosed) — this tool has no
// untaxed-source fund concept anywhere — so taxableUntaxed is always
// 0, reported as its own column rather than silently omitted.
//
// Tax (Commit 1's own table): a dependant (spouse/minor child/
// interdependent/financial dependant) receives every component NANE,
// regardless of tax-free vs taxable — no tax at all. A non-dependant
// (the common case: an adult child) pays 15%/30% PLUS Medicare (a flat
// 2%, not shaded — this is a beneficiary who isn't one of the two
// modelled taxpayers, so there is no "other income" to shade against;
// the spec's own table gives flat rates, not a marginal calculation).
// "estate" is taxed like a non-dependant but WITHOUT Medicare — the
// real, frequently-missed ATO distinction the spec's own header calls
// out — a disclosed simplification of "taxed per ultimate beneficiary"
// (not modelled: this tool has no concept of who the estate's own
// beneficiaries are).
// Reversionary pensions (spec 22, Commit 2) — the `reversionary` flag
// (spec 20, Commit 1) previously had no consequence; here it means a
// pension continues DIRECTLY to the spouse rather than being paid as a
// lump sum, so it's excluded from the ordinary beneficiary split below
// entirely (a couple-only concept — meaningless with no spouse to
// revert to; couple is checked defensively here even though
// clampPension already resets `reversionary` to false for a single
// household, since this raw-state-tolerant engine defends every other
// dangling/impossible combination the same way). NANE to the spouse as
// a tax dependant (always — spec's own words), so it needs no tax
// computation of its own, only the transfer balance consequence: the
// credit lands on the SURVIVOR's own transfer balance account, at the
// value AT THE DATE OF DEATH (this FY's closing balance — no 12
// months of further growth is simulated; this is a terminal figure,
// consistent with Commit 1), which can push the survivor over their
// OWN cap — the actual planning issue, so it's reported explicitly
// rather than silently absorbed. Twelve-months-after-death is a
// disclosed TIMING fact only (the real law's own deliberate delay,
// giving the survivor time to restructure) — not simulated, since
// nothing projects past the final year here anyway.
// Death benefit tax on a taxable amount, by beneficiary relationship
// (Commit 1's own table) — extracted and exported so
// focusDeathBenefits.js's "alternative nomination" comparison (Commit
// 3) can reuse the EXACT same rule for a hypothetical relationship,
// rather than re-deriving it and risking the two quietly diverging.
export function deathBenefitTax(relationship, taxableTaxed, taxableUntaxed) {
  if (isDeathBenefitTaxDependant(relationship)) return 0;
  if (relationship === "estate") return taxableTaxed * 0.15 + taxableUntaxed * 0.30;
  return taxableTaxed * (0.15 + LEG.medicareLevy) + taxableUntaxed * (0.30 + LEG.medicareLevy);
}

function computeReversionaryPensions(owner, pensionRows, finalRow, couple, tba) {
  if (!couple) return [];
  const survivor = owner === "client" ? "partner" : "client";
  const survivorTbaBefore = tba[survivor];
  return pensionRows.filter((pn) => pn.owner === owner && pn.reversionary === true).map((pn) => {
    const d = finalRow.pensionDetail[pn.id];
    const valueAtDeath = d?.closing ?? 0;
    const { tba: survivorTbaAfter, excess, excessTaxRate } = creditTransferBalance(survivorTbaBefore, valueAtDeath);
    return {
      pensionId: pn.id, pensionName: pn.name, valueAtDeath,
      survivorTbaBefore: { balance: survivorTbaBefore.balance, personalCap: survivorTbaBefore.personalCap },
      survivorTbaAfter: { balance: survivorTbaAfter.balance, personalCap: survivorTbaAfter.personalCap },
      excess: excess ?? 0, excessTaxRate,
    };
  });
}

function computeDeathBenefitForPerson(owner, person, superAccounts, pensionRows, finalRow, couple, tba) {
  const beneficiaries = person?.deathBenefit?.beneficiaries ?? [];
  const reversionaryPensions = computeReversionaryPensions(owner, pensionRows, finalRow, couple, tba);
  if (beneficiaries.length === 0 && reversionaryPensions.length === 0) return null;

  const accounts = [];
  for (const s of superAccounts) {
    if (s.owner !== owner) continue;
    const d = finalRow.superDetail[s.id];
    if (!d) continue;
    const taxFree = Math.min(Math.max(0, d.taxFreeClosing), d.closing);
    accounts.push({ id: s.id, name: s.name, kind: "super", closing: d.closing, taxFree, taxableTaxed: Math.max(0, d.closing - taxFree), taxableUntaxed: 0 });
  }
  for (const pn of pensionRows) {
    if (pn.owner !== owner) continue;
    if (pn.reversionary === true && couple) continue; // continues to the spouse instead — see computeReversionaryPensions
    const d = finalRow.pensionDetail[pn.id];
    if (!d) continue;
    const taxFree = Math.min(Math.max(0, d.taxFreeClosing), d.closing);
    accounts.push({ id: pn.id, name: pn.name, kind: "pension", closing: d.closing, taxFree, taxableTaxed: Math.max(0, d.closing - taxFree), taxableUntaxed: 0 });
  }

  const byBeneficiary = beneficiaries.map((b) => {
    const share = b.sharePct / 100;
    const isDependant = isDeathBenefitTaxDependant(b.relationship);
    let taxFreeTotal = 0, taxableTaxedTotal = 0, taxableUntaxedTotal = 0, taxTotal = 0;
    const perAccount = accounts.map((a) => {
      const taxFreeShare = a.taxFree * share;
      const taxableTaxedShare = a.taxableTaxed * share;
      const taxableUntaxedShare = a.taxableUntaxed * share;
      const tax = deathBenefitTax(b.relationship, taxableTaxedShare, taxableUntaxedShare);
      taxFreeTotal += taxFreeShare; taxableTaxedTotal += taxableTaxedShare; taxableUntaxedTotal += taxableUntaxedShare; taxTotal += tax;
      return {
        accountId: a.id, accountName: a.name, kind: a.kind,
        taxFree: taxFreeShare, taxableTaxed: taxableTaxedShare, taxableUntaxed: taxableUntaxedShare, tax,
      };
    });
    const gross = taxFreeTotal + taxableTaxedTotal + taxableUntaxedTotal;
    return {
      id: b.id, label: b.label, relationship: b.relationship, sharePct: b.sharePct, isDependant,
      accounts: perAccount,
      taxFree: taxFreeTotal, taxableTaxed: taxableTaxedTotal, taxableUntaxed: taxableUntaxedTotal,
      gross, tax: taxTotal, net: gross - taxTotal,
    };
  });

  const totals = byBeneficiary.reduce((acc, b) => ({
    gross: acc.gross + b.gross, tax: acc.tax + b.tax, net: acc.net + b.net,
  }), { gross: 0, tax: 0, net: 0 });

  return { accounts, byBeneficiary, totals, reversionaryPensions };
}

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
    // Untaxed elements (spec 26, Commit 1) — an untaxed-status account
    // (public-sector schemes like West State Super) pays NO 15%/10%
    // earnings-tax haircut inside the fund at all: `rate` simply equals
    // `grossRate`, the same "no wedge" shape retirement-phase pension
    // growth already uses (pensionMeta's own inRetirementPhase branch).
    // The reporting split (row.superDetail[id].earningsTax) falls out
    // for free at the existing `grossGrowth - netGrowth` line below,
    // since netGrowth already equals grossGrowth when rate === grossRate.
    const untaxed = s.taxedStatus === "untaxed";
    const grossRate = toMonthlyReal(incomeNominal + growthNominal - icr, cpi);
    superMeta[s.id] = {
      // Actual compounding rate: both components taxed, THEN combined
      // and Fisher-converted — same structure assetMonthlyRate uses.
      rate: untaxed ? grossRate : toMonthlyReal(incomeNominal * (1 - rates.earningsTaxRate) + growthNominal * (1 - growthTaxRate) - icr, cpi),
      // Pre-tax rate, for the earnings/earnings-tax reporting split only.
      grossRate,
      owner: s.owner,
      taxedStatus: untaxed ? "untaxed" : "taxed",
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
  // pensions, which fix the proportion once at commencement — see the
  // pension phase section below). Never cascades to another account —
  // same convention as explicit financial-asset withdrawals.
  function withdrawFromSuper(id, want) {
    const balance = superBal[id];
    const paid = Math.min(want, balance);
    if (paid <= 0) return 0;
    const taxFreeFraction = balance > 0 ? superTaxFree[id] / balance : 0;
    superTaxFree[id] -= paid * taxFreeFraction;
    superBal[id] -= paid;
    return paid;
  }

  // --- Investment and education bonds (spec 25, Commit 1) -------------------
  //
  // A distinct pocket, never merged into `bal`/`combined`/fundingOrder
  // (same pattern as super/pensions/properties/liabilities): its own
  // balance series, its own per-year detail block. Earnings are taxed
  // INSIDE the bond at bondEffectiveTaxRate (30% less the franked
  // proportion's benefit — see bonds.js) and NEVER touch acc[p] — this
  // is what keeps them out of assessable income, HELP repayment income,
  // Division 293 income and the Medicare Levy Surcharge base, all by
  // construction, the same way a pension's tax-free component never
  // reaches acc[p] either. Only GAINS are taxed (a negative-return month
  // realises no rebate) — a disclosed simplification, no fund-level
  // capital-loss carry-forward modelled, matching the "no CGT discount"
  // simplification bonds.js's own header already discloses.
  const bonds = (state.bonds ?? []).filter((b) => b.include);
  const bondMeta = {};
  for (const b of bonds) {
    const { incomeNominal, growthNominal, frankingPct } = assetReturnComponents(b, profiles);
    const icr = b.icrPct / 100;
    bondMeta[b.id] = {
      // Pre-tax rate — for the earnings/internal-tax reporting split,
      // the same grossRate/rate (net) pairing superMeta uses.
      grossRate: toMonthlyReal(incomeNominal + growthNominal - icr, cpi),
      effectiveRate: bondEffectiveTaxRate(frankingPct),
      shares: ownerShares(b, couple),
      startMonth: bondStartMonthIndex(b.startDate, state.plan.start),
    };
  }
  // Linked withdrawals (spec 25, Commit 3) — resolved once, per bond,
  // from the child's own pre-built fee schedule (schedule.js's
  // childEducationFlows). Any bond with a real beneficiary gets one,
  // regardless of type (education vs investment) — the a-bonds block
  // below branches the WITHDRAWAL'S TAX TREATMENT on b.type, not
  // whether the withdrawal happens at all; every bond with no
  // beneficiary simply has no entry here at all.
  const bondEducationFlow = {};
  for (const b of bonds) {
    if (b.beneficiaryChildId) {
      bondEducationFlow[b.id] = schedule.childEducationFlows?.[b.beneficiaryChildId] ?? null;
    }
  }
  const bondBal = {};
  const bondSeries = {};
  const bondCostBase = {}; // running notional cost base — original investment only, never earnings
  // The 125% rule's own live state (spec 25, Commit 1's "single most
  // important warning") — the PRIOR and THIS FY's contribution totals,
  // and the clock's CURRENT effective start month (bondMeta's own
  // startMonth is the OPENING value; a breach resets THIS, not that,
  // so the opening figure stays available for reference/reporting).
  const bondPriorFyContribution = {};
  const bondThisFyContribution = {};
  const bondEffectiveStartMonth = {};
  const bondWarnings = [];
  for (const b of bonds) {
    bondBal[b.id] = b.balance;
    bondSeries[b.id] = new Float64Array(months + 1);
    bondSeries[b.id][0] = b.balance;
    bondCostBase[b.id] = b.balance;
    bondPriorFyContribution[b.id] = null; // null = no prior FY assessed yet (see the FY-end check's own comment)
    bondThisFyContribution[b.id] = 0;
    bondEffectiveStartMonth[b.id] = bondMeta[b.id].startMonth;
  }

  // --- pension phase (spec 20, Commit 1) -------------------------------------
  //
  // A pension is always COMMENCED from an existing super account WITHIN
  // the projection — there is no "already in pension phase at plan
  // start" input (planState.js's own header note). Its own balance
  // series/detail therefore always opens at 0, the same shape as a
  // planned (not-yet-purchased) property's opening value — see
  // conservationCheck.js's own caveat on why randomScenario() must
  // never generate a pension with a nonzero opening balance either.
  //
  // Growth: "the reason pension phase exists" (spec 20, Commit 3) — an
  // ABP in RETIREMENT PHASE pays no tax on earnings (capital gains
  // included — this engine already accrues gains smoothly into the
  // return rate rather than tracking discrete realisation events, the
  // same simplification accumulation super's own earnings tax uses, so
  // "untaxed" here means the SAME smooth-accrual rate with the tax
  // wedge simply zeroed). A TTR is NOT in retirement phase — its
  // earnings stay taxed exactly like accumulation (15%/10%) — UNTIL it
  // converts, at the first of two triggers: turning 65 (automatic), or
  // notifying retirement at/after preservation age (retirementAge) —
  // exactly pensionMinCommenceAge's own ABP formula (superReleaseAge):
  // retiring before 60 doesn't count until 60 is ALSO reached, since a
  // full condition of release always requires reaching preservation age
  // regardless of when someone actually stopped working. taxedRate is
  // the Commit 1 accumulation-style formula (still used for a TTR
  // before conversion); grossRate is the account's TRUE pre-tax return,
  // reused UNCHANGED as the net rate too once in retirement phase (0%
  // tax = no wedge between gross and net) — resolved fresh every month
  // in the growth step below, not fixed once like superMeta's own rate
  // (which never needs to change mid-projection; a TTR's DOES, at its
  // own conversion point).
  const pensionRows = state.plan.pensions ?? [];
  const pensionIds = pensionRows.map((pn) => pn.id);
  const pensionMeta = {};
  for (const pn of pensionRows) {
    const { incomeNominal, growthNominal } = assetReturnComponents(pn, profiles);
    const icr = pn.icrPct / 100;
    const rates = superRatesFor(fy0, bracketMode, cpi);
    const growthTaxRate = rates.earningsTaxRate * (2 / 3);
    const ownerPerson = pn.owner === "partner" ? state.plan.partner : state.plan.client;
    pensionMeta[pn.id] = {
      taxedRate: toMonthlyReal(incomeNominal * (1 - rates.earningsTaxRate) + growthNominal * (1 - growthTaxRate) - icr, cpi),
      grossRate: toMonthlyReal(incomeNominal + growthNominal - icr, cpi),
      // Irrelevant for an ABP (always in retirement phase, from
      // commencement) — computed for every pension uniformly anyway,
      // cheap and side-effect-free.
      retirementPhaseFromAge: superReleaseAge(ownerPerson?.retirementAge),
      owner: pn.owner,
      sourceAccountId: pn.sourceAccountId,
      type: pn.type,
      drawdownOption: pn.drawdownOption,
      fixedAmount: pn.fixedAmount,
      indexBasis: pn.indexBasis,
      indexExtraPct: pn.indexExtraPct,
      // Deeming grandfathering (spec 21b, Commit 3) — a fixed factor
      // from plan state, never recomputed engine-side (see
      // clampPension's own header: the LE factor is anchored to the
      // OWNER's age at the historical commencement date, not to any
      // moving "current" age).
      grandfathered: pn.grandfathered === true,
      grandfatheredPurchasePrice: pn.grandfatheredPurchasePrice ?? 0,
      grandfatheredLifeExpectancyYears: pn.grandfatheredLifeExpectancyYears ?? null,
    };
  }
  const pensionBal = {};
  const pensionSeries = {};
  // Taxable component = balance − pensionTaxFree, same shape as super's
  // own superTaxFree — but UNLIKE super, never recalculated from the
  // live ratio after commencement (the proportioning rule, see below).
  const pensionTaxFree = {};
  // Fixed at the commencement MONTH from the source account's
  // then-current components, and never recomputed again — "the single
  // most important mechanical difference from accumulation" (spec 20's
  // own words). Every subsequent debit (growth touches neither side;
  // a payment/commutation does) reduces pensionTaxFree by exactly
  // `debit × this fixed proportion`, NOT by the live balance ratio the
  // way withdrawFromSuper's own taxFreeFraction is.
  const pensionFixedProportion = {};
  const pensionCommenced = {}; // guards the one-off transfer firing at most once per pension
  // The commencement amount, CAPPED via reserveFromSuper against
  // whatever adviser fees/Division 293/296/FHSSS already claimed on the
  // SAME account this SAME year — resolved once per FY, before the
  // monthly loop even starts (see the reserveFromSuper block, later in
  // this function). Read (not written) by the in-month commencement
  // transfer below.
  const pensionCommenceReserved = {};

  // Pay `want` real dollars from a pension, proportioning tax-free/
  // taxable at the FIXED commencement-time ratio — never recalculated,
  // the mirror of withdrawFromSuper but for the proportioning rule's
  // OTHER branch (see this block's own header). Never cascades to
  // another pocket, same convention as withdrawFromSuper.
  function withdrawFromPension(id, want) {
    const balance = pensionBal[id];
    const paid = Math.min(want, Math.max(0, balance));
    if (paid <= 0) return 0;
    pensionTaxFree[id] -= paid * pensionFixedProportion[id];
    pensionBal[id] -= paid;
    return paid;
  }

  // --- drawdown, minimums, and payments (spec 20, Commit 2) ------------------
  //
  // pensionAnnualAmount[id]: this FY's determined payment, resolved
  // ONCE per FY — either in the per-year setup below (an already-
  // commenced pension, whose 1 July balance is known before either
  // pass runs) or inline in the monthly loop, right after the
  // commencement transfer fires (a newly-commencing pension, whose
  // basis is the just-transferred amount — see minDrawdownAmount's own
  // header on why this is ALWAYS a full 12-month basis in this engine:
  // commencement can only ever land on 1 July). null for an
  // "expenditure" pension — its payment is resolved dynamically, month
  // by month, inside the deficit-funding step (see the "d." block).
  // pensionMinThisYear[id]: this FY's minimum — the floor under every
  // option, and (for "expenditure") the FY-end top-up target.
  // pensionPaidYtd[id]: running total actually paid so far this FY —
  // real-pass only (mirrors superOutcome/superCapUsage's own "resolved
  // once, credited only in the real pass" shape).
  const pensionAnnualAmount = {};
  const pensionMinThisYear = {};
  const pensionPaidYtd = {};
  for (const pn of pensionRows) {
    pensionAnnualAmount[pn.id] = 0;
    pensionMinThisYear[pn.id] = 0;
    pensionPaidYtd[pn.id] = 0;
  }
  // The FY's payment amount for a pension whose basis (1 July balance,
  // or — in its own commencement year — the just-transferred amount)
  // is already known. Shared by the per-year setup (ongoing pensions)
  // and the in-month commencement handler (a newly-commencing pension).
  function resolvePensionThisYear(pn, basis, ownerAge, y) {
    const pm = pensionMeta[pn.id];
    const minAmount = minDrawdownAmount(basis, ownerAge, 12);
    pensionMinThisYear[pn.id] = minAmount;
    if (pm.drawdownOption === "expenditure") {
      pensionAnnualAmount[pn.id] = null; // resolved dynamically — see the header above
      return;
    }
    let requested = 0;
    if (pm.drawdownOption === "fixed") {
      const basisRate = pm.indexBasis === "awote" ? awoteAssum : pm.indexBasis === "cpi" ? cpi : 0;
      const g = basisRate + (pm.indexExtraPct ?? 0) / 100;
      // Real amount at FY start — the annual-figure form of the locked
      // indexation formula (no /12: this IS the annual amount, not a
      // monthly slice of one — see propFlowAt's own comment above for
      // the sibling monthly-slice form of the identical formula).
      requested = pm.fixedAmount * Math.pow((1 + g) / (1 + cpi), yearStartIdx(y) / 12);
    } else if (pm.drawdownOption === "maximum" && pm.type === "ttr") {
      requested = basis * TTR_MAX_DRAWDOWN_PCT;
    }
    // "minimum" (requested stays 0) and every other option: the minimum
    // always applies as a floor — "a plan that draws less than the
    // minimum is not a plan; it is a compliance breach" (spec's own words).
    pensionAnnualAmount[pn.id] = Math.max(minAmount, requested);
  }
  // --- transfer balance cap and account (spec 20, Commit 4) ------------------
  //
  // One account PER PERSON (not per pension — several pensions can
  // credit the SAME person's account). Seeded at the general cap as at
  // plan start; indexed once per FY thereafter by however much the
  // general cap itself moved (see pensionTba.js's own header for the
  // proportional-indexation rule). pensionTbaCredited[id] guards a
  // TTR's own (single, at-conversion) credit from firing more than
  // once — an ABP credits immediately at commencement instead (see the
  // commencement block below), so it never needs this guard.
  const transferBalanceCap0 = superRatesFor(fy0, bracketMode, cpi).generalTransferBalanceCap;
  const tba = { client: createTransferBalanceAccount(transferBalanceCap0), partner: null };
  if (state.plan.partner) tba.partner = createTransferBalanceAccount(transferBalanceCap0);
  let lastTransferBalanceCap = transferBalanceCap0;
  const pensionTbaCredited = {};
  for (const pn of pensionRows) pensionTbaCredited[pn.id] = false;

  for (const pn of pensionRows) {
    pensionBal[pn.id] = 0;
    pensionSeries[pn.id] = new Float64Array(months + 1);
    pensionTaxFree[pn.id] = 0;
    pensionFixedProportion[pn.id] = 0;
    pensionCommenced[pn.id] = false;
  }

  // --- Defined benefit pensions (spec 26, Commit 2) --------------------------
  //
  // A promised pension the client's own annual statement states — no
  // source super account, no balance to grow/draw (the spec's own
  // scoping principle: "we do not compute what the fund's actuary
  // computes"). Structurally simpler than an ABP/TTR pension: the
  // payment amount is a pure per-FY formula (annualPension, indexed),
  // never shortfall- or balance-dependent, so unlike EVERY other
  // super/pension mutation in this engine it is safe to credit UNGATED
  // (in both passes), the same way ordinary employment income is —
  // no one-year settlement lag is needed for its tax consequences at
  // all (contrast pendingUntaxedSuperTax's own header, which needs the
  // lag specifically because super mutation is real-pass-gated; a DB
  // pension has nothing to gate).
  const dbRows = state.plan.definedBenefits ?? [];
  const dbMeta = {};
  for (const db of dbRows) {
    dbMeta[db.id] = {
      owner: db.owner,
      annualPension: db.annualPension,
      indexBasis: db.indexBasis,
      indexExtraPct: db.indexExtraPct,
      taxFreeProportion: (db.taxFreeProportion ?? 0) / 100,
      untaxedProportion: (db.untaxedProportion ?? 0) / 100,
      notionalTaxedContributions: db.notionalTaxedContributions ?? 0,
    };
  }
  // Commencement (resolved further below, once julyOf exists — see the
  // block right after pensionCommenceMonth's own resolution) and the
  // TBA credit guard live in dbCommenceMonth/dbTbaCredited.

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
  // Work Bonus income bank (spec 21b, Commit 1) — year-sequential state,
  // same convention as superCarryForward: resolved once per FY, before
  // either pass, in the age pension setup block below. null until the
  // person's first year as an age-pension-age "new recipient" (starts
  // at WORK_BONUS.startingBalance then, not before — see that block).
  let workBonusBank = { client: null, partner: null };
  // Home Equity Access Scheme (spec 21b, Commit 5) — a single running
  // loan balance (real $, like every other balance in this engine),
  // resolved once per FY in the age-pension-adjacent per-year setup
  // below (same year-sequential convention as workBonusBank above):
  // drawdowns and capitalised interest both accrue onto it; never
  // reduced by anything else (no repayment path is modelled — real
  // rule too, the loan is recovered from the estate).
  let heasBal = 0;
  const heasConfig = state.plan.heas ?? { enabled: false, propertyId: null };
  let pendingDiv293 = { client: 0, partner: 0 }; // assessed FY t, paid July t+1 (same convention as CGT)
  let pendingDiv296 = { client: 0, partner: 0 }; // assessed FY t, paid July t+1 (same convention as CGT/Div293)
  // PAYG withholding / tax refund timing: assessed FY t (paygWithheld −
  // actualTaxPayable, per person with employment income that FY), paid
  // July t+1 (same convention). 0 for a person with no employment
  // income that FY — their tax stays on the pre-existing smooth
  // spreadTax accrual entirely (see the assessment loop below).
  let pendingRefund = { client: 0, partner: 0 };
  const superWarnings = [...schedule.superWarnings]; // age/work-test rejections, resolved in schedule.js
  // Bonus destinations (spec 23, Commit 2) — grouped by owner+year for
  // O(1) lookup in the per-person tax loop below, where the after-tax
  // amount is resolved (see that loop's own comment for why).
  const bonusEventsByOwnerYear = new Map();
  for (const ev of schedule.bonusDestinationEvents ?? []) {
    const key = `${ev.owner}::${ev.year}`;
    if (!bonusEventsByOwnerYear.has(key)) bonusEventsByOwnerYear.set(key, []);
    bonusEventsByOwnerYear.get(key).push(ev);
  }
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
  // HEAS (spec 21b, Commit 5) — the secured property, resolved once. A
  // stale/deleted/excluded propertyId (planState.js's own second-stage
  // refinement should already prevent this, but this raw-state-
  // tolerant engine defends anyway, same convention as every other
  // dangling-reference fallback here) simply means HEAS never fires.
  const heasProperty = heasConfig.enabled ? props.find((p) => p.id === heasConfig.propertyId) ?? null : null;
  const yearStartIdx = (y) => (y === 0 ? 0 : schedule.monthsInFirstYear + 12 * (y - 1));
  const julyOf = (y) => (y === 0 ? (state.plan.start.month === 7 ? 0 : null) : yearStartIdx(y));

  // Pension commencement month (spec 20, Commit 1) — resolved once
  // here, not per month, same as a property's own purchaseMonth just
  // above. commenceAt's own age (if age-kind) is CLIENT-anchored, per
  // convention (see planState.js's pensionMinCommenceAge header) — but
  // the condition-of-release GATE is scoped to the pension's OWNER, so
  // it cannot be enforced by bounding commenceAt itself (see that same
  // header). Instead: resolve commenceAt to its requested plan year,
  // then walk FORWARD (never back) to the first plan year the owner's
  // OWN age actually meets the type's gate — exactly how
  // schedule.js's superWithdrawal payments are gated against the
  // owner's real age each month, independent of the row's own window.
  const ownerAgeAt = (owner, y) => (owner === "partner" ? schedule.partnerAges?.[y] : schedule.clientAges[y]);
  const pensionCommenceMonth = {};
  for (const pn of pensionRows) {
    const meta = pensionMeta[pn.id];
    // No valid (or currently-included) source account — can never fire.
    if (!meta.sourceAccountId || superBal[meta.sourceAccountId] === undefined) {
      pensionCommenceMonth[pn.id] = null;
      continue;
    }
    const ownerPerson = meta.owner === "partner" ? state.plan.partner : state.plan.client;
    const gateAge = pensionMinCommenceAge(meta.type, ownerPerson?.retirementAge);
    let y = resolveRef(pn.commenceAt, state.plan, schedule, "client").planYear;
    while (y < schedule.planYears && ownerAgeAt(meta.owner, y) < gateAge) y++;
    pensionCommenceMonth[pn.id] = y < schedule.planYears ? julyOf(y) : null; // null = never fires within the projection (convention 5's partial-first-year skip, or the gate never met)
  }

  // Defined benefit pensions (spec 26, Commit 2) — same "fires in July
  // of its resolved plan year, or never" convention as an ABP/TTR
  // pension's own pensionCommenceMonth just above, but with NO
  // condition-of-release gate to loop forward past — a DB pension has
  // no such gate: the client's own statement already reflects when it
  // starts.
  const dbCommenceMonth = {};
  for (const db of dbRows) {
    const y = resolveRef(db.commenceAt, state.plan, schedule, "client").planYear;
    dbCommenceMonth[db.id] = y < schedule.planYears ? julyOf(y) : null;
  }
  // Transfer balance account credit guard (spec 26, Commit 2) — same
  // one-off shape as pensionTbaCredited above.
  const dbTbaCredited = {};
  for (const db of dbRows) dbTbaCredited[db.id] = false;

  // This FY's indexed annual amount for a defined benefit pension — a
  // pure formula (fyStart/y only), shared by runYear's own monthly
  // credit (real dollars/12 per month) and the age-pension income-test
  // setup below (spec 26, Commit 3), which both need the IDENTICAL
  // figure and must never independently re-derive it (a formula
  // duplicated in two places is a formula that can silently drift).
  function dbAnnualAmountFor(db, y) {
    const dm = dbMeta[db.id];
    const basisRate = dm.indexBasis === "awote" ? awoteAssum : dm.indexBasis === "cpi" ? cpi : 0;
    const g = basisRate + (dm.indexExtraPct ?? 0) / 100;
    return dm.annualPension * Math.pow((1 + g) / (1 + cpi), yearStartIdx(y) / 12);
  }

  // Commutation events (spec 20, Commit 5) — resolved once per
  // commutation row, same "fires in July of its resolved plan year, or
  // never" convention as commencement just above. A pension can carry
  // several; each resolves independently.
  const pensionCommutationEvents = {};
  for (const pn of pensionRows) {
    pensionCommutationEvents[pn.id] = (pn.commutations ?? []).map((c) => {
      const y = resolveRef(c.at, state.plan, schedule, "client").planYear;
      return { id: c.id, month: julyOf(y), amount: c.amount, destination: c.destination };
    }).filter((e) => e.month != null);
  }

  // Superannuation rollovers (spec 26, Commit 1) — resolved once per
  // row, same "fires in July of its resolved plan year, or never"
  // convention as a pension commutation just above. Processed in the
  // monthly loop below, real-pass only (superBal/superTaxFree have no
  // measurement-pass concept at all, the same reason every other super
  // mutation in this engine is real-pass-gated).
  const superRolloverEvents = (state.cashflows.superRollovers ?? []).map((sr) => {
    const y = resolveRef(sr.at, state.plan, schedule, "client").planYear;
    return { id: sr.id, month: julyOf(y), fromAccountId: sr.fromAccountId, toAccountId: sr.toAccountId, amount: sr.amount };
  }).filter((e) => e.month != null && e.fromAccountId && e.toAccountId && superIds.includes(e.fromAccountId) && superIds.includes(e.toAccountId));

  // Deeming grandfathering (spec 21b, Commit 3) — grandfathering is
  // lost PERMANENTLY the moment a grandfathered pension is first
  // commuted (partial or full), so its loss is the earliest commutation
  // event's own month — resolved once, up front, alongside the events
  // themselves, since it depends only on the commutation rows' fixed
  // dates, never on anything path-dependent. Real rules also end
  // grandfathering when the member ceases income support entirely;
  // that trigger isn't modelled (disclosed — this engine has no such
  // event to hang it on).
  const pensionGrandfatheredLostAt = {};
  for (const pn of pensionRows) {
    const events = pensionCommutationEvents[pn.id];
    pensionGrandfatheredLostAt[pn.id] = events.length ? Math.min(...events.map((e) => e.month)) : null;
  }

  // Gifting and deprivation (spec 21b, Commit 2) — each gift resolves
  // to its own firing month, same "fires in July of its resolved plan
  // year, or never" convention. Deprivation itself (the $10,000/yr,
  // $30,000/five-year rolling limits) is resolved ONCE, up front, since
  // it depends only on the gifts' own fixed dates/amounts — not on
  // anything path-dependent — chronologically across ALL gifts
  // regardless of input order (src/gifting.js's own header).
  const giftEvents = (state.plan.gifts ?? []).map((g) => {
    const y = resolveRef(g.at, state.plan, schedule, "client").planYear;
    const month = julyOf(y);
    return month == null ? null : { id: g.id, month, amount: g.amount, planYear: y };
  }).filter(Boolean);
  const resolvedGifts = resolveGiftDeprivation(giftEvents);
  const giftsByMonth = {};
  for (const g of resolvedGifts) (giftsByMonth[g.month] ??= []).push(g);

  // Main residence exemption (spec 19 Commit 5) — resolves a
  // mainResidence object's DateRef-anchored events to literal ISO
  // calendar dates (1 July of each event's resolved plan year, the
  // SAME "annual one-off fires in July" convention every age-anchored
  // event in this engine already uses) so mainResidence.js's pure
  // exemptProportion() can do its day-count arithmetic on real dates,
  // exactly like Property.acquisitionDate already is.
  const julyIsoOf = (planYear) => `${fy0 + planYear}-07-01`;
  const resolveMainResidenceDates = (mr) => {
    if (!mr?.movedOutAt) return null;
    const movedOutAt = julyIsoOf(resolveRef(mr.movedOutAt, state.plan, schedule, "client").planYear);
    const movedBackInAt = mr.movedBackInAt
      ? julyIsoOf(resolveRef(mr.movedBackInAt, state.plan, schedule, "client").planYear)
      : null;
    return { movedOutAt, producingIncome: mr.producingIncome === true, movedBackInAt };
  };
  const propMeta = {};
  const propVal = {};    // real value; 0 until purchased
  const derivedLoans = []; // purchase loans, activated at settlement
  for (const p of props) {
    const owned = p.status === "owned";
    let purchaseMonth = null;
    let effectiveAcquisitionDate = p.acquisitionDate;
    if (!owned) {
      // Key Dates: resolved once here (not per month) — an anchor or
      // an explicit age both clamp into the projection window, so this
      // never needs a separate bounds check.
      const y = resolveRef(p.purchaseAt, state.plan, schedule, "client").planYear;
      purchaseMonth = julyOf(y); // null = never fires (convention 5's partial-year skip)
      // Main residence exemption (spec 19 Commit 5) — a still-to-be-
      // purchased property has no acquisitionDate yet; its own eventual
      // purchase date stands in, so a purchased-then-vacated-then-sold
      // PPR within the SAME projection still gets a real ownership
      // period rather than silently defaulting to "fully exempt".
      effectiveAcquisitionDate = julyIsoOf(y);
    }
    // Property sale (spec 19 Commit 4) — same "fires in July of its
    // resolved plan year" resolution as purchaseMonth above. A sale
    // dated before the property is even purchased (a still-planned
    // property) can never fire — null, same as any other one-off whose
    // trigger never arrives (convention 5's own partial-year skip is
    // the same shape: a date that structurally can't occur this
    // projection is silently inert, not an error).
    let saleMonth = null;
    if (p.sale?.enabled) {
      const saleY = resolveRef(p.sale.at, state.plan, schedule, "client").planYear;
      const sm = julyOf(saleY);
      if (sm != null && (owned || (purchaseMonth != null && sm > purchaseMonth))) saleMonth = sm;
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
      saleMonth,
      sale: p.sale,
      invest,
      // PPR is exempt UNLESS it has an absence event (spec 19 Commit 5 —
      // main residence exemption / six-year rule): a "ppr" property the
      // owner moved out of still needs its cost-base pool tracked, just
      // like an investment property, so its gain (at eventual sale) can
      // be assessed at a REDUCED (not necessarily zero) exempt
      // proportion — see mainResidence.js and the sale block below.
      isCgt: p.propertyType !== "ppr" || p.mainResidence?.movedOutAt != null,
      mainResidence: p.mainResidence,
      acquisitionDate: effectiveAcquisitionDate,
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
  // Input behaviour fix — a liability the user linked to a property via
  // "Relates to / secured by" is dischargeable by that property's sale
  // too, not only the auto-generated purchase loan (`prop-<id>`, the
  // ONLY loan this engine could previously identify as "this
  // property's own" — see the sale-discharge block's own header). An
  // already-owned property's manually-entered mortgage had no way to
  // be recognised at all before this.
  const linkedLoanIdByProperty = {};
  for (const l of liabs) {
    if (l.linkedAssetId && propMeta[l.linkedAssetId]) linkedLoanIdByProperty[l.linkedAssetId] = l.id;
  }
  const liabMeta = {};
  const loanBal = {}; // nominal
  // Drawdowns and dynamic deductibility (spec 24, Commit 1) — investBal/
  // privateBal (nominal, like loanBal) track a mixed loan's own two
  // purpose buckets; ALWAYS sum to loanBal[l.id]. Only populated for a
  // liability that actually uses them (a drawdown, or repaymentAllocation
  // "privateFirst" — the only two things that can move the deductible
  // proportion away from its opening value; see currentDeductibleFraction's
  // own header) — every OTHER liability keeps reading the static
  // liabMeta[l.id].deductibleFraction exactly as before Commit 1, which
  // is what makes "liabilities without drawdowns bit-identical" a real
  // guarantee rather than a hopeful floating-point coincidence.
  const investBal = {};
  const privateBal = {};
  // Credit-limit binding and an aggressive privateFirst-on-a-single-loan
  // assumption are both flagged, never silently allowed or refused —
  // the spec's own words for the latter.
  const drawdownWarnings = [];
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
    const openingDeductibleFraction = deductibleFraction(l);
    // Drawdowns and dynamic deductibility (spec 24, Commit 1) — buckets
    // only matter (diverge from the static opening fraction) when a
    // drawdown can move them, or repaymentAllocation is "privateFirst"
    // (the only other thing that can shift the split, on a part-
    // deductible loan, with no drawdown at all). Every other liability
    // — the entire pre-Commit-1 universe — never allocates these,
    // guaranteeing the regression gate exactly, not approximately.
    // Debt recycling (spec 24, Commit 2) — a recycling plan is the
    // THIRD thing (alongside a drawdown and privateFirst) that can move
    // the deductible proportion away from its opening value, so it ALSO
    // engages dynamic tracking. Bounds resolved once here, same as
    // fixedUntil/rolloverYear above.
    const recycling = l.recycling?.enabled ? {
      fromYear: resolveRef(l.recycling.from, state.plan, schedule, "client").planYear,
      toYear: resolveRef(l.recycling.to, state.plan, schedule, "client").planYear,
      destinationAssetId: l.recycling.destinationAssetId,
      matchRepayments: l.recycling.matchRepayments !== false,
      annualCap: l.recycling.annualCap ?? null,
    } : null;
    const usesDynamicDeductibility = (l.drawdowns?.length ?? 0) > 0 || l.repaymentAllocation === "privateFirst" || !!recycling;
    liabMeta[l.id] = {
      i,
      termM,
      ioM,
      startMonth: l.startMonth ?? 0, // purchase loans (D4) start at settlement
      pmtPI: levelPayment(l.balance, i, termM - ioM),
      offsetId,
      deductibleFraction: openingDeductibleFraction,
      usesDynamicDeductibility,
      repaymentAllocation: l.repaymentAllocation === "privateFirst" ? "privateFirst" : "proportional",
      creditLimit: l.creditLimit ?? null,
      recycling,
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
    if (usesDynamicDeductibility) {
      investBal[l.id] = loanBal[l.id] * openingDeductibleFraction;
      privateBal[l.id] = loanBal[l.id] * (1 - openingDeductibleFraction);
      // "privateFirst" on a SINGLE loan (no distinct split-facility
      // second loan) is the legally aggressive reading — permitted,
      // flagged, never silently allowed or refused (the spec's own words).
      if (l.repaymentAllocation === "privateFirst") {
        drawdownWarnings.push({
          liabilityId: l.id, type: "privateFirstAggressive",
          reason: `${l.name ?? "This loan"}: directing repayments at the private portion of a single mixed loan is an aggressive assumption the ATO would not accept — model a genuine split facility as a second loan instead if this needs to withstand scrutiny`,
        });
      }
    }
    liabSeries[l.id] = new Float64Array(months + 1);
    liabSeries[l.id][0] = loanBal[l.id]; // real == nominal at month 0
    if (offsetId) (offsetLoansByAsset[offsetId] ??= []).push(l.id);
  }
  // Dynamic deductibility (spec 24, Commit 1) — the fraction to use for
  // THIS month's interest deduction: the static opening value for every
  // liability that never diverges from it (guaranteeing bit-identical
  // output there), or the LIVE investBal/privateBal ratio for one that
  // can. Guards 0/0 (a fully drawn-down-to-zero loan) at 0, matching
  // deductibleFraction's own "nothing left to deduct" reading.
  const currentDeductibleFraction = (id) => {
    const md = liabMeta[id];
    if (!md.usesDynamicDeductibility) return md.deductibleFraction;
    const total = investBal[id] + privateBal[id];
    // Clamped defensively into [0, 1] — every mutation site is written
    // to keep the ratio there by construction, but this is the ONE
    // read every downstream consumer (interest deduction, the "pay
    // non-deductible debt first" ranking) shares, so a bound here
    // protects the whole engine from ever amplifying a stray desync
    // into an out-of-range deduction or an overpayment beyond the
    // loan's own balance.
    return total > 0 ? Math.max(0, Math.min(1, investBal[id] / total)) : 0;
  };
  // Every mechanism that reduces a liability's balance via an ACTUAL
  // REPAYMENT (as opposed to a drawdown, which only ever increases it)
  // must keep investBal/privateBal in lockstep with loanBal, or the two
  // would silently drift apart and the deductible fraction would
  // corrupt from that point on. Shared by the ordinary contractual/
  // extra-repayment reduction inline in the liability loop below, a
  // bonus redirected to this loan, and a property sale's proceeds
  // discharging it — one split calculation, not independent copies.
  // `nominalAmount` is nominal, same units as loanBal itself. A no-op
  // for a liability that never uses dynamic deductibility.
  const reduceBucketsForRepayment = (id, nominalAmount) => {
    const md = liabMeta[id];
    if (!md?.usesDynamicDeductibility || nominalAmount <= 0) return;
    if (md.repaymentAllocation === "privateFirst") {
      const fromPrivate = Math.min(privateBal[id], nominalAmount);
      privateBal[id] -= fromPrivate;
      investBal[id] -= (nominalAmount - fromPrivate);
    } else {
      const total = investBal[id] + privateBal[id];
      const investShare = total > 0 ? investBal[id] / total : 0;
      investBal[id] -= nominalAmount * investShare;
      privateBal[id] -= nominalAmount * (1 - investShare);
    }
    investBal[id] = Math.max(0, investBal[id]);
    privateBal[id] = Math.max(0, privateBal[id]);
  };
  const reduceLoanBalanceForRepayment = (id, nominalAmount) => {
    loanBal[id] = Math.max(0, loanBal[id] - nominalAmount);
    reduceBucketsForRepayment(id, nominalAmount);
  };

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
  // already exclude them). Bonds (spec 25, Commit 2) ARE eligible —
  // "they are liquid" (the spec's own words) — subject to the SAME
  // funding order and minimum balances as an ordinary financial asset,
  // so a bond id may sit anywhere in the adviser's own chosen order.
  const fundingOrder = state.settings.fundingOrder.filter(
    (id) => (id in bal && !meta[id].lifestyle) || id in bondBal
  );
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
  // Investment/education bonds (spec 25, Commit 2) — the incremental
  // tax cost of this FY's pre-ten-year bond withdrawal(s), assessed in
  // FY t (using the REAL pass's own actual withdrawal amount — see the
  // a2 block for why), payable July t+1, exactly the same shape and
  // reason as pendingCgt above.
  let pendingBondTax = { client: 0, partner: 0 };
  // Untaxed superannuation elements (spec 26, Commit 1) — same shape and
  // reason as pendingBondTax above: a benefit from an untaxed-status
  // account (withdrawal OR rollover) is only ever mutated inside the
  // real pass (superBal/superTaxFree have no measurement-pass snapshot/
  // restore at all — see withdrawFromSuper's own callers), so its tax
  // consequence can never be known before the "a" assessPerson call
  // (which runs BEFORE the real pass, to produce the taxOut array the
  // real pass's own deficit funding depends on) — the same circular-
  // dependency reason CGT and bond withdrawals both get a one-year lag.
  let pendingUntaxedSuperTax = { client: 0, partner: 0 };
  // Lifetime, per-person cumulative untaxed-element amount already
  // assessed at the concessional 15%/10% rate (withdrawals AND
  // rollovers both consume the SAME cap — the spec's own singular "the
  // untaxed plan cap"). A running total, never reset, mutated only in
  // the real pass (the only pass that ever touches an untaxed benefit at
  // all) — the direct analogue of the transfer balance account's own
  // lifetime, never-decremented `balance` for cap-consumption purposes
  // (see pensionTba.js), but simpler: no high-water-mark/indexation
  // concept, since the untaxed plan cap is a flat lifetime ceiling, not
  // a personal cap that itself grows.
  const untaxedCapUsed = { client: 0, partner: 0 };
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
    // Adjustment rows (spec 18, Commit 1) — reporting only (Commit 2's
    // table marking reads this): every adjustment active this FY, with
    // its resolved real-dollar amount. Never touches money-flow
    // arithmetic itself — see the a-adjustments block for where the
    // SAME amount actually feeds income/deductions/expenses/super/tax.
    adjustments: [],
    // Redundancy and ETP (spec 19 Commit 3) — reporting only, one entry
    // per termination event that fired this FY.
    termination: [],
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
        // Drawdowns and dynamic deductibility (spec 24, Commit 1) — a
        // year-end snapshot (not a sum), same convention as closing/
        // offsetApplied; both 0 unless the liability actually uses
        // dynamic deductibility (see currentDeductibleFraction's own
        // header) — a plain deductiblePct loan never populates these,
        // same as it never used investBal/privateBal at all.
        investmentBalance: 0, privateBalance: 0,
      }]),
      ...helpLiabPersons.map((p) => [`help_${p}`, {
        opening: 0, interest: 0, principal: 0, drawdown: 0, offsetApplied: 0, closing: 0, extraRepayment: 0, surplusRepayment: 0, indexation: 0, ratePct: 0,
        // Drawdowns and dynamic deductibility (spec 24, Commit 1) — a
        // year-end snapshot (not a sum), same convention as closing/
        // offsetApplied; both 0 unless the liability actually uses
        // dynamic deductibility (see currentDeductibleFraction's own
        // header) — a plain deductiblePct loan never populates these,
        // same as it never used investBal/privateBal at all.
        investmentBalance: 0, privateBalance: 0,
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
    // surplusContribution (Surplus and Deficit Allocation spec, Commit
    // 3): the slice of `contribution` above that arrived via a surplus
    // allocation this FY, rather than the goal's own ordinary
    // fundedFrom draw — a reporting-only breakdown (both paths already
    // debit the SAME pocket, so no conservation double-count risk;
    // unlike surplusSalarySacrifice, this needs no invariant add-back)
    // that lets the Cashflow table's Funding group and the Focus →
    // Surplus allocation view show "how much of this goal's funding
    // this year came from surplus" without re-deriving it.
    goals: Object.fromEntries(goals.map((g) => [g.id, { contribution: 0, surplusContribution: 0 }])),
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
      deposit: 0, duty: 0, costs: 0, fhog: 0, landTax: 0,
      // Property sale (spec 19 Commit 4) — zero except in the sale's
      // own FY. saleProceeds is net of agent fees/settlement costs;
      // saleGain is the taxable capital gain (0 for a PPR, always
      // exempt) already folded into row.tax via the usual FY-end
      // assessment, reported here only for disclosure.
      saleProceeds: 0, saleGain: 0, saleValue: 0,
      // Usable equity and borrowing capacity (Implementation/Rates
      // spec, Commit 3) — filled in by a post-pass once `yearly` is
      // complete (needs the property's own linked liabilities' closing
      // balances, which are only final at year-end).
      usableEquity: 0,
    }])),
    // Property sale (spec 19 Commit 4) — household total, net of
    // costs, across every property sold this FY (usually one).
    propertySaleProceeds: 0,
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
      // Government co-contribution + LISTO (spec 19 Commit 6) — a
      // genuine inflow from the government, no household cash movement
      // (a named conservation term — see conservationCheck.js).
      govSuperInflow: 0,
      // Net concessional contributions actually credited THIS FY (gross
      // less contributions tax, from every concessional source — the
      // ordinary monthly flow, a toConcessionalCap fill, and an
      // adjustment-row super contribution all feed it). Tracked
      // separately from `contributions` (which also mixes in accepted
      // non-concessional) purely so NEXT year's contribution-splitting
      // election (below) has a single, correct "prior FY concessional"
      // figure to split a % of, instead of re-deriving it imprecisely
      // from contributions − contributionsTax (which would double as an
      // implicit NCC estimate whenever a fill or adjustment landed).
      concessionalNet: 0,
      // Contribution splitting (spec 19 Commit 6 completion) — moves a
      // % of the PRIOR FY's concessionalNet to the owner's spouse's
      // account, applied at the top of THIS FY (see the top-of-year-
      // loop block). A same-total transfer between two pockets already
      // both inside `superClosing` — no conservation term needed (see
      // conservationCheck.js's header for the same reasoning already
      // applied to land tax/redundancy/the PPR exemption).
      contributionSplitOut: 0, contributionSplitIn: 0,
      // Insurance premiums inside super (spec 19 Commit 7) — a direct
      // balance reduction, deliberately separate from `withdrawals`
      // (not a benefit payment — see the debit site's own comment).
      insurancePremium: 0,
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
      // The same reporting-only breakdown as surplusSalarySacrifice,
      // but for a personalDeductible-type target — no invariant
      // add-back needed here (an ORDINARY personalDeductible
      // contribution already passes through wcaBal exactly like this
      // surplus-sourced one does, unlike salary sacrifice's payroll
      // bypass), so this exists purely so the Cashflow table's Funding
      // group and the Focus → Surplus allocation view can show it.
      surplusPersonalDeductible: 0,
      // Untaxed superannuation elements (spec 26, Commit 1) — a
      // same-person rollover between two of the owner's own accounts.
      // rolloverOut/rolloverIn are the GROSS/NET amounts either side of
      // the transfer (see the monthly loop's own header for why they
      // can differ: an untaxed-status source pays 15%/47% tax on its
      // untaxed element at the point of rollover); rolloverTax is that
      // tax, a genuine leak (named in conservationCheck.js).
      rolloverOut: 0, rolloverIn: 0, rolloverTax: 0,
      closing: 0, taxFreeClosing: 0,
    }])),
    superClosing: 0,
    superCapUsage: { client: null, partner: null },
    // Per-bond detail (spec 25, Commit 1): opening + contributions +
    // earnings − internalTax = closing, per bond — the same opening/
    // closing reconciliation shape as perAssetDetail/superDetail above.
    // costBase: the running notional cost base (original investment
    // only) — NOT a CGT cost-base pool (bonds are not CGT assets, no
    // pool, no discount); just what the withdrawal-tax split (Commit 2)
    // needs to know how much of a withdrawal is capital vs earnings.
    // withdrawals (spec 25, Commit 2): the total withdrawn this FY via
    // deficit funding (the only withdrawal mechanism until Commit 3's
    // education withdrawals); assessableWithdrawal: the slice of that
    // which was earnings withdrawn from an UNMATURED bond — the real
    // cost the plan should show, not hide (the spec's own words).
    // yearsToMaturity/contributionHeadroom: read-only reporting for the
    // Bonds table, resolved once at year-end below.
    bondDetail: Object.fromEntries(bonds.map((b) => [b.id, {
      opening: 0, contributions: 0, earnings: 0, internalTax: 0, withdrawals: 0, assessableWithdrawal: 0,
      // Education withdrawals (spec 25, Commit 3) — a SEPARATE pair
      // from withdrawals/assessableWithdrawal above (an ordinary
      // deficit-funded sale): educationWithdrawal is what this bond
      // paid its OWN linked child's fees this FY; educationBenefit is
      // the provider's own recovered-tax top-up on top of it — see
      // bonds.js's bondEducationBenefit for the verified mechanic.
      educationWithdrawal: 0, educationBenefit: 0,
      closing: 0, costBase: 0, yearsToMaturity: null, contributionHeadroom: null,
    }])),
    bondsClosing: 0,
    // Per-pension detail (spec 20, Commits 1-2): opening/closing balance,
    // the commencement transfer (nonzero only in the pension's own
    // commencement FY), fund earnings/earnings-tax (the SAME 15%/10%
    // haircut shape as superDetail above — a Commit 1 placeholder,
    // Commit 3 zero-rates an ABP in retirement phase), and payments —
    // split tax-free/taxable at the FIXED commencement-time proportion
    // (see pensionFixedProportion in the engine setup above), never the
    // live ratio. Commutations/taxFreeClosing arrive in Commit 5, the
    // same incremental growth superDetail's own fields went through
    // across Tier 1.2's four commits. taxFreeProportion is null until
    // the pension's own commencement fires this run, then fixed for
    // every later year.
    pensionDetail: Object.fromEntries(pensionIds.map((id) => [id, {
      opening: 0, commencementAmount: 0, earnings: 0, earningsTax: 0,
      payments: 0, paymentsTaxFree: 0, paymentsTaxable: 0, commutations: 0,
      closing: 0, taxFreeClosing: 0, taxFreeProportion: null,
      // Deeming grandfathering (spec 21b, Commit 3) — both zero unless
      // this pension is grandfathered AND still is this FY.
      grandfatheredDeductibleIncome: 0, grandfatheredDeemingExempt: 0,
    }])),
    pensionClosing: 0,
    // Defined benefit pensions (spec 26, Commit 2) — no balance/opening/
    // closing at all (the spec's own point: no account exists to
    // assess). grossPension/taxFreeAmount/untaxedAssessable are set in
    // the real pass only (below); dbIncomeCapExcess/tax are set in the
    // per-FY tax-assessment block once the FY's totals are known
    // (Commit 3 extends this further for the Centrelink/table outputs).
    definedBenefitDetail: Object.fromEntries(dbRows.map((db) => [db.id, {
      grossPension: 0, taxFreeAmount: 0, untaxedAssessable: 0, dbIncomeCapExcess: 0, tax: 0,
    }])),
    // Transfer balance account (spec 20, Commit 4) — a snapshot of each
    // person's account at THIS FY's end: the running credited-minus-
    // debited balance, their own (proportionally-indexed) personal
    // cap, and remaining headroom (floored at 0 — a breach shows as 0
    // headroom, not negative; the excess itself is on superWarnings,
    // type "tbaExcess", the same disclosure-only shape every other
    // pension/super warning already uses).
    transferBalance: Object.fromEntries(persons.map((p) => [p, { balance: 0, personalCap: 0, remainingCap: 0 }])),
    // Focus Commit 3 (docs/specs/12-focus-views.md) follow-on: the
    // FHSSS running-balance snapshot (src/fhsss.js's fhsssBal) was
    // tracked internally but never exposed — a Focus view showing
    // "contributions by year, associated earnings" would otherwise have
    // to re-derive the whole accrual/cap-acceptance sequence itself.
    // null once a person has already released (nothing left to accrue —
    // mirrors fhsssBal.released's own early-exit).
    fhsssDetail: { client: null, partner: null },
    // Age pension (spec 21a) — set once per FY in the per-year setup
    // (before either pass, since it carries no tax consequence to get
    // right in two passes); this default only ever shows if that block
    // somehow didn't run.
    agePensionDetail: null,
    // CSHC (spec 21b, Commit 4) — set once per FY, after the tax
    // measurement pass (it needs the FY's adjusted taxable income);
    // this default only ever shows if that block somehow didn't run.
    cshcDetail: null,
    // HEAS (spec 21b, Commit 5) — set once per FY alongside
    // agePensionDetail; opening/closing are the running loan balance
    // (real $, a liability — see row.netAssets's own subtraction of
    // heasDetail.closing).
    heasDetail: { opening: 0, interest: 0, drawn: 0, mla: 0, securityValue: 0, closing: 0 },
    // Death benefits (spec 22, Commit 1) — a TERMINAL planning figure
    // only: set on the FINAL projection year's row alone (after the
    // year loop finishes), never per-year — "the tax outcome of the
    // super balance at the projection's end," the spec's own words, not
    // a year-by-year accrual. null on every other year, and null here
    // too whenever a person has no beneficiaries nominated.
    deathBenefitDetail: null,
    // Gifting (spec 21b, Commit 2) — the FY's total gift outflow (the
    // full amount, regardless of how much is deprived vs allowable —
    // see gifting.js's own header): a leak, set alongside agePensionDetail.
    giftsPaid: 0,
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
    agePensionMonthly = 0,
    heasMonthly = 0,
    bonusCredits = {},
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
      acc[p] = {
        ordinary: 0, franked: 0, unfranked: 0, deductions: 0, netCapitalGain: 0, incomeMonths: new Set(), fhsssTaxableRelease: 0,
        // Pension phase, Commit 2: the taxable component of a pre-60
        // TTR payment — assessable at marginal rates with a 15%
        // non-refundable offset (see assessPerson's own ttrPensionTaxable
        // param). Structurally always 0 in this build: EVERY reachable
        // commencement requires age >= 60 (pensionMinCommenceAge's own
        // gate — TTR floors at preservation age 60 same as ABP), so no
        // payment this engine can ever produce is pre-60. Wired anyway,
        // for genuine spec correctness and direct unit-testability —
        // see Tax/annual.test.js.
        ttrPensionTaxable: 0,
        // Investment/education bonds (spec 25, Commit 2) — a DEFICIT-
        // FUNDED bond withdrawal's assessable earnings. Kept OUT of the
        // "pre"/"a" assessPerson calls (assessed instead via the
        // separate, one-year-lagged pendingBondTax mechanism, using
        // real[p] — see the a2 block for why): a deficit-funded sale's
        // exact size is pass-dependent (the measurement pass simulates
        // zero tax cash outflow that month, so it can genuinely draw a
        // different amount than the real pass), so using measured[p]'s
        // own figure to size THIS FY's tax would silently mismatch what
        // was actually sold — the same reason CGT is assessed from
        // real[p].netCapitalGain, never measured[p].
        bondDeficitAssessableWithdrawal: 0,
        // Investment/education bonds (spec 25, Commit 3) — a PLANNED,
        // schedule-driven withdrawal linked to a child's own fee
        // schedule (an investment-type bond's own "beneficiaryChildId"
        // withdrawal — an education-type bond's own linked withdrawal
        // gets the benefit-and-no-tax treatment instead and never adds
        // here at all). UNLIKE the deficit-funded case above, this
        // amount is pass-INDEPENDENT (sized purely by the pre-resolved
        // fee schedule and the bond's own live balance, neither of
        // which depends on this month's tax/shortfall), so it's safe to
        // assess immediately, same-year, via measured[p] — the SAME
        // "add to income, credit back a flat offset" shape as
        // fhsssTaxableRelease/ttrPensionTaxable. A MATURED bond's
        // withdrawal never adds here at all (bondWithdrawalTax only
        // computes a nonzero assessableEarnings when unmatured).
        bondAssessableWithdrawal: 0,
        // Untaxed superannuation elements (spec 26, Commit 1) — same
        // pass-dependence reason as bondDeficitAssessableWithdrawal
        // above (superBal/superTaxFree only ever mutate in the real
        // pass — see pendingUntaxedSuperTax's own header), so this is
        // ALWAYS assessed via the one-year lag, for both the explicit
        // scheduled withdrawal AND the deficit-funded case — unlike
        // bonds, super has no ungated, both-pass-executed growth block
        // to make a same-year assessment possible for either path.
        // Split in two: untaxedSuperWithinCap gets the 15% offset,
        // untaxedSuperExcess (over the lifetime untaxed plan cap) is
        // taxed flat at 47% instead — see assessPerson's own params.
        untaxedSuperWithinCap: 0,
        untaxedSuperExcess: 0,
        // Defined benefit pensions (spec 26, Commit 2) — pass-INDEPENDENT
        // (a pure per-FY formula, never shortfall-dependent), so unlike
        // every other super/pension mechanism above these accumulate
        // identically in both passes and are read directly from
        // measured[p] for the SAME-year "pre"/"a" assessment — no lag.
        // dbGrossPension is the running total this FY (both components
        // combined) — needed to size the income-cap excess, which is
        // assessed OUTSIDE this per-month accumulation (see the a2-
        // adjacent block: it depends on the FY total, not a monthly
        // slice).
        dbUntaxedAssessable: 0,
        dbGrossPension: 0,
      };
    }
    // Per-property net-rental tracking for the gearing rules (D4).
    acc._propNet = Object.fromEntries(props.map((p) => [p.id, {
      rent: 0, expenses: 0, interest: { client: 0, partner: 0 },
    }]));
    const markIncome = (sharesObj, m) => {
      for (const p of persons) if (sharesObj[p]) acc[p].incomeMonths.add(m);
    };
    // Untaxed superannuation elements (spec 26, Commit 1) — splits a
    // just-crystallised untaxed-element amount into the within-cap
    // (15%/10%-offset-eligible) and excess (flat 47%) portions against
    // the OWNER's lifetime untaxedCapUsed running total, and advances
    // that total. Shared by the explicit withdrawal, deficit-funded
    // withdrawal, and rollover sites below — one place computing the
    // cap boundary, so all three treat a client already near the cap
    // identically.
    const untaxedPlanCapY = superRatesFor(fyStart, bracketMode, cpi, awoteAssum).untaxedPlanCap;
    const creditUntaxedCap = (owner, amount) => {
      if (!(amount > 0)) return { withinCap: 0, excess: 0 };
      const remaining = Math.max(0, untaxedPlanCapY - untaxedCapUsed[owner]);
      const withinCap = Math.min(amount, remaining);
      const excess = amount - withinCap;
      untaxedCapUsed[owner] += amount;
      return { withinCap, excess };
    };
    // Wraps withdrawFromSuper (outer scope) with the untaxed-element tax
    // consequence: 100% of an untaxed account's TAXABLE component
    // (balance minus taxFreeComponent) is untaxed element — this engine
    // models taxedStatus as a whole-of-account attribute, not a per-
    // contribution one (the spec's own scoping principle) — computed
    // from the CURRENT ratio, same "recalculated at every payment"
    // convention withdrawFromSuper's own tax-free split already uses. A
    // no-op for a taxed account (untaxedFraction is 0). Used by BOTH the
    // explicit and deficit-funded withdrawal sites below.
    function withdrawFromSuperTaxed(id, want, owner) {
      const balance = superBal[id];
      const untaxedFraction = superMeta[id].taxedStatus === "untaxed" && balance > 0
        ? Math.max(0, balance - superTaxFree[id]) / balance : 0;
      const paid = withdrawFromSuper(id, want);
      if (paid > 0 && untaxedFraction > 0) {
        const { withinCap, excess } = creditUntaxedCap(owner, paid * untaxedFraction);
        acc[owner].untaxedSuperWithinCap += withinCap;
        acc[owner].untaxedSuperExcess += excess;
      }
      return paid;
    }
    // Defined benefit pensions (spec 26, Commit 2) — this FY's annual
    // amount, via the shared dbAnnualAmountFor formula (outer scope) —
    // resolved here, directly, rather than in an outer per-year setup
    // the way pensionAnnualAmount needs (that one depends on a LIVE 1
    // July balance; this one doesn't).
    const dbAnnualAmountThisYear = {};
    for (const db of dbRows) dbAnnualAmountThisYear[db.id] = dbAnnualAmountFor(db, y);
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

    // A sale of `want` real dollars from a bond — DEFICIT FUNDING only
    // (spec 25, Commit 2): proportional cost-base reduction (bonds.js's
    // bondWithdrawalTax — no CGT pool, no discount, unlike sell()
    // above), with the earnings component of an UNMATURED bond's
    // withdrawal assessable at the owner's marginal rate
    // (acc[p].bondDeficitAssessableWithdrawal — assessed with a
    // one-year lag via pendingBondTax, see the a2 block's own header
    // for why THIS specific case needs one and the schedule-driven
    // education-linked withdrawal below does not). A MATURED bond's
    // withdrawal is entirely tax-free — bondWithdrawalTax already
    // returns 0 assessable for one. Returns paid.
    const sellBond = (id, want, m) => {
      const balance = bondBal[id];
      const paid = Math.min(want, balance);
      if (paid <= 0) return 0;
      const matured = bondHasMatured(bondEffectiveStartMonth[id], m);
      const { assessableEarnings } = bondWithdrawalTax({
        withdrawalAmount: paid, balance, costBase: bondCostBase[id], matured,
      });
      const bm = bondMeta[id];
      for (const p of persons) {
        if (bm.shares[p]) acc[p].bondDeficitAssessableWithdrawal += assessableEarnings * bm.shares[p];
      }
      // markIncome, same as every other income source in this engine —
      // without it, a person whose ONLY assessable income this FY is an
      // unmatured bond withdrawal has an empty incomeMonths set, and
      // spreadTax (below, in the real pass) has no month to spread the
      // resulting tax across — a real leak, not a display quirk (found
      // via the conservation invariant).
      if (assessableEarnings > 0) markIncome(bm.shares, m);
      bondCostBase[id] -= bondCostBase[id] * (paid / balance);
      bondBal[id] -= paid;
      // Reported directly here (not by the caller) — the same "the
      // ACTUAL sell()/cash effect runs unconditionally, only the
      // reporting needs to avoid double-counting the measure pass"
      // split every other deficit-funding site in this file already
      // uses (see goalAccruedTotal's own header).
      if (row) row.bondDetail[id].assessableWithdrawal += assessableEarnings;
      return paid;
    };

    const first = yearStart(y);
    const last = yearEnd(y);
    for (let m = first; m < last; m++) {
      // Drawdowns (spec 24, Commit 1) — reset each month. The credited
      // amount flows through `inc` below (drawdownIncomeThisMonth),
      // exactly like HEAS's own drawdown ("a drawdown credits household
      // cash... folded into inc the same way the age pension's own
      // entitlement is" — see heasDrawn's header in conservationCheck.js):
      // the loan's own increase is already conservation-neutral via
      // liabilityRevaluation's "+drawdown" term, but that term only
      // explains the LIABILITY side — the CASH/ASSET side crediting
      // somewhere needs its own named channel, or it reads as money
      // created from nothing. An asset-destined drawdown flows through
      // `inc` too, then transfers OUT of the WCA into the asset
      // (drawdownAssetCredits) right after wcaBal += net below — a
      // received-then-invested shape, not a separate untracked credit.
      let drawdownIncomeThisMonth = 0;
      const drawdownAssetCredits = [];
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

      // a-bonds. Investment/education bonds (spec 25, Commit 2): growth
      // net of the internal tax haircut (only GAINS are taxed — see
      // bonds.js's own header) and the contribution credit run UNGATED,
      // exactly the same "mutate always, report only in the real pass"
      // shape as ordinary asset growth just above — once bonds are
      // eligible for deficit funding (below), the measurement pass must
      // see an accurate bondBal for any same-FY sale to compute the
      // correct assessable-withdrawal amount. bondBal/bondCostBase are
      // snapshotted/restored around the measurement pass for this
      // reason (see the Pass 1 setup); bondSeries is pure per-month
      // output and needs no restore, same as `series` itself.
      for (const b of bonds) {
        const bm = bondMeta[b.id];
        const shock = shockFor(b.id, m);
        const grossGrowth = bondBal[b.id] * (bm.grossRate + shock);
        const tax = grossGrowth > 0 ? grossGrowth * bm.effectiveRate : 0;
        bondBal[b.id] += grossGrowth - tax;
        if (row) {
          row.bondDetail[b.id].earnings += grossGrowth;
          row.bondDetail[b.id].internalTax += tax;
        }

        const bondFlows = schedule.bondFlows[b.id];
        const contrib = bondFlows ? bondFlows.contributions[m] : 0;
        if (contrib > 0) {
          bondBal[b.id] += contrib;
          bondCostBase[b.id] += contrib;
          if (row) {
            row.bondDetail[b.id].contributions += contrib;
            bondThisFyContribution[b.id] += contrib;
          }
        }
        // Linked withdrawals (spec 25, Commit 3) — a bond with a
        // beneficiary (beneficiaryChildId) funds THAT child's own
        // modelled school fees automatically, in the SAME month the
        // fee itself fires (schedule.childEducationFlows), rather than
        // the fee being met from cashflow. The FIELD applies to either
        // bond type (see planState.js's own header on why); the TAX
        // TREATMENT branches on it: an education bond gets the benefit-
        // and-no-personal-tax mechanism (bonds.js's own verification
        // note), a plain investment bond gets the ordinary assessable-
        // if-unmatured treatment via bondWithdrawalTax instead — this
        // is what lets Focus → Education funding (Commit 3) run its
        // investment-bond arm through the SAME real engine mechanism as
        // its education-bond arm, per the Focus governing principle.
        // Pass-independent by construction either way (sized purely by
        // the pre-resolved fee schedule and this bond's own live
        // balance, neither of which depends on this month's tax/
        // shortfall the way a deficit-funded sale does), so — unlike
        // sellBond's own deficit-funding path — this needs no
        // measurement/real split: both passes compute the identical
        // amount, safe to assess immediately via acc[p].
        const educationFlow = bondEducationFlow[b.id];
        const feeDue = educationFlow ? educationFlow[m] : 0;
        if (feeDue > 0 && bondBal[b.id] > 0) {
          const withdrawAmount = Math.min(feeDue, bondBal[b.id]);
          const priorBalance = bondBal[b.id];
          if (b.type === "education") {
            const { earningsWithdrawn } = bondWithdrawalSplit({
              withdrawalAmount: withdrawAmount, balance: priorBalance, costBase: bondCostBase[b.id],
            });
            const benefit = bondEducationBenefit(earningsWithdrawn);
            bondCostBase[b.id] -= bondCostBase[b.id] * (withdrawAmount / priorBalance);
            bondBal[b.id] -= withdrawAmount;
            // A transfer (bond down, WCA up by the withdrawal itself —
            // no conservation term needed) PLUS a genuine external
            // inflow (the benefit — the provider's own recovered tax,
            // no offsetting outflow anywhere, the same "sgInflow"
            // shape), credited directly rather than through `inc`
            // (folding the WITHDRAWAL portion into `inc` would double-
            // count the bond's own balance reduction — see
            // conservationCheck.js's own educationBenefit term for why
            // only the benefit gets one).
            wcaBal += withdrawAmount + benefit;
            if (row) {
              row.bondDetail[b.id].educationWithdrawal += withdrawAmount;
              row.bondDetail[b.id].educationBenefit += benefit;
            }
          } else {
            // Plain investment bond: the ordinary ten-year-rule
            // treatment, assessed immediately (acc[p].bondAssessableWithdrawal
            // — the schedule-driven, pass-independent case; see that
            // field's own header) rather than through the deficit-
            // funding lag mechanism, since this withdrawal isn't
            // deficit-driven at all.
            const matured = bondHasMatured(bondEffectiveStartMonth[b.id], m);
            const { assessableEarnings } = bondWithdrawalTax({
              withdrawalAmount: withdrawAmount, balance: priorBalance, costBase: bondCostBase[b.id], matured,
            });
            bondCostBase[b.id] -= bondCostBase[b.id] * (withdrawAmount / priorBalance);
            bondBal[b.id] -= withdrawAmount;
            for (const p of persons) {
              if (bm.shares[p]) acc[p].bondAssessableWithdrawal += assessableEarnings * bm.shares[p];
            }
            if (assessableEarnings > 0) markIncome(bm.shares, m);
            wcaBal += withdrawAmount; // a transfer only — no benefit, no separate term needed
            if (row) {
              row.bondDetail[b.id].withdrawals += withdrawAmount;
              row.bondDetail[b.id].assessableWithdrawal += assessableEarnings;
            }
          }
        }
        bondSeries[b.id][m + 1] = bondBal[b.id];

        // The 125% rule's own bookkeeping — real-pass only:
        // bondThisFyContribution/bondPriorFyContribution/
        // bondEffectiveStartMonth persist ACROSS years with no
        // snapshot/restore of their own, so they must be written
        // exactly once per FY, from the real pass alone (the
        // measurement pass never touches them at all, unlike bondBal/
        // bondCostBase above).
        if (row && m === last - 1) {
          // A bond's very first assessed FY has no real "prior year" to
          // compare against — the rule only constrains a top-up
          // relative to what was ACTUALLY contributed last time, so the
          // first year simply establishes the baseline rather than
          // being checked against a fabricated one (bondPriorFyContribution
          // starts at null, not 0, for exactly this reason — a genuine
          // zero-contribution year, by contrast, sets it to an actual
          // 0, which DOES then constrain the following year to nil, per
          // the spec's own "nil-contribution year" rule).
          const { breach } = bondPriorFyContribution[b.id] == null
            ? { breach: false }
            : bondContributionCapCheck(bondPriorFyContribution[b.id], bondThisFyContribution[b.id]);
          if (breach) {
            // Resets the WHOLE bond's ten-year clock to the start of
            // THIS FY — the spec's own "single most important warning",
            // flagged rather than silently applied.
            bondEffectiveStartMonth[b.id] = first;
            bondWarnings.push({
              bondId: b.id, type: "contributionCapBreach",
              reason: `${b.name}: this year's contribution exceeds 125% of last year's — the ten-year clock has reset to ${schedule.fyLabels[y]}`,
            });
          }
          bondPriorFyContribution[b.id] = bondThisFyContribution[b.id];
          bondThisFyContribution[b.id] = 0;
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

      // a-adjustments. Adjustment rows (spec 18, Commit 1) — resolved
      // once per FY by schedule.js into a real-dollar amount, fired
      // here in July like every other annual row. income.assessable/
      // deductions are UNGATED (must feed the tax measurement pass,
      // same reasoning as a-super-deduct/a-deductions above);
      // income.nonTaxable/expenses feed household cash only (below);
      // superContributions' balance credit stays row-gated, applied
      // alongside the toConcessionalCap fills below. tax.* targets are
      // applied by the caller, before either pass — see the per-year
      // setup's own comment.
      let adjIncomeCash = 0;
      let adjExpenseCash = 0;
      let adjSuperCashOut = 0;
      if (m === julyOf(y)) {
        for (const adj of schedule.adjustments ?? []) {
          if (y < adj.fromYear || y > adj.toYear) continue;
          const amt = adj.amountAtYear[y];
          if (amt === 0) continue;
          if (adj.target === "income.assessable") {
            adjIncomeCash += amt;
            // Owner is guaranteed valid by clampAdjustment in the
            // normal path; guarded here too so a raw/malformed fixture
            // (this codebase has plenty, see CLAUDE.md) can't crash the
            // engine — the cash still arrives, only the tax-base
            // attribution is skipped if there's nowhere to attribute it.
            if (acc[adj.owner]) { acc[adj.owner].ordinary += amt; acc[adj.owner].incomeMonths.add(m); }
          } else if (adj.target === "income.nonTaxable") {
            adjIncomeCash += amt;
          } else if (adj.target === "deductions") {
            if (acc[adj.owner]) acc[adj.owner].deductions += amt;
          } else if (adj.target === "expenses") {
            adjExpenseCash += amt;
          } else if (adj.target === "superContributions") {
            // Only debit cash if the target account still exists —
            // otherwise this would destroy money (cash leaves, nothing
            // is credited anywhere). See the row-gated credit below for
            // the matching guard on the other side of this transfer.
            if (superIds.includes(adj.superAccountId)) adjSuperCashOut += amt;
          }
          // Reporting only (Commit 2's table marking reads this) — the
          // resolved amount for every target, regardless of which of
          // the three mechanisms above actually applied it. Real pass
          // only: this never feeds tax/cash, so nothing to snapshot.
          if (row) {
            row.adjustments.push({
              id: adj.id, target: adj.target, owner: adj.owner, superAccountId: adj.superAccountId,
              label: adj.label, note: adj.note, amount: amt,
            });
          }
        }
      }

      // a-termination. Redundancy and ETP (spec 19 Commit 3) — resolved
      // once per FY by schedule.js (month + age), fired here in July
      // like every other age-anchored one-off event. UNGATED: the
      // unused-leave portion (assessable, disclosed as taxed like
      // ordinary income — no distinct concessional treatment modelled)
      // must feed the tax measurement pass, same reasoning as
      // a-adjustments above. The genuine-redundancy tax-free base and
      // the ETP taxable component are BOTH excluded from
      // acc[owner].ordinary entirely (not merely untaxed) — the
      // spec's own test that neither appears in assessable income,
      // HELP repayment income, or Division 293 income falls out for
      // free from that exclusion, since all three read acc[*].ordinary.
      // The ETP's own flat tax (concessional rate up to the relevant
      // cap, 45% above, plus Medicare — see etpRates.js) is added
      // directly to this exact month's tax outflow, not spread or
      // PAYG-estimated — it settles in full the month it's incurred.
      let terminationCashOut = 0;
      if (m === julyOf(y)) {
        for (const ev of schedule.terminationEvents ?? []) {
          if (ev.month !== m) continue;
          if (!acc[ev.owner]) continue; // defensive — see a-adjustments' own guard
          const rates = etpRatesFor(fyStart, bracketMode, cpi, awoteAssum);
          const genuineRedundancy = ev.type === "genuineRedundancy";
          const taxFreeAmount = genuineRedundancy ? redundancyTaxFreeAmount(rates, ev.completedYearsOfService) : 0;
          // "Other taxable income this FY" for the whole-of-income cap
          // (resignation/retirement only — a genuine redundancy is an
          // EXCLUDED ETP, so the cap never applies to it) approximates
          // using whatever this person has already accrued THIS FY
          // before this event fires — disclosed simplification: since
          // termination fires in July (this FY's first month, the same
          // "annual one-off" convention every other age-anchored event
          // uses), that is usually $0, likely understating other income
          // for a same-July termination. A real multi-month-precision
          // model would need a finer DateRef grain than this engine's
          // age-year resolution supports anywhere else either.
          const { tax: etpTaxAmount } = etpTax(rates, ev.etpTaxableComponent, ev.age ?? 65, {
            genuineRedundancy, otherTaxableIncomeThisFY: acc[ev.owner].ordinary,
          });
          terminationCashOut += taxFreeAmount + ev.etpTaxableComponent + ev.unusedLeave - etpTaxAmount;
          // Pass-gated like every other direct tax-outflow write here
          // (spreadTax's own taxOutArr) — the measurement pass runs
          // with taxOut:null (see its own call site's comment) and only
          // needs the ordinary-income/cash effects above, not the
          // actual ledger write; writing once, in the real pass, avoids
          // double-counting across the two runYear calls per year.
          if (taxOut) taxOut[m] += etpTaxAmount;
          if (ev.unusedLeave > 0) {
            acc[ev.owner].ordinary += ev.unusedLeave;
            acc[ev.owner].incomeMonths.add(m);
          }
          if (row) {
            row.termination.push({
              rowId: ev.rowId, owner: ev.owner, type: ev.type,
              taxFreeAmount, etpTaxableComponent: ev.etpTaxableComponent, unusedLeave: ev.unusedLeave,
              etpTax: etpTaxAmount,
            });
          }
        }
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
        // Insurance premiums inside super (spec 19 Commit 7) — resolved
        // once per FY by schedule.js (July, indexed CPI+3% default),
        // debited here the SAME way as the release/adviser-fee blocks
        // just above: a direct balance reduction via the SAME
        // proportioning withdrawFromSuper uses, reported on its own
        // field — NOT `withdrawals` (no preservation gate, no
        // assessable income, not a benefit payment, per the spec's own
        // words). Fund-level tax deductibility for TPD/income-
        // protection premiums (which would reduce the fund's own
        // earnings tax) is NOT modelled — disclosed, the same "ICR
        // nets into the return rate with no separate fund-tax detail"
        // simplification this engine already uses elsewhere.
        if (m === julyOf(y)) {
          for (const id of superIds) {
            const premiumAtYear = schedule.superInsurancePremiums?.[id]?.[y] ?? 0;
            if (premiumAtYear <= 0) continue;
            const paid = withdrawFromSuper(id, premiumAtYear);
            row.superDetail[id].insurancePremium += paid;
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

        // Pension phase (spec 20, Commit 3) — "the reason pension phase
        // exists": an ABP (always in retirement phase, from
        // commencement) or a CONVERTED TTR grows completely untaxed
        // (grossRate reused as the net rate — no wedge); a not-yet-
        // converted TTR still grows taxed exactly like accumulation
        // (taxedRate) — see pensionMeta's own header for the two
        // conversion triggers. Zero balance before commencement, so
        // this is a no-op until the transfer below fires, the same
        // shape as a not-yet-purchased property's own growth-of-zero.
        for (const id of pensionIds) {
          const pm = pensionMeta[id];
          const inRetirementPhase = pm.type === "abp" || ownerAgeAt(pm.owner, y) >= pm.retirementPhaseFromAge;
          // Transfer balance account (spec 20, Commit 4) — a TTR
          // credits ONLY here, the FIRST month it's actually in
          // retirement phase (never at its own commencement — see the
          // commencement block's own comment), at its THEN-CURRENT
          // value — the balance going INTO this exact month, before
          // this same month's own growth compounds. pensionCommenced
          // guards against a not-yet-commenced pension (balance still
          // 0) firing this early, purely from the owner's age already
          // meeting the gate before the pension itself exists yet.
          if (pm.type === "ttr" && inRetirementPhase && pensionCommenced[id] && !pensionTbaCredited[id]) {
            const { tba: newTba, excess, excessTaxRate } = creditTransferBalance(tba[pm.owner], pensionBal[id]);
            tba[pm.owner] = newTba;
            pensionTbaCredited[id] = true;
            if (excess != null) {
              superWarnings.push({
                fyLabel: schedule.fyLabels[y], owner: pm.owner, type: "tbaExcess",
                reason: `Transfer balance cap exceeded by $${Math.round(excess)} — the ${Math.round(excessTaxRate * 100)}% notional earnings tax would apply (disclosure only; the commutation-authority process is not modelled)`,
              });
            }
          }
          const netRate = inRetirementPhase ? pm.grossRate : pm.taxedRate;
          const shock = shockFor(id, m);
          const grossGrowth = pensionBal[id] * (pm.grossRate + shock);
          const netGrowth = pensionBal[id] * (netRate + shock);
          pensionBal[id] += netGrowth;
          row.pensionDetail[id].earnings += grossGrowth;
          row.pensionDetail[id].earningsTax += grossGrowth - netGrowth;
        }
        // Commencement — a one-off transfer FROM an existing super
        // account INTO the (freshly-grown, still-zero) pension account
        // above, fired at most once per pension, at its resolved month
        // (pensionCommenceMonth, computed once above — see its own
        // header for the condition-of-release gating). A TRANSFER, not
        // new money: both pockets are already inside netAssets (via
        // superClosing/pensionClosing), so this needs no conservation
        // term of its own — see conservationCheck.js's own reasoning
        // for why a same-total move between two already-counted pockets
        // is invisible to the invariant by construction. Components
        // transfer PROPORTIONALLY from the source (spec's own words);
        // the resulting ratio is fixed here, once, for the pension's
        // entire remaining life — the proportioning rule, and the
        // single most important mechanical difference from accumulation
        // (which recalculates the ratio on every payment instead).
        for (const pn of pensionRows) {
          if (pensionCommenced[pn.id] || pensionCommenceMonth[pn.id] !== m) continue;
          pensionCommenced[pn.id] = true;
          const pm = pensionMeta[pn.id];
          const sourceBal = superBal[pm.sourceAccountId];
          // Capped via reserveFromSuper (resolved once per FY, before
          // the monthly loop even starts — see that block's own header)
          // against whatever adviser fees/Division 293/296/FHSSS
          // already claimed on the SAME account this SAME year, THEN
          // defensively re-capped against whatever's actually still
          // there right now (belt and braces — nothing else should have
          // touched this account between reservation and here, but
          // matching withdrawFromSuper's own Math.min discipline costs
          // nothing).
          const amount = Math.min(pensionCommenceReserved[pn.id] ?? 0, Math.max(0, sourceBal));
          if (amount <= 0) continue; // nothing to commence with — leaves the pension permanently at 0, same as a purchase event with no funds
          const taxFreeFraction = sourceBal > 0 ? superTaxFree[pm.sourceAccountId] / sourceBal : 0;
          const taxFreeAmount = amount * taxFreeFraction;
          superBal[pm.sourceAccountId] -= amount;
          superTaxFree[pm.sourceAccountId] -= taxFreeAmount;
          pensionBal[pn.id] += amount;
          pensionTaxFree[pn.id] += taxFreeAmount;
          pensionFixedProportion[pn.id] = taxFreeFraction; // fixed for life — see the block header above
          row.pensionDetail[pn.id].commencementAmount += amount;
          row.pensionDetail[pn.id].taxFreeProportion = taxFreeFraction;
          // Drawdown (spec 20, Commit 2): this FY's minimum/payment,
          // resolved NOW — the commencement amount IS the 1 July basis
          // (commencement can only ever land on 1 July — see
          // minDrawdownAmount's own header), unreachable from the
          // per-year setup above since it ran before this transfer
          // existed. Every LATER year resolves there instead.
          resolvePensionThisYear(pn, pensionBal[pn.id], ownerAgeAt(pm.owner, y), y);
          // Transfer balance account (spec 20, Commit 4) — an ABP is in
          // retirement phase from the moment it commences (Commit 3),
          // so it credits the OWNER's account right here, at its
          // commencement value. A TTR does NOT credit here — it credits
          // separately, at CONVERSION, at its then-current value (see
          // the growth step below) — this is "the entire point of the
          // TTR-versus-ABP question" the spec's own Commit 3 header
          // names, extended to the cap too.
          if (pn.type === "abp") {
            const { tba: newTba, excess, excessTaxRate } = creditTransferBalance(tba[pm.owner], amount);
            tba[pm.owner] = newTba;
            pensionTbaCredited[pn.id] = true;
            if (excess != null) {
              superWarnings.push({
                fyLabel: schedule.fyLabels[y], owner: pm.owner, type: "tbaExcess",
                reason: `Transfer balance cap exceeded by $${Math.round(excess)} — the ${Math.round(excessTaxRate * 100)}% notional earnings tax would apply (disclosure only; the commutation-authority process is not modelled)`,
              });
            }
          }
        }

        // Defined benefit pensions (spec 26, Commit 2) — "the factor of
        // ten": the transfer balance account credits at the pension's
        // OWN special value, annual pension × 16, NOT the pension
        // amount itself — the canonical trap this spec exists to avoid
        // ("getting this wrong... understates cap usage sixteenfold").
        // Fires once, at commencement, real-pass only (matching the
        // ABP/TTR commencement block just above) — no balance transfer
        // occurs (there is no source account), only the TBA credit.
        for (const db of dbRows) {
          if (dbTbaCredited[db.id] || dbCommenceMonth[db.id] !== m) continue;
          dbTbaCredited[db.id] = true;
          const dm = dbMeta[db.id];
          const specialValue = dbAnnualAmountThisYear[db.id] * 16;
          const { tba: newTba, excess, excessTaxRate } = creditTransferBalance(tba[dm.owner], specialValue);
          tba[dm.owner] = newTba;
          if (excess != null) {
            superWarnings.push({
              fyLabel: schedule.fyLabels[y], owner: dm.owner, type: "tbaExcess",
              reason: `Transfer balance cap exceeded by $${Math.round(excess)} — the ${Math.round(excessTaxRate * 100)}% notional earnings tax would apply (disclosure only; the commutation-authority process is not modelled)`,
            });
          }
        }

        for (const id of superIds) {
          const flows = schedule.superFlows[id];
          if (!flows) continue;
          const outcome = superOutcome[superMeta[id].owner];
          const ccGross = flows.sg[m] + flows.salarySacrifice[m] + flows.personalDeductible[m];
          const nccGross = flows.nonConcessional[m];
          // Untaxed elements (spec 26, Commit 1): concessional
          // contributions to an untaxed-status account still count
          // against the concessional cap (superOutcome's own
          // contributionsTaxRate/nccAcceptRatio resolution is unaffected
          // by taxedStatus — only the FUND-LEVEL tax charged here
          // changes), but no 15% is actually deducted.
          const ccTax = superMeta[id].taxedStatus === "untaxed" ? 0 : ccGross * outcome.contributionsTaxRate;
          const nccAccepted = nccGross * outcome.nccAcceptRatio;
          superBal[id] += (ccGross - ccTax) + nccAccepted;
          row.superDetail[id].concessionalNet += ccGross - ccTax;
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
              const tax = superMeta[fill.accountId]?.taxedStatus === "untaxed" ? 0 : fill.amount * superOutcome[p].contributionsTaxRate;
              superBal[fill.accountId] += fill.amount - tax; // concessional fill — taxable, no taxFree change
              row.superDetail[fill.accountId].contributions += fill.amount;
              row.superDetail[fill.accountId].contributionsTax += tax;
              row.superDetail[fill.accountId].concessionalNet += fill.amount - tax;
              if (fill.type === "personalDeductible") row.superDetail[fill.accountId].personalDeductible += fill.amount;
              else row.superDetail[fill.accountId].salarySacrifice += fill.amount;
            }
          }
          // Adjustment rows (spec 18, Commit 1) — superContributions:
          // a synthetic contribution to a SPECIFIC account, credited
          // the same shape a toConcessionalCap fill is (flat
          // concessional tax rate). Disclosed simplification: unlike
          // an ordinary contribution row, this does NOT check against
          // the person's remaining concessional cap headroom — an
          // override is entered deliberately, not capped a second time.
          // The household cash side (adjSuperCashOut) is already
          // folded into superContribCashOut below.
          for (const adj of schedule.adjustments ?? []) {
            if (adj.target !== "superContributions" || y < adj.fromYear || y > adj.toYear) continue;
            const amt = adj.amountAtYear[y];
            if (amt === 0) continue;
            // Owner is derived from the ACCOUNT itself (not adj.owner)
            // — the account is the source of truth, and this also
            // doubles as the "does this account still exist" guard: a
            // dangling/removed superAccountId (superMeta has no entry)
            // credits nothing rather than crediting the wrong place.
            const owner = superMeta[adj.superAccountId]?.owner;
            if (!owner) continue;
            const tax = superMeta[adj.superAccountId].taxedStatus === "untaxed" ? 0 : amt * superOutcome[owner].contributionsTaxRate;
            superBal[adj.superAccountId] += amt - tax;
            row.superDetail[adj.superAccountId].contributions += amt;
            row.superDetail[adj.superAccountId].contributionsTax += tax;
            row.superDetail[adj.superAccountId].concessionalNet += amt - tax;
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
            const paid = withdrawFromSuperTaxed(id, want, superMeta[id].owner);
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

      // a1c. Property sale (spec 19 Commit 4) — fires in July of its
      // resolved plan year (same convention as a purchase), BEFORE the
      // property loop below (which would otherwise grow/rent/land-tax
      // a property this SAME month) and before the liability loop
      // further down this same month (so a discharged loan accrues no
      // further interest this FY, not one month too many). CGT joins
      // the SAME pooled cost-base machinery a financial asset sale uses
      // (poolConsume) — PPR is exempt, skipped entirely. Agent fees and
      // settlement costs are a COST-BASE element (spec's own words), so
      // they reduce the taxable gain directly rather than being
      // expensed separately — mathematically identical to adding them
      // to cost base, since gain = proceeds − pool either way. The
      // property "leaves the projection" simply by propVal reaching
      // zero — every existing gate (`propVal[pid] > 0`) already treats
      // that as "doesn't exist", so no separate flag is needed for
      // rent/expenses/land tax/growth to stop.
      let saleNetProceeds = 0;
      for (const pid in propMeta) {
        const pm = propMeta[pid];
        if (pm.saleMonth !== m || propVal[pid] <= 0) continue;
        const saleValue = propVal[pid];
        const agentFeesReal = saleValue * (pm.sale.agentFeesPct / 100);
        const settlementCostsReal = pm.sale.settlementCosts;
        const netProceeds = Math.max(0, saleValue - agentFeesReal - settlementCostsReal);
        let taxableGain = 0;
        if (pm.isCgt) {
          const { state: newPool, gain, newMoneyFraction } = poolConsume(propPools[pid], saleValue, saleValue);
          propPools[pid] = newPool;
          const netGain = gain - agentFeesReal - settlementCostsReal;
          taxableGain = fyStart < 2027 ? preReformTaxableGain(netGain, newMoneyFraction) : netGain;
          // Main residence exemption and the six-year absence rule
          // (spec 19 Commit 5) — ONLY for a "ppr" property (an
          // investment/holiday property's gain must stay fully taxable
          // regardless of exemptProportion's own "never moved out ⇒
          // exempt" default, which assumes a PPR history that doesn't
          // exist for a property that was never anyone's home). Gated
          // explicitly on propertyType, not just isCgt (true here for a
          // ppr-with-absence for this exact reason, but ALSO true for
          // every ordinary investment/holiday property). saleDate/
          // acquisitionDate use the same "1 July of the resolved plan
          // year" calendar-date convention the sale itself fires on.
          if (propsById[pid].propertyType === "ppr") {
            const saleDateISO = `${fyStart}-07-01`;
            const proportion = exemptProportion(pm.acquisitionDate, saleDateISO, resolveMainResidenceDates(pm.mainResidence));
            taxableGain *= (1 - proportion);
          }
          for (const per of persons) {
            const s = pm.shares[per];
            if (s) acc[per].netCapitalGain += taxableGain * s;
          }
        }
        // Discharge the loan linked to this property: the auto-
        // generated purchase-derived loan (id `prop-<id>`, the SAME
        // naming convention isPropertyLoan uses everywhere else) for a
        // property this tool financed itself, or — Input behaviour fix
        // — a liability the user separately linked via "Relates to /
        // secured by" for an already-owned property whose loan was
        // entered by hand. In practice a property only ever has one or
        // the other; the auto-generated id is checked first purely as
        // a defensive tie-break, not a real choice.
        let toDestination = netProceeds;
        const autoLoanId = `prop-${pid}`;
        const loanId = loanBal[autoLoanId] > 0 ? autoLoanId : linkedLoanIdByProperty[pid];
        if (pm.sale.proceedsDestination === "repayLoanThenAsset" && loanId && loanBal[loanId] > 0) {
          const payoff = Math.min(toDestination, loanBal[loanId]);
          loanBal[loanId] -= payoff;
          // Dynamic deductibility (spec 24, Commit 1) — real-pass only,
          // same convention as every other bucket mutation (see
          // reduceBucketsForRepayment's own header); a no-op for the
          // auto-generated D4 purchase loan (autoLoanId), which never
          // uses dynamic deductibility, and for any liability that doesn't.
          if (row) reduceBucketsForRepayment(loanId, payoff);
          toDestination -= payoff;
          // Reported as `principal` — conservationCheck.js's
          // liabilityRevaluation formula already subtracts this field
          // to isolate CPI-driven revaluation from a deliberate balance
          // reduction; a sale-funded discharge is conservation-neutral
          // the same way an ordinary principal repayment or an extra/
          // one-off repayment already is, just funded from a different
          // pocket (the sale, not household cash directly).
          if (row) row.liabilities[loanId].principal += payoff;
        }
        if (pm.sale.assetId && toDestination > 0 && bal[pm.sale.assetId] != null) {
          bal[pm.sale.assetId] += toDestination;
          if (meta[pm.sale.assetId]?.cgt) pools[pm.sale.assetId] = poolAdd(pools[pm.sale.assetId], toDestination);
        }
        saleNetProceeds += netProceeds;
        propVal[pid] = 0;
        if (row) {
          row.properties[pid].saleProceeds = netProceeds;
          row.properties[pid].saleGain = taxableGain;
          row.properties[pid].saleValue = saleValue;
          row.propertySaleProceeds += netProceeds;
        }
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

      // a3. Land tax (spec 19 Commit 2) — assessed annually (July only,
      // same "annual rows fire in July" convention as everything else
      // here) on the AGGREGATED unimproved land value of each owner's
      // non-exempt (non-PPR) properties within a jurisdiction — a
      // household cash outflow either way, but deductible against
      // rental income ONLY for an investment property (a holiday home
      // earns no assessable income to offset against, so its land tax
      // is a personal, non-deductible cost). Routed through the SAME
      // _propNet[pid].expenses bucket ordinary property expenses use,
      // not a bare acc[per].deductions credit alone, so a land-tax-
      // driven loss is subject to the SAME negative-gearing quarantine
      // rule below (line ~2400) — otherwise land tax would always
      // offset other income even in a year the quarantine should apply.
      // landValuePct estimates the unimproved-land share of total value
      // (disclosed approximation); landTaxOverride bypasses the
      // aggregate calculation for that one property, added to its
      // owner's cash/deduction totals directly instead (dutyOverride's
      // own precedence convention).
      let landTaxOut = 0;
      if (m === julyOf(y)) {
        const aggValue = {};
        for (const per of persons) aggValue[per] = {};
        for (const pid in propMeta) {
          const pm = propMeta[pid];
          const p = propsById[pid];
          if (p.propertyType === "ppr" || propVal[pid] <= 0 || p.landTaxOverride != null) continue;
          const landValue = ((p.landValuePct ?? 60) / 100) * propVal[pid];
          for (const per of persons) {
            const s = pm.shares[per];
            if (!s) continue;
            aggValue[per][p.state] = (aggValue[per][p.state] ?? 0) + landValue * s;
          }
        }
        const taxByOwnerState = {};
        for (const per of persons) {
          taxByOwnerState[per] = {};
          for (const st in aggValue[per]) taxByOwnerState[per][st] = landTaxOnValue(st, aggValue[per][st]);
        }
        for (const pid in propMeta) {
          const pm = propMeta[pid];
          const p = propsById[pid];
          if (p.propertyType === "ppr" || propVal[pid] <= 0) continue;
          let propTax = 0;
          if (p.landTaxOverride != null) {
            propTax = p.landTaxOverride;
          } else {
            const landValue = ((p.landValuePct ?? 60) / 100) * propVal[pid];
            for (const per of persons) {
              const s = pm.shares[per];
              if (!s) continue;
              const groupTotal = aggValue[per][p.state] ?? 0;
              const groupTax = taxByOwnerState[per][p.state] ?? 0;
              if (groupTotal > 0) propTax += groupTax * (landValue * s) / groupTotal;
            }
          }
          landTaxOut += propTax;
          if (pm.invest) {
            acc._propNet[pid].expenses += propTax;
            for (const per of persons) {
              const s = pm.shares[per];
              if (s) acc[per].deductions += propTax * s;
            }
          }
          if (row) row.properties[pid].landTax = propTax;
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
        // Drawdowns (spec 24, Commit 1) — applied at the TOP of this
        // liability's own month, before b0 is read, so a drawdown on a
        // currently-fully-repaid loan (loanBal 0) still takes effect
        // this month rather than being skipped by the b0<=0 guard
        // below. Real-pass only (the measured pass never sees it,
        // exactly like a bonus-destination credit — see that block's
        // own header; the measured pass's own interest-deduction figure
        // for THIS specific FY is a disclosed, bounded approximation as
        // a result, corrected from next FY onward once the real pass's
        // mutation persists). Credit-limit binding draws only the
        // available headroom — never silently over the facility, never
        // silently refused — with a flagged warning.
        if (row) {
          for (const ev of schedule.liabilityDrawdownEvents?.[l.id] ?? []) {
            if (ev.month !== m) continue;
            const inflNow = inflAt(m);
            const requestedNominal = ev.amount * inflNow;
            const limit = md.creditLimit;
            const headroomNominal = limit == null ? Infinity : Math.max(0, limit * inflNow - loanBal[l.id]);
            const actualNominal = Math.min(requestedNominal, headroomNominal);
            if (actualNominal <= 0) continue;
            loanBal[l.id] += actualNominal;
            if (md.usesDynamicDeductibility) {
              if (ev.purpose === "private") privateBal[l.id] += actualNominal;
              else investBal[l.id] += actualNominal;
            }
            const actualReal = actualNominal / inflNow;
            if (actualReal < ev.amount - 1e-6) {
              drawdownWarnings.push({
                liabilityId: l.id, type: "creditLimitBound",
                reason: `${l.name ?? "This loan"}: a $${Math.round(ev.amount).toLocaleString()} drawdown exceeds the facility limit — only $${Math.round(actualReal).toLocaleString()} drawn`,
              });
            }
            row.liabilities[l.id].drawdown += actualReal;
            // The money arrives at its destination — cash (the WCA) or
            // an asset. Routed through drawdownIncomeThisMonth (folded
            // into `inc` below), the SAME "credits household cash,
            // already inside income" shape HEAS's own drawdown uses
            // (conservationCheck.js's heasDrawn header) — the loan's
            // own increase is already conservation-neutral via
            // liabilityRevaluation's "+drawdown" term, but that only
            // explains the LIABILITY side; the cash/asset side crediting
            // somewhere needs its own named channel (income), or it
            // reads as money created from nothing. An asset destination
            // is a received-then-invested shape: the cash still lands
            // in income this month, then transfers OUT of the WCA into
            // the asset right after wcaBal += net (drawdownAssetCredits).
            // A property destination is modelled as cash too (this tool
            // has no generic "property improvement cost" to credit
            // instead — disclosed in clampDrawdown's own header).
            drawdownIncomeThisMonth += actualReal;
            if (ev.destination !== "cash" && ev.destination in bal) {
              drawdownAssetCredits.push({ destination: ev.destination, amount: actualReal });
            }
          }
        }
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
        // Dynamic deductibility (spec 24, Commit 1): the fraction to
        // use for THIS month's interest is read BEFORE the repayment
        // below reduces the buckets — "this month's interest deducts
        // at whatever proportion was true going into it", the same
        // opening-balance convention b0 itself already follows.
        const monthDeductibleFraction = currentDeductibleFraction(l.id);
        // Real-pass only: buckets only ever move in the real pass (see
        // the drawdown block's own header above for why). Principal
        // actually repaid this month (contractual + extra), nominal —
        // b0 - b1 net of interest accruing/being repaid — split per
        // repaymentAllocation by the SAME shared reducer every other
        // repayment-shaped mutation site uses.
        if (row) reduceBucketsForRepayment(l.id, Math.max(0, b0 - b1));
        const defl = 1 / infl;
        loanPayReal += (payment + extraApplied) * defl;
        const interestReal = interest * defl;
        // Surplus/deficit allocation spec, Commit 1: deductibleFraction
        // replaces the old all-or-nothing boolean — a part-deductible
        // loan deducts that proportion of its interest, same as before
        // when the fraction is exactly 0 or 1. Dynamic deductibility
        // (spec 24, Commit 1) makes that proportion live for a liability
        // that actually uses it (see currentDeductibleFraction's header).
        if (monthDeductibleFraction > 0 && interestReal > 0) {
          const deductibleInterestReal = interestReal * monthDeductibleFraction;
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
          // Drawdowns and dynamic deductibility (spec 24, Commits 1/3) —
          // same snapshot convention. Reported for EVERY liability, not
          // just one using dynamic tracking (investBal/privateBal don't
          // exist for the others) — derived from currentDeductibleFraction
          // either way, so the Liabilities table's own "deductible
          // proportion" row has one uniform field to read regardless of
          // whether this loan ever drew down or recycled.
          {
            const frac = currentDeductibleFraction(l.id);
            // Deflated at inflAt(m+1), matching `closing`'s OWN deflator
            // (liabSeries[l.id][m+1] = b1/inflAt(m+1)) exactly — using
            // `defl` (1/inflAt(m), this month's own factor) here instead
            // would leave a small but real one-month CPI mismatch
            // against `closing`, since both read the SAME b1.
            const closingDefl = 1 / inflAt(m + 1);
            row.liabilities[l.id].investmentBalance = b1 * closingDefl * frac;
            row.liabilities[l.id].privateBalance = b1 * closingDefl * (1 - frac);
          }
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

      // Debt recycling (spec 24, Commit 2) — resolved once per FY, at
      // its LAST month, right here (BEFORE household net/inc below, so
      // its cash credit can flow through drawdownIncomeThisMonth the
      // same way an ordinary drawdown's does). Redraws an amount equal
      // to THIS FY's contractual + extra principal reduction (NOT the
      // FY-end surplus-allocation sweep further below, which hasn't run
      // yet at this point in the month — a disclosed scope: recycling
      // matches ordinary amortisation/extra repayments, not also a
      // separate surplus-sweep targeting the same loan in the same FY),
      // capped at annualCap and at whatever credit-limit headroom
      // remains, marked investment-purpose (the whole point of the
      // strategy), and directed to its destination asset. Real-pass
      // only, same convention as every other bucket/loanBal mutation —
      // a structurally invalid/unresolved destination falls through
      // (no redraw at all, the same "falls through" shape a dangling
      // bonus destination already has).
      if (row && m === last - 1) {
        for (const l of liabs) {
          const rec = liabMeta[l.id].recycling;
          if (!rec || y < rec.fromYear || y > rec.toYear || !rec.matchRepayments) continue;
          if (!rec.destinationAssetId || !(rec.destinationAssetId in bal)) continue;
          const repaidThisFy = row.liabilities[l.id].principal + row.liabilities[l.id].extraRepayment;
          if (repaidThisFy <= 0) continue;
          const requestedReal = rec.annualCap != null ? Math.min(repaidThisFy, rec.annualCap) : repaidThisFy;
          const inflNow = inflAt(m);
          const requestedNominal = requestedReal * inflNow;
          const limit = liabMeta[l.id].creditLimit;
          const headroomNominal = limit == null ? Infinity : Math.max(0, limit * inflNow - loanBal[l.id]);
          const actualNominal = Math.min(requestedNominal, headroomNominal);
          if (actualNominal <= 0) continue;
          loanBal[l.id] += actualNominal;
          investBal[l.id] += actualNominal; // "mark it investment-purpose" — the spec's own words
          // liabSeries[l.id][m+1] (→ row.liabilities[l.id].closing) was
          // already written by the liability loop above, BEFORE this
          // redraw — re-stamp it now, or the reported closing balance
          // (and hence liabilitiesClosing/netAssets) would understate
          // the redraw for this exact FY, even though loanBal itself
          // (what next year's own amortisation actually starts from)
          // is already correct.
          liabSeries[l.id][m + 1] = loanBal[l.id] / inflAt(m + 1);
          const actualReal = actualNominal / inflNow;
          if (actualReal < requestedReal - 1e-6) {
            drawdownWarnings.push({
              liabilityId: l.id, type: "creditLimitBound",
              reason: `${l.name ?? "This loan"}: debt recycling's redraw exceeds the facility limit — only $${Math.round(actualReal).toLocaleString()} of $${Math.round(requestedReal).toLocaleString()} redrawn`,
            });
          }
          row.liabilities[l.id].drawdown += actualReal;
          drawdownIncomeThisMonth += actualReal;
          drawdownAssetCredits.push({ destination: rec.destinationAssetId, amount: actualReal });
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

      // c-pension. Pension payments (spec 20, Commit 2) — "minimum",
      // "fixed" and "maximum" pay a smooth, SCHEDULED monthly slice of
      // this FY's already-determined annual amount (pensionAnnualAmount,
      // resolved once — see the per-year setup and the commencement
      // block above). "expenditure" pensions are null here (resolved
      // dynamically, in the deficit-funding step below) and skipped.
      //
      // A TRANSFER (pensionBal → the WCA), not new household income —
      // credited DIRECTLY to wcaBal, real-pass only, exactly like an
      // existing super withdrawal already is (see the deficit-funding
      // "d." block's own withdrawFromSuper calls) — NOT folded into
      // `inc`/row.income, which would double-count it: the debit
      // already leaves the ledger's books via pensionClosing's own
      // decrease, so counting the SAME dollar again as "income" in the
      // conservation invariant would claim credit for value that never
      // actually increased net worth (found via the invariant itself —
      // exactly the class of bug its own header describes). Reported
      // instead via the dedicated row.pensionDetail[*].payments fields,
      // the same shape row.superDetail[*].withdrawals already uses.
      //
      // The tax-measurement split (ttrPensionTaxable) is UNGATED — the
      // measurement pass needs to see it too — computed from the
      // THEORETICAL scheduled amount rather than the real pass's capped
      // `paid` (only the real pass can know if the balance ran dry
      // mid-year, an extreme-crash edge case); harmless in practice
      // since every reachable payment in this build is tax-free anyway
      // (see acc[p]'s own header).
      const monthsInFy = last - first;
      for (const pn of pensionRows) {
        if (!pensionCommenced[pn.id]) continue;
        const annual = pensionAnnualAmount[pn.id];
        if (annual == null) continue; // "expenditure" — see the deficit-funding step
        const scheduled = annual / monthsInFy;
        if (scheduled <= 0) continue;
        const pm = pensionMeta[pn.id];
        const scheduledTaxable = scheduled - scheduled * pensionFixedProportion[pn.id];
        if (ownerAgeAt(pm.owner, y) < 60) acc[pm.owner].ttrPensionTaxable += scheduledTaxable;
        if (row) {
          const paid = withdrawFromPension(pn.id, scheduled);
          if (paid <= 0) continue;
          wcaBal += paid;
          pensionPaidYtd[pn.id] += paid;
          const taxFreeAmount = paid * pensionFixedProportion[pn.id];
          row.pensionDetail[pn.id].payments += paid;
          row.pensionDetail[pn.id].paymentsTaxFree += taxFreeAmount;
          row.pensionDetail[pn.id].paymentsTaxable += paid - taxFreeAmount;
        }
      }

      // Commutations (spec 20, Commit 5) — a lump-sum withdrawal in the
      // FIXED proportions (withdrawFromPension, never the live ratio),
      // debiting the owner's transfer balance account at the commuted
      // amount. Post-60 tax-free — every commutation this engine can
      // ever reach IS post-60 (a pension can't even exist below it —
      // see pensionMinCommenceAge's own header), so no offset mechanism
      // is needed the way payments' pre-60 TTR case has one. A TRANSFER
      // either way (cash: pensionClosing → wcaClosing; super:
      // pensionClosing → superClosing), so — like payments — it's
      // credited DIRECTLY, never through `inc`/row.income (would
      // double-count it in the conservation invariant; see the payment
      // block's own comment above for the exact reasoning). A FULL
      // commutation (amount:null → the whole remaining balance) simply
      // leaves pensionBal at 0 — "closing" the pension needs no separate
      // flag; growth/payments on a zero balance are already inert.
      // Real-pass only, same structural convention as every other
      // pension/super balance mutation in this engine.
      if (row) {
        for (const pn of pensionRows) {
          if (!pensionCommenced[pn.id]) continue;
          const pm = pensionMeta[pn.id];
          for (const ev of pensionCommutationEvents[pn.id]) {
            if (ev.month !== m) continue;
            const requested = ev.amount == null ? pensionBal[pn.id] : ev.amount;
            const paid = withdrawFromPension(pn.id, requested);
            if (paid <= 0) continue;
            const taxFreeAmount = paid * pensionFixedProportion[pn.id];
            row.pensionDetail[pn.id].commutations += paid;
            tba[pm.owner] = debitTransferBalance(tba[pm.owner], paid);
            // Deeming grandfathering (spec 21b, Commit 3) — commuting a
            // grandfathered pension ends its grandfathering PERMANENTLY,
            // from this exact month; the consequence (full deeming from
            // here on) doesn't show up in the entitlement figure until
            // next FY's assessment, so it needs a visible warning here,
            // at the moment it actually happens.
            if (pm.grandfathered && ev.month === pensionGrandfatheredLostAt[pn.id]) {
              superWarnings.push({
                fyLabel: schedule.fyLabels[y], owner: pm.owner, type: "grandfatheringLost",
                reason: `Commuting ${pn.name ?? "this pension"} permanently ends its pre-2015 deeming grandfathering — its balance is deemed like any other financial asset from this point on`,
              });
            }
            // "super": returns to accumulation in the SAME account the
            // pension originally came from — a disclosed simplification
            // when that account is no longer valid/included (falls back
            // to cash, the same "don't destroy money, don't silently
            // misattribute it either" fallback shape every other
            // dangling-target case in this engine already uses).
            const target = ev.destination === "super" && superBal[pm.sourceAccountId] !== undefined
              ? pm.sourceAccountId : null;
            if (target) {
              superBal[target] += paid;
              superTaxFree[target] += taxFreeAmount;
            } else {
              wcaBal += paid;
            }
          }
        }

        // Superannuation rollovers (spec 26, Commit 1) — a same-person,
        // account-to-account transfer, real-pass only (superBal/
        // superTaxFree have no measurement-pass concept — see
        // pendingUntaxedSuperTax's own header). Rolling an UNTAXED
        // account's benefit triggers 15% tax on the untaxed element
        // AT ROLLOVER, capped at the (same, lifetime) untaxed plan cap
        // — a FUND-LEVEL flat tax, unlike a personal withdrawal's
        // marginal-rate-plus-offset treatment, so it's a direct balance
        // deduction here, not routed through assessPerson/the one-year
        // lag at all (no personal income tax event occurs — the member
        // never sees this amount as their own assessable income). A
        // same-status rollover (taxed→taxed or untaxed→untaxed) has no
        // untaxed element to tax, so untaxedFraction is simply 0 and the
        // whole amount transfers net.
        for (const ev of superRolloverEvents) {
          if (ev.month !== m) continue;
          const fromBal = superBal[ev.fromAccountId];
          const amount = Math.min(ev.amount == null ? fromBal : ev.amount, Math.max(0, fromBal));
          if (amount <= 0) continue;
          const fromMeta = superMeta[ev.fromAccountId];
          const untaxedFraction = fromMeta.taxedStatus === "untaxed"
            ? Math.max(0, fromBal - superTaxFree[ev.fromAccountId]) / fromBal : 0;
          const taxFreeFraction = superTaxFree[ev.fromAccountId] / fromBal;
          const untaxedPortion = amount * untaxedFraction;
          const { withinCap, excess } = creditUntaxedCap(fromMeta.owner, untaxedPortion);
          const rolloverTax = withinCap * 0.15 + excess * 0.47;
          const taxFreeAmount = amount * taxFreeFraction;
          superBal[ev.fromAccountId] -= amount;
          superTaxFree[ev.fromAccountId] -= taxFreeAmount;
          const netAmount = amount - rolloverTax;
          superBal[ev.toAccountId] += netAmount;
          superTaxFree[ev.toAccountId] += taxFreeAmount;
          row.superDetail[ev.fromAccountId].rolloverOut += amount;
          row.superDetail[ev.toAccountId].rolloverIn += netAmount;
          row.superDetail[ev.fromAccountId].rolloverTax += rolloverTax;
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
      // Age pension (spec 21a) — a genuinely NEW money flow (a
      // government payment with no offsetting household outflow),
      // credited to household cash exactly like any other recurring
      // income, but NEVER via row.income/acc[p].ordinary (it's non-
      // assessable — Commit 3's own tax-treatment decision) — see the
      // per-year setup above for the FY-level assessment this monthly
      // figure divides out of.
      // Defined benefit pensions (spec 26, Commit 2) — a genuinely NEW
      // money flow (no source account, nothing debited anywhere),
      // credited into `inc` the SAME way agePensionMonthly is just
      // above — which is why it needs NO conservation term of its own:
      // `inc` accumulates straight into row.income every month, so it's
      // already fully counted there (see conservationCheck.js's own
      // header on dbPensionInflow for the double-count this avoids).
      // UNLIKE the age pension it IS partly assessable (the untaxed
      // element), so unlike agePensionMonthly it DOES feed acc[p], per
      // owner. Pass-independent (a pure formula, resolved above), so
      // this can run ungated in both passes and be read same-year via
      // measured[p] — no settlement lag, unlike every super/pension
      // mechanism above.
      const dbMonthlyByOwner = { client: 0, partner: 0 };
      const dbUntaxedMonthlyByOwner = { client: 0, partner: 0 };
      for (const db of dbRows) {
        if (dbCommenceMonth[db.id] == null || dbCommenceMonth[db.id] > m) continue;
        const dm = dbMeta[db.id];
        const monthly = dbAnnualAmountThisYear[db.id] / 12;
        const untaxedMonthly = monthly * dm.untaxedProportion;
        const taxFreeMonthly = monthly * dm.taxFreeProportion;
        dbMonthlyByOwner[dm.owner] += monthly;
        dbUntaxedMonthlyByOwner[dm.owner] += untaxedMonthly;
        if (row) {
          row.definedBenefitDetail[db.id].grossPension += monthly;
          row.definedBenefitDetail[db.id].taxFreeAmount += taxFreeMonthly;
          row.definedBenefitDetail[db.id].untaxedAssessable += untaxedMonthly;
        }
      }
      const inc = schedule.income[m] + cashDist + rentIncome - fillSalarySacrifice.client - fillSalarySacrifice.partner + adjIncomeCash + terminationCashOut + agePensionMonthly + heasMonthly + drawdownIncomeThisMonth + dbMonthlyByOwner.client + dbMonthlyByOwner.partner;
      for (const p of persons) {
        const own = p === "partner" ? schedule.incomeByOwner.partner : schedule.incomeByOwner.client;
        if (own && own[m] > 0) {
          acc[p].ordinary += own[m];
          acc[p].incomeMonths.add(m);
        }
        if (fillSalarySacrifice[p] > 0) acc[p].ordinary -= fillSalarySacrifice[p];
        if (dbMonthlyByOwner[p] > 0) {
          acc[p].dbGrossPension += dbMonthlyByOwner[p];
          acc[p].dbUntaxedAssessable += dbUntaxedMonthlyByOwner[p];
          acc[p].incomeMonths.add(m);
        }
      }
      const exp = schedule.expenses[m] + adjExpenseCash;
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
      // Non-concessional contributions specifically: household cash
      // pays for only the ACCEPTED portion (flows.nonConcessional[m] ×
      // nccAcceptRatio), not the full requested amount — a bug found
      // via the conservation invariant once a client's TSB neared the
      // bring-forward "nil" tier (superRatesFor's own
      // bringForwardTsbThresholds) for the first time: a REJECTED NCC
      // (superOutcome's own nccAcceptRatio < 1, see processNonConcessionalCap)
      // was still debiting the FULL gross amount from cash while
      // crediting nothing to super for the rejected slice — money
      // genuinely vanishing, the same class of defect this block's own
      // header describes for a personalDeductible contribution crediting
      // super with no cash ever leaving. nccAcceptRatio is resolved ONCE
      // per FY, before either pass (same "resolve before either pass"
      // convention superOutcome itself already follows), so it's safe
      // to read here directly — no snapshot/restore concern.
      const superContribCashOut = superIds.reduce((s, id) => {
        const flows = schedule.superFlows[id];
        if (!flows) return s;
        const nccRatio = superOutcome[superMeta[id].owner]?.nccAcceptRatio ?? 1;
        return s + flows.personalDeductible[m] + flows.nonConcessional[m] * nccRatio;
      }, 0) + fillCashDebit + adjSuperCashOut;
      // Investment/education bonds (spec 25, Commit 1) — a contribution
      // is paid from household cash, exactly like a personal super
      // contribution above: UNGATED, so an unaffordable contribution
      // runs the same funding-order-then-unfunded fallback as everything
      // else, in BOTH passes (the measurement pass must see the same
      // cash cost, or it could measure a different set of deficit-funded
      // asset sales/realised gains than the real pass actually makes).
      const bondContribCashOut = bonds.reduce((s, b) => {
        const flows = schedule.bondFlows[b.id];
        return s + (flows ? flows.contributions[m] : 0);
      }, 0);
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
      // Gifting (spec 21b, Commit 2) — the FULL gift amount leaves
      // household cash at its own resolved month, regardless of how
      // much of it Centrelink counts as deprived vs allowable (that
      // distinction only affects the age pension assessment, resolved
      // separately above — see the module header on gifting.js: "the
      // gifted amount leaves the client's assets regardless").
      const giftOut = (giftsByMonth[m] ?? []).reduce((s, g) => s + g.amount, 0);
      let net = inc - (exp + propExpenseOut + landTaxOut) - tax - loanPayReal - settlementOut - superContribCashOut - bondContribCashOut - adviserFeeCashOut - giftOut;
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
      // Drawdowns directed to an asset (spec 24, Commit 1) — the cash
      // already landed in the WCA above (via drawdownIncomeThisMonth,
      // folded into inc/net); this transfers it straight back out into
      // the destination asset, a received-then-invested shape, the
      // same WCA-passthrough transfer surplus-allocation's own "asset"
      // target already uses. Real-pass only — bal/pools have no
      // measurement-pass snapshot/restore for this kind of credit.
      if (row) {
        for (const credit of drawdownAssetCredits) {
          wcaBal -= credit.amount;
          bal[credit.destination] += credit.amount;
          if (meta[credit.destination]?.cgt) pools[credit.destination] = poolAdd(pools[credit.destination], credit.amount);
          if (row.perAssetDetail[credit.destination]) row.perAssetDetail[credit.destination].oneOffs += credit.amount;
        }
      }
      if (row) {
        row.income += inc;
        row.cashDistributions += cashDist;
        row.expenses += exp + propExpenseOut + landTaxOut;
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

      // Bonus destinations (spec 23, Commit 2) — a bonus can redirect
      // its own AFTER-TAX amount straight to a loan/super/asset instead
      // of remaining ordinary household cash. Real-pass only, no
      // measurement-pass snapshot needed: this has no tax consequence
      // of its own (the bonus's GROSS amount already flowed through
      // ordinary income/incomeByOwner above, via schedule.js's
      // applyBonus, and is what actually gets taxed). bonusCredits is
      // resolved once per FY, before this real pass, in the per-person
      // tax loop below — the after-tax amount depends on that FY's own
      // marginal tax on the bonus, found by differencing two isolated-
      // employment assessments; this block only APPLIES the already-
      // known dollar amount. Capped at whatever surplus THIS month's
      // cash actually has above the WCA minimum — the same floor the
      // FY-end surplus sweep protects — exactly the "falls through to
      // the normal surplus treatment if unavailable" the spec calls
      // for: a month without enough spare cash just leaves the
      // after-tax bonus sitting in the WCA as ordinary cash instead.
      if (row) {
        // loanBal is tracked in NOMINAL dollars (D3 — nominal
        // amortisation, deflated only at the ledger), unlike bal/
        // superBal, which are real throughout (CLAUDE.md's "real terms
        // everywhere" convention) — credit.amount is real (it came out
        // of assessPerson's own real-dollar differencing), so the loan
        // branch alone needs the SAME real→nominal conversion the
        // ordinary extra-repayment code above it already applies
        // (extraNominal = extraReal * infl).
        const inflNow = inflAt(m);
        for (const credit of bonusCredits[m] ?? []) {
          const available = Math.max(0, wcaBal - wca.minimumBalance);
          if (available <= 0) break;
          if (credit.type === "loanRepayment") {
            const loanBalReal = Math.max(0, (loanBal[credit.targetId] ?? 0) / inflNow);
            const consumed = Math.min(available, credit.amount, loanBalReal);
            if (consumed > 0) {
              loanBal[credit.targetId] -= consumed * inflNow;
              // Dynamic deductibility (spec 24, Commit 1) — already
              // real-pass only (this whole block is), same convention.
              reduceBucketsForRepayment(credit.targetId, consumed * inflNow);
              wcaBal -= consumed;
              row.liabilities[credit.targetId].extraRepayment += consumed;
            }
          } else if (credit.type === "superContribution") {
            const consumed = Math.min(available, credit.amount);
            if (consumed > 0) {
              // Non-concessional (post-tax) credit — the amount is
              // already net of the bonus's own income tax, so no
              // further 15% fund tax applies; the whole amount joins
              // the tax-free component, same as any other NCC.
              superBal[credit.targetId] += consumed;
              superTaxFree[credit.targetId] += consumed;
              wcaBal -= consumed;
              row.superDetail[credit.targetId].contributions += consumed;
            }
          } else if (credit.type === "asset") {
            const consumed = Math.min(available, credit.amount);
            if (consumed > 0) {
              bal[credit.targetId] += consumed;
              if (meta[credit.targetId].cgt) pools[credit.targetId] = poolAdd(pools[credit.targetId], consumed);
              wcaBal -= consumed;
              row.perAssetDetail[credit.targetId].oneOffs += consumed;
            }
          }
        }
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
        // "Expenditure" pensions (spec 20, Commit 2) — "draw what the
        // household needs, floored at the minimum" (the "Expend"
        // behaviour Xtools removed — see docs/reference/
        // xtools-calm-reference.md §10 item 2: "that is our deficit
        // funding"). Tried FIRST, ahead of ordinary asset liquidation —
        // a retiree draws their pension income before selling other
        // assets, and the minimum-floor top-up below tops this same
        // running total up at FY-end regardless. Real-pass only, same
        // structural convention as the released-super draw further
        // below in this same block (no measurement-pass equivalent —
        // see pensionIncomeThisMonth's own header above for why that's
        // an accepted, pre-existing shape in this engine, not new).
        if (row) {
          for (const pn of pensionRows) {
            if (shortfall <= 0) break;
            if (!pensionCommenced[pn.id] || pensionMeta[pn.id].drawdownOption !== "expenditure") continue;
            const paid = withdrawFromPension(pn.id, shortfall);
            if (paid <= 0) continue;
            shortfall -= paid;
            wcaBal += paid;
            const pm = pensionMeta[pn.id];
            const taxFreeAmount = paid * pensionFixedProportion[pn.id];
            const taxableAmount = paid - taxFreeAmount;
            pensionPaidYtd[pn.id] += paid;
            row.pensionDetail[pn.id].payments += paid;
            row.pensionDetail[pn.id].paymentsTaxFree += taxFreeAmount;
            row.pensionDetail[pn.id].paymentsTaxable += taxableAmount;
            if (ownerAgeAt(pm.owner, y) < 60) acc[pm.owner].ttrPensionTaxable += taxableAmount;
          }
        }
        const gainRatio = (id) => {
          // Bonds (spec 25, Commit 2) are not CGT assets at all — same
          // "realises nothing, always sells first" treatment as a plain
          // non-CGT asset like cash, since this rule is specifically
          // about MINIMISING realised CGT, a concept that doesn't apply
          // to a bond's own (entirely different) tax base.
          if (!(id in bal) || !meta[id].cgt) return -Infinity;
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
            const isBond = id in bondBal;
            const floor = floorOf(id);
            const available = Math.max(0, (isBond ? bondBal[id] : bal[id]) - floor);
            if (available <= 0) continue;
            const paid = isBond
              ? sellBond(id, Math.min(shortfall, available), m)
              : sell(id, Math.min(shortfall, available), m);
            shortfall -= paid;
            wcaBal += paid;
            // A bond sale mutates bondBal AFTER this month's own
            // "a-bonds" step already stamped bondSeries[id][m+1] — the
            // same re-stamp requirement debt recycling's own redraw
            // needed (spec 24, Commit 2): the LAST month of the FY has
            // no later month within this same year to naturally correct
            // a stale stamp via its own growth step.
            if (isBond) bondSeries[id][m + 1] = bondBal[id];
            if (row) {
              row.deficitFundedFromAssets += paid;
              if (isBond) row.bondDetail[id].withdrawals += paid;
              else row.perAssetDetail[id].deficitFunding += paid;
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
            const paid = withdrawFromSuperTaxed(id, shortfall, superMeta[id].owner);
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

      // FY-end minimum top-up for "expenditure" pensions (spec 20,
      // Commit 2): "the minimum always applies as a floor. A plan that
      // draws less than the minimum is not a plan; it is a compliance
      // breach" (spec's own words) — an expenditure pension that never
      // needed to cover a shortfall this FY (or covered less than its
      // own minimum) still pays the difference, unconditionally, in the
      // FY's last month. Real-pass only, same reason as the deficit-
      // funding draw above.
      if (row && m === last - 1) {
        for (const pn of pensionRows) {
          if (!pensionCommenced[pn.id] || pensionMeta[pn.id].drawdownOption !== "expenditure") continue;
          const owed = pensionMinThisYear[pn.id] - pensionPaidYtd[pn.id];
          if (owed <= 0) continue;
          const paid = withdrawFromPension(pn.id, owed);
          if (paid <= 0) continue;
          wcaBal += paid;
          const pm = pensionMeta[pn.id];
          const taxFreeAmount = paid * pensionFixedProportion[pn.id];
          const taxableAmount = paid - taxFreeAmount;
          pensionPaidYtd[pn.id] += paid;
          row.pensionDetail[pn.id].payments += paid;
          row.pensionDetail[pn.id].paymentsTaxFree += taxFreeAmount;
          row.pensionDetail[pn.id].paymentsTaxable += taxableAmount;
          if (ownerAgeAt(pm.owner, y) < 60) acc[pm.owner].ttrPensionTaxable += taxableAmount;
        }
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
            const candidates = liabs.filter((l) => loanBal[l.id] > 0 && currentDeductibleFraction(l.id) < 1);
            const ordered = surplusPeriod.debtOrder === "interestRate"
              ? [...candidates].sort((a, b) => rateAt(b) - rateAt(a))
              : candidates; // "manual" — the order liabilities are entered in the Liabilities section
            for (const l of ordered) {
              if (remaining <= 0) break;
              const nonDeductibleBalance = loanBal[l.id] * (1 - currentDeductibleFraction(l.id));
              const pay = Math.min(remaining, nonDeductibleBalance);
              if (pay <= 0) continue;
              loanBal[l.id] -= pay;
              // Dynamic deductibility (spec 24, Commit 1) — this payment
              // targets the NON-deductible balance by definition, so it
              // reduces the private bucket specifically, keeping the
              // investment bucket (and hence the deductible interest it
              // still generates) untouched. Real-pass only — this whole
              // "d." surplus-sweep block runs in BOTH passes (unlike
              // the drawdown/repayment bucket code, which is entirely
              // inside a real-pass-only region), and investBal/privateBal
              // have no measurement-pass snapshot/restore; gating here
              // is what stops the measured pass's own touch from
              // persisting (uncorrected) into the real pass.
              if (row && liabMeta[l.id].usesDynamicDeductibility) {
                privateBal[l.id] = Math.max(0, privateBal[l.id] - pay);
              }
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
                // Dynamic deductibility (spec 24, Commit 1) — real-pass
                // only, same convention as every other bucket mutation.
                if (row) reduceBucketsForRepayment(a.targetId, consumed);
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
                const taxRate = superMeta[target.accountId]?.taxedStatus === "untaxed" ? 0 : superOutcome[target.owner].contributionsTaxRate;
                const tax = consumed * taxRate;
                superBal[target.accountId] += consumed - tax;
                wcaBal -= consumed;
                row.superDetail[target.accountId].contributions += consumed;
                row.superDetail[target.accountId].contributionsTax += tax;
                if (target.type === "personalDeductible") {
                  row.superDetail[target.accountId].personalDeductible += consumed;
                  row.superDetail[target.accountId].surplusPersonalDeductible += consumed;
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
              row.goals[a.targetId].surplusContribution += consumed;
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
        for (const id of pensionIds) pensionSeries[id][m + 1] = pensionBal[id];
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

    // Contribution splitting (spec 19 Commit 6 completion) — an annual
    // election, effective as at 1 July, of a % of THIS account's own
    // PRIOR FY's net concessional contributions moved to the owner's
    // spouse's default account. Applied here, before anything else this
    // FY reads superBal (reserveFromSuper, the measured pass, the
    // Division 293/296 TSB check), because — unlike govSuperInflow,
    // which depends on THIS year's own not-yet-measured income and so
    // must wait until after the real pass — the split's basis (last
    // FY's already-finalised concessionalNet) is fully known before
    // year y starts, so applying it first has no feedback into this
    // year's own results; it's the same "resolve before either pass
    // touches the balance" treatment adviser fees/Division 293/296/
    // FHSSS already get (see reserveFromSuper's own header). A
    // same-total transfer between two pockets already both inside
    // `superClosing` — no conservation term needed, the same reasoning
    // already applied to land tax/redundancy/the PPR exemption (see
    // conservationCheck.js). It does NOT create a new contribution or
    // touch either side's concessional cap (the spec's own words) —
    // this is a raw balance move, nothing routes through superFlows/
    // superOutcome. Reported once `row` exists, a few lines below.
    const contributionSplit = [];
    if (state.plan.partner && y > 0) {
      const priorRow = yearly[y - 1];
      for (const s of superAccounts) {
        const pct = s.contributionSplitPct;
        if (!(pct > 0)) continue;
        const priorNet = priorRow?.superDetail?.[s.id]?.concessionalNet ?? 0;
        if (!(priorNet > 0)) continue;
        const destOwner = s.owner === "partner" ? "client" : "partner";
        const dest = superAccounts.find((d) => d.owner === destOwner);
        if (!dest) continue; // no eligible spouse account to receive it
        // Capped at what's actually still in the account — concessionalNet
        // is a prior-year figure; withdrawals/fees/insurance premiums
        // since then may have already reduced what's left to move.
        const amount = Math.min(priorNet * (pct / 100), Math.max(0, superBal[s.id]));
        if (amount <= 0) continue;
        superBal[s.id] -= amount;
        superBal[dest.id] += amount;
        superSeries[s.id][yearStart(y)] -= amount;
        superSeries[dest.id][yearStart(y)] += amount;
        contributionSplit.push({ fromId: s.id, toId: dest.id, amount });
      }
    }

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
    const bondTaxDue = y > 0 ? pendingBondTax.client + pendingBondTax.partner : 0;
    const untaxedSuperTaxDue = y > 0 ? pendingUntaxedSuperTax.client + pendingUntaxedSuperTax.partner : 0;
    const cgtDue = (y > 0 ? pendingCgt.client + pendingCgt.partner : 0)
      + divReleaseCash.client + divReleaseCash.partner - refundDue + bondTaxDue + untaxedSuperTaxDue;
    const cgtDueDetail = y > 0 ? pendingCgt : { client: 0, partner: 0 };

    // Pension drawdown (spec 20, Commit 2): resolved ONCE per FY, before
    // either pass, for every ALREADY-commenced pension (from a prior
    // year) — pensionBal hasn't been touched yet this FY by either pass
    // (growth/payments are real-pass-only, gated behind `if (row)`
    // below), so it correctly reads as this FY's 1 July balance. A
    // pension commencING this exact FY is resolved separately, inline,
    // right after its commencement transfer fires — its basis isn't
    // known until then. pensionPaidYtd resets here too, every FY,
    // regardless of pass (a plain counter — resetting it in a pass that
    // doesn't credit anything is harmless).
    for (const pn of pensionRows) {
      pensionPaidYtd[pn.id] = 0;
      if (!pensionCommenced[pn.id]) continue; // not yet — resolved at commencement instead
      const ownerAge = ownerAgeAt(pensionMeta[pn.id].owner, y);
      resolvePensionThisYear(pn, pensionBal[pn.id], ownerAge, y);
    }

    // Age pension (spec 21a) — assessed ONCE per FY, before either
    // pass, against opening (1 July) balances: bal/propVal/loanBal/
    // superBal/pensionBal/wcaBal all already reflect the PRIOR year's
    // real pass at this exact point (same reasoning pensionBal's own
    // drawdown resolution above relies on) — Centrelink itself
    // reassesses through the year (20 March/September); this engine
    // applies it once, the same simplification agePension.js's own
    // header discloses for rate/threshold indexation. Tax treatment
    // (Commit 3's own decision, spec's own words: "pick one and say
    // which") — NON-ASSESSABLE income, disclosed: the pensioner tax
    // offset (SAPTO) that would otherwise reduce a taxable pension to
    // near-nil is not modelled anywhere in this engine (CLAUDE.md's own
    // "not modelled" list), so treating the payment as taxable without
    // it would overstate tax; non-assessable avoids that distortion and
    // needs no measurement-pass split at all — there's no tax
    // consequence to get right in two passes; the credit below applies
    // identically to both, gated `if (row)` only for the actual cash
    // movement (the shared "real-pass-only balance mutation" convention).
    const agePensionRatesY = agePensionRatesFor(fyStart, bracketMode, cpi, awoteAssum);
    let agePensionMonthly = 0;
    let agePensionDetailY = null;
    // HEAS (spec 21b, Commit 5) — resolved inside the SAME block as the
    // age pension's own entitlement (paid.client+paid.partner), just
    // below, since the drawdown cap needs it; hoisted here (like
    // agePensionMonthly/agePensionDetailY above) so both survive to
    // feed row.heasDetail and the runYear calls further down.
    let heasMonthly = 0;
    let heasDetailY = null;
    // Deeming grandfathering (spec 21b, Commit 3) — per-pension detail
    // (deductible-amount income, deeming-base exemption), keyed by
    // pension id; declared here (outside the block below) so it
    // survives to feed row.pensionDetail[id] further down.
    let grandfatheredDetailByPension = {};
    // CSHC (spec 21b, Commit 4) needs the SAME grandfathering split
    // outside this block too (its own income test is assembled later,
    // after the tax measurement pass) — hoisted here for the same
    // reason grandfatheredDetailByPension is.
    let grandfatheredDeemingExempt = 0;
    let grandfatheredDeductibleIncome = 0;
    // Pension-PHASE super balances only (never accumulation, regardless
    // of age) — CSHC's own deeming base is narrower than the age
    // pension's (spec's own words: "deemed income from account-based
    // pensions", not every financial asset).
    let pensionPhaseSuperTotal = 0;
    // Gifting (spec 21b, Commit 2) — the household total for THIS FY,
    // summed straight from the already-resolved gift events (fixed
    // month/amount, no path dependence) rather than accumulated inside
    // runYear's own monthly loop.
    let giftsPaidThisYear = 0;
    for (let m = yearStart(y); m < yearEnd(y); m++) {
      giftsPaidThisYear += (giftsByMonth[m] ?? []).reduce((s, g) => s + g.amount, 0);
    }
    {
      // Financial + lifestyle assets both count toward the assets test
      // (spec's own words); only FINANCIAL assets (plus pension-phase
      // super, deemed like any other financial asset) are deemed for
      // the income test — accumulation super is never deemed (it
      // produces no accessible income while preserved).
      let financialAssets = wcaBal;
      let lifestyleAssets = 0;
      for (const id of ids) {
        if (meta[id].lifestyle) lifestyleAssets += bal[id]; else financialAssets += bal[id];
      }
      // Property: every non-PPR property counts at market value, read
      // broadly (a holiday home is assessable too under real Centrelink
      // rules, not only a rented investment) — the PPR is the ONLY
      // property exemption, and its presence marks homeowner status.
      let propertyAssets = 0;
      let homeowner = false;
      for (const p of props) {
        const pm = propMeta[p.id];
        const settledByNow = pm.owned || (pm.purchaseMonth != null && pm.purchaseMonth <= yearStart(y));
        if (!settledByNow) continue;
        if (p.propertyType === "ppr") { homeowner = true; continue; }
        propertyAssets += propVal[p.id];
      }
      // Liabilities secured against an ASSESSED asset (never the PPR)
      // reduce the total — netted against the combined pool rather than
      // per-asset, an equivalent simplification for the aggregate this
      // feeds (agePensionMeansTest.js's own assessableAssets()).
      let securedLiabilities = 0;
      for (const l of liabs) {
        const targetId = l.propertyId ?? l.linkedAssetId;
        const targetProp = targetId ? props.find((p) => p.id === targetId) : null;
        if (targetProp && targetProp.propertyType === "ppr") continue; // secured against the exempt PPR — no effect
        securedLiabilities += loanBal[l.id] ?? 0;
      }
      // Super: accumulation exempt below age pension age, pension-phase
      // assessed regardless (spec's own words — "the rule that drives
      // strategy"), evaluated per OWNER — a couple's younger partner
      // still exempts THEIR OWN accumulation balance even while the
      // elder partner's is fully assessed. Pre-gated here (per owner),
      // then handed to assessableAssets() as `pensionSuper` (its
      // "always assessed" bucket) since the gating is already applied —
      // that function's own single agePensionAgeReached flag can't
      // represent a MIXED per-owner outcome for a couple in one call.
      let preAssessedSuper = 0;
      for (const p of persons) {
        const ageReached = ownerAgeAt(p, y) >= agePensionRatesY.ageOfEligibility;
        if (ageReached) preAssessedSuper += superAccountsByOwner[p].reduce((s, id) => s + superBal[id], 0);
      }
      // Deeming grandfathering (spec 21b, Commit 3) — grandfathering
      // ONLY changes the INCOME test treatment (a "deductible amount"
      // in place of deeming); the ASSETS test is unaffected by it (the
      // spec's own words), so a grandfathered pension's balance still
      // joins preAssessedSuper here uniformly. Separately: still-
      // grandfathered pensions have their balance pulled back OUT of
      // the deeming base below, and their deductible-amount income
      // added straight into otherIncomeTotal instead — bypassing
      // deeming entirely, exactly like a real Centrelink assessment.
      for (const pn of pensionRows) {
        if (!pensionCommenced[pn.id]) continue;
        preAssessedSuper += pensionBal[pn.id]; // pension-phase, always assessed
        pensionPhaseSuperTotal += pensionBal[pn.id];
        const pm = pensionMeta[pn.id];
        if (!pm.grandfathered) continue;
        const lostAt = pensionGrandfatheredLostAt[pn.id];
        const stillGrandfathered = lostAt == null || lostAt > yearStart(y);
        if (!stillGrandfathered) continue;
        grandfatheredDeemingExempt += pensionBal[pn.id];
        const annualPayment = pensionAnnualAmount[pn.id] ?? pensionMinThisYear[pn.id];
        const deductible = pm.grandfatheredLifeExpectancyYears > 0
          ? pm.grandfatheredPurchasePrice / pm.grandfatheredLifeExpectancyYears : 0;
        const deductibleIncome = Math.max(0, annualPayment - deductible);
        grandfatheredDeductibleIncome += deductibleIncome;
        grandfatheredDetailByPension[pn.id] = { grandfatheredDeductibleIncome: deductibleIncome, grandfatheredDeemingExempt: pensionBal[pn.id] };
      }
      // Disclosed simplification: `pensionCommenced` only flips true
      // inside the real pass's own month loop (the actual commencement
      // transfer), which runs AFTER this assessment — so a pension
      // commencing exactly THIS FY is still read as accumulation for
      // this one year's snapshot, then correctly pension-phase from the
      // FOLLOWING FY onward. A one-year lag on the FY a pension actually
      // starts, not an ongoing misclassification.
      //
      // Deprived assets (spec 21b, Commit 2) — gifts above the gifting
      // limits, still counted at face value for the assets test (and
      // folded into the deeming base below for the income test) for
      // exactly five years from their own date.
      const deprivedAssetsTotal = deprivedAssetsAt(resolvedGifts, yearStart(y));
      const assessableAssetsTotal = agePensionAssessableAssets({
        financialAssets, lifestyleAssets, investmentProperty: propertyAssets,
        pensionSuper: preAssessedSuper, securedLiabilities, deprivedAssets: deprivedAssetsTotal,
      });

      // "Other income" (income test): employment income (schedule's own
      // per-owner precomputed array, unaffected by the real pass) —
      // net of the Work Bonus (spec 21b, Commit 1) — plus net rental
      // income on already-settled non-PPR properties this FY. Disclosed
      // simplification: "otherIncome"-category rows (business/other
      // taxable income) and after-tax bonuses are not included — see
      // the Parameters modal.
      //
      // Work Bonus: per person, employment income ONLY (never rental/
      // investment — those never enter this per-person figure), gated
      // on the person having reached age pension age this FY (it's an
      // age-pension-specific concession) — resolved before the rental
      // loop below so workBonusBank[p] only ever advances once per real
      // FY, the same year-sequential convention superCarryForward uses.
      const workBonusExemptByOwner = { client: 0, partner: 0 };
      let otherIncomeTotal = 0;
      for (const p of persons) {
        let employmentIncomeP = 0;
        for (let m = yearStart(y); m < yearEnd(y); m++) employmentIncomeP += schedule.employmentIncomeByOwner[p]?.[m] ?? 0;
        const ageReached = ownerAgeAt(p, y) >= agePensionRatesY.ageOfEligibility;
        if (ageReached) {
          if (workBonusBank[p] == null) workBonusBank[p] = WORK_BONUS.startingBalance; // new recipient
          const wb = workBonusApply({ employmentIncome: employmentIncomeP, bank: workBonusBank[p], exemptAnnual: WORK_BONUS.exemptAnnual, bankCap: WORK_BONUS.bankCap });
          workBonusExemptByOwner[p] = wb.exempt;
          workBonusBank[p] = wb.bank;
          otherIncomeTotal += employmentIncomeP - wb.exempt;
        } else {
          otherIncomeTotal += employmentIncomeP; // not yet age-pension age — Work Bonus doesn't apply
        }
      }
      for (const p of props) {
        const pm = propMeta[p.id];
        if (!pm.invest || p.propertyType === "ppr") continue;
        const settledByNow = pm.owned || (pm.purchaseMonth != null && pm.purchaseMonth <= yearStart(y));
        if (!settledByNow) continue;
        for (let m = yearStart(y); m < yearEnd(y); m++) {
          otherIncomeTotal += propFlowAt(pm.rent, m) - propFlowAt(pm.expensesFlow, m);
        }
      }
      const deemedIncomeTotal = agePensionDeemedIncome({
        // ABPs are deemed like any other financial asset; deprived
        // gifted amounts are ALSO deemed (spec's own words: "assessed
        // under both the assets and income tests (deemed)"); a still-
        // grandfathered pension's balance is pulled back OUT here (its
        // income instead flows through otherIncomeTotal as a deductible-
        // amount figure, added below).
        financialAssets: financialAssets + preAssessedSuper - grandfatheredDeemingExempt + deprivedAssetsTotal,
        lowerRate: agePensionRatesY.deemingLowerRate, upperRate: agePensionRatesY.deemingUpperRate,
        threshold: couple ? agePensionRatesY.couple.deemingThreshold : agePensionRatesY.single.deemingThreshold,
      });
      otherIncomeTotal += grandfatheredDeductibleIncome;
      // Defined benefit pensions (spec 26, Commit 3) — income-test ONLY:
      // never added to financialAssets/preAssessedSuper above (there is
      // no account balance to assess — the spec's own point, "that
      // asset-test exemption is a material planning advantage and is
      // invisible unless modelled"), and bypasses deeming entirely,
      // exactly the same shape the grandfathered-pension deductible-
      // income figure just above already uses. Assessable = gross less
      // its OWN deductible amount (the tax-free component) — the spec's
      // own formula, distinct from the untaxed-element tax treatment
      // (a Commit 2 concern; Centrelink never sees that split).
      let dbAssessableIncomeTotal = 0;
      for (const db of dbRows) {
        if (dbCommenceMonth[db.id] == null || dbCommenceMonth[db.id] > yearStart(y)) continue;
        const gross = dbAnnualAmountFor(db, y);
        const deductible = gross * dbMeta[db.id].taxFreeProportion;
        dbAssessableIncomeTotal += Math.max(0, gross - deductible);
      }
      otherIncomeTotal += dbAssessableIncomeTotal;
      const assessableIncomeTotal = agePensionAssessableIncome({ deemedIncome: deemedIncomeTotal, otherIncome: otherIncomeTotal });

      const assessment = couple
        ? coupleAgePensionAssessment({ assessableAssets: assessableAssetsTotal, assessableIncome: assessableIncomeTotal, rates: agePensionRatesY, homeowner })
        : singleAgePensionAssessment({ assessableAssets: assessableAssetsTotal, assessableIncome: assessableIncomeTotal, rates: agePensionRatesY, homeowner });

      const eachShare = couple ? assessment.each : assessment.entitlement;
      const paid = { client: 0, partner: 0 };
      const ageEligible = { client: false, partner: false };
      for (const p of persons) {
        const person = p === "partner" ? state.plan.partner : state.plan.client;
        ageEligible[p] = ownerAgeAt(p, y) >= agePensionRatesY.ageOfEligibility;
        if (ageEligible[p] && person?.taxProfile?.centrelinkEligible !== false) paid[p] = eachShare;
      }
      agePensionMonthly = (paid.client + paid.partner) / (yearEnd(y) - yearStart(y));
      agePensionDetailY = {
        homeowner,
        deprivedAssets: deprivedAssetsTotal,
        assessableAssets: assessableAssetsTotal,
        assetsTestResult: assessment.assetsResult,
        deemedIncome: deemedIncomeTotal,
        otherIncome: otherIncomeTotal,
        assessableIncome: assessableIncomeTotal,
        incomeTestResult: assessment.incomeResult,
        bindingTest: assessment.bindingTest,
        entitlement: paid.client + paid.partner,
        grandfatheredDeductibleIncome: grandfatheredDeductibleIncome,
        grandfatheredDeemingExempt: grandfatheredDeemingExempt,
        // Defined benefit pensions (spec 26, Commit 3) — the income-
        // test-only assessable amount already folded into otherIncome
        // above, reported separately so the Age pension table can show
        // it as its own row ("income-test-only treatment" — the spec's
        // own words).
        dbAssessableIncome: dbAssessableIncomeTotal,
        client: {
          ageEligible: ageEligible.client, eligible: state.plan.client?.taxProfile?.centrelinkEligible !== false, paid: paid.client,
          workBonusExempt: workBonusExemptByOwner.client, workBonusBank: workBonusBank.client ?? 0,
        },
        partner: couple ? {
          ageEligible: ageEligible.partner, eligible: state.plan.partner?.taxProfile?.centrelinkEligible !== false, paid: paid.partner,
          workBonusExempt: workBonusExemptByOwner.partner, workBonusBank: workBonusBank.partner ?? 0,
        } : null,
      };

      // Home Equity Access Scheme (spec 21b, Commit 5) — resolved here,
      // right after the age pension's own entitlement (paid.client +
      // paid.partner) is known, since the drawdown cap is 150% of the
      // maximum pension rate LESS the actual pension received. Real-
      // rule eligibility: the client OR partner (couple) must have
      // reached age pension age; the secured property must have
      // actually settled (a still-planned property has no value yet to
      // secure against). Interest capitalises on the OPENING balance
      // regardless — an existing loan is never paused or forgiven.
      const heasEligibleAge = heasProperty
        ? (couple
            ? ownerAgeAt("client", y) >= HEAS_BASE.ageOfEligibility || ownerAgeAt("partner", y) >= HEAS_BASE.ageOfEligibility
            : ownerAgeAt("client", y) >= HEAS_BASE.ageOfEligibility)
        : false;
      const heasPm = heasProperty ? propMeta[heasProperty.id] : null;
      // Disclosed simplification, same shape as pensionCommenced's own
      // one-year lag: this whole assessment runs before either pass,
      // against OPENING (1 July) values — propVal for a property
      // purchasing exactly THIS FY isn't credited until the real pass's
      // own purchase event fires, later in the month loop. So a
      // property settling this exact FY still reads as unsettled for
      // this one snapshot, then correctly available from the
      // FOLLOWING FY onward.
      const heasSettled = heasPm ? (heasPm.owned || (heasPm.purchaseMonth != null && heasPm.purchaseMonth <= yearStart(y))) : false;
      const heasBalOpening = heasBal;
      let heasSecurityValue = 0, heasMla = 0, heasDrawnThisYear = 0;
      if (heasProperty && heasEligibleAge && heasSettled) {
        heasSecurityValue = propVal[heasProperty.id];
        // Real rule: for a couple, the YOUNGER partner's age sets the
        // age component (a lower cap while either partner is younger).
        const heasAge = couple ? Math.min(ownerAgeAt("client", y), ownerAgeAt("partner", y)) : ownerAgeAt("client", y);
        heasMla = heasMaxLoanAmount(heasSecurityValue, heasAge);
        const maxPensionRate = couple ? agePensionRatesY.couple.rateCombined : agePensionRatesY.single.rate;
        const requestedAnnual = Math.max(0, HEAS_BASE.drawdownCapPctOfMaxPension * maxPensionRate - (paid.client + paid.partner));
        const headroom = Math.max(0, heasMla - heasBalOpening);
        heasDrawnThisYear = Math.min(requestedAnnual, headroom);
      }
      // The loan's legislated rate is NOMINAL (fortnightly-compounding,
      // not part of the CPI/AWOTE indexation regime — see heas.js's own
      // header); deflated to real terms the same Fisher way every other
      // nominal rate in this engine is, since heasBal itself is tracked
      // in real dollars like every other balance here.
      const heasRealAnnualRate = (1 + heasEffectiveAnnualRate()) / (1 + cpi) - 1;
      const heasInterestThisYear = heasBalOpening * heasRealAnnualRate;
      heasBal = heasBalOpening + heasInterestThisYear + heasDrawnThisYear;
      heasMonthly = heasDrawnThisYear / (yearEnd(y) - yearStart(y));
      heasDetailY = {
        opening: heasBalOpening, interest: heasInterestThisYear, drawn: heasDrawnThisYear,
        mla: heasMla, securityValue: heasSecurityValue, closing: heasBal,
      };
    }

    // Super contribution caps (Tier 1.2, Commit 2): resolved ONCE per
    // FY, before either pass — concessional carry-forward and NCC
    // bring-forward are year-SEQUENTIAL state that must advance exactly
    // once per real FY, not once per measurement/real pass. The outcome
    // (contributions tax rate, the accepted NCC fraction, dynamic
    // "toConcessionalCap" fills, excess CC, and the Div293 inputs) is
    // handed to runYear for crediting in the real pass only.
    const superRatesY = superRatesFor(fyStart, bracketMode, cpi, awoteAssum);

    // Transfer balance cap indexation (spec 20, Commit 4) — applied
    // ONCE per FY, before either pass (a pure recompute against
    // whatever each person's account already holds; no cash/balance
    // mutation, so it's safe to apply UNGATED, identically in both
    // passes — the same reasoning superRatesY's own resolution uses).
    const generalCapDelta = superRatesY.generalTransferBalanceCap - lastTransferBalanceCap;
    for (const p of persons) tba[p] = indexTransferBalanceCap(tba[p], generalCapDelta);
    lastTransferBalanceCap = superRatesY.generalTransferBalanceCap;
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
      // Defined benefit pensions (spec 26, Commit 2) — notional taxed
      // contributions count toward the concessional cap, the same as
      // any other concessional flow, but consume headroom ONLY (no
      // super account is credited — see the acc[p] header on the
      // structural reason this counts nowhere else). Modelled while the
      // member is still an ACCRUING one — before their own pension
      // commences (the real-world shape: notional contributions accrue
      // during working life, not after retirement); disclosed
      // simplification: grandfathered schemes cap notional
      // contributions AT the concessional cap so a member can't
      // involuntarily exceed it (spec's own words) — that grandfathering
      // itself is NOT modelled, so a grandfathered member's notional
      // contributions can show as excess here when in reality they
      // would not.
      let grossNotionalDB = 0;
      for (const db of dbRows) {
        if (dbMeta[db.id].owner !== p) continue;
        const commenceMonth = dbCommenceMonth[db.id];
        if (commenceMonth != null && commenceMonth <= yearStart(y)) continue; // already commenced — no longer accruing
        grossNotionalDB += dbMeta[db.id].notionalTaxedContributions;
      }
      const otherConcessional = grossSG + grossSS + grossPD + grossNotionalDB;
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

    // Pension commencement (spec 20, Commit 1) — a FIFTH mechanism that
    // can claim from a super account this same year, resolved through
    // the SAME reserveFromSuper ledger as adviser fees/Division
    // 293/296/FHSSS above (appended last in the fixed claim order —
    // see reserveFromSuper's own header). Without this, a pension
    // commencing this FY would read the account's LIVE balance directly
    // inside the monthly loop, oblivious to what the other four
    // mechanisms already reserved against the SAME account this same
    // year — exactly the class of bug reserveFromSuper exists to
    // prevent (found via the conservation invariant itself, once a
    // randomised pension shared an account with an FHSSS-eligible
    // contribution often enough to hit it).
    for (const pn of pensionRows) {
      if (pensionCommenced[pn.id] || pensionCommenceMonth[pn.id] !== yearStart(y)) continue;
      const sourceId = pensionMeta[pn.id].sourceAccountId;
      const requested = pn.commenceAmount == null ? Math.max(0, superBal[sourceId] ?? 0) : pn.commenceAmount;
      pensionCommenceReserved[pn.id] = reserveFromSuper(sourceId, requested);
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
    // Investment/education bonds (spec 25, Commit 2): bondBal/
    // bondCostBase are now path-dependent within the SAME measurement
    // pass (a deficit-funded bond sale mid-year changes what's left to
    // grow/sell for the rest of that pass), so they need the same
    // snapshot/restore as bal/pools — bondSeries does NOT (it's pure
    // per-month output, overwritten wholesale by the real pass that
    // follows, the same reason `series` itself needs no restore).
    const bondBalSnap = { ...bondBal };
    const bondCostBaseSnap = { ...bondCostBase };
    const measured = runYear(y, {
      taxOut: null, cgtDue, row: null, trackUnfunded: false, superOutcome,
      divReleaseFromSuper, divReleaseAccountId, fhsssRelease,
      ongoingFromSuperRequested, ongoingFromSuperShortfall, upfrontFromSuperShortfall,
      agePensionMonthly, heasMonthly,
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
    Object.assign(bondBal, bondBalSnap);
    Object.assign(bondCostBase, bondCostBaseSnap);

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
    //
    // Salary packaging (spec 23, Commit 3) — reportableFringeBenefits
    // and fbtPayable are STATIC per FY (schedule.js's own packaging
    // resolution already grouped by employer/cap and needs no per-year
    // tax context), so read once here rather than recomputed per
    // person below. "The sting": packaging that reduces income tax can
    // increase HELP/Div293/MLS via this exact add-back.
    const reportableFringeBenefits = {
      client: schedule.packagingByOwnerYear.client.reportableFringeBenefits[y],
      partner: schedule.packagingByOwnerYear.partner ? schedule.packagingByOwnerYear.partner.reportableFringeBenefits[y] : 0,
    };
    const fbtDue = {
      client: schedule.packagingByOwnerYear.client.fbtPayable[y],
      partner: schedule.packagingByOwnerYear.partner ? schedule.packagingByOwnerYear.partner.fbtPayable[y] : 0,
    };
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
        ttrPensionTaxable: measured[p].ttrPensionTaxable ?? 0,
        // The schedule-driven, education-linked withdrawal (spec 25,
        // Commit 3) is safe here — see acc[p]'s own init comment.
        bondAssessableWithdrawal: measured[p].bondAssessableWithdrawal ?? 0,
        // Defined benefit pensions (spec 26, Commit 2) — pass-independent
        // (see dbGrossPension's own header), safe to assess same-year
        // via measured[p] here, same as ttrPensionTaxable/bondAssessableWithdrawal
        // above.
        dbUntaxedPensionTaxable: measured[p].dbUntaxedAssessable ?? 0,
        dbIncomeCapExcess: Math.max(0, (measured[p].dbGrossPension ?? 0) - superRatesY.dbIncomeCap) * 0.5,
      });
      // Disclosed simplification: excludes this FY's own realised
      // capital gain AND the DEFICIT-FUNDED bond assessable withdrawal
      // (spec 25, Commit 2) — both are deficit-funding-driven, so their
      // exact SIZE is only known once the real pass actually runs (the
      // measurement pass's own shortfall differs, since it simulates
      // zero tax cash outflow
      // that month — see the a2 block below for why this MUST be
      // assessed from real[p], not measured[p], the same reason CGT
      // already is), which this engine only ever assesses in a later,
      // separately-timed block.
      repaymentIncome[p] = pre.taxableIncome
        + (superOutcome[p]?.reportableSuperContributions ?? 0)
        + netInvestmentLoss[p]
        + reportableFringeBenefits[p];
    }

    // Commonwealth Seniors Health Card (spec 21b, Commit 4) — income-
    // tested only, no assets test. Assessable income is "adjusted
    // taxable income" (repaymentIncome — the SAME disclosed-simplified
    // figure already used for HELP/MLS purposes, per its own header
    // above) plus deemed income from account-based pensions, with the
    // SAME pre-2015 grandfathering exclusion as Commit 3 (a still-
    // grandfathered pension's deductible-amount income counts instead
    // of being deemed). Computed here — the earliest point BOTH
    // repaymentIncome (from the tax measurement pass) and the
    // grandfathering split (from the per-year setup, hoisted above) are
    // known — assessed on the COMBINED household figure for a couple
    // (spec's own words), reported per person since each person needs
    // their OWN age-eligibility check.
    const cshcThresholdsY = cshcThresholdsFor(fyStart, bracketMode, cpi);
    const cshcDeemableAbp = Math.max(0, pensionPhaseSuperTotal - grandfatheredDeemingExempt);
    const cshcDeemedIncomeTotal = agePensionDeemedIncome({
      financialAssets: cshcDeemableAbp,
      lowerRate: agePensionRatesY.deemingLowerRate, upperRate: agePensionRatesY.deemingUpperRate,
      threshold: couple ? agePensionRatesY.couple.deemingThreshold : agePensionRatesY.single.deemingThreshold,
    });
    const cshcAdjustedTaxableIncome = repaymentIncome.client + repaymentIncome.partner;
    const cshcAssessableIncomeTotal = cshcAdjustedTaxableIncome + cshcDeemedIncomeTotal + grandfatheredDeductibleIncome;
    const cshcThreshold = couple ? cshcThresholdsY.coupleCombined : cshcThresholdsY.single;
    const cshcMargin = cshcThreshold - cshcAssessableIncomeTotal; // positive = room to spare; negative = over
    const cshcIncomeEligible = cshcAssessableIncomeTotal <= cshcThreshold;
    const cshcDetailY = {
      threshold: cshcThreshold,
      adjustedTaxableIncome: cshcAdjustedTaxableIncome,
      deemedIncome: cshcDeemedIncomeTotal,
      grandfatheredDeductibleIncome,
      assessableIncome: cshcAssessableIncomeTotal,
      margin: cshcMargin,
      client: {
        ageEligible: ownerAgeAt("client", y) >= agePensionRatesY.ageOfEligibility,
        eligible: ownerAgeAt("client", y) >= agePensionRatesY.ageOfEligibility && cshcIncomeEligible,
      },
      partner: couple ? {
        ageEligible: ownerAgeAt("partner", y) >= agePensionRatesY.ageOfEligibility,
        eligible: ownerAgeAt("partner", y) >= agePensionRatesY.ageOfEligibility && cshcIncomeEligible,
      } : null,
    };
    // Spouse contributions, co-contribution and LISTO (spec 19 Commit
    // 6) — both persons' pre-assessed taxable income is now known
    // (repaymentIncome/pre, just above), so this is the earliest safe
    // point: the spouse offset needs the RECEIVING spouse's own income,
    // which isn't ready until BOTH persons' loop iterations above have
    // run. Credited/applied immediately, in the SAME FY it's earned —
    // a disclosed simplification of the real ~12-18 month ATO payment
    // lag for co-contribution/LISTO (which this tool doesn't otherwise
    // model deferred-government-payment timing for at all).
    const spouseRatesY = spouseSuperRatesFor(fyStart, bracketMode, cpi, awoteAssum);
    // Government co-contribution and LISTO — genuine inflows FROM the
    // government INTO super, credited to the person's own default
    // (first-listed, included) account, same convention SG uses. The
    // "10% eligible income" test (real law: 10%+ of income from
    // employment or business) collapses to "10%+ from employment" here
    // — this tool has no separate self-employment/business income
    // category to test against (disclosed).
    // Credited to superBal (and reported on the row) below, once `row`
    // exists — computed here, alongside everything else this FY's
    // assessment needs, but applied later (this function-level scope
    // doesn't have `row` yet; it's declared just before the real pass).
    const govSuperInflowAccount = { client: null, partner: null };
    const govSuperInflowAmount = { client: 0, partner: 0 };
    for (const p of persons) {
      const account = (state.plan.superAccounts ?? []).find((s) => s.owner === p && s.include);
      if (!account) continue;
      const empArr = schedule.employmentIncomeByOwner[p];
      let employmentIncomeFy = 0;
      if (empArr) for (let m = yearStart(y); m < yearEnd(y); m++) employmentIncomeFy += empArr[m];
      const totalIncome = Math.max(1, measured[p].ordinary); // avoid a spurious 100% ratio at zero income
      const eligibleIncomeTestMet = employmentIncomeFy / totalIncome >= spouseRatesY.coContributionEligibleIncomeTestPct;
      let inflow = 0;
      if (eligibleIncomeTestMet) {
        const ncc = schedule.personalNccByOwner?.[p]?.[y] ?? 0;
        inflow += coContribution(spouseRatesY, ncc, measured[p].ordinary);
        inflow += listo(spouseRatesY, superOutcome[p]?.lowTaxContributions ?? 0, measured[p].ordinary);
      }
      if (inflow > 0) {
        govSuperInflowAccount[p] = account.id;
        govSuperInflowAmount[p] = inflow;
      }
    }

    const isFamily = persons.length > 1; // a couple — MLS family thresholds apply to both
    const familyIncome = repaymentIncome.client + repaymentIncome.partner;
    // Input Usability spec, Commit 3 — derived per FY from each child's
    // own DOB, so the family threshold steps down as children age out
    // instead of being a fixed number for the life of the projection.
    const dependentChildren = dependentChildrenCountInFY(state.plan.children, fyStart);

    // Adjustment rows (spec 18, Commit 1) — resolved once per FY,
    // bucketed by person and by which mechanism applies. tax.withheld
    // adjusts PAYG withheld only (below, where paygWithheld is
    // computed) — meaningful ONLY for a person with employment income
    // this FY, since only that branch has a withheld-vs-liability gap
    // for a timing adjustment to net out through next July's refund/
    // balancing settlement; a person with no employment income has no
    // separate "withheld" concept to adjust (a disclosed no-op, not a
    // silent leak — applying it as a permanent tax change instead would
    // break the "nets to zero across the two years" guarantee that's
    // the whole point of this target). tax.incomeTax/medicare/help/cgt
    // are disclosed as ONE cash-debit mechanism: each overrides "how
    // much tax this person actually pays this FY", applied below via
    // the same PAYG-style spread every ordinary tax debit already
    // uses — which specific line it's labelled against on screen is a
    // display concern (Commit 2), not a distinct settlement mechanic.
    const taxAdjustmentTotal = { client: 0, partner: 0 };
    const withheldAdjustmentTotal = { client: 0, partner: 0 };
    for (const adj of schedule.adjustments ?? []) {
      if (y < adj.fromYear || y > adj.toYear) continue;
      const amt = adj.amountAtYear[y];
      if (amt === 0) continue;
      if (adj.target === "tax.withheld") withheldAdjustmentTotal[adj.owner] += amt;
      else if (adj.target === "tax.incomeTax" || adj.target === "tax.medicare" || adj.target === "tax.help" || adj.target === "tax.cgt") {
        taxAdjustmentTotal[adj.owner] += amt;
      }
    }

    taxOutArr.fill(0, yearStart(y), yearEnd(y));
    // Salary packaging (spec 23, Commit 3) — FBT is a genuine one-time
    // annual liability, not a smoothly-accruing PAYG-style withholding,
    // so it's added directly here (once, the FY's first month) exactly
    // like cgtDue's own "fires once, added at m===first" pattern —
    // deliberately OUTSIDE the paygWithheld/pendingRefund reconciliation
    // below (which only reconciles income tax/HELP/MLS), so it can
    // never be silently trued-up/refunded away the following year.
    taxOutArr[yearStart(y)] += fbtDue.client + fbtDue.partner;
    // Bonus destinations (spec 23, Commit 2) — {[month]: [{type,
    // targetId, amount}]}, resolved fresh each FY (see the loop below)
    // and passed to THIS year's real pass only; the measured pass
    // above already ran and rolled back, so it can never see this —
    // exactly the ordering every other "resolved once per FY, before
    // the real pass" figure in this file already relies on.
    const bonusCredits = {};
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
        ttrPensionTaxable: measured[p].ttrPensionTaxable ?? 0,
        // The schedule-driven, education-linked withdrawal only (spec
        // 25, Commit 3) — pass-independent, safe to assess immediately.
        // The DEFICIT-FUNDED case is deliberately excluded here — see
        // the "pre" call above and the a2 block below for why THAT one
        // must be assessed from real[p], not measured[p].
        bondAssessableWithdrawal: measured[p].bondAssessableWithdrawal ?? 0,
        dbUntaxedPensionTaxable: measured[p].dbUntaxedAssessable ?? 0,
        dbIncomeCapExcess: Math.max(0, (measured[p].dbGrossPension ?? 0) - superRatesY.dbIncomeCap) * 0.5,
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
        paygWithheld[p] = payg.netIncomeTax + withheldAdjustmentTotal[p];
        // Bonus destinations (spec 23, Commit 2) — "PAYG withholding on
        // a bonus uses the marginal method... withheld at the
        // recipient's marginal rate on the bonus amount" (the spec's
        // own words). Found by differencing this SAME isolated-
        // employment assessment against a counterfactual with the
        // bonus's own gross removed — the standard differencing
        // technique this codebase already uses elsewhere (see
        // medicareOnGain in Tax/engine.js) to isolate one component's
        // own incremental tax, correctly capturing bracket-climbing
        // rather than an average/blended rate. Only computed when this
        // person actually has a bonus destination event this FY — free
        // for every other person/year.
        const bonusEvents = bonusEventsByOwnerYear.get(`${p}::${y}`);
        if (bonusEvents?.length) {
          const grossFy = bonusEvents.reduce((s, ev) => s + ev.grossAmount, 0);
          const withoutBonus = assessPerson({
            fyStartYear: fyStart, bracketMode, cpi,
            ordinaryIncome: Math.max(0, employmentIncomeFy - grossFy), deductions: 0,
            distributions: { franked: 0, unfranked: 0 },
            netCapitalGain: 0, capitalLossCarryFwd: 0,
            taxProfile: state.plan[p]?.taxProfile ?? null,
            excessConcessionalContributions: 0,
          });
          const bonusMarginalTax = Math.max(0, payg.netIncomeTax - withoutBonus.netIncomeTax);
          const afterTaxTotal = Math.max(0, grossFy - bonusMarginalTax);
          for (const ev of bonusEvents) {
            const share = grossFy > 0 ? ev.grossAmount / grossFy : 0;
            const amount = afterTaxTotal * share;
            if (amount <= 0) continue;
            const dest = ev.destination;
            if (dest.type === "superContribution") {
              // Age/work-test gate (Tier 1.2's own superContributionAllowed)
              // — this credit bypasses schedule.js's own superFlows
              // array (the amount isn't known until this differencing
              // runs), so it needs the SAME gate applied inline. Not
              // hooked into the NCC annual cap/bring-forward ledger — a
              // disclosed gap, not a silent one (this is a targeted
              // redirect of a specific bonus, not a user-entered
              // recurring contribution row).
              const age = p === "partner" ? schedule.partnerAges?.[y] : schedule.clientAges[y];
              const workTestMet = (p === "partner" ? state.plan.partner?.super?.workTestMet : state.plan.client?.super?.workTestMet) !== false;
              const gateResult = superContributionAllowed("personalNonDeductible", age, workTestMet, superRatesFor(fyStart, bracketMode, cpi));
              if (!gateResult.ok) {
                superWarnings.push({
                  fyLabel: schedule.fyLabels[y], owner: p, type: "bonusSuperContribution", reason: gateResult.reason,
                });
                continue; // falls through — stays as ordinary household cash
              }
            }
            (bonusCredits[ev.month] ??= []).push({ type: dest.type, targetId: dest.targetId, amount });
          }
        }
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
      // Adjustment rows (spec 18, Commit 1) — the tax.incomeTax/medicare/
      // help/cgt leak, applied uniformly regardless of which branch
      // above fired (see this block's own header comment).
      if (taxAdjustmentTotal[p] !== 0) {
        spreadTax(taxAdjustmentTotal[p], measured[p].incomeMonths, yearEnd(y) - 1);
      }
      helpBal[p] -= helpDue[p];
    }

    // Spouse contribution tax offset (spec 19 Commit 6) — applied via
    // the SAME spreadTax mechanism as every other same-year tax debit/
    // credit above, so it MUST run after `taxOutArr.fill(...)` and the
    // per-person spreadTax calls just above (both of those reset/write
    // this exact array) — placed any earlier, this offset's own write
    // gets silently wiped by that later fill, a real bug this file's
    // own conservation invariant caught (a $500 gap between the
    // adviser-fee-from-super/-cash split it exposed on an unrelated
    // interaction while debugging this same commit).
    if (state.plan.partner) {
      for (const receivingOwner of persons) {
        const contributingOwner = receivingOwner === "partner" ? "client" : "partner";
        const contribution = schedule.spouseContributionsByOwner?.[receivingOwner]?.[y] ?? 0;
        if (contribution <= 0) continue;
        // TSB check (disclosed simplification: the receiving spouse's
        // CURRENT total super balance, a reasonable proxy for "at the
        // prior 30 June" — this engine doesn't separately snapshot TSB
        // at FY boundaries anywhere else either). The "no excess NCCs"
        // condition is not modelled — disclosed, not silently assumed
        // met; a rare edge case relative to the income-based phase-out.
        const receivingTsb = (state.plan.superAccounts ?? [])
          .filter((s) => s.owner === receivingOwner && s.include)
          .reduce((s, acc) => s + (superBal[acc.id] ?? 0), 0);
        if (receivingTsb >= spouseRatesY.generalTransferBalanceCap) continue;
        const offset = spouseContributionOffset(spouseRatesY, contribution, repaymentIncome[receivingOwner]);
        if (offset > 0) spreadTax(-offset, measured[contributingOwner].incomeMonths, yearEnd(y) - 1);
      }
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
        reportableFringeBenefits: reportableFringeBenefits[p],
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
    for (const b of bonds) row.bondDetail[b.id].opening = bondSeries[b.id][yearStart(y)];
    for (const id of pensionIds) row.pensionDetail[id].opening = pensionSeries[id][yearStart(y)];
    // Contribution splitting (spec 19 Commit 6 completion) — the actual
    // balance move already happened at the top of this year's loop
    // (before `opening`, above, was even read); this just reports it.
    for (const split of contributionSplit) {
      row.superDetail[split.fromId].contributionSplitOut += split.amount;
      row.superDetail[split.toId].contributionSplitIn += split.amount;
    }
    row.agePensionDetail = agePensionDetailY;
    row.cshcDetail = cshcDetailY;
    row.heasDetail = heasDetailY;
    row.giftsPaid = giftsPaidThisYear;
    for (const id of pensionIds) {
      if (grandfatheredDetailByPension[id]) Object.assign(row.pensionDetail[id], grandfatheredDetailByPension[id]);
    }
    const real = runYear(y, {
      taxOut: taxOutArr, cgtDue, row, trackUnfunded: true, superOutcome,
      divReleaseFromSuper, divReleaseAccountId, fhsssRelease,
      ongoingFromSuperRequested, ongoingFromSuperShortfall, upfrontFromSuperShortfall,
      agePensionMonthly, heasMonthly, bonusCredits,
    });
    // Defined benefit pensions (spec 26, Commit 2) — report the FY's
    // income-cap excess on every one of this owner's DB rows,
    // proportioned by each row's own share of the person's total gross
    // DB pension (a person can hold more than one) — purely for the
    // Commit 3 table breakout; the tax consequence itself is already
    // correctly assessed via the person-level total (the "a" call
    // above). row.definedBenefitDetail[*].grossPension is only now
    // populated (the real pass just finished), hence resolved here.
    for (const p of persons) {
      const totalGross = measured[p].dbGrossPension ?? 0;
      if (!(totalGross > 0)) continue;
      const capExcessTotal = Math.max(0, totalGross - superRatesY.dbIncomeCap) * 0.5;
      for (const db of dbRows) {
        if (dbMeta[db.id].owner !== p) continue;
        const g = row.definedBenefitDetail[db.id].grossPension;
        row.definedBenefitDetail[db.id].dbIncomeCapExcess = capExcessTotal * (g / totalGross);
      }
    }
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
    for (const b of bonds) {
      row.bondDetail[b.id].closing = bondSeries[b.id][yearEnd(y)];
      row.bondDetail[b.id].costBase = bondCostBase[b.id];
      row.bondsClosing += bondSeries[b.id][yearEnd(y)];
      // Bonds table reporting (spec 25, Commit 2): years to the ten-year
      // date (floored at 0 — already matured), and the 125% headroom
      // for NEXT FY's contribution (this FY's own total, ×1.25 — the
      // basis bondContributionCapCheck will compare next FY's total
      // against; the FY-end check above has already rolled
      // bondPriorFyContribution over to it).
      row.bondDetail[b.id].yearsToMaturity = Math.max(0, (bondMaturityMonth(bondEffectiveStartMonth[b.id]) - yearEnd(y)) / 12);
      row.bondDetail[b.id].contributionHeadroom = bondPriorFyContribution[b.id] * 1.25;
    }
    for (const id of pensionIds) {
      row.pensionDetail[id].closing = pensionSeries[id][yearEnd(y)];
      row.pensionDetail[id].taxFreeClosing = pensionTaxFree[id];
      // Reported once the pension has actually commenced (fixed at that
      // point, for life — see pensionFixedProportion's own header);
      // still null every year before commencement, and 0 if it never
      // commenced at all within this projection (no source funds, or
      // the condition-of-release gate never met).
      if (pensionCommenced[id]) row.pensionDetail[id].taxFreeProportion = pensionFixedProportion[id];
      row.pensionClosing += pensionSeries[id][yearEnd(y)];
    }
    // Transfer balance account (spec 20, Commit 4) — snapshotted after
    // this FY's indexation AND every credit event that could have
    // fired this FY (both happen earlier in this same real pass).
    for (const p of persons) {
      row.transferBalance[p] = {
        balance: tba[p].balance,
        personalCap: tba[p].personalCap,
        remainingCap: Math.max(0, tba[p].personalCap - tba[p].balance),
      };
    }

    // Government co-contribution + LISTO (spec 19 Commit 6) — credited
    // strictly AFTER the real pass completes (not before, and not
    // between the measured pass and `row` — both were tried and both
    // leak into the SAME-year adviser-fee/Division 293/296/FHSSS
    // reservation system: those all resolve "how much to draw from
    // super vs cash" against superBal EARLIER in this function, so
    // crediting super before they run made the balance look bigger than
    // it actually was AT THAT DECISION POINT, silently shifting some of
    // THEIR funding from cash to super — found via this very invariant,
    // the same class of bug reserveFromSuper's own header describes.
    // Applied here, after everything else this FY has already settled,
    // it can't influence any of that; it just doesn't compound further
    // growth THIS year — a disclosed timing simplification, reasonable
    // given the real ATO payment lag is 12-18 months anyway. Bumping
    // superSeries too (not just superBal) keeps NEXT year's own
    // opening balance (read from superSeries, not superBal, at that
    // point) consistent with this year's true closing.
    for (const p of persons) {
      const accountId = govSuperInflowAccount[p];
      if (!accountId) continue;
      const amount = govSuperInflowAmount[p];
      superBal[accountId] += amount;
      superSeries[accountId][yearEnd(y)] += amount;
      row.superDetail[accountId].closing += amount;
      row.superDetail[accountId].govSuperInflow += amount;
      row.superClosing += amount;
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
    row.netAssets = row.closingBalance + row.propertyClosing + row.superClosing + row.pensionClosing + row.bondsClosing + row.wcaClosing - row.liabilitiesClosing - row.heasDetail.closing;

    // CGT assessment on the year's realised net gains (decision 13),
    // stacked on the same measured income base.
    const newPending = { client: 0, partner: 0 };
    // Investment/education bonds (spec 25, Commit 2): the incremental
    // tax cost of THIS FY's pre-ten-year DEFICIT-FUNDED bond
    // withdrawal(s) — assessed here, from
    // real[p].bondDeficitAssessableWithdrawal (the REAL pass's own
    // actual withdrawal amount), the SAME reason CGT is assessed from
    // real[p].netCapitalGain rather than measured[p]: a deficit-funded
    // sale's exact size depends on this month's ACTUAL tax cash outflow,
    // which the measurement pass (taxOut: null) never simulates, so the
    // two passes can genuinely draw down a different amount — using
    // measured[p]'s figure to size THIS FY's tax would silently mismatch
    // what was actually sold. Isolated by differencing (the same
    // technique the bonus-PAYG withholding block above already uses),
    // stacked on top of BOTH ordinary income and this FY's own gain —
    // passed into a2 itself for this reason (so cgtTax's own gain-
    // stacking base already reflects it). The SCHEDULE-DRIVEN,
    // education-linked case (Commit 3) is a DIFFERENT acc field,
    // assessed immediately via measured[p] in the "pre"/"a" calls
    // instead — see acc[p]'s own init comment for why that one doesn't
    // need this lag.
    const newPendingBondTax = { client: 0, partner: 0 };
    // Untaxed superannuation elements (spec 26, Commit 1) — same lag,
    // same isolation-by-differencing technique, for the SAME structural
    // reason (see pendingUntaxedSuperTax's own header): super mutations
    // are entirely real-pass-gated, so this FY's untaxed-benefit amount
    // is only known AFTER the real pass finishes, too late for the "a"
    // call that already produced this FY's taxOut. Isolated independently
    // of the bond delta above: "withoutBond" still carries the untaxed
    // amounts (so it isolates ONLY bond's own effect), and the
    // "withoutUntaxedSuper" call below still carries the bond amount (so
    // it isolates ONLY the untaxed-super delta) — each lagged flow is
    // differenced against a baseline that keeps every OTHER lagged flow
    // in place, the general pattern for combining independent deltas.
    const newPendingUntaxedSuperTax = { client: 0, partner: 0 };
    for (const p of persons) {
      // Remaining quarantined carry offsets this year's realised gains.
      if (quarantineCarry[p] > 0 && real[p].netCapitalGain > 0) {
        const useGain = Math.min(quarantineCarry[p], real[p].netCapitalGain);
        real[p].netCapitalGain -= useGain;
        quarantineCarry[p] -= useGain;
      }
      const bondDeficitAssessableWithdrawal = real[p].bondDeficitAssessableWithdrawal ?? 0;
      const untaxedSuperWithinCap = real[p].untaxedSuperWithinCap ?? 0;
      const untaxedSuperExcess = real[p].untaxedSuperExcess ?? 0;
      // Defined benefit pensions (spec 26, Commit 2) — pass-independent,
      // already fully assessed same-year in the "a" call above (no lag
      // of its own). Still passed into EVERY call in this block,
      // including both "without" isolation calls: omitting it here
      // would understate the taxable base each call stacks its own gain
      // on top of, silently mis-bracketing the CGT/bond/untaxed-super
      // deltas this block computes — the general rule for combining
      // independent deltas (see untaxedSuperWithinCap's own header).
      const dbUntaxed = measured[p].dbUntaxedAssessable ?? 0;
      const dbCapExcess = Math.max(0, (measured[p].dbGrossPension ?? 0) - superRatesY.dbIncomeCap) * 0.5;
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
        bondAssessableWithdrawal: bondDeficitAssessableWithdrawal,
        untaxedSuperTaxable: untaxedSuperWithinCap,
        untaxedSuperExcess,
        dbUntaxedPensionTaxable: dbUntaxed,
        dbIncomeCapExcess: dbCapExcess,
      });
      lossCarryFwd[p] = a2.lossCarryFwd;
      newPending[p] = a2.cgtTax;
      if (bondDeficitAssessableWithdrawal > 0) {
        const withoutBond = assessPerson({
          fyStartYear: fyStart, bracketMode, cpi,
          ordinaryIncome: measured[p].ordinary,
          deductions: measured[p].deductions,
          distributions: { franked: measured[p].franked, unfranked: measured[p].unfranked },
          netCapitalGain: real[p].netCapitalGain,
          capitalLossCarryFwd: lossCarryFwd[p],
          taxProfile: state.plan[p]?.taxProfile ?? null,
          excessConcessionalContributions: superOutcome[p]?.excessCC ?? 0,
          untaxedSuperTaxable: untaxedSuperWithinCap,
          untaxedSuperExcess,
          dbUntaxedPensionTaxable: dbUntaxed,
          dbIncomeCapExcess: dbCapExcess,
        });
        newPendingBondTax[p] = a2.netIncomeTax - withoutBond.netIncomeTax;
      }
      if (untaxedSuperWithinCap > 0 || untaxedSuperExcess > 0) {
        const withoutUntaxedSuper = assessPerson({
          fyStartYear: fyStart, bracketMode, cpi,
          ordinaryIncome: measured[p].ordinary,
          deductions: measured[p].deductions,
          distributions: { franked: measured[p].franked, unfranked: measured[p].unfranked },
          netCapitalGain: real[p].netCapitalGain,
          capitalLossCarryFwd: lossCarryFwd[p],
          taxProfile: state.plan[p]?.taxProfile ?? null,
          excessConcessionalContributions: superOutcome[p]?.excessCC ?? 0,
          bondAssessableWithdrawal: bondDeficitAssessableWithdrawal,
          dbUntaxedPensionTaxable: dbUntaxed,
          dbIncomeCapExcess: dbCapExcess,
        });
        newPendingUntaxedSuperTax[p] = a2.netIncomeTax - withoutUntaxedSuper.netIncomeTax;
      }
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
      // Pension phase (spec 20, Commit 2/5) — the reserved "Taxable
      // Pension Component"/"Taxable Pension Offset (TTR)" rows in the
      // firm's cashflow vocabulary (src/cashflowStatement.js). Always 0
      // in this build's own reachable states (every payment is post-60
      // — see acc[p]'s own header) but wired for genuine correctness,
      // the same shape as excessCcOffset/fhsssOffset above.
      taxablePensionComponent: measured[p].ttrPensionTaxable ?? 0,
      ttrPensionOffset: assessed[p].ttrPensionOffset,
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
      // Salary packaging (spec 23, Commit 3) — the household's FBT
      // liability (already inside row.tax above, via taxOutArr) and the
      // reportable fringe benefits amount added back for HELP/Div293/
      // MLS purposes (repaymentIncome above), surfaced for the net-
      // position view (Focus/output tables).
      fbtPayable: fbtDue.client + fbtDue.partner,
      reportableFringeBenefits: reportableFringeBenefits.client + reportableFringeBenefits.partner,
    };
    yearly.push(row);
    pendingCgt = newPending;
    pendingBondTax = newPendingBondTax;
    pendingUntaxedSuperTax = newPendingUntaxedSuperTax;
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

  // Death benefits (spec 22, Commit 1) — the final projection year's
  // row alone; see computeDeathBenefitForPerson's own header for why
  // this is a terminal figure, not a per-year one.
  const finalRow = yearly[yearly.length - 1];
  if (finalRow) {
    finalRow.deathBenefitDetail = {
      client: computeDeathBenefitForPerson("client", state.plan.client, superAccounts, pensionRows, finalRow, couple, tba),
      partner: couple ? computeDeathBenefitForPerson("partner", state.plan.partner, superAccounts, pensionRows, finalRow, couple, tba) : null,
    };
  }

  return {
    schedule,
    monthly: { combined, perAsset: series, wca: wcaSeries },
    yearly,
    shortfall,
    accruedCgtAtEnd: pendingCgt.client + pendingCgt.partner,
    // Same unpayable-final-FY convention as accruedCgtAtEnd (spec 25,
    // Commit 2): the final FY's own bond-withdrawal tax never settles
    // inside the projection either.
    accruedBondTaxAtEnd: pendingBondTax.client + pendingBondTax.partner,
    // Same unpayable-final-FY convention (spec 26, Commit 1): the final
    // FY's own untaxed-super-benefit tax never settles inside the
    // projection either.
    accruedUntaxedSuperTaxAtEnd: pendingUntaxedSuperTax.client + pendingUntaxedSuperTax.partner,
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
    drawdownWarnings,
    bondWarnings,
    liabilityRepaymentStats,
    liabilityRollovers,
    goalStats,
    wealthCrossoverYear,
  };
}
