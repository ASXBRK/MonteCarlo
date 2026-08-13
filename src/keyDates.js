// Key Dates — named date anchors (Tier 1.1). Pure, no DOM/engine.
//
// Every date field in the plan is a DateRef, never a bare integer age:
//   { kind: "anchor", anchorId }   — a built-in id or a plan.keyDates id
//   { kind: "age", age }           — an explicit age (the pre-Key-Dates behaviour)
//
// Built-in anchors are derived — never stored in plan state:
//   start                — plan year 0
//   end                  — the final plan year
//   retirement-client     — the plan year the client reaches plan.client.retirementAge
//   retirement-partner    — ditto for the partner (couple only)
//
// User-defined key dates live in plan.keyDates (see planState.js for
// their shape/clamping); this module only resolves references, so it
// deliberately imports nothing from planState.js.
//
// Engine semantics do not change in this phase: an anchor resolves to
// exactly the plan year an equivalent integer age resolved to before.
// Resolution happens ONCE, at the top of schedule building (or, for
// callers outside the engine — the UI, table/chart annotation — on
// demand against an already-built schedule) — never threaded into the
// month-by-month engine loop.

const RETIREMENT_CLIENT = "retirement-client";
const RETIREMENT_PARTNER = "retirement-partner";

function personLabel(person, fallback) {
  const n = `${person?.firstName ?? ""} ${person?.surname ?? ""}`.trim();
  return n || fallback;
}

// Is `anchorId` one of the four derived built-ins? (retirement-partner
// only counts when the household actually has a partner.)
export function isBuiltInAnchor(anchorId, plan) {
  if (anchorId === "start" || anchorId === "end" || anchorId === RETIREMENT_CLIENT) return true;
  if (anchorId === RETIREMENT_PARTNER) return !!plan?.partner;
  return false;
}

// Built-in OR a currently-defined user key date — used to validate a
// stored anchorId without needing to resolve it.
export function isValidAnchorId(anchorId, plan) {
  if (isBuiltInAnchor(anchorId, plan)) return true;
  return (plan?.keyDates ?? []).some((k) => k.id === anchorId);
}

function ownerCurrentAge(owner, plan) {
  return owner === "partner" && plan.partner ? plan.partner.currentAge : plan.client.currentAge;
}

// Resolve an (owner, age) pair against an already-built schedule:
// the plan year that owner is `age` in, clamped into the projection
// window (never throws — clamping out-of-window ages is exactly the
// "Out-of-window anchors clamp" rule, and applies identically to a
// plain {kind:"age"} reference that falls outside the plan).
function resolveOwnerAge(owner, age, plan, schedule) {
  const last = schedule.planYears - 1;
  const rawYear = (Number.isFinite(age) ? age : ownerCurrentAge(owner, plan)) - ownerCurrentAge(owner, plan);
  const planYear = Math.min(last, Math.max(0, rawYear));
  const outOfRange = planYear !== rawYear;
  return {
    planYear,
    age: ownerCurrentAge(owner, plan) + planYear,
    fyLabel: schedule.fyLabels[planYear],
    outOfRange,
  };
}

function resolveAnchor(anchorId, plan, schedule) {
  if (anchorId === "start") {
    return { planYear: 0, age: schedule.clientAges[0], fyLabel: schedule.fyLabels[0], outOfRange: false };
  }
  if (anchorId === "end") {
    const y = schedule.planYears - 1;
    return { planYear: y, age: schedule.clientAges[y], fyLabel: schedule.fyLabels[y], outOfRange: false };
  }
  if (anchorId === RETIREMENT_CLIENT) {
    return resolveOwnerAge("client", plan.client.retirementAge, plan, schedule);
  }
  if (anchorId === RETIREMENT_PARTNER && plan.partner) {
    return resolveOwnerAge("partner", plan.partner.retirementAge, plan, schedule);
  }
  const kd = (plan.keyDates ?? []).find((k) => k.id === anchorId);
  if (kd) {
    const basis = kd.basis === "partner" && plan.partner ? "partner" : "client";
    return resolveOwnerAge(basis, kd.age, plan, schedule);
  }
  // Unknown/dangling anchorId (e.g. a key date deleted without its
  // references being converted) — fall back to plan start rather than
  // throwing; the UI's deletion flow is what should normally prevent
  // this from ever being reached.
  return { planYear: 0, age: schedule.clientAges[0], fyLabel: schedule.fyLabels[0], outOfRange: false };
}

// resolveRef(ref, plan, schedule, ownerForAges) → { planYear, age, fyLabel, outOfRange }
//
// `ownerForAges` only matters for {kind:"age"} refs (an anchor already
// knows whose age it is): income rows resolve against their OWNER's
// age; every other row type resolves against the CLIENT's — exactly
// the pre-Key-Dates rule, preserved verbatim.
export function resolveRef(ref, plan, schedule, ownerForAges = "client") {
  if (ref?.kind === "anchor") return resolveAnchor(ref.anchorId, plan, schedule);
  return resolveOwnerAge(ownerForAges, ref?.age, plan, schedule);
}

// listAnchors(plan, schedule) → every available anchor (built-ins,
// always first and in a fixed order, then user key dates in the order
// they're defined), resolved and ready to render as select options or
// read-only Setup rows.
export function listAnchors(plan, schedule) {
  const anchors = [];
  const push = (id, label) => {
    const r = resolveAnchor(id, plan, schedule);
    anchors.push({
      id, label,
      planYear: r.planYear, age: r.age, fyLabel: r.fyLabel, outOfRange: r.outOfRange,
      display: `${label} — age ${r.age} (${r.fyLabel})`,
    });
  };
  push("start", "Start");
  push("end", "End");
  push(RETIREMENT_CLIENT, `Retirement — ${personLabel(plan.client, "Client")}`);
  if (plan.partner) push(RETIREMENT_PARTNER, `Retirement — ${personLabel(plan.partner, "Partner")}`);
  for (const kd of plan.keyDates ?? []) push(kd.id, kd.label);
  return anchors;
}
