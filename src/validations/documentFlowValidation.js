const { z } = require("zod");

const { documentTypeValue } = require("../enums/documentType");

const fileKeySchema = z
  .object({
    fileKey: z.string().trim().min(3).max(500),
  })
  .strict();

const runOcrSchema = z
  .object({
    fileKey: z.string().trim().min(3).max(500),
    documentType: z.enum(documentTypeValue).optional(),
    mimeType: z.string().trim().max(128).optional(),
  })
  .strict();

const addDocumentSchema = z
  .object({
    fileKey: z.string().trim().min(3).max(500),
    documentType: z.enum(documentTypeValue).optional(),
    fileName: z.string().trim().max(255).optional(),
    bucket: z.string().trim().max(255).optional(),
    rawOcrData: z.record(z.any()),
    extractedStructuredData: z.record(z.any()),
    graphs: z.array(z.record(z.any())).optional().default([]),
    embeddingsGenerated: z.boolean().optional().default(false),
  })
  .strict();

const createChatSessionSchema = z
  .object({
    title: z.string().trim().max(255).optional(),
    documentId: z.string().uuid().optional(),
  })
  .strict();

const sendChatMessageSchema = z
  .object({
    sessionId: z.string().uuid(),
    message: z.string().trim().min(1).max(4000),
    documentId: z.string().uuid().optional(),
  })
  .strict();

const sessionMessagesQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
    direction: z.enum(["before", "after"]).default("before"),
  })
  .strict();

const sessionListQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();

module.exports = {
  addDocumentSchema,
  createChatSessionSchema,
  fileKeySchema,
  runOcrSchema,
  sendChatMessageSchema,
  sessionListQuerySchema,
  sessionMessagesQuerySchema,
};
