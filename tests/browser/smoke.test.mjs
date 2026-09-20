// Browser: smoke across every view (docs/specs/40-browser-test-harness.md,
// Commit 4) — cheap breadth, to catch the "renders blank" and "throws
// on empty data" class. The blank-chart bug in an earlier spec was 19
// chart containers built via innerHTML with no CSS height; `.chart-mount`
// (styles.css) is the fix — every Plotly mount other than #chart itself
// carries it, and gets its height from the class alone, before Plotly
// ever touches it. This is the test that would have caught a chart
// container shipped without it, and would catch a regression the same
// way.
//
// The view list is DERIVED from INPUT_SECTIONS/OUTPUT_VIEWS
// (router.js's own registries), never copied, so a view added later is
// covered the day it lands. All three fixtures — fully populated,
// nearly empty, and a single data point — are already built in
// fixtures.mjs (Commit 2's own fixtures, reused rather than duplicated).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  launchBrowser, trackConsoleErrors, seedScenario, screenshotOnFailure, BASE_URL,
} from "./support.mjs";
import { fullyPopulatedState, nearlyEmptyState, singleDataPointState } from "./fixtures.mjs";
import { INPUT_SECTIONS, OUTPUT_VIEWS, formatRoute } from "../../src/router.js";

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
  await page.waitForTimeout(15);
}

// Every `.chart-mount`/`#chart` element currently visible has a real
// rendered height — checked against the DOM generally (not scoped to
// one container), since a blank chart is exactly as much a bug
// wherever it sits, and there's no cheaper way to be sure none was
// missed than looking at all of them each time.
async function chartMountFailures(page, areaLabel) {
  return page.evaluate((areaLabel) => {
    const els = Array.from(document.querySelectorAll(".chart-mount, #chart")).filter((el) => {
      if (el.hidden || el.closest("[hidden]")) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    return els
      .filter((el) => el.getBoundingClientRect().height === 0)
      .map((el) => ({ area: areaLabel, chartId: el.id || "(no id)", reason: "chart mount has zero rendered height" }));
  }, areaLabel);
}

const FIXTURES = [
  ["fully populated", fullyPopulatedState],
  ["nearly empty", nearlyEmptyState],
  ["single data point", singleDataPointState],
];

for (const [fixtureName, buildState] of FIXTURES) {
  test(`browser: smoke — every input section and output view renders (${fixtureName} fixture)`, { timeout: 30_000 }, async (t) => {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    const consoleErrors = trackConsoleErrors(page);
    page.on("dialog", (dialog) => dialog.accept());

    const { clientId, scenarioId, route } = await seedScenario(page, buildState(), {
      scenarioName: `Commit 4 smoke — ${fixtureName}`,
    });
    const ids = { clientId, scenarioId };
    const chartFailures = [];

    try {
      await page.goto(`${BASE_URL}/${route}`);
      await page.waitForSelector('[data-section="setup"]');

      for (const section of INPUT_SECTIONS) {
        await goToArea(page, ids, "input", section);
        chartFailures.push(...await chartMountFailures(page, `input/${section}`));
      }
      for (const view of OUTPUT_VIEWS) {
        await goToArea(page, ids, "output", view);
        chartFailures.push(...await chartMountFailures(page, `output/${view}`));
      }
    } catch (err) {
      await screenshotOnFailure(page, t.name);
      throw err;
    } finally {
      await page.close();
      await browser.close();
    }

    assert.equal(consoleErrors.length, 0, `console errors across the ${fixtureName} fixture:\n${consoleErrors.join("\n")}`);
    assert.deepEqual(
      chartFailures, [],
      `${chartFailures.length} blank chart mount(s) (${fixtureName} fixture):\n` +
        chartFailures.map((f) => `  [${f.area}] #${f.chartId} — ${f.reason}`).join("\n")
    );
  });
}

// Proves the height check above actually fails on a genuinely blank
// chart mount, rather than passing by construction — a synthetic
// `.chart-mount` div with height forced to 0, standing in for the
// historical bug (a chart container built via innerHTML with no CSS
// height at all).
test("browser: smoke check fails on a deliberately blank chart mount", async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const { route } = await seedScenario(page, fullyPopulatedState());

  try {
    await page.goto(`${BASE_URL}/${route}`);
    await page.waitForSelector('[data-section="setup"]');

    await page.evaluate(() => {
      const el = document.createElement("div");
      el.id = "bt-fake-blank-chart";
      el.className = "chart-mount";
      el.style.height = "0px"; // the historical bug: no real height at all
      document.body.appendChild(el);
    });

    const failures = await chartMountFailures(page, "sabotage");
    assert.equal(failures.length, 1, `expected exactly one blank-chart failure, got: ${JSON.stringify(failures)}`);
    assert.equal(failures[0].chartId, "bt-fake-blank-chart");
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }
});
