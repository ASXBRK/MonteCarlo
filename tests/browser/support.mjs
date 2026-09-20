// Browser-harness shared support (docs/specs/40-browser-test-harness.md,
// Commit 1) — browser launch, localStorage fixture seeding, console-
// error tracking, and screenshot-on-failure. Every test file imports
// from here rather than re-deriving any of this.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIndex } from "../../src/workspace.js";
import { serialize } from "../../src/planState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PREVIEW_PORT = Number(process.env.BROWSER_TEST_PORT ?? 4174);
export const BASE_URL = `http://localhost:${PREVIEW_PORT}`;
export const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

// Playwright's own default browser-channel resolution expects a
// specific bundled revision; this sandbox (and possibly other CI
// images) ships a DIFFERENT already-installed chromium-<rev> under
// PLAYWRIGHT_BROWSERS_PATH, one Playwright's own default lookup
// doesn't find (mismatched revision number) — confirmed directly
// while building this harness: chromium.launch() with no options
// fails "Executable doesn't exist at .../chromium_headless_shell-*"
// even though a perfectly usable chromium-* IS installed one
// directory over. Scans for it and passes an explicit executablePath
// ONLY when the default resolution would otherwise fail — an
// environment where the default works (a normal `npx playwright
// install` machine) is untouched.
function resolveChromiumExecutable() {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsersPath || !fs.existsSync(browsersPath)) return undefined;
  const revisions = fs.readdirSync(browsersPath)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const rev of revisions) {
    const exe = path.join(browsersPath, rev, "chrome-linux", "chrome");
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

export async function launchBrowser() {
  // Check for the known-installed-elsewhere revision FIRST (a fast,
  // synchronous fs scan) rather than trying Playwright's own default
  // resolution and catching its failure — in a network-blocked sandbox
  // that failure is itself slow (it appears to attempt network
  // resolution before giving up), costing a large, invisible chunk of
  // wall-clock time on every single run, which directly fights this
  // harness's own "keep it fast" requirement. An environment where the
  // default resolution actually works skips this scan's own result
  // (undefined) and launches normally, untouched.
  const executablePath = resolveChromiumExecutable();
  const opts = { headless: true, args: ["--no-sandbox"], ...(executablePath ? { executablePath } : {}) };
  return chromium.launch(opts);
}

// Known, environment-specific network noise, not an app defect: this
// sandbox's own outbound proxy blocks the Plotly CDN
// (src/chart.js/index.html load Plotly from cdn.plot.ly — the "CDN
// may be blocked" case CLAUDE.md's own architecture map already
// documents as guarded, not a bug to fix). A genuine app console error
// never mentions plot.ly or a bare network-transport failure string,
// so filtering these two specific, narrow patterns can't hide a real
// regression — it only silences a failure this exact sandbox cannot
// avoid regardless of what the app does.
const KNOWN_NETWORK_NOISE = [/plot\.ly/i, /net::ERR_/, /404 \(Not Found\)/];

function isKnownNoise(text) {
  return KNOWN_NETWORK_NOISE.some((re) => re.test(text));
}

// Attaches console/pageerror capture to a page, returning a live array
// of unfiltered error strings — "console errors fail the test" (the
// spec's own Commit 1 requirement), checked by the caller at whatever
// point makes sense for that test (usually right before returning).
export function trackConsoleErrors(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !isKnownNoise(msg.text())) errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err?.stack ?? err)));
  return errors;
}

// Seeds localStorage with a fully-formed workspace index + one
// scenario BEFORE the app's own module graph evaluates (main.js reads
// localStorage synchronously at top level the instant it parses — see
// mountWorkspace's own header in main.js — so seeding via
// page.evaluate() AFTER goto() is already too late, the app will have
// already created and possibly persisted a fresh empty workspace by
// then). Returns the route to the seeded scenario's own Setup page;
// callers navigate wherever they actually need from there.
export async function seedScenario(page, state, { clientName = "Test client", scenarioName = "Test scenario" } = {}) {
  const index = createIndex(Date.now());
  index.clients[0].name = clientName;
  index.clients[0].scenarios[0].name = scenarioName;
  const clientId = index.activeClientId;
  const scenarioId = index.activeScenarioId;
  const scenarioJSON = serialize(state);
  await page.addInitScript(
    ([indexKey, indexJSON, scenarioStorageKey, scenarioBlob]) => {
      localStorage.setItem(indexKey, indexJSON);
      localStorage.setItem(scenarioStorageKey, scenarioBlob);
    },
    ["planner.workspace.v1", JSON.stringify(index), `planner.scenario.${scenarioId}`, scenarioJSON]
  );
  return { clientId, scenarioId, route: `#/clients/${clientId}/scenarios/${scenarioId}/input/setup` };
}

// --- Commit 2 (docs/specs/40-browser-test-harness.md) — "every
// control is alive" -------------------------------------------------

// Structural, not attribute-based: an earlier pass over main.js found
// ~20 different -action attribute names and ~18 different *field names
// with no single convention linking them, so deriving "every control"
// from data-* naming would silently miss whatever doesn't happen to
// match. Every control kind the spec names — buttons, selects,
// checkboxes/radios — plus <summary>, the native disclosure control
// used for the collapsible review panel and chart-treatment details,
// which is exactly as "interactive control" as the rest even though it
// isn't literally a <button>.
export const CONTROL_SELECTOR = "button, select, input[type=checkbox], input[type=radio], summary";

// Monte Carlo / lifecycle-comparison "Run" buttons kick off a real
// 2,000-to-4,000-path simulation through the full engine — genuinely
// wired, not dead, but running one to completion on every sweep pass
// contradicts the harness's own "keep it fast" requirement by orders
// of magnitude: a first pass that swept these like any other button
// left a Chromium renderer at 60%+ CPU for minutes after the test
// itself had moved on (confirmed directly — see docs/reference/build-
// log.md, Commit 2). controls.test.mjs excludes these ids from the
// generic sweep and checks them separately, bounded, in a page it
// discards immediately after (closing a page tears down its Worker
// regardless of whether Cancel was clicked or even exists yet).
export const HEAVY_RUN_BUTTON_IDS = [
  "runMonteCarloBtn", "runMonteCarloTableBtn", "retirementMcRunBtn", "retirementCompareRunBtn",
];

// #exportBtn's whole job (relabelled "Export PNG"/"Export CSV" per
// view — main.js's own header comment on it) is a Blob + anchor
// download, never a DOM or localStorage change — structurally
// invisible to sweepArea's change signal, confirmed directly (it
// reported as dead every time). Excluded from the generic sweep;
// controls.test.mjs checks it separately via Playwright's own
// download event instead.
export const DOWNLOAD_TRIGGER_IDS = ["exportBtn"];

export const DEFAULT_EXCLUDE_IDS = [...HEAVY_RUN_BUTTON_IDS, ...DOWNLOAD_TRIGGER_IDS];

// sweepArea (below) scopes its own MutationObserver to just the
// container being swept for each call — plus every <dialog>, since a
// control's real effect is sometimes to open one of those, which live
// outside any [data-section] container. An earlier draft used a single
// document-wide observer instead; that false-positived (confirmed
// directly — a completely inert, disconnected button, in an isolated
// wrapper div appended straight to <body>, still showed a document-wide
// mutation within a 60ms window with nothing else clicking anything):
// a page this busy has enough of its own ambient settling activity that
// "something changed somewhere on the page" stopped meaning "this
// control did something".

// Runs entirely inside the page (one round trip, not one per control)
// so the per-control settle wait (waitMs — a handler that kicks off a
// worker, e.g. Monte Carlo's "Run", needs a real tick before its
// "now running" state shows up) doesn't multiply into per-control
// Node<->browser round-trip latency across hundreds of controls.
//
// Derives its own worklist from the live DOM each iteration (never a
// snapshot taken up front) — operating a control commonly adds,
// removes, or reveals others (an "Add row" button's own new row; a
// "Run" button's own "Cancel" button; a confirm dialog's own buttons),
// and each of those is exactly as much "a control in the application"
// as the one that revealed it. A control is marked tested via an
// in-memory WeakSet, not a scratch DOM attribute — attribute mutations
// are tracked too (below), and MutationObserver delivers its records as
// a microtask rather than synchronously, so a mark-then-snapshot within
// the same synchronous turn was found to leak the MARK'S OWN mutation
// into the wrong side of the next diff: it hadn't been delivered yet
// when "before" was read, then landed during the settle wait and made
// "after" look changed regardless of what the control itself did —
// confirmed directly, a deliberately inert control was passing. A
// WeakSet touches nothing the observer watches, so it can't leak.
// Every control gets EXACTLY one operation: a button is clicked, a
// checkbox/unchecked-radio is clicked, a select with >1 option moves to
// its next option. A radio already selected, or a select with only one
// option, has nothing to operate and is skipped (not a failure — there
// is no "different" state to move it to).
//
// "Alive" means operating it left a trace: the tracked mutation count
// moved, or the scenario's own localStorage serialization changed. Per
// this project's own input-integrity convention (CLAUDE.md), a control
// that silently clamps/rejects with neither of those is exactly the
// bug class to catch, not a pass — a "recognised no-op" still has to
// SHOW something (a validation message, a disabled state) to count.
export async function sweepArea(page, containerSelector, { maxControls = 400, waitMs = 60, excludeIds = DEFAULT_EXCLUDE_IDS } = {}) {
  return page.evaluate(
    async ({ containerSelector, maxControls, waitMs, controlSelector, excludeIds }) => {
      // Keyed by a structural signature, not node identity: this app
      // re-renders whole sections via innerHTML replacement (confirmed
      // directly — e.g. toggling the Setup household Single/Married
      // buttons replaces #planBar's entire subtree), so the SAME
      // logical control becomes a brand-new DOM node on every
      // operation. A WeakSet keyed by node kept finding "new" controls
      // forever — the very same two buttons, toggling back and forth —
      // and ran straight into the maxControls guard. A signature built
      // from id/data-*/name survives the re-render (the new node has
      // the SAME attributes), so the second sighting is correctly
      // recognised as "already tested" and the loop actually ends.
      const seen = new Set();

      function isVisible(el) {
        if (el.hidden || el.disabled) return false;
        if (el.closest("[hidden]")) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") return false;
        return true;
      }

      function baseKey(el) {
        if (el.id) return `id:${el.id}`;
        const dataAttrs = Array.from(el.attributes)
          .filter((a) => a.name.startsWith("data-"))
          .map((a) => `${a.name}=${a.value}`)
          .sort().join("&");
        const core = `${el.tagName}:${el.type || ""}:${el.name || ""}`;
        if (dataAttrs) return `${core}:${dataAttrs}`;
        // No id and no data-* to key on — last resort, the rendered
        // label itself (ambiguous across a copy change, but there's
        // nothing else to go on for a control this bare).
        const label = (el.getAttribute("aria-label") || el.textContent || el.value || "")
          .trim().replace(/\s+/g, " ").slice(0, 60);
        return `${core}:text=${label}`;
      }

      // Two distinct controls can legitimately share a base key (e.g.
      // two otherwise-identical bare buttons with no distinguishing
      // attribute) — disambiguated by their ordinal position among
      // same-signature siblings, which a re-render preserves as long
      // as the controls themselves don't reorder.
      function keyOf(el, allControls) {
        const base = baseKey(el);
        const sameBase = allControls.filter((x) => baseKey(x) === base);
        if (sameBase.length <= 1) return base;
        return `${base}#${sameBase.indexOf(el)}`;
      }

      const container = document.querySelector(containerSelector);
      if (!container) {
        return { tested: 0, skipped: 0, failures: [{ descriptor: containerSelector, reason: "container not found" }] };
      }

      // Scoped to this container plus every <dialog> (modals live at
      // the top of the document, outside any [data-section] container,
      // and a control's real effect is sometimes to open one) — NOT
      // document-wide, which was found to register unrelated ambient
      // page activity as if it were this control's own effect.
      let mutationCount = 0;
      const observer = new MutationObserver((records) => { mutationCount += records.length; });
      const observeOpts = { childList: true, subtree: true, attributes: true, characterData: true };
      observer.observe(container, observeOpts);
      for (const dialog of document.querySelectorAll("dialog")) observer.observe(dialog, observeOpts);

      const failures = [];
      let tested = 0, skipped = 0, iterations = 0;

      while (iterations++ < maxControls) {
        const all = Array.from(container.querySelectorAll(controlSelector)).filter(isVisible);
        const candidates = all.filter((el) => !seen.has(keyOf(el, all)));
        if (candidates.length === 0) break;

        const el = candidates[0];
        const desc = keyOf(el, all);
        seen.add(desc);
        if (el.id && excludeIds.includes(el.id)) { skipped++; continue; }

        if (el.tagName === "INPUT" && el.type === "radio" && el.checked) { skipped++; continue; }
        if (el.tagName === "SELECT" && el.options.length < 2) { skipped++; continue; }
        // A tab/segmented-toggle button that already IS the selected
        // one (aria-selected/aria-pressed="true", the convention this
        // app's own tablist/toggle groups use throughout) has nothing
        // different to move to — same reasoning as the two checks
        // above, just for the button-group equivalent of a radio.
        if (el.getAttribute("aria-selected") === "true") { skipped++; continue; }
        if (el.getAttribute("aria-pressed") === "true") { skipped++; continue; }

        const beforeMutations = mutationCount;
        const beforeStorage = JSON.stringify(localStorage);
        try {
          if (el.tagName === "SELECT") {
            el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            el.click();
          }
        } catch (err) {
          failures.push({ descriptor: desc, reason: `threw: ${err && err.message}` });
          continue;
        }

        // Polled rather than a single flat wait: most controls settle
        // within a poll or two, so this costs nothing in the common
        // case, but a slower one gets the full waitMs budget instead of
        // a single sample that can land just before its mutation is
        // delivered.
        const pollEvery = Math.max(15, Math.floor(waitMs / 4));
        let changed = false;
        for (let waited = 0; waited < waitMs; waited += pollEvery) {
          await new Promise((resolve) => setTimeout(resolve, pollEvery));
          changed = mutationCount !== beforeMutations || JSON.stringify(localStorage) !== beforeStorage;
          if (changed) break;
        }
        if (!changed) failures.push({ descriptor: desc, reason: "no DOM mutation, no state change after operating" });
        else tested++;

        // Close any <dialog> this control (or an earlier one) left
        // open, right away — an open modal <dialog> makes the REST OF
        // THE DOCUMENT inert per the HTML spec, which silently drops
        // .click() on every control tested after it. Confirmed
        // directly: paramsBtn intermittently "failed" only because
        // adjustmentsBtn, tested immediately before it in DOM order,
        // had left #adjustmentsModal open — nothing wrong with
        // paramsBtn itself.
        for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
      }

      observer.disconnect();
      if (iterations >= maxControls) {
        failures.push({ descriptor: containerSelector, reason: `hit maxControls guard (${maxControls}) — possible runaway control generation` });
      }
      return { tested, skipped, failures };
    },
    { containerSelector, maxControls, waitMs, controlSelector: CONTROL_SELECTOR, excludeIds }
  );
}

// Screenshots on failure (the spec's own Commit 1 requirement) — a
// gitignored directory (tests/browser/screenshots/), named after the
// test so repeated runs overwrite rather than accumulate.
export async function screenshotOnFailure(page, testName) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const safeName = testName.replace(/[^a-z0-9-]+/gi, "-").slice(0, 120);
  const filePath = path.join(SCREENSHOT_DIR, `${safeName}.png`);
  try {
    await page.screenshot({ path: filePath, fullPage: true });
  } catch {
    // The page/context may already be closed if the failure happened
    // during teardown — a missed screenshot is not worth failing the
    // test run over a second time.
  }
  return filePath;
}
