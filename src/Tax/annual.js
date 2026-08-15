// annual.js — the shared per-person, per-FY tax assessment.
//
// Pure: no assets, no ledger, no DOM. The deterministic engine calls
// this once per person per plan year; the Monte Carlo engine will call
// it per path later. Reuses the vendored engine primitives (LEG
// bracket tables, marginalTax, medicareLevy) rather than duplicating
// them.
//
// Modelled: resident individual marginal brackets, Medicare levy with
// shading-in (single thresholds per person), LITO (non-refundable),
// franking gross-up with refundable credits, CGT under both regimes
// (pre-reform discounted gains arrive already discounted; post-reform
// gains get the 30% minimum-tax floor consistent with the engine's
// simple_max application), and per-person capital-loss carry-forward.
// HELP repayments are modelled separately (src/data/helpRates.js,
// deterministic.js) since they depend on repayment income, not this
// function's inputs. NOT modelled (disclosed in the Parameters modal):
// SAPTO, Medicare levy surcharge, family Medicare thresholds. (Div 293
// is also modelled separately — Tier 1.2 — this comment predates it.)
//
// Everything is in REAL dollars. Bracket modes (locked decision 6):
//   "indexed" (default) — brackets/Medicare/LITO held constant in real
//     terms from FY2027-28 onward (CPI-indexed settings; exact in the
//     real frame). FY2026-27 and earlier use their own legislated
//     tables.
//   "frozen" — nominal settings frozen at the FY2027-28 tables. In
//     real dollars every threshold shrinks by CPI each year after
//     FY2027-28. Implemented by scaling: tax on real income x against
//     thresholds/k equals marginalTax(x·k)/k with nominal thresholds,
//     where k = (1+cpi)^(fyStartYear − 2027).

import { LEG, marginalTax, marginalTaxNonResident, medicareLevy } from "./engine.js";

export const FRANKING_RATE = 30 / 70; // credit per $ of franked distribution

// LITO — current legislated schedule (s 159N as amended): $700 max,
// withdrawn at 5c/$ over $37,500 to $325 at $45,000, then at 1.5c/$,
// cutting out at $66,667. Non-refundable, offsets income tax only
// (never the Medicare levy).
export const LITO = Object.freeze({
  maxOffset: 700,
  taper1Threshold: 37500,
  taper1Rate: 0.05,
  taper2Threshold: 45000,
  taper2Base: 325,
  taper2Rate: 0.015,
});

export function litoAmount(taxableIncome) {
  if (taxableIncome <= LITO.taper1Threshold) return LITO.maxOffset;
  if (taxableIncome <= LITO.taper2Threshold) {
    return LITO.maxOffset - (taxableIncome - LITO.taper1Threshold) * LITO.taper1Rate;
  }
  return Math.max(0, LITO.taper2Base - (taxableIncome - LITO.taper2Threshold) * LITO.taper2Rate);
}

// A nominal threshold's value in real (today's) dollars for a FY under
// the active bracket mode — the Assumptions view's row math. Indexed:
// constant; frozen: shrinks by CPI each year after FY2027-28.
export function realThreshold(nominal, fyStartYear, bracketMode, cpi) {
  return nominal / bracketSettings(fyStartYear, bracketMode, cpi).k;
}

// Bracket-table key and real-scaling factor for a FY (see header).
export function bracketSettings(fyStartYear, bracketMode, cpi) {
  const key =
    fyStartYear <= 2025 ? "2025-26" :
    fyStartYear === 2026 ? "2026-27" : "2027-28";
  const k = bracketMode === "frozen"
    ? Math.pow(1 + cpi, Math.max(0, fyStartYear - 2027))
    : 1;
  return { key, k };
}

// assessPerson — one person's tax for one FY, all in real dollars.
//
//   ordinaryIncome   gross income rows attributed to the person
//   deductions       ICR-style investment deductions attributed to them
//   distributions    { franked, unfranked } CASH amounts (pre-gross-up)
//   netCapitalGain   the FY's realised net gain: post-reform gains at
//                    full real value, pre-reform gains already
//                    discounted; negative = a current-year net loss
//   capitalLossCarryFwd  prior-year losses carried in
//   taxProfile       { residency: "resident"|"nonResident",
//                      medicareExempt } (C3). Non-residents: no
//                    tax-free threshold (non-resident brackets), no
//                    Medicare, no LITO. Franking credits stay
//                    refundable and CGT mechanics are NOT
//                    differentiated for non-residents — disclosed
//                    simplifications. Medicare-exempt residents skip
//                    the levy only.
//
// Returns { incomeTax, medicare, lito, excessCcOffset, frankingCredits,
//           netIncomeTax, cgtTax, taxableIncome, taxableGain, lossCarryFwd }.
// netIncomeTax = incomeTax − lito − excessCcOffset + medicare −
// frankingCredits and can be NEGATIVE (refundable franking credits).
// cgtTax is assessed separately because it is paid on a different
// timetable (July of the following FY).
export function assessPerson({
  fyStartYear,
  bracketMode = "indexed",
  cpi = 0.025,
  ordinaryIncome = 0,
  deductions = 0,
  distributions = { franked: 0, unfranked: 0 },
  netCapitalGain = 0,
  capitalLossCarryFwd = 0,
  taxProfile = null,
  // Excess concessional super contributions (Tier 1.2): included in
  // assessable income at the member's marginal rate, with a
  // non-refundable offset for the 15% contributions tax already paid
  // in the fund (avoiding literal double taxation, not exempting the
  // excess). Modelled: leave-in-fund (the default) — the
  // release-from-fund election is not modelled.
  excessConcessionalContributions = 0,
  excessConcessionalOffsetRate = 0.15,
}) {
  const { key, k } = bracketSettings(fyStartYear, bracketMode, cpi);
  const nonResident = taxProfile?.residency === "nonResident";
  const noLevy = nonResident || taxProfile?.medicareExempt === true;
  const tax = (x) => (nonResident ? marginalTaxNonResident(x * k, key) : marginalTax(x * k, key)) / k;
  const levy = (x) => (noLevy ? 0 : medicareLevy(x * k) / k);
  const lito = (x) => (nonResident ? 0 : litoAmount(x * k) / k);

  const franked = Math.max(0, distributions.franked || 0);
  const unfranked = Math.max(0, distributions.unfranked || 0);
  const frankingCredits = franked * FRANKING_RATE;

  // Taxable income base: gross income + grossed-up distributions less
  // deductions, plus any excess concessional super contributions
  // (Tier 1.2 — assessable at the marginal rate like ordinary income,
  // including for Medicare/LITO purposes). Excess deductions floor at
  // zero (revenue losses are not carried in this model).
  const excessCC = Math.max(0, excessConcessionalContributions);
  const base = Math.max(0, ordinaryIncome + franked + unfranked + frankingCredits - deductions + excessCC);

  // Capital losses: a net loss year adds to the carry-forward; a gain
  // year consumes carried losses before any tax (losses never offset
  // ordinary income).
  let taxableGain = 0;
  let lossCarryFwd = Math.max(0, capitalLossCarryFwd);
  if (netCapitalGain < 0) {
    lossCarryFwd += -netCapitalGain;
  } else if (netCapitalGain > 0) {
    const used = Math.min(lossCarryFwd, netCapitalGain);
    taxableGain = netCapitalGain - used;
    lossCarryFwd -= used;
  }

  const incomeTax = tax(base);
  const medicare = levy(base);
  // LITO withdraws on total taxable income (the gain is part of it)
  // but only ever offsets the income-tax side, never Medicare.
  const litoApplied = Math.min(lito(base + taxableGain), incomeTax);
  // Excess-CC offset applies after LITO, non-refundable (capped at
  // whatever income tax remains) — the 15% already paid in the fund,
  // credited back against (not exempting) the marginal-rate tax on it.
  const excessCcOffset = Math.min(excessCC * excessConcessionalOffsetRate, Math.max(0, incomeTax - litoApplied));
  const netIncomeTax = incomeTax - litoApplied - excessCcOffset + medicare - frankingCredits;

  // CGT: the gain stacks on top of the income base. Marginal tax and
  // Medicare on the gain by differencing; post-reform (FY2027-28
  // onward) the 30% minimum-tax floor applies to the marginal
  // component before Medicare, matching the engine's simple_max.
  let cgtTax = 0;
  if (taxableGain > 0) {
    const marginalOnGain = tax(base + taxableGain) - incomeTax;
    const medicareOnGain = levy(base + taxableGain) - medicare;
    const floor = fyStartYear >= 2027 ? taxableGain * LEG.minimumTaxRate : 0;
    cgtTax = Math.max(marginalOnGain, floor) + medicareOnGain;
  }

  return {
    incomeTax,
    medicare,
    lito: litoApplied,
    excessCcOffset,
    frankingCredits,
    netIncomeTax,
    cgtTax,
    taxableIncome: base + taxableGain,
    taxableGain,
    lossCarryFwd,
  };
}
