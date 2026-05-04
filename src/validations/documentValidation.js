const { z } = require("zod");

const { errorConstants } = require("../constants/errorConstants");
const { documentTypeValue } = require("../enums/documentType");
const { fileTypeValue } = require("../enums/fileType");
const { ocrStatus, ocrStatusValue } = require("../enums/ocrStatus");
const maxFileSize = 25 * 1024 * 1024;
const documentFilterSortKeys = [
  "createdAt",
  "createdBy",
  "doctorName",
  "documentType",
  "fileName",
  "fileType",
  "hospitalName",
  "reportDate",
  "title",
  "type",
  "updatedAt",
];

const createDocumentSchema = z
  .object({
    doctorName: z.string().trim().max(255),
    documentType: z.enum(documentTypeValue, {
      invalid_type_error: errorConstants.VALID_DOCUMENT_TYPE_REQUIRED,
      required_error: errorConstants.VALID_DOCUMENT_TYPE_REQUIRED,
    }),
    fileName: z.string().trim().min(2, errorConstants.NAME_TOO_SHORT).max(255),
    fileSize: z.coerce
      .number({ invalid_type_error: errorConstants.FILE_SIZE_INVALID })
      .int(errorConstants.FILE_SIZE_INVALID)
      .positive(errorConstants.FILE_SIZE_INVALID)
      .max(maxFileSize, errorConstants.FILE_SIZE_INVALID),
    fileStoragePath: z.string().trim().min(1, errorConstants.INVALID_REQUEST),
    fileType: z.enum(fileTypeValue, {
      invalid_type_error: errorConstants.FILE_TYPE_INVALID,
      required_error: errorConstants.FILE_TYPE_INVALID,
    }),
    hospitalName: z.string().trim().max(255),
    ocrExtractedText: z.string().optional().nullable(),
    ocrStatus: z.enum(ocrStatusValue).default(ocrStatus.PENDING),
    remarks: z.string().optional().nullable(),
    reportDate: z.coerce.date().optional().nullable(),
    s3Bucket: z.string().trim().min(1).max(255),
    s3Key: z.string().trim().min(1).max(500),
    structuredExtractedData: z.optional().nullable(),
  })
  .strict();

const listDocumentsQuerySchema = z
  .object({
    documentType: z.enum(documentTypeValue).optional(),
    fileType: z.enum(fileTypeValue).optional(),
    limit: z.coerce.number().int().positive().max(100).default(10),
    page: z.coerce.number().int().positive().default(1),
    search: z.string().trim().optional(),
    sortBy: z.string().trim().default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .transform((data) => ({
    ...data,
    offset: (data.page - 1) * data.limit,
  }));

const documentFilterSchema = z
  .object({
    createdBy: z.string().uuid(errorConstants.ID_INVALID).optional(),
    doctorName: z.string().trim().optional(),
    documentType: z.enum(documentTypeValue).optional(),
    fileName: z.string().trim().optional(),
    fileType: z.enum(fileTypeValue).optional(),
    hospitalName: z.string().trim().optional(),
    search: z.string().trim().optional(),
    title: z.string().trim().optional(),
    type: z.enum(documentTypeValue).optional(),
  })
  .strict();

const documentSortSchema = z
  .object({
    orderBy: z.enum(["asc", "desc"]).default("asc"),
    sortBy: z.enum(documentFilterSortKeys).default("createdAt"),
  })
  .strict();

const listDocumentsFilterSortSchema = z
  .object({
    filter: documentFilterSchema.optional().default({}),
    sort: documentSortSchema.optional().default({
      orderBy: "asc",
      sortBy: "createdAt",
    }),
  })
  .strict();

const listDocumentsPaginatedSchema = listDocumentsFilterSortSchema
  .extend({
    page: z
      .object({
        pageLimit: z.coerce.number().int().min(1).max(100),
        pageNumber: z.coerce.number().int().min(0),
      })
      .strict(),
  })
  .strict();

const downloadFileQuerySchema = z
  .object({
    fileKey: z.string().trim().min(1, errorConstants.FILE_KEY_REQUIRED),
  })
  .strict();

module.exports = {
  createDocumentSchema,
  listDocumentsFilterSortSchema,
  listDocumentsPaginatedSchema,
  downloadFileQuerySchema,
  listDocumentsQuerySchema,
};
