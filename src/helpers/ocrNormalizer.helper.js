const sharp = require("sharp");

async function preprocessImage(imageBuffer) {
  try {
    console.log(
      "[OcrService] Preprocessing image with Sharp: auto-orient, resize (max 1600px), converting to jpeg",
    );
    const processedBuffer = await sharp(imageBuffer)
      .rotate()
      .resize({
        width: 1600,
        height: 1600,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    return processedBuffer;
  } catch (error) {
    console.warn(
      "[OcrService] Image preprocessing failed, falling back to raw buffer:",
      error.message,
    );
    return imageBuffer;
  }
}

async function processInBatches(items, batchSize, processFn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processFn));
    results.push(...batchResults);
  }
  return results;
}

function cleanOcrText(text) {
  if (!text || typeof text !== "string") return "";

  let cleaned = text;
  // Strip <think>...</think> blocks
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // Split into lines to clean line-by-line reasoning
  const lines = cleaned.split("\n");
  const filteredLines = lines.filter((line) => {
    const trimmed = line.trim().toLowerCase();
    if (
      trimmed.startsWith("wait,") ||
      trimmed.startsWith("let me check") ||
      trimmed.startsWith("let me think") ||
      trimmed.startsWith("let's see") ||
      trimmed.startsWith("first, let's") ||
      trimmed.startsWith("first, let me")
    ) {
      return false;
    }
    return true;
  });

  return filteredLines.join("\n").trim();
}

function normalizeDate(dobStr) {
  if (!dobStr) return null;
  const cleaned = String(dobStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned;
  }
  const matchDmy = cleaned.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (matchDmy) {
    const day = matchDmy[1].padStart(2, "0");
    const month = matchDmy[2].padStart(2, "0");
    const year = matchDmy[3];
    return `${year}-${month}-${day}`;
  }
  return null;
}

function normalizeGender(genderStr) {
  if (!genderStr) return null;
  const cleaned = String(genderStr).trim().toLowerCase();
  if (cleaned.includes("female") || cleaned === "સ્ત્રી" || cleaned === "stri") {
    return "female";
  }
  if (cleaned.includes("male") || cleaned === "પુરુષ" || cleaned === "purush") {
    return "male";
  }
  return null;
}

function normalizeBloodGroup(bgStr) {
  if (!bgStr) return null;
  const cleaned = String(bgStr).trim().toUpperCase();
  const valid = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
  if (valid.includes(cleaned)) {
    return cleaned;
  }
  return null;
}

function normalizeEmail(emailStr) {
  if (!emailStr) return null;
  const cleaned = String(emailStr).trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(cleaned) ? cleaned : null;
}

function normalizePhone(phoneStr) {
  if (!phoneStr) return null;
  const cleaned = String(phoneStr)
    .trim()
    .replace(/[^\d+]/g, "");
  return cleaned.length >= 7 && cleaned.length <= 15 ? cleaned : null;
}

function splitName(fullName) {
  if (!fullName) return { firstName: null, middleName: null, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: null, middleName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], middleName: null, lastName: null };
  if (parts.length === 2) return { firstName: parts[0], middleName: null, lastName: parts[1] };

  const firstName = parts[0];
  const lastName = parts[parts.length - 1];
  const middleName = parts.slice(1, -1).join(" ");
  return { firstName, middleName, lastName };
}

function pickEntities(entities, type) {
  if (!Array.isArray(entities)) return [];
  return entities.filter((entity) => (entity?.type || "").toLowerCase() === type);
}

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function pickReportDate(normalized) {
  for (const prescription of normalized.prescriptions || []) {
    if (prescription?.issueDate) return prescription.issueDate;
  }
  const dateEntities = pickEntities(normalized.medicalEntities, "date");
  if (dateEntities.length) return dateEntities[0].value || dateEntities[0].name;
  return null;
}

function pickFirstField(rows, field) {
  for (const row of rows || []) {
    if (row?.[field]) return row[field];
  }
  return null;
}

function sanitizeMedicationInstructions(instructions, quantity, duration) {
  if (!instructions || typeof instructions !== "string") return null;
  const trimmed = instructions.trim();
  if (!trimmed) return null;
  // If instructions is purely a number (e.g. "30", "4"), or matches quantity/duration
  if (/^\d+$/.test(trimmed)) return null;
  if (/^\d+\s*(?:tablets?|tabs?|caps?|capsules?|pills?|times?|x)$/i.test(trimmed)) {
    return null;
  }
  if (quantity && String(quantity).trim().toLowerCase() === trimmed.toLowerCase()) return null;
  if (duration && String(duration).trim().toLowerCase() === trimmed.toLowerCase()) return null;
  return trimmed;
}

function buildMedications(normalized) {
  const medications = [];

  for (const med of normalized.medications || []) {
    if (!med) continue;
    const qty = med?.quantity || med?.qty || null;
    const duration = med?.duration || null;
    const rawDosage = med?.dosage || med?.dose || med?.timeOfDay || null;
    const instructions = sanitizeMedicationInstructions(
      med?.instructions || med?.notes,
      qty,
      duration,
    );

    medications.push({
      dosage: rawDosage ? String(rawDosage).trim() : null,
      duration: duration ? String(duration).trim() : null,
      frequency: med?.frequency || null,
      instructions,
      name: med?.name || med?.medicineName || med?.medicationName || null,
      timing: med?.timing || med?.when || null,
      quantity: qty ? String(qty).trim() : null,
      qty: qty ? String(qty).trim() : null,
      type: med?.type || null,
      prescribedBy: med?.prescribedBy || med?.doctorName || null,
    });
  }

  for (const prescription of normalized.prescriptions || []) {
    for (const med of prescription?.medications || []) {
      const qty = med?.quantity || med?.qty || null;
      const duration = med?.duration || null;
      const rawDosage = med?.dosage || med?.dose || med?.timeOfDay || null;
      const instructions = sanitizeMedicationInstructions(
        med?.instructions || med?.notes,
        qty,
        duration,
      );

      medications.push({
        dosage: rawDosage ? String(rawDosage).trim() : null,
        duration: duration ? String(duration).trim() : null,
        frequency: med?.frequency || null,
        instructions,
        name: med?.name || med?.medicineName || null,
        timing: med?.timing || null,
        quantity: qty ? String(qty).trim() : null,
        qty: qty ? String(qty).trim() : null,
        type: med?.type || null,
        prescribedBy:
          med?.prescribedBy ||
          med?.doctorName ||
          prescription?.doctorName ||
          normalized.doctorInfo?.name ||
          null,
      });
    }
  }

  return medications.filter((m) => m.name);
}

function buildLabResults(normalized) {
  const labRows = [];

  for (const result of normalized.labResults || []) {
    if (!result) continue;
    labRows.push({
      category: result?.category || result?.panel || null,
      isAbnormal: !!result?.isAbnormal,
      name: result?.name || result?.testName || null,
      normalRange: result?.normalRange || result?.referenceRange || null,
      unit: result?.unit || null,
      value: result?.value || null,
    });
  }

  for (const lab of normalized.labReports || []) {
    for (const result of lab?.results || []) {
      labRows.push({
        category: lab?.title || null,
        isAbnormal: !!result?.isAbnormal,
        name: result?.name || null,
        normalRange: result?.normalRange || null,
        unit: result?.unit || null,
        value: result?.value || null,
      });
    }
  }

  for (const entity of pickEntities(normalized.medicalEntities, "test_value")) {
    labRows.push({
      category: "entity",
      isAbnormal: !!entity.isAbnormal,
      name: entity.name,
      normalRange: entity.normalRange || null,
      unit: entity.unit || null,
      value: entity.value || null,
    });
  }

  for (const entity of pickEntities(normalized.medicalEntities, "abnormal_value")) {
    labRows.push({
      category: "abnormal",
      isAbnormal: true,
      name: entity.name,
      normalRange: entity.normalRange || null,
      unit: entity.unit || null,
      value: entity.value || null,
    });
  }

  return labRows.filter((row) => row.name || row.value);
}

function buildDiagnosis(normalized, summary) {
  const diseaseEntities = pickEntities(normalized.medicalEntities, "disease")
    .map((entity) => entity.value || entity.name)
    .filter(Boolean);
  return uniqueStrings([
    ...asArray(normalized.diagnosis),
    ...diseaseEntities,
    ...asArray(summary?.diagnosis),
  ]);
}

function buildVitals(normalized) {
  return asArray(normalized.vitals)
    .filter(Boolean)
    .map((vital) => (typeof vital === "string" ? { value: vital } : vital));
}

function joinForText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return value || null;
}

module.exports = {
  preprocessImage,
  processInBatches,
  cleanOcrText,
  normalizeDate,
  normalizeGender,
  normalizeBloodGroup,
  normalizeEmail,
  normalizePhone,
  splitName,
  pickEntities,
  asArray,
  asObject,
  uniqueStrings,
  pickReportDate,
  pickFirstField,
  buildMedications,
  buildLabResults,
  buildDiagnosis,
  buildVitals,
  joinForText,
};
