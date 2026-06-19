// BalancePoint Contributions Planner - configuration constants
// All caps, thresholds, and rates sourced from ATO/legislated data, June 2026.
// Any figure for FY2026/27 marked "FLAG" should be reconfirmed against ATO from 1 July 2026.

export const CC_CAP = {
  '2018/19': 25000,
  '2019/20': 25000,
  '2020/21': 25000,
  '2021/22': 27500,
  '2022/23': 27500,
  '2023/24': 27500,
  '2024/25': 30000,
  '2025/26': 30000,
  '2026/27': 32500,
};

export const NCC_CAP = {
  '2024/25': { annual: 120000, bf3: 360000 },
  '2025/26': { annual: 120000, bf3: 360000 },
  '2026/27': { annual: 130000, bf3: 390000 },
};

export const NCC_BF_TIERS_2025_26 = [
  { tsbUnder: 1760000, available: 360000, years: 3 },
  { tsbUnder: 1880000, available: 240000, years: 2 },
  { tsbUnder: 2000000, available: 120000, years: 1 },
  { tsbUnder: Infinity, available: 0, years: 0 },
];

export const NCC_BF_TIERS_2026_27 = [
  { tsbUnder: 1850000, available: 390000, years: 3 },
  { tsbUnder: 1980000, available: 260000, years: 2 },
  { tsbUnder: 2100000, available: 130000, years: 1 },
  { tsbUnder: Infinity, available: 0, years: 0 },
];

export const CARRY_FORWARD = {
  tsbGate: 500000,
  maxYears: 5,
  firstAvailableFY: '2019/20',
};

export const DIV293 = {
  threshold: 250000,
  extraRate: 0.15,
};

export const SG_RATE = {
  '2024/25': 0.115,
  '2025/26': 0.12,
  '2026/27': 0.12,
};

export const SG_MAX_BASE_QUARTERLY_2025_26 = 62500;
export const SG_MAX_BASE_ANNUAL_2025_26 = 250000;

export const TAX_BRACKETS_2025_26 = [
  { upTo: 18200, rate: 0 },
  { upTo: 45000, rate: 0.16 },
  { upTo: 135000, rate: 0.30 },
  { upTo: 190000, rate: 0.37 },
  { upTo: Infinity, rate: 0.45 },
];

export const TAX_BRACKETS_2026_27 = [
  { upTo: 18200, rate: 0 },
  { upTo: 45000, rate: 0.15 },
  { upTo: 135000, rate: 0.30 },
  { upTo: 190000, rate: 0.37 },
  { upTo: Infinity, rate: 0.45 },
];

export const TAX_BRACKETS_BY_FY = {
  '2024/25': TAX_BRACKETS_2025_26,
  '2025/26': TAX_BRACKETS_2025_26,
  '2026/27': TAX_BRACKETS_2026_27,
};

export const MEDICARE_LEVY = 0.02;
export const CONTRIB_TAX = 0.15;
export const CONTRIB_AGE_LIMIT = 75;

export const WORK_TEST = { agesFrom: 67, agesTo: 74, hours: 40, days: 30 };

export const DOWNSIZER = { cap: 300000, minAge: 55 };

export const CO_CONTRIBUTION_2025_26 = {
  max: 500,
  lower: 47488,
  upper: 62488,
  ageLimit: 71,
  tsbLimit: 2000000,
};

export const LISTO = { max: 500, incomeLimit: 37000 };

export const SPOUSE_OFFSET = {
  maxContrib: 3000,
  rate: 0.18,
  fullThreshold: 37000,
  cutout: 40000,
};

export const ALL_FY = [
  '2018/19',
  '2019/20',
  '2020/21',
  '2021/22',
  '2022/23',
  '2023/24',
  '2024/25',
  '2025/26',
  '2026/27',
];

export const C = {
  primary: '#0d9488',
  primaryDark: '#0f766e',
  primaryLight: '#5eead4',
  primaryBg: '#ccfbf1',
  bg: '#f8fafc',
  card: '#ffffff',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  text: '#0f172a',
  textMuted: '#475569',
  textSubtle: '#94a3b8',
  green: '#16a34a',
  greenLight: '#bbf7d0',
  amber: '#f59e0b',
  amberLight: '#fde68a',
  red: '#dc2626',
  redLight: '#fecaca',
  memberA: '#6366f1',
  memberB: '#ec4899',
  memberALight: '#e0e7ff',
  memberBLight: '#fce7f3',
  shadow: '0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04)',
  shadowLg: '0 10px 25px -5px rgba(15,23,42,0.10), 0 4px 6px -2px rgba(15,23,42,0.05)',
};

export const FONT = {
  heading: '"DM Sans", system-ui, sans-serif',
  body: '"Plus Jakarta Sans", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
};

export const HIDE_SPINNERS = `
  input.no-spinner::-webkit-outer-spin-button,
  input.no-spinner::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  input.no-spinner[type='number'] { -moz-appearance: textfield; }
  body { margin: 0; background: ${C.bg}; color: ${C.text}; font-family: ${FONT.body}; -webkit-font-smoothing: antialiased; }
  *, *::before, *::after { box-sizing: border-box; }
  button { font-family: ${FONT.body}; }
  h1, h2, h3, h4, h5 { font-family: ${FONT.heading}; margin: 0; }
  .mono { font-family: ${FONT.mono}; font-variant-numeric: tabular-nums; }
`;
