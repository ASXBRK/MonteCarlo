import { describe, it, expect } from "vitest";
import { parseRoute, formatRoute, resolveRoute, activeRoute, initialRoute } from "./router.js";

const index = {
  schemaVersion: 1,
  activeClientId: "cl-1",
  activeScenarioId: "sc-2",
  clients: [
    { id: "cl-1", name: "Client 1", scenarios: [{ id: "sc-1", name: "A", updatedAt: 1 }, { id: "sc-2", name: "B", updatedAt: 2 }] },
    { id: "cl-2", name: "Client 2", scenarios: [{ id: "sc-3", name: "C", updatedAt: 3 }] },
  ],
};

describe("parseRoute", () => {
  it("parses the three route shapes", () => {
    expect(parseRoute("#/clients")).toEqual({ page: "clients" });
    expect(parseRoute("#/clients/cl-1")).toEqual({ page: "client", clientId: "cl-1" });
    expect(parseRoute("#/clients/cl-1/scenarios/sc-2"))
      .toEqual({ page: "workspace", clientId: "cl-1", scenarioId: "sc-2" });
  });

  it("tolerates missing # and trailing slash", () => {
    expect(parseRoute("/clients/")).toEqual({ page: "clients" });
    expect(parseRoute("clients/cl-1")).toEqual({ page: "client", clientId: "cl-1" });
  });

  it("rejects malformed hashes", () => {
    expect(parseRoute("")).toBeNull();
    expect(parseRoute("#")).toBeNull();
    expect(parseRoute("#/nope")).toBeNull();
    expect(parseRoute("#/clients/cl-1/extra")).toBeNull();
    expect(parseRoute("#/clients/cl-1/scenarios")).toBeNull();
    expect(parseRoute("#/clients/cl-1/scenarios/sc-1/deeper")).toBeNull();
  });

  it("round-trips through formatRoute, including encoding", () => {
    for (const r of [
      { page: "clients" },
      { page: "client", clientId: "cl-1" },
      { page: "workspace", clientId: "cl a", scenarioId: "sc/1" },
    ]) {
      expect(parseRoute(formatRoute(r))).toEqual(r);
    }
  });
});

describe("resolveRoute", () => {
  it("accepts routes whose ids exist", () => {
    expect(resolveRoute("#/clients", index)).toEqual({ page: "clients" });
    expect(resolveRoute("#/clients/cl-2", index)).toEqual({ page: "client", clientId: "cl-2" });
    expect(resolveRoute("#/clients/cl-2/scenarios/sc-3", index))
      .toEqual({ page: "workspace", clientId: "cl-2", scenarioId: "sc-3" });
  });

  it("rejects unknown ids and cross-client scenario ids", () => {
    expect(resolveRoute("#/clients/nope", index)).toBeNull();
    expect(resolveRoute("#/clients/cl-1/scenarios/nope", index)).toBeNull();
    // sc-3 belongs to cl-2, not cl-1.
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-3", index)).toBeNull();
  });
});

describe("initialRoute / activeRoute", () => {
  it("empty hash restores the last active scenario", () => {
    for (const h of ["", "#", "#/", null, undefined]) {
      expect(initialRoute(h, index))
        .toEqual({ page: "workspace", clientId: "cl-1", scenarioId: "sc-2" });
    }
  });

  it("a valid deep link wins over the active scenario", () => {
    expect(initialRoute("#/clients/cl-2/scenarios/sc-3", index))
      .toEqual({ page: "workspace", clientId: "cl-2", scenarioId: "sc-3" });
    expect(initialRoute("#/clients", index)).toEqual({ page: "clients" });
  });

  it("an invalid hash falls back to Clients, not the active scenario", () => {
    expect(initialRoute("#/clients/nope", index)).toEqual({ page: "clients" });
    expect(initialRoute("#/garbage", index)).toEqual({ page: "clients" });
  });

  it("activeRoute is defensive against dangling active ids", () => {
    const broken = { ...index, activeClientId: "cl-9", activeScenarioId: "sc-9" };
    expect(activeRoute(broken)).toEqual({ page: "clients" });
    expect(initialRoute("", broken)).toEqual({ page: "clients" });
  });
});
