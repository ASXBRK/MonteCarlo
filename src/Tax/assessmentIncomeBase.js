// One function answering "what is this person's assessment income for
// year Y", for the bases that share this exact shape — a taxable-
// income figure plus a specific set of add-back terms — with the base
// itself as a parameter, per docs/specs/41-dependency-ordering-
// density.md Commit 3. Replaces two independent computations that had
// each needed the identical fix at a different time (Division 293
// excluded the year's own net capital gain until spec 37 Commit 5;
// HELP/MLS had the identical gap until spec 39 Commit 2) — the same
// income-base concept, patched twice at two separate call sites,
// because there was no one place to patch.
//
// HELP and MLS share an IDENTICAL formula today, and are kept as two
// distinct base ids rather than merged into one "surchargeableIncome"
// concept: the ATO defines them independently, and a future
// refinement (this tool doesn't model exempt foreign employment
// income, which the ATO's own HELP definition adds as a fifth
// component HELP has and MLS doesn't) could diverge them — merging the
// ids now would have to be un-merged later.
//
// Division 293 is included; Division 296 deliberately is NOT — see
// div296.js's own div296Tax(): its base is the higher of opening/
// closing TSB for threshold proportioning and realised fund earnings
// for the tax itself, neither of which is a "taxable income plus add-
// backs" figure. Forcing it through this same shape would be a false
// unification, not a real one — and unlike Division 293/HELP/MLS, it
// already has exactly one call site (deterministic.js's own Division
// 296 block), so there was no parallel derivation to consolidate in
// the first place.
export function assessmentIncomeBase(base, {
  taxableIncome, reportableSuperContributions = 0, reportableFringeBenefits = 0,
  lowTaxContributions = 0, netInvestmentLoss = 0,
} = {}) {
  switch (base) {
    // Division 293 (spec 37 Commit 5, finding 1.8): taxable income +
    // reportable super contributions + low-tax contributions +
    // reportable fringe benefits. Net investment losses are NOT added
    // back here — a documented, pre-existing gap (superContributions.js
    // carried this same note before this consolidation), not something
    // this commit changes.
    case "div293":
      return taxableIncome + reportableSuperContributions + lowTaxContributions + reportableFringeBenefits;
    // HELP repayment income / MLS surcharge income (Document Set
    // Commits 1-2, spec 39 Commit 2): taxable income + reportable super
    // contributions + net investment loss + reportable fringe benefits.
    // Low-tax contributions are NOT added back — that term is
    // Division-293-specific.
    case "help":
    case "mls":
      return taxableIncome + reportableSuperContributions + netInvestmentLoss + reportableFringeBenefits;
    default:
      throw new Error(`assessmentIncomeBase: unknown base "${base}"`);
  }
}
