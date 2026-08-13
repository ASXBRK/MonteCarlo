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
