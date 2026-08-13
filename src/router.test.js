import { describe, it, expect } from "vitest";
import {
  parseRoute, formatRoute, resolveRoute, activeRoute, initialRoute,
  INPUT_SECTIONS, OUTPUT_VIEWS, DEFAULT_INPUT_SECTION, DEFAULT_OUTPUT_VIEW,
} from "./router.js";

const index = {
  schemaVersion: 1,
  activeClientId: "cl-1",
  activeScenarioId: "sc-2",
  clients: [
    { id: "cl-1", name: "Client 1", scenarios: [{ id: "sc-1", name: "A", updatedAt: 1 }, { id: "sc-2", name: "B", updatedAt: 2 }] },
    { id: "cl-2", name: "Client 2", scenarios: [{ id: "sc-3", name: "C", updatedAt: 3 }] },
  ],
};

const bare = (clientId, scenarioId) => ({ page: "workspace", clientId, scenarioId, area: null, section: null });
const input = (clientId, scenarioId, section) => ({ page: "workspace", clientId, scenarioId, area: "input", section });
const output = (clientId, scenarioId, section) => ({ page: "workspace", clientId, scenarioId, area: "output", section });

describe("parseRoute", () => {
  it("parses the clients and client route shapes", () => {
    expect(parseRoute("#/clients")).toEqual({ page: "clients" });
    expect(parseRoute("#/clients/cl-1")).toEqual({ page: "client", clientId: "cl-1" });
  });

  it("parses a bare scenario route (no area/section)", () => {
    expect(parseRoute("#/clients/cl-1/scenarios/sc-2")).toEqual(bare("cl-1", "sc-2"));
  });

  it("parses input and output routes", () => {
    expect(parseRoute("#/clients/cl-1/scenarios/sc-2/input/liabilities"))
      .toEqual(input("cl-1", "sc-2", "liabilities"));
    expect(parseRoute("#/clients/cl-1/scenarios/sc-2/output/tax"))
      .toEqual(output("cl-1", "sc-2", "tax"));
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
    expect(parseRoute("#/clients/cl-1/scenarios/sc-1/bogusArea/setup")).toBeNull();
    expect(parseRoute("#/clients/cl-1/scenarios/sc-1/input/setup/extra")).toBeNull();
  });

  it("round-trips through formatRoute, including encoding", () => {
    for (const r of [
      { page: "clients" },
      { page: "client", clientId: "cl-1" },
      bare("cl a", "sc/1"),
      input("cl-1", "sc-2", "liabilities"),
      output("cl-1", "sc-2", "assumptions"),
    ]) {
      expect(parseRoute(formatRoute(r))).toEqual(r);
    }
  });
});

describe("resolveRoute", () => {
  it("accepts routes whose ids exist", () => {
    expect(resolveRoute("#/clients", index)).toEqual({ page: "clients" });
    expect(resolveRoute("#/clients/cl-2", index)).toEqual({ page: "client", clientId: "cl-2" });
    expect(resolveRoute("#/clients/cl-2/scenarios/sc-3", index)).toEqual(bare("cl-2", "sc-3"));
    expect(resolveRoute("#/clients/cl-2/scenarios/sc-3/input/property", index))
      .toEqual(input("cl-2", "sc-3", "property"));
    expect(resolveRoute("#/clients/cl-2/scenarios/sc-3/output/cashflow", index))
      .toEqual(output("cl-2", "sc-3", "cashflow"));
  });

  it("rejects unknown client/scenario ids and cross-client scenario ids", () => {
    expect(resolveRoute("#/clients/nope", index)).toBeNull();
    expect(resolveRoute("#/clients/cl-1/scenarios/nope", index)).toBeNull();
    // sc-3 belongs to cl-2, not cl-1.
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-3", index)).toBeNull();
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-3/input/setup", index)).toBeNull();
  });

  it("an invalid section falls back to input/setup without rejecting the route", () => {
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/input/bogus", index))
      .toEqual(input("cl-1", "sc-2", DEFAULT_INPUT_SECTION));
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/output/bogus", index))
      .toEqual(input("cl-1", "sc-2", DEFAULT_INPUT_SECTION));
    // A section from the wrong area (an output id under input/) is
    // also invalid for that area and falls back the same way.
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/input/tax", index))
      .toEqual(input("cl-1", "sc-2", DEFAULT_INPUT_SECTION));
  });
});

describe("initialRoute / activeRoute", () => {
  it("empty hash restores the last active scenario as a bare route", () => {
    for (const h of ["", "#", "#/", null, undefined]) {
      expect(initialRoute(h, index)).toEqual(bare("cl-1", "sc-2"));
    }
  });

  it("a valid deep link wins over the active scenario", () => {
    expect(initialRoute("#/clients/cl-2/scenarios/sc-3/input/liabilities", index))
      .toEqual(input("cl-2", "sc-3", "liabilities"));
    expect(initialRoute("#/clients", index)).toEqual({ page: "clients" });
  });

  it("an invalid client/scenario id falls back to Clients", () => {
    expect(initialRoute("#/clients/nope", index)).toEqual({ page: "clients" });
    expect(initialRoute("#/garbage", index)).toEqual({ page: "clients" });
  });

  it("an invalid section on an otherwise-valid deep link falls back to Setup, not Clients", () => {
    expect(initialRoute("#/clients/cl-2/scenarios/sc-3/input/bogus", index))
      .toEqual(input("cl-2", "sc-3", DEFAULT_INPUT_SECTION));
  });

  it("activeRoute is defensive against dangling active ids", () => {
    const broken = { ...index, activeClientId: "cl-9", activeScenarioId: "sc-9" };
    expect(activeRoute(broken)).toEqual({ page: "clients" });
    expect(initialRoute("", broken)).toEqual({ page: "clients" });
  });
});

describe("known section/view ids", () => {
  it("exposes the full input section list", () => {
    expect(INPUT_SECTIONS).toEqual([
      "setup", "income", "expenses", "financial-assets", "lifestyle-assets",
      "property", "liabilities", "investment-cashflows", "settings",
    ]);
    expect(DEFAULT_INPUT_SECTION).toBe("setup");
  });

  it("exposes the output view list", () => {
    expect(OUTPUT_VIEWS).toEqual(["projection", "cashflow", "assets", "tax", "assumptions"]);
    expect(DEFAULT_OUTPUT_VIEW).toBe("projection");
  });
});
