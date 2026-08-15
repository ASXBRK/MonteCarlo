// First Home Super Saver Scheme — Document Set Commit 3. Pure business
// logic (annual/lifetime cap acceptance, release-amount split); no
// engine/DOM knowledge. deterministic.js owns the year-sequential
// balance and the interaction with the property purchase event.
//
// Caps are flat nominal dollar figures fixed in the FHSSS legislation
// (not indexed), unlike the FY-keyed bracket tables in helpRates.js/
// mlsRates.js — so there is no *RatesFor(fyStartYear) function here.
//
// Source: ATO First Home Super Saver Scheme guidance, as at FY2026/27
// (the $15,000/$50,000 caps and the 85%/100% release split have been
// stable law since the scheme's 1 Jul 2018 start and the 2022 lifetime-
// cap increase to $50,000).
export const FHSSS_ANNUAL_CAP = 15000;
export const FHSSS_LIFETIME_CAP = 50000;
export const FHSSS_CONCESSIONAL_RELEASE_PCT = 0.85;
// The non-refundable tax offset applied to the taxable component of a
// release (85% of eligible concessional contributions + all associated
// earnings), reflecting the 15% contributions tax already paid in the
// fund plus a further margin — same "add to assessable income, credit
// back a flat offset" shape Tax/annual.js already uses for excess
// concessional contributions (excessConcessionalOffsetRate), just a
// different source and rate.
export const FHSSS_OFFSET_RATE = 0.30;

// fhsssAcceptContribution({ requestedConcessional, requestedNonConcessional,
//   lifetimeContributed }) → how much of THIS FY's eligible voluntary
// contributions count toward FHSSS, after the combined $15,000/year and
// $50,000/lifetime cap (both concessional and non-concessional draw on
// the SAME combined caps — the spec's own "both count toward the
// $15,000/year and $50,000 lifetime caps"). When a cap partially binds,
// the accepted amount is split proportionally between the two types
// (a disclosed simplification — the ATO's real determination has no
// "ordering" concept either, since it assesses the whole request at
// once).
export function fhsssAcceptContribution({ requestedConcessional, requestedNonConcessional, lifetimeContributed }) {
  const requestedTotal = Math.max(0, requestedConcessional) + Math.max(0, requestedNonConcessional);
  const capRemaining = Math.max(0, Math.min(FHSSS_ANNUAL_CAP, FHSSS_LIFETIME_CAP - lifetimeContributed));
  const accepted = Math.min(requestedTotal, capRemaining);
  const acceptedConcessional = requestedTotal > 0 ? accepted * (requestedConcessional / requestedTotal) : 0;
  const acceptedNonConcessional = accepted - acceptedConcessional;
  return {
    acceptedConcessional,
    acceptedNonConcessional,
    rejected: requestedTotal - accepted,
    newLifetimeContributed: lifetimeContributed + accepted,
  };
}

// fhsssReleaseAmounts({ concessionalBalance, nonConcessionalBalance,
//   earnings }) → the release split: 85% of eligible concessional
// contributions plus 100% of eligible non-concessional contributions
// plus all associated earnings, with the taxable/tax-free components
// kept separate — the concessional 15% notionally already taxed in the
// fund is never released (stays in super).
export function fhsssReleaseAmounts({ concessionalBalance, nonConcessionalBalance, earnings }) {
  const releasedConcessional = FHSSS_CONCESSIONAL_RELEASE_PCT * Math.max(0, concessionalBalance);
  const taxFreeComponent = Math.max(0, nonConcessionalBalance);
  const taxableComponent = releasedConcessional + Math.max(0, earnings);
  return {
    taxableComponent,
    taxFreeComponent,
    grossRelease: taxableComponent + taxFreeComponent,
  };
}
