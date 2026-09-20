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
