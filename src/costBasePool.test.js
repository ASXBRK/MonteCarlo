import { describe, it, expect } from "vitest";
import {
  createPool, poolAdd, poolConsume, poolNewFy,
  poolDeemedReacquisition, preReformTaxableGain,
} from "./costBasePool.js";

describe("pool mechanics", () => {
  it("proportional consume: hand-computed slice", () => {
    // Seed $100k, asset now worth $150k, sell $30k → f = 0.2, slice =
    // $20k, gain = $10k, pool left = $80k.
    const p = createPool(100000);
    const { state, gain } = poolConsume(p, 30000, 150000);
    expect(gain).toBeCloseTo(10000, 8);
    expect(state.pool).toBeCloseTo(80000, 8);
  });

  it("contribute then partial sale: additions uplift the pool", () => {
    let p = createPool(100000);
    p = poolAdd(p, 20000); // pool 120k
    // Asset worth 160k, sell 40k → f = 0.25, slice 30k, gain 10k.
    const { state, gain } = poolConsume(p, 40000, 160000);
    expect(gain).toBeCloseTo(10000, 8);
    expect(state.pool).toBeCloseTo(90000, 8);
  });

  it("reinvested distributions uplift the pool monthly", () => {
    let p = createPool(50000);
    for (let m = 0; m < 12; m++) p = poolAdd(p, 100);
    expect(p.pool).toBeCloseTo(51200, 8);
    expect(p.fyAdditions).toBeCloseTo(1200, 8);
  });

  it("a sale below the consumed slice is a capital loss", () => {
    const p = createPool(100000);
    // Asset fell to 80k, sell half (40k) → slice 50k → loss 10k.
    const { gain } = poolConsume(p, 40000, 80000);
    expect(gain).toBeCloseTo(-10000, 8);
  });

  it("full sale consumes the whole pool", () => {
    const p = createPool(100000);
    const { state, gain } = poolConsume(p, 130000, 130000);
    expect(state.pool).toBeCloseTo(0, 8);
    expect(gain).toBeCloseTo(30000, 8);
  });

  it("consume scales fyAdditions with the unsold fraction", () => {
    let p = poolAdd(createPool(90000), 10000); // pool 100k, fyAdd 10k
    const { state } = poolConsume(p, 50000, 200000); // f = 0.25
    expect(state.fyAdditions).toBeCloseTo(7500, 8);
    expect(poolNewFy(state).fyAdditions).toBe(0);
  });
});

describe("deemed reacquisition (1 July 2027)", () => {
  it("resets the pool to market value; an immediate same-value sale has zero gain", () => {
    let p = createPool(40000); // large unrealised gain sitting on 200k of value
    p = poolDeemedReacquisition(p, 200000);
    expect(p.pool).toBe(200000);
    const { gain } = poolConsume(p, 50000, 200000);
    expect(gain).toBeCloseTo(0, 8); // unrealised history erased
  });
});

describe("pre-reform discount treatment (decision 10)", () => {
  it("all-old money gets the full 50% discount; losses pass through", () => {
    expect(preReformTaxableGain(10000, 0)).toBeCloseTo(5000, 8);
    expect(preReformTaxableGain(-4000, 0)).toBe(-4000);
  });

  it("same-FY additions dilute the discount proportionally", () => {
    // 20% new money: taxable = 10,000 × (0.8×0.5 + 0.2×1) = 6,000.
    expect(preReformTaxableGain(10000, 0.2)).toBeCloseTo(6000, 8);
  });

  it("newMoneyFraction reflects this-FY additions at sale time", () => {
    const p = poolAdd(createPool(80000), 20000); // 20% new
    const { newMoneyFraction } = poolConsume(p, 10000, 150000);
    expect(newMoneyFraction).toBeCloseTo(0.2, 8);
  });
});
