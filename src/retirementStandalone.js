// Retirement Projection — Standalone Surface (docs/specs/33-retirement-
// standalone.md, Commit 1) — pure, no DOM/Plotly.
//
// Maps the standalone page's own inputs onto EXISTING state fields —
// plan.client.*, plan.partner.*, plan.superAccounts[*],
// cashflows.income, cashflows.superContributions, state.assets[*],
// plan.retirement — and nothing else. This is the spec's own explicit
// constraint, restated in the chat that commissioned this commit: "NO
// NEW STATE SHAPE... A scenario created on this page is an ordinary
// scenario with a subset populated, and must open correctly in the
// comprehensive workspace." A parallel state shape would recreate,
// inside this tool, the exact "two models disagreeing" problem spec
// 32/33 exist to let a firm diagnose in ANOTHER tool — building one
// here would be absurd.
//
// Household scope, revised after Commit 1's first review: both single
// and couple households. The About and Superannuation cards are
// per-person (client, and partner when household is "couple");
// Household-level fields (Income Required, other investments, other
// retirement income, the age pension toggle) stay a single set of
// controls regardless — resolveIncomeRequired/asfaAnnual/age-pension
// means testing already key off plan.household themselves, so nothing
// there needs touching for couple support.
//
// Every setter takes a state and returns a NEW state (never mutates its
// argument) with exactly the touched path replaced — the caller is
// responsible for re-validating through clampAllToPlan(state, profiles)
// afterwards, the same "mutate, then clamp once" shape every other
// main.js commit function already uses. Where a target row/account
// doesn't exist yet (a brand-new scenario's own super account, financial
// asset, or income row), the setter creates ONE using the SAME factory
// the comprehensive workspace's own "+ Add..." buttons call
// (createSuperAccount/createAsset/createIncomeRow/createSuperContribution)
// — never a bespoke shape of its own.

import {
  createSuperAccount, createAsset, createIncomeRow, createSuperContribution, createIncomeRequired,
  createPension, isCoupleHousehold, clampGlidePath,
} from "./planState.js";
import { superRatesFor } from "./data/superRates.js";
import { agePensionRatesFor } from "./data/agePension.js";
import { div293Tax } from "./Tax/superContributions.js";
import { resolveRef } from "./keyDates.js";
import { firstFyStartYear } from "./schedule.js";

const RETIREMENT_CLIENT_ANCHOR = { kind: "anchor", anchorId: "retirement-client" };
const RETIREMENT_PARTNER_ANCHOR = { kind: "anchor", anchorId: "retirement-partner" };
const END_ANCHOR = { kind: "anchor", anchorId: "end" };
const retirementAnchorFor = (owner) => (owner === "partner" ? RETIREMENT_PARTNER_ANCHOR : RETIREMENT_CLIENT_ANCHOR);

// --- Reads (own account/row per concern; every one takes `owner`) -----

export function superAccountFor(state, owner) {
  return (state.plan.superAccounts ?? []).find((s) => s.owner === owner) ?? null;
}

function findSalaryRow(state, owner) {
  return (state.cashflows.income ?? []).find((r) => r.owner === owner && r.category === "salary") ?? null;
}

function findConcessionalContributionRow(state, owner) {
  return (state.cashflows.superContributions ?? []).find((c) => c.owner === owner && c.type === "salarySacrifice") ?? null;
}

// Structural match, not a marker field (no new field anywhere) — the
// one income row owned by the client, categorised "otherIncome", that
// starts at the retirement-client anchor specifically. Always
// client-owned: "other retirement income" is a HOUSEHOLD figure on
// this page (one combined amount), never split per person. A household
// that separately adds a SECOND otherIncome row via the comprehensive
// workspace (starting elsewhere) is out of this simple page's own
// reach — a disclosed limitation of "deliberately narrow", not a
// silent miscount.
function findOtherRetirementIncomeRow(state) {
  return (state.cashflows.income ?? []).find((r) =>
    r.owner === "client" && r.category === "otherIncome"
    && r.from?.kind === "anchor" && r.from?.anchorId === "retirement-client"
  ) ?? null;
}

export function findOtherInvestmentsAsset(state) {
  return (state.assets ?? [])[0] ?? null;
}

export function pensionFor(state, owner) {
  return (state.plan.pensions ?? []).find((p) => p.owner === owner) ?? null;
}

function personRetirementFields(state, owner) {
  const person = owner === "partner" ? state.plan.partner : state.plan.client;
  const sa = superAccountFor(state, owner);
  const salary = findSalaryRow(state, owner);
  const contribution = findConcessionalContributionRow(state, owner);
  return {
    firstName: person?.firstName ?? "",
    dob: person?.dob ?? "",
    retirementAge: person?.retirementAge ?? 65,
    superBalance: sa?.balance ?? 0,
    superAllocation: sa?.allocation ?? null,
    salary: salary?.amount ?? 0,
    concessionalContributions: contribution?.amount ?? 0,
    // The row's own DateRef window — null (not a default) when no row
    // exists yet, so the UI can fall back to what createSuperContribution
    // WOULD default to (start → the owner's own retirement anchor)
    // without this read side inventing that default a second time.
    concessionalContributionsFrom: contribution?.from ?? null,
    concessionalContributionsTo: contribution?.to ?? null,
  };
}

// retirementFields(state) → the page's own fields' CURRENT values, read
// straight off the existing state paths above — the read side symmetric
// with every setter below, so the page can populate its form from
// whatever state it loaded (a fresh scenario, or one edited earlier in
// this same session) without tracking any of its own local copy.
// `client`/`partner` mirror each other's shape; `partner` is null for a
// single household (no partner card to render).
export function retirementFields(state) {
  const couple = isCoupleHousehold(state.plan.household);
  const otherIncome = findOtherRetirementIncomeRow(state);
  const asset = findOtherInvestmentsAsset(state);
  return {
    household: couple ? "couple" : "single",
    client: personRetirementFields(state, "client"),
    partner: couple ? personRetirementFields(state, "partner") : null,
    incomeRequired: state.plan.retirement?.incomeRequired ?? createIncomeRequired(),
    otherInvestments: asset?.balance ?? 0,
    otherInvestmentsAllocation: asset?.allocation ?? null,
    otherRetirementIncome: otherIncome?.amount ?? 0,
    includeAgePension: state.plan.client.taxProfile?.centrelinkEligible !== false,
  };
}

// True once the partner has any figures entered on THIS page (a super
// account, a salary row, or a concessional-contribution row) — the
// signal main.js uses to decide whether switching back to "single"
// needs a confirmation (nothing to lose vs real dollars to lose).
// Partner identity fields alone (name/DOB/retirement age with no money
// attached) don't count — cheap to re-type, not worth a confirm.
export function partnerHasData(state) {
  return !!(
    superAccountFor(state, "partner")
    || findSalaryRow(state, "partner")
    || findConcessionalContributionRow(state, "partner")
  );
}

// --- Household toggle ---------------------------------------------------

// target: "single" | "couple". Couple → single strips every partner-
// owned row THIS PAGE creates (super account, pension, salary row,
// concessional-contribution row) before nulling plan.partner —
// otherwise clampPlan's own generic behaviour (every owner:"partner"
// row silently reassigned to "client" once plan.partner is null — see
// clampSuperAccount/clampPension/clampIncomeRow/clampSuperContribution)
// would merge the partner's balance/salary/pension into the client's
// own figures with no visible change, rather than actually removing
// them. main.js is responsible for confirming with the user first when
// partnerHasData(state) is true — this setter itself is unconditional
// once called, same "pure, no dialog" convention as every other setter
// in this module.
export function setHousehold(state, target) {
  if (target === "couple") {
    if (isCoupleHousehold(state.plan.household)) return state;
    return {
      ...state,
      plan: {
        ...state.plan,
        household: "married",
        partner: state.plan.partner ?? { currentAge: state.plan.client.currentAge },
      },
    };
  }
  const superAccounts = (state.plan.superAccounts ?? []).filter((s) => s.owner !== "partner");
  const pensions = (state.plan.pensions ?? []).filter((p) => p.owner !== "partner");
  const income = (state.cashflows.income ?? []).filter((r) => r.owner !== "partner");
  const superContributions = (state.cashflows.superContributions ?? []).filter((c) => c.owner !== "partner");
  return {
    ...state,
    plan: { ...state.plan, household: "single", partner: null, superAccounts, pensions },
    cashflows: { ...state.cashflows, income, superContributions },
  };
}

// --- Per-person setters (owner: "client" | "partner") -------------------

function withPerson(state, owner, patch) {
  const key = owner === "partner" ? "partner" : "client";
  return { ...state, plan: { ...state.plan, [key]: { ...state.plan[key], ...patch } } };
}

export function setFirstName(state, owner, value) {
  return withPerson(state, owner, { firstName: value });
}

export function setDob(state, owner, value) {
  return withPerson(state, owner, { dob: value });
}

export function setRetirementAge(state, owner, value) {
  return withPerson(state, owner, { retirementAge: value });
}

// Ensures exactly one super account for `owner` exists, creating one
// via the SAME factory the comprehensive Super input section's own
// "+ Add super account" button calls, if none does yet. Never a second,
// parallel concept of "the retirement page's own super account" — a
// scenario created here has ordinary plan.superAccounts entries, full
// stop.
export function ensurePersonSuperAccount(state, owner, profiles) {
  if (superAccountFor(state, owner)) return state;
  const sa = createSuperAccount(state.plan, state.plan.superAccounts ?? [], profiles, owner);
  return { ...state, plan: { ...state.plan, superAccounts: [...(state.plan.superAccounts ?? []), sa] } };
}

function withPersonSuperAccount(state, owner, profiles, patch) {
  const next = ensurePersonSuperAccount(state, owner, profiles);
  const superAccounts = next.plan.superAccounts.map((s) => (s.owner === owner ? { ...s, ...patch(s) } : s));
  return { ...next, plan: { ...next.plan, superAccounts } };
}

export function setSuperBalance(state, owner, value, profiles) {
  return withPersonSuperAccount(state, owner, profiles, () => ({ balance: value }));
}

// `allocation` is either { mode: "profile", profile } or
// { mode: "glidePath", glidePathId } — the same shape clampAllocation
// already validates for every other allocation-bearing row; this
// setter stores it as given and leaves validation to the caller's own
// clampAllToPlan pass (a dangling glidePathId falls back to a firm
// profile there, same as everywhere else).
export function setSuperAllocation(state, owner, allocation, profiles) {
  return withPersonSuperAccount(state, owner, profiles, () => ({ allocation }));
}

function withSalaryRow(state, owner, patch) {
  const existing = findSalaryRow(state, owner);
  if (existing) {
    const income = state.cashflows.income.map((r) => (r.id === existing.id ? { ...r, ...patch } : r));
    return { ...state, cashflows: { ...state.cashflows, income } };
  }
  const row = {
    ...createIncomeRow(state.plan, state.cashflows.income ?? []),
    owner,
    to: retirementAnchorFor(owner),
    ...patch,
  };
  return { ...state, cashflows: { ...state.cashflows, income: [...(state.cashflows.income ?? []), row] } };
}

export function setSalary(state, owner, value) {
  return withSalaryRow(state, owner, { amount: value });
}

// Shared find-or-create for the one concessional-contribution row this
// page edits — `patch` is applied whether the row already exists or is
// being created for the first time (createSuperContribution's own
// default from/to — start to the owner's own retirement anchor — is
// the starting point either way; a from/to setter below just patches
// straight on top of that same row, never a second one).
function withConcessionalContributionRow(state, owner, profiles, patch) {
  const withAccount = ensurePersonSuperAccount(state, owner, profiles);
  const existing = findConcessionalContributionRow(withAccount, owner);
  if (existing) {
    const superContributions = withAccount.cashflows.superContributions.map((c) =>
      (c.id === existing.id ? { ...c, ...patch } : c)
    );
    return { ...withAccount, cashflows: { ...withAccount.cashflows, superContributions } };
  }
  const row = {
    ...createSuperContribution(withAccount.plan, withAccount.plan.superAccounts, owner),
    amount: 0, basis: "amount", frequency: "annual",
    ...patch,
  };
  return {
    ...withAccount,
    cashflows: { ...withAccount.cashflows, superContributions: [...(withAccount.cashflows.superContributions ?? []), row] },
  };
}

// "Concessional contributions beyond SG (annual)" — salarySacrifice is
// the natural fit (createSuperContribution's own default type, and the
// spec's own wording: additional to SG, not SG itself — see schedule.js
// for why SG needs no explicit contribution row at all: it's derived
// automatically from every sgApplies:true income row).
export function setConcessionalContributions(state, owner, value, profiles) {
  return withConcessionalContributionRow(state, owner, profiles, { amount: value, basis: "amount", frequency: "annual" });
}

// Spec 34, Commit 1 — "a single static number cannot describe any real
// contribution strategy": the row's own EXISTING from/to DateRef fields
// (already present on every superContribution row, already validated
// by clampFromTo/clampSuperContribution — no new state shape) become
// editable here, so "salary sacrifice $15,000 from 55 until retirement"
// is expressible on this page, not just in the comprehensive workspace.
export function setConcessionalContributionsFrom(state, owner, ref, profiles) {
  return withConcessionalContributionRow(state, owner, profiles, { from: ref });
}

export function setConcessionalContributionsTo(state, owner, ref, profiles) {
  return withConcessionalContributionRow(state, owner, profiles, { to: ref });
}

// --- Household setters ---------------------------------------------------

// plan.retirement.incomeRequired is the SPEC 32 CONTROL, all sources —
// this setter merges a partial patch (e.g. { source: "asfaComfortable" }
// or { customAmount: 90000 }) rather than requiring the caller to
// reconstruct the whole object, matching main.js's own
// commitIncomeRequired convention on the comprehensive Settings page.
// Already household-aware (isCoupleHousehold(plan.household) inside
// retirement.js's own resolver) — nothing here changes for a couple.
export function setIncomeRequired(state, patch) {
  const incomeRequired = { ...(state.plan.retirement?.incomeRequired ?? createIncomeRequired()), ...patch };
  return { ...state, plan: { ...state.plan, retirement: { ...state.plan.retirement, incomeRequired } } };
}

function withOtherInvestmentsAsset(state, profiles, patch) {
  const assets = state.assets && state.assets.length > 0
    ? state.assets.map((a, i) => (i === 0 ? { ...a, ...patch(a) } : a))
    : [{ ...createAsset(state.plan, [], profiles), ...patch(null) }];
  const fundingOrder = state.settings.fundingOrder.length > 0 || assets.length === 0
    ? state.settings.fundingOrder
    : [assets[0].id];
  return { ...state, assets, settings: { ...state.settings, fundingOrder } };
}

// "Other investments as a single lump" — defaultState() already seeds
// exactly one financial asset (assets[0]); this writes into THAT row
// rather than adding a second one, so a scenario created here still
// carries the ordinary single-asset shape every fresh scenario has.
// One combined pool for the household, same as otherRetirementIncome —
// never split per person.
export function setOtherInvestments(state, value, profiles) {
  return withOtherInvestmentsAsset(state, profiles, () => ({ balance: value }));
}

export function setOtherInvestmentsAllocation(state, allocation, profiles) {
  return withOtherInvestmentsAsset(state, profiles, () => ({ allocation }));
}

// "Other retirement income (annual, indexed)" — an ordinary
// cashflows.income row, category "otherIncome" (clampIncomeRow derives
// incomeType "otherTaxable" and sgApplies false from that category
// alone — never set manually here), running from the retirement-client
// anchor to the plan's own end, indexed to CPI by default.
export function setOtherRetirementIncome(state, value) {
  const existing = findOtherRetirementIncomeRow(state);
  if (existing) {
    const income = state.cashflows.income.map((r) => (r.id === existing.id ? { ...r, amount: value } : r));
    return { ...state, cashflows: { ...state.cashflows, income } };
  }
  const row = {
    ...createIncomeRow(state.plan, state.cashflows.income ?? []),
    category: "otherIncome",
    amount: value,
    frequency: "annual",
    indexBasis: "cpi",
    indexExtraPct: 0,
    from: RETIREMENT_CLIENT_ANCHOR,
    to: END_ANCHOR,
  };
  return { ...state, cashflows: { ...state.cashflows, income: [...(state.cashflows.income ?? []), row] } };
}

// "Include age pension" toggle, default on, ONE control for the whole
// household — there is no single household-level Centrelink flag in
// this schema (planState.js's applyCentrelinkEligibleDefault sets
// plan.client.taxProfile.centrelinkEligible / centrelinkEligibleIsDefault
// PER PERSON), so this setter applies the same choice to whichever
// people currently exist (client always; partner too, when present) —
// keeping the schema's per-person flags in lockstep behind what reads
// as a single household switch on this page. Age pension MEANS TESTING
// itself already resolves couple-vs-single thresholds from
// plan.household with no change needed here; this toggle only controls
// whether either person is assessed at all. ON restores the smart
// default (age-based eligibility, still tracked); OFF is an explicit,
// permanent override — never age-pension-eligible regardless of age —
// same one-way "stop tracking the smart default" convention every other
// derived-default field in this schema already uses.
export function setIncludeAgePension(state, included) {
  const patch = { centrelinkEligible: included ? true : false, centrelinkEligibleIsDefault: included };
  const client = { ...state.plan.client, taxProfile: { ...state.plan.client.taxProfile, ...patch } };
  const partner = state.plan.partner
    ? { ...state.plan.partner, taxProfile: { ...state.plan.partner.taxProfile, ...patch } }
    : state.plan.partner;
  return { ...state, plan: { ...state.plan, client, partner } };
}

// --- Retirement drawdown provisioning (Commit 2) -------------------------
//
// Commit 1's nine fields have no "commence a pension" input — but
// without an explicit plan.pensions entry the engine never draws super
// down at all (only a pension converts a balance into retirement
// income; see deterministic.js's own resolvePensionThisYear). Left
// alone, a "retirement projection" built from just these nine numbers
// would show super accumulating forever, untouched, which is not a
// retirement projection — decided with the user before building
// Commit 2's outputs on top of it (see chat).
//
// ensureRetirementPensions silently creates ONE pension per person who
// already has a super account (client always once touched; partner too,
// in a couple), via the SAME createPension factory the comprehensive
// workspace's own "+ Add pension" button calls — still "no new state
// shape", just an existing shape this page now also provisions. Each
// pension is set to drawdownOption "expenditure" ("Fund expenditure
// shortfall" — deterministic.js resolves its payment dynamically each
// month to cover whatever the household needs, floored at the
// statutory minimum), and — the FIRST time any such pension is created
// — plan.retirement.incomeDrivenDrawdown is switched on, so the
// combined pensions actively top up toward the page's own Income
// Required figure at each FY's end (spec 32 Commit 4's existing
// mechanism) rather than merely reacting to whatever the raw literal
// expense shortfall happens to be. Only touched on FIRST creation — an
// adviser who later opens the comprehensive workspace and deliberately
// turns income-driven drawdown off keeps that choice on every
// subsequent visit to this page; ensureRetirementPensions never
// re-forces it once pensions already exist.
export function ensureRetirementPensions(state, profiles) {
  const owners = isCoupleHousehold(state.plan.household) ? ["client", "partner"] : ["client"];
  let next = state;
  let created = false;
  for (const owner of owners) {
    if (!superAccountFor(next, owner)) continue; // nothing to draw from yet
    if (pensionFor(next, owner)) continue; // already provisioned
    const pn = {
      ...createPension(next.plan, next.plan.pensions ?? [], next.plan.superAccounts ?? [], owner),
      drawdownOption: "expenditure",
    };
    next = { ...next, plan: { ...next.plan, pensions: [...(next.plan.pensions ?? []), pn] } };
    created = true;
  }
  if (!created) return next;
  return { ...next, plan: { ...next.plan, retirement: { ...next.plan.retirement, incomeDrivenDrawdown: true } } };
}

// --- Derived inputs (spec 34, Commit 1: "the page knows things") --------
//
// Pure calculations only — main.js wraps each result in the page's own
// HTML. Kept here (not inline in main.js) so the underlying figures are
// unit-testable the same way every other pure module in this codebase
// is, per the spec's own explicit test list: "SG derives correctly...;
// preservation and pension ages from DOB; cap headroom matching the
// comprehensive section's own figures; the Division 293 warning firing
// at the right year." `schedule` is the caller's own already-built
// projection.schedule (or buildSchedules(state) directly for a
// schedule-only need) — these functions never build one themselves.

// Super Guarantee for `owner`, resolved for TODAY's FY (year 0) — a
// live "what would this year's SG be" readout, via the SAME formula
// schedule.js's own SG crediting uses
// (Math.min(salary, sgMaximumSalary) * sgRate). "Remove any input that
// duplicates it" (spec's own words) — none exists on this page.
export function sgFor(state, salary) {
  const a = state.assumptions;
  const f0 = firstFyStartYear(state.plan.start);
  const mode = a.bracketMode === "frozen" ? "frozen" : "indexed";
  const rates = superRatesFor(f0, mode, a.cpi, a.awote ?? 0.032);
  const isCapped = salary > rates.sgMaximumSalary;
  const base = Math.min(salary, rates.sgMaximumSalary);
  return { amount: base * rates.sgRate, ratePct: rates.sgRate * 100, base, sgMaximumSalary: rates.sgMaximumSalary, isCapped, salary };
}

// The calendar year `owner` reaches `age`, resolved the SAME way every
// other age-to-year figure in this app is (resolveRef's own
// {kind:"age"} resolution — ages tick each 1 July, CLAUDE.md's own
// locked convention — not a naive dob-year-plus-age approximation).
// `year: null` when the age falls beyond the projection window.
export function ageYear(state, owner, age, schedule) {
  const resolved = resolveRef({ kind: "age", age }, state.plan, schedule, owner);
  const f0 = firstFyStartYear(state.plan.start);
  return { age, year: resolved.outOfRange ? null : f0 + resolved.planYear, outOfRange: resolved.outOfRange };
}

// Preservation age (a flat constant for the only cohort this tool
// models — superRatesFor's own preservationAge) resolved to a year for
// `owner`. "Derive from date of birth. Show them; do not ask" (spec's
// own words) — the AGE doesn't vary by client here, the YEAR does.
export function preservationAgeFor(state, owner, schedule) {
  const f0 = firstFyStartYear(state.plan.start);
  const rates = superRatesFor(f0);
  return ageYear(state, owner, rates.preservationAge, schedule);
}

// Age pension age (agePensionRatesFor's own ageOfEligibility), same
// shape as preservationAgeFor.
export function agePensionAgeFor(state, owner, schedule) {
  const f0 = firstFyStartYear(state.plan.start);
  const rates = agePensionRatesFor(f0);
  return ageYear(state, owner, rates.ageOfEligibility, schedule);
}

// Concessional cap headroom for `owner`, TODAY's FY (year 0) — "live,
// as the comprehensive super section already does" (spec's own
// words): reads the SAME projection.yearly[0].superCapUsage[owner] the
// comprehensive Super section's own superCapHeadroomHTML reads (see
// that function's own header in main.js), so this can never disagree
// with that figure. `null` when no super account/projection exists yet
// for this owner.
export function capHeadroomFor(projection, owner) {
  return projection.yearly?.[0]?.superCapUsage?.[owner] ?? null;
}

// Division 293 — the FIRST plan year `owner`'s reconstructed Division
// 293 tax is actually positive (spec: "when income plus concessional
// contributions approaches $250,000, with the year it first bites").
// Reconstructed via the SAME pure div293Tax the engine itself calls
// (Tax/superContributions.js) — never a duplicated rule — fed from
// what's ALREADY exposed per year (row.superCapUsage for this person's
// own SG/salary-sacrifice/cap-and-carry-forward position,
// row.taxDetail[owner].taxableIncome). Deliberately NOT
// row.taxDetail[owner].div293 — that field reports the PRIOR year's
// tax, paid this July (deterministic.js's own CGT-style payment-timing
// convention), which would name the wrong (later) year as "when it
// first bites". `null` when it never bites within the projection.
export function firstDiv293Year(state, projection, owner) {
  const a = state.assumptions;
  const f0 = firstFyStartYear(state.plan.start);
  const mode = a.bracketMode === "frozen" ? "frozen" : "indexed";
  const ages = owner === "partner" ? projection.schedule.partnerAges : projection.schedule.clientAges;
  for (let y = 0; y < projection.yearly.length; y++) {
    const row = projection.yearly[y];
    const usage = row.superCapUsage?.[owner];
    const taxDetail = row.taxDetail?.[owner];
    if (!usage || !taxDetail) continue;
    const rates = superRatesFor(f0 + y, mode, a.cpi, a.awote ?? 0.032);
    const reportableSuperContributions = usage.sg + usage.salarySacrifice + usage.personalDeductible;
    const lowTaxContributions = Math.min(reportableSuperContributions, usage.cap + usage.carryForwardAvailable);
    const { tax } = div293Tax({
      taxableIncome: taxDetail.taxableIncome,
      reportableSuperContributions, lowTaxContributions, reportableFringeBenefits: 0,
      threshold: rates.div293Threshold, rate: rates.div293Rate,
    });
    if (tax > 1e-6) {
      return { year: f0 + y, age: ages?.[y] ?? null, threshold: rates.div293Threshold, ratePct: rates.div293Rate * 100 };
    }
  }
  return null;
}

// Age pension eligibility, derived (spec: "Age pension modelled from
// age 67 (2049), with the toggle to suppress it") — client-anchored,
// same simplification as every other client-anchored household-level
// display on this page (the toggle itself applies to the whole
// household — setIncludeAgePension keeps every person's own
// centrelinkEligible flag in lockstep).
export function agePensionEligibilityFor(state, schedule) {
  return agePensionAgeFor(state, "client", schedule);
}

// --- Glide path presets (spec 34, Commit 3: "the two presets from spec
// 32 plus any the adviser has defined") -----------------------------
//
// Mirrors glidePaths.js's own singleStepGlidePathPreset/
// gradualGlidePathPreset (spec 32) exactly in step shape and profile
// names, but parametrized by OWNER rather than hardcoded to plan.client
// — this page edits either person's own account, and those two
// functions only ever read plan.client's own ages.
export const GLIDE_PATH_PRESET_KINDS = ["single", "gradual"];

function glidePathPresetSteps(kind, plan, owner) {
  const person = owner === "partner" ? plan.partner : plan.client;
  const currentAge = person.currentAge, retirementAge = person.retirementAge;
  if (kind === "gradual") {
    const stepDownStart = Math.max(currentAge, retirementAge - 10);
    return {
      name: "Gradual (steps down over the 10 years before retirement, then again at 75)",
      steps: [
        { fromAge: currentAge, profile: "High Growth – Capital" },
        { fromAge: stepDownStart, profile: "High Growth – Capital" },
        { fromAge: retirementAge, profile: "Balanced" },
        { fromAge: Math.max(retirementAge, 74), profile: "Balanced" },
        { fromAge: Math.max(retirementAge + 1, 75), profile: "Moderately Defensive" },
      ],
      rebalance: "annual",
    };
  }
  return {
    name: "Single-step (High Growth → Balanced at retirement)",
    steps: [
      { fromAge: currentAge, profile: "High Growth – Capital" },
      { fromAge: retirementAge, profile: "Balanced" },
    ],
    rebalance: "annual",
  };
}

// Adds a NEW glide path (built from the given preset, for this owner's
// own ages) to plan.glidePaths — an EXISTING field, the same list the
// comprehensive workspace's own Settings panel already maintains, not a
// new shape — and points the owner's super account at it. Every call
// creates a genuinely new glide path (never edits one in place): the
// spec's own examples treat each preset pick as adding a reusable
// option to choose from again, matching "add-preset-single"/
// "add-preset-gradual" in the comprehensive workspace exactly.
export function applyGlidePathPreset(state, owner, presetKind, profiles) {
  const withAccount = ensurePersonSuperAccount(state, owner, profiles);
  const gp = clampGlidePath(glidePathPresetSteps(presetKind, withAccount.plan, owner), withAccount.plan, profiles);
  const glidePaths = [...(withAccount.plan.glidePaths ?? []), gp];
  const superAccounts = withAccount.plan.superAccounts.map((sa) =>
    (sa.owner === owner ? { ...sa, allocation: { mode: "glidePath", glidePathId: gp.id } } : sa)
  );
  return { ...withAccount, plan: { ...withAccount.plan, glidePaths, superAccounts } };
}
