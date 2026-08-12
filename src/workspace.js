// Client/scenario workspace — pure operations over the storage index.
//
// Hierarchy: Client → Scenarios. Each scenario is a full plan state
// stored under its own key; this module manages only the INDEX
// structure and the export/import file shapes. No DOM, no storage —
// main.js owns localStorage and passes blobs in/out.
//
// Index shape (workspace schema v1):
//   {
//     schemaVersion: 1,
//     activeClientId, activeScenarioId,
//     clients: [{ id, name, scenarios: [{ id, name, updatedAt }] }],
//   }

export const WORKSPACE_SCHEMA = 1;

let counter = 0;
export function wid(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// --- construction -------------------------------------------------------

export function createIndex(now = Date.now()) {
  const clientId = wid("cl");
  const scenarioId = wid("sc");
  return {
    schemaVersion: WORKSPACE_SCHEMA,
    activeClientId: clientId,
    activeScenarioId: scenarioId,
    clients: [{
      id: clientId,
      name: "Client 1",
      scenarios: [{ id: scenarioId, name: "Scenario 1", updatedAt: now }],
    }],
  };
}

// Defensive normalisation of a parsed index blob. Returns null when
// unusable.
export function normaliseIndex(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.schemaVersion !== WORKSPACE_SCHEMA) return null;
  if (!Array.isArray(raw.clients) || raw.clients.length === 0) return null;
  const clients = raw.clients
    .filter((c) => c && typeof c.id === "string" && Array.isArray(c.scenarios) && c.scenarios.length > 0)
    .map((c, i) => ({
      id: c.id,
      name: typeof c.name === "string" && c.name.trim() ? c.name : `Client ${i + 1}`,
      scenarios: c.scenarios
        .filter((s) => s && typeof s.id === "string")
        .map((s, j) => ({
          id: s.id,
          name: typeof s.name === "string" && s.name.trim() ? s.name : `Scenario ${j + 1}`,
          updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : 0,
        })),
    }))
    .filter((c) => c.scenarios.length > 0);
  if (clients.length === 0) return null;

  let activeClient = clients.find((c) => c.id === raw.activeClientId) || clients[0];
  let activeScenario = activeClient.scenarios.find((s) => s.id === raw.activeScenarioId)
    || mostRecent(activeClient.scenarios);
  return {
    schemaVersion: WORKSPACE_SCHEMA,
    activeClientId: activeClient.id,
    activeScenarioId: activeScenario.id,
    clients,
  };
}

function mostRecent(scenarios) {
  return [...scenarios].sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function findClient(index, clientId) {
  return index.clients.find((c) => c.id === clientId) || null;
}

export function findActive(index) {
  const client = findClient(index, index.activeClientId);
  const scenario = client?.scenarios.find((s) => s.id === index.activeScenarioId) || null;
  return { client, scenario };
}

// Unique-name helper: appends the suffix (repeatedly, in the rare
// nested-clash case) until the name is unique among `existing`.
export function uniqueName(base, existing, suffix = " (imported)") {
  let name = base;
  const names = new Set(existing);
  while (names.has(name)) name = `${name}${suffix}`;
  return name;
}

function nextNumberedName(prefix, existing) {
  let max = 0;
  for (const name of existing) {
    const m = new RegExp(`^${prefix} (\\d+)$`).exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix} ${Math.max(max, existing.length) + 1}`;
}

// --- client operations -----------------------------------------------------

// New client arrives with one fresh scenario and becomes active.
export function newClient(index, now = Date.now(), name = null) {
  const clientId = wid("cl");
  const scenarioId = wid("sc");
  const clientName = name || nextNumberedName("Client", index.clients.map((c) => c.name));
  return {
    index: {
      ...index,
      activeClientId: clientId,
      activeScenarioId: scenarioId,
      clients: [...index.clients, {
        id: clientId,
        name: clientName,
        scenarios: [{ id: scenarioId, name: "Scenario 1", updatedAt: now }],
      }],
    },
    clientId,
    scenarioId,
  };
}

export function renameClient(index, clientId, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return index;
  return {
    ...index,
    clients: index.clients.map((c) => c.id === clientId ? { ...c, name: trimmed } : c),
  };
}

// Cannot delete the last client. Returns { index, removedScenarioIds }
// or null when refused. Deleting the active client activates the
// first remaining client's most recent scenario.
export function deleteClient(index, clientId) {
  if (index.clients.length <= 1) return null;
  const victim = findClient(index, clientId);
  if (!victim) return null;
  const clients = index.clients.filter((c) => c.id !== clientId);
  let { activeClientId, activeScenarioId } = index;
  if (activeClientId === clientId) {
    const next = clients[0];
    activeClientId = next.id;
    activeScenarioId = mostRecent(next.scenarios).id;
  }
  return {
    index: { ...index, clients, activeClientId, activeScenarioId },
    removedScenarioIds: victim.scenarios.map((s) => s.id),
  };
}

export function switchClient(index, clientId) {
  const client = findClient(index, clientId);
  if (!client) return index;
  return {
    ...index,
    activeClientId: clientId,
    activeScenarioId: mostRecent(client.scenarios).id,
  };
}

// --- scenario operations ----------------------------------------------------

export function newScenario(index, clientId, now = Date.now(), name = null) {
  const client = findClient(index, clientId);
  if (!client) return { index, scenarioId: null };
  const scenarioId = wid("sc");
  const scenarioName = name || nextNumberedName("Scenario", client.scenarios.map((s) => s.name));
  return {
    index: {
      ...index,
      activeClientId: clientId,
      activeScenarioId: scenarioId,
      clients: index.clients.map((c) => c.id === clientId
        ? { ...c, scenarios: [...c.scenarios, { id: scenarioId, name: scenarioName, updatedAt: now }] }
        : c),
    },
    scenarioId,
  };
}

// Duplicate: new id, " copy" suffix (unique-ified). The CALLER copies
// the state blob — a deep copy via serialize/parse, never a shared
// reference.
export function duplicateScenario(index, clientId, scenarioId, now = Date.now()) {
  const client = findClient(index, clientId);
  const src = client?.scenarios.find((s) => s.id === scenarioId);
  if (!client || !src) return { index, scenarioId: null };
  const newId = wid("sc");
  const name = uniqueName(`${src.name} copy`, client.scenarios.map((s) => s.name), " copy");
  return {
    index: {
      ...index,
      activeClientId: clientId,
      activeScenarioId: newId,
      clients: index.clients.map((c) => c.id === clientId
        ? { ...c, scenarios: [...c.scenarios, { id: newId, name, updatedAt: now }] }
        : c),
    },
    scenarioId: newId,
    sourceScenarioId: scenarioId,
  };
}

export function renameScenario(index, clientId, scenarioId, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return index;
  return {
    ...index,
    clients: index.clients.map((c) => c.id === clientId
      ? { ...c, scenarios: c.scenarios.map((s) => s.id === scenarioId ? { ...s, name: trimmed } : s) }
      : c),
  };
}

// Cannot delete the last scenario in a client. Deleting the active
// one switches to the most recently updated remaining scenario.
export function deleteScenario(index, clientId, scenarioId) {
  const client = findClient(index, clientId);
  if (!client || client.scenarios.length <= 1) return null;
  const remaining = client.scenarios.filter((s) => s.id !== scenarioId);
  if (remaining.length === client.scenarios.length) return null;
  let { activeScenarioId } = index;
  if (activeScenarioId === scenarioId) {
    activeScenarioId = mostRecent(remaining).id;
  }
  return {
    index: {
      ...index,
      activeScenarioId,
      clients: index.clients.map((c) => c.id === clientId ? { ...c, scenarios: remaining } : c),
    },
    removedScenarioId: scenarioId,
  };
}

export function switchScenario(index, clientId, scenarioId) {
  const client = findClient(index, clientId);
  if (!client || !client.scenarios.some((s) => s.id === scenarioId)) return index;
  return { ...index, activeClientId: clientId, activeScenarioId: scenarioId };
}

export function touchScenario(index, scenarioId, now = Date.now()) {
  return {
    ...index,
    clients: index.clients.map((c) => ({
      ...c,
      scenarios: c.scenarios.map((s) => s.id === scenarioId ? { ...s, updatedAt: now } : s),
    })),
  };
}

// --- export / import file shapes ---------------------------------------------

export const EXPORT_FORMAT = 1;

// getState(scenarioId) → parsed plan-state object (or null). Missing
// blobs are exported as null and dropped on import.
export function exportClientFile(index, clientId, getState) {
  const client = findClient(index, clientId);
  if (!client) return null;
  return {
    kind: "client",
    formatVersion: EXPORT_FORMAT,
    name: client.name,
    scenarios: client.scenarios.map((s) => ({ name: s.name, state: getState(s.id) })),
  };
}

export function exportScenarioFile(index, clientId, scenarioId, getState) {
  const client = findClient(index, clientId);
  const scenario = client?.scenarios.find((s) => s.id === scenarioId);
  if (!client || !scenario) return null;
  return {
    kind: "scenario",
    formatVersion: EXPORT_FORMAT,
    name: scenario.name,
    scenarios: [{ name: scenario.name, state: getState(scenarioId) }],
  };
}

// Validate + import a parsed export file. Every scenario state runs
// through the normal hydrate/migration path. Never overwrites: a
// client file becomes a NEW client; a scenario file becomes a NEW
// scenario in the active client. Name clashes gain " (imported)".
//
// Returns { index, writes: [{ scenarioId, state }] } or
// { error } — never throws.
export function importFile(index, file, { hydrateState, now = Date.now() }) {
  if (!file || typeof file !== "object") return { error: "Not a valid export file." };
  if (file.kind !== "client" && file.kind !== "scenario") return { error: "Unrecognised file kind." };
  if (!Array.isArray(file.scenarios) || file.scenarios.length === 0) return { error: "File contains no scenarios." };

  const hydrated = [];
  for (const s of file.scenarios) {
    if (!s || s.state == null) continue;
    const state = hydrateState(JSON.stringify(s.state));
    if (state) hydrated.push({ name: typeof s.name === "string" && s.name.trim() ? s.name : "Imported scenario", state });
  }
  if (hydrated.length === 0) return { error: "No scenario in the file could be read (unknown or corrupt schema)." };

  const writes = [];

  if (file.kind === "scenario") {
    const client = findClient(index, index.activeClientId);
    if (!client) return { error: "No active client to import into." };
    let out = index;
    let firstId = null;
    for (const h of hydrated) {
      const name = uniqueName(h.name, findClient(out, client.id).scenarios.map((s) => s.name));
      const res = newScenario(out, client.id, now, name);
      out = res.index;
      writes.push({ scenarioId: res.scenarioId, state: h.state });
      if (!firstId) firstId = res.scenarioId;
    }
    out = switchScenario(out, client.id, firstId);
    return { index: out, writes };
  }

  // kind === "client"
  const clientName = uniqueName(
    typeof file.name === "string" && file.name.trim() ? file.name : "Imported client",
    index.clients.map((c) => c.name)
  );
  const clientId = wid("cl");
  const scenarios = hydrated.map((h, i) => {
    const id = wid("sc");
    writes.push({ scenarioId: id, state: h.state });
    return { id, name: h.name, updatedAt: now - (hydrated.length - i) };
  });
  const out = {
    ...index,
    activeClientId: clientId,
    activeScenarioId: scenarios[scenarios.length - 1].id,
    clients: [...index.clients, { id: clientId, name: clientName, scenarios }],
  };
  return { index: out, writes };
}
