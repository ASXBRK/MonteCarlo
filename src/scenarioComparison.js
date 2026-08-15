// Scenario comparison (Implementation/Rates spec, Commit 6) — pure
// helpers only. Loading OTHER scenarios from storage and running
// projectPlan() on each is main.js's job (the same way loadActiveState()
// already does it for the active one) — this module never touches
// localStorage. "Current is simply another scenario — no new data
// model" (the spec's own words): every compared scenario is a full,
// independent projectPlan() run, never approximated or interpolated.

// Two plan windows are "the same age axis" iff the client's own
// current age, start date, and end age all match exactly. Partner
// differences don't affect the axis at all — the projection's age
// axis is client-anchored throughout (CLAUDE.md's Time conventions),
// so a partner-only difference between two otherwise-identical windows
// still lines up correctly and must NOT be refused.
export function planWindowsMatch(planA, planB) {
  return planA.client.currentAge === planB.client.currentAge
    && planA.start.year === planB.start.year && planA.start.month === planB.start.month
    && planA.endAge === planB.endAge;
}

// Every row's value at year y from buildKeyFiguresGroups' own return
// shape (an array of {title, rows: [{label, cell(y)}]}) — flattened to
// one ordered {label, value} list. Reading straight through `cell(y)`
// (never re-deriving) is what guarantees a comparison column equals
// that scenario's own Key figures view exactly.
export function keyFigureValuesAtYear(groups, y) {
  return groups.flatMap((g) => g.rows).map((r) => ({ label: r.label, value: r.cell(y) }));
}

// scenarioValues: one keyFigureValuesAtYear() result per scenario, in
// the SAME order the scenarios were picked — index 0 is always the
// base every delta computes against. Rows are matched by LABEL, not
// index/position: a row that exists in only some scenarios (e.g. HELP
// balance, which only joins the table when a HELP debt exists at all)
// must never silently misalign against an unrelated row in another
// scenario's list purely because they happened to land at the same
// index.
export function keyFigureComparisonRows(scenarioValues) {
  if (scenarioValues.length === 0) return [];
  const order = [];
  const seen = new Set();
  for (const sv of scenarioValues) for (const r of sv) { if (!seen.has(r.label)) { seen.add(r.label); order.push(r.label); } }
  const baseByLabel = new Map(scenarioValues[0].map((r) => [r.label, r.value]));
  return order.map((label) => {
    const values = scenarioValues.map((sv) => sv.find((r) => r.label === label)?.value ?? null);
    const base = baseByLabel.get(label);
    const deltas = values.slice(1).map((v) => (v == null || base == null ? null : v - base));
    return { label, values, deltas };
  });
}
