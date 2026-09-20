// Browser: displayed totals reconcile to the ledger (docs/specs/40-
// browser-test-harness.md, Commit 3) — the defect class from the
// adversarial review (spec 37): "Total assets" showed $51,582 against
// net assets of $746,846 on adjacent rows, three separate re-
// derivations of figures the engine already published. Spec 37 Commit
// 4 added a unit-level reconciliation test (src/displayReconciliation.
// test.js); this is the same assertion against what actually RENDERS,
// which is where the three original drifts lived.
//
// The "ledger" is projectPlan() — the exact function main.js itself
// assigns to its own `projection` variable (see main.js's own
// `projection = projectPlan(state)`) — called here directly on the
// SAME seeded state, never a second, hand-maintained computation. Cell
// text is compared against fmtLedgerCell()/csvMoney(), the same pure
// formatters the table and CSV export themselves call
// (src/moneyDisplay.js) — so this test's "expected" string is produced
// by the exact code the app runs, not a re-implementation of its
// rounding/sign rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  launchBrowser, trackConsoleErrors, seedScenario, screenshotOnFailure, BASE_URL,
} from "./support.mjs";
import { fullyPopulatedState } from "./fixtures.mjs";
import { hydrate } from "../../src/planState.js";
import { projectPlan } from "../../src/deterministic.js";
import { fmtLedgerCell, csvMoney } from "../../src/moneyDisplay.js";
import { PROFILES } from "../../src/profiles.js";
import { formatRoute } from "../../src/router.js";

async function goToOutput(page, ids, section, form) {
  const hash = formatRoute({ page: "workspace", ...ids, area: "output", section, form });
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction(
    () => { const el = document.querySelector('[data-section="__output__"]'); return el && !el.hidden; },
    null, { timeout: 5000 }
  );
  await page.waitForTimeout(20);
}

// Reads every rendered year-column for one labelled row of a
// renderTransposed() table (main.js) — <th class="tl-label"> for the
// row, <th class="tl-year"><span class="tl-age"> for each column's age
// (the same age projectPlan()'s own out.schedule.clientAges[y] carries,
// so a column maps back to a year index without guessing which years
// the period selector currently shows).
async function readLedgerRow(page, tableSelector, rowLabel) {
  return page.evaluate(
    ({ tableSelector, rowLabel }) => {
      const table = document.querySelector(tableSelector);
      if (!table) return null;
      const ages = Array.from(table.querySelectorAll("thead th.tl-year"))
        .map((th) => th.querySelector(".tl-age")?.textContent.trim());
      const row = Array.from(table.querySelectorAll("tbody tr"))
        .find((tr) => tr.querySelector("th.tl-label")?.textContent.trim() === rowLabel);
      if (!row) return null;
      const cells = Array.from(row.querySelectorAll("td.tl-num")).map((td) => td.textContent.trim());
      return ages.map((age, i) => ({ age: Number(age), text: cells[i] }));
    },
    { tableSelector, rowLabel }
  );
}

// Asserts one rendered row (already read via readLedgerRow) matches
// fmtLedgerCell(expected(y)) for every column, mapping each column's
// displayed age back to a year index via the SAME clientAges array
// projectPlan() itself produced. Returns the list of any mismatches
// instead of asserting directly, so the drift test below can reuse it
// against a deliberately sabotaged render.
function checkLedgerRow(cells, clientAges, expected, rowLabel) {
  const mismatches = [];
  for (const { age, text } of cells) {
    const y = clientAges.indexOf(age);
    if (y === -1) continue; // a couple's partner-age column etc. — not this array's own age sequence
    const want = fmtLedgerCell(expected(y));
    if (text !== want) mismatches.push({ rowLabel, age, y, rendered: text, expected: want });
  }
  return mismatches;
}

test("browser: displayed totals reconcile to the ledger", { timeout: 30_000 }, async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleErrors = trackConsoleErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  const state = fullyPopulatedState();
  const out = projectPlan(state);
  const clientAges = out.schedule.clientAges;
  // Sanity per displayReconciliation.test.js's own convention: a
  // reconciliation over a scenario that doesn't actually exercise every
  // ingredient would trivially "pass" on zeroed-out fields.
  assert.ok(out.yearly.some((r) => r.pensionClosing > 0), "fixture has no pension balance to reconcile");
  assert.ok(out.yearly.some((r) => r.bondsClosing > 0), "fixture has no bond balance to reconcile");
  assert.ok(out.yearly.some((r) => r.propertyClosing > 0), "fixture has no property balance to reconcile");
  assert.ok(out.yearly.some((r) => (r.agePensionDetail?.entitlement ?? 0) > 0), "fixture draws no age pension to reconcile");
  assert.ok(out.yearly.some((r) => r.liabilitiesClosing > 0), "fixture has no liability to reconcile");

  const { clientId, scenarioId, route } = await seedScenario(page, state, { scenarioName: "Commit 3 — reconciliation" });
  const ids = { clientId, scenarioId };

  const mismatches = [];

  try {
    await page.goto(`${BASE_URL}/${route}`);
    await page.waitForSelector('[data-section="setup"]');

    // Key figures (output/net-worth, table form) — the exact surface
    // spec 37's "Total assets" vs "net assets" drift lived on.
    await goToOutput(page, ids, "net-worth", "table");
    for (const [rowLabel, fieldFn] of [
      ["Total assets", (y) => out.yearly[y].totalAssets],
      ["NET ASSETS", (y) => out.yearly[y].netAssets],
      ["Super balance", (y) => out.yearly[y].superClosing + out.yearly[y].pensionClosing],
      ["Working cash balance", (y) => out.yearly[y].wcaClosing],
    ]) {
      const cells = await readLedgerRow(page, "#keyFiguresTable table.tl", rowLabel);
      assert.ok(cells && cells.length > 0, `Key figures row "${rowLabel}" not found or has no columns`);
      mismatches.push(...checkLedgerRow(cells, clientAges, fieldFn, `Key figures / ${rowLabel}`));
    }

    // Assets table's own totals row (output/assets, table form) —
    // "Closing balance" (Combined group) and "Total" (per-asset group)
    // both reconcile to the same ledger field, by construction
    // (buildAssetsGroups, main.js) — checked as a second, independent
    // display surface.
    await goToOutput(page, ids, "assets", "table");
    const assetsCells = await readLedgerRow(page, "#assetsTable table.tl", "Closing balance");
    assert.ok(assetsCells && assetsCells.length > 0, `Assets table row "Closing balance" not found`);
    mismatches.push(...checkLedgerRow(assetsCells, clientAges, (y) => out.yearly[y].closingBalance, "Assets / Closing balance"));

    // CSV export — the SAME "Total assets"/"NET ASSETS" figures via the
    // csvMoney() formatter, a genuinely separate code path from the
    // table's own fmtLedgerCell() (moneyDisplay.js's own header: the
    // review finding this module exists to fix was exactly these two
    // formatters disagreeing).
    await goToOutput(page, ids, "net-worth", "table");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 5000 }),
      page.click("#exportBtn"),
    ]);
    const csvPath = await download.path();
    const csvText = fs.readFileSync(csvPath, "utf8");
    const csvRows = parseCSV(csvText);
    const header = csvRows[0]; // ["Item", "68 (FY2026–27)", ...]
    const csvAges = header.slice(1).map((h) => Number(String(h).match(/^(\d+)/)?.[1]));
    for (const [rowLabel, fieldFn] of [
      ["Total assets", (y) => out.yearly[y].totalAssets],
      ["NET ASSETS", (y) => out.yearly[y].netAssets],
    ]) {
      const row = csvRows.find((r) => r[0] === rowLabel);
      assert.ok(row, `CSV export has no "${rowLabel}" row`);
      csvAges.forEach((age, i) => {
        const y = clientAges.indexOf(age);
        if (y === -1) return;
        const want = csvMoney(fieldFn(y));
        const got = row[i + 1];
        if (got !== want) mismatches.push({ rowLabel: `CSV / ${rowLabel}`, age, y, rendered: got, expected: want });
      });
    }

    // Chart series reconciliation now lives in its own dedicated file
    // (tests/browser/chartReconciliation.test.mjs, docs/specs/41-
    // dependency-ordering-density.md Commit 2) — covering every Output-
    // group chart, not just Net worth's, now that Plotly is vendored
    // and actually available to check against.

    // Round trip — edit through the review panel (the surface spec 38's
    // "stale cached DOM" bug lived on), assert the engine changed AND
    // the already-open Key Figures table followed, without navigating
    // away from it.
    await goToOutput(page, ids, "net-worth", "table");
    const before = await readLedgerRow(page, "#keyFiguresTable table.tl", "NET ASSETS");
    const beforeY0 = before.find((c) => c.age === clientAges[0]).text;

    await page.evaluate(() => { document.getElementById("inputReviewSection").open = true; });
    const bondInput = page.locator('#inputReviewPanel input[data-bdfield="balance"]');
    await bondInput.waitFor({ state: "visible", timeout: 5000 });
    await bondInput.fill("999999");
    await bondInput.blur(); // fires a real, bubbling "change" — same as a user tabbing off the field
    await page.waitForTimeout(100);

    const scenarioKey = `planner.scenario.${scenarioId}`;
    const rawAfter = await page.evaluate((key) => localStorage.getItem(key), scenarioKey);
    const stateAfter = hydrate(rawAfter, PROFILES);
    const outAfter = projectPlan(stateAfter);
    const expectedAfterY0 = fmtLedgerCell(outAfter.yearly[0].netAssets);

    assert.notEqual(expectedAfterY0, fmtLedgerCell(out.yearly[0].netAssets), "editing the bond balance produced no change in the engine's own NET ASSETS — the round trip's own premise is broken");

    const after = await readLedgerRow(page, "#keyFiguresTable table.tl", "NET ASSETS");
    const afterY0 = after.find((c) => c.age === clientAges[0]).text;
    assert.notEqual(afterY0, beforeY0, "Key figures NET ASSETS did not change after the review-panel edit");
    assert.equal(afterY0, expectedAfterY0, "Key figures NET ASSETS, after the edit, does not match a fresh projectPlan() over the edited state — the open display did not follow the engine");
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }

  assert.equal(consoleErrors.length, 0, `console errors during reconciliation:\n${consoleErrors.join("\n")}`);
  assert.deepEqual(
    mismatches, [],
    `${mismatches.length} reconciliation mismatch(es):\n` +
      mismatches.map((m) => `  [${m.rowLabel}] age ${m.age} (y=${m.y}): rendered ${m.rendered}, ledger says ${m.expected}`).join("\n")
  );
});

// Proves checkLedgerRow (and by extension the mechanism above) actually
// fails on a genuine drift, the same way Commit 2's sabotage test
// proved the control sweep does — mutates one already-rendered cell to
// a wrong figure and re-runs the same comparison against it.
test("browser: a deliberately introduced drift fails reconciliation", async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.on("dialog", (dialog) => dialog.accept());

  const state = fullyPopulatedState();
  const out = projectPlan(state);
  const clientAges = out.schedule.clientAges;
  const { clientId, scenarioId, route } = await seedScenario(page, state);
  const ids = { clientId, scenarioId };

  try {
    await page.goto(`${BASE_URL}/${route}`);
    await page.waitForSelector('[data-section="setup"]');
    await goToOutput(page, ids, "net-worth", "table");

    await page.evaluate(() => {
      const table = document.querySelector("#keyFiguresTable table.tl");
      const row = Array.from(table.querySelectorAll("tbody tr")).find((tr) => tr.querySelector("th.tl-label")?.textContent.trim() === "NET ASSETS");
      const cell = row.querySelector("td.tl-num");
      cell.textContent = "1"; // deliberately wrong
    });

    const cells = await readLedgerRow(page, "#keyFiguresTable table.tl", "NET ASSETS");
    const mismatches = checkLedgerRow(cells, clientAges, (y) => out.yearly[y].netAssets, "NET ASSETS");
    assert.ok(mismatches.length > 0, "the sabotaged NET ASSETS cell was not detected as a mismatch");
    assert.equal(mismatches[0].rendered, "1");
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }
});

// A minimal CSV parser matching exactly what exportTransposedCSV
// (main.js) writes: comma-separated, double-quoted fields with ""
// escaping for an embedded quote — no other CSV dialect quirks (no
// embedded newlines inside a field) appear in this app's own export.
function parseCSV(text) {
  return text.split("\n").filter((line) => line.length > 0).map((line) => {
    const fields = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        let j = i + 1, val = "";
        while (j < line.length) {
          if (line[j] === '"' && line[j + 1] === '"') { val += '"'; j += 2; continue; }
          if (line[j] === '"') { j++; break; }
          val += line[j]; j++;
        }
        fields.push(val);
        i = j + 1; // skip trailing comma
      } else {
        const next = line.indexOf(",", i);
        const end = next === -1 ? line.length : next;
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
    return fields;
  });
}
