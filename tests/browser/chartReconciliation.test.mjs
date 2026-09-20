// Browser: chart series reconcile to the ledger (docs/specs/41-
// dependency-ordering-density.md, Commit 2) — with Plotly vendored
// (Commit 1), this is the assertion spec 40 Commit 3 wrote and guarded
// because Plotly couldn't load in this sandbox: for every chart in the
// Output group, every plotted series equals its ledger source. This is
// the assertion that would have caught adversarial-review findings
// 1.10, 1.11 and 2.5 — it has never been able to run before now.
//
// Each chart's "expected" values come from the SAME pure function (or
// the same direct projectPlan() row field) main.js itself calls to
// build that chart's traces — chartSeries.js's expenseFundingSeries/
// taxByTypeSeries/debtVsAssetsSeries/superVsNonSuperSeries,
// cashflowCategories.js's incomeCategorySums/expenseCategorySums (the
// same pure functions spec 37's own unit reconciliation test uses),
// allocation.js's allocationSeries, or a bare row.<field> read — never
// a second, hand-maintained computation duplicating that arithmetic.
//
// Scope: the Output group's 13 directly-ledger-backed, deterministic
// charts. NOT covered, each for a stated reason:
//   - Monte Carlo charts (chartMonteCarlo, retirementMc*, the
//     sustainable-spend/levers/lifecycle-comparison charts) — genuinely
//     stochastic; there is no single "ledger figure" a simulated
//     distribution reconciles to the way a deterministic total does.
//   - Composite and "Where the money went" (money-decomposition) —
//     non-default chart-type options under Net worth/Projection's own
//     selector, layered on the SAME compositeSeries()/row fields the
//     in-scope charts already exercise; left for a follow-up rather
//     than growing this commit further.
//   - Focus/What-if/Retirement-group charts — single-question views
//     over the same comprehensive inputs, out of the adversarial
//     review's own scope (findings 1.10/1.11/2.5 were all Output-group
//     totals).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  launchBrowser, trackConsoleErrors, seedScenario, screenshotOnFailure, BASE_URL,
} from "./support.mjs";
import { fullyPopulatedState } from "./fixtures.mjs";
import { projectPlan } from "../../src/deterministic.js";
import {
  expenseFundingSeries, taxByTypeSeries, debtVsAssetsSeries, superVsNonSuperSeries,
} from "../../src/chartSeries.js";
import { incomeCategorySums, expenseCategorySums } from "../../src/cashflowCategories.js";
import { allocationSeries } from "../../src/allocation.js";
import { PROFILES, ASSET_CLASS_KEYS, ASSET_CLASS_LABELS } from "../../src/profiles.js";
import { flatEducationBlocks } from "../../src/planState.js";
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

// Switches the chart-type dropdown (main.js's CHART_OPTIONS — cashflow/
// net-worth/super each offer more than one chart) and waits for the
// newly selected chart's own container to actually receive data before
// reading it, since the switch re-renders in place.
async function selectChartType(page, chartId, expectContainerId) {
  await page.selectOption("#chartTypeSelect", chartId);
  await page.waitForFunction(
    (id) => document.getElementById(id)?.data?.length > 0,
    expectContainerId, { timeout: 5000 }
  );
  await page.waitForTimeout(20);
}

// Reads a Plotly chart's plotted traces straight off its own data model
// (el.data) — not the rendered SVG — so this reads exactly what Plotly
// was given, the same thing findings 1.10/1.11/2.5 were about.
async function readChart(page, containerId) {
  return page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el?.data?.length) return null;
    return { x: el.data[0].x, traces: el.data.map((t) => ({ name: t.name, y: t.y })) };
  }, containerId);
}

// mode "byName": each trace named in `expected` must equal expected(y)
// at every rendered age. mode "sum": the SUM of every trace's y-value
// at each age must equal expected(y) — used for the stacked-by-item
// charts (Assets, Super) whose trace names are dynamic (asset/account
// names), so there is no fixed name to key on; the total is the
// ledger-published field those items are known to sum to.
function checkChart(chart, clientAges, mode, expected, label) {
  const mismatches = [];
  if (!chart) { mismatches.push({ chart: label, trace: "(container)", reason: "no chart data mounted" }); return mismatches; }
  chart.x.forEach((age, i) => {
    const y = clientAges.indexOf(age);
    if (y === -1) return;
    if (mode === "sum") {
      const sum = chart.traces.reduce((s, tr) => s + (Number(tr.y[i]) || 0), 0);
      const want = expected(y);
      if (Math.abs(sum - want) > 1) mismatches.push({ chart: label, trace: "(sum)", age, rendered: sum, expected: want });
      return;
    }
    for (const tr of chart.traces) {
      const fn = expected[tr.name];
      if (!fn) continue;
      const val = Number(tr.y[i]) || 0;
      const want = fn(y);
      if (Math.abs(val - want) > 1) mismatches.push({ chart: label, trace: tr.name, age, rendered: val, expected: want });
    }
  });
  return mismatches;
}

const CASHFLOW_INCOME_SEGMENTS = [
  { key: "employment", name: "Employment" }, { key: "rental", name: "Rental" },
  { key: "investment", name: "Investment/distributions" }, { key: "wcaInterest", name: "Working Cash Account interest" },
  { key: "other", name: "Other income" },
];
const CASHFLOW_EXPENSE_SEGMENTS = [
  { key: "living", name: "Living expenses" }, { key: "investmentExpenses", name: "Investment/property expenses" },
  { key: "education", name: "Education" }, { key: "loanInterest", name: "Loan interest" },
  { key: "loanPrincipal", name: "Loan principal" }, { key: "tax", name: "Tax" },
  { key: "superContributions", name: "Super contributions" },
];
const INCOME_SOURCE_SEGMENTS = [
  { key: "employment", name: "Salary" }, { key: "rental", name: "Rent" },
  { key: "investment", name: "Distributions" }, { key: "wcaInterest", name: "Cash interest" },
  { key: "other", name: "Capital drawdown & other" },
];
const TAX_TYPE_SEGMENTS = [
  { key: "incomeTax", name: "Income tax" }, { key: "cgt", name: "CGT" },
  { key: "contributionsTax", name: "Contributions tax" }, { key: "div293", name: "Division 293" },
  { key: "div296", name: "Division 296" }, { key: "help", name: "HELP" }, { key: "mls", name: "Medicare Levy Surcharge" },
];

function financialAssetIds(state) {
  return state.assets.filter((a) => a.class !== "lifestyle").map((a) => a.id);
}
// Exactly main.js's own incomeCategorySums(y)/expenseCategorySums(y)
// wrappers (thin adapters over cashflowCategories.js — see that
// module's own header) — replicated here, argument for argument,
// rather than imported, since those wrappers close over main.js's own
// module-level `state`/`projection` and aren't themselves exported.
function incomeSumsFor(out, state, y) {
  return incomeCategorySums(
    out.yearly[y], state.cashflows.income, out.schedule.rowTotals.income,
    state.properties, out.schedule.oneOffsByAssetYear, financialAssetIds(state), state.plan.superAccounts, y
  );
}
function expenseSumsFor(out, state, y) {
  return expenseCategorySums(
    out.yearly[y], state.cashflows.expenses, out.schedule.rowTotals.expenses,
    state.properties, out.schedule.oneOffsByAssetYear, financialAssetIds(state), state.plan.superAccounts, y,
    flatEducationBlocks(state.plan), out.schedule.rowTotals.education
  );
}

test("browser: every chart's plotted series reconciles to the ledger", { timeout: 30_000 }, async (t) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleErrors = trackConsoleErrors(page);
  page.on("dialog", (dialog) => dialog.accept());

  const state = fullyPopulatedState();
  const out = projectPlan(state);
  const clientAges = out.schedule.clientAges;

  const { clientId, scenarioId, route } = await seedScenario(page, state, { scenarioName: "Commit 2 — chart reconciliation" });
  const ids = { clientId, scenarioId };
  const mismatches = [];

  try {
    await page.goto(`${BASE_URL}/${route}`);
    await page.waitForSelector('[data-section="setup"]');

    // Projection — the "Combined" line is a direct row field.
    await goToOutput(page, ids, "projection");
    mismatches.push(...checkChart(
      await readChart(page, "chart"), clientAges, "byName",
      { Combined: (y) => out.yearly[y].closingBalance }, "Projection"
    ));

    // Net worth (default: Net assets), then Debt vs assets via the
    // chart-type selector.
    await goToOutput(page, ids, "net-worth", "chart");
    mismatches.push(...checkChart(
      await readChart(page, "chartNetAssets"), clientAges, "byName",
      { "Net assets": (y) => out.yearly[y].netAssets }, "Net worth"
    ));
    await selectChartType(page, "debt-vs-assets", "chartDebtVsAssets");
    const dva = debtVsAssetsSeries(out.yearly);
    mismatches.push(...checkChart(
      await readChart(page, "chartDebtVsAssets"), clientAges, "byName",
      { "Total assets": (y) => dva[y].assets, "Total debt": (y) => dva[y].debt }, "Debt vs assets"
    ));

    // Assets — stacked per-asset, dynamic trace names, so summed
    // against the ledger's own closing balance.
    await goToOutput(page, ids, "assets", "chart");
    mismatches.push(...checkChart(
      await readChart(page, "chartAssetBalances"), clientAges, "sum",
      (y) => out.yearly[y].closingBalance, "Assets"
    ));

    // Liabilities — a "Total" trace, alongside per-loan lines this test
    // doesn't need to name individually.
    await goToOutput(page, ids, "liabilities", "chart");
    mismatches.push(...checkChart(
      await readChart(page, "chartLiabilitiesBalances"), clientAges, "byName",
      { Total: (y) => out.yearly[y].liabilitiesClosing }, "Liabilities"
    ));

    // Super (default: Super balances, stacked, summed), then Super vs
    // non-super via the chart-type selector.
    await goToOutput(page, ids, "super", "chart");
    mismatches.push(...checkChart(
      await readChart(page, "chartSuperBalances"), clientAges, "sum",
      (y) => out.yearly[y].superClosing + out.yearly[y].pensionClosing, "Super"
    ));
    await selectChartType(page, "super-vs-non-super", "chartSuperVsNonSuper");
    const svns = superVsNonSuperSeries(out.yearly);
    mismatches.push(...checkChart(
      await readChart(page, "chartSuperVsNonSuper"), clientAges, "byName",
      { Super: (y) => svns[y].superBalance, "Non-super": (y) => svns[y].nonSuper }, "Super vs non-super"
    ));

    // Allocation — 100%-stacked weightPct per asset class, from
    // allocation.js's own allocationSeries, called exactly as
    // renderAssetAllocationChart does for the consolidated ("all")
    // entity view.
    await goToOutput(page, ids, "allocation");
    const { perYear } = allocationSeries(
      out.yearly, state.assets, state.plan.superAccounts ?? [], PROFILES, state.bonds ?? [],
      state.plan.glidePaths, { client: out.schedule.clientAges, partner: out.schedule.partnerAges }, (i) => i
    );
    const allocExpected = Object.fromEntries(
      ASSET_CLASS_KEYS.map((k) => [ASSET_CLASS_LABELS[k], (y) => perYear[y]?.weightPct[k] ?? 0])
    );
    mismatches.push(...checkChart(await readChart(page, "chartAssetAllocation"), clientAges, "byName", allocExpected, "Allocation"));

    // Cashflow (default: Cashflow bars), then Income sources / Expense
    // funding / Tax by type via the chart-type selector — the four
    // options CHART_OPTIONS.cashflow offers.
    await goToOutput(page, ids, "cashflow", "chart");
    const cashflowExpected = {};
    for (const seg of CASHFLOW_INCOME_SEGMENTS) cashflowExpected[seg.name] = (y) => incomeSumsFor(out, state, y)[seg.key];
    cashflowExpected["Age pension"] = (y) => incomeSumsFor(out, state, y).agePension;
    for (const seg of CASHFLOW_EXPENSE_SEGMENTS) cashflowExpected[seg.name] = (y) => -expenseSumsFor(out, state, y)[seg.key];
    cashflowExpected["Surplus / (deficit)"] = (y) => out.yearly[y].surplusOrDeficit;
    mismatches.push(...checkChart(await readChart(page, "chartCashflowBars"), clientAges, "byName", cashflowExpected, "Cashflow bars"));

    await selectChartType(page, "income-sources", "chartIncomeSources");
    const incomeSourcesExpected = {};
    for (const seg of INCOME_SOURCE_SEGMENTS) incomeSourcesExpected[seg.name] = (y) => incomeSumsFor(out, state, y)[seg.key];
    incomeSourcesExpected["Age pension"] = (y) => out.yearly[y].agePensionDetail?.entitlement ?? 0;
    mismatches.push(...checkChart(await readChart(page, "chartIncomeSources"), clientAges, "byName", incomeSourcesExpected, "Income sources"));

    await selectChartType(page, "expense-funding", "chartExpenseFunding");
    const ef = expenseFundingSeries(out.yearly);
    mismatches.push(...checkChart(
      await readChart(page, "chartExpenseFunding"), clientAges, "byName",
      {
        "Met from income": (y) => ef[y].metFromIncome, "Funded by selling assets": (y) => ef[y].fundedFromAssets,
        Unfunded: (y) => ef[y].unfunded,
      }, "Expense funding"
    ));

    await selectChartType(page, "tax-by-type", "chartTaxByType");
    const tbt = taxByTypeSeries(out.yearly);
    const taxExpected = Object.fromEntries(TAX_TYPE_SEGMENTS.map((seg) => [seg.name, (y) => tbt[y][seg.key]]));
    mismatches.push(...checkChart(await readChart(page, "chartTaxByType"), clientAges, "byName", taxExpected, "Tax by type"));

    // Age pension — all three series read straight off
    // row.agePensionDetail (main.js's own comment: "never re-derived").
    await goToOutput(page, ids, "age-pension", "chart");
    mismatches.push(...checkChart(
      await readChart(page, "chartAgePension"), clientAges, "byName",
      {
        "Entitlement (paid)": (y) => out.yearly[y].agePensionDetail?.entitlement ?? 0,
        "Assets test result": (y) => out.yearly[y].agePensionDetail?.assetsTestResult ?? 0,
        "Income test result": (y) => out.yearly[y].agePensionDetail?.incomeTestResult ?? 0,
      }, "Age pension"
    ));
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }

  assert.equal(consoleErrors.length, 0, `console errors during chart reconciliation:\n${consoleErrors.join("\n")}`);
  assert.deepEqual(
    mismatches, [],
    `${mismatches.length} chart series mismatch(es):\n` +
      mismatches.map((m) => `  [${m.chart}] ${m.trace}${m.age != null ? ` age ${m.age}` : ""} — rendered ${m.rendered}, ledger says ${m.expected}${m.reason ? ` (${m.reason})` : ""}`).join("\n")
  );
});

// Proves checkChart actually fails on a genuine drift — mutates one
// already-plotted trace's own data array (Plotly's live model, not the
// SVG) to a wrong value and re-runs the same comparison against it, the
// same pattern as every other sabotage test in this suite.
test("browser: a deliberately introduced chart drift fails reconciliation", async (t) => {
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
    await goToOutput(page, ids, "net-worth", "chart");

    await page.evaluate(() => {
      document.getElementById("chartNetAssets").data[0].y[0] = 1; // deliberately wrong
    });

    const chart = await readChart(page, "chartNetAssets");
    const mismatches = checkChart(chart, clientAges, "byName", { "Net assets": (y) => out.yearly[y].netAssets }, "Net worth");
    assert.ok(mismatches.length > 0, "the sabotaged chart series was not detected as a mismatch");
    assert.equal(mismatches[0].rendered, 1);
  } catch (err) {
    await screenshotOnFailure(page, t.name);
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }
});
