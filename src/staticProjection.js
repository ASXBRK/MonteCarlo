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
//   3. Every included asset (financial or lifestyle) rolls its balance
//      forward at its OWN profile/allocation's real return
//      (`assetMonthlyRate`, compounded annually) — the one part of a
//      snapshot tool that's usually done right, since it doesn't need
//      re-deriving the whole cashflow picture.
//   4. Every liability's own snapshot-year real P&I payment (interest
//      + principal, already net of any offset — read straight off the
//      real engine's own row) is held/indexed and re-applied every
//      year, at the snapshot year's own IMPLIED real interest rate,
//      until the balance is exhausted.
//   5. Each asset's/liability's snapshot-year net surplus-driven flow
//      (contributions/withdrawals/one-offs/deficit-funding/surplus-
//      invested for an asset; extra + surplus repayment for a
//      liability) is held/indexed and re-applied the SAME way. An
//      ASSET destination never closes, so its flow continues forever.
//      A LIABILITY destination closes the year its balance reaches
//      zero — from the NEXT year on, the amount that would have gone
//      there is simply DROPPED, not redirected elsewhere. That drop is
//      the exact defect being measured, reproduced deliberately.
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
//   - A snapshot year with a deficit (surplusOrDeficit ≤ 0) has no
//     positive surplus to distribute by destination shares; this
//     model then applies scheduled liability payments and asset
//     contributions/withdrawals as recorded (which may themselves be
//     negative — a net asset drawdown), but adds no NEW surplus-driven
//     flow beyond what the snapshot year already shows. Not the
//     primary scenario this analysis is built to measure.

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

// projectStatic(state, opts) → yearly[] for a single snapshot year, or
// an array of { snapshotYear, yearly } when `snapshotYears` is itself
// an array — "support multiple snapshot years... each extrapolated
// from its own base" (the spec's own words: the comparison tool uses
// several columns, each its own independent extrapolation, not one
// blended series). `profiles` defaults to the same PROFILES the real
// engine uses.
export function projectStatic(state, opts = {}) {
  const { snapshotYears, indexation = "flat", profiles = PROFILES } = opts;
  if (Array.isArray(snapshotYears)) {
    return snapshotYears.map((sy) => ({
      snapshotYear: sy,
      yearly: projectStaticFromSnapshot(state, sy, indexation, profiles),
    }));
  }
  return projectStaticFromSnapshot(state, snapshotYears, indexation, profiles);
}

function projectStaticFromSnapshot(state, sy, indexation, profiles) {
  const out = projectPlan(state, profiles);
  const cpi = state.assumptions.cpi ?? 0.025;
  const planYears = out.yearly.length;
  if (sy < 0 || sy >= planYears) {
    throw new Error(`projectStatic: snapshotYear ${sy} is outside the projection (0..${planYears - 1})`);
  }
  const snap = out.yearly[sy];

  const assets = (state.assets ?? []).filter((a) => a.include);
  const liabilities = state.liabilities ?? [];

  // Per-asset: opening real return rate (fixed, from the asset's OWN
  // allocation/profile — never itself "snapshot-derived", since it's
  // an input assumption, not an outcome) and the single net real
  // dollar flow the snapshot year recorded for this asset (held/
  // indexed exactly like income/expenses below).
  const assetReturn = {};
  const assetNetFlowBase = {};
  for (const a of assets) {
    assetReturn[a.id] = assetAnnualRealReturn(a, cpi, profiles);
    const d = snap.perAssetDetail?.[a.id];
    assetNetFlowBase[a.id] = d
      ? (d.contributions ?? 0) - (d.withdrawals ?? 0) + (d.oneOffs ?? 0)
        - (d.deficitFunding ?? 0) + (d.surplusInvested ?? 0)
      : 0;
  }

  // Per-liability: the snapshot year's own IMPLIED real rate (interest
  // ÷ opening — 0 if the loan was already closed or never opened this
  // FY) and its two held/indexed figures: the ordinary scheduled real
  // payment (interest + principal, already net of offset), and the
  // "extra" real payment (extraRepayment + surplusRepayment) that
  // stops the moment the loan closes in THIS model, per this file's
  // whole reason for existing.
  const liabRate = {};
  const liabScheduledBase = {};
  const liabExtraBase = {};
  for (const l of liabilities) {
    const d = snap.liabilities?.[l.id];
    liabRate[l.id] = d && d.opening > 0 ? d.interest / d.opening : 0;
    liabScheduledBase[l.id] = d ? (d.interest ?? 0) + (d.principal ?? 0) : 0;
    liabExtraBase[l.id] = d ? (d.extraRepayment ?? 0) + (d.surplusRepayment ?? 0) : 0;
  }

  const incomeBase = snap.income ?? 0;
  const expensesBase = snap.expenses ?? 0;
  const taxBase = snap.tax ?? 0;

  const assetBalance = Object.fromEntries(assets.map((a) => [a.id, snap.perAssetDetail?.[a.id]?.closing ?? 0]));
  const liabBalance = Object.fromEntries(liabilities.map((l) => [l.id, snap.liabilities?.[l.id]?.closing ?? 0]));

  // The snapshot year itself is reported as-is (the real figure — the
  // two models agree exactly at the snapshot by construction).
  const yearly = [staticRowFrom(sy, snap, assetBalance, liabBalance)];

  for (let y = sy + 1; y < planYears; y++) {
    const yearsElapsed = y - sy;
    const idx = indexFactor(indexation, cpi, yearsElapsed);
    const income = incomeBase * idx;
    const expenses = expensesBase * idx;
    const tax = taxBase * idx;
    const surplusOrDeficit = income - expenses - tax;

    const perAssetDetail = {};
    for (const a of assets) {
      const opening = assetBalance[a.id];
      const netFlow = assetNetFlowBase[a.id] * idx;
      // Mid-year flow convention (same spirit as the real engine's own
      // monthly compounding average) — a flow deposited/withdrawn
      // partway through the year earns roughly half a year's growth.
      const growth = (opening + netFlow / 2) * assetReturn[a.id];
      const closing = Math.max(0, opening + netFlow + growth);
      assetBalance[a.id] = closing;
      perAssetDetail[a.id] = { opening, netFlow, growth, closing };
    }

    const liabilitiesRow = {};
    for (const l of liabilities) {
      const opening = liabBalance[l.id];
      let closing = opening;
      let interest = 0, principal = 0, extra = 0;
      if (opening > 1e-6) {
        interest = opening * liabRate[l.id];
        const scheduled = liabScheduledBase[l.id] * idx;
        extra = liabExtraBase[l.id] * idx;
        const payment = Math.min(scheduled + extra, opening + interest);
        principal = Math.max(0, payment - interest);
        closing = Math.max(0, opening + interest - payment);
      }
      liabBalance[l.id] = closing;
      liabilitiesRow[l.id] = { opening, interest, principal, extra, closing };
    }

    const closingBalance = Object.values(assetBalance).reduce((s, v) => s + v, 0);
    const liabilitiesClosing = Object.values(liabBalance).reduce((s, v) => s + v, 0);
    const netAssets = closingBalance - liabilitiesClosing;

    yearly.push({
      y,
      fyLabel: out.schedule.fyLabels[y],
      clientAge: out.schedule.clientAges[y],
      partnerAge: out.schedule.partnerAges ? out.schedule.partnerAges[y] : null,
      income, expenses, tax, surplusOrDeficit,
      perAssetDetail, liabilities: liabilitiesRow,
      closingBalance, liabilitiesClosing, netAssets,
    });
  }

  return yearly;
}

// The snapshot year's own row, reshaped into this file's own (smaller)
// row vocabulary so callers never need to special-case row 0.
function staticRowFrom(sy, snap, assetBalance, liabBalance) {
  const perAssetDetail = {};
  for (const id of Object.keys(assetBalance)) {
    const d = snap.perAssetDetail?.[id];
    perAssetDetail[id] = { opening: d?.opening ?? 0, netFlow: 0, growth: d?.growth ?? 0, closing: d?.closing ?? assetBalance[id] };
  }
  const liabilitiesRow = {};
  for (const id of Object.keys(liabBalance)) {
    const d = snap.liabilities?.[id];
    liabilitiesRow[id] = {
      opening: d?.opening ?? 0, interest: d?.interest ?? 0, principal: d?.principal ?? 0,
      extra: (d?.extraRepayment ?? 0) + (d?.surplusRepayment ?? 0), closing: d?.closing ?? liabBalance[id],
    };
  }
  return {
    y: sy,
    fyLabel: snap.fyLabel, clientAge: snap.clientAge, partnerAge: snap.partnerAge,
    income: snap.income, expenses: snap.expenses, tax: snap.tax, surplusOrDeficit: snap.surplusOrDeficit,
    perAssetDetail, liabilities: liabilitiesRow,
    closingBalance: Object.values(assetBalance).reduce((s, v) => s + v, 0),
    liabilitiesClosing: Object.values(liabBalance).reduce((s, v) => s + v, 0),
    netAssets: snap.netAssets,
  };
}
