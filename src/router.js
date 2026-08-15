// Hash-based routing over the client/scenario workspace — pure
// helpers, no DOM, no storage. main.js owns the hashchange wiring.
//
// Routes:
//   #/clients                                        → Clients page
//   #/clients/<id>                                   → Client page (their scenarios)
//   #/clients/<cid>/scenarios/<sid>                   → bare workspace route (caller
//                                                       resolves the landing section)
//   #/clients/<cid>/scenarios/<sid>/input/<section>   → an input fact-find page
//   #/clients/<cid>/scenarios/<sid>/output/<view>     → an output graph or table

export const INPUT_SECTIONS = [
  "setup", "implementation", "income", "deductions", "expenses", "financial-assets", "lifestyle-assets",
  "property", "super", "liabilities", "goals", "investment-cashflows", "settings",
];
export const DEFAULT_INPUT_SECTION = "setup";

// Output view ids are flat (not nested by Graphs/Tables group) — the
// grouping is a sidebar presentation concern, not a routing one.
export const OUTPUT_VIEWS = [
  "projection", "composite", "net-assets", "asset-balances", "asset-allocation", "super-balances", "liabilities-balances", "cashflow-bars", "monte-carlo",  // Graphs
  "money-decomposition",                                                                                                                                      // Graphs (docs/specs/13-implementation-rates-equity-comparison.md, Commit 4)
  "key-figures", "cashflow", "assets", "tax", "super", "liabilities", "snapshot", "monte-carlo-table", "assumptions",                                        // Tables
  "focus-deposit", "focus-fhsss", "focus-salary-sacrifice", "focus-debt-payoff", "focus-lookups",                                                            // Focus (docs/specs/12-focus-views.md)
  "focus-equity", "focus-transfer-schedule", "focus-compare-scenarios",                                                                                       // Focus (docs/specs/13-implementation-rates-equity-comparison.md)
];
export const DEFAULT_OUTPUT_VIEW = "composite"; // the composite chart is the default Graphs view (D5)

export function formatRoute(route) {
  switch (route?.page) {
    case "client":
      return `#/clients/${encodeURIComponent(route.clientId)}`;
    case "workspace": {
      const base = `#/clients/${encodeURIComponent(route.clientId)}/scenarios/${encodeURIComponent(route.scenarioId)}`;
      if (route.area === "input" || route.area === "output") {
        return `${base}/${route.area}/${encodeURIComponent(route.section ?? "")}`;
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
  const parts = String(hash ?? "")
    .replace(/^#/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (parts[0] !== "clients") return null;
  if (parts.length === 1) return { page: "clients" };
  if (parts.length === 2) return { page: "client", clientId: parts[1] };
  if (parts.length === 4 && parts[2] === "scenarios") {
    return { page: "workspace", clientId: parts[1], scenarioId: parts[3], area: null, section: null };
  }
  if (parts.length === 6 && parts[2] === "scenarios" && (parts[4] === "input" || parts[4] === "output")) {
    return { page: "workspace", clientId: parts[1], scenarioId: parts[3], area: parts[4], section: parts[5] };
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
  if (!client.scenarios.some((s) => s.id === r.scenarioId)) return null;
  if (r.area == null) return r; // bare — caller resolves the landing section
  const validSection =
    (r.area === "input" && INPUT_SECTIONS.includes(r.section)) ||
    (r.area === "output" && OUTPUT_VIEWS.includes(r.section));
  if (!validSection) return { ...r, area: "input", section: DEFAULT_INPUT_SECTION };
  return r;
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
