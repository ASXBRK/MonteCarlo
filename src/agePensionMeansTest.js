// Age Pension — assets test and income test mechanics (spec 21a,
// Commit 2). Pure functions only — no DOM/Plotly, no reference to plan
// state or the engine's own asset/liability graph. Asset composition
// (which balances count, netting a liability against its secured
// asset, homeowner status) is an engine-integration concern resolved
// by the caller (deterministic.js, Commit 3) — this module only knows
// the test MECHANICS once handed clean numbers.
//
// The rule that drives strategy (spec's own words): superannuation in
// ACCUMULATION phase is exempt from the assets test until the member
// reaches age pension age; in PENSION phase it is assessed regardless
// of age. assessableAssets() takes accumulation and pension-phase super
// as two SEPARATE inputs for exactly this reason — collapsing them
// into one "super balance" figure upstream would make this rule
// impossible to apply correctly.

// Total assessable assets for the assets test. `securedLiabilities` is
// the sum of liability balances secured against an ASSESSED asset
// (never the principal residence, which the caller excludes entirely
// before this function ever sees the figures) — netting reduces the
// asset's contribution, per the spec's own wording ("less... any
// liability secured against an assessed asset").
export function assessableAssets({
  financialAssets = 0,
  lifestyleAssets = 0,
  investmentProperty = 0,
  businessAssets = 0,
  accumulationSuper = 0,
  pensionSuper = 0,
  agePensionAgeReached = true,
  securedLiabilities = 0,
} = {}) {
  const assessedSuper = pensionSuper + (agePensionAgeReached ? accumulationSuper : 0);
  const gross = financialAssets + lifestyleAssets + investmentProperty + businessAssets + assessedSuper;
  return Math.max(0, gross - securedLiabilities);
}

// Assets-test result: full rate up to the threshold, then reduced by
// the taper for every $1,000 of assessable assets above it.
export function assetsTestResult({ assessableAssets: assets, maxRate, fullPensionThreshold, reductionRatePer1000 }) {
  if (assets <= fullPensionThreshold) return maxRate;
  const excess = assets - fullPensionThreshold;
  const reduction = (excess / 1000) * reductionRatePer1000;
  return Math.max(0, maxRate - reduction);
}

// Deeming: a two-tier rate on total financial assets. Account-based
// pensions are deemed like any other financial asset (grandfathering
// of pre-2015 ABPs is spec 21b) — the caller folds a person's ABP
// balance into `financialAssets` before calling this.
export function deemedIncome({ financialAssets = 0, lowerRate, upperRate, threshold }) {
  if (financialAssets <= threshold) return financialAssets * lowerRate;
  return threshold * lowerRate + (financialAssets - threshold) * upperRate;
}

// Total assessable income for the income test: deemed income on
// financial assets, plus actual income from non-financial sources
// (rent net of expenses, employment income, business income) — the
// caller sums those before calling this; this function only combines
// the deemed figure with whatever "other" total it's handed.
export function assessableIncome({ deemedIncome: deemed = 0, otherIncome = 0 } = {}) {
  return Math.max(0, deemed + otherIncome);
}

// Income-test result: full rate up to the free area, then reduced 50c
// per dollar of income above it (a couple's combined income/free area
// in, then the caller splits the resulting combined result in half).
export function incomeTestResult({ assessableIncome: income, maxRate, freeArea, reductionRate }) {
  if (income <= freeArea) return maxRate;
  const excess = income - freeArea;
  return Math.max(0, maxRate - excess * reductionRate);
}

// Entitlement = the LESSER of the two test results, floored at zero
// (already true of each result individually, but kept explicit here
// since this is the number that reaches household cashflow). The
// binding test is whichever result is lower — reported because it's
// the lever advice actually turns on; a tie is reported as "assets"
// (arbitrary but deterministic — the two tests never differ in kind
// at that point, since both already equal the same entitlement).
export function agePensionEntitlement({ assetsResult, incomeResult }) {
  const bindingTest = assetsResult <= incomeResult ? "assets" : "income";
  return {
    entitlement: Math.max(0, Math.min(assetsResult, incomeResult)),
    bindingTest,
    assetsResult,
    incomeResult,
  };
}

// Full single-person assessment: assets test + income test + the
// lesser-of, in one call. Kept separate from the couple version below
// since a couple's tests run on COMBINED figures and then the result
// is split, not run independently per partner.
export function singleAgePensionAssessment({
  assessableAssets: assets, assessableIncome: income, rates, homeowner = true,
}) {
  const assetsResult = assetsTestResult({
    assessableAssets: assets,
    maxRate: rates.single.rate,
    fullPensionThreshold: homeowner ? rates.single.assetsFullHomeowner : rates.single.assetsFullNonHomeowner,
    reductionRatePer1000: rates.reductionRatePer1000,
  });
  const incomeResult = incomeTestResult({
    assessableIncome: income,
    maxRate: rates.single.rate,
    freeArea: rates.single.incomeFreeArea,
    reductionRate: rates.incomeReductionRate,
  });
  return agePensionEntitlement({ assetsResult, incomeResult });
}

// Full couple assessment: tests run on the household's COMBINED
// assessable assets/income against the couple's combined rate and
// thresholds; the resulting entitlement is split 50/50 between the
// partners (Centrelink's own convention — a couple is assessed as one
// unit, then paid as two).
export function coupleAgePensionAssessment({
  assessableAssets: assets, assessableIncome: income, rates, homeowner = true,
}) {
  const assetsResult = assetsTestResult({
    assessableAssets: assets,
    maxRate: rates.couple.rateCombined,
    fullPensionThreshold: homeowner ? rates.couple.assetsFullHomeowner : rates.couple.assetsFullNonHomeowner,
    reductionRatePer1000: rates.reductionRatePer1000,
  });
  const incomeResult = incomeTestResult({
    assessableIncome: income,
    maxRate: rates.couple.rateCombined,
    freeArea: rates.couple.incomeFreeAreaCombined,
    reductionRate: rates.incomeReductionRate,
  });
  const combined = agePensionEntitlement({ assetsResult, incomeResult });
  return { ...combined, each: combined.entitlement / 2 };
}
