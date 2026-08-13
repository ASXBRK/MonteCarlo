// Composite output series (D5) — pure, no DOM/Plotly. Derives the
// composite chart's series from the engine's yearly ledger, honouring
// the DISPLAY-LEVEL asset-class chart treatment (Exclude | Include |
// Include Separately). Every value here is a direct field or a plain
// sum of fields already on projectPlan()'s yearly rows — this module
// never recomputes engine numbers, so table values (which read the
// ledger directly, untouched by chartTreatment) stay byte-identical
// regardless of what the chart is set to show.

// Total expenditure including tax: household expenses (already
// including deductible/non-deductible property expenses) + tax +
// every loan's interest and principal that FY.
export function compositeExpenditure(row) {
  const loanService = Object.values(row.liabilities ?? {})
    .reduce((s, l) => s + l.interest + l.principal, 0);
  return row.expenses + row.tax + loanService;
}

// Capital drawdown: funded withdrawals + deficit-funding draws.
export function compositeDrawdown(row) {
  return row.withdrawals + row.deficitFundedFromAssets;
}

export function compositeIncome(row) {
  return row.income;
}

function lifestyleValue(row, assets) {
  return assets
    .filter((a) => a.class === "lifestyle")
    .reduce((s, a) => s + (row.perAssetClosing[a.id] ?? 0), 0);
}
function pprValue(row, properties) {
  return properties
    .filter((p) => p.propertyType === "ppr")
    .reduce((s, p) => s + (row.properties?.[p.id]?.value ?? 0), 0);
}
function otherPropertyValue(row, properties) {
  return properties
    .filter((p) => p.propertyType !== "ppr")
    .reduce((s, p) => s + (row.properties?.[p.id]?.value ?? 0), 0);
}

// compositeSeries(yearly, assets, properties, treatment) →
//   { netAssetsArea[y], separateArea[y], expenditure[y], income[y], drawdown[y] }
//
// netAssetsArea starts from the engine's own row.netAssets (assets +
// property − liabilities) and adjusts only for classes this
// treatment excludes or splits out; separateArea collects whatever
// was split out (Lifestyle and/or PPR property, by default). There is
// no separate area for Liabilities — "separate" behaves like
// "include" for that class, since a liability isn't a stackable asset
// value in this chart.
export function compositeSeries(yearly, assets, properties, treatment) {
  const netAssetsArea = [];
  const separateArea = [];
  const expenditure = [];
  const income = [];
  const drawdown = [];

  for (const row of yearly) {
    const lifestyle = lifestyleValue(row, assets);
    const ppr = pprValue(row, properties);
    const otherProp = otherPropertyValue(row, properties);

    let net = row.netAssets;
    let sep = 0;
    const apply = (value, mode) => {
      if (mode === "exclude") net -= value;
      else if (mode === "separate") { net -= value; sep += value; }
    };
    apply(lifestyle, treatment.lifestyle);
    apply(ppr, treatment.pprProperty);
    apply(otherProp, treatment.otherProperty);
    if (treatment.liabilities === "exclude") net += (row.liabilitiesClosing ?? 0);

    netAssetsArea.push(net);
    separateArea.push(sep);
    expenditure.push(compositeExpenditure(row));
    income.push(compositeIncome(row));
    drawdown.push(compositeDrawdown(row));
  }
  return { netAssetsArea, separateArea, expenditure, income, drawdown };
}

// --- shared-zero dual-axis maths (composite chart fixes) --------------------
//
// Plotly draws each axis's own [min, max] independently, so a left
// axis that autoranges and a right axis pinned to rangemode:"tozero"
// generally put y=0 at two different heights — a naive read makes the
// two series look like they cross when they don't. sharedZeroRanges
// computes explicit ranges for both axes so zero sits at the same
// vertical fraction on each.

function bounds(values) {
  const withZero = [0, ...values];
  const min = Math.min(...withZero);
  const max = Math.max(...withZero);
  const span = max - min;
  const pad = span > 0 ? span * 0.05 : 1; // degenerate (all-zero) series still get a visible range
  return [min - pad, max + pad];
}

// Fraction of the axis height at which zero sits, given a padded
// [min, max] range that already contains 0.
function zeroFractionOf([min, max]) {
  return -min / (max - min);
}

// Rescale [min, max] (which already contains 0) so zero sits at
// fraction f, expanding whichever side is needed — the original
// padded bounds are never shrunk.
function rescaleToFraction([min, max], f) {
  const below = -min;
  const above = max;
  const belowNeeded = (above * f) / (1 - f);
  if (belowNeeded >= below) return [-belowNeeded, above];
  const aboveNeeded = (below * (1 - f)) / f;
  return [-below, aboveNeeded];
}

// sharedZeroRanges(leftValues, rightValues, pad) →
//   { leftRange: [min, max], rightRange: [min, max], zeroFraction }
//
// Both ranges include 0 by construction (bounds() prepends it), each
// padded by ~5%. zeroFraction is taken from the LEFT axis (the assets
// axis, which is never all-zero in practice) and clamped away from
// the plot edges so zero never lands exactly on a border; the right
// axis is then rescaled to place its own zero at that same fraction.
export function sharedZeroRanges(leftValues, rightValues) {
  const leftRange = bounds(leftValues);
  const rightRangeRaw = bounds(rightValues);
  const f = Math.min(0.95, Math.max(0.05, zeroFractionOf(leftRange)));
  const rightRange = rescaleToFraction(rightRangeRaw, f);
  return { leftRange, rightRange, zeroFraction: f };
}

// A series that is (numerically) zero across every displayed point —
// omit its trace entirely rather than show an empty legend entry and
// bar slot.
export function seriesIsAllZero(values, threshold = 0.005) {
  return values.every((v) => Math.abs(v) < threshold);
}
