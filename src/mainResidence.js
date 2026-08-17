// Main residence exemption and the six-year absence rule (spec 19,
// Commit 5) — pure day-count arithmetic, no DOM/Plotly. Every date here
// is a literal ISO string (Property.acquisitionDate's own existing
// shape) — deterministic.js resolves each DateRef-anchored event to a
// calendar date (1 July of its resolved plan year, the same "annual
// one-off fires in July" convention every other age-anchored event in
// this engine already uses) before calling in here.
//
// The PPR is exempt while it is the main residence. Under the absence
// rule it stays exempt for up to six years while producing income
// (rented out), and INDEFINITELY if not producing income (a vacant
// holiday-style absence never starts the clock at all) — but only one
// property can be the main residence at a time, and only ONE
// moved-out/moved-back-in cycle is modelled here (the spec's own
// disclosed limit: successive absences, the choice between two
// properties as main residence, and home-office apportionment are all
// out of scope).
//
// Reoccupation "resets the clock" — the strategy the spec names is
// selling before six years of absence elapse SINCE the last time the
// owner moved back in; with only one cycle modelled, the practical
// effect is that a `movedBackInAt` date simply ends the absence window
// there rather than counting it through to the sale.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(fromISO, toISO) {
  return Math.max(0, Math.round((new Date(toISO).getTime() - new Date(fromISO).getTime()) / MS_PER_DAY));
}

function addYears(iso, years) {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

// exemptProportion(acquisitionDateISO, saleDateISO, mainResidence) → the
// fraction (0–1) of a PPR's capital gain that is CGT-exempt.
// mainResidence = { movedOutAt: ISO|null, producingIncome: bool, movedBackInAt: ISO|null }.
export function exemptProportion(acquisitionDateISO, saleDateISO, mainResidence) {
  const { movedOutAt, producingIncome, movedBackInAt } = mainResidence ?? {};
  if (!movedOutAt) return 1; // never absent — fully exempt throughout
  const totalDays = daysBetween(acquisitionDateISO, saleDateISO);
  if (totalDays <= 0) return 1;
  if (!producingIncome) return 1; // vacant absence — exempt indefinitely, no clock
  const sixYearMark = addYears(movedOutAt, 6);
  // The absence ends at reoccupation if that happens before the sale,
  // otherwise it runs through to the sale itself.
  const absenceEnd = movedBackInAt && new Date(movedBackInAt).getTime() < new Date(saleDateISO).getTime()
    ? movedBackInAt : saleDateISO;
  const nonExemptDays = daysBetween(sixYearMark, absenceEnd);
  const exemptDays = Math.max(0, totalDays - nonExemptDays);
  return exemptDays / totalDays;
}
