// Annual state land tax on non-exempt (non-PPR) land — all eight
// Australian jurisdictions, same encoding pattern as stampDuty.js:
// per-jurisdiction progressive bracket tables, held at nominal-dollar
// values as at a stated date (not indexed here), with a per-property
// override for precision.
//
// VERIFICATION STATUS: WA's general scale was cross-checked this
// session against multiple secondary sources (calculator sites plus
// RSM Australia commentary, via web search) that independently
// converge on the same bracket edges — RevenueWA's own site could not
// be reached directly (network egress to *.wa.gov.au is blocked from
// this build environment), so treat it as corroborated-but-not-
// primary-sourced rather than fully verified, and reconfirm against
// RevenueWA before this is relied on for advice. Every other
// jurisdiction is an UNVERIFIED, deliberately simplified (2-4 bracket)
// approximation from training knowledge — confirm each against its own
// revenue office. NT does not levy a general land tax at all (a stable,
// well-established fact, not a simplification).
//
// Land tax is assessed on UNIMPROVED land value; this tool holds total
// property value, so `landValuePct` (default 50% for a house, 20% for
// a unit — a unit's land is shared across the whole strata; editable
// per property — see planState.js's own header, and assumptions-
// provenance.md §7.4) estimates the land component. This is the single
// largest approximation in the feature, disclosed per the spec's own
// instruction. Metropolitan/regional and
// absentee/foreign-owner surcharges (e.g. WA's MRIT, NSW/VIC/QLD
// foreign-owner surcharges) are NOT modelled.
export const LAND_TAX_META = Object.freeze({
  asAt: "2025-07-01",
  note: "WA corroborated via multiple secondary sources this session (RevenueWA itself unreachable — network egress blocked); every other jurisdiction is an UNVERIFIED simplified approximation. Land value defaults to 60% of total property value (editable per property) — the largest disclosed approximation here. Metropolitan/foreign-owner surcharges not modelled.",
});

// [floor, base, rate] rows, same convention as stampDuty.js's general
// bracket table: tax = base + rate × (value − floor) for the row whose
// floor is the largest not exceeding the value.
const SCHEDULES = {
  // Corroborated this session via web search against multiple secondary
  // sources (calculator sites + RSM Australia commentary); RevenueWA's
  // own page was not directly reachable — reconfirm before relying on
  // this for advice. General scale, individuals (non-trust), 2025-26.
  // Tax-free below $300,000.
  WA: {
    brackets: [
      [0, 0, 0],
      [300000, 300, 0],
      [420000, 300, 0.0025],
      [1000000, 1750, 0.009],
      [1800000, 8950, 0.018],
      [5000000, 66500, 0.02],
      [11000000, 186550, 0.0267],
    ],
  },
  // UNVERIFIED — simplified training-knowledge approximation of the
  // general (non-trust) land tax scale. Confirm against
  // revenue.nsw.gov.au. Tax-free below $1,075,000.
  NSW: {
    brackets: [
      [0, 0, 0],
      [1075000, 100, 0.016],
      [6571000, 88036, 0.02],
    ],
  },
  // UNVERIFIED — simplified approximation. Confirm against sro.vic.gov.au.
  // Tax-free below $50,000.
  VIC: {
    brackets: [
      [0, 0, 0],
      [50000, 0, 0.002],
      [100000, 100, 0.005],
      [300000, 1100, 0.0105],
      [600000, 4250, 0.0165],
      [1000000, 10850, 0.0225],
      [1800000, 28850, 0.03],
      [3000000, 64850, 0.0315],
    ],
  },
  // UNVERIFIED — simplified approximation. Confirm against qro.qld.gov.au.
  // Tax-free below $600,000 (individuals).
  QLD: {
    brackets: [
      [0, 0, 0],
      [600000, 500, 0.01],
      [1000000, 4500, 0.0165],
      [3000000, 37500, 0.0175],
      [5000000, 72500, 0.0225],
    ],
  },
  // UNVERIFIED — simplified approximation. Confirm against revenuesa.sa.gov.au.
  // Tax-free below $732,000.
  SA: {
    brackets: [
      [0, 0, 0],
      [732000, 0, 0.005],
      [1259000, 2635, 0.02],
      [1731000, 12075, 0.024],
    ],
  },
  // UNVERIFIED — simplified approximation. Confirm against sro.tas.gov.au.
  // Tax-free below $50,000.
  TAS: {
    brackets: [
      [0, 0, 0],
      [50000, 50, 0.0055],
      [400000, 1975, 0.015],
    ],
  },
  // UNVERIFIED — simplified approximation of the ACT's general (AUV-
  // based) rating and land tax charge for a non-exempt residential
  // property, which — unlike the other states — has no general
  // tax-free threshold for an investment/holiday property. Confirm
  // against revenue.act.gov.au.
  ACT: {
    brackets: [
      [0, 1392, 0.0068],
    ],
  },
  // The Northern Territory does not levy a general land tax on
  // residential landholders — a stable, well-established fact, not a
  // simplification.
  NT: {
    brackets: [
      [0, 0, 0],
    ],
  },
};

export const LAND_TAX_STATES = Object.keys(SCHEDULES);

// Land tax on an aggregated unimproved land value within one
// jurisdiction (the caller aggregates across an owner's properties in
// the same state before calling this — see deterministic.js).
export function landTaxOnValue(stateCode, aggregatedLandValue) {
  const s = SCHEDULES[stateCode];
  if (!s || !(aggregatedLandValue > 0)) return 0;
  let row = s.brackets[0];
  for (const b of s.brackets) {
    if (aggregatedLandValue >= b[0]) row = b;
    else break;
  }
  const [floor, base, rate] = row;
  return Math.max(0, base + rate * (aggregatedLandValue - floor));
}
