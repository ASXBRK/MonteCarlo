// Money display, table + CSV (docs/specs/39-cleanup-rules-cascade.md,
// Commit 4, review finding 2.9) — pure, no DOM/Plotly, so the ONE
// rounding rule every transposed table and its paired CSV export both
// use can actually be unit-tested for agreement, which main.js itself
// (DOM-dependent throughout) cannot be.
//
// The defect the review found: renderTransposed's own table cells
// (fmtLedgerCell) round to the nearest whole dollar with parentheses
// for negatives; exportTransposedCSV wrote the same cells to the CENT
// with a leading minus sign — two decimal places of precision the
// table never showed, and a different negative-number spelling. "The
// defect is that three conventions coexist" (the spec's own words,
// counting Snapshot's separate-but-already-consistent pair as a
// third) — fixed by putting both functions here, sharing the same
// Math.round, so a genuinely new inconsistency can't creep back in
// unnoticed at a fourth call site.
//
// Table and CSV deliberately do NOT share identical punctuation —
// CLAUDE.md's own locked Outputs convention requires parentheses for
// negatives ON SCREEN, but a CSV cell needs to stay a plain,
// spreadsheet-parseable number (no parentheses, no thousands
// separator). "Agree on rounding and sign" (the spec's own test
// requirement) means: the same underlying rounded magnitude, and the
// same negative-ness — not identical characters, which the locked
// table convention makes impossible anyway.

// The table cell: "–" below half a cent, parenthesised negatives,
// thousands-separated, rounded to the nearest whole dollar.
export function fmtLedgerCell(v) {
  if (Math.abs(v) < 0.005) return "–";
  const s = Math.round(Math.abs(v)).toLocaleString("en-AU");
  return v < 0 ? `(${s})` : s;
}

// The CSV cell: a plain signed integer string, rounded to the SAME
// nearest whole dollar fmtLedgerCell used for the same value —
// deliberately round(|v|) then re-signed, NOT the JS-native
// Math.round(v) directly: Math.round rounds a negative exact-.5 value
// TOWARD zero (Math.round(-0.5) === -0), asymmetric with how
// fmtLedgerCell rounds the same value (Math.round(Math.abs(-0.5)) ===
// 1, shown as "(1)") — the two would silently disagree at exactly
// .5 cents on a negative figure, the one gap a naive shared "just use
// Math.round" fix would have reintroduced. String(0) is "0" (JS
// stringifies -0 as "0" too), so no extra zero-handling is needed.
export function csvMoney(v) {
  return String(v < 0 ? -Math.round(-v) : Math.round(v));
}
