const { and, asc, count, desc, eq, ilike, or, sql } = require("drizzle-orm");
const { db } = require("../configs/db");
const { medication } = require("../models/medication");

const filterSortColumnMap = Object.freeze({
  createdAt: medication.createdAt,
  medicationName: medication.medicationName,
  medicationType: medication.medicationType,
  frequency: medication.frequency,
  startDate: medication.startDate,
  updatedAt: medication.updatedAt,
});

function buildMedicationFilters(filters = {}, userId) {
  const conditions = [eq(medication.softDelete, false)];
  if (userId) {
    conditions.push(eq(medication.userId, String(userId)));
  }
  if (filters.patientCode) {
    conditions.push(eq(medication.patientCode, filters.patientCode));
  }
  if (filters.medicationType) {
    conditions.push(eq(medication.medicationType, filters.medicationType));
  }
  if (filters.frequency) {
    conditions.push(eq(medication.frequency, filters.frequency));
  }
  if (filters.search) {
    const search = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(medication.medicationName, search),
        ilike(medication.prescribedBy, search),
        ilike(medication.notes, search),
        ilike(sql`${medication.medicationType}::text`, search),
        ilike(sql`${medication.frequency}::text`, search),
        ilike(sql`${medication.foodFrequency}::text`, search),
      ),
    );
  }
  return and(...conditions);
}

function buildOrderClause(sort = {}) {
  const sortColumn = filterSortColumnMap[sort.sortBy] || medication.createdAt;
  return sort.sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn);
}

class MedicationRepository {
  async create(data) {
    const result = await db.insert(medication).values(data).returning();
    return result[0] || null;
  }

  async insert(data) {
    const result = await db
      .insert(medication)
      .values(data)
      .onConflictDoUpdate({
        target: [medication.userId, medication.clientMedId],
        set: {
          patientCode: data.patientCode,
          medicationName: data.medicationName,
          medicationType: data.medicationType,
          prescribedBy: data.prescribedBy,
          dosePerIntake: data.dosePerIntake,
          frequency: data.frequency,
          medicationSchedule: data.medicationSchedule,
          foodFrequency: data.foodFrequency,
          startDate: data.startDate,
          endDate: data.endDate,
          ongoing: data.ongoing,
          totalQuantity: data.totalQuantity,
          unit: data.unit,
          dailyConsumption: data.dailyConsumption,
          reminderBeforeMinutes: data.reminderBeforeMinutes,
          notes: data.notes,
        },
      })
      .returning();
    return result[0] || null;
  }

  async bulkInsert(dataList) {
    return await db.transaction(async (tx) => {
      const results = [];
      for (const data of dataList) {
        const res = await tx
          .insert(medication)
          .values(data)
          .onConflictDoUpdate({
            target: [medication.userId, medication.clientMedId],
            set: {
              patientCode: data.patientCode,
              medicationName: data.medicationName,
              medicationType: data.medicationType,
              prescribedBy: data.prescribedBy,
              dosePerIntake: data.dosePerIntake,
              frequency: data.frequency,
              medicationSchedule: data.medicationSchedule,
              foodFrequency: data.foodFrequency,
              startDate: data.startDate,
              endDate: data.endDate,
              ongoing: data.ongoing,
              totalQuantity: data.totalQuantity,
              unit: data.unit,
              dailyConsumption: data.dailyConsumption,
              reminderBeforeMinutes: data.reminderBeforeMinutes,
              notes: data.notes,
            },
          })
          .returning();
        results.push(res[0] || null);
      }
      return results;
    });
  }

  async findById(id) {
    const result = await db
      .select()
      .from(medication)
      .where(and(eq(medication.id, id), eq(medication.softDelete, false)))
      .limit(1);
    return result[0] || null;
  }

  async findAllWithFilters({ filter = {}, sort = {}, userId }) {
    const where = buildMedicationFilters(filter, userId);
    const orderClause = buildOrderClause(sort);
    const rows = await db.select().from(medication).where(where).orderBy(orderClause);

    const totalRows = await db
      .select({
        total: count(),
      })
      .from(medication)
      .where(where);

    return {
      rows,
      total: Number(totalRows[0]?.total || 0),
    };
  }

  async findAllWithPagination({ filter = {}, page = {}, sort = {}, userId }) {
    const where = buildMedicationFilters(filter, userId);
    const orderClause = buildOrderClause(sort);
    const pageLimit = page.pageLimit || 10;
    const pageNumber = page.pageNumber || 1;
    const offset = (pageNumber - 1) * pageLimit;
    const data = await db
      .select()
      .from(medication)
      .where(where)
      .orderBy(orderClause)
      .limit(pageLimit)
      .offset(offset);
    const totalRecordsResult = await db
      .select({
        count: sql`count(*)`,
      })
      .from(medication)
      .where(where);
    const totalRecords = Number(totalRecordsResult[0].count);
    return {
      data,
      page: {
        pageLimit,
        pageNumber,
        totalPages: Math.ceil(totalRecords / pageLimit),
        totalRecords,
      },
    };
  }

  async findAll(userId) {
    return db
      .select()
      .from(medication)
      .where(and(eq(medication.softDelete, false), eq(medication.userId, String(userId))));
  }

  async updateById(id, payload) {
    const result = await db
      .update(medication)
      .set({
        ...payload,
        updatedAt: new Date(),
      })
      .where(and(eq(medication.id, id), eq(medication.softDelete, false)))
      .returning();
    return result[0] || null;
  }

  async findAllActive(ongoing) {
    const conditions = [eq(medication.softDelete, false)];
    if (ongoing !== undefined) {
      conditions.push(eq(medication.ongoing, ongoing));
    }
    return db
      .select()
      .from(medication)
      .where(and(...conditions));
  }

  async softDeleteById(id) {
    const result = await db
      .update(medication)
      .set({
        softDelete: true,
        updatedAt: new Date(),
      })
      .where(and(eq(medication.id, id), eq(medication.softDelete, false)))
      .returning();
    return result[0] || null;
  }
}

module.exports = new MedicationRepository();
