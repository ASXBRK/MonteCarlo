// Cashflow schedule builder — pure, no DOM/Plotly/engine knowledge.
//
// Converts a schemaVersion-3 plan state into per-month cashflow arrays
// for the whole projection, implementing the locked time conventions:
//
//  1. Plan years are Australian FYs (1 July – 30 June), "FY2026–27".
//     Monthly steps throughout.
//  2. The projection starts at plan.start {year, month}; the first plan
//     year is partial (start month → following 30 June). The final plan
//     year is the FY in which the client is endAge.
//  3. Ages tick over each 1 July. Income rows anchor to the OWNER's
//     age; everything else anchors to the client's.
//  4. Monthly cashflows apply every month within [fromAge, toAge],
//     inclusive of both boundary plan years.
//  5. Annual cashflows and one-offs fire in July. In the partial first
//     year, if the start month is after July (or the partial year
//     contains no July at all), that FY's annual flows and one-offs
//     are skipped (assumed already made earlier in the FY).
//  6. Indexed cashflows are constant in real terms; non-indexed are
//     fixed-nominal and decay: real at month m = amount/(1+cpi)^(m/12).
//
// All amounts in the output are REAL dollars. Nominal is a display
// scaling applied by the renderer via nominalFactor().
//
// Key Dates (Tier 1.1): every row's from/to/at is a DateRef, resolved
// to a plan-year bound HERE, once, before any month is walked — never
// inside the per-month loop. Engine semantics are unchanged: an anchor
// resolves to exactly the plan year an equivalent integer age did.

import { resolveRef } from "./keyDates.js";
import { superRatesFor, superReleaseAge } from "./data/superRates.js";
import { childEducationPlanYearBounds, legacySurplusPeriod } from "./planState.js";

// Age 75 limit (member/spouse contributions — SG is exempt) and the
// personal-deductible work test (ages 67–74, gated by the person's own
// workTestMet toggle; the work-test EXEMPTION is not modelled).
// Exported so deterministic.js can apply the same rule to a dynamic
// "toConcessionalCap" fill, which it resolves itself (see schedule.js's
// header comment on toConcessionalCapRows).
export function superContributionAllowed(type, age, workTestMet, rates) {
  if (type === "sg" || age == null) return { ok: true };
  if (age > rates.contributionAgeLimit) {
    return { ok: false, reason: `Age ${age} exceeds the age ${rates.contributionAgeLimit} contribution limit` };
  }
  if (type === "personalDeductible") {
    const [lo, hi] = rates.workTestAges;
    if (age >= lo && age <= hi && !workTestMet) {
      return { ok: false, reason: `Work test not met at age ${age} (ages ${lo}–${hi})` };
    }
  }
  return { ok: true };
}

// --- time helpers -------------------------------------------------------

// Months in the partial first plan year (12 when starting in July).
export function monthsInFirstYear(start) {
  return 12 - ((start.month - 7 + 12) % 12);
}

// Calendar year in which the first plan year's FY began (its 1 July).
export function firstFyStartYear(start) {
  return start.month >= 7 ? start.year : start.year - 1;
}

// Number of plan years: the client is endAge in the final one.
export function planYearCount(plan) {
  return plan.endAge - plan.client.currentAge + 1;
}

export function totalMonths(plan) {
  return monthsInFirstYear(plan.start) + 12 * (planYearCount(plan) - 1);
}

// Plan year (0-based) containing month index m (m = 0 is the start month).
export function planYearOfMonth(plan, m) {
  const first = monthsInFirstYear(plan.start);
  return m < first ? 0 : 1 + Math.floor((m - first) / 12);
}

// Calendar month (1–12) of month index m.
export function calendarMonthOf(plan, m) {
  return ((plan.start.month - 1 + m) % 12) + 1;
}

// "FY2026–27" label for a 0-based plan year.
export function fyLabel(plan, planYear) {
  const fy = firstFyStartYear(plan.start) + planYear;
  return `FY${fy}–${String((fy + 1) % 100).padStart(2, "0")}`;
}

export function clientAgeAt(plan, planYear) {
  return plan.client.currentAge + planYear;
}

export function partnerAgeAt(plan, planYear) {
  return plan.partner ? plan.partner.currentAge + planYear : null;
}

export function ownerAgeAt(plan, owner, planYear) {
  if (owner === "partner" && plan.partner) return partnerAgeAt(plan, planYear);
  return clientAgeAt(plan, planYear);
}

// Display-time nominal scaling for a value observed at month index m.
export function nominalFactor(m, cpi) {
  return Math.pow(1 + cpi, m / 12);
}

// Per-row indexation (D1): nominal growth g = basis rate + additional
// %, so the real amount at month m is amount × ((1+g)/(1+cpi))^(m/12).
// CPI+0 → constant real; None+0 → decays at CPI (fixed nominal);
// AWOTE-linked rows grow in real terms. Rows carrying only the pre-D1
// `indexed` flag fall back to its CPI/None equivalents.
export function realAmountAt(row, m, cpi, awote) {
  let basis = row.indexBasis;
  if (basis == null) basis = row.indexed === false ? "none" : "cpi";
  const basisRate = basis === "awote" ? awote : basis === "cpi" ? cpi : 0;
  const g = basisRate + (row.indexExtraPct ?? 0) / 100;
  if (g === cpi) return row.amount; // exact constant-real fast path
  return row.amount * Math.pow((1 + g) / (1 + cpi), m / 12);
}

// Whether plan year y contains a July month that fires annual flows.
// Full years (y > 0) always start in July. Year 0 fires only when the
// projection itself starts in July (convention 5).
function julyMonthIndex(plan, y) {
  if (y === 0) return plan.start.month === 7 ? 0 : null;
  return monthsInFirstYear(plan.start) + 12 * (y - 1);
}

// A bonus's own nominated month (spec 23, Commit 2) — same convention 5
// null-return as julyMonthIndex (a partial first year without a firing
// July skips the bonus entirely too, not just ordinary annual rows;
// every full plan year is 12 months starting in July, so July + any
// 0–11 offset always lands inside the SAME plan year, never overflows
// into the next one). bonusMonth is a calendar month (1–12); July (7)
// is offset 0, June (6) — the FY's last month, the spec's own default
// — is offset 11.
function bonusMonthIndex(plan, y, bonusMonth) {
  const jm = julyMonthIndex(plan, y);
  if (jm == null) return null;
  const offset = ((bonusMonth - 7) % 12 + 12) % 12;
  return jm + offset;
}

// --- schedule builder ------------------------------------------------------

// buildSchedules(state) → {
//   months, planYears, monthsInFirstYear,
//   fyLabels[y], clientAges[y], partnerAges[y]|null,
//   yearOfMonth[m],
//   income[m], expenses[m],                        // household, real $
//   assetFlows: { [assetId]: {
//     contributions[m], withdrawals[m], oneOffs[m] // real $; oneOffs signed (+in / −out)
//   } },  // included assets only
// }
export function buildSchedules(state) {
  const plan = state.plan;
  const cpi = state.assumptions.cpi;
  const awote = state.assumptions.awote ?? 0.035;
  const bracketMode = state.assumptions.bracketMode === "frozen" ? "frozen" : "indexed";
  const fy0 = firstFyStartYear(plan.start);
  const months = totalMonths(plan);
  const planYears = planYearCount(plan);
  const firstYearMonths = monthsInFirstYear(plan.start);

  const fyLabels = [];
  const clientAges = [];
  const partnerAges = plan.partner ? [] : null;
  for (let y = 0; y < planYears; y++) {
    fyLabels.push(fyLabel(plan, y));
    clientAges.push(clientAgeAt(plan, y));
    if (partnerAges) partnerAges.push(partnerAgeAt(plan, y));
  }

  const yearOfMonth = new Array(months);
  for (let m = 0; m < months; m++) yearOfMonth[m] = planYearOfMonth(plan, m);

  const income = new Float64Array(months);
  const expenses = new Float64Array(months);
  // Per-owner income split — the tax layer attributes income rows to
  // the person who owns them. income = incomeByOwner.client + .partner.
  const incomeByOwner = {
    client: new Float64Array(months),
    partner: plan.partner ? new Float64Array(months) : null,
  };
  // Employment income only, net of salary sacrifice (PAYG withholding,
  // Commit "PAYG withholding, tax refund timing, and deductions") — a
  // subset of incomeByOwner, tracked separately because PAYG withheld
  // is computed on employment income ALONE, ignoring every other
  // income type, deduction, and offset except the tax-free threshold
  // and LITO. Reduced by salary sacrifice for the same reason
  // incomeByOwner is: an employer withholds PAYG on what it actually
  // pays the employee, not the pre-sacrifice salary.
  const employmentIncomeByOwner = {
    client: new Float64Array(months),
    partner: plan.partner ? new Float64Array(months) : null,
  };
  // Deductions (PAYG withholding, tax refund timing, and deductions) —
  // per-owner, like incomeByOwner, since each reduces ONE person's
  // assessable income. Never a household cash outflow (disclosed —
  // there's no linked income row to reduce at source the way salary
  // sacrifice is, so entering a deduction here doesn't itself move
  // cash; enter a matching Expense row too if the underlying spend
  // also needs to leave household cash).
  const deductionsByOwner = {
    client: new Float64Array(months),
    partner: plan.partner ? new Float64Array(months) : null,
  };

  // Cashflows may only target included FINANCIAL assets (D2) —
  // lifestyle assets carry no flow arrays at all.
  const includedIds = new Set(
    state.assets.filter((a) => a.include && a.class !== "lifestyle").map((a) => a.id)
  );
  const assetFlows = {};
  for (const id of includedIds) {
    assetFlows[id] = {
      contributions: new Float64Array(months),
      withdrawals: new Float64Array(months),
      oneOffs: new Float64Array(months),
    };
  }

  // Per-row FY totals for the transposed output views (one line per
  // entered row) — filled alongside the monthly arrays.
  const rowTotals = { income: {}, expenses: {}, deductions: {} };
  // Net one-off amounts per asset per FY (signed) for the one-off grid.
  const oneOffsByAssetYear = {};
  for (const id of includedIds) oneOffsByAssetYear[id] = new Float64Array(planYears);

  // Key Dates: a partial schedule — just enough for resolveRef
  // (planYears/fyLabels/clientAges) — built from the arrays above, so
  // every row's from/to/at resolves against the SAME plan-year numbering
  // the rest of this function uses. Resolved once per row below, never
  // per month.
  const dateSchedule = { planYears, fyLabels, clientAges };

  // A regular cashflow row is active in plan year y iff y lies within
  // its resolved [from, to] plan-year bounds (inclusive of both
  // boundary plan years — convention 4).
  const activeInPlanYear = (bounds, y) => y >= bounds.from && y <= bounds.to;

  // Accumulate a regular row into a target Float64Array (and its
  // per-FY totals when a `totals` array is supplied).
  const applyRegular = (row, owner, target, totals = null) => {
    if (row.amount <= 0) return;
    const bounds = {
      from: resolveRef(row.from, plan, dateSchedule, owner).planYear,
      to: resolveRef(row.to, plan, dateSchedule, owner).planYear,
    };
    if (row.frequency === "monthly") {
      for (let m = 0; m < months; m++) {
        if (activeInPlanYear(bounds, yearOfMonth[m])) {
          const v = realAmountAt(row, m, cpi, awote);
          target[m] += v;
          if (totals) totals[yearOfMonth[m]] += v;
        }
      }
    } else { // annual — fires in July (convention 5)
      for (let y = 0; y < planYears; y++) {
        if (!activeInPlanYear(bounds, y)) continue;
        const jm = julyMonthIndex(plan, y);
        if (jm == null) continue; // partial first year without a firing July
        const v = realAmountAt(row, jm, cpi, awote);
        target[jm] += v;
        if (totals) totals[y] += v;
      }
    }
  };

  // Bonus (spec 23, Commit 2): fires ONCE a year, in its own nominated
  // month, never spread across every month of the row's window the way
  // a "monthly" row would be — clampIncomeRow already forces
  // frequency:"annual" for a bonus row, but this row-shaped helper
  // (bonusMonthIndex instead of julyMonthIndex) is what actually
  // relocates the firing month; kept separate from applyRegular's own
  // annual branch rather than parameterising it, since nothing else
  // ever fires anywhere but July.
  const applyBonus = (row, owner, target, totals = null) => {
    if (row.amount <= 0) return;
    const bounds = {
      from: resolveRef(row.from, plan, dateSchedule, owner).planYear,
      to: resolveRef(row.to, plan, dateSchedule, owner).planYear,
    };
    for (let y = 0; y < planYears; y++) {
      if (!activeInPlanYear(bounds, y)) continue;
      const bm = bonusMonthIndex(plan, y, row.bonusMonth ?? 6);
      if (bm == null) continue; // partial first year without a firing July — convention 5
      const v = realAmountAt(row, bm, cpi, awote);
      target[bm] += v;
      if (totals) totals[y] += v;
    }
  };

  for (const row of state.cashflows.income) {
    rowTotals.income[row.id] = new Float64Array(planYears);
    const apply = row.category === "bonus" ? applyBonus : applyRegular;
    apply(row, row.owner, income, rowTotals.income[row.id]);
    // Non-taxable income (Tier 1.2) is real household cashflow (still
    // counted in `income`/`rowTotals`) but bypasses tax assessment
    // entirely — incomeByOwner feeds ONLY the tax layer, so it's the
    // one place this row is excluded.
    if (row.incomeType !== "nonTaxable") {
      const ownerArr = row.owner === "partner" && incomeByOwner.partner
        ? incomeByOwner.partner
        : incomeByOwner.client;
      apply(row, row.owner, ownerArr);
    }
    if (row.incomeType === "employment") {
      const empArr = row.owner === "partner" && employmentIncomeByOwner.partner
        ? employmentIncomeByOwner.partner
        : employmentIncomeByOwner.client;
      apply(row, row.owner, empArr);
    }
  }
  for (const row of state.cashflows.expenses) {
    rowTotals.expenses[row.id] = new Float64Array(planYears);
    applyRegular(row, "client", expenses, rowTotals.expenses[row.id]);
  }

  // Education funding (Input Usability spec, Commit 3) — household
  // expenses, same as the loop above, just anchored to each child's OWN
  // age rather than the client's (see childEducationPlanYearBounds's
  // header for why that's a self-contained shift rather than a
  // resolveRef owner). Annual only (school fees are paid yearly), fires
  // in July like every other annual row (convention 5); a not-yet-born
  // child's window simply lands later, with no special-case clamp.
  rowTotals.education = {};
  for (const child of state.plan.children ?? []) {
    for (const block of child.education ?? []) {
      rowTotals.education[block.id] = new Float64Array(planYears);
      if (block.annualAmount <= 0) continue;
      const bounds = childEducationPlanYearBounds(child, plan, block.fromAge, block.toAge);
      // realAmountAt reads .amount, not .annualAmount — the field is
      // named annualAmount on the block itself (spec's own model) since
      // "amount" alone reads ambiguously for something that only ever
      // fires once a year; this reshapes it at the one call site that needs it.
      const asRow = { amount: block.annualAmount, indexBasis: block.indexBasis, indexExtraPct: block.indexExtraPct };
      for (let y = 0; y < planYears; y++) {
        if (!activeInPlanYear(bounds, y)) continue;
        const jm = julyMonthIndex(plan, y);
        if (jm == null) continue;
        const v = realAmountAt(asRow, jm, cpi, awote);
        expenses[jm] += v;
        rowTotals.education[block.id][y] += v;
      }
    }
  }
  for (const row of state.cashflows.deductions ?? []) {
    rowTotals.deductions[row.id] = new Float64Array(planYears);
    const ownerArr = row.owner === "partner" && deductionsByOwner.partner
      ? deductionsByOwner.partner
      : deductionsByOwner.client;
    applyRegular(row, row.owner, ownerArr, rowTotals.deductions[row.id]);
  }

  for (const row of state.cashflows.contributions) {
    const flows = assetFlows[row.assetId];
    if (flows) applyRegular(row, "client", flows.contributions);
  }
  for (const row of state.cashflows.withdrawals) {
    const flows = assetFlows[row.assetId];
    if (flows) applyRegular(row, "client", flows.withdrawals);
  }

  // One-offs fire in the July of the plan year resolved from ls.at,
  // subject to convention 5's partial-first-year skip. They carry no
  // indexed flag — amounts are real as entered.
  for (const ls of state.cashflows.lumpSums) {
    const flows = assetFlows[ls.assetId];
    if (!flows || ls.amount <= 0) continue;
    const y = resolveRef(ls.at, plan, dateSchedule, "client").planYear;
    const jm = julyMonthIndex(plan, y);
    if (jm == null) continue;
    const signed = ls.direction === "out" ? -ls.amount : ls.amount;
    flows.oneOffs[jm] += signed;
    oneOffsByAssetYear[ls.assetId][y] += signed;
  }

  // --- superannuation (Tier 1.2, accumulation phase) ------------------------
  //
  // superFlows parallels assetFlows, but tracks GROSS requested amounts
  // per super account, split by tax treatment: sg/salarySacrifice/
  // personalDeductible (concessional — always 15% fund tax, cap+
  // carry-forward only affects whether the EXCESS is also assessed to
  // the member) and nonConcessional (personalNonDeductible + spouse —
  // untaxed on entry, but capped/bring-forward-gated with the excess
  // REJECTED rather than credited). Caps, contributions tax, Division
  // 293, and age/work-test gating are all inherently YEAR-SEQUENTIAL
  // (carry-forward and bring-forward evolve FY over FY) and so are
  // computed in deterministic.js's year loop, not here — this module
  // only resolves WHEN and WHERE each gross dollar lands.
  const superAccounts = (plan.superAccounts ?? []).filter((s) => s.include);
  const superFlows = {};
  for (const s of superAccounts) {
    superFlows[s.id] = {
      sg: new Float64Array(months),
      salarySacrifice: new Float64Array(months),
      personalDeductible: new Float64Array(months),
      nonConcessional: new Float64Array(months),
      withdrawals: new Float64Array(months), // gross REQUESTED amount; release-gated below (Commit 3)
    };
  }
  // Spouse contributions, co-contribution and LISTO (spec 19 Commit 6)
  // — both government payments AND the spouse offset need to tell a
  // "spouse" contribution (into the RECEIVING owner's account, on their
  // behalf) apart from that SAME owner's own "personalNonDeductible"
  // NCC, even though both already merge into the SAME nonConcessional
  // flow key above for cap-acceptance purposes (unaffected, deliberately
  // not touched) — additive per-FY-per-owner totals, gated the SAME
  // age/work-test way as the real credit (accumulated inside the SAME
  // loop below, right where the gated `temp` array is already known).
  const spouseContributionsByOwner = { client: new Float64Array(planYears), partner: new Float64Array(planYears) };
  const personalNccByOwner = { client: new Float64Array(planYears), partner: new Float64Array(planYears) };
  // Insurance premiums inside super (spec 19 Commit 7) — resolved once
  // per account here, same "annual row fires in July" convention every
  // other $ figure in this file follows, rather than deferred to
  // deterministic.js. A zero-amount premium (the default) never even
  // enters the map, so an untouched account costs nothing extra to
  // check downstream.
  const superInsurancePremiums = {};
  for (const s of superAccounts) {
    const premium = s.insurancePremium;
    if (!premium || !(premium.amount > 0)) continue;
    const amountAtYear = new Float64Array(planYears);
    for (let y = 0; y < planYears; y++) {
      const jm = julyMonthIndex(plan, y);
      if (jm == null) continue;
      amountAtYear[y] = realAmountAt(premium, jm, cpi, awote);
    }
    superInsurancePremiums[s.id] = amountAtYear;
  }
  // FHSSS-eligible contributions (Document Set Commit 3), keyed by the
  // CONTRIBUTING person (not account — FHSSS eligibility is a
  // per-person entitlement) and split concessional/non-concessional,
  // the same split fhsss.js's release calculation needs. Only rows
  // flagged fhsssEligible AND of an eligible type feed this — SG can
  // never be eligible (voluntary contributions only) and spouse
  // contributions are excluded too (not the contributing person's own
  // voluntary contribution, per the ATO's FHSSS rules) even though
  // both share the "nonConcessional" flow key above.
  const fhsssFlows = {
    client: { concessional: new Float64Array(months), nonConcessional: new Float64Array(months) },
    partner: { concessional: new Float64Array(months), nonConcessional: new Float64Array(months) },
  }
  const yearStartM = (y) => (y === 0 ? 0 : firstYearMonths + 12 * (y - 1));
  const yearEndM = (y) => firstYearMonths + 12 * y;
  const FLOW_KEY_BY_TYPE = {
    sg: "sg",
    salarySacrifice: "salarySacrifice",
    personalDeductible: "personalDeductible",
    personalNonDeductible: "nonConcessional",
    spouse: "nonConcessional",
  };

  // Both age and the work-test toggle are static per plan-year (ages
  // tick once at 1 July; the toggle doesn't vary within a projection),
  // so — unlike caps, which are year-sequential and live in
  // deterministic.js — this can be resolved here, once, before any
  // month is walked. Rejections are flagged (superWarnings), never
  // silently dropped.
  const superWarnings = [];
  const memberAgeAt = (owner, y) => (owner === "partner" ? partnerAges?.[y] : clientAges[y]);
  const workTestMetFor = (owner) =>
    (owner === "partner" ? plan.partner?.super?.workTestMet : plan.client?.super?.workTestMet) !== false;

  // Returns true (credit allowed) or false (rejected, warning pushed).
  function gate(type, owner, y) {
    const rates = superRatesFor(fy0 + y, bracketMode, cpi);
    const result = superContributionAllowed(type, memberAgeAt(owner, y), workTestMetFor(owner), rates);
    if (result.ok) return true;
    superWarnings.push({ fyLabel: fyLabels[y], owner, type, reason: result.reason });
    return false;
  }

  // Salary sacrifice reduces the CONTRIBUTING person's assessable
  // salary at source (Commit 2) AND the household cash they actually
  // receive (engine-correctness fix) — every dollar credited here is
  // subtracted from BOTH incomeByOwner (tax) and `income` (household
  // cash, what the Working Cash Account sees), the same month, each
  // floored at zero independently. The client never had this cash —
  // their employer diverted it straight to super — so leaving it in
  // `income` while also crediting the super account would create it
  // from nothing (the original defect: super gained the contribution,
  // tax fell by the saving, but household cash was never debited).
  const reduceTaxableIncome = (owner, m, amount) => {
    const arr = owner === "partner" && incomeByOwner.partner ? incomeByOwner.partner : incomeByOwner.client;
    arr[m] = Math.max(0, arr[m] - amount);
    // Mirrored into employmentIncomeByOwner too: salary sacrifice is by
    // definition a reduction of employment income at source, so the
    // PAYG-withholding base (Commit "PAYG withholding...") must see the
    // same reduced amount, not the pre-sacrifice salary.
    const empArr = owner === "partner" && employmentIncomeByOwner.partner
      ? employmentIncomeByOwner.partner : employmentIncomeByOwner.client;
    empArr[m] = Math.max(0, empArr[m] - amount);
  };
  const reduceHouseholdCash = (m, amount) => {
    income[m] = Math.max(0, income[m] - amount);
  };

  // SG: per EMPLOYER (spec 23, Commit 1), not per row and not pooled
  // across a person's whole income — the maximum contribution base is
  // a per-employer cap, so two rows sharing one employerId (e.g. base
  // salary + a recurring allowance from the SAME job) share one cap,
  // while two DIFFERENT employers each get their own, full cap — a
  // second job at $200,000 generates SG on both up to the cap on each,
  // materially more than SG on the combined $400,000 capped once.
  // Grouped by owner+employerId; a row with no employerId at all
  // (pre-Commit-1 raw state, or a test fixture that never set one up)
  // falls back to its OWN row id as the group key — a singleton group,
  // i.e. exactly the old per-row behaviour, so nothing changes for a
  // scenario that never adopted the employer model. Capped ONCE per
  // group per FY, then the capped total is distributed back across the
  // group's own rows in proportion to each row's own uncapped share,
  // preserving each row's own monthly-vs-annual crediting timing.
  // "&& row.category !== "overtime"" is belt-and-braces, not the
  // primary gate — clampIncomeRow already forces sgApplies:false for
  // overtime — but a raw/unclamped state (a test fixture, an
  // in-progress edit) must never be able to generate SG on overtime by
  // just setting sgApplies:true directly; overtime is assessable but
  // not ordinary time earnings, so no SG ever applies to it, full stop.
  const employmentRows = state.cashflows.income.filter(
    (row) => row.incomeType === "employment" && row.sgApplies !== false && row.category !== "overtime"
  );
  const sgGroups = new Map();
  for (const row of employmentRows) {
    const key = `${row.owner}::${row.employerId ?? row.id}`;
    if (!sgGroups.has(key)) sgGroups.set(key, []);
    sgGroups.get(key).push(row);
  }
  for (const rows of sgGroups.values()) {
    const owner = rows[0].owner;
    const account = superAccounts.find((s) => s.owner === owner);
    if (!account) continue; // no account for that owner → nothing to credit (disclosed — SG still legally accrues)
    const flows = superFlows[account.id];
    const rowBounds = rows.map((row) => ({
      from: resolveRef(row.from, plan, dateSchedule, row.owner).planYear,
      to: resolveRef(row.to, plan, dateSchedule, row.owner).planYear,
    }));
    for (let y = 0; y < planYears; y++) {
      let totalSalaryFy = 0;
      const perRowSalary = rows.map((row, i) => {
        if (y < rowBounds[i].from || y > rowBounds[i].to) return 0;
        const v = rowTotals.income[row.id][y] ?? 0;
        totalSalaryFy += v;
        return v;
      });
      if (!(totalSalaryFy > 0)) continue;
      const rates = superRatesFor(fy0 + y, bracketMode, cpi, awote);
      // Modelled annually (the real cap applies per quarter — this
      // engine has no quarterly granularity anywhere else either;
      // disclosed, same as every other annual-equivalent simplification).
      const cappedTotalFy = Math.min(totalSalaryFy, rates.sgMaximumSalary) * rates.sgRate;
      if (cappedTotalFy <= 0) continue;
      rows.forEach((row, i) => {
        const share = perRowSalary[i] / totalSalaryFy;
        const sgFy = cappedTotalFy * share;
        if (sgFy <= 0) return;
        if (row.frequency === "monthly") {
          const s = yearStartM(y), e = yearEndM(y);
          if (e > s) {
            const per = sgFy / (e - s);
            for (let m = s; m < e; m++) flows.sg[m] += per;
          }
        } else {
          // A bonus fires in its OWN nominated month, not always July
          // (see applyBonus/bonusMonthIndex above) — SG on it follows
          // the same month, not the row's frequency-implied default.
          const jm = row.category === "bonus" ? bonusMonthIndex(plan, y, row.bonusMonth ?? 6) : julyMonthIndex(plan, y);
          if (jm != null) flows.sg[jm] += sgFy;
        }
      });
    }
  }

  // User-entered contributions. "toConcessionalCap" is excluded here —
  // its fill amount depends on the carry-forward ledger's evolving
  // state, so deterministic.js resolves it directly (see
  // `toConcessionalCapRows` below).
  //
  // A toConcessionalCap fill's household-cash and tax effects are NOT
  // derived from these flow arrays — a fill is never written back into
  // them, since its amount depends on the live carry-forward ledger
  // (see toConcessionalCapRows below). deterministic.js resolves and
  // applies both effects itself, once per FY, at the point the fill
  // amount becomes known (a-super-fill, applied UNGATED so it feeds the
  // tax measurement pass too, same as every other deduction here).
  const incomeRowsById = Object.fromEntries(state.cashflows.income.map((r) => [r.id, r]));
  const toConcessionalCapRows = [];
  for (const sc of state.cashflows.superContributions ?? []) {
    const flows = superFlows[sc.accountId];
    if (!flows) continue;
    if (sc.basis === "toConcessionalCap") {
      toConcessionalCapRows.push({
        accountId: sc.accountId,
        owner: sc.owner,
        type: FLOW_KEY_BY_TYPE[sc.type] === "nonConcessional" ? "salarySacrifice" : sc.type, // toConcessionalCap only ever makes sense as a concessional fill
        fromYear: resolveRef(sc.from, plan, dateSchedule, "client").planYear,
        toYear: resolveRef(sc.to, plan, dateSchedule, "client").planYear,
      });
      continue;
    }
    const key = FLOW_KEY_BY_TYPE[sc.type] ?? "nonConcessional";
    // Credit into a scratch buffer first — age/work-test gating (below)
    // zeroes out whole rejected FYs before merging into the real flow,
    // so a rejected row never partially lands.
    const temp = new Float64Array(months);

    if (sc.basis === "amount") {
      applyRegular(sc, "client", temp);
    } else if (sc.basis === "percentOfIncome") {
      const incomeRow = incomeRowsById[sc.incomeRowId];
      if (!incomeRow || !(sc.percent > 0)) continue;
      const bounds = {
        from: resolveRef(sc.from, plan, dateSchedule, "client").planYear,
        to: resolveRef(sc.to, plan, dateSchedule, "client").planYear,
      };
      const incBounds = {
        from: resolveRef(incomeRow.from, plan, dateSchedule, incomeRow.owner).planYear,
        to: resolveRef(incomeRow.to, plan, dateSchedule, incomeRow.owner).planYear,
      };
      for (let m = 0; m < months; m++) {
        const y = yearOfMonth[m];
        if (y < bounds.from || y > bounds.to) continue;
        if (y < incBounds.from || y > incBounds.to) continue;
        let incomeAtM = 0;
        if (incomeRow.frequency === "monthly") incomeAtM = realAmountAt(incomeRow, m, cpi, awote);
        else if (julyMonthIndex(plan, y) === m) incomeAtM = realAmountAt(incomeRow, m, cpi, awote);
        if (incomeAtM <= 0) continue;
        temp[m] += incomeAtM * (sc.percent / 100);
      }
    }

    // Age 75 / work-test gate, resolved once per FY this row is active
    // in (never per month) — a rejected FY is zeroed out in full.
    for (let y = 0; y < planYears; y++) {
      const s = yearStartM(y), e = yearEndM(y);
      let anyThisYear = false;
      for (let m = s; m < e; m++) if (temp[m] > 0) { anyThisYear = true; break; }
      if (!anyThisYear) continue;
      if (!gate(sc.type, sc.owner, y)) {
        for (let m = s; m < e; m++) temp[m] = 0;
      }
    }

    // Salary sacrifice: reduce the contributing owner's taxable income
    // AND the household's actual cash by exactly what survives gating,
    // month by month — see reduceHouseholdCash's header comment.
    if (key === "salarySacrifice") {
      for (let m = 0; m < months; m++) {
        if (temp[m] > 0) {
          reduceTaxableIncome(sc.owner, m, temp[m]);
          reduceHouseholdCash(m, temp[m]);
        }
      }
    }
    // FHSSS-eligible tracking (Document Set Commit 3): reads the SAME
    // gated `temp` array used for the real credit above, so a rejected
    // FY (age/work-test) is excluded from FHSSS eligibility exactly
    // like it's excluded from the real contribution. sg/spouse types
    // are never eligible regardless of the row's own flag (input
    // integrity — planState.js's clampSuperContribution forces the
    // flag false for those, so this check is a defensive belt-and-
    // braces, not the primary gate).
    // Disclosed simplification: this reads the row's REQUESTED amount
    // (post age/work-test gating, pre non-concessional-cap acceptance
    // — that ratio is resolved later, in deterministic.js's year loop,
    // using live carry-forward/bring-forward state this module doesn't
    // have). A personalNonDeductible row that also exceeds the
    // ORDINARY non-concessional cap would (rarely) overstate the
    // FHSSS-eligible balance by its rejected excess. Not a money-
    // creation bug either way — the eventual release still cannot
    // exceed the real super account balance (withdrawFromSuper caps at
    // it) — just a disclosed edge-case imprecision in FHSSS eligibility
    // tracking specifically. Concessional rows have no equivalent gap:
    // the FULL gross concessional amount always lands in the fund
    // regardless of excess-cap status (see deterministic.js's
    // `superBal[id] += (ccGross - ccTax) + nccAccepted`).
    if (sc.fhsssEligible && sc.type !== "sg" && sc.type !== "spouse") {
      const bucket = sc.type === "personalNonDeductible" ? "nonConcessional" : "concessional";
      const owner = sc.owner === "partner" ? "partner" : "client";
      for (let m = 0; m < months; m++) fhsssFlows[owner][bucket][m] += temp[m];
    }
    for (let m = 0; m < months; m++) flows[key][m] += temp[m];
    // Spouse contributions, co-contribution and LISTO (spec 19 Commit
    // 6) — per-FY-per-owner totals, additive alongside the merged
    // nonConcessional credit above (see this block's own header).
    if (sc.type === "spouse" || sc.type === "personalNonDeductible") {
      const bucket = sc.type === "spouse" ? spouseContributionsByOwner : personalNccByOwner;
      const owner = sc.owner === "partner" ? "partner" : "client";
      for (let m = 0; m < months; m++) if (temp[m] > 0) bucket[owner][yearOfMonth[m]] += temp[m];
    }
  }

  // Super withdrawals (Tier 1.2, Commit 3): only ever paid once the
  // account owner's condition of release is met (reaching the
  // unrestricted-access age, or retiring at/after preservation age —
  // approximated by the person's own Tier 1.1 retirementAge). Release
  // age is static for the whole projection (retirementAge doesn't
  // change), so — like age/work-test gating above — this is resolved
  // here rather than in deterministic.js. A withdrawal requested before
  // release is rejected in full for that FY (flagged), not partially
  // paid or deferred.
  for (const sw of state.cashflows.superWithdrawals ?? []) {
    const flows = superFlows[sw.accountId];
    if (!flows) continue;
    const temp = new Float64Array(months);
    applyRegular(sw, "client", temp);

    const person = sw.owner === "partner" ? plan.partner : plan.client;
    const releaseAge = superReleaseAge(person?.retirementAge ?? 65); // 65 is only a defensive fallback — clampPerson always stamps a real retirementAge
    for (let y = 0; y < planYears; y++) {
      const s = yearStartM(y), e = yearEndM(y);
      let anyThisYear = false;
      for (let m = s; m < e; m++) if (temp[m] > 0) { anyThisYear = true; break; }
      if (!anyThisYear) continue;
      const age = sw.owner === "partner" ? partnerAges?.[y] : clientAges[y];
      if (age == null || age < releaseAge) {
        superWarnings.push({
          fyLabel: fyLabels[y], owner: sw.owner, type: "withdrawal",
          reason: `Blocked — no condition of release met until age ${releaseAge}`,
        });
        for (let m = s; m < e; m++) temp[m] = 0;
      }
    }
    for (let m = 0; m < months; m++) flows.withdrawals[m] += temp[m];
  }

  // Extra and one-off loan repayments (Document Set Commit 5) — one
  // combined REQUESTED-amount array per liability, client-anchored
  // like every other non-income row here. deterministic.js applies
  // this against the liability's live balance (capped there, since
  // this module has no balance state) and folds it into household
  // cash the same way the loan's contractual payment already is —
  // "if cash is short, deficit-funded then unfunded" is the EXISTING
  // WCA/funding-order mechanism, not something this module decides.
  const liabilityExtraFlows = {};
  for (const l of state.liabilities ?? []) {
    const target = new Float64Array(months);
    for (const er of l.extraRepayments ?? []) applyRegular(er, "client", target);
    for (const oo of l.oneOffRepayments ?? []) {
      if (!(oo.amount > 0)) continue;
      const y = resolveRef(oo.at, plan, dateSchedule, "client").planYear;
      const jm = julyMonthIndex(plan, y);
      if (jm == null) continue; // partial first year without a firing July — convention 5
      target[jm] += oo.amount;
    }
    liabilityExtraFlows[l.id] = target;
  }

  // Surplus allocation periods (Surplus and Deficit Allocation spec,
  // Commit 1) — bounds only, same split as toConcessionalCapRows above:
  // this module resolves WHEN a period applies (its from/to DateRefs
  // are static, so a plan-year bound is all this needs); deterministic.js
  // resolves WHAT it does, since applying it needs live per-FY state
  // (loan balances, super cap headroom) this module doesn't have.
  // Tolerates the pre-Commit-1 {mode, assetId} shape too (same
  // dual-shape tolerance as liabilities.js's deductibleFraction) — a
  // lot of this codebase's own test fixtures build raw state directly,
  // bypassing clampAllToPlan's migration entirely.
  const rawSurplusPeriods = Array.isArray(state.settings?.surplus?.periods)
    ? state.settings.surplus.periods
    : [legacySurplusPeriod(state.settings?.surplus)];
  const surplusPeriods = rawSurplusPeriods.map((p) => ({
    ...p,
    fromYear: resolveRef(p.from, plan, dateSchedule, "client").planYear,
    toYear: resolveRef(p.to, plan, dateSchedule, "client").planYear,
  }));

  // Adjustment rows (spec 18, Commit 1) — resolved into bounds AND the
  // per-FY real-dollar amount, unlike surplus periods above: an
  // adjustment IS a dollar amount over time (same shape as an income/
  // expense row), so it follows the SAME convention every other row's
  // indexation already does here, rather than deferring the arithmetic
  // to deterministic.js. Fires once, in July, like every other annual
  // row — julyMonthIndex returns null for a partial first year that
  // doesn't start in July (convention 5), so that FY is silently
  // skipped, matching every other annual flow.
  const rawAdjustments = Array.isArray(plan.adjustments) ? plan.adjustments : [];
  const adjustments = rawAdjustments.map((a) => {
    const anchorOwner = a.owner === "partner" ? "partner" : "client";
    const fromYear = resolveRef(a.from, plan, dateSchedule, anchorOwner).planYear;
    const toYear = resolveRef(a.to, plan, dateSchedule, anchorOwner).planYear;
    const amountAtYear = new Float64Array(planYears);
    for (let y = Math.max(0, fromYear); y <= Math.min(planYears - 1, toYear); y++) {
      const jm = julyMonthIndex(plan, y);
      if (jm == null) continue;
      amountAtYear[y] = realAmountAt(a, jm, cpi, awote);
    }
    return { ...a, fromYear, toYear, amountAtYear };
  });

  // Redundancy and ETP (spec 19 Commit 3) — resolved once here, same
  // "fires in July of its resolved plan year" convention every other
  // age-anchored one-off event in this engine already uses (property
  // purchases, FHSSS releases). planState.js's clampIncomeRow forces
  // the row's own `to` to equal termination.at when enabled, so the
  // row's ordinary income naturally stops there via the EXISTING
  // from/to mechanism — this only resolves the PAYOUT's own month/age
  // (age drives the ETP tax bracket in deterministic.js).
  const terminationEvents = state.cashflows.income
    .filter((r) => r.termination?.enabled)
    .map((r) => {
      const owner = r.owner === "partner" ? "partner" : "client";
      const y = resolveRef(r.termination.at, plan, dateSchedule, owner).planYear;
      const month = julyMonthIndex(plan, y);
      const age = (owner === "partner" ? partnerAges : clientAges)[y] ?? null;
      return { rowId: r.id, owner, month, age, ...r.termination };
    })
    .filter((e) => e.month != null);

  // Bonus destinations (spec 23, Commit 2) — a bonus can nominate a
  // destination (extra loan repayment / super contribution / asset)
  // instead of landing as ordinary household cash. This module only
  // resolves the STATIC parts (bounds, firing month, gross real-dollar
  // amount, and whether the target structurally exists) — the actual
  // AFTER-TAX amount depends on that FY's own tax assessment, which
  // only deterministic.js can compute; it applies the credit directly
  // against the live balance at this exact month, real-pass only,
  // exactly like a pension commutation already does. "Falls through to
  // the normal surplus treatment if unavailable" (the spec's own
  // words) covers both a structurally-invalid destination (dropped
  // here — never coerced to a fallback, same rule clampBonusDestination
  // itself already applies) and an insufficient-cash month
  // (deterministic.js's own concern, at apply time) — either way the
  // bonus's gross amount still lands in ordinary income regardless.
  const bonusDestinationEvents = [];
  for (const row of state.cashflows.income) {
    if (row.category !== "bonus" || !(row.amount > 0)) continue;
    const dest = row.bonusDestination;
    if (!dest?.type || !dest.targetId) continue;
    const targetExists =
      (dest.type === "loanRepayment" && (state.liabilities ?? []).some((l) => l.id === dest.targetId)) ||
      (dest.type === "superContribution" && (plan.superAccounts ?? []).some((s) => s.include && s.id === dest.targetId)) ||
      (dest.type === "asset" && includedIds.has(dest.targetId));
    if (!targetExists) continue;
    const bounds = {
      from: resolveRef(row.from, plan, dateSchedule, row.owner).planYear,
      to: resolveRef(row.to, plan, dateSchedule, row.owner).planYear,
    };
    for (let y = 0; y < planYears; y++) {
      if (!activeInPlanYear(bounds, y)) continue;
      const month = bonusMonthIndex(plan, y, row.bonusMonth ?? 6);
      if (month == null) continue;
      const grossAmount = realAmountAt(row, month, cpi, awote);
      if (grossAmount <= 0) continue;
      bonusDestinationEvents.push({ rowId: row.id, owner: row.owner, year: y, month, grossAmount, destination: dest });
    }
  }

  return {
    months,
    planYears,
    monthsInFirstYear: firstYearMonths,
    fyLabels,
    clientAges,
    partnerAges,
    yearOfMonth,
    income,
    incomeByOwner,
    employmentIncomeByOwner,
    deductionsByOwner,
    expenses,
    assetFlows,
    superFlows,
    fhsssFlows,
    toConcessionalCapRows,
    surplusPeriods,
    adjustments,
    terminationEvents,
    bonusDestinationEvents,
    spouseContributionsByOwner,
    personalNccByOwner,
    superInsurancePremiums,
    superWarnings,
    rowTotals,
    oneOffsByAssetYear,
    liabilityExtraFlows,
  };
}
