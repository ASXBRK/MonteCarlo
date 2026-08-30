# Aged Care and Social Security Figures — Big Black Book

Source: Macquarie Big Black Book, aged care and social security section.
**Period: 20 March 2026 – 19 September 2026** unless otherwise stated.
This is a primary professional source and supersedes every secondary
figure previously supplied.

---

## CORRECTIONS to figures I gave earlier from secondary sources

| Figure | I said | **Correct** |
|---|---|---|
| Former home cap | ~$206,000 | **$214,884** |
| Income free area, couple | $34,034 | **$34,585.20** each |
| Max accommodation supplement | $70.94/day | **$26,317.20 pa** ($72.10/day) |
| NCCC maximum daily | $105.30 | **$107.32** |

The ~$206,000 was the upper edge of the first assets band, conflated with
the home cap by a secondary source. Exactly the failure the sourcing
protocol guards against.

**MPIR conflict to resolve:** the BBB gives **7.96% for 1 April – 30 June
2026**. A secondary source gave **8.43% from 1 July 2026**. MPIR is
quarterly, so both may be correct for their own quarter — and we are now in
the September 2026 quarter, so **neither is necessarily current**. Store
7.96% as BBB-sourced for its quarter, flag that the current quarter needs
confirming, and make it overridable.

---

## 1. BASIC DAILY FEE

**$66.80/day**, legislated at **85% of the single basic Age Pension**.
Same under both regimes. **Derive it** from the age pension rate the engine
already models rather than storing it.

Age Pension maximum basic rates, 20 Mar – 19 Sep 2026:
- Single **$1,200.90/fortnight** (~$31,223.40 pa), incl. pension supplement
  $86.50/pf and energy supplement $14.10/pf
- Couple **$905.20 each/fortnight** (~$47,070.40 combined pa), incl. pension
  supplement $130.40/pf and energy supplement $21.20/pf combined

---

## 2. PRE-1 NOVEMBER 2025 REGIME — means tested fee
Entry 1 July 2014 to 31 October 2025.

```
means tested fee = means tested amount − maximum accommodation supplement
means tested amount = income tested amount + assets tested amount
maximum accommodation supplement = $26,317.20 pa
```

Capped at the amount the Government would otherwise pay in subsidy and
primary care supplements, and additionally by:
- **daily maximum $370.39**
- **annual cap $35,910.43**
- **lifetime cap $86,185.23**

### Income test
| | Threshold | Income tested amount |
|---|---|---|
| Single | $35,313.20 pa | 50% of income above threshold |
| Couple (each) | $34,585.20 pa | 50% of income above threshold |

For each member of a couple, **half the couple's combined income** is
counted. Thresholds adjust 20 March, 1 July and 20 September.

Income assessed includes deemed income, income support payments, real
estate (**excluding rent from the former home where daily accommodation
payments or contributions are made** — but this exemption was removed for
new residents entering on or after 1 January 2016), employment, and
overseas pensions.

### Assets test
| Assets | Assets tested amount |
|---|---|
| Up to $64,500 | Nil |
| $64,500 – $214,884 | 17.5% of assets between thresholds |
| $214,884 – $515,652 | $26,317.20 + 1% of assets between thresholds |
| Above $515,652 | $29,324.88 + 2% of assets above threshold |

For each member of a couple, **half the couple's combined assets**.
Thresholds adjust 20 March and 20 September.

Assets assessed include financial assets, real estate, superannuation,
motor vehicles, boats, caravans, household contents and personal effects,
**the former home capped at $214,884 per person** (exempt entirely if
occupied by an eligible person), and **the balance of any RAD or RAC**.

---

## 3. FROM 1 NOVEMBER 2025 REGIME — NCCC and Hotelling
Both regimes run permanently side by side. Pre-1 Nov 2025 entrants are
covered by the **"no worse off" principle** and may **opt in** to the new
rules. Home Care recipients covered by "no worse off" who enter residential
care on or after 1 November 2025 remain on the pre-1 Nov rules.

```
NCCC + Hotelling = means tested amount − maximum accommodation supplement
maximum accommodation supplement = $26,317.20 pa
```

Maximum daily rates:
| | Daily | Annual |
|---|---|---|
| Non-clinical care contribution (NCCC) | **$107.32** | $39,064.48 |
| Hotelling contribution | **$22.15** | $8,062.60 |
| Combined | **$129.47** | $47,127.08 |

**Ordering rule:** the NCCC is only payable **after** the individual reaches
the maximum daily rate for the Hotelling contribution.

**NCCC ceases at the earlier of:**
- the **lifetime cap $137,917.01**, or
- **four years**

The NCCC lifetime cap includes NCCCs *plus* means tested residential care
fees (for 1 Jul 2014 – 31 Oct 2025 entrants), *plus* Support at Home
contributions and Home Care income tested fees.

**The Hotelling contribution has no annual or lifetime cap.**

### Income test — single
| Income | Income tested amount |
|---|---|
| Up to $35,313.20 | Nil |
| $35,313.20 – $87,947.60 | 50% of income between thresholds |
| $87,947.60 – $101,105.00 | $26,317.20 |
| $101,105.00 – $117,230.20 | $26,317.20 + 50% of income between thresholds |
| $117,230.20 – $141,252.80 | $34,379.80 |
| Above $141,252.80 | $34,379.80 + 50% of income above threshold |

### Income test — couple (each)
| Income | Income tested amount |
|---|---|
| Up to $34,585.20 | Nil |
| $34,585.20 – $87,219.60 | 50% of income between thresholds |
| $87,219.60 – $101,105.00 | $26,317.20 |
| $101,105.00 – $117,230.20 | $26,317.20 + 50% of income between thresholds |
| $117,230.20 – $138,340.80 | $34,379.80 |
| Above $138,340.80 | $34,379.80 + 50% of income above threshold |

Note the **plateau bands** — the amount is flat across two ranges. This is
not a taper; implement it literally.

### Assets test — singles and couples (each)
| Assets | Assets tested amount |
|---|---|
| Up to $64,500 | Nil |
| $64,500 – $214,884 | 17.5% of assets between thresholds |
| $214,884 – $258,000 | $26,317.20 |
| $258,000 – $361,366.66 | $26,317.20 + 7.8% of assets between thresholds |
| $361,366.66 – $536,384 | $34,379.80 |
| Above $536,384 | $34,379.80 + 7.8% of assets above threshold |

Same plateau structure. Same former-home cap of $214,884 per person and
inclusion of RAD/RAC balance.

---

## 4. ACCOMMODATION PAYMENTS

**Accommodation contribution** (part payment) applies where the means tested
amount at entry is **less than** the maximum accommodation supplement.
**Accommodation payment** (full cost) applies where it is **equal to or
greater than** it, or where insufficient information was provided.
Neither is charged for respite care.

| | Value |
|---|---|
| Maximum accommodation payment | **$758,627** (or higher if approved by the Aged Care Pricing Commissioner) |
| Maximum price cap without approval | $750,000 (from 1 Jan 2025), indexed twice yearly |
| Maximum accommodation contribution | individual's max daily contribution × 365 ÷ MPIR |
| **MPIR** | **7.96%** for 1 Apr – 30 Jun 2026 ⚠ current quarter needs confirming |
| Minimum permissible assets | **$64,500** — a facility cannot accept a RAD that would leave the individual below this |

**Payment options:** upfront (RAD or RAC), ongoing (DAP or DAC), or a
combination.

```
DAP = refundable deposit × MPIR ÷ 365
```

DAPs are **indexed with CPI on 20 March and 20 September** for those
entering from 1 November 2025; not indexed for earlier entrants.

**RAD/RAC retention:** fully refundable for entrants before 1 November 2025.
From 1 November 2025, the provider retains **2% per annum for up to 5
years**, calculated **daily on the outstanding balance**.

**Important:** for the accommodation assessment the assets test is the same
as for the means tested fee **except the former home is NOT capped**.

---

## 5. FIGURES THAT FILL GAPS ELSEWHERE IN THE ENGINE

### 5.1 Age Pension — non-homeowner thresholds (spec 21a's known gap)
Assets test, 20 Mar – 19 Sep 2026:

| | Homeowner full | Homeowner cut-out | Non-homeowner full | Non-homeowner cut-out |
|---|---|---|---|---|
| Single | $321,500 | $722,000 | **$579,500** | **$980,000** |
| Couple | $481,500 | $1,085,000 | **$739,500** | **$1,343,000** |

Reduction **$78 pa per $1,000** of assets over the full-pension threshold.
Full thresholds index 1 July with CPI; cut-outs adjust 20 Mar, 1 Jul, 20 Sep.

Income test:
| | Full pension | Cut-out |
|---|---|---|
| Single | $5,668.00 pa | $68,114.80 pa |
| Couple | $9,880.00 pa | $104,020.80 pa |

Reduction **$0.50 per $1** (single) and **$0.25 per $1 each** (couple) above
the full threshold.

### 5.2 Deeming — 20 Mar – 30 Jun 2026
| | Threshold | Rate below | Rate above |
|---|---|---|---|
| Single | $64,200 | **1.25%** | **3.25%** |
| Couple | $106,200 | 1.25% | 3.25% |

**No longer frozen** — the freeze ended 30 June 2025.

Where a principal residence is sold on or after 1 January 2023, proceeds
held in financial assets and intended for a new principal residence are
deemed **separately at the lower rate** during the exemption period
(generally 2 years).

### 5.3 Work Bonus — 1 Jul 2025 – 30 Jun 2026
$300/fortnight exempt · maximum accrued balance **$11,800** · starting
balance **$4,000** for new recipients · effective employment income
threshold $13,468 single, $25,480 couple combined.

### 5.4 Commonwealth Seniors Health Card — 20 Sep 2025 – 19 Sep 2026
Cut-out: single **$101,105** · couple **$161,768** combined ·
illness-separated couple **$202,210** combined. **+$639.60 per dependent
child.** Income = adjusted taxable income plus deemed income from account
based pensions commenced on or after 1 January 2015.

### 5.5 Home Equity Access Scheme — 2025/26
Interest **3.95% pa compounded fortnightly**. Max fortnightly loan = 150% of
max pension less actual pension received. Total loan limit = age component ×
value of real assets ÷ 10,000. Up to two lump sum advances per 12 months,
totalling up to 50% of the maximum annual Age Pension.

Age component amounts (age at last birthday; for couples use the **younger**
partner):

| Age | Factor | Age | Factor | Age | Factor |
|---|---|---|---|---|---|
| ≤55 | $1,710 | 67 | $2,740 | 79 | $4,380 |
| 56 | $1,780 | 68 | $2,850 | 80 | $4,560 |
| 57 | $1,850 | 69 | $2,960 | 81 | $4,740 |
| 58 | $1,920 | 70 | $3,080 | 82 | $4,930 |
| 59 | $2,000 | 71 | $3,200 | 83 | $5,130 |
| 60 | $2,080 | 72 | $3,330 | 84 | $5,330 |
| 61 | $2,160 | 73 | $3,460 | 85 | $5,550 |
| 62 | $2,250 | 74 | $3,600 | 86 | $5,770 |
| 63 | $2,340 | 75 | $3,750 | 87 | $6,000 |
| 64 | $2,430 | 76 | $3,900 | 88 | $6,240 |
| 65 | $2,530 | 77 | $4,050 | 89 | $6,490 |
| 66 | $2,630 | 78 | $4,210 | ≥90 | $6,750 |

### 5.6 Age Pension treatment of a RAD
**A Refundable Accommodation Deposit is EXEMPT from the Age Pension assets
test and income test.** But it **IS assessable for the aged care means
test** (§2, §3). That asymmetry is the heart of the RAD/DAP decision and
must be modelled correctly in both places.

### 5.7 Gifting
Up to **$10,000 per financial year**, maximum **$30,000 over 5 years**.
Excess is deemed and assessed for **5 years from the date of the gift**
under both tests.

---

## 6. IMPLEMENTATION NOTES

- **Two complete regimes**, selected by entry date, running permanently side
  by side. Pre-1 Nov 2025 entrants may opt in to the new rules — model the
  opt-in as a flag.
- **The plateau bands are literal**, not tapers. Between $87,947.60 and
  $101,105.00 the single income tested amount is a flat $26,317.20.
- **Work in annual terms** where the source gives annual figures, converting
  to daily only for display. The daily maximum ($370.39) and the annual cap
  ($35,910.43) are separate constraints; apply both.
- **The former home is capped at $214,884 for the means test but NOT for the
  accommodation assessment.** Two different treatments of the same asset.
- All figures index **20 March and 20 September**, income thresholds also
  **1 July**. Stamp the module with its period and warn when a projection
  runs past 19 September 2026.
