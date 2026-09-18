// Search across inputs (docs/specs/38-finding-and-editing-inputs.md,
// Commit 2). "The fix that keeps working as sections are added" — a
// single box at the top of the input rail, matching row labels, section
// names, and the values themselves.
//
// Pure: builds a flat, precomputed search index straight off state (the
// SAME collections retirementReviewPanel.js's own buildReviewGroups
// reads — no second derivation of "what's in this scenario"), and
// matches a typed term against it. main.js owns rendering results,
// wiring the search box, and click-through/highlight/inline-edit — all
// DOM concerns that belong there.
//
// Every entry's own `dataAttrs` is the EXACT attribute scheme
// applyRetirementReviewFieldEdit (main.js, docs/specs/38 Commit 1)
// already dispatches on (data-kind/data-cfid, data-aid, data-said,
// data-pid, data-lid, data-bdid) — a search result's own inline-edit
// control can be wired with that SAME listener, not a third copy of the
// commit logic. `dataAttrs: null` marks a result with no simple field
// to edit inline (a property, or a bare section-name match) — click-
// through only, per the review panel's own existing rule ("edit inline
// where the field is simple, link out for anything more complex").
import { INCOME_CATEGORY_LABELS, EXPENSE_CATEGORY_LABELS, isCoupleHousehold } from "./planState.js";
import { INPUT_SECTIONS } from "./router.js";

// "Keep this list in one place so it can be extended without hunting
// through the search code" (the spec's own words) — every key and every
// one of its own values are pre-normalised (lowercase) by
// normaliseSearchText below; SEARCH_ALIASES itself is looked up via the
// SAME normalisation, so a caller never needs to hand-lowercase a key
// when extending this list.
export const SEARCH_ALIASES = {
  sac: ["salary sacrifice"],
  "salary sacrifice": ["sac"],
  ncc: ["personal non deductible", "non concessional"],
  "non-concessional": ["personal non deductible", "ncc"],
  "non concessional": ["personal non deductible", "ncc"],
  ttr: ["transition to retirement"],
  "transition to retirement": ["ttr"],
  abp: ["account based pension"],
  "account-based pension": ["abp"],
  "account based pension": ["abp"],
  offset: ["offset account"],
  ppr: ["main residence"],
  "main residence": ["ppr"],
};

function normaliseSearchText(s) {
  return String(s ?? "").toLowerCase().trim();
}

// "salarySacrifice" → "salary sacrifice"; "personalNonDeductible" →
// "personal non deductible" — turns a stored camelCase enum value into
// naturally searchable words with no per-type label map required (the
// six named abbreviations above are the ONLY cases that genuinely need
// an alias — everything else already reads as plain English once split).
function humaniseEnum(s) {
  if (!s) return "";
  return String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function buildEntrySearchText(entry) {
  const parts = [entry.label, entry.sectionLabel, entry.typeText, entry.ownerText];
  if (entry.value != null && Number.isFinite(entry.value)) parts.push(String(Math.round(Math.abs(entry.value))));
  return normaliseSearchText(parts.filter(Boolean).join(" "));
}

function ownerText(owner) {
  return owner === "partner" ? "partner" : owner === "joint" ? "joint" : owner === "client" ? "client" : "";
}

export function buildSearchIndex(state, sectionLabels = {}) {
  const plan = state.plan;
  const sectionLabel = (id) => sectionLabels[id] ?? id;
  const entries = [];
  const push = (partial) => {
    const entry = { ownerText: "", typeText: "", value: null, rowId: null, dataAttrs: null, ...partial };
    entry.searchText = buildEntrySearchText(entry);
    entries.push(entry);
  };

  for (const r of state.cashflows?.income ?? []) {
    push({
      id: `income:${r.id}`, kind: "income", rowId: r.id,
      sectionId: "income", sectionLabel: sectionLabel("income"),
      label: r.label || INCOME_CATEGORY_LABELS[r.category] || "Income",
      typeText: humaniseEnum(r.category), ownerText: ownerText(r.owner),
      value: r.amount, dataAttrs: { kind: "income", cfid: r.id, field: "amount" },
    });
  }
  for (const r of state.cashflows?.expenses ?? []) {
    push({
      id: `expense:${r.id}`, kind: "expense", rowId: r.id,
      sectionId: "expenses", sectionLabel: sectionLabel("expenses"),
      label: r.label || EXPENSE_CATEGORY_LABELS[r.category] || "Expense",
      typeText: humaniseEnum(r.category),
      value: r.amount, dataAttrs: { kind: "expenses", cfid: r.id, field: "amount" },
    });
  }
  for (const sa of (plan.superAccounts ?? []).filter((s) => s.include !== false)) {
    push({
      id: `super:${sa.id}`, kind: "super", rowId: sa.id,
      sectionId: "super", sectionLabel: sectionLabel("super"),
      label: sa.name, ownerText: ownerText(sa.owner),
      value: sa.balance, dataAttrs: { said: sa.id, sfield: "balance" },
    });
  }
  for (const sc of state.cashflows?.superContributions ?? []) {
    push({
      id: `contribution:${sc.id}`, kind: "contribution", rowId: sc.id,
      sectionId: "super", sectionLabel: sectionLabel("super"),
      label: sc.label || "Contribution",
      typeText: humaniseEnum(sc.type), ownerText: ownerText(sc.owner),
      value: sc.amount, dataAttrs: { kind: "superContributions", cfid: sc.id, field: "amount" },
    });
  }
  for (const pn of plan.pensions ?? []) {
    push({
      id: `pension:${pn.id}`, kind: "pension", rowId: pn.id,
      sectionId: "pension", sectionLabel: sectionLabel("pension"),
      label: pn.name, typeText: humaniseEnum(pn.type), ownerText: ownerText(pn.owner),
      value: pn.drawdownOption === "fixed" ? pn.fixedAmount : null,
      dataAttrs: pn.drawdownOption === "fixed" ? { pid: pn.id, pfield: "fixedAmount" } : null,
    });
  }
  for (const a of (state.assets ?? []).filter((a) => a.class === "financial" && a.include !== false)) {
    push({
      id: `asset:${a.id}`, kind: "asset", rowId: a.id,
      sectionId: "financial-assets", sectionLabel: sectionLabel("financial-assets"),
      label: a.name, ownerText: ownerText(a.owner),
      value: a.balance, dataAttrs: { aid: a.id, field: "balance" },
    });
  }
  for (const a of (state.assets ?? []).filter((a) => a.class === "lifestyle" && a.include !== false)) {
    push({
      id: `lifestyle-asset:${a.id}`, kind: "lifestyle-asset", rowId: a.id,
      sectionId: "lifestyle-assets", sectionLabel: sectionLabel("lifestyle-assets"),
      label: a.name, ownerText: ownerText(a.owner),
      value: a.balance, dataAttrs: { aid: a.id, field: "balance" },
    });
  }
  for (const l of state.liabilities ?? []) {
    push({
      id: `liability:${l.id}`, kind: "liability", rowId: l.id,
      sectionId: "liabilities", sectionLabel: sectionLabel("liabilities"),
      label: l.name, typeText: humaniseEnum(l.type), ownerText: ownerText(l.owner),
      value: l.balance, dataAttrs: { lid: l.id, lfield: "balance" },
    });
  }
  for (const b of (state.bonds ?? []).filter((b) => b.include !== false)) {
    push({
      id: `bond:${b.id}`, kind: "bond", rowId: b.id,
      sectionId: "investment-cashflows", sectionLabel: sectionLabel("investment-cashflows"),
      label: b.name, typeText: humaniseEnum(b.type), ownerText: ownerText(b.owner),
      value: b.balance, dataAttrs: { bdid: b.id, bdfield: "balance" },
    });
  }
  // Properties — click-through only (no simple single "amount" field;
  // sale/purchase/duty logic makes this a "link out" case, the review
  // panel's own rule, docs/specs/35 Commit 2 — see docs/specs/38's own
  // build-log entry for why properties aren't a review-panel group).
  for (const p of state.properties ?? []) {
    push({
      id: `property:${p.id}`, kind: "property", rowId: p.id,
      sectionId: "property", sectionLabel: sectionLabel("property"),
      label: p.name, typeText: humaniseEnum(p.propertyType), ownerText: ownerText(p.owner),
      value: p.status === "planned" ? p.priceToday : p.currentValue,
    });
  }

  // Singletons already surfaced by the review panel (docs/specs/38
  // Commit 1) — searchable here too, same click-through target.
  const isCouple = isCoupleHousehold(plan.household) && !!plan.partner;
  push({
    id: "income-required", kind: "setting", sectionId: "settings", sectionLabel: sectionLabel("settings"),
    label: "Target retirement income",
  });
  push({
    id: "retirement-age-client", kind: "setting", sectionId: "setup", sectionLabel: sectionLabel("setup"),
    label: "Retirement age", ownerText: "client", value: plan.client?.retirementAge,
    dataAttrs: { planField: "clientRetirementAge" },
  });
  if (isCouple) {
    push({
      id: "retirement-age-partner", kind: "setting", sectionId: "setup", sectionLabel: sectionLabel("setup"),
      label: "Retirement age", ownerText: "partner", value: plan.partner?.retirementAge,
      dataAttrs: { planField: "partnerRetirementAge" },
    });
  }

  // Section-name fallback — every input section is findable by name
  // alone, even one with no row-level entry above yet (Children, Tax
  // details, Aged care, Goals, Settings, ...): "search over ... section
  // names" (the spec's own words) applies to the full 17, not just the
  // collections with row-level detail.
  for (const id of INPUT_SECTIONS) {
    push({ id: `section:${id}`, kind: "section", sectionId: id, sectionLabel: sectionLabel(id), label: sectionLabel(id) });
  }

  return entries;
}

// Result ranking: an exact label match leads, then a label prefix, then
// any label substring, then everything else (section/type/owner/value
// matches) — stable within each tier (index build order), so results
// don't visibly shuffle between keystrokes for no reason.
function rank(entry, q) {
  const label = normaliseSearchText(entry.label);
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  if (label.includes(q)) return 2;
  return 3;
}

export function searchInputs(index, term) {
  const q = normaliseSearchText(term);
  if (!q) return [];
  const terms = [q, ...(SEARCH_ALIASES[q] ?? []).map(normaliseSearchText)];
  return index
    .filter((entry) => terms.some((t) => entry.searchText.includes(t)))
    .map((entry) => ({ entry, score: Math.min(...terms.map((t) => (entry.searchText.includes(t) ? rank(entry, t) : 9))) }))
    .sort((a, b) => a.score - b.score)
    .map((r) => r.entry);
}
