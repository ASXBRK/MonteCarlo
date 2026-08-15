// Focus: Salary sacrifice (docs/specs/12-focus-views.md, Commit 4) —
// pure, no DOM/Plotly. Both arms of the comparison come from a real
// projectPlan() run — the "without" arm is the SAME plan with the
// sacrifice contribution row deleted outright (the extra take-home pay
// flows through the household's own normal surplus handling, whatever
// it's set to — no redirection needed, unlike FHSSS's comparison, since
// here there's no "money has to end up somewhere else" question, just
// "does this row exist or not").
import { projectPlan } from "./deterministic.js";

// Rows this view can compare — an actual salary-sacrifice contribution
// (not personal deductible/SG/spouse; those are different strategies).
export function eligibleSalarySacrificeRows(state) {
  return (state.cashflows.superContributions ?? []).filter((c) => c.type === "salarySacrifice");
}

// buildSalarySacrificeFocus({ state, contributionId, amount }) → the
// view's data, or null if the row doesn't exist. `amount` overrides the
// row's own stored amount for this comparison only (the "adjustable
// within the view" live what-if) — pass the row's own `amount` to
// compare the plan exactly as it stands.
export function buildSalarySacrificeFocus({ state, contributionId, amount }) {
  const row = (state.cashflows.superContributions ?? []).find((c) => c.id === contributionId);
  if (!row) return null;
  const owner = row.owner;
  const accountId = row.accountId;

  const withState = structuredClone(state);
  const withRow = withState.cashflows.superContributions.find((c) => c.id === contributionId);
  withRow.amount = amount;
  const withOut = projectPlan(withState);

  const withoutState = structuredClone(state);
  withoutState.cashflows.superContributions = withoutState.cashflows.superContributions.filter((c) => c.id !== contributionId);
  const withoutOut = projectPlan(withoutState);

  const byYear = [];
  for (let y = 0; y < withOut.yearly.length; y++) {
    const wRow = withOut.yearly[y];
    const woRow = withoutOut.yearly[y];
    const wTax = wRow.taxDetail[owner];
    const woTax = woRow.taxDetail[owner];
    const wSuper = accountId ? wRow.superDetail[accountId] : null;
    const woSuper = accountId ? woRow.superDetail[accountId] : null;
    byYear.push({
      year: y,
      age: owner === "partner" ? wRow.partnerAge : wRow.clientAge,
      fyLabel: withOut.schedule.fyLabels[y],
      // .incomeTax is the FULL net figure (brackets less Medicare, LITO
      // and offsets) — the same field the Tax view's own "Income tax"
      // row reads; .grossTax is the pre-offset bracket figure only, not
      // what "income tax saved" means in plain English.
      incomeTaxWith: wTax?.incomeTax ?? 0,
      incomeTaxWithout: woTax?.incomeTax ?? 0,
      incomeTaxSaved: (woTax?.incomeTax ?? 0) - (wTax?.incomeTax ?? 0),
      helpWith: wTax?.helpRepayment ?? 0,
      helpWithout: woTax?.helpRepayment ?? 0,
      div293With: wRow.taxDetail.div293 ?? 0,
      div293Without: woRow.taxDetail.div293 ?? 0,
      // Net of the 15% contributions tax already deducted at crediting
      // (superDetail.contributionsTax) — the same "gross in, tax
      // skimmed at the point of crediting" figure every other super
      // view already reads, not a fresh calculation.
      superGainedNet: wSuper ? (wSuper.contributions - wSuper.contributionsTax) - (woSuper ? (woSuper.contributions - woSuper.contributionsTax) : 0) : 0,
      // Financial assets AND the Working Cash Account — a household on
      // "accumulate" never invests its surplus into a named asset at
      // all, so closingBalance alone would miss where the extra
      // take-home pay actually lands.
      cashReduced: (woRow.closingBalance + woRow.wcaClosing) - (wRow.closingBalance + wRow.wcaClosing),
      netAssetsWith: wRow.netAssets,
      netAssetsWithout: woRow.netAssets,
    });
  }

  return { contributionId, owner, accountId, byYear };
}
