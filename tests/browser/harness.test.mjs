// Commit 1's own tests (docs/specs/40-browser-test-harness.md) — the
// harness runs green against the current build, and a deliberately
// broken selector fails clearly rather than hanging (the whole point
// of a FAST suite: a selector waiting on Playwright's own 30s default
// timeout would make one bad test dominate the entire run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, trackConsoleErrors, seedScenario, screenshotOnFailure, BASE_URL } from "./support.mjs";
import { fullyPopulatedState } from "./fixtures.mjs";

test("harness: a seeded scenario loads with no console errors", async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const errors = trackConsoleErrors(page);
  try {
    const { route } = await seedScenario(page, fullyPopulatedState());
    await page.goto(`${BASE_URL}/${route}`);
    // [data-section="setup"] is a STATIC attribute already in
    // index.html (never generated per-render) — the one, existing
    // stable hook for "the Setup input section is the active one",
    // exactly what navigating to input/setup should produce.
    await page.locator('[data-section="setup"]').waitFor({ state: "visible", timeout: 10_000 });
    assert.deepEqual(errors, [], `unexpected console errors: ${errors.join("\n")}`);
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await browser.close();
  }
});

test("harness: a deliberately broken selector fails clearly, not by hanging", async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const { route } = await seedScenario(page, fullyPopulatedState());
    await page.goto(`${BASE_URL}/${route}`);
    const started = Date.now();
    await assert.rejects(
      () => page.locator('[data-section="this-selector-does-not-exist"]').waitFor({ state: "visible", timeout: 2_000 }),
      /Timeout/
    );
    const elapsed = Date.now() - started;
    // Failed within roughly its own stated timeout, not Playwright's
    // 30s default — proves this harness's own short-timeout
    // convention (every wait below explicitly bounds itself) actually
    // takes effect rather than silently falling back to the default.
    assert.ok(elapsed < 5_000, `broken selector took ${elapsed}ms to fail — expected well under 5000ms`);
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await browser.close();
  }
});
