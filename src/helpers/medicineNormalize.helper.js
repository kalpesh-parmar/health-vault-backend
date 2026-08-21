const { medictationType } = require("../enums/medicationType");
const { frequencyType } = require("../enums/frequencyType");
const { foodType } = require("../enums/foodType");

// Type prefix rules for deriving medicationType from name prefixes
const TYPE_PREFIXES = [
  { regex: /^(?:tab\.|tablet|tab)\s+/i, type: medictationType.TABLET },
  { regex: /^(?:cap\.|capsule|caps|cap)\s+/i, type: medictationType.CAPSULE },
  { regex: /^(?:syp\.|syrup|syp)\s+/i, type: medictationType.SYRUP },
  { regex: /^(?:inj\.|injection|inj)\s+/i, type: medictationType.INJECTION },
  { regex: /^(?:drops?|drop)\s+/i, type: medictationType.DROPS },
  { regex: /^spray\s+/i, type: medictationType.SPRAY },
  { regex: /^(?:inhaler|inh\.|inh)\s+/i, type: medictationType.INHALER },
];

// Mapping helper for converting onboarding frequency string to DB Enum frequency value
const FREQUENCY_TO_DB_MAP = {
  ONCE: frequencyType.ONCE_DAILY,
  TWICE: frequencyType.TWICE_DAILY,
  THRICE: frequencyType.THREE_TIMES_DAILY,
  "Once Daily": frequencyType.ONCE_DAILY,
  "Twice Daily": frequencyType.TWICE_DAILY,
  "Three Times Daily": frequencyType.THREE_TIMES_DAILY,
};

/**
 * Parses Indian dosing notations like "1-0-1", "0.5-0-0.5", "½-0-½", including B/F and A/F suffixes.
 *
 * @param {string} text
 * @returns {null|{frequencyCount: number, times: string[], dosePerIntake: number, frequency: string, foodContext: string|null}}
 */
function parseIndianDosing(text) {
  if (!text || typeof text !== "string") return null;

  // Normalize fractions and spaces
  let normalized = text.replace(/½/g, "0.5").replace(/1\/2/g, "0.5").trim();

  // Parse food context suffix
  let foodContext = null;
  if (/\b(?:a\/f|af|after food|after meal|after meals)\b/i.test(normalized)) {
    foodContext = "AFTER_FOOD";
  } else if (
    /\b(?:b\/f|bf|before food|before meal|before meals|empty stomach)\b/i.test(normalized)
  ) {
    foodContext = "BEFORE_FOOD";
  }

  // Remove suffixes to clean the dosing notation match
  normalized = normalized
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\b(?:a\/f|af|b\/f|bf)\b/gi, "")
    .trim();

  // Match 3 or 4 slots separated by hyphens (e.g. 1-0-1, 1-1-1-1)
  const regex = /^([0-9.]+)\s*-\s*([0-9.]+)\s*-\s*([0-9.]+)(?:\s*-\s*([0-9.]+))?$/;
  const match = normalized.match(regex);
  if (!match) return null;

  const parts = [match[1], match[2], match[3]];
  if (match[4]) {
    parts.push(match[4]);
  }

  const values = parts.map((p) => {
    const val = parseFloat(p);
    return isNaN(val) ? 0 : val;
  });

  const nonZero = values.filter((v) => v > 0);
  const frequencyCount = nonZero.length;
  if (frequencyCount === 0) return null;

  const timesMap = ["08:00", "14:00", "20:00", "22:00"];
  const times = [];
  values.forEach((v, idx) => {
    if (v > 0 && idx < timesMap.length) {
      times.push(timesMap[idx]);
    }
  });

  const dosePerIntake = nonZero[0] || 1;

  let frequency = "ONCE";
  if (frequencyCount === 2) frequency = "TWICE";
  else if (frequencyCount >= 3) frequency = "THRICE";

  return {
    frequencyCount,
    times,
    dosePerIntake,
    frequency,
    foodContext,
  };
}

/**
 * Inters medication type and cleans prefix from name.
 *
 * @param {string} rawName
 * @returns {{name: string, type: string|null, inferred: boolean}}
 */
function deriveTypeFromName(rawName) {
  const name = String(rawName || "").trim();
  if (!name) return { name: "Unknown Medicine", type: null, inferred: false };

  for (const prefix of TYPE_PREFIXES) {
    if (prefix.regex.test(name)) {
      const cleaned = name.replace(prefix.regex, "").trim();
      return {
        name: cleaned,
        type: prefix.type,
        inferred: true,
      };
    }
  }

  return { name, type: null, inferred: false };
}

/**
 * Parses generic duration strings (e.g. "30 Days", "4 Weeks").
 *
 * @param {string} duration
 * @returns {null|number}
 */
function parseDurationDays(duration) {
  if (!duration) return null;
  const match = String(duration).match(/(\d+)\s*(day|week|month)/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("week")) return n * 7;
  if (unit.startsWith("month")) return n * 30;
  return n;
}

/**
 * Standard hints mapping for medication types.
 */
function matchTypeHint(name, dosage, instructions) {
  const haystack = [name, dosage, instructions].map((s) => String(s || "").toLowerCase()).join(" ");
  if (haystack.includes("tab") || haystack.includes("tablet")) return medictationType.TABLET;
  if (haystack.includes("cap") || haystack.includes("capsule")) return medictationType.CAPSULE;
  if (haystack.includes("syrup") || haystack.includes("suspension") || haystack.includes("syp"))
    return medictationType.SYRUP;
  if (haystack.includes("drop")) return medictationType.DROP;
  if (haystack.includes("inj") || haystack.includes("injection") || haystack.includes("shot"))
    return medictationType.INJECTION;
  if (haystack.includes("spray")) return medictationType.SPRAY;
  if (haystack.includes("inhaler") || haystack.includes("inh")) return medictationType.INHALER;
  return null;
}

/**
 * Standard hints mapping for frequency.
 */
function matchFrequencyHint(frequencyText, timingText, instructionsText) {
  const haystack = [frequencyText, timingText, instructionsText]
    .map((s) => String(s || "").toLowerCase())
    .join(" ");
  if (
    haystack.includes("once daily") ||
    haystack.includes("once a day") ||
    haystack.includes("od") ||
    haystack.includes("qd")
  ) {
    return "ONCE";
  }
  if (
    haystack.includes("twice daily") ||
    haystack.includes("twice a day") ||
    haystack.includes("bd") ||
    haystack.includes("bid")
  ) {
    return "TWICE";
  }
  if (
    haystack.includes("thrice") ||
    haystack.includes("three times") ||
    haystack.includes("tds") ||
    haystack.includes("tid")
  ) {
    return "THRICE";
  }
  return null;
}

/**
 * Normalizes and defaults a raw extracted medication object.
 *
 * @param {object} med Raw extracted medicine
 * @param {number} index Index for client_med_id fallback
 * @param {string} patientCode
 * @param {object} defaults Default values overrides
 * @returns {object} Full database representation + needsReview per-field flags
 */
function normalizeMedicine(med, index, patientCode = "P-TEMP", defaults = {}) {
  if (!med || typeof med !== "object") {
    med = {};
  }

  const rawName = med.name || med.medicineName || med.medicationName || "Unknown Medicine";
  const rawDosage = med.dosage || med.dose || "";
  const rawFrequency = med.frequency || "";
  const rawTiming = med.timing || med.when || med.timeOfDay || "";
  const rawInstructions = med.instructions || med.notes || "";
  const rawDuration = med.duration || "";
  const rawQty = med.quantity || med.qty || med.totalQuantity || med.total_quantity || 0;

  const needsReview = {
    name: false,
    type: false,
    dose: false,
    frequency: false,
    duration: false,
  };

  // 1. Clean Name and Extract Type
  let { name, type: derivedType, inferred: derivedTypeInferred } = deriveTypeFromName(rawName);
  if (!derivedType) {
    derivedType =
      med.type || matchTypeHint(name, rawDosage, rawInstructions) || medictationType.TABLET;
    needsReview.type = true; // Flag as low confidence if we fell back
  } else if (derivedTypeInferred) {
    needsReview.type = false; // We successfully derived it from name prefix
  }

  // 2. Parse Dosing Notation
  // Check frequency, timing, or dosage columns for "1-0-1" notation
  const dosing =
    parseIndianDosing(rawFrequency) ||
    parseIndianDosing(rawTiming) ||
    parseIndianDosing(rawDosage) ||
    parseIndianDosing(rawInstructions);

  let freqVal = "ONCE";
  let times = ["08:00"];
  let parsedDose = null;
  let notationFoodContext = null;

  if (dosing) {
    freqVal = dosing.frequency;
    times = dosing.times;
    parsedDose = dosing.dosePerIntake;
    notationFoodContext = dosing.foodContext;
  } else {
    // Fall back to standard frequency hints
    const hintFreq = matchFrequencyHint(rawFrequency, rawTiming, rawInstructions);
    if (hintFreq) {
      freqVal = hintFreq;
      if (freqVal === "TWICE") times = ["08:00", "20:00"];
      else if (freqVal === "THRICE") times = ["08:00", "14:00", "20:00"];
    } else {
      freqVal = "ONCE";
      needsReview.frequency = true;
    }
  }

  // 3. Resolve Dose and Count/Value
  let count = undefined;
  let value = undefined;
  let unit = undefined;

  const rawDosageLower = String(rawDosage).toLowerCase().trim();
  const hasTabletType =
    derivedType === medictationType.TABLET || derivedType === medictationType.CAPSULE;

  if (hasTabletType) {
    const matchNum = rawDosageLower.match(/([0-9.]+)/);
    if (matchNum) {
      count = parseFloat(matchNum[1]);
    } else if (parsedDose !== null) {
      count = parsedDose;
    } else {
      count = 1;
      needsReview.dose = true;
    }
    unit = derivedType.toLowerCase();
  } else {
    const matchNum = rawDosageLower.match(/([0-9.]+)/);
    value = matchNum ? parseFloat(matchNum[1]) : parsedDose !== null ? parsedDose : 1;
    if (!matchNum && parsedDose === null) {
      needsReview.dose = true;
    }

    const matchUnit = rawDosageLower.match(/(ml|tsp|tbsp|drops?|puff|iu)/i);
    if (matchUnit) {
      const matched = matchUnit[1].toLowerCase();
      unit = matched === "iu" ? "IU" : matched.startsWith("drop") ? "drops" : matched;
    } else {
      if (derivedType === medictationType.SYRUP || derivedType === medictationType.INJECTION) {
        unit = "ml";
      } else if (derivedType === medictationType.DROPS || derivedType === medictationType.DROP) {
        unit = "drops";
      } else if (derivedType === medictationType.SPRAY || derivedType === medictationType.INHALER) {
        unit = "puff";
      } else {
        unit = "ml";
      }
    }
  }

  // 4. Resolve Food Context / foodFrequency
  let foodFrequency = foodType.AFTER_FOOD;
  if (notationFoodContext) {
    foodFrequency = notationFoodContext;
  } else {
    const haystack = [rawTiming, rawInstructions]
      .map((s) => String(s || "").toLowerCase())
      .join(" ");
    if (
      haystack.includes("before food") ||
      haystack.includes("before meal") ||
      haystack.includes("ac") ||
      haystack.includes("empty stomach")
    ) {
      foodFrequency = foodType.BEFORE_FOOD;
    }
  }

  // 5. Resolve Duration and Quantity
  const durationDays = parseDurationDays(rawDuration);
  const startDate = defaults.startDate || new Date().toISOString().slice(0, 10);
  const start = new Date(startDate);
  let endDate = null;
  let ongoing = true;

  if (durationDays) {
    endDate = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    ongoing = false;
  }

  const frequencyCount = dosing
    ? dosing.frequencyCount
    : freqVal === "ONCE"
      ? 1
      : freqVal === "TWICE"
        ? 2
        : 3;
  const dailyConsumption = Math.ceil(hasTabletType ? count : value) * frequencyCount;

  let totalQuantity = 0;
  const parsedQty = parseFloat(rawQty);
  if (!isNaN(parsedQty) && parsedQty > 0) {
    totalQuantity = Math.round(parsedQty);
  } else if (durationDays) {
    totalQuantity = dailyConsumption * durationDays;
  }

  const refillAlert = !!med.refill_alert || !!med.refillAlert || false;
  const prescribedBy = med.prescribedBy || med.prescribed_by || defaults.prescribedBy || null;

  // 6. Build the approved medicationSchedule JSON contract
  const medicationSchedule = {
    times,
    reminderTimes: times,
    dose: hasTabletType ? { count } : { value, unit },
    source: med.source || "OCR",
    refillAlert,
    foodContext: foodFrequency,
  };

  // 7. Stable client_med_id for OCR
  const clientMedId = med.client_med_id || med.clientMedId || `doc_med_${index}`;

  const row = {
    bestTaken: [foodFrequency],
    dailyConsumption,
    dosePerIntake: hasTabletType
      ? typeof count === "number" && count > 0
        ? count
        : null
      : typeof value === "number" && value > 0
        ? value
        : null,
    doseReminders: false,
    endDate,
    foodFrequency,
    frequency: FREQUENCY_TO_DB_MAP[freqVal] || frequencyType.ONCE_DAILY,
    medicationName: name,
    medicationTime: times,
    medicationType: derivedType,
    notes: rawInstructions ? String(rawInstructions).slice(0, 1000) : null,
    ongoing,
    patientCode,
    prescribedBy,
    refillAlert,
    reminderBeforeMinutes: 5,
    remainingQuantity: 0,
    startDate,
    totalQuantity,
    unit: String(unit).toUpperCase(),
    userId: defaults.userId || null,
    clientMedId,
    softDelete: false,
  };

  // Onboarding structure representation
  const onboardingMed = {
    id: clientMedId,
    client_med_id: clientMedId,
    name,
    type: derivedType,
    dose: hasTabletType ? { count } : { value, unit },
    frequency: freqVal,
    notes: rawInstructions,
    prescribed_by: prescribedBy || "",
    refill_alert: refillAlert,
    total_quantity: totalQuantity || null,
    selected: true,
    source: "OCR",
    needsReview,
    medicationSchedule,
    duration: rawDuration || (durationDays ? `${durationDays} Days` : ""),
    startDate,
    ongoing,
    subtitle: hasTabletType
      ? `${count} ${derivedType.toLowerCase()}(s) · ${freqVal.toLowerCase()}`
      : `${value} ${unit} · ${freqVal.toLowerCase()}`,
  };

  return { row, onboardingMed };
}

/**
 * Normalizes shorthand payload (e.g. from chat actions or mobile forms)
 * into the strict schema shape required by createMedicationSchema.
 */
function normalizeCreateMedicationInput(payload = {}) {
  const input = { ...payload };

  if (input.name && !input.medicationName) {
    input.medicationName = input.name;
  }
  if (input.type && !input.medicationType) {
    input.medicationType = String(input.type).toUpperCase();
  }
  if (input.instructions && !input.notes) {
    input.notes = String(input.instructions).slice(0, 1000);
  }
  if (input.dose && input.dosePerIntake === undefined) {
    input.dosePerIntake =
      typeof input.dose === "object"
        ? input.dose.count || input.dose.value || 1
        : Number(input.dose) || 1;
  }
  if (input.frequency && FREQUENCY_TO_DB_MAP[input.frequency]) {
    input.frequency = FREQUENCY_TO_DB_MAP[input.frequency];
  } else if (input.frequency && FREQUENCY_TO_DB_MAP[String(input.frequency).toUpperCase()]) {
    input.frequency = FREQUENCY_TO_DB_MAP[String(input.frequency).toUpperCase()];
  }
  if (!input.medicationSchedule && input.frequency) {
    if (input.frequency === frequencyType.ONCE_DAILY) {
      input.medicationSchedule = { Morning: "09:00:00" };
    } else if (input.frequency === frequencyType.TWICE_DAILY) {
      input.medicationSchedule = { Morning: "09:00:00", Night: "21:00:00" };
    } else if (input.frequency === frequencyType.THREE_TIMES_DAILY) {
      input.medicationSchedule = { Morning: "09:00:00", Noon: "14:00:00", Night: "21:00:00" };
    }
  }
  if (input.totalQuantity === undefined || input.totalQuantity === null) {
    input.totalQuantity = 30;
  }
  if (!input.startDate) {
    input.startDate = new Date().toISOString().split("T")[0];
  }
  if (!input.foodFrequency) {
    input.foodFrequency = "AFTER_FOOD";
  }

  // Whitelist ONLY allowed schema keys so Zod .strict() validation passes without unrecognized key errors
  const allowedKeys = [
    "medicationName",
    "medicationType",
    "prescribedBy",
    "dosePerIntake",
    "frequency",
    "medicationSchedule",
    "foodFrequency",
    "startDate",
    "endDate",
    "ongoing",
    "totalQuantity",
    "reminderBeforeMinutes",
    "notes",
  ];

  const sanitized = {};
  for (const key of allowedKeys) {
    if (input[key] !== undefined) {
      sanitized[key] = input[key];
    }
  }

  return sanitized;
}

module.exports = {
  parseIndianDosing,
  deriveTypeFromName,
  parseDurationDays,
  matchTypeHint,
  matchFrequencyHint,
  normalizeMedicine,
  normalizeCreateMedicationInput,
};
