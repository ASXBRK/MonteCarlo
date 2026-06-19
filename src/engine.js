// BalancePoint Contributions Planner - calculation engine.
// All exports are pure functions. No DOM, no React, no side effects.

import {
  CC_CAP,
  NCC_CAP,
  NCC_BF_TIERS_2025_26,
  NCC_BF_TIERS_2026_27,
  CARRY_FORWARD,
  DIV293,
  TAX_BRACKETS_BY_FY,
  TAX_BRACKETS_2025_26,
  MEDICARE_LEVY,
  CONTRIB_TAX,
  CONTRIB_AGE_LIMIT,
  ALL_FY,
} from './config.js';

// FY helpers ----------------------------------------------------------------

export function fyStartYear(fy) {
  return parseInt(fy.split('/')[0], 10);
}

export function fyFromStartYear(startYear) {
  const next = (startYear + 1) % 100;
  return `${startYear}/${next.toString().padStart(2, '0')}`;
}

export function fyEndCalYear(fy) {
  return fyStartYear(fy) + 1;
}

export function nextFY(fy) {
  return fyFromStartYear(fyStartYear(fy) + 1);
}

// Tax helpers ---------------------------------------------------------------

export function taxOnIncome(income, brackets) {
  if (income <= 0) return 0;
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    if (income <= prev) break;
    const slice = Math.min(income, b.upTo) - prev;
    tax += slice * b.rate;
    prev = b.upTo;
  }
  return tax;
}

export function marginalRate(income, brackets) {
  for (const b of brackets) {
    if (income <= b.upTo) return b.rate;
  }
  return 0;
}

export function effectiveMarginalRate(income, brackets) {
  // Including the 2% Medicare levy when income exceeds the basic threshold.
  const base = marginalRate(income, brackets);
  if (income > 27222) return base + MEDICARE_LEVY;
  return base;
}

// 1. Carry-forward concessional ---------------------------------------------

/**
 * Compute carry-forward concessional cap state over an array of FY rows.
 *
 * Input rows: [{ fy: '2019/20', ccCap?, ccMade: number, tsbPriorJune?: number }]
 * If ccCap omitted, looks up CC_CAP[fy].
 *
 * Output: array of rows, each augmented with
 *   { totalAvailable, availableCarryBefore, carriedForward, bucketsAfter,
 *     tsbEligibleForCarry, excessOverCap }
 *
 * FIFO expiry: a bucket originating in FY with startYear Y is usable in years
 *   Y+1 ... Y+5; it expires at the end of Y+5. CCs applied first consume the
 *   base cap, then oldest buckets next.
 */
export function computeCarryForward(rows) {
  const buckets = []; // { originFY, originYear, remaining }
  const out = [];

  for (const row of rows) {
    const fy = row.fy;
    const yearStart = fyStartYear(fy);
    const ccCap = row.ccCap ?? CC_CAP[fy] ?? 0;
    const ccMade = Number(row.ccMade) || 0;
    const tsb = Number(row.tsbPriorJune) || 0;
    const tsbEligibleForCarry = tsb < CARRY_FORWARD.tsbGate;

    // Active buckets (not yet expired): originYear + maxYears >= yearStart
    const active = buckets.filter(
      (b) => b.originYear + CARRY_FORWARD.maxYears >= yearStart,
    );

    const availableCarryBefore = active.reduce((s, b) => s + b.remaining, 0);
    const totalAvailable = ccCap + availableCarryBefore;

    // Apply CCs: consume base cap first, then oldest buckets (FIFO).
    let remainingToApply = ccMade;
    const consumedBase = Math.min(remainingToApply, ccCap);
    remainingToApply -= consumedBase;
    const unusedBaseThisYear = ccCap - consumedBase;

    const activeCopy = active.map((b) => ({ ...b }));
    activeCopy.sort((a, b) => a.originYear - b.originYear);
    for (const b of activeCopy) {
      if (remainingToApply <= 0) break;
      const use = Math.min(remainingToApply, b.remaining);
      b.remaining -= use;
      remainingToApply -= use;
    }

    // Replace the buckets list with surviving active buckets, then add this
    // year's leftover base cap as a new bucket.
    buckets.length = 0;
    for (const b of activeCopy) {
      if (b.remaining > 0.005) buckets.push(b);
    }
    if (unusedBaseThisYear > 0.005) {
      buckets.push({
        originFY: fy,
        originYear: yearStart,
        remaining: unusedBaseThisYear,
      });
    }

    const carriedForward = buckets.reduce((s, b) => s + b.remaining, 0);
    const excessOverCap = Math.max(0, ccMade - totalAvailable);

    out.push({
      ...row,
      ccCap,
      ccMade,
      tsbPriorJune: tsb,
      totalAvailable,
      availableCarryBefore,
      tsbEligibleForCarry,
      carriedForward,
      excessOverCap,
      bucketsAfter: buckets.map((b) => ({ ...b })),
    });
  }

  return out;
}

/**
 * Given the result of computeCarryForward, return buckets at end of `asOfFY`
 * grouped with expiry information for the use-it-or-lose-it visual.
 */
export function bucketsForExpiryView(historyRows, asOfFY) {
  const last = historyRows[historyRows.length - 1];
  if (!last) return [];
  const buckets = last.bucketsAfter;
  const currentYear = fyStartYear(asOfFY);
  return buckets.map((b) => {
    const expiresYear = b.originYear + CARRY_FORWARD.maxYears;
    const yearsLeft = expiresYear - currentYear;
    let status = 'available';
    if (yearsLeft < 0) status = 'expired';
    else if (yearsLeft <= 1) status = 'expiringSoon';
    return {
      originFY: b.originFY,
      remaining: b.remaining,
      expiresFY: fyFromStartYear(expiresYear),
      yearsLeft,
      status,
    };
  });
}

// 2. Concessional estimator -------------------------------------------------

/**
 * Available concessional cap given current-year committed contributions.
 */
export function availableCC({
  fy,
  sg = 0,
  salarySacrifice = 0,
  personalDeductible = 0,
  carryForwardAvailable = 0,
  tsbPriorJune = 0,
  taxableIncome = 0,
}) {
  const baseCap = CC_CAP[fy] ?? 0;
  const canUseCarry = tsbPriorJune < CARRY_FORWARD.tsbGate;
  const usableCarry = canUseCarry ? carryForwardAvailable : 0;
  const totalCap = baseCap + usableCarry;
  const committedCC = (sg || 0) + (salarySacrifice || 0) + (personalDeductible || 0);
  const remainingCap = Math.max(0, totalCap - committedCC);
  const overCap = Math.max(0, committedCC - totalCap);

  // Div 293 income includes taxable income + low-tax contributions (SG, SS,
  // personal deductible).
  const lowTaxContrib = committedCC;
  const div293Income = (taxableIncome || 0) + lowTaxContrib;
  const div293Flag = div293Income > DIV293.threshold;
  const div293Excess = Math.max(0, div293Income - DIV293.threshold);
  const div293ApplicableContrib = Math.min(lowTaxContrib, div293Excess);
  const div293Liability = div293ApplicableContrib * DIV293.extraRate;

  return {
    fy,
    baseCap,
    carryForwardAvailable,
    usableCarry,
    totalCap,
    committedCC,
    remainingCap,
    overCap,
    canUseCarry,
    tsbPriorJune,
    div293Flag,
    div293Income,
    div293Liability,
    div293ApplicableContrib,
  };
}

// 3. Non-concessional estimator --------------------------------------------

export function nccBfTiersFor(fy) {
  if (fy === '2026/27') return NCC_BF_TIERS_2026_27;
  return NCC_BF_TIERS_2025_26;
}

/**
 * Available non-concessional cap and bring-forward tier.
 */
export function availableNCC({
  fy,
  tsbPriorJune = 0,
  ncCMadeThisYear = 0,
  age = 30,
}) {
  const caps = NCC_CAP[fy] ?? NCC_CAP['2025/26'];
  const annualCap = caps.annual;
  const tiers = nccBfTiersFor(fy);
  const tier = tiers.find((t) => tsbPriorJune < t.tsbUnder) ?? tiers[tiers.length - 1];

  const eligibilityCutoff = age > CONTRIB_AGE_LIMIT;
  const autoBringForward = ncCMadeThisYear > annualCap && tier.years > 0;
  const totalAvailable = tier.available;
  const remaining = Math.max(0, totalAvailable - ncCMadeThisYear);
  const overCap = Math.max(0, ncCMadeThisYear - totalAvailable);

  return {
    fy,
    annualCap,
    tier,
    bringForwardYears: tier.years,
    totalAvailable,
    remaining,
    overCap,
    eligibilityCutoff,
    autoBringForward,
    age,
    tsbPriorJune,
  };
}

// 4. Tax saving estimator ---------------------------------------------------

/**
 * Estimate the tax saving from making a concessional contribution.
 *
 * - `taxableIncome` is income BEFORE the contribution (gross).
 * - `contribution` is the additional concessional contribution being modelled.
 * - `div293Applies` upgrades the in-fund tax to 30% on the slice that hits
 *   Div 293.
 */
export function taxSaving({
  fy,
  taxableIncome,
  contribution,
  div293Income = null,
}) {
  if (contribution <= 0) {
    return {
      marginalRate: 0,
      personalTaxAvoided: 0,
      contribTax15: 0,
      div293Tax: 0,
      netSaving: 0,
      effectivePerDollar: 0,
      warning: null,
    };
  }
  const brackets = TAX_BRACKETS_BY_FY[fy] ?? TAX_BRACKETS_2025_26;
  const incomeBefore = taxableIncome;
  const incomeAfter = Math.max(0, taxableIncome - contribution);

  const taxBefore = taxOnIncome(incomeBefore, brackets);
  const taxAfter = taxOnIncome(incomeAfter, brackets);

  // Medicare levy approximation: 2% applies above ~$27k.
  const medBefore = incomeBefore > 27222 ? incomeBefore * MEDICARE_LEVY : 0;
  const medAfter = incomeAfter > 27222 ? incomeAfter * MEDICARE_LEVY : 0;

  const personalTaxAvoided = taxBefore + medBefore - taxAfter - medAfter;
  const sliceEffectiveRate = personalTaxAvoided / contribution;

  // 15% in-fund contributions tax.
  const contribTax15 = contribution * CONTRIB_TAX;

  // Div 293 add-on: 15% on the portion above the threshold.
  const div293ApplicableContrib = (() => {
    if (div293Income == null) return 0;
    const excess = Math.max(0, div293Income - DIV293.threshold);
    return Math.min(contribution, excess);
  })();
  const div293Tax = div293ApplicableContrib * DIV293.extraRate;

  const netSaving = personalTaxAvoided - contribTax15 - div293Tax;
  const effectivePerDollar = netSaving / contribution;

  let warning = null;
  if (sliceEffectiveRate < CONTRIB_TAX) {
    warning = 'Marginal rate below 15%: concessional contribution increases net tax.';
  } else if (netSaving <= 0) {
    warning = 'After contributions tax and Div 293, net saving is zero or negative.';
  }

  return {
    marginalRate: sliceEffectiveRate,
    personalTaxAvoided,
    contribTax15,
    div293Tax,
    netSaving,
    effectivePerDollar,
    warning,
  };
}

// 5. Multi-year projection --------------------------------------------------

/**
 * Project super balance forward applying contributions, 15% contribution tax
 * on concessional, and an annual return.
 *
 * annualStrategy: either a number (CC per year, NCC=0) or an object
 *   { cc, ncc }. May also pass a function (yearIndex, fy) => { cc, ncc }.
 */
export function projectBalance({
  startBalance,
  annualStrategy,
  returnRate,
  fy,
  years,
}) {
  const out = [];
  let balance = startBalance;
  let currentFY = fy;

  for (let i = 0; i < years; i++) {
    const strat = typeof annualStrategy === 'function'
      ? annualStrategy(i, currentFY)
      : typeof annualStrategy === 'number'
        ? { cc: annualStrategy, ncc: 0 }
        : annualStrategy;
    const cc = strat?.cc ?? 0;
    const ncc = strat?.ncc ?? 0;

    const contribTax = cc * CONTRIB_TAX;
    const netContrib = cc - contribTax + ncc;

    // Apply contributions then growth.
    const afterContrib = balance + netContrib;
    const growth = afterContrib * returnRate;
    balance = afterContrib + growth;

    out.push({
      year: i + 1,
      fy: currentFY,
      cc,
      ncc,
      contribTax,
      netContrib,
      growth,
      balance,
    });
    currentFY = nextFY(currentFY);
  }
  return out;
}

// 6. Optimiser --------------------------------------------------------------

/**
 * Recommend an optimal concessional contribution amount for the current FY
 * given an objective.
 *
 * objective:
 *   - 'maxTaxSaving' — use carry-forward + base cap to maximise tax saved
 *     without slicing below 15% MTR.
 *   - 'maxBalance' — same as max tax saving (concessional + NCC up to cap).
 *   - 'useCarryForward' — fully use carry-forward expiring soonest.
 */
export function recommendStrategy({
  fy,
  taxableIncome,
  carryForwardAvailable,
  tsbPriorJune,
  age,
  sg = 0,
  salarySacrificeExisting = 0,
  personalDeductibleExisting = 0,
  objective = 'maxTaxSaving',
  affordability = Infinity,
  bucketsAfter = [],
}) {
  const baseCap = CC_CAP[fy] ?? 0;
  const canUseCarry = tsbPriorJune < CARRY_FORWARD.tsbGate;
  const committedCC = sg + salarySacrificeExisting + personalDeductibleExisting;
  const baseHeadroom = Math.max(0, baseCap - committedCC);
  const usableCarry = canUseCarry ? carryForwardAvailable : 0;

  // Hard ceiling from cap.
  const capCeiling = baseHeadroom + usableCarry;

  const brackets = TAX_BRACKETS_BY_FY[fy] ?? TAX_BRACKETS_2025_26;

  // Find the income level at which MTR drops to 15% — below this, concessional
  // contributions stop being net-positive. Walking the brackets, the largest
  // contribution that keeps the slice above 15% is taxableIncome - 18200, but
  // only if income is currently in the 15%+ band.
  let maxBeforeNegative = capCeiling;
  if (taxableIncome <= 18200) {
    maxBeforeNegative = 0;
  } else {
    maxBeforeNegative = Math.min(capCeiling, Math.max(0, taxableIncome - 18200));
  }

  let recommended;
  let optimisedFor;
  let benefitText;
  let benefitValue;

  if (objective === 'useCarryForward') {
    // Use the oldest-expiring bucket(s) first, capped by income and affordability.
    const sortedBuckets = [...bucketsAfter].sort((a, b) => a.originYear - b.originYear);
    let expiringSoon = 0;
    for (const b of sortedBuckets) {
      const yearsLeft = b.originYear + CARRY_FORWARD.maxYears - fyStartYear(fy);
      if (yearsLeft <= 1) expiringSoon += b.remaining;
    }
    const target = expiringSoon > 0 ? expiringSoon : usableCarry;
    recommended = Math.min(
      target + baseHeadroom,
      maxBeforeNegative,
      affordability,
    );
    optimisedFor = 'Using carry-forward before it expires';
    const ts = taxSaving({
      fy,
      taxableIncome,
      contribution: recommended,
      div293Income: taxableIncome + committedCC + recommended,
    });
    benefitValue = ts.netSaving;
    benefitText = 'in net tax saved';
  } else {
    // maxTaxSaving / maxBalance — use up to capCeiling, but stop if MTR<=15%.
    recommended = Math.min(capCeiling, maxBeforeNegative, affordability);
    const ts = taxSaving({
      fy,
      taxableIncome,
      contribution: recommended,
      div293Income: taxableIncome + committedCC + recommended,
    });
    if (objective === 'maxBalance') {
      optimisedFor = 'Maximising projected end balance';
      benefitText = 'extra into super after tax';
      benefitValue = recommended - ts.contribTax15 - ts.div293Tax;
    } else {
      optimisedFor = 'Maximising tax saved this year';
      benefitText = 'in net tax saved';
      benefitValue = ts.netSaving;
    }
  }

  recommended = Math.max(0, Math.round(recommended));

  const eligibility = {
    tsbCarryGate: { ok: canUseCarry, label: '$500k TSB carry-forward gate' },
    div293: {
      ok: taxableIncome + committedCC + recommended <= DIV293.threshold,
      label: '$250k Div 293 threshold',
    },
    ageLimit: {
      ok: age <= CONTRIB_AGE_LIMIT,
      label: `Age ${CONTRIB_AGE_LIMIT} contribution limit`,
    },
    workTest: {
      ok: age < 67 || age > 74,
      label: 'Work test 67–74',
      info: age >= 67 && age <= 74 ? 'Personal deductible only — work test applies' : null,
    },
  };

  return {
    recommended,
    optimisedFor,
    benefitText,
    benefitValue,
    eligibility,
    breakdown: {
      baseHeadroom,
      usableCarry,
      capCeiling,
      maxBeforeNegative,
    },
  };
}

// 7. Putting it together — project with strategy over multiple years -------

/**
 * Project balance for two scenarios (with strategy vs no strategy / SG-only)
 * over a horizon, including cumulative tax saved.
 */
export function projectScenarios({
  startBalance,
  fy,
  years,
  returnRate,
  withStrategy,
  baseline,
  taxableIncome,
}) {
  const withRows = projectBalance({
    startBalance,
    annualStrategy: withStrategy,
    returnRate,
    fy,
    years,
  });
  const baseRows = projectBalance({
    startBalance,
    annualStrategy: baseline,
    returnRate,
    fy,
    years,
  });

  let cumTaxSaved = 0;
  const merged = withRows.map((row, i) => {
    const baseRow = baseRows[i];
    const extraCC = row.cc - baseRow.cc;
    const incomeThisYear = Math.max(0, taxableIncome - baseRow.cc);
    const ts = taxSaving({
      fy: row.fy,
      taxableIncome: incomeThisYear,
      contribution: extraCC,
      div293Income: taxableIncome + baseRow.cc + extraCC,
    });
    const yearTaxSaved = Math.max(0, ts.netSaving);
    cumTaxSaved += yearTaxSaved;
    return {
      year: row.year,
      fy: row.fy,
      withBalance: row.balance,
      baseBalance: baseRow.balance,
      delta: row.balance - baseRow.balance,
      yearTaxSaved,
      cumTaxSaved,
      cc: row.cc,
      ncc: row.ncc,
      baseCc: baseRow.cc,
    };
  });
  return merged;
}

// 8. Formatters -------------------------------------------------------------

export function fmt(n) {
  if (n == null || isNaN(n)) return '$0';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.round(Math.abs(n)).toLocaleString('en-AU');
}

export function fmtCents(n) {
  if (n == null || isNaN(n)) return '$0.00';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString('en-AU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtK(n) {
  if (n == null || isNaN(n)) return '$0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1_000) return sign + '$' + (abs / 1_000).toFixed(0) + 'k';
  return sign + '$' + abs.toFixed(0);
}

export function pct(n, digits = 1) {
  if (n == null || isNaN(n)) return '0%';
  return (n * 100).toFixed(digits) + '%';
}

// 9. Convenience: historical default rows for the carry-forward sample ------

export function defaultHistoryRows() {
  return [
    { fy: '2019/20', ccMade: 0, tsbPriorJune: 100000 },
    { fy: '2020/21', ccMade: 0, tsbPriorJune: 120000 },
    { fy: '2021/22', ccMade: 0, tsbPriorJune: 150000 },
    { fy: '2022/23', ccMade: 0, tsbPriorJune: 180000 },
    { fy: '2023/24', ccMade: 0, tsbPriorJune: 220000 },
    { fy: '2024/25', ccMade: 0, tsbPriorJune: 280000 },
  ];
}
