// Liability amortisation helpers — pure, nominal-dollar math (D3).
//
// Loans live in NOMINAL dollars: interest accrues on the nominal
// balance and repayments are nominal-fixed, so in the real-terms
// engine frame both deflate by (1+cpi)^(m/12) — which is exactly why
// real mortgage burdens fall over time. The engine simulates each loan
// nominally inside the monthly loop and deflates at the ledger.
//
// v1 limitations (disclosed): constant interest rate for the whole
// projection (the level payment is computed once); no redraw. Extra
// and lump-sum repayments landed in Document Set Commit 5 — see
// scheduledAmortisation below and deterministic.js's liability loop.

// Standard level monthly payment: P·i / (1 − (1+i)^−n); P/n at i = 0.
export function levelPayment(principal, monthlyRate, nMonths) {
  const P = Math.max(0, principal);
  const n = Math.max(1, Math.round(nMonths));
  if (P === 0) return 0;
  if (monthlyRate <= 0) return P / n;
  return (P * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -n));
}

// Contractual payment profile for a liability at (0-based) loan month
// mRel: interest-only for ioMonths, then the level P&I payment over
// the remainder of the term.
export function contractualPayment(liab, mRel) {
  const i = monthlyRate(liab);
  const termM = termMonths(liab);
  const ioM = ioMonths(liab);
  if (mRel >= termM) return { pi: 0, io: false };
  if (mRel < ioM) return { pi: 0, io: true }; // pay interest as charged
  return { pi: levelPayment(liab.balance, i, termM - ioM), io: false };
}

export const monthlyRate = (l) => (l.interestRatePct ?? 0) / 100 / 12;
export const termMonths = (l) => Math.max(1, Math.round((l.termYears ?? 30) * 12));
export const ioMonths = (l) =>
  l.repayment === "io" ? Math.min(termMonths(l), Math.max(0, Math.round((l.ioYears ?? 0) * 12))) : 0;

// Months until a loan (with no offset) reaches zero: the full term for
// a healthy amortisation; Infinity when IO/underpayment never retires
// it (rate 0 edge cases resolve to the term).
export function payoffMonths(l) {
  const i = monthlyRate(l);
  const termM = termMonths(l);
  const ioM = ioMonths(l);
  const pmt = levelPayment(l.balance, i, termM - ioM);
  if (l.balance <= 0) return 0;
  if (pmt <= l.balance * i && i > 0) return Infinity; // never amortises
  return termM;
}

// scheduledAmortisation({ balance, i, ioM, termM, pmtPI, startMonth,
//   inflAt }) → { totalInterestReal, payoffMonth } — the CONTRACTUAL
// path with no extra repayments (Document Set Commit 5's "scheduled
// path" baseline), simulated with the exact same month-by-month
// mechanics as deterministic.js's own liability loop (interest, then
// IO-or-level payment, floor at zero) so the two stay comparable.
// payoffMonth is always termM by construction (a level payment is
// solved to exactly retire the balance over termM − ioM months) —
// returned anyway so a caller never has to re-derive it. inflAt
// deflates each month's interest to real dollars at its OWN point in
// the projection (startMonth + month), the same convention the real
// loop's `defl` uses, so interest saved is a like-for-like comparison.
export function scheduledAmortisation({ balance, i, ioM, termM, pmtPI, startMonth = 0, inflAt }) {
  let b = balance;
  let totalInterestReal = 0;
  for (let month = 0; month < termM && b > 1e-9; month++) {
    const interest = b * i;
    const contractual = month < ioM ? interest : pmtPI;
    const payment = Math.min(Math.max(contractual, 0), b + interest);
    b = b + interest - payment;
    if (b < 1e-9) b = 0;
    totalInterestReal += interest / inflAt(startMonth + month);
  }
  return { totalInterestReal, payoffMonth: termM };
}
