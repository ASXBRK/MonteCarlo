// Phase B acceptance e2e — projection chart + ledger table views.
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

// Zero-real custom allocation at 2.5% CPI: net nominal = CPI → real 0.
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

// Portfolio-only: one asset, no cashflows at all → every Cashflow-group
// column is all-zero and must be hidden.
const portfolioOnly = mkState({
  endAge: 60,
  assets: [mkAsset("a1", "Portfolio", 100000)],
});

// Drawdown: cash 24k + shares 100k (both zero real), $4k/mo expenses,
// cash-first funding. 124k funds months 0..30 exactly; month 31 is the
// first unfunded month → plan year 2 → age 42, FY2028–29.
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

// Boot once so main.js creates the workspace index, then learn the
// active scenario's storage key for seeding.
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
const ledgerHeaders = () =>
  page.locator("#ledgerTable thead tr:nth-child(2) th").allInnerTexts();
// Note: .stat-label is uppercased by CSS, so match case-insensitively.
const tile = async (label) => {
  const lines = (await stripText()).split("\n").map((s) => s.trim()).filter(Boolean);
  const i = lines.findIndex((s) => s.toUpperCase() === label.toUpperCase());
  return i >= 0 && i + 1 < lines.length ? lines[i + 1] : null;
};
const parseMoney = (s) => Number(s.replace(/[^0-9.-]/g, ""));

// --- 1. portfolio-only: all-zero cashflow columns hidden -------------------
await seed(portfolioOnly);
check("portfolio-only: end balance tile = current value ($100,000)",
  (await tile("Projected end balance")) === "$100,000",
  await tile("Projected end balance"));
check("portfolio-only: no shortfall tile",
  !(await stripText()).toUpperCase().includes("FIRST SHORTFALL"));

await page.click('#viewSwitcher [data-view="ledger"]');
await page.waitForSelector("#ledgerTable table");
let headers = await ledgerHeaders();
check("portfolio-only: FY/Age/Closing balance columns present",
  headers.includes("FY") && headers.includes("Age") && headers.includes("Closing balance"),
  headers.join("|"));
check("portfolio-only: all-zero columns hidden (no Income/Expenses/Contributions/Unfunded)",
  ["Income", "Expenses", "Contributions", "Withdrawals", "Unfunded", "Deficit funding", "Growth"]
    .every((h) => !headers.includes(h)),
  headers.join("|"));
check("portfolio-only: ledger has 21 year rows (ages 40–60)",
  (await page.locator("#ledgerTable tbody tr").count()) === 21,
  String(await page.locator("#ledgerTable tbody tr").count()));

// Per-asset columns toggle appends the asset column.
await page.check("#showPerAssetCols");
headers = await ledgerHeaders();
check("portfolio-only: per-asset toggle adds asset column", headers.includes("Portfolio"), headers.join("|"));

// CSV export carries exactly the visible columns.
const dl = await Promise.all([
  page.waitForEvent("download"),
  page.click("#exportBtn"),
]).then(([d]) => d);
check("ledger CSV filename", /-ledger\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
const csv = await dl.createReadStream().then(async (rs) => {
  const chunks = [];
  for await (const c of rs) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
});
const csvHeader = csv.split("\n")[0];
check("ledger CSV header matches visible columns",
  csvHeader === headers.map((h) => `"${h}"`).join(","),
  csvHeader);

// --- 2. nominal display: year-N combined = real × 1.025^N ------------------
await page.click('[data-units="nominal"]');
const nominalEnd = parseMoney(await tile("Projected end balance"));
const expectNominal = Math.round(100000 * Math.pow(1.025, 21));
check("nominal end balance = real × 1.025^21",
  Math.abs(nominalEnd - expectNominal) <= 1,
  `got ${nominalEnd}, want ~${expectNominal}`);
await page.click('[data-units="real"]');

// --- 3. drawdown: first-shortfall age consistent everywhere ----------------
await seed(drawdown);
check("drawdown: first shortfall tile shows Age 42 (FY2028–29)",
  (await tile("First shortfall")) === "Age 42 (FY2028–29)",
  await tile("First shortfall"));
check("drawdown: end balance $0", (await tile("Projected end balance")) === "$0",
  await tile("Projected end balance"));

await page.click('#viewSwitcher [data-view="ledger"]');
await page.waitForSelector("#ledgerTable table");
headers = await ledgerHeaders();
check("drawdown: Expenses/Deficit funding/Unfunded columns present",
  ["Expenses", "Deficit funding", "Unfunded"].every((h) => headers.includes(h)),
  headers.join("|"));
check("drawdown: no Income/Contributions columns (all zero)",
  !headers.includes("Income") && !headers.includes("Contributions"),
  headers.join("|"));

// Year rows: FY2026–27 funds 48k; unfunded first appears in FY2028–29.
const rows = await page.locator("#ledgerTable tbody tr").allInnerTexts();
const cells = rows.map((r) => r.split("\t"));
const col = (name) => headers.indexOf(name);
check("drawdown: FY2026–27 deficit funding (48,000), no unfunded",
  cells[0][col("Deficit funding")] === "(48,000)" && cells[0][col("Unfunded")] === "–",
  JSON.stringify(cells[0]));
check("drawdown: FY2028–29 unfunded = 20,000 (5 months × 4,000)",
  cells[2][col("Unfunded")] === "20,000",
  JSON.stringify(cells[2]));
check("drawdown: FY2029–30 unfunded = 48,000 (fully unfunded year)",
  cells[3][col("Unfunded")] === "48,000",
  JSON.stringify(cells[3]));

// Projection view shows the shortfall note (skipped if Plotly is blocked
// in this sandbox — the guard hides the note with the fallback message).
await page.click('#viewSwitcher [data-view="projection"]');
const plotlyLoaded = await page.evaluate(() => typeof window.Plotly !== "undefined");
if (plotlyLoaded) {
  const note = await page.locator("#shortfallNote").innerText();
  check("drawdown: shortfall note names age 42 and FY2028–29",
    note.includes("age 42") && note.includes("FY2028–29"), note);
  const png = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportBtn"),
  ]).then(([d]) => d.suggestedFilename());
  check("projection PNG filename", /-projection\.png$/.test(png), png);
} else {
  console.log("SKIP  Plotly CDN blocked in sandbox — chart fallback path exercised instead");
  const fb = await page.locator("#chart").innerText();
  check("chart fallback message shown", fb.includes("Chart unavailable"), fb);
}

// --- 4. live recompute on input edit ---------------------------------------
// Bump the expense amount and confirm the strip updates without reload.
const expenseInput = page.locator('[data-kind="expenses"][data-field="amount"]').first();
await expenseInput.fill("8000");
await expenseInput.dispatchEvent("change");
check("live recompute: shortfall moves earlier (age 41)",
  (await tile("First shortfall")) === "Age 41 (FY2027–28)",
  await tile("First shortfall"));

check("no unexpected console/page errors", errors.length === 0, errors.join(" ;; "));

await browser.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
