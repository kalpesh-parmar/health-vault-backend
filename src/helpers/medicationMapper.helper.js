/**
 * Map AI-extracted medications into the existing `medications` table.
 *
 * Why a dedicated service / helper
 * ───────────────────────────────
 * The AI extractor returns medications as free-form objects:
 *
 *     { name, dosage, frequency, timing, duration, instructions }
 *
 * The existing `medications` table is strictly typed (enum frequency,
 * enum medication type, enum food timing, integer dose, etc.). This
 * mapper performs a deterministic, dependency-free translation so the
 * persistence flow can insert valid rows without rejecting the whole
 * transaction over a single bad value.
 *
 * No LLM calls happen here — the upstream AI step already produced the
 * raw extraction. We only normalize.
 */

const { normalizeMedicine } = require("./medicineNormalize.helper");
const { toDbTimestamp } = require("../utils/dateUtils");

class MedicationMapper {
  /**
   * Map AI medications to insertable medication rows. Returns
   *
   *   { rows: [...], skipped: [{ raw, reason }, ...] }
   *
   * Only rows with a valid medication name are mapped.
   */
  buildRows({ userId, patientCode, medications, defaults = {} }) {
    if (!Array.isArray(medications) || medications.length === 0) {
      return { rows: [], skipped: [] };
    }

    const rows = [];
    const skipped = [];

    const normDefaults = {
      startDate: defaults.startDate,
      prescribedBy: defaults.prescribedBy,
      userId,
    };

    for (let i = 0; i < medications.length; i++) {
      const med = medications[i];
      if (!med || typeof med !== "object") continue;

      const name = (med.name || med.medicineName || med.medicationName || "").trim();
      if (!name) {
        skipped.push({ raw: med, reason: "missing name" });
        continue;
      }
      const { row } = normalizeMedicine(med, i, patientCode, normDefaults);
      // Coerce at the database boundary without mutating domain normalizer helpers
      row.startDate = toDbTimestamp(row.startDate) ?? defaults.startDate;
      row.endDate = toDbTimestamp(row.endDate);

      rows.push(row);
    }

    return { rows, skipped };
  }
}

module.exports = new MedicationMapper();
