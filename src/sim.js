// Monte Carlo simulation core.
// Monthly steps, yearly snapshots, percentile aggregation.
// Supports an optional drawdown phase: accumulation up to the
// retirement month, then withdrawals from a two-bucket portfolio.

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
// [path * months + month] layout, for use as `preGenZ` (or its
// defensive-bucket counterpart) so multiple simulate() calls can
// share the same market sequence.
export function generateShocks(numPaths, months) {
  const out = new Float64Array(numPaths * months);
  for (let i = 0; i < out.length; i++) out[i] = randn();
  return out;
}

// Pre-generate a flat Float64Array of uniform[0,1) draws used to
// transition the regime state. Same row-major layout as the return
// shocks. Sharing this across paired scenarios in compare mode keeps
// the regime sequence (mostly) aligned, so the comparison isolates
// strategy differences from regime luck.
export function generateUniforms(numPaths, months) {
  const out = new Float64Array(numPaths * months);
  for (let i = 0; i < out.length; i++) out[i] = Math.random();
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

// Deterministic compound path. Accumulation uses (μ/12) compounding
// plus contribution. If drawdown is provided, post-retirement months
// strip the contribution and withdraw annualWithdrawal/12 per month.
function deterministicPath({
  horizonYears, startingBalance, monthlyContribution, mu, drawdown,
}) {
  const months = horizonYears * 12;
  const rMonthly = mu / 12;
  const yearly = new Array(horizonYears + 1);
  let balance = startingBalance;
  yearly[0] = balance;
  for (let m = 1; m <= months; m++) {
    if (!drawdown || m <= drawdown.retirementMonth) {
      balance = balance * (1 + rMonthly) + monthlyContribution;
    } else {
      balance = balance * (1 + rMonthly) - drawdown.annualWithdrawal / 12;
      if (balance < 0) balance = 0;
    }
    if (m % 12 === 0) yearly[m / 12] = balance;
  }
  return yearly;
}

export function simulate({
  horizonYears,
  startingBalance,
  monthlyContribution,
  mu,
  // Regime-switching variance. Long-run σ comes from calibrating the
  // weighted variance across the two states; that calibration lives
  // in profiles.js. The engine just consumes per-state σ + transition
  // probabilities.
  sigma_normal,
  sigma_stress,
  p_stay_normal,
  p_stay_stress,
  numPaths = NUM_PATHS,
  samplePaths = SAMPLE_PATHS,
  // Optional shared N(0,1) shock matrix for monthly returns.
  preGenZ = null,
  // Optional shared U(0,1) draw matrix for regime transitions. Same
  // layout as preGenZ. Sharing this in compare mode keeps the regime
  // sequence aligned across paired scenarios.
  preGenU = null,
  // Drawdown config. When supplied, accumulation runs up to
  // retirementMonth, then contributions stop and a fixed-real
  // withdrawal of (annualWithdrawal / 12) is taken each month.
  //   { retirementMonth, annualWithdrawal }
  drawdown = null,
}) {
  const months = horizonYears * 12;
  const years = horizonYears + 1;
  const rMonthly = mu / 12;
  const sigmaNormalMonthly = sigma_normal / Math.sqrt(12);
  const sigmaStressMonthly = sigma_stress / Math.sqrt(12);

  const isDrawdown = drawdown !== null;
  const retirementMonth = isDrawdown ? drawdown.retirementMonth : months + 1;
  const monthlyWithdrawal = isDrawdown ? drawdown.annualWithdrawal / 12 : 0;

  const yearlyAll = new Float64Array(numPaths * years);
  const ruined = isDrawdown ? new Uint8Array(numPaths) : null;

  for (let p = 0; p < numPaths; p++) {
    let balance = startingBalance;
    let isRuined = false;
    // 0 = NORMAL, 1 = STRESS. Every path starts in NORMAL — running
    // a long horizon, the chain converges to the stationary
    // distribution well within the first few years.
    let regime = 0;

    const base = p * years;
    const zBase = p * months;
    yearlyAll[base + 0] = balance;

    for (let m = 1; m <= months; m++) {
      if (isRuined) {
        if (m % 12 === 0) yearlyAll[base + m / 12] = 0;
        continue;
      }

      // Regime transition: stay with probability p_stay; otherwise flip.
      const u = preGenU ? preGenU[zBase + (m - 1)] : Math.random();
      if (regime === 0) {
        if (u >= p_stay_normal) regime = 1;
      } else {
        if (u >= p_stay_stress) regime = 0;
      }
      const sigmaThis = regime === 0 ? sigmaNormalMonthly : sigmaStressMonthly;

      const z = preGenZ ? preGenZ[zBase + (m - 1)] : randn();
      const r = rMonthly + sigmaThis * z;
      balance = balance * (1 + r);

      if (m <= retirementMonth) {
        balance += monthlyContribution;
      } else {
        balance -= monthlyWithdrawal;
        if (balance <= 0) {
          balance = 0;
          isRuined = true;
        }
      }
      if (balance < 0) balance = 0;

      if (m % 12 === 0) {
        yearlyAll[base + m / 12] = isRuined ? 0 : balance;
      }
    }

    if (isRuined) ruined[p] = 1;
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

  // Sample N paths uniformly at random.
  const sampleIdx = new Set();
  const targetCount = Math.min(samplePaths, numPaths);
  while (sampleIdx.size < targetCount) {
    sampleIdx.add(Math.floor(Math.random() * numPaths));
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
    drawdown: isDrawdown ? {
      retirementMonth,
      annualWithdrawal: drawdown.annualWithdrawal,
    } : null,
  });

  const xYears = Array.from({ length: years }, (_, i) => i);

  let ruinedFraction = 0;
  if (isDrawdown) {
    let count = 0;
    for (let p = 0; p < numPaths; p++) if (ruined[p]) count++;
    ruinedFraction = count / numPaths;
  }

  return {
    xYears, p05, p25, p50, p75, p95, deterministic, sampled,
    paths: yearlyAll, numPaths, years,
    ruined, ruinedFraction,
  };
}
