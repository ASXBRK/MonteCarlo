import { buildDemoClients } from "../../../../src/demo/index.js";
import { buildAgedCareAccommodationFocus } from "../../../../src/focusAgedCareAccommodation.js";
import { projectPlan } from "../../../../src/deterministic.js";
const demos = buildDemoClients(new Date(2026, 8, 15));
const retiree = demos[3].scenarios[0].state; // Modest retiree, September start, client 70
const preRet = demos[2].scenarios[0].state;
for (const entryAge of [70, 72]) {
  const f = buildAgedCareAccommodationFocus({ state: retiree, accommodationPrice: 500000, radAmount: 250000, entryAge, fundingAssetId: retiree.assets[0].id });
  const p0 = f.byYear[0];
  console.log(`entry ${entryAge} (year ${f.byYear[0].year}, ${p0.fyLabel}):`, f.arms.map((a) => `${a.id}: radPaid ${Math.round(a.radPaid)} dap ${Math.round(a.dapAnnualCost)} | costYr0 ${Math.round(p0[a.id].costThisYear)} remaining ${Math.round(p0[a.id].remainingAssets)}`).join("\n     "));
}
const out = projectPlan(preRet);
console.log("pre-retiree Current: income at age 65/75/85:", [65, 75, 85].map((a) => { const r = out.yearly.find((r) => r.clientAge === a); return r ? Math.round(r.income) : null; }));
{
  const f = buildAgedCareAccommodationFocus({ state: retiree, accommodationPrice: 500000, radAmount: 250000, entryAge: 70, fundingAssetId: retiree.assets[0].id });
  for (const p of [f.byYear[1], f.byYear[5]]) console.log(`entry 70, ${p.fyLabel}:`, f.arms.map((a) => `${a.id} cost ${Math.round(p[a.id].costThisYear)} remaining ${Math.round(p[a.id].remainingAssets)} cum ${Math.round(p[a.id].cumulativeCost)}`).join(" | "));
  console.log("estate:", JSON.stringify(Object.fromEntries(Object.entries(f.estate ?? {}).map(([k, v]) => [k, Math.round(v)]))));
}
