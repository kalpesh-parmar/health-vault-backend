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
  const map = {
    ONCE: "Once Daily",
    TWICE: "Twice Daily",
    THRICE: "Three Times Daily",
    "Once Daily": "Once Daily",
    "Twice Daily": "Twice Daily",
    "Three Times Daily": "Three Times Daily",
  };
  return map[frequency] || "Once Daily";
}

function getFrequencyCount(frequency) {
  const map = {
    ONCE: 1,
    TWICE: 2,
    THRICE: 3,
    "Once Daily": 1,
    "Twice Daily": 2,
    "Three Times Daily": 3,
  };
  return map[frequency] || 1;
}

function mapOnboardingMedicationToDb(payload, patient, userId, defaults, options = {}) {
  const frequencyDb = mapFrequencyToDb(payload.frequency);

  let value = undefined;
  let unit = undefined;

  if (payload.type === "TABLET" || payload.type === "CAPSULE") {
    value = payload.dose?.count;
    unit = payload.type.toLowerCase();
  } else {
    value = payload.dose?.value;
    unit = payload.dose?.unit;
  }

  const dosePerIntake = Number.isInteger(value) ? value : null;
  const unitDb = unit ? unit.toUpperCase() : "TABLET";

  const foodContext = payload.foodContext || defaults.food_context;
  const foodFrequency = foodContext === "BEFORE_FOOD" ? "BEFORE_FOOD" : "AFTER_FOOD";

  const frequencyCount = getFrequencyCount(payload.frequency);
  const dailyConsumption = Math.ceil(value || 1) * frequencyCount;

  let timeSchedule;
  if (
    payload.medicationSchedule &&
    (payload.medicationSchedule.Morning ||
      payload.medicationSchedule.Noon ||
      payload.medicationSchedule.Night ||
      payload.medicationSchedule.Custom)
  ) {
    timeSchedule = {
      Morning: payload.medicationSchedule.Morning,
      Noon: payload.medicationSchedule.Noon,
      Night: payload.medicationSchedule.Night,
      Custom: payload.medicationSchedule.Custom,
    };
  } else {
    timeSchedule = defaults.medicationSchedule;
  }

  const medicationSchedule = {
    ...timeSchedule,
    dose: { value, unit },
    source: payload.source || "MANUAL",
    refillAlert: !!payload.refill_alert,
    foodContext: foodFrequency,
  };

  return {
    userId,
    patientCode: patient.patientCode,
    medicationName: payload.name,
    medicationType: payload.type,
    prescribedBy: payload.prescribed_by || null,
    dosePerIntake,
    frequency: frequencyDb,
    medicationSchedule,
    foodFrequency,
    startDate: payload.startDate ? new Date(payload.startDate) : new Date(),
    endDate: null,
    ongoing: options.ongoing !== undefined ? options.ongoing : false,
    totalQuantity: payload.total_quantity !== undefined ? payload.total_quantity : 0,
    unit: unitDb,
    dailyConsumption,
    reminderBeforeMinutes: payload.reminderBeforeMinutes || 5,
    notes: payload.notes || null,
    clientMedId: payload.client_med_id,
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
