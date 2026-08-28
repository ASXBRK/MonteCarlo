// Static extrapolation model (spec 30, Commit 1) — a deliberate
// reimplementation of the firm's SECOND projection tool's method, so
// the two approaches can be measured against each other on identical
// inputs (divergence.js, Commit 2; the Focus view and committed
// report, Commit 3). This file does NOT try to improve on that
// method — it reproduces it faithfully, including its disclosed
// failure mode ("money is not conserved": surplus directed to a loan
// that later repays has nowhere to go once the loan is gone), because
// the whole point of spec 30 is to QUANTIFY what a snapshot-and-
// extrapolate tool actually gets wrong, not to build a better one.
//
// Method (locked in by the spec's own words):
//   1. Run the real engine once. Take income, expenses, tax and
//      surplus from ONE snapshot plan-year.
//   2. Hold those figures constant in NOMINAL terms, or index them at
//      CPI (both supported — real tools differ; `indexation` chooses).
//      Since this engine (and this file) works entirely in REAL
//      (today's) dollars, "hold constant in nominal terms" means the
//      REAL figure DECAYS at CPI — exactly this engine's own
//      indexBasis "none" convention; "index at CPI in nominal terms"
//      means the REAL figure stays FLAT — this engine's own
//      indexBasis "cpi" convention. Same formula, same vocabulary,
//      just applied to a whole-of-household figure instead of one row.
//   3. Every balance-holding account rolls forward at its OWN real
//      return: an asset at its profile/allocation's real return
//      (`assetMonthlyRate`, compounded annually); a super or pension
//      account at its OWN snapshot year's IMPLIED real return
//      (post-tax earnings ÷ opening balance, held flat) — deriving it
//      from the outcome rather than re-deriving fund/earnings tax a
//      second time, the same reasoning liabilities (below) use for
//      their own implied rate.
//   4. Every liability's own snapshot-year real P&I payment (interest
//      + principal, already net of any offset — read straight off the
//      real engine's own row) is held/indexed and re-applied every
//      year, at the snapshot year's own IMPLIED real interest rate,
//      until the balance is exhausted.
//   5. Each account's snapshot-year net non-growth flow (contributions,
//      withdrawals, one-offs, deficit funding, surplus-invested for an
//      asset; contributions/payments/commutations/releases net for
//      super and pensions; extra + surplus repayment for a liability)
//      is held/indexed and re-applied the SAME way. An ASSET/SUPER/
//      PENSION account never closes, so its flow continues forever. A
//      LIABILITY closes the year its balance reaches zero — from the
//      NEXT year on, the amount that would have gone there is simply
//      DROPPED, not redirected elsewhere. That drop is the exact
//      defect being measured, reproduced deliberately, not fixed.
//
// Deliberate simplifications, disclosed per the spec's own "document
// each modelling choice and its effect on the result" rule:
//   - Tax is the SNAPSHOT YEAR's own bracket outcome, held/indexed
//     like income — a real snapshot tool has no forward tax-bracket
//     model, so this is faithful, not a shortcut (Commit 2's "tax
//     bracket effects" driver measures exactly this).
//   - Age pension, once entitled at the snapshot year, is held/indexed
//     the same way rather than re-assessed — a snapshot tool has no
//     forward means-test model either (Commit 2's "age pension
//     entitlement" driver).
//   - Fixed-rate rollover is NOT modelled: the snapshot year's own
//     IMPLIED real rate is held flat forever, even if the real
//     engine's loan is on a fixed rate that later reverts to variable
//     (Commit 2's "fixed-rate rollover" driver).
//   - A liability's real P&I payment is taken as a single lump
//     "interest + principal" figure and re-amortised using the
//     snapshot year's own IMPLIED real rate (`interest / opening`)
//     rather than re-deriving a nominal amortisation schedule and
//     deflating it — this keeps the static model entirely in the same
//     real-dollar terms as everything else it holds constant, and is
//     the MORE FAVOURABLE reading for the static approach (a real
//     nominal-schedule reproduction would decay the fixed nominal
//     payment in real terms over time, retiring the loan slightly
//     slower — holding the real payment flat pays it off at least as
//     fast, never slower, than the fully faithful alternative).
//   - Non-reinvest ("paid as cash") assets are treated identically to
//     reinvest-mode ones (their income component grows the balance
//     rather than being paid out as separate household cash) — total
//     net worth is what this analysis compares, and this only shifts
//     WHERE a dollar sits, never how many there are.
//   - Property, bonds and the Working Cash Account are NOT tracked —
//     disclosed, not silently dropped. Property's rent/expense/sale
//     dynamics and bonds' 10-year/125% rules would need their own
//     held/indexed treatment this file doesn't yet build; a household
//     whose net worth leans heavily on either will show a LARGER
//     divergence than this model reports, in the direction of
//     understating both approaches' net worth by the same missing
//     amount (not a source of bias between them, since neither model
//     sees these accounts at all here).
//   - A snapshot year with a deficit (surplusOrDeficit ≤ 0) has no
//     positive surplus to distribute by destination shares; this
//     model then applies scheduled liability payments and account
//     flows as recorded (which may themselves be negative — a net
//     drawdown), but adds no NEW surplus-driven flow beyond what the
//     snapshot year already shows. Not the primary scenario this
//     analysis is built to measure.
//
// `opts.realism` (divergence.js, Commit 2) — each flag substitutes the
// REAL engine's OWN per-year figure for ONE naive held/indexed
// component, isolating exactly one of the seven named drivers at a
// time ("re-running the static model with that single evolving
// feature enabled" — the spec's own words). All default false, which
// reproduces this file's Commit 1 baseline exactly (regression gate:
// no test passes `realism` at all).
//   - `expenseWindows` — real out.yearly[y].expenses instead of held/
//     indexed (school fees ending, a goal funded).
//   - `contributionsStopping` — each asset's/super account's REAL net
//     flow that year instead of the snapshot's held/indexed one
//     (a contribution stopping at retirement or a cap binding).
//   - `taxBrackets` — real out.yearly[y].tax instead of held/indexed.
//   - `fixedRateRollover` — the liability's REAL implied rate that
//     year (interest ÷ opening) instead of the snapshot's flat implied
//     rate, applied to the SCHEDULED portion only (the "extra" surplus
//     payment still behaves per the baseline, isolating the rate
//     effect on its own).
//   - `agePension` — a correction term added to income for JUST the
//     age pension entitlement's real-vs-held-constant difference
//     (income is otherwise still held/indexed as normal — this isolates
//     the pension changing without also isolating wage/other growth).
//   - `superPensionTransitions` — the real engine's OWN combined
//     super+pension total that year, substituted whole, instead of
//     this file's own tracked approximation (captures a preservation-
//     age/pension-phase transition this file's simple per-account
//     roll-forward has no other way to notice).
//   - `loanMaturity` — once a liability's static balance closes, the
//     amount that WOULD have gone to it is REDIRECTED into a synthetic
//     "static cash" balance (included in netAssets) instead of being
//     dropped — the baseline's own defect, switched off in isolation.

import { projectPlan, assetMonthlyRate } from "./deterministic.js";
import { PROFILES } from "./profiles.js";

// Real annual return for one asset, compounding the engine's own real
// monthly rate twelve times — bit-consistent with how the real engine
// itself would grow the SAME asset over a year with no cashflows.
function assetAnnualRealReturn(asset, cpi, profiles) {
  return Math.pow(1 + assetMonthlyRate(asset, cpi, profiles), 12) - 1;
}

// "Hold constant (nominal) or index at CPI (nominal)" as a REAL-dollar
// multiplier, `yearsElapsed` years after the snapshot — see this
// file's own header for why the mapping is CPI→flat / flat→decay.
function indexFactor(indexation, cpi, yearsElapsed) {
  if (indexation === "cpi") return 1;
  return Math.pow(1 / (1 + cpi), yearsElapsed);
}

// A generic "balance account" track shared by assets, super and
// pension accounts: each item gets a fixed real RETURN RATE (from the
// snapshot, however derived — an assumption for an asset, an implied
// outcome for super/pension) and a single NET FLOW figure for the
// snapshot year (held/indexed every later year). Growth uses a
// mid-year-flow convention (a flow deposited/withdrawn partway through
// the year earns roughly half a year's growth) — the same spirit as
// the real engine's own monthly compounding average, at annual
// granularity.
function makeAccountTrack(items, openingOf, returnOf, netFlowOf) {
  const rate = {};
  const netFlowBase = {};
  const balance = {};
  for (const item of items) {
    rate[item.id] = returnOf(item);
    netFlowBase[item.id] = netFlowOf(item);
    balance[item.id] = openingOf(item);
  }
  return {
    balance,
    // `netFlowOverride(id)`, if it returns a finite number, replaces
    // THIS year's held/indexed net flow for that one item — the hook
    // `realism.contributionsStopping` uses to substitute the real
    // year's own flow (see projectStaticFromSnapshot).
    stepYear(idx, netFlowOverride) {
      const detail = {};
      for (const id of Object.keys(balance)) {
        const opening = balance[id];
        const overridden = netFlowOverride?.(id);
        const netFlow = Number.isFinite(overridden) ? overridden : netFlowBase[id] * idx;
        const growth = (opening + netFlow / 2) * rate[id];
        const closing = Math.max(0, opening + netFlow + growth);
        balance[id] = closing;
        detail[id] = { opening, netFlow, growth, closing };
      }
      return detail;
    },
    total() {
      return Object.values(balance).reduce((s, v) => s + v, 0);
    },
  };
}

// projectStatic(state, opts) → yearly[] for a single snapshot year, or
// an array of { snapshotYear, yearly } when `snapshotYears` is itself
// an array — "support multiple snapshot years... each extrapolated
// from its own base" (the spec's own words: the comparison tool uses
// several columns, each its own independent extrapolation, not one
// blended series). `profiles` defaults to the same PROFILES the real
// engine uses.
export function projectStatic(state, opts = {}) {
  const { snapshotYears, indexation = "flat", profiles = PROFILES, realism = {} } = opts;
  if (Array.isArray(snapshotYears)) {
    return snapshotYears.map((sy) => ({
      snapshotYear: sy,
      yearly: projectStaticFromSnapshot(state, sy, indexation, profiles, realism),
    }));
  }
  return projectStaticFromSnapshot(state, snapshotYears, indexation, profiles, realism);
}

// The net non-growth flow for one asset/super-account's row detail —
// the SAME decomposition used to seed each track's snapshot-year base,
// reused again per-year when `realism.contributionsStopping` asks for
// the REAL year's own flow instead of the held/indexed one.
function assetNetFlowOf(d) {
  return d ? (d.contributions ?? 0) - (d.withdrawals ?? 0) + (d.oneOffs ?? 0) - (d.deficitFunding ?? 0) + (d.surplusInvested ?? 0) : 0;
}
function superLikeNetFlowOf(d) {
  if (!d) return 0;
  const growth = d.earnings - d.earningsTax;
  return d.closing - d.opening - growth;
}

function projectStaticFromSnapshot(state, sy, indexation, profiles, realism = {}) {
  const out = projectPlan(state, profiles);
  const cpi = state.assumptions.cpi ?? 0.025;
  const planYears = out.yearly.length;
  if (sy < 0 || sy >= planYears) {
    throw new Error(`projectStatic: snapshotYear ${sy} is outside the projection (0..${planYears - 1})`);
  }
  const snap = out.yearly[sy];

  const assets = (state.assets ?? []).filter((a) => a.include);
  const liabilities = state.liabilities ?? [];
  const superAccounts = (state.plan?.superAccounts ?? []).filter((s) => s.include);
  const pensions = state.plan?.pensions ?? [];

  const assetTrack = makeAccountTrack(
    assets,
    (a) => snap.perAssetDetail?.[a.id]?.closing ?? 0,
    (a) => assetAnnualRealReturn(a, cpi, profiles),
    (a) => assetNetFlowOf(snap.perAssetDetail?.[a.id]),
  );

  // Super/pension: the implied real return backs out whatever the fund
  // actually earned after tax that year (earnings − earningsTax ÷
  // opening) rather than re-deriving the 15%/~10% fund-tax formula a
  // second time here — see this file's own header.
  const superTrack = makeAccountTrack(
    superAccounts,
    (s) => snap.superDetail?.[s.id]?.closing ?? 0,
    (s) => {
      const d = snap.superDetail?.[s.id];
      return d && d.opening > 0 ? (d.earnings - d.earningsTax) / d.opening : 0;
    },
    (s) => superLikeNetFlowOf(snap.superDetail?.[s.id]),
  );
  const pensionTrack = makeAccountTrack(
    pensions,
    (p) => snap.pensionDetail?.[p.id]?.closing ?? 0,
    (p) => {
      const d = snap.pensionDetail?.[p.id];
      return d && d.opening > 0 ? (d.earnings - d.earningsTax) / d.opening : 0;
    },
    (p) => superLikeNetFlowOf(snap.pensionDetail?.[p.id]),
  );

  // Liabilities keep their own bespoke step (a payment can EXHAUST the
  // balance and then stop contributing anything at all — the one
  // account type in this file that closes) rather than fitting
  // makeAccountTrack's "always open" shape.
  const liabRate = {};
  const liabScheduledBase = {};
  const liabExtraBase = {};
  const liabBalance = {};
  for (const l of liabilities) {
    const d = snap.liabilities?.[l.id];
    liabRate[l.id] = d && d.opening > 0 ? d.interest / d.opening : 0;
    liabScheduledBase[l.id] = d ? (d.interest ?? 0) + (d.principal ?? 0) : 0;
    liabExtraBase[l.id] = d ? (d.extraRepayment ?? 0) + (d.surplusRepayment ?? 0) : 0;
    liabBalance[l.id] = d?.closing ?? 0;
  }

  const incomeBase = snap.income ?? 0;
  const expensesBase = snap.expenses ?? 0;
  const taxBase = snap.tax ?? 0;
  const agePensionEntitlementBase = snap.agePensionDetail?.entitlement ?? 0;

  // Loan maturity (`realism.loanMaturity`) — the amount that would
  // have gone to a now-closed liability accumulates here instead of
  // being dropped. Real dollars, no return of its own by default (a
  // conservative "sits in cash" reading — see this file's own header
  // on favouring the static approach where a behaviour is ambiguous).
  let staticCash = 0;

  // The snapshot year itself is reported as-is (the real figure — the
  // two models agree exactly at the snapshot by construction).
  const yearly = [staticRowFrom(sy, snap, assetTrack, superTrack, pensionTrack, liabBalance)];

  for (let y = sy + 1; y < planYears; y++) {
    const yearsElapsed = y - sy;
    const idx = indexFactor(indexation, cpi, yearsElapsed);
    const realRow = out.yearly[y];

    let income = incomeBase * idx;
    if (realism.agePension) {
      const realEntitlement = realRow.agePensionDetail?.entitlement ?? 0;
      income += realEntitlement - agePensionEntitlementBase * idx;
    }
    const expenses = realism.expenseWindows ? realRow.expenses : expensesBase * idx;
    const tax = realism.taxBrackets ? realRow.tax : taxBase * idx;
    const surplusOrDeficit = income - expenses - tax;

    const netFlowFromReal = (realDetailById) => (id) => {
      const d = realDetailById?.[id];
      return d ? assetNetFlowOf(d) : NaN;
    };
    const superNetFlowFromReal = (realDetailById) => (id) => {
      const d = realDetailById?.[id];
      return d ? superLikeNetFlowOf(d) : NaN;
    };

    const perAssetDetail = assetTrack.stepYear(idx, realism.contributionsStopping ? netFlowFromReal(realRow.perAssetDetail) : undefined);
    let superDetail = superTrack.stepYear(idx, realism.contributionsStopping ? superNetFlowFromReal(realRow.superDetail) : undefined);
    let pensionDetail = pensionTrack.stepYear(idx, realism.contributionsStopping ? superNetFlowFromReal(realRow.pensionDetail) : undefined);

    let superClosing = superTrack.total();
    let pensionClosing = pensionTrack.total();
    // Super preservation / pension phase transitions
    // (`realism.superPensionTransitions`) — substitute the real
    // engine's own combined total whole, rather than trying to detect
    // the transition itself (a rollover from accumulation to pension
    // phase isn't a "flow" this file's per-account tracks see at all).
    if (realism.superPensionTransitions) {
      superClosing = realRow.superClosing ?? 0;
      pensionClosing = realRow.pensionClosing ?? 0;
    }

    const liabilitiesRow = {};
    for (const l of liabilities) {
      const opening = liabBalance[l.id];
      let closing = opening;
      let interest = 0, principal = 0, extra = 0;
      if (opening > 1e-6) {
        const rate = realism.fixedRateRollover
          ? (() => {
              const rd = realRow.liabilities?.[l.id];
              return rd && rd.opening > 0 ? rd.interest / rd.opening : liabRate[l.id];
            })()
          : liabRate[l.id];
        interest = opening * rate;
        const scheduled = liabScheduledBase[l.id] * idx;
        extra = liabExtraBase[l.id] * idx;
        const payment = Math.min(scheduled + extra, opening + interest);
        principal = Math.max(0, payment - interest);
        closing = Math.max(0, opening + interest - payment);
      } else if (realism.loanMaturity && liabExtraBase[l.id] > 0) {
        // Already closed: the baseline drops `extra` here — redirect
        // it into static cash instead, isolating JUST this behaviour.
        staticCash += liabExtraBase[l.id] * idx;
      }
      liabBalance[l.id] = closing;
      liabilitiesRow[l.id] = { opening, interest, principal, extra, closing };
    }

    const closingBalance = assetTrack.total();
    const liabilitiesClosing = Object.values(liabBalance).reduce((s, v) => s + v, 0);
    const netAssets = closingBalance + superClosing + pensionClosing + staticCash - liabilitiesClosing;

    yearly.push({
      y,
      fyLabel: out.schedule.fyLabels[y],
      clientAge: out.schedule.clientAges[y],
      partnerAge: out.schedule.partnerAges ? out.schedule.partnerAges[y] : null,
      income, expenses, tax, surplusOrDeficit,
      perAssetDetail, superDetail, pensionDetail, liabilities: liabilitiesRow, staticCash,
      closingBalance, superClosing, pensionClosing, liabilitiesClosing, netAssets,
    });
  }

  return yearly;
}

// The snapshot year's own row, reshaped into this file's own (smaller)
// row vocabulary so callers never need to special-case row 0. Uses
// netAssets components from out.yearly[sy] directly where this file
// tracks the SAME accounts (property/bonds/WCA are excluded from both
// sides here, so netAssets is NOT simply out.yearly[sy].netAssets —
// see this file's own header on the property/bonds/WCA disclosure).
function staticRowFrom(sy, snap, assetTrack, superTrack, pensionTrack, liabBalance) {
  const closingBalance = assetTrack.total();
  const superClosing = superTrack.total();
  const pensionClosing = pensionTrack.total();
  const liabilitiesClosing = Object.values(liabBalance).reduce((s, v) => s + v, 0);
  return {
    y: sy,
    fyLabel: snap.fyLabel, clientAge: snap.clientAge, partnerAge: snap.partnerAge,
    income: snap.income, expenses: snap.expenses, tax: snap.tax, surplusOrDeficit: snap.surplusOrDeficit,
    perAssetDetail: snap.perAssetDetail, superDetail: snap.superDetail, pensionDetail: snap.pensionDetail,
    liabilities: snap.liabilities, staticCash: 0,
    closingBalance, superClosing, pensionClosing, liabilitiesClosing,
    netAssets: closingBalance + superClosing + pensionClosing - liabilitiesClosing,
  };
}
