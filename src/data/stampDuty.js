// Residential transfer (stamp) duty — all eight Australian
// jurisdictions: general schedules, first-home-buyer concessions, and
// first home owner grants (new builds).
//
// AS AT 1 JULY 2025. Schedules are legislated nominal-dollar bracket
// tables and are NOT indexed here (disclosed in the Parameters modal);
// the per-property dutyOverride field exists for precision. Sources
// per state below are the revenue-office published scales current at
// the as-at date; VERIFY against the revenue offices before production
// use — this build environment could not reach them.
//
// FHB phase-outs are modelled as a LINEAR taper from full exemption at
// `exemptTo` to full duty at `phaseTo` — a documented simplification
// of each state's own concession formula. `newOnly: true` restricts
// the concession to new builds.
//
// General bracket rows: [floor, baseDuty, marginalRatePerDollar] —
// duty = base + rate × (price − floor) for the row whose floor is the
// largest not exceeding the price.

export const STAMP_DUTY_META = Object.freeze({
  asAt: "2025-07-01",
  note: "Nominal-dollar schedules held at their as-at values (not indexed); FHB tapers linearised. Use the duty override for precision.",
});

const SCHEDULES = {
  // Revenue NSW, transfer duty standard rates (FY2024-25 indexed scale)
  NSW: {
    brackets: [
      [0, 0, 0.0125],
      [17000, 212, 0.015],
      [36000, 497, 0.0175],
      [97000, 1564, 0.035],
      [364000, 10909, 0.045],
      [1212000, 49069, 0.055],
      [3636000, 182389, 0.07],
    ],
    fhb: { exemptTo: 800000, phaseTo: 1000000, newOnly: false }, // First Home Buyers Assistance Scheme
    fhog: { amount: 10000, cap: 750000 }, // new homes
  },
  // State Revenue Office Victoria, general land transfer duty
  VIC: {
    brackets: [
      [0, 0, 0.014],
      [25000, 350, 0.024],
      [130000, 2870, 0.06],
      [960000, 0, 0.055, "flat"],   // 960k–2m: 5.5% of the whole price
      [2000000, 110000, 0.065],
    ],
    fhb: { exemptTo: 600000, phaseTo: 750000, newOnly: false },
    fhog: { amount: 10000, cap: 750000 },
  },
  // Queensland Revenue Office, transfer duty general rate
  QLD: {
    brackets: [
      [0, 0, 0],
      [5000, 0, 0.015],
      [75000, 1050, 0.035],
      [540000, 17325, 0.045],
      [1000000, 38025, 0.0575],
    ],
    fhb: { exemptTo: 700000, phaseTo: 800000, newOnly: false }, // from June 2024
    fhog: { amount: 30000, cap: 750000 }, // new builds, extended program
  },
  // RevenueWA, general rate
  WA: {
    brackets: [
      [0, 0, 0.019],
      [120000, 2280, 0.0285],
      [150000, 3135, 0.038],
      [360000, 11115, 0.0475],
      [725000, 28453, 0.0515],
    ],
    fhb: { exemptTo: 450000, phaseTo: 600000, newOnly: false }, // first home owner rate
    fhog: { amount: 10000, cap: 750000 },
  },
  // RevenueSA, general (non-qualifying land) scale
  SA: {
    brackets: [
      [0, 0, 0.01],
      [12000, 120, 0.02],
      [30000, 480, 0.03],
      [50000, 1080, 0.035],
      [100000, 2830, 0.04],
      [200000, 6830, 0.0425],
      [250000, 8955, 0.0475],
      [300000, 11330, 0.05],
      [500000, 21330, 0.055],
    ],
    // SA: full exemption for NEW first homes (uncapped since Jun 2024);
    // no relief for established homes.
    fhb: { exemptTo: Infinity, phaseTo: Infinity, newOnly: true },
    fhog: { amount: 15000, cap: 650000 },
  },
  // State Revenue Office Tasmania
  TAS: {
    brackets: [
      [0, 50, 0],
      [3000, 50, 0.0175],
      [25000, 435, 0.0225],
      [75000, 1560, 0.035],
      [200000, 5935, 0.04],
      [375000, 12935, 0.0425],
      [725000, 27810, 0.045],
    ],
    fhb: { exemptTo: 750000, phaseTo: 750000, newOnly: false }, // 100% established-home exemption ≤ 750k
    fhog: { amount: 10000, cap: Infinity }, // new builds
  },
  // ACT Revenue Office, non-commercial conveyance scale. The ACT Home
  // Buyer Concession is income-tested with no price cap — modelled as
  // a full exemption (simplification; disclose via override).
  ACT: {
    brackets: [
      [0, 0, 0.012],
      [200000, 2400, 0.022],
      [300000, 4600, 0.034],
      [500000, 11400, 0.0432],
      [750000, 22200, 0.059],
      [1000000, 36950, 0.064],
      [1455000, 0, 0.0454, "flat"], // over 1,455,000: flat 4.54% of the whole price
    ],
    fhb: { exemptTo: Infinity, phaseTo: Infinity, newOnly: false },
    fhog: { amount: 0, cap: 0 }, // ACT grant abolished
  },
  // Territory Revenue Office NT: formula D = (0.06571441·V² + 15V)
  // where V = price/1000, for prices ≤ $525,000; marginal-free flat
  // percentages above.
  NT: {
    formula: (price) => {
      if (price <= 525000) {
        const V = price / 1000;
        return 0.06571441 * V * V + 15 * V;
      }
      if (price <= 3000000) return price * 0.0495;
      if (price <= 5000000) return price * 0.0575;
      return price * 0.0595;
    },
    fhb: { exemptTo: 0, phaseTo: 0, newOnly: true }, // no general FHB duty relief; grant-led support
    fhog: { amount: 50000, cap: Infinity }, // HomeGrown Territory grant, new homes (Oct 2024)
  },
};

export const STATES = Object.keys(SCHEDULES);

// General residential transfer duty at a nominal price.
export function transferDuty(stateCode, price) {
  const s = SCHEDULES[stateCode];
  if (!s || !(price > 0)) return 0;
  if (s.formula) return s.formula(price);
  let row = s.brackets[0];
  for (const b of s.brackets) {
    if (price >= b[0]) row = b;
    else break;
  }
  const [floor, base, rate, mode] = row;
  const duty = mode === "flat" ? price * rate : base + rate * (price - floor);
  return Math.max(0, duty);
}

// Duty payable including any first-home-buyer concession.
export function dutyWithConcessions(stateCode, price, { firstHomeBuyer = false, newBuild = false } = {}) {
  const general = transferDuty(stateCode, price);
  const s = SCHEDULES[stateCode];
  if (!s || !firstHomeBuyer) return general;
  const fhb = s.fhb;
  if (fhb.newOnly && !newBuild) return general;
  if (price <= fhb.exemptTo) return 0;
  if (price >= fhb.phaseTo) return general;
  // Linear taper between full exemption and full duty (simplified).
  return general * ((price - fhb.exemptTo) / (fhb.phaseTo - fhb.exemptTo));
}

// First home owner grant (new builds only), nominal dollars.
export function fhogAmount(stateCode, price, { firstHomeBuyer = false, newBuild = false } = {}) {
  const s = SCHEDULES[stateCode];
  if (!s || !firstHomeBuyer || !newBuild) return 0;
  if (price > s.fhog.cap) return 0;
  return s.fhog.amount;
}
