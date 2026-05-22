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
// plus contribution; if drawdown is provided, post-retirement months
// strip the contribution and instead withdraw annualWithdrawal/12 per
// month (fixed real, even when the stochastic strategy is something
// else — the deterministic line is meant to be a clean baseline).
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
  sigma,
  numPaths = NUM_PATHS,
  samplePaths = SAMPLE_PATHS,
  // Optional shared shock matrix for the growth bucket, Float64Array
  // of size numPaths*months in [path * months + monthIndex] layout
  // (monthIndex 0-based, so step m=1 reads index 0).
  preGenZ = null,
  // Optional drawdown config. When supplied, the simulation runs
  // accumulation up to retirementMonth and then a two-bucket
  // withdrawal phase to the end.
  //   {
  //     retirementMonth,           // 1..months; switch happens at end of this month
  //     annualWithdrawal,          // real $ per year at retirement
  //     defensiveYears,            // years of withdrawals to hold defensive
  //     strategy,                  // 'fixed-real' | 'fixed-pct' | 'guyton-klinger'
  //     defensiveMu, defensiveSigma,
  //     preGenZDefensive,          // optional shared defensive shock matrix
  //   }
  drawdown = null,
}) {
  const months = horizonYears * 12;
  const years = horizonYears + 1; // include year 0
  const rMonthly = mu / 12;
  const sigmaMonthly = sigma / Math.sqrt(12);

  const isDrawdown = drawdown !== null;
  const retirementMonth = isDrawdown ? drawdown.retirementMonth : months + 1; // never reached
  const dfMu = isDrawdown ? drawdown.defensiveMu / 12 : 0;
  const dfSigma = isDrawdown ? drawdown.defensiveSigma / Math.sqrt(12) : 0;
  const dfYears = isDrawdown ? drawdown.defensiveYears : 0;
  const dfStrategy = isDrawdown ? drawdown.strategy : null;
  const initialAnnualWithdrawal = isDrawdown ? drawdown.annualWithdrawal : 0;

  // Flat Float64Array: row-major [path * years + year].
  const yearlyAll = new Float64Array(numPaths * years);
  // Per-path ruin flag (1 = depleted to zero at some point).
  const ruined = isDrawdown ? new Uint8Array(numPaths) : null;

  for (let p = 0; p < numPaths; p++) {
    let growthBalance = startingBalance;
    let defensiveBalance = 0;
    let annualWithdrawal = initialAnnualWithdrawal;
    let initialWR = 0;
    let isRuined = false;

    const base = p * years;
    const zBase = p * months;
    yearlyAll[base + 0] = growthBalance;

    for (let m = 1; m <= months; m++) {
      if (isRuined) {
        if (m % 12 === 0) yearlyAll[base + m / 12] = 0;
        continue;
      }

      // Growth bucket return — applied every month regardless of phase.
      const z = preGenZ ? preGenZ[zBase + (m - 1)] : randn();
      const r = rMonthly + sigmaMonthly * z;
      growthBalance = growthBalance * (1 + r);

      if (m <= retirementMonth) {
        // Accumulation: contribute, no withdrawal.
        growthBalance += monthlyContribution;
        if (growthBalance < 0) growthBalance = 0;

        // At the boundary, split into buckets.
        if (m === retirementMonth && isDrawdown) {
          const total = growthBalance;
          const targetDef = initialAnnualWithdrawal * dfYears;
          if (targetDef >= total) {
            defensiveBalance = total;
            growthBalance = 0;
          } else {
            defensiveBalance = targetDef;
            growthBalance = total - targetDef;
          }
          initialWR = total > 0 ? initialAnnualWithdrawal / total : 0;
        }
      } else {
        // Drawdown: apply defensive return, withdraw, rebalance.
        const dIdx = m - 1; // index in absolute months
        const zd = drawdown.preGenZDefensive
          ? drawdown.preGenZDefensive[zBase + dIdx]
          : randn();
        const rd = dfMu + dfSigma * zd;
        defensiveBalance = defensiveBalance * (1 + rd);

        const totalBefore = growthBalance + defensiveBalance;
        let monthlyWithdrawal;
        if (dfStrategy === "fixed-pct") {
          monthlyWithdrawal = (initialWR / 12) * totalBefore;
        } else {
          monthlyWithdrawal = annualWithdrawal / 12;
        }
        if (monthlyWithdrawal < 0) monthlyWithdrawal = 0;

        // Take from defensive first, then growth. Mark ruin if both go.
        if (defensiveBalance >= monthlyWithdrawal) {
          defensiveBalance -= monthlyWithdrawal;
        } else {
          const remainder = monthlyWithdrawal - defensiveBalance;
          defensiveBalance = 0;
          if (growthBalance >= remainder) {
            growthBalance -= remainder;
          } else {
            growthBalance = 0;
            isRuined = true;
          }
        }

        // Rebalance defensive toward target (years × current annual withdrawal).
        if (!isRuined) {
          const totalNow = growthBalance + defensiveBalance;
          const targetNow = annualWithdrawal * dfYears;
          const targetActual = Math.min(targetNow, totalNow);
          if (defensiveBalance < targetActual && growthBalance > 0) {
            const transfer = Math.min(targetActual - defensiveBalance, growthBalance);
            defensiveBalance += transfer;
            growthBalance -= transfer;
          }
        }
      }

      // Year-end snapshot + G-K annual adjustment.
      if (m % 12 === 0) {
        const totalYear = isRuined ? 0 : growthBalance + defensiveBalance;
        yearlyAll[base + m / 12] = totalYear;

        if (isDrawdown && dfStrategy === "guyton-klinger" &&
            !isRuined && m > retirementMonth && totalYear > 0 && initialWR > 0) {
          const currentWR = annualWithdrawal / totalYear;
          if (currentWR > initialWR * 1.20) {
            annualWithdrawal = annualWithdrawal * 0.90;
          } else if (currentWR < initialWR * 0.80) {
            annualWithdrawal = annualWithdrawal * 1.10;
          }
          // else: hold in real terms.
        }
      }
    }

    if (isRuined) ruined[p] = 1;
  }

  // Per-year percentiles across all paths.
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
      annualWithdrawal: initialAnnualWithdrawal,
    } : null,
  });

  const xYears = Array.from({ length: years }, (_, i) => i);

  // Probability of ruin (fraction of paths that hit zero at any point).
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
