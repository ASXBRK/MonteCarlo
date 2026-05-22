// Monte Carlo simulation core.
// Monthly steps, yearly snapshots, percentile aggregation.

export const NUM_PATHS = 2000;
const SAMPLE_PATHS = 30;

// Box-Muller: returns one N(0,1) sample. We discard the paired value
// to keep the call site simple; the cost is negligible at this scale.
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Pre-generate a flat Float64Array of N(0,1) shocks in row-major
// [path * months + month] layout, for use as `preGenZ` so multiple
// simulate() calls can share the same market sequence.
export function generateShocks(numPaths, months) {
  const out = new Float64Array(numPaths * months);
  for (let i = 0; i < out.length; i++) out[i] = randn();
  return out;
}

function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Deterministic compound path with same monthly mechanics but z=0.
function deterministicPath({ horizonYears, startingBalance, monthlyContribution, mu }) {
  const months = horizonYears * 12;
  const rMonthly = mu / 12;
  const yearly = new Array(horizonYears + 1);
  let balance = startingBalance;
  yearly[0] = balance;
  for (let m = 1; m <= months; m++) {
    balance = balance * (1 + rMonthly) + monthlyContribution;
    if (m % 12 === 0) yearly[m / 12] = balance;
  }
  return yearly;
}

export function simulate({
  horizonYears,
  startingBalance,
  monthlyContribution,
  mu,
  sigma,
  numPaths = NUM_PATHS,
  samplePaths = SAMPLE_PATHS,
  // Optional shared shock matrix: Float64Array of size numPaths*months
  // in [path * months + monthIndex] layout, where monthIndex is 0-based
  // (so step m=1 reads index 0). When supplied, both compared scenarios
  // see the same market sequence; when omitted, shocks are generated
  // internally (single-scenario behaviour).
  preGenZ = null,
}) {
  const months = horizonYears * 12;
  const years = horizonYears + 1; // include year 0
  const rMonthly = mu / 12;
  const sigmaMonthly = sigma / Math.sqrt(12);

  // Flat Float64Array: row-major [path * years + year].
  const yearlyAll = new Float64Array(numPaths * years);

  for (let p = 0; p < numPaths; p++) {
    let balance = startingBalance;
    const base = p * years;
    const zBase = p * months;
    yearlyAll[base + 0] = balance;
    for (let m = 1; m <= months; m++) {
      const z = preGenZ ? preGenZ[zBase + (m - 1)] : randn();
      const r = rMonthly + sigmaMonthly * z;
      balance = balance * (1 + r) + monthlyContribution;
      if (balance < 0) balance = 0; // floor at zero
      if (m % 12 === 0) {
        yearlyAll[base + m / 12] = balance;
      }
    }
  }

  // Per-year percentiles.
  const p05 = new Array(years);
  const p25 = new Array(years);
  const p50 = new Array(years);
  const p75 = new Array(years);
  const p95 = new Array(years);
  const colBuf = new Float64Array(numPaths);

  for (let y = 0; y < years; y++) {
    for (let p = 0; p < numPaths; p++) colBuf[p] = yearlyAll[p * years + y];
    const sorted = Array.from(colBuf).sort((a, b) => a - b);
    p05[y] = quantileSorted(sorted, 0.05);
    p25[y] = quantileSorted(sorted, 0.25);
    p50[y] = quantileSorted(sorted, 0.50);
    p75[y] = quantileSorted(sorted, 0.75);
    p95[y] = quantileSorted(sorted, 0.95);
  }

  // Sample N paths from the central 90% by terminal value.
  // The bands above are computed over all paths; this filter only
  // restricts which paths get drawn as overlay wisps, so the most
  // extreme outliers don't crowd the chart.
  const lastY = years - 1;
  const termLo = p05[lastY];
  const termHi = p95[lastY];
  const eligible = [];
  for (let p = 0; p < numPaths; p++) {
    const term = yearlyAll[p * years + lastY];
    if (term >= termLo && term <= termHi) eligible.push(p);
  }
  const sampleIdx = new Set();
  const targetCount = Math.min(samplePaths, eligible.length);
  while (sampleIdx.size < targetCount) {
    sampleIdx.add(eligible[Math.floor(Math.random() * eligible.length)]);
  }
  const sampled = [];
  for (const idx of sampleIdx) {
    const row = new Array(years);
    const base = idx * years;
    for (let y = 0; y < years; y++) row[y] = yearlyAll[base + y];
    sampled.push(row);
  }

  const deterministic = deterministicPath({
    horizonYears, startingBalance, monthlyContribution, mu,
  });

  const xYears = Array.from({ length: years }, (_, i) => i);

  return {
    xYears, p05, p25, p50, p75, p95, deterministic, sampled,
    // Full per-path yearly matrix, exposed for compare mode (path pairing).
    paths: yearlyAll, numPaths, years,
  };
}
