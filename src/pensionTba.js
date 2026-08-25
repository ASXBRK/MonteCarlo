// Transfer balance cap and account (spec 20, Commit 4). Pure, no
// engine/DOM — deterministic.js drives this with the per-year general
// cap (data/superRates.js's generalTransferBalanceCap) and each
// pension's own commencement/conversion events.
//
// Two DISTINCT numbers this module tracks per person:
//   - the GENERAL transfer balance cap (GTBC) — one figure for
//     everyone, CPI-indexed in $100,000 steps (already built for
//     Division 296 — superRatesFor's own generalTransferBalanceCap).
//   - each person's PERSONAL transfer balance cap — starts equal to
//     the GTBC, but ONLY grows by the UNUSED PROPORTION of any later
//     GTBC increase, where "unused" is 100% minus the HIGHEST
//     percentage of their OWN personal cap they have EVER used (a
//     high-water mark, not the CURRENT balance — a later debit doesn't
//     "unuse" cap space that was already used at a higher point). Once
//     that high-water mark reaches 100%, the personal cap never
//     indexes again — "the fiddly part" the spec calls out, and the
//     one most likely to be implemented as simple uniform indexation
//     if this proportional rule isn't followed exactly.
//
// A pension's TRANSFER BALANCE ACCOUNT tracks CREDITS (commencing a
// retirement-phase pension — an ABP always, from commencement; a TTR
// only once it CONVERTS, at its then-current value, not its original
// commencement amount) and DEBITS (a commutation, spec 20 Commit 5, at
// the commuted amount). Ordinary PENSION PAYMENTS are never a debit —
// a common misunderstanding, and worth this comment: the cap measures
// what was PLACED into retirement phase, not what remains there.
//
// Excess: modelled as a flagged warning (excess amount + the notional
// earnings tax rate that would apply — 15% on a first breach, 30% on
// any subsequent one) — the commutation-authority PROCESS itself (the
// ATO forcing a corrective commutation) is explicitly out of scope
// (spec's own words) — this is disclosure, not an enforced correction,
// so it debits/credits NOTHING and is not a money flow the conservation
// invariant needs to know about.

export function createTransferBalanceAccount(generalCap) {
  return { balance: 0, personalCap: generalCap, highestUsedPct: 0, hasBreached: false };
}

// Applied once per FY, before that FY's own credit events — grows the
// personal cap by the UNUSED proportion (1 − highestUsedPct, floored at
// 0 so a member already over 100% gets none) of however much the
// general cap itself increased since the last time this ran. A no-op
// when the general cap hasn't moved (most years, between $100k steps).
export function indexTransferBalanceCap(tba, generalCapDelta) {
  if (!(generalCapDelta > 0)) return tba;
  const unusedProportion = Math.max(0, 1 - tba.highestUsedPct);
  return { ...tba, personalCap: tba.personalCap + unusedProportion * generalCapDelta };
}

// A credit — pension commencement (ABP: always, at commencement; TTR:
// only at conversion, spec's own words) — at the given real-dollar
// amount. Returns the new account state plus this EVENT's own excess
// disclosure (null when no breach) — the excess is reported per event,
// not carried as running state, since a later debit can bring the
// account back under the cap without erasing the fact that a breach
// happened (hasBreached, inside `tba`, is the one that persists).
export function creditTransferBalance(tba, amount) {
  if (!(amount > 0)) return { tba, excess: null, excessTaxRate: null };
  const balance = tba.balance + amount;
  const usedPct = tba.personalCap > 0 ? balance / tba.personalCap : Infinity;
  const highestUsedPct = Math.max(tba.highestUsedPct, usedPct);
  const excessAmount = Math.max(0, balance - tba.personalCap);
  const breachedNow = excessAmount > 0;
  const excessTaxRate = breachedNow ? (tba.hasBreached ? 0.30 : 0.15) : null;
  return {
    tba: { ...tba, balance, highestUsedPct, hasBreached: tba.hasBreached || breachedNow },
    excess: breachedNow ? excessAmount : null,
    excessTaxRate,
  };
}

// A debit — a commutation (spec 20, Commit 5), at the commuted amount.
// Floored at 0 (never negative) — never itself re-evaluated against the
// cap (a debit can only ever bring the balance DOWN, so it can't create
// a new breach) and never adjusts highestUsedPct (a high-water mark;
// see this module's own header).
export function debitTransferBalance(tba, amount) {
  if (!(amount > 0)) return tba;
  return { ...tba, balance: Math.max(0, tba.balance - amount) };
}
