// Deterministic after-CGT projection with FIFO parcel (lot) tracking.
//
// This module is the integration layer between a balance projection and
// the vendored CGT engine (engine.js — read-only). It models the
// portfolio as parcels acquired at contribution time:
//
//   - Every contribution (and the initial balance) creates a parcel
//     { purchaseDate, costBase, units } at that date's unit price.
//   - Growth moves the unit price, never the parcels.
//   - Withdrawals draw down the OLDEST parcels first (FIFO), splitting
//     a parcel proportionally when it isn't consumed whole.
//   - Each drawn-down parcel becomes one call into the tax engine via
//     taxOnParcelSale, which auto-detects the transition bucket
//     (A pre-2027 / B straddling / C post-2027 / D pre-1985).
//
// FIFO (not weighted-average) is deliberate: it correctly handles
// parcels that straddle 1 July 2027 — pre-2027 lots get the old 50%
// discount treatment, post-2027 lots get indexation + 30% minimum,
// and mixed years see a proper mix.
//
// Modelling assumptions (documented for review):
//   - Yearly granularity: the projection steps on anniversaries of
//     startDate. Growth for the year is applied BEFORE any withdrawal
//     dated on that anniversary (grow-then-withdraw).
//   - Contributions dated inside a year are applied at the NEXT
//     anniversary's unit price (end-of-period convention).
//   - Fractional units are allowed (units are ratios, not integers).
//   - Stacking approximation: when multiple parcels sell in the same
//     year, each parcel is taxed independently against the same
//     other_income. This slightly understates tax when combined gains
//     push into a higher bracket — the industry-standard approximation,
//     matching the engine's own Bucket B pro-rata split.
//   - Loss netting: the engine models gains only. When a sale event
//     includes loss parcels alongside gain parcels, the total nominal
//     loss is redistributed pro-rata as a cost-base uplift on the gain
//     parcels before calling the engine (approximate netting). Loss
//     parcels then contribute zero tax.

import { taxOnParcelSale } from './taxOnParcelSale.js';

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

function toDate(d) { return d instanceof Date ? d : new Date(d); }
function iso(d) { return toDate(d).toISOString().slice(0, 10); }

function addYears(dateStr, k) {
  const d = toDate(dateStr);
  const out = new Date(d);
  out.setFullYear(d.getFullYear() + k);
  return out;
}

// Sell `grossAmount` (dollars) out of `parcels` (mutated) at `unitPrice`,
// FIFO. Returns { sales: [{ parcel, salePrice }], unitsSold }.
// Each sale's `parcel` is a snapshot { purchaseDate, costBase } of the
// portion sold — the live parcel is split proportionally.
export function fifoSell(parcels, grossAmount, unitPrice) {
  const sales = [];
  let remainingUnits = grossAmount / unitPrice;
  while (remainingUnits > 1e-12 && parcels.length > 0) {
    const lot = parcels[0];
    if (lot.units <= remainingUnits + 1e-12) {
      // Consume the whole lot.
      sales.push({
        parcel: { purchaseDate: lot.purchaseDate, costBase: lot.costBase },
        salePrice: lot.units * unitPrice,
      });
      remainingUnits -= lot.units;
      parcels.shift();
    } else {
      // Split proportionally.
      const fraction = remainingUnits / lot.units;
      const soldCost = lot.costBase * fraction;
      sales.push({
        parcel: { purchaseDate: lot.purchaseDate, costBase: soldCost },
        salePrice: remainingUnits * unitPrice,
      });
      lot.costBase -= soldCost;
      lot.units -= remainingUnits;
      remainingUnits = 0;
    }
  }
  return { sales };
}

// Approximate loss netting: engine models gains only, so redistribute
// nominal losses as a pro-rata cost-base uplift across gain parcels.
function netLossesAcrossParcels(sales) {
  let totalLoss = 0;
  let totalGain = 0;
  for (const s of sales) {
    const nominal = s.salePrice - s.parcel.costBase;
    if (nominal < 0) totalLoss += -nominal;
    else totalGain += nominal;
  }
  if (totalLoss === 0 || totalGain === 0) return sales;
  return sales.map((s) => {
    const nominal = s.salePrice - s.parcel.costBase;
    if (nominal <= 0) return s;
    const uplift = totalLoss * (nominal / totalGain);
    return {
      ...s,
      parcel: { ...s.parcel, costBase: s.parcel.costBase + Math.min(uplift, nominal) },
    };
  });
}

// Run the deterministic projection.
//
// scenario: {
//   initialBalance, startDate,            // ISO date
//   returnRate,                           // annual nominal growth
//   inflation,                            // annual, drives engine indexation
//   contributions: [{ date, amount }],    // optional
//   withdrawals:   [{ date, amount }],    // optional
//   otherIncome, assetType, onIncomeSupport,
//   years,                                // optional horizon override
// }
//
// Returns { years: [...], parcelsRemaining, capitalExhausted }.
// Each year entry: {
//   date, startBalance, growth, contributions,
//   grossWithdrawal, cgtTax, netWithdrawal, taxBucket,
//   parcelSales, endBalance, capitalExhausted,
// }
export function runProjection(scenario) {
  const {
    initialBalance = 0,
    startDate,
    returnRate = 0,
    contributions = [],
    withdrawals = [],
    years: yearsOverride,
  } = scenario;

  const lastEventYear = Math.max(
    0,
    ...contributions.map((c) => Math.ceil((toDate(c.date) - toDate(startDate)) / MS_PER_YEAR)),
    ...withdrawals.map((w) => Math.ceil((toDate(w.date) - toDate(startDate)) / MS_PER_YEAR)),
  );
  const horizon = yearsOverride ?? Math.max(lastEventYear, 1);

  // Parcel store. Initial balance is a parcel at unit price 1.
  const parcels = [];
  if (initialBalance > 0) {
    parcels.push({ purchaseDate: iso(startDate), costBase: initialBalance, units: initialBalance });
  }

  const years = [];
  let capitalExhausted = false;

  for (let k = 1; k <= horizon; k++) {
    const yearDate = addYears(startDate, k);
    const yearISO = iso(yearDate);
    const prevDate = addYears(startDate, k - 1);
    const unitPrice = Math.pow(1 + returnRate, k);
    const prevUnitPrice = Math.pow(1 + returnRate, k - 1);

    const unitsHeld = parcels.reduce((s, p) => s + p.units, 0);
    const startBalance = unitsHeld * prevUnitPrice;
    const growth = unitsHeld * (unitPrice - prevUnitPrice);

    // Contributions falling in (prevDate, yearDate] buy at this
    // anniversary's unit price (end-of-period convention).
    let contribTotal = 0;
    for (const c of contributions) {
      const cd = toDate(c.date);
      if (cd > prevDate && cd <= yearDate && c.amount > 0) {
        parcels.push({
          purchaseDate: iso(cd),
          costBase: c.amount,
          units: c.amount / unitPrice,
        });
        contribTotal += c.amount;
      }
    }

    // Withdrawals falling in (prevDate, yearDate].
    let grossWithdrawal = 0;
    let cgtTax = 0;
    let taxBucket = null;
    const parcelSales = [];

    for (const w of withdrawals) {
      const wd = toDate(w.date);
      if (!(wd > prevDate && wd <= yearDate) || w.amount <= 0) continue;

      const balanceNow = parcels.reduce((s, p) => s + p.units, 0) * unitPrice;
      let gross = w.amount;
      if (gross >= balanceNow - 1e-9) {
        gross = balanceNow;
        capitalExhausted = true;
      }
      if (gross <= 0) continue;

      const { sales } = fifoSell(parcels, gross, unitPrice);
      const netted = netLossesAcrossParcels(sales);

      let largestSale = 0;
      for (const s of netted) {
        const r = taxOnParcelSale({
          parcel: s.parcel,
          saleDate: iso(wd),
          salePrice: s.salePrice,
          scenario,
        });
        cgtTax += r.tax;
        parcelSales.push({
          purchaseDate: s.parcel.purchaseDate,
          salePrice: s.salePrice,
          costBase: s.parcel.costBase,
          tax: r.tax,
          bucket: r.bucket,
        });
        if (s.salePrice > largestSale) {
          largestSale = s.salePrice;
          taxBucket = r.bucket;
        }
      }
      grossWithdrawal += gross;
    }

    const endBalance = parcels.reduce((s, p) => s + p.units, 0) * unitPrice;

    years.push({
      date: yearISO,
      startBalance,
      growth,
      contributions: contribTotal,
      grossWithdrawal,
      cgtTax,
      netWithdrawal: grossWithdrawal - cgtTax,
      taxBucket,
      parcelSales,
      endBalance,
      capitalExhausted,
    });

    if (capitalExhausted && endBalance <= 1e-9) break;
  }

  return { years, parcelsRemaining: parcels, capitalExhausted };
}
