import { describe, it, expect } from "vitest";
import { assessPerson, litoAmount, bracketSettings, realThreshold, FRANKING_RATE } from "./annual.js";

describe("litoAmount (legislated schedule)", () => {
  it("matches the published taper points", () => {
    expect(litoAmount(0)).toBe(700);
    expect(litoAmount(37500)).toBe(700);
    expect(litoAmount(45000)).toBeCloseTo(325, 8);   // 700 − 7500×5%
    expect(litoAmount(50000)).toBeCloseTo(250, 8);   // 325 − 5000×1.5%
    expect(litoAmount(66667)).toBeCloseTo(0, 1);     // cut-out
    expect(litoAmount(80000)).toBe(0);
  });
});

describe("bracketSettings (decision 6)", () => {
  it("selects each FY's own legislated table up to 2027-28", () => {
    expect(bracketSettings(2025, "indexed", 0.025).key).toBe("2025-26");
    expect(bracketSettings(2026, "indexed", 0.025).key).toBe("2026-27");
    expect(bracketSettings(2027, "indexed", 0.025).key).toBe("2027-28");
    expect(bracketSettings(2045, "indexed", 0.025).key).toBe("2027-28");
  });

  it("indexed mode never scales; frozen mode scales after FY2027-28", () => {
    expect(bracketSettings(2047, "indexed", 0.025).k).toBe(1);
    expect(bracketSettings(2026, "frozen", 0.025).k).toBe(1);
    expect(bracketSettings(2027, "frozen", 0.025).k).toBe(1);
    expect(bracketSettings(2047, "frozen", 0.025).k).toBeCloseTo(Math.pow(1.025, 20), 10);
  });
});

describe("assessPerson — known values", () => {
  it("$100k salary, FY2027-28, no investments (hand-computed)", () => {
    // Brackets 2027-28: 0–18,200 @ 0%; 18,200–45,000 @ 14% = 26,800 ×
    // 0.14 = $3,752; 45,000–100,000 @ 30% = 55,000 × 0.30 = $16,500.
    // Income tax = $20,252. Medicare = 2% × 100,000 = $2,000 (well
    // above the shading band). LITO = $0 (income > $66,667 cut-out).
    // Net = 20,252 + 2,000 = $22,252.
    const a = assessPerson({ fyStartYear: 2027, ordinaryIncome: 100000 });
    expect(a.incomeTax).toBeCloseTo(20252, 6);
    expect(a.medicare).toBeCloseTo(2000, 6);
    expect(a.lito).toBe(0);
    expect(a.netIncomeTax).toBeCloseTo(22252, 6);
    expect(a.cgtTax).toBe(0);
  });

  it("fully-franked $7,000 distribution, zero other income → full-credit refund", () => {
    const a = assessPerson({
      fyStartYear: 2027,
      distributions: { franked: 7000, unfranked: 0 },
    });
    // Taxable = 7,000 + 3,000 gross-up = 10,000 → tax-free threshold,
    // no Medicare. Refundable credits come straight back.
    expect(a.frankingCredits).toBeCloseTo(7000 * FRANKING_RATE, 8);
    expect(a.incomeTax).toBe(0);
    expect(a.netIncomeTax).toBeCloseTo(-3000, 6);
  });

  it("Medicare shading-in band", () => {
    const a = assessPerson({ fyStartYear: 2027, ordinaryIncome: 30000 });
    expect(a.medicare).toBeCloseTo((30000 - 28011) * 0.10, 6);
  });

  it("deductions reduce taxable income; excess floors at zero", () => {
    const a = assessPerson({ fyStartYear: 2027, ordinaryIncome: 50000, deductions: 5000 });
    const b = assessPerson({ fyStartYear: 2027, ordinaryIncome: 45000 });
    expect(a.incomeTax).toBeCloseTo(b.incomeTax, 8);
    const c = assessPerson({ fyStartYear: 2027, ordinaryIncome: 1000, deductions: 50000 });
    expect(c.taxableIncome).toBe(0);
    expect(c.netIncomeTax).toBe(0);
  });
});

describe("realThreshold (C4 assumptions rows)", () => {
  it("indexed mode holds thresholds flat in real terms", () => {
    expect(realThreshold(18200, 2027, "indexed", 0.025)).toBe(18200);
    expect(realThreshold(18200, 2047, "indexed", 0.025)).toBe(18200);
  });

  it("frozen mode shrinks thresholds by CPI after FY2027-28", () => {
    expect(realThreshold(18200, 2027, "frozen", 0.025)).toBe(18200);
    expect(realThreshold(18200, 2037, "frozen", 0.025))
      .toBeCloseTo(18200 / Math.pow(1.025, 10), 8);
  });
});

describe("assessPerson — tax profile (C3)", () => {
  it("non-resident: non-resident brackets, no Medicare, no LITO", () => {
    // $100k FY2027-28 non-resident: 100,000 × 30% = $30,000 flat —
    // no tax-free threshold, no levy, no offset. Resident: $22,252.
    const nr = assessPerson({
      fyStartYear: 2027, ordinaryIncome: 100000,
      taxProfile: { residency: "nonResident", medicareExempt: false },
    });
    expect(nr.incomeTax).toBeCloseTo(30000, 6);
    expect(nr.medicare).toBe(0);
    expect(nr.lito).toBe(0);
    expect(nr.netIncomeTax).toBeCloseTo(30000, 6);
    const res = assessPerson({ fyStartYear: 2027, ordinaryIncome: 100000 });
    expect(res.netIncomeTax).toBeCloseTo(22252, 6);
  });

  it("non-resident LITO stays zero at low income; franking stays refundable", () => {
    const nr = assessPerson({
      fyStartYear: 2027, distributions: { franked: 7000, unfranked: 0 },
      taxProfile: { residency: "nonResident", medicareExempt: false },
    });
    // Taxable 10,000 → 3,000 tax at 30%; credits 3,000 refundable → net 0.
    expect(nr.incomeTax).toBeCloseTo(3000, 6);
    expect(nr.lito).toBe(0);
    expect(nr.netIncomeTax).toBeCloseTo(0, 6);
  });

  it("Medicare exemption zeroes the levy for the exempt person only", () => {
    const exempt = assessPerson({
      fyStartYear: 2027, ordinaryIncome: 100000,
      taxProfile: { residency: "resident", medicareExempt: true },
    });
    const applies = assessPerson({
      fyStartYear: 2027, ordinaryIncome: 100000,
      taxProfile: { residency: "resident", medicareExempt: false },
    });
    expect(exempt.medicare).toBe(0);
    expect(exempt.netIncomeTax).toBeCloseTo(20252, 6);
    expect(applies.medicare).toBeCloseTo(2000, 6);
  });

  it("non-resident brackets follow the bracket-mode scaling", () => {
    const at = (bracketMode, fy) => assessPerson({
      fyStartYear: fy, bracketMode, cpi: 0.025, ordinaryIncome: 100000,
      taxProfile: { residency: "nonResident", medicareExempt: false },
    }).netIncomeTax;
    expect(at("frozen", 2027)).toBeCloseTo(at("indexed", 2027), 8);
    expect(at("frozen", 2046)).toBeGreaterThan(at("indexed", 2046) + 500); // creeps into 37%
  });
});

describe("assessPerson — bracket modes over time", () => {
  const at = (fyStartYear, bracketMode) =>
    assessPerson({ fyStartYear, bracketMode, cpi: 0.025, ordinaryIncome: 100000 }).netIncomeTax;

  it("equal in FY2026-27 and FY2027-28, higher under frozen by year 20", () => {
    expect(at(2026, "frozen")).toBeCloseTo(at(2026, "indexed"), 8);
    expect(at(2027, "frozen")).toBeCloseTo(at(2027, "indexed"), 8);
    expect(at(2046, "indexed")).toBeCloseTo(at(2027, "indexed"), 8); // real-constant
    expect(at(2046, "frozen")).toBeGreaterThan(at(2046, "indexed") + 1000); // bracket creep bites
  });
});

describe("assessPerson — CGT", () => {
  it("post-reform 30% floor beats a low marginal rate", () => {
    // Zero other income: marginal tax on a $10k gain is $0 (below the
    // tax-free threshold) so the 30% minimum applies.
    const a = assessPerson({ fyStartYear: 2027, netCapitalGain: 10000 });
    expect(a.cgtTax).toBeCloseTo(3000, 6);
  });

  it("pre-reform has no floor", () => {
    const a = assessPerson({ fyStartYear: 2026, netCapitalGain: 10000 });
    expect(a.cgtTax).toBe(0); // below threshold, no minimum tax
  });

  it("marginal + Medicare by differencing when above the floor", () => {
    // $100k base, $50k gain, FY2027-28: the gain spans 100k→150k, so
    // marginal on the gain = 35,000 × 0.30 + 15,000 × 0.37 = 16,050
    // (above the 15,000 floor); Medicare on the gain = 2% × 50,000 =
    // 1,000. Total 17,050.
    const a = assessPerson({ fyStartYear: 2027, ordinaryIncome: 100000, netCapitalGain: 50000 });
    expect(a.cgtTax).toBeCloseTo(17050, 6);
  });

  it("losses carry forward and offset later gains, never ordinary income", () => {
    const lossYear = assessPerson({ fyStartYear: 2027, ordinaryIncome: 100000, netCapitalGain: -5000 });
    expect(lossYear.cgtTax).toBe(0);
    expect(lossYear.lossCarryFwd).toBe(5000);
    expect(lossYear.netIncomeTax).toBeCloseTo(22252, 6); // untouched by the loss

    const gainYear = assessPerson({
      fyStartYear: 2028, ordinaryIncome: 100000,
      netCapitalGain: 8000, capitalLossCarryFwd: lossYear.lossCarryFwd,
    });
    expect(gainYear.taxableGain).toBe(3000);
    expect(gainYear.lossCarryFwd).toBe(0);
  });

  it("LITO withdraws on taxable income including the gain", () => {
    const noGain = assessPerson({ fyStartYear: 2027, ordinaryIncome: 37000 });
    const withGain = assessPerson({ fyStartYear: 2027, ordinaryIncome: 37000, netCapitalGain: 20000 });
    expect(noGain.lito).toBeCloseTo(700, 6);
    expect(withGain.lito).toBeLessThan(700);
  });
});

describe("excess concessional super contributions (Tier 1.2)", () => {
  it("excess CC is taxed at the marginal rate, offset by the 15% already paid in the fund", () => {
    const base = assessPerson({ fyStartYear: 2027, ordinaryIncome: 100000 });
    const withExcess = assessPerson({ fyStartYear: 2027, ordinaryIncome: 100000, excessConcessionalContributions: 10000 });
    // Taxable income rises by the excess, same as ordinary income would.
    expect(withExcess.taxableIncome).toBeCloseTo(base.taxableIncome + 10000, 6);
    // The offset is exactly 15% of the excess (well within the tax payable).
    expect(withExcess.excessCcOffset).toBeCloseTo(1500, 6);
    // Net tax rises by the marginal tax + Medicare on the excess, less the offset.
    const marginalOnExcess = withExcess.incomeTax - base.incomeTax;
    const medicareOnExcess = withExcess.medicare - base.medicare;
    expect(marginalOnExcess + medicareOnExcess).toBeGreaterThan(1500); // MTR+Medicare here exceeds 15%, so it's a real net cost
    expect(withExcess.netIncomeTax - base.netIncomeTax).toBeCloseTo(marginalOnExcess + medicareOnExcess - 1500, 2);
  });

  it("the offset is non-refundable — capped at the tax payable, never pushing net tax negative on its own", () => {
    // A very low income: income tax payable is tiny, so a large excess
    // CC's 15% offset can't exceed what's actually owed.
    const a = assessPerson({ fyStartYear: 2027, ordinaryIncome: 0, excessConcessionalContributions: 5000 });
    expect(a.excessCcOffset).toBeLessThanOrEqual(a.incomeTax);
  });

  it("zero excess CC (the default) leaves every figure unchanged", () => {
    const base = assessPerson({ fyStartYear: 2027, ordinaryIncome: 80000 });
    const explicit = assessPerson({ fyStartYear: 2027, ordinaryIncome: 80000, excessConcessionalContributions: 0 });
    expect(explicit).toEqual(base);
  });
});

describe("FHSSS taxable release (Document Set Commit 3)", () => {
  it("the taxable release is taxed at the marginal rate, offset by 30%", () => {
    const base = assessPerson({ fyStartYear: 2027, ordinaryIncome: 100000 });
    const withRelease = assessPerson({ fyStartYear: 2027, ordinaryIncome: 100000, fhsssTaxableRelease: 10000 });
    expect(withRelease.taxableIncome).toBeCloseTo(base.taxableIncome + 10000, 6);
    expect(withRelease.fhsssOffset).toBeCloseTo(3000, 6);
    const marginalOnRelease = withRelease.incomeTax - base.incomeTax;
    const medicareOnRelease = withRelease.medicare - base.medicare;
    expect(withRelease.netIncomeTax - base.netIncomeTax).toBeCloseTo(marginalOnRelease + medicareOnRelease - 3000, 2);
  });

  it("the offset is non-refundable — capped at the tax payable, applied after LITO and the excess-CC offset", () => {
    const a = assessPerson({ fyStartYear: 2027, ordinaryIncome: 0, fhsssTaxableRelease: 5000 });
    expect(a.fhsssOffset).toBeLessThanOrEqual(a.incomeTax);
  });

  it("stacks correctly alongside an excess-CC offset in the same year — both non-refundable, applied in sequence", () => {
    const a = assessPerson({ fyStartYear: 2027, ordinaryIncome: 100000, excessConcessionalContributions: 5000, fhsssTaxableRelease: 10000 });
    expect(a.excessCcOffset).toBeCloseTo(750, 6); // 15% of 5,000
    expect(a.fhsssOffset).toBeCloseTo(3000, 6); // 30% of 10,000, unaffected by the CC offset since plenty of tax remains
  });

  it("zero release (the default) leaves every figure unchanged", () => {
    const base = assessPerson({ fyStartYear: 2027, ordinaryIncome: 80000 });
    const explicit = assessPerson({ fyStartYear: 2027, ordinaryIncome: 80000, fhsssTaxableRelease: 0 });
    expect(explicit).toEqual(base);
  });
});
