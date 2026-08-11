// engine.js — pure CGT projection engine.
//
// Encodes industry consensus on the 2026 federal-budget reform that replaces
// the 50% CGT discount with cost-base indexation + a 30% minimum tax for
// CGT events on or after 1 July 2027.
//
// Constants live in LEG (frozen). Swap a single field to flip behaviour if
// final legislation differs.

export const LEG = Object.freeze({
  // Effective dates
  newRulesStart: new Date('2027-07-01T00:00:00+10:00'),
  budgetNight: new Date('2026-05-12T19:30:00+10:00'),
  preCgtCutoff: new Date('1985-09-20T00:00:00+10:00'),

  // Rates
  minimumTaxRate: 0.30,
  oldDiscountRate: 0.50,
  superDiscountRate: 1 / 3,
  medicareLevy: 0.02,

  // Medicare levy thresholds for resident individuals (singles, 2025-26).
  // Below lower: no levy.
  // Lower to upper: 10% of excess over lower (shading-in).
  // Above upper: 2% of full taxable income.
  // Family thresholds not modelled — recommend the differencing math
  // produces sensible numbers for couples too.
  medicareLowerSingle: 28011,
  medicareUpperSingle: 35014,
  medicareShadingRate: 0.10,

  // Industry-consensus assumptions — swap if legislation differs
  apportionmentMethod: 'compound_CAGR',
  indexationFrequency: 'annual',
  minimumTaxApplication: 'simple_max',
  stackingOrder: 'pro_rata',

  // Marginal tax brackets [floor, ceiling, rate]
  // Resident individuals, excludes Medicare levy
  brackets: {
    '2025-26': [
      [0, 18200, 0],
      [18200, 45000, 0.16],
      [45000, 135000, 0.30],
      [135000, 190000, 0.37],
      [190000, Infinity, 0.45],
    ],
    '2026-27': [
      [0, 18200, 0],
      [18200, 45000, 0.15],
      [45000, 135000, 0.30],
      [135000, 190000, 0.37],
      [190000, Infinity, 0.45],
    ],
    '2027-28': [
      [0, 18200, 0],
      [18200, 45000, 0.14],
      [45000, 135000, 0.30],
      [135000, 190000, 0.37],
      [190000, Infinity, 0.45],
    ],
  },
  defaultBracketYear: '2027-28',

  buckets: {
    A: 'Asset purchased AND sold before 1 July 2027 — old rules only',
    B: 'Asset purchased before, sold after 1 July 2027 — split treatment',
    C: 'Asset purchased after 1 July 2027 — new rules only',
    D: 'Pre-1985 asset, sold after 1 July 2027 — pre-CGT exempt + new rules',
  },
});

// ---------- date / tax helpers ----------

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;
const MS_PER_DAY = 24 * 3600 * 1000;

function toDate(d) {
  return d instanceof Date ? d : new Date(d);
}

export function yearsBetween(d1, d2) {
  return (toDate(d2).getTime() - toDate(d1).getTime()) / MS_PER_YEAR;
}

// Whole-day count between two dates. Used by the 12-month CGT discount
// eligibility check — yearsBetween divides by 365.25 days, so an asset
// held exactly 12 calendar months (365 days) reads as 0.9993y and would
// fail a `holdingYears >= 1` test. Day count avoids that rounding gap
// and matches the ATO's "at least 12 months" rule (ITAA 1997 s 115-25).
export function holdingDays(d1, d2) {
  return (toDate(d2).getTime() - toDate(d1).getTime()) / MS_PER_DAY;
}

export function fyForDate(d) {
  const date = toDate(d);
  const m = date.getMonth();
  const y = date.getFullYear();
  const start = m >= 6 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

export function marginalTax(income, fy) {
  const brackets = LEG.brackets[fy] || LEG.brackets[LEG.defaultBracketYear];
  let tax = 0;
  for (const [floor, ceiling, rate] of brackets) {
    if (income <= floor) break;
    tax += (Math.min(income, ceiling) - floor) * rate;
  }
  return tax;
}

function marginalOnGain(otherIncome, gain, fy) {
  if (gain <= 0) return 0;
  return marginalTax(otherIncome + gain, fy) - marginalTax(otherIncome, fy);
}

// Medicare levy with proper shading-in.
// Returns the levy that would be payable on a given taxable income.
export function medicareLevy(taxableIncome) {
  if (taxableIncome <= LEG.medicareLowerSingle) return 0;
  if (taxableIncome <= LEG.medicareUpperSingle) {
    return (taxableIncome - LEG.medicareLowerSingle) * LEG.medicareShadingRate;
  }
  return taxableIncome * LEG.medicareLevy;
}

// Medicare attributable to the additional taxable amount (gain).
// Calculated by differencing: levy on (other + gain) minus levy on other alone.
// This handles shading-in correctly — clients well above the threshold see
// roughly 2% × gain, clients below see less.
function medicareOnGain(otherIncome, taxableGain) {
  if (taxableGain <= 0) return 0;
  return medicareLevy(otherIncome + taxableGain) - medicareLevy(otherIncome);
}

export function determineBucket(purchaseDate, saleDate, isPreCgt = null) {
  const start = LEG.newRulesStart;
  const sale = toDate(saleDate);
  const purchase = purchaseDate ? toDate(purchaseDate) : null;

  // Auto-detect pre-CGT from date if not explicitly set
  const effectivePreCgt =
    isPreCgt != null ? isPreCgt : purchase && purchase < LEG.preCgtCutoff;

  if (effectivePreCgt) {
    // Pre-CGT and sale before 2027: still exempt (treat as 'A' — no tax)
    return sale < start ? 'A' : 'D';
  }
  if (sale < start) return 'A';
  if (purchase && purchase >= start) return 'C';
  return 'B';
}

// ---------- core regime calculations ----------

function applyOld({ nominalGain, holdingYears, holdingDays: heldDays, otherIncome, fy }) {
  if (nominalGain <= 0) {
    return { taxableGain: 0, taxOnGain: 0 };
  }
  // Day count is the authoritative threshold (>= 365 days = at least 12
  // calendar months per ITAA 1997 s 115-25). Mode 1 callers don't have
  // dates and pass holdingYears only; whole-year inputs there don't hit
  // the 365.25-day rounding gap.
  const eligible = heldDays != null
    ? heldDays >= 365
    : holdingYears >= 1;
  const taxableGain =
    eligible ? nominalGain * LEG.oldDiscountRate : nominalGain;
  const mt = marginalOnGain(otherIncome, taxableGain, fy);
  const medicare = medicareOnGain(otherIncome, taxableGain);
  return { taxableGain, taxOnGain: mt + medicare };
}

function applyNew({
  salePrice,
  costBase,
  holdingYears,
  inflation,
  otherIncome,
  incomeSupport,
  fy,
}) {
  const indexationFactor = Math.pow(1 + inflation, holdingYears);
  const indexedCostBase = costBase * indexationFactor;
  let realGain = salePrice - indexedCostBase;
  if (realGain < 0) realGain = 0;
  if (realGain === 0) {
    return {
      taxableGain: 0,
      taxOnGain: 0,
      indexedCostBase,
      indexationFactor,
      minTaxApplied: false,
    };
  }
  const mt = marginalOnGain(otherIncome, realGain, fy);
  const minTax = realGain * LEG.minimumTaxRate;
  const exclMedicare = incomeSupport ? mt : Math.max(mt, minTax);
  const medicare = medicareOnGain(otherIncome, realGain);
  const minTaxApplied = !incomeSupport && minTax > mt;
  return {
    taxableGain: realGain,
    taxOnGain: exclMedicare + medicare,
    indexedCostBase,
    indexationFactor,
    minTaxApplied,
  };
}

// ---------- cost base assembly ----------

// Build cost base from inputs, honoring asset type. For investment property,
// capital works deductions claimed reduce the cost base per Division 43.
function buildCostBase(inputs) {
  const {
    purchase_price = 0,
    acquisition_costs = 0,
    capital_improvements = 0,
    depreciation_claimed = 0,
    value_2027 = 0,
    asset_type = 'shares',
    is_pre_cgt = false,
  } = inputs;
  // Capital improvements + capital-works depreciation only apply to property.
  // Force zero for non-property so stale form/URL state can't leak through.
  const improvements = asset_type === 'property' ? (capital_improvements || 0) : 0;
  const dep = asset_type === 'property' ? (depreciation_claimed || 0) : 0;
  if (is_pre_cgt) {
    // Pre-CGT scenarios use the 1 Jul 2027 market value as the deemed cost
    // base. Property improvements/depreciation in the post-2027 window
    // adjust the deemed base — pre-1985 history is already reflected in
    // value_2027 so original purchase price and acquisition costs aren't
    // part of the cost base.
    return (value_2027 || 0) + improvements - dep;
  }
  return purchase_price + acquisition_costs + improvements - dep;
}

// Market value of the asset at purchase, used as the growth basis for
// projecting sale prices and the 1 Jul 2027 value. Distinct from cost base:
// depreciation reduces the tax cost base but does NOT reduce market value
// (a property that has been depreciated is still worth what the market
// pays for it). Improvements are treated as if made at purchase — a
// documented simplification.
export function buildAssetValueAtPurchase(inputs) {
  const {
    purchase_price = 0,
    capital_improvements = 0,
    asset_type = 'shares',
  } = inputs;
  const improvements = asset_type === 'property' ? (capital_improvements || 0) : 0;
  return (purchase_price || 0) + improvements;
}

// Sale price projection. Pre-CGT scenarios extrapolate from value_2027
// forward over the post-commencement years; everything else grows from
// market value at purchase. Cost base is intentionally NOT the growth
// basis — see buildAssetValueAtPurchase.
export function derivedSalePrice(inputs, saleDate) {
  const isPreCgt =
    inputs.is_pre_cgt != null
      ? inputs.is_pre_cgt
      : (inputs.purchase_date && toDate(inputs.purchase_date) < LEG.preCgtCutoff);
  const returnRate = inputs.return_rate || 0;
  const sd = saleDate instanceof Date ? saleDate : toDate(saleDate);
  if (isPreCgt) {
    // Pre-CGT: extrapolate from the 1 Jul 2027 market value along the same
    // growth curve in both directions. Pre-2027 sales reverse-CAGR back
    // from value_2027 (negative exponent), so the chart shows a smoothly
    // growing curve rather than flatlining at value_2027 before 2027.
    //
    // Capital improvements on a pre-CGT property are post-2027 events by
    // definition, so they only feed the growth basis for sale dates at or
    // after the cutoff.
    const yearsRelative = yearsBetween(LEG.newRulesStart, sd);
    const v2027 = inputs.value_2027 || 0;
    const improvements =
      yearsRelative > 0 && inputs.asset_type === 'property'
        ? (inputs.capital_improvements || 0)
        : 0;
    return (v2027 + improvements) * Math.pow(1 + returnRate, yearsRelative);
  }
  const pd = toDate(inputs.purchase_date);
  const yearsHeld = Math.max(yearsBetween(pd, sd), 0);
  return buildAssetValueAtPurchase(inputs) * Math.pow(1 + returnRate, yearsHeld);
}

// ---------- result builders ----------

function makeRegimeResult(salePrice, costBasePaid, regime) {
  const nominalGain = salePrice - costBasePaid;
  return {
    taxableGain: regime.taxableGain,
    taxOnGain: regime.taxOnGain,
    afterTaxProceeds: salePrice - regime.taxOnGain,
    effectiveRate: nominalGain > 0 ? regime.taxOnGain / nominalGain : 0,
    indexedCostBase: regime.indexedCostBase,
    indexationFactor: regime.indexationFactor,
    minTaxApplied: regime.minTaxApplied || false,
  };
}

function getDiagnostics(extras = {}) {
  return {
    apportionmentMethod: LEG.apportionmentMethod,
    indexationFrequency: LEG.indexationFrequency,
    minimumTaxApplication: LEG.minimumTaxApplication,
    stackingOrder: LEG.stackingOrder,
    medicareLevyAssumption: 'shading_in_singles_2025_26',
    inflationAssumption: 'user_specified',
    capitalLossesHandled: false,
    costBaseElementsIndexed: 'all',
    legislationStatus: 'announced_not_legislated',
    ...extras,
  };
}

// ---------- Mode 1: old vs new (abstract) ----------

function runOldVsNew(inputs) {
  const {
    purchase_price,
    return_rate,
    inflation,
    holding_years,
    other_income,
    income_support_recipient = false,
  } = inputs;

  const costBase = purchase_price;
  const salePrice = purchase_price * Math.pow(1 + return_rate, holding_years);
  const fy = LEG.defaultBracketYear;

  const nominalGain = salePrice - costBase;
  if (nominalGain <= 0) {
    return capitalLossResult({
      mode: 'old_vs_new',
      bucket: 'C',
      salePrice,
      costBase,
      holdingYears: holding_years,
      inflation,
    });
  }

  const old = applyOld({
    nominalGain,
    holdingYears: holding_years,
    otherIncome: other_income,
    fy,
  });
  const nw = applyNew({
    salePrice,
    costBase,
    holdingYears: holding_years,
    inflation,
    otherIncome: other_income,
    incomeSupport: income_support_recipient,
    fy,
  });

  const oldRules = makeRegimeResult(salePrice, costBase, old);
  const newRules = makeRegimeResult(salePrice, costBase, nw);

  return {
    mode: 'old_vs_new',
    bucket: 'C',
    inputs,
    salePrice,
    costBase,
    nominalGain,
    holdingYears: holding_years,
    oldRules,
    newRules,
    split: null,
    actual: newRules,
    headline: buildHeadlineMode1({
      returnRate: return_rate,
      inflation,
      holdingYears: holding_years,
      oldTax: old.taxOnGain,
      newTax: nw.taxOnGain,
      minTaxApplied: nw.minTaxApplied,
      otherIncome: other_income,
      realGain: nw.taxableGain,
      fy,
    }),
    diagnostics: getDiagnostics(),
  };
}

function capitalLossResult(base) {
  return {
    ...base,
    inputs: base.inputs || {},
    nominalGain: base.salePrice - base.costBase,
    oldRules: { taxableGain: 0, taxOnGain: 0, afterTaxProceeds: base.salePrice, effectiveRate: 0 },
    newRules: { taxableGain: 0, taxOnGain: 0, afterTaxProceeds: base.salePrice, effectiveRate: 0, minTaxApplied: false },
    split: null,
    actual: { taxOnGain: 0, afterTaxProceeds: base.salePrice, taxableGain: 0, effectiveRate: 0, minTaxApplied: false },
    result: 'capital_loss',
    headline:
      'This is a capital loss scenario. The tool models gains only. Losses carry forward against future gains under both regimes.',
    diagnostics: getDiagnostics({ capitalLossesHandled: false, scenarioIsLoss: true }),
  };
}

// ---------- Mode 2: specific asset ----------

function runSpecific(inputs) {
  const {
    purchase_date,
    sale_date,
    sale_price,
    sale_costs = 0,
    inflation = 0,
    other_income,
    income_support_recipient = false,
    value_2027: userValue2027,
  } = inputs;

  const purchaseDate = purchase_date ? toDate(purchase_date) : null;
  const saleDate = toDate(sale_date);

  // Auto-detect pre-CGT from purchase date if not explicitly set
  const isPreCgt =
    inputs.is_pre_cgt != null
      ? inputs.is_pre_cgt
      : purchaseDate && purchaseDate < LEG.preCgtCutoff;

  const costBase = isPreCgt ? 0 : buildCostBase(inputs);
  // Net sale proceeds (after sale costs) feed the gain calculation
  const netSale = sale_price - sale_costs;
  const fy = fyForDate(saleDate);
  const bucket = determineBucket(purchaseDate, saleDate, isPreCgt);

  const totalYears = purchaseDate
    ? Math.max(yearsBetween(purchaseDate, saleDate), 0)
    : 0;

  // Pre-CGT asset sold before 1 July 2027 — exempt under existing law and
  // the new rules haven't commenced. Zero tax under both regimes.
  if (isPreCgt && saleDate < LEG.newRulesStart) {
    return {
      mode: 'specific',
      bucket: 'A',
      inputs,
      salePrice: netSale,
      costBase: 0,
      nominalGain: 0,
      holdingYears: totalYears,
      purchaseDate,
      saleDate,
      oldRules: { taxableGain: 0, taxOnGain: 0, afterTaxProceeds: netSale, effectiveRate: 0 },
      newRules: { taxableGain: 0, taxOnGain: 0, afterTaxProceeds: netSale, effectiveRate: 0, minTaxApplied: false },
      split: null,
      actual: { taxableGain: 0, taxOnGain: 0, afterTaxProceeds: netSale, effectiveRate: 0, minTaxApplied: false },
      headline: `Selling this pre-1985 asset in ${saleDate.getFullYear()} is exempt under existing CGT law — no tax under either regime.`,
      diagnostics: getDiagnostics({ preCgtExempt: true }),
    };
  }

  if (bucket === 'A') {
    return runBucketA({
      inputs,
      costBase,
      salePrice: netSale,
      grossSalePrice: sale_price,
      totalYears,
      inflation,
      otherIncome: other_income,
      incomeSupport: income_support_recipient,
      fy,
      purchaseDate,
      saleDate,
    });
  }
  if (bucket === 'C') {
    return runBucketC({
      inputs,
      costBase,
      salePrice: netSale,
      grossSalePrice: sale_price,
      totalYears,
      inflation,
      otherIncome: other_income,
      incomeSupport: income_support_recipient,
      fy,
      purchaseDate,
      saleDate,
    });
  }
  if (bucket === 'D') {
    return runBucketD({
      inputs,
      salePrice: netSale,
      grossSalePrice: sale_price,
      value2027: userValue2027,
      saleDate,
      inflation,
      otherIncome: other_income,
      incomeSupport: income_support_recipient,
      fy,
      purchaseDate,
    });
  }
  // bucket B
  return runBucketB({
    inputs,
    costBase,
    salePrice: netSale,
    grossSalePrice: sale_price,
    purchaseDate,
    saleDate,
    totalYears,
    inflation,
    otherIncome: other_income,
    incomeSupport: income_support_recipient,
    fy,
    userValue2027,
  });
}

function runBucketA(args) {
  const {
    inputs,
    costBase,
    salePrice,
    totalYears,
    inflation,
    otherIncome,
    incomeSupport,
    fy,
    purchaseDate,
    saleDate,
  } = args;

  const nominalGain = salePrice - costBase;
  if (nominalGain <= 0) {
    return capitalLossResult({
      mode: 'specific',
      bucket: 'A',
      inputs,
      salePrice,
      costBase,
      holdingYears: totalYears,
      inflation,
    });
  }
  const old = applyOld({
    nominalGain,
    holdingYears: totalYears,
    holdingDays: holdingDays(purchaseDate, saleDate),
    otherIncome,
    fy,
  });
  const nw = applyNew({
    salePrice,
    costBase,
    holdingYears: totalYears,
    inflation,
    otherIncome,
    incomeSupport,
    fy,
  });
  const oldRules = makeRegimeResult(salePrice, costBase, old);
  const newRules = makeRegimeResult(salePrice, costBase, nw);

  return {
    mode: 'specific',
    bucket: 'A',
    inputs,
    salePrice,
    costBase,
    nominalGain,
    holdingYears: totalYears,
    purchaseDate,
    saleDate,
    oldRules,
    newRules,
    split: null,
    actual: oldRules,
    headline: buildHeadlineBucketA({
      saleDate,
      afterTax: oldRules.afterTaxProceeds,
    }),
    diagnostics: getDiagnostics(),
  };
}

function runBucketC(args) {
  const {
    inputs,
    costBase,
    salePrice,
    totalYears,
    inflation,
    otherIncome,
    incomeSupport,
    fy,
    purchaseDate,
    saleDate,
  } = args;

  const nominalGain = salePrice - costBase;
  if (nominalGain <= 0) {
    return capitalLossResult({
      mode: 'specific',
      bucket: 'C',
      inputs,
      salePrice,
      costBase,
      holdingYears: totalYears,
      inflation,
    });
  }
  const old = applyOld({
    nominalGain,
    holdingYears: totalYears,
    holdingDays: holdingDays(purchaseDate, saleDate),
    otherIncome,
    fy,
  });
  const nw = applyNew({
    salePrice,
    costBase,
    holdingYears: totalYears,
    inflation,
    otherIncome,
    incomeSupport,
    fy,
  });
  const oldRules = makeRegimeResult(salePrice, costBase, old);
  const newRules = makeRegimeResult(salePrice, costBase, nw);

  return {
    mode: 'specific',
    bucket: 'C',
    inputs,
    salePrice,
    costBase,
    nominalGain,
    holdingYears: totalYears,
    purchaseDate,
    saleDate,
    oldRules,
    newRules,
    split: null,
    actual: newRules,
    headline: buildHeadlineBucketC({
      saleDate,
      afterTax: newRules.afterTaxProceeds,
      indexedCb: newRules.indexedCostBase,
      realGain: newRules.taxableGain,
      effectiveRate: newRules.effectiveRate,
    }),
    diagnostics: getDiagnostics(),
  };
}

function runBucketB(args) {
  const {
    inputs,
    costBase,
    salePrice,
    purchaseDate,
    saleDate,
    totalYears,
    inflation,
    otherIncome,
    incomeSupport,
    fy,
  } = args;

  const yearsToCutoff = Math.max(yearsBetween(purchaseDate, LEG.newRulesStart), 0);
  const yearsPost = Math.max(totalYears - yearsToCutoff, 0);

  // value_2027 always derives from the CAGR between purchase and sale —
  // the manual override toggle has been removed. For pre-CGT (Bucket D)
  // scenarios the user-entered value_2027 is consumed directly by
  // runBucketD; for Bucket B the projection-derived value is correct
  // because both salePrice and value_2027 grow off the same market-value
  // curve.
  let value2027;
  {
    // CAGR derived from MARKET VALUE at purchase, not cost base. Depreciation
    // reduces cost base but not the underlying asset value, so using cost
    // base here understates value_2027 for depreciated property.
    const avap = buildAssetValueAtPurchase(inputs);
    const cagr =
      totalYears > 0 && avap > 0
        ? Math.pow(salePrice / avap, 1 / totalYears) - 1
        : 0;
    value2027 = avap * Math.pow(1 + cagr, yearsToCutoff);
  }

  // Pre-2027 portion: 50% discount (total holding > 12 months assumed for split)
  const preGain = Math.max(value2027 - costBase, 0);
  const prePortionTaxable = preGain * LEG.oldDiscountRate;

  // Post-2027 portion: indexation + min tax
  const postIndexationFactor = Math.pow(1 + inflation, yearsPost);
  const indexedValue2027 = value2027 * postIndexationFactor;
  let postPortionTaxable = salePrice - indexedValue2027;
  if (postPortionTaxable < 0) postPortionTaxable = 0;

  const totalTaxable = prePortionTaxable + postPortionTaxable;

  // Stacking via pro-rata
  let taxPre = 0;
  let taxPost = 0;
  let minTaxApplied = false;
  if (totalTaxable > 0) {
    const mtTotal = marginalOnGain(otherIncome, totalTaxable, fy);
    const preShare = prePortionTaxable / totalTaxable;
    const postShare = postPortionTaxable / totalTaxable;
    const mtPre = mtTotal * preShare;
    const mtPost = mtTotal * postShare;

    const minTaxOnPost = postPortionTaxable * LEG.minimumTaxRate;
    taxPre = mtPre;
    if (incomeSupport) {
      taxPost = mtPost;
    } else {
      taxPost = Math.max(mtPost, minTaxOnPost);
      minTaxApplied = minTaxOnPost > mtPost;
    }
  }
  const medicare = medicareOnGain(otherIncome, totalTaxable);
  const totalTax = taxPre + taxPost + medicare;
  const afterTax = salePrice - totalTax;

  // Counterfactuals (full gain under each regime)
  const nominalGain = salePrice - costBase;
  const oldCf = applyOld({
    nominalGain,
    holdingYears: totalYears,
    holdingDays: holdingDays(purchaseDate, saleDate),
    otherIncome,
    fy,
  });
  const newCf = applyNew({
    salePrice,
    costBase,
    holdingYears: totalYears,
    inflation,
    otherIncome,
    incomeSupport,
    fy,
  });
  const oldRules = makeRegimeResult(salePrice, costBase, oldCf);
  const newRules = makeRegimeResult(salePrice, costBase, newCf);

  const actual = {
    taxableGain: totalTaxable,
    taxOnGain: totalTax,
    afterTaxProceeds: afterTax,
    effectiveRate: nominalGain > 0 ? totalTax / nominalGain : 0,
    minTaxApplied,
  };

  const diff = afterTax - oldRules.afterTaxProceeds;
  return {
    mode: 'specific',
    bucket: 'B',
    inputs,
    salePrice,
    costBase,
    nominalGain,
    holdingYears: totalYears,
    purchaseDate,
    saleDate,
    oldRules,
    newRules,
    split: {
      value2027,
      yearsToCutoff,
      yearsPost,
      preGain,
      prePortionTaxable,
      postGain: postPortionTaxable,
      postPortionTaxable,
      indexedValue2027,
      taxPre,
      taxPost,
      medicare,
      totalTaxable,
      totalTax,
      minTaxApplied,
    },
    actual,
    headline: buildHeadlineBucketB({
      saleDate,
      afterTax,
      totalGain: nominalGain,
      preGain,
      postGainRaw: Math.max(0, salePrice - value2027),
      postPortionTaxable,
      diff,
      afterTaxOld: oldRules.afterTaxProceeds,
    }),
    diagnostics: getDiagnostics(),
  };
}

function runBucketD(args) {
  const {
    inputs,
    salePrice,
    value2027,
    saleDate,
    inflation,
    otherIncome,
    incomeSupport,
    fy,
    purchaseDate,
  } = args;

  if (value2027 == null || value2027 <= 0) {
    // Soft state: tell the UI we need a valuation; don't throw.
    return {
      mode: 'specific',
      bucket: 'D',
      inputs,
      salePrice,
      costBase: 0,
      nominalGain: salePrice,
      holdingYears: 0,
      purchaseDate,
      saleDate,
      oldRules: { taxableGain: 0, taxOnGain: 0, afterTaxProceeds: salePrice, effectiveRate: 0 },
      newRules: { taxableGain: 0, taxOnGain: 0, afterTaxProceeds: salePrice, effectiveRate: 0, minTaxApplied: false },
      split: null,
      actual: { taxOnGain: 0, afterTaxProceeds: salePrice, taxableGain: 0, effectiveRate: 0, minTaxApplied: false },
      result: 'awaiting_value_2027',
      headline: '',
      diagnostics: getDiagnostics({ awaitingValue2027: true }),
    };
  }

  const yearsPost = Math.max(yearsBetween(LEG.newRulesStart, saleDate), 0);

  // Post-2027 events affect the deemed cost base for pre-CGT property:
  // capital improvements add, capital-works deductions subtract. Same
  // treatment as Bucket B/C, just operating over the post-2027 window.
  const propertyImprovements =
    inputs?.asset_type === 'property' ? (inputs.capital_improvements || 0) : 0;
  const propertyDepreciation =
    inputs?.asset_type === 'property' ? (inputs.depreciation_claimed || 0) : 0;
  const effectiveCostBase = value2027 + propertyImprovements - propertyDepreciation;

  const nw = applyNew({
    salePrice,
    costBase: effectiveCostBase,
    holdingYears: yearsPost,
    inflation,
    otherIncome,
    incomeSupport,
    fy,
  });

  // For Bucket D, "newRules" represents the actual post-2027 calculation,
  // since the pre-2027 portion is exempt.
  const newRules = makeRegimeResult(salePrice, effectiveCostBase, nw);
  // No meaningful old-rules counterfactual: pre-1985 assets were exempt under
  // the old regime too. Show zero-tax to make that visible.
  const oldRules = {
    taxableGain: 0,
    taxOnGain: 0,
    afterTaxProceeds: salePrice,
    effectiveRate: 0,
  };

  const postGain = nw.taxableGain;
  const actual = {
    taxableGain: postGain,
    taxOnGain: nw.taxOnGain,
    afterTaxProceeds: salePrice - nw.taxOnGain,
    effectiveRate: postGain > 0 ? nw.taxOnGain / postGain : 0,
    minTaxApplied: nw.minTaxApplied,
  };

  return {
    mode: 'specific',
    bucket: 'D',
    inputs,
    salePrice,
    costBase: effectiveCostBase,
    nominalGain: Math.max(0, salePrice - effectiveCostBase),
    holdingYears: yearsPost,
    purchaseDate,
    saleDate,
    oldRules,
    newRules,
    split: {
      value2027,
      yearsToCutoff: null,
      yearsPost,
      preGain: 0,
      prePortionTaxable: 0,
      postGain,
      postPortionTaxable: postGain,
      indexedValue2027: nw.indexedCostBase,
      taxPre: 0,
      taxPost: nw.taxOnGain,
      medicare: medicareOnGain(otherIncome, postGain),
      totalTaxable: postGain,
      totalTax: nw.taxOnGain,
      minTaxApplied: nw.minTaxApplied,
    },
    actual,
    headline: buildHeadlineBucketD({
      saleDate,
      afterTax: actual.afterTaxProceeds,
      postGain,
    }),
    diagnostics: getDiagnostics(),
  };
}

// ---------- public entry points ----------

// ---------- input validation limits ----------
// Defensive clamps to prevent unrealistic values from producing meaningless
// output. The UI also enforces these on every numeric field; engine-level
// clamping is belt-and-braces for stale URL state or programmatic callers.
export const INPUT_LIMITS = Object.freeze({
  purchase_price:        { min: 1,    max: 100_000_000 },
  acquisition_costs:     { min: 0,    max:  10_000_000 },
  capital_improvements:  { min: 0,    max:  10_000_000 },
  depreciation_claimed:  { min: 0,    max:  10_000_000 },
  sale_costs:            { min: 0,    max:  10_000_000 },
  value_2027:            { min: 0,    max: 100_000_000 },
  return_rate:           { min: 0,    max: 0.25 },
  inflation:             { min: 0,    max: 0.10 },
  other_income:          { min: 0,    max:   5_000_000 },
});

const clamp = (v, lo, hi) => {
  if (v == null || !Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
};

function clampInputs(inputs) {
  const out = { ...inputs };
  for (const [key, { min, max }] of Object.entries(INPUT_LIMITS)) {
    if (out[key] != null) out[key] = clamp(Number(out[key]), min, max);
  }
  return out;
}

export function runCGTProjection(inputs) {
  // Defensive date validation: a malformed date string in inputs would
  // propagate as NaN through every downstream calculation and crash the
  // chart layer. Return a structured error instead so the UI can show a
  // graceful message.
  if (inputs?.purchase_date != null) {
    const pd = new Date(inputs.purchase_date);
    if (isNaN(pd.getTime())) {
      return { error: 'Invalid purchase date', bucket: null };
    }
  }
  if (inputs?.sale_date != null) {
    const sd = new Date(inputs.sale_date);
    if (isNaN(sd.getTime())) {
      return { error: 'Invalid sale date', bucket: null };
    }
  }
  const safe = clampInputs(inputs);
  if (safe.mode === 'old_vs_new') return runOldVsNew(safe);
  return runSpecific(safe);
}

export function runCGTSeries(baseInputs, axisVar, range) {
  const [min, max] = range;
  const results = [];
  if (axisVar === 'holding_years') {
    for (let y = min; y <= max; y++) {
      results.push(runCGTProjection({ ...baseInputs, holding_years: y }));
    }
  } else if (axisVar === 'sale_year') {
    for (let y = min; y <= max; y++) {
      const saleDate = new Date(`${y}-06-30T00:00:00+10:00`);
      const purchaseDate = toDate(baseInputs.purchase_date);
      const years = Math.max(yearsBetween(purchaseDate, saleDate), 0);
      const growth = baseInputs.growth_rate ?? 0.06;
      const avap = buildAssetValueAtPurchase(baseInputs);
      const derivedSalePrice =
        baseInputs.sale_price_derive === false
          ? baseInputs.sale_price
          : (baseInputs.is_pre_cgt ||
            (purchaseDate && purchaseDate < LEG.preCgtCutoff)
              ? (baseInputs.value_2027 || 0) *
                Math.pow(
                  1 + growth,
                  Math.max(yearsBetween(LEG.newRulesStart, saleDate), 0)
                )
              : avap * Math.pow(1 + growth, years));
      results.push(
        runCGTProjection({
          ...baseInputs,
          sale_date: saleDate.toISOString().slice(0, 10),
          sale_price: derivedSalePrice,
        })
      );
    }
  }
  return results;
}

// ---------- headline builders ----------

function fmtAUD(v) {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    maximumFractionDigits: 0,
  }).format(Math.round(v));
}

function fmtPct(v, dp = 1) {
  return `${(v * 100).toFixed(dp)}%`;
}

function buildHeadlineMode1({
  returnRate,
  inflation,
  holdingYears,
  oldTax,
  newTax,
  minTaxApplied,
  otherIncome,
  realGain,
  fy,
}) {
  const diff = newTax - oldTax;
  const pct = oldTax > 0 ? Math.abs(diff) / oldTax : 0;
  const ret = fmtPct(returnRate);
  const inf = fmtPct(inflation);
  let base;
  if (pct < 0.02) {
    base = `At ${ret} return and ${inf} inflation over ${holdingYears} years, the old and new rules produce broadly the same outcome.`;
  } else if (diff > 0) {
    base = `At ${ret} return and ${inf} inflation over ${holdingYears} years, the new rules tax this asset ${fmtAUD(diff)} more than the old 50% discount.`;
  } else {
    base = `At ${ret} return and ${inf} inflation over ${holdingYears} years, the new rules save ${fmtAUD(-diff)} compared to the old 50% discount.`;
  }
  if (minTaxApplied && realGain > 0) {
    const mtMarg = marginalOnGain(otherIncome, realGain, fy);
    const minTax = realGain * LEG.minimumTaxRate;
    const topUp = Math.max(minTax - mtMarg, 0);
    if (topUp > 0) {
      base += ` The 30% minimum tax adds ${fmtAUD(topUp)} on top of the marginal rate.`;
    }
  }
  return base;
}

function buildHeadlineBucketA({ saleDate, afterTax }) {
  const y = toDate(saleDate).getFullYear();
  return `Selling this asset in ${y} produces ${fmtAUD(afterTax)} after tax under the current 50% discount rules.`;
}

function buildHeadlineBucketB({ saleDate, afterTax, totalGain, preGain, postGainRaw, postPortionTaxable, diff, afterTaxOld }) {
  const y = toDate(saleDate).getFullYear();
  const moreOrLess = diff >= 0 ? 'more' : 'less';
  return `Selling in ${y} produces ${fmtAUD(afterTax)} after tax. Of the ${fmtAUD(totalGain)} total gain: ${fmtAUD(preGain)} accrued before 1 July 2027 (50% discount applies). ${fmtAUD(postGainRaw)} accrued after — after indexation, ${fmtAUD(postPortionTaxable)} is taxable under the new rules (marginal rate, 30% minimum). That's ${fmtAUD(Math.abs(diff))} ${moreOrLess} than the ${fmtAUD(afterTaxOld)} you'd receive if the old rules applied to the whole gain.`;
}

function buildHeadlineBucketC({ saleDate, afterTax, indexedCb, realGain, effectiveRate }) {
  const y = toDate(saleDate).getFullYear();
  return `Selling in ${y} produces ${fmtAUD(afterTax)} after tax. The indexed cost base of ${fmtAUD(indexedCb)} leaves a real gain of ${fmtAUD(realGain)}, taxed at ${fmtPct(effectiveRate)}.`;
}

function buildHeadlineBucketD({ saleDate, afterTax, postGain }) {
  const y = toDate(saleDate).getFullYear();
  return `Selling in ${y} produces ${fmtAUD(afterTax)} after tax. The ${fmtAUD(postGain)} gain accruing from 1 July 2027 is taxed under indexation + 30% min; gains before that date remain exempt.`;
}
