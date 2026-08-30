import { describe, it, expect } from "vitest";
import {
  parseRoute, formatRoute, resolveRoute, activeRoute, initialRoute,
  INPUT_SECTIONS, OUTPUT_VIEWS, OUTPUT_SUBJECT_FORMS, DEFAULT_INPUT_SECTION, DEFAULT_OUTPUT_VIEW,
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
const output = (clientId, scenarioId, section, form) => {
  const r = { page: "workspace", clientId, scenarioId, area: "output", section };
  if (form) r.form = form;
  return r;
};
const compare = (clientId, scenarioIds) => ({ page: "compare", clientId, scenarioIds });

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

  it("parses a compare route, including its scenario-id query list", () => {
    expect(parseRoute("#/clients/cl-1/compare?s=sc-1,sc-2"))
      .toEqual(compare("cl-1", ["sc-1", "sc-2"]));
    expect(parseRoute("#/clients/cl-1/compare?s=sc-1,sc-2,sc-3"))
      .toEqual(compare("cl-1", ["sc-1", "sc-2", "sc-3"]));
  });

  it("a compare route with a missing or empty s param parses to an empty scenario list", () => {
    expect(parseRoute("#/clients/cl-1/compare")).toEqual(compare("cl-1", []));
    expect(parseRoute("#/clients/cl-1/compare?s=")).toEqual(compare("cl-1", []));
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
    expect(parseRoute("#/clients/cl-1/compare/extra")).toBeNull();
  });

  it("round-trips through formatRoute, including encoding", () => {
    for (const r of [
      { page: "clients" },
      { page: "client", clientId: "cl-1" },
      bare("cl a", "sc/1"),
      input("cl-1", "sc-2", "liabilities"),
      output("cl-1", "sc-2", "assumptions"),
      compare("cl-1", ["sc-1", "sc-2"]),
      compare("cl a", ["sc/1", "sc 2"]),
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

  it("accepts a compare route and keeps every scenario id belonging to that client", () => {
    expect(resolveRoute("#/clients/cl-1/compare?s=sc-1,sc-2", index)).toEqual(compare("cl-1", ["sc-1", "sc-2"]));
  });

  it("a compare route drops unknown/stale scenario ids rather than rejecting the whole route", () => {
    // sc-3 belongs to cl-2, not cl-1; "nope" doesn't exist at all.
    expect(resolveRoute("#/clients/cl-1/compare?s=sc-1,sc-3,nope", index)).toEqual(compare("cl-1", ["sc-1"]));
  });

  it("rejects a compare route for an unknown client, same as any other page", () => {
    expect(resolveRoute("#/clients/nope/compare?s=sc-1", index)).toBeNull();
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
      "setup", "tax-details", "children", "implementation", "income", "deductions", "expenses", "financial-assets", "lifestyle-assets",
      "property", "super", "pension", "aged-care", "liabilities", "goals", "investment-cashflows", "settings",
    ]);
    expect(DEFAULT_INPUT_SECTION).toBe("setup");
  });

  it("exposes the output view list", () => {
    expect(OUTPUT_VIEWS).toEqual([
      "projection", "cashflow", "assets", "liabilities", "bonds", "super", "pension", "age-pension", "death-benefits", "tax", "net-worth", "allocation", "snapshot", "assumptions",
      "focus-deposit", "focus-fhsss", "focus-salary-sacrifice", "focus-debt-payoff", "focus-lookups",
      "focus-equity", "focus-transfer-schedule",
      "focus-surplus-allocation",
      "focus-ppr-exemption",
      "focus-age-pension",
      "focus-death-benefits",
      "focus-approach-comparison",
      "focus-aged-care-accommodation",
      "focus-debt-recycling",
      "focus-education-funding",
      "monte-carlo", "monte-carlo-table",
      "whatif-rate-shock", "whatif-crash", "whatif-income-gap", "whatif-expense-shock",
    ]);
    expect(DEFAULT_OUTPUT_VIEW).toBe("projection");
  });

  it("exposes which form(s) each Output subject supports", () => {
    expect(OUTPUT_SUBJECT_FORMS).toEqual({
      projection: ["chart"],
      cashflow: ["chart", "table"],
      assets: ["chart", "table"],
      liabilities: ["chart", "table"],
      bonds: ["table"],
      super: ["chart", "table"],
      pension: ["table"],
      "age-pension": ["chart", "table"],
      "death-benefits": ["table"],
      tax: ["table"],
      "net-worth": ["chart", "table"],
      allocation: ["chart"],
      snapshot: ["table"],
      assumptions: ["table"],
    });
    // Focus/What-if ids have no chart/table concept.
    expect(OUTPUT_SUBJECT_FORMS["focus-deposit"]).toBeUndefined();
    expect(OUTPUT_SUBJECT_FORMS["monte-carlo"]).toBeUndefined();
  });
});

// Navigation, View Consolidation, and Simple Charts (spec 17), Commit 1.
describe("output subject+form routing", () => {
  it("parses an explicit ?form= query on an output route", () => {
    expect(parseRoute("#/clients/cl-1/scenarios/sc-2/output/cashflow?form=table"))
      .toEqual({ page: "workspace", clientId: "cl-1", scenarioId: "sc-2", area: "output", section: "cashflow", form: "table" });
  });

  it("round-trips an output route carrying a form", () => {
    const r = { page: "workspace", clientId: "cl-1", scenarioId: "sc-2", area: "output", section: "assets", form: "chart" };
    expect(parseRoute(formatRoute(r))).toEqual(r);
  });

  it("an output route with no form omits it from formatRoute's query string", () => {
    expect(formatRoute({ page: "workspace", clientId: "cl-1", scenarioId: "sc-2", area: "output", section: "tax" }))
      .toBe("#/clients/cl-1/scenarios/sc-2/output/tax");
  });

  it("resolveRoute keeps a valid, subject-appropriate form", () => {
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/output/cashflow?form=table", index))
      .toEqual(output("cl-1", "sc-2", "cashflow", "table"));
  });

  it("resolveRoute drops a form the subject doesn't support, leaving it for main.js to fill in", () => {
    // "tax" is table-only.
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/output/tax?form=chart", index))
      .toEqual(output("cl-1", "sc-2", "tax"));
    // Garbage form value, same treatment.
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/output/cashflow?form=bogus", index))
      .toEqual(output("cl-1", "sc-2", "cashflow"));
  });

  it("resolveRoute redirects a pre-spec-17 legacy id to its new subject+form home", () => {
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/output/cashflow-bars", index))
      .toEqual(output("cl-1", "sc-2", "cashflow", "chart"));
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/output/key-figures", index))
      .toEqual(output("cl-1", "sc-2", "net-worth", "table"));
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/output/asset-allocation", index))
      .toEqual(output("cl-1", "sc-2", "allocation", "chart"));
    // composite/money-decomposition fold into their new home's chart
    // form until Commit 4 restores them as in-view chart options.
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/output/composite", index))
      .toEqual(output("cl-1", "sc-2", "projection", "chart"));
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/output/money-decomposition", index))
      .toEqual(output("cl-1", "sc-2", "net-worth", "chart"));
  });

  it("an explicit form on a legacy id overrides the legacy default", () => {
    expect(resolveRoute("#/clients/cl-1/scenarios/sc-2/output/net-assets?form=table", index))
      .toEqual(output("cl-1", "sc-2", "net-worth", "table"));
  });
});
