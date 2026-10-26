const { eq, and, desc } = require("drizzle-orm");
const { db } = require("../configs/db");
const { medicationOccurrenceHistory } = require("../models/medicationOccurrenceHistory");

class MedicationOccurrenceHistoryRepository {
  /**
   * Log an immutable occurrence state transition
   * @param {Object} data - History payload
   * @param {Object} [tx] - Optional Drizzle transaction client
   * @returns {Promise<Object>} Created history record
   */
  async create(data, tx = db) {
    const client = tx || db;
    const result = await client
      .insert(medicationOccurrenceHistory)
      .values({
        occurrenceId: data.occurrenceId,
        patientId: data.patientId,
        fromStatus: data.fromStatus,
        toStatus: data.toStatus,
        completionClassification: data.completionClassification || null,
        actionTimestamp: data.actionTimestamp || new Date(),
        completedAt: data.completedAt || null,
        delayMinutes: data.delayMinutes !== undefined ? data.delayMinutes : null,
        actor: data.actor || "PATIENT",
        notes: data.notes || null,
      })
      .returning();

    return result[0] || null;
  }

  /**
   * Get all history transitions for a specific occurrence
   * @param {string} occurrenceId - Occurrence UUID
   * @param {string} patientId - Patient UUID for tenant isolation
   * @param {Object} [tx] - Optional Drizzle transaction client
   * @returns {Promise<Array>} History records
   */
  async findByOccurrenceId(occurrenceId, patientId, tx = db) {
    const client = tx || db;
    const conditions = [eq(medicationOccurrenceHistory.occurrenceId, occurrenceId)];
    if (patientId) {
      conditions.push(eq(medicationOccurrenceHistory.patientId, patientId));
    }

    return client
      .select()
      .from(medicationOccurrenceHistory)
      .where(and(...conditions))
      .orderBy(desc(medicationOccurrenceHistory.actionTimestamp));
  }

  /**
   * Get latest history record for an occurrence
   * @param {string} occurrenceId - Occurrence UUID
   * @param {Object} [tx] - Optional Drizzle transaction client
   * @returns {Promise<Object|null>} Latest history record
   */
  async findLatestByOccurrenceId(occurrenceId, tx = db) {
    const client = tx || db;
    const result = await client
      .select()
      .from(medicationOccurrenceHistory)
      .where(eq(medicationOccurrenceHistory.occurrenceId, occurrenceId))
      .orderBy(desc(medicationOccurrenceHistory.actionTimestamp))
      .limit(1);

    return result[0] || null;
  }
}

module.exports = new MedicationOccurrenceHistoryRepository();
