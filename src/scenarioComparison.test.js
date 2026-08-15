import { describe, it, expect } from "vitest";
import { planWindowsMatch, keyFigureValuesAtYear, keyFigureComparisonRows } from "./scenarioComparison.js";

const plan = (over = {}) => ({
  client: { currentAge: 40 },
  start: { year: 2026, month: 7 },
  endAge: 65,
  ...over,
});

describe("planWindowsMatch", () => {
  it("true for identical windows", () => {
    expect(planWindowsMatch(plan(), plan())).toBe(true);
  });
  it("false when current age differs", () => {
    expect(planWindowsMatch(plan(), plan({ client: { currentAge: 41 } }))).toBe(false);
  });
  it("false when start date differs (year or month)", () => {
    expect(planWindowsMatch(plan(), plan({ start: { year: 2027, month: 7 } }))).toBe(false);
    expect(planWindowsMatch(plan(), plan({ start: { year: 2026, month: 10 } }))).toBe(false);
  });
  it("false when end age differs", () => {
    expect(planWindowsMatch(plan(), plan({ endAge: 70 }))).toBe(false);
  });
  it("true even when partner ages differ — the axis is client-anchored", () => {
    const a = { ...plan(), partner: { currentAge: 38 } };
    const b = { ...plan(), partner: { currentAge: 45 } };
    expect(planWindowsMatch(a, b)).toBe(true);
  });
});

describe("keyFigureValuesAtYear", () => {
  it("flattens groups into a flat, ordered {label, value} list", () => {
    const groups = [
      { title: null, rows: [{ label: "Total assets", cell: (y) => 1000 + y }, { label: "NET ASSETS", cell: (y) => 500 + y }] },
    ];
    expect(keyFigureValuesAtYear(groups, 2)).toEqual([
      { label: "Total assets", value: 1002 },
      { label: "NET ASSETS", value: 502 },
    ]);
  });
});

describe("keyFigureComparisonRows", () => {
  it("each scenario's own values pass through unchanged (column equals that scenario's own Key figures view)", () => {
    const a = [{ label: "Total assets", value: 100 }, { label: "NET ASSETS", value: 50 }];
    const b = [{ label: "Total assets", value: 150 }, { label: "NET ASSETS", value: 80 }];
    const rows = keyFigureComparisonRows([a, b]);
    expect(rows.find((r) => r.label === "Total assets").values).toEqual([100, 150]);
    expect(rows.find((r) => r.label === "NET ASSETS").values).toEqual([50, 80]);
  });

  it("deltas compute against the FIRST-listed scenario, not adjacent pairs", () => {
    const a = [{ label: "NET ASSETS", value: 100 }];
    const b = [{ label: "NET ASSETS", value: 150 }];
    const c = [{ label: "NET ASSETS", value: 90 }];
    const rows = keyFigureComparisonRows([a, b, c]);
    const row = rows.find((r) => r.label === "NET ASSETS");
    expect(row.values).toEqual([100, 150, 90]);
    expect(row.deltas).toEqual([50, -10]); // b-a, c-a — never c-b
  });

  it("a row present in only SOME scenarios is null (not misaligned) for the others, matched by label", () => {
    const a = [{ label: "NET ASSETS", value: 100 }];
    const b = [{ label: "NET ASSETS", value: 150 }, { label: "HELP balance", value: 5000 }];
    const rows = keyFigureComparisonRows([a, b]);
    const help = rows.find((r) => r.label === "HELP balance");
    expect(help.values).toEqual([null, 5000]);
    expect(help.deltas).toEqual([null]); // no base value to delta against
  });

  it("returns [] for zero scenarios", () => {
    expect(keyFigureComparisonRows([])).toEqual([]);
  });
});
