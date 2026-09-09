const { and, count, eq, gte, lte } = require("drizzle-orm");

const { db } = require("../configs/db");
const { medication } = require("../models/medication");
const { document } = require("../models/document");
const { medicationReminderOccurrence } = require("../models/medicationReminderOccurrence");

class DashboardRepository {
  async getMedicinesCount(userId) {
    const result = await db
      .select({ total: count() })
      .from(medication)
      .where(and(eq(medication.userId, userId), eq(medication.softDelete, false)));

    return Number(result[0]?.total || 0);
  }

  async getDocumentsCount(userId) {
    const result = await db
      .select({ total: count() })
      .from(document)
      .where(and(eq(document.userId, userId), eq(document.softDelete, false)));

    return Number(result[0]?.total || 0);
  }

  async getTodayDosesCount(patientId) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const result = await db
      .select({ total: count() })
      .from(medicationReminderOccurrence)
      .where(
        and(
          eq(medicationReminderOccurrence.patientId, patientId),
          eq(medicationReminderOccurrence.softDelete, false),
          gte(medicationReminderOccurrence.actualMedicationTime, startOfDay),
          lte(medicationReminderOccurrence.actualMedicationTime, endOfDay),
        ),
      );

    return Number(result[0]?.total || 0);
  }
}

module.exports = new DashboardRepository();
