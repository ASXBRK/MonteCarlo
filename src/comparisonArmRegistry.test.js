// docs/specs/37-review-remediation.md, Commit 6 — "Then close the
// class. This has now occurred four times: a gift arm in spec 21b, a
// deposit solver, the aged care arms, and these two levers... Register
// arms so a new one cannot be added without appearing in the test."
//
// Every comparison arm, what-if shock, and retirement lever in this
// application claims to move the projection away from its own baseline
// when applied. Four times now, one has silently done nothing instead,
// each time discovered only by a later, unrelated probe rather than by
// a test built for the purpose. This file is that test's home: one
// entry per arm, naming the file and test that proves — with a real
// projectPlan()/runMonteCarlo() run, not an estimate — that the arm
// genuinely differs from its own baseline.
//
// Two different guarantees, matched to what each kind of arm actually
// is in this codebase:
//   - Levers (retirementLevers.js's own LEVERS) and what-if shocks
//     (whatIf.js's own SHOCK_APPLIERS, via registeredShockKinds()) are
//     REAL, ENUMERABLE runtime registries — this file diffs its own
//     REGISTERED_LEVERS/REGISTERED_SHOCKS lists against them, so a
//     lever or shock kind added to the app without a matching entry
//     HERE fails this test immediately, by construction.
//   - Focus/comparison arms (age pension strategy, aged care planning,
//     salary sacrifice, FHSSS, surplus allocation, recontribution,
//     debt payoff, debt recycling, glide-vs-static lifecycle, aged care
//     accommodation) have no such central dispatch table — each is its
//     own module, imported ad hoc by main.js. For these, the guarantee
//     is a completeness check: every entry below names a real test file
//     and test title that must both exist, so an arm's own bite-proving
//     test can't be silently deleted or renamed without this failing —
//     the closest enforceable equivalent to "must appear in the test"
//     without inventing a dispatch mechanism this app doesn't otherwise
//     have (CLAUDE.md's own anti-overengineering convention).
//
// Cross-referenced against docs/reference/adversarial-review-2026-09/
// README.md section 8's own "Comparison arms that do change the
// projection" second-pass list — the review's own confirmation that,
// as of this commit, every arm below genuinely bites.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LEVERS } from "./retirementLevers.js";
import { registeredShockKinds } from "./whatIf.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// --- Levers (retirementLevers.js's own LEVERS registry) --------------------
const REGISTERED_LEVERS = ["contributeMore", "retireLater", "spendLess", "takeMoreRisk"];
const LEVER_BITE_TEST = {
  contributeMore: { file: "retirementLevers.test.js", title: "when it converges, the SOLVED value's own re-run genuinely reaches at/near the threshold" },
  retireLater: { file: "retirementLevers.test.js", title: "genuinely bites — pushing a retirement-anchored salary out changes the projection" },
  spendLess: { file: "retirementLevers.test.js", title: "genuinely bites — a lower Income Required target changes the expenditure pension's own withdrawals" },
  takeMoreRisk: { file: "retirementLevers.test.js", title: "scans RISK_LADDER from least to most aggressive and returns a distribution when it converges" },
};

// --- What-if shocks (whatIf.js's own SHOCK_APPLIERS registry) --------------
const REGISTERED_SHOCKS = ["rateShock", "revertRateShock", "incomeGap", "expenseShock"];
const SHOCK_BITE_TEST = {
  rateShock: { file: "whatIf.test.js", title: "a variable loan's interest changes from month one" },
  revertRateShock: { file: "whatIf.test.js", title: "a revert-rate shock leaves the fixed period untouched and leaves variable loans completely alone" },
  incomeGap: { file: "whatIf.test.js", title: "a gap large enough to break affordability produces unfunded cashflow the base run never sees" },
  expenseShock: { file: "whatIf.test.js", title: "a large enough expense increase produces unfunded cashflow the base run never sees" },
};
// Market crash timing (whatIfCrash.js) is deliberately its own thing —
// three ages against the SAME base, not a registered shock kind (see
// that module's own header) — registered here directly rather than
// through SHOCK_APPLIERS.
const CRASH_BITE_TEST = { file: "whatIfCrash.test.js", title: "runs the SAME shock at three ages against the SAME base — identical magnitude, different outcomes" };

// --- Focus / comparison arms (no central dispatch table) -------------------
const COMPARISON_ARMS = {
  "agePensionStrategy.gift": { file: "focusAgePensionStrategy.test.js", title: "the gift arm's net worth is always lower than the current plan's — the real leak the spec calls out (gifting is not free)" },
  "agePensionStrategy.workIncome": { file: "focusAgePensionStrategy.test.js", title: "a work-income arm's entitlement never exceeds the current plan's — extra income can only reduce or hold it, even net of the Work Bonus exemption" },
  "agedCarePlanning.gift": { file: "focusAgedCarePlanning.test.js", title: "a pre-entry gift produces a second arm with its own total cost of care and estate position" },
  "agedCareAccommodation.radVsDap": { file: "focusAgedCareAccommodation.test.js", title: "a bigger RAD means a smaller ongoing DAP cost but a larger lump sum drawn from assets" },
  "salarySacrifice.withVsWithout": { file: "focusSalarySacrifice.test.js", title: "the no-sacrifice arm equals the projection with the contribution deleted" },
  "fhsss.insideVsOutside": { file: "focusFhsss.test.js", title: "the difference is exactly insideValue minus outsideValue" },
  "surplusAllocation.singleDestination": { file: "focusSurplusAllocation.test.js", title: "sends 100% of surplus to the nominated asset regardless of the configured periods" },
  "deathBenefits.recontribution": { file: "focusDeathBenefits.test.js", title: "an adult child costs strictly more tax than a spouse, on the identical underlying balance" },
  "debtPayoff.counterfactual": { file: "focusDebtPayoff.test.js", title: "the counterfactual balance series diverges (no-extras stays higher) once extras are configured" },
  "debtRecycling.withVsWithout": { file: "focusDebtRecycling.test.js", title: "total debt stays materially flat WITH recycling, but declines normally WITHOUT it — the whole point of the strategy, visible in the series" },
  "lifecycle.glideVsStatic": { file: "retirementLifecycleComparison.test.js", title: "runs both arms through the real projectPlan on independent clones — same starting facts, only the allocation differs" },
};

function testFileContains(fileName, title) {
  const path = join(SRC_DIR, fileName);
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").includes(title);
}

describe("Comparison arm registry (docs/specs/37-review-remediation.md, Commit 6)", () => {
  it("every registered lever (LEVERS) has a matching bite-test entry here — nothing extra, nothing missing", () => {
    expect(new Set(REGISTERED_LEVERS)).toEqual(new Set(LEVERS));
    expect(Object.keys(LEVER_BITE_TEST).sort()).toEqual([...REGISTERED_LEVERS].sort());
  });

  it("every registered what-if shock kind (SHOCK_APPLIERS) has a matching bite-test entry here", () => {
    expect(new Set(REGISTERED_SHOCKS)).toEqual(new Set(registeredShockKinds()));
    expect(Object.keys(SHOCK_BITE_TEST).sort()).toEqual([...REGISTERED_SHOCKS].sort());
  });

  it("every lever's own named bite-test genuinely exists in its own file", () => {
    for (const [lever, { file, title }] of Object.entries(LEVER_BITE_TEST)) {
      expect(testFileContains(file, title), `${lever}: "${title}" not found in ${file}`).toBe(true);
    }
  });

  it("every what-if shock's own named bite-test genuinely exists in its own file", () => {
    for (const [shock, { file, title }] of Object.entries(SHOCK_BITE_TEST)) {
      expect(testFileContains(file, title), `${shock}: "${title}" not found in ${file}`).toBe(true);
    }
    expect(testFileContains(CRASH_BITE_TEST.file, CRASH_BITE_TEST.title)).toBe(true);
  });

  it("every registered comparison arm's own named bite-test genuinely exists in its own file", () => {
    for (const [arm, { file, title }] of Object.entries(COMPARISON_ARMS)) {
      expect(testFileContains(file, title), `${arm}: "${title}" not found in ${file}`).toBe(true);
    }
  });

  it("the registry itself is non-empty and covers every kind of arm named in the spec — a comparison arm, a what-if shock, and a lever", () => {
    expect(Object.keys(COMPARISON_ARMS).length).toBeGreaterThan(0);
    expect(Object.keys(SHOCK_BITE_TEST).length).toBeGreaterThan(0);
    expect(Object.keys(LEVER_BITE_TEST).length).toBeGreaterThan(0);
  });
});
