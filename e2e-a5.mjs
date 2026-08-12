// A.5 acceptance e2e — page-based client/scenario navigation.
// Run: node e2e-a5.mjs   (needs `vite preview` on :4173)
import { chromium } from "playwright-core";

const URL = "http://localhost:4173/";
const EXE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const isNoise = (t) =>
  t.includes("cdn.plot.ly") || t.includes("Plotly") ||
  t.includes("ERR_TUNNEL_CONNECTION_FAILED") || t.includes("Failed to load resource");

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => { if (!isNoise(String(e))) errors.push(`pageerror: ${e}`); });
page.on("console", (m) => {
  if (m.type() === "error" && !isNoise(m.text())) errors.push(`console: ${m.text()}`);
});

const hash = () => page.evaluate(() => location.hash);
const visiblePage = () => page.evaluate(() => {
  for (const id of ["pageClients", "pageClient", "pageWorkspace"]) {
    if (!document.getElementById(id).hidden) return id;
  }
  return null;
});

// --- 1. fresh load restores the active scenario's workspace route ---------
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("#summaryStrip .stat");
check("fresh load lands on the workspace page", (await visiblePage()) === "pageWorkspace");
check("fresh load hash is the scenario route",
  /^#\/clients\/[\w-]+\/scenarios\/[\w-]+$/.test(await hash()), await hash());
const bcText = await page.locator("#breadcrumb").innerText();
check("workspace breadcrumb shows Clients / client / scenario",
  bcText.includes("Clients") && bcText.includes("Client 1") && bcText.includes("Scenario 1"), bcText);

// --- 2. breadcrumb → Clients; heavy DOM is dropped -------------------------
await page.click('#breadcrumb a[href="#/clients"]');
await page.waitForSelector("#pageClients .list-row");
check("Clients page visible", (await visiblePage()) === "pageClients");
check("hash is #/clients", (await hash()) === "#/clients");
check("client row shows name + scenario count",
  (await page.locator("#pageClients .list-row").innerText()).includes("1 scenario"));
check("workspace DOM emptied behind the list page",
  await page.evaluate(() =>
    document.getElementById("assets").children.length === 0 &&
    document.getElementById("summaryStrip").children.length === 0 &&
    document.getElementById("chart").children.length === 0));
check("delete disabled on the last client",
  await page.locator('#pageClients [data-action="delete"]').isDisabled());

// --- 3. new client → client page; new scenario → workspace ----------------
await page.click('[data-action="new-client"]');
await page.waitForSelector("#pageClient .list-row");
check("new client navigates into its Client page",
  (await visiblePage()) === "pageClient" && /^#\/clients\/[\w-]+$/.test(await hash()), await hash());
check("client page breadcrumb has renameable client name",
  (await page.locator("#breadcrumb .bc-name").innerText()) === "Client 2");

// Rename the client inline via the breadcrumb.
await page.click("#breadcrumb .bc-name");
await page.fill("#breadcrumb .inline-rename-input", "Smith Family");
await page.press("#breadcrumb .inline-rename-input", "Enter");
check("breadcrumb rename commits",
  (await page.locator("#breadcrumb .bc-name").innerText()) === "Smith Family");

await page.click('[data-action="new-scenario"]');
await page.waitForSelector("#summaryStrip .stat");
check("new scenario navigates into the workspace",
  (await visiblePage()) === "pageWorkspace" && /scenarios/.test(await hash()), await hash());
const scenarioUrl = page.url();

// --- 4. edit → navigate away → reopen → state persisted --------------------
const balance = page.locator('[data-field="balance"]').first();
await balance.fill("555000");
await balance.dispatchEvent("change");
await page.click('#breadcrumb a[href="#/clients"]');
await page.waitForSelector("#pageClients .list-row");
check("two clients listed", (await page.locator("#pageClients .list-row").count()) === 2);
check("second client row shows 2 scenarios",
  (await page.locator('#pageClients .list-row', { hasText: "Smith Family" }).innerText()).includes("2 scenarios"));

await page.click('#pageClients .list-name:has-text("Smith Family")');
await page.waitForSelector("#pageClient .list-row");
check("scenario list shows both scenarios",
  (await page.locator("#pageClient .list-row").count()) === 2);
await page.click('#pageClient .list-name:has-text("Scenario 2")');
await page.waitForSelector("#summaryStrip .stat");
check("reopened scenario kept the edit",
  (await page.locator('[data-field="balance"]').first().inputValue()) === "555000");

// --- 5. back/forward buttons ------------------------------------------------
await page.goBack(); // → client page
await page.waitForSelector("#pageClient .list-row");
check("back button returns to the Client page", (await visiblePage()) === "pageClient");
await page.goForward(); // → workspace
await page.waitForSelector("#summaryStrip .stat");
check("forward button returns to the workspace", (await visiblePage()) === "pageWorkspace");

// --- 6. deep link in a fresh page load --------------------------------------
const page2 = await ctx.newPage();
page2.on("pageerror", (e) => { if (!isNoise(String(e))) errors.push(`pageerror2: ${e}`); });
await page2.goto(scenarioUrl, { waitUntil: "networkidle" });
await page2.waitForSelector("#summaryStrip .stat");
check("deep link opens the right scenario directly",
  (await page2.locator("#breadcrumb").innerText()).includes("Scenario 2") &&
  (await page2.locator('[data-field="balance"]').first().inputValue()) === "555000");
await page2.close();

// --- 7. invalid URLs fall back to #/clients ---------------------------------
const page3 = await ctx.newPage();
page3.on("pageerror", (e) => { if (!isNoise(String(e))) errors.push(`pageerror3: ${e}`); });
await page3.goto(`${URL}#/clients/bogus/scenarios/nope`, { waitUntil: "networkidle" });
await page3.waitForSelector("#pageClients .list-row");
check("invalid deep link redirects to Clients",
  (await page3.evaluate(() => location.hash)) === "#/clients");
await page3.goto(`${URL}#/garbage`, { waitUntil: "networkidle" });
await page3.waitForSelector("#pageClients .list-row");
check("unknown route redirects to Clients",
  (await page3.evaluate(() => location.hash)) === "#/clients");
await page3.close();

// --- 8. rename + delete rules on the list pages ------------------------------
await page.click('#breadcrumb a[href="#/clients"]');
await page.waitForSelector("#pageClients .list-row");
const smithRow = page.locator('#pageClients .list-row', { hasText: "Smith Family" });
await smithRow.locator('[data-action="rename"]').click();
await page.fill("#pageClients .inline-rename-input", "Smith & Co");
await page.press("#pageClients .inline-rename-input", "Enter");
check("row rename commits",
  (await page.locator("#pageClients").innerText()).includes("Smith & Co"));

page.once("dialog", (d) => d.accept());
await page.locator('#pageClients .list-row', { hasText: "Smith & Co" })
  .locator('[data-action="delete"]').click();
await page.waitForTimeout(100);
check("delete removes the client from the list",
  (await page.locator("#pageClients .list-row").count()) === 1);
check("remaining client's delete is disabled again",
  await page.locator('#pageClients [data-action="delete"]').isDisabled());

check("no unexpected console/page errors", errors.length === 0, errors.join(" ;; "));

await browser.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
