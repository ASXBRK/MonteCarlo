// Division 296 — two-tier tax on high superannuation balances (Super
// thresholds Commit 2). Commenced 1 July 2026 (Royal Assent 13 March
// 2026); this models the October 2025 revised design, NOT the lapsed
// 2023 bill — the two differ in three ways this module encodes:
//   - Earnings are REALISED only (fund-level realised income: interest,
//     dividends, rent, and gains on assets actually sold), not the
//     lapsed design's unrealised total-superannuation-balance movement.
//   - A second, higher tier applies above $10m (the lapsed design had
//     only the $3m tier).
//   - Both thresholds ARE indexed (see superRates.js's
//     div296LowerThreshold/div296UpperThreshold — CPI, $150,000 steps
//     for the lower threshold, $500,000 steps for the upper).
//
// Formula (proportional method, matching the Government's own worked
// examples):
//   tax = 0.15 × proportionAboveLower × earnings
//       + 0.10 × proportionAboveUpper × earnings
//   proportionAboveX = max(TSB − X, 0) / TSB
//
// The two terms overlap by design: proportionAboveLower already
// includes whatever lies above the upper threshold too, so earnings
// attributable to a balance above $10m effectively draw BOTH the 15%
// and the 10% additional rates (25% Division 296 tax, on top of the
// fund's own 15% earnings tax = 40% effective) — while earnings between
// $3m and $10m draw only the 15% term (30% effective). This is exactly
// the Government's published two-tier structure, not an independent
// second bracket.
//
// TSB for the proportions is the HIGHER of opening and closing TSB — a
// documented simplification (the member doesn't get to choose whichever
// measurement date minimises their proportion).
//
// Realised earnings is this tool's LARGEST approximation in this
// feature: every super account's growth is already modelled as smoothly
// realised every year (the same smoothing simplification the ordinary
// 15%/10% fund earnings tax uses — see deterministic.js's super
// crediting step), rather than tracking which gains were actually
// crystallised by a sale inside the fund this year. A negative-earnings
// year pays zero Division 296 tax, not a refund (the formula would
// otherwise imply one) — not modelled: the release-from-fund election,
// and the SMSF CGT cost-base reset election for the FY2026-27
// transition.
export function div296Tax({ openingTsb, closingTsb, earnings, lowerThreshold, upperThreshold }) {
  const tsb = Math.max(openingTsb, closingTsb);
  if (!(tsb > lowerThreshold)) return { tsb, proportionAboveLower: 0, proportionAboveUpper: 0, tax: 0 };
  const proportionAboveLower = Math.max(0, tsb - lowerThreshold) / tsb;
  const proportionAboveUpper = Math.max(0, tsb - upperThreshold) / tsb;
  const earningsForTax = Math.max(0, earnings); // negative-earnings years pay zero, not a rebate
  const tax = 0.15 * proportionAboveLower * earningsForTax + 0.10 * proportionAboveUpper * earningsForTax;
  return { tsb, proportionAboveLower, proportionAboveUpper, tax };
}
