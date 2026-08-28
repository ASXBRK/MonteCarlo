# Assumptions and Provenance — Master Document

Every figure the engine uses that is not a hard legislated fact, with its
value, source, basis and rationale.

**Purpose.** A knowledgeable reviewer should be able to read this and either
agree with each line or point at the one they would change — rather than
being told "we decided to do X".

**Last verification pass:** August 2026 — twelve figure sets verified against
primary sources, six open questions resolved with the firm. Outstanding
actions are in §0.

**Classification** — LEGISLATED · HOUSE VIEW · RESEARCHED · DERIVED ·
UNVERIFIED. Every UNVERIFIED figure has a manual override.

---

# 0. STATUS

## 0.1 Resolved this pass

| Item | Resolution |
|---|---|
| Transfer balance cap $2.1m / NCC $130k | **Confirmed correct by the firm.** Conflicting secondary sources were stale. Our engine is right. |
| Wage growth basis | **Split.** Salary indexation **2.70%** (Xplan-aligned, WPI basis); super cap indexation **3.2%** (AWOTE — legislated basis). §1.2 |
| FBT employer types | **All types required**, with presets for every subtype. §4 |
| Land value proportion | **50% houses, 20% units**, both overridable. §7.4 |
| Accelerated Growth CMA inconsistency | **Resolved** — weights bent to the firm's stated returns, implied allocations documented. §2.3 |

## 0.2 Outstanding — engineering

| # | Item | Current | Should be | Severity |
|---|---|---|---|---|
| 1 | FBT caps entered as grossed-up | no guidance | cash **$15,900 / $9,010 / $2,650**, presets per subtype | **High** — silently doubles permitted packaging |
| 2 | FHSSS earnings rate | 7.94% | **7.43%** (Jul–Sep 2026), quarterly refresh | Medium |
| 3 | FHBG caps | as entered | Perth **$850,000**; income caps and place limits **removed** 1 Oct 2025 | Medium |
| 4 | Education bond beneficiary tax | unmodelled | assessable to beneficiary; **under-18 $416 trap** | Medium — changes the advice |
| 5 | Insurance premium indexation | CPI + 3% flat | **age-based curve** | Medium |
| 6 | Wage growth | single 3.5% | **split 2.70% / 3.2%** per §1.2 | Medium |
| 7 | Land value | 60%, no type split | **50% houses, 20% units** | Medium |
| 8 | Property expenses | 20% of rent | **25%** (midpoint of the supported range) | Low |

## 0.3 Outstanding — firm to supply
**The eight state duty and land tax schedules.** See §9 for exactly what is
needed and where to obtain it. This is the largest remaining barrier to
client use.

---

# 1. ECONOMIC PARAMETERS

## 1.1 CPI — 2.5%
**HOUSE VIEW, aligned to policy.** Midpoint of the RBA's 2–3% target band.
Using the midpoint rather than a recent outturn avoids anchoring a fifty-year
projection to a transient inflation episode. A reviewer who disagrees is
disagreeing with the RBA's target. **Sensitivity: high** — deflates the whole
real-terms engine.

## 1.2 Wage growth — RESOLVED: split by basis
**Firm decision, August 2026.**

| Use | Value | Basis |
|---|---|---|
| **Salary and wage indexation** | **2.70%** | WPI concept. Matches Xplan's own indexation screen and the realised 10–15 year WPI average (2.7% / 2.72% CAGR). Sits just below the RBA's estimate of the WPI-basis rate consistent with target inflation (~2.9%). |
| **Super cap indexation** | **3.2%** | AWOTE. **Not a preference — the statute indexes contribution caps on AWOTE.** 3.2% is the 10-year AWOTE average and the RBA's earnings-basis sustainable estimate. |

**Why the split rather than one figure.** Applying a WPI-basis rate to super
cap indexation would understate cap growth against the legislated basis; a
single 3.5% would overstate salary growth against every WPI measure. The
split is more accurate and no harder to implement.

Context: WPI **+3.2%** (year to June 2026); AWOTE **+3.7%** (year to May 2026
— the lowest annual increase since November 2022). Treasury forecasts WPI
3.5% for 2027–28. AiGroup cites long-run averages of 2.6% WPI, 3.1%
earnings.

**WA note:** WA AWOTE is **$2,227.60**, second highest of all jurisdictions
after the ACT — relevant to a Perth client base.

## 1.3 Mortgage rate — 6.0%
**HOUSE VIEW, decomposed.** Neutral real ~1% + CPI 2.5% + margin ~2.5%.
**Research note:** RBA models imply a **nominal neutral of ~2.9%** (mid-2024,
~0.7pp below the prior ~3.6%), with **real neutral as low as ~0.25%**. Our 1%
real neutral is at the top of the plausible range — the 6% headline remains
reasonable, but the neutral component is arguably ~0.5pp high.

## 1.4 FHSSS associated earnings rate — ⚠ 7.94% → 7.43%
**LEGISLATED.** FHSSS credits earnings at the **ATO Shortfall Interest
Charge** rate = 90-day Bank Accepted Bill rate **+ 3%**, set **quarterly**
(TAA 1953 s 280-105). Jan–Mar 2026 **6.65%** · Apr–Jun 2026 **6.96%** ·
**Jul–Sep 2026 7.43%**. Refresh quarterly from the ATO SIC page.

## 1.5 Age pension indexation — rates at wages, thresholds at CPI
**RESEARCHED.** Rates index twice yearly to the greater of CPI and the
Pensioner and Beneficiary Living Cost Index, then are benchmarked to a
minimum of **27.7% of Male Total Average Weekly Earnings** for the single
rate. Thresholds index annually to CPI.

Over a long horizon the MTAWE benchmark binds, so rates track wages while
thresholds track prices — the pension grows roughly **1% a year in real terms
relative to the thresholds**. Modelling rates at CPI would understate the age
pension by around a third over thirty years. This is the mechanism in the
legislation, not a judgement.
**Disclosed:** Centrelink steps 20 March and 20 September; our annual engine
applies indexation once at 1 July.

---

# 2. RETURN AND VOLATILITY

## 2.1 Profile returns — the firm's own, verified
**HOUSE VIEW.** Cash 3.50% · Defensive 4.50% · Moderately Defensive 5.20% ·
Balanced 5.85% · Moderate Growth 6.85% · High Growth 8.00% · Accelerated
Growth 9.50% · Residential Property 9.50%. Nominal, income plus growth.
**Verified to the basis point** against the firm's own `Investment
comparison` sheet for all seven base profiles.

## 2.2 Profile volatility (σ) — validated against the Standard Risk Measure
**HOUSE VIEW, independently validated.** Annual, real: Cash 1.5% · Defensive
3.0% · Moderately Defensive 4.5% · Balanced 6.0% · Moderate Growth 7.5% ·
High Growth 9.5% · Accelerated Growth 12.0% · Residential Property 11.0%.

The **ASFA/FSC Standard Risk Measure** (Guidance Paper, July 2011, issued at
APRA's request; in every Australian super PDS since June 2012) bands an
option by expected negative annual returns over 20 years: `20 × Φ(−μ/σ)`.

Against the bands **State Super discloses** (calculated by Frontier from
forward-looking CMAs):

| Our profile | Neg. yrs | Implied band | Disclosed comparable | |
|---|---|---|---|---|
| Cash | 0.2 | 1 Very low | Cash — band 1 | ✅ |
| Moderately Defensive | 2.5 | 4 Medium | Conservative — band 4 | ✅ |
| Balanced | 3.3 | 5 Medium to high | Balanced — band 5 | ✅ |
| Accelerated Growth | 4.3 | 6 High | Growth — band 6 | ✅ |

**Four for four.** The firm's volatility assumptions independently reproduce
the risk bands a real Australian super fund discloses under the regulatory
standard — substantially stronger than "we chose 6%".

**Boundary flagged:** High Growth implies 3.99 negative years, on the band
5/6 line. Real funds split on where they band high growth options.

**σ is in real terms.** Defensive-end values are deliberately higher than
nominal intuition suggests because real cash and bond variance is dominated
by *inflation* variance — hence Cash at 1.5% rather than near zero.

## 2.3 Asset class weights — RESOLVED
**RESEARCHED — our construction, fitted to the firm's returns.**

**The principle:** where the weights and the firm's stated returns disagree,
**the returns win.** The returns are verified house view; the weights are our
reconstruction. So the weights are fitted to reproduce each profile's stated
income figure, and the implied allocation is documented so the firm can
inspect it.

Franking is **derived** from these weights rather than stored separately, so
the two cannot disagree.

### The Accelerated Growth pair — previously flagged as inconsistent
Both figures are internally coherent once the implied allocation is worked
out. They are a deliberate income-versus-growth pair at the aggressive end.

**Accelerated Growth – Income (5.00% income, 4.50% growth).** Reachable only
if income is stated **grossed-up including franking credits**, which
Australian CMAs commonly do. At a grossed-up Australian equity yield of
~5.7%, an allocation of roughly **65% Australian equity, 20% property and
infrastructure, 13% international equity, 2% cash** produces ~4.94% income.
Coherent, and strongly home-biased — which is what an income mandate implies.

**Accelerated Growth – Growth (2.00% income, 7.50% growth).** Requires almost
no Australian equity: roughly **90% international equity, 8% property, 2%
cash** produces ~2.09% income. Coherent, and an unusually international
portfolio.

**For the CMA owner to confirm or correct:** these are the allocations your
stated returns imply. If Accelerated Growth – Growth is not intended to be
~90% international, the 2.00% income figure needs revisiting. Documented
rather than silently adjusted.

---

# 3. MONTE CARLO PARAMETERS

| Parameter | Value | Basis |
|---|---|---|
| Market correlation ρ | 0.85 | Single shared factor. **Verified** to give realised correlation ρ, not ρ². |
| CPI volatility | 1.0% pa | Historical SD of Australian annual CPI around target. |
| CPI floor | −1% | Prevents implausible sustained deflation. |
| Neutral real rate | 1.0% | RBA models now imply ~0.25%; ours is at the top of the range. |
| Mortgage margin | 2.5% | With 2.5% CPI gives the 6.0% default. |
| Paths | 2,000 | Standard for stable percentiles; configurable 500–10,000. |

**Rate linkage.** Rates are driven off each path's own simulated CPI rather
than as an independent process: central banks respond to inflation, so this
gives the correlation for free and is **more honest** — an independent
process would permit high-inflation/low-rate paths that do not occur.

**Regime switching** — two-state Markov variance, applied to the shared factor
so all assets experience regimes together.

**Erratum** (`docs/specs/14-what-if.md`): the spec predicted a fixed-rate
client's fan would be *narrower*. Measured behaviour is the opposite and the
model is correct — a variable borrower is substantially hedged against
inflation in real terms; a fixed borrower is not.

---

# 4. FRINGE BENEFITS TAX — VERIFIED

**Not in the firm's rate reference**, which states FBT figures "must be
sourced separately". Researched against the ATO.
**All employer types are in scope** — the firm advises across all of them.

| Figure | Value |
|---|---|
| FBT rate | **47%**, unchanged 31 Mar 2023 – 31 Mar 2027 |
| Type 1 gross-up (GST credit available) | **2.0802** |
| Type 2 gross-up (no GST credit) | **1.8868** |
| PBI and health promotion charities (non-hospital) | **$30,000** grossed-up |
| Public and NFP hospitals, public ambulance | **$17,000** grossed-up |
| FBT-rebatable employers | **$30,000** grossed-up, rebate 47% |
| Meal entertainment / ELFE (separate, all NFP) | **$5,000** grossed-up |
| Reportable fringe benefits threshold | **$2,000** taxable value |
| Car statutory rate | **20%** flat |
| Car parking threshold (2026 FBT year) | **$11.03** |

## ⚠ The caps are GROSSED-UP, not cash
The engine compares packaged amounts against the cap **in cash terms** and
grosses up only the excess — which is correct. But nothing tells the adviser
which form to enter, and the ATO publishes the grossed-up figure. Entering
$30,000 where $15,900 is meant **silently doubles the cap**.

| Employer type | Grossed-up | **Cash — enter this** |
|---|---|---|
| PBI / health promotion charity | $30,000 | **$15,900** |
| Public and NFP hospitals, ambulance | $17,000 | **$9,010** |
| FBT-rebatable | $30,000 | **$15,900** |
| Meal entertainment (all NFP) | $5,000 | **$2,650** |
| Standard employer | — | no cap benefit |

Cash = grossed-up ÷ 1.8868. $15,900 and $9,010 are the figures advisers quote
and clients see on packaging statements. **Provide all four as presets.**

## Corrections to spec 23
- FBT-exempt has **two** caps by subtype, not one — a hospital nurse and a
  charity worker have materially different capacity.
- Meal entertainment within its $5,000 cap does **not** consume the general
  cap; the excess does.
- Reportable fringe benefits are reported at the **Type 2** rate even where
  Type 1 was used for the FBT calculation.
- Cars are **never** covered by either cap.

---

# 5. VERIFIED TAX AND SUPER FIGURES

## 5.1 Redundancy and ETP — FY2026-27, VERIFIED
Taxation Administration (Withholding Schedules) Instrument 2026, Schedule 11.

| Figure | Value |
|---|---|
| Genuine redundancy tax-free base | **$13,598** |
| Plus per completed year of service | **$6,801** |
| ETP cap | **$270,000** (from $260,000) |
| Whole-of-income cap | **$180,000** |
| Taxable component, at/over preservation age | **17%** to cap (incl. Medicare) |
| Taxable component, under preservation age | **32%** to cap (incl. Medicare) |
| Above the cap | **47%** |

Only **completed** years count. Indexed annually 1 July; the ETP cap moves in
**$10,000** increments (AWOTE-indexed, rounded down).

**Genuine redundancy is an *excluded* ETP** — it uses the ETP cap, not the
whole-of-income cap, which applies to non-excluded ETPs and is reduced
dollar-for-dollar by other taxable income.

**Unused leave** is taxed separately and is never part of the tax-free
redundancy amount. On genuine redundancy: annual leave at a maximum flat
**32%** (incl. Medicare); LSL post-17 August 1993 at max 32%, the pre-18
August 1993 component only 5% assessable at marginal rates. On resignation,
leave accrued since 18 August 1993 is taxed at marginal rates.
**Preservation age is now 60 for everyone**, simplifying the age test.

## 5.2 Spouse contribution offset — FY2026-27, VERIFIED
**18%** of contributions on up to **$3,000** → maximum **$540**. Full offset
where the receiving spouse's total income is **$37,000 or less**, phasing out
$1-for-$1 to **nil at $40,000**. Non-refundable. Independent of the
contributing spouse's income. Receiving spouse must be under 75 with a TSB
under the general transfer balance cap; contributions count against their
non-concessional cap.

## 5.3 HELP indexation — VERIFIED
**Lower of CPI or WPI**, Universities Accord (Student Support and Other
Measures) Act 2024, backdated to 1 June 2023. Applied **1 June**. CPI =
annual change to the March quarter; WPI = to the December quarter; the ATO
publishes in late May.

Applied: **2023 3.2%** (reduced from 7.1%, retrospective credit) · **2024
4.0%** (from 4.7%) · **2025 3.2%** · **2026 2.8%** — lowest since 2021.

The **one-off 20% reduction** (Higher Education Legislation Amendment Act
2025) applied automatically on **1 June 2025, before** that year's
indexation.

**Our implementation uses AWOTE as a WPI proxy.** With the §1.2 split, the
salary figure (2.70%) is now itself a WPI-basis rate — **use that for HELP
indexation rather than the AWOTE figure**, which brings the proxy much closer
to the legislated basis.

## 5.4 Super caps — CONFIRMED CORRECT
Secondary sources conflicted; **the firm confirmed our values are right for
FY2026-27**:
- **General transfer balance cap: $2,100,000** ✓
- **Non-concessional cap: $130,000** ✓

The conflicting $2.0m and $120k figures were stale. No change required.

---

# 6. PRODUCT AND SCHEME FIGURES

## 6.1 First Home Guarantee — MATERIALLY CHANGED 1 October 2025
The expansion removed **both** the income caps ($125,000 single / $200,000
couple) **and** the 35,000-place annual limit. The Regional First Home Buyer
Guarantee was folded in. Renamed the "Australian Government 5% Deposit
Scheme".

**LMI is still waived** — the government guarantees up to 15% of value, so a
95% LVR loan is treated as ≤80%. Minimum 5% deposit (2% single-parent).
Eligibility: citizen or PR, 18+, owner-occupier, first home buyer or no
Australian residential property in 10 years.

| Location | Cap |
|---|---|
| Sydney & NSW regional centres | $1,500,000 |
| Melbourne & Geelong | $950,000 |
| Brisbane, Gold Coast, Sunshine Coast | $1,000,000 |
| **Perth (metro)** | **$850,000** (from $600,000) |
| Regional WA | $600,000 |
| Adelaide | $900,000 |
| Hobart | $700,000 |
| ACT | $1,000,000 |
| NT | $600,000 (Darwin → $750,000 from 1 July 2026) |

**Note:** Housing Australia's caps page blocks automated retrieval; caps were
corroborated from the media release plus multiple independent sources.

## 6.2 LMI premiums — UNVERIFIED, and structurally unverifiable
**Neither Helia nor QBE publishes a public consumer rate card.** Every rate
table online is a broker or calculator estimate.

Structure (reliable): payable above **80% LVR**; commonly **capitalised** into
the loan, lifting the effective LVR; rises **non-linearly** with cliffs at
85%, 90% and 95%.

Indicative on a ~$600,000 loan: 85% ≈ $9–12k · 90% ≈ $15–20k · 95% ≈ $23–30k.
As a share of loan: ~1.45% at 90%, close to 3% at 95%.

**Treat as indicative planning estimates.**

## 6.3 Education and investment bonds — VERIFIED
Earnings taxed at up to **30%** inside the bond, reduced by franking credits.
Not reported in the investor's return unless withdrawn within 10 years.

**The "$30 per $70" mechanic is confirmed.** When earnings are withdrawn for
education costs the provider adds **$30 for every $70 of earnings withdrawn**
— a refund of the 30% already paid inside the bond. The arithmetic: $70 net
of 30% tax grosses up to $70 ÷ 0.70 = $100 pre-tax, so $30 is added back.
Confirmed in Futurity's own product material.

**⚠ The catch we do not currently model:** the education benefit and the
withdrawn earnings are **assessable to the student/beneficiary at their
marginal rate**. For a beneficiary **under 18, only the first $416 a year is
tax-free** before penalty rates on minors' unearned income apply — so it is
often materially more tax-effective to defer drawdown until 18+. **This
changes the advice and should be modelled.**

**Standard bond rules:** 10-year rule; 125% rule (contributions above 125% of
the prior year reset the clock for the whole balance; skipping a year and
later contributing also resets it); pre-10-year withdrawals assessable with a
non-refundable 30% offset. Assessable fraction of earnings tapers: **years
1–8 = 100%, year 9 = ⅔, year 10 = ⅓, after year 10 = nil.** No CGT discount
inside the bond.

**Not confirmed:** no explicit dollar cap on the education benefit was found.
Treat "uncapped" as unverified.

---

# 7. DERIVED AND BEHAVIOURAL DEFAULTS

## 7.1 Education fee indexation — CPI + 2.0%
**RESEARCHED. Two independent bases converge.**

**Mechanical:** private school fee indexation is driven by an index weighted
roughly **75% to staffing costs (WPI) and 25% to CPI** — with WPI 2.7% and
CPI 2.5% that implies ~2.65%, or CPI + 0.15% as pure cost recovery.

**Observed:** the ABS secondary-education price sub-index compounded at
approximately **4.0% a year over 2018–2026** (3.2, 3.4, 3.2, 2.5, 5.7, 6.1,
5.3, 4.7, 5.1). NSW and ACT fees rose **5–7% in 2026**, described in the AFR
as "more than double the rate of inflation".

CPI + 2% sits between pure cost recovery and observed behaviour, closer to
observed — schools raise fees above cost, not merely to cover it.
**Defensible and arguably conservative.**

## 7.2 Property expenses — 20% → **25% of gross rent**
**RESEARCHED.** Property management alone runs **6–10%** of rent (some quote
7–15% with letting and admin fees), higher in Perth than the east coast, plus
a letting fee of 2–3 weeks' rent in WA. Adding council rates, water,
insurance, maintenance and WA's mandatory Property Condition Reports, total
holding costs excluding mortgage commonly land at **20–30% of gross rent**.

**25% is the midpoint** and a better default than 20%, which was optimistic
for anything but a newer low-maintenance property. Editable per property.

## 7.3 Agent fees on sale — 2.5%
**RESEARCHED.** Perth commissions run **2–3%** plus marketing; 2.5% is the
midpoint.

## 7.4 Land value — RESOLVED: 50% houses, 20% units
**RESEARCHED, firm-approved.** Land tax is assessed on **unimproved land
value**; we hold total value. No authoritative national statistic exists. The
consistent valuer rule of thumb:

| Property type | Range | **Our default** |
|---|---|---|
| House on a standard suburban block | 40–60% | **50%** |
| Apartment / unit (land shared across strata) | 10–30% | **20%** |

Highly sensitive to building age: an old house on a good block can be ~90%
land; a fully renovated house ~70%; a new build often under 50%.

**WA:** Landgate assesses the unimproved value RevenueWA uses for land tax;
the WA taxing date is **30 June**. **Use the per-property override wherever a
rates notice gives the actual unimproved value** — it is on the notice, and
an actual figure always beats a ratio.

## 7.5 Insurance premium indexation — CPI + 3% ⚠ SHOULD BE AGE-BASED
**RESEARCHED.** "Stepped" premiums — renamed **variable age-stepped** under
the CALI/APRA/ASIC labelling reform effective 31 December 2024 — are
recalculated each year on current age, rising at every anniversary with
increases **accelerating materially from the mid-40s**. Roughly **3 in 4**
retail policies are stepped. Driven by age, CPI indexation of the sum
insured, and insurer repricing (level premiums repriced up to ~30% over ~7
years at some insurers).

**No authoritative escalation table is published.** Because increases are
age-dependent and steepen sharply, **a flat CPI + 3% understates increases in
the 50s and 60s and overstates them at younger ages.** An age-based curve is
materially more accurate past the late 40s.

## 7.6 Other derived defaults
| Default | Value | Basis |
|---|---|---|
| Purchase costs | 2% of price | Transfer, legal, inspections, excluding duty. |
| LVR | 80% | The LMI threshold. |
| Rent where not entered | 4% of value | Approximate gross residential yield. |
| Property growth | Residential Property profile growth component | Ties property to the firm's own CMA. |
| Retirement age | 65 | Conventional default; user-entered. |
| Settlement costs on sale | $2,000 | Conveyancing and settlement agent. |

---

# 8. INDEXATION BASES

Rounding happens in **nominal** dollars — where the legislated steps exist —
so real-terms values step irregularly. Correct, not a defect.

| Figure | Basis | Step |
|---|---|---|
| Concessional contributions cap | **AWOTE 3.2%** | $2,500 down |
| Non-concessional cap | 4 × concessional | — |
| General transfer balance cap | CPI | $100,000 down |
| Bring-forward TSB thresholds | derived from GTBC | — |
| Untaxed plan cap | AWOTE | $5,000 down |
| Division 296 thresholds | CPI | $150,000 / $500,000 |
| Defined benefit income cap | derived: GTBC ÷ 16 | ITAA97 s307-462(3) |
| ETP cap | AWOTE | $10,000 down |
| Genuine redundancy base and per-year | AWOTE | whole dollars, 1 July |
| **Salary and wage income** | **WPI 2.70%** | — |
| **HELP debt** | **lower of CPI and WPI 2.70%** | 1 June |
| **Division 293 threshold ($250,000)** | **not indexed** | — |
| **Carry-forward TSB gate ($500,000)** | **not indexed** | — |
| **Gifting limits ($10,000 / $30,000)** | **not indexed** | — |
| **Spouse offset thresholds ($37,000 / $40,000)** | **not indexed** | — |
| Age pension rates | wages (MTAWE benchmark) | — |
| Age pension thresholds | CPI | — |
| MLS and PHI thresholds | AWOTE | — |
| SIC / FHSSS earnings | 90-day BAB + 3% | quarterly |
| Income tax brackets | **constant real by default** | toggle available |

**The unindexed figures are the interesting ones.** Division 293's $250,000,
the $500,000 carry-forward gate, the gifting limits and the spouse offset
thresholds do not index, so in real terms they shrink by CPI every year. A
client at $200,000 today drifts into Division 293 purely through bracket
creep. Correct modelling; surprising to see.

**Tax bracket indexation is an assumption, not law.** Brackets are not indexed
in legislation; they are adjusted ad hoc and roughly track inflation over long
horizons. Freezing them nominally for fifty years compounds into an effective
rate nobody would defend. Default **constant in real terms**, with a
no-indexation toggle for a deliberate bracket-creep stress test.

**Refresh cadence:** SIC/FHSSS quarterly · AWOTE and WPI at each ABS release ·
HELP each late May · super caps 1 July · FBT 1 April · FHBG whenever Housing
Australia revises (next known: Darwin 1 July 2026).

---

# 9. STATE AND PRODUCT DATA TABLES

| Table | Status |
|---|---|
| Stamp duty | **WA verified** (incl. 7 May 2026 FHB settings). Seven jurisdictions **UNVERIFIED**. |
| Land tax | **WA corroborated** from secondary sources. Seven **simplified approximations**. |
| LMI premiums | **UNVERIFIED and structurally unverifiable** — no public rate card exists (§6.2). |
| First Home Guarantee caps | **VERIFIED** — updated 1 Oct 2025 (§6.1). |
| ETP and redundancy | **VERIFIED** (§5.1). |
| Spouse super offset | **VERIFIED** (§5.2). |
| HELP indexation | **VERIFIED** (§5.3). |
| Education bond benefit | **VERIFIED** — mechanic confirmed; benefit cap unverified; beneficiary tax unmodelled (§6.3). |
| FBT caps and rates | **VERIFIED** (§4). |
| Super caps | **CONFIRMED by the firm** (§5.4). |
| ABS life tables 2020–22 | **VERIFIED** — complete official single-year ex column. |

## 9.1 Obtaining the eight state schedules — the largest remaining gap

Web research is a poor tool here: revenue office sites are often unreachable
from automated fetching, the figures are dense bracket tables where a
transcription error is invisible, and reachable secondary sources are the most
likely to be stale. **Go direct to each revenue office**, or take them from the
firm's Big Black Book.

| | Transfer duty | Land tax |
|---|---|---|
| **WA** | RevenueWA (wa.gov.au → Department of Finance) | same |
| **NSW** | revenue.nsw.gov.au | same |
| **VIC** | sro.vic.gov.au | same |
| **QLD** | qro.qld.gov.au | same |
| **SA** | revenuesa.sa.gov.au | same |
| **TAS** | sro.tas.gov.au | same |
| **ACT** | revenue.act.gov.au | same |
| **NT** | nt.gov.au → Territory Revenue Office | *(NT has no land tax)* |

Search each for **"transfer duty rates"** and **"land tax rates and
thresholds"**.

**What is needed per jurisdiction:**
1. The **full bracket table** — threshold, base amount, and marginal rate
   above it.
2. The **effective date** of that table.
3. **First-home concessions separately** — these change more often than the
   general rates and are where WA already caught us out (the 7 May 2026
   settings superseded what we had).

Screenshots or pasted text are sufficient.

---

# 10. MODELLING CONVENTIONS

- **Real terms throughout**, nominal as display-only scaling.
- **Monthly engine, annual reporting.** FYs 1 July – 30 June, partial first
  year from the start month.
- **Ages tick over each 1 July.** Birthdays are not modelled; DOB is used for
  life-expectancy lookup only.
- **Annual cashflows fire in July**, skipped in a partial first year beginning
  after July.
- **Growth before cashflow within a month.**
- **Geometric monthly compounding**, not arithmetic.
- **Fund earnings tax 15% on income, 10% effective on growth** — the latter
  reflects the one-third CGT discount on gains held over twelve months. Real
  funds realise gains lumpily; we accrue smoothly.
- **Pooled cost bases, not parcels** — justified by the 1 July 2027 deemed
  reacquisition, which resets every cost base to market value.
- **PAYG withheld on employment income only**; the gap settles as a refund the
  following year.
- **Tax timing:** income tax accrues in-year PAYG-style; CGT, Division 293 and
  296 are paid in July of the following FY.
- **Explicit withdrawals do not cascade**; only household deficit funding walks
  the funding order.
- **Lifestyle assets are never sold** to fund deficits.
- **Life expectancy anchors to the longest in the household**; mortality is not
  modelled and the projection ends with both alive.
- **Partner death is deliberately not modelled** — an insurance question
  answered by needs analysis, not a projection. Xplan reached the same
  conclusion.
