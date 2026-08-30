// Focus: Aged care planning (spec 29, Commit 5) — pre-entry strategies,
// compared against the plan exactly as entered. Unlike Commit 3's
// accommodation view (a planning ESTIMATE built from ad hoc cashflow
// rows, before aged care was a first-class engine concept), this view
// falls out of what already exists, per the spec's own words: the
// household's real `plan.agedCare[]` entry is already a genuine engine
// money flow (deterministic.js), and a pre-entry gift is a genuine
// `plan.gifts[]` entry — both run through the SAME real projectPlan(),
// never a second calculation (the Focus governing principle).
//
// "One or two pre-entry strategies" (spec's own words): the current
// plan as its own baseline arm, plus one optional pre-entry gift arm.
// The gift's timing relative to the aged care entry's own resolved age
// is the whole point — move it inside five years of entry and the
// engine's OWN deprivation modelling (spec 21b, gifting.js) catches it
// automatically, since this is a REAL plan.gifts[] entry running
// through the REAL engine, not a hand-rolled caveat. No separate
// "estate position" calculation either — it's exactly the final year's
// NET ASSETS, the same figure every other view reads.
import { projectPlan } from "./deterministic.js";
import { resolveGiftDeprivation, GIFT_DEPRIVATION_MONTHS } from "./gifting.js";

// Household total cost of aged care over a full projection run — every
// entry's own ongoing cost (row.agedCareDetail) plus every RAD lump sum
// paid (row.agedCareRadPaid), summed across every year. Household-level
// by construction (agedCareRadPaid carries no per-entry split in the
// engine — see deterministic.js) — the same total the Key Figures
// view's own "Total cost of aged care (cumulative)" row reads, just
// taken at the final year rather than shown year by year.
function totalCostOfCare(out) {
  let total = 0;
  for (const row of out.yearly) {
    total += Object.values(row.agedCareDetail ?? {}).reduce((sum, d) => sum + (d.total ?? 0), 0);
    total += row.agedCareRadPaid ?? 0;
  }
  return total;
}

// buildAgedCarePlanningFocus({ state, agedCareEntryId, giftAmount,
// giftYearsBeforeEntry }) → { entryAge, entryYear, entryName, arms:
// [{id, label, totalCostOfCare, estatePosition, giftAmount,
// giftAge, deprivationCaught}] } or null when the chosen entry never
// fires within this projection.
export function buildAgedCarePlanningFocus({ state, agedCareEntryId, giftAmount = 0, giftYearsBeforeEntry = 6 }) {
  const entry = (state.plan.agedCare ?? []).find((ac) => ac.id === agedCareEntryId);
  if (!entry) return null;

  const baseOut = projectPlan(state);
  // Defensive only: clampAgedCareEntry (planState.js) bounds entryAt to
  // [currentAge, endAge], and the engine's projection runs to endAge —
  // in practice every clamped entry therefore fires somewhere within
  // this run, the same "unenterable, not warned about" input-integrity
  // discipline CLAUDE.md names. Kept for a genuinely unresolvable edge
  // (a partial final year with no July left to fire in) that this
  // module's own test suite doesn't attempt to construct.
  const entryY = baseOut.yearly.findIndex((row) => (row.agedCareDetail ?? {})[entry.id]);
  if (entryY < 0) return null; // entry never fires within this projection
  const entryAge = baseOut.schedule.clientAges[entryY];

  const arms = [
    {
      id: "current", label: "Current plan (no pre-entry gift)",
      totalCostOfCare: totalCostOfCare(baseOut),
      estatePosition: baseOut.yearly[baseOut.yearly.length - 1].netAssets,
    },
  ];

  if (giftAmount > 0) {
    const giftAge = Math.max(state.plan.client.currentAge, entryAge - giftYearsBeforeEntry);
    const clone = structuredClone(state);
    clone.plan.gifts = [
      ...(clone.plan.gifts ?? []),
      {
        id: "focus-agedcare-planning-gift", owner: entry.owner, amount: giftAmount,
        at: { kind: "age", age: giftAge }, label: "Pre-entry gift (Focus estimate)",
      },
    ];
    const giftOut = projectPlan(clone);
    // The caveat the spec names explicitly — a gift above the $10,000/
    // $30,000 exempt limits is a DEPRIVED asset for exactly five years
    // (60 months) from the gift's own date (gifting.js). Resolved here
    // taken on its own (not netted against any other gift already in
    // the plan — a disclosed simplification; the real engine run above
    // already nets it correctly against the household's actual gifts,
    // this flag is only for the caveat message). Both conditions must
    // hold: some part of the gift actually exceeds the exempt limits,
    // AND the five-year window hasn't lapsed by the time of entry.
    const deprived = resolveGiftDeprivation([{ id: "focus-gift", month: 0, amount: giftAmount, planYear: 0 }])[0].deprived;
    const deprivationCaught = deprived > 0 && giftYearsBeforeEntry * 12 < GIFT_DEPRIVATION_MONTHS;
    arms.push({
      id: "gift",
      label: `Gift ${giftYearsBeforeEntry} year${giftYearsBeforeEntry === 1 ? "" : "s"} before entry`,
      totalCostOfCare: totalCostOfCare(giftOut),
      estatePosition: giftOut.yearly[giftOut.yearly.length - 1].netAssets,
      giftAmount, giftAge, deprivationCaught,
    });
  }

  return { entryAge, entryYear: entryY, entryName: entry.name, arms };
}
