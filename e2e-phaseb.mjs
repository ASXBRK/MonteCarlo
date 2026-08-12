// Output-layer acceptance e2e — projection chart + transposed views
// (Phase B foundations, restructured by Phase C1: view rail, Cashflow
// + Assets views, report period selector).
// Run: node e2e-phaseb.mjs   (needs `vite preview` on :4173)
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

// Zero-real custom allocation at 2.5% CPI (income-yield form).
const zeroReal = { mode: "custom", incomePct: 2.5, growthPct: 0, frankingPct: 0, volBasis: "Balanced" };

const mkAsset = (id, name, balance, over = {}) => ({
  id, name, include: true, owner: "client", distributions: "reinvest",
  balance, allocation: zeroReal, icrPct: 0, cgtAsset: false, costBase: null, ...over,
});

const mkState = ({ endAge, assets, cashflows = {}, fundingOrder }) => ({
  schemaVersion: 3,
  plan: {
    household: "single", client: { currentAge: 40 }, partner: null,
    endAge, start: { year: 2026, month: 7 },
  },
  assets,
  cashflows: { income: [], expenses: [], contributions: [], withdrawals: [], lumpSums: [], ...cashflows },
  settings: {
    surplus: { mode: "spend", assetId: null },
    fundingOrder: fundingOrder ?? assets.map((a) => a.id),
  },
  display: { units: "real" },
  assumptions: { cpi: 0.025 },
});

const portfolioOnly = mkState({
  endAge: 60,
  assets: [mkAsset("a1", "Portfolio", 100000)],
});

// Drawdown: cash 24k + shares 100k (both zero real), $4k/mo expenses,
// cash-first funding → first unfunded month 31 → age 42, FY2028–29.
const drawdown = mkState({
  endAge: 44,
  assets: [mkAsset("cash", "Cash", 24000), mkAsset("shares", "Shares", 100000)],
  fundingOrder: ["cash", "shares"],
  cashflows: {
    expenses: [{ id: "ex1", label: "Living", amount: 4000, frequency: "monthly", fromAge: 40, toAge: 44, indexed: true }],
  },
});

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => { if (!isNoise(String(e))) errors.push(`pageerror: ${e}`); });
page.on("console", (m) => {
  if (m.type() === "error" && !isNoise(m.text())) errors.push(`console: ${m.text()}`);
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("#summaryStrip .stat");
const scenarioKey = await page.evaluate(() => {
  const idx = JSON.parse(localStorage.getItem("planner.workspace.v1"));
  return `planner.scenario.${idx.activeScenarioId}`;
});

async function seed(state) {
  await page.evaluate(
    ([key, blob]) => localStorage.setItem(key, blob),
    [scenarioKey, JSON.stringify(state)]
  );
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector("#summaryStrip .stat");
}

const stripText = () => page.locator("#summaryStrip").innerText();
const tile = async (label) => {
  const lines = (await stripText()).split("\n").map((s) => s.trim()).filter(Boolean);
  const i = lines.findIndex((s) => s.toUpperCase() === label.toUpperCase());
  return i >= 0 && i + 1 < lines.length ? lines[i + 1] : null;
};
const parseMoney = (s) => Number(s.replace(/[^0-9.-]/g, ""));

const rowLabels = (sel) => page.locator(`${sel} .tl tbody .tl-label`).allInnerTexts();
const yearHeads = (sel) => page.locator(`${sel} .tl thead .tl-year`).allInnerTexts();
const clickView = async (view) => {
  await page.click(`#viewRail [data-view="${view}"]`);
  await page.waitForSelector(view === "assets" ? "#assetsTable .tl" : `#view${view[0].toUpperCase()}${view.slice(1)} .tl`);
};

// --- 1. portfolio-only: zero rows hidden, totals present --------------------
await seed(portfolioOnly);
check("portfolio-only: end balance tile = current value ($100,000)",
  (await tile("Projected end balance")) === "$100,000",
  await tile("Projected end balance"));
check("rail shows greyed coming-soon entries (Super/Liabilities/Net assets)",
  await page.locator('#viewRail [data-view="tax"]').isEnabled() &&
  (await page.locator("#viewRail .rail-item:disabled").count()) === 3);

await clickView("cashflow");
let labels = await rowLabels("#viewCashflow");
check("cashflow: all-zero rows hidden, totals always shown",
  labels.includes("Total income") && labels.includes("Total expenses") &&
  labels.includes("Surplus / (deficit)") &&
  !labels.includes("Distributions paid as cash") && !labels.includes("Tax") &&
  !labels.includes("Deficit funded from assets"),
  labels.join("|"));
check("cashflow: one-off grid row per asset", labels.includes("Portfolio"));
let years = await yearHeads("#viewCashflow");
check("cashflow: 21 year columns (FY26–27 … FY46–47)",
  years.length === 21 && years[0] === "FY26–27" && years[20] === "FY46–47",
  years.join("|"));

// Period selector: Next 10 narrows every view + exports.
await page.click('[data-preset="10"]');
await page.waitForTimeout(50);
years = await yearHeads("#viewCashflow");
check("period preset Next 10 → 10 year columns",
  years.length === 10 && years[9] === "FY35–36", years.join("|"));

const dl = await Promise.all([
  page.waitForEvent("download"),
  page.click("#exportBtn"),
]).then(([d]) => d);
check("cashflow CSV filename", /-cashflow\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
const csv = await dl.createReadStream().then(async (rs) => {
  const chunks = [];
  for await (const c of rs) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
});
const csvLines = csv.split("\n");
check("CSV header matches the visible period",
  csvLines[0] === `"Item","FY26–27","FY27–28","FY28–29","FY29–30","FY30–31","FY31–32","FY32–33","FY33–34","FY34–35","FY35–36"`,
  csvLines[0]);
check("CSV includes visible rows only",
  csv.includes(`"Total income"`) && !csv.includes(`"Deficit funded from assets"`));

// Back to full period.
await page.click('[data-preset="all"]');
await page.waitForTimeout(50);
check("preset All restores every year column",
  (await yearHeads("#viewCashflow")).length === 21);

// --- 2. Assets view: entity selector + reconciliation on screen -------------
await clickView("assets");
labels = await rowLabels("#viewAssets");
// Zero-real asset → Growth row is all-zero and auto-hides.
check("assets consolidated: detail block + closing by asset (zero rows hidden)",
  labels.includes("Opening balance") && labels.includes("Closing balance") &&
  labels.includes("Portfolio") && labels.includes("Total") && !labels.includes("Growth"),
  labels.join("|"));
await page.click('#assetsEntity [data-entity="a1"]');
await page.waitForTimeout(50);
labels = await rowLabels("#viewAssets");
check("assets single-entity block renders",
  labels.includes("Opening balance") && labels.includes("Closing balance") && !labels.includes("Total"),
  labels.join("|"));

// --- 3. nominal display: end balance = real × 1.025^21 ----------------------
await page.click('[data-units="nominal"]');
const nominalEnd = parseMoney(await tile("Projected end balance"));
check("nominal end balance = real × 1.025^21",
  Math.abs(nominalEnd - Math.round(100000 * Math.pow(1.025, 21))) <= 1,
  String(nominalEnd));
await page.click('[data-units="real"]');

// --- 4. drawdown: shortfall consistency + funding rows -----------------------
await seed(drawdown);
check("drawdown: first shortfall tile shows Age 42 (FY2028–29)",
  (await tile("First shortfall")) === "Age 42 (FY2028–29)",
  await tile("First shortfall"));
await clickView("cashflow");
labels = await rowLabels("#viewCashflow");
check("drawdown: expense line, funding + unfunded rows visible",
  labels.includes("Living") && labels.includes("Deficit funded from assets") && labels.includes("Unfunded cashflow"),
  labels.join("|"));

// Row values: FY26–27 deficit funding (48,000); FY29–30 unfunded 48,000.
const rowCells = async (label) => {
  const tr = page.locator(`#viewCashflow .tl tbody tr`, { has: page.locator(`.tl-label`, { hasText: label }) }).first();
  return (await tr.innerText()).split("\t").slice(1);
};
const funding = await rowCells("Deficit funded from assets");
check("drawdown: FY2026–27 deficit funding (48,000)", funding[0] === "(48,000)", funding.join("|"));
const unfunded = await rowCells("Unfunded cashflow");
check("drawdown: FY2028–29 unfunded 20,000; FY2029–30 48,000",
  unfunded[2] === "20,000" && unfunded[3] === "48,000", unfunded.join("|"));

// Assets view: cash drains to zero by year 0 close, so its closing
// row is all-zero and auto-hides; shares row remains.
await clickView("assets");
await page.waitForSelector('#assetsEntity [data-entity="cash"]');
labels = await rowLabels("#viewAssets");
check("assets: drained cash row auto-hides; shares row shows",
  !labels.includes("Cash") && labels.includes("Shares") && labels.includes("Total"),
  labels.join("|"));

// --- 5. projection chart (fallback in sandbox) + live recompute --------------
await clickView("cashflow");
await page.click('#viewRail [data-view="projection"]');
const plotlyLoaded = await page.evaluate(() => typeof window.Plotly !== "undefined");
if (!plotlyLoaded) {
  console.log("SKIP  Plotly CDN blocked in sandbox — asserting fallback message");
  check("chart fallback message shown",
    (await page.locator("#chart").innerText()).includes("Chart unavailable"));
}

const expenseInput = page.locator('[data-kind="expenses"][data-field="amount"]').first();
await expenseInput.fill("8000");
await expenseInput.dispatchEvent("change");
check("live recompute: shortfall moves earlier (age 41)",
  (await tile("First shortfall")) === "Age 41 (FY2027–28)",
  await tile("First shortfall"));

// --- 6. C2: in-grid one-off editing ------------------------------------------
await seed(portfolioOnly);
await clickView("cashflow");
const oneOffCell = (col) => page.locator(
  `#viewCashflow .tl tbody tr`,
  { has: page.locator(".tl-label", { hasText: "Portfolio" }) }
).first().locator(`td:nth-child(${col + 2})`); // +1 label col, nth-child is 1-based

// Edit year-10 (FY36–37): type −20,000 → outflow lump sum, source "table".
await oneOffCell(10).click();
await page.fill("#viewCashflow .tl-cell-input", "-20000");
await page.press("#viewCashflow .tl-cell-input", "Enter");
await page.waitForTimeout(100);
check("grid edit: cell shows the outflow", (await oneOffCell(10).innerText()) === "(20,000)",
  await oneOffCell(10).innerText());
check("grid edit: end balance moved (100k − 20k)",
  (await tile("Projected end balance")) === "$80,000",
  await tile("Projected end balance"));
check("grid edit: input panel shows the from-table row",
  /from table/i.test(await page.locator("#investSection").innerText()));

// Assets view reflects it too.
await clickView("assets");
labels = await rowLabels("#viewAssets");
check("grid edit: assets view gains the one-off row", labels.includes("One-off amounts"));

// Reload → persisted.
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("#summaryStrip .stat");
await clickView("cashflow");
check("grid edit persists across reload", (await oneOffCell(10).innerText()) === "(20,000)");

// Clearing the cell deletes the table-sourced entry.
await oneOffCell(10).click();
await page.fill("#viewCashflow .tl-cell-input", "");
await page.press("#viewCashflow .tl-cell-input", "Enter");
await page.waitForTimeout(100);
check("clearing the cell removes the entry", (await oneOffCell(10).innerText()) === "–");
check("end balance restored", (await tile("Projected end balance")) === "$100,000");
check("from-table row gone from the input panel",
  !/from table/i.test(await page.locator("#investSection").innerText()));

// First-FY blocking: an August start has no firing July in year 0.
await seed({ ...portfolioOnly, plan: { ...portfolioOnly.plan, start: { year: 2026, month: 8 } } });
await clickView("cashflow");
const blocked = oneOffCell(0);
check("first-FY cell is blocked with an explanation",
  (await blocked.getAttribute("data-ls-blocked")) === "1" &&
  ((await blocked.getAttribute("title")) || "").includes("partial first year"));
await blocked.click();
check("blocked cell refuses editing",
  (await page.locator("#viewCashflow .tl-cell-input").count()) === 0);

// --- 7. C4: Tax + Assumptions views -------------------------------------------
const salaried = mkState({
  endAge: 45,
  assets: [mkAsset("a1", "Portfolio", 100000, {
    allocation: { mode: "custom", incomePct: 0, growthPct: 2.5, frankingPct: 0, volBasis: "Balanced" },
  })],
  cashflows: {
    income: [{ id: "i1", label: "Salary", owner: "client", amount: 100000 / 12, frequency: "monthly", fromAge: 40, toAge: 45, indexed: true }],
  },
});
await seed(salaried);
const cellsOf = async (container, label) => {
  const tr = page.locator(`${container} .tl tbody tr`, { has: page.locator(".tl-label", { hasText: label }) }).first();
  return (await tr.innerText()).split("\t").slice(1);
};

await page.click('#viewRail [data-view="tax"]');
await page.waitForSelector("#viewTax .tl");
labels = await rowLabels("#viewTax");
check("tax view: per-person rows + household total; zero rows hidden",
  labels.includes("Taxable income") && labels.includes("Gross tax") &&
  labels.includes("Medicare levy") && labels.includes("Net income tax") &&
  labels.includes("Total tax") && !labels.includes("LITO") && !labels.includes("CGT payable"),
  labels.join("|"));
const taxable = await cellsOf("#viewTax", "Taxable income");
const netTax = await cellsOf("#viewTax", "Net income tax");
check("tax view: FY27–28 taxable income 100,000 and net tax (22,252)",
  taxable[1] === "100,000" && netTax[1] === "(22,252)",
  `${taxable[1]} / ${netTax[1]}`);

const dlTax = await Promise.all([
  page.waitForEvent("download"),
  page.click("#exportBtn"),
]).then(([d]) => d.suggestedFilename());
check("tax CSV filename", /-tax\.csv$/.test(dlTax), dlTax);

await page.click('#viewRail [data-view="assumptions"]');
await page.waitForSelector("#viewAssumptions .tl");
labels = await rowLabels("#viewAssumptions");
check("assumptions view: economic + threshold rows",
  labels.includes("CPI (% p.a.)") &&
  labels.some((l) => l.includes("net real return")) &&
  labels.includes("Tax-free threshold (to)") && labels.includes("LITO cut-out"),
  labels.join("|"));
const tft = await cellsOf("#viewAssumptions", "Tax-free threshold (to)");
check("assumptions: indexed mode holds the tax-free threshold flat in today's dollars",
  tft[0] === "18,200" && tft[tft.length - 1] === "18,200",
  tft.join("|"));

check("no unexpected console/page errors", errors.length === 0, errors.join(" ;; "));

await browser.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
