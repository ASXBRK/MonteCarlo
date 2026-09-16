import { checkYearConservation } from "../../../../src/conservationCheck.js";
export function conserve(out, label) {
  const fails = [];
  for (let y = 0; y < out.yearly.length - 1; y++) {
    try { checkYearConservation(out, y, `${label} y${y}`); } catch (e) { fails.push(String(e.message).slice(0, 300)); }
  }
  return fails;
}
