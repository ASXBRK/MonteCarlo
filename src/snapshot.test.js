import { describe, it, expect } from "vitest";
import { buildSnapshotColumns, buildSnapshotTable, snapshotToHTML, snapshotToCSV, SNAPSHOT_ROWS } from "./snapshot.js";
import { cashflowStatement } from "./cashflowStatement.js";

function mkRow(over = {}) {
  return {
    superDetail: {}, properties: {}, liabilities: {}, cashDistributions: 0,
    wcaDetail: { interest: 0 }, tax: 0,
    taxDetail: {
      client: { grossTax: 0, medicare: 0, lito: 0, paygWithheld: 0 },
      partner: {}, frankingCredits: 0, div293: 0, div296: 0, netCapitalGain: 0, refundSettled: 0,
    },
    ...over,
  };
}

describe("buildSnapshotColumns", () => {
  it("resolves each requested plan year, dropping out-of-range and duplicate years", () => {
    const yearly = [mkRow(), mkRow(), mkRow()];
    const ctxFor = (y) => ({ y });
    const columns = buildSnapshotColumns(yearly, ctxFor, [0, 5, -1, 0, 2], false);
    expect(columns.map((c) => c.y)).toEqual([0, 2]);
  });

  it("each column reconciles to cashflowStatement() for that year, by construction (same function, same ctx)", () => {
    const incomeRows = [{ id: "i1", category: "salary", owner: "client" }];
    const rowTotalsIncome = { i1: [90000] };
    const yearly = [mkRow()];
    const ctxFor = (y) => ({ incomeRows, rowTotalsIncome, y });
    const columns = buildSnapshotColumns(yearly, ctxFor, [0], false);
    expect(columns[0].total).toEqual(cashflowStatement(yearly[0], ctxFor(0), null));
    expect(columns[0].client).toEqual(cashflowStatement(yearly[0], ctxFor(0), "client"));
  });

  it("omits the partner column for a single household", () => {
    const yearly = [mkRow()];
    const columns = buildSnapshotColumns(yearly, () => ({ y: 0 }), [0], false);
    expect(columns[0].partner).toBeNull();
  });
});

describe("buildSnapshotTable", () => {
  const couple = (income) => {
    const incomeRows = [
      { id: "i1", category: "salary", owner: "client" },
      { id: "i2", category: "salary", owner: "partner" },
    ];
    const rowTotalsIncome = { i1: [income.client], i2: [income.partner] };
    const yearly = [mkRow()];
    const ctxFor = (y) => ({ incomeRows, rowTotalsIncome, y });
    return buildSnapshotColumns(yearly, ctxFor, [0], true);
  };

  it("Client + Partner = Total on the Salary row, reading straight through from cashflowStatement", () => {
    const columns = couple({ client: 80000, partner: 40000 });
    const table = buildSnapshotTable(columns, { hideEmptyRows: false });
    const salaryRow = table.rows.find((r) => r.label === "Salary");
    expect(salaryRow.cells[0].client).toBe(80000);
    expect(salaryRow.cells[0].partner).toBe(40000);
    expect(salaryRow.cells[0].total).toBe(120000);
  });

  it("hides an all-zero row across every column, keeps a nonzero one", () => {
    const columns = couple({ client: 80000, partner: 0 });
    const table = buildSnapshotTable(columns, { hideEmptyRows: true });
    expect(table.rows.some((r) => r.label === "Salary")).toBe(true);
    expect(table.rows.some((r) => r.label === "Trust Distribution")).toBe(false); // always [zero]
  });

  it("subtotal/total rows are never hidden, even at zero", () => {
    const columns = couple({ client: 0, partner: 0 });
    const table = buildSnapshotTable(columns, { hideEmptyRows: true });
    expect(table.rows.some((r) => r.label === "Assessable Income")).toBe(true);
    expect(table.rows.some((r) => r.label === "NET INCOME")).toBe(true);
  });

  it("every SNAPSHOT_ROWS entry has a working path accessor (never throws on a zeroed statement)", () => {
    const s = cashflowStatement(mkRow(), {});
    for (const def of SNAPSHOT_ROWS) {
      expect(() => def.path(s)).not.toThrow();
      expect(Number.isFinite(def.path(s))).toBe(true);
    }
  });
});

describe("snapshotToHTML / snapshotToCSV", () => {
  const columns = () => {
    const incomeRows = [{ id: "i1", category: "salary", owner: "client" }];
    const rowTotalsIncome = { i1: [80000] };
    const yearly = [mkRow()];
    return buildSnapshotColumns(yearly, (y) => ({ incomeRows, rowTotalsIncome, y }), [0], false);
  };

  it("HTML export contains exactly the visible (non-hidden) rows, not the full row list", () => {
    const table = buildSnapshotTable(columns(), { hideEmptyRows: true });
    const html = snapshotToHTML(table, ["FY2026-27"], false);
    expect(html).toContain("Salary");
    expect(html).not.toContain("Trust Distribution"); // hidden — always zero here
    // Exactly one <tr> per visible row plus one section header per
    // distinct section plus the header row.
    const trCount = (html.match(/<tr/g) || []).length;
    const sectionCount = new Set(table.rows.map((r) => r.section)).size;
    expect(trCount).toBe(1 + table.rows.length + sectionCount);
  });

  it("CSV export contains exactly the visible rows and reconciles Client+Partner=Total for a couple", () => {
    const incomeRows = [
      { id: "i1", category: "salary", owner: "client" },
      { id: "i2", category: "salary", owner: "partner" },
    ];
    const rowTotalsIncome = { i1: [80000], i2: [40000] };
    const yearly = [mkRow()];
    const cols = buildSnapshotColumns(yearly, (y) => ({ incomeRows, rowTotalsIncome, y }), [0], true);
    const table = buildSnapshotTable(cols, { hideEmptyRows: true });
    const csv = snapshotToCSV(table, ["FY2026-27"], true);
    const lines = csv.split("\r\n");
    expect(lines.length).toBe(1 + table.rows.length); // header + one line per visible row
    const salaryLine = lines.find((l) => l.startsWith("Salary,"));
    const [, client, partner, total] = salaryLine.split(",");
    expect(Number(client) + Number(partner)).toBe(Number(total));
  });

  it("a single household's export has no Client/Partner columns, only Total", () => {
    const table = buildSnapshotTable(columns(), { hideEmptyRows: true });
    const csv = snapshotToCSV(table, ["FY2026-27"], false);
    const header = csv.split("\r\n")[0];
    expect(header).toBe("Item,FY2026-27");
  });
});
