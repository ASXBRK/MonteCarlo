// Focus: Standalone lookups (docs/specs/12-focus-views.md, Commit 6) —
// the ONE deliberate exception to the governing principle: a lookup,
// not a projection, so it can't contradict the plan. Takes no
// plan/scenario input at all — reuses the SAME rate tables and
// functions the purchase engine calls (deterministic.js) against a
// typed-in price, instead of a property's own projected one. No new
// rate data lives here.
import { transferDuty, dutyWithConcessions, fhogAmount, STATES, STAMP_DUTY_META } from "./data/stampDuty.js";
import { lmiPremium, LMI_META } from "./data/lmiRates.js";
import { fhbgPriceCapExceeded, FHBG_META } from "./data/fhbgCaps.js";

export { STATES, STAMP_DUTY_META, LMI_META, FHBG_META };

// computeStampDutyLookup({ stateCode, price, firstHomeBuyer, newBuild })
// → duty payable (with any FHB concession applied), the general
// (no-concession) figure alongside it for comparison, and the FHOG —
// the exact same dutyWithConcessions/fhogAmount calls
// deterministic.js's purchase-event block makes, just against a
// typed-in price rather than a projected one.
export function computeStampDutyLookup({ stateCode, price, firstHomeBuyer = false, newBuild = false }) {
  const general = transferDuty(stateCode, price);
  const duty = dutyWithConcessions(stateCode, price, { firstHomeBuyer, newBuild });
  const fhog = fhogAmount(stateCode, price, { firstHomeBuyer, newBuild });
  return { stateCode, price, firstHomeBuyer, newBuild, general, duty, concessionSaving: general - duty, fhog };
}

// computeLmiLookup({ stateCode, price, lvrPct, firstHomeGuarantee }) →
// the LMI premium at the given LVR (0 at/below 80%), or the First Home
// Guarantee waiver — mirrors the purchase engine's own
// `p.firstHomeGuarantee ? 0 : lmiPremium(...)` precedence exactly —
// plus whether the price exceeds that state's own FHBG cap (a flag,
// never a block — the engine's own propertyWarnings do the same, not
// a refusal to waive).
export function computeLmiLookup({ stateCode, price, lvrPct, firstHomeGuarantee = false }) {
  const loanAmount = (lvrPct / 100) * price;
  const capExceeded = firstHomeGuarantee && fhbgPriceCapExceeded(stateCode, price);
  const lmi = firstHomeGuarantee ? 0 : lmiPremium(lvrPct, loanAmount);
  return { stateCode, price, lvrPct, firstHomeGuarantee, loanAmount, lmi, waived: firstHomeGuarantee, capExceeded };
}
