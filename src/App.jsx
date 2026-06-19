import React, { useState, useMemo, useCallback } from 'react';
import {
  LineChart,
  ComposedChart,
  Line,
  Bar,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceDot,
  Cell,
} from 'recharts';
import {
  CC_CAP,
  NCC_CAP,
  CARRY_FORWARD,
  DIV293,
  SG_RATE,
  SG_MAX_BASE_ANNUAL_2025_26,
  CONTRIB_AGE_LIMIT,
  C,
  FONT,
  HIDE_SPINNERS,
} from './config.js';
import {
  computeCarryForward,
  availableCC,
  availableNCC,
  taxSaving,
  projectScenarios,
  recommendStrategy,
  bucketsForExpiryView,
  fmt,
  fmtK,
  pct,
} from './engine.js';

// ───────────── default member state ─────────────

const defaultHistory = () => [
  { fy: '2019/20', ccMade: 6894.23, tsbPriorJune: 100000 },
  { fy: '2020/21', ccMade: 10086.10, tsbPriorJune: 120000 },
  { fy: '2021/22', ccMade: 8570.46, tsbPriorJune: 150000 },
  { fy: '2022/23', ccMade: 6912.14, tsbPriorJune: 180000 },
  { fy: '2023/24', ccMade: 10031.96, tsbPriorJune: 220000 },
  { fy: '2024/25', ccMade: 16999.84, tsbPriorJune: 280000 },
];

const defaultMember = (label) => ({
  name: label,
  age: 45,
  salary: 145000,
  taxableIncome: 145000,
  currentBalance: 320000,
  tsbPriorJune: 320000,
  history: defaultHistory(),
  currentFY: '2025/26',
  strategyMode: 'optimal',
  knowCC: 10000,
  knowNCC: 0,
  preset: 'custom',
  objective: 'maxTaxSaving',
  affordability: 30000,
});

// ───────────── helpers ─────────────

const styles = {
  page: {
    minHeight: '100vh',
    background: C.bg,
    color: C.text,
    fontFamily: FONT.body,
  },
  nav: {
    background: C.card,
    borderBottom: `1px solid ${C.border}`,
    padding: '14px 28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    position: 'sticky',
    top: 0,
    zIndex: 50,
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    fontFamily: FONT.heading,
    fontWeight: 700,
    fontSize: 18,
    color: C.text,
  },
  brandDot: {
    width: 14,
    height: 14,
    background: C.primary,
    borderRadius: 4,
    transform: 'rotate(45deg)',
  },
  modeSwitch: {
    display: 'flex',
    gap: 6,
    background: C.bg,
    padding: 4,
    borderRadius: 8,
    border: `1px solid ${C.border}`,
  },
  modeBtn: (active) => ({
    padding: '6px 14px',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    background: active ? C.card : 'transparent',
    color: active ? C.text : C.textMuted,
    boxShadow: active ? C.shadow : 'none',
  }),
  layoutGrid: {
    display: 'grid',
    gridTemplateColumns: '420px 1fr',
    gap: 20,
    padding: 20,
    maxWidth: 1600,
    margin: '0 auto',
  },
  card: {
    background: C.card,
    borderRadius: 12,
    padding: 18,
    border: `1px solid ${C.border}`,
    boxShadow: C.shadow,
    marginBottom: 16,
  },
  cardTitle: {
    fontFamily: FONT.heading,
    fontWeight: 600,
    fontSize: 14,
    color: C.text,
    marginBottom: 14,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    letterSpacing: '-0.005em',
  },
  inputRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 10,
  },
  inputLabel: {
    fontSize: 13,
    color: C.textMuted,
    flex: 1,
  },
  inputWrap: {
    position: 'relative',
    minWidth: 130,
  },
  inputPrefix: {
    position: 'absolute',
    left: 8,
    top: '50%',
    transform: 'translateY(-50%)',
    color: C.textSubtle,
    fontSize: 13,
    fontFamily: FONT.mono,
    pointerEvents: 'none',
  },
  input: (hasPrefix = true) => ({
    width: '100%',
    padding: hasPrefix ? '8px 10px 8px 22px' : '8px 10px',
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    fontSize: 13,
    fontFamily: FONT.mono,
    background: C.card,
    color: C.text,
    textAlign: 'right',
  }),
  selectInput: {
    width: '100%',
    padding: '8px 10px',
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    fontSize: 13,
    fontFamily: FONT.body,
    background: C.card,
    color: C.text,
  },
  btnTab: (active, color = C.primary) => ({
    padding: '10px 14px',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    borderRadius: 0,
    cursor: 'pointer',
    background: 'transparent',
    color: active ? color : C.textMuted,
    borderBottom: active ? `2px solid ${color}` : `2px solid transparent`,
    transition: 'color 0.15s, border-color 0.15s',
  }),
  primaryBtn: {
    padding: '10px 18px',
    background: C.primary,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: FONT.body,
  },
  secondaryBtn: {
    padding: '8px 14px',
    background: C.card,
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: FONT.body,
  },
};

// ───────────── small components ─────────────

const Card = ({ title, action, children, style }) => (
  <div style={{ ...styles.card, ...style }}>
    {title && (
      <div style={styles.cardTitle}>
        <span>{title}</span>
        {action}
      </div>
    )}
    {children}
  </div>
);

const InputField = ({ label, value, onChange, prefix = '$', suffix, step = '1', min = 0, type = 'number' }) => (
  <div style={styles.inputRow}>
    <span style={styles.inputLabel}>{label}</span>
    <div style={styles.inputWrap}>
      {prefix && type === 'number' && <span style={styles.inputPrefix}>{prefix}</span>}
      <input
        type={type}
        className="no-spinner"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          onChange(type === 'number' ? (v === '' ? 0 : Number(v)) : v);
        }}
        step={step}
        min={min}
        style={styles.input(prefix && type === 'number')}
      />
      {suffix && (
        <span style={{ ...styles.inputPrefix, left: 'auto', right: 8 }}>{suffix}</span>
      )}
    </div>
  </div>
);

const SelectField = ({ label, value, onChange, options }) => (
  <div style={styles.inputRow}>
    <span style={styles.inputLabel}>{label}</span>
    <div style={styles.inputWrap}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={styles.selectInput}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  </div>
);

const EligibilityChip = ({ ok, label, info }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
      borderRadius: 999,
      background: ok ? C.greenLight : C.amberLight,
      color: ok ? '#166534' : '#92400e',
      fontSize: 11,
      fontWeight: 600,
      marginRight: 6,
      marginBottom: 6,
    }}
    title={info || ''}
  >
    <span style={{ width: 6, height: 6, borderRadius: '50%', background: ok ? C.green : C.amber }} />
    {label}
  </div>
);

const StatCard = ({ label, value, sublabel, color = C.text }) => (
  <div
    style={{
      background: C.card,
      borderRadius: 10,
      padding: 14,
      border: `1px solid ${C.border}`,
      flex: 1,
      minWidth: 140,
    }}
  >
    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {label}
    </div>
    <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: FONT.mono, marginTop: 4 }}>
      {value}
    </div>
    {sublabel && (
      <div style={{ fontSize: 11, color: C.textSubtle, marginTop: 2 }}>{sublabel}</div>
    )}
  </div>
);

const CustomTooltip = ({ active, payload, label, formatter = fmt }) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: '10px 12px',
        boxShadow: C.shadowLg,
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: C.text }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
          <span style={{ color: C.textMuted, minWidth: 110 }}>{p.name}</span>
          <span style={{ fontFamily: FONT.mono, fontWeight: 600 }}>{formatter(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

// ───────────── chart panels ─────────────

const CarryForwardChart = ({ historyRows, currentFY, color }) => {
  const data = historyRows.map((r) => ({
    fy: r.fy,
    cap: Math.round(r.ccCap),
    totalAvailable: Math.round(r.totalAvailable),
    carriedForward: Math.round(r.carriedForward),
    ccMade: Math.round(r.ccMade),
  }));
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 10, right: 20, bottom: 5, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="fy" tick={{ fontSize: 11, fill: C.textMuted }} stroke={C.borderStrong} />
        <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: C.textMuted }} stroke={C.borderStrong} />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="ccMade" name="CCs made" fill={C.primaryLight} />
        <Bar dataKey="carriedForward" name="Carried forward" fill={color || C.primary} />
        <Line dataKey="totalAvailable" name="Total cap (incl. carried)" stroke={C.amber} strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

const UtilisationChart = ({ historyRows, color }) => {
  const data = historyRows.map((r) => ({
    fy: r.fy,
    used: Math.round(r.ccMade),
    available: Math.round(r.totalAvailable - r.ccMade),
  }));
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 10, right: 20, bottom: 5, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="fy" tick={{ fontSize: 11, fill: C.textMuted }} stroke={C.borderStrong} />
        <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: C.textMuted }} stroke={C.borderStrong} />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="used" name="Used" stackId="a" fill={color || C.primary} />
        <Bar dataKey="available" name="Unused" stackId="a" fill={C.amberLight} />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

const BalanceChart = ({ scenarioData, sliderYear, color }) => {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={scenarioData} margin={{ top: 10, right: 20, bottom: 5, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="fy" tick={{ fontSize: 11, fill: C.textMuted }} stroke={C.borderStrong} />
        <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: C.textMuted }} stroke={C.borderStrong} />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="baseBalance" name="Baseline (SG only)" stroke={C.textSubtle} fill="#f1f5f9" />
        <Line type="monotone" dataKey="withBalance" name="With strategy" stroke={color || C.primary} strokeWidth={3} dot={false} />
        {sliderYear != null && scenarioData[sliderYear - 1] && (
          <ReferenceLine x={scenarioData[sliderYear - 1].fy} stroke={C.amber} strokeWidth={1.5} strokeDasharray="4 3" />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
};

const TaxSavedChart = ({ scenarioData, color }) => (
  <ResponsiveContainer width="100%" height={300}>
    <ComposedChart data={scenarioData} margin={{ top: 10, right: 20, bottom: 5, left: 10 }}>
      <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
      <XAxis dataKey="fy" tick={{ fontSize: 11, fill: C.textMuted }} stroke={C.borderStrong} />
      <YAxis tickFormatter={fmtK} tick={{ fontSize: 11, fill: C.textMuted }} stroke={C.borderStrong} />
      <Tooltip content={<CustomTooltip />} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
      <Bar dataKey="yearTaxSaved" name="Annual tax saved" fill={C.primaryLight} />
      <Line type="monotone" dataKey="cumTaxSaved" name="Cumulative tax saved" stroke={color || C.primary} strokeWidth={3} dot={false} />
    </ComposedChart>
  </ResponsiveContainer>
);

const ExpiryBars = ({ expiryView }) => {
  if (!expiryView.length) return null;
  return (
    <ResponsiveContainer width="100%" height={160}>
      <ComposedChart data={expiryView} margin={{ top: 10, right: 10, bottom: 5, left: 10 }} layout="vertical">
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis type="number" tickFormatter={fmtK} tick={{ fontSize: 10, fill: C.textMuted }} stroke={C.borderStrong} />
        <YAxis type="category" dataKey="originFY" tick={{ fontSize: 11, fill: C.textMuted }} stroke={C.borderStrong} width={70} />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey="remaining" name="Unused cap remaining">
          {expiryView.map((d, i) => (
            <Cell
              key={i}
              fill={d.status === 'expired' ? C.red : d.status === 'expiringSoon' ? C.amber : C.green}
            />
          ))}
        </Bar>
      </ComposedChart>
    </ResponsiveContainer>
  );
};

// ───────────── App ─────────────

export default function App() {
  const [mode, setMode] = useState('setup');
  const [coupleMode, setCoupleMode] = useState(false);
  const [activeMember, setActiveMember] = useState('A');
  const [memberA, setMemberA] = useState(() => defaultMember('Client A'));
  const [memberB, setMemberB] = useState(() => defaultMember('Client B'));
  const [returnRate, setReturnRate] = useState(0.07);
  const [years, setYears] = useState(15);
  const [chartTab, setChartTab] = useState('balance');
  const [sliderYear, setSliderYear] = useState(1);
  const [showAssumptions, setShowAssumptions] = useState(false);

  const current = activeMember === 'A' ? memberA : memberB;
  const setCurrent = activeMember === 'A' ? setMemberA : setMemberB;
  const accentColor = coupleMode ? (activeMember === 'A' ? C.memberA : C.memberB) : C.primary;

  const updateField = useCallback((field, value) => {
    setCurrent((s) => ({ ...s, [field]: value }));
  }, [setCurrent]);

  const updateHistory = useCallback((idx, field, value) => {
    setCurrent((s) => ({
      ...s,
      history: s.history.map((r, i) => (i === idx ? { ...r, [field]: value } : r)),
    }));
  }, [setCurrent]);

  // ───── derive for current member ─────

  const computeMemberDerived = (m) => {
    const historyRows = computeCarryForward(m.history);
    const lastRow = historyRows[historyRows.length - 1];
    const carryFwd = lastRow?.carriedForward ?? 0;
    const buckets = lastRow?.bucketsAfter ?? [];
    const expiryView = bucketsForExpiryView(historyRows, m.currentFY);

    const sgBase = Math.min(m.salary, SG_MAX_BASE_ANNUAL_2025_26);
    const sg = Math.round(sgBase * (SG_RATE[m.currentFY] ?? 0.12));
    const cc = availableCC({
      fy: m.currentFY,
      sg,
      salarySacrifice: 0,
      personalDeductible: 0,
      carryForwardAvailable: carryFwd,
      tsbPriorJune: m.tsbPriorJune,
      taxableIncome: m.taxableIncome,
    });
    const ncc = availableNCC({
      fy: m.currentFY,
      tsbPriorJune: m.tsbPriorJune,
      ncCMadeThisYear: 0,
      age: m.age,
    });
    const recommendation = recommendStrategy({
      fy: m.currentFY,
      taxableIncome: m.taxableIncome,
      carryForwardAvailable: carryFwd,
      tsbPriorJune: m.tsbPriorJune,
      age: m.age,
      sg,
      objective: m.objective,
      affordability: m.affordability,
      bucketsAfter: buckets,
    });

    let extraCC = 0;
    let extraNCC = 0;
    if (m.strategyMode === 'know') {
      extraCC = m.knowCC;
      extraNCC = m.knowNCC;
    } else {
      extraCC = recommendation.recommended;
      extraNCC = 0;
    }

    const totalCC = sg + extraCC;
    const taxSavingResult = taxSaving({
      fy: m.currentFY,
      taxableIncome: m.taxableIncome,
      contribution: extraCC,
      div293Income: m.taxableIncome + totalCC,
    });

    const scenario = projectScenarios({
      startBalance: m.currentBalance,
      fy: m.currentFY,
      years,
      returnRate,
      withStrategy: { cc: totalCC, ncc: extraNCC },
      baseline: { cc: sg, ncc: 0 },
      taxableIncome: m.taxableIncome,
    });

    return {
      historyRows,
      carryFwd,
      buckets,
      expiryView,
      sg,
      cc,
      ncc,
      recommendation,
      extraCC,
      extraNCC,
      totalCC,
      taxSavingResult,
      scenario,
    };
  };

  const derivedA = useMemo(() => computeMemberDerived(memberA), [memberA, years, returnRate]);
  const derivedB = useMemo(() => computeMemberDerived(memberB), [memberB, years, returnRate]);
  const derived = activeMember === 'A' ? derivedA : derivedB;

  const combinedScenario = useMemo(() => {
    if (!coupleMode) return null;
    return derivedA.scenario.map((rowA, i) => {
      const rowB = derivedB.scenario[i];
      return {
        fy: rowA.fy,
        year: rowA.year,
        withBalance: rowA.withBalance + rowB.withBalance,
        baseBalance: rowA.baseBalance + rowB.baseBalance,
        delta: rowA.delta + rowB.delta,
        yearTaxSaved: rowA.yearTaxSaved + rowB.yearTaxSaved,
        cumTaxSaved: rowA.cumTaxSaved + rowB.cumTaxSaved,
        cc: rowA.cc + rowB.cc,
        ncc: rowA.ncc + rowB.ncc,
      };
    });
  }, [coupleMode, derivedA.scenario, derivedB.scenario]);

  const sliderRow = (combinedScenario ?? derived.scenario)[sliderYear - 1] ?? null;

  // ───── headline sentence ─────

  const headline = useMemo(() => {
    const { recommendation, scenario, taxSavingResult, extraCC } = derived;
    const endRow = scenario[scenario.length - 1];
    const finalDelta = endRow?.delta ?? 0;
    if (current.strategyMode === 'optimal') {
      const r = recommendation;
      const verb = r.benefitText.startsWith('extra') ? 'puts' : 'saves';
      return `Contributing ${fmt(r.recommended)} extra concessionally this FY ${verb} ${fmt(Math.abs(r.benefitValue))} ${r.benefitText} — and grows the projected balance by ${fmt(finalDelta)} over ${years} years.`;
    }
    if (extraCC > 0) {
      return `Contributing ${fmt(extraCC)} extra concessionally this FY saves ~${fmt(taxSavingResult.netSaving)} in net tax and grows projected balance by ${fmt(finalDelta)} over ${years} years.`;
    }
    return `No additional contributions modelled. Current trajectory projects ${fmt(endRow?.withBalance ?? 0)} in ${years} years.`;
  }, [derived, current.strategyMode, years]);

  // ───── presets ─────

  const applyPreset = (preset) => {
    if (preset === 'maxThis') {
      setCurrent((s) => ({
        ...s,
        strategyMode: 'know',
        preset,
        knowCC: derived.cc.remainingCap,
      }));
    } else if (preset === 'useCarryAll') {
      setCurrent((s) => ({
        ...s,
        strategyMode: 'know',
        preset,
        knowCC: derived.cc.usableCarry + derived.cc.baseCap - derived.sg,
      }));
    } else {
      setCurrent((s) => ({ ...s, preset: 'custom' }));
    }
  };

  // ───── render ─────

  return (
    <div style={styles.page}>
      <style>{HIDE_SPINNERS}</style>
      <NavBar mode={mode} setMode={setMode} />
      {mode === 'setup' ? (
        <SetupMode
          current={current}
          setCurrent={setCurrent}
          updateField={updateField}
          updateHistory={updateHistory}
          derived={derived}
          coupleMode={coupleMode}
          setCoupleMode={setCoupleMode}
          activeMember={activeMember}
          setActiveMember={setActiveMember}
          accentColor={accentColor}
          returnRate={returnRate}
          setReturnRate={setReturnRate}
          years={years}
          setYears={setYears}
          chartTab={chartTab}
          setChartTab={setChartTab}
          sliderYear={sliderYear}
          setSliderYear={setSliderYear}
          headline={headline}
          combinedScenario={combinedScenario}
          derivedA={derivedA}
          derivedB={derivedB}
          memberA={memberA}
          memberB={memberB}
          applyPreset={applyPreset}
          sliderRow={sliderRow}
        />
      ) : (
        <PresentationMode
          derived={derived}
          accentColor={accentColor}
          chartTab={chartTab}
          setChartTab={setChartTab}
          sliderYear={sliderYear}
          setSliderYear={setSliderYear}
          years={years}
          headline={headline}
          current={current}
          combinedScenario={combinedScenario}
          showAssumptions={showAssumptions}
          setShowAssumptions={setShowAssumptions}
          returnRate={returnRate}
          setReturnRate={setReturnRate}
          setYears={setYears}
          coupleMode={coupleMode}
          sliderRow={sliderRow}
        />
      )}
      <Disclaimer />
    </div>
  );
}

// ───────────── NavBar ─────────────

function NavBar({ mode, setMode }) {
  return (
    <div style={styles.nav}>
      <div style={styles.brand}>
        <span style={styles.brandDot} />
        <span>BalancePoint</span>
        <span style={{ color: C.textSubtle, fontWeight: 400, fontSize: 14, marginLeft: 4 }}>
          Contributions Planner
        </span>
      </div>
      <div style={styles.modeSwitch}>
        <button style={styles.modeBtn(mode === 'setup')} onClick={() => setMode('setup')}>Setup</button>
        <button style={styles.modeBtn(mode === 'presentation')} onClick={() => setMode('presentation')}>Presentation</button>
      </div>
    </div>
  );
}

// ───────────── Setup Mode ─────────────

function SetupMode({
  current,
  setCurrent,
  updateField,
  updateHistory,
  derived,
  coupleMode,
  setCoupleMode,
  activeMember,
  setActiveMember,
  accentColor,
  returnRate,
  setReturnRate,
  years,
  setYears,
  chartTab,
  setChartTab,
  sliderYear,
  setSliderYear,
  headline,
  combinedScenario,
  derivedA,
  derivedB,
  memberA,
  memberB,
  applyPreset,
  sliderRow,
}) {
  const isOptimal = current.strategyMode === 'optimal';
  const r = derived.recommendation;

  return (
    <div style={styles.layoutGrid}>
      {/* LEFT COLUMN — input cards */}
      <div>
        <Card title="Couple mode">
          <div style={{ display: 'flex', gap: 8, marginBottom: coupleMode ? 12 : 0 }}>
            <button
              onClick={() => setCoupleMode(false)}
              style={{
                ...styles.secondaryBtn,
                background: !coupleMode ? C.primary : C.card,
                color: !coupleMode ? '#fff' : C.text,
                borderColor: !coupleMode ? C.primary : C.border,
                flex: 1,
              }}
            >
              Single
            </button>
            <button
              onClick={() => setCoupleMode(true)}
              style={{
                ...styles.secondaryBtn,
                background: coupleMode ? C.primary : C.card,
                color: coupleMode ? '#fff' : C.text,
                borderColor: coupleMode ? C.primary : C.border,
                flex: 1,
              }}
            >
              Couple
            </button>
          </div>
          {coupleMode && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setActiveMember('A')}
                style={{
                  ...styles.secondaryBtn,
                  background: activeMember === 'A' ? C.memberA : C.memberALight,
                  color: activeMember === 'A' ? '#fff' : C.memberA,
                  borderColor: C.memberA,
                  flex: 1,
                  fontWeight: 600,
                }}
              >
                {memberA.name}
              </button>
              <button
                onClick={() => setActiveMember('B')}
                style={{
                  ...styles.secondaryBtn,
                  background: activeMember === 'B' ? C.memberB : C.memberBLight,
                  color: activeMember === 'B' ? '#fff' : C.memberB,
                  borderColor: C.memberB,
                  flex: 1,
                  fontWeight: 600,
                }}
              >
                {memberB.name}
              </button>
            </div>
          )}
        </Card>

        <Card title="Client details">
          <InputField label="Client name" value={current.name} onChange={(v) => updateField('name', v)} type="text" prefix={null} />
          <InputField label="Age" value={current.age} onChange={(v) => updateField('age', v)} prefix={null} suffix="yrs" />
          <InputField label="Annual salary" value={current.salary} onChange={(v) => updateField('salary', v)} />
          <InputField label="Taxable income" value={current.taxableIncome} onChange={(v) => updateField('taxableIncome', v)} />
          <InputField label="Current super balance" value={current.currentBalance} onChange={(v) => updateField('currentBalance', v)} />
          <InputField label="TSB at prior 30 June" value={current.tsbPriorJune} onChange={(v) => updateField('tsbPriorJune', v)} />
          <SelectField
            label="Planning FY"
            value={current.currentFY}
            onChange={(v) => updateField('currentFY', v)}
            options={[
              { value: '2024/25', label: '2024/25' },
              { value: '2025/26', label: '2025/26 (current)' },
              { value: '2026/27', label: '2026/27' },
            ]}
          />
        </Card>

        <Card title="Contribution strategy">
          <div style={{ display: 'flex', gap: 6, marginBottom: 14, background: C.bg, padding: 4, borderRadius: 8 }}>
            <button
              onClick={() => updateField('strategyMode', 'know')}
              style={styles.modeBtn(current.strategyMode === 'know')}
            >
              I know the amount
            </button>
            <button
              onClick={() => updateField('strategyMode', 'optimal')}
              style={styles.modeBtn(current.strategyMode === 'optimal')}
            >
              Find optimal
            </button>
          </div>
          {current.strategyMode === 'know' ? (
            <>
              <InputField label="Extra concessional this FY" value={current.knowCC} onChange={(v) => updateField('knowCC', v)} />
              <InputField label="Non-concessional this FY" value={current.knowNCC} onChange={(v) => updateField('knowNCC', v)} />
              <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                <button onClick={() => applyPreset('maxThis')} style={styles.secondaryBtn}>
                  Max this FY
                </button>
                <button onClick={() => applyPreset('useCarryAll')} style={styles.secondaryBtn}>
                  Use carry-forward
                </button>
                <button onClick={() => applyPreset('custom')} style={styles.secondaryBtn}>
                  Custom
                </button>
              </div>
            </>
          ) : (
            <>
              <SelectField
                label="Objective"
                value={current.objective}
                onChange={(v) => updateField('objective', v)}
                options={[
                  { value: 'maxTaxSaving', label: 'Maximise tax saving' },
                  { value: 'maxBalance', label: 'Maximise end balance' },
                  { value: 'useCarryForward', label: 'Use carry-forward before expiry' },
                ]}
              />
              <InputField label="Annual affordability ceiling" value={current.affordability} onChange={(v) => updateField('affordability', v)} />
            </>
          )}
        </Card>

        <Card title="Concessional history (FY → CCs made)">
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
            Edit prior-year contributions and TSB at prior 30 June to recompute carry-forward.
          </div>
          {current.history.map((row, i) => (
            <div key={row.fy} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 1fr', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: C.textMuted, fontFamily: FONT.mono }}>{row.fy}</span>
              <div style={styles.inputWrap}>
                <span style={styles.inputPrefix}>$</span>
                <input
                  type="number"
                  className="no-spinner"
                  value={row.ccMade}
                  step="0.01"
                  onChange={(e) => updateHistory(i, 'ccMade', Number(e.target.value))}
                  style={styles.input(true)}
                />
              </div>
              <div style={styles.inputWrap}>
                <span style={styles.inputPrefix}>$</span>
                <input
                  type="number"
                  className="no-spinner"
                  value={row.tsbPriorJune}
                  onChange={(e) => updateHistory(i, 'tsbPriorJune', Number(e.target.value))}
                  style={styles.input(true)}
                />
              </div>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 1fr', gap: 6, marginTop: 6 }}>
            <span />
            <span style={{ fontSize: 10, color: C.textSubtle, textAlign: 'right' }}>CCs made</span>
            <span style={{ fontSize: 10, color: C.textSubtle, textAlign: 'right' }}>TSB @ prior 30 Jun</span>
          </div>
        </Card>

        <Card title="Projection assumptions">
          <InputField label="Investment return p.a." value={(returnRate * 100).toFixed(1)} onChange={(v) => setReturnRate(v / 100)} prefix={null} suffix="%" step="0.1" />
          <InputField label="Projection horizon" value={years} onChange={setYears} prefix={null} suffix="yrs" />
        </Card>
      </div>

      {/* RIGHT COLUMN — outputs */}
      <div>
        {/* Headline for Find Optimal */}
        {isOptimal && (
          <Card>
            <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
              Recommended additional concessional contribution
            </div>
            <div style={{ fontSize: 42, fontWeight: 700, color: C.amber, fontFamily: FONT.mono, lineHeight: 1 }}>
              {fmt(r.recommended)}
            </div>
            <div style={{ fontSize: 14, color: C.textMuted, marginTop: 8 }}>
              Optimised for: <strong style={{ color: C.text }}>{r.optimisedFor}</strong>
            </div>
            <div style={{ fontSize: 14, color: C.textMuted, marginTop: 4 }}>
              Benefit: <strong style={{ color: C.green }}>{fmt(Math.abs(r.benefitValue))}</strong> {r.benefitText}
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                onClick={() =>
                  setCurrent((s) => ({ ...s, strategyMode: 'know', knowCC: r.recommended, knowNCC: 0 }))
                }
                style={styles.primaryBtn}
              >
                Apply & Compare
              </button>
              <span style={{ fontSize: 12, color: C.textMuted }}>
                Switches to "I know the amount" with this value
              </span>
            </div>
            <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap' }}>
              <EligibilityChip {...r.eligibility.tsbCarryGate} />
              <EligibilityChip {...r.eligibility.div293} />
              <EligibilityChip {...r.eligibility.ageLimit} />
              <EligibilityChip {...r.eligibility.workTest} info={r.eligibility.workTest.info} />
            </div>
          </Card>
        )}

        {/* Headline sentence */}
        <Card>
          <div style={{ fontSize: 18, fontFamily: FONT.heading, fontWeight: 500, lineHeight: 1.4, color: C.text }}>
            {headline}
          </div>
        </Card>

        {/* Stat cards */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <StatCard
            label="Carry-forward available"
            value={fmt(derived.carryFwd)}
            sublabel={derived.cc.canUseCarry ? 'TSB under $500k — usable' : 'TSB ≥ $500k — not usable'}
            color={derived.cc.canUseCarry ? C.primary : C.textSubtle}
          />
          <StatCard
            label="CC cap this FY"
            value={fmt(derived.cc.totalCap)}
            sublabel={`Base ${fmt(derived.cc.baseCap)} + Carry ${fmt(derived.cc.usableCarry)}`}
            color={accentColor}
          />
          <StatCard
            label="NCC available"
            value={fmt(derived.ncc.totalAvailable)}
            sublabel={`${derived.ncc.bringForwardYears}yr bring-forward`}
            color={C.text}
          />
          <StatCard
            label="Est. net tax saved (yr 1)"
            value={fmt(derived.taxSavingResult.netSaving)}
            sublabel={`MTR effective ${pct(derived.taxSavingResult.marginalRate)}`}
            color={derived.taxSavingResult.netSaving > 0 ? C.green : C.red}
          />
        </div>

        {/* Chart tabs + chart */}
        <Card title="Projections" action={
          <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}` }}>
            {[
              ['balance', 'Balance'],
              ['carryforward', 'Carry-forward'],
              ['utilisation', 'Cap utilisation'],
              ['tax', 'Tax saved'],
            ].map(([k, l]) => (
              <button key={k} onClick={() => setChartTab(k)} style={styles.btnTab(chartTab === k, accentColor)}>{l}</button>
            ))}
          </div>
        }>
          {chartTab === 'balance' && (
            <BalanceChart
              scenarioData={combinedScenario ?? derived.scenario}
              sliderYear={sliderYear}
              color={accentColor}
            />
          )}
          {chartTab === 'carryforward' && (
            <CarryForwardChart historyRows={derived.historyRows} currentFY={current.currentFY} color={accentColor} />
          )}
          {chartTab === 'utilisation' && (
            <UtilisationChart historyRows={derived.historyRows} color={accentColor} />
          )}
          {chartTab === 'tax' && (
            <TaxSavedChart scenarioData={combinedScenario ?? derived.scenario} color={accentColor} />
          )}
          <div style={{ marginTop: 12 }}>
            <input
              type="range"
              min="1"
              max={years}
              value={sliderYear}
              onChange={(e) => setSliderYear(Number(e.target.value))}
              style={{ width: '100%', accentColor }}
            />
            {sliderRow && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.textMuted, marginTop: 4 }}>
                <span>Year {sliderYear} — {sliderRow.fy}</span>
                <span>Age {current.age + sliderYear - 1}</span>
                <span>With strategy: <strong style={{ color: C.text, fontFamily: FONT.mono }}>{fmt(sliderRow.withBalance)}</strong></span>
                <span>Delta: <strong style={{ color: C.green, fontFamily: FONT.mono }}>+{fmt(sliderRow.delta)}</strong></span>
              </div>
            )}
          </div>
        </Card>

        {/* Carry-forward expiry */}
        <Card title="Carry-forward expiry — use it or lose it">
          <ExpiryBars expiryView={derived.expiryView} />
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11 }}>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: C.green, borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />Available</span>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: C.amber, borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />Expiring within 12 months</span>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, background: C.red, borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />Expired</span>
          </div>
        </Card>

        {/* Carry-forward table */}
        <Card title="Carry-forward detail">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, fontFamily: FONT.mono, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: C.bg }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontFamily: FONT.body, fontWeight: 600, color: C.textMuted }}>FY</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontFamily: FONT.body, fontWeight: 600, color: C.textMuted }}>Cap</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontFamily: FONT.body, fontWeight: 600, color: C.textMuted }}>Total available</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontFamily: FONT.body, fontWeight: 600, color: C.textMuted }}>CCs made</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontFamily: FONT.body, fontWeight: 600, color: C.textMuted }}>Carried fwd</th>
                </tr>
              </thead>
              <tbody>
                {derived.historyRows.map((r) => (
                  <tr key={r.fy} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: '6px 10px', fontFamily: FONT.body }}>{r.fy}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmt(r.ccCap)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmt(r.totalAvailable)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>${r.ccMade.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', color: C.primary, fontWeight: 600 }}>{fmt(r.carriedForward)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {coupleMode && (
          <Card title="Combined household snapshot">
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <StatCard label={`${memberA.name} carry-fwd`} value={fmt(derivedA.carryFwd)} color={C.memberA} />
              <StatCard label={`${memberB.name} carry-fwd`} value={fmt(derivedB.carryFwd)} color={C.memberB} />
              <StatCard
                label="Combined tax saved (yr 1)"
                value={fmt(derivedA.taxSavingResult.netSaving + derivedB.taxSavingResult.netSaving)}
                color={C.green}
              />
              <StatCard
                label={`Combined balance yr ${years}`}
                value={fmt(combinedScenario[combinedScenario.length - 1]?.withBalance ?? 0)}
                color={C.primary}
              />
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ───────────── Presentation Mode ─────────────

function PresentationMode({
  derived,
  accentColor,
  chartTab,
  setChartTab,
  sliderYear,
  setSliderYear,
  years,
  headline,
  current,
  combinedScenario,
  showAssumptions,
  setShowAssumptions,
  returnRate,
  setReturnRate,
  setYears,
  coupleMode,
  sliderRow,
}) {
  const scenarioData = combinedScenario ?? derived.scenario;

  return (
    <div style={{ padding: 28, maxWidth: 1400, margin: '0 auto', position: 'relative', minHeight: 'calc(100vh - 60px)' }}>
      {/* Headline */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
          {current.name} — {current.currentFY}
        </div>
        <div style={{ fontSize: 20, fontFamily: FONT.heading, fontWeight: 500, lineHeight: 1.4, color: C.text, maxWidth: 1100 }}>
          {headline}
        </div>
      </div>

      {/* Chart tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, marginBottom: 16 }}>
        {[
          ['balance', 'Balance projection'],
          ['carryforward', 'Carry-forward position'],
          ['utilisation', 'Cap utilisation'],
          ['tax', 'Tax saved over time'],
        ].map(([k, l]) => (
          <button key={k} onClick={() => setChartTab(k)} style={{ ...styles.btnTab(chartTab === k, accentColor), padding: '12px 18px', fontSize: 14 }}>
            {l}
          </button>
        ))}
      </div>

      {/* Chart full width */}
      <div style={{ background: C.card, borderRadius: 12, padding: 20, border: `1px solid ${C.border}`, boxShadow: C.shadow }}>
        <div style={{ height: 420 }}>
          {chartTab === 'balance' && (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={scenarioData}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="fy" tick={{ fontSize: 12, fill: C.textMuted }} stroke={C.borderStrong} />
                <YAxis tickFormatter={fmtK} tick={{ fontSize: 12, fill: C.textMuted }} stroke={C.borderStrong} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 13 }} />
                <Area type="monotone" dataKey="baseBalance" name="Baseline (SG only)" stroke={C.textSubtle} fill="#f1f5f9" />
                <Line type="monotone" dataKey="withBalance" name="With strategy" stroke={accentColor} strokeWidth={3} dot={false} />
                {sliderRow && (
                  <>
                    <ReferenceLine x={sliderRow.fy} stroke={C.amber} strokeWidth={1.5} strokeDasharray="4 3" />
                    <ReferenceDot x={sliderRow.fy} y={sliderRow.withBalance} r={6} fill={accentColor} stroke="#fff" strokeWidth={2} />
                  </>
                )}
              </ComposedChart>
            </ResponsiveContainer>
          )}
          {chartTab === 'carryforward' && (
            <CarryForwardChart historyRows={derived.historyRows} currentFY={current.currentFY} color={accentColor} />
          )}
          {chartTab === 'utilisation' && (
            <UtilisationChart historyRows={derived.historyRows} color={accentColor} />
          )}
          {chartTab === 'tax' && (
            <TaxSavedChart scenarioData={scenarioData} color={accentColor} />
          )}
        </div>
      </div>

      {/* Year slider */}
      <div style={{ marginTop: 24, background: C.card, borderRadius: 12, padding: 24, border: `1px solid ${C.border}`, boxShadow: C.shadow }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 22, fontFamily: FONT.mono, fontWeight: 700, color: C.text }}>
              Year {sliderYear} — {sliderRow?.fy}
            </div>
            <div style={{ fontSize: 14, color: C.textMuted, marginTop: 4 }}>
              Age {current.age + sliderYear - 1}
            </div>
          </div>
          {sliderRow && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Projected balance
              </div>
              <div style={{ fontSize: 26, fontFamily: FONT.mono, fontWeight: 700, color: accentColor }}>
                {fmt(sliderRow.withBalance)}
              </div>
              <div style={{ fontSize: 12, color: C.green, fontFamily: FONT.mono, fontWeight: 600 }}>
                +{fmt(sliderRow.delta)} vs baseline
              </div>
            </div>
          )}
        </div>
        <input
          type="range"
          min="1"
          max={years}
          value={sliderYear}
          onChange={(e) => setSliderYear(Number(e.target.value))}
          style={{ width: '100%', accentColor, height: 6, marginTop: 8 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.textSubtle, marginTop: 4 }}>
          <span>Year 1</span>
          <span>Year {years}</span>
        </div>
      </div>

      {/* Floating edit button */}
      <button
        onClick={() => setShowAssumptions(true)}
        style={{
          position: 'fixed',
          bottom: 28,
          right: 28,
          padding: '14px 22px',
          background: C.primary,
          color: '#fff',
          border: 'none',
          borderRadius: 999,
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          boxShadow: C.shadowLg,
          zIndex: 100,
        }}
      >
        Edit assumptions
      </button>

      {/* Slide-over */}
      {showAssumptions && (
        <div
          onClick={() => setShowAssumptions(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,0.4)',
            zIndex: 200,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              right: 0,
              top: 0,
              bottom: 0,
              width: 380,
              background: C.card,
              padding: 24,
              boxShadow: C.shadowLg,
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <h3 style={{ fontFamily: FONT.heading, fontWeight: 600, fontSize: 16 }}>Adjust assumptions</h3>
              <button onClick={() => setShowAssumptions(false)} style={{ ...styles.secondaryBtn, padding: '4px 10px' }}>Close</button>
            </div>
            <InputField label="Investment return p.a." value={(returnRate * 100).toFixed(1)} onChange={(v) => setReturnRate(v / 100)} prefix={null} suffix="%" step="0.1" />
            <InputField label="Projection horizon" value={years} onChange={setYears} prefix={null} suffix="yrs" />
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 12 }}>
              For full inputs return to Setup mode.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────── Disclaimer ─────────────

function Disclaimer() {
  return (
    <div style={{ padding: '20px 28px', borderTop: `1px solid ${C.border}`, background: C.card, marginTop: 32 }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', fontSize: 11, color: C.textMuted, lineHeight: 1.6 }}>
        <strong style={{ color: C.text }}>Assumptions & disclaimer.</strong> General information only — not personal advice.
        Figures use ATO data current as entered: concessional cap {fmt(CC_CAP['2025/26'])}, NCC annual cap {fmt(NCC_CAP['2025/26'].annual)},
        carry-forward TSB gate {fmt(CARRY_FORWARD.tsbGate)}, Div 293 threshold {fmt(DIV293.threshold)}.
        FY2026/27 caps ({fmt(CC_CAP['2026/27'])} concessional, {fmt(NCC_CAP['2026/27'].annual)} NCC, {fmt(NCC_CAP['2026/27'].bf3)} 3-yr bring-forward)
        are legislated/indexation-based and should be reconfirmed against ATO figures from 1 July 2026.
        Tax saving estimates use 2024/25 resident marginal rates plus 2% Medicare; do not include LITO, HELP, or other offsets.
        Projection compounds annually after a 15% in-fund contribution tax on concessional contributions.
        Member/spouse contributions accepted to age {CONTRIB_AGE_LIMIT} (+28 days). Work test (40 hrs / 30 days) applies for ages 67–74 for personal deductible contributions.
      </div>
    </div>
  );
}
