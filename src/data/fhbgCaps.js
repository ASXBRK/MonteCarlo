// First Home Guarantee (FHBG) property price caps — Document Set
// Commit 4. One cap per state/territory (Housing Australia's real
// caps split capital-city/regional-centre from the rest of the state;
// this tool has no postcode/region field on a property, so the higher
// (capital-city) figure is used for the whole state — a disclosed
// simplification, same granularity stampDuty.js already uses for
// property.state).
//
// VERIFICATION STATUS: INDICATIVE figures — built from training
// knowledge of the scheme's general price-cap shape, not transcribed
// from a live Housing Australia page this session (egress to verify
// is blocked from this build environment, same constraint as
// src/data/stampDuty.js's and src/data/lmiRates.js's headers). Price
// caps are reviewed periodically by the scheme administrator — confirm
// the current figures before relying on this for advice.
export const FHBG_META = Object.freeze({
  asAt: "2026-07-01",
  note: "Indicative price caps (capital-city/regional-centre figure used for the whole state — no postcode/region field on a property). Confirm against Housing Australia before client use.",
});

export const FHBG_PRICE_CAPS = Object.freeze({
  NSW: 900000,
  VIC: 800000,
  QLD: 700000,
  WA: 600000,
  SA: 600000,
  TAS: 600000,
  ACT: 750000,
  NT: 600000,
});

// fhbgPriceCapExceeded(stateCode, price) → true when the purchase price
// is over the state's cap — a flag, never a block (caps change and a
// user may know the current figure differs from this table).
export function fhbgPriceCapExceeded(stateCode, price) {
  const cap = FHBG_PRICE_CAPS[stateCode];
  return cap != null && price > cap;
}
