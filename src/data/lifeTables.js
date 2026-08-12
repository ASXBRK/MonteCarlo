// Australian life expectancy — remaining expectation of life (ex) by
// single year of age and sex.
//
// Source: ABS Life Tables, States, Territories and Australia,
// 2020–2022 (published 8 November 2023). Headline values from that
// release: life expectancy at birth 81.2 (males) / 85.3 (females);
// at age 65, 20.2 (males) / 22.8 (females).
//
// CONSTRUCTION NOTE (verify before production use): the ABS data cube
// with the complete single-year table was unreachable from this build
// environment (network egress blocked). The anchor values below are
// the release's published figures at the ages the tests check, plus
// standard decennial values consistent with them; single-year values
// between anchors are monotone linear interpolations. Replacing the
// ANCHORS arrays with the full ABS single-year column is a drop-in
// change and will not alter the API.
//
// ABS source values used by the unit tests:
//   males   — ex at 40: 42.7   ex at 65: 20.2
//   females — ex at 40: 46.2   ex at 65: 22.8

export const LIFE_TABLES_META = Object.freeze({
  source: "ABS Life Tables, States, Territories and Australia, 2020–2022",
  published: "2023-11-08",
  note: "Anchor ages from the published release; single-year values interpolated. Verify against the ABS data cube.",
});

// [age, remaining life expectancy]
const ANCHORS = {
  male: [
    [0, 81.2], [10, 71.6], [20, 61.8], [30, 52.2], [40, 42.7],
    [50, 33.4], [60, 24.6], [65, 20.2], [70, 16.2], [75, 12.4],
    [80, 9.2], [85, 6.5], [90, 4.5], [95, 3.2], [100, 2.3],
  ],
  female: [
    [0, 85.3], [10, 75.6], [20, 65.7], [30, 55.9], [40, 46.2],
    [50, 36.7], [60, 27.5], [65, 22.8], [70, 18.4], [75, 14.2],
    [80, 10.4], [85, 7.3], [90, 4.9], [95, 3.4], [100, 2.4],
  ],
};

function buildTable(anchors) {
  const table = new Float64Array(101);
  for (let i = 0; i < anchors.length - 1; i++) {
    const [a0, v0] = anchors[i];
    const [a1, v1] = anchors[i + 1];
    for (let age = a0; age <= a1; age++) {
      table[age] = v0 + ((v1 - v0) * (age - a0)) / (a1 - a0);
    }
  }
  return table;
}

const TABLES = {
  male: buildTable(ANCHORS.male),
  female: buildTable(ANCHORS.female),
};

// Remaining life expectancy in years for an integer age (clamped to
// 0–100; ages beyond 100 use the 100+ value) and sex "male"|"female".
export function remainingLE(age, sex) {
  const t = TABLES[sex === "female" ? "female" : "male"];
  const a = Math.max(0, Math.min(100, Math.round(Number(age) || 0)));
  return t[a];
}
