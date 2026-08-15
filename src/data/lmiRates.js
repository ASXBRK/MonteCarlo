// Lenders Mortgage Insurance (LMI) premium table — Document Set
// Commit 4. Applies above 80% LVR; premium is a % of the loan amount,
// varying by LVR band and loan-size band (larger loans attract a
// slightly higher rate at the same LVR — the standard shape of a
// published LMI premium calculator).
//
// VERIFICATION STATUS: this table is INDICATIVE — built from the
// general shape of published LMI premium calculators (e.g. Helia/
// Genworth-style LVR × loan-size tiering), not transcribed from any
// single insurer's live rate card (egress to verify against one is
// blocked from this build environment — same constraint noted in
// src/data/stampDuty.js's header). Confirm against the firm's panel
// lender/LMI provider before relying on this for advice. The
// per-purchase manual override field exists for exactly this reason —
// same escape hatch as the stamp duty override.
export const LMI_META = Object.freeze({
  asAt: "2026-07-01",
  note: "Indicative LVR × loan-size premium tiering, NOT a specific insurer's published rate card — confirm before client use. Use the LMI override for precision.",
});

// Loan-size band floors — the rate for a given loan amount is whichever
// band's floor is the highest one at or below it.
const LOAN_BAND_FLOORS = [0, 300000, 500000, 750000];

// Each row's `rates` array has one rate per loan-size band above,
// in the same order. Bands are (floor, ceiling] on LVR — 80% itself
// pays no LMI (lmiPremium returns 0 at/below 80).
const LVR_BANDS = [
  { floor: 80, ceiling: 85, rates: [0.5, 0.57, 0.65, 0.72] },
  { floor: 85, ceiling: 90, rates: [1.0, 1.15, 1.3, 1.45] },
  { floor: 90, ceiling: 95, rates: [2.0, 2.3, 2.6, 2.9] },
  { floor: 95, ceiling: 100, rates: [3.5, 3.9, 4.3, 4.7] },
];

function loanBandIndex(loanAmount) {
  let idx = 0;
  for (let i = 0; i < LOAN_BAND_FLOORS.length; i++) {
    if (loanAmount >= LOAN_BAND_FLOORS[i]) idx = i;
  }
  return idx;
}

// lmiPremium(lvrPct, loanAmount) → the $ premium, from the embedded
// table. 0 at or below 80% LVR. Above 100% is clamped to the top band
// (not realistically financeable, but never throws).
export function lmiPremium(lvrPct, loanAmount) {
  if (!(lvrPct > 80) || !(loanAmount > 0)) return 0;
  const band = LVR_BANDS.find((b) => lvrPct > b.floor && lvrPct <= b.ceiling) ?? LVR_BANDS.at(-1);
  return loanAmount * (band.rates[loanBandIndex(loanAmount)] / 100);
}
