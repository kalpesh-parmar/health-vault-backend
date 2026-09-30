const { ConflictException } = require("../exceptions/appError");

const SUGGESTED_ACTIONS = Object.freeze([
  { action: "KEEP EXISTING", label: "keep previous medication" },
  { action: "REPLACE", label: "replace previous medication" },
  { action: "EDIT", label: "edit previous medication" },
  { action: "REMOVE NEW", label: "remove incoming new medication" },
]);

function normalizeMedicationName(name) {
  if (!name || typeof name !== "string") return "";
  let clean = name.toLowerCase().trim();
  clean = clean.replace(
    /^(?:tab\.|tablet|tab|cap\.|capsule|caps|cap|syp\.|syrup|syp|inj\.|injection|inj|drops?|drop|spray|inhaler|inh\.|inh)\s+/i,
    "",
  );
  clean = clean.replace(/\b\d+(\.\d+)?\s*(mg|g|mcg|ml|iu|puffs?)?\b/gi, "");
  clean = clean
    .replace(/[^a-z0-9\s]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean;
}

function findMedicationDuplicates(activeMedications = [], incomingRaw = "", excludeId = null) {
  const incomingNorm = normalizeMedicationName(incomingRaw);
  const exactMatches = [];
  const similarMatches = [];

  if (!incomingNorm && !incomingRaw) {
    return {
      hasDuplicate: false,
      conflictType: null,
      matchedMedication: null,
      matchedMedications: [],
      suggestedActions: [],
    };
  }

  for (const med of activeMedications) {
    if (excludeId && String(med.id) === String(excludeId)) continue;

    const existingRaw = med?.medicationName || "";
    const existingNorm = normalizeMedicationName(existingRaw);

    if (!existingNorm && !existingRaw) continue;

    if (
      incomingNorm === existingNorm ||
      incomingRaw.toLowerCase().trim() === existingRaw.toLowerCase().trim()
    ) {
      exactMatches.push(med);
    } else if (
      incomingNorm.length >= 3 &&
      existingNorm.length >= 3 &&
      (incomingNorm.includes(existingNorm) || existingNorm.includes(incomingNorm))
    ) {
      similarMatches.push(med);
    }
  }

  const hasDuplicate = exactMatches.length > 0 || similarMatches.length > 0;
  let conflictType = null;
  let matchedMedications = [];

  if (exactMatches.length > 0) {
    conflictType = "EXACT_DUPLICATE";
    matchedMedications = exactMatches;
  } else if (similarMatches.length > 0) {
    conflictType = "SIMILAR_NAME";
    matchedMedications = similarMatches;
  }

  return {
    hasDuplicate,
    conflictType,
    matchedMedication: matchedMedications.length > 0 ? matchedMedications[0] : null,
    matchedMedications,
    suggestedActions: hasDuplicate ? [...SUGGESTED_ACTIONS] : [],
  };
}

function throwDuplicateConflict(dupCheck) {
  const matchedMedication =
    dupCheck.matchedMedication ||
    (dupCheck.matchedMedications && dupCheck.matchedMedications[0]) ||
    null;

  throw new ConflictException("A similar medication already exists.", {
    duplicateInfo: {
      existingMedicationId: matchedMedication ? matchedMedication.id : null,
      existingMedicationName: matchedMedication ? matchedMedication.medicationName : null,
      matchType: dupCheck.conflictType === "EXACT_DUPLICATE" ? "exact" : "fuzzy",
      matchedMedication,
      matchedMedications: dupCheck.matchedMedications || [],
    },
    suggestedActions: dupCheck.suggestedActions || [...SUGGESTED_ACTIONS],
  });
}

function mapFrequencyToDb(frequency) {
  if (!frequency || typeof frequency !== "string") return "Once Daily";
  const upper = frequency.trim().toUpperCase().replace(/\s+/g, "_");
  const map = {
    ONCE: "Once Daily",
    ONCE_DAILY: "Once Daily",
    TWICE: "Twice Daily",
    TWICE_DAILY: "Twice Daily",
    THRICE: "Three Times Daily",
    THREE_TIMES_DAILY: "Three Times Daily",
    AS_NEEDED: "As Needed",
    "ONCE DAILY": "Once Daily",
    "TWICE DAILY": "Twice Daily",
    "THREE TIMES DAILY": "Three Times Daily",
    "AS NEEDED": "As Needed",
  };
  if (map[frequency]) return map[frequency];
  if (map[upper]) return map[upper];
  if (upper.includes("THREE") || upper.includes("THRICE") || upper.includes("TID"))
    return "Three Times Daily";
  if (upper.includes("TWICE") || upper.includes("BID") || upper.includes("BD"))
    return "Twice Daily";
  if (upper.includes("ONCE") || upper.includes("QD") || upper.includes("OD")) return "Once Daily";
  if (upper.includes("NEED")) return "As Needed";
  return "Once Daily";
}

function getFrequencyCount(frequency) {
  if (!frequency || typeof frequency !== "string") return 1;
  const dbFreq = mapFrequencyToDb(frequency);
  const map = {
    "Once Daily": 1,
    "Twice Daily": 2,
    "Three Times Daily": 3,
    "As Needed": 1,
  };
  return map[dbFreq] || 1;
}

function mapOnboardingMedicationToDb(payload, patient, userId, defaults, options = {}) {
  const frequencyDb = mapFrequencyToDb(payload.frequency);

  let value = undefined;
  let unit = undefined;

  const medType = payload.type || payload.medicationType || "";
  if (medType === "TABLET" || medType === "CAPSULE") {
    value = payload.dose?.count || payload.dosePerIntake || payload.dose?.value;
    unit = medType.toLowerCase();
  } else {
    value = payload.dose?.value || payload.dosePerIntake || payload.dose?.count;
    unit = payload.dose?.unit || payload.unit;
  }

  const dosePerIntake = Number.isInteger(value) ? value : payload.dosePerIntake || null;
  const unitDb = unit ? unit.toUpperCase() : payload.unit ? payload.unit.toUpperCase() : "TABLET";

  const foodContext =
    payload.foodFrequency ||
    payload.food_frequency ||
    payload.foodContext ||
    payload.food_context ||
    defaults.food_context ||
    "AFTER_FOOD";
  const foodFrequency =
    String(foodContext).toUpperCase() === "BEFORE_FOOD" ? "BEFORE_FOOD" : "AFTER_FOOD";

  const frequencyCount = getFrequencyCount(payload.frequency);
  const dailyConsumption = payload.dailyConsumption || Math.ceil(value || 1) * frequencyCount;

  function formatHHMMSS(t) {
    if (!t || typeof t !== "string") return "08:00:00";
    const parts = t.trim().split(":");
    const hh = parts[0].padStart(2, "0");
    const mm = (parts[1] || "00").padStart(2, "0");
    const ss = (parts[2] || "00").padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  let timeSchedule = null;
  const rawSched = payload.medicationSchedule;
  const rawTimes =
    Array.isArray(rawSched) && rawSched.length > 0
      ? rawSched
      : Array.isArray(rawSched?.times) && rawSched.times.length > 0
        ? rawSched.times
        : Array.isArray(rawSched?.reminderTimes) && rawSched.reminderTimes.length > 0
          ? rawSched.reminderTimes
          : Array.isArray(payload.reminderTimes) && payload.reminderTimes.length > 0
            ? payload.reminderTimes
            : Array.isArray(payload.times) && payload.times.length > 0
              ? payload.times
              : Array.isArray(payload.medicationTime) && payload.medicationTime.length > 0
                ? payload.medicationTime
                : null;

  if (
    rawSched &&
    typeof rawSched === "object" &&
    !Array.isArray(rawSched) &&
    (rawSched.Morning ||
      rawSched.morning ||
      rawSched.Noon ||
      rawSched.noon ||
      rawSched.Night ||
      rawSched.night ||
      rawSched.Custom ||
      rawSched.custom)
  ) {
    timeSchedule = {};
    if (rawSched.Morning || rawSched.morning) {
      timeSchedule.Morning = formatHHMMSS(rawSched.Morning || rawSched.morning);
    }
    if (rawSched.Noon || rawSched.noon) {
      timeSchedule.Noon = formatHHMMSS(rawSched.Noon || rawSched.noon);
    }
    if (rawSched.Night || rawSched.night) {
      timeSchedule.Night = formatHHMMSS(rawSched.Night || rawSched.night);
    }
    if (rawSched.Custom || rawSched.custom) {
      const c = rawSched.Custom || rawSched.custom;
      timeSchedule.Custom = Array.isArray(c) ? c.map(formatHHMMSS) : [formatHHMMSS(c)];
    }
  } else if (Array.isArray(rawTimes) && rawTimes.length > 0) {
    timeSchedule = {};
    rawTimes.forEach((t) => {
      const timeStr = formatHHMMSS(t);
      const hour = parseInt(timeStr.split(":")[0], 10);
      if (hour < 12 && !timeSchedule.Morning) timeSchedule.Morning = timeStr;
      else if (hour >= 12 && hour < 17 && !timeSchedule.Noon) timeSchedule.Noon = timeStr;
      else if (hour >= 17 && !timeSchedule.Night) timeSchedule.Night = timeStr;
      else {
        if (!timeSchedule.Custom) timeSchedule.Custom = [];
        timeSchedule.Custom.push(timeStr);
      }
    });
  }

  if (!timeSchedule || Object.keys(timeSchedule).length === 0) {
    if (frequencyDb === "Three Times Daily") {
      timeSchedule = { Morning: "08:00:00", Noon: "14:00:00", Night: "20:00:00" };
    } else if (frequencyDb === "Twice Daily") {
      timeSchedule = { Morning: "08:00:00", Night: "20:00:00" };
    } else if (
      defaults &&
      defaults.medicationSchedule &&
      Object.keys(defaults.medicationSchedule).length > 0
    ) {
      timeSchedule = defaults.medicationSchedule;
    } else {
      timeSchedule = { Morning: "08:00:00" };
    }
  }

  const medicationSchedule = {
    ...timeSchedule,
    dose: { value, unit },
    source: payload.source || "MANUAL",
    refillAlert: payload.refillAlert !== undefined ? !!payload.refillAlert : !!payload.refill_alert,
    foodContext: foodFrequency,
  };

  const rawTotalQty =
    payload.totalQuantity !== undefined
      ? payload.totalQuantity
      : payload.total_quantity !== undefined
        ? payload.total_quantity
        : payload.quantity !== undefined
          ? payload.quantity
          : payload.qty !== undefined
            ? payload.qty
            : 1;

  return {
    userId,
    patientCode: patient.patientCode,
    medicationName: payload.medicationName || payload.name,
    medicationType: payload.medicationType || payload.type,
    prescribedBy: payload.prescribedBy || payload.prescribed_by || null,
    dosePerIntake,
    frequency: frequencyDb,
    medicationSchedule,
    foodFrequency,
    startDate: payload.startDate ? new Date(payload.startDate) : new Date(),
    endDate: payload.endDate ? new Date(payload.endDate) : null,
    ongoing:
      options.ongoing !== undefined
        ? options.ongoing
        : payload.ongoing !== undefined
          ? payload.ongoing
          : false,
    totalQuantity: Number(rawTotalQty) > 0 ? Number(rawTotalQty) : 1,
    unit: unitDb,
    dailyConsumption,
    reminderBeforeMinutes: payload.reminderBeforeMinutes || 5,
    notes: payload.notes || payload.instructions || null,
    clientMedId: payload.clientMedId || payload.client_med_id,
    softDelete: false,
  };
}

module.exports = {
  SUGGESTED_ACTIONS,
  findMedicationDuplicates,
  mapOnboardingMedicationToDb,
  normalizeMedicationName,
  throwDuplicateConflict,
};
