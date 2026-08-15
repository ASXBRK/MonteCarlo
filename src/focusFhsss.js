// Focus: First Home Super Saver (docs/specs/12-focus-views.md, Commit 3)
// — pure, no DOM/Plotly. Every figure is read straight off a real
// projectPlan() output (row.fhsssDetail/taxDetail, deterministic.js) or
// computed by running the real engine on a modified clone (the
// inside-vs-outside comparison) — never re-derived independently.
import { fhsssReleaseAmounts, FHSSS_ANNUAL_CAP, FHSSS_LIFETIME_CAP } from "./fhsss.js";
import { projectPlan } from "./deterministic.js";
import { uid } from "./planState.js";

function accountOwnerMap(state) {
  return new Map((state.plan.superAccounts ?? []).map((a) => [a.id, a.owner]));
}

// Persons with at least one FHSSS-eligible super contribution row —
// the view can only answer for someone actually using the scheme.
export function eligibleFhsssPersons(state) {
  const ownerOf = accountOwnerMap(state);
  const persons = new Set();
  for (const c of state.cashflows.superContributions ?? []) {
    if (c.fhsssEligible && ownerOf.has(c.accountId)) persons.add(ownerOf.get(c.accountId));
  }
  return [...persons];
}

function ageAt(out, person, y) {
  return person === "partner" ? out.schedule.partnerAges[y] : out.schedule.clientAges[y];
}

// buildFhsssFocus({ out, state, person }) → the view's data, or null if
// this person has no FHSSS activity in the projection at all.
export function buildFhsssFocus({ out, state, person }) {
  const byYear = [];
  let latestY = -1;
  for (let y = 0; y < out.yearly.length; y++) {
    const d = out.yearly[y].fhsssDetail?.[person];
    if (!d) continue;
    latestY = y;
    byYear.push({
      year: y, age: ageAt(out, person, y), fyLabel: out.schedule.fyLabels[y],
      contributionAccepted: d.contributionAccepted,
      contributionRejected: d.contributionRejected,
      earningsAccrued: d.earningsAccrued,
    });
  }
  // row.fhsssDetail[person] is populated for EVERY year for EVERY
  // person, released or not (deterministic.js's accrual loop runs
  // unconditionally — it's a genuine zero for someone who's never made
  // an eligible contribution, not a missing value) — so "no activity"
  // has to be a real check, not just "no non-null entries", which
  // would never be true. A person who has released has fhsssDetail
  // null from the year AFTER release onward, so also check for a past
  // release before giving up.
  const hasReleased = out.yearly.some((row) => (row.taxDetail?.[person]?.fhsssRelease ?? 0) > 0);
  const latest = latestY >= 0 ? out.yearly[latestY].fhsssDetail[person] : null;
  if (!hasReleased && (!latest || latest.lifetimeContributed <= 0)) return null;
  // Cap headroom (Focus Commit 3 follow-on): the engine tracks
  // lifetimeContributed/contributionAccepted per year (row.fhsssDetail)
  // but never computed a "headroom remaining" figure itself — this is
  // the SAME arithmetic fhsssAcceptContribution() applies internally,
  // just read back against the latest tracked balance for display.
  const capHeadroom = latest ? {
    year: latestY,
    annualUsed: latest.contributionAccepted,
    annualRemaining: Math.max(0, FHSSS_ANNUAL_CAP - latest.contributionAccepted),
    lifetimeContributed: latest.lifetimeContributed,
    lifetimeRemaining: Math.max(0, FHSSS_LIFETIME_CAP - latest.lifetimeContributed),
    rejectedThisYear: latest.contributionRejected,
  } : null;

  // "Eligible release" — if triggered today (the latest tracked
  // balance), using the SAME formula the engine itself uses at actual
  // release time (fhsssReleaseAmounts, imported directly — not
  // reimplemented).
  const eligibleReleaseNow = latest ? {
    year: latestY, age: ageAt(out, person, latestY), fyLabel: out.schedule.fyLabels[latestY],
    ...fhsssReleaseAmounts({
      concessionalBalance: latest.concessionalBalance,
      nonConcessionalBalance: latest.nonConcessionalBalance,
      earnings: latest.earningsBalance,
    }),
  } : null;

  // The actual release, if the projection includes a property purchase
  // that triggers one.
  let actualRelease = null;
  const releaseY = out.yearly.findIndex((row) => (row.taxDetail?.[person]?.fhsssRelease ?? 0) > 0);
  if (releaseY !== -1) {
    const td = out.yearly[releaseY].taxDetail[person];
    actualRelease = {
      year: releaseY, age: ageAt(out, person, releaseY), fyLabel: out.schedule.fyLabels[releaseY],
      grossRelease: td.fhsssRelease,
      taxableComponent: td.fhsssTaxableComponent,
      taxFreeComponent: td.fhsssTaxFreeComponent,
      offset: td.fhsssOffset,
    };
  }

  return { person, byYear, capHeadroom, eligibleReleaseNow, actualRelease };
}

// buildFhsssComparison({ state, person }) — "the comparison that
// justifies the strategy": the SAME dollars contributed to FHSSS versus
// saved outside super, both arms from a real projectPlan() run (never
// hand-rolled — the spec's own explicit test requirement). The outside-
// super clone redirects every FHSSS-eligible contribution row this
// person owns into an ordinary financial asset for the SAME dollar
// amount/frequency/dates, using the SAME allocation as their linked
// super account (so the comparison isolates the TAX WRAPPER — 15%
// contributions tax and concessional earnings tax vs ordinary asset
// tax, and the 30% offset on release vs none — not a different
// investment mix). Disclosed simplification: a salary-sacrifice
// contribution is pre-tax; redirecting the identical headline dollar
// figure into an ordinary asset does not additionally model the extra
// income tax that not sacrificing would trigger (that "could they
// actually afford it" question is Focus Commit 4's own job) — this
// comparison is about where the SAME dollar figure ends up, not
// whether it remains affordable to contribute.
export function buildFhsssComparison({ state, person }) {
  const ownerOf = accountOwnerMap(state);
  const eligibleRows = (state.cashflows.superContributions ?? [])
    .filter((c) => c.fhsssEligible && ownerOf.get(c.accountId) === person);
  if (eligibleRows.length === 0) return null;

  const insideOut = projectPlan(state);
  const focus = buildFhsssFocus({ out: insideOut, state, person });
  if (!focus) return null;
  const comparisonYear = focus.actualRelease?.year ?? focus.capHeadroom?.year;
  if (comparisonYear == null) return null;

  const templateAccount = (state.plan.superAccounts ?? []).find((a) => a.id === eligibleRows[0].accountId);
  const outsideState = structuredClone(state);
  const comparisonAssetId = "__focus-fhsss-comparison__";
  outsideState.assets = [
    ...outsideState.assets,
    {
      id: comparisonAssetId, name: "FHSSS comparison (outside super)", class: "financial",
      include: true, owner: person, distributions: "reinvest", balance: 0,
      allocation: templateAccount?.allocation ?? { mode: "custom", incomePct: 3, growthPct: 3, frankingPct: 0, volBasis: "Balanced" },
      icrPct: 0, cgtAsset: true, costBase: 0,
    },
  ];
  const eligibleIds = new Set(eligibleRows.map((c) => c.id));
  outsideState.cashflows.superContributions = outsideState.cashflows.superContributions.filter((c) => !eligibleIds.has(c.id));
  outsideState.cashflows.contributions = [
    ...outsideState.cashflows.contributions,
    ...eligibleRows.map((c) => ({
      id: uid("cf"), assetId: comparisonAssetId, amount: c.amount, frequency: c.frequency,
      from: c.from, to: c.to, indexed: false, owner: person, label: "FHSSS comparison draft",
    })),
  ];
  // No FHSSS balance exists outside super — nothing to release.
  outsideState.properties = (outsideState.properties ?? []).map((p) =>
    p.releaseFhsssAtPurchase ? { ...p, releaseFhsssAtPurchase: false } : p
  );
  outsideState.settings = {
    ...outsideState.settings,
    fundingOrder: [...(outsideState.settings.fundingOrder ?? []), comparisonAssetId],
  };
  const outsideOut = projectPlan(outsideState);

  const insideValue = focus.actualRelease?.grossRelease ?? focus.eligibleReleaseNow?.grossRelease ?? 0;
  const outsideRow = outsideOut.yearly[comparisonYear];
  const outsideValue = outsideRow.perAssetClosing[comparisonAssetId] ?? 0;

  return {
    person, comparisonYear, fyLabel: insideOut.schedule.fyLabels[comparisonYear],
    insideValue, outsideValue, difference: insideValue - outsideValue,
  };
}
