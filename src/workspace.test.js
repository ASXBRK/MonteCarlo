import { describe, it, expect } from "vitest";
import {
  WORKSPACE_SCHEMA, createIndex, normaliseIndex, findActive, findClient,
  newClient, renameClient, deleteClient, switchClient,
  newScenario, duplicateScenario, renameScenario, deleteScenario,
  switchScenario, touchScenario, uniqueName,
  exportClientFile, exportScenarioFile, importFile,
} from "./workspace.js";
import { defaultState, serialize, hydrate } from "./planState.js";
import { PROFILES } from "./profiles.js";

const hydrateState = (json) => hydrate(json, PROFILES);

describe("index construction + normalisation", () => {
  it("createIndex builds Client 1 / Scenario 1, active", () => {
    const idx = createIndex(1000);
    expect(idx.schemaVersion).toBe(WORKSPACE_SCHEMA);
    const { client, scenario } = findActive(idx);
    expect(client.name).toBe("Client 1");
    expect(scenario.name).toBe("Scenario 1");
    expect(scenario.updatedAt).toBe(1000);
  });

  it("normaliseIndex repairs dangling active ids and rejects garbage", () => {
    const idx = createIndex(1000);
    const broken = { ...idx, activeClientId: "nope", activeScenarioId: "nope" };
    const fixed = normaliseIndex(broken);
    expect(fixed.activeClientId).toBe(idx.clients[0].id);
    expect(fixed.activeScenarioId).toBe(idx.clients[0].scenarios[0].id);
    expect(normaliseIndex(null)).toBeNull();
    expect(normaliseIndex({ schemaVersion: 99 })).toBeNull();
    expect(normaliseIndex({ schemaVersion: 1, clients: [] })).toBeNull();
  });
});

describe("client operations", () => {
  it("newClient becomes active with a fresh scenario; names increment", () => {
    let { index } = { index: createIndex(1000) };
    const r = newClient(index, 2000);
    expect(findActive(r.index).client.name).toBe("Client 2");
    expect(findActive(r.index).scenario.name).toBe("Scenario 1");
    const r2 = newClient(r.index, 3000);
    expect(findActive(r2.index).client.name).toBe("Client 3");
  });

  it("cannot delete the last client", () => {
    expect(deleteClient(createIndex(1000), createIndex(1000).clients[0].id)).toBeNull();
  });

  it("deleteClient returns scenario ids for storage cleanup and re-activates", () => {
    let idx = createIndex(1000);
    const firstClient = idx.clients[0].id;
    const r = newClient(idx, 2000); // active = Client 2
    const del = deleteClient(r.index, r.clientId);
    expect(del).not.toBeNull();
    expect(del.removedScenarioIds).toEqual([r.scenarioId]);
    expect(del.index.activeClientId).toBe(firstClient);
  });

  it("rename ignores empty names", () => {
    const idx = createIndex(1000);
    const cid = idx.clients[0].id;
    expect(renameClient(idx, cid, "  ").clients[0].name).toBe("Client 1");
    expect(renameClient(idx, cid, "Smith Family").clients[0].name).toBe("Smith Family");
  });
});

describe("scenario operations", () => {
  it("new / rename / switch", () => {
    let idx = createIndex(1000);
    const cid = idx.clients[0].id;
    const r = newScenario(idx, cid, 2000);
    expect(findActive(r.index).scenario.name).toBe("Scenario 2");
    const renamed = renameScenario(r.index, cid, r.scenarioId, "Proposed");
    expect(findClient(renamed, cid).scenarios[1].name).toBe("Proposed");
    const back = switchScenario(renamed, cid, idx.activeScenarioId);
    expect(back.activeScenarioId).toBe(idx.activeScenarioId);
  });

  it("duplicate takes ' copy' suffix and unique-ifies", () => {
    let idx = createIndex(1000);
    const cid = idx.clients[0].id;
    const d1 = duplicateScenario(idx, cid, idx.activeScenarioId, 2000);
    expect(findActive(d1.index).scenario.name).toBe("Scenario 1 copy");
    const d2 = duplicateScenario(d1.index, cid, idx.activeScenarioId, 3000);
    expect(findActive(d2.index).scenario.name).toBe("Scenario 1 copy copy");
  });

  it("cannot delete the last scenario in a client", () => {
    const idx = createIndex(1000);
    expect(deleteScenario(idx, idx.clients[0].id, idx.activeScenarioId)).toBeNull();
  });

  it("deleting the active scenario switches to the most recently updated", () => {
    let idx = createIndex(1000);
    const cid = idx.clients[0].id;
    const s1 = idx.activeScenarioId;
    const r2 = newScenario(idx, cid, 2000); // s2, active
    const r3 = newScenario(r2.index, cid, 3000); // s3, active
    // Touch s1 so it is the most recent besides s3.
    let cur = touchScenario(r3.index, s1, 4000);
    const del = deleteScenario(cur, cid, r3.scenarioId); // delete active s3
    expect(del.index.activeScenarioId).toBe(s1); // most recently updated
  });

  it("switchClient activates that client's most recent scenario", () => {
    let idx = createIndex(1000);
    const c1 = idx.clients[0].id;
    const r = newClient(idx, 2000);
    const s2 = newScenario(r.index, r.clientId, 3000);
    const back = switchClient(s2.index, c1);
    expect(back.activeClientId).toBe(c1);
    const again = switchClient(back, r.clientId);
    expect(again.activeScenarioId).toBe(s2.scenarioId); // most recent in client 2
  });
});

describe("duplicate is a true deep copy", () => {
  it("mutating one scenario's state never affects another", () => {
    // The caller's copy discipline: duplicate copies the blob via
    // serialize → hydrate. Verify mutations don't leak.
    const original = defaultState(PROFILES, new Date("2026-08-12"));
    original.assets[0].name = "Original asset";
    const copy = hydrateState(serialize(original));
    expect(copy).not.toBeNull();

    copy.assets[0].name = "Mutated copy";
    copy.assets[0].balance = 999999;
    copy.cashflows.contributions[0].amount = 4242;
    copy.plan.client.currentAge = 63;

    expect(original.assets[0].name).toBe("Original asset");
    expect(original.assets[0].balance).toBe(100000);
    expect(original.cashflows.contributions[0].amount).toBe(0);
    expect(original.plan.client.currentAge).toBe(40);
  });
});

describe("export / import", () => {
  function seededWorkspace() {
    let idx = createIndex(1000);
    const cid = idx.clients[0].id;
    idx = renameClient(idx, cid, "Smith Family");
    const blobs = new Map();
    const st = defaultState(PROFILES, new Date("2026-08-12"));
    st.assets[0].name = "Smith Super";
    st.assets[0].balance = 420000;
    blobs.set(idx.activeScenarioId, st);
    const r2 = newScenario(idx, cid, 2000, "Proposed");
    idx = r2.index;
    const st2 = defaultState(PROFILES, new Date("2026-08-12"));
    st2.plan.endAge = 95;
    blobs.set(r2.scenarioId, st2);
    return { idx, cid, blobs };
  }

  it("client export → import round-trips deep-equal state", () => {
    const { idx, cid, blobs } = seededWorkspace();
    const file = exportClientFile(idx, cid, (id) => blobs.get(id));
    expect(file.kind).toBe("client");
    expect(file.name).toBe("Smith Family");
    expect(file.scenarios).toHaveLength(2);

    // Import into a fresh workspace.
    const fresh = createIndex(5000);
    const res = importFile(fresh, JSON.parse(JSON.stringify(file)), { hydrateState, now: 6000 });
    expect(res.error).toBeUndefined();
    expect(res.index.clients).toHaveLength(2);
    const imported = res.index.clients[1];
    expect(imported.name).toBe("Smith Family");
    expect(res.writes).toHaveLength(2);
    // Deep-equal state round trip (hydrate of serialised state is
    // canonical, so compare against hydrate of the original).
    const expected0 = hydrateState(serialize(blobs.get(idx.clients[0].scenarios[0].id)));
    expect(res.writes[0].state).toEqual(expected0);
  });

  it("scenario import lands in the active client with ' (imported)' on clash", () => {
    const { idx, cid, blobs } = seededWorkspace();
    const file = exportScenarioFile(idx, cid, idx.clients[0].scenarios[0].id, (id) => blobs.get(id));
    expect(file.kind).toBe("scenario");
    // Import into the SAME workspace → name "Scenario 1" clashes.
    const res = importFile(idx, JSON.parse(JSON.stringify(file)), { hydrateState, now: 9000 });
    expect(res.error).toBeUndefined();
    const client = findClient(res.index, cid);
    expect(client.scenarios.map((s) => s.name)).toContain("Scenario 1 (imported)");
    expect(res.index.activeScenarioId).toBe(res.writes[0].scenarioId);
  });

  it("client name clash gains ' (imported)'", () => {
    const { idx, cid, blobs } = seededWorkspace();
    const file = exportClientFile(idx, cid, (id) => blobs.get(id));
    const res = importFile(idx, JSON.parse(JSON.stringify(file)), { hydrateState, now: 9000 });
    expect(res.index.clients.map((c) => c.name)).toContain("Smith Family (imported)");
  });

  it("rejects garbage files and unreadable states without throwing", () => {
    const idx = createIndex(1000);
    expect(importFile(idx, null, { hydrateState }).error).toBeTruthy();
    expect(importFile(idx, { kind: "nope" }, { hydrateState }).error).toBeTruthy();
    expect(importFile(idx, { kind: "client", scenarios: [] }, { hydrateState }).error).toBeTruthy();
    expect(importFile(idx, {
      kind: "client", name: "X",
      scenarios: [{ name: "bad", state: { schemaVersion: 99 } }],
    }, { hydrateState }).error).toBeTruthy();
  });

  it("uniqueName loops until unique", () => {
    expect(uniqueName("A", ["A", "A (imported)"])).toBe("A (imported) (imported)");
  });
});
