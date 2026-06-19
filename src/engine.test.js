import { describe, it, expect } from 'vitest';
import {
  computeCarryForward,
  availableCC,
  availableNCC,
  taxSaving,
  projectBalance,
  marginalRate,
  taxOnIncome,
  fyStartYear,
  fyFromStartYear,
  nextFY,
  bucketsForExpiryView,
} from './engine.js';
import { TAX_BRACKETS_2025_26, TAX_BRACKETS_2026_27 } from './config.js';

describe('FY helpers', () => {
  it('parses FY start year', () => {
    expect(fyStartYear('2019/20')).toBe(2019);
    expect(fyStartYear('2024/25')).toBe(2024);
  });
  it('builds FY string from start year', () => {
    expect(fyFromStartYear(2019)).toBe('2019/20');
    expect(fyFromStartYear(2024)).toBe('2024/25');
  });
  it('returns next FY', () => {
    expect(nextFY('2024/25')).toBe('2025/26');
    expect(nextFY('2019/20')).toBe('2020/21');
  });
});

describe('computeCarryForward — sample reconciliation', () => {
  const sample = [
    { fy: '2019/20', ccMade: 6894.23, tsbPriorJune: 100000 },
    { fy: '2020/21', ccMade: 10086.10, tsbPriorJune: 120000 },
    { fy: '2021/22', ccMade: 8570.46, tsbPriorJune: 150000 },
    { fy: '2022/23', ccMade: 6912.14, tsbPriorJune: 180000 },
    { fy: '2023/24', ccMade: 10031.96, tsbPriorJune: 220000 },
    { fy: '2024/25', ccMade: 16999.84, tsbPriorJune: 280000 },
  ];

  const result = computeCarryForward(sample);

  it('matches the Total CC Cap column (whole dollars)', () => {
    expect(Math.round(result[0].totalAvailable)).toBe(25000);
    expect(Math.round(result[1].totalAvailable)).toBe(43106);
    expect(Math.round(result[2].totalAvailable)).toBe(60520);
    expect(Math.round(result[3].totalAvailable)).toBe(79449);
    expect(Math.round(result[4].totalAvailable)).toBe(100037);
    expect(Math.round(result[5].totalAvailable)).toBe(120005);
  });

  it('matches the Unused CCs carried fwd column (whole dollars)', () => {
    expect(Math.round(result[0].carriedForward)).toBe(18106);
    expect(Math.round(result[1].carriedForward)).toBe(33020);
    expect(Math.round(result[2].carriedForward)).toBe(51949);
    expect(Math.round(result[3].carriedForward)).toBe(72537);
    expect(Math.round(result[4].carriedForward)).toBe(90005);
    expect(Math.round(result[5].carriedForward)).toBe(103005);
  });

  it('preserves CC made amounts to the cent', () => {
    expect(result[0].ccMade).toBeCloseTo(6894.23, 2);
    expect(result[5].ccMade).toBeCloseTo(16999.84, 2);
  });
});

describe('computeCarryForward — FIFO consumption', () => {
  it('consumes oldest unused bucket when CCs exceed base cap', () => {
    const rows = [
      { fy: '2019/20', ccMade: 5000, tsbPriorJune: 100000 },
      { fy: '2020/21', ccMade: 5000, tsbPriorJune: 100000 },
      { fy: '2021/22', ccMade: 50000, tsbPriorJune: 100000 },
    ];
    const r = computeCarryForward(rows);
    expect(Math.round(r[0].carriedForward)).toBe(20000);
    expect(Math.round(r[1].carriedForward)).toBe(40000);
    expect(Math.round(r[2].totalAvailable)).toBe(67500);
    expect(Math.round(r[2].carriedForward)).toBe(17500);
    const remaining = r[2].bucketsAfter.find((b) => b.originYear === 2019);
    expect(remaining).toBeUndefined();
  });

  it('expires unused cap after 5 years FIFO', () => {
    const rows = [
      { fy: '2019/20', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2020/21', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2021/22', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2022/23', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2023/24', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2024/25', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2025/26', ccMade: 0, tsbPriorJune: 100000 },
    ];
    const r = computeCarryForward(rows);
    const has2019Bucket = r[6].bucketsAfter.some((b) => b.originYear === 2019);
    expect(has2019Bucket).toBe(false);
  });

  it('flags excess over total available cap', () => {
    const rows = [{ fy: '2024/25', ccMade: 35000, tsbPriorJune: 100000 }];
    const r = computeCarryForward(rows);
    expect(r[0].excessOverCap).toBeCloseTo(5000, 1);
  });
});

describe('computeCarryForward — TSB gate', () => {
  it('flags ineligibility for carry-forward when TSB >= 500k at prior 30 June', () => {
    const rows = [{ fy: '2024/25', ccMade: 0, tsbPriorJune: 600000 }];
    const r = computeCarryForward(rows);
    expect(r[0].tsbEligibleForCarry).toBe(false);
  });

  it('flags eligibility when TSB < 500k', () => {
    const rows = [{ fy: '2024/25', ccMade: 0, tsbPriorJune: 400000 }];
    const r = computeCarryForward(rows);
    expect(r[0].tsbEligibleForCarry).toBe(true);
  });

  it('still accrues unused cap when TSB above gate', () => {
    const rows = [{ fy: '2024/25', ccMade: 0, tsbPriorJune: 600000 }];
    const r = computeCarryForward(rows);
    expect(Math.round(r[0].carriedForward)).toBe(30000);
  });
});

describe('availableCC', () => {
  it('returns base cap when no carry-forward', () => {
    const r = availableCC({ fy: '2025/26', tsbPriorJune: 100000 });
    expect(r.baseCap).toBe(30000);
    expect(r.totalCap).toBe(30000);
    expect(r.remainingCap).toBe(30000);
  });

  it('adds carry-forward when TSB under 500k', () => {
    const r = availableCC({
      fy: '2025/26',
      carryForwardAvailable: 50000,
      tsbPriorJune: 400000,
    });
    expect(r.totalCap).toBe(80000);
    expect(r.canUseCarry).toBe(true);
  });

  it('excludes carry-forward when TSB >= 500k', () => {
    const r = availableCC({
      fy: '2025/26',
      carryForwardAvailable: 50000,
      tsbPriorJune: 600000,
    });
    expect(r.totalCap).toBe(30000);
    expect(r.canUseCarry).toBe(false);
  });

  it('reduces remaining cap by committed contributions', () => {
    const r = availableCC({
      fy: '2025/26',
      sg: 15000,
      salarySacrifice: 5000,
      personalDeductible: 2000,
      tsbPriorJune: 100000,
    });
    expect(r.committedCC).toBe(22000);
    expect(r.remainingCap).toBe(8000);
  });

  it('flags Div 293 when income + low-tax contrib > 250k', () => {
    const r = availableCC({
      fy: '2025/26',
      sg: 30000,
      taxableIncome: 240000,
      tsbPriorJune: 100000,
    });
    expect(r.div293Flag).toBe(true);
    expect(r.div293ApplicableContrib).toBeGreaterThan(0);
  });
});

describe('availableNCC', () => {
  it('returns 3-year bring-forward when TSB under low tier', () => {
    const r = availableNCC({ fy: '2025/26', tsbPriorJune: 1500000, age: 50 });
    expect(r.annualCap).toBe(120000);
    expect(r.bringForwardYears).toBe(3);
    expect(r.totalAvailable).toBe(360000);
  });

  it('returns 2-year bring-forward at mid tier', () => {
    const r = availableNCC({ fy: '2025/26', tsbPriorJune: 1800000, age: 50 });
    expect(r.bringForwardYears).toBe(2);
    expect(r.totalAvailable).toBe(240000);
  });

  it('returns 1-year (annual only) at upper tier', () => {
    const r = availableNCC({ fy: '2025/26', tsbPriorJune: 1900000, age: 50 });
    expect(r.bringForwardYears).toBe(1);
    expect(r.totalAvailable).toBe(120000);
  });

  it('returns zero when TSB at or above cap', () => {
    const r = availableNCC({ fy: '2025/26', tsbPriorJune: 2100000, age: 50 });
    expect(r.totalAvailable).toBe(0);
    expect(r.bringForwardYears).toBe(0);
  });

  it('flags age cutoff after 75', () => {
    const r = availableNCC({ fy: '2025/26', tsbPriorJune: 1500000, age: 76 });
    expect(r.eligibilityCutoff).toBe(true);
  });

  it('flags auto-triggered bring-forward when NCC > annual', () => {
    const r = availableNCC({
      fy: '2025/26',
      tsbPriorJune: 1500000,
      ncCMadeThisYear: 200000,
      age: 50,
    });
    expect(r.autoBringForward).toBe(true);
  });

  it('uses 2026/27 caps with $130k annual', () => {
    const r = availableNCC({ fy: '2026/27', tsbPriorJune: 1500000, age: 50 });
    expect(r.annualCap).toBe(130000);
    expect(r.totalAvailable).toBe(390000);
  });
});

describe('taxOnIncome', () => {
  it('returns 0 below tax-free threshold', () => {
    expect(taxOnIncome(15000, TAX_BRACKETS_2025_26)).toBe(0);
  });
  it('taxes only the slice above 18200 at 16% in 2025/26', () => {
    const t = taxOnIncome(45000, TAX_BRACKETS_2025_26);
    expect(t).toBeCloseTo((45000 - 18200) * 0.16, 2);
  });
  it('uses 15% on 18201-45000 in 2026/27', () => {
    const t = taxOnIncome(45000, TAX_BRACKETS_2026_27);
    expect(t).toBeCloseTo((45000 - 18200) * 0.15, 2);
  });
});

describe('taxSaving', () => {
  it('reports zero on zero contribution', () => {
    const r = taxSaving({ fy: '2025/26', taxableIncome: 100000, contribution: 0 });
    expect(r.netSaving).toBe(0);
  });

  it('computes saving for a 37% bracket earner', () => {
    const r = taxSaving({
      fy: '2025/26',
      taxableIncome: 150000,
      contribution: 10000,
    });
    // $140k-$150k slice all in 37% bracket + 2% Medicare = 39%
    expect(r.marginalRate).toBeCloseTo(0.39, 2);
    expect(r.contribTax15).toBe(1500);
    expect(r.netSaving).toBeCloseTo(2400, 0);
  });

  it('flags warning when MTR below 15%', () => {
    const r = taxSaving({
      fy: '2025/26',
      taxableIncome: 18000,
      contribution: 5000,
    });
    expect(r.warning).toBeTruthy();
  });

  it('adds Div 293 when income above threshold', () => {
    const r = taxSaving({
      fy: '2025/26',
      taxableIncome: 280000,
      contribution: 20000,
      div293Income: 300000,
    });
    expect(r.div293Tax).toBeGreaterThan(0);
  });
});

describe('marginalRate', () => {
  it('returns 30% in $135k bracket', () => {
    expect(marginalRate(100000, TAX_BRACKETS_2025_26)).toBe(0.30);
  });
  it('returns 37% in $190k bracket', () => {
    expect(marginalRate(180000, TAX_BRACKETS_2025_26)).toBe(0.37);
  });
  it('returns 45% above $190k', () => {
    expect(marginalRate(300000, TAX_BRACKETS_2025_26)).toBe(0.45);
  });
});

describe('projectBalance', () => {
  it('grows balance over years with contributions', () => {
    const rows = projectBalance({
      startBalance: 100000,
      annualStrategy: { cc: 20000, ncc: 0 },
      returnRate: 0.07,
      fy: '2025/26',
      years: 3,
    });
    expect(rows).toHaveLength(3);
    expect(rows[0].balance).toBeGreaterThan(100000);
    expect(rows[2].balance).toBeGreaterThan(rows[1].balance);
  });

  it('applies 15% contributions tax to CC only', () => {
    const rows = projectBalance({
      startBalance: 0,
      annualStrategy: { cc: 10000, ncc: 0 },
      returnRate: 0,
      fy: '2025/26',
      years: 1,
    });
    expect(rows[0].contribTax).toBe(1500);
    expect(rows[0].balance).toBeCloseTo(8500, 1);
  });

  it('does not tax NCC contributions', () => {
    const rows = projectBalance({
      startBalance: 0,
      annualStrategy: { cc: 0, ncc: 10000 },
      returnRate: 0,
      fy: '2025/26',
      years: 1,
    });
    expect(rows[0].contribTax).toBe(0);
    expect(rows[0].balance).toBeCloseTo(10000, 1);
  });

  it('rolls FY forward', () => {
    const rows = projectBalance({
      startBalance: 0,
      annualStrategy: { cc: 0, ncc: 0 },
      returnRate: 0,
      fy: '2025/26',
      years: 2,
    });
    expect(rows[0].fy).toBe('2025/26');
    expect(rows[1].fy).toBe('2026/27');
  });
});

describe('bucketsForExpiryView', () => {
  it('marks buckets within 1 year of expiry as expiringSoon', () => {
    const history = computeCarryForward([
      { fy: '2019/20', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2020/21', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2021/22', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2022/23', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2023/24', ccMade: 0, tsbPriorJune: 100000 },
      { fy: '2024/25', ccMade: 0, tsbPriorJune: 100000 },
    ]);
    const view = bucketsForExpiryView(history, '2024/25');
    const oldest = view.find((b) => b.originFY === '2019/20');
    expect(oldest.yearsLeft).toBe(0);
    expect(oldest.status).toBe('expiringSoon');
  });
});
