// Demo coverage — for every id in router.js's OUTPUT_VIEWS, at least
// one demo client/scenario must produce real, non-empty data for it.
// This is what turns "we think the demo covers everything" into "every
// view has actually been shown with data" — a view with no populating
// scenario fails here BEFORE a presenter discovers it live.
//
// Deliberately state/engine-level checks, not a render of each Focus
// view's own UI (main.js has no test-friendly seam for that) — "has
// the underlying data this view would show" is the faithful
// approximation available without duplicating every Focus builder's
// own bespoke parameter shape (a childId, a liabilityId, a propertyId,
// ...) here. Where a view's own Focus module has an explicit
// null-return gate, the check mirrors that gate's real condition
// directly (not re-derived from scratch) so this test can't drift from
// what the view itself actually requires.
import { describe, it, expect } from "vitest";
import { buildDemoClients } from "./index.js";
import { projectPlan } from "../deterministic.js";
import { OUTPUT_VIEWS } from "../router.js";

const NOW = new Date("2026-08-17T00:00:00+10:00");
const clients = buildDemoClients(NOW);

// Every (client, scenario, state, out) combination, computed once —
// checkers below run cheaply against this rather than re-projecting
// per view.
const combos = clients.flatMap((client) =>
  client.scenarios.map((scenario) => ({
    client: client.name, scenario: scenario.name, state: scenario.state, out: projectPlan(scenario.state),
  }))
);

function anyYear(out, pred) {
  return out.yearly.some(pred);
}

// death-benefits (Table) and focus-death-benefits (Focus) read the
// exact same underlying data — out.yearly[last].deathBenefitDetail —
// so both checkers below share this one function rather than drifting.
function hasDeathBenefitDetail({ out }) {
  const last = out.yearly[out.yearly.length - 1];
  return !!(last.deathBenefitDetail?.client || last.deathBenefitDetail?.partner);
}

// One checker per Output/Focus/What-if subject — true means THIS
// combo alone would show real data for that view. Every view not
// listed here is a bug in this test, not a silent pass — the "missing
// checker" assertion at the bottom catches that.
const CHECKS = {
  // --- Output ---
  projection: ({ out }) => out.yearly.length > 0,
  cashflow: ({ out }) => out.yearly.length > 0, // income/expenses always populated for a real client
  assets: ({ state }) => (state.assets ?? []).length > 0,
  liabilities: ({ state, out }) =>
    (state.liabilities ?? []).length > 0 || anyYear(out, (row) => Object.keys(row.liabilities ?? {}).length > 0),
  bonds: ({ state }) => (state.bonds ?? []).length > 0,
  super: ({ state }) => (state.plan.superAccounts ?? []).length > 0,
  pension: ({ state }) => (state.plan.pensions ?? []).length > 0,
  "aged-care": ({ state }) => (state.plan.agedCare ?? []).length > 0,
  "age-pension": ({ out }) => anyYear(out, (row) => (row.agePensionDetail?.entitlement ?? 0) > 0),
  "death-benefits": hasDeathBenefitDetail,
  tax: ({ out }) => anyYear(out, (row) => (row.tax ?? 0) !== 0 || !!row.taxDetail),
  "net-worth": ({ out }) => out.yearly.length > 0,
  allocation: ({ state }) => (state.assets ?? []).length > 0,
  snapshot: ({ out }) => out.yearly.length > 0,
  assumptions: ({ out }) => out.yearly.length > 0,

  // --- Focus (docs/specs/12-focus-views.md and friends) ---
  "focus-deposit": ({ state }) => (state.properties ?? []).some((p) => p.status === "planned"),
  "focus-fhsss": ({ state }) => (state.cashflows.superContributions ?? []).some((c) => c.fhsssEligible),
  "focus-salary-sacrifice": ({ state }) => (state.cashflows.superContributions ?? []).some((c) => c.type === "salarySacrifice"),
  "focus-debt-payoff": ({ state }) => (state.liabilities ?? []).some((l) => l.balance > 0),
  "focus-lookups": () => true, // a standalone stamp duty/LMI calculator — no plan-state dependency at all
  "focus-equity": ({ state }) => (state.properties ?? []).length > 0,
  "focus-transfer-schedule": ({ out }) => out.yearly.length > 0,
  "focus-surplus-allocation": ({ out }) => out.yearly.length > 0, // buildSurplusAllocationFocus has no null-gate
  "focus-ppr-exemption": ({ state }) => (state.properties ?? []).some((p) => p.propertyType === "ppr"),
  "focus-age-pension": ({ out }) =>
    anyYear(out, (row) => row.agePensionDetail?.client?.ageEligible || row.agePensionDetail?.partner?.ageEligible),
  "focus-death-benefits": hasDeathBenefitDetail,
  "focus-approach-comparison": ({ out }) => out.yearly.length > 1, // needs at least one full FY to project a static line from
  "focus-aged-care-accommodation": ({ state }) => (state.assets ?? []).some((a) => a.include && a.class === "financial"),
  "focus-aged-care-planning": ({ state }) => (state.plan.agedCare ?? []).length > 0,
  "focus-debt-recycling": ({ state }) => (state.liabilities ?? []).some((l) => l.recycling?.enabled),
  "focus-education-funding": ({ state }) => (state.plan.children ?? []).some((c) => (c.education ?? []).length > 0),

  // --- What if (docs/specs/14-what-if.md) ---
  "monte-carlo": ({ state }) => (state.assets ?? []).length > 0,
  "monte-carlo-table": ({ state }) => (state.assets ?? []).length > 0,
  "whatif-rate-shock": ({ state }) => (state.liabilities ?? []).some((l) => l.balance > 0),
  "whatif-crash": ({ state }) => (state.assets ?? []).some((a) => a.include && a.class !== "lifestyle"),
  "whatif-income-gap": ({ out }) => anyYear(out, (row) => row.income > 0),
  "whatif-expense-shock": ({ out }) => anyYear(out, (row) => row.expenses > 0),
};

describe("Demo coverage — every router.js output view has at least one populating client/scenario", () => {
  it("every OUTPUT_VIEWS id has a checker registered in this test", () => {
    const missing = OUTPUT_VIEWS.filter((id) => !(id in CHECKS));
    expect(missing, `no coverage checker for: ${missing.join(", ")}`).toEqual([]);
  });

  for (const id of OUTPUT_VIEWS) {
    it(`"${id}" is populated by at least one demo client/scenario`, () => {
      const check = CHECKS[id];
      if (!check) return; // reported by the "every id has a checker" test above, not duplicated here
      const populatingCombos = combos.filter((c) => check(c));
      const names = populatingCombos.map((c) => `${c.client} — ${c.scenario}`);
      expect(populatingCombos.length, `no demo client/scenario populates "${id}"`).toBeGreaterThan(0);
      // Recorded for docs/reference/demo-coverage.md's own cross-check —
      // printed, not asserted, so a human can eyeball which scenario(s)
      // actually cover each view without re-deriving it by hand.
      if (process.env.DEMO_COVERAGE_VERBOSE) console.log(`${id}: ${names.join(", ")}`);
    });
  }
});
