const { and, asc, count, desc, eq, ilike, inArray, or, sql, isNull } = require("drizzle-orm");

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

function buildDocumentFilters(filters = {}, userId) {
  const conditions = [
    eq(document.userId, userId),
    or(eq(document.softDelete, false), isNull(document.softDelete)),
  ];

  if (filters.userId) {
    conditions.push(eq(document.userId, filters.userId));
  }

  if (filters.documentType) {
    conditions.push(eq(document.documentType, filters.documentType.trim()));
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
  const conditions = [
    eq(document.userId, userId),
    or(eq(document.softDelete, false), isNull(document.softDelete)),
  ];

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
  if (filter.createdBy) {
    conditions.push(eq(document.userId, filter.createdBy));
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

  async upsertInitialDocument(data) {
    const [row] = await db
      .insert(document)
      .values(data)
      .onConflictDoUpdate({
        target: document.s3Key,
        set: {
          softDelete: false,
          fileName: data.fileName,
          s3Bucket: data.s3Bucket,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row || null;
  }
  async update(id, data) {
    const result = await db
      .update(document)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(document.id, id))
      .returning();

    return result[0] || null;
  }

  // async updateById(id, data) {
  //   return this.update(id, data);
  // }

  async upsertCompletedDocument(data) {
    if (!data?.s3Key) return null;
    const [row] = await db
      .insert(document)
      .values({
        id: data.id || crypto.randomUUID(),
        userId: data.userId,
        documentType: data.documentType || "OTHER_MEDICAL_DOCUMENT",
        fileName: data.fileName || "Document",
        s3Bucket: data.s3Bucket,
        s3Key: data.s3Key,
        fileType: data.fileType || "application/pdf",
        fileSize: data.fileSize || 0,
        ocrStatus: data.ocrStatus || "completed",
        ocrExtractedText: data.ocrExtractedText || null,
        structuredExtractedData: data.structuredExtractedData || null,
        reportDate: data.reportDate || null,
        hospitalName: data.hospitalName || null,
        doctorName: data.doctorName || null,
        remarks: data.remarks || null,
        summaryEnglish: data.summaryEnglish || null,
      })
      .onConflictDoUpdate({
        target: document.s3Key,
        set: {
          softDelete: false,
          documentType: data.documentType || "OTHER_MEDICAL_DOCUMENT",
          fileName: data.fileName || "Document",
          fileSize: data.fileSize || sql`${document.fileSize}`,
          fileType: data.fileType || sql`${document.fileType}`,
          s3Bucket: data.s3Bucket || sql`${document.s3Bucket}`,
          ocrStatus: data.ocrStatus || "completed",
          ocrExtractedText: data.ocrExtractedText,
          structuredExtractedData: data.structuredExtractedData,
          reportDate: data.reportDate,
          hospitalName: data.hospitalName,
          doctorName: data.doctorName,
          remarks: data.remarks,
          summaryEnglish: data.summaryEnglish,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row || null;
  }

  async updateOcrStatusByFileKey(fileKey, status, extraData = {}) {
    if (!fileKey) return null;
    const result = await db
      .update(document)
      .set({
        ocrStatus: status,
        updatedAt: new Date(),
        ...extraData,
      })
      .where(eq(document.s3Key, fileKey))
      .returning();
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

  async findActiveDocumentById(id, userId) {
    const result = await db
      .select()
      .from(document)
      .where(and(eq(document.id, id), eq(document.userId, userId), eq(document.softDelete, false)))
      .limit(1);

    return result[0] || null;
  }

  async findDocumentsByIds(ids) {
    if (!ids || ids.length === 0) return [];
    return db
      .select({
        id: document.id,
        fileName: document.fileName,
        reportDate: document.reportDate,
        documentType: document.documentType,
        structuredExtractedData: document.structuredExtractedData,
      })
      .from(document)
      .where(and(inArray(document.id, ids), eq(document.softDelete, false)));
  }

  async findLatestActiveDocumentByUserId(userId) {
    const result = await db
      .select()
      .from(document)
      .where(and(eq(document.userId, userId), eq(document.softDelete, false)))
      .orderBy(desc(document.createdAt))
      .limit(1);

    return result[0] || null;
  }

  async findAll({ userId, ...filters }) {
    const sortColumn = documentSortColumns[filters.sortBy] || document.createdAt;
    const orderBy = filters.sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn);
    const where = buildDocumentFilters(filters, userId);

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

  async findAllByFilterAndSort({ filter = {}, sort = {}, userId }) {
    const conditions = buildFilterSortConditions(filter, userId);
    const orderClause = buildOrderClause(sort);

    return db
      .select()
      .from(document)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(orderClause);
  }

  async findAllByFilterSortAndPagination({ filter = {}, page, sort = {}, userId }) {
    const conditions = buildFilterSortConditions(filter, userId);
    const orderClause = buildOrderClause(sort);
    const rawPageNumber = page?.pageNumber ?? 1;
    const pageLimit = Math.max(1, page?.pageLimit ?? 10);
    const effectivePageNumber = Math.max(1, rawPageNumber);
    const offset = Math.max(0, (effectivePageNumber - 1) * pageLimit);
    const limit = pageLimit;

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
        // deletedAt: new Date(),
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
  async updateById(id, data) {
    const result = await db.update(document).set(data).where(eq(document.id, id)).returning();

    return result[0] || null;
  }

  async getSummaryByUserId(userId) {
    const docs = await db
      .select({
        id: document.id,
        fileName: document.fileName,
        documentType: document.documentType,
        fileType: document.fileType,
        reportDate: document.reportDate,
        ocrStatus: document.ocrStatus,
        remarks: document.remarks,
        createdAt: document.createdAt,
      })
      .from(document)
      .where(and(eq(document.userId, userId), eq(document.softDelete, false)))
      .orderBy(desc(document.createdAt));

    return docs;
  }

  async findByFileKey(fileKey, userId = null) {
    if (!fileKey) return null;
    const cleanKey = String(fileKey).trim().replace(/['"]+/g, "");
    if (!cleanKey) return null;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanKey);
    const orConditions = [eq(document.s3Key, cleanKey)];
    if (isUuid) {
      orConditions.push(eq(document.id, cleanKey));
    }
    const conditions = [or(...orConditions), eq(document.softDelete, false)];
    if (userId) {
      conditions.push(eq(document.userId, userId));
    }
    const result = await db
      .select()
      .from(document)
      .where(and(...conditions))
      .limit(1);

    return result[0] || null;
  }
}

module.exports = new DocumentRepository();
