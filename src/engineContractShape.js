// Engine API contract-shape snapshot (spec 31, Commit 4) — the
// DURABLE piece: pins the full result SHAPE (field names and types,
// never values) so a field silently removed or renamed is caught here
// rather than discovered by a consumer. Per CLAUDE.md: "The engine
// result shape is a published contract. Any commit changing it must
// update the contract snapshot and bump the result version in the
// same commit. Removing or renaming a field is a breaking change."
//
// Committed and updated DELIBERATELY, never regenerated automatically
// — an auto-updating snapshot tests nothing (this project's own
// stated testing philosophy; see CLAUDE.md's Testing conventions).
// To update after a genuine, reviewed shape change: re-run the
// generation recipe below, review the diff by eye, paste the new
// COMMITTED_SHAPE in, and bump ENGINE_VERSION's minor (additive) or
// major (removed/renamed) in engine.js in the SAME commit, per the
// rule above.
//
// Generated from THREE demo fixtures, shapes unioned by key (no one
// fixture has everything): "First home buyer"'s "Buy 2030 with FHSSS"
// scenario (src/demo/firstHomeBuyer.js — HELP balance, a property
// purchase producing a property-linked liability, super, FHSSS);
// "Family with a mortgage"'s "Current" scenario (src/demo/
// familyWithMortgage.js — a couple, a plain liability, super); and a
// small hand-built single-person fixture with one aged care entry
// (defaultState() + a `plan.agedCare` row, spec 29 Commit 5 — its own
// FIRST year with a non-empty `agedCareDetail`, not necessarily the
// final year). `yearly` otherwise uses each fixture's FINAL year
// (captures deathBenefitDetail, which is null on every other row).
// Disclosed gap: none of the three fixtures has bonds, a pension, a
// defined benefit, or a goal, so `bondDetail`, `pensionDetail`,
// `definedBenefitDetail`, `goals`, `schedule.bondFlows`,
// `schedule.superInsurancePremiums`, `liabilityRepaymentStats`,
// `goalStats`, and `schedule.rowTotals.deductions` are pinned as
// empty objects here, not their populated inner shape — those are
// still exercised (for correctness, not shape-pinning) by their own
// dedicated test files (bonds.test.js, pensionTba.test.js, etc.).
//
// Dictionaries keyed by a generated row id (asset/liability/super/
// property/etc — see planState.js's `uid()`) collapse to a single
// "<id>" placeholder key, since every entry in such a dictionary has
// the same shape by construction of the engine's own code.
export const ID_KEY_RE = /-[0-9a-z]{4}$|^help_(client|partner)$/;

// shapeOf(value) → a JSON-safe structural fingerprint: "null" for
// null, typeof for a primitive, ["array", shapeOf(firstElement)] (or
// ["array","empty"]) for an array, or a sorted-key object mapping each
// field to ITS shape, with any id-shaped key collapsed to "<id>".
export function shapeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? ["array", "empty"] : ["array", shapeOf(value[0])];
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const out = {};
    for (const k of keys) out[ID_KEY_RE.test(k) ? "<id>" : k] = shapeOf(value[k]);
    return out;
  }
  return typeof value;
}

// compareShapes(committed, live) → { errors, notices }. A field
// present in `committed` but missing (or changed type) in `live` is an
// ERROR — the test fails. A field present in `live` but not in
// `committed` is a NOTICE only — the test still passes, but prints a
// reminder that ENGINE_VERSION's minor should bump and this snapshot
// should be updated deliberately. Renaming a field is caught as BOTH
// (the old name errors as missing, the new name notices as added).
export function compareShapes(committed, live) {
  const errors = [];
  const notices = [];
  const walk = (c, l, path) => {
    const cIsArr = Array.isArray(c), lIsArr = Array.isArray(l);
    if (cIsArr || lIsArr) {
      if (!cIsArr || !lIsArr) { errors.push(`${path}: expected an array marker on both sides`); return; }
      if (c[1] === "empty" || l[1] === "empty") return; // can't compare element shape when either side has no example
      walk(c[1], l[1], `${path}[]`);
      return;
    }
    const cIsObj = c !== null && typeof c === "object", lIsObj = l !== null && typeof l === "object";
    if (cIsObj || lIsObj) {
      if (!cIsObj || !lIsObj) { errors.push(`${path}: type changed (was an object, now ${typeof l})`); return; }
      const cKeys = Object.keys(c), lKeys = new Set(Object.keys(l));
      for (const k of cKeys) {
        if (!lKeys.has(k)) { errors.push(`${path}.${k}: field REMOVED (or renamed) — breaking change`); continue; }
        walk(c[k], l[k], `${path}.${k}`);
      }
      for (const k of Object.keys(l)) {
        if (!cKeys.includes(k)) notices.push(`${path}.${k}: NEW field — bump ENGINE_VERSION's minor and update the committed contract shape`);
      }
      return;
    }
    if (c !== l) errors.push(`${path}: type changed from "${c}" to "${l}"`);
  };
  walk(committed, live, "$");
  return { errors, notices };
}

// mergeShapes(a, b) → the union shape (every key/array-element-shape
// from EITHER side). Used both to regenerate COMMITTED_SHAPE below
// (from the two demo fixtures, neither of which alone has every
// feature) and by engine.test.js to build the live "current shape"
// from the SAME two fixtures before comparing — comparing a single
// fixture's shape directly against the union would spuriously report
// features that fixture just doesn't happen to use as "removed".
export function mergeShapes(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a[1] === "empty") return b[1] === "empty" ? a : b;
    if (b[1] === "empty") return a;
    return ["array", mergeShapes(a[1], b[1])];
  }
  if (a !== null && typeof a === "object" && b !== null && typeof b === "object") {
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = mergeShapes(a[k], b[k]);
    return out;
  }
  return a; // primitives: same type on both sides in practice
}

export const COMMITTED_SHAPE ={
  "accruedBondTaxAtEnd": "number",
  "accruedCgtAtEnd": "number",
  "accruedDiv293AtEnd": "number",
  "accruedDiv296AtEnd": "number",
  "accruedRefundAtEnd": "number",
  "accruedUntaxedSuperTaxAtEnd": "number",
  "agedCareWarnings": [
    "array",
    {
      "reason": "string",
      "type": "string"
    }
  ],
  "bondWarnings": [
    "array",
    "empty"
  ],
  "drawdownWarnings": [
    "array",
    "empty"
  ],
  "engineVersion": "string",
  "errors": [
    "array",
    "empty"
  ],
  "figuresAsAt": "string",
  "goalStats": {},
  "liabilityRepaymentStats": {},
  "liabilityRollovers": {
    "<id>": {
      "fromRatePct": "number",
      "fyLabel": "string",
      "planYear": "number",
      "repaymentAfter": "number",
      "repaymentBefore": "number",
      "toRatePct": "number"
    }
  },
  "monthly": {
    "combined": [
      "array",
      "number"
    ],
    "perAsset": {
      "<id>": [
        "array",
        "number"
      ]
    },
    "wca": [
      "array",
      "number"
    ]
  },
  "propertyWarnings": [
    "array",
    "empty"
  ],
  "schedule": {
    "adjustments": [
      "array",
      "empty"
    ],
    "assetFlows": {
      "<id>": {
        "contributions": [
          "array",
          "number"
        ],
        "oneOffs": [
          "array",
          "number"
        ],
        "withdrawals": [
          "array",
          "number"
        ]
      }
    },
    "bondFlows": {},
    "bonusDestinationEvents": [
      "array",
      "empty"
    ],
    "childEducationFlows": {
      "<id>": [
        "array",
        "number"
      ]
    },
    "clientAges": [
      "array",
      "number"
    ],
    "deductionsByOwner": {
      "client": [
        "array",
        "number"
      ],
      "partner": "null"
    },
    "employmentIncomeByOwner": {
      "client": [
        "array",
        "number"
      ],
      "partner": "null"
    },
    "expenses": [
      "array",
      "number"
    ],
    "fhsssFlows": {
      "client": {
        "concessional": [
          "array",
          "number"
        ],
        "nonConcessional": [
          "array",
          "number"
        ]
      },
      "partner": {
        "concessional": [
          "array",
          "number"
        ],
        "nonConcessional": [
          "array",
          "number"
        ]
      }
    },
    "fyLabels": [
      "array",
      "string"
    ],
    "income": [
      "array",
      "number"
    ],
    "incomeByOwner": {
      "client": [
        "array",
        "number"
      ],
      "partner": "null"
    },
    "liabilityDrawdownEvents": {
      "<id>": [
        "array",
        "empty"
      ]
    },
    "liabilityExtraFlows": {
      "<id>": [
        "array",
        "number"
      ]
    },
    "months": "number",
    "monthsInFirstYear": "number",
    "oneOffsByAssetYear": {
      "<id>": [
        "array",
        "number"
      ]
    },
    "packagingByOwnerYear": {
      "client": {
        "fbtPayable": [
          "array",
          "number"
        ],
        "reportableFringeBenefits": [
          "array",
          "number"
        ]
      },
      "partner": "null"
    },
    "partnerAges": "null",
    "personalNccByOwner": {
      "client": [
        "array",
        "number"
      ],
      "partner": [
        "array",
        "number"
      ]
    },
    "planYears": "number",
    "rowTotals": {
      "deductions": {},
      "education": {
        "<id>": [
          "array",
          "number"
        ]
      },
      "expenses": {
        "<id>": [
          "array",
          "number"
        ]
      },
      "income": {
        "<id>": [
          "array",
          "number"
        ]
      }
    },
    "spouseContributionsByOwner": {
      "client": [
        "array",
        "number"
      ],
      "partner": [
        "array",
        "number"
      ]
    },
    "superFlows": {
      "<id>": {
        "nonConcessional": [
          "array",
          "number"
        ],
        "personalDeductible": [
          "array",
          "number"
        ],
        "salarySacrifice": [
          "array",
          "number"
        ],
        "sg": [
          "array",
          "number"
        ],
        "withdrawals": [
          "array",
          "number"
        ]
      }
    },
    "superInsurancePremiums": {},
    "superWarnings": [
      "array",
      "empty"
    ],
    "surplusPeriods": [
      "array",
      {
        "allocations": [
          "array",
          "empty"
        ],
        "debtOrder": "string",
        "from": {
          "anchorId": "string",
          "kind": "string"
        },
        "fromYear": "number",
        "id": "string",
        "payNonDeductibleDebtFirst": "boolean",
        "remainderTo": "string",
        "to": {
          "anchorId": "string",
          "kind": "string"
        },
        "toYear": "number"
      }
    ],
    "terminationEvents": [
      "array",
      "empty"
    ],
    "toConcessionalCapRows": [
      "array",
      "empty"
    ],
    "yearOfMonth": [
      "array",
      "number"
    ]
  },
  "shortfall": "null",
  "superWarnings": [
    "array",
    {
      "fyLabel": "string",
      "owner": "string",
      "reason": "string",
      "type": "string"
    }
  ],
  "wealthCrossoverYear": "null",
  "yearly": [
    "array",
    {
      "adjustments": [
        "array",
        "empty"
      ],
      "adviserFeesOngoing": {
        "outsideCash": "number",
        "paidFromSuper": "number",
        "requestedFromSuper": "number"
      },
      "adviserFeesUpfront": {
        "outsideCash": "number",
        "paidFromSuper": "number",
        "requestedFromSuper": "number"
      },
      "agedCareDetail": {
        "<id>": {
          "basicDailyFee": "number",
          "contribution": "number",
          "dap": "number",
          "extraServices": "number",
          "lifetimeCumulative": "number",
          "regime": "string",
          "total": "number"
        }
      },
      "agedCareRadPaid": "number",
      "agePensionDetail": {
        "assessableAssets": "number",
        "assessableIncome": "number",
        "assetsTestResult": "number",
        "bindingTest": "string",
        "client": {
          "ageEligible": "boolean",
          "eligible": "boolean",
          "paid": "number",
          "workBonusBank": "number",
          "workBonusExempt": "number"
        },
        "dbAssessableIncome": "number",
        "deemedIncome": "number",
        "deprivedAssets": "number",
        "entitlement": "number",
        "grandfatheredDeductibleIncome": "number",
        "grandfatheredDeemingExempt": "number",
        "homeowner": "boolean",
        "incomeTestResult": "number",
        "otherIncome": "number",
        "partner": "null"
      },
      "bondDetail": {},
      "bondsClosing": "number",
      "cashDistributions": "number",
      "clientAge": "number",
      "closingBalance": "number",
      "contributions": "number",
      "cshcDetail": {
        "adjustedTaxableIncome": "number",
        "assessableIncome": "number",
        "client": {
          "ageEligible": "boolean",
          "eligible": "boolean"
        },
        "deemedIncome": "number",
        "grandfatheredDeductibleIncome": "number",
        "margin": "number",
        "partner": "null",
        "threshold": "number"
      },
      "cumulativeDecomposition": {
        "expenses": "number",
        "fees": "number",
        "growth": "number",
        "income": "number",
        "interest": "number",
        "oneOffs": "number",
        "tax": "number"
      },
      "deathBenefitDetail": {
        "client": "null",
        "partner": "null"
      },
      "decomposition": {
        "expenses": "number",
        "fees": "number",
        "growth": "number",
        "income": "number",
        "interest": "number",
        "oneOffs": "number",
        "tax": "number"
      },
      "deficitFundedFromAssets": "number",
      "definedBenefitDetail": {},
      "expenses": "number",
      "fees": "null",
      "fhsssDetail": {
        "client": "null",
        "partner": "null"
      },
      "fyLabel": "string",
      "giftsPaid": "number",
      "goals": {},
      "growth": "number",
      "heasDetail": {
        "closing": "number",
        "drawn": "number",
        "interest": "number",
        "mla": "number",
        "opening": "number",
        "securityValue": "number"
      },
      "income": "number",
      "liabilities": {
        "<id>": {
          "closing": "number",
          "drawdown": "number",
          "extraRepayment": "number",
          "indexation": "number",
          "interest": "number",
          "investmentBalance": "number",
          "offsetApplied": "number",
          "opening": "number",
          "principal": "number",
          "privateBalance": "number",
          "ratePct": "number",
          "surplusRepayment": "number"
        }
      },
      "liabilitiesClosing": "number",
      "netAssets": "number",
      "oneOffsNet": "number",
      "openingBalance": "number",
      "partnerAge": "null",
      "pensionClosing": "number",
      "pensionDetail": {},
      "perAssetClosing": {
        "<id>": "number"
      },
      "perAssetDetail": {
        "<id>": {
          "closing": "number",
          "contributions": "number",
          "costBasePool": "null",
          "deficitFunding": "number",
          "growth": "number",
          "oneOffs": "number",
          "opening": "number",
          "surplusInvested": "number",
          "withdrawals": "number"
        }
      },
      "properties": {
        "<id>": {
          "costBaseSeed": "number",
          "costs": "number",
          "deposit": "number",
          "depreciation": "number",
          "duty": "number",
          "expenses": "number",
          "fhog": "number",
          "fhsssRelease": "number",
          "landTax": "number",
          "lmi": "number",
          "rent": "number",
          "saleGain": "number",
          "saleProceeds": "number",
          "saleValue": "number",
          "settlement": "number",
          "usableEquity": "number",
          "value": "number"
        }
      },
      "propertyClosing": "number",
      "propertySaleProceeds": "number",
      "superCapUsage": {
        "client": {
          "available": "number",
          "cap": "number",
          "carryForwardAvailable": "number",
          "personalDeductible": "number",
          "salarySacrifice": "number",
          "sg": "number"
        },
        "partner": "null"
      },
      "superClosing": "number",
      "superDetail": {
        "<id>": {
          "adviserFee": "number",
          "closing": "number",
          "concessionalNet": "number",
          "contributionSplitIn": "number",
          "contributionSplitOut": "number",
          "contributions": "number",
          "contributionsTax": "number",
          "earnings": "number",
          "earningsTax": "number",
          "fhsssRelease": "number",
          "govSuperInflow": "number",
          "insurancePremium": "number",
          "nonConcessional": "number",
          "opening": "number",
          "personalDeductible": "number",
          "release": "number",
          "rolloverIn": "number",
          "rolloverOut": "number",
          "rolloverTax": "number",
          "salarySacrifice": "number",
          "sg": "number",
          "surplusPersonalDeductible": "number",
          "surplusSalarySacrifice": "number",
          "taxFreeClosing": "number",
          "withdrawals": "number"
        }
      },
      "surplusAccumulated": "number",
      "surplusInvested": "number",
      "surplusOrDeficit": "number",
      "surplusSpent": "number",
      "tax": "number",
      "taxDetail": {
        "cgt": "number",
        "client": {
          "actualTaxPayable": "number",
          "cgt": "number",
          "div293": "number",
          "div296": "number",
          "divTaxFromCash": "number",
          "divTaxPaidFrom": "string",
          "divTaxReleasedFromSuper": "number",
          "excessCcOffset": "number",
          "excessConcessionalContributions": "number",
          "fhsssOffset": "number",
          "fhsssRelease": "number",
          "fhsssTaxFreeComponent": "number",
          "fhsssTaxableComponent": "number",
          "frankingCredits": "number",
          "grossTax": "number",
          "helpBalanceClosing": "number",
          "helpRepayment": "number",
          "helpWithheld": "number",
          "incomeTax": "number",
          "lito": "number",
          "medicare": "number",
          "medicareLevySurcharge": "number",
          "mlsWithheld": "number",
          "netCapitalGain": "number",
          "paygWithheld": "number",
          "quarantinedLossCarry": "number",
          "refundOrBalancing": "number",
          "refundSettled": "number",
          "taxableIncome": "number",
          "taxablePensionComponent": "number",
          "ttrPensionOffset": "number"
        },
        "div293": "number",
        "div296": "number",
        "divTaxFromCash": "number",
        "divTaxReleasedFromSuper": "number",
        "fbtPayable": "number",
        "fhsssRelease": "number",
        "frankingCredits": "number",
        "helpRepayment": "number",
        "incomeTax": "number",
        "medicareLevySurcharge": "number",
        "netCapitalGain": "number",
        "partner": "null",
        "refundSettled": "number",
        "reportableFringeBenefits": "number"
      },
      "termination": [
        "array",
        "empty"
      ],
      "transferBalance": {
        "client": {
          "balance": "number",
          "personalCap": "number",
          "remainingCap": "number"
        },
        "partner": {
          "balance": "number",
          "personalCap": "number",
          "remainingCap": "number"
        }
      },
      "unfundedCashflow": "number",
      "wcaClosing": "number",
      "wcaDetail": {
        "closing": "number",
        "interest": "number",
        "netFlow": "number",
        "opening": "number",
        "sweptInvested": "number",
        "sweptSpent": "number",
        "sweptToCash": "number"
      },
      "withdrawals": "number"
    }
  ]
}
;
