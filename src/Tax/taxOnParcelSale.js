// Per-parcel CGT wrapper around the vendored engine.
// One call per FIFO parcel drawn down in a sale event.

import { runCGTProjection } from './engine.js';

export function taxOnParcelSale({ parcel, saleDate, salePrice, scenario }) {
  const result = runCGTProjection({
    mode: 'specific',
    asset_type: scenario.assetType || 'shares',   // 'shares' | 'property' | 'crypto' | 'other'
    purchase_date: parcel.purchaseDate,           // ISO 'YYYY-MM-DD'
    sale_date:     saleDate,                      // ISO 'YYYY-MM-DD'
    purchase_price: parcel.costBase,
    sale_price:     salePrice,
    inflation:      scenario.inflation ?? 0.025,  // annual, drives indexation post-2027
    other_income:   scenario.otherIncome ?? 0,    // drives marginal rate + Medicare shading
    income_support_recipient: scenario.onIncomeSupport ?? false,
    // Property-only fields — leave zero for shares/crypto/other:
    acquisition_costs:     0,
    capital_improvements:  0,
    depreciation_claimed:  0,
    sale_costs:            0,
  });
  return {
    tax:            result.actual.taxOnGain,
    afterTaxCash:   result.actual.afterTaxProceeds,
    bucket:         result.bucket,
    effectiveRate:  result.actual.effectiveRate,
  };
}
