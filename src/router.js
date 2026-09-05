// Hash-based routing over the client/scenario workspace — pure
// helpers, no DOM, no storage. main.js owns the hashchange wiring.
//
// Routes:
//   #/clients                                        → Clients page
//   #/clients/<id>                                   → Client page (their scenarios)
//   #/clients/<cid>/compare?s=<id>,<id>[,<id>]        → Compare page (client-level,
//                                                       no input sidebar — Spec 13 Commit 6
//                                                       relocated here, see scenarioComparison.js)
//   #/clients/<cid>/scenarios/<sid>                   → bare workspace route (caller
//                                                       resolves the landing section)
//   #/clients/<cid>/scenarios/<sid>/input/<section>   → an input fact-find page
//   #/clients/<cid>/scenarios/<sid>/output/<view>     → an output graph or table
//   #/clients/<cid>/scenarios/<sid>/retirement         → Retirement Projection
//                                                       standalone page (client-level,
//                                                       no input sidebar — docs/specs/
//                                                       33-retirement-standalone.md,
//                                                       Commit 1). The scenario it
//                                                       addresses is an ORDINARY one
//                                                       (same CLIENT state, same
//                                                       engine) — this route only
//                                                       changes what's SHOWN, never
//                                                       the state shape underneath.

export const INPUT_SECTIONS = [
  "setup", "tax-details", "children", "implementation", "income", "deductions", "expenses", "financial-assets", "lifestyle-assets",
  "property", "super", "pension", "aged-care", "liabilities", "goals", "investment-cashflows", "settings",
];
export const DEFAULT_INPUT_SECTION = "setup";

// Output view ids are flat (not nested by group) — the grouping is a
// sidebar presentation concern, not a routing one.
//
// Navigation, View Consolidation, and Simple Charts (docs/specs/17-
// navigation-and-charts.md), Commit 1 — Graphs and Tables collapsed
// into one Output group of SUBJECT views, each carrying whichever of
// chart/table it supports (OUTPUT_SUBJECT_FORMS below). "composite" and
// "money-decomposition" fold into Projection's and Net worth's own
// chart selector (Commit 4) rather than staying separate subjects.
export const OUTPUT_VIEWS = [
  "projection", "cashflow", "assets", "liabilities", "bonds", "super", "pension", "aged-care", "age-pension", "death-benefits", "tax", "net-worth", "allocation", "snapshot", "assumptions", // Output
  "focus-deposit", "focus-fhsss", "focus-salary-sacrifice", "focus-debt-payoff", "focus-lookups",                                                            // Focus (docs/specs/12-focus-views.md)
  "focus-equity", "focus-transfer-schedule",                                                                                                                  // Focus (docs/specs/13-implementation-rates-equity-comparison.md)
  "focus-surplus-allocation",                                                                                                                                 // Focus (docs/specs/16-surplus-allocation.md, Commit 3)
  "focus-ppr-exemption",                                                                                                                                      // Focus (docs/specs/19-engine-completion.md, Commit 5's own Focus view)
  "focus-age-pension",                                                                                                                                        // Focus (docs/specs/21a-age-pension-core.md, Commit 4)
  "focus-death-benefits",                                                                                                                                     // Focus (docs/specs/22-death-benefits.md, Commit 3)
  "focus-approach-comparison",                                                                                                                                 // Focus (docs/specs/30-divergence-analysis.md, Commit 3)
  "focus-aged-care-accommodation",                                                                                                                             // Focus (docs/specs/29-aged-care.md, Commit 3)
  "focus-aged-care-planning",                                                                                                                                  // Focus (docs/specs/29-aged-care.md, Commit 5)
  // Reachability bug found by spec 27's own pre-Commit-1 audit: bonds
  // (spec 25) and both these Focus views (specs 24/25) were already
  // fully BUILT (a complete Bonds table; complete Focus views) but
  // never routable — resolveRoute() silently redirected every visit
  // back to Setup, and router.test.js's own coverage list had been
  // asserting the WRONG (missing-these-three) set as correct. Fixed
  // here rather than deferred, since it unblocks already-finished work
  // with zero new UI/engine code.
  "focus-debt-recycling",                                                                                                                                     // Focus (docs/specs/24-drawdowns-debt-recycling.md, Commit 3)
  "focus-education-funding",                                                                                                                                   // Focus (docs/specs/25-investment-education-bonds.md, Commit 3)
  "focus-retirement",                                                                                                                                          // Focus (docs/specs/32-retirement-phase-one.md, Commit 5)
  // "focus-compare-scenarios" relocated to its own client-level Compare
  // page (#/clients/<cid>/compare) — no longer a workspace output view.
  // What if (docs/specs/14-what-if.md) — "what if the world is different"
  // (uncontrolled shocks), as opposed to Focus's "what if I did something
  // different" (levers the client controls). Monte Carlo relocated here
  // unchanged (Commit 1) — a simulation is the probabilistic form of
  // exactly this question.
  "monte-carlo", "monte-carlo-table",
  "whatif-rate-shock", "whatif-crash", "whatif-income-gap", "whatif-expense-shock",
];
export const DEFAULT_OUTPUT_VIEW = "projection";

// Which form(s) each Output subject supports — a subject absent here
// (Focus/What-if ids) has no chart/table concept at all. The router
// uses this only to validate/clamp an explicit `?form=` query value;
// picking the REMEMBERED form when none is given is main.js's job
// (state.display.outputForm), since the router has no access to it.
export const OUTPUT_SUBJECT_FORMS = {
  projection: ["chart"],
  cashflow: ["chart", "table"],
  assets: ["chart", "table"],
  liabilities: ["chart", "table"],
  bonds: ["table"],
  super: ["chart", "table"],
  pension: ["table"],
  "aged-care": ["table"],
  "age-pension": ["chart", "table"],
  "death-benefits": ["table"],
  tax: ["table"],
  "net-worth": ["chart", "table"],
  allocation: ["chart"],
  snapshot: ["table"],
  assumptions: ["table"],
};

// Pre-spec-17 flat Graphs/Tables ids — kept so a bookmarked or shared
// link still lands on the right subject+form rather than bouncing to
// Setup. "composite" and "money-decomposition" land on the plain chart
// form of their new home until Commit 4 restores them as in-view chart
// options.
const LEGACY_OUTPUT_REDIRECTS = {
  "cashflow-bars": { section: "cashflow", form: "chart" },
  "asset-balances": { section: "assets", form: "chart" },
  "liabilities-balances": { section: "liabilities", form: "chart" },
  "super-balances": { section: "super", form: "chart" },
  "net-assets": { section: "net-worth", form: "chart" },
  "key-figures": { section: "net-worth", form: "table" },
  "asset-allocation": { section: "allocation", form: "chart" },
  "composite": { section: "projection", form: "chart" },
  "money-decomposition": { section: "net-worth", form: "chart" },
};

export function formatRoute(route) {
  switch (route?.page) {
    case "client":
      return `#/clients/${encodeURIComponent(route.clientId)}`;
    case "compare": {
      const ids = (route.scenarioIds ?? []).map(encodeURIComponent).join(",");
      return `#/clients/${encodeURIComponent(route.clientId)}/compare?s=${ids}`;
    }
    case "retirement":
      return `#/clients/${encodeURIComponent(route.clientId)}/scenarios/${encodeURIComponent(route.scenarioId)}/retirement`;
    case "workspace": {
      const base = `#/clients/${encodeURIComponent(route.clientId)}/scenarios/${encodeURIComponent(route.scenarioId)}`;
      if (route.area === "input" || route.area === "output") {
        const path = `${base}/${route.area}/${encodeURIComponent(route.section ?? "")}`;
        // The form query param makes a specific chart-or-table view of
        // a subject shareable (spec 17 Commit 1) — only ever present
        // for output routes, and only when the caller set one.
        return route.area === "output" && route.form ? `${path}?form=${encodeURIComponent(route.form)}` : path;
      }
      return base; // bare — caller resolves the landing section
    }
    default:
      return "#/clients";
  }
}

// Structural parse only — no id/section validation beyond shape.
// Returns null for anything that isn't one of the known route shapes.
export function parseRoute(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const qi = raw.indexOf("?");
  const pathPart = qi === -1 ? raw : raw.slice(0, qi);
  const queryPart = qi === -1 ? "" : raw.slice(qi + 1);
  const parts = pathPart
    .split("/")
    .filter(Boolean)
    .map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (parts[0] !== "clients") return null;
  if (parts.length === 1) return { page: "clients" };
  if (parts.length === 2) return { page: "client", clientId: parts[1] };
  if (parts.length === 3 && parts[2] === "compare") {
    const s = new URLSearchParams(queryPart).get("s") ?? "";
    const scenarioIds = s.split(",").map((id) => id.trim()).filter(Boolean)
      .map((id) => { try { return decodeURIComponent(id); } catch { return id; } });
    return { page: "compare", clientId: parts[1], scenarioIds };
  }
  if (parts.length === 4 && parts[2] === "scenarios") {
    return { page: "workspace", clientId: parts[1], scenarioId: parts[3], area: null, section: null };
  }
  if (parts.length === 5 && parts[2] === "scenarios" && parts[4] === "retirement") {
    return { page: "retirement", clientId: parts[1], scenarioId: parts[3] };
  }
  if (parts.length === 6 && parts[2] === "scenarios" && (parts[4] === "input" || parts[4] === "output")) {
    const route = { page: "workspace", clientId: parts[1], scenarioId: parts[3], area: parts[4], section: parts[5] };
    if (parts[4] === "output") {
      const form = new URLSearchParams(queryPart).get("form");
      if (form) route.form = form;
    }
    return route;
  }
  return null;
}

// Parse + validate ids against the workspace index. Null means the
// caller should redirect to #/clients. An unresolvable client/scenario
// id is fatal (redirect); an unresolvable AREA/SECTION is not — it
// falls back to input/setup so a bad section never bounces the user
// out of the scenario they were looking at.
export function resolveRoute(hash, index) {
  const r = parseRoute(hash);
  if (!r) return null;
  if (r.page === "clients") return r;
  const client = index.clients.find((c) => c.id === r.clientId);
  if (!client) return null;
  if (r.page === "client") return r;
  if (r.page === "compare") {
    // Unknown/stale scenario ids are dropped rather than treated as
    // fatal — same non-rejecting treatment an invalid area/section
    // gets below (the caller shows a "pick scenarios" state for < 2,
    // never a redirect away from a client whose id IS valid).
    const scenarioIds = r.scenarioIds.filter((id) => client.scenarios.some((s) => s.id === id));
    return { ...r, scenarioIds };
  }
  if (!client.scenarios.some((s) => s.id === r.scenarioId)) return null;
  if (r.page === "retirement") return r;
  if (r.area == null) return r; // bare — caller resolves the landing section

  if (r.area === "input") {
    if (INPUT_SECTIONS.includes(r.section)) return r;
    return { page: r.page, clientId: r.clientId, scenarioId: r.scenarioId, area: "input", section: DEFAULT_INPUT_SECTION };
  }

  // area === "output" — resolve a legacy (pre spec-17) id to its new
  // subject+form home, then validate/clamp the form against what that
  // subject actually supports. An unrecognised or absent form is left
  // OFF the returned route: main.js applies the scenario's own
  // remembered chart/table choice, which this pure router has no
  // access to and shouldn't guess.
  const legacy = LEGACY_OUTPUT_REDIRECTS[r.section];
  const section = legacy ? legacy.section : r.section;
  let form = r.form ?? legacy?.form;
  if (!OUTPUT_VIEWS.includes(section)) {
    return { page: r.page, clientId: r.clientId, scenarioId: r.scenarioId, area: "input", section: DEFAULT_INPUT_SECTION };
  }
  const allowedForms = OUTPUT_SUBJECT_FORMS[section]; // undefined for Focus/What-if ids — no chart/table concept
  if (!allowedForms || !allowedForms.includes(form)) form = undefined;
  const out = { page: r.page, clientId: r.clientId, scenarioId: r.scenarioId, area: "output", section };
  if (form) out.form = form;
  return out;
}

// The last active scenario's bare workspace route (caller resolves
// landing), or Clients when the active ids don't resolve (defensive —
// normaliseIndex keeps them valid in practice).
export function activeRoute(index) {
  const r = {
    page: "workspace",
    clientId: index.activeClientId,
    scenarioId: index.activeScenarioId,
    area: null,
    section: null,
  };
  return resolveRoute(formatRoute(r), index) ? r : { page: "clients" };
}

// Boot route. An explicit hash is honoured when valid (invalid
// area/section clamps to input/setup rather than rejecting the whole
// route) and falls back to Clients only when the client/scenario ids
// themselves don't resolve; an empty hash restores the last active
// scenario (bare — caller resolves landing).
export function initialRoute(hash, index) {
  const bare = String(hash ?? "").replace(/^#\/?/, "");
  if (bare) return resolveRoute(hash, index) ?? { page: "clients" };
  return activeRoute(index);
}
