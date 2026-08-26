// Focus: Usable equity and borrowing capacity (Implementation/Rates
// spec, Commit 3) — pure, no DOM/Plotly. Every figure is read straight
// off a real projectPlan() output (row.properties[pid].usableEquity) —
// never re-derived, and this view aggregates them (a plain sum over
// already-produced figures, not a fresh calculation).
//
// The one deliberate discipline this view exists to enforce: usable
// equity is a SECURITY constraint, not a serviceability assessment —
// this tool never asks whether income could service the resulting
// loan. Nothing here may imply a purchase is approvable; see
// buildEquityFocus's own disclosure field and main.js's rendering for
// where that's stated on screen.

// Properties the engine actually tracks a value for — mirrors
// deterministic.js's own `props` filter (status==="owned" needs a
// currentValue, a planned purchase needs a priceToday) exactly, so
// this list matches row.properties' own keys with nothing missing or
// spurious.
export function eligibleEquityProperties(state) {
  return (state.properties ?? []).filter((p) => (p.status === "owned" ? p.currentValue > 0 : p.priceToday > 0));
}

// buildEquityFocus({ out, state }) → the view's data, or null if there
// are no properties to show equity for.
export function buildEquityFocus({ out, state }) {
  const properties = eligibleEquityProperties(state);
  if (properties.length === 0) return null;

  const byYear = out.yearly.map((row, y) => {
    const byProperty = {};
    let total = 0;
    for (const p of properties) {
      const eq = row.properties[p.id]?.usableEquity ?? 0;
      byProperty[p.id] = eq;
      total += eq;
    }
    return { year: y, age: out.schedule.clientAges[y], fyLabel: out.schedule.fyLabels[y], byProperty, total };
  });

  // Drawdowns and debt recycling (spec 24, Commits 1/2) — usableEquity
  // (property value × ceiling − the SECURED loan's own closing balance)
  // already reflects a drawdown or a recycling redraw for free: both
  // increase the loan's closing balance directly, deterministic.js
  // never recomputes usableEquity separately for them. This is purely a
  // disclosure note so the Debt drawdowns/recycling view and this one
  // agree about how much room is left, not a second calculation.
  const drawingDown = (state.liabilities ?? []).filter((l) =>
    properties.some((p) => p.id === l.linkedAssetId) && ((l.drawdowns?.length ?? 0) > 0 || l.recycling?.enabled === true)
  );

  return {
    properties: properties.map((p) => ({ id: p.id, name: p.name, equityCeilingPct: p.equityCeilingPct })),
    byYear,
    // The engine's own insufficient-equity flags (deterministic.js),
    // filtered to this concern — read through, never recomputed.
    warnings: (out.propertyWarnings ?? []).filter((w) => w.type === "insufficientEquity"),
    disclosure: "Usable equity is a security constraint only — the amount a lender would typically lend against a property's value, net of what's already owed. It is not a serviceability assessment: a lender also tests income against the loan, which this tool does not model. Nothing here implies a purchase is approvable.",
    drawdownNote: drawingDown.length > 0
      ? `A drawdown or debt recycling plan against ${drawingDown.map((l) => l.name).join(", ")} is already reducing the usable equity shown here — the same balance increase both views read from.`
      : null,
  };
}
