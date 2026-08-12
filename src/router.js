// Hash-based routing over the client/scenario workspace — pure
// helpers, no DOM, no storage. main.js owns the hashchange wiring.
//
// Routes:
//   #/clients                          → Clients page
//   #/clients/<id>                     → Client page (their scenarios)
//   #/clients/<cid>/scenarios/<sid>    → Workspace (modelling page)

export function formatRoute(route) {
  switch (route?.page) {
    case "client":
      return `#/clients/${encodeURIComponent(route.clientId)}`;
    case "workspace":
      return `#/clients/${encodeURIComponent(route.clientId)}/scenarios/${encodeURIComponent(route.scenarioId)}`;
    default:
      return "#/clients";
  }
}

// Structural parse only — no id validation. Returns null for anything
// that isn't one of the three route shapes.
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
    return { page: "workspace", clientId: parts[1], scenarioId: parts[3] };
  }
  return null;
}

// Parse + validate ids against the workspace index. Null means the
// caller should redirect to #/clients.
export function resolveRoute(hash, index) {
  const r = parseRoute(hash);
  if (!r) return null;
  if (r.page === "clients") return r;
  const client = index.clients.find((c) => c.id === r.clientId);
  if (!client) return null;
  if (r.page === "client") return r;
  return client.scenarios.some((s) => s.id === r.scenarioId) ? r : null;
}

// The last active scenario's workspace route, or Clients when the
// active ids don't resolve (defensive — normaliseIndex keeps them
// valid in practice).
export function activeRoute(index) {
  const r = {
    page: "workspace",
    clientId: index.activeClientId,
    scenarioId: index.activeScenarioId,
  };
  return resolveRoute(formatRoute(r), index) ? r : { page: "clients" };
}

// Boot route. An explicit hash is honoured when valid and falls back
// to Clients when it isn't (bad deep link); an empty hash restores the
// last active scenario.
export function initialRoute(hash, index) {
  const bare = String(hash ?? "").replace(/^#\/?/, "");
  if (bare) return resolveRoute(hash, index) ?? { page: "clients" };
  return activeRoute(index);
}
