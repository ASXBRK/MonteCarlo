import { superRatesFor } from "../../../../src/data/superRates.js";
import { createTransferBalanceAccount, indexTransferBalanceCap } from "../../../../src/pensionTba.js";
const cpi = 0.025;
let last = superRatesFor(2026, "indexed", cpi).generalTransferBalanceCap;
let tba = createTransferBalanceAccount(last);
let sumPos = 0;
for (let fy = 2027; fy <= 2066; fy++) {
  const g = superRatesFor(fy, "indexed", cpi).generalTransferBalanceCap;
  const d = g - last;
  if (d > 0) sumPos += d;
  tba = indexTransferBalanceCap(tba, d);
  last = g;
  if (fy % 10 === 6) console.log(fy, "realGTBC", g.toFixed(0), "personalCap(0% used)", tba.personalCap.toFixed(0));
}
