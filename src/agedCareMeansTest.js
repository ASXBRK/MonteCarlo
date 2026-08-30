// Aged care means testing (spec 29) — a SEPARATE test from the Age
// Pension's own (agePensionMeansTest.js): different thresholds,
// different taper structure (including LITERAL PLATEAU bands under the
// 1 Nov 2025+ regime — never taper across one), and different
// former-home treatment. Pure mechanics only; nothing here reads plan
// state directly, matching every other means-test module.
//
// Two regimes (data/agedCare.js's own header has the full disclosure):
// oldRegimeMeansTestedFee() for 1 Jul 2014 – 31 Oct 2025 entrants (or
// opted-in — the caller decides, this module just computes whichever
// regime it's asked to); newRegimeContributions() for 1 Nov 2025+
// entrants (or opted in).
import { evaluateTieredAmount, trackLifetimeCare } from "./data/agedCare.js";

// formerHomeAssessedValueForMeansTest({ marketValue,
// occupiedByProtectedPerson, cappedValuePerPerson }) → the amount the
// former home contributes to the ONGOING means test's assessable
// assets — capped at $214,884 PER PERSON (data/agedCare.js's own
// figure), or fully EXEMPT while a protected person lives there (a
// spouse, dependent child, or carer/close relative meeting the
// eligibility conditions — this function takes the already-resolved
// boolean rather than modelling each protected-person TYPE, since the
// plan state has no carer/close-relative concept to model them
// individually against; see Commit 5's own input field).
//
// NOT the same figure as formerHomeValueForAccommodationAssessment()
// below — the BBB is explicit that the SAME asset gets TWO DIFFERENT
// treatments (capped here; full market value there). Conflating them
// is exactly the kind of error the spec's own sourcing rule guards
// against.
export function formerHomeAssessedValueForMeansTest({ marketValue, occupiedByProtectedPerson, cappedValuePerPerson }) {
  if (occupiedByProtectedPerson) return 0;
  return Math.min(Math.max(0, marketValue), cappedValuePerPerson);
}

// formerHomeValueForAccommodationAssessment({ marketValue,
// occupiedByProtectedPerson }) → the ONE-OFF accommodation assessment
// at entry (decides accommodation contribution vs payment, and RAD/DAP
// negotiability) uses the SAME protected-person exemption, but NO cap
// at all — full market value otherwise. See module header.
export function formerHomeValueForAccommodationAssessment({ marketValue, occupiedByProtectedPerson }) {
  if (occupiedByProtectedPerson) return 0;
  return Math.max(0, marketValue);
}

// formerHomeRentTreatment(entryDate) → which treatment applies to rent
// from a former home let out while the resident pays a DAP: rent was
// historically EXEMPT from the income test for entrants BEFORE 1
// January 2016; entrants from that date have the rent counted as
// assessable income (both regimes — the BBB's own §2 confirms this
// carries into the current rules).
const RENT_EXEMPTION_CUTOFF = "2016-01-01";
export function formerHomeRentTreatment(entryDate) {
  const d = entryDate instanceof Date ? entryDate : new Date(entryDate);
  if (Number.isNaN(d.getTime())) return null;
  return d < new Date(RENT_EXEMPTION_CUTOFF)
    ? { exempt: true, reason: `Entered care before ${RENT_EXEMPTION_CUTOFF} — rent from the former home is historically exempt from the aged care income test.` }
    : { exempt: false, reason: `Entered care on or after ${RENT_EXEMPTION_CUTOFF} — rent from the former home is assessable income.` };
}

// agedCareAssessableAssets({ otherFinancialAssets, formerHome, radPaid })
// → the total assessable-assets figure the assets test brackets are
// applied to. A RAD/RAC balance counts here EVEN THOUGH it is
// refundable — the spec's central, easy-to-invert trade-off (paying a
// large RAD to reduce accommodation cost INCREASES the means-tested
// fee). This is also the asymmetry the BBB's §5.6 names explicitly: a
// RAD is EXEMPT from the Age Pension's own assets/income tests — that
// exemption is realised simply by never passing the RAD into the Age
// Pension side's own assessableAssets() call at all (agePensionMeansTest.js),
// not by any special-casing here; the two sides never share a
// "financial assets" number that could accidentally include or
// exclude it inconsistently.
export function agedCareAssessableAssets({ otherFinancialAssets = 0, formerHome = 0, radPaid = 0 }) {
  return Math.max(0, otherFinancialAssets) + Math.max(0, formerHome) + Math.max(0, radPaid);
}

// --- 1 Jul 2014 – 31 Oct 2025 ("old") regime -------------------------------

// oldRegimeIncomeTestedAmount(assessableIncome, isCouple, rates) →
// 50% of income above the (single or per-couple-member) threshold — a
// SIMPLE single taper, no plateau, under the old regime.
export function oldRegimeIncomeTestedAmount(assessableIncome, isCouple, rates) {
  const threshold = isCouple ? rates.oldRegime.incomeThresholdCoupleEach : rates.oldRegime.incomeThresholdSingle;
  return Math.max(0, assessableIncome - threshold) * rates.oldRegime.incomeTaperRate;
}

// oldRegimeAssetsTestedAmount(assessableAssets, rates) — assessableAssets
// is ALREADY the per-person figure (a couple member's own half of the
// couple's combined assets — the caller's responsibility, same
// convention agePensionMeansTest.js's own couple handling uses).
export function oldRegimeAssetsTestedAmount(assessableAssets, rates) {
  return evaluateTieredAmount(assessableAssets, rates.oldRegime.assetsBrackets);
}

// oldRegimeMeansTestedFee({ assessableIncome, assessableAssets, isCouple,
// subsidyAmount, lifetimeCumulative, rates }) → the full formula:
// (income tested + assets tested) − max accommodation supplement,
// floored at 0, capped at the LEAST of the subsidy, the DAILY max
// (×365 — a separate constraint, applied alongside the annual one per
// the BBB's own note), the annual cap, and the remaining lifetime cap.
export function oldRegimeMeansTestedFee({ assessableIncome, assessableAssets, isCouple, subsidyAmount = Infinity, lifetimeCumulative = 0, rates }) {
  const incomeTested = oldRegimeIncomeTestedAmount(assessableIncome, isCouple, rates);
  const assetsTested = oldRegimeAssetsTestedAmount(assessableAssets, rates);
  const raw = Math.max(0, incomeTested + assetsTested - rates.maxAccommodationSupplementAnnual);
  const lifetimeCapRemaining = Math.max(0, rates.oldRegime.lifetimeCap - lifetimeCumulative);
  const fee = Math.max(0, Math.min(
    raw, subsidyAmount, rates.oldRegime.dailyMax * 365, rates.oldRegime.annualCap, lifetimeCapRemaining,
  ));
  return { incomeTested, assetsTested, raw, fee };
}

// --- 1 Nov 2025+ ("new") regime --------------------------------------------

// newRegimeIncomeTestedAmount/newRegimeAssetsTestedAmount — the SAME
// evaluateTieredAmount() bracket walk, against the plateau-bearing
// tables (data/agedCare.js's own header: "implement literally, not as
// a taper across the band" — evaluateTieredAmount already does this
// correctly for a "flat" bracket; nothing regime-specific needed here
// beyond picking the right table).
export function newRegimeIncomeTestedAmount(assessableIncome, isCouple, rates) {
  const brackets = isCouple ? rates.newRegime.incomeBracketsCoupleEach : rates.newRegime.incomeBracketsSingle;
  return evaluateTieredAmount(assessableIncome, brackets);
}
export function newRegimeAssetsTestedAmount(assessableAssets, rates) {
  return evaluateTieredAmount(assessableAssets, rates.newRegime.assetsBrackets);
}

// newRegimeContributions({ assessableIncome, assessableAssets, isCouple,
// ncccLifetimeCumulative, ncccYearsSoFar, rates }) → the Hotelling +
// NCCC split. ORDERING RULE (BBB §3): Hotelling saturates FIRST, up to
// its own max (which has NO cap at all beyond that daily max); the
// NCCC is only payable once Hotelling is AT its own max — never a
// share of "whatever's left" below that point. NCCC additionally
// ceases at the EARLIER of its lifetime cap or 4 years in — both
// checked; the caller tracks `ncccLifetimeCumulative` (trackLifetimeCare(),
// data/agedCare.js) and `ncccYearsSoFar` on the person.
export function newRegimeContributions({ assessableIncome, assessableAssets, isCouple, ncccLifetimeCumulative = 0, ncccYearsSoFar = 0, rates }) {
  const incomeTested = newRegimeIncomeTestedAmount(assessableIncome, isCouple, rates);
  const assetsTested = newRegimeAssetsTestedAmount(assessableAssets, rates);
  const meansTestedAmount = Math.max(0, incomeTested + assetsTested - rates.maxAccommodationSupplementAnnual);

  const hotelling = Math.min(meansTestedAmount, rates.newRegime.hotellingMaxAnnual);
  const remainderAfterHotelling = Math.max(0, meansTestedAmount - hotelling);
  const hotellingSaturated = hotelling >= rates.newRegime.hotellingMaxAnnual - 1e-9;
  const timeLimitReached = ncccYearsSoFar >= rates.newRegime.ncccTimeLimitYears;

  let nccc = 0, ncccCumulative = ncccLifetimeCumulative, ncccCapped = false;
  if (hotellingSaturated && !timeLimitReached) {
    const desired = Math.min(remainderAfterHotelling, rates.newRegime.ncccMaxAnnual);
    const tracked = trackLifetimeCare(ncccLifetimeCumulative, desired, rates.ncccLifetimeCap);
    nccc = tracked.charged;
    ncccCumulative = tracked.cumulative;
    ncccCapped = tracked.capped;
  }

  return {
    incomeTested, assetsTested, meansTestedAmount,
    hotelling, nccc, total: hotelling + nccc,
    ncccCumulative, ncccCapped, ncccTimeLimitReached: timeLimitReached,
  };
}

// agedCareRegimeFor(entryDate, optedIn) → "old" | "new" | "pre2014" —
// the regime FORK by entry date, never a migration (data/agedCare.js's
// own header). `optedIn` lets a pre-1-Nov-2025 entrant explicitly
// choose the new rules (the BBB's own words: "model the opt-in as a
// flag" — never silently switched). Pre-1 July 2014 residents are
// flagged and NOT modelled at all (spec's own words) — the caller must
// refuse to project a "pre2014" resident's fee rather than approximate
// it as either regime.
const NEW_REGIME_START = "2025-11-01";
const OLD_REGIME_START = "2014-07-01";
export function agedCareRegimeFor(entryDate, optedIn = false) {
  const d = entryDate instanceof Date ? entryDate : new Date(entryDate);
  if (Number.isNaN(d.getTime())) return null;
  if (d < new Date(OLD_REGIME_START)) return "pre2014";
  if (d >= new Date(NEW_REGIME_START)) return "new";
  return optedIn ? "new" : "old";
}

// noWorseOffComparison({ assessableIncome, assessableAssets, isCouple,
// lifetimeCumulative, rates }) → { oldFee, newTotal, betterUnder } for
// a PRE-1 NOVEMBER 2025 entrant only — the "no worse off" principle
// (BBB §3, spec's own Commit 4) lets such a resident stay on the old
// means-tested fee OR opt in to the new NCCC+Hotelling contributions;
// this reports BOTH annual figures side by side so the comparison is
// visible, never picks a winner (`betterUnder` names whichever is
// CHEAPER for the resident — "old"|"new"|"same" — a factual label, not
// advice). A 1 Nov 2025+ entrant has no such choice (already on the
// new regime) and a pre-1 Jul 2014 entrant's old-regime figure isn't
// modelled at all (agedCareRegimeFor's own "pre2014" flag) — the
// caller should not call this for either.
export function noWorseOffComparison({ assessableIncome, assessableAssets, isCouple, lifetimeCumulative = 0, rates }) {
  const oldFee = oldRegimeMeansTestedFee({ assessableIncome, assessableAssets, isCouple, lifetimeCumulative, rates }).fee;
  const newTotal = newRegimeContributions({ assessableIncome, assessableAssets, isCouple, rates }).total;
  const betterUnder = Math.abs(oldFee - newTotal) < 1e-6 ? "same" : (oldFee < newTotal ? "old" : "new");
  return { oldFee, newTotal, betterUnder };
}
