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

// FILTERS
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

// SORT
function buildOrderClause(sort = {}) {
  const sortColumn = filterSortColumnMap[sort.sortBy] || medication.createdAt;

  return sort.sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn);
}

class MedicationRepository {

  // CREATE
  async create(data) {
    const result = await db.insert(medication).values(data).returning();

    return result[0] || null;
  }

  // FIND BY ID
  async findById(id) {
    const result = await db
      .select()
      .from(medication)
      .where(
        and(
          eq(medication.id, id),

          eq(medication.softDelete, false),
        ),
      )
      .limit(1);

    return result[0] || null;
  }


  // FIND ALL FILTERS
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


  // PAGINATION
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

  // FIND ALL
  async findAll(userId) {
    return db
      .select()
      .from(medication)
      .where(
        and(
          eq(medication.softDelete, false),

          eq(medication.userId, userId),
        ),
      );
  }


  // UPDATE BY ID
  async updateById(id, payload) {
    const result = await db
      .update(medication)
      .set({
        ...payload,

        updatedAt: new Date(),
      })
      .where(
        and(
          eq(medication.id, id),

          eq(medication.softDelete, false),
        ),
      )
      .returning();

    return result[0] || null;
  }


  // FIND ALL ACTIVE
  async findAllActive() {
    return db.select().from(medication).where(eq(medication.softDelete, false));
  }


  // REDUCE QUANTITY
  async reduceQuantity(medicationId, quantity = 1) {
    const existingMedication = await this.findById(medicationId);

    if (!existingMedication) {
      return null;
    }

    const updatedQuantity = Math.max(
      0,

      Number(existingMedication.remainingQuantity) - Number(quantity),
    );

    const result = await db
      .update(medication)
      .set({
        remainingQuantity: updatedQuantity,

        updatedAt: new Date(),
      })
      .where(
        and(
          eq(medication.id, medicationId),

          eq(medication.softDelete, false),
        ),
      )
      .returning();

    return result[0] || null;
  }



  // ADD QUANTITY
  async addQuantity(medicationId, quantity = 0) {
    const existingMedication = await this.findById(medicationId);

    if (!existingMedication) {
      return null;
    }

    const updatedQuantity = Number(existingMedication.remainingQuantity) + Number(quantity);

    const result = await db
      .update(medication)
      .set({
        remainingQuantity: updatedQuantity,

        totalQuantity: Number(existingMedication.totalQuantity) + Number(quantity),

        updatedAt: new Date(),
      })
      .where(
        and(
          eq(medication.id, medicationId),

          eq(medication.softDelete, false),
        ),
      )
      .returning();

    return result[0] || null;
  }

  // SOFT DELETE
  async softDeleteById(id) {
    const result = await db
      .update(medication)
      .set({
        softDelete: true,

        updatedAt: new Date(),
      })
      .where(
        and(
          eq(medication.id, id),

          eq(medication.softDelete, false),
        ),
      )
      .returning();

    return result[0] || null;
  }
}

module.exports = new MedicationRepository();
