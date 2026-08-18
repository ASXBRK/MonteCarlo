// Focus: Main residence exemption and the six-year absence rule
// (docs/specs/19-engine-completion.md, Commit 5's own Focus view — never
// built until this commit). Pure, no DOM/Plotly.
//
// The timeline/exempt-days table are pure day-count arithmetic built on
// mainResidence.js's own exemptProportion (never re-derived — one
// definition of the rule, shared with the real engine). The CGT-if-sold
// series is a REAL projectPlan() re-run per candidate year (the same
// "always use the real engine, never a shortcut formula" convention
// every other Focus view follows) — CGT tax payable depends on the
// person's marginal rate and whatever else that FY, which a standalone
// formula would have to reconstruct and could drift from the engine's
// own assessment. Isolated as an INCREMENTAL figure: total household
// tax under a synthetic sale at year Y, less total tax under no sale at
// all, for the same FY — the actual $ cost of selling THEN, not just
// the taxable gain.

import { projectPlan } from "./deterministic.js";
import { clampAllToPlan } from "./planState.js";
import { PROFILES } from "./profiles.js";
import { resolveRef } from "./keyDates.js";
import { firstFyStartYear } from "./schedule.js";
import { exemptProportion } from "./mainResidence.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
function daysBetween(fromISO, toISO) {
  return Math.max(0, Math.round((new Date(toISO).getTime() - new Date(fromISO).getTime()) / MS_PER_DAY));
}
function addYearsISO(iso, years) {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

// Eligible properties for this view — the six-year rule only ever
// applies to a `ppr` property (the spec's own scope: an investment/
// holiday property is either fully assessable throughout or, if it was
// ever someone's home, that history predates this projection and is
// out of scope — see mainResidence.js's own header).
export function eligibleMainResidenceProperties(state) {
  return (state.properties ?? []).filter((p) => p.propertyType === "ppr");
}

// The four status labels the spec names, at a given calendar date.
// "investment" never applies to a ppr property in this model (there is
// no mechanism here for a main residence to change propertyType) — it
// is reported only via mainResidencePropertyTimeline's own handling of
// a NON-ppr property, included in the same timeline view for
// comparison ("this one never had the exemption question at all").
export function mainResidenceStatusAt(acquisitionDateISO, atISO, mainResidence) {
  const { movedOutAt, producingIncome, movedBackInAt } = mainResidence ?? {};
  const at = new Date(atISO).getTime();
  if (!movedOutAt || at < new Date(movedOutAt).getTime()) return "main-residence";
  if (movedBackInAt && at >= new Date(movedBackInAt).getTime()) return "main-residence";
  if (!producingIncome) return "absent-covered"; // vacant absence — no clock, exempt indefinitely
  const sixYearMark = addYearsISO(movedOutAt, 6);
  return at < new Date(sixYearMark).getTime() ? "absent-covered" : "absent-exceeded";
}

// julyISOof(plan, y) — 1 July of plan year y, the same calendar year
// deterministic.js's own julyOf resolves for that plan year, just
// expressed as a date string (mainResidence.js's arithmetic is all
// calendar-date based) rather than a month index — built on the SAME
// firstFyStartYear schedule.js already exports, not re-derived.
function julyISOof(plan, y) {
  return `${firstFyStartYear(plan.start) + y}-07-01`;
}

// The effective acquisition date to measure ownership days from — a
// still-to-be-purchased property has no acquisitionDate yet, so this
// falls back to the resolved purchase date, mirroring deterministic.js's
// own effectiveAcquisitionDate (never re-derived independently — see
// that function's header for why a null date must not default to
// "fully exempt").
function effectiveAcquisitionDate(property, plan, schedule) {
  if (property.acquisitionDate) return property.acquisitionDate;
  const y = resolveRef(property.purchaseAt, plan, schedule, "client").planYear;
  return julyISOof(plan, y);
}

// mainResidence.movedOutAt/movedBackInAt are stored as DateRefs (age or
// anchor), like every other property date — resolved to a calendar ISO
// date the SAME way deterministic.js's own resolveMainResidenceDates
// does (never re-derived independently), since mainResidence.js's own
// arithmetic is calendar-date based.
function resolveMainResidenceDatesISO(mr, plan, schedule) {
  if (!mr?.movedOutAt) return { movedOutAt: null, producingIncome: false, movedBackInAt: null };
  const movedOutAt = julyISOof(plan, resolveRef(mr.movedOutAt, plan, schedule, "client").planYear);
  const movedBackInAt = mr.movedBackInAt
    ? julyISOof(plan, resolveRef(mr.movedBackInAt, plan, schedule, "client").planYear)
    : null;
  return { movedOutAt, producingIncome: mr.producingIncome === true, movedBackInAt };
}

// Timeline + exempt-days table for one property, one row per plan year.
export function buildMainResidenceTimeline({ property, plan, schedule }) {
  const isPpr = property.propertyType === "ppr";
  const acquisitionISO = effectiveAcquisitionDate(property, plan, schedule);
  const mrISO = resolveMainResidenceDatesISO(property.mainResidence, plan, schedule);
  const years = schedule.fyLabels.length;
  const rows = [];
  for (let y = 0; y < years; y++) {
    const atISO = julyISOof(plan, y);
    const status = isPpr ? mainResidenceStatusAt(acquisitionISO, atISO, mrISO) : "investment";
    const totalDays = daysBetween(acquisitionISO, atISO);
    const proportion = isPpr ? exemptProportion(acquisitionISO, atISO, mrISO) : 0;
    rows.push({
      y, fyLabel: schedule.fyLabels[y], status,
      totalDays, exemptDays: Math.round(totalDays * proportion), exemptProportion: proportion,
    });
  }
  return rows;
}

// A dedicated zero-income, zero-growth destination asset, injected into
// a throwaway clone only — parking the sale proceeds somewhere that
// earns nothing means the ONLY tax difference a sale can create is the
// sale's own CGT, not extra investment income the proceeds would earn
// for the rest of that FY (a real, found-while-building-this confound:
// routing the sale to one of the plan's own real assets measured the
// SUM of CGT plus that asset's own earnings on the extra cash, not CGT
// alone).
function withMeasurementAsset(clone) {
  const id = "__mre_measure__";
  clone.assets = [...clone.assets, {
    id, name: "(measurement only)", include: true, owner: "client", class: "financial", balance: 0,
    allocation: { mode: "custom", incomePct: 0, growthPct: 0, frankingPct: 0, volBasis: "Balanced" },
    icrPct: 0, cgtAsset: false, costBase: null,
  }];
  return id;
}

// CGT payable if sold in each year — a REAL projectPlan() re-run per
// candidate year (see this file's own header for why). `years` lets
// the caller thin a long projection (e.g. every year for the first
// decade, then every 5th) rather than paying for every single one;
// omit to cover the whole projection.
export function buildCgtIfSoldSeries({ state, property, out, years }) {
  const plan = state.plan;
  const candidateYears = years ?? out.yearly.map((_, y) => y);
  // Baseline: this property never sells at all, for the SAME FY's total
  // household tax to diff against — computed once, reused for every
  // candidate year (the baseline doesn't depend on which year we're
  // testing a hypothetical sale in).
  const baselineClone = structuredClone(state);
  const baselineProp = baselineClone.properties.find((p) => p.id === property.id);
  baselineProp.sale = { ...baselineProp.sale, enabled: false };
  const baselineOut = projectPlan(clampAllToPlan(baselineClone, PROFILES));

  return candidateYears.map((y) => {
    const clone = structuredClone(state);
    const measureAssetId = withMeasurementAsset(clone);
    const prop = clone.properties.find((p) => p.id === property.id);
    prop.sale = {
      ...prop.sale, enabled: true, assetId: measureAssetId,
      at: { kind: "age", age: plan.client.currentAge + y },
    };
    const saleOut = projectPlan(clampAllToPlan(clone, PROFILES));
    // CGT assessed on a sale in year y is PAID in July of year y+1 (this
    // engine's own convention — see CLAUDE.md's Tax section and
    // deterministic.js's own cgtDue/pendingCgt) — comparing yearly[y].tax
    // would silently show zero every time. A sale in the FINAL plan year
    // has no y+1 row at all; accruedCgtAtEnd is where that last FY's CGT
    // surfaces instead (same "unpayable inside the projection" figure
    // every other end-of-projection CGT already uses).
    const cgtPayable = y + 1 < saleOut.yearly.length
      ? Math.max(0, (saleOut.yearly[y + 1]?.tax ?? 0) - (baselineOut.yearly[y + 1]?.tax ?? 0))
      : Math.max(0, saleOut.accruedCgtAtEnd - baselineOut.accruedCgtAtEnd);
    return { y, fyLabel: out.schedule.fyLabels[y], cgtPayable };
  });
}
