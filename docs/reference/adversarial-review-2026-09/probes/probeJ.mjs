import { buildDemoClients } from "../../../../src/demo/index.js";
import { hydrate, clampAllToPlan } from "../../../../src/planState.js";
import { PROFILES } from "../../../../src/profiles.js";
import { runProjection } from "../../../../src/engine.js";
function diff(a, b, path = "", out = []) {
  if (a === b) return out;
  if (typeof a !== "object" || typeof b !== "object" || a == null || b == null) { out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`); return out; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], path + "." + k, out);
  return out;
}
for (const client of buildDemoClients(new Date(2026, 8, 15))) for (const sc of client.scenarios) {
  const s = sc.state;
  const h = hydrate(JSON.stringify(s), PROFILES);
  const d = diff(s, h).filter((l) => !l.includes("Default"));
  const o1 = runProjection(s), o2 = runProjection(h); if (o2.errors.length) { console.log(client.name, sc.name, "hydrated state invalid:", JSON.stringify(o2.errors).slice(0,200), "keys", Object.keys(h).join(",")); continue; }
  const numDiff = o1.yearly.map((r, i) => Math.abs((r.netAssets ?? 0) - (o2.yearly[i]?.netAssets ?? 0))).reduce((a, b) => Math.max(a, b), 0);
  console.log(`${client.name} / ${sc.name}: hydrate diffs ${d.length}; max netAssets diff ${numDiff.toFixed(2)}; start ${JSON.stringify(s.plan.start)}`);
  for (const l of d.slice(0, 6)) console.log("   ", l.slice(0, 160));
}
