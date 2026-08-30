// Focus: Aged care accommodation (spec 29, Commit 3) — the RAD/DAP/
// combination decision, three arms side by side. Every arm comes from
// a REAL projectPlan() run on a mutated clone of the actual plan,
// following focusAgePensionStrategy.js's own "clone, mutate, re-run,
// zip" pattern — never a hand-derived estimate.
//
// Each arm simulates the aged care event using EXISTING plan-state
// primitives (a one-off lump-sum withdrawal for the RAD, an ongoing
// expense row for the DAP + basic daily fee + means-tested fee/
// contributions + extra services) rather than a first-class
// `state.agedCare` entry — that first-class model, and the real
// household-cashflow/deficit-funding integration, is Commit 5's job (a
// genuinely new money flow, gated by CLAUDE.md's own rule on extending
// randomScenario()/the conservation invariant in the SAME commit it
// lands). This view is a planning estimate against the plan as it
// stands today.
//
// The means-tested fee / NCCC+Hotelling contributions ARE computed
// here (BBB-sourced formulas, agedCareMeansTest.js) using each
// person's own share of the household's assessable income/assets the
// real engine already computed for the Age Pension (row.agePensionDetail)
// — which EXCLUDES the former home and any RAD entirely, by
// construction (the Age Pension exempts the home outright and never
// hears about a RAD at all). This Focus view does not yet model a
// RETAINED former home (Commit 5's own input field, "protected-person
// status of the former home") — only the RAD itself is added on top as
// the aged-care-specific assessable asset (§5.6's own asymmetry: exempt
// from the Age Pension, assessable here).
//
// Non-prescriptive (spec's own words): reports total cost of care,
// remaining assets, and the estate position for all three arms side by
// side, and picks no winner. The RAD-vs-DAP trade-off is genuinely
// two-sided — a RAD held for years is refunded at a nominal amount
// worth less in real terms by then (radRealValueAtYear), set against a
// DAP being money that never comes back at all — AND a bigger RAD
// increases the ongoing means-tested fee (the central, easy-to-invert
// trade-off the spec names explicitly).
import { projectPlan } from "./deterministic.js";
import { firstFyStartYear } from "./schedule.js";
import { agePensionRatesFor } from "./data/agePension.js";
import { agedCareRatesFor, basicDailyFeeAnnual, combinationPayment, radRealValueAtYear, radRefundOnExit } from "./data/agedCare.js";
import { agedCareAssessableAssets, oldRegimeMeansTestedFee, newRegimeContributions, agedCareRegimeFor, noWorseOffComparison } from "./agedCareMeansTest.js";

// The three arms — RAD-only and DAP-only are just the two ends of the
// same combinationPayment() calculation (spec's own framing).
const ARM_DEFS = [
  { id: "rad", label: "RAD in full", radPaidOf: (price) => price },
  { id: "dap", label: "DAP in full", radPaidOf: () => 0 },
  { id: "combination", label: "Combination", radPaidOf: (price, radAmount) => Math.max(0, Math.min(radAmount, price)) },
];

// buildAgedCareAccommodationFocus({ state, accommodationPrice,
// radAmount, entryAge, extraServiceFeesAnnual, fundingAssetId,
// optedIntoNewRegime }) → { entryAge, entryYear, regime, arms, byYear,
// estate } or null if the inputs can't support a projection.
export function buildAgedCareAccommodationFocus({
  state, accommodationPrice, radAmount = 0, entryAge, extraServiceFeesAnnual = 0, fundingAssetId,
  optedIntoNewRegime = false,
}) {
  if (!(accommodationPrice > 0) || entryAge == null || !fundingAssetId) return null;
  const asset = state.assets.find((a) => a.id === fundingAssetId && a.include);
  if (!asset) return null;

  const baseOut = projectPlan(state);
  const entryY = baseOut.schedule.clientAges.findIndex((age) => age >= entryAge);
  if (entryY < 0) return null; // entry age never reached within this projection

  const bracketMode = state.assumptions.bracketMode === "frozen" ? "frozen" : "indexed";
  const cpi = state.assumptions.cpi;
  const awote = state.assumptions.awote ?? 0.032;
  const fyStartYear = firstFyStartYear(state.plan.start) + entryY;
  const entryDate = new Date(fyStartYear, 6, 1); // one-off events in this engine always fire in July — see module header
  const regime = agedCareRegimeFor(entryDate, optedIntoNewRegime);
  const isCouple = state.plan.household !== "single";

  const singleAgePensionRateAnnual = agePensionRatesFor(fyStartYear, bracketMode, cpi, awote).single.rate;
  const basicDailyAnnual = basicDailyFeeAnnual(singleAgePensionRateAnnual);
  const agedCareRates = agedCareRatesFor(fyStartYear, bracketMode, cpi, state.assumptions.agedCare);
  const mpirAtEntry = agedCareRates.mpir;

  // Per-person assessable income/assets: the Age Pension's own already-
  // computed household combined figures (row.agePensionDetail), halved
  // for a couple — the SAME convention agePensionMeansTest.js's own
  // couple handling uses. These EXCLUDE the former home entirely (Age
  // Pension exempts it) and never include a RAD (never told about it)
  // — the RAD is added back in below, per person, as the aged-care-
  // specific assessable asset.
  const entryRow = baseOut.yearly[entryY];
  const householdAssessableAssets = entryRow.agePensionDetail?.assessableAssets ?? 0;
  const householdAssessableIncome = entryRow.agePensionDetail?.assessableIncome ?? 0;
  const personAssessableAssets = isCouple ? householdAssessableAssets / 2 : householdAssessableAssets;
  const personAssessableIncome = isCouple ? householdAssessableIncome / 2 : householdAssessableIncome;

  const arms = ARM_DEFS.map((def) => {
    const radPaid = def.radPaidOf(accommodationPrice, radAmount);
    const { unpaidBalance, dapAnnual } = combinationPayment({ accommodationPrice, radPaid, mpirAtEntry });

    const assessableAssets = agedCareAssessableAssets({ otherFinancialAssets: personAssessableAssets, radPaid });
    let contributionAnnual = 0;
    if (regime === "old") {
      contributionAnnual = oldRegimeMeansTestedFee({
        assessableIncome: personAssessableIncome, assessableAssets, isCouple, rates: agedCareRates,
      }).fee;
    } else if (regime === "new") {
      contributionAnnual = newRegimeContributions({
        assessableIncome: personAssessableIncome, assessableAssets, isCouple, rates: agedCareRates,
      }).total;
    }
    // regime === "pre2014" is flagged, not modelled — contributionAnnual stays 0, disclosed via `regime` on the result.

    const otherAnnual = basicDailyAnnual + contributionAnnual + Math.max(0, extraServiceFeesAnnual);

    const clone = structuredClone(state);
    if (radPaid > 0) {
      clone.cashflows.lumpSums = [
        ...(clone.cashflows.lumpSums ?? []),
        {
          id: `agedcare-focus-rad-${def.id}`, assetId: fundingAssetId, amount: radPaid,
          direction: "out", at: { kind: "age", age: entryAge }, source: "input",
        },
      ];
    }
    const newExpenseRows = [];
    // DAP indexation is a named 2025-reform mechanic (BBB §4): indexed
    // with CPI on 20 March/20 September for 1 Nov 2025+ entrants;
    // NOT indexed at all for earlier entrants — held flat in NOMINAL
    // dollars, so its REAL value decays (this engine's own "none"
    // basis, per CLAUDE.md's indexation formula). Split into its own
    // row so the two mechanics don't share one indexBasis.
    if (dapAnnual > 0) {
      newExpenseRows.push({
        id: `agedcare-focus-dap-${def.id}`, label: "Aged care DAP (Focus estimate)", labelIsDefault: false,
        category: "other", amount: dapAnnual, frequency: "annual",
        from: { kind: "age", age: entryAge }, to: { kind: "anchor", anchorId: "end" },
        indexBasis: regime === "new" ? "cpi" : "none", indexExtraPct: 0,
      });
    }
    // Basic daily fee and the means-tested contribution/NCCC+Hotelling
    // are both genuinely CPI-linked (they derive from CPI/AWOTE-indexed
    // rates each FY in the real system) regardless of regime.
    if (otherAnnual > 0) {
      newExpenseRows.push({
        id: `agedcare-focus-cost-${def.id}`, label: "Aged care fees (Focus estimate)", labelIsDefault: false,
        category: "other", amount: otherAnnual, frequency: "annual",
        from: { kind: "age", age: entryAge }, to: { kind: "anchor", anchorId: "end" },
        indexBasis: "cpi", indexExtraPct: 0,
      });
    }
    if (newExpenseRows.length > 0) clone.cashflows.expenses = [...clone.cashflows.expenses, ...newExpenseRows];
    return {
      id: def.id, label: def.label, radPaid, unpaidBalance, dapAnnualCost: dapAnnual,
      basicDailyAnnual, contributionAnnual, out: projectPlan(clone),
    };
  });
  // Disclosed simplification: the means-tested fee/contribution is
  // computed ONCE at entry and held flat (CPI-indexed) for the whole
  // projection, like the DAP and basic daily fee — it does not
  // re-derive from each future year's own changing income/assets, and
  // the lifetime cap/4-year NCCC limit is NOT dynamically enforced
  // here (trackLifetimeCare, data/agedCare.js, is available for a
  // caller that needs it). This is a planning ESTIMATE; the real,
  // year-by-year recomputation against the actual future ledger is
  // Commit 5's job, once aged care is a first-class engine concept.

  const years = baseOut.yearly.length;
  const byYear = [];
  for (let y = entryY; y < years; y++) {
    const point = { year: y, fyLabel: baseOut.schedule.fyLabels[y], age: baseOut.schedule.clientAges[y] };
    for (const arm of arms) {
      const row = arm.out.yearly[y];
      const baseRow = baseOut.yearly[y];
      point[arm.id] = {
        costThisYear: Math.max(0, row.expenses - baseRow.expenses),
        remainingAssets: row.netAssets,
      };
    }
    byYear.push(point);
  }
  const cumulative = { rad: 0, dap: 0, combination: 0 };
  for (const point of byYear) {
    for (const arm of arms) {
      cumulative[arm.id] += point[arm.id].costThisYear;
      point[arm.id].cumulativeCost = cumulative[arm.id];
    }
  }

  const finalYear = years - 1;
  const yearsInCare = finalYear - entryY;
  const estate = {};
  for (const arm of arms) {
    const finalRow = arm.out.yearly[finalYear];
    // The estate position adds back the RAD refund — money the engine
    // itself has no concept of (it only sees the lump sum LEAVE the
    // funding asset) but which returns to the estate on exit/death.
    // Retention (2025 reforms: 2% pa, up to 5 years, new-regime
    // entrants only) is applied to the NOMINAL amount refunded before
    // converting to today's real dollars — a RAD held for years is
    // refunded at a SMALLER nominal amount than paid (retention) which
    // is ALSO worth less in real terms by then (inflation) — both
    // effects stack, never offset each other.
    const { refund } = radRefundOnExit({ radPaid: arm.radPaid, yearsInCare, enteredFrom1Nov2025: regime === "new" });
    estate[arm.id] = finalRow.netAssets + radRealValueAtYear(refund, cpi, yearsInCare);
  }

  // "No worse off" comparison (spec 29 Commit 4) — only meaningful for
  // a genuinely pre-1 Nov 2025 entrant who has an actual CHOICE to opt
  // in; a 1 Nov 2025+ entrant is already on the new regime with no
  // alternative, and a pre-2014 entrant's old-regime figure isn't
  // modelled at all. Computed once, against the RAD-in-full arm's own
  // assessable assets (the comparison is about the FEE REGIME, not the
  // accommodation choice, so any arm's own assessable-assets figure
  // would do — RAD-in-full is used for a single, consistent reference
  // point across the whole comparison).
  let noWorseOff = null;
  if (regime === "old") {
    const radArmAssets = agedCareAssessableAssets({ otherFinancialAssets: personAssessableAssets, radPaid: accommodationPrice });
    noWorseOff = noWorseOffComparison({ assessableIncome: personAssessableIncome, assessableAssets: radArmAssets, isCouple, rates: agedCareRates });
  }

  return {
    entryAge, entryYear: entryY, regime, noWorseOff,
    arms: arms.map(({ id, label, radPaid, unpaidBalance, dapAnnualCost, basicDailyAnnual, contributionAnnual }) =>
      ({ id, label, radPaid, unpaidBalance, dapAnnualCost, basicDailyAnnual, contributionAnnual })),
    byYear, estate,
  };
}
