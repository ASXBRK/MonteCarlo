// Liability amortisation helpers — pure, nominal-dollar math (D3).
//
// Loans live in NOMINAL dollars: interest accrues on the nominal
// balance and repayments are nominal-fixed, so in the real-terms
// engine frame both deflate by (1+cpi)^(m/12) — which is exactly why
// real mortgage burdens fall over time. The engine simulates each loan
// nominally inside the monthly loop and deflates at the ledger.
//
// v1 limitations (disclosed): constant interest rate for the whole
// projection (the level payment is computed once), no extra/early
// repayments, no redraw.

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
