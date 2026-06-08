const { and, asc, desc, eq, ilike, or, sql } = require("drizzle-orm");

const { db } = require("../configs/db");
const { notification } = require("../models/notification");

const sortMap = Object.freeze({
  createdAt: notification.createdAt,
  createdBy: notification.userId,
  title: notification.title,
});

function buildConditions(filter = {}, userId) {
  const conditions = [];

  if (userId) {
    conditions.push(eq(notification.userId, userId));
  }

  if (filter.isRead !== undefined) {
    conditions.push(eq(notification.isRead, filter.isRead));
  }

  if (filter.search) {
    const search = `%${filter.search}%`;
    conditions.push(or(ilike(notification.title, search), ilike(notification.body, search)));
  }

  return conditions;
}

function buildOrderClause(sort = {}) {
  const sortColumn = sortMap[sort.sortBy] || notification.createdAt;
  return sort.orderBy === "desc" ? desc(sortColumn) : asc(sortColumn);
}

class NotificationRepository {
  async create(data) {
    const result = await db.insert(notification).values(data).returning();
    return result[0] || null;
  }

  async findById(id) {
    const result = await db.select().from(notification).where(eq(notification.id, id)).limit(1);
    return result[0] || null;
  }

  async list({ filter = {}, sort = {}, userId }) {
    const conditions = buildConditions(filter, userId);
    if (userId) {
      conditions.push(eq(notification.userId, userId));
    }
    const orderClause = buildOrderClause(sort);

    return db
      .select()
      .from(notification)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(orderClause);
  }

  async listPaginated({ filter = {}, page, sort = {}, userId }) {
    const conditions = buildConditions(filter, userId);
    const orderClause = buildOrderClause(sort);
    const offset = page.pageNumber * page.pageLimit;

    const data = await db
      .select()
      .from(notification)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(orderClause)
      .limit(page.pageLimit)
      .offset(offset);
    const totalRecordsResult = await db
      .select({ count: sql`count(*)` })
      .from(notification)
      .where(conditions.length ? and(...conditions) : undefined);
    const totalRecords = Number(totalRecordsResult[0].count);

    return {
      data,
      page: {
        pageLimit: page.pageLimit,
        pageNumber: page.pageNumber,
        totalPages: Math.ceil(totalRecords / page.pageLimit),
        totalRecords,
      },
    };
  }

  async markRead(id) {
    const result = await db
      .update(notification)
      .set({
        isRead: true,
        updatedAt: new Date(),
      })
      .where(eq(notification.id, id))
      .returning();

    return result[0] || null;
  }

  async markAllRead(userId) {
    return db
      .update(notification)
      .set({
        isRead: true,
        updatedAt: new Date(),
      })
      .where(eq(notification.userId, userId))
      .returning();
  }

  async deleteById(id) {
    const result = await db.delete(notification).where(eq(notification.id, id)).returning();
    return result[0] || null;
  }

  async getUnreadCount(userId) {
    const result = await db
      .select({ count: sql`count(*)` })
      .from(notification)
      .where(and(eq(notification.userId, userId), eq(notification.isRead, false)));

    return Number(result[0].count);
  }
}

module.exports = new NotificationRepository();
