const { and, asc, count, desc, eq, ilike, or, sql } = require("drizzle-orm");

const { db } = require("../configs/db");

const { medication } = require("../models/medication");

// const medicationSortColumns = Object.freeze({
//   createdAt: medication.createdAt,
//   medicationName: medication.medicationName,
//   startDate: medication.startDate,
//   updatedAt: medication.updatedAt,
// });

const filterSortColumnMap = Object.freeze({
  createdAt: medication.createdAt,
  medicationName: medication.medicationName,
  medicationType: medication.medicationType,
  frequency: medication.frequency,
  startDate: medication.startDate,
  updatedAt: medication.updatedAt,
});

function buildMedicationFilters(filters = {}) {
  const conditions = [eq(medication.softDelete, false)];

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
        ilike(sql`${medication.withFood}::text`, search),
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

  async findById(id) {
    console.log("id", id);
    const result = await db
      .select()
      .from(medication)
      .where(and(eq(medication.id, id), eq(medication.softDelete, false)))
      .limit(1);

    console.log("DB RESULT:", result);

    return result[0] || null;
  }

  async findAllWithFilters({ filter = {}, sort = {} }) {
    const where = buildMedicationFilters(filter);

    const orderClause = buildOrderClause(sort);

    const rows = await db.select().from(medication).where(where).orderBy(orderClause);

    const totalRows = await db.select({ total: count() }).from(medication).where(where);

    return {
      rows,
      total: Number(totalRows[0]?.total || 0),
    };
  }

  async findAllWithPagination({ filter = {}, page = {}, sort = {} }) {
    const where = buildMedicationFilters(filter);
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
    const result = await db
      .select()
      .from(medication)
      .where(and(eq(medication.userId, userId), eq(medication.softDelete, false)));

    return result;
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

  async softDeleteById(id) {
    const result = await db
      .update(medication)
      .set({
        softDelete: true,
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(medication.id, id), eq(medication.softDelete, false)))
      .returning();

    return result[0] || null;
  }
}

module.exports = new MedicationRepository();
