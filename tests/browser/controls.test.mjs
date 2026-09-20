// Browser: every interactive control is alive (docs/specs/40-browser-
// test-harness.md, Commit 2) — the defect class from spec 39 Commit 8:
// a control that renders and does nothing. A destination dropdown
// showing the wrong type, a silent branch deletion, a permanently
// unreachable split button, and a completely dead "+ Add step" button
// all shipped hand-verified; every one is a control that either did
// nothing observable, or was never reachable to operate at all.
//
// The control list, the input-section list and the output-view list
// are all DERIVED — never hard-coded — so a control or a view added
// later is covered without anyone remembering to add it here:
//   - controls: queried structurally off the live DOM per area
//     (support.mjs's CONTROL_SELECTOR/sweepArea), not by data-*
//     attribute name (main.js uses ~20 different *-action names and
//     ~18 different *field names with no single convention linking
//     them — an attribute-based list would silently miss whatever
//     doesn't happen to match).
//   - sections/views: INPUT_SECTIONS and OUTPUT_VIEWS, router.js's own
//     registries (the same ones resolveRoute() itself validates
//     against), not a copy of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  launchBrowser, trackConsoleErrors, seedScenario, screenshotOnFailure, sweepArea, BASE_URL,
} from "./support.mjs";
import { fullyPopulatedState } from "./fixtures.mjs";
import { INPUT_SECTIONS, OUTPUT_VIEWS, formatRoute } from "../../src/router.js";

// The four Monte Carlo/lifecycle-comparison "Run" buttons directly
// reachable from a fully populated scenario (support.mjs's
// HEAVY_RUN_BUTTON_IDS — excluded from the generic sweep below because
// running one to completion is orders of magnitude too slow for this
// suite) get their own bounded check instead: click, confirm an
// immediate state change, then discard the page outright rather than
// waiting for or cancelling the run.
//
// Two further heavy buttons are NOT checked at all:
// retirementSustainableSpendRunBtn ("Solve") and retirementLeversRunBtn
// ("Show what would help") only become visible after Retirement's own
// Monte Carlo run has already completed (index.html: both containers
// start `hidden`, "computed on demand" once a run exists) — reaching
// that condition costs exactly the full simulation this exclusion
// exists to avoid. A documented gap, not a silent one.
const HEAVY_RUN_BUTTONS = [
  { id: "runMonteCarloBtn", view: "monte-carlo" },
  { id: "runMonteCarloTableBtn", view: "monte-carlo-table" },
  { id: "retirementMcRunBtn", view: "retirement-monte-carlo" },
  { id: "retirementCompareRunBtn", view: "retirement-lifecycle" },
];

// Setting location.hash directly (rather than clicking through the
// sidebar) exercises the exact same path a sidebar click does —
// main.js's own navigate() just sets location.hash too (see its own
// header) — while reaching every section regardless of which sidebar
// group happens to be collapsed.
async function goToArea(page, ids, area, section) {
  const hash = formatRoute({ page: "workspace", ...ids, area, section });
  await page.evaluate((h) => { location.hash = h; }, hash);
  if (area === "input") {
    await page.waitForFunction(
      (sec) => { const el = document.querySelector(`[data-section="${CSS.escape(sec)}"]`); return el && !el.hidden; },
      section, { timeout: 5000 }
    );
  } else {
    await page.waitForFunction(
      () => { const el = document.querySelector('[data-section="__output__"]'); return el && !el.hidden; },
      null, { timeout: 5000 }
    );
  }
  // A brief settle for any render triggered by the navigation itself
  // (chart mount, review-panel rebuild) before the sweep takes its
  // first mutation-count snapshot.
  await page.waitForTimeout(20);
}

// Output views share one physical mount (#outputCanvas, index.html) —
// header controls (period selector, real/nominal toggle, Export PNG,
// the review panel) are the SAME DOM nodes across every view, not
// rebuilt per view. Sweeping the whole canvas on every one of the 42
// views would retest that shared chrome 42 times for zero extra
// coverage; instead the shared chrome is swept once (on the first
// output view visited) and every view after that is scoped to
// whichever .view-canvas child is currently the visible one —
// determined by asking the DOM which child isn't hidden, not by
// guessing the id from the view's route name (the two don't follow a
// single naming convention either, e.g. "age-pension" vs
// "viewAgePensionChart"/"viewAgePensionTable" depending on form).
async function outputSweepContainer(page, sharedChromeAlreadySwept) {
  if (!sharedChromeAlreadySwept) return "#outputCanvas";
  return page.evaluate(() => {
    const canvas = document.querySelector(".view-canvas");
    const visible = canvas && Array.from(canvas.children).find((el) => !el.hidden);
    return visible?.id ? `#${visible.id}` : "#outputCanvas";
  });
}

test("browser: every interactive control across every input section and output view is alive", { timeout: 60_000 }, async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleErrors = trackConsoleErrors(page);
  // Some remove actions confirm via window.confirm() (e.g. the gifts
  // list, settingsPanel's click handler) — a real native dialog blocks
  // page JS until Node resolves it. Accepting lets the control's real
  // effect run, which is what "alive" is asking about here.
  page.on("dialog", (dialog) => dialog.accept());

  const { clientId, scenarioId, route } = await seedScenario(page, fullyPopulatedState(), {
    scenarioName: "Commit 2 — every control",
  });
  const ids = { clientId, scenarioId };

  const allFailures = [];
  let totalTested = 0;

  try {
    await page.goto(`${BASE_URL}/${route}`);
    await page.waitForSelector('[data-section="setup"]');

    for (const section of INPUT_SECTIONS) {
      await goToArea(page, ids, "input", section);
      const result = await sweepArea(page, `[data-section="${section}"]`);
      totalTested += result.tested;
      for (const f of result.failures) allFailures.push({ area: `input/${section}`, ...f });
    }

    let sharedOutputChromeSwept = false;
    for (const view of OUTPUT_VIEWS) {
      await goToArea(page, ids, "output", view);
      const container = await outputSweepContainer(page, sharedOutputChromeSwept);
      sharedOutputChromeSwept = true;
      const result = await sweepArea(page, container);
      totalTested += result.tested;
      for (const f of result.failures) allFailures.push({ area: `output/${view}`, ...f });
    }
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }

  assert.equal(consoleErrors.length, 0, `console errors during control sweep:\n${consoleErrors.join("\n")}`);
  assert.ok(totalTested > 0, "the sweep found no controls at all — the derivation itself is broken");
  assert.deepEqual(
    allFailures, [],
    `${allFailures.length} dead/silent control(s):\n` +
      allFailures.map((f) => `  [${f.area}] ${f.descriptor} — ${f.reason}`).join("\n")
  );
});

// Proves the mechanism above actually fails when a control IS dead,
// rather than passing by construction — an isolated synthetic control
// with no listener at all, standing in for spec 39 Commit 8's real
// "+ Add step" button (which had exactly this property: it rendered
// and its click produced nothing).
test("browser: control sweep fails on a deliberately disconnected control", async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const { route } = await seedScenario(page, fullyPopulatedState());

  try {
    await page.goto(`${BASE_URL}/${route}`);
    await page.waitForSelector('[data-section="setup"]');

    await page.evaluate(() => {
      const wrap = document.createElement("div");
      wrap.id = "bt-sabotage-wrap";
      const dead = document.createElement("button");
      dead.type = "button";
      dead.textContent = "Deliberately dead";
      wrap.appendChild(dead);
      document.body.appendChild(wrap);
    });

    const result = await sweepArea(page, "#bt-sabotage-wrap", { maxControls: 10, waitMs: 60 });
    assert.equal(result.tested, 0, "the disconnected control should not have registered as tested");
    assert.equal(result.failures.length, 1, `expected exactly one failure, got: ${JSON.stringify(result.failures)}`);
    assert.match(result.failures[0].reason, /no DOM mutation, no state change/);
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }
});

// Clicks one button by id and reports whether ANYTHING observable
// happened within waitMs — the same signal sweepArea uses (scoped to
// #outputCanvas, where every one of these buttons and their own status
// text live, not document-wide — see support.mjs's sweepArea for why
// document-wide false-positives on a page this busy), but as a one-off
// so the caller can bound and discard the page itself rather than let
// sweepArea's own worklist loop keep going.
async function clickAndCheckChange(page, buttonId, waitMs = 250) {
  return page.evaluate(
    async ({ buttonId, waitMs }) => {
      const el = document.getElementById(buttonId);
      if (!el) return { found: false, changed: false };
      const canvas = document.querySelector("#outputCanvas");
      let mutationCount = 0;
      const observer = new MutationObserver((records) => { mutationCount += records.length; });
      observer.observe(canvas, { childList: true, subtree: true, attributes: true, characterData: true });
      const beforeStorage = JSON.stringify(localStorage);
      el.click();
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const changed = mutationCount > 0 || JSON.stringify(localStorage) !== beforeStorage;
      observer.disconnect();
      return { found: true, changed };
    },
    { buttonId, waitMs }
  );
}

test("browser: heavy-computation Run buttons are wired (bounded, never run to completion)", async (t) => {
  for (const { id, view } of HEAVY_RUN_BUTTONS) {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    const { clientId, scenarioId, route } = await seedScenario(page, fullyPopulatedState());
    try {
      await page.goto(`${BASE_URL}/${route}`);
      await page.waitForSelector('[data-section="setup"]');
      await goToArea(page, { clientId, scenarioId }, "output", view);
      const result = await clickAndCheckChange(page, id);
      assert.ok(result.found, `#${id} not found on output/${view}`);
      assert.ok(result.changed, `#${id} produced no observable change within the bounded wait`);
    } catch (err) {
      await screenshotOnFailure(page, `${t.name}-${id}`);
      throw err;
    } finally {
      // Closing the page/browser tears down any Worker the click just
      // started, regardless of whether the app's own Cancel button was
      // ever reached — the whole point of never letting this run long.
      await page.close();
      await browser.close();
    }
  }
});

// #exportBtn (support.mjs's DOWNLOAD_TRIGGER_IDS, excluded from the
// generic sweep above) never touches the DOM or localStorage — its
// whole job is a Blob + anchor download, so "alive" here means a real
// download fires, checked the way Playwright itself expects a download
// to be checked: page.waitForEvent('download'), not the mutation/
// storage signal sweepArea uses everywhere else.
//
// Checked against "tax", a table-only output subject (router.js's
// OUTPUT_SUBJECT_FORMS: tax has no chart form at all), not "projection"
// — main.js's own exportChartPNG guards on `typeof Plotly === "undefined"`
// and returns without downloading anything when the CDN is unreachable
// (chart.js's documented "CDN may be blocked" case, CLAUDE.md's
// architecture map — confirmed directly as the reason a PNG export
// attempt here produced no download at all). The CSV path a table-only
// subject takes has no such dependency.
test("browser: the Export button downloads something", async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const { clientId, scenarioId, route } = await seedScenario(page, fullyPopulatedState());
  try {
    await page.goto(`${BASE_URL}/${route}`);
    await page.waitForSelector('[data-section="setup"]');
    await goToArea(page, { clientId, scenarioId }, "output", "tax");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 5000 }),
      page.click("#exportBtn"),
    ]);
    assert.ok(download.suggestedFilename(), "Export produced a download with no filename");
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }
});
