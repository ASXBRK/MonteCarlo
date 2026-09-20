import { describe, it, expect } from "vitest";
import { fmtLedgerCell, csvMoney } from "./moneyDisplay.js";

// Recovers the signed, rounded magnitude a table cell displays, so it
// can be compared directly against a CSV cell's own numeric value —
// stripping only the table's own punctuation (thousands separator,
// parentheses), never re-deriving a value independently.
function tableMagnitude(display) {
  if (display === "–") return 0;
  const negative = display.startsWith("(");
  const digits = display.replace(/[(),]/g, "");
  const n = Number(digits);
  return negative ? -n : n;
}

describe("fmtLedgerCell (table)", () => {
  it("rounds to the nearest whole dollar", () => {
    expect(fmtLedgerCell(1234.49)).toBe("1,234");
    expect(fmtLedgerCell(1234.5)).toBe("1,235");
  });
  it("shows near-zero as a dash", () => {
    expect(fmtLedgerCell(0)).toBe("–");
    expect(fmtLedgerCell(0.004)).toBe("–");
    expect(fmtLedgerCell(-0.004)).toBe("–");
  });
  it("parenthesises negatives (CLAUDE.md's own locked table convention)", () => {
    expect(fmtLedgerCell(-1234)).toBe("(1,234)");
  });
});

describe("csvMoney (CSV)", () => {
  it("rounds to the nearest whole dollar, same as the table", () => {
    expect(csvMoney(1234.49)).toBe("1234");
    expect(csvMoney(1234.5)).toBe("1235");
  });
  it("never writes cent-level precision", () => {
    expect(csvMoney(1234.567)).not.toContain(".");
  });
  it("writes a plain minus sign, no parentheses — a CSV cell stays spreadsheet-parseable", () => {
    expect(csvMoney(-1234)).toBe("-1234");
  });
  it("writes a clean 0 for -0, not '-0'", () => {
    expect(csvMoney(-0.004)).toBe("0");
  });
});

describe("table and CSV agree on rounding and sign (docs/specs/39-cleanup-rules-cascade.md, Commit 4, review finding 2.9)", () => {
  it("agree across a stratified sweep of representative values", () => {
    const values = [
      0, 0.004, -0.004, 0.5, -0.5, 1, -1, 1234.49, -1234.49, 1234.5, -1234.5,
      999999.99, -999999.99, 1000000, -1000000, 0.001, -0.001, 250000.5, -250000.5,
    ];
    for (const v of values) {
      const tableValue = tableMagnitude(fmtLedgerCell(v));
      const csvValue = Number(csvMoney(v));
      expect(csvValue).toBe(tableValue);
      // Same sign meaning: a table cell in parentheses is negative iff
      // the CSV cell carries a leading minus (both are "0", i.e.
      // neither, when the rounded figure is exactly zero).
      expect(Math.sign(csvValue)).toBe(Math.sign(tableValue));
    }
  });
});
