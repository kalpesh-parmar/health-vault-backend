const { and, asc, count, desc, eq, ilike, or, sql } = require("drizzle-orm");

const { db } = require("../configs/db");
const { document } = require("../models/document");

const documentSortColumns = Object.freeze({
  createdAt: document.createdAt,
  documentType: document.documentType,
  fileName: document.fileName,
  reportDate: document.reportDate,
  updatedAt: document.updatedAt,
});

const filterSortColumnMap = Object.freeze({
  createdAt: document.createdAt,
  createdBy: document.userId,
  doctorName: document.doctorName,
  documentType: document.documentType,
  fileName: document.fileName,
  fileType: document.fileType,
  hospitalName: document.hospitalName,
  reportDate: document.reportDate,
  title: document.fileName,
  type: document.documentType,
  updatedAt: document.updatedAt,
});

function buildDocumentFilters(filters = {}) {
  const conditions = [eq(document.softDelete, false)];

  if (filters.userId) {
    conditions.push(eq(document.userId, filters.userId));
  }

  if (filters.documentType) {
    conditions.push(eq(document.documentType, filters.documentType));
  }

  if (filters.fileType) {
    conditions.push(eq(document.fileType, filters.fileType));
  }

  if (filters.search) {
    const search = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(document.fileName, search),
        ilike(document.hospitalName, search),
        ilike(document.doctorName, search),
      ),
    );
  }

  return and(...conditions);
}

function buildFilterSortConditions(filter = {}) {
  const conditions = [eq(document.softDelete, false)];

  if (filter.title) {
    conditions.push(eq(document.fileName, filter.title));
  }

  if (filter.fileName) {
    conditions.push(eq(document.fileName, filter.fileName));
  }

  if (filter.type) {
    conditions.push(eq(document.documentType, filter.type));
  }

  if (filter.documentType) {
    conditions.push(eq(document.documentType, filter.documentType));
  }

  if (filter.fileType) {
    conditions.push(eq(document.fileType, filter.fileType));
  }

  if (filter.createdBy) {
    conditions.push(eq(document.userId, filter.createdBy));
  }

  if (filter.hospitalName) {
    conditions.push(eq(document.hospitalName, filter.hospitalName));
  }

  if (filter.doctorName) {
    conditions.push(eq(document.doctorName, filter.doctorName));
  }

  if (filter.search) {
    const search = `%${filter.search}%`;
    conditions.push(
      or(
        ilike(document.fileName, search),
        ilike(document.hospitalName, search),
        ilike(document.doctorName, search),
        ilike(document.remarks, search),
        ilike(sql`${document.documentType}::text`, search),
      ),
    );
  }

  return conditions;
}

function buildOrderClause(sort = {}) {
  const sortColumn = filterSortColumnMap[sort.sortBy] || document.createdAt;
  return sort.orderBy === "desc" ? desc(sortColumn) : asc(sortColumn);
}

class DocumentRepository {
  async create(data) {
    console.log("data===", data);

    const result = await db.insert(document).values(data).returning();
    return result[0] || null;
  }

  async findById(id) {
    const result = await db
      .select()
      .from(document)
      .where(and(eq(document.id, id), eq(document.softDelete, false)))
      .limit(1);

    return result[0] || null;
  }

  async findAll(filters = {}) {
    const sortColumn = documentSortColumns[filters.sortBy] || document.createdAt;
    const orderBy = filters.sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn);
    const where = buildDocumentFilters(filters);

    const rows = await db
      .select()
      .from(document)
      .where(where)
      .orderBy(orderBy)
      .limit(filters.limit)
      .offset(filters.offset);
    const totalRows = await db.select({ total: count() }).from(document).where(where);

    return {
      rows,
      total: Number(totalRows[0]?.total || 0),
    };
  }

  async findAllByFilterAndSort({ filter = {}, sort = {} }) {
    const conditions = buildFilterSortConditions(filter);
    const orderClause = buildOrderClause(sort);

    return db
      .select()
      .from(document)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(orderClause);
  }

  async findAllByFilterSortAndPagination({ filter = {}, page, sort = {} }) {
    const conditions = buildFilterSortConditions(filter);
    const orderClause = buildOrderClause(sort);
    const offset = page.pageNumber * page.pageLimit;
    const limit = page.pageLimit;

    const data = await db
      .select()
      .from(document)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset);
    const totalRecordsResult = await db
      .select({ count: sql`count(*)` })
      .from(document)
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

  async softDeleteById(id, userId) {
    const result = await db
      .update(document)
      .set({
        deletedAt: new Date(),
        softDelete: true,
        updatedAt: new Date(),
      })
      .where(and(eq(document.id, id), eq(document.userId, userId), eq(document.softDelete, false)))
      .returning();

    return result[0] || null;
  }

  async deleteByPatientId(userId) {
    return db.delete(document).where(eq(document.userId, userId)).returning();
  }
}

module.exports = new DocumentRepository();
