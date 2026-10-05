const { sql, eq, and, asc, desc, ilike, or } = require("drizzle-orm");
const { db } = require("../configs/db");
const { refillCount } = require("../models/refillCount");
const { medication } = require("../models/medication");

const filterSortColumnMap = Object.freeze({
  createdAt: refillCount.createdAt,
  medicationId: refillCount.medicationId,
  beforeRefillRemainingQuantity: refillCount.beforeRefillRemainingQuantity,
  beforeRefillTotalQuantity: refillCount.beforeRefillTotalQuantity,
  afterRefillRemainingQuantity: refillCount.afterRefillRemainingQuantity,
  afterRefillTotalQuantity: refillCount.afterRefillTotalQuantity,
});

function buildOrderClause(sort = {}) {
  const sortColumn = filterSortColumnMap[sort.sortBy] || refillCount.createdAt;

  return sort.sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn);
}

// FILTERS
function buildRefillCountFilters(filters = {}, userId) {
  const conditions = [eq(refillCount.softDelete, false)];

  if (userId) {
    conditions.push(eq(refillCount.userId, String(userId)));
  }

  if (filters.medicationId) {
    conditions.push(eq(refillCount.medicationId, filters.medicationId));
  }

  if (filters.beforeRefillRemainingQuantity) {
    conditions.push(
      eq(refillCount.beforeRefillRemainingQuantity, filters.beforeRefillRemainingQuantity),
    );
  }

  if (filters.beforeRefillTotalQuantity) {
    conditions.push(eq(refillCount.beforeRefillTotalQuantity, filters.beforeRefillTotalQuantity));
  }

  if (filters.afterRefillRemainingQuantity) {
    conditions.push(
      eq(refillCount.afterRefillRemainingQuantity, filters.afterRefillRemainingQuantity),
    );
  }

  if (filters.afterRefillTotalQuantity) {
    conditions.push(eq(refillCount.afterRefillTotalQuantity, filters.afterRefillTotalQuantity));
  }

  if (filters.search) {
    const search = `%${filters.search}%`;

    conditions.push(
      or(
        ilike(refillCount.userId, search),
        ilike(refillCount.medicationId, search),
        ilike(refillCount.beforeRefillRemainingQuantity, search),
        ilike(refillCount.afterRefillRemainingQuantity, search),
        ilike(refillCount.beforeRefillTotalQuantity, search),
        ilike(refillCount.afterRefillTotalQuantity, search),
      ),
    );
  }

  return and(...conditions);
}

class refillRepository {
  async add(data) {
    const result = await db.insert(refillCount).values(data).returning();
    return result[0] || null;
  }
  async getUnreadCount(medicationId) {
    // const result = await db
    //   .select({ count: sql`count(*)` })
    //   .from(refillCount)
    //   .where(and(eq(refillCount.medicationId, medicationId), eq(refillCount.softDelete, false)));
    // return Number(result[0].count);
    const [list, countResult] = await Promise.all([
      db
        .select()
        .from(refillCount)
        .where(and(eq(refillCount.medicationId, medicationId), eq(refillCount.softDelete, false))),

      db
        .select({ count: sql`count(*)` })
        .from(refillCount)
        .where(and(eq(refillCount.medicationId, medicationId), eq(refillCount.softDelete, false))),
    ]);

    return {
      count: Number(countResult[0].count),
      list,
    };
  }
  async getRefillList(userId) {
    const result = await db
      .select()
      .from(refillCount)
      .where(and(eq(refillCount.userId, userId), eq(refillCount.softDelete, false)))
      .orderBy(desc(refillCount.createdAt));
    return result;
  }
  async findAllByUserId(userId) {
    try {
      const query = db
        .select({
          id: refillCount.id,
          userId: refillCount.userId,
          medicationId: refillCount.medicationId,
          medicationName: medication.medicationName,
          unit: medication.unit,
          beforeRefillTotalQuantity: refillCount.beforeRefillTotalQuantity,
          beforeRefillRemainingQuantity: refillCount.beforeRefillRemainingQuantity,
          refillQuantity: refillCount.refillQuantity,
          afterRefillTotalQuantity: refillCount.afterRefillTotalQuantity,
          afterRefillRemainingQuantity: refillCount.afterRefillRemainingQuantity,
          createdAt: refillCount.createdAt,
          updatedAt: refillCount.updatedAt,
        })
        .from(refillCount);

      if (typeof query.innerJoin === "function") {
        return await query
          .innerJoin(medication, eq(medication.id, refillCount.medicationId))
          .where(and(eq(refillCount.userId, String(userId)), eq(refillCount.softDelete, false)))
          .orderBy(desc(refillCount.createdAt));
      }
    } catch {
      // Fall through to simple query
    }

    return db
      .select()
      .from(refillCount)
      .where(and(eq(refillCount.userId, String(userId)), eq(refillCount.softDelete, false)))
      .orderBy(desc(refillCount.createdAt));
  }
  async findLatestByUserId(userId) {
    try {
      const query = db
        .select({
          id: refillCount.id,
          userId: refillCount.userId,
          medicationId: refillCount.medicationId,
          medicationName: medication.medicationName,
          unit: medication.unit,
          beforeRefillTotalQuantity: refillCount.beforeRefillTotalQuantity,
          beforeRefillRemainingQuantity: refillCount.beforeRefillRemainingQuantity,
          refillQuantity: refillCount.refillQuantity,
          afterRefillTotalQuantity: refillCount.afterRefillTotalQuantity,
          afterRefillRemainingQuantity: refillCount.afterRefillRemainingQuantity,
          createdAt: refillCount.createdAt,
        })
        .from(refillCount);

      if (typeof query.innerJoin === "function") {
        const results = await query
          .innerJoin(medication, eq(medication.id, refillCount.medicationId))
          .where(and(eq(refillCount.userId, String(userId)), eq(refillCount.softDelete, false)))
          .orderBy(desc(refillCount.createdAt))
          .limit(1);
        return results[0] || null;
      }
    } catch {
      // Fall through to simple query
    }

    const results = await db
      .select()
      .from(refillCount)
      .where(and(eq(refillCount.userId, String(userId)), eq(refillCount.softDelete, false)))
      .orderBy(desc(refillCount.createdAt))
      .limit(1);
    return results[0] || null;
  }
  async findAllWithFilters({ filter = {}, page = {}, sort = {}, userId }) {
    const where = buildRefillCountFilters(filter, userId);
    const orderClause = buildOrderClause(sort);
    const pageLimit = page.pageLimit || 10;
    const pageNumber = page.pageNumber || 1;
    const offset = (pageNumber - 1) * pageLimit;
    const result = await db
      .select()
      .from(refillCount)
      .where(where)
      .orderBy(orderClause)
      .limit(pageLimit)
      .offset(offset);

    return result;
  }
  async count(filters, userId) {
    const where = buildRefillCountFilters(filters, userId);
    const result = await db
      .select({ count: sql`count(*)` })
      .from(refillCount)
      .where(where);
    return Number(result[0].count);
  }
  async findLatestRefillByMedicationId(medicationId) {
    const result = await db
      .select()
      .from(refillCount)
      .where(and(eq(refillCount.medicationId, medicationId), eq(refillCount.softDelete, false)))
      .orderBy(desc(refillCount.createdAt))
      .limit(1);
    return result[0] || null;
  }
}
module.exports = new refillRepository();
