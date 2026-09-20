// Browser: retirement-focused input ordering (docs/specs/41-
// dependency-ordering-density.md, Commit 6) — an ORDERING, not a
// filter: both the default and retirement-focused arrangements must
// present every one of router.js's own INPUT_SECTIONS, and switching
// between them must not lose the section currently being viewed or
// (where the sidebar is actually scrolled) its scroll position.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  launchBrowser, trackConsoleErrors, seedScenario, screenshotOnFailure, BASE_URL,
} from "./support.mjs";
import { fullyPopulatedState } from "./fixtures.mjs";
import { INPUT_SECTIONS, formatRoute } from "../../src/router.js";

async function goToInput(page, ids, section) {
  const hash = formatRoute({ page: "workspace", ...ids, area: "input", section });
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction(
    (sec) => { const el = document.querySelector(`[data-section="${CSS.escape(sec)}"]`); return el && !el.hidden; },
    section, { timeout: 5000 }
  );
  await page.waitForTimeout(20);
}

// Every INPUT_SECTIONS id currently has a [data-nav-section] sidebar
// button somewhere in the DOM — read directly rather than via any
// group structure, since the whole point is not hard-coding what the
// groups look like.
async function navSectionIds(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#sideNav [data-nav-area="input"][data-nav-section]'))
      .map((el) => el.dataset.navSection)
  );
}

test("browser: both input orderings present every section", { timeout: 20_000 }, async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleErrors = trackConsoleErrors(page);
  page.on("dialog", (dialog) => dialog.accept());
  const { route } = await seedScenario(page, fullyPopulatedState(), { scenarioName: "Commit 6 — orderings" });

  try {
    await page.goto(`${BASE_URL}/${route}`);
    await page.waitForSelector('[data-section="setup"]');

    // Default ordering (nothing selected yet — this scenario has never
    // been switched) — every group may start collapsed, so expand them
    // all first; nav items only render for expanded subgroups.
    async function expandEveryGroupAndCollectIds() {
      // Click every group header until none are left collapsed —
      // bounded, since there are only a handful of groups.
      for (let i = 0; i < 10; i++) {
        const collapsedHeader = page.locator('#sideNav [data-nav-group-area="input"][aria-expanded="false"]').first();
        if (await collapsedHeader.count() === 0) break;
        await collapsedHeader.click();
        await page.waitForTimeout(10);
      }
      return navSectionIds(page);
    }

    const defaultIds = await expandEveryGroupAndCollectIds();
    assert.deepEqual([...defaultIds].sort(), [...INPUT_SECTIONS].sort(), "default ordering is missing or duplicating a section");

    await page.selectOption("#inputOrderingSelect", "retirement");
    await page.waitForTimeout(20);
    const retirementIds = await expandEveryGroupAndCollectIds();
    assert.deepEqual([...retirementIds].sort(), [...INPUT_SECTIONS].sort(), "retirement ordering is missing or duplicating a section");

    // An ORDERING, not just a different set — "super" should actually
    // be earlier in the retirement arrangement than in the default one.
    assert.ok(retirementIds.indexOf("super") < defaultIds.indexOf("super"), "retirement ordering should move Super earlier, not just reshuffle randomly");
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }
  assert.equal(consoleErrors.length, 0, `console errors:\n${consoleErrors.join("\n")}`);
});

test("browser: switching input ordering preserves the active section and scroll position", { timeout: 20_000 }, async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const { clientId, scenarioId, route } = await seedScenario(page, fullyPopulatedState(), { scenarioName: "Commit 6 — persistence" });
  const ids = { clientId, scenarioId };

  try {
    await page.goto(`${BASE_URL}/${route}`);
    await page.waitForSelector('[data-section="setup"]');

    // On a section that exists in both orderings' own arrangements —
    // liabilities is never relocated by RETIREMENT_FOCUS_IDS.
    await goToInput(page, ids, "liabilities");

    // #sideNav has no overflow/max-height of its own (confirmed
    // directly — it's a plain flex column inside a sticky wrapper; the
    // PAGE scrolls, not the sidebar independently), so "scroll
    // position" here means the page's own scroll, not a container that
    // doesn't exist. Forced non-zero the same way the section content
    // isn't naturally tall enough to overflow in a fresh headless
    // viewport either.
    await page.evaluate(() => window.scrollTo(0, 250));

    await page.selectOption("#inputOrderingSelect", "retirement");
    await page.waitForTimeout(30);

    // State: still viewing Liabilities' own content, not reset to the
    // default landing section.
    const stillOnLiabilities = await page.evaluate(() => {
      const el = document.querySelector('[data-section="liabilities"]');
      return el && !el.hidden;
    });
    assert.ok(stillOnLiabilities, "switching ordering should not navigate away from the section currently being viewed");

    // Scroll position: an innerHTML swap of #sideNav (a child element)
    // never touches the page's own scroll — nothing to explicitly
    // restore, confirmed here rather than assumed.
    const scrollY = await page.evaluate(() => window.scrollY);
    assert.equal(scrollY, 250, "the page's own scroll position should be undisturbed by an ordering switch");

    // Persists like every other display field — part of the scenario
    // blob, survives a reload of the same scenario.
    await page.goto(`${BASE_URL}/${route}`);
    await page.waitForSelector('[data-section="setup"]');
    assert.equal(await page.locator("#inputOrderingSelect").inputValue(), "retirement", "the ordering choice should persist for this scenario after a reload");
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }
});
