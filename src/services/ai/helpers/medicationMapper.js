/**
 * Map AI-extracted medications into the existing `medications` table.
 *
 * Why a dedicated service
 * ───────────────────────
 * The AI extractor returns medications as free-form objects:
 *
 *     { name, dosage, frequency, timing, duration, instructions }
 *
 * The existing `medications` table is strictly typed (enum frequency,
 * enum medication type, enum food timing, integer dose, etc.). This
 * mapper performs a deterministic, dependency-free translation so the
 * persistence flow can insert valid rows without rejecting the whole
 * transaction over a single bad value. Anything that cannot be mapped
 * is dropped from the insert payload and recorded in the response so
 * the FE can prompt the user to complete it manually.
 *
 * No LLM calls happen here — the upstream AI step already produced the
 * raw extraction. We only normalize.
 */

const { foodType } = require("../../../enums/foodType");
const { frequencyType } = require("../../../enums/frequencyType");
const { medictationType } = require("../../../enums/medicationType");
const { medicationUnit } = require("../../../enums/medicationUnit");

const TYPE_HINTS = [
  { keys: ["tab", "tablet"], value: medictationType.TABLET },
  { keys: ["cap", "capsule"], value: medictationType.CAPSULE },
  { keys: ["syrup", "suspension"], value: medictationType.SYRUP },
  { keys: ["drop"], value: medictationType.DROP },
  { keys: ["inj", "injection", "shot"], value: medictationType.INJECTION },
];

const FREQUENCY_HINTS = [
  {
    keys: ["once daily", "once a day", "od", "qd", "1-0-0", "0-0-1", "0-1-0"],
    value: frequencyType.ONCE_DAILY,
  },
  {
    keys: ["twice daily", "bd", "bid", "1-0-1", "1-1-0", "0-1-1"],
    value: frequencyType.TWICE_DAILY,
  },
  {
    keys: ["thrice", "three times", "tds", "tid", "1-1-1"],
    value: frequencyType.THREE_TIMES_DAILY,
  },
  { keys: ["as needed", "prn", "sos"], value: frequencyType.AS_NEEDED },
];

const FOOD_HINTS = [
  { keys: ["before food", "before meal", "ac", "empty stomach"], value: foodType.BEFORE_FOOD },
  {
    keys: ["after food", "after meal", "pc", "with food", "with meal"],
    value: foodType.AFTER_FOOD,
  },
];

const UNIT_HINTS = [
  {
    keys: ["mg", "mcg", "g", "tablet", "tab", "cap", "capsule", "pill"],
    value: medicationUnit.PILLS,
  },
  { keys: ["ml", "millilit"], value: medicationUnit.ML },
  { keys: ["drop"], value: medicationUnit.DROPS },
  { keys: ["iu", "unit"], value: medicationUnit.UNITS },
];

function lower(value) {
  return String(value || "").toLowerCase();
}

function matchHint(hints, ...candidates) {
  const haystack = candidates.map(lower).join(" ");
  for (const hint of hints) {
    if (hint.keys.some((key) => haystack.includes(key))) {
      return hint.value;
    }
  }
  return null;
}

function parseDosePerIntake(dosage) {
  if (!dosage) return null;
  const match = String(dosage).match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num);
}

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

function inferDailyConsumption(frequency) {
  switch (frequency) {
    case frequencyType.ONCE_DAILY:
      return 1;
    case frequencyType.TWICE_DAILY:
      return 2;
    case frequencyType.THREE_TIMES_DAILY:
      return 3;
    default:
      return 0;
  }
}

class MedicationMapper {
  /**
   * Map AI medications to insertable medication rows. Returns
   *
   *   { rows: [...], skipped: [{ raw, reason }, ...] }
   *
   * Only complete-enough rows (name + frequency + type + unit) are inserted.
   */
  buildRows({ userId, patientCode, medications, defaults = {} }) {
    if (!Array.isArray(medications) || medications.length === 0) {
      return { rows: [], skipped: [] };
    }

    const rows = [];
    const skipped = [];

    const startDate = defaults.startDate || new Date().toISOString().slice(0, 10);
    const prescribedBy = defaults.prescribedBy || null;

    for (const med of medications) {
      if (!med || typeof med !== "object") continue;

      const name = (med.name || med.medicineName || "").trim();
      if (!name) {
        skipped.push({ raw: med, reason: "missing name" });
        continue;
      }

      const medicationType =
        matchHint(TYPE_HINTS, name, med.dosage, med.instructions) || medictationType.TABLET;
      const frequency = matchHint(FREQUENCY_HINTS, med.frequency, med.timing, med.instructions);
      if (!frequency) {
        skipped.push({ raw: med, reason: "unable to map frequency" });
        continue;
      }

      const foodFrequency = matchHint(FOOD_HINTS, med.timing, med.instructions);
      const unit =
        matchHint(UNIT_HINTS, med.dosage) ||
        (medicationType === medictationType.SYRUP
          ? medicationUnit.ML
          : medicationType === medictationType.DROP
            ? medicationUnit.DROPS
            : medicationType === medictationType.INJECTION
              ? medicationUnit.UNITS
              : medicationUnit.PILLS);

      const dosePerIntake = parseDosePerIntake(med.dosage);
      const dailyConsumption = inferDailyConsumption(frequency);
      const durationDays = parseDurationDays(med.duration);
      const start = new Date(startDate);
      const endDate = durationDays
        ? new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        : null;

      rows.push({
        bestTaken: foodFrequency ? [foodFrequency] : null,
        dailyConsumption,
        dosePerIntake,
        doseReminders: false,
        endDate,
        foodFrequency,
        frequency,
        medicationName: name,
        medicationTime: med.timing ? [String(med.timing)] : [],
        medicationType,
        notes: med.instructions ? String(med.instructions).slice(0, 1000) : null,
        ongoing: !endDate,
        patientCode,
        prescribedBy,
        refillAlert: false,
        reminderBeforeMinutes: 5,
        remainingQuantity: 0,
        startDate,
        totalQuantity: 0,
        unit,
        userId,
      });
    }

    return { rows, skipped };
  }
}

module.exports = new MedicationMapper();
