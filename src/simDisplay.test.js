import { describe, it, expect } from "vitest";
import { formatSimPct, isSimPctCapped, roundSimMoney } from "./simDisplay.js";

describe("formatSimPct (docs/specs/36-retirement-outputs.md, Commit 3 — display honesty)", () => {
  it("rounds to the nearest 1% for an ordinary value", () => {
    expect(formatSimPct(0.5)).toBe("50%");
    expect(formatSimPct(0.126)).toBe("13%");
    expect(formatSimPct(0)).toBe("0%");
  });

  it("a value that rounds to exactly 99% displays as a plain 99%, not capped", () => {
    expect(formatSimPct(0.994)).toBe("99%");
  });

  it("a value that would round to 100% displays as 99%+ instead — never above 99%", () => {
    expect(formatSimPct(0.995)).toBe("99%+");
    expect(formatSimPct(0.999)).toBe("99%+");
  });

  it("a genuine 100% (every simulated path succeeded/ruined) still caps at 99%+ — no probability figure ever implies a guarantee", () => {
    expect(formatSimPct(1)).toBe("99%+");
  });

  it("clamps out-of-range input defensively rather than producing a malformed string", () => {
    expect(formatSimPct(1.5)).toBe("99%+");
    expect(formatSimPct(-0.2)).toBe("0%");
  });

  it("null/NaN → an em dash, never a malformed percentage", () => {
    expect(formatSimPct(null)).toBe("—");
    expect(formatSimPct(NaN)).toBe("—");
  });
});

describe("isSimPctCapped", () => {
  it("true exactly when formatSimPct's own output is the capped form", () => {
    expect(isSimPctCapped(0.995)).toBe(true);
    expect(isSimPctCapped(1)).toBe(true);
    expect(isSimPctCapped(0.994)).toBe(false);
    expect(isSimPctCapped(0.5)).toBe(false);
  });
});

describe("roundSimMoney (docs/specs/39-cleanup-rules-cascade.md, Commit 4, review finding 2.6)", () => {
  it("rounds to the nearest $1,000", () => {
    expect(roundSimMoney(514764)).toBe(515000);
    expect(roundSimMoney(514499)).toBe(514000);
    expect(roundSimMoney(514500)).toBe(515000);
  });
  it("rounds a negative figure symmetrically", () => {
    expect(roundSimMoney(-514764)).toBe(-515000);
  });
  it("leaves an exact multiple of $1,000 unchanged", () => {
    expect(roundSimMoney(500000)).toBe(500000);
    expect(roundSimMoney(0)).toBe(0);
  });
  it("null/NaN passes through unchanged, never a malformed figure", () => {
    expect(roundSimMoney(null)).toBeNull();
    expect(Number.isNaN(roundSimMoney(NaN))).toBe(true);
  });
});
