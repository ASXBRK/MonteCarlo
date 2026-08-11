import { describe, it, expect } from 'vitest';
import {
  runCGTProjection, marginalTax, fyForDate, determineBucket, medicareLevy, LEG,
  buildAssetValueAtPurchase, derivedSalePrice,
} from './engine.js';

function near(a, b, pct = 0.01) {
  if (b === 0) return Math.abs(a) <= 1;
  return Math.abs(a - b) / Math.abs(b) <= pct;
}

describe('helpers', () => {
  it('fyForDate handles July boundary', () => {
    expect(fyForDate('2027-07-01')).toBe('2027-28');
    expect(fyForDate('2027-06-30')).toBe('2026-27');
  });

  it('marginalTax matches 2027-28 brackets', () => {
    expect(marginalTax(100000, '2027-28')).toBeCloseTo(20252, 0);
  });

  it('determineBucket assigns A/B/C/D (auto-detects pre-CGT)', () => {
    expect(determineBucket('2020-01-01', '2025-01-01')).toBe('A');
    expect(determineBucket('2020-01-01', '2030-01-01')).toBe('B');
    expect(determineBucket('2028-01-01', '2032-01-01')).toBe('C');
    expect(determineBucket('1980-01-01', '2030-01-01')).toBe('D');
  });

  it('medicareLevy applies shading-in correctly', () => {
    expect(medicareLevy(25000)).toBe(0);              // below lower threshold
    expect(medicareLevy(28011)).toBe(0);              // at lower threshold
    expect(medicareLevy(35014)).toBeCloseTo(700, -1); // top of shading zone
    expect(medicareLevy(100000)).toBe(2000);          // 2% full rate
  });
});

describe('Mode 1 — Old vs New rules', () => {
  const base = {
    mode: 'old_vs_new',
    purchase_price: 500000,
    inflation: 0.025,
    holding_years: 10,
    other_income: 100000,
    income_support_recipient: false,
  };

  it('Test 1 (Ben, 2.5% return): real gain wiped by indexation', () => {
    const r = runCGTProjection({ ...base, return_rate: 0.025 });
    expect(near(r.oldRules.taxableGain, 70021, 0.005)).toBe(true);
    expect(r.newRules.taxableGain).toBeCloseTo(0, 0);
  });

  it('Test 2 (David, 5% return)', () => {
    const r = runCGTProjection({ ...base, return_rate: 0.05 });
    expect(near(r.oldRules.taxableGain, 157224, 0.005)).toBe(true);
    expect(near(r.newRules.taxableGain, 174405, 0.005)).toBe(true);
  });

  it('Test 3 (Kate, 7.5% return)', () => {
    const r = runCGTProjection({ ...base, return_rate: 0.075 });
    expect(near(r.oldRules.taxableGain, 265258, 0.005)).toBe(true);
    expect(near(r.newRules.taxableGain, 390474, 0.005)).toBe(true);
  });
});

describe('Mode 2 — Specific asset', () => {
  it('Test 4 (Jane, Bucket B split treatment)', () => {
    const r = runCGTProjection({
      mode: 'specific',
      purchase_date: '2022-07-01',
      purchase_price: 800000,
      sale_date: '2032-07-01',
      sale_price: 1600000,
      inflation: 0.025,
      other_income: 200000,
      valuation_method: 'ATO_formula',
    });
    expect(r.bucket).toBe('B');
    expect(near(r.split.value2027, 1131371, 0.005)).toBe(true);
    expect(near(r.split.prePortionTaxable, 165685, 0.01)).toBe(true);
    expect(near(r.split.postPortionTaxable, 319958, 0.01)).toBe(true);
    expect(near(r.split.totalTaxable, 485643, 0.01)).toBe(true);
  });

  it('Test 5 (Zoe, Bucket C low growth)', () => {
    const r = runCGTProjection({
      mode: 'specific',
      purchase_date: '2027-07-01',
      purchase_price: 100,
      sale_date: '2032-07-01',
      sale_price: 125,
      inflation: 0.025,
      other_income: 100000,
    });
    expect(r.bucket).toBe('C');
    expect(near(r.newRules.indexedCostBase, 113, 0.02)).toBe(true);
    expect(near(r.newRules.taxableGain, 12, 0.2)).toBe(true);
    expect(near(r.oldRules.taxableGain, 12.5, 0.2)).toBe(true);
  });

  it('Test 6 (Jack, 30% minimum bites — with proper Medicare)', () => {
    const r = runCGTProjection({
      mode: 'specific',
      purchase_date: '2027-08-01',
      purchase_price: 0,
      sale_date: '2030-06-30',
      sale_price: 10000,
      inflation: 0,
      other_income: 25000,
    });
    expect(r.bucket).toBe('C');
    expect(r.newRules.minTaxApplied).toBe(true);
    // 30% × $10k = $3,000 base. Other income $25k below Medicare lower
    // threshold $28,011; gain pushes total to $35,000 which is within shading
    // zone. Medicare ≈ ($35,000 - $28,011) × 10% = $698.90. Total ≈ $3,699.
    expect(r.newRules.taxOnGain).toBeGreaterThanOrEqual(3500);
    expect(r.newRules.taxOnGain).toBeLessThanOrEqual(3800);
  });

  it('Test 7 (Max, Bucket B Pitcher worked example)', () => {
    const r = runCGTProjection({
      mode: 'specific',
      purchase_date: '2025-07-01',
      purchase_price: 4000,
      sale_date: '2028-06-30',
      sale_price: 35000,
      inflation: 0.025,
      other_income: 10000,
      valuation_method: 'ATO_formula',
    });
    expect(r.bucket).toBe('B');
    expect(near(r.split.value2027, 16985, 0.02)).toBe(true);
    expect(r.split.prePortionTaxable).toBeGreaterThan(0);
    expect(r.split.postPortionTaxable).toBeGreaterThan(0);
  });

  it('Test 8 (Pre-CGT, Bucket D — auto-detected from date)', () => {
    const r = runCGTProjection({
      mode: 'specific',
      // no is_pre_cgt flag — engine derives from 1980 purchase date
      purchase_date: '1980-01-01',
      sale_date: '2030-06-30',
      sale_price: 500000,
      value_2027: 400000,
      inflation: 0.025,
      other_income: 80000,
      valuation_method: 'use_entered_value',
    });
    expect(r.bucket).toBe('D');
    expect(r.split.prePortionTaxable).toBe(0);
    expect(near(r.newRules.indexedCostBase, 431500, 0.02)).toBe(true);
    expect(near(r.newRules.taxableGain, 68500, 0.02)).toBe(true);
  });
});

describe('Edge cases', () => {
  it('capital loss returns flag and zero tax', () => {
    const r = runCGTProjection({
      mode: 'old_vs_new',
      purchase_price: 1000,
      return_rate: -0.05,
      inflation: 0.025,
      holding_years: 5,
      other_income: 100000,
    });
    expect(r.result).toBe('capital_loss');
    expect(r.oldRules.taxOnGain).toBe(0);
    expect(r.newRules.taxOnGain).toBe(0);
  });

  it('income support recipient is not hit by 30% minimum', () => {
    const r = runCGTProjection({
      mode: 'specific',
      purchase_date: '2027-08-01',
      purchase_price: 0,
      sale_date: '2030-06-30',
      sale_price: 10000,
      inflation: 0,
      other_income: 25000,
      income_support_recipient: true,
    });
    expect(r.newRules.minTaxApplied).toBe(false);
    // Marginal only + proper Medicare (low income, in shading zone)
    expect(r.newRules.taxOnGain).toBeLessThan(2500);
  });

  it('investment property: capital works deductions reduce cost base', () => {
    const baseInputs = {
      mode: 'specific',
      asset_type: 'property',
      purchase_date: '2020-07-01',
      purchase_price: 500000,
      acquisition_costs: 20000,
      capital_improvements: 0,
      sale_date: '2025-06-30',
      sale_price: 700000,
      sale_costs: 5000,
      inflation: 0.025,
      other_income: 100000,
    };
    const withoutDep = runCGTProjection({ ...baseInputs, depreciation_claimed: 0 });
    const withDep = runCGTProjection({ ...baseInputs, depreciation_claimed: 30000 });
    // Higher cost base reduction → larger gain → more tax
    expect(withDep.actual.taxOnGain).toBeGreaterThan(withoutDep.actual.taxOnGain);
  });

  it('LEG constants are frozen', () => {
    expect(Object.isFrozen(LEG)).toBe(true);
  });
});

describe('Sale-price growth basis (depreciation does not reduce market value)', () => {
  // Each test derives sale price via the engine helper and runs the
  // projection end-to-end so we verify both the UI-facing derivation and
  // the engine's downstream value_2027 calculation.

  it('T1: property with depreciation, no improvements', () => {
    const inputs = {
      mode: 'specific',
      asset_type: 'property',
      purchase_date: '2020-01-01',
      sale_date: '2035-01-01',
      purchase_price: 500_000,
      capital_improvements: 0,
      depreciation_claimed: 100_000,
      return_rate: 0.05,
      inflation: 0.025,
      other_income: 150_000,
      valuation_method: 'ATO_formula',
    };
    expect(buildAssetValueAtPurchase(inputs)).toBe(500_000);
    const sp = derivedSalePrice(inputs, inputs.sale_date);
    expect(near(sp, 1_039_464, 0.001)).toBe(true);
    const r = runCGTProjection({ ...inputs, sale_price: Math.round(sp) });
    expect(r.bucket).toBe('B');
    expect(near(r.costBase, 400_000, 0.001)).toBe(true);
    expect(near(r.nominalGain, 639_464, 0.001)).toBe(true);
    expect(near(r.split.value2027, 720_752, 0.005)).toBe(true);
  });

  it('T2: property with improvements, no depreciation (no regression)', () => {
    const inputs = {
      mode: 'specific',
      asset_type: 'property',
      purchase_date: '2020-01-01',
      sale_date: '2035-01-01',
      purchase_price: 500_000,
      capital_improvements: 200_000,
      depreciation_claimed: 0,
      return_rate: 0.05,
      inflation: 0.025,
      other_income: 150_000,
    };
    expect(buildAssetValueAtPurchase(inputs)).toBe(700_000);
    const sp = derivedSalePrice(inputs, inputs.sale_date);
    expect(near(sp, 1_455_251, 0.001)).toBe(true);
    const r = runCGTProjection({ ...inputs, sale_price: Math.round(sp) });
    expect(near(r.costBase, 700_000, 0.001)).toBe(true);
  });

  it('T3: property with both improvements and depreciation', () => {
    const inputs = {
      mode: 'specific',
      asset_type: 'property',
      purchase_date: '2020-01-01',
      sale_date: '2035-01-01',
      purchase_price: 500_000,
      capital_improvements: 200_000,
      depreciation_claimed: 100_000,
      return_rate: 0.05,
      inflation: 0.025,
      other_income: 150_000,
    };
    expect(buildAssetValueAtPurchase(inputs)).toBe(700_000);
    const sp = derivedSalePrice(inputs, inputs.sale_date);
    expect(near(sp, 1_455_251, 0.001)).toBe(true);
    const r = runCGTProjection({ ...inputs, sale_price: Math.round(sp) });
    expect(near(r.costBase, 600_000, 0.001)).toBe(true);
    expect(near(r.nominalGain, 855_251, 0.001)).toBe(true);
  });

  it('T4: shares (no regression — depreciation/improvements ignored for non-property)', () => {
    const inputs = {
      mode: 'specific',
      asset_type: 'shares',
      purchase_date: '2022-01-01',
      sale_date: '2026-01-01',
      purchase_price: 100_000,
      return_rate: 0.07,
      inflation: 0.025,
      other_income: 100_000,
    };
    expect(buildAssetValueAtPurchase(inputs)).toBe(100_000);
    const sp = derivedSalePrice(inputs, inputs.sale_date);
    expect(near(sp, 131_080, 0.001)).toBe(true);
  });

  it('T5: Bucket B 50-year hold with depreciation', () => {
    const inputs = {
      mode: 'specific',
      asset_type: 'property',
      purchase_date: '1990-06-01',
      sale_date: '2040-06-01',
      purchase_price: 200_000,
      capital_improvements: 0,
      depreciation_claimed: 100_000,
      return_rate: 0.06,
      inflation: 0.03,
      other_income: 150_000,
      valuation_method: 'ATO_formula',
    };
    expect(buildAssetValueAtPurchase(inputs)).toBe(200_000);
    const sp = derivedSalePrice(inputs, inputs.sale_date);
    expect(near(sp, 3_684_030, 0.001)).toBe(true);
    const r = runCGTProjection({ ...inputs, sale_price: Math.round(sp) });
    expect(r.bucket).toBe('B');
    expect(near(r.costBase, 100_000, 0.001)).toBe(true);
    expect(near(r.split.value2027, 1_735_518, 0.005)).toBe(true);
  });

  it('T6: pre-CGT property — post-2027 improvements + depreciation feed cost base + growth', () => {
    const inputs = {
      mode: 'specific',
      asset_type: 'property',
      purchase_date: '1980-01-01',
      sale_date: '2035-07-01', // 8 years post-cutoff
      value_2027: 1_000_000,
      capital_improvements: 200_000,
      depreciation_claimed: 50_000,
      return_rate: 0.05,
      inflation: 0.025,
      other_income: 150_000,
    };

    // Growth basis post-2027 = value_2027 + improvements; depreciation does
    // not reduce market value. Pre-2027 sale dates use value_2027 alone.
    const spPost = derivedSalePrice(inputs, '2035-07-01');
    expect(near(spPost, 1_200_000 * Math.pow(1.05, 8), 0.001)).toBe(true);
    const spPre = derivedSalePrice(inputs, '2026-01-01');
    // Reverse-CAGR from value_2027 only (improvements haven't happened yet)
    expect(near(spPre, 1_000_000 * Math.pow(1.05, -1.5), 0.005)).toBe(true);

    const r = runCGTProjection({ ...inputs, sale_price: Math.round(spPost) });
    expect(r.bucket).toBe('D');
    // Effective cost base = 1_000_000 + 200_000 − 50_000 = 1_150_000
    expect(near(r.costBase, 1_150_000, 0.001)).toBe(true);
    // Pre-2027 portion stays exempt under Bucket D
    expect(r.oldRules.taxOnGain).toBe(0);
    // newRules.indexedCostBase = effectiveCostBase × (1+inflation)^yearsPost
    expect(
      near(r.newRules.indexedCostBase, 1_150_000 * Math.pow(1.025, 8), 0.005)
    ).toBe(true);
  });
});

describe('12-month CGT discount threshold (day count, not 365.25)', () => {
  // Bucket A scenario base — sale before 1 Jul 2027 so old-rules treatment
  // is the only one that applies and we can read taxable gain directly.
  const base = {
    mode: 'specific',
    asset_type: 'shares',
    purchase_price: 100_000,
    sale_price: 110_000, // $10k nominal gain
    inflation: 0.025,
    other_income: 100_000,
  };

  it('sale exactly 12 calendar months after purchase qualifies for the 50% discount', () => {
    const r = runCGTProjection({
      ...base,
      purchase_date: '2026-05-15',
      sale_date: '2027-05-15', // 365 days later
    });
    expect(r.bucket).toBe('A');
    // Discount applied → taxable gain = 0.5 * $10k = $5,000
    expect(r.oldRules.taxableGain).toBeCloseTo(5_000, -1);
  });

  it('sale 1 day before the 12-month anniversary denies the discount', () => {
    const r = runCGTProjection({
      ...base,
      purchase_date: '2026-05-15',
      sale_date: '2027-05-14', // 364 days
    });
    expect(r.bucket).toBe('A');
    // No discount → taxable gain = full $10k
    expect(r.oldRules.taxableGain).toBeCloseTo(10_000, -1);
  });

  it('sale 1 day after the 12-month anniversary qualifies for the discount', () => {
    const r = runCGTProjection({
      ...base,
      purchase_date: '2026-05-15',
      sale_date: '2027-05-16', // 366 days
    });
    expect(r.bucket).toBe('A');
    expect(r.oldRules.taxableGain).toBeCloseTo(5_000, -1);
  });

  // Three additional scenarios pinning calendar-month boundaries and the
  // zero-gain edge case. Use runCGTProjection (the public API) with an
  // explicit sale_price so the gain is deterministic.
  it('sale exactly 12 months across a leap year (Jan 2024 → Jan 2025) qualifies', () => {
    const r = runCGTProjection({
      mode: 'specific',
      asset_type: 'shares',
      purchase_date: '2024-01-01',
      sale_date: '2025-01-01', // 366 days (2024 is a leap year)
      purchase_price: 100_000,
      sale_price: 110_000,
      inflation: 0.025,
      other_income: 100_000,
    });
    expect(r.bucket).toBe('A');
    expect(r.oldRules.taxableGain).toBe(5_000);
  });

  it('sale 11 months after purchase rejects the discount', () => {
    const r = runCGTProjection({
      mode: 'specific',
      asset_type: 'shares',
      purchase_date: '2024-01-01',
      sale_date: '2024-12-01', // 335 days
      purchase_price: 100_000,
      sale_price: 110_000,
      inflation: 0.025,
      other_income: 150_000,
    });
    expect(r.bucket).toBe('A');
    expect(r.oldRules.taxableGain).toBe(10_000);
  });

  it('same-day purchase and sale produces zero gain', () => {
    const r = runCGTProjection({
      mode: 'specific',
      asset_type: 'shares',
      purchase_date: '2025-06-15',
      sale_date: '2025-06-15',
      purchase_price: 100_000,
      sale_price: 100_000,
      inflation: 0.025,
      other_income: 100_000,
    });
    expect(r.nominalGain).toBe(0);
    expect(r.actual.taxOnGain).toBe(0);
    expect(r.actual.afterTaxProceeds).toBe(100_000);
  });
});
