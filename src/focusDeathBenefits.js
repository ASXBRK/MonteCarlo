// Focus: Death benefits (spec 22, Commit 3) — pure, no DOM/Plotly.
// Non-prescriptive (locked convention, and the spec's own words for
// this feature specifically): report the tax difference and the
// constraints; never label a nomination or a strategy as "better" —
// that judgement belongs to the adviser and client, not this tool.
import { projectPlan, deathBenefitTax } from "./deterministic.js";
import { DEATH_BENEFIT_RELATIONSHIPS, isDeathBenefitTaxDependant } from "./planState.js";

// alternativeNominations(deathBenefitDetail) — "the cost of nominating
// an adult child rather than a spouse, or paying via the estate, is a
// number rather than an assertion" (spec's own words), for ONE
// person's already-computed final-year detail (out.yearly[last]
// .deathBenefitDetail[owner], from deterministic.js's Commit 1). A
// PURE recombination of the components already computed there — no
// re-projection needed, since only WHO receives the benefit changes
// here, never the underlying balance — reusing deathBenefitTax()
// (deterministic.js's own exported rule) so the two can never quietly
// diverge. Returns null when the person has no death benefit detail at
// all (nothing to compare).
export function alternativeNominations(deathBenefitDetail) {
  if (!deathBenefitDetail) return null;
  const totals = deathBenefitDetail.accounts.reduce((acc, a) => ({
    taxFree: acc.taxFree + a.taxFree,
    taxableTaxed: acc.taxableTaxed + a.taxableTaxed,
    taxableUntaxed: acc.taxableUntaxed + a.taxableUntaxed,
  }), { taxFree: 0, taxableTaxed: 0, taxableUntaxed: 0 });
  const gross = totals.taxFree + totals.taxableTaxed + totals.taxableUntaxed;
  return DEATH_BENEFIT_RELATIONSHIPS.map((relationship) => {
    const tax = deathBenefitTax(relationship, totals.taxableTaxed, totals.taxableUntaxed);
    return { relationship, gross, tax, net: gross - tax };
  });
}

// buildRecontributionFocus({ state, owner, withdrawalId, contributionId })
// → { owner, hasNonDependant, cannotHelp, withTax, withoutTax, taxSaved }
// or null when the nominated withdrawal/contribution isn't actually in
// the plan — "reflects an actually-modelled re-contribution, not a
// synthetic estimate" (spec's own words): this NEVER fabricates the
// withdrawal or contribution row itself, only compares the plan AS
// ALREADY MODELLED against a clone with that specific pair removed.
// Both arms are REAL projectPlan() runs — the same "clone, mutate,
// re-run, zip" pattern every other Focus view already uses
// (focusSalarySacrifice.js).
//
// Constraints (spec's own words) this module doesn't need to enforce
// itself — the engine already does, and any consequence shows up
// directly in the comparison: the non-concessional cap/bring-forward
// (an excess contribution is simply rejected, per the existing
// contribution machinery — superWarnings carries the disclosure) and
// the under-75 age gate (same rejection path). What this module DOES
// check is the one constraint that's specific to death benefits, not
// to contributions generally: the strategy only ever helps when there
// is a non-dependant beneficiary — a dependant already pays no tax at
// all, so converting taxable to tax-free component changes nothing for
// them. `cannotHelp` fires whenever every nominated beneficiary is a
// tax dependant, regardless of what the comparison itself shows.
export function buildRecontributionFocus({ state, owner, withdrawalId, contributionId }) {
  const withdrawalExists = (state.cashflows.superWithdrawals ?? []).some((w) => w.id === withdrawalId);
  const contributionExists = (state.cashflows.superContributions ?? []).some((c) => c.id === contributionId);
  if (!withdrawalExists || !contributionExists) return null;

  const beneficiaries = state.plan[owner]?.deathBenefit?.beneficiaries ?? [];
  const hasNonDependant = beneficiaries.some((b) => !isDeathBenefitTaxDependant(b.relationship));

  const withOut = projectPlan(state);
  const withoutState = structuredClone(state);
  withoutState.cashflows.superWithdrawals = (withoutState.cashflows.superWithdrawals ?? []).filter((w) => w.id !== withdrawalId);
  withoutState.cashflows.superContributions = (withoutState.cashflows.superContributions ?? []).filter((c) => c.id !== contributionId);
  const withoutOut = projectPlan(withoutState);

  const withDetail = withOut.yearly[withOut.yearly.length - 1].deathBenefitDetail?.[owner] ?? null;
  const withoutDetail = withoutOut.yearly[withoutOut.yearly.length - 1].deathBenefitDetail?.[owner] ?? null;
  const withTax = withDetail?.totals.tax ?? 0;
  const withoutTax = withoutDetail?.totals.tax ?? 0;

  return { owner, hasNonDependant, cannotHelp: !hasNonDependant, withTax, withoutTax, taxSaved: withoutTax - withTax };
}
