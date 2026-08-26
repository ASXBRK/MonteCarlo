// UI reachability sweep (spec 27, Commit 5) — "an engine figure nobody
// can enter or see is not a feature." A STRUCTURAL test, not a UI test
// (main.js touches the DOM at module scope — `document.getElementById`
// calls run the instant it's imported — so it can't be imported under
// plain Node/vitest the way every pure module in this project is;
// there is no jsdom dependency in this project by design, see CLAUDE.md's
// "Pure modules never import DOM/Plotly" convention, and introducing
// one just for this test would be a bigger, riskier change than the
// gap it's meant to guard). Instead this reads main.js's own SOURCE
// TEXT and router.js's real, already-tested INPUT_SECTIONS/OUTPUT_VIEWS
// registries — the exact same registries whose own omission (bonds,
// focus-debt-recycling, focus-education-funding never listed in
// OUTPUT_VIEWS) was the actual bug this whole spec exists to close
// (see router.js's own comment on that finding).
//
// For every repeatable collection this engine models, this asserts:
//   1. it has a genuine path into the input side (a real router.js
//      INPUT_SECTIONS id, or a documented exception — see "adjustments"
//      below — plus a text marker proving an add/mutate affordance
//      actually exists in main.js, not just declared in planState.js);
//   2. it has a genuine path into the output side (a real router.js
//      OUTPUT_VIEWS id, plus a text marker proving it's actually read
//      there).
// A collection can be fully built in every OTHER registry (sidebar
// nav, view mounts, the CSV dispatcher) and still be completely
// unreachable if missing from router.js's own canonical lists — that
// is precisely what happened to bonds/focus-debt-recycling/focus-
// education-funding, and why the router.js cross-checks below (not
// just "does the text exist somewhere") are the assertions that
// actually matter here.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { INPUT_SECTIONS, OUTPUT_VIEWS } from "./router.js";

const mainSrc = readFileSync(new URL("./main.js", import.meta.url), "utf8");

const REGISTRY = [
  { name: "assets", inputSection: "financial-assets", outputView: "assets",
    reads: ["state.assets"], writes: ["addAssetBtn.addEventListener"] },
  { name: "properties", inputSection: "property", outputView: "assets",
    reads: ["state.properties"], writes: ['data-prop-action="add"'] },
  { name: "liabilities", inputSection: "liabilities", outputView: "liabilities",
    reads: ["state.liabilities"], writes: ['data-liab-action="add"'] },
  { name: "superAccounts", inputSection: "super", outputView: "super",
    reads: ["state.plan.superAccounts"], writes: ['data-super-action="add-account"'] },
  { name: "pensions", inputSection: "pension", outputView: "pension",
    reads: ["state.plan.pensions"], writes: ['data-pension-action="add"'] },
  { name: "definedBenefits", inputSection: "pension", outputView: "pension",
    reads: ["state.plan.definedBenefits"], writes: ['data-defined-benefit-action="add"'] },
  { name: "bonds", inputSection: "investment-cashflows", outputView: "bonds",
    reads: ["state.bonds"], writes: ['data-bond-action="add"'] },
  { name: "goals", inputSection: "goals", outputView: "cashflow",
    reads: ["state.goals"], writes: ['data-goal-action="add"'] },
  { name: "children", inputSection: "children", outputView: "cashflow",
    reads: ["state.plan.children"], writes: ['data-child-action="add"'] },
  { name: "gifts", inputSection: "settings", outputView: "cashflow",
    reads: ['label: "Gifts"'], writes: ['data-gift-action="add"'] },
  // Super rollovers (spec 26 engine; UI: spec 27 Commit 1) — the output
  // side of THIS was itself a gap this same sweep found and fixed in
  // the same commit as this test (superDetailRows had no rollover
  // rows at all, despite the engine computing rolloverIn/Out/Tax since
  // Commit 1) — the "Rollovers in"/"Rollovers out" markers are that
  // fix, not a pre-existing feature.
  { name: "superRollovers", inputSection: "super", outputView: "super",
    reads: ["Rollovers in", "Rollovers out"], writes: ['data-kind="superRollovers"'] },
  // Adjustments (spec 18) — a deliberate, already-shipped exception to
  // the "own INPUT_NAV section" shape: there is no "adjustments" id in
  // router.js's INPUT_SECTIONS at all — it's reached via a modal opened
  // from the Cashflow OUTPUT view's own "Adjustments" button instead.
  // Checked from its actual home rather than forcing a false input-
  // section claim.
  { name: "adjustments", inputSection: null, outputView: "cashflow",
    reads: ["state.plan.adjustments"], writes: ["adjustmentsAddBtn.addEventListener"] },
];

describe("UI reachability sweep (spec 27 Commit 5)", () => {
  for (const c of REGISTRY) {
    describe(c.name, () => {
      it("has a real router.js input path (or a documented exception)", () => {
        if (c.inputSection === null) return; // see registry comment on "adjustments"
        expect(INPUT_SECTIONS).toContain(c.inputSection);
      });
      it("has a real router.js output path", () => {
        expect(OUTPUT_VIEWS).toContain(c.outputView);
      });
      it("is genuinely read somewhere in main.js", () => {
        for (const marker of c.reads) expect(mainSrc).toContain(marker);
      });
      it("has a genuine add/mutate affordance in main.js", () => {
        for (const marker of c.writes) expect(mainSrc).toContain(marker);
      });
    });
  }

  // Employers (spec 23, Commit 1) — a KNOWN, currently-real gap this
  // exact sweep surfaced: plan.employers exists in planState.js
  // (createEmployer, resolveEmployerAssignment, per-employer FBT caps)
  // but has ZERO reachable UI anywhere in main.js — no input section
  // renders it, no output view reads it, no income row exposes an
  // employerId control to attach one. This pre-dates spec 27 (spec 23)
  // and sits outside both its audit window (specs 21b-26) and its own
  // five-commit scope, so it is disclosed here rather than silently
  // fixed mid-"test infrastructure" commit. it.fails keeps this
  // documented and the suite green until it's actually built: if a
  // future commit adds the missing UI, this assertion starts PASSING,
  // which makes it.fails itself fail — forcing this line to be updated
  // to a real assertion instead of silently going stale.
  it.fails("employers: currently has NO reachable input or output UI (spec 23 gap, out of scope here)", () => {
    expect(mainSrc).toContain("createEmployer");
  });
});
