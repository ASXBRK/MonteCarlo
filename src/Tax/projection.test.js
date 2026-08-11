import { describe, it, expect } from 'vitest';
import { runProjection, fifoSell } from './projection.js';

describe('FIFO parcel mechanics', () => {
  it('splits a parcel proportionally when partially consumed', () => {
    const parcels = [{ purchaseDate: '2024-01-01', costBase: 1000, units: 1000 }];
    const { sales } = fifoSell(parcels, 250, 1); // unitPrice 1, sell $250
    expect(sales).toHaveLength(1);
    expect(sales[0].parcel.costBase).toBeCloseTo(250, 6);
    expect(sales[0].salePrice).toBeCloseTo(250, 6);
    expect(parcels[0].costBase).toBeCloseTo(750, 6);
    expect(parcels[0].units).toBeCloseTo(750, 6);
  });

  it('consumes oldest parcels first across multiple lots', () => {
    const parcels = [
      { purchaseDate: '2024-01-01', costBase: 100, units: 100 },
      { purchaseDate: '2026-01-01', costBase: 200, units: 100 },
    ];
    const { sales } = fifoSell(parcels, 150, 1);
    expect(sales).toHaveLength(2);
    expect(sales[0].parcel.purchaseDate).toBe('2024-01-01');
    expect(sales[0].salePrice).toBeCloseTo(100, 6);
    expect(sales[1].parcel.purchaseDate).toBe('2026-01-01');
    expect(sales[1].salePrice).toBeCloseTo(50, 6);
    // Second lot half consumed: cost base split proportionally.
    expect(parcels).toHaveLength(1);
    expect(parcels[0].costBase).toBeCloseTo(100, 6);
  });
});

describe('runProjection integration', () => {
  it('drawdown across 2027 produces expected CGT with correct bucket', () => {
    const scenario = {
      initialBalance: 500_000, startDate: '2024-01-01',
      returnRate: 0.06, inflation: 0.025,
      withdrawals: [{ date: '2035-01-01', amount: 100_000 }],
      otherIncome: 50_000, assetType: 'shares',
    };
    const result = runProjection(scenario);
    const y2035 = result.years.find(y => y.date === '2035-01-01');
    expect(y2035).toBeDefined();
    expect(y2035.cgtTax).toBeGreaterThan(0);
    expect(y2035.taxBucket).toBe('B');
    expect(y2035.netWithdrawal).toBeCloseTo(100_000 - y2035.cgtTax, 0);
  });

  it('growth and contribution-only years carry zero tax', () => {
    const scenario = {
      initialBalance: 100_000, startDate: '2024-01-01',
      returnRate: 0.06, inflation: 0.025,
      contributions: [{ date: '2026-01-01', amount: 20_000 }],
      withdrawals: [{ date: '2030-01-01', amount: 10_000 }],
      otherIncome: 80_000, assetType: 'shares',
    };
    const result = runProjection(scenario);
    for (const y of result.years) {
      if (y.grossWithdrawal === 0) {
        expect(y.cgtTax).toBe(0);
        expect(y.netWithdrawal).toBe(0);
      }
    }
    const saleYear = result.years.find(y => y.grossWithdrawal > 0);
    expect(saleYear.date).toBe('2030-01-01');
    expect(saleYear.cgtTax).toBeGreaterThan(0);
  });

  it('withdrawal exceeding balance caps at balance and marks exhausted', () => {
    const scenario = {
      initialBalance: 50_000, startDate: '2024-01-01',
      returnRate: 0.03, inflation: 0.025,
      withdrawals: [{ date: '2026-01-01', amount: 500_000 }],
      otherIncome: 60_000, assetType: 'shares',
    };
    const result = runProjection(scenario);
    const y = result.years.find(y => y.grossWithdrawal > 0);
    expect(y.grossWithdrawal).toBeLessThan(500_000);
    expect(y.capitalExhausted).toBe(true);
    expect(result.capitalExhausted).toBe(true);
    expect(y.endBalance).toBeCloseTo(0, 6);
  });

  it('zero withdrawal skips tax calculation entirely', () => {
    const scenario = {
      initialBalance: 100_000, startDate: '2024-01-01',
      returnRate: 0.06, inflation: 0.025,
      withdrawals: [{ date: '2026-01-01', amount: 0 }],
      otherIncome: 80_000, assetType: 'shares',
      years: 3,
    };
    const result = runProjection(scenario);
    for (const y of result.years) {
      expect(y.cgtTax).toBe(0);
      expect(y.parcelSales).toHaveLength(0);
    }
  });

  it('pre-2027 sale lands in bucket A; post-2027 purchase+sale in bucket C', () => {
    // Bucket A: everything before the 2027 cutoff.
    const a = runProjection({
      initialBalance: 200_000, startDate: '2020-01-01',
      returnRate: 0.06, inflation: 0.025,
      withdrawals: [{ date: '2026-01-01', amount: 50_000 }],
      otherIncome: 90_000, assetType: 'shares',
    });
    const yA = a.years.find(y => y.grossWithdrawal > 0);
    expect(yA.taxBucket).toBe('A');

    // Bucket C: parcel purchased after 1 July 2027 via a contribution,
    // initial balance fully drawn down first (FIFO) by a prior withdrawal.
    const c = runProjection({
      initialBalance: 10_000, startDate: '2028-01-01',
      returnRate: 0.06, inflation: 0.025,
      withdrawals: [{ date: '2033-01-01', amount: 5_000 }],
      otherIncome: 90_000, assetType: 'shares',
    });
    const yC = c.years.find(y => y.grossWithdrawal > 0);
    expect(yC.taxBucket).toBe('C');
  });

  it('FIFO across the 2027 boundary mixes buckets within one sale', () => {
    // Initial parcel 2024 (straddles 2027 → B) + contribution parcel 2028
    // (post-2027 → C). A large 2035 withdrawal consumes both.
    const scenario = {
      initialBalance: 50_000, startDate: '2024-01-01',
      returnRate: 0.06, inflation: 0.025,
      contributions: [{ date: '2028-01-01', amount: 50_000 }],
      withdrawals: [{ date: '2035-01-01', amount: 110_000 }],
      otherIncome: 70_000, assetType: 'shares',
    };
    const result = runProjection(scenario);
    const y = result.years.find(y => y.grossWithdrawal > 0);
    const buckets = new Set(y.parcelSales.map(s => s.bucket));
    expect(buckets.has('B')).toBe(true);
    expect(buckets.has('C')).toBe(true);
  });
});
