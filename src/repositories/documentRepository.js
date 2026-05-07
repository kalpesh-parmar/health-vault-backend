const { and, asc, count, desc, eq, ilike, or, sql, isNull } = require("drizzle-orm");

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
  const conditions = [or(eq(document.softDelete, false), isNull(document.softDelete))];

  if (filters.userId) {
    conditions.push(eq(document.userId, filters.userId));
  }

  if (filters.documentType) {
    conditions.push(ilike(document.documentType, filters.documentType.trim()));
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

function buildFilterSortConditions(filter = {}, userId) {
  const conditions = [or(eq(document.softDelete, false), isNull(document.softDelete))];

  if (userId) {
    conditions.push(eq(document.userId, String(userId)));
  }

  if (filter.title) {
    conditions.push(eq(document.fileName, filter.title));
  }

  if (filter.fileName) {
    conditions.push(eq(document.fileName, filter.fileName));
  }

  const docType = filter.documentType || filter.type;
  if (docType) {
    conditions.push(eq(document.documentType, docType.trim()));
  }

  if (filter.fileType) {
    conditions.push(eq(document.fileType, filter.fileType));
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
  if (sort.sortBy === "documentType") {
    return sort.orderBy === "desc" ? desc(sql`${sortColumn}::text`) : asc(sql`${sortColumn}::text`);
  }

  return sort.orderBy === "desc" ? desc(sortColumn) : asc(sortColumn);
}

class DocumentRepository {
  async create(data) {
    const result = await db.insert(document).values(data).returning();
    return result[0] || null;
  }
  async update(id, data) {
    const result = await db.update(document).set(data).where(eq(document.id, id)).returning();

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

  async findAllByFilterSortAndPagination({ filter = {}, page, sort = {}, userId }) {
    if (!userId) {
      throw new Error("UserId is required");
    }
    const conditions = buildFilterSortConditions(filter, userId);
    const orderClause = buildOrderClause(sort);
    const pageNumber = page?.pageNumber ?? 1;
    const pageLimit = page?.pageLimit ?? 10;

    const offset = (pageNumber - 1) * pageLimit;
    const limit = pageLimit;

    const data = await db
      .select()
      .from(document)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset);
    console.log("data===", data);

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
