import { describe, it, expect } from "vitest";
import {
  expenseFundingSeries, taxByTypeSeries, debtVsAssetsSeries, debtAssetsCrossoverYear, superVsNonSuperSeries,
} from "./chartSeries.js";

function mkRow(over = {}) {
  return {
    income: 0, surplusOrDeficit: 0, deficitFundedFromAssets: 0, unfundedCashflow: 0,
    closingBalance: 0, propertyClosing: 0, superClosing: 0, wcaClosing: 0, liabilitiesClosing: 0,
    taxDetail: { client: {}, partner: null },
    superDetail: {},
    ...over,
  };
}

describe("expenseFundingSeries", () => {
  it("a surplus year: the whole need is met from income, nothing funded from assets or unfunded", () => {
    // income 80,000, surplusOrDeficit +20,000 => need = 60,000, fully from income.
    const [s] = expenseFundingSeries([mkRow({ income: 80000, surplusOrDeficit: 20000 })]);
    expect(s.metFromIncome).toBeCloseTo(60000, 6);
    expect(s.fundedFromAssets).toBe(0);
    expect(s.unfunded).toBe(0);
  });

  it("a deficit year: all of income goes to the need, the shortfall splits across assets and unfunded", () => {
    // income 50,000, surplusOrDeficit -10,000 (need 60,000); the deficit
    // cascade covered the 10,000 shortfall as 7,000 from assets + 3,000
    // unfunded, by construction of the funding cascade.
    const [s] = expenseFundingSeries([mkRow({
      income: 50000, surplusOrDeficit: -10000, deficitFundedFromAssets: 7000, unfundedCashflow: 3000,
    })]);
    expect(s.metFromIncome).toBeCloseTo(50000, 6); // every dollar of income
    expect(s.fundedFromAssets).toBeCloseTo(7000, 6);
    expect(s.unfunded).toBeCloseTo(3000, 6);
    // Reconciles exactly to the year's total need (income - surplusOrDeficit).
    expect(s.metFromIncome + s.fundedFromAssets + s.unfunded).toBeCloseTo(60000, 6);
  });

  it("reconciles across a mixed multi-year series, per year not just in total", () => {
    const rows = [
      mkRow({ income: 100000, surplusOrDeficit: 15000 }),
      mkRow({ income: 40000, surplusOrDeficit: -5000, deficitFundedFromAssets: 5000, unfundedCashflow: 0 }),
      mkRow({ income: 30000, surplusOrDeficit: -20000, deficitFundedFromAssets: 8000, unfundedCashflow: 12000 }),
    ];
    const series = expenseFundingSeries(rows);
    rows.forEach((row, y) => {
      const need = row.income - row.surplusOrDeficit;
      expect(series[y].metFromIncome + series[y].fundedFromAssets + series[y].unfunded).toBeCloseTo(need, 6);
    });
  });
});

describe("taxByTypeSeries", () => {
  it("each series reads its own named ledger source exactly", () => {
    const row = mkRow({
      taxDetail: {
        client: { incomeTax: 12000 }, partner: { incomeTax: 8000 },
        cgt: 3000, div293: 500, div296: 200, helpRepayment: 1500, medicareLevySurcharge: 400,
      },
      superDetail: { su1: { contributionsTax: 900 }, su2: { contributionsTax: 300 } },
    });
    const [s] = taxByTypeSeries([row]);
    expect(s.incomeTax).toBeCloseTo(20000, 6); // client + partner
    expect(s.cgt).toBeCloseTo(3000, 6);
    expect(s.div293).toBeCloseTo(500, 6);
    expect(s.div296).toBeCloseTo(200, 6);
    expect(s.help).toBeCloseTo(1500, 6);
    expect(s.mls).toBeCloseTo(400, 6);
    expect(s.contributionsTax).toBeCloseTo(1200, 6); // su1 + su2, NOT part of row.tax
  });

  it("a single-person household (partner null) counts only the client", () => {
    const row = mkRow({ taxDetail: { client: { incomeTax: 9000 }, partner: null } });
    const [s] = taxByTypeSeries([row]);
    expect(s.incomeTax).toBeCloseTo(9000, 6);
  });
});

describe("debtVsAssetsSeries / debtAssetsCrossoverYear", () => {
  it("assets is the same Total-assets figure Key Figures shows, debt is liabilitiesClosing unchanged", () => {
    const row = mkRow({ closingBalance: 100000, propertyClosing: 500000, superClosing: 200000, wcaClosing: 10000, liabilitiesClosing: 400000 });
    const [s] = debtVsAssetsSeries([row]);
    expect(s.assets).toBeCloseTo(810000, 6);
    expect(s.debt).toBeCloseTo(400000, 6);
  });

  it("finds the first year net worth crosses from negative to non-negative", () => {
    const rows = [
      mkRow({ closingBalance: 0, liabilitiesClosing: 500000 }), // -500,000
      mkRow({ closingBalance: 200000, liabilitiesClosing: 400000 }), // -200,000
      mkRow({ closingBalance: 450000, liabilitiesClosing: 300000 }), // +150,000 — crosses here
      mkRow({ closingBalance: 600000, liabilitiesClosing: 250000 }), // stays positive
    ];
    expect(debtAssetsCrossoverYear(rows)).toBe(2);
  });

  it("returns null when already net-positive from year 0, or when it never crosses", () => {
    expect(debtAssetsCrossoverYear([mkRow({ closingBalance: 100000, liabilitiesClosing: 50000 })])).toBeNull();
    const neverCrosses = [
      mkRow({ closingBalance: 0, liabilitiesClosing: 500000 }),
      mkRow({ closingBalance: 50000, liabilitiesClosing: 480000 }),
    ];
    expect(debtAssetsCrossoverYear(neverCrosses)).toBeNull();
  });

  it("an empty series returns null rather than throwing", () => {
    expect(debtAssetsCrossoverYear([])).toBeNull();
  });
});

describe("superVsNonSuperSeries", () => {
  it("splits into super and everything else, reconciling to the same total debtVsAssetsSeries reports", () => {
    const row = mkRow({ closingBalance: 100000, propertyClosing: 500000, superClosing: 200000, wcaClosing: 10000 });
    const [s] = superVsNonSuperSeries([row]);
    const [d] = debtVsAssetsSeries([row]);
    expect(s.superBalance).toBeCloseTo(200000, 6);
    expect(s.nonSuper).toBeCloseTo(610000, 6);
    expect(s.superBalance + s.nonSuper).toBeCloseTo(d.assets, 6);
  });
});
